# 006 — Skybox

This page documents the Unity sky conversion. Canonical SSX sky geometry,
texture mapping, source-space orientation, and presentation behavior live in
[Trailmap: 220-level-pbd, 170-materials, 400-rendering].

## Input and bake

`Importer/Editor/SkyboxBaker.cs` consumes the portable sky geometry and
textures, temporarily places them on an isolated layer, and captures a cubemap
from their bounds center. The temporary camera, geometry, and materials are
removed after the cubemap and `Skybox/Cubemap` material are saved.

A sentinel clear color identifies directions not covered by the open backdrop.
With `AutoSkyFill`, the baker samples the first painted texel below each upper
edge and replaces sentinel pixels with their average. MSAA stays disabled for
that capture so edge pixels do not blend with the sentinel. Source textures are
clamped during the bake to avoid panel-edge wrap seams.

The saved cubemap format accounts for the project's Gamma or Linear color
space. In Linear projects the baker stores converted linear values in a UNorm
cubemap so the runtime shader sample reproduces the captured display color.

## Scene environment

The baker assigns `RenderSettings.skybox`, selects skybox ambient lighting, and
refreshes the environment. It derives an optional fog color from bright horizon
samples, while `SkyFillColor` and `FogColor` remain manual fallbacks.

Scene fog is disabled during cubemap capture so it is not baked into the sky.
Afterward, the unlit level shader opts into Unity fog for terrain and props.
`FogStartDistance` is static; when an object culler exists, the culler owns fog
end and keeps it aligned with the active PC/Quest range tier. This coupling and
all fog distances are OpenSlope presentation policy, not recovered SSX data.

Movers are excluded from the static culler. The Basis culler applies the same
local `RenderSettings` distances.

## Verification

- Ensure the cubemap contains only sky geometry and has no magenta sentinel.
- Check the upper fill and every panorama panel join for seams.
- Move across the course and confirm the sky has no parallax.
- Compare Game view in Gamma and Linear projects; do not rely on a UNorm asset
  thumbnail as the color reference.
- Confirm the preview camera uses `CameraClearFlags.Skybox`.
- Toggle cull tiers on PC and Quest and verify fog reaches full opacity at the
  active object range without changing the per-level fog enable/color.
