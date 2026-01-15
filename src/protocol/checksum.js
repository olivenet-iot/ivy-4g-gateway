/**
 * DLT645-2007 Checksum Utilities
 *
 * Checksum calculation rules:
 * - Sum all bytes from first 0x68 to the byte before checksum
 * - Take modulo 256 (& 0xFF)
 * - Checksum byte is placed before the end delimiter (0x16)
 *
 * Frame structure reminder:
 * [0x68] [A0-A5] [0x68] [C] [L] [DATA...] [CS] [0x16]
 *   ^---- checksum includes these bytes ----^
 *
 * @module protocol/checksum
 */

import { bufferToHex } from './bcd.js';

/**
 * Calculate DLT645 checksum for a buffer
 * Sums all bytes and returns modulo 256
 *
 * @param {Buffer} buffer - Bytes to calculate checksum over
 * @returns {number} Single byte checksum (0x00-0xFF)
 * @example
 * calculateChecksum(Buffer.from([0x68, 0x12, 0x34, 0x56, 0x78, 0x90, 0x12, 0x68, 0x11, 0x04, 0x33, 0x33, 0x33, 0x33]))
 */
export const calculateChecksum = (buffer) => {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i];
  }
  return sum & 0xff;
};

/**
 * Verify checksum of a complete DLT645 frame
 *
 * @param {Buffer} frame - Complete frame including start (0x68) and end (0x16)
 * @returns {Object} Validation result
 * @returns {boolean} result.valid - Whether checksum is correct
 * @returns {number} result.expected - Calculated checksum
 * @returns {number} result.actual - Checksum byte from frame
 * @throws {Error} If frame is too short or malformed
 * @example
 * verifyChecksum(Buffer.from([0x68, ..., CS, 0x16]))
 */
export const verifyChecksum = (frame) => {
  // Minimum frame: 0x68 + 6 addr + 0x68 + ctrl + len + cs + 0x16 = 12 bytes
  if (frame.length < 12) {
    throw new Error(`Frame too short for checksum verification: ${frame.length} bytes`);
  }

  // Verify frame delimiters
  if (frame[0] !== 0x68) {
    throw new Error(`Invalid start delimiter: 0x${frame[0].toString(16)}, expected 0x68`);
  }

  if (frame[frame.length - 1] !== 0x16) {
    throw new Error(
      `Invalid end delimiter: 0x${frame[frame.length - 1].toString(16)}, expected 0x16`
    );
  }

  // Checksum is second-to-last byte
  const checksumIndex = frame.length - 2;
  const actualChecksum = frame[checksumIndex];

  // Calculate expected checksum (all bytes except checksum and end delimiter)
  const dataToCheck = frame.subarray(0, checksumIndex);
  const expectedChecksum = calculateChecksum(dataToCheck);

  return {
    valid: actualChecksum === expectedChecksum,
    expected: expectedChecksum,
    actual: actualChecksum,
  };
};

/**
 * Append checksum and end delimiter to a partial frame
 * Input should be a frame without checksum and end delimiter
 *
 * @param {Buffer} partialFrame - Frame from 0x68 through data (no CS, no 0x16)
 * @returns {Buffer} Complete frame with checksum and 0x16 appended
 * @example
 * // Input: [0x68, A0-A5, 0x68, C, L, DATA...]
 * // Output: [0x68, A0-A5, 0x68, C, L, DATA..., CS, 0x16]
 * appendChecksum(partialFrame)
 */
export const appendChecksum = (partialFrame) => {
  const checksum = calculateChecksum(partialFrame);

  // Create new buffer with space for checksum and end delimiter
  const completeFrame = Buffer.alloc(partialFrame.length + 2);

  // Copy partial frame
  partialFrame.copy(completeFrame, 0);

  // Append checksum
  completeFrame[partialFrame.length] = checksum;

  // Append end delimiter
  completeFrame[partialFrame.length + 1] = 0x16;

  return completeFrame;
};

/**
 * Extract checksum byte from a complete frame
 *
 * @param {Buffer} frame - Complete DLT645 frame
 * @returns {number} Checksum byte value
 * @throws {Error} If frame is too short
 */
export const extractChecksum = (frame) => {
  if (frame.length < 3) {
    throw new Error(`Frame too short to extract checksum: ${frame.length} bytes`);
  }

  // Checksum is always second-to-last byte (before 0x16)
  return frame[frame.length - 2];
};

/**
 * Validate frame structure (basic integrity check)
 * Checks delimiters, minimum length, and second start delimiter position
 *
 * @param {Buffer} frame - Frame to validate
 * @returns {Object} Validation result with details
 */
export const validateFrameStructure = (frame) => {
  const errors = [];

  // Check minimum length
  if (frame.length < 12) {
    errors.push(`Frame too short: ${frame.length} bytes (minimum 12)`);
    return { valid: false, errors };
  }

  // Check start delimiter
  if (frame[0] !== 0x68) {
    errors.push(`Invalid first start delimiter: 0x${frame[0].toString(16).padStart(2, '0')}`);
  }

  // Check second start delimiter (after 6-byte address)
  if (frame[7] !== 0x68) {
    errors.push(
      `Invalid second start delimiter: 0x${frame[7].toString(16).padStart(2, '0')} at position 7`
    );
  }

  // Check end delimiter
  if (frame[frame.length - 1] !== 0x16) {
    errors.push(
      `Invalid end delimiter: 0x${frame[frame.length - 1].toString(16).padStart(2, '0')}`
    );
  }

  // Check length field matches actual data length
  const declaredLength = frame[9]; // Length byte is at position 9
  const actualDataLength = frame.length - 12; // Total - (start + addr + start + ctrl + len + cs + end)

  if (declaredLength !== actualDataLength) {
    errors.push(`Length mismatch: declared ${declaredLength}, actual data ${actualDataLength}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    frameInfo: {
      totalLength: frame.length,
      declaredDataLength: declaredLength,
      actualDataLength,
    },
  };
};

/**
 * Debug helper: Print frame analysis
 *
 * @param {Buffer} frame - Frame to analyze
 * @returns {Object} Detailed frame breakdown
 */
export const analyzeFrame = (frame) => {
  if (frame.length < 12) {
    return {
      error: 'Frame too short for analysis',
      hex: bufferToHex(frame),
      length: frame.length,
    };
  }

  const startDelimiter1 = frame[0];
  const address = frame.subarray(1, 7);
  const startDelimiter2 = frame[7];
  const controlCode = frame[8];
  const dataLength = frame[9];
  const data = frame.subarray(10, 10 + dataLength);
  const checksum = frame[frame.length - 2];
  const endDelimiter = frame[frame.length - 1];

  // Calculate expected checksum
  const checksumData = frame.subarray(0, frame.length - 2);
  const expectedChecksum = calculateChecksum(checksumData);

  return {
    hex: bufferToHex(frame),
    totalLength: frame.length,
    breakdown: {
      startDelimiter1: `0x${startDelimiter1.toString(16).padStart(2, '0')}`,
      address: bufferToHex(address),
      startDelimiter2: `0x${startDelimiter2.toString(16).padStart(2, '0')}`,
      controlCode: `0x${controlCode.toString(16).padStart(2, '0')}`,
      dataLength,
      data: bufferToHex(data),
      checksum: `0x${checksum.toString(16).padStart(2, '0')}`,
      expectedChecksum: `0x${expectedChecksum.toString(16).padStart(2, '0')}`,
      checksumValid: checksum === expectedChecksum,
      endDelimiter: `0x${endDelimiter.toString(16).padStart(2, '0')}`,
    },
  };
};

/**
 * DLT645 Frame Constants
 */
export const FRAME_CONSTANTS = {
  START_DELIMITER: 0x68,
  END_DELIMITER: 0x16,
  MIN_FRAME_LENGTH: 12,
  ADDRESS_LENGTH: 6,
  HEADER_LENGTH: 10, // start + addr(6) + start + ctrl + len
};

export default {
  calculateChecksum,
  verifyChecksum,
  appendChecksum,
  extractChecksum,
  validateFrameStructure,
  analyzeFrame,
  FRAME_CONSTANTS,
};
