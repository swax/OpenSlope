# Board snow-spray — the five FX systems (static + live RE)

PAL boot ELF `SLES_505.45`. The board's snow FX is **five independent sub-buffers** inside one
particle-system container `PS`, walked every frame by the dispatcher `sub_001350c8` (update) and
`ParticleSystem_RenderAllBuffers` `0x00135178` (render). This file is the behaviour of all five —
gates, rates, spawn fields, age/size/alpha curves — with the live measurements folded in. The P6 sprite draw path
used by the 40-slot ring is `spray-render-pipeline.md`; the three EE-side puff buffers draw through the driver's
plain sprite entry (`+0x244`, `0x001ddac0`) and sys2 through its geometry entry (`+0x224`). The sprite name-table
is `emitter-sprite-index.md`.

**FACT** = read off instructions/decoded constants. **INFERENCE** = reasoned. **LIVE** = measured
over PINE against a running image. Addresses virtual.

> **Revision 2026-08-24.** A second live pass with `tools/instrumentation/board_fx_probe.py` (frame-fenced
> dumps of the whole container, the boarder, the driver's VU packets and VU1 data memory) overturned several
> earlier conclusions. In particular: the 40-slot ring's billboards are **thrown, not frozen** (P6 reads the EE
> age accumulator as its trajectory parameter and the slot carries real velocities); its drawn size comes from
> the record's *lifetime* column and its fade time from the *size* column (the two range setters are swapped
> relative to what P6 reads); the "landing burst" in that ring is a **takeoff** puff gated on the airborne state;
> sys4 draws big rising squares, not streaks; and the boarder's emit basis rolls with the lean. Each corrected
> claim below is marked **LIVE 08-24**.

---

## 0. Shared architecture (FACT)

**Five independent systems, each with its own buffer off one container `PS`:**

| system | what it draws | buffer | update | render | draw path |
|---|---|---|---|---|---|
| sys1 | carve plume (ex06-09 puffs) | `PS+0` | `0x0012ecb0` | `0x0012f180` | driver `+0x244` sprite |
| sys2 | spray sheet (spry ribbon) | `PS+0x1c20` | `0x0012fef8` | `0x00130ba0` | driver `+0x224` geometry |
| BoardSpray | 40-slot surface chunks / takeoff puffs | `PS+0x4b60` | `0x001311b8` | `0x00132310` | driver `+0x25c` → VU1 P6 |
| sys4 | landing cloud (rising squares) | `PS+0x99b0` | `0x0012e6f0` | `0x0012e920` | driver `+0x244` sprite |
| sys5 | powder cloud | `PS+0xb600` | `0x0012f4c8` | `0x0012fb48` | driver `+0x244` sprite |

The alpha-blended `tral` wake is a sixth ring at `PS+0x8020` (`0x00132650` / `0x001331b0`), covered in the 380 spec.
Each system sees only its own sub-buffer and the rider — there is no shared particle pool. The buffer bases are
contiguous (`0x1c20 + 0x60 + 75*160 = 0x4b60`, `0x4b60 + 0x40 + 40*336 = 0x8020`, etc.).

**Container pointer chain (PINE, for live reads):**
```
reg      = *(0x00338E58)
worldObj = *(reg + 0x730)
boarder  = *(worldObj + 0xA4)
sm       = *(boarder + 0x5AE0)     ; boarder state-machine (a pointer)
PS       = *(sm + 0x3E0)           ; the five-buffer container
drv      = *(reg + 0x724)          ; GS render driver (its VU packets at +0x490/+0x510/+0x5b0)
VU1 data = 0x1100C000              ; mapped into EE space; PINE reads it (LIVE 08-24)
```

**Boarder fields the systems read** (all `boarder+off`): velocity `+0x150` (u/s), position `+0x140`, raw slip
`+0x1fc`, lean `+0x214` (±0.905 full), carve-edge flag `+0x1b4` (1 when lean > 0 in every capture),
SurfaceType `+0x290`, motion state `+0x424` (`1` air, `2` ground, `3` rail, `5/6` wipeout), ground sub-state
`+0x2e0` (`==2` suppresses spray), contact normal `+0x2a0`, contact point `+0x2d0`, board up `+0x1a0`, emit
basis `+0x4a60..+0x4aa0`, spawn point `+0x4a90`, state-machine ptr `+0x5ae0`.

**The emit basis (LIVE 08-24).** `+0x4a60`, `+0x4a70`, `+0x4a80` are an orthonormal right-handed frame
(`+0x4aa0 = −(+0x4a80)`), the *board's* basis: `+0x4a60` = board backward, `+0x4a70` = board up, `+0x4a80` =
board lateral. Riding straight they coincide with (−travel, normal, n×t); in a carve the frame **yaws into the
turn** (~20° at full lean) and **rolls onto the edge**: the lateral's tilt off the snow reads ~20° at lean 0.19,
~50° at 0.39, ~73° at 0.58, ~85° at 0.77 and 90° (straight up) at 0.885 — roughly `min(90°, 120°·|lean|)`.
`+0x4a90` sits 28 u behind the contact point along the travel. Both the chunk throw and the sheet launch use
this frame, and both go to the **outside** of the turn (positive lean = left turn; the throw's lateral sign is
`−(n×t)` = right).

**Common skeleton (all five):** a ring; `age += 1/60` every frame, unconditional; spawn appends (evicting the
oldest when full). Units: `100 engine-u = 1 m` for positions, velocities and the three `+0x244` sprite sizes.

**Units anchor (LIVE):** carving `|vel| = 1000–1400 u/s ≈ 10–14 m/s`; the recurring `277.78` (`0x438ae38e`)
constant is a low "actually moving" floor (~2.8 m/s).

**Colour (LIVE 08-24):** every system seeds RGB from `sm+0x474..+0x47c`, which reads ≈ (5.4, 5.0, 4.8); after the
desaturate/spread/bias step the clamp to [0,1] makes it white (sys5 clamps to 0.7 grey). Colour is not a tuning
input in practice.

---

## 1. sys1 — carve plume (`PS+0`; update `0x0012ecb0`, render `0x0012f180`)

Big additive `ex06-09` puffs, one per 0.7 m along the path while carving (or on powder), each frozen at spawn
and growing 1.6→8 m over a fixed 2 s life. The soft haze behind a carve.

**Ring (FACT):** 64 slots × **112 B** at `PS+0x10`; count `PS+0x1c10`, head `PS+0x1c14`; newest at
`head+count−1`. `age += 1/60`, expire at `age > 2.0`.

**Gate — one spawn/frame iff ALL (FACT):**
| # | condition | addr |
|---|---|---|
| G1 | grounded `boarder+0x424 == 2` | `0x0012eda0` |
| G2 | `boarder+0x2e0 != 2` | `0x0012ed98` |
| G3 | powder bypass: `SurfaceType∈{3,4}` skips the lean test; **else** `\|lean\| > 0.2` | `0x0012edbc`–`e8` |
| G4 | travel odometer `\|boarder+0x4a90 − PS[0]\| > 70.0` u | `0x0012edf0`–`ee48` |

`PS[0]` is rewritten to `+0x4a90` on every spawn (`0x0012f154`) — it is the odometer's last-spawn point.

**Spawn fields (FACT):** `+0x00` age 0; `+0x04..+0x13` random UV mirror flags (u0,v0,1−u0,1−v0); `+0x20` =
`boarder+0x4a90` (frozen); `+0x30` = `boarder+0x1a0` (board up); `+0x40` = `rng&3` → `table[24+n]` = **ex06-09**;
`+0x44` = `|lean|·0.2` (or `0.2` on powder) peak alpha; `+0x48..+0x54` colour (white after clamp); `+0x58` alpha
knee `0.2`/`0` (non-powder/powder); `+0x5c`=2.0 life; `+0x60`=80.0 size floor; `+0x64`=400.0 growth.

**Render (FACT, LIVE 08-24 sizes):** additive; sprite drawn through the driver's plain sprite entry `+0x244`,
whose `(w,h)` are **half-extents in world units**. `half = max(200·age, 80)` u → **1.6 m wide at birth, 8 m at
death**; centre lifted `half/2` along `+0x30` (up) so the square grows out of the snow. Alpha: non-powder rises
0→peak over [0,0.2 s] then falls to 0 at 2.0 s; powder is pure decay from 0.2.

**LIVE:** 44 live on a hard carve; newest peak `0.177 = 0.885(lean)·0.2`; `+0x30` ≈ contact normal.

---

## 2. sys2 — spray sheet (`PS+0x1c20`; update `0x0012fef8`, spawn `0x001306b8`, render `0x00130ba0`)

The "sheet of snow shooting out the side": a connected four-rail additive `spry` ribbon whose rails launch
up-and-out of the turn at 1×/2×/3× a throw speed and curl down under gravity and drag. The densest carve spray.

**Ring (FACT, LIVE 08-24 order):** 75 slots × **160 B** at `PS+0x1c20+0x60`; count `+0x50`, head `+0x54`.
**Newest at `head`**, older at `head+1…` (the head decrements on commit inside `RandomJitter 0x00130968`).
`age += 1/60` at `slot+0x94`; the age walk truncates the ring at the first slot past **0.9 s**.

**Per-surface (FACT):** the material record's `+0x58` (`trail_emit_intensity`, the alpha gain) and `+0x60`
(`trail_motion_scale`, the throw scale): snow `0.251/1.66`, off-track `0.600/2.00`, powder `0.259/3.00`, deep
powder `1.079/3.95`, **ice `0.0008/2.00`** → invisible on ice. Rock/metal rows carry 0 → no sheet.

**Signals (FACT):** `carve = lean·(1 − |slip+0x1fc|)` (sign from the edge flag); `seed = gain·(|carve| − 0.2)`
clamped ≥ 0; `throw = motion_scale·speed_u·carve` (u/s). Ring state: `+0x00` armed, `+0x30` jitter, `+0x34`
= `throw` low-passed (`+= (throw − lp)·0.0333`, τ ≈ 0.5 s), `+0x38` = `seed` low-passed (`0.333/0.667`, τ ≈ 3
frames), `+0x40` = launch direction low-passed (`0.8333/0.1667`), `+0x10` = last commit point, `+0x20` =
last base, `+0x04` = column counter (U).

**Launch direction (FACT):** `normalize((+0x4a60 × normal) + normal·(±record+0x5c))` — the board's lateral
toward the **outside** of the turn tilted `atan(0.4666) ≈ 25°` up the normal (snow `+0x5c` = 0.4666) — then
low-passed into `+0x40`. **LIVE 08-24:** newest column direction `(0.894, 0.435, 0.108)` = `0.43·n − 0.88·(n×t)
+ 0.19·t` on a lean-0.885 left carve.

**Gate (FACT):** unarmed → arm when grounded ∧ `+0x2e0 != 2` ∧ `|carve| > 0.3`: zero `+0x34`, seed `+0x38`,
lay two zero-throw cap columns, armed. Armed → close (one alpha-0 cap column, unarmed) when the throw's sign
differs from `+0x34`'s or when `+0x38` decays below 0.02; otherwise every frame: low-pass the three signals and
**append a column** (`AppendQuad 0x001306b8`). The head only advances (via the jitter step) when the contact has
moved **> 25 u (0.25 m)** since the last commit; between commits the head column is re-written in place, so
the ribbon tracks the board and commits one column per 0.25 m. Jitter `+0x30` random-walks by ±0.133 per commit,
reflected into ±0.3.

**Column (FACT, `AppendQuad`):** `f22 = +0x34·(1 + jitter)`; **`V_i = dir·(i·0.25·f22)`** for rails i=0..3
(stored `+0x40/+0x50/+0x60/+0x70`); `base = contact − (±+0x4a60)·50` (0.5 m behind the board along its own
backward axis); **`p_i = base + V_i/speed_mps`** (`+0x00..+0x30`) — so the rails start `i·0.25·motion_scale·carve`
metres apart *whatever the speed* (0.41 m on snow at full carve, 0.75 m on powder); `+0x80` = alpha seed
`+0x38·(1 + 1.2·jitter)` clamped [0,1]; `+0x84..+0x8c` = 1.0 (white); `+0x90` = U = `−0.25·counter`; `+0x94` = 0.
**LIVE 08-24:** at 9.93 m/s on a lean-0.885 carve, `+0x34 = −1771` → `f22 = −1877` → rail velocities exactly
`1×/2×/3× 469 u/s` along `−(+0x40)`, rail spacing 47.3 u = 469/9.93 ✓, alpha seed 0.187 ✓.

**Rail motion (FACT + LIVE):** per frame for i = 1..3: `p_i += V_i/60`; `V_i += (−3.5·V_i + worldDown·2800·(0.25·i)²)/60`
— drag 3.5/s, gravity `175·i²` u/s². Rail 0 is frozen. The oldest live columns (0.9 s) read exactly
`V_i = (0, 0, −50·i²)` — the terminal velocity `g/drag` — confirming both constants. The outer rail arcs ~1 m up
and 3–4 m out before falling back through the snow; the near rail barely leaves the ground.

**Render (FACT):** additive; `alpha = slot+0x80·(0.9 − age)·1.111·128`, white vertex colour; `0x00130ba0`
builds a connected strip across successive columns through the driver's geometry entry (`+0x224`), maps V
`0.98/0.66/0.34/0.02` across the four rails, U from `+0x90`, one `spry` texture (table[3]) over the sheet, and
calls the descriptor writer `+0x1c8` with depth mode 0 (always-pass) first, so the ground rail draws over the
terrain. Does **not** fire on a landing (needs a carve).

---

## 3. 40-slot BoardSpray — the surface chunks + takeoff puffs (`PS+0x4b60`; update `0x001311b8`, render `0x00132310`)

The per-surface data-driven spray: small chunks (`blb1` snow / `swp2` off-track / `str3` powder / `cnf2` ice),
**alpha-blended, thrown** along a random blend of the board's own velocity and a lateral throw that rotates
from sideways to straight up with the lean, decelerating over ~0.5 s. Airborne, the same ring puffs additive
`swp2` from the board's tail.

**Ring (FACT, LIVE 08-24 header):** 40 slots × **336 B** (`0x150`), slot base `+0x40`. Header: `+0x00` count,
`+0x04` head, `+0x08` air latch, `+0x0c` air scalar. Newest at `head+count−1`. When full, a spawn evicts the
oldest. Per slot the update calls only `Particle_AgeIntegrateStep` (`age += (1/60)·slot+0x3c`, `+0x3c = 5.0`), so
`slot+0x08` = `5·t`. **Nothing retires a slot by age**: a slot lives until evicted; it is invisible once its alpha
has faded (below). Straight on groomed snow the ring sits at 40 with the head creeping ~1/s.

**Emission — ground (FACT):** `motionScalar = speed_u·0.006·(1 + 149·lean²)`, `count = trunc(motion·emit_rate/60
+ rand[0,1))`; zero skips the tick, else **one** slot with that many P6 billboards. Surfaces {9,13,18,19} force
zero (no snow spray on rock/metal). Straight on snow that is ~1 sprite/s; a full carve on snow 1–2/frame; a full
carve on powder ~9/frame in one slot.

**Emission — air and rail (FACT, LIVE 08-24; formerly misread as a landing burst):** the branch at `0x001315e4`
runs when motion state is **1 (airborne)**: on the first airborne frame (`+0x08 == 0`) the scalar `+0x0c` is set
to **70**, then decays `×0.9467/frame` while above 10; `count = trunc(scalar·min(1, speed/277.78)/60 + rand)`,
no record rate. So leaving the snow throws 1–2 puffs/frame for ~0.6 s then ~1 per 6 frames for the rest of the
flight. Rail state 3 uses a constant 30 (0.5/frame) except on surfaces {13,18,19}. Both branches use sprite
**13 `swp2`**, additive (blend 5), alpha 0.25, size lanes `[2,4)`, fade 0.6 s, spawn point `+0x4a90` (the tail),
and `Vbase = velocity`. On touchdown (state 2) the latch clears and the ground law takes over — the ring has no
landing burst of its own (that is sys4, §4).

**Spawn — what each P6 lane receives (FACT, LIVE 08-24 decoded from live slots):**
- `qw0.x` = count (`t0`), `qw0.y` = 1 (inner trail count), `qw0.z` = age accumulator (`slot+0x08`), `qw0.w` =
  `0.125/count` (per-billboard age offset).
- `qw1` = `[(Lmax−Lmin), (Smax−Smin)·5, (2Lmin−Lmax), (2Smin−Smax)·5]` with L = `lifetime_base·[0.8,1.2]`,
  S = `size_min/max`. Live snow: `(1.203, 0.532, 1.203, 0.149)`. **P6 reads `.x/.z` as its size lanes** → the
  drawn size is `L·[0.8,1.2)` = the record's *lifetime* column; the size column only reaches the dead `.y/.w`
  lanes. The record's `size_max` instead sets the **fade time** through `qw17`.
- `qw5` = `(0,0,−100)/r² = (0,0,−4)` (gravity, negligible: ~6 cm over the visible life).
- `qw6..qw9` from `Particle_SetVelocityFromBasis 0x001d5c88`: `qw6 = (Vbase − 1.5·(Va+Vb+Vc))/r`, `qw7 = Va/r`,
  `qw8 = Vb/r`, `qw9 = Vc/r` — the SSF pre-bias, so each billboard gets `V = Vbase + Va·(R3−1.5) + Vb·(R4−1.5)
  + Vc·(R5−1.5)`, R uniform in [1,2).
- `qw10 = contact − 1.5·(A+B)`, `qw11 = A = 2·15u·(+0x4a80)`, `qw12 = B = 2·90u·(+0x4a60)`: a stable-random
  scatter of ±15 u along the board's (rolled) lateral and ±90 u along its backward axis. `qw13 = 0`
  (`Particle_ClearBatchStep`).
- `qw14 = (128,128,128, alpha·128)`, `qw15 = qw16 = 0`, `qw17 = (0,0,0, −alpha·128/(size_max·r))`. Live snow:
  `(…, 51.3)` and `−42.32` ✓.
- `+0x140` texture (record `+0x44` → `blb1`), `+0x144` blend = record `+0x54` = **3 (alpha-over)** on every
  snow/ice row; the air/rail branch writes 5 (additive).

**The ground throw (FACT, LIVE 08-24):** with `dirA = +0x4a80` (rolled lateral), `dir2 = +0x4a60` (backward),
`V0 = velocity`, `lat = ±lean·1.1·speed_u` (sign from the edge flag, i.e. toward the outside of the turn):
```
d = V0·dirA + lat
if |d| >= 450: pull the dirA component back to sign(d)·(450 + 0.5·(|d| − 450)); spread = |d| − 150
else:          spread = 300
Vbase = V0 + dirA·lat  (with the pull-back)
f31 = Vbase·dir2;  Vbase −= dir2·0.5·f31          (≈ −0.5·V0: dir2 is backward)
Va = dirA·spread;  Vb = 0;  Vc = dir2·f31          (≈ +V0)
```
so `V = V0·u + dirA·(lat' + spread·(w − 0.5))`, u,w uniform in [0,1): every chunk carries between nothing and the
full board velocity forward, plus a lateral throw around `lat'` (a full carve at 12 m/s: `lat` 1170 u/s pulled to
810, spread 1020 → 300…1320 u/s) along an axis that is sideways at small lean and **straight up** at full lean.
Live slot decode on a lean-0.885 carve: `dirA·(−842)` recovered against a predicted −840; `|Vc| = 1130 = speed`.

**Flight (FACT, from P6):** with `a = 5·t`, `ac = min(a, 2.7)`, `c = −0.73·ac + 0.113·ac²`:
`pos = centre + qw5·(a + c) − (V/5)·c` = `centre + V·(0.73t − 0.565t²)` for t ≤ 0.54 s, then frozen at
`0.229·V`. A chunk thrown at 8 m/s travels ~1.1 m in the 0.24 s snow fade, ~1.8 m in the 0.58 s powder fade.

**Per-surface record:**
| surface | emit_rate | drawn size (`≈3.5 cm × lifetime`) | fade (= `size_max`) | alpha | sprite | blend |
|---|--:|---|--:|--:|---|---|
| 1 standard snow | 0.075 | 3.0 → 8–12 cm | 0.24 s | 0.40 | `blb1` chunk | 3 alpha |
| 2 off-track | 0.159 | 4.3 → 12–18 cm | 0.45 s | 0.41 | `swp2` puff | 3 alpha |
| 3 powdered snow | 0.505 | 7.9 → 22–33 cm | 0.58 s | 0.23 | `str3` twinkle | 3 alpha |
| 4 slow/deep powder | **0** | — | — | — | (sprays nothing) | — |
| 5 ice | 0.200 | 1.2 → 3–5 cm | 0.27 s | 0.51 | `cnf2` shard | 3 alpha |
| air / rail puff | 70→10 / 30 | [2,4) → 7–14 cm | 0.6 s | 0.25 | `swp2` | 5 additive |

The "ice draws far under its size row" puzzle is resolved by the lane swap: ice's *lifetime* (1.2) is a third of
snow's (3.0), and that column is the size.

**LIVE 08-24:** carve on snow: 1 slot/frame, count 1–2, blend 3, sprite 16; the newest slots' `qw6..qw9`
reproduce the formulas above to three figures. Air: latch 1, scalar 70 on the first airborne frame; the air
slots hold `Vbase = velocity`, `qw7 = 80·lateral`, `qw8 = 10·up`, `qw9 = 80·backward`.

### 3a. The spark gate (FACT, `0x00131b28`–`0x00132164`) — rails and rock/metal

After the snow spawn, the same function runs a second gate when motion state is 2 (ground) or **3 (rail)** and
SurfaceType ∈ {9, 13, 18, 19}. It reuses the 40-slot ring but with its own constants:
- **Count:** `⌊50/60 + rand⌋` per frame (≈1); a `rand < 1/60` roll (`0x00131d3c`) makes it a **burst**
  `⌊1050/60 + rand⌋` = 17–18 and swaps throw scale 2.0→3.0 and fade 0.25→0.65 s.
- **`Particle_Init(count, inner = 7, gravity = (0,0,−2000), 0.025, 0.007, r = 12)`**: seven P6 trail copies per
  dot (`qw2.y = 0.084` clock units younger each, alpha −1/7 per copy), `qw5 = (0,0,−13.9)` (a real 20 m/s²),
  the age clock 12× wall time (the drag curve freezes at 0.225 s).
- Size lanes `SetLifetimeRange(0.75, 1.25)` → 3–4 cm dots; fade via `SetSizeRange(0.1, f25)` → `size_max` =
  0.25 s (0.65 burst).
- **Spawn point** = contact `+0x2d0` + velocity·0.02 (·0.04 on a rail), scatter `qw11/qw12` = 2×15 u along
  `+0x4a80`, 2×90 u along `+0x4a60` as for snow. On a rail the position setter is `0x001d5878`, which blends
  the current point against the ring's anchor `+0x10` (the last spawn point), so the sparks fill the rail
  between spawns.
- **Velocity** (`f = scale·min(speed, 1666.67)`, `spread = min(0.35f, 1111)`): `Vbase = up(+0x1a0)·0.05f −
  fwd(+0x180)·0.1f`, `Va = lat(+0x190)·spread`, `Vb = fwd·0.2f`, `Vc = up·0.2f`.
- **Colour:** `c0 = (128, 90, 0, 80)` → R 1.0, G 0.7, B 0, **A 0.625**; `c1 = (128, 90, 90, 0)` so the fade
  lifts B to 0.7 while A → 0; random spreads `qw15 = (0,50,0,0)`, `qw16 = (0,0,50,0)` give G ∈ [0.51, 0.90),
  B ∈ [0, 0.2) per dot. **Orange-yellow additive `part` (table[0]), blend 5.** The ring header `+0x24` also
  receives a grey/orange quad from `sm+0x0c` — a slewed 0..1 value — that the render loop does not read.
- The old "hard-surface grit, lifetime 0.75–1.25 s" reading was this gate's size lanes misread as a lifetime.

---

## 4. sys4 — landing cloud (`PS+0x99b0`; update `0x0012e6f0`, render `0x0012e920`, burst `0x0012e0f0`)

Big faint additive squares that rise up the contact normal — the touchdown dome, also fed by hard sideways skids.
Formerly described as velocity-stretched streaks; it is not (LIVE 08-24): the renderer draws an axis-aligned
sprite whose half-extent *and* height above the near point both follow one length law.

**Ring (FACT):** 30 records × **80 B**; count `+0x960`, head `+0x964`, cadence B `+0x968`, activity A `+0x96c`.
Age `slot+0x40`, life **2.0 s**, compacting FIFO, newest at `head+count−1`.

**Accumulator (FACT):** `A += 0.05 (clamp 1.0)` iff `+0x2e0 != 2 ∧ |slip+0x1fc| > 0.7 ∧ +0x424 == 2 ∧ speed >
277.78`. While `A > 0`: spawn iff `B < A·0.1 + 0.5`, then `B += 1`; `A −= 1/60`. Every frame `B ×= 2/3`. Net: one
puff per 2–3 frames while active.

**Touchdown (FACT, LIVE 08-24):** the container's event entry `0x00135270` → `0x0012e0f0(f12 = −speed_u)`:
`N = clamp(trunc(0.0009·speed_u), 2, 8)` slots at once, scattered ±40 u about the contact, each with peak `0.1`;
then `A = min(1.5, A + 1.5·(0.2 + 0.000514·speed_u))`, `B = 1`. A 14 m/s landing seeds A ≈ 1.4 and the cadence
then lays ~25 more puffs over the next 1.3 s (live: 27 slots, A 0.93 two frames after touchdown). The sibling
`0x00135260` → `0x0012e010` is a single-slot kick (`A += 0.5`, cap 2).

**Spawn (FACT, `0x0012e338`):** `+0x00` near point = contact `+0x2d0` + planar velocity × random `[0.1, 0.2)`
(1–2 m ahead at speed); `+0x10` = contact normal; `+0x20..0x2c` colour (white); `+0x30..0x3f` UV mirror;
`+0x44` = `rng&3` → ex06-09; `+0x48` = peak `W = A·0.05` (burst slots 0.1).

**Render (FACT, LIVE 08-24):** additive. Length `len = age·600` (age < 0.2 s) then `120 + 72.2·(age − 0.2)` u;
the sprite is drawn through `+0x244` with **half-extents `(len, len)`** — 2.4 m wide at 0.2 s, 5 m at 2 s — at
`near + normal·0.9·len` (1.1 m → 2.25 m above the snow). Brightness `W·age/0.2` then
`W·(2−age)·0.5556·(0.6 + 0.222·(2−age))`. Thirty of these overlapping at α ≤ 0.07 is the bright dome that
hugs the ground at touchdown and lifts off as it fades.

**LIVE:** A = B = count = 0 through a clean hard carve — sys4 throws nothing on a clean carve.

---

## 5. sys5 — powder cloud (`PS+0xb600`; update `0x0012f4c8`, render `0x0012fb48`)

The constant powder cloud that rides with the board. Self-contained (no material record).

**Ring (FACT):** 64 slots × **52 B** at `s3+0x50`; count `+0xd50`, head `+0xd54`, newest at `head+count−1`.
`age += 1/60` at `slot+0x00`, retire at `age > 1.0`; draw-cull at `age >= slot+0x28` (≈0.36–0.54 s).

**Frame (FACT):** every update rewrites the buffer's frame from the *current* rider: `+0x00` origin = contact
point (`+0x2d0`, or position when airborne), `+0x10` = planar velocity direction, `+0x20` = travel × normal,
`+0x30` = normal, `+0x40..` = colour clamped to 0.7 grey.

**Gate (FACT):** `+0x2e0 != 2` ∧ `+0x424 == 2` ∧ `SurfaceType ∈ {3,4}` — a hardcoded range, not the record.
**Count:** `max(1, round(speed_u / 1270.695))` per frame, lean-independent.

**Spawn fields (FACT):** `+0x04..+0x13` random UV mirror; `+0x14/+0x18` = rand `[−44.17, +44.17)` u scatter;
`+0x1c` = `rng&3` variant; `+0x20` = 0.16997 alpha; `+0x24` = 0 knee; `+0x28` lifetime =
`rand[0.8,1.2)·0.4465·min(1, speed/972.22)`; `+0x2c` max half-size = `rand[0.8,1.2)·18.49` u; `+0x30` grow =
`rand[0.8,1.2)·113.95` u.

**Render (FACT, LIVE 08-24 sizes):** additive; sprite `table[24 + variant]` = ex06-09. `half =
min((grow/life)·age, maxHalf)` — pops open in 4–6 frames then holds — drawn through `+0x244` as half-extents, so
each puff is **0.3–0.44 m wide** (the earlier 0.45 m eyeball estimate, now explained). Position is rebuilt every
frame off the buffer's *current* frame: `origin + travel·(scatterA − 200·age) + side·scatterB + normal·half/2`,
so the cloud hugs the board and each puff slides backward at 2 m/s. Alpha `0.17·(1 − age/life)`.

**LIVE:** count 61–64 on powder straight at 13–18 m/s; co-active with sys1 (the powder bypass).

---

## 6. Cross-system summary

| system | buffer | slots×B | life | gate | sprite | size | motion |
|---|---|---|--:|---|---|---|---|
| sys1 plume | `PS+0` | 64×112 | 2.0 s | ground + (powder or lean>0.2) + 70 u odometer | ex06-09 | 1.6→8 m | frozen, lifted as it grows |
| sys2 sheet | `PS+0x1c20` | 75×160 | 0.9 s | armed carve > 0.3, snow/powder only | `spry` ribbon | rails 0.41·i m apart (snow) | rails thrown 1/2/3× up-and-out, drag 3.5, g 175·i² |
| 40-slot ring | `PS+0x4b60` | 40×336 | fade 0.24–0.6 s | motion·rate (ground) / 70→10 (air) | per surface, alpha-blend | 3.5 cm × lifetime col | **thrown**: V0·u + lateral throw, P6 drag curve |
| sys4 cloud | `PS+0x99b0` | 30×80 | 2.0 s | A>0: touchdown burst, skid > 0.7 | ex06-09 | 2.4→5 m squares | frozen near point, rises 0.9·len up the normal |
| sys5 powder | `PS+0xb600` | 64×52 | ~0.45 s vis | ground + SurfaceType∈{3,4}; speed-count | ex06-09 | 0.3–0.44 m | re-placed off the live board frame, −2 m/s |

**Open leads:** the exact roll law of the board basis versus lean (five samples, ~`120°·lean` clamped 90°);
which caller fires the sys4 kick `0x00135260`; whether `+0x4a90` is the board's tail or a fixed 28 u offset.

## 7. Live capture log (2026-08-24, `board_fx_probe.py`, PCSX2 2.6.3, PAL, Garibaldi race)

| capture | state | what it settled |
|---|---|---|
| `straight-1635` | ice, straight, 16.8 m/s | ring full at 40 with head creeping; all other buffers empty; basis = (−travel, up, lateral) |
| `powder-straight-14501` | snow just after a flight | air slots: `swp2`, blend 5, `qw1=(2,1,0,1)`, `Vbase = velocity` |
| `carve+31-14814/-14980` | snow, lean 0.885, 9.9 m/s | ground slots' `qw6..qw9` reproduce the throw law; sys2 rails 1/2/3×469 u/s; basis rolled to −normal |
| `air-15048` | airborne | latch 1, scalar 70 on the first airborne frame |
| `land0..3` | touchdown + 2.5 s | sys4 burst + A 0.93, near points 1–2 m ahead, `dir = normal`; A 0.30 after 2.5 s |
| lean sweep | steer 6…31 both sides | the emit basis roll versus lean (§0) |
