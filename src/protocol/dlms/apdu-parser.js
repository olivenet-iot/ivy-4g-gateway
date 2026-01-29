/**
 * DLMS/COSEM APDU Parser
 *
 * Parses DLMS Application Protocol Data Units (APDUs) received from meters.
 * Supports EventNotification, DataNotification, and GET.response APDUs.
 *
 * DLMS APDU tags:
 *   0xC2 = EventNotification-Request
 *   0x0F = DataNotification (data-notification)
 *   0xC4 = GET.response (get-response-normal)
 *   0x61 = AARE (association response)
 *   0x63 = RLRE (release response)
 *
 * @module protocol/dlms/apdu-parser
 */

import { parseDlmsValue, parseCosemDateTime, parseObisCode, looksLikeCosemDateTime } from './data-types.js';
import { lookupObis } from './obis-registry.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ module: 'dlms-apdu-parser' });

/**
 * APDU tag values
 */
export const APDU_TAGS = {
  EVENT_NOTIFICATION: 0xC2,
  DATA_NOTIFICATION: 0x0F,
  GET_REQUEST: 0xC0,
  GET_RESPONSE: 0xC4,
  SET_RESPONSE: 0xC5,
  ACTION_RESPONSE: 0xC7,
  AARQ: 0x60,
  AARE: 0x61,
  RLRQ: 0x62,
  RLRE: 0x63,
  EXCEPTION_RESPONSE: 0xD8,
};

/**
 * APDU tag names for logging
 */
const APDU_TAG_NAMES = {
  [APDU_TAGS.EVENT_NOTIFICATION]: 'EventNotification',
  [APDU_TAGS.DATA_NOTIFICATION]: 'DataNotification',
  [APDU_TAGS.GET_REQUEST]: 'GET.request',
  [APDU_TAGS.GET_RESPONSE]: 'GET.response',
  [APDU_TAGS.SET_RESPONSE]: 'SET.response',
  [APDU_TAGS.ACTION_RESPONSE]: 'ACTION.response',
  [APDU_TAGS.AARQ]: 'AARQ',
  [APDU_TAGS.AARE]: 'AARE',
  [APDU_TAGS.RLRQ]: 'RLRQ',
  [APDU_TAGS.RLRE]: 'RLRE',
  [APDU_TAGS.EXCEPTION_RESPONSE]: 'ExceptionResponse',
};

/**
 * DLMS data-access-result error names (IEC 62056-5-3 Table 12)
 */
export const DATA_ACCESS_RESULT_NAMES = {
  0: 'success',
  1: 'hardware-fault',
  2: 'temporary-failure',
  3: 'read-write-denied',
  4: 'object-undefined',
  5: 'object-class-inconsistent',
  6: 'object-unavailable',
  7: 'type-unmatched',
  8: 'scope-of-access-violated',
  9: 'data-block-unavailable',
  10: 'long-get-aborted',
  11: 'no-long-get-in-progress',
  12: 'long-set-aborted',
  13: 'no-long-set-in-progress',
};

/**
 * Parse a DLMS APDU and dispatch to the appropriate handler
 *
 * @param {Buffer} buffer - APDU buffer (starts with tag byte)
 * @returns {Object} Parsed APDU with type, tag, and type-specific fields
 */
export const parseApdu = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) {
    throw new Error('Empty or invalid APDU buffer');
  }

  const tag = buffer[0];
  const tagName = APDU_TAG_NAMES[tag] || `Unknown(0x${tag.toString(16)})`;

  switch (tag) {
    case APDU_TAGS.EVENT_NOTIFICATION:
      return parseEventNotification(buffer);

    case APDU_TAGS.DATA_NOTIFICATION:
      return parseDataNotification(buffer);

    case APDU_TAGS.GET_RESPONSE:
      return parseGetResponse(buffer);

    case APDU_TAGS.AARQ:
      return { type: 'aarq', tag, tagName, raw: buffer };

    case APDU_TAGS.AARE:
      return parseAare(buffer);

    case APDU_TAGS.RLRQ:
      return { type: 'rlrq', tag, tagName, raw: buffer };

    case APDU_TAGS.RLRE:
      return { type: 'rlre', tag, tagName, raw: buffer };

    case APDU_TAGS.GET_REQUEST:
      return { type: 'get-request', tag, tagName, raw: buffer };

    case APDU_TAGS.EXCEPTION_RESPONSE:
      return parseExceptionResponse(buffer);

    default:
      logger.debug('Unhandled APDU tag', { tag: `0x${tag.toString(16)}`, tagName, length: buffer.length });
      return {
        type: 'unknown',
        tag,
        tagName,
        raw: buffer,
      };
  }
};

/**
 * Parse EventNotification-Request APDU (tag 0xC2)
 *
 * Structure:
 *   [0xC2] [body...]
 *   Body contains:
 *     - Optional timestamp (COSEM date-time, 12 bytes)
 *     - Class ID (uint16 BE)
 *     - OBIS code (6 bytes)
 *     - Attribute index (int8)
 *     - Data (DLMS value)
 *
 * The exact structure varies by implementation. We use heuristics to detect
 * timestamp presence and locate the OBIS code.
 *
 * @param {Buffer} buffer - APDU starting with 0xC2
 * @returns {Object} Parsed event notification
 */
export const parseEventNotification = (buffer) => {
  const result = {
    type: 'event-notification',
    tag: APDU_TAGS.EVENT_NOTIFICATION,
    tagName: 'EventNotification',
    timestamp: null,
    classId: null,
    obisCode: null,
    obisInfo: null,
    attributeIndex: null,
    data: null,
    raw: buffer,
  };

  try {
    let pos = 1; // skip tag byte

    // Check for optional date-time
    // EventNotification may have time as first element
    if (buffer.length > pos + 12 && looksLikeCosemDateTime(buffer, pos)) {
      result.timestamp = parseCosemDateTime(buffer, pos);
      pos += 12;
    }

    // Class ID (2 bytes)
    if (buffer.length >= pos + 2) {
      result.classId = buffer.readUInt16BE(pos);
      pos += 2;
    }

    // OBIS code (6 bytes as octet-string: length byte + 6 bytes, or raw 6 bytes)
    if (buffer.length >= pos + 6) {
      // Check if next byte is 0x06 (length prefix for 6-byte OBIS)
      if (buffer[pos] === 0x06) {
        pos += 1;
      }
      if (buffer.length >= pos + 6) {
        result.obisCode = parseObisCode(buffer, pos);
        result.obisInfo = lookupObis(result.obisCode);
        pos += 6;
      }
    }

    // Attribute index (1 byte)
    if (buffer.length > pos) {
      result.attributeIndex = buffer[pos];
      pos += 1;
    }

    // Data value(s) — parse first, then consume trailing DLMS values (event log entries, etc.)
    if (buffer.length > pos) {
      try {
        const firstData = parseDlmsValue(buffer, pos);
        pos += firstData.bytesConsumed;

        // Parse additional trailing DLMS values (tags 1-27; skip 0/NULL_DATA to avoid IVY header ambiguity)
        const additionalData = [];
        while (pos < buffer.length && buffer[pos] >= 1 && buffer[pos] <= 27) {
          try {
            const extra = parseDlmsValue(buffer, pos);
            additionalData.push(extra);
            pos += extra.bytesConsumed;
          } catch { break; }
        }

        if (additionalData.length > 0) {
          result.data = {
            type: 2,
            typeName: 'STRUCTURE',
            value: [firstData, ...additionalData],
            bytesConsumed: firstData.bytesConsumed + additionalData.reduce((s, d) => s + d.bytesConsumed, 0),
          };
        } else {
          result.data = firstData;
        }
      } catch (err) {
        logger.debug('Failed to parse EventNotification data value', { error: err.message });
        result.data = { raw: buffer.subarray(pos) };
      }
    }
  } catch (err) {
    logger.warn('EventNotification parse error', { error: err.message, hex: buffer.toString('hex') });
    result.parseError = err.message;
  }

  return result;
};

/**
 * Parse DataNotification APDU (tag 0x0F)
 *
 * Structure:
 *   [0x0F] [long-invoke-id: 4 bytes] [date-time: variable] [notification-body: DLMS data]
 *
 * @param {Buffer} buffer - APDU starting with 0x0F
 * @returns {Object} Parsed data notification
 */
export const parseDataNotification = (buffer) => {
  const result = {
    type: 'data-notification',
    tag: APDU_TAGS.DATA_NOTIFICATION,
    tagName: 'DataNotification',
    invokeId: null,
    timestamp: null,
    data: null,
    raw: buffer,
  };

  try {
    let pos = 1; // skip tag

    // Long invoke ID and priority (4 bytes)
    if (buffer.length >= pos + 4) {
      result.invokeId = buffer.readUInt32BE(pos);
      pos += 4;
    }

    // Date-time: octet-string with length prefix
    if (buffer.length > pos) {
      const dtLen = buffer[pos];
      pos += 1;

      if (dtLen === 12 && buffer.length >= pos + 12) {
        result.timestamp = parseCosemDateTime(buffer, pos);
        pos += 12;
      } else if (dtLen === 0) {
        // No datetime
      } else {
        // Skip unknown datetime format
        pos += dtLen;
      }
    }

    // Notification body - DLMS encoded data
    if (buffer.length > pos) {
      try {
        result.data = parseDlmsValue(buffer, pos);
      } catch (err) {
        logger.debug('Failed to parse DataNotification body', { error: err.message });
        result.data = { raw: buffer.subarray(pos) };
      }
    }
  } catch (err) {
    logger.warn('DataNotification parse error', { error: err.message });
    result.parseError = err.message;
  }

  return result;
};

/**
 * Parse GET.response APDU (tag 0xC4)
 *
 * Structure:
 *   [0xC4] [response-type: 1 byte] [invoke-id: 1 byte] [result...]
 *
 * response-type:
 *   0x01 = get-response-normal
 *   0x02 = get-response-with-datablock
 *   0x03 = get-response-with-list
 *
 * @param {Buffer} buffer - APDU starting with 0xC4
 * @returns {Object} Parsed GET response
 */
export const parseGetResponse = (buffer) => {
  const result = {
    type: 'get-response',
    tag: APDU_TAGS.GET_RESPONSE,
    tagName: 'GET.response',
    responseType: null,
    invokeId: null,
    accessResult: null,
    data: null,
    raw: buffer,
  };

  try {
    let pos = 1; // skip tag

    // Response type
    if (buffer.length > pos) {
      result.responseType = buffer[pos];
      pos += 1;
    }

    // Invoke ID and priority
    if (buffer.length > pos) {
      result.invokeId = buffer[pos];
      pos += 1;
    }

    if (result.responseType === 0x01) {
      // get-response-normal: choice [0] = data, [1] = data-access-result
      if (buffer.length > pos) {
        const choice = buffer[pos];
        pos += 1;

        if (choice === 0x00) {
          // Success - data follows
          result.accessResult = 'success';
          if (buffer.length > pos) {
            try {
              result.data = parseDlmsValue(buffer, pos);
            } catch (err) {
              logger.debug('Failed to parse GET.response data', { error: err.message });
              result.data = { raw: buffer.subarray(pos) };
            }
          }
        } else if (choice === 0x01) {
          // Error - data-access-result enum follows
          result.accessResult = 'error';
          if (buffer.length > pos) {
            const errorCode = buffer[pos];
            const errorName = DATA_ACCESS_RESULT_NAMES[errorCode] || `unknown(${errorCode})`;
            result.data = { errorCode, errorName };
            logger.warn('GET.response data-access-result error', {
              invokeId: result.invokeId,
              errorCode,
              errorName,
              hex: buffer.toString('hex'),
            });
          }
        }
      }
    }
  } catch (err) {
    logger.warn('GET.response parse error', { error: err.message });
    result.parseError = err.message;
  }

  return result;
};

/**
 * Parse AARE (Association Response) APDU (tag 0x61)
 *
 * @param {Buffer} buffer - APDU starting with 0x61
 * @returns {Object} Parsed AARE
 */
export const parseAare = (buffer) => {
  const result = {
    type: 'aare',
    tag: APDU_TAGS.AARE,
    tagName: 'AARE',
    accepted: false,
    raw: buffer,
  };

  try {
    // AARE is BER-TLV encoded. Basic extraction:
    // After tag and length, look for result field (tag 0xA2)
    // Result source diagnostic contains acceptance info
    // For now, do a simple scan for the association-result value
    // association-result: 0 = accepted, 1 = rejected-permanent, 2 = rejected-transient
    for (let i = 2; i < buffer.length - 2; i++) {
      // Look for context tag [2] (result) followed by integer
      if (buffer[i] === 0xA2) {
        const len = buffer[i + 1];
        if (len >= 3 && i + 2 + len <= buffer.length) {
          // Inside should be INTEGER with the result value
          if (buffer[i + 2] === 0x02 && buffer[i + 3] >= 1) {
            const associationResult = buffer[i + 4];
            result.associationResult = associationResult;
            result.accepted = associationResult === 0;
            break;
          }
        }
      }
    }
  } catch (err) {
    logger.warn('AARE parse error', { error: err.message });
    result.parseError = err.message;
  }

  return result;
};

/**
 * Parse ExceptionResponse APDU (tag 0xD8)
 *
 * @param {Buffer} buffer
 * @returns {Object}
 */
export const parseExceptionResponse = (buffer) => {
  const result = {
    type: 'exception-response',
    tag: APDU_TAGS.EXCEPTION_RESPONSE,
    tagName: 'ExceptionResponse',
    stateError: null,
    serviceError: null,
    raw: buffer,
  };

  if (buffer.length >= 3) {
    result.stateError = buffer[1];
    result.serviceError = buffer[2];
  }

  return result;
};

/**
 * Extract telemetry-relevant data from a parsed APDU
 * Converts DLMS data into the format expected by the gateway publisher
 *
 * @param {Object} parsedApdu - Result from parseApdu()
 * @returns {Object|null} Telemetry data or null if not telemetry-relevant
 */
export const extractTelemetry = (parsedApdu) => {
  if (!parsedApdu) return null;

  if (parsedApdu.type === 'event-notification') {
    return extractEventNotificationTelemetry(parsedApdu);
  }

  if (parsedApdu.type === 'data-notification') {
    return extractDataNotificationTelemetry(parsedApdu);
  }

  if (parsedApdu.type === 'get-response' && parsedApdu.accessResult === 'success') {
    return {
      source: 'dlms',
      type: 'get-response',
      data: parsedApdu.data,
    };
  }

  return null;
};

/**
 * Extract telemetry from EventNotification
 * @private
 */
const extractEventNotificationTelemetry = (parsed) => {
  const result = {
    source: 'dlms',
    type: 'event-notification',
    obisCode: parsed.obisCode,
    obisInfo: parsed.obisInfo,
    classId: parsed.classId,
    timestamp: parsed.timestamp?.iso || null,
    readings: {},
  };

  if (parsed.obisInfo && parsed.data) {
    const value = parsed.data.value !== undefined ? parsed.data.value : parsed.data;
    result.readings[parsed.obisInfo.key] = {
      value,
      unit: parsed.obisInfo.unit,
      obis: parsed.obisCode,
    };
  }

  return result;
};

/**
 * Extract telemetry from DataNotification
 * @private
 */
const extractDataNotificationTelemetry = (parsed) => {
  const result = {
    source: 'dlms',
    type: 'data-notification',
    invokeId: parsed.invokeId,
    timestamp: parsed.timestamp?.iso || null,
    readings: {},
    data: parsed.data,
  };

  // If data is a structure or array, try to extract individual values
  if (parsed.data && parsed.data.typeName === 'STRUCTURE' && Array.isArray(parsed.data.value)) {
    for (const field of parsed.data.value) {
      if (field && field.value !== undefined) {
        result.readings[field.typeName || 'value'] = field.value;
      }
    }
  }

  return result;
};

export default {
  APDU_TAGS,
  DATA_ACCESS_RESULT_NAMES,
  parseApdu,
  parseEventNotification,
  parseDataNotification,
  parseGetResponse,
  parseAare,
  parseExceptionResponse,
  extractTelemetry,
};
