'use strict';

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { bootProxy, teardownProxy } = require('../helpers/boot-proxy');

/**
 * Realistic GetCapabilities response: the camera advertises every service on
 * its own address (captured from the target via tcpflow).
 */
const CAPS_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
  ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl"' +
  ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
  '<soap:Body><tds:GetCapabilitiesResponse><tds:Capabilities>' +
  '<tt:Media><tt:XAddr>http://192.0.2.12:80/onvif/service</tt:XAddr></tt:Media>' +
  '<tt:PTZ><tt:XAddr>http://192.0.2.12:80/onvif/service</tt:XAddr></tt:PTZ>' +
  '</tds:Capabilities></tds:GetCapabilitiesResponse></soap:Body></soap:Envelope>';

const GET_CAPABILITIES =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
  ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
  '<soap:Body><tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities></soap:Body>' +
  '</soap:Envelope>';

describe('proxy HTTP listener — GetCapabilities XAddr rewrite', () => {
  /** @type {any} */
  let booted;

  afterEach(async () => {
    await teardownProxy(booted);
  });

  /** @param {{ status: number, body: string }} capsResponse */
  async function bootWithCaps(capsResponse) {
    booted = await bootProxy({
      upstream: {
        respondWith: /** @type {(req: any) => { status: number, body: string }} */ (req) => {
          if (req.body.includes('GetCapabilities')) {
            return capsResponse;
          }
          return { status: 200, body: '<ok/>' };
        },
      },
    });
  }

  it('re-points every XAddr at the proxy origin (inbound Host), preserving paths', async () => {
    await bootWithCaps({ status: 200, body: CAPS_BODY });
    const response = await booted.postToProxy(GET_CAPABILITIES, '/onvif/device_service');

    const expected = `http://127.0.0.1:${booted.proxyPort}/onvif/service`;
    assert.equal(response.status, 200);
    const addrs = [...response.body.matchAll(/<tt:XAddr>([^<]*)<\/tt:XAddr>/g)].map((m) => m[1]);
    assert.deepEqual(addrs, [expected, expected]);
    assert.ok(!response.body.includes('192.0.2.12'), 'camera address must not survive');
  });

  it('logs the rewrite (PTZ-relevant events, once per rewrite)', async () => {
    await bootWithCaps({ status: 200, body: CAPS_BODY });
    await booted.postToProxy(GET_CAPABILITIES);
    await booted.postToProxy(GET_CAPABILITIES);

    const rewriteLogs = booted.logs.filter((/** @type {string} */ l) => l.includes('rewrote GetCapabilities XAddrs'));
    assert.equal(rewriteLogs.length, 2);
  });

  it('forwards the GetCapabilities request itself verbatim', async () => {
    await bootWithCaps({ status: 200, body: CAPS_BODY });
    await booted.postToProxy(GET_CAPABILITIES, '/onvif/device_service');

    const sent = booted.upstream.requests()[0];
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, '/onvif/device_service');
    assert.ok(sent.body.includes('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>'));
  });

  it('does not rewrite an error status (ADR-0005 pass-through)', async () => {
    await bootWithCaps({ status: 503, body: '<html>service unavailable</html>' });
    const response = await booted.postToProxy(GET_CAPABILITIES);

    assert.equal(response.status, 503);
    assert.equal(response.body, '<html>service unavailable</html>');
    assert.ok(
      !booted.logs.some((/** @type {string} */ l) => l.includes('rewrote GetCapabilities XAddrs')),
      'no rewrite should be logged for a failed status'
    );
  });

  it('does not rewrite a SOAP fault, whatever status it arrives with', async () => {
    const fault =
      '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
      '<soap:Body><soap:Fault><soap:Code><soap:Value>soap:Receiver</soap:Value></soap:Code>' +
      '<soap:Reason><soap:Text>down</soap:Text></soap:Reason></soap:Fault></soap:Body></soap:Envelope>';
    await bootWithCaps({ status: 200, body: fault });
    const response = await booted.postToProxy(GET_CAPABILITIES);

    assert.equal(response.status, 200);
    assert.equal(response.body, fault);
  });

  it('leaves XAddr-like content in other responses untouched', async () => {
    booted = await bootProxy({
      upstream: {
        respondWith: /** @type {(req: any) => { status: number, body: string }} */ (req) => {
          if (req.body.includes('GetServiceCapabilities')) {
            return {
              status: 200,
              body:
                '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">' +
                '<soap:Body><tptz:GetServiceCapabilitiesResponse><tptz:Capabilities><tt:XAddr>http://192.0.2.12:80/onvif/service</tt:XAddr></tptz:Capabilities></tptz:GetServiceCapabilitiesResponse></soap:Body></soap:Envelope>',
            };
          }
          return { status: 200, body: '<ok/>' };
        },
      },
    });
    const inbound =
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">' +
      '<soap:Body><tptz:GetServiceCapabilities/></soap:Body></soap:Envelope>';
    const response = await booted.postToProxy(inbound);

    assert.ok(response.body.includes('http://192.0.2.12:80/onvif/service'), 'only GetCapabilities is rewritten');
  });
});
