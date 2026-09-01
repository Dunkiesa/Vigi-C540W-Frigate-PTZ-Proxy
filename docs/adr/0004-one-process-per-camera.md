# One proxy process per camera

> **Amended by ADR-0008 on one point:** the per-camera state listed below
> no longer includes upstream credentials — the proxy holds none; they
> arrive with each Frigate request and are relayed. The one-process-per-
> camera shape itself stands.

Two cameras are supported for autotracking (a third unit was excluded); the proxy holds per-camera state (HFOV/VFOV, mechanical ranges, upstream credentials, cached `GetConfiguration`). Each camera is bound to its own proxy instance. Identical process image, per-instance config — two Docker containers from one image, two `.env` entries, two `docker-compose.yml` services.

## Considered Options

- **Single multi-camera proxy process.** One process listens, is configured with N upstream cameras, routes requests by Frigate's selected ProfileToken. Rejected: routing logic and per-camera state live in one process; a crash or bug takes down every camera at once.
- **One process per camera with a shared central config store.** Deferred — revisit if cameras are added/removed frequently enough that per-instance config drift becomes painful.

## Consequences

- Operational model: `docker compose up` brings up two proxies. Per-proxy logs (via journald) are naturally separated by container, which helps when diagnosing one misbehaving camera.
- Config edits are per-camera: changing one unit's HFOV override touches only its container, not the other.
- Adding a third supported camera later (after the excluded unit is fixed or replaced) is a config-only change — no ADR revision needed.