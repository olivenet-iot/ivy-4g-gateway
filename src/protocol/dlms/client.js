/**
 * DLMS/COSEM Client - AARQ, GET.request, and Release builders
 *
 * Builds DLMS APDUs for initiating associations and querying meter registers.
 * Used by the DLMS probe and active polling when the meter supports queries.
 *
 * @module protocol/dlms/client
 */

import { wrapIvyPacket, IVY_DESTINATIONS } from '../ivy-wrapper.js';
import { config } from '../../config/index.js';

/**
 * DLMS application context names
 */
export const APPLICATION_CONTEXT = {
  LN_NO_CIPHER: Buffer.from([0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x01]), // Logical Name, no ciphering
  SN_NO_CIPHER: Buffer.from([0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x02]), // Short Name, no ciphering
  LN_WITH_CIPHER: Buffer.from([0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x03]),
  SN_WITH_CIPHER: Buffer.from([0x60, 0x85, 0x74, 0x05, 0x08, 0x01, 0x04]),
};

/**
 * Build an AARQ (Association Request) APDU
 *
 * @param {Object} [options] - AARQ options
 * @param {Buffer} [options.applicationContext] - Application context OID
 * @param {number} [options.clientAddress=0x10] - Client address (public=0x10)
 * @param {boolean} [options.proposedDlmsVersion=6] - Proposed DLMS version
 * @returns {Buffer} AARQ APDU bytes
 */
export const buildAarq = (options = {}) => {
  const {
    applicationContext = APPLICATION_CONTEXT.LN_NO_CIPHER,
    proposedDlmsVersion = 6,
  } = options;

  // Build the AARQ body using BER-TLV encoding
  const parts = [];

  // Application context name [1]
  const ctxValue = Buffer.concat([
    Buffer.from([0x06, applicationContext.length]),
    applicationContext,
  ]);
  parts.push(Buffer.from([0xA1, ctxValue.length]));
  parts.push(ctxValue);

  // sender-acse-requirements [10] - authentication (bit 0)
  // Optional - skip for public client

  // user-information [30] - InitiateRequest
  const initiateRequest = buildInitiateRequest(proposedDlmsVersion);
  const userInfoOctet = Buffer.concat([
    Buffer.from([0x04, initiateRequest.length]),
    initiateRequest,
  ]);
  parts.push(Buffer.from([0xBE, userInfoOctet.length]));
  parts.push(userInfoOctet);

  const body = Buffer.concat(parts);

  // Wrap in AARQ tag (0x60)
  return Buffer.concat([
    Buffer.from([0x60, body.length]),
    body,
  ]);
};

/**
 * Build InitiateRequest for AARQ user-information
 * @private
 */
const buildInitiateRequest = (dlmsVersion) => {
  // xDLMS-Initiate.request
  //   proposed-dlms-version-number: 6
  //   proposed-conformance: basic conformance block
  //   client-max-receive-pdu-size: 0xFFFF
  return Buffer.from([
    0x01, 0x00, 0x00, 0x00, // dedicated-key absent, response-allowed=true, proposed-quality-of-service=0
    dlmsVersion, // proposed-dlms-version-number
    // proposed-conformance (3 bytes, tag [31])
    0x5F, 0x1F, 0x04, 0x00,
    0x00, 0x1E, 0x1D, // conformance bits
    0xFF, 0xFF, // client-max-receive-pdu-size
  ]);
};

/**
 * Build a GET.request-normal APDU
 *
 * @param {number} classId - COSEM class ID (e.g., 1=Data, 3=Register, 7=Profile)
 * @param {string} obisCode - OBIS code in "A-B:C.D.E.F" format
 * @param {number} [attributeIndex=2] - Attribute index (2=value for most classes)
 * @param {number} [invokeId=1] - Invoke ID for request/response matching
 * @returns {Buffer} GET.request APDU bytes
 */
export const buildGetRequest = (classId, obisCode, attributeIndex = 2, invokeId = 1) => {
  const obisBytes = obisToBytes(obisCode);

  return Buffer.from([
    0xC0, // GET.request tag
    0x01, // get-request-normal
    invokeId & 0xFF, // invoke-id-and-priority
    // cosem-attribute-descriptor:
    (classId >> 8) & 0xFF, classId & 0xFF, // class-id (uint16)
    ...obisBytes, // instance-id (6 bytes)
    attributeIndex, // attribute-id (int8)
    0x00, // access-selection: not present
  ]);
};

/**
 * Build an ACTION.request-normal APDU
 *
 * @param {number} classId - COSEM class ID (e.g., 70=Disconnect control)
 * @param {string} obisCode - OBIS code in "A-B:C.D.E.F" format
 * @param {number} methodId - Method index (e.g., 1=remote_disconnect, 2=remote_reconnect)
 * @param {number} [invokeId=1] - Invoke ID for request/response matching
 * @returns {Buffer} ACTION.request APDU bytes (13 bytes)
 */
export const buildActionRequest = (classId, obisCode, methodId, invokeId = 1) => {
  const obisBytes = obisToBytes(obisCode);

  return Buffer.from([
    0xC3, // ACTION.request tag
    0x01, // action-request-normal
    invokeId & 0xFF, // invoke-id-and-priority
    // cosem-method-descriptor:
    (classId >> 8) & 0xFF, classId & 0xFF, // class-id (uint16)
    ...obisBytes, // instance-id (6 bytes)
    methodId, // method-id (int8)
    0x00, // method-invocation-parameters: not present
  ]);
};

/**
 * Build a Release Request (RLRQ) APDU
 *
 * @param {number} [reason=0] - Release reason (0=normal)
 * @returns {Buffer} RLRQ APDU bytes
 */
export const buildReleaseRequest = (reason = 0) => {
  const body = Buffer.from([
    0x80, 0x01, reason, // reason [0] INTEGER
  ]);

  return Buffer.concat([
    Buffer.from([0x62, body.length]),
    body,
  ]);
};

/**
 * Wrap a DLMS APDU in an IVY packet for sending to the meter
 *
 * @param {Buffer} apdu - DLMS APDU to wrap
 * @param {number} [destination] - IVY destination (defaults to config or 0x0001)
 * @returns {Buffer} Complete IVY-wrapped packet
 */
export const wrapDlmsForSending = (apdu, destination) => {
  const dest = destination ?? config.dlms?.ivyDestination ?? IVY_DESTINATIONS.DLMS_PUBLIC_CLIENT;
  return wrapIvyPacket(dest, apdu);
};

/**
 * Prepare a DLMS APDU for sending, conditionally wrapping with IVY header
 *
 * @param {Buffer} apdu - DLMS APDU to send
 * @param {Object} [options] - Options
 * @param {boolean} [options.wrapWithIvy=true] - Whether to wrap with IVY header
 * @param {number} [options.destination] - IVY destination (defaults to config or 0x0001)
 * @returns {Buffer} Ready-to-send packet (IVY-wrapped or raw APDU)
 */
export const prepareDlmsForSending = (apdu, options = {}) => {
  const { wrapWithIvy = true, destination } = options;
  if (wrapWithIvy) {
    const dest = destination ?? config.dlms?.ivyDestination ?? IVY_DESTINATIONS.DLMS_PUBLIC_CLIENT;
    return wrapIvyPacket(dest, apdu);
  }
  return apdu;
};

/**
 * Convert OBIS code string to 6-byte buffer
 *
 * @param {string} obisCode - "A-B:C.D.E.F"
 * @returns {Buffer} 6-byte OBIS buffer
 */
export const obisToBytes = (obisCode) => {
  const match = obisCode.match(/^(\d+)-(\d+):(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid OBIS code format: ${obisCode}`);
  }
  return Buffer.from(match.slice(1).map(Number));
};

export default {
  APPLICATION_CONTEXT,
  buildAarq,
  buildGetRequest,
  buildActionRequest,
  buildReleaseRequest,
  wrapDlmsForSending,
  prepareDlmsForSending,
  obisToBytes,
};
