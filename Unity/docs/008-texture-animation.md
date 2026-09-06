# 008 — Texture Animation (Unity port)

Material frame lists, effect-driven playback, UV scrolling, crowd cells, and
their timing are specified in [Trailmap: 150-logic],
[Trailmap: 170-materials], and [Trailmap: 410-texture-animation]. This document
covers how the importer and VRChat runtime realize the portable outputs.

Code: `Importer/Editor/MaterialFactory.cs`, `Importer/Shaders/UvScroll.hlsl`,
`VRC/Shaders/Unlit.shader`, `VRC/World/FlipbookAnimator.cs`, and
`VRC/World/ButtonU.cs`.

## Portable inputs

Snowknife resolves source material/effect joins before Unity import and emits:

- material frame lists in `Materials.json`;
- free-running playback records in `Flip.json`;
- UV motion profiles in `Scroll.json`;
- replayed triggered-button frame/hold sequences; and
- crowd cell tags plus staged shared crowd frames.

A frame list alone does not cause Unity playback. Only a resolved free-running
record, triggered sequence, scroll profile, or crowd classification selects one
of the runtime paths below. The canonical distinction is defined in
[Trailmap: 410-texture-animation].

## Unity realization

### Free-running flipbooks

`MaterialFactory` flattens animated renderer slots into a `FlipbookMarker`.
`VrcWiring` realizes it as `FlipbookAnimator`, whose Udon runtime changes the
instanced material's `_MainTex`. Per-slot rates and dwell data come from the
portable records; Unity owns only material lifetime and scheduling.

Because this path requires Udon, a plain imported Scene view does not animate
it. Avoid creating per-renderer material instances until a slot actually needs
runtime ownership.

### Triggered button pulses

`ButtonU` points at the affected renderer and walks the pre-resolved frame/hold
sequence when its volume fires. It creates the material instance on first use
and schedules delayed events instead of running an idle `Update` on every
button. Networking follows the existing animation-trigger policy so observers
see the same pulse.

### UV scroll

The importer writes motion and cycle data onto the material. The shared shader
evaluates the profile from `_Time`, so scrolling works without a runtime
component and is visible in an upload. `ScrollSpeedScale` is a Unity conversion
setting, not a source-format definition.

### Crowd cells

`MaterialFactory.BuildCrowd` packs staged shared frames into a `Texture2DArray`.
All cells retain one material/submesh; cell identity travels in UV1 and the
shader chooses the current array slice. This preserves batching and requires no
Udon behavior.

The source placeholders are not the crowd art. Import must use the staged
shared crowd frames and the resolved cell tags rather than guessing from model
or texture names.

## Unity-specific constraints

- Material keywords must be set before the asset is written, or Unity may save
  a variant that never executes the intended shader path.
- Runtime flipbooks need instanced materials; shader-driven scroll/crowd paths
  should stay shared for batching.
- Texture-array imports must build both target compression variants used by the
  project.
- Triggered state changes and free-running animation must remain separate even
  though both consume frame lists.
- A bundle without the optional shared crowd asset should fail visibly or use
  the documented fallback, never reinterpret an unrelated level texture.

## Verification

- Import one asset for each of the four paths and one frame-list-only material
  that must remain at rest.
- Check UV scroll and crowd animation in Scene view and an uploaded world.
- Check flipbook and button behavior in ClientSim/VRChat, including material
  allocation and networking.
- Verify each crowd cell remains in the shared draw group.
- Compare rates, dwell, and state transitions to
  [Trailmap: 410-texture-animation] without copying those values here.

## Related implementation

[005 — Materials & Alpha](unity/005-materials-and-alpha.md) owns material
variants; [013 — Udon Components](vrchat/013-udon-components.md) owns marker
realization; [034 — Bundle Pipeline](../../Snowknife/docs/034-bundle-pipeline.md)
owns the conversion outputs.
