'use strict';

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { bootProxy, teardownProxy } = require('../helpers/boot-proxy');
const { envelope, clientSecurity } = require('../helpers/soap-fixtures');

const UPSTREAM_RESPONSE = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><tds:GetCapabilitiesResponse><tds:Capabilities/></tds:GetCapabilitiesResponse></soap:Body></soap:Envelope>';

describe('proxy HTTP listener — pass-through', () => {
  /** @type {any} */
  let booted;

  beforeEach(async () => {
    booted = await bootProxy({ upstream: { status: 200, body: UPSTREAM_RESPONSE } });
  });

  afterEach(async () => {
    await teardownProxy(booted);
  });

  /** @param {string} envelope */
  function envelopeOf(envelope) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
<soap:Body>${envelope}</soap:Body>
</soap:Envelope>`;
  }

  const REPRESENTATIVE_BODIES = {
    GetCapabilities: '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
    GetStatus: '<tptz:GetStatus><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetStatus>',
    GetPresets: '<tptz:GetPresets><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetPresets>',
    GetImagingSettings:
      '<timg:GetImagingSettings><timg:VideoSourceToken>vs1</timg:VideoSourceToken></timg:GetImagingSettings>',
    GetServiceCapabilities: '<tptz:GetServiceCapabilities/>',
    GetProfiles: '<trt:GetProfiles/>',
    GetVideoSources: '<trt:GetVideoSources/>',
    GetConfiguration: '<tptz:GetConfiguration><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:GetConfiguration>',
  };

  for (const [name, body] of Object.entries(REPRESENTATIVE_BODIES)) {
    it(`forwards a raw SOAP ${name} to upstream with the body verbatim`, async () => {
      const inbound = envelopeOf(body);
      const response = await booted.postToProxy(inbound);

      assert.equal(response.status, 200);
      assert.equal(response.body, UPSTREAM_RESPONSE);

      const captured = booted.upstream.requests();
      assert.equal(captured.length, 1);
      assert.equal(captured[0].method, 'POST');
      assert.equal(captured[0].path, '/onvif/service');

      // Inner body content is forwarded verbatim
      assert.ok(
        captured[0].body.includes(body),
        `upstream should have received the original body content; got: ${captured[0].body}`
      );
    });
  }

  it('relays the client\'s WS-UsernameToken verbatim into the outbound envelope (ADR-0008)', async () => {
    const security = clientSecurity('frigate-user');
    const inbound = envelope('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', security);
    await booted.postToProxy(inbound);

    const captured = booted.upstream.requests();
    assert.equal(captured.length, 1);
    const sent = captured[0].body;
    assert.ok(
      sent.includes(security),
      'outbound header must carry the client Security element byte-for-byte'
    );
    assert.match(sent, /<wsse:Username>frigate-user<\/wsse:Username>/);
    assert.match(sent, /Type="http:\/\/docs\.oasis-open\.org\/wss\/2004\/01\/oasis-200401-wss-username-token-profile-1\.0#PasswordDigest"/);
  });

  it('forwards unauthenticated when the client supplies no Security header', async () => {
    const inbound = envelope('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    const response = await booted.postToProxy(inbound);

    // ADR-0005 posture: the proxy never invents credentials; the camera's
    // answer (here: the stub's 200) comes back untouched.
    assert.equal(response.status, 200);
    const sent = booted.upstream.requests()[0].body;
    assert.match(sent, /<soap:Header><\/soap:Header>/);
    assert.ok(!sent.includes('wsse:'), 'no credential material may appear without a client header');
  });

  it('carries Header-tag namespace bindings through the rebuild so the relayed token stays bound', async () => {
    const inbound =
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
      '<soap:Header xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<wsse:Security><wsse:UsernameToken><wsse:Username>header-bound</wsse:Username></wsse:UsernameToken></wsse:Security>' +
      '</soap:Header>' +
      '<soap:Body><tds:GetCapabilities/></soap:Body></soap:Envelope>';
    await booted.postToProxy(inbound);

    const sent = booted.upstream.requests()[0].body;
    assert.match(
      sent,
      /<soap:Header xmlns:wsse="http:\/\/docs\.oasis-open\.org\/wss\/2004\/01\/oasis-200401-wss-wssecurity-secext-1\.0\.xsd">/,
      'the inbound Header binding must ride on the outbound Header'
    );
  });

  it('never hoists a Security element from the Body into the outbound header', async () => {
    const inbound =
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:s="urn:wsse">' +
      '<soap:Header/>' +
      '<soap:Body><s:Security><s:UsernameToken><s:Username>body-injected</s:Username></s:UsernameToken></s:Security></soap:Body>' +
      '</soap:Envelope>';
    await booted.postToProxy(inbound);

    const sent = booted.upstream.requests()[0].body;
    assert.ok(
      !/<soap:Header[^>]*><s:Security>/.test(sent),
      'a payload Security element must not be relayed as credentials'
    );
    assert.ok(sent.includes('body-injected'), 'sanity: the payload itself still passes through verbatim');
  });

  it('preserves the inbound envelope namespace declarations so prefixed body elements stay bound upstream', async () => {
    const inbound =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl">\n' +
      '<soap:Body><tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities></soap:Body>\n' +
      '</soap:Envelope>';
    await booted.postToProxy(inbound);

    const sent = booted.upstream.requests()[0].body;
    assert.match(sent, /xmlns:tds="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"/);
    assert.match(sent, /xmlns:trt="http:\/\/www\.onvif\.org\/ver10\/media\/wsdl"/);
    // Sanity: only one xmlns:soap declaration on the outbound envelope,
    // even though the inbound also declared it.
    const soapDecls = sent.match(/xmlns:soap=/g) || [];
    assert.equal(soapDecls.length, 1);
  });

  it('forwards the request path to upstream unchanged', async () => {
    const inbound = envelopeOf('<trt:GetProfiles/>');
    await booted.postToProxy(inbound, '/onvif/device_service');
    assert.equal(booted.upstream.requests()[0].path, '/onvif/device_service');
  });

  it('forwards a zeep-style SOAP-ENV:-prefixed GetCapabilities (the real Frigate shape)', async () => {
    const inbound =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<SOAP-ENV:Envelope xmlns:SOAP-ENC="http://www.w3.org/2003/05/soap-encoding" ` +
      `xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" ` +
      `xmlns:tds="http://www.onvif.org/ver10/device/wsdl">` +
      `<SOAP-ENV:Header/><SOAP-ENV:Body>` +
      `<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>` +
      `</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 200);
    assert.equal(response.body, UPSTREAM_RESPONSE);
    const sent = booted.upstream.requests()[0].body;
    assert.ok(
      sent.includes('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>'),
      `upstream should have received the zeep body verbatim; got: ${sent}`
    );
  });
});

describe('proxy HTTP listener — fault pass-through', () => {
  /** @type {any} */
  let booted;

  beforeEach(async () => {
    const faultBody =
      '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><soap:Fault><Code>soap:Sender</Code><Reason><Text>auth failed</Text></Reason></soap:Fault></soap:Body></soap:Envelope>';
    booted = await bootProxy({ upstream: { status: 401, body: faultBody } });
  });

  afterEach(async () => {
    await teardownProxy(booted);
  });

  it('returns a SOAP fault from upstream verbatim to the client', async () => {
    const inbound =
      '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><soap:Body><tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities></soap:Body></soap:Envelope>';

    const response = await booted.postToProxy(inbound);

    assert.equal(response.status, 401);
    // The stub response was a SOAP fault envelope
    assert.match(response.body, /<soap:Fault>/);
    assert.match(response.body, /auth failed/);
  });
});