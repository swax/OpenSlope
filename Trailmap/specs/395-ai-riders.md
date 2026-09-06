# 395 — AI Riders

The computer-controlled racers. An AI rider is **not** a second kind of entity
with its own movement code: it is an ordinary rider (`300-rider-states.md`)
whose control input is synthesized instead of read from a pad. Everything this
chapter describes produces one thing — a control word — and every consequence of
that word (carving, jumping, grinding, boosting, crashing) is the shared rider
model of Part 3. The paths the AI follows are `140-paths.md`; their encoding is
`250-paths-aip-sop.md`. [[395-overview]]()

> [[395-overview]]() db:ai-rider; @0x001384c0; map:"AI rider (the synthesized
> controller)" — class family `cComputer`/`cPlayer` over `cBoarder` (RTTI
> `9cComputer` @0x0036bc78, `7cPlayer` @0x003704e8, `8cBoarder` @0x00368e50);
> the AI behavior machine is `cAI`/`cAIState`/`cAIStateHandler`/`cAIWorld`/
> `cAIPath` (@0x00365b28 ff.).

## The rider asks for input; the AI answers

Every rider, human or AI, runs the same update. Once per tick it asks its
**input source** to fill a **packed control word**, then hands that word to
whichever control state it is in; the control state is the only thing that
interprets it. A human rider's input source is the pad. An AI rider's input
source is the AI, which fills the same word with the same bit layout. There is
no other channel: an AI rider cannot move itself, cannot steer outside the
physics, and has no separate integrator — it can only press buttons and hold
sticks. [[395-controller]]()

The control word packs the analog axes as **6-bit signed fields** (a full deflection
is ±31, so the recovered axis is a multiple of 1/31) alongside the button bits.
The turn axis is the one the grounded steering model reads (`330-carving.md`).
The AI zeroes the whole word each tick and rebuilds it, so an AI rider holds
nothing between ticks that it does not re-assert. [[395-word]]()

Input synthesis is **per control state**: the AI carries one input builder for
each rider control state (cruise, ollie charge, jump release, airborne, rail,
wipeout, recovery, …), so what "the stick" means is decided by the state the
rider is in — the same dispatch the human's word goes through. In the grounded
cruise state the builder produces the path-following steer below and then defers
to the AI's own behavior state machine, which layers on the tricks, grabs and
boost presses. [[395-per-state]]()

> [[395-controller]]() @0x00117b74 — `BoarderMotion_SharedUpdate` calls a rider
> virtual (vtable slot 10: `(delta, fn)` at vtable+0x50) that fills a control
> word on the caller's stack, then passes that same stack word to the
> control-state update dispatch `0x0011c9a8`. `cComputer`'s override is
> `0x001384c0` (this-adjust −0x8B0: the AI object precedes the `cBoarder`
> subobject in one allocation); `cPlayer`'s reads the pad (`0x001513b0` ff.).

> [[395-word]]() @0x001384c0 — the override memsets the 4-byte word, then each
> per-state builder ORs its fields in. Turn axis = bits 5–10 (builders mask
> `0xFFFFF81F` and shift the quantized value left 5; the human ground control
> `0x00102fc8` recovers it as `((word << 21) >> 26) / 31.0`); two further 6-bit
> axes at bits 11–16 and 17–22; button bits elsewhere in the word.

> [[395-per-state]]() @0x001384c0 — 22-entry jump table at 0x0036BA90 indexed by
> `boarder+0x428 − 1` (the control state). Cruise-family states → `0x001389d0`,
> which calls the steer builder and then an in-object member-function pointer
> (`this+0x8A0`: the `(delta, fn)` PMF pair loaded with `ld` and called with the
> word) — the `cAI`/`cAIState` behavior machine. Other builders: ollie charge
> `0x001387f0`, jump release `0x001389c8`, airborne `0x00138ac8`, rail
> `0x00138d68`, wipeout `0x00138b68`, recovery `0x00139ac0`.

## Following the path: pure pursuit

Each rider tracks one **current AI path**. Every tick it projects its own
position onto that path, keeping the arc-length of the projection, the closest
point itself, and the perpendicular distance to it. The rider's **target** is
then the point on the path a fixed **800 engine units (8 m)** further along than
that projection. The lookahead is constant: it does not scale with speed, and
the target is a point on the path, not the path's tangent. [[395-pursuit]]()

Three properties of that projection carry more weight than anything else in this
chapter, because a reimplementation that misses them produces a field that cannot
get down a mountain.

**The arc itself is horizontal.** "8 m further along" means 8 m *across the
ground*. A path's arc-length ruler is the sum of its steps' **W** fields, and W is
each step's plan-view length (`250-paths-aip-sop.md`) — the climb is not arc. The
tracker's own footing makes this self-proving: it takes the along-segment distance
as a **two-component** dot of (rider − segment start) against the stored direction
and then **clamps that against W**, which is only a coherent operation if the two
are the same unit. Everything measured along a path inherits the metric:
distance-to-finish, the event stations, and this lookahead. Rule it in 3-D instead
and every steep stretch of line quietly collapses the lookahead — on Garibaldi's
big drop, one authored step falls 162 m across 31 m of ground, so 8 m of 3-D arc
buys 1.5 m of ground and the pursuit target lands almost on top of the rider,
where the bearing to it is noise. [[395-planar-arc]]()

**The projection is horizontal.** The closest-point search, the perpendicular
distance and the path heading are all computed in the **ground plane**: the
vertical component is loaded and then never enters the dot product or the
distance. A rider is therefore "on" its path in plan view. This is what lets a
path arc through the air over a jump while the riders below it are still tracking
it normally, and — the same fact from the other side — it is what lets a rider
that *failed* to clear a jump keep riding: it is twenty metres under its own line,
its perpendicular distance is nearly zero, its arc keeps advancing, and the
lookahead keeps pulling it down-course. Measure that perpendicular in three
dimensions instead and the rider concludes it is hopelessly off-line, re-selects
its path every second, and orbits below the jump indefinitely. The **path
chooser** is the one place that measures in full 3-D, which is what stops a rider
*selecting* a line that flies overhead. [[395-planar]]()

**The arc is forward-only.** The search resumes at a cached segment index and
runs forward at most **3000 units (30 m)** of arc, stopping at the first segment
whose perpendicular foot lies inside it. The projection cannot rewind onto an
earlier part of the line, so a rider that doubles back on itself — bounced,
spun, or dropped — cannot re-latch behind its own position and loop. The cache is
invalidated (index −1, full re-scan) in exactly two places, both immediately after
the rider's path pointer changes. [[395-forward-only]]()

The steer is a **proportional controller on the bearing to that target**, and the
bearing is taken **in the rider's own board plane**: the rider's orientation matrix
is built from its quaternion, the board's up axis (row 2) is projected out of the
rider→target vector, and the angle is formed from the two remaining rows.

That projection has a failure mode worth stating plainly, because it is the one
place this controller can be driven into a corner. A target *below* the rider
projects forward and steering is well behaved. A target **above** it does not: the
forward component of the projected vector goes as `f·cos θ − h·sin θ` for a board
tilted θ off horizontal, a target `h` above and `f` ahead — so once `h/f` exceeds
`cot θ` it flips **negative**, and the rider turns to chase a point behind itself.
With the 8 m lookahead that is a target ~38 m up on a 12° slope, ~17 m on a 25°
one. The turn is self-sustaining: circling holds the rider's own projection still,
so the target never advances. **The engine ships no guard against this** — no
vertical term anywhere in the tracker, the perp, or the re-select trigger — and it
does not need one, because a rider only ends up far *under* its own line by missing
a jump its authored marker told it to take. A reimplementation whose riders miss
those jumps for any other reason (wrong arc metric, wrong marker station) will
watch its field do donuts under the flight paths, and the bug will not be in the
steering. [[395-board-plane]]()

Take that signed yaw angle; the stick is it scaled by a fixed
gain, deadbanded, clamped, and re-signed:

```
err   = signed yaw angle (rider forward → target − position)
mag   = |err| · 6.2897 · skill        # skill = 1 for a nominal rider (below)
stick = 0                if mag < 0.2
        sign(err) · min(mag, 0.9705)  otherwise
```

The stick is then quantized to the 6-bit field and handed to the rider like any
other input, so the **lean slew, the speed-ramped yaw and the carve/skid model
of `330-carving.md` are what actually turn the board** — the AI has no privileged
steering. With the nominal gain the deadband is ≈1.8° of bearing error and the
stick is fully deflected by ≈8.8°: on any normal line the controller is
saturated or dead, and the smoothness comes from the rider's own lean slew rather
than from the controller. [[395-steer]]()

Path tracking runs for **every** rider, not only AI ones, and it is **not gated on
being grounded**: the tracker is called unconditionally, and the airborne input
builder feeds the *same* pursuit target into air control. A rider steers toward
its line while it is in the air. [[395-tracking-universal]]()

> [[395-pursuit]]() @0x00118098 — per-frame tracker called from
> `BoarderMotion_SharedUpdate` (@0x00117afc): `cPath_ClosestPointArcLength`
> (0x00197970) → arc `boarder+0x344`, perp `+0x348`, closest point `+0x350`;
> then `cPath_PointAtArcLength` (0x00197ef0) at `arc + 800.0` (`0x44480000`) →
> target `boarder+0x360`; the bearing from closest point to target is also kept
> at `+0x370`. Current path = `boarder+0x57A4` (the race line, a separate track,
> is `+0x57A0`).

> [[395-steer]]() @0x00137300 — builds the rider→target vector from the pose
> matrix (`boarder+0x4AA0`) and position (`+0x140`) with VU0 macro ops, forms the
> signed yaw by an inline atan2 (±π/2 `0xBFC90FDB`, ±π `0x40490FDB`), then:
> gain `6.2897` (`0x40C9453E`), skill divisor `1.0241` (`0x3F8315D8`, applied only
> when the skill scalar ≠ 1.0), deadband `0.2` (`0x3E4CCCCD`), clamp `0.9705`
> (`0x3F787702`). Callers quantize with ×31 (`0x41F80000`). Deadband/saturation
> angles: 0.2/6.2897 = 0.0318 rad; 0.9705/6.2897 = 0.1543 rad.

> [[395-planar-arc]]() @0x00197970 — `cPath_ClosestPointArcLength`: the running arc
> is `f23`, advanced once per segment by `add.s f23, f23, f22` at 0x00197bb0 where
> `f22` = the step's W (`lwc1 f22, 12(v0)`, 0x00197a8c) — so the ruler is the sum of
> the Ws, and W is the plan-view step length (spec:250-accumulation). The reported
> arc is `f23 + s` (0x00197b6c) with `s = clamp(dot2(query − P, direction), 0, W)`
> — the clamp against W (0x00197ae0..0x00197af0) is what pins `s` to the same unit,
> and the dot is two-component (0x00197ab8..0x00197ac0). `cPath_PointAtParam`
> 0x00197ef0 walks the same Ws (0x00197c30..), so the 800.0 lookahead is 8 m of
> ground. GARI AI path 0 step 15: 162.2 m of fall across 31.4 m of ground (165.2 m
> in 3-D) — the ratio that makes the difference visible. Independently confirmed
> against the data: where a level's race lines genuinely chain, `DistanceToFinish`
> drops by exactly the plan-view length of the line left behind (MERQUER line 0:
> 873.7 m of DTF vs 873.7 m plan / 1009.4 m 3-D; ELYSIUM line 0: 805.2 vs 805.2 /
> 1008.2) — and by the 3-D length in no case.
>
> [[395-board-plane]]() @0x00137300 — `AiRider_Steer(computer, target)`: loads the
> rider's orientation matrix from `boarder+0x4AA0` (three quads, rows 0/1/2), takes
> `d = target − boarder+0x140`, normalizes, projects out row 2
> (0x001373b8..0x00137410: `d −= row2 · (d·row2)`, renormalize), and forms the
> angle from `atan2(d·row1, d·row0)` (0x00137414..0x00137458 + the hand-rolled
> atan2 at 0x00137460..). `boarder+0x4AA0` has exactly one writer,
> `BoarderPose_BuildRenderTransform` 0x001296d8, and it is a quaternion→matrix
> expansion (`boarder+0x170` = w; the 1−2(y²+z²) / 2(xy±wz) pattern is at
> 0x0012967c..0x001296dc) — so row 2 is the **board's** up, the real tilted one,
> not world up. Hence the flip: no vertical guard exists anywhere on the path
> (the re-select trigger at 0x00118104 tests the *planar* perp `boarder+0x348`
> against 500.0, once every 60 frames). Measured on the shipped data: 51 of
> Garibaldi's 90 AI paths fly >15 m over ground a rider can stand on, one by
> 100.9 m — so the state is reachable, it is simply not one a rider that took its
> jumps can be in.
>
> [[395-planar]]() @0x00197970 — `cPath_ClosestPointArcLength`: the along-segment
> parameter is a **2-component** dot (`0x00197ab0`–`0x00197ac0`, delta.x·dir.x +
> delta.y·dir.y) and the distance is `dx² + dy²` (`0x00197b38`–`0x00197b48`); the
> third component is loaded into the scratch vector at 0x00197a80 and never used.
> Path heading `+0x370` is `atan2(Δy, Δx)` (0x001181c4–0x0011827c), likewise. The
> engine's up axis is the **third** component (`002-conventions.md`), confirmed
> independently by the out-of-play height test reading `pos+0x08` (0x00117c60).
> By contrast the path **chooser** scores with the full 4-component dot chain
> (0x00118ac0–0x00118b0c), so height does count when *selecting* a line.

> [[395-forward-only]]() @0x00197970 — tracker cache `boarder+0x390` =
> {point[16], arc @+0x10, segIndex @+0x14}. With a valid cached index the scan
> starts there (0x001979f4), the running best is re-initialised each call, the
> limit is `cachedArc + 3000.0` (`0x453B8000`, 0x001979fc/0x00197a10, tested at
> 0x00197b90) and it breaks at the first interior foot (0x00197b80). Invalidated
> to −1 only where the path pointer `+0x57A4` changes: 0x00118b84 (selector) and
> 0x00118e90 (course reset).

> [[395-tracking-universal]]() @0x00118098 — no rider-type gate and no
> ground/air gate on the tracker: it is called unconditionally from
> `BoarderMotion_SharedUpdate` (0x00117afc) behind a game-phase compare only. The
> airborne builder (control state 13, @0x00138ac8) calls the same steer
> (0x00138b0c) on the same target `boarder+0x360`, sign-flipped for the air yaw
> convention. The `boarder+0x418` tests on the re-select branches are
> **not** a grounded gate — `+0x418` is the rider's **finish
> time in centiseconds**, −1 while still racing (accessor 0x00122ea0 returns
> `+0x418 ≥ 0`; stamped at 0x0011da48 as `raceTime · 100`; `Race_StandingsPass`
> sorts on `0x7FFFFFFF − t`). The gates mean "still racing".

## Choosing a path

An AI rider does not follow one path down the mountain: it follows a **chain of
short paths**, re-choosing as it goes. A new choice is made when any of three
things happens: the rider is more than **500 units (5 m)** off its current path
(measured as the perpendicular distance above, tested only while grounded, and
rate-limited to at most one re-choice per second); the rider's projection comes
within **200 units (2 m)** of the end of the current path (an *advance*, which
excludes the current path from the candidates); or the path itself reports that
the rider has left it. [[395-reselect]]()

The candidates are the **six nearest** AI paths to the rider. A candidate is
rejected outright if the rider would already be within 200 units of *its* end.
The rest are scored, lowest wins:

```
score = |position − closestPointOnCandidate|²
      + |lookaheadTargetOnCandidate − position|²
      − (100 − |candidate.rating − mood|) · 23189.36      # AI riders only
```

The first two terms are a plain geometric cost in squared engine units — stay
near the path you are on, and prefer the path whose lookahead point is closest
to you. The third term is the interesting one. [[395-score]]()

## Line rating and mood: what the AI paths' rating field is for

Every AI path carries an authored **rating** in 0…100 (`250-paths-aip-sop.md`
records it as the one varying scalar in the path header; most paths are 50, with
0/20/25/80/100 outliers). Each AI rider computes a **mood** in the same 0…100
scale, and the score above rewards a candidate for how closely its rating matches
that mood — strongly enough (the weight is equivalent to ~15 m of geometric
error at a perfect match) to pull a rider onto a line it is not currently nearest
to. The rating is therefore not tuning data for a path: it is **the path's
identity within the network** — a menu of lines a rider chooses between by
temperament. This is why a course authors many short, overlapping AI paths rather
than one line per start gate. [[395-rating]]()

Mood is recomputed at each choice from the rider's situation, and lands on one of
three values — 0, 50 (the default) or 100:

| Situation | Mood |
|---|---|
| Boost meter below a per-mode floor (≈0.10 in one mode, ≈0.31 in the others) | 100 |
| Leading, or holding a mid-pack placement (the exact placements vary by mode) | 0 |
| Anything else | 50 |

The result is then **gambled against the rider's skill**: with probability equal
to the rider's skill scalar (normalized so a fully-skilled rider always keeps its
mood) the computed mood stands; otherwise it collapses back to 50. A low-skill
rider therefore spends most of its time on the default-rated lines, while a
high-skill rider commits to the extremes. A global switch can force the skill
term to zero, pinning every rider to mood 50. [[395-mood]]()

The mapping from rating to line character is not recorded in the data; the
behavior implies it. A rider that is **short of boost** seeks rating **100**, and
a rider that is **winning** seeks rating **0** — consistent with 100 marking the
trick-rich line (jumps and rails, where boost is earned) and 0 the direct fast
line, with 50 the safe default down the middle. [inferred] [[395-rating-reading]]()

> [[395-reselect]]() @0x00118098 — off-path threshold `500.0` (`0x43FA0000`) on
> `boarder+0x348`, gated `+0x418 ≥ 0` and `frameCounter % 60 == 0`; end-of-path
> threshold `200.0` (`0x43480000`) against the path length (`0x00198048`); third
> trigger = a path virtual (`path+0x34` vtable, slot at +0x14) fed the previous
> arc. All three call the selector `0x00118838` (advance passes a1 = 1, which
> excludes the incumbent).

> [[395-score]]() @0x00118838 — candidate collect `0x00198420` over the AI-path
> table (global 0x003491B8), N = 6; per candidate `cPath_ClosestPointArcLength`
> (0x00197748) and the same `arc + 800.0` lookahead; geometric terms are two VU0
> dot products (squared distances); best = minimum, seeded `0x7CF0BDC2`.

> [[395-rating]]() @0x00118838 — the rating is `path+0x38` read as an integer:
> the in-memory slot the parser fills from the path record's 0x0C word (the same
> slot holds `DistanceToFinish` for race lines, a float — one field, two record
> kinds). Bonus term `(100 − |rating − mood|) × 23189.357` (`0x46B526B7`),
> subtracted from the score, AI riders only (`boarder+0x41C == 0`). GARI census
> (spec:250-patha): 50 on most paths, outliers 0/20/25/80/100.

> [[395-mood]]() @0x001188F0..0x001189E8 — mode `boarder+0x420`; placement
> `boarder+0x110` (written by the standings pass 0x00115100); boost meter
> `boarder+0x1C` vs `0.1033` (`0x3DD3B6E3`) / `0.3121` (`0x3E9FAD4C`); skill
> percent = rider virtual (vtable+0x70 → `0x00138468`: returns 0 when the global
> at 0x0032F0A4 is clear, else `skill / 1.1039` (`0x3F8D4FDF`), or exactly 1.0
> when skill == 1.0), compared against `rand() % 100` — losing the roll resets the
> mood to 50.

> [[395-rating-reading]]() the 0↔100 semantics are inferred from the mood
> triggers (boost-starved → 100, leading → 0), not from any label in the data. A
> census correlating per-path ratings against nearby jumps/rails would settle it;
> not yet run.

## The behavior machine

The path-following steer above is only what the AI does when it has nothing more
interesting to do. On top of it sits a four-state machine held as a
**pointer-to-member-function** on the AI object, dispatched from the grounded
cruise input builder. Each state ends by choosing its own successor, so the
machine is a plain transition table with no scheduler. [[395-behaviour]]()

| state | what it does |
|---|---|
| **approach** | a **jump marker** is in range on the current path: press and hold the ollie (below) |
| **cruise** | nothing in the way: ride the line, boost when the meter allows |
| **avoid** | a rival is in the way and this rider is faster: swerve around it |
| **attack** | hunt a rival: abandon the line and pursue an intercept point ahead of it |

**Cruise** holds boost once the **boost meter is full**, scaled down by the
rider's aggression scalar so an aggressive rider fires earlier; it drives the
throttle axis to full below **30 km/h** and to `aggression / 2.2116` above it.
[[395-cruise]]()

## The jump is authored, not emergent

An AI rider ollies because the level **told it to**, at a marker on the path it is
riding. It does not probe the terrain, does not read the path's gradient or
curvature, and does not carry a precomputed distance-to-jump. The entire rule is a
range query against the path's own item list. [[395-jump]]()

Every tick the rider asks its **current AI path** for items in the arc window
`[lastFrameArc, arc + 300 u (3 m)]` — a window whose back edge is last frame's arc,
so a marker cannot be stepped over however fast the rider is travelling. An item
of **type 25** puts it in the *approach* state, where it presses **jump** if, and
only if:

- the marker is still **ahead** of the rider's arc, and
- the rider is within **153.10 units (1.53 m)** perpendicular of its line, and
- its steering command is under **0.536** — i.e. it is going roughly straight. A
  rider does not jump mid-carve.

It then **holds** the button while a type-25 marker remains inside the tighter
window `[lastFrameArc, arc + 50 u (0.5 m)]`, so the charge builds over the last
half-metre and releases as the rider crosses the marker. During the charge it
**boosts** if it is more than **5 km/h under the marker's target speed**, and it
**brakes** if it is more than 5 km/h over. [[395-jump-window]]()

The marker's payload is the reason the AI hits a gap at the right speed:

| field | meaning |
|---|---|
| `flags >> 2` | **target speed, km/h** (GARI: 46–117, median 100) |
| `flags & 2`, `flags & 1` | two **trick-selection** flags, rolled at the press |
| item arc | where on the path the marker sits |

The trick itself is chosen at the moment of the press, by a roll against the
rider's trick statistic; a lost roll falls back to no trick.
[[395-trick-pick]]()

The AI reads two path-event types at runtime, and the course reset four more
(`250-paths-aip-sop.md`). Item type 25 is index 25 in the event-type
translation table, which maps to raw `EventType` **100** in the file — 104 of
them on Garibaldi's AI paths. The path's **range query** walks the path's
16-byte event records — type index, value, start station, end station — and
returns every record whose window **overlaps** the asked interval, so a
marker window that straddles the rider's arc is found, however it is
authored. A second query asks whether an "end of path" event (raw type
**300**) overlaps the interval the rider just travelled; that is the
tracker's third re-select trigger. Every other event type remains
undispatched by the AI. [[395-jump-type]]() [[395-range-query]]()

## Tricks in the air

An AI rider performs **named tricks, not mashed inputs**. In the launched-air
state its synthesized control word carries the same fields a human's does: a
trick slot in the low byte (one of the 26 trick inputs of the button map, or
26 for none), a signed spin command, a signed flip command, and two small
nudges for yaw and pitch. Three independent rolls at the jump press decide
what it will do. The trick slot is a uniformly random entry from the
character's fifteen-entry trick list if a roll against the rider's trick
statistic passes, else none. Rotation is *allowed* only if the jump marker
carried at least one of its two flags **and** a second identical roll passes —
then the spin command is ±1 exactly when the marker's second flag is set and
the flip command ±1 when its first is, each sign random. So the marker's flags
select **which rotation axes** the rider uses, not which trick. A third,
"late release" flag is rolled with a probability that grows as the rider's
skill scalar falls (never for a nominal rider). [[395-air-tricks]]()

Airborne, every tick the rider re-asserts the trick slot and both rotation
commands, and — only when it holds no trick and no rotation — steers yaw
toward its pursuit target and pitch toward its predicted landing vector. It
**stops a rotation** when the board is within 20° before or 5° past an
aligned angle (flips at multiples of 360°; spins at multiples of 180°, or
360° for one board class) *and* the remaining airtime is shorter than a
further half or full turn would take at the current rate — it lands square by
design. It **releases the trick** when the remaining airtime drops below
`0.8 / (0.782 + 0.806 × stat / 255)` seconds — half a second to a second
depending on the rider — or below 0.3 s if the late-release flag was rolled.
It may pick a **second trick** mid-air, without a roll, when none is active,
it has been airborne longer than that threshold and has more than it
remaining — but only after natural air, never after a jump, because the flag
that arms it is set only by the natural-air state. In natural air the rider
does no tricks; in the last half-second before landing it steers toward its
path target. On a rail it presses jump (and picks a trick) when a jump
marker is ahead; otherwise it steers to stay level, and once nearly level a
trick-statistic roll makes it boost and push the stick fully to one side for
a rail spin. [[395-air-tricks]]()

The two prewind states' threshold is the race run clock, compared *negated*
against 30 s and 60 s. The clock is never negative, so the first branch
always wins and the AI always holds full spin deflection in one direction;
the alternate branches are unreachable in retail. [[395-prewind]]()

## The push

Two bits of the grounded control word are a **push gesture**: a pair of
signed 2-bit digital axes forming an 8-way direction (a human sets them with
two dedicated buttons or the sign of an analog axis past a half-deflection
dead zone). The grounded control states decode both into a direction angle
and play one of four push animations — forward within ±30°, backward beyond
150°, otherwise left or right (swapped by stance). The AI writes the field
every sixth frame, only while its designated **objective rival** is beside
it — 30°–150° off the nose and within 2 m — pushing toward that rival's side;
riders ahead or behind, and rivals it is not targeting, are never shoved.
Whether the gesture itself moves the rival, beyond the ordinary body-contact
separation below, was not traced. [[395-push]]()

> [[395-air-tricks]]() `AiInput_TrickAir_State16` `0x00138d68`: flip stop
> `0x00138db0–0x00138e2c` (`deg(+0x1D4) mod 360`, window `(r−5) <u 336`, rate
> `[boarder+0x5AE0]+0x770`, π/rate vs `+0x57B8`); spin stop `0x00138e34–ec`
> (modulus 360 if `boarder+0x420 == 2` else 180, rate `+0x76C`); trick release
> `0x00138ef0–0x00139018` (re-pick via `0x0011d370` when `+0x884 ≠ 0`, `T <
> +0x57FC`, `T < +0x57B8`, T = 0.8 / (rider[+0x14]·0x3F4E47D2·0x3B808081 +
> 0x3F48390A); id ≠ 26: `+0x880 ≠ 0 → 0.3 s` (`0x3E99999A`) else T); spin/flip
> encode `0x00139024–80` (mask 0xFFFFCFFF, << 12) and `0x00139084–d8` (mask
> 0xFFFF3FFF, << 14); `lbu +0x878 / sb 0(word)` `0x001390dc–e0`; yaw
> `0x00139120–8c` (`AiSteer` `0x00137300`, sign → bits 20–21), pitch
> `0x00139194–0x00139200` (helper `0x001371e8` on `boarder+0x57E0`, bits
> 22–23). `AiPickTrick` `0x00139d60`: `+0x87C` roll gated on either marker
> flag `0x00139d8c–c8`, `+0x880` `0x00139dc8–e84` (0x416743A5 and 20.0),
> `+0x878` `0x00139e88–cc`, `+0x888/+0x88C` from the flags with random
> negation `0x00139edc–f48`; trick table `0x0011d370`: `0x00334298 +
> rider[+0x44]·240 + rider[+0x5C]`, `rand % 15`, 16-byte rows `{trickId 0..25,
> 3 anim event ids}`. Natural air `AiInput_NaturalAir_State13` `0x00138ac8`
> (`+0x884 = 1, +0x87C = 0, +0x880 = 0`; gate `+0x57B8 < 0.5`; steer → bits
> 8–13; `+0x878 = 26`). Rail `AiInput_RailRide_State15` `0x00138bc0` (marker
> query `0x001392b0` → bit 1 + `AiPickTrick` at `0x00138c14`; steer `clamp(−2 ·
> boarder+0x198)` `0x00138c30–64`, deadband `0x3DCCCCCD`; roll `0x00138ca0–c0`
> → bit 3 at `0x00138cd4`, full steer `0x00138d24–44`). Human side for the
> layout: `cPlayer_GetInput` `0x00151268`, case table `0x003702C0`; state-16
> case `0x00151958` (byte 0 := 26 at `0x00151c5c`, then slot i for pressed
> trick input i ∈ 0..25 at `0x00151dc4–0x00152020`; bits 12–23 = axis signs in
> 2-bit pairs); consumer `Trick_StartFromInputSlot` `0x001272f0` (compares
> with 26 at `0x00127358`, stores `boarder+0x1E4` at `0x00127814`). Landing
> block `boarder+0x57B0` ticked by `AirLanding_TickTimers` `0x00123ed0`
> (`+0x57FC += 1/60`, `+0x57B8 = +0x57F4 − elapsed`). map:"AI rider, part 4:
> air tricks, the push gesture and the path range query".

> [[395-prewind]]() `AiInput_Prewind_State8` `0x00138630` (states 9/17 inline
> `|0x1F` at `0x00138610`): threshold `[0x00338E58]->+0x730->+0x1C->+0x14` =
> race manager (per `GetRider` `0x00181560`) `+0x14` run clock (integrator
> `0x00114210` `+= dt`, penalty `0x0011361c` `+= 2.0`, finish stamp `0x0011da78`
> `×100 → boarder+0x418`); thresholds `0x41F00000`/`0x42700000` (30/60 s),
> divisor `0x40508CC3` (3.2586) for non-nominal skill; writes `(w & ~0x3F) |
> 0x1F` (+31) at `0x001386c4` or `| 0x21` (−31) at `0x0013874c` — the latter
> unreachable since the clock is ≥ 0; the 6-bit field is a signed spin axis,
> not five button bits.

> [[395-push]]() AI writer in `AiBehaviour_Dispatch` `0x001389d0`: helper
> `AiRival_ObjectiveTargetBeside` `0x001394e8(this, &side)` → `side ≠ 0 ⇒
> 0x01800000` (−1) else `0x00800000` (+1), mask 0xFE7FFFFF
> (`0x00138a1c–4c`); helper: anim gate `0x0015eed8(boarder+0x46C0, 1) ≠ 21`,
> `raceMgr+0x18 % 6 == 0`, loop over `raceMgr+0x88` riders skipping
> `boarder+0x460`, pairwise entry `boarder+0x40 + 32i`: dist < 200.0, `d =
> wrap(boarder+0x1B0 − bearing)`, `0.5236 < |d| < 2.618` (`0x3F060A92` /
> `0x40278D36`), objective gate `+0x118 ≠ 0 ∧ +0x120 == i ∧ +0x124 ∈ {1,2}`
> (`0x00139638–6c`), `side = (0 < d)`. Readers: `0x001032bc` (state 3),
> `0x00104230` (state 2), `0x00105e28` (state 7) — `sll 7; sra 30` → f12, `sll
> 5; sra 30` → f13, `jal Boarder_GroundGestureFromDigitalDir 0x00127920`;
> `0x00127920`: angle `0x00127bb4–0x00127c2c` (atan `0x00251628`), stored
> `boarder+0x1E0`, events 519/520/517/518 by `boarder+0x1B4` →
> `BoarderAnim_PlayEvent` `0x0015fd10`; anim strings `bxR_PUSHTS/2/3`,
> `frR_PUSHTS…`, `exR_PUSHTS…` at `0x00373178` ff. Human writer
> `0x00151514–0x00151628`: btn 38 → 3, btn 39 → 1, else sign(axis 5) → bits
> 23–24; sign(axis 6) → 25–26; same pair at 24–27 in state 16 and 26–29 in
> state 13.

> [[395-range-query]]() `AIPath_ParseSection` `0x00198abc` stores the vtable
> `0x0038BE48` at `+0x34` of every 64-byte record (race-line sibling
> `0x0038BE80` at `0x0019895c`; RTTI `7cAIPath`); vtable slots 0–4 =
> `0x00196e38`, `0x00197e08`, `0x00198088`, `0x00196bf8`, `0x00196c10`.
> `cAIPath_RangeQueryEvents` `0x00197e08(path, &outArray, &typeMask,
> startSlot, f12 lo, f13 hi)`: `hi < lo ⇒ 0`; result pointers into
> `0x003390F0 + startSlot·4`; loop over `[path+0]` events at `[path+4]`, stride
> 16 (`0x00197e50–dc`): skip if `hi < start(+8)` or `end(+0xC) < lo`; mask `|=
> 1 << type` if `lo < start` or `hi < end`; append; returns count.
> `cAIPath_HasType31EventInWindow` `0x00198088` (`type == 31 ⇒ 1` at
> `0x001980cc–e0`), called at `0x001181a0–b0` in `Boarder_UpdateAiPathTracking`
> with `[+0x340, +0x344]`. `PathEvent_Parse` `0x00197668` writes +0/+4/+8/+0xC.

## Rivals: what actually spreads a field out

The riders can see **each other**, and that — not any property of a single rider —
is what stops an SSX field riding in single file.

The race manager keeps a **pairwise table** on every boarder: one 32-byte entry
per competitor, holding the **planar distance** and the **world bearing** to that
competitor, rebuilt every standings pass by a symmetric double loop.
[[395-pairwise]]()

A rider **acquires a rival** from that table every 12th frame: anyone within
**700 units (7 m)**, scored by distance weighted against how far off the nose they
are, so the competitor straight ahead beats a nearer one off to the side. It drops
the rival past **1050 units (10.5 m)**, or when the rider is itself more than 600 u
off its own path (too lost to be racing anyone); it will not acquire at all beyond
540 u off-path. [[395-rival]]()

**Avoid.** A rival is "in the way" if its bearing offset from the rider's path
heading is inside a cone of `atan(150 u / distance)` — a cone drawn around a
**1.5 m clearance disc**, so it *widens as the rider closes* (≈12° at 7 m, ≈27° at
3 m, 45° at 1.5 m). The swerve is not a nudge on the stick: the rider→target
**pursuit vector is rotated in yaw** by the angle that clears the disc, and the
rider then carves toward that displaced aim point like any other target. And it
only swerves if it is **strictly faster** than the rival — a slower rider holds its
line and eats the block, which is why real SSX traffic bunches and shoves instead
of politely parting. [[395-avoid]]()

**Attack.** If the rival is anywhere in the forward 180° arc, the rider abandons
its path outright and pursues an **intercept point 300 u (3 m) ahead of the rival
along the rival's own velocity**, braking if it is closing too fast from outside a
2 m gap. Whether a rider attacks or avoids is decided by a game-mode gate:
attack-everyone is mode enum **0**, which the front end never writes, so in
every reachable mode only the rider's designated objective target is
attackable. [[395-attack]]()

**Bodies collide.** Two overlapping riders are pushed apart, each taking **0.55**
of the separation vector (the full push lands on one rider if the other is down).
The AI does not read the contact — it reasons only from distance, bearing and
speed — so the shove is a pure physics consequence layered under the behavior.
[[395-bump]]()

**NEGATIVE — there is no lateral lane.** Every rider aims *dead at the centreline*
of its path, 8 m of arc ahead. The path record carries no corridor width, the
point-at-arc query has no lateral parameter, and of the ten call sites of the
steer, the only two that aim anywhere other than the raw spline point derive that
aim from **another rider** (the avoid rotation and the attack intercept). A
per-rider lane offset is the obvious way to spread a field and the engine does not
do it. [[395-no-lane]]()

> [[395-behaviour]]() @0x001389d0 — the cruise input builder dispatches the PMF at
> `cComputer+0x8A0` (old-GCC layout: delta @+0x8A0, index @+0x8A2 = −1 ⇒
> non-virtual, pfn @+0x8A4; mirrored state id at +0x89C), `jalr` at 0x00138aa4.
> The four states come from a table at **0x0031E518**: 0 = approach @0x00137860,
> 1 = cruise @0x001375d0, 2 = avoid @0x00137dc8, 3 = attack @0x00137a20.
> Transitions are the assignments into +0x8A0: 0x001378b0 (0→1), 0x001377e8,
> 0x00137820, 0x00137840, 0x00137d38/6c/98, 0x001380d4/0x00138108/0x00138130,
> 0x00138420 (reset → cruise). The code lives at 0x001375D0–0x0013A600.

> [[395-cruise]]() @0x001375d0 tail 0x0013773c — boost meter `boarder+0x1C`,
> aggression `cComputer+0x86C` (from +0x870): press when `1.0 ≤ meter` (aggression
> exactly 1.0) else `1.0 ≤ meter · (aggression / 1.410261)`; word |= 0x0008 at
> 0x0013779c. Throttle `AiSetThrottle` @0x00139f68: `t = 1.0` below `833.333` u/s
> (`0x44505555`, 30 km/h) else `aggression / 2.2116` (`0x400D8C7A`); written to the
> 6-bit field at bit 11 (mask 0xFFFE07FF).

> [[395-jump]]() @0x00137860 (behavior state 0) — marker query 0x001392b0, then:
> `aheadFlag != 0` (0x00137940) ∧ `boarder+0x348` (perp) `< 153.1020` (0x0013795c)
> ∧ `|steer| < 0.5361633` (0x0013797c) ⇒ `AiPickTrick` (0x00139d60) and `word |=
> 0x0002` (0x0013799c). Pad-word bits established from the consumers, not guessed:
> bit 0 = course reset (`ControlState3_Cruise` 0x0010335c → `Boarder_CourseResetEntry`),
> **bit 1 = jump/ollie** (0x00103130 → control state 14), bit 3/4 = boost
> (`Boarder_HeldBoostChargeUpdate` 0x0011d040), bits 5–10 = steer, 11–16 =
> throttle, 17–22 = brake.

> [[395-jump-window]]() @0x001392b0 — window `[boarder+0x340 (previous arc),
> boarder+0x344 (current arc) + 300.0 (0x43960000)]` over the **active AI path**
> `boarder+0x57A4`, through the path's range-query virtual; items filtered to
> `type == 25` (`addiu a0, zero, 25` @0x00139338). The hold builder (control state
> 14, @0x001387f0) re-runs the same query with **50.0** (`0x42480000`) and
> re-asserts bit 1 (0x001388ec) plus boost (0x001388e0) while `speed <
> targetSpeed − 138.8889` (5 km/h); no marker in range ⇒ bit 1 drops ⇒ the ollie
> fires. Brake: `word.bit17 = 31` when `speed > targetSpeed + 138.8889`
> (0x001376b8 / 0x00137a00). `+0x340`/`+0x344` are written by the tracker
> (0x001180c4–0x001180f0), which is what makes the window gap-free.

> [[395-trick-pick]]() @0x00139d60 — rolls `rand() % 100 − 16 < riderStat[+0x1D]`
> (0x00139eb0); success → trick-table lookup 0x0011d370 (table 0x00334298 off
> rider record `boarder+0x464`), id stored at `cComputer+0x878`; failure → id 26
> (= no trick, the same sentinel the human's byte carries when no trick input
> is pressed). The marker's two flag bits land at `+0x888`/`+0x88C` as ±1.0f
> with random sign, gated by a second roll (`[[395-air-tricks]]()`). The id is
> consumed by the launched-air builder `0x00138d68` (`lbu +0x878 / sb 0(word)`
> at `0x001390dc–e0`); the prewind builder's `ori 0x1F` is the signed 6-bit
> spin axis, not five buttons (`[[395-prewind]]()`).

> [[395-jump-type]]() type-enum translation table @0x00339070 (`PathEvent_Parse`
> 0x00197668 stores the table INDEX, not the raw code): indices 0–24 map to raw
> −1 and 0…23, and **index 25 maps to raw 100** (0x003390d4), 26→101, 27→102,
> 28→103, 29→104, 30→105, 31→300. Raw type 100 census on the AI paths: GARI 104,
> and 516 across the five retail levels' `.aip`. Value word decodes as
> `(kmh << 2) | (trickB << 1) | trickA`: GARI target speeds 46–117 km/h, median
> 100. NOTE: a geometric check for a lift-off signature at the markers found none
> (median path climb in the 20 m after a marker is indistinguishable from a random
> arc position) — the AI paths hug the ground, which is consistent with the tracker
> being planar; the identification rests on the disassembly, not on the geometry.
> spec:250-events.

> [[395-pairwise]]() producer @0x00115a80, called from 0x0011389c immediately
> after `Race_StandingsPass`; full pairwise double loop over the race manager's
> boarder array (`race+0xC4`, count `race+0x88`) writing both `[i][j]` and
> `[j][i]`. Table base `boarder+0x40`, **stride 32**, indexed by the rider's race
> slot (`boarder+0x460`). Entry: `+0x00` planar distance `sqrt(dx² + dy²)` of the
> collision-volume centres (`+0x480`), `+0x04` world bearing `atan2(dy, dx)` (the
> reciprocal row gets `wrap(bearing ± π)`), `+0x08`/`+0x0C` frame stamps for the
> two contact channels (3-frame debounce), `+0x1A` bump counter. No pointer and no
> relative velocity are stored.

> [[395-rival]]() @0x001396d0 — runs on `frame % 12`; acquire radius `700.0`
> (`0x442F0000`, 0x001397e8), drop past `1050.0` (`0x44834000`, 0x00139728) or when
> `boarder+0x348` (perp) `> 600.0` (`0x44160000`), no acquisition when perp `≥
> 540.0` (`0x44070000`). Score = `dist · (attackable ? 1 + |cos d| : 1 − cos d)`
> where `d = wrap(entry.bearing − boarder+0x1B0)`; minimum wins. `attackable`
> (0x00139930) returns 1 unconditionally when the mode enum at 0x0032F08C is 0,
> else only for the rider's objective target (`boarder+0x118/0x120/0x124/0x128`).

> [[395-avoid]]() @0x00137dc8 — `halfWidth = atan(150.0 / dist)` (`0x43160000`,
> 0x00137f44); `d = wrap(entry.bearing − pathHeading(+0x370))`. If `halfWidth <
> |d|` or `mySpeed ≤ rivalSpeed` → steer at the raw target `+0x360`. Otherwise
> `theta = (d > 0) ? d − halfWidth : halfWidth − d`, SinCos, and the
> (target − pos) vector is rotated in the ground plane (0x00138000–0x00138044,
> lanes 0/1 rotated, lane 2 passed through — which is itself a second confirmation
> that lane 2 is up), then steered to (0x00138050). The two branches are **not**
> mirror images (`|d − hw| ≤ hw` one way, `hw − d ≥ hw` the other): the sign is
> always correct but one side over-swings. Kept as an authentic quirk.

> [[395-attack]]() @0x00137a20 — `|d| > 90°` (`0x3FC90FDB`) ⇒ steer back to the
> centreline, and brake (`bit17 = 31`) if `dist > 200.0` and the rival is slower.
> Otherwise `lead = rivalPos + 300.0 · normalize(rivalVel)` (`0x43960000`,
> 0x00137be4) and the pursuit steer is called on `lead` (0x00137cbc). Cones of
> 15° (`0x3E860A92`) and 50° (`0x3F5F66F3`) select the throttle helpers.
>
> [[395-bump]]() `Boarder_BodyBumpContactResponseCandidate` @0x00123fd0, called
> per-rider from `BoarderMotion_SharedUpdate`; volume test 0x00236f20 on the
> riders' collision records (`+0x470`) returns a separation vector; response
> (0x001240b0–0x00124184, VU0 on `boarder+0x140`): `sep · 0.55` (`0x3F0CCCCD`)
> subtracted from A and added to B when both are live, the full `−1.0 · sep` onto
> one when the other is down. Debounced through the pairwise table's `+0x08` frame
> stamp against `frame − 3`.

> [[395-no-lane]]() @0x00118098 — the target is a verbatim copy of the curve point:
> `cPath_PointAtParam(path, 0, arc + 800.0)` (0x001180ec) → `sq` straight into
> `boarder+0x360` (0x00118100), nothing added between. `cPath_PointAtParam`
> (0x00197ef0) has no lateral parameter (its third argument is an out-pointer for a
> clamp flag, written at 0x00197f4c/0x00197f6c). All ten `jal 0x00137300` call
> sites were enumerated: seven pass `boarder+0x360` verbatim, one passes the attack
> intercept (0x00137cc0), one the avoid-rotated target (0x00138054). The path
> record carries no width: the AI reads only the points, the length (0x00198048),
> the closest-point query and `cPath+0x38` (the rating).

## What actually differentiates a field

It is worth being precise about this, because the obvious guess is wrong. AI
riders differ by **the line they choose** (the rating-vs-mood pick above), by **how
they react to each other** (the rivals above — with no rival state and no bodies, a
field has nothing in it that can push two riders apart), by **their skill scalars**
(below), and by **the catch-up they are given**.

They do **not** differ in top speed: the per-character speed statistic gates the
cruise *drive* — the pull toward the surface's speed target — and not the target
itself (`360-speed-and-boost.md`), so every rider on a surface converges to the
same pace. What the statistic buys is *recovery*: how quickly a rider climbs back
to that pace off the line and out of each carve. The dramatic speed differences in
a real race come from the boost meter, the tricks that fill it, and the crashes
that empty it — not from a faster board. [[395-differentiation]]()

> [[395-differentiation]]() the negative is the load-bearing part: the cruise
> drive's rider factor (`0.7381 + stat·0.2769`, spec:360-cruise) multiplies the
> *deficit* against the per-surface target, which is shared, so a max-stat rider
> reaches the same terminal speed as a min-stat one and only gets there sooner.
> Independently reproduced in a port driving the same model: 5.8 m of gain over
> 20 s on shallow ground, 1.9 m on a steep pitch, identical final speeds.

## Skill

Each AI rider carries **two authored steering-gain scalars** and switches between
them once per second by comparing its own placement with that of a reference
rider: one value is used while that rider is ahead of it, the other while it is
not. The chosen scalar is what scales the steering gain above, and the same
scalar (differently normalized) is the probability the rider commits to its mood.
A nominal scalar of 1.0 leaves both at their defaults. So "skill" in this engine
is literally *how hard the rider is willing to turn* and *how far it strays from
the safe line* — not a different algorithm. [[395-skill]]()

> [[395-skill]]() @0x0013A228 — runs on `frameCounter % 60 == 0`; reference rider
> resolved through `0x00181560` from `boarder+0x100`; picks `this+0x874` when the
> reference's placement (`+0x110`) is better than its own, else `this+0x870`;
> result → `this+0x86C`, read by the steer (`0x00137300`) and the skill-percent
> virtual (`0x00138468`). Both source values are written at rider construction
> (`0x0024E44C`/`0x0024E450`).

## Catch-up: the AI rides in dilated time

The rubber band is **not** a force, a speed bonus, or a path change. Every rider
scales its own integration step by a per-rider **time-scale** (nominally 1.0, i.e.
a 1/60 s tick), and an AI rider *drives that scalar*: it runs its physics between
**0.70× and 1.50× real time** depending on how far ahead of, or behind, its
reference rider it is. An AI rider that is behind lives in fast time — it
accelerates harder, carves faster and covers more ground per frame with exactly
the same physics — and one that is ahead is slowed the same way. [[395-catchup]]()

The input is the **gap along the course direction** between the rider and its
reference (the component of the vector to that rider along the rider's current
path heading, so lateral separation does not count). Inside a symmetric dead band
of **±517.34 units (±5.17 m)** the scale is exactly 1.0. Beyond it: falling
behind ramps the scale up **linearly** with the gap (reaching the 1.50 ceiling at
roughly twice the band), while getting ahead drops it to the 0.70 floor almost
immediately past the band. The result is slewed at no more than **0.008444 per
tick**, so a full swing from floor to ceiling takes about 1.6 s and the band is
never entered or left abruptly. [[395-catchup-shape]]()

The reference rider and the band are assigned by the **standings pass**, which
runs every sixth frame and sorts every rider — the human included — by course
progress. It writes each rider's placement, and then hands each one, as its
reference, **the competitor immediately ahead of it in the placings**; the leader
is given the runner-up instead. The field is therefore banded as a **ladder, not
a star**: each rider paces the one in front of it, and the leader is the only one
whose reference is behind it (which is what pulls a runaway leader back). Nothing
is banded against the human specifically — they are simply one more rung.
Placement is an input to both the catch-up and the skill switch above.
[[395-standings]]()

| Quantity | Value |
|---|---|
| Lookahead to the steering target | 800 units (8 m) |
| Steering gain (nominal skill) | 6.2897 rad⁻¹ (deadband ≈1.8°, full stick ≈8.8°) |
| Steer deadband / clamp | 0.2 / 0.9705 of full stick |
| Off-path re-choice threshold | 500 units (5 m), grounded, ≤ 1/s |
| End-of-path advance threshold | 200 units (2 m) |
| Path candidates considered | 6 nearest |
| Line-rating match weight | 23189.36 per rating point (max 100 points) |
| Mood values | 0 / 50 / 100 |
| Catch-up dead band | ±517.34 units (±5.17 m) of along-course gap |
| Catch-up time-scale range | 0.70× … 1.50×, slewed ≤ 0.008444/tick |
| Standings pass | every 6th frame; skill switch every 60th |

> [[395-catchup]]() @0x0013A0F8 — the AI's per-tick scalar, written through
> `0x0011CFF8` (a move-toward with max step `0.008444`, `0x3C0A6286`) into
> `boarder+0x12C` — the rider's tick scale, `dt = +0x12C / 60` throughout the
> rider model (map:"Ground steering heading rate"; @0x0010A120 tick scale
> `0.016666667`). Returns exactly 1.0 when no reference is set
> (`boarder+0x100 < 0`).

> [[395-catchup-shape]]() @0x0013A0F8 — gap `x = −rec[0] · cos(rec[4] −
> pathHeading(+0x370))` where `rec = boarder + 0x40 + 32 · (+0x100)` — the pairwise
> table, produced at [[395-pairwise]](). Band `lo = +0x104 =
> −517.34`, `hi = +0x108 = +517.34` (`0xC4015603` / `0x44015603`, written by the
> standings pass at 0x001154AC/B4). Behind (`x < lo`): `((x − lo)/lo + 1) ·
> 1.13598` (`0x3F9167F4`). Ahead (`x > hi`): `2.04874 / (x − hi)` (`0x40031E57`).
> Else 1.0. Clamp `[0.70008, 1.50227]` (`0x3F3336CA` / `0x3FC04A0C`).

> [[395-standings]]() @0x00115100 — runs on `frameCounter % 6 == 0`; sorts the
> rider array (`mgr+0xC4`, count `+0x88`) by a mode-selected progress key
> (`0x002D0F68` qsort), writes placement to `boarder+0x110` and the reference /
> band fields `+0x100`/`+0x104`/`+0x108`. The reference assignment is the ladder:
> at 0x001154D0 the leader (`sorted[0]`) is given `sorted[1]`, then the loop at
> 0x001154F0 walks `s2 = 1…count-1` writing `rider[sorted[s2]]+0x100 =
> sorted[s2-1]` — each rider gets the one placed immediately ahead of it, and no
> rider is special-cased to the human. spec:390-race-score (the standings key
> itself is the discrete checkpoint counter, not DTF).

## Falling out of play: the course reset

A rider that ends up somewhere it cannot race from is not nudged — it is
**warped**. This is one mechanism for the whole field, human and AI alike, and it
is the reason no rider ever needs a "stuck" detector.

**What arms it.** Three automatic triggers, plus the reset button and the SSF
reset volumes (`390-pickups-and-race.md`):

- a **bump integrator** that accumulates while the rider is in contact with an
  object or another rider and fires after roughly five consecutive frames of it —
  the engine's "wedged against something" detector;
- a second **contact integrator** with a higher threshold;
- a **height plane**: the rider is below the level floor by more than 10 000 units
  (100 m).

A crash also forces it on the next update by slamming the bump integrator to a
huge value. **NEGATIVE: there is no stuck timer and no no-progress test.** Being
far from your path, or making no forward progress at all, never resets you — only
impacts, the floor, a volume, or the button do. [[395-reset-arm]]()

**Where it puts you.** The reset runs as its own control state, and after **0.8 s**
it: takes a point on the rider's current path a **rubber-band delta** further
along (the mean of the other riders' progress, clamped non-negative, so a reset
never costs you ground you had already made); collects the **six nearest paths to
that point, filtered to those flagged `respawnable`**; scores them exactly like the
AI path selector; and writes the winner's point straight into the rider's position
with a velocity of **833.33 u/s (8.33 m/s) down-course**. The path tracker is
re-seeded on the new line. [[395-reset-place]]()

This is what the AIP's **respawnable** flag is for, and it gates **this and nothing
else**: the AI's own path selector runs the same collector with the filter turned
*off*, so a rider may freely *ride* a line it could never be *put back* on
(`250-paths-aip-sop.md`). [[395-respawnable]]()

> [[395-reset-arm]]() `Boarder_CourseResetEntry` @0x00118f18, polled from every
> control state; automatic sites in `BoarderMotion_SharedUpdate`: bump integrator
> `boarder+0x2E4` decayed by `0.95614` (`0x3F74BEDF`) and fired above `4.4920`
> (`0x408FBE85`) at 0x00117bc8, fed `+= (dot < 0) ? 1.0 : 1.0 − dot` per contact
> frame from 0x00125cac; contact integrator `+0x300` decayed by `0.97836` and fired
> above `12.0021` (`0x414008CA`) at 0x00117c1c; height test at 0x00117c60,
> `pos+0x148 < level+0x0C − 10000.0` (`0x461C4000`). The ground-motion crash path
> sets `+0x2E4 = 1000000.0` (0x0010d648) when the rider has not finished.

> [[395-reset-place]]() 0x00118f18 → 0x00119be8 (motion 4, control state 22) →
> state-22 update 0x00106a90: timer `+0x08` past `0.8` (`0x3F4CCCCD`) calls
> 0x00118c10 (target = current path at `arc + delta`, extrapolated past the end if
> need be; collector `0x00198400` → six nearest; winner → `+0x57A4`; tracker cache
> → −1 at 0x00118e90) then 0x00119228 → `0x0011caf0`, which does the writes:
> `sq` the path point into `boarder+0x140` (0x0011cb3c) and the down-course
> velocity into `+0x150` (0x0011cb48) at `833.333` (`0x44505555`). The delta is the
> mean of the other riders' DTF, clamped ≥ 0 (0x00118f18 / 0x00119be8).

> [[395-respawnable]]() the filter lives in the collector: `0x00198400` is a
> one-line wrapper that calls `0x00198420` with `t0 = 1`; inside, `t0 != 0` tests
> `cPath+0x3C` and excludes the path (distance = 1e37) when it is zero
> (0x001984b0–0x001984c8). `AiPath_SelectOrAdvance` (0x00118838) calls `0x00198420`
> with `t0 = 0` — no filter. `cPath+0x3C` is the AIP record's respawnable word
> (file `+0x18`), adjacent to the rating at `+0x38`; cPath stride is 64.
> **Correction:** `300-rider-states.md` `[[300-reset-separate]]` says no
> nearest-path search runs on the recover path — that is true of
> `WipeOutRecover_RepositionOntoTrack` (0x0010f178), which is a relative nudge and
> is gated on `+0x418 ≥ 0`, i.e. it only runs for a rider who has already
> **finished**. During a race a wipeout does not reposition you; the searching
> reset is the control-state-22 warp above, which is a separate path.

<!-- DIRTY
Open leads, AI riders:

- **Prewind entry.** How the AI's antic state hands off to prewind states 8/9
  (no `a1=8/9` setter through 0x0011f610 was found; the AI's antic-state steer
  occupies the bits the human's prewind axis 13 uses), and what control
  state 17 is. Next: grep `addiu a1, zero, 8/9` near `jal 0x0011c7e0` and read
  the state-14 update's prewind branch.
- **Push physics.** Whether the ground gesture (events 517–520 via
  `boarder+0x1E0`) feeds the pairwise bump or is animation only. Next: follow
  the animation-event consumer.
- **`boarder+0x190` quad** — its lane 2 drives the AI's rail level-keeping;
  read 0x00117700 (`BoarderMotion_SharedUpdate+0x560`) and 0x0010b418
  (`RailMotion_State3Update+0x348`) to name it.
- **Button/axis slot names** (trick slots 0–25, buttons 27/29/32–39, axes
  0–14): parse `data/config/btnmap%d.dat` (string 0x00386600) via
  `BtnMap_LoadConfig` 0x00179aa0.
- **`cAIFwdDiffCache`** (RTTI @0x003A7798, code near 0x0025261C): `xrefs` and
  `refs` both return zero hits. It is dead code — a forward-difference path
  evaluator nothing calls. Recorded so nobody hunts it again.
DIRTY -->
