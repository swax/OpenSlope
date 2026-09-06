# 004 — Orientation & World Scale

This document covers Unity's mapping from the canonical raw SSX coordinate
system to Unity. Raw units, axes, and handedness are specified in
[Trailmap: 002-conventions]; this document owns only the importer transforms,
mesh winding consequences, and diagnostics.

Three operations perform the mapping to Unity (Y-up, metres): a root rotation,
a uniform root scale, and a per-vertex X mirror shared by the separately built
terrain and prop paths. Get any one wrong and the imported level is inverted,
mirrored, misaligned, or incorrectly scaled.

Code: `Importer/Editor/ImportConfig.cs` (`RootEuler`, `WorldScale`), the per-vertex `-x` in
`TerrainBuilder.Build`/`PropBuilder.Build`, and the reversed collider winding.

## TL;DR

| Knob (`ImportConfig`) | Value | Why |
|---|---|---|
| `RootEuler` | `(270, 0, 0)` = −90° about X | maps raw source Z to Unity Y |
| `WorldScale` | `0.01` | maps canonical engine centimetres to Unity metres |
| per-vertex X | `-x` | performs the handedness mirror and keeps the procedural terrain and OBJ-space props aligned |
| collider winding | reversed | the X-negate flips face normals down; rewind them up or the player falls through |

Rotation and scale live **on the root**, not baked into the meshes — so the exported OBJ/JSON stay
in raw SSX space (useful for overlaying props on terrain in Blender), and the Unity-specific
correction is one transform you can inspect. Do not infer or redefine the source
coordinate convention from these Unity transforms; use [Trailmap: 002-conventions].

## Our approach

The root `GameObject` (`OpenSlope_Map`) carries `eulerAngles = RootEuler` and
`localScale = WorldScale`. Everything — terrain, props, collision, probes, skybox geo — is parented
under it, so the whole level is corrected by that single node. Each mesh is built/parsed with its X
coordinate negated at the vertex level so the two independent build paths (procedural terrain from
`Patches.json`, OBJ-parsed props) end up in one consistent space.

## What we learned (the gotchas)

### 1. Verify the mapped result, not a single triangle

Compute the imported terrain's area-weighted world normal and require it to
point toward Unity +Y while preserving the course's downhill direction. A
single face is not a reliable orientation test on sloped terrain.

Use the canonical `0.01` conversion from [Trailmap: 002-conventions]. Do not
recalibrate the world from individual props or deliberately oversized
billboards.

### 2. Two separately-built meshes must share one space
Terrain is generated procedurally (so we can bake the lightmap — see [002](002-terrain-geometry.md) /
[007](007-terrain-lighting.md)); props are parsed from `Props.obj`. They only overlay correctly
because **both negate X**, matching the handedness flip Unity's OBJ importer applies. If only one did,
props would float mirror-imaged off the terrain.

### 3. Negating X breaks collider winding
Reversing a single axis flips triangle handedness, so the surface normals point **down**. That's
invisible under the `Cull Off` preview shader — but a `MeshCollider` with down-facing normals lets
the player capsule fall **through** the world (and downward raycasts miss it, because physics queries
skip back-faces). Fix: wind terrain faces up explicitly — `(a,e,c)` / `(a,b,e)` instead of the
obvious order. (Props inherit correct winding from the OBJ.)

### 4. There are two unrelated UV conventions — don't conflate them
Orientation bites once more at the texture level, from **two different UV sources**: the **diffuse
texture** UVs are the patch's stored `UVPoint_i`, bound index-for-index to the geometry corners — an
off-diagonal **transpose** of the bilerp corners, while the **lightmap tile** maps the patch's
parametric `(u,v)` onto its own tile rectangle with a separate **transpose** (`LightmapUvMode = 6`).
Both are transpose-flavoured, but they come from different sources and are computed independently — fixing one
does **not** fix the other. Details live in [002](002-terrain-geometry.md) and
[007](007-terrain-lighting.md).

## Diagnostics that worked

- **Area-weighted world normal → +Y** to verify upright.
- **Known-size import fixture** to verify the `0.01` scale without redefining
  the source-space contract.

## Note

`WorldScale` defaults to the canonical `0.01`. Changing it is an intentional
Unity presentation choice; it does not change the raw SSX unit convention.
