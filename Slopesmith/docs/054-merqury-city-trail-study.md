# 054 — How Merqury City runs its trail between buildings

A measured study of SSX Tricky's Merqury City Meltdown (course slot `MERQUER`), made to answer one
question for authored villages: what does "the trail moves between the buildings" actually mean in
numbers, and how much of it does a small alpine village on a 50 m vertex net get to keep? It was done
for the NOELRIDGE Christmas map (docs/052, "What the demo proved"), whose village was measured with the
same script before and after a rework, so the rules below carry a worked before/after.

The extraction was a fresh `snowknife import discs\ssx-tricky-europe.iso MERQUER Maps\MERQUER`. Every
number comes from the extraction's `Instances.json`, `Models.json`, `Props.obj`, `Patches.json` and
`AIP.json`, read in editor metres (`core/reference/terrain.ts`: raw SSX is centimetres, Z-up,
X-mirrored; `editorFromRaw(x,y,z) = (-x/100, z/100, -y/100)`). "Facade" means real wall triangles from
the world-baked prop mesh inside the rider band (+0.3 to +8 m above the trail), not bounding boxes —
an early box pass wrongly read the L-shaped corner blocks as pass-throughs. Course station is horizontal
arc along the main racing line (Race Lines 0→6 chained by distance-to-finish; 7–11 are the alternates),
which is how the engine rules distance. Corridor widths are five lateral rays per 25 m station against
facades, capped at 120 m a side. NOELRIDGE was measured with the same rule against its course knots.

## The city in numbers

**Scale.** 5,627 m of course, 2,469 m of drop, mean grade 44%. 417 building placements from 94 models,
plus 237 structure pieces. Placed heights median 111 m (p10 20, p90 180); footprints median 909 m². The
city is about twice real scale: 27 m street lights, 71 m trees, 64 m median streets.

**Setback.** Centreline to nearest facade: p10 12.7 m, median 37 m, p90 114 m; 4% of buildings within
10 m, 25% within 20 m, 52% within 40 m. Measured from the rideable snow's edge instead, the median is
**0 m**: for 60% of buildings the piste runs to the wall. There is no shoulder and no fence.

**Corridor.** Both walls present at 77% of stations. Two-sided width p10 28 m, median 51 m, p90 143 m;
the nearer face sits at a median 18.8 m, the farther at 32.5 m — the line rides one-third of the way
across the street, not down the middle. Street-scale canyons (≤ 80 m) cover 58% of the course at a
median 44 m; the tightest is 16 m. Height over width in those canyons: median 1.9 (p10 1.0, p90 3.8).

**Rhythm.** Downtown keeps both facades almost continuously (unbroken canyons of 1,050 m and 1,300 m);
the pulse is in width: 35% of downtown stations are ≤ 40 m pinches, widenings to ≥ 70 m come every
~250 m and last 25–75 m, real plazas ≥ 90 m every ~375 m. Density 4–8 buildings per 100 m through
3.3 km of downtown, then 0 for 800 m of park, then a shorter second downtown with the subway as its
pinch.

**Routes.** Five alternate race lines 340–1,100 m long, 45–146 m off the main line and — every one of
them — 25–79 m above or below it. 41 of 152 AI paths leave the main line by more than 30 m, in four
bundles; the route envelope is wider than 40 m over 44% of the course. **32 buildings have an authored
path on both sides**: in the 200–1,700 m downtown that is a split around a building every ~55 m.

**Grid.** 77% of buildings sit exactly on one 90° world grid. The trail does not: its heading is a
median 15° off a grid axis and only half the stations are within 15° of one, so of the buildings within
40 m of the line, 34% are skewed 30–45° to it. Facades are not rotated to the trail.

**Furniture.** Signal heads at a median 4.2 m from the line, park lamps 5.3, hydrants 7.7, news boxes
8.4, parking meters 9.4, bus stops 10.4; poles, signs and cars 10–20 m; barriers, benches, dumpsters and
trees 25–45 m. Street lights: median 14 m off the line, one per 34 m of course. All of it stands inside
the rideable street as obstacles.

**Verticality.** 408 m (7%) of the course is under a building or structure, in 12 episodes: the
Parlament passage (56 m, 20 m headroom), three glass overpasses (10–12 m long, 15–18 m headroom), the
mall (106 m, 7.2 m), park bridges, highway underpasses; plus the patch-built subway, 180 m at 15–20 m
wall to wall. 196 m is ridden on prop roofs and decks, starting with 225 m of rooftops.

## Design rules, with the village translation

Merqury's numbers first, then a village at roughly half scale (chalets 8–15 m to the ridge; ride speed
is the same, so clear widths cannot halve all the way).

1. **Setback.** Nearest facade 13–20 m from the line, never under 5 m. Village: nearest wall 6–10 m,
   far wall 12–20 m; one pinch per village at 4–5 m.
2. **Street width.** 18–30 m wall to wall; pinches 12–15 m for ≤ 25 m. Keep ≥ 18 m at ride speed.
3. **Height over width ≥ 1, aim 1.5.** Chalets alone give 0.4–0.6: build the street into the hillside
   (retaining wall and stacked buildings uphill) and put the church tower, hotel and lift station at the
   pinches.
4. **Ride one-third across the street.** Offset the line toward one wall; the far side is space for the
   alternate line and the furniture.
5. **Snow to the wall.** The facade is the boundary, not a fence; furniture stands inside the piste.
6. **Pulse the width.** Both walls kept through the core; pinches 10–12 m, street 15–25 m, a widening
   to 35–45 m every 120–150 m, one 45–60 m square per village with a side open to the view.
7. **Split around a building every 100–150 m**, branches 20–45 m apart and on different levels; one
   long alternate (back lane, roof line, under-passage) of 150 m or more, 30–40 m off the street.
8. **Buildings on one or two alignments; the trail crosses them diagonally.** Never rotate buildings to
   follow the trail's curves.
9. **Pass under something** two or three times per village, 6–12 m long at ≥ 6 m headroom, plus one
   signature passage of 25–40 m (arcade, undercroft, lift-station tunnel) at ≥ 5 m with walls 12–18 m
   apart.
10. **Furniture in three bands**: lanterns, stalls, sled racks 3–6 m off the line; sleighs, carts, signs
    6–12 m; trees, fences, snowmen 12–25 m; a lantern every 15–20 m, paired at squares.
11. **Density 4–6 buildings per 100 m through the core, then nothing** — at least 200 m of open meadow
    either side, so the village is an event rather than scenery.
12. **Enter from a roof or terrace drop.**

What does not translate: the absolute scale (64 m streets, 111 m towers are for 2× scale traffic); the
5.6 km length (a village is a 300–600 m episode — two or three canyon/plaza cycles, two or three splits,
one passage); the strict city grid (use two or three local alignments and let the diagonals happen at
the squares); building-scale passages of 20–40 m headroom (covered bridges, arcades and breezeways at
5–8 m take the role); highway decks and subways (lift pylons, cables, wooden bridges, sled tunnels);
hard furniture at 4–5 m from the line (keep hard obstacles 3–4 m off at village scale, soft ones inside
that); rooftop riding beyond a single drop-in.

## NOELRIDGE before and after

The village episode is course t 0.78–1.0 (≈ 450 m: the arched entrance drop, a plateau about 145 m
across, and the run-out descent). Merqury's own numbers are the shared-rule ones above.

| metric | village target | NOELRIDGE before | NOELRIDGE after |
| --- | --- | --- | --- |
| nearest-facade setback, median | 6–10 m near wall | 51.5 m (min 29.5) | 9 m (min 5.7); 10 of 12 within 20 m |
| stations walled both sides | ≥ 60% of the built stretch | 0 of 18 | 4 of 19 — the whole 115 m street |
| two-sided width / nearer face | 18–30 m / 6–10 m | none | 14–22 m / 6.9 m |
| run floor at the village knots | 15–45 m | 400 m | 26 / 36 / 45 / 36 / 26 m |
| height over width | ≥ 1 | undefined | 0.5 |
| buildings per 100 m, core bin | 4–6 | 4 (1.1 over the episode) | 9 (2.6 over the episode) |
| alignment | 1–2 grids, trail diagonal | five yaws, each 6–18° off the trail | one grid (115°/295°), trail at 4–20° |
| under-passages | 2–3 short at ≥ 6 m | the arch, 39° skewed to the trail | covered bridge 6 m long, 6.9 m headroom, square to the line; arch re-squared |
| split around a building | every 100–150 m | none | the lodge as an island, 24 m alternate lane with a rail and gems |
| furniture bands | 3–6 / 6–12 / 12–25 m | canes at 10 m, everything else 30–60 m off | Merqury lamps, hydrants, meters, mailbox, news box, bus stop, benches, park walls and snowed-in cars in the bands; 26 light strings |

Two gaps are the format's, not the crew's. A Slopesmith document carries one course line, so the split
around the lodge is physical — an open lane the rider can take — but not an authored route the metric
(or the AI export) can see; authoring alternates would need a second course or a rail-like route object.
And height over width stays at 0.5 because the terrain net's 50 m spacing cannot cut a retaining wall
behind a row of 6 m chalets without moving the vertices they stand on; the rule wants either a finer
net under the village or taller kits (a two-storey townhouse, the chapel tower at every pinch).

One thing the method above could not see, because it measured stations knot to knot: the run's spine
is a uniform Catmull-Rom through the knots, and the rework left a 225 m descent segment running into a
33 m street segment (and a 41 m one running out into 266 m). Sampled the way the export samples it, the
line looped at both ends of the village — 10 m under the plateau at the entrance, 18 m at the exit — and
`GET …/course` (docs/052) showed it on the first read. The fix was fifteen extra knots seated on the
ground at even spacing (31 in all); the seven village knots did not move, so nothing in the table above
changed. A study that states rules in stations should read them off the sampled spine, not the chords.

## Where the tooling went

The analysis and measurement scripts (`merquer-analysis.mts`, `noelridge-metrics.mts`) were session
scratch: Node built-ins only, reading the extraction folder and a frozen project document, emitting the
station tables and the comparison above. They were not kept in the repository — the method is fully
described here, and a rerun is a few hundred lines against the same files. The *placement* arithmetic
the rework crew scripted — a station and a setback into an `[x, y, z]` on the ground, a facade yaw off
the line's heading, a row of lamps at a spacing — is the API's own now (docs/052: `pos: {station,
lateral, above}`, `yaw: "course+90"`, `repeat`, and `GET …/course` as the ruler), so every rule above
that is stated in stations and setbacks can be authored in those terms from curl.
