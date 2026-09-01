# Proxy presents the upstream camera's identity, not its own

Frigate's autotracker requires the camera to advertise `TranslationSpaceFov`; the camera does not. The proxy makes Frigate believe it does by forwarding `GetCapabilities`, `GetDeviceInformation`, and XAddrs verbatim from the upstream camera, then selectively injecting the FOV space into `GetConfigurationOptions`. Frigate is configured with the proxy's URL but sees an indistinguishable camera — the proxy is a transparent MITM with response injection, not a separate ONVIF device.

## Considered Options

- **Separate ONVIF device with own UUID, scopes, XAddrs.** Frigate would see the proxy as a distinct device. Rejected: every Frigate field that today keys off the camera (device logs, network captures, config keys) would have to be reconciled against two identities for no operational gain.
- **Hybrid — own `GetDeviceInformation` for ops/debug, forwarded capabilities.** Rejected: two truths to maintain; one of them would drift.