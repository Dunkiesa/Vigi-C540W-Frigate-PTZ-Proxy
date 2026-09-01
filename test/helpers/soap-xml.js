'use strict';

/**
 * XML extraction helpers shared by the translation tests. Pull the pan/tilt
 * and zoom vectors out of a SOAP envelope or body fragment so assertions can
 * check what actually went over the wire, whatever prefix the elements carry.
 */

/**
 * Extract the first `<...PanTilt .../>` element's attributes from an XML
 * fragment.
 *
 * @param {string} xml
 * @returns {{ x: number, y: number, space: string } | null}
 */
function extractPanTilt(xml) {
  const m = xml.match(/<(?:[a-zA-Z][\w-]*:)?PanTilt\b([^>]*)\/>/);
  if (!m || m[1] === undefined) return null;
  const attrs = m[1];
  const x = attrs.match(/\bx="([^"]*)"/);
  const y = attrs.match(/\by="([^"]*)"/);
  const space = attrs.match(/\bspace="([^"]*)"/);
  if (!x || !y || !space || x[1] === undefined || y[1] === undefined || space[1] === undefined) return null;
  return { x: Number(x[1]), y: Number(y[1]), space: space[1] };
}

/**
 * Extract the first `<...Zoom .../>` element's attributes from an XML
 * fragment.
 *
 * @param {string} xml
 * @returns {{ x: number, space: string } | null}
 */
function extractZoom(xml) {
  const m = xml.match(/<(?:[a-zA-Z][\w-]*:)?Zoom\b([^>]*)\/>/);
  if (!m || m[1] === undefined) return null;
  const attrs = m[1];
  const x = attrs.match(/\bx="([^"]*)"/);
  const space = attrs.match(/\bspace="([^"]*)"/);
  if (!x || !space || x[1] === undefined || space[1] === undefined) return null;
  return { x: Number(x[1]), space: space[1] };
}

module.exports = { extractPanTilt, extractZoom };
