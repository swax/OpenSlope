# 007 — Terrain lighting

This page documents the portable terrain-lighting assets and their Unity
shader realization. Canonical SSX lightmap storage, tile addressing, GS blend
equation, normalization, color domain, and UV orientation live in
[Trailmap: 160-lighting-data, 400-rendering]. Object lighting is separate; see
[010 object lighting](010-object-lighting.md).

## Bundle contract

`Snowknife/Export/LightmapExporter.cs` preserves the raw RGBA maps.
`Snowknife/Bundle/TerrainBundle.cs` writes:

- `LightmapAtlas.png`, the lossless raw-term atlas consumed by Unity;
- UV1 coordinates in `terrain.glb` for each tessellated patch vertex; and
- `LightmapMultiply.png`, a conventional colored-multiply approximation for
  interchange tools that cannot evaluate the original blend.

Atlas dimensions, tile remapping, shader scale factors, and the distinction
between raw and multiply atlases are part of the Trail Map contract. Unity
must consume the manifest record instead of independently deriving them.

## Unity import and shader

`Importer/Editor/TerrainBuilder.cs` loads the atlas and the glTF UV1 stream; it
does not repack source lightmaps. Terrain materials select
`VRC/Shaders/Unlit.shader`'s `_LIGHTMAP_GS` path.

The shader samples the diffuse texture and raw atlas and evaluates the
canonical blend in the specified display-color domain. In Linear projects it
performs explicit gamma conversion around that operation. The legacy vertex-
color `_LIGHTMAP` path remains a fallback but is not the parity path.

Because lighting is sampled per pixel, `TerrainRes` is a geometry and collision
choice rather than a lightmap-resolution control.

## Diagnostics

- Override diffuse input with white through a `MaterialPropertyBlock` to
  inspect atlas continuity without altering shared materials.
- Score world-coincident patch-edge samples when diagnosing an atlas UV
  regression; do not tune orientation by eye.
- Compare representative bright snow, colored shade, and dark textured rock
  in both Gamma and Linear projects.
- Confirm `terrain.glb` contains UV1 and the importer selects the raw atlas,
  while interchange exports point to the multiply atlas.
