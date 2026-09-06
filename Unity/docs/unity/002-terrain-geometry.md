# 002 — Terrain geometry

This page documents the portable terrain bake and Unity import. Canonical SSX
patch layout, Bézier evaluation, UV binding, surface types, source-space
conventions, and adaptive rendering behavior live in [Trailmap: 110-terrain,
400-rendering]. Lighting is covered by [007 terrain lighting](007-terrain-lighting.md).

## Bundle contract

`Snowknife/Bundle/TerrainBundle.cs` consumes the source patches once and emits:

- `terrain.glb`, with a base `Terrain` node and optional render-only
  `TerrainHD` node;
- analytic normals and the data needed by smooth board contact;
- material UVs and lightmap atlas UVs;
- render submeshes grouped by texture; and
- collision groups partitioned by `SurfaceType`.

`TerrainRes` controls the base render and collision tessellation.
`TerrainResHd` controls the inactive, render-only high-density sibling.
`LightmapUvMode`, `MaxDivergence`, and `SmoothAngle` belong to the bake rather
than to Unity scene setup.

The bake applies the shared mesh-space handedness transform and matching face
winding described in [004 orientation](004-orientation-and-scale.md). Its
diffuse-UV seam inset is limited to exact unit tiles; repeated and cropped UV
ranges remain unchanged.

## Unity import

`Importer/Editor/TerrainBuilder.cs` loads the glTF nodes and lightmap atlas. It
does not re-evaluate source patches. The base node supplies all collision;
`TerrainHD` is imported inactive and has no automatic runtime switch.

Each surface partition receives the collider/tag policy described in
[009 collision](../009-collision.md). No-collision surfaces continue to render
without producing a collider. The root level transform converts mesh-space
geometry to Unity world space.

The rideable board evaluates the retained analytic patch representation for
contact height and normal, so collision tessellation density is not a board-
physics tuning control. See [021 analytic contact](../021-smooth-contact-normal.md).

## Diagnostics

- Use directional texture features to verify the diffuse-UV corner mapping.
- Check area-weighted world normals after the handedness conversion.
- Compare base/HD bounds and material slots; only density should differ.
- Confirm every collision child has the expected surface tag and that the HD
  node contributes no collider.
- Treat patches skipped for incomplete control-point data as an extraction
  error to investigate upstream.
