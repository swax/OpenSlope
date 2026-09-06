# Ground-contact implementation history

> spec:310-fields; spec:320-spring; spec:320-spring-accel;
> spec:320-pushout; spec:320-redirect; spec:340-air

Historical implementation notebook for Slopesmith's ride-model rework. Raw
trace details, superseded interpretations, negative results, and the evolution
of the port remain here as research provenance. Current behavior belongs in
the linked specs; current implementation guidance belongs in Slopesmith.

> **The traced grounded tick below is the model.** Three analysis passes traced
> `GroundMotion_SurfaceTunedBoardUpdateCandidate` @0x0010a0d8 at the instruction level; the behavioural
> model they recovered is what the linked specs state, and Slopesmith's ride session
> (`../../Slopesmith/src/app/ride/session.ts`) implements those specs, explicit Euler and all. The plan
> further down this doc — built from the spec
> and the Trailmap research notes rather than the instructions themselves — is wrong in five specific ways, and stays as the
> record because the *cause* is reusable: **the disassembler prints the EE 128-bit quadword ops `sq`/`lq` as
> `.word 0x7fa2XXXX` / `0x7ba2XXXX`**, so a scan for writes to a stack slot silently misses the one that matters.
> Three separate wrong conclusions — "no grounded gravity", "the acceleration clamp is a degenerate guard", "rest
> depth = the sink budget" — all trace to that single blind spot.

## The traced grounded tick

What the traced tick computes, stated as the model rather than as the routine's
statement order. Provenance: `GroundMotion_SurfaceTunedBoardUpdateCandidate`
@0x0010a0d8…a578; boarder fields position `+0x140`, velocity `+0x150`, contact error
`+0x1bc`, game-speed dial `+0x12c`, surface index `+0x290`, bog `+0x294`, sink budget
`+0x298`, contact normal `+0x2a0`; surface records are 100 bytes.

```
vn    = dot(vel, normal)
dt    = gameSpeed / 60                  (the dial is 1.0 in play)
A     = the surface's own normal-force scale
R     = accelResponse(error, vn)        (state 2 is its only caller)
nCap  = min(R, 2A) / cosθ

accel = normal·(R − nCap) + bankedNormal·nCap
      + tangent·(tanTerm1 + tanTerm2) + lateral·latTerm
      + worldDown·A                     ← GRAVITY, per surface

e = max(budget + error, −10)
if (e < 0) {                            ← only past the sink budget
    pos   −= e·normal                   (capped at 10 units = 0.1 m)
    error −= e
    vel   −= vn·normal                  ← ZEROES the normal velocity
    if (dot(accel, normal) < 0)         ← the acceleration clamp
        accel −= normal·dot(accel, normal)
}

pos += vel·dt                           (post-pushout velocity)
vel += accel·dt                         (accel frozen at tick open — explicit Euler)
```

**1. Grounded gravity is the surface's own `record+0x00`,** applied along world-down. Component `[2]` is the
vertical axis — proved by the air integrator branching its two-stage gravity on the same offset (`sp+0x98`,
@0x0012b3c4). So gravity is *per surface*: **9.80 m/s² on the thirteen generic rows — exactly standard gravity** —
and 13.01 snow, 13.51 ice and ramp, 11.51 powder, 9.99 slow powder. The table's name for that column,
`contact_accel_response`, is a misnomer: it is the **normal-force scale**. The same field, doubled, is the
`min(R, 2A)` response cap, so pull and maximum push scale together per surface.

**2. The deck rests at `bog` (`record+0x1c`), not the sink budget (`record+0x20`).** Because gravity is `A` and the
response is `A·phase`, **`A` cancels** and the equilibrium is `phase = n̂·up`, i.e. `error = −bog·cos(slope)`.
Simulated on the traced model: powder settles at 15.08 cm against a bog of 15.09, slow powder 25.20 against
25.20, ramp 0.50 against 0.50 — residual normal speed down to `1e-17`. The **budget is the pushout threshold.**
`320`'s Net table, which is `lift − budget` arithmetic, is therefore measuring the wrong column.

**3. `record+0x18` is `ground_threshold`** — the "[open] one further scalar with no traced consumer" in
`310-fields`. The ground→air predicate (@0x0010ab4c, → `SetBoarderMotionState(1)`) is *probe empty, or clearance >
`record+0x18`*. Snow **2.742 units ≈ 2.7 cm**; ice 2.78; rock 2.02; ramp 2.58; powder 15.04; slow powder 30.03.

**4. The above-surface pull is integrated, and bounded by that band — not unreachable.** `−(A/30)·error` reaches
21 m/s² half a metre up, but the grounded state never extends past `ground_threshold`, where the pull is 1.2 m/s².
An ollie crosses the band in two ticks. Its damping term is **one-sided** above the surface (`−P·vn` only when
`vn > 0`). There is no airborne caller of the helper anywhere in the ELF.

**5. The acceleration clamp is real.** It lives *inside* the
`e < 0` block, so it fires **only when penetration exceeds the sink budget**, never on an ordinary tick.
Unconditional clamping, which both Unity boards do, remains the bug.

Also traced: `+0x12c` is a **game-speed dial** (reset to 1.0, slew-limited ±0.008446/update into [0.70, 1.50] for
scripted time dilation), not a frame delta — so the fixed 60 Hz tick stands. And **clean landings go air → state 2
directly** (@0x00109390); only crashes route through state 5, where the full contact-plane projection lives. The
ordinary landing has no projection at all: the arriving normal velocity is killed by the pushout's `vel −= vn·n`.

### Phase 1b — the traced tick in `session.ts`

`session.ts` carries all of it: rest depth `= bog`, per-surface gravity `= A/100`, the `ground_threshold`
band with contact hysteresis, the `vn`-kill pushout, the budget-gated accel clamp, the one-sided above-surface
damping, no projection on a clean landing, and **explicit Euler**. Verified against the shipped
`contactResponse`: `error = −bog` is an exact fixed point on every surface (peak-to-peak 0), and an 8 m/s landing
reaches 3.6 cm into snow against its 2.5 cm budget.

The deliberate choice was to keep the engine's integrator. Its consequence is measured and stated: on the lightly
damped rows the fixed point *repels*, and a deck standing still on flat snow limit-cycles 8.6 cm at ~4.3 Hz,
spending ~60% of ticks airborne. Powder is stable (its 15 cm give is a soft spring); rock and ramp are stable
(`P` = 30, 40). Whether that chatter survives being ridden — where terrain, not the instability, drives the
contact — is the next thing to find out. If it doesn't survive, the lever is the discretization, not the
constants: a semi-implicit step quiets every surface.


The test ride ([016](../../Slopesmith/docs/016-ride.md)) holds the deck on the surface with a **hard snap**: every grounded frame
re-seats it at a fixed hover height, minus a per-surface sink carried as a 1-D position spring. The engine does
none of that. Its deck has a **free contact error** — gravity pulls it into the surface, a one-sided capped spring
pushes it back out, and the deck settles wherever those balance ([Trailmap: 320-ground-contact]).

The snap is the root of every compensation in `../../Slopesmith/src/app/ride/session.ts`: the spring needs an artificial excitation to
ring at all, the landing plunge needs an invented transient, convex ground needs a blanket velocity projection that
[Trailmap: 320] explicitly warns against, and leaving a lip needs a hand-picked threshold. Each fix is sound given
the snap. Together they are a different game.

This doc plans the replacement: **delete the snap and the compensations, port the engine's model, and let the feel
emerge.** Then iterate — from authentic, not toward it.

## What the engine does

The RE's own replication summary (`db:snow-sink @0x10a428`) is unambiguous:

> keep a signed contact penetration depth; per SurfaceType rate-limit a sink budget toward its target at ~1 m/s;
> **let full gravity pull the deck into the surface**, and apply an outward normal spring **only when depth exceeds
> the budget**, force proportional to the overshoot, capped at ~0.1 m, bleeding the depth down — **do not hard-snap
> to a fixed hover height.**

Three consequences, none of which the current ride can produce:

- The **~1 Hz bob** is the equilibrium of gravity against the spring. Nothing has to excite it.
- The board **crests a roll** when gravity can no longer supply the centripetal acceleration the surface demands.
  Nothing tests for it; the crossover `R = v²/(g·n̂)` simply happens.
- The deck **sinks per surface** because the spring's budget says so — powder buries, ice and rock stay crisp.

## Phase 0 — Close the open question first

Two facts the model rests on are not established, and both are cheap to settle. Writing code before they are is how
a wrong mechanism gets encoded in three codebases.

1. **Where gravity is applied to the grounded rider, and whether its normal component is gated.** The grounded
   gravity term is untraced; [Trailmap: 320] carries it as `[open]`.
2. **What stops the spring's above-surface zone from being a magnet.** Above the surface the response is
   `−(A/30)·error − P·vn`. On snow that is `43.4 × error` — at half a metre up, **21 m/s² pulling down**. Applied
   unclamped, the board could never leave the ground. Something gates it, and the sign-gated branch at
   `0x0010a4b8` is *not* it (that vector is the banked-frame basis, `contactNormal × cos(record+0x14° · lean)`).

Method, in `Trailmap`:

- Enumerate **every write to `+0x150`** (velocity) and `+0x140` (position) in the ground update
  `0x0010a0d8..0x0010a808`. That list *is* the complete set of grounded forces — no inference.
- Trace `f21` (the `AccelResponseHelper` return) and `f20 = min(f21, 2A)/cos θ` to their consumers. The contact
  response looks to be applied along the **banked** normal, not the raw one; if so it changes the port.
- Locate grounded gravity: `BoarderMotion_SharedUpdate @0x001171a0` runs for every motion state, or search `.data`
  near the airborne constants for a distinct grounded one.

**Phase 0 result:** the scoped write inventory is folded into
[Trailmap: 320]. In `0x0010a0d8..0x0010a808`, the direct motion writes are the
budget pushout to `+0x140` / `+0x150`, then free `pos += velocity * dt`, then
`velocity += accel_delta * dt`. The `f21` return is split through the banked
contact frame; the `0x0010a4b8` sign gate tests `normal * cos(tilt)`, so it is
not the above-surface magnet gate and not a gravity-normal clamp.

**Exit:** proceed to Phase 1 on the replication summary tagged `[inferred]`.
Residual unknowns stay explicit: the exact grounded gravity source/magnitude,
and the gate that prevents the above-surface response from welding the board to
the ground. The design does not depend on the outcome — only our confidence in
it does.

## Phase 1 — Slopesmith is the reference implementation

The sandbox: cheapest to iterate, and the only place the model can be verified without a headset.

- **State:** `error` = signed clearance of the deck reference along the contact normal (negative = penetrating).
  Position integrates freely.
- **Per grounded tick,** using Phase 0's traced stores and the replication
  summary where still `[inferred]`: three-zone contact response (`A`, `P`, bog,
  budget, `vn`) → full grounded pull `[inferred]` → carve / cruise / boost in
  the contact frame → one-sided capped pushout past budget, bleeding the error
  → integrate.
- **Ground ⇄ air** by the contact-probe band, not by a velocity threshold.
- **Touchdown** is the *only* velocity projection, with `340`'s landing bands.

**Deleted, not ported.** `HOVER`, `GROUND_SNAP`, `GROUND_STICK`, `movingOff`, `stuck`, `sinkImpact`, the
position-spring `sinkUpdate`, the tangent projection, the `SINK_*` knobs. Every one exists to prop up the snap.
Porting them forward guarantees we never find out whether the model is right.

**Kept.** The analytic patch contact, the 20-row surface table, the lean/carve/yaw math, cruise + boost, the visual
lift, `CONTACT_SLEW`, the camera, the touch controls. This is surgery on ~150 lines of `step()` / `groundStep()`.

*The fixed tick.* The engine's contact model is a **per-tick discrete system**, not a per-second one: the pushout
adds a *length* to velocity once a tick, and the contact fields slew a flat 1.6667 units a tick. `step()` now banks
real time and spends it in whole 60 Hz ticks. This is also what makes Phase 2's frame-rate assertion true by
construction rather than by luck, and it *removes* code: because `dt` inside a tick is fixed, the carve needs no
exponential-closure rewrite or `dt`-scaled yaw clamp — the raw `6°/tick` is simply itself.

*The integrator is ours.* The traced store order is explicit Euler — `pos += vel·dt` then `vel += accel·dt`, both
against the tick's opening position — and on snow's deep zone (`ω = 36 rad/s`, `h = 1/60`) its amplification is
`|λ| = 1.13` per tick. It cannot settle; a literal port chatters, never converges, and is frame-rate dependent.
The **response** is the engine's, the **discretization** is a semi-implicit step (damping implicit, position
integrated with the tick's finished velocity). That is the only deviation in the grounded path, and it is stated
in the source.

**Phase 0.2 is answered, and the answer is "nothing gates it".** The above-surface pull is never integrated,
because the grounded tick runs only while `error ≤ 0` and **air is a separate integrator** (`AirMotion_…`,
two-stage gravity, no contact term). Every airborne landing routes through motion state 5, not the ground update
([Trailmap: 300]), so the ground update never sees a deck falling from height. The helper keeps its above-surface
branch because its *airborne* caller reads it — the pre-landing basis rebuild ([Trailmap: 340]) — not to move the
rider. The ollie survives the one moment it could be eaten because the launch **forces the air state**, with no
contact check, exactly as [Trailmap: 300] describes. There is no magnet to gate, and no threshold was invented.

**Verified numerically, not in a browser.** Driving the shipped `contactResponse` through the grounded tick's own
arithmetic: every surface converges (residual normal speed ~1e-16 m/s), at the rest depths in the table below.
The `P = 0` row (13, off-track metal) holds a bounded limit cycle — it has no damping to settle it, as authored.

## What Phase 1 found: the spec's two published columns do not reproduce

Neither is a porting error. Both follow from the units, and both were invisible until the model ran.

**1. The ζ column describes a zone the deck never occupies.** [Trailmap: 320] derives `ζ = P / (2·√(A/30))` and
reports a ~1 Hz bob. But `A/30` is a stiffness (1/s²) only in the **above-surface** branch; the bog and deep
branches return an *acceleration* ≈ `A/100` m/s² (13 m/s² at phase 1 on snow, capped at `2A` = 26). The deck rests
below the surface, always — so the stiffness it actually feels is the deep zone's local slope,
`2·(A/100)/(budget − bog)` ≈ 1300 s⁻² on snow, some **thirty times** the ζ column's `k`:

| Surface | published ζ / Hz | measured (rest, deep zone) |
|---|---|---|
| standard snow | 0.38 / ~1 Hz | ζ 0.069 / **5.7 Hz** |
| ice | 0.30 | ζ 0.052 / 6.3 Hz |
| powder | 0.23 | ζ 0.113 / 2.0 Hz |
| rock | 2.62 (overdamped) | ζ 0.346 / 6.0 Hz |
| ramp | 2.98 (overdamped) | ζ 0.821 / 2.4 Hz |

The column's *content* survives — it still splits snow/powder/ice from rock/ramp, and that ordering is the feel.
Its numbers characterise the response's shallow tail, not its working point. Nothing overdamps.

**2. Grounded gravity, not the table, sets the rest depth.** The deck settles where the response balances `g·n̂`.
The response saturates at `2A/100`, so if `g < 2A/100` the deck rests **above** the authored sink budget and the
pushout never fires:

| | snow | off-track | powder | slow powder | ice | rock | ramp |
|---|---:|---:|---:|---:|---:|---:|---:|
| rest at g = 19 (cm) | 0.96 | 1.25 | 19.87 | 29.90 | 0.86 | 0.99 | 1.42 |
| authored sink (cm) | 2.50 | 3.09 | 29.78 | 35.63 | 2.25 | 1.54 | 5.05 |
| `g` needed to reach it | 26.02 | 24.01 | 23.03 | 19.98 | **27.02** | 19.60 | **27.02** |

At `g ≥ 27.02` (ice and ramp, the stiffest rows) every surface saturates, the deck drives past its budget, and the
**capped pushout** — not the three-zone response — is what holds it, at exactly the budget. Then [Trailmap: 310]'s
Sink column and [Trailmap: 320]'s Net column reproduce exactly, and the RE's own words ("the spring balances it
at penetration ≈ budget") become literally true, with "the spring" meaning the pushout.

That is a **falsifiable prediction about an [open] constant**, and it is left at 19 rather than tuned to fit. The
ordering the table exists to express (powder ≫ hard surfaces) survives either way. If a later trace finds a
grounded gravity near 27, this is the confirmation; if it finds 19, the published columns are the RE author's
model rather than a measurement, and the Net table is arithmetic, not an observation.

## Phase 2 — Verify numerically before calling it done

A headless harness (`../../Slopesmith/test/ride-contract.test.ts`) asserting **emergent properties, never implementation**. If a property
has to be coded in, the model is wrong.

| Assertion | Why this is the right test |
|---|---|
| Rest depth per surface = where the response balances `g·n̂` | The powder ≫ snow / ice / rock ordering must fall out of the table, not out of an `if`. Phase 1 checks this on the 1-D normal channel; the harness must do it on the real board |
| ~~ζ and bob frequency match the published column~~ → **assert the deep-zone ζ above, and the underdamped/firm split** | The published column measures the above-surface zone. Asserting it would encode a mistake |
| 10 s on a convex R = 200 m arc → **0 % airborne**, depth bounded | The failure that motivated this doc |
| Sweep R at 20 m/s → the board leaves at `R ≈ v²/(g·n̂)` | Emergent. Grep the source: no such expression exists |
| Carried speed onto a concave ramp transition is preserved | The regression a blanket projection causes ([Trailmap: 320]) |
| 60 Hz vs 240 Hz agree to ~1 mm | True by construction now (fixed tick) — so the test guards the accumulator, not the model |
| An ollie from rest clears ≈ `v²/2g` | Guards the forced-air latch: without it the pop is spent inside the surface |

`contactResponse` and `SURFACE_ROWS` are exported from `session.ts` for exactly this.
This suite is the **contract the Unity ports must satisfy**, not a Slopesmith detail.

## Phase 3 — Feel pass

Only now, and only on what the spec marks `[open]`: the grounded gravity magnitude if Phase 0 did not yield it, the
carve-drag → acceleration coefficient, the air control rate. Everything else is data and stays untouched.

## Phase 4 — Unity, after Phase 2 is green

`RideableBoard`'s `newPos = _pPoint + _pNormal * (hoverHeight − SinkUpdate())` is load-bearing for the VRCStation
seat, the wake ribbon, the spray FX, the ride audio, the OOB reset, the network pose, rail entry/exit, and the pitch
conform.

1. Enumerate every consumer of `hoverHeight` / `_sinkDepth`. That list is the blast radius.
2. Port the tick, reusing Phase 1's numbers.
3. Compile-verify (`../../Unity/tools/sync-unity.ps1` → OpenSlope-Gamma, `CompileAllCsPrograms`).
4. Keep `snowSink` / `hoverHeight` as a live A/B toggle for one release — Garibaldi is published.
5. Ride-test.
6. `BasisBoard` mirrors it.

## Phase 5 — Spec and docs

[Trailmap: 320] gains the grounded tick as established. This doc,
`../../Unity/docs/vrchat/020` and `../../Unity/docs/basis` describe the
model as it is. The archaeology — what each compensation was for, and why the old reading of the clamp was wrong —
belongs to the port's own history, not to those documents.

## What can bite us

- ~~**The above-surface magnet** (Phase 0.2)~~ — **resolved.** Nothing integrates it; the grounded tick runs only
  while `error ≤ 0` and air is a separate integrator. See the Phase 1 pass.
- **Grounded gravity sets every rest depth.** Confirmed, and quantified above: at `g = 19` the deck rests at
  0.4–0.7× the authored budget on hard surfaces, so snow and ice draw ~1 cm *proud* of the snow where the spec's
  Net column says ~1 cm sunk. Left at 19 and recorded.
- **The resting bob is ~6 Hz, not ~1 Hz.** Bounded and small (a centimetre on snow), and the camera's aim damper
  already filters it out of the view — but it is a shudder the old snap did not have, and Phase 3 should look at
  it before deciding it is wrong. It is what the constants say.
- **Removing the snap surfaces terrain quality.** The deck genuinely follows the surface, so G1 continuity across
  cells starts to matter. The authored mountain rides the analytic patch and is exact; a loaded reference world is
  faceted and may need its own treatment.
- **Props and rails** ride the same snap path today.
- **The feel changes, probably a lot, before it improves.** That is the cost of authentic-first, and the reason
  Phase 3 is a phase and not a polish pass.

## Rollback

Slopesmith's current model is one commit; it stays until Phase 2 is green. No local toggle: keeping the snap alive
behind a flag would keep every compensation alive with it, which is the one thing this plan is for. Unity keeps its
inspector toggle for a release, because Garibaldi is published.

## Next

Phase 2 — the headless harness, with the corrected assertion list above. The two columns that do not reproduce are
the reason it exists: an assertion suite written from the spec's published numbers would have encoded the mistake.

Then Phase 3 owes an answer on grounded gravity (19 vs 27.02) and on the ~6 Hz bob, and only then Phase 4's Unity
port — whose blast radius (`hoverHeight` / `_sinkDepth` consumers) is unchanged and still needs enumerating.
