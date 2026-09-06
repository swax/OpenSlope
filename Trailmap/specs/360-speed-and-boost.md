# 360 — Speed and Boost

Speed is managed from two sides. A shared, slowly decaying **speed cap**
bounds the carried velocity from above (it never pulls speed up), and a
grounded **cruise drive** re-accelerates the rider toward a per-surface
**speed target** — gated by how square the board is to its travel. Boost
exists in three forms: the **held boost** (a player-controlled meter spend),
instant **pad boosts** placed on the course, and authored scripted boost
nodes. [[360-overview]]()

> [[360-overview]]() db:speed-cap; db:surface-speed-response; db:boost.

## The speed cap

Every tick, the shared update measures the velocity magnitude and selects a
cap by boost state: ≈ 27.9 m/s by default, raised to ≈ 30.7 or ≈ 33.5 m/s
while a boost gate is active (the strongest while boosting hard or carrying a
pad boost). The live cap **decays toward the selected value at ≈ 2.08 m/s
per second** rather than snapping (an expiring boost bleeds off smoothly —
≈ 29.3 m/s is a typical mid-decay value), and the whole velocity vector is
scaled down only when speed exceeds the live cap. The airborne integrator
re-arms the cap at the top value (`340-jump-air-landing.md`); the same
down-only cap is the only drag a rail applies (`350-rails.md`).
[[360-cap]]()

> [[360-cap]]() db:speed-cap — @0x00117970: caps 2788.839 default /
> 3347.222 strong gate (+0x134 > 0, or +0x130 > 0 with meter > 0.666) /
> 3072.142 weak gate (meter > 0.3336) / 2932.430 observed mid-decay; decay
> 3.472222 units/s per tick; scale-down @0x00117aac only when over.

## The cruise drive

On the ground, the surface row supplies a **speed target** and a response
multiplier (`310-surface-response.md`). The drive computes a positive-only
deficit, gates it by alignment and a rider statistic, and applies the result
as acceleration along the contact-frame tangent: [[360-cruise]]()

```text
deficit   = min(target − speed, 11.1 m/s worth)      (only if positive)
alignment = full when |heading − travel| ≤ 30°,
            fading linearly to zero at 60°, zero beyond
factor    = rider-statistic curve (state-dependent, ≈ 0.74–1.51)
drive     = alignment · factor · deficit · surfaceMultiplier
```

So a board pointed down its own travel direction pulls toward the surface's
cruising speed, a board more than 60° across its travel gets nothing (a
sideways skid does not re-accelerate), and slow surfaces are slow because
their target is low — rock's ≈ 5.4 m/s versus ice's ≈ 17.8
(`310-surface-response.md`). A suppression timer can zero the drive entirely,
and one animation event substitutes a small floor response regardless of
alignment. [[360-cruise-vals]]()

Grounded down-slope acceleration is consequently **shaped**, not a bare
gravity projection: what the rider feels on a slope is the combination of
this drive, the contact-frame response (`320-ground-contact.md`), and the
cap — not a g·sin θ term. No such term is *written*: gravity pulls the grounded
deck into the surface each tick (`320-ground-contact.md`), and what a slope does
with that is geometry. The shaping sits on top of it. [[360-shaped]]()

Three things a rider control scheme might expect are **absent from the traced
model**, and an implementation that adds them is adding its own game, not
reproducing this one: there is no grounded **drag** term (the cap and the
deficit-only drive are the whole of the speed bound), and no **brake** or
**tuck/crouch** input reaches the motion code at all. [open] [[360-absent]]()

> [[360-cruise]]() db:surface-speed-response —
> `SurfaceMaterial_SpeedResponseHelper` @0x00109950: deficit
> `surface(+0x2c)·27.7778 − |v|` capped 1111.11; alignment from wrapped
> heading delta (+0x1b0 vs +0x370), 30°/60°; rider factor 1.205 +
> byte·(0.305/255) in state 2, else 0.738 + byte·(0.277/255); × surface
> +0x30; applied along +0x320 with the turn response (@0x0010a38c).

> [[360-cruise-vals]]() db:surface-speed-response — suppression when
> +0x1fc > 0 (returns zero); event-545 floor 0.2·factor·deficit;
> db:surface-table (targets).

> [[360-shaped]]() db:motion — down-slope/contact acceleration is tuned
> through boarder fields, contact-normal components, and surface scalars; no
> plain g·sin(θ) term in the ground helpers; db:snow-sink for the grounded
> gravity pull (`[[320-gravity-holds]]`).

> [[360-absent]]() db:motion; db:input — inspected-path negatives: no
> velocity-proportional or speed-squared damping term in the ground update
> @0x0010a0d8 or the shared update @0x001171a0 (the only traced damping is the
> airborne horizontal one, db:air); no control-state branch decodes a brake or
> crouch button (db:input button map; the traced grounded inputs are turn,
> jump and boost).

## Held boost

The held boost is a meter spend: while the boost input is held, the rider's
**held-boost amount** is set from the meter's thresholds, and cleared when
released. It has four consumers: [[360-held]]()

- **The cap.** An active boost selects the raised speed caps above: the
  strong cap applies while a pad boost is active, or the held meter exceeds
  ≈2/3; the weak cap applies once the held meter exceeds ≈1/3.
- **Ground thrust.** Inside the cruise drive, a separate thrust fires only
  while the board is ridden **nearly flat** (|lean| below a window of
  ≈ 0.08): `thrust = (windowRemaining / window) · (23.5 + slope·10.5 when
  slope is favorable) m/s²` — i.e. up to ≈ 23.5 m/s² at full window on level
  ground, ramping to zero as lean approaches the window edge, and increasing
  further on favorable slope. The quantity the slope term reads is not
  established [open], so only the 23.5 m/s² base is safe to reproduce. The
  window is narrow against the lean clamp of ±0.905: roughly the first 9% of
  available lean. Edging hard while boosting therefore wastes
  the thrust; boost is a hold-your-line tool. The thrust is **not** scaled by
  the surface — a surface reaches boost only through its cruise target.
- **Rail thrust.** On a rail the held amount drives the tangent thrust
  directly (`350-rails.md`). [[360-held]]()
- **Board afterimage.** The board renderer samples four pose points into a
  seven-record geometry ring at 20 Hz and draws two coloured sheets through
  the history. It uses yellow/orange/red meter thirds, drains one record per
  20 Hz update after release, and has no contact gate, so it follows the deck
  in the air too (`research/boost-trail.md`). [[360-boost-trail]]()

> [[360-held]]() db:boost-rail — `Boarder_HeldBoostChargeUpdate` writes
> +0x130 from meter thresholds, clears on release (strong gate `+0x134 > 0`
> or `+0x130 > 0` with meter > 0.666, weak gate meter > 0.3336, per
> `[[360-cap]]`); db:surface-speed-response — ground thrust gate `|lean| <
> 0.079833` (the window), response = gate · ((0.079833 − |lean|)/0.079833) ·
> slopeTerm, slopeTerm 2350.30957 raw units/s² ≈ 23.5 m/s² (+ slope ·
> 1053.44836 raw ≈ 10.5 m/s² when the slope field is positive); the boost
> input is the Square button (db:input).

> [[360-boost-trail]]() `BoarderRender_Update` @0x00136150 (held +0x130 / pad
> +0x134 gate, meter colour, seven-slot ring); pose capture @0x00136c50;
> render and dedicated history draw @0x001364d8 / @0x001f0dc8.

## The boost/Tricky meter

The held boost spends a **meter** (range 0..1) that tricks fill. It is the
same energy the music subsystem reads for the "It's Tricky" song swap and
uber-tier escalation (`430-music-and-announcer.md`). [[360-meter]]()

**Filling.** Each landed/registered trick adds to the meter:
`meter += inc × riderScalar`, clamped to 1.0. The increment is the trick's
**style value** run through the points constant without the ×10000 scale:
`inc = max(0, style × 0.67869) / (flips + 1)` — exactly the trick's **base
style points ÷ 10 000**. Two things that raise the *score* do **not** raise
the meter: the **gem multiplier** is not applied, and the **flat bonuses**
(grab-hold tiers, big-air time) contribute nothing. **Held tricks feed style
over time**, though: recognizing a named trick bumps style by 0.0425 × its
position in the string and arms an authored per-trick **style rate**
(1.0–5.0), and each held tick accrues `style += rate × 0.045/s` — so a held
**grab** does charge the meter through style (a basic rate-1 grab ≈ 0.03
meter/s, a rate-5 uber ≈ 0.15/s), even though its flat tier points never do.
Concretely: a clean 360 (style 0.25) fills ≈ **0.17** of the bar; a plain
grind (≈ 0.15 style/s) fills ≈ **0.10/s** while on the rail — over twice the
held-boost drain, so grinding is the fastest earner. A string resolved at a
jump launch fills the same style term undivided. `riderScalar` is a character statistic in the range
≈ **0.98× – 1.34×**, so a higher Tricky stat fills the bar faster.
**Penalties** (also rider-scaled): a crash or a **body bump** subtracts
≈ 0.1, a light bump 0.02, a placement reset 0.12. The 500/2000/5000-point
**score pickups** each add a flat **0.04** regardless of their point value,
and authored SSF nodes can add an arbitrary float. Crossing full triggers
the "It's Tricky" swap. [[360-meter-fill]]()

**Spending.** Two separate drains act on the meter: [[360-meter-drain]]()

- **Holding boost** drains it ≈ **0.045/s** — a full bar ≈ **22 s** of grounded
  boost. Boost also *requires* meter > 0 to do anything, and the meter **level
  selects the boost strength** (and the cap tier, and the engage sound) by the
  same thresholds: strong above ≈ 0.666, mid above ≈ 0.334.
- A **passive bleed** runs only while **airborne** (it is frozen on the ground),
  an order of magnitude slower (≈ 0.0001–0.008/s by rider stat) — just enough
  that a full bar can't be hoarded indefinitely in the air.

So in normal play the bar is spent by holding boost on the ground; airtime
barely touches it.

**Uber / infinite boost.** A separate **tier counter** climbs as the bar keeps
refilling (`430-music-and-announcer.md`); once it reaches **6**, both drains are
skipped and the meter is **pinned to 1.0 — boost becomes infinite**.
[[360-meter-uber]]()

**The engage sound.** Held boost plays a **one-shot on the engage frame** (not a
sustained loop): a MAIN-bank one-shot whose variant is chosen by the meter level
— slot **120** above ≈ 0.666, **121** above ≈ 0.334, else **122** — gated to the
local human. It fires once when boost activates and is **not** re-triggered while
held; the ~1.12 s clip simply plays out. [[360-meter-sound]]()

> [[360-meter]]() db:boost-meter — `boarder+0x1c` `boost_meter_energy` (0..1).

> [[360-meter-fill]]() db:boost-meter — `Boarder_AddBoostMeter` @0x0011b020:
> meter += inc·riderScalar, clamp [0,1]; riderScalar =
> statByte(rider record +0x1d)·0.3596/255 + 0.9788 (≈ 0.979..1.338); `inc` =
> `TrickScore_StyleToMeterFill` @0x00155428 = max(0, style·0.67869) — no gem
> multiplier, no flat bonuses — ÷(flips+1) in `TrickScore_UpdatePerFrame`
> @0x001569c8 (div.s @0x00156b80), undivided from
> `TrickScore_ResolveTrickString` @0x00156630 (jump launch / rail exit; 0 on
> its S+0x20==0 early-out). Held-trick accrual: `TrickScore_NamedTrickBegin`
> @0x00155f00 (style += 0.0425·stringPos; rate table 0x00371ea0 → S+0x2c) +
> `TrickScore_HeldTrickTick` @0x00156e98 (style += S+0x2c·0.00075/tick, from
> the boarder update @0x00117c98). Penalties: `TrickScore_FinalizeTrick` @0x00156df8
> always returns −0.09999 (wipeouts @0x00108e2c/0x001092a8/0x0010ac58/
> 0x00126674 and body bumps @0x0012436c/0x00124384); light bump −0.02
> @0x00124e18; placement reset −0.12 via @0x00155ac0. Score pickups flat
> +0.04 via `TrickScore_ScorePickupCollect` @0x00155b28 (SSF MainType 6);
> MainType 15 passes an authored float. Crossing <0.85 → ≥1.0 calls
> `Music_OnBoostMeterFull` @0x002196b8.

> [[360-meter-drain]]() db:boost-meter — active: `Boarder_HeldBoostChargeUpdate`
> @0x0011d040 does meter −= 0.00075/tick (0x3a44a5c3 ≈ 0.045/s) unless uber-tier;
> requires meter>0; sets strength +0x130 = 0.75/0.65/0.55 by thresholds
> 0.666/0.3336. passive: `Boarder_DrainBoostMeter` @0x0011b200 — uber→pin 1.0,
> grounded (+0x418≥0)→frozen, airborne→ −f(rider +0x1b) ≈ 0.0001–0.0085/s.

> [[360-meter-uber]]() db:boost-meter — uber check @0x0011f438 returns
> (boarder+0x58a8 ≥ 6); the tier counter climbs via `MusicTricky_TierEnterDispatch`
> @0x0021c598.

> [[360-meter-sound]]() db:boost-sound — `Boost_PlayMeterSfx` @0x002197a0; its one
> caller @0x0011d0c0 is gated on +0x130==0, i.e. the engage edge only (not
> per-frame); MAIN/`zbxsfx` slots 120/121/122 by the meter thresholds;
> local-human gated; shares the gem/pad one-shot ring template @0x002fc648.

## Pad boosts

Course-placed pads act through the effect-logic dispatch
(`150-logic.md`): touching a **speed pad** raises the rider's pad-boost
request, touching a **trick pad** arms the trick-boost window, and each takes
the **max** with whatever is already running, so pads do not stack.

The authored number on both is a **duration in seconds, never a strength**.
Each field counts itself down by 1/60 every tick and clamps at zero, and every
consumer tests it only for *greater than zero* — the raised speed cap it
selects is a fixed constant, not a function of the value. So a 3.0 pad is a
shorter boost than a 5.0 pad, not a weaker one, and the 10.0/15.0 authored on
trick pads are ten and fifteen seconds. On one example level the values are 3.0
and 5.0 for speed pads and 10.0 and 15.0 for trick pads. [measured]
[[360-pads]]() [[360-pads-duration]]()

The speed-pad request enables the raised cap and feeds the cruise drive's
boost gate — there is **no direct velocity write** on the pad itself, so a
pad cannot fling a stationary rider; it lets a moving one run faster. The
trick-pad window decays in real time (1/60 per tick) and its one traced
consumer scales the **rail**-control spin rates (`350-rails.md` owns the
factor) — a trick pad makes **rail** spins come out faster. The window is
**cleared on going airborne**, so that scaling is rail-only: in the air a
boost changes **only the speed cap** (`340-jump-air-landing.md`), not the
rotation rate. No upward launch from trick pads was found. [[360-pads-rt]]()

The visible gold speed pads and red/green trick pads are **one-shot pickups**:
their contact chain runs the boost request, a sparkle burst, and then the same
dead-node tombstone that despawns a gem (`390-pickups-and-race.md`) — the pad
is neither drawn nor touchable for the rest of the run, and a race restart
re-applies the recorded tombstones. [[360-pads-oneshot]]()

> [[360-pads-oneshot]]() GARI `SSFLogic.json` slots 0–3 → headers 1/3/5/7 =
> `[T17|T18][T2×9][T0/Sub5 DeadNode mode 2]` on `Mdl_SpeedBoost_Gold_*` /
> `Mdl_TrickBoost_RedGreen_*` (persistent slot = `T0/Sub10` UVScroll); the
> tombstone ctor `0x0013af40` clears static-draw 0x02 / PlayerCollision 0x20
> of `entity+0xe8` — `[[230-deadnode-modes]]()`, map:"Instance runtime status
> word (`entity+0xe8`)".

**Both pad opcodes have been reproduced from an authored level.** MainType-17
and MainType-18 nodes packed onto a Garibaldi-slot course write their authored
5.0 into the two request fields, and the passes that land it carry their own
proof: the speed request read by the *next* cell down the course is the first
cell's 5.0 minus exactly the elapsed time between the two contacts, to three
figures, and the rider covers 2.23 m between 20 Hz samples across the pads
against 1.62 m everywhere else on the same pass — the raised cap, measured
without reference to the field at all. [measured] [[360-pads-authored]]()

What is **not** reliable is landing it: **3 of 42** recorded passes wrote. The
shape of the failures is more informative than the rate. Across all 42 the two
pads — different props, ~90 m and ~3 s apart on the course, approached at
independently varying distances — **never once disagreed**: 3 passes where both
wrote, 39 where neither did, no pass where one did and the other did not. Two
independent fields, two dispatcher branches, one outcome per pass.

That rules out everything local to a cell. Proximity is eliminated directly as
well (a pass came within 0.08 m of the trick pad and wrote nothing, while one
1.15 m away in the very next pass wrote), and so are chain position, payload and
sample rate. It also rules out the tempting explanation that an opponent's
contact ran the chain instead: an instance has one live-node slot and an event
carries a full field of riders (`395-ai-riders.md`), so that does happen — but
in the batch where it is visible the *speed* pad's slot filled at the rider's own
nearest sample, to within 0.2 s, and still wrote nothing.

What is left gates both opcodes at once. The one step they share is the boarder
they are **handed** — the effect thread's owner — rather than the rider they
touched, and no constructor on the collision-spawn path assigns that field.

That owner is **not null**, which was the leading guess and is eliminated by
measurement rather than by argument. A null one would send the store to absolute
`0x134`, in kernel-side low memory where nothing else writes floats — the one
candidate that leaves physical evidence — and those words are read directly
across three passes, on the failures as much as the successes, and never leave
zero. So the field holds a real pointer that is not always the local rider.
[[360-pads-ownership]]()

**The owner word has now been read, and it is the gate.** A cell carrying a
speed pad, a trick pad and a course reset in one chain on one prop — three
opcodes that reach the rider through the identical instruction, so they share a
thread and therefore share the one owner word each of them re-reads — was ridden
three times, with the thread found in the heap by the back-pointer it holds to
its own host. The correlation is exact: on both passes where the pads wrote their
5.0 and the reset moved the rider, the owner held **the local rider's boarder
address exactly**; on the pass where neither happened, the blocks carrying that
instance held two different boarder-shaped pointers and neither was the local
rider. Nothing else about the pass differed. [measured] [[360-pads-owner-read]]()

Which also **corrects the "constant within a pass" reading** that the 42-pass
corpus supported. In one of these three passes the two long-standing pad props
wrote nothing while the pads on this third prop wrote 4.983 — the first split
between pad props ever recorded inside a single pass. The rate was never a
property of the pass. It is per **contact**: each contact spawns its own thread
with its own owner, and every opcode in that chain acts on whoever that thread
was given, so both pads on one prop always agree and two props need not.
[measured] [[360-pads-owner-read]]()

**And the mechanism now survives an intervention rather than only a
correlation.** Ridden in *showoff*, which puts a single rider on the mountain,
the same fixture wrote on every pad it crossed in one pass: the speed pad read
5.000, the trick pad read its own 5.000 alongside the speed request decayed to
2.017, and the third prop read 4.983 in both fields. Against 3 passes in 42 in a
six-rider race. Removing the other boarders removes the failure, which is what
the owner account predicts and no account local to a prop can explain.
[measured] [[360-pads-solo]]()

So a pad's reliability is a property of **how crowded the mountain is**, not of
the pad. In a race it services whichever rider its contact thread was handed and
the local human is one of six candidates; alone, there is only one boarder to
hand it. The remaining question is what picks the owner when there is more than
one to pick from. [open]

Crossing a pad also plays a **fixed per-type feedback chime** (not tier- or
meter-dependent), gated to the local human player: a speed pad plays global
**MAIN**-bank slot **115**, a trick pad slot **114** — distinct from the gem
chimes (116/117/118, `390-pickups-and-race.md`) and the held-boost meter sound
(120/121/122). [measured] [[360-pad-sound]]()

## Scripted boost nodes

A third boost form is the **scripted boost node**, an effect-graph node placed
on a prop's collision circumstance. Unlike the pads it **writes the rider's
velocity directly**, so it can launch a rider who is barely moving — this is the
only boost path in the game that can. Despite the name it is the engine's
general **directional velocity driver**: it drives Megaplex's conveyors, exhaust
vents and air shafts, Merqury City's sand boosts, and Untracked's wind volumes,
which are boosts in everything but name. [[360-node]]()

**What it does.** Each tick, for every rider currently inside the node's
volume, the node drives the rider's speed *along a fixed authored axis* toward
a target, as a first-order lag:

```
along   = dot(velocity, dir)          # dir is unit length, world space
deficit = target - along
if deficit > 0:                       # add-only; a boost never brakes
    velocity += dir * deficit * rate / 60
```

so the rider's speed along `dir` approaches `target` exponentially with time
constant `1/rate` seconds, and a rider already moving faster than `target`
along that axis is left alone. The push is applied to the same carried velocity
the rest of the motion system integrates, not to a separate accumulator, so it
composes with gravity and contact normally. [[360-node-apply]]()

**The push is observed, not only disassembled.** An authored boost carrying the
exhaust-vent shape — mode 1, `U1` 0.0, `rate` 5.0, `target` 25 m/s, `dir`
(0, 0, 1) — was packed onto a Garibaldi-slot course inside a 120 × 40 × 40 m
trigger box, and it took the rider from descending at 7.5 m/s to climbing at
7.2–13.7 m/s, the fastest the rider rose anywhere on that course in every pass.
The box size is the part worth copying: rider selection is a containment test
re-run every tick, so a thin host offers one or two ticks of push and reads as a
node that built and did nothing. [measured] [[360-lapboost-live]]()

**How far it actually throws is a property of the host, not of the payload**, and
a second measurement pins the number at the size retail ships. Megaplex's own
exhaust-vent host is **3.60 × 3.12 × 3.29 m** — about ten ticks of a crossing,
an order of magnitude smaller than the box above. Packed onto a Garibaldi-slot
course at that size with the vent's own tuning (mode 1, `U1` 0.0, `rate` 3.0,
`target` 100 m/s, straight up), it takes a rider crossing at course speed to
**13.5–21.7 m/s of climb, gaining 11–14 m** of altitude, the spread tracking how
squarely the crossing lands. So the throw follows the **dwell**, and a port that
gives a boost a volume of its own choosing has changed the node however exactly
it reproduces the lag. [measured] [[360-node-throw]]()

The same passes bound it from above, and the bound is not the node's: peak
carried speed was **33.47 m/s in every pass**, which is the strong cap constant
to three figures. A scripted boost writes neither pad-request field, so it
selects no tier itself — that reading is the airborne re-arm, and the rider is
clamped to it the moment they are grounded again. A vent throws a rider high; it
does not make them fast. [measured] [[360-node-throw]]()

**The authored fields.** Four scalars plus a vector, in `Effects.json` order:

| Field | Meaning |
|---|---|
| `Mode` | lifetime rule — see below |
| `U1` | duration in **seconds** (× 60 → ticks) |
| `U2` | `rate` — the approach rate, per second |
| `BoostAmount` | `target` — the speed target along `dir`, in **m/s** |
| `BoostDir` | `dir` — unit-length push axis, **world space, not instance-local** |

`BoostAmount` is authored in m/s and scaled ×100 at load because engine units
are cm/s; a port working in m/s uses the authored number unchanged. Authored
targets run 45–200 m/s. At the top of that range the target sits far above any
reachable speed, so it saturates and **`rate` becomes the real tuning knob** —
it sets how violently the volume grabs the rider. Megaplex's conveyors use
`rate` 10.0 (a near-instant slam to speed), its exhaust vents 3.0, and the
gentlest air-shaft slots 0.1. Untracked's wind volumes are the counter-case: at
`target` 45 m/s with `rate` 4.0, the target is close enough to airborne speeds
to act as a genuine terminal speed rather than a saturating constant.
[measured] [[360-node-fields]]()

Because `dir` is world space and never rotated by the host instance's
transform, two placements of the same model carry different vectors — the six
directional slots on Megaplex's twin air shafts are authored individually.
[measured] [[360-node-fields]]()

**Mode.** The mode selects what the duration means and when the node retires
itself. The node keeps a countdown, seeded from `U1` at construction **only when
mode is 1**, and re-armed from the stored duration whenever the effect chain
activates the node:

| Mode | Countdown is | Lifetime |
|---:|---|---|
| 0 | a **cooldown** — while it runs the push is suppressed entirely | never self-retires |
| 1 | an **active window** | retires once the window expires *and* no rider is inside |
| ≥2 | never seeded, so it is 0 | retires on its first tick — inert |

**Every scripted boost in the retail corpus is mode 1** — 45 of 45, across all
three courses that author any — so modes 0 and 2+ are read from the lifetime
logic rather than observed in data. A node also stays alive for as
long as a rider is inside it regardless of its timer, so the window never cuts
a push off mid-contact. With `U1` = 0 — the common authoring, including every
exhaust vent — the node lives exactly as long as contact does. [[360-node-mode]]()

Note the window governs the **node's** lifetime, not the push: the push only
ever applies to riders currently intersecting the volume, so a non-zero `U1`
keeps the node armed between contacts rather than pushing a departed rider.
[[360-node-mode]]()

**The speed cap does not bound this in the air.** The shared cap clamp scales
the whole velocity vector down when its magnitude exceeds the cap, but the
airborne motion state branches past that clamp entirely
(`340-jump-air-landing.md`). So a scripted boost is bounded by the ≈27.9 / 33.5
m/s cap only while the rider is grounded, and once the push has put the rider
in the air it is not bounded at all — which is how a vertical vent throws a
rider far above normal course speed. [[360-node-cap]]()

**Worked example — Megaplex exhaust vents.** `Mdl_Exaust_BOOST_Volume_*` share
one slot: mode 1, `U1` 0.0, `rate` 3.0, `target` 100 m/s, `dir` (0, 0, +1) —
straight up in the world Z-up frame (`002-conventions.md`). Standing in the
vent with no vertical speed, the first tick adds
`(100 − 0) × 3 / 60` = **5 m/s** upward, the next ≈4.75 m/s, and so on; contact
lasts a handful of ticks, and the rider leaves the ground well before the
target matters. Two further vents push along (−0.194, +0.439, +0.877) and
(−0.283, −0.387, +0.877) — the same ≈61° climb, splayed apart in plan.
[measured] [[360-node-corpus]]()

**Worked example — Untracked's wind ramp.** The clearest authored use of the
node is a chain of seven wind volumes, `Mdl_ForceWind_5000`–`5006`, all sharing
`target` 45 m/s and `U1` 0.0. Every direction has **exactly zero Y**, so the
whole chain pushes within one vertical plane, and the pitch walks smoothly down
that chain — ≈53° above horizontal at `5000`–`5002`, then 51°, 39°, 27°, and
≈11° at `5006`. The vectors are normalized small-integer ratios ((3,0,4),
(4,0,5), (5,0,4), (2,0,1), (5,0,1)), so the fan was authored as whole numbers
and normalized at build. `rate` is 4.0 throughout except the shallowest, which
eases to 3.0. Passing along the chain therefore bends a rider's trajectory
progressively rather than kicking it once — a curved updraft assembled out of
seven straight pushes. [measured] [[360-node-corpus]]()

That directional node is the common one, but it is not alone: the effect
registry carries **four** boost-flavored property sub-types and the retail
corpus authors all four. Three of them appear on a single course only — a
**lap** boost and a **tube-end** boost, both sitting on that course's
finish-tube markers, and a **Z** boost — so any census narrower than the full
corpus will report them as unauthored.

### The Z boost is an elevator, not a push

The Z boost earns its own class. Two of its three placements sit on the course's
**twin air shafts**, on slots that also run a persistent particle emitter, so
the prop blows a visible plume *and* takes the rider as they cross it.

It reuses the directional node's push verbatim — same target, same approach
rate, same axis, same first-order lag — and then wraps it in three behaviours
that change what the thing *is*: [[360-zboost]]()

- **It cancels horizontal motion.** After running the push it zeroes the
  rider's X and Y velocity outright, on both the pushed and the
  already-fast-enough path. The rider stops travelling and only rises. This is
  what separates it from an authored (0, 0, 1) directional boost, which leaves
  the rider's existing momentum intact.
- **It aims at an altitude, not a speed.** The node carries a **target world Z**
  and only acts on riders currently below it; a rider at or above the target is
  dropped from the volume immediately. The speed field is just how fast the lift
  gets there.
- **It arrives.** A **snap tolerance** closes out the ride: once the remaining
  gap to the target altitude falls under it, the rider's Z is written to the
  target exactly and the lift ends, so a rider is never left drifting the last
  few centimetres.

The push axis is authored (0, 0, 1) in all three placements, which settles the
open question its name posed: the direction is straight **up** in the world Z-up
frame (`002-conventions.md`), and there is no sign ambiguity to resolve.
[measured] [[360-zboost-corpus]]()

The two tunings are opposite ends of the same mechanism. The air shafts lift at
19–20 m/s toward a target ≈15 m above the shaft's own base, with the snap
tolerance set to **zero** so they never snap and always ride the lag all the way
in. The finish-tube marker sets the tolerance to a value larger than any gap it
will ever see, which inverts the rule: it snaps on the first tick of contact,
placing the rider at the target altitude outright. One field spans "always ease"
to "always teleport". [measured] [[360-zboost-corpus]]()

Lifetime needs no mode or window — unlike the directional node, presence *is*
the rule. The node retires itself on the first tick that lifts nobody.
[[360-zboost]]()

### The two finish-tube nodes

The remaining pair sit together on Megaplex's finish tube, one placement each,
and they are not two nodes so much as **two halves of one mechanism**. The lap
boost decides *which* of three launches a rider has earned and records that
per rider; the tube-end boost reads that decision and performs the launch. The
handoff is a small global table indexed by rider, written by one and read by the
other — so neither makes sense read alone, which is why both looked opaque until
they were read together. [[360-tube-pair]]()

**The lap boost** carries the same three fields at the same offsets as every
node above — an approach rate, a target speed, and a direction — but never runs
the shared push. What makes it a *lap* boost is its entry test, and the effect
of that test is simple enough to state in one line:

> **A rider with passes left is lifted. A rider whose crossing was the last is
> not.**

That is the behaviour a player meets: on Megaplex's four passes the tube throws
you up the shaft at the first three crossings — the counter, decremented at the
line, still reads 3, 2, then 1 — and at the fourth, where it reads 0, it lets
you ride straight through to the finish
(`390-pickups-and-race.md`). [measured] [[360-lapboost-gate]]()

The implementation is oblique. Each rider carries a **laps-remaining** counter,
and the node snapshots it per rider when it is built. The snapshot is then
decremented once per tick while it has not been passed, and a rider is dropped
the moment it goes negative. With passes left, the first decrement immediately puts
the snapshot below the live counter, where it freezes and the rider is serviced
for as long as they stay inside. At the last crossing the counter is already 0, so
that same first decrement takes the snapshot to −1 and the rider is dropped on
the spot. The countdown is really a one-shot test of whether the counter is
nonzero, spelled as a countdown. [[360-lapboost-gate]]()

Laps are the only thing that decides service. The node's other test — the
rider's height above the host's own floor — does not drop anybody; it picks
which stage a serviced rider is assigned, below. [[360-lapboost]]()

**Both halves of that are now measured, and the practical consequence is
blunt: outside Megaplex a lap boost lifts nobody.** An authored lap boost was
packed onto a Garibaldi-slot course inside a box deep enough to hold a rider for
~90 ticks, beside a directional boost in an identical box carrying this node's
own authored lift — rate 5, target 25 m/s, axis (0, 0, 1). The lap boost's node
was built and held the instance's effect slot in every pass, reading sub-type 15,
and the rider was never lifted; the directional boost beside it took the rider
from descending at 7.5 m/s to climbing at 7.2–13.7 m/s in every pass. The run
read `laps_remaining` as **0 for its whole length**, which is the gate closing
exactly as the disassembly describes. Since that counter is seeded from the
course — 4 on Megaplex, 0 everywhere else (`390-pickups-and-race.md`) — the node is
inert by construction anywhere else, and a port or an authored level wanting this
behaviour has to either ride the Megaplex slot or use the directional node.
[measured] [[360-lapboost-live]]()

A serviced rider is then assigned a **stage**, 0 to 2, from where they are in
the host's own extent — and that stage is the whole point of the node, because
it is what the tube-end boost consumes:

- below 10 m above the host's floor reference — **stage 0**;
- otherwise, which side of the host's midpoint the rider is on, measured along
  the host's local X axis — the near side is **stage 1**, the far side
  **stage 2**.

So the lap boost is a *classifier*, not a push: laps decide whether a rider is
serviced at all, and position decides which launch they get.
[[360-lapboost-stage]]()

Alongside that it also runs a scripted ride — it writes the rider's **position
as well as velocity** and drives two dedicated rider motion states while damping
velocity to 95% per tick. That ride is separate from the stage decision above
and is not decoded [open]. [[360-lapboost]]()

**The tube-end boost** is the only sub-type that is a genuine *subclass*: its
constructor calls the directional node's constructor first and its per-tick
update **is** the directional node's, so it inherits that node's whole payload,
its mode/window lifetime, and its rider selection unchanged. It then overrides
only the apply, and extends the payload with **three unit vectors paired with
three speeds** — an authored three-stage launch. [[360-tubeend]]()

The retail placement is the tell: it authors the inherited direction as
**(0, 0, 0)**, which makes the inherited push contribute exactly nothing. All of
the behaviour is in the three added pairs — and **the stage the lap boost
recorded picks which pair**. On a rider's first tick in the volume the node
copies that stage's direction into a per-rider slot and normalises it; from then
on it runs the ordinary shared push, toward that stage's speed along that stage's
axis. Nothing about the launch is novel — it is the directional boost with its
axis and target chosen per rider rather than authored per volume.
[[360-tubeend]]()

The three pairs are therefore three tiers of the same finish launch, and their
authored values read that way: the stage-0 pair is the shallowest and slowest at
27 m/s, and stages 1 and 2 both launch at 35 m/s on slightly different lines.
[measured] [[360-tubeend]]()

### All three compose into one finish

Read separately the three MEGAPLE-only sub-types look like three unrelated
oddities. Their placements say otherwise: they are **one sequence**, and the
course's geometry is what makes it legible.

The three markers sit on a **tall vertical shaft**. The lap boost and the Z boost
share the bottom of it, 30 m apart at the foot of the course; the tube-end boost
sits **≈440 m above the Z boost's marker**, near the top. Given that, each node's
authoring stops looking arbitrary: [measured] [[360-tube-sequence]]()

1. **Lap boost**, at the bottom — gates on having completed a lap, then
   classifies the rider into stage 0, 1 or 2 by where they stand.
2. **Z boost**, at the bottom — cancels horizontal motion and finishes the climb.
   This is the placement whose snap tolerance is set larger than any gap it can
   encounter, so it does not ease the rider up at all: it places them at the top
   on the first tick they reach it.
3. **Tube-end boost**, at the top — launches along the recorded stage's axis at
   that stage's speed, forward and slightly upward, out of the shaft.

That also explains the Z boost's two very different tunings from a single field.
On the air shafts, which are ordinary course furniture, the tolerance is zero and
the lift eases in over its full travel. Here it is effectively infinite and the
same node becomes a placement primitive. One number spans "ride the lift" and
"arrive instantly". [[360-tube-sequence]]()

The two nodes at the bottom **split the ascent**. A live capture taken with
riders in the shaft shows them climbing at 18–20 m/s about 12 m from the lap
marker, still 40 m below the Z boost and not yet snapped — so the lap boost's
scripted ride performs the initial lift itself rather than merely dressing one.
The Z boost then completes the climb the moment the rider reaches it, snapping
away the remaining ~420 m. The ride is transport, not presentation.
[measured] [[360-tube-observed]]()

That capture also settles the motion states: riders under the ride read state
**1**, not the 5 or 6 the ride's first two branches test. Those two are
special-case early exits — the ordinary path is the fall-through, and that is
where the position write lives. It opens by taking the 3D midpoint of the same
corner pair the stage test uses — and that pair is now **confirmed to be the
host's bounding box**: read live, its midpoint reproduces the host's own origin
exactly, and its extent is a 19 × 18 × 31 m upright box, which is the shaft. So
both consumers are reading a box, one for its centre and one for which side of
it the rider is on. What the fall-through then does with that centre is still
untraced [open]. [[360-tube-box]]()

That also puts a number on the height gate: the box's floor sets it, so a rider
must be above **−45,894.5** in world Z before the stage test will return anything
other than 0. [measured] [[360-tube-box]]()

**The two lifts are tuned to hand off.** The lap boost and the Z boost author the
*same* target — 25 m/s straight up — and differ only in approach rate, 5.0 for
the ride and 4.0 for the elevator. A second capture, taken with riders spread
through the shaft, shows the seam working: riders still under the ride climb at
23.0–23.3 m/s with horizontal velocity at essentially zero, converging on that
shared 25. The ascent is short — a rider only climbs ~28 m under power before
reaching the Z boost, which then snaps away the remaining ~420 m — which is why
the whole trip reads as instant in play. [measured] [[360-tube-observed]]()

**Stage 0 is what a real run uses, and structurally so.** The node keeps a
per-rider latch beside the lap snapshots: a rider whose latch is clear is
classified and the latch set, and one whose latch is already set skips
classification entirely and goes straight to the ride. **The stage is therefore
decided once, on entry, and never revised.** Since a rider enters the shaft at
its floor — necessarily below a gate set 10 m up — the answer on entry is always
stage 0. Riders caught at the top launch at 26.4–26.7 m/s against stage 0's
authored 27, the shared lag converging on its target. [measured]
[[360-tube-latch]]()

Reaching stage 1 or 2 would take entering the box *above* Z −45,894.5 rather than
rising through it, which the normal line does not do. Whether any line does, or
whether the two upper stages are vestigial, is not established [open].
[[360-tube-latch]]()

> [[360-lapboost-gate]]() db:boost — three PINE captures of the same PAL session
> decide this. Mid-race, in the shaft: every rider reads boarder+0x114 = 3 against
> a node+0x58 snapshot of 2 — snapshot < counter, frozen, all six lifted.
> The final crossing, riding through: five riders read **boarder+0x114 = 0 with
> snapshot −1** (dropped), carrying +Y velocity 1369–1975 units/s and Z between
> −52 and −425, i.e. travelling horizontally through the volume with no lift; the
> sixth reads counter 1 / snapshot 0, frozen, and is still serviced — one
> crossing behind, on its third arrival of the four. That the field reads **0 at
> the final crossing and 3 earlier** is what identifies it as
> laps-*remaining* rather than laps-completed — the constructor's `lhu`
> boarder+0x114 @0x00140a1c and the tick's `lw` @0x00140c88 read the same word.
> Gate arithmetic: snapshot seeds equal to the counter, so the `slt` @0x00140c98
> fails on tick 1 and the `sh` @0x00140ca8 always decrements once; with counter
> ≥ 1 that lands below it and freezes, with counter 0 it lands at −1 and the
> `bltz` @0x00140cb0 drops the rider.

> [[360-tube-latch]]() db:boost — live read of `cLapBoostNode` @0x0085dee0. Its
> payload reads back rate 5.0, target 2500.0 units (25.0 m/s) and direction
> (0, 0, 1), matching `Mdl_Endboost_Lap_1000`'s authored `U0`/`U1`/`U4` — so the
> node identity and the +0x40/+0x50/+0x54 offsets are confirmed against live
> memory, not just the constructor. Per-rider arrays: lap snapshots at node+0x58,
> latches at node+0x64, both u16 by rider index. All six riders read lap 3 against
> snapshot 2, i.e. snapshot < lap, so the countdown is frozen and every rider is
> serviced — the all-zero stage table is not a lock-out. Latch reads 1 for the
> three riders still in the shaft and 0 for the three already launched at the top.
> `lh`/`bne` @0x00140cbc–0x00140cc0 branches a set latch straight to the ride
> @0x00140e48, jumping the whole classification block, which is what makes the
> stage a once-per-entry decision.

> [[360-tube-box]]() db:boost — live read from the same PINE snapshot. The
> `cLapBoostNode` instance is found by scanning EE RAM for its vtable 0x0036e5f8
> at node+0x08 (one live instance, node @0x0085dee0); node+0x28 gives the bound
> entity @0x01157e50, whose 4×4 sits at +0x00..+0x30 — matching the
> `ldc2 0/16/32/48(a1)` loads @0x00140dac–0x00140db8. On that entity:
> A (+0xcc) = (−1068.7, −7298.6, −46894.5), B (+0xd8) = (821.4, −5543.5, −43814.2).
> Their midpoint (−123.65, −6421.02, −45354.35) reproduces the entity's own
> translation row (−123.7, −6421.0, −45354.4) to 0.05 units, and the extent is
> 1890 × 1755 × 3080 units = 18.9 × 17.6 × 30.8 m — an upright box the size of the
> shaft. The pair is a bounding box, not merely shaped like one. Height gate
> A.z + 1000.0 therefore sits at Z = −45894.5.

> [[360-tube-observed]]() db:boost — PINE capture of a paused PAL session
> (`SLES-50545`, PCSX2 2.6.3) with six riders in the Megaplex shaft. Rider table
> walked as `GetRider`: `*(0x00338E58)` → +0x730 → +0x1c, count at +0x88, riders
> at +0xC4+i×4. Riders 0–2 on lap 3 at Z ≈ −46,220 to −46,363 with velocity Z
> +1789 to +1967 units/s (17.9–19.7 m/s up); riders 3–5 on lap 4 at Z ≈ −46,080
> to −46,346. Lap marker sits 1,186 units (≈12 m) away, Z marker 4,034 (≈40 m);
> no rider is at Z ≈ 0, so the Z snap has not fired. All six read
> boarder+0x424 == 1 or 2, never 5 or 6. Stage table 0x0031E538 reads all zero,
> consistent with the height gate failing — every rider is *below* the lap
> marker while the gate needs 1000 units above it. Fall-through path
> @0x00140eec–0x00140f40 loads inst+0xcc and inst+0xd8 as two 3-component points,
> sums them componentwise and scales by 0.5 (0x3F000000) — the same corner pair
> the stage test reads, now used as a 3D centre.
> Second capture, riders spread through the shaft: riders 3–5 at Z −45,168 /
> −44,653 / −44,227 carry velocity (5, 22, 2299), (1, 8, 2320), (1, 3, 2326) —
> horizontal 0.01–0.22 m/s against vertical 23.0–23.3 m/s, i.e. the horizontal
> kill and the approach toward the shared 25.0 target, and 18–28 m short of the
> Z marker so its snap has not yet fired. Riders 0–2 sit at Z +1482 / +1958 /
> +1992, level with `Mdl_Endboost_End_1000` at +1772.2, at |v| 26.39 / 26.73 /
> 26.59 m/s against stage 0's authored 27.0. Stage table reads all zero in both
> captures, consistent with the height gate failing for a rider on the shaft
> floor. Alignment of those launch velocities to the stage-0 axis is 0.75–0.80
> (37–40°), as expected for an add-only push composed with carried momentum —
> the speed, not the heading, is the discriminator.

> [[360-tube-sequence]]() db:boost — placement altitudes from MEGAPLE
> `Instances.json`, world Z per `002-conventions.md`: `Mdl_Endboost_Lap_1000`
> −45354.3, `Mdl_Endboost_Z_1000` −42373.9, `Mdl_Endboost_End_1000` +1772.2,
> against a course instance-Z range of −47679 to +13735 — so the first two sit at
> the foot of the course, 2,980 units ≈ 30 m apart, and the third is 44,146 units
> ≈ 441 m above the Z marker (47,126 ≈ 471 m above the lap marker). The Z
> boost's target altitude is 0.0 with tolerance 400000.0, and a rider entering at
> ≈ −42000 gives a gap far under that tolerance, so the snap branch @0x00141e58
> fires on the first tick and places the rider at 0.0 — level with the tube-end
> marker at +1772.2. Stage directions are dominantly +Y with Z components
> 0.25–0.37, i.e. forward and slightly up out of the shaft. The undecoded ride is
> `LapBoostNode_Update` @0x00140e48–0x001411b8; the presentation reading of it is
> inference from the Z boost already performing the transport, not traced [open].

> [[360-zboost]]() db:boost — RTTI `cZBoostNode` @0x0036f000 (a `cZBoostNodeState`
> twin exists @0x0036f2e0); name string @0x0036c988, built at
> `EffectRegistry_BuildEffectNode`+0x82c; ctor
> `ZBoostNode_ConstructFromEffectPayload` @0x00141af8 (256-byte node, vtable
> @0x0036e328); tick `ZBoostNode_Update` @0x00141ce0 (vtable slot 2).
> Ctor field map: payload +0x0c → node+0x54 rate; +0x10 → node+0x50 target ×100
> (0x42C80000); +0x14/+0x18/+0x1c → node+0x40 direction vec4 w=0 via `lq`/`sq`;
> +0x20 → node+0x5c target Z; +0x24 → node+0x60 snap tolerance — node+0x40/+0x50/
> +0x54 are laid out identically to `cBoostNode`, and the push block @0x00141ea4
> is instruction-for-instruction `BoostNode_ApplyToBoarder` including the
> 1/60 literal 0x3C888889 and the `VADD` into boarder+0x150.
> Tick shape: pass 1 marks presence into the byte array at node+0x64 indexed by
> boarder+0x460, over the same contact list / type-1007 / `IntersectLineQuery`
> gate as sub-7. Pass 2 per flagged rider: `c.olt.s` @0x00141e38 drops riders
> whose Z (boarder+0x148, the z lane of the +0x140 position vec4) is not below
> node+0x5c; `bc1fl` @0x00141e58 snaps boarder+0x148 = node+0x5c when the gap is
> under node+0x60; raw motion state 5 calls 0x0011caf0 with position+velocity
> first; both exits then `swc1 f3` (0.0) into boarder+0x150 and +0x154, zeroing
> velocity X and Y. Alive flag @0x00141f30 is set only by a lifted rider, and
> alive == 0 self-ends via vtable+0xB4 arg 1 — no mode or countdown is read.

> [[360-zboost-corpus]]() db:boost — all three MEGAPLE placements, direction
> (0, 0, 1) in every one: slot:0092 `Mdl_twinAirShaft_BOOST_0` and slot:0093
> `Mdl_twinAirShaft_BOOST_5` (rate 4.0, target 20.0 / 19.0, target Z −12000,
> tolerance 0.0) against host Z of −13487.9 / −13532.8, i.e. a lift of ≈1500
> engine units ≈ 15 m; slot:0125 `Mdl_Endboost_Z_1000` (rate 4.0, target 25.0,
> target Z 0.0, tolerance 400000.0). Payload words are **seven f32** — the ctor
> loads every one with `lwc1`, which is what establishes the float typing carried
> in the `230-level-ssf.md` row. A parser sees the direction's X and Y as u32
> because they read 0.0 in all three placements, so the data alone cannot
> disambiguate them.

> [[360-tube-pair]]() db:boost — the handoff is the word array at **0x0031E538**,
> indexed by the rider index at boarder+0x460. `LapBoostNode_Update` writes it
> @0x00140e34; `TubeEndBoostNode_ApplyToBoarder` reads it @0x001418e4 (to pick the
> direction) and again @0x00141944 (to pick the speed). Those, plus a reset in
> sub_00141a90 @0x00141ad8 and sub_00149b08 @0x00149b68, are its only references
> in the ELF — so the table exists solely to carry this one value between these
> two nodes.

> [[360-lapboost-stage]]() db:boost — stage selection @0x00140cc8–0x00140e34, all on the
> host instance reached through node+0x28: A = (inst+0xcc, inst+0xd0, inst+0xd4),
> B = (inst+0xd8, inst+0xdc). Height gate @0x00140cd4 compares boarder+0x148 − A.z
> against 1000.0 (0x447A0000); failing it takes the `bc1f` to 0x00140e34 with
> stage 0 in the delay slot. Otherwise stage 2 is seeded @0x00140cf4 and the
> geometry runs: `VSUB` @0x00140d3c gives B−A, `VMULx` by 0.5 (0x3F000000) and
> `VADD` @0x00140d74 give the midpoint; the instance matrix rows at +0x00..+0x30
> transform (1, 0, 0) @0x00140dc0–0x00140dcc into the host's world X axis;
> `VSUB` @0x00140de8 gives rider.xy − midpoint and the dot @0x00140e00–0x00140e14
> is compared against 0.0 by `c.olt.s` @0x00140e20, with `bc1tl` @0x00140e28
> selecting stage 1 in its delay slot. Only three stage values are ever
> assigned — 0, 2 and 1 at 0x00140cec, 0x00140cf4 and 0x00140e2c. A and B are the
> host's bounding-box corners, confirmed live ([[360-tube-box]]); the fields are
> unnamed in db.

> [[360-lapboost-live]]() Live evidence: `Trailmap/tools/autotest`, runs
> 20260806-081511, -081741 and -082007 (AUTOTEST2 cells `lap-boost` and
> `boost-up-lifts`). Both cells are effect-trigger boxes 120 × 40 × 40 m on the
> same fall line 90 m apart, so the pair differs only in which node the chain
> carries. The dispatch slot fired 3/3 on both; the rider's carried velocity
> (`boarder+0x150`, z lane) peaked at −7.32, −5.34 and −7.12 m/s across the lap
> boost's three passes against +7.23, +13.71 and +8.39 m/s across the directional
> boost's — i.e. the lap boost never interrupted the descent. `boarder+0x114`
> read 0 at every sample of every pass. The height test is not a second service
> gate: the `bc1f` at @0x00140cd4 falls to 0x00140e34 carrying stage 0 in its
> delay slot, so a rider under the line is classified rather than dropped.

> [[360-lapboost]]() db:boost — RTTI `cLapBoostNode` @0x0036f070 (`…State` twin
> @0x0036f290); name @0x0036c958, built at `EffectRegistry_BuildEffectNode`+0x718;
> ctor `LapBoostNode_ConstructFromEffectPayload` @0x00140950 (vtable @0x0036e5f8);
> tick `LapBoostNode_Update` @0x00140b98. Payload is **5 × f32**, every word
> `lwc1`: +0x0c → node+0x54 rate, +0x10 → node+0x50 target ×100, +0x14/+0x18/+0x1c
> → node+0x40 direction vec4 — same offsets as `cBoostNode`, so the two words a
> parser reads as `u32, u32` are again the direction's X and Y. Ctor loop @0x001409e4
> walks `GetRider` 0x00181560 and stores rider+0x114 (u16 lap) into node+0x58[i×2],
> zeroing node+0x64[i×2]. Lap gate @0x00140c88–0x00140cb0: `slt` snapshot vs
> current lap, `sh` decrement when not advanced, `bltz` lock-out. Height gate
> @0x00140cd4 compares boarder+0x148 − instance+0xd4 against 1000.0 (0x447A0000).
> State work: boarder+0x424 == 6 damps velocity ×0.95 (0x3F733333) @0x00140e58,
> == 5 takes the @0x00140e84 path; velocity written @0x00140e78, **position**
> (boarder+0x140) @0x00141050. No 0x3C888889, i.e. the shared lag is never run.
> Retail: MEGAPLE slot:0124 `Mdl_Endboost_Lap_1000`, rate 5.0, target 25.0,
> direction (0, 0, 1). Tube path from instance+0xcc..+0xdc undecoded [open].

> [[360-tubeend]]() db:boost — RTTI `cTubeEndBoostNode` @0x0036f020 (`…State`
> twin @0x0036f2c0); name @0x0036c9c8, built at
> `EffectRegistry_BuildEffectNode`+0xa70; ctor
> `TubeEndBoostNode_ConstructFromEffectPayload` @0x00141690, vtable @0x0036e408.
> Subclassing is literal: the ctor's first call is `jal 0x001404a0`
> (`BoostNode_ConstructFromEffectPayload`), and vtable slot 2 is 0x00140690 —
> the *same* `BoostNode_Update`. Only the apply differs: vtable+0xE4 holds
> `TubeEndBoostNode_ApplyToBoarder` @0x001418b0 where sub-7 holds 0x00140840.
> Added payload: +0x28/+0x34/+0x40 triples → node+0x110/+0x120/+0x130 (`lq`/`sq`
> vec4s), +0x4c/+0x50/+0x54 each ×100.0 → node+0x1a0/+0x1a4/+0x1a8. Ctor tail
> seeds 5 per-rider vec4 slots at node+0x140 with 0x501502F9 (~1e10). Apply, fully
> decoded: `stage` = 0x0031E538[boarder+0x460]; on a still-sentinel slot at
> node+0x140 + idx×16, `lq` node+0x110 + stage×16 into it @0x00141900 and normalise
> through the VU rsqrt/`VMULq` pair; then `along` = dot(boarder+0x150, slot),
> `deficit` = node+0x1A0 + stage×4 − along @0x00141988–0x0014198c, and on
> deficit > 0 the same lag as sub-7 (0x3C888889, `VADD`, `sdc2` boarder+0x150)
> @0x001419a0–0x001419e4; a byte at node+0x1AC + riderIndex is set @0x001419f4.
> Stage×16 and stage×4 line up exactly with the three authored vectors at
> +0x110/+0x120/+0x130 and the three speeds at +0x1A0/+0x1A4/+0x1A8. Retail: MEGAPLE
> slot:0126 `Mdl_Endboost_End_1000` — mode 1, window 0.0, rate 2.0, target 20.0,
> inherited direction **(0, 0, 0)**; vectors (0.1590, 0.9539, 0.2544),
> (0.2261, 0.9044, 0.3618), (0.0925, 0.9245, 0.3698), all unit to 1e-4; speeds
> 27.0, 35.0, 35.0. Stage selection undecoded [open].

> [[360-pads]]() db:course-boost — main type 17 →
> `Boarder_RequestBoostAmount` (+0x134 = max(old, value)); main type 18 →
> `Boarder_RequestBoostFlagAndWindow` (+0x138 = max, +0x13c = 1); GARI pads:
> speed slot 0 value 5.0, trick slot 1 value 15.0, lower tiers 3.0/10.0
> (doc:../research/extracted-data.md "Boost and scoring effects").

> [[360-pads-duration]]() Decay: `BoarderMotion_SharedUpdate` 0x0011791c–
> 0x00117948 (+0x134) and 0x0011794c–0x00117964 (+0x138), both `sub.s` of
> 0x3C888889 = 1/60 with a `c.ole.s`-guarded clamp to zero; no other writer of
> +0x134 in .text besides `Boarder_RequestBoostAmount`. Boolean use, not
> magnitude: 0x001179ac `c.olt.s f20, f0` then a cap of 0x4551338E (3347.22 raw
> = 33.47 m/s) where the default arm at 0x001179b0 is 0x452E4D6E (2788.84 raw =
> 27.89 m/s); `SurfaceMaterial_SpeedResponseHelper` 0x00109a50 likewise tests
> >0 and then clamps against a fixed ×5.5. The value never reaches either
> arithmetic.

> [[360-pads-authored]]() Live evidence: `Trailmap/tools/autotest`, runs
> 20260806-172756/-172947/-173137 (cells `speed-pad`, `trick-pad`), with an
> earlier single pass at -113832. `speed-pad` read 5.000/4.967 and `trick-pad`
> 5.000/4.933 — the shortfalls being one or two frames of decay past the write.
> Cross-cell arithmetic: on -173137 `speed-pad` filled its slot at 7.100 s and
> `trick-pad` at 10.000 s, and the speed request measured at `trick-pad` was
> 2.100 = 5.0 − 2.90 s. Packed graphs confirmed with `snowknife effects-export`
> off the built ISO: Effects 308–311 carry MainType 17/18 with
> `type17`/`type18` = 5.0 in both chain positions. Stores confirmed against the
> ELF as `swc1 f0, 308(a0)` and `lwc1 f0, 312(a0)`.

> [[360-pads-ownership]]() All 42 AUTOTEST2 passes in
> `Trailmap/temp/autotest` carrying both cells, 20260806-100330 through
> -174146. Wrote: -113832, -172756, -173137. Split (one cell only): none.
> Approach at the writing passes 0.41/0.59/0.64 m on `speed-pad`; non-writing
> passes include 0.08 m on `trick-pad` (-113606) against 1.15 m on the pass that
> wrote (-113832). Own-contact counterexample: -173805/-173956/-174146 put
> `speed-pad`'s slot fill within 0.18/0.08/0.00 s of the rider's own nearest
> sample and none wrote. Owner boarder is `lw a0, 232(s0)` at 0x0013c410
> (main 17) and 0x0013c434 (main 18);
> `CollisionEffectSlot_SpawnFromContactResult` 0x0013ab00 memsets its 240-byte
> thread to 0xdeadc0de and the ctor chain (0x0013b8c8 → 0x0017d198 →
> 0x0017d100) writes +0x08/+0x14/+0x20/+0x24/+0x38/+0x3c/+0x40/+0xe0/+0xe4 and
> never +0xe8. A `liveNode+0xe4` probe on these cells reads allocator poison
> rather than the cell's own entity, so the slot holds a smaller node than the
> thread and +0xe8 is not reachable from the instance. Null ruled out on runs
> 20260806-193236/-193432/-193633: absolute 0x134/0x138/0x13c sampled as fixed
> words for whole passes — one of which wrote 4.983 to the real field and two of
> which wrote nothing — hold 0x00000000 throughout and never change.

> [[360-pads-owner-read]]() Live evidence: `Trailmap/tools/autotest`, cell
> `pad-gate` (AUTOTEST2), runs 20260806-214442/-214529/-214615, `--frames 2400
> --turbo 3`. Chain = Debounce, marker, MainType 17 (5.0), MainType 18 (5.0),
> MainType 13, MainType 4 — the three rider-acting opcodes adjacent so one
> traversal serves them all. `lateWatch` searches the heap for a block holding
> the cell's instance at `thread+0xe4` and reads `+0x40`/`+0xe8`/`+0xe4`/`+0xe0`.
> Instance 0x0127e3d0 in all three. -214442: `boost-request` 0.000, `jump` 2.24 m
> (under the 2.5 m/sample noise floor, i.e. no reset), owners 0x00de2ef0 and
> 0x00d38970 against rider 0x00c86300. -214529: 4.983 and 17.16 m, owner
> 0x00ddae00 = rider 0x00ddae00. -214615: 4.950 and 32.05 m, owner 0x00ddae00 =
> rider 0x00ddae00. The within-pass split is -214529, where cells `speed-pad`
> and `trick-pad` both read 0.000 in the same pass this cell read 4.983.
> LIMIT ON THE NEGATIVE HALF: the harness reports only heap candidates whose
> words changed over the search window, so the non-writing pass shows that the
> blocks it reported were not the rider, not that no block held it.
> ROSTER CORROBORATION: the harness now reads the rider manager's own field
> (count `+0x88`, array `+0xC4`, found by heap search), and Race mode carries
> six. Both owners measured on the failing pass, 0x00de2ef0 and 0x00d38970, are
> entries in that field — so the write went to a NAMED rival rather than to an
> unidentified pointer. Two caveats keep this corroboration rather than proof:
> the roster was read on run 20260806-223255 rather than on -214442 itself
> (boarder addresses recur across runs, but the local human's did not), and the
> third candidate on that pass, 0x43e1d43e, is a float and correctly matches
> nothing — which is the control on the other two matching. A failing pass
> ridden from now on names its own owner within one run.

> [[360-pads-solo]]() Live evidence: `Trailmap/tools/autotest`, run
> 20260806-225818 (AUTOTEST2, `--mode showoff --menu "cross:76,down:1"`,
> `--frames 2400`, 1x). `GameModeGlobal` 3; the harness's roster probe read
> **1 rider** (manager 0x00a40580, boarder 0x00af5800) against 6 in race on
> 20260806-223255. All three pad cells wrote in that one pass: `speed-pad`
> 5.000, `trick-pad` 2.017 speed + 5.000 trick (5.0 less the 2.98 s between the
> two contacts), `pad-gate` 4.983 in both. Mode enum → mode-name mapping from
> the jump table at 0x00365730; the menu prelude is calibrated by
> `emu.py modescan` and asserted per run, so the mode is a reading rather than
> an intention. NOTE the reset in `pad-gate` moved the rider 0.0 m on this pass
> where it moved 17-32 m on the race passes that wrote — unexplained, and a
> separate question from the pads.

> [[360-pads-rt]]() db:course-boost (no velocity/upward write in either
> branch); db:trick-boost (rail spin-rate setup, factor value owned by
> 350-rails.md); window decay 1/60 per tick @0x0011794c, cleared on
> motion-state reset @0x00108368 (map:"Visible speed/trick boost pads").

> [[360-pad-sound]]() map:"Visible speed/trick boost pads" — main type 17
> branch (`0x0013c408`) → feedback/audio path (`0x002345c8`) plays `zbxsfx`
> slot 115; main type 18 (`0x0013c42c` → `0x00234818`) slot 114; fixed per pad
> type, local-human gated.

> [[360-node]]() db:boost — type-0 sub-type 7 `Boost`, RTTI `cBoostNode`
> @0x0036f090, vtable @0x0036e6d8; ctor `BoostNode_ConstructFromEffectPayload`
> @0x001404a0, tick `BoostNode_Update` @0x00140690 (vtable slot 2)
> (map:"Boost effect constructor").

> [[360-node-apply]]() db:boost — `BoostNode_ApplyToBoarder` @0x00140840,
> reached from the tick handler's per-rider virtual call at vtable+0xE4.
> `along` = dot(boarder+0x150 `carried_velocity_vector`, node+0x40 dir) on VU0;
> `deficit` = node+0x50 − along; `c.olt.s` early-out unless deficit > 0;
> delta = dir × deficit × node+0x54 × 1/60 (literal 0x3C888889); `VADD.xyzw`
> then `sdc2` back to boarder+0x150. Rider selection: contact list at node+0x70,
> entity type field == 1007, each gated on `WorldEntity_IntersectLineQuery` > 0.

> [[360-node-fields]]() db:boost — ctor field map: payload +0x0c → node+0x60
> (s16 mode); +0x10 → node+0x58 as `(int)(U1 × 60)` frames, and to node+0x5c
> only under the mode==1 `movz`; +0x14 → node+0x54 (direct); +0x18 → node+0x50
> (× 100.0, literal 0x42C80000); +0x1c/+0x20/+0x24 → node+0x40 as a vec4 with
> w = 0 via `lq`/`sq`. Engine-unit scale cross-checks against the shared caps
> (2788.83936 / 3347.22217 units/s = 27.888 / 33.472 m/s). No instance transform
> is applied to the direction on either the ctor or the apply path. Corpus
> `rate`/`target` values and the per-placement direction spread:
> doc:../research/extracted-data.md "Boost and scoring effects".

> [[360-node-throw]]() Live evidence: `Trailmap/tools/autotest`, AUTOTEST2 cell
> `vent-throw`, runs 20260806-203550 and -203635 (with -200836, -201653,
> -202059, -202317 and -203353 reproducing the same two clusters on earlier
> revisions of the metric). Host box `[120, 3.29, 3.6]` m — the two extents that
> govern dwell taken from `Mdl_Exaust_BOOST_Volume_0`'s own mesh
> (`Maps/MEGAPLE/Meshes`, model 311: 3.60 × 3.12 × 3.29 m in model X/Y/Z, Z
> world up), the third widened across the corridor because a fixture with no
> steering must not miss and a wider axis cannot lengthen a crossing. Payload
> packed as MainType 0 SubType 7, `Mode` 1 / `U1` 0 / `U2` 3 / `BoostAmount` 100
> / `BoostDir` (0, 0, 1), matching MEGAPLE slot:0100. Signals: `rise` = peak
> boarder+0x150 z lane; `climb` = peak boarder+0x140 z minus its value at the
> first attributed sample, per continuous stretch; `speed` = peak |boarder+0x150|.
> The 33.47 m/s ceiling is 3347.222 raw units/s, the strong-gate constant at
> `[[360-cap]]`, reached with boarder+0x134 reading 0.000 at every sample — i.e.
> not this node's doing. Slopesmith's side of the same measurement is
> `Slopesmith/tools/ride-study/boost-throw.ts`.

> [[360-node-mode]]() db:boost — `BoostNode_Update` @0x00140690 alive flag:
> seeded 1, `movn` clears it when mode != 0, `movz` re-sets it when the
> countdown at node+0x5c is still ≥ 1 after its per-tick decrement, and the
> per-rider hit branch @0x001407a4 sets it unconditionally. Mode != 1 with
> countdown > 0 takes the `bgtzl` @0x00140700 that skips the apply loop — the
> cooldown reading. Alive == 0 at the end calls vtable+0xB4 with arg 1, the
> self-end/handoff hook (`150-logic.md` Slot4). Re-arm is
> `BoostNode_ControlOp` @0x001408d8: command 1 writes node+0x5c = node+0x58,
> all other commands tail-call `EffectNodeBase_ControlOp` @0x0013aa50.

> [[360-node-cap]]() db:speed-cap — clamp @0x00117a90 in
> `BoarderMotion_SharedUpdate` scales boarder+0x150 by (+0x1c4 / speed) when
> speed exceeds the cap; the raw-motion-state test @0x001179a4 branches state 1
> (air) to 0x00117ac0, past the clamp, so no airborne clamp occurs
> (map:"Visible speed/trick boost pads").

> [[360-node-corpus]]() db:boost — census over the extracted courses'
> `Effects.json` walking instance → property → effectSlot → circumstance →
> graph: 45 sub-7 bindings, MEGAPLE 30 + MERQUER 8 + ALASKA 7, **all mode 1**,
> all on the collision circumstance, all directions unit length to 1e-4. Matches
> the independent count at spec:360-boost-subtypes, so the corpus is now fully
> sampled for this sub-type. Exhaust vents = MEGAPLE slot:0100 (dir 0,0,1;
> shared by `Mdl_Exaust_BOOST_Volume_0..11`), slot:0101, slot:0102. Conveyors =
> slots 0071–0089 (`rate` 10.0, `target` 60); air shafts = slots 0094–0099.
> Wind ramp = ALASKA slots 0030–0036, hosts `Mdl_ForceWind_5006`…`5000` in
> ascending pitch order, all `target` 45.0 / `U1` 0.0, `rate` 3.0 on 5006 and
> 4.0 on the rest, all dir.Y == 0.0 exactly.

> [[360-boost-subtypes]]() doc:../research/effects-semantic-names.md — type-0
> boost sub-types authored across the 12 retail course SSFs:
> Boost (7) ×45 — ALASKA 7, MEGAPLE 30, MERQUER 8; LapBoost (15) ×1, ZBoost
> (18) ×3, TubeEndBoost (24) ×1 — all MEGAPLE-only, all on the **collision**
> circumstance. Hosts: LapBoost `Mdl_Endboost_Lap_1000` (payload `U0`=5.0
> `U1`=25.0 `U4`=1.0); TubeEndBoost `Mdl_Endboost_End_1000` (19-field payload
> incl. three unit-length vectors); ZBoost twice on `Mdl_twinAirShaft_BOOST_0`
> slots 92/93 (`U0`=4.0, `U1`=20.0/19.0, `U5`=−12000.0), whose persistent
> circumstance is a timer particle emitter (`180-particles-data.md`), and once
> on `Mdl_Endboost_Z_1000` (`U5`=0.0, `U6`=400000.0). The same air-shaft model
> also hosts six ordinary directional Boost slots (94–99), so the plume props
> mix both kinds. Field semantics for all three are now resolved — 18 fully
> ([[360-zboost]]), 15 and 24 through their gating and payloads with their
> scripted sequences still open ([[360-lapboost]], [[360-tubeend]]). All three
> are absent from every other course, so MEGAPLE is the only sample.
