#!/usr/bin/env node
/**
 * DLMS OBIS Code Discovery Probe
 *
 * Standalone TCP server that systematically probes DLMS/COSEM OBIS codes
 * to discover which ones the IVY EM114070 meter supports.
 *
 * Background:
 *   GET.response returns "object-undefined" (error 4) for OBIS 1-0:1.8.0.255
 *   (Class 3). The meter may support different OBIS codes or class IDs.
 *   This tool tries multiple combinations to discover what works.
 *
 * Phases:
 *   1. LN Association (AARQ with LN_NO_CIPHER context)
 *   2. LN OBIS Probing (GET.request for each OBIS, retrying with alt class IDs)
 *   3. SN Association (AARQ with SN_NO_CIPHER context, if LN fails broadly)
 *   4. SN Base Address Probing (READ.request with common SN addresses)
 *   5. Summary Report (all results + copy-paste DLMS_POLL_REGISTERS entries)
 *
 * Usage:
 *   sudo systemctl stop ivy-gateway
 *   node debug/dlms-obis-probe.js
 *   # Wait for meter to connect, probes run automatically
 *   # Ctrl+C to exit early
 *
 * No imports from src/ — fully standalone using only Node.js built-ins.
 */

import net from 'net';

// ─── Configuration ──────────────────────────────────────────────────────────

const TCP_PORT = 8899;
const RESPONSE_TIMEOUT_MS = 5000;   // Wait 5s for each response
const PROBE_GAP_MS = 1000;          // 1s gap between probes

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
const IVY_DESTINATION = 0x0001; // DLMS public client on EM114070

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

// ─── OBIS Codes to Probe ────────────────────────────────────────────────────

const OBIS_PROBE_LIST = [
  { obis: '1-0:1.8.0.255',   defaultClass: 3, name: 'Total Import Active Energy' },
  { obis: '1-0:2.8.0.255',   defaultClass: 3, name: 'Total Export Active Energy' },
  { obis: '0-0:1.0.0.255',   defaultClass: 8, name: 'Clock' },
  { obis: '1-0:0.0.0.255',   defaultClass: 1, name: 'Device ID / Logical Device Name' },
  { obis: '0-0:96.1.0.255',  defaultClass: 1, name: 'Meter Serial Number' },
  { obis: '1-0:32.7.0.255',  defaultClass: 3, name: 'Voltage L1' },
  { obis: '1-0:52.7.0.255',  defaultClass: 3, name: 'Voltage L2' },
  { obis: '1-0:72.7.0.255',  defaultClass: 3, name: 'Voltage L3' },
  { obis: '1-0:31.7.0.255',  defaultClass: 3, name: 'Current L1' },
  { obis: '1-0:51.7.0.255',  defaultClass: 3, name: 'Current L2' },
  { obis: '1-0:71.7.0.255',  defaultClass: 3, name: 'Current L3' },
  { obis: '1-0:1.7.0.255',   defaultClass: 3, name: 'Instantaneous Active Power' },
  { obis: '1-0:13.7.0.255',  defaultClass: 3, name: 'Power Factor Total' },
  { obis: '1-0:14.7.0.255',  defaultClass: 3, name: 'Frequency' },
  { obis: '0-0:96.14.0.255', defaultClass: 1, name: 'Current Tariff' },
  { obis: '0-0:97.97.0.255', defaultClass: 1, name: 'Error Register' },
  { obis: '0-0:96.3.10.255', defaultClass: 1, name: 'Disconnect Control State' },
  // Extended probe codes for further discovery
  { obis: '1-0:12.7.0.255',  defaultClass: 3, name: 'Voltage combined/average' },
  { obis: '1-0:11.7.0.255',  defaultClass: 3, name: 'Current combined/average' },
  { obis: '1-0:15.8.0.255',  defaultClass: 3, name: 'Total active energy (absolute)' },
  { obis: '1-0:1.8.0.0',     defaultClass: 3, name: 'Active energy import (F=0)' },
  { obis: '1-0:1.8.0.1',     defaultClass: 3, name: 'Active energy import (F=1)' },
  { obis: '1-0:1.8.0.2',     defaultClass: 3, name: 'Active energy import (F=2)' },
  { obis: '1-0:0.2.0.255',   defaultClass: 1, name: 'Firmware version' },
  { obis: '0-0:42.0.0.255',  defaultClass: 1, name: 'Logical device name (alt)' },
  { obis: '0-0:96.1.1.255',  defaultClass: 1, name: 'Manufacturer serial (alt)' },
  { obis: '1-0:9.7.0.255',   defaultClass: 3, name: 'Apparent power import' },
  { obis: '1-0:3.7.0.255',   defaultClass: 3, name: 'Reactive power import' },
  { obis: '1-0:21.7.0.255',  defaultClass: 3, name: 'Active power phase A' },
  { obis: '1-0:1.6.0.255',   defaultClass: 4, name: 'Maximum demand (class 4)' },
  { obis: '1-0:0.8.0.255',   defaultClass: 3, name: 'Total operating time' },
];

const ALT_CLASS_IDS = [1, 3, 4, 7];

// ─── SN Base Addresses to Probe ─────────────────────────────────────────────

const SN_BASE_ADDRESSES = [
  0x0000, 0x0008, 0x0010, 0x0018, 0x0020, 0x0028, 0x0030, 0x0038,
  0x0040, 0x0048, 0x0050, 0x0058, 0x0060, 0x0068, 0x0070, 0x0078,
  0x0080, 0x00A0, 0x00C0, 0x0100, 0x0140, 0x0280, 0x0300,
];

// ─── State ──────────────────────────────────────────────────────────────────

let meterAddress = null;
let activeSocket = null;
let lnResults = [];      // { obis, classId, name, result, error, data, rawHex }
let snResults = [];      // { address, result, error, data, rawHex }
let disconnected = false;

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
  header.writeUInt16BE(0x0001, 2);           // Source
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

/**
 * Extract DLMS payload from incoming data (handles IVY-wrapped or raw DLMS).
 * Returns { payload, tag } or null.
 */
function extractDlmsPayload(data) {
  // IVY-wrapped packet
  if (isIvyPacket(data) && data.length >= IVY_HEADER_LENGTH) {
    const payloadLen = data.readUInt16BE(6);
    if (data.length >= IVY_HEADER_LENGTH + payloadLen && payloadLen > 0) {
      const payload = data.subarray(IVY_HEADER_LENGTH, IVY_HEADER_LENGTH + payloadLen);
      return { payload, tag: payload[0] };
    }
  }

  // Raw DLMS APDU
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
    0x01, 0x00, 0x00, 0x00,    // dedicated-key absent, response-allowed=true
    dlmsVersion,                // proposed-dlms-version-number
    0x5F, 0x1F, 0x04, 0x00,    // proposed-conformance tag
    0x00, 0x1E, 0x1D,          // conformance bits
    0xFF, 0xFF,                // client-max-receive-pdu-size
  ]);
}

function buildAarq(applicationContext) {
  const parts = [];

  // Application context name [1]
  const ctxValue = Buffer.concat([
    Buffer.from([0x06, applicationContext.length]),
    applicationContext,
  ]);
  parts.push(Buffer.from([0xA1, ctxValue.length]));
  parts.push(ctxValue);

  // User-information [30] - InitiateRequest
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
    0xC0,                                     // GET.request tag
    0x01,                                     // get-request-normal
    invokeId & 0xFF,                          // invoke-id-and-priority
    (classId >> 8) & 0xFF, classId & 0xFF,    // class-id (uint16 BE)
    ...obisBytes,                             // instance-id (6 bytes)
    attributeIndex,                           // attribute-id
    0x00,                                     // access-selection: not present
  ]);
}

// ─── DLMS Release Request Builder ───────────────────────────────────────────

function buildReleaseRequest(reason = 0) {
  const body = Buffer.from([0x80, 0x01, reason]);
  return Buffer.concat([Buffer.from([0x62, body.length]), body]);
}

// ─── SN READ.request Builder ────────────────────────────────────────────────

/**
 * Build a Short Name READ.request for a single variable.
 * Tag 0x05 (ReadRequest), sub-tag 0x02 (variable-name, uint16 BE)
 */
function buildSnReadRequest(baseAddress) {
  // ReadRequest ::= SEQUENCE OF {
  //   variable-access-specification CHOICE {
  //     variable-name [2] IMPLICIT Integer16
  //   }
  // }
  // Simplified: [0x05][length][0x02][hi][lo]
  return Buffer.from([
    0x05,                                        // READ.request tag
    0x01,                                        // count: 1 variable
    0x02,                                        // variable-name choice tag
    (baseAddress >> 8) & 0xFF, baseAddress & 0xFF, // base address (uint16 BE)
  ]);
}

// ─── DLMS Value Decoder (Minimal Inline) ────────────────────────────────────

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
    throw new Error(`Buffer too short for COSEM datetime`);
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

  // Scan for association-result context tag [2] (0xA2)
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

  let pos = 1; // skip tag

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

// ─── SN READ.response Parser ───────────────────────────────────────────────

/**
 * Parse a Short Name READ.response (tag 0x0C).
 * Structure: [0x0C][count][result-choice per item]
 *   choice 0x00 = data (DLMS value follows)
 *   choice 0x01 = data-access-error (1 byte error code)
 */
function parseSnReadResponse(buffer) {
  const result = {
    type: 'sn-read-response',
    items: [],
  };

  if (buffer.length < 3) return result;

  let pos = 1; // skip tag 0x0C
  const count = buffer[pos++];

  for (let i = 0; i < count && pos < buffer.length; i++) {
    const choice = buffer[pos++];
    if (choice === 0x00) {
      // Success - DLMS data follows
      try {
        const data = parseDlmsValue(buffer, pos);
        result.items.push({ accessResult: 'success', data });
        pos += data.bytesConsumed;
      } catch (err) {
        result.items.push({ accessResult: 'parse-error', error: err.message });
        break;
      }
    } else if (choice === 0x01) {
      // Error
      if (pos < buffer.length) {
        const errorCode = buffer[pos++];
        const errorName = DATA_ACCESS_RESULT_NAMES[errorCode] || `unknown(${errorCode})`;
        result.items.push({ accessResult: 'error', errorCode, errorName });
      }
    } else {
      result.items.push({ accessResult: 'unknown-choice', choice });
      break;
    }
  }

  return result;
}

// ─── Data Value Formatter (for display) ─────────────────────────────────────

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

// ─── TCP Data Accumulation & Response Waiting ───────────────────────────────

/**
 * Wait for a DLMS response of a specific tag, filtering out heartbeats
 * and unsolicited notifications.
 */
function waitForResponse(socket, expectedTag, timeoutMs = RESPONSE_TIMEOUT_MS) {
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

      // Try to extract complete packets from accumulated data
      let processed = true;
      while (processed && !resolved) {
        processed = false;

        // Skip heartbeats
        if (accum.length >= HEARTBEAT_PACKET_LENGTH && isHeartbeat(accum)) {
          log('  (heartbeat received, filtering out)');
          accum = accum.subarray(HEARTBEAT_PACKET_LENGTH);
          processed = true;
          continue;
        }

        // Try to find an IVY-wrapped packet
        if (isIvyPacket(accum) && accum.length >= IVY_HEADER_LENGTH) {
          const payloadLen = accum.readUInt16BE(6);
          const totalLen = IVY_HEADER_LENGTH + payloadLen;

          if (accum.length >= totalLen) {
            const payload = Buffer.from(accum.subarray(IVY_HEADER_LENGTH, totalLen));
            accum = accum.subarray(totalLen);
            processed = true;

            if (payload.length > 0) {
              const tag = payload[0];
              const tagName = APDU_TAG_NAMES[tag] || `0x${tag.toString(16)}`;

              // Unsolicited notifications - log and skip
              if (tag === APDU_TAGS.EVENT_NOTIFICATION || tag === APDU_TAGS.DATA_NOTIFICATION) {
                log(`  (unsolicited ${tagName} received, filtering out)`);
                continue;
              }

              if (expectedTag === null || tag === expectedTag) {
                resolved = true;
                cleanup();
                resolve({ timeout: false, payload, tag, rawHex: hexDump(payload) });
                return;
              }

              log(`  (unexpected APDU tag ${tagName}, wanted ${APDU_TAG_NAMES[expectedTag] || '0x' + expectedTag.toString(16)})`);
            }
            continue;
          }
          // Incomplete IVY packet, wait for more data
          break;
        }

        // Try raw DLMS APDU
        if (accum.length > 0 && accum[0] !== 0x00) {
          const knownTags = new Set([0x60, 0x61, 0x62, 0x63, 0xC0, 0xC2, 0xC4, 0xC5, 0xC7, 0x0F, 0xD8]);
          if (knownTags.has(accum[0])) {
            const tag = accum[0];
            const tagName = APDU_TAG_NAMES[tag] || `0x${tag.toString(16)}`;

            // For BER-TLV (AARE, RLRE): parse length to know full size
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
                  log(`  (unexpected raw APDU ${tagName})`);
                  continue;
                }
              }
              break; // wait for more
            }

            // For GET.response: try to parse at current size
            if (tag === 0xC4) {
              // Minimum: tag(1) + responseType(1) + invokeId(1) + choice(1) = 4
              // Error response: + errorCode(1) = 5
              // We need at least 5 bytes, but success needs more for value parsing
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
                    // Success - try to parse DLMS value to know total length
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
                      // Incomplete, wait for more
                      break;
                    }
                  }
                }
              }
              break; // wait for more
            }

            // Unsolicited notifications
            if (tag === APDU_TAGS.EVENT_NOTIFICATION || tag === APDU_TAGS.DATA_NOTIFICATION) {
              log(`  (unsolicited raw ${tagName}, skipping 1 byte to resync)`);
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

            // SN READ.response (0x0C) - variable length
            if (tag === 0x0C && accum.length >= 3) {
              // Try to parse
              try {
                const parsed = parseSnReadResponse(accum);
                // If we got at least one item, assume we consumed enough
                // For now, return what we have - the parser handles partial
                const payload = Buffer.from(accum);
                accum = Buffer.alloc(0);
                processed = true;
                resolved = true;
                cleanup();
                resolve({ timeout: false, payload, tag: 0x0C, rawHex: hexDump(payload) });
                return;
              } catch {
                break;
              }
            }
          }

          // Unknown byte at start - skip
          if (!knownTags.has(accum[0]) && accum[0] !== 0x00) {
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

// ─── Probe Phases ───────────────────────────────────────────────────────────

/**
 * Phase 1: Attempt LN Association (AARQ with LN_NO_CIPHER)
 */
async function phaseLnAssociation(socket) {
  log('\n' + '═'.repeat(70));
  log('PHASE 1: LN ASSOCIATION (Logical Name, No Ciphering)');
  log('═'.repeat(70));

  const aarq = buildAarq(APPLICATION_CONTEXT.LN_NO_CIPHER);
  const packet = wrapWithIvy(IVY_DESTINATION, aarq);

  log(`Sending AARQ (${aarq.length} bytes): ${hexDump(aarq)}`);
  log(`IVY packet (${packet.length} bytes): ${hexDump(packet)}`);

  socket.write(packet);
  const response = await waitForResponse(socket, APDU_TAGS.AARE);

  if (response.timeout) {
    log('  TIMEOUT - No AARE response received');
    log('  Trying without IVY wrapper...');

    // Retry raw
    socket.write(aarq);
    const rawResponse = await waitForResponse(socket, APDU_TAGS.AARE);
    if (rawResponse.timeout) {
      log('  TIMEOUT again - meter may only support passive/push mode');
      return { success: false, reason: 'no-response' };
    }
    return handleAareResponse(rawResponse);
  }

  return handleAareResponse(response);
}

function handleAareResponse(response) {
  log(`  AARE received (${response.payload.length} bytes): ${response.rawHex}`);
  const aare = parseAare(response.payload);
  log(`  Association result: ${aare.associationResult} (${aare.accepted ? 'ACCEPTED' : 'REJECTED'})`);

  if (aare.accepted) {
    log('  ✓ LN association established successfully');
    return { success: true };
  } else {
    log(`  ✗ LN association rejected (result=${aare.associationResult})`);
    return { success: false, reason: 'rejected', result: aare.associationResult };
  }
}

/**
 * Phase 2: Probe each OBIS code with GET.request
 */
async function phaseLnProbing(socket) {
  log('\n' + '═'.repeat(70));
  log('PHASE 2: LN OBIS CODE PROBING');
  log('═'.repeat(70));

  let invokeId = 1;
  let successCount = 0;

  for (const entry of OBIS_PROBE_LIST) {
    if (disconnected) break;

    // Try with default class ID first
    const classesToTry = [entry.defaultClass];
    // Add alternative class IDs that aren't the default
    for (const altClass of ALT_CLASS_IDS) {
      if (altClass !== entry.defaultClass) {
        classesToTry.push(altClass);
      }
    }

    let found = false;

    for (const classId of classesToTry) {
      if (found || disconnected) break;

      const label = `${entry.obis} (class ${classId}) - ${entry.name}`;
      log(`\n  Probing: ${label}`);

      const getReq = buildGetRequest(classId, entry.obis, 2, invokeId);
      const packet = wrapWithIvy(IVY_DESTINATION, getReq);

      log(`    GET.request: ${hexDump(getReq)}`);
      socket.write(packet);

      const response = await waitForResponse(socket, APDU_TAGS.GET_RESPONSE);
      invokeId = (invokeId % 255) + 1;

      if (response.timeout) {
        log(`    TIMEOUT - no GET.response`);
        lnResults.push({
          obis: entry.obis,
          classId,
          name: entry.name,
          result: 'timeout',
          error: null,
          data: null,
          rawHex: null,
        });
        // If default class timed out, don't bother with alternatives
        break;
      }

      log(`    GET.response: ${response.rawHex}`);
      const parsed = parseGetResponse(response.payload);

      if (parsed.accessResult === 'success') {
        const formatted = formatDlmsValue(parsed.data);
        log(`    ✓ SUCCESS! Value: ${formatted}`);
        lnResults.push({
          obis: entry.obis,
          classId,
          name: entry.name,
          result: 'success',
          error: null,
          data: parsed.data,
          rawHex: response.rawHex,
        });
        successCount++;
        found = true;
      } else if (parsed.accessResult === 'error') {
        const err = parsed.data;
        log(`    ✗ Error: ${err.errorName} (code ${err.errorCode})`);

        lnResults.push({
          obis: entry.obis,
          classId,
          name: entry.name,
          result: 'error',
          error: err.errorName,
          data: null,
          rawHex: response.rawHex,
        });

        // Only retry with alt class IDs for specific errors
        if (err.errorName !== 'object-undefined' &&
            err.errorName !== 'object-class-inconsistent') {
          break; // No point retrying for other error types
        }
      } else {
        log(`    ? Unexpected response format`);
        lnResults.push({
          obis: entry.obis,
          classId,
          name: entry.name,
          result: 'unexpected',
          error: 'unexpected response format',
          data: null,
          rawHex: response.rawHex,
        });
        break;
      }

      await sleep(PROBE_GAP_MS);
    }

    if (!found) {
      await sleep(PROBE_GAP_MS);
    }
  }

  log(`\n  LN probing complete: ${successCount}/${OBIS_PROBE_LIST.length} OBIS codes responded successfully`);
  return successCount;
}

/**
 * Release the current association
 */
async function releaseAssociation(socket) {
  log('\n  Sending RLRQ (Release Request)...');
  const rlrq = buildReleaseRequest();
  const packet = wrapWithIvy(IVY_DESTINATION, rlrq);
  socket.write(packet);

  const response = await waitForResponse(socket, APDU_TAGS.RLRE, 3000);
  if (response.timeout) {
    log('  No RLRE received (timeout)');
  } else {
    log(`  RLRE received: ${response.rawHex}`);
  }
}

/**
 * Phase 3: Attempt SN Association (AARQ with SN_NO_CIPHER)
 */
async function phaseSnAssociation(socket) {
  log('\n' + '═'.repeat(70));
  log('PHASE 3: SN ASSOCIATION (Short Name, No Ciphering)');
  log('═'.repeat(70));

  const aarq = buildAarq(APPLICATION_CONTEXT.SN_NO_CIPHER);
  const packet = wrapWithIvy(IVY_DESTINATION, aarq);

  log(`Sending SN AARQ (${aarq.length} bytes): ${hexDump(aarq)}`);
  socket.write(packet);

  const response = await waitForResponse(socket, APDU_TAGS.AARE);

  if (response.timeout) {
    log('  TIMEOUT - No AARE response for SN association');
    return { success: false, reason: 'no-response' };
  }

  log(`  AARE received: ${response.rawHex}`);
  const aare = parseAare(response.payload);
  log(`  Association result: ${aare.associationResult} (${aare.accepted ? 'ACCEPTED' : 'REJECTED'})`);

  if (aare.accepted) {
    log('  ✓ SN association established successfully');
    return { success: true };
  } else {
    log(`  ✗ SN association rejected`);
    return { success: false, reason: 'rejected' };
  }
}

/**
 * Phase 4: Probe SN base addresses with READ.request
 */
async function phaseSnProbing(socket) {
  log('\n' + '═'.repeat(70));
  log('PHASE 4: SN BASE ADDRESS PROBING');
  log('═'.repeat(70));

  let successCount = 0;

  for (const addr of SN_BASE_ADDRESSES) {
    if (disconnected) break;

    const addrHex = `0x${addr.toString(16).padStart(4, '0')}`;
    log(`\n  Probing SN address: ${addrHex}`);

    const readReq = buildSnReadRequest(addr);
    const packet = wrapWithIvy(IVY_DESTINATION, readReq);

    log(`    READ.request: ${hexDump(readReq)}`);
    socket.write(packet);

    // SN READ.response tag is 0x0C
    const response = await waitForResponse(socket, 0x0C);

    if (response.timeout) {
      log(`    TIMEOUT`);
      snResults.push({
        address: addrHex,
        result: 'timeout',
        error: null,
        data: null,
        rawHex: null,
      });
    } else {
      log(`    Response: ${response.rawHex}`);
      const parsed = parseSnReadResponse(response.payload);

      if (parsed.items.length > 0) {
        const item = parsed.items[0];
        if (item.accessResult === 'success') {
          const formatted = formatDlmsValue(item.data);
          log(`    ✓ SUCCESS! Value: ${formatted}`);
          snResults.push({
            address: addrHex,
            result: 'success',
            error: null,
            data: item.data,
            rawHex: response.rawHex,
          });
          successCount++;
        } else {
          log(`    ✗ Error: ${item.errorName || item.accessResult}`);
          snResults.push({
            address: addrHex,
            result: 'error',
            error: item.errorName || item.accessResult,
            data: null,
            rawHex: response.rawHex,
          });
        }
      } else {
        log(`    ? No items in response`);
        snResults.push({
          address: addrHex,
          result: 'empty',
          error: 'no items',
          data: null,
          rawHex: response.rawHex,
        });
      }
    }

    await sleep(PROBE_GAP_MS);
  }

  log(`\n  SN probing complete: ${successCount}/${SN_BASE_ADDRESSES.length} addresses responded successfully`);
  return successCount;
}

// ─── Phase 5: Summary Report ────────────────────────────────────────────────

function printSummary() {
  log('\n\n' + '═'.repeat(70));
  log('PHASE 5: PROBE RESULTS SUMMARY');
  log('═'.repeat(70));

  // ── LN Results ──
  if (lnResults.length > 0) {
    log('\n── LN (Logical Name) OBIS Results ──\n');

    const header = [
      'OBIS Code'.padEnd(20),
      'Cls'.padEnd(4),
      'Name'.padEnd(35),
      'Result'.padEnd(12),
      'Details',
    ].join(' | ');
    log(header);
    log('─'.repeat(header.length));

    // Deduplicate: show last result per OBIS (which is typically the most informative)
    const obisMap = new Map();
    for (const r of lnResults) {
      const key = r.obis;
      if (r.result === 'success') {
        obisMap.set(key, r); // Success always wins
      } else if (!obisMap.has(key) || obisMap.get(key).result !== 'success') {
        obisMap.set(key, r);
      }
    }

    for (const [, r] of obisMap) {
      let details = '';
      if (r.result === 'success') {
        details = formatDlmsValue(r.data);
      } else if (r.result === 'error') {
        details = r.error;
      } else if (r.result === 'timeout') {
        details = 'no response';
      } else {
        details = r.error || '';
      }

      const resultIcon = r.result === 'success' ? 'OK' : r.result === 'timeout' ? 'TMOUT' : 'FAIL';

      const row = [
        r.obis.padEnd(20),
        String(r.classId).padEnd(4),
        r.name.padEnd(35),
        resultIcon.padEnd(12),
        details,
      ].join(' | ');
      log(row);
    }

    // Successful entries
    const successEntries = lnResults.filter(r => r.result === 'success');
    // Deduplicate by OBIS
    const uniqueSuccess = new Map();
    for (const r of successEntries) {
      uniqueSuccess.set(r.obis, r);
    }

    if (uniqueSuccess.size > 0) {
      log('\n── Copy-Paste Ready: DLMS_POLL_REGISTERS Entries ──\n');
      log('// Add these to src/services/polling-manager.js DLMS_POLL_REGISTERS:');
      for (const [, r] of uniqueSuccess) {
        log(`    { classId: ${r.classId}, obisCode: '${r.obis}', name: '${r.name}' },`);
      }
    }
  }

  // ── SN Results ──
  if (snResults.length > 0) {
    log('\n── SN (Short Name) Base Address Results ──\n');

    const header = [
      'Address'.padEnd(10),
      'Result'.padEnd(12),
      'Details',
    ].join(' | ');
    log(header);
    log('─'.repeat(header.length));

    for (const r of snResults) {
      let details = '';
      if (r.result === 'success') {
        details = formatDlmsValue(r.data);
      } else if (r.result === 'error') {
        details = r.error;
      } else if (r.result === 'timeout') {
        details = 'no response';
      } else {
        details = r.error || '';
      }

      const resultIcon = r.result === 'success' ? 'OK' : r.result === 'timeout' ? 'TMOUT' : 'FAIL';

      const row = [
        r.address.padEnd(10),
        resultIcon.padEnd(12),
        details,
      ].join(' | ');
      log(row);
    }

    const snSuccess = snResults.filter(r => r.result === 'success');
    if (snSuccess.length > 0) {
      log(`\n  Working SN base addresses: ${snSuccess.map(r => r.address).join(', ')}`);
    }
  }

  // ── Overall Summary ──
  log('\n── Overall Summary ──\n');

  const lnSuccess = new Map();
  for (const r of lnResults.filter(r => r.result === 'success')) {
    lnSuccess.set(r.obis, r);
  }
  const snSuccess = snResults.filter(r => r.result === 'success');

  if (lnSuccess.size > 0) {
    log(`  LN: ${lnSuccess.size} OBIS codes working`);
    for (const [obis, r] of lnSuccess) {
      log(`    - ${obis} (class ${r.classId}): ${r.name}`);
    }
  } else if (lnResults.length > 0) {
    log('  LN: No working OBIS codes found');
  } else {
    log('  LN: Not tested (association failed or no data)');
  }

  if (snSuccess.length > 0) {
    log(`  SN: ${snSuccess.length} base addresses working`);
  } else if (snResults.length > 0) {
    log('  SN: No working base addresses found');
  }

  if (lnSuccess.size === 0 && snSuccess.length === 0) {
    log('\n  SUGGESTION: The meter may only support passive/push mode');
    log('  (EventNotification/DataNotification) rather than active querying.');
    log('  Check if EventNotification packets are being received during normal operation.');
  }

  log('\n' + '═'.repeat(70));
}

// ─── Main Probe Runner ─────────────────────────────────────────────────────

async function runProbes(socket) {
  log('\n' + '═'.repeat(70));
  log('STARTING DLMS OBIS PROBE SEQUENCE');
  log(`Meter address: ${meterAddress}`);
  log(`OBIS codes to probe: ${OBIS_PROBE_LIST.length}`);
  log(`SN base addresses to probe: ${SN_BASE_ADDRESSES.length}`);
  log('═'.repeat(70));

  // Phase 1: LN Association
  const lnAssoc = await phaseLnAssociation(socket);

  if (lnAssoc.success) {
    // Phase 2: LN OBIS Probing
    const lnCount = await phaseLnProbing(socket);

    // Release LN association
    if (!disconnected) {
      await releaseAssociation(socket);
      await sleep(2000); // Give meter time to process release
    }

    // Phase 3 & 4: Only if LN probing failed broadly
    if (lnCount === 0 && !disconnected) {
      log('\n  LN probing found no working OBIS codes. Trying SN mode...');
      await sleep(2000);

      const snAssoc = await phaseSnAssociation(socket);
      if (snAssoc.success) {
        await phaseSnProbing(socket);
        if (!disconnected) {
          await releaseAssociation(socket);
        }
      }
    }
  } else {
    // LN association failed - try SN directly
    log('\n  LN association failed. Trying SN mode...');
    await sleep(2000);

    const snAssoc = await phaseSnAssociation(socket);
    if (snAssoc.success) {
      await phaseSnProbing(socket);
      if (!disconnected) {
        await releaseAssociation(socket);
      }
    }
  }

  // Phase 5: Summary
  printSummary();
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
    lnResults = [];
    snResults = [];

    let heartbeatReceived = false;
    let heartbeatDataBuffer = Buffer.alloc(0);

    const heartbeatPhaseHandler = (data) => {
      log(`<< Received ${data.length} bytes: ${hexDump(data)}`);
      heartbeatDataBuffer = Buffer.concat([heartbeatDataBuffer, data]);

      while (heartbeatDataBuffer.length >= HEARTBEAT_PACKET_LENGTH) {
        if (isHeartbeat(heartbeatDataBuffer)) {
          const addr = parseHeartbeat(heartbeatDataBuffer);
          log(`\nHEARTBEAT detected! Meter address: ${addr}`);
          meterAddress = addr;
          heartbeatReceived = true;

          heartbeatDataBuffer = heartbeatDataBuffer.subarray(HEARTBEAT_PACKET_LENGTH);
          socket.removeListener('data', heartbeatPhaseHandler);

          if (heartbeatDataBuffer.length > 0) {
            log(`Remaining buffer after heartbeat (${heartbeatDataBuffer.length} bytes): ${hexDump(heartbeatDataBuffer)}`);
          }

          log('\nWaiting 2s before starting DLMS probes...');
          setTimeout(() => {
            runProbes(socket).then(() => {
              log('\nProbe sequence complete. Keeping connection open for observation.');
              log('Press Ctrl+C to exit.');

              socket.on('data', (d) => {
                log(`<< Post-probe data (${d.length} bytes): ${hexDump(d)}`);
                if (isHeartbeat(d)) {
                  log('   Type: heartbeat');
                } else {
                  const extracted = extractDlmsPayload(d);
                  if (extracted) {
                    const tagName = APDU_TAG_NAMES[extracted.tag] || `0x${extracted.tag.toString(16)}`;
                    log(`   Type: ${tagName}`);
                  } else {
                    log('   Type: unknown');
                  }
                }
              });
            }).catch((err) => {
              log(`Probe error: ${err.message}`);
              log(err.stack);
              printSummary();
            });
          }, 2000);

          return;
        }

        const ivyStart = findIvySignature(heartbeatDataBuffer, 1);
        if (ivyStart > 0) {
          log(`Skipping ${ivyStart} non-heartbeat bytes`);
          heartbeatDataBuffer = heartbeatDataBuffer.subarray(ivyStart);
        } else {
          if (heartbeatDataBuffer.length > 100) {
            log(`Discarding ${heartbeatDataBuffer.length - 4} bytes (no heartbeat found)`);
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

      // Print partial results if we have any
      if (lnResults.length > 0 || snResults.length > 0) {
        log('\nMeter disconnected during probing. Printing partial results...');
        printSummary();
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
    log('═'.repeat(70));
    log('DLMS OBIS CODE DISCOVERY PROBE');
    log('═'.repeat(70));
    log(`TCP server listening on port ${TCP_PORT}`);
    log('Waiting for meter to connect...');
    log('');
    log('This script will:');
    log('  1. Wait for a meter heartbeat to detect meter address');
    log('  2. Attempt LN association (AARQ with LN_NO_CIPHER)');
    log('  3. Probe each OBIS code with GET.request (retrying alt class IDs)');
    log('  4. If LN fails, attempt SN association (SN_NO_CIPHER)');
    log('  5. Probe common SN base addresses with READ.request');
    log('  6. Print summary with copy-paste-ready DLMS_POLL_REGISTERS entries');
    log('');
    log('Make sure the gateway is stopped: sudo systemctl stop ivy-gateway');
    log('═'.repeat(70));
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('\n\nShutting down...');
    if (lnResults.length > 0 || snResults.length > 0) {
      printSummary();
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
