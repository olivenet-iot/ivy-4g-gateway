# Adding a New OBIS Code

Step-by-step guide for adding a new OBIS code to the DLMS registry.

## Steps

### 1. Add to OBIS Registry

Edit `src/protocol/dlms/obis-registry.js` and add an entry to `OBIS_REGISTRY`:

```javascript
'A-B:C.D.E.F': {
  name: 'Human readable name',
  unit: 'kWh',           // Unit of measurement ('' for dimensionless)
  category: 'energy',    // Category: energy, voltage, current, power, powerFactor, demand, system, events, control
  key: 'UNIQUE_KEY',     // Uppercase key for telemetry messages
  scaler: 0.001,         // Optional: multiply raw value by this (omit if 1:1)
},
```

### 2. Add to Polling (if needed)

If this OBIS code should be polled periodically, edit `src/services/polling-manager.js` and add to the appropriate group in `DLMS_POLL_REGISTERS`:

```javascript
{ classId: 3, obisCode: 'A-B:C.D.E.F', name: 'Human readable name' },
```

Common COSEM class IDs:
- `1` = Data (simple value)
- `3` = Register (value + scaler + unit)
- `7` = Profile generic (log data)
- `8` = Clock

### 3. Add Tests

Edit `tests/unit/protocol/dlms/obis-registry.test.js`:

```javascript
it('should contain NEW_CODE entry', () => {
  const entry = lookupObis('A-B:C.D.E.F');
  expect(entry).not.toBeNull();
  expect(entry.name).toBe('Human readable name');
  expect(entry.unit).toBe('kWh');
  expect(entry.category).toBe('energy');
  expect(entry.key).toBe('UNIQUE_KEY');
});
```

### 4. Verify

```bash
npm run test:run -- tests/unit/protocol/dlms/obis-registry.test.js
```

## Finding New OBIS Codes

Use the probe tools to discover what codes a meter supports:

```bash
# Probe specific codes
node debug/dlms-obis-probe.js <meter-ip> <meter-port>

# Brute-force scan all codes
node debug/dlms-obis-bruteforce.js <meter-ip> <meter-port>
```

## Reference

- OBIS format: `A-B:C.D.E.F` where A=medium, B=channel, C=measurement, D=processing, E=tariff, F=historical
- Confirmed EM114070 codes are listed in `.claude/context/discoveries.md`
