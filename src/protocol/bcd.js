/**
 * BCD (Binary Coded Decimal) Utilities for DLT645-2007 Protocol
 *
 * DLT645 Protocol BCD Rules:
 * 1. Each byte contains 2 decimal digits (0-9)
 * 2. Data bytes have +0x33 offset applied (anti-interference)
 * 3. Meter addresses are stored in reversed byte order
 * 4. Multi-byte values are typically little-endian
 *
 * @module protocol/bcd
 */

/**
 * DLT645 data offset constant
 * All data bytes in DLT645 frames have this offset added
 */
export const DLT645_OFFSET = 0x33;

/**
 * Convert a single byte to BCD (2 decimal digits)
 * @param {number} byte - Byte value (0-99 as decimal representation)
 * @returns {number} BCD encoded byte
 * @throws {Error} If value is out of range
 * @example
 * byteToBcd(12) // returns 0x12
 * byteToBcd(99) // returns 0x99
 */
export const byteToBcd = (byte) => {
  if (byte < 0 || byte > 99) {
    throw new Error(`BCD byte value out of range: ${byte}. Must be 0-99.`);
  }
  const tens = Math.floor(byte / 10);
  const ones = byte % 10;
  return (tens << 4) | ones;
};

/**
 * Convert a BCD byte to decimal
 * @param {number} bcd - BCD encoded byte
 * @returns {number} Decimal value (0-99)
 * @throws {Error} If BCD contains invalid digits
 * @example
 * bcdToByte(0x12) // returns 12
 * bcdToByte(0x99) // returns 99
 */
export const bcdToByte = (bcd) => {
  const tens = (bcd >> 4) & 0x0f;
  const ones = bcd & 0x0f;

  if (tens > 9 || ones > 9) {
    throw new Error(`Invalid BCD byte: 0x${bcd.toString(16)}. Digits must be 0-9.`);
  }

  return tens * 10 + ones;
};

/**
 * Convert a decimal number to BCD byte array
 * @param {number} value - Decimal value to convert
 * @param {number} byteLength - Number of bytes in output array
 * @param {boolean} [littleEndian=true] - Byte order (DLT645 uses little-endian)
 * @returns {Buffer} BCD encoded bytes
 * @example
 * decimalToBcd(123456, 4) // returns Buffer [0x56, 0x34, 0x12, 0x00] (LE)
 * decimalToBcd(1234.56, 4, true, 2) // with 2 decimal places
 */
export const decimalToBcd = (value, byteLength, littleEndian = true) => {
  if (value < 0) {
    throw new Error(`Cannot convert negative value to BCD: ${value}`);
  }

  const buffer = Buffer.alloc(byteLength);
  let remaining = Math.round(value); // Handle any floating point

  for (let i = 0; i < byteLength; i++) {
    const twoDigits = remaining % 100;
    buffer[littleEndian ? i : byteLength - 1 - i] = byteToBcd(twoDigits);
    remaining = Math.floor(remaining / 100);
  }

  return buffer;
};

/**
 * Convert BCD byte array to decimal number
 * @param {Buffer} buffer - BCD encoded bytes
 * @param {boolean} [littleEndian=true] - Byte order
 * @returns {number} Decimal value
 * @example
 * bcdToDecimal(Buffer.from([0x56, 0x34, 0x12, 0x00])) // returns 123456
 */
export const bcdToDecimal = (buffer, littleEndian = true) => {
  let result = 0;
  let multiplier = 1;

  for (let i = 0; i < buffer.length; i++) {
    const byteIndex = littleEndian ? i : buffer.length - 1 - i;
    const byteValue = bcdToByte(buffer[byteIndex]);
    result += byteValue * multiplier;
    multiplier *= 100;
  }

  return result;
};

/**
 * Convert decimal with fractional part to BCD
 * Used for values like energy (kWh), voltage, current
 * @param {number} value - Decimal value (e.g., 1234.56)
 * @param {number} byteLength - Number of bytes in output
 * @param {number} decimalPlaces - Number of decimal places to preserve
 * @param {boolean} [littleEndian=true] - Byte order
 * @returns {Buffer} BCD encoded bytes
 * @example
 * decimalToBcdWithPrecision(1234.56, 4, 2) // 123456 as BCD
 */
export const decimalToBcdWithPrecision = (
  value,
  byteLength,
  decimalPlaces,
  littleEndian = true
) => {
  const multiplier = Math.pow(10, decimalPlaces);
  const intValue = Math.round(value * multiplier);
  return decimalToBcd(intValue, byteLength, littleEndian);
};

/**
 * Convert BCD to decimal with fractional part
 * @param {Buffer} buffer - BCD encoded bytes
 * @param {number} decimalPlaces - Number of decimal places
 * @param {boolean} [littleEndian=true] - Byte order
 * @returns {number} Decimal value with fraction
 * @example
 * bcdToDecimalWithPrecision(Buffer.from([0x56, 0x34, 0x12, 0x00]), 2) // returns 1234.56
 */
export const bcdToDecimalWithPrecision = (buffer, decimalPlaces, littleEndian = true) => {
  const intValue = bcdToDecimal(buffer, littleEndian);
  const divisor = Math.pow(10, decimalPlaces);
  return intValue / divisor;
};

/**
 * Apply DLT645 +0x33 offset to data bytes
 * All data in DLT645 frames (except frame delimiters) has this offset
 * @param {Buffer} buffer - Raw data bytes
 * @returns {Buffer} Offset-applied bytes
 * @example
 * applyOffset(Buffer.from([0x00, 0x00, 0x00, 0x00])) // returns [0x33, 0x33, 0x33, 0x33]
 */
export const applyOffset = (buffer) => {
  const result = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    result[i] = (buffer[i] + DLT645_OFFSET) & 0xff;
  }
  return result;
};

/**
 * Remove DLT645 +0x33 offset from data bytes
 * @param {Buffer} buffer - Offset-applied bytes
 * @returns {Buffer} Raw data bytes
 * @example
 * removeOffset(Buffer.from([0x33, 0x33, 0x33, 0x33])) // returns [0x00, 0x00, 0x00, 0x00]
 */
export const removeOffset = (buffer) => {
  const result = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    // Handle underflow (wrap around)
    result[i] = (buffer[i] - DLT645_OFFSET + 256) & 0xff;
  }
  return result;
};

/**
 * Parse meter address string to BCD buffer (reversed order)
 * DLT645 stores addresses with least significant byte first
 * @param {string} address - 12-digit meter address string or broadcast address (AAAAAAAAAAAA)
 * @returns {Buffer} 6-byte BCD address in reversed order
 * @throws {Error} If address format is invalid
 * @example
 * addressToBuffer('000000001234') // returns Buffer [0x34, 0x12, 0x00, 0x00, 0x00, 0x00]
 * addressToBuffer('AAAAAAAAAAAA') // returns Buffer [0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]
 */
export const addressToBuffer = (address) => {
  // Remove any spaces or dashes
  const cleaned = address.replace(/[\s-]/g, '');

  // Handle broadcast address (all AAs)
  if (/^[Aa]{12}$/.test(cleaned)) {
    return Buffer.alloc(6, 0xaa);
  }

  if (!/^\d{12}$/.test(cleaned)) {
    throw new Error(`Invalid meter address: "${address}". Must be 12 digits.`);
  }

  const buffer = Buffer.alloc(6);

  // Parse 2 digits at a time, reversed order (A0 at position 5, A5 at position 0)
  for (let i = 0; i < 6; i++) {
    const digitPair = cleaned.substring(10 - i * 2, 12 - i * 2);
    buffer[i] = byteToBcd(parseInt(digitPair, 10));
  }

  return buffer;
};

/**
 * Convert BCD address buffer to string
 * @param {Buffer} buffer - 6-byte BCD address (reversed order)
 * @returns {string} 12-digit address string
 * @example
 * bufferToAddress(Buffer.from([0x34, 0x12, 0x00, 0x00, 0x00, 0x00])) // returns '000000001234'
 */
export const bufferToAddress = (buffer) => {
  if (buffer.length !== 6) {
    throw new Error(`Invalid address buffer length: ${buffer.length}. Must be 6 bytes.`);
  }

  let address = '';

  // Read in reversed order
  for (let i = 5; i >= 0; i--) {
    const value = bcdToByte(buffer[i]);
    address += value.toString().padStart(2, '0');
  }

  return address;
};

/**
 * Convert 4-byte Data Identifier to buffer with offset applied
 * DI format: DI3 DI2 DI1 DI0 (big-endian in spec, little-endian in frame)
 * @param {number} dataId - 32-bit data identifier
 * @returns {Buffer} 4-byte buffer with +0x33 offset, little-endian
 * @example
 * dataIdToBuffer(0x02010100) // VOLTAGE register
 */
export const dataIdToBuffer = (dataId) => {
  const buffer = Buffer.alloc(4);

  // Little-endian: DI0 first, DI3 last
  buffer[0] = dataId & 0xff; // DI0
  buffer[1] = (dataId >> 8) & 0xff; // DI1
  buffer[2] = (dataId >> 16) & 0xff; // DI2
  buffer[3] = (dataId >> 24) & 0xff; // DI3

  return applyOffset(buffer);
};

/**
 * Convert buffer to Data Identifier (removes offset)
 * @param {Buffer} buffer - 4-byte buffer with +0x33 offset
 * @returns {number} 32-bit data identifier
 * @example
 * bufferToDataId(Buffer.from([0x33, 0x34, 0x34, 0x35])) // 0x02010100 after offset removal
 */
export const bufferToDataId = (buffer) => {
  if (buffer.length !== 4) {
    throw new Error(`Invalid data ID buffer length: ${buffer.length}. Must be 4 bytes.`);
  }

  const raw = removeOffset(buffer);

  // Little-endian reconstruction
  return raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24);
};

/**
 * Format buffer as hex string for debugging
 * @param {Buffer} buffer - Any buffer
 * @param {string} [separator=' '] - Byte separator
 * @returns {string} Hex string representation
 * @example
 * bufferToHex(Buffer.from([0x68, 0x12, 0x34])) // returns '68 12 34'
 */
export const bufferToHex = (buffer, separator = ' ') => {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(separator);
};

/**
 * Parse hex string to buffer
 * @param {string} hex - Hex string (with or without separators)
 * @returns {Buffer} Parsed buffer
 * @example
 * hexToBuffer('68 12 34') // returns Buffer [0x68, 0x12, 0x34]
 * hexToBuffer('681234')   // also returns Buffer [0x68, 0x12, 0x34]
 */
export const hexToBuffer = (hex) => {
  const cleaned = hex.replace(/[\s-]/g, '');

  if (!/^[0-9A-Fa-f]*$/.test(cleaned)) {
    throw new Error(`Invalid hex string: "${hex}"`);
  }

  if (cleaned.length % 2 !== 0) {
    throw new Error(`Hex string must have even length: "${hex}"`);
  }

  const buffer = Buffer.alloc(cleaned.length / 2);

  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
  }

  return buffer;
};

/**
 * Handle signed BCD values (used for power readings that can be negative)
 * DLT645 uses MSB of the highest byte as sign bit for some registers
 * @param {Buffer} buffer - BCD encoded bytes
 * @param {boolean} [littleEndian=true] - Byte order
 * @returns {number} Signed decimal value
 */
export const bcdToSignedDecimal = (buffer, littleEndian = true) => {
  const highByteIndex = littleEndian ? buffer.length - 1 : 0;
  const isNegative = (buffer[highByteIndex] & 0x80) !== 0;

  // Clear sign bit for conversion
  const tempBuffer = Buffer.from(buffer);
  tempBuffer[highByteIndex] = tempBuffer[highByteIndex] & 0x7f;

  const value = bcdToDecimal(tempBuffer, littleEndian);
  return isNegative ? -value : value;
};

/**
 * Convert signed decimal to BCD
 * @param {number} value - Signed decimal value
 * @param {number} byteLength - Number of bytes
 * @param {boolean} [littleEndian=true] - Byte order
 * @returns {Buffer} BCD encoded bytes with sign bit
 */
export const signedDecimalToBcd = (value, byteLength, littleEndian = true) => {
  const isNegative = value < 0;
  const buffer = decimalToBcd(Math.abs(value), byteLength, littleEndian);

  if (isNegative) {
    const highByteIndex = littleEndian ? buffer.length - 1 : 0;
    buffer[highByteIndex] = buffer[highByteIndex] | 0x80;
  }

  return buffer;
};

export default {
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
};
