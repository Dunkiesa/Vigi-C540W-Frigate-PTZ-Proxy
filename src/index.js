'use strict';

const { loadConfig, startupLogView } = require('./config');
const { createServer } = require('./server');

/**
 * Process entry point. Loads the per-instance binding from environment
 * variables, builds the proxy's HTTP listener, and binds it. The listener
 * accepts SOAP POSTs from Frigate and forwards them to the upstream camera
 * inside a fresh envelope carrying Frigate's own WS-UsernameToken
 * (ADR-0008), returning the upstream response verbatim.
 *
 * The env and log sink are injectable so the startup binding line
 * (logging policy) is verifiable without mutating `process.env` or stdout.
 * The default wiring prints the startup view through `startupLogView`;
 * since ADR-0008 the binding holds no credentials to redact.
 *
 * In production this runs as a Docker container with a per-
 * instance `.env` file (ADR-0006).
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (line: string) => void }} [opts]
 * @returns {import('node:http').Server} the bound listener (for tests / shutdown)
 */
function main({ env = process.env, log } = {}) {
  let config;
  try {
    config = loadConfig({ env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[startup] invalid configuration: ${message}`);
    process.exit(1);
  }

  const write = log ?? ((/** @type {string} */ line) => console.log(`[proxy] ${line}`));
  const safe = startupLogView(config);
  write(`starting — ${JSON.stringify(safe)}`);

  const server = createServer({ config, log: write });
  server.listen(config.listenPort, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.listenPort;
    write(`listening on ${port}`);
  });
  return server;
}

if (require.main === module) {
  main();
}

module.exports = { main };