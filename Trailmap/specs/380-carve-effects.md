# 380 — Carve Effects

The visual feedback of riding — the snow **spray** thrown from the edge, the
carved **wake** ribbon left behind, and the **sink** of the deck into soft
snow — are all driven by the same few rider signals (speed, lean, slip,
motion state) and, for the data-driven systems, the per-surface response row
(`310-surface-response.md`). The **wake** lays continuously whenever the
board rides a wake surface — straight as well as carving — narrowing straight
and widening through a carve; the *thin slice that appears only mid-carve* is
the spry-column **spray**, a different system. The **spray** is a *composite*
of several particle systems, some carve-gated and some not: powder sprays
continuously (even straight), and a contact-normal stretched streak fires on skid/speed
and landings, alongside the lean-gated carve plumes. Sink is specified with
the contact model (`320-ground-contact.md`); this chapter covers spray and
wake. [[380-overview]]()

> [[380-overview]]() db:powder-spray; db:surface-trail — the spray emitters
> read the surface record and the lean/slip fields and key on the steady
> ground/carve motion state; the trail keys on motion state + its own
> per-surface enable table.

## Snow spray

The board spray is not one emitter but **five particle systems** in one
per-boarder container, all additive; one update pass (`sub_001350c8`) and one
render pass (`ParticleSystem_RenderAllBuffers`) walk all of them. Three are
self-contained (they read **no** surface record — only `SurfaceType`, to
branch powder-vs-not); two — the 40-slot ring and the spry-column plume —
read the per-surface material record. Each answers a different riding
situation: [[380-spray-systems]]()

| System | Fires when | Look |
|---|---|---|
| carve plume | grounded + carving (`\|lean\|>0.2`) or on powder; one puff per ≈0.7 m travelled | additive puffs 1.6 m wide at birth growing to 8 m over a fixed 2 s life, rising out of the snow as they grow; alpha ∝ lean |
| spray sheet | grounded + carving past 0.3 on snow/powder (invisible on ice); one column per 0.25 m of travel | a connected four-rail additive `spry` ribbon; the base rail sits half a metre behind the board, the three upper rails launch up-and-out of the turn at 1×/2×/3× a throw speed that ramps with the carve, then curl down under gravity and drag over 0.9 s |
| powder cloud | grounded on powder / deep powder only (hardcoded `SurfaceType∈{3,4}`) | 0.3–0.44 m puffs, count ∝ speed, lean-independent, re-placed off the board every frame so the cloud rides with it — the constant deep-snow cloud |
| landing cloud | touchdown (an immediate burst plus ~1.5 s of follow-up), or a hard sideways skid at speed | big faint squares (2.4 m → 5 m) that rise up the contact normal over 2 s — the impact dome |
| surface ring | per-surface `emit_rate` gate (below); airborne, a takeoff puff | small per-surface chunks that are **thrown** — a random share of the board's velocity plus a lateral throw out of the turn that tilts from sideways to straight up as the lean deepens — the rooster tail |

Full per-system rules (gate, rate, spawn, render curves — live-validated) are
in the sys1/sys2/sys4/sys5 Trailmap research notes.

> [[380-spray-systems]]() db:board-spray — one container walked by
> `sub_001350c8` (update) / `ParticleSystem_RenderAllBuffers` `0x00135178`
> (render): carve plume `0x0012ecb0`/`0x0012f180` (PS+0), spry-column plume
> `0x0012fef8`/`0x00130ba0` (PS+0x1c20), 40-slot BoardSpray
> `0x001311b8` (PS+0x4b60), stretched streak `0x0012e6f0`/`0x0012e920`
> (PS+0x99b0), powder `0x0012f4c8`/`0x0012fb48` (PS+0xb600). Spry-column gate
> = the per-surface material record's `+0x58` field (~0 only on ice).
> research/spray-systems.md (+ spray-render-pipeline.md for the draw path).

### The 40-slot per-surface ring

The rooster tail is a ring of at most 40 live CPU slots. A tick allocates at
most one slot, but that slot's integer gate result is also its **P6 billboard
count**, so one slot can draw several independently scattered sprites. The
gate/count is where much of the behavior lives: [[380-spray-gate]]()

```text
motion = speed · 0.006 · (1 + 149 · lean²)
value  = motion · sprayRate / 60
count  = trunc(value + random[0,1))       (0 = no slot; otherwise one slot
                                           containing `count` P6 sprites)
```

Lean enters **squared** with a ×149 weight: a hard carve fills the ring, while
straight gliding leaves a near-zero trickle (about one sprite a second on
groomed snow). When `value > 1`, notably on a hard powder carve, the same ring
slot carries multiple billboards rather than discarding the excess. Rock and
metal surfaces force the count to zero.

Each billboard is **thrown**. The slot seeds a throw from the board's own
velocity plus a lateral term `lean · 1.1 · speed` along the board's lateral
axis, soft-limited above 4.5 m/s, and the billboards of one slot then sample it
so that every chunk carries a random fraction (0…1) of the board's velocity
forward plus that lateral throw ± half a spread (3 m/s, or the throw less
1.5 m/s once the limit engages). The lateral axis is the *board's*, and the
board rolls onto its edge with the lean, so the throw is sideways at a light
lean and straight up at a full one — always out of the turn. In flight a
chunk covers `V · (0.73 t − 0.565 t²)`: it starts at three quarters of its
throw speed, decelerates, and is still by 0.54 s; a light gravity term adds a
few centimetres of sag. The spawn centre is scattered ±0.15 m along the
board's lateral and ±0.9 m along its length, so the shower leaves a strip of
the board's recent track. [[380-spray-aim]]()

Sprites are selected per surface from the shared bank
(`180-particles-data.md`), are **static** (no flipbook animation; size and
colour are fixed per particle at spawn, see 400-rendering.md), and the surface
rows draw **alpha-blended** — small opaque-ish chunks over the snow, not a
glow — while the airborne puff (below) draws additive. Alpha fades linearly to
zero over the row's fade time. [[380-spray-render]]()

> [[380-spray-gate]]() db:powder-spray — emitter @0x001311b8 (40-slot
> ring); gate/count `trunc(motion·rate·(1/60) + rand[0,1))` @0x00131724;
> exactly one CPU slot when non-zero (no CPU loop), then a1=t0 @0x00131970
> stores the P6 sprite count; motion scalar @0x001313c8, constants
> 0.006/149 exact; map:"BoardSpray snow spray (the 40-slot ring): how deep snow sprays more".

> [[380-spray-aim]]() db:powder-spray — throw built @0x001313c8–0x0013155c
> (lean·1.1·speed = 0x3f8ccccd, limits 450/150/300 = 0x43e10000/0x43160000/
> 0x43960000) and handed to `Particle_SetVelocityFromBasis` @0x001d5c88 as
> (Vbase, dirA·spread, 0, backward·f31), which stores qw6..qw9 divided by
> the slot rate; P6 reads slot+0x08 (qw0.z) as its trajectory parameter and
> flies `−(V/r)·c(a)`, c = −0.73a + 0.113a², a clamped 2.7. qw13 cleared by
> 0x001d5a40; `Particle_SetSpawnPosition` @0x001d5910 writes qw11/qw12 from
> 2×15 u along boarder+0x4a80 and 2×90 u along boarder+0x4a60. Live slot
> decode 2026-08-24 (research/spray-systems.md §3, §7).

> [[380-spray-render]]() db:powder-spray — sprite handle resolved once
> at spawn (@0x00131b00), no UV/frame step in the age path; blend = record
> +0x54 (3 = alpha-over on every snow/ice row; the air branch writes 5 =
> additive) stored at slot+0x144 and bound by the render loop @0x00132310;
> db:particle-bank (per-surface sprite indices). Draw = VU1 program P6: flat
> per-particle size from the qw1.x/z lanes (the record lifetime column, since
> `SetLifetimeRange` @0x001d57e0 writes +0x10/+0x18), alpha via qw17.w =
> −A·128/(size_max·r) × age — full model in 400-rendering.md [[400-sprites]] +
> db:powder-spray @0x001e2f58.

### Per-surface spray character

The "deep snow sprays more" look is **entirely data** — there is no powder
special case. Key rows: [measured] [[380-spray-table]]()

| Surface | Rate | Drawn width | Fade (s) | Alpha | Sprite | Character |
|---|---:|---|---:|---:|---|---|
| standard snow | 0.075 | 8–12 cm | 0.24 | 0.40 | snow chunk | light dusting of chunks |
| off-track snow | 0.159 | 12–18 cm | 0.45 | 0.41 | soft puff | medium |
| powdered snow | 0.505 | 22–33 cm | 0.58 | 0.23 | 4-point twinkle | the big rooster tail |
| slow (deep) powder | 0 | — | — | — | — | none — you sink, not spray |
| ice | 0.200 | 3–5 cm | 0.27 | 0.51 | crystal shard | brief glitter |

The record's two size-looking columns are not what they look like: the column
that reads as a *lifetime* (3.0 s snow … 7.9 s powder) is the **drawn size**
(≈3.5 cm per unit, with a ±20 % per-sprite random), and the column that reads
as a *size range* is the **fade time**, its maximum in seconds. Nothing retires
a chunk by age; it is simply invisible once faded, and its ring slot is reused
when the ring wraps. Powder carries ≈ 6.7× standard snow's rate, ≈ 2.6× the
chunk size, more than double the fade, and its own sprite. Four surface types
are authored at rate zero and spray **nothing**: the deepest, bogging powder
type and three ice/glide variants that carry no trail (`110-terrain.md`
enumerates the full surface-type list). Rock/metal/ramp also force the snow
gate to zero — they, and every rail grind, instead run the ring's
**spark gate**. [[380-spray-hard]]()

### Sparks

Riding rock or metal, or grinding a rail, the surface ring switches to
sparks: soft additive dots tinted orange-yellow — red 1.0, green 0.5–0.9 and
almost no blue per spark — at an alpha of 0.63 that fades to zero over
0.25 s while the blue channel lifts toward a pink-white. About one spark a
tick in steady state, and on a 1-in-60 roll each tick a **flare of 17–18**
with a half-again throw and a 0.65 s fade — the once-a-second burst. Each
spark is drawn as a seven-copy comet trail, the copies a few milliseconds
younger and a seventh dimmer in turn, at ≈3–4 cm each.

The throw scales with speed (`f = 2 × speed`, `3 ×` in a flare, speed capped
at 16.7 m/s): a spark leaves at `0.05 f` up and `0.1 f` backward, with
±`min(0.35 f, 11 m/s)` sideways, ±`0.2 f` along and ±`0.2 f` up of spread, from
the contact 20 ms ahead of the board (40 ms on a rail) scattered over the
same ±0.15 × ±0.9 m strip as the snow chunks. The flight is the chunk law on
a 12× clock — so it freezes after 0.22 s — under a real 20 m/s² gravity, so a
spark arcs up-and-back and drops. On a rail the sparks are laid between the
previous spawn point and the current one, so they fill the rail behind the
board whichever way the deck faces. [[380-sparks]]()

> [[380-spray-table]]() db:powder-spray — record fields rate/size
> min/max/lifetime/sprite (+0x34..+0x44), dumped values per type
> (map:"BoardSpray snow spray (the 40-slot ring): how deep snow sprays more"); types 4/7/8/11
> rate 0.

> **LIVE (2026-08-24).** The earlier "ice draws far under its size row" puzzle
> is the column swap above: ice's lifetime column (1.2) is a third of snow's
> (3.0), and that column is the size. The 3.5 cm/unit scale is the VU1
> program's resident size constant read directly out of VU1 data memory
> (research/spray-render-pipeline.md §4). The Slopesmith port draws these
> sizes; the Unity port (`RideableBoard.Fx.cs`) still carries the older
> record-size reading.

> [[380-spray-hard]]() db:powder-spray — surface types {9,13,18,19}
> zero the snow gate (f21 = 0 @0x001313b0) and, with motion state 2 or 3
> (@0x00131c2c–0x00131c64), route to the spark gate below.

> [[380-sparks]]() db:powder-spray — spark gate @0x00131c6c–0x00132164, same
> 40-slot ring: steady scalar 50 (0x42480000) → count ⌊50/60 + rand⌋; a
> rand < 1/60 roll @0x00131d3c swaps in 1050 (0x44834000), size_max 0.65
> (fade) and throw scale 3.0 for 2.0. `Particle_Init` with inner count 7,
> rate 12 (0x41400000), gravity (0,0,−2000) (0xc4fa0000); lifetime lanes
> 0.75/1.25 (size); spawn = contact + velocity·0.02 (·0.04 rail state 3) and
> the rail variant `0x001d5878` blends against the ring's anchor +0x10.
> Velocity args @0x00131fd4–0x00132094: Vbase = +0x1a0·0.05f − +0x180·0.1f,
> Va = +0x190·min(0.35f, 1111), Vb = +0x180·0.2f, Vc = +0x1a0·0.2f, f =
> scale·min(speed, 1666.67). Colour @0x001320a4–0x00132124: c0 = (128, 90, 0,
> 80), c1 = (128, 90, 90, 0), random spreads (0,50,0,0)/(0,0,50,0); sprite
> table[0] `part`, blend 5 @0x00132150–0x0013215c.

### Takeoff puff and landing cloud

Leaving the snow, not landing on it, is what the surface ring reacts to: on
the first airborne tick it seeds an emit scalar of 70 that decays ≈ 5.3 % per
tick to a floor of 10, and while airborne it puffs additive soft puffs from the
board's tail at that scalar (scaled down below ~2.8 m/s) — one or two a tick
for the first half second of flight, then a trickle. The puffs are launched
with the board's full velocity plus ±2 m/s of lateral and along-track scatter,
so they trail the airborne board and fall behind it as they decelerate. A rail
ride emits the same puff at a steady half a tick, except on metal.
[[380-burst]]()

Touchdown is the landing cloud's event. The moment the board lands, the cloud
buffer lays two to eight puffs at once (more with speed), scattered ±0.4 m
about the contact at double brightness, and seeds its activity accumulator
from the landing speed (≈1.4 at 14 m/s, capped 1.5); that accumulator then
adds a puff every two to three ticks while it leaks away over the next second
or so. Each puff is a big soft square whose half-extent and height above the
snow follow one law — 2.4 m wide and 1.1 m up at 0.2 s, 5 m wide and 2.25 m up
at 2 s — brightening in over 0.2 s and fading out quadratically, at a peak
alpha of only a few percent so the dome is the sum of many. A hard sideways
skid at speed feeds the same accumulator without the burst. [[380-landing]]()

> [[380-burst]]() db:powder-spray — air branch @0x001315e4 runs on motion
> state 1: latch obj+0x08, scalar obj+0x0c seeded 70.0 (0x428c0000), decay
> ×0.9467 (0x3f7258bf) while above 10.0 (0x41200000), scaled by
> min(1, speed/277.78); rail state 3 uses 30.0 unless SurfaceType ∈ {13,18,19};
> both write asset 13 (swp2) and blend 5, size lanes [2,4), fade 0.6, alpha
> 0.25, spawn point boarder+0x4a90, Vbase = boarder+0x150. Live 2026-08-24:
> latch 1 / scalar 70 on the first airborne frame; the ground path resets the
> latch and carries no burst.

> [[380-landing]]() db:board-spray — sys4 burst entry @0x00135270 →
> 0x0012e0f0(f12 = −speed): N = clamp(trunc(0.0009·speed), 2, 8) slots with
> ±40 u scatter and peak 0.1, then A = min(1.5, A + 1.5·(0.2 + 0.000514·speed)),
> B = 1; cadence @0x0012e6f0 spawn iff B < 0.1A+0.5, B += 1, A −= 1/60, B ×=
> 2/3 per frame; render @0x0012e920 length 600·age / 120 + 72.2·(age−0.2)
> passed to the driver sprite entry +0x244 as half-extents, centre near +
> normal·0.9·length. Live 2026-08-24: 27 slots and A 0.93 two frames after
> a 14 m/s landing.

## The carved wake

The wake is a separate effect: an **alpha-blended geometry strip** laid into
the contact plane behind the board — a ring of ~100 cross-sections, each a
left/right vertex pair, reaching tens of metres back (a long-lived track, not
a sub-second flash). Its texture coordinate advances **along** the ribbon per
segment (the groove texture tiles down the trail), and its vertices carry
neutral color with no scene lighting: the convincing light-edge/shadow-edge
"depression in the snow" is **pre-shaded into the texture**, drawn in two
offset alpha passes. The ribbon straddles the board's centerline; its two
long edges read as the classic twin grooves — close together riding straight,
spreading through a carve. [[380-wake-model]]()

Emission is **not** carve-gated: the trail lays whenever the board is in a
steady ground motion state on a wake-bearing surface, straight or carving.
The per-surface behaviour is an **enable table** (not the response record):
[[380-wake-gate]]() [[380-wake-table]]()

| Surface | Wake | Per-surface scalar |
|---|---|---:|
| standard snow, off-track, glidy, sand (1, 2, 8, 15, 16) | yes | 0.0286 |
| powdered / slow powder (3, 4) | yes — most persistent | 0.0167 |
| standard ice (5) | yes — fastest-fading scratch | 0.1998 |
| everything else (0, 6, 7, 9–14, 17–19) | none | — |

The scalar orders the trail's persistence (powder < snow < ice fade). When
the gate drops (airborne, a no-wake surface), the strip's newest sections
fade their vertex alpha down in steps toward the tip — the trail's end melts
out rather than cutting.

> [[380-wake-model]]() db:surface-trail — 101 × 64-byte cross-section
> ring at container +0x8020, header at +0x1940 (@0x00132650); left/right
> world-space vertex pair + per-vertex alpha/UV row per section; per-vertex
> UV advances along the ribbon; neutral 128 vertex color, two alpha
> passes (blend enum 4 = 0x46 / enum 8 = 0x49, `400-rendering.md`)
> @0x001331b0/0x001333c8; centered straddle;
> map:"Board snow wake / trail (SurfaceTrail)".

> [[380-wake-gate]]() db:surface-trail — update @0x00132650 reads no
> material record and no lean term: motion state ∈ {2, 5, 6}, sub-state
> ∉ {2, 3}, and the SurfaceType jump table @0x0036ac60; tail fade on gate
> loss @0x00132758; live-verified laying at lean 0.000 (straight glide,
> full ring, newest section at the board).

> [[380-wake-table]]() db:surface-trail — record fields
> +0x58/+0x5c/+0x60 per surface (map:"Surface physics table" feedback
> fields).

## Shared gating

Both effects key on the same **steady ground/carve motion state** — airborne
and rail states emit neither spray nor wake (`350-rails.md` specifies the
rail state's own motion and control; it carries no distinct spark or grind
visual presentation in this spec), and the wake additionally lays a paired
quad only in that steady state. A reimplementation should drive spray and
wake from one
"carving on the ground" predicate plus the shared lean/slip signals, never
from separate ad-hoc tests. [[380-shared]]()

> [[380-shared]]() db:board-spray; db:surface-trail — both check the
> motion-state field (+0x424 == 2) for their steady branches; the secondary
> feedback ring (jump table @0x00132650) keys the same state set {2,5,6}.
