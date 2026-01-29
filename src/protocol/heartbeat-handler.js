/**
 * IVY EM114070 Heartbeat Packet Handler
 *
 * The IVY EM114070 meter sends a proprietary 26-byte heartbeat/registration
 * packet upon TCP connection. This module detects and parses those packets,
 * extracting the meter address so the connection can be identified before
 * any DLT645 frames arrive.
 *
 * Heartbeat structure (26 bytes):
 *   [0-10]  Header: 00 01 00 01 00 01 00 12 0a 02 0c  (11 bytes)
 *   [11-22] Meter address as ASCII digits             (12 bytes)
 *   [23]    Separator byte                            (1 byte)
 *   [24-25] CRC / trailer                            (2 bytes)
 *
 * @module protocol/heartbeat-handler
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';

const logger = createChildLogger({ module: 'heartbeat-handler' });

/**
 * Heartbeat packet constants
 */
export const HEARTBEAT_CONSTANTS = {
  PACKET_LENGTH: 26,
  HEADER_LENGTH: 11,
  ADDRESS_OFFSET: 11,
  ADDRESS_LENGTH: 12,
  SEPARATOR_OFFSET: 23,
  CRC_OFFSET: 24,
  CRC_LENGTH: 2,
  HEADER_BYTES: Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c]),
};

/**
 * Check if a buffer starts with the heartbeat packet signature
 *
 * @param {Buffer} buffer - Incoming data buffer
 * @returns {boolean} True if buffer matches heartbeat signature
 */
export const isHeartbeatPacket = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEARTBEAT_CONSTANTS.PACKET_LENGTH) {
    return false;
  }

  // First byte must not be 0x68 (DLT645 start delimiter)
  // and must match the known header
  for (let i = 0; i < HEARTBEAT_CONSTANTS.HEADER_LENGTH; i++) {
    if (buffer[i] !== HEARTBEAT_CONSTANTS.HEADER_BYTES[i]) {
      return false;
    }
  }

  return true;
};

/**
 * Parse a heartbeat packet and extract fields
 *
 * @param {Buffer} buffer - Buffer containing heartbeat packet (>= 26 bytes)
 * @returns {Object} Parsed heartbeat with { valid, meterAddress, separator, crc, raw }
 */
export const parseHeartbeatPacket = (buffer) => {
  if (!isHeartbeatPacket(buffer)) {
    return { valid: false, meterAddress: null, separator: null, crc: null, raw: null };
  }

  const addressBytes = buffer.subarray(
    HEARTBEAT_CONSTANTS.ADDRESS_OFFSET,
    HEARTBEAT_CONSTANTS.ADDRESS_OFFSET + HEARTBEAT_CONSTANTS.ADDRESS_LENGTH
  );
  const meterAddress = addressBytes.toString('ascii');

  const separator = buffer[HEARTBEAT_CONSTANTS.SEPARATOR_OFFSET];
  const crc = buffer.subarray(
    HEARTBEAT_CONSTANTS.CRC_OFFSET,
    HEARTBEAT_CONSTANTS.CRC_OFFSET + HEARTBEAT_CONSTANTS.CRC_LENGTH
  );

  const raw = Buffer.from(buffer.subarray(0, HEARTBEAT_CONSTANTS.PACKET_LENGTH));

  return {
    valid: true,
    meterAddress,
    separator,
    crc: Buffer.from(crc),
    raw,
  };
};

/**
 * HeartbeatHandler class
 * Manages heartbeat detection and meter identification from heartbeat packets
 */
export class HeartbeatHandler extends EventEmitter {
  /**
   * @param {Object} options - Configuration options
   * @param {boolean} [options.ackEnabled=false] - Send ACK after heartbeat
   * @param {string} [options.ackPayload=''] - ACK payload (hex string)
   * @param {string} [options.zeroAddressAction='accept'] - Action for zero address: 'accept' or 'use_ip'
   */
  constructor(options = {}) {
    super();

    const heartbeatConfig = config.heartbeat || {};

    this.options = {
      ackEnabled: options.ackEnabled ?? heartbeatConfig.ackEnabled ?? false,
      ackPayload: options.ackPayload ?? heartbeatConfig.ackPayload ?? '',
      zeroAddressAction: options.zeroAddressAction ?? heartbeatConfig.zeroAddressAction ?? 'accept',
    };

    logger.debug('HeartbeatHandler created', { options: this.options });
  }

  /**
   * Check if incoming data is a heartbeat packet and consume it
   *
   * @param {Buffer} data - Incoming TCP data
   * @returns {Object} { consumed: number, heartbeat: Object|null }
   */
  handleData(data) {
    if (!isHeartbeatPacket(data)) {
      return { consumed: 0, heartbeat: null };
    }

    const heartbeat = parseHeartbeatPacket(data);
    return {
      consumed: HEARTBEAT_CONSTANTS.PACKET_LENGTH,
      heartbeat,
    };
  }

  /**
   * Resolve a meter ID from a heartbeat packet
   * If the address is all zeros and zeroAddressAction is 'use_ip', generates a synthetic ID.
   *
   * @param {Object} heartbeat - Parsed heartbeat from parseHeartbeatPacket()
   * @param {Object} connection - Connection object with remoteAddress and remotePort
   * @returns {string} Resolved meter ID
   */
  resolveMeterId(heartbeat, connection) {
    const address = heartbeat.meterAddress;

    if (address === '000000000000' && this.options.zeroAddressAction === 'use_ip') {
      const ip = (connection.remoteAddress || 'unknown').replace(/[.:]/g, '_');
      const port = connection.remotePort || 0;
      return `auto_${ip}_${port}`;
    }

    return address;
  }

  /**
   * Build an ACK response buffer if configured
   *
   * @returns {Buffer|null} ACK buffer or null if not enabled
   */
  buildAckResponse() {
    if (!this.options.ackEnabled || !this.options.ackPayload) {
      return null;
    }

    try {
      return Buffer.from(this.options.ackPayload, 'hex');
    } catch (error) {
      logger.warn('Invalid ACK payload', { payload: this.options.ackPayload, error: error.message });
      return null;
    }
  }
}

/**
 * Create a new HeartbeatHandler instance
 *
 * @param {Object} [options] - Configuration options
 * @returns {HeartbeatHandler} New instance
 */
export const createHeartbeatHandler = (options) => {
  return new HeartbeatHandler(options);
};

export default {
  HeartbeatHandler,
  HEARTBEAT_CONSTANTS,
  isHeartbeatPacket,
  parseHeartbeatPacket,
  createHeartbeatHandler,
};
