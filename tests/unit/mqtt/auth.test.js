/**
 * MQTT Auth Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuthManager,
  createAuthManager,
  DEFAULT_ACL_RULES,
} from '../../../src/mqtt/auth.js';

describe('MQTT Auth', () => {
  describe('DEFAULT_ACL_RULES', () => {
    it('should have default rules for metpow topics', () => {
      expect(DEFAULT_ACL_RULES).toHaveLength(2);
      expect(DEFAULT_ACL_RULES[0].pattern).toBe('metpow/#');
      expect(DEFAULT_ACL_RULES[1].pattern).toBe('metpow/#');
    });
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      const auth = new AuthManager();

      expect(auth.allowAnonymous).toBe(false);
      expect(auth.getAllUsers()).toHaveLength(0);
      expect(auth.getAclRules()).toHaveLength(2); // Default rules
    });

    it('should accept allowAnonymous option', () => {
      const auth = new AuthManager({ allowAnonymous: true });

      expect(auth.allowAnonymous).toBe(true);
    });

    it('should parse users from string', () => {
      const auth = new AuthManager({
        users: 'admin:secret,user1:pass1,user2:pass2',
      });

      expect(auth.getAllUsers()).toHaveLength(3);
      expect(auth.getUser('admin')).toEqual({ username: 'admin', roles: ['user'] });
      expect(auth.getUser('user1')).toEqual({ username: 'user1', roles: ['user'] });
    });

    it('should handle empty users string', () => {
      const auth = new AuthManager({ users: '' });

      expect(auth.getAllUsers()).toHaveLength(0);
    });

    it('should accept custom ACL rules', () => {
      const customRules = [
        { id: 'test-rule', username: '*', pattern: 'test/#', actions: ['subscribe'], allow: true },
      ];
      const auth = new AuthManager({ aclRules: customRules });

      expect(auth.getAclRules()).toHaveLength(1);
      expect(auth.getAclRules()[0].id).toBe('test-rule');
    });
  });

  describe('User Management', () => {
    let auth;

    beforeEach(() => {
      auth = new AuthManager();
    });

    describe('addUser', () => {
      it('should add user with default roles', () => {
        const result = auth.addUser('testuser', 'password');

        expect(result).toBe(true);
        expect(auth.getUser('testuser')).toEqual({
          username: 'testuser',
          roles: ['user'],
        });
      });

      it('should add user with custom roles', () => {
        auth.addUser('admin', 'secret', ['admin', 'user']);

        expect(auth.getUser('admin').roles).toEqual(['admin', 'user']);
      });

      it('should reject empty username', () => {
        expect(auth.addUser('', 'password')).toBe(false);
      });

      it('should reject empty password', () => {
        expect(auth.addUser('user', '')).toBe(false);
      });
    });

    describe('removeUser', () => {
      it('should remove existing user', () => {
        auth.addUser('testuser', 'password');
        const result = auth.removeUser('testuser');

        expect(result).toBe(true);
        expect(auth.getUser('testuser')).toBeNull();
      });

      it('should return false for non-existing user', () => {
        expect(auth.removeUser('nonexistent')).toBe(false);
      });
    });

    describe('getUser', () => {
      it('should return user info without password', () => {
        auth.addUser('testuser', 'secret123', ['admin']);

        const user = auth.getUser('testuser');

        expect(user.username).toBe('testuser');
        expect(user.roles).toEqual(['admin']);
        expect(user.password).toBeUndefined();
      });

      it('should return null for non-existing user', () => {
        expect(auth.getUser('nonexistent')).toBeNull();
      });
    });

    describe('getAllUsers', () => {
      it('should return all users without passwords', () => {
        auth.addUser('user1', 'pass1');
        auth.addUser('user2', 'pass2');

        const users = auth.getAllUsers();

        expect(users).toHaveLength(2);
        expect(users[0].password).toBeUndefined();
        expect(users[1].password).toBeUndefined();
      });
    });
  });

  describe('ACL Rules', () => {
    let auth;

    beforeEach(() => {
      auth = new AuthManager({ aclRules: [] });
    });

    describe('addAclRule', () => {
      it('should add valid rule', () => {
        const result = auth.addAclRule({
          id: 'test-rule',
          username: '*',
          pattern: 'test/#',
          actions: ['subscribe'],
          allow: true,
        });

        expect(result).toBe(true);
        expect(auth.getAclRules()).toHaveLength(1);
      });

      it('should reject rule without id', () => {
        const result = auth.addAclRule({
          pattern: 'test/#',
          actions: ['subscribe'],
        });

        expect(result).toBe(false);
      });

      it('should reject rule without pattern', () => {
        const result = auth.addAclRule({
          id: 'test',
          actions: ['subscribe'],
        });

        expect(result).toBe(false);
      });

      it('should reject rule without actions', () => {
        const result = auth.addAclRule({
          id: 'test',
          pattern: 'test/#',
        });

        expect(result).toBe(false);
      });

      it('should replace existing rule with same id', () => {
        auth.addAclRule({ id: 'test', pattern: 'old/#', actions: ['subscribe'], allow: true });
        auth.addAclRule({ id: 'test', pattern: 'new/#', actions: ['publish'], allow: false });

        const rules = auth.getAclRules();
        expect(rules).toHaveLength(1);
        expect(rules[0].pattern).toBe('new/#');
      });

      it('should default allow to true', () => {
        auth.addAclRule({ id: 'test', pattern: 'test/#', actions: ['subscribe'] });

        expect(auth.getAclRules()[0].allow).toBe(true);
      });

      it('should default username to *', () => {
        auth.addAclRule({ id: 'test', pattern: 'test/#', actions: ['subscribe'] });

        expect(auth.getAclRules()[0].username).toBe('*');
      });
    });

    describe('removeAclRule', () => {
      it('should remove existing rule', () => {
        auth.addAclRule({ id: 'test', pattern: 'test/#', actions: ['subscribe'] });
        const result = auth.removeAclRule('test');

        expect(result).toBe(true);
        expect(auth.getAclRules()).toHaveLength(0);
      });

      it('should return false for non-existing rule', () => {
        expect(auth.removeAclRule('nonexistent')).toBe(false);
      });
    });

    describe('getAclRules', () => {
      it('should return copy of rules', () => {
        auth.addAclRule({ id: 'test', pattern: 'test/#', actions: ['subscribe'] });

        const rules = auth.getAclRules();
        rules.push({ id: 'fake' });

        expect(auth.getAclRules()).toHaveLength(1);
      });
    });
  });

  describe('authenticate', () => {
    let auth;

    beforeEach(() => {
      auth = new AuthManager({
        users: 'admin:secret,user1:pass1',
      });
    });

    it('should authenticate valid credentials', async () => {
      const client = { id: 'test-client' };

      await new Promise((resolve) => {
        auth.authenticate(client, 'admin', Buffer.from('secret'), (error, success) => {
          expect(error).toBeNull();
          expect(success).toBe(true);
          expect(client.username).toBe('admin');
          resolve();
        });
      });
    });

    it('should reject invalid password', async () => {
      const client = { id: 'test-client' };

      await new Promise((resolve) => {
        auth.authenticate(client, 'admin', Buffer.from('wrong'), (error, success) => {
          expect(error).toBeInstanceOf(Error);
          expect(success).toBe(false);
          resolve();
        });
      });
    });

    it('should reject unknown user', async () => {
      const client = { id: 'test-client' };

      await new Promise((resolve) => {
        auth.authenticate(client, 'unknown', Buffer.from('pass'), (error, success) => {
          expect(error).toBeInstanceOf(Error);
          expect(success).toBe(false);
          resolve();
        });
      });
    });

    it('should reject anonymous when not allowed', async () => {
      const client = { id: 'test-client' };

      await new Promise((resolve) => {
        auth.authenticate(client, undefined, undefined, (error, success) => {
          expect(error).toBeInstanceOf(Error);
          expect(success).toBe(false);
          resolve();
        });
      });
    });

    it('should allow anonymous when enabled', async () => {
      auth = new AuthManager({ allowAnonymous: true });
      const client = { id: 'test-client' };

      await new Promise((resolve) => {
        auth.authenticate(client, undefined, undefined, (error, success) => {
          expect(error).toBeNull();
          expect(success).toBe(true);
          expect(client.username).toBeNull();
          resolve();
        });
      });
    });

    it('should handle string password', async () => {
      const client = { id: 'test-client' };

      await new Promise((resolve) => {
        auth.authenticate(client, 'admin', 'secret', (error, success) => {
          expect(error).toBeNull();
          expect(success).toBe(true);
          resolve();
        });
      });
    });
  });

  describe('authorizePublish', () => {
    let auth;

    beforeEach(() => {
      auth = new AuthManager({
        aclRules: [
          { id: 'allow-test', username: '*', pattern: 'test/#', actions: ['publish'], allow: true },
          { id: 'deny-secret', username: '*', pattern: 'secret/#', actions: ['publish'], allow: false },
        ],
      });
    });

    it('should allow publish to permitted topic', async () => {
      const client = { id: 'test-client', username: 'user1' };
      const packet = { topic: 'test/data' };

      await new Promise((resolve) => {
        auth.authorizePublish(client, packet, (error) => {
          expect(error).toBeNull();
          resolve();
        });
      });
    });

    it('should deny publish to restricted topic', async () => {
      const client = { id: 'test-client', username: 'user1' };
      const packet = { topic: 'secret/data' };

      await new Promise((resolve) => {
        auth.authorizePublish(client, packet, (error) => {
          expect(error).toBeInstanceOf(Error);
          resolve();
        });
      });
    });

    it('should deny publish to unmatched topic', async () => {
      const client = { id: 'test-client', username: 'user1' };
      const packet = { topic: 'other/topic' };

      await new Promise((resolve) => {
        auth.authorizePublish(client, packet, (error) => {
          expect(error).toBeInstanceOf(Error);
          resolve();
        });
      });
    });

    it('should allow internal messages without client', async () => {
      const packet = { topic: 'any/topic' };

      await new Promise((resolve) => {
        auth.authorizePublish(null, packet, (error) => {
          expect(error).toBeNull();
          resolve();
        });
      });
    });
  });

  describe('authorizeSubscribe', () => {
    let auth;

    beforeEach(() => {
      auth = new AuthManager({
        aclRules: [
          { id: 'allow-test', username: '*', pattern: 'test/#', actions: ['subscribe'], allow: true },
          { id: 'deny-secret', username: '*', pattern: 'secret/#', actions: ['subscribe'], allow: false },
        ],
      });
    });

    it('should allow subscribe to permitted topic', async () => {
      const client = { id: 'test-client', username: 'user1' };
      const subscription = { topic: 'test/data' };

      await new Promise((resolve) => {
        auth.authorizeSubscribe(client, subscription, (error, sub) => {
          expect(error).toBeNull();
          expect(sub).toBe(subscription);
          resolve();
        });
      });
    });

    it('should deny subscribe to restricted topic', async () => {
      const client = { id: 'test-client', username: 'user1' };
      const subscription = { topic: 'secret/data' };

      await new Promise((resolve) => {
        auth.authorizeSubscribe(client, subscription, (error, _sub) => {
          expect(error).toBeInstanceOf(Error);
          resolve();
        });
      });
    });

    it('should deny subscribe to unmatched topic', async () => {
      const client = { id: 'test-client', username: 'user1' };
      const subscription = { topic: 'other/topic' };

      await new Promise((resolve) => {
        auth.authorizeSubscribe(client, subscription, (error, _sub) => {
          expect(error).toBeInstanceOf(Error);
          resolve();
        });
      });
    });
  });

  describe('checkAcl', () => {
    it('should match user-specific rules', () => {
      const auth = new AuthManager({
        aclRules: [
          { id: 'admin-only', username: 'admin', pattern: 'admin/#', actions: ['publish'], allow: true },
        ],
      });

      expect(auth.checkAcl('admin', 'admin/test', 'publish')).toBe(true);
      expect(auth.checkAcl('user', 'admin/test', 'publish')).toBe(false);
    });

    it('should match wildcard user rules', () => {
      const auth = new AuthManager({
        aclRules: [
          { id: 'all-users', username: '*', pattern: 'public/#', actions: ['subscribe'], allow: true },
        ],
      });

      expect(auth.checkAcl('user1', 'public/test', 'subscribe')).toBe(true);
      expect(auth.checkAcl('user2', 'public/test', 'subscribe')).toBe(true);
    });

    it('should check action type', () => {
      const auth = new AuthManager({
        aclRules: [
          { id: 'sub-only', username: '*', pattern: 'readonly/#', actions: ['subscribe'], allow: true },
        ],
      });

      expect(auth.checkAcl('user', 'readonly/test', 'subscribe')).toBe(true);
      expect(auth.checkAcl('user', 'readonly/test', 'publish')).toBe(false);
    });

    it('should default to deny', () => {
      const auth = new AuthManager({ aclRules: [] });

      expect(auth.checkAcl('user', 'any/topic', 'publish')).toBe(false);
    });
  });

  describe('topicMatches', () => {
    let auth;

    beforeEach(() => {
      auth = new AuthManager();
    });

    it('should match exact topics', () => {
      expect(auth.topicMatches('test/topic', 'test/topic')).toBe(true);
      expect(auth.topicMatches('test/topic', 'test/other')).toBe(false);
    });

    it('should match single-level wildcard (+)', () => {
      expect(auth.topicMatches('test/+/data', 'test/sensor1/data')).toBe(true);
      expect(auth.topicMatches('test/+/data', 'test/sensor2/data')).toBe(true);
      expect(auth.topicMatches('test/+/data', 'test/sensor/other')).toBe(false);
      expect(auth.topicMatches('test/+/data', 'test/a/b/data')).toBe(false);
    });

    it('should match multi-level wildcard (#)', () => {
      expect(auth.topicMatches('test/#', 'test/sensor')).toBe(true);
      expect(auth.topicMatches('test/#', 'test/sensor/data')).toBe(true);
      expect(auth.topicMatches('test/#', 'test/a/b/c/d')).toBe(true);
      expect(auth.topicMatches('test/#', 'other/topic')).toBe(false);
    });

    it('should handle # at end only', () => {
      expect(auth.topicMatches('metpow/#', 'metpow/meter1/telemetry')).toBe(true);
      expect(auth.topicMatches('#', 'any/topic')).toBe(true);
    });

    it('should handle + with multiple levels', () => {
      expect(auth.topicMatches('+/+/data', 'a/b/data')).toBe(true);
      expect(auth.topicMatches('+/+/data', 'x/y/data')).toBe(true);
      expect(auth.topicMatches('+/+/data', 'a/b/c')).toBe(false);
    });

    it('should not match shorter topics than pattern', () => {
      expect(auth.topicMatches('test/a/b', 'test/a')).toBe(false);
      expect(auth.topicMatches('test/+/b', 'test/a')).toBe(false);
    });

    it('should not match longer topics than pattern without #', () => {
      expect(auth.topicMatches('test/a', 'test/a/b')).toBe(false);
      expect(auth.topicMatches('test/+', 'test/a/b')).toBe(false);
    });
  });

  describe('createAuthManager', () => {
    it('should create AuthManager instance', () => {
      const auth = createAuthManager();

      expect(auth).toBeInstanceOf(AuthManager);
    });

    it('should pass options to constructor', () => {
      const auth = createAuthManager({
        allowAnonymous: true,
        users: 'test:pass',
      });

      expect(auth.allowAnonymous).toBe(true);
      expect(auth.getAllUsers()).toHaveLength(1);
    });
  });
});
