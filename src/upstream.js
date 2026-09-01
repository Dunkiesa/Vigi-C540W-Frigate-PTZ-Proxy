'use strict';

const http = require('node:http');

/**
 * POST a SOAP envelope to an upstream ONVIF endpoint. Used by the proxy to
 * forward Frigate's SOAP requests to the camera. Returns the upstream
 * response (status + body + headers) verbatim — pass-through contract.
 *
 * Network-level failures (connection refused, timeout, DNS error) reject the
 * promise; the caller (the proxy's HTTP listener) translates those into an
 * HTTP 502 response to the client per ADR-0005.
 *
 * @param {{
 *   host: string,
 *   port: number,
 *   path: string,
 *   envelope: string,
 *   timeoutMs?: number
 * }} opts
 * @returns {Promise<{ status: number, body: string, headers: http.IncomingHttpHeaders }>}
 */
function postSoap({ host, port, path, envelope, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(envelope, 'utf8'),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream request timed out')));
    req.write(envelope);
    req.end();
  });
}

module.exports = { postSoap };