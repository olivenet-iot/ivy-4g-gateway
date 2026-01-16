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
