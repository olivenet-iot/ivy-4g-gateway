/**
 * HTTP Security Middleware
 *
 * Basic security headers and protections for the dashboard.
 *
 * @module http/security
 */

/**
 * Security headers middleware
 * @returns {Function} Express middleware
 */
export function securityHeaders() {
  return (req, res, next) => {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // XSS Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Content Security Policy (allow CDN for Bootstrap/MQTT.js)
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
        "font-src 'self' https://cdn.jsdelivr.net",
      ].join('; ')
    );

    next();
  };
}

/**
 * Request logging middleware
 * @param {Object} logger - Logger instance
 * @returns {Function} Express middleware
 */
export function requestLogger(logger) {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.debug('HTTP request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
        ip: req.ip || req.connection.remoteAddress,
      });
    });

    next();
  };
}

/**
 * Basic rate limiting for HTTP
 * @param {Object} options - Rate limiter options
 * @param {number} [options.windowMs=60000] - Time window in ms
 * @param {number} [options.maxRequests=100] - Max requests per window
 * @returns {Function} Express middleware
 */
export function httpRateLimiter(options = {}) {
  const windowMs = options.windowMs ?? 60000;
  const maxRequests = options.maxRequests ?? 100;
  const requests = new Map();

  // Cleanup every minute
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of requests) {
      if (now - data.windowStart > windowMs) {
        requests.delete(ip);
      }
    }
  }, 60000);

  // Prevent interval from keeping process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    let data = requests.get(ip);
    if (!data || now - data.windowStart > windowMs) {
      data = { windowStart: now, count: 0 };
      requests.set(ip, data);
    }

    data.count++;

    if (data.count > maxRequests) {
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: Math.ceil((data.windowStart + windowMs - now) / 1000),
      });
      return;
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - data.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((data.windowStart + windowMs) / 1000));

    next();
  };
}

export default { securityHeaders, requestLogger, httpRateLimiter };
