'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { injectTranslationSpaceFov, rewriteXAddrs, FOV_URI } = require('../../src/response-injection');

// Flat wire shape per the schema: each RelativePanTiltTranslationSpace element
// carries URI/XRange/YRange as DIRECT children (tt:Space2DDescription). The
// element prefix (tptz) deliberately differs from the child prefix (tt) so the
// tests pin the prefix-reuse behaviour of the injection.
const GENERIC_RESPONSE =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
  ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
  ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
  '<soap:Body>' +
  '<tptz:GetConfigurationOptionsResponse>' +
  '<tptz:Spaces>' +
  '<tptz:RelativePanTiltTranslationSpace>' +
  '<tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI>' +
  '<tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>' +
  '<tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>' +
  '</tptz:RelativePanTiltTranslationSpace>' +
  '</tptz:Spaces>' +
  '</tptz:GetConfigurationOptionsResponse>' +
  '</soap:Body>' +
  '</soap:Envelope>';

const ALREADY_INCLUDES_FOV_RESPONSE =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
  ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
  ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
  '<soap:Body>' +
  '<tptz:GetConfigurationOptionsResponse>' +
  '<tptz:Spaces>' +
  '<tptz:RelativePanTiltTranslationSpace>' +
  '<tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI>' +
  '<tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>' +
  '<tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>' +
  '</tptz:RelativePanTiltTranslationSpace>' +
  '<tptz:RelativePanTiltTranslationSpace>' +
  `<tt:URI>${FOV_URI}</tt:URI>` +
  '<tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>' +
  '<tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>' +
  '</tptz:RelativePanTiltTranslationSpace>' +
  '</tptz:Spaces>' +
  '</tptz:GetConfigurationOptionsResponse>' +
  '</soap:Body>' +
  '</soap:Envelope>';

describe('injectTranslationSpaceFov — appends a FOV sibling element', () => {
  it('appends a RelativePanTiltTranslationSpace sibling whose FOV URI is a direct child', () => {
    const out = injectTranslationSpaceFov(GENERIC_RESPONSE);
    assert.match(out, /<tptz:RelativePanTiltTranslationSpace>/);
    const fovCount = (out.match(/TranslationSpaceFov/g) || []).length;
    assert.equal(fovCount, 1);
    assert.match(out, new RegExp(`<tptz:RelativePanTiltTranslationSpace><tt:URI>${FOV_URI}</tt:URI>`));
  });

  it('uses the canonical [-1, 1] range on the injected space (XRange.Min, XRange.Max, YRange.Min, YRange.Max)', () => {
    const out = injectTranslationSpaceFov(GENERIC_RESPONSE);
    const fovSpace = extractFovSibling(out);
    assert.ok(fovSpace, 'expected a RelativePanTiltTranslationSpace with a direct FOV URI child');
    assert.match(fovSpace, /<tt:XRange><tt:Min>-1(?:\.0)?<\/tt:Min><tt:Max>1(?:\.0)?<\/tt:Max><\/tt:XRange>/);
    assert.match(fovSpace, /<tt:YRange><tt:Min>-1(?:\.0)?<\/tt:Min><tt:Max>1(?:\.0)?<\/tt:Max><\/tt:YRange>/);
  });

  it('preserves the existing TranslationGenericSpace entry alongside the injected FOV entry', () => {
    const out = injectTranslationSpaceFov(GENERIC_RESPONSE);
    assert.match(out, /TranslationGenericSpace/);
    assert.match(out, /TranslationSpaceFov/);
  });

  it('preserves everything outside RelativePanTiltTranslationSpace verbatim (envelope, body, other config)', () => {
    const out = injectTranslationSpaceFov(GENERIC_RESPONSE);
    assert.ok(out.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
    assert.match(out, /<soap:Envelope /);
    assert.match(out, /<soap:Body>/);
    assert.match(out, /<\/soap:Body>/);
    assert.match(out, /<\/soap:Envelope>/);
    assert.match(out, /<\/tptz:GetConfigurationOptionsResponse>/);
  });

  it('preserves any other XML present in the response body that is not the translation-space array', () => {
    const fullerResponse = GENERIC_RESPONSE
      .replace(
        '</tptz:Spaces>',
        '<tptz:RelativeZoomTranslationSpace>' +
        '<tt:URI>http://www.onvif.org/ver10/tptz/ZoomSpaces/TranslationGenericSpace</tt:URI>' +
        '<tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>' +
        '</tptz:RelativeZoomTranslationSpace>' +
        '</tptz:Spaces>'
      )
      .replace(
        '</tptz:GetConfigurationOptionsResponse>',
        '<tptz:PTZConfiguration><tptz:Name>conf1</tptz:Name></tptz:PTZConfiguration></tptz:GetConfigurationOptionsResponse>'
      );
    const out = injectTranslationSpaceFov(fullerResponse);
    assert.match(out, /<tptz:RelativeZoomTranslationSpace>/);
    assert.match(out, /<tptz:PTZConfiguration>/);
    assert.match(out, /<tptz:Name>conf1<\/tptz:Name>/);
  });
});

describe('injectTranslationSpaceFov — idempotency', () => {
  it('does not duplicate the FOV entry when upstream already advertises it', () => {
    const out = injectTranslationSpaceFov(ALREADY_INCLUDES_FOV_RESPONSE);
    const fovCount = (out.match(/TranslationSpaceFov/g) || []).length;
    assert.equal(fovCount, 1, 'expected exactly one TranslationSpaceFov reference in output');
    assert.equal(out, ALREADY_INCLUDES_FOV_RESPONSE);
  });
});

describe('injectTranslationSpaceFov — pass-through when the array is absent', () => {
  it('returns the body unchanged when RelativePanTiltTranslationSpace is not present (upstream is broken; ADR-0005)', () => {
    const brokenResponse =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
      ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">' +
      '<soap:Body>' +
      '<tptz:GetConfigurationOptionsResponse>' +
      '<tptz:PTZConfiguration/>' +
      '</tptz:GetConfigurationOptionsResponse>' +
      '</soap:Body>' +
      '</soap:Envelope>';
    const out = injectTranslationSpaceFov(brokenResponse);
    assert.equal(out, brokenResponse);
  });
});

describe('injectTranslationSpaceFov — real-camera flat form (regression)', () => {
  // Captured verbatim from the target camera (tptz GetConfigurationOptions).
  // The schema (onvif.xsd tt:Space2DDescription) makes each
  // RelativePanTiltTranslationSpace element carry URI/XRange/YRange as DIRECT
  // children — no SpaceDescription wrapper. Anything nested one level deeper
  // is outside the content model and silently dropped by zeep, so the FOV URI
  // MUST land as a direct child of a sibling element for Frigate to see it.
  const CAPTURED_CAMERA_RESPONSE =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:SOAP-ENC="http://www.w3.org/2003/05/soap-encoding" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tptz="http://www.onvif.org/ver10/ptz/wsdl">' +
    '<SOAP-ENV:Body>' +
    '<tptz:GetConfigurationOptionsResponse>' +
    '<tt:Spaces>' +
    '<tt:AbsolutePanTiltPositionSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:AbsolutePanTiltPositionSpace>' +
    '<tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:RelativePanTiltTranslationSpace>' +
    '<tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace>' +
    '<tt:PanTiltSpeedSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/GenericSpeedSpace</tt:URI><tt:XRange><tt:Min>0</tt:Min><tt:Max>1</tt:Max></tt:XRange></tt:PanTiltSpeedSpace>' +
    '</tt:Spaces>' +
    '</tptz:GetConfigurationOptionsResponse>' +
    '</SOAP-ENV:Body>' +
    '</SOAP-ENV:Envelope>';

  it('appends a sibling element whose FOV URI is a direct child (content-model visible)', () => {
    const out = injectTranslationSpaceFov(CAPTURED_CAMERA_RESPONSE);
    assert.match(
      out,
      /<tt:RelativePanTiltTranslationSpace><tt:URI>http:\/\/www\.onvif\.org\/ver10\/tptz\/PanTiltSpaces\/TranslationSpaceFov<\/tt:URI>/,
      'FOV URI must be a direct child of its own RelativePanTiltTranslationSpace element, not nested'
    );
    const relCount = (out.match(/<tt:RelativePanTiltTranslationSpace>/g) || []).length;
    assert.equal(relCount, 2, 'expected the generic element plus one injected sibling');
  });

  it('keeps the injected sibling schema-valid (URI, XRange, YRange as direct children, in order)', () => {
    const out = injectTranslationSpaceFov(CAPTURED_CAMERA_RESPONSE);
    assert.match(
      out,
      /<tt:RelativePanTiltTranslationSpace><tt:URI>[^<]*TranslationSpaceFov[^<]*<\/tt:URI><tt:XRange><tt:Min>-1(?:\.0)?<\/tt:Min><tt:Max>1(?:\.0)?<\/tt:Max><\/tt:XRange><tt:YRange><tt:Min>-1(?:\.0)?<\/tt:Min><tt:Max>1(?:\.0)?<\/tt:Max><\/tt:YRange><\/tt:RelativePanTiltTranslationSpace>/
    );
  });

  it('inserts the sibling immediately after the last existing element, inside Spaces', () => {
    const out = injectTranslationSpaceFov(CAPTURED_CAMERA_RESPONSE);
    const fovElem = out.indexOf('<tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov</tt:URI>');
    const genericEnd = out.indexOf('</tt:RelativePanTiltTranslationSpace>', out.indexOf('<tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace'));
    const continuousStart = out.indexOf('<tt:ContinuousPanTiltVelocitySpace>');
    assert.ok(fovElem > genericEnd && fovElem < continuousStart, 'injected sibling must sit between the generic element and the next Spaces child');
  });

  it('leaves every other element of the captured response verbatim', () => {
    const withoutFov = injectTranslationSpaceFov(CAPTURED_CAMERA_RESPONSE).replace(
      /<tt:RelativePanTiltTranslationSpace><tt:URI>[^<]*TranslationSpaceFov[^<]*<\/tt:URI>[\s\S]*?<\/tt:RelativePanTiltTranslationSpace>/,
      ''
    );
    assert.equal(withoutFov, CAPTURED_CAMERA_RESPONSE);
  });

  it('is idempotent on the real captured form', () => {
    const once = injectTranslationSpaceFov(CAPTURED_CAMERA_RESPONSE);
    const twice = injectTranslationSpaceFov(once);
    assert.equal(twice, once);
    assert.equal((once.match(/TranslationSpaceFov/g) || []).length, 1);
  });
});

describe('injectTranslationSpaceFov — edge cases', () => {
  it('appends a sibling after a self-closing empty element instead of silently skipping', () => {
    const s = '<tt:Spaces xmlns:tt="http://www.onvif.org/ver10/schema"><tt:RelativePanTiltTranslationSpace/></tt:Spaces>';
    const out = injectTranslationSpaceFov(s);
    assert.ok(
      out.includes('<tt:RelativePanTiltTranslationSpace/><tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov</tt:URI>'),
      `expected a sibling after the self-closing element; got: ${out}`
    );
  });

  it('re-declares element-local xmlns bindings so the sibling stays in scope', () => {
    const s =
      '<x:RelativePanTiltTranslationSpace xmlns:x="http://www.onvif.org/ver10/schema">' +
      '<x:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace</x:URI>' +
      '</x:RelativePanTiltTranslationSpace>';
    const out = injectTranslationSpaceFov(s);
    assert.ok(
      out.includes('<x:RelativePanTiltTranslationSpace xmlns:x="http://www.onvif.org/ver10/schema"><x:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov</x:URI>'),
      `expected the sibling to carry the local xmlns declaration; got: ${out}`
    );
  });

  it('tolerates open/close prefix mismatch (same lenient policy as isSoapFaultBody)', () => {
    const s = '<tt:RelativePanTiltTranslationSpace><tt:URI>http://example/TranslationGenericSpace</tt:URI></tptz:RelativePanTiltTranslationSpace>';
    const out = injectTranslationSpaceFov(s);
    assert.notEqual(out, s);
    assert.ok(out.includes('<tt:RelativePanTiltTranslationSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov</tt:URI>'));
  });
});

describe('rewriteXAddrs — GetCapabilities XAddr rewriting', () => {
  // Shaped like the real camera response captured over tcpflow.
  const CAPS_RESPONSE =
    '<tds:Capabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">' +
    '<tt:Media><tt:XAddr>http://192.0.2.12:80/onvif/service</tt:XAddr></tt:Media>' +
    '<tt:PTZ><tt:XAddr>http://192.0.2.12:80/onvif/service</tt:XAddr></tt:PTZ>' +
    '<tt:Imaging><tt:XAddr>http://192.0.2.12:80/onvif/service</tt:XAddr></tt:Imaging>' +
    '<tt:Extension><tt:DeviceIO><tt:XAddr></tt:XAddr></tt:DeviceIO>' +
    '<tt:Recording><tt:XAddr>http://192.0.2.12:80/onvif/Recording</tt:XAddr></tt:Recording>' +
    '<tt:Replay><tt:XAddr>http://192.0.2.12:80/onvif/Replay</tt:XAddr></tt:Replay></tt:Extension>' +
    '</tds:Capabilities>';

  const PROXY = 'http://192.0.2.165:8080';

  it('points every XAddr authority at the proxy origin and preserves each path', () => {
    const out = rewriteXAddrs(CAPS_RESPONSE, PROXY);
    const addrs = [...out.matchAll(/<tt:XAddr>([^<]*)<\/tt:XAddr>/g)].map((m) => m[1]);
    assert.deepEqual(addrs, [
      `${PROXY}/onvif/service`,
      `${PROXY}/onvif/service`,
      `${PROXY}/onvif/service`,
      '',
      `${PROXY}/onvif/Recording`,
      `${PROXY}/onvif/Replay`,
    ]);
  });

  it('leaves the camera address nowhere in the rewritten fragment', () => {
    const out = rewriteXAddrs(CAPS_RESPONSE, PROXY);
    assert.ok(!out.includes('192.0.2.12'), `camera address survived the rewrite: ${out}`);
  });

  it('is idempotent: rewriting an already-rewritten body changes nothing', () => {
    const once = rewriteXAddrs(CAPS_RESPONSE, PROXY);
    const twice = rewriteXAddrs(once, PROXY);
    assert.equal(twice, once);
  });

  it('rewrites XAddr under any prefix, including none', () => {
    const s = '<s:Envelope><s:Body><XAddr>http://cam.local/onvif/service</XAddr><e:XAddr>http://cam/other</e:XAddr></s:Body></s:Envelope>';
    const out = rewriteXAddrs(s, 'http://proxy:9');
    assert.ok(out.includes('<XAddr>http://proxy:9/onvif/service</XAddr>'), out);
    assert.ok(out.includes('<e:XAddr>http://proxy:9/other</e:XAddr>'), out);
  });

  it('touches nothing outside XAddr elements (e.g. snapshot URIs)', () => {
    const withSnapshots =
      CAPS_RESPONSE +
      '<tt:Uri>http://192.0.2.12:80/snapshots/1.jpg</tt:Uri>' +
      '<tt:StreamUri><tt:Uri>rtsp://192.0.2.12:554/stream</tt:Uri></tt:StreamUri>';
    const out = rewriteXAddrs(withSnapshots, PROXY);
    assert.ok(out.includes('<tt:Uri>http://192.0.2.12:80/snapshots/1.jpg</tt:Uri>'));
    assert.ok(out.includes('rtsp://192.0.2.12:554/stream'));
  });

  it('normalizes a bare authority (no path) to proxy origin + empty path', () => {
    const out = rewriteXAddrs('<tt:XAddr>http://192.0.2.12</tt:XAddr>', PROXY);
    assert.equal(out, `<tt:XAddr>${PROXY}</tt:XAddr>`);
  });
});

/**
 * Pull the first `<...:RelativePanTiltTranslationSpace>` element whose DIRECT
 * child URI contains "TranslationSpaceFov" — i.e. the one a schema parser
 * would show Frigate. Used by the range-shape assertions.
 *
 * @param {string} xml
 * @returns {string | null}
 */
function extractFovSibling(xml) {
  const spaceRegex = /<(?:[^:]+:)?RelativePanTiltTranslationSpace\b[^>]*>[\s\S]*?<\/(?:[^:]+:)?RelativePanTiltTranslationSpace>/gi;
  let m;
  while ((m = spaceRegex.exec(xml)) !== null) {
    const inner = m[0].replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
    if (/^<(?:[a-zA-Z][\w.-]*:)?URI\b[^>]*>[^<]*TranslationSpaceFov/i.test(inner)) return m[0];
  }
  return null;
}
