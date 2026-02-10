/**
 * TCP Connection Manager
 *
 * Manages TCP connections from 4G energy meters.
 * Handles connection lifecycle, state management, and heartbeat monitoring.
 *
 * Features:
 * - Connection registration and tracking
 * - Meter address association
 * - Activity monitoring and timeouts
 * - Stream parser per connection
 * - Event emission for connection events
 *
 * @module tcp/connection-manager
 */

import { EventEmitter } from 'events';
import { createStreamParser } from '../protocol/frame-parser.js';
import { createHeartbeatHandler } from '../protocol/heartbeat-handler.js';
import { createProtocolRouter } from '../protocol/protocol-router.js';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';

const logger = createChildLogger({ module: 'connection-manager' });

/**
 * Connection states
 */
export const CONNECTION_STATE = {
  CONNECTED: 'connected',
  IDENTIFIED: 'identified',
  ACTIVE: 'active',
  IDLE: 'idle',
  DISCONNECTING: 'disconnecting',
  DISCONNECTED: 'disconnected',
};

/**
 * Connection events
 */
export const CONNECTION_EVENTS = {
  CONNECTION_NEW: 'connection:new',
  CONNECTION_IDENTIFIED: 'connection:identified',
  CONNECTION_CLOSED: 'connection:closed',
  CONNECTION_TIMEOUT: 'connection:timeout',
  CONNECTION_ERROR: 'connection:error',
  DATA_RECEIVED: 'data:received',
  FRAME_RECEIVED: 'frame:received',
  HEARTBEAT_RECEIVED: 'heartbeat:received',
  DLMS_RECEIVED: 'dlms:received',
  PROTOCOL_DETECTED: 'protocol:detected',
};

/**
 * Connection info object
 * @typedef {Object} ConnectionInfo
 * @property {string} id - Unique connection ID
 * @property {string|null} meterId - Associated meter address (12 digits)
 * @property {string} remoteAddress - Client IP address
 * @property {number} remotePort - Client port
 * @property {string} state - Current connection state
 * @property {number} connectedAt - Connection timestamp
 * @property {number} lastActivity - Last activity timestamp
 * @property {number} bytesReceived - Total bytes received
 * @property {number} bytesSent - Total bytes sent
 * @property {number} framesReceived - Total frames received
 * @property {number} framesSent - Total frames sent
 */

/**
 * TCP Connection Manager
 * Singleton pattern - use getInstance() or createConnectionManager()
 */
export class ConnectionManager extends EventEmitter {
  /**
   * @param {Object} options - Configuration options
   * @param {number} [options.heartbeatInterval=30000] - Heartbeat check interval (ms)
   * @param {number} [options.connectionTimeout=120000] - Connection timeout (ms)
   * @param {number} [options.maxConnections=1000] - Maximum concurrent connections
   */
  constructor(options = {}) {
    super();

    this.options = {
      heartbeatInterval: options.heartbeatInterval || config.tcp.heartbeatInterval || 30000,
      connectionTimeout: options.connectionTimeout || config.tcp.connectionTimeout || 120000,
      maxConnections: options.maxConnections || 1000,
      maxPendingCommands: options.maxPendingCommands || 50,
    };

    /** @type {Map<string, Object>} Connection ID -> Connection object */
    this.connections = new Map();

    /** @type {Map<string, string>} Meter ID -> Connection ID */
    this.meterToConnection = new Map();

    /** @type {NodeJS.Timeout|null} */
    this.heartbeatTimer = null;

    /** @type {import('../protocol/heartbeat-handler.js').HeartbeatHandler} */
    this.heartbeatHandler = createHeartbeatHandler(options.heartbeat);

    /** @type {boolean} */
    this.isRunning = false;

    logger.info('ConnectionManager created', { options: this.options });
  }

  /**
   * Start the connection manager
   * Begins heartbeat monitoring
   */
  start() {
    if (this.isRunning) {
      logger.warn('ConnectionManager already running');
      return;
    }

    this.isRunning = true;
    this.startHeartbeatMonitor();
    logger.info('ConnectionManager started');
  }

  /**
   * Stop the connection manager
   * Stops heartbeat monitoring and closes all connections
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.stopHeartbeatMonitor();

    // Close all connections
    const closePromises = [];
    for (const [connectionId] of this.connections) {
      closePromises.push(this.closeConnection(connectionId, 'manager_shutdown'));
    }

    await Promise.allSettled(closePromises);
    logger.info('ConnectionManager stopped', { closedConnections: closePromises.length });
  }

  /**
   * Register a new TCP connection
   *
   * @param {net.Socket} socket - TCP socket
   * @returns {Object} Connection object
   */
  registerConnection(socket) {
    // Check max connections
    if (this.connections.size >= this.options.maxConnections) {
      logger.warn('Max connections reached, rejecting new connection', {
        current: this.connections.size,
        max: this.options.maxConnections,
      });
      socket.destroy();
      return null;
    }

    const connectionId = this.generateConnectionId();
    const now = Date.now();

    // Create stream parser with callbacks bound to this connection (legacy DLT645 fallback)
    const streamParser = createStreamParser(
      (parsed, frame) => {
        this.handleFrame(connectionId, parsed, frame);
      },
      (error, frame) => {
        this.handleParseError(connectionId, error, frame);
      }
    );

    // Create protocol router for auto-detection
    const protocolRouter = createProtocolRouter({
      onHeartbeat: (heartbeat) => {
        this.handleRouterHeartbeat(connectionId, heartbeat);
      },
      onDlt645Frame: (parsed, frame) => {
        this.handleFrame(connectionId, parsed, frame);
      },
      onDlt645Error: (error, frame) => {
        this.handleParseError(connectionId, error, frame);
      },
      onDlmsApdu: (parsedApdu, telemetry, raw) => {
        this.handleDlmsData(connectionId, parsedApdu, telemetry, raw);
      },
      onDlmsError: (error) => {
        const level = error.message.includes('discarding') || error.message.includes('Skipping') ? 'warn' : 'debug';
        logger[level]('DLMS parse error', { connectionId, error: error.message });
      },
      onProtocolDetected: (protocolType) => {
        this.handleProtocolDetected(connectionId, protocolType);
      },
    });

    const connection = {
      id: connectionId,
      socket,
      meterId: null,
      protocolType: null,
      remoteAddress: socket.remoteAddress || 'unknown',
      remotePort: socket.remotePort || 0,
      state: CONNECTION_STATE.CONNECTED,
      connectedAt: now,
      lastActivity: now,
      bytesReceived: 0,
      bytesSent: 0,
      framesReceived: 0,
      framesSent: 0,
      streamParser,
      protocolRouter,
      pendingCommands: new Map(), // commandId -> { resolve, reject, timeout }
      lastHeartbeat: null,
      heartbeatCount: 0,
    };

    this.connections.set(connectionId, connection);

    // Setup socket event handlers
    this.setupSocketHandlers(connection);

    logger.info('New connection registered', {
      connectionId,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      totalConnections: this.connections.size,
    });

    this.emit(CONNECTION_EVENTS.CONNECTION_NEW, {
      connectionId,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
    });

    return connection;
  }

  /**
   * Setup socket event handlers for a connection
   * @private
   */
  setupSocketHandlers(connection) {
    const { socket, id: connectionId } = connection;

    socket.on('data', (data) => {
      this.handleData(connectionId, data);
    });

    socket.on('close', (hadError) => {
      this.handleClose(connectionId, hadError);
    });

    socket.on('error', (error) => {
      this.handleError(connectionId, error);
    });

    socket.on('timeout', () => {
      this.handleTimeout(connectionId);
    });

    // Set socket timeout
    socket.setTimeout(this.options.connectionTimeout);
  }

  /**
   * Handle incoming data from a connection
   * @private
   */
  handleData(connectionId, data) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      logger.warn('Data received for unknown connection', { connectionId });
      return;
    }

    // Update stats
    connection.lastActivity = Date.now();
    connection.bytesReceived += data.length;

    // Update state to active
    if (
      connection.state === CONNECTION_STATE.CONNECTED ||
      connection.state === CONNECTION_STATE.IDLE
    ) {
      connection.state = CONNECTION_STATE.ACTIVE;
    }

    this.emit(CONNECTION_EVENTS.DATA_RECEIVED, {
      connectionId,
      meterId: connection.meterId,
      dataLength: data.length,
    });

    // Route data through the protocol router (auto-detects DLT645 vs IVY/DLMS)
    connection.protocolRouter.push(data);
  }

  /**
   * Handle heartbeat received via protocol router
   * @private
   */
  handleRouterHeartbeat(connectionId, heartbeat) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const meterId = this.heartbeatHandler.resolveMeterId(heartbeat, connection);

    logger.info('Heartbeat packet received', {
      connectionId,
      meterAddress: heartbeat.meterAddress,
      resolvedMeterId: meterId,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      raw: heartbeat.raw.toString('hex'),
      heartbeatCount: connection.heartbeatCount + 1,
    });

    // Identify connection on first heartbeat
    if (!connection.meterId) {
      this.identifyConnection(connectionId, meterId);
    }

    connection.lastHeartbeat = Date.now();
    connection.heartbeatCount++;

    this.emit(CONNECTION_EVENTS.HEARTBEAT_RECEIVED, {
      connectionId,
      meterId: connection.meterId,
      meterAddress: heartbeat.meterAddress,
      heartbeatCount: connection.heartbeatCount,
    });

    // Send ACK if configured
    const ack = this.heartbeatHandler.buildAckResponse();
    if (ack && connection.socket && !connection.socket.destroyed) {
      connection.socket.write(ack);
    }
  }

  /**
   * Handle DLMS data received via protocol router
   * @private
   */
  handleDlmsData(connectionId, parsedApdu, telemetry, raw) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.framesReceived++;

    this.emit(CONNECTION_EVENTS.DLMS_RECEIVED, {
      connectionId,
      meterId: connection.meterId,
      parsedApdu,
      telemetry,
      raw,
    });
  }

  /**
   * Handle protocol detection from router
   * @private
   */
  handleProtocolDetected(connectionId, protocolType) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.protocolType = protocolType;

    logger.info('Protocol detected for connection', {
      connectionId,
      meterId: connection.meterId,
      protocolType,
    });

    this.emit(CONNECTION_EVENTS.PROTOCOL_DETECTED, {
      connectionId,
      meterId: connection.meterId,
      protocolType,
    });
  }

  /**
   * Handle parsed frame from stream parser
   * @private
   */
  handleFrame(connectionId, parsed, frame) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.framesReceived++;

    this.emit(CONNECTION_EVENTS.FRAME_RECEIVED, {
      connectionId,
      meterId: connection.meterId,
      frame,
      parsed,
    });
  }

  /**
   * Handle parse error from stream parser
   * @private
   */
  handleParseError(connectionId, error, _frame) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    logger.warn('Frame parse error', {
      connectionId,
      meterId: connection.meterId,
      error: error.message,
    });
  }

  /**
   * Handle connection close
   * @private
   */
  handleClose(connectionId, hadError) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.state = CONNECTION_STATE.DISCONNECTED;

    // Remove from meter mapping
    if (connection.meterId) {
      this.meterToConnection.delete(connection.meterId);
    }

    // Cancel pending commands
    for (const [, pending] of connection.pendingCommands) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    connection.pendingCommands.clear();

    this.connections.delete(connectionId);

    logger.info('Connection closed', {
      connectionId,
      meterId: connection.meterId,
      hadError,
      duration: Date.now() - connection.connectedAt,
      bytesReceived: connection.bytesReceived,
      bytesSent: connection.bytesSent,
    });

    this.emit(CONNECTION_EVENTS.CONNECTION_CLOSED, {
      connectionId,
      meterId: connection.meterId,
      hadError,
      stats: {
        duration: Date.now() - connection.connectedAt,
        bytesReceived: connection.bytesReceived,
        bytesSent: connection.bytesSent,
        framesReceived: connection.framesReceived,
        framesSent: connection.framesSent,
      },
    });
  }

  /**
   * Handle connection error
   * @private
   */
  handleError(connectionId, error) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    logger.error('Connection error', {
      connectionId,
      meterId: connection.meterId,
      error: error.message,
    });

    this.emit(CONNECTION_EVENTS.CONNECTION_ERROR, {
      connectionId,
      meterId: connection.meterId,
      error,
    });
  }

  /**
   * Handle connection timeout
   * @private
   */
  handleTimeout(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    logger.warn('Connection timeout', {
      connectionId,
      meterId: connection.meterId,
      lastActivity: connection.lastActivity,
    });

    this.emit(CONNECTION_EVENTS.CONNECTION_TIMEOUT, {
      connectionId,
      meterId: connection.meterId,
    });

    // Close the connection
    this.closeConnection(connectionId, 'timeout');
  }

  /**
   * Associate a meter ID with a connection
   * Called when first response from meter identifies it
   *
   * @param {string} connectionId - Connection ID
   * @param {string} meterId - 12-digit meter address
   * @returns {boolean} Success
   */
  identifyConnection(connectionId, meterId) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      logger.warn('Cannot identify unknown connection', { connectionId, meterId });
      return false;
    }

    // Check if meter is already connected elsewhere
    const existingConnectionId = this.meterToConnection.get(meterId);
    if (existingConnectionId && existingConnectionId !== connectionId) {
      logger.warn('Meter already connected on different connection', {
        meterId,
        existingConnectionId,
        newConnectionId: connectionId,
      });
      // Close old connection
      this.closeConnection(existingConnectionId, 'duplicate_meter');
    }

    connection.meterId = meterId;
    connection.state = CONNECTION_STATE.IDENTIFIED;
    this.meterToConnection.set(meterId, connectionId);

    logger.info('Connection identified', {
      connectionId,
      meterId,
      remoteAddress: connection.remoteAddress,
    });

    this.emit(CONNECTION_EVENTS.CONNECTION_IDENTIFIED, {
      connectionId,
      meterId,
      remoteAddress: connection.remoteAddress,
    });

    return true;
  }

  /**
   * Send data to a connection
   *
   * @param {string} connectionId - Connection ID
   * @param {Buffer} data - Data to send
   * @returns {Promise<boolean>} Success
   */
  async send(connectionId, data) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      logger.warn('Cannot send to unknown connection', { connectionId });
      return false;
    }

    if (
      connection.state === CONNECTION_STATE.DISCONNECTED ||
      connection.state === CONNECTION_STATE.DISCONNECTING
    ) {
      logger.warn('Cannot send to disconnected connection', { connectionId });
      return false;
    }

    logger.debug('Sending data', {
      connectionId,
      meterId: connection.meterId,
      length: data.length,
      hex: data.subarray(0, Math.min(32, data.length)).toString('hex'),
    });

    return new Promise((resolve, reject) => {
      const ok = connection.socket.write(data, (error) => {
        if (error) {
          logger.error('Send error', { connectionId, error: error.message });
          reject(error);
        } else {
          connection.bytesSent += data.length;
          connection.framesSent++;
          connection.lastActivity = Date.now();
          resolve(true);
        }
      });

      // Handle backpressure: if write buffer is full, wait for drain
      if (!ok) {
        logger.debug('Socket backpressure, waiting for drain', { connectionId });
        connection.socket.once('drain', () => {
          logger.debug('Socket drained', { connectionId });
        });
      }
    });
  }

  /**
   * Send data to a meter by its ID
   *
   * @param {string} meterId - 12-digit meter address
   * @param {Buffer} data - Data to send
   * @returns {Promise<boolean>} Success
   */
  async sendToMeter(meterId, data) {
    const connectionId = this.meterToConnection.get(meterId);
    if (!connectionId) {
      logger.warn('No connection for meter', { meterId });
      return false;
    }
    return this.send(connectionId, data);
  }

  /**
   * Close a connection
   *
   * @param {string} connectionId - Connection ID
   * @param {string} [reason='normal'] - Close reason
   * @returns {Promise<void>}
   */
  async closeConnection(connectionId, reason = 'normal') {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    if (
      connection.state === CONNECTION_STATE.DISCONNECTING ||
      connection.state === CONNECTION_STATE.DISCONNECTED
    ) {
      return;
    }

    connection.state = CONNECTION_STATE.DISCONNECTING;

    logger.info('Closing connection', { connectionId, meterId: connection.meterId, reason });

    return new Promise((resolve) => {
      connection.socket.end(() => {
        connection.socket.destroy();
        resolve();
      });

      // Force destroy after timeout
      setTimeout(() => {
        if (!connection.socket.destroyed) {
          connection.socket.destroy();
        }
        resolve();
      }, 5000);
    });
  }

  /**
   * Get connection by ID
   *
   * @param {string} connectionId - Connection ID
   * @returns {Object|null} Connection object
   */
  getConnection(connectionId) {
    return this.connections.get(connectionId) || null;
  }

  /**
   * Get connection by meter ID
   *
   * @param {string} meterId - 12-digit meter address
   * @returns {Object|null} Connection object
   */
  getConnectionByMeter(meterId) {
    const connectionId = this.meterToConnection.get(meterId);
    if (!connectionId) {
      return null;
    }
    return this.connections.get(connectionId) || null;
  }

  /**
   * Get connection info (safe to expose externally)
   *
   * @param {string} connectionId - Connection ID
   * @returns {ConnectionInfo|null} Connection info
   */
  getConnectionInfo(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return null;
    }

    return {
      id: connection.id,
      meterId: connection.meterId,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      state: connection.state,
      connectedAt: connection.connectedAt,
      lastActivity: connection.lastActivity,
      bytesReceived: connection.bytesReceived,
      bytesSent: connection.bytesSent,
      framesReceived: connection.framesReceived,
      framesSent: connection.framesSent,
    };
  }

  /**
   * Get all connection infos
   *
   * @returns {ConnectionInfo[]} Array of connection infos
   */
  getAllConnectionInfos() {
    const infos = [];
    for (const [connectionId] of this.connections) {
      const info = this.getConnectionInfo(connectionId);
      if (info) {
        infos.push(info);
      }
    }
    return infos;
  }

  /**
   * Get all connected meter IDs
   *
   * @returns {string[]} Array of meter IDs
   */
  getConnectedMeterIds() {
    return Array.from(this.meterToConnection.keys());
  }

  /**
   * Check if a meter is connected
   *
   * @param {string} meterId - Meter ID
   * @returns {boolean} Is connected
   */
  isMeterConnected(meterId) {
    return this.meterToConnection.has(meterId);
  }

  /**
   * Get connection statistics
   *
   * @returns {Object} Statistics
   */
  getStats() {
    let identifiedCount = 0;
    let activeCount = 0;
    let idleCount = 0;
    let totalBytesReceived = 0;
    let totalBytesSent = 0;

    for (const [, connection] of this.connections) {
      if (connection.meterId) identifiedCount++;
      if (connection.state === CONNECTION_STATE.ACTIVE) activeCount++;
      if (connection.state === CONNECTION_STATE.IDLE) idleCount++;
      totalBytesReceived += connection.bytesReceived;
      totalBytesSent += connection.bytesSent;
    }

    return {
      totalConnections: this.connections.size,
      identifiedConnections: identifiedCount,
      activeConnections: activeCount,
      idleConnections: idleCount,
      totalBytesReceived,
      totalBytesSent,
      maxConnections: this.options.maxConnections,
    };
  }

  /**
   * Start heartbeat monitoring
   * @private
   */
  startHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.checkConnections();
    }, this.options.heartbeatInterval);

    logger.debug('Heartbeat monitor started', {
      interval: this.options.heartbeatInterval,
    });
  }

  /**
   * Stop heartbeat monitoring
   * @private
   */
  stopHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      logger.debug('Heartbeat monitor stopped');
    }
  }

  /**
   * Check all connections for timeouts and update states
   * @private
   */
  checkConnections() {
    const now = Date.now();
    const timeoutThreshold = now - this.options.connectionTimeout;
    const idleThreshold = now - this.options.heartbeatInterval * 2;

    for (const [connectionId, connection] of this.connections) {
      // Check for timeout
      if (connection.lastActivity < timeoutThreshold) {
        logger.warn('Connection timed out during heartbeat check', {
          connectionId,
          meterId: connection.meterId,
          lastActivity: connection.lastActivity,
          threshold: timeoutThreshold,
        });
        this.handleTimeout(connectionId);
        continue;
      }

      // Update idle state
      if (connection.lastActivity < idleThreshold && connection.state === CONNECTION_STATE.ACTIVE) {
        connection.state = CONNECTION_STATE.IDLE;
      }
    }
  }

  /**
   * Generate unique connection ID
   * @private
   */
  generateConnectionId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `conn_${timestamp}_${random}`;
  }
}

// Singleton instance
let instance = null;

/**
 * Get singleton instance of ConnectionManager
 *
 * @param {Object} [options] - Options (only used on first call)
 * @returns {ConnectionManager} Singleton instance
 */
export const getInstance = (options) => {
  if (!instance) {
    instance = new ConnectionManager(options);
  }
  return instance;
};

/**
 * Create a new ConnectionManager instance
 * Use this for testing or when you need multiple instances
 *
 * @param {Object} [options] - Configuration options
 * @returns {ConnectionManager} New instance
 */
export const createConnectionManager = (options) => {
  return new ConnectionManager(options);
};

/**
 * Reset singleton instance (for testing)
 */
export const resetInstance = () => {
  if (instance) {
    instance.stop();
    instance = null;
  }
};

export default {
  ConnectionManager,
  CONNECTION_STATE,
  CONNECTION_EVENTS,
  getInstance,
  createConnectionManager,
  resetInstance,
};
