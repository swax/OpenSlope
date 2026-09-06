# 045 — Protected-region retopology benchmark

The first retopology milestone is deliberately offline. It establishes which external quadrangulator gives
SlopeSmith the best topology before the editor commits to a dependency or a conversion pipeline.

## Contract

Locked patches are the preserve seed. `collarRings` grows that seed through edge-adjacent patches (0–3 rings).
Those patches remain the original bicubic quilt. Only the complement is tessellated and sent to an external
tool. The cut interface is written to `constraints.json` as samples of the **exact cubic patch edges**, with
the original stable vertex and patch ids retained in the sidecar.

The prepared directory contains:

- `input.obj` — seam-welded triangles for the remeshable remainder;
- `protected.obj` — visualization of the exact frozen selection and collar;
- `constraints.json` — stable protected identity, interface curves, area, and target face count;
- `report.json` — normalized candidate scores after `run` or `score`.

OBJ is only interchange. `benchmark:retopology-integrate` turns a winning all-quad OBJ into an editable
SlopeSmith mountain while retaining the protected bicubic patches exactly.

## The secret recipe: prescribed conforming join

The production whole-mountain pipeline makes the locked-feature seam conforming **by construction** instead of
by luck (`ideas/042`). Every numbered item is load-bearing; the failure that motivated it is noted inline:

1. **Solve with the locked feature as a real boundary hole.** The resolution-1 whole-mountain proxy keeps the
   global edge-flow context of the free solve, but the locked rim is a true hole, not an internal feature cut
   after smoothing. An internal-guide proxy can bridge close parallel banks, and its post-hoc footprint cut is
   what used to tear rims. A plain first solve still runs the free path, but its two failure classes — a
   crossing-repair spiral and a rim too coarse for the protected corners — both convert to the
   boundary-constrained retry, so every whole-mountain job reaches this recipe.
   `SLOPESMITH_RETOPOLOGY_HOLE_MODE=always` skips the doomed first solve.
2. **Prescribe the quantization; never beg for it.** `prescribe.ts` matches each locked rim among the remesh
   boundary loops, pairs the traced layout corners to authored corners with a cyclically monotone min-max
   assignment, physically moves in-gate layout corners onto their authored corner (rewriting `input_rem_p0.obj`
   with intermediate rim vertices redistributed along the original polyline), and writes
   `input_rem_p0.fixed`: per-subside edge **counts** summing to exactly one candidate edge per protected
   corner, plus strictly increasing arc-length **fractions** that place every rim vertex at its authored
   corner's projection. The patched `quad_from_patches` pins counts as hard lower==upper bounds in the BiMDF
   solve, lands boundary vertices exactly via the UV arc-length override in `computeQuadrangulation`, and pins
   prescribed rim loops through `MultiCostraintSmooth`, which otherwise slides them metres along the feature.
3. **Pin nearby unlocked holes at remesh resolution.** Freely quantized, a small authored hole near the
   interface collapses to a few target-size edges whose ring quads reach across the locked outline.
4. **Never cut a hole-mode candidate.** The locked feature is already a hole, so every positive-area footprint
   overlap is a leaning first-row face — there is no interior sheet to remove, and cutting removes leaning
   clusters wholesale, tearing the prescribed rim. Instead `nudgeLeaningFacesOffLockedFootprint` slides the
   offending interior vertices outward in top view before integration. Screens must respect two subtleties:
   rim vertices sit a prescription residual (worst authored projection, ~1.4 m observed) off their corner, so
   area tests snap them onto the corner first or the whole rim reads as sliver overlap; and the bicubic
   outline bulges outward past the chord near corners, so a second area test splices each rim chord to the
   sampled curve to catch bulge dips that every chordal screen misses.
5. **Repair seams by nudging, never by deletion.** Deleting a first-row face changes the rim's boundary-loop
   topology, which a conforming join can never absorb. The seam-repair loop marches crossing vertices along
   candidate outward directions (each anchor's outline normal plus their bisector — a concave pocket defeats
   any single direction) with escalating clearance margins, re-integrating with the conforming options between
   passes. Geometry that cannot clear — an unlocked hole grazing or sharing the locked outline — falls back to
   the transition-collar join instead of failing.
6. **Judge the footprint like a conforming join.** The trail and first row share the rim curve exactly, and
   the acceptance gate's two independent piecewise-linear samplings of that same cubic always interleave in
   hairline slivers; zero-overlap can never pass. A direct join is gated on centroid penetration depth (1% of
   target patch size, sampled at resolution 8+) — genuine leans measured 0.5 m+ against a 0.03–0.16 m sliver
   floor. All other gates (components, inversions, locked controls, T-junction validity, snap, aspect,
   surface deviation) are unchanged.

The sequence:

```text
locked source -> whole-mountain resolution-1 proxy, locked features as real holes
              -> corner-conformed rim prescription: counts + arc fractions in input_rem_p0.fixed
              -> QuadWild automatic field; pinned BiMDF quantization; exact UV boundary placement;
                 rim pinned through smoothing
              -> nudge leaning first-row faces clear of the footprint (no cut)
              -> conform rim to protected corners -> direct conforming integration (no refinement)
              -> seam repair by vertex nudging with escalating margins
              -> height fit -> conforming-aware validation (centroid-depth footprint gate)
```

The direct join is the default for prescribed solves (`SLOPESMITH_RETOPOLOGY_DIRECT_JOIN=0` opts out). Checked
results, all one component with zero T-junctions, zero inverted patches, and zero locked-control deviation:
MOUNTAIN01_4 joins 40-to-40 (previously 40-to-74 with 31 T-junctions via the collar), MOUNTAIN01_5 joins
108-to-108 across a hairpin with steep banks, and MOUNTAIN01_6 joins two disconnected locked regions at
174-to-174 in one solve, validated at 25, 32, and 40 m targets.

## The old secret recipe: the free-solve secret sauce

The original benchmark recipe is retained as the baseline the prescribed pipeline is measured against; its
conforming 60-to-60 join depended on the quantizer landing the right count by luck, which is exactly what the
prescription now guarantees.

The preferred MOUNTAIN01_2 result was not produced by one magic QuadWild setting. It needed the following
pipeline as a whole; removing any of the bold items recreated one of the failed candidates:

1. **Keep the authored trail exact.** Its 56 locked bicubic patches, paint, texture, and control points are the
   protected result, not merely reference samples for a replacement trail.
2. **Give edge flow global context.** Triangulate the whole welded trail-and-mountain surface for the topology
   solve. A small old-grid collar fixes the flow too early and concentrates poles, T-nodes, and skinny quads at
   the trail boundary.
3. **Use a resolution-1 topology proxy.** Each authored patch contributes only two triangles. QuadWild decides
   connectivity and edge flow from that proxy instead of mistaking an 8x8 render tessellation for required
   control-patch density. The full bicubic source is retained separately for later fitting and validation.
4. **Keep the exact trail perimeter as an internal hard feature.** The accepted proxy contains the complete
   60-edge trail loop. QuadWild's automatic field performed better here than the experimental trail-diffused
   4-RoSy field. Removing the internal hard feature let the solver shortcut across the hairpin and produced a
   20-edge hole that could not preserve the trail shape.
5. **Choose density at the control-patch scale.** QuadWild `scaleFact 1.6` on this resolution-1 input corresponds
   to a 21.51 m nominal patch and yielded 2,249 candidate quads. Coarsening the high-resolution proxy did not
   cure the dense turn ring; reducing the information given to the topology solve did.
6. **Reinsert the exact trail after the global solve.** Cut every face with positive-area intersection against
   its top-down footprint (zero buffer rings), then integrate the original locked patches. Testing the complete
   candidate polygon rather than only its center prevents a coarse quad from crossing over and covering a narrow
   locked trail; boundary-only contact is retained. The accepted solve happens to expose 60 candidate hole
   edges for 60 protected edges, so the final join is conforming: no grid collar, edge split, or T-node.
7. **Restore the bicubic surface without overfitting the sub-cage.** Vertically seat generated cage vertices on
   the full source surface, derive smooth shared Bessel edge handles, and leave generated interiors as zero-twist
   Ferguson controls. That matches the source mountain's effectively zero interior-twist convention. Independent
   four-control fits lowered sampled surface error but created 11.194 m p95 / 25 m maximum offsets and the visibly
   oscillating patches that the scalar error score missed.
8. **Treat validation as part of the algorithm.** Reject disconnected components, moved protected controls,
   inverted patches, invalid T-nodes, and non-finite or excessive surface error. Also inspect control-offset,
   edge-length, aspect, pole, and interface distributions; surface deviation alone is not an acceptance test.

For this checked result the sequence is therefore:

```text
locked source -> whole-surface resolution-1 triangle proxy + exact trail feature
              -> QuadWild automatic field, scale 1.6
              -> cut exact trail footprint -> reinsert 56 original patches
              -> seat generated vertices on full bicubic source
              -> shared Bessel edges + zero-twist Ferguson interiors
              -> topology, interface, control-cage, and surface validation
```

The resulting map has 56 exact trail patches plus 2,191 generated mountain patches, one component, a 60-to-60
interface, no T-nodes, no inverted patches, 19.67 m median / 26.53 m p95 cage edges, and 1.25 median / 2.00 p95
aspect ratio. These are the reference invariants for productization; an editor or server implementation should
produce the same intermediate contract rather than invoke QuadWild directly on render tessellation.

### What the rejected experiments taught us

| Experiment | Failure | Lesson retained |
| --- | --- | --- |
| Retopologize the mountain outside an old-grid collar | Grid-shaped seam, crowded transitions, T-nodes | Solve flow broadly; reinsert only the exact trail |
| Resolution-8 triangle input | 134-edge tight-turn ring and excessive local density | Rendering samples are not topology requirements |
| Globally coarsen the resolution-8 solve | The dense turn ring remained | Simplify the proxy before changing the target size |
| Remove the internal trail feature | Hairpin shortcut and a 20-edge trail hole | The complete trail loop is a hard constraint |
| Custom trail-diffused 4-RoSy field | More quads/poles or worse surface error for little alignment gain | Keep QuadWild's automatic field until a better field wins the benchmark |
| Preserve a generated trail collar | Small/skewed transition quads and a 134-to-60 interface | Prefer a conforming 60-to-60 exact-trail join |
| Fit four interior controls independently per patch | Great scalar fit, visibly wild controls and distorted blending | Default generated terrain to shared zero-twist Ferguson controls |
| Instant Meshes / QuadriFlow baseline | Excess poles or a disconnected/poorly aligned trail interface | QuadWild-BiMDF remains the production candidate |

## Integrated collar-free result

For a trail, use `collar 0`: only locked trail patches are retained. The integration layer does **not** keep an
old grid-shaped source ring. It instead:

1. pairs each remesh hole with the exact protected cubic loop;
2. locally strip-splits coarse boundary quads wherever QuadWild skipped an original trail corner;
3. makes the split's opposite points explicit dependent T-nodes;
4. solves a harmonic boundary-displacement field from the exact trail through the generated mountain while
   holding the true outer rim;
5. untangles low-Jacobian quads with T-nodes constrained to their host edges;
6. preserves the locked trail's full 16-point bicubic patches, subdivides its cubic boundary handles exactly,
   and derives smooth Bessel/Ferguson handles for the generated terrain.

The result is one connected editable mesh. Triangles are never introduced by integration. The packager refuses
an output with an inverted candidate patch, a moved protected control point, a disconnected component, or an
invalid T-node, and records a tessellated bicubic surface-deviation score in `Retopology.json`.

```powershell
npm run benchmark:retopology-integrate -- `
  --source ../Maps/MOUNTAIN01_2/MOUNTAIN01_2.slope.json `
  --candidate C:/path/to/quadwild_quadrangulation_smooth.obj `
  --constraints C:/path/to/retopo-run/constraints.json `
  --out ../Maps/MOUNTAIN01_2_RETOPO_QUADWILD_INTEGRATED `
  --name MOUNTAIN01_2_RETOPO_QUADWILD_INTEGRATED `
  --quality-resolution 4
```

The checked MOUNTAIN01_2 inspection result uses QuadWild's 23.6 m quantization: 56 exact locked patches plus
2,649 generated quads, one component, zero inversions, a 3.334 m maximum pre-integration boundary correction,
and effectively zero protected/T-node error. At quality resolution 4 its source-to-result bicubic deviation is
3.374 m at p95 and 11.161 m maximum. These are benchmark facts, not yet production defaults.

A high-resolution trail-diffused 4-RoSy comparison reduced median near-trail cross-field error by only 2.2° on
this source while increasing maximum surface error from 10.6 m to 18.8 m. It is therefore retained as research,
not promoted over the automatic QuadWild field. Better global field optimization remains the next flow-quality
milestone; the stitching/integration layer is independent of that choice.

## Whole-surface experiment

`prepare --whole-surface` implements the alternate topology-first experiment: tessellate the entire welded
mountain and trail into one triangle mesh, keep the locked trail boundary as an **internal** field/feature guide,
and let the quadrangulator replace all source connectivity. There is no protected hole, retained grid collar,
seam snap, or integration T-node. Locks, paint, and textures are transferred to the resulting patches by nearest
source-surface ownership. This preserves the authored feature semantics, not the trail's original patch ids or
connectivity.

```powershell
npm run benchmark:retopology -- prepare `
  --input ../Maps/MOUNTAIN01_2/MOUNTAIN01_2.slope.json `
  --out ../temp/retopo/MOUNTAIN01_2-whole `
  --whole-surface `
  --target-size 25 `
  --resolution 8
```

The integrator runs a bounded quad-shape regularization pass after fold repair. It improves edge-length,
aspect-ratio, and corner-angle consistency while holding the mountain's outer boundary and refusing inverted
patches. The checked automatic-field candidate is packaged at
`Maps/MOUNTAIN01_2_RETOPO_QUADWILD_WHOLE`: 2,274 replacement quads in one component, no T-nodes or inversions,
20.24 m median / 30.06 m p95 cage edges, 1.43 median / 2.94 p95 aspect ratio, and 4.459 m p95 / 13.632 m maximum
source-to-result bicubic deviation. Its minimum corner Jacobian is 0.025, so this remains an inspection candidate,
not a production-quality acceptance threshold.

A coarser 29.2 m quantization landed at 1,853 quads, nearly the source's 1,858 patches, but was rejected: after
the same repair its p95 aspect ratio was 3.17 and its p95 / maximum bicubic deviation rose to 5.319 / 19.800 m.
Matching the old patch count was therefore a worse trade than the denser candidate's consistency and surface fit.

On the same whole-surface input, the custom trail-diffused field produced more quads and poles without improving
the measured near-trail cross-field alignment. It is retained as a rejected diagnostic; the automatic QuadWild
field is the current inspection winner.

### Exact-trail hybrid

`benchmark:retopology-integrate -- --trail-buffer --footprint-rings 1` reuses the successful whole-surface flow
while retaining the original locked trail. It removes QuadWild faces inside the exact top-down trail footprint
plus one face ring, inserts one generated trail-shaped collar quad per authored trail boundary edge, and places
all candidate/source edge-count mismatch on the collar's outer boundary. Ordered chord-length subdivision keeps
those extra vertices as explicit T-nodes without crowding them onto the trail edge.

```powershell
npm run benchmark:retopology-integrate -- `
  --source ../Maps/MOUNTAIN01_2/MOUNTAIN01_2.slope.json `
  --candidate ../temp/retopo/runs/MOUNTAIN01_2-whole-auto-r8/input_rem_p0_180_quadrangulation_smooth.obj `
  --constraints ../temp/retopo/runs/MOUNTAIN01_2-whole-auto-r8/constraints.json `
  --trail-buffer --footprint-rings 1 `
  --out ../Maps/MOUNTAIN01_2_RETOPO_QUADWILD_EXACT_TRAIL `
  --name MOUNTAIN01_2_RETOPO_QUADWILD_EXACT_TRAIL `
  --quality-resolution 4
```

The checked candidate retains all 56 original trail patches and adds a 60-quad protected collar around 2,019
retopologized mountain patches. The collar has 20.37 m median / 34.61 m p95 edges, 2.15 median / 3.54 p95 aspect,
and 0.049 minimum corner Jacobian. Its 134-edge outer hole maps to 60 collar edges through 74 exact T-nodes.
The generated mountain has zero inversions, 1.39 median / 2.86 p95 aspect, and 4.502 m p95 / 14.094 m maximum
bicubic surface deviation. Two pre-existing three-edge QuadWild pinholes are capped as SlopeSmith collapsed-edge
wedges; they are the only triangle exceptions. This is an inspection candidate, not yet a production default.

### Bezier-aware low-density proxy

The dense tight-turn ring was not caused by the authored trail: its 28 lengthwise spans (56 patches) use the
same measured spacing range as the retail center-line samples. It came from asking QuadWild to infer control
topology from the 8x8 render tessellation. Both the 20 m and 24 m whole-surface solves retained the same local
134-edge trail ring, so globally coarsening that mesh did not reduce the visible turn density.

The accepted low-density experiment instead gives QuadWild a resolution-1 topology proxy: two triangles per
authored patch, plus the exact 60-edge trail perimeter as an explicit feature. The proxy determines only edge
flow/connectivity. After the exact locked trail is reinserted, generated vertices are vertically seated with a
25 m ambiguity bound, while generated patches retain zero-twist Ferguson interiors derived from their smooth
shared boundary handles. This matches the source mountain: its unlocked interior-control offsets have a zero
median, effectively-zero p95, and only 7 mm maximum numerical residue. An optional experimental mode reduces
patch-local estimates to a bounded, smoothed value per shared cage vertex, but it did not improve p95 error.

The checked map is
`Maps/MOUNTAIN01_2_RETOPO_QUADWILD_EXACT_TRAIL_BEZIER_LOW_DENSITY`. At QuadWild scale 1.6 (21.51 m nominal),
the candidate has 2,249 quads. Cutting 58 trail-footprint faces leaves an exact 60-edge hole; the result is 56
unchanged locked trail patches plus 2,191 generated mountain patches in one component. The join is 60-to-60,
with no collar, no T-nodes, no inverted patches, and a 0.031 minimum cage-corner Jacobian. Generated cage edges
are 19.67 m median / 26.53 m p95 and aspect ratios are 1.25 median / 2.00 p95. Fitting seats 2,206 vertices; all
2,191 generated patches use coherent zero-twist interiors. Source-to-result bicubic deviation is 2.545 m p95 /
17.086 m maximum. The discarded independent per-patch fit scored 1.327 m p95 but produced 11.194 m p95 / 25 m
maximum interior offsets and visibly oscillating control cages; surface error alone did not expose that failure.

This is 112 patches more globally than the earlier 2,135-patch exact-trail hybrid, but removes its 60-patch
collar and 134-edge / 74-T-node local interface. It is therefore the preferred visual-density comparison near
the tight turns and is the topology recipe used by the first production editor job.

Rejected controls are retained as benchmark evidence: removing all internal hard features produced a 20-edge
hole that shortcut across the hairpin and inverted a collar; the 22.86 m resolution-1 solve reduced the total
further but its required 58-to-60 boundary split left one severe fold. Neither is packaged as an inspection map.

## In-editor production workflow

In Edit mode with nothing selected, **Retopology → Retopologize…** opens the whole-mountain job panel. Lock a
trail or other terrain feature first. “Whole mountain — preserve every locked region” sees the entire connected
mountain, rebuilds every unlocked patch, and cuts one protected opening for every disconnected locked region.
Apply reinserts all of those patches with their original ids, 16-point bicubic cages, locks, surface properties,
textures, orientations, and paint. They are integrated terrain, not omitted from the solve or returned as
separate islands. The 2.5D footprint path requires locked features to remain internal rather than touch the
mountain's outer rim.

Selecting authored patches adds **Retopologize region…** to that selection's Topology actions. This scope
requires one edge-connected selected region, but permits any number of locked islands inside it. Selected
unlocked patches plus zero to five influence rings are rebuilt; locked patches and every patch outside that solve
are reinserted exactly. The selection must leave one frozen patch ring at the mountain rim. Influence growth
automatically stops at that ring, so increasing it cannot accidentally turn a regional job into a whole-mountain
replacement.

The editor sends an immutable document snapshot to the server and polls a bounded native-job queue. The live
mountain does not change while QuadWild runs. A result is offered for Apply only after it passes connectedness,
interface, inversion, patch-distortion, locked-control, T-junction, and sampled bicubic surface-deviation checks. Apply first asks
project storage for a `before retopology` checkpoint and then publishes the replacement through the ordinary
bulk topology/history path. If the live document changed after the snapshot, Apply is refused and the job must
be rerun.

The native handoff is deliberately exact:

1. tessellate the whole mountain, or only the selected solve, at resolution 1 (two triangles per authored patch);
2. write every open solve boundary and internal locked/unlocked interface to `input.sharp`;
3. invoke `quadwild input.obj 2 input.sharp basic_setup_Organic.txt` — the explicit sharp argument is required;
4. run `quad_from_patches` with `flow_noalign_lemon.txt`, calibrated to `scaleFact 1.6` at a 25 m target;
5. for a first whole solve, cut candidate faces inside every protected top-down footprint; for a selected solve,
   retain the candidate's outer boundary and locked holes directly;
6. minimally refine only a coarse interface, distribute surplus boundary vertices by ordered chord length so
   none collapse onto the same protected corner, and reinsert every exact protected bicubic patch;
7. vertically fit the generated cage to the frozen source with coherent zero-twist interiors, then transfer
   surface and paint from the nearest replaced patch.

Target patch size directly scales the native QuadWild density around that validated 25 m / 1.6 calibration.
QuadWild normalizes every input to roughly the same intermediate triangle count, so regional jobs compensate by
inverse square root of physical solve area. Their native scale is capped at 5: a coarser regional candidate can
fold when it is seated on a comparatively dense frozen boundary. The advanced density calibration remains
exposed for comparison work. Jobs default to one native worker and keep their result for 30 minutes.

The server prefers a built QuadWild-BiMDF checkout at `../quadwild-bimdf` relative to the Slopesmith app
(the gitignored repository-root checkout), with the prescribed-subside patches applied — see
[`tools/retopology/quadwild-patches/README.md`](../tools/retopology/quadwild-patches/README.md), which covers how to apply them, the
licenses they and the solver carry, and the optional not-free-software dependency its build can pull in.
The former `../temp/retopo/quadwild-bimdf` location remains a compatibility fallback when it already exists.
Deployments can instead set `SLOPESMITH_QUADWILD_ROOT` and, when binaries live elsewhere,
`SLOPESMITH_QUADWILD_BIN`. `SLOPESMITH_RETOPOLOGY_CONCURRENCY` permits one to four concurrent native jobs. The
capabilities endpoint reports a missing executable or config to the editor instead of enabling Run.

The production MOUNTAIN01_2 smoke solve completes as 56 exact locked patches plus 2,191 generated patches: one
connected component, a 60-to-60 interface, zero T-junctions, zero inverted patches, and effectively zero locked
control-point movement. Generated cage edges are 19.67 m median / 26.53 m p95, aspect ratios are 1.25 median /
2.00 p95, and the resolution-4 source-to-result bicubic deviation is 2.43 m p95 / 17.09 m maximum.

The current `MOUNTAIN01_3` plural-lock smoke has 120 exact locked patches in two disconnected regions plus 2,161
generated mountain patches (2,281 total). Its two direct joins expose 128 protected versus 150 generated edges,
represented by 22 explicit, gap-free T-junctions. It remains one component with zero inversions and effectively
zero locked-control movement. Generated edges are 19.28 m median / 25.47 m p95; aspect is 1.25 median / 1.91 p95,
and symmetric sampled surface deviation is 13.33 m maximum.

### Repeat whole-mountain retopology

`MOUNTAIN_RETOPO_1` exposed a failure that manifold/component tests cannot see: a cyclic boundary match could
attach the mountain's right bank to the trail's left bank and vice versa. The result remained one connected
surface, but both terrain banks reached across and overlapped the trail. The first repair strategy removed each
crossing face and enlarged the candidate hole. On this map that changed a 202-edge hole to 238, 256, then 274
edges and eventually merged the trail hole with the mountain rim. A global cyclic match could avoid a proper edge
crossing only by choosing the visually wrong bank swap. More seam deletion was therefore not a valid repair.

A repeat whole-mountain solve now has a distinct preparation path whenever the saved source already contains
T-junctions:

1. QuadWild receives the locked trail as a real hole boundary rather than as an internal feature that is cut only
   after smoothing. This prevents its triangle proxy from bridging the two close, parallel hairpin banks.
2. The smoothed candidate is cut again against the exact protected footprint at resolution 4 or better, and its
   largest boundary is re-seated on the original bicubic mountain rim.
3. Existing candidate boundary knots are cyclically assigned to an ordered subset of protected trail corners.
   Besides the usual distance/shape terms, the assignment charges each interval's drag onto its own straight
   outer collar chord: where the hole boundary bulges outward, corners trace the bulge instead of letting one
   chord cut it off and drag the first row across itself. Only genuinely omitted corners are strip-split; the
   saved reproduction had 83 candidate edges for 84 trail edges, so exactly one edge was split.
4. One trail-shaped transition collar patch per protected boundary edge is constructed. Its inner edge is the
   exact locked trail cubic; its outer corners follow the remesh and are pushed outward only when the collar
   would be narrower than half the target patch size. Each push is checked against the candidate's post-snap
   radial first-row edges and locally backed off where a pushed chord would cross them. Collar corner order is
   chosen per quad so the patch normal faces upward — the host loop's traversal direction would otherwise
   render the whole ring back-faced. The edge-count/phase decision is thus made next to the correct bank
   before general stitching.
5. The original 80 locked patches remain control-point exact. The generated collar and mountain are vertically
   re-seated on the frozen source and receive the same shared Bessel / zero-twist Ferguson controls as an ordinary
   solve.

The acceptance gate now measures positive-area protected-footprint penetration, not only proper edge crossings.
An ordinary first pass still permits no generated overlap. The repeat collar permits only a shallow tessellation
contact: maximum centroid depth is 8% of target patch size and overlap-triangle count cannot exceed the number of
persistent locked patches. For comparison, the rejected bank-swapped sheet produced 1,749 overlapping triangles,
1,050 interior centroids, and 6.318 m maximum penetration. The accepted collar produced 7 overlap triangles, 2
interior centroids, and 0.835 m maximum penetration at a 25 m target.

The current saved `MOUNTAIN_RETOPO_1` reproduction validates as 80 exact locked trail patches, 84 transition
patches, and 2,198 remeshed mountain patches (2,362 total): one component, an exact 84-to-84 interface, zero
crossing interface edges, zero T-junctions, zero inverted patches, and zero locked-control deviation. Generated
cage edges are 22.78 m median / 30.06 m p95; aspect ratio is 1.16 median / 1.78 p95 (6.90 maximum), and symmetric
sampled surface deviation is 10.97 m maximum. This is the production regression for the close-bank repeat path.

The first `MOUNTAIN01_4` production attempt showed that zero saved T-junctions do not prove the internal-guide path
is safe. Its local crossing repair oscillated upward and finally merged the 2 candidate boundary loops into 1.
That loop-count change now aborts face deletion and automatically reruns QuadWild with the locked feature as a
true boundary. The transition collar retains the cyclic candidate-knot assignment chosen during construction;
integration cannot independently re-phase it. Collar outer edges use bounded endpoint chords because a fitted
cubic through outward-adjusted endpoints can overshoot back across the collar.

A candidate face that still crosses a collar chord after integration is repaired in bounded passes. The collar is
first rebuilt with a halved minimum width — down to roughly an eighth of the target patch size — because near a
tight feature it is the minimum-width push itself that fans chords across the candidate's first rows, and a
narrow transition patch is valid geometry while a crossed one is rejected outright. Only after the width ladder
are crossed faces removed, and every removal must strictly reduce the crossing count: enlarging the hole can also
create fresh crossings, and that spiral is how a feature hole ends up merged into the mountain rim. A job whose
crossings survive the ladder is rejected with the crossing report. On this source, targets through 32 m validate;
40 m and coarser cannot fit even the narrowed collar through the elbow's clearance and are rejected. The
prescribed conforming join (the secret recipe above) serves those geometries without a collar at all, and the
collar path remains its fallback for rims a nudge cannot clear.

The checked 25 m fallback for `_4` retains 36 exact locked patches, adds 40 transition patches, and produces 5,447
mountain patches (5,523 total): one component, a 40-to-74 interface with 31 exact T-junctions, zero crossings,
zero protected-footprint penetration, zero inversions, and zero locked-control deviation. Numerically flat
boundary quads that carry a redundant surplus knot — whether the flat knot's face has three or four interface
corners — are encoded as single collapsed-edge triangles; splitting one into two wedges introduced a new diagonal
through the collar and was rejected. Generated edges are 14.70 m median / 18.30 m p95, aspect is 1.16 median /
1.46 p95 (4.30 maximum), and symmetric sampled deviation is 14.51 m maximum.

A zero-T-junction two-row collar built by mechanically subdividing the existing candidate was tested and rejected:
although topologically conforming, it introduced flipped normals, flat/creased patches, irregular sizes, distorted
controls, and visibly worse surrounding terrain. The direct T-junction join remains the preferred initial global
integration when protected/candidate loop counts differ; it no longer has to be permanent.

**Retopology → Make seam conforming…** is the follow-up local repair. It recognizes T records hosted by locked
feature boundaries — growing a locked region through complete unlocked rings (bounded) when the seam is instead
recorded on a transition collar's outer boundary, so a buffered whole-mountain result conforms too — removes only
the complete unlocked one-ring (or the requested 2–3 rings), and treats the exact locked loop and exact
retained-terrain loop as prescribed boundaries of an annulus. A dynamic quadrangulation uses
ordinary `(1,1)` rail quads plus `(2,0)` / `(0,2)` transitions to absorb boundary-count differences as 3/5 poles.
Collapsed-edge triangle wedges carry a prohibitive cost and occur only when parity or local validity makes an
all-quad strip impossible. The operation pins every retained Bessel handle whose neighborhood changes, so both the
locked bicubic feature and every patch outside the rebuilt collar are control-point exact. It rejects disconnected,
non-manifold, inverted, or moved-exact results before enabling Apply and commits through the same undoable bulk-edit
checkpoint as native retopology.

The bridge search also rejects any new cell whose projected radial edge crosses the locked footprint. New internal
bridge edges receive explicit linear first-span handles, preventing extraordinary-pole Bessel inference from aiming
control points underneath the surface; exact locked and retained boundary handles remain authoritative.

On the MOUNTAIN01_4 32 m buffered result, one conforming ring removes all 17 recorded T-junctions (83 patches out,
61 rebuilt, 6 wedges, worst new aspect 16.8); two rings trade more replaced terrain for better shapes (149 out, 64
rebuilt, 4 wedges, worst aspect 11.9). Either way the exact trail, the transition collar, and all outside terrain
measure zero bicubic-control deviation, and the count mismatch that the T-nodes had carried becomes ordinary 3/5
poles in the rebuilt ring.

On the current saved `MOUNTAIN01_2` repeat-retopology state, the one-ring pass repairs two locked seams, removes all
22 recorded T-junctions, replaces 157 old collar patches with 145 new patches, produces one component with zero
inverted patches and zero triangle wedges, and measures exactly zero locked/outside bicubic-control deviation. Its
worst new cage aspect is
10.74, so the panel presents a yellow inspection warning above 8 rather than silently treating topology validity as
visual approval. Two rings reduce that worst aspect to 7.31 but increase maximum sampled surface deviation; one ring
therefore remains the conservative default.

A regional smoke job seeded by the 56-patch trail with two influence rings replaces 101 source patches with 263
generated patches while keeping 1,757 outside/locked patches exact; it returns one component, 44 valid interface
T-nodes, zero inversions, and 3.60 m maximum sampled deviation. “Validated Result Ready” currently exposes this
report and Apply/Discard; it does not yet draw a temporary result in the viewport.

## Prepare

Save the project so its `mountain.slope.json` contains the current locks, then run:

```powershell
npm run benchmark:retopology -- prepare `
  --input "C:\path\to\mountain.slope.json" `
  --out "C:\path\to\retopo-run" `
  --collar 1 `
  --target-size 30 `
  --resolution 8
```

The loader accepts the stable-id keyed file written by the server. Target faces are `remeshable area /
target-size²`, making the three tools comparable under the same patch-size request.

## Run candidates

Copy `tools/retopology/runners.example.json`, update executable/config paths, and run:

```powershell
npm run benchmark:retopology -- run `
  --dir "C:\path\to\retopo-run" `
  --config "C:\path\to\my-retopology-runners.json"
```

Runner strings can use `{dir}`, `{input}`, `{output}`, `{targetFaces}`, and `{targetPatchSize}`. Commands are
spawned directly without a shell. Output and errors are retained under `logs/`.

The checked example reflects the upstream CLIs:

- QuadWild-BiMDF runs `quadwild` preprocessing followed by `quad_from_patches`; it produces the native
  `_rem_p0_<seed>_quadrangulation_smooth.obj` result (`123` in the checked runner example).
- Instant Meshes runs deterministic four-way orientation/position fields, requests the common face target,
  and enables open-boundary alignment (`-b`).
- QuadriFlow requests the common face target and sharp preservation.

Candidate versions and exact configs belong beside each benchmark report. QuadWild in particular exposes
important quality/runtime choices in its configuration files; treating the executable name as a complete
configuration would make results irreproducible.

An already-produced OBJ can be scored without a runner:

```powershell
npm run benchmark:retopology -- score `
  --dir "C:\path\to\retopo-run" `
  --candidate instant="C:\meshes\instant.obj" `
  --candidate quadriflow="C:\meshes\quadriflow.obj"
```

## Inspect candidates as SlopeSmith reference maps

After scoring, package every candidate together with the exact protected trail/collar:

```powershell
npm run benchmark:retopology-maps -- `
  --source ../Maps/MOUNTAIN01_2/MOUNTAIN01_2.slope.json `
  --benchmark ../temp/retopo/runs/MOUNTAIN01_2-c1-s25 `
  --maps-root ../Maps
```

This creates one `<source>_RETOPO_<candidate>` folder per result. Each is a normal reference level because it
contains `Patches.json`. The source map's textures and course files are copied for inspection, `candidate.obj`
preserves the tool output for external mesh viewers, and `Retopology.json` records the full score. Candidate
polygons are only degree-elevated to planar bicubic patches: no smoothing, fitting, stitching, or repair is
performed, so boundary misses and inverted patches remain visible.

## Metrics

Every report compares:

- quad/triangle/n-gon percentage and face-target ratio;
- interior 3-, 5-, and other-valence pole counts;
- quad minimum scaled Jacobian, aspect ratio, and equivalent edge length;
- trail cross-field alignment (an edge may be parallel **or perpendicular** to the protected trail boundary);
- protected-interface distance, sample coverage, and original-knot matches;
- symmetric candidate↔source surface deviation;
- boundary, non-manifold, and isolated-vertex diagnostics.

The boundary scores are intentionally not repaired before measurement. They answer the integration question:
can this result be stitched to exact retained patches without a large transition zone?

## Production decision gate

Do not pick the winner on quad percentage alone. A useful result must have no non-manifold edges, acceptable
surface deviation, high protected-boundary coverage, and a pole/skew distribution that stays clean near the
trail. QuadWild-BiMDF is the quality target, Instant Meshes tests guide-field control, and QuadriFlow is the
permissive baseline.

For the first in-editor implementation, the same constraints and metrics apply to a top-down 2.5D
quadrangulator. Patches whose normals approach horizontal are excluded or handed to the later general-surface
path; no silent heightfield collapse is allowed.
