/**
 * TCP Server Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'net';
import {
  TCPServer,
  SERVER_EVENTS,
  createTCPServer,
  getInstance,
  resetInstance,
} from '../../../src/tcp/server.js';
import { appendChecksum } from '../../../src/protocol/checksum.js';
import { addressToBuffer, dataIdToBuffer, applyOffset } from '../../../src/protocol/bcd.js';
import { CONTROL_CODES } from '../../../src/protocol/registers.js';

/**
 * Helper: Build a mock response frame
 * @param {string} address - 12-digit meter address
 * @param {number} controlCode - Response control code
 * @param {number} dataId - Data identifier
 * @param {Buffer} valueBuffer - Value data buffer
 * @returns {Buffer} Complete DLT645 frame
 */
const buildMockResponse = (address, controlCode, dataId, valueBuffer) => {
  const header = Buffer.alloc(10);
  header[0] = 0x68;
  addressToBuffer(address).copy(header, 1);
  header[7] = 0x68;
  header[8] = controlCode;

  const dataIdBuf = dataIdToBuffer(dataId);
  const valueWithOffset = applyOffset(valueBuffer);
  const data = Buffer.concat([dataIdBuf, valueWithOffset]);

  header[9] = data.length;

  const frameWithoutChecksum = Buffer.concat([header, data]);
  return appendChecksum(frameWithoutChecksum);
};

/**
 * Get an available port for testing
 * @returns {Promise<number>} Available port number
 */
const getAvailablePort = () => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
};

/**
 * Wait helper
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TCP Server', () => {
  let server;
  let testPort;

  beforeEach(async () => {
    testPort = await getAvailablePort();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    await resetInstance();
  });

  describe('SERVER_EVENTS', () => {
    it('should have all expected events', () => {
      expect(SERVER_EVENTS.SERVER_STARTED).toBe('server:started');
      expect(SERVER_EVENTS.SERVER_STOPPED).toBe('server:stopped');
      expect(SERVER_EVENTS.SERVER_ERROR).toBe('server:error');
      expect(SERVER_EVENTS.METER_CONNECTED).toBe('meter:connected');
      expect(SERVER_EVENTS.METER_DISCONNECTED).toBe('meter:disconnected');
      expect(SERVER_EVENTS.TELEMETRY_RECEIVED).toBe('telemetry:received');
      expect(SERVER_EVENTS.COMMAND_RESPONSE).toBe('command:response');
      expect(SERVER_EVENTS.ERROR_RESPONSE).toBe('error:response');
    });
  });

  describe('constructor', () => {
    it('should create server with default options', () => {
      server = createTCPServer({ port: testPort });
      expect(server).toBeInstanceOf(TCPServer);
      expect(server.isRunning).toBe(false);
    });

    it('should accept custom options', () => {
      server = createTCPServer({
        host: '127.0.0.1',
        port: testPort,
      });
      expect(server.options.host).toBe('127.0.0.1');
      expect(server.options.port).toBe(testPort);
    });
  });

  describe('start / stop', () => {
    it('should start server on specified port', async () => {
      server = createTCPServer({ port: testPort });

      const startedHandler = vi.fn();
      server.on(SERVER_EVENTS.SERVER_STARTED, startedHandler);

      await server.start();

      expect(server.isRunning).toBe(true);
      expect(startedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          port: testPort,
        })
      );
    });

    it('should stop server gracefully', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const stoppedHandler = vi.fn();
      server.on(SERVER_EVENTS.SERVER_STOPPED, stoppedHandler);

      await server.stop();

      expect(server.isRunning).toBe(false);
      expect(stoppedHandler).toHaveBeenCalled();
    });

    it('should not start twice', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();
      await server.start(); // Should warn but not error

      expect(server.isRunning).toBe(true);
    });

    it('should handle stop when not running', async () => {
      server = createTCPServer({ port: testPort });
      await server.stop(); // Should not error
    });
  });

  describe('handleConnection', () => {
    it('should accept incoming connections', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      // Connect a client
      const client = new net.Socket();

      await new Promise((resolve, reject) => {
        client.connect(testPort, '127.0.0.1', resolve);
        client.on('error', reject);
      });

      // Wait a bit for connection to be registered
      await wait(50);

      const stats = server.getStats();
      expect(stats.connections.totalConnections).toBe(1);

      client.destroy();
    });

    it('should handle multiple connections', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const clients = [];
      for (let i = 0; i < 3; i++) {
        const client = new net.Socket();
        await new Promise((resolve, reject) => {
          client.connect(testPort, '127.0.0.1', resolve);
          client.on('error', reject);
        });
        clients.push(client);
      }

      await wait(50);

      const stats = server.getStats();
      expect(stats.connections.totalConnections).toBe(3);

      clients.forEach((c) => c.destroy());
    });
  });

  describe('handleFrame', () => {
    it('should parse and emit telemetry from received frames', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const telemetryHandler = vi.fn();
      server.on(SERVER_EVENTS.TELEMETRY_RECEIVED, telemetryHandler);

      // Connect client and send a response frame
      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      // Wait for connection registration
      await wait(50);

      // Send a mock meter response (total energy read response)
      const frame = buildMockResponse(
        '000000001234',
        CONTROL_CODES.READ_DATA_RESPONSE,
        0x00000000, // Total energy
        Buffer.from([0x67, 0x45, 0x23, 0x01]) // 12345.67 kWh
      );

      client.write(frame);

      // Wait for frame processing
      await wait(100);

      expect(telemetryHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: '000000001234',
          dataId: 0x00000000,
        })
      );

      client.destroy();
    });

    it('should identify meter from first frame', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const meterConnectedHandler = vi.fn();
      server.on(SERVER_EVENTS.METER_CONNECTED, meterConnectedHandler);

      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      await wait(50);

      // Send frame with meter address
      const frame = buildMockResponse(
        '000000005678',
        CONTROL_CODES.READ_DATA_RESPONSE,
        0x00000000,
        Buffer.from([0x00])
      );

      client.write(frame);

      await wait(100);

      expect(meterConnectedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: '000000005678',
        })
      );

      expect(server.isMeterConnected('000000005678')).toBe(true);

      client.destroy();
    });

    it('should handle error response frames', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const errorHandler = vi.fn();
      server.on(SERVER_EVENTS.ERROR_RESPONSE, errorHandler);

      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      await wait(50);

      // Build an error response frame (error code 0x02 - no data)
      const header = Buffer.alloc(10);
      header[0] = 0x68;
      addressToBuffer('000000001234').copy(header, 1);
      header[7] = 0x68;
      header[8] = CONTROL_CODES.READ_DATA_ERROR; // 0xD1
      header[9] = 1; // data length = 1 (error code)

      const errorData = applyOffset(Buffer.from([0x02])); // Error code with offset
      const frameWithoutChecksum = Buffer.concat([header, errorData]);
      const frame = appendChecksum(frameWithoutChecksum);

      client.write(frame);

      await wait(100);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: '000000001234',
        })
      );

      client.destroy();
    });
  });

  describe('getConnectedMeters', () => {
    it('should return list of connected meter IDs', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      // Initially empty
      expect(server.getConnectedMeters()).toHaveLength(0);

      // Connect and identify a meter
      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      await wait(50);

      const frame = buildMockResponse(
        '000000001111',
        CONTROL_CODES.READ_DATA_RESPONSE,
        0x00000000,
        Buffer.from([0x00])
      );
      client.write(frame);

      await wait(100);

      const meters = server.getConnectedMeters();
      expect(meters).toContain('000000001111');

      client.destroy();
    });
  });

  describe('isMeterConnected', () => {
    it('should check meter connection status', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      expect(server.isMeterConnected('000000009999')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return server and connection stats', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const stats = server.getStats();

      expect(stats.server.isRunning).toBe(true);
      expect(stats.server.port).toBe(testPort);
      expect(stats.connections).toBeDefined();
      expect(stats.connections.totalConnections).toBe(0);
    });
  });

  describe('getMeterConnectionInfo', () => {
    it('should return null for unknown meter', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      expect(server.getMeterConnectionInfo('000000009999')).toBeNull();
    });

    it('should return connection info for connected meter', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      await wait(50);

      const frame = buildMockResponse(
        '000000002222',
        CONTROL_CODES.READ_DATA_RESPONSE,
        0x00000000,
        Buffer.from([0x00])
      );
      client.write(frame);

      await wait(100);

      const info = server.getMeterConnectionInfo('000000002222');
      expect(info).not.toBeNull();
      expect(info.meterId).toBe('000000002222');

      client.destroy();
    });
  });

  describe('getAllConnectionInfos', () => {
    it('should return all connection infos', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const infos = server.getAllConnectionInfos();
      expect(Array.isArray(infos)).toBe(true);
    });
  });

  describe('sendCommand', () => {
    it('should throw for disconnected meter', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      await expect(server.sendCommand('000000009999', Buffer.from([0x00]))).rejects.toThrow(
        'Meter not connected'
      );
    });

    it('should send command and timeout waiting for response', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      // Connect and identify a meter
      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      await wait(50);

      const identifyFrame = buildMockResponse(
        '000000003333',
        CONTROL_CODES.READ_DATA_RESPONSE,
        0x00000000,
        Buffer.from([0x00])
      );
      client.write(identifyFrame);

      await wait(100);

      // Send command with short timeout (no response will come)
      await expect(
        server.sendCommand('000000003333', Buffer.from([0x68, 0x16]), null, 100)
      ).rejects.toThrow('Command timeout');

      client.destroy();
    });
  });

  describe('sendCommandNoWait', () => {
    it('should return false for disconnected meter', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const result = await server.sendCommandNoWait('000000009999', Buffer.from([0x00]));
      expect(result).toBe(false);
    });

    it('should return true for connected meter', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      // Connect and identify a meter
      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      await wait(50);

      const identifyFrame = buildMockResponse(
        '000000004444',
        CONTROL_CODES.READ_DATA_RESPONSE,
        0x00000000,
        Buffer.from([0x00])
      );
      client.write(identifyFrame);

      await wait(100);

      const result = await server.sendCommandNoWait('000000004444', Buffer.from([0x68, 0x16]));
      expect(result).toBe(true);

      client.destroy();
    });
  });

  describe('singleton pattern', () => {
    afterEach(async () => {
      await resetInstance();
    });

    it('should return same instance', async () => {
      const instance1 = getInstance({ port: testPort });
      const instance2 = getInstance({ port: testPort + 1 }); // Options ignored

      expect(instance1).toBe(instance2);
    });

    it('should reset instance', async () => {
      const instance1 = getInstance({ port: testPort });
      await resetInstance();
      const instance2 = getInstance({ port: testPort });

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('error handling', () => {
    it('should emit error event on server error', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      // Try to start another server on same port
      const server2 = createTCPServer({ port: testPort });
      const errorHandler = vi.fn();
      server2.on(SERVER_EVENTS.SERVER_ERROR, errorHandler);

      await expect(server2.start()).rejects.toThrow();
    });
  });

  describe('meter disconnection', () => {
    it('should emit METER_DISCONNECTED when identified meter disconnects', async () => {
      server = createTCPServer({ port: testPort });
      await server.start();

      const disconnectHandler = vi.fn();
      server.on(SERVER_EVENTS.METER_DISCONNECTED, disconnectHandler);

      // Connect and identify a meter
      const client = new net.Socket();
      await new Promise((resolve) => {
        client.connect(testPort, '127.0.0.1', resolve);
      });

      await wait(50);

      const frame = buildMockResponse(
        '000000005555',
        CONTROL_CODES.READ_DATA_RESPONSE,
        0x00000000,
        Buffer.from([0x00])
      );
      client.write(frame);

      await wait(100);

      // Now disconnect
      client.destroy();

      await wait(100);

      expect(disconnectHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: '000000005555',
        })
      );
    });
  });
});
