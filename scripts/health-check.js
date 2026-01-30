#!/usr/bin/env node
/**
 * health-check.js - IVY 4G Gateway health checker
 *
 * Checks:
 * - HTTP /health endpoint (port 3000)
 * - TCP server (port 8899)
 * - MQTT broker (port 1883)
 *
 * Usage: node scripts/health-check.js
 * Exit code: 0 = healthy, 1 = unhealthy
 */

import net from 'net';
import http from 'http';

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
const TCP_PORT = parseInt(process.env.TCP_PORT || '8899', 10);
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const HOST = process.env.HEALTH_CHECK_HOST || 'localhost';
const TIMEOUT = parseInt(process.env.HEALTH_CHECK_TIMEOUT || '5000', 10);

const results = {
  http: { status: 'unknown', message: '' },
  tcp: { status: 'unknown', message: '' },
  mqtt: { status: 'unknown', message: '' },
};

/**
 * Check TCP port connectivity
 */
function checkPort(name, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      results[name] = { status: 'fail', message: `Timeout after ${TIMEOUT}ms` };
      resolve(false);
    }, TIMEOUT);

    socket.connect(port, HOST, () => {
      clearTimeout(timer);
      socket.destroy();
      results[name] = { status: 'ok', message: `Port ${port} reachable` };
      resolve(true);
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      results[name] = { status: 'fail', message: err.message };
      resolve(false);
    });
  });
}

/**
 * Check HTTP health endpoint
 */
function checkHttp() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      results.http = { status: 'fail', message: `Timeout after ${TIMEOUT}ms` };
      resolve(false);
    }, TIMEOUT);

    const req = http.get(`http://${HOST}:${HTTP_PORT}/health`, (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          results.http = { status: 'ok', message: 'HTTP /health OK', data: body };
          resolve(true);
        } else {
          results.http = { status: 'fail', message: `HTTP ${res.statusCode}` };
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      results.http = { status: 'fail', message: err.message };
      resolve(false);
    });
  });
}

async function main() {
  console.log('IVY 4G Gateway Health Check');
  console.log('===========================\n');

  // Run all checks in parallel
  const [httpOk, tcpOk, mqttOk] = await Promise.all([
    checkHttp(),
    checkPort('tcp', TCP_PORT),
    checkPort('mqtt', MQTT_PORT),
  ]);

  // Print results
  for (const [name, result] of Object.entries(results)) {
    const icon = result.status === 'ok' ? '[OK]' : '[FAIL]';
    const port = name === 'http' ? HTTP_PORT : name === 'tcp' ? TCP_PORT : MQTT_PORT;
    console.log(`${icon} ${name.toUpperCase()} (port ${port}): ${result.message}`);
  }

  const allOk = httpOk && tcpOk && mqttOk;
  console.log(`\nOverall: ${allOk ? 'HEALTHY' : 'UNHEALTHY'}`);

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Health check error:', err.message);
  process.exit(1);
});
