/**
 * DLMS Capture Service
 *
 * Logs all raw DLMS packets with full hex dumps and parsed analysis.
 * Tracks timing patterns and OBIS code inventory.
 * Generates summary after configurable duration.
 *
 * Used to understand what a DLMS meter pushes spontaneously
 * before implementing full active query support.
 *
 * Configuration:
 *   DLMS_CAPTURE_ENABLED=true
 *   DLMS_CAPTURE_DURATION=3600000  (1 hour default)
 *
 * @module services/dlms-capture-service
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import { SERVER_EVENTS } from '../tcp/server.js';
import config from '../config/index.js';

const logger = createChildLogger({ module: 'dlms-capture' });

/**
 * Capture service events
 */
export const CAPTURE_EVENTS = {
  PACKET_CAPTURED: 'capture:packet',
  CAPTURE_STARTED: 'capture:started',
  CAPTURE_STOPPED: 'capture:stopped',
  CAPTURE_SUMMARY: 'capture:summary',
};

/**
 * DLMS Capture Service
 */
export class DlmsCaptureService extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} [options.tcpServer] - TCP server instance to listen on
   * @param {number} [options.duration] - Capture duration in ms (0 = indefinite)
   * @param {boolean} [options.enabled] - Whether capture is enabled
   */
  constructor(options = {}) {
    super();

    const dlmsConfig = config.dlms || {};

    this.tcpServer = options.tcpServer || null;
    this.options = {
      duration: options.duration ?? dlmsConfig.captureDuration ?? 3600000,
      enabled: options.enabled ?? dlmsConfig.captureEnabled ?? false,
    };

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {NodeJS.Timeout|null} */
    this.durationTimer = null;

    /** @type {Date|null} */
    this.startTime = null;

    /** @type {Object[]} Captured packets */
    this.packets = [];

    /** @type {Map<string, Object>} OBIS code inventory */
    this.obisInventory = new Map();

    /** @type {Map<string, number[]>} Timing data per APDU type */
    this.timingData = new Map();

    /** @type {number} Last packet timestamp */
    this.lastPacketTime = 0;

    logger.info('DlmsCaptureService created', { options: this.options });
  }

  /**
   * Start capturing
   */
  start() {
    if (!this.options.enabled) {
      logger.info('DLMS capture disabled by configuration');
      return;
    }

    if (this.isRunning) {
      logger.warn('DlmsCaptureService already running');
      return;
    }

    this.isRunning = true;
    this.startTime = new Date();
    this.packets = [];
    this.obisInventory.clear();
    this.timingData.clear();
    this.lastPacketTime = 0;

    this.setupListeners();

    if (this.options.duration > 0) {
      this.durationTimer = setTimeout(() => {
        this.stop();
      }, this.options.duration);
    }

    logger.info('DLMS capture started', {
      duration: this.options.duration,
      willStopAt: this.options.duration > 0
        ? new Date(Date.now() + this.options.duration).toISOString()
        : 'manual',
    });

    this.emit(CAPTURE_EVENTS.CAPTURE_STARTED, {
      startTime: this.startTime.toISOString(),
      duration: this.options.duration,
    });
  }

  /**
   * Stop capturing and generate summary
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }

    const summary = this.generateSummary();

    logger.info('DLMS capture stopped', summary);

    this.emit(CAPTURE_EVENTS.CAPTURE_STOPPED, summary);
    this.emit(CAPTURE_EVENTS.CAPTURE_SUMMARY, summary);

    return summary;
  }

  /**
   * Setup TCP server event listeners
   * @private
   */
  setupListeners() {
    if (!this.tcpServer) return;

    // Listen for DLMS telemetry events
    this.tcpServer.on(SERVER_EVENTS.DLMS_TELEMETRY_RECEIVED, (data) => {
      this.capturePacket(data);
    });

    // Listen for DLMS events
    this.tcpServer.on(SERVER_EVENTS.DLMS_EVENT_RECEIVED, (data) => {
      this.capturePacket(data);
    });
  }

  /**
   * Capture a DLMS packet
   * @param {Object} data - DLMS data from TCP server event
   */
  capturePacket(data) {
    if (!this.isRunning) return;

    const now = Date.now();
    const interval = this.lastPacketTime > 0 ? now - this.lastPacketTime : 0;

    const capture = {
      index: this.packets.length,
      timestamp: new Date(now).toISOString(),
      intervalMs: interval,
      meterId: data.meterId,
      source: data.source || 'dlms',
      apduType: data.apduType || data.eventType || 'unknown',
      telemetry: data.telemetry || null,
      rawHex: data.raw ? data.raw.toString('hex') : null,
    };

    this.packets.push(capture);
    this.lastPacketTime = now;

    // Update OBIS inventory
    if (data.telemetry?.readings) {
      for (const [key, reading] of Object.entries(data.telemetry.readings)) {
        const obis = reading.obis || key;
        const existing = this.obisInventory.get(obis) || {
          count: 0,
          name: key,
          unit: reading.unit,
          firstSeen: now,
          lastSeen: now,
          sampleValues: [],
        };
        existing.count++;
        existing.lastSeen = now;
        if (existing.sampleValues.length < 5) {
          existing.sampleValues.push(reading.value);
        }
        this.obisInventory.set(obis, existing);
      }
    }

    // Update timing data
    const typeKey = capture.apduType;
    const timings = this.timingData.get(typeKey) || [];
    if (interval > 0) {
      timings.push(interval);
    }
    this.timingData.set(typeKey, timings);

    logger.debug('DLMS packet captured', {
      index: capture.index,
      apduType: capture.apduType,
      meterId: capture.meterId,
      intervalMs: interval,
    });

    this.emit(CAPTURE_EVENTS.PACKET_CAPTURED, capture);
  }

  /**
   * Generate summary report
   * @returns {Object} Summary
   */
  generateSummary() {
    const duration = this.startTime
      ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
      : 0;

    const obisEntries = {};
    for (const [obis, data] of this.obisInventory) {
      obisEntries[obis] = {
        name: data.name,
        unit: data.unit,
        count: data.count,
        firstSeen: new Date(data.firstSeen).toISOString(),
        lastSeen: new Date(data.lastSeen).toISOString(),
        sampleValues: data.sampleValues,
      };
    }

    const timingStats = {};
    for (const [type, intervals] of this.timingData) {
      if (intervals.length > 0) {
        const sorted = [...intervals].sort((a, b) => a - b);
        timingStats[type] = {
          count: intervals.length,
          minMs: sorted[0],
          maxMs: sorted[sorted.length - 1],
          avgMs: Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length),
          medianMs: sorted[Math.floor(sorted.length / 2)],
        };
      }
    }

    return {
      captureStarted: this.startTime?.toISOString() || null,
      durationSeconds: duration,
      totalPackets: this.packets.length,
      uniqueObisCodesSeen: this.obisInventory.size,
      obisInventory: obisEntries,
      timingByType: timingStats,
      packetsPerMinute: duration > 0 ? Math.round((this.packets.length / duration) * 60) : 0,
    };
  }

  /**
   * Get current stats
   * @returns {Object}
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      enabled: this.options.enabled,
      packetsCaptured: this.packets.length,
      uniqueObisCodes: this.obisInventory.size,
      startTime: this.startTime?.toISOString() || null,
    };
  }
}

/**
 * Create capture service instance
 * @param {Object} options
 * @returns {DlmsCaptureService}
 */
export const createDlmsCaptureService = (options) => {
  return new DlmsCaptureService(options);
};

export default {
  DlmsCaptureService,
  CAPTURE_EVENTS,
  createDlmsCaptureService,
};
