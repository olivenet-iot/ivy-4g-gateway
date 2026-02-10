/**
 * IVY EM114070 Packet Wrapper Parser
 *
 * Handles the IVY 8-byte proprietary header as well as raw (unwrapped)
 * DLMS APDUs that some meters send directly after the initial heartbeat.
 *
 * IVY Header structure (8 bytes):
 *   Bytes 0-1: Version   (uint16 BE, always 0x0001)
 *   Bytes 2-3: Source    (uint16 BE, meter address identifier)
 *   Bytes 4-5: Destination (uint16 BE, see IVY_DESTINATIONS)
 *   Bytes 6-7: Payload length (uint16 BE)
 *
 * @module protocol/ivy-wrapper
 */

import { parseDlmsValue, looksLikeCosemDateTime } from './dlms/data-types.js';

/**
 * IVY header length in bytes
 */
export const IVY_HEADER_LENGTH = 8;

/**
 * IVY protocol version
 */
export const IVY_VERSION = 0x0001;

/**
 * Known IVY destination values
 */
export const IVY_DESTINATIONS = {
  HEARTBEAT: 0x0001,
  DLMS_PUBLIC_CLIENT: 0x0001, // EM114070 DLMS endpoint (was 0x0010)
  DLMS_LEGACY: 0x0010,       // Keep for backward compat routing
};

/**
 * Maximum payload length to prevent memory exhaustion from corrupted headers
 */
const MAX_PAYLOAD_LENGTH = 4096;

/**
 * Known DLMS APDU tag bytes that can appear as raw (unwrapped) packets
 */
export const RAW_DLMS_TAGS = new Set([
  0xC2, // EventNotification-Request
  0x0F, // DataNotification
  0xC4, // GET.response
  0xC5, // SET.response
  0xC3, // ACTION.request
  0xC7, // ACTION.response
  0x61, // AARE (Association Response)
  0x63, // RLRE (Release Response)
  0xD8, // ExceptionResponse
  0x60, // AARQ (Association Request)
  0x62, // RLRQ (Release Request)
  0xC0, // GET.request
]);

/**
 * Check if a buffer starts with the IVY packet signature (version 0x0001)
 *
 * @param {Buffer} buffer - Buffer to check
 * @returns {boolean} True if buffer starts with IVY header signature
 */
export const isIvyPacket = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }
  return (
    buffer[0] === 0x00 &&
    buffer[1] === 0x01 &&
    buffer[2] === 0x00 &&
    buffer[3] === 0x01
  );
};

/**
 * Parse an IVY header from a buffer
 *
 * @param {Buffer} buffer - Buffer containing at least 8 bytes
 * @returns {Object} Parsed header { version, source, destination, payloadLength }
 * @throws {Error} If buffer is too short
 */
export const parseIvyHeader = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < IVY_HEADER_LENGTH) {
    throw new Error(`Buffer too short for IVY header: need ${IVY_HEADER_LENGTH}, got ${buffer ? buffer.length : 0}`);
  }

  return {
    version: buffer.readUInt16BE(0),
    source: buffer.readUInt16BE(2),
    destination: buffer.readUInt16BE(4),
    payloadLength: buffer.readUInt16BE(6),
  };
};

/**
 * Build an IVY header for outgoing packets
 *
 * @param {number} destination - Destination address (e.g., IVY_DESTINATIONS.DLMS_PUBLIC_CLIENT)
 * @param {number} payloadLength - Length of the payload that follows
 * @param {number} [source=0x0001] - Source address
 * @returns {Buffer} 8-byte IVY header
 */
export const buildIvyHeader = (destination, payloadLength, source = 0x0001) => {
  const header = Buffer.alloc(IVY_HEADER_LENGTH);
  header.writeUInt16BE(IVY_VERSION, 0);
  header.writeUInt16BE(source, 2);
  header.writeUInt16BE(destination, 4);
  header.writeUInt16BE(payloadLength, 6);
  return header;
};

/**
 * Wrap a payload buffer with an IVY header
 *
 * @param {number} destination - Destination address
 * @param {Buffer} payload - Payload to wrap
 * @param {number} [source=0x0001] - Source address
 * @returns {Buffer} Complete IVY packet (header + payload)
 */
export const wrapIvyPacket = (destination, payload, source = 0x0001) => {
  const header = buildIvyHeader(destination, payload.length, source);
  return Buffer.concat([header, payload]);
};

/**
 * Compute the total byte length of a BER-TLV encoded structure.
 * Used for AARE (0x61) and RLRE (0x63) APDUs.
 *
 * @param {Buffer} buffer - Buffer starting with BER-TLV tag
 * @returns {number} Total length or -1 if insufficient data
 */
const computeBerTlvLength = (buffer) => {
  if (buffer.length < 2) return -1;

  const lenByte = buffer[1];
  if (lenByte < 0x80) {
    // Short form: tag(1) + lengthByte(1) + content(lenByte)
    const total = 2 + lenByte;
    return buffer.length >= total ? total : -1;
  }

  // Long form
  const numLenBytes = lenByte & 0x7F;
  if (numLenBytes === 0 || numLenBytes > 4) return -1;
  if (buffer.length < 2 + numLenBytes) return -1;

  let contentLen = 0;
  for (let i = 0; i < numLenBytes; i++) {
    contentLen = (contentLen << 8) | buffer[2 + i];
  }

  const total = 1 + 1 + numLenBytes + contentLen;
  return buffer.length >= total ? total : -1;
};

/**
 * Walk an EventNotification body starting at a given offset.
 * Expects: classId(2) + OBIS(6-7) + attrIndex(1) + dlmsValue(variable)
 *
 * @param {Buffer} buffer - Full APDU buffer
 * @param {number} pos - Start offset (after tag and optional datetime)
 * @returns {number} Total bytes consumed from start of buffer, or -1
 */
const walkEventNotificationBody = (buffer, pos) => {
  // ClassId (2 bytes)
  if (pos + 2 > buffer.length) return -1;
  pos += 2;

  // OBIS code (optional 0x06 length prefix + 6 bytes)
  if (pos >= buffer.length) return -1;
  if (buffer[pos] === 0x06) pos += 1;
  if (pos + 6 > buffer.length) return -1;
  pos += 6;

  // Attribute index (1 byte)
  if (pos >= buffer.length) return -1;
  pos += 1;

  // Data value(s) — parse ALL consecutive DLMS values
  if (pos >= buffer.length) return -1;
  try {
    const dataResult = parseDlmsValue(buffer, pos);
    pos += dataResult.bytesConsumed;
  } catch {
    return -1;
  }

  // Continue parsing trailing DLMS values (event log data, etc.)
  // Skip tag 0 (NULL_DATA) as it conflicts with IVY header start byte 0x00
  while (pos < buffer.length && buffer[pos] >= 1 && buffer[pos] <= 27) {
    try {
      const extra = parseDlmsValue(buffer, pos);
      pos += extra.bytesConsumed;
    } catch { break; }
  }

  return pos;
};

/**
 * Check if a byte is a valid start of the next packet (IVY header or known DLMS tag)
 *
 * @param {number} byte - The byte to check
 * @returns {boolean} True if it could be a next-packet marker
 */
const isValidNextByte = (byte) => {
  return byte === 0x00 || RAW_DLMS_TAGS.has(byte);
};

/**
 * Compute byte length of an EventNotification APDU (0xC2)
 *
 * When both datetime and no-datetime interpretations succeed, disambiguate by
 * checking which boundary aligns with the buffer end or a valid next-packet marker.
 */
const computeEventNotificationLength = (buffer) => {
  if (buffer.length < 11) return -1; // minimum: tag + classId(2) + obis(6) + attr(1) + data(1)

  const pos = 1; // skip tag

  // Try without datetime first (always attempted)
  const withoutDt = walkEventNotificationBody(buffer, pos);

  // Check for optional COSEM datetime (need 12 bytes from pos to check reliably)
  let withDt = -1;
  if (buffer.length >= pos + 12 && looksLikeCosemDateTime(buffer, pos)) {
    withDt = walkEventNotificationBody(buffer, pos + 12);
  }

  // If only one interpretation succeeded, use it
  if (withDt !== -1 && withoutDt === -1) return withDt;
  if (withDt === -1 && withoutDt !== -1) return withoutDt;
  if (withDt === -1 && withoutDt === -1) return -1;

  // Both succeeded - disambiguate
  // Prefer the one that exactly matches buffer length
  if (withDt === buffer.length && withoutDt !== buffer.length) return withDt;
  if (withoutDt === buffer.length && withDt !== buffer.length) return withoutDt;

  // Prefer the one where the next byte is a valid packet start
  const dtNextValid = withDt < buffer.length && isValidNextByte(buffer[withDt]);
  const noDtNextValid = withoutDt < buffer.length && isValidNextByte(buffer[withoutDt]);
  if (dtNextValid && !noDtNextValid) return withDt;
  if (noDtNextValid && !dtNextValid) return withoutDt;

  // Default: prefer without datetime (simpler, less likely to be a false positive from heuristic)
  return withoutDt;
};

/**
 * Compute byte length of a DataNotification APDU (0x0F)
 */
const computeDataNotificationLength = (buffer) => {
  if (buffer.length < 7) return -1; // tag + invokeId(4) + dtLen(1) + min data(1)

  let pos = 1; // skip tag
  pos += 4; // invokeId (long-invoke-id-and-priority)

  // Datetime: length-prefixed octet-string
  if (pos >= buffer.length) return -1;
  const dtLen = buffer[pos];
  pos += 1;
  if (pos + dtLen > buffer.length) return -1;
  pos += dtLen;

  // Data value
  if (pos >= buffer.length) return -1;
  try {
    const dataResult = parseDlmsValue(buffer, pos);
    pos += dataResult.bytesConsumed;
  } catch {
    return -1;
  }

  return pos;
};

/**
 * Compute byte length of a response APDU (0xC4, 0xC5, 0xC7)
 * Only handles response-normal (type 0x01).
 */
const computeResponseLength = (buffer) => {
  if (buffer.length < 4) return -1; // tag + responseType + invokeId + min result

  const tag = buffer[0];
  const responseType = buffer[1];
  let pos = 3; // skip tag + responseType + invokeId

  // Only handle response-normal
  if (responseType !== 0x01) return -1;

  switch (tag) {
    case 0xC4: { // GET.response-normal
      if (pos >= buffer.length) return -1;
      const choice = buffer[pos++];
      if (choice === 0x00) {
        // Success: DLMS value follows
        if (pos >= buffer.length) return -1;
        try {
          const result = parseDlmsValue(buffer, pos);
          pos += result.bytesConsumed;
        } catch { return -1; }
      } else if (choice === 0x01) {
        // Data-access-result error: 1 byte
        if (pos >= buffer.length) return -1;
        pos += 1;
      } else {
        return -1;
      }
      break;
    }
    case 0xC5: // SET.response-normal: result byte
      if (pos >= buffer.length) return -1;
      pos += 1;
      break;
    case 0xC7: { // ACTION.response-normal: action-result byte + optional return-data
      if (pos >= buffer.length) return -1;
      const actionResult = buffer[pos];
      pos += 1;
      // If success (0), check for optional return-data
      if (actionResult === 0 && pos < buffer.length) {
        const returnDataPresent = buffer[pos];
        pos += 1;
        if (returnDataPresent !== 0x00 && pos < buffer.length) {
          try {
            const result = parseDlmsValue(buffer, pos);
            pos += result.bytesConsumed;
          } catch { return -1; }
        }
      }
      break;
    }
    default:
      return -1;
  }

  return pos;
};

/**
 * Compute the byte length of a raw DLMS APDU from the buffer.
 * Returns -1 if insufficient data to determine the length.
 *
 * @param {Buffer} buffer - Buffer starting with a DLMS APDU tag
 * @returns {number} Total byte length, or -1 if incomplete
 */
export const computeRawDlmsLength = (buffer) => {
  if (buffer.length < 1) return -1;

  switch (buffer[0]) {
    case 0x60: // AARQ
    case 0x61: // AARE
    case 0x62: // RLRQ
    case 0x63: // RLRE
      return computeBerTlvLength(buffer);
    case 0xD8: // ExceptionResponse - always 3 bytes
      return buffer.length >= 3 ? 3 : -1;
    case 0xC2: // EventNotification
      return computeEventNotificationLength(buffer);
    case 0x0F: // DataNotification
      return computeDataNotificationLength(buffer);
    case 0xC4: // GET.response
    case 0xC5: // SET.response
    case 0xC7: // ACTION.response
      return computeResponseLength(buffer);
    case 0xC0: // GET.request-normal: tag(1) + type(1) + invokeId(1) + classId(2) + OBIS(6) + attrId(1) + accessSelection(1) = 13
      return buffer.length >= 13 ? 13 : -1;
    case 0xC3: // ACTION.request-normal: tag(1) + type(1) + invokeId(1) + classId(2) + OBIS(6) + methodId(1) + noParams(1) = 13
      return buffer.length >= 13 ? 13 : -1;
    default:
      return -1;
  }
};

/**
 * Create a stateful IVY stream parser
 *
 * Accumulates incoming TCP data and emits complete packets.
 * Handles both IVY-wrapped packets and raw DLMS APDUs.
 * Each emitted packet includes the parsed header and the payload buffer.
 *
 * @param {Function} onPacket - Callback: (header, payload, raw) => void
 * @param {Function} [onError] - Callback: (error) => void
 * @returns {Object} Stream parser with push() and reset() methods
 */
export const createIvyStreamParser = (onPacket, onError = null) => {
  let buffer = Buffer.alloc(0);
  let packetCount = 0;

  const parser = {
    /**
     * Push new data into the parser
     * @param {Buffer} data - Incoming data chunk
     */
    push(data) {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length > 0) {
        // 1. Potential IVY packet (starts with 0x00)
        if (buffer[0] === 0x00) {
          // Need at least 4 bytes to confirm IVY signature
          if (buffer.length < 4) {
            break; // wait for more data
          }

          if (buffer[1] === 0x01 && buffer[2] === 0x00 && buffer[3] === 0x01) {
            // Confirmed IVY packet
            if (buffer.length < IVY_HEADER_LENGTH) {
              break; // wait for full header
            }

            let header;
            try {
              header = parseIvyHeader(buffer);
            } catch (err) {
              if (onError) onError(err);
              buffer = buffer.subarray(1);
              continue;
            }

            if (header.payloadLength > MAX_PAYLOAD_LENGTH) {
              if (onError) {
                onError(new Error(`IVY payload length too large: ${header.payloadLength}`));
              }
              buffer = buffer.subarray(1);
              continue;
            }

            const totalLength = IVY_HEADER_LENGTH + header.payloadLength;
            if (buffer.length < totalLength) {
              break; // wait for complete packet
            }

            const raw = Buffer.from(buffer.subarray(0, totalLength));
            const payload = Buffer.from(buffer.subarray(IVY_HEADER_LENGTH, totalLength));
            buffer = buffer.subarray(totalLength);

            packetCount++;
            try {
              onPacket(header, payload, raw);
            } catch (err) {
              if (onError) onError(err);
            }
            continue;
          }

          // Starts with 0x00 but not IVY signature - fall through to garbage handling
        }

        // 2. Raw DLMS APDU: starts with known DLMS tag
        if (RAW_DLMS_TAGS.has(buffer[0])) {
          const dlmsLength = computeRawDlmsLength(buffer);

          if (dlmsLength === -1) {
            // Possibly incomplete - guard against infinite buffering
            if (buffer.length > MAX_PAYLOAD_LENGTH) {
              if (onError) {
                onError(new Error(`Raw DLMS APDU too large or malformed, discarding byte 0x${buffer[0].toString(16)}`));
              }
              buffer = buffer.subarray(1);
              continue;
            }
            break; // wait for more data
          }

          const raw = Buffer.from(buffer.subarray(0, dlmsLength));
          buffer = buffer.subarray(dlmsLength);

          // Create synthetic header for raw DLMS
          const syntheticHeader = {
            version: IVY_VERSION,
            source: 0x0001,
            destination: IVY_DESTINATIONS.DLMS_PUBLIC_CLIENT,
            payloadLength: raw.length,
            isRawDlms: true,
          };

          packetCount++;
          try {
            onPacket(syntheticHeader, raw, raw);
          } catch (err) {
            if (onError) onError(err);
          }
          continue;
        }

        // 3. Unknown data: skip to next valid IVY or DLMS start
        const nextIvy = findIvyStart(buffer, 1);
        const nextDlms = findRawDlmsStart(buffer, 1);

        let nextValid = -1;
        if (nextIvy !== -1 && nextDlms !== -1) {
          nextValid = Math.min(nextIvy, nextDlms);
        } else if (nextIvy !== -1) {
          nextValid = nextIvy;
        } else if (nextDlms !== -1) {
          nextValid = nextDlms;
        }

        if (nextValid === -1) {
          if (onError) {
            const hexPreview = buffer.subarray(0, Math.min(32, buffer.length)).toString('hex');
            onError(new Error(`No IVY header or DLMS tag found, discarding ${buffer.length} bytes, hex: ${hexPreview}`));
          }
          buffer = Buffer.alloc(0);
          break;
        }

        // Skip garbage bytes to next valid start
        if (onError) {
          const skippedHex = buffer.subarray(0, Math.min(32, nextValid)).toString('hex');
          onError(new Error(`Skipping ${nextValid} bytes to next valid start, hex: ${skippedHex}`));
        }
        buffer = buffer.subarray(nextValid);
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
     * @returns {number}
     */
    getBufferLength() {
      return buffer.length;
    },

    /**
     * Get packet count
     * @returns {number}
     */
    getPacketCount() {
      return packetCount;
    },
  };

  return parser;
};

/**
 * Find the next potential IVY header start in a buffer.
 * Requires 4-byte signature match (00 01 00 01) to avoid false positives
 * from DLMS data containing 00 01 byte sequences.
 *
 * @param {Buffer} buffer - Buffer to search
 * @param {number} [startIndex=0] - Starting position
 * @returns {number} Index of potential IVY start, or -1
 */
const findIvyStart = (buffer, startIndex = 0) => {
  for (let i = startIndex; i <= buffer.length - 4; i++) {
    if (buffer[i] === 0x00 && buffer[i + 1] === 0x01 &&
        buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
      return i;
    }
  }
  return -1;
};

/**
 * Find the next known raw DLMS APDU tag in a buffer
 *
 * @param {Buffer} buffer - Buffer to search
 * @param {number} [startIndex=0] - Starting position
 * @returns {number} Index of DLMS tag, or -1
 */
const findRawDlmsStart = (buffer, startIndex = 0) => {
  for (let i = startIndex; i < buffer.length; i++) {
    if (RAW_DLMS_TAGS.has(buffer[i])) {
      return i;
    }
  }
  return -1;
};

export default {
  IVY_HEADER_LENGTH,
  IVY_VERSION,
  IVY_DESTINATIONS,
  RAW_DLMS_TAGS,
  isIvyPacket,
  parseIvyHeader,
  buildIvyHeader,
  wrapIvyPacket,
  createIvyStreamParser,
  computeRawDlmsLength,
};
