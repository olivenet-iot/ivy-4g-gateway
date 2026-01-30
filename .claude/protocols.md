# DL/T 645-2007 Protocol Reference

This document describes the DL/T 645-2007 protocol implementation used by IVY 4G Gateway.

## Frame Structure

Every DL/T 645-2007 frame follows this structure:

```
Position:  [0]   [1-6]     [7]   [8]    [9]    [10...N-2]   [N-1]  [N]
Content:  0x68  ADDRESS   0x68  CTRL   LEN      DATA         CS    0x16
           │      │         │     │      │        │           │      │
           │      │         │     │      │        │           │      └─ End delimiter
           │      │         │     │      │        │           └─ Checksum (mod 256)
           │      │         │     │      │        └─ Payload (with +0x33 offset)
           │      │         │     │      └─ Data length (number of payload bytes)
           │      │         │     └─ Control code (request/response type)
           │      │         └─ Second start delimiter
           │      └─ 6-byte address (BCD, little-endian)
           └─ First start delimiter
```

**Minimum frame length:** 12 bytes (no data payload)

## Address Format

- 12-digit decimal string: `"000000001234"`
- Stored as 6 bytes in **little-endian BCD**
- Example: `"000000001234"` → `[0x34, 0x12, 0x00, 0x00, 0x00, 0x00]`

**Broadcast addresses:**
- Standard: `"999999999999"` → `[0x99, 0x99, 0x99, 0x99, 0x99, 0x99]`
- Alternative: `"AAAAAAAAAAAA"` → `[0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]`

## Control Codes

### Request Codes (sent to meter)

| Code | Name | Description |
|------|------|-------------|
| `0x11` | READ_DATA | Read register data |
| `0x12` | READ_FOLLOW | Read next data block |
| `0x13` | READ_ADDRESS | Read meter address |
| `0x14` | WRITE_DATA | Write register data |
| `0x15` | WRITE_ADDRESS | Set meter address |
| `0x08` | BROADCAST_TIME | Broadcast time sync |
| `0x1C` | RELAY_CONTROL | Control prepaid relay |

### Response Codes (from meter)

| Code | Name | Description |
|------|------|-------------|
| `0x91` | READ_DATA_RESPONSE | Data read successful |
| `0x92` | READ_FOLLOW_RESPONSE | Next block data |
| `0x93` | READ_ADDRESS_RESPONSE | Address returned |
| `0x94` | WRITE_DATA_RESPONSE | Write confirmed |
| `0x95` | WRITE_ADDRESS_RESPONSE | Address changed |
| `0x9C` | RELAY_CONTROL_RESPONSE | Relay control confirmed |

### Error Codes

| Code | Name | Description |
|------|------|-------------|
| `0xD1` | READ_DATA_ERROR | Read failed |
| `0xD4` | WRITE_DATA_ERROR | Write failed |
| `0xDC` | RELAY_CONTROL_ERROR | Relay control failed |

**Control code logic:**
```javascript
// Response = Request + 0x80
0x11 (read request) → 0x91 (read response)

// Error = Request + 0xC0
0x11 (read request) → 0xD1 (read error)

// Check if error response
isError = (controlCode & 0xC0) === 0xC0
```

## Data Identifiers (DI)

Data identifiers are 4-byte codes that specify which register to read/write.

**Structure:** `DI3-DI2-DI1-DI0` (most significant to least significant)

| DI3 | Category |
|-----|----------|
| `0x00` | Energy (kWh readings) |
| `0x01` | Maximum demand |
| `0x02` | Instantaneous values |
| `0x03` | Event records |
| `0x04` | Parameters |
| `0x05` | Frozen data |
| `0x09` | Prepaid (vendor-specific) |

### Common Registers

**Energy (DI3=0x00):**
| Data ID | Name | Unit | Resolution |
|---------|------|------|------------|
| `0x00000000` | Total Active Energy (Import) | kWh | 0.01 |
| `0x00010000` | Total Active Energy (Export) | kWh | 0.01 |
| `0x00020000` | Total Reactive Energy (Import) | kvarh | 0.01 |

**Instantaneous (DI3=0x02):**
| Data ID | Name | Unit | Resolution |
|---------|------|------|------------|
| `0x02010100` | Phase A Voltage | V | 0.1 |
| `0x02010200` | Phase B Voltage | V | 0.1 |
| `0x02010300` | Phase C Voltage | V | 0.1 |
| `0x02020100` | Phase A Current | A | 0.001 |
| `0x02020200` | Phase B Current | A | 0.001 |
| `0x02020300` | Phase C Current | A | 0.001 |
| `0x02030000` | Total Active Power | W | 1 |
| `0x02040000` | Total Reactive Power | var | 1 |
| `0x02060000` | Total Power Factor | - | 0.001 |
| `0x02800002` | Grid Frequency | Hz | 0.01 |

**Parameters (DI3=0x04):**
| Data ID | Name | Description |
|---------|------|-------------|
| `0x04000501` | Relay Status | 0x00=Closed, 0x01=Open |
| `0x04000401` | Meter Address | 6-byte BCD |

**Prepaid (DI3=0x09):**
| Data ID | Name | Unit |
|---------|------|------|
| `0x00900100` | Balance Energy | kWh |
| `0x00900200` | Balance Money | currency |

## BCD Encoding

DL/T 645 uses Binary Coded Decimal (BCD) for numeric values.

**BCD byte:** Each nibble (4 bits) represents one decimal digit.
```
0x12 = decimal 12
0x99 = decimal 99
0x00 = decimal 00
```

**Multi-byte values:** Stored in **little-endian** order.
```
Value: 123456
Bytes: [0x56, 0x34, 0x12, 0x00]  (LSB first)
```

**Decimal values:** Implied decimal point based on register resolution.
```
Energy: 1234.56 kWh
Raw value: 123456
Resolution: 0.01
Bytes: [0x56, 0x34, 0x12, 0x00]
```

**Signed values:** MSB indicates sign (0=positive, 1=negative).
```javascript
// Power can be negative (export)
Positive 1234W: [0x34, 0x12, 0x00]  // MSB high nibble = 0
Negative 1234W: [0x34, 0x12, 0x80]  // MSB high nibble = 8
```

## Data Offset (+0x33)

**Critical:** All data bytes in DL/T 645 frames have `0x33` added.

```javascript
// Encoding (before sending)
originalData = [0x00, 0x00, 0x00, 0x00]
sentData = [0x33, 0x33, 0x33, 0x33]  // Add 0x33 to each byte

// Decoding (after receiving)
receivedData = [0x33, 0x34, 0x45, 0x33]
originalData = [0x00, 0x01, 0x12, 0x00]  // Subtract 0x33 from each byte
```

## Checksum Calculation

Checksum = sum of all bytes from first `0x68` to last data byte, modulo 256.

```javascript
function calculateChecksum(frame) {
  let sum = 0;
  // Sum from byte 0 to byte before checksum
  for (let i = 0; i < frame.length - 2; i++) {
    sum += frame[i];
  }
  return sum & 0xFF;  // Modulo 256
}
```

## Example Frames

### Read Total Active Energy

**Request:**
```
68 34 12 00 00 00 00 68 11 04 33 33 33 33 B2 16
│  │                 │  │  │  │           │  │
│  └─ Address        │  │  │  └─ Data ID  │  └─ End
│     001234         │  │  │     0x00000000│
│                    │  │  │     (+0x33)   └─ Checksum
│                    │  │  └─ Length: 4 bytes
│                    │  └─ Control: 0x11 (READ_DATA)
│                    └─ Second start
└─ First start
```

**Response (success):**
```
68 34 12 00 00 00 00 68 91 08 33 33 33 33 89 67 45 33 XX 16
│  │                 │  │  │  │           │           │
│  └─ Address        │  │  │  └─ Data ID  └─ Value    │
│                    │  │  │                          │
│                    │  │  └─ Length: 8 bytes         └─ End
│                    │  └─ Control: 0x91 (response)
│                    └─ Second start
└─ First start

Value (after -0x33): 0x56 0x34 0x12 0x00 = 123456 → 1234.56 kWh
```

### Relay Control (Trip)

**Request:**
```
68 34 12 00 00 00 00 68 1C 10 [16-byte AES encrypted block] CS 16
                        │  │   │
                        │  │   └─ Encrypted: timestamp + operator + password + command
                        │  └─ Length: 16 bytes
                        └─ Control: 0x1C (RELAY_CONTROL)
```

**Encrypted block plaintext:**
```
Bytes 0-5:  Timestamp (YY MM DD HH mm ss) in BCD
Bytes 6-9:  Operator code
Bytes 10-13: Password
Byte 14:    Command (0x1A=trip, 0x1B=close)
Byte 15:    Padding (0x00)
```

## Error Response Format

When a read/write fails, meter returns error response:

```
68 34 12 00 00 00 00 68 D1 01 XX CS 16
                        │  │  │
                        │  │  └─ Error code
                        │  └─ Length: 1 byte
                        └─ Control: 0xD1 (READ_DATA_ERROR)
```

**Error codes:**
| Code | Meaning |
|------|---------|
| `0x01` | Other error |
| `0x02` | No data requested |
| `0x04` | Password error / Unauthorized |
| `0x08` | Communication rate cannot be changed |
| `0x10` | Annual power exceeds limit |
| `0x20` | Day power exceeds limit |
| `0x40` | Command execution failed |

Codes can be combined (OR'd together) for multiple errors.

## Key Functions Reference

**File: `src/protocol/frame-builder.js`**
```javascript
buildReadFrame(address, dataId)           // Build read request
buildWriteFrame(address, dataId, value)   // Build write request
buildRelayControlFrame(address, command)  // Build relay control
buildReadAddressFrame()                   // Build address discovery
describeFrame(frame)                      // Debug frame structure
```

**File: `src/protocol/frame-parser.js`**
```javascript
parseFrame(frame)                         // Parse any frame
parseReadResponse(frame, register)        // Parse read response
parseErrorResponse(frame)                 // Parse error response
isCompleteFrame(buffer)                   // Check frame completeness
createStreamParser(onFrame, onError)      // TCP stream parser
```

**File: `src/protocol/bcd.js`**
```javascript
decimalToBcd(value, byteLength)           // Number to BCD bytes
bcdToDecimal(buffer)                      // BCD bytes to number
applyOffset(buffer)                       // Add +0x33
removeOffset(buffer)                      // Remove +0x33
addressToBuffer(address)                  // Address string to bytes
bufferToAddress(buffer)                   // Bytes to address string
```

**File: `src/protocol/checksum.js`**
```javascript
calculateChecksum(buffer)                 // Calculate CS byte
verifyChecksum(frame)                     // Validate frame CS
validateFrameStructure(frame)             // Check delimiters
```

---

# IVY Wrapper Protocol

The IVY wrapper is a proprietary 8-byte header used by IVY EM114070 meters to transport DLMS payloads over TCP.

## IVY Header Structure

```
Offset  Size   Field           Encoding         Value
0-1     2      Version         uint16 BE        Always 0x0001
2-3     2      Source          uint16 BE        0x0001 (meter → gateway)
4-5     2      Destination     uint16 BE        0x0001 (heartbeat + DLMS)
6-7     2      Payload Length  uint16 BE        Byte count of payload
```

**Hex example (8-byte header + 3-byte payload):**
```
00 01 00 01 00 01 00 03 D8 01 02
│           │           │        │
└─ Header ──┘           └─ Payload (ExceptionResponse)
```

## IVY Destinations

| Value | Constant | Usage |
|-------|----------|-------|
| `0x0001` | `HEARTBEAT` / `DLMS_PUBLIC_CLIENT` | All EM114070 traffic |
| `0x0010` | `DLMS_LEGACY` | Reserved (EM114070 does not respond) |

Both heartbeat and DLMS traffic share destination `0x0001`. Disambiguation is content-based:
- Heartbeat: matches 11-byte fixed header signature starting with `0x0a`
- DLMS APDU: starts with known tag byte (0x60, 0x61, 0xC0, 0xC2, 0xC4, 0xD8, etc.)
- No collision: heartbeat payload byte [0] = `0x0a`, not a DLMS APDU tag

## IVY Stream Parser

The stream parser (`createIvyStreamParser()`) handles:
1. **IVY-wrapped packets**: Detects 4-byte signature `00 01 00 01`, reads header, extracts payload
2. **Raw DLMS APDUs**: After initial exchange, meter may send DLMS without IVY header. Parser detects known DLMS tags and computes APDU length
3. **Garbage bytes**: Skips unrecognized data to next valid packet start

Raw DLMS APDUs get a synthetic IVY header with `isRawDlms: true` for uniform downstream processing.

## Key Functions

**File: `src/protocol/ivy-wrapper.js`**
```javascript
isIvyPacket(buffer)                           // Check for IVY signature (00 01 00 01)
parseIvyHeader(buffer)                        // Parse 8-byte header → { version, source, destination, payloadLength }
buildIvyHeader(destination, payloadLength)     // Build 8-byte header
wrapIvyPacket(destination, payload)            // Header + payload concat
createIvyStreamParser(onPacket, onError)       // Stateful TCP stream parser
computeRawDlmsLength(buffer)                   // Compute raw DLMS APDU byte length
```

---

# IVY EM114070 Heartbeat

26-byte registration packet sent by the meter immediately upon TCP connection.

## Heartbeat Structure

```
Offset  Size   Content
0-10    11     Fixed header: 00 01 00 01 00 01 00 12 0a 02 0c
11-22   12     Meter address (12 ASCII digits, e.g., "000000000000")
23      1      Separator (0x0d)
24-25   2      CRC bytes
```

**Total length:** 26 bytes (constant `HEARTBEAT_CONSTANTS.PACKET_LENGTH`)

**Hex example (unconfigured meter):**
```
00 01 00 01 00 01 00 12 0a 02 0c 30 30 30 30 30 30 30 30 30 30 30 30 0d XX XX
│                               │ │                                   │ │     │
└─── 11-byte fixed header ──────┘ └── "000000000000" (ASCII) ────────┘ │  CRC │
                                                                       Sep    │
```

## Detection

A packet is identified as heartbeat if:
1. Buffer length ≥ 26 bytes
2. First 11 bytes match the fixed header signature exactly
3. Bytes 11-22 are all ASCII digits (`0x30`-`0x39`)

**File: `src/protocol/heartbeat-handler.js`**
```javascript
isHeartbeatPacket(payload)                    // Check if buffer is heartbeat
parseHeartbeatPacket(payload)                 // Extract meter address → { meterAddress, raw }
```

---

# DLMS/COSEM Protocol

IEC 62056 standard for energy meter communication. Carried over IVY wrapper or sent as raw APDUs.

## APDU Tags

| Tag | Hex | Name | Direction | Description |
|-----|-----|------|-----------|-------------|
| AARQ | `0x60` | Association Request | Gateway → Meter | Open DLMS session |
| AARE | `0x61` | Association Response | Meter → Gateway | Session accepted/rejected |
| RLRQ | `0x62` | Release Request | Gateway → Meter | Close session |
| RLRE | `0x63` | Release Response | Meter → Gateway | Session closed |
| GET.request | `0xC0` | Get Request Normal | Gateway → Meter | Read register value |
| GET.response | `0xC4` | Get Response Normal | Meter → Gateway | Register value result |
| EventNotification | `0xC2` | Event Notification | Meter → Gateway | Unsolicited data push |
| DataNotification | `0x0F` | Data Notification | Meter → Gateway | Unsolicited structured data |
| ExceptionResponse | `0xD8` | Exception Response | Meter → Gateway | Error (always 3 bytes) |

## DLMS Association Flow

```
Gateway                         Meter
   │                              │
   │──── AARQ (0x60) ────────────►│  Open session (LN_NO_CIPHER context)
   │◄──── AARE (0x61) ────────────│  Response: accepted=true
   │                              │
   │──── GET.request (0xC0) ─────►│  Read OBIS code (e.g., 1-0:12.7.0.255)
   │◄──── GET.response (0xC4) ────│  Value: 23636 (UINT32)
   │                              │
   │  ... repeat for each OBIS ...│
   │                              │
   │──── RLRQ (0x62) ────────────►│  Close session
   │◄──── RLRE (0x63) ────────────│  Session closed
```

### Application Context

Only LN_NO_CIPHER is supported by the EM114070:

| Context | OID | Status |
|---------|-----|--------|
| LN_NO_CIPHER | `60 85 74 05 08 01 01` | **Accepted** |
| SN_NO_CIPHER | `60 85 74 05 08 01 02` | Rejected |
| LN_WITH_CIPHER | `60 85 74 05 08 01 03` | Rejected |
| SN_WITH_CIPHER | `60 85 74 05 08 01 04` | Rejected |

Public client address: `0x10`

## GET.response Structure

```
[0xC4] [response-type] [invoke-id] [choice] [data...]
        0x01=normal     matches      0x00=success → DLMS value
                        request      0x01=error → data-access-result byte
```

**Data access result errors:**

| Code | Name |
|------|------|
| 0 | success |
| 1 | hardware-fault |
| 2 | temporary-failure |
| 3 | read-write-denied |
| 4 | object-undefined |
| 5 | object-class-inconsistent |
| 6 | object-unavailable |

## EventNotification Structure (0xC2)

Variable-length, no fixed framing:

```
[0xC2] [optional: COSEM datetime, 12 bytes] [classId: 2] [OBIS: 6-7] [attrIndex: 1] [data: variable]
```

Key challenges:
- Datetime prefix is optional and detected by `looksLikeCosemDateTime()` heuristic
- No explicit length field — parser walks the structure to compute boundaries
- Trailing DLMS values may follow (event log data)

## ExceptionResponse Structure (0xD8)

Always exactly 3 bytes:

```
[0xD8] [state-error: 1 byte] [service-error: 1 byte]
```

## Key Functions

**File: `src/protocol/dlms/apdu-parser.js`**
```javascript
parseApdu(buffer)                             // Dispatch to tag-specific parser
parseEventNotification(buffer)                // Parse 0xC2
parseDataNotification(buffer)                 // Parse 0x0F
parseGetResponse(buffer)                      // Parse 0xC4
parseAare(buffer)                             // Parse 0x61
parseExceptionResponse(buffer)                // Parse 0xD8
extractTelemetry(parsedApdu)                  // Convert to gateway telemetry format
```

**File: `src/protocol/dlms/client.js`**
```javascript
buildAarq(options)                            // Build AARQ APDU (0x60)
buildGetRequest(classId, obisCode, attr, id)  // Build GET.request (0xC0)
buildReleaseRequest(reason)                   // Build RLRQ (0x62)
wrapDlmsForSending(apdu, destination)         // Wrap APDU in IVY header
obisToBytes(obisCode)                         // "A-B:C.D.E.F" → 6-byte Buffer
```

---

# OBIS Code System

OBIS (Object Identification System) codes identify registers in DLMS/COSEM meters.

## Format

```
A-B:C.D.E.F

A = Media (0=abstract, 1=electricity)
B = Channel (0=default)
C = Physical quantity (1=active power, 12=voltage, etc.)
D = Processing (7=instantaneous, 8=time integral)
E = Tariff (0=total)
F = Billing (255=current value)
```

## Confirmed EM114070 OBIS Codes

14 codes confirmed working from brute-force scan of 12,109 OBIS codes:

### Instantaneous Values (Class ID 3 = Register)

| OBIS Code | Data Type | Scaler | Unit | Description |
|-----------|-----------|--------|------|-------------|
| `1-0:1.7.0.255` | INT32 | 1 | W | Active power import |
| `1-0:3.7.0.255` | INT32 | 1 | var | Reactive power import |
| `1-0:9.7.0.255` | UINT32 | 1 | VA | Apparent power import |
| `1-0:11.7.0.255` | UINT32 | 0.001 | A | Current total |
| `1-0:12.7.0.255` | UINT32 | 0.01 | V | Voltage total |
| `1-0:13.7.0.255` | INT32 | 0.001 | - | Power factor total |
| `1-0:14.7.0.255` | UINT32 | 0.01 | Hz | Frequency |
| `1-0:91.7.0.255` | UINT32 | 0.001 | A | Neutral current |

### Energy Values (Class ID 3 = Register)

| OBIS Code | Data Type | Scaler | Unit | Description |
|-----------|-----------|--------|------|-------------|
| `1-0:15.8.0.255` | UINT32 | 0.001 | kWh | Total energy absolute |

### Information Objects (Class ID 1 = Data, Class ID 8 = Clock)

| OBIS Code | Class | Data Type | Description |
|-----------|-------|-----------|-------------|
| `0-0:1.0.0.255` | 8 | OCTET_STRING (12 bytes) | Clock (COSEM datetime) |
| `0-0:42.0.0.255` | 1 | OCTET_STRING | Logical device name |
| `0-0:96.1.0.255` | 1 | OCTET_STRING | Meter serial number |
| `0-0:96.1.1.255` | 1 | OCTET_STRING | Manufacturer ID |
| `0-0:96.14.0.255` | 1 | UINT8 | Current tariff |

### Non-Working OBIS Codes on EM114070

| OBIS Code | Expected | Result | Reason |
|-----------|----------|--------|--------|
| `1-0:32.7.0.255` | Phase A voltage | `object-undefined` | Single-phase meter |
| `1-0:52.7.0.255` | Phase B voltage | `object-undefined` | Single-phase meter |
| `1-0:72.7.0.255` | Phase C voltage | `object-undefined` | Single-phase meter |
| `1-0:31.7.0.255` | Phase A current | `object-undefined` | Single-phase meter |
| `1-0:1.8.1.255` | Tariff 1 energy | `object-undefined` | Firmware limitation |
| `0-0:96.3.10.255` | Relay state | `object-undefined` | Not supported |

## Scaler System

Raw values from the meter are integers. Scalers convert to real units:

```
Real Value = Raw Value × Scaler

Example: Voltage
  Raw: 23636, Scaler: 0.01
  Real: 23636 × 0.01 = 236.36 V
```

Scalers are stored in the OBIS registry (`obis-registry.js`) rather than queried from the meter (ADR-005). This avoids extra round-trips and works in passive mode.

**File: `src/protocol/dlms/obis-registry.js`**
```javascript
lookupObis(obisCode)                          // Find registry entry by OBIS code
getObisByCategory(category)                   // Get all entries in a category
mapDlmsToGatewayRegister(obisCode)            // Map OBIS to gateway register format

// Registry entry structure:
{
  name: 'Voltage Total',
  unit: 'V',
  category: 'voltage',
  key: 'VOLTAGE_TOTAL',
  scaler: 0.01,            // Optional - multiply raw value
}
```

---

# Protocol Router

Auto-detects the protocol from the first bytes received on a TCP connection.

## Detection Logic

```
First bytes received:
  0x68                     → DL/T 645-2007 (Chinese meter standard)
  0x00 0x01 0x00 0x01      → IVY/DLMS (IVY wrapper header)
  Known DLMS tag           → IVY/DLMS (raw APDU, no IVY header)
  Other                    → Unknown protocol
```

Once detected, the protocol is **locked for the connection's lifetime**. No re-detection occurs.

## Content-Based Routing (within IVY/DLMS)

After protocol detection, IVY packets at destination `0x0001` are further classified:

1. **Heartbeat** — Payload matches 11-byte fixed header signature
2. **DLMS APDU** — Payload starts with APDU tag (0x60, 0x61, 0xC2, 0xC4, 0xD8, etc.)
3. **Unknown** — Neither pattern matches; logged and skipped

**File: `src/protocol/protocol-router.js`**
```javascript
detectProtocol(buffer)                        // Detect from first bytes → PROTOCOL_TYPES
createProtocolRouter(connection)              // Create stateful router for a connection

// Protocol types:
PROTOCOL_TYPES = {
  DLT645: 'dlt645',
  IVY_DLMS: 'ivy_dlms',
  UNKNOWN: 'unknown',
}
```

---

# DLMS Active Polling

When `DLMS_PASSIVE_ONLY=false`, the gateway actively queries DLMS meters.

## Poll Cycle

```
1. Send AARQ (wrapped in IVY header)
2. Wait for AARE (association accepted)
3. For each OBIS code in poll group:
   a. Send GET.request with unique invoke ID
   b. Wait for GET.response with matching invoke ID
   c. Apply scaler from OBIS registry
4. Send RLRQ (release request)
5. Wait for RLRE (release response)
```

## DLMS Poll Register Groups

| Group | OBIS Codes |
|-------|------------|
| `energy` | `1-0:15.8.0.255` |
| `instantaneous` | `1-0:1.7.0.255`, `1-0:3.7.0.255`, `1-0:9.7.0.255`, `1-0:11.7.0.255`, `1-0:12.7.0.255`, `1-0:13.7.0.255`, `1-0:14.7.0.255`, `1-0:91.7.0.255` |
| `all` | All of the above |

## Key Functions

**File: `src/services/polling-manager.js`**
```javascript
pollDlmsMeter(meterId, socket, group)         // Execute full AARQ→GET→RLRQ cycle
resolveDlmsInvokeId(meterId, invokeId, data)  // Match GET.response to pending request
```

---

# DLMS Capture Service

Debug service for recording all DLMS traffic from a meter.

**File: `src/services/dlms-capture-service.js`**
```javascript
// Events:
CAPTURE_EVENTS = {
  CAPTURE_STARTED: 'capture:started',
  CAPTURE_STOPPED: 'capture:stopped',
  PACKET_CAPTURED: 'capture:packet',
}
```

Enable via environment:
```
DLMS_CAPTURE_ENABLED=true
DLMS_CAPTURE_DURATION=3600000  # 1 hour
```

---

# Debug Tools

Located in `debug/` directory:

| Tool | Purpose |
|------|---------|
| `dlms-probe.js` | Connect to meter, send AARQ, read specific OBIS codes |
| `dlms-obis-probe.js` | Test individual OBIS codes interactively |
| `dlms-obis-bruteforce.js` | Scan all possible OBIS codes (12,109 probes) |

Scan results: `debug/obis-scan-results-2026-01-29T20-34-02.json`
