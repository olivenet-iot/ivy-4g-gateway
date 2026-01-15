/**
 * DLT645-2007 Protocol Data Registers & Constants
 *
 * This module defines all data identifiers, control codes, and
 * helper functions for the DLT645 protocol implementation.
 *
 * Data Identifier (DI) Format:
 * - 4 bytes: DI3 DI2 DI1 DI0
 * - Stored little-endian in frames
 * - Each byte pair represents a category/subcategory
 *
 * @module protocol/registers
 */

/**
 * Control Codes for DLT645 Protocol
 * Used in the control field (byte 8) of frames
 */
export const CONTROL_CODES = {
  // Request codes (sent to meter)
  READ_DATA: 0x11, // Read data from meter
  WRITE_DATA: 0x14, // Write data to meter
  READ_FOLLOW: 0x12, // Read subsequent data
  READ_ADDRESS: 0x13, // Read meter address
  WRITE_ADDRESS: 0x15, // Write meter address
  BROADCAST_TIME: 0x08, // Broadcast time sync
  RELAY_CONTROL: 0x1c, // Relay trip/close control

  // Response codes (received from meter)
  // Response = Request + 0x80
  READ_DATA_RESPONSE: 0x91,
  WRITE_DATA_RESPONSE: 0x94,
  READ_FOLLOW_RESPONSE: 0x92,
  READ_ADDRESS_RESPONSE: 0x93,
  WRITE_ADDRESS_RESPONSE: 0x95,
  RELAY_CONTROL_RESPONSE: 0x9c,

  // Error responses
  // Error = Request + 0x80 + 0x40 = Request + 0xC0
  READ_DATA_ERROR: 0xd1,
  WRITE_DATA_ERROR: 0xd4,
  RELAY_CONTROL_ERROR: 0xdc,
};

/**
 * Error codes returned in error response frames
 */
export const ERROR_CODES = {
  0x01: 'Other error',
  0x02: 'No data requested',
  0x04: 'Password error / Unauthorized',
  0x08: 'Communication rate cannot be changed',
  0x10: 'Annual power exceeds limit',
  0x20: 'Day power exceeds limit',
  0x40: 'Command execution failed',
};

/**
 * Data Register Categories (DI3 byte)
 */
export const REGISTER_CATEGORIES = {
  ENERGY: 0x00, // Energy readings (kWh)
  MAX_DEMAND: 0x01, // Maximum demand records
  INSTANTANEOUS: 0x02, // Real-time measurements
  EVENT_RECORDS: 0x03, // Event/alarm records
  PARAMETERS: 0x04, // Configuration parameters
  FROZEN_DATA: 0x05, // Historical frozen data
  LOAD_PROFILE: 0x06, // Load profile data
  PREPAID: 0x09, // Prepaid/credit data (custom extension)
};

/**
 * Energy Data Registers (DI3 = 0x00)
 * Resolution: 0.01 kWh (2 decimal places)
 */
export const ENERGY_REGISTERS = {
  // Total Energy
  TOTAL_ACTIVE_POSITIVE: {
    id: 0x00000000,
    name: 'Total Active Energy (Import)',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
    description: 'Cumulative imported active energy',
  },
  TOTAL_ACTIVE_NEGATIVE: {
    id: 0x00010000,
    name: 'Total Active Energy (Export)',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
    description: 'Cumulative exported active energy',
  },
  TOTAL_REACTIVE_POSITIVE: {
    id: 0x00020000,
    name: 'Total Reactive Energy (Import)',
    unit: 'kvarh',
    resolution: 0.01,
    bytes: 4,
  },
  TOTAL_REACTIVE_NEGATIVE: {
    id: 0x00030000,
    name: 'Total Reactive Energy (Export)',
    unit: 'kvarh',
    resolution: 0.01,
    bytes: 4,
  },

  // Tariff Energy (T1-T4)
  TARIFF_1_ACTIVE: {
    id: 0x00010100,
    name: 'Tariff 1 Active Energy',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
  },
  TARIFF_2_ACTIVE: {
    id: 0x00010200,
    name: 'Tariff 2 Active Energy',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
  },
  TARIFF_3_ACTIVE: {
    id: 0x00010300,
    name: 'Tariff 3 Active Energy',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
  },
  TARIFF_4_ACTIVE: {
    id: 0x00010400,
    name: 'Tariff 4 Active Energy',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
  },
};

/**
 * Instantaneous Data Registers (DI3 = 0x02)
 * Real-time electrical parameters
 */
export const INSTANTANEOUS_REGISTERS = {
  // Voltage
  VOLTAGE_A: {
    id: 0x02010100,
    name: 'Phase A Voltage',
    unit: 'V',
    resolution: 0.1,
    bytes: 2,
    description: 'Single phase or Phase A voltage',
  },
  VOLTAGE_B: {
    id: 0x02010200,
    name: 'Phase B Voltage',
    unit: 'V',
    resolution: 0.1,
    bytes: 2,
  },
  VOLTAGE_C: {
    id: 0x02010300,
    name: 'Phase C Voltage',
    unit: 'V',
    resolution: 0.1,
    bytes: 2,
  },

  // Current
  CURRENT_A: {
    id: 0x02020100,
    name: 'Phase A Current',
    unit: 'A',
    resolution: 0.001,
    bytes: 3,
    description: 'Single phase or Phase A current',
  },
  CURRENT_B: {
    id: 0x02020200,
    name: 'Phase B Current',
    unit: 'A',
    resolution: 0.001,
    bytes: 3,
  },
  CURRENT_C: {
    id: 0x02020300,
    name: 'Phase C Current',
    unit: 'A',
    resolution: 0.001,
    bytes: 3,
  },

  // Active Power
  ACTIVE_POWER_TOTAL: {
    id: 0x02030000,
    name: 'Total Active Power',
    unit: 'W',
    resolution: 1,
    bytes: 3,
    signed: true,
    description: 'Positive = import, Negative = export',
  },
  ACTIVE_POWER_A: {
    id: 0x02030100,
    name: 'Phase A Active Power',
    unit: 'W',
    resolution: 1,
    bytes: 3,
    signed: true,
  },
  ACTIVE_POWER_B: {
    id: 0x02030200,
    name: 'Phase B Active Power',
    unit: 'W',
    resolution: 1,
    bytes: 3,
    signed: true,
  },
  ACTIVE_POWER_C: {
    id: 0x02030300,
    name: 'Phase C Active Power',
    unit: 'W',
    resolution: 1,
    bytes: 3,
    signed: true,
  },

  // Reactive Power
  REACTIVE_POWER_TOTAL: {
    id: 0x02040000,
    name: 'Total Reactive Power',
    unit: 'var',
    resolution: 1,
    bytes: 3,
    signed: true,
  },
  REACTIVE_POWER_A: {
    id: 0x02040100,
    name: 'Phase A Reactive Power',
    unit: 'var',
    resolution: 1,
    bytes: 3,
    signed: true,
  },

  // Apparent Power
  APPARENT_POWER_TOTAL: {
    id: 0x02050000,
    name: 'Total Apparent Power',
    unit: 'VA',
    resolution: 1,
    bytes: 3,
  },

  // Power Factor
  POWER_FACTOR_TOTAL: {
    id: 0x02060000,
    name: 'Total Power Factor',
    unit: '',
    resolution: 0.001,
    bytes: 2,
    signed: true,
    description: 'Range: -1.000 to +1.000',
  },
  POWER_FACTOR_A: {
    id: 0x02060100,
    name: 'Phase A Power Factor',
    unit: '',
    resolution: 0.001,
    bytes: 2,
    signed: true,
  },

  // Frequency
  FREQUENCY: {
    id: 0x02800002,
    name: 'Grid Frequency',
    unit: 'Hz',
    resolution: 0.01,
    bytes: 2,
    description: 'Typical range: 49.00 - 51.00 Hz',
  },
};

/**
 * Parameter Registers (DI3 = 0x04)
 * Meter configuration and status
 */
export const PARAMETER_REGISTERS = {
  // Relay Status
  RELAY_STATUS: {
    id: 0x04000501,
    name: 'Relay Status',
    unit: '',
    bytes: 1,
    description: '0x00 = Closed (ON), 0x01 = Open (OFF/Tripped)',
    values: {
      0x00: 'Closed',
      0x01: 'Open',
    },
  },

  // Meter Status Word
  METER_STATUS: {
    id: 0x04000503,
    name: 'Meter Status Word',
    unit: '',
    bytes: 2,
    description: 'Bit flags for various meter states',
  },

  // Communication Address
  METER_ADDRESS: {
    id: 0x04000401,
    name: 'Meter Communication Address',
    unit: '',
    bytes: 6,
    description: '12-digit BCD address',
  },

  // Date and Time
  DATE_TIME: {
    id: 0x04000101,
    name: 'Meter Date/Time',
    unit: '',
    bytes: 6,
    description: 'YY MM DD WW HH MM SS format',
  },
};

/**
 * Prepaid/Balance Registers (Custom extension, DI3 = 0x09 or vendor-specific)
 * Note: These may vary by manufacturer
 */
export const PREPAID_REGISTERS = {
  BALANCE_ENERGY: {
    id: 0x00900100,
    name: 'Balance Energy',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
    description: 'Remaining prepaid credit in kWh',
  },
  BALANCE_MONEY: {
    id: 0x00900200,
    name: 'Balance Money',
    unit: 'currency',
    resolution: 0.01,
    bytes: 4,
    description: 'Remaining prepaid credit in currency',
  },
  ALARM_THRESHOLD: {
    id: 0x00900300,
    name: 'Low Balance Alarm Threshold',
    unit: 'kWh',
    resolution: 0.01,
    bytes: 4,
  },
};

/**
 * All registers combined for lookup
 */
export const ALL_REGISTERS = {
  ...ENERGY_REGISTERS,
  ...INSTANTANEOUS_REGISTERS,
  ...PARAMETER_REGISTERS,
  ...PREPAID_REGISTERS,
};

/**
 * Commonly used registers for quick polling
 * These are the registers typically read in each telemetry cycle
 */
export const TELEMETRY_REGISTERS = [
  ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE,
  INSTANTANEOUS_REGISTERS.VOLTAGE_A,
  INSTANTANEOUS_REGISTERS.CURRENT_A,
  INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL,
  INSTANTANEOUS_REGISTERS.REACTIVE_POWER_TOTAL,
  INSTANTANEOUS_REGISTERS.POWER_FACTOR_TOTAL,
  INSTANTANEOUS_REGISTERS.FREQUENCY,
  PREPAID_REGISTERS.BALANCE_ENERGY,
  PARAMETER_REGISTERS.RELAY_STATUS,
];

/**
 * Relay control commands
 */
export const RELAY_COMMANDS = {
  TRIP: 0x1a, // Open relay (disconnect)
  CLOSE: 0x1b, // Close relay (reconnect)
  ALARM: 0x1c, // Alarm/warning state
};

/**
 * Broadcast address (used for addressing all meters)
 */
export const BROADCAST_ADDRESS = '999999999999';
export const BROADCAST_ADDRESS_AA = 'AAAAAAAAAAAA';

/**
 * Find register definition by Data Identifier
 * @param {number} dataId - 4-byte Data Identifier
 * @returns {Object|null} Register definition or null if not found
 */
export const findRegisterById = (dataId) => {
  for (const [key, register] of Object.entries(ALL_REGISTERS)) {
    if (register.id === dataId) {
      return { key, ...register };
    }
  }
  return null;
};

/**
 * Find register definition by name
 * @param {string} name - Register name (case-insensitive partial match)
 * @returns {Object|null} Register definition or null if not found
 */
export const findRegisterByName = (name) => {
  const searchTerm = name.toLowerCase();
  for (const [key, register] of Object.entries(ALL_REGISTERS)) {
    if (register.name.toLowerCase().includes(searchTerm)) {
      return { key, ...register };
    }
  }
  return null;
};

/**
 * Get all registers in a category
 * @param {number} category - Category byte (DI3)
 * @returns {Object[]} Array of matching registers
 */
export const getRegistersByCategory = (category) => {
  const results = [];
  for (const [key, register] of Object.entries(ALL_REGISTERS)) {
    const di3 = (register.id >> 24) & 0xff;
    if (di3 === category) {
      results.push({ key, ...register });
    }
  }
  return results;
};

/**
 * Check if control code is a response (has 0x80 bit set)
 * @param {number} controlCode - Control code byte
 * @returns {boolean} True if response code
 */
export const isResponseCode = (controlCode) => {
  return (controlCode & 0x80) !== 0;
};

/**
 * Check if control code is an error response (has 0xC0 bits set)
 * @param {number} controlCode - Control code byte
 * @returns {boolean} True if error response
 */
export const isErrorResponse = (controlCode) => {
  return (controlCode & 0xc0) === 0xc0;
};

/**
 * Get request code from response code
 * @param {number} responseCode - Response control code
 * @returns {number} Original request code
 */
export const getRequestCode = (responseCode) => {
  if (isErrorResponse(responseCode)) {
    return responseCode & 0x3f; // Remove 0xC0
  }
  return responseCode & 0x7f; // Remove 0x80
};

/**
 * Get response code from request code
 * @param {number} requestCode - Request control code
 * @returns {number} Expected response code
 */
export const getResponseCode = (requestCode) => {
  return requestCode | 0x80;
};

/**
 * Get error response code from request code
 * @param {number} requestCode - Request control code
 * @returns {number} Error response code
 */
export const getErrorResponseCode = (requestCode) => {
  return requestCode | 0xc0;
};

/**
 * Parse error code from error response data
 * @param {number} errorByte - Error code byte from response
 * @returns {string} Human-readable error description
 */
export const parseErrorCode = (errorByte) => {
  // Error byte can have multiple bits set
  const errors = [];
  for (const [code, message] of Object.entries(ERROR_CODES)) {
    if (errorByte & parseInt(code)) {
      errors.push(message);
    }
  }
  return errors.length > 0 ? errors.join(', ') : `Unknown error: 0x${errorByte.toString(16)}`;
};

/**
 * Format Data Identifier for display
 * @param {number} dataId - 4-byte Data Identifier
 * @returns {string} Formatted string like "DI3-DI2-DI1-DI0"
 */
export const formatDataId = (dataId) => {
  const di0 = dataId & 0xff;
  const di1 = (dataId >> 8) & 0xff;
  const di2 = (dataId >> 16) & 0xff;
  const di3 = (dataId >> 24) & 0xff;
  return `${di3.toString(16).padStart(2, '0')}-${di2.toString(16).padStart(2, '0')}-${di1.toString(16).padStart(2, '0')}-${di0.toString(16).padStart(2, '0')}`.toUpperCase();
};

/**
 * Convert raw value to engineering units using register definition
 * @param {number} rawValue - Raw BCD-decoded value
 * @param {Object} register - Register definition with resolution
 * @returns {number} Value in engineering units
 */
export const toEngineeringUnits = (rawValue, register) => {
  if (!register || !register.resolution) {
    return rawValue;
  }
  return rawValue * register.resolution;
};

/**
 * Convert engineering units to raw value for writing
 * @param {number} value - Value in engineering units
 * @param {Object} register - Register definition with resolution
 * @returns {number} Raw value for BCD encoding
 */
export const fromEngineeringUnits = (value, register) => {
  if (!register || !register.resolution) {
    return Math.round(value);
  }
  return Math.round(value / register.resolution);
};

export default {
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
  BROADCAST_ADDRESS_AA,
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
};
