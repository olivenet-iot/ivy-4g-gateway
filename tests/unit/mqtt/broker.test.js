/**
 * MQTT Broker Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mqtt from 'mqtt';
import net from 'net';
import {
  MQTTBroker,
  BROKER_EVENTS,
  createMQTTBroker,
  getInstance,
  resetInstance,
} from '../../../src/mqtt/broker.js';

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

describe('MQTT Broker', () => {
  let broker;
  let testPort;
  let testWsPort;

  beforeEach(async () => {
    testPort = await getAvailablePort();
    testWsPort = await getAvailablePort();
  });

  afterEach(async () => {
    if (broker) {
      await broker.stop();
      broker = null;
    }
    await resetInstance();
  });

  describe('BROKER_EVENTS', () => {
    it('should have all expected events', () => {
      expect(BROKER_EVENTS.CLIENT_CONNECTED).toBe('client:connected');
      expect(BROKER_EVENTS.CLIENT_DISCONNECTED).toBe('client:disconnected');
      expect(BROKER_EVENTS.CLIENT_ERROR).toBe('client:error');
      expect(BROKER_EVENTS.MESSAGE_PUBLISHED).toBe('message:published');
      expect(BROKER_EVENTS.MESSAGE_SUBSCRIBED).toBe('message:subscribed');
      expect(BROKER_EVENTS.BROKER_STARTED).toBe('broker:started');
      expect(BROKER_EVENTS.BROKER_STOPPED).toBe('broker:stopped');
    });
  });

  describe('constructor', () => {
    it('should create broker with default options', () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      expect(broker).toBeInstanceOf(MQTTBroker);
      expect(broker.isRunning).toBe(false);
    });

    it('should accept custom options', () => {
      broker = createMQTTBroker({
        port: testPort,
        wsPort: testWsPort,
        host: '127.0.0.1',
      });
      expect(broker.options.port).toBe(testPort);
      expect(broker.options.host).toBe('127.0.0.1');
    });
  });

  describe('start / stop', () => {
    it('should start broker on specified port', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      expect(broker.isRunning).toBe(true);
      expect(broker.isActive()).toBe(true);
    });

    it('should stop broker gracefully', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();
      await broker.stop();

      expect(broker.isRunning).toBe(false);
    });

    it('should not start twice', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();
      await broker.start(); // Should not error

      expect(broker.isRunning).toBe(true);
    });

    it('should emit BROKER_STARTED event', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });

      let startedEvent = null;
      broker.on(BROKER_EVENTS.BROKER_STARTED, (data) => {
        startedEvent = data;
      });

      await broker.start();

      expect(startedEvent).not.toBeNull();
      expect(startedEvent.port).toBe(testPort);
    });
  });

  describe('client connections', () => {
    it('should accept MQTT client connections', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'test-client-1',
      });

      await new Promise((resolve) => {
        client.on('connect', resolve);
      });

      await wait(100);

      const clients = broker.getConnectedClients();
      expect(clients.length).toBe(1);
      expect(clients[0].id).toBe('test-client-1');

      client.end();
    });

    it('should track multiple clients', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client1 = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'client-1',
      });
      const client2 = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'client-2',
      });

      await Promise.all([
        new Promise((resolve) => client1.on('connect', resolve)),
        new Promise((resolve) => client2.on('connect', resolve)),
      ]);

      await wait(100);

      expect(broker.getConnectedClients().length).toBe(2);

      client1.end();
      client2.end();
    });

    it('should handle client disconnect', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'disconnect-test',
      });

      await new Promise((resolve) => client.on('connect', resolve));
      await wait(100);

      expect(broker.getConnectedClients().length).toBe(1);

      client.end(true);
      await wait(200);

      expect(broker.getConnectedClients().length).toBe(0);
    });

    it('should emit CLIENT_CONNECTED event', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      let connectedEvent = null;
      broker.on(BROKER_EVENTS.CLIENT_CONNECTED, (data) => {
        connectedEvent = data;
      });

      const client = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'event-test-client',
      });

      await new Promise((resolve) => client.on('connect', resolve));
      await wait(100);

      expect(connectedEvent).not.toBeNull();
      expect(connectedEvent.clientId).toBe('event-test-client');

      client.end();
    });

    it('should emit CLIENT_DISCONNECTED event', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      let disconnectedEvent = null;
      broker.on(BROKER_EVENTS.CLIENT_DISCONNECTED, (data) => {
        disconnectedEvent = data;
      });

      const client = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'disconnect-event-test',
      });

      await new Promise((resolve) => client.on('connect', resolve));
      await wait(100);

      client.end(true);
      await wait(200);

      expect(disconnectedEvent).not.toBeNull();
      expect(disconnectedEvent.clientId).toBe('disconnect-event-test');
    });
  });

  describe('publish', () => {
    it('should publish message to topic', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client = mqtt.connect(`mqtt://localhost:${testPort}`);

      await new Promise((resolve) => client.on('connect', resolve));

      const receivedMessages = [];
      client.subscribe('test/topic');
      client.on('message', (topic, payload) => {
        receivedMessages.push({ topic, payload: payload.toString() });
      });

      await wait(100);

      await broker.publish('test/topic', 'Hello MQTT');

      await wait(100);

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].topic).toBe('test/topic');
      expect(receivedMessages[0].payload).toBe('Hello MQTT');

      client.end();
    });

    it('should publish JSON objects', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client = mqtt.connect(`mqtt://localhost:${testPort}`);
      await new Promise((resolve) => client.on('connect', resolve));

      const receivedMessages = [];
      client.subscribe('json/topic');
      client.on('message', (_topic, payload) => {
        receivedMessages.push(JSON.parse(payload.toString()));
      });

      await wait(100);

      await broker.publish('json/topic', { value: 123, unit: 'kWh' });

      await wait(100);

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].value).toBe(123);
      expect(receivedMessages[0].unit).toBe('kWh');

      client.end();
    });

    it('should publish with QoS and retain options', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      // Should not throw
      await broker.publish('qos/topic', 'test', { qos: 1, retain: true });
    });

    it('should throw when broker not running', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });

      await expect(broker.publish('test', 'data')).rejects.toThrow('Broker not running');
    });
  });

  describe('subscriptions', () => {
    it('should track client subscriptions', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'sub-test',
      });

      await new Promise((resolve) => client.on('connect', resolve));
      await wait(50);

      client.subscribe(['topic/a', 'topic/b']);
      await wait(100);

      const clients = broker.getConnectedClients();
      const clientData = clients.find((c) => c.id === 'sub-test');

      expect(clientData.subscriptions).toContain('topic/a');
      expect(clientData.subscriptions).toContain('topic/b');

      client.end();
    });

    it('should emit MESSAGE_SUBSCRIBED event', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      let subscribedEvent = null;
      broker.on(BROKER_EVENTS.MESSAGE_SUBSCRIBED, (data) => {
        subscribedEvent = data;
      });

      const client = mqtt.connect(`mqtt://localhost:${testPort}`, {
        clientId: 'sub-event-test',
      });

      await new Promise((resolve) => client.on('connect', resolve));
      await wait(50);

      client.subscribe('event/topic');
      await wait(100);

      expect(subscribedEvent).not.toBeNull();
      expect(subscribedEvent.clientId).toBe('sub-event-test');
      expect(subscribedEvent.topics).toContain('event/topic');

      client.end();
    });
  });

  describe('authentication', () => {
    it('should support custom authentication', async () => {
      const authenticate = (_client, username, password, callback) => {
        if (username === 'valid' && password.toString() === 'secret') {
          callback(null, true);
        } else {
          callback(new Error('Invalid credentials'), false);
        }
      };

      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort, authenticate });
      await broker.start();

      // Valid credentials
      const validClient = mqtt.connect(`mqtt://localhost:${testPort}`, {
        username: 'valid',
        password: 'secret',
      });

      await new Promise((resolve) => validClient.on('connect', resolve));
      expect(broker.getConnectedClients().length).toBe(1);
      validClient.end();

      await wait(100);

      // Invalid credentials
      const invalidClient = mqtt.connect(`mqtt://localhost:${testPort}`, {
        username: 'invalid',
        password: 'wrong',
      });

      await new Promise((resolve) => {
        invalidClient.on('error', resolve);
        setTimeout(resolve, 500);
      });

      await wait(100);
      expect(broker.getConnectedClients().length).toBe(0);
      invalidClient.end();
    });
  });

  describe('getStats', () => {
    it('should return broker statistics', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const stats = broker.getStats();

      expect(stats.isRunning).toBe(true);
      expect(stats.port).toBe(testPort);
      expect(stats.clientsConnected).toBe(0);
      expect(stats.messagesPublished).toBe(0);
    });

    it('should track client count', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client = mqtt.connect(`mqtt://localhost:${testPort}`);
      await new Promise((resolve) => client.on('connect', resolve));
      await wait(100);

      const stats = broker.getStats();
      expect(stats.clientsConnected).toBe(1);
      expect(stats.clientsTotal).toBe(1);

      client.end();
    });

    it('should update connected count on disconnect', async () => {
      broker = createMQTTBroker({ port: testPort, wsPort: testWsPort });
      await broker.start();

      const client = mqtt.connect(`mqtt://localhost:${testPort}`);
      await new Promise((resolve) => client.on('connect', resolve));
      await wait(100);

      expect(broker.getStats().clientsConnected).toBe(1);

      client.end(true);
      await wait(200);

      expect(broker.getStats().clientsConnected).toBe(0);
      expect(broker.getStats().clientsTotal).toBe(1); // Total should remain
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance', () => {
      const instance1 = getInstance({ port: testPort });
      const instance2 = getInstance({ port: testPort + 1 });

      expect(instance1).toBe(instance2);
    });

    it('should reset instance', async () => {
      const instance1 = getInstance({ port: testPort });
      await resetInstance();
      const instance2 = getInstance({ port: testPort });

      expect(instance1).not.toBe(instance2);
    });
  });
});
