# 006 — Surface net (Mountain as an editable Bézier control net)

## Why this replaces the heightfield

The game boards on a **watertight quilt of bicubic Bézier patches** — that is what `Patches.json`
stores and what the PS2 tessellates ([terrain-render RE]). Slopesmith already *exports* that for
both editors. The Mountain's heightfield (`MountainDoc.verts`, one Y per ground point) was only an
*editing* convenience; it is fit to the Bézier quilt at derive time and never reaches the game.

Its real limit is not smoothness or holes (both are guaranteed by the derivation) — it is **which
shapes it can express**: a single-valued heightfield cannot make a vertical wall, an overhang, or a
past-vertical face. The full original shape class needs the surface to fold, which means the authored
thing must be the **control points themselves**, in full 3D. So Mountain stops being a heightfield
and *becomes* the control net. The heightfield generator survives only as one way to **seed** it.

This is also the clean answer to "load existing terrain": original patches already *are* a Bézier net,
so editing the control points is editing the same kind of data — no lossy heightfield in the middle
(grid-topology only; see Non-goals).

## The representation

`MountainDoc` becomes (new `kind: 'mountain'`, version-tagged; old docs migrate — see Migration):

- `corners: number[]` — `(R+1)·(C+1)·3` flat, the patch **corner** control points in full 3D
  (editor metres). This is the generalisation of `verts`: same grid, but a corner may move on **any**
  axis, so the surface can fold. `R·C` patches.
- `handles?: Record<string, V3>` — sparse **tangent-handle overrides**. Key = `"i,j:dir"` for a
  corner `(i,j)` and direction `dir ∈ {u-,u+,v-,v+}`. Absent → the handle is **Bessel-derived**
  (today's `gridTangents`), so a freshly seeded surface is smooth and identical to the current quilt.
  Present → the user has pulled that handle (an overhang or a crease).
- `spacing`, `baseSurface` — as today (spacing is now the *parameter* step, see UV).
- `paint`, `texPaint` — per-patch surface/texture, keyed `"pi,pj"` (unchanged).
- `course: CoursePath[]` — replaces `carves` (see "Course on a surface").

A corner is `cp[0|3|12|15]` of the patches that share it; the handle overrides are the edge points
`cp[1|2|4|8|…]`. Together they are the full 16-point control net, organised so the **on-surface
points (corners) are first-class** and the tangent handles are opt-in.

### Why corners-plus-overrides, not the raw (3R+1)×(3C+1) net

Same expressive power, but: (a) it degrades exactly to today's model (corners = verts, no overrides
= Bessel), so migration and seeding are trivial; (b) editing a corner moves the whole local frame
the intuitive way; (c) far fewer points to author by default — you only materialise handles where
you actually shape a wall/crease.

## Watertight, smooth, and deliberate creases

- **Watertight** is automatic and unconditional: adjacent patches read the *same* shared corner from
  `corners`, and shared edge handles are derived from the shared corner line — there is no way to
  open a crack. This is the one hard invariant; everything else is shape.
- **Smooth (G1)** holds wherever handles are Bessel (the default) — the tangents across a seam are
  collinear by construction, so nothing catches an edge.
- A **crease** (the top of a wall, a lip) is just a seam where the two sides' handles are *not*
  collinear. That is a feature, authored by pulling a handle or via a "crease" assist. Smoothness is
  therefore a per-seam choice, not a global property — exactly what walls need.

## Course = a ribbon laid into the mountain

A course is a **ribbon**: a 2D swept surface — a spine (centerline) + a **cross-section** (floor
width, quarter-pipe wall, bank, shoulder). Because it is a parametric band, a **bank** is just
tilting the cross-section and **thin/wide** is just the width — the easy authoring that makes the
ribbon the right tool. This is the existing Course model; it folds into Mountain as the **Run** tool
(the standalone Course editor retires once the in-mountain run is fully capable).

A run **deforms the terrain to seat itself** ("lay it down"): along the spine, the cross-section
defines a target surface (floor at the spine elevation, quarter-pipe walls rising at the edges,
banked tilt), and the terrain net is pushed toward it, blended back to the surrounding land over a
falloff. So the run sits *in* the hill — a banked channel / half-pipe cut into the terrain — not a
ribbon floating on top. It also paints the floor strip's ride-feel and exports the AIP line + gate.

- Stage 1 (this) seats the ribbon by **deforming the terrain net** (one-shot "seat run" op): the
  rideable surface *is* the deformed terrain. Reuses the cross-section profile + spine frame
  (mountain.ts `crossHeight`/`seatCourse`, spine.ts `frameAt`/`paramsAt`).
  - **Antialiased seat** (`seatCourse`): the cross-section's wall is a metres-wide feature on a
    tens-of-metres grid, so a *diagonal* run sampled one point per corner staircases (its wall
    iso-lines jump cell to cell). Each corner's seated height is averaged over a ~1.2-cell footprint
    (a box low-pass at the grid frequency), so the wall lands as a smooth ramp the bicubic net holds
    — the relax-by-hand fix, baked in. Measured on a wall=8 diagonal: ~80% less height-field roughness,
    ~84% of trench depth kept. A wall here can be no *crisper* than the grid; crisp **and** smooth at
    any angle needs the run to be its own surface (below).
- A run **dipping below the surface and back out** is a **tunnel**: there the run must be its own
  surface with the terrain roofing over it through a portal — the frontier (final stage). This is also
  the path to a **crisp + smooth wall at any angle** (a high-res ribbon tessellated along its own arc,
  independent of terrain grid). A single deformed net cannot be both the run floor *and* the terrain
  above it.

`CourseKnot` therefore carries the full cross-section (`width`, `wall`, `bank`, `shoulder`).

A mountain carries **exactly one run** — the spawn/AIP course — and it cannot be added or removed:
the export rides it, and `migrateMountain` guarantees it (collapsing a multi-run doc onto its first
sweepable run, sweeping a fall line for a doc that carries none). Branching would be several AIP
`RaceLines` carrying `DistanceToFinish`, which `CoursePath` does not express.

## Editing model

- **Sculpt** — 3D brushes on the corners: raise/lower either **vertical** or along the **local surface
  normal** (so it builds a wall face / pulls an overhang — S3), smooth (3D neighbour average), Grab in the
  camera-facing plane, and Flatten toward world height, the clicked tangent, or a weighted footprint-area
  plane. Flatten can lock that press-time plane for the whole stroke (default) or follow the surface under
  each dab. Radius follows connected surface distance across the control net, so folds are included without
  jumping to disconnected overlapping geometry within a dab. Displacement brushes preserve sparse authored
  handle/twist detail as it rides the broad corner shape; Flatten projects the complete effective 16-point
  cages, and Smooth relaxes those explicit deviations toward the automatic cage. Primary terrain shaping.
- **Edit** — click a node to select it; a Unity-style **translate gizmo** seats on it (three's
  `TransformControls`): drag an **axis arrow** to move on one axis, a **plane square** for two axes, or the
  **centre** for a free screen-space move — so the drag axis is always explicit (replaces the old
  planar-drag + Shift-for-height heuristic). The gizmo serves **every** draggable node — corner
  control points, course knots, and the tangent-handle nubs (a tangent is a free 3D vector, so the
  3-axis gizmo fits it directly). One gizmo at a time: clicking a corner seats it on the corner;
  clicking one of that corner's nubs re-seats it on the nub (the corner stays selected). The cage is
  the handle set, so corner editing turns on with the cage. (S3, gizmo added later)
  - **World / Local / Surface framing (one Edit-tool pill, default Surface).** For a corner (single or a
    multi-selection), **Local** re-frames the gizmo to the picked corner's slope while retaining the full
    free-move gizmo; **Surface** uses that same local frame AND slides along the surface. The anchor's
    quaternion is the corner's tangent frame (`cornerFrame` central differences,
    matching `mountain.ts cornerNormal`; the multi-corner centroid uses the members' averaged frame) and the
    gizmo runs `local`, so local **Y** is the surface **normal** (the _up post_), the **XZ** pad is the
    **tangent plane**, and the two arrows are **down-mountain (u)** / **cross-slope (v)** — restricted to
    those four clean handles (the vertical-plane pads + free centre are hidden). Sliding is implicit: the two
    arrows and the **XZ** pad all re-cut the net exactly (below), so **only the up (Y) handle** moves the point
    off the surface (normal to it — the deliberate height change). **Local** keeps all seven handles and
    applies their displacement directly without a re-cut or projection. A point connected only by free edges
    still gets a Local frame: X follows its longest connected edge chord, Y is world-up projected perpendicular
    to that chord (with a stable perpendicular fallback for vertical edges). **World** is the full
    7-handle free gizmo for off-surface work (overhangs, wall faces, cave roofs); **Shift** held while
    dragging forces World for one drag. Implementation: handle-hiding wraps the gizmo helper's
    `updateMatrixWorld` (which re-computes visibility each frame) to force the XY/YZ/XYZ handles — and their
    pickers — invisible last. `slideProject` — a plain down-ray against a terrain `MeshBVH` frozen at drag-start,
    replacing the dragged corner's Y with the frozen surface height at its current (x, z) — is the FALLBACK for a
    corner the exact slide refuses: a pinched net whose surface frame is degenerate (nothing tells the handles
    apart), or a legacy grid document with no quad mesh to freeze. The ray is wrong on an overhang, and it is all
    a corner with no axes has. (worldRoot only flips Z, so the probe needs no transform.) For a **corner region**
    the drag is instead a
    **ratio-preserving grid slide** (`captureSlideGroup` / `slideGroupUpdate`, reported via `onSlideCorners`):
    the centre handle's displacement becomes a uniform grid FRACTION (its tangent component ÷ the selection's
    mean cell size), and every member advances that same fraction of ITS OWN cell toward its next vertex — so
    a band slid "half a cell down-mountain" keeps its ratios on a non-uniform net — then rides the frozen
    surface (per-corner step oriented to the gizmo arrow so both axes track the drag); the handle's normal
    component lifts the whole group off the surface rigidly. Tangent nubs use Local / Surface only for their
    slope-aligned orientation (they never slide). Every other non-corner node kind (knots, props, gems, the
    reference) stays plain World. (Surface framing added later.)
  - **The in-plane arrows are an exact slide (`core/mesh/slide.ts`).** An arrow drag re-cuts the control net instead of
    deforming it — a de Casteljau split of the net frozen at drag-start, so the ridable surface is bit-for-bit what
    it was and only its parameterisation moves; that holds on overhangs and cave roofs, where no down-ray helps.
    A **corner** slides along one of its own edges (`slideVertexAlongEdge`); an **edge** or edge loop slides across
    the quads it borders, each becoming the exact sub-patch of itself (`slideEdgesInQuads`); a **cell** selection
    carries BOTH of its boundaries (`planCellSlide` → the same `slideEdgesInQuads` call) — the trail edge to
    parameter `t` inside the cell, the lead edge to `t` inside the neighbour beyond it. The cell ledger: the
    unselected quad slid INTO is bit-exact and the dragged cell's two moved boundary curves are exact, while the
    dragged cell's interior sits ~0.04% of a quad diagonal off the parent surface because it now straddles a G1
    seam (`[t,1]` of its own patch ∪ `[0,t]` of the next) and two G1-joined bicubics are not one bicubic. Every
    frame re-cuts the drag-start snapshot, never the last frame's output, so a long drag accumulates no drift;
    `t` is read off the frozen rail nearest the gizmo anchor, copied onto it. Held at the far clamp, a release
    **merges** (`applyVertexWeld`, announced on the status line): a corner fuses into its neighbour, an edge into
    the edge opposite, a cell dissolves the cell ahead of it (only the leading quad's rails weld — a dragged cell
    survives one seat forward). A rim selection has nowhere to run, so it clamps at `t → 0` and commits nothing;
    a corner region re-parameterises nothing at all and takes the frozen-BVH grid slide above.
  - **The tangent pad is that slide in both axes at once (`core/mesh/slide-gesture.ts`).** The 'XZ' handle drives the
    same three selections through the same frozen net, one `SlidePlan` per drag frame, and the host applies it to a
    clone of its own drag-start document (`applySlidePlan`). Its law: **every moved vertex `V` lands on `P_V(tu, tv)`,
    the exact patch point of `V`'s QUADRANT quad — the quad incident to `V` whose interior lies in the drag's `+u,+v`
    corner** (`slideQuadrantTargets`). No ray is cast, so the pad holds on the overhangs the arrows hold on.
    - **The 2-D ledger, plainly.** Every moved vertex is exactly on the parent surface. Nothing else is. A 2-D drag
      re-parameterises nothing — a moved cell's footprint straddles four parent patches, and four G1-joined bicubics
      are not one bicubic — and the moved boundary CURVES between the vertices hug the parent to ~0.04% of a quad
      diagonal (2.2 cm on a 51 m cell), not to the bit. Let either parameter fall back below `SLIDE_EPS` and its pass drops out, restoring
      the full 1-D exactness above, byte for byte. The arrows stay the precision instrument.
    - **Positions come from the law; the passes shape the tangents.** A frame runs a u-pass, a v-pass, then a `place`
      pass that writes each moved vertex onto its quadrant point. `place` is load-bearing, not polish: a composition
      of two 1-D passes gets only two of a cell's four corners right and drags the other two metres back down a chord
      toward a neighbour the first pass never moved (which two depends on the pass order, so no order works). A lone
      corner takes one `slideVertexOnPatch` pass instead — it is `place` and its tangents in one.
    - **Each axis reads its own rail.** `tu` and `tv` are projected onto their own frozen rails after the OTHER axis's
      travel is stripped from the pointer, so a pure-axis pad drag reproduces the matching arrow's parameter exactly.
      The pad's two coordinates are the gizmo's own arrows `(tu, n × tu)` — orthonormal, and NOT the surface frame's
      raw axis tangents, which are neither orthogonal to each other nor even same-signed as the blue arrow (a skyward
      normal flip reverses `n × tu`). A vertex's SIDE comes off the raw tangents (they orient `vertexAxes`' pairs);
      its COORDINATE comes off the pad axes. Swap the two and the corner slides away from the arrow you are pulling.
    - **An edge's two motions.** An edge or loop slides ACROSS the quads it borders and its endpoints slide ALONG it.
      Which axis drives which is a property of the SELECTION's own rails, not of the gizmo, so a down-mountain loop
      takes them the other way round. The across pass runs first: its moved boundary is then the parent's own
      `u = tu` iso-curve, and cutting THAT at `tv` lands on the surface.
    - **Merge, and the wall.** Saturating one axis merges as the arrow does, and the merging axis pins the other at
      zero — its pass and `place` drop, so the geometry lands ON the weld target instead of springing back, and the
      merge path is the tested 1-D path. A merge only arms while the other parameter has stayed within
      `SLIDE_MERGE_SNAP` (10% of a cell) of its rail: further out the dragged thing stands on the link EDGE, not on
      either of its ends, and a quad mesh has no legal T-junction. **Saturating BOTH axes merges nothing.** The corner
      has arrived at its quadrant quad's FAR corner, and welding it there is the one fusion `applyVertexWeld` refuses
      outright — a quad encodes the edge-collapsed wedge `[A,B,C,C]`, never a diagonal collapse. Welding it into its
      two rail neighbours instead does pass the guard, but those neighbours ARE that diagonal pair: union-find fuses
      all three through the corner, drops the quadrant quad, and teleports the corner most of a cell back onto a rail
      it had just crossed. Two cells' worth of merge is a different topological operation, so the drag clamps against
      the corner — visible, reversible, and never a jump.
  - **The arrows are drawn as the rails they slide down (`app/viewport/gizmo/arcs.ts`).** In Surface mode the two
    in-plane arrows are not straight — each is the boundary cubic that direction's drag re-cuts (`slideRail`), so the
    arrow bends along the slope over a lip and under a cave roof, and its head parks exactly on the neighbour vertex
    the drag clamps and merges at. What you pull is what you see. They are real gizmo meshes named `X` / `Z` grafted
    into `TransformControls`' own translate gizmo and picker, so the hover highlight, the camera-facing hide, and the
    `gizmo.axis` read are the stock machinery; the straight shafts are simply hidden while the arcs stand, and a
    direction with no rail (a rim, a wedge ahead, a corner region) shows the plain straight arrow. **Live while
    dragging:** each frame re-seats on the sliding corner against the re-cut net, so the pulled arrow shrinks onto its
    merge target as you close on it and the cross arrow swings to the surface direction from the corner's new spot.
  **Reveal handles** on a selected corner to pull overhangs/creases; per-corner **smooth ↔ crease**;
  **shift-click** a second corner to select the rectangular block between it and the first, or **box-select**
  a region — either multi-selection carries one **centre gizmo that moves the whole set** and the bulk
  crease/smooth. (S4 / S4-cont) Box-select over the solid surface grabs only
  the corners you can SEE — `cornersInMarquee` casts camera→corner against a fresh terrain `MeshBVH` and drops
  any corner the surface hides (else a flat screen rectangle would also catch points on the far side / buried
  under the hill); wireframe (no solid) keeps the plain through-select.
  **Cell selection** is the same grammar one level up: a click on a cell's open FACE (missed every corner)
  selects the **cell** — an orange outline on the patch, and the corner region seated on its 2×2 corner
  square — and **shift-click** on another face extends into the rectangular block of cells between them
  (`cellSel` in main.ts; the block's deduped corners become `regionSel`, so the centre gizmo's group
  move / slide and bulk crease/smooth all apply unchanged). The anchor cell persists for re-ranging; a
  corner pick, box-select, Esc, or empty-space click drops the cell set. The Tools note counts both
  (`N cells selected` above the corner-block line).
- **Paint** — unchanged (surface = ride feel, texture = real tiles), keyed per patch.
- **Cage** — a toggle that draws the control net (corner lattice; handles shown for the selection),
  so you can see what you are pushing. Editor-only.

## Export & UV

- `corners` + resolved handles → each patch's 16 CPs → `Patches.json` `Points` (via `toRaw`), exactly
  as the bake consumes. No fitting step; preview tessellation (`patchPoint`) stays bit-identical to
  the bake. Surface/texture paint and the start gate/AIP come from `paint`/`texPaint`/`course`.
- **UV**: parameter-step UV stretched a tall wall (one grid step spanning many metres). Terrain UV now
  accumulates **3D chord length** along i and j (`deriveMountain`), so texture density stays even on
  steep/folded faces. (Landed in S4.)
- **Normals**: the "all terrain normals point skyward" invariant (and the smoke's old `minNy > 0`
  check) was a *heightfield* property. Once overhangs exist, an underside legitimately faces down. It
  turns out the **bake already winds by geometric orientation, not a skyward assumption**:
  `TerrainBundle.cs` signs each analytic normal against the geometric winding normal `gN` (accumulated
  from the tessellated triangles' fixed parameter winding) and welds within a smoothing angle — so a
  folded net bakes with consistent, double-sided-correct normals and **no bake change was needed**.
  The preview already renders DoubleSide. Only the mountain smoke relaxed: it now requires "consistent
  winding, no NaN" (some skyward face, finite unit normals, overhang undersides allowed) and keeps the
  strict skyward check for heightfield *courses*. Verified end-to-end: a deliberately folded net bakes
  to a normal-Y range of [-0.58, 1.00] with no NaN.

## Migration (old saved mountains keep working)

`MountainDoc` is detected by shape: an old doc has `verts`/`carves`; a new one has `corners`/`course`.
On load, an old doc is converted once: run the current `deriveMountain` (apply its carves into the
heightfield) → take the resulting surface-grid points as `corners`, no handle overrides; convert each
carve line to a `CoursePath`. Result is visually identical, now freely editable in 3D. A `version`
field guards future changes. New mountain creates a starter course directly and passes it through the same
topology-general `buildMeshFromCourse` loft used by terrain regeneration; the grid path remains only for
loading old saves.

## Non-goals (later stages)

- **Arbitrary original import** — extracted levels are general quad meshes with extraordinary corners, not a
  rectangular grid; they cannot load into a single rectangular net. Lossless load is limited to
  **grid-topology** levels (our own exports). Extracted levels stay the read-only Reference layer.
- **B-spline / automatic global continuity** — we keep explicit Bézier control points (creases are a
  feature), with smoothness as Bessel defaults + assists, not a constraint solver.

## Performance note

A big surface is thousands of patches and many more control points. The preview already tessellates
per patch at res 4; the cage adds a lattice. Keep the cage to corners by default (handles only for the
selection), cap interactive net size, and reuse the existing per-texture draw-group batching. Mobile:
corner handles must be big enough to grab and the cage cheap to redraw.

## Build stages

- **S1 — Net core.** The `corners`/`handles`/`course` model + `makeMountain`; migrates old docs; a
  toggleable corner cage; exports the net to `Patches.json`; smoke stays green. (S2 grows the
  centreline groove here into the full ribbon below.)
- **S2 — Ribbon run, seated.** `CourseKnot` carries the cross-section (`wall`/`bank`/`shoulder`); the
  one-shot "seat run" deforms the terrain net to the ribbon profile (banked channels / half-pipes cut
  into the hill), reusing the cross-section + spine frame. The run knot inspector carries the section
  controls. `npm run smoke` stays green.
- **S3 — 3D terrain editing.** Sculpt raise/lower has a **vertical | surface-normal** direction (normal
  builds wall faces / pulls overhangs) and smooth relaxes corners in full 3D; Edit **drags terrain
  corner control points in 3D** (cage on = handles live; planar drag, Shift = height; cyan handle marks
  the selected corner). The bake winds by geometric orientation (see Normals), so overhangs bake
  correctly with no bake change; the **mountain smoke** checks "consistent winding, no NaN" (courses
  stay strict-skyward). Grab/extrude brushes + marquee/handle reveal are S4's.
- **S4 — Handles & creases.** Each corner carries four directional tangent **handles** (`bezier.ts`:
  u-/u+/v-/v+ offsets, Bessel by default, overridable per `MountainDoc.handles` — byte-identical export
  when none); a selected corner reveals draggable magenta **nubs** (Edit + cage), and **crease**
  (one-sided chords → sharp kink) / **smooth** (drop overrides → Bessel G1) assists. Both preview and
  the bake consume the handles through the one `gridTangents`/`cellControlPoints` path, so no C# change.
  **Chord-length UV** follows true 3D surface distance, so steep walls/folds keep even texels instead of
  stretching. An override moves the right CP and keeps shared corners (watertight); a crease changes
  only the patches touching that corner and reaches `Patches.json`.
- **S5 — Tunnels / portals (frontier).** A run dips below the surface as its own tube surface; the
  terrain roofs over it with a portal at the mouth. The hard topology; built toward by everything above.
- **S6 — Mountain-only.** Slopesmith has one document type (`MountainDoc`) and one editor: there is no
  standalone Course editor. The ribbon lives on as the in-mountain **Run** (`CoursePath` with the full
  `width`/`wall`/`bank`/`shoulder` cross-section, edited with the same knot drag/insert/delete +
  seat-into-terrain), carrying the cross-section, banking, surface, start gate and AIP line from S2. The
  one capability the Run doesn't carry is **independent run resolution** (`patchLen`/`floorCols`): a
  seated run's crispness is the terrain grid spacing, not its own — that's the future "run as its own
  surface" (S5 tunnels). Lossless grid-level *load* (re-importing our own exports) remains open.
- **S7 — Cell selection.** Face click + shift-range selects **cells** (see the Edit bullet above): the
  block's corners seat the region, so group move / slide and bulk crease/smooth apply unchanged, and
  `cellSel` keeps the patch coords for a future refine-selection gesture.

## Open questions for review

1. **UV on folds** — resolved: chord-length terrain UV (`deriveMountain` accumulates true 3D distance
   per axis), so walls keep even texels.
2. **Normal/winding** — resolved: the bake signs normals by geometric winding, so overhangs bake
   correctly with no skyward assumption; the mountain smoke checks "consistent winding, no NaN" for
   mountains (courses stay strict-skyward).
3. **Net resolution** — fixed seed grid + later local refinement (add a patch ring), or expose grid
   density up front? Proposing fixed seed + S5 refinement.
4. **Course coupling** — is the decoupled "path + optional groove" the right call vs. some always-on
   auto-groove? Proposing decoupled.
