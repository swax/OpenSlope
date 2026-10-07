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

From a hovered edge, walk the quad strip through opposite edges in both directions until the strip
**closes** into a ring or reaches the **rim**. Insert one vertex on every crossed edge at fraction `t`
(default 0.5; Alt+wheel slides the ghost line along the strip, as it turns a held prop — the plain wheel
still zooms), split each crossed quad into two.

- **Poles don't stop it.** Entering a quad by one edge always leaves by the opposite one, whatever its
  corners' valence, so the strip is as well defined through a 3/5 pole's patches as anywhere — only a
  vertex-to-vertex edge *loop* is ambiguous at a pole, and a cut walks faces. (It used to stop at any patch
  touching a pole, and refuse the commit: on GARI_DEUX that was 207 of 298 strips.)
- **A triangle ends it conformingly.** A wedge has no opposite edge to leave by, so the cut runs on to its
  far corner and splits it into two triangles (`wedgeEnds`).
- **What it can't end inside hangs.** A seam three or more patches share, the strip coming back across a
  quad it already cut the other way, or a second end in one triangle: the new point stays on that patch's
  unsplit edge as an explicit T-junction, exactly on its curve, as Split's strip ends do (`tStops`, drawn red
  in the ghost). The ghost shows rim ends orange.
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
  Cancel or switching back to Pull restores the captured source selection. **Turn with the path** decides
  how the run follows it: a path along existing surface edges runs the run **parallel** by default, every
  point following an exact copy of the path's curve (a skirt down a terrain edge); a path drawn from free
  edges **turns** it, carrying its frames and point roll. Turning swings a run that reaches far from the path
  through an arc its length times the path's turn — an 82 m run beside a 16 m boundary edge that turns 45°
  had its far end thrown 58 m (GARI_DEUX, extrude2) — so the checkbox overrides either way. A **free** guide edge that turns
  further than one band can follow (45°, `MAX_BAND_TURN`) is cut on its own curve into equal-length pieces
  first (`guideCuts` / `splitGuideEdges`, exact de Casteljau, so the curve does not move), and sweeps as that
  many bands. A single patch asked to turn through a hairpin folds.
- When the mountain contains authored paths or rails, the **follow** list also offers those splines.
  Their start is aligned with the source edge centre, and the edge turns along the curve. **Reverse path**
  chooses the other direction; segment length controls the sampling, with extra segments around bends.
- A turning profile is carried station to station by the least rotation the path makes, and settled
  onto the path's level frame wherever that frame is well defined (`sweepPathFrames`, `levelTrust`): an
  ordinary climbing turn stays exactly level, but a steep or vertical run no longer spins the profile about
  itself (level fixes the sideways axis by the path's heading, which the slightest bend of a near-vertical
  path swings through a half turn). A sweep that starts steep takes its roll from where level first holds.
- Where a turning path bends tighter than the edge run reaches into the bend, the new patches must fold on its
  inside whatever the frames do; the panel names that bend (radius and reach) with a ⚠ note, and Commit
  stays available.

## UI

All ops live in the Edit tool as a "Surgery" group; each follows the placement-model conventions
([012](012-props.md)): ghost preview first, Alt+wheel to adjust, click/Enter to commit, Esc to abandon.
**Loop cut** arms from Edit ▸ Create (⫼ loop cut) or **Ctrl+R**, Blender's key. Edit mode swallows Ctrl+R
even when another tool keeps it from arming, so the browser's reload never lands mid-edit; Ctrl+Shift+R stays
the hard reload, and outside Edit the key is the browser's. The tool stays armed across cuts; Esc leaves it.
The cage overlay auto-enables while a surgery gesture is armed. Pole dots (3 orange / 5 violet, as in
the reference view) render whenever the cage is on, so the consequences of a cut are visible
immediately.

The drawing tools (create edge / patch / tube) put a chain's **first** point on the vertex, edge or surface under
the cursor — a click has no other depth to go on — and every later point on the screen-facing plane through the
previous one, so terrain behind the cursor never pulls a free-standing wall or overhang off to it. **Ctrl** drops
a later point onto the surface; **Shift** locks it to a world axis (`resolvePlacementEndpoint`,
`placementTakesSurface`). Create patch, tube and edge all snap a later point to a vertex under the cursor without
Ctrl. Create edge also snaps it onto a free (construction) edge, which is split there at the exact curve point
(`appendFreeEdge`), so the strands of a wire web share their meeting points and **Create Patches** can fill its
three- and four-sided cells. A surface edge also takes a later point without Ctrl where the chain can cut to it
(`createEdgeCuts`): across a patch its last point touches — so a stroke from one edge of a patch to another splits
that patch, leaving T-junctions where it ends inside shared edges — or, out of a T-junction vertex, along the
routed strip of patches the stroke crosses, which resolves the T as described above. Drawing a split through
the middle of a grid and then out of each T to the rim therefore leaves the grid all conforming quads. Any other
surface edge, or the surface, takes a later edge point only while Ctrl is held — in a busy map one is nearly
always under the cursor (the ghost re-seats on the key itself) — and a free edge ending on a surface edge stays a
T-junction rather than splitting it. A surface cut that has already crossed a patch keeps sticking because only
an edge or a point can continue it (`createEdgePlacement`). Esc ends
the strand being drawn and keeps the tool armed; a second Esc, or Enter, leaves it with every edge drawn
selected (a selected edge that a later strand split is carried as its halves). Create trail is drawn over the ground, so each of its knots takes
the surface; paste has no chain and does too.

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
