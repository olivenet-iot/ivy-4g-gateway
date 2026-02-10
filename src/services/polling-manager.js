/**
 * Polling Manager
 *
 * Periodically polls connected meters for telemetry data.
 * Supports configurable intervals and register sets.
 *
 * Features:
 * - Configurable polling interval per meter or global
 * - Register groups (energy, instantaneous, all)
 * - Staggered polling to avoid thundering herd
 * - Automatic retry on failure
 * - Statistics tracking
 *
 * @module services/polling-manager
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import { buildReadFrame } from '../protocol/frame-builder.js';
import { ENERGY_REGISTERS, INSTANTANEOUS_REGISTERS } from '../protocol/registers.js';
import { PROTOCOL_TYPES } from '../protocol/protocol-router.js';
import { buildAarq, buildGetRequest, buildReleaseRequest, prepareDlmsForSending } from '../protocol/dlms/client.js';
import config from '../config/index.js';

const logger = createChildLogger({ module: 'polling-manager' });

/**
 * Polling events
 */
export const POLLING_EVENTS = {
  POLL_STARTED: 'poll:started',
  POLL_COMPLETED: 'poll:completed',
  POLL_FAILED: 'poll:failed',
  METER_POLLED: 'meter:polled',
  METER_POLL_ERROR: 'meter:poll:error',
  CYCLE_STARTED: 'cycle:started',
  CYCLE_COMPLETED: 'cycle:completed',
};

/**
 * Register groups for polling
 */
export const REGISTER_GROUPS = {
  ENERGY: 'energy',
  INSTANTANEOUS: 'instantaneous',
  ALL: 'all',
  CUSTOM: 'custom',
};

/**
 * Default registers to poll by group
 */
export const DEFAULT_POLL_REGISTERS = {
  [REGISTER_GROUPS.ENERGY]: [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE],
  [REGISTER_GROUPS.INSTANTANEOUS]: [
    INSTANTANEOUS_REGISTERS.VOLTAGE_A,
    INSTANTANEOUS_REGISTERS.CURRENT_A,
    INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL,
    INSTANTANEOUS_REGISTERS.POWER_FACTOR_TOTAL,
    INSTANTANEOUS_REGISTERS.FREQUENCY,
  ],
  [REGISTER_GROUPS.ALL]: [
    ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE,
    ENERGY_REGISTERS.TARIFF_1_ACTIVE,
    ENERGY_REGISTERS.TARIFF_2_ACTIVE,
    INSTANTANEOUS_REGISTERS.VOLTAGE_A,
    INSTANTANEOUS_REGISTERS.CURRENT_A,
    INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL,
    INSTANTANEOUS_REGISTERS.REACTIVE_POWER_TOTAL,
    INSTANTANEOUS_REGISTERS.POWER_FACTOR_TOTAL,
    INSTANTANEOUS_REGISTERS.FREQUENCY,
  ],
};

/**
 * DLMS OBIS codes to poll by register group.
 * Each entry has classId (COSEM class) and obisCode.
 */
export const DLMS_POLL_REGISTERS = {
  [REGISTER_GROUPS.ENERGY]: [
    { classId: 3, obisCode: '1-0:15.8.0.255', name: 'Total energy absolute' },
    { classId: 3, obisCode: '1-0:12.7.0.255', name: 'Voltage total' },
    { classId: 3, obisCode: '1-0:11.7.0.255', name: 'Current total' },
    { classId: 3, obisCode: '1-0:1.7.0.255', name: 'Active power import' },
    { classId: 3, obisCode: '1-0:14.7.0.255', name: 'Frequency' },
    { classId: 1, obisCode: '0-0:96.14.0.255', name: 'Current tariff' },
  ],
  [REGISTER_GROUPS.INSTANTANEOUS]: [
    { classId: 3, obisCode: '1-0:12.7.0.255', name: 'Voltage total' },
    { classId: 3, obisCode: '1-0:11.7.0.255', name: 'Current total' },
    { classId: 3, obisCode: '1-0:91.7.0.255', name: 'Neutral current' },
    { classId: 3, obisCode: '1-0:1.7.0.255', name: 'Active power import' },
    { classId: 3, obisCode: '1-0:3.7.0.255', name: 'Reactive power import' },
    { classId: 3, obisCode: '1-0:9.7.0.255', name: 'Apparent power import' },
    { classId: 3, obisCode: '1-0:13.7.0.255', name: 'Power factor total' },
    { classId: 3, obisCode: '1-0:14.7.0.255', name: 'Frequency' },
  ],
  [REGISTER_GROUPS.ALL]: [
    { classId: 3, obisCode: '1-0:15.8.0.255', name: 'Total energy absolute' },
    { classId: 3, obisCode: '1-0:12.7.0.255', name: 'Voltage total' },
    { classId: 3, obisCode: '1-0:11.7.0.255', name: 'Current total' },
    { classId: 3, obisCode: '1-0:91.7.0.255', name: 'Neutral current' },
    { classId: 3, obisCode: '1-0:1.7.0.255', name: 'Active power import' },
    { classId: 3, obisCode: '1-0:3.7.0.255', name: 'Reactive power import' },
    { classId: 3, obisCode: '1-0:9.7.0.255', name: 'Apparent power import' },
    { classId: 3, obisCode: '1-0:13.7.0.255', name: 'Power factor total' },
    { classId: 3, obisCode: '1-0:14.7.0.255', name: 'Frequency' },
    { classId: 1, obisCode: '0-0:96.14.0.255', name: 'Current tariff' },
  ],
};

/**
 * Polling Manager class
 */
export class PollingManager extends EventEmitter {
  /**
   * @param {Object} options - Polling options
   * @param {Object} options.tcpServer - TCP server instance
   * @param {number} [options.interval=60000] - Polling interval in ms
   * @param {string} [options.registerGroup='energy'] - Register group to poll
   * @param {Object[]} [options.customRegisters] - Custom registers to poll
   * @param {number} [options.timeout=10000] - Command timeout in ms
   * @param {number} [options.retries=2] - Retry count on failure
   * @param {number} [options.staggerDelay=100] - Delay between meters in ms
   * @param {boolean} [options.enabled=true] - Enable polling
   */
  constructor(options = {}) {
    super();

    if (!options.tcpServer) {
      throw new Error('TCP server instance required');
    }

    this.tcpServer = options.tcpServer;
    this.options = {
      interval: options.interval ?? config.polling?.interval ?? 60000,
      registerGroup:
        options.registerGroup ?? config.polling?.registerGroup ?? REGISTER_GROUPS.ENERGY,
      customRegisters: options.customRegisters ?? [],
      timeout: options.timeout ?? config.polling?.timeout ?? 10000,
      retries: options.retries ?? config.polling?.retries ?? 2,
      staggerDelay: options.staggerDelay ?? config.polling?.staggerDelay ?? 100,
      enabled: options.enabled ?? config.polling?.enabled ?? true,
    };

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {NodeJS.Timeout|null} */
    this.pollTimer = null;

    /** @type {boolean} */
    this.isPolling = false;

    /** @type {number} */
    this.cycleCount = 0;

    /** @type {Object} Statistics */
    this.stats = {
      totalPolls: 0,
      successfulPolls: 0,
      failedPolls: 0,
      totalCycles: 0,
      lastCycleTime: null,
      lastCycleDuration: null,
      averageCycleDuration: null,
    };

    /** @type {Map<string, Object>} Per-meter polling stats */
    this.meterStats = new Map();

    /** @type {Map<string, Map<number, Object>>} meterId → Map<invokeId, {obisCode, name, classId, sentAt}> */
    this.pendingDlmsRequests = new Map();

    /** @type {Map<string, {promise: Promise, resolve: Function}>} Per-meter DLMS association locks */
    this.dlmsAssociationLocks = new Map();

    logger.info('PollingManager created', { options: this.options });
  }

  /**
   * Start polling
   */
  start() {
    if (this.isRunning) {
      logger.warn('PollingManager already running');
      return;
    }

    if (!this.options.enabled) {
      logger.info('Polling disabled by configuration');
      return;
    }

    this.isRunning = true;
    this.schedulePoll();

    logger.info('PollingManager started', {
      interval: this.options.interval,
      registerGroup: this.options.registerGroup,
    });
  }

  /**
   * Stop polling
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Release all DLMS locks
    for (const [, lock] of this.dlmsAssociationLocks) {
      lock.resolve();
    }
    this.dlmsAssociationLocks.clear();

    logger.info('PollingManager stopped');
  }

  /**
   * Schedule next poll cycle
   * @private
   */
  schedulePoll() {
    if (!this.isRunning) {
      return;
    }

    this.pollTimer = setTimeout(async () => {
      await this.executePollCycle();
      this.schedulePoll();
    }, this.options.interval);
  }

  /**
   * Execute a polling cycle (poll all connected meters)
   * @returns {Promise<Object>} Cycle results
   */
  async executePollCycle() {
    if (this.isPolling) {
      logger.warn('Poll cycle already in progress, skipping');
      return { skipped: true };
    }

    this.isPolling = true;
    this.cycleCount++;
    const cycleStartTime = Date.now();

    const meters = this.tcpServer.getConnectedMeters();

    if (meters.length === 0) {
      logger.debug('No meters connected, skipping poll cycle');
      this.isPolling = false;
      return { metersPolled: 0 };
    }

    logger.info('Starting poll cycle', {
      cycle: this.cycleCount,
      meterCount: meters.length,
    });

    this.emit(POLLING_EVENTS.CYCLE_STARTED, {
      cycle: this.cycleCount,
      meterCount: meters.length,
    });

    const results = {
      cycle: this.cycleCount,
      metersPolled: 0,
      successful: 0,
      failed: 0,
      readings: [],
    };

    // Get registers to poll
    const registers = this.getRegistersToPoll();

    // Poll each meter with stagger delay
    for (let i = 0; i < meters.length; i++) {
      const meterId = meters[i];

      // Stagger to avoid thundering herd
      if (i > 0 && this.options.staggerDelay > 0) {
        await this.delay(this.options.staggerDelay);
      }

      const meterResult = await this.pollMeter(meterId, registers);
      results.metersPolled++;

      if (meterResult.success) {
        results.successful++;
        results.readings.push(...meterResult.readings);
      } else {
        results.failed++;
      }
    }

    const cycleDuration = Date.now() - cycleStartTime;

    // Update stats
    this.stats.totalCycles++;
    this.stats.lastCycleTime = cycleStartTime;
    this.stats.lastCycleDuration = cycleDuration;
    this.stats.averageCycleDuration = this.stats.averageCycleDuration
      ? (this.stats.averageCycleDuration + cycleDuration) / 2
      : cycleDuration;

    this.isPolling = false;

    logger.info('Poll cycle completed', {
      cycle: this.cycleCount,
      duration: cycleDuration,
      successful: results.successful,
      failed: results.failed,
    });

    this.emit(POLLING_EVENTS.CYCLE_COMPLETED, {
      ...results,
      duration: cycleDuration,
    });

    return results;
  }

  /**
   * Poll a single meter for all configured registers
   *
   * @param {string} meterId - Meter address
   * @param {Object[]} registers - Registers to read
   * @returns {Promise<Object>} Poll result
   */
  async pollMeter(meterId, registers) {
    const result = {
      meterId,
      success: true,
      readings: [],
      errors: [],
    };

    // Check protocol type - skip active polling for IVY/DLMS in passive mode
    const connection = this.tcpServer.connectionManager?.getConnectionByMeter(meterId);
    if (connection?.protocolType === PROTOCOL_TYPES.IVY_DLMS) {
      const dlmsConfig = config.dlms || {};
      if (dlmsConfig.passiveOnly !== false) {
        logger.debug('Skipping active poll for DLMS meter (passive mode)', { meterId });
        return { meterId, success: true, readings: [], errors: [], skipped: 'dlms_passive' };
      }
      return this.pollDlmsMeter(meterId);
    }

    // Initialize meter stats if needed
    if (!this.meterStats.has(meterId)) {
      this.meterStats.set(meterId, {
        totalPolls: 0,
        successful: 0,
        failed: 0,
        lastPoll: null,
      });
    }

    const meterStat = this.meterStats.get(meterId);

    this.emit(POLLING_EVENTS.POLL_STARTED, { meterId, registers });

    for (const register of registers) {
      const readResult = await this.readRegister(meterId, register);

      this.stats.totalPolls++;
      meterStat.totalPolls++;

      if (readResult.success) {
        this.stats.successfulPolls++;
        meterStat.successful++;
        result.readings.push(readResult.data);
      } else {
        this.stats.failedPolls++;
        meterStat.failed++;
        result.errors.push({
          register: register.key || register.name,
          error: readResult.error,
        });
      }
    }

    meterStat.lastPoll = Date.now();

    // Mark as failed if more than half of registers failed
    if (result.errors.length > registers.length / 2) {
      result.success = false;
      this.emit(POLLING_EVENTS.POLL_FAILED, {
        meterId,
        errors: result.errors,
      });
    } else {
      this.emit(POLLING_EVENTS.POLL_COMPLETED, {
        meterId,
        readings: result.readings,
      });
    }

    this.emit(POLLING_EVENTS.METER_POLLED, {
      meterId,
      success: result.success,
      readingCount: result.readings.length,
      errorCount: result.errors.length,
    });

    return result;
  }

  /**
   * Read a single register from a meter
   *
   * @param {string} meterId - Meter address
   * @param {Object} register - Register to read
   * @returns {Promise<Object>} Read result
   */
  async readRegister(meterId, register) {
    let lastError = null;

    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        const frame = buildReadFrame(meterId, register.id);

        const response = await this.tcpServer.sendCommand(
          meterId,
          frame,
          register.id,
          this.options.timeout
        );

        logger.debug('Register read successful', {
          meterId,
          register: register.key || register.name,
          value: response.value,
          unit: response.unit,
        });

        return {
          success: true,
          data: {
            meterId,
            register: register.key || register.name,
            dataId: register.id,
            value: response.value,
            unit: response.unit || register.unit,
            timestamp: Date.now(),
          },
        };
      } catch (error) {
        lastError = error;

        if (attempt < this.options.retries) {
          logger.debug('Register read failed, retrying', {
            meterId,
            register: register.key || register.name,
            attempt: attempt + 1,
            error: error.message,
          });
          await this.delay(100); // Short delay before retry
        }
      }
    }

    logger.warn('Register read failed after retries', {
      meterId,
      register: register.key || register.name,
      error: lastError?.message,
    });

    this.emit(POLLING_EVENTS.METER_POLL_ERROR, {
      meterId,
      register: register.key || register.name,
      error: lastError,
    });

    return {
      success: false,
      error: lastError?.message || 'Unknown error',
    };
  }

  /**
   * Poll a DLMS meter using COSEM GET.request.
   * Fire-and-forget: sends AARQ, GET requests, and RLRQ.
   * Responses flow through the standard DLMS event pipeline to MQTT.
   *
   * @param {string} meterId - Meter address
   * @returns {Promise<Object>} Poll result
   */
  async pollDlmsMeter(meterId) {
    const dlmsRegisters = DLMS_POLL_REGISTERS[this.options.registerGroup]
      || DLMS_POLL_REGISTERS[REGISTER_GROUPS.ENERGY];

    const wrapWithIvy = config.dlms?.wrapOutgoing !== false;
    logger.info('Starting DLMS active poll', { meterId, registerCount: dlmsRegisters.length, wrapWithIvy });

    const preparePacket = (apdu) => prepareDlmsForSending(apdu, { wrapWithIvy });

    try {
      // 1. Send AARQ (Association Request)
      const aarq = preparePacket(buildAarq());
      logger.debug('Sending AARQ', { meterId, hex: aarq.subarray(0, Math.min(32, aarq.length)).toString('hex') });
      const sent = await this.tcpServer.sendCommandNoWait(meterId, aarq);
      if (!sent) {
        logger.warn('Failed to send AARQ to DLMS meter', { meterId });
        return { meterId, success: false, readings: [], errors: ['AARQ send failed'] };
      }

      // Wait for AARE response to be processed
      await this.delay(config.dlms?.associationTimeout ?? 2000);

      // 2. Send GET.request for each register
      // Initialize pending requests map for this meter
      if (!this.pendingDlmsRequests.has(meterId)) {
        this.pendingDlmsRequests.set(meterId, new Map());
      }
      const meterPending = this.pendingDlmsRequests.get(meterId);

      for (let i = 0; i < dlmsRegisters.length; i++) {
        const reg = dlmsRegisters[i];
        const invokeId = (i + 1) & 0xFF;
        const getReq = preparePacket(
          buildGetRequest(reg.classId, reg.obisCode, 2, invokeId)
        );
        // Store invokeId → request info mapping
        meterPending.set(invokeId, {
          obisCode: reg.obisCode,
          name: reg.name,
          classId: reg.classId,
          sentAt: Date.now(),
        });
        logger.debug('Sending GET.request', { meterId, obisCode: reg.obisCode, invokeId, hex: getReq.subarray(0, Math.min(32, getReq.length)).toString('hex') });
        await this.tcpServer.sendCommandNoWait(meterId, getReq);

        // Small delay between requests to avoid overwhelming the meter
        await this.delay(200);
      }

      // Cleanup stale pending requests after 30s
      setTimeout(() => {
        const pending = this.pendingDlmsRequests.get(meterId);
        if (pending) {
          const cutoff = Date.now() - 30000;
          for (const [id, info] of pending) {
            if (info.sentAt < cutoff) {
              pending.delete(id);
            }
          }
          if (pending.size === 0) {
            this.pendingDlmsRequests.delete(meterId);
          }
        }
      }, 30000);

      // 3. Send RLRQ (Release Request)
      await this.delay(500);
      const rlrq = preparePacket(buildReleaseRequest());
      logger.debug('Sending RLRQ', { meterId, hex: rlrq.subarray(0, Math.min(32, rlrq.length)).toString('hex') });
      await this.tcpServer.sendCommandNoWait(meterId, rlrq);

      logger.info('DLMS active poll requests sent', { meterId, registerCount: dlmsRegisters.length });

      // Responses arrive asynchronously through the DLMS event pipeline
      return { meterId, success: true, readings: [], errors: [], dlmsPollSent: true };
    } catch (error) {
      logger.warn('DLMS active poll failed', { meterId, error: error.message });
      return { meterId, success: false, readings: [], errors: [error.message] };
    }
  }

  /**
   * Resolve a pending DLMS invoke ID to request info.
   * Returns and removes the stored mapping, or null if not found.
   *
   * @param {string} meterId - Meter address
   * @param {number} invokeId - DLMS invoke ID from GET.response
   * @returns {Object|null} { obisCode, name, classId, sentAt } or null
   */
  resolveDlmsInvokeId(meterId, invokeId) {
    const meterPending = this.pendingDlmsRequests.get(meterId);
    if (!meterPending) return null;

    const info = meterPending.get(invokeId);
    if (!info) return null;

    meterPending.delete(invokeId);
    // Note: Do NOT delete the meter entry from pendingDlmsRequests here even if
    // meterPending is empty. pollDlmsMeter() holds a local reference to the inner
    // Map and may still be adding invokeIds for subsequent GET.requests. Premature
    // deletion causes a race condition where invokeIds 2-6 are stored in a detached
    // Map that resolveDlmsInvokeId can no longer find. The 30s timeout in
    // pollDlmsMeter() handles stale entry cleanup instead.
    return info;
  }

  /**
   * Acquire a per-meter DLMS association lock.
   * Ensures only one DLMS association sequence runs at a time per meter.
   *
   * @param {string} meterId - Meter address
   * @param {number} [timeout=30000] - Maximum time to wait for lock (ms)
   * @returns {Promise<Function>} Release function to call when done
   * @throws {Error} If timeout expires waiting for lock
   */
  async acquireDlmsLock(meterId, timeout = 30000) {
    const startTime = Date.now();

    while (this.dlmsAssociationLocks.has(meterId)) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        throw new Error(`DLMS lock timeout for meter ${meterId} after ${timeout}ms`);
      }

      const lock = this.dlmsAssociationLocks.get(meterId);
      if (lock) {
        // Wait for existing lock to be released, with remaining timeout
        const remaining = timeout - elapsed;
        await Promise.race([
          lock.promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`DLMS lock timeout for meter ${meterId} after ${timeout}ms`)), remaining)
          ),
        ]);
      }
    }

    // Create new lock
    let lockResolve;
    const lockPromise = new Promise((resolve) => {
      lockResolve = resolve;
    });

    this.dlmsAssociationLocks.set(meterId, { promise: lockPromise, resolve: lockResolve });

    const release = () => {
      const lock = this.dlmsAssociationLocks.get(meterId);
      if (lock && lock.resolve === lockResolve) {
        this.dlmsAssociationLocks.delete(meterId);
        lockResolve();
      }
    };

    return release;
  }

  /**
   * Get registers to poll based on configuration
   * @private
   * @returns {Object[]} Registers
   */
  getRegistersToPoll() {
    if (this.options.registerGroup === REGISTER_GROUPS.CUSTOM) {
      return this.options.customRegisters;
    }

    return (
      DEFAULT_POLL_REGISTERS[this.options.registerGroup] ||
      DEFAULT_POLL_REGISTERS[REGISTER_GROUPS.ENERGY]
    );
  }

  /**
   * Trigger immediate poll for a specific meter
   *
   * @param {string} meterId - Meter address
   * @param {Object[]} [registers] - Optional custom registers
   * @returns {Promise<Object>} Poll result
   */
  async pollMeterNow(meterId, registers = null) {
    const regs = registers || this.getRegistersToPoll();
    return this.pollMeter(meterId, regs);
  }

  /**
   * Trigger immediate poll cycle for all meters
   * @returns {Promise<Object>} Cycle result
   */
  async pollAllNow() {
    return this.executePollCycle();
  }

  /**
   * Set polling interval
   * @param {number} interval - New interval in ms
   */
  setInterval(interval) {
    this.options.interval = interval;

    // Reschedule if running
    if (this.isRunning && this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.schedulePoll();
    }

    logger.info('Polling interval updated', { interval });
  }

  /**
   * Set register group
   * @param {string} group - Register group
   */
  setRegisterGroup(group) {
    if (!DEFAULT_POLL_REGISTERS[group] && group !== REGISTER_GROUPS.CUSTOM) {
      logger.warn('Invalid register group', { group });
      return;
    }

    this.options.registerGroup = group;
    logger.info('Register group updated', { group });
  }

  /**
   * Get polling statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPolling: this.isPolling,
      cycleCount: this.cycleCount,
      options: {
        interval: this.options.interval,
        registerGroup: this.options.registerGroup,
        timeout: this.options.timeout,
        retries: this.options.retries,
      },
    };
  }

  /**
   * Get per-meter statistics
   * @param {string} [meterId] - Optional specific meter
   * @returns {Object} Meter stats
   */
  getMeterStats(meterId) {
    if (meterId) {
      return this.meterStats.get(meterId) || null;
    }

    const stats = {};
    for (const [id, stat] of this.meterStats) {
      stats[id] = stat;
    }
    return stats;
  }

  /**
   * Delay helper
   * @private
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create polling manager instance
 * @param {Object} options - Options
 * @returns {PollingManager}
 */
export const createPollingManager = (options) => {
  return new PollingManager(options);
};

export default {
  PollingManager,
  POLLING_EVENTS,
  REGISTER_GROUPS,
  DEFAULT_POLL_REGISTERS,
  DLMS_POLL_REGISTERS,
  createPollingManager,
};
