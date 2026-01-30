# Project Status

Current state of the IVY 4G Gateway project.

## Overview

- **Version**: Pre-1.0 (active development)
- **Protocols**: Dual-protocol (DL/T 645-2007 + IVY/DLMS)
- **Tests**: ~982 test cases across unit and integration tests
- **Source files**: 29 JavaScript modules
- **Architecture**: Single-node, in-memory, event-driven

## Supported Meters

| Meter | Protocol | Status | Notes |
|-------|----------|--------|-------|
| Generic DL/T 645-2007 | DLT645 | Fully supported | All standard registers, relay control |
| IVY EM114070 | DLMS/COSEM via IVY | Operational | 14 confirmed OBIS codes, passive + active polling |

## Working Features

### DLT645 Path
- TCP connection management
- Frame parsing and building
- Register reading (energy, voltage, current, power, power factor, frequency)
- Relay control (trip/close with AES encryption)
- Automatic polling with configurable intervals
- MQTT telemetry publishing
- Command handling via MQTT

### IVY/DLMS Path
- IVY 8-byte header parsing and building
- Heartbeat packet detection and meter identification
- Protocol auto-detection (first-byte routing)
- DLMS APDU parsing (AARE, GET.response, EventNotification, DataNotification, ExceptionResponse)
- OBIS code registry with scaler conversion
- DLMS active polling (AARQ -> GET.request -> RLRQ cycle)
- Raw DLMS APDU handling (without IVY wrapper)
- DLMS capture service for traffic analysis

### Shared Infrastructure
- MQTT broker (Aedes, embedded)
- Rate limiting (IP-based)
- HTTP dashboard
- Structured logging (Winston)
- Security middleware

## Known Limitations

- **No database persistence** - All state is in-memory, lost on restart
- **No Redis** - Session state not shared across instances
- **Single-node only** - No clustering or load balancing
- **DLMS relay control** - Not yet implemented (OBIS 0-0:96.3.10.255 registered but no command handler)
- **Per-phase V/I on EM114070** - Meter only returns total values, per-phase OBIS codes return errors
- **No DLMS ciphered contexts** - Only LN_NO_CIPHER is supported

## Pending Work

- Database integration (PostgreSQL/TimescaleDB)
- Redis for session state
- DLMS relay/disconnect control command
- Multi-gateway coordination
- Historical data API
- Additional meter models
