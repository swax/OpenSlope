# 390 — Pickups and Race Logic

The course-level interaction systems: out-of-bounds resets, collectible
score multipliers, event triggers (fireworks), and the race lines as the
course-position metric. Everything here rides the placed-instance and
effect-logic machinery of `120-objects.md` and `150-logic.md`; the path data
is `140-paths.md`. [[390-overview]]()

> [[390-overview]]() db:oob-reset; db:course-boost — the trigger /
> pickup / reset props are all invisible or pass-through instances wired to
> effect slots (doc:../research/extracted-data.md "Instance placement
> census").

## Out-of-bounds and the course reset

A course marks out-of-bounds two ways: terrain patches authored with the
**reset surface type** (type 0 — large skirts of it surround the rideable
course), and invisible **reset-zone volumes** placed like any other
pass-through instance (`120-objects.md`). Riding into either takes the rider
out of play and triggers the course reset. [[390-reset-marks]]()

The reset itself is a **course-level, path-driven** mechanism: the rider is
placed back **on the course** using the path tables — the AI paths flagged
respawnable and the race-line spine (`140-paths.md`) — facing down-course.
Nothing in the rider physics handles the reset surface (it is an ordinary
response-table row there; the *control* layer polls the contact surface each
frame and requests the reset), and the physics **wipeout recovery** is a
separate, purely relative mechanism (`300-rider-states.md`): crash recovery
keeps you where you fell; the reset puts you back on the line.
[[390-reset-path]]()

A reset-zone volume reaches this through the logic graph: its collision chain
is a single **course-reset node** (`150-logic.md` main type 13), which funnels
into the same reset entry the manual reset button uses from every riding
state. [[390-reset-entry]]()

**Seven things request a reset**, all through that one entry, which is
refused for a rider who has already finished and while the rider's tracked
path station lies inside an authored no-reset window
(`250-paths-aip-sop.md`): a reset-zone volume's course-reset node; riding
onto the reset surface — every riding control state polls the contact
surface each frame; the Reset button (the one **manual** trigger, costing
0.12 of the boost meter — every automatic one is free); falling below a
death plane 100 m under the world grid's vertical origin; a **prop-bounce
accumulator** — each bounce off a prop adds up to 1, the total decays 4.4 %
per frame, and a reset fires above 4.49, so a rider wedged against scenery is
pulled back to the course; a **hard-impact accumulator** fed by flagged-prop
impacts (decays 2.2 % per frame, threshold 12); and a wipeout that fails to
resolve within 7 s of tumbling or 3 s of its landing phase
(`300-rider-states.md`). [[390-reset-triggers]]()

**The placement.** The request records a drop height of about a metre and a
forward bias, plays the reset sound for the local human, and enters a warp
state that holds for **0.8 s** — the rider fades out over the first
half-second and a per-viewport presentation effect switches on at 0.2 s. The
target is then computed: start from the rider's current station on the AI
path it is tracking, advance it by the bias (extrapolating straight past the
path's end along its last direction if it overruns), then choose, among the
**six respawn-enabled paths nearest that point**, the one minimising the
distance to its closest point plus the distance to the point 8 m further
along it — rejecting candidates whose projection lands within 2 m of their
end, and keeping the current path when it wins — and project onto the winner.
The station is nudged by any authored respawn windows covering it, and the
path point there becomes the placement: heading is the segment's horizontal
direction, velocity is exactly **30 km/h** along it, and the placement
primitive probes vertically from 2 m above to 3 m below, sits the rider on
the hit surface tilted to its normal, raises them by the drop height and
enters the airborne drop-in, so they fall the last metre onto the snow. The
trick combo is cancelled and the chase camera re-snapped. A sideways
"don't land on another rider" search exists but the shipped reset never
enables it. [[390-reset-placement]]()

**The forward bias** is what makes the reset rubber-band-aware rather than a
plain put-back. With a single rider, within 100 m of the finish, on Tokyo
Megaplex, or in any mode outside the three race modes, it is zero. In the race
modes with several riders it is 0.8 × the speed of the rider one place
behind (one place ahead for the last-placed rider), so a reset drops you
roughly where your pursuer will be in 0.8 s. In the pre-menu initial mode it
is the other riders' mean distance-to-finish — a course distance added to a
path station, which would throw the placement past the path end if that mode
were ever ridden with company; it is not a selectable mode, so this is
recorded as a quirk rather than a behavior. [[390-reset-bias]]()

> [[390-reset-triggers]]() `Boarder_CourseResetEntry` `0x00118f18`: `bgez
> +0x418 → return` at `0x00118f48` (finish stamp, −1 while racing);
> `cPath_StationOutsideType29Window` `0x00196d50(+0x57a4, f12=+0x344) == 0 →
> return` at `0x00118f5c`; SFX `0x002193a8` when `+0x41c == 1` at `0x00118f78`;
> tail `0x00119be8` → `+0x81c/+0x820/+0x824`, `SetMotionState(4)` at
> `0x00119c54`, `SetControlState(22)` at `0x00119c74`. Requesters (18 sites,
> `refs 0x00118f18`): main-type-13 `0x0013c3a8` (`+0x304 = 1`, f12 = 101.46
> `0x42caebe0`); control-state poll helper `0x00108140` (`andi word,1` →
> manual, `+0x304 = 0`; else `+0x290 == 0` → automatic, `+0x304 = 1`) and
> inline copies `0x00104724..0x00104768`, `0x00103394`, `0x0010557c`,
> `0x00102124`, `0x00100534`; Reset bit: cPlayer cruise builder `0x0015138c`
> puts pad bool 37 at bit 0 (`0x00151428..0x00151448`), airborne builder
> `0x00152024` at bit 1 — `BTNMAP0.DAT` `{ Reset, (SELECT) }`; death plane
> `0x00117c64..0x00117c90`: `+0x148 < [0x00347688]+0xc − 10000.0`; bounce
> accumulator `+0x2e4` `0x00117bb8..0x00117bfc` (×0.956 `0x3f74bedf`,
> threshold 4.49 `0x408fbe85`; writers `0x00125cac` `+= 1 − dot`, `0x0010d648`
> `= 1e6` from the wipeout timeout); impact accumulator `+0x300`
> `0x00117c00..0x00117c4c` (×0.978 `0x3f7a70b9`, threshold 12.0 `0x414008ca`;
> writer `0x00126628` `+= (2.5 − J)·max(k, 0.2)`); penalty gate on `+0x304` at
> `0x0011cf48` (`TrickScore_PlacementResetFinalize` `0x00155ac0` →
> `0x0011b020` −0.11997 only when `+0x304 == 0`). map:"Course reset: triggers,
> warp state and placement".

> [[390-reset-placement]]() control state 22: enter `0x00106a88` (`sw
> zero,8(a0)`), update `0x00106a90`, exit `0x00106a48` (`+0x448 = 1.0`,
> `+0x44c = 0`, stops viewport effect 12 via `0x001a7d58`); update: timer `+=
> 1/60`, `+0x448 = clamp((0.5 − t)·2)` at `0x00106b14`, `t > 0.2` → viewport
> effect 12 (`0x001a7d40`) and `+0x44c` fade at `0x00106ba8`, `t > 0.8` →
> `Boarder_CourseReset_AdvanceAndReselectRespawnPath` `0x00118c10(boarder,
> f12 = bias)` at `0x00106c7c` then `Boarder_CourseReset_PlaceOnRespawnPath`
> `0x00119228(boarder, a1 = 0, f12 = drop)` at `0x00106c8c` (state data =
> `[boarder+0x5ae0]+0x810`; `+0x81c/+0x820` drop height / bias). `0x00118c10`:
> `cPath_TotalLength` at `0x00118c60`, station + bias at `0x00118c70`,
> extrapolation `0x00118ca4..0x00118d0c`, `Path_CollectNearest(pathMgr, point,
> out, 6)` `0x00198400` at `0x00118d24` (respawnable only),
> `cPath_ClosestPointPerpDist` at `0x00118d68`, end rejection `total − 200 <
> arc` at `0x00118d8c`, lookahead `arc + 800` at `0x00118da0`, score
> `0x00118de8..0x00118e34`, keep-current `movz s6,zero` at `0x00118e58`,
> `Path_ClosestPointArcLength` at `0x00118ea4` → `+0x344/+0x350/+0x360`.
> `0x00119228`: event adjust `cPath_AdjustStationForRespawnEvents` `0x00196c50`
> at `0x00119280` → `+0x350`; `cPath_PointAtStation` at `0x00119298` (returns
> the segment's unit direction — x,y unit-horizontal, z slope — not a
> position); heading `atan2` `0x001192a0..0x00119340`; `beq s0,zero` at
> `0x00119344` skips the avoidance block `0x0011934c..0x001199b0` (1000-unit
> gather, 200-unit steps, 800-unit cap, `WorldLine_InitSegmentQuery` /
> `WorldIntersect_QueryNearest` at `0x00119980/0x00119998`, retry
> `0x00119d38(boarder, 0, DTF + 500, f13)` at `0x00119b14`) whose only a1=1
> producer `0x0011a028` has no callers; velocity = dir × 833.333
> (`0x44505555`) at `0x00119b34..0x00119b58`; `Boarder_InitPlacementAndContact`
> `0x0011caf0(boarder, pos = +0x350, vel, a3 = 0, f12 = heading, f13 = drop)`
> at `0x00119b78`; camera `0x00173a78` → `0x00177dc8` at `0x00119b9c`.
> `0x0011caf0` modes: `a3 ≠ 0` = start-gate hold (no probe, motion 4 / control
> 1); `a3 == 0, f13 > 0` = probe `z + 200` to `z − (f13 + 200)`
> (`0x0011cca4..0x0011ccdc`), hit → pos/normal/tilt `0x0011cd04..0x0011cdcc`,
> `+0x148 += f13`, motion 1 / control 13 + anim 547 (`0x0011cee4..0x0011cf04`);
> `f13 ≤ 0` = probe then motion 2 / control 3 (`0x0011cf2c/0x0011cf38`). Its
> other callers: `ZBoostNode_Update` `0x00141e98` (re-seat at own position),
> `StartGateIdle_UpdateSlot` `0x0016dac0` (`0x0016db18`, a3 = 1, per-slot
> re-pin every frame before the countdown; caller `0x00177038` loops 8 ×
> 64-byte slots at `raceMgr+0x220`), `RaceStart_PlaceRidersAtGatesCandidate`
> `0x00176eb8`. GARI: 81/90 AIP and 32/32 SOP paths respawnable. map:"Course
> reset: triggers, warp state and placement".

> [[390-reset-bias]]() `Boarder_CourseResetEntry` `0x00118f18`: mode word
> `0x0032f08c` at `0x00118f8c`; `myDTF > 10000` (`0x461c4000`) at `0x00119084`;
> course `0x0032f088 == 8` at `0x00119098`; modes 2/7/4 at
> `0x001190a0..0x001190b0`; neighbour `+0x110 ± 1` at `0x001190c0..0x001190dc`;
> |velocity| at `0x00119030..0x00119058`, ×0.8 (`0x3f4ce1bd`) at `0x00119150`;
> `riderRow+0x65 < 0 → 0` at `0x00119128` (skips riders of the other class);
> mode-0 mean DTF `0x00118fa8..0x00119008`. Mode 0 is the pre-menu initial
> value the front end never writes (`395-ai-riders.md`). Multi-rider bias not
> observed live — doc:../research/open-questions.md.

**An authored reset node works, and the distance it moves you is how far off
the line you were.** The same node was ridden on two courses: on one the rider
was still on the racing line when it fired and was moved **22–25 m**; on a
shorter course whose run had already sailed past the end into nothing, the same
node moved them **2975–2983 m**. Both in a single 20 Hz sample, three passes
each, against ordinary motion of under 2.5 m per sample. So it is a
carry-back-to-the-course rather than a warp to a fixed point, which is what the
progress-biased placement above predicts. [measured] [[390-reset-live]]()

> [[390-reset-live]]() Live evidence: `Trailmap/tools/autotest`, cell
> `rider-reset` — runs 20260806-101357/-101611/-101822 (AUTOTEST2, 2975–2983 m)
> and the AUTOTEST1 batch from -102319 (22.1–25.3 m). No boarder field records
> that a reset happened, so the single-sample position discontinuity is the
> observable; the harness bounds it to samples where this cell is the rider's
> nearest, and to genuinely adjacent samples, so a rider merely returning to the
> area cannot be read as a jump.

> [[390-reset-marks]]() doc:../research/extracted-data.md — GARI: 622
> type-0 patches; 20 invisible `ResetZone` instances (40×40) in the census.

> [[390-reset-path]]() db:oob-reset — the no-physics-branch negative
> and the path-table correction (map:"Out-of-bounds reset / wipeout
> recovery"); respawnable flag + race lines
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs.

> [[390-reset-entry]]() ResetZone chains: MERQUER 29× /
> GARI 20× `Mdl_ResetZone*` → CollisionEffectSlot = a single main-type-13
> node; handler 0x0013c3a8 → `Boarder_CourseResetEntry` 0x00118f18 (also
> polled from every control-state update = the manual reset), which averages
> the other riders' DTF (`+0x374`), stores placement at
> `[boarder+0x5ae0]+0x81c/+0x820/+0x824` (0x00119be8, fixed param 101.46 from
> the SSF branch), and switches control state 4 → 22 (the reset warp). See
> `230-level-ssf.md` `[[230-reset]]()`.

## Race lines as the position metric

Each race line carries one baked **distance-to-finish** (DTF) at its start,
making the ordered race lines the course's progress ruler: a rider's
continuous DTF is the nearest race line's stored start-DTF minus the
horizontal arc-length from that line's start to the rider's projected
position, not raw world coordinates (`140-paths.md` defines the data;
`250-paths-aip-sop.md` the runtime trace). It is recomputed and cached every
frame. DTF drives **rubber-banding/catch-up** (the average of the *other*
riders' DTF), **off-line detection** (perp distance > 500 units → snap back
to the line — the path-table OOB reset), and the **course-progress total**.
It is **not** the standings key (that is the discrete checkpoint counter
below), and **no DTF-driven announcer or music-intensity input was found**
— race music is a fixed path level of 80 and race barks are event/place-based.
[[390-raceline]]()

> [[390-raceline]]() db:race — `DistanceToFinish` per race line, one f32 at
> the line's header (AIPSOPHandler.cs `PathB`, offset 0x0C; `250-paths-aip-sop.md`);
> race manager `Boarder_UpdateRaceLineProgress`
> 0x001182a0 (DTF → `boarder+0x374`), projection `cPath_ClosestPointArcLength`
> 0x00197970, line-select 0x00118618 → 0x00198608, rubber-band 0x00118f18,
> progress-total `Boarder_GetCourseProgressTotal` 0x001170d8. Confirmed negatives:
> standings use the discrete counter `rider+0x20` not DTF; no DTF-driven music
> (fixed `SetPathLevel(80)`, db:music-system). spec:250-dtf-runtime.

## Score-multiplier pickups (gems)

The floating multiplier gems are placed instances with **pass-through
collision** (response mass 0, box collision) and a collision effect slot. The
effect data carries a **score-multiplier** node type whose authored values
come in tiers — ×2, ×3, ×5 — so touching a gem multiplies the trick score
banked at that moment. Their glitter is an ordinary timer-driven sparkle
emitter from the shared sprite bank, drawn additive like all sprite effects
(`180-particles-data.md`, `400-rendering.md`). [measured] [[390-gems]]()

The complete LTG **GemIndex object layer** is **Showoff-only**: live retail
verification finds it present in Showoff and absent in both Race and Freeride,
together with the Showoff rails. Despite the list's name, it contains both the
79 multiplier pickups and all 78 solid `Gem_RailSupport_1000` placements on
GARI. `HideShowOff` contains none of those 157 instances, so this is an
engine-side mode object-set rule rather than a level-authored hide edge.
[measured] [observed] [[390-gem-mode-presence]]()

Applying the multiplier is independently **showoff-only**. The handler opens
by testing the game-mode global against the same two values that select `ShowoffMode` and load
`.sop` rather than `.aip` (`250-paths-aip-sop.md`), and returns without
scoring anything outside them — the same gate main types 6, 15 and 16 carry
(`150-logic.md`). A gem touched in Race or Freeride multiplies nothing.
[measured] [[390-gem-mode-gate]]()

Collection feedback includes a **per-tier pickup chime** — one sound per
multiplier tier — played by **game code**, not by an effect-graph sound node,
and gated to the local human player. The ×2 / ×3 / ×5 tiers select slots
**116 / 117 / 118** of the global **MAIN** sound bank (a trio of
identical-length variants that exist only in that bank). [measured]
[[390-gem-chime]]()

The chime is **outside** the handler's mode gate: the mode test guards only the scoring
call, and the local-human test that selects and plays the chime sits after the
paths rejoin. This describes a direct/manual invocation in a non-Showoff mode;
normal Race/Freeride course setup has no gem object to touch. A chime therefore
still does not, by itself, prove that a multiplier landed.
[measured] [[390-gem-mode-gate]]()

A gem floats by playing its own model animation on a free-running loop (the
`AnimObject` node of `120-objects.md`) from the moment the level loads. The
same collision hit that applies the multiplier and the chime also fires a
**dead-node kill (`230-level-ssf.md`, type 0 sub 5, mode 2)** at the gem's
slot: it tears down that looping animation and installs a one-shot tombstone
node in its place. **The tombstone is the despawn.** Every placed instance
carries a live status word seeded from its authored flags plus two engine
bits — "cell active" and "drawn by the static path" — and the tombstone clears
the static-draw bit, the player-collision bit and the player-bounce bit while
marking the instance as owned by a node that neither draws nor updates. The
renderer's placed-object pass submits an instance only when both its authored
visible bit and the static-draw bit are set, and the collision broadphase
skips any instance whose player-collision bit is clear before the effect-slot
dispatch can run. A collected gem is therefore neither drawn nor touchable
for the rest of the run: it cannot re-score, and no respawn of any kind
exists. The authored visible flag itself is never rewritten at runtime —
"hidden" in this engine means "no static draw and no owning node". The same
primitive is what every scripted hide in the shipped levels uses (the mode
presence functions, the start-gate hide, the start-area disappear volumes,
the breakable-sign chains), and it is what makes the visible boost pads
one-shot pickups too (`360-speed-and-boost.md`). A race restart re-applies
the recorded tombstones from the restart snapshot. [measured]
[[390-gem-despawn]]()

> [[390-gems]]() doc:../research/extracted-data.md "Boost and scoring
> effects" — effect main type 14 = score multiplier, values 2.0/3.0/5.0;
> gems are mode-2 movability-0 instances (db:collision); sparkle = type-2
> sub-0 timer emitters at effect indices 9/11/13 (two emitters, `U0`=150
> sparks; map:"Timer particle emitter field block (`Type2Sub0`,
> fireworks/sparkles)"), additive (db:powder-spray blend enum 5 is the
> sprite-path default; db:particle-bank).

> [[390-gem-mode-presence]]() observed live in retail: the same course shows
> rails, `Gem_TrickMultiplier_*` pickups and their `Gem_RailSupport_1000`
> models in Showoff, and omits all three sets in Race and Freeride. GARI census:
> all 157 state-2 instances (79 pickups + 78 supports) are written to LTG
> `GemIndex`; zero are targets in `HideShowOff` or `HideRace`, locating this
> rule outside the authored SSF function edges.

> [[390-gem-mode-gate]]() `GemMultiplier_ApplyAndChime` 0x0011e668: reads
> `GameModeGlobal` 0x0032f08c and branches to the multiplier call
> (`TrickScore_ApplyGemMultiplier` 0x00155ce8) only on 3 or 5, `bnel` past it
> otherwise @0x0011e694; both paths converge at 0x0011e6c0–0x0011e6c8 on the
> `boarder+0x41c == 1` test that reaches the chime player. Same two compares
> against the same global open 0x0011e610 (main 6), 0x0011e960 (main 15) and
> 0x0011e8a8 (main 16). Mode→`ShowoffMode` mapping from dispatcher 0x00112550
> (`250-paths-aip-sop.md`).

> [[390-gem-chime]]() map:"Gem-pickup chime (MainType 14 → code-driven
> group-0 one-shot)" — dispatcher main type 14 (`0x0013c3cc`) →
> apply-multiplier (`0x0011e668`, gated `boarder+0x41c==1`) → slot select+play
> (`0x0021a268`): id 116, +1 at mult ≥ 3.0, +2 at ≥ 5.0; a direct group-0
> one-shot that bypasses the prop-collision event-id resolver. Slots
> 116/117/118 exist only in `zbxsfx` (MAIN / group 0), three ~93,900-byte
> (≈2.1 s) variants.

> [[390-gem-despawn]]() GARI `SSFLogic.json`: each gem's `PersistantEffectSlot`
> (8/10/12) installs a bare `type0Sub256` `AnimObject` (`U0`=1 wrap, no play
> window) — the free-running spin; its `CollisionEffectSlot` (9/11/13) fires
> `[MainType14 score][MainType2 ×2 sparkle burst][MainType0 Sub5 DeadNode
> mode=2]` in one header. Mode-2 handler `0x0013ad44` destroys the `entity+0xe4`
> node (AnimObject teardown `0x0019970c` restores `live = template | 2`) then
> jumps to the shared tombstone ctor `0x0013af40` (a2=0), which masks the
> instance's runtime status word `entity+0xe8` `&0xffffff0f`, `&0xfffffffd`,
> `|0x0004` (`0x0013af70–0x0013af9c`) — clearing static-draw 0x02,
> PlayerCollision 0x20, live-body 0x40, PlayerBounce 0x80 — and installs a
> 44-byte node whose vtable `0x0036c4a8` overrides only slots 0/1 of the base
> `0x0036c588` (no draw, no update). Consumers: the placed-object submit walk
> `WorldCells_SubmitStaticInstances` `0x00200888` (`lw 0xe8; andi 3; bne 3 →
> skip` at `0x002009f0–0x002009f8`, reached from the world render pass
> `0x00265518+0x204`), and the broadphase gates in `WorldIntersect_QueryNearest`
> `0x0025bb74` and `QuerySphereSetNearest` `0x0025c0f8` (`andi 0x20; beq →
> next`), upstream of `CollisionEffectNode_GetOrCreate`. All 16 camera-submit
> sites (`field-refs 0x2a8 --op lh`) draw their own instance; none walks by
> flag. Word layout: `entity+0xe8 = props[+8]` copied at
> `CourseResolve_BindInstanceProperties` `0x0025fac8` (`0x0025fb88/0x0025fb9c`),
> on disc `{u16 0, u16 BitFlags}`; live init `0x0025f8f0–0x0025f96c` sets
> `live16 = template16 = authored | 0x0102`; every node-end path restores
> `live = (live & 0x0100) | template | 0x0002`. Data: GARI slots 0–3 →
> headers 1/3/5/7 `[T17|T18][T2×9][DeadNode 2]` on `Mdl_SpeedBoost_Gold_*` /
> `Mdl_TrickBoost_RedGreen_*`; `HideShowOff/HideRace/HideStartGate` mode-2
> hops GARI 98/5/3, ELYSIUM 208/122/3, ALASKA 235/9/2, SNOW 10/15/4, MERQUER
> 0/12/2, MESA 0/6/3; ALOHA `EffectHeaders[24]` (`Mdl_Trigger_topDissapear_1000`)
> = 118 mode-2 hops on plain static props; race-restart restore `0x00190c78`
> (state-stream reader `0x00193198`) re-tombstones a stored instance-index list
> through `0x0013af40`. map:"Instance runtime status word (`entity+0xe8`)".
> Generic `CollisionEffectSlot` dispatch is live-node-gated, not
> frame-count-gated (`150-logic.md` `[[150-dispatch-runtime]]`;
> doc:../research/prop-collision-semantics.md "Collision-effect re-fire rule").

## Event triggers (fireworks)

Course set-pieces fire from **invisible trigger volumes**: a pass-through
instance whose collision chain plays particle emitters positioned on *other*
instances (the launchers) and a sound node per launcher
(`150-logic.md` walks a worked example). The sound node resolves as a raw,
no-fallback course-bank slot (`420-audio-runtime.md`, `190-audio-data.md`);
shipped levels do contain authored-silent firework events that exercise the
no-fallback rule. The launcher sprites are the shared particle bank's
additive set (`180-particles-data.md`); fireworks bursts render additive
(`400-rendering.md`). [[390-fireworks]]()

> [[390-fireworks]]() map:"SSF effect-graph sound (firework
> `SoundPlay`)" — sound-play handler hardcodes the course-bank group and
> passes the slot raw; verified empty-slot silence (Mesa bomb events,
> slot 83 absent from its bank); GARI firework report = slot 82;
> db:particle-bank.

## Teleport instances

A collision chain can **warp the rider to a named instance** instead of
running a break or pickup response: the node carries the target instance's
index, and on trigger the rider lands **3 m from that instance rather than on
it**, facing a heading taken from the target's own orientation, and arrives
**stopped** — the placement zeroes their velocity. The 3 m displacement is a
spread rather than a clearance: which of five directions is used is chosen by
the arriving rider's own **slot index** — the rider's position in the race
manager's list, assigned once when the riders are created — so a field of
riders warping to one destination lands fanned out instead of stacked. In
the exit instance's own frame (its local +Y is "forward") the offsets are
(−1, 0), (−1, +1), (0, +1), (+1, +1) and (+1, 0) for slots 0–4, each scaled by
3 m without normalising, so the diagonal slots land about 4.2 m out; a sixth
rider lands on the origin. Every arrival faces the exit's forward axis
projected into the horizontal plane, is set down on the snow by a short
vertical probe already in normal riding, and has the chase camera re-snapped.
The node's payload carries only the destination instance; nothing in it
selects the offset. This is an authored-once feature, not course furniture every level
uses: of the levels examined, only one mountain pairs a teleport-entrance
instance with a teleport-exit instance, cued by a one-shot sound on entry.
It works from an AUTHORED level, which is not a given for an opcode retail
uses once — an authored node naming an appended instance warped the rider
132.9 m to it. [measured] [[390-teleport]]()

> [[390-teleport]]() map:"MainType 24 (teleport to a named instance) and
> MainType 25 (toggle a spline as a rail candidate)" — dispatcher main type
> 24 (`EffectOpcode24_TeleportToInstance` `0x0013c504`) resolves the
> payload's instance index through the same resolver `MainType 7` uses — the
> same four instruction encodings in both handlers, `Pbd_GetInstance`
> `0x00254f58`, whose only null return is a signed `index >= NumInstances`
> against the PBD header at `+0x0C`. `Boarder_WarpNearInstance` `0x0011a0a0`
> then reads only bytes `0x00..0x3F` of the instance record (its 4×4 world
> matrix), rotates a unit direction through it, scales by a literal `300.0f`,
> and adds the matrix translation; the heading is `atan2` over the target's
> local +Y axis in world. The direction is a 5-way switch on `boarder+0x460`,
> the **rider slot index** — the same field `LapBoostNode_Update` `0x00140c6c`
> uses as an array subscript — so this is an anti-stacking fan, not an
> authored quadrant; a slot ≥ 5 falls through with a zero offset and lands on
> the origin. `+0x460` is written once, by `Boarder_SetRiderRow` `0x00116a68`
> (`sw a1,0x460(a0)`, a1 = the loop index over the rider table, callers
> `0x00110d64`/`0x00110e48`/`0x00111668`; `GetRider` `0x00181560` is the
> inverse map). Switch `0x0011a0dc..0x0011a170` writes (x,y) = 0:(−1,0)
> 1:(−1,1) 2:(0,1) 3:(1,1) 4:(1,0), ≥ 5 → `0x0011a184` with the zeroed vector;
> VU0 transform by the instance matrix (w = 0, rotation only)
> `0x0011a184..0x0011a1a8`, ×300.0 (`0x43960000` at `0x0011a1ac`), plus the
> translation `0x0011a1ec..0x0011a1f8`; heading = atan2 of the transformed
> local (0,1,0) `0x0011a1fc..0x0011a2dc`; `0x0011caf0(boarder, pos, vel = 0,
> a3 = 0, f12 = heading, f13 = 0)` at `0x0011a304` → probe ±200 units then
> motion 2 / control 3 (Cruise); camera resnap `0x00177dc8` via `boarder+0x38`
> at `0x0011a328`. The function has **no early return**: every path reaches
> `Boarder_InitPlacementAndContact` `0x0011caf0`, whose entry block stores the
> destination to `boarder+0x140` and a zero vector to `+0x150` before any
> branch. The boarder it acts on is `thread+0xE8` and is NOT null-checked,
> unlike main types 10/11 — so a teleport reached from a thread with no owning
> rider writes to low memory. Authored once in the extracted corpus: MERQUER's
> `Mdl_TeleportStart_0` collision fires `[MainType 8 SoundPlay 122][MainType 24
> → Mdl_TeleportExit_0]`, whose target is an ordinary prop with
> `EffectSlotIndex: -1`; GARI, MESA, ELYSIUM, and SNOW author zero. Confirmed
> on hardware from an authored level, three passes of three: 132.9 m in one
> sample, arriving 3.00 m from the destination with speed 23.9 m/s → 0
> (`tools/autotest` cell `teleport-warp`, runs 20260807-165202 / -165433 /
> -165613).

## Trick scoring

Each rider owns a **trick-score state**. A trick banks a
value each scoring tick built from three parts, accumulated into the run total: a
**style/rotation** term, a flat **grab-hold** bonus, and a flat **big-air**
bonus. The style term is the only one the gem multiplier scales. [[390-trick-score]]()

| Component | Value |
|---|---|
| style → points | `round10( style × gemMult × 0.67869 × 10000 + 5 )`; style accrues +0.25 per 360° spin (one bare 360 ≈ 1700 pts) |
| grab-hold tier | tier 2 = 4000, 3 = 8000, 4 = 12000, ≥5 = 16000 (flat) |
| big-air bonus | airtime ≥ 4 s → `(airtime − 3) × 1000` (flat) |
| score-multiplier gems | ×2, ×3, ×5 — `max`, never stack; consumed by the next banked trick |

A clean landing banks the combo; a bail/crash forces the multiplier back to ×1
and **loses** the uncommitted trick. The run total persists across the run; the
combo reset only wipes the in-progress fields. **Rails score continuously while
ridden** — the grind is itself a held trick: the hold counter and style accrue
every frame (no input needed), routed into the same trick-score state, with
spins/grabs on top. [[390-trick-bank]]()

## Race scoring

Trick points still accrue during a race (the scored race modes are 3 and 5), but
the **race result is finishing order and time**, not the trick total. Standings
ride a per-rider progress counter bumped at each checkpoint/finish
crossing; the leader is the strictly-highest counter. The race clock is stored in
centiseconds. A checkpoint crossing presents the on-screen **CHECKPOINT**
acknowledgement [observed] and advances progress only — it does not add time or
points. That HUD acknowledgement is a reaction to event 12, not evidence that the
visible checkpoint sign is the trigger. Showoff/trick mode instead surfaces a points result (the
point-distribution / hi-score overlays), with per-course score targets authored
as descending gold/silver/bronze triples (e.g. 55000 / 40000 / 25000).
[[390-race-score]]()

**Crossings are edge-triggered boarder game events**, not geometry tests. The
boarder holds a per-frame event bitmask pair (previous/current) dispatched on
the rising edge. **Event 12 = a checkpoint**: the checkpoint handler bumps
the rider's progress counter and re-derives the leader as the strict maximum
across all riders; a checkpoint arriving while already finished logs a
defensive warning. **Event 18 = the finish**: its own dedicated event (not a
count-reached or DTF-zero test) — it fires the finish announcer and an
interactive-music song event. The cross-the-line celebration animation and
the HUD popup are the finish *reaction*, not its location. [[390-finish-events]]()

### The showoff clock

A showoff run is a **countdown**, and how long it runs is a property of the
**course slot**. One field on the race manager is the clock for every mode, and
the mode decides what it means: showoff seeds it from a per-course record in the
boot executable — an integer in **hundredths of a second**, divided by 100 — while
every other mode stores **zero** there and counts it **up**, which is the race
clock this chapter reports in centiseconds above. Showoff subtracts one tick's
worth per update and, at zero or below, clamps the field and ends the run for
every rider on the mountain. [[390-showoff-clock]]()

| course | s | | course | s | | course | s |
|---|---:|---|---|---:|---|---|---:|
| GARI | 120 | | ALOHA | 90 | | BIGAIR | 90 |
| SNOW | 90 | | PIPE | 90 | | TRICK | 0 |
| ELYSIUM | 90 | | UNTRACK | 0 | | ALASKA | 135 |
| MESA | 90 | | MEGAPLE | 90 | | *(front end)* | 0 |
| MERQUER | 90 | | | | | | |

The two zeroes are the slots that host no showoff event — the free-ride mountain
and the tutorial — so the number is never seeded there rather than expiring
instantly.

Two things add to the same field, both gated to the showoff modes: the SSF **time
bonus** (`150-logic.md` main type 16, authored nowhere in the extracted levels)
and a **checkpoint crossing**, whose handler adds the crossing event's own payload
in seconds. The race branch of that handler writes no time at all: the payload
extends a showoff run, while a race crossing performs the progress/standing update
above and presents **CHECKPOINT** without changing elapsed race time or trick score.
A showoff run's real budget is therefore the seeded number plus whatever its checkpoints award. The payload
is authored directly on the active `.sop` race line: raw path event type **11**,
`EventValue = bonus seconds`, at horizontal arc station `EventStart`. The parser
turns raw 11 into internal event 12. [[390-showoff-extend]]()

The checkpoint's visible sign is not its trigger. Alaska's
`Mdl_CheckPoint_Top_2000` is the flashing upper sign next to the course (with
`Bottom_2000` and the `2001` pair completing that visual); it carries an animated
texture/effect because it is scenery. The rider need not collide with or pass
through it. The active race-line event fires when forward course progress crosses
its station. This separation is load-bearing for authoring: checkpoint data
belongs to a race-line station, while a sign is an optional independently placed
and animated prop. [[390-alaska-checkpoints]]()

Alaska starts at **135 s** and its main route has three logical awards:

| logical checkpoint | SOP bonus | approximate run progress | event position (editor m) |
|---|---:|---:|---|
| 1 | +150 s | 1.741 km / 28.4% | `[367.589, -655.139, -1135.311]` |
| 2 | +110 s | 3.638 km / 59.3% | `[-903.040, -1539.094, -1579.074]` |
| 3 | +30 s | 5.513 km / 89.9% | `[-2201.507, -2326.108, -1290.599]` |

Thus a run crossing all three has 425 seconds available before time spent
(135 + 150 + 110 + 30), not merely the initial 2:15. A fourth raw event, +150
on alternate race-line row 11 at `[395.145, -628.513, -1151.320]`, has the same
remaining DTF as checkpoint 1 to within 0.09 m. It is the alternate-route copy
of the first logical checkpoint, not a stackable fourth award. [[390-alaska-checkpoints]]()

> [[390-showoff-clock]]() the clock is `GlobalGameStatePtr` (0x00338e58) → +0x730
> courseRuntime → +0x1C race manager → **+0x14** (f32), beside the frame counter
> at +0x18 and the rider count/array at +0x88/+0xC4. Seed: the manager's vtable
> entry at 0x00365a0c → 0x00113740, which tests the mode global (0x0032F08C) for
> {3,5} and otherwise takes `sw zero, 20(s2)` at 0x001137a4; the showoff path
> 0x001137a8–0x001137d4 reads the **course index at 0x0032F088**, multiplies by
> the record stride **28** (R5900 3-operand `mult`), indexes the table at
> **0x00334128**, loads the integer at **+0x0C** and divides by 100.0. That table
> is the course catalogue — each record is `{index, "Garibaldi", "GARIBALDI",
> seconds×100, "gari", "gari", 5}` — and the front end reads the same records
> (0x00285908). Tick: vtable 0x00365a1c → 0x00113820, mode test at 0x001138b8,
> showoff `sub.s` of 1/60 (0x3C888889) at 0x001138cc–0x001138f4 with `c.ole.s`
> against 0.0; expiry at 0x00113904 clamps the field to 0.0 and walks the rider
> array calling 0x0011da48; the non-showoff branch at 0x0011396c **adds** the same
> 1/60. Before a run the clock is parked **negative**: the `StartCountdown` named
> function's caller (0x00113520) stores −300.0 at 0x00113594, and `EndCountdown`'s
> (0x00113600) adds 2.0 and fires once the sum is ≥ 0. Measured live on the PAL
> disc (SLES-50545) over three boots: Garibaldi in showoff reads 118.017 /
> 118.050 / 118.034 s about two seconds after the gate release — 120.0 seeded —
> and falls at 1.00 s/s.

> [[390-showoff-extend]]() `RaceCheckpoint_Handler` 0x0011e700 opens on the mode
> global for {3,5} (0x0011e714–0x0011e73c); the showoff path converts its second
> argument with `cvt.s.w` and adds it to the clock at 0x0011e808–0x0011e820, while
> modes 2/4 fall to 0x0011e824, which calls the score module and writes no clock.
> The argument is the game event's own payload word: the dispatcher
> `BoarderState_GameEventToAudio` 0x0011a350 passes `record+4` at 0x0011a468 for
> event 12. `PathEvent_Parse` `0x00197668` fills it from the raw type-11
> `EventValue`; the active EventPath query `0x00196ea8` → `0x00197e08` returns
> records crossed between previous and current forward arc, and
> `Boarder_UpdateRaceLineProgress` consumes them at `0x00118534..0x00118578`.
> Main type 16 is the same add through
> `SsfTimeBonus_ShowoffGate` 0x0011e8a8 (`150-logic.md` `[[150-types-open]]`).
> Observed live on retail Garibaldi: three separate additions inside one 300 s
> window, roughly +75, +75 and +45 s, with the frame counter continuous across
> each — so they are in-run awards, not the level restarting.

> [[390-alaska-checkpoints]]() `Maps/ALASKA/SOP.json`: positive type-11 events
> are +150 at raw station 85531.8 (race-line row 1), +110 at 10085.382 (row 4),
> +30 at 22227.54 (row 6), plus the route-equivalent +150 at 30248.367 (row 11).
> Positions are `PathPos` plus incremental `PathPoints`, interpolated at
> `EventStart` in the horizontal metric and converted raw→editor. The three
> nearest sign pairs are `Mdl_CheckPoint_{Bottom,Top}_2000/2001`, `4000/4001`
> and `5000/5001`; event-to-sign offsets are about 2.0, 2.6 and 9.3 m. The last
> still lies across the roughly 54 m-wide sign span. Route-equivalence uses
> `DistanceToFinish - EventStart`: the two +150 copies differ by only 8.6 cm.

### Laps

Only **one course laps**, and the engine says so with a single hardcoded test
rather than a table. The shared motion reset compares the loaded course index
against one constant and seeds the rider's **laps-remaining** counter to **four**
on a match; every other course is seeded **zero**. That match is the Megaplex
slot, so there is no per-course lap count to author or extract — one course laps
and the other twelve do not. The seed is the pass count: see the rate below.
The same branch is the only
other place the course is special-cased, scanning the instance list for a
particular object kind and caching a distance on the rider.
[[390-lap-counter]]()

The counter is **passes still to run, counting the one under way** — laps
remaining, not laps completed. It descends one per crossing and reaches zero at
the final crossing, where the finish reads it ([[390-lap-field]]()). It is
written in exactly three places: the seed above, a clear when a rider is placed,
and a single decrement. It is read by the finish gates below and by the
finish-tube lift (`360-speed-and-boost.md`), and by nothing else — no HUD or
scoreboard displays it, though the lap announcement heard at each crossing
speaks the same number (below). It exists to decide when the race may end and
whether the tube throws you back up the mountain.
[[390-lap-counter]]()

**Three crossing events share the counter**, and they divide the work cleanly:

- **Event 12** bumps the standings progress counter (above). It does not touch laps.
- **Event 13** *is* the lap: while the counter is above zero it plays a lap sound
  and decrements. On the final lap it does nothing.
- **Events 10 and 18** are the finish, and both are gated on the counter being
  **zero**. Event 18 is the announcer and music side already described; event 10
  is the one that ends the run.

[[390-lap-events]]()

**Dispatch order** is lowest code upward, so on a crossing that raises both the
finish and the lap bit the finish is offered the counter *before* the decrement
runs, and the crossing that takes the counter to zero does not itself end the
race. [[390-lap-order]]()

**Megaplex is raced over four passes**, and event 13 fires **once per
crossing**. [measured] The seed of 4 is the pass count, nothing subtler: the
counter descends 3 · 2 · 1 across the first three crossings — each of which the
tube reads as nonzero and lifts — and hits zero at the fourth, which the tube
lets ride through to the finish below. The lap announcement at each crossing
speaks the post-decrement value: **"3 laps to go" on the first crossing**, then
2, then 1, which is also why the race reads as "three laps" at the rail — three
is the count of announced laps and of tube lifts, one short of the passes
ridden. How the announcement's voice line is selected is not traced [open];
event 13's handler plays a sound and decrements, and the number heard tracks
the counter. [[390-lap-rate]]()

An engine reproducing this holds passes-remaining seeded to the pass count and
decrements once per crossing — retail's own arithmetic. Everything outside the
counter depends only on whether it is zero: the finish may end the run, and the
tube lift fires while it is nonzero, three lifts and a ride-through on a seed of
four. [[390-lap-rate]]()

> [[390-lap-counter]]() db:race @0x00116fb4 @0x00117010 @0x0011cc90 — seed site in
> `BoarderMotion_ResetSharedState`; the course index is the same word
> `442-sky-color.md` reads, and the constant it is compared against is the
> Megaplex slot in that chapter's course table. Branch-likely: the delay-slot
> store of zero is annulled on a match, falling through to the store of 4. The
> co-located instance scan walks the list at 0x003391B8 (count +8, pointer +12,
> stride 60) filtered through 0x00197ce8 with kind 13, writing boarder+0x37c.

> [[390-lap-field]]() db:race db:boost @0x00140a1c @0x00140c88 — the counter is
> boarder+0x114, named `laps_remaining` in the db field table. Three PINE captures
> of one PAL session, each 4 minus the crossings counted: 3 past the first
> crossing, 0 for riders traversing the tube volume with no lift at the final
> crossing, 1 for a rider one crossing (a lap) behind them, still lifted.
> Sized u16 by the `lhu` in the lap-boost constructor; the seed and decrement use
> `sw`/`lw` on the same word.

> [[390-lap-events]]() db:race @0x0011a3ec @0x0011a3f0 @0x0011a414 @0x0011a43c —
> in `BoarderState_GameEventToAudio`: compare against 10 then 13 then 12, each
> constant set in the preceding delay slot. Event 13's body is `lw` boarder+0x114,
> `blez` skip, call 0x00155cb8(boarder+22560), `addiu -1`, `sw`. Event 10 calls
> 0x0011da48(boarder) only when the counter is zero; event 18 at +0x1d8 is gated
> identically and was already recorded.

> [[390-lap-order]]() db:race @0x001185a0 @0x001185d8 @0x001185e0 — the scan loop
> in the tail of `Boarder_UpdateRaceLineProgress` starts its code counter at zero
> and runs `addiu +1` / `slti 32` / `bnel`, i.e. ascending. Each set rising-edge
> bit writes {code, 0} to the stack and calls the boarder vtable method at +0x5c
> with a pointer to it — the word the handler reads.

> [[390-lap-rate]]() db:race @0x00117010 @0x0011a43c — seed 4 at the store
> above; the rate is once per crossing, fixed by play and consistent with every
> capture. Observed in play (PAL, 2026-08-06): the announcement at the first
> tube arrival is **"3 laps to go"**, and the race is three lifts then a
> ride-through — four passes over the line — which community walkthroughs of the
> course also describe ("down and back up three times before passing through").
> A counter seeded 4 and decremented once per crossing announces 3 · 2 · 1 and
> reads 0 at the fourth, matching all of that plus the PINE captures in
> `[[390-lap-field]]()`: the lap-down rider's 1 is a whole-crossing offset from
> the leaders' 0. Read those same captures as "raced over three laps, zero all
> through the final lap" and they force an invented two-decrements-per-lap rate,
> plus an unlocatable second poster of event 13, to reconcile: the "three laps"
> is the announced count rather than the passes ridden, and the 0 is captured at
> the final crossing rather than mid-lap. The poster
> of event 13 is still not located [open], but its station is boxed in: the
> DTF-zero finish plane sits ~25 m DOWN-course of the lap-boost shaft (measured
> off the shipped race lines against the volume placements), so a mid-race pass
> ends at the tube without ever reaching the plane — and riders inside the shaft
> already read the decremented value ([[390-lap-field]]()). The crossing that
> event 13 counts therefore lies at or just above the tube's mouth, not at the
> finish plane; a full-race telemetry capture of boarder+0x114 (four decrements,
> each at that line) would close the last gap.

The finish **line** is the plane where a rider's continuous DTF reaches **zero**
— i.e. the point at arc-length `DistanceToFinish` along the last race line.
Three independent anchors agree on it: the last race line carries exactly one
`PathEvent` of **type 9** whose `EventStart` is bit-equal to that line's
`DistanceToFinish` (true on all five levels, in both `.aip` and `.sop`, and the
only event in either file with that property); the nearest placed instance is
the finish arch `Mdl_FinnishGate_*` (0.8–5.8 m, every level); and on MERQUER the
level's checkered-flag ground decal — `Mdl_FinishLine_6000`, the sole user of
texture `0180.png`, a 4.43 × 34.02 m quad — has its uphill edge **0.14 m** from
that point, with the type-9 event's arc span (449 u) matching the decal's depth
(443 u). The last race-line vertex is **not** the finish: the line overshoots by
25 m (MESA) to 61 m (MERQUER). [[390-finish-loc]]()

`Mdl_StageArea_Finish_0` (start = `Mdl_StageArea_Start_0`) is **not** the line.
It is the post-race **podium/corral, 20–48 m past** it — co-located with
`Mdl_Finish_Stage_*` / `Mdl_Finsh_Screen_*` / `Mdl_Finish_Coral_*`, and its own
collision is a ~1 × 0.1 × 1 m box. The engine hard-codes both names and resolves
them to read a start/finish **placement anchor** (camera + staging), not a
crossing trigger; they are present once per course with byte-identical model
hashes across every Tricky level (`120-objects.md`). [[390-finish-anchor]]()

At race start the engine transforms a fixed six-rider local formation through
`Mdl_StageArea_Start_0`; the active AIP/SOP start-path origins do not directly position the
riders. [[390-finish-anchor]]()

Crossing the line does **not** tear the level down. The race ends, the results
come up, and the engine then **reseeds the level clock to zero** and returns the
rider to the start gate for another run — the world and boarder pointers stay
valid throughout, so a host watching the pointer chain sees one continuous level
across two runs. The reset clock is the observable boundary between them.
[[390-run-restart]]()

> [[390-run-restart]]() measured on hardware, 2026-08-06, GARI/AUTOTEST1 under
> `tools/autotest`. A 160 s sample window against a ~2 min race read the level
> clock looping back nine times: elapsed ticks collapsed toward zero at each
> restart, the same game timestamps recurred in probe traces (…101.70 s →
> 102.67 s → 103.10 s → 101.72 s → …), and the rider covered 25,004 m of a
> 2,690 m course while the pointer chain never went null. The harness now ends a
> pass on the backwards clock step.

The uber-trick tier events and the "Tricky" boost meter feed the interactive
music and announcer systems (`430-music-and-announcer.md`); meter-full fires the
It's-Tricky song swap, and while the uber tier is high the meter is pinned full
(unlimited boost). [[390-scoring-music]]()

## Scoring sounds

The scoring system's audio feedback routes through one hub
(`BoarderState_GameEventToAudio`) that turns rider game-events into sound. Gem
chimes, boost/trick pads and the held-boost meter are numbered MAIN-bank
one-shots; **landing-well and bailing are per-character voice lines** (impact-
tiered), not numbered SFX, and there is no discrete "perfect landing" slot.
Announcer barks are probability-gated and get more frequent as the run heats up.
[[390-score-sound]]()

| Sound | Slot / form |
|---|---|
| gem pickup ×2 / ×3 / ×5 | MAIN slots 116 / 117 / 118 |
| trick-boost pad / speed pad | MAIN slot 114 / 115 |
| held-boost meter (by level) | MAIN slots 120 / 121 / 122 |
| clean land / bail-crash | per-character voice, impact category 0/1/2 |
| big air / It's-Tricky / finish | announcer + music events |

> [[390-trick-score]]() doc:../research/scoring.md — formula
> `TrickScore_StyleToPoints` 0x00155458, grab-hold table 0x001568c8, big-air
> 0x00156980, state struct `TrickScoreState` at `boarder+0x5820` (db:scoring).

> [[390-trick-bank]]() db:scoring — bank `TrickScore_FinalizeTrick`
> 0x00156df8, reset 0x00157020, gem multiplier 0x00155ce8 (max-not-stack); rails
> share the spin scorers 0x00155e18/0x00155e80.

> [[390-race-score]]() db:scoring — `RaceCheckpoint_Handler`
> 0x0011e700 (progress `rider+0x20`, leader = strictly-highest); clock in
> centiseconds; showoff targets at 0x0038f730. doc:../research/scoring.md.

> [[390-finish-events]]() db:race — event bitmask `boarder+0x384`/`+0x388`,
> dispatch `BoarderState_GameEventToAudio` 0x0011a350 (jump table 0x003671f0);
> event 12 → `RaceCheckpoint_Handler` 0x0011e700 (gated `+0x418<0`); event 18 →
> `GameEvent18_Finish_ToMusicVoice` 0x0011a528 (song-event 10 + finish announcer
> 0x0021ea20). "Check Point past finish" warning 0x003673d0. `cFinishLineControlState`
> RTTI 0x00360fb0, `cPopFinishOverlay` 0x00391698. The per-frame poster of bits
> 12/18 (likely `cFinishLineControl` + a race-line advance) is not yet pinned.

> [[390-finish-loc]]() raw-file measurement over GARI/MESA/ELYSIUM/MERQUER/SNOW
> (`AIP.json`+`SOP.json`, `Instances.json`, `Materials.json`, `Models.json`;
> 100 units = 1 m). DTF=0 = the point at arc-length `DistanceToFinish` along the
> minimum-DTF race line, walked in the horizontal (W-metric) arc length. Type-9
> `PathEvent` with `EventStart == DistanceToFinish`: 10/10 level×file, unique.
> DTF=0 → nearest instance `Mdl_FinnishGate_*`: 0.79 / 5.83 / 1.48 / 2.94 /
> 4.47 m. MERQUER decal: material 189 `damwater1` → `0180.png` → model 540
> `Mdl_FinishLine_6000`, one instance, scale (4.4269, 1, 34.0205) on a 100×100
> quad, rotation = +90° about X (flat on the ground); its uphill edge X=123966.2
> vs DTF=0 X=123952.4. Race-line overshoot past DTF=0: 3909 / 2467 / 4205 / 6099
> / 4244 units. Where `.aip` and `.sop` disagree the `.aip` line is the one on
> the arch (GARI: 0.79 m vs 13.99 m). NEGATIVE: path events have no traced
> gameplay dispatch (`research/elf-map.md`), so type 9 is the *authoring* marker
> for the line, not the runtime trigger — the poster of game-event bit 18 is
> still unpinned ([[390-finish-events]]()). spec:250-dtf-zero, spec:250-events.

> [[390-finish-anchor]]() db:finish — `StageArea_GetMarkerTransform` 0x001777e8
> (index 1→`Mdl_StageArea_Start_0` @0x00384278, 2→`Mdl_StageArea_Finish_0`
> @0x00384290) → name hash 0x00241408 → instance-hash resolver 0x002555f8;
> callers 0x0016e918/0x00171628/0x00172118 retain their default vector on a
> lookup miss. Universal: identical model hashes (Start
> 0x91f640, Finish 0xfc656e0) across GARI/MESA/ELYSIUM/ALASKA/PIPE. Measured
> distance from the DTF=0 line to `Mdl_StageArea_Finish_0`: 47.6 / 20.3 / 39.0 /
> 34.3 / 31.4 m on GARI/MESA/ELYSIUM/MERQUER/SNOW (from the arch: 47.7 / 16.0 /
> 38.8 / 31.8 / 31.0 m); on MERQUER `Mdl_Finish_Stage_0`, `Mdl_Finish_Screen_0`
> and `Mdl_Finish_Coral_0` share its exact position. spec:120-stagearea.

> [[390-scoring-music]]() db:music-system — game events 2/4/6 = uber
> tier 1/2/3 enter (song events 1/3/5), 3/5/7 = tier exits with a 1000 ms
> grace; boost-meter-full → the It's-Tricky song swap; uber tier ≥6 pins the
> meter full.

> [[390-score-sound]]() db:scoring-sound — hub
> `BoarderState_GameEventToAudio` 0x0011a350; gem chime 0x0021a268, pads
> 0x00234818/0x002345c8, meter 0x002197a0; landing voice 0x00218248, wipeout
> voice 0x002186e0; announcer gate 0x00236278 (table 0x003a4798).
> doc:../research/scoring.md.
