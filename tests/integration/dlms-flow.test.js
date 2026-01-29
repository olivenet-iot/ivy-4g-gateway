/**
 * DLMS Flow Integration Tests
 *
 * Tests the end-to-end flow from IVY/DLMS packet reception
 * through protocol detection, DLMS parsing, and event emission.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnectionManager, CONNECTION_EVENTS } from '../../src/tcp/connection-manager.js';
import { PROTOCOL_TYPES } from '../../src/protocol/protocol-router.js';
import { DLMS_DATA_TYPES } from '../../src/protocol/dlms/data-types.js';
import { EventEmitter } from 'events';

/**
 * Build a 26-byte heartbeat packet
 */
const buildHeartbeatPacket = (meterAddress = '311501114070') => {
  const header = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c]);
  const address = Buffer.from(meterAddress, 'ascii');
  const sep = Buffer.from([0x00]);
  const crc = Buffer.from([0x00, 0x00]);
  return Buffer.concat([header, address, sep, crc]);
};

/**
 * Build an IVY-wrapped DLMS packet
 */
const buildIvyDlmsPacket = (destination, dlmsPayload) => {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0001, 0);
  header.writeUInt16BE(0x0001, 2);
  header.writeUInt16BE(destination, 4);
  header.writeUInt16BE(dlmsPayload.length, 6);
  return Buffer.concat([header, dlmsPayload]);
};

/**
 * Build a minimal valid DLT645 frame
 */
const buildDlt645Frame = (address = '000000001234') => {
  const addressBytes = [];
  for (let i = 0; i < 12; i += 2) {
    addressBytes.push(parseInt(address.substring(10 - i, 12 - i), 16));
  }

  const data = Buffer.from([0x66, 0x66, 0x33, 0x33]); // with 0x33 offset
  const frame = Buffer.from([
    0x68,
    ...addressBytes,
    0x68,
    0x91,
    data.length,
    ...data,
    0x00,
    0x16,
  ]);

  let cs = 0;
  for (let i = 0; i < frame.length - 2; i++) {
    cs = (cs + frame[i]) & 0xFF;
  }
  frame[frame.length - 2] = cs;
  return frame;
};

/**
 * Create a mock socket
 */
const createMockSocket = () => {
  const socket = new EventEmitter();
  socket.remoteAddress = '192.168.1.100';
  socket.remotePort = 12345;
  socket.destroyed = false;
  socket.write = vi.fn((data, cb) => {
    if (cb) cb(null);
  });
  socket.end = vi.fn((cb) => {
    if (cb) cb();
  });
  socket.destroy = vi.fn(() => {
    socket.destroyed = true;
  });
  socket.setTimeout = vi.fn();
  return socket;
};

describe('DLMS Flow Integration', () => {
  let connectionManager;

  beforeEach(() => {
    connectionManager = createConnectionManager({
      heartbeatInterval: 30000,
      connectionTimeout: 120000,
    });
    connectionManager.start();
  });

  afterEach(async () => {
    await connectionManager.stop();
  });

  it('should detect IVY_DLMS protocol from heartbeat and emit heartbeat event', async () => {
    const heartbeatReceived = vi.fn();
    const protocolDetected = vi.fn();
    connectionManager.on(CONNECTION_EVENTS.HEARTBEAT_RECEIVED, heartbeatReceived);
    connectionManager.on(CONNECTION_EVENTS.PROTOCOL_DETECTED, protocolDetected);

    const socket = createMockSocket();
    const connection = connectionManager.registerConnection(socket);
    expect(connection).not.toBeNull();

    // Simulate heartbeat packet
    socket.emit('data', buildHeartbeatPacket('311501114070'));

    expect(protocolDetected).toHaveBeenCalledWith(
      expect.objectContaining({ protocolType: PROTOCOL_TYPES.IVY_DLMS })
    );
    expect(heartbeatReceived).toHaveBeenCalledWith(
      expect.objectContaining({ meterAddress: '311501114070' })
    );
    expect(connection.protocolType).toBe(PROTOCOL_TYPES.IVY_DLMS);
    expect(connection.meterId).toBe('311501114070');
  });

  it('should detect DLT645 protocol and emit frame events', async () => {
    const frameReceived = vi.fn();
    const protocolDetected = vi.fn();
    connectionManager.on(CONNECTION_EVENTS.FRAME_RECEIVED, frameReceived);
    connectionManager.on(CONNECTION_EVENTS.PROTOCOL_DETECTED, protocolDetected);

    const socket = createMockSocket();
    connectionManager.registerConnection(socket);

    socket.emit('data', buildDlt645Frame());

    expect(protocolDetected).toHaveBeenCalledWith(
      expect.objectContaining({ protocolType: PROTOCOL_TYPES.DLT645 })
    );
    expect(frameReceived).toHaveBeenCalledOnce();
  });

  it('should parse DLMS EventNotification and emit DLMS_RECEIVED', async () => {
    const dlmsReceived = vi.fn();
    connectionManager.on(CONNECTION_EVENTS.DLMS_RECEIVED, dlmsReceived);

    const socket = createMockSocket();
    connectionManager.registerConnection(socket);

    // First send heartbeat to establish IVY protocol
    socket.emit('data', buildHeartbeatPacket('311501114070'));

    // Then send DLMS EventNotification
    const dlmsPayload = Buffer.from([
      0xC2, // EventNotification tag
      0x00, 0x03, // classId = 3 (Register)
      0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: 1-0:1.8.0.255
      0x02, // attributeIndex
      DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10, // value = 10000
    ]);
    socket.emit('data', buildIvyDlmsPacket(0x0010, dlmsPayload));

    expect(dlmsReceived).toHaveBeenCalledOnce();
    const event = dlmsReceived.mock.calls[0][0];
    expect(event.meterId).toBe('311501114070');
    expect(event.parsedApdu.type).toBe('event-notification');
    expect(event.parsedApdu.obisCode).toBe('1-0:1.8.0.255');
    expect(event.telemetry).not.toBeNull();
    expect(event.telemetry.source).toBe('dlms');
  });

  it('should handle heartbeat followed by multiple DLMS packets', async () => {
    const dlmsReceived = vi.fn();
    connectionManager.on(CONNECTION_EVENTS.DLMS_RECEIVED, dlmsReceived);

    const socket = createMockSocket();
    connectionManager.registerConnection(socket);

    socket.emit('data', buildHeartbeatPacket('311501114070'));

    // Send two DLMS packets
    const payload1 = Buffer.from([
      0xC2, 0x00, 0x03,
      0x01, 0x00, 0x20, 0x07, 0x00, 0xFF, // OBIS: 1-0:32.7.0.255 (Voltage A)
      0x02,
      DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // 230
    ]);
    const payload2 = Buffer.from([
      0xC2, 0x00, 0x03,
      0x01, 0x00, 0x1F, 0x07, 0x00, 0xFF, // OBIS: 1-0:31.7.0.255 (Current A)
      0x02,
      DLMS_DATA_TYPES.UINT16, 0x00, 0x0A, // 10
    ]);

    socket.emit('data', buildIvyDlmsPacket(0x0010, payload1));
    socket.emit('data', buildIvyDlmsPacket(0x0010, payload2));

    expect(dlmsReceived).toHaveBeenCalledTimes(2);
  });

  it('should maintain DLT645 backward compatibility', async () => {
    const frameReceived = vi.fn();
    const dlmsReceived = vi.fn();
    connectionManager.on(CONNECTION_EVENTS.FRAME_RECEIVED, frameReceived);
    connectionManager.on(CONNECTION_EVENTS.DLMS_RECEIVED, dlmsReceived);

    const socket = createMockSocket();
    const conn = connectionManager.registerConnection(socket);

    // Send DLT645 frame
    socket.emit('data', buildDlt645Frame());

    expect(frameReceived).toHaveBeenCalledOnce();
    expect(dlmsReceived).not.toHaveBeenCalled();
    expect(conn.protocolType).toBe(PROTOCOL_TYPES.DLT645);
  });

  it('should handle heartbeat then raw DLMS EventNotification end-to-end', async () => {
    const dlmsReceived = vi.fn();
    const heartbeatReceived = vi.fn();
    connectionManager.on(CONNECTION_EVENTS.DLMS_RECEIVED, dlmsReceived);
    connectionManager.on(CONNECTION_EVENTS.HEARTBEAT_RECEIVED, heartbeatReceived);

    const socket = createMockSocket();
    connectionManager.registerConnection(socket);

    // Send heartbeat to establish IVY protocol and meter identity
    socket.emit('data', buildHeartbeatPacket('311501114070'));
    expect(heartbeatReceived).toHaveBeenCalledOnce();

    // Send raw DLMS EventNotification (no IVY wrapper)
    const rawDlms = Buffer.from([
      0xC2,             // EventNotification tag
      0x00, 0x03,       // classId = 3 (Register)
      0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: 1-0:1.8.0.255
      0x02,             // attributeIndex
      DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10, // value = 10000
    ]);
    socket.emit('data', rawDlms);

    expect(dlmsReceived).toHaveBeenCalledOnce();
    const event = dlmsReceived.mock.calls[0][0];
    expect(event.meterId).toBe('311501114070');
    expect(event.parsedApdu.type).toBe('event-notification');
    expect(event.parsedApdu.obisCode).toBe('1-0:1.8.0.255');
    expect(event.telemetry).not.toBeNull();
    expect(event.telemetry.source).toBe('dlms');
  });

  it('should handle multiple concatenated raw DLMS APDUs in one TCP segment', async () => {
    const dlmsReceived = vi.fn();
    connectionManager.on(CONNECTION_EVENTS.DLMS_RECEIVED, dlmsReceived);

    const socket = createMockSocket();
    connectionManager.registerConnection(socket);

    // First: heartbeat
    socket.emit('data', buildHeartbeatPacket('311501114070'));

    // Two raw DLMS APDUs concatenated in one TCP segment
    const apdu1 = Buffer.from([
      0xC2, 0x00, 0x03,
      0x01, 0x00, 0x20, 0x07, 0x00, 0xFF, // OBIS: 1-0:32.7.0.255 (Voltage A)
      0x02,
      DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // 230
    ]);
    const apdu2 = Buffer.from([
      0xC2, 0x00, 0x03,
      0x01, 0x00, 0x1F, 0x07, 0x00, 0xFF, // OBIS: 1-0:31.7.0.255 (Current A)
      0x02,
      DLMS_DATA_TYPES.UINT16, 0x00, 0x0A, // 10
    ]);

    // Send both in one segment
    socket.emit('data', Buffer.concat([apdu1, apdu2]));

    expect(dlmsReceived).toHaveBeenCalledTimes(2);
    expect(dlmsReceived.mock.calls[0][0].parsedApdu.obisCode).toBe('1-0:32.7.0.255');
    expect(dlmsReceived.mock.calls[1][0].parsedApdu.obisCode).toBe('1-0:31.7.0.255');
  });
});
