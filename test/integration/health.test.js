'use strict';

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { bootProxy, teardownProxy, findClosedPort } = require('../helpers/boot-proxy');
const { httpGet } = require('../helpers/http-get');
const { envelope } = require('../helpers/soap-fixtures');

const UPSTREAM_RESPONSE =
  '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><tds:GetCapabilitiesResponse/></soap:Body></soap:Envelope>';

describe('proxy health endpoint — GET /health', () => {
  /** @type {any} */
  let booted;

  beforeEach(async () => {
    booted = await bootProxy({ upstream: { status: 200, body: UPSTREAM_RESPONSE } });
  });

  afterEach(async () => {
    await teardownProxy(booted);
  });

  it('answers GET /health locally with 200 without touching upstream or the log', async () => {
    const response = await httpGet(booted.proxyPort, '/health');

    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok');
    assert.match(response.headers['content-type'] ?? '', /^text\/plain/);
    assert.deepEqual(booted.upstream.requests(), [], 'health check must never be forwarded upstream');
    assert.deepEqual(booted.logs, [], 'routine health checks must not pollute the proxy log');
  });

  it('ignores a query string on /health (cache-busting health probes)', async () => {
    const response = await httpGet(booted.proxyPort, '/health?t=1750000000');
    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok');
  });

  it('does not intercept other GET paths — they still hit SOAP parsing', async () => {
    const response = await httpGet(booted.proxyPort, '/onvif/service');
    assert.equal(response.status, 400, 'a bodyless GET must not be answered as health');
  });

  it('does not intercept a POST whose path is /health — only GET /health is special', async () => {
    const inbound = envelope('<tptz:GetServiceCapabilities/>');
    const response = await booted.postToProxy(inbound, '/health');

    assert.equal(response.status, 200);
    const captured = booted.upstream.requests();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, '/health');
  });

  it('leaves normal SOAP forwarding untouched around health checks', async () => {
    await httpGet(booted.proxyPort, '/health');
    const inbound = envelope('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    const response = await booted.postToProxy(inbound);
    await httpGet(booted.proxyPort, '/health');

    assert.equal(response.status, 200);
    assert.equal(response.body, UPSTREAM_RESPONSE);
    assert.equal(booted.upstream.requests().length, 1);
  });
});

describe('proxy health endpoint — upstream down', () => {
  /** @type {any} */
  let booted;

  beforeEach(async () => {
    booted = await bootProxy({ upstreamPort: await findClosedPort() });
  });

  afterEach(async () => {
    await teardownProxy(booted);
  });

  it('stays healthy while the camera is unreachable — the check gates on the listener, not the upstream', async () => {
    const soap = await booted.postToProxy(envelope('<tptz:GetServiceCapabilities/>'));
    assert.equal(soap.status, 502, 'sanity: forwarding fails while the camera is down');

    const health = await httpGet(booted.proxyPort, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body, 'ok');
  });
});
