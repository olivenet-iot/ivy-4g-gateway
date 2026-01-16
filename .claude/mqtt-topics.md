# MQTT Topics & Payloads

This document describes all MQTT topics and message formats used by IVY 4G Gateway.

## Connection Details

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
If `MQTT_AUTH_ENABLED=true`:
```
Username: <from MQTT_USERS>
Password: <from MQTT_USERS>
```

## Topic Hierarchy

```
ivy/v1/
├── meters/
│   └── {meterId}/
│       ├── telemetry          # Meter readings
│       ├── status             # Online/offline (retained)
│       ├── events             # Alarms and events
│       └── command/
│           ├── request        # Send commands
│           └── response       # Command results
└── gateway/
    ├── status                 # Gateway online/offline (retained)
    └── stats                  # Gateway statistics
```

**Topic prefix:** `ivy/v1`
**Meter ID:** 12-digit address (e.g., `000000001234`)

## Meter Topics

### Telemetry

**Topic:** `ivy/v1/meters/{meterId}/telemetry`
**QoS:** 1
**Retain:** No

Published when meter data is read (polling or on-demand).

**Single Reading Payload:**
```json
{
  "ts": 1705320000000,
  "meterId": "000000001234",
  "dataId": "0x00000000",
  "register": "TOTAL_ACTIVE_POSITIVE",
  "value": 1234.56,
  "rawValue": 123456,
  "unit": "kWh"
}
```

**Batch Reading Payload:**
```json
{
  "ts": 1705320000000,
  "meterId": "000000001234",
  "values": {
    "TOTAL_ACTIVE_POSITIVE": { "value": 1234.56, "unit": "kWh" },
    "VOLTAGE_A": { "value": 230.5, "unit": "V" },
    "CURRENT_A": { "value": 15.234, "unit": "A" }
  },
  "isBatch": true
}
```

### Status

**Topic:** `ivy/v1/meters/{meterId}/status`
**QoS:** 1
**Retain:** Yes (last known state persisted)

Published when meter connects or disconnects.

**Online Payload:**
```json
{
  "ts": 1705320000000,
  "meterId": "000000001234",
  "online": true,
  "ip": "192.168.1.100"
}
```

**Offline Payload:**
```json
{
  "ts": 1705320000000,
  "meterId": "000000001234",
  "online": false
}
```

### Events

**Topic:** `ivy/v1/meters/{meterId}/events`
**QoS:** 1
**Retain:** No

Published for alarms, warnings, and informational events.

**Event Payload:**
```json
{
  "ts": 1705320000000,
  "meterId": "000000001234",
  "event": "OVERVOLTAGE",
  "severity": "warning",
  "data": {
    "phase": "A",
    "value": 255.5,
    "threshold": 250,
    "unit": "V"
  }
}
```

**Event Types:**
| Event | Severity | Description |
|-------|----------|-------------|
| `METER_ONLINE` | info | Meter connected |
| `METER_OFFLINE` | warning | Meter disconnected |
| `COMMUNICATION_LOST` | critical | No response timeout |
| `OVERVOLTAGE` | warning | Voltage > threshold |
| `UNDERVOLTAGE` | warning | Voltage < threshold |
| `OVERCURRENT` | warning | Current > threshold |
| `OVERLOAD` | critical | Power > threshold |
| `LOW_POWER_FACTOR` | warning | PF < threshold |
| `LOW_BALANCE` | warning | Prepaid balance low |
| `RELAY_TRIPPED` | info | Relay opened |
| `RELAY_CLOSED` | info | Relay closed |

### Commands

#### Request

**Topic:** `ivy/v1/meters/{meterId}/command/request`
**QoS:** 1
**Retain:** No

**Read Register:**
```json
{
  "id": "cmd-1705320000000-abc",
  "method": "read_register",
  "params": {
    "register": "TOTAL_ACTIVE_POSITIVE"
  }
}
```

**Read by Data ID:**
```json
{
  "id": "cmd-1705320000001-def",
  "method": "read_register",
  "params": {
    "dataId": "0x02010100"
  }
}
```

**Read Multiple:**
```json
{
  "id": "cmd-1705320000002-ghi",
  "method": "read_all",
  "params": {
    "registers": ["VOLTAGE_A", "CURRENT_A", "ACTIVE_POWER_TOTAL"]
  }
}
```

**Relay Control:**
```json
{
  "id": "cmd-1705320000003-jkl",
  "method": "relay_control",
  "params": {
    "state": "open"
  }
}
```

**Available Methods:**
| Method | Parameters | Description |
|--------|------------|-------------|
| `read_register` | `register` or `dataId` | Read single register |
| `read_all` | `registers[]` (optional) | Read multiple registers |
| `read_address` | none | Verify meter address |
| `relay_control` | `state` (open/close) | Control prepaid relay |

#### Response

**Topic:** `ivy/v1/meters/{meterId}/command/response`
**QoS:** 1
**Retain:** No

**Success Response:**
```json
{
  "ts": 1705320000100,
  "id": "cmd-1705320000000-abc",
  "success": true,
  "result": {
    "register": "TOTAL_ACTIVE_POSITIVE",
    "dataId": "0x00000000",
    "value": 1234.56,
    "unit": "kWh",
    "timestamp": 1705320000100
  }
}
```

**Error Response:**
```json
{
  "ts": 1705320000100,
  "id": "cmd-1705320000000-abc",
  "success": false,
  "error": "Meter not connected"
}
```

**Common Errors:**
- `"Meter not connected"` - No TCP connection
- `"Command timeout"` - No response within timeout
- `"Invalid register"` - Unknown register name
- `"Invalid command"` - Unknown method
- `"Protocol error: ..."` - DL/T 645 error response

## Gateway Topics

### Gateway Status

**Topic:** `ivy/v1/gateway/status`
**QoS:** 1
**Retain:** Yes

Published periodically and on startup/shutdown.

**Online Payload:**
```json
{
  "ts": 1705320000000,
  "status": "online",
  "version": "0.1.0",
  "name": "IVY 4G Gateway",
  "uptime": 3600
}
```

**Offline Payload:**
```json
{
  "ts": 1705320000000,
  "status": "offline"
}
```

### Gateway Statistics

**Topic:** `ivy/v1/gateway/stats`
**QoS:** 0
**Retain:** No

Published periodically with operational statistics.

**Payload:**
```json
{
  "ts": 1705320000000,
  "meters": {
    "connected": 5,
    "total": 10
  },
  "mqtt": {
    "clients": 2,
    "messagesPublished": 1000
  },
  "publisher": {
    "telemetryPublished": 500,
    "statusPublished": 50,
    "eventsPublished": 10,
    "errors": 0
  },
  "polling": {
    "enabled": true,
    "interval": 60000,
    "lastCycle": 1705319940000
  }
}
```

## Wildcard Subscriptions

**Single-level wildcard (+):**
```
ivy/v1/meters/+/telemetry    # All meters' telemetry
ivy/v1/meters/+/status       # All meters' status
ivy/v1/meters/+/events       # All meters' events
```

**Multi-level wildcard (#):**
```
ivy/v1/meters/#              # All meter topics
ivy/v1/#                     # Everything
```

## Code Examples

### JavaScript (Node.js)

```javascript
import mqtt from 'mqtt';

const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', () => {
  // Subscribe to all meter telemetry
  client.subscribe('ivy/v1/meters/+/telemetry');
  client.subscribe('ivy/v1/meters/+/status');

  // Subscribe to specific meter commands
  client.subscribe('ivy/v1/meters/000000001234/command/response');
});

client.on('message', (topic, message) => {
  const data = JSON.parse(message.toString());
  console.log(`${topic}:`, data);
});

// Send a command
function readRegister(meterId, register) {
  const command = {
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method: 'read_register',
    params: { register }
  };

  client.publish(
    `ivy/v1/meters/${meterId}/command/request`,
    JSON.stringify(command)
  );

  return command.id;
}

// Example usage
readRegister('000000001234', 'TOTAL_ACTIVE_POSITIVE');
```

### JavaScript (Browser with WebSocket)

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
  document.getElementById('output').textContent = JSON.stringify(data, null, 2);
});
</script>
```

### Python

```python
import paho.mqtt.client as mqtt
import json
import time

def on_connect(client, userdata, flags, rc):
    print(f"Connected: {rc}")
    client.subscribe("ivy/v1/meters/+/telemetry")
    client.subscribe("ivy/v1/meters/+/status")

def on_message(client, userdata, msg):
    data = json.loads(msg.payload.decode())
    print(f"{msg.topic}: {data}")

client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message

client.connect("localhost", 1883, 60)

# Send a command
def send_command(meter_id, method, params=None):
    command = {
        "id": f"cmd-{int(time.time() * 1000)}",
        "method": method,
        "params": params or {}
    }

    topic = f"ivy/v1/meters/{meter_id}/command/request"
    client.publish(topic, json.dumps(command))
    return command["id"]

# Example: Read total energy
send_command("000000001234", "read_register", {"register": "TOTAL_ACTIVE_POSITIVE"})

client.loop_forever()
```

## Key Files Reference

**File: `src/mqtt/publisher.js`**
- `TOPIC_PREFIX = 'ivy/v1'`
- `publishTelemetry(meterId, data)` - Publish readings
- `publishMeterStatus(meterId, online)` - Publish status
- `publishEvent(meterId, event, data)` - Publish events

**File: `src/mqtt/command-handler.js`**
- `COMMAND_METHODS` - Available command types
- `handleReadRegister()` - Read register handler
- `handleRelayControl()` - Relay control handler

**File: `src/mqtt/broker.js`**
- `BROKER_EVENTS` - Broker event constants
- TCP port: 1883
- WebSocket port: 9001
