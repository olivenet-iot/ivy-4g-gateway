/**
 * MQTT Telemetry Publisher Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TelemetryPublisher,
  TOPIC_PREFIX,
  Topics,
  PUBLISHER_EVENTS,
  createTelemetryPublisher,
} from '../../../src/mqtt/publisher.js';

/**
 * Create mock broker
 */
const createMockBroker = () => ({
  publish: vi.fn().mockResolvedValue(undefined),
  isActive: () => true,
});

describe('MQTT Telemetry Publisher', () => {
  let publisher;
  let mockBroker;

  beforeEach(() => {
    mockBroker = createMockBroker();
    publisher = createTelemetryPublisher({ broker: mockBroker });
  });

  afterEach(async () => {
    if (publisher?.isRunning) {
      await publisher.stop();
    }
  });

  describe('Topics', () => {
    it('should generate correct telemetry topic', () => {
      expect(Topics.meterTelemetry('000000001234')).toBe(
        'ivy/v1/meters/000000001234/telemetry'
      );
    });

    it('should generate correct status topic', () => {
      expect(Topics.meterStatus('000000001234')).toBe('ivy/v1/meters/000000001234/status');
    });

    it('should generate correct events topic', () => {
      expect(Topics.meterEvents('000000001234')).toBe('ivy/v1/meters/000000001234/events');
    });

    it('should generate correct command response topic', () => {
      expect(Topics.meterCommandResponse('000000001234')).toBe(
        'ivy/v1/meters/000000001234/command/response'
      );
    });

    it('should generate correct gateway topics', () => {
      expect(Topics.gatewayStatus()).toBe('ivy/v1/gateway/status');
      expect(Topics.gatewayStats()).toBe('ivy/v1/gateway/stats');
    });
  });

  describe('TOPIC_PREFIX', () => {
    it('should have correct prefix', () => {
      expect(TOPIC_PREFIX).toBe('ivy/v1');
    });
  });

  describe('PUBLISHER_EVENTS', () => {
    it('should have all expected events', () => {
      expect(PUBLISHER_EVENTS.TELEMETRY_PUBLISHED).toBe('telemetry:published');
      expect(PUBLISHER_EVENTS.STATUS_PUBLISHED).toBe('status:published');
      expect(PUBLISHER_EVENTS.EVENT_PUBLISHED).toBe('event:published');
      expect(PUBLISHER_EVENTS.PUBLISH_ERROR).toBe('publish:error');
    });
  });

  describe('constructor', () => {
    it('should create publisher with broker', () => {
      expect(publisher).toBeInstanceOf(TelemetryPublisher);
      expect(publisher.isRunning).toBe(false);
    });

    it('should throw without broker', () => {
      expect(() => createTelemetryPublisher({})).toThrow('MQTT broker instance required');
    });

    it('should accept custom options', () => {
      const p = createTelemetryPublisher({
        broker: mockBroker,
        qos: 2,
        retain: true,
        statusInterval: 30000,
      });
      expect(p.options.qos).toBe(2);
      expect(p.options.retain).toBe(true);
      expect(p.options.statusInterval).toBe(30000);
    });

    it('should use default options', () => {
      expect(publisher.options.qos).toBe(1);
      expect(publisher.options.retain).toBe(false);
      expect(publisher.options.statusInterval).toBe(60000);
    });
  });

  describe('start / stop', () => {
    it('should start publisher', () => {
      publisher.start();
      expect(publisher.isRunning).toBe(true);
    });

    it('should publish gateway status on start', () => {
      publisher.start();
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/gateway/status',
        expect.objectContaining({ status: 'online' }),
        expect.any(Object)
      );
    });

    it('should stop publisher', async () => {
      publisher.start();
      await publisher.stop();
      expect(publisher.isRunning).toBe(false);
    });

    it('should publish offline status on stop', async () => {
      publisher.start();
      mockBroker.publish.mockClear();
      await publisher.stop();

      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/gateway/status',
        expect.objectContaining({ status: 'offline' }),
        expect.any(Object)
      );
    });

    it('should not start twice', () => {
      publisher.start();
      publisher.start();
      expect(publisher.isRunning).toBe(true);
    });

    it('should accept gateway info', () => {
      publisher.start({ version: '1.0.0', name: 'Test Gateway' });
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/gateway/status',
        expect.objectContaining({
          version: '1.0.0',
          name: 'Test Gateway',
        }),
        expect.any(Object)
      );
    });
  });

  describe('publishTelemetry', () => {
    beforeEach(() => {
      publisher.start();
    });

    it('should publish telemetry to correct topic', async () => {
      const result = await publisher.publishTelemetry('000000001234', {
        value: 12345.67,
        unit: 'kWh',
        register: { key: 'TOTAL_ACTIVE_POSITIVE' },
      });

      expect(result).toBe(true);
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/000000001234/telemetry',
        expect.objectContaining({
          meterId: '000000001234',
          value: 12345.67,
          unit: 'kWh',
        }),
        expect.any(Object)
      );
    });

    it('should emit TELEMETRY_PUBLISHED event', async () => {
      const handler = vi.fn();
      publisher.on(PUBLISHER_EVENTS.TELEMETRY_PUBLISHED, handler);

      await publisher.publishTelemetry('000000001234', {
        value: 100,
        unit: 'V',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: '000000001234',
          topic: 'ivy/v1/meters/000000001234/telemetry',
        })
      );
    });

    it('should update stats', async () => {
      await publisher.publishTelemetry('000000001234', { value: 100 });

      const stats = publisher.getStats();
      expect(stats.telemetryPublished).toBe(1);
      expect(stats.lastPublish).not.toBeNull();
    });

    it('should store last telemetry', async () => {
      await publisher.publishTelemetry('000000001234', {
        value: 220.5,
        unit: 'V',
        register: { key: 'VOLTAGE_A' },
      });

      const last = publisher.getLastTelemetry('000000001234');
      expect(last).not.toBeNull();
      expect(last.VOLTAGE_A.value).toBe(220.5);
    });

    it('should return false when not running', async () => {
      await publisher.stop();
      const result = await publisher.publishTelemetry('000000001234', { value: 100 });
      expect(result).toBe(false);
    });

    it('should handle publish errors', async () => {
      mockBroker.publish.mockRejectedValueOnce(new Error('Publish failed'));

      const errorHandler = vi.fn();
      publisher.on(PUBLISHER_EVENTS.PUBLISH_ERROR, errorHandler);

      const result = await publisher.publishTelemetry('000000001234', { value: 100 });

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
      expect(publisher.getStats().errors).toBe(1);
    });

    it('should format dataId when provided', async () => {
      await publisher.publishTelemetry('000000001234', {
        value: 100,
        dataId: 0x00010000,
      });

      expect(mockBroker.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dataId: '0x00010000',
        }),
        expect.any(Object)
      );
    });

    it('should use dataIdFormatted when provided', async () => {
      await publisher.publishTelemetry('000000001234', {
        value: 100,
        dataIdFormatted: '00-01-00-00',
      });

      expect(mockBroker.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          dataId: '00-01-00-00',
        }),
        expect.any(Object)
      );
    });
  });

  describe('publishBatchTelemetry', () => {
    beforeEach(() => {
      publisher.start();
    });

    it('should publish batch values', async () => {
      const values = {
        voltage_v: 220.5,
        current_a: 5.234,
        power_w: 1152,
      };

      const result = await publisher.publishBatchTelemetry('000000001234', values);

      expect(result).toBe(true);
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/000000001234/telemetry',
        expect.objectContaining({
          meterId: '000000001234',
          values,
        }),
        expect.any(Object)
      );
    });

    it('should emit event with isBatch flag', async () => {
      const handler = vi.fn();
      publisher.on(PUBLISHER_EVENTS.TELEMETRY_PUBLISHED, handler);

      await publisher.publishBatchTelemetry('000000001234', { voltage: 220 });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ isBatch: true }));
    });

    it('should return false when not running', async () => {
      await publisher.stop();
      const result = await publisher.publishBatchTelemetry('000000001234', { voltage: 220 });
      expect(result).toBe(false);
    });
  });

  describe('publishMeterStatus', () => {
    beforeEach(() => {
      publisher.start();
    });

    it('should publish online status', async () => {
      const result = await publisher.publishMeterStatus('000000001234', true, {
        ip: '192.168.1.100',
      });

      expect(result).toBe(true);
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/000000001234/status',
        expect.objectContaining({
          meterId: '000000001234',
          online: true,
          ip: '192.168.1.100',
        }),
        expect.objectContaining({ retain: true })
      );
    });

    it('should publish offline status', async () => {
      await publisher.publishMeterStatus('000000001234', false);

      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/000000001234/status',
        expect.objectContaining({ online: false }),
        expect.any(Object)
      );
    });

    it('should emit STATUS_PUBLISHED event', async () => {
      const handler = vi.fn();
      publisher.on(PUBLISHER_EVENTS.STATUS_PUBLISHED, handler);

      await publisher.publishMeterStatus('000000001234', true);

      expect(handler).toHaveBeenCalled();
    });

    it('should return false when not running', async () => {
      await publisher.stop();
      const result = await publisher.publishMeterStatus('000000001234', true);
      expect(result).toBe(false);
    });

    it('should update status count', async () => {
      await publisher.publishMeterStatus('000000001234', true);
      expect(publisher.getStats().statusPublished).toBe(1);
    });
  });

  describe('publishMeterEvent', () => {
    beforeEach(() => {
      publisher.start();
    });

    it('should publish meter event', async () => {
      const result = await publisher.publishMeterEvent('000000001234', 'alarm', {
        type: 'overvoltage',
        value: 250,
      });

      expect(result).toBe(true);
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/000000001234/events',
        expect.objectContaining({
          event: 'alarm',
          data: { type: 'overvoltage', value: 250 },
        }),
        expect.any(Object)
      );
    });

    it('should emit EVENT_PUBLISHED', async () => {
      const handler = vi.fn();
      publisher.on(PUBLISHER_EVENTS.EVENT_PUBLISHED, handler);

      await publisher.publishMeterEvent('000000001234', 'error', {});

      expect(handler).toHaveBeenCalled();
    });

    it('should return false when not running', async () => {
      await publisher.stop();
      const result = await publisher.publishMeterEvent('000000001234', 'alarm', {});
      expect(result).toBe(false);
    });

    it('should update events count', async () => {
      await publisher.publishMeterEvent('000000001234', 'alarm', {});
      expect(publisher.getStats().eventsPublished).toBe(1);
    });
  });

  describe('publishCommandResponse', () => {
    beforeEach(() => {
      publisher.start();
    });

    it('should publish command response', async () => {
      const result = await publisher.publishCommandResponse(
        '000000001234',
        'cmd_123',
        true,
        { relay_state: 'open' }
      );

      expect(result).toBe(true);
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/meters/000000001234/command/response',
        expect.objectContaining({
          id: 'cmd_123',
          success: true,
          result: { relay_state: 'open' },
        }),
        expect.any(Object)
      );
    });

    it('should return false when not running', async () => {
      await publisher.stop();
      const result = await publisher.publishCommandResponse('000000001234', 'cmd', true);
      expect(result).toBe(false);
    });
  });

  describe('publishGatewayStatus', () => {
    it('should publish gateway status with retain', async () => {
      publisher.start({ version: '1.0.0' });

      // Clear mock to check gateway status specifically
      mockBroker.publish.mockClear();
      await publisher.publishGatewayStatus('online');

      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/gateway/status',
        expect.objectContaining({
          status: 'online',
          version: '1.0.0',
        }),
        expect.objectContaining({ retain: true })
      );
    });

    it('should include uptime', async () => {
      publisher.start();
      mockBroker.publish.mockClear();
      await publisher.publishGatewayStatus('online');

      expect(mockBroker.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          uptime: expect.any(Number),
        }),
        expect.any(Object)
      );
    });
  });

  describe('publishGatewayStats', () => {
    beforeEach(() => {
      publisher.start();
    });

    it('should publish gateway stats', async () => {
      const stats = {
        connections: 5,
        meters: 3,
      };

      const result = await publisher.publishGatewayStats(stats);

      expect(result).toBe(true);
      expect(mockBroker.publish).toHaveBeenCalledWith(
        'ivy/v1/gateway/stats',
        expect.objectContaining({
          connections: 5,
          meters: 3,
          publisher: expect.any(Object),
        }),
        expect.any(Object)
      );
    });
  });

  describe('getLastTelemetry / getAllLastTelemetry', () => {
    beforeEach(() => {
      publisher.start();
    });

    it('should return null for unknown meter', () => {
      expect(publisher.getLastTelemetry('unknown')).toBeNull();
    });

    it('should return all last telemetry', async () => {
      await publisher.publishTelemetry('000000001111', { value: 100, register: { key: 'A' } });
      await publisher.publishTelemetry('000000002222', { value: 200, register: { key: 'B' } });

      const all = publisher.getAllLastTelemetry();
      expect(all['000000001111']).toBeDefined();
      expect(all['000000002222']).toBeDefined();
    });

    it('should merge multiple values for same meter', async () => {
      await publisher.publishTelemetry('000000001234', {
        value: 220,
        register: { key: 'VOLTAGE' },
      });
      await publisher.publishTelemetry('000000001234', {
        value: 5.5,
        register: { key: 'CURRENT' },
      });

      const last = publisher.getLastTelemetry('000000001234');
      expect(last.VOLTAGE.value).toBe(220);
      expect(last.CURRENT.value).toBe(5.5);
    });
  });

  describe('getStats', () => {
    it('should return publisher statistics', () => {
      publisher.start();
      const stats = publisher.getStats();

      expect(stats.isRunning).toBe(true);
      expect(stats.telemetryPublished).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.meterCount).toBe(0);
    });

    it('should track meter count', async () => {
      publisher.start();
      await publisher.publishTelemetry('000000001111', { value: 100, register: { key: 'A' } });
      await publisher.publishTelemetry('000000002222', { value: 200, register: { key: 'B' } });

      expect(publisher.getStats().meterCount).toBe(2);
    });
  });

  describe('periodic status publishing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should publish status periodically', async () => {
      publisher = createTelemetryPublisher({
        broker: mockBroker,
        statusInterval: 1000,
      });
      publisher.start();

      // Initial publish
      expect(mockBroker.publish).toHaveBeenCalledTimes(1);

      // Advance timer
      vi.advanceTimersByTime(1000);
      expect(mockBroker.publish).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1000);
      expect(mockBroker.publish).toHaveBeenCalledTimes(3);

      await publisher.stop();
    });

    it('should stop timer on stop', async () => {
      publisher = createTelemetryPublisher({
        broker: mockBroker,
        statusInterval: 1000,
      });
      publisher.start();
      await publisher.stop();

      mockBroker.publish.mockClear();

      // Timer should be stopped
      vi.advanceTimersByTime(5000);
      expect(mockBroker.publish).not.toHaveBeenCalled();
    });
  });

  describe('createTelemetryPublisher', () => {
    it('should create publisher instance', () => {
      const p = createTelemetryPublisher({ broker: mockBroker });
      expect(p).toBeInstanceOf(TelemetryPublisher);
    });
  });
});
