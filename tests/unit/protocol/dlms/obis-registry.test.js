/**
 * OBIS Registry Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  OBIS_REGISTRY,
  lookupObis,
  mapDlmsToGatewayRegister,
  getObisByCategory,
  getCategories,
} from '../../../../src/protocol/dlms/obis-registry.js';

describe('OBIS Registry', () => {
  describe('new OBIS entries', () => {
    it('should have Voltage total entry', () => {
      const entry = OBIS_REGISTRY['1-0:12.7.0.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('VOLTAGE_TOTAL');
      expect(entry.unit).toBe('V');
      expect(entry.category).toBe('voltage');
      expect(entry.scaler).toBe(0.01);
    });

    it('should have Current total entry', () => {
      const entry = OBIS_REGISTRY['1-0:11.7.0.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('CURRENT_TOTAL');
      expect(entry.unit).toBe('A');
      expect(entry.category).toBe('current');
      expect(entry.scaler).toBe(0.001);
    });

    it('should have Neutral current entry', () => {
      const entry = OBIS_REGISTRY['1-0:91.7.0.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('CURRENT_NEUTRAL');
      expect(entry.unit).toBe('A');
      expect(entry.category).toBe('current');
      expect(entry.scaler).toBe(0.001);
    });

    it('should have Total energy absolute entry', () => {
      const entry = OBIS_REGISTRY['1-0:15.8.0.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('TOTAL_ENERGY_ABSOLUTE');
      expect(entry.unit).toBe('kWh');
      expect(entry.category).toBe('energy');
      expect(entry.scaler).toBe(0.001);
    });

    it('should have Logical device name entry', () => {
      const entry = OBIS_REGISTRY['0-0:42.0.0.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('LOGICAL_DEVICE_NAME');
      expect(entry.unit).toBe('');
      expect(entry.category).toBe('system');
    });

    it('should have Manufacturer ID entry', () => {
      const entry = OBIS_REGISTRY['0-0:96.1.1.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('MANUFACTURER_ID');
      expect(entry.unit).toBe('');
      expect(entry.category).toBe('system');
    });
  });

  describe('scaler values on existing entries', () => {
    it('should have scaler on POWER_FACTOR_TOTAL', () => {
      const entry = OBIS_REGISTRY['1-0:13.7.0.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('POWER_FACTOR_TOTAL');
      expect(entry.scaler).toBe(0.001);
    });

    it('should have scaler on FREQUENCY', () => {
      const entry = OBIS_REGISTRY['1-0:14.7.0.255'];
      expect(entry).toBeDefined();
      expect(entry.key).toBe('FREQUENCY');
      expect(entry.scaler).toBe(0.01);
    });

    it('should not have scaler on entries that do not need it', () => {
      const entry = OBIS_REGISTRY['1-0:1.8.0.255'];
      expect(entry).toBeDefined();
      expect(entry.scaler).toBeUndefined();
    });
  });

  describe('lookupObis', () => {
    it('should return entry for known OBIS code', () => {
      const entry = lookupObis('1-0:12.7.0.255');
      expect(entry).not.toBeNull();
      expect(entry.key).toBe('VOLTAGE_TOTAL');
    });

    it('should return null for unknown OBIS code', () => {
      const entry = lookupObis('9-9:99.99.99.255');
      expect(entry).toBeNull();
    });

    it('should return new entries correctly', () => {
      expect(lookupObis('1-0:11.7.0.255').key).toBe('CURRENT_TOTAL');
      expect(lookupObis('1-0:91.7.0.255').key).toBe('CURRENT_NEUTRAL');
      expect(lookupObis('1-0:15.8.0.255').key).toBe('TOTAL_ENERGY_ABSOLUTE');
      expect(lookupObis('0-0:42.0.0.255').key).toBe('LOGICAL_DEVICE_NAME');
      expect(lookupObis('0-0:96.1.1.255').key).toBe('MANUFACTURER_ID');
    });
  });

  describe('getObisByCategory', () => {
    it('should include new voltage entry in voltage category', () => {
      const voltageEntries = getObisByCategory('voltage');
      expect(voltageEntries['1-0:12.7.0.255']).toBeDefined();
      expect(voltageEntries['1-0:12.7.0.255'].key).toBe('VOLTAGE_TOTAL');
    });

    it('should include new current entries in current category', () => {
      const currentEntries = getObisByCategory('current');
      expect(currentEntries['1-0:11.7.0.255']).toBeDefined();
      expect(currentEntries['1-0:91.7.0.255']).toBeDefined();
    });

    it('should include new energy entry in energy category', () => {
      const energyEntries = getObisByCategory('energy');
      expect(energyEntries['1-0:15.8.0.255']).toBeDefined();
    });

    it('should include new system entries in system category', () => {
      const systemEntries = getObisByCategory('system');
      expect(systemEntries['0-0:42.0.0.255']).toBeDefined();
      expect(systemEntries['0-0:96.1.1.255']).toBeDefined();
    });
  });

  describe('mapDlmsToGatewayRegister', () => {
    it('should map new OBIS codes to gateway register keys', () => {
      expect(mapDlmsToGatewayRegister('1-0:12.7.0.255')).toBe('VOLTAGE_TOTAL');
      expect(mapDlmsToGatewayRegister('1-0:11.7.0.255')).toBe('CURRENT_TOTAL');
      expect(mapDlmsToGatewayRegister('1-0:91.7.0.255')).toBe('CURRENT_NEUTRAL');
      expect(mapDlmsToGatewayRegister('1-0:15.8.0.255')).toBe('TOTAL_ENERGY_ABSOLUTE');
      expect(mapDlmsToGatewayRegister('0-0:42.0.0.255')).toBe('LOGICAL_DEVICE_NAME');
      expect(mapDlmsToGatewayRegister('0-0:96.1.1.255')).toBe('MANUFACTURER_ID');
    });

    it('should return OBIS code itself for unknown codes', () => {
      expect(mapDlmsToGatewayRegister('9-9:99.99.99.255')).toBe('9-9:99.99.99.255');
    });
  });

  describe('getCategories', () => {
    it('should include all expected categories', () => {
      const categories = getCategories();
      expect(categories).toContain('energy');
      expect(categories).toContain('voltage');
      expect(categories).toContain('current');
      expect(categories).toContain('power');
      expect(categories).toContain('powerFactor');
      expect(categories).toContain('system');
      expect(categories).toContain('demand');
      expect(categories).toContain('events');
      expect(categories).toContain('control');
    });
  });
});
