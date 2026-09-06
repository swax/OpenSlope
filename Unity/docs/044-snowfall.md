# 044 — Ambient Snowfall (Unity port)

The original weather subsystem, enable semantics, camera-relative wrapping,
flake motion, sprite choice, and blend mode are specified in
[Trailmap: 400-rendering] and [Trailmap: 180-particles-data]. This document
covers the VRChat realization only.

Code:

- `VRC/Shaders/Snowfield.shader` — fall, drift, wrap, billboard, and fragment
  presentation;
- `VRC/World/SnowfallU.cs` — local on/off control;
- `VRC/Editor/SnowfallSetup.cs` — mesh/material creation and wiring; and
- `VRC/Editor/UdonTools.cs` — program-asset bootstrap.

## Shader-driven field

The port uses one static mesh of flake quads. Vertex attributes hold a base
point, quad corner, and per-flake random values; the shader derives motion from
time and the current camera. There is no Unity `ParticleSystem` and no per-frame
Udon simulation.

The mesh bounds span the course so normal frustum culling does not discard the
camera-relative field while the course is visible. The shader ignores the
object transform for placement, wraps each flake centre before expanding its
quad, and uses the centre-eye position so both stereo views choose the same
wrap cell. Edge and near-camera shrink bands hide recycling and prevent large
close-range flashes.

Billboards face the camera position with world up, avoiding head-roll in VR.
The project material uses a soft additive procedural dot so the port can run
without copying the source particle-bank sprite.

Mirrors and handheld or stream cameras naturally receive fields around their
own render viewpoints because the shader reads the active camera.

## Local control and deliberate policy

`SnowfallU` only toggles the `MeshRenderer`. It is sync-none and local to each
viewer. The Settings Board exposes the effect, and
`ImportConfig.BuildSnowfall` controls whether setup creates it.

The source enable rule does not live in the imported world geometry. Unity
therefore offers snowfall on every map by default and lets the player or map
author disable it. This is an explicit port policy; the canonical source rule
remains in [Trailmap: 400-rendering].

All field dimensions, density, drift, flake size, and fades are material
settings. `_Intensity` is a Unity presentation control, not a recovered level
field. Slopesmith exposes a broader authored weather dial over its own port;
see [Slopesmith docs/050](../../Slopesmith/docs/050-snowfall.md).

## Setup

`Setup All` invokes the snowfall setup when `BuildSnowfall` is enabled. The
manual path is `OpenSlope/Setup/Snowfall`, which creates
`OpenSlope_Map/Snowfall` and writes its generated mesh/material assets under
`Assets/OpenSlope/VRC/Materials/`.

Like other Udon setup steps, the first run in a fresh project may create and
compile the program asset; run the setup again to attach it. Re-run after
switching the imported map because the object lives under `OpenSlope_Map`.

## Verification

- Check the field in both eyes and while rolling the headset.
- Move across a wrap boundary and verify no visible pop or torn quad.
- Teleport and confirm the field recentres without retained CPU state.
- Toggle the Settings Board row and confirm it affects only the local viewer.
- Profile the draw and additive fill on the target Quest tier.

Any newly recovered source behavior belongs in Trailmap first. Keep only the
Unity consequence and divergence in this document.
