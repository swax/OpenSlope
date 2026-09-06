# 004 — Sculpt Mode (Terrain + Course)

Why Slopesmith has a second editor, what its data model is, and the staged path from here to
authoring SSX-class maps. The course grammar is [001](001-design.md)/[002](002-course-model.md);
the export contract both editors share is [003](003-export-contract.md).

Code: `src/core/doc/mountain.ts` (model, carve, brushes), `src/core/export/level.ts`
(`buildMountainLevel`), `src/app/main.ts` + `viewport.ts` (Sculpt GUI / interaction).

## What an original level actually is

Measured on the reference's extracted patches (corner/edge adjacency at 1 cm quantization, slope
sampled per patch):

- **One sheet.** 96% of the patches form a single edge-connected surface. The mountain is one
  continuous quilt, not a bundle of ribbon courses — the edge loops run straight from the ridable
  track into the surrounding hills (no seam or dart at the track boundary), i.e. hand-authored
  continuous topology, not a separate corridor ribbon stitched into a coarse master grid.
- **A quad mesh, mostly regular.** Most patch corners have grid valence 4, but ~15% are
  extraordinary (3, 5, 6, up to 8 patches meeting). The shape class is a general quad control mesh
  with a bicubic patch per quad. Measured across the reference levels, the 3/5-poles fall into two
  populations. A **geometry** minority (~¼–⅓ of interior poles) sits where the surface curves and
  obeys the quad-mesh law with ~0 violations: a **3-pole on positive Gaussian curvature** (a dome
  or bowl), a **5-pole on negative** (a saddle / branch / pass). A **flow** majority (~⅔–¾) sits on
  near-flat terrain, placed to change grid resolution or seat a rip — a finite resolution strip caps
  with a 5-pole at its mouth and a 3-pole at its tip. Note the discriminator is *Gaussian* curvature
  (synclastic dome-or-bowl vs saddle), **not** convex-vs-concave: a 3-pole serves convex domes and
  concave bowls alike, so mean-curvature sign does not separate the two valences.
- **Mostly a heightfield.** ~10% of patches have a near-vertical region somewhere (gully walls,
  cliffs, the cave); the rest is single-valued terrain.
- **Coarse.** Median patch edge ~28 m (max 141 m). Smoothness comes from the bicubic basis, not
  from density — a whole mountain is a few thousand patches.

A single spine+section ribbon (the course grammar) cannot reach that. The staged path:

| Stage | Adds | Reaches |
|---|---|---|
| **2a (this)** | vertex-grid mountain + sculpt brushes + carve lines | open terrain, branching courses (~90% of the reference's character) |
| 2b | local grid refinement under carves | tight features on coarse mountains |
| 3 | topology edits + extraordinary-corner patches | walls past vertical, caves — the full shape class |

## Data model: a quad mesh constrained to a heightfield

`MountainDoc` stores a `rows × cols` vertex grid (default 60×45 at 30 m — the reference's own patch
budget) as **full 3D positions**, deliberately not a 2D height array. Today every tool only
displaces Y, so the terrain is a heightfield *by constraint, not by representation* — stage 3's
walls and cave roofs are new edit operations on the same model, not a rewrite. This is the one
decision in 2a that exists purely to keep stage 3 additive.

Grid orientation: rows along +X, cols along +Z, so the quilt's u×v cross points down in editor
space — the same convention `mountain.ts` chooses for courses, which the bake's winding turns into
skyward normals (asserted by both smoke tests).

## Carve lines: the course as a modifier

> The shipping editor does not work this way. A mountain is its mesh, the course is a line through it, and the
> run's cross-section reaches the terrain through the one-shot **shape run into terrain** command rather than a
> derive-time mix — see [002 — Shaping the run into the terrain](002-course-model.md). The nondestructive carve
> below is the stage-2a grid model, kept because the reasoning about feature width against vertex spacing is
> what still decides how fine a channel the net can hold.


A carve line is a Catmull-Rom spine (same sampler as the course spine) with per-knot floor
`width` and a per-line lateral `blend`. It is **nondestructive**: stored as parameters, applied
at derive time after the sculpt —

```
base verts (sculpted)  ──▶  per-vertex carve mix  ──▶  SurfaceGrid  ──▶  Bessel-tangent patches
```

Inside the floor half-width the surface height *is* the spine's smooth elevation — the rideable
course floor survives any roughness the sculpt puts under it. From the floor edge the height
smoothsteps back to the base terrain over `blend` metres, which is what digs the natural gully
walls. Where the spine rides above the base terrain the same mix builds an embankment. Floor
cells (cell centre inside the floor width) take the line's SurfaceType (snow by default) over the
mountain's base surface (off-track), so the course reads on the map and in collision the way a
original course does.

**Branching is free.** Two carve lines on one grid just work — each vertex takes the strongest
carve influence, and where lines cross or merge the floors blend. The junction topology problem
that makes ribbon networks hard (watertight Y-junction patch layouts) never appears, because the
grid is the mountain, not the ribbon.

The first carve line doubles as the level's course: its spine exports as the Respawnable AIP path
(~15 m point spacing) and hosts the start gate, so the six-slot start field, StageArea alignment and
on-track OOB reset share the same authored origin.

**The density rule** (inherited from the Blender NURBS prototype, `Blender/openslope_terrain.py`): a
carved feature only survives patch fitting if the vertex spacing is at most about half the
feature's width. At the default 30 m spacing, carves narrower than ~60 m lose their flat floor —
which is why the default carve is 64 m wide and new lines default to `2 × spacing`. Stage 2b
(refinement under carves) is the real fix; until then, narrower carves want a denser grid.

## Sculpting

Brushes (`raise` / `lower` / `smooth` / `flatten`, bell falloff) edit the **base** verts only;
the carve re-applies on every rebuild, so sculpting can never break a carved floor. The brush
maps the derived preview hit back to its authored quad, then measures a bounded shortest path over
that connected control surface (patch edges + diagonals). Its radius therefore follows walls and
folds in 3D instead of projecting through XZ, and cannot jump to a disconnected surface stacked at
the same horizontal position. The hover ring aligns to the hit surface's tangent plane. Its falloff is
selectable: the original smooth bell, linear, sharp centre-weighted, or constant with a hard edge. Grab
captures that connected footprint on press and drags it in the camera-facing plane; its source positions and
weights stay frozen for the gesture so the surface does not crawl or accumulate frame-by-frame error.
Flatten offers three target planes: **height** preserves the original horizontal world-Y behavior,
**surface** uses the tangent plane at the exact hit, and **area** estimates a falloff-weighted plane from the
whole connected footprint. Surface and area therefore work on walls and overhangs as well as terrain floors.
The plane behavior defaults to **locked**: its position and normal are sampled on pointer-down, then every
footprint crossed during that stroke moves toward the same original plane—even after crossing onto another
surface. **Follow stroke** retains the locally adaptive behavior by resampling the target plane for each dab.
Sculpt is aware of the bicubic representation rather than treating the preview triangles as editable data.
Raise/Lower, Grab, and Push reshape the shared corner net while preserving authored handle/twist detail. Flatten
projects every effective boundary and interior control in the affected 16-point cages, so an apparently flat
patch cannot retain hidden off-plane curvature. Smooth relaxes corners from a frozen snapshot and fades
explicit handle/twist deviations back toward the automatic Ferguson cage.
The Sculpt panel groups operations into connected **Displace** (Raise/Lower), **Refine** (Smooth/Flatten),
and **Move** (Grab/Push) families, keeps size/falloff together, and shows only the selected tool's meaningful
settings. Falloff, displacement direction, flatten plane, and plane sampling use compact icon rows with
descriptive tooltips instead of dropdowns. Grab locks one connected footprint on press; Push resamples the
footprint continuously and projects each stroke segment onto the current surface tangent before moving its
control points. Keys `1`–`6` select Raise through Push; `[` / `]` resize the footprint.

## Export

`buildMountainLevel` feeds the derived grid through the same `quiltPatches` writer as a course:
identical Patches.json records, identical index-matched UV transpose binding, identical one-tile-per-patch
UVs ([003](003-export-contract.md)). Everything there applies unchanged — Sculpt mode is a second
producer of the same contract, not a second contract.

## Verification

`npm run smoke` runs the default mountain through the real bake and asserts the terrain
invariants. Current numbers: 59×44 cells = 2596 patches → 42,545 baked verts,
min terrain normal Y 0.911, collision split `TerrainCol_2` (off-track base) + `TerrainCol_1`
(carved snow floor), `manifest.Paths.Course` populated from the carve line.
