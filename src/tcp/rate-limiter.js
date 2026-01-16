/**
 * TCP Rate Limiter
 *
 * Prevents abuse by limiting connection attempts per IP.
 *
 * @module tcp/rate-limiter
 */

import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'rate-limiter' });

/**
 * Rate limiter for TCP connections
 */
export class RateLimiter {
  /**
   * @param {Object} options
   * @param {number} [options.maxConnectionsPerIP=10] - Max connections per IP
   * @param {number} [options.windowMs=60000] - Time window in ms
   * @param {number} [options.maxConnectionAttempts=20] - Max attempts per window
   * @param {number} [options.blockDuration=300000] - Block duration (5 min)
   */
  constructor(options = {}) {
    this.maxConnectionsPerIP = options.maxConnectionsPerIP ?? 10;
    this.windowMs = options.windowMs ?? 60000;
    this.maxConnectionAttempts = options.maxConnectionAttempts ?? 20;
    this.blockDuration = options.blockDuration ?? 300000;

    /** @type {Map<string, number>} Active connections per IP */
    this.activeConnections = new Map();

    /** @type {Map<string, number[]>} Connection attempts timestamps */
    this.connectionAttempts = new Map();

    /** @type {Map<string, number>} Blocked IPs with unblock time */
    this.blockedIPs = new Map();

    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);

    logger.info('RateLimiter created', {
      maxConnectionsPerIP: this.maxConnectionsPerIP,
      maxConnectionAttempts: this.maxConnectionAttempts,
      windowMs: this.windowMs,
    });
  }

  /**
   * Check if connection should be allowed
   * @param {string} ip - Remote IP address
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkConnection(ip) {
    // Check if IP is blocked
    const blockedUntil = this.blockedIPs.get(ip);
    if (blockedUntil && Date.now() < blockedUntil) {
      const remainingSeconds = Math.ceil((blockedUntil - Date.now()) / 1000);
      logger.warn('Blocked IP attempted connection', { ip, remainingSeconds });
      return { allowed: false, reason: `IP blocked for ${remainingSeconds}s` };
    } else if (blockedUntil) {
      this.blockedIPs.delete(ip);
    }

    // Check active connections limit
    const activeCount = this.activeConnections.get(ip) || 0;
    if (activeCount >= this.maxConnectionsPerIP) {
      logger.warn('Max connections per IP exceeded', { ip, activeCount });
      return { allowed: false, reason: 'Max connections per IP exceeded' };
    }

    // Check connection rate
    const now = Date.now();
    const attempts = this.connectionAttempts.get(ip) || [];
    const recentAttempts = attempts.filter((t) => now - t < this.windowMs);

    if (recentAttempts.length >= this.maxConnectionAttempts) {
      // Block the IP
      this.blockedIPs.set(ip, now + this.blockDuration);
      logger.warn('IP blocked due to excessive connection attempts', {
        ip,
        attempts: recentAttempts.length,
        blockDuration: this.blockDuration,
      });
      return { allowed: false, reason: 'Too many connection attempts' };
    }

    // Record attempt
    recentAttempts.push(now);
    this.connectionAttempts.set(ip, recentAttempts);

    return { allowed: true };
  }

  /**
   * Record new connection
   * @param {string} ip - Remote IP
   */
  onConnect(ip) {
    const count = this.activeConnections.get(ip) || 0;
    this.activeConnections.set(ip, count + 1);
  }

  /**
   * Record connection closed
   * @param {string} ip - Remote IP
   */
  onDisconnect(ip) {
    const count = this.activeConnections.get(ip) || 0;
    if (count <= 1) {
      this.activeConnections.delete(ip);
    } else {
      this.activeConnections.set(ip, count - 1);
    }
  }

  /**
   * Manually block an IP
   * @param {string} ip - IP to block
   * @param {number} [duration] - Duration in ms
   */
  blockIP(ip, duration = this.blockDuration) {
    this.blockedIPs.set(ip, Date.now() + duration);
    logger.info('IP manually blocked', { ip, duration });
  }

  /**
   * Unblock an IP
   * @param {string} ip - IP to unblock
   */
  unblockIP(ip) {
    this.blockedIPs.delete(ip);
    logger.info('IP unblocked', { ip });
  }

  /**
   * Get blocked IPs list
   * @returns {Object[]}
   */
  getBlockedIPs() {
    const blocked = [];
    const now = Date.now();
    for (const [ip, until] of this.blockedIPs) {
      if (until > now) {
        blocked.push({ ip, until, remainingMs: until - now });
      }
    }
    return blocked;
  }

  /**
   * Get stats
   * @returns {Object}
   */
  getStats() {
    return {
      activeConnectionsByIP: this.activeConnections.size,
      totalActiveConnections: Array.from(this.activeConnections.values()).reduce(
        (a, b) => a + b,
        0
      ),
      blockedIPs: this.blockedIPs.size,
      trackedIPs: this.connectionAttempts.size,
    };
  }

  /**
   * Cleanup old data
   * @private
   */
  cleanup() {
    const now = Date.now();

    // Clean old connection attempts
    for (const [ip, attempts] of this.connectionAttempts) {
      const recent = attempts.filter((t) => now - t < this.windowMs);
      if (recent.length === 0) {
        this.connectionAttempts.delete(ip);
      } else {
        this.connectionAttempts.set(ip, recent);
      }
    }

    // Clean expired blocks
    for (const [ip, until] of this.blockedIPs) {
      if (until <= now) {
        this.blockedIPs.delete(ip);
      }
    }
  }

  /**
   * Stop the rate limiter
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Create rate limiter instance
 * @param {Object} options
 * @returns {RateLimiter}
 */
export const createRateLimiter = (options) => new RateLimiter(options);

export default { RateLimiter, createRateLimiter };
