/**
 * Checksum Module Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  calculateChecksum,
  verifyChecksum,
  appendChecksum,
  extractChecksum,
  validateFrameStructure,
  analyzeFrame,
  FRAME_CONSTANTS,
} from '../../../src/protocol/checksum.js';

describe('Checksum Module', () => {
  describe('FRAME_CONSTANTS', () => {
    it('should have correct delimiter values', () => {
      expect(FRAME_CONSTANTS.START_DELIMITER).toBe(0x68);
      expect(FRAME_CONSTANTS.END_DELIMITER).toBe(0x16);
    });

    it('should have correct length constants', () => {
      expect(FRAME_CONSTANTS.MIN_FRAME_LENGTH).toBe(12);
      expect(FRAME_CONSTANTS.ADDRESS_LENGTH).toBe(6);
      expect(FRAME_CONSTANTS.HEADER_LENGTH).toBe(10);
    });
  });

  describe('calculateChecksum', () => {
    it('should calculate simple sum modulo 256', () => {
      // Simple test: 0x01 + 0x02 + 0x03 = 0x06
      const buffer = Buffer.from([0x01, 0x02, 0x03]);
      expect(calculateChecksum(buffer)).toBe(0x06);
    });

    it('should handle overflow correctly (mod 256)', () => {
      // 0xFF + 0xFF = 0x1FE -> 0xFE (mod 256)
      const buffer = Buffer.from([0xff, 0xff]);
      expect(calculateChecksum(buffer)).toBe(0xfe);
    });

    it('should handle empty buffer', () => {
      const buffer = Buffer.alloc(0);
      expect(calculateChecksum(buffer)).toBe(0x00);
    });

    it('should calculate checksum for real DLT645 frame data', () => {
      // Example: Read total energy command frame (without CS and end)
      // 68 AA AA AA AA AA AA 68 11 04 33 33 33 33
      const frameData = Buffer.from([
        0x68, // Start
        0xaa,
        0xaa,
        0xaa,
        0xaa,
        0xaa,
        0xaa, // Address (broadcast)
        0x68, // Start 2
        0x11, // Control: Read
        0x04, // Length: 4 bytes
        0x33,
        0x33,
        0x33,
        0x33, // Data ID: 0x00000000 + offset
      ]);

      const checksum = calculateChecksum(frameData);
      // Manual calculation: sum of all bytes mod 256
      const manualSum = 0x68 + 0xaa * 6 + 0x68 + 0x11 + 0x04 + 0x33 * 4;
      expect(checksum).toBe(manualSum & 0xff);
    });

    it('should calculate checksum for meter address 000000001234', () => {
      // Frame: 68 34 12 00 00 00 00 68 11 04 33 33 33 33
      const frameData = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, // Address reversed
        0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
      ]);

      const checksum = calculateChecksum(frameData);
      expect(typeof checksum).toBe('number');
      expect(checksum).toBeGreaterThanOrEqual(0);
      expect(checksum).toBeLessThanOrEqual(255);
    });
  });

  describe('verifyChecksum', () => {
    it('should verify valid frame checksum', () => {
      // Build a valid frame manually
      const frameWithoutEnd = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
      ]);

      const checksum = calculateChecksum(frameWithoutEnd);
      const completeFrame = Buffer.concat([frameWithoutEnd, Buffer.from([checksum, 0x16])]);

      const result = verifyChecksum(completeFrame);
      expect(result.valid).toBe(true);
      expect(result.expected).toBe(result.actual);
    });

    it('should detect invalid checksum', () => {
      const invalidFrame = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
        0x00, // Wrong checksum
        0x16,
      ]);

      const result = verifyChecksum(invalidFrame);
      expect(result.valid).toBe(false);
      expect(result.actual).toBe(0x00);
      expect(result.expected).not.toBe(0x00);
    });

    it('should throw on frame too short', () => {
      const shortFrame = Buffer.from([0x68, 0x16]);
      expect(() => verifyChecksum(shortFrame)).toThrow('Frame too short');
    });

    it('should throw on invalid start delimiter', () => {
      const badStart = Buffer.from([
        0x00, // Wrong start
        0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33, 0x00, 0x16,
      ]);
      expect(() => verifyChecksum(badStart)).toThrow('Invalid start delimiter');
    });

    it('should throw on invalid end delimiter', () => {
      const badEnd = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33, 0x00,
        0x00, // Wrong end
      ]);
      expect(() => verifyChecksum(badEnd)).toThrow('Invalid end delimiter');
    });
  });

  describe('appendChecksum', () => {
    it('should append correct checksum and end delimiter', () => {
      const partial = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
      ]);

      const complete = appendChecksum(partial);

      // Should be 2 bytes longer
      expect(complete.length).toBe(partial.length + 2);

      // Last byte should be 0x16
      expect(complete[complete.length - 1]).toBe(0x16);

      // Checksum should be valid
      const result = verifyChecksum(complete);
      expect(result.valid).toBe(true);
    });

    it('should work for broadcast address frame', () => {
      const partial = Buffer.from([
        0x68, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, // Broadcast
        0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
      ]);

      const complete = appendChecksum(partial);
      const result = verifyChecksum(complete);
      expect(result.valid).toBe(true);
    });
  });

  describe('extractChecksum', () => {
    it('should extract checksum from valid frame', () => {
      const frame = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
        0xab, // Checksum
        0x16,
      ]);

      expect(extractChecksum(frame)).toBe(0xab);
    });

    it('should throw on frame too short', () => {
      const short = Buffer.from([0x68, 0x16]);
      expect(() => extractChecksum(short)).toThrow('too short');
    });
  });

  describe('validateFrameStructure', () => {
    it('should validate correct frame structure', () => {
      const partial = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11,
        0x04, // Length = 4
        0x33, 0x33, 0x33, 0x33, // 4 data bytes
      ]);
      const frame = appendChecksum(partial);

      const result = validateFrameStructure(frame);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect invalid first start delimiter', () => {
      const frame = Buffer.from([
        0x00, // Wrong
        0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33, 0x00, 0x16,
      ]);

      const result = validateFrameStructure(frame);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('first start delimiter'))).toBe(true);
    });

    it('should detect invalid second start delimiter', () => {
      const frame = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00,
        0x00, // Wrong - should be 0x68
        0x11, 0x04, 0x33, 0x33, 0x33, 0x33, 0x00, 0x16,
      ]);

      const result = validateFrameStructure(frame);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('second start delimiter'))).toBe(true);
    });

    it('should detect length mismatch', () => {
      const frame = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11,
        0x08, // Says 8 bytes but only 4 follow
        0x33, 0x33, 0x33, 0x33, 0x00, 0x16,
      ]);

      const result = validateFrameStructure(frame);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Length mismatch'))).toBe(true);
    });

    it('should return frameInfo even on errors', () => {
      const frame = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33, 0x00,
        0x16,
      ]);

      const result = validateFrameStructure(frame);
      expect(result.frameInfo).toBeDefined();
      expect(result.frameInfo.totalLength).toBe(16);
    });
  });

  describe('analyzeFrame', () => {
    it('should break down frame into components', () => {
      const partial = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
      ]);
      const frame = appendChecksum(partial);

      const analysis = analyzeFrame(frame);

      expect(analysis.breakdown.startDelimiter1).toBe('0x68');
      expect(analysis.breakdown.startDelimiter2).toBe('0x68');
      expect(analysis.breakdown.controlCode).toBe('0x11');
      expect(analysis.breakdown.dataLength).toBe(4);
      expect(analysis.breakdown.endDelimiter).toBe('0x16');
      expect(analysis.breakdown.checksumValid).toBe(true);
    });

    it('should handle short frames gracefully', () => {
      const short = Buffer.from([0x68, 0x16]);
      const analysis = analyzeFrame(short);

      expect(analysis.error).toBeDefined();
      expect(analysis.length).toBe(2);
    });

    it('should show invalid checksum in analysis', () => {
      const badFrame = Buffer.from([
        0x68, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
        0xff, // Wrong checksum
        0x16,
      ]);

      const analysis = analyzeFrame(badFrame);
      expect(analysis.breakdown.checksumValid).toBe(false);
    });
  });

  describe('Real-world DLT645 Frame Tests', () => {
    it('should handle read total energy request frame', () => {
      // Standard read command for total active energy (0x00000000)
      const partial = Buffer.from([
        0x68, // Start
        0x78, 0x56, 0x34, 0x12, 0x00, 0x00, // Address: 000012345678 reversed
        0x68, // Start 2
        0x11, // Control: Read data
        0x04, // Length: 4
        0x33, 0x33, 0x33, 0x33, // DI: 0x00000000 + 0x33 offset
      ]);

      const frame = appendChecksum(partial);

      // Verify structure
      const structResult = validateFrameStructure(frame);
      expect(structResult.valid).toBe(true);

      // Verify checksum
      const csResult = verifyChecksum(frame);
      expect(csResult.valid).toBe(true);
    });

    it('should handle read response frame', () => {
      // Response to read command (control = 0x91 = 0x11 + 0x80)
      const partial = Buffer.from([
        0x68, 0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x68,
        0x91, // Response control code
        0x08, // Length: 4 (DI) + 4 (data)
        0x33, 0x33, 0x33, 0x33, // DI echo
        0x78, 0x56, 0x34, 0x12, // Energy: 12345678 BCD (123456.78 kWh)
      ]);

      const frame = appendChecksum(partial);

      const csResult = verifyChecksum(frame);
      expect(csResult.valid).toBe(true);

      const analysis = analyzeFrame(frame);
      expect(analysis.breakdown.controlCode).toBe('0x91');
      expect(analysis.breakdown.dataLength).toBe(8);
    });

    it('should handle relay control command frame', () => {
      // Relay control (0x1C) - simplified without encryption
      const partial = Buffer.from([
        0x68, 0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x68,
        0x1c, // Relay control
        0x10, // Length: 16 bytes
        // 16 bytes of data (simplified - actual would be encrypted)
        0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
        0x33,
      ]);

      const frame = appendChecksum(partial);

      const result = verifyChecksum(frame);
      expect(result.valid).toBe(true);
    });

    it('should handle error response frame', () => {
      // Error response (control = 0xD1, error in data)
      const partial = Buffer.from([
        0x68, 0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x68,
        0xd1, // Error response
        0x01, // Length: 1 (error code)
        0x34, // Error code (example)
      ]);

      const frame = appendChecksum(partial);

      const csResult = verifyChecksum(frame);
      expect(csResult.valid).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle minimum valid frame (no data)', () => {
      // Minimum frame: 0x68 + 6 addr + 0x68 + ctrl + len(0) + cs + 0x16
      const partial = Buffer.from([
        0x68, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x68, 0x11,
        0x00, // No data
      ]);

      const frame = appendChecksum(partial);
      expect(frame.length).toBe(12); // Minimum length

      const result = verifyChecksum(frame);
      expect(result.valid).toBe(true);
    });

    it('should handle maximum single-frame data length', () => {
      // Max data length is 200 bytes per DLT645 spec
      const dataLength = 200;
      const data = Buffer.alloc(dataLength, 0x33);

      const partial = Buffer.concat([
        Buffer.from([0x68, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x68, 0x91, dataLength]),
        data,
      ]);

      const frame = appendChecksum(partial);

      const result = verifyChecksum(frame);
      expect(result.valid).toBe(true);
    });

    it('should handle all-FF address (common test address)', () => {
      const partial = Buffer.from([
        0x68, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33,
      ]);

      const frame = appendChecksum(partial);
      const result = verifyChecksum(frame);
      expect(result.valid).toBe(true);
    });
  });
});
