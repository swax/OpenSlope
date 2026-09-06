# Board snow-spray — the render pipeline (slot → pixels)

PAL boot ELF `SLES_505.45`. How one live spray ring slot becomes a drawn sprite: the slot struct and
its over-life curves, the EE-side aging, the GS-driver emit-quad, and the VU1 microprogram (P6) that
actually expands each particle. Settles the two long-standing questions — **does a spray sprite translate
after spawn, and is its size flat or growing?** — from the VU1 program that consumes the draw packet.
The per-system behaviour (gates/rates/spawn) is `spray-systems.md`; the sprite table is
`emitter-sprite-index.md`. **FACT** = instructions/bits/constants. **INFERENCE** = interpretation.

The 40-slot BoardSpray ring is the worked example (336 B, base `+0x40`, stride `0x150`); the other four
buffers draw through the same driver path.

---

## 1. Particle slot struct + over-life setters (FACT unless noted)

Two bases: **P** = ring base `+0x40` (passed to every `Particle_*` method; all curve offsets below are
P-relative). **S2** = `P − 0x40` (spawn's tex/blend writes: spawn `sw …,0x180(S2)` == render `lw …,0x140(P)`).

| P-off | meaning | evidence |
|---|---|---|
| +0x00 | active flag / count (`qw0.x` = P6 billboard count) | `0x001d55d0`; render gates `lw v1,0(s0)` `0x001323d0` |
| +0x08 | **age accumulator** = **`qw0.z`, P6's trajectory parameter** | `AgeIntegrateStep` `0x001d5eec`; P6 slot 71 |
| **+0x10 / +0x18** | `qw1.x/z` = `(Lmax−Lmin)` / `(2·Lmin−Lmax)` — **written by `SetLifetimeRange` `0x001d57e0`**, un-scaled; **P6 reads these as its SIZE lanes** | `swc1 f13,16(a0)` / `swc1 f12,24(a0)`; live `(1.203, ·, 1.203, ·)` for snow L=3.0 |
| +0x14 / +0x1c | `qw1.y/w` = `(Smax−Smin)·r` / `(2·Smin−Smax)·r` — written by `SetSizeRange` `0x001d57f8`; P6's `vf15.y` "life" lane, **dead code** | `swc1 f13,20(a0)` / `swc1 f12,28(a0)`; live `(·, 0.532, ·, 0.149)` |
| +0x28..+0x38 | color seed RGB(+) — **PRNG** [1,2) per channel | `Particle_SeedRandomFields` `0x001d56c8..` |
| **+0x3c** | per-particle **rate** r (time/units scale; scales size, age, spawn-pos) | `AgeIntegrateStep` `0x001d5ee8` |
| +0x48 / +0x4c | color spread / bias — **PRNG-seeded**, not overwritten | `0x001d57a8/d0` |
| +0x50 | alpha_scalar | (seeder stops at +0x4c) |
| +0xa0 / +0xd0 | position / velocity quad | spawn-written once; the ring update never touches them |
| +0x140 / +0x144 | **texture handle / blend** (= S2+0x180/0x184) | render `lw a1,320/324(s0)` `0x001323e8/f8` |

**The two range setters (FACT, corrected 2026-08-24):** both store the engine's `{range, base}` pair
`value(k) = base + range·k` (endpoints at k=1 and k=2, k the VU's [1,2) random). `Particle_SetLifetimeRange`
`0x001d57e0` writes **+0x10/+0x18** un-scaled; `Particle_SetSizeRange` `0x001d57f8` writes **+0x14/+0x1c** scaled
by `r = P+0x3c`. The earlier table had them the other way round. P6 (slots 66–71) builds its half-extent from
`qw1.z + qw1.x·R` = the **+0x10/+0x18 pair** — so BoardSpray's billboard size is its record's *lifetime* column
(×[0.8,1.2)) and the record's size column only reaches `vf15.y`, which P6 computes and never uses. BoardSpray
never kills a slot by age either: its "lifetime" is the drawn size, its "size_max" is the fade time (§4), and a
slot lives until the ring evicts it. Size IS flat over life (a per-particle random, no age term).

**Color seed (FACT):** `Particle_SeedRandomFields 0x001d5678` draws the engine PRNG `0x0023d9c8` once per
field into +0x28..+0x4c (skipping +0x3c), each a float in [1,2). RGB = +0x28/+0x2c/+0x30; the lerp-toward-mean
+ spread(+0x48) + bias(+0x4c) + ×128 happens in the draw. Not board-basis, not a fixed table.

---

## 2. EE side: ages only — but the VU flies the sprite (FACT, corrected 2026-08-24)

The ring update loops calling **only** `Particle_AgeIntegrateStep 0x001d5ee8`:
```
f1 = slot[0x3c]  (rate) ;  f0 = slot[0x08]  (age) ;  slot[0x08] = f0 + (1/60)·f1    ; ONLY this field
```
It touches nothing but `slot+0x08`, and the full pos/vel/color integrator `0x001d5f28` is never called by any
spray ring. The earlier conclusion drawn from that — "position frozen at spawn" — was wrong, because
`slot+0x08` is `qw0.z`, and **P6 reads `qw0.z` as its trajectory parameter** (slot 71 `MOVE.z vf15, vf19`).
The slot's `qw5..qw9` hold real velocities: `Particle_SetVelocityFromBasis 0x001d5c88` divides the four
caller vectors by `r` and pre-biases `qw6` by `−1.5·(Va+Vb+Vc)/r` exactly as the SSF timer-emitter reader does,
and BoardSpray passes it the board velocity plus a lateral throw (`spray-systems.md` §3). So the billboard
**moves every frame**, on the VU, along `centre − (V/r)·c(age)`; the EE just advances the clock. The alpha fade
is also VU-side: `qw17.w = −alpha·128/(size_max·r)` times `qw0.z` (the `(0.9 − age)·1.111` law at
`0x00130ba0` belongs to the sys2 sheet renderer, not to this ring).

---

## 3. The GS-driver emit-quad → VIF1 → VU1 (FACT)

**Driver object:** `GlobalGameState *(0x00338e58)` → `[0x724]` = driverObj (singleton, ctor `0x001dbf50`,
sits beside `cPS2BezierMan_InitHardware 0x001dbfd0` that uploads VU1). Its concrete **vtable = `0x00394880`**
(set by `0x001ea5b8`). Relevant methods: `+0x1e0` `SetSpriteBlendMode` (`0x001e9910`), `+0x1f0` set texture
(`0x001e9870`), **`+0x25c` board-spray emit-quad (`0x001e2f58`)**.

**Per slot the render loop `0x00132310` calls:** `+0x1f0(slot[0x140])` bind texture (resolved once at spawn,
no UV advance), `+0x1e0(slot[0x144]=5)` **blend = additive** (enum 5 = `Cs·As+Cd`, written to descriptor
`+0x470+0x15/+0x17`), then `+0x25c(slot)` emit.

**The emit-quad `0x001e2f58` (FACT):** it is a generic "append a primitive to the DMA chain," not a vertex
shader. It writes a header then **copies `slot[0x00..0x140)` (20 qwords) verbatim** — pure integer copy, no
float math on pos/vel/age/size — and builds the view-proj matrix once/frame in VU0 macro mode (guarded by
`this[0x17d0]`). The header decodes as **DMAtag `0x10000017`** (ID=CNT, QWC=23) + a **VIF1 code** `0x6C148000`
= **UNPACK V4-32, NUM=20, FLG=1** (double-buffer) → the 20 payload qwords unpack into **VU1 data memory
(PATH1, not direct GIF)**. Then `0x14000000|micro>>3` = **MSCAL** (kick VU1) + `0x13000000` = **FLUSHA**.
`1 hdr + 20 payload + 2 = 23 = QWC` ✓ (cross-checked against the mode-7 sibling `0x001e3358`: `0xd813`,
NUM=9, QWC=12 — `QWC = NUM + 3` both ways).

**Program select (FACT):** `0x001e2f58` sets render-descriptor `+0x10 = 6`; `VuRender_UploadProgram 0x001c6180`
(jump table `0x391d10`) maps **id6 → VU program P6** (the mode-7 sibling sets id7 → P7). So the board spray
draws through **VU1 program P6**.

---

## 4. VU1 program P6 — the look-deciding ops (FACT)

P6 (152 instr) reads a **per-draw header only** and procedurally generates N camera-facing GS SPRITEs with the
VU hardware RNG — no per-particle vertex stream. Payload map (input qword → P6 use):

| qw | struct off | role |
|---|---|---|
| 0 | +0x00 | `.x` = particle **COUNT** (outer loop `vi09`); `.y` = inner trail count (`vi08`); `.z` = **age** (`slot+0x08`, the trajectory parameter `a`); `.w` = per-particle age offset |
| 1 | +0x10 | `x`/`z` **size** range/base (BoardSpray: its lifetime column), `y`/`w` the unused "life" lanes (§1, §4a) |
| 2–4 | +0x20/+0x30/+0x40 | **RNG seeds** (`RINIT R,vf20`); size random = `vf22.z` |
| 5–9 | +0x50..+0x90 | `M·qw` basis vectors |
| **10** | **+0xa0** | `M·qw10` = **WORLD POSITION → sprite center** (weight 1.0) |
| 11–12 | +0xb0/+0xc0 | scatter basis (× RNG) |
| **13** | **+0xd0** | generic within-draw step (× **batch index** `vf13.x`); **BoardSpray zeros it** |
| 14–15 | +0x0e0/+0x0f0 | colour (fan reads stop 0 `×128`) / authored **stop 2** `×128` — §4a |
| 16 | +0x100 | color basis (× RNG) |
| 18–19 | +0x120/+0x130 | GS ST/reg templates, `SQ`'d verbatim into the GIF packet |

**Center (FACT):** P6 first builds
`center = M·qw10 + M·qw13·particleIndex + M·qw11·R1 + M·qw12·R2`, but that is only the age-independent part.
Slots 59–85 then add the trajectory terms:

```text
a  = qw0.z                              # emitter age, offset by qw0.w per outer particle
ac = min(a, 2.7)
c  = -0.73*ac + 0.113*ac^2
position = center + M·qw5*a + M·(qw5 - (qw6 + qw7*R3 + qw8*R4 + qw9*R5))*c
```

BoardSpray fills `qw5..qw9` too (corrected 2026-08-24; the earlier "leaves its world point fixed" reading was
wrong): `Particle_Init` stores `qw5 = gravity/r²` (BoardSpray passes `(0,0,−100)` → `(0,0,−4)`), and
`Particle_SetVelocityFromBasis` stores `qw6 = (Vbase − 1.5·(Va+Vb+Vc))/r, qw7 = Va/r, qw8 = Vb/r, qw9 = Vc/r`,
so with `a = qw0.z = 5·t` every billboard flies `pos = centre + qw5·(a + c) − (V/r)·c`,
`c = −0.73·min(a,2.7) + 0.113·min(a,2.7)²`, i.e. `V·(0.73t − 0.565t²)` and then frozen after 0.54 s — a
drag-decelerated throw. The live carve slots decode to `|qw7|·5 = 1081` u/s against the predicted 1081 and
`|qw9|·5 = 1130 = |velocity|`. `qw13·particleIndex` is a generic within-draw term that **BoardSpray zeros** by
calling `Particle_ClearBatchStep 0x001d5a40` at `0x00131aac`. **HIGH** (P6 slots 45–85; live slot decode).

**BoardSpray batch/scatter (FACT):** `t0 = trunc(p + rand[0,1))` at `0x00131734` is passed unchanged as `a1`
to `Particle_Init 0x001d55a8` (`0x00131970`), which stores it at slot `+0x00`; P6 loads that word as loop trip
`vi09`. The CPU allocates only one ring slot when `t0 != 0`, but that draw contains **t0 billboards**. Values
above one matter, notably during a hard powder carve (~9/slot). `Particle_SetSpawnPosition 0x001d5910` writes
the two scatter vectors at qw11/qw12 from 2× the caller axes: 15 u along `boarder+0x4a80` (the board's rolled
lateral) and 90 u along `boarder+0x4a60` (its backward axis), becoming **30 u / 180 u (0.3 m / 1.8 m)** P6
scatter vectors, and `qw10 = contact − 1.5·(A+B)`. Each billboard samples those axes with stable VU RNG, so the
spawn centres fill a thin strip along the board's recent track before the throw carries them off. **HIGH.**

**SSF field-to-basis construction (FACT):** the EE reader pre-biases the VU's hardware `[1,2)` random values:

```text
qw10 = transformed(origin) - 1.5*(A+B)  # A=U12..14, B=U15..17
qw11 = A; qw12 = B; qw13 = 0
spawn = origin + A*(R1-1.5) + B*(R2-1.5)

qw6 = Vbase/U3 - 1.5*(Va+Vb+Vc)/U3
qw7 = Va/U3; qw8 = Vb/U3; qw9 = Vc/U3
velocity = Vbase + Va*(R3-1.5) + Vb*(R4-1.5) + Vc*(R5-1.5)

Vbase=U18..20; Va=U21..23; Vb=U24..26; Vc=U27..29
qw5 = (U30..32)/U3^2
```

**Colour stops (FACT):** SSF stores `U33..U48` as four **A,R,G,B** quartets.
The EE reader loads each quartet as `[U+1,U+2,U+3,U]`, so the P6 payload and
GS output see ordinary `[R,G,B,A]`. The first rotation is visible at
`ParticleEmitter_ReadType2Sub0Payload` `0x001d8e68..0x001d8e88`; a controlled
PCSX2 red/green emitter canary confirmed the static trace.

Thus `U12..17` are two centered **spawn-area axes**, not velocity, and `U18..29` are a base velocity plus three
centered half-range variation axes. This is a generic oriented box/parallelepiped law, not a cone heuristic.

**Size (FACT, LIVE 08-24):** half-extent = `const6.xy · (qw1.z + qw1.x·R)`, `R` from the VU RNG seeded by the
particle's frozen spawn-random (`vf20 = P+0x20`) → deterministic per particle, **no age term** → **size FLAT**.
`const6` lives in VU1 data memory, which PINE *can* read (EE-mapped `0x1100C000`): row 6 reads
**`(0.924, 1.232, 0, 0)`** (a 4:3 pair) next to the P6 screen scale `(448, 512)` and offset `(2047.5, 2047.5)`,
against a projection whose x column is scaled 0.528. Net full width ≈ `2·0.924/0.528` u per size unit ≈
**3.5 cm × qw1-size**: snow `blb1` (size 2.4–3.6) 8–12 cm, powder `str3` 22–33 cm, ice `cnf2` 3–5 cm, the air
`swp2` puff 7–14 cm. That is what the live specks measured, including the once-puzzling tiny ice shards.

**Emission and trails (FACT):** `qw0.w=(U2*U3)/U0`; the outer loop subtracts it from `qw0.z` once per particle,
so U2 is the burst's **start-time window**, not an amount added to every particle's life. `qw1.y/w` encode the
random `U5±U7/2` life range (scaled into P6 time by U3). The inner loop count comes from U1 (retail 0–10), its
age step is `qw2.y=U8*U3`, and its alpha loses `qw2.x=1/U1` per copy. U1/U8 therefore describe a tapered
multi-billboard **trail**, not CPU spawn batches or size growth. **HIGH** (constructor 0x001d55a8/0x001d57f8;
P6 slots 66–70, 82–88, 97, 123–128).

**Primitive (FACT):** corners `vf05 ∓ vf14`, `FTOI4` → GS 12.4 fixed XY, 2 vertices sharing one RGBAQ → a **GS
SPRITE** (PRI=6, TME=1): camera-facing axis-aligned rect, perspective-correct size (extent added before the Q-divide).
Additive blend comes from the EE draw-env (§3), not the VU.

**P6 vs P7 (FACT):** P7 (89 instr) builds `center = base + Σ basis·RNG` without P6's trajectory/trail machinery.
P6 is statically confirmed for both board spray and `EmitterNode_SpawnTick`; no SSF timer-emitter caller for P7 is
confirmed. P6 & P7 are the only two of the 9 VU programs that use the RNG register.

## 4a. `qw1` lanes and the SSF emitter's size scale (measured)

Live PINE reads of a paused PCSX2 v2.6.3 running `SLES-50545`, decoding the §3 payload straight out of EE RAM
(locate the packets by scanning for the `0x6C148000` VIF code):

| level / emitter | authored | `qw1` = `[x, y, z, w]` | reading |
|---|---|---|---|
| MEGAPLE `graph:0069`, exhaust fan | `U0`=75 `U4`=10 `U6`=5 `U5`=0.3 `U7`=0.2 `U3`=0.5 | `[5.0, 0.1, 2.5, 0.0]` | size `Smax−Smin`=5, `2Smin−Smax`=2.5 → **7.5 / 12.5**; life `(Lmax−Lmin)·U3`=0.1, `(2Lmin−Lmax)·U3`=0 |
| GARI `graph:0120`, firework | `U0`=200 `U4`=15 `U6`=25 `U3`=1.5 | `[25.0, 2.55, −22.5, −2.025]` | size `Smax−Smin`=25, `2Smin−Smax`=−22.5 → **2.5 / 27.5**; life range `(Lmax−Lmin)·U3`=2.55 |

**Lanes (FACT):** `x`/`z` hold the SIZE range/base and `y`/`w` the LIFETIME range/base — four exact matches
across two levels, and the signs disambiguate (GARI's size base is −22.5 where its life range is +2.55).

**Open — the GARI lifetime base:** its `w`=−2.025 puts the resolved life endpoints at 0.525/3.075, exactly
0.45 (`=0.3·U3`) below the `(2Lmin−Lmax)·U3`=−1.575 the authored `U5`=1.5/`U7`=1.7 predicts. The fan's `w`=0
matches its prediction exactly, so this is not a lane error. The captured GARI burst was mid-flight
(`qw0.z`=1.425 against the fan's 0.198), so an age term folded into the pair is the obvious suspect and is
untested. Size is unaffected — both levels' size lanes match to the digit.

**SSF size scale (FACT):** the timer-emitter constructor hands P6 `U4 ± U6/2` **verbatim** — 7.5/12.5 for
`U4`=10/`U6`=5, 2.5/27.5 for `U4`=15/`U6`=25. No `÷100`, no `×0.5`, no `r`, in the very record where it *does*
scale lifetime by `U3` and gravity by `1/U3²` (fan `qw5.z`=40=`U32/U3²`). Everything converting that authored
pair into a drawn half-extent therefore sits in `vf02`, which is VU1 data memory and unreachable over PINE.

**Corroborating decodes, fan record:** `qw0.x`=75=`U0`; `qw2.x`=0.1=`1/U1`; `qw2.y`=0.0015=`U8·U3`;
`qw2.zw`/`qw3`/`qw4` all within `[1,2)` (VU RNG seeds); `qw10`=(−5063,−16057,−42757,**1.0**) world position;
`qw14`=(128,128,128,**19.2**) = stop 0 `×128` of an authored `(1,1,1,0.15)`.

**Colour stops (measured):** `qw15` carries authored **stop 2 `×128`** — GARI `graph:0120` authors
`(0.1,0.1,0.1,0.1)` and its record reads `(12.8, 12.8, 12.8, 12.8)`. `qw16` is `(0,0,0,0)` in both captures,
consistent with stop 3 but not separable from §4's "colour basis × RNG" reading, since both emitters happen to
author stop 3 as zero. An emitter with a **non-zero stop 3** would settle it. `qw17` is *not* a plain
`(stop1−stop0)/segment` rate: the fan's `(0,0,0,−96)` fades its 19.2 alpha over exactly `Lmax`=0.2 s, but
GARI's `(0, 33.301, 0, −8.325)` yields no consistent segment time across channels (`G`→2.31, `A`→3.08, `B`→∞),
so a live mid-flight record is presumably already carrying the per-particle colour spread/bias of `P+0x48/+0x4c`.
**How the four stops map onto a particle's life is therefore still open.**

---

## 5. The draw model (synthesis)

Per frame the EE ages a slot and nothing else; everything that decides how it *looks* happens on the VU, and the
VU reads that age. Each of the slot's `qw0.x` billboards is a camera-facing GS SPRITE of a fixed per-particle
random size (`3.5 cm × qw1-size`), whose centre is the slot's spawn point scattered over two stable random axes
(±0.15 m lateral, ±0.9 m along the track) **and then thrown**: `−(V/r)·c(age)` with the slot's per-billboard
velocity `V = Vbase + Va·(R−1.5) + Vb·(R−1.5) + Vc·(R−1.5)`, a drag curve that covers `0.73·V·t` at first and
stops after 0.54 s. Alpha fades linearly to zero over the record's `size_max` seconds (snow 0.24 s, powder
0.58 s); the surface rows draw alpha-over (blend 3), the airborne puff additive (blend 5).

**Net:** the surface spray is a shower of small chunks that inherit a random fraction of the board's velocity and
are thrown sideways-to-upward out of the turn, decelerating as they fade — not an accumulation of frozen sprites.
The port (`Slopesmith/src/app/ride/board-fx.ts`) integrates exactly this curve per billboard.

---

## 6. VU program inventory (reference)

`.vutext` @ `0x310ba0`. Uploaded via `VuRender_UploadProgram 0x001c6180`, descriptor `+0x10` = id (jump table `0x391d10`):

Particles are expanded by their own dedicated microprograms, separate from the
ones that draw meshes, strips and terrain. Two exist:

| Prog | id | role |
|---|--:|---|
| **P6** | **6** | **particle sprite expander — full (per-particle size+color, velocity·index); board spray and SSF timer emitters** |
| **P7** | **7** | **particle sprite expander — simple (uniform color, isotropic); no confirmed SSF timer-emitter caller** |

P6 and P7 are also the only two that use the RNG register — so every particle
actually observed in game gets per-particle random size and colour, and the
simple uniform path has no known user.

**Residual:** the resident GS PRIM bits P6 XGKICKs (SPRITE strongly implied by the 2-corner FTOI4). The former
`qw0.x`/batch-spread question is closed statically: `qw0.x=t0`, qw13 is zero, and BoardSpray's within-draw shape
comes from qw11/qw12 scatter plus the per-billboard throw. VU1 data memory is readable over PINE, so the
remaining resident constants (rows 4–7) can be sampled directly rather than inferred.
