/**
 * MQTT Broker (Aedes)
 *
 * Embedded MQTT broker for IVY Gateway.
 * External clients connect here to receive meter telemetry
 * and send commands.
 *
 * Features:
 * - MQTT 3.1.1 support
 * - TCP transport (port 1883)
 * - WebSocket transport (port 9001)
 * - Basic authentication
 * - Connection tracking
 *
 * @module mqtt/broker
 */

import Aedes from 'aedes';
import { createServer } from 'net';
import { createServer as createHttpServer } from 'http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';

const logger = createChildLogger({ module: 'mqtt-broker' });

/**
 * Broker events
 */
export const BROKER_EVENTS = {
  CLIENT_CONNECTED: 'client:connected',
  CLIENT_DISCONNECTED: 'client:disconnected',
  CLIENT_ERROR: 'client:error',
  MESSAGE_PUBLISHED: 'message:published',
  MESSAGE_SUBSCRIBED: 'message:subscribed',
  BROKER_STARTED: 'broker:started',
  BROKER_STOPPED: 'broker:stopped',
};

/**
 * MQTT Broker class
 */
export class MQTTBroker extends EventEmitter {
  /**
   * @param {Object} options - Broker options
   * @param {number} [options.port=1883] - MQTT TCP port
   * @param {number} [options.wsPort=9001] - MQTT WebSocket port
   * @param {string} [options.host='0.0.0.0'] - Bind host
   * @param {Function} [options.authenticate] - Auth function
   * @param {Function} [options.authorizePublish] - Publish ACL
   * @param {Function} [options.authorizeSubscribe] - Subscribe ACL
   */
  constructor(options = {}) {
    super();

    this.options = {
      port: options.port || config.mqtt?.port || 1883,
      wsPort: options.wsPort || config.mqtt?.wsPort || 9001,
      host: options.host || config.mqtt?.host || '0.0.0.0',
      authenticate: options.authenticate || null,
      authorizePublish: options.authorizePublish || null,
      authorizeSubscribe: options.authorizeSubscribe || null,
    };

    /** @type {Aedes|null} */
    this.aedes = null;

    /** @type {import('net').Server|null} */
    this.server = null;

    /** @type {import('http').Server|null} */
    this.httpServer = null;

    /** @type {WebSocketServer|null} */
    this.wss = null;

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {Map<string, Object>} Client tracking */
    this.clients = new Map();

    /** @type {Object} Statistics */
    this.stats = {
      messagesPublished: 0,
      messagesReceived: 0,
      clientsTotal: 0,
      clientsConnected: 0,
    };

    logger.info('MQTTBroker created', { options: this.options });
  }

  /**
   * Start the MQTT broker
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      logger.warn('MQTT Broker already running');
      return;
    }

    return new Promise((resolve, reject) => {
      // Create Aedes instance
      this.aedes = new Aedes({
        id: 'ivy-gateway-broker',
        heartbeatInterval: 60000,
        connectTimeout: 30000,
      });

      // Setup authentication if provided
      if (this.options.authenticate) {
        this.aedes.authenticate = this.options.authenticate;
      }

      // Setup authorization if provided
      if (this.options.authorizePublish) {
        this.aedes.authorizePublish = this.options.authorizePublish;
      }

      if (this.options.authorizeSubscribe) {
        this.aedes.authorizeSubscribe = this.options.authorizeSubscribe;
      }

      // Setup event handlers
      this.setupEventHandlers();

      // Create TCP server
      this.server = createServer(this.aedes.handle);

      this.server.on('error', (error) => {
        logger.error('MQTT Server error', { error: error.message });
        if (!this.isRunning) {
          reject(error);
        }
      });

      this.server.listen(this.options.port, this.options.host, () => {
        this.isRunning = true;
        logger.info('MQTT Broker started', {
          host: this.options.host,
          port: this.options.port,
        });

        // Setup WebSocket server for browser clients
        this.setupWebSocketServer()
          .then(() => {
            this.emit(BROKER_EVENTS.BROKER_STARTED, {
              host: this.options.host,
              port: this.options.port,
              wsPort: this.options.wsPort,
            });
            resolve();
          })
          .catch(reject);
      });
    });
  }

  /**
   * Stop the MQTT broker
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping MQTT Broker...');

    return new Promise((resolve) => {
      // Close all client connections
      if (this.aedes) {
        this.aedes.close(() => {
          logger.debug('Aedes closed');
        });
      }

      // Close WebSocket server
      if (this.wss) {
        this.wss.close();
      }

      // Close HTTP server for WebSocket
      if (this.httpServer) {
        this.httpServer.close(() => {
          logger.debug('MQTT WebSocket server closed');
        });
      }

      // Close TCP server
      if (this.server) {
        this.server.close(() => {
          this.isRunning = false;
          logger.info('MQTT Broker stopped');
          this.emit(BROKER_EVENTS.BROKER_STOPPED, {});
          resolve();
        });
      } else {
        this.isRunning = false;
        resolve();
      }

      // Force resolve after timeout
      setTimeout(() => {
        this.isRunning = false;
        resolve();
      }, 5000);
    });
  }

  /**
   * Setup Aedes event handlers
   * @private
   */
  setupEventHandlers() {
    // Client connected
    this.aedes.on('client', (client) => {
      this.stats.clientsTotal++;
      this.stats.clientsConnected++;

      this.clients.set(client.id, {
        id: client.id,
        connectedAt: Date.now(),
        subscriptions: [],
      });

      logger.info('MQTT client connected', { clientId: client.id });
      this.emit(BROKER_EVENTS.CLIENT_CONNECTED, { clientId: client.id });
    });

    // Client disconnected
    this.aedes.on('clientDisconnect', (client) => {
      this.stats.clientsConnected--;
      this.clients.delete(client.id);

      logger.info('MQTT client disconnected', { clientId: client.id });
      this.emit(BROKER_EVENTS.CLIENT_DISCONNECTED, { clientId: client.id });
    });

    // Client error
    this.aedes.on('clientError', (client, error) => {
      logger.error('MQTT client error', {
        clientId: client?.id,
        error: error.message,
      });
      this.emit(BROKER_EVENTS.CLIENT_ERROR, {
        clientId: client?.id,
        error: error.message,
      });
    });

    // Message published
    this.aedes.on('publish', (packet, client) => {
      // Ignore $SYS messages and messages without client (internal)
      if (packet.topic.startsWith('$SYS') || !client) {
        return;
      }

      this.stats.messagesPublished++;

      logger.debug('Message published', {
        clientId: client.id,
        topic: packet.topic,
        qos: packet.qos,
        retain: packet.retain,
      });
      this.emit(BROKER_EVENTS.MESSAGE_PUBLISHED, {
        clientId: client.id,
        topic: packet.topic,
        payload: packet.payload,
        qos: packet.qos,
        retain: packet.retain,
      });
    });

    // Client subscribed
    this.aedes.on('subscribe', (subscriptions, client) => {
      const clientData = this.clients.get(client.id);
      if (clientData) {
        clientData.subscriptions.push(...subscriptions.map((s) => s.topic));
      }

      logger.debug('Client subscribed', {
        clientId: client.id,
        topics: subscriptions.map((s) => s.topic),
      });
      this.emit(BROKER_EVENTS.MESSAGE_SUBSCRIBED, {
        clientId: client.id,
        topics: subscriptions.map((s) => s.topic),
      });
    });

    // Client unsubscribed
    this.aedes.on('unsubscribe', (topics, client) => {
      const clientData = this.clients.get(client.id);
      if (clientData) {
        clientData.subscriptions = clientData.subscriptions.filter(
          (t) => !topics.includes(t)
        );
      }

      logger.debug('Client unsubscribed', {
        clientId: client.id,
        topics,
      });
    });
  }

  /**
   * Setup WebSocket server for browser MQTT clients
   * @private
   * @returns {Promise<void>}
   */
  async setupWebSocketServer() {
    return new Promise((resolve, reject) => {
      // Create HTTP server for WebSocket upgrade
      this.httpServer = createHttpServer();

      // Create WebSocket server attached to HTTP server
      this.wss = new WebSocketServer({ server: this.httpServer });

      // Handle WebSocket connections
      this.wss.on('connection', (ws) => {
        const stream = createWebSocketStream(ws, { duplex: true });
        this.aedes.handle(stream);
      });

      this.httpServer.on('error', (error) => {
        logger.error('MQTT WebSocket server error', { error: error.message });
        reject(error);
      });

      // Start WebSocket server
      this.httpServer.listen(this.options.wsPort, this.options.host, () => {
        logger.info('MQTT WebSocket server started', {
          host: this.options.host,
          port: this.options.wsPort,
        });
        resolve();
      });
    });
  }

  /**
   * Publish a message to a topic
   *
   * @param {string} topic - MQTT topic
   * @param {string|Buffer|Object} payload - Message payload
   * @param {Object} [options] - Publish options
   * @param {number} [options.qos=0] - QoS level (0, 1, 2)
   * @param {boolean} [options.retain=false] - Retain flag
   * @returns {Promise<void>}
   */
  async publish(topic, payload, options = {}) {
    if (!this.isRunning || !this.aedes) {
      throw new Error('Broker not running');
    }

    const message =
      typeof payload === 'object' && !Buffer.isBuffer(payload)
        ? JSON.stringify(payload)
        : payload;

    return new Promise((resolve, reject) => {
      this.aedes.publish(
        {
          topic,
          payload: Buffer.from(message),
          qos: options.qos || 0,
          retain: options.retain || false,
        },
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }

  /**
   * Get list of connected clients
   * @returns {Object[]} Client list
   */
  getConnectedClients() {
    return Array.from(this.clients.values());
  }

  /**
   * Get broker statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      port: this.options.port,
    };
  }

  /**
   * Check if broker is running
   * @returns {boolean}
   */
  isActive() {
    return this.isRunning;
  }
}

// Singleton instance
let instance = null;

/**
 * Get singleton instance
 * @param {Object} [options] - Options (only used on first call)
 * @returns {MQTTBroker}
 */
export const getInstance = (options) => {
  if (!instance) {
    instance = new MQTTBroker(options);
  }
  return instance;
};

/**
 * Create new broker instance
 * @param {Object} [options] - Broker options
 * @returns {MQTTBroker}
 */
export const createMQTTBroker = (options) => {
  return new MQTTBroker(options);
};

/**
 * Reset singleton (for testing)
 */
export const resetInstance = async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
};

export default {
  MQTTBroker,
  BROKER_EVENTS,
  getInstance,
  createMQTTBroker,
  resetInstance,
};
