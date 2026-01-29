/**
 * IVY 4G Energy Meter Gateway
 * Main application entry point
 */

import config, { validateConfig } from './config/index.js';
import logger from './utils/logger.js';
import { createTCPServer, SERVER_EVENTS } from './tcp/server.js';
import { createMQTTBroker } from './mqtt/broker.js';
import { createAuthManager } from './mqtt/auth.js';
import { createTelemetryPublisher } from './mqtt/publisher.js';
import { createCommandHandler } from './mqtt/command-handler.js';
import { createPollingManager } from './services/polling-manager.js';
import { createStatusManager } from './services/status-manager.js';
import { createHttpServer } from './http/server.js';

/** @type {import('./tcp/server.js').TCPServer|null} */
let tcpServer = null;

/** @type {import('./mqtt/broker.js').MQTTBroker|null} */
let mqttBroker = null;

/** @type {import('./mqtt/auth.js').AuthManager|null} */
let authManager = null;

/** @type {import('./mqtt/publisher.js').TelemetryPublisher|null} */
let telemetryPublisher = null;

/** @type {import('./mqtt/command-handler.js').CommandHandler|null} */
let commandHandler = null;

/** @type {import('./services/polling-manager.js').PollingManager|null} */
let pollingManager = null;

/** @type {import('./services/status-manager.js').StatusManager|null} */
let statusManager = null;

/** @type {Object|null} */
let httpServer = null;

/**
 * Application startup
 */
const main = async () => {
  logger.info('Starting IVY 4G Gateway...', {
    env: config.env,
    tcpPort: config.tcp.port,
  });

  try {
    // Validate configuration
    validateConfig();
    logger.info('Configuration validated');

    // Create and start TCP server
    tcpServer = createTCPServer();

    // Setup event handlers
    setupEventHandlers();

    // Start the server
    await tcpServer.start();

    // Setup MQTT Authentication if enabled
    if (config.mqtt.auth.enabled) {
      authManager = createAuthManager({
        allowAnonymous: config.mqtt.auth.allowAnonymous,
        users: config.mqtt.auth.users,
      });
      logger.info('MQTT Auth enabled', {
        allowAnonymous: config.mqtt.auth.allowAnonymous,
        userCount: authManager.getAllUsers().length,
      });
    }

    // Start MQTT Broker
    mqttBroker = createMQTTBroker({
      ...(authManager && {
        authenticate: authManager.authenticate.bind(authManager),
        authorizePublish: authManager.authorizePublish.bind(authManager),
        authorizeSubscribe: authManager.authorizeSubscribe.bind(authManager),
      }),
    });
    await mqttBroker.start();

    // Create and start Telemetry Publisher
    telemetryPublisher = createTelemetryPublisher({
      broker: mqttBroker,
    });
    telemetryPublisher.start({
      version: '0.1.0',
      name: 'IVY 4G Gateway',
    });
    logger.info('Telemetry Publisher started');

    // Create and start Command Handler
    commandHandler = createCommandHandler({
      broker: mqttBroker,
      tcpServer,
      publisher: telemetryPublisher,
    });
    commandHandler.start();
    logger.info('Command Handler started');

    // Create and start Polling Manager
    pollingManager = createPollingManager({ tcpServer });
    pollingManager.start();
    logger.info('Polling Manager started', {
      interval: config.polling.interval,
      registerGroup: config.polling.registerGroup,
      enabled: config.polling.enabled,
    });

    // Create and start Status Manager
    statusManager = createStatusManager({
      publisher: telemetryPublisher,
      tcpServer,
    });
    statusManager.start();
    logger.info('Status Manager started');

    // Start HTTP server for dashboard
    if (config.http?.enabled !== false) {
      httpServer = createHttpServer();
      await httpServer.start();
      logger.info('Dashboard available', {
        url: `http://localhost:${config.http.port}`,
      });
    }

    logger.info('IVY 4G Gateway started successfully', {
      tcpPort: config.tcp.port,
      mqttPort: config.mqtt.port,
      mqttWsPort: config.mqtt.wsPort,
      httpPort: config.http?.enabled !== false ? config.http.port : 'disabled',
    });

    // Setup shutdown handlers
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    logger.error('Failed to start gateway', { error: error.message, stack: error.stack });
    process.exit(1);
  }
};

/**
 * Setup TCP server event handlers
 */
const setupEventHandlers = () => {
  tcpServer.on(SERVER_EVENTS.METER_CONNECTED, async ({ meterId, remoteAddress }) => {
    logger.info('Meter connected', { meterId, remoteAddress });

    // Publish meter online status
    if (telemetryPublisher) {
      await telemetryPublisher.publishMeterStatus(meterId, true, { ip: remoteAddress });
    }
  });

  tcpServer.on(SERVER_EVENTS.METER_DISCONNECTED, async ({ meterId, stats }) => {
    logger.info('Meter disconnected', { meterId, stats });

    // Publish meter offline status
    if (telemetryPublisher) {
      await telemetryPublisher.publishMeterStatus(meterId, false);
    }
  });

  tcpServer.on(SERVER_EVENTS.TELEMETRY_RECEIVED, async (data) => {
    logger.debug('Telemetry received', {
      meterId: data.meterId,
      register: data.register?.name || data.dataIdFormatted,
      value: data.value,
      unit: data.unit,
    });

    // Publish to MQTT
    if (telemetryPublisher) {
      await telemetryPublisher.publishTelemetry(data.meterId, data);
    }
  });

  tcpServer.on(SERVER_EVENTS.ERROR_RESPONSE, (data) => {
    logger.warn('Error response from meter', {
      meterId: data.meterId,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
    });
  });

  tcpServer.on(SERVER_EVENTS.HEARTBEAT_RECEIVED, (data) => {
    logger.info('Meter heartbeat received', {
      meterId: data.meterId,
      meterAddress: data.meterAddress,
      heartbeatCount: data.heartbeatCount,
    });
  });

  tcpServer.on(SERVER_EVENTS.SERVER_ERROR, ({ error }) => {
    logger.error('TCP Server error', { error: error.message });
  });
};

/**
 * Graceful shutdown handler
 */
const shutdown = async () => {
  logger.info('Shutting down...');

  try {
    if (httpServer) {
      await httpServer.stop();
      logger.info('HTTP server stopped');
    }

    if (statusManager) {
      statusManager.stop();
      logger.info('Status Manager stopped');
    }

    if (commandHandler) {
      commandHandler.stop();
      logger.info('Command Handler stopped');
    }

    if (pollingManager) {
      pollingManager.stop();
      logger.info('Polling Manager stopped');
    }

    if (tcpServer) {
      await tcpServer.stop();
      logger.info('TCP Server stopped');
    }

    if (telemetryPublisher) {
      await telemetryPublisher.stop();
      logger.info('Telemetry Publisher stopped');
    }

    if (mqttBroker) {
      await mqttBroker.stop();
      logger.info('MQTT Broker stopped');
    }

    // TODO: Close other connections (future phases)
    // - Close database pool
    // - Disconnect Redis

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

// Start application
main();
