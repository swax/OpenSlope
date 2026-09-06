# 330 — Carving

Steering is built around one smoothed, speed-scaled **lean** signal driven by
the turn input. Lean feeds four consumers: the **heading yaw** (a direct,
capped rotation about the contact normal), the surface-tuned **carve/side
force** (`310-surface-response.md` fields), the **visual bank and lateral
pose slide**, and the carve **effects** (`380-carve-effects.md`). There is no
single "turn rate" constant: the rate emerges from input shaping, two speed
gates, and a hard per-tick cap. [[330-overview]]()

> [[330-overview]]() map:"Ground steering heading rate"; db:turn-carve.

## The lean signal

The turn input (a signed stick axis, `002-conventions.md` timebase) is shaped
into a lean target and slewed: [[330-lean]]()

```text
target = clamp(stick, ±0.9051856) · min(1, speed / speedRef)
rate   = clamp(|target − lean| · 7.017359, 0.1, 8.018349)   (per second)
on powder surface types: rate · 0.6
lean slews toward target by rate / 60 each tick
```

The speed reference is state-dependent in a narrow band
(≈ 11.19–11.38 m/s), so lean — and with it every lean consumer — fades out
linearly toward a standstill and is at full authority above roughly 11 m/s.
The same shaping serves the airborne turn input (`340-jump-air-landing.md`);
the powder rate penalty makes deep snow feel slower to edge. [[330-lean-vals]]()

> [[330-lean]]() db:air — `AirTurnLeanSlewFromInput` @0x00126950 writes
> the boarder+0x214/+0x218/+0x21c slew triple, shared by ground and air
> control; constants table in map:"Ground steering heading rate"; stick
> decode `/31.0` in the ground control update @0x00102fc8.

> [[330-lean-vals]]() map:"Ground steering heading rate" — speedRef
> 1138.27 (state 2) / 1134.97 (state 0) / 1119.01 (default) engine-units/s;
> powder multiplier 0.599972606 for surface types 3/4.

## Heading yaw

Grounded heading turns by rotating the orientation about the **contact
normal** by a per-tick angle: [[330-yaw]]()

```text
turnLean  = lean · c7 · (1 + 0.5·c0·(1 − lean²))      (state curve c0, c7)
turnLean /= (1 + jumpCharge · 0.01)                    (charging stiffens steering)
candidate = −slipAngle + turnLean                      (slip = asin of the lateral
                                                        contact-basis projection)
speedGate = min(1, speed² · 0.0000200298473 / 60)
align     = min(1, max(0, 40 · min(1, speed/555.6) · (1 − |lateral|/speed)) + 0.01)
yaw/tick  = clamp(candidate · speedGate · max(|lean|, align), ±0.104719758)
```

The cap is **6° per tick = 360°/s**. The speed gate is quadratic (half
authority at ≈ 12.2 m/s); together with the lean shaping it means a
standstill cannot yaw at all, and a full-stick carve on standard snow reaches
the 360°/s cap from about 8 m/s upward. The slip-angle term self-centers the
board toward its travel direction when the lateral slip is large.
[[330-yaw-vals]]()

> [[330-yaw]]() map:"Ground steering heading rate" — @0x0010a0d8 →
> quaternion apply helper (half-angle path, radians); curve pairs
> (0.2083,0.2622)/(0.3002,0.3492)/(0.4,0.5240) by state +0x420; slip asin
> clamp ±0.99999; charge denominator +0x208·0.01.

> [[330-yaw-vals]]() map:"Ground steering heading rate" — clamp
> ±0.104719758 rad/tick; gate half at 1223.8 u/s, 1.0 at 1730.8 u/s; worked
> full-stick case caps from ≈ 798.9 u/s.

## Carve force vs. skid

The surface's three **turn response** components and its **carve drag**
(`310-surface-response.md`) do not enter the yaw angle above; they tune the
**side-force/carve acceleration** built in the contact frame — the force that
makes an edged board actually change its velocity direction rather than just
its facing. The turn-response helper consumes the three components together
with rider tuning bytes; its output is added to the tick's acceleration along
the contact-frame tangent, and the carve-drag response acts along the lateral
axis. Ice and ramp are both authored with near-zero **turn response**, so both
steer their *facing* normally but barely bend their *path* from turn
response alone; ice additionally has near-zero **carve drag** — the ice
skid — while ramp retains snow-like lateral drag (its carve drag is close
to standard snow's). Powder's high carve drag, by contrast, eats lateral
speed. [[330-carve-force]]()

Neither response is written out as a formula. The algebra that turns the three
turn-response components into a tangential acceleration, and the one that turns
the carve-drag coefficient into a lateral one, are both untraced. What an
implementation can rely on is the *relative* magnitude across surfaces
(`310-surface-response.md`): carve drag spans three orders of magnitude from
ice (0.0025) to slow powder (3.50), and preserving that ratio is what makes ice
skid and powder bite. An implementation that remaps the column onto a bounded
grip factor flattens exactly the ratio that carries the feel. [open]
[[330-carve-formula]]()

The residual mismatch between facing and travel is the **slip**; its
magnitude (the lateral projection of velocity against the contact frame)
drives the carve audio and effects gates (`380-carve-effects.md`,
`420-audio-runtime.md`), and the self-centering term above feeds it back into
the yaw. [[330-slip]]()

> [[330-carve-force]]() db:turn-carve —
> `SurfaceMaterial_TurnResponseHelper` @0x00109cb8 consumes record
> +0x04/+0x08/+0x0c plus rider tuning bytes; result feeds the
> carve/side-force path @0x0010a38c, not the yaw quaternion; carve drag
> +0x10 applied along +0x330; surface types 6/10 special-cased @0x0010c2f0.

> [[330-carve-formula]]() db:turn-carve — the interior of
> `SurfaceMaterial_TurnResponseHelper` @0x00109cb8 and the lateral apply at
> @0x0010a38c are not decomposed to an expression; only their inputs (record
> +0x04..+0x10, rider bytes) and output axes (+0x320 tangent, +0x330 lateral)
> are established. db:surface-table (the carve-drag column).

> [[330-slip]]() db:audio — the Slip getter @0x0021aba0 is the abs
> projection of the contact tangent against velocity; lean getter
> `|lean·127|` @0x0021ac08; db:surface-trail (wake gate uses lean·(1−slip)).

## Visual bank and the lateral carve slide

The drawn deck banks **directly from lean**: roll = lean · 50° in normal
riding (a special state uses 65°), giving ≈ 45° of visible bank at the full
lean clamp. The roll is a pure rotation about the deck origin — no vertical
lift accompanies it (`320-ground-contact.md`). [[330-bank]]()

Separately, the deck (and the ground probe with it) **slides sideways into
the carve**: a pose offset slews toward
`−60 · lean · min(1, speed·0.694444)` units (speed in engine-units/s, the
same convention as every other formula in this chapter; rate 66.7/s),
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
