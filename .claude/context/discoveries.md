# EM114070 Empirical Discoveries

Findings from testing with the IVY EM114070 energy meter.

## Meter Identity

| Property | Value |
|----------|-------|
| Manufacturer | Zhejiang Yongtailong Electronic Co., LTD |
| Logical Device Name | YTL102000000000000 |
| OBIS for manufacturer | 0-0:96.1.1.255 |
| OBIS for device name | 0-0:42.0.0.255 |
| OBIS for serial number | 0-0:96.1.0.255 |

## Heartbeat Packet

- Length: 26 bytes
- Fixed header (11 bytes): `00 01 00 01 00 01 00 12 0a 02 0c`
- Meter address: 12 ASCII digits at offset 11
- Sent immediately upon TCP connection
- Address may be all zeros (`000000000000`) for unconfigured meters

## DLMS Association

| Context | Result |
|---------|--------|
| LN_NO_CIPHER (01 01) | Accepted |
| SN_NO_CIPHER (01 02) | Rejected |
| LN_WITH_CIPHER (01 03) | Rejected |
| SN_WITH_CIPHER (01 04) | Rejected |

Only Logical Name referencing without ciphering works. Public client address: 0x10.

## OBIS Scan Results

Full brute-force scan: 12,109 OBIS codes probed, 14 returned valid data.

### Working Codes

| OBIS Code | Class ID | Data Type | Raw Value | Real Value | Description |
|-----------|----------|-----------|-----------|------------|-------------|
| 1-0:1.7.0.255 | 3 | INT32 | 0 | 0 W | Active power import |
| 1-0:3.7.0.255 | 3 | INT32 | 0 | 0 var | Reactive power import |
| 1-0:9.7.0.255 | 3 | UINT32 | 0 | 0 VA | Apparent power import |
| 1-0:11.7.0.255 | 3 | UINT32 | 0 | 0.000 A | Current total |
| 1-0:12.7.0.255 | 3 | UINT32 | 23636 | 236.36 V | Voltage total |
| 1-0:13.7.0.255 | 3 | INT32 | 0 | 0.000 | Power factor total |
| 1-0:14.7.0.255 | 3 | UINT32 | 5004 | 50.04 Hz | Frequency |
| 1-0:15.8.0.255 | 3 | UINT32 | 0 | 0.000 kWh | Total energy absolute |
| 1-0:91.7.0.255 | 3 | UINT32 | 0 | 0.000 A | Neutral current |
| 0-0:1.0.0.255 | 8 | OCTET_STRING | 12 bytes | COSEM datetime | Clock |
| 0-0:42.0.0.255 | 1 | OCTET_STRING | 18 bytes | "YTL102000000000000" | Logical device name |
| 0-0:96.1.0.255 | 1 | OCTET_STRING | 12 bytes | "000000000000" | Meter serial number |
| 0-0:96.1.1.255 | 1 | OCTET_STRING | variable | "Zhejiang Yongtailong..." | Manufacturer ID |
| 0-0:96.14.0.255 | 1 | UINT8 | 1 | 1 | Current tariff |

### Non-Working Observations

- Per-phase voltage (32.7, 52.7, 72.7) returns `object-undefined` - single-phase meter
- Per-phase current (31.7, 51.7, 71.7) returns `object-undefined` - single-phase meter
- Energy tariffs (1.8.1-4) return `object-undefined` on this firmware version
- Relay control state (96.3.10) returns `object-undefined`

## Protocol Behavior

- Only destination `0x0001` works for DLMS communication
- After heartbeat, meter may send raw DLMS APDUs without IVY header
- EventNotification (0xC2) may or may not include a COSEM datetime prefix
- ExceptionResponse (0xD8) is always exactly 3 bytes
- Energy values are integers requiring scaler multiplication (not floats)
- GET.response uses invoke ID matching for request/response correlation

## Scan Data

Full scan results: `debug/obis-scan-results-2026-01-29T20-34-02.json`
