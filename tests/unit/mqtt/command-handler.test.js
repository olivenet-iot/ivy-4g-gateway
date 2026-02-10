/**
 * Command Handler Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CommandHandler,
  COMMAND_EVENTS,
  COMMAND_METHODS,
  COMMAND_STATUS,
  createCommandHandler,
} from '../../../src/mqtt/command-handler.js';
import { ENERGY_REGISTERS } from '../../../src/protocol/registers.js';

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
  buildSimpleRelayFrame: vi.fn((meterId, command) => Buffer.from(`relay:${meterId}:${command}`)),
}));

/**
 * Create mock MQTT broker
 */
const createMockBroker = () => {
  const publishHandler = vi.fn();
  return {
    aedes: {
      on: vi.fn((event, handler) => {
        if (event === 'publish') {
          publishHandler.mockImplementation(handler);
        }
      }),
      removeListener: vi.fn(),
    },
    publish: vi.fn(() => Promise.resolve()),
    _simulatePublish: (packet, client) => {
      publishHandler(packet, client);
    },
  };
};

/**
 * Create mock TCP server
 */
const createMockTCPServer = () => ({
  isMeterConnected: vi.fn(() => true),
  sendCommand: vi.fn(() =>
    Promise.resolve({
      value: 123.45,
      unit: 'kWh',
    })
  ),
  getConnectedMeters: vi.fn(() => ['000000001234']),
});

/**
 * Create mock publisher
 */
const createMockPublisher = () => ({
  publishCommandResponse: vi.fn(() => Promise.resolve(true)),
});

describe('Command Handler', () => {
  let mockBroker;
  let mockTCPServer;
  let mockPublisher;

  beforeEach(() => {
    mockBroker = createMockBroker();
    mockTCPServer = createMockTCPServer();
    mockPublisher = createMockPublisher();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('COMMAND_EVENTS', () => {
    it('should define COMMAND_RECEIVED event', () => {
      expect(COMMAND_EVENTS.COMMAND_RECEIVED).toBe('command:received');
    });

    it('should define COMMAND_EXECUTED event', () => {
      expect(COMMAND_EVENTS.COMMAND_EXECUTED).toBe('command:executed');
    });

    it('should define COMMAND_FAILED event', () => {
      expect(COMMAND_EVENTS.COMMAND_FAILED).toBe('command:failed');
    });

    it('should define COMMAND_INVALID event', () => {
      expect(COMMAND_EVENTS.COMMAND_INVALID).toBe('command:invalid');
    });
  });

  describe('COMMAND_METHODS', () => {
    it('should define READ_REGISTER method', () => {
      expect(COMMAND_METHODS.READ_REGISTER).toBe('read_register');
    });

    it('should define RELAY_CONTROL method', () => {
      expect(COMMAND_METHODS.RELAY_CONTROL).toBe('relay_control');
    });

    it('should define READ_ADDRESS method', () => {
      expect(COMMAND_METHODS.READ_ADDRESS).toBe('read_address');
    });

    it('should define READ_ALL method', () => {
      expect(COMMAND_METHODS.READ_ALL).toBe('read_all');
    });
  });

  describe('COMMAND_STATUS', () => {
    it('should define PENDING status', () => {
      expect(COMMAND_STATUS.PENDING).toBe('pending');
    });

    it('should define EXECUTING status', () => {
      expect(COMMAND_STATUS.EXECUTING).toBe('executing');
    });

    it('should define SUCCESS status', () => {
      expect(COMMAND_STATUS.SUCCESS).toBe('success');
    });

    it('should define FAILED status', () => {
      expect(COMMAND_STATUS.FAILED).toBe('failed');
    });

    it('should define TIMEOUT status', () => {
      expect(COMMAND_STATUS.TIMEOUT).toBe('timeout');
    });

    it('should define INVALID status', () => {
      expect(COMMAND_STATUS.INVALID).toBe('invalid');
    });
  });

  describe('constructor', () => {
    it('should throw error if broker is not provided', () => {
      expect(() => new CommandHandler({ tcpServer: mockTCPServer })).toThrow(
        'MQTT broker instance required'
      );
    });

    it('should throw error if tcpServer is not provided', () => {
      expect(() => new CommandHandler({ broker: mockBroker })).toThrow(
        'TCP server instance required'
      );
    });

    it('should create instance with required options', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      expect(handler).toBeInstanceOf(CommandHandler);
    });

    it('should use default timeout', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      expect(handler.options.timeout).toBe(10000);
    });

    it('should accept custom timeout', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        timeout: 5000,
      });
      expect(handler.options.timeout).toBe(5000);
    });

    it('should accept optional publisher', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      expect(handler.publisher).toBe(mockPublisher);
    });

    it('should initialize stats', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      expect(handler.stats.commandsReceived).toBe(0);
      expect(handler.stats.commandsExecuted).toBe(0);
      expect(handler.stats.commandsFailed).toBe(0);
      expect(handler.stats.commandsInvalid).toBe(0);
    });
  });

  describe('start/stop', () => {
    it('should start handler', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      handler.start();
      expect(handler.isRunning).toBe(true);
    });

    it('should setup subscriptions on start', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      handler.start();
      expect(mockBroker.aedes.on).toHaveBeenCalledWith('publish', expect.any(Function));
    });

    it('should not start if already running', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      handler.start();
      handler.start();
      // Should only call on once
      expect(mockBroker.aedes.on).toHaveBeenCalledTimes(1);
    });

    it('should stop handler', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      handler.start();
      handler.stop();
      expect(handler.isRunning).toBe(false);
    });

    it('should remove listener on stop', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      handler.start();
      handler.stop();
      expect(mockBroker.aedes.removeListener).toHaveBeenCalledWith(
        'publish',
        expect.any(Function)
      );
    });

    it('should clear pending commands on stop', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      handler.start();
      handler.pendingCommands.set('cmd_1', { status: COMMAND_STATUS.EXECUTING });
      handler.stop();
      expect(handler.pendingCommands.size).toBe(0);
    });
  });

  describe('validateCommand', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
    });

    it('should reject command without id', () => {
      const result = handler.validateCommand({ method: 'read_register' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing command id');
    });

    it('should reject command without method', () => {
      const result = handler.validateCommand({ id: 'cmd_1' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing command method');
    });

    it('should reject unknown method', () => {
      const result = handler.validateCommand({ id: 'cmd_1', method: 'unknown' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unknown method: unknown');
    });

    it('should reject read_register without register or dataId', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'read_register',
        params: {},
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing register or dataId parameter');
    });

    it('should accept read_register with register param', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'read_register',
        params: { register: 'TOTAL_ACTIVE_POSITIVE' },
      });
      expect(result.valid).toBe(true);
    });

    it('should accept read_register with dataId param', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'read_register',
        params: { dataId: '0x00000000' },
      });
      expect(result.valid).toBe(true);
    });

    it('should reject relay_control without state', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'relay_control',
        params: {},
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid relay state (must be "open" or "close")');
    });

    it('should reject relay_control with invalid state', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'relay_control',
        params: { state: 'toggle' },
      });
      expect(result.valid).toBe(false);
    });

    it('should accept relay_control with open state', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'relay_control',
        params: { state: 'open' },
      });
      expect(result.valid).toBe(true);
    });

    it('should accept relay_control with close state', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'relay_control',
        params: { state: 'close' },
      });
      expect(result.valid).toBe(true);
    });

    it('should accept read_address without params', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'read_address',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept read_all without params', () => {
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'read_all',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('handleCommandMessage', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should extract meter ID from topic', async () => {
      const receivedEvent = vi.fn();
      handler.on(COMMAND_EVENTS.COMMAND_RECEIVED, receivedEvent);

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_address',
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(receivedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: '000000001234',
        })
      );
    });

    it('should ignore non-matching topics', async () => {
      const receivedEvent = vi.fn();
      handler.on(COMMAND_EVENTS.COMMAND_RECEIVED, receivedEvent);

      const packet = {
        topic: 'ivy/v1/meters/000000001234/telemetry',
        payload: Buffer.from('{}'),
      };

      await handler.handleCommandMessage(packet);

      expect(receivedEvent).not.toHaveBeenCalled();
    });

    it('should handle invalid JSON gracefully', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from('not json'),
      };

      // Should not throw
      await handler.handleCommandMessage(packet);
    });

    it('should emit COMMAND_INVALID for invalid commands', async () => {
      const invalidEvent = vi.fn();
      handler.on(COMMAND_EVENTS.COMMAND_INVALID, invalidEvent);

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'unknown_method',
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(invalidEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unknown method: unknown_method',
        })
      );
    });

    it('should increment commandsReceived stat', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_address',
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(handler.stats.commandsReceived).toBe(1);
    });
  });

  describe('executeReadRegister', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should resolve register by name', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { register: 'TOTAL_ACTIVE_POSITIVE' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockTCPServer.sendCommand).toHaveBeenCalledWith(
        '000000001234',
        expect.any(Buffer),
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id,
        10000
      );
    });

    it('should resolve register by dataId string', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { dataId: '0x00000000' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockTCPServer.sendCommand).toHaveBeenCalledWith(
        '000000001234',
        expect.any(Buffer),
        0x00000000,
        10000
      );
    });

    it('should publish success response', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { register: 'TOTAL_ACTIVE_POSITIVE' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockPublisher.publishCommandResponse).toHaveBeenCalledWith(
        '000000001234',
        'cmd_1',
        true,
        expect.objectContaining({
          value: 123.45,
          unit: 'kWh',
        })
      );
    });

    it('should emit COMMAND_EXECUTED on success', async () => {
      const executedEvent = vi.fn();
      handler.on(COMMAND_EVENTS.COMMAND_EXECUTED, executedEvent);

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { register: 'TOTAL_ACTIVE_POSITIVE' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(executedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: '000000001234',
          commandId: 'cmd_1',
          method: 'read_register',
        })
      );
    });

    it('should handle unknown register name', async () => {
      const failedEvent = vi.fn();
      handler.on(COMMAND_EVENTS.COMMAND_FAILED, failedEvent);

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { register: 'UNKNOWN_REGISTER' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(failedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unknown register: UNKNOWN_REGISTER',
        })
      );
    });
  });

  describe('executeRelayControl', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should map open state to trip command', async () => {
      const { buildSimpleRelayFrame } = await import(
        '../../../src/protocol/frame-builder.js'
      );

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'relay_control',
            params: { state: 'open' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(buildSimpleRelayFrame).toHaveBeenCalledWith('000000001234', 'trip');
    });

    it('should map close state to close command', async () => {
      const { buildSimpleRelayFrame } = await import(
        '../../../src/protocol/frame-builder.js'
      );

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'relay_control',
            params: { state: 'close' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(buildSimpleRelayFrame).toHaveBeenCalledWith('000000001234', 'close');
    });

    it('should publish success response with relay state', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'relay_control',
            params: { state: 'open' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockPublisher.publishCommandResponse).toHaveBeenCalledWith(
        '000000001234',
        'cmd_1',
        true,
        expect.objectContaining({
          relay_state: 'open',
        })
      );
    });
  });

  describe('executeReadAddress', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should return meter address', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_address',
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockPublisher.publishCommandResponse).toHaveBeenCalledWith(
        '000000001234',
        'cmd_1',
        true,
        expect.objectContaining({
          address: '000000001234',
        })
      );
    });
  });

  describe('executeReadAll', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should read multiple registers', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_all',
            params: { registers: ['TOTAL_ACTIVE_POSITIVE', 'VOLTAGE_A'] },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockTCPServer.sendCommand).toHaveBeenCalledTimes(2);
    });

    it('should use default registers if not specified', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_all',
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      // Default is 3 registers
      expect(mockTCPServer.sendCommand).toHaveBeenCalledTimes(3);
    });

    it('should include errors for failed reads', async () => {
      mockTCPServer.sendCommand
        .mockResolvedValueOnce({ value: 100, unit: 'kWh' })
        .mockRejectedValueOnce(new Error('Read failed'));

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_all',
            params: { registers: ['TOTAL_ACTIVE_POSITIVE', 'VOLTAGE_A'] },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockPublisher.publishCommandResponse).toHaveBeenCalledWith(
        '000000001234',
        'cmd_1',
        true,
        expect.objectContaining({
          readings: expect.objectContaining({
            TOTAL_ACTIVE_POSITIVE: expect.objectContaining({ value: 100 }),
            VOLTAGE_A: expect.objectContaining({ error: 'Read failed' }),
          }),
        })
      );
    });
  });

  describe('sendSuccessResponse/sendErrorResponse', () => {
    it('should use publisher when available', async () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });

      await handler.sendSuccessResponse('meter1', 'cmd_1', { value: 100 });

      expect(mockPublisher.publishCommandResponse).toHaveBeenCalledWith(
        'meter1',
        'cmd_1',
        true,
        { value: 100 }
      );
    });

    it('should use broker directly when no publisher', async () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });

      await handler.sendSuccessResponse('meter1', 'cmd_1', { value: 100 });

      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/meter1/command/response',
        expect.objectContaining({
          id: 'cmd_1',
          success: true,
          result: { value: 100 },
        })
      );
    });

    it('should send error response with publisher', async () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });

      await handler.sendErrorResponse('meter1', 'cmd_1', 'Test error');

      expect(mockPublisher.publishCommandResponse).toHaveBeenCalledWith(
        'meter1',
        'cmd_1',
        false,
        { error: 'Test error' }
      );
    });

    it('should send error response without publisher', async () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });

      await handler.sendErrorResponse('meter1', 'cmd_1', 'Test error');

      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/meter1/command/response',
        expect.objectContaining({
          id: 'cmd_1',
          success: false,
          error: 'Test error',
        })
      );
    });
  });

  describe('execute() programmatic API', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should execute read_register command', async () => {
      const result = await handler.execute('000000001234', 'read_register', {
        register: 'TOTAL_ACTIVE_POSITIVE',
      });

      expect(result).toMatchObject({
        value: 123.45,
        unit: 'kWh',
      });
    });

    it('should execute relay_control command', async () => {
      const result = await handler.execute('000000001234', 'relay_control', {
        state: 'open',
      });

      expect(result).toMatchObject({
        relay_state: 'open',
      });
    });

    it('should execute read_address command', async () => {
      const result = await handler.execute('000000001234', 'read_address');

      expect(result).toMatchObject({
        address: '000000001234',
      });
    });

    it('should throw on invalid command', async () => {
      await expect(handler.execute('000000001234', 'unknown_method')).rejects.toThrow(
        'Unknown method: unknown_method'
      );
    });

    it('should throw when meter not connected', async () => {
      mockTCPServer.isMeterConnected.mockReturnValue(false);

      await expect(
        handler.execute('000000001234', 'read_register', {
          register: 'TOTAL_ACTIVE_POSITIVE',
        })
      ).rejects.toThrow('Meter not connected');
    });
  });

  describe('meter not connected', () => {
    let handler;

    beforeEach(() => {
      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
      mockTCPServer.isMeterConnected.mockReturnValue(false);
    });

    afterEach(() => {
      handler.stop();
    });

    it('should send error response when meter not connected', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { register: 'TOTAL_ACTIVE_POSITIVE' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(mockPublisher.publishCommandResponse).toHaveBeenCalledWith(
        '000000001234',
        'cmd_1',
        false,
        { error: 'Meter not connected' }
      );
    });

    it('should emit COMMAND_FAILED event', async () => {
      const failedEvent = vi.fn();
      handler.on(COMMAND_EVENTS.COMMAND_FAILED, failedEvent);

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { register: 'TOTAL_ACTIVE_POSITIVE' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(failedEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Meter not connected',
        })
      );
    });

    it('should increment commandsFailed stat', async () => {
      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(
          JSON.stringify({
            id: 'cmd_1',
            method: 'read_register',
            params: { register: 'TOTAL_ACTIVE_POSITIVE' },
          })
        ),
      };

      await handler.handleCommandMessage(packet);

      expect(handler.stats.commandsFailed).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return statistics', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });

      const stats = handler.getStats();

      expect(stats).toHaveProperty('commandsReceived');
      expect(stats).toHaveProperty('commandsExecuted');
      expect(stats).toHaveProperty('commandsFailed');
      expect(stats).toHaveProperty('commandsInvalid');
      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('pendingCommands');
    });

    it('should reflect running state', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });

      expect(handler.getStats().isRunning).toBe(false);

      handler.start();
      expect(handler.getStats().isRunning).toBe(true);

      handler.stop();
      expect(handler.getStats().isRunning).toBe(false);
    });
  });

  describe('getPendingCommands', () => {
    it('should return empty array initially', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });

      expect(handler.getPendingCommands()).toEqual([]);
    });

    it('should return pending commands with elapsed time', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });

      handler.pendingCommands.set('cmd_1', {
        meterId: '000000001234',
        command: { method: 'read_register' },
        status: COMMAND_STATUS.EXECUTING,
        startTime: Date.now() - 1000,
      });

      const pending = handler.getPendingCommands();

      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: 'cmd_1',
        meterId: '000000001234',
        method: 'read_register',
        status: COMMAND_STATUS.EXECUTING,
      });
      expect(pending[0].elapsed).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('createCommandHandler', () => {
    it('should create CommandHandler instance', () => {
      const handler = createCommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      expect(handler).toBeInstanceOf(CommandHandler);
    });
  });

  describe('COMMAND_METHODS (new)', () => {
    it('should define READ_RELAY_STATE method', () => {
      expect(COMMAND_METHODS.READ_RELAY_STATE).toBe('read_relay_state');
    });
  });

  describe('constructor (pollingManager)', () => {
    it('should accept optional pollingManager', () => {
      const mockPollingManager = { acquireDlmsLock: vi.fn() };
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        pollingManager: mockPollingManager,
      });
      expect(handler.pollingManager).toBe(mockPollingManager);
    });

    it('should default pollingManager to null', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      expect(handler.pollingManager).toBeNull();
    });
  });

  describe('validateCommand (read_relay_state)', () => {
    it('should accept read_relay_state without params', () => {
      const handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
      const result = handler.validateCommand({
        id: 'cmd_1',
        method: 'read_relay_state',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('DLMS relay control (protocol branching)', () => {
    let handler;
    let mockConnectionManager;

    beforeEach(() => {
      mockConnectionManager = {
        getConnectionByMeter: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      mockTCPServer.connectionManager = mockConnectionManager;
      mockTCPServer.sendCommandNoWait = vi.fn(() => Promise.resolve(true));

      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should use DLT645 path when protocolType is not IVY_DLMS', async () => {
      // No protocolType set → DLT645 path
      mockConnectionManager.getConnectionByMeter.mockReturnValue({ protocolType: 'dlt645' });

      const packet = {
        topic: 'ivy/v1/meters/000000001234/command/request',
        payload: Buffer.from(JSON.stringify({
          id: 'cmd_1',
          method: 'relay_control',
          params: { state: 'open' },
        })),
      };

      await handler.handleCommandMessage(packet);

      // Should use buildSimpleRelayFrame (DLT645 path)
      const { buildSimpleRelayFrame } = await import('../../../src/protocol/frame-builder.js');
      expect(buildSimpleRelayFrame).toHaveBeenCalledWith('000000001234', 'trip');
    });

    it('should use DLMS path when protocolType is IVY_DLMS', async () => {
      mockConnectionManager.getConnectionByMeter.mockReturnValue({ protocolType: 'ivy_dlms' });

      // Simulate AARE response
      mockConnectionManager.on.mockImplementation((event, listener) => {
        if (event === 'dlms:received') {
          setTimeout(() => {
            listener({
              meterId: '000000001234',
              parsedApdu: { type: 'aare', accepted: true },
            });
          }, 10);
          setTimeout(() => {
            listener({
              meterId: '000000001234',
              parsedApdu: { type: 'action-response', success: true, actionResult: 0, actionResultName: 'success' },
            });
          }, 20);
          setTimeout(() => {
            listener({
              meterId: '000000001234',
              parsedApdu: { type: 'get-response', accessResult: 'success', data: { value: false } },
            });
          }, 1030);
        }
      });

      const result = await handler.execute('000000001234', 'relay_control', { state: 'open' });

      expect(result.protocol).toBe('dlms');
      expect(result.relay_state).toBe('open');
      expect(mockTCPServer.sendCommandNoWait).toHaveBeenCalled();
    });

    it('should fail DLMS relay control on association failure', async () => {
      mockConnectionManager.getConnectionByMeter.mockReturnValue({ protocolType: 'ivy_dlms' });

      // Simulate failed AARE
      mockConnectionManager.on.mockImplementation((event, listener) => {
        if (event === 'dlms:received') {
          setTimeout(() => {
            listener({
              meterId: '000000001234',
              parsedApdu: { type: 'aare', accepted: false },
            });
          }, 10);
        }
      });

      await expect(handler.execute('000000001234', 'relay_control', { state: 'open' }))
        .rejects.toThrow('DLMS association failed');
    });
  });

  describe('read_relay_state command', () => {
    let handler;
    let mockConnectionManager;

    beforeEach(() => {
      mockConnectionManager = {
        getConnectionByMeter: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      mockTCPServer.connectionManager = mockConnectionManager;
      mockTCPServer.sendCommandNoWait = vi.fn(() => Promise.resolve(true));

      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
        publisher: mockPublisher,
      });
      handler.start();
    });

    afterEach(() => {
      handler.stop();
    });

    it('should reject read_relay_state for non-DLMS meters', async () => {
      mockConnectionManager.getConnectionByMeter.mockReturnValue({ protocolType: 'dlt645' });

      await expect(handler.execute('000000001234', 'read_relay_state'))
        .rejects.toThrow('only supported for DLMS meters');
    });

    it('should reject read_relay_state when no connection exists', async () => {
      mockConnectionManager.getConnectionByMeter.mockReturnValue(null);

      await expect(handler.execute('000000001234', 'read_relay_state'))
        .rejects.toThrow('only supported for DLMS meters');
    });

    it('should execute read_relay_state for DLMS meters', async () => {
      mockConnectionManager.getConnectionByMeter.mockReturnValue({ protocolType: 'ivy_dlms' });

      // Track all listeners registered and emit events to each
      const listeners = [];
      mockConnectionManager.on.mockImplementation((event, listener) => {
        if (event === 'dlms:received') {
          listeners.push(listener);
          // Emit AARE on first listener registration
          if (listeners.length === 1) {
            setTimeout(() => {
              listeners.forEach(l => l({
                meterId: '000000001234',
                parsedApdu: { type: 'aare', accepted: true },
              }));
            }, 10);
          }
          // Emit first GET.response on second registration
          if (listeners.length === 2) {
            setTimeout(() => {
              listeners.forEach(l => l({
                meterId: '000000001234',
                parsedApdu: { type: 'get-response', accessResult: 'success', data: { value: true } },
              }));
            }, 10);
          }
          // Emit second GET.response on third registration
          if (listeners.length === 3) {
            setTimeout(() => {
              listeners.forEach(l => l({
                meterId: '000000001234',
                parsedApdu: { type: 'get-response', accessResult: 'success', data: { value: 1 } },
              }));
            }, 10);
          }
        }
      });

      const result = await handler.execute('000000001234', 'read_relay_state');

      expect(result.protocol).toBe('dlms');
      expect(result.output_state).toBe(true);
      expect(result.control_state).toBe(1);
    });
  });

  describe('waitForDlmsResponse', () => {
    let handler;
    let mockConnectionManager;

    beforeEach(() => {
      mockConnectionManager = {
        getConnectionByMeter: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      mockTCPServer.connectionManager = mockConnectionManager;

      handler = new CommandHandler({
        broker: mockBroker,
        tcpServer: mockTCPServer,
      });
    });

    it('should return null when connectionManager is not available', async () => {
      mockTCPServer.connectionManager = null;

      const result = await handler.waitForDlmsResponse('meter1', 'aare', 100);
      expect(result).toBeNull();
    });

    it('should return null on timeout', async () => {
      // Don't emit any events
      const result = await handler.waitForDlmsResponse('meter1', 'aare', 50);
      expect(result).toBeNull();
    });

    it('should resolve when matching response arrives', async () => {
      mockConnectionManager.on.mockImplementation((event, listener) => {
        setTimeout(() => {
          listener({
            meterId: 'meter1',
            parsedApdu: { type: 'aare', accepted: true },
          });
        }, 10);
      });

      const result = await handler.waitForDlmsResponse('meter1', 'aare', 1000);
      expect(result).toEqual({ type: 'aare', accepted: true });
    });

    it('should ignore responses for different meters', async () => {
      mockConnectionManager.on.mockImplementation((event, listener) => {
        setTimeout(() => {
          listener({
            meterId: 'meter2',
            parsedApdu: { type: 'aare', accepted: true },
          });
        }, 10);
      });

      const result = await handler.waitForDlmsResponse('meter1', 'aare', 50);
      expect(result).toBeNull();
    });

    it('should ignore responses of different type', async () => {
      mockConnectionManager.on.mockImplementation((event, listener) => {
        setTimeout(() => {
          listener({
            meterId: 'meter1',
            parsedApdu: { type: 'get-response', data: {} },
          });
        }, 10);
      });

      const result = await handler.waitForDlmsResponse('meter1', 'aare', 50);
      expect(result).toBeNull();
    });

    it('should clean up listener after resolving', async () => {
      mockConnectionManager.on.mockImplementation((event, listener) => {
        setTimeout(() => {
          listener({
            meterId: 'meter1',
            parsedApdu: { type: 'aare', accepted: true },
          });
        }, 10);
      });

      await handler.waitForDlmsResponse('meter1', 'aare', 1000);
      expect(mockConnectionManager.removeListener).toHaveBeenCalledWith('dlms:received', expect.any(Function));
    });

    it('should clean up listener on timeout', async () => {
      await handler.waitForDlmsResponse('meter1', 'aare', 50);
      expect(mockConnectionManager.removeListener).toHaveBeenCalledWith('dlms:received', expect.any(Function));
    });
  });
});
