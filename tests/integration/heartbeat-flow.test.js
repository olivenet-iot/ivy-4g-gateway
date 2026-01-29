/**
 * Heartbeat Flow Integration Tests
 *
 * End-to-end tests for IVY EM114070 heartbeat packet handling:
 * TCP client sends heartbeat → gateway identifies meter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import { createTCPServer, SERVER_EVENTS } from '../../src/tcp/server.js';

/**
 * Get an available port
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
 * Wait for a condition with timeout
 */
const waitFor = (condition, timeout = 5000, interval = 50) => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout waiting for condition'));
      } else {
        setTimeout(check, interval);
      }
    };

    check();
  });
};

/**
 * Build a 26-byte heartbeat packet
 */
const buildHeartbeatPacket = (meterAddress = '311501114070') => {
  const header = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c]);
  const address = Buffer.from(meterAddress, 'ascii');
  const separator = Buffer.from([0x00]);
  const crc = Buffer.from([0x00, 0x00]);
  return Buffer.concat([header, address, separator, crc]);
};

describe('Heartbeat Flow Integration Tests', () => {
  let server;
  let testPort;
  let client;

  beforeEach(async () => {
    testPort = await getAvailablePort();
    server = createTCPServer({ port: testPort });
    await server.start();
  });

  afterEach(async () => {
    if (client && !client.destroyed) {
      client.destroy();
      client = null;
    }
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('should identify meter from heartbeat packet', async () => {
    const meterAddress = '311501114070';

    // Connect raw TCP client
    client = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: testPort }, () => {
        resolve(socket);
      });
      socket.on('error', reject);
    });

    // Send heartbeat packet
    const heartbeat = buildHeartbeatPacket(meterAddress);
    client.write(heartbeat);

    // Wait for meter to be identified
    await waitFor(() => server.isMeterConnected(meterAddress), 2000);

    expect(server.isMeterConnected(meterAddress)).toBe(true);
    expect(server.getConnectedMeters()).toContain(meterAddress);
  });

  it('should emit HEARTBEAT_RECEIVED event', async () => {
    const meterAddress = '311501114070';
    let heartbeatEvent = null;

    server.on(SERVER_EVENTS.HEARTBEAT_RECEIVED, (data) => {
      heartbeatEvent = data;
    });

    client = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: testPort }, () => {
        resolve(socket);
      });
      socket.on('error', reject);
    });

    const heartbeat = buildHeartbeatPacket(meterAddress);
    client.write(heartbeat);

    await waitFor(() => heartbeatEvent !== null, 2000);

    expect(heartbeatEvent).not.toBeNull();
    expect(heartbeatEvent.meterId).toBe(meterAddress);
    expect(heartbeatEvent.meterAddress).toBe(meterAddress);
    expect(heartbeatEvent.heartbeatCount).toBe(1);
  });

  it('should handle heartbeat followed by DLT645 data in same buffer', async () => {
    const meterAddress = '311501114070';

    client = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: testPort }, () => {
        resolve(socket);
      });
      socket.on('error', reject);
    });

    // Send heartbeat + some trailing bytes (not a valid DLT645 frame, will be discarded)
    const heartbeat = buildHeartbeatPacket(meterAddress);
    const trailing = Buffer.from([0x01, 0x02, 0x03]);
    const combined = Buffer.concat([heartbeat, trailing]);
    client.write(combined);

    // Meter should still be identified from the heartbeat
    await waitFor(() => server.isMeterConnected(meterAddress), 2000);

    expect(server.isMeterConnected(meterAddress)).toBe(true);
  });

  it('should not re-identify on subsequent heartbeats', async () => {
    const meterAddress = '311501114070';
    let identifyCount = 0;

    server.on(SERVER_EVENTS.METER_CONNECTED, () => {
      identifyCount++;
    });

    client = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: testPort }, () => {
        resolve(socket);
      });
      socket.on('error', reject);
    });

    const heartbeat = buildHeartbeatPacket(meterAddress);

    // Send first heartbeat
    client.write(heartbeat);
    await waitFor(() => server.isMeterConnected(meterAddress), 2000);

    // Send second heartbeat
    client.write(heartbeat);

    // Wait a bit for second heartbeat to be processed
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should only have identified once
    expect(identifyCount).toBe(1);
  });

  it('should handle zero address heartbeat with default accept action', async () => {
    const meterAddress = '000000000000';

    client = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: testPort }, () => {
        resolve(socket);
      });
      socket.on('error', reject);
    });

    const heartbeat = buildHeartbeatPacket(meterAddress);
    client.write(heartbeat);

    await waitFor(() => server.isMeterConnected(meterAddress), 2000);

    expect(server.isMeterConnected(meterAddress)).toBe(true);
  });
});
