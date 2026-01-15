/**
 * IVY 4G Energy Meter Gateway
 * Main application entry point
 */

import config, { validateConfig } from './config/index.js';
import logger from './utils/logger.js';
import { createTCPServer, SERVER_EVENTS } from './tcp/server.js';

/** @type {import('./tcp/server.js').TCPServer|null} */
let tcpServer = null;

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

    logger.info('IVY 4G Gateway started successfully', {
      tcpPort: config.tcp.port,
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
  tcpServer.on(SERVER_EVENTS.METER_CONNECTED, ({ meterId, remoteAddress }) => {
    logger.info('Meter connected', { meterId, remoteAddress });
  });

  tcpServer.on(SERVER_EVENTS.METER_DISCONNECTED, ({ meterId, stats }) => {
    logger.info('Meter disconnected', { meterId, stats });
  });

  tcpServer.on(SERVER_EVENTS.TELEMETRY_RECEIVED, (data) => {
    logger.debug('Telemetry received', {
      meterId: data.meterId,
      register: data.register?.name || data.dataIdFormatted,
      value: data.value,
      unit: data.unit,
    });

    // TODO: Publish to MQTT (Phase 2)
    // mqttPublisher.publishTelemetry(data);
  });

  tcpServer.on(SERVER_EVENTS.ERROR_RESPONSE, (data) => {
    logger.warn('Error response from meter', {
      meterId: data.meterId,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
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
    if (tcpServer) {
      await tcpServer.stop();
      logger.info('TCP Server stopped');
    }

    // TODO: Close other connections (Phase 2-3)
    // - Disconnect MQTT
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
