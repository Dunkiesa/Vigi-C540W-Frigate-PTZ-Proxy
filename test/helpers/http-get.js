'use strict';

const http = require('node:http');

/**
 * GET a path on a plain TCP port and capture the response. The read-side
 * counterpart to the POST helpers used by the SOAP tests; shared because
 * both the listener tests and the compose smoke test probe GET /health.
 *
 * @param {number} port
 * @param {string} [path]
 * @param {string} [host]
 * @returns {Promise<{ status: number, body: string, headers: http.IncomingHttpHeaders }>}
 */
function httpGet(port, path = '/', host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { httpGet };
