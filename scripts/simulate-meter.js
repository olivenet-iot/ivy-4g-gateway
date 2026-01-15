#!/usr/bin/env node

/**
 * Meter Simulator CLI
 *
 * Command line tool to simulate an energy meter connecting to the gateway.
 * Useful for manual testing and debugging.
 *
 * Usage:
 *   node scripts/simulate-meter.js [options]
 *
 * Options:
 *   --address, -a   Meter address (default: 000000001234)
 *   --host, -h      Server host (default: 127.0.0.1)
 *   --port, -p      Server port (default: 8899)
 *   --energy, -e    Initial energy value in kWh (default: 12345.67)
 *   --voltage, -v   Initial voltage value in V (default: 220.5)
 *   --interval, -i  Auto-report interval in seconds (0 = disabled)
 *
 * @module scripts/simulate-meter
 */

import { createMeterSimulator, SIMULATOR_EVENTS } from '../tests/mocks/meter-simulator.js';
import { ENERGY_REGISTERS, INSTANTANEOUS_REGISTERS } from '../src/protocol/registers.js';
import { bufferToHex } from '../src/protocol/bcd.js';

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  address: '000000001234',
  host: '127.0.0.1',
  port: 8899,
  energy: 12345.67,
  voltage: 220.5,
  interval: 0,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];

  switch (arg) {
    case '--address':
    case '-a':
      options.address = next;
      i++;
      break;
    case '--host':
    case '-h':
      options.host = next;
      i++;
      break;
    case '--port':
    case '-p':
      options.port = parseInt(next, 10);
      i++;
      break;
    case '--energy':
    case '-e':
      options.energy = parseFloat(next);
      i++;
      break;
    case '--voltage':
    case '-v':
      options.voltage = parseFloat(next);
      i++;
      break;
    case '--interval':
    case '-i':
      options.interval = parseInt(next, 10);
      i++;
      break;
    case '--help':
      console.log(`
Meter Simulator CLI

Usage:
  node scripts/simulate-meter.js [options]

Options:
  --address, -a   Meter address (default: 000000001234)
  --host, -h      Server host (default: 127.0.0.1)
  --port, -p      Server port (default: 8899)
  --energy, -e    Initial energy value in kWh (default: 12345.67)
  --voltage, -v   Initial voltage value in V (default: 220.5)
  --interval, -i  Auto-report interval in seconds (0 = disabled)
  --help          Show this help message

Examples:
  # Connect with default settings
  node scripts/simulate-meter.js

  # Connect with custom address and port
  node scripts/simulate-meter.js -a 000000005678 -p 8899

  # Auto-report energy every 10 seconds
  node scripts/simulate-meter.js -i 10
      `);
      process.exit(0);
  }
}

// Create simulator
const simulator = createMeterSimulator({
  address: options.address,
  host: options.host,
  port: options.port,
  values: {
    [ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id]: options.energy,
    [INSTANTANEOUS_REGISTERS.VOLTAGE_A.id]: options.voltage,
  },
});

// Setup event handlers
simulator.on(SIMULATOR_EVENTS.CONNECTED, ({ address, host, port }) => {
  console.log(`Connected to ${host}:${port}`);
  console.log(`   Meter Address: ${address}`);
  console.log(`   Energy: ${options.energy} kWh`);
  console.log(`   Voltage: ${options.voltage} V`);
  console.log('');
  console.log('Waiting for commands from server...');
  console.log('Press Ctrl+C to disconnect');
  console.log('');
});

simulator.on(SIMULATOR_EVENTS.DISCONNECTED, () => {
  console.log('Disconnected from server');
  process.exit(0);
});

simulator.on(SIMULATOR_EVENTS.FRAME_RECEIVED, ({ frame }) => {
  console.log(`[RX] ${bufferToHex(frame)}`);
});

simulator.on(SIMULATOR_EVENTS.FRAME_SENT, ({ frame }) => {
  console.log(`[TX] ${bufferToHex(frame)}`);
});

simulator.on(SIMULATOR_EVENTS.ERROR, ({ error }) => {
  console.error(`Error: ${error.message}`);
});

// Connect
console.log('');
console.log('Meter Simulator');
console.log('==================');
console.log(`Connecting to ${options.host}:${options.port}...`);

simulator
  .connect()
  .then(() => {
    // Setup auto-report if interval specified
    if (options.interval > 0) {
      console.log(`Auto-reporting every ${options.interval} seconds`);

      setInterval(async () => {
        // Increment energy slightly
        const currentEnergy = simulator.getValue(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
        simulator.setValue(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id, currentEnergy + 0.01);

        // Send telemetry
        await simulator.sendTelemetry(ENERGY_REGISTERS.TOTAL_ACTIVE_POSITIVE.id);
        console.log(`Auto-reported: ${currentEnergy + 0.01} kWh`);
      }, options.interval * 1000);
    }
  })
  .catch((error) => {
    console.error(`Connection failed: ${error.message}`);
    process.exit(1);
  });

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  await simulator.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await simulator.disconnect();
  process.exit(0);
});
