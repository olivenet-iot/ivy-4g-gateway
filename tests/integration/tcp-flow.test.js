/**
 * TCP Flow Integration Tests
 *
 * End-to-end tests for the complete TCP communication flow:
 * Server <-> Meter Simulator
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import { createTCPServer, SERVER_EVENTS } from '../../src/tcp/server.js';
import { createMeterSimulator, SIMULATOR_EVENTS } from '../mocks/meter-simulator.js';
import { buildReadFrame } from '../../src/protocol/frame-builder.js';
import {
  ENERGY_REGISTERS,
  INSTANTANEOUS_REGISTERS,
} from '../../src/protocol/registers.js';

/**
 * Get an available port
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
 * Wait for a condition with timeout
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

describe('TCP Flow Integration Tests', () => {
  let server;
  let simulator;
  let testPort;

  beforeEach(async () => {
    testPort = await getAvailablePort();
    server = createTCPServer({ port: testPort });
    await server.start();
  });

  afterEach(async () => {
    if (simulator) {
      await simulator.disconnect();
      simulator = null;
    }
    if (server) {
      await server.stop();
      server = null;
    }
  });

  describe('Basic Connection Flow', () => {
    it('should accept meter connection and identify from response', async () => {
      const meterAddress = '000000001234';

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
      });

      // Connect simulator
      await simulator.connect();

      // Send unsolicited telemetry to trigger identification
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);

      // Wait for meter to be identified
      await waitFor(() => server.isMeterConnected(meterAddress), 2000);

      expect(server.isMeterConnected(meterAddress)).toBe(true);
      expect(server.getConnectedMeters()).toContain(meterAddress);
    });

    it('should handle multiple meters simultaneously', async () => {
      const meter1 = createMeterSimulator({ address: '000000001111', port: testPort });
      const meter2 = createMeterSimulator({ address: '000000002222', port: testPort });

      await meter1.connect();
      await meter2.connect();

      // Trigger identification by sending unsolicited telemetry
      await meter1.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await meter2.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);

      await waitFor(
        () => server.isMeterConnected('000000001111') && server.isMeterConnected('000000002222'),
        2000
      );

      expect(server.getConnectedMeters()).toHaveLength(2);
      expect(server.getConnectedMeters()).toContain('000000001111');
      expect(server.getConnectedMeters()).toContain('000000002222');

      await meter1.disconnect();
      await meter2.disconnect();
    });
  });

  describe('Telemetry Flow', () => {
    it('should receive and parse energy telemetry', async () => {
      const meterAddress = '000000003333';
      const expectedEnergy = 9876.54;

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
        values: {
          [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: expectedEnergy,
        },
      });

      let receivedTelemetry = null;
      server.on(SERVER_EVENTS.TELEMETRY_RECEIVED, (event) => {
        if (event.dataId === ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id) {
          receivedTelemetry = event;
        }
      });

      await simulator.connect();

      // Send unsolicited telemetry from meter
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);

      await waitFor(() => receivedTelemetry !== null, 2000);

      expect(receivedTelemetry).not.toBeNull();
      expect(receivedTelemetry.meterId).toBe(meterAddress);
      expect(receivedTelemetry.value).toBeCloseTo(expectedEnergy, 2);
      expect(receivedTelemetry.unit).toBe('kWh');
    });

    it('should receive voltage telemetry with correct resolution', async () => {
      const meterAddress = '000000004444';
      const expectedVoltage = 231.5;

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
        values: {
          [INSTANTANEOUS_REGISTERS.VOLTAGE_A.id]: expectedVoltage,
        },
      });

      let receivedTelemetry = null;
      server.on(SERVER_EVENTS.TELEMETRY_RECEIVED, (event) => {
        if (event.dataId === INSTANTANEOUS_REGISTERS.VOLTAGE_A.id) {
          receivedTelemetry = event;
        }
      });

      await simulator.connect();
      await simulator.sendTelemetry(INSTANTANEOUS_REGISTERS.VOLTAGE_A.id);

      await waitFor(() => receivedTelemetry !== null, 2000);

      expect(receivedTelemetry.value).toBeCloseTo(expectedVoltage, 1);
      expect(receivedTelemetry.unit).toBe('V');
    });

    it('should receive current telemetry with correct resolution', async () => {
      const meterAddress = '000000005555';
      const expectedCurrent = 12.345;

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
        values: {
          [INSTANTANEOUS_REGISTERS.CURRENT_A.id]: expectedCurrent,
        },
      });

      let receivedTelemetry = null;
      server.on(SERVER_EVENTS.TELEMETRY_RECEIVED, (event) => {
        if (event.dataId === INSTANTANEOUS_REGISTERS.CURRENT_A.id) {
          receivedTelemetry = event;
        }
      });

      await simulator.connect();
      await simulator.sendTelemetry(INSTANTANEOUS_REGISTERS.CURRENT_A.id);

      await waitFor(() => receivedTelemetry !== null, 2000);

      expect(receivedTelemetry.value).toBeCloseTo(expectedCurrent, 3);
      expect(receivedTelemetry.unit).toBe('A');
    });
  });

  describe('Command-Response Flow', () => {
    it('should send read command and receive response', async () => {
      const meterAddress = '000000006666';
      const expectedEnergy = 5555.55;

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
        values: {
          [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: expectedEnergy,
        },
      });

      await simulator.connect();

      // Identify meter first
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => server.isMeterConnected(meterAddress), 2000);

      // Now send command and wait for response
      const frame = buildReadFrame(meterAddress, ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      const response = await server.sendCommand(
        meterAddress,
        frame,
        ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id,
        5000
      );

      expect(response).toBeDefined();
      expect(response.value).toBeCloseTo(expectedEnergy, 2);
    });

    it('should handle command timeout', async () => {
      const meterAddress = '000000007777';

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
        responseDelay: 5000, // Very slow response
      });

      await simulator.connect();
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => server.isMeterConnected(meterAddress), 2000);

      const frame = buildReadFrame(meterAddress, ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);

      await expect(
        server.sendCommand(meterAddress, frame, ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id, 100)
      ).rejects.toThrow('timeout');
    });
  });

  describe('Disconnect Flow', () => {
    it('should emit METER_DISCONNECTED when meter disconnects', async () => {
      const meterAddress = '000000008888';

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
      });

      let disconnectEvent = null;
      server.on(SERVER_EVENTS.METER_DISCONNECTED, (event) => {
        if (event.meterId === meterAddress) {
          disconnectEvent = event;
        }
      });

      await simulator.connect();
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => server.isMeterConnected(meterAddress), 2000);

      // Disconnect meter
      await simulator.disconnect();

      await waitFor(() => disconnectEvent !== null, 2000);

      expect(disconnectEvent).not.toBeNull();
      expect(disconnectEvent.meterId).toBe(meterAddress);
    });

    it('should remove meter from connected list on disconnect', async () => {
      const meterAddress = '000000009999';

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
      });

      await simulator.connect();
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => server.isMeterConnected(meterAddress), 2000);

      expect(server.isMeterConnected(meterAddress)).toBe(true);

      await simulator.disconnect();

      await waitFor(() => !server.isMeterConnected(meterAddress), 2000);

      expect(server.isMeterConnected(meterAddress)).toBe(false);
    });
  });

  describe('Statistics', () => {
    it('should track connection statistics', async () => {
      simulator = createMeterSimulator({
        address: '000000010000',
        port: testPort,
      });

      await simulator.connect();
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);

      await waitFor(() => server.isMeterConnected('000000010000'), 2000);

      const stats = server.getStats();

      expect(stats.server.isRunning).toBe(true);
      expect(stats.connections.totalConnections).toBeGreaterThanOrEqual(1);
      expect(stats.connections.identifiedConnections).toBeGreaterThanOrEqual(1);
    });

    it('should track simulator statistics', async () => {
      simulator = createMeterSimulator({
        address: '000000011000',
        port: testPort,
      });

      await simulator.connect();
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);

      const stats = simulator.getStats();

      expect(stats.isConnected).toBe(true);
      expect(stats.framesSent).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown register request with error response', async () => {
      const meterAddress = '000000012000';

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
      });

      let errorEvent = null;
      server.on(SERVER_EVENTS.ERROR_RESPONSE, (event) => {
        errorEvent = event;
      });

      await simulator.connect();
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => server.isMeterConnected(meterAddress), 2000);

      // Request unknown register
      const frame = buildReadFrame(meterAddress, 0xffffffff);
      await server.sendCommandNoWait(meterAddress, frame);

      await waitFor(() => errorEvent !== null, 2000);

      expect(errorEvent).not.toBeNull();
      expect(errorEvent.meterId).toBe(meterAddress);
    });

    it('should handle connection errors gracefully', async () => {
      simulator = createMeterSimulator({
        address: '000000013000',
        port: testPort + 1000, // Wrong port
      });

      // Add error handler to prevent unhandled error event
      const errors = [];
      simulator.on(SIMULATOR_EVENTS.ERROR, (e) => errors.push(e));

      await expect(simulator.connect()).rejects.toThrow();
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Value Updates', () => {
    it('should report updated values after setValue', async () => {
      const meterAddress = '000000014000';
      const initialEnergy = 1000.0;
      const updatedEnergy = 2000.0;

      simulator = createMeterSimulator({
        address: meterAddress,
        port: testPort,
        values: {
          [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: initialEnergy,
        },
      });

      await simulator.connect();

      // First telemetry with initial value
      const telemetryValues = [];
      server.on(SERVER_EVENTS.TELEMETRY_RECEIVED, (event) => {
        if (event.dataId === ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id) {
          telemetryValues.push(event.value);
        }
      });

      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => telemetryValues.length >= 1, 2000);

      expect(telemetryValues[0]).toBeCloseTo(initialEnergy, 2);

      // Update value and send again
      simulator.setValue(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id, updatedEnergy);
      await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
      await waitFor(() => telemetryValues.length >= 2, 2000);

      expect(telemetryValues[1]).toBeCloseTo(updatedEnergy, 2);
    });
  });
});
