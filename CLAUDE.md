# CLAUDE.md - IVY 4G Gateway

This file provides context for Claude Code to understand, maintain, and extend this project.

## Project Overview

**IVY 4G Gateway** is an IoT gateway that bridges DL/T 645-2007 energy meters to MQTT. It receives TCP connections from 4G-enabled meters, parses the DL/T 645 protocol frames, and publishes telemetry data over MQTT for backend systems to consume.

**Primary Functions:**
- Accept TCP connections from energy meters (port 8899)
- Parse DL/T 645-2007 protocol frames (Chinese energy meter standard)
- Publish meter readings to MQTT topics
- Handle commands from MQTT (read registers, relay control)
- Automatic periodic polling of meters
- Real-time alarm monitoring (voltage, current, power)

**Target Users:**
- Energy management platforms
- Building management systems
- Prepaid electricity systems

## Architecture

```
┌─────────────┐     TCP/DL/T645    ┌─────────────────────────────────────┐
│   Energy    │ ─────────────────► │           IVY 4G Gateway            │
│   Meters    │ ◄───────────────── │                                     │
│  (4G/LTE)   │                    │  ┌─────────┐  ┌──────────────────┐  │
└─────────────┘                    │  │TCP      │  │MQTT Broker       │  │
                                   │  │Server   │──│(Aedes)           │  │
                                   │  │:8899    │  │:1883 TCP         │  │
                                   │  └─────────┘  │:9001 WebSocket   │  │
                                   │       │       └──────────────────┘  │
                                   │       ▼              │              │
                                   │  ┌─────────┐        │              │
                                   │  │Polling  │        ▼              │
                                   │  │Manager  │  ┌──────────────────┐  │
                                   │  └─────────┘  │Publisher         │  │──► MQTT Clients
                                   │       │       │Command Handler   │  │
                                   │       ▼       └──────────────────┘  │
                                   │  ┌─────────┐                       │
                                   │  │Status   │                       │
                                   │  │Manager  │  ┌──────────────────┐  │
                                   │  └─────────┘  │HTTP Dashboard    │  │──► Browser
                                   │               │:3000             │  │
                                   └───────────────┴──────────────────┴──┘
```

**Data Flow:**
1. Meter connects via TCP → Connection Manager tracks it
2. Meter sends data frames → Frame Parser decodes DL/T 645
3. Parsed data → Telemetry Publisher → MQTT topic
4. Polling Manager periodically reads registers from meters
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
├── index.js              # Entry point, wires all components
├── config/
│   └── index.js          # Environment config loader
├── tcp/
│   ├── server.js         # TCP server (EventEmitter)
│   ├── connection-manager.js  # Connection lifecycle
│   └── rate-limiter.js   # IP-based rate limiting
├── mqtt/
│   ├── broker.js         # Aedes MQTT broker
│   ├── publisher.js      # Publishes to MQTT topics
│   ├── command-handler.js # Handles MQTT commands
│   └── auth.js           # MQTT authentication
├── protocol/
│   ├── registers.js      # DL/T 645 register definitions
│   ├── frame-parser.js   # Decode received frames
│   ├── frame-builder.js  # Build request frames
│   ├── bcd.js            # BCD encoding/decoding
│   └── checksum.js       # Frame checksum
├── services/
│   ├── polling-manager.js # Periodic meter polling
│   └── status-manager.js  # Health & alarm monitoring
├── http/
│   ├── server.js         # Express HTTP server
│   └── security.js       # Security middleware
└── utils/
    └── logger.js         # Winston logger config
```

## Key Concepts

### Meter Address
- 12-digit decimal string (e.g., `"000000001234"`)
- Stored as 6-byte BCD in little-endian order
- Broadcast address: `"999999999999"` or `"AAAAAAAAAAAA"`

### DL/T 645-2007 Protocol
- Chinese standard for electricity meter communication
- Binary protocol with BCD encoding
- Frame structure: `[0x68][Address][0x68][Control][Length][Data][CS][0x16]`
- All data bytes have +0x33 offset applied
- See [.claude/protocols.md](.claude/protocols.md) for details

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
- 671 tests, ~3.5s runtime

**Key Test Files:**
- `tests/unit/protocol/*.test.js` - Protocol parsing
- `tests/unit/mqtt/*.test.js` - MQTT components
- `tests/integration/tcp-flow.test.js` - TCP server flows
- `tests/integration/mqtt-flow.test.js` - End-to-end MQTT

## Common Tasks

### Adding a New Register
1. Edit `src/protocol/registers.js`
2. Add to appropriate category (ENERGY, INSTANTANEOUS, etc.)
3. Include: `id`, `name`, `unit`, `resolution`, `bytes`
4. Add tests in `tests/unit/protocol/registers.test.js`

### Adding a New Command
1. Edit `src/mqtt/command-handler.js`
2. Add method to `COMMAND_METHODS`
3. Create handler: `handle{MethodName}(meterId, params)`
4. Add validation and response format
5. Add tests

### Adding a New Alarm Type
1. Edit `src/services/status-manager.js`
2. Add to `DEFAULT_THRESHOLDS`
3. Add to `ALARM_TYPES`
4. Add check in `checkAlarms()` method
5. Add tests

### Debugging Frame Issues
```javascript
import { describeFrame } from './src/protocol/frame-builder.js';
import { bufferToHex } from './src/protocol/bcd.js';

console.log(bufferToHex(frame));  // '68 34 12 00 ...'
console.log(describeFrame(frame)); // { address, control, data, ... }
```

## Important Files

| File | Purpose |
|------|---------|
| `src/index.js` | Main entry, component wiring |
| `src/config/index.js` | All configuration options |
| `src/protocol/registers.js` | Register definitions (data IDs) |
| `src/protocol/frame-parser.js` | Frame decoding logic |
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

### Future Enhancements
- PostgreSQL/TimescaleDB for telemetry storage
- Redis for session state
- Multi-gateway coordination
- Historical data API

## Quick Reference

### Ports
| Port | Protocol | Service |
|------|----------|---------|
| 8899 | TCP | Meter connections |
| 1883 | MQTT | MQTT broker |
| 9001 | WebSocket | MQTT WebSocket |
| 3000 | HTTP | Dashboard |

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

- [.claude/protocols.md](.claude/protocols.md) - DL/T 645-2007 protocol details
- [.claude/mqtt-topics.md](.claude/mqtt-topics.md) - MQTT topics and payloads
- [.claude/development.md](.claude/development.md) - Development guide
- [.claude/troubleshooting.md](.claude/troubleshooting.md) - Debug reference
