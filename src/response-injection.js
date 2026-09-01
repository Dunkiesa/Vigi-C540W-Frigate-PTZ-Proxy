'use strict';

/**
 * The ONVIF URI for the FOV translation space. Frigate's autotracker
 * enablement check does a substring match (`"TranslationSpaceFov" in
 * space["URI"]`), so any URI carrying the substring `TranslationSpaceFov`
 * satisfies it; we ship the canonical form.
 */
const FOV_URI = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov';

/**
 * Inject a `TranslationSpaceFov` entry into a `GetConfigurationOptionsResponse`
 * so that Frigate's autotracker-enablement check passes.
 *
 * This is one of the two response rewrites in the proxy (ADR-0001; the other
 * is rewriteXAddrs below). The injected space advertises `XRange = YRange =
 * [-1, 1]`, matching the canonical translation-space range the proxy uses as
 * its reference (ADR-0002). Frigate interpolates its own `[-1, 1]` move values
 * through this XRange via `numpy.interp` before the wire call, so the
 * wire-level values arriving at the proxy are also in `[-1, 1]`.
 *
 * Wire shape (learned the hard way — the first implementation guessed a
 * `<RelativePanTiltTranslationSpace><SpaceDescription>...` wrapper, zeep
 * silently dropped the nested entry, and Frigate's autotracker stayed
 * disabled): the schema declares `RelativePanTiltTranslationSpace` as a
 * REPEATED element of type `tt:Space2DDescription` (onvif.xsd), whose content
 * model is `URI, XRange?, YRange?` as DIRECT children. A valid FOV entry is
 * therefore a new SIBLING element appended after the last existing one.
 * Anything outside the content model is invisible to strict schema parsers.
 * The live target camera confirms this shape.
 *
 * Behaviour:
 *   - Find every `RelativePanTiltTranslationSpace` element in the body
 *     (paired or self-closing form). If none exist, return the body
 *     unchanged — upstream is broken; per ADR-0005, the proxy passes that
 *     through.
 *   - If any existing element already carries a URI containing the substring
 *     `TranslationSpaceFov` (mirrors Frigate's check), return unchanged
 *     (idempotent).
 *   - Otherwise insert a new sibling element immediately after the LAST
 *     existing one. The sibling reuses the element prefix and the children's
 *     prefix (falling back to the element prefix) and re-declares any `xmlns`
 *     bindings from the template element's own opening tag, so every prefix
 *     the sibling uses is in scope no matter where it was declared.
 *
 * Every other byte of the body — envelope, namespaces, sibling `Spaces`
 * children, every other config option — is preserved verbatim.
 *
 * @param {string} body verbatim upstream response body for a
 *   `GetConfigurationOptions` call.
 * @returns {string} the body with a `TranslationSpaceFov` entry guaranteed
 *   to be present in `RelativePanTiltTranslationSpace`.
 */
function injectTranslationSpaceFov(body) {
  const matches = [...body.matchAll(SPACE_ELEM_RE)];
  if (matches.length === 0) return body;
  if (matches.some((m) => elementHasFovUri(m[0]))) return body;
  const last = matches[matches.length - 1];
  if (!last) return body; // noUncheckedIndexedAccess demands the guard; matches.length > 0 makes it unreachable in practice
  const insertAt = last.index + last[0].length;
  return body.slice(0, insertAt) + fovSpaceElement(last[0]) + body.slice(insertAt);
}

/**
 * Match one `RelativePanTiltTranslationSpace` ELEMENT (any prefix, or none;
 * paired or self-closing). The schema makes it a repeated element, so
 * multiple matches per body are normal. Deliberately does not bind open/close
 * prefix agreement — same lenient policy as `isSoapFaultBody`.
 */
const SPACE_ELEM_RE = /<(?:[a-zA-Z][\w-]*:)?RelativePanTiltTranslationSpace\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:[a-zA-Z][\w-]*:)?RelativePanTiltTranslationSpace>)/gi;

/**
 * The namespace prefix on the element's own tag ('' when unprefixed).
 *
 * @param {string} elementFragment a full matched RelativePanTiltTranslationSpace element
 * @returns {string}
 */
function elementPrefixOf(elementFragment) {
  const m = elementFragment.match(/^<(?:([a-zA-Z][\w-]*):)?RelativePanTiltTranslationSpace/);
  return (m && m[1]) || '';
}

/**
 * The prefix the element's children use, seen on the first prefixed child
 * tag; undefined when the content is empty or entirely unprefixed.
 *
 * @param {string} elementFragment
 * @returns {string | undefined}
 */
function childPrefixOf(elementFragment) {
  const inner = elementFragment.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
  const m = inner.match(/<([a-zA-Z][\w-]*):/);
  return m ? m[1] : undefined;
}

/**
 * Every `xmlns[:prefix]="..."` declaration written on the template element's
 * own opening tag, re-emitted (space-prefixed) for the sibling's opening tag.
 * Declarations on ancestors need nothing — the sibling lands inside the same
 * scope; declarations local to the template element would otherwise be lost.
 *
 * @param {string} elementFragment
 * @returns {string} '' or e.g. ` xmlns:tt="http://www.onvif.org/ver10/schema"`
 */
function localDeclarationsOf(elementFragment) {
  const openTag = (elementFragment.match(/^<[^>]*>/) || [''])[0];
  return [...openTag.matchAll(/xmlns(?::[a-zA-Z][\w-]*)?\s*=\s*"[^"]*"/g)].map((m) => ` ${m[0]}`).join('');
}

/**
 * Match any `<URI>...</URI>` element. Group 1 is the URI text.
 */
const URI_RE = /<(?:[a-zA-Z][\w-]*:)?URI\b[^>]*>([^<]*)<\/(?:[a-zA-Z][\w-]*:)?URI>/gi;

/**
 * True when any `<URI>` inside the given element fragment contains the
 * substring `TranslationSpaceFov`. Mirrors Frigate's check
 * (`"TranslationSpaceFov" in space["URI"]`) so a substring match is the
 * idempotency criterion.
 *
 * @param {string} elementFragment
 * @returns {boolean}
 */
function elementHasFovUri(elementFragment) {
  URI_RE.lastIndex = 0;
  let m;
  while ((m = URI_RE.exec(elementFragment)) !== null) {
    if (m[1] && m[1].indexOf('TranslationSpaceFov') !== -1) return true;
  }
  return false;
}

/**
 * Build the FOV sibling element shaped after an existing one: `[-1.0, 1.0]`
 * is the canonical range ADR-0002 commits the proxy to; prefixes and local
 * xmlns declarations are reused so the injected element parses in scope.
 *
 * @param {string} templateElement a full matched RelativePanTiltTranslationSpace element
 * @returns {string}
 */
function fovSpaceElement(templateElement) {
  const elemPrefix = elementPrefixOf(templateElement);
  const childPrefix = childPrefixOf(templateElement) ?? elemPrefix;
  const decls = localDeclarationsOf(templateElement);
  const e = elemPrefix ? `${elemPrefix}:` : '';
  const c = childPrefix ? `${childPrefix}:` : '';
  return (
    `<${e}RelativePanTiltTranslationSpace${decls}>` +
    `<${c}URI>${FOV_URI}</${c}URI>` +
    `<${c}XRange><${c}Min>-1.0</${c}Min><${c}Max>1.0</${c}Max></${c}XRange>` +
    `<${c}YRange><${c}Min>-1.0</${c}Min><${c}Max>1.0</${c}Max></${c}YRange>` +
    `</${e}RelativePanTiltTranslationSpace>`
  );
}

/**
 * Rewrite the service endpoint XAddrs in a `GetCapabilitiesResponse` so they
 * point at the proxy's own origin instead of the camera's address.
 *
 * Why this is needed: Frigate's client takes each advertised XAddr as the
 * endpoint for every subsequent service call (media, PTZ, imaging). The camera
 * advertises its own address (e.g. `http://<IP>:<PORT>/onvif/service`), so
 * without this rewrite the calls the proxy exists to intercept —
 * `GetConfigurationOptions` and `RelativeMove` — would flow straight to the
 * camera and the FOV feature would never engage.
 *
 * The rewrite replaces each XAddr URL's scheme+authority with the proxy origin
 * (the inbound request's `Host` header) and preserves the path verbatim. The
 * path is cosmetic upstream: this camera family dispatches ONVIF bodies purely
 * by namespace, ignoring the request path (verified against the target:
 * `POST /bogus` with a media GetProfiles returns 200 + a normal response).
 *
 * XAddr elements that don't carry an http(s) URL — notably the empty
 * `<tt:XAddr></tt:XAddr>` some cameras send for unsupported services — are
 * left untouched, as is every other element.
 *
 * @param {string} body verbatim upstream `GetCapabilities` response body
 * @param {string} proxyOrigin origin to advertise, e.g. `http://<PROXY-IP>:8080`
 * @returns {string} the body with every XAddr authority pointed at the proxy
 */
function rewriteXAddrs(body, proxyOrigin) {
  return body.replace(XADDR_URL_RE, (_whole, open, urlPath, close) =>
    `${open}${proxyOrigin}${urlPath || ''}${close}`
  );
}

/**
 * Match an `<XAddr>` element (any prefix, or none) whose text is an http(s)
 * URL. Capture group 1 is the opening tag, group 2 the URL path after the
 * authority (possibly absent), group 3 the closing tag.
 */
const XADDR_URL_RE =
  /(<(?:[a-zA-Z][\w-]*:)?XAddr\b[^>]*>)\s*https?:\/\/[^\/\s<]+(\/[^<\s]*)?\s*(<\/(?:[a-zA-Z][\w-]*:)?XAddr>)/gi;

module.exports = { injectTranslationSpaceFov, rewriteXAddrs, FOV_URI };
