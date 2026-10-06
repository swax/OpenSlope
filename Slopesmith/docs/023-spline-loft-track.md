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

## Create Trail: an owned trail network

Edit mode's empty-selection **Create Terrain** group includes **Create Trail**. It lays centre points with the same
Catmull-Rom-to-Bézier curve as Add Rail and Add Motion Path, and the trail it builds keeps its splines: an
`AuthoredTrail` in the document's `trails` list (`core/doc/types.ts`) holds its points and paths and the stable ids
of the vertices and patches it cut. It is the first, two-patch-wide cut of the Track object below.

**Networks.** A trail is a NETWORK: a list of POINTS and the PATHS through them (`TrailPath`: an ordered list of
point places, with its own settings and Bézier handles). Every path is alike — there is no main trail and no
branch — and a point the paths share is where they meet. Splits, merges, crossings, bypasses and loops are all just
paths sharing points. A point where three or more ARMS meet (an arm per path end there, two per path running
through) carries a JUNCTION; so does one where exactly two path ends meet and nothing else — a loop closing on
itself, or two paths cut differently laid end to end — which is knitted as a two-arm joint. A point a single path
runs through is no junction. Each path is cut with its own settings, so a narrow cat-track can leave a wide run;
what a point sets for itself (below) it sets for every path through it.

**Drawing.** Create Trail draws one path. Each click on no point adds one at the surface point under the cursor,
raised by the surface-lift setting (0.25 m by default) when it lands on an authored patch or vertex; a free-space
point is not moved. From the second point the path is in the document, patches and all, and it re-cuts with every
point, so what you see while drawing is the real ribbon. Before each click a teal ghost shows what a point under the
cursor would cut — the new span, the junction a point would make, and every patch it reshapes (`trailPreview`) —
and where a point there would be refused, the panel says why. A click on an existing point picks it up instead: the
translate gizmo goes on it, and a drag re-cuts the trail live — before the last point is laid as well as after. A
picked point also shows the drawn path's two pink Bézier handles there, which drag the same way (docs/014 · Bézier
handles) and bend that path through the point; at a junction each path has its own. Backspace removes the picked
point, or else the newest; Enter or Escape finishes, leaving the path selected. A trail that never had a path of two
points was never in the document and is dropped. The point bulbs — and the ghost, and the rings below — hold their
size on screen however far off the camera is (6.5 px, the picked one 8.5 px), each with a dark rim that keeps it
apart from the pale ribbon under it.

**Joining.** Any point can land on any point. While a path is drawn, and while a picked point is dragged, every
point it may land on is ringed in amber — a dark-centred ring where it is another trail's, round the bulb where it is
shown — so where it can attach is plain before it gets there. Each catches it within 14 px on screen, measured in the view alone — two points that overlap there
catch at any depth, since nobody can line them up along the view by eye — the next point
drawn by `TrailShape.snaps`: every point of every trail but the one the path grows from; the picked point dragged by
`dragSnaps`: every point but itself and its neighbours along its paths, which it would fold a path onto, so a point
picked mid-draw is never caught by its own place. It sits exactly on the point, filled amber, and the ghost shows the
result: for a point drawn, what the click would lay; for a point dragged, over the drag's own live cut, the merge
its drop would make — the junction the paths would meet in, or the one path two ends fuse into — computed as the
drop computes it, and gone with the drop. The FIRST point of a new trail laid on a FREE END (one path's end with
nothing else there) goes on drawing that path; on any other point it starts a new path there. A LATER point laid on
one ends the path on it — a fork from a middle point, a merge, a bypass back onto its own trail, a loop closed on
its own first point — and the drawing ends. A dragged point dropped on another becomes it (`mergeTrailPoints`):
dropped on a middle point of another path it makes a crossing; one dropped mid-draw ends the drawing, the path it
was drawing renumbered by the join. When the point is another trail's, the two trails
become one network (`joinTrails`): the other trail's id, the first taken out with its patches — one history step —
and refused if other patches are joined to the trail taken in, which would have to be cut afresh. Wherever two path
ends come to meet alone and the two paths are cut alike, they FUSE into one path (`fusePathsAt`): the
lower-numbered keeps its place and direction and takes the other in, turned round if it ran the other way — its
handles swap sides, and the seam and fixed bank of the points only it used mirror, since they are measured across
the direction of travel. Paths cut differently stay two and meet in a joint.

**Selecting.** A click on a trail patch selects the PATH it belongs to: its patches become the patch selection, its
point bulbs and guide show, and the Tools panel is the path's own. Every patch is exactly one path's — its runs'
ribbons, and the junction patches carrying its lanes on (`trailPathQuads`). Only the trail moves its vertices and
edges, so a click on one inside it — its centre seam, the station lines between its patches, a hub
(`trailInterior`) — passes to the patch beneath and selects the path too; the open rim stays a vertex or an edge
like any other, for the welds, bridges and extrusions that join other patches to the trail. Ctrl+click adds or drops a whole path, a
box takes every path it catches whole, and a double-click, Ctrl+A or the panel's **select the whole network** takes
every path joined to the selection. The selected paths are not stored anywhere; they are whichever whole paths'
patches are exactly the patch selection, so any other selection is already "not a trail" (the picked point is kept,
`store.trailPoint`). With no point picked, the gizmo sits at the centre of the selected patches and carries the
selected paths as a unit (gizmo kind `'trail'`, `viewport/tools/create-trail.ts`, which reports the transform from
the drag's start, `TrailTransform`): Move translates every point they run through, Rotate (E) turns them about that
centre, Scale (R) stretches them, and every dragged Bézier handle of theirs turns and stretches with its point. A
point they share with a path not selected moves too, dragging that path's end along. The trail re-cuts from the moved
points each frame — so its patches stay locked and only the trail moves them, and patches joined to it stretch to
follow. It is World-framed: the mesh's Surface slide does not apply to a trail.

**The panel** exposes the points, the selected paths' section (target width and length, centre dish and seam, turn
density), banking, its tiles (below), **✚ add points before the start** and **after
the end** (the one selected path's: both with no point picked, the picked end's with an end picked), **⑂ start a new
path here** (any picked point but a free end), **✂ disconnect here** (any point two arms or more meet at,
`disconnectPoint`: every path running through it is cut there, keeping its shape — the handles either side of the cut
fixed where the curve ran — and every arm ends at a point of its own at the same place, carrying the point's values:
two sides mid-path, three at a fork, four at a crossing. A loop broken this way opens into one path. Sides no longer
joined become trails of their own (`separateTrail`): the network holding the first path keeps the trail and re-cuts
in place, the others are cut fresh. The selected paths stay selected as their pieces, and the clicked path's side
keeps the point picked, so a drag pulls it away; dropped back on a point, it joins again), **⫽ split path here** (a
point a path runs on through, `splitPathsAt`: every path running through it is cut there into pieces that still meet
at the point, in a two-arm joint, keeping their shape — nothing comes apart, and each piece can then be set on its
own, its tiles above all; the pieces stay selected and the point picked), **✕ delete this point**, **select the whole network**, **select
overlapping vertices**, **⇥ dissolve network into patches** and **✕ delete path**. Every setting re-cuts as it
changes, applies to every selected path — the panel shows the clicked path's values — and becomes the next new
path's starting value. Deleting a point takes it out of every path through it, each then running straight past it,
and a path left with one point goes. Deleting a path takes its patches and the points only it used; the paths it met
re-cut without it.

**Textures.** A trail's tiles come in matched PAIRS (`TrailTilePair`): one tile drawn across the trail's width and
cut in two, a half for each lane of a span — the lane to a rider's left going along the path, and the one to their
right. A pair belongs to the map both its tiles come from and is named within it, so its id reads `MESA/Trail 1` or
`GARI/Turn 2`. A path wears three, by id, among its settings: its **trail tiles** along every span, its **left turn
tiles** through left turns tighter than **turns under** (80 m by default), and its **right turn tiles** through right
ones — a turn slot left empty wears the trail tiles there too. Left and right are as the path runs, from its first point
to its last: data space is the game's left-handed frame, so a rider's left is the side the generator calls `right`
(`[-tz, 0, tx]`), a span turning left has positive signed curvature, and a pair's left half goes on each span's second
patch. One pair per slot and nothing cycled: a path that should change its tiles part of the way along is split there
(below) and each piece set on its own. Each pair carries the quarter turn its halves are worn at beyond a trail tile's
own (the tile's v along the path, above). Each pair is of a KIND — `trail`, `left-turn`, `right-turn`, or `turn` for
either way — which says which slots list it.

The shipped maps' pairs are built in (`core/mesh/trail-textures.ts`, `TRAIL_TILE_PAIRS`): Mesa's four trail pairs —
variants of one groomed look, `0045|0044`, `0047|0046`, `0061|0059` (almost only Mesa's section D) and `0042|0002` as
[left|right] — and its blue and red striped turn pairs. Mesa marks a turn's WAY with them: the same striped tile turned
round, its stripes down the centre seam either way — blue `0064|0066` with its top downhill on 12 left turns and 1
right, `0066|0064` with its top uphill on 24 right turns and no left; red `0062|0063` on left turns only and `0063|0062`
on right ones. So they are `MESA/Left Turn 1` and `2` and `MESA/Right Turn 1` and `2`, and a new path wears
`MESA/Trail 1`, `MESA/Left Turn 1` and `MESA/Right Turn 1`. (A path still naming the single `MESA/Turn 1` or `2` of
before wears the split pair for each side; those names are never given out again.)

**Finding a map's pairs.** `tools/mountain-study/trail-pairs.ts` finds them from a map's patches alone, with no
centreline picked: wherever two textured patches meet with the right art edge of one tile on the left art edge of the
other, art up the same way, the picture runs across the seam — a matched pair. It keeps a seam only when neither half is
matched again across its far side, since a trail is two patches across and a rock wall or tiled field is matched on
every side, and drops tiles laid mostly on rock, walls or out of bounds. Going downhill along each seam it reads which
tile is on a rider's left, which way the art's top faces, and how tightly and which way the seam turns (the inner rim is
the shorter). Two tiles laid through turns under 80 m at least 60% of the time are turn pairs — the way they are laid
most through left turns a left-turn pair, through right turns a right-turn pair — and others are a trail pair laid
their commonest way. It prints every candidate as a `TrailTilePair` line to paste in, named by how often the map lays
it, and writes `temp/trail-pairs.html`: each candidate as the art, as a rider going downhill sees it, to choose by eye —
a ground transition can match too. It recovers Mesa's pairs exactly, and finds directional turn pairs on ALASKA, ALOHA
(a marker on the outside half only), ELYSIUM and MERQUER; MEGAPLE and UNTRACK lay almost no two-patch matched ribbons.

A mountain's own pairs live in its document's
`trailTilePairs` (one global register, docs/039) and are named on the same pattern, next among their map's: the first a
mountain makes from GARI's tiles is `GARI/Trail 1`. Each slot is a dropdown of pictures: its value is the worn pair's
two halves and its id, and it opens a list of every pair of its kind as its art, under its map's name, with none first
and **new pair…** last. A pair is drawn as a rider going along the path sees it, the path running up the screen: its
left half on the left, each half turned as the terrain wears it (`trailTileViewOrient`: a half's quarter turns plus
two, as `orientCss` draws a D4). **new pair…** makes one of the mountain's own — its left lane's tile and then its
right lane's, chosen in the Texture Library, both from one map — and wears it. A pair of the mountain's own that a
selected path wears shows below, its halves to choose again, **⇄ swap** its halves, its turn and **✕ delete**: every
change re-cuts every path wearing it, and deleting it leaves those paths plain there. A pair that cannot be found lays
nothing. A re-cut that lays no tile on a patch takes back only what a pair lays there — the built-in ones' tiles and
the mountain's own — so a tile painted by hand stays. Paths saved before tile pairs carried only `mesaTextures`, and
load wearing Mesa's first pairs, or plain; ones saved with a single turn pair wear it through both turns.

**Per-point section.** A picked point adds a **Point N** group to the panel: its width, centre seam and centre dish,
and its bank. Each row shows the value it is cut with there; moving it makes the value the point's own (the row is
marked ●), stored in the trail's `pointSettings`, index-parallel with `points`, and only for the values a point sets
— everything else follows the settings of each path through it. A point several paths share sets its values for all
of them. Between two points every value eases from one point's to the next by distance along the path
(`TrailKnotProfile`), so a point set to 25 m swells a 13 m path there and it narrows back over the neighbouring
stretches. The bank is either **automatic** — the curvature law, scaled by the point's **bank strength** (0 levels
it, 2 leans twice as hard) — or a **fixed angle**, which starts at the bank the point has when chosen. Between two
fixed points the bank turns evenly from one angle to the other, so two points at 0° hold the stretch between them
level through any curve; between a fixed point and an automatic one it fades from the angle into the automatic bank,
which is where the automatic point's side of the stretch reads it; two automatic points are the automatic bank
exactly. **↺ follow the path here** clears the point's values. Patch length, turn density and the textures stay
per path: they decide how many patches fall between two points, which belongs to a stretch, not a point.

**Junctions.** Cutting a trail with junctions is a network (`applyTrailNetwork`): every path split at each junction
it runs through, each piece a RUN of its own, pulled back from the junction until neighbouring rims meet before the
ribbons end — the reach is found working out from the junction, since a bypass that bends back runs alongside its
trail again further out — and every lane carries on into the opening: each run's centre seam runs on to a hub at the
point, each pair of facing rims runs on to the crotch where they cross (on the rim itself, abeam the point, where a
path runs straight through), and between a seam and a crotch lies one patch per lane, written as the lane's own next
patch and wearing its path's ordinary tile — never the tight-turn stripes, which stop where the ribbon does. A fork is
six quads around a valence-6 hub — the six-pole the shipped levels knit by hand — a crossing eight around a
valence-8 hub, a joint four around a valence-4 hub. A junction that cannot be knitted — a path leaving too close
along another — is refused by name (which path, between which points; which junction point).

**The cut** (`core/mesh/trail-object.ts` `cutTrail`) lays the trail out on its own first — one ribbon, or the
network: the runs path by path, then for each junction a crotch per arm and the hub — and writes that over what the
trail already owns slot by slot: the same vertices and patches wherever the old cut had one, new ones past its end,
and what it had past the new end retired through the shared compactor. A trail of more than one run keeps the shape
of its last cut (`network`: spans per run, the path each run belongs to, and the arms of each junction), which is how
its names divide up. Every handle on the ribbons' edges is cleared and derived again — the exact centre seam, then the
lock's materialised Bessel handles — so a re-cut in place is the same surface as cutting the moved spline fresh. A
point drag cuts once per frame, each time from the document as it stood when the drag began, so the frames do not
pile up each other's minted and retired ids.

**Ownership.** Every owned patch is locked from the moment it is cut: sculpt brushes and Edit transforms leave it
alone, and only the trail moves it. Edit's Delete and Dissolve refuse a vertex, edge or patch selection that would
take or rewrite a locked patch — a trail's, or one locked by hand — and say why (`meshLockReason`): a trail's paths
go with the trail's own delete. Patches joined to a ribbon — a Weld Loops seam, a retopologised mountain — share
its rim vertices, so a re-cut moves those vertices and the joined patches stretch to follow. While anything shares
its vertices the trail keeps its layout: each run shares exactly the spans it already has out across its point
segments (`spanCount`, by the same length and turn demand the adaptive count reads), and a spline with more segments
than spans is refused — and so is a path or a junction added or removed. A trail whose ribbons something has cut into
— a loop cut, say — no longer resolves; its panel says so and offers only dissolve and delete. **Dissolve** forgets
the whole network's paths and leaves the patches as ordinary (still locked) mesh, the escape hatch for hand work on
them.

A trail is its own register family (`o/trail/<id>`, docs/039), written whole: its paths and the patch ids it names
come from one writer, alongside the mesh change that cut them. Trails saved before networks — one spline of knots
with branches hung off it — come forward on load (`core/doc/trails.ts`): the trail is the first path, each branch a
path through the knots it left and rejoined, with a copy of the trail's settings, laid out in the order the old trail
cut its runs and junctions so its names divide up as before and its next cut lands on the same patches.

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
  weld; a first-class junction object for the Track is deferred. (Create Trail's networks, above, already knit
  their own junctions.)
- **Reading reference tracks back into track objects.** Fitting spine + section to shipped ribbons
  is a separate problem (006 non-goals still apply).
- **Replacing the net editor.** The net stays the body; splines, lofts and tracks are additive.
