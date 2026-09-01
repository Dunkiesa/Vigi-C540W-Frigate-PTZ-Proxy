# Vigi C540W Frigate PTZ Proxy

[![build](https://github.com/Dunkiesa/Vigi-C540W-Frigate-PTZ-Proxy/actions/workflows/build.yml/badge.svg)](https://github.com/Dunkiesa/Vigi-C540W-Frigate-PTZ-Proxy/actions/workflows/build.yml)

A tiny, dependency-free ONVIF PTZ proxy that makes TP-Link Vigi C540-W (v2)
autotracking *and* click-to-move work in
[Frigate](https://frigate.video/).

## About this project

**This codebase was predominantly written by AI coding agents** (Qwen 3.8 Max,
Qwen 3.8 Flash, and MiniMax M3, via
[opencode](https://opencode.ai/)), working from human-supplied requirements,
grilling sessions, and empirical measurements taken against real cameras.
Humans owned the architecture decisions — every one of them is recorded in
[`docs/adr/`](docs/adr) — chose the trade-offs, ran the live-camera
verification, and reviewed the code. AI handled the prose-to-spec-to-
implementation lifting and the test scaffolding. If you're evaluating this for
your own deployment, read the ADRs first: they tell you *why* it is the way it
is, which is the part the AI didn't decide.

## The problem

Frigate's autotracker only enables ONVIF autotracking if the camera's
`GetConfigurationOptions` response advertises the FOV relative translation
space (`RelativePanTiltTranslationSpace` with a `.../TranslationSpaceFov`
URI). The C540-W v2 advertises only the generic normalized space — and, worse,
it silently accepts FOV-space coordinates as generic ones instead of rejecting
them. A Frigate move of `(0.1, 0)` meaning
"10% of the frame" is applied as "10% of the mechanical range", overshooting
wildly.

## How the proxy fixes it

The proxy sits on the LAN between Frigate and the camera and answers the
camera's ONVIF endpoint. It makes exactly three rewrites and forwards
everything else verbatim:

| Direction | Request/response | What happens |
|---|---|---|
| response | `GetConfigurationOptions` | Injects the FOV translation-space entry so Frigate enables autotracking ([ADR-0001](docs/adr/0001-proxy-is-camera-shaped.md)) |
| request | `RelativeMove` in FOV space | Converts the pan/tilt vector to generic space using the camera's known field-of-view and mechanical ranges ([ADR-0002](docs/adr/0002-stateless-fov-translation.md), [ADR-0003](docs/adr/0003-static-fov-config-no-auto-measurement.md)); strips the `Speed` element the camera slow-paths on; answers zero-magnitude no-ops locally because the camera faults them |
| response | `GetCapabilities` | Re-points service XAddrs at the proxy so Frigate keeps calling through it |

Because the FOV translation space is what Frigate gates its **click-to-move**
feature on as well, click-to-move works through the proxy too — with or
without autotracking enabled for the camera.

Authentication is pass-through: the proxy **holds no camera credentials**.
Frigate's own WS-UsernameToken arrives inside each SOAP request and is relayed
verbatim to the camera ([ADR-0008](docs/adr/0008-client-supplied-credentials-relayed.md)),
so the only place your camera password lives is Frigate's config.

One proxy process per camera ([ADR-0004](docs/adr/0004-one-process-per-camera.md));
SOAP faults and error statuses pass through untouched
([ADR-0005](docs/adr/0005-pass-through-error-semantics.md)); per-camera
bindings arrive via env files ([ADR-0006](docs/adr/0006-credential-propagation-via-env-file.md),
[ADR-0007](docs/adr/0007-compose-deployment-shared-network.md)).
Runtime is the Node standard library only — no dependencies to audit.

## Requirements

- A TP-Link Vigi C540-W v2 (4 mm lens) camera. Other models *may* work if
  they share the same quirk, but the FOV/limits calibration is locked to this
  unit's spec sheet (override per unit via env if you've measured yours).
- Frigate with the camera's ONVIF integration configured — for autotracking,
  click-to-move, or both.
- Docker + Docker Compose (or any way to run `node src/index.js` per camera).

## Quick start (Docker Compose)

1. **Copy the per-camera bindings and edit them** — these files hold no
   secrets, only addressing and calibration:

   ```sh
   cp env/cam-1.env.example env/cam-1.env
   cp env/cam-2.env.example env/cam-2.env
   # edit UPSTREAM_HOST (camera LAN IP) and UPSTREAM_PORT (ONVIF port)
   ```

2. **Bring up the proxies** (image is published, or build locally with
   `npm run docker:build`):

   ```sh
   docker compose up -d
   ```

3. **Point Frigate at the proxies instead of the cameras.** On the shared
   Docker network (`frigate` by default) the proxy is reachable by container
   name, and your camera credentials go in the Frigate config (nowhere else):

   ```yaml
   cameras:
     cam-1:
     #  ONVIF host: proxy-cam-1, port: 8080, path: /onvif/service
   ```

4. Verify: `docker compose ps` should show each proxy `healthy`
   (`GET /health` answers locally), and Frigate's autotracker should stop
   faulting and start tracking.

## Configuration reference

Every variable below is **required at startup** — the proxy fails loudly
rather than fall back to a hardcoded default. See [`.env.example`](.env.example)
for the annotated template.

| Variable | Meaning |
|---|---|
| `UPSTREAM_HOST` / `UPSTREAM_PORT` | The real camera's ONVIF address |
| `LISTEN_PORT` | Port the proxy binds inside its container |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `HFOV_DEG`, `VFOV_DEG`, `PAN_MECH_DEG`, `TILT_MECH_DEG` | Optional per-unit calibration overrides; default to the C540-W v2 spec sheet |

## Development

```sh
npm install
npm test          # unit + integration (stub-camera, no real hardware needed)
npm run test:integration   # includes a Docker Compose smoke test when Docker is available
npm run typecheck # tsc over the JSDoc types — no build step
```

The integration tests boot the real HTTP listener against in-process stub
SOAP responders, so the whole suite runs on a laptop with no cameras
attached.

## Known limitations

- Only the **Vigi C540-W v2** is a supported unit (both supported cameras in
  this deployment are that exact model and hardware version). Autotracking
  relies on the v2's `MoveStatus` reporting `IDLE`/`MOVING` reliably; a
  **Vigi C540-W v1** consistently reports `UNKNOWN` instead, so autotracking
  does not work through the proxy on the v1 (it remains usable for live video
  and manual PTZ without this proxy). See the ADRs and `CONTEXT.md` in the
  repo for the domain glossary and findings.
- TLS/HTTPS to the camera is not implemented (LAN deployments only).
- The FOV calibration values are per-model; other cameras need measured
  overrides.

## License

MIT — see [LICENSE](LICENSE).
