'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { postSoap } = require('../../src/upstream');
const { StubServer } = require('../helpers/stub-server');

describe('upstream.postSoap', () => {
  /** @type {any} */
  let stub;

  afterEach(async () => {
    if (stub) await stub.stop();
    stub = undefined;
  });

  it('POSTs the envelope to the upstream host:port/path with SOAP Content-Type', async () => {
    stub = await StubServer.start({ status: 200, body: '<ok/>' });

    await postSoap({
      host: '127.0.0.1',
      port: stub.port(),
      path: '/onvif/service',
      envelope: '<envelope/>',
    });

    const reqs = stub.requests();
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].method, 'POST');
    assert.equal(reqs[0].path, '/onvif/service');
    assert.equal(reqs[0].body, '<envelope/>');
    assert.match(reqs[0].headers['content-type'], /application\/soap\+xml/);
  });

  it('returns the upstream status code and body verbatim', async () => {
    stub = await StubServer.start({
      status: 401,
      body: '<soap:Fault><Code>sender</Code></soap:Fault>',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    });

    const res = await postSoap({
      host: '127.0.0.1',
      port: stub.port(),
      path: '/onvif/service',
      envelope: '<envelope/>',
    });

    assert.equal(res.status, 401);
    assert.equal(res.body, '<soap:Fault><Code>sender</Code></soap:Fault>');
  });

  it('rejects when the upstream connection is refused', async () => {
    await assert.rejects(
      () =>
        postSoap({
          host: '127.0.0.1',
          port: 1, // closed port
          path: '/onvif/service',
          envelope: '<envelope/>',
          timeoutMs: 500,
        }),
      /ECONNREFUSED|timeout/i
    );
  });

  it('rejects when the upstream accepts the connection but never responds', async () => {
    stub = await StubServer.start({ hang: true });

    await assert.rejects(
      () =>
        postSoap({
          host: '127.0.0.1',
          port: stub.port(),
          path: '/onvif/service',
          envelope: '<envelope/>',
          timeoutMs: 250,
        }),
      /timed out/i
    );
  });
});