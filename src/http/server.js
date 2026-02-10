/**
 * HTTP Server
 *
 * Serves static files and REST API endpoints for the monitoring dashboard.
 *
 * @module http/server
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { securityHeaders, httpRateLimiter } from './security.js';

const logger = createChildLogger({ module: 'http-server' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json once at startup
let packageVersion = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  packageVersion = pkg.version || '0.1.0';
} catch {
  // fallback to hardcoded
}

/**
 * Create HTTP server
 * @param {Object} options - Server options
 * @param {number} [options.port] - HTTP port
 * @param {Object} [options.tcpServer] - TCP server instance
 * @param {Object} [options.publisher] - Telemetry publisher instance
 * @param {Object} [options.statusManager] - Status manager instance
 * @param {Object} [options.pollingManager] - Polling manager instance
 * @param {Object} [options.commandHandler] - Command handler instance
 * @returns {Object} Server instance
 */
export function createHttpServer(options = {}) {
  const app = express();
  const port = options.port || config.http?.port || 3000;

  const tcpServer = options.tcpServer || null;
  const publisher = options.publisher || null;
  const statusManager = options.statusManager || null;
  const pollingManager = options.pollingManager || null;
  const commandHandler = options.commandHandler || null;

  // Apply security middleware
  app.use(securityHeaders());
  app.use(httpRateLimiter({
    maxRequests: config.security?.http?.maxRequestsPerMinute || 100,
  }));

  // Parse JSON bodies for POST endpoints
  app.use(express.json());

  // Serve static files from public directory
  const publicPath = join(__dirname, '../../public');
  app.use(express.static(publicPath));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // API info endpoint
  app.get('/api/info', (req, res) => {
    res.json({
      name: 'IVY 4G Gateway',
      version: packageVersion,
      mqtt: {
        port: config.mqtt?.port || 1883,
        wsPort: config.mqtt?.wsPort || 9001,
      },
      tcp: {
        port: config.tcp?.port || 8899,
      },
      uptime: process.uptime(),
    });
  });

  // --- REST API endpoints ---

  // GET /api/meters - List all connected meters with details
  app.get('/api/meters', (req, res) => {
    if (!tcpServer?.connectionManager) {
      return res.json({ meters: [] });
    }

    const connections = tcpServer.connectionManager.connections;
    const meters = [];

    for (const [, conn] of connections) {
      if (conn.meterId) {
        meters.push({
          meterId: conn.meterId,
          online: conn.state !== 'disconnected',
          state: conn.state,
          protocolType: conn.protocolType || null,
          remoteAddress: conn.remoteAddress,
          connectedAt: conn.connectedAt,
          lastActivity: conn.lastActivity,
          bytesReceived: conn.bytesReceived || 0,
          bytesSent: conn.bytesSent || 0,
        });
      }
    }

    // Also include last telemetry from publisher
    if (publisher) {
      for (const meter of meters) {
        const lastTelemetry = publisher.getLastTelemetry(meter.meterId);
        if (lastTelemetry) {
          meter.lastTelemetry = lastTelemetry;
        }
      }
    }

    res.json({ meters });
  });

  // GET /api/meters/:meterId - Single meter detail
  app.get('/api/meters/:meterId', (req, res) => {
    const { meterId } = req.params;

    let meterInfo = null;

    if (tcpServer?.connectionManager) {
      const conn = tcpServer.connectionManager.getConnectionByMeter(meterId);
      if (conn) {
        meterInfo = {
          meterId: conn.meterId,
          online: conn.state !== 'disconnected',
          state: conn.state,
          protocolType: conn.protocolType || null,
          remoteAddress: conn.remoteAddress,
          connectedAt: conn.connectedAt,
          lastActivity: conn.lastActivity,
          bytesReceived: conn.bytesReceived || 0,
          bytesSent: conn.bytesSent || 0,
        };
      }
    }

    if (!meterInfo) {
      return res.status(404).json({ error: 'Meter not found' });
    }

    // Include last telemetry
    if (publisher) {
      const lastTelemetry = publisher.getLastTelemetry(meterId);
      if (lastTelemetry) {
        meterInfo.lastTelemetry = lastTelemetry;
      }
    }

    // Include status info
    if (statusManager) {
      const meterStatus = statusManager.getMeterStatus(meterId);
      if (meterStatus) {
        meterInfo.status = meterStatus;
      }
      meterInfo.alarms = statusManager.getActiveAlarms(meterId);
    }

    res.json(meterInfo);
  });

  // GET /api/stats - Gateway statistics
  app.get('/api/stats', (req, res) => {
    const stats = {
      uptime: process.uptime(),
      version: packageVersion,
      memory: {
        heapUsed: process.memoryUsage().heapUsed,
        heapTotal: process.memoryUsage().heapTotal,
        rss: process.memoryUsage().rss,
      },
    };

    if (tcpServer) {
      stats.tcp = tcpServer.getStats();
    }
    if (publisher) {
      stats.publisher = publisher.getStats();
    }
    if (statusManager) {
      stats.status = statusManager.getStats();
    }
    if (pollingManager) {
      stats.polling = pollingManager.getStats();
    }
    if (commandHandler) {
      stats.commands = commandHandler.getStats();
    }

    res.json(stats);
  });

  // GET /api/alarms - Active alarms
  app.get('/api/alarms', (req, res) => {
    if (!statusManager) {
      return res.json({ alarms: [], events: [] });
    }

    res.json({
      alarms: statusManager.getActiveAlarms(),
      events: statusManager.getRecentEvents(50),
    });
  });

  // GET /api/telemetry - Latest telemetry for all meters
  app.get('/api/telemetry', (req, res) => {
    if (!publisher) {
      return res.json({ telemetry: {} });
    }

    res.json({ telemetry: publisher.getAllLastTelemetry() });
  });

  let server = null;

  return {
    /**
     * Start the HTTP server
     * @returns {Promise<void>}
     */
    start() {
      return new Promise((resolve, reject) => {
        server = app.listen(port, () => {
          logger.info('HTTP server started', { port });
          resolve();
        });
        server.on('error', reject);
      });
    },

    /**
     * Stop the HTTP server
     * @returns {Promise<void>}
     */
    stop() {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => {
            logger.info('HTTP server stopped');
            resolve();
          });
        } else {
          resolve();
        }
      });
    },

    /**
     * Get server port
     * @returns {number}
     */
    getPort() {
      return port;
    },

    /**
     * Get Express app
     * @returns {express.Application}
     */
    getApp() {
      return app;
    },
  };
}

export default { createHttpServer };
