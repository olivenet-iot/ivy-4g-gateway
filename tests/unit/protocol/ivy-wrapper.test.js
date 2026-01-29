/**
 * IVY Wrapper Parser Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  IVY_HEADER_LENGTH,
  IVY_VERSION,
  IVY_DESTINATIONS,
  isIvyPacket,
  parseIvyHeader,
  buildIvyHeader,
  wrapIvyPacket,
  createIvyStreamParser,
  computeRawDlmsLength,
} from '../../../src/protocol/ivy-wrapper.js';
import { DLMS_DATA_TYPES } from '../../../src/protocol/dlms/data-types.js';

/**
 * Build a valid IVY packet for testing
 */
const buildTestPacket = (destination = 0x0010, payload = Buffer.from([0xC2, 0x01, 0x02])) => {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(0x0001, 0); // version
  header.writeUInt16BE(0x0001, 2); // source
  header.writeUInt16BE(destination, 4);
  header.writeUInt16BE(payload.length, 6);
  return Buffer.concat([header, payload]);
};

describe('IVY Wrapper Parser', () => {
  describe('isIvyPacket', () => {
    it('should return true for valid IVY packet', () => {
      const packet = buildTestPacket();
      expect(isIvyPacket(packet)).toBe(true);
    });

    it('should return true for heartbeat destination', () => {
      const packet = buildTestPacket(IVY_DESTINATIONS.HEARTBEAT);
      expect(isIvyPacket(packet)).toBe(true);
    });

    it('should return false for DLT645 frame (starts with 0x68)', () => {
      const dlt645 = Buffer.alloc(12, 0);
      dlt645[0] = 0x68;
      expect(isIvyPacket(dlt645)).toBe(false);
    });

    it('should return false for buffer shorter than 4 bytes', () => {
      expect(isIvyPacket(Buffer.from([0x00, 0x01]))).toBe(false);
    });

    it('should return false for wrong signature bytes', () => {
      const packet = Buffer.from([0x00, 0x02, 0x00, 0x01, 0x00, 0x10, 0x00, 0x03]);
      expect(isIvyPacket(packet)).toBe(false);
    });

    it('should return false for null/undefined input', () => {
      expect(isIvyPacket(null)).toBe(false);
      expect(isIvyPacket(undefined)).toBe(false);
    });

    it('should return false for non-Buffer input', () => {
      expect(isIvyPacket('not a buffer')).toBe(false);
      expect(isIvyPacket(42)).toBe(false);
    });

    it('should check first 4 bytes: 00 01 00 01', () => {
      const valid = Buffer.from([0x00, 0x01, 0x00, 0x01]);
      expect(isIvyPacket(valid)).toBe(true);

      const invalid = Buffer.from([0x00, 0x01, 0x00, 0x02]);
      expect(isIvyPacket(invalid)).toBe(false);
    });
  });

  describe('parseIvyHeader', () => {
    it('should parse a valid 8-byte header', () => {
      const header = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x00, 0x20]);
      const result = parseIvyHeader(header);

      expect(result.version).toBe(0x0001);
      expect(result.source).toBe(0x0001);
      expect(result.destination).toBe(0x0010);
      expect(result.payloadLength).toBe(0x0020);
    });

    it('should parse heartbeat destination', () => {
      const header = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12]);
      const result = parseIvyHeader(header);

      expect(result.destination).toBe(IVY_DESTINATIONS.HEARTBEAT);
      expect(result.payloadLength).toBe(0x12);
    });

    it('should throw for buffer too short', () => {
      expect(() => parseIvyHeader(Buffer.from([0x00, 0x01]))).toThrow('Buffer too short');
    });

    it('should throw for null input', () => {
      expect(() => parseIvyHeader(null)).toThrow();
    });

    it('should parse from a longer buffer (only reads first 8 bytes)', () => {
      const packet = buildTestPacket(0x0010, Buffer.from([0xAA, 0xBB]));
      const result = parseIvyHeader(packet);

      expect(result.version).toBe(0x0001);
      expect(result.destination).toBe(0x0010);
      expect(result.payloadLength).toBe(2);
    });
  });

  describe('buildIvyHeader', () => {
    it('should build a valid 8-byte header', () => {
      const header = buildIvyHeader(0x0010, 32);

      expect(header.length).toBe(IVY_HEADER_LENGTH);
      expect(header.readUInt16BE(0)).toBe(IVY_VERSION);
      expect(header.readUInt16BE(2)).toBe(0x0001); // default source
      expect(header.readUInt16BE(4)).toBe(0x0010);
      expect(header.readUInt16BE(6)).toBe(32);
    });

    it('should use custom source address', () => {
      const header = buildIvyHeader(0x0010, 10, 0x0020);
      expect(header.readUInt16BE(2)).toBe(0x0020);
    });

    it('should round-trip with parseIvyHeader', () => {
      const header = buildIvyHeader(0x0010, 42, 0x0005);
      const parsed = parseIvyHeader(header);

      expect(parsed.version).toBe(IVY_VERSION);
      expect(parsed.source).toBe(0x0005);
      expect(parsed.destination).toBe(0x0010);
      expect(parsed.payloadLength).toBe(42);
    });
  });

  describe('wrapIvyPacket', () => {
    it('should wrap payload with header', () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const packet = wrapIvyPacket(0x0010, payload);

      expect(packet.length).toBe(IVY_HEADER_LENGTH + 3);
      expect(packet.readUInt16BE(6)).toBe(3);
      expect(packet.subarray(IVY_HEADER_LENGTH)).toEqual(payload);
    });

    it('should wrap empty payload', () => {
      const packet = wrapIvyPacket(0x0010, Buffer.alloc(0));
      expect(packet.length).toBe(IVY_HEADER_LENGTH);
      expect(packet.readUInt16BE(6)).toBe(0);
    });
  });

  describe('createIvyStreamParser', () => {
    it('should parse a single complete packet', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const packet = buildTestPacket(0x0010, Buffer.from([0xC2, 0x01]));
      parser.push(packet);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.destination).toBe(0x0010);
      expect(header.payloadLength).toBe(2);
      expect(payload).toEqual(Buffer.from([0xC2, 0x01]));
    });

    it('should handle data arriving in chunks', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const packet = buildTestPacket(0x0010, Buffer.from([0xAA, 0xBB, 0xCC]));

      // Send header first, then payload
      parser.push(packet.subarray(0, 5));
      expect(onPacket).not.toHaveBeenCalled();

      parser.push(packet.subarray(5));
      expect(onPacket).toHaveBeenCalledOnce();
    });

    it('should parse multiple packets in one push', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const pkt1 = buildTestPacket(0x0001, Buffer.from([0x01]));
      const pkt2 = buildTestPacket(0x0010, Buffer.from([0x02, 0x03]));

      parser.push(Buffer.concat([pkt1, pkt2]));

      expect(onPacket).toHaveBeenCalledTimes(2);
      expect(onPacket.mock.calls[0][0].destination).toBe(0x0001);
      expect(onPacket.mock.calls[1][0].destination).toBe(0x0010);
    });

    it('should track packet count', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      parser.push(buildTestPacket());
      parser.push(buildTestPacket());

      expect(parser.getPacketCount()).toBe(2);
    });

    it('should reset parser state', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      // Push partial data
      parser.push(Buffer.from([0x00, 0x01, 0x00, 0x01]));
      expect(parser.getBufferLength()).toBe(4);

      parser.reset();
      expect(parser.getBufferLength()).toBe(0);
    });

    it('should call onError for invalid data with no IVY header', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      parser.push(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));

      expect(onPacket).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalled();
    });

    it('should skip garbage bytes before valid packet', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      const garbage = Buffer.from([0xFF, 0xFE, 0xFD]);
      const valid = buildTestPacket(0x0010, Buffer.from([0xAA]));

      parser.push(Buffer.concat([garbage, valid]));

      expect(onPacket).toHaveBeenCalledOnce();
      expect(onPacket.mock.calls[0][0].destination).toBe(0x0010);
    });

    it('should reject payload length exceeding max', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      // Create header with excessive payload length
      const header = Buffer.alloc(8);
      header.writeUInt16BE(0x0001, 0);
      header.writeUInt16BE(0x0001, 2);
      header.writeUInt16BE(0x0010, 4);
      header.writeUInt16BE(0xFFFF, 6); // 65535 bytes - too large

      parser.push(header);
      expect(onError).toHaveBeenCalled();
      expect(onPacket).not.toHaveBeenCalled();
    });

    it('should provide raw buffer in callback', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const packet = buildTestPacket(0x0010, Buffer.from([0xAA]));
      parser.push(packet);

      const [, , raw] = onPacket.mock.calls[0];
      expect(raw).toEqual(packet);
    });

    it('should emit raw DLMS EventNotification without IVY wrapper', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      // Raw EventNotification: tag + classId + OBIS + attr + UINT32 value
      const rawApdu = Buffer.from([
        0xC2,             // EventNotification tag
        0x00, 0x03,       // classId = 3 (Register)
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: 1-0:1.8.0.255
        0x02,             // attributeIndex
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10, // value = 10000
      ]);

      parser.push(rawApdu);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.isRawDlms).toBe(true);
      expect(header.destination).toBe(IVY_DESTINATIONS.DLMS_PUBLIC_CLIENT);
      expect(payload).toEqual(rawApdu);
    });

    it('should parse IVY heartbeat followed by raw DLMS APDU', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      // IVY heartbeat packet
      const heartbeat = buildTestPacket(0x0001, Buffer.from([0x0a, 0x02, 0x0c]));

      // Raw DLMS EventNotification (no IVY wrapper)
      const rawDlms = Buffer.from([
        0xC2, 0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x10, 0x00,
      ]);

      parser.push(Buffer.concat([heartbeat, rawDlms]));

      expect(onPacket).toHaveBeenCalledTimes(2);
      // First: IVY heartbeat
      expect(onPacket.mock.calls[0][0].isRawDlms).toBeUndefined();
      expect(onPacket.mock.calls[0][0].destination).toBe(0x0001);
      // Second: raw DLMS
      expect(onPacket.mock.calls[1][0].isRawDlms).toBe(true);
    });

    it('should not misalign on DLMS data containing 00 01 bytes (regression)', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      // Raw EventNotification with OBIS 1-0:1.8.0.255 which contains 00 01 at bytes 4-5
      // In the old parser, this would trigger false IVY header detection
      const rawDlms = Buffer.from([
        0xC2,             // EventNotification tag
        0x00, 0x03,       // classId = 3
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: contains 00 01 at positions 4-5
        0x02,             // attributeIndex
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // value = 230
      ]);

      parser.push(rawDlms);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.isRawDlms).toBe(true);
      expect(payload).toEqual(rawDlms);
      // No misalignment errors
      expect(onError).not.toHaveBeenCalled();
    });

    it('should wait and reassemble raw DLMS APDU split across TCP segments', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const rawDlms = Buffer.from([
        0xC2, 0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10,
      ]);

      // Send first 5 bytes
      parser.push(rawDlms.subarray(0, 5));
      expect(onPacket).not.toHaveBeenCalled();

      // Send remaining bytes
      parser.push(rawDlms.subarray(5));
      expect(onPacket).toHaveBeenCalledOnce();
      expect(onPacket.mock.calls[0][0].isRawDlms).toBe(true);
    });

    it('should handle mixed IVY and raw DLMS packets in rapid succession', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const ivyPacket = buildTestPacket(0x0010, Buffer.from([0xC2, 0x01]));
      const rawDlms = Buffer.from([
        0xC2, 0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.UINT16, 0x00, 0x64,
      ]);
      const ivyPacket2 = buildTestPacket(0x0001, Buffer.from([0xAA]));

      parser.push(Buffer.concat([ivyPacket, rawDlms, ivyPacket2]));

      expect(onPacket).toHaveBeenCalledTimes(3);
      expect(onPacket.mock.calls[0][0].isRawDlms).toBeUndefined(); // IVY
      expect(onPacket.mock.calls[1][0].isRawDlms).toBe(true);      // raw DLMS
      expect(onPacket.mock.calls[2][0].isRawDlms).toBeUndefined(); // IVY
    });

    it('should correctly size raw AARE (BER-TLV)', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      // Minimal AARE: tag=0x61, length=5, body=5 bytes
      const aare = Buffer.from([
        0x61, 0x05, // tag + short-form length
        0xA1, 0x03, 0x02, 0x01, 0x00, // body (5 bytes)
      ]);

      parser.push(aare);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.isRawDlms).toBe(true);
      expect(payload.length).toBe(7);
    });

    it('should correctly parse raw ExceptionResponse (3 bytes)', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const excResp = Buffer.from([0xD8, 0x01, 0x02]); // stateError=1, serviceError=2

      parser.push(excResp);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.isRawDlms).toBe(true);
      expect(payload).toEqual(excResp);
    });

    it('should require 4-byte match for findIvyStart (old 2-byte match rejected)', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      // Data containing 00 01 but NOT 00 01 00 01 - should not be treated as IVY
      // Followed by a valid IVY packet
      const falseMatch = Buffer.from([0xFF, 0x00, 0x01, 0xFF, 0xFF]);
      const validIvy = buildTestPacket(0x0010, Buffer.from([0xAA]));

      parser.push(Buffer.concat([falseMatch, validIvy]));

      // Should parse the valid IVY packet, not the false 00 01 match
      expect(onPacket).toHaveBeenCalledOnce();
      expect(onPacket.mock.calls[0][0].destination).toBe(0x0010);
    });
  });

  describe('computeRawDlmsLength', () => {
    it('should return 3 for ExceptionResponse', () => {
      expect(computeRawDlmsLength(Buffer.from([0xD8, 0x01, 0x02]))).toBe(3);
    });

    it('should return -1 for incomplete ExceptionResponse', () => {
      expect(computeRawDlmsLength(Buffer.from([0xD8, 0x01]))).toBe(-1);
    });

    it('should compute BER-TLV length for AARE', () => {
      // Short form: tag + len(10) + 10 bytes body = 12
      const buf = Buffer.alloc(12);
      buf[0] = 0x61;
      buf[1] = 10;
      expect(computeRawDlmsLength(buf)).toBe(12);
    });

    it('should compute BER-TLV length for AARQ (0x60)', () => {
      const buf = Buffer.alloc(8);
      buf[0] = 0x60;
      buf[1] = 6; // 6 bytes of body
      expect(computeRawDlmsLength(buf)).toBe(8);
    });

    it('should compute BER-TLV length for RLRQ (0x62)', () => {
      const buf = Buffer.alloc(7);
      buf[0] = 0x62;
      buf[1] = 5;
      expect(computeRawDlmsLength(buf)).toBe(7);
    });

    it('should return 13 for complete GET.request (0xC0)', () => {
      const buf = Buffer.from([
        0xC0, 0x01, 0x01,             // tag + type + invokeId
        0x00, 0x03,                     // classId
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS
        0x02,                           // attrId
        0x00,                           // accessSelection
      ]);
      expect(computeRawDlmsLength(buf)).toBe(13);
    });

    it('should return -1 for incomplete GET.request', () => {
      expect(computeRawDlmsLength(Buffer.from([0xC0, 0x01, 0x01]))).toBe(-1);
    });

    it('should return -1 for unknown tags', () => {
      expect(computeRawDlmsLength(Buffer.from([0x99]))).toBe(-1);
    });

    it('should return -1 for empty buffer', () => {
      expect(computeRawDlmsLength(Buffer.alloc(0))).toBe(-1);
    });
  });

  describe('new DLMS tags in stream parser', () => {
    it('should recognize AARQ (0x60) as a raw DLMS APDU', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      // AARQ: BER-TLV with 3-byte body
      const aarq = Buffer.from([0x60, 0x03, 0xA1, 0x01, 0x00]);
      parser.push(aarq);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.isRawDlms).toBe(true);
      expect(payload).toEqual(aarq);
    });

    it('should recognize RLRQ (0x62) as a raw DLMS APDU', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      // RLRQ: BER-TLV with reason field
      const rlrq = Buffer.from([0x62, 0x03, 0x80, 0x01, 0x00]);
      parser.push(rlrq);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.isRawDlms).toBe(true);
      expect(payload).toEqual(rlrq);
    });

    it('should recognize GET.request (0xC0) as a raw DLMS APDU', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const getReq = Buffer.from([
        0xC0, 0x01, 0x01,
        0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        0x00,
      ]);
      parser.push(getReq);

      expect(onPacket).toHaveBeenCalledOnce();
      const [header, payload] = onPacket.mock.calls[0];
      expect(header.isRawDlms).toBe(true);
      expect(payload).toEqual(getReq);
    });

    it('should parse concatenated new-tag APDUs', () => {
      const onPacket = vi.fn();
      const parser = createIvyStreamParser(onPacket);

      const aarq = Buffer.from([0x60, 0x03, 0xA1, 0x01, 0x00]);
      const rlrq = Buffer.from([0x62, 0x03, 0x80, 0x01, 0x00]);

      parser.push(Buffer.concat([aarq, rlrq]));

      expect(onPacket).toHaveBeenCalledTimes(2);
      expect(onPacket.mock.calls[0][1]).toEqual(aarq);
      expect(onPacket.mock.calls[1][1]).toEqual(rlrq);
    });
  });

  describe('hex logging in error messages', () => {
    it('should include hex preview when discarding all bytes', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      const garbage = Buffer.from([0xFF, 0xFE, 0xFD, 0xFC]);
      parser.push(garbage);

      expect(onError).toHaveBeenCalled();
      const errorMsg = onError.mock.calls[0][0].message;
      expect(errorMsg).toContain('discarding 4 bytes');
      expect(errorMsg).toContain('hex: fffefdfc');
    });

    it('should include hex preview when skipping to next valid start', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      // Garbage followed by a valid ExceptionResponse
      const garbage = Buffer.from([0xFF, 0xFE]);
      const valid = Buffer.from([0xD8, 0x01, 0x02]);
      parser.push(Buffer.concat([garbage, valid]));

      expect(onPacket).toHaveBeenCalledOnce();
      // Find the skip error message
      const skipError = onError.mock.calls.find(call => call[0].message.includes('Skipping'));
      expect(skipError).toBeDefined();
      expect(skipError[0].message).toContain('hex: fffe');
    });
  });

  describe('EventNotification with trailing DLMS values', () => {
    it('should include trailing DLMS values in computeRawDlmsLength', () => {
      // EventNotification: tag + classId(2) + OBIS(6) + attr(1) + UINT16(3) + trailing UINT16(3)
      const buf = Buffer.from([
        0xC2,
        0x00, 0x03, // classId = 3
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS
        0x02, // attributeIndex
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // first value = 230
        DLMS_DATA_TYPES.UINT16, 0x01, 0x00, // trailing value = 256
      ]);

      const length = computeRawDlmsLength(buf);
      // Should consume ALL bytes including the trailing value
      expect(length).toBe(buf.length);
    });

    it('should parse stream with EventNotification containing trailing values followed by another APDU', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      // EventNotification with trailing UINT8
      const eventNotif = Buffer.from([
        0xC2,
        0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // first value
        DLMS_DATA_TYPES.UINT8, 0x0A, // trailing value
      ]);

      // Followed by an ExceptionResponse
      const excResp = Buffer.from([0xD8, 0x01, 0x02]);

      parser.push(Buffer.concat([eventNotif, excResp]));

      expect(onPacket).toHaveBeenCalledTimes(2);
      expect(onPacket.mock.calls[0][1]).toEqual(eventNotif);
      expect(onPacket.mock.calls[1][1]).toEqual(excResp);
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('EventNotification disambiguation', () => {
    it('should pick no-datetime when it exactly matches buffer length', () => {
      // Build an EventNotification where classId bytes happen to pass looksLikeCosemDateTime
      // but the correct parse is without datetime
      const rawApdu = Buffer.from([
        0xC2,             // EventNotification tag
        0x00, 0x03,       // classId = 3 (Register)
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: 1-0:1.8.0.255
        0x02,             // attributeIndex
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10, // value = 10000
      ]);

      // computeRawDlmsLength should return the full length without datetime
      const length = computeRawDlmsLength(rawApdu);
      expect(length).toBe(rawApdu.length);
    });

    it('should correctly parse concatenated EventNotifications where classId looks like datetime', () => {
      const onPacket = vi.fn();
      const onError = vi.fn();
      const parser = createIvyStreamParser(onPacket, onError);

      // First EventNotification
      const apdu1 = Buffer.from([
        0xC2,             // EventNotification tag
        0x00, 0x03,       // classId = 3
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS
        0x02,             // attributeIndex
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // value = 230
      ]);

      // Second EventNotification (concatenated)
      const apdu2 = Buffer.from([
        0xC2,
        0x00, 0x03,
        0x01, 0x00, 0x20, 0x07, 0x00, 0xFF, // different OBIS
        0x02,
        DLMS_DATA_TYPES.UINT16, 0x01, 0x00, // value = 256
      ]);

      parser.push(Buffer.concat([apdu1, apdu2]));

      // Should get 2 packets, no errors
      expect(onPacket).toHaveBeenCalledTimes(2);
      expect(onPacket.mock.calls[0][1]).toEqual(apdu1);
      expect(onPacket.mock.calls[1][1]).toEqual(apdu2);
    });
  });
});
