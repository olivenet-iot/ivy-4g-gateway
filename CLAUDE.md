# CLAUDE.md - IVY 4G Gateway

This file provides context for Claude Code to understand, maintain, and extend this project.

## Project Overview

**IVY 4G Gateway** is an IoT gateway that bridges energy meters to MQTT, supporting multiple protocols. It receives TCP connections from 4G-enabled meters, auto-detects the protocol (DL/T 645-2007 or IVY/DLMS), parses frames, and publishes telemetry data over MQTT for backend systems to consume.

**Supported Protocols:**
- **DL/T 645-2007** - Chinese energy meter standard (binary, BCD-encoded)
- **DLMS/COSEM via IVY wrapper** - International standard used by IVY EM114070 meters
- **IVY Heartbeat** - Proprietary 26-byte registration packet from IVY meters

**Primary Functions:**
- Accept TCP connections from energy meters (port 8899)
- Auto-detect protocol from first bytes (0x68 = DLT645, 0x00 0x01 = IVY/DLMS)
- Parse DL/T 645-2007 protocol frames (Chinese energy meter standard)
- Parse DLMS/COSEM APDUs wrapped in IVY proprietary headers
- Handle IVY EM114070 heartbeat packets for meter identification
- Publish meter readings to MQTT topics
- Handle commands from MQTT (read registers, relay control)
- Automatic periodic polling of meters (DLT645 and DLMS)
- Real-time alarm monitoring (voltage, current, power)

**Target Users:**
- Energy management platforms
- Building management systems
- Prepaid electricity systems

## Architecture

```
┌─────────────┐     TCP/DLT645     ┌─────────────────────────────────────────┐
│  DLT645     │ ─────────────────► │            IVY 4G Gateway               │
│  Meters     │ ◄───────────────── │                                         │
│  (4G/LTE)   │                    │  ┌───────────┐  ┌──────────────────┐    │
└─────────────┘                    │  │TCP Server │  │MQTT Broker       │    │
                                   │  │:8899      │──│(Aedes)           │    │
┌─────────────┐     TCP/IVY+DLMS   │  └─────┬─────┘  │:1883 TCP         │    │
│  IVY        │ ─────────────────► │        │        │:9001 WebSocket   │    │
│  EM114070   │ ◄───────────────── │        ▼        └──────────────────┘    │
│  (4G/LTE)   │                    │  ┌───────────┐        │                 │
└─────────────┘                    │  │Protocol   │        ▼                 │
                                   │  │Router     │  ┌──────────────────┐    │
                                   │  │           │  │Publisher         │    │
                                   │  │ ┌─DLT645  │  │Command Handler   │──► │ MQTT
                                   │  │ │ Parser  │  └──────────────────┘    │ Clients
                                   │  │ ├─IVY     │                          │
                                   │  │ │ Wrapper │  ┌──────────────────┐    │
                                   │  │ ├─DLMS    │  │Polling Manager   │    │
                                   │  │ │ Parser  │  │(DLT645 + DLMS)  │    │
                                   │  │ └─HB      │  └──────────────────┘    │
                                   │  │   Handler │                          │
                                   │  └───────────┘  ┌──────────────────┐    │
                                   │                  │Status Manager    │    │
                                   │                  └──────────────────┘    │
                                   │                  ┌──────────────────┐    │
                                   │                  │HTTP Dashboard    │──► │ Browser
                                   │                  │:3000             │    │
                                   └──────────────────┴──────────────────┴────┘
```

**Data Flow:**
1. Meter connects via TCP → Connection Manager tracks it
2. Protocol Router detects protocol from first bytes:
   - `0x68` → DLT645 Frame Parser
   - `0x00 0x01` → IVY Wrapper Parser → Heartbeat or DLMS APDU
   - Known DLMS tag → Raw DLMS Parser (synthetic IVY header)
3. Parsed data → Telemetry Publisher → MQTT topic
4. Polling Manager periodically reads registers from meters (DLT645 or DLMS)
5. Status Manager monitors for alarm conditions
6. MQTT commands → Command Handler → TCP to meter

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 20+ | ES modules, async/await |
| TCP Server | `net` (built-in) | Meter connections |
| MQTT Broker | `aedes` | Embedded MQTT 3.1.1 |
| WebSocket | `ws` | MQTT over WebSocket |
| HTTP Server | `express` | Dashboard serving |
| Logging | `winston` | Structured JSON logs |
| Config | `dotenv` | Environment variables |
| Testing | `vitest` | Unit/integration tests |

## Directory Structure

```
src/
├── index.js                    # Entry point, wires all components
├── config/
│   └── index.js                # Environment config loader
├── tcp/
│   ├── server.js               # TCP server (EventEmitter)
│   ├── connection-manager.js   # Connection lifecycle
│   └── rate-limiter.js         # IP-based rate limiting
├── mqtt/
│   ├── broker.js               # Aedes MQTT broker
│   ├── publisher.js            # Publishes to MQTT topics
│   ├── command-handler.js      # Handles MQTT commands
│   └── auth.js                 # MQTT authentication
├── protocol/
│   ├── registers.js            # DL/T 645 register definitions
│   ├── frame-parser.js         # DLT645 frame decoder
│   ├── frame-builder.js        # DLT645 request frame builder
│   ├── bcd.js                  # BCD encoding/decoding
│   ├── checksum.js             # Frame checksum
│   ├── protocol-router.js      # Auto-detect protocol from first bytes
│   ├── ivy-wrapper.js          # IVY 8-byte header parser/builder
│   ├── heartbeat-handler.js    # IVY EM114070 heartbeat packets
│   └── dlms/
│       ├── apdu-parser.js      # DLMS APDU parser (EventNotification, GET.response, etc.)
│       ├── client.js           # DLMS AARQ/GET.request/RLRQ builders
│       ├── data-types.js       # DLMS data type decoder (INT32, UINT32, OCTET_STRING, etc.)
│       ├── obis-registry.js    # OBIS code → name/unit/category mapping
│       └── dlms-probe.js       # DLMS association probe utility
├── services/
│   ├── polling-manager.js      # Periodic meter polling (DLT645 + DLMS)
│   ├── status-manager.js       # Health & alarm monitoring
│   └── dlms-capture-service.js # Raw DLMS packet capture & analysis
├── http/
│   ├── server.js               # Express HTTP server
│   └── security.js             # Security middleware
└── utils/
    └── logger.js               # Winston logger config

debug/
├── dlms-obis-probe.js          # Interactive OBIS code scanner
├── dlms-obis-bruteforce.js     # Exhaustive OBIS code brute-force scanner
└── ivy-dlt645-probe.js         # DLT645 meter probe tool
```

## Key Concepts

### Meter Address
- 12-digit decimal string (e.g., `"000000001234"`)
- Stored as 6-byte BCD in little-endian order (DLT645)
- Extracted from ASCII heartbeat packet (IVY EM114070)
- Broadcast address: `"999999999999"` or `"AAAAAAAAAAAA"`

### DL/T 645-2007 Protocol
- Chinese standard for electricity meter communication
- Binary protocol with BCD encoding
- Frame structure: `[0x68][Address][0x68][Control][Length][Data][CS][0x16]`
- All data bytes have +0x33 offset applied
- See [.claude/protocols.md](.claude/protocols.md) for details

### IVY Wrapper Protocol
- Proprietary 8-byte header used by IVY EM114070 meters
- Header: `Version(2 BE) + Source(2 BE) + Destination(2 BE) + PayloadLength(2 BE)`
- Version is always `0x0001`, Source is always `0x0001`
- Destination `0x0001` carries both heartbeat packets and DLMS APDUs
- Content-based routing at destination `0x0001`: heartbeat starts with `0x0a` byte at payload[0], DLMS APDUs start with known tags (0x61, 0xC4, 0xC2, etc.)
- Raw DLMS APDUs (without IVY header) also supported via synthetic header injection

### DLMS/COSEM Protocol
- International standard (IEC 62056) for energy meter communication
- Used by IVY EM114070 via IVY wrapper
- Association: AARQ (0x60) → AARE (0x61), using LN_NO_CIPHER context
- Data access: GET.request (0xC0) → GET.response (0xC4)
- Push data: EventNotification (0xC2), DataNotification (0x0F)
- Error handling: ExceptionResponse (0xD8), data-access-result error codes
- OBIS codes identify registers (format: `A-B:C.D.E.F`)
- Values use integer types (INT32, UINT32) with scaler conversion (e.g., 0.01 for voltage)

### Protocol Router
- Detects protocol from first byte of TCP data (stateful per connection)
- `0x68` → DLT645 protocol
- `0x00 0x01` (4-byte signature `00 01 00 01`) → IVY/DLMS protocol
- Known DLMS APDU tags → IVY/DLMS protocol (raw DLMS without wrapper)
- Once detected, all subsequent data on that connection uses the same parser

### MQTT Topics
- Prefix: `ivy/v1`
- Pattern: `ivy/v1/meters/{meterId}/telemetry`
- See [.claude/mqtt-topics.md](.claude/mqtt-topics.md) for all topics

### Register Groups
- `energy` - kWh readings (total, tariffs)
- `power` - Active/reactive/apparent power
- `voltage` - Phase voltages (A, B, C)
- `current` - Phase currents (A, B, C)
- `powerFactor` - Power factor readings

## Code Conventions

### Naming
| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `frame-parser.js` |
| Functions | camelCase | `parseFrame()` |
| Classes | PascalCase | `TCPServer` |
| Constants | UPPER_SNAKE | `CONTROL_CODES` |
| Events | colon-separated | `meter:connected` |

### Module Pattern
```javascript
// Every module exports:
export class MyClass extends EventEmitter { }
export const MY_EVENTS = { EVENT_A: 'event:a' };
export const createMyClass = (options) => new MyClass(options);
export default { MyClass, MY_EVENTS, createMyClass };
```

### Event Pattern
```javascript
// Emit with context object
this.emit(EVENTS.SOMETHING_HAPPENED, {
  meterId: '000000001234',
  timestamp: Date.now(),
  data: { /* relevant data */ }
});
```

### Error Handling
```javascript
// Always log with context
try {
  // operation
} catch (error) {
  logger.error('Operation failed', {
    meterId,
    error: error.message,
    stack: error.stack
  });
}
```

## Testing Strategy

```bash
npm test              # Watch mode
npm run test:run      # Single run (CI)
npm run test:coverage # With coverage
npm run lint          # ESLint check
```

**Test Structure:**
- `tests/unit/` - Unit tests per module
- `tests/integration/` - TCP/MQTT flow tests
- ~982 test cases, 29 source files

**Key Test Files:**
- `tests/unit/protocol/*.test.js` - DLT645 protocol parsing
- `tests/unit/protocol/dlms/*.test.js` - DLMS APDU parsing, OBIS registry, data types
- `tests/unit/protocol/ivy-wrapper.test.js` - IVY header parsing and stream parser
- `tests/unit/protocol/heartbeat-handler.test.js` - Heartbeat detection and parsing
- `tests/unit/protocol/protocol-router.test.js` - Protocol auto-detection
- `tests/unit/mqtt/*.test.js` - MQTT components
- `tests/unit/services/dlms-capture-service.test.js` - DLMS capture service
- `tests/integration/tcp-flow.test.js` - TCP server flows
- `tests/integration/mqtt-flow.test.js` - End-to-end MQTT

## Common Tasks

### Adding a New DLT645 Register
1. Edit `src/protocol/registers.js`
2. Add to appropriate category (ENERGY, INSTANTANEOUS, etc.)
3. Include: `id`, `name`, `unit`, `resolution`, `bytes`
4. Add tests in `tests/unit/protocol/registers.test.js`

### Adding a New OBIS Code
1. Edit `src/protocol/dlms/obis-registry.js`
2. Add entry to `OBIS_REGISTRY` with: `name`, `unit`, `category`, `key`, optional `scaler`
3. If the code should be polled, add to `DLMS_POLL_REGISTERS` in `src/services/polling-manager.js`
4. Add tests in `tests/unit/protocol/dlms/obis-registry.test.js`

### Adding a New DLMS APDU Type
1. Edit `src/protocol/dlms/apdu-parser.js` - add tag to `APDU_TAGS`, add parser function, add case to `parseApdu()` switch
2. Edit `src/protocol/ivy-wrapper.js` - add tag to `RAW_DLMS_TAGS` set, add length computation case to `computeRawDlmsLength()`
3. Add tests in `tests/unit/protocol/dlms/apdu-parser.test.js`

### Adding a New Command
1. Edit `src/mqtt/command-handler.js`
2. Add method to `COMMAND_METHODS`
3. Create handler: `handle{MethodName}(meterId, params)`
4. For DLMS meters: check `protocolType` and use DLMS client builders
5. Add validation and response format
6. Add tests

### Adding a New Alarm Type
1. Edit `src/services/status-manager.js`
2. Add to `DEFAULT_THRESHOLDS`
3. Add to `ALARM_TYPES`
4. Add check in `checkAlarms()` method
5. Add tests

### Running DLMS Probe Tools
```bash
# Interactive OBIS code scanner (probe specific codes)
node debug/dlms-obis-probe.js <meter-ip> <meter-port>

# Brute-force OBIS scan (try all codes in range)
node debug/dlms-obis-bruteforce.js <meter-ip> <meter-port>

# DLT645 meter probe
node debug/ivy-dlt645-probe.js <meter-ip> <meter-port>
```

### Debugging Frame Issues
```javascript
// DLT645 debugging
import { describeFrame } from './src/protocol/frame-builder.js';
import { bufferToHex } from './src/protocol/bcd.js';
console.log(bufferToHex(frame));  // '68 34 12 00 ...'
console.log(describeFrame(frame)); // { address, control, data, ... }

// IVY header debugging
import { parseIvyHeader } from './src/protocol/ivy-wrapper.js';
const header = parseIvyHeader(buffer);
// { version: 1, source: 1, destination: 1, payloadLength: 18 }

// DLMS APDU debugging
import { parseApdu } from './src/protocol/dlms/apdu-parser.js';
const parsed = parseApdu(payload);
// { type: 'get-response', tag: 0xC4, invokeId: 1, data: {...} }
```

## Important Files

| File | Purpose |
|------|---------|
| `src/index.js` | Main entry, component wiring |
| `src/config/index.js` | All configuration options |
| `src/protocol/registers.js` | DLT645 register definitions (data IDs) |
| `src/protocol/frame-parser.js` | DLT645 frame decoding logic |
| `src/protocol/protocol-router.js` | Protocol auto-detection and routing |
| `src/protocol/ivy-wrapper.js` | IVY 8-byte header parser, stream parser, raw DLMS handling |
| `src/protocol/heartbeat-handler.js` | IVY EM114070 heartbeat packet parser |
| `src/protocol/dlms/apdu-parser.js` | DLMS APDU parser and telemetry extractor |
| `src/protocol/dlms/client.js` | DLMS AARQ/GET.request/RLRQ builders |
| `src/protocol/dlms/obis-registry.js` | OBIS code → name/unit/category registry |
| `src/protocol/dlms/data-types.js` | DLMS data type decoder |
| `src/services/polling-manager.js` | Periodic polling (DLT645 + DLMS) |
| `src/services/dlms-capture-service.js` | Raw DLMS packet capture for analysis |
| `src/mqtt/publisher.js` | MQTT topic publishing |
| `src/tcp/server.js` | TCP server events |

## Environment Variables

See `.env.example` for all options. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | development | Environment mode |
| `TCP_PORT` | 8899 | Meter TCP port |
| `MQTT_PORT` | 1883 | MQTT broker port |
| `MQTT_WS_PORT` | 9001 | MQTT WebSocket port |
| `HTTP_PORT` | 3000 | Dashboard port |
| `POLLING_INTERVAL` | 60000 | Polling interval (ms) |
| `POLLING_REGISTER_GROUP` | energy | Registers to poll |
| `DLMS_ENABLED` | true | Enable DLMS protocol support |
| `DLMS_PASSIVE_ONLY` | true | Only parse DLMS, don't actively query |
| `DLMS_CLIENT_ADDRESS` | 0x10 | DLMS public client address |
| `DLMS_ASSOCIATION_TIMEOUT` | 5000 | DLMS association timeout (ms) |
| `DLMS_QUERY_TIMEOUT` | 5000 | DLMS query timeout (ms) |
| `DLMS_AUTO_ASSOCIATE` | false | Auto-send AARQ on connection |
| `DLMS_WRAP_OUTGOING` | true | Wrap outgoing DLMS with IVY header |
| `DLMS_IVY_DESTINATION` | 0x0001 | IVY destination for DLMS packets |
| `DLMS_CAPTURE_ENABLED` | false | Enable DLMS packet capture |
| `DLMS_CAPTURE_DURATION` | 3600000 | Capture duration (ms) |
| `HEARTBEAT_ACK_ENABLED` | false | Send ACK after heartbeat |
| `HEARTBEAT_ACK_PAYLOAD` | (empty) | ACK payload hex string |
| `HEARTBEAT_ZERO_ADDRESS_ACTION` | accept | Action for zero address: accept or use_ip |

## Deployment

```bash
# Quick deploy on Ubuntu
sudo ./deploy.sh

# Service management
sudo systemctl status ivy-gateway
sudo journalctl -u ivy-gateway -f
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for detailed guide.

## Known Issues & TODOs

### Current Limitations
- No database persistence (in-memory only)
- No Redis integration yet
- Single-node only (no clustering)
- DLMS relay control not yet implemented
- Per-phase voltage/current not available on EM114070 (returns only total)

### Future Enhancements
- PostgreSQL/TimescaleDB for telemetry storage
- Redis for session state
- Multi-gateway coordination
- Historical data API
- DLMS relay/disconnect control via OBIS 0-0:96.3.10.255

## Quick Reference

### Ports
| Port | Protocol | Service |
|------|----------|---------|
| 8899 | TCP | Meter connections |
| 1883 | MQTT | MQTT broker |
| 9001 | WebSocket | MQTT WebSocket |
| 3000 | HTTP | Dashboard |

### Supported Meters
| Meter | Protocol | Detection | Notes |
|-------|----------|-----------|-------|
| Generic DLT645 | DL/T 645-2007 | First byte 0x68 | BCD-encoded registers |
| IVY EM114070 | DLMS/COSEM via IVY | First bytes 00 01 00 01 | 14 confirmed OBIS codes |

### MQTT Topics
```
ivy/v1/meters/{meterId}/telemetry         # Readings
ivy/v1/meters/{meterId}/status            # Online/offline
ivy/v1/meters/{meterId}/events            # Alarms
ivy/v1/meters/{meterId}/command/request   # Send command
ivy/v1/meters/{meterId}/command/response  # Command result
ivy/v1/gateway/status                     # Gateway status
```

### Common Commands
```bash
npm run dev          # Development mode
npm run test         # Run tests
npm run lint         # Check code
npm start            # Production start
```

## Additional Context Files

- [.claude/protocols.md](.claude/protocols.md) - DL/T 645-2007 and DLMS/COSEM protocol details
- [.claude/mqtt-topics.md](.claude/mqtt-topics.md) - MQTT topics and payloads
- [.claude/development.md](.claude/development.md) - Development guide
- [.claude/troubleshooting.md](.claude/troubleshooting.md) - Debug reference
- [.claude/context/project-status.md](.claude/context/project-status.md) - Current project status
- [.claude/context/decisions.md](.claude/context/decisions.md) - Architecture decision records
- [.claude/context/discoveries.md](.claude/context/discoveries.md) - EM114070 empirical findings
- [.claude/skills/add-obis-code.md](.claude/skills/add-obis-code.md) - Adding OBIS codes
- [.claude/skills/add-dlms-apdu-type.md](.claude/skills/add-dlms-apdu-type.md) - Adding DLMS APDU types
- [.claude/skills/add-register.md](.claude/skills/add-register.md) - Adding DLT645 registers
- [.claude/skills/add-command.md](.claude/skills/add-command.md) - Adding MQTT commands
- [.claude/skills/debug-protocol.md](.claude/skills/debug-protocol.md) - Protocol debugging
- [.claude/skills/add-alarm-type.md](.claude/skills/add-alarm-type.md) - Adding alarm types
