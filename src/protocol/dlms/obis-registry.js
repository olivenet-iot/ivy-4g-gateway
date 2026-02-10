/**
 * OBIS Code Registry
 *
 * Maps OBIS (Object Identification System) codes to human-readable names,
 * units, and categories. Used for interpreting DLMS/COSEM data from meters.
 *
 * OBIS format: A-B:C.D.E.F
 *   A = Medium (1 = electricity)
 *   B = Channel (0 = no channel)
 *   C = Measurement type
 *   D = Processing
 *   E = Tariff rate
 *   F = Historical (255 = current value)
 *
 * @module protocol/dlms/obis-registry
 */

/**
 * OBIS code registry
 * Key: OBIS string in "A-B:C.D.E.F" format
 */
export const OBIS_REGISTRY = {
  // Active energy import
  '1-0:1.8.0.255': { name: 'Total active energy import', unit: 'kWh', category: 'energy', key: 'TOTAL_ACTIVE_IMPORT' },
  '1-0:1.8.1.255': { name: 'Active energy import tariff 1', unit: 'kWh', category: 'energy', key: 'TARIFF_1_ACTIVE_IMPORT' },
  '1-0:1.8.2.255': { name: 'Active energy import tariff 2', unit: 'kWh', category: 'energy', key: 'TARIFF_2_ACTIVE_IMPORT' },
  '1-0:1.8.3.255': { name: 'Active energy import tariff 3', unit: 'kWh', category: 'energy', key: 'TARIFF_3_ACTIVE_IMPORT' },
  '1-0:1.8.4.255': { name: 'Active energy import tariff 4', unit: 'kWh', category: 'energy', key: 'TARIFF_4_ACTIVE_IMPORT' },

  // Active energy export
  '1-0:2.8.0.255': { name: 'Total active energy export', unit: 'kWh', category: 'energy', key: 'TOTAL_ACTIVE_EXPORT' },
  '1-0:2.8.1.255': { name: 'Active energy export tariff 1', unit: 'kWh', category: 'energy', key: 'TARIFF_1_ACTIVE_EXPORT' },
  '1-0:2.8.2.255': { name: 'Active energy export tariff 2', unit: 'kWh', category: 'energy', key: 'TARIFF_2_ACTIVE_EXPORT' },

  // Reactive energy
  '1-0:3.8.0.255': { name: 'Total reactive energy import', unit: 'kvarh', category: 'energy', key: 'TOTAL_REACTIVE_IMPORT' },
  '1-0:4.8.0.255': { name: 'Total reactive energy export', unit: 'kvarh', category: 'energy', key: 'TOTAL_REACTIVE_EXPORT' },

  // Apparent energy
  '1-0:9.8.0.255': { name: 'Total apparent energy import', unit: 'kVAh', category: 'energy', key: 'TOTAL_APPARENT_IMPORT' },

  // Total energy absolute
  '1-0:15.8.0.255': { name: 'Total energy absolute', unit: 'kWh', category: 'energy', key: 'TOTAL_ENERGY_ABSOLUTE', scaler: 0.001 },

  // Instantaneous voltage
  '1-0:12.7.0.255': { name: 'Voltage total', unit: 'V', category: 'voltage', key: 'VOLTAGE_TOTAL', scaler: 0.01 },
  '1-0:32.7.0.255': { name: 'Voltage phase A', unit: 'V', category: 'voltage', key: 'VOLTAGE_A' },
  '1-0:52.7.0.255': { name: 'Voltage phase B', unit: 'V', category: 'voltage', key: 'VOLTAGE_B' },
  '1-0:72.7.0.255': { name: 'Voltage phase C', unit: 'V', category: 'voltage', key: 'VOLTAGE_C' },

  // Instantaneous current
  '1-0:11.7.0.255': { name: 'Current total', unit: 'A', category: 'current', key: 'CURRENT_TOTAL', scaler: 0.001 },
  '1-0:31.7.0.255': { name: 'Current phase A', unit: 'A', category: 'current', key: 'CURRENT_A' },
  '1-0:51.7.0.255': { name: 'Current phase B', unit: 'A', category: 'current', key: 'CURRENT_B' },
  '1-0:71.7.0.255': { name: 'Current phase C', unit: 'A', category: 'current', key: 'CURRENT_C' },
  '1-0:90.7.0.255': { name: 'Current neutral', unit: 'A', category: 'current', key: 'CURRENT_N' },
  '1-0:91.7.0.255': { name: 'Neutral current', unit: 'A', category: 'current', key: 'CURRENT_NEUTRAL', scaler: 0.001 },

  // Instantaneous power
  '1-0:1.7.0.255': { name: 'Active power import', unit: 'W', category: 'power', key: 'ACTIVE_POWER_IMPORT' },
  '1-0:2.7.0.255': { name: 'Active power export', unit: 'W', category: 'power', key: 'ACTIVE_POWER_EXPORT' },
  '1-0:3.7.0.255': { name: 'Reactive power import', unit: 'var', category: 'power', key: 'REACTIVE_POWER_IMPORT' },
  '1-0:4.7.0.255': { name: 'Reactive power export', unit: 'var', category: 'power', key: 'REACTIVE_POWER_EXPORT' },
  '1-0:9.7.0.255': { name: 'Apparent power import', unit: 'VA', category: 'power', key: 'APPARENT_POWER_IMPORT' },
  '1-0:21.7.0.255': { name: 'Active power phase A', unit: 'W', category: 'power', key: 'ACTIVE_POWER_A' },
  '1-0:41.7.0.255': { name: 'Active power phase B', unit: 'W', category: 'power', key: 'ACTIVE_POWER_B' },
  '1-0:61.7.0.255': { name: 'Active power phase C', unit: 'W', category: 'power', key: 'ACTIVE_POWER_C' },

  // Power factor
  '1-0:13.7.0.255': { name: 'Power factor total', unit: '', category: 'powerFactor', key: 'POWER_FACTOR_TOTAL', scaler: 0.001 },
  '1-0:33.7.0.255': { name: 'Power factor phase A', unit: '', category: 'powerFactor', key: 'POWER_FACTOR_A' },
  '1-0:53.7.0.255': { name: 'Power factor phase B', unit: '', category: 'powerFactor', key: 'POWER_FACTOR_B' },
  '1-0:73.7.0.255': { name: 'Power factor phase C', unit: '', category: 'powerFactor', key: 'POWER_FACTOR_C' },

  // Frequency
  '1-0:14.7.0.255': { name: 'Frequency', unit: 'Hz', category: 'power', key: 'FREQUENCY', scaler: 0.01 },

  // Demand
  '1-0:1.6.0.255': { name: 'Maximum demand active import', unit: 'W', category: 'demand', key: 'MAX_DEMAND_IMPORT' },
  '1-0:2.6.0.255': { name: 'Maximum demand active export', unit: 'W', category: 'demand', key: 'MAX_DEMAND_EXPORT' },

  // Clock and calendar
  '0-0:1.0.0.255': { name: 'Clock', unit: '', category: 'system', key: 'CLOCK' },

  // Meter serial / identity
  '0-0:96.1.0.255': { name: 'Meter serial number', unit: '', category: 'system', key: 'SERIAL_NUMBER' },
  '0-0:96.1.1.255': { name: 'Manufacturer ID', unit: '', category: 'system', key: 'MANUFACTURER_ID' },
  '0-0:42.0.0.255': { name: 'Logical device name', unit: '', category: 'system', key: 'LOGICAL_DEVICE_NAME' },

  // Events / logs
  '0-0:96.7.21.255': { name: 'Number of power failures', unit: '', category: 'events', key: 'POWER_FAILURE_COUNT' },
  '0-0:96.7.9.255': { name: 'Number of long power failures', unit: '', category: 'events', key: 'LONG_POWER_FAILURE_COUNT' },
  '1-0:99.97.0.255': { name: 'Power failure event log', unit: '', category: 'events', key: 'POWER_FAILURE_LOG' },
  '0-0:96.7.19.255': { name: 'Number of voltage sags L1', unit: '', category: 'events', key: 'VOLTAGE_SAG_L1_COUNT' },
  '0-0:96.7.20.255': { name: 'Number of voltage swells L1', unit: '', category: 'events', key: 'VOLTAGE_SWELL_L1_COUNT' },

  // Relay / disconnect control
  '0-0:96.3.10.255': {
    name: 'Disconnect control state',
    unit: '', category: 'control', key: 'DISCONNECT_STATE',
    classId: 70,
    attributes: {
      2: { name: 'output_state', type: 'boolean' },
      3: { name: 'control_state', type: 'enum', values: { 0: 'disconnected', 1: 'connected', 2: 'ready_for_reconnection' } },
      4: { name: 'control_mode', type: 'enum' },
    },
    methods: {
      1: { name: 'remote_disconnect' },
      2: { name: 'remote_reconnect' },
    },
  },

  // Tariff
  '0-0:96.14.0.255': { name: 'Current tariff', unit: '', category: 'system', key: 'CURRENT_TARIFF' },
};

/**
 * Lookup OBIS code in registry
 *
 * @param {string} obisString - OBIS code in "A-B:C.D.E.F" format
 * @returns {Object|null} Registry entry or null
 */
export const lookupObis = (obisString) => {
  return OBIS_REGISTRY[obisString] || null;
};

/**
 * Map a DLMS OBIS code to a gateway register name
 * Returns the key that can be used in telemetry messages
 *
 * @param {string} obisString - OBIS code
 * @returns {string} Gateway register key or the OBIS code itself
 */
export const mapDlmsToGatewayRegister = (obisString) => {
  const entry = OBIS_REGISTRY[obisString];
  return entry ? entry.key : obisString;
};

/**
 * Get all OBIS codes for a category
 *
 * @param {string} category - Category name (energy, voltage, current, power, etc.)
 * @returns {Object} Map of OBIS code -> registry entry
 */
export const getObisByCategory = (category) => {
  const result = {};
  for (const [obis, entry] of Object.entries(OBIS_REGISTRY)) {
    if (entry.category === category) {
      result[obis] = entry;
    }
  }
  return result;
};

/**
 * Get a list of all known categories
 * @returns {string[]}
 */
export const getCategories = () => {
  const cats = new Set();
  for (const entry of Object.values(OBIS_REGISTRY)) {
    cats.add(entry.category);
  }
  return Array.from(cats);
};

export default {
  OBIS_REGISTRY,
  lookupObis,
  mapDlmsToGatewayRegister,
  getObisByCategory,
  getCategories,
};
