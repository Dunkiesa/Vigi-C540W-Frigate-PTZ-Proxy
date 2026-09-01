'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { postSoap } = require('../../src/upstream');
const { bootProxy, teardownProxy, findClosedPort } = require('../helpers/boot-proxy');
const { envelope, AUTH_FAULT } = require('../helpers/soap-fixtures');

/**
 * HTTP-boundarytests (ADR-0005, pass-through error semantics).
 *
 * Seam: a real proxy listener driven over real HTTP, pointed at a stub
 * upstream that can be configured to (a) return a SOAP fault and (b) refuse
 * connections entirely.
 *
 * Contract under test:
 *   - Upstream SOAP faults reach Frigate with the same status code and the
 *     same body, byte for byte. The proxy never swallows a fault, never
 *     rewrites one into a 200, and never synthesises a fault of its own.
 *   - Network-level unreachability (refused, timed out) surfaces as HTTP 502
 *     with a plain-text body — explicitly NOT a SOAP fault.
 */

/**
 * A device-level fault (ActionNotSupported style) — the shape Hikvision-ish
 * firmware returns for unimplemented PTZ methods.
 */
const ACTION_FAULT =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
  '<s:Body>' +
  '<s:Fault>' +
  '<s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>t:ActionNotSupported</s:Value></s:Subcode></s:Code>' +
  '<s:Reason><s:Text xml:lang="en">The action requested is not supported by this device</s:Text></s:Reason>' +
  '</s:Fault>' +
  '</s:Body>' +
  '</s:Envelope>';

const GET_CAPABILITIES = envelope('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
const GET_CONFIG_OPTIONS = envelope('<tptz:GetConfigurationOptions><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetConfigurationOptions>');
const RELATIVE_MOVE = envelope(
  '<tptz:RelativeMove><tptz:ProfileToken>prof1</tptz:ProfileToken>' +
    '<tptz:Translation><tptz:PanTilt x="0.1" y="0" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov"/></tptz:Translation>' +
    '</tptz:RelativeMove>'
);

describe('error semantics — SOAP fault pass-through (ADR-0005)', () => {
  /** @type {any} */
  let booted;

  afterEach(async () => {
    if (booted) await teardownProxy(booted);
    booted = undefined;
  });

  it('returns a 401 auth fault with the same status and the byte-identical body', async () => {
    booted = await bootProxy({ upstream: { status: 401, body: AUTH_FAULT } });

    const response = await booted.postToProxy(GET_CAPABILITIES);

    assert.equal(response.status, 401);
    assert.equal(response.body, AUTH_FAULT);
    assert.match(response.headers['content-type'] || '', /application\/soap\+xml/);
  });

  it('returns a 500 ActionNotSupported fault verbatim for a RelativeMove', async () => {
    booted = await bootProxy({ upstream: { status: 500, body: ACTION_FAULT } });

    const response = await booted.postToProxy(RELATIVE_MOVE);

    assert.equal(response.status, 500);
    assert.equal(response.body, ACTION_FAULT);
  });

  it('passes an intercepted-method fault through unchanged — GetConfigurationOptions fault is not injected into, not rewritten to 200', async () => {
    // The one response the proxy rewrites on the happy path is a
    // GetConfigurationOptions response. A *fault* to the same call must
    // still pass through untouched: same status, same bytes, no injected
    // TranslationSpaceFov, no 200.
    booted = await bootProxy({ upstream: { status: 401, body: AUTH_FAULT } });

    const response = await booted.postToProxy(GET_CONFIG_OPTIONS);

    assert.equal(response.status, 401, 'fault must never be rewritten into a 200');
    assert.equal(response.body, AUTH_FAULT, 'fault body must reach Frigate byte-identical');
    assert.ok(
      !response.body.includes('TranslationSpaceFov'),
      'injection must not touch a fault body'
    );
  });

  it('passes a fault-shaped body through untouched even when the upstream answers it with HTTP 200', async () => {
    // Some cameras return 200 + soap:Fault. The proxy must forward that
    // pairing unchanged — no injection into a fault body, no status rewrite.
    // The fault body deliberately embeds the injection anchor so this test
    // fails loudly if fault detection breaks.
    const ok200Fault =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema">' +
      '<s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code>' +
      '<s:Reason><s:Text>options temporarily unavailable</s:Text></s:Reason>' +
      '<tt:RelativePanTiltTranslationSpace></tt:RelativePanTiltTranslationSpace>' +
      '</s:Fault></s:Body></s:Envelope>';
    booted = await bootProxy({ upstream: { status: 200, body: ok200Fault } });

    const response = await booted.postToProxy(GET_CONFIG_OPTIONS);

    assert.equal(response.status, 200);
    assert.equal(response.body, ok200Fault);
    assert.ok(!response.body.includes('TranslationSpaceFov'));
  });

  it('logs the upstream fault instead of swallowing it silently', async () => {
    booted = await bootProxy({ upstream: { status: 401, body: AUTH_FAULT } });

    await booted.postToProxy(GET_CAPABILITIES);

    assert.ok(
      booted.logs.some((/** @type {string} */ line) => /upstream SOAP fault returned \(status=401\)/.test(/** @type {string} */ line)),
      `expected a fault log line with the status; logs were: ${JSON.stringify(booted.logs)}`
    );
  });

  it('still returns the fault untouched when the upstream body embeds a RelativePanTiltTranslationSpace', async () => {
    // Adversarial fixture: a 500 whose body is a fault envelope that happens
    // to contain the injection anchor. The proxy keys injection on the
    // *request*, so a GetConfigurationOptions fault with this body must be
    // forwarded byte-identical regardless.
    const faultWithAnchor =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema">' +
      '<s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code>' +
      '<s:Reason><s:Text>options unavailable</s:Text></s:Reason>' +
      '<tt:RelativePanTiltTranslationSpace></tt:RelativePanTiltTranslationSpace>' +
      '</s:Fault></s:Body></s:Envelope>';
    booted = await bootProxy({ upstream: { status: 500, body: faultWithAnchor } });

    const response = await booted.postToProxy(GET_CONFIG_OPTIONS);

    assert.equal(response.status, 500);
    assert.equal(response.body, faultWithAnchor);
  });
});

describe('error semantics — upstream unreachable → 502 (ADR-0005)', () => {
  /** @type {any} */
  let booted;

  afterEach(async () => {
    if (booted) await teardownProxy(booted);
    booted = undefined;
  });

  it('returns HTTP 502 when the camera refuses connections', async () => {
    const closedPort = await findClosedPort();
    booted = await bootProxy({ upstreamPort: closedPort });

    const response = await booted.postToProxy(GET_CAPABILITIES);

    assert.equal(response.status, 502);
  });

  it('returns HTTP 502 when the upstream request times out', async () => {
    // Stub accepts the connection but never answers; the upstream leg is
    // wrapped with a short timeout so the test stays fast. The reject → 502
    // translation in the proxy is identical for every network failure mode.
    booted = await bootProxy({
      upstream: { hang: true },
      postSoapFn: (opts) => postSoap({ ...opts, timeoutMs: 300 }),
    });

    const response = await booted.postToProxy(GET_CAPABILITIES);

    assert.equal(response.status, 502);
  });

  it('never synthesises a SOAP fault on 502 — the body is plain text', async () => {
    const closedPort = await findClosedPort();
    booted = await bootProxy({ upstreamPort: closedPort });

    const response = await booted.postToProxy(GET_CAPABILITIES);

    assert.equal(response.status, 502);
    assert.ok(
      !/<[a-zA-Z][\w.-]*:Fault\b|<Fault\b/.test(response.body),
      `502 body must not be a synthesised SOAP fault; got: ${response.body}`
    );
    assert.ok(
      !response.body.includes('<?xml'),
      `502 body must not be XML; got: ${response.body}`
    );
  });

  it('logs the unreachability with the upstream host:port', async () => {
    const closedPort = await findClosedPort();
    booted = await bootProxy({ upstreamPort: closedPort });

    await booted.postToProxy(GET_CAPABILITIES);

    assert.ok(
      booted.logs.some((/** @type {string} */ line) => /upstream unreachable \(127\.0\.0\.1:\d+\)/.test(/** @type {string} */ line)),
      `expected an "upstream unreachable" log line; logs were: ${JSON.stringify(booted.logs)}`
    );
  });

  it('surfaces ECONNREFUSED as 502 for every request shape, including intercepted calls', async () => {
    const closedPort = await findClosedPort();
    booted = await bootProxy({ upstreamPort: closedPort });

    for (const request of [GET_CAPABILITIES, GET_CONFIG_OPTIONS, RELATIVE_MOVE]) {
      const response = await booted.postToProxy(request);
      assert.equal(response.status, 502, `expected 502 for ${request.slice(0, 80)}...`);
    }
  });
});

describe('error semantics — happy path stays intact (regression)', () => {
  /** @type {any} */
  let booted;

  afterEach(async () => {
    if (booted) await teardownProxy(booted);
    booted = undefined;
  });

  it('a 200 GetConfigurationOptions response still receives the FOV injection', async () => {
    const okResponse =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">' +
      '<s:Body><tptz:GetConfigurationOptionsResponse><tptz:PTZConfiguration><tt:Spaces>' +
      '<tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI>' +
      '<tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>' +
      '<tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:RelativePanTiltTranslationSpace>' +
      '</tt:Spaces></tptz:PTZConfiguration></tptz:GetConfigurationOptionsResponse></s:Body></s:Envelope>';
    booted = await bootProxy({ upstream: { status: 200, body: okResponse } });

    const response = await booted.postToProxy(GET_CONFIG_OPTIONS);

    assert.equal(response.status, 200);
    assert.ok(response.body.includes('TranslationSpaceFov'), 'injection must still apply to 200s');
    assert.equal(booted.logs.filter((/** @type {string} */ line) => /upstream returned non-success/.test(/** @type {string} */ line)).length, 0);
  });
});
