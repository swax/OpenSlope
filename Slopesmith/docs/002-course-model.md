# 002 — Course Model

How a `CourseDoc` (knots + parameters) becomes a watertight quilt of bicubic Bézier patches.
The design rationale is [001](001-design.md); what the result is serialized into is
[003 — Export Contract](003-export-contract.md).

Code: `src/core/math/spine.ts` (centerline), `src/core/doc/mountain.ts` (generation — `buildMeshFromCourse`/`seatCourse`), `src/core/math/bezier.ts`
(quilt + evaluation), `src/core/mesh/tessellation.ts` (viewport tessellation).

`Generate terrain from run` is a separate topology-general path. Every authored course knot creates a primary
random-height edge chain perpendicular to the course, with **width** meaning the full endpoint-to-endpoint edge
length (300 m by default). The first edge seeds a height profile; each following edge carries forward the previous
edge vertex-by-vertex, adds the course elevation change, then progressively replaces the inherited relative profile
with deterministic per-vertex variation (60% per primary edge at roughness 1). Thus neighbouring edges remain
related while distant top/bottom profiles decorrelate. Each later vertex also has a roughness-scaled random chance
(12% at roughness 1, capped at 35%) of a much larger positive or negative jump, seeding occasional hills and dips
held in a separate transient component that retains only 12% at the next primary edge, preventing sustained ridges.
The whole edge also receives a smaller mean-reverting elevation offset (45% retained) so the seated course varies
its rate of descent through pitches and benches instead of dropping uniformly. At tight turns, overlapping
authored-knot edges are narrowed around their fixed course-centre vertices instead of being discarded; only
synthetic runout edges are expendable. It then bridges the resulting rails with `applyLoft`. There is no generated floor and no concave/convex
profile. Edge width defaults to 400 m. Roughness defaults to 0.5 and ranges to 3 for extreme relief. Every generation dialog starts with a
fresh random numeric seed; re-entering a seed reproduces the same terrain. Both this generator and Bridge Builder
insert intermediate loft rails when a span between primary edges exceeds the target patch size (50 m by default).
The course sections are emitted as one giant bridge with connection curve 1, so its inserted loops follow
a continuous smooth path through every authored knot rail without the exaggerated overshoot that can fold a
patch past its neighbour. The bridge keeps one ribbon winding throughout: adjacent patches inherit the same
front-face direction through steep walls and overhangs instead of being independently forced skyward.
Generation finishes by selecting every generated control point and applying the standard Edit Smooth command
(automatic Bessel tangents, with positions unchanged), then seats a cloned course onto the final quilt so its
exported gates, paths and test-ride start follow the smoothed terrain.

Freshly generated terrain also receives a deterministic default surface pass. The outer patch ring is reset/OOB
(`SurfaceType 0`) and the next ring is slow off-track (`2`). Inside those safety bands, 45–65° patches are ice
(`5`) while terrain at 65° or steeper is rock (`9`), keeping rock for extreme faces, walls and overhangs. Gentler
patches whose centres lie within 75 m overhead of the course are snow (`1`), and the rest are powder (`3`). A
gentle far-field pocket at least 110 m from and 20 m below its nearest course point becomes slow powder (`4`).

`New mountain`, `Generate terrain from run`, and `New mountain from this course` all use this one dialog and
generator. Alongside edge width, roughness, target patch size and seed, the dialog exposes **height**: the
course's maxY − minY vertical extent. A shorter height trims the course at an interpolated downhill crossing;
a taller height extrapolates its final downhill direction. Reference lines are adjusted before their dense raw
points are resampled, so leaving the displayed reference height unchanged is a geometry-preserving no-op rather
than an accidental tail extension. A new mountain starts with a 1,500 m, ten-knot editable course and lofts it
immediately, through the one generator above — there is no separate corridor/carved/open-slope authoring path.

`New mountain` additionally picks a **terrain** shape. *Lofted course* is the starter above. *Blank — no
terrain* runs no generator at all: `blankMountain` returns a document with an empty mesh — zero vertices, zero
quads — carrying only its name, its spacing and a straight fall-line guide run (`straightCourse`) descending at
the chosen **slope**. Every surface is then drawn by hand with Edit ▸ create patch (`P`), which requires no
existing geometry: `resolvePlacementEndpoint` falls back to a screen-facing construction plane through the view
target, so the first patch has somewhere to land. The dialog hides edge width, roughness and seed, which only
shape a loft.

An empty mesh is not a special case — it is the substrate a model session already edits
(`createAuthoredModel`), and the consumers guard for it: `buildQuadMesh` accepts zero counts, `surfaceHeightAt`
returns `null`, `focusMountain` frames the origin, and `migrateMountain` passes an empty `vertices`/`quads`
pair straight through. Deletion guards the *last* patch rather than a doc with none, so points and free edges
stay deletable while a blank mountain has no quads yet.

The starter follows the retail course-profile convention measured from Gari: its start is fixed at the
high/max-X,max-Z corner of its horizontal box and its finish at the opposite low/min-X,min-Z corner. Interior
knots follow Gari's uneven X/Z and descent profile with small seed-driven variation, so the generation seed
reproduces both the starter line and its terrain. **Frame map** uses a course-facing isometric angle, preserving
that profile's start upper-right and finish lower-left orientation while showing the mountain's depth.

## Shaping the run into the terrain

Code: `src/core/doc/run-shaping.ts` (`crossHeight`, `shapeRunIntoTerrain`, `profileWarnings`), Scene ▸ Course ▸
**⌒ shape run into terrain** and the Selected-knot sliders.

A knot carries four numbers that describe a channel around the line: a floor of `width`, a quarter-pipe `wall`
at each floor edge, a `shoulder` past the wall tops, and a `bank` rolling the whole section. The run's own
`blend` says how many metres that channel takes to fade back into the hill it was cut into. **Shape run into
terrain** presses it in: every vertex the ribbon reaches moves to the profile's height, the blend band mixes
toward it, and the floor strip takes the run's surface.

It is a COMMAND, not a modifier. The mountain is its mesh (006) — nothing re-derives the channel behind you, so
sculpt, Edit and Paint all own the result afterwards, and pressing the button again re-asserts the profile over
whatever has happened since. Two consequences follow from that and are the whole behaviour worth knowing:

- **Heights only.** Vertices keep their XZ, so a floor spans exactly its authored width in plan and the pass
  cannot fold a patch sideways into its neighbour. A wall past vertical is Edit work, not a knot field.
- **Inside the reach the target is absolute; the blend band is not.** Re-running changes nothing on the floor
  or the wall crest, and draws the blend band a little further toward the ribbon each time. Locked patches
  (`quadLocked`) are honoured exactly as sculpt honours them, and the pass reports how many points they held.

The wall's lateral run equals its height, so a wall is a 45° face and a 30 m wall is a 30 m-wide berm. Which
sets up the one trap in the model, and the reason `profileWarnings` exists at all: **bank rolls the walls with
the floor.** Bank far enough and the downhill wall's crest drops below the floor it was meant to contain, so a
"banked turn" is a chute open on its outside edge and a whole AI field slides out of it. The rule is
`wall > (width/2 + wall)·sin|bank|`, and it bites hardest where a designer wants it least — a wide floor needs
a tall wall to survive even a gentle bank. Its mirror is cheaper but worth saying: the uphill wall stands at
45° + |bank|, and past ~58° nothing holds to it. Both are checked from the four numbers alone and shown under
the sliders as you drag them.

`seatCourse` is the same profile swept by the one-shot generator seat on a build-time `GridNet`, and shares
`crossHeight` with the above so a seeded course and a shaped one have the same cross-section.

## TL;DR

| Stage | Construction | Guarantees |
|---|---|---|
| Spine | Catmull-Rom through knots, densely sampled once into an arc-length table | rows are evenly spaced in metres, not in parameter |
| Section | fixed column layout, parameters smoothstep-blended between knots | grid topology never changes while shapes morph |
| Grid → patches | Hermite cells from Bessel (chord-weighted) tangents, zero twist | C0 watertight + G1 across every seam, by construction |
| Preview | same control points, same evaluator, same 8×8 resolution as the HD bake | the viewport shows the high-detail baked geometry |

## Spine

Knot positions are interpolated with a Catmull-Rom spline and sampled densely (32 samples per
segment) into a table carrying position, tangent, cumulative arc length `s`, and a continuous
knot index `k`. All later questions — "where is the row at s = 132 m?", "what is the width
there?" — are answered from this table (`spineAt`, `paramsAt`), so geometry spacing is uniform
in metres regardless of how unevenly the user places knots.

Patch rows sit every `patchLen` metres (default 12, the row count rounds so the last row lands
exactly on the end). Cross-section parameters (`width`, `wall`, `bank`, `shoulder`) blend
between knots with a smoothstep on the knot-index fraction: parameter changes ease in and out
rather than kinking at knots.

## Cross-section and the fixed column layout

Each row sweeps one cross-section, sampled at a **fixed number of stations** so the grid stays
rectangular while parameters morph:

```
shoulder | wall wall |  floor × floorCols  | wall wall | shoulder        (cells)
```

- **Floor**: `floorCols` even cells across `width`, height 0.
- **Walls**: two cells each side rising `wall` metres over a lateral run of
  `max(wall, 1.2)` m — the 1.2 m floor on the lateral extent keeps the wall columns
  non-degenerate when `wall → 0`, so a flat-edged course is just a quilt whose wall cells are
  flat, not a different topology.
- **Shoulders**: one flat-ish cell each side beyond the wall top (slight outward rise), reset
  surface by default — ride off the course and the board's on-track OOB reset fires.

**Bank** rolls the whole station set about the spine before placement, so a banked turn tilts
floor, walls and shoulders together.

The lateral frame at each row is `side = fwd × worldUp`, `up = side × fwd`. The direction of
`side` is load-bearing: it makes the quilt's u×v tangent cross point *down* in editor space,
which is the orientation the bake's winding convention turns into skyward normals — the full
chain is derived in 003.

## Grid cells → Bézier patches

Each grid cell becomes one patch. The 16 control points come from a bicubic Hermite (Ferguson)
construction:

- **Tangents** at every grid point, along rows and along columns, are **Bessel** — finite
  differences weighted by the chord lengths on either side (`bezier.ts tangents()`). Plain
  uniform Catmull-Rom would overshoot where a narrow wall cell meets a wide floor cell;
  chord-weighting keeps the curve inside its data.
- **Corner/edge/interior points** are the standard Hermite→Bézier conversion: boundary points
  are the grid points themselves, edge-adjacent points add ⅓ of the local tangent, interior
  points add both tangents. **Twist vectors are zero** — twist only shapes the patch interior,
  never the seams, and zero is robust.

Continuity then comes for free: adjacent cells *share* their boundary grid points and the
tangents along the shared edge, so the quilt is exactly C0 (watertight — stronger than the
spec's epsilon-weld requirement, which exists because original data is only near-equal at seams)
and G1 (smooth normals) across every interior seam.

Control points are ordered row-major with rows along u (the spine direction) — the same
`cp[r*4+c]` layout `snowknife`'s `Bezier.Patch` consumes.

## Preview parity

`patchPoint` / `patchNormal` in `bezier.ts` reproduce `Snowknife/Bundle/Bezier.cs` —
Bernstein basis, same row-then-column operation order — and the viewport tessellates each cell
at the bake's high-detail `TerrainResHd = 8`. What the user sculpts is therefore the HD baked render mesh,
vertex for vertex; only shading differs (preview normals are evaluated per-vertex, the bake additionally
welds normals across seams within a smoothing angle). The bundle also emits the same surface at
`TerrainRes = 4` for the base render/collider budget. Editor Play does not ride either set of chords: a
triangle hit seeds an analytic solve on the bicubic patch.

The preview tints vertices by surface type with a subtle per-cell checker so the patch grid —
the thing paint mode addresses — stays visible.

## Paint

Paint mode writes `doc.paint["row,col"] = surfaceType` overrides; unpainted cells fall back to
`floorSurface` (shoulder columns to `shoulderSurface`). Picking maps the clicked triangle's
`faceIndex` back to its cell arithmetically (cells emit a fixed `res²·2` faces in build
order), so no auxiliary picking structure exists. Structural edits that change the row count
clear the paint map — overrides are keyed by grid position and would otherwise land on the
wrong cells.
