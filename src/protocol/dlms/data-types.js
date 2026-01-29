/**
 * DLMS/COSEM Data Type Parser
 *
 * Handles parsing of DLMS ASN.1-like encoded data values.
 * DLMS uses a tag-length-value encoding for data transport.
 *
 * Reference: DLMS UA Blue Book (IEC 62056-5-3)
 *
 * @module protocol/dlms/data-types
 */

/**
 * DLMS data type tags
 */
export const DLMS_DATA_TYPES = {
  NULL_DATA: 0,
  BOOLEAN: 3,
  BIT_STRING: 4,
  INT32: 5,
  UINT32: 6,
  OCTET_STRING: 9,
  VISIBLE_STRING: 10,
  UTF8_STRING: 12,
  INT8: 15,
  INT16: 16,
  UINT8: 17,
  UINT16: 18,
  INT64: 20,
  UINT64: 21,
  ENUM: 22,
  FLOAT32: 23,
  FLOAT64: 24,
  DATE_TIME: 25,
  DATE: 26,
  TIME: 27,
  ARRAY: 1,
  STRUCTURE: 2,
  COMPACT_ARRAY: 13,
};

/**
 * DLMS data type tag names (for debugging)
 */
const TYPE_NAMES = {};
for (const [name, tag] of Object.entries(DLMS_DATA_TYPES)) {
  TYPE_NAMES[tag] = name;
}

/**
 * Parse a single DLMS value from a buffer at the given offset
 *
 * Returns { value, bytesConsumed } so the caller can advance past this value.
 *
 * @param {Buffer} buffer - Buffer containing DLMS encoded data
 * @param {number} [offset=0] - Starting offset
 * @returns {{ value: any, type: number, typeName: string, bytesConsumed: number }}
 */
export const parseDlmsValue = (buffer, offset = 0) => {
  if (offset >= buffer.length) {
    throw new Error(`DLMS parse: offset ${offset} beyond buffer length ${buffer.length}`);
  }

  const tag = buffer[offset];
  const typeName = TYPE_NAMES[tag] || `UNKNOWN(${tag})`;
  let pos = offset + 1;

  switch (tag) {
    case DLMS_DATA_TYPES.NULL_DATA:
      return { value: null, type: tag, typeName, bytesConsumed: 1 };

    case DLMS_DATA_TYPES.BOOLEAN:
      return { value: buffer[pos] !== 0, type: tag, typeName, bytesConsumed: 2 };

    case DLMS_DATA_TYPES.INT8:
      return { value: buffer.readInt8(pos), type: tag, typeName, bytesConsumed: 2 };

    case DLMS_DATA_TYPES.UINT8:
      return { value: buffer.readUInt8(pos), type: tag, typeName, bytesConsumed: 2 };

    case DLMS_DATA_TYPES.INT16:
      return { value: buffer.readInt16BE(pos), type: tag, typeName, bytesConsumed: 3 };

    case DLMS_DATA_TYPES.UINT16:
      return { value: buffer.readUInt16BE(pos), type: tag, typeName, bytesConsumed: 3 };

    case DLMS_DATA_TYPES.INT32:
      return { value: buffer.readInt32BE(pos), type: tag, typeName, bytesConsumed: 5 };

    case DLMS_DATA_TYPES.UINT32:
      return { value: buffer.readUInt32BE(pos), type: tag, typeName, bytesConsumed: 5 };

    case DLMS_DATA_TYPES.INT64: {
      const val = buffer.readBigInt64BE(pos);
      return { value: Number(val), type: tag, typeName, bytesConsumed: 9 };
    }

    case DLMS_DATA_TYPES.UINT64: {
      const val = buffer.readBigUInt64BE(pos);
      return { value: Number(val), type: tag, typeName, bytesConsumed: 9 };
    }

    case DLMS_DATA_TYPES.FLOAT32:
      return { value: buffer.readFloatBE(pos), type: tag, typeName, bytesConsumed: 5 };

    case DLMS_DATA_TYPES.FLOAT64:
      return { value: buffer.readDoubleBE(pos), type: tag, typeName, bytesConsumed: 9 };

    case DLMS_DATA_TYPES.ENUM:
      return { value: buffer.readUInt8(pos), type: tag, typeName, bytesConsumed: 2 };

    case DLMS_DATA_TYPES.OCTET_STRING: {
      const len = buffer[pos];
      pos++;
      const octets = Buffer.from(buffer.subarray(pos, pos + len));
      return { value: octets, type: tag, typeName, bytesConsumed: 2 + len };
    }

    case DLMS_DATA_TYPES.VISIBLE_STRING: {
      const len = buffer[pos];
      pos++;
      const str = buffer.subarray(pos, pos + len).toString('ascii');
      return { value: str, type: tag, typeName, bytesConsumed: 2 + len };
    }

    case DLMS_DATA_TYPES.UTF8_STRING: {
      const len = buffer[pos];
      pos++;
      const str = buffer.subarray(pos, pos + len).toString('utf8');
      return { value: str, type: tag, typeName, bytesConsumed: 2 + len };
    }

    case DLMS_DATA_TYPES.BIT_STRING: {
      const bitCount = buffer[pos];
      pos++;
      const byteCount = Math.ceil(bitCount / 8);
      const bits = Buffer.from(buffer.subarray(pos, pos + byteCount));
      return { value: bits, type: tag, typeName, bytesConsumed: 2 + byteCount };
    }

    case DLMS_DATA_TYPES.DATE_TIME: {
      // COSEM date-time is always 12 bytes
      const dt = parseCosemDateTime(buffer, pos);
      return { value: dt, type: tag, typeName, bytesConsumed: 13 };
    }

    case DLMS_DATA_TYPES.DATE: {
      // COSEM date is 5 bytes: year(2) month(1) day(1) dow(1)
      const year = buffer.readUInt16BE(pos);
      const month = buffer[pos + 2];
      const day = buffer[pos + 3];
      const dow = buffer[pos + 4];
      return {
        value: { year, month, day, dayOfWeek: dow },
        type: tag,
        typeName,
        bytesConsumed: 6,
      };
    }

    case DLMS_DATA_TYPES.TIME: {
      // COSEM time is 4 bytes: hour(1) minute(1) second(1) hundredths(1)
      return {
        value: {
          hour: buffer[pos],
          minute: buffer[pos + 1],
          second: buffer[pos + 2],
          hundredths: buffer[pos + 3],
        },
        type: tag,
        typeName,
        bytesConsumed: 5,
      };
    }

    case DLMS_DATA_TYPES.ARRAY: {
      const count = buffer[pos];
      pos++;
      const elements = [];
      let totalConsumed = 2; // tag + count
      for (let i = 0; i < count; i++) {
        const elem = parseDlmsValue(buffer, offset + totalConsumed);
        elements.push(elem.value);
        totalConsumed += elem.bytesConsumed;
      }
      return { value: elements, type: tag, typeName, bytesConsumed: totalConsumed };
    }

    case DLMS_DATA_TYPES.STRUCTURE: {
      const count = buffer[pos];
      pos++;
      const fields = [];
      let totalConsumed = 2; // tag + count
      for (let i = 0; i < count; i++) {
        const field = parseDlmsValue(buffer, offset + totalConsumed);
        fields.push(field);
        totalConsumed += field.bytesConsumed;
      }
      return { value: fields, type: tag, typeName, bytesConsumed: totalConsumed };
    }

    default:
      throw new Error(`Unknown DLMS data type tag: 0x${tag.toString(16)} (${tag}) at offset ${offset}`);
  }
};

/**
 * Parse a COSEM date-time value (12 bytes)
 *
 * Structure:
 *   Bytes 0-1: Year (uint16 BE, 0xFFFF = not specified)
 *   Byte 2:    Month (1-12, 0xFF = not specified)
 *   Byte 3:    Day of month (1-31, 0xFF = not specified)
 *   Byte 4:    Day of week (1=Monday, 7=Sunday, 0xFF = not specified)
 *   Byte 5:    Hour (0-23, 0xFF = not specified)
 *   Byte 6:    Minute (0-59, 0xFF = not specified)
 *   Byte 7:    Second (0-59, 0xFF = not specified)
 *   Byte 8:    Hundredths (0-99, 0xFF = not specified)
 *   Byte 9:    Deviation high byte (int16 BE, minutes from UTC, 0x8000 = not specified)
 *   Byte 10:   Deviation low byte
 *   Byte 11:   Clock status (bit flags)
 *
 * @param {Buffer} buffer - Buffer containing datetime
 * @param {number} [offset=0] - Starting offset
 * @returns {Object} Parsed datetime
 */
export const parseCosemDateTime = (buffer, offset = 0) => {
  if (buffer.length < offset + 12) {
    throw new Error(`Buffer too short for COSEM datetime: need ${offset + 12}, got ${buffer.length}`);
  }

  const year = buffer.readUInt16BE(offset);
  const month = buffer[offset + 2];
  const day = buffer[offset + 3];
  const dayOfWeek = buffer[offset + 4];
  const hour = buffer[offset + 5];
  const minute = buffer[offset + 6];
  const second = buffer[offset + 7];
  const hundredths = buffer[offset + 8];
  const deviation = buffer.readInt16BE(offset + 9);
  const clockStatus = buffer[offset + 11];

  const result = {
    year: year === 0xFFFF ? null : year,
    month: month === 0xFF ? null : month,
    day: day === 0xFF ? null : day,
    dayOfWeek: dayOfWeek === 0xFF ? null : dayOfWeek,
    hour: hour === 0xFF ? null : hour,
    minute: minute === 0xFF ? null : minute,
    second: second === 0xFF ? null : second,
    hundredths: hundredths === 0xFF ? null : hundredths,
    deviation: deviation === -0x8000 ? null : deviation,
    clockStatus,
  };

  // Build ISO string if we have enough fields
  if (result.year !== null && result.month !== null && result.day !== null) {
    try {
      const pad = (n) => String(n).padStart(2, '0');
      let iso = `${result.year}-${pad(result.month)}-${pad(result.day)}`;
      if (result.hour !== null) {
        iso += `T${pad(result.hour)}:${pad(result.minute || 0)}:${pad(result.second || 0)}`;
      }
      result.iso = iso;
    } catch {
      result.iso = null;
    }
  } else {
    result.iso = null;
  }

  return result;
};

/**
 * Parse an OBIS code from 6 bytes
 *
 * OBIS format: A-B:C.D.E.F
 * Where each letter is a single byte value.
 *
 * @param {Buffer} buffer - Buffer containing 6-byte OBIS code
 * @param {number} [offset=0] - Starting offset
 * @returns {string} OBIS code string in "A-B:C.D.E.F" format
 */
export const parseObisCode = (buffer, offset = 0) => {
  if (buffer.length < offset + 6) {
    throw new Error(`Buffer too short for OBIS code: need ${offset + 6}, got ${buffer.length}`);
  }

  const a = buffer[offset];
  const b = buffer[offset + 1];
  const c = buffer[offset + 2];
  const d = buffer[offset + 3];
  const e = buffer[offset + 4];
  const f = buffer[offset + 5];

  return `${a}-${b}:${c}.${d}.${e}.${f}`;
};

/**
 * Check if a buffer contains a COSEM date-time at the given offset
 * by looking for reasonable values (non-0xFF for key fields)
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {boolean}
 */
export const looksLikeCosemDateTime = (buffer, offset = 0) => {
  if (buffer.length < offset + 12) return false;
  const year = buffer.readUInt16BE(offset);
  const month = buffer[offset + 2];
  const hour = buffer[offset + 5];
  // Year should be reasonable (2000-2099) or 0xFFFF
  if (year !== 0xFFFF && (year < 2000 || year > 2099)) return false;
  // Month 1-12 or 0xFF
  if (month !== 0xFF && (month < 1 || month > 12)) return false;
  // Hour 0-23 or 0xFF
  if (hour !== 0xFF && hour > 23) return false;
  return true;
};

export default {
  DLMS_DATA_TYPES,
  parseDlmsValue,
  parseCosemDateTime,
  parseObisCode,
  looksLikeCosemDateTime,
};
