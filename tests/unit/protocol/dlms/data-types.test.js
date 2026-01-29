/**
 * DLMS Data Types Parser Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  DLMS_DATA_TYPES,
  parseDlmsValue,
  parseCosemDateTime,
  parseObisCode,
  looksLikeCosemDateTime,
} from '../../../../src/protocol/dlms/data-types.js';

describe('DLMS Data Types', () => {
  describe('parseDlmsValue', () => {
    it('should parse null-data', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.NULL_DATA]);
      const result = parseDlmsValue(buf);
      expect(result.value).toBeNull();
      expect(result.typeName).toBe('NULL_DATA');
      expect(result.bytesConsumed).toBe(1);
    });

    it('should parse boolean true', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.BOOLEAN, 0x01]);
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(true);
      expect(result.typeName).toBe('BOOLEAN');
      expect(result.bytesConsumed).toBe(2);
    });

    it('should parse boolean false', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.BOOLEAN, 0x00]);
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(false);
    });

    it('should parse uint8', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.UINT8, 0xFF]);
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(255);
      expect(result.bytesConsumed).toBe(2);
    });

    it('should parse int8', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.INT8, 0x80]); // -128
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(-128);
    });

    it('should parse uint16', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.UINT16, 0x01, 0x00]); // 256
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(256);
      expect(result.bytesConsumed).toBe(3);
    });

    it('should parse int16', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.INT16, 0xFF, 0x00]); // -256
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(-256);
    });

    it('should parse uint32', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.UINT32, 0x00, 0x01, 0x00, 0x00]); // 65536
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(65536);
      expect(result.bytesConsumed).toBe(5);
    });

    it('should parse int32', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.INT32, 0xFF, 0xFF, 0xFF, 0xFE]); // -2
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(-2);
    });

    it('should parse float32', () => {
      const buf = Buffer.alloc(5);
      buf[0] = DLMS_DATA_TYPES.FLOAT32;
      buf.writeFloatBE(3.14, 1);
      const result = parseDlmsValue(buf);
      expect(result.value).toBeCloseTo(3.14, 2);
      expect(result.bytesConsumed).toBe(5);
    });

    it('should parse float64', () => {
      const buf = Buffer.alloc(9);
      buf[0] = DLMS_DATA_TYPES.FLOAT64;
      buf.writeDoubleBE(2.718281828, 1);
      const result = parseDlmsValue(buf);
      expect(result.value).toBeCloseTo(2.718281828, 6);
      expect(result.bytesConsumed).toBe(9);
    });

    it('should parse enum', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.ENUM, 0x03]);
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(3);
      expect(result.typeName).toBe('ENUM');
    });

    it('should parse octet-string', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.OCTET_STRING, 0x03, 0xAA, 0xBB, 0xCC]);
      const result = parseDlmsValue(buf);
      expect(Buffer.isBuffer(result.value)).toBe(true);
      expect(result.value).toEqual(Buffer.from([0xAA, 0xBB, 0xCC]));
      expect(result.bytesConsumed).toBe(5);
    });

    it('should parse visible-string', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.VISIBLE_STRING, 0x05, 0x48, 0x65, 0x6C, 0x6C, 0x6F]);
      const result = parseDlmsValue(buf);
      expect(result.value).toBe('Hello');
      expect(result.bytesConsumed).toBe(7);
    });

    it('should parse array', () => {
      // Array of 2 uint8 values
      const buf = Buffer.from([
        DLMS_DATA_TYPES.ARRAY, 0x02,
        DLMS_DATA_TYPES.UINT8, 0x0A,
        DLMS_DATA_TYPES.UINT8, 0x14,
      ]);
      const result = parseDlmsValue(buf);
      expect(result.typeName).toBe('ARRAY');
      expect(result.value).toEqual([10, 20]);
    });

    it('should parse structure', () => {
      // Structure with uint16 and boolean
      const buf = Buffer.from([
        DLMS_DATA_TYPES.STRUCTURE, 0x02,
        DLMS_DATA_TYPES.UINT16, 0x00, 0xFF,
        DLMS_DATA_TYPES.BOOLEAN, 0x01,
      ]);
      const result = parseDlmsValue(buf);
      expect(result.typeName).toBe('STRUCTURE');
      expect(result.value).toHaveLength(2);
      expect(result.value[0].value).toBe(255);
      expect(result.value[1].value).toBe(true);
    });

    it('should parse datetime type tag', () => {
      const buf = Buffer.alloc(13);
      buf[0] = DLMS_DATA_TYPES.DATE_TIME;
      buf.writeUInt16BE(2025, 1);
      buf[3] = 6;  // month
      buf[4] = 15; // day
      buf[5] = 3;  // dow
      buf[6] = 14; // hour
      buf[7] = 30; // minute
      buf[8] = 0;  // second
      buf[9] = 0;  // hundredths
      buf.writeInt16BE(60, 10); // deviation
      buf[12] = 0; // clock status

      const result = parseDlmsValue(buf);
      expect(result.typeName).toBe('DATE_TIME');
      expect(result.value.year).toBe(2025);
      expect(result.value.month).toBe(6);
      expect(result.value.hour).toBe(14);
      expect(result.bytesConsumed).toBe(13);
    });

    it('should parse with offset', () => {
      const buf = Buffer.from([0xFF, 0xFF, DLMS_DATA_TYPES.UINT8, 0x42]);
      const result = parseDlmsValue(buf, 2);
      expect(result.value).toBe(0x42);
    });

    it('should throw for unknown type tag', () => {
      const buf = Buffer.from([0xFE, 0x00]);
      expect(() => parseDlmsValue(buf)).toThrow('Unknown DLMS data type');
    });

    it('should throw for offset beyond buffer', () => {
      const buf = Buffer.from([0x01]);
      expect(() => parseDlmsValue(buf, 5)).toThrow('offset');
    });

    it('should parse int64', () => {
      const buf = Buffer.alloc(9);
      buf[0] = DLMS_DATA_TYPES.INT64;
      buf.writeBigInt64BE(-100n, 1);
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(-100);
      expect(result.bytesConsumed).toBe(9);
    });

    it('should parse uint64', () => {
      const buf = Buffer.alloc(9);
      buf[0] = DLMS_DATA_TYPES.UINT64;
      buf.writeBigUInt64BE(1000000n, 1);
      const result = parseDlmsValue(buf);
      expect(result.value).toBe(1000000);
    });

    it('should parse bit-string', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.BIT_STRING, 0x08, 0xFF]); // 8 bits
      const result = parseDlmsValue(buf);
      expect(Buffer.isBuffer(result.value)).toBe(true);
      expect(result.bytesConsumed).toBe(3);
    });

    it('should parse date', () => {
      const buf = Buffer.alloc(6);
      buf[0] = DLMS_DATA_TYPES.DATE;
      buf.writeUInt16BE(2025, 1);
      buf[3] = 1;  // month
      buf[4] = 15; // day
      buf[5] = 3;  // dow

      const result = parseDlmsValue(buf);
      expect(result.value.year).toBe(2025);
      expect(result.value.month).toBe(1);
      expect(result.value.day).toBe(15);
      expect(result.bytesConsumed).toBe(6);
    });

    it('should parse time', () => {
      const buf = Buffer.from([DLMS_DATA_TYPES.TIME, 14, 30, 45, 0]);
      const result = parseDlmsValue(buf);
      expect(result.value.hour).toBe(14);
      expect(result.value.minute).toBe(30);
      expect(result.value.second).toBe(45);
      expect(result.bytesConsumed).toBe(5);
    });
  });

  describe('parseCosemDateTime', () => {
    it('should parse a valid datetime', () => {
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(2025, 0);
      buf[2] = 3;   // March
      buf[3] = 20;  // 20th
      buf[4] = 4;   // Thursday
      buf[5] = 10;  // 10:00
      buf[6] = 0;
      buf[7] = 0;
      buf[8] = 0;   // hundredths
      buf.writeInt16BE(120, 9); // UTC+2h
      buf[11] = 0;

      const result = parseCosemDateTime(buf);
      expect(result.year).toBe(2025);
      expect(result.month).toBe(3);
      expect(result.day).toBe(20);
      expect(result.hour).toBe(10);
      expect(result.deviation).toBe(120);
      expect(result.iso).toBe('2025-03-20T10:00:00');
    });

    it('should handle not-specified fields (0xFF)', () => {
      const buf = Buffer.alloc(12, 0xFF);
      buf.writeUInt16BE(0xFFFF, 0);

      const result = parseCosemDateTime(buf);
      expect(result.year).toBeNull();
      expect(result.month).toBeNull();
      expect(result.day).toBeNull();
      expect(result.hour).toBeNull();
      expect(result.iso).toBeNull();
    });

    it('should handle not-specified deviation (0x8000)', () => {
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(2025, 0);
      buf[2] = 1;
      buf[3] = 1;
      buf[4] = 0xFF;
      buf[5] = 12;
      buf[6] = 0;
      buf[7] = 0;
      buf[8] = 0;
      buf.writeInt16BE(-0x8000, 9);
      buf[11] = 0;

      const result = parseCosemDateTime(buf);
      expect(result.deviation).toBeNull();
    });

    it('should throw for buffer too short', () => {
      expect(() => parseCosemDateTime(Buffer.alloc(5))).toThrow('Buffer too short');
    });

    it('should parse with offset', () => {
      const buf = Buffer.alloc(15);
      buf.writeUInt16BE(2024, 3);
      buf[5] = 12;
      buf[6] = 25;
      buf[7] = 0xFF;
      buf[8] = 8;
      buf[9] = 30;
      buf[10] = 0;
      buf[11] = 0;
      buf.writeInt16BE(0, 12);
      buf[14] = 0;

      const result = parseCosemDateTime(buf, 3);
      expect(result.year).toBe(2024);
      expect(result.month).toBe(12);
    });
  });

  describe('parseObisCode', () => {
    it('should parse standard OBIS code', () => {
      const buf = Buffer.from([1, 0, 1, 8, 0, 255]); // 1-0:1.8.0.255
      expect(parseObisCode(buf)).toBe('1-0:1.8.0.255');
    });

    it('should parse voltage OBIS', () => {
      const buf = Buffer.from([1, 0, 32, 7, 0, 255]); // 1-0:32.7.0.255
      expect(parseObisCode(buf)).toBe('1-0:32.7.0.255');
    });

    it('should parse with offset', () => {
      const buf = Buffer.from([0xFF, 0xFF, 1, 0, 31, 7, 0, 255]);
      expect(parseObisCode(buf, 2)).toBe('1-0:31.7.0.255');
    });

    it('should throw for buffer too short', () => {
      expect(() => parseObisCode(Buffer.from([1, 0, 1]))).toThrow('Buffer too short');
    });
  });

  describe('looksLikeCosemDateTime', () => {
    it('should return true for valid datetime bytes', () => {
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(2025, 0);
      buf[2] = 6;
      buf[5] = 14;
      expect(looksLikeCosemDateTime(buf)).toBe(true);
    });

    it('should return true for all-0xFF (not specified)', () => {
      const buf = Buffer.alloc(12, 0xFF);
      buf.writeUInt16BE(0xFFFF, 0);
      expect(looksLikeCosemDateTime(buf)).toBe(true);
    });

    it('should return false for buffer too short', () => {
      expect(looksLikeCosemDateTime(Buffer.alloc(5))).toBe(false);
    });

    it('should return false for unreasonable year', () => {
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(1800, 0); // Too old
      expect(looksLikeCosemDateTime(buf)).toBe(false);
    });

    it('should return false for invalid month', () => {
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(2025, 0);
      buf[2] = 13; // Invalid month
      expect(looksLikeCosemDateTime(buf)).toBe(false);
    });

    it('should return false for invalid hour', () => {
      const buf = Buffer.alloc(12);
      buf.writeUInt16BE(2025, 0);
      buf[2] = 6;
      buf[5] = 25; // Invalid hour
      expect(looksLikeCosemDateTime(buf)).toBe(false);
    });
  });
});
