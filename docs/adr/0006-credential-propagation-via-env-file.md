# Camera credentials propagate via per-instance `.env` + Compose `env_file:`

> **Partially superseded by ADR-0008.** The credential story below (proxy-held
> `UPSTREAM_USER`/`UPSTREAM_PASSWORD` injected via env) is withdrawn: camera
> credentials now arrive with each client request and are relayed. The rest
> of this ADR stands — per-instance `.env` files, `env_file:` wiring, and
> fail-loudly validation of the non-credential bindings (host, ports, FOV
> overrides) — and ADR-0008's "no secret in the deployment" outcome makes
> those files strictly simpler.

The proxy's upstream-camera credentials live in per-instance `.env` files alongside `docker-compose.yml`. Each Compose service references its file via the `env_file:` directive; each key becomes an env var inside the container at process start. The proxy reads `process.env.UPSTREAM_PASSWORD` (and the other binding fields) at startup, holds the value in memory only, and uses it to construct WS-UsernameToken for outbound SOAP. The password never appears in source, in the image, or in `docker-compose.yml`.

## Considered Options

- **Compose-level `.env` substitution (`${VAR}` in the YAML).** Rejected: it interpolates strings into the compose file, it does not expose env vars inside the container. Wrong tool for the job.
- **Docker `secrets:` directive.** Rejected: Swarm-oriented, mounts as files at `/run/secrets/`, requires the proxy to read from a filesystem path rather than `process.env`. More plumbing than a single-host Compose deployment needs, and the file-mount semantics couple the proxy's auth helper to a path layout.
- **Bind-mounted secret file (operator-controlled path).** Rejected: requires a host path to exist before `docker compose up`; fragile across hosts; couples the proxy to a host directory layout rather than to standard Compose config.

## Consequences

- One `.env` per proxy instance, one Compose service per camera. Adding a third supported camera later is "copy `.env`, edit, add a service" — no ADR revision needed.
- The binding loader reads `process.env` at startup. Startup is a clean place to validate presence and fail loudly if a required key is missing.
- The password value is held in memory only — never logged, never written to disk by the proxy, never reflected back to Frigate. The startup log line records the loaded binding (camera binding values, upstream host/port, log level) but never the password value.
- The proxy's listener does not require auth from Frigate. Frigate connects to the proxy's port over LAN and is trusted; the proxy's own SOAP calls upstream carry WS-UsernameToken with the loaded credential.