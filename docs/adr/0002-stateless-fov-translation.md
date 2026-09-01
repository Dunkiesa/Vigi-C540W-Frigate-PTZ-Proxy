# FOV-to-generic translation is stateless

A FOV-space `RelativeMove` is converted to a generic-space `RelativeMove` by pure unit conversion — `fov(x, y) → degrees(x·hfov, y·vfov) → generic(x/pan_mech, y/tilt_mech)` — and emitted upstream. The proxy holds no current-position state; the output is a relative offset, not an absolute target, so the conversion needs no position lookup. Empirically verified on a supported unit: a `(0.1, 0)` move in either space produces an identical `dx = 0.1001` change in `PositionGenericSpace`, but the camera's silent acceptance of FOV coordinates as generic means *without* translation, every Frigate move is oversized — `FOV(0.1, 0)` (intended as "10% of frame") becomes "10% of mechanical range."

## Considered Options

- **Position-aware translation to generic `AbsoluteMove`.** Rejected: requires polling `GetStatus.Position`, introduces a stale-position failure mode, and contradicts FOV's relative-offset semantics.
- **Bounded sanity checks against a polled position.** Rejected: same polling cost, plus a policy divergence surface between the proxy's view and the camera's view of where the camera is.

## Consequences

- The proxy cannot recover from a move whose visible effect was lost (e.g., a clipped mechanical-range move). It trusts the camera's own motion to match the issued translation.
- No position-state means no "where am I" debugging log line. MoveStatus is the only state surfaced (and it is forwarded verbatim, not maintained by the proxy).
- The injected `TranslationSpaceFov` advertises `XRange = YRange = [-1, 1]`. Frigate interpolates its internal `[-1, 1]` moves through this XRange via `numpy.interp` (`frigate/ptz/onvif.py:644-659`), so the values that arrive at the proxy's listener are also in `[-1, 1]`. The math above then applies directly without any further unit conversion at the proxy boundary. Choosing any other XRange would require the proxy to reverse Frigate's interpolation before applying the math.