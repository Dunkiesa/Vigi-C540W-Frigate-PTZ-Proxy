'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { findEphemeralPort } = require('../helpers/boot-proxy');

/**
 * Process-boundarytests ("binding values are read from
 * environment variables at startup with no hardcoded fallbacks").
 *
 * Seam: `node src/index.js` run as a child process. The container's CMD is
 * exactly this invocation, so failing loudly on a broken `env_file:` must be
 * observable through the real process exit code and stderr — not just through
 * loadConfig in-process.
 */

const ENTRY = path.join(__dirname, '..', '..', 'src', 'index.js');

/**
 * Environment a Node child process needs on top of the proxy's own vars.
 * Deliberately NOT inheriting process.env, so the test proves no binding
 * value leaks in from the developer's shell.
 *
 * @param {Record<string, string>} values
 * @returns {NodeJS.ProcessEnv}
 */
function containerEnv(values) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  return { ...env, ...values };
}

/**
 * Run the proxy entry point as a child process. Resolves when the child
 * exits on its own, or (with `until`) as soon as one stdout chunk matches —
 * the caller then gets the still-running handle so it can kill it.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ until?: (line: string) => boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null, child?: import('node:child_process').ChildProcess }>}
 */
function runProxy(env, { until, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (/** @type {number | null} */ code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, child: code === null ? child : undefined });
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`proxy child did not settle in ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (until && until(chunk)) finish(null);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => finish(code));
  });
}

const FULL_BINDING = () => ({
  LISTEN_PORT: '8080',
  UPSTREAM_HOST: '192.0.2.11',
  UPSTREAM_PORT: '80',
});

describe('proxy process startup (— fail loudly, no fallbacks)', () => {
  for (const required of ['LISTEN_PORT', 'UPSTREAM_HOST', 'UPSTREAM_PORT']) {
    it(`exits non-zero naming ${required} when it is missing from the container env`, async () => {
      const env = containerEnv(FULL_BINDING());
      delete env[required];

      const { code, stderr } = await runProxy(env);

      assert.equal(code, 1, `expected exit 1; stderr: ${stderr}`);
      assert.match(stderr, /invalid configuration/);
      assert.ok(
        stderr.includes(`${required} is required`),
        `stderr should name the missing var; got: ${stderr}`
      );
    });
  }

  it('starts with no credential env at all — credentials arrive per-request (ADR-0008)', async () => {
    const port = await findEphemeralPort();
    const env = containerEnv({ ...FULL_BINDING(), LISTEN_PORT: String(port) });

    const started = runProxy(env, { until: (line) => line.includes('listening on') });
    const { child } = await started;
    child && child.kill();
  });

  it('binds and serves when the full env is present — and only reads it from env', async () => {
    const port = await findEphemeralPort();
    const env = containerEnv({ ...FULL_BINDING(), LISTEN_PORT: String(port) });

    const started = runProxy(env, { until: (line) => line.includes('listening on') });
    const { child } = await started;

    try {
      // The listener bound to the env-provided port, not a code default.
      const http = require('node:http');
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, method: 'GET', path: '/' },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(typeof status, 'number', 'the HTTP listener must accept connections');
    } finally {
      child && child.kill();
    }
  });
});
