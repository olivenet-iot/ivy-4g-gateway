# MQTT API Reference

This document describes the MQTT topics and message formats used by IVY 4G Gateway.

## Table of Contents

- [Connection](#connection)
- [Topics Overview](#topics-overview)
- [Meter Topics](#meter-topics)
  - [Telemetry](#telemetry)
  - [Status](#status)
  - [Events](#events)
  - [Commands](#commands)
- [Gateway Topics](#gateway-topics)
- [Code Examples](#code-examples)
- [Available Registers](#available-registers)

## Connection

### TCP Connection

```
Host: <gateway-ip>
Port: 1883
Protocol: MQTT 3.1.1
```

### WebSocket Connection

```
URL: ws://<gateway-ip>:9001
Protocol: MQTT over WebSocket
```

### Authentication

If authentication is enabled:

```
Username: <configured username>
Password: <configured password>
```

## Topics Overview

| Topic Pattern | Direction | Description |
|--------------|-----------|-------------|
| `ivy/v1/meters/{meterId}/telemetry` | Gateway → Client | Meter readings |
| `ivy/v1/meters/{meterId}/status` | Gateway → Client | Online/offline status |
| `ivy/v1/meters/{meterId}/events` | Gateway → Client | Alarms and events |
| `ivy/v1/meters/{meterId}/command/request` | Client → Gateway | Send command |
| `ivy/v1/meters/{meterId}/command/response` | Gateway → Client | Command result |
| `ivy/v1/gateway/status` | Gateway → Client | Gateway status |
| `ivy/v1/gateway/stats` | Gateway → Client | Gateway statistics |

**Note:** `{meterId}` is the 12-digit meter address (e.g., `000000000001`)

## Meter Topics

### Telemetry

**Topic:** `ivy/v1/meters/{meterId}/telemetry`

Published when meter data is read (polling or on-demand).

**Payload:**

```json
{
  "meterId": "000000000001",
  "timestamp": 1705320000000,
  "register": {
    "id": "00010000",
    "name": "totalActiveEnergy",
    "description": "Total Active Energy (Combined)"
  },
  "value": 12345.67,
  "unit": "kWh",
  "raw": "00001234567"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `meterId` | string | 12-digit meter address |
| `timestamp` | number | Unix timestamp (ms) |
| `register.id` | string | DL/T 645 data identifier |
| `register.name` | string | Human-readable name |
| `register.description` | string | Full description |
| `value` | number | Parsed value |
| `unit` | string | Unit of measurement |
| `raw` | string | Raw BCD data (hex) |

### Status

**Topic:** `ivy/v1/meters/{meterId}/status`

Published when meter connects or disconnects.

**Payload:**

```json
{
  "meterId": "000000000001",
  "online": true,
  "timestamp": 1705320000000,
  "ip": "192.168.1.100"
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `meterId` | string | 12-digit meter address |
| `online` | boolean | Connection status |
| `timestamp` | number | Unix timestamp (ms) |
| `ip` | string | Remote IP (when online) |

### Events

**Topic:** `ivy/v1/meters/{meterId}/events`

Published for alarms and significant events.

**Payload:**

```json
{
  "meterId": "000000000001",
  "timestamp": 1705320000000,
  "type": "alarm",
  "event": "voltage_high",
  "message": "Voltage exceeded threshold",
  "data": {
    "phase": "A",
    "value": 245.5,
    "threshold": 240
  }
}
```

**Event Types:**

| Type | Description |
|------|-------------|
| `alarm` | Threshold violation |
| `warning` | Non-critical alert |
| `info` | Informational event |

**Common Events:**

| Event | Description |
|-------|-------------|
| `voltage_high` | Voltage above threshold |
| `voltage_low` | Voltage below threshold |
| `current_high` | Current above threshold |
| `power_factor_low` | Power factor below threshold |
| `meter_connected` | Meter came online |
| `meter_disconnected` | Meter went offline |

### Commands

#### Request

**Topic:** `ivy/v1/meters/{meterId}/command/request`

Send commands to meters.

**Read Register:**

```json
{
  "requestId": "req-123",
  "command": "read",
  "register": "totalActiveEnergy"
}
```

**Read by Data ID:**

```json
{
  "requestId": "req-124",
  "command": "read",
  "dataId": "00010000"
}
```

**Read Multiple:**

```json
{
  "requestId": "req-125",
  "command": "readMultiple",
  "registers": ["voltageA", "currentA", "activePowerA"]
}
```

**Read Group:**

```json
{
  "requestId": "req-126",
  "command": "readGroup",
  "group": "energy"
}
```

#### Response

**Topic:** `ivy/v1/meters/{meterId}/command/response`

Command execution results.

**Success:**

```json
{
  "requestId": "req-123",
  "success": true,
  "timestamp": 1705320000000,
  "data": {
    "register": "totalActiveEnergy",
    "value": 12345.67,
    "unit": "kWh"
  }
}
```

**Error:**

```json
{
  "requestId": "req-123",
  "success": false,
  "timestamp": 1705320000000,
  "error": "Meter not connected"
}
```

## Gateway Topics

### Gateway Status

**Topic:** `ivy/v1/gateway/status`

Published periodically and on start/stop.

**Payload:**

```json
{
  "status": "online",
  "timestamp": 1705320000000,
  "uptime": 3600000,
  "version": "0.1.0",
  "name": "IVY 4G Gateway"
}
```

### Gateway Statistics

**Topic:** `ivy/v1/gateway/stats`

Published periodically with operational statistics.

**Payload:**

```json
{
  "timestamp": 1705320000000,
  "meters": {
    "connected": 5,
    "total": 10
  },
  "mqtt": {
    "clients": 2,
    "messagesPublished": 1000
  },
  "polling": {
    "enabled": true,
    "interval": 60000,
    "lastRun": 1705319940000
  }
}
```

## Code Examples

### JavaScript (Node.js)

```javascript
import mqtt from 'mqtt';

const client = mqtt.connect('mqtt://localhost:1883', {
  username: 'admin',
  password: 'your_password'
});

client.on('connect', () => {
  console.log('Connected to IVY Gateway');

  // Subscribe to all meter telemetry
  client.subscribe('ivy/v1/meters/+/telemetry');
  client.subscribe('ivy/v1/meters/+/status');
  client.subscribe('ivy/v1/meters/+/events');
});

client.on('message', (topic, message) => {
  const data = JSON.parse(message.toString());
  console.log(`${topic}:`, data);
});

// Send a command
function readMeter(meterId, register) {
  const requestId = `req-${Date.now()}`;

  client.subscribe(`ivy/v1/meters/${meterId}/command/response`);

  client.publish(`ivy/v1/meters/${meterId}/command/request`, JSON.stringify({
    requestId,
    command: 'read',
    register
  }));

  return requestId;
}

// Example: Read total energy from meter
readMeter('000000000001', 'totalActiveEnergy');
```

### JavaScript (Browser)

```html
<script src="https://unpkg.com/mqtt/dist/mqtt.min.js"></script>
<script>
const client = mqtt.connect('ws://localhost:9001');

client.on('connect', () => {
  console.log('Connected via WebSocket');
  client.subscribe('ivy/v1/meters/+/telemetry');
});

client.on('message', (topic, message) => {
  const data = JSON.parse(message.toString());
  console.log('Telemetry:', data);
});
</script>
```

### Python

```python
import paho.mqtt.client as mqtt
import json

def on_connect(client, userdata, flags, rc):
    print(f"Connected with result code {rc}")
    client.subscribe("ivy/v1/meters/+/telemetry")
    client.subscribe("ivy/v1/meters/+/status")

def on_message(client, userdata, msg):
    data = json.loads(msg.payload.decode())
    print(f"{msg.topic}: {data}")

client = mqtt.Client()
client.username_pw_set("admin", "your_password")
client.on_connect = on_connect
client.on_message = on_message

client.connect("localhost", 1883, 60)
client.loop_forever()
```

### Python - Send Command

```python
import paho.mqtt.client as mqtt
import json
import uuid

def read_meter(client, meter_id, register):
    request_id = str(uuid.uuid4())

    command = {
        "requestId": request_id,
        "command": "read",
        "register": register
    }

    client.publish(
        f"ivy/v1/meters/{meter_id}/command/request",
        json.dumps(command)
    )

    return request_id

# Usage
client = mqtt.Client()
client.connect("localhost", 1883, 60)
read_meter(client, "000000000001", "totalActiveEnergy")
```

## Available Registers

### Energy Registers

| Name | Data ID | Unit | Description |
|------|---------|------|-------------|
| `totalActiveEnergy` | 00010000 | kWh | Total Active Energy (Combined) |
| `totalActiveEnergyForward` | 00010100 | kWh | Forward Active Energy |
| `totalActiveEnergyReverse` | 00010200 | kWh | Reverse Active Energy |
| `totalReactiveEnergy` | 00020000 | kvarh | Total Reactive Energy |

### Power Registers

| Name | Data ID | Unit | Description |
|------|---------|------|-------------|
| `totalActivePower` | 02030000 | kW | Total Active Power |
| `activePowerA` | 02030100 | kW | Phase A Active Power |
| `activePowerB` | 02030200 | kW | Phase B Active Power |
| `activePowerC` | 02030300 | kW | Phase C Active Power |
| `totalReactivePower` | 02040000 | kvar | Total Reactive Power |
| `totalApparentPower` | 02050000 | kVA | Total Apparent Power |

### Voltage Registers

| Name | Data ID | Unit | Description |
|------|---------|------|-------------|
| `voltageA` | 02010100 | V | Phase A Voltage |
| `voltageB` | 02010200 | V | Phase B Voltage |
| `voltageC` | 02010300 | V | Phase C Voltage |

### Current Registers

| Name | Data ID | Unit | Description |
|------|---------|------|-------------|
| `currentA` | 02020100 | A | Phase A Current |
| `currentB` | 02020200 | A | Phase B Current |
| `currentC` | 02020300 | A | Phase C Current |

### Power Factor Registers

| Name | Data ID | Unit | Description |
|------|---------|------|-------------|
| `totalPowerFactor` | 02060000 | - | Total Power Factor |
| `powerFactorA` | 02060100 | - | Phase A Power Factor |
| `powerFactorB` | 02060200 | - | Phase B Power Factor |
| `powerFactorC` | 02060300 | - | Phase C Power Factor |

### Frequency

| Name | Data ID | Unit | Description |
|------|---------|------|-------------|
| `frequency` | 02800002 | Hz | Grid Frequency |

### Register Groups

Groups can be used with `readGroup` command:

| Group | Registers |
|-------|-----------|
| `energy` | totalActiveEnergy, totalActiveEnergyForward, totalActiveEnergyReverse, totalReactiveEnergy |
| `power` | totalActivePower, activePowerA, activePowerB, activePowerC, totalReactivePower, totalApparentPower |
| `voltage` | voltageA, voltageB, voltageC |
| `current` | currentA, currentB, currentC |
| `powerFactor` | totalPowerFactor, powerFactorA, powerFactorB, powerFactorC |
| `all` | All available registers |

## DLMS Telemetry

When a DLMS/COSEM meter sends data, the telemetry payload includes a `source: "dlms"` field.

### DLMS Telemetry Payload

**Topic:** `ivy/v1/meters/{meterId}/telemetry`

```json
{
  "meterId": "000000000000",
  "timestamp": 1706500000000,
  "source": "dlms",
  "readings": {
    "VOLTAGE_TOTAL": {
      "value": 236.36,
      "unit": "V",
      "obis": "1-0:12.7.0.255"
    },
    "CURRENT_TOTAL": {
      "value": 0.5,
      "unit": "A",
      "obis": "1-0:11.7.0.255"
    },
    "ACTIVE_POWER_IMPORT": {
      "value": 118,
      "unit": "W",
      "obis": "1-0:1.7.0.255"
    }
  }
}
```

### DLMS Event Types

| Event | APDU | Description |
|-------|------|-------------|
| `event-notification` | 0xC2 | Unsolicited push with OBIS code and value |
| `data-notification` | 0x0F | Unsolicited push with structured data |
| `get-response` | 0xC4 | Response to active GET.request |

### DLMS OBIS Registers

These registers are available via DLMS polling or push notifications:

| Key | OBIS Code | Unit | Description |
|-----|-----------|------|-------------|
| `ACTIVE_POWER_IMPORT` | 1-0:1.7.0.255 | W | Active power import |
| `REACTIVE_POWER_IMPORT` | 1-0:3.7.0.255 | var | Reactive power import |
| `APPARENT_POWER_IMPORT` | 1-0:9.7.0.255 | VA | Apparent power import |
| `CURRENT_TOTAL` | 1-0:11.7.0.255 | A | Current total |
| `VOLTAGE_TOTAL` | 1-0:12.7.0.255 | V | Voltage total |
| `POWER_FACTOR_TOTAL` | 1-0:13.7.0.255 | - | Power factor |
| `FREQUENCY` | 1-0:14.7.0.255 | Hz | Grid frequency |
| `TOTAL_ENERGY_ABSOLUTE` | 1-0:15.8.0.255 | kWh | Total energy |
| `CURRENT_NEUTRAL` | 1-0:91.7.0.255 | A | Neutral current |
| `CURRENT_TARIFF` | 0-0:96.14.0.255 | - | Active tariff number |

---

For troubleshooting, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
