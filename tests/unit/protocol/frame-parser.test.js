/**
 * Frame Parser Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
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
} from '../../../src/protocol/frame-parser.js';

import {
  buildReadFrame,
  buildSimpleRelayFrame,
  buildReadAddressFrame,
} from '../../../src/protocol/frame-builder.js';

import { appendChecksum } from '../../../src/protocol/checksum.js';
import { applyOffset, addressToBuffer } from '../../../src/protocol/bcd.js';
import {
  CONTROL_CODES,
  ENERGY_REGISTERS,
  INSTANTANEOUS_REGISTERS,
} from '../../../src/protocol/registers.js';

/**
 * Build a mock read response frame
 */
const buildMockReadResponse = (address, dataId, valueBuffer) => {
  const header = Buffer.alloc(10);
  header[0] = 0x68;
  addressToBuffer(address).copy(header, 1);
  header[7] = 0x68;
  header[8] = CONTROL_CODES.READ_DATA_RESPONSE; // 0x91

  // Data: DI (4 bytes) + Value
  const diBuffer = Buffer.alloc(4);
  diBuffer[0] = dataId & 0xff;
  diBuffer[1] = (dataId >> 8) & 0xff;
  diBuffer[2] = (dataId >> 16) & 0xff;
  diBuffer[3] = (dataId >> 24) & 0xff;

  const data = Buffer.concat([applyOffset(diBuffer), applyOffset(valueBuffer)]);
  header[9] = data.length;

  const frameWithoutChecksum = Buffer.concat([header, data]);
  return appendChecksum(frameWithoutChecksum);
};

/**
 * Build a mock error response frame
 */
const buildMockErrorResponse = (address, errorCode) => {
  const header = Buffer.alloc(10);
  header[0] = 0x68;
  addressToBuffer(address).copy(header, 1);
  header[7] = 0x68;
  header[8] = CONTROL_CODES.READ_DATA_ERROR; // 0xD1

  // Error code with offset
  const data = Buffer.from([errorCode + 0x33]);
  header[9] = data.length;

  const frameWithoutChecksum = Buffer.concat([header, data]);
  return appendChecksum(frameWithoutChecksum);
};

describe('Frame Parser', () => {
  describe('parseFrame', () => {
    it('should parse a valid response frame', () => {
      // Build mock response: address 000000001234, voltage 220.5V (raw: 2205 = 0x22 0x05 BCD)
      const valueBuffer = Buffer.from([0x05, 0x22]); // 2205 in BCD little-endian
      const frame = buildMockReadResponse('000000001234', 0x02010100, valueBuffer);

      const result = parseFrame(frame);

      expect(result.address).toBe('000000001234');
      expect(result.controlCode).toBe(0x91);
      expect(result.isResponse).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.dataLength).toBe(6); // DI(4) + Value(2)
    });

    it('should throw on invalid frame structure', () => {
      const badFrame = Buffer.from([0x00, 0x01, 0x02]);
      expect(() => parseFrame(badFrame)).toThrow('Invalid frame structure');
    });

    it('should throw on checksum error', () => {
      const valueBuffer = Buffer.from([0x05, 0x22]);
      const frame = buildMockReadResponse('000000001234', 0x02010100, valueBuffer);
      // Corrupt checksum
      frame[frame.length - 2] = 0x00;
      expect(() => parseFrame(frame)).toThrow('Checksum error');
    });
  });

  describe('extractAddress', () => {
    it('should extract meter address from frame', () => {
      const valueBuffer = Buffer.from([0x00]);
      const frame = buildMockReadResponse('000000001234', 0x00000000, valueBuffer);

      const address = extractAddress(frame);
      expect(address).toBe('000000001234');
    });

    it('should extract different addresses correctly', () => {
      const valueBuffer = Buffer.from([0x00]);
      const frame = buildMockReadResponse('123456789012', 0x00000000, valueBuffer);

      const address = extractAddress(frame);
      expect(address).toBe('123456789012');
    });

    it('should throw on short frame', () => {
      const shortFrame = Buffer.from([0x68, 0x12, 0x34]);
      expect(() => extractAddress(shortFrame)).toThrow('Frame too short');
    });
  });

  describe('extractControlCode', () => {
    it('should classify response codes', () => {
      const valueBuffer = Buffer.from([0x00]);
      const frame = buildMockReadResponse('000000001234', 0x00000000, valueBuffer);

      const control = extractControlCode(frame);
      expect(control.code).toBe(0x91);
      expect(control.isResponse).toBe(true);
      expect(control.isError).toBe(false);
      expect(control.requestCode).toBe(0x11);
      expect(control.type).toBe('READ_DATA');
    });

    it('should classify error codes', () => {
      const frame = buildMockErrorResponse('000000001234', 0x02);

      const control = extractControlCode(frame);
      expect(control.code).toBe(0xd1);
      expect(control.isResponse).toBe(true);
      expect(control.isError).toBe(true);
      expect(control.requestCode).toBe(0x11);
    });

    it('should classify request codes', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);

      const control = extractControlCode(frame);
      expect(control.code).toBe(0x11);
      expect(control.isResponse).toBe(false);
      expect(control.isError).toBe(false);
    });
  });

  describe('extractData', () => {
    it('should extract data with offset removed', () => {
      const valueBuffer = Buffer.from([0x56, 0x34, 0x12, 0x00]); // 123456 in BCD
      const frame = buildMockReadResponse('000000001234', 0x00000000, valueBuffer);

      const data = extractData(frame);

      // Data should have offset removed
      // First 4 bytes are DI (0x00000000), next are value
      expect(data.length).toBe(8);
    });

    it('should handle empty data', () => {
      const frame = buildReadAddressFrame();
      const data = extractData(frame);
      expect(data.length).toBe(0);
    });
  });

  describe('parseReadResponse', () => {
    it('should parse voltage reading', () => {
      // Voltage 220.5V = raw 2205 = BCD 0x22 0x05
      const valueBuffer = Buffer.from([0x05, 0x22]); // Little-endian BCD
      const frame = buildMockReadResponse('000000001234', 0x02010100, valueBuffer);

      const result = parseReadResponse(frame, INSTANTANEOUS_REGISTERS.VOLTAGE_A);

      expect(result.success).toBe(true);
      expect(result.dataId).toBe(0x02010100);
      expect(result.rawValue).toBe(2205);
      expect(result.value).toBeCloseTo(220.5);
      expect(result.unit).toBe('V');
    });

    it('should parse energy reading', () => {
      // Energy 12345.67 kWh = raw 1234567 = BCD 0x67 0x45 0x23 0x01
      const valueBuffer = Buffer.from([0x67, 0x45, 0x23, 0x01]); // Little-endian BCD
      const frame = buildMockReadResponse('000000001234', 0x00000000, valueBuffer);

      const result = parseReadResponse(frame, ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE);

      expect(result.success).toBe(true);
      expect(result.rawValue).toBe(1234567);
      expect(result.value).toBeCloseTo(12345.67);
      expect(result.unit).toBe('kWh');
    });

    it('should auto-detect register by dataId', () => {
      const valueBuffer = Buffer.from([0x05, 0x22]);
      const frame = buildMockReadResponse('000000001234', 0x02010100, valueBuffer);

      const result = parseReadResponse(frame);

      expect(result.success).toBe(true);
      expect(result.register).not.toBeNull();
      expect(result.register.unit).toBe('V');
    });

    it('should handle error response', () => {
      const frame = buildMockErrorResponse('000000001234', 0x02);

      const result = parseReadResponse(frame);

      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe(0x02);
    });
  });

  describe('parseWriteResponse', () => {
    it('should parse successful write response', () => {
      // Build write response frame
      const header = Buffer.alloc(10);
      header[0] = 0x68;
      addressToBuffer('000000001234').copy(header, 1);
      header[7] = 0x68;
      header[8] = CONTROL_CODES.WRITE_DATA_RESPONSE;
      header[9] = 0;

      const frame = appendChecksum(header);
      const result = parseWriteResponse(frame);

      expect(result.success).toBe(true);
      expect(result.address).toBe('000000001234');
    });
  });

  describe('parseRelayResponse', () => {
    it('should parse successful relay response', () => {
      const header = Buffer.alloc(10);
      header[0] = 0x68;
      addressToBuffer('000000001234').copy(header, 1);
      header[7] = 0x68;
      header[8] = CONTROL_CODES.RELAY_CONTROL_RESPONSE;
      header[9] = 0;

      const frame = appendChecksum(header);
      const result = parseRelayResponse(frame);

      expect(result.success).toBe(true);
      expect(result.address).toBe('000000001234');
    });
  });

  describe('parseErrorResponse', () => {
    it('should parse error code 0x01', () => {
      const frame = buildMockErrorResponse('000000001234', 0x01);
      const result = parseErrorResponse(frame);

      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe(0x01);
      expect(result.errorMessage).toContain('Other error');
    });

    it('should parse error code 0x02', () => {
      const frame = buildMockErrorResponse('000000001234', 0x02);
      const result = parseErrorResponse(frame);

      expect(result.errorCode).toBe(0x02);
      expect(result.errorMessage).toContain('No data requested');
    });

    it('should parse error code 0x04', () => {
      const frame = buildMockErrorResponse('000000001234', 0x04);
      const result = parseErrorResponse(frame);

      expect(result.errorCode).toBe(0x04);
      expect(result.errorMessage).toContain('Password error');
    });
  });

  describe('parseTelemetryData', () => {
    it('should parse voltage data', () => {
      const buffer = Buffer.from([0x05, 0x22]); // 2205 BCD
      const result = parseTelemetryData(buffer, INSTANTANEOUS_REGISTERS.VOLTAGE_A);

      expect(result.rawValue).toBe(2205);
      expect(result.value).toBeCloseTo(220.5);
      expect(result.unit).toBe('V');
    });

    it('should handle null register', () => {
      const buffer = Buffer.from([0x05, 0x22]);
      const result = parseTelemetryData(buffer, null);

      expect(result.rawValue).toBe(2205);
      expect(result.value).toBe(2205);
      expect(result.unit).toBeNull();
    });
  });

  describe('buildTelemetryObject', () => {
    it('should build telemetry from multiple responses', () => {
      const responses = [
        {
          success: true,
          address: '000000001234',
          dataId: 0x00000000,
          register: { key: 'TOTAL_ACTIVE_POSITIVE', name: 'Total Energy', unit: 'kWh' },
          value: 12345.67,
          unit: 'kWh',
        },
        {
          success: true,
          address: '000000001234',
          dataId: 0x02010100,
          register: { key: 'VOLTAGE_A', name: 'Voltage A', unit: 'V' },
          value: 220.5,
          unit: 'V',
        },
      ];

      const telemetry = buildTelemetryObject(responses);

      expect(telemetry.address).toBe('000000001234');
      expect(telemetry.energy.TOTAL_ACTIVE_POSITIVE).toBeDefined();
      expect(telemetry.energy.TOTAL_ACTIVE_POSITIVE.value).toBe(12345.67);
      expect(telemetry.instantaneous.VOLTAGE_A).toBeDefined();
      expect(telemetry.instantaneous.VOLTAGE_A.value).toBe(220.5);
      expect(telemetry.errors).toHaveLength(0);
    });

    it('should collect errors', () => {
      const responses = [
        {
          success: false,
          dataId: 0x00000000,
          errorCode: 0x02,
          errorMessage: 'No data requested',
        },
      ];

      const telemetry = buildTelemetryObject(responses);

      expect(telemetry.errors).toHaveLength(1);
      expect(telemetry.errors[0].errorCode).toBe(0x02);
    });
  });

  describe('isCompleteFrame', () => {
    it('should detect complete frame', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      const result = isCompleteFrame(frame);

      expect(result.isComplete).toBe(true);
      expect(result.frameLength).toBe(frame.length);
    });

    it('should detect incomplete frame', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      const partial = frame.subarray(0, 10);
      const result = isCompleteFrame(partial);

      expect(result.isComplete).toBe(false);
    });

    it('should detect short buffer', () => {
      const buffer = Buffer.from([0x68, 0x12]);
      const result = isCompleteFrame(buffer);

      expect(result.isComplete).toBe(false);
    });

    it('should detect invalid start delimiter', () => {
      const buffer = Buffer.alloc(12, 0x00);
      const result = isCompleteFrame(buffer);

      expect(result.isComplete).toBe(false);
      expect(result.error).toBe('No start delimiter');
    });
  });

  describe('findFrameStart', () => {
    it('should find frame start at beginning', () => {
      const buffer = Buffer.from([0x68, 0x12, 0x34]);
      expect(findFrameStart(buffer)).toBe(0);
    });

    it('should find frame start after garbage', () => {
      const buffer = Buffer.from([0x00, 0x00, 0x68, 0x12]);
      expect(findFrameStart(buffer)).toBe(2);
    });

    it('should return -1 if not found', () => {
      const buffer = Buffer.from([0x00, 0x01, 0x02]);
      expect(findFrameStart(buffer)).toBe(-1);
    });

    it('should start from specified index', () => {
      const buffer = Buffer.from([0x68, 0x00, 0x68, 0x12]);
      expect(findFrameStart(buffer, 1)).toBe(2);
    });
  });

  describe('createStreamParser', () => {
    let onFrame;
    let onError;
    let parser;

    beforeEach(() => {
      onFrame = vi.fn();
      onError = vi.fn();
      parser = createStreamParser(onFrame, onError);
    });

    it('should parse complete frame in one chunk', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      parser.push(frame);

      expect(onFrame).toHaveBeenCalledTimes(1);
      expect(onFrame.mock.calls[0][0].address).toBe('000000001234');
    });

    it('should handle partial frames', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      const part1 = frame.subarray(0, 8);
      const part2 = frame.subarray(8);

      parser.push(part1);
      expect(onFrame).not.toHaveBeenCalled();

      parser.push(part2);
      expect(onFrame).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple frames in one chunk', () => {
      const frame1 = buildReadFrame('000000001234', 0x00000000);
      const frame2 = buildReadFrame('000000005678', 0x02010100);
      const combined = Buffer.concat([frame1, frame2]);

      parser.push(combined);

      expect(onFrame).toHaveBeenCalledTimes(2);
    });

    it('should skip garbage before frame', () => {
      const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const frame = buildReadFrame('000000001234', 0x00000000);
      const combined = Buffer.concat([garbage, frame]);

      parser.push(combined);

      expect(onFrame).toHaveBeenCalledTimes(1);
    });

    it('should track buffer length', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      const partial = frame.subarray(0, 10);

      parser.push(partial);
      expect(parser.getBufferLength()).toBe(10);
    });

    it('should track frame count', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      parser.push(frame);
      parser.push(frame);

      expect(parser.getFrameCount()).toBe(2);
    });

    it('should reset state', () => {
      const frame = buildReadFrame('000000001234', 0x00000000);
      const partial = frame.subarray(0, 10);

      parser.push(partial);
      expect(parser.getBufferLength()).toBe(10);

      parser.reset();
      expect(parser.getBufferLength()).toBe(0);
    });

    it('should call error handler on parse error', () => {
      // Create frame with bad checksum
      const frame = buildReadFrame('000000001234', 0x00000000);
      frame[frame.length - 2] = 0x00; // Corrupt checksum

      parser.push(frame);

      expect(onError).toHaveBeenCalled();
    });
  });

  describe('describeResponse', () => {
    it('should describe read response', () => {
      const valueBuffer = Buffer.from([0x05, 0x22]);
      const frame = buildMockReadResponse('000000001234', 0x02010100, valueBuffer);

      const desc = describeResponse(frame);

      expect(desc.address).toBe('000000001234');
      expect(desc.type).toBe('READ_DATA');
      expect(desc.isResponse).toBe(true);
      expect(desc.value).toBeCloseTo(220.5);
      expect(desc.unit).toBe('V');
    });

    it('should describe error response', () => {
      const frame = buildMockErrorResponse('000000001234', 0x02);

      const desc = describeResponse(frame);

      expect(desc.isError).toBe(true);
      expect(desc.errorCode).toBe(0x02);
      expect(desc.errorMessage).toContain('No data requested');
    });

    it('should handle invalid frame gracefully', () => {
      const badFrame = Buffer.from([0x00, 0x01, 0x02]);

      const desc = describeResponse(badFrame);

      expect(desc.error).toBeDefined();
    });
  });

  describe('Round-trip Tests', () => {
    it('should parse frames built by frame-builder', () => {
      const requestFrame = buildReadFrame('000000001234', 0x02010100);

      // Verify we can parse the request
      const parsed = parseFrame(requestFrame);

      expect(parsed.address).toBe('000000001234');
      expect(parsed.controlCode).toBe(0x11);
      expect(parsed.isResponse).toBe(false);
    });

    it('should parse relay frame built by frame-builder', () => {
      const relayFrame = buildSimpleRelayFrame('000000001234', 'trip');

      const parsed = parseFrame(relayFrame);

      expect(parsed.address).toBe('000000001234');
      expect(parsed.controlCode).toBe(0x1c);
    });
  });

  describe('Edge Cases', () => {
    it('should handle maximum length address', () => {
      const valueBuffer = Buffer.from([0x00]);
      const frame = buildMockReadResponse('999999999999', 0x00000000, valueBuffer);

      const result = parseReadResponse(frame);

      expect(result.address).toBe('999999999999');
    });

    it('should handle zero value', () => {
      const valueBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      const frame = buildMockReadResponse('000000001234', 0x00000000, valueBuffer);

      const result = parseReadResponse(frame);

      expect(result.rawValue).toBe(0);
      expect(result.value).toBe(0);
    });

    it('should handle large values', () => {
      // 99999999 = max 4-byte BCD
      const valueBuffer = Buffer.from([0x99, 0x99, 0x99, 0x99]);
      const frame = buildMockReadResponse('000000001234', 0x00000000, valueBuffer);

      const result = parseReadResponse(frame);

      expect(result.rawValue).toBe(99999999);
    });
  });
});
