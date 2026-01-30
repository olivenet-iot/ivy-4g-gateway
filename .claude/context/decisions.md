# Architecture Decision Records

Key design decisions made during development.

## ADR-001: Content-Based Routing at Destination 0x0001

**Context**: The IVY EM114070 sends both heartbeat packets and DLMS responses to the same IVY destination address (0x0001).

**Decision**: Use content-based routing by inspecting the payload:
- Heartbeat packets match a rigid 11-byte header signature
- DLMS APDUs start with known tag bytes (0x61, 0xC4, 0xC2, etc.)
- No collision since heartbeat payload byte [0] is 0x0a, not a DLMS APDU tag

**Consequences**: Robust disambiguation without needing separate destination addresses.

## ADR-002: Destination 0x0001 Instead of 0x0010

**Context**: We initially targeted destination 0x0010 for DLMS communication.

**Decision**: Use destination 0x0001 because the EM114070 does not respond to packets sent with destination 0x0010.

**Consequences**: Simplified routing (single destination). `IVY_DESTINATIONS.DLMS_LEGACY` (0x0010) retained for backward compatibility.

## ADR-003: Synthetic IVY Headers for Raw DLMS APDUs

**Context**: After initial exchange, the EM114070 sometimes sends raw DLMS APDUs without the IVY header.

**Decision**: Create a synthetic IVY header with `isRawDlms: true` flag for uniform downstream processing.

**Consequences**: Unified packet processing pipeline. The flag is available for logging but doesn't affect routing.

## ADR-004: Passive-First DLMS (Default DLMS_PASSIVE_ONLY=true)

**Context**: Should the gateway actively query DLMS meters or passively wait for pushed data?

**Decision**: Default to passive mode. Active polling available but requires explicit opt-in.

**Consequences**: Safe default. Active polling sends AARQ -> GET.request x N -> RLRQ cycle when enabled.

## ADR-005: OBIS Scaler in Registry vs Querying Meter

**Context**: DLMS meters store scaler/unit as attribute 3 of Register class objects.

**Decision**: Store scalers in `obis-registry.js` rather than querying attribute 3 from the meter.

**Consequences**: Faster (no extra round-trip), works in passive mode, but requires manual updates for non-standard scalers.

## ADR-006: First-Byte Protocol Detection (Stateful per Connection)

**Context**: The gateway handles both DLT645 and IVY/DLMS meters on the same TCP port.

**Decision**: Detect protocol from first byte(s):
- `0x68` = DLT645
- `0x00 0x01` (4-byte) = IVY/DLMS
- Known DLMS tag = IVY/DLMS (raw)

Lock detected protocol for connection lifetime.

**Consequences**: Simple, reliable detection. No per-meter configuration needed.
