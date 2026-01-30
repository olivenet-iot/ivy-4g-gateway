# OBIS Registry Entry Template

## Template

Add this to `OBIS_REGISTRY` in `src/protocol/dlms/obis-registry.js`:

```javascript
// Category comment
'A-B:C.D.E.F': {
  name: 'Human-readable register name',
  unit: 'kWh',           // Unit: kWh, kvarh, kVAh, V, A, W, var, VA, Hz, '' (dimensionless)
  category: 'energy',    // One of: energy, voltage, current, power, powerFactor, demand, system, events, control
  key: 'UNIQUE_KEY',     // UPPER_SNAKE_CASE, used as telemetry key
  scaler: 0.001,         // Optional: raw_value * scaler = real_value. Omit if 1:1
},
```

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable name |
| `unit` | string | Yes | SI unit or empty string |
| `category` | string | Yes | Register category for grouping |
| `key` | string | Yes | Unique telemetry key |
| `scaler` | number | No | Conversion factor (omit if raw value equals real value) |

## Categories

| Category | Description | Example OBIS |
|----------|-------------|--------------|
| `energy` | Cumulative energy | `1-0:1.8.0.255` |
| `voltage` | Voltage measurements | `1-0:12.7.0.255` |
| `current` | Current measurements | `1-0:11.7.0.255` |
| `power` | Power and frequency | `1-0:1.7.0.255` |
| `powerFactor` | Power factor | `1-0:13.7.0.255` |
| `demand` | Maximum demand | `1-0:1.6.0.255` |
| `system` | Clock, serial, device info | `0-0:1.0.0.255` |
| `events` | Event logs, counters | `0-0:96.7.21.255` |
| `control` | Relay/disconnect | `0-0:96.3.10.255` |

## Example

```javascript
// Instantaneous voltage
'1-0:12.7.0.255': {
  name: 'Voltage total',
  unit: 'V',
  category: 'voltage',
  key: 'VOLTAGE_TOTAL',
  scaler: 0.01,
},
```
