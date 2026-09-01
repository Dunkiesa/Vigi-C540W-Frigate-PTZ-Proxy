'use strict';

/**
 * FOV-to-generic translation (ADR-0002).
 *
 * Pure conversion, no HTTP and no position state:
 *   fov(x, y) → degrees(x·hfov, y·vfov) → generic(x/pan_mech, y/tilt_mech)
 *
 * The output is a relative offset, not an absolute target, so the proxy never
 * needs to know the camera's current generic-space position to translate.
 */

/**
 * The ONVIF URI for the generic translation space — the space the upstream
 * camera advertises and executes. Translated pan/tilt vectors are emitted in
 * this space.
 */
const GENERIC_URI = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace';

/**
 * Substring that identifies a FOV translation-space URI. Mirrors Frigate's
 * own check (`"TranslationSpaceFov" in space["URI"]`), so any URI carrying
 * the substring is treated as FOV space.
 */
const FOV_SPACE_MARKER = 'TranslationSpaceFov';

/**
 * Match a `<PanTilt .../>` (or `<PanTilt ...>`) element with any XML prefix.
 * The proxy only rewrites the pan/tilt vector of a RelativeMove; zoom rides
 * in its own element and is never translated.
 */
const PANTILT_RE = /<(?:[a-zA-Z][\w-]*:)?PanTilt\b[^>]*\/?>/;

/**
 * Match the `<Speed>` element of a RelativeMove (any prefix; paired or
 * self-closing). The opening tag consumes quoted attribute values as units,
 * so a `>` inside an attribute can't fool it into a half-element match and
 * mangle the body. Stripped from translated moves: the target camera ignores
 * the Speed value but takes a slow path whenever the element is present
 * (~2.5x slower, measured 2026-08-31), using its own — already maxed —
  * DefaultPTZSpeed only when Speed is absent.
 */
const SPEED_RE = /<(?:[a-zA-Z][\w-]*:)?Speed\b(?:[^>'"]*|"[^"]*"|'[^']*')*(?:\/>|>[\s\S]*?<\/(?:[a-zA-Z][\w-]*:)?Speed>)/;

/**
 * @typedef {object} CameraBinding
 * @property {number} hfovDeg     Camera horizontal field of view in degrees.
 * @property {number} vfovDeg     Camera vertical field of view in degrees.
 * @property {number} panMechDeg  Mechanical pan range in degrees.
 * @property {number} tiltMechDeg Mechanical tilt range in degrees.
 */

/**
 * @typedef {object} TranslateResult
 * @property {string} body outbound body content for the upstream camera.
 * @property {boolean} translated true when a FOV pan/tilt vector was rewritten.
 * @property {boolean} speedStripped true when a Speed element was removed from a translated body.
 * @property {{ x: number, y: number } | null} inbound FOV-space vector read from the request; null when not translated.
 * @property {{ x: number, y: number } | null} outbound generic-space vector written upstream; null when not translated.
 * @property {number | null} outboundZoom x-value of the Translation's Zoom element (forwarded unmodified), or null when absent — a move with a nonzero Zoom is NOT a no-op.
 */

/**
 * Convert a FOV-space pan/tilt translation to the equivalent generic-space
 * translation.
 *
 * @param {{ x: number, y: number }} move FOV-space translation in [-1, 1].
 * @param {CameraBinding} binding per-instance binding values.
 * @returns {{ x: number, y: number }} generic-space translation.
 */
function fovToGeneric(move, binding) {
  return {
    x: (move.x * binding.hfovDeg) / binding.panMechDeg,
    y: (move.y * binding.vfovDeg) / binding.tiltMechDeg,
  };
}

/**
 * Translate the body of an inbound `RelativeMove` from FOV space to generic
 * space, leaving everything else — ProfileToken, zoom vector, element shape —
 * untouched, and stripping the `Speed` element from the translated move
 * (the camera slow-paths whenever Speed is present).
 *
 * Only bodies whose `PanTilt` element carries a FOV translation-space URI are
 * rewritten; every other body (generic-space moves, missing or unparseable
 * vectors) is returned verbatim, per the pass-through posture (ADR-0005).
 * Zoom needs no translation: Frigate already sends it in the generic space.
 *
 * @param {string} bodyContent verbatim inner `<soap:Body>` content of a
 *   `RelativeMove` request.
 * @param {CameraBinding} binding per-instance binding values.
 * @returns {TranslateResult}
 */
function translateRelativeMove(bodyContent, binding) {
  /** @type {TranslateResult} */
  const verbatim = { body: bodyContent, translated: false, speedStripped: false, inbound: null, outbound: null, outboundZoom: null };

  const match = bodyContent.match(PANTILT_RE);
  if (!match || match.index === undefined) return verbatim;
  const element = match[0];

  const space = attrValue(element, 'space');
  if (space === null || space.indexOf(FOV_SPACE_MARKER) === -1) return verbatim;

  const xRaw = attrValue(element, 'x');
  const yRaw = attrValue(element, 'y');
  if (xRaw === null || yRaw === null) return verbatim;
  const inbound = { x: Number(xRaw), y: Number(yRaw) };
  if (!Number.isFinite(inbound.x) || !Number.isFinite(inbound.y)) return verbatim;

  const outbound = fovToGeneric(inbound, binding);
  let rewritten = replaceAttrValue(element, 'x', formatGenericValue(outbound.x));
  rewritten = replaceAttrValue(rewritten, 'y', formatGenericValue(outbound.y));
  rewritten = replaceAttrValue(rewritten, 'space', GENERIC_URI);

  let body = bodyContent.slice(0, match.index) + rewritten + bodyContent.slice(match.index + element.length);

  // The camera slow-paths on the mere presence of Speed, so the
  // translated move goes upstream without it and the camera falls back to its
  // own (max) DefaultPTZSpeed. Only ever reached for translated bodies.
  const stripped = body.replace(SPEED_RE, '');
  const speedStripped = stripped !== body;
  if (speedStripped) body = stripped;

  return { body, translated: true, speedStripped, inbound, outbound, outboundZoom: readZoomTranslation(bodyContent) };
}

/**
 * The x-value of the Zoom vector inside the move's `<Translation>` element
 * (zoom is never translated), or null when absent. Only the Translation's own
 * Zoom counts — the Speed block's Zoom is about to be stripped and says
 * nothing about the requested motion.
 *
 * @param {string} bodyContent
 * @returns {number | null}
 */
function readZoomTranslation(bodyContent) {
  const translation = bodyContent.match(
    /<(?:[a-zA-Z][\w-]*:)?Translation\b(?:[^>'"]|"[^"]*"|'[^']*')*?>([\s\S]*?)<\/(?:[a-zA-Z][\w-]*:)?Translation>/i
  );
  if (!translation || translation[1] === undefined) return null;
  const zoom = translation[1].match(/<(?:[a-zA-Z][\w-]*:)?Zoom\b((?:[^>'"]|"[^"]*"|'[^']*')*?)\/?>/i);
  if (!zoom || zoom[1] === undefined) return null;
  const x = attrValue(zoom[0], 'x');
  if (x === null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read an attribute value out of an XML element's opening tag. Accepts both
 * quote styles; returns null when the attribute is absent.
 *
 * @param {string} element
 * @param {string} name
 * @returns {string | null}
 */
function attrValue(element, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = element.match(re);
  if (!m) return null;
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  return null;
}

/**
 * Replace an attribute's value inside an XML element's opening tag, keeping
 * the attribute name, its prefix, and every other byte of the element intact.
 *
 * @param {string} element
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function replaceAttrValue(element, name, value) {
  const re = new RegExp(`(\\b${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  return element.replace(re, `$1"${value}"`);
}

/**
 * Serialize a generic-space value for the wire: 6 decimal places, trailing
 * zeros stripped. Cameras accept decimal floats; 6 places keeps the rounding
 * error (~5e-7 of the mechanical range) far below motor resolution.
 *
 * @param {number} v
 * @returns {string}
 */
function formatGenericValue(v) {
  return String(Number(v.toFixed(6)));
}

module.exports = { fovToGeneric, translateRelativeMove, GENERIC_URI, formatGenericValue };
