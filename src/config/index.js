/**
 * Configuration loader
 * Loads environment variables and provides typed config object
 */

import { config as dotenvConfig } from 'dotenv';

// Load .env file
dotenvConfig();

/**
 * Parse integer with default value
 * @param {string|undefined} value
 * @param {number} defaultValue
 * @returns {number}
 */
const parseIntDefault = (value, defaultValue) => {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
};

/**
 * Application configuration object
 */
export const config = {
  // Application
  env: process.env.NODE_ENV || 'development',
  appName: process.env.APP_NAME || 'ivy-4g-gateway',
  logLevel: process.env.LOG_LEVEL || 'info',

  // TCP Server
  tcp: {
    host: process.env.TCP_HOST || '0.0.0.0',
    port: parseIntDefault(process.env.TCP_PORT, 8899),
    heartbeatInterval: parseIntDefault(process.env.TCP_HEARTBEAT_INTERVAL, 30000),
    connectionTimeout: parseIntDefault(process.env.TCP_CONNECTION_TIMEOUT, 120000),
  },

  // MQTT
  mqtt: {
    // Embedded broker config
    port: parseIntDefault(process.env.MQTT_PORT, 1883),
    host: process.env.MQTT_HOST || '0.0.0.0',
    // Client config (for connecting to external brokers)
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    clientId: process.env.MQTT_CLIENT_ID || `ivy-gateway-${Date.now()}`,
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'metpow/4g',
    // Authentication config
    auth: {
      enabled: process.env.MQTT_AUTH_ENABLED === 'true', // false by default for dev
      allowAnonymous: process.env.MQTT_ALLOW_ANONYMOUS === 'true', // false by default
      users: process.env.MQTT_USERS || '', // Format: "user1:pass1,user2:pass2"
    },
  },

  // Database
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseIntDefault(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'ivy_gateway',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseIntDefault(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || '',
  },

  // Security
  security: {
    aesKey: process.env.AES_ENCRYPTION_KEY || '',
    operatorCode: process.env.METER_OPERATOR_CODE || '00000000',
    password: process.env.METER_PASSWORD || '00000000',
  },

  // Polling
  polling: {
    enabled: process.env.POLLING_ENABLED !== 'false', // true by default
    interval: parseIntDefault(process.env.POLLING_INTERVAL, 60000),
    registerGroup: process.env.POLLING_REGISTER_GROUP || 'energy',
    timeout: parseIntDefault(process.env.POLLING_TIMEOUT, 10000),
    retries: parseIntDefault(process.env.POLLING_RETRIES, 2),
    staggerDelay: parseIntDefault(process.env.POLLING_STAGGER_DELAY, 100),
  },
};

/**
 * Validate required configuration
 * @throws {Error} If required config is missing
 */
export const validateConfig = () => {
  const errors = [];

  if (config.env === 'production') {
    if (!config.security.aesKey) {
      errors.push('AES_ENCRYPTION_KEY is required in production');
    }
    if (!config.mqtt.password) {
      errors.push('MQTT_PASSWORD is required in production');
    }
    if (!config.db.password) {
      errors.push('DB_PASSWORD is required in production');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return true;
};

export default config;
