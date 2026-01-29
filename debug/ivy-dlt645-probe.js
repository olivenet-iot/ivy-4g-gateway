#!/usr/bin/env node
/**
 * IVY DLT645 Destination Code Probe
 *
 * Standalone TCP server that systematically probes different IVY header
 * destination codes to discover which one the meter responds to for
 * DLT645 commands over TCP.
 *
 * Background:
 *   DLT645 works over RS-485 but not directly over TCP on IVY EM114070 meters.
 *   TCP requires wrapping DLT645 frames in an 8-byte IVY proprietary header,
 *   but the correct destination code for DLT645 forwarding is unknown.
 *   Known destinations: 0x0001 (heartbeat), 0x0010 (DLMS public client).
 *
 * Usage:
 *   sudo systemctl stop ivy-gateway
 *   node debug/ivy-dlt645-probe.js
 *   # Wait for meter to connect, probes run automatically
 *   # Ctrl+C to exit early
 *
 * No imports from src/ — fully standalone using only Node.js built-ins.
 */

import net from 'net';

// ─── Configuration ──────────────────────────────────────────────────────────

const TCP_PORT = 8899;
const PROBE_TIMEOUT_MS = 5000;   // Wait 5s for response per probe
const PROBE_GAP_MS = 5000;       // 5s gap between probes

// ─── Heartbeat Constants ────────────────────────────────────────────────────

const HEARTBEAT_PACKET_LENGTH = 26;
const HEARTBEAT_HEADER = Buffer.from([
  0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c,
]);
const HEARTBEAT_ADDRESS_OFFSET = 11;
const HEARTBEAT_ADDRESS_LENGTH = 12;

// ─── IVY Header Constants ───────────────────────────────────────────────────

const IVY_VERSION = 0x0001;
const IVY_HEADER_LENGTH = 8;

// ─── DLT645 Constants ───────────────────────────────────────────────────────

const DLT645_START = 0x68;
const DLT645_END = 0x16;
const CONTROL_READ_DATA = 0x11;
const CONTROL_RELAY = 0x1C;
const RELAY_TRIP = 0x1A;
const RELAY_CLOSE = 0x1B;

// ─── Probe Destinations ─────────────────────────────────────────────────────

const PROBE_LIST = [
  { destination: 0x0001, description: 'Heartbeat dest' },
  { destination: 0x0002, description: 'Next sequential' },
  { destination: 0x0010, description: 'DLMS public client' },
  { destination: 0x0011, description: 'DLMS + 1' },
  { destination: 0x0020, description: 'Another guess' },
  { destination: 0x0021, description: 'Another guess' },
  { destination: 0x00FF, description: 'Max low byte' },
  { destination: null,   description: 'Raw DLT645 (no IVY header)' },
];

// ─── State ──────────────────────────────────────────────────────────────────

let meterAddress = null;    // 12-digit ASCII string from heartbeat
let activeSocket = null;    // Current meter socket
let probeResults = [];      // Collected results
let incomingBuffer = Buffer.alloc(0);  // Accumulate incoming data per probe

// ─── Utility: Hex Dump ─────────────────────────────────────────────────────

function hexDump(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ─── Heartbeat Detection ────────────────────────────────────────────────────

function isHeartbeat(data) {
  if (data.length < HEARTBEAT_PACKET_LENGTH) return false;
  return data.subarray(0, HEARTBEAT_HEADER.length).equals(HEARTBEAT_HEADER);
}

function parseHeartbeat(data) {
  const addrBuf = data.subarray(HEARTBEAT_ADDRESS_OFFSET, HEARTBEAT_ADDRESS_OFFSET + HEARTBEAT_ADDRESS_LENGTH);
  return addrBuf.toString('ascii');
}

// ─── DLT645 Frame Building (inline) ────────────────────────────────────────

/**
 * Convert 12-digit ASCII meter address to 6-byte reversed BCD.
 * E.g., "000000001234" => bytes [0x34, 0x12, 0x00, 0x00, 0x00, 0x00]
 */
function addressToBcd(address) {
  const buf = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    const hi = parseInt(address[i * 2], 10);
    const lo = parseInt(address[i * 2 + 1], 10);
    buf[5 - i] = (hi << 4) | lo;
  }
  return buf;
}

/**
 * Compute DLT645 checksum: sum of all bytes from 0x68 to last data byte, mod 256.
 */
function dlt645Checksum(frame, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum = (sum + frame[i]) & 0xFF;
  }
  return sum;
}

/**
 * Build a DLT645 "Read Total Active Energy" frame.
 * DI = 0x00000000, control = 0x11 (read data)
 * Data bytes have +0x33 offset: 0x33, 0x33, 0x33, 0x33
 *
 * Frame: [0x68][addr LE BCD 6B][0x68][0x11][0x04][0x33 0x33 0x33 0x33][CS][0x16]
 */
function buildReadTotalEnergyFrame(address) {
  const addrBcd = addressToBcd(address);

  // Total frame: 1 + 6 + 1 + 1 + 1 + 4 + 1 + 1 = 16 bytes
  const frame = Buffer.alloc(16);
  let pos = 0;

  frame[pos++] = DLT645_START;           // 0x68
  addrBcd.copy(frame, pos); pos += 6;    // Address (6 bytes LE BCD)
  frame[pos++] = DLT645_START;           // 0x68
  frame[pos++] = CONTROL_READ_DATA;      // 0x11
  frame[pos++] = 0x04;                   // Data length = 4
  frame[pos++] = 0x33;                   // DI0 + 0x33
  frame[pos++] = 0x33;                   // DI1 + 0x33
  frame[pos++] = 0x33;                   // DI2 + 0x33
  frame[pos++] = 0x33;                   // DI3 + 0x33

  // Checksum: sum of bytes 0..pos-1
  frame[pos++] = dlt645Checksum(frame, 0, pos - 1);
  frame[pos++] = DLT645_END;             // 0x16

  return frame.subarray(0, pos);
}

/**
 * Build a DLT645 simple relay control frame (no encryption).
 * control = 0x1C, data = [command + 0x33]
 *
 * Frame: [0x68][addr LE BCD 6B][0x68][0x1C][0x01][cmd+0x33][CS][0x16]
 */
function buildSimpleRelayFrame(address, command) {
  const addrBcd = addressToBcd(address);
  const cmdByte = command === 'trip' ? RELAY_TRIP : RELAY_CLOSE;

  // Total: 1 + 6 + 1 + 1 + 1 + 1 + 1 + 1 = 13 bytes
  const frame = Buffer.alloc(13);
  let pos = 0;

  frame[pos++] = DLT645_START;
  addrBcd.copy(frame, pos); pos += 6;
  frame[pos++] = DLT645_START;
  frame[pos++] = CONTROL_RELAY;          // 0x1C
  frame[pos++] = 0x01;                   // Data length = 1
  frame[pos++] = (cmdByte + 0x33) & 0xFF;

  frame[pos++] = dlt645Checksum(frame, 0, pos - 1);
  frame[pos++] = DLT645_END;

  return frame.subarray(0, pos);
}

// ─── IVY Header Building ────────────────────────────────────────────────────

/**
 * Build an 8-byte IVY header.
 *   Bytes 0-1: Version   = 0x0001 (uint16 BE)
 *   Bytes 2-3: Source    = 0x0001 (uint16 BE)
 *   Bytes 4-5: Destination (uint16 BE)
 *   Bytes 6-7: Payload Length (uint16 BE)
 */
function buildIvyHeader(destination, payloadLength) {
  const header = Buffer.alloc(IVY_HEADER_LENGTH);
  header.writeUInt16BE(IVY_VERSION, 0);
  header.writeUInt16BE(0x0001, 2);         // Source
  header.writeUInt16BE(destination, 4);
  header.writeUInt16BE(payloadLength, 6);
  return header;
}

/**
 * Wrap a payload with an IVY header.
 */
function wrapWithIvy(destination, payload) {
  const header = buildIvyHeader(destination, payload.length);
  return Buffer.concat([header, payload]);
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Try to identify what a data chunk is.
 */
function identifyData(data) {
  // Heartbeat
  if (isHeartbeat(data)) {
    return { type: 'heartbeat', address: parseHeartbeat(data) };
  }

  // IVY-wrapped packet (starts with 00 01 00 01)
  if (data.length >= 8 && data[0] === 0x00 && data[1] === 0x01 &&
      data[2] === 0x00 && data[3] === 0x01) {
    const dest = data.readUInt16BE(4);
    const payloadLen = data.readUInt16BE(6);
    const payload = data.length >= 8 + payloadLen
      ? data.subarray(8, 8 + payloadLen)
      : data.subarray(8);

    const result = {
      type: 'ivy-wrapped',
      destination: `0x${dest.toString(16).padStart(4, '0')}`,
      payloadLength: payloadLen,
      payloadHex: hexDump(payload),
    };

    // Check if payload is DLT645
    if (payload.length > 0 && payload[0] === DLT645_START) {
      result.innerType = 'dlt645';
      result.dlt645 = parseDlt645Response(payload);
    }

    return result;
  }

  // Raw DLT645 (starts with 0x68)
  if (data.length >= 12 && data[0] === DLT645_START) {
    return { type: 'dlt645', ...parseDlt645Response(data) };
  }

  // DLMS EventNotification (0xC2) or other known tags
  const dlmsTags = { 0xC2: 'EventNotification', 0x0F: 'DataNotification',
    0xC4: 'GET.response', 0x61: 'AARE', 0xD8: 'ExceptionResponse' };
  if (data.length > 0 && dlmsTags[data[0]]) {
    return { type: 'dlms', apduType: dlmsTags[data[0]] };
  }

  return { type: 'unknown' };
}

/**
 * Parse a raw DLT645 response frame (best-effort).
 */
function parseDlt645Response(data) {
  const result = { valid: false };

  if (data.length < 12 || data[0] !== DLT645_START) {
    return result;
  }

  // Check second 0x68
  if (data[7] !== DLT645_START) {
    return result;
  }

  const controlCode = data[8];
  const dataLength = data[9];
  const expectedLen = 10 + dataLength + 2; // header + data + CS + 0x16

  result.controlCode = `0x${controlCode.toString(16).padStart(2, '0')}`;
  result.dataLength = dataLength;

  // Identify control code
  if (controlCode === 0x91) {
    result.controlType = 'READ_DATA_RESPONSE (success)';
  } else if (controlCode === 0xD1) {
    result.controlType = 'READ_DATA_RESPONSE (error)';
  } else if (controlCode === 0x9C) {
    result.controlType = 'RELAY_CONTROL_RESPONSE (success)';
  } else if (controlCode === 0xDC) {
    result.controlType = 'RELAY_CONTROL_RESPONSE (error)';
  } else if (controlCode === 0x11) {
    result.controlType = 'READ_DATA_REQUEST';
  } else if (controlCode === 0x1C) {
    result.controlType = 'RELAY_CONTROL_REQUEST';
  } else {
    result.controlType = 'OTHER';
  }

  if (data.length >= expectedLen) {
    result.valid = true;
    result.frameHex = hexDump(data.subarray(0, expectedLen));

    // For successful read response, extract value
    if (controlCode === 0x91 && dataLength >= 4) {
      const rawDataBytes = data.subarray(10, 10 + dataLength);
      // Remove +0x33 offset
      const decoded = Buffer.alloc(rawDataBytes.length);
      for (let i = 0; i < rawDataBytes.length; i++) {
        decoded[i] = (rawDataBytes[i] - 0x33) & 0xFF;
      }
      result.decodedData = hexDump(decoded);

      // DI bytes (first 4)
      const di = decoded.subarray(0, 4);
      result.dataId = `0x${[...di].reverse().map(b => b.toString(16).padStart(2, '0')).join('')}`;

      // Value bytes (remaining, BCD LE)
      if (dataLength > 4) {
        const valBytes = decoded.subarray(4);
        // Parse as BCD
        let bcdStr = '';
        for (let i = valBytes.length - 1; i >= 0; i--) {
          bcdStr += valBytes[i].toString(16).padStart(2, '0');
        }
        result.rawBcdValue = bcdStr;

        // For total energy (DI=0x00000000), resolution is 0.01 kWh
        const numericVal = parseInt(bcdStr, 10);
        if (!isNaN(numericVal)) {
          result.numericValue = numericVal / 100;
          result.unit = 'kWh';
        }
      }
    }

    // For error response, extract error code
    if (controlCode === 0xD1 && dataLength > 0) {
      const rawDataBytes = data.subarray(10, 10 + dataLength);
      const decoded = Buffer.alloc(rawDataBytes.length);
      for (let i = 0; i < rawDataBytes.length; i++) {
        decoded[i] = (rawDataBytes[i] - 0x33) & 0xFF;
      }
      const errByte = decoded[dataLength > 4 ? 4 : 0];
      const errorCodes = {
        0x01: 'Other error',
        0x02: 'No requested data',
        0x04: 'Password error / unauthorized',
        0x08: 'Baud rate not supported',
        0x10: 'Year-month-time not valid',
        0x20: 'No matching baud rate',
        0x40: 'Tariff number overflows',
      };
      result.errorCode = `0x${errByte.toString(16).padStart(2, '0')}`;
      result.errorMessage = errorCodes[errByte] || 'Unknown error';
    }
  }

  return result;
}

// ─── Probe Runner ───────────────────────────────────────────────────────────

/**
 * Send a single probe and wait for response.
 * Returns a result object with timing and response info.
 */
function sendProbe(socket, probeIndex, destination, dlt645Frame) {
  return new Promise((resolve) => {
    const isRaw = destination === null;
    const label = isRaw
      ? `Probe #${probeIndex + 1}: Raw DLT645 (no IVY header)`
      : `Probe #${probeIndex + 1}: IVY dest=0x${destination.toString(16).padStart(4, '0')}`;

    const packet = isRaw
      ? dlt645Frame
      : wrapWithIvy(destination, dlt645Frame);

    log(`\n${'='.repeat(70)}`);
    log(`SENDING ${label}`);
    log(`  Packet (${packet.length} bytes): ${hexDump(packet)}`);
    if (!isRaw) {
      log(`  IVY header: ${hexDump(packet.subarray(0, 8))}`);
      log(`  DLT645 payload: ${hexDump(packet.subarray(8))}`);
    }

    const result = {
      probeIndex: probeIndex + 1,
      destination: isRaw ? 'RAW' : `0x${destination.toString(16).padStart(4, '0')}`,
      description: PROBE_LIST[probeIndex].description,
      sentHex: hexDump(packet),
      sentAt: Date.now(),
      responses: [],
      gotResponse: false,
    };

    // Reset incoming buffer
    incomingBuffer = Buffer.alloc(0);

    // Collect all data received during the timeout window
    const dataHandler = (data) => {
      const receiveTs = Date.now();
      const elapsed = receiveTs - result.sentAt;
      incomingBuffer = Buffer.concat([incomingBuffer, data]);

      log(`  << RECEIVED ${data.length} bytes (${elapsed}ms after send)`);
      log(`     Hex: ${hexDump(data)}`);

      const identified = identifyData(data);
      log(`     Identified as: ${identified.type}`);

      if (identified.type === 'heartbeat') {
        log(`     (Heartbeat from ${identified.address} - ignoring for probe result)`);
        return; // Don't count heartbeats as probe responses
      }

      result.gotResponse = true;
      result.responses.push({
        elapsed,
        length: data.length,
        hex: hexDump(data),
        parsed: identified,
      });

      if (identified.type === 'dlt645' || identified.type === 'ivy-wrapped') {
        log(`     *** POSSIBLE DLT645 RESPONSE! ***`);
        if (identified.dlt645) {
          log(`     Control: ${identified.dlt645.controlCode} (${identified.dlt645.controlType})`);
          if (identified.dlt645.numericValue !== undefined) {
            log(`     Value: ${identified.dlt645.numericValue} ${identified.dlt645.unit}`);
          }
          if (identified.dlt645.errorMessage) {
            log(`     Error: ${identified.dlt645.errorMessage}`);
          }
        }
        if (identified.controlType) {
          log(`     Control: ${identified.controlCode} (${identified.controlType})`);
        }
      }
    };

    socket.on('data', dataHandler);

    // Write probe
    try {
      socket.write(packet);
    } catch (err) {
      log(`  ERROR writing to socket: ${err.message}`);
      socket.removeListener('data', dataHandler);
      result.error = err.message;
      resolve(result);
      return;
    }

    // Wait for timeout
    setTimeout(() => {
      socket.removeListener('data', dataHandler);

      if (!result.gotResponse) {
        log(`  No response within ${PROBE_TIMEOUT_MS}ms`);
      } else {
        log(`  Received ${result.responses.length} response(s)`);
      }

      // Also check accumulated buffer for multi-packet responses
      if (incomingBuffer.length > 0 && !result.gotResponse) {
        log(`  Accumulated buffer (${incomingBuffer.length} bytes): ${hexDump(incomingBuffer)}`);
      }

      resolve(result);
    }, PROBE_TIMEOUT_MS);
  });
}

/**
 * Run the full probe sequence.
 */
async function runProbes(socket, address) {
  log('\n' + '='.repeat(70));
  log('STARTING PROBE SEQUENCE');
  log(`Meter address: ${address}`);
  log(`Probes to run: ${PROBE_LIST.length} read probes`);
  log('='.repeat(70));

  // Build the DLT645 read frame
  const readFrame = buildReadTotalEnergyFrame(address);
  log(`\nDLT645 Read Total Energy frame: ${hexDump(readFrame)}`);

  // Phase 1: Read probes
  let workingDestination = null;

  for (let i = 0; i < PROBE_LIST.length; i++) {
    const probe = PROBE_LIST[i];
    const result = await sendProbe(socket, i, probe.destination, readFrame);
    probeResults.push(result);

    if (result.gotResponse && !workingDestination) {
      // Check if any response was actually a DLT645 response
      for (const resp of result.responses) {
        if (resp.parsed.type === 'dlt645' ||
            (resp.parsed.type === 'ivy-wrapped' && resp.parsed.innerType === 'dlt645')) {
          workingDestination = probe.destination;
          log(`\n  >>> WORKING DESTINATION FOUND: ${result.destination} <<<`);
          break;
        }
      }
    }

    // Gap between probes (except after last)
    if (i < PROBE_LIST.length - 1) {
      log(`\n  Waiting ${PROBE_GAP_MS / 1000}s before next probe...`);
      await sleep(PROBE_GAP_MS);
    }
  }

  // Phase 2: Relay probes
  log('\n' + '='.repeat(70));
  log('PHASE 2: RELAY CONTROL PROBES');
  log('='.repeat(70));

  const tripFrame = buildSimpleRelayFrame(address, 'trip');
  const closeFrame = buildSimpleRelayFrame(address, 'close');
  log(`\nDLT645 Relay Trip frame: ${hexDump(tripFrame)}`);
  log(`DLT645 Relay Close frame: ${hexDump(closeFrame)}`);

  if (workingDestination !== null) {
    // Try relay with the working destination
    log(`\nTrying relay with working destination: 0x${workingDestination.toString(16).padStart(4, '0')}`);

    // Trip test
    const tripResult = await sendProbe(socket, probeResults.length,
      workingDestination, tripFrame);
    tripResult.description = `Relay TRIP (dest=${tripResult.destination})`;
    probeResults.push(tripResult);

    await sleep(PROBE_GAP_MS);

    // Close test (to restore state)
    const closeResult = await sendProbe(socket, probeResults.length,
      workingDestination, closeFrame);
    closeResult.description = `Relay CLOSE (dest=${closeResult.destination})`;
    probeResults.push(closeResult);
  } else {
    // No working destination found for reads - try relay with all destinations
    log('\nNo working destination found for reads. Trying relay with all destinations...');

    const relayDests = [0x0001, 0x0002, 0x0010, 0x0011, 0x0020, 0x0021, 0x00FF, null];

    for (let i = 0; i < relayDests.length; i++) {
      const dest = relayDests[i];
      const result = await sendProbe(socket, probeResults.length, dest, tripFrame);
      result.description = dest === null
        ? 'Relay TRIP (raw DLT645)'
        : `Relay TRIP (dest=0x${dest.toString(16).padStart(4, '0')})`;
      probeResults.push(result);

      if (i < relayDests.length - 1) {
        await sleep(PROBE_GAP_MS);
      }
    }
  }

  // Print summary
  printSummary(workingDestination);
}

// ─── Summary Report ─────────────────────────────────────────────────────────

function printSummary(workingDestination) {
  log('\n\n' + '='.repeat(70));
  log('PROBE RESULTS SUMMARY');
  log('='.repeat(70));
  log('');

  // Table header
  const header = [
    '#'.padStart(3),
    'Type'.padEnd(10),
    'Destination'.padEnd(14),
    'Description'.padEnd(30),
    'Response?'.padEnd(10),
    'Details',
  ].join(' | ');

  log(header);
  log('-'.repeat(header.length));

  for (const result of probeResults) {
    const responseStr = result.gotResponse ? 'YES' : 'no';
    let details = '';

    if (result.gotResponse) {
      for (const resp of result.responses) {
        if (resp.parsed.type === 'dlt645') {
          details += `DLT645 ${resp.parsed.controlType || ''}`;
          if (resp.parsed.numericValue !== undefined) {
            details += ` val=${resp.parsed.numericValue}${resp.parsed.unit || ''}`;
          }
          if (resp.parsed.errorMessage) {
            details += ` err="${resp.parsed.errorMessage}"`;
          }
        } else if (resp.parsed.type === 'ivy-wrapped') {
          details += `IVY(${resp.parsed.destination})`;
          if (resp.parsed.dlt645) {
            details += ` DLT645:${resp.parsed.dlt645.controlType || ''}`;
          }
        } else if (resp.parsed.type === 'dlms') {
          details += `DLMS:${resp.parsed.apduType}`;
        } else {
          details += `${resp.parsed.type} (${resp.length}B)`;
        }
        details += '; ';
      }
    } else if (result.error) {
      details = `ERROR: ${result.error}`;
    }

    // Determine type (read vs relay)
    const isRelay = (result.description || '').toLowerCase().includes('relay');
    const typeStr = isRelay ? 'RELAY' : 'READ';

    const row = [
      String(result.probeIndex).padStart(3),
      typeStr.padEnd(10),
      result.destination.padEnd(14),
      (result.description || '').padEnd(30),
      responseStr.padEnd(10),
      details.trim(),
    ].join(' | ');

    log(row);
  }

  log('');
  log('-'.repeat(70));

  if (workingDestination !== null) {
    const destStr = workingDestination === null
      ? 'RAW (no IVY header)'
      : `0x${workingDestination.toString(16).padStart(4, '0')}`;
    log(`\n  RESULT: Working destination for DLT645 reads: ${destStr}`);
    log('  Use this destination code to wrap DLT645 frames in IVY headers.');
  } else {
    log('\n  RESULT: No working destination found for DLT645 reads.');
    log('  The meter may not support DLT645 over TCP, or may require');
    log('  a different wrapping format or authentication step.');
  }

  // Check if any relay probes got responses
  const relayResults = probeResults.filter(r =>
    (r.description || '').toLowerCase().includes('relay'));
  const relayResponses = relayResults.filter(r => r.gotResponse);
  if (relayResponses.length > 0) {
    log(`\n  Relay probes with responses: ${relayResponses.length}/${relayResults.length}`);
    for (const r of relayResponses) {
      log(`    - ${r.description}: ${r.destination}`);
    }
  } else if (relayResults.length > 0) {
    log(`\n  No relay probes received responses (0/${relayResults.length}).`);
  }

  log('\n' + '='.repeat(70));
}

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── TCP Server ─────────────────────────────────────────────────────────────

function startServer() {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`\nMeter connected from ${remote}`);

    if (activeSocket) {
      log('Already have an active connection, rejecting new one.');
      socket.destroy();
      return;
    }

    activeSocket = socket;
    probeResults = [];

    // Data handler during heartbeat detection phase
    let heartbeatReceived = false;
    let heartbeatDataBuffer = Buffer.alloc(0);

    const heartbeatPhaseHandler = (data) => {
      log(`<< Received ${data.length} bytes: ${hexDump(data)}`);
      heartbeatDataBuffer = Buffer.concat([heartbeatDataBuffer, data]);

      // Try to find heartbeat in accumulated buffer
      while (heartbeatDataBuffer.length >= HEARTBEAT_PACKET_LENGTH) {
        if (isHeartbeat(heartbeatDataBuffer)) {
          const addr = parseHeartbeat(heartbeatDataBuffer);
          log(`\nHEARTBEAT detected! Meter address: ${addr}`);
          meterAddress = addr;
          heartbeatReceived = true;

          // Consume the heartbeat bytes
          heartbeatDataBuffer = heartbeatDataBuffer.subarray(HEARTBEAT_PACKET_LENGTH);

          // Remove this handler and start probes
          socket.removeListener('data', heartbeatPhaseHandler);

          // Log any remaining buffer data
          if (heartbeatDataBuffer.length > 0) {
            log(`Remaining buffer after heartbeat (${heartbeatDataBuffer.length} bytes): ${hexDump(heartbeatDataBuffer)}`);
          }

          // Small delay before starting probes
          log('\nWaiting 2s before starting probes...');
          setTimeout(() => {
            runProbes(socket, addr).then(() => {
              log('\nProbe sequence complete. Keeping connection open for observation.');
              log('Press Ctrl+C to exit.');

              // Keep logging any further data
              socket.on('data', (d) => {
                log(`<< Post-probe data (${d.length} bytes): ${hexDump(d)}`);
                const identified = identifyData(d);
                log(`   Type: ${identified.type}`);
              });
            }).catch((err) => {
              log(`Probe error: ${err.message}`);
              log(err.stack);
            });
          }, 2000);

          return;
        }

        // Not a heartbeat start — try to find the IVY signature
        const ivyStart = findIvySignature(heartbeatDataBuffer, 1);
        if (ivyStart > 0) {
          log(`Skipping ${ivyStart} non-heartbeat bytes`);
          heartbeatDataBuffer = heartbeatDataBuffer.subarray(ivyStart);
        } else {
          // No IVY signature found, keep last few bytes in case of split
          if (heartbeatDataBuffer.length > 100) {
            log(`Discarding ${heartbeatDataBuffer.length - 4} bytes (no heartbeat found)`);
            heartbeatDataBuffer = heartbeatDataBuffer.subarray(heartbeatDataBuffer.length - 4);
          }
          break;
        }
      }

      if (!heartbeatReceived) {
        log('Waiting for heartbeat packet...');
      }
    };

    socket.on('data', heartbeatPhaseHandler);

    socket.on('close', () => {
      log(`Meter disconnected from ${remote}`);
      activeSocket = null;
      meterAddress = null;
    });

    socket.on('error', (err) => {
      log(`Socket error: ${err.message}`);
      activeSocket = null;
      meterAddress = null;
    });

    log('Waiting for heartbeat from meter...');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`\nERROR: Port ${TCP_PORT} is already in use!`);
      log('Make sure to stop the gateway first:');
      log('  sudo systemctl stop ivy-gateway');
      process.exit(1);
    }
    log(`Server error: ${err.message}`);
  });

  server.listen(TCP_PORT, '0.0.0.0', () => {
    log('='.repeat(70));
    log('IVY DLT645 DESTINATION CODE PROBE');
    log('='.repeat(70));
    log(`TCP server listening on port ${TCP_PORT}`);
    log('Waiting for meter to connect...');
    log('');
    log('This script will:');
    log('  1. Wait for a meter heartbeat to detect meter address');
    log('  2. Send DLT645 "Read Total Energy" with various IVY destination codes');
    log('  3. Send DLT645 relay control probes');
    log('  4. Report which destination code (if any) gets a response');
    log('');
    log('Make sure the gateway is stopped: sudo systemctl stop ivy-gateway');
    log('='.repeat(70));
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('\n\nShutting down...');
    if (probeResults.length > 0) {
      printSummary(null);
    }
    server.close(() => {
      if (activeSocket) {
        activeSocket.destroy();
      }
      process.exit(0);
    });
    // Force exit after 3s
    setTimeout(() => process.exit(0), 3000);
  });
}

/**
 * Find the IVY 4-byte signature (00 01 00 01) in a buffer.
 */
function findIvySignature(buf, startIndex = 0) {
  for (let i = startIndex; i <= buf.length - 4; i++) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x01 &&
        buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
      return i;
    }
  }
  return -1;
}

// ─── Entry Point ────────────────────────────────────────────────────────────

startServer();
