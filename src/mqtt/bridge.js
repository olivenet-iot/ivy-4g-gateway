/**
 * MQTT Bridge
 *
 * Connects to an external MQTT broker and bridges data bidirectionally.
 * Forwards local telemetry/status/events to the remote broker (publish),
 * and receives commands from the remote broker (subscribe).
 *
 * This enables server-to-server data transfer for centralized
 * monitoring platforms and multi-gateway deployments.
 *
 * @module mqtt/bridge
 */

import mqtt from 'mqtt';
import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import { TOPIC_PREFIX } from './publisher.js';

const logger = createChildLogger({ module: 'mqtt-bridge' });

/**
 * Bridge events
 */
export const BRIDGE_EVENTS = {
  CONNECTED: 'bridge:connected',
  DISCONNECTED: 'bridge:disconnected',
  ERROR: 'bridge:error',
  MESSAGE_FORWARDED: 'bridge:message:forwarded',
  COMMAND_RECEIVED: 'bridge:command:received',
  RECONNECTING: 'bridge:reconnecting',
};

/**
 * MQTT Bridge class
 */
export class MQTTBridge extends EventEmitter {
  /**
   * @param {Object} options - Bridge options
   * @param {string} options.brokerUrl - Remote MQTT broker URL (e.g., mqtt://remote:1883)
   * @param {string} [options.username] - Remote broker username
   * @param {string} [options.password] - Remote broker password
   * @param {string} [options.clientId] - Client ID for remote connection
   * @param {Object} options.localBroker - Local Aedes broker instance
   * @param {string} [options.remotePrefix] - Topic prefix on remote broker
   * @param {string} [options.localPrefix] - Topic prefix on local broker
   * @param {boolean} [options.forwardTelemetry=true] - Forward telemetry to remote
   * @param {boolean} [options.forwardStatus=true] - Forward status to remote
   * @param {boolean} [options.forwardEvents=true] - Forward events to remote
   * @param {boolean} [options.receiveCommands=true] - Receive commands from remote
   * @param {number} [options.reconnectPeriod=5000] - Reconnect interval in ms
   */
  constructor(options = {}) {
    super();

    if (!options.brokerUrl) {
      throw new Error('Remote broker URL required for MQTT bridge');
    }
    if (!options.localBroker) {
      throw new Error('Local broker instance required for MQTT bridge');
    }

    this.options = {
      brokerUrl: options.brokerUrl,
      username: options.username || '',
      password: options.password || '',
      clientId: options.clientId || `ivy-bridge-${Date.now()}`,
      localPrefix: options.localPrefix || TOPIC_PREFIX,
      remotePrefix: options.remotePrefix || TOPIC_PREFIX,
      forwardTelemetry: options.forwardTelemetry !== false,
      forwardStatus: options.forwardStatus !== false,
      forwardEvents: options.forwardEvents !== false,
      receiveCommands: options.receiveCommands !== false,
      reconnectPeriod: options.reconnectPeriod ?? 5000,
    };

    this.localBroker = options.localBroker;

    /** @type {mqtt.MqttClient|null} */
    this.remoteClient = null;

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {Object} Statistics */
    this.stats = {
      messagesForwarded: 0,
      commandsReceived: 0,
      errors: 0,
      lastForward: null,
      lastCommand: null,
      connected: false,
    };

    logger.info('MQTTBridge created', {
      brokerUrl: this.options.brokerUrl,
      clientId: this.options.clientId,
    });
  }

  /**
   * Start the bridge
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      logger.warn('MQTTBridge already running');
      return;
    }

    this.isRunning = true;

    return new Promise((resolve, reject) => {
      const connectOptions = {
        clientId: this.options.clientId,
        keepalive: 30,
        reconnectPeriod: this.options.reconnectPeriod,
        connectTimeout: 10000,
        clean: true,
      };

      if (this.options.username) {
        connectOptions.username = this.options.username;
        connectOptions.password = this.options.password;
      }

      // Set up LWT (Last Will and Testament) for bridge status
      connectOptions.will = {
        topic: `${this.options.remotePrefix}/gateway/bridge/status`,
        payload: JSON.stringify({ status: 'offline', ts: Date.now() }),
        qos: 1,
        retain: true,
      };

      this.remoteClient = mqtt.connect(this.options.brokerUrl, connectOptions);

      const connectTimeout = setTimeout(() => {
        reject(new Error(`Bridge connection timeout to ${this.options.brokerUrl}`));
      }, 15000);

      this.remoteClient.on('connect', () => {
        clearTimeout(connectTimeout);
        this.stats.connected = true;

        logger.info('Bridge connected to remote broker', {
          brokerUrl: this.options.brokerUrl,
        });

        // Publish bridge online status
        this.remoteClient.publish(
          `${this.options.remotePrefix}/gateway/bridge/status`,
          JSON.stringify({ status: 'online', ts: Date.now() }),
          { qos: 1, retain: true }
        );

        // Subscribe to remote commands if enabled
        if (this.options.receiveCommands) {
          this.subscribeToRemoteCommands();
        }

        // Start listening to local broker messages
        this.setupLocalForwarding();

        this.emit(BRIDGE_EVENTS.CONNECTED, {
          brokerUrl: this.options.brokerUrl,
        });

        resolve();
      });

      this.remoteClient.on('error', (error) => {
        this.stats.errors++;
        logger.error('Bridge connection error', {
          error: error.message,
          brokerUrl: this.options.brokerUrl,
        });

        this.emit(BRIDGE_EVENTS.ERROR, { error });

        // If not yet connected, reject the promise
        if (!this.stats.connected) {
          clearTimeout(connectTimeout);
          reject(error);
        }
      });

      this.remoteClient.on('reconnect', () => {
        logger.info('Bridge reconnecting to remote broker');
        this.emit(BRIDGE_EVENTS.RECONNECTING, {});
      });

      this.remoteClient.on('close', () => {
        this.stats.connected = false;
        logger.info('Bridge disconnected from remote broker');
        this.emit(BRIDGE_EVENTS.DISCONNECTED, {});
      });

      this.remoteClient.on('message', (topic, payload) => {
        this.handleRemoteMessage(topic, payload);
      });
    });
  }

  /**
   * Stop the bridge
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Remove local broker listener
    if (this.localBroker?.aedes && this._localPublishHandler) {
      this.localBroker.aedes.removeListener('publish', this._localPublishHandler);
      this._localPublishHandler = null;
    }

    if (this.remoteClient) {
      // Publish offline status before disconnecting
      try {
        await new Promise((resolve) => {
          this.remoteClient.publish(
            `${this.options.remotePrefix}/gateway/bridge/status`,
            JSON.stringify({ status: 'offline', ts: Date.now() }),
            { qos: 1, retain: true },
            () => resolve()
          );
        });
      } catch {
        // ignore
      }

      return new Promise((resolve) => {
        this.remoteClient.end(false, {}, () => {
          this.remoteClient = null;
          logger.info('MQTTBridge stopped');
          resolve();
        });
      });
    }

    logger.info('MQTTBridge stopped');
  }

  /**
   * Setup forwarding of local broker messages to remote
   * @private
   */
  setupLocalForwarding() {
    if (!this.localBroker?.aedes) {
      logger.warn('Local broker not available for forwarding');
      return;
    }

    // Store reference for cleanup
    this._localPublishHandler = (packet, _client) => {
      // Skip system messages and messages without a topic
      if (!packet.topic || packet.topic.startsWith('$SYS')) {
        return;
      }

      // Only forward messages matching our local prefix
      if (!packet.topic.startsWith(this.options.localPrefix + '/')) {
        return;
      }

      // Determine message type
      const isTelemetry = packet.topic.includes('/telemetry');
      const isStatus = packet.topic.includes('/status');
      const isEvent = packet.topic.includes('/events');
      const isCommand = packet.topic.includes('/command');

      // Skip command topics (avoid loops)
      if (isCommand) {
        return;
      }

      // Check forwarding flags
      if (isTelemetry && !this.options.forwardTelemetry) return;
      if (isStatus && !this.options.forwardStatus) return;
      if (isEvent && !this.options.forwardEvents) return;

      // Remap topic prefix if different
      let remoteTopic = packet.topic;
      if (this.options.localPrefix !== this.options.remotePrefix) {
        remoteTopic = packet.topic.replace(
          this.options.localPrefix,
          this.options.remotePrefix
        );
      }

      // Forward to remote
      if (this.remoteClient && this.stats.connected) {
        this.remoteClient.publish(remoteTopic, packet.payload, {
          qos: isTelemetry ? 0 : 1, // QoS 0 for high-frequency telemetry
          retain: isStatus, // Retain status messages
        }, (err) => {
          if (err) {
            this.stats.errors++;
            logger.warn('Failed to forward message to remote', {
              topic: remoteTopic,
              error: err.message,
            });
          }
        });

        this.stats.messagesForwarded++;
        this.stats.lastForward = Date.now();

        this.emit(BRIDGE_EVENTS.MESSAGE_FORWARDED, {
          topic: remoteTopic,
          size: packet.payload?.length || 0,
        });
      }
    };

    this.localBroker.aedes.on('publish', this._localPublishHandler);

    logger.info('Bridge forwarding configured', {
      forwardTelemetry: this.options.forwardTelemetry,
      forwardStatus: this.options.forwardStatus,
      forwardEvents: this.options.forwardEvents,
    });
  }

  /**
   * Subscribe to remote commands for bidirectional communication
   * @private
   */
  subscribeToRemoteCommands() {
    if (!this.remoteClient) return;

    // Subscribe to command requests from remote
    const commandTopic = `${this.options.remotePrefix}/meters/+/command/request`;

    this.remoteClient.subscribe(commandTopic, { qos: 1 }, (err) => {
      if (err) {
        logger.error('Failed to subscribe to remote commands', {
          error: err.message,
        });
      } else {
        logger.info('Bridge subscribed to remote commands', {
          topic: commandTopic,
        });
      }
    });
  }

  /**
   * Handle messages received from remote broker
   * @private
   */
  handleRemoteMessage(topic, payload) {
    // Only handle command topics
    if (!topic.includes('/command/request')) {
      return;
    }

    try {
      const message = JSON.parse(payload.toString());

      // Remap to local topic
      let localTopic = topic;
      if (this.options.localPrefix !== this.options.remotePrefix) {
        localTopic = topic.replace(
          this.options.remotePrefix,
          this.options.localPrefix
        );
      }

      logger.info('Command received from remote broker', {
        topic: localTopic,
        method: message.method,
      });

      // Publish to local broker for command handler to pick up
      if (this.localBroker) {
        this.localBroker.publish(localTopic, message, { qos: 1 });
      }

      this.stats.commandsReceived++;
      this.stats.lastCommand = Date.now();

      this.emit(BRIDGE_EVENTS.COMMAND_RECEIVED, {
        topic: localTopic,
        method: message.method,
      });
    } catch (error) {
      this.stats.errors++;
      logger.warn('Failed to parse remote command', {
        topic,
        error: error.message,
      });
    }
  }

  /**
   * Get bridge statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      brokerUrl: this.options.brokerUrl,
      clientId: this.options.clientId,
    };
  }
}

/**
 * Create MQTT bridge instance
 * @param {Object} options - Bridge options
 * @returns {MQTTBridge}
 */
export const createMQTTBridge = (options) => {
  return new MQTTBridge(options);
};

export default {
  MQTTBridge,
  BRIDGE_EVENTS,
  createMQTTBridge,
};
