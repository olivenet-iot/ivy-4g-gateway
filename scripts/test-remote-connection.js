#!/usr/bin/env node
/**
 * IVY Meter Simulator - Remote Connection Test
 *
 * Simulates an IVY EM114070 4G meter connecting to a remote server.
 * Use this to verify the server is accepting connections correctly.
 *
 * Usage:
 *   node scripts/test-remote-connection.js [host] [port] [meterId]
 *
 * Examples:
 *   node scripts/test-remote-connection.js 13.41.157.130 8899
 *   node scripts/test-remote-connection.js 13.41.157.130 8899 123456789012
 */

import net from 'net';

// Configuration
const HOST = process.argv[2] || '13.41.157.130';
const PORT = parseInt(process.argv[3]) || 8899;
const METER_ID = process.argv[4] || '000000001234';

// DL/T 645 Protocol Constants
const START_DELIMITER = 0x68;
const END_DELIMITER = 0x16;
const DATA_OFFSET = 0x33;

// Control Codes
const CONTROL_CODES = {
  READ_DATA: 0x11,
  READ_DATA_RESPONSE: 0x91,
  READ_ADDRESS: 0x13,
  READ_ADDRESS_RESPONSE: 0x93,
};

// Sample register values (simulated meter data)
const REGISTER_VALUES = {
  0x00000000: { value: 12345.67, bytes: 4, resolution: 0.01 },  // Total active energy
  0x02010100: { value: 220.5, bytes: 2, resolution: 0.1 },      // Voltage A
  0x02020100: { value: 5.234, bytes: 3, resolution: 0.001 },    // Current A
  0x02030000: { value: 1152, bytes: 3, resolution: 1 },         // Active power
  0x02060000: { value: 0.997, bytes: 2, resolution: 0.001 },    // Power factor
  0x02800002: { value: 50.02, bytes: 2, resolution: 0.01 },     // Frequency
};

// Helper functions
function addressToBuffer(address) {
  const buffer = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    const twoDigits = address.substr(i * 2, 2);
    const tens = parseInt(twoDigits[0]);
    const ones = parseInt(twoDigits[1]);
    buffer[5 - i] = (tens << 4) | ones;  // Little-endian
  }
  return buffer;
}

function bufferToAddress(buffer) {
  let address = '';
  for (let i = 5; i >= 0; i--) {
    const byte = buffer[i];
    address += ((byte >> 4) & 0x0f).toString() + (byte & 0x0f).toString();
  }
  return address;
}

function applyOffset(buffer) {
  const result = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    result[i] = (buffer[i] + DATA_OFFSET) & 0xff;
  }
  return result;
}

function removeOffset(buffer) {
  const result = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    result[i] = (buffer[i] - DATA_OFFSET + 256) & 0xff;
  }
  return result;
}

function calculateChecksum(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i];
  }
  return sum & 0xff;
}

function encodeValueToBcd(value, bytes) {
  const buffer = Buffer.alloc(bytes);
  let remaining = Math.abs(Math.round(value));

  for (let i = 0; i < bytes; i++) {
    const twoDigits = remaining % 100;
    const tens = Math.floor(twoDigits / 10);
    const ones = twoDigits % 10;
    buffer[i] = (tens << 4) | ones;
    remaining = Math.floor(remaining / 100);
  }

  return buffer;
}

function dataIdToBuffer(dataId) {
  const buffer = Buffer.alloc(4);
  buffer[0] = ((dataId & 0xff) + DATA_OFFSET) & 0xff;
  buffer[1] = (((dataId >> 8) & 0xff) + DATA_OFFSET) & 0xff;
  buffer[2] = (((dataId >> 16) & 0xff) + DATA_OFFSET) & 0xff;
  buffer[3] = (((dataId >> 24) & 0xff) + DATA_OFFSET) & 0xff;
  return buffer;
}

function extractDataId(data) {
  return (
    data[0] |
    (data[1] << 8) |
    (data[2] << 16) |
    (data[3] << 24)
  );
}

function buildResponseFrame(meterId, controlCode, data) {
  const header = Buffer.alloc(10);
  header[0] = START_DELIMITER;
  addressToBuffer(meterId).copy(header, 1);
  header[7] = START_DELIMITER;
  header[8] = controlCode;
  header[9] = data.length;

  const frameWithoutChecksum = Buffer.concat([header, data]);
  const checksum = calculateChecksum(frameWithoutChecksum);

  return Buffer.concat([frameWithoutChecksum, Buffer.from([checksum, END_DELIMITER])]);
}

function buildReadResponse(meterId, dataId, regInfo) {
  const rawValue = Math.round(regInfo.value / regInfo.resolution);
  const valueBuffer = encodeValueToBcd(rawValue, regInfo.bytes);
  const valueWithOffset = applyOffset(valueBuffer);
  const dataIdBuffer = dataIdToBuffer(dataId);

  const data = Buffer.concat([dataIdBuffer, valueWithOffset]);
  return buildResponseFrame(meterId, CONTROL_CODES.READ_DATA_RESPONSE, data);
}

function buildAddressResponse(meterId) {
  const addressData = applyOffset(addressToBuffer(meterId));
  return buildResponseFrame(meterId, CONTROL_CODES.READ_ADDRESS_RESPONSE, addressData);
}

// Proactively send telemetry (like a real meter does after connecting)
function buildTelemetryFrame(meterId) {
  // Send total active energy as initial telemetry
  const regInfo = REGISTER_VALUES[0x00000000];
  return buildReadResponse(meterId, 0x00000000, regInfo);
}

function formatHex(buffer) {
  return buffer.toString('hex').match(/.{2}/g).join(' ').toUpperCase();
}

function parseFrame(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] !== START_DELIMITER) return null;
  if (buffer[7] !== START_DELIMITER) return null;

  const dataLength = buffer[9];
  const expectedLength = 10 + dataLength + 2;
  if (buffer.length < expectedLength) return null;

  const address = bufferToAddress(buffer.subarray(1, 7));
  const controlCode = buffer[8];
  const rawData = buffer.subarray(10, 10 + dataLength);
  const data = removeOffset(rawData);

  return { address, controlCode, data, dataLength };
}

// Main simulator class
class MeterSimulator {
  constructor(host, port, meterId) {
    this.host = host;
    this.port = port;
    this.meterId = meterId;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.isConnected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      console.log('═'.repeat(60));
      console.log('IVY Meter Simulator - Remote Connection Test');
      console.log('═'.repeat(60));
      console.log(`Meter ID:    ${this.meterId}`);
      console.log(`Server:      ${this.host}:${this.port}`);
      console.log('─'.repeat(60));
      console.log(`[${this.timestamp()}] Connecting...`);

      this.socket = new net.Socket();

      this.socket.connect(this.port, this.host, () => {
        this.isConnected = true;
        console.log(`[${this.timestamp()}] ✅ TCP Connected!`);
        console.log(`[${this.timestamp()}] Local address: ${this.socket.localAddress}:${this.socket.localPort}`);

        // Send initial telemetry after connection (like real meter)
        setTimeout(() => {
          this.sendInitialTelemetry();
        }, 500);

        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        console.log(`[${this.timestamp()}] ❌ Connection closed`);
        this.isConnected = false;
      });

      this.socket.on('error', (err) => {
        console.log(`[${this.timestamp()}] ❌ Error: ${err.message}`);
        if (!this.isConnected) {
          reject(err);
        }
      });

      // Connection timeout
      this.socket.setTimeout(10000, () => {
        console.log(`[${this.timestamp()}] ❌ Connection timeout`);
        this.socket.destroy();
        reject(new Error('Connection timeout'));
      });
    });
  }

  timestamp() {
    return new Date().toISOString().substr(11, 12);
  }

  sendInitialTelemetry() {
    console.log(`[${this.timestamp()}] 📤 Sending initial telemetry (Total Energy)...`);
    const frame = buildTelemetryFrame(this.meterId);
    this.sendFrame(frame);
  }

  handleData(data) {
    console.log(`[${this.timestamp()}] 📥 Received: ${formatHex(data)}`);

    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 12) {
      // Find frame start
      const startIdx = this.buffer.indexOf(START_DELIMITER);
      if (startIdx === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (startIdx > 0) {
        this.buffer = this.buffer.subarray(startIdx);
      }

      if (this.buffer.length < 10) break;

      const dataLength = this.buffer[9];
      const frameLength = 10 + dataLength + 2;

      if (this.buffer.length < frameLength) break;

      const frame = this.buffer.subarray(0, frameLength);
      this.buffer = this.buffer.subarray(frameLength);

      this.processFrame(frame);
    }
  }

  processFrame(frame) {
    const parsed = parseFrame(frame);
    if (!parsed) {
      console.log(`[${this.timestamp()}] ⚠️  Invalid frame`);
      return;
    }

    console.log(`[${this.timestamp()}] 📋 Frame: addr=${parsed.address}, ctrl=0x${parsed.controlCode.toString(16)}`);

    // Check if addressed to us or broadcast
    if (parsed.address !== this.meterId &&
        parsed.address !== '999999999999' &&
        parsed.address !== 'AAAAAAAAAAAA') {
      console.log(`[${this.timestamp()}]    Not for us, ignoring`);
      return;
    }

    // Handle based on control code
    switch (parsed.controlCode) {
      case CONTROL_CODES.READ_DATA:
        this.handleReadRequest(parsed);
        break;
      case CONTROL_CODES.READ_ADDRESS:
        this.handleReadAddress();
        break;
      default:
        console.log(`[${this.timestamp()}]    Unknown control code, no response`);
    }
  }

  handleReadRequest(parsed) {
    if (parsed.data.length < 4) {
      console.log(`[${this.timestamp()}]    Data too short for read request`);
      return;
    }

    const dataId = extractDataId(parsed.data);
    console.log(`[${this.timestamp()}]    Read request for DI: 0x${dataId.toString(16).padStart(8, '0')}`);

    const regInfo = REGISTER_VALUES[dataId];
    if (!regInfo) {
      console.log(`[${this.timestamp()}]    Unknown register, no response`);
      return;
    }

    setTimeout(() => {
      const response = buildReadResponse(this.meterId, dataId, regInfo);
      console.log(`[${this.timestamp()}] 📤 Response: ${regInfo.value} (DI: 0x${dataId.toString(16).padStart(8, '0')})`);
      this.sendFrame(response);
    }, 50);
  }

  handleReadAddress() {
    console.log(`[${this.timestamp()}]    Read address request`);

    setTimeout(() => {
      const response = buildAddressResponse(this.meterId);
      console.log(`[${this.timestamp()}] 📤 Address response: ${this.meterId}`);
      this.sendFrame(response);
    }, 50);
  }

  sendFrame(frame) {
    if (!this.isConnected || !this.socket) {
      console.log(`[${this.timestamp()}] ⚠️  Cannot send, not connected`);
      return;
    }
    console.log(`[${this.timestamp()}]    TX: ${formatHex(frame)}`);
    this.socket.write(frame);
  }

  // Send periodic telemetry like a real meter
  startPeriodicTelemetry(intervalMs = 30000) {
    console.log(`[${this.timestamp()}] 🔄 Starting periodic telemetry every ${intervalMs/1000}s`);

    setInterval(() => {
      if (this.isConnected) {
        // Randomly pick a register to report
        const dataIds = Object.keys(REGISTER_VALUES).map(k => parseInt(k));
        const dataId = dataIds[Math.floor(Math.random() * dataIds.length)];
        const regInfo = REGISTER_VALUES[dataId];

        // Add some variation to the value
        const variation = regInfo.value * (0.95 + Math.random() * 0.1);
        const tempRegInfo = { ...regInfo, value: variation };

        console.log(`[${this.timestamp()}] 📤 Periodic telemetry: ${variation.toFixed(2)}`);
        const frame = buildReadResponse(this.meterId, dataId, tempRegInfo);
        this.sendFrame(frame);
      }
    }, intervalMs);
  }

  disconnect() {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

// Run the simulator
async function main() {
  const simulator = new MeterSimulator(HOST, PORT, METER_ID);

  try {
    await simulator.connect();

    // Start sending periodic telemetry
    simulator.startPeriodicTelemetry(30000);

    console.log('─'.repeat(60));
    console.log('Simulator running. Press Ctrl+C to stop.');
    console.log('─'.repeat(60));

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log(`\n[${simulator.timestamp()}] Shutting down...`);
      simulator.disconnect();
      process.exit(0);
    });

  } catch (err) {
    console.error(`\n❌ Failed to connect: ${err.message}`);
    console.log('\nPossible causes:');
    console.log('  - Server not running');
    console.log('  - Firewall blocking connection');
    console.log('  - Wrong IP/port');
    process.exit(1);
  }
}

main();
