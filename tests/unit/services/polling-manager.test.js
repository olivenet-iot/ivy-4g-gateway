/**
 * Polling Manager Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PollingManager,
  POLLING_EVENTS,
  REGISTER_GROUPS,
  DEFAULT_POLL_REGISTERS,
  createPollingManager,
} from '../../../src/services/polling-manager.js';
import { ENERGY_REGISTERS, INSTANTANEOUS_REGISTERS } from '../../../src/protocol/registers.js';

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock frame-builder
vi.mock('../../../src/protocol/frame-builder.js', () => ({
  buildReadFrame: vi.fn((meterId, dataId) => Buffer.from(`read:${meterId}:${dataId}`)),
}));

/**
 * Create mock TCP server
 */
const createMockTCPServer = () => ({
  getConnectedMeters: vi.fn(() => []),
  sendCommand: vi.fn(() =>
    Promise.resolve({
      value: 123.45,
      unit: 'kWh',
    })
  ),
});

describe('Polling Manager', () => {
  let mockTCPServer;

  beforeEach(() => {
    vi.useFakeTimers();
    mockTCPServer = createMockTCPServer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('POLLING_EVENTS', () => {
    it('should define POLL_STARTED event', () => {
      expect(POLLING_EVENTS.POLL_STARTED).toBe('poll:started');
    });

    it('should define POLL_COMPLETED event', () => {
      expect(POLLING_EVENTS.POLL_COMPLETED).toBe('poll:completed');
    });

    it('should define POLL_FAILED event', () => {
      expect(POLLING_EVENTS.POLL_FAILED).toBe('poll:failed');
    });

    it('should define METER_POLLED event', () => {
      expect(POLLING_EVENTS.METER_POLLED).toBe('meter:polled');
    });

    it('should define METER_POLL_ERROR event', () => {
      expect(POLLING_EVENTS.METER_POLL_ERROR).toBe('meter:poll:error');
    });

    it('should define CYCLE_STARTED event', () => {
      expect(POLLING_EVENTS.CYCLE_STARTED).toBe('cycle:started');
    });

    it('should define CYCLE_COMPLETED event', () => {
      expect(POLLING_EVENTS.CYCLE_COMPLETED).toBe('cycle:completed');
    });
  });

  describe('REGISTER_GROUPS', () => {
    it('should define ENERGY group', () => {
      expect(REGISTER_GROUPS.ENERGY).toBe('energy');
    });

    it('should define INSTANTANEOUS group', () => {
      expect(REGISTER_GROUPS.INSTANTANEOUS).toBe('instantaneous');
    });

    it('should define ALL group', () => {
      expect(REGISTER_GROUPS.ALL).toBe('all');
    });

    it('should define CUSTOM group', () => {
      expect(REGISTER_GROUPS.CUSTOM).toBe('custom');
    });
  });

  describe('DEFAULT_POLL_REGISTERS', () => {
    it('should have energy registers', () => {
      const energyRegs = DEFAULT_POLL_REGISTERS[REGISTER_GROUPS.ENERGY];
      expect(energyRegs).toBeDefined();
      expect(energyRegs).toContain(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);
    });

    it('should have instantaneous registers', () => {
      const instantRegs = DEFAULT_POLL_REGISTERS[REGISTER_GROUPS.INSTANTANEOUS];
      expect(instantRegs).toBeDefined();
      expect(instantRegs).toContain(INSTANTANEOUS_REGISTERS.VOLTAGE_A);
      expect(instantRegs).toContain(INSTANTANEOUS_REGISTERS.CURRENT_A);
      expect(instantRegs).toContain(INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL);
    });

    it('should have all registers (combined)', () => {
      const allRegs = DEFAULT_POLL_REGISTERS[REGISTER_GROUPS.ALL];
      expect(allRegs).toBeDefined();
      expect(allRegs).toContain(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);
      expect(allRegs).toContain(INSTANTANEOUS_REGISTERS.VOLTAGE_A);
    });
  });

  describe('constructor', () => {
    it('should throw error if tcpServer is not provided', () => {
      expect(() => new PollingManager()).toThrow('TCP server instance required');
    });

    it('should create instance with tcpServer', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      expect(pm).toBeInstanceOf(PollingManager);
    });

    it('should use default options', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      expect(pm.options.interval).toBe(60000);
      expect(pm.options.registerGroup).toBe('energy');
      expect(pm.options.timeout).toBe(10000);
      expect(pm.options.retries).toBe(2);
      expect(pm.options.staggerDelay).toBe(100);
      expect(pm.options.enabled).toBe(true);
    });

    it('should accept custom options', () => {
      const pm = new PollingManager({
        tcpServer: mockTCPServer,
        interval: 30000,
        registerGroup: 'instantaneous',
        timeout: 5000,
        retries: 3,
        staggerDelay: 200,
        enabled: false,
      });
      expect(pm.options.interval).toBe(30000);
      expect(pm.options.registerGroup).toBe('instantaneous');
      expect(pm.options.timeout).toBe(5000);
      expect(pm.options.retries).toBe(3);
      expect(pm.options.staggerDelay).toBe(200);
      expect(pm.options.enabled).toBe(false);
    });

    it('should initialize state properly', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      expect(pm.isRunning).toBe(false);
      expect(pm.isPolling).toBe(false);
      expect(pm.cycleCount).toBe(0);
      expect(pm.pollTimer).toBeNull();
    });

    it('should initialize stats properly', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      expect(pm.stats.totalPolls).toBe(0);
      expect(pm.stats.successfulPolls).toBe(0);
      expect(pm.stats.failedPolls).toBe(0);
      expect(pm.stats.totalCycles).toBe(0);
    });
  });

  describe('start/stop', () => {
    it('should start polling', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.start();
      expect(pm.isRunning).toBe(true);
      expect(pm.pollTimer).not.toBeNull();
      pm.stop();
    });

    it('should not start if already running', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.start();
      const timer1 = pm.pollTimer;
      pm.start();
      expect(pm.pollTimer).toBe(timer1); // Same timer
      pm.stop();
    });

    it('should not start if disabled', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer, enabled: false });
      pm.start();
      expect(pm.isRunning).toBe(false);
      expect(pm.pollTimer).toBeNull();
    });

    it('should stop polling', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.start();
      pm.stop();
      expect(pm.isRunning).toBe(false);
      expect(pm.pollTimer).toBeNull();
    });

    it('should handle stop when not running', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      expect(() => pm.stop()).not.toThrow();
    });
  });

  describe('executePollCycle', () => {
    it('should skip if already polling', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.isPolling = true;

      const result = await pm.executePollCycle();
      expect(result.skipped).toBe(true);
    });

    it('should skip if no meters connected', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue([]);
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const result = await pm.executePollCycle();
      expect(result.metersPolled).toBe(0);
    });

    it('should emit CYCLE_STARTED event', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1']);
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const cycleStarted = vi.fn();
      pm.on(POLLING_EVENTS.CYCLE_STARTED, cycleStarted);

      await pm.executePollCycle();

      expect(cycleStarted).toHaveBeenCalledWith({
        cycle: 1,
        meterCount: 1,
      });
    });

    it('should emit CYCLE_COMPLETED event', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1']);
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const cycleCompleted = vi.fn();
      pm.on(POLLING_EVENTS.CYCLE_COMPLETED, cycleCompleted);

      await pm.executePollCycle();

      expect(cycleCompleted).toHaveBeenCalled();
      expect(cycleCompleted.mock.calls[0][0]).toMatchObject({
        cycle: 1,
        metersPolled: 1,
      });
    });

    it('should poll all connected meters', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1', 'meter2']);
      const pm = new PollingManager({ tcpServer: mockTCPServer, staggerDelay: 10 });

      const executePromise = pm.executePollCycle();
      await vi.advanceTimersByTimeAsync(500);
      const result = await executePromise;

      expect(result.metersPolled).toBe(2);
    });

    it('should increment cycle count', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1']);
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      await pm.executePollCycle();
      expect(pm.cycleCount).toBe(1);

      await pm.executePollCycle();
      expect(pm.cycleCount).toBe(2);
    });

    it('should update stats', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1']);
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      await pm.executePollCycle();

      expect(pm.stats.totalCycles).toBe(1);
      expect(pm.stats.lastCycleTime).not.toBeNull();
      expect(pm.stats.lastCycleDuration).not.toBeNull();
    });

    it('should apply stagger delay between meters', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1', 'meter2', 'meter3']);
      const pm = new PollingManager({ tcpServer: mockTCPServer, staggerDelay: 100 });

      const executePromise = pm.executePollCycle();

      // Advance timers to allow stagger delays
      await vi.advanceTimersByTimeAsync(500);
      await executePromise;

      // Should have called sendCommand for each meter
      expect(mockTCPServer.sendCommand).toHaveBeenCalled();
    });
  });

  describe('pollMeter', () => {
    it('should emit POLL_STARTED event', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const pollStarted = vi.fn();
      pm.on(POLLING_EVENTS.POLL_STARTED, pollStarted);

      await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      expect(pollStarted).toHaveBeenCalledWith({
        meterId: 'meter1',
        registers: [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE],
      });
    });

    it('should read all registers', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const registers = [
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE,
        INSTANTANEOUS_REGISTERS.VOLTAGE_A,
      ];

      await pm.pollMeter('meter1', registers);

      expect(mockTCPServer.sendCommand).toHaveBeenCalledTimes(2);
    });

    it('should return readings on success', async () => {
      mockTCPServer.sendCommand.mockResolvedValue({ value: 100.5, unit: 'kWh' });
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const result = await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      expect(result.success).toBe(true);
      expect(result.readings.length).toBe(1);
      expect(result.readings[0].value).toBe(100.5);
    });

    it('should track errors for failed registers', async () => {
      mockTCPServer.sendCommand.mockRejectedValue(new Error('Timeout'));
      const pm = new PollingManager({ tcpServer: mockTCPServer, retries: 0 });

      const result = await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toBe('Timeout');
    });

    it('should emit POLL_COMPLETED for successful polls', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const pollCompleted = vi.fn();
      pm.on(POLLING_EVENTS.POLL_COMPLETED, pollCompleted);

      await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      expect(pollCompleted).toHaveBeenCalled();
    });

    it('should emit POLL_FAILED when most registers fail', async () => {
      mockTCPServer.sendCommand.mockRejectedValue(new Error('Timeout'));
      const pm = new PollingManager({ tcpServer: mockTCPServer, retries: 0 });

      const pollFailed = vi.fn();
      pm.on(POLLING_EVENTS.POLL_FAILED, pollFailed);

      await pm.pollMeter('meter1', [
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE,
        INSTANTANEOUS_REGISTERS.VOLTAGE_A,
      ]);

      expect(pollFailed).toHaveBeenCalled();
    });

    it('should emit METER_POLLED event', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const meterPolled = vi.fn();
      pm.on(POLLING_EVENTS.METER_POLLED, meterPolled);

      await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      expect(meterPolled).toHaveBeenCalledWith({
        meterId: 'meter1',
        success: true,
        readingCount: 1,
        errorCount: 0,
      });
    });

    it('should initialize meter stats', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      const stats = pm.getMeterStats('meter1');
      expect(stats).not.toBeNull();
      expect(stats.totalPolls).toBe(1);
    });
  });

  describe('readRegister', () => {
    it('should call sendCommand with correct parameters', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer, timeout: 5000 });

      await pm.readRegister('meter1', ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);

      expect(mockTCPServer.sendCommand).toHaveBeenCalledWith(
        'meter1',
        expect.any(Buffer),
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id,
        5000
      );
    });

    it('should return success result on successful read', async () => {
      mockTCPServer.sendCommand.mockResolvedValue({ value: 123.45, unit: 'kWh' });
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const result = await pm.readRegister('meter1', ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);

      expect(result.success).toBe(true);
      expect(result.data.value).toBe(123.45);
      expect(result.data.meterId).toBe('meter1');
    });

    it('should retry on failure', async () => {
      mockTCPServer.sendCommand
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockRejectedValueOnce(new Error('Timeout'))
        .mockResolvedValue({ value: 100 });

      const pm = new PollingManager({ tcpServer: mockTCPServer, retries: 2 });

      // Advance timers for retry delays
      const resultPromise = pm.readRegister('meter1', ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(mockTCPServer.sendCommand).toHaveBeenCalledTimes(3);
    });

    it('should return failure after all retries exhausted', async () => {
      mockTCPServer.sendCommand.mockRejectedValue(new Error('Timeout'));
      const pm = new PollingManager({ tcpServer: mockTCPServer, retries: 2 });

      const resultPromise = pm.readRegister('meter1', ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Timeout');
      expect(mockTCPServer.sendCommand).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should emit METER_POLL_ERROR on failure', async () => {
      mockTCPServer.sendCommand.mockRejectedValue(new Error('Connection lost'));
      const pm = new PollingManager({ tcpServer: mockTCPServer, retries: 0 });

      const pollError = vi.fn();
      pm.on(POLLING_EVENTS.METER_POLL_ERROR, pollError);

      await pm.readRegister('meter1', ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);

      expect(pollError).toHaveBeenCalledWith({
        meterId: 'meter1',
        register: ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.key || ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.name,
        error: expect.any(Error),
      });
    });
  });

  describe('pollMeterNow', () => {
    it('should poll meter immediately', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const result = await pm.pollMeterNow('meter1');

      expect(result.meterId).toBe('meter1');
      expect(mockTCPServer.sendCommand).toHaveBeenCalled();
    });

    it('should use default registers if none provided', async () => {
      const pm = new PollingManager({
        tcpServer: mockTCPServer,
        registerGroup: 'energy',
      });

      await pm.pollMeterNow('meter1');

      // Should have polled energy registers
      expect(mockTCPServer.sendCommand).toHaveBeenCalled();
    });

    it('should use custom registers if provided', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      const customRegisters = [
        INSTANTANEOUS_REGISTERS.VOLTAGE_A,
        INSTANTANEOUS_REGISTERS.VOLTAGE_B,
      ];

      await pm.pollMeterNow('meter1', customRegisters);

      expect(mockTCPServer.sendCommand).toHaveBeenCalledTimes(2);
    });
  });

  describe('pollAllNow', () => {
    it('should execute poll cycle immediately', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1', 'meter2']);
      const pm = new PollingManager({ tcpServer: mockTCPServer, staggerDelay: 10 });

      const resultPromise = pm.pollAllNow();
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.metersPolled).toBe(2);
    });

    it('should work even when polling is stopped', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1']);
      const pm = new PollingManager({ tcpServer: mockTCPServer, staggerDelay: 0 });
      // Don't start polling

      const result = await pm.pollAllNow();

      expect(result.metersPolled).toBe(1);
    });
  });

  describe('setInterval', () => {
    it('should update interval option', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.setInterval(30000);
      expect(pm.options.interval).toBe(30000);
    });

    it('should reschedule if running', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer, interval: 60000 });
      pm.start();
      const oldTimer = pm.pollTimer;

      pm.setInterval(30000);

      expect(pm.pollTimer).not.toBe(oldTimer);
      pm.stop();
    });
  });

  describe('setRegisterGroup', () => {
    it('should update register group', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.setRegisterGroup('instantaneous');
      expect(pm.options.registerGroup).toBe('instantaneous');
    });

    it('should reject invalid group', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.setRegisterGroup('invalid');
      expect(pm.options.registerGroup).toBe('energy'); // Unchanged
    });

    it('should accept custom group', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      pm.setRegisterGroup('custom');
      expect(pm.options.registerGroup).toBe('custom');
    });
  });

  describe('getStats', () => {
    it('should return global statistics', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const stats = pm.getStats();

      expect(stats).toHaveProperty('totalPolls');
      expect(stats).toHaveProperty('successfulPolls');
      expect(stats).toHaveProperty('failedPolls');
      expect(stats).toHaveProperty('totalCycles');
      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('isPolling');
      expect(stats).toHaveProperty('cycleCount');
    });

    it('should include options', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const stats = pm.getStats();

      expect(stats.options).toHaveProperty('interval');
      expect(stats.options).toHaveProperty('registerGroup');
      expect(stats.options).toHaveProperty('timeout');
      expect(stats.options).toHaveProperty('retries');
    });
  });

  describe('getMeterStats', () => {
    it('should return null for unknown meter', () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });

      const stats = pm.getMeterStats('unknown');

      expect(stats).toBeNull();
    });

    it('should return stats for polled meter', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      const stats = pm.getMeterStats('meter1');

      expect(stats).not.toBeNull();
      expect(stats.totalPolls).toBe(1);
      expect(stats.successful).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.lastPoll).not.toBeNull();
    });

    it('should return all meter stats if no id provided', async () => {
      const pm = new PollingManager({ tcpServer: mockTCPServer });
      await pm.pollMeter('meter1', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);
      await pm.pollMeter('meter2', [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE]);

      const stats = pm.getMeterStats();

      expect(stats).toHaveProperty('meter1');
      expect(stats).toHaveProperty('meter2');
    });
  });

  describe('createPollingManager', () => {
    it('should create PollingManager instance', () => {
      const pm = createPollingManager({ tcpServer: mockTCPServer });
      expect(pm).toBeInstanceOf(PollingManager);
    });
  });

  describe('scheduled polling', () => {
    it('should execute poll cycle at interval', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1']);
      const pm = new PollingManager({ tcpServer: mockTCPServer, interval: 5000 });

      pm.start();

      // No poll yet
      expect(pm.cycleCount).toBe(0);

      // Advance to first poll
      await vi.advanceTimersByTimeAsync(5000);
      expect(pm.cycleCount).toBe(1);

      // Advance to second poll
      await vi.advanceTimersByTimeAsync(5000);
      expect(pm.cycleCount).toBe(2);

      pm.stop();
    });

    it('should stop scheduled polling on stop', async () => {
      mockTCPServer.getConnectedMeters.mockReturnValue(['meter1']);
      const pm = new PollingManager({ tcpServer: mockTCPServer, interval: 5000 });

      pm.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(pm.cycleCount).toBe(1);

      pm.stop();

      // Advance time - should not poll again
      await vi.advanceTimersByTimeAsync(10000);
      expect(pm.cycleCount).toBe(1);
    });
  });
});
