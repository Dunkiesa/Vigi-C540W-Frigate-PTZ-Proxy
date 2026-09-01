'use strict';

/**
 * Shared SOAP fixtures for the HTTP-boundary tests. One envelope shape,
 * one client WS-UsernameToken header, and one canonical fault body, used
 * by the error-semantics and observability suites so their assertions agree
 * on what the wire looks like.
 */

/**
 * Wrap an inner body in a SOAP 1.2 envelope declaring the namespaces the
 * Frigate surface uses (device, schema, PTZ). Pass `header` (e.g. from
 * {@link clientSecurity}) to emit the zeep shape whose `<soap:Header>`
 * carries the client's credentials — the proxy relays that Security
 * element verbatim upstream (ADR-0008).
 *
 * @param {string} inner verbatim `<soap:Body>` content
 * @param {string} [header] content for `<soap:Header>` (omitted when empty)
 * @returns {string}
 */
function envelope(inner, header = '') {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl"' +
    ' xmlns:tt="http://www.onvif.org/ver10/schema"' +
    ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">' +
    (header ? `<soap:Header>${header}</soap:Header>` : '') +
    `<soap:Body>${inner}</soap:Body>` +
    '</soap:Envelope>'
  );
}

/**
 * A client-side `<wsse:Security>` WS-UsernameToken header, the shape
 * zeep/onvifptzcontrol sends to the proxy. The digest/nonce/created values
 * are fixed fixtures — the proxy must relay them verbatim without ever
 * checking or recomputing them (it cannot: a PasswordDigest is not
 * reversible to the password).
 *
 * @param {string} [user]
 * @returns {string}
 */
function clientSecurity(user = 'user') {
  return (
    '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"' +
    ' xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
    '<wsse:UsernameToken>' +
    `<wsse:Username>${user}</wsse:Username>` +
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">qkNjP2mfLWVPa21LU0hFMkpLd0dKWg==</wsse:Password>' +
    '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">c21va2Utbm9uY2UtaGVyZQ==</wsse:Nonce>' +
    '<wsu:Created>2026-08-31T12:00:00Z</wsu:Created>' +
    '</wsse:UsernameToken>' +
    '</wsse:Security>'
  );
}

/** A realistic ONVIF 1.2 / WS-Addressing-less auth fault, as cameras send it. */
const AUTH_FAULT =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
  '<s:Body>' +
  '<s:Fault>' +
  '<s:Code><s:Value>s:Receiver</s:Value><s:Subcode><s:Value>t:ActionNotSupported</s:Value></s:Subcode></s:Code>' +
  '<s:Reason><s:Text xml:lang="en">Authentication or permission failure</s:Text></s:Reason>' +
  '<s:Detail><ErrorText>Invalid credentials</ErrorText></s:Detail>' +
  '</s:Fault>' +
  '</s:Body>' +
  '</s:Envelope>';

module.exports = { envelope, clientSecurity, AUTH_FAULT };
