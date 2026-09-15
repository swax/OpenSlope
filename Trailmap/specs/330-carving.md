# 330 — Carving

Ground steering has separate **orientation** and **velocity** responses. A
smoothed lean requests heading yaw and banks the contact force. Forward
resistance and lateral resistance act on velocity in the contact frame; they
do not directly set an angular turn rate. Visual bank and the pose slide are
separate lean consumers. [[330-overview]]()

> [[330-overview]]() doc:../research/carving-response.md; db:turn-carve —
> response directions, corrected interpretation and validation scope.

## The lean signal

The signed turn input is clamped, speed-scaled, and slewed. The target clamp
does not rescale every input value: a half-axis input remains 0.5 before the
speed gate. Speeds here are in **m/s**, and the simulation runs at **60 Hz**:
[[330-lean]]()

```text
target = clamp(stick, -0.9051856, 0.9051856) * min(1, speed/speedRef)
rate   = clamp(abs(target-lean)*7.017359, 0.1, 8.018349)
on powder types 3 and 4: rate *= 0.599972606
lean moves toward target by at most rate/60 per tick
```

The speed reference depends on the riding-mode selector: 11.3827 m/s for
mode 2, 11.3497 for mode 0, and 11.1901 otherwise. The same shaping serves
airborne turning. [[330-lean-vals]]()

> [[330-lean]]() db:air; @0x00126950; map:"Ground steering heading rate" —
> lean slew triple; ground stick decode /31.0 @0x00102fc8.
> [[330-lean-vals]]() map:"Ground steering heading rate" — mode +0x420;
> speedRef 1138.27/1134.97/1119.01 engine-units/s, powder factor 0.599972606.

## Heading yaw

Yaw changes physical orientation about the **contact normal**. It does not
rotate velocity. The heading calculation follows the ground acceleration and
velocity integration, using the contact frame already built for that tick.
Let `n` be the unit contact normal, `f` the unit forward contact tangent,
`v` velocity, `s=length(v)`, and `dt=1/60`. Angles below are **radians**;
velocities are **m/s**. [[330-yaw]]()

The alignment reference `d` is the **downhill direction on the contact
plane**, independent of the board's sideways axis. Construct it as
`cross(n, normalize(cross(n, worldUp)))`; when that inner cross has length
at most 0.0001, use the physical board-forward vector instead. This flat-ground
fallback is not an arbitrary lateral axis. [[330-alignment-basis]]()

```text
slipProjection = dot(cross(v,f),n) / s
slipAngle = asin(clamp(slipProjection, -0.99999, 0.99999))
turnLean = lean*c7*(1 + 0.5*c0*(1-lean*lean)) / (1 + jumpCharge*0.01)
candidate = turnLean - slipAngle
if dot(v,f) < 0: candidate = -candidate

speedGate = min(1, s*s*0.2002984729*dt)
align = min(1, max(0, 40*min(1,s/5.55555542)*(0.5-abs(dot(v,d))/s))
               + 0.01004204992)
directionalLean = lean if candidate > 0 else -lean
yawPerTick = clamp(candidate*speedGate*max(directionalLean,align),
                   -0.1047197580, 0.1047197580)
```

At zero speed the turn has no authority; an implementation must guard the
direction divisions. Preserve the cross-product sign when mapping the source
coordinates to another engine. The state curves are: [[330-yaw]]()

| Riding mode | c0 | c7 |
|---|---:|---:|
| 2 | 0.2083389610 | 0.2622103095 |
| 0 | 0.3001891971 | 0.3491855264 |
| other | 0.4000000060 | 0.5239824057 |

The cap is **6 degrees per ordinary tick**, equivalent to **360 degrees/s**.
It limits heading correction, not sustained travel turning rate. The quadratic
speed gate reaches half authority around 12.24 m/s and full authority around
17.31 m/s. The original speed-gate coefficient for speeds in centimeters/s is
0.0000200298473; the converted coefficient above already accounts for squared
velocity units. The per-tick angle must not receive another `dt` multiplication.
[[330-yaw-vals]]()

> [[330-yaw]]() doc:../research/carving-response.md; @0x0010a704 —
> heading analysis; scalar resistance fixtures do not validate heading.
> [[330-alignment-basis]]() doc:../research/carving-response.md;
> @0x00128a20 — downhill reference and flat-ground fallback analysis.
> [[330-yaw-vals]]() doc:../research/carving-response.md;
> @0x0010a8a4; @0x0010a9d0 — measured heading gate and cap constants.

## Heading, travel direction, and diagnostic slip

For the original Z-up coordinates, a horizontal bearing with +X at zero and
+Y at 90 degrees is `atan2(direction.y,direction.x)*180/pi`, wrapped to
0–360 degrees. Use the physical board-forward vector for heading and velocity
for travel. Their wrapped difference is a useful horizontal slip measurement.
For slope-local diagnostic slip, use
`atan2(dot(v,lateral),dot(v,f))*180/pi`, with the lateral-axis sign stated.
Neither diagnostic is automatically interchangeable with the bounded asin
projection used by the controller above. Near rest, or when a horizontal
projection vanishes, the corresponding bearing is undefined. [[330-slip]]()

> [[330-slip]]() doc:../research/carving-response.md;
> doc:../research/rider-telemetry.md — telemetry exposes physical board forward,
> velocity and the contact basis; `tools/analysis/ice_slip_retail.py` measures
> full-quadrant diagnostic slip. Audio's Slip getter @0x0021aba0 instead uses
> an absolute velocity projection, not an angle in degrees.

## Carve force vs. skid

Three contributions must remain distinct: the **banked contact force**, the
**forward resistance polynomial**, and **lateral resistance**. The surface
table's former "turn response (3 components)" fields are the polynomial's
coefficients. Their output acts along the forward tangent, opposing signed
forward travel for ordinary nonnegative inputs; they are not a sideways
acceleration or degrees-per-second tuning. [[330-carve-force]]()

Ice's small forward coefficients and near-zero lateral resistance allow fast
travel and sustained drift, while its banked contact response still supplies
turning force. A ramp also has small forward coefficients but retains snow-like
lateral resistance. Powder combines larger forward resistance, a depth factor,
and stronger lateral resistance. Preserve the actual surface coefficients
instead of remapping their large ratios onto a bounded grip factor.
[[330-carve-force]]()

> [[330-carve-force]]() doc:../research/carving-response.md;
> @0x00109cb8; @0x00109ef8 — forward and lateral response functions;
> direction analysis corrects the previous side-force interpretation.

### Banked contact force

Let `R` be the contact helper's scalar acceleration (`320-ground-contact.md`),
and `A` the surface contact-response scale **converted to m/s²**. For unit
lateral axis `l`, the force assembly is: [[330-bank-force]]()

```text
theta = surfaceTiltDegrees * pi/180 * lean
C = min(R, 2*A)
B = C/cos(theta)
contactAcceleration = n*(R-B) + (n*cos(theta)+l*sin(theta))*B
worldDownAcceleration = worldDown*A
```

Thus the lateral component is `C*tan(theta)`, while the normal component is
`R+C-C/cos(theta)`. Simply retaining `R` along the normal omits the residual
term. The tilt is a physical force-frame angle, distinct from visual deck bank.
The world-down term is not the net energy gain measured across a course segment;
forward resistance and other motion terms also contribute to that measurement.
[[330-bank-force]]()

> [[330-bank-force]]() doc:../research/carving-response.md;
> @0x0010a278; @0x0010a3f8 — banked contact and grounded-load analysis;
> these vector contributions are outside the scalar verifier's coverage.

### Forward resistance

Let `u=dot(v,f)` in **m/s**, `x=0.1*abs(u)`, and `(a,b,c)` be the three
surface forward-resistance coefficients. Four normalized rider-tuning inputs
are named by their consuming terms: `linearStat`, `quadraticStat`, `skidStat`,
and `lateralStat`. These names describe their roles, not verified front-end
attribute names. A riding-mode/edge multiplier is shared by the helpers:
[[330-resistance]]()

```text
k = 1             if currentEdge == preferredEdge or ridingMode == 1
    0.8499836326  otherwise, if ridingMode == 0
    0.6998783350  otherwise

rA = k*(0.7076424360 - 0.3019791245*linearStat)   if ridingMode == 2
     k*(1.0649821758 - 0.3084552288*linearStat)   otherwise
rC = k*(1.2848105431 - 0.2903534174*quadraticStat)
rS = k*(0.6150994897 + 0.9181777835*skidStat)
q = max(1, suppliedLoadRatio)
depth = 0.5 - contactError/sinkBudget            on powder types 3 and 4
        1                                      otherwise

forwardAcceleration = -u*depth*(
    q*a*rA + (1-jumpCharge)*0.1057286412
    + (1+boostStrength*1.2153687477)*1.7513076067*skidControl^2*rS
    + x*(q*b + x*q*c*rC))
```

`skidControl` is a separate signed control state; **do not substitute the
diagnostic slip angle or sideways speed**. The helper algebra is established,
but the runtime load-ratio multiplier, complete skid-control scheduling, and
the mapping from front-end rider attributes remain open. Supplying neutral
defaults for these is a documented implementation choice, not an exact retail
rider configuration. The powder depth ratio assumes a positive sink budget.
[[330-carve-formula]]()

> [[330-resistance]]() doc:../research/carving-response.md;
> @0x00109cb8 — scalar numerical comparison across synthetic inputs;
> rider attribute names and runtime input scheduling remain unverified.
> [[330-carve-formula]]() doc:../research/carving-response.md — response
> equation established; load-ratio and skid-control inputs remain open.

### Lateral resistance

Use signed lateral speed `w=dot(v,l)` and **absolute forward speed** `s=abs(u)`,
both in m/s. The surface's `drag` and the same rider/edge multiplier `k` give:
[[330-lateral]]()

```text
speedGain = 0.2010370344 + s*0.08899726090
              if s < 5.55555542
            0.6954662800 + (s-5.55555542)*0.03612979490
              else if s < 13.88888794
            0.9965478778 - (s-13.88888794)*0.01044131714
              otherwise
leanGain  = max(1, abs(lean)*1.0001484156)
riderGain = k*(0.0010000000475 + 1.1412174702*lateralStat)
boostGain = 1/(1+3.4999945164*boostStrength)       if boostStrength > 0
            1                                  otherwise
lateralAcceleration = -w*drag*speedGain*leanGain*riderGain*boostGain
```

The lean multiplier remains one throughout the ordinary lean range. This is
an acceleration integrated once by the ground tick; an implicit decay with a
fixed fitted bite constant is a different model. Tests can compare these scalar
helpers independently from contact and heading, then compare the integrated
heading rate, travel rate, speed and slip on the same course segment.
[[330-lateral]]()

> [[330-lateral]]() doc:../research/carving-response.md;
> @0x00109ef8 — scalar numerical comparison including speed boundaries,
> lean range, stance and boost variation.

## Visual bank and the lateral carve slide

The drawn deck banks **directly from lean**: roll = lean · 50° in normal
riding (a special state uses 65°), giving ≈ 45° of visible bank at the full
lean clamp. The roll is a pure rotation about the deck origin — no vertical
lift accompanies it (`320-ground-contact.md`). [[330-bank]]()

Separately, the deck (and the ground probe with it) **slides sideways into
the carve**: a pose offset slews toward
`−60 · lean · min(1, speed·0.694444)` units (speed in engine-units/s, the
source-unit convention for this pose formula; rate 66.7/s),
scaled by a rider-tuning byte, and is applied along the contact-frame
lateral axis to both the render position and the contact probe base
(`320-ground-contact.md`). At that scale the `min(1, …)` term saturates by
≈1.44 engine-units/s (≈1.4 cm/s) — i.e. the slide is at full magnitude for
essentially any speed above a near-standstill, not a gradual ramp
[observed]. The slide is purely in-plane. [[330-slide]]()

> [[330-bank]]() map:"Board visual bank / roll basis" — @0x00129630
> reads lean +0x214; 0.87266463 rad (50°) normal / 1.13446403 rad (65°) when
> +0x420 == 2; skipped in motion state 3; max visible ≈ 45.26° / 58.84°.

> [[330-slide]]() map:"Board visual bank / roll basis"; db:ride-height —
> target written by @0x0012950c (slew rate 66.666664), consumed in
> @0x00129630 with rider byte +0x60; same offset feeds the probe base in
> @0x00128af0.
