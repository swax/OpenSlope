# 050 — Run scoring + course leaderboard

A timed, scored **run** down the mountain and a **leaderboard** at the bottom that records it. Getting on a board
starts a Race clock at zero or a Trick/showoff countdown at the map's seed; riding it banks a **trick score** from your spins/flips/airtime (gem pickups multiply it);
crossing the **finish line** at the bottom records your run into two top-10 lists — **best trick scores** and
**fastest times** — keyed by player name, one best entry per player. New runs only overwrite your previous entry when
they beat it.

Built by `OpenSlope/Setup/Leaderboard` (`LeaderboardSetup`), runs as part of `OpenSlope/Setup All` after the Info Board.
Re-runnable via `OpenSlope/Setup/Leaderboard`. Lives under `OpenSlope_Map/Leaderboard` (+ `OpenSlope_Map/FinishLine`), so it's rebuilt
per map. The trick scorer rides on the board itself (`RideableBoard.Score.cs`), so it works with every pooled board.

## The run lifecycle

| Moment | What happens | Where |
|---|---|---|
| **Mount a *fresh gate* board** | Run starts: score 0, clock running. | `ScoreMountHook(fromGate)` ← `OnStationEntered` |
| **Mount an abandoned board** | No run — the clock doesn't start and the finish won't record (free-roam). | `ScoreMountHook(false)` |
| **Ride** | The clock ticks; spins/flips/air bank a trick score; gems raise the multiplier. | `ScoreUpdate` per frame |
| **Cross a showoff checkpoint** | In Trick mode its SOP type-11 seconds are added to the remaining clock. The current port does not consume it as a Race checkpoint. | `RaceProgressTick` → `ApplyCheckpointBonus` |
| **Grind a rail** | Staying on a rail scores continuously (linear style, ~1,000 pts/sec — game-tested) as part of the open trick — no input needed; spins stack on top. The clock keeps ticking on the rail. | `ScoreGrindFrame` ← `GrindUpdate` |
| **Land it clean** | The trick banks (incl. any grind); `last trick +N` on the HUD. | `ScoreUpdate` |
| **Bad landing** (badly unfinished flip — deck near-sideways) | The trick is wiped — **no points** — but you **keep riding** (no eject); the HUD just shows nothing. | `badLandingZerosTrick` → `ScoreUpdate` |
| **Out-of-bounds reset** | The *uncommitted* trick + multiplier are wiped, but the run total **and the clock carry on** — OOB does **not** reset the timer (it's a time penalty). | `ScoreBailHook` ← `RaceKnockdownHook` |
| **Cross the finish line** | The run (score + time) is recorded into the leaderboard, then the run ends so it can't double-record. | `FinishLine.OnTriggerEnter` → `board.EndRun()` |
| **Get off (dismount)** | The run ends with **no** record (only the finish records). | `ScoreDismountHook` ← `OnStationExited` |

A timed run only starts off a **fresh board taken from a start gate** — not a board someone rode off and left on the
mountain (you can ride those freely, they just don't time/record). The signal is the board's `atGate` flag, set by the
dispenser (`BoardManager` → `PlaceAtGate`) and `[UdonSynced]` so the *mounting* client sees it; `OnStationEntered`
captures it before clearing it and passes `fromGate` to the scorer. So to set another time, grab a **fresh board at the
top gate** — re-mounting the one you just rode down won't restart the clock.

A finished board is **not** auto-recycled — it parks at the bottom like any dismounted board and returns to the pool only
via the manager's normal abandon timeout (`BoardManager.abandonTimeout`, 1 h). If finished boards pile up at the
bottom of a busy instance, that's the lever to shorten (or raise `BoardCap`); see docs/vrchat/042.

### Showoff clock + checkpoints

`LeaderboardSetup` reads `manifest.Race.ShowoffSeconds` into the map's `FinishLine`; a fresh Trick-mode
gate mount seeds `RunClockCs` from it and counts down. `RunTimeCs` remains the elapsed duration used for
leaderboard records, so changing the HUD direction does not corrupt result timing. Reaching zero ends the
showoff run.

Checkpoint awards come from **SOP race-line type 11**, not from collisions with `Mdl_CheckPoint_*` signs.
Snowknife writes each event's interpolated local position, remaining DTF, `EventValue` seconds and logical
route group to `manifest.Paths.Course.Checkpoints`; the importer stamps those arrays onto `CoursePath`.
The board's existing 0.1 s DTF poll tests the forward previous→current interval, matching the native
EventPath crossing query. Alternate-line copies share a group and the route position nearest the rider
supplies one payload (important where routes offer different values). The HUD switches to the remaining
`RunClockCs` and shows `TIME BONUS +m:ss.cc` briefly when an award lands.

#### Retail Race behavior not yet modeled

Retail Race handles the same type-11 station without using its time payload: it displays **CHECKPOINT**,
increments a discrete per-rider checkpoint/progress counter, and recomputes the standing leader. It adds
neither time nor points. The current Unity port applies imported checkpoints only in Trick mode; it does
not yet show the retail Race checkpoint cue or maintain checkpoint-count standings. Its Race leaderboard
behavior should therefore not be treated as checkpoint-accurate yet.

## The trick score (RE-grounded)

The board doesn't model SSX's full trick engine, but it *does* animate real spins (stick-X yaws the deck) and flips
(stick-Y somersaults it) and it tracks airtime — so the scorer banks points from exactly those, using the numbers from
[Trailmap: 390-pickups-and-race]:

```
while airborne:  _scoreSpinDeg += |yaw this frame|             # spins: stick-X + VR head-look
                 _scoreFlipDeg += |stick-Y flip this frame|    # flips
on a clean landing (airtime > orientationGrace):
    style  = (spinDeg + flipDeg) / 360  *  scoreSpinPer360(0.25)
    points = round10( style * gemMult * scoreStyleConstant(6786.9) )   # the gem multiplier scales style only
           + bigAir                                                     # flat, if airtime >= 4 s
           + grabTier                                                   # flat, from held-deck seconds (below)
    runTotal += points
    reset combo (rotation -> 0, multiplier -> x1)
big air:  airtime >= 4 s  ->  (airtime - 3) * 1000   # 1000 @ 4 s, 2000 @ 5 s, ...
grab:     held-deck seconds / scoreGrabTierSeconds(0.5) -> tier; 2=4000 3=8000 4=12000 5+=16000
```

So a bare clean 360 with no gem ≈ **1700** points, as in the game; a ×2 gem makes it ≈ 3400. Points bank **on the
landing** (a bail/OOB loses the uncommitted trick); the run total persists across the run. A bump-skip
(sub-`orientationGrace` air) banks nothing and keeps the multiplier for the real trick to come.

**Grabs are the deck itself** (`ScoreOffBoardUpdate`): taking the board off your feet into a VR hand mid-air
(`TakeFromFeet`) *is* the grab — the run and the open trick already survive that window, so the seconds the deck
stays held simply step the game's flat **grab-hold ladder** (4000 / 8000 / 12000 /
16000 at `scoreGrabTierSeconds` per tier, so at the 0.5 default a 1 s hold pays 4000 and 2.5 s+ caps at 16000),
banked with the trick when you catch the deck and land it. The holding hand labels it (**left/right grab** on the
HUD, which follows the deck into your hand). A throw-and-recatch pauses the timer while the deck flies (a fresh
catch re-bumps like the engine re-recognizing the trick). Engine behavior kept both ways: the hold **also accrues
style** — the engine's held-trick accrual (+0.0425 on recognition, then `scoreGrabStyleRate` × 0.045 style/s; the
authored rates run 1.0–5.0) — and style reaches the points **and the boost meter** (~305 pts + ~3% meter per held
second at rate 1.0), while the flat tier points stay score-only: **no gem multiplier, no meter**
([Trailmap: 390-pickups-and-race]). Knobs: `scoreGrabEnabled`, `scoreGrabTierSeconds`, `scoreGrabStyleRate`.

**Grinding scores continuously** (`ScoreGrindFrame` ← `GrindUpdate`), matching the game's held-trick rail scoring:
just *staying* on a rail accrues base style every frame (`scoreGrindStylePerSec`) — no input needed. It is **LINEAR**:
the game test measures a plain grind at **~1,000 pts/sec** (~5,000 for 5 s, ~2,000 for 2 s), which is fully the style
term (`0.15 style/sec × 6,787`); there is **no** flat hold-tier on a grind (the hold counter ticks, but the banked
score is just style — [Trailmap: 390-pickups-and-race]). **Spins on a rail score like air spins** — `GrindUpdate` accrues the deck's
yaw rotation into the *same* `_scoreSpinDeg` the air uses (the game scores air and rail spins alike),
so a 360 on a rail is a discrete +1,700 on top of the base grind. It's all the *same* open trick: grind style + rail
spins + air spins fold into one `style`, banked when you land off the rail. The grind branch `return`s before
`ScoreUpdate`, so `ScoreGrindFrame` also keeps the run **clock** ticking on the rail (and the bank gate treats "any
grind held" as a real trick, so a spin-less grind banks).

`RunScore` (the live field the finish reads) is the banked total **plus** the in-progress trick's current worth, so a
finish crossed mid-air still counts the trick you're in.

### Gems = the multiplier

Riding through a score gem (`GemPickup`, tier 2/3/5) calls `board.ApplyGemMultiplier(tier)` — **MAX-not-stack**: it
raises the active multiplier, which the next banked trick consumes (then resets to ×1 on the land). Local to that
rider's run. (Walking through a gem still pops it, but has no run to multiply.) This is the future hook the gem's
`Multiplier` field was always stamped for.

## The finish line

`FinishLine`, at the bottom of the run, fed by **two detectors that land in one method** (`CrossOnBoard`, whose
cooldown makes a crossing both see count once):

- **The primary is the board's own course progress.** The engine detects a finish crossing on the rider's
  distance-to-finish passing zero — a *progress* event with no height in it ([Trailmap: 390]) — and the board does the
  same: while a run is active it polls its DTF (`RaceProgressTick`, every 0.1 s, the same baked metric the standings
  board reads) and hands a zero crossing to the finish line. Hysteresis makes it once-per-pass: after firing it
  re-arms only when the rider has regained 120 m of DTF — the trip a lap course's tube actually makes — so lingering
  and bouncing around the foot can't re-fire it. MEGAPLE is why this is the primary: its run drops riders into the
  finish funnel from the air, over any gate box of sane height, and the funnel feeds them straight into the tube.
- **The secondary is the trigger box** (an `isTrigger` `BoxCollider`): the riding board sweeps its kinematic
  **RiderProbe** capsule through it, raising `OnTriggerEnter` — the same dual-collision pattern as gems / boost pads
  (docs/040, docs/vrchat/043). On a map with no baked DTF it is the only detector.

On a lap course there is a **third station these never see mid-race**: the lap-gated finish tube. On MEGAPLE the
shaft sits ~24 m *up*-course of the DTF=0 plane, so every pass but the last ends at the tube — its mouth counts the
lap itself (docs/053) and only the final, unlifted pass carries on to the plane, where the detectors above record
it. The stations share `board.LastLapCountTime`, so a crossing two of them see counts once.

`CrossOnBoard` reads the board's run off its public fields (`RunActive` / `RunScore` / `RunTimeCs` / `RunMode`), counts a
lap or records: `EndRun()` so lingering can't double-record, then `leaderboard.Submit(name, score, timeCs, mode)`. A
walking player has no run, so both paths ignore them.

`mode` is the rider's **ride mode**, frozen into the run at mount (the Settings Board's Race / Trick / Free ride picker,
docs/vrchat/047). It picks **which list** the run competes on — race runs enter *Best times*, trick runs *Top scores* —
so a time-trial pass with no tricks can't park a `0` in the score table. A free ride never starts a recordable run at
all, so it never reaches here. Both lists still display the other metric alongside.

The submit is **local** on the finishing client; the networking lives in the leaderboard (below).

## Two top-10 lists, per-player best

`Leaderboard` keeps two lists, each capped at **10** and one entry per player (by display name):

- **Top scores** — sorted by score **desc**; each row also shows that run's **time**.
- **Best times** — sorted by time **asc**; each row also shows that run's **score**.

`Submit` updates a player's entry in each list **only if the new run beats it** (higher score / lower time) — so a worse
run never displaces your best, and a better one overwrites in place. A player's best-score run and best-time run can be
different runs (the lists are independent). Records **persist** for the instance's life (a player who leaves keeps their
entry — it's a record board). Time is shown `m:ss.cc` (the game's HUD clock format).

## The run HUD

While a run is active, a small **local** readout (`RunHud`) rides on the **top of the board you're riding**:

1. the current **time** (`m:ss.cc`) — elapsed in Race, remaining in Trick/showoff,
2. the current **points** (your whole run score),
3. on a course that laps, the **lap standing** as the game's announcer counts it — the passes left counting the
   one under way, off the board's `LapsRemaining` (docs/053): `3 laps left` after MEGAPLEX's first crossing, then
   `2 laps left`, then `final lap`. Hidden on a single-pass course, and
4. the real-time **trick block** (two lines while a trick is live, one after):
   - **In a trick** (spinning / grinding): line A = the *accumulating* trick score (`+N`, **white**), line B = the
     **equation** `w × x × y × z` (`rotations × style-per-360 × gem-mult × base`) — or `grind Ns` on a rail.
   - **On landing**: the score turns **green** and the equation drops; it holds for `resultHoldSeconds` (3 s) then clears.
   - **On a bail** (badly unfinished flip, or out-of-bounds mid-trick): the *lost* score shows in **red** with the
     reason below it (`sloppy landing` / `out of bounds`), also for ~3 s then clears.
   - A 0-point trick, or before your first trick, shows nothing. The board bumps `RunResolveTick` on each bank/bail so
     the HUD knows exactly when to start the hold window.

   (`RunTrickPts` = the live accumulating value; `RunLastTrickPts` / `RunLastBailed` / `RunLastBailReason` carry the
   resolved result. There is no impact-based "hard slam" bail — gravity makes clean big-air landings hit a high
   into-surface impact, so it false-triggers; only the alignment bail is used.)

It mirrors `DebugHud`: one per-client object (sync None) that scans the pool for the board the local player is riding
(`IsRiding`), reads the run off its public fields (`RunActive` / `RunTimeCs` / `RunScore` / `RunStyleRots` /
`RunGemMult`), positions itself **flat on the deck, locked to the visible board pose** (`RideableBoard.DeckPivot`, the
"Heading" pivot that carries the deck's facing + bank + flip + pitch) in `PostLateUpdate` — so it **banks into carves and
flips end-over-end with the board** rather than billboarding (deck-space offsets keep it flush just above the deck, a
touch ahead of your feet; an old board with no deck pivot falls back to the billboarded panel). Other players don't see
your readout. The panel is shown only while a run is active. Built by `OpenSlope/Setup/Run HUD` (in `Setup All` after the
Leaderboard).

### Networking

Mirrors the Players Board (docs/vrchat/048): the two lists are the only synced state, held by **whoever last finished** (sync
**Manual**, six `[UdonSynced]` parallel arrays). `Submit` takes **ownership** of the board object, folds the result in,
trims each list to ten, and `RequestSerialization()`s; every client repaints from the set it last received
(`OnDeserialization`). Two finishes in the very same network frame can race (last-writer-wins on the whole arrays) — at
worst one record is dropped and re-established by the next finish, the same trade the Players Board makes. Display-only:
no Interact, no per-frame work — it repaints only on a submit / deserialize.

## Placement (auto + movable)

`LeaderboardSetup` derives both from the course's own data.

- **The finish plane** is the **DTF = 0 crossing** of the baked course progress (`OpenSlope_Map/CoursePath`'s `DistToFinish`),
  interpolated inside the race-line segment that straddles zero. That is the engine's real finish: on Merqury City the
  level's checkered-flag decal (`Mdl_FinishLine_6000`, the only user of texture `0180.png`) begins on it to within
  **0.14 m**, and on every course the nearest placed instance is the finish arch `Mdl_FinnishGate_*` (0.8–5.8 m). The
  last race line carries a `PathEvent` of type 9 whose `EventStart` is bit-equal to that line's `DistanceToFinish` —
  the authoring tool's own finish marker (Trailmap 250/390).
- **The trigger box** takes its width from the level's finish **arch** (`Mdl_FinnishGate_*` crossbar + posts), whose
  AABB snowknife bakes into the bundle as `Paths.Course.FinishArch` (34–42 m across the five courses). Its height runs
  from the arch's buried posts to **30 m above the crossbar** (`GateHeadroom`), because the engine's crossing is a
  *progress* test with no height in it — a rider who flies over the crossbar has still crossed, and on MEGAPLE that is
  the common case: the finish-shaft mouth reaches ~11 m above the crossbar and the run drops riders into the funnel
  from the air, so a crossbar-height gate never fires and no lap ever counts. Only the 8 m depth is otherwise ours.
  The box's **uphill face lies on the DTF = 0 plane**, so the record fires the instant the rider crosses — the depth
  only stops a fast rider tunnelling.
- **`Mdl_StageArea_Finish` is not the line.** It is the **podium / corral 20–48 m past** it, co-located with
  `Mdl_Finish_Stage` / `Mdl_Finish_Screen` / `Mdl_Finish_Coral`. The game resolves it by name
  as a *placement anchor* — its collision is a ~1 × 0.1 × 1 m box, not a crossing
  trigger. Note it carries `PlayerCollision: false`, so snowknife emits no bounds box and **no scene object is named for
  it**; it stays in the merged Props mesh.
- **The display board** stands in the run-out **27.5 m past the line, 2 m to the rider's right**, at the plane's height,
  facing **back up the hill** so a finisher reads it head-on. Both offsets are in the finish frame (downhill / right), so
  the placement carries to any course.
- **Fallbacks:** arch missing from the bundle (regenerate it) → a generous 80 × 40 × 8 m catch box on the plane; no
  baked DTF → that box at the **lowest point** of `OpenSlope_Map/CoursePath` (which *overshoots* the real line by tens of m,
  so it warns); no course path → the player spawn.

Both live under `OpenSlope_Map`, so **nudge / resize them in the scene afterward** if needed. The build log names which source
the finish came from (`finish from DTF=0 plane + FinnishGate arch (39.2 x 29.4 m) at …`).

## Course progress (distance-to-finish)

The course carries a **distance-to-finish (DTF)** field — the game's own progress metric ([Trailmap: 250-paths-aip-sop], [Trailmap: 390-pickups-and-race];
each race *line* stores one authored DTF at its start, and a rider's continuous DTF is that value minus the horizontal
arc-length walked along the line). It's baked onto `OpenSlope_Map/CoursePath` (the `RailNetwork`) as a per-point
`DistToFinish[]` (metres) + `CourseLength`, and read at runtime by
**`RailNetwork.QueryProgress(worldPos, maxDist)`** → `PProgress01` (0 at the start gate → 1 at the finish),
`PDistToFinish` (metres to go), `PFound`. It reuses the network's existing spatial grid, so a query is allocation-free.
This is the foundation for live race **standings**, **splits**, ghosts, and a run-`%` HUD readout.

DTF reaches **0 exactly at the finish line** and goes negative past it: the last race line runs on beyond the line, as
authored (25 m on Mesablanca, 61 m on Merqury City), so `PDistToFinish` clamps at 0. That zero crossing is what places
the finish trigger (above).

Baked by `CourseProgressBuilder` (auto-run when `CoursePathBuilder` builds the course path — i.e. on map import and on
`OpenSlope/Refresh/Course Path`, which is why re-baking progress has no menu item of its own) from the game's **authored** values: the per-race-line
`DistanceToFinish` is carried through the bundle (`snowknife` `PathBundle` → `manifest.Paths.Course.LineDtf` +
`RaceLineCount`); each race line is anchored at its authored DTF and per-point DTF is that anchor minus the **horizontal**
arc-length along the line — exactly how the engine derives a continuous DTF (Trailmap 250). **Race lines only**; AI/respawn
lines are `NaN`-marked and excluded. Progress is normalized against the **`Mdl_StageArea_Start`** marker (so the start gate
reads 0 %), falling back to the top race line.

A level whose bundle predates the DTF carry has no `LineDtf` → the metric stays off and the bake logs a warning;
regenerate that level's bundle with `snowknife gltf <level>` and re-import. On a converted retail level: 18 race lines, **4607 m**
start-to-finish (start 0 % · finish 100 %).

## Tuning (board inspector, "Trick scoring" header)

| Field | Default | Meaning |
|---|---|---|
| `scoringEnabled` | true | Master toggle; off = the finish records time only (score 0). |
| `scoreStyleConstant` | 6786.9 | Style→points scale (RE `0.67869 * 10000`). |
| `scoreSpinPer360` | 0.25 | Style accrued per full 360 of rotation. |
| `scoreBigAirSeconds` | 4 | Airtime at/above which the big-air bonus kicks in. |
| `scoreBigAirPerSecond` | 1000 | Big-air points per second over 3 s. |

> **New-field gotcha (docs/vrchat/013):** a field added to an existing `RideableBoard` is read by already-placed
> pooled boards as the type default (scoring **off**) until their backing heap is re-pushed. `LeaderboardSetup`
> doesn't touch the boards; after adding the feature to a live scene, stamp the defaults onto every board
> (`CopyProxyToUdon` per instance) and save — done once per project.

## Files

`RideableBoard.Score.cs` (the run scorer + read surface) · `FinishLine.cs` (the record trigger) ·
`Leaderboard.cs` (the two synced lists + display) · `LeaderboardSetup.cs` (build + place) · hooks in
`RideableBoard.cs` / `.Mount.cs` / `.Race.cs` and the gem multiplier in `GemPickup.cs`. Course progress:
`CourseProgressBuilder.cs` (bake authored/recompute DTF) · `RailNetwork.cs` (`QueryProgress` + `DistToFinish`) ·
`CoursePathBuilder.cs` (auto-stamps on build) · `snowknife` `PathBundle.cs` / `BundleManifest.cs` (carry `LineDtf`).
Research: [Trailmap: 390-pickups-and-race] and [Trailmap: 250-paths-aip-sop].
