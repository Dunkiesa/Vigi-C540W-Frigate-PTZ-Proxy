'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fovToGeneric, translateRelativeMove, GENERIC_URI } = require('../../src/fov-translation');
const { FOV_URI } = require('../../src/response-injection');
const { extractPanTilt, extractZoom } = require('../helpers/soap-xml');

/**
 * The locked spec-sheet binding: HFOV 80°, VFOV 43.2°,
 * pan-mech 350°, tilt-mech 120°.
 */
const BINDING = { hfovDeg: 80, vfovDeg: 43.2, panMechDeg: 350, tiltMechDeg: 120 };

/**
 * @param {number} actual
 * @param {number} expected
 * @param {string} label
 */
function assertClose(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${label}: expected ${expected}, got ${actual}`
  );
}

describe('fovToGeneric — pure FOV-to-generic conversion (ADR-0002)', () => {
  // Expected values are hand-derived from the translation formula
  //   generic = (fov * fov_deg) / mech_deg
  // using the locked spec-sheet numbers, e.g. (0.1 * 80) / 350 = 8/350.
  const GRID = [
    { in: { x: 0, y: 0 }, out: { x: 0, y: 0 } },
    { in: { x: 0.1, y: 0 }, out: { x: 0.0228571, y: 0 } }, // acceptance: ≈ 0.02286
    { in: { x: 0, y: 0.1 }, out: { x: 0, y: 0.036 } },
    { in: { x: 1, y: 1 }, out: { x: 0.2285714, y: 0.36 } },
    { in: { x: -1, y: -1 }, out: { x: -0.2285714, y: -0.36 } },
    { in: { x: -1, y: 1 }, out: { x: -0.2285714, y: 0.36 } },
    { in: { x: 0.5, y: -0.5 }, out: { x: 0.1142857, y: -0.18 } },
    { in: { x: -0.1, y: 0.25 }, out: { x: -0.0228571, y: 0.09 } },
  ];

  for (const { in: move, out } of GRID) {
    it(`converts fov(${move.x}, ${move.y}) to generic(${out.x}, ${out.y})`, () => {
      const result = fovToGeneric(move, BINDING);
      assertClose(result.x, out.x, 'x');
      assertClose(result.y, out.y, 'y');
    });
  }

  it('honours per-instance binding values rather than the spec sheet', () => {
    // HFOV 90°, pan-mech 360°: (1 * 90) / 360 = 0.25
    const result = fovToGeneric(
      { x: 1, y: 1 },
      { hfovDeg: 90, vfovDeg: 60, panMechDeg: 360, tiltMechDeg: 120 }
    );
    assertClose(result.x, 0.25, 'x');
    assertClose(result.y, 0.5, 'y');
  });
});

/**
 * Build a RelativeMove SOAP body content (the inner `<soap:Body>` payload) in
 * the shape Frigate emits. `space` is the pan/tilt translation-space URI;
 * zoom always rides in the generic space (onvif.py:404).
 *
 * @param {string} space pan/tilt translation-space URI
 * @param {number | string} x
 * @param {number | string} y
 * @param {{ zoomX?: number, speedXml?: string }} [opts]
 * @returns {string}
 */
function relativeMoveBody(space, x, y, opts = {}) {
  const zoomX = opts.zoomX !== undefined ? opts.zoomX : 0;
  return (
    '<tptz:RelativeMove>' +
    '<tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
    '<tptz:Translation>' +
    `<tt:PanTilt x="${x}" y="${y}" space="${space}"/>` +
    `<tt:Zoom x="${zoomX}" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace"/>` +
    '</tptz:Translation>' +
    (opts.speedXml || '') +
    '</tptz:RelativeMove>'
  );
}

describe('translateRelativeMove — FOV pan/tilt becomes generic upstream', () => {
  it('rewrites a FOV-space RelativeMove(0.1, 0) into generic space using the binding', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0);
    const { body, translated } = translateRelativeMove(inbound, BINDING);

    assert.equal(translated, true);
    const pt = extractPanTilt(body);
    assert.ok(pt, `expected a PanTilt element in the translated body; got: ${body}`);
    // (0.1 * 80) / 350 ≈ 0.02286 per ADR-0002; tilt stays 0.
    assertClose(pt.x, 0.0228571, 'translated pan');
    assertClose(pt.y, 0, 'translated tilt');
    assert.equal(pt.space, GENERIC_URI);
  });

  it('translates both axes of a FOV-space move', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.5, -0.25);
    const { body, translated } = translateRelativeMove(inbound, BINDING);

    assert.equal(translated, true);
    const pt = extractPanTilt(body);
    assert.ok(pt);
    // pan: (0.5 * 80) / 350 ≈ 0.1142857; tilt: (-0.25 * 43.2) / 120 = -0.09
    assertClose(pt.x, 0.1142857, 'translated pan');
    assertClose(pt.y, -0.09, 'translated tilt');
    assert.equal(pt.space, GENERIC_URI);
  });

  it('passes the zoom element through verbatim (zoom is already generic)', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0, { zoomX: 0.42 });
    const { body } = translateRelativeMove(inbound, BINDING);

    const zoom = extractZoom(body);
    assert.ok(zoom, `expected a Zoom element in the translated body; got: ${body}`);
    assertClose(zoom.x, 0.42, 'zoom value');
    assert.match(zoom.space, /TranslationGenericSpace/);
  });

  it('preserves the ProfileToken and overall RelativeMove shape', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0);
    const { body } = translateRelativeMove(inbound, BINDING);

    assert.match(body, /<tptz:RelativeMove>/);
    assert.match(body, /<tptz:ProfileToken>profile_1<\/tptz:ProfileToken>/);
    assert.match(body, /<\/tptz:RelativeMove>/);
  });

  it('reports the inbound and outbound translations for logging', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0);
    const { translated, inbound: from, outbound } = translateRelativeMove(inbound, BINDING);

    assert.equal(translated, true);
    assert.ok(from && outbound);
    assertClose(from.x, 0.1, 'inbound pan');
    assertClose(from.y, 0, 'inbound tilt');
    assertClose(outbound.x, 0.0228571, 'outbound pan');
    assertClose(outbound.y, 0, 'outbound tilt');
  });
});

describe('translateRelativeMove — strips Speed from the translated move', () => {
  // Live-camera measurement (2026-08-31): a RelativeMove WITHOUT Speed runs a
  // 0.15 pan leg in ~1.3s (camera's max DefaultPTZSpeed); WITH a Speed
  // element — any value, with or without @space — the same leg takes ~3.2s.
  // The camera takes a slow path whenever Speed is present, so the translated
  // move must leave it out. Frigate always sends Speed PanTilt=1.0
  // (onvif.py:661).
  const SPEED_PAIRED = '<tptz:Speed><tt:PanTilt x="1.0" y="1.0"/></tptz:Speed>';

  it('removes a paired Speed element from a translated FOV move', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0, { speedXml: SPEED_PAIRED });
    const { body, translated, speedStripped } = translateRelativeMove(inbound, BINDING);

    assert.equal(translated, true);
    assert.equal(speedStripped, true);
    assert.ok(!body.includes('Speed'), `Speed must be stripped; got: ${body}`);
    assert.match(body, /<tptz:ProfileToken>profile_1<\/tptz:ProfileToken>/, 'profile token survives the strip');
    assert.ok(body.includes('<tt:Zoom x="0"'), 'zoom element survives the strip');
    const pt = extractPanTilt(body);
    assert.ok(pt);
    assertClose(pt.x, 0.0228571, 'translated pan still correct after strip');
    assert.equal(pt.space, GENERIC_URI);
  });

  it('removes the WHOLE Speed element when a quoted attribute contains />', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0, {
      speedXml: '<tt:Speed tt:x="a/>b"><tt:PanTilt x="1.0" y="1.0"/></tt:Speed>',
    });
    const { body, speedStripped } = translateRelativeMove(inbound, BINDING);

    assert.equal(speedStripped, true);
    assert.ok(!body.includes('a/>b'), `no fragment of the element may survive; got: ${body}`);
    assert.ok(!body.includes('Speed'), `Speed must be stripped; got: ${body}`);
  });

  it('removes a self-closing Speed element too', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0, { speedXml: '<tptz:Speed/>' });
    const { body, speedStripped } = translateRelativeMove(inbound, BINDING);

    assert.equal(speedStripped, true);
    assert.ok(!body.includes('Speed'), `Speed must be stripped; got: ${body}`);
  });

  it('a translated move without Speed is unchanged apart from the translation', () => {
    const inbound = relativeMoveBody(FOV_URI, 0.1, 0);
    const { body, speedStripped } = translateRelativeMove(inbound, BINDING);

    assert.equal(speedStripped, false);
    assert.ok(!body.includes('Speed'));
  });

  it('leaves Speed intact on non-translated bodies (pass-through posture)', () => {
    const inbound = relativeMoveBody(GENERIC_URI, 0.1, 0, { speedXml: SPEED_PAIRED });
    const result = translateRelativeMove(inbound, BINDING);

    assert.equal(result.body, inbound);
    assert.equal(result.speedStripped, false);
  });
});

describe('translateRelativeMove — reports the Zoom translation (local-answer gate)', () => {
  it('reports the Zoom x present on a translated move', () => {
    const inbound = relativeMoveBody(FOV_URI, 0, 0, { zoomX: 0.42 });
    assert.equal(translateRelativeMove(inbound, BINDING).outboundZoom, 0.42);
  });

  it('reports 0 for a zero Zoom translation', () => {
    const inbound = relativeMoveBody(FOV_URI, 0, 0, { zoomX: 0 });
    assert.equal(translateRelativeMove(inbound, BINDING).outboundZoom, 0);
  });

  it('reports null when the move carries no Zoom at all', () => {
    const inbound =
      '<tptz:RelativeMove><tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
      `<tptz:Translation><tt:PanTilt x="0.1" y="0" space="${FOV_URI}"/></tptz:Translation></tptz:RelativeMove>`;
    assert.equal(translateRelativeMove(inbound, BINDING).outboundZoom, null);
  });

  it('does not mistake the Speed block Zoom for a motion Zoom', () => {
    const inbound =
      '<tptz:RelativeMove><tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
      `<tptz:Translation><tt:PanTilt x="0" y="0" space="${FOV_URI}"/></tptz:Translation>` +
      '<tptz:Speed><tt:PanTilt x="1" y="1"/><tt:Zoom x="1"/></tptz:Speed></tptz:RelativeMove>';
    assert.equal(translateRelativeMove(inbound, BINDING).outboundZoom, null);
  });
});

describe('translateRelativeMove — non-FOV bodies pass through verbatim', () => {
  it('returns a generic-space RelativeMove byte-for-byte unchanged', () => {
    const inbound = relativeMoveBody(GENERIC_URI, 0.1, 0, { zoomX: -0.01 });
    const result = translateRelativeMove(inbound, BINDING);

    assert.equal(result.body, inbound);
    assert.equal(result.translated, false);
    assert.equal(result.inbound, null);
    assert.equal(result.outbound, null);
  });

  it('returns a RelativeMove with an unrecognized pan/tilt space unchanged (pass-through posture, ADR-0005)', () => {
    const inbound = relativeMoveBody('http://example.com/SomeOtherSpace', 0.3, 0.2);
    const result = translateRelativeMove(inbound, BINDING);

    assert.equal(result.body, inbound);
    assert.equal(result.translated, false);
  });

  it('returns a body without a PanTilt element unchanged', () => {
    const inbound =
      '<tptz:RelativeMove>' +
      '<tptz:ProfileToken>profile_1</tptz:ProfileToken>' +
      '<tptz:Translation>' +
      '<tt:Zoom x="0.1" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace"/>' +
      '</tptz:Translation>' +
      '</tptz:RelativeMove>';
    const result = translateRelativeMove(inbound, BINDING);

    assert.equal(result.body, inbound);
    assert.equal(result.translated, false);
  });

  it('returns a FOV-space body with non-numeric vector values unchanged', () => {
    const inbound = relativeMoveBody(FOV_URI, 'NaN-ish', 0);
    const result = translateRelativeMove(inbound, BINDING);

    assert.equal(result.body, inbound);
    assert.equal(result.translated, false);
  });
});
