# Protocol Debugging Guide

Techniques and tools for debugging protocol issues.

## Hex Dump Analysis

### DLT645 Frames
```javascript
import { describeFrame } from './src/protocol/frame-builder.js';
import { bufferToHex } from './src/protocol/bcd.js';

console.log(bufferToHex(frame));  // '68 34 12 00 ...'
console.log(describeFrame(frame)); // { address, control, data, ... }
```

### IVY Header Parsing
```javascript
import { parseIvyHeader, isIvyPacket } from './src/protocol/ivy-wrapper.js';

if (isIvyPacket(buffer)) {
  const header = parseIvyHeader(buffer);
  // { version: 1, source: 1, destination: 1, payloadLength: 18 }
}
```

### DLMS APDU Inspection
```javascript
import { parseApdu, extractTelemetry } from './src/protocol/dlms/apdu-parser.js';

const parsed = parseApdu(payload);
// { type: 'get-response', tag: 0xC4, invokeId: 1, accessResult: 'success', data: {...} }

const telemetry = extractTelemetry(parsed);
// { source: 'dlms', type: 'get-response', data: { type: 6, typeName: 'UINT32', value: 23636 } }
```

## Probe Tools

### DLMS OBIS Probe
```bash
node debug/dlms-obis-probe.js <meter-ip> <meter-port>
```

### DLMS Brute-Force Scanner
```bash
node debug/dlms-obis-bruteforce.js <meter-ip> <meter-port>
```

### DLT645 Probe
```bash
node debug/ivy-dlt645-probe.js <meter-ip> <meter-port>
```

## Log Analysis

```bash
# DLMS-related logs
sudo journalctl -u ivy-gateway | grep -i "dlms\|apdu\|obis"

# IVY heartbeat logs
sudo journalctl -u ivy-gateway | grep -i "heartbeat"

# Protocol detection
sudo journalctl -u ivy-gateway | grep "Protocol detected"

# Enable debug logging in .env
LOG_LEVEL=debug
```

## DLMS Capture Service

Enable to log all raw DLMS packets:
```bash
# In .env
DLMS_CAPTURE_ENABLED=true
DLMS_CAPTURE_DURATION=3600000  # 1 hour
```

## Common Issues

| Symptom | Check |
|---------|-------|
| No heartbeat detected | Verify 26-byte packet with header `00 01 00 01 00 01 00 12 0a 02 0c` |
| DLMS association rejected | Meter may not support LN_NO_CIPHER; check AARE response |
| OBIS code returns error | Verify class ID (1=Data, 3=Register); try attribute index 2 |
| Raw DLMS not parsed | Check if tag is in `RAW_DLMS_TAGS` set in ivy-wrapper.js |
| IVY header parse error | Verify 4-byte signature: `00 01 00 01` |
