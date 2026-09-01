'use strict';

const http = require('node:http');

const { extractBody, extractClientSecurity, buildEnvelope, describeSoapFault, buildSuccessResponse, SoapParseError } = require('./soap');
const { postSoap } = require('./upstream');
const { injectTranslationSpaceFov, rewriteXAddrs } = require('./response-injection');
const { translateRelativeMove, formatGenericValue } = require('./fov-translation');

/**
 * Build the proxy's HTTP listener. The listener is the only seam between
 * Frigate and the camera; everything that follows this boundary — credential
 * relay, upstream forwarding, interception / translation — lives inside the
 * request handler.
 *
 * Pass-through contract:
 *   - Inbound SOAP body is preserved verbatim and forwarded upstream inside
 *     a fresh envelope carrying Frigate's own WS-UsernameToken (ADR-0008)
 *     — with the two interception points below as the only exceptions.
 *   - The proxy holds no camera credentials: Frigate's inbound
 *     `<wsse:Security>` element is relayed verbatim (the PasswordDigest
 *     stays valid because it signs no body content), together with any
 *     namespace bindings on the inbound Header tag. A request without one
 *     is forwarded unauthenticated — the camera faults it and the fault
 *     passes through (ADR-0005 posture).
 *   - Upstream response (status code + body) is returned to Frigate unchanged.
 *   - On upstream network failure, the proxy returns HTTP 502 (ADR-0005).
 *
 * Interception:
 *   - Inbound FOV-space RelativeMove pan/tilt vectors are translated to
 *     generic space before forwarding (ADR-0002); every other body
 *     goes upstream verbatim. A translated move whose generic vector is
 *     zero-magnitude is answered locally with an empty success response —
 *     the camera faults such no-op moves.
 *   - GetConfigurationOptions responses get TranslationSpaceFov injected on
 *     the way back to Frigate (ADR-0001) — successful responses only; SOAP
 *     faults and error statuses pass through untouched.
 *   - GetCapabilities responses get their service XAddrs re-pointed at the
 *     proxy's own origin so Frigate keeps routing media/PTZ/imaging calls
 *     through here — without it, the camera's self-advertised address sends
 *     the intercepted calls past the proxy entirely. Same error semantics:
 *     faults and error statuses pass through untouched.
 *
 * Health check:
 *   - `GET /health` is answered locally with `200 ok` and never forwarded.
 *     ONVIF exchanges are always SOAP POSTs (whatever path the camera
 *     advertises, since the proxy forwards `req.url` verbatim), so an exact
 *     GET path outside the SOAP flow is the non-conflicting choice: Frigate
 *     never sends it, and nothing upstream is shadowed. It proves the proxy
 *     listener is up, not that the camera is reachable (used as the
 *     container health check in Compose).
 *
 * The function does NOT start the server — tests call `.listen()` directly
 * with an ephemeral port.
 *
 * @param {{
 *   config: import('./config').ProxyConfig,
 *   postSoapFn?: typeof postSoap,
 *   rewriteXAddrsFn?: typeof rewriteXAddrs,
 *   log?: (line: string) => void
 * }} opts
 * @returns {http.Server}
 */
function createServer({ config, postSoapFn = postSoap, rewriteXAddrsFn = rewriteXAddrs, log = () => {} }) {
  return http.createServer((req, res) => {
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      rawBody += c;
    });
    req.on('end', async () => {
      try {
        await handle(req, res, rawBody, { config, postSoapFn, rewriteXAddrsFn, log });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`proxy-level error: ${message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
        }
      }
    });

    req.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`client request error: ${message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      }
    });
  });
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} rawBody
 * @param {{ config: any, postSoapFn: any, log: (s: string) => void, injectTranslationSpaceFovFn?: typeof injectTranslationSpaceFov, translateRelativeMoveFn?: typeof translateRelativeMove, rewriteXAddrsFn?: typeof rewriteXAddrs }} deps
 */
async function handle(req, res, rawBody, { config, postSoapFn, log, injectTranslationSpaceFovFn = injectTranslationSpaceFov, translateRelativeMoveFn = translateRelativeMove, rewriteXAddrsFn = rewriteXAddrs }) {
  let bodyContent;
  let envelopeAttributes;
  let bodyElementLocalName;

  // Health endpoint: answered locally, never forwarded. ONVIF traffic is
  // always SOAP POSTs to the paths in play for the camera (the proxy is
  // path-agnostic — it forwards req.url verbatim), so an exact GET path
  // is what keeps this from colliding: Frigate never sends it and no
  // upstream path is shadowed. A 200 here means only "the proxy listener
  // is up and speaking HTTP" — it does not assert upstream reachability.
  if (isHealthRequest(req)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  try {
    ({ bodyContent, envelopeAttributes, bodyElementLocalName } = extractBody(rawBody));
  } catch (err) {
    if (err instanceof SoapParseError) {
      // Method/path/content-type only — never the body itself, which can
      // carry Frigate-configured credentials even on a failed parse
      // (logging policy).
      log(
        `malformed inbound SOAP: ${req.method || '?'} ${req.url || '?'} ` +
          `(content-type=${req.headers['content-type'] || 'none'}, length=${req.headers['content-length'] || '0'}): ` +
          err.message
      );
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    throw err;
  }

  // The single request rewrite (ADR-0002): FOV-space RelativeMove
  // pan/tilt vectors are translated to generic space using the per-instance
  // binding before forwarding. translateRelativeMove returns every other body
  // — generic-space moves included — verbatim, so this is a no-op for them.
  // Stateless by design: no position lookup, no caching, no polling.
  let outboundBody = bodyContent;
  if (bodyElementLocalName === 'RelativeMove') {
    const result = translateRelativeMoveFn(bodyContent, config);
    outboundBody = result.body;
    if (result.translated && result.inbound && result.outbound) {
      // The camera faults zero-magnitude relative moves
      // (ter:InvalidArgVal) and a no-op move needs no camera — answer it
      // locally. "Zero" is judged on the serialized wire values the camera
      // will parse, and a present Zoom translation means the move still
      // physically moves and must be forwarded.
      const wireX = formatGenericValue(result.outbound.x);
      const wireY = formatGenericValue(result.outbound.y);
      const zeroMagnitude = wireX === '0' && wireY === '0' && !result.outboundZoom;
      log(
        `FOV RelativeMove (x=${result.inbound.x}, y=${result.inbound.y}) -> ` +
          `generic (x=${wireX}, y=${wireY})` +
          (result.speedStripped ? ' (Speed stripped)' : '') +
          (zeroMagnitude ? ' (zero-magnitude move answered locally)' : '')
      );
      if (zeroMagnitude) {
        sendSoap(res, 200, buildSuccessResponse(bodyContent, envelopeAttributes));
        return;
      }
    }
  }

  // Credentials arrive with Frigate (ADR-0008): the inbound <wsse:Security>
  // element — and any namespace bindings sitting on the inbound Header tag —
  // are relayed into the fresh envelope (rationale in ADR-0008 / soap.js).
  // No Security header means the request goes upstream unauthenticated and
  // the camera's auth fault passes back untouched (ADR-0005 posture), which
  // the fault logging already surfaces. The relayed
  // header is never logged: it carries credential material.
  const client = extractClientSecurity(rawBody);
  const outbound = buildEnvelope(outboundBody, {
    authHeader: client.security || '',
    envelopeAttributes,
    headerAttributes: client.security === null ? '' : client.headerAttributes,
  });

  let upstreamResult;
  try {
    upstreamResult = await postSoapFn({
      host: config.upstreamHost,
      port: config.upstreamPort,
      path: req.url || '/',
      envelope: outbound,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`upstream unreachable (${config.upstreamHost}:${config.upstreamPort}): ${message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
    return;
  }

  // The single response rewrite (ADR-0001): inject TranslationSpaceFov into
  // GetConfigurationOptions responses so Frigate's autotracker-enablement
  // check passes. No other body is touched. Error semantics (ADR-0005)
  // narrow this further: a SOAP fault is a fault whatever status
  // it arrives with, and faults are never rewritten — inject only into a
  // successful, non-fault response.
  const faultSummary = describeSoapFault(upstreamResult.body);
  const upstreamFailed = upstreamResult.status >= 400;
  const injectable =
    bodyElementLocalName === 'GetConfigurationOptions' &&
    !upstreamFailed &&
    faultSummary === null;
  let responseBody = upstreamResult.body;
  if (injectable) {
    const injected = injectTranslationSpaceFovFn(upstreamResult.body);
    if (injected !== responseBody) {
      responseBody = injected;
      log('injected TranslationSpaceFov into GetConfigurationOptions response');
    }
  }

  // The second response rewrite (see the XAddr note on createServer): point
  // the camera's advertised service endpoints back at this proxy so
  // Frigate's media/PTZ/imaging calls keep flowing through here. Same
  // error semantics as the injection: faults and error statuses are never
  // rewritten. The advertised origin is the inbound Host header — the
  // address the client itself used to reach us.
  const proxyOrigin = req.headers.host ? `http://${req.headers.host}` : null;
  if (
    bodyElementLocalName === 'GetCapabilities' &&
    !upstreamFailed &&
    faultSummary === null &&
    proxyOrigin !== null
  ) {
    const rewritten = rewriteXAddrsFn(responseBody, /** @type {string} */ (proxyOrigin));
    if (rewritten !== responseBody) {
      responseBody = rewritten;
      log(`rewrote GetCapabilities XAddrs to ${proxyOrigin}`);
    }
  }

  // Pass-through: forward upstream status verbatim. We rewrite the response
  // headers to avoid the upstream's Content-Length / Transfer-Encoding
  // fighting with Node's framing — the upstream body is forwarded
  // byte-for-byte as captured.
  //
  // Logging policy: faults are logged with their code / reason so
  // the exchange is diagnosable from the log alone; other non-success statuses
  // get a bare status line; successful routine forwarding logs nothing.
  if (faultSummary !== null) {
    log(`upstream SOAP fault returned (status=${upstreamResult.status}): ${faultSummary}`);
  } else if (upstreamFailed) {
    log(`upstream returned non-success status=${upstreamResult.status}`);
  }
  sendSoap(res, upstreamResult.status, responseBody);
}

/**
 * A container health check: GET on exactly /health (query strings allowed —
 * probes sometimes append cache-busters, and a miss here would fail the
 * check, not just return a 400 nobody acts on). The GET-plus-exact-path
 * shape is the non-conflict guarantee: ONVIF exchanges are always SOAP
 * POSTs, so no Frigate traffic can look like this request.
 *
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function isHealthRequest(req) {
  if (req.method !== 'GET') return false;
  const path = (req.url || '').split('?', 2)[0];
  return path === '/health';
}

/**
 * Write a SOAP document with content framing that matches the body — used by
 * both the pass-through tail and locally answered requests so the two paths
 * cannot drift apart.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} body complete response document
 */
function sendSoap(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/soap+xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

module.exports = { createServer };