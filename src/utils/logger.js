/**
 * Winston logger configuration
 * Provides structured logging with different transports
 */

import winston from 'winston';
import config from '../config/index.js';

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * Custom log format
 */
const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}]: ${message}${metaStr}`;
});

/**
 * Create winston logger instance
 */
const logger = winston.createLogger({
  level: config.logLevel,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    logFormat
  ),
  defaultMeta: { service: config.appName },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        logFormat
      ),
    }),
  ],
});

// Add file transport in production
if (config.env === 'production') {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    })
  );
}

/**
 * Create child logger with additional context
 * @param {Object} meta - Additional metadata
 * @returns {winston.Logger}
 */
export const createChildLogger = (meta) => {
  return logger.child(meta);
};

export default logger;
