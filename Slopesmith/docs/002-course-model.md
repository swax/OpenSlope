# 002 — Course Model

How a `CourseDoc` (knots + parameters) becomes a watertight quilt of bicubic Bézier patches.
The design rationale is [001](001-design.md); what the result is serialized into is
[003 — Export Contract](003-export-contract.md).

Code: `src/core/math/spine.ts` (centerline), `src/core/doc/mountain.ts` (generation — `buildMeshFromCourse`/`seatCourse`), `src/core/math/bezier.ts`
(quilt + evaluation), `src/core/mesh/tessellation.ts` (viewport tessellation).

The terrain generator (`buildMeshFromCourse`, behind New mountain and a reference's "new mountain from this
course") is a separate topology-general path. Every authored course knot creates a primary
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

`New mountain` and `New mountain from this course` both use this one dialog and generator. There is no
regenerate-in-place for the current run: once a mountain exists its terrain is edited, not re-lofted. Alongside edge width, roughness, target patch size and seed, the dialog exposes **height**: the
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

## Drawing and seating the run

Code: `src/core/doc/course.ts` (`redrawCourse`, `seatRunOnTerrain`), `src/app/viewport/tools/course-draw.ts`,
Scene ▸ Course ▸ **⟲ reset course**.

The run is a line the net does not carry, and the game spawns the field at its exported heights — so a line
left floating or buried starts the race that far off the snow. The editor therefore keeps it seated, and there
is no button for it:

- **Reset course** replaces the line. Click the terrain at the start, then each point down to the finish;
  click the newest point again (or press Enter) to commit, Backspace takes a point back, Esc cancels and keeps
  the old line. Every point is a hit on the mountain's own surface, so the new run starts seated. Each new knot
  is a 30 m open floor (`DEFAULT_KNOT_PROFILE`: no wall, no bank, 8 m shoulder) — the same profile every new run
  starts with, below — rather than whatever the old knots carried. Checkpoint bonuses and placed START /
  FINISH flags go with the old line, so the drawn ends are the race's ends until a flag is dragged again.
- **Dragging** a knot or a flag moves it across X/Z only — the gizmo has no vertical handle — and the ground
  under it sets its height on every move.
- **Reshaping the hill** re-seats the whole line, knots and flags together: each sculpt stroke and each Edit
  drag re-lands it when it ends, as does adding a knot. Edit commands that are not drags (smooth, loft and the
  like) do not; the next stroke or drag near the line picks it up.

A knot's `width` is the run's own floor: it bounds the AI field's weave (half of it, less a 1.5 m margin). Every new run — reset course, New mountain's starter line, a
reference line borrowed into a new mountain, a blank mountain's guide run — starts at 30 m. The generators'
**edge width** is a separate thing, the span of terrain lofted around the run; until this split it was also
written into every knot, which gave generated mountains 400 m floors and a field that could weave ±178 m.
Saved mountains keep the widths they have. The editor draws its start, checkpoint and finish lines a fixed
30 m across regardless (`course-markers.ts`); none of them ships as a model.

Where the mountain passes over itself — a bridge, an overhang, a lap running under its own upper section — the
point's (x, z) column holds several surfaces, and a seat picks the one NEAREST the height the point already has,
so a run under a deck stays under it however the deck above is sculpted. A drag carries that height move to move,
so a knot dragged along beneath a bridge stays beneath it; to move a point onto the other deck, reset the course
and click it there (a click lands on the surface you see). The editor reads every surface in the column from the
viewport's cached surface tree (`Viewport.terrainNearestAt`), the HD tessellation the user sees; `seatRunOnTerrain`'s default ground is the document's own quilt at the 4×4 collider resolution, which is
what generation and the checks use. Building every patch's control points costs a dense mountain a tenth of a
second or more, too much to pay each time a sculpt stroke lifts; the two surfaces differ by centimetres.

## The run no longer shapes the terrain

Scene ▸ Course once had **shape run into terrain**, a one-shot command that pressed a channel profile — the
floor `width`, a quarter-pipe `wall` at each floor edge, a `shoulder` past the wall tops, a `bank` rolling the
section, faded back into the hill over the run's `blend` — into the mesh's heights and painted the floor strip.
It is gone, along with the wall / bank / shoulder sliders: the course is a line through the terrain and nothing
else, and a groomed path along it is built with Edit ▸ Create Trail (docs/023), which emits a clean ribbon at
its own density instead of bending whatever the terrain's patches happen to be. The command also worked in
plan only, so on a mountain that overlaps itself it pulled a deck above or below the run onto it.

The fields stay in the document format, so older saves open unchanged. Only `width` still means anything
live (the AI field's bound). The cross-section math (`crossHeight` / `seatSample` in `core/doc/run-shaping.ts`)
survives for one reader: `seatCourse`, which re-creates a legacy carved save's channel on its build-time
`GridNet` during migration so the document opens with the terrain it was saved with.

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
