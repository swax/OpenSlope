# 023 — Splines, loft, and the first-class track

## Why

Edit shapes terrain corner-wise, and a track is not a corner-wise thing — it is a **law along a line**:
one cross-section evaluated down a smooth spine, with width, depth and bank varying smoothly by arc
length. Hands are good at deciding where the line goes; they are bad at holding a law across forty
patches. Measured on the extracted GARI patches, the law is unmistakable:

- Snow (SurfaceType 1) is 650 patches whose snow-adjacency degree peaks at 3 (419 of 650) — the
  interior signature of a **two-lane ribbon** (one neighbour across the seam, two along it), in ~20
  chained segments that end where the net goes irregular (poles / darts).
- The cross-section is a **dish**: the centre seam sits below the rim-to-rim chord at almost every
  station — median −1.55 m on a ~29 m width (p10 −5.7, p90 ≈ 0), ≈ 6 % of width. Constant in *shape*;
  width breathes 16→41 m (p10–p90) and the dish scales with it.
- **Bank** is median 8°, up to ~32° in corners, ramping ~6° per station — banking runs over several
  patches, never jumping.
- Lanes are ~15 m wide, stations ~27 m long, and 87 % of snow patches share one identical UV corner
  pattern (12 % the transpose) — one tile per quad, uniformly flow-oriented. Aligned textures are a
  *consequence* of congruent, flow-ordered quads.

The shipped data also says how the originals were built. The patch structure carries NURBS-workflow
fingerprints: 1/3 handles (uniform B-spline → Bézier decomposition), zero-twist interiors (surfaces
generated from curve networks, not hand-placed CVs), integer-ratio dense corridors (isoparm
insertion), and seams that meet along a shared curve with matched endpoints, tolerated T-junctions
and epsilon welds (tolerance stitching). The GARI deconstruct's secondary charts split between
**knit-dominant** (stitched in, with wedge darts at density steps) and **open-dominant** (free
ribbons overlaid on the body, never stitched). The workflow was: draw curves, **sweep / loft the
track as its own surface**, then stitch it in by hand — or park it on top and bury the body. The
sweep was automated; the integration was craft.

## MESA centreline study (phase one)

The selected MESA trail centre seam is saved in the local research archive as
`ResearchData/trails/centerlines/mesa-centerline.json`. (`ResearchData/` is the maintainer's local, gitignored
evidence archive and `temp/` is scratch output; a fresh clone finds both empty, see `ResearchData/README.md`,
so the commands in this section are recorded for reproducibility rather than runnable from a checkout.)
`tools/mountain-study/trail-selection.ts` resolves those copied exact cubics back onto the full reference
quilt and writes the repeatable report `temp/mesa-trail-study.json`:

```powershell
npx tsx tools\mountain-study\trail-selection.ts ..\ResearchData\trails\centerlines\mesa-centerline.json
```

The sample contains 187 centre vertices and 182 edges. Every selected edge has exactly two incident
patches, confirming a three-rail / two-patch-wide ordinary trail chart. It also contains six disconnected
components, four degree-three split/merge vertices, one split/rejoin cycle, and thirteen maximal ordinary
chains. The branch vertices are not ordinary overlapping ribbons: their complete reference topology is a
hand-knit valence-five or valence-six patch fan. Branch knitting must therefore remain an explicit later
operation.

Measured ordinary-chart law:

- Centre-station cubic arc length is p10 10.2 m, median 20.4 m, p90 30.3 m. Tighter curves receive shorter
  cells: median 15.2 m below 40 m radius and about 21–26 m on broad turns.
- Full rim-to-rim surface width is p10 10.8 m, median 15.5 m, p90 22.4 m; one of the two patch lanes is
  median 7.7 m. The centre seam is a dish, median 1.35 m below the rim chord, or 9.4% of full width.
- Absolute bank is median 9° and p90 31.2°. A useful automatic reconstruction is
  `-atan(15 m × signed horizontal curvature)`. The direct map-wide fit clamps automatic bank to ±20° and
  allows 20° station steps; explicit knot banks reproduce the stronger hand-authored sections. The sign follows
  Slopesmith's lateral frame so positive gain raises the outside rim.
- Cross edges are close to perpendicular to travel (median error 4.3°), and centre versus rim flow tangents
  differ by only 2.7° median. Longitudinal and transverse handle/chord ratios both centre on one third.
- The selected flow direction is raw patch-v on 353 of 364 adjacent patches. Slopesmith charts use patch-u
  for flow, so a recovered MESA tile needs one quarter-turn of orientation when painted onto generated quads.
- Tight-turn markings are matched two-half tiles, not left/right turn labels: `0066+0064` is the blue pair
  and `0063+0062` the red pair. Both occur equally on positive and negative turns. Ordinary matched pairs
  include `0044+0045`, `0046+0047`, `0059+0061`, and `0002+0042`.

`core/mesh/trail.ts` is the first executable reconstruction of that law. It accepts one or more connected
cubic Bézier segments, re-cuts the centre curve exactly with de Casteljau, adaptively caps ordinary cells at
22.5 m or 52° of tangent turn (with a 9.5 m practical floor), and emits three rails plus two quads per span.
It uses the fitted 13.0 m plan-width / 10.5% MESA section, automatic bank above, Bessel rim and cross handles,
matched held texture pairs, stable mesh ids, and explicit fold/manifold refusal. Width, dish, centre-seam lane
balance, and signed bank can also be supplied per construction-spline knot and interpolate independently of
generated patch density. It deliberately stops at ordinary ribbon runs; split/merge fan generation is not
inferred from the regular chart.

### Four-map reconstruction benchmark

`ResearchData/trails/centerlines/` adds ELYSIUM, GARI, and SNOW to MESA: 680 selected centre edges in total, of which 656
belong to ordinary runs after excluding edges that touch split/merge vertices. The benchmark rebuilds those
runs with `applyTrailSpline`, then samples each generated bicubic at the same centre-curve and lateral
parameters as its two original retail patches:

```powershell
npx tsx tools\mountain-study\trail-benchmark.ts ..\ResearchData\trails\centerlines
```

The curated machine-readable result is `ResearchData/trails/trail-reconstruction-benchmark.json`. One constant fitted
parameter set per map produces median surface distances of 1.56 m (MESA), 2.11 m (SNOW), 2.52 m (ELYSIUM),
and 2.86 m (GARI); RMS is 2.65–5.34 m because retail widths and authored banks vary substantially inside a
map. Feeding the measured values back as per-knot width, dish, lane balance, and bank profiles isolates the
surface-construction law: median distance falls to 0.65–0.81 m and RMS to 1.31–2.46 m across 644 of 656
ordinary edges. Twelve extreme hairpin edges still trigger the safe fold refusal.

That residual is expected and useful: the originals skew cross edges away from perpendicular (p90 about
15–18°), vary rim-flow tangents, and carry 0.4–0.7 m median interior-control residuals beyond a zero-twist
loft. The ordinary generator should preserve its clean perpendicular/Bessel law; matching those last local
meters is a finishing or explicit junction/hairpin operation, not a reason to make every generated trail
irregular. The benchmark also found and fixed two prototype errors: bank sign now raises the outside rim, and
turn concentrated at a join between two cubics now contributes to both banking and adaptive density.

## Current Create Trail tool

Edit mode's empty-selection **Create Terrain** group now includes **Create Trail**. It lays transient centre
knots with the same Catmull-Rom-to-Bézier curve as Add Rail and Add Motion Path, previews the generated chart,
and commits it as ordinary selected mesh patches. Its panel exposes target width and length, centre dish and
bias, adaptive turn density, auto-bank gain/clamp, surface lift, and the Mesa matched-half/tight-turn texture
preset. A knot clicked on an authored patch or vertex is raised by the surface-lift setting (0.25 m by default),
while a free-space knot is not moved. Enter commits, Backspace removes the last knot, and Escape cancels.

This is deliberately the useful one-shot tool from the generator study, not yet the first-class owned Track
object described below: after commit its two-patch ribbon is normal editable terrain and does not retain the
construction spline.

A patch selection also exposes **Select overlapping vertices**. It projects the selected patches' tessellated
curved surfaces through the current camera, excludes their own corners, and replaces the patch selection with
every other authored vertex inside that screen-space mask. The query selects through depth intentionally: from
a top view it finds mountain points beneath an overlay trail, which can then be inspected and deleted with the
ordinary Delete operation to open a clearance hole.

007 proposed flow ribbons as a live-derived chain (corridor + ribbon regenerated from the spline on
every edit). This doc re-lands 007 on the mesh editor: charts are real mesh in the one document,
generation is an explicit act, and the only live derivation is scoped to the quads a track *owns*.

## The stack

Three layers, each usable without the ones above it:

1. **Splines** — construction curves. Laid knot-by-knot like a trick rail (docs/014), or *adopted*
   from something that already has the shape: a selected edge run (the Edit edge-loop pick), or a
   course segment (a knot range). Knots snap to host vertices / edges, which is what lets a loft
   meet the terrain exactly.
2. **Loft** — the one geometry generator. N ordered rails → resample at matched arc-length stations
   → emit a quad chart with the shipped conventions (handles = spine derivative / 3, zero twist),
   ghost preview, commit appends vertices + quads to the doc. One-shot: the mesh does not remember
   the loft. Loft between two *host* edge runs is a bridge — which makes loft the knitting tool too.
3. **Track** — the first-class object. A spine laid like a rail whose knots carry an overridable
   cross-section; it emits a chart through the loft and **owns** it.

## Track: a rail that owns terrain

A track is authored exactly like a trick rail — click knots down the mountain, drag them, insert /
delete — but each knot carries the section, and the section is the `CourseKnot` vocabulary grown up
(those fields are seed-only today; the track makes them live):

- **patch width** — exact width of one patch across the floor (default 15 m). The stored section
  width is the total ribbon width, `patch width × lanes`, so sparse width overrides can still make
  the whole track breathe. A new track starts as one lane: one perpendicular edge with two endpoints.
- **depth** — the dish: how far the centre seam sits below the rim chord, as a fraction of width
  (default 6 %).
- **bank** — roll of the section, degrees. Default is *auto*: gain × horizontal spine curvature
  (superelevation into turns, which is what makes banking ramp in and out smoothly); a knot override
  wins.
- **wall / shoulder** — the quarter-pipe lip and flat beyond it, as in `CourseKnot` (0 = open).
- **lanes / patch length** — chart density (defaults one 15 m patch across and 30 m down-track).
  Fresh stations sit at exact `0, 30, 60, ...` metre arc positions on the centre spline, with one
  additional station at the final endpoint when the last patch is short.

Per-knot values are sparse **overrides over the track's defaults** — absent means default, the same
convention as edge handles (absent ⇒ Bessel). Between knots everything interpolates smoothly along
the spine, so "constant saddle, smooth curve, smooth banking, congruent quads" are properties of the
generator, not of discipline.

Every station uses the spline's horizontal normal, so its cross edge is **perpendicular to travel**;
on a circular course the cross edges point at the centre. Curvature controls the cross-edge bank, which
sets the two endpoint heights. All rails share that one centreline station parameter: inside edges shorten
and outside edges lengthen naturally, while the mesh's Bessel boundary handles form smooth longitudinal
splines through every inside/outside vertex. If a turn is tighter than half the total width and its
perpendicular inside rail would reverse or self-cross, emission refuses and asks for a narrower track or
wider spline; it never silently substitutes diagonal cross edges.

### Ownership

The track's chart is real mesh — the bake, the ride, preflight and every mesh tool see plain quads,
and the exported `Patches.json` is indistinguishable from hand-built patches. But the quads are
**marked owned**, and ownership means:

- **The track is their generator.** Editing the spine or any knot property re-cuts the owned
  vertices from the law. The track stays mod'able forever.
- **Owned vertices are locked to hand edits.** Sculpt brushes skip them; Edit move-sets filter them;
  surgery refuses to change owned topology. The hill cannot smear the track.
- **The rim is the handshake.** Stitching welds *host* vertices INTO rim vertices (`applyVertexWeld`
  `[from, into]` — the rim survives and keeps its position), so the body is draped to meet the
  track. Move the terrain and the seam holds: the track remains constant, the neighbouring body
  cells absorb the change through the net's own smoothness. This is 007's authority model — the
  course owns the trail band, the body is merely required to meet it — enforced by the lock instead
  of by regeneration.
- **Re-cuts are positions-only while the topology stands.** Chart topology is a function of lanes ×
  station count; width / depth / bank / spine drags rewrite positions under the same ids, so stitches
  survive. An edit that changes station or lane count re-emits the chart — and a *stitched* track
  refuses it (unstitch first, explicitly). Overlay-only tracks re-emit freely.
- **Dissolve is the escape hatch.** A track can be dissolved into plain mesh at any time — the
  object goes, the quads stay, every tool works on them. The net remains sovereign; the track is a
  privilege it grants, one-way revocable.

Both integration styles are authentic and both are supported: **overlay** (bury or dip the body
beneath the ribbon — the open-dominant charts in the shipped data) and **stitch** (weld the rims,
dart the density steps with the existing wedge tools — the knit-dominant bands).

## Gestures

- **Track**: a Terrain-mode tool beside the surgery set. Arm → lay knots like a rail, ghost chart
  live under the cursor; select an existing track → knots + section panel, drag / override / re-cut
  live. Floor cells paint the track surface (default snow) on emit.
- **Loft**: select 2+ rails / edge runs in order → Loft → ghost → commit. Gesture-free entry: the
  first useful loft needs no new drawing UI at all, just the edge selection that exists. Bridge Builder
  exposes target patch size plus connection curve: 0 is straight, 1 follows a smooth Catmull/Bessel path
  through the rail sequence, and values through 2 exaggerate the bend. Curvature affects both inserted
  intermediate loops and the connecting boundary handles.
- **Spline**: lay knots (the rail gesture), adopt a selected edge run, adopt a course knot range.
  Knot snap to host vertices / edges.
- **Stitch**: target-weld — drag a host vertex onto a rim vertex to fuse (the slide's auto-merge
  machinery, `applyVertexWeld`). Local density changes use patch-strip Split and explicit T-junctions (docs/017–018).

## Staged plan

- **S1 — loft core + edge-runs-as-rails.** `applyLoft(doc, rails, opts)` beside the mesh-ops
  (`applyCellEdgeInsert` result pattern), ghost + commit, tests in the quadmesh-check style.
  Includes the prerequisite audit: cage / BVH / preflight / derive must tolerate a **disconnected
  chart** (nothing in `QuadMeshDoc` forbids one; assumptions might).
- **S2 — spline objects.** Laying, adopting, snapping; splines persist as peers of rails and the
  course.
- **S3 — the track object.** Spine + section defaults + sparse knot overrides; emits through the
  loft; ownership marks, lock enforcement, positions-only re-cut.
- **S4 — integration UX.** Target-weld gesture, dissolve, the stitched-refuses-topology-change rule
  surfaced in preflight, and the re-emit report when an overlay track re-cuts.

Each stage lands something usable on its own: S1 bridges and fills corridors, S2 makes free-space
rails, S3 is the track, S4 is the craft polish.

## Non-goals

- **Live corridor cutting of the body** (007 R2's derived trim). The body meets the track by stitch
  or overlay, as the originals do; nothing regenerates behind the author's back.
- **Branching / merging tracks.** Two tracks whose charts share a seam are just two charts and a
  weld; a first-class junction object is deferred.
- **Reading reference tracks back into track objects.** Fitting spine + section to shipped ribbons
  is a separate problem (006 non-goals still apply).
- **Replacing the net editor.** The net stays the body; splines, lofts and tracks are additive.
