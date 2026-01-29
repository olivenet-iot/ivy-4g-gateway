/**
 * DLMS Client Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  buildAarq,
  buildGetRequest,
  buildReleaseRequest,
  wrapDlmsForSending,
  prepareDlmsForSending,
  obisToBytes,
} from '../../../../src/protocol/dlms/client.js';
import { IVY_HEADER_LENGTH } from '../../../../src/protocol/ivy-wrapper.js';

describe('DLMS Client', () => {
  describe('buildAarq', () => {
    it('should build an AARQ starting with tag 0x60', () => {
      const aarq = buildAarq();
      expect(aarq[0]).toBe(0x60);
      expect(aarq.length).toBeGreaterThan(2);
    });

    it('should have valid BER-TLV length', () => {
      const aarq = buildAarq();
      const bodyLen = aarq[1];
      expect(aarq.length).toBe(2 + bodyLen);
    });
  });

  describe('buildGetRequest', () => {
    it('should build a GET.request starting with tag 0xC0', () => {
      const req = buildGetRequest(3, '1-0:1.8.0.255');
      expect(req[0]).toBe(0xC0);
      expect(req[1]).toBe(0x01); // get-request-normal
    });

    it('should be exactly 13 bytes', () => {
      const req = buildGetRequest(3, '1-0:1.8.0.255');
      expect(req.length).toBe(13);
    });

    it('should encode OBIS code correctly', () => {
      const req = buildGetRequest(3, '1-0:1.8.0.255');
      // OBIS starts at byte 3 (after tag, type, invokeId)
      // classId is bytes 3-4, OBIS is bytes 5-10
      expect(req[5]).toBe(1);
      expect(req[6]).toBe(0);
      expect(req[7]).toBe(1);
      expect(req[8]).toBe(8);
      expect(req[9]).toBe(0);
      expect(req[10]).toBe(255);
    });
  });

  describe('buildReleaseRequest', () => {
    it('should build an RLRQ starting with tag 0x62', () => {
      const rlrq = buildReleaseRequest();
      expect(rlrq[0]).toBe(0x62);
    });
  });

  describe('wrapDlmsForSending', () => {
    it('should wrap APDU with IVY header using default destination 0x0001', () => {
      const apdu = Buffer.from([0xC0, 0x01, 0x01]);
      const wrapped = wrapDlmsForSending(apdu);

      expect(wrapped.length).toBe(IVY_HEADER_LENGTH + apdu.length);
      // IVY signature
      expect(wrapped[0]).toBe(0x00);
      expect(wrapped[1]).toBe(0x01);
      expect(wrapped[2]).toBe(0x00);
      expect(wrapped[3]).toBe(0x01);
      // Destination: DLMS_PUBLIC_CLIENT (0x0001)
      expect(wrapped.readUInt16BE(4)).toBe(0x0001);
      // Payload length
      expect(wrapped.readUInt16BE(6)).toBe(apdu.length);
      // Payload
      expect(wrapped.subarray(IVY_HEADER_LENGTH)).toEqual(apdu);
    });

    it('should allow explicit destination override', () => {
      const apdu = Buffer.from([0xC0, 0x01, 0x01]);
      const wrapped = wrapDlmsForSending(apdu, 0x0010);

      expect(wrapped.readUInt16BE(4)).toBe(0x0010);
      expect(wrapped.subarray(IVY_HEADER_LENGTH)).toEqual(apdu);
    });
  });

  describe('prepareDlmsForSending', () => {
    it('should wrap with IVY header when wrapWithIvy is true', () => {
      const apdu = Buffer.from([0x60, 0x03, 0xA1, 0x01, 0x00]);
      const result = prepareDlmsForSending(apdu, { wrapWithIvy: true });

      expect(result.length).toBe(IVY_HEADER_LENGTH + apdu.length);
      expect(result[0]).toBe(0x00); // IVY header start
      expect(result[1]).toBe(0x01);
      expect(result.subarray(IVY_HEADER_LENGTH)).toEqual(apdu);
    });

    it('should return raw APDU when wrapWithIvy is false', () => {
      const apdu = Buffer.from([0x60, 0x03, 0xA1, 0x01, 0x00]);
      const result = prepareDlmsForSending(apdu, { wrapWithIvy: false });

      expect(result).toEqual(apdu);
      expect(result.length).toBe(apdu.length);
    });

    it('should default to wrapping with IVY header', () => {
      const apdu = Buffer.from([0xC0, 0x01, 0x01]);
      const result = prepareDlmsForSending(apdu);

      expect(result.length).toBe(IVY_HEADER_LENGTH + apdu.length);
    });

    it('should produce same output as wrapDlmsForSending when wrapping', () => {
      const apdu = buildAarq();
      const wrapped = wrapDlmsForSending(apdu);
      const prepared = prepareDlmsForSending(apdu, { wrapWithIvy: true });

      expect(prepared).toEqual(wrapped);
    });
  });

  describe('obisToBytes', () => {
    it('should convert valid OBIS code string to 6-byte buffer', () => {
      const bytes = obisToBytes('1-0:1.8.0.255');
      expect(bytes).toEqual(Buffer.from([1, 0, 1, 8, 0, 255]));
    });

    it('should throw for invalid OBIS format', () => {
      expect(() => obisToBytes('invalid')).toThrow('Invalid OBIS code format');
    });
  });
});
