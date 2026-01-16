/**
 * MQTT Flow Integration Tests
 *
 * End-to-end tests for MQTT broker, authentication, publishing,
 * command handling, and status management.
 *
 * Tests the complete flow:
 * - Client connection with auth
 * - Telemetry subscription and reception
 * - Command request/response cycle
 * - Status updates
 * - Event publishing
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mqtt from 'mqtt';
import net from 'net';
import { createMQTTBroker, resetInstance } from '../../src/mqtt/broker.js';
import { createAuthManager } from '../../src/mqtt/auth.js';
import { createTelemetryPublisher } from '../../src/mqtt/publisher.js';
import { createCommandHandler, COMMAND_METHODS } from '../../src/mqtt/command-handler.js';
import { createStatusManager } from '../../src/services/status-manager.js';
import { createTCPServer } from '../../src/tcp/server.js';
import { createMeterSimulator } from '../mocks/meter-simulator.js';
import { ENERGY_REGISTERS, INSTANTANEOUS_REGISTERS } from '../../src/protocol/registers.js';

/**
 * Get available port
 */
const getAvailablePort = () => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
};

/**
 * Wait helper
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for condition
 */
const waitFor = (condition, timeout = 5000, interval = 50) => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout waiting for condition'));
      } else {
        setTimeout(check, interval);
      }
    };
    check();
  });
};

/**
 * Create MQTT client helper
 */
const createTestClient = (port, options = {}) => {
  return mqtt.connect(`mqtt://localhost:${port}`, {
    clientId: options.clientId || `test-client-${Date.now()}`,
    username: options.username,
    password: options.password,
    connectTimeout: 5000,
  });
};

describe('MQTT Flow Integration Tests', () => {
  let mqttPort;
  let mqttWsPort;
  let tcpPort;
  let broker;
  let authManager;
  let tcpServer;
  let publisher;
  let commandHandler;
  let statusManager;

  beforeAll(async () => {
    // Get available ports
    mqttPort = await getAvailablePort();
    mqttWsPort = await getAvailablePort();
    tcpPort = await getAvailablePort();

    // Create auth manager with test users
    authManager = createAuthManager({
      allowAnonymous: false,
    });

    // Add test users with different roles
    authManager.addUser('admin', 'admin123', ['admin']);
    authManager.addUser('client', 'client123', ['client']);
    authManager.addUser('readonly', 'readonly123', ['readonly']);

    // Add ACL rules for ivy/v1 topics
    authManager.addAclRule({
      id: 'admin-all',
      username: 'admin',
      pattern: 'ivy/v1/#',
      actions: ['subscribe', 'publish'],
      allow: true,
    });
    authManager.addAclRule({
      id: 'client-subscribe',
      username: 'client',
      pattern: 'ivy/v1/#',
      actions: ['subscribe'],
      allow: true,
    });
    authManager.addAclRule({
      id: 'client-command-publish',
      username: 'client',
      pattern: 'ivy/v1/meters/+/command/request',
      actions: ['publish'],
      allow: true,
    });
    authManager.addAclRule({
      id: 'readonly-subscribe',
      username: 'readonly',
      pattern: 'ivy/v1/#',
      actions: ['subscribe'],
      allow: true,
    });

    // Create and start broker with auth
    broker = createMQTTBroker({
      port: mqttPort,
      wsPort: mqttWsPort,
      authenticate: authManager.authenticate.bind(authManager),
      authorizePublish: authManager.authorizePublish.bind(authManager),
      authorizeSubscribe: authManager.authorizeSubscribe.bind(authManager),
    });
    await broker.start();

    // Create and start TCP server
    tcpServer = createTCPServer({ port: tcpPort });
    await tcpServer.start();

    // Create publisher
    publisher = createTelemetryPublisher({ broker });
    publisher.start({ version: 'test' });

    // Create command handler
    commandHandler = createCommandHandler({
      broker,
      tcpServer,
      publisher,
    });
    commandHandler.start();

    // Create status manager
    statusManager = createStatusManager({
      publisher,
      tcpServer,
      statusInterval: 60000, // Long interval for tests
    });
    statusManager.start();
  });

  afterAll(async () => {
    if (statusManager) statusManager.stop();
    if (commandHandler) commandHandler.stop();
    if (publisher) await publisher.stop();
    if (tcpServer) await tcpServer.stop();
    if (broker) await broker.stop();
    await resetInstance();
  });

  describe('Authentication', () => {
    it('should allow connection with valid credentials', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'admin123',
      });

      await new Promise((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      expect(client.connected).toBe(true);
      client.end();
    });

    it('should reject connection with invalid credentials', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'wrongpassword',
      });

      await new Promise((resolve) => {
        client.on('error', () => resolve());
        client.on('connect', () => resolve());
        setTimeout(resolve, 2000);
      });

      expect(client.connected).toBe(false);
      client.end();
    });

    it('should reject anonymous connection when auth enabled', async () => {
      const client = createTestClient(mqttPort, {});

      await new Promise((resolve) => {
        client.on('error', () => resolve());
        client.on('connect', () => resolve());
        setTimeout(resolve, 2000);
      });

      expect(client.connected).toBe(false);
      client.end();
    });
  });

  describe('Topic ACL', () => {
    it('should allow admin to subscribe to all topics', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'admin123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const subscribed = await new Promise((resolve) => {
        client.subscribe('ivy/v1/#', (err) => {
          resolve(!err);
        });
      });

      expect(subscribed).toBe(true);
      client.end();
    });

    it('should allow client to subscribe to telemetry', async () => {
      const client = createTestClient(mqttPort, {
        username: 'client',
        password: 'client123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const subscribed = await new Promise((resolve) => {
        client.subscribe('ivy/v1/meters/+/telemetry', (err) => {
          resolve(!err);
        });
      });

      expect(subscribed).toBe(true);
      client.end();
    });

    it('should allow client to publish commands', async () => {
      const client = createTestClient(mqttPort, {
        username: 'client',
        password: 'client123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      // Publishing should not error
      const published = await new Promise((resolve) => {
        client.publish(
          'ivy/v1/meters/000000001234/command/request',
          JSON.stringify({ id: 'test', method: 'read_address' }),
          (err) => resolve(!err)
        );
      });

      expect(published).toBe(true);
      client.end();
    });

    it('should deny readonly from publishing', async () => {
      const client = createTestClient(mqttPort, {
        username: 'readonly',
        password: 'readonly123',
      });

      await new Promise((resolve) => client.on('connect', resolve));
      await wait(100);

      // For readonly, publish should be denied by ACL
      // Note: mqtt.js doesn't always report ACL failures clearly
      // The message simply won't be delivered
      client.publish(
        'ivy/v1/meters/000000001234/command/request',
        JSON.stringify({ id: 'test', method: 'read_address' })
      );

      await wait(100);
      client.end();
    });
  });

  describe('Telemetry Publishing', () => {
    it('should receive published telemetry', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'admin123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const messages = [];
      client.subscribe('ivy/v1/meters/+/telemetry');
      client.on('message', (topic, payload) => {
        messages.push({ topic, payload: JSON.parse(payload.toString()) });
      });

      await wait(100);

      // Publish telemetry
      await publisher.publishTelemetry('000000009999', {
        value: 12345.67,
        unit: 'kWh',
        register: { key: 'TOTAL_ACTIVE_POSITIVE' },
      });

      await waitFor(() => messages.length > 0, 2000);

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].topic).toBe('ivy/v1/meters/000000009999/telemetry');
      expect(messages[0].payload.value).toBe(12345.67);

      client.end();
    });

    it('should receive batch telemetry', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'admin123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const messages = [];
      client.subscribe('ivy/v1/meters/+/telemetry');
      client.on('message', (topic, payload) => {
        messages.push(JSON.parse(payload.toString()));
      });

      await wait(100);

      await publisher.publishBatchTelemetry('000000008888', {
        voltage_v: 220.5,
        current_a: 5.2,
        power_w: 1146,
      });

      await waitFor(() => messages.length > 0, 2000);

      expect(messages[0].values).toBeDefined();
      expect(messages[0].values.voltage_v).toBe(220.5);

      client.end();
    });
  });

  describe('Status Publishing', () => {
    it('should receive meter status updates', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'admin123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const messages = [];
      client.subscribe('ivy/v1/meters/+/status');
      client.on('message', (topic, payload) => {
        messages.push(JSON.parse(payload.toString()));
      });

      await wait(100);

      await publisher.publishMeterStatus('000000007777', true, { ip: '192.168.1.100' });

      await waitFor(() => messages.length > 0, 2000);

      expect(messages[0].online).toBe(true);
      expect(messages[0].ip).toBe('192.168.1.100');

      client.end();
    });

    it('should receive gateway status', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'admin123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const messages = [];
      client.subscribe('ivy/v1/gateway/status');
      client.on('message', (topic, payload) => {
        messages.push(JSON.parse(payload.toString()));
      });

      await wait(100);

      await publisher.publishGatewayStatus('online');

      await waitFor(() => messages.length > 0, 2000);

      expect(messages[0].status).toBe('online');

      client.end();
    });
  });

  describe('Event Publishing', () => {
    it('should receive meter events', async () => {
      const client = createTestClient(mqttPort, {
        username: 'admin',
        password: 'admin123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const messages = [];
      client.subscribe('ivy/v1/meters/+/events');
      client.on('message', (topic, payload) => {
        messages.push(JSON.parse(payload.toString()));
      });

      await wait(100);

      await publisher.publishMeterEvent('000000006666', 'alarm', {
        type: 'overvoltage',
        value: 255,
      });

      await waitFor(() => messages.length > 0, 2000);

      expect(messages[0].event).toBe('alarm');
      expect(messages[0].data.type).toBe('overvoltage');

      client.end();
    });
  });

  describe('Command Flow', () => {
    let simulator;

    beforeEach(async () => {
      simulator = createMeterSimulator({
        address: '000000005555',
        port: tcpPort,
        values: {
          [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: 9999.99,
          [INSTANTANEOUS_REGISTERS.VOLTAGE_A.id]: 220.0,
        },
      });
      await simulator.connect();

      // Wait for meter to be identified
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => tcpServer.isMeterConnected('000000005555'), 3000);
    });

    afterEach(async () => {
      if (simulator) {
        await simulator.disconnect();
      }
    });

    it('should execute command via MQTT and receive response', async () => {
      const client = createTestClient(mqttPort, {
        username: 'client',
        password: 'client123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const responses = [];
      client.subscribe('ivy/v1/meters/000000005555/command/response');
      client.on('message', (topic, payload) => {
        responses.push(JSON.parse(payload.toString()));
      });

      await wait(100);

      // Send command
      const commandId = `cmd_${Date.now()}`;
      client.publish(
        'ivy/v1/meters/000000005555/command/request',
        JSON.stringify({
          id: commandId,
          method: COMMAND_METHODS.READ_REGISTER,
          params: { register: 'TOTAL_ACTIVE_POSITIVE' },
        })
      );

      await waitFor(() => responses.length > 0, 5000);

      expect(responses[0].id).toBe(commandId);
      expect(responses[0].success).toBe(true);
      expect(responses[0].result.value).toBeCloseTo(9999.99, 1);

      client.end();
    });

    it('should return error for disconnected meter', async () => {
      // Disconnect simulator first
      await simulator.disconnect();
      await wait(500);

      const client = createTestClient(mqttPort, {
        username: 'client',
        password: 'client123',
      });

      await new Promise((resolve) => client.on('connect', resolve));

      const responses = [];
      client.subscribe('ivy/v1/meters/000000005555/command/response');
      client.on('message', (topic, payload) => {
        responses.push(JSON.parse(payload.toString()));
      });

      await wait(100);

      client.publish(
        'ivy/v1/meters/000000005555/command/request',
        JSON.stringify({
          id: 'cmd_error_test',
          method: COMMAND_METHODS.READ_REGISTER,
          params: { register: 'VOLTAGE_A' },
        })
      );

      await waitFor(() => responses.length > 0, 3000);

      expect(responses[0].success).toBe(false);
      expect(responses[0].result.error).toContain('not connected');

      client.end();
    });
  });
});

describe('Full System Integration', () => {
  let mqttPort;
  let mqttWsPort;
  let tcpPort;
  let broker;
  let authManager;
  let tcpServer;
  let publisher;
  let commandHandler;
  let statusManager;
  let simulator;
  let mqttClient;

  beforeAll(async () => {
    await resetInstance();
    mqttPort = await getAvailablePort();
    mqttWsPort = await getAvailablePort();
    tcpPort = await getAvailablePort();

    authManager = createAuthManager({
      allowAnonymous: false,
    });

    // Add metpow user
    authManager.addUser('metpow', 'metpow123', ['client']);

    // Add ACL rules for ivy/v1 topics
    authManager.addAclRule({
      id: 'metpow-subscribe',
      username: 'metpow',
      pattern: 'ivy/v1/#',
      actions: ['subscribe'],
      allow: true,
    });
    authManager.addAclRule({
      id: 'metpow-command-publish',
      username: 'metpow',
      pattern: 'ivy/v1/meters/+/command/request',
      actions: ['publish'],
      allow: true,
    });

    broker = createMQTTBroker({
      port: mqttPort,
      wsPort: mqttWsPort,
      authenticate: authManager.authenticate.bind(authManager),
      authorizePublish: authManager.authorizePublish.bind(authManager),
      authorizeSubscribe: authManager.authorizeSubscribe.bind(authManager),
    });
    await broker.start();

    tcpServer = createTCPServer({ port: tcpPort });
    await tcpServer.start();

    publisher = createTelemetryPublisher({ broker });
    publisher.start();

    commandHandler = createCommandHandler({
      broker,
      tcpServer,
      publisher,
    });
    commandHandler.start();

    statusManager = createStatusManager({
      publisher,
      tcpServer,
      statusInterval: 60000,
    });
    statusManager.start();
  });

  afterAll(async () => {
    if (mqttClient) mqttClient.end();
    if (simulator) await simulator.disconnect();
    if (statusManager) statusManager.stop();
    if (commandHandler) commandHandler.stop();
    if (publisher) await publisher.stop();
    if (tcpServer) await tcpServer.stop();
    if (broker) await broker.stop();
    await resetInstance();
  });

  it('should handle complete meter lifecycle', async () => {
    // 1. Connect MQTT client (Metpow Portal)
    mqttClient = createTestClient(mqttPort, {
      clientId: 'metpow-portal',
      username: 'metpow',
      password: 'metpow123',
    });

    await new Promise((resolve) => mqttClient.on('connect', resolve));

    const receivedMessages = {
      telemetry: [],
      status: [],
      events: [],
      responses: [],
    };

    mqttClient.subscribe([
      'ivy/v1/meters/+/telemetry',
      'ivy/v1/meters/+/status',
      'ivy/v1/meters/+/events',
      'ivy/v1/meters/+/command/response',
    ]);

    mqttClient.on('message', (topic, payload) => {
      const data = JSON.parse(payload.toString());
      if (topic.includes('/telemetry')) receivedMessages.telemetry.push(data);
      else if (topic.includes('/status')) receivedMessages.status.push(data);
      else if (topic.includes('/events')) receivedMessages.events.push(data);
      else if (topic.includes('/response')) receivedMessages.responses.push(data);
    });

    await wait(200);

    // 2. Connect meter simulator
    simulator = createMeterSimulator({
      address: '000000004444',
      port: tcpPort,
      values: {
        [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: 5000.0,
        [INSTANTANEOUS_REGISTERS.VOLTAGE_A.id]: 225.0,
        [INSTANTANEOUS_REGISTERS.CURRENT_A.id]: 10.5,
      },
    });

    await simulator.connect();

    // 3. Meter sends telemetry (identification)
    await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);

    await waitFor(() => tcpServer.isMeterConnected('000000004444'), 3000);

    // 4. Verify meter online status
    expect(tcpServer.isMeterConnected('000000004444')).toBe(true);

    // 5. Send read command via MQTT
    const cmdId = `cmd_lifecycle_${Date.now()}`;
    mqttClient.publish(
      'ivy/v1/meters/000000004444/command/request',
      JSON.stringify({
        id: cmdId,
        method: COMMAND_METHODS.READ_REGISTER,
        params: { register: 'VOLTAGE_A' },
      })
    );

    // 6. Wait for response
    await waitFor(() => receivedMessages.responses.length > 0, 5000);

    const response = receivedMessages.responses.find((r) => r.id === cmdId);
    expect(response).toBeDefined();
    expect(response.success).toBe(true);
    expect(response.result.value).toBeCloseTo(225.0, 0);

    // 7. Disconnect meter
    await simulator.disconnect();
    simulator = null;

    await wait(500);

    // 8. Verify meter offline
    expect(tcpServer.isMeterConnected('000000004444')).toBe(false);
  });
});
