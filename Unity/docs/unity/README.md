# Engine-neutral Unity importer documentation

Implementation notes for the shared Unity importer and built-in-render-pipeline presentation. These pages
describe how portable map data becomes Unity geometry, materials, lighting, particles, and neutral runtime
markers before VRChat or Basis wiring is applied.

Numbers are stable identifiers within this directory. Gaps are intentional; other documentation trees may
reuse the same numbers.

- [002 — Terrain geometry](002-terrain-geometry.md)
- [003 — Props](003-props.md)
- [004 — Orientation and world scale](004-orientation-and-scale.md)
- [005 — Materials and alpha](005-materials-and-alpha.md)
- [006 — Skybox](006-skybox.md)
- [007 — Terrain lighting](007-terrain-lighting.md)
- [010 — Object lighting](010-object-lighting.md)
- [014 — Placed particle clouds](014-particles.md)
- [045 — Colored flares and light glints](045-flares.md)
- [046 — Sun god-rays](046-sun-god-rays.md)
- [047 — Continuous emitters](047-continuous-emitters.md)
- [060 — Platform-neutral importer](060-platform-neutral-importer.md)

Cross-layer behavior is indexed in the parent [Unity documentation](../README.md). Platform realization is
documented separately for [VRChat](../vrchat/README.md) and [Basis](../basis/README.md).
