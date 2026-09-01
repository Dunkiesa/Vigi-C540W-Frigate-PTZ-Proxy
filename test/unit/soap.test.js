'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractBody, extractClientSecurity, isSoapFaultBody } = require('../../src/soap');

describe('soap.extractBody', () => {
  it('returns the local name of the body element when prefixed', () => {
    const env = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
<soap:Body><trt:GetProfiles/></soap:Body>
</soap:Envelope>`;
    const { bodyElementLocalName } = extractBody(env);
    assert.equal(bodyElementLocalName, 'GetProfiles');
  });

  it('returns the local name of the body element when unprefixed', () => {
    const env = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
<soap:Body><GetProfiles/></soap:Body>
</soap:Envelope>`;
    const { bodyElementLocalName } = extractBody(env);
    assert.equal(bodyElementLocalName, 'GetProfiles');
  });

  it('returns the inner body content verbatim, ready to be re-wrapped in a new envelope', () => {
    const env = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
<soap:Body><trt:GetProfiles/></soap:Body>
</soap:Envelope>`;
    const { bodyContent } = extractBody(env);
    assert.equal(bodyContent, '<trt:GetProfiles/>');
  });

  it('returns the inner body content for an element with attributes', () => {
    const env = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
<soap:Body><tptz:RelativeMove><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:RelativeMove></soap:Body>
</soap:Envelope>`;
    const { bodyElementLocalName, bodyContent } = extractBody(env);
    assert.equal(bodyElementLocalName, 'RelativeMove');
    assert.equal(
      bodyContent,
      '<tptz:RelativeMove><tptz:ProfileToken>prof1</tptz:ProfileToken></tptz:RelativeMove>'
    );
  });

  it('returns null for the local name when there is no body element', () => {
    const env = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
<soap:Body></soap:Body>
</soap:Envelope>`;
    const { bodyElementLocalName, bodyContent } = extractBody(env);
    assert.equal(bodyElementLocalName, null);
    assert.equal(bodyContent, '');
  });

  it('returns the inbound envelope\'s attribute string so the forwarder can preserve namespaces', () => {
    const env = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
<soap:Body><tds:GetCapabilities/></soap:Body>
</soap:Envelope>`;
    const { envelopeAttributes } = extractBody(env);
    assert.match(envelopeAttributes, /xmlns:soap="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
    assert.match(envelopeAttributes, /xmlns:tds="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"/);
  });

  it('throws on a malformed envelope (no Body element)', () => {
    const env = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"></soap:Envelope>`;
    assert.throws(() => extractBody(env), /Body/);
  });

  it('throws on a missing Envelope element', () => {
    const env = `<soap:Body><tds:GetCapabilities/></soap:Body>`;
    assert.throws(() => extractBody(env), /Envelope/);
  });

  it('parses the SOAP 1.2 default prefix zeep sends (SOAP-ENV:)', () => {
    const env = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
<SOAP-ENV:Header/><SOAP-ENV:Body><tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
    const { bodyElementLocalName, bodyContent, envelopeAttributes } = extractBody(env);
    assert.equal(bodyElementLocalName, 'GetCapabilities');
    assert.equal(bodyContent, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    assert.match(envelopeAttributes, /xmlns:SOAP-ENV="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
  });

  it('extracts the body from an env:-prefixed envelope (axis style)', () => {
    const env = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
<env:Header/><env:Body><tptz:GetStatus/></env:Body>
</env:Envelope>`;
    const { bodyElementLocalName } = extractBody(env);
    assert.equal(bodyElementLocalName, 'GetStatus');
  });

  it('accepts a dotted namespace prefix', () => {
    const env = `<m.ns:Envelope xmlns:m.ns="http://www.w3.org/2003/05/soap-envelope"><m.ns:Body><trt:GetProfiles/></m.ns:Body></m.ns:Envelope>`;
    const { bodyElementLocalName } = extractBody(env);
    assert.equal(bodyElementLocalName, 'GetProfiles');
  });

  it('rejects a document that merely embeds an Envelope-shaped fragment', () => {
    const doc = `<html><body>note</body><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><tds:GetCapabilities/></soap:Body></soap:Envelope></html>`;
    assert.throws(() => extractBody(doc), /Envelope/);
  });

  it('accepts an XML prolog (declaration, comments, PIs) before the document-element Envelope', () => {
    const env = `<?xml version="1.0" encoding="UTF-8"?>
<!-- routing note -->
<?pi example?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
<soap:Body><trt:GetProfiles/></soap:Body>
</soap:Envelope>`;
    const { bodyElementLocalName } = extractBody(env);
    assert.equal(bodyElementLocalName, 'GetProfiles');
  });
});


describe('soap.extractClientSecurity', () => {
  const SECURITY =
    '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    '<wsse:UsernameToken><wsse:Username>user</wsse:Username>' +
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">abc123</wsse:Password>' +
    '</wsse:UsernameToken></wsse:Security>';

  it('returns the full Security element verbatim, attributes included', () => {
    const doc = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Header>${SECURITY}</soap:Header><soap:Body><tds:GetProfiles/></soap:Body></soap:Envelope>`;
    assert.deepEqual(extractClientSecurity(doc), { security: SECURITY, headerAttributes: '' });
  });

  it('handles the zeep shape where the wsse binding sits on the Envelope', () => {
    const doc =
      '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" ' +
      'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<SOAP-ENV:Header><wsse:Security><wsse:UsernameToken><wsse:Username>u</wsse:Username></wsse:UsernameToken></wsse:Security></SOAP-ENV:Header>' +
      '<SOAP-ENV:Body><tds:GetProfiles/></SOAP-ENV:Body></SOAP-ENV:Envelope>';
    assert.deepEqual(extractClientSecurity(doc), {
      security: '<wsse:Security><wsse:UsernameToken><wsse:Username>u</wsse:Username></wsse:UsernameToken></wsse:Security>',
      headerAttributes: '',
    });
  });

  it('captures Header-tag bindings so the relayed element stays namespace-bound after the rebuild', () => {
    const doc =
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
      '<soap:Header xmlns:wsse="urn:wsse"><wsse:Security><wsse:UsernameToken/></wsse:Security></soap:Header>' +
      '<soap:Body/></soap:Envelope>';
    const { security, headerAttributes } = extractClientSecurity(doc);
    assert.equal(security, '<wsse:Security><wsse:UsernameToken/></wsse:Security>');
    assert.equal(headerAttributes, ' xmlns:wsse="urn:wsse"');
  });

  it('matches an alternate prefix and its matching close tag', () => {
    const doc = '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:s="urn:wsse"><env:Header><s:Security><s:UsernameToken/></s:Security></env:Header><env:Body/></env:Envelope>';
    assert.equal(extractClientSecurity(doc).security, '<s:Security><s:UsernameToken/></s:Security>');
  });

  it('matches an unprefixed Security element', () => {
    const doc = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Header><Security xmlns="urn:wsse"><UsernameToken/></Security></soap:Header><soap:Body/></soap:Envelope>';
    assert.equal(extractClientSecurity(doc).security, '<Security xmlns="urn:wsse"><UsernameToken/></Security>');
  });

  it('matches the self-closing form', () => {
    const doc = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:s="urn:wsse"><soap:Header><s:Security/></soap:Header><soap:Body/></soap:Envelope>';
    assert.equal(extractClientSecurity(doc).security, '<s:Security/>');
  });

  it('reports no credentials when the Header carries no Security element', () => {
    const doc = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Header/><soap:Body><tds:GetProfiles/></soap:Body></soap:Envelope>';
    assert.deepEqual(extractClientSecurity(doc), { security: null, headerAttributes: '' });
  });

  it('never lifts a Security element out of the Body - the Header is the only scope', () => {
    // Regression: extraction was once document-wide, so a payload element
    // named Security could be hoisted into the outbound header.
    const doc =
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:s="urn:wsse"><soap:Header/>' +
      '<soap:Body><payload><s:Security><s:UsernameToken><s:Username>attacker</s:Username></s:UsernameToken></s:Security></payload></soap:Body>' +
      '</soap:Envelope>';
    assert.equal(extractClientSecurity(doc).security, null);
  });

  it('prefers the SOAP Header when both header and body carry Security', () => {
    const doc =
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:s="urn:wsse"><soap:Header><s:Security><s:UsernameToken><s:Username>real</s:Username></s:UsernameToken></s:Security></soap:Header>' +
      '<soap:Body><payload><s:Security>not-a-token</s:Security></payload></soap:Body></soap:Envelope>';
    const { security } = extractClientSecurity(doc);
    assert.ok(security);
    assert.match(security, /real/);
  });

  it('reports no credentials when the document has no Header element at all', () => {
    const doc = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><tds:GetProfiles/></soap:Body></soap:Envelope>';
    assert.deepEqual(extractClientSecurity(doc), { security: null, headerAttributes: '' });
  });
});

describe('soap.isSoapFaultBody', () => {
  it('detects a SOAP 1.2 prefixed Fault as the body root', () => {
    const body = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code></s:Fault></s:Body></s:Envelope>';
    assert.equal(isSoapFaultBody(body), true);
  });

  it('detects an unprefixed SOAP 1.1 Fault', () => {
    const body = '<Envelope><Body><Fault><faultcode>Client</faultcode></Fault></Body></Envelope>';
    assert.equal(isSoapFaultBody(body), true);
  });

  it('returns false for a normal response body', () => {
    const body = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><tds:GetCapabilitiesResponse/></soap:Body></soap:Envelope>';
    assert.equal(isSoapFaultBody(body), false);
  });

  it('returns false for a body that merely mentions Fault in text', () => {
    const body = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><res><Text>Fault reported upstream</Text></res></soap:Body></soap:Envelope>';
    assert.equal(isSoapFaultBody(body), false);
  });

  it('returns false for non-SOAP garbage (HTML error page)', () => {
    assert.equal(isSoapFaultBody('<html><body>500 Internal Server Error</body></html>'), false);
  });
});

describe('soap.buildSuccessResponse — locally answered intercepted requests', () => {
  const { buildSuccessResponse } = require('../../src/soap');

  it('answers with the request local name + Response, binding mirrored from the envelope declarations', () => {
    const attrs = ' xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver10/ptz/wsdl"';
    const out = buildSuccessResponse('<tptz:RelativeMove><tptz:ProfileToken>p1</tptz:ProfileToken></tptz:RelativeMove>', attrs);
    assert.match(out, /<soap:Envelope xmlns:soap="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
    assert.match(out, /<soap:Body><tptz:RelativeMoveResponse xmlns:tptz="http:\/\/www\.onvif\.org\/ver10\/ptz\/wsdl"\/><\/soap:Body>/);
    assert.ok(!out.includes('UsernameToken'), 'a response carries no WSSE header');
  });

  it('mirrors an element-local xmlns binding when the envelope does not declare it', () => {
    const out = buildSuccessResponse(
      '<foo:RelativeMove xmlns:foo="urn:local:ptz"><foo:ProfileToken>p1</foo:ProfileToken></foo:RelativeMove>',
      ' xmlns:soap="http://www.w3.org/2003/05/soap-envelope"'
    );
    assert.match(out, /<foo:RelativeMoveResponse xmlns:foo="urn:local:ptz"\/>/);
  });

  it('mirrors a default (unprefixed) namespace binding', () => {
    const out = buildSuccessResponse(
      '<RelativeMove xmlns="urn:default:ptz"/>',
      ' xmlns="urn:envelope:whatever"'
    );
    assert.match(out, /<RelativeMoveResponse xmlns="urn:default:ptz"\/>/);
  });

  it('emits a bare prefixed element when the binding is already on the envelope attrs', () => {
    const attrs = ' xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"';
    const out = buildSuccessResponse('<tptz:RelativeMove/>', attrs);
    assert.match(out, /<tptz:RelativeMoveResponse(?: xmlns:tptz="http:\/\/www\.onvif\.org\/ver20\/ptz\/wsdl")?\/>/);
    assert.match(out, /<soap:Envelope[^>]*tptz="http:\/\/www\.onvif\.org\/ver20\/ptz\/wsdl"/);
  });

  it('rejects request content without a root element', () => {
    assert.throws(() => buildSuccessResponse('   ', ''), /no root element/);
  });
});
