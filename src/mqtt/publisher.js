/**
 * MQTT Telemetry Publisher
 *
 * Publishes meter telemetry data from TCP server to MQTT topics.
 * Bridges the gap between DLT645 protocol and MQTT clients.
 *
 * Topic Structure:
 * - ivy/v1/meters/{meterId}/telemetry - Meter readings
 * - ivy/v1/meters/{meterId}/status - Connection status
 * - ivy/v1/meters/{meterId}/events - Alarms and events
 * - ivy/v1/gateway/status - Gateway status
 * - ivy/v1/gateway/stats - Gateway statistics
 *
 * @module mqtt/publisher
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'mqtt-publisher' });

/**
 * Topic prefix
 */
export const TOPIC_PREFIX = 'ivy/v1';

/**
 * Topic builders
 */
export const Topics = {
  meterTelemetry: (meterId) => `${TOPIC_PREFIX}/meters/${meterId}/telemetry`,
  meterStatus: (meterId) => `${TOPIC_PREFIX}/meters/${meterId}/status`,
  meterEvents: (meterId) => `${TOPIC_PREFIX}/meters/${meterId}/events`,
  meterCommandResponse: (meterId) => `${TOPIC_PREFIX}/meters/${meterId}/command/response`,
  gatewayStatus: () => `${TOPIC_PREFIX}/gateway/status`,
  gatewayStats: () => `${TOPIC_PREFIX}/gateway/stats`,
};

/**
 * Publisher events
 */
export const PUBLISHER_EVENTS = {
  TELEMETRY_PUBLISHED: 'telemetry:published',
  STATUS_PUBLISHED: 'status:published',
  EVENT_PUBLISHED: 'event:published',
  PUBLISH_ERROR: 'publish:error',
};

/**
 * Telemetry Publisher class
 */
export class TelemetryPublisher extends EventEmitter {
  /**
   * @param {Object} options - Publisher options
   * @param {Object} options.broker - MQTT broker instance
   * @param {number} [options.qos=1] - Default QoS level
   * @param {boolean} [options.retain=false] - Default retain flag
   * @param {number} [options.statusInterval=60000] - Gateway status publish interval
   */
  constructor(options = {}) {
    super();

    if (!options.broker) {
      throw new Error('MQTT broker instance required');
    }

    this.broker = options.broker;
    this.options = {
      qos: options.qos ?? 1,
      retain: options.retain ?? false,
      statusInterval: options.statusInterval ?? 60000,
    };

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {NodeJS.Timeout|null} */
    this.statusTimer = null;

    /** @type {Object} Statistics */
    this.stats = {
      telemetryPublished: 0,
      statusPublished: 0,
      eventsPublished: 0,
      errors: 0,
      lastPublish: null,
    };

    /** @type {Map<string, Object>} Last telemetry per meter */
    this.lastTelemetry = new Map();

    /** @type {Object} Gateway info */
    this.gatewayInfo = {};

    logger.info('TelemetryPublisher created', { options: this.options });
  }

  /**
   * Start the publisher
   * @param {Object} [gatewayInfo] - Gateway info for status messages
   */
  start(gatewayInfo = {}) {
    if (this.isRunning) {
      logger.warn('TelemetryPublisher already running');
      return;
    }

    this.isRunning = true;
    this.gatewayInfo = gatewayInfo;

    // Start periodic gateway status publishing
    this.startStatusPublishing();

    // Publish initial gateway status
    this.publishGatewayStatus('online');

    logger.info('TelemetryPublisher started');
  }

  /**
   * Stop the publisher
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stopStatusPublishing();

    // Publish offline status
    await this.publishGatewayStatus('offline');

    logger.info('TelemetryPublisher stopped');
  }

  /**
   * Publish meter telemetry
   *
   * @param {string} meterId - 12-digit meter address
   * @param {Object} data - Telemetry data
   * @param {number} [data.dataId] - Register data ID
   * @param {string} [data.dataIdFormatted] - Formatted data ID
   * @param {Object} [data.register] - Register info
   * @param {number} data.value - Parsed value
   * @param {number} [data.rawValue] - Raw BCD value
   * @param {string} [data.unit] - Unit of measurement
   * @param {number} [data.timestamp] - Timestamp
   * @returns {Promise<boolean>} Success
   */
  async publishTelemetry(meterId, data) {
    if (!this.isRunning) {
      logger.warn('Publisher not running, skipping telemetry');
      return false;
    }

    try {
      const topic = Topics.meterTelemetry(meterId);

      // Build telemetry message
      const message = {
        ts: data.timestamp || Date.now(),
        meterId,
        dataId: data.dataIdFormatted || `0x${(data.dataId || 0).toString(16).padStart(8, '0')}`,
        register: data.register?.key || data.register?.name || 'unknown',
        value: data.value,
        rawValue: data.rawValue,
        unit: data.unit || '',
      };

      await this.broker.publish(topic, message, {
        qos: this.options.qos,
        retain: false, // Don't retain telemetry
      });

      // Update stats
      this.stats.telemetryPublished++;
      this.stats.lastPublish = Date.now();

      // Store last telemetry
      this.updateLastTelemetry(meterId, message);

      this.emit(PUBLISHER_EVENTS.TELEMETRY_PUBLISHED, {
        meterId,
        topic,
        message,
      });

      logger.debug('Telemetry published', {
        meterId,
        register: message.register,
        value: message.value,
        unit: message.unit,
      });

      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Failed to publish telemetry', {
        meterId,
        error: error.message,
      });

      this.emit(PUBLISHER_EVENTS.PUBLISH_ERROR, {
        type: 'telemetry',
        meterId,
        error,
      });

      return false;
    }
  }

  /**
   * Publish batch telemetry (multiple values at once)
   *
   * @param {string} meterId - Meter address
   * @param {Object} values - Key-value pairs of telemetry
   * @returns {Promise<boolean>} Success
   */
  async publishBatchTelemetry(meterId, values) {
    if (!this.isRunning) {
      return false;
    }

    try {
      const topic = Topics.meterTelemetry(meterId);

      const message = {
        ts: Date.now(),
        meterId,
        values,
      };

      await this.broker.publish(topic, message, {
        qos: this.options.qos,
        retain: false,
      });

      this.stats.telemetryPublished++;
      this.stats.lastPublish = Date.now();

      // Update last telemetry with batch values
      this.updateLastTelemetry(meterId, { ...message, isBatch: true });

      this.emit(PUBLISHER_EVENTS.TELEMETRY_PUBLISHED, {
        meterId,
        topic,
        message,
        isBatch: true,
      });

      logger.debug('Batch telemetry published', {
        meterId,
        valueCount: Object.keys(values).length,
      });

      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Failed to publish batch telemetry', {
        meterId,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Publish meter status (online/offline)
   *
   * @param {string} meterId - Meter address
   * @param {boolean} online - Is meter online
   * @param {Object} [details] - Additional status details
   * @returns {Promise<boolean>} Success
   */
  async publishMeterStatus(meterId, online, details = {}) {
    if (!this.isRunning) {
      return false;
    }

    try {
      const topic = Topics.meterStatus(meterId);

      const message = {
        ts: Date.now(),
        meterId,
        online,
        ...details,
      };

      await this.broker.publish(topic, message, {
        qos: this.options.qos,
        retain: true, // Retain status messages
      });

      this.stats.statusPublished++;

      this.emit(PUBLISHER_EVENTS.STATUS_PUBLISHED, {
        meterId,
        topic,
        message,
      });

      logger.info('Meter status published', {
        meterId,
        online,
      });

      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Failed to publish meter status', {
        meterId,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Publish meter event (alarm, error, etc.)
   *
   * @param {string} meterId - Meter address
   * @param {string} eventType - Event type
   * @param {Object} [eventData] - Event details
   * @returns {Promise<boolean>} Success
   */
  async publishMeterEvent(meterId, eventType, eventData = {}) {
    if (!this.isRunning) {
      return false;
    }

    try {
      const topic = Topics.meterEvents(meterId);

      const message = {
        ts: Date.now(),
        meterId,
        event: eventType,
        data: eventData,
      };

      await this.broker.publish(topic, message, {
        qos: this.options.qos,
        retain: false,
      });

      this.stats.eventsPublished++;

      this.emit(PUBLISHER_EVENTS.EVENT_PUBLISHED, {
        meterId,
        topic,
        message,
      });

      logger.info('Meter event published', {
        meterId,
        eventType,
      });

      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Failed to publish meter event', {
        meterId,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Publish command response
   *
   * @param {string} meterId - Meter address
   * @param {string} commandId - Original command ID
   * @param {boolean} success - Command success
   * @param {Object} [result] - Command result or error
   * @returns {Promise<boolean>} Success
   */
  async publishCommandResponse(meterId, commandId, success, result = {}) {
    if (!this.isRunning) {
      return false;
    }

    try {
      const topic = Topics.meterCommandResponse(meterId);

      const message = {
        ts: Date.now(),
        id: commandId,
        success,
        result,
      };

      await this.broker.publish(topic, message, {
        qos: this.options.qos,
        retain: false,
      });

      logger.debug('Command response published', {
        meterId,
        commandId,
        success,
      });

      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error('Failed to publish command response', {
        meterId,
        commandId,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Publish gateway status
   *
   * @param {string} status - 'online' or 'offline'
   * @returns {Promise<boolean>} Success
   */
  async publishGatewayStatus(status) {
    try {
      const topic = Topics.gatewayStatus();

      const message = {
        ts: Date.now(),
        status,
        version: this.gatewayInfo?.version || '0.1.0',
        uptime: process.uptime(),
        ...this.gatewayInfo,
      };

      await this.broker.publish(topic, message, {
        qos: 1,
        retain: true,
      });

      logger.info('Gateway status published', { status });
      return true;
    } catch (error) {
      logger.error('Failed to publish gateway status', {
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Publish gateway statistics
   *
   * @param {Object} stats - Statistics object
   * @returns {Promise<boolean>} Success
   */
  async publishGatewayStats(stats) {
    try {
      const topic = Topics.gatewayStats();

      const message = {
        ts: Date.now(),
        ...stats,
        publisher: this.stats,
      };

      await this.broker.publish(topic, message, {
        qos: 0,
        retain: false,
      });

      return true;
    } catch (error) {
      logger.error('Failed to publish gateway stats', {
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Start periodic status publishing
   * @private
   */
  startStatusPublishing() {
    if (this.statusTimer) {
      return;
    }

    this.statusTimer = setInterval(() => {
      this.publishGatewayStatus('online');
    }, this.options.statusInterval);

    logger.debug('Status publishing started', {
      interval: this.options.statusInterval,
    });
  }

  /**
   * Stop periodic status publishing
   * @private
   */
  stopStatusPublishing() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
      logger.debug('Status publishing stopped');
    }
  }

  /**
   * Update last telemetry for a meter
   * @private
   */
  updateLastTelemetry(meterId, data) {
    const existing = this.lastTelemetry.get(meterId) || {};

    if (data.isBatch && data.values) {
      // Merge batch values
      this.lastTelemetry.set(meterId, {
        ...existing,
        ...data.values,
        _lastUpdate: data.ts,
      });
    } else {
      // Single value
      this.lastTelemetry.set(meterId, {
        ...existing,
        [data.register]: {
          value: data.value,
          unit: data.unit,
          ts: data.ts,
        },
        _lastUpdate: data.ts,
      });
    }
  }

  /**
   * Get last telemetry for a meter
   *
   * @param {string} meterId - Meter address
   * @returns {Object|null} Last telemetry data
   */
  getLastTelemetry(meterId) {
    return this.lastTelemetry.get(meterId) || null;
  }

  /**
   * Get all last telemetry
   *
   * @returns {Object} Map of meterId -> telemetry
   */
  getAllLastTelemetry() {
    const result = {};
    for (const [meterId, data] of this.lastTelemetry) {
      result[meterId] = data;
    }
    return result;
  }

  /**
   * Get publisher statistics
   *
   * @returns {Object} Stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      meterCount: this.lastTelemetry.size,
    };
  }
}

/**
 * Create telemetry publisher instance
 * @param {Object} options - Publisher options
 * @returns {TelemetryPublisher}
 */
export const createTelemetryPublisher = (options) => {
  return new TelemetryPublisher(options);
};

export default {
  TelemetryPublisher,
  TOPIC_PREFIX,
  Topics,
  PUBLISHER_EVENTS,
  createTelemetryPublisher,
};
