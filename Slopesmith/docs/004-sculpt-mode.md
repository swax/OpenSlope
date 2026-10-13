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
> run does not shape the terrain at all — a groomed path is built with Edit ▸ Create Trail — see
> [002 — The run no longer shapes the terrain](002-course-model.md). The nondestructive carve
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
(~15 m point spacing) and stages the field at its head, so the six-slot start field, StageArea alignment and
on-track OOB reset share the same authored origin.

**The density rule** (inherited from the Blender NURBS prototype, `Blender/openslope_terrain.py`): a
carved feature only survives patch fitting if the vertex spacing is at most about half the
feature's width. At the default 30 m spacing, carves narrower than ~60 m lose their flat floor —
which is why the default carve is 64 m wide and new lines default to `2 × spacing`. Stage 2b
(refinement under carves) is the real fix; until then, narrower carves want a denser grid.

## Sculpting

Brushes (`raise` / `lower` / `pull` / `push` / `smooth` / `flatten`, bell falloff) edit the **base** verts only;
the carve re-applies on every rebuild, so sculpting can never break a carved floor. The brush
maps the derived preview hit back to its authored quad, then measures a bounded shortest path over
that connected control surface (patch edges + diagonals). Its radius therefore follows walls and
folds in 3D instead of projecting through XZ, and cannot jump to a disconnected surface stacked at
the same horizontal position.

**A brush narrower than the cage.** The brush moves corners, and a coarse cage can leave every corner of the hit
patch outside the radius — a small brush on a 30 m patch, or any dab on an edge or patch middle. Measured by
corner distance alone, that dab moved nothing (Maya's NURBS Sculpt Geometry Tool had the same limit: only CVs
inside the radius move, and its manual's remedy is a bigger brush or more isoparms). So after the falloff weights
the corners, the hit patch's own corners are topped up by the least-norm move that carries the surface point
under the cursor the full stroke — the solve Maya's Surface Editing Tool uses to drag a point anywhere on a
surface. Each corner's pull on that point is measured on the live cage (automatic handles re-derived, authored
handle and twist offsets riding along), so poles, rims and linear cages need no special case. No corner moves
further than the stroke: a corner the solve would overshoot is held at full strength and the lift it cannot take
is dropped rather than handed to the others (right beside a corner the hit therefore rises ~85–100% of the
stroke). A footprint whose falloff already carries the hit, as any brush that spans the patch does, keeps exactly
its falloff weights. Every brush shares these weights, so Grab keeps the grabbed point under the cursor and
Smooth/Flatten reach the patch under a small brush. The visible footprint is therefore at least the hit patch.

**Sculpting against a lock.** Patch locks are enforced per control point, not per corner. A corner shared with a
locked patch stays put, but it also owns controls that do not shape that patch: its handles on unlocked edges
and its interior points in unlocked patches. Those take the stroke the corner would have taken. This is what
makes a cornice sculptable: lock the cliff face, then Grab the snow at the lip up and out (or Pull it). The lip curve and the
cliff stay exact while the snow's last third — the controls the lip corners own — pillows out over the face.
Before this, every control behind the lip hung off the locked corners and only the row 30 m back could move.
The weights ignore locks for the same reason: the locked corner's share is carried by its free controls, and
re-solving it onto the rest of the patch would drag the far side in.

The hover ring aligns to the hit surface's tangent plane. Its falloff is
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
Raise/Lower, Pull/Push, Grab, and Nudge reshape the shared corner net while preserving authored handle/twist detail. Flatten
projects every effective boundary and interior control in the affected 16-point cages, so an apparently flat
patch cannot retain hidden off-plane curvature. Smooth relaxes corners from a frozen snapshot and fades
explicit handle/twist deviations back toward the automatic Ferguson cage.
The Sculpt panel groups operations into connected **Displace** (Raise/Lower, and Pull/Push beneath them),
**Refine** (Smooth/Flatten), and **Move** (Grab/Nudge) families, keeps size/falloff together, and shows only the
selected tool's meaningful settings. Raise/Lower move straight up and down; Pull/Push move each corner out of or
into the surface along its own normal (Maya's Pull/Push convention), which is what builds walls, overhangs and
snow pillows — the two directions are separate tools rather than a toggle on Raise/Lower. "Out" is toward the face
being sculpted: the viewport turns the hit normal to the viewer (the terrain is two-sided, so a wall seen from
behind reports its far side), and each corner's normal is turned to agree with it. A vertex frame's own sign comes
from a skyward convention that means nothing on a wall — a hair of tilt decides it — so without this a near-plumb
wall pulled half its corners out and pushed half in. Holding the button still keeps building at ten dabs a second
(a moving stroke dabs on every move, about one a frame, which held on one spot would be far too fast); a move
restarts the count. Falloff, flatten plane,
and plane sampling use compact icon rows with descriptive tooltips instead of dropdowns. Grab locks one connected
footprint on press; Nudge (Blender's name for the same brush) resamples the footprint continuously and projects
each stroke segment onto the current surface tangent before moving its control points. `[` / `]` resize the
footprint.

**Keys** (`src/app/sculpt-shortcuts.ts` — the handler, the legend and the panel buttons read one table): one
letter per tool, drawn faintly after its button label — `R` Raise, `P` Pull, `S` Smooth, `⇧F` Flatten, `G` Grab,
`N` Nudge. Lower and Push have no letter of their own: **Ctrl** is the opposite. Held through a stroke it inverts
a displacement (Raise↔Lower, Pull↔Push; tools without an opposite ignore it) and is read on every dab, so it can
flip mid-stroke; on the key, `Ctrl+R` selects Lower and `Ctrl+P` Push, which also keeps the browser's reload and
print off those chords. **Shift** held smooths with whatever tool is active and is decided at pointer-down, since
it also turns a Grab press into a smoothing stroke — the Ctrl-inverts / Shift-smooths convention Blender, Maya and
Mudbox share. The digits stay the view switches and bare `F` stays frame, which is why Flatten is `⇧F`; ZBrush
inverts with Alt, but Alt is the camera's fly key here.

**Shift+scroll** sizes the brush, as it sizes a held prop: ~15% a notch, never less than a metre, in whole metres
(`[` / `]` keep their 5 m steps). Not Ctrl+scroll: a trackpad pinch arrives as Ctrl+wheel (it zooms the camera
here), and Ctrl already inverts. The first wheel event of a gesture steps at once, so every mouse notch lands, and
later deltas gather into notch-sized steps so a trackpad swipe walks a few sizes instead of racing through dozens.
Falloff stays a panel choice — off the wheel, where an accidental scroll would quietly change how every stroke
lands. The brush ring shows it: a faint inner circle where the profile falls to half strength — near the centre
for Sharp, half way for Linear, wider for Smooth, none for Constant's hard edge.

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
