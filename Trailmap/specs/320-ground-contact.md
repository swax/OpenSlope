# 320 — Ground Contact

Grounded riding rests on four mechanisms: a **single-line contact probe**
that yields the contact point, normal, and surface type; a **soft, one-sided
contact spring** that lets the deck float a per-surface depth *into* the
surface instead of snapping to it; a **speed-preserving redirect** at the end
of every non-powder tick that rotates part of the normal velocity into the
contact plane — the spring's stabilizer, and the reason landings convert
impact into carried speed; and a small **visual lift** that draws the deck
back up per surface. Together they produce the signature feel — a crisp
contact on ice and rock, a springy bob on snow, and a board that genuinely
buries and plows in deep powder. [[320-overview]]()

The per-surface constants used throughout are rows of the response table
(`310-surface-response.md`). The carve-driven parts of the pose (bank,
lateral slide) are specified in `330-carving.md`; landing impact handling in
`340-jump-air-landing.md`.

> [[320-overview]]() db:snow-sink; db:ride-height;
> map:"Snow springiness / feet sinking into the snow (soft contact spring)".

## The contact probe

Each grounded tick casts **one line segment** through the world: the segment
is aimed along the **cached contact normal from the previous tick**, spanning
from 1 m below to 2 m above a base point. The base point is the rider's
physics position **offset sideways by the carve pose offset**
(`330-carving.md`) — so the surface is always measured under where the deck is
actually drawn, and physics contact and visuals slide together in a carve.
The query returns the nearest hit among terrain patches and collidable
objects in one unified result carrying the hit point and its surface type;
a rideable prop is therefore picked up exactly like terrain
(`130-collision-data.md`). [[320-probe]]()

For a terrain hit the returned normal is the **exact analytic surface
normal** of the patch at the refined hit parameter — not a facet normal
(`110-terrain.md`). No temporal low-pass is applied to the contact normal;
continuity comes from the smooth surface itself and from aiming the next
probe along the previous normal. A faceted-mesh reimplementation inherits
facet steps in the contact frame and may need its own smoothing as a
compensation, not as engine behavior. [[320-analytic]]()

Two derived quantities are refreshed from the hit each tick:

- the **contact error**: the signed clearance of the deck reference point
  along the contact normal (negative = penetrating the surface); and
- the **contact frame**: the cached normal plus in-plane tangent and lateral
  axes, consumed by carving (`330-carving.md`), launch
  (`340-jump-air-landing.md`), and the wake (`380-carve-effects.md`).
  A separate **smoothed up vector** eases toward the contact normal each tick
  (renormalized after adding half the normal) and carries the visual lift
  below. [[320-frame]]()

> [[320-probe]]() map:"Terrain orientation lead" — probe built in
> @0x00128af0: endpoints `base − 100·normal` / `base + 200·normal`, base
> offset by the lateral pose term; world query
> `WorldIntersect_QueryNearest` @0x0025b528, hit surface type at result+0x34
> → boarder+0x290; db:rideable-props.

> [[320-analytic]]() db:terrain-collision — Newton-refined patch hit
> returns `normalize(∂P/∂u × ∂P/∂v)` (@0x0025e480); no low-pass on the cached
> normal found in @0x00128af0 (map:"Terrain orientation lead").

> [[320-frame]]() db:snow-sink — contact error boarder+0x1bc written
> @0x00128df4 (helper @0x00128a20); frame fields +0x2a0 normal / +0x2b0,
> +0x330 lateral / +0x320 tangent; smoothed up +0x2c0 =
> `normalize(+0x2c0 + 0.5·normal)` (@0x0012950c,
> map:"Board ride height / how high the deck sits over the snow").

## The soft contact spring

The contact response along the normal is a per-surface spring/damper
evaluated in three zones of the contact error (`A` = the surface's contact
stiffness, `P` = its contact damping, `bog` and `budget` the surface's two
depth fields, `vn = dot(velocity, normal)` — the signed velocity component
along the outward contact normal, positive when separating, negative when
approaching): [[320-spring]]()

```text
above the surface (error > 0):
    accel = −(A/30)·error            − P·vn   (unconditional damping, both directions)
in the bog zone (0 ≥ error > −bog):
    accel = −A·error/bog             − P·vn   (stiffer near the surface)
deep (error ≤ −bog):
    phase = 1 − 2·(max(error,−budget) + bog) / (budget − bog)
    accel = A·phase                  − P·vn
```

The helper's scalar is split through the banked contact frame built from the
contact normal, the lateral axis, and the per-surface carve-tilt angle. The
ordinary grounded contact slice then has exactly four direct motion writes:
budget pushout into position and velocity, followed by free position
integration and acceleration/contact-frame velocity integration. There is no
hard position snap in that slice. [[320-spring-accel]]()

Backstopping the spring is a **capped, one-sided pushout**: when the
penetration exceeds the surface's budget (`budget + error < 0`), the excess —
clamped to at most 10 cm per tick — is pushed back out along the normal,
applied to both position and velocity, and bled out of the stored error.
Because it fires only past the budget and is proportional to the overshoot,
it is a soft floor, not a rigid one. [[320-pushout]]()

The grounded load is now constrained independently in the normal and tangent
directions. A keyboard-only Gari Type-5 trace removes controller scaling from
the experiment: neutral ice averages 13.77 m/s² of response while sitting at
approximately the 5 mm bog floor, matching that row's `A/100 = 13.5093 m/s²`.
The former 4.73 m/s² world-down port settled at only 1.75 mm and cannot produce
that response or the measured banked side force. The active surface's `A/100`
therefore supplies the port's normal load. [measured, inferred]
[[320-equilibrium]]() [[320-gari-load]]()

The matched Snowdream natural-lip approach still constrains the **effective
tangential** pull. From course coordinate −640.04 m to −572.15 m the terrain
drops 22.74 m while speed rises 14.32 → 20.49 m/s with no boost, giving
`(v1²−v0²)/(2h) = 4.73 m/s²`. This cannot be the entire grounded world-down
load because it contradicts Gari's directly observed contact response. It is
the net down-course result after the still-unrecovered tangential terms.
Ports currently preserve both measurements by projecting `A/100` into the
normal channel and 4.73 m/s² into the contact plane. The retail decomposition
remains open. [measured, inferred] [[320-ground-gold]]()

> [[320-ground-gold]]() doc:../research/ground-contact-gold.md — matched
> Snowdream telemetry and the same no-boost energy calculation used by the port.

> [[320-gari-load]]() doc:../research/rider-telemetry.md — keyboard-only Gari
> ice trace, recovered response values and path-curvature comparison.

For patch-based ports, the contact point must also satisfy the probe itself.
The tessellated triangle hit may seed the bicubic parameters, but evaluating
the patch once at that unchanged seed is not an intersection: on the second
and third marked Snowdream lips it produced smooth points 0.86–1.30 m
sideways from the probe and held the rider down to −73.5°/−64.9°. Solve
`patch(u,v) = probeRay(t)` (for example by Newton iteration) before applying
the patch normal or response. This is a port constraint derived from the gold
comparison, not evidence for a particular retail solver. [measured]
[[320-patch-ray]]()

> [[320-patch-ray]]() doc:../research/ground-contact-gold.md — seed-only miss
> distances, Newton ray/patch constraint, and post-fix residual measurements.

The post-fix Snowdream capture verified 525 analytic probes at 11 nm median,
9.1 µm p99 and 9.7 µm maximum distance from their rays. Its three marked
Slopesmith takeoffs were `(speed, trajectory pitch, board pitch)` =
`(20.32, −23.9°, −17.6°)`, `(30.10, −34.0°, −25.9°)`, and
`(31.77, −33.6°, −27.6°)`, versus retail `(20.49, −28.7°, −16.9°)`,
`(31.42, −37.6°, −24.0°)`, and `(31.64, −36.6°, −22.0°)`. The played
lines differed by 1.6–3.5 m at those takeoffs, so the residual pitch delta is
not a same-point tuning measurement. [measured]

The active port profile is serialized in `specs/data/ride-v1.json`, and ports
generate their own language views from it. Ports consume those values
and must preserve the declared tick order. This machine-readable profile does not
replace the prose evidence or promote inferred values to traced facts: the
normal/tangential load split remains tagged `measured-inferred`. [port contract]

> [[320-spring]]() db:surface-accel-rate —
> `SurfaceMaterial_AccelResponseHelper` @0x00109878: A = record+0x00,
> P = record+0x24, lo = boarder+0x294 (bog), hi = +0x298 (budget),
> vn = dot(velocity, normal); three-zone scalar as quoted
> (map:"Surface physics table").

> [[320-spring-accel]]() db:surface-accel-rate;
> db:ground-velocity-correction; map:"Surface physics table" —
> `GroundMotion_SurfaceTunedBoardUpdateCandidate` @0x0010a0d8..0x0010a808:
> `f21 = SurfaceMaterial_AccelResponseHelper(...)`; `θ = record+0x14° * lean`;
> `sp+0x10 = +0x2a0 * cosθ`, `sp+0x20 = +0x330 * sinθ`,
> `sp+0x30 = sp+0x10 + sp+0x20`; `f20 = min(f21, 2A) / cosθ`, then the caller
> accumulates contact/tangent/lateral terms and integrates with
> `dt = +0x12c/60`. Direct boarder motion stores in the scoped slice:
> @0x0010a480 `+0x140` budget pushout, @0x0010a4b0 `+0x150` budget pushout,
> @0x0010a554 `+0x140 += +0x150 * dt`, @0x0010a578 `+0x150 += accel_delta * dt`.
> The two later `+0x150` stores @0x0010aae8 and @0x0010ab48 after yaw/contact
> refresh are the grounded redirect ([[320-redirect]]).

> [[320-pushout]]() db:snow-sink; db:ground-velocity-correction —
> @0x0010a428: `e = max(budget + error, −10)`; if `e < 0` then
> position/velocity `−= e·normal` and `error −= e`; 10 units ≈ 0.1 m.

> [[320-equilibrium]]() db:snow-sink;
> map:"Snow springiness / feet sinking into the snow (soft contact spring)" —
> the grounded path only conditionally cancels the into-surface component, so
> gravity vs. the one-sided spring floats penetration ≈ budget.

## The grounded redirect

The grounded tick does not end at integration. After the position and
velocity updates, the ground update **re-probes the surface at the new
position** (refreshing the contact error, normal, and surface type for the
exit checks and the next tick), and then — on every surface **except the two
powders** (SurfaceTypes 3 and 4 skip it) — applies a speed-preserving
velocity rotation along the fresh normal: [[320-redirect]]()

```text
vn   = dot(velocity, normal)          (post-integration, fresh normal)
v0   = |velocity|
velocity -= normal · (0.4 · vn)       (both signs of vn, every tick, no gate)
velocity *= v0 / |velocity|           (unless the new magnitude is exactly 0)
```

40% of the normal velocity component is removed and the speed magnitude is
then restored, so **no energy is dissipated — the velocity is rotated toward
the contact plane**. This one term is what makes the whole contact work:

- **It is the spring's stabilizer.** On the 5 mm-bog surfaces the contact
  spring is stiffer than the 60 Hz explicit step can integrate
  (`k = A/bog ≈ 2602 s⁻²` on snow, amplifying `|λ| = 1.28` per tick); on the
  spring and pushout alone a resting deck limit-cycles ~8.6 cm at ~4 Hz on
  perfectly smooth ground. With the redirect the normal channel contracts and
  the deck sits quiet. The spring, the explicit step, the pushout and the
  redirect are one mechanism split across the tick — a reimplementation that
  ports any subset gets a different contact (the spring alone buzzes; a
  semi-implicit step without the redirect is quiet but loses the redirect's
  speed conversion). [measured]
- **It converts landing impact into carried speed.** The arriving normal
  velocity is rotated into the contact plane rather than damped away, so a
  hard square landing comes out *carrying* what it arrived with.
- **The powders are exempt** because their 15–25 cm bogs are stable soft
  springs on their own — the wallow and plow of deep powder is authored, and
  the redirect would erase it.
- **At a standstill it does nothing**: with the velocity purely normal, the
  magnitude restore exactly undoes the removal. The redirect only acts when
  there is tangential travel to rotate into.

The redirect runs **before** the ground→air exit checks (probe empty, or
clearance past the surface's ground threshold) and before the wall-crash
check, so it also applies on the tick the deck leaves the ground; the jump
launch is invoked after it and adds its impulse untouched. [[320-redirect]]()

> [[320-redirect]]() map:"Snow springiness / feet sinking into the snow
> (soft contact spring)" — tail of
> `GroundMotion_SurfaceTunedBoardUpdateCandidate`: re-probe jal @0x0010aa48
> (`Boarder_UpdateGroundContactFromWorld` @0x00128af0); powder skip
> @0x0010aa58 (`+0x290 ∈ {3,4}`); `0.4` constant @0x0010aa6c (0x3ecccccd);
> `vn` dot @0x0010aa78..94; old magnitude @0x0010aaa0..c8;
> `velocity −= normal·(0.4·vn)` @0x0010aae4/@0x0010aae8;
> magnitude restore `× v0/|v'|` @0x0010ab34..@0x0010ab48 (zero-guard
> @0x0010ab24); exit checks follow @0x0010ab4c..78.

## Why snow bobs and rock doesn't

With stiffness `k = A/30` and damping `c = P`, the damping ratio
`ζ = c / (2·√k)` is per-surface, and the table splits cleanly in two: the
rideable snow family is **underdamped** (the deck visibly bobs at roughly
1 Hz), while rock, ramp, and the non-gameplay surfaces are **overdamped**
(firm, dead contact). The bob is kept from burying the deck by the capped
pushout above — not by heavy damping — so a reimplementation must keep the
snow spring underdamped and rely on the depth cap, or the feel goes dead.
[measured] [[320-damping]]()

| Surface | ζ | Feel |
|---|---:|---|
| standard snow | 0.38 | springy, ~1 Hz bob |
| powdered snow | 0.23 | very springy |
| slow powder | 0.26 | springy |
| ice | 0.30 | springy, shallow |
| rock | 2.62 | firm / dead |
| ramp / metal | 2.98 | firm / dead |

> [[320-damping]]() map:"The per-surface spring constants — stiffness
> `A`, damping `P` (and why snow bobs)"; db:snow-sink (constants table, ζ
> derivation).

## Velocity is corrected conditionally, not projected every tick

Grounded motion does **not** project out the into-surface velocity component
— a reimplementation that substitutes a blanket `v −= n·dot(v,n)` will shed
carried speed on every slope transition that the original keeps (most
visibly: riding onto a steep ramp). The traced normal-velocity mechanisms are
exactly four, and the only one that runs every tick — the redirect above — is
speed-preserving, which is precisely how the original avoids that shedding:
[[320-no-blanket]]()

1. the **grounded redirect** above (every non-powder tick, rotates 40% of the
   normal component into the plane, magnitude restored);
2. the capped **pushout** above (fires only past the sink budget);
3. a **sign-gated normal correction** whose tested vector is now identified as
   `normal · cos(carveTilt)`, one half of the banked contact frame. Its
   contact-normal dot is positive for every reachable tilt, so this reads as a
   degenerate guard on basis construction, not as a general acceleration clamp;
   in particular there is no evidence it removes gravity's into-surface
   component or gates the above-surface spring pull. [open];
4. a full velocity projection onto the contact plane, but only in the
   landing/contact branch — that mechanism is owned by
   `340-jump-air-landing.md`'s Touchdown section. [[320-no-blanket]]()

Gravity, meanwhile, keeps pulling the deck into the surface every grounded tick
— that is what the spring balances, and what holds the deck against a convex
surface. A rider crests a roll when gravity can no longer supply the centripetal
acceleration the surface demands (`v²/R` against `g·n̂`); nothing tests for it.
An implementation that instead **clamps out gravity's** into-surface component
removes the sole force holding the deck down: outward normal speed then
accumulates on any convex ground with nothing to remove it, and the deck floats
off perfectly smooth terrain — a failure a faceted collision mesh hides, because
its noise keeps resetting the accumulation. The grounded gravity *term* itself
is untraced, so its magnitude remains [open] as noted above.
[[320-gravity-holds]]()

> [[320-gravity-holds]]() db:snow-sink — map:"soft contact spring": "full
> gravity keeps pulling the deck down into the surface every tick; the spring
> balances that at penetration ≈ budget"; the same topic's replication summary
> @0x0010a428 prescribes "let full gravity pull the deck into the surface … do
> NOT hard-snap to a fixed hover height". No grounded gravity term has been
> located, so the constant stays [open] (`[[320-equilibrium]]`); the convex-hover
> failure mode is [inferred] from that model, not traced.

> [[320-no-blanket]]() db:ground-velocity-correction;
> db:contact-projection — the @0x0010a4b8 gate tests `dot < 0` (f21 is zeroed
> @0x0010a448) on `sp+0x10`, written once @0x0010a2c0 as
> `scale(sp+0x10, boarder+0x2a0, cos(record+0x14° · lean))` — the banked-frame
> basis vector, not an accumulated acceleration; its dot is that cosine, positive
> for every reachable tilt, so the branch reads as a degenerate guard [open].
> Full projection only in the 732/733 branch of
> @0x0010c2f0 (@0x0010c4c8) after `clamp(error + bog, ±8.333)`; the helper
> @0x001267a8 adjusts an incoming vector only in motion state 2 with a
> negative normal dot.

## Ride height: sink plus visual lift

The drawn deck is not at the physics contact point. The render position adds
two pose terms: [[320-renderpos]]()

```text
renderPos = contactPoint
          + smoothedUp · lift           (per-surface visual lift)
          + lateralAxis · carveSlide    (330-carving.md)
```

The lift is the surface's visual-lift field, slewed in during normal ground
riding and slewed to zero otherwise, at the rate specified in
`310-surface-response.md`. Its authored values **nearly cancel the sink on
hard surfaces and deliberately do not on powder**, so the net visible deck
height *is* the surface character — the Sink/Lift columns below are
`310-surface-response.md`'s own per-surface values, reproduced here only to
derive the Net column: [measured] [[320-net]]()

| Surface | Lift (cm) | Sink (cm) | Net (cm) | Reads as |
|---|---:|---:|---:|---|
| standard snow | 1.74 | 2.50 | −0.76 | running right at the snow |
| ice | 2.04 | 2.25 | −0.21 | crisp, on the surface |
| rock | 2.02 | 1.54 | +0.48 | sits just proud |
| off-track snow | 1.00 | 3.09 | −2.09 | settles in a touch |
| ramp / metal | 1.08 | 5.05 | −3.97 | low, planted |
| powdered snow | ≈0 | 29.78 | −29.8 | buried, plowing |
| slow powder | 0.22 | 35.63 | −35.4 | buried deepest |

A consequence of the bank model (`330-carving.md`, pure roll, no vertical
term): a banked deck's downhill edge geometrically dips below the contact
point, and the game's soft, sinkable surfaces make that read as the edge
biting in. The deck model extends upward from its running surface, so the
body stays visible at any of these offsets. [[320-bank-dip]]()

> [[320-renderpos]]() db:ride-height —
> `BoarderPose_BuildRenderTransform` @0x00129630: renderPos = +0x140 +
> +0x2c0·+0x308 + +0x330·(rider tune · +0x244);
> map:"Board ride height / how high the deck sits over the snow".

> [[320-net]]() db:ride-height — net = lift − sink per surface
> (record +0x28 − record +0x20); lift slew @0x00117690, ground state only.

> [[320-bank-dip]]() db:ride-height — the bank roll in @0x00129630 has
> no bank-proportional vertical term; map:"Net result and why banking doesn't
> look like clipping".
