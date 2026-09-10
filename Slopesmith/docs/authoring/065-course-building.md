# 065 — Building a course, one terrain feature at a time

A convincing course starts with a readable riding line and landforms that explain its shape. Build the
trail as a curved strip of quads, then give the banks, buttresses, snow pockets, ledges and gullies their
own patch layouts. Spend detail where those features meet and where the rider makes decisions.

This guide covers a practical Slopesmith workflow using the HTTP API, browser review and, when needed,
the geometry core. It accompanies the [terrain vocabulary](064-terrain-vocabulary.md),
[scored build loop](066-scored-build-loop.md) and [HATEOAS API contract](../052-hateoas-api.md).
The recipes are construction methods, not fixed course dimensions or universal difficulty settings.

## Start with a feature and its joins

The smallest useful review unit is a bend with its approach and exit, a cliff with its snow foot, or a
takeoff with its landing. An isolated quad does not explain the ride; a whole mountain is too much to
revise at once.

1. Read `GET /api`, follow its guide, schemas and project actions, and inspect `/api/browser`.
2. Write a short riding sequence: staging area, drop, recovery, banked turn, opening slope, optional
   trick line, finish. Reserve space for connections without filling the entire map with terrain.
3. Create a new project, or read the current document and revision before extending an existing one.
4. Build the first track strip, immediate banks and one substantial supporting landform.
5. Review the lit surface, control cage and rider-height approach. Correct shape and topology before
   adding small scenery.
6. Check the surface between and across route samples, including joins with the previous section.
7. Add materials, props and gameplay features; seat them on the finished surface and test clearance.
8. Run the approach, feature and exit with collisions enabled. Save the observed results and a named
   checkpoint, then extend the next section.

Keep the saved lighting active during these reviews. A feature must read from the riding line and
from its reverse side, as well as from a high overview.

## Add landforms before adding patch count

Subdivision adds places to edit. Exact subdivision alone leaves the surface unchanged. A dense wall
can still have the same simple shape as a sparse one, and many small props cannot supply a missing
ledge or canyon recess.

Work at three scales:

| Scale | Authoring decisions |
| --- | --- |
| Course | Sustained pitches, recovery benches, turns, lane choices and major crossings |
| Landform | Projecting buttress, recessed cliff, diagonal gully, snow pocket, shelf and apron |
| Surface detail | Drift lips, fractures, takeoff edges, trail margins, talus and vegetation |

For each landform, identify its footprint, upper rim, lower contact and direction of flow. Let these
boundaries vary independently of the trail's centreline offsets. One side of a turn might rise into a
rideable snow bank while the other narrows against a rock spur. Avoid extending the same cross-section
bands throughout both sides of the mountain.

If a patch layout cannot describe a projecting face and the pocket behind it, replace that local
layout. Fewer patches arranged around the feature can produce more useful detail than repeated
subdivision of long parallel strips. Review the entry and exit of the replacement, too.

## Understand the document before editing it

Read the current `MountainDocument`, `CoursePath`, `RegisterKey`, `AuthoredModel` and `PlacedProp`
schemas. These distinctions matter when writing a construction helper:

| Field | Meaning |
| --- | --- |
| `vertices` | Flat XYZ array in authored metres, Y up |
| `quads` | Four vertex **indices** per patch in tensor order `[A, B, C, D]` |
| `vertexIds`, `quadIds` | Stable identities, distinct from array indices |
| `quadTex`, `quadPaint`, `quadLabels`, `quadTwist` | Dictionaries keyed by quad **index** |
| `quadOrient` | Per-quad texture rotation/mirroring; also keyed by quad index |
| `edgeHandles["a>b"]` | Offset from vertex index `a` to the next control point toward `b` |
| `h/<fromId>><toId>` | Handle register using stable vertex IDs |
| `course` | Route metadata; changing it does not automatically rebuild a custom mesh |

Tensor order `[A,B,C,D]` has perimeter order `[A,B,D,C]`. A helper that accepts perimeter vertices
`[p0,p1,p2,p3]` must store `[p0,p1,p3,p2]`. Maintain consistent winding through each quilt. An upward
normal is a useful check for ordinary snow floors; an overhanging rock face may legitimately have a
downward normal. Do not reverse individual cliff patches merely to make every normal point upward.

Authored coordinates are already metres, Y up. Imported patch files and the renderer can use different
axes and units; read the appropriate coordinate contract before converting them. Never apply a raw
import conversion to an authored document a second time.

Use labels for both section and role, such as `02 Canyon`, `Fast line`, `Upper shelf`, `Rock face`,
`Snow pocket` and `Ground props`. Labels make framing, selection and validation repeatable. Keep
boundary IDs and feature membership in build state; a label is not a substitute for stable identity.

## Construct the track and its immediate banks

Place stations at changes in direction, grade and width. A horizontal frame for a trail travelling
generally toward negative Z can be constructed as follows:

```text
tangent = centre[i+1] - centre[i-1]
right   = normalize([-tangent.z, 0, tangent.x])
point   = centre[i] + right * halfWidth[i] * lateral + [0, heightOffset, 0]
```

Use one-sided tangents at open ends. Check that the horizontal tangent is nonzero. More stations are
useful through a tightening corner or grade transition; a uniform tiny spacing wastes control points.

Allocate narrower patches to trail margins and lips, with broader patches in the interior. For
example, lateral samples `[-1,-0.9,-0.35,0.35,0.9,1]` create five patches across a strip. Choose the
allocation for the feature rather than repeating it as a fixed rule.

Banking can be shaped directly through cross-section heights. A lateral rise measured in metres is
different from the angle stored in `course.bank`. Keep the geometry helper and route metadata clear
about which quantity they accept.

Join rows using shared vertex indices. When extending a section, reuse its track, shoulder and apron
boundary vertices, and retain the previous row when estimating the join tangent. Matching corner
coordinates without shared topology leaves independent surfaces.

Keep recovery space after a drop, before a tight turn and after an optional line rejoins. A shelf
should be actual rideable terrain with a readable entrance, not a path drawn over a steep cliff.

## Shape native Bézier patches deliberately

Each quad derives a bicubic surface from 16 control points: four corners, eight boundary controls and
four interior controls. See [Patch Finish](../020-patch-finish.md) and the
[control-net implementation](../../src/core/mesh/topology.ts).

Start with the native automatic handles on smooth terrain. On regular chains they derive curved
tangents from neighbouring vertices; explicit `edgeHandles` override them. Check `linearCage` if an
entire custom mesh unexpectedly renders as straight-edged patches: that flag is for polygon models
and should not be set on a mountain.

For an intentionally straight cubic edge from `a` to `b`, the directed offsets are:

```text
h[a>b] = (b - a) / 3
h[b>a] = (a - b) / 3
```

Applying this to every edge locks the whole quilt into straight boundaries. Use it selectively for
fractures, constructed edges or a deliberate rock plane. Snow should retain curved boundaries and
coherent tangent planes. Excessively long handles can overshoot or fold a patch; very short handles
can make a smooth-looking cage turn sharply at its corners.

The default interior is a Ferguson construction based on corner positions and incident handles.
`quadTwist` stores four offsets from that construction. A Coons boundary blend can help fit a specific
patch, but applying it across an existing mountain replaces its interior shaping. A generic finish
pass that resets all handles or twists can undo carefully authored terrain.

The tools have different effects:

| Operation | Use and limitation |
| --- | --- |
| Smooth handles (`meshSmoothVertices`) | Removes eligible outgoing overrides so automatic handles return; does not move corners or clear existing twists |
| Reset shape (`meshResetShape`) | Restores eligible automatic corner handles and clears selected interior twists; changes the surface |
| Vertex/brush shaping | Changes geometry; inspect neighbouring patches and re-seat affected scenery |
| Explicit handles/interior controls | Fits a local feature; shared boundary edits also affect its neighbours |
| Exact Bézier subdivision | Adds control without changing the parent surface when all 16 controls are preserved |

Repair the layout before tuning handles. Backtracking rows or a self-crossing snow quad in plan can
produce folded terrain that extra tessellation will not fix. For ordinary snow, check consistent
orientation throughout the evaluated surface, not just at the four corners. Judge vertical rock and
overhangs in their own surface frame rather than forcing them through a heightfield test.

## Refine without losing the original surface

Use de Casteljau subdivision when the desired operation is an exact cut. The core provides
`splitCubic`, `splitPatchU` and `splitPatchV` in [bezier.ts](../../src/core/math/bezier.ts).

For the row-major control net `cp[4 * row + column]`, rows advance in `u` and columns in `v`.
Corners are controls `0,3,12,15`; interior controls are `5,6,9,10`. A child of a zero-twist parent can
require nonzero twists. Copying only its corners and boundary curves, then resetting its interior,
does not preserve the surface.

An exact refinement needs to:

1. Read and retain the parent's full evaluated control net, including current overrides and twists.
2. Split that net into child nets at the chosen parameters.
3. Create consistent child topology, sharing vertices and curves along common edges.
4. Write the corners and all eight directed boundary handles, then derive the four interior offsets
   against that new frame.
5. Re-read the resulting nets and compare evaluated child points with the corresponding parent
   parameter ranges. Check neighbouring patches as well.

`writeQuadControlPoints` in [slide.ts](../../src/core/mesh/slide.ts) implements the inverse storage
operation for a non-collapsed quad. When writing a batch, shared frames must agree before interior
offsets are calculated. The helper skips collapsed wedges; do not treat it as a general topology tool.
Likewise, do not assume every insert or loop-cut operation preserves all interior controls: verify
the particular operation with a surface comparison.

For a smooth snow pillow, shape a coherent parent or continuous region before subdividing it. Adding
the same isolated bulge to every child tends to create repeated ribs and new seam kinks. If shaping
children separately, coordinate their cross-boundary derivatives.

## Change density and direction where features need it

A regular interior quad vertex has four incident edges. A 3-pole or 5-pole has three or five distinct
incident edges. Count unique non-self edges and distinguish interior vertices from boundary vertices.
Pole counts describe connectivity; they are not a quality score.

Use poles to end a row, divert flow around a buttress, or let a narrow bank broaden into a pocket.
Place them in a region with manageable curvature. A steep, twisting junction can crease badly even
when its shared edges have no positional gap. Moving the junction onto a small sloped shelf and
aligning outgoing handles within a common tangent plane can improve the result. Preserve the
surrounding landform; flattening every pole indiscriminately is not a solution.

A local edge rotation can redirect two quads within their existing six-vertex boundary. The endpoint
valences change, allowing paired 3/5 transitions when the surrounding topology supports them. Inspect
the new quad shapes and the adjacent surfaces after the rotation. Prefer the existing topology
operations to hand-editing connectivity and hoping the sparse maps remain aligned.

See [Density Transitions](../018-density-transitions.md) for transition designs; check the live tools
for available operations, since that document also describes staged work. A conforming
all-quad layout has boundary-parity constraints; an arbitrary one-to-two transition is not guaranteed
to work. A collapsed-edge patch `[A,B,C,C]` is a supported wedge with a degenerate row, not an ordinary
four-corner quad or proof of a conforming 3/5 transition. It has no real `C>C` edge.

At a fine-to-coarse contact, record explicit T-junction topology using `{vertex, edge:[a,b], t}` in
`tJunctions`. Preserve the coarse cubic and its exact child subcurves. Coordinate proximity alone does
not define the editable connection. Use the [T-junction utilities](../../src/core/mesh/t-junctions.ts)
to reconcile topology and geometry after edits.

Before changing valence beside finished terrain, retain its actual control nets. If automatic handles
would refit after the change, pin the existing curved values where preservation is required. Replacing
them with chord handles preserves the corners but changes the surface.

After deletion or compaction, remap every index-keyed channel, handle, label membership and T-junction
record while retaining surviving stable IDs and recording removed identities. Use the canonical
[mesh rewrite operations](../../src/core/mesh/ops/contract.ts) and
[deletion implementation](../../src/core/mesh/ops/delete.ts). Never reuse an old build script's array
indices against a compacted document without resolving its stable IDs again.

## Check both position and tangent continuity

**C0 continuity** means the surfaces meet along the same curve. **G1 continuity** means they share a
tangent plane along it. **C1 continuity** additionally matches parameter derivatives. Smooth-looking
terrain generally needs G1 at snow joins; a deliberate rock fracture may keep a crease.

Matching endpoints is insufficient for C0: compare all four boundary controls, or evaluate the full
curves with compatible parameter direction. Matching a shared curve is insufficient for G1: compare
surface normals on both sides along the edge. Native automatic handles are a useful starting point,
but a mixed-resolution interface or extraordinary vertex still needs inspection.

Audit full shared edges **and** partial fine-to-coarse interfaces. A full-edge-only check can report
clean seams while missing kinks along an entire section's coarse entry or exit boundary.

For a smooth fine-to-coarse join:

1. Restrict the coarse surface to the child's edge interval with exact subdivision.
2. Align parameter direction and identify its boundary control row `E[j]` and inward adjacent row
   `I[j]`, for `j=0..3`.
3. Use the same boundary row on the child. A compatible opposite-side inward row can be written as
   `E[j] + lambda * (E[j] - I[j])`, with a positive scale `lambda` shared by all four controls.
4. Coordinate the scale and shared controls between sibling children. Recompute affected twists and
   inspect the join to the child's other neighbours before accepting the fit.

This matches the cross-boundary derivative direction for a regular, non-degenerate boundary. It does
not solve every pole or an incompatible corner layout automatically. If the required controls fight
the adjacent feature, add space for a transition or change the layout instead of forcing the fit.

After any boundary-handle edit, recheck the edited patches and their immediate neighbours. Record
accidental snow kinks separately from intentional rock or lip creases. A single global angle
threshold cannot decide which edges are correct.

## Build the surrounding terrain as connected features

### Buttress, snow pocket and apron

Draw an asymmetric rock footprint and vary the rim height, projection and base position. Give the
face a recess or ledge where its form calls for one. Round the snow cap toward the lip and let it curl
partway down selected faces. A thin flat cap on a repeated vertical ring looks mechanical.

Build the lower snow pocket and apron as surfaces with their own flow. Their edges can converge into
a gully, widen behind a spur or rise against the rock toe. Connect the rideable snow joins; shape a
fillet where a wall meets the bank so that the rider can understand whether it is a carve surface or
an obstruction.

Preserve deliberate hard directions in rock while keeping snow rounded. A diagonal fracture quilt
can cross a larger face, but repeated concentric rings on every outcrop soon become visible as a
construction pattern. Change the feature's layout and contact line, not just its texture or scale.

### Intersecting quilts and visible boundaries

Independent quilts are useful for fractures, snow against a cliff, channels and overhangs. Give each
intersection a clear depth relationship. Nearly coplanar overlap can flicker or create ambiguous
collision.

For a rock fragment embedded in a host face, bury its entire perimeter while allowing the interior
ridge to protrude. Buried corners do not prove that the curved edges stay buried. Sample the complete
boundary curves against the host, using closest points and signed distance along its consistently
oriented normals where the local correspondence is well-defined. Inspect concave corners and ends
from both sides. A vertical height query cannot establish this on a wall or overhang.

A course is an open surface environment. It does not need a bottom, an enclosing box or walls around
the outer map perimeter. Add cliff faces where the rider can encounter or see them. Fix exposed
holes under nearby snow patches by extending the actual apron, bank or cliff foot that belongs
there. Distinguish the intended outer boundary, intentional jump gaps and buried quilt boundaries
from unexplained slits beside the course.

### Bridges, rivers and jumps

Build bridge landing ledges before the deck and supports. Check terrain-to-deck clearance for the
whole rider corridor. Separate supporting posts from the overhead structure when collision hulls
would otherwise span the opening and block the route.

A river needs a channel: its own curved bed, bank contacts and meaningful depth. Painting a blue
strip on an unbroken snow floor does not create one. For a true gap, end the takeoff terrain and
begin the landing separately; the route may pass through the air without terrain spanning it.

Most airtime can come from convex rollovers with continuous terrain beneath them. Use explicit gaps
for deliberate set pieces. Test slow, normal and fast approaches, lateral drift, touchdown slope and
the space needed before the next turn. Build a truck jump's approach and landing as carefully as the
truck itself; a prop is not a complete jump design.

## Use original materials, readable markings and saved lighting

Appearance and physics are separate. `quadTex` selects the image; `quadPaint` selects the surface
response. Check the current [surface types](../../src/core/doc/types.ts): snow is `1`, powder `3`,
slow powder `4`, ice `5`, rock/off-track `9`, wall `10`, and reset `0`. A rock-looking tile does not
make a patch behave as rock. Review the surface-colour mode as well as the textured scene.

For an original asset set, supply terrain tiles, prop models and materials, signs, sky imagery and
the particle sprites actually used. Upload project-scoped texture bytes through the advertised
upload action. Use the returned filename literally when building `Custom/<filename>`; it may already
include `.png` or a collision suffix. Resolve the asset before assigning it to terrain or a model.
Keep provenance and the final asset manifest with the project.

Make the fast lane and its margins readable at riding height. Align ski grooves, edge dashes and
direction arrows with travel through the patch's actual UV orientation. Texture direction is local
to each patch; a rotated or reversed quad can rotate the markings. Check every changed turn, split
and jump approach, and adjust `quadOrient` or the texture variant where necessary. Keep warnings before
the decision point, rather than only on the takeoff lip. Avoid dense repeated arrows that make the
whole slope look tiled.

Set the scene's lighting deliberately and retain that rig while judging materials. Inspect snow,
rock, foliage, undersides and signs in both light and shadow. Dark props can result from normals,
material colour or baked shadows in the texture as well as light intensity. Adjust the cause, then
review it under the same saved rig. Prefer neutral material textures over strong baked illumination
that fights the scene's sun. An unlit review alone cannot validate the finished appearance.

## Dress the landform and preserve the route

Cluster trees by terrain opportunity: a protected shelf, a snow pocket or a broad apron. Vary age,
height, spacing and orientation; leave deliberate openings around the ride. Put talus near rock
toes and recesses. Place spectator structures on real terraces with supported footprints, access
steps and sightlines toward the action.

Use [authored models](../028-authored-models.md) for simple structures or the
[Blender bridge](../046-blender-bridge.md) for more complex assets. Terrain quads are Bézier patches;
authored prop quads are polygon faces. Check model winding and collision separately.

Seat scenery after shaping and again after relevant terrain edits. Check footprint corners and
support lengths, not just a model's centre height. Keep trunk and foliage, rock and snow cap, and
other multipart assets on the same transform. A mismatched rotation can expose a floating cap even
when both parts have the correct centre position.

Separate ground objects from decks, headers and other elevated objects in labels and seating calls.
The ground API samples the upper terrain surface; it cannot choose a lower shelf beneath an
overhang. For those placements, evaluate the intended patch or inspect and fit the object explicitly.
Check seating response counts and skipped IDs.

Rails need a reachable entry, clearance along their full curve and a usable exit. Signs must be
legible before the turn; their supports must stay outside the racing corridor. Inspect canopies,
roofs, braces and collision hulls for intrusion. When a ride reports an obstacle hit, inspect that
placement and the intended line before changing collision settings to make the symptom disappear.

Place fog to add depth without hiding takeoffs or hazards. Put triggers where a rider actually
crosses them, then observe the resulting fireworks or other effects in Test mode. Verify knockable
props by contact and their configured response. Scene preview alone does not prove trigger execution
or knockdown behaviour. See [Effects editor](../026-effects-editor.md) and
[Original particle sprites](067-custom-particle-sprites.md) for custom sprite and export limitations.

## Publish each pass through the API

Follow the actions in live responses; `<id>` below is the returned project ID. These are the main
operations for a small build-and-review loop:

| Operation | Request/body |
| --- | --- |
| Validate a candidate | `POST /api/projects/validate` with `{"document":doc}` |
| Create a project | `POST /api/projects` with `{"name":"MYRIDGE","document":doc}` |
| Read authoritative state | `GET /api/projects/<id>` |
| Replace topology | `PUT /api/projects/<id>/document` with `{"baseRevision":revision,"document":doc}` |
| Assign existing fields/objects | `POST /api/projects/<id>/registers` with `{"changes":[...]}` |
| Sample upper terrain | `POST /api/projects/<id>/ground` with `{"points":[[x,z],...]}` |
| Read route samples | `GET /api/projects/<id>/course?every=5` |
| Seat selected objects | `POST /api/projects/<id>/seat` with `{"ids":["prop:tree-a"],"offset":0}` |
| Name a checkpoint | `POST /api/projects/<id>/checkpoints` with `{"note":"Turn and joins checked"}` |
| Check export assets | `POST /api/preflight?project=<id>` with `{"doc":doc}` |
| Download document and assets | `GET /api/projects/<id>/download?assets=bytes` |

Read the document **before constructing** a topology replacement. Preserve its existing channels,
objects, assets and lighting, validate the candidate, then publish against that read's revision.
On `409`, reconcile the current state or rebuild the change. Attaching a new revision number to an
old full-document snapshot defeats the conflict protection and can erase newer work.

Register assignments replace an object as a whole: read it, modify the intended fields and retain
the rest. In seating requests, `ids` is a top-level field, not `where.ids`; it selects a union with
the label selection. Inspect `seated`, `skipped` and `unchanged`, not just the HTTP status.

Keep candidate construction separate from publishing. Save the input revision, stable boundary IDs,
seeded random choices, candidate document and validation results. Make a checkpoint before a
substantial topology replacement and another after its joins and ride hold up. Do not replay an
initial generator over a later, manually refined document.

## Review through reproducible browser views

The project advertises `browser-view`, `screenshot-view` and `frame-label` links. `/api/browser`
describes execution; `/api/schemas/BrowserView` lists parameters. These links return HTML and need a
WebGL browser. Fetching them over HTTP does not render the scene.

For a label named `label:canyon`, a view can be opened with the following template after substituting
the project ID:

```text
http://localhost:5179/?project=<id>#view=1&label=label%3Acanyon&az=-35&el=35&preset=clean&size=1600,1000&ui=1
```

Use Scene → Camera to read the current position, apply a view, restore it, or copy a view link.
Explicit `pos`/`look` and label framing are mutually exclusive. Label bounds include curved terrain
and placed props, so an incorrectly placed prop can distort framing. Camera URL coordinates use
authored metres, Y up; `data-camera` on the capture-status element uses renderer coordinates with
Z mirrored.

Review the same feature from a few purposeful views:

| View | What to inspect |
| --- | --- |
| `preset=clean`, oblique | Lighting, material boundaries, landform mass and the riding line |
| `preset=topology` | Edge flow, density changes, poles, joins and repeated construction patterns |
| `preset=surface` | Intended physical response of the lane, bank and off-course terrain |
| Low approach and reverse oblique | Clearances, hidden gaps, undercut faces and supported scenery |
| Orthographic plan | Row spacing, narrowing, branch entrances and backtracking snow quads |

Wait for `#capture-status[data-state="ready"]`, then confirm `data-project-id`, `data-revision`
and `data-request`. An error or timeout is not a completed review. Use **Save screenshot** if a PNG
is needed for a separate review record; `size` sets that render buffer, while browser captures can
use different CSS-pixel dimensions.

A camera link is a view, not a historical snapshot. The `revision` fragment parameter checks the live
revision and errors on mismatch; it does not load history. An arbitrary `review` query parameter is
not a history selector either. Keep a checkpoint or document bundle for before/after state. Reload
after document or asset changes if a hash-only navigation retains stale data, and confirm the revision
again. Readiness covers tracked loads and settled frames, not future triggered effects or ride results.

## Validate construction, assets and riding separately

Use the [scored build loop](066-scored-build-loop.md) to keep these checks repeatable.

**Construction:** validate the document; check winding, folds, full shared curves, partial T-seams and
normal continuity. Count boundaries with host edges split at explicit T-nodes, otherwise joined
surfaces can be mistaken for holes. Classify each open loop by purpose. An unexplained interior loop
or edge with too many incident faces deserves inspection even if the chosen camera hides it.

Sample the route between knots and across the lane, including its margins. The ground API is a
vertical top-surface query: at a jump gap it may find a river below; beneath an overhang it may find
the upper quilt. It does not test bridge clearance or identify the intended layer in a canyon. Use
direct patch evaluation, three-dimensional contact checks and browser inspection for those cases.

**Assets and placement:** run preflight, inspect failed loads and skipped seating, and check models
with the saved lighting. Confirm all required textures, models, sky and effect sprites travel in the
portable bundle. A document-only save does not establish that its assets are portable.

**Riding:** open `mode=test` and use **Play** or **Watch the AI**. Test the main line and each optional
line with approach and rejoin included. A section-only probe can miss an entry problem. Run with
props present, observe actual completion, and record hits, resets, stalls and landing failures.
Use a terrain-only run diagnostically to distinguish geometry from obstacle placement.

Sampled checks do not prove every point or every rider trajectory is safe. Report what was checked,
where an intentional gap or crease remains, and which branches or export targets are untested.
Browser readiness, schema validation, asset preflight and successful riding answer different questions.

## Leave a useful handoff

Save the project and portable asset bundle, named checkpoints, view URLs, feature labels, stable
boundary IDs and a concise validation record. Describe the intended route, optional lines, open
boundaries, deliberate creases and any unresolved problems. Record the actual revision and lighting
used for review.

The project download is distinct from a Unity/Snowknife/ISO export. Verify the relevant downstream
pipeline separately before claiming that output is ready. A new author should be able to find the
next feature boundary, understand why its patches are arranged that way, and continue without
reconstructing the previous session's scripts or camera choices.
