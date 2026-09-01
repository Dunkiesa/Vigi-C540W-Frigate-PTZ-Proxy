'use strict';

const http = require('node:http');
const net = require('node:net');

const { StubServer } = require('./stub-server');
const { loadConfig } = require('../../src/config');
const { createServer } = require('../../src/server');
const { postSoap } = require('../../src/upstream');
const { rewriteXAddrs } = require('../../src/response-injection');

/**
 * Boot a proxy HTTP listener pointed at a stub upstream. Returns the
 * listeners and a `postToProxy` helper that sends a SOAP envelope to the
 * proxy and captures the response.
 *
 * `upstream` is an opts object compatible with {@link StubServer.start}.
 * Pass `upstreamPort` instead of (or in addition to) `upstream` to point the
 * proxy at a fixed port with no stub behind it — use {@link findClosedPort}
 * to simulate a camera that refuses connections (ADR-0005's 502 branch).
 *
 * @typedef {object} BootedProxy
 * @property {any} proxy
 * @property {number} proxyPort
 * @property {any} upstream
 * @property {string[]} logs Every line the proxy logged while booted.
 * @property {(body: string, path?: string) => Promise<{ status: number, body: string, headers: object }>} postToProxy
 *
 * @param {{
 *   upstream?: object,
 *   upstreamPort?: number,
 *   postSoapFn?: typeof postSoap,
 *   rewriteXAddrsFn?: typeof rewriteXAddrs,
 * }} [opts]
 * @returns {Promise<BootedProxy>}
 */
async function bootProxy(opts = {}) {
  /** @type {any} */
  let upstream;
  /** @type {number} */
  let upstreamPort;
  if (opts.upstreamPort !== undefined) {
    upstreamPort = opts.upstreamPort;
    // No stub behind it — the proxy's upstream leg will fail at the network level.
    upstream = {
      port: () => upstreamPort,
      requests: () => [],
      stop: async () => {},
    };
  } else {
    upstream = /** @type {any} */ (await StubServer.start(opts.upstream || { status: 200, body: '<ok/>' }));
    upstreamPort = upstream.port();
  }
  /** @type {string[]} */
  const logs = [];
  const config = loadConfig({
    env: {
      // Every binding var is required from env. The listener
      // binds an ephemeral port below, so LISTEN_PORT only needs to be
      // present and valid. No credential vars since ADR-0008.
      LISTEN_PORT: '8080',
      UPSTREAM_HOST: '127.0.0.1',
      UPSTREAM_PORT: String(upstreamPort),
    },
  });
  const proxy = createServer({
    config,
    postSoapFn: opts.postSoapFn || postSoap,
    rewriteXAddrsFn: opts.rewriteXAddrsFn || rewriteXAddrs,
    log: (line) => logs.push(line),
  });
  /** @type {(v?: unknown) => void} */
  let resolveListen;
  const listenPromise = new Promise((resolve) => {
    resolveListen = resolve;
  });
  proxy.listen(0, '127.0.0.1', () => resolveListen && resolveListen());
  await listenPromise;
  /** @type {any} */
  const addr = proxy.address();
  const proxyPort = addr.port;

  /** @type {BootedProxy['postToProxy']} */
  const postToProxy = (body, path = '/onvif/service') =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
          },
        },
        (res) => {
          let responseBody = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            responseBody += c;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode || 0, body: responseBody, headers: res.headers })
          );
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

  return { proxy, proxyPort, upstream, logs, postToProxy };
}

/**
 * Bind an ephemeral listener on 127.0.0.1, grab its port, then close it.
 *
 * @returns {Promise<number>}
 */
async function findEphemeralPort() {
  const srv = net.createServer();
  await new Promise((/** @type {(v?: unknown) => void} */ resolve) => srv.listen(0, '127.0.0.1', resolve));
  /** @type {any} */
  const addr = srv.address();
  const port = addr.port;
  await new Promise((/** @type {(v?: unknown) => void} */ resolve) => srv.close(resolve));
  return port;
}

/**
 * Find a TCP port on 127.0.0.1 that is almost certainly closed: an ephemeral
 * port just released by {@link findEphemeralPort}. Pointing the proxy's
 * upstream at this port makes the upstream leg fail with ECONNREFUSED —
 * the "camera offline / network down" case of ADR-0005.
 *
 * @returns {Promise<number>}
 */
async function findClosedPort() {
  return findEphemeralPort();
}

/**
 * Tear down the proxy and the stub upstream created by {@link bootProxy}.
 * Forces keep-alive sockets closed so the test runner exits cleanly.
 *
 * @param {BootedProxy} booted
 */
async function teardownProxy(booted) {
  await new Promise((resolve) => {
    /** @type {(v?: unknown) => void} */
    let r;
    const p = new Promise((resolveP) => {
      r = resolveP;
    });
    booted.proxy.close(() => r && r());
    booted.proxy.closeAllConnections && booted.proxy.closeAllConnections();
    resolve(p);
  });
  await booted.upstream.stop();
}

module.exports = { bootProxy, teardownProxy, findClosedPort, findEphemeralPort };