'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { main } = require('../../src/index');
const { bootProxy, teardownProxy, findClosedPort, findEphemeralPort } = require('../helpers/boot-proxy');
const { envelope, clientSecurity, AUTH_FAULT } = require('../helpers/soap-fixtures');
const { FOV_URI } = require('../../src/response-injection');
const { GENERIC_URI } = require('../../src/fov-translation');

/**
 * HTTP-boundarytests (observability surface / logging policy).
 *
 * Seam: the proxy's HTTP listener (via bootProxy, whose `logs` array captures
 * every line the proxy logs) and the process entry point's startup line
 * (via main() with an injected env + log sink). Assertions follow the spec's
 * logging policy: PTZ-relevant events in, routine forwarding out, password
 * never anywhere.
 */

describe('startup binding log line', () => {
  /** @type {any} */
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections && server.closeAllConnections();
      });
      server = undefined;
    }
  });

  it('logs the loaded binding — host/port, listen port, camera binding values, log level — at startup', async () => {
    const listenPort = await findEphemeralPort();
    /** @type {string[]} */
    const lines = [];
    server = main({
      env: {
        LISTEN_PORT: String(listenPort),
        UPSTREAM_HOST: '192.0.2.12',
        UPSTREAM_PORT: '80',
        LOG_LEVEL: 'warn',
      },
      log: (line) => lines.push(line),
    });
    await new Promise((resolve) => server.once('listening', resolve));

    const startup = lines.find((line) => line.includes('starting'));
    assert.ok(startup, `expected a startup binding line; got: ${JSON.stringify(lines)}`);
    for (const needle of [
      '"upstreamHost":"192.0.2.12"',
      '"upstreamPort":80',
      `"listenPort":${listenPort}`,
      '"hfovDeg":80',
      '"vfovDeg":43.2',
      '"panMechDeg":350',
      '"tiltMechDeg":120',
      '"logLevel":"warn"',
    ]) {
      assert.ok(startup.includes(needle), `startup line should record ${needle}; got: ${startup}`);
    }
  });

  it('starts clean when leftover credential env vars are present — the binding holds none (ADR-0008)', async () => {
    const listenPort = await findEphemeralPort();
    /** @type {string[]} */
    const lines = [];
    server = main({
      env: {
        LISTEN_PORT: String(listenPort),
        UPSTREAM_HOST: '192.0.2.12',
        UPSTREAM_PORT: '80',
        UPSTREAM_USER: 'user',
        UPSTREAM_PASSWORD: 'unused-pass',
      },
      log: (line) => lines.push(line),
    });
    await new Promise((resolve) => server.once('listening', resolve));

    assert.ok(lines.length > 0, 'expected startup lines to be logged');
    for (const line of lines) {
      assert.ok(!line.includes('unused-pass'), `credential value must not appear in: ${line}`);
    }
    const startup = lines.find((line) => line.includes('starting'));
    assert.ok(startup, 'expected a startup binding line');
    assert.ok(!startup.includes('upstreamPassword'), `binding line must not carry credential fields; got: ${startup}`);
    assert.ok(!startup.includes('<set>'), `presence markers are gone with the credentials; got: ${startup}`);
  });
});

// GetStatus — the routine poll Frigate hammers between moves.
const GET_STATUS = envelope('<tptz:GetStatus><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetStatus>');
const GET_CAPABILITIES = envelope('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');

describe('upstream SOAP fault logging', () => {
  /** @type {any} */
  let booted;

  afterEach(async () => {
    if (booted) await teardownProxy(booted);
    booted = undefined;
  });

  it('logs a fault returned to Frigate with code, subcode, and reason text', async () => {
    booted = await bootProxy({ upstream: { status: 401, body: AUTH_FAULT } });

    await booted.postToProxy(GET_CAPABILITIES);

    const faultLine = booted.logs.find((/** @type {string} */ l) => l.includes('SOAP fault'));
    assert.ok(faultLine, `expected a SOAP fault log line; logs were: ${JSON.stringify(booted.logs)}`);
    assert.ok(faultLine.includes('status=401'), `fault line should carry the status; got: ${faultLine}`);
    assert.ok(faultLine.includes('s:Receiver'), `fault line should carry the fault code; got: ${faultLine}`);
    assert.ok(faultLine.includes('t:ActionNotSupported'), `fault line should carry the subcode; got: ${faultLine}`);
    assert.ok(
      faultLine.includes('Authentication or permission failure'),
      `fault line should carry the reason text; got: ${faultLine}`
    );
  });

  it('logs the fault even when the upstream wraps it in HTTP 200', async () => {
    booted = await bootProxy({ upstream: { status: 200, body: AUTH_FAULT } });

    await booted.postToProxy(GET_CAPABILITIES);

    const faultLine = booted.logs.find((/** @type {string} */ l) => l.includes('SOAP fault'));
    assert.ok(faultLine, `expected a SOAP fault log line for a 200-wrapped fault; logs: ${JSON.stringify(booted.logs)}`);
    assert.ok(faultLine.includes('status=200'), `fault line should carry status=200; got: ${faultLine}`);
    assert.ok(faultLine.includes('s:Receiver'), `fault line should carry the fault code; got: ${faultLine}`);
  });

  it('summarises a SOAP 1.1 style fault (faultcode / faultstring) with its code and text', async () => {
    const legacyFault =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Body><soap:Fault>' +
      '<faultcode>soap:Client.NotAuthorized</faultcode>' +
      '<faultstring>Authentication of the request failed</faultstring>' +
      '</soap:Fault></soap:Body></soap:Envelope>';
    booted = await bootProxy({ upstream: { status: 500, body: legacyFault } });

    await booted.postToProxy(GET_CAPABILITIES);

    const faultLine = booted.logs.find((/** @type {string} */ l) => l.includes('SOAP fault'));
    assert.ok(faultLine, `expected a SOAP fault log line; logs: ${JSON.stringify(booted.logs)}`);
    assert.ok(
      faultLine.includes('soap:Client.NotAuthorized'),
      `fault line should carry the 1.1 faultcode; got: ${faultLine}`
    );
    assert.ok(
      faultLine.includes('Authentication of the request failed'),
      `fault line should carry the 1.1 faultstring; got: ${faultLine}`
    );
  });

  it('caps the upstream-controlled fault reason so one fault cannot bloat the log', async () => {
    const longReason = 'e'.repeat(4000);
    const spamFault =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
      `<s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code>` +
      `<s:Reason><s:Text>${longReason}</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;
    booted = await bootProxy({ upstream: { status: 500, body: spamFault } });

    await booted.postToProxy(GET_CAPABILITIES);

    const faultLine = booted.logs.find((/** @type {string} */ l) => l.includes('SOAP fault'));
    assert.ok(faultLine, `expected a SOAP fault log line; logs: ${JSON.stringify(booted.logs.map((/** @type {string} */ l) => l.slice(0, 60)))}`);
    assert.ok(faultLine.length < 400, `fault line must be capped, not 4000 chars of camera text; got ${faultLine.length} chars`);
    assert.ok(faultLine.includes('s:Receiver'), `capped line should still carry the code; got: ${faultLine.slice(0, 120)}`);
  });
});

describe('GetConfigurationOptions injection is logged (— every rewrite raises a line)', () => {
  /** @type {any} */
  let booted;

  afterEach(async () => {
    if (booted) await teardownProxy(booted);
    booted = undefined;
  });

  const GCO_OPTIONS = envelope(
    '<tptz:GetConfigurationOptions><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetConfigurationOptions>'
  );
  const OK_OPTIONS =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">' +
    '<s:Body><tptz:GetConfigurationOptionsResponse><tptz:PTZConfiguration><tt:Spaces>' +
    '<tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI></tt:RelativePanTiltTranslationSpace>' +
    '</tt:Spaces></tptz:PTZConfiguration></tptz:GetConfigurationOptionsResponse></s:Body></s:Envelope>';

  it('logs one line when a GetConfigurationOptions response is rewritten with the FOV injection', async () => {
    booted = await bootProxy({ upstream: { status: 200, body: OK_OPTIONS } });

    const response = await booted.postToProxy(GCO_OPTIONS);
    assert.ok(response.body.includes('TranslationSpaceFov'), 'sanity: injection must still happen');

    const injectLines = booted.logs.filter((/** @type {string} */ l) => l.includes('TranslationSpaceFov'));
    assert.equal(injectLines.length, 1, `expected exactly one injection log line; logs: ${JSON.stringify(booted.logs)}`);
  });
});

/**
 * RelativeMove envelope in Frigate's wire shape — pan/tilt in the given
 * space, zoom generic.
 *
 * @param {string} panTiltSpace
 * @param {number} x
 * @param {number} y
 */
function relativeMoveEnvelope(panTiltSpace, x, y) {
  return envelope(
    '<tptz:RelativeMove><tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
      '<tptz:Translation>' +
      `<tt:PanTilt x="${x}" y="${y}" space="${panTiltSpace}"/>` +
      `<tt:Zoom x="0" space="${GENERIC_URI}"/>` +
      '</tptz:Translation></tptz:RelativeMove>'
  );
}

const MOVE_OK =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
  '<soap:Body><RelativeMoveResponse/></soap:Body></soap:Envelope>';

describe('per-request log policy at the HTTP boundary', () => {
  /** @type {any} */
  let booted;

  afterEach(async () => {
    if (booted) await teardownProxy(booted);
    booted = undefined;
  });

  it('logs a FOV-space RelativeMove with the inbound (x, y) and the emitted (x-prime, y-prime) on one line', async () => {
    booted = await bootProxy({ upstream: { status: 200, body: MOVE_OK } });

    await booted.postToProxy(relativeMoveEnvelope(FOV_URI, 0.1, 0.25));

    const moveLines = booted.logs.filter((/** @type {string} */ l) => l.includes('RelativeMove'));
    assert.equal(moveLines.length, 1, `expected exactly one move log line; logs: ${JSON.stringify(booted.logs)}`);
    // (0.1 * 80) / 350 ≈ 0.022857 (6 dp, formatGenericValue) ; (0.25 * 43.2) / 120 = 0.09 — spec-sheet binding.
    assert.match(
      moveLines[0],
      /\(x=0\.1, y=0\.25\).*\(x=0\.022857, y=0\.09\)/,
      `move line must pair the FOV and generic vectors; got: ${moveLines[0]}`
    );
  });

  it('logs nothing for a generic-space RelativeMove forwarded verbatim', async () => {
    booted = await bootProxy({ upstream: { status: 200, body: MOVE_OK } });

    await booted.postToProxy(relativeMoveEnvelope(GENERIC_URI, 0.1, 0.25));

    assert.deepEqual(booted.logs, [], `generic moves are routine forwarding; logs: ${JSON.stringify(booted.logs)}`);
  });

  it('logs nothing per request for the routine polling / capability / profile surface', async () => {
    booted = await bootProxy({
      upstream: {
        status: 200,
        body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><ok/></soap:Body></soap:Envelope>',
      },
    });

    const routine = [
      GET_STATUS,
      GET_CAPABILITIES,
      envelope('<tds:GetProfiles/>'),
      envelope('<tptz:GetConfiguration><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetConfiguration>'),
      envelope('<tptz:GetServiceCapabilities/>'),
      envelope('<tptz:GetPresets><tptz:ProfileToken>profile_1</tptz:ProfileToken></tptz:GetPresets>'),
      envelope('<tt:GetImagingSettings><tt:ProfileToken>profile_1</tt:ProfileToken></tt:GetImagingSettings>'),
    ];
    for (const request of routine) {
      await booted.postToProxy(request);
    }

    assert.deepEqual(booted.logs, [], `routine forwarding must be silent; logs: ${JSON.stringify(booted.logs)}`);
  });

  it('logs malformed inbound SOAP and answers 400', async () => {
    booted = await bootProxy({ upstream: { status: 200, body: '<ok/>' } });

    const response = await booted.postToProxy('not even xml');

    assert.equal(response.status, 400);
    assert.ok(
      booted.logs.some((/** @type {string} */ l) => l.includes('malformed inbound SOAP')),
      `expected a malformed-SOAP log line; logs: ${JSON.stringify(booted.logs)}`
    );
  });

  it('logs upstream unreachability alongside the 502', async () => {
    const closedPort = await findClosedPort();
    booted = await bootProxy({ upstreamPort: closedPort });

    const response = await booted.postToProxy(GET_STATUS);

    assert.equal(response.status, 502);
    assert.ok(
      booted.logs.some((/** @type {string} */ l) => l.includes('upstream unreachable')),
      `expected an unreachability log line; logs: ${JSON.stringify(booted.logs)}`
    );
  });

  it('logs proxy-level errors from the request pipeline', async () => {
    const CAPS_OK =
      '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" ' +
      'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><soap:Body><tds:GetCapabilitiesResponse>' +
      '<tds:Capabilities/></tds:GetCapabilitiesResponse></soap:Body></soap:Envelope>';
    booted = await bootProxy({
      upstream: { status: 200, body: CAPS_OK },
      rewriteXAddrsFn: () => {
        throw new Error('rewrite exploded');
      },
    });

    const response = await booted.postToProxy(GET_CAPABILITIES);

    assert.equal(response.status, 502);
    assert.ok(
      booted.logs.some((/** @type {string} */ l) => l.includes('proxy-level error') && l.includes('rewrite exploded')),
      `expected a proxy-level error log line; logs: ${JSON.stringify(booted.logs)}`
    );
  });

  it('never writes the client\'s relayed credentials into any runtime log line', async () => {
    booted = await bootProxy({ upstream: { status: 401, body: AUTH_FAULT } });

    // Credentials now travel INSIDE the request (ADR-0008): the relay path
    // must swallow them without echoing username / digest / nonce anywhere.
    const credentials = clientSecurity('operator-user-with-s3kr3t-name');
    await booted.postToProxy(envelope('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', credentials));
    await booted.postToProxy(GET_STATUS);
    await booted.postToProxy(GET_CAPABILITIES);

    for (const line of booted.logs) {
      assert.ok(!line.includes('s3kr3t'), `credential material must not appear in: ${line}`);
      assert.ok(!line.includes('qkNjP2mfLWVPa21LU0hFMkpLd0dKWg=='), `digest must not appear in: ${line}`);
      assert.ok(!line.includes('c21va2Utbm9uY2UtaGVyZQ=='), `nonce must not appear in: ${line}`);
    }
    assert.ok(booted.logs.length > 0, 'sanity: the fault paths above must have logged something');
  });
});
