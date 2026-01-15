/**
 * DLT645-2007 Frame Parser
 *
 * Parses binary response frames from energy meters.
 * Handles data extraction, error detection, and stream parsing.
 *
 * Frame Structure:
 * [0x68] [A0-A5] [0x68] [C] [L] [DATA...] [CS] [0x16]
 *
 * Response Control Codes:
 * - Normal response: Request + 0x80 (e.g., 0x91 for read)
 * - Error response: Request + 0xC0 (e.g., 0xD1 for read error)
 *
 * @module protocol/frame-parser
 */

import {
  bufferToAddress,
  bufferToDataId,
  removeOffset,
  bcdToDecimal,
  bcdToSignedDecimal,
  bufferToHex,
} from './bcd.js';

import { verifyChecksum, validateFrameStructure, FRAME_CONSTANTS } from './checksum.js';

import {
  CONTROL_CODES,
  isResponseCode,
  isErrorResponse,
  getRequestCode,
  findRegisterById,
  parseErrorCode,
  toEngineeringUnits,
} from './registers.js';

/**
 * Parse a complete DLT645 frame
 *
 * @param {Buffer} frame - Complete frame buffer
 * @returns {Object} Parsed frame components
 * @throws {Error} If frame is invalid
 */
export const parseFrame = (frame) => {
  // Validate structure
  const structureResult = validateFrameStructure(frame);
  if (!structureResult.valid) {
    throw new Error(`Invalid frame structure: ${structureResult.errors.join(', ')}`);
  }

  // Verify checksum
  const checksumResult = verifyChecksum(frame);
  if (!checksumResult.valid) {
    throw new Error(
      `Checksum error: expected 0x${checksumResult.expected.toString(16)}, got 0x${checksumResult.actual.toString(16)}`
    );
  }

  // Extract components
  const address = extractAddress(frame);
  const controlCode = extractControlCode(frame);
  const dataLength = frame[9];
  const rawData = frame.subarray(10, 10 + dataLength);
  const data = removeOffset(rawData);

  return {
    address,
    controlCode: controlCode.code,
    controlType: controlCode.type,
    isResponse: controlCode.isResponse,
    isError: controlCode.isError,
    dataLength,
    rawData,
    data,
    checksum: frame[frame.length - 2],
    hex: bufferToHex(frame),
  };
};

/**
 * Extract meter address from frame
 *
 * @param {Buffer} frame - Frame buffer
 * @returns {string} 12-digit meter address
 */
export const extractAddress = (frame) => {
  if (frame.length < 7) {
    throw new Error('Frame too short to extract address');
  }
  const addressBuffer = frame.subarray(1, 7);
  return bufferToAddress(addressBuffer);
};

/**
 * Extract and classify control code
 *
 * @param {Buffer} frame - Frame buffer
 * @returns {Object} Control code info
 */
export const extractControlCode = (frame) => {
  if (frame.length < 9) {
    throw new Error('Frame too short to extract control code');
  }

  const code = frame[8];
  const isResponse = isResponseCode(code);
  const isError = isErrorResponse(code);
  const requestCode = isResponse ? getRequestCode(code) : code;

  // Determine type name
  let type = 'UNKNOWN';
  for (const [name, value] of Object.entries(CONTROL_CODES)) {
    if (value === code || value === requestCode) {
      type = name.replace('_RESPONSE', '').replace('_ERROR', '');
      break;
    }
  }

  return {
    code,
    requestCode,
    isResponse,
    isError,
    type,
  };
};

/**
 * Extract data payload from frame (with offset removed)
 *
 * @param {Buffer} frame - Frame buffer
 * @returns {Buffer} Data payload without offset
 */
export const extractData = (frame) => {
  if (frame.length < 12) {
    throw new Error('Frame too short to extract data');
  }

  const dataLength = frame[9];
  if (dataLength === 0) {
    return Buffer.alloc(0);
  }

  const rawData = frame.subarray(10, 10 + dataLength);
  return removeOffset(rawData);
};

/**
 * Parse a read response frame
 *
 * @param {Buffer} frame - Response frame
 * @param {Object} [register] - Optional register definition for value conversion
 * @returns {Object} Parsed response with value
 */
export const parseReadResponse = (frame, register = null) => {
  const parsed = parseFrame(frame);

  if (parsed.isError) {
    return parseErrorResponse(frame);
  }

  if (parsed.dataLength < 4) {
    throw new Error(`Read response data too short: ${parsed.dataLength} bytes`);
  }

  // Extract Data Identifier (first 4 bytes)
  const dataIdBuffer = parsed.data.subarray(0, 4);
  const dataId = bufferToDataId(Buffer.from([
    dataIdBuffer[0] + 0x33,
    dataIdBuffer[1] + 0x33,
    dataIdBuffer[2] + 0x33,
    dataIdBuffer[3] + 0x33,
  ]));

  // Value bytes are after DI
  const valueBuffer = parsed.data.subarray(4);

  // Find register if not provided
  const reg = register || findRegisterById(dataId);

  // Parse value based on register definition
  let rawValue;
  let value;

  if (valueBuffer.length > 0) {
    if (reg && reg.signed) {
      rawValue = bcdToSignedDecimal(valueBuffer);
    } else {
      rawValue = bcdToDecimal(valueBuffer);
    }

    value = reg ? toEngineeringUnits(rawValue, reg) : rawValue;
  } else {
    rawValue = null;
    value = null;
  }

  return {
    success: true,
    address: parsed.address,
    dataId,
    dataIdHex: `0x${dataId.toString(16).padStart(8, '0')}`,
    register: reg,
    rawValue,
    value,
    unit: reg ? reg.unit : null,
    hex: parsed.hex,
  };
};

/**
 * Parse a write response frame
 *
 * @param {Buffer} frame - Response frame
 * @returns {Object} Parsed write acknowledgment
 */
export const parseWriteResponse = (frame) => {
  const parsed = parseFrame(frame);

  if (parsed.isError) {
    return parseErrorResponse(frame);
  }

  return {
    success: true,
    address: parsed.address,
    controlCode: parsed.controlCode,
    hex: parsed.hex,
  };
};

/**
 * Parse a relay control response frame
 *
 * @param {Buffer} frame - Response frame
 * @returns {Object} Parsed relay response
 */
export const parseRelayResponse = (frame) => {
  const parsed = parseFrame(frame);

  if (parsed.isError) {
    return parseErrorResponse(frame);
  }

  return {
    success: true,
    address: parsed.address,
    controlCode: parsed.controlCode,
    hex: parsed.hex,
  };
};

/**
 * Parse an error response frame
 *
 * @param {Buffer} frame - Error response frame
 * @returns {Object} Error details
 */
export const parseErrorResponse = (frame) => {
  const parsed = parseFrame(frame);

  // Error code is in the data field (after DI if present)
  let errorCode = 0;
  let errorMessage = 'Unknown error';

  if (parsed.data.length > 0) {
    // For read errors, error code is after DI (4 bytes)
    if (parsed.data.length > 4) {
      errorCode = parsed.data[4];
    } else {
      errorCode = parsed.data[0];
    }
    errorMessage = parseErrorCode(errorCode);
  }

  return {
    success: false,
    address: parsed.address,
    controlCode: parsed.controlCode,
    isError: true,
    errorCode,
    errorMessage,
    hex: parsed.hex,
  };
};

/**
 * Parse telemetry data from value buffer using register definition
 *
 * @param {Buffer} dataBuffer - Raw value bytes (offset already removed)
 * @param {Object} register - Register definition
 * @returns {Object} Parsed telemetry value
 */
export const parseTelemetryData = (dataBuffer, register) => {
  if (!register) {
    return {
      rawValue: bcdToDecimal(dataBuffer),
      value: bcdToDecimal(dataBuffer),
      unit: null,
    };
  }

  let rawValue;
  if (register.signed) {
    rawValue = bcdToSignedDecimal(dataBuffer);
  } else {
    rawValue = bcdToDecimal(dataBuffer);
  }

  const value = toEngineeringUnits(rawValue, register);

  return {
    name: register.name,
    rawValue,
    value,
    unit: register.unit,
    resolution: register.resolution,
  };
};

/**
 * Build a standardized telemetry object from multiple parsed responses
 *
 * @param {Object[]} responses - Array of parsed read responses
 * @returns {Object} Standardized telemetry object
 */
export const buildTelemetryObject = (responses) => {
  const telemetry = {
    timestamp: new Date().toISOString(),
    address: null,
    energy: {},
    instantaneous: {},
    parameters: {},
    errors: [],
  };

  for (const response of responses) {
    if (!response.success) {
      telemetry.errors.push({
        dataId: response.dataId,
        errorCode: response.errorCode,
        errorMessage: response.errorMessage,
      });
      continue;
    }

    // Set address from first successful response
    if (!telemetry.address) {
      telemetry.address = response.address;
    }

    const reg = response.register;
    if (!reg) continue;

    // Categorize by register type
    const category = (response.dataId >> 24) & 0xff;

    if (category === 0x00) {
      // Energy registers
      telemetry.energy[reg.key || reg.name] = {
        value: response.value,
        unit: response.unit,
      };
    } else if (category === 0x02) {
      // Instantaneous registers
      telemetry.instantaneous[reg.key || reg.name] = {
        value: response.value,
        unit: response.unit,
      };
    } else if (category === 0x04) {
      // Parameter registers
      telemetry.parameters[reg.key || reg.name] = {
        value: response.value,
        unit: response.unit,
      };
    }
  }

  return telemetry;
};

/**
 * Check if buffer contains a complete frame
 *
 * @param {Buffer} buffer - Buffer to check
 * @returns {Object} Result with isComplete flag and frameLength
 */
export const isCompleteFrame = (buffer) => {
  // Need at least minimum frame length
  if (buffer.length < FRAME_CONSTANTS.MIN_FRAME_LENGTH) {
    return { isComplete: false, frameLength: 0 };
  }

  // Check for start delimiter
  if (buffer[0] !== FRAME_CONSTANTS.START_DELIMITER) {
    return { isComplete: false, frameLength: 0, error: 'No start delimiter' };
  }

  // Check for second start delimiter
  if (buffer.length > 7 && buffer[7] !== FRAME_CONSTANTS.START_DELIMITER) {
    return { isComplete: false, frameLength: 0, error: 'Invalid second delimiter' };
  }

  // Get declared data length
  if (buffer.length < 10) {
    return { isComplete: false, frameLength: 0 };
  }

  const dataLength = buffer[9];
  const expectedLength = FRAME_CONSTANTS.HEADER_LENGTH + dataLength + 2; // +2 for CS and end

  if (buffer.length < expectedLength) {
    return { isComplete: false, frameLength: expectedLength };
  }

  // Check end delimiter
  if (buffer[expectedLength - 1] !== FRAME_CONSTANTS.END_DELIMITER) {
    return { isComplete: false, frameLength: 0, error: 'Invalid end delimiter' };
  }

  return { isComplete: true, frameLength: expectedLength };
};

/**
 * Find frame start position in buffer
 *
 * @param {Buffer} buffer - Buffer to search
 * @param {number} [startIndex=0] - Starting position
 * @returns {number} Index of frame start, or -1 if not found
 */
export const findFrameStart = (buffer, startIndex = 0) => {
  for (let i = startIndex; i < buffer.length; i++) {
    if (buffer[i] === FRAME_CONSTANTS.START_DELIMITER) {
      return i;
    }
  }
  return -1;
};

/**
 * Create a stateful stream parser for TCP connections
 * Handles partial frames and buffer accumulation
 *
 * @param {Function} onFrame - Callback when complete frame is parsed
 * @param {Function} [onError] - Callback on parse errors
 * @returns {Object} Stream parser with push() and reset() methods
 */
export const createStreamParser = (onFrame, onError = null) => {
  let buffer = Buffer.alloc(0);
  let frameCount = 0;

  const parser = {
    /**
     * Push new data into the parser
     * @param {Buffer} data - Incoming data chunk
     */
    push(data) {
      // Append new data to buffer
      buffer = Buffer.concat([buffer, data]);

      // Process all complete frames in buffer
      while (buffer.length >= FRAME_CONSTANTS.MIN_FRAME_LENGTH) {
        // Find frame start
        const startIndex = findFrameStart(buffer);

        if (startIndex === -1) {
          // No start delimiter found, clear buffer
          buffer = Buffer.alloc(0);
          break;
        }

        // Discard any data before frame start
        if (startIndex > 0) {
          buffer = buffer.subarray(startIndex);
        }

        // Check if we have a complete frame
        const result = isCompleteFrame(buffer);

        if (!result.isComplete) {
          if (result.error) {
            // Invalid frame, skip this byte and try again
            buffer = buffer.subarray(1);
            continue;
          }
          // Incomplete frame, wait for more data
          break;
        }

        // Extract complete frame
        const frame = buffer.subarray(0, result.frameLength);
        buffer = buffer.subarray(result.frameLength);

        // Parse and emit frame
        try {
          const parsed = parseFrame(frame);
          frameCount++;
          onFrame(parsed, frame);
        } catch (err) {
          if (onError) {
            onError(err, frame);
          }
        }
      }
    },

    /**
     * Reset parser state
     */
    reset() {
      buffer = Buffer.alloc(0);
    },

    /**
     * Get current buffer length
     * @returns {number} Buffer length
     */
    getBufferLength() {
      return buffer.length;
    },

    /**
     * Get frame count
     * @returns {number} Number of frames parsed
     */
    getFrameCount() {
      return frameCount;
    },
  };

  return parser;
};

/**
 * Describe a response frame in human-readable format
 *
 * @param {Buffer} frame - Frame to describe
 * @returns {Object} Human-readable description
 */
export const describeResponse = (frame) => {
  try {
    const parsed = parseFrame(frame);
    const controlInfo = extractControlCode(frame);

    const description = {
      address: parsed.address,
      type: controlInfo.type,
      isResponse: controlInfo.isResponse,
      isError: controlInfo.isError,
      dataLength: parsed.dataLength,
      hex: parsed.hex,
    };

    if (parsed.isError) {
      const errorInfo = parseErrorResponse(frame);
      description.errorCode = errorInfo.errorCode;
      description.errorMessage = errorInfo.errorMessage;
    } else if (controlInfo.type === 'READ_DATA' && parsed.dataLength >= 4) {
      const readInfo = parseReadResponse(frame);
      description.dataId = readInfo.dataIdHex;
      description.value = readInfo.value;
      description.unit = readInfo.unit;
      if (readInfo.register) {
        description.registerName = readInfo.register.name;
      }
    }

    return description;
  } catch (err) {
    return {
      error: err.message,
      hex: bufferToHex(frame),
    };
  }
};

export default {
  parseFrame,
  extractAddress,
  extractControlCode,
  extractData,
  parseReadResponse,
  parseWriteResponse,
  parseRelayResponse,
  parseErrorResponse,
  parseTelemetryData,
  buildTelemetryObject,
  isCompleteFrame,
  findFrameStart,
  createStreamParser,
  describeResponse,
};
