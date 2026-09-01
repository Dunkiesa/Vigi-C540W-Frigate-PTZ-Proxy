# Proxy deploys as Docker Compose services on a shared network with Frigate

The proxy runs as a Docker Compose service per supported camera, on the same Docker network as Frigate. Cameras are physical devices on the LAN, reachable from that network via the Docker host's interface. Compose publishes the proxy's in-container listen port to a unique host port per camera (`ports:` mapping), so Frigate can address each proxy by container name on the shared network while operators can also reach the proxy from the host for ad-hoc SOAP testing.

## Considered Options

- **Bare-metal or systemd service per camera.** Rejected: duplicates the per-instance state (`.env`, log destination, restart policy) across hosts; loses the single-image, per-instance-config property that ADR-0004 relies on for "add a third camera = config only."
- **One Compose service per camera but on separate Docker networks per camera.** Rejected: forces Frigate to know which proxy lives on which network, and breaks the "same network as Frigate" operational model. No operational gain.
- **`network_mode: host` for the proxy.** Rejected: removes the network isolation between containers, leaks the proxy's listener to every interface on the Docker host, and breaks the container-name-based addressing that Frigate uses on the shared network. The `ports:` mapping gives the same reachability without those costs.
- **Single service with `ports:` range, distinguished by path or header.** Rejected: a single process serving N cameras contradicts ADR-0004.

## Consequences

- One `docker-compose.yml` declares one service per supported camera (e.g., `proxy-cam-1`, `proxy-cam-2`), each with its own `env_file:` (ADR-0006), its own `ports:` mapping, and the same network as Frigate.
- The proxy's binding exposes an in-container `listen_port` (e.g., `8080`). Compose publishes that port to a unique host port per camera (`8001`, `8002`). The proxy code is identical across services; only the host-port mapping differs.
- Frigate is configured with each proxy's address — either the published host port (`http://docker-host:8001/onvif/service`) or the container name on the shared network (`http://proxy-cam-1:8080/onvif/service`). Both reach the same listener.
- Cameras are physical, not Dockerised. The proxy reaches them via `upstream_host` (the camera's LAN IP, e.g., `<IP>`) and `upstream_port` (`<PORT>` in this deployment), over the Docker host's LAN interface. The cameras being "on the same network" means the Docker host is on the cameras' VLAN, not that cameras are Docker containers.
- Adding a third supported camera later: add one service block to `docker-compose.yml`, add one `.env` file, no ADR revision. Restart Frigate only if its config references the new proxy.
- The compose file uses `${VAR:-default}` interpolation for non-secret deployment knobs only — the `env_file:` path, the published host port, and the shared network name — so the deployment smoke test can run the same shipped file against stub upstreams on spare ports. Nothing secret is ever interpolated into the YAML; since ADR-0008 there are no credentials in the deployment at all (camera credentials arrive with each Frigate request).