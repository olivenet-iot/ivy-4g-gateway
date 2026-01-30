# Protocol Reference

This document describes all protocols supported by the IVY 4G Gateway.

## Table of Contents

- [Protocol Detection](#protocol-detection)
- [DL/T 645-2007](#dlt-645-2007)
- [IVY Wrapper Protocol](#ivy-wrapper-protocol)
- [IVY EM114070 Heartbeat](#ivy-em114070-heartbeat)
- [DLMS/COSEM](#dlmscosem)
- [OBIS Code Reference](#obis-code-reference)
- [Supported Meters](#supported-meters)

## Protocol Detection

The gateway auto-detects the protocol from the first bytes received on a TCP connection:

| First Bytes | Protocol | Parser |
|-------------|----------|--------|
| `0x68` | DL/T 645-2007 | `frame-parser.js` |
| `0x00 0x01 0x00 0x01` | IVY/DLMS | `ivy-wrapper.js` |
| Known DLMS tag (0x60, 0x61, 0xC0, 0xC2, 0xC4, 0xD8...) | IVY/DLMS (raw) | `ivy-wrapper.js` |

Once detected, the protocol is locked for the connection's lifetime. All detection logic is in `src/protocol/protocol-router.js`.

## DL/T 645-2007

Chinese standard for electricity meter communication.

### Frame Structure

```
[0x68] [Address: 6 bytes] [0x68] [Control: 1] [Length: 1] [Data: N] [Checksum: 1] [0x16]
```

| Field | Size | Description |
|-------|------|-------------|
| Start | 1 byte (0x68) | Frame start delimiter |
| Address | 6 bytes | Meter address (reversed BCD, little-endian) |
| Start2 | 1 byte (0x68) | Second delimiter |
| Control | 1 byte | Command type (see below) |
| Length | 1 byte | Data payload length |
| Data | Variable | Payload with +0x33 offset on each byte |
| Checksum | 1 byte | Sum of all bytes mod 256 |
| End | 1 byte (0x16) | Frame end delimiter |

### Control Codes

| Code | Direction | Description |
|------|-----------|-------------|
| 0x11 | Request | Read data |
| 0x14 | Request | Write data |
| 0x1C | Request | Relay control |
| 0x91 | Response | Read success |
| 0xD1 | Response | Read error |

### Data Identifiers

4-byte data IDs (DI3-DI2-DI1-DI0):

| DI3 | Category | Examples |
|-----|----------|----------|
| 0x00 | Energy | Total active energy, tariff readings |
| 0x02 | Instantaneous | Voltage, current, power, frequency |
| 0x04 | Parameters | Relay status, meter address |

## IVY Wrapper Protocol

Proprietary 8-byte header used by IVY EM114070 meters to wrap DLMS payloads.

### Header Structure

```
Offset  Size   Field           Encoding
0-1     2      Version         uint16 BE (always 0x0001)
2-3     2      Source          uint16 BE (always 0x0001)
4-5     2      Destination     uint16 BE (0x0001 for heartbeat and DLMS)
6-7     2      Payload Length  uint16 BE
```

### Routing

Destination `0x0001` is shared between heartbeats and DLMS. Content-based routing:
- Heartbeat: matches 11-byte header signature
- DLMS APDU: starts with known tag byte (0x61, 0xC4, 0xC2, etc.)

## IVY EM114070 Heartbeat

26-byte registration packet sent upon TCP connection.

```
[Header: 11 bytes] [Address: 12 ASCII digits] [Separator: 1] [CRC: 2]
```

Fixed header: `00 01 00 01 00 01 00 12 0a 02 0c`

The 12 ASCII digits at offset 11 are the meter address.

## DLMS/COSEM

IEC 62056 standard for energy meter communication, carried over the IVY wrapper.

### APDU Tags

| Tag | Name | Description |
|-----|------|-------------|
| 0x60 | AARQ | Association Request (gateway → meter) |
| 0x61 | AARE | Association Response (meter → gateway) |
| 0x62 | RLRQ | Release Request |
| 0x63 | RLRE | Release Response |
| 0xC0 | GET.request | Read register value |
| 0xC4 | GET.response | Register value result |
| 0xC2 | EventNotification | Unsolicited data push |
| 0x0F | DataNotification | Unsolicited data push |
| 0xD8 | ExceptionResponse | Error response (3 bytes) |

### Association

The gateway uses LN_NO_CIPHER context (`60 85 74 05 08 01 01`). Other contexts are rejected by the EM114070.

### Data Flow

```
1. Meter connects → sends heartbeat (26 bytes)
2. Gateway identifies meter from heartbeat address
3. (Active mode) Gateway sends AARQ → receives AARE
4. (Active mode) Gateway sends GET.request per OBIS code → receives GET.response
5. (Active mode) Gateway sends RLRQ → receives RLRE
6. (Passive mode) Gateway waits for EventNotification/DataNotification
```

## OBIS Code Reference

OBIS codes identify registers. Format: `A-B:C.D.E.F`

### Confirmed EM114070 Codes

| OBIS Code | Type | Unit | Description |
|-----------|------|------|-------------|
| 1-0:1.7.0.255 | INT32 | W | Active power import |
| 1-0:3.7.0.255 | INT32 | var | Reactive power import |
| 1-0:9.7.0.255 | UINT32 | VA | Apparent power import |
| 1-0:11.7.0.255 | UINT32 | A | Current total (scaler 0.001) |
| 1-0:12.7.0.255 | UINT32 | V | Voltage total (scaler 0.01) |
| 1-0:13.7.0.255 | INT32 | - | Power factor total (scaler 0.001) |
| 1-0:14.7.0.255 | UINT32 | Hz | Frequency (scaler 0.01) |
| 1-0:15.8.0.255 | UINT32 | kWh | Total energy absolute (scaler 0.001) |
| 1-0:91.7.0.255 | UINT32 | A | Neutral current (scaler 0.001) |
| 0-0:1.0.0.255 | OCTET_STRING | - | Clock (COSEM datetime) |
| 0-0:42.0.0.255 | OCTET_STRING | - | Logical device name |
| 0-0:96.1.0.255 | OCTET_STRING | - | Meter serial number |
| 0-0:96.1.1.255 | OCTET_STRING | - | Manufacturer ID |
| 0-0:96.14.0.255 | UINT8 | - | Current tariff |

The full OBIS registry is in `src/protocol/dlms/obis-registry.js`.

## Supported Meters

| Meter | Protocol | Connection | Polling |
|-------|----------|------------|---------|
| Generic DL/T 645-2007 | DLT645 | First byte 0x68 | Active (read frames) |
| IVY EM114070 | DLMS via IVY | Heartbeat + IVY header | Passive or active (AARQ/GET) |

---

For implementation details, see the source code in `src/protocol/`.
