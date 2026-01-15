/**
 * Frame Builder Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  buildReadFrame,
  buildReadFrameFromRegister,
  buildWriteFrame,
  buildRelayControlFrame,
  buildSimpleRelayFrame,
  buildReadAddressFrame,
  buildBroadcastTimeFrame,
  buildBatchReadFrames,
  buildBatchReadFramesFromRegisters,
  describeFrame,
  isValidAddress,
} from '../../../src/protocol/frame-builder.js';

import { verifyChecksum, validateFrameStructure } from '../../../src/protocol/checksum.js';
import {
  ENERGY_REGISTERS,
  INSTANTANEOUS_REGISTERS,
  CONTROL_CODES,
} from '../../../src/protocol/registers.js';

describe('Frame Builder', () => {
  describe('buildReadFrame', () => {
    it('should build valid read frame for total energy', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);

      // Verify frame structure
      const structure = validateFrameStructure(frame);
      expect(structure.valid).toBe(true);

      // Verify checksum
      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);

      // Verify control code
      expect(frame[8]).toBe(CONTROL_CODES.READ_DATA);

      // Verify data length (4 bytes for DI)
      expect(frame[9]).toBe(4);
    });

    it('should encode meter address in reversed BCD', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);

      // Address bytes are at positions 1-6
      const addressBytes = frame.subarray(1, 7);

      // 000000001234 reversed = [0x34, 0x12, 0x00, 0x00, 0x00, 0x00]
      expect(addressBytes).toEqual(Buffer.from([0x34, 0x12, 0x00, 0x00, 0x00, 0x00]));
    });

    it('should apply +0x33 offset to Data Identifier', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);

      // Data starts at position 10
      const dataBytes = frame.subarray(10, 14);

      // 0x00000000 + 0x33 offset = [0x33, 0x33, 0x33, 0x33]
      expect(dataBytes).toEqual(Buffer.from([0x33, 0x33, 0x33, 0x33]));
    });

    it('should build correct frame for voltage register', () => {
      // VOLTAGE_A = 0x02010100
      const frame = buildReadFrame('000000001234', 0x02010100);

      const structure = validateFrameStructure(frame);
      expect(structure.valid).toBe(true);

      // Data bytes: 0x02010100 little-endian + 0x33 = [0x33, 0x34, 0x34, 0x35]
      const dataBytes = frame.subarray(10, 14);
      expect(dataBytes).toEqual(Buffer.from([0x33, 0x34, 0x34, 0x35]));
    });

    it('should build frame with correct total length', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);

      // Header(10) + Data(4) + Checksum(1) + End(1) = 16
      expect(frame.length).toBe(16);
    });

    it('should have correct start and end delimiters', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);

      expect(frame[0]).toBe(0x68); // First start
      expect(frame[7]).toBe(0x68); // Second start
      expect(frame[frame.length - 1]).toBe(0x16); // End
    });
  });

  describe('buildReadFrameFromRegister', () => {
    it('should build frame from register definition', () => {
      const frame = buildReadFrameFromRegister(
        '000000001234',
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE
      );

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);

      expect(frame[8]).toBe(CONTROL_CODES.READ_DATA);
    });

    it('should work with instantaneous registers', () => {
      const frame = buildReadFrameFromRegister('000000001234', INSTANTANEOUS_REGISTERS.VOLTAGE_A);

      const structure = validateFrameStructure(frame);
      expect(structure.valid).toBe(true);
    });

    it('should throw on invalid register', () => {
      expect(() => buildReadFrameFromRegister('000000001234', null)).toThrow();
      expect(() => buildReadFrameFromRegister('000000001234', {})).toThrow();
      expect(() => buildReadFrameFromRegister('000000001234', { name: 'test' })).toThrow();
    });
  });

  describe('buildWriteFrame', () => {
    it('should build valid write frame', () => {
      const value = Buffer.from([0x00, 0x10]); // Some test value
      const frame = buildWriteFrame('000000001234', 0x04000101, value);

      const structure = validateFrameStructure(frame);
      expect(structure.valid).toBe(true);

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);

      expect(frame[8]).toBe(CONTROL_CODES.WRITE_DATA);
    });

    it('should include operator code and password', () => {
      const value = Buffer.from([0x00]);
      const frame = buildWriteFrame('000000001234', 0x04000101, value, '12345678', 'AABBCCDD');

      // Data length: DI(4) + Operator(4) + Password(4) + Value(1) = 13
      expect(frame[9]).toBe(13);
    });

    it('should apply offset to all data bytes', () => {
      const value = Buffer.from([0x00, 0x00]);
      const frame = buildWriteFrame('000000001234', 0x00000000, value);

      // All data bytes should have +0x33 offset
      const data = frame.subarray(10, 10 + frame[9]);
      for (const byte of data) {
        expect(byte).toBeGreaterThanOrEqual(0x33);
      }
    });
  });

  describe('buildRelayControlFrame', () => {
    const testKey = '00112233445566778899AABBCCDDEEFF';

    it('should build valid relay control frame for trip', () => {
      const frame = buildRelayControlFrame('000000001234', 'trip', testKey);

      const structure = validateFrameStructure(frame);
      expect(structure.valid).toBe(true);

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);

      expect(frame[8]).toBe(CONTROL_CODES.RELAY_CONTROL);
    });

    it('should build valid relay control frame for close', () => {
      const frame = buildRelayControlFrame('000000001234', 'close', testKey);

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);
    });

    it('should accept Buffer as AES key', () => {
      const keyBuffer = Buffer.from(testKey, 'hex');
      const frame = buildRelayControlFrame('000000001234', 'trip', keyBuffer);

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);
    });

    it('should throw on invalid command', () => {
      expect(() => buildRelayControlFrame('000000001234', 'invalid', testKey)).toThrow();
    });

    it('should throw on invalid AES key length', () => {
      expect(() => buildRelayControlFrame('000000001234', 'trip', '0011')).toThrow();
      expect(() => buildRelayControlFrame('000000001234', 'trip', Buffer.alloc(8))).toThrow();
    });

    it('should use provided timestamp', () => {
      const timestamp = new Date('2024-06-15T10:30:45');
      const frame1 = buildRelayControlFrame(
        '000000001234',
        'trip',
        testKey,
        '00000000',
        '00000000',
        timestamp
      );
      const frame2 = buildRelayControlFrame(
        '000000001234',
        'trip',
        testKey,
        '00000000',
        '00000000',
        timestamp
      );

      // Same timestamp should produce same frame
      expect(frame1).toEqual(frame2);
    });

    it('should include encrypted payload', () => {
      const frame = buildRelayControlFrame('000000001234', 'trip', testKey);

      // Data: DI(4) + Encrypted(16) = 20 bytes
      expect(frame[9]).toBe(20);
    });
  });

  describe('buildSimpleRelayFrame', () => {
    it('should build simple relay frame for trip', () => {
      const frame = buildSimpleRelayFrame('000000001234', 'trip');

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);

      expect(frame[8]).toBe(CONTROL_CODES.RELAY_CONTROL);
      expect(frame[9]).toBe(1); // Just command byte
    });

    it('should build simple relay frame for close', () => {
      const frame = buildSimpleRelayFrame('000000001234', 'close');

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);
    });

    it('should throw on invalid command', () => {
      expect(() => buildSimpleRelayFrame('000000001234', 'unknown')).toThrow();
    });
  });

  describe('buildReadAddressFrame', () => {
    it('should build valid address read frame', () => {
      const frame = buildReadAddressFrame();

      const structure = validateFrameStructure(frame);
      expect(structure.valid).toBe(true);

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);
    });

    it('should use broadcast address (all AAs)', () => {
      const frame = buildReadAddressFrame();

      // Address bytes should all be 0xAA
      const addressBytes = frame.subarray(1, 7);
      for (const byte of addressBytes) {
        expect(byte).toBe(0xaa);
      }
    });

    it('should have READ_ADDRESS control code', () => {
      const frame = buildReadAddressFrame();
      expect(frame[8]).toBe(CONTROL_CODES.READ_ADDRESS);
    });

    it('should have zero data length', () => {
      const frame = buildReadAddressFrame();
      expect(frame[9]).toBe(0);
    });
  });

  describe('buildBroadcastTimeFrame', () => {
    it('should build valid broadcast time frame', () => {
      const frame = buildBroadcastTimeFrame();

      const structure = validateFrameStructure(frame);
      expect(structure.valid).toBe(true);

      const checksum = verifyChecksum(frame);
      expect(checksum.valid).toBe(true);
    });

    it('should have BROADCAST_TIME control code', () => {
      const frame = buildBroadcastTimeFrame();
      expect(frame[8]).toBe(CONTROL_CODES.BROADCAST_TIME);
    });

    it('should have 6 bytes of time data', () => {
      const frame = buildBroadcastTimeFrame();
      expect(frame[9]).toBe(6);
    });

    it('should use provided time', () => {
      const time1 = new Date('2024-01-15T10:30:45');
      const time2 = new Date('2024-06-20T14:25:30');

      const frame1 = buildBroadcastTimeFrame(time1);
      const frame2 = buildBroadcastTimeFrame(time2);

      // Different times should produce different frames
      expect(frame1).not.toEqual(frame2);
    });

    it('should use broadcast address', () => {
      const frame = buildBroadcastTimeFrame();

      // Address should be 999999999999 in reversed BCD
      const addressBytes = frame.subarray(1, 7);
      expect(addressBytes).toEqual(Buffer.from([0x99, 0x99, 0x99, 0x99, 0x99, 0x99]));
    });
  });

  describe('buildBatchReadFrames', () => {
    it('should build multiple read frames', () => {
      const dataIds = [0x00000000, 0x02010100, 0x02020100];
      const frames = buildBatchReadFrames('000000001234', dataIds);

      expect(frames).toHaveLength(3);

      frames.forEach((frame) => {
        const checksum = verifyChecksum(frame);
        expect(checksum.valid).toBe(true);
      });
    });

    it('should return empty array for empty input', () => {
      const frames = buildBatchReadFrames('000000001234', []);
      expect(frames).toHaveLength(0);
    });
  });

  describe('buildBatchReadFramesFromRegisters', () => {
    it('should build frames from register array', () => {
      const registers = [
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE,
        INSTANTANEOUS_REGISTERS.VOLTAGE_A,
        INSTANTANEOUS_REGISTERS.CURRENT_A,
      ];

      const frames = buildBatchReadFramesFromRegisters('000000001234', registers);

      expect(frames).toHaveLength(3);

      frames.forEach((frame) => {
        const checksum = verifyChecksum(frame);
        expect(checksum.valid).toBe(true);
      });
    });
  });

  describe('describeFrame', () => {
    it('should describe read frame correctly', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      const description = describeFrame(frame);

      expect(description.length).toBe(frame.length);
      expect(description.controlCode).toContain('READ_DATA');
      expect(description.dataLength).toBe(4);
      expect(description.hex).toBeDefined();
    });

    it('should describe relay control frame', () => {
      const frame = buildSimpleRelayFrame('000000001234', 'trip');
      const description = describeFrame(frame);

      expect(description.controlCode).toContain('RELAY_CONTROL');
    });

    it('should handle short frames', () => {
      const shortFrame = Buffer.from([0x68, 0x16]);
      const description = describeFrame(shortFrame);

      expect(description.error).toBeDefined();
    });
  });

  describe('isValidAddress', () => {
    it('should accept valid 12-digit addresses', () => {
      expect(isValidAddress('000000001234')).toBe(true);
      expect(isValidAddress('123456789012')).toBe(true);
      expect(isValidAddress('999999999999')).toBe(true);
    });

    it('should accept addresses with separators', () => {
      expect(isValidAddress('0000-0000-1234')).toBe(true);
      expect(isValidAddress('0000 0000 1234')).toBe(true);
    });

    it('should accept broadcast address (all As)', () => {
      expect(isValidAddress('AAAAAAAAAAAA')).toBe(true);
      expect(isValidAddress('aaaaaaaaaaaa')).toBe(true);
    });

    it('should reject invalid addresses', () => {
      expect(isValidAddress('12345')).toBe(false);
      expect(isValidAddress('1234567890123')).toBe(false);
      expect(isValidAddress('00000000123X')).toBe(false);
      expect(isValidAddress('')).toBe(false);
      expect(isValidAddress(null)).toBe(false);
      expect(isValidAddress(123456789012)).toBe(false);
    });
  });

  describe('Frame Integrity Tests', () => {
    it('all built frames should pass checksum verification', () => {
      const frames = [
        buildReadFrame('000000001234', 0x00000000),
        buildReadFrame('999999999999', 0x02010100),
        buildSimpleRelayFrame('000000001234', 'trip'),
        buildSimpleRelayFrame('000000001234', 'close'),
        buildReadAddressFrame(),
        buildBroadcastTimeFrame(),
      ];

      frames.forEach((frame) => {
        const result = verifyChecksum(frame);
        expect(result.valid).toBe(true);
      });
    });

    it('all built frames should pass structure validation', () => {
      const frames = [
        buildReadFrame('000000001234', 0x00000000),
        buildWriteFrame('000000001234', 0x04000101, Buffer.from([0x01])),
        buildSimpleRelayFrame('000000001234', 'trip'),
        buildReadAddressFrame(),
        buildBroadcastTimeFrame(),
      ];

      frames.forEach((frame) => {
        const result = validateFrameStructure(frame);
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('Real-world Scenarios', () => {
    it('should build frame matching expected hex for total energy read', () => {
      // Read total energy from meter 000000001234
      const frame = buildReadFrame('000000001234', 0x00000000);

      // Expected structure:
      // 68 [addr 6 bytes] 68 11 04 [DI 4 bytes] CS 16
      expect(frame[0]).toBe(0x68);
      expect(frame[7]).toBe(0x68);
      expect(frame[8]).toBe(0x11);
      expect(frame[9]).toBe(0x04);
      expect(frame[frame.length - 1]).toBe(0x16);
    });

    it('should build telemetry polling frames', () => {
      const telemetryRegisters = [
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE,
        INSTANTANEOUS_REGISTERS.VOLTAGE_A,
        INSTANTANEOUS_REGISTERS.CURRENT_A,
        INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL,
      ];

      const frames = buildBatchReadFramesFromRegisters('000012345678', telemetryRegisters);

      expect(frames).toHaveLength(4);
      frames.forEach((frame) => {
        expect(verifyChecksum(frame).valid).toBe(true);
      });
    });
  });
});
