# 110 — Terrain

The course surface is not a triangle mesh. Terrain is a quilt of **bicubic
Bézier patches**: the level data stores control points and per-patch
attributes, and the surface itself is evaluated parametrically at runtime.
There is consequently **no canonical triangle count** — any tessellation
density that follows the curve faithfully reproduces the game's terrain, and
both rendering and physics can (and should) work from the continuous surface
rather than from any particular triangulation. [[110-patch-model]]()

This chapter defines the logical terrain model. The on-disc encoding is
specified in `220-level-pbd.md`; what each surface type *does* is specified in
`310-surface-response.md` (physics) and `420-audio-runtime.md` (audio); the
lightmap pages a patch references are specified in `160-lighting-data.md`; how
the original renderer tessellates is described in `400-rendering.md`.

> [[110-patch-model]]() db:terrain-render; db:terrain-collision;
> map:"Terrain rendering". The on-disc record stores the 16 points as
> bicubic **power-basis (monomial) coefficient** vectors — confirmed: the
> collision Newton solver consumes them directly with [u³,u²,u,1]-style
> bases — convertible 1:1 to Bézier control points,
> doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Utilities/BezierUtil.cs
> (GenerateRawPoints / GenerateProcessedPoints); patch record = struct
> Patch in
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> (16 × Vector4 R4C4…R1C1, plus UVPoint1–4, LightMapPoint,
> Lowest/HighestXYZ, Point1–4 corner cache, SurfaceType, PatchVisablity,
> TextureAssigment, LightmapID).

## The patch

A patch is a **4×4 grid of 16 control points** in world space (centimeters,
see `002-conventions.md`). The surface over the unit square
(u, v) ∈ [0, 1]² is the standard tensor-product cubic Bézier:

```
P(u,v) = Σᵢ₌₀..₃ Σⱼ₌₀..₃ Bᵢ(u) · Bⱼ(v) · Pᵢⱼ
```

with the cubic Bernstein basis
`B₀(t)=(1−t)³, B₁(t)=3t(1−t)², B₂(t)=3t²(1−t), B₃(t)=t³`. Evaluation as four
row curves then one column curve (or vice versa) gives the same result.

The **exact surface normal** is the normalized cross product of the two
parametric tangents, `N(u,v) = normalize(∂P/∂u × ∂P/∂v)` (winding chosen so
terrain normals point skyward). Rendering and contact each resolve against
the curved surface independently, and terrain contact is **exact**. The
**candidate patches** for a contact query are not searched exhaustively: the
query point maps to its cell in the level's **world spatial grid** (the broad
phase, `160-lighting-data.md`), and only the patches that cell lists are
tested. Within each candidate patch a line query is first bracketed by a
coarse fixed subdivision of the patch, then refined on the true bicubic with a
few Newton steps using the analytic partial derivatives (rejected back to the
bracket result if the parameter leaves the patch), and the query returns the
refined hit point together with the exact analytic normal at the refined
(u, v). [measured] Contact normals
therefore vary smoothly along the curve regardless of any render
tessellation — implementations that instead derive contact from a fixed
coarse triangulation give the rider facet-rate heading kicks while
carving. [[110-analytic-normal]]()

Each patch also carries an axis-aligned bounding box (min/max corner) usable
for culling and contact queries; it is derivable from the control points.

> [[110-analytic-normal]]() db:terrain-collision;
> map:"Terrain collision" — candidate patches from the world-grid broadphase
> (`WorldIntersect_QueryNearest` via @0x00128bc8, world singleton @0x00347688,
> grid data model spec:160-grid) before the per-patch bracket+refine:
> WorldPatch_IntersectLineCandidate @0x0025ccf8
> (9×9 bracket; facet cross-product only under the cached-normal 1e10
> sentinel) → vtable+0x54 WorldPatch_NewtonRefineHit @0x0025e480: ≤4 Newton
> iterations, J=[Pu,Pv,−lineDir], u,v∈[0,1] guard, exit computes
> normalize(Pu×Pv) via VU0 cross + rsqrt. Render path separate,
> db:terrain-render. Failure mode verified empirically in the port:
> contact normals raycast from a fixed 4×4-per-patch triangulation gave
> visible per-facet heading kicks while carving; the analytic normal
> removed them at unchanged triangle count.

## Per-patch attributes

| Attribute | Type | Meaning |
|---|---|---|
| Control points | 16 × position | The bicubic grid above. |
| Surface type | small integer | Selects all per-surface behavior (see below). |
| Texture | reference | Diffuse texture for the patch. |
| Texture UVs | 4 × (u, v) | Corner texture coordinates, interpolated bilinearly across the parametric square. |
| Lightmap reference | page id + tile rect | An 8×8-texel tile inside one of the level's lightmap pages (`160-lighting-data.md`). |
| Visibility / trick-only | integer | Negative values mark "trick-only" patches. |
| Bounding box | min/max corner | Derivable; stored for convenience. |

**Texture UV orientation.** Each stored UV corner pairs **index-for-index**
with the patch's geometry corner of the same index (`UVPoint_i` ↔ `Point_i`):
with parametric corners uvA@(0,0), uvB@(0,1), uvC@(1,0), uvD@(1,1) the binding
is uvA=UVPoint1, uvB=UVPoint3, uvC=UVPoint2, uvD=UVPoint4 — a **transpose** of
the same-index order. Directional decals (the boost chevrons, which must point
parallel and downhill) are the practical test. [[110-uv-rotation]]()

**Tile layout.** The four UV corners almost always describe **one full tile
per patch**, so texture density follows patch density. Most levels store the
tile **inset by 0.008 per side** (corners at 0.008/0.992 rather than 0/1),
which keeps bilinear + wrap sampling from bleeding the tile's opposite edge
across the patch seam; a minority of patches instead rotate/mirror the tile,
repeat it across one patch (2–3 tile spans), or crop into it. Every shipped
layout is an axis-aligned rectangle composed with a square symmetry — nothing
sheared. [[110-uv-inset]]()

**Lightmap tile orientation** uses its own, different convention from the
texture UVs above — specified in `160-lighting-data.md`.
[[110-lightmap-tile]]()

**Trick-only patches** exist as a flag separate from the surface type
(example level: 60 of them); they mark surfaces intended for trick scoring
rather than a distinct physical material. [inferred — the flag and its name
are data facts; the precise gameplay effect is not yet pinned
down] [[110-trick-only]]()

> [[110-uv-rotation]]() doc:../research/extracted-data.md "Terrain
> patch orientation and seam conventions" — `UVPoint_i` pairs index-for-index
> with geometry corner `Point_i` (a transpose of the same-index order),
> established from the raw gari.pbd's parallel corner/UV storage and confirmed
> in-world; snowknife `TerrainBundle.cs` binds uvA=c0,uvB=c2,uvC=c1,uvD=c3. The
> boost-chevron decals are the practical compass (correctly bound they point
> parallel, downhill).

> [[110-uv-inset]]() doc:../research/extracted-data.md "Terrain
> patch orientation and seam conventions" — census across the five extracted
> levels (14,985 patches): the 0.008/side inset (span 0.984) is exact on
> ELYSIUM 4,200/4,268, MESA 2,197/2,448, MERQUER 2,183/2,731; GARI is the
> outlier (3,715/3,885 exact-unit), SNOW between (172 insets ~0.993). 13
> distinct layouts total, all axis-aligned rect × D4.

> [[110-lightmap-tile]]() doc:../research/extracted-data.md "Terrain
> patch orientation and seam conventions" — 8-symmetry boundary-mismatch
> scoring on GARI; transpose 0.025 vs rot90 0.121 (~5×), and only
> transpose is smooth along both axes.

> [[110-trick-only]]() PatchVisablity < 0 ⇒ TrickOnlyPatch in the
> community decoder (TrickyLevelInterface.cs); GARI count
> doc:../research/extracted-data.md.

## Surface types

Every patch carries a surface type that drives friction, sink, spray, wake,
sounds, and reset behavior. The full observed enumeration: [[110-surface-types]]()

| Type | Label [observed] |
|---:|---|
| 0 | reset / out of bounds |
| 1 | standard snow |
| 2 | standard off-track |
| 3 | powder snow |
| 4 | slow powder snow |
| 5 | ice |
| 6 | bounce / unrideable |
| 7 | ice/water, no trail |
| 8 | glidy (heavy snow particles) |
| 9 | rock / off track |
| 10 | wall |
| 11 | no trail, ice-crunch sound |
| 12 | no sound, no trail, small wake |
| 13 | off-track metal (slow, grinding sound, sparks) |
| 14 | speed, grinding sound |
| 15 | standard |
| 16 | sand |
| 17 | no collision |
| 18 | show-off ramp / metal |

Notes:

- **Type 0 (reset)** triggers the out-of-bounds respawn when ridden onto
  (`390-pickups-and-race.md`).
- **Type 17 (no collision)** renders but takes no part in contact queries.
- A level uses a subset. Example distribution (Garibaldi, 3,885 patches
  total): snow 650, powder 1,321, slow powder 390, ice 258, rock 540,
  wall 38, reset 622, no-collision 6, ramp/metal 60. [measured]
  [[110-gari-counts]]()
- The per-type physical response constants are a separate, single
  **global, engine-authored** table (one table for all levels, not shipped
  in level files), specified in `310-surface-response.md`.

> [[110-surface-types]]() db:surface-types; legend = the community
> decoder's patch-record comment,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> (struct Patch); labels corroborated by the per-type audio-group map and
> material table, db:surface-table.

> [[110-gari-counts]]() doc:../research/extracted-data.md "Terrain
> surface labels" (counts read from GARI Patches.json).

## Continuity and seams

Adjacent patches abut edge-to-edge; boundary control points of neighbors
coincide, so the quilt is watertight (position-continuous). Tangent
continuity across boundaries is common but not guaranteed — implementations
should weld coincident boundary vertices (within a small epsilon) rather than
assume exact bitwise equality, and must not require C¹
continuity. [observed] [[110-seams]]()

> [[110-seams]]() doc:../research/extracted-data.md "Terrain patch
> orientation and seam conventions" — boundary points are near-equal, not
> bitwise equal; epsilon weld required in practice.

## Rendering note

The original game renders this surface by **adaptive runtime tessellation** —
subdivision density rises as patches approach the camera, so nearby terrain
is visibly curved, not faceted. Density is an implementation choice; the
behavioral requirements (chord error small relative to the ~7 cm board
thickness near the rider, analytic normals regardless of density) and the
original's observed LOD scheme are specified in
`400-rendering.md`. [[110-adaptive-tess]]()

> [[110-adaptive-tess]]() db:terrain-render; map:"Terrain
> rendering" — cPS2BezierMan @0x001da180; per-edge LOD 4/6/8 by distance
> thresholds 3000/15000, 8×8 ≈ 98 tris/patch near. The chord-error bound
> comes from the poke-through analysis there: a fixed 4×4 grid (~7 m
> facets) sags 6–12 cm mid-facet ≈ the deck's own 7 cm, so the terrain
> visibly pierced the board; the original's near-camera density keeps sag
> well under that.
