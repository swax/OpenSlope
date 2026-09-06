# 180 — Particles Data

The level's particle effects — fireworks, gem sparkles, drifting fog, the
debris of a collision — are defined by **emitter parameter blocks** carried as
nodes in the logic graph (`150-logic.md`), all drawing their sprites from a
single **shared sprite bank**. A separate, smaller table places standalone
**particle volumes** (the fog clusters) directly in the world. This chapter
defines that data. The emitter node and its payload encoding are in
`230-level-ssf.md`; the particle-volume table is in `220-level-pbd.md`; how
an emitter's template turns into spawned sprites is below; the additive
compositing of sprites is a runtime matter in `400-rendering.md`. The
board's own snow spray is a special case — it is not an emitter node at all
(see below).

## Emitter definitions

An emitter is a parameter block describing one burst or stream of sprites. Two
kinds exist, sharing the **same parameter footprint** and differing only in what
triggers them: a **timer-driven** emitter (fireworks, gem sparkles, fog) and a
**collision-driven** emitter (impact debris). The block specifies: [[180-emitter]]()

- a particle **count**, emission-time window, and a short billboard-trail definition,
- per-particle **lifetime** and a **size** range,
- two centered spawn-area axes plus a base velocity and three centered
  velocity-variation axes,
- a **gravity** vector applied over the particle's life, and
- a **colour ramp** of several RGBA stops the particle fades through.

A worked example (a fireworks burst): a 200-spark burst, a fraction of a
second of base lifetime, a strong downward gravity, and a four-stop colour ramp;
across the level's launchers only the colour controls and a little of the timing
vary, while count, spawn/velocity bases, size, and gravity are shared. The
collision-driven kind has one shipped graph in the full course corpus:
UNTRACK's slot 10, shared by 34 `Mdl_Tree_SnowGhost_*` placements, emits a
`clod` snow burst on contact. Other surveyed props with collision sounds but no
such node still produce only sound and a bounce. [measured]
[[180-emitter-vals]]() [[180-collision-emitter]]()

**The emission window decides burst or stream.** The window is the time over
which the block's particle count is released, and its **sign is a mode
selector**: a positive window releases that count once, spread over those
seconds; a **negative** window means an unbounded stream that never stops. The
negative form is rare and load-bearing — across the five levels examined, 6 of
598 timer emitters carry it, all with the same value, and those 6 are exactly
the always-on prop emitters described next. A prop authored with a positive
window on a persistent chain therefore emits a single burst as its region
activates and nothing thereafter, which reads on screen as a prop that does not
emit at all. [measured] [[180-emitter-window]]()

**Persistent (always-on) emitters.** An emitter reaches the world through an
instance's effect slot (`150-logic.md`): most are set off by a scripted event or a
trigger volume (the fireworks above), but a timer emitter held on a prop's
**persistent** chain simply streams for as long as the instance exists. The
clearest case is a **snow-cannon** prop — each blower carries a
persistent stack of **two** `Type2Sub0` emitters (a dense layer over a sparse one)
aimed up its barrel, near-white, with a strong **downward** gravity so the blown
snow arcs up off the nozzle and falls. The same persistent wiring drives the
course's road flares and stone-lantern flames (one layer each, with an **upward**
gravity so the flame rises); their per-flare *colour*, though, is not in the
emitter block — it comes from a co-located point light (`light-flares.md`). Each
layer also authors its own **blend mode** (`U50`, the *Blend* section below): the
snow-cannon mist and lantern flames draw **additively**, while the flare plume is
a **darkening** sprite — it multiplies the framebuffer toward black by its alpha
(colour ignored), so a lit flare visibly streams near-black smoke. [measured]
[[180-emitter-persistent]]()

> [[180-emitter]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> struct `Type2Sub0` (timer) and `Type2Sub2` (collision), both 51 fields
> `U0..U50`: `U0` particle count; `U1` trail-copy count (retail 0–10); `U2` start-time
> window (negative = persistent stream); `U3` internal time scale; size
> centre/span at `U4`/`U6` (→ a min/max range); `U5`/`U7` per-particle life
> centre/full-span; `U8` trail-copy time spacing; `U9..U11` local
> emitter-origin point; `U12..U17` two centered spawn-area axes;
> `U18..U20` base velocity; `U21..U29` three centered half-range velocity axes;
> `U30..U32` gravity, `U33..U48` four colour stops serialized **A,R,G,B** per
> quartet (the loader rotates each to runtime RGBA; ×128 → GS colour), `U49`
> sprite index, `U50` blend-mode selector (the *Blend* section). Dispatch
> `EffectMainType2_ParticleEmitterDispatch` 0x0013d138, read 0x001d8988; full
> field decode map:"Timer particle emitter field block (`Type2Sub0`,
> fireworks/sparkles)". The legacy `Type2Sub2` reader declares all 51 words as
> integers, so its exported `U2..U48` values are the exact IEEE-754 f32 bit
> patterns; consumers reinterpret those words rather than numerically casting
> them. UNTRACK's `U4=1128792064`, for example, is `200.0f`.

> [[180-emitter-window]]() [measured]
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> struct `Type2Sub0` field `U2`. Census over
> ELYSIUM/GARI/MERQUER/MESA/SNOW `SSFLogic.json`: 598 timer emitters, 6 with
> `U2 < 0` and every one of those exactly −1 — SNOW effects 75 (both layers),
> 82 and 107, MESA effect 231, MERQUER effect 863, i.e. the snow cannons,
> flares and lanterns of the persistent paragraph below; ELYSIUM and GARI
> author none. Walking each slot column's full chain (following the main-type-7
> instance hops) makes the correlation exact and shows it runs ONE way: of the
> emitters reachable from a `PersistantEffectSlot`, **5 of 5 carry the negative
> form and none is positive** (SNOW 4, MERQUER 1) — an always-on emitter always
> authors the stream form. The converse does not hold: MESA effect 231 is a
> negative emitter on a NON-persistent chain, i.e. an unbounded stream armed by
> something other than the persistent column. The burst reading of a positive window is the fireworks case
> already measured in [[180-emitter-vals]](); that a positive window on a
> persistent chain yields no visible stream was confirmed by an authored
> PCSX2 canary (a prop emitter authored at +0.6 s showed nothing in play,
> and the same emitter at −1 streamed).

> [[180-emitter-colour-order]]() `ParticleEmitter_ReadType2Sub0Payload`
> 0x001d8e68..0x001d8e88 loads first-stop `U34/U35/U36` into x/y/z and `U33`
> into w before scaling, i.e. raw `[A,R,G,B]` becomes runtime `[R,G,B,A]`.
> A controlled GARI PCSX2 canary authored one emitter as red and one as green
> in that order and rendered red/green respectively. [measured]

> [[180-emitter-vals]]() GARI firework emitter (effect 120): `U0`=200,
> gravity `U30..U32`=(0,0,−3000), four-stop ramp `U33..U48`, count/velocity/size
> constant across all 39 launchers,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.
> Collision emitter: map:"The collision shell and the SSF MainType 2 / SubType 2 particle" /
> map:"Prop-collision debris particle"; db:bark-fx — GARI authors none of the
> 107 emitters as the collision kind.

> [[180-collision-emitter]]() [measured] Full extracted PAL course census:
> exactly one MainType-2/SubType-2 graph, UNTRACK effect 10, reached by
> `EffectSlots[10].CollisionEffectSlot`; exactly 34 instances own that slot and
> all are `Mdl_Tree_SnowGhost_*`. Its reinterpreted P6 law is count 50, size
> `200±50` cm, life `2±0.5` s, pale-blue first stop
> `(0.74,0.84,0.97,0.04)`, sprite `U49=2` =
> `clod`, and blend selector 0 → additive mode 5. This is snow shed from the
> tree, not generic bark debris. Its stored U9..U11 words decode to
> `(33.3,1243,-44)` cm but are replaced on every real hit by the exact contact
> point. The constructor replaces base velocity `(0,0,800)` with the outward
> contact normal times its 800 cm/s magnitude; U21..U29 variation stays authored.
> The collision-effect entry path gates repeat contact for 30 logic ticks;
> map:"The collision shell and the SSF MainType 2 / SubType 2 particle".

> [[180-emitter-persistent]]() [measured] Snowdream `SSFLogic.json`: 49 visible
> instances carry a persistent `Type2Sub0` emitter via
> `EffectSlots[slot].PersistantEffectSlot` (`150-logic.md`) — 4 snow cannons
> (`Mdl_SnowBlower_Top`, slot 36, **two** layers: `U0`=200 over 50, size `U4`=120,
> velocity-envelope max ≈ 4380, gravity `U30..U32`=(0,0,−4000) ⇒ falls, white-ish
> 4-stop ramp), 43 flares (`Mdl_Flare`, slot 46, one layer, gravity +Z ⇒ rises),
> 2 stone lanterns (`Mdl_Lantern_Stone`, slot 40). Distinct from the trigger-fired
> fireworks (whose launcher instances carry no effect slot) and the boost pads
> (a collision chain, `360-speed-and-boost.md`).
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.

**Timer-emitter local origin.** For SubType 0, `U9..U11` are three f32
components of an emitter-local point.
The reader explicitly constructs `(U9,U10,U11,1)` and transforms it by the
owning instance's 4×4 matrix; the following six velocity vectors are transformed
with homogeneous `w=0`. Thus an editor can expose `U9..U11` as a local XYZ
origin/offset in engine centimeters while retaining the raw names alongside the
semantic label. Across all 12 PAL level SSFs, 937 of 978 timer-emitter nodes
author `(0,0,0)` and 41 author a nonzero point. `U9` itself is zero in the retail
corpus but is still an f32; a former integer reader declaration was a latent
new-authoring bug, now covered by a non-integral round-trip test. [measured]
[[180-emitter-origin]]()

SubType 2 preserves the same words in the file but does **not** use that point
on contact. Its constructor copies the live contact point over U9..U11, takes
`length(U18..U20)`, and copies `contactNormal * length` over U18..U20 before
entering the shared P6 reader. Only the base direction changes: spawn axes,
velocity-variation axes U21..U29, gravity, and the rest of the law remain
authored. [[180-collision-contact-frame]]()

> [[180-emitter-origin]]() `ParticleEmitter_ReadType2Sub0Payload`
> @0x001d8acc..0x001d8b40; `ssf-check` full-corpus emitter census;
> `SsfEmitterRoundTripTests.Type2Sub0_U9_RoundTripsAsFloat`. The controlled
> GARI ISO canary places a baseline plus independent +1000 mutations on U9,
> U10 and U11 for visual axis/unit confirmation; that visual observation is
> deliberately not needed for the binary type or point-vs-vector conclusion.
> Live P6 capture independently found the prepared origin `(x,y,z,w)` equal to
> the exact instance positions (with `w=1`) for effect hosts 242, 301 and 312
> when their authored U9..U11 were zero; map:"Timer particle emitter field block
> (`Type2Sub0`, fireworks/sparkles)".

> [[180-collision-contact-frame]]() `EffectMainType2_ParticleEmitterDispatch`
> @0x0013d210 → constructor @0x00148568 → payload override @0x00148750 →
> common P6 reader @0x001d8988. The object-collision path @0x00125090 copies
> query contact point to frame `+0x00` and outward normal to `+0x20` before
> starting the collision thread. map:"The collision shell and the SSF MainType
> 2 / SubType 2 particle".

## Emitter runtime: one generic P6 law

A live emitter node is ticked every frame by the logic graph's generic
effect-thread walk (`150-logic.md`). Its EE-side constructor turns the authored
fields into one 20-qword record, and each draw hands that record to VU program
P6 — the same generic renderer used by the board's snow spray. There is no CPU
array of 200 firework objects: P6 deterministically reconstructs the current
positions, sizes, colours, and U1 trail copies from the shared record, its age,
and seeded random values every frame. Persistent emitters keep the record's
age inside its occupancy window and advance the seeds as old particles roll
out.
[[180-emitter-runtime]]()

P6 generates the GS sprites procedurally from that compact record; there is no
uploaded per-particle vertex stream. Its timer-emitter position law is:
[[180-particle-vu]]()

```text
spawn    = origin + spawnA*r1 + spawnB*r2                 # r1,r2 in [-0.5,+0.5]
v        = velocityBase + velocityA*r3 + velocityB*r4 + velocityC*r5
a        = particleAge * U3
ac       = min(a, 2.7)
curve    = -0.73*ac + 0.113*ac^2
offset   = (gravity/U3^2)*a + ((gravity/U3^2) - (v/U3))*curve
position = spawn + offset
```

Successive particles start `U2/U0` seconds apart. Each gets a life in
`U5±U7/2`, a size in `U4±U6/2`, and U1 tapered trail copies separated by U8
seconds. These are shared generic semantics for fireworks, sparkles, fog, snow
blowers and flares; a consumer should not infer a cone or a separate
effect-specific particle preset from the six vectors.

> [[180-emitter-runtime]]() elf-map.md "SSF particle-emitter runtime:
> EE-side spawn dispatch, VU1-resident per-particle math" — traced chain
> `EffectThread_Tick`/`EffectThread_DispatchOne` 0x0013be80/0x0013bfd8 →
> `EffectMainType2_ParticleEmitterDispatch` 0x0013d138 → per-class Update
> (`Emitter` vtable 0x0036d9f8 Update 0x00147e68; `cParticleNode` vtable
> 0x0036d918 Update 0x00148108) → thunk → `EmitterNode_SpawnTick` 0x001d90c0
> (re-entrancy gate, the `U50`→blend remap lookup — the *Blend* section —,
> texture-table lookup, then vtable+0x25c → 0x001e2f58 — the same function already
> documented as the board-spray emit method — which memcpys the template's
> velocity-envelope/gravity/colour-ramp bytes verbatim into the VU1 upload
> ring and kicks the GPU). Age/duration pacing `0x001d9018` →
> `Particle_AgeIntegrateStep` 0x001d5ee8 (or the persistent-stream rollover
> integrator 0x001d5f28). The latter subtracts one emission interval per
> rollover, performs `qw10 += qw13`, and advances the nine stored RNG scalars;
> its loop progresses through the age decrement, not a missing counter. Shared
> producer singleton `GlobalGameStatePtr+0x724`, GS-driver vtable
> 0x00394880 (same class BoardSpray uses). The emitter's **sprite** is `U49`
> (stored to `node+0x4`, a raw index into the name-table-order bank at
> `*(GlobalGameState)+0x30`); `U50` (`node+0x8`, clamped ≤10) is the layer's
> blend selector, remapped through `0x00393f68` (the *Blend* section). Full trace:
> `research/emitter-sprite-index.md`. The emitter virtual call loads slot
> `+0x25c` at 0x001d91dc and resolves
> to 0x001e2f58; that entry writes render-program id **6**. The adjacent P7
> method (0x001e3358, id 7) occupies the next virtual slot and is not called by
> `EmitterNode_SpawnTick`. Therefore SSF timer emitters and board spray both use
> the full P6 upload path. A live GARI axis-canary run independently recorded
> 1,785 spawn ticks and 1,739 calls to P6 from return address 0x001d91e8, with
> **zero** P7 calls. [measured] This is statically and dynamically closed.

> [[180-particle-vu]]() `vu_disasm.py overlays`/`disasm`;
> `spray-render-pipeline.md` §4/§6 (P6/P7) — the two RNG-using VU programs of nine, selected by
> `VuRender_UploadProgram` 0x1c6180 render-descriptor id 6 (full, 152
> instr) / id 7 (simple, 89 instr); per-particle: `RINIT`/`RNEXT`, the position
> expression above, perspective-correct camera-facing billboard → `SQ` +
> `XGKICK`; P6 additionally computes a flat random size, time-varying colour,
> and the U1/U8 tapered trail. The BoardSpray caller happens to prepare a
> frozen-position record; SSF timer emitters populate P6's trajectory terms.

## The shared sprite bank

Every particle effect draws from **one** level-independent bank of named sprites:
debris chips, star and streak shapes, snow grains, the carved-wake ribbon, glow
rings, and explosion smoke. An effect names a sprite by index into this bank;
the bank is the same for all levels. As with all textures, several of the
sprites — the glow and explosion and debris art — are stored half-bright and must
be brightened on decode (`170-materials.md`). [[180-bank]]()

Which sprite a given effect uses is part of that effect's parameters: a
timer-driven emitter names its sprite in its block (field `U49`, a raw index
into the shared bank), and the board's per-surface spray (below) names a
different grain per surface type in its surface record. Both index the bank in
one order — the name-table/registration order (`part`=0 … `brk`=5‑7,
`ndl`=8‑9 … `str2`=19 … `tral`=23), detailed in
`research/emitter-sprite-index.md`. [[180-bank-select]]()

> [[180-bank]]() db:particle-bank; map:"The shared particle sprite
> bank (`PARTICLE.SSH`)" — `DATA/TEXTURES/PARTICLE.SSH`, ~38 named slots
> (brk1–3 debris, str* streaks, part/clod snow, tral trail, halo glow,
> ex06–09 explosion); 11 stored half-bright (clod/halo/snfl/ex06-09/exlm), the rest full-range.

> [[180-bank-select]]() db:particle-bank — per-surface board spray
> sprite index in the surface record (+0x44), a raw index into the
> name-table-order bank (`research/emitter-sprite-index.md`): type 1 (snow) →
> `blb1` (16), type 3 (powder) → `str3` (20), type 5 (ice) → `cnf2` (15),
> off-track/rock/bounce → `swp2` (13); trail → `tral` (23), the wake anchor.
> Timer emitters read the same space via `U49`: fireworks → `part` (0),
> gem sparkles → `str2` (19).

## Particle-volume placements

Levels place a handful of standalone **particle volumes** through a separate
table from the object instances — most visibly the **fog** clusters. Each entry
is a world transform, a particle-model table index (`ParticleModelIndex` at `0x40`),
and a bounding box. The referenced **puff-cluster** is a set of billboard
**puffs**, each with a local position, per-puff scale, and radius (the radii
reproduce the stored cluster bounds). This reference is many-to-one: Garibaldi
has ten placements and ten models, but ELYSIUM has 59 placements sharing 19
models. [measured]
[[180-volumes]]()

> [[180-volumes]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> struct `ParticleInstance` (`matrix4X4`, `LowestXYZ`/`HighestXYZ`, ref) →
> `ParticleModel` → `ParticleObject` → `AnimationFrames` (per puff: `Position`,
> `Rotation` used as scale, `Unknown` = radius; radius reproduces the AABB to
> ~1%). Extracted PAL corpus: GARI 10 placements / 10 models / 102 total puffs,
> MERQUER 9 / 9, ELYSIUM 59 / 19. In each case `ParticleInstance.ParticleModelIndex`
> is a valid model-table index; name matching alone loses 40 ELYSIUM placements.

## The board's snow spray is not an emitter node

The continuous snow spray thrown up by the riding board is **not** one of the
emitter nodes above. Its parameters live in the **per-surface response table**
(`310-surface-response.md`): each surface type carries its own spray emit rate,
size range, lifetime, and sprite index, so packed snow, deep powder, and ice each
spray differently — the measured per-surface ranking and the authored zeroes
are `380-carve-effects.md`'s. How those parameters turn into a per-frame
plume — the spawn gate, the quadratic growth with carve lean, the sideways
aim — is also the carve-effects model in `380-carve-effects.md`. [[180-spray]]()

> [[180-spray]]() db:powder-spray; map:"BoardSpray snow spray (the 40-slot ring): how
> deep snow sprays more" — per-surface fields in the surface record: emit rate
> +0x34, size +0x3c/+0x40, sprite +0x44 (0x001311b8). Measured emit rates:
> snow 0.075, powder 0.505 (≈6.7×), ice 0.200; types 4/7/8/11 = 0.

## The ambient snowfall is a weather subsystem, not placed data

The steady **falling snow** on snowy courses is likewise **not** in any of the
data above — no emitter node and no particle volume; a snowy level's particle
tables can be empty of it. It is a runtime **weather subsystem** that maintains
a camera-following box of flakes, enabled by a per-level flag and intensity,
drawing one grain from this bank — the soft `str2` star at **index 19** — as a
small additive sprite. Its camera-relative box, the world-fixed/parallax recycle
of its flakes, and the sprite choice are specified with the render model in
`400-rendering.md`. [[180-snowfall]]()

> [[180-snowfall]]() db:snowfall — manager `cSnowFallMan`; ambient snow
> draws bank index 19 = `str2` (texture set @0x001c9e0c, byte offset 76; bank
> order from the loader @0x001cb3f0 / name table @0x0033fff0). Behaviour is
> `spec:400-snow`.

## Blend: authored per emitter layer, fixed elsewhere

An **emitter layer authors its own compositing**: `U50` is remapped through an
8-entry table into the renderer's blend enum, so one effect graph can mix
additive, alpha and darkening layers. On Snowdream: the snow-cannon mist and
lantern flames (`U50=0`) are **additive**; the `str1`/`str2` star layers
(`U50=1`) **alpha-blend**; the road-flare plume (`U50=4`, the only such layer) is
**darkening** — the framebuffer is multiplied by (1 − sprite alpha), the sprite
colour ignored, so the plume reads as near-black smoke over anything bright.
The board's own spray/trail paths carry no such field — their blend modes are
fixed by the render path, specified in `400-rendering.md`. [[180-blend]]()

> [[180-blend]]() `U50` remap table `0x00393f68` = `[5, 3, 2, 1, 4, 0, 6, 7]`,
> consulted by `EmitterNode_SpawnTick` 0x001d90c0; the enum feeds
> `GsBlend_BuildAlphaReg` 0x001c0900 (jump table 0x00391ad0): enum 5 → ALPHA
> `0x48` `Cs·As+Cd` additive, enum 3 → `0x44` alpha, enum 4 → `0x46`
> `Cd·(1−As/128)` darken, enum 6 → `0x81` lightmap, enum 7 → `0x42`
> subtract-source; full map in doc:../research/light-flares.md. Layer values
> [measured] Snowdream `SSFLogic.json`: blowers + lanterns 0, `str1`/`str2`
> star layers 1, flare 4 (the only one).
> Blend-mode ownership for the non-emitter paths and the enum values are
> `400-rendering.md`'s `[[400-blend]]`; map:"Board snow spray & landing
> burst (BoardSpray)".
