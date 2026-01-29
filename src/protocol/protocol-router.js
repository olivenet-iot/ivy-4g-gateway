/**
 * Protocol Router
 *
 * Detects the protocol type from the first data received on a TCP connection
 * and routes subsequent data to the appropriate parser.
 *
 * Supported protocols:
 * - DLT645: Traditional Chinese energy meter protocol (starts with 0x68)
 * - IVY_DLMS: IVY EM114070 proprietary wrapper containing DLMS/COSEM or heartbeat
 *
 * @module protocol/protocol-router
 */

import { createStreamParser } from './frame-parser.js';
import { createIvyStreamParser, IVY_DESTINATIONS, RAW_DLMS_TAGS } from './ivy-wrapper.js';
import { isHeartbeatPacket, parseHeartbeatPacket } from './heartbeat-handler.js';
import { parseApdu, extractTelemetry } from './dlms/apdu-parser.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'protocol-router' });

/**
 * Protocol types
 */
export const PROTOCOL_TYPES = {
  DLT645: 'dlt645',
  IVY_DLMS: 'ivy_dlms',
  UNKNOWN: 'unknown',
};

/**
 * Detect protocol type from first data bytes
 *
 * @param {Buffer} buffer - First data from connection
 * @returns {string} Protocol type constant
 */
export const detectProtocol = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) {
    return PROTOCOL_TYPES.UNKNOWN;
  }

  // DLT645 frames always start with 0x68
  if (buffer[0] === 0x68) {
    return PROTOCOL_TYPES.DLT645;
  }

  // IVY wrapper starts with 00 01 00 01
  if (buffer.length >= 4 &&
      buffer[0] === 0x00 && buffer[1] === 0x01 &&
      buffer[2] === 0x00 && buffer[3] === 0x01) {
    return PROTOCOL_TYPES.IVY_DLMS;
  }

  // Raw DLMS APDU (unwrapped) - treat as IVY_DLMS protocol
  if (RAW_DLMS_TAGS.has(buffer[0])) {
    return PROTOCOL_TYPES.IVY_DLMS;
  }

  return PROTOCOL_TYPES.UNKNOWN;
};

/**
 * Create a protocol router
 *
 * Routes incoming TCP data to the appropriate parser based on auto-detected
 * protocol type. Once the protocol is detected from the first data, all
 * subsequent data uses the same parser.
 *
 * @param {Object} callbacks - Event callbacks
 * @param {Function} callbacks.onHeartbeat - (heartbeat) => void
 * @param {Function} callbacks.onDlt645Frame - (parsed, frame) => void
 * @param {Function} [callbacks.onDlt645Error] - (error, frame) => void
 * @param {Function} [callbacks.onDlmsApdu] - (parsedApdu, telemetry, raw) => void
 * @param {Function} [callbacks.onDlmsError] - (error) => void
 * @param {Function} [callbacks.onProtocolDetected] - (protocolType) => void
 * @returns {Object} Router with push(), reset(), getProtocol() methods
 */
export const createProtocolRouter = (callbacks = {}) => {
  let detectedProtocol = null;
  let dlt645Parser = null;
  let ivyParser = null;

  const {
    onHeartbeat,
    onDlt645Frame,
    onDlt645Error = null,
    onDlmsApdu = null,
    onDlmsError = null,
    onProtocolDetected = null,
  } = callbacks;

  /**
   * Handle DLMS payload (shared by content-based and legacy routing)
   */
  const handleDlmsPayload = (header, payload, raw) => {
    if (payload.length > 0 && onDlmsApdu) {
      try {
        const parsed = parseApdu(payload);
        const telemetry = extractTelemetry(parsed);

        const logData = {
          tag: `0x${parsed.tag.toString(16)}`,
          type: parsed.type,
          payloadLength: payload.length,
          rawDlms: !!header.isRawDlms,
        };
        if (parsed.type === 'get-response') {
          logData.invokeId = parsed.invokeId;
          logData.accessResult = parsed.accessResult;
          if (parsed.accessResult === 'error') {
            logData.errorCode = parsed.data?.errorCode;
            logData.errorName = parsed.data?.errorName;
          } else if (parsed.accessResult === 'success' && parsed.data) {
            logData.dataType = parsed.data.typeName;
            logData.dataValue = parsed.data.value;
          }
          logData.hex = payload.toString('hex');
        } else if (parsed.type === 'event-notification') {
          logData.obisCode = parsed.obisCode;
          logData.classId = parsed.classId;
        }
        logger.debug('DLMS APDU received', logData);

        onDlmsApdu(parsed, telemetry, raw);
      } catch (err) {
        logger.warn('DLMS APDU parse error', { error: err.message });
        if (onDlmsError) {
          onDlmsError(err);
        }
      }
    }
  };

  /**
   * Handle a complete IVY packet
   *
   * Destination 0x0001 is shared between heartbeats and DLMS responses,
   * so we use content-based routing: heartbeat has a rigid 11-byte signature
   * (payload starts with 0x0a), while DLMS APDUs start with known tags
   * (0x61, 0xC4, 0xD8, etc.) — no collision risk.
   */
  const handleIvyPacket = (header, payload, raw) => {
    if (header.destination === IVY_DESTINATIONS.HEARTBEAT) {
      // dest=0x0001: content-based routing (heartbeat vs DLMS)
      if (isHeartbeatPacket(raw)) {
        const heartbeat = parseHeartbeatPacket(raw);
        if (heartbeat.valid && onHeartbeat) {
          onHeartbeat(heartbeat);
        }
      } else if (payload.length > 0 && RAW_DLMS_TAGS.has(payload[0])) {
        // DLMS APDU arriving at dest=0x0001
        handleDlmsPayload(header, payload, raw);
      } else {
        logger.debug('IVY packet at dest=0x0001 with unknown payload', {
          payloadLength: payload.length,
          hex: raw.toString('hex').substring(0, 60),
        });
      }
    } else if (header.destination >= 0x0010) {
      // DLMS APDU at legacy destination (backward compat)
      handleDlmsPayload(header, payload, raw);
    } else {
      logger.debug('IVY packet with unknown destination', {
        destination: `0x${header.destination.toString(16)}`,
        payloadLength: payload.length,
      });
    }
  };

  /**
   * Initialize the DLT645 parser
   */
  const initDlt645Parser = () => {
    dlt645Parser = createStreamParser(
      (parsed, frame) => {
        if (onDlt645Frame) {
          onDlt645Frame(parsed, frame);
        }
      },
      (error, frame) => {
        if (onDlt645Error) {
          onDlt645Error(error, frame);
        }
      }
    );
  };

  /**
   * Initialize the IVY/DLMS parser
   */
  const initIvyParser = () => {
    ivyParser = createIvyStreamParser(handleIvyPacket, (error) => {
      logger.debug('IVY stream parse error', { error: error.message });
      if (onDlmsError) {
        onDlmsError(error);
      }
    });
  };

  const router = {
    /**
     * Push data into the router
     * On first call, detects protocol and initializes appropriate parser.
     *
     * @param {Buffer} data - Incoming TCP data
     */
    push(data) {
      if (!detectedProtocol) {
        detectedProtocol = detectProtocol(data);

        logger.info('Protocol detected', {
          protocol: detectedProtocol,
          firstByte: `0x${data[0].toString(16)}`,
          dataLength: data.length,
        });

        if (onProtocolDetected) {
          onProtocolDetected(detectedProtocol);
        }

        if (detectedProtocol === PROTOCOL_TYPES.DLT645) {
          initDlt645Parser();
        } else if (detectedProtocol === PROTOCOL_TYPES.IVY_DLMS) {
          initIvyParser();
        }
      }

      // Route to the appropriate parser
      if (detectedProtocol === PROTOCOL_TYPES.DLT645 && dlt645Parser) {
        dlt645Parser.push(data);
      } else if (detectedProtocol === PROTOCOL_TYPES.IVY_DLMS && ivyParser) {
        ivyParser.push(data);
      } else {
        logger.debug('Discarding data for unknown protocol', {
          protocol: detectedProtocol,
          dataLength: data.length,
        });
      }
    },

    /**
     * Reset the router state
     */
    reset() {
      detectedProtocol = null;
      dlt645Parser = null;
      ivyParser = null;
    },

    /**
     * Get the detected protocol type
     * @returns {string|null}
     */
    getProtocol() {
      return detectedProtocol;
    },
  };

  return router;
};

export default {
  PROTOCOL_TYPES,
  detectProtocol,
  createProtocolRouter,
};
