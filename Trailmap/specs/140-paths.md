# 140 — Paths

A level describes its course not only as terrain but as a set of **paths** —
curves threaded down the mountain. Three kinds matter to gameplay: the **race
lines** that form the course spine and measure progress to the finish, the
**AI / respawn paths** that mark the racing line and the places a fallen rider is
put back, and the **grind-rail splines** the board locks onto. The player's start
position is derived from this data too. This chapter defines the path data model.
The on-disc encodings are in `250-paths-aip-sop.md` (race and AI paths) and
`220-level-pbd.md` (rail splines); how paths drive behavior is in `350-rails.md`
(grinding) and `390-pickups-and-race.md` (race progress and out-of-bounds reset).

## Race lines — the course spine

The **race lines** are an ordered set of curves running down the course. Each
race line carries an origin, a sequence of points along the curve, a list of
**events** that annotate it, and a baked **distance-to-finish** — the precomputed
distance from that line's position to the finish. Distance-to-finish is the
course's **progress metric**: a rider's position along the course is read off the
nearest race line each frame — the engine subtracts the rider's horizontal
arc-length along that line from the line's stored distance-to-finish
(runtime trace in `250-paths-aip-sop.md`). That scalar drives catch-up/
rubber-banding and the on-course reset (the "off the line" branch of the same
routine), but it is **not** itself the standings key — placement is a discrete
checkpoint counter and finishing is its own event (`390-pickups-and-race.md`).
[[140-raceline]]()

On disc, a path's points are relative steps that must be accumulated, not
absolute coordinates — `250-paths-aip-sop.md` owns the encoding, the
formula, and the proof. [[140-points]]()

> [[140-raceline]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs
> struct `PathB` (`DistanceToFinish`, `PathPos`, `VectorPoints`, `PathEvents`,
> `BBoxMin`/`BBoxMax`); map:"Out-of-bounds reset / wipeout recovery" — race
> lines are the ordered spine, `DistanceToFinish` per line; db:oob-reset.

> [[140-points]]() `250-paths-aip-sop.md` "Position encoding — accumulated
> steps" `[[250-accumulation]]`.

## AI and respawn paths

A second family of paths describes the **racing lines and respawn points**. Each
is a waypoint path (origin, points, events, bounds) carrying a **respawnable**
flag and a **line rating** (0…100). The respawnable paths are, literally, "where
a fallen rider gets put back": they enumerate authored on-course positions the
race manager can drop a rider onto after a wipeout or an out-of-bounds excursion.
Both families also carry per-path **events** (a typed value with a start/end
window along the path). A few types are read at runtime — the AI's jump
marker and "left the path" marker, the race-line checkpoint, and four AI-path
types the course reset uses to nudge or refuse a respawn station
(`250-paths-aip-sop.md`, `390-pickups-and-race.md`); the rest are inert.
[[140-aipath]]()

These paths are, plurally, **racing lines** — not one line per course. A level
authors many short, overlapping AI paths, and an AI rider chains them: it follows
one, then chooses the next from the paths nearest it, weighing each candidate's
line rating against its own current temperament (`395-ai-riders.md`). The rating
is what makes the family a *menu* — a course offers a safe line, a fast line and a
daring line over the same stretch of mountain, and which one a rider takes is a
runtime decision. Course-progress measurement, by contrast, rides the race lines
above; the two families are read for different purposes. [[140-aipath-network]]()

> [[140-aipath]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs
> struct `PathA` (`Respawnable` uint32, `NumPoints`, `NumEvents`, `PathPos`,
> `VectorPoints`, `PathEvents`); `PathEvent` (`EventType`, `EventValue`,
> `EventStart`, `EventEnd` — runtime readers: AI marker query `0x001392b0`
> (index 25), `cAIPath_HasType31EventInWindow` `0x00198088` (index 31, the
> tracker's re-select trigger), checkpoint (race-line index 12), and the reset
> station adjust `0x00196c50` / no-reset window `0x00196d50` (indices
> 25/28/30 and 29) — spec:250-events, spec:250-reset-events). The rating is
> `PathA`'s 0x0C word (`U3`), spec:250-patha. map:"Out-of-bounds reset /
> wipeout recovery"; db:oob-reset.

> [[140-aipath-network]]() db:ai-rider; @0x00118838 — the AI's path chain:
> candidates = the 6 nearest paths, scored by squared distance plus a rating-vs-
> mood match term; re-choice at 5 m off-path or 2 m from the path's end. GARI:
> 90 AI paths in the `.aip`, mostly ~250 m segments. spec:395-reselect.

## Grind-rail splines

Grind rails are stored as **cubic splines**. A spline is a chain of segments;
each segment is a cubic curve given by its control points and a set of
precomputed monomial coefficients, plus its own bounding box and cumulative
arc-length along the spline. Consecutive segments share an endpoint and are
doubly linked, and each segment back-references its parent spline; some splines
chain end-to-end into longer runs (powerline and fence lines authored as several
joined splines). A separate per-spline **style** integer classifies the spline,
and one style value marks the grind rails. [[140-spline]]()

The engine rides a rail as the **analytic cubic**, not as a polyline — the
riding algorithm (closest-point search, exact tangent) is `350-rails.md`'s;
the authoritative geometry is the cubic. Example counts (Garibaldi): 169
grind splines totalling 542 segments, all of the one grind style. [measured]
[[140-spline-ride]]()

A logic-graph node can also **toggle a spline's rail-riding candidacy at
runtime** — turn a spline on or off as something the rail query is allowed to
find — independent of any render-visibility state on the mesh that authored
it. A grind-style spline is grindable by default; the toggle is used two ways.
It **enables a default-off spline after an event**: a falling tree's trunk
splines are switched on only at the end of its fall-and-break sequence, once
the trunk is lying across the path. And it **disables default-on rails by game
mode**: every level authors a named "hide show-off" function that turns a set
of trick-line rails off (and hides their rail models), run when entering
free-ride or race mode but not the trick/show-off mode — so those rails are
grindable only in show-off play. [measured] [[140-rail-toggle]]()

> [[140-rail-toggle]]() map:"MainType 24 (teleport to a named instance) and
> MainType 25 (toggle a spline as a rail candidate)" — dispatcher main type
> 25 (`EffectOpcode25_ToggleSplineCandidate` `0x0013c530`) calls
> `RailMan_RegisterRailEffectCandidate` `0x00149038(splineIndex, flag)`, which
> pushes the flag onto the spline's scene-object candidacy bit (`350-rails.md`
> `[[350-analytic]]`; `Effect≠0` sets = grindable, `Effect=0` clears). Two
> authored uses. **Enable-after-event**, in MESA effect header 221: the last
> two nodes of a staged break chain (flash pots, then a falling
> `Mdl_TreeTrunk_EvergreenB_Fall_*`) toggle the trunk's two splines on
> (`Effect: 1`; `SplineStyle 1`, indices 87/88 — non-rail style, off until
> enabled). **Mode-gating**, in every surveyed level's `HideShowOff` named
> function (`MainType 25 Effect: 0` disables + paired `MainType 7` model-hides
> of the `Mdl_Rail_Metal` props), reached from `FreerideMode` and `RaceMode`
> but not `ShowoffMode` (`150-logic.md` `[[150-stores]]`): the
> `Spline_RailMetalShowOff` rails are off in free-ride/race, on in show-off —
> GARI 66, MESA 45, ELYSIUM 62, MERQUER 75, SNOW 92. db:rail-candidacy.

> [[140-spline]]() field inventory (control points, coefficients, bounding
> box, arc length, link/parent indices): `220-level-pbd.md` "Splines and
> spline segments" `[[220-spline]]` `[[220-segment]]`. Style classifier:
> SSF `Spline.SplineStyle`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.

> [[140-spline-ride]]() riding algorithm: `350-rails.md` "The rail is
> ridden as a true curve" `[[350-analytic]]`. GARI: 169 splines / 542
> segments, all `SplineStyle 13` (`Spline_RailMetalShowOff_` 66,
> `Spline_MetalRail_` 50, `Spline_FenceRail_` 41, `Spline_BillboardRail_` 12).

## Spawn derivation

Each per-mode path dataset carries exactly six **start-position indices** into
its AI-path table, one assigned path pointer per rider slot. Race/Freeride use
the AIP table and Show Off uses SOP. Final world placement is separate: the
engine transforms a fixed local six-rider staging formation through
`Mdl_StageArea_Start_0`. [[140-spawn]]()

> [[140-spawn]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs
> `TypeA.StartPosCount` / `TypeA.StartPosList` (indices into the `PathA` array);
> exported `AIPath.StartPosList`,
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs. GARI
> start count = 6 in both files. Mode/file selector and fixed six-pointer
> runtime field: `250-paths-aip-sop.md` `[[250-section-a]]`/`[[250-two-files]]`.

## Note: reset is path-driven, recovery is not

The respawnable paths and race lines above feed the **out-of-bounds reset**
(`390-pickups-and-race.md`); the physics **wipeout recovery** is an
unrelated, purely relative reposition that consults no path table
(`300-rider-states.md`). [[140-reset-vs-recover]]()

> [[140-reset-vs-recover]]() `390-pickups-and-race.md` "Out-of-bounds and
> the course reset" `[[390-reset-path]]`; `300-rider-states.md` "Wipeout
> and recovery".
