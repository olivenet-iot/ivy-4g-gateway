/**
 * Protocol Router Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PROTOCOL_TYPES,
  detectProtocol,
  createProtocolRouter,
} from '../../../src/protocol/protocol-router.js';
import { DLMS_DATA_TYPES } from '../../../src/protocol/dlms/data-types.js';

/**
 * Build a valid IVY packet for testing
 */
const buildIvyPacket = (destination, payload) => {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0001, 0); // version
  header.writeUInt16BE(0x0001, 2); // source
  header.writeUInt16BE(destination, 4);
  header.writeUInt16BE(payload.length, 6);
  return Buffer.concat([header, payload]);
};

/**
 * Build a valid 26-byte heartbeat packet
 */
const buildHeartbeatPacket = (meterAddress = '311501114070') => {
  const header = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c]);
  const address = Buffer.from(meterAddress, 'ascii');
  const sep = Buffer.from([0x00]);
  const crc = Buffer.from([0x00, 0x00]);
  return Buffer.concat([header, address, sep, crc]);
};

/**
 * Build a minimal valid DLT645 frame
 */
const buildDlt645Frame = () => {
  // Minimal frame: 68 AA AA AA AA AA AA 68 91 04 [4 data bytes] CS 16
  const frame = Buffer.from([
    0x68,
    0x34, 0x12, 0x00, 0x00, 0x00, 0x00, // address
    0x68,
    0x91, // control code (read response)
    0x04, // data length
    0x66, 0x66, 0x33, 0x33, // data (with 0x33 offset)
    0x00, // checksum placeholder
    0x16,
  ]);
  // Calculate checksum
  let cs = 0;
  for (let i = 0; i < frame.length - 2; i++) {
    cs = (cs + frame[i]) & 0xFF;
  }
  frame[frame.length - 2] = cs;
  return frame;
};

describe('Protocol Router', () => {
  describe('detectProtocol', () => {
    it('should detect DLT645 from 0x68 start byte', () => {
      expect(detectProtocol(Buffer.from([0x68, 0x00]))).toBe(PROTOCOL_TYPES.DLT645);
    });

    it('should detect IVY_DLMS from 00 01 00 01 prefix', () => {
      expect(detectProtocol(Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x10]))).toBe(PROTOCOL_TYPES.IVY_DLMS);
    });

    it('should return UNKNOWN for other data', () => {
      expect(detectProtocol(Buffer.from([0xFF, 0xFE]))).toBe(PROTOCOL_TYPES.UNKNOWN);
    });

    it('should return UNKNOWN for empty buffer', () => {
      expect(detectProtocol(Buffer.alloc(0))).toBe(PROTOCOL_TYPES.UNKNOWN);
    });

    it('should return UNKNOWN for null', () => {
      expect(detectProtocol(null)).toBe(PROTOCOL_TYPES.UNKNOWN);
    });

    it('should return UNKNOWN for too-short buffer for IVY detection', () => {
      expect(detectProtocol(Buffer.from([0x00, 0x01]))).toBe(PROTOCOL_TYPES.UNKNOWN);
    });
  });

  describe('createProtocolRouter', () => {
    it('should detect and route DLT645 frames', () => {
      const onDlt645Frame = vi.fn();
      const onProtocolDetected = vi.fn();

      const router = createProtocolRouter({
        onDlt645Frame,
        onProtocolDetected,
      });

      router.push(buildDlt645Frame());

      expect(onProtocolDetected).toHaveBeenCalledWith(PROTOCOL_TYPES.DLT645);
      expect(onDlt645Frame).toHaveBeenCalledOnce();
      expect(router.getProtocol()).toBe(PROTOCOL_TYPES.DLT645);
    });

    it('should detect and route IVY heartbeat packets', () => {
      const onHeartbeat = vi.fn();
      const onProtocolDetected = vi.fn();

      const router = createProtocolRouter({
        onHeartbeat,
        onProtocolDetected,
      });

      router.push(buildHeartbeatPacket());

      expect(onProtocolDetected).toHaveBeenCalledWith(PROTOCOL_TYPES.IVY_DLMS);
      expect(onHeartbeat).toHaveBeenCalledOnce();
      expect(onHeartbeat.mock.calls[0][0].meterAddress).toBe('311501114070');
    });

    it('should detect and route IVY DLMS APDU packets', () => {
      const onDlmsApdu = vi.fn();
      const onProtocolDetected = vi.fn();

      const router = createProtocolRouter({
        onDlmsApdu,
        onProtocolDetected,
        onHeartbeat: vi.fn(),
      });

      // DLMS EventNotification wrapped in IVY header
      const dlmsPayload = Buffer.from([
        0xC2, // EventNotification tag
        0x00, 0x03, // classId
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS
        0x02,
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x10, 0x00,
      ]);
      const packet = buildIvyPacket(0x0010, dlmsPayload);

      router.push(packet);

      expect(onProtocolDetected).toHaveBeenCalledWith(PROTOCOL_TYPES.IVY_DLMS);
      expect(onDlmsApdu).toHaveBeenCalledOnce();
      const [parsed] = onDlmsApdu.mock.calls[0];
      expect(parsed.type).toBe('event-notification');
    });

    it('should handle mixed heartbeat and DLMS in sequence', () => {
      const onHeartbeat = vi.fn();
      const onDlmsApdu = vi.fn();

      const router = createProtocolRouter({
        onHeartbeat,
        onDlmsApdu,
      });

      // First: heartbeat
      router.push(buildHeartbeatPacket());

      // Second: DLMS packet
      const dlmsPayload = Buffer.from([
        0xC2, 0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.NULL_DATA,
      ]);
      const dlmsPacket = buildIvyPacket(0x0010, dlmsPayload);
      router.push(dlmsPacket);

      expect(onHeartbeat).toHaveBeenCalledOnce();
      expect(onDlmsApdu).toHaveBeenCalledOnce();
    });

    it('should report protocol detection only once', () => {
      const onProtocolDetected = vi.fn();

      const router = createProtocolRouter({
        onDlt645Frame: vi.fn(),
        onProtocolDetected,
      });

      router.push(buildDlt645Frame());
      router.push(buildDlt645Frame());

      expect(onProtocolDetected).toHaveBeenCalledOnce();
    });

    it('should reset state', () => {
      const router = createProtocolRouter({
        onDlt645Frame: vi.fn(),
      });

      router.push(buildDlt645Frame());
      expect(router.getProtocol()).toBe(PROTOCOL_TYPES.DLT645);

      router.reset();
      expect(router.getProtocol()).toBeNull();
    });

    it('should call onDlt645Error for invalid DLT645 frames', () => {
      const onDlt645Error = vi.fn();
      const onDlt645Frame = vi.fn();

      const router = createProtocolRouter({
        onDlt645Frame,
        onDlt645Error,
      });

      // Valid start for DLT645 but corrupted frame
      const corrupted = Buffer.from([
        0x68, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x68, 0x91, 0x04, 0x00, 0x00, 0x00, 0x00,
        0xFF, // wrong checksum
        0x16,
      ]);

      router.push(corrupted);
      expect(onDlt645Error).toHaveBeenCalled();
    });

    it('should discard data for unknown protocol', () => {
      const onDlt645Frame = vi.fn();
      const onDlmsApdu = vi.fn();

      const router = createProtocolRouter({
        onDlt645Frame,
        onDlmsApdu,
      });

      router.push(Buffer.from([0xFF, 0xFE, 0xFD]));

      expect(onDlt645Frame).not.toHaveBeenCalled();
      expect(onDlmsApdu).not.toHaveBeenCalled();
      expect(router.getProtocol()).toBe(PROTOCOL_TYPES.UNKNOWN);
    });

    it('should route DLMS AARE at dest=0x0001 to onDlmsApdu (not heartbeat)', () => {
      const onDlmsApdu = vi.fn();
      const onHeartbeat = vi.fn();

      const router = createProtocolRouter({
        onDlmsApdu,
        onHeartbeat,
      });

      // AARE (Association Response) wrapped in IVY header with dest=0x0001
      const aarePayload = Buffer.from([
        0x61, 0x05, // AARE tag + short-form length
        0xA1, 0x03, 0x02, 0x01, 0x00, // body (5 bytes)
      ]);
      const packet = buildIvyPacket(0x0001, aarePayload);

      router.push(packet);

      expect(onDlmsApdu).toHaveBeenCalledOnce();
      expect(onHeartbeat).not.toHaveBeenCalled();
      const [parsed] = onDlmsApdu.mock.calls[0];
      expect(parsed.tag).toBe(0x61);
    });

    it('should still route heartbeat at dest=0x0001 to onHeartbeat', () => {
      const onDlmsApdu = vi.fn();
      const onHeartbeat = vi.fn();

      const router = createProtocolRouter({
        onDlmsApdu,
        onHeartbeat,
      });

      router.push(buildHeartbeatPacket());

      expect(onHeartbeat).toHaveBeenCalledOnce();
      expect(onDlmsApdu).not.toHaveBeenCalled();
    });

    it('should handle mixed heartbeat and DLMS both at dest=0x0001 in sequence', () => {
      const onHeartbeat = vi.fn();
      const onDlmsApdu = vi.fn();

      const router = createProtocolRouter({
        onHeartbeat,
        onDlmsApdu,
      });

      // First: heartbeat at dest=0x0001
      router.push(buildHeartbeatPacket());

      // Second: DLMS ExceptionResponse at dest=0x0001
      const exceptionPayload = Buffer.from([0xD8, 0x01, 0x02]);
      const dlmsPacket = buildIvyPacket(0x0001, exceptionPayload);
      router.push(dlmsPacket);

      expect(onHeartbeat).toHaveBeenCalledOnce();
      expect(onDlmsApdu).toHaveBeenCalledOnce();
      const [parsed] = onDlmsApdu.mock.calls[0];
      expect(parsed.tag).toBe(0xD8);
    });

    it('should handle chunked IVY data', () => {
      const onDlmsApdu = vi.fn();

      const router = createProtocolRouter({
        onDlmsApdu,
        onHeartbeat: vi.fn(),
      });

      const dlmsPayload = Buffer.from([
        0xC2, 0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.NULL_DATA,
      ]);
      const packet = buildIvyPacket(0x0010, dlmsPayload);

      // Send in chunks
      router.push(packet.subarray(0, 5));
      expect(onDlmsApdu).not.toHaveBeenCalled();

      router.push(packet.subarray(5));
      expect(onDlmsApdu).toHaveBeenCalledOnce();
    });

    it('should route raw DLMS to onDlmsApdu after IVY heartbeat', () => {
      const onHeartbeat = vi.fn();
      const onDlmsApdu = vi.fn();

      const router = createProtocolRouter({
        onHeartbeat,
        onDlmsApdu,
      });

      // First: heartbeat (establishes IVY_DLMS protocol)
      router.push(buildHeartbeatPacket('311501114070'));

      // Second: raw DLMS EventNotification (no IVY wrapper)
      const rawDlms = Buffer.from([
        0xC2, 0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10,
      ]);
      router.push(rawDlms);

      expect(onHeartbeat).toHaveBeenCalledOnce();
      expect(onDlmsApdu).toHaveBeenCalledOnce();
      const [parsed] = onDlmsApdu.mock.calls[0];
      expect(parsed.type).toBe('event-notification');
      expect(parsed.obisCode).toBe('1-0:1.8.0.255');
    });

    it('should route GET.response error to onDlmsApdu with errorName', () => {
      const onDlmsApdu = vi.fn();

      const router = createProtocolRouter({
        onDlmsApdu,
        onHeartbeat: vi.fn(),
      });

      // GET.response error APDU wrapped in IVY header
      const getResponseError = Buffer.from([
        0xC4, // GET.response tag
        0x01, // response-normal
        0x05, // invokeId = 5
        0x01, // choice: error
        0x04, // object-undefined
      ]);
      const packet = buildIvyPacket(0x0001, getResponseError);

      router.push(packet);

      expect(onDlmsApdu).toHaveBeenCalledOnce();
      const [parsed] = onDlmsApdu.mock.calls[0];
      expect(parsed.type).toBe('get-response');
      expect(parsed.accessResult).toBe('error');
      expect(parsed.data.errorCode).toBe(4);
      expect(parsed.data.errorName).toBe('object-undefined');
    });

    it('should route successful GET.response to onDlmsApdu with data', () => {
      const onDlmsApdu = vi.fn();

      const router = createProtocolRouter({
        onDlmsApdu,
        onHeartbeat: vi.fn(),
      });

      // GET.response success with UINT16 value
      const getResponseSuccess = Buffer.from([
        0xC4, // GET.response tag
        0x01, // response-normal
        0x01, // invokeId = 1
        0x00, // choice: data (success)
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // value = 230
      ]);
      const packet = buildIvyPacket(0x0001, getResponseSuccess);

      router.push(packet);

      expect(onDlmsApdu).toHaveBeenCalledOnce();
      const [parsed, telemetry] = onDlmsApdu.mock.calls[0];
      expect(parsed.type).toBe('get-response');
      expect(parsed.accessResult).toBe('success');
      expect(parsed.data.value).toBe(230);
      expect(telemetry).not.toBeNull();
      expect(telemetry.source).toBe('dlms');
    });

    it('should detect protocol from raw DLMS tag as first packet', () => {
      const onDlmsApdu = vi.fn();
      const onProtocolDetected = vi.fn();

      const router = createProtocolRouter({
        onDlmsApdu,
        onProtocolDetected,
      });

      // Send a raw DLMS EventNotification as the very first packet
      const rawDlms = Buffer.from([
        0xC2, 0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6,
      ]);
      router.push(rawDlms);

      expect(onProtocolDetected).toHaveBeenCalledWith(PROTOCOL_TYPES.IVY_DLMS);
      expect(onDlmsApdu).toHaveBeenCalledOnce();
      expect(router.getProtocol()).toBe(PROTOCOL_TYPES.IVY_DLMS);
    });
  });
});
