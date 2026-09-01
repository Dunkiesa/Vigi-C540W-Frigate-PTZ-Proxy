'use strict';

/**
 * Read the proxy's per-instance binding from environment variables.
 *
 * The proxy holds per-camera state in static config; the loader's job is to
 * validate presence and shape, and to surface the parsed binding to the rest
 * of the process. Since ADR-0008 the proxy holds NO camera credentials:
 * upstream authentication arrives with each client request (the relayed
 * <wsse:Security> header), so there is no secret in the binding and nothing
 * here needs redacting before logging.
 *
 * ADR-0006 (superseded on credentials, kept on the rest) and ADR-0007:
 * every deployment binding — LISTEN_PORT, UPSTREAM_HOST,
 * UPSTREAM_PORT — is required from env with no hardcoded fallbacks, so a
 * misconfigured per-camera `.env` can never silently point one instance at
 * the wrong camera.
 *
 * @typedef {object} ProxyConfig
 * @property {number}  listenPort         Port the proxy binds inside its container.
 * @property {string}  upstreamHost       Upstream ONVIF camera host (LAN IP).
 * @property {number}  upstreamPort       Upstream ONVIF camera port (deployment-specific, see `.env.example`).
 * @property {number}  hfovDeg            Camera horizontal field of view in degrees.
 * @property {number}  vfovDeg            Camera vertical field of view in degrees.
 * @property {number}  panMechDeg         Mechanical pan range in degrees.
 * @property {number}  tiltMechDeg        Mechanical tilt range in degrees.
 * @property {LogLevel} logLevel          Verbosity setting from LOG_LEVEL (default 'info'), recorded at startup.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {ProxyConfig}
 */
function loadConfig({ env = process.env } = {}) {
  const listenPort = parseRequiredPort(env.LISTEN_PORT, 'LISTEN_PORT');
  const upstreamHost = requireString(env.UPSTREAM_HOST, 'UPSTREAM_HOST');
  const upstreamPort = parseRequiredPort(env.UPSTREAM_PORT, 'UPSTREAM_PORT');
  const logLevel = parseLogLevel(env.LOG_LEVEL);

  // Camera binding for FOV-to-generic translation. ADR-0003: spec-sheet
  // values are the starting point; per-unit overrides arrive as optional
  // env vars written by the user after manual measurement.
  const binding = loadCameraBinding(env);

  return {
    listenPort,
    upstreamHost,
    upstreamPort,
    logLevel,
    ...binding,
  };
}

/**
 * The locked spec-sheet camera binding: HFOV 80°, VFOV 43.2°, pan-mech 350°,
 * tilt-mech 120° (TP-Link Vigi C540-W v2, 4 mm lens — ADR-0003). Per-unit
 * drift is expected; the HFOV_DEG / VFOV_DEG / PAN_MECH_DEG / TILT_MECH_DEG
 * env vars override individual fields for a given instance.
 */
const SPEC_SHEET_BINDING = Object.freeze({
  hfovDeg: 80,
  vfovDeg: 43.2,
  panMechDeg: 350,
  tiltMechDeg: 120,
});

/**
 * Assemble the camera binding: spec-sheet defaults with per-unit overrides
 * from the environment (ADR-0003). Absent or empty override vars fall back
 * to the spec sheet; malformed values fail loudly at startup.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Pick<ProxyConfig, 'hfovDeg' | 'vfovDeg' | 'panMechDeg' | 'tiltMechDeg'>}
 */
function loadCameraBinding(env) {
  return {
    hfovDeg: parseDegOverride(env.HFOV_DEG, 'HFOV_DEG', SPEC_SHEET_BINDING.hfovDeg),
    vfovDeg: parseDegOverride(env.VFOV_DEG, 'VFOV_DEG', SPEC_SHEET_BINDING.vfovDeg),
    panMechDeg: parseDegOverride(env.PAN_MECH_DEG, 'PAN_MECH_DEG', SPEC_SHEET_BINDING.panMechDeg),
    tiltMechDeg: parseDegOverride(env.TILT_MECH_DEG, 'TILT_MECH_DEG', SPEC_SHEET_BINDING.tiltMechDeg),
  };
}

/**
 * A camera-binding field in degrees: positive finite number, may be
 * fractional (e.g. VFOV 43.2). Empty means "not overridden".
 *
 * @param {string | undefined} raw
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function parseDegOverride(raw, name, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive number of degrees (got: ${raw})`);
  }
  return n;
}

class ConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel
 */

/**
 * Verbosity levels accepted by `LOG_LEVEL`. This slice records the loaded
 * level at startup; wiring the proxy's own logger to gate on it is follow-up.
 *
 * @type {ReadonlyArray<LogLevel>}
 */
const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/**
 * @param {string | undefined} raw
 * @returns {LogLevel}
 */
function parseLogLevel(raw) {
  if (raw === undefined || raw === '') return 'info';
  const normalized = raw.toLowerCase();
  if (!LOG_LEVELS.includes(/** @type {LogLevel} */ (normalized))) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got: ${raw})`);
  }
  return /** @type {LogLevel} */ (normalized);
}

/**
 * Parse a port that must come from the per-instance env. No
 * fallback: absent, empty, or malformed values fail loudly at startup.
 *
 * @param {string | undefined} raw
 * @param {string} name
 * @returns {number}
 */
function parseRequiredPort(raw, name) {
  if (raw === undefined || raw === '') {
    throw new ConfigError(`${name} is required but was not set`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new ConfigError(`${name} must be an integer in 1..65535 (got: ${raw})`);
  }
  return n;
}

/**
 * A string that must come from the per-instance env. No
 * fallback: absent or empty values fail loudly at startup.
 *
 * @param {string | undefined} raw
 * @param {string} name
 * @returns {string}
 */
function requireString(raw, name) {
  if (raw === undefined || raw === '') {
    throw new ConfigError(`${name} is required but was not set`);
  }
  return raw;
}

/**
 * The startup log view of the binding. Since ADR-0008 the binding holds no
 * secrets — the camera credentials belong to Frigate's request, not the
  * proxy — so this is a plain field list, kept as the explicit "what the
  * process loaded" startup line.
 *
 * @param {ProxyConfig} cfg
 * @returns {ProxyConfig}
 */
function startupLogView(cfg) {
  return {
    listenPort: cfg.listenPort,
    upstreamHost: cfg.upstreamHost,
    upstreamPort: cfg.upstreamPort,
    logLevel: cfg.logLevel,
    hfovDeg: cfg.hfovDeg,
    vfovDeg: cfg.vfovDeg,
    panMechDeg: cfg.panMechDeg,
    tiltMechDeg: cfg.tiltMechDeg,
  };
}

module.exports = { loadConfig, startupLogView, ConfigError };