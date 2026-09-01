# ONVIF PTZ Proxy — Domain Glossary

Single-context glossary for the Frigate↔ONVIF-camera proxy project. Vocabulary only — no implementation detail, no architecture.

## Language

**Proxy**:
A transparent HTTP/SOAP interceptor that sits between Frigate and an ONVIF PTZ camera. It presents the upstream camera's identity (`GetCapabilities`, `GetDeviceInformation`) to Frigate — except that it re-points advertised service XAddrs at itself, so Frigate's subsequent calls keep flowing through the proxy instead of bypassing it — and selectively injects or transforms SOAP responses so that the camera appears to advertise ONVIF capabilities it does not natively expose.
_Avoid_: facade, gateway, adapter, bridge

**Frigate**:
The NVR/detection system that drives autotracking. In this context, Frigate is the *user* of the proxy — its autotracker is the only client behaviour the proxy is shaped around.
_Avoid_: client, NVR

**Camera**:
The upstream ONVIF PTZ device on the LAN. Owns the real PTZ node, media profiles, and video source. In this project, **two** cameras are supported for autotracking (a third unit, `<IP>`, was excluded because its `MoveStatus` reports `UNKNOWN` consistently). Per-unit drift in HFOV/VFOV is expected across the two supported units.
_Avoid_: device, PTZ node (a camera *contains* a PTZ node, but is not one)

**Translation space**:
The ONVIF coordinate system in which a PTZ move is expressed. Generic and FOV are two such spaces. The proxy's purpose is to translate moves between spaces.
_Avoid_: coordinate system (too generic), space (ambiguous)

**Generic translation space**:
The normalized `[-1, 1]` coordinate system mapped to a PTZ node's mechanical range. Stable across zooms.
_Avoid_: normalized space

**FOV translation space**:
The normalized `[-1, 1]` coordinate system mapped to the current visible field of view. Zoom-dependent — but in this project, the cameras do not support zoom, so FOV space is fixed for the life of a unit.
_Avoid_: field-of-view space

**Translation**:
A relative move expressed in a translation space. Distinct from a translation *space* (the coordinate system).

**FOV-to-generic translation**:
The proxy's act of converting an incoming FOV-space relative move into an outgoing generic-space relative move. Pure unit conversion: `fov(x, y) → degrees(x·hfov, y·vfov) → generic(x/pan_mech, y/tilt_mech)`. Position-state-free by design — the output is a relative offset, not an absolute target, so the proxy does not need to know the camera's current generic-space position to translate.

**Calibration**:
The process by which the proxy obtains a camera's true HFOV and VFOV degrees for use in FOV-to-generic translation. In this project, calibration is a per-unit concern: spec-sheet values are the starting point, per-unit values override them.
_Avoid_: setup, configuration

**MoveStatus**:
The ONVIF-reported PTZ motor state, read by Frigate (and the proxy) via `GetStatus`. Valid values per the ONVIF spec are `IDLE` and `MOVING`; cameras may also return `UNKNOWN`. Frigate's autotracker requires the value to be in `{IDLE, MOVING}` — anything else triggers its "GetStatus unsupported" path and disables autotracking. Cameras that don't update `MoveStatus` reliably (the Hikvision-style firmware bug) are excluded from this design.

**PanTiltLimits**:
The mechanical pan and tilt range of a PTZ node, expressed in degrees via `GetConfiguration`. Distinct from translation-space limits, which are always `[-1, 1]`.

**Position**:
The camera's current pan/tilt location, read from `GetStatus.Position.PanTilt`. Reported in `PositionGenericSpace` (a third coordinate system that maps to the same mechanical range as `TranslationGenericSpace`).

**Translation-space equivalence (camera-specific quirk)**:
Some PTZ cameras accept a `RelativeMove` whose `Translation.PanTilt@space` is set to a translation space they do not advertise (e.g., they advertise `TranslationGenericSpace` only, but silently accept `TranslationSpaceFov` and interpret the values identically). Without translation, this leads to oversized moves — the FOV (0.1, 0) move that Frigate means as "10% of the visible frame" gets executed as "10% of the mechanical range."

**Speed slow path (camera-specific quirk)**:
The target cameras ignore the value of a `RelativeMove` `Speed` element but move ~2.5x slower whenever it is present at all (measured on the live unit: 0.15 generic pan in ~1.3 s without `Speed`, ~3.2 s with any `Speed`, including `PanTilt=1.0` which is what Frigate always sends). Omitting `Speed` makes the camera use its own `DefaultPTZSpeed`, which is already maxed. The proxy therefore strips `Speed` from every translated FOV move.

**Zero-move fault (camera-specific quirk)**:
The target cameras reject a zero-magnitude `RelativeMove` — even in generic space, direct to the camera — with HTTP 400 and a `Sender / ter:InvalidArgVal` SOAP fault carrying no Reason text (zeep surfaces it as `Fault: None`). Frigate's `calibrate_on_startup` sweep begins at exactly (0, 0), so the fault crashes Frigate at boot. A move whose pan/tilt serialize to zero and which carries no `Zoom` translation is a physical no-op, so the proxy answers translated zero-magnitude FOV moves with a locally built `RelativeMoveResponse` instead of forwarding them; every other body keeps the pass-through posture.

**Pass-through error semantics**:
The proxy returns upstream camera responses and errors to Frigate verbatim, including HTTP status codes and SOAP faults. The proxy is operationally indistinguishable from a flaky camera in Frigate's logs — by design. Network-level unreachability to the upstream camera surfaces as HTTP 502 from the proxy.

**Move types the proxy intercepts**:
- `GetConfigurationOptions` — advertise `TranslationSpaceFov` as an additional `RelativePanTiltTranslationSpace` entry. The schema declares it a repeated element (`tt:Space2DDescription`) with `URI`/`XRange`/`YRange` as direct children, so the entry must be a sibling element, not a nested wrapper — wrappers are outside the content model and invisible to schema-driven clients like zeep.
- `RelativeMove` whose `Translation.PanTilt@space` is FOV — translate to generic space, strip `Speed` (see the speed slow-path quirk), and forward upstream. A translated move whose pan/tilt serialize to zero with no `Zoom` translation is answered locally with an empty `RelativeMoveResponse` — the camera faults no-op moves (see the zero-move fault quirk). The injected FOV space uses `XRange = YRange = [-1, 1]` so Frigate's internal `[-1, 1]` move arrives at the proxy unmodified.

All other ONVIF calls (every method outside the two above) are forwarded verbatim.

**Observability surface**:
The proxy logs PTZ-relevant events (inbound FOV-relative moves and their translated outgoing equivalents, upstream SOAP faults, proxy-level errors, startup config) and skips routine forwarding (`GetStatus` polls, warm-path capability/profile queries). Full-packet capture via `tcpdump` is the escape hatch for one-shot diagnosis.

**Camera binding**:
The per-camera state the proxy holds at startup: HFOV degrees, VFOV degrees, mechanical pan range (degrees), mechanical tilt range (degrees), and the upstream camera's host/port. Held in static config; never mutated at runtime in this design. Credentials are not part of it (ADR-0008).
_Avoid_: camera profile (conflicts with ONVIF media profile), camera config

**ONVIF port**:
The TCP port on which the camera exposes ONVIF SOAP. Standard is 80, but firmware revisions vary — in this deployment, all supported cameras are reachable on a non-standard port (`<PORT>`). Use `<PORT>` for the proxy→camera leg for consistency.

**Camera credentials**:
The upstream camera's WS-UsernameToken (username + password). The proxy holds none (ADR-0008): the credentials are supplied by Frigate inside each SOAP request's `<wsse:Security>` header and relayed verbatim into the outbound envelope. In this deployment they live only in Frigate's own camera config.
_Avoid_: proxy credentials (the proxy has none), admin password (too narrow), auth token (this is a UsernameToken digest, not a bearer token)

**Credential relay**:
The proxy's act of extracting Frigate's inbound `<wsse:Security>` element and re-embedding it byte-for-byte in the fresh envelope forwarded upstream. A PasswordDigest signs only nonce + created + password, never the body, so it survives the move; the proxy never learns — or can log — the password itself. A request with no header is relayed unauthenticated and the camera's fault answers (ADR-0005 posture).
_Avoid_: re-signing, re-authenticating (nothing is computed — the token is passed through)

**Health endpoint**:
`GET /health` — a locally answered `200 ok` from the proxy listener, never forwarded upstream and never logged. ONVIF exchanges are always SOAP POSTs, so an exact GET path cannot collide with camera traffic. Gates the Docker Compose health check (and thus Frigate's `depends_on` startup ordering); asserts the listener is up, not camera reachability.
_Avoid_: liveness probe (generic k8s term), readiness check (the check gates startup ordering, not traffic readiness)