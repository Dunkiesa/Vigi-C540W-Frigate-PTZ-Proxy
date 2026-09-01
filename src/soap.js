'use strict';

/**
 * Namespace-prefix pattern shared by every element regex in this module.
 * Accepts any valid XML prefix or none: zeep (Frigate's client) sends the
 * SOAP 1.2 default `SOAP-ENV:`, other stacks use `soap:` / `env:`, and
 * cameras answer with whatever prefix their XML stack prefers — the
 * pass-through contract (ADR-0001) means the parser must not assume one.
 */
const NS_PREFIX = String.raw`(?:[a-zA-Z][\w.-]*:)?`;

/**
 * Opening `<Envelope>` tag, capturing its attribute string. Anchored with `^`
 * and applied to the document after prolog stripping (see stripProlog), so
 * only a real document-element Envelope parses — a garbage body that merely
 * embeds an Envelope-shaped fragment stays rejected.
 */
const ENVELOPE_OPEN_RE = new RegExp(`^<${NS_PREFIX}Envelope\\b([^>]*)>`, 'i');

/**
 * Parse a SOAP envelope and return the inner `<Body>` content along with the
 * local name of the body's root element. The envelope's namespaces and every
 * byte of the inner body are preserved verbatim — pass-through requires that
 * the proxy never mutates the body content on its way upstream.
 *
 * This is a regex-based parser, intentionally small and dependency-free to
 * match a lean, dependency-free style. The body's root element is the only
 * piece routing / interception logic needs.
 *
 * @param {string} envelope
 * @returns {{
 *   bodyElementLocalName: string | null,
 *   bodyContent: string,
 *   envelopeAttributes: string
 * }}
 *   `bodyContent` is the verbatim inner XML of the `<Body>` element,
 *   ready to be re-wrapped in a new envelope with the client's relayed
 *   `<wsse:Security>` header (ADR-0008).
 *   `envelopeAttributes` is the verbatim attribute string of the inbound
 *   `<Envelope>` opening tag (including namespace declarations); the
 *   forwarder copies these onto the outbound envelope so the body's prefixed
 *   elements remain bound to their URIs.
 * @throws if the document element is not an `<Envelope>`, or the envelope does
 *   not contain a `<Body>` element.
 */
function extractBody(envelope) {
  const doc = stripProlog(envelope);
  const envelopeMatch = doc.match(ENVELOPE_OPEN_RE);
  if (!envelopeMatch) {
    throw new SoapParseError('envelope does not contain an <Envelope> element');
  }
  const envelopeAttributes = envelopeMatch[1] || '';

  const bodyContent = matchLocal(envelope, 'Body');
  if (bodyContent === null) {
    throw new SoapParseError('envelope does not contain a <Body> element');
  }
  const rootMatch = bodyContent.match(/^\s*<([^\s\/>]+)/);
  const bodyElementLocalName = rootMatch && rootMatch[1] !== undefined ? stripPrefix(rootMatch[1]) : null;
  return { bodyElementLocalName, bodyContent, envelopeAttributes };
}

/**
 * Drop the XML prolog — byte-order mark, whitespace, XML declaration,
 * processing instructions and comments — so the Envelope-open test can
 * require the envelope to be the document element.
 *
 * @param {string} xml
 * @returns {string}
 */
function stripProlog(xml) {
  let rest = xml.replace(/^\uFEFF/, '');
  let m;
  while ((m = rest.match(/^\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)/))) {
    rest = rest.slice(m[0].length);
  }
  return rest.replace(/^\s+/, '');
}

/**
 * @param {string} qname
 * @returns {string}
 */
function stripPrefix(qname) {
  const colon = qname.indexOf(':');
  return colon >= 0 ? qname.slice(colon + 1) : qname;
}

class SoapParseError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SoapParseError';
  }
}

/** Upper bound on a fault summary's contribution to one log line. */
const MAX_FAULT_SUMMARY = 240;

/**
 * True when the given response document is a SOAP Fault envelope — i.e. the
 * `<Body>`'s root element is `Fault` (any prefix: `s:Fault`, `soap:Fault`,
 * or the unprefixed SOAP 1.1 `<Fault>`). Prefix tolerance is shared with
 * extractBody through matchLocal — cameras answer with whatever prefix their
 * XML stack prefers. Non-SOAP garbage (HTML error pages, truncated bodies) is
 * reported as not-a-fault; the caller forwards garbage verbatim, which is
 * exactly what ADR-0005 wants for anything broken.
 *
 * @param {string} body upstream response body
 * @returns {boolean}
 */
function isSoapFaultBody(body) {
  const inner = matchLocal(body, 'Body');
  if (inner === null) return false;
  const rootMatch = inner.match(/^\s*<([^\s\/>]+)/);
  if (!rootMatch || rootMatch[1] === undefined) return false;
  return stripPrefix(rootMatch[1]) === 'Fault';
}

/**
 * Summarise a SOAP Fault body for the log (observability policy):
 * fault code, optional subcode, and reason text — enough to diagnose which
 * camera-side failure Frigate is being handed. Returns null for anything that
 * is not a fault; the caller decides what to log then.
 *
 * Prefix-agnostic like isSoapFaultBody: real cameras answer with `s:Fault`,
 * `soap-env:Fault`, or unprefixed, and the nested Code/Value/Reason elements
 * carry the envelope's own prefix.
 *
 * @param {string} body upstream response body
 * @returns {string | null} a one-line summary, or null when `body` is not a fault
 */
function describeSoapFault(body) {
  if (!isSoapFaultBody(body)) return null;
  // Greedy to the last closing Fault tag (the Fault is the body's only root);
  // nested detail elements are matched later with lazy matchLocal.
  const faultMatch = body.match(new RegExp(`<${NS_PREFIX}Fault\\b[^>]*>([\\s\\S]*)</${NS_PREFIX}Fault>`, 'i'));
  const fault = faultMatch && faultMatch[1] !== undefined ? faultMatch[1] : '';

  /** @type {string[]} */
  const parts = [];
  const codeMatch = matchLocal(fault, 'Code');
  const codeValue = codeMatch ? firstValue(codeMatch) : null;
  if (codeValue) parts.push(`code=${codeValue}`);
  const subcodeMatch = codeMatch ? matchLocal(codeMatch, 'Subcode') : null;
  const subcodeValue = subcodeMatch ? firstValue(subcodeMatch) : null;
  if (subcodeValue) parts.push(`subcode=${subcodeValue}`);
  const reasonMatch = matchLocal(fault, 'Reason');
  if (reasonMatch) {
    const text = stripTags(reasonMatch);
    if (text) parts.push(`reason="${text}"`);
  }
  // Older firmware answers SOAP 1.1 with flat faultcode / faultstring —
  // isSoapFaultBody treats those as faults too, so summarise them likewise.
  if (parts.length === 0) {
    const legacyCode = matchLocal(fault, 'faultcode');
    if (legacyCode) parts.push(`code=${stripTags(legacyCode)}`);
    const legacyString = matchLocal(fault, 'faultstring');
    if (legacyString) parts.push(`reason="${stripTags(legacyString)}"`);
  }
  const summary = parts.length > 0 ? parts.join(' ') : 'fault (no details)';
  // The reason text is camera-controlled; cap the line so one misbehaving
  // upstream cannot bloat the log. (stripTags already folded newlines.)
  return summary.length > MAX_FAULT_SUMMARY ? summary.slice(0, MAX_FAULT_SUMMARY - 3) + '...' : summary;
}

/**
 * Extract the inner content of the first element with the given local name
 * (any prefix) in an XML fragment, or null when absent.
 *
 * @param {string} xml
 * @param {string} localName
 * @returns {string | null}
 */
function matchLocal(xml, localName) {
  const m = xml.match(new RegExp(`<${NS_PREFIX}${localName}\\b[^>]*>([\\s\\S]*?)</${NS_PREFIX}${localName}>`, 'i'));
  return m && m[1] !== undefined ? m[1] : null;
}

/**
 * The text of the first <Value> element inside a fragment.
 *
 * @param {string} xml
 * @returns {string | null}
 */
function firstValue(xml) {
  const inner = matchLocal(xml, 'Value');
  if (inner === null) return null;
  const text = stripTags(inner);
  return text === '' ? null : text;
}

/**
 * Collapse an element fragment to its text content: tags stripped, entities
 * and whitespace normalised. Enough for a single log line, not a parser.
 *
 * @param {string} xml
 * @returns {string}
 */
function stripTags(xml) {
  return xml
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The inbound `<soap:Header>` element (any prefix): its attributes and
 * inner content, both needed together for the credential relay — the
 * client may bind `wsse` on the Header opening tag just as well as on the
 * Envelope or the Security element itself. First match wins; SOAP orders
 * Header before Body, so the document's real header is always found first.
 */
const HEADER_ELEMENT_RE =
  /<((?:[a-zA-Z][\w.-]*:)?)Header\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1Header>)/i;

/**
 * The client's WS-UsernameToken, located inside the SOAP Header only — a
 * `<Security>` element somewhere in the Body is message content and must
 * never be lifted into the outbound header. Returns the Security element
 * verbatim (or null when the client authenticated with nothing) plus the
 * inbound Header's attribute string, which the forwarder re-attaches to
 * the outbound Header so the relayed element's namespace bindings survive
 * the envelope rebuild (ADR-0008).
 *
 * Prefix-tolerant like the rest of this module, matched by local name:
 * zeep declares `xmlns:wsse` on the Envelope or the Header, not the
 * Security element, so a URI check on the fragment itself would fail.
 *
 * @param {string} envelope the raw inbound document
 * @returns {{ security: string | null, headerAttributes: string }}
 *   `security` is the complete `<…Security>…</…Security>` element verbatim
 *   (or self-closing form), null when absent; `headerAttributes` is the
 *   inbound `<…Header>` opening-tag attribute string ('' when no Header).
 */
function extractClientSecurity(envelope) {
  const header = envelope.match(HEADER_ELEMENT_RE);
  if (!header) {
    return { security: null, headerAttributes: '' };
  }
  const inner = header[3] || '';
  const security = inner.match(
    /<((?:[a-zA-Z][\w.-]*:)?)Security\b[^>]*?(?:\/>|>[\s\S]*?<\/\1Security>)/i
  );
  return {
    security: security ? security[0] : null,
    headerAttributes: header[2] || '',
  };
}

/**
 * Build a fresh SOAP envelope around the given body content. Used by the
 * upstream forwarder to add a `<soap:Header>`; `authHeader` is the inbound
 * client's verbatim `<wsse:Security>` element (ADR-0008), or '' to send
 * the request unauthenticated. `headerAttributes` carries the inbound
 * Header's attribute string (namespace bindings for the relayed element)
 * onto the outbound Header.
 *
 * `envelopeAttributes` carries the inbound envelope's attribute string so
 * namespace declarations like `xmlns:tds="..."` survive the round-trip and
 * the body's prefixed elements stay bound to their URIs upstream.
 *
 * @param {string} bodyContent verbatim inner XML of the inbound `<Body>` (any prefix)
 * @param {{ authHeader: string, envelopeAttributes?: string, headerAttributes?: string }} opts
 * @returns {string} a complete `<soap:Envelope>` document
 */
function buildEnvelope(bodyContent, { authHeader, envelopeAttributes = '', headerAttributes = '' }) {
  // xmlns:soap is added by this function; if the inbound already declared it
  // (it does, by spec) we end up with two declarations of the same prefix/URI
  // pair, which XML allows but is ugly. Strip the inbound's xmlns:soap so we
  // own the canonical declaration.
  const cleanedAttrs = envelopeAttributes.replace(/\s+xmlns:soap=(?:"[^"]*"|'[^']*')/i, '');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
    cleanedAttrs +
    '>' +
    `<soap:Header${headerAttributes}>${authHeader}</soap:Header>` +
    `<soap:Body>${bodyContent}</soap:Body>` +
    '</soap:Envelope>'
  );
}

/**
 * Build a minimal SOAP 1.2 success response for a request the proxy answers
 * locally (the target camera faults zero-magnitude RelativeMoves,
 * and a no-op move is one the proxy can complete itself). The response
 * element is the request's root local name + `Response`, carrying the same
 * namespace binding the request root had — element-local declaration wins
 * over the envelope's — so namespace-validating clients (zeep) accept it.
 *
 * @param {string} requestBodyContent verbatim inner `<soap:Body>` content of the inbound request
 * @param {string} envelopeAttributes the inbound `<Envelope>` opening-tag attribute string
 * @returns {string} a complete response document
 */
function buildSuccessResponse(requestBodyContent, envelopeAttributes) {
  const root = requestBodyContent.match(
    /^\s*<(?:([a-zA-Z][\w.-]*):)?([a-zA-Z][\w.-]*)\b((?:[^>'"]|"[^"]*"|'[^']*')*?)\/?>/
  );
  if (!root || root[2] === undefined) {
    throw new SoapParseError('buildSuccessResponse: request body content has no root element');
  }
  const prefix = root[1] || '';
  const localName = root[2];
  const rootAttributes = root[3] || '';

  const bindingOf = (/** @type {string} */ attributes, /** @type {string} */ pfx) => {
    const escaped = pfx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = pfx
      ? new RegExp(`xmlns:${escaped}\\s*=\\s*"([^"]*)"`)
      : /xmlns\s*=\s*"([^"]*)"/;
    const m = attributes.match(re);
    return m && m[1] !== undefined ? m[1] : null;
  };

  const uri = bindingOf(rootAttributes, prefix) ?? bindingOf(envelopeAttributes, prefix);
  const qname = prefix ? `${prefix}:` : '';
  const decl = uri === null ? '' : ` xmlns${prefix ? ':' + prefix : ''}="${uri}"`;
  return buildEnvelope(`<${qname}${localName}Response${decl}/>`, { authHeader: '', envelopeAttributes });
}

module.exports = { extractBody, extractClientSecurity, buildEnvelope, isSoapFaultBody, describeSoapFault, buildSuccessResponse, SoapParseError };