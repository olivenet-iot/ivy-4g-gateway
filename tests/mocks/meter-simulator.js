/**
 * DLT645 Energy Meter Simulator
 *
 * Simulates a 4G energy meter for testing purposes.
 * Connects to TCP server as a client and responds to commands
 * with valid DLT645 protocol frames.
 *
 * Features:
 * - Configurable meter address
 * - Simulated register values (energy, voltage, current, etc.)
 * - Auto-response to read commands
 * - Relay control simulation
 * - Configurable response delays
 *
 * @module mocks/meter-simulator
 */

import net from 'net';
import { EventEmitter } from 'events';
import { createStreamParser } from '../../src/protocol/frame-parser.js';
import {
  appendChecksum,
  FRAME_CONSTANTS,
} from '../../src/protocol/checksum.js';
import {
  addressToBuffer,
  dataIdToBuffer,
  applyOffset,
} from '../../src/protocol/bcd.js';
import {
  CONTROL_CODES,
  ENERGY_REGISTERS,
  INSTANTANEOUS_REGISTERS,
  PARAMETER_REGISTERS,
  PREPAID_REGISTERS,
  getResponseCode,
  getErrorResponseCode,
} from '../../src/protocol/registers.js';

/**
 * Simulator events
 */
export const SIMULATOR_EVENTS = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FRAME_RECEIVED: 'frame:received',
  FRAME_SENT: 'frame:sent',
  ERROR: 'error',
};

/**
 * Default simulated meter values
 */
export const DEFAULT_METER_VALUES = {
  // Energy (kWh) - resolution 0.01
  [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: 12345.67,
  [ENERGY_REGISTERS.TARIFF_1_ACTIVE.id]: 8000.0,
  [ENERGY_REGISTERS.TARIFF_2_ACTIVE.id]: 3000.0,
  [ENERGY_REGISTERS.TARIFF_3_ACTIVE.id]: 1000.0,
  [ENERGY_REGISTERS.TARIFF_4_ACTIVE.id]: 345.67,

  // Voltage (V) - resolution 0.1
  [INSTANTANEOUS_REGISTERS.VOLTAGE_A.id]: 220.5,

  // Current (A) - resolution 0.001
  [INSTANTANEOUS_REGISTERS.CURRENT_A.id]: 5.234,

  // Power (W) - resolution 1
  [INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL.id]: 1152,
  [INSTANTANEOUS_REGISTERS.REACTIVE_POWER_TOTAL.id]: 89,

  // Power Factor - resolution 0.001
  [INSTANTANEOUS_REGISTERS.POWER_FACTOR_TOTAL.id]: 0.997,

  // Frequency (Hz) - resolution 0.01
  [INSTANTANEOUS_REGISTERS.FREQUENCY.id]: 50.02,

  // Balance (kWh) - resolution 0.01
  [PREPAID_REGISTERS.BALANCE_ENERGY.id]: 500.0,

  // Relay Status - 0=closed, 1=open
  [PARAMETER_REGISTERS.RELAY_STATUS.id]: 0,
};

/**
 * Register metadata for encoding
 */
const REGISTER_METADATA = {
  [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: { bytes: 4, resolution: 0.01 },
  [ENERGY_REGISTERS.TARIFF_1_ACTIVE.id]: { bytes: 4, resolution: 0.01 },
  [ENERGY_REGISTERS.TARIFF_2_ACTIVE.id]: { bytes: 4, resolution: 0.01 },
  [ENERGY_REGISTERS.TARIFF_3_ACTIVE.id]: { bytes: 4, resolution: 0.01 },
  [ENERGY_REGISTERS.TARIFF_4_ACTIVE.id]: { bytes: 4, resolution: 0.01 },
  [INSTANTANEOUS_REGISTERS.VOLTAGE_A.id]: { bytes: 2, resolution: 0.1 },
  [INSTANTANEOUS_REGISTERS.CURRENT_A.id]: { bytes: 3, resolution: 0.001 },
  [INSTANTANEOUS_REGISTERS.ACTIVE_POWER_TOTAL.id]: { bytes: 3, resolution: 1 },
  [INSTANTANEOUS_REGISTERS.REACTIVE_POWER_TOTAL.id]: { bytes: 3, resolution: 1 },
  [INSTANTANEOUS_REGISTERS.POWER_FACTOR_TOTAL.id]: { bytes: 2, resolution: 0.001 },
  [INSTANTANEOUS_REGISTERS.FREQUENCY.id]: { bytes: 2, resolution: 0.01 },
  [PREPAID_REGISTERS.BALANCE_ENERGY.id]: { bytes: 4, resolution: 0.01 },
  [PARAMETER_REGISTERS.RELAY_STATUS.id]: { bytes: 1, resolution: 1 },
};

/**
 * Meter Simulator Class
 */
export class MeterSimulator extends EventEmitter {
  /**
   * @param {Object} options - Simulator options
   * @param {string} [options.address='000000001234'] - 12-digit meter address
   * @param {string} [options.host='127.0.0.1'] - Server host
   * @param {number} [options.port=8899] - Server port
   * @param {number} [options.responseDelay=10] - Response delay in ms
   * @param {Object} [options.values] - Initial register values
   */
  constructor(options = {}) {
    super();

    this.options = {
      address: options.address || '000000001234',
      host: options.host || '127.0.0.1',
      port: options.port || 8899,
      responseDelay: options.responseDelay || 10,
    };

    /** @type {net.Socket|null} */
    this.socket = null;

    /** @type {boolean} */
    this.isConnected = false;

    /** @type {Object} Simulated register values */
    this.values = { ...DEFAULT_METER_VALUES, ...options.values };

    /** @type {Object} Stream parser for incoming frames */
    this.streamParser = null;

    /** @type {number} */
    this.framesReceived = 0;

    /** @type {number} */
    this.framesSent = 0;
  }

  /**
   * Connect to TCP server
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.isConnected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      // Create stream parser with callbacks
      this.streamParser = createStreamParser(
        (parsed, frame) => {
          this.framesReceived++;
          this.emit(SIMULATOR_EVENTS.FRAME_RECEIVED, { frame, parsed });
          this.processFrame(frame, parsed);
        },
        (error, frame) => {
          this.emit(SIMULATOR_EVENTS.ERROR, { error, context: 'parse', frame });
        }
      );

      this.socket.connect(this.options.port, this.options.host, () => {
        this.isConnected = true;
        this.emit(SIMULATOR_EVENTS.CONNECTED, {
          address: this.options.address,
          host: this.options.host,
          port: this.options.port,
        });
        resolve();
      });

      this.socket.on('data', (data) => {
        this.streamParser.push(data);
      });

      this.socket.on('close', () => {
        this.isConnected = false;
        this.emit(SIMULATOR_EVENTS.DISCONNECTED, {
          address: this.options.address,
        });
      });

      this.socket.on('error', (error) => {
        this.emit(SIMULATOR_EVENTS.ERROR, { error });
        if (!this.isConnected) {
          reject(error);
        }
      });
    });
  }

  /**
   * Disconnect from server
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.isConnected || !this.socket) {
      return;
    }

    return new Promise((resolve) => {
      this.socket.end(() => {
        this.socket.destroy();
        this.isConnected = false;
        resolve();
      });

      // Force close after timeout
      setTimeout(() => {
        if (this.socket && !this.socket.destroyed) {
          this.socket.destroy();
        }
        resolve();
      }, 1000);
    });
  }

  /**
   * Process a received frame and generate response
   * @private
   * @param {Buffer} frame - Raw frame buffer
   * @param {Object} parsed - Parsed frame object
   */
  processFrame(frame, parsed) {
    try {
      // Check if frame is addressed to us (or broadcast)
      const frameAddress = parsed.address;
      if (
        frameAddress !== this.options.address &&
        frameAddress !== '999999999999' &&
        frameAddress !== 'AAAAAAAAAAAA'
      ) {
        return; // Not for us
      }

      // Handle based on control code
      const controlCode = parsed.controlCode;

      switch (controlCode) {
        case CONTROL_CODES.READ_DATA:
          this.handleReadRequest(frame, parsed);
          break;

        case CONTROL_CODES.WRITE_DATA:
          this.handleWriteRequest(frame, parsed);
          break;

        case CONTROL_CODES.RELAY_CONTROL:
          this.handleRelayControl(frame, parsed);
          break;

        case CONTROL_CODES.READ_ADDRESS:
          this.handleReadAddress(frame);
          break;

        default:
          // Unknown command - send error response
          this.sendErrorResponse(controlCode, 0x01);
      }
    } catch (error) {
      this.emit(SIMULATOR_EVENTS.ERROR, { error, context: 'processFrame' });
    }
  }

  /**
   * Extract data identifier from parsed frame
   * @private
   * @param {Object} parsed - Parsed frame object
   * @returns {number} Data ID
   */
  extractDataId(parsed) {
    if (parsed.data.length < 4) {
      return 0;
    }
    // Data is already offset-removed in parsed.data
    // Reconstruct as little-endian 32-bit integer
    return (
      parsed.data[0] |
      (parsed.data[1] << 8) |
      (parsed.data[2] << 16) |
      (parsed.data[3] << 24)
    );
  }

  /**
   * Handle READ_DATA request
   * @private
   */
  handleReadRequest(frame, parsed) {
    const dataId = this.extractDataId(parsed);
    const value = this.values[dataId];

    if (value === undefined) {
      // Unknown register - send error
      this.sendErrorResponse(CONTROL_CODES.READ_DATA, 0x02); // No data
      return;
    }

    // Build response
    setTimeout(() => {
      const response = this.buildReadResponse(dataId, value);
      this.sendFrame(response);
    }, this.options.responseDelay);
  }

  /**
   * Build READ_DATA response frame
   * @private
   */
  buildReadResponse(dataId, value) {
    const header = Buffer.alloc(10);
    header[0] = FRAME_CONSTANTS.START_DELIMITER;
    addressToBuffer(this.options.address).copy(header, 1);
    header[7] = FRAME_CONSTANTS.START_DELIMITER;
    header[8] = getResponseCode(CONTROL_CODES.READ_DATA); // 0x91

    // Get metadata for encoding
    const metadata = REGISTER_METADATA[dataId] || { bytes: 4, resolution: 1 };

    // Encode value to BCD
    const rawValue = Math.round(value / metadata.resolution);
    const valueBuffer = this.encodeValueToBcd(rawValue, metadata.bytes);

    // Build data: DI (with offset) + Value (with offset)
    const dataIdBuf = dataIdToBuffer(dataId); // Already has offset applied
    const valueWithOffset = applyOffset(valueBuffer);
    const data = Buffer.concat([dataIdBuf, valueWithOffset]);

    header[9] = data.length;

    const frameWithoutChecksum = Buffer.concat([header, data]);
    return appendChecksum(frameWithoutChecksum);
  }

  /**
   * Encode a numeric value to BCD buffer
   * @private
   */
  encodeValueToBcd(value, bytes) {
    const buffer = Buffer.alloc(bytes);
    let remaining = Math.abs(value);

    for (let i = 0; i < bytes; i++) {
      const twoDigits = remaining % 100;
      const tens = Math.floor(twoDigits / 10);
      const ones = twoDigits % 10;
      buffer[i] = (tens << 4) | ones;
      remaining = Math.floor(remaining / 100);
    }

    return buffer;
  }

  /**
   * Handle WRITE_DATA request
   * @private
   */
  handleWriteRequest(_frame, _parsed) {
    // For simulation, just acknowledge the write
    setTimeout(() => {
      const response = this.buildWriteResponse();
      this.sendFrame(response);
    }, this.options.responseDelay);
  }

  /**
   * Build WRITE_DATA response frame
   * @private
   */
  buildWriteResponse() {
    const header = Buffer.alloc(10);
    header[0] = FRAME_CONSTANTS.START_DELIMITER;
    addressToBuffer(this.options.address).copy(header, 1);
    header[7] = FRAME_CONSTANTS.START_DELIMITER;
    header[8] = getResponseCode(CONTROL_CODES.WRITE_DATA); // 0x94
    header[9] = 0; // No data

    return appendChecksum(header);
  }

  /**
   * Handle RELAY_CONTROL request
   * @private
   */
  handleRelayControl(_frame, _parsed) {
    // Toggle relay state for simulation
    const currentState = this.values[PARAMETER_REGISTERS.RELAY_STATUS.id];
    this.values[PARAMETER_REGISTERS.RELAY_STATUS.id] = currentState === 0 ? 1 : 0;

    setTimeout(() => {
      const response = this.buildRelayResponse();
      this.sendFrame(response);
    }, this.options.responseDelay);
  }

  /**
   * Build RELAY_CONTROL response frame
   * @private
   */
  buildRelayResponse() {
    const header = Buffer.alloc(10);
    header[0] = FRAME_CONSTANTS.START_DELIMITER;
    addressToBuffer(this.options.address).copy(header, 1);
    header[7] = FRAME_CONSTANTS.START_DELIMITER;
    header[8] = getResponseCode(CONTROL_CODES.RELAY_CONTROL); // 0x9C
    header[9] = 0; // No data

    return appendChecksum(header);
  }

  /**
   * Handle READ_ADDRESS request
   * @private
   */
  handleReadAddress(_frame) {
    setTimeout(() => {
      const response = this.buildAddressResponse();
      this.sendFrame(response);
    }, this.options.responseDelay);
  }

  /**
   * Build READ_ADDRESS response frame
   * @private
   */
  buildAddressResponse() {
    const header = Buffer.alloc(10);
    header[0] = FRAME_CONSTANTS.START_DELIMITER;
    addressToBuffer(this.options.address).copy(header, 1);
    header[7] = FRAME_CONSTANTS.START_DELIMITER;
    header[8] = getResponseCode(CONTROL_CODES.READ_ADDRESS); // 0x93

    // Data is the address itself with offset
    const addressData = applyOffset(addressToBuffer(this.options.address));
    header[9] = addressData.length;

    const frameWithoutChecksum = Buffer.concat([header, addressData]);
    return appendChecksum(frameWithoutChecksum);
  }

  /**
   * Send error response
   * @private
   */
  sendErrorResponse(requestCode, errorCode) {
    const header = Buffer.alloc(10);
    header[0] = FRAME_CONSTANTS.START_DELIMITER;
    addressToBuffer(this.options.address).copy(header, 1);
    header[7] = FRAME_CONSTANTS.START_DELIMITER;
    header[8] = getErrorResponseCode(requestCode);
    header[9] = 1;

    const errorData = Buffer.from([(errorCode + 0x33) & 0xff]);
    const frameWithoutChecksum = Buffer.concat([header, errorData]);
    const frame = appendChecksum(frameWithoutChecksum);

    setTimeout(() => {
      this.sendFrame(frame);
    }, this.options.responseDelay);
  }

  /**
   * Send a frame to the server
   * @private
   */
  sendFrame(frame) {
    if (!this.isConnected || !this.socket) {
      return;
    }

    this.socket.write(frame);
    this.framesSent++;
    this.emit(SIMULATOR_EVENTS.FRAME_SENT, { frame });
  }

  /**
   * Set a register value
   * @param {number} dataId - Register data identifier
   * @param {number} value - Value to set
   */
  setValue(dataId, value) {
    this.values[dataId] = value;
  }

  /**
   * Get a register value
   * @param {number} dataId - Register data identifier
   * @returns {number|undefined} Current value
   */
  getValue(dataId) {
    return this.values[dataId];
  }

  /**
   * Set multiple values at once
   * @param {Object} values - Object mapping dataId to value
   */
  setValues(values) {
    Object.assign(this.values, values);
  }

  /**
   * Get all current values
   * @returns {Object} All register values
   */
  getAllValues() {
    return { ...this.values };
  }

  /**
   * Get simulator statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      address: this.options.address,
      isConnected: this.isConnected,
      framesReceived: this.framesReceived,
      framesSent: this.framesSent,
    };
  }

  /**
   * Send an unsolicited telemetry frame (push mode)
   * Useful for testing meter-initiated communication
   * @param {number} dataId - Register to report
   */
  async sendTelemetry(dataId) {
    const value = this.values[dataId];
    if (value === undefined) {
      throw new Error(`Unknown register: 0x${dataId.toString(16)}`);
    }

    const frame = this.buildReadResponse(dataId, value);
    this.sendFrame(frame);
  }
}

/**
 * Create a new meter simulator
 * @param {Object} options - Simulator options
 * @returns {MeterSimulator} New simulator instance
 */
export const createMeterSimulator = (options) => {
  return new MeterSimulator(options);
};

export default {
  MeterSimulator,
  SIMULATOR_EVENTS,
  DEFAULT_METER_VALUES,
  createMeterSimulator,
};
