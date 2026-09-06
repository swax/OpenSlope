# 310 — Surface Response

Almost everything that makes one surface ride differently from another — how
hard it pushes back, how deep the board sinks, how fast it lets you go, how it
turns, what it sprays — is **data, not code**: a single per-surface-type
**response table** that every grounded helper indexes by the rider's current
surface type. There is no special-case "deep powder" or "ice" branch in the
motion code; powder bogs and ice skates because their table rows say so.
[[310-table]]()

The table is **runtime-authored by the engine binary**, not shipped in the
level files: the level supplies only the surface-type *labels* on terrain
patches and collision surfaces (`110-terrain.md`, `130-collision-data.md`),
and one global table supplies the responses for all levels. The table holds
**20 records**, indexed by surface type; the 19 types defined in level data
(0–18, `110-terrain.md`) each get a record, leaving the table's last record
unreferenced by any authored surface. Each record is a fixed block of
scalar fields. [[310-authoring]]()

> [[310-table]]() db:surface-table; map:"Surface physics table" —
> reached as `GlobalGameStatePtr(0x00338e58) → +0x730 → +0x24 +
> SurfaceType*100`; consumed by the ground update @0x0010a0d8 and the shared
> update @0x001171a0; db:physics (level data has no friction/grip constants).

> [[310-authoring]]() map:"Surface physics table" — 20 records × 100
> bytes allocated at course load (@0x0017e5a0) and filled by
> `SurfaceMaterialTable_InitDefaults` @0x002566b8; no level serialization path
> found for these values. Dump via `ssx_analyze.py surface-table`.

## Record fields and where each feeds the model

A record's fields, by role (the chapters listed define the consuming
behavior): [[310-fields]]()

| Field | Role | Consumed in |
|---|---|---|
| contact stiffness | restoring strength of the soft ground contact | `320-ground-contact.md` |
| contact damping | damping on into-surface velocity | `320-ground-contact.md` |
| sink budget | how deep the deck may float into the surface | `320-ground-contact.md` |
| bog depth | near-surface drag-zone depth (deep-powder bog) | `320-ground-contact.md` |
| visual lift | per-surface render lift of the drawn deck | `320-ground-contact.md` |
| turn response (3 components) | carve/side-force tuning | `330-carving.md` |
| carve drag | lateral drag while carving | `330-carving.md` |
| speed target gain | per-surface cruise speed target | `360-speed-and-boost.md` |
| speed response multiplier | scales the cruise re-acceleration | `360-speed-and-boost.md` |
| carve tilt angle (degrees) | banks the contact frame the carve force acts in | `330-carving.md` |
| ground threshold | maximum above-surface clearance retained by the grounded state | `320-ground-contact.md` |
| spray rate / size / lifetime / sprite | snow-spray look | `380-carve-effects.md` |
| spray color / alpha (trailing bytes, untraced consumer) | [open] | not consumed by any traced chapter |
| wake emit / width / advance | carved wake ribbon | `380-carve-effects.md` |

> [[310-fields]]() db:surface-table; map:"Surface physics table" (field
> map: +0x00 stiffness A, +0x24 damping P, +0x20 sink budget, +0x1c bog,
> +0x28 lift, +0x04/+0x08/+0x0c turn, +0x10 carve drag, +0x14 carve tilt in
> DEGREES (58.3 everywhere but ice 45.0 and rock 21.34): the ground update
> @0x0010a278 forms `record+0x14 · (π/180) · lean`, sincos's it @0x00251140, and
> scales the contact normal by the cosine and the lateral axis by the sine into a
> banked contact frame; +0x18 ground threshold, compared with contact
> clearance by the ground-to-air exit at @0x0010ab4c..@0x0010ab78,
> +0x2c/+0x30 speed
> gain/mult, +0x34..+0x44 spray rate/size/lifetime/sprite (traced,
> 380-carve-effects.md), +0x44..+0x54 further spray-record bytes with no
> traced consumer [open], +0x58..+0x60 trail); db:surface-accel-rate;
> db:surface-speed-response; db:turn-carve; db:snow-sink; db:surface-trail;
> db:powder-spray.

## The motion constants

**Scope note.** The measured values below are retail-derived functional facts,
carried under the RETAIL-DERIVED FACTS section of `Trailmap/NOTICE`;
`specs/data/ride-v1.json` is the authoritative copy. Slopesmith and both Unity
ride layers use generated views of that file; handwritten ports are not
authoritative. This is an engineering/provenance decision, not a conclusion about
copyrightability. If counsel determines that any row reflects protectable authored
choice rather than purely functional interoperability data, the follow-up is to
make that field import-only from the user's disc.

Measured values for **all twenty records** (`110-terrain.md` gives the
enumeration for types 0–18; sink/bog/lift are in centimeters at the world scale
of `002-conventions.md`, speed targets converted to m/s): [measured]
[[310-values]]()

| Type | Surface | Stiffness | Damping | Sink (cm) | Bog | Lift (cm) | Speed target (m/s) | Speed mult | Carve drag |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | reset / out of bounds | 989.83 | 11.61 | 117.84 | 100.00 | 1.33 | 0 | 0 | 1.000 |
| 1 | standard snow | 1300.85 | 5.01 | 2.50 | 0.50 | 1.74 | 14.40 | 2.00 | 1.202 |
| 2 | standard off-track | 1200.45 | 5.53 | 3.09 | 0.50 | 1.00 | 12.69 | 1.81 | 1.509 |
| 3 | powder snow | 1151.31 | 2.84 | 29.78 | 15.09 | ≈0 | 11.25 | 3.09 | 3.001 |
| 4 | slow powder snow | 999.14 | 2.98 | 35.63 | 25.20 | 0.22 | 10.03 | 2.02 | 3.503 |
| 5 | ice | 1350.93 | 4.05 | 2.25 | 0.50 | 2.04 | 17.79 | 3.00 | 0.0025 |
| 6 | bounce / unrideable | 980.00 | 30.00 | 20.00 | 10.00 | 10.00 | 14.58 | 2.20 | 1.000 |
| 7 | ice/water, no trail | 980.00 | 45.21 | 30.27 | 13.82 | 9.69 | 11.33 | 2.39 | 0.196 |
| 8 | glidy (heavy snow particles) | 980.00 | 39.40 | 23.52 | 14.35 | 10.00 | 12.01 | 2.01 | 1.580 |
| 9 | rock / off-track | 980.00 | 30.00 | 1.54 | 0.50 | 2.02 | 5.44 | 1.68 | 0.892 |
| 10 | wall | 980.00 | 30.00 | 20.00 | 10.00 | 10.00 | 14.58 | 2.20 | 1.000 |
| 11 | no trail, ice-crunch sound | 980.00 | 17.93 | 1.00 | 0.50 | 1.35 | 7.31 | 1.47 | 0 |
| 12 | no sound, no trail, small wake | 980.00 | 30.00 | 6.32 | 0.50 | 2.02 | 15.11 | 2.21 | 0.892 |
| 13 | off-track metal | 980.00 | 0 | 1.51 | 0.50 | 3.85 | 16.92 | 1.43 | 0.100 |
| 14 | speed, grinding sound | 980.00 | 30.00 | 5.14 | 0.50 | 2.18 | 18.15 | 2.20 | 0.030 |
| 15 | standard | 980.00 | 30.00 | 20.00 | 10.00 | 10.00 | 14.58 | 2.20 | 1.000 |
| 16 | sand | 980.00 | 30.00 | 20.00 | 10.00 | 10.00 | 14.58 | 2.20 | 1.000 |
| 17 | no collision | 980.00 | 30.00 | 20.00 | 10.00 | 10.00 | 14.58 | 2.20 | 1.000 |
| 18 | show-off ramp / metal | 1350.86 | 40.01 | 5.05 | 0.50 | 1.08 | 16.68 | 3.00 | 1.209 |
| 19 | (spare, no authored surface) | 980.00 | 30.00 | 20.00 | 10.00 | 10.00 | 14.58 | 2.20 | 1.000 |

The pattern to preserve: the **two powder types** carry an order of magnitude
more sink and bog than every rideable hard surface — snow, ice, rock, ramp
(the reset and wall rows are non-gameplay/wipeout-trigger surfaces, not
comparable "hard riding" surfaces); the board genuinely buries and bogs,
`320`; **ice** has near-zero turn response and near-zero carve drag
(you cannot bite the edge) but the **highest speed target** among the surfaces
a course actually rides on; **rock** has a
heavily damped, dead contact and the lowest speed target (riding off-track is
slow); the **ramp** type is a fast, heavily damped, hold-your-line surface.
[measured] [[310-pattern]]()

## The rows the names do not describe

Only nine rows are individually authored. **Six rows are byte-identical** — the
generic record shared by types 6, 10, 15, 16, 17 and the spare 19: stiffness
980, damping 30, a 20 cm sink over a 10 cm bog, and the 14.58 m/s target. Every
surface a course never means to be ridden on falls back to that one row.
[measured] [[310-generic]]()

The remaining rows are individually authored but **their labels describe their
audio and effects, not their physics** — an implementation that folds a type
onto the family its name suggests gets the wrong constants every time:
[measured] [[310-misleading]]()

- **type 7 "ice/water, no trail"** shares nothing with ice (5). It has the
  generic 980 stiffness, the **heaviest damping in the table** (45.21, dead
  contact), and a 30 cm sink — deep-powder territory, not ice's springy 2.25 cm.
- **type 8 "glidy"** sinks 23.5 cm, not standard snow's 2.5 cm, and is likewise
  heavily damped.
- **type 11 "ice-crunch"** is the only row with **zero carve drag** — the one
  surface on which an edge cannot bite at all — and it is not an ice row either.
- **type 13 "off-track metal"** is the only row with **zero contact damping**.
  The soft contact spring's damping term vanishes there; the engine's capped
  pushout still settles it (`320-ground-contact.md`), but a reimplementation
  that carries the spring as a damped *position* state has nothing to settle it.
- **type 14 "speed, grinding"** carries the **highest speed target in the whole
  table**, 18.15 m/s — faster than ice.
- **type 16 "sand"** is exactly the generic row. [measured] [[310-misleading]]()

> [[310-values]]() db:surface-table — full dump in map:"Surface physics
> table" (CSV block); regenerate with `ssx_analyze.py surface-table
> --format csv`. Speed target = gain × 27.7778 engine-units/s (db:
> surface-accel-rate), quoted here ÷100 for m/s. Sink/bog/lift = record
> +0x20/+0x1c/+0x28.

> [[310-pattern]]() db:surface-table — turn components: ice
> (0, 0, 0.00254) and ramp (0, 0, 0.0026) vs snow (0.0020, 0.0020, 0.0075);
> carve drag ice 0.0025 vs powder 3.0–3.5; db:snow-sink (powder sink/bog).

> [[310-generic]]() db:surface-table — records 6/10/15/16/17/19 are
> identical across every motion field (+0x00, +0x1c..+0x30); only their
> spray/trail tails and the level's own labelling distinguish them.

> [[310-misleading]]() db:surface-table — record +0x24 (damping P) is
> 45.21 on type 7, 39.40 on type 8, 17.93 on type 11 and exactly 0 on type 13;
> +0x10 (carve drag) is exactly 0 on type 11; +0x2c (speed gain) is 65.34 on
> type 14 vs 64.04 on ice; type 16 matches the generic record field for field.
> Labels come from `110-terrain.md`'s observed enumeration, which is derived
> from level authoring and audio behavior, not from these constants.

## Per-surface fields ease in, not snap

The rider does not consume the table rows directly for the contact fields:
the sink budget, bog depth, and visual lift are **rate-limited copies** held
on the rider, each slewing toward the current surface's value at **1 m/s**
(100 units/s). Crossing from packed snow onto deep powder therefore eases the
~30 cm sink in over a third of a second rather than snapping the board
downward — the easing is part of the surface feel and must be reproduced.
The visual-lift copy additionally slews toward zero whenever the rider is not
in the normal ground motion state. [[310-slew]]()

> [[310-slew]]() db:snow-sink — slews in `BoarderMotion_SharedUpdate`:
> budget @0x00117894 (boarder+0x298 ← record+0x20), bog @0x00117850
> (+0x294 ← +0x1c), lift @0x00117690 (+0x308 ← +0x28, ground state only);
> shared max step 1.6666666 units / 60 Hz tick = 100 units/s.

## Surface type beyond the table

Two surface types are not intended riding surfaces: the "bounce/unskiable"
and "wall" types trigger the wipeout instead of a normal contact when hit
with enough lateral speed (`300-rider-states.md`) — below that speed they
still carry full riding constants and contact normally. The reset type (0) is an ordinary
table row for physics purposes; the course reset it causes is a course-level
mechanism (`390-pickups-and-race.md`). Surface type also selects the ride
**audio** family through a separate fixed surface-to-audio-group mapping
(`420-audio-runtime.md`) and reaches the rider from props as well as terrain
when a prop is rideable (`130-collision-data.md`). [[310-special]]()

> [[310-special]]() map:"Out-of-bounds reset / wipeout recovery"
> (surface 6/10 crash gate in the ground update); db:oob-reset (no physics branch on
> type 0); db:audio (`SnowAudio_SurfaceTypeToGroup` @0x0020fe00);
> db:rideable-props (prop surface type feeds the same response path).
