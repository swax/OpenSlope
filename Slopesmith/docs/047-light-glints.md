# 047 — Light glints (Slopesmith port)

The original light-record gate, colour treatment, size classes, projection,
range, and occlusion behavior are specified in
[Trailmap: 160-lighting-data]. This document records how Slopesmith previews
those records and authors compatible ones.

## Implementation

The port has two layers:

- `core/lighting/glints.ts` converts a `LightRig` into renderer-ready glints.
  Authored and loaded-reference rigs use the same path; and
- `app/viewport/scene/glints.ts` draws an instanced camera-facing quad set for
  the active rig.

`GLINT_LAW` holds Slopesmith's renderer tuning. The viewport uploads one cloud
for the authored world and one for the loaded reference so comparison offsets
carry their own lights. Desktop refreshes the viewport-height input; WebXR also
supplies the shared cyclopean projection used by the port's stereo-stable bloom.

The layer prefers the extracted `PARTICLE.SSH` lens atlas through
`/api/particle-texture`. When that asset is unavailable, the shader uses a
project-owned procedural radial fallback. This asset fallback is an
implementation policy, not a second definition of the source sprite.

Depth testing provides the current Slopesmith occlusion. Source-visibility
fading is not yet implemented; that gap is tracked below.

## Authoring

A free light from [013 — Lights and Sound Sources](013-lights.md) exposes a
glint class in its inspector. The selected class is written to the exported
light record's `SpriteRes`; downstream import and repack therefore consume the
same authored field rather than a Slopesmith-only sidecar.

Glints follow `Lighting ▸ Local lights`, not the Sources rigging overlay. A
loaded reference follows the same visibility rule. Selecting or copying a
reference light never changes the authored rig without an explicit authoring
action.

## Verification

- `rigGlints` tests should cover accepted/ignored classes, colour conversion,
  and authored/reference parity.
- Inspect desktop and stereo views for stable billboard placement.
- Verify a missing particle bank selects the procedural fallback cleanly.
- Export an authored class and confirm it survives the portable light record
  and downstream bundle.

Compare any fidelity result to [Trailmap: 160-lighting-data]. If the original
behavior is found to differ, update Trailmap first and then change this port.

## Remaining work

- Add source-visibility fading against terrain and prop occluders. The current
  depth-tested quad can clip rather than fade at an edge.
- Add a reference-light filter/count for glint-capable records.
- Expose the glint class on lights nested inside authored groups.

The Unity sibling is [Unity: 045-flares].
