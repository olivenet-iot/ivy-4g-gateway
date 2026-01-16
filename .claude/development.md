# Development Guide

This guide covers development setup, testing, and common tasks for IVY 4G Gateway.

## Setup

### Prerequisites
- Node.js 20 LTS
- npm 10+
- Git

### Clone and Install

```bash
git clone https://github.com/olivenet-iot/ivy-4g-gateway.git
cd ivy-4g-gateway
npm install
```

### Configure Environment

```bash
cp .env.example .env
# Edit .env for local settings (usually defaults are fine for dev)
```

Key development settings:
```bash
NODE_ENV=development
LOG_LEVEL=debug
POLLING_ENABLED=false  # Disable for manual testing
```

## Running Locally

### Development Mode (with auto-restart)

```bash
npm run dev
```

This uses `--watch` flag for automatic restarts on file changes.

### Production Mode

```bash
npm start
```

### Verify Services

After starting:
- TCP Server: `telnet localhost 8899`
- MQTT Broker: `mosquitto_sub -h localhost -t '#' -v`
- Dashboard: `http://localhost:3000`
- Health Check: `curl http://localhost:3000/health`

## Testing

### Run All Tests

```bash
npm test           # Watch mode (interactive)
npm run test:run   # Single run (CI-friendly)
```

### Run Specific Tests

```bash
# Run tests for a specific file
npm test -- src/protocol/frame-parser

# Run tests matching a pattern
npm test -- --grep "should parse"

# Run only unit tests
npm test -- tests/unit

# Run only integration tests
npm test -- tests/integration
```

### Coverage Report

```bash
npm run test:coverage
```

Coverage report generated in `coverage/` directory.

### Test Structure

```
tests/
├── unit/
│   ├── protocol/
│   │   ├── bcd.test.js
│   │   ├── checksum.test.js
│   │   ├── frame-builder.test.js
│   │   ├── frame-parser.test.js
│   │   └── registers.test.js
│   ├── tcp/
│   │   ├── server.test.js
│   │   └── connection-manager.test.js
│   ├── mqtt/
│   │   ├── broker.test.js
│   │   ├── publisher.test.js
│   │   ├── auth.test.js
│   │   └── command-handler.test.js
│   └── services/
│       ├── polling-manager.test.js
│       └── status-manager.test.js
└── integration/
    ├── tcp-flow.test.js
    └── mqtt-flow.test.js
```

### Writing Tests

Use Vitest with `describe`/`it`/`expect`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseFrame } from '../../../src/protocol/frame-parser.js';

describe('Frame Parser', () => {
  describe('parseFrame', () => {
    it('should parse valid read response', () => {
      const frame = Buffer.from([0x68, /* ... */, 0x16]);
      const result = parseFrame(frame);

      expect(result.success).toBe(true);
      expect(result.address).toBe('000000001234');
    });

    it('should handle invalid frame', () => {
      const frame = Buffer.from([0x00, 0x01]);
      const result = parseFrame(frame);

      expect(result.success).toBe(false);
    });
  });
});
```

### Mocking Patterns

**Mock TCP Connection:**
```javascript
import { vi } from 'vitest';

const mockSocket = {
  write: vi.fn(),
  on: vi.fn(),
  end: vi.fn(),
  remoteAddress: '127.0.0.1',
  remotePort: 12345
};
```

**Mock MQTT Broker:**
```javascript
const mockBroker = {
  publish: vi.fn().mockResolvedValue(),
  isRunning: true
};
```

## Adding New Features

### Adding a New Register

1. **Edit `src/protocol/registers.js`:**

```javascript
// Add to appropriate category (ENERGY, INSTANTANEOUS, PARAMETERS, etc.)
export const REGISTERS = {
  // ... existing registers ...

  NEW_REGISTER: {
    id: 0x02010400,           // Data identifier
    name: 'New Register Name',
    unit: 'unit',             // V, A, kWh, etc.
    resolution: 0.01,         // Multiply raw value by this
    bytes: 4,                 // Number of data bytes
    signed: false,            // true if value can be negative
    description: 'Description of what this measures'
  },
};
```

2. **Add to group if needed:**

```javascript
export const REGISTER_GROUPS = {
  // ... existing groups ...
  custom: ['NEW_REGISTER', 'OTHER_REGISTER'],
};
```

3. **Add tests in `tests/unit/protocol/registers.test.js`:**

```javascript
it('should have NEW_REGISTER defined', () => {
  expect(REGISTERS.NEW_REGISTER).toBeDefined();
  expect(REGISTERS.NEW_REGISTER.id).toBe(0x02010400);
  expect(REGISTERS.NEW_REGISTER.unit).toBe('unit');
});
```

### Adding a New Command

1. **Edit `src/mqtt/command-handler.js`:**

```javascript
// Add to COMMAND_METHODS
export const COMMAND_METHODS = {
  READ_REGISTER: 'read_register',
  RELAY_CONTROL: 'relay_control',
  READ_ADDRESS: 'read_address',
  READ_ALL: 'read_all',
  NEW_COMMAND: 'new_command',    // Add new method
};

// Add handler method to CommandHandler class
async handleNewCommand(meterId, params) {
  // Validate parameters
  if (!params.requiredParam) {
    return { success: false, error: 'Missing requiredParam' };
  }

  // Get connection
  const connection = this.tcpServer.getConnection(meterId);
  if (!connection) {
    return { success: false, error: 'Meter not connected' };
  }

  // Build and send frame
  const frame = buildSomeFrame(meterId, params);

  try {
    const response = await this.tcpServer.sendCommand(
      meterId,
      frame,
      expectedDataId,
      this.options.timeout
    );

    return {
      success: true,
      result: {
        // processed response data
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Add to command routing in handleCommand()
case COMMAND_METHODS.NEW_COMMAND:
  result = await this.handleNewCommand(meterId, params);
  break;
```

2. **Add tests in `tests/unit/mqtt/command-handler.test.js`**

### Adding a New Alarm Type

1. **Edit `src/services/status-manager.js`:**

```javascript
// Add to DEFAULT_THRESHOLDS
export const DEFAULT_THRESHOLDS = {
  // ... existing thresholds ...
  newAlarmThreshold: 100,
};

// Add to ALARM_TYPES
export const ALARM_TYPES = {
  // ... existing types ...
  NEW_ALARM: 'NEW_ALARM',
};

// Add check in checkAlarms() method
checkAlarms(meterId, data) {
  const alarms = [];

  // ... existing checks ...

  // New alarm check
  if (data.newValue !== undefined) {
    if (data.newValue > this.options.newAlarmThreshold) {
      alarms.push({
        type: ALARM_TYPES.NEW_ALARM,
        severity: 'warning',
        value: data.newValue,
        threshold: this.options.newAlarmThreshold,
        message: `New value ${data.newValue} exceeded threshold ${this.options.newAlarmThreshold}`
      });
    }
  }

  return alarms;
}
```

2. **Add tests in `tests/unit/services/status-manager.test.js`**

### Modifying MQTT Payload Format

1. **Edit `src/mqtt/publisher.js`:**

```javascript
// Modify the appropriate publish method
async publishTelemetry(meterId, data) {
  const payload = {
    ts: Date.now(),
    meterId,
    // Add or modify fields here
    newField: data.newField,
    // ...
  };

  await this.publish(
    Topics.meterTelemetry(meterId),
    payload
  );
}
```

2. **Update documentation in `.claude/mqtt-topics.md`**

3. **Update tests to verify new format**

## Code Patterns

### EventEmitter Pattern

All managers extend EventEmitter:

```javascript
import { EventEmitter } from 'events';

export const MY_EVENTS = {
  SOMETHING_HAPPENED: 'something:happened',
};

export class MyManager extends EventEmitter {
  doSomething() {
    // ... do work ...

    this.emit(MY_EVENTS.SOMETHING_HAPPENED, {
      meterId,
      timestamp: Date.now(),
      data: result
    });
  }
}
```

### Factory Pattern

Every module exports a factory function:

```javascript
export class MyClass {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }
}

export const createMyClass = (options) => new MyClass(options);
```

### Async Command Pattern

TCP commands use Promise-based request/response:

```javascript
async sendCommand(meterId, frame, dataId, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error('Command timeout'));
    }, timeout);

    // Store pending command
    this.pendingCommands.set(commandId, {
      resolve: (result) => {
        clearTimeout(timeoutHandle);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      }
    });

    // Send frame
    connection.socket.write(frame);
  });
}
```

### Logger Pattern

Use child loggers for module context:

```javascript
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'my-module' });

logger.info('Something happened', {
  meterId,
  value: 123,
  unit: 'kWh'
});
```

## Debugging Tips

### Enable Debug Logging

```bash
LOG_LEVEL=debug npm run dev
```

### View Frame Hex Dumps

```javascript
import { bufferToHex } from './src/protocol/bcd.js';
import { describeFrame } from './src/protocol/frame-builder.js';

console.log(bufferToHex(frame));     // '68 34 12 00 ...'
console.log(describeFrame(frame));   // { address, control, data, ... }
```

### Test MQTT Manually

```bash
# Subscribe to all topics
mosquitto_sub -h localhost -t 'ivy/v1/#' -v

# Publish a command
mosquitto_pub -h localhost \
  -t 'ivy/v1/meters/000000001234/command/request' \
  -m '{"id":"test-1","method":"read_register","params":{"register":"TOTAL_ACTIVE_POSITIVE"}}'
```

### Simulate Meter Connection

Use the meter simulator script:

```bash
node scripts/simulate-meter.js
```

## Linting & Formatting

```bash
npm run lint          # Check for issues
npm run lint:fix      # Auto-fix issues
npm run format        # Format with Prettier
```

## Performance Considerations

### Connection Limits
- Default max connections: 1000
- Per-IP limit: 10 connections
- Adjust via `MAX_CONNECTIONS_PER_IP` env var

### Memory Usage
- Each connection: ~50KB
- Each pending command: ~1KB
- Status manager state: ~1KB per meter

### Polling Impact
- Default interval: 60 seconds
- Stagger delay: 100ms between meters
- Consider disabling for high meter counts

### Rate Limiting
- Connection attempts: 20 per minute per IP
- Block duration: 5 minutes
- HTTP requests: 100 per minute per IP
