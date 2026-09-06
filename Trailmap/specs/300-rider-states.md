# 300 — Rider States

The rider is driven by **two independent state machines** that tick together at
the fixed 60 Hz simulation rate (`002-conventions.md`): a **motion** state that
selects the physics integrator (ground / air / rail / wipeout), and a
**control** state that selects the input interpreter (cruise steering, jump
charge, airborne spin, rail tricks, crash recovery). They are separate ids,
changed by separate setters, and a transition in one does not imply a
transition in the other. [[300-two-machines]]()

This chapter defines the machines, their states, and the transitions between
them. The per-state physics is specified in the following chapters: grounded
response in `310-surface-response.md`–`330-carving.md`, jump/air/landing in
`340-jump-air-landing.md`, rails in `350-rails.md`, speed management in
`360-speed-and-boost.md`.

> [[300-two-machines]]() db:motion-state; db:jump — control state id at
> boarder+0x428 (`SetBoarderControlState` @0x0011c7e0, 23 states), motion
> state id at boarder+0x424 (`SetBoarderMotionState` @0x0011c650, 7 states);
> map:"Out-of-bounds reset / wipeout recovery" (state-machine plumbing).

## The motion states

The motion state selects which update routine integrates the rider's position
and velocity each tick. Seven states exist: [[300-motion-states]]()

| Id | State | Role |
|---:|---|---|
| 0 | static | parked / not simulating |
| 1 | air | ballistic flight with two-stage gravity (`340-jump-air-landing.md`) |
| 2 | ground | surface-tuned riding (`310`–`330`) |
| 3 | rail | grind travel along a rail curve (`350-rails.md`) |
| 4 | (auxiliary contact state) | no traced update handler or entry path; safe for an implementation to treat as unused [open] |
| 5 | wipeout / landing-contact | every airborne landing resolves through this state's update, which gates a clean landing (angle/impact/surface checks, transitioning quickly back to ground) from a crash/tumble that hosts the recovery trigger (below) |
| 6 | recover-contact | post-reposition contact state during the get-up |

The state machine is implemented as parallel **enter / exit / update** dispatch
tables indexed by the raw state id; each state's per-tick update is dispatched
from the update table. A shared per-tick update additionally runs for **every**
motion state and maintains the cross-state fields: the smoothed lean, the
per-surface response fields, and the decaying speed cap
(`360-speed-and-boost.md`). [[300-motion-dispatch]]()

> [[300-motion-states]]() db:motion-state — update dispatch
> @0x00367290 maps 1→air (@0x00108378), 2→ground (@0x0010a0d8),
> 3→rail (@0x0010b0d0), 5→wipeout/landing-contact (@0x0010c2f0),
> 6→ground-contact (@0x001102c8); map:"Out-of-bounds reset / wipeout recovery".
> The state-5 update is the same landing-acceptance gate 340-jump-air-landing.md
> cites (`[[340-landing-gate]]`, @0x0010c2f0): every airborne landing enters
> motion state 5, whose update either accepts the landing (surface/angle/impact
> checks pass, event 0x224, quick transition to ground) or lets the tumble
> continue as a wipeout.

> [[300-motion-dispatch]]() map:"Rail slide — resolved" — all three
> motion vtables share `BoarderMotion_SharedUpdate` @0x001171a0 as the common
> per-tick update; the per-state integrators hang off the raw-id thunk tables
> (motion EXIT/ENTER/UPDATE @0x00367250/0x00367270/0x00367290).

## The control states

The control state selects how player input is interpreted. Twenty-three states
exist; the ones with specified behavior are below. The remaining fourteen are
out of this spec's traced scope (menu/trick-select/animation-driven states
not exercised by the riding model); an implementation may treat them as
cruise-equivalent. [[300-control-states]]()

| Id | State | Role |
|---:|---|---|
| 3 | cruise | normal grounded steering (`330-carving.md`) |
| 8, 9 | air prewind / spin | airborne spin setup and release (`340`) |
| 10 | jump-release wait | counts the release down, then launches (`340`) |
| 13 | airborne | natural air control (`340`) |
| 14 | jump charge | charges the jump while the jump input is held (`340`) |
| 15 | on-rail | rail riding: steer, boost, jump charge (`350-rails.md`) |
| 16 | launched air | trick, spin and flip input — entered after **every** jump release, on the rail's lost-contact exit, and on a trick press in natural air (`340`, `350-rails.md`) |
| 19 | wipeout | crash entry (below) |
| 20 | recover wait | plays the get-up and waits for it (below) |
| 22 | reset warp | 0.8 s hold with a fade-out, then the course-reset placement (`390-pickups-and-race.md`) |

> [[300-control-states]]() db:jump (states 14/10/13);
> db:rail-entry (15) ; db:rail-control-input (16); db:oob-reset (19/20);
> control EXIT/ENTER/UPDATE dispatch tables
> @0x003672b0/0x00367310/0x00367370, 23 entries each. 15/16 from transition
> evidence: the accepted rail entry is the only
> `a1=15` setter (`addiu a1,zero,15` @0x00126224); three entries set 16 —
> `BoarderJumpReleaseTransition` @0x00126f90, the rail lost-contact exit
> @0x0010bfb0 (motion 1 + control 16) and the natural-air trick press
> @0x00100338 — and the state-16 update @0x00100908 reads the input word's
> trick byte (`lbu` @0x00101450 → `Trick_StartFromInputSlot` 0x001272f0, id 26
> = none) plus 2-bit spin/flip fields, while the state-15 update @0x001073e0
> handles boost, steer and the jump latch and hands to 14. 22 = enter/update/exit
> @0x00106a88/0x00106a90/0x00106a48; map:"Course reset: triggers, warp state
> and placement".

## Control and motion are deliberately decoupled

The clearest consequence of the two-machine design is the jump: the whole
charge → release → launch sequence runs in the **control** machine, and the
launch fires purely when the release countdown reaches zero — there is **no
ground-contact or motion-state check at the moment of launch**. A momentary
ground→air→ground flicker over a crest (which flips the *motion* state twice)
cannot cancel a committed jump. The engine gates only the **start** of a
charge: entering the charge state requires a grounded, chargeable control
situation, so a fresh jump cannot be initiated mid-air. Implementations that
re-validate ground contact every tick of the jump will drop jumps on bumpy
terrain that the original game accepts. [[300-decoupled]]()

> [[300-decoupled]]() db:jump — `ControlState10_JumpReleaseWaitUpdate`
> @0x001046b0 launches on `charge countdown == 0` (c.eq.s at 0x001046d0) with
> no contact predicate, then *forces* motion state 1 (air); charge entry gates
> on chargeable-state fields only (map:"Jump is a CONTROL state, decoupled
> from the GROUND/AIR motion state").

## Wipeout and recovery

A crash is its own state pair (motion 5 + control 19). Entry snapshots a
recovery target frame from the rider's current orientation and bumps a crash
counter. Four conditions trigger it: [[300-wipeout-triggers]]()

- riding onto an **unrideable hard surface** (the "bounce/unskiable" and
  "wall" surface types), gated by sufficient lateral contact speed;
- a **hard landing** (excessive landing error, `340-jump-air-landing.md`);
- a hard **body collision** (`370-world-interaction.md`);
- a flagged-prop **player-bounce hard impact**: normal velocity delta
  `J=max(s·(1+b),s+55.556)` exceeds the orientation-adjusted threshold
  `1944.444+833.333·dot(boardUp,contactNormal)`. [[300-wipeout-triggers]]()

Recovery is **relative**: when the wipeout state decides the tumble is over,
the rider is repositioned to their **current position plus a short
orientation-derived offset** — near where they crashed, facing their carried
heading. Velocity is **not zeroed**; it carries through the tumble. Control
then sits in a recover-wait state that is **animation-gated**: it polls the
get-up clip and returns to cruise when the clip's completion event arrives,
not after a fixed frame count. [[300-recovery]]()

A tumble that fails to resolve is handed to the course reset instead: once
the crash has lasted more than **7 s**, or its landing phase **3 s**, a rider
still racing is course-reset — fade-out, then the drop-in onto a respawn path
(`390-pickups-and-race.md`) — while a rider who has already finished gets the
relative get-up. Ordinary crashes resolve well before that, so the relative
recovery is the normal case and the course reset is the fallback for
tumbling off the course. [[300-wipeout-timeout]]()

This crash recovery is distinct from the out-of-bounds **course reset**, which
is path-driven and specified in `390-pickups-and-race.md` (see also the note in
`140-paths.md`). The rider *physics* has no branch on the reset surface type
— it is an ordinary response-table row there; it is the **control** layer
that polls the contact surface each frame and requests the course reset when
it reads the reset type, alongside the reset button and the other automatic
triggers. [[300-reset-separate]]()

> [[300-wipeout-timeout]]() wipeout update `0x0010c2f0` (motion 5): elapsed
> timer `+0xc` @0x0010c34c, regime split on anims 732/733 @0x0010c354; timeout
> `+0x10 ≥ 3.0` or `+0xc > 7.0` @0x0010d570–0x0010d5a8, then `bltz +0x418 →
> 0x0010d638` (`+0x2e4 := 1e6`, which the next `BoarderMotion_SharedUpdate`
> bounce-accumulator test @0x00117bf4 turns into `Boarder_CourseResetEntry`)
> vs finished → `WipeOutRecover_RepositionOntoTrack`; `+0x418` is the finish
> stamp (−1 while racing; written once at `0x0011da48` as race clock × 100).
> Static only; a > 7 s off-course tumble mid-race is the decisive live check.
> map:"Course reset: triggers, warp state and placement".

> [[300-wipeout-triggers]]() map:"Out-of-bounds reset / wipeout
> recovery" — `Boarder_EnterWipeOut` @0x0011d838 call sites: the surface 6/10
> gate (lateral-speed gated) in the ground update, two air-landing branches,
> the body-bump helper, and the player-bounce comparison @0x0012665c;
> db:oob-reset.

> [[300-recovery]]() db:oob-reset — reposition
> `WipeOutRecover_RepositionOntoTrack` @0x0010f178 writes
> `new_pos = current + orientation offset`, leaves velocity +0x150 untouched,
> sets motion 6 + control 20; recover-wait @0x00108198 polls the anim event id
> (511/545/514) before returning to cruise (control 3 + motion 2).

> [[300-reset-separate]]() db:oob-reset — no `SurfaceType == 0` branch
> exists in the rider physics, and no nearest-path search runs on the player
> recover path; the reset draws on the respawnable paths / race lines
> (map:"Out-of-bounds reset / wipeout recovery"). The surface poll is in the
> control states: helper `0x00108140` (`andi word,1` → manual, `+0x304=0`;
> else `+0x290 == 0` → automatic, `+0x304=1`; f12 = 101.46) and inline copies
> at `0x00104724..0x00104768` (state 10), `0x00103394`, `0x0010557c`,
> `0x00102124`, `0x00100534` (state 13 tests `word & 2`) — 18 request sites
> in all (`refs 0x00118f18`).
> The reset runs as its own control state — every state's update
> polls `Boarder_CourseResetEntry` @0x00118f18, which switches control to
> 4 → 22 (the warp state, outside the specified riding set); triggered by the
> reset button, out-of-play detection, or an SSF main-type-13 node
> (`390-pickups-and-race.md` `[[390-reset-entry]]()`).

## Timestep within a state

Every integrator in Part 3 advances with a per-tick scale
`dt = frameScale / 60` where the frame scale is normally 1 — i.e. constants
are authored against the 60 Hz tick (`002-conventions.md`), and a slow-motion
or dropped-frame scale stretches the same constants rather than re-deriving
them. Rate-like values in this spec are therefore given per second.
[[300-dt]]()

> [[300-dt]]() db:timestep — `BoarderMotion_SharedUpdate` @0x001171a0
> uses explicit 60.0 / 0.0166667; the air integrator passes
> `dt = boarder[+0x12c] * (1/60)` (db:air); the same `+0x12c/60` scale appears
> in the ground yaw path (map:"Ground steering heading rate").
