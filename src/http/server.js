/**
 * HTTP Server
 *
 * Serves static files for the monitoring dashboard.
 *
 * @module http/server
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createChildLogger } from '../utils/logger.js';
import config from '../config/index.js';
import { securityHeaders, httpRateLimiter } from './security.js';

const logger = createChildLogger({ module: 'http-server' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create HTTP server
 * @param {Object} options - Server options
 * @param {number} [options.port] - HTTP port
 * @returns {Object} Server instance
 */
export function createHttpServer(options = {}) {
  const app = express();
  const port = options.port || config.http?.port || 3000;

  // Apply security middleware
  app.use(securityHeaders());
  app.use(httpRateLimiter({
    maxRequests: config.security?.http?.maxRequestsPerMinute || 100,
  }));

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
      version: '0.1.0',
      mqtt: {
        port: config.mqtt?.port || 1883,
        wsPort: config.mqtt?.wsPort || 9001,
      },
      tcp: {
        port: config.tcp?.port || 8899,
      },
    });
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
