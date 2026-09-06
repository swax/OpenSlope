# 340 — Jump, Air, Landing

The jump is a charged launch that **adds** a contact-frame impulse to the
carried velocity (never replaces it); flight is ballistic under a
**two-stage gravity** with light horizontal damping and a hard speed cap; and
the landing **rewards squareness** — the deck is pre-aligned to the upcoming
surface while still airborne, and touchdown scrubs speed progressively with
the orientation error. [[340-overview]]()

The charge/release sequencing lives in the control state machine and is
deliberately decoupled from ground contact (`300-rider-states.md`).

> [[340-overview]]() db:jump; db:air; db:landing;
> map:"Jump / Antic charge status".

## Charging and releasing

Holding the jump input drives a normalized **charge** toward 1.0 — at a rate
that is not established [open], so the time to a full charge is unknown;
releasing
snapshots the charge and slews the same value back toward zero at a fixed
13.33/s — and the launch fires when that countdown **reaches zero**, with no
ground-contact check at that moment (`300-rider-states.md`). A full charge
therefore launches ≈ 75 ms after the button comes up, not on the release frame.
While charging,
steering stiffens slightly (the charge enters the yaw denominator,
`330-carving.md`), and two separate **prewind** axes follow the stick to set
up airborne spin/flip without affecting the charge scalar. [[340-charge]]()

> [[340-charge]]() db:jump — state 14 charges +0x208 toward 1.0
> (@0x001050e8, helper @0x00126c08); release sets target 0 rate 13.333333,
> snapshots into +0x1c8, transitions to state 10 (@0x001046b0); prewind axes
> +0x220/+0x22c.

## Launch magnitude

The launch speed is a **squared charge** shaped by a rider statistic and the
current speed, with a strong minimum: [[340-magnitude]]()

```text
chargeUsed  = max(0, snapshot − remainingCountdown)
riderCurve  = 0.09851468 + riderByte · (0.78700274 / 255)
speedFactor = min(speed · 0.88093346 + 24.678448, 899.86835)
launch      = max(630.8786, chargeUsed² · riderCurve · speedFactor)
```

The minimum, 630.88 engine-units/s ≈ **6.31 m/s**, applies even to an
instantaneous tap; the curve means hold time pays off quadratically and
faster approaches jump higher. [measured] [[340-magnitude-vals]]()

> [[340-magnitude]]() db:jump — `JumpLaunch_ChargeScalarAndVelocity`
> @0x001284e8; rider byte at boarder+0x464+0x17.

> [[340-magnitude-vals]]() db:jump — minimum scalar 630.8786 passed by
> the state-10 caller; one alternate wrapper (@0x00128478) calls with a zero
> minimum (no-charge takeoffs).

## Launch direction — the normal↔tangent blend

The launch vector is built in the **contact frame** and added to the carried
velocity. On ordinary ground the direction is mostly the contact normal; on
steep takeoffs a tangent (down-the-lip) component blends in, computed from
contact geometry — not from a global knob and not from the surface type:
[[340-blend]]()

```text
steep     = (normalUp − cos 50°) / (cos 70° − cos 50°)
tangentUp = upward component of the in-plane takeoff tangent / sin 20°
weight    = clamp(steep · tangentUp, 0, 0.9)
```

On gentle-to-flat ground `steep` is **negative** (normalUp ≈ 1 gives
steep ≈ −1.19), not zero. The weighted tangent also scales an additional
carry term proportional to current speed, so a fast hit on a steep lip
throws you down-course as well as up. When the geometry is degenerate (flat
tangent, or steepness negative — which ordinary flat-to-gentle ground is), a
fixed fallback blend of the normal plus 0.2 × tangent (normalized) is used
instead of the weighted blend above — so an ordinary flat-ground launch
takes this fallback path, at ≈ 6.19 m/s vertical at the minimum launch.
There is
**no special case for the ramp surface type**: booter behavior is entirely
its response-table row (fast speed target, no turn response,
`310-surface-response.md`) plus this geometric blend. [[340-blend-vals]]()

> [[340-blend]]() db:jump-launch-blend — steepness from boarder+0x2a8
> vs cos(50°)/cos(70°) (@0x00128660/0x00128684); tangent-up vs sin(20°)
> (@0x0012884c); clamp 0..0.9; speed enters after the clamp as a carry term
> (@0x0012893c).

> [[340-blend-vals]]() db:jump-launch-blend — fallback
> `normalize(normal + 0.2·tangent) · launch` @0x001286dc;
> 630.8786/√(1+0.04) ≈ 618.6 u/s; no SurfaceType-18 branch in the launch
> helper (map:"Jump / Antic charge status").

## Airborne motion

Flight integrates velocity with a per-tick `dt` and four constants —
two gravity constants, a horizontal damping rate, and a speed cap:
[[340-air]]()

| Quantity | Value | SI |
|---|---:|---:|
| gravity while rising | −850.24 units/s² | ≈ 8.5 m/s² |
| gravity while falling | −1900.84 units/s² | ≈ 19.0 m/s² |
| horizontal damping | −0.2 × horizontal velocity /s | — |
| speed cap | the shared speed cap, re-armed at its top tier (≈33.5 m/s) while airborne (`360-speed-and-boost.md`) | — |

The gravity branch selects on the sign of the vertical velocity component,
giving the floaty, managed arc — slow up, fast down. Horizontal velocity is
otherwise preserved: no air path zeroes or rebuilds it, so takeoff carry
survives to the landing. [measured] [[340-air-vals]]()

In the air the stick **rotates the rider's orientation in every direction** —
left/right spins (yaw), up/down pitches (the flip rotation), and diagonals tilt
the axis (corks). It is one apply about a stick-selected axis, rotating the
orientation quaternion directly by a single angle `riderFactor · spinScalar`, so
**yaw, pitch and roll turn at the same rate**: a base rate floored at 555.56
deg/s, then multiplied by a rider-statistic factor of ≈0.49–1.21, giving ≈
**271–670 deg/s** (a full rotation in ~0.54–1.33 s), raisable by a quick
stick flick at release. Flips are this pitch rotation with the
named trick's grab/pose animation layered on top — there is no separate flip-rate.
[[340-air-control]]()

> [[340-air]]() db:air —
> `AirMotion_IntegrateVelocityWithGravityCandidate` @0x0012b348 with
> `dt = +0x12c/60`, position +0x140, velocity +0x150.

> [[340-air-vals]]() db:air — constants at 0x0012b3b8/0x0012b3dc/
> 0x0012b3f4/0x0012b368; cap check @0x0012ba20 scales the vector down only;
> "no horizontal reset" is the inspected-path negative
> (map:"Air gravity and velocity integration").

> [[340-air-control]]() db:air doc:../research/air-rotation-and-boost.md —
> apply `ControlState9_AirSpinApply` @0x001062b0 rotates the orientation quat
> boarder+0x180 by `riderFactor · spinScalar(+0x1c8)` about a stick/velocity axis
> (a VU0 macro-mode `cop2` rotate); charge @0x00105f58 (target +0x238). Spin floor
> 555.5555 (@0x00106140), rider factor 0.4875571 + byte·(0.7180859/255), flick
> bonus `Δextrema·2024.8037·(1−prewind)/(timer+1)`. Same scalar for all axes;
> stick direction sets the axis. Lean (+0x214, separate) @0x00126950.

## Pre-landing alignment

While falling, the air update **probes the world along the predicted
travel**, refreshes the contact fields for the surface it is about to hit,
and can rebuild the rider's orientation basis *before* touchdown — the deck
arrives pre-tilted toward the upcoming surface rather than slapping flat and
correcting afterward. A well-flown approach therefore lands inside the clean
band below. [[340-prealign]]()

> [[340-prealign]]() db:landing; map:"Airborne pre-contact basis
> rebuild and landing error angles" — air update @0x00108378 builds lookahead
> line queries, calls the ground-contact update, and rewrites the basis via
> @0x00129010 while still airborne.

## Touchdown

Touchdown computes **two orientation error angles** between the arriving deck
and the contact, and scales the carried velocity by each on a progressive
band — square landings keep their speed: [[340-landing-bands]]()

| Error band | Free below | Clamped at | Velocity scale |
|---|---:|---:|---|
| first error angle | ≈ 15° | ≈ 50° | 1.0 → 0.85 |
| second error angle | ≈ 25° | ≈ 80° | 1.0 → 0.75 |

A landing is **accepted as clean** when the surface is rideable (not the
bounce/wall types), the residual error fields are small, the deck/contact
alignment dot exceeds 0.9 (≈ within 26°), and the impact scalar is below a
threshold; the accepted branch fires the landing transition event. Falling
far outside the bands — checks exist against ≈ 90° and ≈ −45° errors and a
very large downward speed — feeds the hard-landing wipeout triggers
(`300-rider-states.md`), though a single proven wipeout angle has not been
isolated.

An ordinary clean transition seeds the contact error at **zero** and carries
its post-band velocity into ground; it does not immediately project away the
incoming normal component. In the Snowdream gold capture, clean transitions
with ≈15–20 m/s into the fresh normal retain ≈100–102% of total speed on the
transition sample, after which the ordinary grounded redirect/pushout absorbs
the impact over several ticks. [measured] Feeding the discovery probe's full
one-tick penetration directly into deep pushout incorrectly collapses that
sequence into an immediate speed cliff. [[340-landing-seed]]()

The special landing/contact branch ids 732/733 are the **one place** in
grounded motion (`320-ground-contact.md`) where velocity is fully projected
onto the contact plane rather than corrected conditionally: a depth correction
is first clamped to ±8.33 cm, then the carried velocity is projected flat along
the normal. The runtime transition evidence rules this branch out as the
ordinary clean touchdown path; it belongs to the exceptional landing/contact
recovery path [inferred]. Touchdown also seeds the landing spray burst
(`380-carve-effects.md`). [[340-landing-gate]]()

> [[340-landing-bands]]() db:landing; map:"Airborne pre-contact basis
> rebuild and landing error angles" — error pair from @0x0012ba80; bands
> 15°/50° → 0.85 and 25°/80° → 0.75 in @0x00108378.

> [[340-landing-seed]]() measured: Snowdream Showoff telemetry, ordinary
> air→ground transitions at frames 848 / 1244 / 2639 / 5941 retain
> 1.008× / 1.008× / 1.021× / 1.009× speed with incoming normal components
> ≈15.4 / 20.0 / 19.2 / 19.4 m/s; transition contact error reads zero.

> [[340-landing-gate]]() db:landing — gate in @0x0010c2f0: surface ≠
> 6/10, |state errors| < 0.5, dot > 0.9, impact < 4.0, then event 0x224;
> transition checks |angle| > 90°, < −45°, downward < −2777.105 in the
> follow-up transition helper; full projection branch ids 732/733
> (db:ground-velocity-correction).
