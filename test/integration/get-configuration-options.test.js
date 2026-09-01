'use strict';

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { bootProxy, teardownProxy } = require('../helpers/boot-proxy');
const { FOV_URI } = require('../../src/response-injection');

const GENERIC_URI = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace';

// Flat wire shape per the schema (tt:Space2DDescription direct children) and
// matching the live camera capture that originally exposed the nested-wrapper
// injection bug.
const UPSTREAM_GET_CONFIG_OPTIONS_RESPONSE =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
  ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
  ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
  '<soap:Body>' +
  '<tptz:GetConfigurationOptionsResponse>' +
  '<tptz:Spaces>' +
  '<tptz:RelativePanTiltTranslationSpace>' +
  `<tt:URI>${GENERIC_URI}</tt:URI>` +
  '<tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange>' +
  '<tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange>' +
  '</tptz:RelativePanTiltTranslationSpace>' +
  '</tptz:Spaces>' +
  '</tptz:GetConfigurationOptionsResponse>' +
  '</soap:Body>' +
  '</soap:Envelope>';

const UPSTREAM_GET_CONFIG_OPTIONS_RESPONSE_WITH_FOV =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
  ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
  ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
  '<soap:Body>' +
  '<tptz:GetConfigurationOptionsResponse>' +
  '<tptz:Spaces>' +
  '<tptz:RelativePanTiltTranslationSpace>' +
  `<tt:URI>${GENERIC_URI}</tt:URI>` +
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

/**
 * @param {string} envelope
 */
function envelopeOf(envelope) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"' +
    ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
    `<soap:Body>${envelope}</soap:Body>` +
    '</soap:Envelope>'
  );
}

describe('proxy HTTP listener — GetConfigurationOptions injection', () => {
  /** @type {any} */
  let booted;

  beforeEach(async () => {
    booted = await bootProxy({
      upstream: {
        respondWith: /** @type {(req: any) => { status: number, body: string }} */ (req) => {
          if (req.body.includes('GetConfigurationOptions')) {
            return { status: 200, body: UPSTREAM_GET_CONFIG_OPTIONS_RESPONSE };
          }
          if (req.body.includes('GetProfiles')) {
            return {
              status: 200,
              body:
                '<?xml version="1.0" encoding="utf-8"?>' +
                '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
                ' xmlns:trt="http://www.onvif.org/ver10/media/wsdl">' +
                '<soap:Body><trt:GetProfilesResponse/></soap:Body>' +
                '</soap:Envelope>',
            };
          }
          if (req.body.includes('GetStatus')) {
            return {
              status: 200,
              body:
                '<?xml version="1.0" encoding="utf-8"?>' +
                '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
                ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">' +
                '<soap:Body><tptz:GetStatusResponse><tptz:PTZStatus><tptz:MoveStatus><tptz:PanTilt>IDLE</tptz:PanTilt></tptz:MoveStatus></tptz:PTZStatus></tptz:GetStatusResponse></soap:Body>' +
                '</soap:Envelope>',
            };
          }
          if (req.body.includes('GetCapabilities')) {
            return {
              status: 200,
              body:
                '<?xml version="1.0" encoding="utf-8"?>' +
                '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
                ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
                '<soap:Body><tds:GetCapabilitiesResponse/></soap:Body>' +
                '</soap:Envelope>',
            };
          }
          return { status: 200, body: '<ok/>' };
        },
      },
    });
  });

  afterEach(async () => {
    await teardownProxy(booted);
  });

  it('returns a GetConfigurationOptions response that contains TranslationSpaceFov in RelativePanTiltTranslationSpace', async () => {
    const inbound = envelopeOf('<tptz:GetConfigurationOptions><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetConfigurationOptions>');
    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    assert.match(response.body, /<tptz:RelativePanTiltTranslationSpace>/);
    assert.match(response.body, /TranslationSpaceFov/);
    assert.match(response.body, new RegExp(`<tt:URI>${FOV_URI}</tt:URI>`));
    assert.ok(
      response.body.includes(`<tptz:RelativePanTiltTranslationSpace><tt:URI>${FOV_URI}</tt:URI>`),
      'FOV URI must be a DIRECT child of its own RelativePanTiltTranslationSpace element (schema content model); a nested wrapper is invisible to zeep'
    );
  });

  it('advertises the canonical [-1, 1] XRange and YRange on the injected FOV space', async () => {
    const inbound = envelopeOf('<tptz:GetConfigurationOptions><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetConfigurationOptions>');
    const response = await booted.postToProxy(inbound);

    assert.match(response.body, /<tt:XRange><tt:Min>-1(?:\.0)?<\/tt:Min><tt:Max>1(?:\.0)?<\/tt:Max><\/tt:XRange>/);
    assert.match(response.body, /<tt:YRange><tt:Min>-1(?:\.0)?<\/tt:Min><tt:Max>1(?:\.0)?<\/tt:Max><\/tt:YRange>/);
  });

  it('preserves the existing TranslationGenericSpace entry in the same array', async () => {
    const inbound = envelopeOf('<tptz:GetConfigurationOptions><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetConfigurationOptions>');
    const response = await booted.postToProxy(inbound);

    assert.match(response.body, /TranslationGenericSpace/);
    assert.match(response.body, /TranslationSpaceFov/);
  });

  it('only injects into the GetConfigurationOptions response — other calls return the upstream body verbatim', async () => {
    const getProfiles = envelopeOf('<trt:GetProfiles/>');
    const profilesResponse = await booted.postToProxy(getProfiles);
    assert.equal(profilesResponse.status, 200);
    assert.ok(
      !profilesResponse.body.includes('TranslationSpaceFov'),
      `GetProfiles response should NOT contain the injected FOV space; got: ${profilesResponse.body}`
    );
    assert.ok(profilesResponse.body.includes('GetProfilesResponse'));

    const getStatus = envelopeOf('<tptz:GetStatus><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetStatus>');
    const statusResponse = await booted.postToProxy(getStatus);
    assert.equal(statusResponse.status, 200);
    assert.ok(
      !statusResponse.body.includes('TranslationSpaceFov'),
      `GetStatus response should NOT contain the injected FOV space; got: ${statusResponse.body}`
    );
    assert.ok(statusResponse.body.includes('MoveStatus'));
    assert.match(statusResponse.body, /<tptz:PanTilt>IDLE<\/tptz:PanTilt>/);

    const getCapabilities = envelopeOf('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    const capsResponse = await booted.postToProxy(getCapabilities);
    assert.equal(capsResponse.status, 200);
    assert.ok(
      !capsResponse.body.includes('TranslationSpaceFov'),
      `GetCapabilities response should NOT contain the injected FOV space; got: ${capsResponse.body}`
    );
    assert.ok(capsResponse.body.includes('GetCapabilitiesResponse'));
  });

  it('does not double-inject: upstream responses that already advertise FOV stay single-occurrence', async () => {
    // Boot a proxy whose upstream stub returns a response that already has FOV.
    await teardownProxy(booted);
    booted = await bootProxy({
      upstream: {
        respondWith: /** @type {(req: any) => { status: number, body: string }} */ (req) => {
          if (req.body.includes('GetConfigurationOptions')) {
            return { status: 200, body: UPSTREAM_GET_CONFIG_OPTIONS_RESPONSE_WITH_FOV };
          }
          return { status: 200, body: '<ok/>' };
        },
      },
    });

    const inbound = envelopeOf('<tptz:GetConfigurationOptions><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetConfigurationOptions>');
    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    const fovCount = (response.body.match(/TranslationSpaceFov/g) || []).length;
    assert.equal(fovCount, 1, `expected exactly one FOV reference in the proxied response; got ${fovCount}`);
    assert.equal(
      booted.logs.filter((/** @type {string} */ l) => l.includes('injected TranslationSpaceFov')).length,
      0,
      `nothing was rewritten, so nothing must be logged; logs: ${JSON.stringify(booted.logs)}`
    );
  });

  it('still forwards the inner GetConfigurationOptions body content to upstream verbatim (no request rewriting)', async () => {
    const inboundBody = '<tptz:GetConfigurationOptions><tptz:ProfileToken>prof1</tptz:ProfileToken><tptz:ConfigurationToken>cfg1</tptz:ConfigurationToken></tptz:GetConfigurationOptions>';
    const inbound = envelopeOf(inboundBody);
    await booted.postToProxy(inbound);

    const sent = booted.upstream.requests()[0].body;
    assert.ok(sent.includes(inboundBody), `upstream should have received the inner body verbatim; got: ${sent}`);
  });
});
