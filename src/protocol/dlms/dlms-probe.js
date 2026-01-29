/**
 * DLMS Probe - Systematic DLMS Compatibility Test
 *
 * Tests whether an IVY EM114070 meter responds to DLMS queries.
 * Can be run standalone or imported as a module.
 *
 * Test sequence:
 * 1. Wait for heartbeat to confirm connection
 * 2. Try AARQ with various configurations
 * 3. If association succeeds, try GET.request for common OBIS codes
 * 4. Output compatibility report
 *
 * Usage:
 *   node src/protocol/dlms/dlms-probe.js [host] [port]
 *
 * @module protocol/dlms/dlms-probe
 */

import net from 'net';
import { createIvyStreamParser } from '../ivy-wrapper.js';
import { isHeartbeatPacket, parseHeartbeatPacket } from '../heartbeat-handler.js';
import { parseApdu } from './apdu-parser.js';
import { buildAarq, buildGetRequest, buildReleaseRequest, wrapDlmsForSending, APPLICATION_CONTEXT } from './client.js';
import { createChildLogger } from '../../utils/logger.js';

const logger = createChildLogger({ module: 'dlms-probe' });

/**
 * Common OBIS codes to test
 */
const PROBE_OBIS_CODES = [
  { obis: '1-0:1.8.0.255', classId: 3, name: 'Total active energy import' },
  { obis: '1-0:32.7.0.255', classId: 3, name: 'Voltage phase A' },
  { obis: '1-0:31.7.0.255', classId: 3, name: 'Current phase A' },
  { obis: '1-0:1.7.0.255', classId: 3, name: 'Active power import' },
  { obis: '0-0:1.0.0.255', classId: 8, name: 'Clock' },
  { obis: '0-0:96.1.0.255', classId: 1, name: 'Meter serial number' },
];

/**
 * AARQ configurations to try
 */
const AARQ_CONFIGS = [
  { label: 'LN, no cipher, public (0x10)', context: APPLICATION_CONTEXT.LN_NO_CIPHER },
  { label: 'SN, no cipher', context: APPLICATION_CONTEXT.SN_NO_CIPHER },
  { label: 'LN, with cipher', context: APPLICATION_CONTEXT.LN_WITH_CIPHER },
];

/**
 * Run the DLMS probe against a connected meter
 *
 * @param {Object} options
 * @param {string} [options.host='127.0.0.1'] - Meter host (or gateway if testing locally)
 * @param {number} [options.port=8899] - TCP port
 * @param {number} [options.heartbeatTimeout=30000] - Time to wait for heartbeat
 * @param {number} [options.queryTimeout=5000] - Time to wait for each query response
 * @returns {Promise<Object>} Probe results
 */
export const runProbe = async (options = {}) => {
  const {
    host = '127.0.0.1',
    port = 8899,
    heartbeatTimeout = 30000,
    queryTimeout = 5000,
  } = options;

  const results = {
    host,
    port,
    startTime: new Date().toISOString(),
    heartbeat: null,
    associations: [],
    queries: [],
    spontaneousData: [],
    summary: null,
  };

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      results.endTime = new Date().toISOString();
      results.summary = buildSummary(results);
      socket.destroy();
      resolve(results);
    };

    // Overall timeout
    const overallTimeout = setTimeout(() => {
      logger.info('Probe timeout reached');
      finish();
    }, heartbeatTimeout + (queryTimeout * (AARQ_CONFIGS.length + PROBE_OBIS_CODES.length)));

    socket.on('error', (err) => {
      logger.error('Probe connection error', { error: err.message });
      results.connectionError = err.message;
      clearTimeout(overallTimeout);
      finish();
    });

    socket.on('close', () => {
      clearTimeout(overallTimeout);
      finish();
    });

    // Setup IVY stream parser
    const ivyParser = createIvyStreamParser(
      (header, payload, raw) => {
        if (isHeartbeatPacket(raw)) {
          const hb = parseHeartbeatPacket(raw);
          if (hb.valid) {
            results.heartbeat = {
              meterAddress: hb.meterAddress,
              receivedAt: new Date().toISOString(),
            };
            logger.info('Heartbeat received from meter', { meterAddress: hb.meterAddress });
          }
        } else if (payload.length > 0) {
          try {
            const parsed = parseApdu(payload);
            handleProbeResponse(results, parsed, payload);
          } catch (err) {
            logger.debug('Failed to parse APDU during probe', { error: err.message });
          }
        }
      },
      (err) => {
        logger.debug('IVY parse error during probe', { error: err.message });
      }
    );

    socket.on('data', (data) => {
      ivyParser.push(data);
    });

    socket.connect(port, host, async () => {
      logger.info('Probe connected', { host, port });

      // Wait for heartbeat
      logger.info('Waiting for heartbeat...');
      await delay(Math.min(heartbeatTimeout, 5000));

      if (!results.heartbeat) {
        logger.warn('No heartbeat received, continuing anyway');
      }

      // Try each AARQ configuration
      for (const config of AARQ_CONFIGS) {
        if (resolved) break;

        logger.info(`Trying AARQ: ${config.label}`);
        const aarq = buildAarq({ applicationContext: config.context });
        const wrapped = wrapDlmsForSending(aarq);

        const associationResult = {
          config: config.label,
          sent: true,
          response: null,
          accepted: false,
        };

        socket.write(wrapped);
        await delay(queryTimeout);

        // Check if we got an AARE response
        // (handled in handleProbeResponse)
        results.associations.push(associationResult);
      }

      // If any association succeeded, try GET requests
      const accepted = results.associations.some(a => a.accepted);
      if (accepted) {
        for (const obis of PROBE_OBIS_CODES) {
          if (resolved) break;

          logger.info(`Querying ${obis.name} (${obis.obis})`);
          const getReq = buildGetRequest(obis.classId, obis.obis);
          const wrapped = wrapDlmsForSending(getReq);

          socket.write(wrapped);
          await delay(queryTimeout);
        }

        // Send release
        const release = buildReleaseRequest();
        socket.write(wrapDlmsForSending(release));
        await delay(1000);
      }

      finish();
    });
  });
};

/**
 * Handle responses during probe
 * @private
 */
const handleProbeResponse = (results, parsed) => {
  switch (parsed.type) {
    case 'aare': {
      const lastAssoc = results.associations[results.associations.length - 1];
      if (lastAssoc) {
        lastAssoc.response = parsed;
        lastAssoc.accepted = parsed.accepted;
      }
      logger.info('AARE received', { accepted: parsed.accepted });
      break;
    }

    case 'get-response': {
      results.queries.push({
        type: 'get-response',
        invokeId: parsed.invokeId,
        accessResult: parsed.accessResult,
        data: parsed.data,
        receivedAt: new Date().toISOString(),
      });
      logger.info('GET response received', {
        invokeId: parsed.invokeId,
        accessResult: parsed.accessResult,
      });
      break;
    }

    case 'event-notification':
    case 'data-notification': {
      results.spontaneousData.push({
        type: parsed.type,
        obisCode: parsed.obisCode || null,
        data: parsed.data,
        receivedAt: new Date().toISOString(),
      });
      logger.info('Spontaneous data received', { type: parsed.type });
      break;
    }

    case 'exception-response': {
      logger.warn('Exception response', {
        stateError: parsed.stateError,
        serviceError: parsed.serviceError,
      });
      break;
    }

    default:
      logger.debug('Other APDU received during probe', { type: parsed.type });
  }
};

/**
 * Build summary from probe results
 * @private
 */
const buildSummary = (results) => {
  const associationSuccess = results.associations.some(a => a.accepted);
  const queryCount = results.queries.length;
  const successfulQueries = results.queries.filter(q => q.accessResult === 'success').length;

  return {
    heartbeatReceived: !!results.heartbeat,
    meterAddress: results.heartbeat?.meterAddress || 'unknown',
    associationSupported: associationSuccess,
    successfulAssociations: results.associations.filter(a => a.accepted).map(a => a.config),
    queriesAttempted: PROBE_OBIS_CODES.length,
    queriesResponded: queryCount,
    queriesSuccessful: successfulQueries,
    spontaneousDataCount: results.spontaneousData.length,
    recommendation: associationSuccess
      ? 'Active DLMS queries supported. Set DLMS_PASSIVE_ONLY=false.'
      : results.spontaneousData.length > 0
        ? 'Meter pushes data spontaneously. Use passive mode (DLMS_PASSIVE_ONLY=true).'
        : results.heartbeat
          ? 'Heartbeat works. No DLMS responses detected. Enable capture service for analysis.'
          : 'No communication detected. Check connectivity.',
  };
};

/**
 * Delay helper
 * @private
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Standalone execution
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('dlms-probe.js') ||
  process.argv[1].endsWith('dlms-probe')
);

if (isMainModule) {
  const host = process.argv[2] || '127.0.0.1';
  const port = parseInt(process.argv[3], 10) || 8899;

  console.log(`DLMS Probe - Testing ${host}:${port}`);
  console.log('='.repeat(50));

  runProbe({ host, port }).then((results) => {
    console.log('\n' + '='.repeat(50));
    console.log('PROBE RESULTS');
    console.log('='.repeat(50));
    console.log(JSON.stringify(results.summary, null, 2));

    if (results.associations.length > 0) {
      console.log('\nAssociation attempts:');
      for (const a of results.associations) {
        console.log(`  ${a.config}: ${a.accepted ? 'ACCEPTED' : 'no response/rejected'}`);
      }
    }

    if (results.queries.length > 0) {
      console.log('\nQuery responses:');
      for (const q of results.queries) {
        console.log(`  InvokeId ${q.invokeId}: ${q.accessResult}`);
      }
    }

    if (results.spontaneousData.length > 0) {
      console.log(`\nSpontaneous data packets: ${results.spontaneousData.length}`);
    }

    process.exit(0);
  }).catch((err) => {
    console.error('Probe failed:', err.message);
    process.exit(1);
  });
}

export default { runProbe, PROBE_OBIS_CODES };
