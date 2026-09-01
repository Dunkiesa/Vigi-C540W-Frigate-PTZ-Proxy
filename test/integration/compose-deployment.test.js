'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { StubServer } = require('../helpers/stub-server');
const { envelope, clientSecurity } = require('../helpers/soap-fixtures');
const { findEphemeralPort } = require('../helpers/boot-proxy');
const { httpGet } = require('../helpers/http-get');

/**
 * End-to-end deployment smoketest (ADR-0006 / ADR-0007).
 *
 * Seam: the shipped Dockerfile (built out-of-band via `docker build`, never
 * by Compose) + docker-compose.yml, driven through the real `docker compose`
 * CLI against stub upstreams. Verifies the checklist:
 *   - the Dockerfile build produces a runnable image serving the HTTP
 *     listener, under the exact tag the compose file references;
 *   - two instances of that image, with different `.env` files, run
 *     side-by-side on unique host ports without collision;
 *   - each proxy forwards a raw SOAP GetCapabilities through to its own
 *     respective upstream;
 *   - a client on the shared network reaches a proxy by container name on
 *     the in-container port, bypassing the published host port;
 *   - the container's effective config is env-only: the image with no
 *     binding env exits non-zero instead of falling back to defaults.
 *
 * Skips cleanly when Docker or its daemon is absent (e.g. a dev box without
 * it installed); run it on the deployment host or CI to exercise the
 * checklist above.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');
const IMAGE_TAG = 'onvif-ptz-proxy:latest';

/**
 * Docker is only worth driving when both the client and a reachable daemon
 * exist. `docker info` fails (non-zero) when the daemon is down, which is
 * distinct from `docker` being missing (ENOENT) — both mean "skip".
 */
const DOCKER_CHECK = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 30000 });
const HAVE_DOCKER = !DOCKER_CHECK.error && DOCKER_CHECK.status === 0;

/** @param {string} marker @returns {string} */
function capabilitiesResponse(marker) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl">' +
    '<soap:Body><tds:GetCapabilitiesResponse><tds:Capabilities>' +
    `<tds:Device><tds:XAddr>http://${marker}/onvif/service</tds:XAddr></tds:Device>` +
    '</tds:Capabilities></tds:GetCapabilitiesResponse></soap:Body></soap:Envelope>'
  );
}

// The client (Frigate) supplies credentials per-request (ADR-0008): the
// fixture carries a WS-UsernameToken that the proxy must relay verbatim.
const SMOKE_SECURITY = clientSecurity('smoke-user');
const GET_CAPABILITIES = envelope('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', SMOKE_SECURITY);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: opts.env || process.env,
    timeout: opts.timeoutMs === undefined ? 120000 : opts.timeoutMs,
  });
  if (result.error) throw result.error;
  return { status: result.status === null ? -1 : result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * POST a SOAP envelope and capture the reply.
 *
 * @param {number} port
 * @param {string} body
 * @param {string} [host]
 * @returns {Promise<{ status: number, body: string }>}
 */
function postSoap(port, body, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: '/onvif/service',
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe(
  'compose deployment smoke',
  { skip: HAVE_DOCKER ? false : 'docker not available — run this file on a Docker host' },
  () => {
    const project = `ptz-smoke-${process.pid}`;
    const network = project;
    /** @type {string[]} */ let composeEnvFiles = [];
    /** @type {string} */ let tmpDir = '';
    /** @type {NodeJS.ProcessEnv} */ let composeEnv = { ...process.env };
    /** @type {any} */ let stubCAM1;
    /** @type {any} */ let stubCAM2;
    /** @type {number} */ let hostPort11 = 0;
    /** @type {number} */ let hostPort12 = 0;
    let composeStarted = false;

    /**
     * One service's per-instance env file, pointing its upstream leg at a
     * host-run stub via host.docker.internal (provided by the compose file's
     * extra_hosts mapping — the same route a LAN camera IP takes through the
     * host's LAN interface).
     *
     * @param {string} name
     * @param {number} upstreamPort
     * @param {Record<string, string>} overrides
     * @returns {string} absolute path
     */
    function writeEnvFile(name, upstreamPort, overrides) {
      // No credential vars: the client supplies them per-request and the
      // proxy relays them (ADR-0008).
      const lines = [
        'UPSTREAM_HOST=host.docker.internal',
        `UPSTREAM_PORT=${upstreamPort}`,
        'LISTEN_PORT=8080',
        'LOG_LEVEL=debug',
        ...Object.entries(overrides).map(([k, v]) => `${k}=${v}`),
      ];
      const file = path.join(tmpDir, `${name}.env`);
      fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
      return file;
    }

    /**
     * @param {string[]} extraComposeArgs
     * @param {number} [timeoutMs]
     */
    function compose(extraComposeArgs, timeoutMs) {
      return run(
        'docker',
        ['compose', '-p', project, '-f', 'docker-compose.yml', ...extraComposeArgs],
        { env: composeEnv, timeoutMs }
      );
    }

    before(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-compose-smoke-'));
      composeEnvFiles = [];

      // Docker Desktop reaches host loopback through host.docker.internal;
      // on Linux the connection arrives at a routable interface, so bind all.
      stubCAM1 = await StubServer.start({ host: '0.0.0.0', status: 200, body: capabilitiesResponse('cam-1-stub') });
      stubCAM2 = await StubServer.start({ host: '0.0.0.0', status: 200, body: capabilitiesResponse('cam-2-stub') });
      hostPort11 = await findEphemeralPort();
      hostPort12 = await findEphemeralPort();

      const env11 = writeEnvFile('cam-1', stubCAM1.port(), { HFOV_DEG: '79.1' });
      const env12 = writeEnvFile('cam-2', stubCAM2.port(), { HFOV_DEG: '81.9' });
      composeEnvFiles = [env11, env12];

      composeEnv = {
        ...process.env,
        PROXY_NETWORK: network,
        CAM1_ENV_FILE: env11,
        CAM2_ENV_FILE: env12,
        CAM1_HOST_PORT: String(hostPort11),
        CAM2_HOST_PORT: String(hostPort12),
      };

      const net = run('docker', ['network', 'create', network], { timeoutMs: 30000 });
      assert.equal(net.status, 0, `docker network create failed: ${net.stderr}`);

      const build = run('docker', ['build', '-t', IMAGE_TAG, '.'], { timeoutMs: 600000 });
      assert.equal(build.status, 0, `docker build failed:\n${build.stdout}\n${build.stderr}`);

      // `down` from here on, even if `up` is killed by its own timeout
      // mid-start — otherwise half-created services with
      // `restart: unless-stopped` survive the run and block the network rm.
      composeStarted = true;
      const up = compose(['up', '-d'], 600000);
      assert.equal(up.status, 0, `docker compose up failed:\n${up.stdout}\n${up.stderr}`);

      // Wait until both published ports answer with the respective stub's
      // capabilities (container start + listener bind). A persistent non-200
      // (e.g. the proxy's 502 when host.docker.internal does not resolve)
      // surfaces in the thrown message rather than "never became ready".
      for (const port of [hostPort11, hostPort12]) {
        const deadline = Date.now() + 60000;
        let lastError = 'no attempt made';
        for (;;) {
          try {
            const res = await postSoap(port, GET_CAPABILITIES);
            if (res.status === 200) break;
            lastError = `status=${res.status} body=${res.body.slice(0, 200)}`;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
          if (Date.now() > deadline) {
            throw new Error(`proxy on host port ${port} never became ready; last attempt: ${lastError}`);
          }
          await sleep(1000);
        }
      }
    });

    after(() => {
      try {
        if (composeStarted) compose(['down', '-v', '--remove-orphans'], 120000);
      } finally {
        run('docker', ['network', 'rm', network], { timeoutMs: 30000 });
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      return Promise.all([stubCAM1 && stubCAM1.stop(), stubCAM2 && stubCAM2.stop()]);
    });

    it('two instances of the same image run side-by-side on unique host ports', () => {
      const ps = compose(['ps', '--format', '{{.Name}} {{.State}}']);
      assert.equal(ps.status, 0, ps.stderr);
      assert.match(ps.stdout, /proxy-cam-1\s+running/);
      assert.match(ps.stdout, /proxy-cam-2\s+running/);
      assert.notEqual(hostPort11, hostPort12, 'sanity: the two host ports differ');
    });

    it('both services pass the compose healthcheck (in-image wget -> GET /health)', async () => {
      /** @type {Array<[string, number]>} */
      const services = [
        ['proxy-cam-1', hostPort11],
        ['proxy-cam-2', hostPort12],
      ];
      for (const [service, hostPort] of services) {
        // The real mechanism Frigate's depends_on waits on: Docker running
        // the compose healthcheck inside the container, proving the image
        // ships a working wget and the listener answers /health.
        const deadline = Date.now() + 60000;
        let last = 'no attempt made';
        for (;;) {
          const res = run('docker', ['inspect', '--format', '{{.State.Health.Status}}', service], {
            timeoutMs: 30000,
          });
          last = `status=${res.status} out=${res.stdout.trim()} err=${res.stderr.trim()}`;
          if (res.status === 0 && res.stdout.trim() === 'healthy') break;
          if (Date.now() > deadline) {
            throw new Error(`${service} never became healthy; last inspect: ${last}`);
          }
          await sleep(1000);
        }
        // And the same endpoint is reachable through the published port.
        const health = await httpGet(hostPort, '/health');
        assert.equal(health.status, 200);
        assert.equal(health.body, 'ok');
      }
    });

    it('each proxy forwards a raw GetCapabilities to its respective upstream', async () => {
      const res11 = await postSoap(hostPort11, GET_CAPABILITIES);
      assert.equal(res11.status, 200);
      assert.ok(res11.body.includes('http://cam-1-stub/'), 'cam-1 host port must answer with cam-1 upstream');

      const res12 = await postSoap(hostPort12, GET_CAPABILITIES);
      assert.equal(res12.status, 200);
      assert.ok(res12.body.includes('http://cam-2-stub/'), 'cam-2 host port must answer with cam-2 upstream');

      // Raw pass-through: every request either stub received was its own
      // GetCapabilities — inner body verbatim, plus the client's
      // WS-UsernameToken relayed verbatim (ADR-0008). (The readiness poll
      // and this test each send one, hence "every" rather than an exact count.)
      const seen = stubCAM1.requests();
      assert.ok(seen.length >= 1);
      for (const req of seen) {
        assert.ok(
          req.body.includes('<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>'),
          'cam-1 stub must not see traffic meant for cam-2'
        );
        assert.ok(
          req.body.includes(SMOKE_SECURITY),
          'forwarded envelope must carry the client Security header verbatim'
        );
      }
    });

    it('a client on the shared network reaches either proxy by container name, not through the host port', () => {
      for (const [service, marker] of [
        ['proxy-cam-1', 'http://cam-1-stub/'],
        ['proxy-cam-2', 'http://cam-2-stub/'],
      ]) {
        // Run the proxy image itself as a one-shot SOAP client against
        // http://<service>:8080/ — container-name addressing on the network.
        const client =
          "const http=require('http');" +
          "const body=" + JSON.stringify(GET_CAPABILITIES) + ";" +
          `const req=http.request({host:'${service}',port:8080,path:'/onvif/service',method:'POST',` +
          "headers:{'content-type':'application/soap+xml; charset=utf-8','content-length':Buffer.byteLength(body)}," +
          "res=>{let t='';res.setEncoding('utf8');res.on('data',c=>t+=c);res.on('end'," +
          `()=>{process.stdout.write(t.includes(${JSON.stringify(marker)})?'NAME_OK\\n':'NAME_BAD '+res.statusCode+'\\n');process.exit(0)})});` +
          "req.on('error',e=>{console.error('CLIENTERR '+e.message);process.exit(2)});req.end(body);";
        const res = run('docker', ['run', '--rm', '--network', network, '--entrypoint', 'node', IMAGE_TAG, '-e', client], {
          env: composeEnv,
          timeoutMs: 60000,
        });
        assert.equal(res.status, 0, `${service}: client container failed: ${res.stderr}`);
        assert.ok(res.stdout.includes('NAME_OK'), `${service}: expected container-name OK, got: ${res.stdout}${res.stderr}`);
      }
    });

    it('the image with no binding env exits non-zero — env vars are the only config source', () => {
      const res = run('docker', ['run', '--rm', IMAGE_TAG], { timeoutMs: 60000 });
      assert.equal(res.status, 1, `expected exit 1; stderr: ${res.stderr}`);
      assert.match(res.stderr, /invalid configuration/);
      assert.match(res.stderr, /is required/);
    });
  }
);
