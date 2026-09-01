'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, startupLogView } = require('../../src/config');

/**
 * @param {Record<string, string>} values
 * @returns {NodeJS.ProcessEnv}
 */
function envFrom(values) {
  return { ...values };
}

/**
 * The full per-instance binding a real container receives from its
 * `env_file:` (ADR-0006, credential-free since ADR-0008).
 * Required-from-env means every test that boots a valid config must
 * supply all of it.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {NodeJS.ProcessEnv}
 */
function baseEnv(overrides = {}) {
  return envFrom({
    LISTEN_PORT: '8080',
    UPSTREAM_HOST: '192.0.2.12',
    UPSTREAM_PORT: '80',
    ...overrides,
  });
}

describe('config.loadConfig', () => {
  it('reads explicit env values', () => {
    const cfg = loadConfig({
      env: envFrom({
        LISTEN_PORT: '9001',
        UPSTREAM_HOST: '192.0.2.99',
        UPSTREAM_PORT: '8080',
      }),
    });

    assert.equal(cfg.listenPort, 9001);
    assert.equal(cfg.upstreamHost, '192.0.2.99');
    assert.equal(cfg.upstreamPort, 8080);
  });

  it('requires every deployment binding from env — no hardcoded fallbacks', () => {
    for (const missing of ['LISTEN_PORT', 'UPSTREAM_HOST', 'UPSTREAM_PORT']) {
      const env = { ...baseEnv() };
      delete env[missing];
      assert.throws(() => loadConfig({ env }), new RegExp(missing), `${missing} must be required`);
    }
  });

  it('holds no credentials — leftover UPSTREAM_USER/PASSWORD env are ignored (ADR-0008)', () => {
    const cfg = loadConfig({ env: baseEnv({ UPSTREAM_USER: 'user', UPSTREAM_PASSWORD: 'unused-pass' }) });
    assert.equal('upstreamUser' in cfg, false);
    assert.equal('upstreamPassword' in cfg, false);
    assert.equal(JSON.stringify(cfg).includes('unused-pass'), false);
  });

  it('throws on a non-numeric listen port', () => {
    assert.throws(
      () => loadConfig({ env: baseEnv({ LISTEN_PORT: 'not-a-port' }) }),
      /LISTEN_PORT/
    );
  });

  it('throws on a non-numeric upstream port', () => {
    assert.throws(
      () => loadConfig({ env: baseEnv({ UPSTREAM_PORT: 'oops' }) }),
      /UPSTREAM_PORT/
    );
  });

  it('throws when a required string var is present but empty', () => {
    assert.throws(() => loadConfig({ env: baseEnv({ UPSTREAM_HOST: '' }) }), /UPSTREAM_HOST/);
  });
});

describe('config.loadConfig — camera binding', () => {
  it('loads the locked spec-sheet binding values when no overrides are set (ADR-0003)', () => {
    const cfg = loadConfig({ env: baseEnv() });

    assert.equal(cfg.hfovDeg, 80);
    assert.equal(cfg.vfovDeg, 43.2);
    assert.equal(cfg.panMechDeg, 350);
    assert.equal(cfg.tiltMechDeg, 120);
  });

  it('applies per-unit overrides on top of the spec-sheet defaults (ADR-0003)', () => {
    const cfg = loadConfig({
      env: baseEnv({ HFOV_DEG: '78.5', VFOV_DEG: '42', PAN_MECH_DEG: '348', TILT_MECH_DEG: '115' }),
    });

    assert.equal(cfg.hfovDeg, 78.5);
    assert.equal(cfg.vfovDeg, 42);
    assert.equal(cfg.panMechDeg, 348);
    assert.equal(cfg.tiltMechDeg, 115);
  });

  it('lets a single override stand while the others keep spec-sheet defaults', () => {
    const cfg = loadConfig({ env: baseEnv({ HFOV_DEG: '81.2' }) });

    assert.equal(cfg.hfovDeg, 81.2);
    assert.equal(cfg.vfovDeg, 43.2);
    assert.equal(cfg.panMechDeg, 350);
    assert.equal(cfg.tiltMechDeg, 120);
  });

  it('throws on a non-numeric or non-positive override', () => {
    assert.throws(() => loadConfig({ env: baseEnv({ HFOV_DEG: 'wide' }) }), /HFOV_DEG/);
    assert.throws(() => loadConfig({ env: baseEnv({ PAN_MECH_DEG: '0' }) }), /PAN_MECH_DEG/);
    assert.throws(() => loadConfig({ env: baseEnv({ TILT_MECH_DEG: '-30' }) }), /TILT_MECH_DEG/);
  });

  it('treats an override present but empty as unset (spec-sheet default applies)', () => {
    const cfg = loadConfig({ env: baseEnv({ VFOV_DEG: '' }) });
    assert.equal(cfg.vfovDeg, 43.2);
  });
});

describe('config.loadConfig — log level', () => {
  it('defaults the log level to info when LOG_LEVEL is absent', () => {
    const cfg = loadConfig({ env: baseEnv() });
    assert.equal(cfg.logLevel, 'info');
  });

  it('accepts each level of the enum, case-insensitively', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      const cfg = loadConfig({ env: baseEnv({ LOG_LEVEL: level }) });
      assert.equal(cfg.logLevel, level);
      const upper = loadConfig({ env: baseEnv({ LOG_LEVEL: level.toUpperCase() }) });
      assert.equal(upper.logLevel, level);
    }
  });

  it('throws on a log level outside the enum', () => {
    assert.throws(
      () => loadConfig({ env: baseEnv({ LOG_LEVEL: 'trace' }) }),
      /LOG_LEVEL/
    );
  });
});

describe('config.startupLogView', () => {
  it('carries no secret material — the binding holds none since ADR-0008', () => {
    const cfg = loadConfig({ env: baseEnv({ UPSTREAM_PASSWORD: 'unused-pass' }) });
    const json = JSON.stringify(startupLogView(cfg));
    assert.equal(json.includes('unused-pass'), false);
    assert.equal(json.includes('upstreamPassword'), false);
  });

  it('includes the camera binding values so startup logs show what was loaded', () => {
    const cfg = loadConfig({ env: baseEnv() });
    const safe = startupLogView(cfg);
    assert.equal(safe.hfovDeg, 80);
    assert.equal(safe.vfovDeg, 43.2);
    assert.equal(safe.panMechDeg, 350);
    assert.equal(safe.tiltMechDeg, 120);
  });

  it('includes the log level so the startup binding line records it', () => {
    const cfg = loadConfig({ env: baseEnv({ LOG_LEVEL: 'warn' }) });
    const safe = startupLogView(cfg);
    assert.equal(safe.logLevel, 'warn');
    assert.equal(JSON.stringify(safe).includes('unused-pass'), false);
  });
});
