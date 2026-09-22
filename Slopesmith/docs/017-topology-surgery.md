# 017 — Topology surgery (cuts, welds, poles, wedges)

The quad-mesh document ([006](006-surface-net.md) grid → `QuadMeshDoc` v4, `src/core/mesh/topology.ts`) can
*hold* any quad topology — 3/5 poles, partial loops, triangle wedges — but the editor has no operation
that *changes* topology: every existing tool moves, paints, or creases vertices and quads that already
exist. This doc specifies the surgery kit that creates and destroys them.

The design premise comes from the reference measurements (two throwaway scripts under the gitignored
`temp/`, not distributed): the shipped quilt **is** the authored control mesh — one polygon-style
quad mesh at 10–30 m cells, a few thousand quads, with poles placed by hand. No modeler has a "place
pole" tool; poles are what cut-and-merge surgery leaves behind. So the kit is a small set of
Maya-1-class primitives, and every richer gesture ([018](018-density-transitions.md) stamps,
[019](ideas/019-rips.md) rips) composes them.

Code home: `src/core/mesh/ops/index.ts` (new; pure `QuadMeshDoc → QuadMeshDoc` rewrites), gestures in the
Edit tool (`src/app/main.ts` + `viewport.ts`).

## The op contract

Every op is a pure document rewrite with one shared id-maintenance helper:

- **Ids are stable where untouched.** Ops append new vertices/quads and delete by index; a final
  `remapIds` pass compacts `vertices`/`quads` and remaps every id-keyed sparse map (`edgeHandles`
  `"${from}>${to}"`, `quadPaint`, `quadTex`, `quadOrient`, and [020](020-patch-finish.md)'s
  `quadTwist`). One helper, used by every op, unit-tested once.
- **Topology is derived, never patched:** after a rewrite the op rebuilds via `topologyFromQuads`.
  Undo/redo is the existing document snapshot path — ops never mutate in place.
- **New geometry is born smooth.** Inserted vertices carry no `edgeHandles` overrides, so new seams
  are Bessel-G1 by construction ([006](006-surface-net.md)); creases survive only where the user
  authored them. Overrides on a *split* edge are re-derived: the crease state (collinear or not) of
  the parent edge is inherited by both halves.
- **Manifold guard.** An op that would make an edge shared by 3+ quads, or a vertex whose quad fan is
  disconnected, is rejected with a toast — the mesh stays a manifold-with-boundary quad complex,
  which is what the export and `topologyFromQuads`' pole test assume.

## Ops

### Create patches from selected edges

With multiple authored edges selected, **Topology → create patches** fills every complete three- or
four-edge hole in one document edit. Separate holes and adjoining holes can be filled together; extra
open chains are ignored. All sides must be selected. Triangles use the ordinary collapsed-edge wedge
encoding, and new patches become the selection. Existing patches, interior edges, chorded/subdivided
outlines and degenerate/crossed loops are skipped; if nothing can be filled, a toast explains why.
The operation reuses the boundary vertices and curves, matches neighboring normals, consumes perimeter
free edges, and leaves existing patch identities and authored appearance intact.

### Loop cut (the headline)

From a hovered edge, walk the quad strip through opposite edges (`SurfaceTopology.cellEdges` pairs
(0,2)/(1,3) — the same walker as `faceLoop`) in both directions until the strip **closes**, reaches
the **rim**, or reaches a **pole** (`edgeTouchesPole`). Insert one vertex on every crossed edge at
fraction `t` (default 0.5; mouse wheel slides the ghost line along the strip like the placement
wheel), split each crossed quad into two.

- Terminating at a pole is **correct behaviour**, not failure — a loop in a poled mesh is a strip,
  not a global ring. The ghost shows both stop reasons (pole dot / rim tick) before commit.
- On a pristine promoted grid this reproduces a whole row/column insert (strip runs rim to rim), which
  is the regression check.
- Position of inserted vertices: on the *derived Bézier edge curve* at parameter `t` (not the chord),
  so a cut through curved terrain doesn't flatten it. Handles re-derive; shape change is the Bessel
  re-fit only (measured ≲ the [018](018-density-transitions.md) refine tolerances).

### Knife (single-strip split)

The same insert restricted to a user-picked run of quads (click entry edge, drag across, release on
exit edge). This is the Split-Polygon-Tool equivalent: the primitive that, combined with **collapse**,
manufactures poles deliberately.

### Collapse edge / weld vertices

Collapse a picked edge (merge its two vertices at the midpoint, or at either end with a modifier),
removing the degenerate quads. This is the pole-maker: collapsing in a regular region leaves a 3-pole
+ 5-pole pair. Guard: reject if any surviving quad would become a line (two of its four ids equal
after the merge — unless the wedge op below is what's wanted).

### Dissolve ring (inverse loop cut)

Select an edge ring (the loop-cut walk without the insert); dissolve merges each quad pair across the
ring back into one quad and removes the ring's vertices. A region boundary with more than four points keeps
its four strongest tangent corners; intermediate points still used by neighboring patches remain as explicit
T-junctions and are highlighted red. The manifold guard still rejects degenerate or overlapping results.
Drawing the missing cut across the neighboring patch to one of those T vertices resolves it in place: the host
edge is split with that existing id, its curve handles are inherited, and two half-split patches become four
conforming quads without propagating farther.
If a new stroke runs from a T vertex directly to a non-adjacent surface edge, Create Edge follows the drawn
stroke across an unambiguous all-quad strip and inserts the actual cubic-edge crossings automatically. Routing
projects along the endpoints' average surface normal, so it also works on slopes and walls. It stops at an
opening instead of finding a topological detour around it: a connection across a gap stays a direct free edge.
Folded or ambiguous routes require explicit intermediate edge picks. A true rim endpoint is
therefore conforming and never receives a T-node; only stopping on an edge with an untraversed patch beyond it
creates another explicit T-junction.

T-junctions are saved topology, not proximity warnings: `tJunctions[]` records the embedded vertex, its
unsplit host edge, and its directed Bézier parameter. The host surface remains a four-sided bicubic patch;
the record makes its extra boundary node explicit without introducing a five-sided surface. Cuts, dissolves,
welds, deletion, compaction, and clipboard remapping carry or resolve these records. Geometric vertex-on-edge
detection runs only while migrating older documents that predate the explicit representation.

### Edge crossing diagnostics

Non-connected cubic edges within 0.2 m are marked in Edit: a red × for a transverse crossing, or amber for a
near-parallel overlap. Clicking the marker reports the case and offers **Create vertex + weld**, which inserts
one shared point into both edges and re-decomposes their incident patches. Two edges on the same patch are left
for a manual split because inserting the same point twice into one four-sided perimeter is ambiguous.
When a newly created edge makes a transverse crossing within the tighter 0.01 m authoring tolerance, that
crossing is welded immediately and the active edge chain follows both new halves. Near-parallel and broader
proximity diagnostics are never auto-welded. Finishing a new edge directly on an existing red crossing also
uses that endpoint as the shared vertex for both crossed edges.

Distinct used vertices within 0.05 m are marked with a constant-size magenta diamond. Clicking it reports the
two point ids and offers **Weld points**; this remains explicit because merging their incident topology can
collapse cells or otherwise fail the same manifold guards as an ordinary vertex weld.

### Wedge (triangle) fill

A dart tip or an awkward corner closes with a **triangle**, stored as a quad with a collapsed side:
`[A, B, C, C]`. The reference levels use this heavily (3–9% of patches are collapsed-edge wedges).
Data-model additions this op owns:

- `topologyFromQuads`: skip the self-edge `C–C` (no edge record, no adjacency through it).
- `quadControlPoints`: the collapsed side's handles are zero vectors; the exported patch is a
  collapsed-edge bicubic — byte-compatible with the reference wedge encoding.
- Selection/BVH: a wedge tessellates as a triangle fan; `cellLoop`/face-loop walks treat the collapsed
  side as a wall (loops end there).

### Bridge (fill a hole / join two rims)

Pick two open boundary chains of equal edge count (or one chain to cap): append the connecting quad
band. With [019](ideas/019-rips.md)'s stitch this is the constructive half of open-boundary editing.

### Edge extrusion

Select an edge or edge run and press **X** to stage an extrusion. The placement panel offers **Pull**
(the default) and **Path**, with a shared preview and **Enter** to commit or **Esc** to cancel.

- **Pull** keeps the distance handle and Move / Rotate / Scale placement. **Segment length (m)** controls
  the automatic wall spacing, initially based on the shortest source edge. Changing it updates the preview;
  the chosen length is remembered for subsequent extrusions in the session. Up to 512 segments are generated.
- **Path → Selected mesh edges** captures the source edges in blue and clears the live selection. Click the
  first guide edge, then Ctrl-click or Shift-click to select a yellow connected open chain starting at any
  vertex of the source run, including a shared middle vertex. Each guide edge becomes one segment of the
  extrusion. Its existing vertices and Bézier curves are reused as a side or shared seam of the new quads,
  and free edges become surface edges. A middle-start guide needs free edges because new patches fill both
  sides; an end-start guide can also join boundary edges. The source mesh stays unchanged until commit.
  Cancel or switching back to Pull restores the captured source selection.
- When the mountain contains authored paths or rails, the **follow** list also offers those splines.
  Their start is aligned with the source edge centre, and the edge turns along the curve. **Reverse path**
  chooses the other direction; segment length controls the sampling, with extra segments around bends.

## UI

All ops live in the Edit tool as a "Surgery" group; each follows the placement-model conventions
([012](012-props.md)): ghost preview first, wheel to adjust, click/Enter to commit, Esc to abandon.
The cage overlay auto-enables while a surgery gesture is armed. Pole dots (3 orange / 5 violet, as in
the reference view) render whenever the cage is on, so the consequences of a cut are visible
immediately.

## Verification

- Smoke: loop cut on a promoted grid == row insert (byte-compare derived quilt against a reference
  grid of the finer resolution); collapse+knife round-trip restores the starting pole census.
- Every op: derived quilt has no NaN, no crack at shared corners (watertight invariant of
  [006](006-surface-net.md)), `remapIds` preserves every painted/creased/twisted survivor.
- In-browser (Slopesmith:verify): cut, collapse, wedge, dissolve on a seeded mountain; test ride
  (docs/016) still runs after each — the BVH rebuild path is exercised by topology changes.

## Staged build

- **S1 — mesh-ops core + remapIds + manifold guard**; knife + collapse (the pole-makers), unit tests.
- **S2 — loop cut** with ghost/wheel; dissolve ring.
- **S3 — wedges** (data-model extensions) + bridge/cap.
- **S4 — polish**: strip preview shading, pole-consequence hints wired to [021](ideas/021-fidelity-lint.md).
