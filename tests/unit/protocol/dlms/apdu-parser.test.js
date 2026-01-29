/**
 * DLMS APDU Parser Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  APDU_TAGS,
  DATA_ACCESS_RESULT_NAMES,
  parseApdu,
  parseEventNotification,
  parseDataNotification,
  parseGetResponse,
  parseAare,
  parseExceptionResponse,
  extractTelemetry,
} from '../../../../src/protocol/dlms/apdu-parser.js';
import { DLMS_DATA_TYPES } from '../../../../src/protocol/dlms/data-types.js';

describe('DLMS APDU Parser', () => {
  describe('APDU_TAGS', () => {
    it('should define all expected tag constants', () => {
      expect(APDU_TAGS.EVENT_NOTIFICATION).toBe(0xC2);
      expect(APDU_TAGS.DATA_NOTIFICATION).toBe(0x0F);
      expect(APDU_TAGS.GET_RESPONSE).toBe(0xC4);
      expect(APDU_TAGS.AARE).toBe(0x61);
      expect(APDU_TAGS.RLRE).toBe(0x63);
      expect(APDU_TAGS.EXCEPTION_RESPONSE).toBe(0xD8);
    });
  });

  describe('parseApdu', () => {
    it('should dispatch EventNotification (0xC2)', () => {
      // Minimal EventNotification: tag + classId(2) + obis(6) + attrIdx(1) + null-data(1)
      const buf = Buffer.from([
        0xC2,
        0x00, 0x03, // classId = 3 (Register)
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: 1-0:1.8.0.255
        0x02, // attributeIndex
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x10, 0x00, // value
      ]);
      const result = parseApdu(buf);
      expect(result.type).toBe('event-notification');
      expect(result.tag).toBe(0xC2);
    });

    it('should dispatch DataNotification (0x0F)', () => {
      const buf = Buffer.from([
        0x0F,
        0x00, 0x00, 0x00, 0x01, // invokeId
        0x00, // datetime length = 0
        DLMS_DATA_TYPES.NULL_DATA,
      ]);
      const result = parseApdu(buf);
      expect(result.type).toBe('data-notification');
    });

    it('should dispatch GET.response (0xC4)', () => {
      const buf = Buffer.from([
        0xC4,
        0x01, // response-normal
        0x01, // invokeId
        0x00, // choice: data
        DLMS_DATA_TYPES.UINT16, 0x00, 0xFF,
      ]);
      const result = parseApdu(buf);
      expect(result.type).toBe('get-response');
    });

    it('should dispatch AARE (0x61)', () => {
      const buf = Buffer.from([0x61, 0x00]);
      const result = parseApdu(buf);
      expect(result.type).toBe('aare');
    });

    it('should dispatch RLRE (0x63)', () => {
      const buf = Buffer.from([0x63, 0x00]);
      const result = parseApdu(buf);
      expect(result.type).toBe('rlre');
    });

    it('should return unknown for unrecognized tag', () => {
      const buf = Buffer.from([0xAA, 0x01, 0x02]);
      const result = parseApdu(buf);
      expect(result.type).toBe('unknown');
      expect(result.tag).toBe(0xAA);
    });

    it('should throw for empty buffer', () => {
      expect(() => parseApdu(Buffer.alloc(0))).toThrow();
    });

    it('should throw for null input', () => {
      expect(() => parseApdu(null)).toThrow();
    });
  });

  describe('parseEventNotification', () => {
    it('should parse EventNotification with classId, OBIS, and data', () => {
      const buf = Buffer.from([
        0xC2,
        0x00, 0x03, // classId = 3 (Register)
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: 1-0:1.8.0.255
        0x02, // attributeIndex
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10, // value = 10000
      ]);
      const result = parseEventNotification(buf);

      expect(result.type).toBe('event-notification');
      expect(result.classId).toBe(3);
      expect(result.obisCode).toBe('1-0:1.8.0.255');
      expect(result.obisInfo).not.toBeNull();
      expect(result.obisInfo.name).toBe('Total active energy import');
      expect(result.attributeIndex).toBe(2);
      expect(result.data.value).toBe(10000);
    });

    it('should parse EventNotification with OBIS length prefix', () => {
      const buf = Buffer.from([
        0xC2,
        0x00, 0x03, // classId
        0x06, // length prefix for OBIS
        0x01, 0x00, 0x20, 0x07, 0x00, 0xFF, // OBIS: 1-0:32.7.0.255
        0x02,
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // voltage = 230
      ]);
      const result = parseEventNotification(buf);
      expect(result.obisCode).toBe('1-0:32.7.0.255');
      expect(result.obisInfo.key).toBe('VOLTAGE_A');
    });

    it('should handle minimal EventNotification', () => {
      const buf = Buffer.from([0xC2]);
      const result = parseEventNotification(buf);
      expect(result.type).toBe('event-notification');
      expect(result.classId).toBeNull();
    });

    it('should preserve raw buffer', () => {
      const buf = Buffer.from([0xC2, 0x00, 0x01]);
      const result = parseEventNotification(buf);
      expect(result.raw).toBe(buf);
    });
  });

  describe('parseDataNotification', () => {
    it('should parse DataNotification with invokeId and no datetime', () => {
      const buf = Buffer.from([
        0x0F,
        0x00, 0x00, 0x00, 0x42, // invokeId = 66
        0x00, // datetime length = 0 (no datetime)
        DLMS_DATA_TYPES.UINT32, 0x00, 0x01, 0x00, 0x00, // value = 65536
      ]);
      const result = parseDataNotification(buf);

      expect(result.type).toBe('data-notification');
      expect(result.invokeId).toBe(66);
      expect(result.timestamp).toBeNull();
      expect(result.data.value).toBe(65536);
    });

    it('should parse DataNotification with datetime', () => {
      const dt = Buffer.alloc(12);
      dt.writeUInt16BE(2025, 0);
      dt[2] = 6;
      dt[3] = 15;
      dt[4] = 0xFF;
      dt[5] = 10;
      dt[6] = 30;
      dt[7] = 0;
      dt[8] = 0;
      dt.writeInt16BE(0, 9);
      dt[11] = 0;

      const buf = Buffer.concat([
        Buffer.from([
          0x0F,
          0x00, 0x00, 0x00, 0x01, // invokeId
          0x0C, // datetime length = 12
        ]),
        dt,
        Buffer.from([DLMS_DATA_TYPES.NULL_DATA]),
      ]);

      const result = parseDataNotification(buf);
      expect(result.timestamp).not.toBeNull();
      expect(result.timestamp.year).toBe(2025);
      expect(result.timestamp.month).toBe(6);
    });

    it('should handle DataNotification with structure data', () => {
      const buf = Buffer.from([
        0x0F,
        0x00, 0x00, 0x00, 0x01, // invokeId
        0x00, // no datetime
        DLMS_DATA_TYPES.STRUCTURE, 0x02,
        DLMS_DATA_TYPES.UINT16, 0x00, 0xFF,
        DLMS_DATA_TYPES.UINT8, 0x0A,
      ]);
      const result = parseDataNotification(buf);
      expect(result.data.typeName).toBe('STRUCTURE');
      expect(result.data.value).toHaveLength(2);
    });
  });

  describe('parseGetResponse', () => {
    it('should parse successful get-response-normal', () => {
      const buf = Buffer.from([
        0xC4,
        0x01, // response-normal
        0x05, // invokeId
        0x00, // choice: data (success)
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x03, 0xE8, // value = 1000
      ]);
      const result = parseGetResponse(buf);

      expect(result.type).toBe('get-response');
      expect(result.responseType).toBe(1);
      expect(result.invokeId).toBe(5);
      expect(result.accessResult).toBe('success');
      expect(result.data.value).toBe(1000);
    });

    it('should parse error get-response with errorName', () => {
      const buf = Buffer.from([
        0xC4,
        0x01, // response-normal
        0x05, // invokeId
        0x01, // choice: data-access-result (error)
        0x02, // read-write-denied
      ]);
      const result = parseGetResponse(buf);

      expect(result.accessResult).toBe('error');
      expect(result.data.errorCode).toBe(2);
      expect(result.data.errorName).toBe('temporary-failure');
    });

    it('should parse error get-response with unknown error code', () => {
      const buf = Buffer.from([
        0xC4,
        0x01, // response-normal
        0x05, // invokeId
        0x01, // choice: data-access-result (error)
        0xFF, // unknown error code
      ]);
      const result = parseGetResponse(buf);

      expect(result.accessResult).toBe('error');
      expect(result.data.errorCode).toBe(0xFF);
      expect(result.data.errorName).toBe('unknown(255)');
    });

    it('should handle minimal get-response', () => {
      const buf = Buffer.from([0xC4]);
      const result = parseGetResponse(buf);
      expect(result.type).toBe('get-response');
      expect(result.responseType).toBeNull();
    });
  });

  describe('parseAare', () => {
    it('should detect accepted association', () => {
      // Simplified AARE with association-result = 0 (accepted)
      const buf = Buffer.from([
        0x61, 0x20, // AARE tag + length
        0xA1, 0x09, // application context name
        0x06, 0x07, 0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x01,
        0xA2, 0x03, // result tag
        0x02, 0x01, 0x00, // INTEGER 0 = accepted
        0xA3, 0x05,
        0xA1, 0x03,
        0x02, 0x01, 0x00,
      ]);
      const result = parseAare(buf);
      expect(result.type).toBe('aare');
      expect(result.accepted).toBe(true);
    });

    it('should detect rejected association', () => {
      const buf = Buffer.from([
        0x61, 0x10,
        0xA2, 0x03, // result
        0x02, 0x01, 0x01, // INTEGER 1 = rejected-permanent
        0xA3, 0x05,
        0xA1, 0x03,
        0x02, 0x01, 0x00,
      ]);
      const result = parseAare(buf);
      expect(result.accepted).toBe(false);
    });
  });

  describe('parseExceptionResponse', () => {
    it('should parse state and service errors', () => {
      const buf = Buffer.from([0xD8, 0x01, 0x02]);
      const result = parseExceptionResponse(buf);

      expect(result.type).toBe('exception-response');
      expect(result.stateError).toBe(1);
      expect(result.serviceError).toBe(2);
    });
  });

  describe('extractTelemetry', () => {
    it('should extract telemetry from EventNotification with known OBIS', () => {
      const parsed = {
        type: 'event-notification',
        obisCode: '1-0:1.8.0.255',
        obisInfo: { name: 'Total active energy import', unit: 'kWh', key: 'TOTAL_ACTIVE_IMPORT' },
        classId: 3,
        timestamp: { iso: '2025-06-15T10:00:00' },
        data: { value: 12345 },
      };

      const result = extractTelemetry(parsed);
      expect(result).not.toBeNull();
      expect(result.source).toBe('dlms');
      expect(result.type).toBe('event-notification');
      expect(result.readings.TOTAL_ACTIVE_IMPORT.value).toBe(12345);
      expect(result.readings.TOTAL_ACTIVE_IMPORT.unit).toBe('kWh');
    });

    it('should extract telemetry from DataNotification', () => {
      const parsed = {
        type: 'data-notification',
        invokeId: 1,
        timestamp: { iso: '2025-06-15T10:00:00' },
        data: {
          typeName: 'STRUCTURE',
          value: [
            { typeName: 'UINT32', value: 100 },
            { typeName: 'UINT16', value: 230 },
          ],
        },
      };

      const result = extractTelemetry(parsed);
      expect(result).not.toBeNull();
      expect(result.source).toBe('dlms');
      expect(result.type).toBe('data-notification');
    });

    it('should extract from successful GET.response', () => {
      const parsed = {
        type: 'get-response',
        accessResult: 'success',
        data: { value: 42 },
      };

      const result = extractTelemetry(parsed);
      expect(result).not.toBeNull();
      expect(result.source).toBe('dlms');
    });

    it('should return null for error GET.response', () => {
      const parsed = {
        type: 'get-response',
        accessResult: 'error',
        data: { errorCode: 2 },
      };
      expect(extractTelemetry(parsed)).toBeNull();
    });

    it('should return null for unknown APDU type', () => {
      expect(extractTelemetry({ type: 'unknown' })).toBeNull();
    });

    it('should return null for null input', () => {
      expect(extractTelemetry(null)).toBeNull();
    });
  });

  describe('DATA_ACCESS_RESULT_NAMES', () => {
    it('should map known error codes', () => {
      expect(DATA_ACCESS_RESULT_NAMES[0]).toBe('success');
      expect(DATA_ACCESS_RESULT_NAMES[1]).toBe('hardware-fault');
      expect(DATA_ACCESS_RESULT_NAMES[3]).toBe('read-write-denied');
      expect(DATA_ACCESS_RESULT_NAMES[4]).toBe('object-undefined');
    });

    it('should have 14 entries (0-13)', () => {
      expect(Object.keys(DATA_ACCESS_RESULT_NAMES)).toHaveLength(14);
    });
  });

  describe('parseEventNotification multi-value', () => {
    it('should parse EventNotification with trailing DLMS values as STRUCTURE', () => {
      // EventNotification with first UINT16 value + additional UINT16 trailing
      const buf = Buffer.from([
        0xC2,
        0x00, 0x03, // classId = 3
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF, // OBIS: 1-0:1.8.0.255
        0x02, // attributeIndex
        DLMS_DATA_TYPES.UINT16, 0x00, 0xE6, // first value = 230
        DLMS_DATA_TYPES.UINT16, 0x01, 0x00, // trailing value = 256
      ]);
      const result = parseEventNotification(buf);

      expect(result.type).toBe('event-notification');
      expect(result.data.typeName).toBe('STRUCTURE');
      expect(result.data.value).toHaveLength(2);
      expect(result.data.value[0].value).toBe(230);
      expect(result.data.value[1].value).toBe(256);
    });

    it('should parse single-value EventNotification normally', () => {
      const buf = Buffer.from([
        0xC2,
        0x00, 0x03,
        0x01, 0x00, 0x01, 0x08, 0x00, 0xFF,
        0x02,
        DLMS_DATA_TYPES.UINT32, 0x00, 0x00, 0x27, 0x10, // value = 10000
      ]);
      const result = parseEventNotification(buf);

      expect(result.data.typeName).toBe('UINT32');
      expect(result.data.value).toBe(10000);
    });
  });
});
