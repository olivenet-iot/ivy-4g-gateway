#!/usr/bin/env node
/**
 * IVY EM114070 - Comprehensive Packet Analyzer
 * 
 * Captures and analyzes ALL traffic from the meter.
 * Logs everything to console and file for later analysis.
 * 
 * Usage: node ivy-analyzer.mjs [duration_minutes]
 * Default: runs for 30 minutes
 */

import net from 'net';
import fs from 'fs';

const PORT = 8899;
const DURATION_MINUTES = parseInt(process.argv[2]) || 30;
const LOG_FILE = `ivy-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;

// ============================================
// Packet Statistics
// ============================================
const stats = {
  startTime: new Date(),
  totalPackets: 0,
  totalBytes: 0,
  heartbeats: 0,
  dlmsPackets: 0,
  unknownPackets: 0,
  packetTypes: {},
  meterAddress: null,
  connectionCount: 0,
  lastHeartbeat: null,
  lastDataPacket: null
};

// All captured packets for analysis
const capturedPackets = [];

// ============================================
// Logging
// ============================================
function log(message, type = 'INFO') {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${type}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function hexDump(buffer, bytesPerLine = 16) {
  const lines = [];
  for (let i = 0; i < buffer.length; i += bytesPerLine) {
    const slice = buffer.slice(i, i + bytesPerLine);
    const hex = slice.toString('hex').match(/.{2}/g).join(' ');
    const ascii = Array.from(slice).map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : '.').join('');
    lines.push(`  ${i.toString(16).padStart(4, '0')}  ${hex.padEnd(bytesPerLine * 3 - 1)}  |${ascii}|`);
  }
  return lines.join('\n');
}

// ============================================
// Packet Parsers
// ============================================

function isHeartbeat(data) {
  return data.length === 26 && 
         data[0] === 0x00 && 
         data[1] === 0x01 &&
         data[4] === 0x00 &&
         data[5] === 0x01 &&
         data[7] === 0x12;
}

function parseHeartbeat(data) {
  return {
    type: 'HEARTBEAT',
    version: data.readUInt16BE(0),
    source: data.readUInt16BE(2),
    destination: data.readUInt16BE(4),
    length: data.readUInt16BE(6),
    subType: data[8],
    unknown1: data[9],
    unknown2: data[10],
    meterAddress: data.slice(11, 23).toString('ascii'),
    separator: data[23],
    crc: data.readUInt16BE(24)
  };
}

function isDlmsPacket(data) {
  return data.length >= 8 &&
         data[0] === 0x00 &&
         data[1] === 0x01 &&
         data[2] === 0x00 &&
         data[3] === 0x01;
}

function parseDlmsWrapper(data) {
  if (data.length < 8) return null;
  
  return {
    version: data.readUInt16BE(0),
    source: data.readUInt16BE(2),
    destination: data.readUInt16BE(4),
    length: data.readUInt16BE(6),
    payload: data.slice(8)
  };
}

function parseApduTag(tag) {
  const tags = {
    0x0F: 'DataNotification',
    0xC0: 'GET.request',
    0xC1: 'SET.request',
    0xC2: 'EventNotification',
    0xC3: 'ACTION.request',
    0xC4: 'GET.response',
    0xC5: 'SET.response',
    0xC6: 'ACTION.response'
  };
  return tags[tag] || `Unknown(0x${tag.toString(16)})`;
}

function parseCosemDateTime(buffer, offset = 0) {
  if (buffer.length < offset + 12) return null;
  
  const year = buffer.readUInt16BE(offset);
  const month = buffer[offset + 2];
  const day = buffer[offset + 3];
  const dow = buffer[offset + 4];
  const hour = buffer[offset + 5];
  const minute = buffer[offset + 6];
  const second = buffer[offset + 7];
  const hundredths = buffer[offset + 8];
  const deviation = buffer.readInt16BE(offset + 9);
  const status = buffer[offset + 11];
  
  return {
    datetime: `${year}-${month.toString().padStart(2,'0')}-${day.toString().padStart(2,'0')} ${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}:${second.toString().padStart(2,'0')}`,
    dayOfWeek: dow,
    hundredths,
    deviation,
    status
  };
}

function parseObisCode(buffer, offset = 0) {
  if (buffer.length < offset + 6) return null;
  const bytes = buffer.slice(offset, offset + 6);
  return `${bytes[0]}-${bytes[1]}:${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
}

function parseDlmsDataType(tag) {
  const types = {
    0x00: 'null-data',
    0x01: 'array',
    0x02: 'structure',
    0x03: 'boolean',
    0x04: 'bit-string',
    0x05: 'int32',
    0x06: 'uint32',
    0x09: 'octet-string',
    0x0A: 'visible-string',
    0x0F: 'int8',
    0x10: 'int16',
    0x11: 'uint8',
    0x12: 'uint16',
    0x14: 'int64',
    0x15: 'uint64',
    0x16: 'enum',
    0x19: 'datetime'
  };
  return types[tag] || `unknown(0x${tag.toString(16)})`;
}

function analyzeDlmsPayload(payload) {
  const analysis = {
    apduTag: payload[0],
    apduName: parseApduTag(payload[0]),
    details: {}
  };
  
  // EventNotification (0xC2)
  if (payload[0] === 0xC2) {
    analysis.details.timePresent = payload[1] === 0x01;
    
    let offset = 2;
    if (analysis.details.timePresent && payload.length >= 14) {
      analysis.details.timestamp = parseCosemDateTime(payload, offset);
      offset += 12;
    }
    
    // Attribute descriptor
    if (payload.length >= offset + 9) {
      analysis.details.classId = payload.readUInt16BE(offset);
      analysis.details.obisCode = parseObisCode(payload, offset + 2);
      analysis.details.attributeIndex = payload[offset + 8];
      offset += 9;
    }
    
    // Data value starts here
    if (payload.length > offset) {
      analysis.details.dataStartOffset = offset;
      analysis.details.dataTag = payload[offset];
      analysis.details.dataType = parseDlmsDataType(payload[offset]);
      analysis.details.remainingBytes = payload.length - offset;
    }
  }
  
  // DataNotification (0x0F)
  if (payload[0] === 0x0F) {
    analysis.details.note = 'DataNotification - may contain energy readings';
    let offset = 1;
    
    // Long-invoke-id-and-priority
    if (payload.length >= 5) {
      analysis.details.invokeId = payload.readUInt32BE(offset);
      offset += 4;
    }
    
    // date-time (optional)
    if (payload.length >= offset + 1) {
      const dtLength = payload[offset];
      if (dtLength === 0x0C) { // 12 bytes datetime
        offset += 1;
        analysis.details.timestamp = parseCosemDateTime(payload, offset);
        offset += 12;
      } else if (dtLength === 0x00) {
        offset += 1;
      }
    }
    
    // notification-body starts here
    if (payload.length > offset) {
      analysis.details.bodyStartOffset = offset;
      analysis.details.bodyTag = payload[offset];
      analysis.details.bodyType = parseDlmsDataType(payload[offset]);
    }
  }
  
  return analysis;
}

function isDlt645Frame(data) {
  // DLT645 starts with 0x68 and ends with 0x16
  if (data.length < 12) return false;
  const start = data.indexOf(0x68);
  if (start === -1) return false;
  if (data.length > start + 7 && data[start + 7] === 0x68) {
    // Found both 0x68 markers
    return true;
  }
  return false;
}

function parseDlt645Frame(data) {
  const start = data.indexOf(0x68);
  if (start === -1) return null;
  
  const address = data.slice(start + 1, start + 7).reverse().toString('hex');
  const control = data[start + 8];
  const length = data[start + 9];
  
  const controlNames = {
    0x11: 'Read Data',
    0x12: 'Read Subsequent',
    0x13: 'Read Address',
    0x14: 'Write Data',
    0x91: 'Read Response (Normal)',
    0xD1: 'Read Response (Error)',
    0x93: 'Address Response',
    0x94: 'Write Response'
  };
  
  return {
    type: 'DLT645',
    address,
    control,
    controlName: controlNames[control] || `Unknown(0x${control.toString(16)})`,
    dataLength: length,
    isResponse: (control & 0x80) !== 0
  };
}

// ============================================
// Deep Packet Analysis
// ============================================

function analyzePacket(data, direction) {
  const packet = {
    timestamp: new Date().toISOString(),
    direction,
    length: data.length,
    rawHex: data.toString('hex'),
    analysis: null
  };
  
  // Check packet type
  if (isHeartbeat(data)) {
    packet.type = 'HEARTBEAT';
    packet.analysis = parseHeartbeat(data);
    stats.heartbeats++;
    stats.lastHeartbeat = new Date();
    if (!stats.meterAddress) {
      stats.meterAddress = packet.analysis.meterAddress;
    }
  } else if (isDlmsPacket(data)) {
    packet.type = 'DLMS';
    const wrapper = parseDlmsWrapper(data);
    packet.analysis = {
      wrapper,
      payload: wrapper ? analyzeDlmsPayload(wrapper.payload) : null
    };
    stats.dlmsPackets++;
    stats.lastDataPacket = new Date();
    
    // Track destination types
    const destType = `DLMS_dest_${wrapper?.destination || 'unknown'}`;
    stats.packetTypes[destType] = (stats.packetTypes[destType] || 0) + 1;
  } else if (isDlt645Frame(data)) {
    packet.type = 'DLT645';
    packet.analysis = parseDlt645Frame(data);
  } else {
    packet.type = 'UNKNOWN';
    stats.unknownPackets++;
    
    // Try to find patterns
    packet.analysis = {
      startsWithZero: data[0] === 0x00,
      firstBytes: data.slice(0, Math.min(8, data.length)).toString('hex'),
      containsDlt645Start: data.includes(0x68),
      containsAscii: /[\x20-\x7E]{4,}/.test(data.toString())
    };
  }
  
  // Track packet type stats
  stats.packetTypes[packet.type] = (stats.packetTypes[packet.type] || 0) + 1;
  stats.totalPackets++;
  stats.totalBytes += data.length;
  
  return packet;
}

// ============================================
// Display Functions
// ============================================

function displayPacket(packet) {
  const dirArrow = packet.direction === 'IN' ? '📥 <<<' : '📤 >>>';
  
  log(`\n${'═'.repeat(70)}`, 'PKT');
  log(`${dirArrow} ${packet.type} Packet (${packet.length} bytes)`, 'PKT');
  log(`${'═'.repeat(70)}`, 'PKT');
  
  // Hex dump
  log('Raw Data:', 'PKT');
  log(hexDump(Buffer.from(packet.rawHex, 'hex')), 'PKT');
  
  // Analysis
  if (packet.analysis) {
    log('\nAnalysis:', 'PKT');
    log(JSON.stringify(packet.analysis, null, 2), 'PKT');
  }
  
  // Special handling for interesting packets
  if (packet.type === 'DLMS' && packet.analysis?.payload) {
    const payload = packet.analysis.payload;
    log(`\n🔍 DLMS APDU: ${payload.apduName}`, 'PKT');
    
    if (payload.details.obisCode) {
      log(`   OBIS Code: ${payload.details.obisCode}`, 'PKT');
      
      // Known OBIS codes
      const obisNames = {
        '0-0:96.11.0.255': 'Standard Event Log',
        '1-0:1.8.0.255': 'Total Active Energy Import (+A)',
        '1-0:2.8.0.255': 'Total Active Energy Export (-A)',
        '1-0:1.7.0.255': 'Instantaneous Active Power Import',
        '1-0:32.7.0.255': 'Voltage L1',
        '1-0:52.7.0.255': 'Voltage L2',
        '1-0:72.7.0.255': 'Voltage L3',
        '1-0:31.7.0.255': 'Current L1',
        '1-0:51.7.0.255': 'Current L2',
        '1-0:71.7.0.255': 'Current L3'
      };
      
      if (obisNames[payload.details.obisCode]) {
        log(`   OBIS Name: ${obisNames[payload.details.obisCode]}`, 'PKT');
      }
    }
    
    if (payload.details.timestamp) {
      log(`   Timestamp: ${payload.details.timestamp.datetime}`, 'PKT');
    }
  }
}

function displayStats() {
  const runtime = Math.round((new Date() - stats.startTime) / 1000);
  const minutes = Math.floor(runtime / 60);
  const seconds = runtime % 60;
  
  console.log('\n' + '─'.repeat(70));
  console.log('📊 LIVE STATISTICS');
  console.log('─'.repeat(70));
  console.log(`Runtime: ${minutes}m ${seconds}s`);
  console.log(`Total Packets: ${stats.totalPackets} (${stats.totalBytes} bytes)`);
  console.log(`Meter Address: ${stats.meterAddress || 'Unknown'}`);
  console.log(`Connections: ${stats.connectionCount}`);
  console.log(`\nPacket Types:`);
  Object.entries(stats.packetTypes).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
  if (stats.lastHeartbeat) {
    const hbAgo = Math.round((new Date() - stats.lastHeartbeat) / 1000);
    console.log(`\nLast Heartbeat: ${hbAgo}s ago`);
  }
  if (stats.lastDataPacket) {
    const dataAgo = Math.round((new Date() - stats.lastDataPacket) / 1000);
    console.log(`Last Data Packet: ${dataAgo}s ago`);
  }
  console.log('─'.repeat(70));
}

// ============================================
// Test Commands (sent periodically)
// ============================================

const testCommands = [
  {
    name: 'DLT645 Read Total Energy',
    interval: 60000, // every 60s
    lastSent: 0,
    build: () => {
      const frame = Buffer.alloc(16);
      frame[0] = 0x68;
      // Address (broadcast)
      frame[7] = 0x68;
      frame[8] = 0x11; // Read
      frame[9] = 0x04; // Length
      frame[10] = 0x33; frame[11] = 0x33; frame[12] = 0x33; frame[13] = 0x33; // Total energy
      let sum = 0;
      for (let i = 0; i < 14; i++) sum += frame[i];
      frame[14] = sum & 0xFF;
      frame[15] = 0x16;
      return frame;
    }
  },
  {
    name: 'DLMS AARQ (Association Request)',
    interval: 120000, // every 2 min
    lastSent: 0,
    build: () => {
      // Minimal AARQ to try establishing DLMS association
      return Buffer.from([
        0x00, 0x01, // Version
        0x00, 0x01, // Source
        0x00, 0x10, // Destination (public client)
        0x00, 0x19, // Length
        // AARQ APDU
        0x60, 0x17, // AARQ tag + length
        0xA1, 0x09, 0x06, 0x07, 0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x01, // Application context (LN)
        0x8A, 0x02, 0x07, 0x80, // ACSE requirements
        0x8B, 0x04, 0x05, 0x03, 0x04, 0x01 // Mechanism name (lowest level security)
      ]);
    }
  }
];

function sendTestCommands(socket) {
  const now = Date.now();
  
  testCommands.forEach(cmd => {
    if (now - cmd.lastSent > cmd.interval) {
      const data = cmd.build();
      log(`\n🧪 Sending test: ${cmd.name}`, 'TEST');
      log(`   Data: ${data.toString('hex')}`, 'TEST');
      socket.write(data);
      cmd.lastSent = now;
      
      const packet = analyzePacket(data, 'OUT');
      capturedPackets.push(packet);
    }
  });
}

// ============================================
// Main Server
// ============================================

let clientSocket = null;
let testInterval = null;

const server = net.createServer((socket) => {
  stats.connectionCount++;
  const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
  
  log(`\n${'🔌'.repeat(35)}`, 'CONN');
  log(`METER CONNECTED from ${remoteAddr}`, 'CONN');
  log(`${'🔌'.repeat(35)}`, 'CONN');
  
  if (clientSocket) {
    log('Closing previous connection', 'CONN');
    clientSocket.destroy();
  }
  
  clientSocket = socket;
  
  // Start sending test commands periodically
  if (testInterval) clearInterval(testInterval);
  testInterval = setInterval(() => {
    if (clientSocket) sendTestCommands(clientSocket);
  }, 10000); // Check every 10s
  
  socket.on('data', (data) => {
    const packet = analyzePacket(data, 'IN');
    capturedPackets.push(packet);
    displayPacket(packet);
  });
  
  socket.on('close', () => {
    log(`\n🔌 Meter disconnected`, 'CONN');
    clientSocket = null;
    if (testInterval) {
      clearInterval(testInterval);
      testInterval = null;
    }
  });
  
  socket.on('error', (err) => {
    log(`Socket error: ${err.message}`, 'ERROR');
  });
});

// ============================================
// Startup
// ============================================

console.log('═'.repeat(70));
console.log('  IVY EM114070 - Comprehensive Packet Analyzer');
console.log('═'.repeat(70));
console.log(`\n📁 Logging to: ${LOG_FILE}`);
console.log(`⏱️  Will run for: ${DURATION_MINUTES} minutes`);
console.log(`\n🧪 Will periodically send test commands:`);
testCommands.forEach(cmd => console.log(`   - ${cmd.name} (every ${cmd.interval/1000}s)`));

server.listen(PORT, () => {
  log(`\n🚀 Server listening on port ${PORT}`, 'START');
  log('Waiting for meter connection...', 'START');
  
  // Display stats every 30 seconds
  setInterval(displayStats, 30000);
  
  // Auto-exit after duration
  setTimeout(() => {
    log('\n⏱️ Time limit reached. Saving final results...', 'END');
    
    // Save all captured packets
    const captureFile = `ivy-packets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(captureFile, JSON.stringify({
      stats,
      packets: capturedPackets
    }, null, 2));
    
    log(`\n📁 Packets saved to: ${captureFile}`, 'END');
    displayStats();
    
    console.log('\n' + '═'.repeat(70));
    console.log('  FINAL SUMMARY');
    console.log('═'.repeat(70));
    console.log(`Total packets captured: ${capturedPackets.length}`);
    console.log(`Unique DLMS OBIS codes seen:`);
    
    const obisCodes = new Set();
    capturedPackets.forEach(p => {
      if (p.analysis?.payload?.details?.obisCode) {
        obisCodes.add(p.analysis.payload.details.obisCode);
      }
    });
    obisCodes.forEach(code => console.log(`  - ${code}`));
    
    console.log('═'.repeat(70));
    
    process.exit(0);
  }, DURATION_MINUTES * 60 * 1000);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use!`);
    console.error('Run: sudo systemctl stop ivy-gateway');
    process.exit(1);
  }
  throw err;
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  log('\n\n⚠️ Interrupted by user. Saving data...', 'END');
  
  const captureFile = `ivy-packets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(captureFile, JSON.stringify({
    stats,
    packets: capturedPackets
  }, null, 2));
  
  log(`📁 Packets saved to: ${captureFile}`, 'END');
  displayStats();
  process.exit(0);
});
