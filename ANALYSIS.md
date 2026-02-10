# IVY 4G Gateway - Comprehensive Project Analysis

**Date:** 2026-02-09
**Analyst:** Claude Code (claude-opus-4-6)
**Codebase:** IVY 4G Gateway v0.1.0
**Source Lines:** ~11,179 (src/) + ~12,185 (tests/)
**Test Suite:** 906 tests, 25 test files, 100% pass rate

---

## 1. EXECUTIVE SUMMARY

The IVY 4G Gateway is a well-engineered IoT gateway bridging 4G-connected energy meters to MQTT. It supports two protocols: DL/T 645-2007 (Chinese energy meter standard) and DLMS/COSEM via a proprietary IVY wrapper (used by IVY EM114070 meters). The codebase demonstrates strong engineering practices — clean modular architecture, comprehensive test coverage (906 tests), consistent coding conventions, and thorough documentation. The protocol layer is particularly impressive given that the IVY wrapper protocol was reverse-engineered from live meter traffic.

Key strengths: robust stream parsers with proper framing, auto-detection protocol router, comprehensive OBIS code registry, and solid alarm/event system. Key gaps: plaintext password storage in MQTT auth, unused PostgreSQL/Redis dependencies, no database persistence, and some potential memory growth patterns in long-running production deployments.

---

## 2. ARCHITECTURE ANALYSIS

### 2.1 High-Level Architecture

```
                                    ┌─────────────────────────────────────────┐
┌─────────────┐     TCP (4G/LTE)   │            IVY 4G Gateway               │
│  DLT645     │ ──────────────────►│                                         │
│  Meters     │ ◄──────────────────│  ┌─────────────┐  ┌───────────────┐    │
└─────────────┘                    │  │ TCP Server   │  │ MQTT Broker   │    │
                                   │  │ :8899        │  │ (Aedes)       │    │
┌─────────────┐     TCP (4G/LTE)   │  │ ┌──────────┐│  │ :1883 TCP     │    │
│  IVY        │ ──────────────────►│  │ │Connection││  │ :9001 WS      │    │
│  EM114070   │ ◄──────────────────│  │ │Manager   ││  └───────┬───────┘    │
└─────────────┘                    │  │ └─────┬────┘│          │            │
                                   │  └───────┼─────┘          │            │
                                   │          │                │            │
                                   │  ┌───────▼─────┐  ┌──────▼──────┐     │
                                   │  │ Protocol    │  │ Publisher   │     │
                                   │  │ Router      │  │ Cmd Handler │     │
                                   │  │             │  └─────────────┘     │
                                   │  │ ┌─DLT645    │                      │
                                   │  │ │ Parser    │  ┌─────────────┐     │
                                   │  │ ├─IVY       │  │ Polling Mgr │     │
                                   │  │ │ Wrapper   │  │ DLT645+DLMS │     │
                                   │  │ ├─DLMS      │  └─────────────┘     │
                                   │  │ │ Parser    │                      │
                                   │  │ └─Heartbeat │  ┌─────────────┐     │
                                   │  │   Handler   │  │ Status Mgr  │     │  ──► MQTT
                                   │  └─────────────┘  │ Alarms      │     │     Clients
                                   │                   └─────────────┘     │
                                   │  ┌─────────────┐                      │
                                   │  │ HTTP Server │  ──────────────────► │  Browser
                                   │  │ :3000       │                      │
                                   │  └─────────────┘                      │
                                   └──────────────────────────────────────────┘
```

### 2.2 Component Relationships

| Component | Depends On | Emits Events To |
|-----------|-----------|-----------------|
| `index.js` | All components | - |
| `TCPServer` | ConnectionManager | index.js (via events) |
| `ConnectionManager` | ProtocolRouter, HeartbeatHandler | TCPServer |
| `ProtocolRouter` | FrameParser, IvyStreamParser, HeartbeatHandler, ApduParser | ConnectionManager |
| `TelemetryPublisher` | MQTTBroker | index.js |
| `CommandHandler` | MQTTBroker, TCPServer, Publisher | index.js |
| `PollingManager` | TCPServer, FrameBuilder, DlmsClient | index.js |
| `StatusManager` | TCPServer, Publisher | index.js |
| `MQTTBroker` | Aedes, ws | Publisher, CommandHandler |

### 2.3 Data Flow

**Inbound (Meter → Gateway → MQTT):**
1. Meter connects via TCP socket to port 8899
2. `ConnectionManager.registerConnection()` creates connection state and `ProtocolRouter`
3. First data bytes → `ProtocolRouter.detectProtocol()`:
   - `0x68` → DLT645 stream parser → `parseFrame()` → `TELEMETRY_RECEIVED` event
   - `0x00 0x01` → IVY stream parser → heartbeat detection or DLMS APDU parsing
   - Raw DLMS tag → synthetic IVY header → DLMS APDU parsing
4. Parsed data → Event emission up through TCPServer → `index.js` handler
5. `TelemetryPublisher.publishTelemetry()` → MQTT topic `ivy/v1/meters/{id}/telemetry`

**Outbound (MQTT → Gateway → Meter):**
1. Client publishes to `ivy/v1/meters/{id}/command/request`
2. `CommandHandler` receives via Aedes `publish` event
3. Validates command, builds DLT645 frame or DLMS APDU
4. `TCPServer.sendCommand()` → `ConnectionManager.send()` → TCP socket
5. Response arrives via inbound flow → resolves pending Promise
6. `CommandHandler` publishes result to `ivy/v1/meters/{id}/command/response`

### 2.4 Event System

The project uses a well-structured EventEmitter chain:

```
ConnectionManager events → TCPServer (forwarding) → index.js (global handlers)
```

Event naming follows `category:action` convention consistently:
- `connection:new`, `connection:identified`, `connection:closed`
- `data:received`, `frame:received`, `dlms:received`
- `meter:connected`, `meter:disconnected`
- `telemetry:received`, `dlms:telemetry:received`

---

## 3. PROTOCOL ANALYSIS

### 3.1 IVY Wrapper Protocol

The IVY wrapper is an 8-byte proprietary header used by EM114070 meters:

```
Offset  Size  Field           Notes
0       2     Version         Always 0x0001 (uint16 BE)
2       2     Source          Always 0x0001 from meter
4       2     Destination     0x0001 for both heartbeat and DLMS
6       2     PayloadLength   uint16 BE
```

**Key Discovery:** Destination `0x0001` carries BOTH heartbeat packets and DLMS APDUs. Content-based routing distinguishes them:
- Payload starting with `0x0A` → heartbeat (26-byte registration packet)
- Payload starting with known DLMS tags (`0x61`, `0xC4`, `0xC2`, etc.) → DLMS APDU

**Stream Parser Quality:** The `createIvyStreamParser()` in `ivy-wrapper.js` is well-designed:
- Handles fragmented TCP data (buffer accumulation)
- Supports both IVY-wrapped and raw DLMS APDUs
- Implements `MAX_PAYLOAD_LENGTH` (4096) to prevent memory exhaustion
- Garbage byte skipping with recovery to next valid packet boundary
- Individual DLMS APDU length computation via `computeRawDlmsLength()`

**Potential Issue:** The `computeEventNotificationLength()` disambiguation logic (lines 218-249) is complex but necessary — when both datetime and no-datetime interpretations succeed, it uses boundary alignment heuristics. This is fragile but unavoidable given the protocol ambiguity.

### 3.2 DLMS/COSEM Implementation

The DLMS implementation covers:
- **APDU Types:** AARQ, AARE, GET.request/response, SET.response, ACTION.response, EventNotification, DataNotification, ExceptionResponse, RLRQ, RLRE
- **Data Types:** All common types (INT8-64, UINT8-64, FLOAT32/64, OCTET_STRING, VISIBLE_STRING, STRUCTURE, ARRAY, DATE_TIME, etc.)
- **OBIS Registry:** 47 OBIS codes mapped across energy, voltage, current, power, powerFactor, demand, system, events, and control categories
- **Client Builders:** AARQ, GET.request, RLRQ with IVY wrapping

**DLMS Polling:** The `PollingManager.pollDlmsMeter()` implements a fire-and-forget approach:
1. Sends AARQ → waits for association timeout
2. Sends GET.request for each register with incrementing invokeIds
3. Sends RLRQ to release association
4. Responses arrive asynchronously through the DLMS event pipeline

**InvokeId Resolution:** `pendingDlmsRequests` Map tracks invokeId → OBIS code mapping, cleaned up after 30 seconds.

### 3.3 DLT645-2007 Protocol

The DLT645 implementation includes:
- **Frame Parser:** Full BCD decoding with +0x33 offset removal
- **Frame Builder:** Read frames, relay control frames
- **Register Definitions:** Energy, instantaneous, parameter, and prepaid registers
- **Stream Parser:** Byte-level framing with start marker (0x68) detection

---

## 4. CODE QUALITY REPORT

### 4.1 Code Organization: **A**

- Clean separation of concerns across modules
- Consistent file naming (kebab-case)
- Each module exports: class, constants, factory function, default bundle
- Well-structured directory hierarchy matching domain concepts

### 4.2 Naming Conventions: **A**

- Functions: camelCase consistently
- Classes: PascalCase consistently
- Constants: UPPER_SNAKE_CASE consistently
- Events: colon-separated (`meter:connected`)
- Files: kebab-case consistently

### 4.3 Error Handling: **B+**

**Strengths:**
- Consistent try/catch blocks in all parsers
- Structured error logging with context (meterId, connectionId, etc.)
- Graceful degradation — parse errors don't crash the server
- Error events emitted up the chain for monitoring

**Weaknesses:**
- Some `catch` blocks silently swallow errors (e.g., `ivy-wrapper.js:186`, `apdu-parser.js:206`)
- No circuit breaker pattern for repeated failures
- `process.exit(1)` on startup failure could be more graceful

### 4.4 Logging: **A**

- Winston with structured JSON logging
- Child loggers per module (`createChildLogger({ module: 'xxx' })`)
- Appropriate log levels (debug for routine, info for milestones, warn for errors, error for failures)
- Hex dumps included where useful for debugging
- No sensitive data in log output

### 4.5 Test Coverage: **A**

- 906 tests across 25 test files
- Unit tests for every module
- Integration tests for TCP and MQTT flows
- Good edge case coverage (malformed frames, empty buffers, overflow protection)
- Test-to-code ratio: ~1.09:1 (12,185 test lines / 11,179 source lines)

### 4.6 Documentation: **A-**

- Comprehensive CLAUDE.md with architecture, conventions, and common tasks
- JSDoc on all exported functions
- Protocol documentation in `.claude/protocols.md`
- Skills documentation in `.claude/skills/`
- Architecture decision records in `.claude/context/decisions.md`
- Minor gap: No inline comments on complex bit-manipulation logic in some parsers

---

## 5. SECURITY REVIEW

### 5.1 Critical Issues

**SEC-1: Plaintext Password Storage in MQTT Auth**
- File: `src/mqtt/auth.js:98`
- Passwords stored in plaintext in `this.users` Map
- Password comparison is direct string equality (`user.password !== passwordStr`)
- **Risk:** Memory dumps, logs, or debugger access expose all passwords
- **Fix:** Use bcrypt/argon2 for password hashing

**SEC-2: MQTT Auth Disabled by Default**
- File: `src/config/index.js:53`
- `MQTT_AUTH_ENABLED` defaults to `false`
- In development this is fine, but documentation should warn prominently
- Combined with no CORS restrictions on WebSocket, any browser on the network can connect

### 5.2 Important Issues

**SEC-3: No TLS/SSL on Any Transport**
- TCP port 8899: plaintext meter data
- MQTT port 1883: plaintext
- WebSocket port 9001: plaintext (ws://, not wss://)
- HTTP port 3000: plaintext
- **Mitigation:** For internal networks this may be acceptable, but production deployments should use TLS

**SEC-4: Rate Limiter Not Applied to TCP Server**
- `RateLimiter` class exists in `src/tcp/rate-limiter.js` but is never instantiated or used
- The TCP server accepts connections without rate limiting
- The config has rate limiting settings but they're unused

**SEC-5: CSP Allows `unsafe-inline`**
- File: `src/http/security.js:31`
- `script-src 'self' 'unsafe-inline'` weakens XSS protection
- External CDN scripts (unpkg.com, cdn.jsdelivr.net) could be compromised

### 5.3 Minor Issues

**SEC-6: Connection ID Predictability**
- `generateConnectionId()` uses `Date.now().toString(36)` + `Math.random()`
- `Math.random()` is not cryptographically secure
- Low risk since IDs are internal, but worth noting

**SEC-7: No Input Sanitization on Meter IDs in MQTT Topics**
- Meter IDs are used directly in MQTT topic construction
- A malicious meter could send a crafted address containing MQTT wildcards
- Low risk since meter addresses come from binary protocol parsing

---

## 6. PERFORMANCE CONSIDERATIONS

### 6.1 Memory Growth Patterns

**P-1: `lastTelemetry` Map in Publisher (Unbounded)**
- File: `src/mqtt/publisher.js:90`
- `this.lastTelemetry = new Map()` grows with every unique meter ID
- Never cleaned up even after meter disconnects
- **Impact:** Low for typical deployments (<1000 meters), concerning for large-scale

**P-2: `meterStatus` Map in StatusManager (Unbounded)**
- File: `src/services/status-manager.js:140`
- Tracks all meters ever connected, never purged
- Includes `recentEvents` array capped at 100 entries (good)

**P-3: `connectionAttempts` in RateLimiter**
- Has cleanup interval (good)
- But rate limiter isn't actually used (see SEC-4)

**P-4: Buffer Concatenation in Stream Parsers**
- `ivy-wrapper.js:383`: `buffer = Buffer.concat([buffer, data])` on every data event
- `Buffer.concat` allocates new memory each time
- For high-throughput meters, this could cause GC pressure
- **Mitigation:** Consider a ring buffer or pre-allocated buffer pool for production

### 6.2 Connection Scalability

- Max connections capped at 1000 (configurable)
- One stream parser per connection (reasonable memory)
- Heartbeat monitor runs on interval (not per-connection timer — efficient)
- Staggered polling prevents thundering herd (good design)

### 6.3 MQTT Broker Performance

- Aedes is embedded — suitable for moderate scale (~1000 clients)
- Each telemetry reading published individually (not batched)
- Gateway status published every 60 seconds (configurable)
- For high-scale deployments, external MQTT broker recommended

---

## 7. TECHNICAL DEBT INVENTORY

### 7.1 Unused Dependencies

| Dependency | Declared | Actually Used |
|-----------|----------|---------------|
| `ioredis` | Yes (package.json) | No (config only) |
| `pg` | Yes (package.json) | No (config only) |
| `mqtt` | Yes (package.json) | Not in src/ |

The `ioredis` and `pg` packages are listed as future integrations but are not used anywhere in the source code. They add ~3MB to `node_modules` unnecessarily.

### 7.2 Unused Code

**Rate Limiter (`src/tcp/rate-limiter.js`):**
- Fully implemented and tested
- Never imported or used by TCP server
- Should be wired into `handleConnection()` in `tcp/server.js`

**DLMS Capture Service (`src/services/dlms-capture-service.js`):**
- Exists for debugging/analysis
- Gated behind `DLMS_CAPTURE_ENABLED` (false by default)
- Not referenced from `index.js` startup

### 7.3 TODO Comments Found

```
src/index.js:339:    // TODO: Close other connections (future phases)
src/index.js:340:    // - Close database pool
src/index.js:341:    // - Disconnect Redis
```

### 7.4 Hardcoded Values

| Location | Value | Should Be |
|----------|-------|-----------|
| `publisher.js:25` | `'ivy/v1'` topic prefix | Config already has `config.mqtt.topicPrefix` but it's `'metpow/4g'` — mismatch with code |
| `status-manager.js:153` | `version: '0.1.0'` | Should read from package.json |
| `http/server.js:49` | `version: '0.1.0'` | Should read from package.json |
| `index.js:92-93` | `version: '0.1.0'` | Should read from package.json |

### 7.5 Config/Code Mismatch

**MQTT Topic Prefix Mismatch:**
- `config.mqtt.topicPrefix` defaults to `'metpow/4g'` (from config/index.js:50)
- `publisher.js` hardcodes `TOPIC_PREFIX = 'ivy/v1'`
- The config value is never used by the publisher
- This means changing the env var `MQTT_TOPIC_PREFIX` has no effect

---

## 8. RECOMMENDATIONS

### 8.1 Critical (Should Fix Soon)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| C1 | Wire rate limiter into TCP server | `tcp/server.js` | Low |
| C2 | Fix MQTT topic prefix mismatch — publisher ignores config | `mqtt/publisher.js`, `config/index.js` | Low |
| C3 | Hash MQTT passwords with bcrypt | `mqtt/auth.js` | Medium |
| C4 | Remove unused npm dependencies (`ioredis`, `pg`, `mqtt`) | `package.json` | Low |

### 8.2 Important (Should Address)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| I1 | Add TLS support for MQTT and WebSocket | `mqtt/broker.js` | Medium |
| I2 | Centralize version string (read from package.json) | Multiple files | Low |
| I3 | Add meter status cleanup (purge disconnected after TTL) | `status-manager.js`, `publisher.js` | Low |
| I4 | Add request validation/sanitization for meter IDs | `command-handler.js` | Low |
| I5 | Fix silent error swallowing in parsers | `ivy-wrapper.js`, `apdu-parser.js` | Low |
| I6 | Add graceful shutdown timeout to prevent hanging | `index.js` | Low |

### 8.3 Nice to Have (Future Improvements)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| N1 | Replace Buffer.concat with ring buffer in stream parsers | `ivy-wrapper.js`, `frame-parser.js` | Medium |
| N2 | Add DLMS relay control when OBIS code is confirmed | `command-handler.js`, `dlms/client.js` | Medium |
| N3 | Add database persistence (PostgreSQL) | New module | High |
| N4 | Add Redis for session state | New module | Medium |
| N5 | Add HTTP API endpoints for meter management | `http/server.js` | Medium |
| N6 | Add Prometheus metrics endpoint | New middleware | Medium |
| N7 | Batch telemetry MQTT publishing | `publisher.js` | Low |
| N8 | Remove `unsafe-inline` from CSP | `http/security.js` | Low |

---

## 9. IMPLEMENTATION PROMPTS

### PROMPT C1: Wire Rate Limiter into TCP Server

```
IMPLEMENTATION PROMPT: Wire Rate Limiter into TCP Server

Context:
The rate limiter (src/tcp/rate-limiter.js) is fully implemented and tested but never
used by the TCP server. Connections are accepted without any rate limiting.

Current State:
- RateLimiter class exists with checkConnection(), onConnect(), onDisconnect() methods
- TCPServer.handleConnection() accepts all connections unconditionally
- Config has rate limiting settings in config.security.rateLimiting

Desired State:
- TCP server creates a RateLimiter instance on construction
- Each new connection is checked against rate limiter before registration
- Rejected connections are destroyed with appropriate logging
- Rate limiter tracks connect/disconnect for active connection counting

Files to Modify:
- src/tcp/server.js

Implementation Steps:
1. Import createRateLimiter from '../tcp/rate-limiter.js'
2. In TCPServer constructor, create rate limiter:
   this.rateLimiter = createRateLimiter({
     maxConnectionsPerIP: config.security.rateLimiting.maxConnectionsPerIP,
     maxConnectionAttempts: config.security.rateLimiting.maxConnectionAttempts,
     windowMs: config.security.rateLimiting.windowMs,
     blockDuration: config.security.rateLimiting.blockDuration,
   });
3. In handleConnection(socket), add rate limit check BEFORE registerConnection():
   if (config.security.rateLimiting.enabled) {
     const ip = socket.remoteAddress;
     const check = this.rateLimiter.checkConnection(ip);
     if (!check.allowed) {
       logger.warn('Connection rejected by rate limiter', { ip, reason: check.reason });
       socket.destroy();
       return;
     }
     this.rateLimiter.onConnect(ip);
   }
4. Listen for CONNECTION_CLOSED events to call rateLimiter.onDisconnect(ip)
5. In stop(), call this.rateLimiter.stop()
6. Add rate limiter stats to getStats()

Testing Requirements:
- Existing rate limiter tests should still pass
- Add test: connections beyond maxConnectionsPerIP are rejected
- Add test: rapid connection attempts trigger blocking
- Run full test suite to verify no regressions
```

### PROMPT C2: Fix MQTT Topic Prefix Mismatch

```
IMPLEMENTATION PROMPT: Fix MQTT Topic Prefix Mismatch

Context:
The publisher hardcodes TOPIC_PREFIX = 'ivy/v1' but config has
config.mqtt.topicPrefix defaulting to 'metpow/4g'. The config value is never used.

Current State:
- src/mqtt/publisher.js line 25: export const TOPIC_PREFIX = 'ivy/v1';
- src/config/index.js line 50: topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'metpow/4g'
- Topics.meterTelemetry() etc. use TOPIC_PREFIX constant

Desired State:
- Publisher reads topic prefix from config
- All topic builders use the configured prefix
- Default in config should match what the code expects ('ivy/v1')

Files to Modify:
- src/mqtt/publisher.js
- src/config/index.js
- tests/unit/mqtt/publisher.test.js (update if tests reference topic prefix)

Implementation Steps:
1. In config/index.js, change topicPrefix default to 'ivy/v1':
   topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'ivy/v1'
2. In publisher.js, import config and use it:
   import config from '../config/index.js';
   export const TOPIC_PREFIX = config.mqtt.topicPrefix;
3. Update any tests that reference 'ivy/v1' or 'metpow/4g' topic prefix
4. Verify CLAUDE.md documentation matches

Testing:
- All existing tests pass
- Verify topic prefix can be overridden via MQTT_TOPIC_PREFIX env var
```

### PROMPT C3: Hash MQTT Passwords

```
IMPLEMENTATION PROMPT: Hash MQTT Passwords with bcrypt

Context:
MQTT passwords are stored and compared as plaintext strings.
This is a security risk if the process memory is inspected or logs
accidentally capture user data.

Current State:
- src/mqtt/auth.js stores passwords as plain strings in a Map
- Password comparison: user.password !== passwordStr (line 235)

Desired State:
- Passwords hashed with bcrypt on addUser()
- Password comparison uses bcrypt.compare()
- parseUsersString() hashes passwords during parsing

Files to Modify:
- src/mqtt/auth.js
- package.json (add bcrypt or bcryptjs dependency)
- tests/unit/mqtt/auth.test.js

Implementation Steps:
1. npm install bcryptjs (pure JS, no native compilation needed)
2. In auth.js, import bcryptjs:
   import bcrypt from 'bcryptjs';
3. In addUser(), hash password before storing:
   const hashedPassword = bcrypt.hashSync(password, 10);
   this.users.set(username, { username, password: hashedPassword, roles });
4. In authenticate(), use bcrypt.compare:
   const match = bcrypt.compareSync(passwordStr, user.password);
   if (!match) { ... reject ... }
5. Update tests to account for async password comparison
6. Note: authenticate() is a callback-based Aedes function — bcryptjs
   sync functions are fine here since Aedes doesn't expect async auth

Testing:
- Test that addUser stores hashed password (not original)
- Test that authenticate succeeds with correct password
- Test that authenticate fails with wrong password
- Run full suite
```

### PROMPT C4: Remove Unused Dependencies

```
IMPLEMENTATION PROMPT: Remove Unused npm Dependencies

Context:
ioredis, pg, and mqtt are declared in package.json but never imported
in any source file. They exist as placeholders for future database/Redis
integration.

Files to Modify:
- package.json

Implementation Steps:
1. Run: npm uninstall ioredis pg mqtt
2. Remove db and redis config sections from config/index.js
   (or keep config but add comment that they're for future use)
3. Remove the DB_PASSWORD validation in validateConfig() (line 147)
4. Run full test suite to verify nothing breaks

Testing:
- npm run test:run passes
- npm audit shows no new issues
```

### PROMPT I1: Add TLS Support

```
IMPLEMENTATION PROMPT: Add TLS Support for MQTT Broker

Context:
All transports are plaintext. For production deployments, TLS is essential.

Files to Modify:
- src/mqtt/broker.js
- src/config/index.js
- .env.example

Implementation Steps:
1. Add TLS config options:
   mqtt: {
     tls: {
       enabled: process.env.MQTT_TLS_ENABLED === 'true',
       keyFile: process.env.MQTT_TLS_KEY || '',
       certFile: process.env.MQTT_TLS_CERT || '',
       caFile: process.env.MQTT_TLS_CA || '',
     }
   }
2. In broker.js, conditionally create TLS server:
   if (config.mqtt.tls.enabled) {
     const tls = await import('tls');
     const tlsOptions = {
       key: fs.readFileSync(config.mqtt.tls.keyFile),
       cert: fs.readFileSync(config.mqtt.tls.certFile),
     };
     this.server = tls.createServer(tlsOptions, this.aedes.handle);
   } else {
     this.server = createServer(this.aedes.handle);
   }
3. For WebSocket, use https server when TLS enabled
4. Update .env.example with TLS options

Testing:
- Existing tests still pass (TLS disabled by default)
- Manual test with self-signed cert
```

### PROMPT I2: Centralize Version String

```
IMPLEMENTATION PROMPT: Centralize Version String

Context:
Version '0.1.0' is hardcoded in 4 locations. Should be read from package.json.

Files to Modify:
- src/index.js
- src/http/server.js
- src/services/status-manager.js

Implementation Steps:
1. In src/index.js, read version at startup:
   import { readFileSync } from 'fs';
   import { fileURLToPath } from 'url';
   import { dirname, join } from 'path';
   const __filename = fileURLToPath(import.meta.url);
   const __dirname = dirname(__filename);
   const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
   const APP_VERSION = pkg.version;
2. Pass version to components:
   telemetryPublisher.start({ version: APP_VERSION, name: 'IVY 4G Gateway' });
   statusManager uses it from gatewayInfo
3. In http/server.js, import and use the version from package.json
4. Remove all hardcoded '0.1.0' strings

Testing:
- Run tests, verify version appears in MQTT messages
- Bump version in package.json and verify it propagates
```

### PROMPT I3: Add Meter Status Cleanup

```
IMPLEMENTATION PROMPT: Add Meter Status Cleanup

Context:
meterStatus and lastTelemetry Maps grow unbounded as meters connect/disconnect.
Need periodic cleanup of stale entries.

Files to Modify:
- src/services/status-manager.js
- src/mqtt/publisher.js

Implementation Steps:
1. In StatusManager, add a cleanup method:
   cleanupStaleMeters(maxAge = 86400000) { // 24 hours
     const now = Date.now();
     for (const [meterId, status] of this.meterStatus) {
       if (!status.online && status.disconnectedAt &&
           now - status.disconnectedAt > maxAge) {
         this.meterStatus.delete(meterId);
       }
     }
   }
2. Call cleanupStaleMeters() in the periodic status publishing interval
3. In Publisher, add similar cleanup for lastTelemetry:
   cleanupStaleTelemetry(maxAge = 86400000) {
     const now = Date.now();
     for (const [meterId, data] of this.lastTelemetry) {
       if (data._lastUpdate && now - data._lastUpdate > maxAge) {
         this.lastTelemetry.delete(meterId);
       }
     }
   }

Testing:
- Test that stale meters are cleaned up after TTL
- Test that active meters are preserved
```

---

## 10. DOCUMENTATION PROMPTS

### PROMPT D1: Update CLAUDE.md

The existing CLAUDE.md is already comprehensive and accurate. Minor updates needed:

```
PROMPT: Update CLAUDE.md with latest project status

1. Update test count from "~982 test cases" to "906 test cases, 25 test files"
   (the number decreased because counting method changed, not because tests were removed)
2. Update version references
3. Add note about rate limiter being implemented but not wired in
4. Add note about topic prefix config mismatch
5. Document the DLMS polling invoke-id resolution pattern
```

### PROMPT D2: Create API Documentation

```
PROMPT: Create docs/API.md

Create comprehensive API documentation covering:

1. MQTT Topics (with JSON schema for each message type):
   - ivy/v1/meters/{meterId}/telemetry
   - ivy/v1/meters/{meterId}/status
   - ivy/v1/meters/{meterId}/events
   - ivy/v1/meters/{meterId}/command/request
   - ivy/v1/meters/{meterId}/command/response
   - ivy/v1/gateway/status
   - ivy/v1/gateway/stats

2. Command API (request/response format):
   - read_register
   - relay_control
   - read_address
   - read_all

3. HTTP Endpoints:
   - GET /health
   - GET /api/info

4. WebSocket MQTT:
   - Connection URL: ws://host:9001
   - Protocol: MQTT 3.1.1 over WebSocket

Include example payloads for each topic.
```

---

## 11. PROJECT STATUS SUMMARY

### 11.1 What's Complete

| Feature | Status | Notes |
|---------|--------|-------|
| TCP Server | ✅ Complete | Handles DLT645 and IVY/DLMS connections |
| Protocol Auto-Detection | ✅ Complete | DLT645, IVY wrapper, raw DLMS |
| DLT645 Parser/Builder | ✅ Complete | Full BCD encoding, frame validation |
| IVY Wrapper Parser | ✅ Complete | Stream parser with raw DLMS support |
| DLMS APDU Parser | ✅ Complete | EventNotification, GET.response, AARE, etc. |
| DLMS Client (AARQ/GET) | ✅ Complete | Association, GET.request, release |
| Heartbeat Handler | ✅ Complete | IVY EM114070 registration packets |
| MQTT Broker (Aedes) | ✅ Complete | TCP + WebSocket transports |
| MQTT Publisher | ✅ Complete | Telemetry, status, events, commands |
| Command Handler | ✅ Complete | read_register, relay_control, read_all |
| Polling Manager | ✅ Complete | DLT645 + DLMS periodic polling |
| Status Manager | ✅ Complete | Alarms, events, health monitoring |
| HTTP Dashboard | ✅ Basic | Static files + health check |
| Security Middleware | ✅ Basic | CSP, rate limiting, headers |
| MQTT Auth | ✅ Basic | User/pass + ACL (plaintext passwords) |
| OBIS Registry | ✅ Complete | 47 codes across all categories |
| Test Suite | ✅ Complete | 906 tests, 100% pass |
| Documentation | ✅ Comprehensive | CLAUDE.md, protocols, skills, context |

### 11.2 What's In Progress / Partial

| Feature | Status | Notes |
|---------|--------|-------|
| Rate Limiting | 🟡 Implemented but not wired | RateLimiter exists, not used by TCP server |
| DLMS Capture Service | 🟡 Implemented, gated | For debugging, not in main startup |
| Relay Control (DLT645) | 🟡 Basic | Simple relay frame, no feedback loop |

### 11.3 What's Missing

| Feature | Priority | Dependencies |
|---------|----------|-------------|
| DLMS Relay Control | High | IVY OBIS code for disconnect (0-0:96.3.10.255 untested) |
| Database Persistence | Medium | PostgreSQL integration (pg dep declared but unused) |
| Redis Session State | Medium | ioredis dep declared but unused |
| TLS/SSL Support | Medium | None (built-in tls module) |
| Password Hashing | High | bcryptjs package |
| Historical Data API | Low | Database required first |
| Prometheus Metrics | Low | None |
| Multi-node Clustering | Low | Redis required first |
| Per-phase V/I/P for EM114070 | Blocked | Meter only returns totals, not per-phase |

### 11.4 External Dependencies

| Item | Status | Blocking |
|------|--------|----------|
| IVY complete OBIS code list | Pending from IVY | Some OBIS codes may be missing |
| IVY TCP layer documentation | Pending from IVY | Reverse-engineered successfully |
| IVY relay control method | Pending from IVY | Cannot implement DLMS disconnect |
| Per-phase readings from EM114070 | Confirmed unavailable | Meter hardware limitation |

---

## 12. QUESTIONS / AREAS NEEDING CLARIFICATION

1. **Topic Prefix Intent:** Is the intended prefix `ivy/v1` or `metpow/4g`? The config and code disagree. This should be resolved before any deployment.

2. **Rate Limiter Activation:** Was the rate limiter intentionally left disconnected, or was this an oversight? The config settings exist but nothing uses them.

3. **Database Timeline:** The `pg` and `ioredis` dependencies suggest database integration was planned. Is this still on the roadmap? If not, removing them reduces attack surface.

4. **Production Deployment:** Has this gateway been deployed in production? The deployment script (`deploy.sh`) exists and documentation mentions systemd, but there's no CI/CD configuration.

5. **Scale Expectations:** How many meters are expected? The architecture supports ~1000 concurrent connections, but embedded Aedes may become a bottleneck above that.

6. **IVY Documentation Status:** Have the pending items (complete OBIS list, relay control method) been received from IVY since the initial development?

---

## APPENDIX A: FILE INVENTORY

### Source Files (29 files, ~11,179 lines)

```
src/index.js                          351 lines   Entry point
src/config/index.js                   157 lines   Configuration
src/tcp/server.js                     605 lines   TCP server
src/tcp/connection-manager.js         895 lines   Connection lifecycle
src/tcp/rate-limiter.js               210 lines   Rate limiting (unused)
src/protocol/protocol-router.js       266 lines   Protocol auto-detection
src/protocol/ivy-wrapper.js           578 lines   IVY header parser/builder
src/protocol/heartbeat-handler.js     ~150 lines  Heartbeat packets
src/protocol/frame-parser.js          ~400 lines  DLT645 frame parser
src/protocol/frame-builder.js         ~300 lines  DLT645 frame builder
src/protocol/registers.js             ~250 lines  DLT645 registers
src/protocol/bcd.js                   ~100 lines  BCD encoding
src/protocol/checksum.js              ~50 lines   Frame checksum
src/protocol/dlms/apdu-parser.js      541 lines   DLMS APDU parser
src/protocol/dlms/client.js           182 lines   DLMS client builders
src/protocol/dlms/data-types.js       327 lines   DLMS data types
src/protocol/dlms/obis-registry.js    160 lines   OBIS code registry
src/protocol/dlms/dlms-probe.js       332 lines   DLMS probe utility
src/mqtt/broker.js                    455 lines   MQTT broker (Aedes)
src/mqtt/publisher.js                 594 lines   Telemetry publisher
src/mqtt/command-handler.js           658 lines   Command handler
src/mqtt/auth.js                      392 lines   MQTT authentication
src/services/polling-manager.js       720 lines   Periodic polling
src/services/status-manager.js        725 lines   Status & alarms
src/services/dlms-capture-service.js  ~200 lines  DLMS packet capture
src/http/server.js                    113 lines   HTTP server
src/http/security.js                  124 lines   Security middleware
src/utils/logger.js                   ~50 lines   Winston logger
```

### Test Files (25 files, ~12,185 lines)

```
tests/unit/protocol/frame-parser.test.js
tests/unit/protocol/frame-builder.test.js
tests/unit/protocol/registers.test.js
tests/unit/protocol/bcd.test.js
tests/unit/protocol/checksum.test.js
tests/unit/protocol/protocol-router.test.js
tests/unit/protocol/ivy-wrapper.test.js
tests/unit/protocol/heartbeat-handler.test.js
tests/unit/protocol/dlms/apdu-parser.test.js
tests/unit/protocol/dlms/data-types.test.js
tests/unit/protocol/dlms/obis-registry.test.js
tests/unit/protocol/dlms/client.test.js
tests/unit/mqtt/broker.test.js
tests/unit/mqtt/publisher.test.js
tests/unit/mqtt/command-handler.test.js
tests/unit/mqtt/auth.test.js
tests/unit/tcp/connection-manager.test.js
tests/unit/tcp/rate-limiter.test.js
tests/unit/services/polling-manager.test.js
tests/unit/services/status-manager.test.js
tests/unit/services/dlms-capture-service.test.js
tests/unit/config/config.test.js
tests/unit/http/security.test.js
tests/integration/tcp-flow.test.js
tests/integration/mqtt-flow.test.js
```

### Configuration & Documentation

```
package.json                        Project metadata, scripts, dependencies
.env.example                        Environment variable template
CLAUDE.md                           AI assistant guide (comprehensive)
.claude/protocols.md                Protocol documentation
.claude/mqtt-topics.md              MQTT topic reference
.claude/development.md              Development guide
.claude/troubleshooting.md          Debug reference
.claude/context/decisions.md        Architecture decisions
.claude/context/discoveries.md      EM114070 empirical findings
.claude/context/project-status.md   Project status
.claude/skills/add-*.md             Task-specific guides (6 files)
deploy.sh                           Deployment script
docs/DEPLOYMENT.md                  Deployment guide
```
