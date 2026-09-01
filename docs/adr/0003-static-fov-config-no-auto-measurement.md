# HFOV/VFOV come from static config; the proxy never measures

ONVIF does not expose HFOV/VFOV on the wire. The proxy reads per-camera HFOV, VFOV, mechanical pan range, and mechanical tilt range from static config at startup. Locked spec-sheet values for this deployment (TP-Link Vigi C540-W v2, 4 mm lens): HFOV 80°, VFOV 43.2°, pan-mech 350°, tilt-mech 120°. Per-unit overrides live alongside each proxy instance's config and take precedence over the spec sheet. The proxy never measures — measurement is a one-time user workflow that produces a config value.

## Considered Options

- **Auto-measure at startup via feedback.** Rejected: requires the proxy to track generic-space position over time, which ADR-0002 forbids.
- **Integrate with Frigate's `calibrate_on_startup`.** Rejected: Frigate's calibration measures *move duration* (timing regression), not FOV — it solves a different problem. Reading `movement_weights` does not yield HFOV/VFOV.

## Consequences

- Honest limitation: per-unit drift is handled by per-unit overrides, written by the user after manual measurement. Quick-check method: place a measuring tape at a known distance from the camera, observe the visible width in the RTSP feed (VLC), apply `HFOV = 2·atan(W/2 / D)`.
- If autotracking visibly overshoots or undershoots, the spec is wrong for that unit — measure and override.