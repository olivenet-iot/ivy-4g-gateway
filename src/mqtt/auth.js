/**
 * MQTT Authentication & ACL Manager
 *
 * Provides authentication and access control for the MQTT broker.
 * Supports user management, ACL rules, and MQTT topic wildcards.
 *
 * @module mqtt/auth
 */

import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'mqtt-auth' });

/**
 * Default ACL rules for authenticated users
 */
export const DEFAULT_ACL_RULES = [
  {
    id: 'allow-metpow-sub',
    username: '*',
    pattern: 'metpow/#',
    actions: ['subscribe'],
    allow: true,
  },
  {
    id: 'allow-metpow-pub',
    username: '*',
    pattern: 'metpow/#',
    actions: ['publish'],
    allow: true,
  },
];

/**
 * MQTT Authentication & ACL Manager
 */
export class AuthManager {
  /**
   * @param {Object} options - Auth manager options
   * @param {boolean} [options.allowAnonymous=false] - Allow anonymous connections
   * @param {string} [options.users=''] - Users string (format: "user1:pass1,user2:pass2")
   * @param {Object[]} [options.aclRules] - ACL rules
   */
  constructor(options = {}) {
    this.allowAnonymous = options.allowAnonymous || false;

    /** @type {Map<string, {username: string, password: string, roles: string[]}>} */
    this.users = new Map();

    /** @type {Object[]} */
    this.aclRules = options.aclRules || [...DEFAULT_ACL_RULES];

    // Parse users from string
    if (options.users) {
      this.parseUsersString(options.users);
    }

    logger.info('AuthManager created', {
      allowAnonymous: this.allowAnonymous,
      userCount: this.users.size,
      aclRuleCount: this.aclRules.length,
    });
  }

  /**
   * Parse users from string format "user1:pass1,user2:pass2"
   * @param {string} usersString
   * @private
   */
  parseUsersString(usersString) {
    const pairs = usersString.split(',').filter((p) => p.trim());
    for (const pair of pairs) {
      const [username, password] = pair.split(':');
      if (username && password) {
        this.addUser(username.trim(), password.trim(), ['user']);
      }
    }
  }

  // ==========================================================================
  // User Management
  // ==========================================================================

  /**
   * Add a user
   * @param {string} username - Username
   * @param {string} password - Password
   * @param {string[]} [roles=['user']] - User roles
   * @returns {boolean} True if added successfully
   */
  addUser(username, password, roles = ['user']) {
    if (!username || !password) {
      return false;
    }

    this.users.set(username, {
      username,
      password,
      roles,
    });

    logger.debug('User added', { username, roles });
    return true;
  }

  /**
   * Remove a user
   * @param {string} username - Username
   * @returns {boolean} True if removed
   */
  removeUser(username) {
    const deleted = this.users.delete(username);
    if (deleted) {
      logger.debug('User removed', { username });
    }
    return deleted;
  }

  /**
   * Get user info (without password)
   * @param {string} username - Username
   * @returns {Object|null} User info or null
   */
  getUser(username) {
    const user = this.users.get(username);
    if (!user) {
      return null;
    }
    return {
      username: user.username,
      roles: user.roles,
    };
  }

  /**
   * Get all users (without passwords)
   * @returns {Object[]} User list
   */
  getAllUsers() {
    return Array.from(this.users.values()).map((u) => ({
      username: u.username,
      roles: u.roles,
    }));
  }

  // ==========================================================================
  // ACL Management
  // ==========================================================================

  /**
   * Add an ACL rule
   * @param {Object} rule - ACL rule
   * @param {string} rule.id - Rule ID
   * @param {string} rule.username - Username or '*' for all
   * @param {string} rule.pattern - Topic pattern
   * @param {string[]} rule.actions - Actions ['publish', 'subscribe']
   * @param {boolean} rule.allow - Allow or deny
   * @returns {boolean} True if added
   */
  addAclRule(rule) {
    if (!rule.id || !rule.pattern || !rule.actions) {
      return false;
    }

    // Remove existing rule with same ID
    this.removeAclRule(rule.id);

    this.aclRules.push({
      id: rule.id,
      username: rule.username || '*',
      pattern: rule.pattern,
      actions: rule.actions,
      allow: rule.allow !== false,
    });

    logger.debug('ACL rule added', { rule });
    return true;
  }

  /**
   * Remove an ACL rule by ID
   * @param {string} id - Rule ID
   * @returns {boolean} True if removed
   */
  removeAclRule(id) {
    const index = this.aclRules.findIndex((r) => r.id === id);
    if (index >= 0) {
      this.aclRules.splice(index, 1);
      logger.debug('ACL rule removed', { id });
      return true;
    }
    return false;
  }

  /**
   * Get all ACL rules
   * @returns {Object[]} ACL rules
   */
  getAclRules() {
    return [...this.aclRules];
  }

  // ==========================================================================
  // Aedes Auth Callbacks
  // ==========================================================================

  /**
   * Authenticate callback for Aedes
   * @param {Object} client - MQTT client
   * @param {string|undefined} username - Username
   * @param {Buffer|undefined} password - Password
   * @param {Function} callback - Callback(error, success)
   */
  authenticate(client, username, password, callback) {
    // Anonymous connection
    if (!username) {
      if (this.allowAnonymous) {
        logger.debug('Anonymous client authenticated', { clientId: client.id });
        client.username = null;
        return callback(null, true);
      }
      logger.warn('Anonymous client rejected', { clientId: client.id });
      return callback(new Error('Anonymous connections not allowed'), false);
    }

    // Lookup user
    const user = this.users.get(username);
    if (!user) {
      logger.warn('Unknown user rejected', { clientId: client.id, username });
      return callback(new Error('Invalid credentials'), false);
    }

    // Check password
    const passwordStr = password ? password.toString() : '';
    if (user.password !== passwordStr) {
      logger.warn('Invalid password rejected', { clientId: client.id, username });
      return callback(new Error('Invalid credentials'), false);
    }

    // Authentication successful
    client.username = username;
    logger.info('Client authenticated', { clientId: client.id, username });
    return callback(null, true);
  }

  /**
   * Authorize publish callback for Aedes
   * @param {Object} client - MQTT client
   * @param {Object} packet - MQTT packet
   * @param {Function} callback - Callback(error)
   */
  authorizePublish(client, packet, callback) {
    // Internal messages (no client) are always allowed
    if (!client) {
      return callback(null);
    }

    const username = client.username || null;
    const topic = packet.topic;

    // Check ACL
    const allowed = this.checkAcl(username, topic, 'publish');
    if (allowed) {
      logger.debug('Publish authorized', { clientId: client.id, username, topic });
      return callback(null);
    }

    logger.warn('Publish denied', { clientId: client.id, username, topic });
    return callback(new Error('Not authorized'));
  }

  /**
   * Authorize subscribe callback for Aedes
   * @param {Object} client - MQTT client
   * @param {Object} subscription - Subscription object
   * @param {Function} callback - Callback(error, subscription)
   */
  authorizeSubscribe(client, subscription, callback) {
    const username = client.username || null;
    const topic = subscription.topic;

    // Check ACL
    const allowed = this.checkAcl(username, topic, 'subscribe');
    if (allowed) {
      logger.debug('Subscribe authorized', { clientId: client.id, username, topic });
      return callback(null, subscription);
    }

    logger.warn('Subscribe denied', { clientId: client.id, username, topic });
    return callback(new Error('Not authorized'));
  }

  // ==========================================================================
  // ACL Checking
  // ==========================================================================

  /**
   * Check if action is allowed by ACL rules
   * @param {string|null} username - Username (null for anonymous)
   * @param {string} topic - MQTT topic
   * @param {string} action - Action ('publish' or 'subscribe')
   * @returns {boolean} True if allowed
   */
  checkAcl(username, topic, action) {
    // Find matching rules (most specific first)
    for (const rule of this.aclRules) {
      // Check if rule applies to this user
      if (rule.username !== '*' && rule.username !== username) {
        continue;
      }

      // Check if rule applies to anonymous users
      if (username === null && rule.username !== '*') {
        continue;
      }

      // Check if rule applies to this action
      if (!rule.actions.includes(action)) {
        continue;
      }

      // Check if topic matches pattern
      if (this.topicMatches(rule.pattern, topic)) {
        return rule.allow;
      }
    }

    // Default: deny
    return false;
  }

  /**
   * Check if topic matches MQTT pattern
   * Supports + (single-level) and # (multi-level) wildcards
   * @param {string} pattern - Topic pattern
   * @param {string} topic - Topic to match
   * @returns {boolean} True if matches
   */
  topicMatches(pattern, topic) {
    // Exact match
    if (pattern === topic) {
      return true;
    }

    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i];

      // Multi-level wildcard matches everything after
      if (patternPart === '#') {
        return true;
      }

      // No more topic parts to match
      if (i >= topicParts.length) {
        return false;
      }

      const topicPart = topicParts[i];

      // Single-level wildcard matches one level
      if (patternPart === '+') {
        continue;
      }

      // Exact match required
      if (patternPart !== topicPart) {
        return false;
      }
    }

    // All pattern parts matched, check if topic has extra parts
    return patternParts.length === topicParts.length;
  }
}

/**
 * Create a new AuthManager instance
 * @param {Object} [options] - Options
 * @returns {AuthManager}
 */
export const createAuthManager = (options) => {
  return new AuthManager(options);
};

export default {
  AuthManager,
  createAuthManager,
  DEFAULT_ACL_RULES,
};
