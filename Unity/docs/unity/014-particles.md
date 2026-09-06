# 014 — Placed particle clouds

This page documents the Unity billboard realization of portable placed-particle
clusters. Canonical SSX particle instance/model layout, radius interpretation,
shared sprite banks, brightness decode, sprite selection, and renderer blend
rules live in [Trailmap: 180-particles-data, 400-rendering]. Scripted emitters
use the shared P6 path described by their feature pages.

## Bundle contract

Snowknife joins placements to particle models by the explicit model index and
writes `manifest.Particles`. Each record contains the transformed puff centers,
authored radius, and resolved sprite choice. Name matching is retained only as
a compatibility fallback for hand-authored legacy JSON.

Shared particle-bank images are decoded to `Textures/Particles` and referenced
by semantic name. Slopesmith exports stage the assets required by authored fog
volumes, so Unity does not need to infer a bank index from a model name.

For non-unit authored instance scale, the portable pipeline transforms centers
per axis and uses the largest absolute axis for the spherical puff radius. That
is an OpenSlope authoring convention, not a recovered native rule.

## Unity construction

The importer creates one object per placement under `Particles`, with a mesh
containing one four-vertex quad per puff. Quad corners share a center position;
their view-plane offsets are stored in UV1. `OpenSlope/Particle` expands those
offsets in view space, making the puffs camera-facing in normal views, mirrors,
and probes without a runtime script.

Meshes are stored as sub-assets of `Particles.mesh` and materials are shared by
sprite. The shader is unlit, fog-aware, transparent, and does not write depth.
Placed fog currently uses alpha blending as an explicit visual approximation;
it does not redefine the canonical renderer modes specified in Trail Map.

## Configuration

`BuildParticles` enables the feature. `ParticleSprite` is the missing-sprite
fallback. `ParticleSizeScale`, `ParticleTint`, and `ParticleAlpha` are Unity
presentation controls and should not be copied into the SSX specification.

The optional radius-relative near fade is a Quest fill-rate control. At the
inner threshold the vertex shader collapses a fully transparent quad so it
generates no fragments; merely reducing alpha would retain the blend cost.
`_NearFade = 0` disables the feature and is the parity-safe default while its
visual curve remains project-tuned.

## Verification and gaps

- Compare manifest placement/puff counts with generated objects and meshes.
- Test billboarding in stereo, mirrors, probes, and beneath the transformed
  level root.
- Check missing-sprite fallback and shared material/sub-asset reuse.
- Profile overdraw from inside dense banks; triangle count is not the useful
  metric for this feature.
- Verify scene fog affects distant puffs without altering near clouds.
- Per-level tint and any animated cluster drift remain implementation work.

See [005 materials](005-materials-and-alpha.md),
[008 texture animation](../008-texture-animation.md), and
[019 fireworks](../019-fireworks.md).
