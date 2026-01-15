/**
 * TCP Connection Manager Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  ConnectionManager,
  CONNECTION_STATE,
  CONNECTION_EVENTS,
  createConnectionManager,
  getInstance,
  resetInstance,
} from '../../../src/tcp/connection-manager.js';
import { buildReadFrame } from '../../../src/protocol/frame-builder.js';

/**
 * Create a mock socket
 */
const createMockSocket = (options = {}) => {
  const socket = new EventEmitter();
  socket.remoteAddress = options.remoteAddress || '192.168.1.100';
  socket.remotePort = options.remotePort || 12345;
  socket.destroyed = false;

  socket.write = vi.fn((data, callback) => {
    if (callback) callback();
    return true;
  });

  socket.end = vi.fn((callback) => {
    if (callback) callback();
  });

  socket.destroy = vi.fn(() => {
    socket.destroyed = true;
  });

  socket.setTimeout = vi.fn();

  return socket;
};

describe('TCP Connection Manager', () => {
  let manager;

  beforeEach(() => {
    manager = createConnectionManager({
      heartbeatInterval: 1000,
      connectionTimeout: 5000,
      maxConnections: 10,
    });
  });

  afterEach(async () => {
    await manager.stop();
    resetInstance();
  });

  describe('CONNECTION_STATE', () => {
    it('should have all expected states', () => {
      expect(CONNECTION_STATE.CONNECTED).toBe('connected');
      expect(CONNECTION_STATE.IDENTIFIED).toBe('identified');
      expect(CONNECTION_STATE.ACTIVE).toBe('active');
      expect(CONNECTION_STATE.IDLE).toBe('idle');
      expect(CONNECTION_STATE.DISCONNECTING).toBe('disconnecting');
      expect(CONNECTION_STATE.DISCONNECTED).toBe('disconnected');
    });
  });

  describe('CONNECTION_EVENTS', () => {
    it('should have all expected events', () => {
      expect(CONNECTION_EVENTS.CONNECTION_NEW).toBe('connection:new');
      expect(CONNECTION_EVENTS.CONNECTION_IDENTIFIED).toBe('connection:identified');
      expect(CONNECTION_EVENTS.CONNECTION_CLOSED).toBe('connection:closed');
      expect(CONNECTION_EVENTS.CONNECTION_TIMEOUT).toBe('connection:timeout');
      expect(CONNECTION_EVENTS.CONNECTION_ERROR).toBe('connection:error');
      expect(CONNECTION_EVENTS.DATA_RECEIVED).toBe('data:received');
      expect(CONNECTION_EVENTS.FRAME_RECEIVED).toBe('frame:received');
    });
  });

  describe('constructor', () => {
    it('should create manager with default options', () => {
      const defaultManager = createConnectionManager();
      expect(defaultManager).toBeInstanceOf(ConnectionManager);
      expect(defaultManager.connections.size).toBe(0);
    });

    it('should accept custom options', () => {
      expect(manager.options.heartbeatInterval).toBe(1000);
      expect(manager.options.connectionTimeout).toBe(5000);
      expect(manager.options.maxConnections).toBe(10);
    });
  });

  describe('start / stop', () => {
    it('should start and stop without errors', async () => {
      manager.start();
      expect(manager.isRunning).toBe(true);

      await manager.stop();
      expect(manager.isRunning).toBe(false);
    });

    it('should not start twice', () => {
      manager.start();
      manager.start(); // Should log warning but not error
      expect(manager.isRunning).toBe(true);
    });

    it('should close all connections on stop', async () => {
      manager.start();

      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      manager.registerConnection(socket1);
      manager.registerConnection(socket2);

      expect(manager.connections.size).toBe(2);

      await manager.stop();

      // Connections should be closed
      expect(socket1.end).toHaveBeenCalled();
      expect(socket2.end).toHaveBeenCalled();
    });
  });

  describe('registerConnection', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should register new connection', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      expect(connection).not.toBeNull();
      expect(connection.id).toMatch(/^conn_/);
      expect(connection.state).toBe(CONNECTION_STATE.CONNECTED);
      expect(connection.remoteAddress).toBe('192.168.1.100');
      expect(connection.meterId).toBeNull();
      expect(manager.connections.size).toBe(1);
    });

    it('should emit CONNECTION_NEW event', () => {
      const socket = createMockSocket();
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.CONNECTION_NEW, eventHandler);
      manager.registerConnection(socket);

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: expect.any(String),
          remoteAddress: '192.168.1.100',
        })
      );
    });

    it('should reject connection when max reached', () => {
      // Register max connections
      for (let i = 0; i < 10; i++) {
        manager.registerConnection(createMockSocket());
      }

      expect(manager.connections.size).toBe(10);

      // Try to register one more
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      expect(connection).toBeNull();
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('should setup socket event handlers', () => {
      const socket = createMockSocket();
      manager.registerConnection(socket);

      expect(socket.setTimeout).toHaveBeenCalledWith(5000);
      expect(socket.listenerCount('data')).toBe(1);
      expect(socket.listenerCount('close')).toBe(1);
      expect(socket.listenerCount('error')).toBe(1);
    });
  });

  describe('handleData', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should update connection stats on data', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      const data = Buffer.from([0x68, 0x00, 0x01, 0x02, 0x03]);
      socket.emit('data', data);

      expect(connection.bytesReceived).toBe(5);
      expect(connection.lastActivity).toBeGreaterThanOrEqual(connection.connectedAt);
    });

    it('should emit DATA_RECEIVED event', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.DATA_RECEIVED, eventHandler);

      socket.emit('data', Buffer.from([0x01, 0x02]));

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          dataLength: 2,
        })
      );
    });

    it('should update state to ACTIVE when receiving data', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      expect(connection.state).toBe(CONNECTION_STATE.CONNECTED);

      socket.emit('data', Buffer.from([0x01]));

      expect(connection.state).toBe(CONNECTION_STATE.ACTIVE);
    });

    it('should parse complete frames and emit FRAME_RECEIVED', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.FRAME_RECEIVED, eventHandler);

      // Use buildReadFrame to create a valid DLT645 frame (read request)
      // This creates a properly structured frame with valid checksum
      const frame = buildReadFrame('000000001234', 0x02010100);

      socket.emit('data', frame);

      expect(connection.framesReceived).toBe(1);
      expect(eventHandler).toHaveBeenCalled();
    });
  });

  describe('identifyConnection', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should associate meter ID with connection', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      const success = manager.identifyConnection(connection.id, '000000001234');

      expect(success).toBe(true);
      expect(connection.meterId).toBe('000000001234');
      expect(connection.state).toBe(CONNECTION_STATE.IDENTIFIED);
      expect(manager.meterToConnection.get('000000001234')).toBe(connection.id);
    });

    it('should emit CONNECTION_IDENTIFIED event', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.CONNECTION_IDENTIFIED, eventHandler);

      manager.identifyConnection(connection.id, '000000001234');

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          meterId: '000000001234',
        })
      );
    });

    it('should close old connection for duplicate meter', () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      const conn1 = manager.registerConnection(socket1);
      const conn2 = manager.registerConnection(socket2);

      manager.identifyConnection(conn1.id, '000000001234');
      manager.identifyConnection(conn2.id, '000000001234');

      // Old connection should be closed
      expect(socket1.end).toHaveBeenCalled();
      expect(manager.meterToConnection.get('000000001234')).toBe(conn2.id);
    });

    it('should return false for unknown connection', () => {
      const success = manager.identifyConnection('unknown_id', '000000001234');
      expect(success).toBe(false);
    });
  });

  describe('send / sendToMeter', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should send data to connection', async () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      const data = Buffer.from([0x68, 0x16]);
      const result = await manager.send(connection.id, data);

      expect(result).toBe(true);
      expect(socket.write).toHaveBeenCalledWith(data, expect.any(Function));
      expect(connection.bytesSent).toBe(2);
      expect(connection.framesSent).toBe(1);
    });

    it('should send data to meter by ID', async () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      manager.identifyConnection(connection.id, '000000001234');

      const data = Buffer.from([0x68, 0x16]);
      const result = await manager.sendToMeter('000000001234', data);

      expect(result).toBe(true);
      expect(socket.write).toHaveBeenCalled();
    });

    it('should return false for unknown connection', async () => {
      const result = await manager.send('unknown_id', Buffer.from([0x00]));
      expect(result).toBe(false);
    });

    it('should return false for unknown meter', async () => {
      const result = await manager.sendToMeter('999999999999', Buffer.from([0x00]));
      expect(result).toBe(false);
    });
  });

  describe('closeConnection', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should close connection gracefully', async () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      await manager.closeConnection(connection.id, 'test');

      expect(socket.end).toHaveBeenCalled();
      expect(connection.state).toBe(CONNECTION_STATE.DISCONNECTING);
    });

    it('should remove meter mapping on close', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      manager.identifyConnection(connection.id, '000000001234');

      socket.emit('close', false);

      expect(manager.meterToConnection.has('000000001234')).toBe(false);
    });

    it('should emit CONNECTION_CLOSED event', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.CONNECTION_CLOSED, eventHandler);

      socket.emit('close', false);

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          hadError: false,
        })
      );
    });
  });

  describe('handleError', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should emit CONNECTION_ERROR event', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.CONNECTION_ERROR, eventHandler);

      const error = new Error('Test error');
      socket.emit('error', error);

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          error,
        })
      );
    });
  });

  describe('handleTimeout', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should emit CONNECTION_TIMEOUT event', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.CONNECTION_TIMEOUT, eventHandler);

      socket.emit('timeout');

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
        })
      );
    });

    it('should close connection on timeout', () => {
      const socket = createMockSocket();
      manager.registerConnection(socket);

      socket.emit('timeout');

      expect(socket.end).toHaveBeenCalled();
    });
  });

  describe('getConnection / getConnectionByMeter', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should get connection by ID', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      const retrieved = manager.getConnection(connection.id);

      expect(retrieved).toBe(connection);
    });

    it('should get connection by meter ID', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      manager.identifyConnection(connection.id, '000000001234');

      const retrieved = manager.getConnectionByMeter('000000001234');

      expect(retrieved).toBe(connection);
    });

    it('should return null for unknown IDs', () => {
      expect(manager.getConnection('unknown')).toBeNull();
      expect(manager.getConnectionByMeter('999999999999')).toBeNull();
    });
  });

  describe('getConnectionInfo', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should return safe connection info', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      const info = manager.getConnectionInfo(connection.id);

      expect(info.id).toBe(connection.id);
      expect(info.remoteAddress).toBe('192.168.1.100');
      expect(info.state).toBe(CONNECTION_STATE.CONNECTED);
      expect(info.socket).toBeUndefined(); // Should not expose socket
    });

    it('should return null for unknown connection', () => {
      expect(manager.getConnectionInfo('unknown')).toBeNull();
    });
  });

  describe('getAllConnectionInfos', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should return all connection infos', () => {
      manager.registerConnection(createMockSocket());
      manager.registerConnection(createMockSocket());
      manager.registerConnection(createMockSocket());

      const infos = manager.getAllConnectionInfos();

      expect(infos).toHaveLength(3);
    });
  });

  describe('getConnectedMeterIds', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should return list of connected meter IDs', () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      const conn1 = manager.registerConnection(socket1);
      const conn2 = manager.registerConnection(socket2);

      manager.identifyConnection(conn1.id, '000000001234');
      manager.identifyConnection(conn2.id, '000000005678');

      const meterIds = manager.getConnectedMeterIds();

      expect(meterIds).toContain('000000001234');
      expect(meterIds).toContain('000000005678');
      expect(meterIds).toHaveLength(2);
    });
  });

  describe('isMeterConnected', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should check if meter is connected', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      manager.identifyConnection(connection.id, '000000001234');

      expect(manager.isMeterConnected('000000001234')).toBe(true);
      expect(manager.isMeterConnected('999999999999')).toBe(false);
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should return connection statistics', () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      const conn1 = manager.registerConnection(socket1);
      manager.registerConnection(socket2);
      manager.identifyConnection(conn1.id, '000000001234');

      const stats = manager.getStats();

      expect(stats.totalConnections).toBe(2);
      expect(stats.identifiedConnections).toBe(1);
      expect(stats.maxConnections).toBe(10);
    });
  });

  describe('heartbeat monitoring', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should timeout idle connections', async () => {
      manager.start();

      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      const eventHandler = vi.fn();

      manager.on(CONNECTION_EVENTS.CONNECTION_TIMEOUT, eventHandler);

      // Advance time past timeout
      vi.advanceTimersByTime(6000);

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
        })
      );
    });

    it('should update state to idle for inactive connections', () => {
      manager.start();

      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);
      connection.state = CONNECTION_STATE.ACTIVE;

      // Set lastActivity to be older than idle threshold (heartbeatInterval * 2 = 2000ms)
      connection.lastActivity = Date.now() - 2500;

      // Advance time to trigger heartbeat check (1000ms interval)
      vi.advanceTimersByTime(1000);

      expect(connection.state).toBe(CONNECTION_STATE.IDLE);
    });
  });

  describe('singleton pattern', () => {
    afterEach(() => {
      resetInstance();
    });

    it('should return same instance', () => {
      const instance1 = getInstance();
      const instance2 = getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should reset instance', () => {
      const instance1 = getInstance();
      resetInstance();
      const instance2 = getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('pending commands cleanup', () => {
    beforeEach(() => {
      manager.start();
    });

    it('should cancel pending commands on close', () => {
      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      // Add a pending command
      const rejectFn = vi.fn();
      const timeoutId = setTimeout(() => {}, 10000);
      connection.pendingCommands.set('cmd1', {
        resolve: vi.fn(),
        reject: rejectFn,
        timeout: timeoutId,
      });

      socket.emit('close', false);

      expect(rejectFn).toHaveBeenCalledWith(expect.any(Error));
      expect(connection.pendingCommands.size).toBe(0);
    });
  });

  describe('generateConnectionId', () => {
    it('should generate unique IDs', async () => {
      // Create a manager with higher maxConnections for this test
      const testManager = createConnectionManager({
        heartbeatInterval: 1000,
        connectionTimeout: 5000,
        maxConnections: 150,
      });
      testManager.start();

      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        const socket = createMockSocket();
        const connection = testManager.registerConnection(socket);
        ids.add(connection.id);
      }

      expect(ids.size).toBe(100);

      await testManager.stop();
    });

    it('should generate IDs with correct format', () => {
      manager.start();

      const socket = createMockSocket();
      const connection = manager.registerConnection(socket);

      expect(connection.id).toMatch(/^conn_[a-z0-9]+_[a-z0-9]+$/);
    });
  });
});
