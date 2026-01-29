/**
 * Heartbeat Handler Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isHeartbeatPacket,
  parseHeartbeatPacket,
  createHeartbeatHandler,
  HEARTBEAT_CONSTANTS,
} from '../../../src/protocol/heartbeat-handler.js';

/**
 * Build a valid 26-byte heartbeat packet
 * @param {string} meterAddress - 12-digit ASCII meter address
 * @param {number} separator - Separator byte (default 0x00)
 * @param {Buffer} crc - 2-byte CRC (default 0x00 0x00)
 */
const buildHeartbeatPacket = (meterAddress = '311501114070', separator = 0x00, crc = Buffer.from([0x00, 0x00])) => {
  const header = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c]);
  const address = Buffer.from(meterAddress, 'ascii');
  const sep = Buffer.from([separator]);
  return Buffer.concat([header, address, sep, crc]);
};

describe('Heartbeat Handler', () => {
  describe('isHeartbeatPacket', () => {
    it('should return true for valid heartbeat packet', () => {
      const packet = buildHeartbeatPacket();
      expect(isHeartbeatPacket(packet)).toBe(true);
    });

    it('should return false for DLT645 frame (starts with 0x68)', () => {
      const dlt645 = Buffer.alloc(26, 0);
      dlt645[0] = 0x68;
      expect(isHeartbeatPacket(dlt645)).toBe(false);
    });

    it('should return false for buffer shorter than 26 bytes', () => {
      const short = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00]);
      expect(isHeartbeatPacket(short)).toBe(false);
    });

    it('should return false for wrong header bytes', () => {
      const packet = buildHeartbeatPacket();
      packet[3] = 0xff; // Corrupt header
      expect(isHeartbeatPacket(packet)).toBe(false);
    });

    it('should return false for null/undefined input', () => {
      expect(isHeartbeatPacket(null)).toBe(false);
      expect(isHeartbeatPacket(undefined)).toBe(false);
    });

    it('should return false for non-Buffer input', () => {
      expect(isHeartbeatPacket('not a buffer')).toBe(false);
      expect(isHeartbeatPacket(42)).toBe(false);
    });

    it('should return true for packet longer than 26 bytes (extra trailing data)', () => {
      const packet = buildHeartbeatPacket();
      const extended = Buffer.concat([packet, Buffer.from([0x68, 0x00])]);
      expect(isHeartbeatPacket(extended)).toBe(true);
    });
  });

  describe('parseHeartbeatPacket', () => {
    it('should extract correct meter address', () => {
      const packet = buildHeartbeatPacket('311501114070');
      const result = parseHeartbeatPacket(packet);

      expect(result.valid).toBe(true);
      expect(result.meterAddress).toBe('311501114070');
    });

    it('should handle zero address', () => {
      const packet = buildHeartbeatPacket('000000000000');
      const result = parseHeartbeatPacket(packet);

      expect(result.valid).toBe(true);
      expect(result.meterAddress).toBe('000000000000');
    });

    it('should extract separator byte', () => {
      const packet = buildHeartbeatPacket('311501114070', 0x2c);
      const result = parseHeartbeatPacket(packet);

      expect(result.valid).toBe(true);
      expect(result.separator).toBe(0x2c);
    });

    it('should extract CRC bytes', () => {
      const crc = Buffer.from([0xab, 0xcd]);
      const packet = buildHeartbeatPacket('311501114070', 0x00, crc);
      const result = parseHeartbeatPacket(packet);

      expect(result.valid).toBe(true);
      expect(result.crc).toEqual(crc);
    });

    it('should return raw packet data', () => {
      const packet = buildHeartbeatPacket('311501114070');
      const result = parseHeartbeatPacket(packet);

      expect(result.valid).toBe(true);
      expect(result.raw).toEqual(packet);
      expect(result.raw.length).toBe(HEARTBEAT_CONSTANTS.PACKET_LENGTH);
    });

    it('should return invalid for non-heartbeat data', () => {
      const dlt645 = Buffer.alloc(26, 0x68);
      const result = parseHeartbeatPacket(dlt645);

      expect(result.valid).toBe(false);
      expect(result.meterAddress).toBeNull();
    });

    it('should only capture first 26 bytes as raw when buffer is longer', () => {
      const packet = buildHeartbeatPacket('311501114070');
      const extended = Buffer.concat([packet, Buffer.from([0x68, 0x01, 0x02])]);
      const result = parseHeartbeatPacket(extended);

      expect(result.valid).toBe(true);
      expect(result.raw.length).toBe(26);
    });
  });

  describe('HeartbeatHandler', () => {
    let handler;

    beforeEach(() => {
      handler = createHeartbeatHandler();
    });

    describe('handleData', () => {
      it('should consume heartbeat packet and return parsed data', () => {
        const packet = buildHeartbeatPacket('311501114070');
        const result = handler.handleData(packet);

        expect(result.consumed).toBe(26);
        expect(result.heartbeat).not.toBeNull();
        expect(result.heartbeat.valid).toBe(true);
        expect(result.heartbeat.meterAddress).toBe('311501114070');
      });

      it('should return consumed=0 for non-heartbeat data', () => {
        const dlt645 = Buffer.from([0x68, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x68]);
        const result = handler.handleData(dlt645);

        expect(result.consumed).toBe(0);
        expect(result.heartbeat).toBeNull();
      });

      it('should only consume 26 bytes from mixed data', () => {
        const heartbeat = buildHeartbeatPacket('311501114070');
        const dlt645Tail = Buffer.from([0x68, 0x12, 0x34]);
        const mixed = Buffer.concat([heartbeat, dlt645Tail]);

        const result = handler.handleData(mixed);

        expect(result.consumed).toBe(26);
        expect(result.heartbeat.valid).toBe(true);
      });
    });

    describe('resolveMeterId', () => {
      it('should return meter address as-is for non-zero address', () => {
        const heartbeat = parseHeartbeatPacket(buildHeartbeatPacket('311501114070'));
        const connection = { remoteAddress: '10.0.0.1', remotePort: 45000 };

        const meterId = handler.resolveMeterId(heartbeat, connection);
        expect(meterId).toBe('311501114070');
      });

      it('should return zero address when zeroAddressAction is accept (default)', () => {
        const heartbeat = parseHeartbeatPacket(buildHeartbeatPacket('000000000000'));
        const connection = { remoteAddress: '10.0.0.1', remotePort: 45000 };

        const meterId = handler.resolveMeterId(heartbeat, connection);
        expect(meterId).toBe('000000000000');
      });

      it('should generate IP-based ID when zeroAddressAction is use_ip', () => {
        const ipHandler = createHeartbeatHandler({ zeroAddressAction: 'use_ip' });
        const heartbeat = parseHeartbeatPacket(buildHeartbeatPacket('000000000000'));
        const connection = { remoteAddress: '10.0.0.1', remotePort: 45000 };

        const meterId = ipHandler.resolveMeterId(heartbeat, connection);
        expect(meterId).toBe('auto_10_0_0_1_45000');
      });

      it('should not use IP fallback for non-zero address even with use_ip setting', () => {
        const ipHandler = createHeartbeatHandler({ zeroAddressAction: 'use_ip' });
        const heartbeat = parseHeartbeatPacket(buildHeartbeatPacket('311501114070'));
        const connection = { remoteAddress: '10.0.0.1', remotePort: 45000 };

        const meterId = ipHandler.resolveMeterId(heartbeat, connection);
        expect(meterId).toBe('311501114070');
      });
    });

    describe('buildAckResponse', () => {
      it('should return null when ACK is not enabled', () => {
        expect(handler.buildAckResponse()).toBeNull();
      });

      it('should return null when enabled but no payload', () => {
        const ackHandler = createHeartbeatHandler({ ackEnabled: true, ackPayload: '' });
        expect(ackHandler.buildAckResponse()).toBeNull();
      });

      it('should return buffer from hex payload when enabled', () => {
        const ackHandler = createHeartbeatHandler({
          ackEnabled: true,
          ackPayload: '0102030405',
        });
        const ack = ackHandler.buildAckResponse();

        expect(ack).not.toBeNull();
        expect(ack).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
      });
    });
  });

  describe('HEARTBEAT_CONSTANTS', () => {
    it('should have correct packet length', () => {
      expect(HEARTBEAT_CONSTANTS.PACKET_LENGTH).toBe(26);
    });

    it('should have correct header length', () => {
      expect(HEARTBEAT_CONSTANTS.HEADER_LENGTH).toBe(11);
    });

    it('should have correct header bytes', () => {
      expect(HEARTBEAT_CONSTANTS.HEADER_BYTES).toEqual(
        Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x12, 0x0a, 0x02, 0x0c])
      );
    });

    it('should have correct address offset and length', () => {
      expect(HEARTBEAT_CONSTANTS.ADDRESS_OFFSET).toBe(11);
      expect(HEARTBEAT_CONSTANTS.ADDRESS_LENGTH).toBe(12);
    });
  });
});
