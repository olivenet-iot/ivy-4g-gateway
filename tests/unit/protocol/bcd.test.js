/**
 * BCD Utilities Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  DLT645_OFFSET,
  byteToBcd,
  bcdToByte,
  decimalToBcd,
  bcdToDecimal,
  decimalToBcdWithPrecision,
  bcdToDecimalWithPrecision,
  applyOffset,
  removeOffset,
  addressToBuffer,
  bufferToAddress,
  dataIdToBuffer,
  bufferToDataId,
  bufferToHex,
  hexToBuffer,
  bcdToSignedDecimal,
  signedDecimalToBcd,
} from '../../../src/protocol/bcd.js';

describe('BCD Utilities', () => {
  describe('DLT645_OFFSET', () => {
    it('should be 0x33', () => {
      expect(DLT645_OFFSET).toBe(0x33);
    });
  });

  describe('byteToBcd / bcdToByte', () => {
    it('should convert single digits correctly', () => {
      expect(byteToBcd(0)).toBe(0x00);
      expect(byteToBcd(9)).toBe(0x09);
      expect(bcdToByte(0x00)).toBe(0);
      expect(bcdToByte(0x09)).toBe(9);
    });

    it('should convert double digits correctly', () => {
      expect(byteToBcd(12)).toBe(0x12);
      expect(byteToBcd(99)).toBe(0x99);
      expect(byteToBcd(50)).toBe(0x50);
      expect(bcdToByte(0x12)).toBe(12);
      expect(bcdToByte(0x99)).toBe(99);
      expect(bcdToByte(0x50)).toBe(50);
    });

    it('should throw on invalid range', () => {
      expect(() => byteToBcd(-1)).toThrow();
      expect(() => byteToBcd(100)).toThrow();
    });

    it('should throw on invalid BCD digits', () => {
      expect(() => bcdToByte(0xaa)).toThrow();
      expect(() => bcdToByte(0x1a)).toThrow();
      expect(() => bcdToByte(0xf0)).toThrow();
    });
  });

  describe('decimalToBcd / bcdToDecimal', () => {
    it('should convert multi-byte values (little-endian)', () => {
      // 123456 -> [0x56, 0x34, 0x12, 0x00]
      const buffer = decimalToBcd(123456, 4, true);
      expect(buffer).toEqual(Buffer.from([0x56, 0x34, 0x12, 0x00]));
      expect(bcdToDecimal(buffer, true)).toBe(123456);
    });

    it('should convert multi-byte values (big-endian)', () => {
      // 123456 -> [0x00, 0x12, 0x34, 0x56]
      const buffer = decimalToBcd(123456, 4, false);
      expect(buffer).toEqual(Buffer.from([0x00, 0x12, 0x34, 0x56]));
      expect(bcdToDecimal(buffer, false)).toBe(123456);
    });

    it('should handle zero', () => {
      const buffer = decimalToBcd(0, 4, true);
      expect(buffer).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00]));
      expect(bcdToDecimal(buffer, true)).toBe(0);
    });

    it('should handle max 4-byte BCD value', () => {
      // 99999999 (max for 4 BCD bytes)
      const buffer = decimalToBcd(99999999, 4, true);
      expect(buffer).toEqual(Buffer.from([0x99, 0x99, 0x99, 0x99]));
      expect(bcdToDecimal(buffer, true)).toBe(99999999);
    });

    it('should throw on negative values', () => {
      expect(() => decimalToBcd(-1, 4)).toThrow();
    });
  });

  describe('decimalToBcdWithPrecision / bcdToDecimalWithPrecision', () => {
    it('should handle 2 decimal places (energy readings)', () => {
      // 1234.56 kWh -> 123456 -> BCD
      const buffer = decimalToBcdWithPrecision(1234.56, 4, 2, true);
      expect(bcdToDecimalWithPrecision(buffer, 2, true)).toBeCloseTo(1234.56);
    });

    it('should handle 1 decimal place (voltage)', () => {
      // 220.5 V -> 2205 -> BCD
      const buffer = decimalToBcdWithPrecision(220.5, 2, 1, true);
      expect(bcdToDecimalWithPrecision(buffer, 1, true)).toBeCloseTo(220.5);
    });

    it('should handle 3 decimal places (current)', () => {
      // 5.234 A -> 5234 -> BCD
      const buffer = decimalToBcdWithPrecision(5.234, 3, 3, true);
      expect(bcdToDecimalWithPrecision(buffer, 3, true)).toBeCloseTo(5.234);
    });
  });

  describe('applyOffset / removeOffset', () => {
    it('should apply +0x33 offset', () => {
      const input = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      const output = applyOffset(input);
      expect(output).toEqual(Buffer.from([0x33, 0x33, 0x33, 0x33]));
    });

    it('should remove +0x33 offset', () => {
      const input = Buffer.from([0x33, 0x33, 0x33, 0x33]);
      const output = removeOffset(input);
      expect(output).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00]));
    });

    it('should handle overflow correctly', () => {
      const input = Buffer.from([0xdd]); // 0xDD + 0x33 = 0x110 -> 0x10
      const output = applyOffset(input);
      expect(output).toEqual(Buffer.from([0x10]));
    });

    it('should handle underflow correctly', () => {
      const input = Buffer.from([0x10]); // 0x10 - 0x33 = -0x23 -> 0xDD
      const output = removeOffset(input);
      expect(output).toEqual(Buffer.from([0xdd]));
    });

    it('should be reversible', () => {
      const original = Buffer.from([0x12, 0x34, 0x56, 0x78]);
      const offsetted = applyOffset(original);
      const restored = removeOffset(offsetted);
      expect(restored).toEqual(original);
    });
  });

  describe('addressToBuffer / bufferToAddress', () => {
    it('should convert meter address to reversed BCD buffer', () => {
      // Address: 000000001234
      // Reversed: [0x34, 0x12, 0x00, 0x00, 0x00, 0x00]
      const buffer = addressToBuffer('000000001234');
      expect(buffer).toEqual(Buffer.from([0x34, 0x12, 0x00, 0x00, 0x00, 0x00]));
    });

    it('should convert buffer back to address', () => {
      const buffer = Buffer.from([0x34, 0x12, 0x00, 0x00, 0x00, 0x00]);
      expect(bufferToAddress(buffer)).toBe('000000001234');
    });

    it('should handle full address', () => {
      const address = '112233445566';
      const buffer = addressToBuffer(address);
      expect(bufferToAddress(buffer)).toBe(address);
    });

    it('should throw on invalid address format', () => {
      expect(() => addressToBuffer('12345')).toThrow();
      expect(() => addressToBuffer('12345678901a')).toThrow();
      expect(() => addressToBuffer('')).toThrow();
    });

    it('should handle addresses with separators', () => {
      const buffer = addressToBuffer('0000-0000-1234');
      expect(bufferToAddress(buffer)).toBe('000000001234');
    });
  });

  describe('dataIdToBuffer / bufferToDataId', () => {
    it('should convert TOTAL_ACTIVE_ENERGY register', () => {
      // DI: 0x00000000
      const buffer = dataIdToBuffer(0x00000000);
      // With +0x33 offset: [0x33, 0x33, 0x33, 0x33]
      expect(buffer).toEqual(Buffer.from([0x33, 0x33, 0x33, 0x33]));
      expect(bufferToDataId(buffer)).toBe(0x00000000);
    });

    it('should convert VOLTAGE register', () => {
      // DI: 0x02010100
      // Little-endian bytes: [0x00, 0x01, 0x01, 0x02]
      // With offset: [0x33, 0x34, 0x34, 0x35]
      const buffer = dataIdToBuffer(0x02010100);
      expect(buffer).toEqual(Buffer.from([0x33, 0x34, 0x34, 0x35]));
      expect(bufferToDataId(buffer)).toBe(0x02010100);
    });

    it('should convert CURRENT register', () => {
      // DI: 0x02020100
      const buffer = dataIdToBuffer(0x02020100);
      expect(bufferToDataId(buffer)).toBe(0x02020100);
    });

    it('should convert RELAY_STATUS register', () => {
      // DI: 0x04000501
      const buffer = dataIdToBuffer(0x04000501);
      expect(bufferToDataId(buffer)).toBe(0x04000501);
    });
  });

  describe('bufferToHex / hexToBuffer', () => {
    it('should convert buffer to hex string', () => {
      const buffer = Buffer.from([0x68, 0x12, 0x34, 0x56]);
      expect(bufferToHex(buffer)).toBe('68 12 34 56');
    });

    it('should convert hex string to buffer', () => {
      expect(hexToBuffer('68 12 34 56')).toEqual(Buffer.from([0x68, 0x12, 0x34, 0x56]));
      expect(hexToBuffer('68123456')).toEqual(Buffer.from([0x68, 0x12, 0x34, 0x56]));
      expect(hexToBuffer('68-12-34-56')).toEqual(Buffer.from([0x68, 0x12, 0x34, 0x56]));
    });

    it('should handle custom separator', () => {
      const buffer = Buffer.from([0x68, 0x12]);
      expect(bufferToHex(buffer, '-')).toBe('68-12');
      expect(bufferToHex(buffer, '')).toBe('6812');
    });

    it('should throw on invalid hex', () => {
      expect(() => hexToBuffer('GG')).toThrow();
      expect(() => hexToBuffer('123')).toThrow(); // Odd length
    });
  });

  describe('bcdToSignedDecimal / signedDecimalToBcd', () => {
    it('should handle positive values', () => {
      const buffer = signedDecimalToBcd(1234, 3, true);
      expect(bcdToSignedDecimal(buffer, true)).toBe(1234);
    });

    it('should handle negative values', () => {
      const buffer = signedDecimalToBcd(-1234, 3, true);
      expect(bcdToSignedDecimal(buffer, true)).toBe(-1234);
    });

    it('should handle zero', () => {
      const buffer = signedDecimalToBcd(0, 3, true);
      expect(bcdToSignedDecimal(buffer, true)).toBe(0);
    });

    it('should set MSB for negative values (little-endian)', () => {
      const buffer = signedDecimalToBcd(-100, 2, true);
      // Little-endian: [0x00, 0x81] - sign bit in high byte (index 1)
      expect(buffer[1] & 0x80).toBe(0x80);
    });
  });

  describe('Real-world DLT645 scenarios', () => {
    it('should parse actual meter address from frame', () => {
      // Frame snippet: address bytes [0x78, 0x56, 0x34, 0x12, 0x00, 0x00]
      const addressBytes = Buffer.from([0x78, 0x56, 0x34, 0x12, 0x00, 0x00]);
      expect(bufferToAddress(addressBytes)).toBe('000012345678');
    });

    it('should encode energy reading correctly', () => {
      // Energy: 12345.67 kWh (resolution 0.01)
      // Integer: 1234567
      const buffer = decimalToBcdWithPrecision(12345.67, 4, 2, true);
      // Expected: [0x67, 0x45, 0x23, 0x01] (little-endian BCD)
      expect(buffer).toEqual(Buffer.from([0x67, 0x45, 0x23, 0x01]));
    });

    it('should decode voltage reading correctly', () => {
      // Voltage in frame (after offset removal): [0x05, 0x22] = 2205 BCD
      // Resolution: 0.1 V -> 220.5 V
      const buffer = Buffer.from([0x05, 0x22]);
      expect(bcdToDecimalWithPrecision(buffer, 1, true)).toBeCloseTo(220.5);
    });

    it('should decode current reading correctly', () => {
      // Current: 5.234 A (resolution 0.001)
      // BCD: 5234 -> [0x34, 0x52, 0x00]
      const buffer = Buffer.from([0x34, 0x52, 0x00]);
      expect(bcdToDecimalWithPrecision(buffer, 3, true)).toBeCloseTo(5.234);
    });
  });
});
