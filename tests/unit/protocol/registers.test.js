/**
 * Data Registers & Constants Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  CONTROL_CODES,
  ERROR_CODES,
  REGISTER_CATEGORIES,
  ENERGY_REGISTERS,
  INSTANTANEOUS_REGISTERS,
  PARAMETER_REGISTERS,
  PREPAID_REGISTERS,
  ALL_REGISTERS,
  TELEMETRY_REGISTERS,
  RELAY_COMMANDS,
  BROADCAST_ADDRESS,
  findRegisterById,
  findRegisterByName,
  getRegistersByCategory,
  isResponseCode,
  isErrorResponse,
  getRequestCode,
  getResponseCode,
  getErrorResponseCode,
  parseErrorCode,
  formatDataId,
  toEngineeringUnits,
  fromEngineeringUnits,
} from '../../../src/protocol/registers.js';

describe('Data Registers & Constants', () => {
  describe('CONTROL_CODES', () => {
    it('should have correct request codes', () => {
      expect(CONTROL_CODES.READ_DATA).toBe(0x11);
      expect(CONTROL_CODES.WRITE_DATA).toBe(0x14);
      expect(CONTROL_CODES.RELAY_CONTROL).toBe(0x1c);
    });

    it('should have response codes = request + 0x80', () => {
      expect(CONTROL_CODES.READ_DATA_RESPONSE).toBe(CONTROL_CODES.READ_DATA + 0x80);
      expect(CONTROL_CODES.WRITE_DATA_RESPONSE).toBe(CONTROL_CODES.WRITE_DATA + 0x80);
      expect(CONTROL_CODES.RELAY_CONTROL_RESPONSE).toBe(CONTROL_CODES.RELAY_CONTROL + 0x80);
    });

    it('should have error codes = request + 0xC0', () => {
      expect(CONTROL_CODES.READ_DATA_ERROR).toBe(CONTROL_CODES.READ_DATA + 0xc0);
      expect(CONTROL_CODES.WRITE_DATA_ERROR).toBe(CONTROL_CODES.WRITE_DATA + 0xc0);
      expect(CONTROL_CODES.RELAY_CONTROL_ERROR).toBe(CONTROL_CODES.RELAY_CONTROL + 0xc0);
    });
  });

  describe('ERROR_CODES', () => {
    it('should have standard error codes defined', () => {
      expect(ERROR_CODES[0x01]).toBe('Other error');
      expect(ERROR_CODES[0x02]).toBe('No data requested');
      expect(ERROR_CODES[0x04]).toBe('Password error / Unauthorized');
    });
  });

  describe('REGISTER_CATEGORIES', () => {
    it('should have correct category values', () => {
      expect(REGISTER_CATEGORIES.ENERGY).toBe(0x00);
      expect(REGISTER_CATEGORIES.INSTANTANEOUS).toBe(0x02);
      expect(REGISTER_CATEGORIES.PARAMETERS).toBe(0x04);
    });
  });

  describe('ENERGY_REGISTERS', () => {
    it('should have total active energy register', () => {
      const reg = ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE;
      expect(reg.id).toBe(0x00000000);
      expect(reg.unit).toBe('kWh');
      expect(reg.resolution).toBe(0.01);
      expect(reg.bytes).toBe(4);
    });

    it('should have tariff registers', () => {
      expect(ENERGY_REGISTERS.TARIFF_1_ACTIVE.id).toBe(0x00010100);
      expect(ENERGY_REGISTERS.TARIFF_2_ACTIVE.id).toBe(0x00010200);
      expect(ENERGY_REGISTERS.TARIFF_3_ACTIVE.id).toBe(0x00010300);
      expect(ENERGY_REGISTERS.TARIFF_4_ACTIVE.id).toBe(0x00010400);
    });
  });

  describe('INSTANTANEOUS_REGISTERS', () => {
    it('should have voltage registers with correct resolution', () => {
      const voltage = INSTANTANEOUS_REGISTERS.VOLTAGE_A;
      expect(voltage.id).toBe(0x02010100);
      expect(voltage.unit).toBe('V');
      expect(voltage.resolution).toBe(0.1);
      expect(voltage.bytes).toBe(2);
    });

    it('should have current registers with correct resolution', () => {
      const current = INSTANTANEOUS_REGISTERS.CURRENT_A;
      expect(current.id).toBe(0x02020100);
      expect(current.unit).toBe('A');
      expect(current.resolution).toBe(0.001);
      expect(current.bytes).toBe(3);
    });

    it('should have signed power registers', () => {
      const power = INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL;
      expect(power.id).toBe(0x02030000);
      expect(power.signed).toBe(true);
      expect(power.unit).toBe('W');
    });

    it('should have frequency register', () => {
      const freq = INSTANTANEOUS_REGISTERS.FREQUENCY;
      expect(freq.id).toBe(0x02800002);
      expect(freq.unit).toBe('Hz');
      expect(freq.resolution).toBe(0.01);
    });
  });

  describe('PARAMETER_REGISTERS', () => {
    it('should have relay status register', () => {
      const relay = PARAMETER_REGISTERS.RELAY_STATUS;
      expect(relay.id).toBe(0x04000501);
      expect(relay.values).toBeDefined();
      expect(relay.values[0x00]).toBe('Closed');
      expect(relay.values[0x01]).toBe('Open');
    });
  });

  describe('PREPAID_REGISTERS', () => {
    it('should have balance registers', () => {
      expect(PREPAID_REGISTERS.BALANCE_ENERGY.id).toBe(0x00900100);
      expect(PREPAID_REGISTERS.BALANCE_ENERGY.unit).toBe('kWh');
    });
  });

  describe('ALL_REGISTERS', () => {
    it('should contain all individual registers', () => {
      expect(ALL_REGISTERS.TOTAL_ACTIVE_POSITIVE).toBeDefined();
      expect(ALL_REGISTERS.VOLTAGE_A).toBeDefined();
      expect(ALL_REGISTERS.RELAY_STATUS).toBeDefined();
      expect(ALL_REGISTERS.BALANCE_ENERGY).toBeDefined();
    });

    it('should have more than 20 registers', () => {
      expect(Object.keys(ALL_REGISTERS).length).toBeGreaterThan(20);
    });
  });

  describe('TELEMETRY_REGISTERS', () => {
    it('should be an array of common registers', () => {
      expect(Array.isArray(TELEMETRY_REGISTERS)).toBe(true);
      expect(TELEMETRY_REGISTERS.length).toBeGreaterThan(5);
    });

    it('should include essential readings', () => {
      const ids = TELEMETRY_REGISTERS.map((r) => r.id);
      expect(ids).toContain(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      expect(ids).toContain(INSTANTANEOUS_REGISTERS.VOLTAGE_A.id);
      expect(ids).toContain(INSTANTANEOUS_REGISTERS.CURRENT_A.id);
    });
  });

  describe('RELAY_COMMANDS', () => {
    it('should have trip and close commands', () => {
      expect(RELAY_COMMANDS.TRIP).toBe(0x1a);
      expect(RELAY_COMMANDS.CLOSE).toBe(0x1b);
    });
  });

  describe('BROADCAST_ADDRESS', () => {
    it('should be 12 nines', () => {
      expect(BROADCAST_ADDRESS).toBe('999999999999');
      expect(BROADCAST_ADDRESS.length).toBe(12);
    });
  });

  describe('findRegisterById', () => {
    it('should find register by Data Identifier', () => {
      const result = findRegisterById(0x00000000);
      expect(result).not.toBeNull();
      expect(result.name).toBe('Total Active Energy (Import)');
    });

    it('should find voltage register', () => {
      const result = findRegisterById(0x02010100);
      expect(result).not.toBeNull();
      expect(result.key).toBe('VOLTAGE_A');
    });

    it('should return null for unknown ID', () => {
      const result = findRegisterById(0xffffffff);
      expect(result).toBeNull();
    });
  });

  describe('findRegisterByName', () => {
    it('should find register by partial name match', () => {
      const result = findRegisterByName('voltage');
      expect(result).not.toBeNull();
      expect(result.unit).toBe('V');
    });

    it('should be case-insensitive', () => {
      const result = findRegisterByName('FREQUENCY');
      expect(result).not.toBeNull();
      expect(result.id).toBe(0x02800002);
    });

    it('should return null for no match', () => {
      const result = findRegisterByName('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getRegistersByCategory', () => {
    it('should get all energy registers (category 0x00)', () => {
      const results = getRegistersByCategory(0x00);
      expect(results.length).toBeGreaterThan(0);
      results.forEach((r) => {
        const di3 = (r.id >> 24) & 0xff;
        expect(di3).toBe(0x00);
      });
    });

    it('should get all instantaneous registers (category 0x02)', () => {
      const results = getRegistersByCategory(0x02);
      expect(results.length).toBeGreaterThan(5);
      results.forEach((r) => {
        const di3 = (r.id >> 24) & 0xff;
        expect(di3).toBe(0x02);
      });
    });

    it('should return empty array for invalid category', () => {
      const results = getRegistersByCategory(0xff);
      expect(results).toHaveLength(0);
    });
  });

  describe('Control Code Helpers', () => {
    describe('isResponseCode', () => {
      it('should identify response codes', () => {
        expect(isResponseCode(0x91)).toBe(true);
        expect(isResponseCode(0x94)).toBe(true);
        expect(isResponseCode(0x9c)).toBe(true);
      });

      it('should reject request codes', () => {
        expect(isResponseCode(0x11)).toBe(false);
        expect(isResponseCode(0x14)).toBe(false);
        expect(isResponseCode(0x1c)).toBe(false);
      });
    });

    describe('isErrorResponse', () => {
      it('should identify error responses', () => {
        expect(isErrorResponse(0xd1)).toBe(true);
        expect(isErrorResponse(0xd4)).toBe(true);
        expect(isErrorResponse(0xdc)).toBe(true);
      });

      it('should reject normal responses', () => {
        expect(isErrorResponse(0x91)).toBe(false);
        expect(isErrorResponse(0x94)).toBe(false);
      });

      it('should reject request codes', () => {
        expect(isErrorResponse(0x11)).toBe(false);
        expect(isErrorResponse(0x14)).toBe(false);
      });
    });

    describe('getRequestCode', () => {
      it('should extract request from response', () => {
        expect(getRequestCode(0x91)).toBe(0x11);
        expect(getRequestCode(0x94)).toBe(0x14);
        expect(getRequestCode(0x9c)).toBe(0x1c);
      });

      it('should extract request from error response', () => {
        expect(getRequestCode(0xd1)).toBe(0x11);
        expect(getRequestCode(0xd4)).toBe(0x14);
        expect(getRequestCode(0xdc)).toBe(0x1c);
      });
    });

    describe('getResponseCode', () => {
      it('should calculate response from request', () => {
        expect(getResponseCode(0x11)).toBe(0x91);
        expect(getResponseCode(0x14)).toBe(0x94);
        expect(getResponseCode(0x1c)).toBe(0x9c);
      });
    });

    describe('getErrorResponseCode', () => {
      it('should calculate error response from request', () => {
        expect(getErrorResponseCode(0x11)).toBe(0xd1);
        expect(getErrorResponseCode(0x14)).toBe(0xd4);
        expect(getErrorResponseCode(0x1c)).toBe(0xdc);
      });
    });
  });

  describe('parseErrorCode', () => {
    it('should parse single error', () => {
      expect(parseErrorCode(0x01)).toBe('Other error');
      expect(parseErrorCode(0x02)).toBe('No data requested');
      expect(parseErrorCode(0x04)).toBe('Password error / Unauthorized');
    });

    it('should parse multiple errors (bit flags)', () => {
      const result = parseErrorCode(0x03); // 0x01 + 0x02
      expect(result).toContain('Other error');
      expect(result).toContain('No data requested');
    });

    it('should handle unknown error', () => {
      const result = parseErrorCode(0x80);
      expect(result).toContain('Unknown error');
    });
  });

  describe('formatDataId', () => {
    it('should format Data ID as hex string', () => {
      expect(formatDataId(0x00000000)).toBe('00-00-00-00');
      expect(formatDataId(0x02010100)).toBe('02-01-01-00');
      expect(formatDataId(0x02800002)).toBe('02-80-00-02');
    });

    it('should uppercase hex digits', () => {
      expect(formatDataId(0xaabbccdd)).toBe('AA-BB-CC-DD');
    });
  });

  describe('Engineering Unit Conversion', () => {
    describe('toEngineeringUnits', () => {
      it('should convert voltage (resolution 0.1)', () => {
        const register = INSTANTANEOUS_REGISTERS.VOLTAGE_A;
        expect(toEngineeringUnits(2205, register)).toBeCloseTo(220.5);
      });

      it('should convert energy (resolution 0.01)', () => {
        const register = ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE;
        expect(toEngineeringUnits(12345678, register)).toBeCloseTo(123456.78);
      });

      it('should convert current (resolution 0.001)', () => {
        const register = INSTANTANEOUS_REGISTERS.CURRENT_A;
        expect(toEngineeringUnits(5234, register)).toBeCloseTo(5.234);
      });

      it('should handle null register', () => {
        expect(toEngineeringUnits(100, null)).toBe(100);
      });
    });

    describe('fromEngineeringUnits', () => {
      it('should convert voltage back to raw', () => {
        const register = INSTANTANEOUS_REGISTERS.VOLTAGE_A;
        expect(fromEngineeringUnits(220.5, register)).toBe(2205);
      });

      it('should convert energy back to raw', () => {
        const register = ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE;
        expect(fromEngineeringUnits(123456.78, register)).toBe(12345678);
      });

      it('should round to nearest integer', () => {
        const register = INSTANTANEOUS_REGISTERS.CURRENT_A;
        expect(fromEngineeringUnits(5.2345, register)).toBe(5235);
      });
    });
  });

  describe('Register Data Integrity', () => {
    it('all registers should have required fields', () => {
      for (const register of Object.values(ALL_REGISTERS)) {
        expect(register.id).toBeDefined();
        expect(typeof register.id).toBe('number');
        expect(register.name).toBeDefined();
        expect(typeof register.name).toBe('string');
        expect(register.bytes).toBeDefined();
        expect(typeof register.bytes).toBe('number');
      }
    });

    it('all register IDs should be unique', () => {
      const ids = Object.values(ALL_REGISTERS).map((r) => r.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('energy registers should have resolution 0.01', () => {
      for (const register of Object.values(ENERGY_REGISTERS)) {
        expect(register.resolution).toBe(0.01);
      }
    });
  });
});
