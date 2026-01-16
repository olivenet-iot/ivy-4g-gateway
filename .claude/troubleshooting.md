# Troubleshooting for Claude

This guide helps debug common issues at the code level.

## Common Code Issues

### Frame Parsing Failures

**Symptom:** `parseFrame()` returns `success: false`

**Debug Steps:**

1. **Check frame hex dump:**
```javascript
import { bufferToHex } from './src/protocol/bcd.js';
console.log('Frame:', bufferToHex(frame));
```

2. **Validate structure:**
```javascript
import { validateFrameStructure } from './src/protocol/checksum.js';
const result = validateFrameStructure(frame);
console.log('Structure:', result);
// { valid: true/false, errors: [...] }
```

3. **Common issues:**
   - Missing start delimiter (`0x68`)
   - Missing end delimiter (`0x16`)
   - Wrong data length field
   - Checksum mismatch

**Fix:** Check frame construction in `buildReadFrame()` or verify meter response format.

### BCD Conversion Errors

**Symptom:** Incorrect values after parsing

**Debug Steps:**

1. **Check raw bytes:**
```javascript
import { removeOffset, bcdToDecimal } from './src/protocol/bcd.js';

// Remove +0x33 offset first
const dataWithoutOffset = removeOffset(dataBytes);
console.log('Without offset:', bufferToHex(dataWithoutOffset));

// Then decode BCD
const value = bcdToDecimal(dataWithoutOffset);
console.log('Decoded value:', value);
```

2. **Common issues:**
   - Forgetting to remove +0x33 offset
   - Wrong byte order (should be little-endian)
   - Wrong decimal resolution

### Address Format Issues

**Symptom:** Meter not found or wrong meter matched

**Debug Steps:**

```javascript
import { addressToBuffer, bufferToAddress } from './src/protocol/bcd.js';

// Check address conversion
const address = '000000001234';
const buffer = addressToBuffer(address);
console.log('Buffer:', bufferToHex(buffer));  // Should be [0x34, 0x12, 0x00, 0x00, 0x00, 0x00]

// Reverse check
const recovered = bufferToAddress(buffer);
console.log('Recovered:', recovered);  // Should be '000000001234'
```

**Common issues:**
- Address not 12 digits (must be zero-padded)
- Byte order incorrect (should be little-endian)

### Connection Manager Issues

**Symptom:** `getConnection()` returns undefined

**Debug Steps:**

```javascript
// Check all connections
const connections = tcpServer.connectionManager.getConnections();
console.log('Connections:', connections.map(c => ({
  id: c.id,
  meterId: c.meterId,
  ip: c.remoteAddress
})));

// Check specific meter
const conn = tcpServer.getConnection(meterId);
console.log('Connection for', meterId, ':', conn);
```

**Common issues:**
- Meter ID not yet identified (heartbeat not received)
- Connection closed before command sent
- Wrong meter ID format

### Pending Commands Not Resolving

**Symptom:** Commands hang or timeout

**Debug Steps:**

```javascript
// Check pending commands
const connection = connectionManager.connections.get(connectionId);
console.log('Pending commands:', connection.pendingCommands.size);

for (const [id, cmd] of connection.pendingCommands) {
  console.log('Command:', id, {
    dataId: cmd.dataId,
    sentAt: new Date(cmd.sentAt).toISOString()
  });
}
```

**Common issues:**
- Response frame not matching expected data ID
- Frame parsing error preventing resolution
- Meter not responding

## Log Analysis

### Log Format

```
2024-01-15 10:30:45.123 [info]: Message {"module":"tcp-server","meterId":"001234",...}
```

### Key Log Messages

**TCP Server:**
```
[info] TCPServer created                    # Server initialized
[info] TCP Server started                   # Listening on port
[debug] New connection                      # Client connected
[debug] Meter identified                    # Heartbeat received
[info] Meter connected                      # Ready for commands
[info] Meter disconnected                   # Connection closed
```

**MQTT Broker:**
```
[info] MQTT Broker started                  # Broker listening
[info] MQTT client connected                # Client connected
[info] MQTT client disconnected             # Client disconnected
[debug] Message published                   # Published to topic
```

**Polling:**
```
[info] Polling cycle started                # Cycle beginning
[debug] Polling meter                       # Reading specific meter
[info] Polling cycle completed              # Cycle finished
[warn] Polling failed                       # Read error
```

**Status Manager:**
```
[info] Alarm triggered                      # Threshold exceeded
[info] Alarm cleared                        # Back to normal
[debug] Event created                       # Event published
```

### Filtering Logs

```bash
# By module
journalctl -u ivy-gateway | grep '"module":"tcp-server"'

# By meter
journalctl -u ivy-gateway | grep '"meterId":"001234"'

# By level
journalctl -u ivy-gateway -p err  # Errors only

# Last 100 lines
journalctl -u ivy-gateway -n 100
```

## Frame Debugging

### Decode a Response Frame

```javascript
import { parseFrame, parseReadResponse } from './src/protocol/frame-parser.js';
import { findRegisterById } from './src/protocol/registers.js';
import { bufferToHex } from './src/protocol/bcd.js';

const frame = Buffer.from([0x68, 0x34, 0x12, /* ... */, 0x16]);

// Step 1: Basic parse
const parsed = parseFrame(frame);
console.log('Parsed:', parsed);

// Step 2: If read response, get value
if (parsed.success && parsed.controlCode === 0x91) {
  // Find register by data ID
  const register = findRegisterById(parsed.dataId);
  console.log('Register:', register);

  // Parse with register info
  const response = parseReadResponse(frame, register);
  console.log('Response:', response);
}
```

### Build and Verify a Request Frame

```javascript
import { buildReadFrame, describeFrame } from './src/protocol/frame-builder.js';
import { bufferToHex } from './src/protocol/bcd.js';

const address = '000000001234';
const dataId = 0x00000000;  // Total active energy

const frame = buildReadFrame(address, dataId);

console.log('Frame hex:', bufferToHex(frame));
console.log('Frame details:', describeFrame(frame));
```

### Verify Checksum

```javascript
import { verifyChecksum, calculateChecksum } from './src/protocol/checksum.js';

const frame = Buffer.from([/* ... */]);

const result = verifyChecksum(frame);
console.log('Checksum valid:', result.valid);
console.log('Expected:', result.expected.toString(16));
console.log('Actual:', result.actual.toString(16));
```

## Connection Issues

### TCP Connection Not Establishing

**Check:**
1. Port availability: `netstat -tlnp | grep 8899`
2. Firewall rules: `ufw status`
3. Server listening: Check startup logs

**Debug:**
```javascript
// In tcp/server.js
this.server.on('error', (error) => {
  console.error('Server error:', error);
});

this.server.on('listening', () => {
  console.log('Server listening on', this.server.address());
});
```

### MQTT Connection Failing

**Check:**
1. Broker running: Port 1883 or 9001 listening
2. Authentication: Check `MQTT_AUTH_ENABLED` setting
3. ACL rules: Check topic permissions

**Debug:**
```javascript
// Test connection manually
import mqtt from 'mqtt';

const client = mqtt.connect('mqtt://localhost:1883', {
  username: 'admin',
  password: 'password'
});

client.on('connect', () => console.log('Connected'));
client.on('error', (err) => console.error('Error:', err));
```

### Rate Limiting Blocking

**Check:**
```javascript
// In tcp/rate-limiter.js
const stats = rateLimiter.getStats();
console.log('Rate limiter stats:', stats);

const blocked = rateLimiter.getBlockedIPs();
console.log('Blocked IPs:', blocked);
```

**Fix:**
```javascript
// Manually unblock
rateLimiter.unblockIP('192.168.1.100');
```

## Test Failures

### Common Test Issues

**Port already in use:**
```
Error: listen EADDRINUSE: address already in use :::8899
```

**Fix:** Tests should use dynamic ports. Check `beforeEach`:
```javascript
beforeEach(async () => {
  testPort = await getAvailablePort();
  server = createTCPServer({ port: testPort });
});
```

**Timeout errors:**
```
Error: Timeout - Async callback was not invoked within 5000ms
```

**Fix:** Increase timeout or check for hanging promises:
```javascript
it('should complete', async () => {
  // Increase timeout
}, 10000);  // 10 second timeout
```

**Mock not working:**
```javascript
// Ensure mock is set up before import
vi.mock('../src/config/index.js', () => ({
  default: { tcp: { port: 0 } }
}));

// Then import module
import { createTCPServer } from '../src/tcp/server.js';
```

### Running Single Test

```bash
# Run specific test file
npm test -- tests/unit/protocol/frame-parser.test.js

# Run specific test
npm test -- --grep "should parse valid frame"

# Run with verbose output
npm test -- --reporter verbose
```

### Debug Test

```javascript
// Add console.log in test
it('should work', () => {
  const result = someFunction();
  console.log('Result:', JSON.stringify(result, null, 2));
  expect(result).toBeDefined();
});
```

## Quick Diagnostic Commands

```bash
# Check if gateway is running
systemctl status ivy-gateway

# View recent logs
journalctl -u ivy-gateway -n 50 --no-pager

# Check ports
ss -tlnp | grep -E '8899|1883|9001|3000'

# Test TCP connection
telnet localhost 8899

# Test MQTT
mosquitto_sub -h localhost -t '#' -v

# Check health endpoint
curl http://localhost:3000/health
```

## Getting Help

If stuck, collect:
1. Full error message and stack trace
2. Relevant log output (with sensitive data removed)
3. Steps to reproduce
4. Environment (Node version, OS)

Create issue at: https://github.com/olivenet-iot/ivy-4g-gateway/issues
