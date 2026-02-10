/**
 * MQTT Command Handler
 *
 * Handles commands received via MQTT and forwards them to meters via TCP.
 * Subscribes to command request topics and publishes responses.
 *
 * Command Flow:
 * 1. Client publishes to ivy/v1/meters/{meterId}/command/request
 * 2. Handler receives and validates command
 * 3. Handler sends command to meter via TCP
 * 4. Handler publishes result to ivy/v1/meters/{meterId}/command/response
 *
 * Supported Commands:
 * - read_register: Read a specific register
 * - relay_control: Open/close relay (prepaid meters)
 * - read_address: Read meter address
 * - read_all: Read multiple registers
 *
 * @module mqtt/command-handler
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger.js';
import { Topics } from './publisher.js';
import { buildReadFrame, buildSimpleRelayFrame } from '../protocol/frame-builder.js';
import {
  ENERGY_REGISTERS,
  INSTANTANEOUS_REGISTERS,
  PARAMETER_REGISTERS,
  PREPAID_REGISTERS,
  findRegisterById,
} from '../protocol/registers.js';
import { PROTOCOL_TYPES } from '../protocol/protocol-router.js';
import { buildAarq, buildActionRequest, buildGetRequest, buildReleaseRequest, prepareDlmsForSending } from '../protocol/dlms/client.js';
import { CONNECTION_EVENTS } from '../tcp/connection-manager.js';
import config from '../config/index.js';

const logger = createChildLogger({ module: 'command-handler' });

/**
 * Command handler events
 */
export const COMMAND_EVENTS = {
  COMMAND_RECEIVED: 'command:received',
  COMMAND_EXECUTED: 'command:executed',
  COMMAND_FAILED: 'command:failed',
  COMMAND_INVALID: 'command:invalid',
};

/**
 * Supported command methods
 */
export const COMMAND_METHODS = {
  READ_REGISTER: 'read_register',
  RELAY_CONTROL: 'relay_control',
  READ_RELAY_STATE: 'read_relay_state',
  READ_ADDRESS: 'read_address',
  READ_ALL: 'read_all',
};

/**
 * Command status
 */
export const COMMAND_STATUS = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  INVALID: 'invalid',
};

/**
 * Topic pattern for command requests
 */
const COMMAND_TOPIC_PATTERN = /^ivy\/v1\/meters\/([^/]+)\/command\/request$/;

/**
 * Command Handler class
 */
export class CommandHandler extends EventEmitter {
  /**
   * @param {Object} options - Handler options
   * @param {Object} options.broker - MQTT broker instance
   * @param {Object} options.tcpServer - TCP server instance
   * @param {Object} [options.publisher] - Telemetry publisher for responses
   * @param {Object} [options.pollingManager] - Polling manager for DLMS lock coordination
   * @param {number} [options.timeout=10000] - Command timeout in ms
   */
  constructor(options = {}) {
    super();

    if (!options.broker) {
      throw new Error('MQTT broker instance required');
    }
    if (!options.tcpServer) {
      throw new Error('TCP server instance required');
    }

    this.broker = options.broker;
    this.tcpServer = options.tcpServer;
    this.publisher = options.publisher || null;
    this.pollingManager = options.pollingManager || null;
    this.options = {
      timeout: options.timeout ?? 10000,
    };

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {Map<string, Object>} Pending commands */
    this.pendingCommands = new Map();

    /** @type {Object} Statistics */
    this.stats = {
      commandsReceived: 0,
      commandsExecuted: 0,
      commandsFailed: 0,
      commandsInvalid: 0,
    };

    /** @type {Function|null} Publish handler reference for cleanup */
    this._publishHandler = null;

    logger.info('CommandHandler created', { timeout: this.options.timeout });
  }

  /**
   * Start the command handler
   */
  start() {
    if (this.isRunning) {
      logger.warn('CommandHandler already running');
      return;
    }

    // Setup MQTT subscriptions
    this.setupSubscriptions();

    this.isRunning = true;
    logger.info('CommandHandler started');
  }

  /**
   * Stop the command handler
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Remove publish handler
    if (this._publishHandler && this.broker.aedes) {
      this.broker.aedes.removeListener('publish', this._publishHandler);
      this._publishHandler = null;
    }

    // Cancel pending commands
    for (const [, command] of this.pendingCommands) {
      command.status = COMMAND_STATUS.FAILED;
      command.error = 'Handler stopped';
    }
    this.pendingCommands.clear();

    logger.info('CommandHandler stopped');
  }

  /**
   * Setup MQTT subscriptions
   * @private
   */
  setupSubscriptions() {
    if (!this.broker.aedes) {
      logger.warn('Broker aedes instance not available');
      return;
    }

    // Listen to publish events and filter command requests
    this._publishHandler = (packet, client) => {
      const match = packet.topic.match(COMMAND_TOPIC_PATTERN);
      if (match) {
        this.handleCommandMessage(packet, client);
      }
    };

    this.broker.aedes.on('publish', this._publishHandler);

    logger.debug('Subscribed to command topics');
  }

  /**
   * Handle incoming command message
   * @param {Object} packet - MQTT packet
   * @param {Object} [client] - MQTT client
   */
  async handleCommandMessage(packet, client = null) {
    try {
      // Extract meter ID from topic
      const match = packet.topic.match(COMMAND_TOPIC_PATTERN);
      if (!match) {
        return;
      }
      const meterId = match[1];

      // Parse command payload
      let payload;
      try {
        payload = JSON.parse(packet.payload.toString());
      } catch {
        logger.warn('Invalid JSON in command payload', { topic: packet.topic });
        return;
      }

      logger.debug('Command received', {
        meterId,
        method: payload.method,
        id: payload.id,
        clientId: client?.id,
      });

      this.stats.commandsReceived++;

      this.emit(COMMAND_EVENTS.COMMAND_RECEIVED, {
        meterId,
        command: payload,
        clientId: client?.id,
      });

      // Validate command
      const validation = this.validateCommand(payload);
      if (!validation.valid) {
        await this.sendErrorResponse(meterId, payload.id, validation.error);
        this.stats.commandsInvalid++;
        this.emit(COMMAND_EVENTS.COMMAND_INVALID, {
          meterId,
          command: payload,
          error: validation.error,
        });
        return;
      }

      // Execute command
      await this.executeCommand(meterId, payload);
    } catch (error) {
      logger.error('Failed to handle command message', {
        topic: packet.topic,
        error: error.message,
      });
    }
  }

  /**
   * Validate command payload
   * @param {Object} command - Command payload
   * @returns {Object} Validation result { valid: boolean, error?: string }
   */
  validateCommand(command) {
    if (!command.id) {
      return { valid: false, error: 'Missing command id' };
    }

    if (!command.method) {
      return { valid: false, error: 'Missing command method' };
    }

    if (!Object.values(COMMAND_METHODS).includes(command.method)) {
      return { valid: false, error: `Unknown method: ${command.method}` };
    }

    // Method-specific validation
    switch (command.method) {
      case COMMAND_METHODS.READ_REGISTER:
        if (!command.params?.register && !command.params?.dataId) {
          return { valid: false, error: 'Missing register or dataId parameter' };
        }
        break;

      case COMMAND_METHODS.RELAY_CONTROL:
        if (!command.params?.state || !['open', 'close'].includes(command.params.state)) {
          return { valid: false, error: 'Invalid relay state (must be "open" or "close")' };
        }
        break;
    }

    return { valid: true };
  }

  /**
   * Execute a command
   * @private
   * @param {string} meterId - Meter address
   * @param {Object} command - Command payload
   */
  async executeCommand(meterId, command) {
    const commandId = command.id;

    // Check if meter is connected
    if (!this.tcpServer.isMeterConnected(meterId)) {
      await this.sendErrorResponse(meterId, commandId, 'Meter not connected');
      this.stats.commandsFailed++;
      this.emit(COMMAND_EVENTS.COMMAND_FAILED, {
        meterId,
        commandId,
        error: 'Meter not connected',
      });
      return;
    }

    // Track pending command
    this.pendingCommands.set(commandId, {
      meterId,
      command,
      status: COMMAND_STATUS.EXECUTING,
      startTime: Date.now(),
    });

    try {
      let result;

      switch (command.method) {
        case COMMAND_METHODS.READ_REGISTER:
          result = await this.executeReadRegister(meterId, command.params);
          break;

        case COMMAND_METHODS.RELAY_CONTROL:
          result = await this.executeRelayControl(meterId, command.params);
          break;

        case COMMAND_METHODS.READ_ADDRESS:
          result = await this.executeReadAddress(meterId);
          break;

        case COMMAND_METHODS.READ_RELAY_STATE:
          result = await this.executeReadRelayState(meterId);
          break;

        case COMMAND_METHODS.READ_ALL:
          result = await this.executeReadAll(meterId, command.params);
          break;

        default:
          throw new Error(`Unhandled method: ${command.method}`);
      }

      // Send success response
      await this.sendSuccessResponse(meterId, commandId, result);

      this.stats.commandsExecuted++;
      this.pendingCommands.delete(commandId);

      this.emit(COMMAND_EVENTS.COMMAND_EXECUTED, {
        meterId,
        commandId,
        method: command.method,
        result,
      });
    } catch (error) {
      await this.sendErrorResponse(meterId, commandId, error.message);

      this.stats.commandsFailed++;
      this.pendingCommands.delete(commandId);

      this.emit(COMMAND_EVENTS.COMMAND_FAILED, {
        meterId,
        commandId,
        error: error.message,
      });
    }
  }

  /**
   * Execute read_register command
   * @private
   * @param {string} meterId - Meter address
   * @param {Object} params - Command parameters
   * @returns {Promise<Object>} Read result
   */
  async executeReadRegister(meterId, params) {
    // Resolve register
    let register;
    let dataId;

    if (params.dataId) {
      dataId = typeof params.dataId === 'string' ? parseInt(params.dataId, 16) : params.dataId;
      register = findRegisterById(dataId);
    } else if (params.register) {
      register = this.resolveRegisterByName(params.register);
      if (!register) {
        throw new Error(`Unknown register: ${params.register}`);
      }
      dataId = register.id;
    }

    // Build and send frame
    const frame = buildReadFrame(meterId, dataId);
    const response = await this.tcpServer.sendCommand(
      meterId,
      frame,
      dataId,
      this.options.timeout
    );

    return {
      register: register?.key || register?.name || params.register,
      dataId: `0x${dataId.toString(16).padStart(8, '0')}`,
      value: response.value,
      unit: response.unit || register?.unit || '',
      timestamp: Date.now(),
    };
  }

  /**
   * Execute relay_control command
   * @private
   * @param {string} meterId - Meter address
   * @param {Object} params - Command parameters
   * @returns {Promise<Object>} Relay result
   */
  async executeRelayControl(meterId, params) {
    const state = params.state; // 'open' or 'close'

    // Check if this is a DLMS meter
    const connection = this.tcpServer.connectionManager?.getConnectionByMeter(meterId);
    if (connection?.protocolType === PROTOCOL_TYPES.IVY_DLMS) {
      return this.executeDlmsRelayControl(meterId, state);
    }

    // DLT645 path
    // Map command state to DLT645 relay command
    // 'open' means trip/disconnect, 'close' means reconnect
    const relayCommand = state === 'open' ? 'trip' : 'close';

    // Build relay control frame (using simple version for now)
    const frame = buildSimpleRelayFrame(meterId, relayCommand);

    // Send command - relay control may not return data
    try {
      await this.tcpServer.sendCommand(
        meterId,
        frame,
        PARAMETER_REGISTERS.RELAY_STATUS.id,
        this.options.timeout
      );
    } catch (error) {
      // Some meters don't respond to relay control, just acknowledge
      if (!error.message.includes('timeout') && !error.message.includes('Timeout')) {
        throw error;
      }
    }

    return {
      relay_state: state,
      timestamp: Date.now(),
    };
  }

  /**
   * Execute DLMS relay control via ACTION.request
   * @private
   * @param {string} meterId - Meter address
   * @param {string} state - 'open' (disconnect) or 'close' (reconnect)
   * @returns {Promise<Object>} Relay result
   */
  async executeDlmsRelayControl(meterId, state) {
    const DISCONNECT_OBIS = '0-0:96.3.10.255';
    const DISCONNECT_CLASS_ID = 70;
    // method 1 = remote_disconnect, method 2 = remote_reconnect
    const methodId = state === 'open' ? 1 : 2;
    const wrapWithIvy = config.dlms?.wrapOutgoing !== false;

    let release = null;
    try {
      // Acquire DLMS association lock
      if (this.pollingManager) {
        release = await this.pollingManager.acquireDlmsLock(meterId, 15000);
      }

      const preparePacket = (apdu) => prepareDlmsForSending(apdu, { wrapWithIvy });

      // 1. Send AARQ and wait for AARE
      const aarq = preparePacket(buildAarq());
      await this.tcpServer.sendCommandNoWait(meterId, aarq);

      const aare = await this.waitForDlmsResponse(meterId, 'aare', 5000);
      if (!aare || !aare.accepted) {
        throw new Error('DLMS association failed: ' + (aare ? 'rejected' : 'timeout'));
      }

      // 2. Send ACTION.request
      const actionReq = preparePacket(buildActionRequest(DISCONNECT_CLASS_ID, DISCONNECT_OBIS, methodId));
      await this.tcpServer.sendCommandNoWait(meterId, actionReq);

      const actionResp = await this.waitForDlmsResponse(meterId, 'action-response', 5000);
      if (!actionResp || !actionResp.success) {
        throw new Error('DLMS ACTION failed: ' + (actionResp ? actionResp.actionResultName : 'timeout'));
      }

      // 3. Wait and read output_state to confirm
      await this.delay(1000);
      const getReq = preparePacket(buildGetRequest(DISCONNECT_CLASS_ID, DISCONNECT_OBIS, 2, 1));
      await this.tcpServer.sendCommandNoWait(meterId, getReq);

      const getResp = await this.waitForDlmsResponse(meterId, 'get-response', 5000);
      const outputState = getResp?.data?.value;

      // 4. Send RLRQ (fire and forget)
      const rlrq = preparePacket(buildReleaseRequest());
      await this.tcpServer.sendCommandNoWait(meterId, rlrq);

      return {
        relay_state: state,
        output_state: outputState,
        protocol: 'dlms',
        timestamp: Date.now(),
      };
    } finally {
      if (release) release();
    }
  }

  /**
   * Execute read_relay_state command (DLMS only)
   * @private
   * @param {string} meterId - Meter address
   * @returns {Promise<Object>} Relay state result
   */
  async executeReadRelayState(meterId) {
    const connection = this.tcpServer.connectionManager?.getConnectionByMeter(meterId);
    if (!connection || connection.protocolType !== PROTOCOL_TYPES.IVY_DLMS) {
      throw new Error('read_relay_state is only supported for DLMS meters');
    }

    const DISCONNECT_OBIS = '0-0:96.3.10.255';
    const DISCONNECT_CLASS_ID = 70;
    const wrapWithIvy = config.dlms?.wrapOutgoing !== false;

    let release = null;
    try {
      if (this.pollingManager) {
        release = await this.pollingManager.acquireDlmsLock(meterId, 15000);
      }

      const preparePacket = (apdu) => prepareDlmsForSending(apdu, { wrapWithIvy });

      // 1. AARQ → AARE
      const aarq = preparePacket(buildAarq());
      await this.tcpServer.sendCommandNoWait(meterId, aarq);

      const aare = await this.waitForDlmsResponse(meterId, 'aare', 5000);
      if (!aare || !aare.accepted) {
        throw new Error('DLMS association failed: ' + (aare ? 'rejected' : 'timeout'));
      }

      // 2. GET output_state (attribute 2, invokeId 1)
      const getReq1 = preparePacket(buildGetRequest(DISCONNECT_CLASS_ID, DISCONNECT_OBIS, 2, 1));
      await this.tcpServer.sendCommandNoWait(meterId, getReq1);

      const getResp1 = await this.waitForDlmsResponse(meterId, 'get-response', 5000);
      const outputState = getResp1?.data?.value;

      // 3. GET control_state (attribute 3, invokeId 2)
      const getReq2 = preparePacket(buildGetRequest(DISCONNECT_CLASS_ID, DISCONNECT_OBIS, 3, 2));
      await this.tcpServer.sendCommandNoWait(meterId, getReq2);

      const getResp2 = await this.waitForDlmsResponse(meterId, 'get-response', 5000);
      const controlState = getResp2?.data?.value;

      // 4. RLRQ (fire and forget)
      const rlrq = preparePacket(buildReleaseRequest());
      await this.tcpServer.sendCommandNoWait(meterId, rlrq);

      return {
        output_state: outputState,
        control_state: controlState,
        protocol: 'dlms',
        timestamp: Date.now(),
      };
    } finally {
      if (release) release();
    }
  }

  /**
   * Wait for a DLMS response of a specific type from a meter
   * @private
   * @param {string} meterId - Meter address
   * @param {string} expectedType - Expected parsedApdu.type (e.g., 'aare', 'action-response')
   * @param {number} [timeout=5000] - Timeout in ms
   * @returns {Promise<Object|null>} Parsed APDU or null on timeout
   */
  waitForDlmsResponse(meterId, expectedType, timeout = 5000) {
    return new Promise((resolve) => {
      const connectionManager = this.tcpServer.connectionManager;
      if (!connectionManager) {
        resolve(null);
        return;
      }

      const listener = (data) => {
        if (data.meterId === meterId && data.parsedApdu?.type === expectedType) {
          clearTimeout(timer);
          connectionManager.removeListener(CONNECTION_EVENTS.DLMS_RECEIVED, listener);
          resolve(data.parsedApdu);
        }
      };

      const timer = setTimeout(() => {
        connectionManager.removeListener(CONNECTION_EVENTS.DLMS_RECEIVED, listener);
        resolve(null);
      }, timeout);

      connectionManager.on(CONNECTION_EVENTS.DLMS_RECEIVED, listener);
    });
  }

  /**
   * Delay helper
   * @private
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute read_address command
   * @private
   * @param {string} meterId - Meter address
   * @returns {Promise<Object>} Address result
   */
  async executeReadAddress(meterId) {
    // For now, just return the known address
    // Could implement actual address read if needed
    return {
      address: meterId,
      timestamp: Date.now(),
    };
  }

  /**
   * Execute read_all command (read multiple registers)
   * @private
   * @param {string} meterId - Meter address
   * @param {Object} [params] - Command parameters
   * @returns {Promise<Object>} Read results
   */
  async executeReadAll(meterId, params = {}) {
    const results = {};
    const registers = params?.registers || ['TOTAL_ACTIVE_POSITIVE', 'VOLTAGE_A', 'CURRENT_A'];

    for (const regName of registers) {
      try {
        const result = await this.executeReadRegister(meterId, { register: regName });
        results[regName] = {
          value: result.value,
          unit: result.unit,
        };
      } catch (error) {
        results[regName] = {
          error: error.message,
        };
      }
    }

    return {
      readings: results,
      timestamp: Date.now(),
    };
  }

  /**
   * Resolve register by name
   * @private
   * @param {string} name - Register name (case-insensitive)
   * @returns {Object|null} Register definition or null
   */
  resolveRegisterByName(name) {
    const upperName = name.toUpperCase();

    // Check all register groups
    const allRegisters = {
      ...ENERGY_REGISTERS,
      ...INSTANTANEOUS_REGISTERS,
      ...PARAMETER_REGISTERS,
      ...PREPAID_REGISTERS,
    };

    const register = allRegisters[upperName];
    if (register) {
      return { ...register, key: upperName };
    }

    return null;
  }

  /**
   * Send success response
   * @private
   * @param {string} meterId - Meter address
   * @param {string} commandId - Command ID
   * @param {Object} result - Command result
   */
  async sendSuccessResponse(meterId, commandId, result) {
    if (this.publisher) {
      await this.publisher.publishCommandResponse(meterId, commandId, true, result);
    } else {
      const topic = Topics.meterCommandResponse(meterId);
      const response = {
        id: commandId,
        success: true,
        result,
        ts: Date.now(),
      };
      await this.broker.publish(topic, response);
    }

    logger.debug('Command response sent', {
      meterId,
      commandId,
      success: true,
    });
  }

  /**
   * Send error response
   * @private
   * @param {string} meterId - Meter address
   * @param {string} commandId - Command ID
   * @param {string} error - Error message
   */
  async sendErrorResponse(meterId, commandId, error) {
    if (this.publisher) {
      await this.publisher.publishCommandResponse(meterId, commandId, false, { error });
    } else {
      const topic = Topics.meterCommandResponse(meterId);
      const response = {
        id: commandId,
        success: false,
        error,
        ts: Date.now(),
      };
      await this.broker.publish(topic, response);
    }

    logger.debug('Command error response sent', {
      meterId,
      commandId,
      error,
    });
  }

  /**
   * Execute command directly (programmatic API)
   *
   * @param {string} meterId - Meter address
   * @param {string} method - Command method
   * @param {Object} [params] - Command parameters
   * @returns {Promise<Object>} Command result
   */
  async execute(meterId, method, params = {}) {
    const command = {
      id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    };

    const validation = this.validateCommand(command);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Check if meter is connected
    if (!this.tcpServer.isMeterConnected(meterId)) {
      throw new Error('Meter not connected');
    }

    // Execute directly without MQTT response
    switch (method) {
      case COMMAND_METHODS.READ_REGISTER:
        return await this.executeReadRegister(meterId, params);

      case COMMAND_METHODS.RELAY_CONTROL:
        return await this.executeRelayControl(meterId, params);

      case COMMAND_METHODS.READ_RELAY_STATE:
        return await this.executeReadRelayState(meterId);

      case COMMAND_METHODS.READ_ADDRESS:
        return await this.executeReadAddress(meterId);

      case COMMAND_METHODS.READ_ALL:
        return await this.executeReadAll(meterId, params);

      default:
        throw new Error(`Unhandled method: ${method}`);
    }
  }

  /**
   * Get handler statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      pendingCommands: this.pendingCommands.size,
    };
  }

  /**
   * Get pending commands
   * @returns {Object[]} Pending command list
   */
  getPendingCommands() {
    const pending = [];
    for (const [id, cmd] of this.pendingCommands) {
      pending.push({
        id,
        meterId: cmd.meterId,
        method: cmd.command.method,
        status: cmd.status,
        elapsed: Date.now() - cmd.startTime,
      });
    }
    return pending;
  }
}

/**
 * Create command handler instance
 * @param {Object} options - Options
 * @returns {CommandHandler}
 */
export const createCommandHandler = (options) => {
  return new CommandHandler(options);
};

export default {
  CommandHandler,
  COMMAND_EVENTS,
  COMMAND_METHODS,
  COMMAND_STATUS,
  createCommandHandler,
};
