/**
 * TCP Server for DLT645 Energy Meters
 *
 * Listens on configured port (default 8899) for incoming
 * connections from 4G energy meters. Integrates with
 * ConnectionManager for connection lifecycle management.
 *
 * @module tcp/server
 */

import net from 'net';
import { EventEmitter } from 'events';
import {
  createConnectionManager,
  CONNECTION_EVENTS,
} from './connection-manager.js';
import {
  parseFrame,
  parseReadResponse,
  parseErrorResponse,
} from '../protocol/frame-parser.js';
import { findRegisterById } from '../protocol/registers.js';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';

const logger = createChildLogger({ module: 'tcp-server' });

/**
 * TCP Server events
 */
export const SERVER_EVENTS = {
  SERVER_STARTED: 'server:started',
  SERVER_STOPPED: 'server:stopped',
  SERVER_ERROR: 'server:error',
  METER_CONNECTED: 'meter:connected',
  METER_DISCONNECTED: 'meter:disconnected',
  TELEMETRY_RECEIVED: 'telemetry:received',
  COMMAND_RESPONSE: 'command:response',
  ERROR_RESPONSE: 'error:response',
  HEARTBEAT_RECEIVED: 'heartbeat:received',
  DLMS_TELEMETRY_RECEIVED: 'dlms:telemetry:received',
  DLMS_EVENT_RECEIVED: 'dlms:event:received',
  DLMS_ERROR_RECEIVED: 'dlms:error:received',
};

/**
 * TCP Server class
 * Manages the TCP server and integrates with ConnectionManager
 */
export class TCPServer extends EventEmitter {
  /**
   * @param {Object} options - Server options
   * @param {string} [options.host='0.0.0.0'] - Bind host
   * @param {number} [options.port=8899] - Listen port
   * @param {Object} [options.connectionManagerOptions] - Options for ConnectionManager
   */
  constructor(options = {}) {
    super();

    this.options = {
      host: options.host || config.tcp.host || '0.0.0.0',
      port: options.port || config.tcp.port || 8899,
      connectionManagerOptions: options.connectionManagerOptions || {},
    };

    /** @type {net.Server|null} */
    this.server = null;

    /** @type {ConnectionManager} */
    this.connectionManager = createConnectionManager(this.options.connectionManagerOptions);

    /** @type {boolean} */
    this.isRunning = false;

    // Setup connection manager event forwarding
    this.setupConnectionManagerEvents();

    logger.info('TCPServer created', { options: this.options });
  }

  /**
   * Setup event forwarding from ConnectionManager
   * @private
   */
  setupConnectionManagerEvents() {
    // Forward connection events
    this.connectionManager.on(CONNECTION_EVENTS.CONNECTION_IDENTIFIED, (data) => {
      this.emit(SERVER_EVENTS.METER_CONNECTED, data);
    });

    this.connectionManager.on(CONNECTION_EVENTS.CONNECTION_CLOSED, (data) => {
      if (data.meterId) {
        this.emit(SERVER_EVENTS.METER_DISCONNECTED, data);
      }
    });

    // Forward heartbeat events
    this.connectionManager.on(CONNECTION_EVENTS.HEARTBEAT_RECEIVED, (data) => {
      this.emit(SERVER_EVENTS.HEARTBEAT_RECEIVED, data);
    });

    // Handle received frames
    this.connectionManager.on(CONNECTION_EVENTS.FRAME_RECEIVED, ({ connectionId, meterId, frame }) => {
      this.handleFrame(connectionId, meterId, frame);
    });

    // Handle DLMS data from IVY/DLMS meters
    this.connectionManager.on(CONNECTION_EVENTS.DLMS_RECEIVED, ({ connectionId, meterId, parsedApdu, telemetry }) => {
      this.handleDlmsData(connectionId, meterId, parsedApdu, telemetry);
    });
  }

  /**
   * Start the TCP server
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      logger.warn('TCP Server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error) => {
        logger.error('TCP Server error', { error: error.message });
        this.emit(SERVER_EVENTS.SERVER_ERROR, { error });

        if (!this.isRunning) {
          reject(error);
        }
      });

      this.server.on('close', () => {
        logger.info('TCP Server closed');
        this.isRunning = false;
      });

      this.server.listen(this.options.port, this.options.host, () => {
        this.isRunning = true;
        this.connectionManager.start();

        const address = this.server.address();
        logger.info('TCP Server started', {
          host: address.address,
          port: address.port,
        });

        this.emit(SERVER_EVENTS.SERVER_STARTED, {
          host: address.address,
          port: address.port,
        });

        resolve();
      });
    });
  }

  /**
   * Stop the TCP server
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping TCP Server...');

    // Stop connection manager first (closes all connections)
    await this.connectionManager.stop();

    // Close server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.isRunning = false;
          logger.info('TCP Server stopped');
          this.emit(SERVER_EVENTS.SERVER_STOPPED, {});
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle new incoming connection
   * @private
   * @param {net.Socket} socket - New socket
   */
  handleConnection(socket) {
    logger.debug('New connection', {
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
    });

    this.connectionManager.registerConnection(socket);
  }

  /**
   * Handle received frame from a connection
   * @private
   * @param {string} connectionId - Connection ID
   * @param {string|null} meterId - Meter ID (if identified)
   * @param {Buffer} frame - Complete DLT645 frame
   */
  handleFrame(connectionId, meterId, frame) {
    try {
      const parsed = parseFrame(frame);

      // If connection not yet identified, try to identify from frame
      if (!meterId && parsed.address) {
        this.connectionManager.identifyConnection(connectionId, parsed.address);
        meterId = parsed.address;
      }

      if (parsed.isError) {
        // Handle error response
        const errorResult = parseErrorResponse(frame);
        this.handleErrorResponse(connectionId, meterId, errorResult);
      } else {
        // Handle success response
        const telemetry = parseReadResponse(frame);
        this.handleSuccessResponse(connectionId, meterId, telemetry);
      }
    } catch (error) {
      // Parse error - invalid frame
      logger.warn('Frame parse error', {
        connectionId,
        meterId,
        error: error.message,
      });
    }
  }

  /**
   * Handle successful response frame
   * @private
   * @param {string} connectionId - Connection ID
   * @param {string|null} meterId - Meter ID
   * @param {Object} result - Parsed telemetry result
   */
  handleSuccessResponse(connectionId, meterId, result) {
    if (!result.success) {
      logger.warn('Telemetry parse failed', {
        connectionId,
        meterId,
      });
      return;
    }

    const register = result.register || findRegisterById(result.dataId);

    logger.debug('Telemetry received', {
      connectionId,
      meterId,
      dataId: result.dataIdHex,
      value: result.value,
      unit: result.unit,
    });

    this.emit(SERVER_EVENTS.TELEMETRY_RECEIVED, {
      connectionId,
      meterId,
      dataId: result.dataId,
      dataIdFormatted: result.dataIdHex,
      register,
      value: result.value,
      rawValue: result.rawValue,
      unit: result.unit,
      timestamp: Date.now(),
    });

    // Check for pending command
    const connection = this.connectionManager.getConnection(connectionId);
    if (connection) {
      this.resolvePendingCommand(connection, result);
    }
  }

  /**
   * Handle error response frame
   * @private
   * @param {string} connectionId - Connection ID
   * @param {string|null} meterId - Meter ID
   * @param {Object} result - Parsed error result
   */
  handleErrorResponse(connectionId, meterId, result) {
    logger.warn('Error response received', {
      connectionId,
      meterId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });

    this.emit(SERVER_EVENTS.ERROR_RESPONSE, {
      connectionId,
      meterId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      controlCode: result.controlCode,
      timestamp: Date.now(),
    });

    // Reject pending command
    const connection = this.connectionManager.getConnection(connectionId);
    if (connection) {
      this.rejectPendingCommand(connection, result);
    }
  }

  /**
   * Resolve a pending command with successful response
   * @private
   * @param {Object} connection - Connection object
   * @param {Object} result - Parsed result
   */
  resolvePendingCommand(connection, result) {
    // Find matching pending command by dataId
    for (const [cmdId, pending] of connection.pendingCommands) {
      if (pending.dataId === result.dataId) {
        clearTimeout(pending.timeout);
        pending.resolve(result);
        connection.pendingCommands.delete(cmdId);
        break;
      }
    }
  }

  /**
   * Reject a pending command with error response
   * @private
   * @param {Object} connection - Connection object
   * @param {Object} result - Parsed error result
   */
  rejectPendingCommand(connection, result) {
    // Find and reject first pending command (FIFO)
    const entry = connection.pendingCommands.entries().next().value;
    if (entry) {
      const [cmdId, pending] = entry;
      clearTimeout(pending.timeout);
      pending.reject(new Error(result.errorMessage || 'Command failed'));
      connection.pendingCommands.delete(cmdId);
    }
  }

  /**
   * Handle DLMS data received from IVY/DLMS meter
   * @private
   * @param {string} connectionId - Connection ID
   * @param {string|null} meterId - Meter ID (if identified)
   * @param {Object} parsedApdu - Parsed DLMS APDU
   * @param {Object|null} telemetry - Extracted telemetry data
   */
  handleDlmsData(connectionId, meterId, parsedApdu, telemetry) {
    if (!parsedApdu) return;

    const apduType = parsedApdu.type;

    if (apduType === 'event-notification' || apduType === 'data-notification') {
      // Telemetry-bearing APDUs
      if (telemetry && telemetry.readings && Object.keys(telemetry.readings).length > 0) {
        this.emit(SERVER_EVENTS.DLMS_TELEMETRY_RECEIVED, {
          connectionId,
          meterId,
          source: 'dlms',
          apduType,
          telemetry,
          timestamp: Date.now(),
        });
      }

      // Events (EventNotification with event OBIS codes)
      if (apduType === 'event-notification' && parsedApdu.obisInfo?.category === 'events') {
        this.emit(SERVER_EVENTS.DLMS_EVENT_RECEIVED, {
          connectionId,
          meterId,
          source: 'dlms',
          eventType: parsedApdu.obisInfo?.key || parsedApdu.obisCode || 'unknown',
          data: parsedApdu,
          timestamp: Date.now(),
        });
      }

      // Also emit as telemetry event for each reading
      if (telemetry && telemetry.readings) {
        for (const [key, reading] of Object.entries(telemetry.readings)) {
          this.emit(SERVER_EVENTS.TELEMETRY_RECEIVED, {
            connectionId,
            meterId,
            source: 'dlms',
            register: { key, name: reading.obis || key },
            dataIdFormatted: reading.obis || key,
            value: reading.value,
            unit: reading.unit || '',
            timestamp: Date.now(),
          });
        }
      }
    } else if (apduType === 'get-response') {
      if (parsedApdu.accessResult === 'success') {
        // Emit COMMAND_RESPONSE for pending command resolution
        const connection = this.connectionManager.getConnection(connectionId);
        if (connection) {
          this.emit(SERVER_EVENTS.COMMAND_RESPONSE, {
            connectionId,
            meterId,
            source: 'dlms',
            invokeId: parsedApdu.invokeId,
            data: parsedApdu.data,
          });
        }
        // Emit DLMS_TELEMETRY_RECEIVED for MQTT publishing
        this.emit(SERVER_EVENTS.DLMS_TELEMETRY_RECEIVED, {
          connectionId,
          meterId,
          source: 'dlms',
          apduType: 'get-response',
          invokeId: parsedApdu.invokeId,
          telemetry: {
            source: 'dlms',
            type: 'get-response',
            data: parsedApdu.data,
            readings: {},
          },
          timestamp: Date.now(),
        });
      } else if (parsedApdu.accessResult === 'error') {
        logger.warn('DLMS GET.response error', {
          connectionId,
          meterId,
          invokeId: parsedApdu.invokeId,
          errorCode: parsedApdu.data?.errorCode,
          errorName: parsedApdu.data?.errorName,
        });
        this.emit(SERVER_EVENTS.DLMS_ERROR_RECEIVED, {
          connectionId,
          meterId,
          source: 'dlms',
          apduType: 'get-response',
          invokeId: parsedApdu.invokeId,
          errorCode: parsedApdu.data?.errorCode,
          errorName: parsedApdu.data?.errorName,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Send a command to a meter and wait for response
   *
   * @param {string} meterId - 12-digit meter address
   * @param {Buffer} frame - Command frame to send
   * @param {number} [dataId] - Expected response data ID (for matching)
   * @param {number} [timeout=10000] - Response timeout in ms
   * @returns {Promise<Object>} Parsed response
   */
  async sendCommand(meterId, frame, dataId = null, timeout = 10000) {
    const connection = this.connectionManager.getConnectionByMeter(meterId);
    if (!connection) {
      throw new Error(`Meter not connected: ${meterId}`);
    }

    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise((resolve, reject) => {
      // Setup timeout
      const timeoutHandle = setTimeout(() => {
        connection.pendingCommands.delete(commandId);
        reject(new Error(`Command timeout after ${timeout}ms`));
      }, timeout);

      // Store pending command
      connection.pendingCommands.set(commandId, {
        dataId,
        resolve,
        reject,
        timeout: timeoutHandle,
        sentAt: Date.now(),
      });

      // Send frame
      this.connectionManager.send(connection.id, frame)
        .catch((error) => {
          clearTimeout(timeoutHandle);
          connection.pendingCommands.delete(commandId);
          reject(error);
        });
    });
  }

  /**
   * Send a command without waiting for response
   *
   * @param {string} meterId - 12-digit meter address
   * @param {Buffer} frame - Command frame to send
   * @returns {Promise<boolean>} Send success
   */
  async sendCommandNoWait(meterId, frame) {
    return this.connectionManager.sendToMeter(meterId, frame);
  }

  /**
   * Get list of connected meter IDs
   * @returns {string[]} Array of meter IDs
   */
  getConnectedMeters() {
    return this.connectionManager.getConnectedMeterIds();
  }

  /**
   * Check if a meter is connected
   * @param {string} meterId - Meter ID
   * @returns {boolean} Is connected
   */
  isMeterConnected(meterId) {
    return this.connectionManager.isMeterConnected(meterId);
  }

  /**
   * Get server statistics
   * @returns {Object} Server and connection stats
   */
  getStats() {
    const connectionStats = this.connectionManager.getStats();

    return {
      server: {
        isRunning: this.isRunning,
        host: this.options.host,
        port: this.options.port,
      },
      connections: connectionStats,
    };
  }

  /**
   * Get connection info for a meter
   * @param {string} meterId - Meter ID
   * @returns {Object|null} Connection info
   */
  getMeterConnectionInfo(meterId) {
    const connection = this.connectionManager.getConnectionByMeter(meterId);
    if (!connection) {
      return null;
    }
    return this.connectionManager.getConnectionInfo(connection.id);
  }

  /**
   * Get all connection infos
   * @returns {Object[]} Array of connection infos
   */
  getAllConnectionInfos() {
    return this.connectionManager.getAllConnectionInfos();
  }
}

// Singleton instance
let instance = null;

/**
 * Get singleton instance of TCPServer
 * @param {Object} [options] - Options (only used on first call)
 * @returns {TCPServer} Singleton instance
 */
export const getInstance = (options) => {
  if (!instance) {
    instance = new TCPServer(options);
  }
  return instance;
};

/**
 * Create a new TCPServer instance
 * @param {Object} [options] - Server options
 * @returns {TCPServer} New instance
 */
export const createTCPServer = (options) => {
  return new TCPServer(options);
};

/**
 * Reset singleton instance (for testing)
 */
export const resetInstance = async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
};

export default {
  TCPServer,
  SERVER_EVENTS,
  getInstance,
  createTCPServer,
  resetInstance,
};
