/**
 * Status & Events Manager
 *
 * Manages gateway and meter status, processes events and alarms.
 * Publishes status updates to MQTT for external monitoring.
 *
 * Features:
 * - Gateway health monitoring (uptime, memory, connections)
 * - Meter online/offline tracking with timestamps
 * - Event/alarm processing and publishing
 * - Configurable status publish interval
 * - Historical status tracking
 *
 * @module services/status-manager
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import { SERVER_EVENTS } from '../tcp/server.js';

const logger = createChildLogger({ module: 'status-manager' });

/**
 * Status manager events
 */
export const STATUS_EVENTS = {
  METER_ONLINE: 'meter:online',
  METER_OFFLINE: 'meter:offline',
  METER_STATUS_CHANGED: 'meter:status:changed',
  GATEWAY_STATUS_CHANGED: 'gateway:status:changed',
  EVENT_CREATED: 'event:created',
  ALARM_TRIGGERED: 'alarm:triggered',
  ALARM_CLEARED: 'alarm:cleared',
};

/**
 * Event types
 */
export const EVENT_TYPES = {
  // Connection events
  METER_CONNECTED: 'meter_connected',
  METER_DISCONNECTED: 'meter_disconnected',
  METER_TIMEOUT: 'meter_timeout',
  METER_RECONNECTED: 'meter_reconnected',

  // Telemetry events
  TELEMETRY_RECEIVED: 'telemetry_received',
  TELEMETRY_ERROR: 'telemetry_error',

  // Command events
  COMMAND_EXECUTED: 'command_executed',
  COMMAND_FAILED: 'command_failed',

  // System events
  GATEWAY_STARTED: 'gateway_started',
  GATEWAY_STOPPED: 'gateway_stopped',
  GATEWAY_ERROR: 'gateway_error',
};

/**
 * Alarm types
 */
export const ALARM_TYPES = {
  // Voltage alarms
  OVERVOLTAGE: 'overvoltage',
  UNDERVOLTAGE: 'undervoltage',
  VOLTAGE_LOSS: 'voltage_loss',

  // Current alarms
  OVERCURRENT: 'overcurrent',
  CURRENT_IMBALANCE: 'current_imbalance',

  // Power alarms
  POWER_OUTAGE: 'power_outage',
  POWER_RESTORED: 'power_restored',
  OVERLOAD: 'overload',

  // Communication alarms
  COMMUNICATION_LOST: 'communication_lost',
  COMMUNICATION_RESTORED: 'communication_restored',

  // Meter alarms
  METER_TAMPER: 'meter_tamper',
  METER_FAULT: 'meter_fault',
  LOW_BALANCE: 'low_balance',
};

/**
 * Alarm severity levels
 */
export const ALARM_SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

/**
 * Default alarm thresholds
 */
export const DEFAULT_THRESHOLDS = {
  overvoltage: 250, // V
  undervoltage: 180, // V
  overcurrent: 100, // A
  overload: 10000, // W
  lowBalance: 10, // kWh
  offlineTimeout: 300000, // 5 minutes
};

/**
 * Status Manager class
 */
export class StatusManager extends EventEmitter {
  /**
   * @param {Object} options - Manager options
   * @param {Object} [options.publisher] - Telemetry publisher instance
   * @param {Object} [options.tcpServer] - TCP server instance
   * @param {number} [options.statusInterval=30000] - Status publish interval
   * @param {Object} [options.thresholds] - Alarm thresholds
   */
  constructor(options = {}) {
    super();

    this.publisher = options.publisher || null;
    this.tcpServer = options.tcpServer || null;
    this.options = {
      statusInterval: options.statusInterval ?? 30000,
      thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds },
    };

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {NodeJS.Timeout|null} */
    this.statusTimer = null;

    /** @type {Date|null} */
    this.startTime = null;

    /** @type {Map<string, Object>} Meter status map */
    this.meterStatus = new Map();

    /** @type {Map<string, Object>} Active alarms map */
    this.activeAlarms = new Map();

    /** @type {Object[]} Recent events (limited buffer) */
    this.recentEvents = [];
    this.maxRecentEvents = 100;

    /** @type {Object} Gateway status */
    this.gatewayStatus = {
      status: 'stopped',
      startTime: null,
      version: '0.1.0',
    };

    /** @type {Function[]} Bound event listener references for cleanup */
    this._boundListeners = [];

    /** @type {Object} Statistics */
    this.stats = {
      totalEvents: 0,
      totalAlarms: 0,
      alarmsCleared: 0,
      metersOnline: 0,
      metersOffline: 0,
    };

    logger.info('StatusManager created', {
      statusInterval: this.options.statusInterval,
    });
  }

  /**
   * Start the status manager
   */
  start() {
    if (this.isRunning) {
      logger.warn('StatusManager already running');
      return;
    }

    this.isRunning = true;
    this.startTime = new Date();
    this.gatewayStatus.status = 'running';
    this.gatewayStatus.startTime = this.startTime;

    // Setup TCP server event listeners
    this.setupTcpEventListeners();

    // Start periodic status publishing
    this.startStatusPublishing();

    // Create gateway started event
    this.createEvent(EVENT_TYPES.GATEWAY_STARTED, {
      version: this.gatewayStatus.version,
    });

    logger.info('StatusManager started');
  }

  /**
   * Stop the status manager
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.gatewayStatus.status = 'stopped';

    // Remove TCP server event listeners to prevent leaks
    this.removeTcpEventListeners();

    this.stopStatusPublishing();

    // Create gateway stopped event
    this.createEvent(EVENT_TYPES.GATEWAY_STOPPED, {
      uptime: this.getUptime(),
    });

    logger.info('StatusManager stopped');
  }

  /**
   * Setup TCP server event listeners
   * @private
   */
  setupTcpEventListeners() {
    if (!this.tcpServer) {
      return;
    }

    // Store bound references for cleanup
    const onConnected = ({ meterId, remoteAddress }) => {
      this.handleMeterConnected(meterId, remoteAddress);
    };
    const onDisconnected = ({ meterId }) => {
      this.handleMeterDisconnected(meterId);
    };
    const onTelemetry = (data) => {
      this.handleTelemetryReceived(data);
    };
    const onDlmsTelemetry = (data) => {
      if (data.telemetry?.readings) {
        for (const [key, reading] of Object.entries(data.telemetry.readings)) {
          this.handleTelemetryReceived({
            meterId: data.meterId,
            value: reading.value,
            unit: reading.unit || '',
            register: { key, name: key },
            source: 'dlms',
          });
        }
      }
    };

    this.tcpServer.on(SERVER_EVENTS.METER_CONNECTED, onConnected);
    this.tcpServer.on(SERVER_EVENTS.METER_DISCONNECTED, onDisconnected);
    this.tcpServer.on(SERVER_EVENTS.TELEMETRY_RECEIVED, onTelemetry);
    this.tcpServer.on(SERVER_EVENTS.DLMS_TELEMETRY_RECEIVED, onDlmsTelemetry);

    this._boundListeners = [
      { event: SERVER_EVENTS.METER_CONNECTED, fn: onConnected },
      { event: SERVER_EVENTS.METER_DISCONNECTED, fn: onDisconnected },
      { event: SERVER_EVENTS.TELEMETRY_RECEIVED, fn: onTelemetry },
      { event: SERVER_EVENTS.DLMS_TELEMETRY_RECEIVED, fn: onDlmsTelemetry },
    ];
  }

  /**
   * Remove TCP server event listeners
   * @private
   */
  removeTcpEventListeners() {
    if (!this.tcpServer) {
      return;
    }

    for (const { event, fn } of this._boundListeners) {
      this.tcpServer.removeListener(event, fn);
    }
    this._boundListeners = [];
  }

  /**
   * Handle meter connected event
   * @param {string} meterId - Meter address
   * @param {string} remoteAddress - Remote IP
   */
  handleMeterConnected(meterId, remoteAddress) {
    const wasOffline =
      this.meterStatus.has(meterId) && !this.meterStatus.get(meterId).online;

    const status = {
      meterId,
      online: true,
      remoteAddress,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      disconnectedAt: null,
    };

    this.meterStatus.set(meterId, status);
    this.stats.metersOnline++;

    // Create event
    const eventType = wasOffline ? EVENT_TYPES.METER_RECONNECTED : EVENT_TYPES.METER_CONNECTED;
    this.createEvent(eventType, { meterId, remoteAddress });

    // Clear communication alarm if exists
    this.clearAlarm(meterId, ALARM_TYPES.COMMUNICATION_LOST);

    // Publish status
    if (this.publisher) {
      this.publisher.publishMeterStatus(meterId, true, { ip: remoteAddress });
    }

    this.emit(STATUS_EVENTS.METER_ONLINE, { meterId, remoteAddress });
    this.emit(STATUS_EVENTS.METER_STATUS_CHANGED, { meterId, online: true });

    logger.info('Meter online', { meterId, remoteAddress });
  }

  /**
   * Handle meter disconnected event
   * @param {string} meterId - Meter address
   */
  handleMeterDisconnected(meterId) {
    const status = this.meterStatus.get(meterId) || { meterId };

    status.online = false;
    status.disconnectedAt = Date.now();

    this.meterStatus.set(meterId, status);
    this.stats.metersOnline = Math.max(0, this.stats.metersOnline - 1);
    this.stats.metersOffline++;

    // Create event
    this.createEvent(EVENT_TYPES.METER_DISCONNECTED, { meterId });

    // Create communication alarm
    this.createAlarm(meterId, ALARM_TYPES.COMMUNICATION_LOST, ALARM_SEVERITY.WARNING, {
      lastSeen: status.lastSeen,
    });

    // Publish status
    if (this.publisher) {
      this.publisher.publishMeterStatus(meterId, false);
    }

    this.emit(STATUS_EVENTS.METER_OFFLINE, { meterId });
    this.emit(STATUS_EVENTS.METER_STATUS_CHANGED, { meterId, online: false });

    logger.info('Meter offline', { meterId });
  }

  /**
   * Handle telemetry received event
   * @param {Object} data - Telemetry data
   */
  handleTelemetryReceived(data) {
    const { meterId, value, unit, register } = data;

    // Update last seen
    const status = this.meterStatus.get(meterId);
    if (status) {
      status.lastSeen = Date.now();
      status.lastTelemetry = { value, unit, register, ts: Date.now() };
    }

    // Check for alarm conditions
    this.checkAlarmConditions(meterId, data);
  }

  /**
   * Check telemetry for alarm conditions
   * @private
   * @param {string} meterId - Meter address
   * @param {Object} data - Telemetry data
   */
  checkAlarmConditions(meterId, data) {
    const { value, register } = data;
    const registerKey = register?.key || register?.name || '';
    const thresholds = this.options.thresholds;

    // Voltage checks
    if (registerKey.includes('VOLTAGE')) {
      if (value > thresholds.overvoltage) {
        this.createAlarm(meterId, ALARM_TYPES.OVERVOLTAGE, ALARM_SEVERITY.WARNING, {
          value,
          threshold: thresholds.overvoltage,
        });
      } else if (value < thresholds.undervoltage && value > 0) {
        this.createAlarm(meterId, ALARM_TYPES.UNDERVOLTAGE, ALARM_SEVERITY.WARNING, {
          value,
          threshold: thresholds.undervoltage,
        });
      } else {
        // Clear voltage alarms if back to normal
        this.clearAlarm(meterId, ALARM_TYPES.OVERVOLTAGE);
        this.clearAlarm(meterId, ALARM_TYPES.UNDERVOLTAGE);
      }
    }

    // Current checks
    if (registerKey.includes('CURRENT')) {
      if (value > thresholds.overcurrent) {
        this.createAlarm(meterId, ALARM_TYPES.OVERCURRENT, ALARM_SEVERITY.CRITICAL, {
          value,
          threshold: thresholds.overcurrent,
        });
      } else {
        this.clearAlarm(meterId, ALARM_TYPES.OVERCURRENT);
      }
    }

    // Power checks
    if (registerKey.includes('POWER') && !registerKey.includes('FACTOR')) {
      if (value > thresholds.overload) {
        this.createAlarm(meterId, ALARM_TYPES.OVERLOAD, ALARM_SEVERITY.WARNING, {
          value,
          threshold: thresholds.overload,
        });
      } else {
        this.clearAlarm(meterId, ALARM_TYPES.OVERLOAD);
      }
    }

    // Balance checks (prepaid meters)
    if (registerKey.includes('BALANCE')) {
      if (value < thresholds.lowBalance) {
        this.createAlarm(meterId, ALARM_TYPES.LOW_BALANCE, ALARM_SEVERITY.INFO, {
          value,
          threshold: thresholds.lowBalance,
        });
      } else {
        this.clearAlarm(meterId, ALARM_TYPES.LOW_BALANCE);
      }
    }
  }

  /**
   * Create an event
   * @param {string} type - Event type
   * @param {Object} [data] - Event data
   * @returns {Object} Created event
   */
  createEvent(type, data = {}) {
    const event = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      data,
      timestamp: Date.now(),
    };

    // Add to recent events
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.pop();
    }

    this.stats.totalEvents++;

    this.emit(STATUS_EVENTS.EVENT_CREATED, event);

    // Publish event if meter-specific
    if (data.meterId && this.publisher) {
      this.publisher.publishMeterEvent(data.meterId, type, data);
    }

    logger.debug('Event created', { type, meterId: data.meterId });

    return event;
  }

  /**
   * Create an alarm
   * @param {string} meterId - Meter address
   * @param {string} type - Alarm type
   * @param {string} severity - Alarm severity
   * @param {Object} [data] - Additional data
   * @returns {Object|null} Created alarm or null if already exists
   */
  createAlarm(meterId, type, severity, data = {}) {
    const alarmKey = `${meterId}:${type}`;

    // Skip if alarm already active
    if (this.activeAlarms.has(alarmKey)) {
      return null;
    }

    const alarm = {
      id: `alm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      meterId,
      type,
      severity,
      data,
      triggeredAt: Date.now(),
      acknowledged: false,
    };

    this.activeAlarms.set(alarmKey, alarm);
    this.stats.totalAlarms++;

    this.emit(STATUS_EVENTS.ALARM_TRIGGERED, alarm);

    // Publish alarm event
    if (this.publisher) {
      this.publisher.publishMeterEvent(meterId, `alarm:${type}`, {
        severity,
        ...data,
      });
    }

    logger.warn('Alarm triggered', {
      meterId,
      type,
      severity,
      value: data.value,
    });

    return alarm;
  }

  /**
   * Clear an alarm
   * @param {string} meterId - Meter address
   * @param {string} type - Alarm type
   * @returns {boolean} True if alarm was cleared
   */
  clearAlarm(meterId, type) {
    const alarmKey = `${meterId}:${type}`;
    const alarm = this.activeAlarms.get(alarmKey);

    if (!alarm) {
      return false;
    }

    this.activeAlarms.delete(alarmKey);
    this.stats.alarmsCleared++;

    this.emit(STATUS_EVENTS.ALARM_CLEARED, {
      ...alarm,
      clearedAt: Date.now(),
    });

    // Publish alarm cleared event
    if (this.publisher) {
      this.publisher.publishMeterEvent(meterId, `alarm_cleared:${type}`, {});
    }

    logger.info('Alarm cleared', { meterId, type });

    return true;
  }

  /**
   * Acknowledge an alarm
   * @param {string} alarmId - Alarm ID
   * @returns {boolean} Success
   */
  acknowledgeAlarm(alarmId) {
    for (const alarm of this.activeAlarms.values()) {
      if (alarm.id === alarmId) {
        alarm.acknowledged = true;
        alarm.acknowledgedAt = Date.now();
        logger.info('Alarm acknowledged', { alarmId });
        return true;
      }
    }
    return false;
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
      this.publishGatewayStats();
    }, this.options.statusInterval);

    // Publish initial stats
    this.publishGatewayStats();
  }

  /**
   * Stop periodic status publishing
   * @private
   */
  stopStatusPublishing() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /**
   * Publish gateway statistics
   * @private
   */
  async publishGatewayStats() {
    if (!this.publisher) {
      return;
    }

    const stats = this.getGatewayStats();
    await this.publisher.publishGatewayStats(stats);
  }

  /**
   * Get gateway statistics
   * @returns {Object} Gateway stats
   */
  getGatewayStats() {
    const memUsage = process.memoryUsage();

    return {
      status: this.gatewayStatus.status,
      uptime: this.getUptime(),
      version: this.gatewayStatus.version,
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024),
      },
      meters: {
        online: this.stats.metersOnline,
        total: this.meterStatus.size,
      },
      alarms: {
        active: this.activeAlarms.size,
        total: this.stats.totalAlarms,
      },
      events: {
        total: this.stats.totalEvents,
        recent: this.recentEvents.length,
      },
    };
  }

  /**
   * Get uptime in seconds
   * @returns {number} Uptime
   */
  getUptime() {
    if (!this.startTime) {
      return 0;
    }
    return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
  }

  /**
   * Get meter status
   * @param {string} [meterId] - Optional specific meter
   * @returns {Object|Object[]|null} Meter status
   */
  getMeterStatus(meterId) {
    if (meterId) {
      return this.meterStatus.get(meterId) || null;
    }

    const statuses = [];
    for (const status of this.meterStatus.values()) {
      statuses.push(status);
    }
    return statuses;
  }

  /**
   * Get online meters
   * @returns {string[]} Online meter IDs
   */
  getOnlineMeters() {
    const online = [];
    for (const [meterId, status] of this.meterStatus) {
      if (status.online) {
        online.push(meterId);
      }
    }
    return online;
  }

  /**
   * Get active alarms
   * @param {string} [meterId] - Optional filter by meter
   * @returns {Object[]} Active alarms
   */
  getActiveAlarms(meterId) {
    const alarms = [];
    for (const alarm of this.activeAlarms.values()) {
      if (!meterId || alarm.meterId === meterId) {
        alarms.push(alarm);
      }
    }
    return alarms;
  }

  /**
   * Get recent events
   * @param {number} [limit=20] - Max events to return
   * @param {string} [meterId] - Optional filter by meter
   * @returns {Object[]} Recent events
   */
  getRecentEvents(limit = 20, meterId) {
    let events = this.recentEvents;

    if (meterId) {
      events = events.filter((e) => e.data?.meterId === meterId);
    }

    return events.slice(0, limit);
  }

  /**
   * Get manager statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      uptime: this.getUptime(),
      activeAlarms: this.activeAlarms.size,
      trackedMeters: this.meterStatus.size,
    };
  }
}

/**
 * Create status manager instance
 * @param {Object} options - Options
 * @returns {StatusManager}
 */
export const createStatusManager = (options) => {
  return new StatusManager(options);
};

export default {
  StatusManager,
  STATUS_EVENTS,
  EVENT_TYPES,
  ALARM_TYPES,
  ALARM_SEVERITY,
  DEFAULT_THRESHOLDS,
  createStatusManager,
};
