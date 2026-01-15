/**
 * Status Manager Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StatusManager,
  STATUS_EVENTS,
  EVENT_TYPES,
  ALARM_TYPES,
  ALARM_SEVERITY,
  DEFAULT_THRESHOLDS,
  createStatusManager,
} from '../../../src/services/status-manager.js';

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

// Mock tcp server events
vi.mock('../../../src/tcp/server.js', () => ({
  SERVER_EVENTS: {
    METER_CONNECTED: 'meter:connected',
    METER_DISCONNECTED: 'meter:disconnected',
    TELEMETRY_RECEIVED: 'telemetry:received',
    SERVER_ERROR: 'server:error',
    ERROR_RESPONSE: 'error:response',
  },
}));

/**
 * Create mock TCP server
 */
const createMockTCPServer = () => {
  const handlers = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    emit: vi.fn(),
    _handlers: handlers,
    _simulateEvent: (event, data) => {
      if (handlers[event]) {
        handlers[event](data);
      }
    },
  };
};

/**
 * Create mock publisher
 */
const createMockPublisher = () => ({
  publishMeterStatus: vi.fn(() => Promise.resolve(true)),
  publishMeterEvent: vi.fn(() => Promise.resolve(true)),
  publishGatewayStats: vi.fn(() => Promise.resolve(true)),
});

describe('Status Manager', () => {
  let mockTCPServer;
  let mockPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    mockTCPServer = createMockTCPServer();
    mockPublisher = createMockPublisher();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('STATUS_EVENTS', () => {
    it('should define METER_ONLINE event', () => {
      expect(STATUS_EVENTS.METER_ONLINE).toBe('meter:online');
    });

    it('should define METER_OFFLINE event', () => {
      expect(STATUS_EVENTS.METER_OFFLINE).toBe('meter:offline');
    });

    it('should define METER_STATUS_CHANGED event', () => {
      expect(STATUS_EVENTS.METER_STATUS_CHANGED).toBe('meter:status:changed');
    });

    it('should define GATEWAY_STATUS_CHANGED event', () => {
      expect(STATUS_EVENTS.GATEWAY_STATUS_CHANGED).toBe('gateway:status:changed');
    });

    it('should define EVENT_CREATED event', () => {
      expect(STATUS_EVENTS.EVENT_CREATED).toBe('event:created');
    });

    it('should define ALARM_TRIGGERED event', () => {
      expect(STATUS_EVENTS.ALARM_TRIGGERED).toBe('alarm:triggered');
    });

    it('should define ALARM_CLEARED event', () => {
      expect(STATUS_EVENTS.ALARM_CLEARED).toBe('alarm:cleared');
    });
  });

  describe('EVENT_TYPES', () => {
    it('should define METER_CONNECTED event type', () => {
      expect(EVENT_TYPES.METER_CONNECTED).toBe('meter_connected');
    });

    it('should define METER_DISCONNECTED event type', () => {
      expect(EVENT_TYPES.METER_DISCONNECTED).toBe('meter_disconnected');
    });

    it('should define METER_RECONNECTED event type', () => {
      expect(EVENT_TYPES.METER_RECONNECTED).toBe('meter_reconnected');
    });

    it('should define GATEWAY_STARTED event type', () => {
      expect(EVENT_TYPES.GATEWAY_STARTED).toBe('gateway_started');
    });

    it('should define GATEWAY_STOPPED event type', () => {
      expect(EVENT_TYPES.GATEWAY_STOPPED).toBe('gateway_stopped');
    });
  });

  describe('ALARM_TYPES', () => {
    it('should define OVERVOLTAGE alarm type', () => {
      expect(ALARM_TYPES.OVERVOLTAGE).toBe('overvoltage');
    });

    it('should define UNDERVOLTAGE alarm type', () => {
      expect(ALARM_TYPES.UNDERVOLTAGE).toBe('undervoltage');
    });

    it('should define OVERCURRENT alarm type', () => {
      expect(ALARM_TYPES.OVERCURRENT).toBe('overcurrent');
    });

    it('should define OVERLOAD alarm type', () => {
      expect(ALARM_TYPES.OVERLOAD).toBe('overload');
    });

    it('should define COMMUNICATION_LOST alarm type', () => {
      expect(ALARM_TYPES.COMMUNICATION_LOST).toBe('communication_lost');
    });

    it('should define LOW_BALANCE alarm type', () => {
      expect(ALARM_TYPES.LOW_BALANCE).toBe('low_balance');
    });
  });

  describe('ALARM_SEVERITY', () => {
    it('should define INFO severity', () => {
      expect(ALARM_SEVERITY.INFO).toBe('info');
    });

    it('should define WARNING severity', () => {
      expect(ALARM_SEVERITY.WARNING).toBe('warning');
    });

    it('should define CRITICAL severity', () => {
      expect(ALARM_SEVERITY.CRITICAL).toBe('critical');
    });
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('should have default overvoltage threshold', () => {
      expect(DEFAULT_THRESHOLDS.overvoltage).toBe(250);
    });

    it('should have default undervoltage threshold', () => {
      expect(DEFAULT_THRESHOLDS.undervoltage).toBe(180);
    });

    it('should have default overcurrent threshold', () => {
      expect(DEFAULT_THRESHOLDS.overcurrent).toBe(100);
    });

    it('should have default overload threshold', () => {
      expect(DEFAULT_THRESHOLDS.overload).toBe(10000);
    });

    it('should have default lowBalance threshold', () => {
      expect(DEFAULT_THRESHOLDS.lowBalance).toBe(10);
    });
  });

  describe('constructor', () => {
    it('should create instance with default options', () => {
      const sm = new StatusManager();
      expect(sm).toBeInstanceOf(StatusManager);
      expect(sm.options.statusInterval).toBe(30000);
    });

    it('should accept custom options', () => {
      const sm = new StatusManager({
        statusInterval: 60000,
        thresholds: { overvoltage: 260 },
      });
      expect(sm.options.statusInterval).toBe(60000);
      expect(sm.options.thresholds.overvoltage).toBe(260);
    });

    it('should accept publisher and tcpServer', () => {
      const sm = new StatusManager({
        publisher: mockPublisher,
        tcpServer: mockTCPServer,
      });
      expect(sm.publisher).toBe(mockPublisher);
      expect(sm.tcpServer).toBe(mockTCPServer);
    });

    it('should initialize state properly', () => {
      const sm = new StatusManager();
      expect(sm.isRunning).toBe(false);
      expect(sm.statusTimer).toBeNull();
      expect(sm.meterStatus.size).toBe(0);
      expect(sm.activeAlarms.size).toBe(0);
      expect(sm.recentEvents.length).toBe(0);
    });

    it('should initialize stats', () => {
      const sm = new StatusManager();
      expect(sm.stats.totalEvents).toBe(0);
      expect(sm.stats.totalAlarms).toBe(0);
      expect(sm.stats.alarmsCleared).toBe(0);
      expect(sm.stats.metersOnline).toBe(0);
    });
  });

  describe('start/stop', () => {
    it('should start the manager', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
      expect(sm.isRunning).toBe(true);
      expect(sm.startTime).toBeInstanceOf(Date);
      sm.stop();
    });

    it('should not start if already running', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
      const startTime = sm.startTime;
      sm.start();
      expect(sm.startTime).toBe(startTime);
      sm.stop();
    });

    it('should setup TCP event listeners on start', () => {
      const sm = new StatusManager({
        publisher: mockPublisher,
        tcpServer: mockTCPServer,
      });
      sm.start();
      expect(mockTCPServer.on).toHaveBeenCalledTimes(3);
      sm.stop();
    });

    it('should start status publishing on start', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
      expect(sm.statusTimer).not.toBeNull();
      sm.stop();
    });

    it('should create gateway started event on start', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      const eventCreated = vi.fn();
      sm.on(STATUS_EVENTS.EVENT_CREATED, eventCreated);
      sm.start();
      expect(eventCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EVENT_TYPES.GATEWAY_STARTED,
        })
      );
      sm.stop();
    });

    it('should stop the manager', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
      sm.stop();
      expect(sm.isRunning).toBe(false);
      expect(sm.statusTimer).toBeNull();
    });

    it('should create gateway stopped event on stop', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
      const eventCreated = vi.fn();
      sm.on(STATUS_EVENTS.EVENT_CREATED, eventCreated);
      sm.stop();
      expect(eventCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EVENT_TYPES.GATEWAY_STOPPED,
        })
      );
    });
  });

  describe('handleMeterConnected', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({
        publisher: mockPublisher,
        tcpServer: mockTCPServer,
      });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should update meter status to online', () => {
      sm.handleMeterConnected('000000001234', '192.168.1.100');

      const status = sm.getMeterStatus('000000001234');
      expect(status.online).toBe(true);
      expect(status.remoteAddress).toBe('192.168.1.100');
    });

    it('should emit METER_ONLINE event', () => {
      const meterOnline = vi.fn();
      sm.on(STATUS_EVENTS.METER_ONLINE, meterOnline);

      sm.handleMeterConnected('000000001234', '192.168.1.100');

      expect(meterOnline).toHaveBeenCalledWith({
        meterId: '000000001234',
        remoteAddress: '192.168.1.100',
      });
    });

    it('should create meter_connected event', () => {
      const eventCreated = vi.fn();
      sm.on(STATUS_EVENTS.EVENT_CREATED, eventCreated);

      sm.handleMeterConnected('000000001234', '192.168.1.100');

      expect(eventCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EVENT_TYPES.METER_CONNECTED,
          data: expect.objectContaining({
            meterId: '000000001234',
          }),
        })
      );
    });

    it('should create meter_reconnected event if was offline', () => {
      // First connect, then disconnect, then reconnect
      sm.handleMeterConnected('000000001234', '192.168.1.100');
      sm.handleMeterDisconnected('000000001234');

      const eventCreated = vi.fn();
      sm.on(STATUS_EVENTS.EVENT_CREATED, eventCreated);

      sm.handleMeterConnected('000000001234', '192.168.1.100');

      expect(eventCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EVENT_TYPES.METER_RECONNECTED,
        })
      );
    });

    it('should publish meter status', () => {
      sm.handleMeterConnected('000000001234', '192.168.1.100');

      expect(mockPublisher.publishMeterStatus).toHaveBeenCalledWith(
        '000000001234',
        true,
        { ip: '192.168.1.100' }
      );
    });

    it('should clear communication alarm if exists', () => {
      // Create a communication alarm first
      sm.createAlarm('000000001234', ALARM_TYPES.COMMUNICATION_LOST, ALARM_SEVERITY.WARNING);
      expect(sm.activeAlarms.size).toBe(1);

      sm.handleMeterConnected('000000001234', '192.168.1.100');

      expect(sm.activeAlarms.size).toBe(0);
    });

    it('should increment metersOnline stat', () => {
      expect(sm.stats.metersOnline).toBe(0);

      sm.handleMeterConnected('000000001234', '192.168.1.100');

      expect(sm.stats.metersOnline).toBe(1);
    });
  });

  describe('handleMeterDisconnected', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({
        publisher: mockPublisher,
        tcpServer: mockTCPServer,
      });
      sm.start();
      sm.handleMeterConnected('000000001234', '192.168.1.100');
    });

    afterEach(() => {
      sm.stop();
    });

    it('should update meter status to offline', () => {
      sm.handleMeterDisconnected('000000001234');

      const status = sm.getMeterStatus('000000001234');
      expect(status.online).toBe(false);
      expect(status.disconnectedAt).toBeDefined();
    });

    it('should emit METER_OFFLINE event', () => {
      const meterOffline = vi.fn();
      sm.on(STATUS_EVENTS.METER_OFFLINE, meterOffline);

      sm.handleMeterDisconnected('000000001234');

      expect(meterOffline).toHaveBeenCalledWith({
        meterId: '000000001234',
      });
    });

    it('should create meter_disconnected event', () => {
      const eventCreated = vi.fn();
      sm.on(STATUS_EVENTS.EVENT_CREATED, eventCreated);

      sm.handleMeterDisconnected('000000001234');

      expect(eventCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EVENT_TYPES.METER_DISCONNECTED,
        })
      );
    });

    it('should create communication_lost alarm', () => {
      const alarmTriggered = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_TRIGGERED, alarmTriggered);

      sm.handleMeterDisconnected('000000001234');

      expect(alarmTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ALARM_TYPES.COMMUNICATION_LOST,
          severity: ALARM_SEVERITY.WARNING,
        })
      );
    });

    it('should publish meter status offline', () => {
      sm.handleMeterDisconnected('000000001234');

      expect(mockPublisher.publishMeterStatus).toHaveBeenCalledWith('000000001234', false);
    });

    it('should decrement metersOnline stat', () => {
      expect(sm.stats.metersOnline).toBe(1);

      sm.handleMeterDisconnected('000000001234');

      expect(sm.stats.metersOnline).toBe(0);
    });
  });

  describe('handleTelemetryReceived', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({
        publisher: mockPublisher,
        tcpServer: mockTCPServer,
      });
      sm.start();
      sm.handleMeterConnected('000000001234', '192.168.1.100');
    });

    afterEach(() => {
      sm.stop();
    });

    it('should update lastSeen timestamp', () => {
      const beforeLastSeen = sm.getMeterStatus('000000001234').lastSeen;

      vi.advanceTimersByTime(1000);

      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 220,
        unit: 'V',
        register: { key: 'VOLTAGE_A' },
      });

      const afterLastSeen = sm.getMeterStatus('000000001234').lastSeen;
      expect(afterLastSeen).toBeGreaterThan(beforeLastSeen);
    });

    it('should store lastTelemetry', () => {
      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 220,
        unit: 'V',
        register: { key: 'VOLTAGE_A' },
      });

      const status = sm.getMeterStatus('000000001234');
      expect(status.lastTelemetry).toBeDefined();
      expect(status.lastTelemetry.value).toBe(220);
    });
  });

  describe('checkAlarmConditions', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({
        publisher: mockPublisher,
        tcpServer: mockTCPServer,
      });
      sm.start();
      sm.handleMeterConnected('000000001234', '192.168.1.100');
    });

    afterEach(() => {
      sm.stop();
    });

    it('should trigger overvoltage alarm', () => {
      const alarmTriggered = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_TRIGGERED, alarmTriggered);

      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 260,
        unit: 'V',
        register: { key: 'VOLTAGE_A' },
      });

      expect(alarmTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ALARM_TYPES.OVERVOLTAGE,
          severity: ALARM_SEVERITY.WARNING,
        })
      );
    });

    it('should trigger undervoltage alarm', () => {
      const alarmTriggered = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_TRIGGERED, alarmTriggered);

      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 170,
        unit: 'V',
        register: { key: 'VOLTAGE_A' },
      });

      expect(alarmTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ALARM_TYPES.UNDERVOLTAGE,
          severity: ALARM_SEVERITY.WARNING,
        })
      );
    });

    it('should trigger overcurrent alarm with critical severity', () => {
      const alarmTriggered = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_TRIGGERED, alarmTriggered);

      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 150,
        unit: 'A',
        register: { key: 'CURRENT_A' },
      });

      expect(alarmTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ALARM_TYPES.OVERCURRENT,
          severity: ALARM_SEVERITY.CRITICAL,
        })
      );
    });

    it('should trigger overload alarm', () => {
      const alarmTriggered = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_TRIGGERED, alarmTriggered);

      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 15000,
        unit: 'W',
        register: { key: 'ACTIVE_POWER_TOTAL' },
      });

      expect(alarmTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ALARM_TYPES.OVERLOAD,
          severity: ALARM_SEVERITY.WARNING,
        })
      );
    });

    it('should trigger low_balance alarm', () => {
      const alarmTriggered = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_TRIGGERED, alarmTriggered);

      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 5,
        unit: 'kWh',
        register: { key: 'BALANCE_ENERGY' },
      });

      expect(alarmTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ALARM_TYPES.LOW_BALANCE,
          severity: ALARM_SEVERITY.INFO,
        })
      );
    });

    it('should clear alarm when value returns to normal', () => {
      // Trigger alarm
      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 260,
        unit: 'V',
        register: { key: 'VOLTAGE_A' },
      });
      expect(sm.activeAlarms.size).toBe(1);

      // Clear alarm with normal value
      const alarmCleared = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_CLEARED, alarmCleared);

      sm.handleTelemetryReceived({
        meterId: '000000001234',
        value: 220,
        unit: 'V',
        register: { key: 'VOLTAGE_A' },
      });

      expect(alarmCleared).toHaveBeenCalled();
      expect(sm.activeAlarms.size).toBe(0);
    });
  });

  describe('createAlarm/clearAlarm', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({
        publisher: mockPublisher,
      });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should create alarm', () => {
      const alarm = sm.createAlarm(
        '000000001234',
        ALARM_TYPES.OVERVOLTAGE,
        ALARM_SEVERITY.WARNING,
        { value: 260 }
      );

      expect(alarm).toBeDefined();
      expect(alarm.id).toMatch(/^alm_/);
      expect(alarm.meterId).toBe('000000001234');
      expect(alarm.type).toBe(ALARM_TYPES.OVERVOLTAGE);
      expect(alarm.severity).toBe(ALARM_SEVERITY.WARNING);
    });

    it('should not create duplicate alarm', () => {
      const alarm1 = sm.createAlarm(
        '000000001234',
        ALARM_TYPES.OVERVOLTAGE,
        ALARM_SEVERITY.WARNING
      );
      const alarm2 = sm.createAlarm(
        '000000001234',
        ALARM_TYPES.OVERVOLTAGE,
        ALARM_SEVERITY.WARNING
      );

      expect(alarm1).not.toBeNull();
      expect(alarm2).toBeNull();
    });

    it('should emit ALARM_TRIGGERED event', () => {
      const alarmTriggered = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_TRIGGERED, alarmTriggered);

      sm.createAlarm('000000001234', ALARM_TYPES.OVERVOLTAGE, ALARM_SEVERITY.WARNING);

      expect(alarmTriggered).toHaveBeenCalled();
    });

    it('should publish alarm event', () => {
      sm.createAlarm('000000001234', ALARM_TYPES.OVERVOLTAGE, ALARM_SEVERITY.WARNING, {
        value: 260,
      });

      expect(mockPublisher.publishMeterEvent).toHaveBeenCalledWith(
        '000000001234',
        'alarm:overvoltage',
        expect.objectContaining({
          severity: ALARM_SEVERITY.WARNING,
          value: 260,
        })
      );
    });

    it('should clear alarm', () => {
      sm.createAlarm('000000001234', ALARM_TYPES.OVERVOLTAGE, ALARM_SEVERITY.WARNING);
      expect(sm.activeAlarms.size).toBe(1);

      const result = sm.clearAlarm('000000001234', ALARM_TYPES.OVERVOLTAGE);

      expect(result).toBe(true);
      expect(sm.activeAlarms.size).toBe(0);
    });

    it('should return false when clearing non-existent alarm', () => {
      const result = sm.clearAlarm('000000001234', ALARM_TYPES.OVERVOLTAGE);
      expect(result).toBe(false);
    });

    it('should emit ALARM_CLEARED event', () => {
      sm.createAlarm('000000001234', ALARM_TYPES.OVERVOLTAGE, ALARM_SEVERITY.WARNING);

      const alarmCleared = vi.fn();
      sm.on(STATUS_EVENTS.ALARM_CLEARED, alarmCleared);

      sm.clearAlarm('000000001234', ALARM_TYPES.OVERVOLTAGE);

      expect(alarmCleared).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ALARM_TYPES.OVERVOLTAGE,
          clearedAt: expect.any(Number),
        })
      );
    });
  });

  describe('acknowledgeAlarm', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should acknowledge alarm by id', () => {
      const alarm = sm.createAlarm(
        '000000001234',
        ALARM_TYPES.OVERVOLTAGE,
        ALARM_SEVERITY.WARNING
      );

      const result = sm.acknowledgeAlarm(alarm.id);

      expect(result).toBe(true);
      expect(sm.activeAlarms.get('000000001234:overvoltage').acknowledged).toBe(true);
    });

    it('should return false for unknown alarm id', () => {
      const result = sm.acknowledgeAlarm('unknown_id');
      expect(result).toBe(false);
    });
  });

  describe('createEvent', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should create event', () => {
      const event = sm.createEvent(EVENT_TYPES.METER_CONNECTED, {
        meterId: '000000001234',
      });

      expect(event).toBeDefined();
      expect(event.id).toMatch(/^evt_/);
      expect(event.type).toBe(EVENT_TYPES.METER_CONNECTED);
      expect(event.timestamp).toBeDefined();
    });

    it('should add event to recentEvents', () => {
      sm.createEvent(EVENT_TYPES.METER_CONNECTED, { meterId: '000000001234' });

      expect(sm.recentEvents.length).toBeGreaterThan(0);
    });

    it('should limit recentEvents buffer', () => {
      // Create more events than the max
      for (let i = 0; i < 150; i++) {
        sm.createEvent(EVENT_TYPES.TELEMETRY_RECEIVED, { index: i });
      }

      expect(sm.recentEvents.length).toBe(sm.maxRecentEvents);
    });

    it('should emit EVENT_CREATED event', () => {
      const eventCreated = vi.fn();
      sm.on(STATUS_EVENTS.EVENT_CREATED, eventCreated);

      sm.createEvent(EVENT_TYPES.METER_CONNECTED, { meterId: '000000001234' });

      expect(eventCreated).toHaveBeenCalled();
    });

    it('should publish meter event if meterId present', () => {
      sm.createEvent(EVENT_TYPES.METER_CONNECTED, { meterId: '000000001234' });

      expect(mockPublisher.publishMeterEvent).toHaveBeenCalledWith(
        '000000001234',
        EVENT_TYPES.METER_CONNECTED,
        { meterId: '000000001234' }
      );
    });

    it('should increment totalEvents stat', () => {
      const before = sm.stats.totalEvents;

      sm.createEvent(EVENT_TYPES.METER_CONNECTED, { meterId: '000000001234' });

      expect(sm.stats.totalEvents).toBe(before + 1);
    });
  });

  describe('publishGatewayStats', () => {
    it('should publish gateway stats', async () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();

      await sm.publishGatewayStats();

      expect(mockPublisher.publishGatewayStats).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
          uptime: expect.any(Number),
          memory: expect.objectContaining({
            heapUsed: expect.any(Number),
          }),
        })
      );

      sm.stop();
    });

    it('should publish stats periodically', () => {
      const sm = new StatusManager({
        publisher: mockPublisher,
        statusInterval: 5000,
      });
      sm.start();

      // Initial call
      expect(mockPublisher.publishGatewayStats).toHaveBeenCalledTimes(1);

      // After interval
      vi.advanceTimersByTime(5000);
      expect(mockPublisher.publishGatewayStats).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(5000);
      expect(mockPublisher.publishGatewayStats).toHaveBeenCalledTimes(3);

      sm.stop();
    });
  });

  describe('getGatewayStats', () => {
    it('should return gateway stats', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();

      const stats = sm.getGatewayStats();

      expect(stats).toHaveProperty('status', 'running');
      expect(stats).toHaveProperty('uptime');
      expect(stats).toHaveProperty('version');
      expect(stats).toHaveProperty('memory');
      expect(stats).toHaveProperty('meters');
      expect(stats).toHaveProperty('alarms');
      expect(stats).toHaveProperty('events');

      sm.stop();
    });
  });

  describe('getUptime', () => {
    it('should return 0 when not started', () => {
      const sm = new StatusManager();
      expect(sm.getUptime()).toBe(0);
    });

    it('should return uptime in seconds', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();

      vi.advanceTimersByTime(5000);

      expect(sm.getUptime()).toBe(5);

      sm.stop();
    });
  });

  describe('getMeterStatus', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should return null for unknown meter', () => {
      expect(sm.getMeterStatus('unknown')).toBeNull();
    });

    it('should return status for known meter', () => {
      sm.handleMeterConnected('000000001234', '192.168.1.100');

      const status = sm.getMeterStatus('000000001234');

      expect(status).toBeDefined();
      expect(status.meterId).toBe('000000001234');
      expect(status.online).toBe(true);
    });

    it('should return all statuses if no meterId', () => {
      sm.handleMeterConnected('000000001234', '192.168.1.100');
      sm.handleMeterConnected('000000005678', '192.168.1.101');

      const statuses = sm.getMeterStatus();

      expect(statuses).toHaveLength(2);
    });
  });

  describe('getOnlineMeters', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should return empty array when no meters', () => {
      expect(sm.getOnlineMeters()).toEqual([]);
    });

    it('should return online meter ids', () => {
      sm.handleMeterConnected('000000001234', '192.168.1.100');
      sm.handleMeterConnected('000000005678', '192.168.1.101');

      expect(sm.getOnlineMeters()).toEqual(['000000001234', '000000005678']);
    });

    it('should not include offline meters', () => {
      sm.handleMeterConnected('000000001234', '192.168.1.100');
      sm.handleMeterConnected('000000005678', '192.168.1.101');
      sm.handleMeterDisconnected('000000005678');

      expect(sm.getOnlineMeters()).toEqual(['000000001234']);
    });
  });

  describe('getActiveAlarms', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should return empty array when no alarms', () => {
      expect(sm.getActiveAlarms()).toEqual([]);
    });

    it('should return all active alarms', () => {
      sm.createAlarm('meter1', ALARM_TYPES.OVERVOLTAGE, ALARM_SEVERITY.WARNING);
      sm.createAlarm('meter2', ALARM_TYPES.OVERCURRENT, ALARM_SEVERITY.CRITICAL);

      expect(sm.getActiveAlarms()).toHaveLength(2);
    });

    it('should filter by meterId', () => {
      sm.createAlarm('meter1', ALARM_TYPES.OVERVOLTAGE, ALARM_SEVERITY.WARNING);
      sm.createAlarm('meter2', ALARM_TYPES.OVERCURRENT, ALARM_SEVERITY.CRITICAL);

      const alarms = sm.getActiveAlarms('meter1');

      expect(alarms).toHaveLength(1);
      expect(alarms[0].meterId).toBe('meter1');
    });
  });

  describe('getRecentEvents', () => {
    let sm;

    beforeEach(() => {
      sm = new StatusManager({ publisher: mockPublisher });
      sm.start();
    });

    afterEach(() => {
      sm.stop();
    });

    it('should return recent events with default limit', () => {
      for (let i = 0; i < 30; i++) {
        sm.createEvent(EVENT_TYPES.TELEMETRY_RECEIVED, { index: i });
      }

      const events = sm.getRecentEvents();

      expect(events).toHaveLength(20);
    });

    it('should respect custom limit', () => {
      for (let i = 0; i < 30; i++) {
        sm.createEvent(EVENT_TYPES.TELEMETRY_RECEIVED, { index: i });
      }

      const events = sm.getRecentEvents(10);

      expect(events).toHaveLength(10);
    });

    it('should filter by meterId', () => {
      sm.createEvent(EVENT_TYPES.METER_CONNECTED, { meterId: 'meter1' });
      sm.createEvent(EVENT_TYPES.METER_CONNECTED, { meterId: 'meter2' });
      sm.createEvent(EVENT_TYPES.METER_DISCONNECTED, { meterId: 'meter1' });

      const events = sm.getRecentEvents(20, 'meter1');

      expect(events).toHaveLength(2);
    });
  });

  describe('getStats', () => {
    it('should return manager stats', () => {
      const sm = new StatusManager({ publisher: mockPublisher });
      sm.start();

      const stats = sm.getStats();

      expect(stats).toHaveProperty('totalEvents');
      expect(stats).toHaveProperty('totalAlarms');
      expect(stats).toHaveProperty('alarmsCleared');
      expect(stats).toHaveProperty('metersOnline');
      expect(stats).toHaveProperty('isRunning', true);
      expect(stats).toHaveProperty('uptime');
      expect(stats).toHaveProperty('activeAlarms');
      expect(stats).toHaveProperty('trackedMeters');

      sm.stop();
    });
  });

  describe('createStatusManager', () => {
    it('should create StatusManager instance', () => {
      const sm = createStatusManager({ publisher: mockPublisher });
      expect(sm).toBeInstanceOf(StatusManager);
    });
  });
});
