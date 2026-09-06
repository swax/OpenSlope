# Design Study 01 — Terrain Vocabulary (toward building an original map)

> Goal: decompose a shipped SSX mountain's terrain into a parametric vocabulary precise enough that an original
> SSX-style course could be *generated* from a spec — spine curve in, patch quilt out. This doc records what the
> data shows, focused on the **top quarter** of the mountain (dtf 4607→~3455: the start chute, first banked
> S-turns, and the upper braid entries). Numbers come from `tools/mountain-study/gari-study.ts`,
> `tools/mountain-study/gari-pathing.ts`, `tools/mountain-study/gari-shape.ts`
> (heightfield/hillshade/cross-sections/banking). The figures those scripts render (a map, a full profile,
> a top-quarter hillshade and cross-sections) land in the gitignored `temp/` and are not distributed.

## The headline finding: the mountain is authored, not sculpted

The mountain's 3,885 Bézier patches are not freeform terrain — they decompose cleanly into **named layers
with distinct grammar**, and the rideable trail is a **lofted ribbon**:

| Patch class (from `PatchName`) | Count | Typical patch (plan) | Role |
|---|---|---|---|
| `Patch_MainPath*` | 219 | **10 × 21 m** (p90 19×39) | the groomed racing trail |
| `Patch_SCE*` | 1,681 | 22 × 37 m | general course body / canyon flanks |
| `Patch_SideGeo/_SG/_SGD` | 1,397 | 21 × 38 m | OOB skirt, walls, fill |
| `Patch_SC1/SC2/SC5/NewSC` | 169 | 20 × 34 m | numbered course sections (legacy chunks?) |
| `Patch_ShowOff*` | 60 | **4 × 11 m** | ramps / trick features (all SurfaceType 18) |
| `Patch_MetalRail*` | 6 | — | rail bed (SurfaceType 17, no-collision) |

Two structural facts make the "generate it" plan credible:

1. **MainPath is a quad-strip.** Edge-adjacency over the 219 MainPath patches gives an average of
   3.6 edge-neighbors, histogram peaking at 3 (×107) and 4 (×81) — the signature of a **ribbon
   2 patches wide** (occasionally 3) chained along the course. So the trail was built exactly the
   way a tool would build it: a spine curve, a cross-section ~2 control-patches wide, lofted.
2. **Control density follows gameplay.** Trail patches are ~4× smaller in area than flank patches
   (10×21 vs 22×37) — detail budget is spent where the board touches. ShowOff features get another
   4× (4×11 m). A generator should allocate patch subdivision the same way: trail > flank > skirt.

## Surface types are the steering mechanism (recap from study 00)

The trail isn't fenced; it's *fast*. MainPath is 68% standard snow + 25% ice (the only dense ice
concentration on the mountain); flanks are powder (speed_gain 40 vs snow 52 vs ice 64), then
rock/slow-powder (19.6/36), then the `SurfaceType 0` reset skirt. Off-trail on the mountain means
progressively slower, never instantly fatal. **Vocabulary rule: author speed, not walls.**
(Physics numbers: Unity docs/vrchat/020.)

## Cross-section vocabulary (top quarter, measured)

Cross-sections every 50 m along Race Line 0 (±120 m, 2 m heightfield from re-tessellated patches)
show the trail is almost never on open slope. The recurring shapes:

- **BENCH** — the default. A ~30–60 m quasi-flat ledge cut across a steep hillside: uphill wall on
  one side (10–40 m rise within 80 m), fall-away on the other. The race line rides the bench
  centerline; powder fringes occupy the bench edges.
- **WALL-BANK** — a bench whose uphill wall curves *with* a turn. Measured on the first S-turn
  (race-line d≈300–500 m): turn radii **57–75 m** at entry tightening to **~32 m** at apex, wall
  height climbing 17→43 m through the turn, near-vertical face within ~16 m of the racing line.
  The wall *is* the bank — you ride up it; there is no subtle road-style superelevation. (The
  fine-grained bank of the bench surface itself is ±8–20° where measurable; the design lives in
  the wall.)
- **GULLY** — both sides rise ≥8 m: used to funnel into branch merges (appears at the braid entry
  at the bottom of the quarter).
- **SHELF-EDGE / GAP** — bench ends in a cliff; zero-width samples on the race line mark
  authored gap jumps (more of these mid-course than in the top quarter).
- **START PLATEAU** — the gate area: ~200 m of dead-flat 6-lane-wide platform (curv≈0,
  width>200 m), then the floor tips over at ~−70% grade. The first 100 m of riding has *no*
  steering decisions — speed-build only.

Macro numbers for the quarter: ~505 m drop over ~1,000 m ridden (avg ~35°), rideable width
median ~150–200 m narrowing to ~45 m at the S-turn apex; two orphan shortcut chutes (#6: 325 m /
199 m drop, #7: 328 m / 222 m drop, both ~90–98% grade) run parallel to the spine and rejoin
off-line — shortcuts are *steeper and narrower*, the risk/reward axis.

## Pathing vocabulary (recap, for the spec)

- One **spine** (Race Lines 0→1→2→3→4→5), 4.6 km dtf / ~2,640 m drop / ~31° average.
- **Braids**: parallel race lines vertically separated 100–200 m (ridge vs canyon routes), joined
  at named merge points; `DistanceToFinish` is the global parameter tying every line to one
  course clock.
- **Respawn layer**: 75 `Respawnable` AI paths shadowing every branch — a generator must emit
  these alongside the visible trail (they're how OOB recovery works; docs/031).
- **Rhythm**: sprint (steep, wide) → braid (choice) → flat shelf (regroup, tricks/rails: the
  ShowOff and rail density peaks there) → finale plunge. Width and grade modulate *against* each
  other: chokes appear where grade is moderate, the steepest pitches are wide.

## The off-trail / freeride layer (measured via `tools/mountain-study/gari-offtrail.ts`, map `temp/gari-explore.png`)

The "open mountain" feel is engineered, and the numbers overturn the naive reading:

- **There is almost no genuinely open terrain.** Of ~53 ha rideable, 26 ha sits within 25 m of a
  race line, 23 ha in the 25–75 m fringe, and only **4.5 ha is ever >75 m from a race line**
  (>150 m: 0.3 ha). Against *any* authored line (incl. the 100+ AI/respawn paths): just 2.2 ha
  beyond 75 m. Every powder stash and cliff option is itself a designed corridor with a path
  through it. **The freedom is an illusion of density, not acreage.**
- **The density that sells it: parallel stacked lanes.** Slicing the course every 50 m (±450 m
  scan): **79% of the course has ≥2 parallel rideable lanes, 62% has ≥3, peaks of 7.** Lanes are
  separated by narrow unrideable ribs — median gap only **16 m** (p75 40 m) — but offset
  **median 53 m vertically** (p75 134 m). Parallel routes are *stacked*, not side-by-side: choosing
  a lane means choosing an elevation, and the rib between lanes is usually a cliff band.
- **Cliff drops are the lane-change mechanic.** 49 discrete cliff bands ≥8 m relief (excluding the
  two whole-canyon wall systems): p25/med/p75 = 18/29/69 m, eight in the 8–15 m "hit-this-for-fun"
  class, seven monsters >150 m. **59% of significant drops land in powder** (types 3/4 within the
  fall zone) — drops are one-way doors from an upper lane to a lower one, with the landing surface
  chosen to read as a reward.
- **Powder lines the lanes; it is not the wilderness.** 280 connected powder fields, but one
  mega-field (27.7 ha, median 27 m from the race line) *is* the course-long fringe system; the
  next largest are 4.8/2.6/1.4 ha pockets at 30–80 m out. Powder = the 25–75 m shoulder of every
  lane, plus a handful of named stash pockets — never an unbounded bowl.

**Generator rules for the free-explore feel:** (1) build 2–4 (peak 5+) parallel corridors over
~75% of the course, stacked with 40–130 m vertical offset and only 15–40 m of unrideable rib
between them; (2) connect upper→lower lanes with 10–30 m cliff drops landing in powder pockets
(~60% of drops); (3) give every lane a 25–75 m powder shoulder (that shoulder should roughly
match the groomed area in total acreage); (4) never leave rideable terrain more than ~75 m from
some authored line — the respawn layer and the feel both depend on it.

## Snow cover & the snow↔rock transition (measured via `tools/mountain-study/gari-snow.ts`, profiles `temp/gari-snowrock.png`)

- **The slope→material rule is inverted from real-world physics — deliberately.** Area-weighted
  analytic slopes per surface type: snow-family patches have **median slope 62–66°** (snow runs up
  near-vertical bank walls everywhere), while rock's median is 50° and "wall" (type 10) is the
  *flattest* material at 27°. By slope band: terrain steeper than 40° is ~55% snow and only ~11%
  rock; terrain *flatter* than 20° is ~50% rock/wall. **Rock is a floor-penalty material, not a
  steepness material**: it marks slow zones (canyon floors, off-line ledges, village ground), while
  snow is painted wherever the designer wants you to *ride* — including 80° banked walls. Rule:
  distribute materials by gameplay role, never by physical plausibility.
- **The material seam lives at the BOTTOM of rock faces, not the top.** Of 378 snow↔rock shared
  patch edges: **218 are base fillets, only 3 are cliff-top lips** (122 flush). Cliff tops stay
  snow — the snow patch itself curls over the lip and down the face; the switch to rock happens
  where the face meets the lower terrain. Corroborating: **42.5% of steep (>55°) rock-face area is
  plan-covered by snow ≥2 m above it** — snow shelves and curls sit over the rock faces
  throughout (the stacked-lane terraces). The three true material-edge lips all *kick upward*
  (~26° up-flick over the last 3 m): when a lip is a material edge, it's a jump takeoff.
- **Base fillets come in two populations.** Median drift wedge is subtle — **0.9 m tall over
  ~5.5 m** (a cosmetic seam softening, the "snow blown against the wall" read) — but the p75 is
  **17 m tall over ~11.5 m**: full rideable bank ramps. Dihedral kink at fillets is median 18°
  (gentle crease), p75 34°. Several profiles also show a small **gutter/trench right at the wall
  base** before the snow banks up — a catch that funnels the rider along the wall rather than
  into it.
- **Generator rules:** (1) snow patches own cliff lips — round the lip into the snow strip's last
  control row and continue snow partway down the face; switch material only at the base; (2) at
  every wall base, blend a fillet — 1 m × 5 m cosmetic by default, 5–20 m rideable bank where the
  line runs along the wall; (3) reserve material-edge lips for kickers, with a 20–30° up-flick;
  (4) paint rock by *function* (slow zones, inter-lane faces), and let snow climb any wall the
  player is meant to carve.

## Case study: the opening ice-canyon S (measured via `tools/mountain-study/gari-icecanyon.ts`, zoom `temp/gari-icecanyon.png`)

The signature feature after the start — 73 ice patches (30 MainPath + 43 SideGeo) spanning
162×87 m at alt −90…−255, fed by the opening drop. Its anatomy, section by section along
Race Line 0:

1. **Launch drop:** 60 m of plateau, then **74 m of altitude lost in ~20 m ridden** (effectively
   airborne off the plateau lip) onto a **landing bench: ~160 m at 11% grade** with low 3–8 m
   walls — land, recover, build speed.
2. **Second drop** (~−100% grade for 40 m) delivers into the canyon entrance at alt −89.
3. **The S itself (~250 m):** alternating apex radii **120 → 25 → 50 → 36 → 23 → 12 m** then
   opening to R>700 at the exit; channel width *grows* through it (98 → 150 m); apex walls
   **30–105 m** tall. The floor inside the S is *stepped*: near-flat or even uphill sections
   (0…−9%) punctuated by 150–250% falls — internal drops between each sweep.
4. **The ice is on the WALLS, not the floor.** Measured ice-band cross-tilts of **−40° to −71°**
   at the apexes (e.g. a 113 m-wide ice sheet at tilt −43°): the banked carve faces are ice
   (speed_gain 64, zero carve drag) while the floor between stays snow. Riding high on the wall
   *is* the fast line — material placement turns the risky line into the rewarded line. Ice ends
   exactly where the S straightens.

Also: the start chute itself is a small MainPath ice strip (gate → first drop) — free speed
before the first input. **Feature template:** drop → bench → drop → walled S with tightening
radii, stepped floor, ice on the banks, snow runout at the exit.

## How jumps are integrated (measured via `tools/mountain-study/gari-jumps.ts` + `tools/mountain-study/gari-ballistic.ts`)

- **Jumps are speed-emergent, not authored gaps.** The race lines hug terrain even through the
  big drops (median float −0.6 m); only **5 spots** on all 14 lines have the line genuinely leaving
  the terrain (true voids — finale gaps and one shelf crossing). Everything else called a "jump"
  is a **convex crest the rider's speed converts to air**. 1D ballistic sim along the spine:
  | rider speed | airborne events | median flight | median air | median drop |
  |---|---|---|---|---|
  | 54 km/h | 27 (6.2/km) | 26 m | 3.2 m | 28 m |
  | 90 km/h | 29 (6.7/km) | 64 m | 14.5 m | 68 m |
  | 126 km/h | 19 (4.4/km) | 147 m | 34 m | 99 m |
  The event *count* stays ~constant while flight *length* scales with speed — the 75 m terrace
  cadence means slow riders roll each step and fast riders gap terrace-to-terrace off the same
  lips. **One terrain serves every skill level**; this is the payoff of the bimodal
  pitch-and-bench profile.
- **Landings are the next pitch face.** Median landing-slope mismatch (arc angle vs terrain angle
  at touchdown) is 16–28° across speeds — each bench lip launches onto the following steep face,
  which is the natural catch. The handful of mega-flights recur at the same stations at every
  speed (0.40 km = the ice-canyon second drop, 1.15 km, 3.44 km, 3.73 km) — those are the
  authored set-piece crests.
- **Built lips kick ~6–26° up** (the rare material-edge lips and 2 of the 5 explicit-gap takeoffs);
  the rest are rolled or simply fall away. Landing surfaces of explicit gaps: snow/powder only.
- **ShowOff "ramps" are not jumps — they're quarterpipes.** All 60 type-18 patches are the
  TrickOnly patches (the flags coincide exactly), median surface tilt **78°** (p90 90°), median
  **6 m** from a race line: near-vertical trick walls standing beside the line, concentrated on
  the flat shelf.
- **Generator rules:** (1) never place "jump objects" on the course — shape crest lips at the
  pitch/bench transitions and let speed do the scaling; (2) verify each lip's arc envelope at
  15/25/35 m/s lands on the next pitch face (target ≤25° mismatch, fall-away landing 20–80 m
  past the lip); (3) reserve true voids for ≤2 finale set pieces; (4) quarterpipe walls are
  furniture beside the line (≤10 m), flagged trick-only, clustered in the slow zone.

## The watercourse (measured via `tools/mountain-study/gari-water.ts`, zoom `temp/gari-water.png`)

Water is **SurfaceType 5 ("ice" physics) wearing water/foam textures** (0093 open water, 0094
foam-edged bank, 0022 narrow stream, 0014 white rapids; 186 patches). Mapping it changes how the
whole course reads:

- **The course follows a single watercourse top to bottom.** Water textures span alt +101 →
  −2457: a frozen stream at the *start gate* (the "ice strip"), the opening S-canyon (the
  ice-canyon case study above is a frozen river gorge — its carve walls are water-textured), a
  30×167 m cascade ribbon below it, the big mid-course river canyon, and rapids continuing to the
  finale. The fast line and the waterway are the same idea: **water = ice physics = the speed
  artery**, dressed as a river.
- **The main river canyon (444×205 m, alt −1499→−1649) sits exactly in the flat-shelf zone** —
  the river falls 150 m over ~365 m (41% average) through **47 waterfall patches (>40°)**: a
  stepped cascade chain, while the "flat" race lines wind around it.
- **The criss-cross is vertical, lane by lane** (measured line-over-water events):
  - **Race Line 9** (high lane) clears the gorge by **56–71 m** — twice: true gap jumps *over*
    the river.
  - **Race Line 13** rides the **banks**: 138 m at +8 m above the rapids, then dips in.
  - **Race Line 12** rides **in the riverbed**: one continuous 276 m run at ~−6 m relative to the
    rapids' crests — the river *is* the trail (a luge run), plus a pass −83 m under a high fall
    sheet (riding behind/beneath the waterfall).
  - **Race Line 3** bridges it once at +17 m, then threads under falls (−13…−49 m).
  One 400 m stretch of canyon serves three stacked experiences: flight deck, bank trail, river
  luge — the densest expression of the stacked-lane principle anywhere on the mountain.
- **Generator rules:** (1) author the course *as* a watercourse — the spine can literally be a
  riverbed with ice physics, frozen at the top, open rapids lower down; (2) waterfalls are the
  cliff-drop vocabulary item wearing water dress (stepped 40°+ sheets every few dozen metres);
  (3) at a river canyon, give each stacked lane a different relationship to the water: jump it,
  ride its bank, ride *in* it, pass *under* a fall; (4) foam-edge textures (0094/0022 pattern)
  do the snow↔water seam the way fillets do the snow↔rock seam.

## Can this become a build toolset? — assessment

**Yes, with a concrete shape.** The evidence (strip-loft trail, named layers, density tiers,
surface striping, dtf-parameterized paths) says the original pipeline was effectively:

1. **Spine**: a 3D polyline/curve with dtf parameterization (this *is* `RaceLines`).
2. **Cross-section profiles**: a small library (bench-L, bench-R, gully, plateau, gap) with
   width/wall-height/bank parameters varying along dtf.
3. **Loft**: sweep the profile along the spine → MainPath strip (2 patches wide, ~10×20 m each)
   + flank/wall patches (~20×40 m) + skirt.
4. **Surface striping**: ice/snow center, powder fringe, rock margins, type-0 skirt — by offset
   from spine.
5. **Feature pass**: ShowOff ramps, rails (169 cubic-Bézier chains), gaps, shortcut chutes
   (secondary spines that branch/rejoin), props/triggers.
6. **Path emission**: race lines = spine(s); respawn AI paths = smoothed shadows of each branch;
   events keyed to dtf.

This can bake any authored spec to `Patches.json`-shaped data (the importer + bundle pipeline
consumes it end-to-end). Four more measurements round out this quarter's study
(`tools/mountain-study/gari-params.ts`, figure `temp/gari-rhythm.png`):

- **Walls vs turn radius (whole course).** The course rides in a walled corridor *always*:
      81–100% of 25 m samples on all 14 race lines have a ≥8 m wall within 60 m laterally
      (median tallest-side wall 34–48 m). Radius changes *which side*: at tight turns
      (R<80 m) the median wall on the turn-center side jumps to 12–14 m (vs ~0 elsewhere) —
      tight turns exist *because* terrain blocks the inside line; the S-turn case study shows the
      wall face staying on one side while curvature flips. Generator rule: corridor walls are
      ambient (30–50 m, both sides intermittently); add an inside obstruction wall whenever the
      spine's plan radius drops under ~80 m.
- **Longitudinal rhythm: bimodal pitch-and-bench, never constant slope.** Grade along the
      spine (100 m window): **30% flat (<15%), 33% extreme (>90%), only 16% in the easy 15–50%
      band** (median 56%) — the profile slams between steep pitches and benches with fast
      transitions (see the grade panel of `gari-rhythm.png`). Step/roll crests come every
      **45–100 m (median 75 m)** with median feature height ~16 m; 38% of the spine is convex
      (vertical R<125 m kicker territory) and a matching 38% concave (compressions). Generator
      rule: author the profile as alternating pitch/bench segments with terrace lips every
      50–100 m, not as a smoothed fall line.
- **Width transitions.** 12 pinches (<70 m) over 4.35 km, ≈1 per 350 m, widths 30–68 m.
      Two taper styles: *funnels* collapsing from open bowls at >100 m width per 100 m
      (e.g. 330→38 m at 1.02 km) and *held corridors* (taper <10 m/100 m). The two zero-width
      "pinches" (3.90 km, 4.22 km) are the finale gap jumps. Width and grade modulate against
      each other (steepest stretches are wide; chokes sit on moderate grade).
- **Continuity discipline: G1 by default, creases on purpose.** The quilt is watertight —
      5,084 shared edges match all 4 edge control points exactly (2 cm snap), ~2.6 shared
      edges/patch. Across shared edges, the worst tangent kink is **median 0.2°** (exact
      control-point mirroring = authored C1), but p75 is 29° — roughly **a third of edges are
      intentional creases** (wall-meets-floor, terrace lips). Generator rule: mirror control
      points across every interior edge by default; break continuity only at named feature edges.

Not yet studied: the flat-shelf showoff zone and the finale, as case studies (this doc covers the
top quarter).

## Reproduce / extend

```
cd Slopesmith
npx tsx tools/mountain-study/gari-study.ts    # whole-mountain stats + map + race-line profile
npx tsx tools/mountain-study/gari-pathing.ts  # branch graph, full profile, width sampling
npx tsx tools/mountain-study/gari-shape.ts    # heightfield, hillshade, cross-sections, banking (top quarter)
npx tsx tools/mountain-study/gari-params.ts   # walls-vs-radius, roller spectrum, pinches, G1 continuity + rhythm strip
```

All three decode raw SSX space (−Y-up, cm) to metres with up=−y/100, east=−x/100, north=z/100;
path decode is `PathPos` + cumulative `PathPoints` deltas (see `Snowknife/Bundle/PathBundle.cs`).
