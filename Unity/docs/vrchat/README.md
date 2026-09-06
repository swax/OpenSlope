# VRChat runtime documentation

Implementation notes for the Unity 2022.3, VRChat SDK, and UdonSharp runtime. Feature pages document their
own verification status; historical or untested paths are retained only when they still explain shipped
wiring or constraints.

Numbers are stable identifiers within this directory. Gaps are intentional; other documentation trees may
reuse the same numbers.

## Riding and performance

- [017 — Rideable board](017-rideable-board.md)
- [020 — Surface physics](020-surface-physics.md)
- [022 — Rider stance and avatar fit](022-snowboard-stance.md)
- [024 — Free-standing trigger flight](024-player-flight.md) — built but not yet ride-tested.
- [025 — Performance](025-performance.md)
- [027 — World recenter](027-world-recenter.md)
- [030 — Carved wake](030-carved-wake.md)
- [032 — Snow spray](032-snow-spray.md)
- [033 — Snow sink](033-snow-sink.md)
- [035 — Rideable prop surfaces](035-rideable-prop-surfaces.md)

## Runtime wiring and multiplayer

- [013 — Udon components](013-udon-components.md)
- [041 — Video billboards](041-video-billboards.md)
- [042 — Multiplayer networking](042-multiplayer-networking.md)
- [043 — Multiplayer items and effects](043-multiplayer-items-and-effects.md)

## World UI and verification

- [046 — In-world performance controls](046-performance-board.md) — current control map plus the retired
  Performance Board history.
- [047 — Settings Board](047-settings-board.md)
- [048 — Players Board](048-players-board.md)
- [049 — Jukebox](049-jukebox.md)
- [055 — ClientSim autotest](055-clientsim-autotest.md)

Importer behavior and cross-layer features are indexed in the parent [Unity documentation](../README.md).
