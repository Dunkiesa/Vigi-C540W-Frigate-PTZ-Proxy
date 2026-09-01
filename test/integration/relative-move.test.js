'use strict';

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { bootProxy, teardownProxy } = require('../helpers/boot-proxy');
const { extractPanTilt, extractZoom } = require('../helpers/soap-xml');
const { GENERIC_URI } = require('../../src/fov-translation');
const { FOV_URI } = require('../../src/response-injection');

const UPSTREAM_RESPONSE =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
  ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">' +
  '<soap:Body><tptz:RelativeMoveResponse/></soap:Body>' +
  '</soap:Envelope>';

/**
 * Build a RelativeMove envelope in the wire shape Frigate emits: pan/tilt in
 * the given translation space, zoom always in the generic space, profile
 * token from the camera under test.
 *
 * @param {string} panTiltSpace
 * @param {number} x
 * @param {number} y
 * @param {{ zoomX?: number, speedXml?: string }} [opts]
 * @returns {string}
 */
function relativeMoveEnvelope(panTiltSpace, x, y, opts = {}) {
  const zoomX = opts.zoomX !== undefined ? opts.zoomX : 0;
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
    ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
    '<soap:Body>' +
    '<tptz:RelativeMove>' +
    '<tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
    '<tptz:Translation>' +
    `<tt:PanTilt x="${x}" y="${y}" space="${panTiltSpace}"/>` +
    `<tt:Zoom x="${zoomX}" space="${GENERIC_URI}"/>` +
    '</tptz:Translation>' +
    (opts.speedXml || '') +
    '</tptz:RelativeMove>' +
    '</soap:Body>' +
    '</soap:Envelope>'
  );
}

describe('proxy HTTP listener — RelativeMove translation', () => {
  /** @type {any} */
  let booted;

  beforeEach(async () => {
    booted = await bootProxy({ upstream: { status: 200, body: UPSTREAM_RESPONSE } });
  });

  afterEach(async () => {
    await teardownProxy(booted);
  });

  it('translates a FOV-space RelativeMove(0.1, 0) into a generic-space move upstream', async () => {
    const response = await booted.postToProxy(relativeMoveEnvelope(FOV_URI, 0.1, 0));

    assert.equal(response.status, 200);
    assert.equal(response.body, UPSTREAM_RESPONSE);

    const captured = booted.upstream.requests();
    assert.equal(captured.length, 1);
    const pt = extractPanTilt(captured[0].body);
    assert.ok(pt, `upstream should have received a PanTilt element; got: ${captured[0].body}`);

    // (0.1 * 80) / 350 ≈ 0.02286, per ADR-0002 with the locked spec-sheet
    // binding (HFOV 80°, VFOV 43.2°, pan-mech 350°, tilt-mech 120°).
    assert.ok(
      Math.abs(pt.x - 0.0228571) < 1e-5,
      `expected translated pan ≈ 0.02286, got ${pt.x}`
    );
    assert.equal(pt.y, 0);
    assert.equal(pt.space, GENERIC_URI);
  });

  it('keeps the zoom vector and profile token intact on a translated move', async () => {
    await booted.postToProxy(relativeMoveEnvelope(FOV_URI, 0.5, -0.25, { zoomX: 0.3 }));

    const sent = booted.upstream.requests()[0].body;
    const zoom = extractZoom(sent);
    assert.ok(zoom, `upstream should have received a Zoom element; got: ${sent}`);
    assert.equal(zoom.x, 0.3);
    assert.equal(zoom.space, GENERIC_URI);
    assert.match(sent, /<tptz:ProfileToken>profile_1<\/tptz:ProfileToken>/);
  });

  it('strips the Speed element from a translated FOV move before forwarding', async () => {
    // Camera slow-path quirk: any Speed element slows the move to ~2.5x its
    // DefaultPTZSpeed pace regardless of value; omitting it is the fix.
    const inbound = relativeMoveEnvelope(FOV_URI, 0.1, 0, {
      speedXml: '<tptz:Speed><tt:PanTilt x="1.0" y="1.0"/></tptz:Speed>',
    });
    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    const sent = booted.upstream.requests()[0].body;
    assert.ok(!sent.includes('Speed'), `upstream must not see the Speed element; got: ${sent}`);
    const pt = extractPanTilt(sent);
    assert.ok(pt);
    assert.ok(
      Math.abs(pt.x - 0.0228571) < 1e-5,
      `translation must survive the strip, got ${pt.x}`
    );
    assert.equal(pt.space, GENERIC_URI);
    const moveLines = booted.logs.filter((/** @type {string} */ l) => l.includes('FOV RelativeMove'));
    assert.equal(moveLines.length, 1, `expected one move log line; logs: ${JSON.stringify(booted.logs)}`);
    assert.match(moveLines[0], /Speed stripped/, `log must note the strip; got: ${moveLines[0]}`);
  });

  it('answers a zero-magnitude FOV RelativeMove locally without ever forwarding it', async () => {
    // The live camera rejects RelativeMove(0,0) with 400 Sender/ter:InvalidArgVal,
    // which crashes Frigate's calibration sweep (its step 0 is exactly (0,0)).
    const inbound = relativeMoveEnvelope(FOV_URI, 0, 0, {
      speedXml: '<tptz:Speed><tt:PanTilt x="1.0" y="1.0"/></tptz:Speed>',
    });
    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    assert.match(response.body, /<tptz:RelativeMoveResponse/, `expected a RelativeMoveResponse; got: ${response.body}`);
    assert.equal(booted.upstream.requests().length, 0, 'the camera must never see the zero-magnitude move');

    const moveLines = booted.logs.filter((/** @type {string} */ l) => l.includes('FOV RelativeMove'));
    assert.equal(moveLines.length, 1, `expected one move log line; logs: ${JSON.stringify(booted.logs)}`);
    assert.match(moveLines[0], /answered locally/);
  });

  it('forwards a zero pan/tilt move that carries a real Zoom translation (gate)', async () => {
    // A (0,0) pan/tilt WITH Zoom x=0.01 is NOT a no-op — Frigate's relative
    // zoom calibration sends exactly this — so it must reach the camera.
    const inbound = relativeMoveEnvelope(FOV_URI, 0, 0, {
      zoomX: 0.01,
      speedXml: '<tptz:Speed><tt:PanTilt x="1.0" y="1.0"/></tptz:Speed>',
    });
    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    assert.equal(response.body, UPSTREAM_RESPONSE);
    const sent = booted.upstream.requests()[0].body;
    assert.ok(sent.includes('<tt:Zoom x="0.01"'), `Zoom translation must survive to upstream; got: ${sent}`);
    assert.equal(booted.logs.filter((/** @type {string} */ l) => l.includes('answered locally')).length, 0);
  });

  it('answers locally when a tiny FOV vector serializes to wire zero (gate)', async () => {
    // 1e-7 FOV -> 2.3e-8 generic -> "0" on the wire — the camera sees and
    // faults a zero move even though the float is not exactly 0.
    const inbound = relativeMoveEnvelope(FOV_URI, 0.0000001, 0);
    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    assert.match(response.body, /<tptz:RelativeMoveResponse/);
    assert.equal(booted.upstream.requests().length, 0, 'wire-zero moves must not be forwarded');
  });

  it('forwards a generic-space RelativeMove(0,0) verbatim — pass-through posture', async () => {
    const innerBody =
      '<tptz:RelativeMove>' +
      '<tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
      '<tptz:Translation>' +
      `<tt:PanTilt x="0" y="0" space="${GENERIC_URI}"/>` +
      '</tptz:Translation>' +
      '</tptz:RelativeMove>';
    const inbound =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
      ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
      ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
      `<soap:Body>${innerBody}</soap:Body>` +
      '</soap:Envelope>';

    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    assert.equal(response.body, UPSTREAM_RESPONSE, 'the camera fault/success for a generic zero move passes through');
    const captured = booted.upstream.requests();
    assert.equal(captured.length, 1);
    assert.ok(captured[0].body.includes(innerBody), `generic (0,0) must be forwarded verbatim; got: ${captured[0].body}`);
  });

  it('forwards a generic-space RelativeMove verbatim with no modification', async () => {
    const innerBody =
      '<tptz:RelativeMove>' +
      '<tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
      '<tptz:Translation>' +
      `<tt:PanTilt x="0.1" y="0" space="${GENERIC_URI}"/>` +
      `<tt:Zoom x="0" space="${GENERIC_URI}"/>` +
      '</tptz:Translation>' +
      '</tptz:RelativeMove>';
    const inbound =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
      ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
      ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
      `<soap:Body>${innerBody}</soap:Body>` +
      '</soap:Envelope>';

    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    const captured = booted.upstream.requests();
    assert.equal(captured.length, 1);
    assert.ok(
      captured[0].body.includes(innerBody),
      `upstream should have received the generic-space body verbatim; got: ${captured[0].body}`
    );
  });
});
