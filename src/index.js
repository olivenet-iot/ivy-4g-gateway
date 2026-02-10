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
import { lookupObis } from './protocol/dlms/obis-registry.js';
import { createHttpServer } from './http/server.js';
import { createMQTTBridge } from './mqtt/bridge.js';

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

/** @type {import('./mqtt/bridge.js').MQTTBridge|null} */
let mqttBridge = null;

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

    // Create Polling Manager (before Command Handler so it can be injected)
    pollingManager = createPollingManager({ tcpServer });

    // Create and start Command Handler
    commandHandler = createCommandHandler({
      broker: mqttBroker,
      tcpServer,
      publisher: telemetryPublisher,
      pollingManager,
    });
    commandHandler.start();
    logger.info('Command Handler started');

    // Start Polling Manager
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
      httpServer = createHttpServer({
        tcpServer,
        publisher: telemetryPublisher,
        statusManager,
        pollingManager,
        commandHandler,
      });
      await httpServer.start();
      logger.info('Dashboard available', {
        url: `http://localhost:${config.http.port}`,
      });
    }

    // Start MQTT Bridge to external broker if configured
    if (config.mqtt.brokerUrl && config.mqtt.brokerUrl !== 'mqtt://localhost:1883') {
      try {
        mqttBridge = createMQTTBridge({
          brokerUrl: config.mqtt.brokerUrl,
          username: config.mqtt.username,
          password: config.mqtt.password,
          clientId: config.mqtt.clientId,
          localBroker: mqttBroker,
          remotePrefix: config.mqtt.topicPrefix || 'ivy/v1',
        });
        await mqttBridge.start();
        logger.info('MQTT Bridge started', {
          remoteUrl: config.mqtt.brokerUrl,
        });
      } catch (error) {
        // Bridge failure should not prevent gateway from running
        logger.warn('MQTT Bridge failed to start (non-critical)', {
          error: error.message,
          brokerUrl: config.mqtt.brokerUrl,
        });
        mqttBridge = null;
      }
    }

    logger.info('IVY 4G Gateway started successfully', {
      tcpPort: config.tcp.port,
      mqttPort: config.mqtt.port,
      mqttWsPort: config.mqtt.wsPort,
      httpPort: config.http?.enabled !== false ? config.http.port : 'disabled',
      bridgeUrl: mqttBridge ? config.mqtt.brokerUrl : 'disabled',
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

  // DLMS telemetry from IVY/DLMS meters
  tcpServer.on(SERVER_EVENTS.DLMS_TELEMETRY_RECEIVED, async (data) => {
    // For GET.response, resolve invokeId to OBIS code via polling manager
    if (data.apduType === 'get-response' && data.invokeId != null && pollingManager) {
      const reqInfo = pollingManager.resolveDlmsInvokeId(data.meterId, data.invokeId);
      if (reqInfo && data.telemetry) {
        const obisInfo = lookupObis(reqInfo.obisCode);
        const key = obisInfo?.key || reqInfo.obisCode;
        const value = data.telemetry.data?.value !== undefined ? data.telemetry.data.value : data.telemetry.data;
        data.telemetry.readings[key] = {
          value,
          unit: obisInfo?.unit || '',
          obis: reqInfo.obisCode,
        };
      }
    }

    // Apply OBIS scalers to all readings in-place (synchronously).
    // This must run before any await so that other event listeners
    // (e.g. StatusManager) see correctly scaled values.
    if (data.telemetry?.readings) {
      for (const reading of Object.values(data.telemetry.readings)) {
        if (reading.obis && typeof reading.value === 'number') {
          const obisInfo = lookupObis(reading.obis);
          if (obisInfo?.scaler) {
            reading.value = Math.round(reading.value * obisInfo.scaler * 1000) / 1000;
          }
        }
      }
    }

    logger.debug('DLMS telemetry received', {
      meterId: data.meterId,
      apduType: data.apduType,
      source: data.source,
      readings: data.telemetry?.readings ? Object.keys(data.telemetry.readings) : [],
    });

    // Publish each reading to MQTT (values already scaled above)
    if (telemetryPublisher && data.telemetry?.readings) {
      for (const [key, reading] of Object.entries(data.telemetry.readings)) {
        await telemetryPublisher.publishTelemetry(data.meterId, {
          source: 'dlms',
          register: { key, name: key },
          dataIdFormatted: reading.obis || key,
          value: reading.value,
          unit: reading.unit || '',
          timestamp: data.timestamp,
        });
      }
    }
  });

  // DLMS events from IVY/DLMS meters
  tcpServer.on(SERVER_EVENTS.DLMS_EVENT_RECEIVED, async (data) => {
    logger.info('DLMS event received', {
      meterId: data.meterId,
      eventType: data.eventType,
      source: data.source,
    });

    if (telemetryPublisher) {
      await telemetryPublisher.publishMeterEvent(data.meterId, data.eventType, {
        source: 'dlms',
        ...data.data,
      });
    }
  });

  // DLMS error responses (GET.response errors, etc.)
  tcpServer.on(SERVER_EVENTS.DLMS_ERROR_RECEIVED, async (data) => {
    logger.warn('DLMS error received', {
      meterId: data.meterId,
      invokeId: data.invokeId,
      errorCode: data.errorCode,
      errorName: data.errorName,
    });

    let obisInfo = null;
    if (pollingManager && data.invokeId != null) {
      obisInfo = pollingManager.resolveDlmsInvokeId(data.meterId, data.invokeId);
    }

    if (telemetryPublisher) {
      await telemetryPublisher.publishMeterEvent(data.meterId, 'dlms-error', {
        source: 'dlms',
        apduType: data.apduType,
        invokeId: data.invokeId,
        errorCode: data.errorCode,
        errorName: data.errorName,
        obisCode: obisInfo?.obisCode || null,
        registerName: obisInfo?.name || null,
      });
    }
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
    if (mqttBridge) {
      await mqttBridge.stop();
      logger.info('MQTT Bridge stopped');
    }

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

// Global exception handlers to prevent silent crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  // Give logger time to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error('Unhandled promise rejection', { error: message, stack });
});

// Start application
main();
