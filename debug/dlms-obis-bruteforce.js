#!/usr/bin/env node
/**
 * DLMS OBIS Brute-Force Scanner
 *
 * Comprehensive OBIS code brute-force scanner for the IVY EM114070 meter.
 * Systematically probes OBIS code ranges to discover all supported registers.
 *
 * Phase 1 - Quick Scan (~114 probes):
 *   Priority C values with D=7,8 and E=0,255, plus special system codes.
 *
 * Phase 2 - Extended Scan (adaptive):
 *   For each successful C from Phase 1, scan nearby C values with D=0..8,
 *   E=0,1,2,3,255, and alternative classIds.
 *
 * Features:
 *   - Session management (AARQ every N probes)
 *   - Group exhaustion (skip after consecutive failures)
 *   - Resume from saved results (--resume)
 *   - Filter by C group (--group=N)
 *   - Incremental JSON save
 *   - Graceful Ctrl+C with partial results
 *
 * Usage:
 *   sudo systemctl stop ivy-gateway
 *   node debug/dlms-obis-bruteforce.js           # Full scan
 *   node debug/dlms-obis-bruteforce.js --group=32 # Only C=32
 *   node debug/dlms-obis-bruteforce.js --resume   # Resume from saved results
 *   node debug/dlms-obis-bruteforce.js --help     # Show usage
 *
 * No imports from src/ — fully standalone using only Node.js built-ins.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────

const TCP_PORT = 8899;
const PROBE_TIMEOUT_MS = 2000;       // 2s per probe (faster than original 5s)
const PROBE_DELAY_MS = 100;          // 100ms between probes
const SESSION_DELAY_MS = 2000;       // 2s between sessions
const MAX_PROBES_PER_SESSION = 50;   // Re-AARQ every 50 probes
const GROUP_EXHAUST_THRESHOLD = 5;   // Skip C group after 5 consecutive failures
const RESULTS_DIR = 'debug';

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const helpArg = args.includes('--help') || args.includes('-h');
const resumeArg = args.includes('--resume');
const groupArg = args.find(a => a.startsWith('--group='));
const filterGroup = groupArg ? parseInt(groupArg.split('=')[1], 10) : null;

if (helpArg) {
  console.log(`
DLMS OBIS Brute-Force Scanner
==============================

Usage:
  node debug/dlms-obis-bruteforce.js [options]

Options:
  --help, -h     Show this help message
  --resume       Resume from the most recent saved results file
  --group=N      Only scan C group N (e.g., --group=32 for voltage L1)

Examples:
  node debug/dlms-obis-bruteforce.js           # Full scan (Phase 1 + Phase 2)
  node debug/dlms-obis-bruteforce.js --group=1 # Only scan C=1 group
  node debug/dlms-obis-bruteforce.js --resume  # Resume interrupted scan

The scanner runs in two phases:
  Phase 1: Quick scan of priority OBIS codes (~114 probes)
  Phase 2: Extended scan around successful C values from Phase 1

Results are saved incrementally to debug/obis-scan-results-{date}.json.
Press Ctrl+C at any time to save partial results and exit.

Prerequisites:
  sudo systemctl stop ivy-gateway   # Free port 8899
`);
  process.exit(0);
}

// ─── Heartbeat Constants ────────────────────────────────────────────────────

const HEARTBEAT_PACKET_LENGTH = 26;
const HEARTBEAT_HEADER = Buffer.from([
  0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c,
]);
const HEARTBEAT_ADDRESS_OFFSET = 11;
const HEARTBEAT_ADDRESS_LENGTH = 12;

// ─── IVY Header Constants ───────────────────────────────────────────────────

const IVY_VERSION = 0x0001;
const IVY_HEADER_LENGTH = 8;
const IVY_DESTINATION = 0x0001;

// ─── DLMS Constants ─────────────────────────────────────────────────────────

const APDU_TAGS = {
  AARQ: 0x60,
  AARE: 0x61,
  RLRQ: 0x62,
  RLRE: 0x63,
  GET_REQUEST: 0xC0,
  GET_RESPONSE: 0xC4,
  EVENT_NOTIFICATION: 0xC2,
  DATA_NOTIFICATION: 0x0F,
  EXCEPTION_RESPONSE: 0xD8,
};

const APDU_TAG_NAMES = {
  [APDU_TAGS.AARQ]: 'AARQ',
  [APDU_TAGS.AARE]: 'AARE',
  [APDU_TAGS.RLRQ]: 'RLRQ',
  [APDU_TAGS.RLRE]: 'RLRE',
  [APDU_TAGS.GET_REQUEST]: 'GET.request',
  [APDU_TAGS.GET_RESPONSE]: 'GET.response',
  [APDU_TAGS.EVENT_NOTIFICATION]: 'EventNotification',
  [APDU_TAGS.DATA_NOTIFICATION]: 'DataNotification',
  [APDU_TAGS.EXCEPTION_RESPONSE]: 'ExceptionResponse',
};

const DATA_ACCESS_RESULT_NAMES = {
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
};

const APPLICATION_CONTEXT = {
  LN_NO_CIPHER: Buffer.from([0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x01]),
  SN_NO_CIPHER: Buffer.from([0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x02]),
};

// ─── DLMS Data Type Tags ────────────────────────────────────────────────────

const DLMS_DATA_TYPES = {
  NULL_DATA: 0,
  ARRAY: 1,
  STRUCTURE: 2,
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
};

const TYPE_NAMES = {};
for (const [name, tag] of Object.entries(DLMS_DATA_TYPES)) {
  TYPE_NAMES[tag] = name;
}

// ─── State ──────────────────────────────────────────────────────────────────

let meterAddress = null;
let activeSocket = null;
let disconnected = false;
let allResults = [];
let resultsFile = null;

// ─── Utility ────────────────────────────────────────────────────────────────

function hexDump(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Heartbeat Detection ────────────────────────────────────────────────────

function isHeartbeat(data) {
  if (data.length < HEARTBEAT_PACKET_LENGTH) return false;
  return data.subarray(0, HEARTBEAT_HEADER.length).equals(HEARTBEAT_HEADER);
}

function parseHeartbeat(data) {
  const addrBuf = data.subarray(
    HEARTBEAT_ADDRESS_OFFSET,
    HEARTBEAT_ADDRESS_OFFSET + HEARTBEAT_ADDRESS_LENGTH
  );
  return addrBuf.toString('ascii');
}

// ─── IVY Packet Building ────────────────────────────────────────────────────

function buildIvyHeader(destination, payloadLength) {
  const header = Buffer.alloc(IVY_HEADER_LENGTH);
  header.writeUInt16BE(IVY_VERSION, 0);
  header.writeUInt16BE(0x0001, 2);
  header.writeUInt16BE(destination, 4);
  header.writeUInt16BE(payloadLength, 6);
  return header;
}

function wrapWithIvy(destination, payload) {
  const header = buildIvyHeader(destination, payload.length);
  return Buffer.concat([header, payload]);
}

// ─── IVY Packet Parsing ─────────────────────────────────────────────────────

function isIvyPacket(data) {
  if (data.length < 4) return false;
  return data[0] === 0x00 && data[1] === 0x01 &&
         data[2] === 0x00 && data[3] === 0x01;
}

function extractDlmsPayload(data) {
  if (isIvyPacket(data) && data.length >= IVY_HEADER_LENGTH) {
    const payloadLen = data.readUInt16BE(6);
    if (data.length >= IVY_HEADER_LENGTH + payloadLen && payloadLen > 0) {
      const payload = data.subarray(IVY_HEADER_LENGTH, IVY_HEADER_LENGTH + payloadLen);
      return { payload, tag: payload[0] };
    }
  }

  const knownTags = new Set([
    0x60, 0x61, 0x62, 0x63, 0xC0, 0xC2, 0xC4, 0xC5, 0xC7, 0x0F, 0xD8,
  ]);
  if (data.length > 0 && knownTags.has(data[0])) {
    return { payload: data, tag: data[0] };
  }

  return null;
}

// ─── OBIS Code Parsing ──────────────────────────────────────────────────────

function obisToBytes(obisCode) {
  const match = obisCode.match(/^(\d+)-(\d+):(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid OBIS code format: ${obisCode}`);
  }
  return Buffer.from(match.slice(1).map(Number));
}

// ─── DLMS AARQ Builder ─────────────────────────────────────────────────────

function buildInitiateRequest(dlmsVersion) {
  return Buffer.from([
    0x01, 0x00, 0x00, 0x00,
    dlmsVersion,
    0x5F, 0x1F, 0x04, 0x00,
    0x00, 0x1E, 0x1D,
    0xFF, 0xFF,
  ]);
}

function buildAarq(applicationContext) {
  const parts = [];

  const ctxValue = Buffer.concat([
    Buffer.from([0x06, applicationContext.length]),
    applicationContext,
  ]);
  parts.push(Buffer.from([0xA1, ctxValue.length]));
  parts.push(ctxValue);

  const initiateRequest = buildInitiateRequest(6);
  const userInfoOctet = Buffer.concat([
    Buffer.from([0x04, initiateRequest.length]),
    initiateRequest,
  ]);
  parts.push(Buffer.from([0xBE, userInfoOctet.length]));
  parts.push(userInfoOctet);

  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x60, body.length]), body]);
}

// ─── DLMS GET.request Builder ───────────────────────────────────────────────

function buildGetRequest(classId, obisCode, attributeIndex = 2, invokeId = 1) {
  const obisBytes = obisToBytes(obisCode);

  return Buffer.from([
    0xC0,
    0x01,
    invokeId & 0xFF,
    (classId >> 8) & 0xFF, classId & 0xFF,
    ...obisBytes,
    attributeIndex,
    0x00,
  ]);
}

// ─── DLMS Release Request Builder ───────────────────────────────────────────

function buildReleaseRequest(reason = 0) {
  const body = Buffer.from([0x80, 0x01, reason]);
  return Buffer.concat([Buffer.from([0x62, body.length]), body]);
}

// ─── DLMS Value Decoder ─────────────────────────────────────────────────────

function parseDlmsValue(buffer, offset = 0) {
  if (offset >= buffer.length) {
    throw new Error(`DLMS parse: offset ${offset} beyond buffer length ${buffer.length}`);
  }

  const tag = buffer[offset];
  const typeName = TYPE_NAMES[tag] || `UNKNOWN(0x${tag.toString(16)})`;
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
      const dt = parseCosemDateTime(buffer, pos);
      return { value: dt, type: tag, typeName, bytesConsumed: 13 };
    }

    case DLMS_DATA_TYPES.DATE: {
      const year = buffer.readUInt16BE(pos);
      const month = buffer[pos + 2];
      const day = buffer[pos + 3];
      const dow = buffer[pos + 4];
      return {
        value: { year, month, day, dayOfWeek: dow },
        type: tag, typeName, bytesConsumed: 6,
      };
    }

    case DLMS_DATA_TYPES.TIME:
      return {
        value: {
          hour: buffer[pos], minute: buffer[pos + 1],
          second: buffer[pos + 2], hundredths: buffer[pos + 3],
        },
        type: tag, typeName, bytesConsumed: 5,
      };

    case DLMS_DATA_TYPES.ARRAY: {
      const count = buffer[pos];
      pos++;
      const elements = [];
      let totalConsumed = 2;
      for (let i = 0; i < count; i++) {
        const elem = parseDlmsValue(buffer, offset + totalConsumed);
        elements.push(elem);
        totalConsumed += elem.bytesConsumed;
      }
      return { value: elements, type: tag, typeName, bytesConsumed: totalConsumed };
    }

    case DLMS_DATA_TYPES.STRUCTURE: {
      const count = buffer[pos];
      pos++;
      const fields = [];
      let totalConsumed = 2;
      for (let i = 0; i < count; i++) {
        const field = parseDlmsValue(buffer, offset + totalConsumed);
        fields.push(field);
        totalConsumed += field.bytesConsumed;
      }
      return { value: fields, type: tag, typeName, bytesConsumed: totalConsumed };
    }

    default:
      throw new Error(`Unknown DLMS data type tag: 0x${tag.toString(16)} at offset ${offset}`);
  }
}

function parseCosemDateTime(buffer, offset = 0) {
  if (buffer.length < offset + 12) {
    throw new Error('Buffer too short for COSEM datetime');
  }
  const year = buffer.readUInt16BE(offset);
  const month = buffer[offset + 2];
  const day = buffer[offset + 3];
  const hour = buffer[offset + 5];
  const minute = buffer[offset + 6];
  const second = buffer[offset + 7];

  const result = {
    year: year === 0xFFFF ? null : year,
    month: month === 0xFF ? null : month,
    day: day === 0xFF ? null : day,
    hour: hour === 0xFF ? null : hour,
    minute: minute === 0xFF ? null : minute,
    second: second === 0xFF ? null : second,
  };

  if (result.year !== null && result.month !== null && result.day !== null) {
    const pad = (n) => String(n).padStart(2, '0');
    result.iso = `${result.year}-${pad(result.month)}-${pad(result.day)}`;
    if (result.hour !== null) {
      result.iso += `T${pad(result.hour)}:${pad(result.minute || 0)}:${pad(result.second || 0)}`;
    }
  }

  return result;
}

// ─── AARE Parser ────────────────────────────────────────────────────────────

function parseAare(buffer) {
  const result = {
    type: 'aare',
    accepted: false,
    associationResult: null,
    raw: buffer,
  };

  for (let i = 2; i < buffer.length - 2; i++) {
    if (buffer[i] === 0xA2) {
      const len = buffer[i + 1];
      if (len >= 3 && i + 2 + len <= buffer.length) {
        if (buffer[i + 2] === 0x02 && buffer[i + 3] >= 1) {
          const associationResult = buffer[i + 4];
          result.associationResult = associationResult;
          result.accepted = associationResult === 0;
          break;
        }
      }
    }
  }

  return result;
}

// ─── GET.response Parser ────────────────────────────────────────────────────

function parseGetResponse(buffer) {
  const result = {
    type: 'get-response',
    responseType: null,
    invokeId: null,
    accessResult: null,
    data: null,
  };

  let pos = 1;

  if (buffer.length > pos) {
    result.responseType = buffer[pos];
    pos++;
  }

  if (buffer.length > pos) {
    result.invokeId = buffer[pos];
    pos++;
  }

  if (result.responseType === 0x01) {
    if (buffer.length > pos) {
      const choice = buffer[pos];
      pos++;

      if (choice === 0x00) {
        result.accessResult = 'success';
        if (buffer.length > pos) {
          try {
            result.data = parseDlmsValue(buffer, pos);
          } catch (err) {
            result.data = { raw: buffer.subarray(pos), parseError: err.message };
          }
        }
      } else if (choice === 0x01) {
        result.accessResult = 'error';
        if (buffer.length > pos) {
          const errorCode = buffer[pos];
          const errorName = DATA_ACCESS_RESULT_NAMES[errorCode] || `unknown(${errorCode})`;
          result.data = { errorCode, errorName };
        }
      }
    }
  }

  return result;
}

// ─── Data Value Formatter ───────────────────────────────────────────────────

function formatDlmsValue(data) {
  if (!data) return 'null';
  if (data.parseError) return `[parse error: ${data.parseError}]`;
  if (data.raw && Buffer.isBuffer(data.raw)) return `raw(${hexDump(data.raw)})`;
  if (data.errorCode !== undefined) return `ERROR: ${data.errorName} (${data.errorCode})`;

  const val = data.value;
  const type = data.typeName || '';

  if (val === null || val === undefined) return 'null';
  if (Buffer.isBuffer(val)) return `${type}(${hexDump(val)})`;
  if (typeof val === 'object' && val.iso) return `${type}(${val.iso})`;
  if (Array.isArray(val)) {
    return `${type}[${val.map(v => formatDlmsValue(v)).join(', ')}]`;
  }
  if (typeof val === 'object') return `${type}(${JSON.stringify(val)})`;
  return `${type}(${val})`;
}

// ─── Serializable value helper ──────────────────────────────────────────────

function serializeDlmsValue(data) {
  if (!data) return null;
  if (data.parseError) return { parseError: data.parseError };
  if (data.errorCode !== undefined) return { errorCode: data.errorCode, errorName: data.errorName };

  const result = { type: data.type, typeName: data.typeName };
  const val = data.value;

  if (val === null || val === undefined) {
    result.value = null;
  } else if (Buffer.isBuffer(val)) {
    result.value = hexDump(val);
  } else if (Array.isArray(val)) {
    result.value = val.map(v => serializeDlmsValue(v));
  } else if (typeof val === 'object') {
    result.value = val;
  } else {
    result.value = val;
  }

  return result;
}

// ─── TCP Data Accumulation & Response Waiting ───────────────────────────────

function waitForResponse(socket, expectedTag, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let accum = Buffer.alloc(0);
    let resolved = false;

    const cleanup = () => {
      socket.removeListener('data', dataHandler);
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ timeout: true, accumulated: accum });
      }
    }, timeoutMs);

    const dataHandler = (data) => {
      if (resolved) return;
      accum = Buffer.concat([accum, data]);

      let processed = true;
      while (processed && !resolved) {
        processed = false;

        // Skip heartbeats
        if (accum.length >= HEARTBEAT_PACKET_LENGTH && isHeartbeat(accum)) {
          accum = accum.subarray(HEARTBEAT_PACKET_LENGTH);
          processed = true;
          continue;
        }

        // Try IVY-wrapped packet
        if (isIvyPacket(accum) && accum.length >= IVY_HEADER_LENGTH) {
          const payloadLen = accum.readUInt16BE(6);
          const totalLen = IVY_HEADER_LENGTH + payloadLen;

          if (accum.length >= totalLen) {
            const payload = Buffer.from(accum.subarray(IVY_HEADER_LENGTH, totalLen));
            accum = accum.subarray(totalLen);
            processed = true;

            if (payload.length > 0) {
              const tag = payload[0];

              // Unsolicited notifications - skip
              if (tag === APDU_TAGS.EVENT_NOTIFICATION || tag === APDU_TAGS.DATA_NOTIFICATION) {
                continue;
              }

              if (expectedTag === null || tag === expectedTag) {
                resolved = true;
                cleanup();
                resolve({ timeout: false, payload, tag, rawHex: hexDump(payload) });
                return;
              }
            }
            continue;
          }
          break;
        }

        // Try raw DLMS APDU
        if (accum.length > 0 && accum[0] !== 0x00) {
          const knownTags = new Set([0x60, 0x61, 0x62, 0x63, 0xC0, 0xC2, 0xC4, 0xC5, 0xC7, 0x0F, 0xD8]);
          if (knownTags.has(accum[0])) {
            const tag = accum[0];

            // BER-TLV (AARE, RLRE)
            if (tag === 0x61 || tag === 0x63 || tag === 0x60 || tag === 0x62) {
              if (accum.length >= 2) {
                const len = accum[1];
                const totalLen = 2 + len;
                if (accum.length >= totalLen) {
                  const payload = Buffer.from(accum.subarray(0, totalLen));
                  accum = accum.subarray(totalLen);
                  processed = true;

                  if (expectedTag === null || tag === expectedTag) {
                    resolved = true;
                    cleanup();
                    resolve({ timeout: false, payload, tag, rawHex: hexDump(payload) });
                    return;
                  }
                  continue;
                }
              }
              break;
            }

            // GET.response
            if (tag === 0xC4) {
              if (accum.length >= 5) {
                const responseType = accum[1];
                if (responseType === 0x01) {
                  const choice = accum[3];
                  if (choice === 0x01) {
                    // Error - exactly 5 bytes
                    const payload = Buffer.from(accum.subarray(0, 5));
                    accum = accum.subarray(5);
                    processed = true;
                    if (expectedTag === null || tag === expectedTag) {
                      resolved = true;
                      cleanup();
                      resolve({ timeout: false, payload, tag, rawHex: hexDump(payload) });
                      return;
                    }
                    continue;
                  }
                  if (choice === 0x00 && accum.length > 4) {
                    try {
                      const val = parseDlmsValue(accum, 4);
                      const totalLen = 4 + val.bytesConsumed;
                      const payload = Buffer.from(accum.subarray(0, totalLen));
                      accum = accum.subarray(totalLen);
                      processed = true;
                      if (expectedTag === null || tag === expectedTag) {
                        resolved = true;
                        cleanup();
                        resolve({ timeout: false, payload, tag, rawHex: hexDump(payload) });
                        return;
                      }
                      continue;
                    } catch {
                      break;
                    }
                  }
                }
              }
              break;
            }

            // Unsolicited notifications
            if (tag === APDU_TAGS.EVENT_NOTIFICATION || tag === APDU_TAGS.DATA_NOTIFICATION) {
              accum = accum.subarray(1);
              processed = true;
              continue;
            }

            // ExceptionResponse - 3 bytes
            if (tag === 0xD8 && accum.length >= 3) {
              const payload = Buffer.from(accum.subarray(0, 3));
              accum = accum.subarray(3);
              processed = true;
              if (expectedTag === null || tag === expectedTag) {
                resolved = true;
                cleanup();
                resolve({ timeout: false, payload, tag, rawHex: hexDump(payload) });
                return;
              }
              continue;
            }
          }

          // Unknown byte - skip
          if (!new Set([0x60, 0x61, 0x62, 0x63, 0xC0, 0xC2, 0xC4, 0xC5, 0xC7, 0x0F, 0xD8]).has(accum[0]) && accum[0] !== 0x00) {
            accum = accum.subarray(1);
            processed = true;
            continue;
          }
        }
      }
    };

    socket.on('data', dataHandler);
  });
}

// ─── OBIS Scan Range Generator ──────────────────────────────────────────────

function generatePhase1Probes() {
  const probes = [];
  const priorityC = [0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 15, 21, 31, 32, 41, 51, 52, 61, 71, 72, 81, 91, 96, 97];
  const dValues = [7, 8];
  const eValues = [0, 255];

  for (const c of priorityC) {
    for (const d of dValues) {
      for (const e of eValues) {
        probes.push({ a: 1, b: 0, c, d, e, f: 255, classId: 3 });
      }
    }
  }

  // Special system OBIS codes
  probes.push({ a: 0, b: 0, c: 1, d: 0, e: 0, f: 255, classId: 8, name: 'Clock' });
  probes.push({ a: 0, b: 0, c: 96, d: 1, e: 0, f: 255, classId: 1, name: 'Serial Number' });
  probes.push({ a: 1, b: 0, c: 0, d: 0, e: 0, f: 255, classId: 1, name: 'Device ID' });
  probes.push({ a: 0, b: 0, c: 96, d: 14, e: 0, f: 255, classId: 1, name: 'Current Tariff' });
  probes.push({ a: 0, b: 0, c: 97, d: 97, e: 0, f: 255, classId: 1, name: 'Error Register' });
  probes.push({ a: 0, b: 0, c: 96, d: 3, e: 10, f: 255, classId: 1, name: 'Disconnect Control' });
  probes.push({ a: 1, b: 0, c: 0, d: 2, e: 0, f: 255, classId: 1, name: 'Firmware Version' });
  probes.push({ a: 0, b: 0, c: 42, d: 0, e: 0, f: 255, classId: 1, name: 'Logical Device Name' });
  probes.push({ a: 0, b: 0, c: 96, d: 1, e: 1, f: 255, classId: 1, name: 'Manufacturer Serial' });

  return probes;
}

function generatePhase2Probes(phase1Successes, alreadyProbed) {
  const probes = [];
  const successfulCs = [...new Set(phase1Successes.map(s => s.c))];

  for (const baseC of successfulCs) {
    for (let c = Math.max(0, baseC - 2); c <= Math.min(99, baseC + 2); c++) {
      for (let d = 0; d <= 8; d++) {
        for (const e of [0, 1, 2, 3, 255]) {
          for (const classId of [3, 1, 4, 7, 8]) {
            const key = `1-0:${c}.${d}.${e}.255_${classId}`;
            if (!alreadyProbed.has(key)) {
              probes.push({ a: 1, b: 0, c, d, e, f: 255, classId });
            }
          }
        }
      }
    }
  }

  return probes;
}

function probeToObisStr(probe) {
  return `${probe.a}-${probe.b}:${probe.c}.${probe.d}.${probe.e}.${probe.f}`;
}

function probeToKey(probe) {
  return `${probeToObisStr(probe)}_${probe.classId}`;
}

// ─── Results Manager ────────────────────────────────────────────────────────

function getResultsFilePath() {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(RESULTS_DIR, `obis-scan-results-${date}.json`);
}

function findLatestResultsFile() {
  try {
    const files = fs.readdirSync(RESULTS_DIR)
      .filter(f => f.startsWith('obis-scan-results-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length > 0) {
      return path.join(RESULTS_DIR, files[0]);
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return null;
}

function loadResumeData() {
  if (!resumeArg) return [];

  const latestFile = findLatestResultsFile();
  if (!latestFile) {
    log('No previous results file found for --resume');
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    log(`Resuming from ${latestFile} (${data.results.length} previous probes)`);
    resultsFile = latestFile; // Reuse the same file
    return data.results || [];
  } catch (err) {
    log(`Failed to load resume data: ${err.message}`);
    return [];
  }
}

function saveResults(results, phase = null) {
  if (!resultsFile) {
    resultsFile = getResultsFilePath();
  }

  const successes = results.filter(r => r.result === 'success');
  const failures = results.filter(r => r.result === 'error');
  const timeouts = results.filter(r => r.result === 'timeout');
  const skipped = results.filter(r => r.result === 'skipped');

  const output = {
    scanDate: new Date().toISOString(),
    meterAddress: meterAddress || 'unknown',
    scanConfig: {
      phase: phase || 'in-progress',
      totalProbes: results.length,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      probeDelayMs: PROBE_DELAY_MS,
      maxProbesPerSession: MAX_PROBES_PER_SESSION,
      groupExhaustThreshold: GROUP_EXHAUST_THRESHOLD,
    },
    results: results.map(r => ({
      obis: r.obis,
      classId: r.classId,
      name: r.name || null,
      result: r.result,
      error: r.error || null,
      dataType: r.data ? r.data.typeName : null,
      value: r.data ? serializeDlmsValue(r.data) : null,
      formatted: r.data ? formatDlmsValue(r.data) : null,
    })),
    summary: {
      total: results.length,
      success: successes.length,
      failed: failures.length,
      timeout: timeouts.length,
      skipped: skipped.length,
    },
  };

  try {
    fs.writeFileSync(resultsFile, JSON.stringify(output, null, 2));
  } catch (err) {
    log(`Failed to save results: ${err.message}`);
  }
}

// ─── Session Manager ────────────────────────────────────────────────────────

async function openSession(socket) {
  log('Opening DLMS session (AARQ)...');
  const aarq = buildAarq(APPLICATION_CONTEXT.LN_NO_CIPHER);
  const packet = wrapWithIvy(IVY_DESTINATION, aarq);
  socket.write(packet);

  const response = await waitForResponse(socket, APDU_TAGS.AARE, 5000);
  if (response.timeout) {
    log('  AARQ TIMEOUT - no AARE response');
    return false;
  }

  const aare = parseAare(response.payload);
  if (aare.accepted) {
    log('  Session established');
    return true;
  }

  log(`  Session rejected (result=${aare.associationResult})`);
  return false;
}

async function closeSession(socket) {
  log('Closing DLMS session (RLRQ)...');
  const rlrq = buildReleaseRequest();
  const packet = wrapWithIvy(IVY_DESTINATION, rlrq);
  socket.write(packet);

  const response = await waitForResponse(socket, APDU_TAGS.RLRE, 3000);
  if (response.timeout) {
    log('  No RLRE received (timeout)');
  } else {
    log('  Session released');
  }

  await sleep(SESSION_DELAY_MS);
}

// ─── Probe Engine ───────────────────────────────────────────────────────────

async function probeObisCode(socket, probe, invokeId) {
  const obisStr = probeToObisStr(probe);
  const getReq = buildGetRequest(probe.classId, obisStr, 2, invokeId);
  const packet = wrapWithIvy(IVY_DESTINATION, getReq);

  socket.write(packet);
  const response = await waitForResponse(socket, APDU_TAGS.GET_RESPONSE, PROBE_TIMEOUT_MS);

  if (response.timeout) {
    return { obis: obisStr, classId: probe.classId, name: probe.name || null, result: 'timeout' };
  }

  const parsed = parseGetResponse(response.payload);
  if (parsed.accessResult === 'success') {
    return {
      obis: obisStr,
      classId: probe.classId,
      name: probe.name || null,
      result: 'success',
      data: parsed.data,
      rawHex: response.rawHex,
    };
  } else {
    const errorName = parsed.data ? parsed.data.errorName : 'unknown';
    return {
      obis: obisStr,
      classId: probe.classId,
      name: probe.name || null,
      result: 'error',
      error: errorName,
      rawHex: response.rawHex,
    };
  }
}

// ─── Scan Loop ──────────────────────────────────────────────────────────────

async function runScanPhase(socket, probes, phaseName, results, alreadyProbed) {
  const successes = [];
  const groupFailures = {};
  let sessionProbeCount = 0;
  let invokeId = 1;

  log(`\n${'='.repeat(70)}`);
  log(`${phaseName}: ${probes.length} probes to run`);
  log('='.repeat(70));

  if (probes.length === 0) {
    log('  No probes to run (all already probed or filtered)');
    return successes;
  }

  // Open initial session
  if (!await openSession(socket)) {
    log('AARQ failed - aborting phase');
    return successes;
  }

  for (let i = 0; i < probes.length; i++) {
    if (disconnected) break;

    const probe = probes[i];
    const groupKey = `${probe.a}-${probe.b}:${probe.c}`;

    // Check group exhaustion
    if ((groupFailures[groupKey] || 0) >= GROUP_EXHAUST_THRESHOLD) {
      const skippedResult = {
        obis: probeToObisStr(probe),
        classId: probe.classId,
        name: probe.name || null,
        result: 'skipped',
        error: 'group-exhausted',
      };
      results.push(skippedResult);
      alreadyProbed.add(probeToKey(probe));

      // Log skip once per group
      if ((groupFailures[groupKey] || 0) === GROUP_EXHAUST_THRESHOLD) {
        log(`[SKIP] ${groupKey}.x.x.255 - group exhausted after ${GROUP_EXHAUST_THRESHOLD} consecutive failures`);
        groupFailures[groupKey]++;  // Increment past threshold to suppress further logs
      }
      continue;
    }

    // Re-establish session if needed
    if (sessionProbeCount >= MAX_PROBES_PER_SESSION) {
      await closeSession(socket);
      if (disconnected) break;
      if (!await openSession(socket)) {
        log('Session re-establishment failed - aborting');
        break;
      }
      sessionProbeCount = 0;
    }

    const result = await probeObisCode(socket, probe, invokeId);
    invokeId = (invokeId % 255) + 1;
    sessionProbeCount++;
    results.push(result);
    alreadyProbed.add(probeToKey(probe));

    // Track group failures
    if (result.result === 'error' && result.error === 'object-undefined') {
      groupFailures[groupKey] = (groupFailures[groupKey] || 0) + 1;
    } else {
      groupFailures[groupKey] = 0;
    }

    if (result.result === 'success') {
      successes.push({ ...result, c: probe.c });
      log(`[SUCCESS] ${result.obis} (class ${result.classId}) = ${formatDlmsValue(result.data)}${result.name ? ' [' + result.name + ']' : ''}`);
    } else if (result.result === 'timeout') {
      log(`[TMOUT] ${result.obis} (class ${result.classId})`);
    } else {
      log(`[FAIL] ${result.obis} (class ${result.classId}) = ${result.error}`);
    }

    // Progress every 10 probes
    if ((i + 1) % 10 === 0) {
      const pct = ((i + 1) / probes.length * 100).toFixed(1);
      log(`[PROGRESS] ${i + 1}/${probes.length} probes (${pct}%) - Found: ${successes.length}`);
    }

    // Save incrementally every 10 probes
    if ((i + 1) % 10 === 0) {
      saveResults(results, phaseName);
    }

    await sleep(PROBE_DELAY_MS);
  }

  // Final save for this phase
  saveResults(results, phaseName);

  // Close session at end of phase
  if (!disconnected) {
    await closeSession(socket);
  }

  log(`\n${phaseName} complete: ${successes.length} successful probes out of ${probes.length}`);
  return successes;
}

// ─── Main Brute-Force Scan ──────────────────────────────────────────────────

async function runBruteForceScan(socket) {
  // Load resume data if --resume
  const resumeData = loadResumeData();
  const alreadyProbed = new Set(resumeData.map(r => `${r.obis}_${r.classId}`));
  const results = [...resumeData];

  log(`\n${'='.repeat(70)}`);
  log('DLMS OBIS BRUTE-FORCE SCANNER');
  log(`Meter address: ${meterAddress}`);
  if (filterGroup !== null) log(`Filtering to C group: ${filterGroup}`);
  if (resumeArg && resumeData.length > 0) log(`Resumed: ${resumeData.length} previous probes loaded`);
  log('='.repeat(70));

  // Phase 1: Quick Scan
  let phase1Probes = generatePhase1Probes();

  // Apply group filter if specified
  if (filterGroup !== null) {
    phase1Probes = phase1Probes.filter(p => p.c === filterGroup);
  }

  // Filter out already-probed combinations
  phase1Probes = phase1Probes.filter(p => !alreadyProbed.has(probeToKey(p)));

  const phase1Successes = await runScanPhase(
    socket, phase1Probes, 'PHASE 1: Quick Scan', results, alreadyProbed
  );

  if (disconnected) {
    log('\nMeter disconnected during Phase 1');
    printSummary(results);
    saveResults(results, 'phase1-interrupted');
    return results;
  }

  // Gather all successes (including from resume data)
  const allSuccesses = [
    ...results.filter(r => r.result === 'success').map(r => {
      const match = r.obis.match(/^(\d+)-(\d+):(\d+)\./);
      return { ...r, c: match ? parseInt(match[3], 10) : 0 };
    }),
  ];

  // Phase 2: Extended Scan
  let phase2Probes = generatePhase2Probes(allSuccesses, alreadyProbed);

  // Apply group filter if specified
  if (filterGroup !== null) {
    phase2Probes = phase2Probes.filter(p => p.c === filterGroup);
  }

  if (phase2Probes.length > 0 && !disconnected) {
    log(`\nPhase 2 will probe ${phase2Probes.length} additional combinations based on ${allSuccesses.length} successes`);

    await runScanPhase(
      socket, phase2Probes, 'PHASE 2: Extended Scan', results, alreadyProbed
    );
  } else if (allSuccesses.length === 0) {
    log('\nNo successes in Phase 1 - skipping Phase 2');
  } else {
    log('\nAll Phase 2 combinations already probed - skipping');
  }

  // Final summary
  printSummary(results);
  saveResults(results, 'complete');

  allResults = results;
  return results;
}

// ─── Summary Reporter ───────────────────────────────────────────────────────

function printSummary(results) {
  log(`\n\n${'='.repeat(70)}`);
  log('SCAN RESULTS SUMMARY');
  log('='.repeat(70));

  const successes = results.filter(r => r.result === 'success');
  const failures = results.filter(r => r.result === 'error');
  const timeouts = results.filter(r => r.result === 'timeout');
  const skipped = results.filter(r => r.result === 'skipped');

  // Stats
  log(`\nTotal probes: ${results.length}`);
  log(`  Successful: ${successes.length}`);
  log(`  Failed:     ${failures.length}`);
  log(`  Timeout:    ${timeouts.length}`);
  log(`  Skipped:    ${skipped.length}`);

  if (successes.length === 0) {
    log('\nNo successful OBIS codes found.');
    if (failures.length > 0) {
      // Show error distribution
      const errorCounts = {};
      for (const r of failures) {
        errorCounts[r.error] = (errorCounts[r.error] || 0) + 1;
      }
      log('\nError distribution:');
      for (const [error, count] of Object.entries(errorCounts).sort((a, b) => b[1] - a[1])) {
        log(`  ${error}: ${count}`);
      }
    }
    log('\nSUGGESTION: The meter may only support passive/push mode');
    log('(EventNotification/DataNotification) rather than active querying.');
    if (resultsFile) {
      log(`\nResults saved to: ${resultsFile}`);
    }
    log('\n' + '='.repeat(70));
    return;
  }

  // Successful OBIS codes table
  log('\n-- Successful OBIS Codes --\n');

  const header = [
    'OBIS Code'.padEnd(22),
    'Cls'.padEnd(5),
    'Type'.padEnd(18),
    'Value',
  ].join(' | ');
  log(header);
  log('-'.repeat(header.length + 20));

  // Deduplicate successes by OBIS (keep the one with lowest classId)
  const uniqueSuccess = new Map();
  for (const r of successes) {
    const existing = uniqueSuccess.get(r.obis);
    if (!existing || r.classId < existing.classId) {
      uniqueSuccess.set(r.obis, r);
    }
  }

  // Sort by OBIS code
  const sortedSuccess = [...uniqueSuccess.values()].sort((a, b) => {
    return a.obis.localeCompare(b.obis);
  });

  for (const r of sortedSuccess) {
    const formatted = r.data ? formatDlmsValue(r.data) : 'null';
    const dataType = r.data && r.data.typeName ? r.data.typeName : '-';
    const nameStr = r.name ? ` [${r.name}]` : '';
    const row = [
      r.obis.padEnd(22),
      String(r.classId).padEnd(5),
      dataType.padEnd(18),
      formatted + nameStr,
    ].join(' | ');
    log(row);
  }

  // Copy-paste ready output
  log('\n-- Copy-Paste Ready: DLMS_POLL_REGISTERS --\n');
  log('// Add these to src/services/polling-manager.js DLMS_POLL_REGISTERS:');
  for (const r of sortedSuccess) {
    const nameStr = r.name ? r.name : r.obis;
    log(`    { classId: ${r.classId}, obisCode: '${r.obis}', name: '${nameStr}' },`);
  }

  // C-group breakdown
  log('\n-- C-Group Breakdown --\n');
  const cGroupMap = new Map();
  for (const r of sortedSuccess) {
    const match = r.obis.match(/^(\d+)-(\d+):(\d+)\./);
    if (match) {
      const c = parseInt(match[3], 10);
      if (!cGroupMap.has(c)) cGroupMap.set(c, []);
      cGroupMap.get(c).push(r);
    }
  }

  for (const [c, entries] of [...cGroupMap.entries()].sort((a, b) => a[0] - b[0])) {
    log(`  C=${c}: ${entries.length} register(s)`);
    for (const r of entries) {
      const formatted = r.data ? formatDlmsValue(r.data) : '';
      log(`    ${r.obis} (class ${r.classId}) = ${formatted}`);
    }
  }

  // Error distribution
  if (failures.length > 0) {
    log('\n-- Error Distribution --\n');
    const errorCounts = {};
    for (const r of failures) {
      errorCounts[r.error] = (errorCounts[r.error] || 0) + 1;
    }
    for (const [error, count] of Object.entries(errorCounts).sort((a, b) => b[1] - a[1])) {
      log(`  ${error}: ${count}`);
    }
  }

  if (resultsFile) {
    log(`\nResults saved to: ${resultsFile}`);
  }

  log('\n' + '='.repeat(70));
}

// ─── IVY Signature Search ───────────────────────────────────────────────────

function findIvySignature(buf, startIndex = 0) {
  for (let i = startIndex; i <= buf.length - 4; i++) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x01 &&
        buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
      return i;
    }
  }
  return -1;
}

// ─── TCP Server ─────────────────────────────────────────────────────────────

function startServer() {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`\nMeter connected from ${remote}`);

    if (activeSocket) {
      log('Already have an active connection, rejecting new one.');
      socket.destroy();
      return;
    }

    activeSocket = socket;
    disconnected = false;
    allResults = [];

    let heartbeatReceived = false;
    let heartbeatDataBuffer = Buffer.alloc(0);

    const heartbeatPhaseHandler = (data) => {
      heartbeatDataBuffer = Buffer.concat([heartbeatDataBuffer, data]);

      while (heartbeatDataBuffer.length >= HEARTBEAT_PACKET_LENGTH) {
        if (isHeartbeat(heartbeatDataBuffer)) {
          const addr = parseHeartbeat(heartbeatDataBuffer);
          log(`HEARTBEAT detected! Meter address: ${addr}`);
          meterAddress = addr;
          heartbeatReceived = true;

          heartbeatDataBuffer = heartbeatDataBuffer.subarray(HEARTBEAT_PACKET_LENGTH);
          socket.removeListener('data', heartbeatPhaseHandler);

          log('Waiting 2s before starting brute-force scan...');
          setTimeout(() => {
            runBruteForceScan(socket).then(() => {
              log('\nScan complete. Keeping connection open for observation.');
              log('Press Ctrl+C to exit.');

              socket.on('data', (d) => {
                if (isHeartbeat(d)) {
                  // Silently ignore post-scan heartbeats
                } else {
                  const extracted = extractDlmsPayload(d);
                  if (extracted) {
                    const tagName = APDU_TAG_NAMES[extracted.tag] || `0x${extracted.tag.toString(16)}`;
                    log(`<< Post-scan: ${tagName} (${d.length} bytes)`);
                  }
                }
              });
            }).catch((err) => {
              log(`Scan error: ${err.message}`);
              log(err.stack);
              if (allResults.length > 0) {
                printSummary(allResults);
                saveResults(allResults, 'error');
              }
            });
          }, 2000);

          return;
        }

        const ivyStart = findIvySignature(heartbeatDataBuffer, 1);
        if (ivyStart > 0) {
          heartbeatDataBuffer = heartbeatDataBuffer.subarray(ivyStart);
        } else {
          if (heartbeatDataBuffer.length > 100) {
            heartbeatDataBuffer = heartbeatDataBuffer.subarray(heartbeatDataBuffer.length - 4);
          }
          break;
        }
      }

      if (!heartbeatReceived) {
        log('Waiting for heartbeat packet...');
      }
    };

    socket.on('data', heartbeatPhaseHandler);

    socket.on('close', () => {
      log(`Meter disconnected from ${remote}`);
      disconnected = true;
      activeSocket = null;
      meterAddress = null;

      if (allResults.length > 0) {
        log('Meter disconnected. Printing partial results...');
        printSummary(allResults);
        saveResults(allResults, 'disconnected');
      }
    });

    socket.on('error', (err) => {
      log(`Socket error: ${err.message}`);
      disconnected = true;
      activeSocket = null;
      meterAddress = null;
    });

    log('Waiting for heartbeat from meter...');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`\nERROR: Port ${TCP_PORT} is already in use!`);
      log('Make sure to stop the gateway first:');
      log('  sudo systemctl stop ivy-gateway');
      process.exit(1);
    }
    log(`Server error: ${err.message}`);
  });

  server.listen(TCP_PORT, '0.0.0.0', () => {
    log('='.repeat(70));
    log('DLMS OBIS BRUTE-FORCE SCANNER');
    log('='.repeat(70));
    log(`TCP server listening on port ${TCP_PORT}`);
    log('Waiting for meter to connect...');
    log('');
    log('This script will:');
    log('  1. Wait for a meter heartbeat to detect meter address');
    log('  2. Phase 1: Quick scan of ~114 priority OBIS codes');
    log('  3. Phase 2: Extended scan around successful C values');
    log('  4. Print summary with copy-paste-ready register entries');
    log('');
    log(`Options active:`);
    log(`  Resume: ${resumeArg ? 'YES' : 'no'}`);
    log(`  Group filter: ${filterGroup !== null ? 'C=' + filterGroup : 'none (all groups)'}`);
    log(`  Probe timeout: ${PROBE_TIMEOUT_MS}ms`);
    log(`  Probe delay: ${PROBE_DELAY_MS}ms`);
    log(`  Session limit: ${MAX_PROBES_PER_SESSION} probes/session`);
    log(`  Group exhaust: ${GROUP_EXHAUST_THRESHOLD} consecutive failures`);
    log('');
    log('Make sure the gateway is stopped: sudo systemctl stop ivy-gateway');
    log('='.repeat(70));
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('\n\nInterrupted! Saving partial results...');
    if (allResults.length > 0) {
      saveResults(allResults, 'interrupted');
      printSummary(allResults);
    }
    server.close(() => {
      if (activeSocket) {
        activeSocket.destroy();
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

startServer();
