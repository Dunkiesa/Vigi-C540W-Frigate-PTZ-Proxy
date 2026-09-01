'use strict';

const http = require('node:http');

/**
 * Boot a tiny HTTP server that captures every request and returns a canned
 * response. Tests use this in place of a real upstream camera: it binds to an
 * ephemeral port, records every request in `.requests`, and answers with
 * whatever was configured.
 *
 * @typedef {object} CapturedRequest
 * @property {string} method
 * @property {string} path
 * @property {object} headers
 * @property {string} body
 *
 * @typedef {object} StubServerOptions
 * @property {(req: CapturedRequest) => { status: number, body: string, headers?: object } | undefined} [respondWith]
 * @property {number} [status]
 * @property {string} [body]
 * @property {object} [headers]
 * @property {boolean} [hang] When true, the stub reads each request but never
 *   responds — simulating a camera that accepts connections and then goes
 *   silent (request timeout).
 * @property {string} [host] Bind address (default 127.0.0.1). The compose
 *   smoke test binds 0.0.0.0 so containers can reach the stub through
 *   `host.docker.internal` on Linux, where the connection arrives at a
 *   routable host interface rather than loopback.
 */

class StubServer {
  /**
   * @param {StubServerOptions} [opts]
   * @returns {Promise<StubServer>}
   */
  static async start(opts = {}) {
    // Disable keep-alive so the server doesn't hold idle sockets open between
    // test runs — that hangs server.close() in tests.
    const server = http.createServer({ keepAlive: false }, (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        /** @type {CapturedRequest} */
        const captured = {
          method: req.method || '',
          path: req.url || '',
          headers: req.headers,
          body,
        };
        capturedRequests.push(captured);

        if (opts.hang) return;

        const response = opts.respondWith ? opts.respondWith(captured) : undefined;
        const status = /** @type {number} */ (response ? response.status : opts.status !== undefined ? opts.status : 200);
        const responseBody = /** @type {string} */ (response ? response.body : opts.body !== undefined ? opts.body : '');
        const responseHeaders = /** @type {*} */ (response ? response.headers : opts.headers);
        res.writeHead(
          status,
          responseHeaders || { 'Content-Type': 'application/soap+xml; charset=utf-8' }
        );
        res.end(responseBody);
      });
    });

    /** @type {CapturedRequest[]} */
    const capturedRequests = [];

    await new Promise((/** @type {(v?: unknown) => void} */ resolve) => {
      server.once('error', () => resolve(undefined));
      server.listen(0, opts.host || '127.0.0.1', () => resolve(undefined));
    });

    /** @type {any} */
    const addr = server.address();
    const port = addr.port;

    const instance = /** @type {any} */ (server);
    instance.port = () => port;
    instance.requests = () => capturedRequests;
    instance.stop = () =>
      new Promise((/** @type {(v?: unknown) => void} */ resolve) => {
        // A hanging stub (opts.hang) holds the socket open; force-close so
        // teardown never deadlocks.
        server.closeAllConnections && server.closeAllConnections();
        server.close(() => resolve(undefined));
      });
    return instance;
  }
}

module.exports = { StubServer };