# Proxy passes through upstream errors verbatim

When the upstream camera returns a SOAP fault, the proxy returns the same fault to Frigate — unmodified. When the upstream camera is unreachable (network down, camera offline), the proxy returns HTTP 502 Bad Gateway. Frigate's logs are operationally indistinguishable from logs against a flaky camera — by design.

## Considered Options

- **Synthesize normalized errors.** A unified proxy-error envelope plus a pass-through fault envelope. Rejected: Frigate already speaks ONVIF fault and already has logging for it. A second schema adds a second thing to debug.
- **Suppress and retry internally before failing.** Rejected: hides upstream behaviour from Frigate, complicates debugging, and adds a retry surface the proxy must own.

## Consequences

- Operators see one error source (the camera/proxy boundary), not two. Whether the failure is on the camera's side or the proxy's side, it shows up as a SOAP fault or a 502 — the diagnostic question is the same in either case.
- The proxy must not silently swallow a fault or rewrite it into a 200. Verifiable in review: every pass-through path either returns the upstream response unchanged or, if it must rewrite, raises an explicit log line.