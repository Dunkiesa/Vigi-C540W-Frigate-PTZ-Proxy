# Frigate supplies the camera credentials; the proxy relays them

The proxy holds no camera credentials at all. Frigate authenticates itself: its SOAP requests carry a WS-UsernameToken (`<wsse:Security>` header), and the proxy extracts that element verbatim and re-embeds it in the fresh envelope it forwards to the camera. This works because a WS-UsernameToken PasswordDigest covers only `SHA1(nonce + created + password)` — it signs no part of the message body — so Frigate's token stays valid when relayed inside a new envelope around the (verbatim) body. A request without a Security header is forwarded unauthenticated and the camera's auth fault passes back through untouched (ADR-0005 posture). Supersedes the credential half of ADR-0006.

## Considered Options

- **Extract the password and re-digest per request.** Rejected: impossible for Frigate's stack as configured. zeep sends PasswordDigest, which is not reversible to the password; only cleartext PasswordText would allow re-digestion, and switching Frigate to that would widen the secret's exposure for no gain.
- **Keep env credentials as a fallback when Frigate sends none.** Rejected: re-introduces exactly the per-instance secret ADR-0006 was already straining to contain (one password per camera in a gitignored file, redaction rules in every log path); the fallback also masks misconfiguration — Frigate authenticates unconditionally, so "no header" always means a broken deployment, which should surface as the camera's fault.
- **Require authentication at the proxy itself (reject credential-less requests with a local 401).** Rejected: the proxy cannot verify a PasswordDigest without the password it no longer holds, and mirroring the camera's credential store just to refuse early contradicts the camera-shaped posture (ADR-0001) and ADR-0005's "faults pass through".

## Consequences

- `UPSTREAM_USER` / `UPSTREAM_PASSWORD` are gone from the config, the `.env` examples, and the compose docs; the per-instance binding is entirely non-secret, so the operator's Frigate config (`onvif: username/password`) is the single home of the camera credentials.
- The proxy never learns the password — only the digest, nonce, and created it relays. Credential material is request content, and the existing "bodies are never logged" rule already covers it.
- Replayed tokens are time-windowed by the camera (nonce/created freshness is the camera's check, not ours); a capture of Frigate's traffic yields only digests, not passwords. The relay assumes — as zeep/onvifptzcontrol does in practice — that Frigate mints a fresh UsernameToken per request; a client that caches and re-sends one token on every poll would ride its `Created` timestamp into the camera's freshness window, and the camera's fault (passed through verbatim) is the only signal.
- Only the Security element is relayed: other inbound header blocks (WS-Addressing, Timestamps) are dropped from the upstream leg, as they were under the proxy-built-envelope design this replaces.
- Credential-less requests are relayed with an empty `<soap:Header>`; whether a given firmware rejects an empty header before answering its auth fault is untested against real cameras — the deployment cameras are exercised via stubs here and should be spot-checked on first boot.
- A caller that sends no credentials gets the camera's fault verbatim; the proxy adds no error path of its own.
