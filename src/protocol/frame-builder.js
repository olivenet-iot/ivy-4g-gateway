/**
 * DLT645-2007 Frame Builder
 *
 * Builds binary frames for communication with energy meters.
 * Handles read requests, write commands, and relay control.
 *
 * Frame Structure:
 * [0x68] [A0-A5] [0x68] [C] [L] [DATA...] [CS] [0x16]
 *
 * @module protocol/frame-builder
 */

import { addressToBuffer, dataIdToBuffer, applyOffset, bufferToHex } from './bcd.js';

import { appendChecksum, FRAME_CONSTANTS } from './checksum.js';

import { CONTROL_CODES, RELAY_COMMANDS, BROADCAST_ADDRESS } from './registers.js';

import crypto from 'crypto';

/**
 * Build frame header (start + address + start + control + length placeholder)
 * @param {string} address - 12-digit meter address
 * @param {number} controlCode - Control code byte
 * @returns {Buffer} Header bytes (10 bytes, length field = 0)
 */
const buildHeader = (address, controlCode) => {
  const header = Buffer.alloc(10);

  // Start delimiter
  header[0] = FRAME_CONSTANTS.START_DELIMITER;

  // Address (6 bytes, reversed BCD)
  const addressBuf = addressToBuffer(address);
  addressBuf.copy(header, 1);

  // Second start delimiter
  header[7] = FRAME_CONSTANTS.START_DELIMITER;

  // Control code
  header[8] = controlCode;

  // Length (will be updated when data is added)
  header[9] = 0;

  return header;
};

/**
 * Build a complete frame with header, data, checksum, and end delimiter
 * @param {string} address - 12-digit meter address
 * @param {number} controlCode - Control code byte
 * @param {Buffer} data - Data bytes (already with +0x33 offset if needed)
 * @returns {Buffer} Complete frame
 */
const buildFrame = (address, controlCode, data) => {
  const header = buildHeader(address, controlCode);

  // Update length field
  header[9] = data.length;

  // Combine header and data
  const frameWithoutChecksum = Buffer.concat([header, data]);

  // Add checksum and end delimiter
  return appendChecksum(frameWithoutChecksum);
};

/**
 * Build a READ DATA request frame
 * Requests a specific data register from the meter
 *
 * @param {string} address - 12-digit meter address
 * @param {number} dataId - 4-byte Data Identifier (e.g., 0x00000000 for total energy)
 * @returns {Buffer} Complete read request frame
 * @example
 * // Read total active energy from meter 000000001234
 * buildReadFrame('000000001234', 0x00000000)
 */
export const buildReadFrame = (address, dataId) => {
  // Data ID with +0x33 offset (4 bytes)
  const data = dataIdToBuffer(dataId);

  return buildFrame(address, CONTROL_CODES.READ_DATA, data);
};

/**
 * Build a READ DATA request frame using register definition
 *
 * @param {string} address - 12-digit meter address
 * @param {Object} register - Register definition object with 'id' property
 * @returns {Buffer} Complete read request frame
 * @example
 * import { INSTANTANEOUS_REGISTERS } from './registers.js';
 * buildReadFrameFromRegister('000000001234', INSTANTANEOUS_REGISTERS.VOLTAGE_A)
 */
export const buildReadFrameFromRegister = (address, register) => {
  if (!register || typeof register.id !== 'number') {
    throw new Error('Invalid register: must have numeric id property');
  }
  return buildReadFrame(address, register.id);
};

/**
 * Build a WRITE DATA request frame
 * Writes data to a specific register on the meter
 *
 * @param {string} address - 12-digit meter address
 * @param {number} dataId - 4-byte Data Identifier
 * @param {Buffer} value - Value to write (raw bytes, will have offset applied)
 * @param {string} [operatorCode='00000000'] - 8-digit operator code
 * @param {string} [password='00000000'] - 8-digit password
 * @returns {Buffer} Complete write request frame
 */
export const buildWriteFrame = (
  address,
  dataId,
  value,
  operatorCode = '00000000',
  password = '00000000'
) => {
  // Data ID (4 bytes with offset)
  const dataIdBuf = dataIdToBuffer(dataId);

  // Operator code (4 bytes BCD)
  const operatorBuf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    operatorBuf[i] = parseInt(operatorCode.substring(i * 2, i * 2 + 2), 16);
  }

  // Password (4 bytes BCD)
  const passwordBuf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    passwordBuf[i] = parseInt(password.substring(i * 2, i * 2 + 2), 16);
  }

  // Apply offset to value
  const valueWithOffset = applyOffset(value);

  // Combine: DI + PA + P0 + Value
  const data = Buffer.concat([
    dataIdBuf,
    applyOffset(operatorBuf),
    applyOffset(passwordBuf),
    valueWithOffset,
  ]);

  return buildFrame(address, CONTROL_CODES.WRITE_DATA, data);
};

/**
 * Build a RELAY CONTROL frame
 * Controls the meter's internal relay (trip/close)
 *
 * DLT645 relay control requires:
 * - AES-128 encrypted payload
 * - Timestamp for anti-replay protection
 * - Operator code and password
 *
 * @param {string} address - 12-digit meter address
 * @param {string} command - 'trip' or 'close'
 * @param {Buffer|string} aesKey - 16-byte AES key (or 32-char hex string)
 * @param {string} [operatorCode='00000000'] - 8-digit operator code
 * @param {string} [password='00000000'] - 8-digit password
 * @param {Date} [timestamp=new Date()] - Command timestamp
 * @returns {Buffer} Complete relay control frame
 * @throws {Error} If AES key is invalid or command is unknown
 */
export const buildRelayControlFrame = (
  address,
  command,
  aesKey,
  operatorCode = '00000000',
  password = '00000000',
  timestamp = new Date()
) => {
  // Validate command
  const commandCode =
    command.toLowerCase() === 'trip'
      ? RELAY_COMMANDS.TRIP
      : command.toLowerCase() === 'close'
        ? RELAY_COMMANDS.CLOSE
        : null;

  if (commandCode === null) {
    throw new Error(`Unknown relay command: ${command}. Use 'trip' or 'close'.`);
  }

  // Parse AES key
  let keyBuffer;
  if (Buffer.isBuffer(aesKey)) {
    keyBuffer = aesKey;
  } else if (typeof aesKey === 'string') {
    // Remove spaces and convert hex string to buffer
    const cleanKey = aesKey.replace(/\s/g, '');
    if (cleanKey.length !== 32) {
      throw new Error(`AES key must be 16 bytes (32 hex chars), got ${cleanKey.length} chars`);
    }
    keyBuffer = Buffer.from(cleanKey, 'hex');
  } else {
    throw new Error('AES key must be a Buffer or hex string');
  }

  if (keyBuffer.length !== 16) {
    throw new Error(`AES key must be 16 bytes, got ${keyBuffer.length}`);
  }

  // Build plaintext payload for encryption
  // Format: [Timestamp 6 bytes] [Operator 4 bytes] [Password 4 bytes] [Command 1 byte] [Padding]
  const plaintext = Buffer.alloc(16); // AES block size

  // Timestamp: YY MM DD HH mm ss (BCD)
  const ts = timestamp;
  plaintext[0] = parseInt(ts.getFullYear().toString().slice(-2), 10); // YY
  plaintext[1] = ts.getMonth() + 1; // MM (1-12)
  plaintext[2] = ts.getDate(); // DD
  plaintext[3] = ts.getHours(); // HH
  plaintext[4] = ts.getMinutes(); // mm
  plaintext[5] = ts.getSeconds(); // ss

  // Convert timestamp bytes to BCD
  for (let i = 0; i < 6; i++) {
    const val = plaintext[i];
    plaintext[i] = (Math.floor(val / 10) << 4) | (val % 10);
  }

  // Operator code (4 bytes)
  for (let i = 0; i < 4; i++) {
    plaintext[6 + i] = parseInt(operatorCode.substring(i * 2, i * 2 + 2), 16);
  }

  // Password (4 bytes)
  for (let i = 0; i < 4; i++) {
    plaintext[10 + i] = parseInt(password.substring(i * 2, i * 2 + 2), 16);
  }

  // Command code
  plaintext[14] = commandCode;

  // Padding (last byte)
  plaintext[15] = 0x00;

  // Encrypt with AES-128-ECB (no IV needed for ECB)
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuffer, null);
  cipher.setAutoPadding(false); // We handle padding ourselves
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // Build frame data: [DI 4 bytes] [Encrypted 16 bytes]
  // DI for relay control is typically 0x04000B01 or similar (vendor-specific)
  const relayControlDI = 0x04000b01;
  const dataIdBuf = dataIdToBuffer(relayControlDI);

  // Apply offset to encrypted data
  const encryptedWithOffset = applyOffset(encrypted);

  const data = Buffer.concat([dataIdBuf, encryptedWithOffset]);

  return buildFrame(address, CONTROL_CODES.RELAY_CONTROL, data);
};

/**
 * Build a simplified relay control frame (without encryption)
 * For meters that don't require encryption or for testing
 *
 * @param {string} address - 12-digit meter address
 * @param {string} command - 'trip' or 'close'
 * @returns {Buffer} Complete relay control frame
 */
export const buildSimpleRelayFrame = (address, command) => {
  const commandCode =
    command.toLowerCase() === 'trip'
      ? RELAY_COMMANDS.TRIP
      : command.toLowerCase() === 'close'
        ? RELAY_COMMANDS.CLOSE
        : null;

  if (commandCode === null) {
    throw new Error(`Unknown relay command: ${command}. Use 'trip' or 'close'.`);
  }

  // Simple format: just command byte with offset
  const data = Buffer.from([commandCode + 0x33]);

  return buildFrame(address, CONTROL_CODES.RELAY_CONTROL, data);
};

/**
 * Build a READ ADDRESS frame
 * Used to discover meter address on the bus
 * Uses broadcast address
 *
 * @returns {Buffer} Complete read address frame
 */
export const buildReadAddressFrame = () => {
  // Use broadcast address (all AAs)
  const address = 'AAAAAAAAAAAA';

  // No data payload for address read
  const data = Buffer.alloc(0);

  return buildFrame(address, CONTROL_CODES.READ_ADDRESS, data);
};

/**
 * Build a BROADCAST TIME frame
 * Synchronizes time across all meters
 *
 * @param {Date} [time=new Date()] - Time to broadcast
 * @returns {Buffer} Complete broadcast time frame
 */
export const buildBroadcastTimeFrame = (time = new Date()) => {
  // Broadcast address
  const address = BROADCAST_ADDRESS;

  // Time data: SS mm HH DD MM YY (6 bytes BCD, note reversed order)
  const data = Buffer.alloc(6);

  const seconds = time.getSeconds();
  const minutes = time.getMinutes();
  const hours = time.getHours();
  const day = time.getDate();
  const month = time.getMonth() + 1;
  const year = time.getFullYear() % 100;

  // Convert to BCD and apply offset
  data[0] = (((Math.floor(seconds / 10) << 4) | (seconds % 10)) + 0x33) & 0xff;
  data[1] = (((Math.floor(minutes / 10) << 4) | (minutes % 10)) + 0x33) & 0xff;
  data[2] = (((Math.floor(hours / 10) << 4) | (hours % 10)) + 0x33) & 0xff;
  data[3] = (((Math.floor(day / 10) << 4) | (day % 10)) + 0x33) & 0xff;
  data[4] = (((Math.floor(month / 10) << 4) | (month % 10)) + 0x33) & 0xff;
  data[5] = (((Math.floor(year / 10) << 4) | (year % 10)) + 0x33) & 0xff;

  return buildFrame(address, CONTROL_CODES.BROADCAST_TIME, data);
};

/**
 * Build multiple read frames for batch polling
 *
 * @param {string} address - 12-digit meter address
 * @param {number[]} dataIds - Array of Data Identifiers
 * @returns {Buffer[]} Array of read frames
 */
export const buildBatchReadFrames = (address, dataIds) => {
  return dataIds.map((dataId) => buildReadFrame(address, dataId));
};

/**
 * Build multiple read frames from register definitions
 *
 * @param {string} address - 12-digit meter address
 * @param {Object[]} registers - Array of register definitions
 * @returns {Buffer[]} Array of read frames
 */
export const buildBatchReadFramesFromRegisters = (address, registers) => {
  return registers.map((register) => buildReadFrameFromRegister(address, register));
};

/**
 * Frame analysis helper - returns human-readable breakdown
 *
 * @param {Buffer} frame - Built frame
 * @returns {Object} Frame breakdown
 */
export const describeFrame = (frame) => {
  if (frame.length < 12) {
    return { error: 'Frame too short', hex: bufferToHex(frame) };
  }

  const controlCode = frame[8];
  const dataLength = frame[9];
  const data = frame.subarray(10, 10 + dataLength);

  let controlName = 'Unknown';
  for (const [name, code] of Object.entries(CONTROL_CODES)) {
    if (code === controlCode) {
      controlName = name;
      break;
    }
  }

  return {
    hex: bufferToHex(frame),
    length: frame.length,
    address: bufferToHex(frame.subarray(1, 7)),
    controlCode: `0x${controlCode.toString(16).padStart(2, '0')} (${controlName})`,
    dataLength,
    data: bufferToHex(data),
    checksum: `0x${frame[frame.length - 2].toString(16).padStart(2, '0')}`,
  };
};

/**
 * Validate meter address format
 *
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid
 */
export const isValidAddress = (address) => {
  if (typeof address !== 'string') return false;
  const cleaned = address.replace(/[\s-]/g, '');
  return /^\d{12}$/.test(cleaned) || /^[Aa]{12}$/.test(cleaned);
};

export default {
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
};
