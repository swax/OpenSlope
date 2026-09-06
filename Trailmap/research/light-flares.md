# Snowdream "colored flares" — what they actually are

The bright colored flares scattered around the
live Snowdream course — how are they done? Answer below, with the dead-ends that
were ruled out first (kept here because negative results have no spec home).

## Conclusion (data-grounded, high confidence)

The colored map flares are **`Mdl_Flare` prop instances**, not a light-engine
renderer:

- **43 `Mdl_Flare` instances** (`Instances.json`, all `ModelID 26` → the single
  model `Mdl_Flare_1001`). Each is a tall thin **vertical box** mesh
  (`Meshes/31.obj`, 8 verts / 14 faces, X/Z ±3.11, **Y 0 → −63.9** ≈ a 6×64×6
  column), i.e. a **vertical light-shaft / beam**, NOT a camera-facing billboard.
- Material **22** `snowdream_A_flares_Mdl_Flare_3_lambert2`, texture
  **`0019.png`** (32×32, **fully opaque** — alpha 255 everywhere; the red→white
  gradient is in RGB, red at the base → white at the top). `UnknownInt18 = 0x15008`
  → the `&0x40000` alpha-pass bit is **clear** = the **opaque** branch
  (`material-alpha-flag.md`; renderer `RenderObjectMeshes_MaterialDispatch`
  0x001e2468). Object meshes are only ever opaque or alpha-over `ALPHA=0x44`,
  **never additive** (additive is reserved for particles/LensFX). So the beam is
  drawn **OPAQUE, at full brightness** — the instance lighting is full-white
  ambient `[256,256,256,128]` (unlit), so the bright red→white column pops against
  the night and reads as a glowing flare. **Not an additive glow.**
- All 43 instances are identical (one model, one material; per-instance lighting
  is flat white `Ambent [256,256,256,128]`, `LightColour1 = 0`). So the billboard
  itself carries **no per-flare color** — every `Mdl_Flare` beam is the same
  red/pink sprite.

The **color variety** comes from a **co-located Type-2 point light** per flare
(`Lights.json`), sitting 0–7u from each `Mdl_Flare` instance:

| light family | × | `Colour` (RGB) | sits on |
|---|--:|---|---|
| `SD_pt_flare` | 32 | (100, 10, 37) pink-red | `Mdl_Flare_*` |
| `SD_pt_purpleflare` | 8 | (0, 14.7, 100) blue | `Mdl_Flare_*` |
| `SD_pt_redflare` | 4 | (100, 33.8, 40.7) red | `Mdl_Flare_*` |
| `SD_pt_blueflare` | 2 | (10, 47, 100) blue | `Mdl_Flare_*` |
| `SD_pt_caldronlight` | 2 | (7, 0.7, 0.7) dim warm | `Mdl_Lantern_Stone` (no flare beam) |

So each flare = **opaque full-bright red column (`Mdl_Flare`) + a co-located
colored point light** that tints the nearby snow/geometry. Bright column + colored
light spill = the "colored flares, like a lighting effect." (Most are red/pink;
the ~10 blue/purple lights add the accent colors.)

The PBD light list bakes the WORLD lighting at load (per-instance vertex lighting
+ terrain lightmaps) — but a "no runtime light→sprite renderer
exists" conclusion was **wrong**, overturned by the live PINE session below (see
*RESOLVED: the lamp-glint renderer*). That scan missed it because the
runtime reader (`GlintMan_GatherVisibleLights` 0x00200be0) walks the cells'
loader-RESOLVED light-record **pointer lists**, not `Pbd_GetLight`, and its
support module lives at 0x1cc000–0x1ce200. The visible flare COLUMN is still the
prop; the lamp GLINTS are the light records, drawn live.

The **79 type-1 lamp lights that carry `spriteRes=32`** ARE co-located with lamp
fixtures — with the **floodlight-pole HEADS** (add the ~36 m pole height, mesh
`6.obj` Z 3435–3804, to the base pivot: 56/79 land within 3 m of a head, median
2.7 m, min 28 cm; measuring to base pivots instead of heads wrongly reads them as
free-floating). The ELF finding stands that no per-frame reader of the light
records was located in the render-region scan — but on-console behaviour (lamp
halos visible in play, occasionally through terrain) says a corona IS drawn at
these positions, so the negative scan should be read as "the feeder was not
found", not "no glint renderer exists". `cPS2LightMan` (below) remains the
candidate machinery. `spriteRes` (0/16/32 on Snowdream; 256/512 elsewhere) reads
as the glow sprite's resolution/size class.

## Ruled out (each cost a trace; recorded so they aren't re-walked)

- **`cPS2LensFXObjNode` (0x001ebac8 ctor, vtable 0x003955a8)** — not the map
  flares, and **not the sun flare either**. The earlier reading here ("the
  single, screen-space sun/sky lens flare … core+rays+ghosts, atlas slots
  55/10/12-15/42 … ~0.7 Hz pulse") is **withdrawn**: its vtable-13 draw
  0x001ecd00 paints a **bottom-of-screen message panel** (full-width rect, a
  two-half trim sprite, right-aligned localized text via string ids 362/363),
  `obj+0x350` is the panel's **slide position** (6 px/frame toward 480/360/105,
  0x001ecc20) rather than a pulse, and the "atlas slots" were **vtable-call
  arguments**. Its sub-drawer 0x001ed398 is nothing but string-table lookups
  (ids 3770/3564/362/363/17). Full correction, and the actual sun effect —
  a 37-spoke screen-space fan built in `GlintMan_PackSprites` 0x001cd538 from
  per-course `WorldConf` fields — in `sun-godrays.md`.
  The fade-law observation still stands as a description of *that panel*:
  `PopOn` 0x001ee3c8 sets alpha 1.0 + a 60-frame hold (+0x47c), then alpha
  decays 0.016/frame (~1 s linear); the six PopOn call sites inside
  0x001ebbc8 are **pad-button edge triggers** (the "mask manager" 0x3393e0 is
  the PAD manager; `PadDevice_TranslateToGameJoypad` 0x0017b290 builds the bits
  from the 16-mask table 0x338e08) with debug ids 347/335/365/364/329/339.
- **`cLightMan` per-light "render" (0x001d31e8 / 0x001d3248)** — actually
  **`cMCOverlayManager` debug name-formatting** (printf `"%s%s %d %s"` @0x003933e8
  + disc serial `SLES-50545`, via vsprintf 0x0017cf28). The earlier "88-byte
  runtime light array" reading came from this and is bogus.
- **`cPS2LightMan` (real one, 0x001ea738, module 0x1e8000–0x1eb088)** is a generic
  **GS sprite/billboard subsystem** (VU0 sincos billboard matrices 0x001e9ea0,
  148-byte GS texture-transfer DMA 0x001eaa18). It is *capable* machinery but was
  **not** found to be fed the level light records; the map flares are props, so
  this was a red herring for this question. (It likely DOES draw the type-1 lamp
  *glints*: those `spriteRes=32` lamp lights sit at the floodlight-pole heads —
  the "median 2298u from instances" argument against this measured to
  base pivots, not heads — and lamp halos are observable on console. The feeder
  from the light records to this machinery is still untraced.)

Blend reference: GS ALPHA-reg builder `GsBlend_BuildAlphaReg` 0x001c0900
(jump table 0x00391ad0); enum 5 → `0x48` = `Cs·As + Cd` (additive), enum 3 → alpha,
enum 6 → lightmap. Emitter sprites author their blend **per layer** via `U50`
(see *The flare plume is a DARKENING sprite* below) — additive is only the
`U50=0` default, not a universal rule.

## Authored glint art in PARTICLE.SSH

The shared particle bank ships purpose-drawn corona art: **`halo`** (idx 4) is a
soft **ring outline** — exactly the "circle halo" look observed on console lamps —
**`strk`** (22) a thin streak sliver, `beam` (33) a vertical beam, `lens` (28) an
atlas carrying a multi-spike ray star, `spec` (35) a soft blob. `halo` and `strk`
are **runtime orphans** like brk/ndl: no code raw-indexes the handle table at
+0x10/+0x58 (whole-ELF scan) and the authored-emitter U49 union excludes them.
`beam` is consumed near 0x00133cf4; `spec`/`envr` are per-course named-sprite
fallbacks (course-resource resolver, 0x0025f428 region). The on-console lamp
behaviour (halo only while some of the source is visible; ray streaks while
pinched behind an edge; no draw when fully hidden) has **no
statically-traced drawer**; the decisive next step is a PCSX2 read-watchpoint on
a lamp light record (or its load-time copy) while a lamp is on screen.

Statically eliminated (ruled out, no need to re-check): **the `halo` and `strk`
sprites that ship on disc are never drawn** — nothing in the ELF reads their
handle-table entries, and no by-name lookup resolves them (all 22 callers of the
by-name factory resolve FE3D operator / course resource names instead). Lamps
also carry no attached SSF: zero Snowdream lamp instances have an
`EffectSlotIndex`. The 25 `12cPS2LightMan` RTTI strings are per-TU singleton
registration blobs, not subclasses, so they imply no extra light renderers.

## RESOLVED: the lamp-glint renderer (live PINE session)

The light table is **not** bake-only. Found by poking a running Snowdream via PINE
(colour → glints turned green on screen; position +20 m → glints floated up;
write-watchpoint on the runtime glint objects → PC 0x1ccd10) and then reading the
code. The subsystem ("GlintMan", labels in the db):

- `GlintMan_Update` 0x001cc318 — per-frame driver, double-buffered 2×10-slot set
  of 208-byte glint objects (+0xc8 view depth, +0xcc light-record ptr, screen-quad
  corners + GS colour inline).
- `GlintMan_GatherVisibleLights` 0x00200be0 — walks up to 162 grid node cells
  (per-cell u16 visibility bits at cell+0x36 from the render gather), then each
  cell's **resolved light-record pointer list** (cell+0x40; the loader turns the
  LTG light-crossing index lists into direct record pointers — the per-frame
  reader the static scans missed, partly because it sits ABOVE the old
  0x110000–0x250000 scan range's neighbours and reads via cell pointer lists, not
  `Pbd_GetLight`). Gate: **`spriteRes & 0x70`** — only 16/32/64 glint; GARI's
  256/512 lamps never do. View-transform, reject off-screen/beyond draw range,
  insert with view depth as score.
- `GlintMan_TryInsertNearest` 0x001cc580 — keeps the **10 nearest** on-screen
  glint lights, evicting the farthest.
- `GlintMan_UpdateScreenQuads` 0x001cc688 — reads the record position (+0x28,
  plain `lwc1`), projects via the camera vtable, writes rotated screen-quad
  corners; the sin/cos rotation is **screen-position-driven**, not a clock (full
  geometry decode below, *Glint geometry decoded*).
- `GlintMan_PackSprites` 0x001cd538 — packs the GS sprites (and draws a separate
  celestial glint; below). *Superseded on the attribution: the later trace below
  ("not part of the lamp glint path at all") puts this function entirely in the
  celestial path. The occlusion observation that follows stands on its own.*
  **Occlusion is the GS depth test, per pixel**: the
  sprite draws at the light's depth, so terrain clips it exactly — a lamp behind
  a berm shows only the pixels that clear the ridge (the observed "any part
  visible → halo blooms past the fixture; fully hidden → nothing; never through
  terrain").
- Colour = the record's RGB **Euclidean-normalized** times record+0x08 (poked green
  appeared). record+0x08 is 1.0 in all 2894 shipped light records, so the sparkle's
  brightness is a constant and the RGB magnitude is discarded entirely — see
  *Glint brightness is record-uniform*. The earlier "no runtime spriteRes read"
  claims are corrected by this section.

## Glint geometry decoded + on-console close-up

Noclip fly-by observations on Snowdream (PCSX2, Blending=Full), each then traced
in the ELF:

- **The flares emit a dark, almost-black smoke plume.** (Blend decode below.)
- **The glow/halo + sparkle read ≈ 1.5 m across** up close on a flare.
- **The street lights DO sparkle at any distance — tiny and near-constant far
  away, growing as you approach.** (Perspective on a world-anchored quad plus a
  fixed-pixel core, not a constant-screen-size law.)
- **Only the blue/orange lamps sparkle; the white ones never do.** Data: all 122
  `spriteRes & 0x70` records are orange or blue — the 79 type-1 `SD_sp_lamp`
  heads normalize to sodium-orange (4700, 2350, 1645 → 1, .5, .35) or blue
  (400, 500, 1000 → .4, .5, 1) — while the 146 white `SD_sp_veranda_lamp`
  (0.9, 0.9, 1.0) and the blue-white `SD_sp_MEDIALamp` all carry `spriteRes = 0`.
  The gate alone reproduces the observation.
- **The sparkle itself moves very slightly** while riding. (Rotation law below.)
- **A bigger, general glow surrounds the tight sparkle, same hue as the flare**
  (follow-up ride): the glint is two size scales, not one. This matches the two
  quad batches in the corner build — one at f26 × (param+0x34 + cent⁴×1.0096),
  a second at f26 × (param+0x38 + cent⁴×1.2522) — the +0x38 element being the
  larger soft glow. (The params live in the runtime block mgr+0x730→+0x2c;
  their authored values are unread statically — a PINE peek would pin the
  size ratio.)
- **Occlusion fades in/out gracefully** as the source slips behind an edge
  (follow-up ride), and — decisive — **a prop RIGHT NEXT to the flare occludes
  the sparkle** on console. The depth test alone cannot do that: the sprite
  draws at the f27-pulled depth (3/5/8 m toward the camera), so nothing within
  the pull distance of the light could ever z-clip it. The engine therefore
  ALSO fades the glint by the SOURCE's visibility — a mechanism not yet traced.
  The alpha terms read so far (the D/2→D distance fade, colour normalize) don't
  contain it; the untraced remainder is the per-glint GS packing loop tail of
  `GlintMan_PackSprites` (≈0x001cd93c–0x001ce11c) — the next place to read.
  (The pop-on + 0.016/frame linear decay noted under *Ruled out* belongs to the
  HUD panel node, not to any flare, so it is no longer evidence for a sibling
  glint term.) The soft aura
  element (above) additionally smooths whatever partial clipping does happen.

`GlintMan_UpdateScreenQuads` 0x001cc688, per glint object per frame:

- **A fixed 16×8-PIXEL core sprite** at the projected light position (integer
  screen coords, −8/−4 centring, 0x001cc7f4–0x001cc838). Constant screen size at
  any distance — the far lamps' tiny constant sparkle.
- **World-sized quads, per size class** (0x001cc8d4–0x001cc95c): the record's
  `spriteRes & 0x70` picks two world-space constants (f26, f27) — class 16 →
  (100.74, 300), class 32 → (200.08, 500), class 64 → (500, 800), in world units
  (~cm). f26 sizes the rotated sparkle quads. f27 is the **camera-ward depth
  pull** — 3/5/8 m per class: the first projection block (0x001cc998–0x001cc9fc)
  offsets the light position by f27 along the view axis and keeps that point's
  projected depth (→ glint +0x20) as the sprite's draw depth. That pull is how a
  glint escapes the fixture that houses its own light (a lamp head is ~1 m deep)
  while berms/ridges — which sit further than the pull — still depth-clip it.
  World-anchored ⇒ plain perspective growth on approach; the res-32 flare quads
  are ~2 m × an authored scale — the observed ~1.5 m.
- **Screen-centre boost**: centreness = (√2 − |ndc|)·0.7071 (1 at screen centre,
  0 at a corner), raised to the 4th power; quad size = f26 × (param+0x34 +
  cent⁴ × 1.0096), the second element = f26 × (param+0x38 + cent⁴ × 1.2522)
  (0x001ccd84–0x001cdf0 / 0x001cd0c0–0x001cd1cc). Glints bloom up to ~2× when
  looked at dead-on.
- **The rotation is screen-position-driven, not a clock**: angle = −(π/2) ·
  ndc.x, with a second quad pair at +π/2 forming the cross
  (0x001cceac–0x001ccf90, then +1.5708 at 0x001ccfa0). As the light crosses the
  screen the star sweeps up to 180° — the "sparkle moves very slightly" while
  riding. There is no time term anywhere in the function.
- **Far fade**: alpha = 1 out to D/2, then linear to 0 at D (D = the manager
  param block's +0x5c draw range; 0x001cd4a4–0x001cd4cc).
- **Colour** = the record's RGB (+0x10) × the record's +0x08 scale (JSON
  `UnknownFloat1`; 1.0 on every glinting Snowdream light), Euclidean-normalized
  to a unit vector, alpha 1 (0x001cd3f0–0x001cd49c) — pure hue, magnitude
  discarded.

`GlintMan_PackSprites` 0x001cd538 is, despite its name, **not part of the lamp
glint path at all** — it is entirely the **celestial (sun) builder**, and returns
immediately when the course's celestial flag is clear. Its two authored DEGREE
angles (param +0x28/+0x2c → sincos 0x00251140), min(far, param+0x30) placement,
param+0x14 corona radius and 37-spoke screen-space ray fan are fully traced.
The builder's viewport-clamped 16×16 rectangle is dead: the celestial drawer
submits only the top-right corona tile, then the fan. See `sun-godrays.md`.

## Glint brightness is record-uniform — `spec:160-glint-brightness`

`GlintMan_UpdateScreenQuads` builds the sprite colour at 0x001cd3f0 as
`unit_normalize(record RGB) × record+0x08` — a **Euclidean** normalize (rsqrt of the
dot product), *not* a max-channel normalize — times the record's **fourth field**
(the float straight after `Type` and `spriteRes`; `UnknownFloat1` in the library's
`Light` struct, i.e. record+0x08).

That fourth field is a **measured constant across the whole corpus**. Every light
record of every extracted shipped course:

| course | light records | distinct record+0x08 values |
|---|--:|---|
| Snowdream | 421 | `{1.0}` |
| Merqury City | 934 | `{1.0}` |
| Mesa | 379 | `{1.0}` |
| Elysium | 218 | `{1.0}` |
| Garibaldi | 942 | `{1.0}` |
| **total** | **2894** | **`{1.0}`** |

So no shipped record dims or brightens its own glint, and — because the RGB is
normalized away — the record's **colour magnitude never reaches the sparkle**. It
is the light's illumination strength, consumed only by the load-time bake
(`PbdLights_ResolvePerCellIllum` 0x00252d10). Magnitudes |RGB| of the *glinting*
records, by light type:

| course | type-1 (course lamps) | type-2 (decorative) |
|---|---|---|
| Snowdream | 79 × 449 – 6858 | 43 × 1.01 – 113 |
| Merqury City | 86 × 53.0 – 125 | 96 × 1.00 – 40.5 |
| Mesa | 108 × 12.6 – 231 | 5 × 0.02 |
| Elysium | 19 × 139 – 173 | 14 × 30.3 |

Mesa's five `SD_Po_Event_Halo` records (|RGB| 0.02) therefore glint exactly as
brightly as Snowdream's `SD_sp_Lamp` (|RGB| 6858) — a 340000× spread in authored
magnitude, one identical sparkle. Merqury City's 32 emergency-vehicle beacons
(`SD_SP_Police`, `SD_Sp_EventPolice`; |RGB| 1.000–1.010, spriteRes 16) are a red +
blue pair ~0.8 m apart on each `Mdl_PoliceCar_NoSnow` roof, and are the extreme
case of a type-2 record authored as a **pure hue at unit length**.

Second consequence of the *Euclidean* (rather than peak) normalize: a neutral white
record draws at 0.577 per channel, while a saturated hue keeps ~1.0 in its dominant
channel. A saturated glint is the brighter one — white lamps sparkle dimmest.

## The flare plume is a DARKENING sprite

The observed near-black smoke is authored + blended, not an emulator artifact:

- The flare plume is the **only `U50 = 4`** `Type2Sub0` layer on Snowdream
  (`SSFLogic.json`: blower mist and lantern flames author 0; the `str1`/`str2`
  star layers author 1).
- `U50` is the layer's **blend selector**: `EmitterNode_SpawnTick`'s
  "per-substep param table" at **0x00393f68** is the 8-entry remap
  `[5, 3, 2, 1, 4, 0, 6, 7]` into the `GsBlend_BuildAlphaReg` enum. So
  `U50=0` → enum 5 = `0x48` additive (blowers, lanterns); `U50=1` → enum 3 =
  `0x44` alpha (the star sprites); flare `U50=4` → enum 4 →
  **`0x46` = (0 − Cd)·As/128 + Cd = Cd·(1 − As/128)** — the sprite **multiplies
  the framebuffer toward black by its alpha**, and its colour is ignored. Black
  smoke by construction, which is also why the flare layer's colour-ramp RGB
  reads as nonsense: only its alpha matters.
- Full jump-table map (0x00391ad0 → ALPHA lo byte): 0→`0x2A`, 1→`0x6A`, 2→`0x89`,
  3→`0x44` (alpha), 4→`0x46` (darken), 5→`0x48` (additive), 6→`0x81` (lightmap),
  7→`0x42` (subtract-source), 8→`0x49`, 9→FIX-alpha special (`0x64`/`0x68`).
- This corrects the earlier "all effect sprites use enum 5": that lookup —
  spec 180's "blend-table lookup confirming additive" — was read on a `U50=0`
  layer; the table it consults is exactly this remap.

### PCSX2 watchpoint runbook (route 1, prepared)

Boot Snowdream, then PCSX2 Debugger → Memory Search for the 12-byte needle made
of one lamp's world position as three little-endian floats (a lamp light record's
POSITION field; both lamps sit near the course start):

- `SD_sp_lamp_4010`: (108773.6, -115804.3, -110396.2)
- `SD_sp_lamp_4003`: (113816.3, -120501.4, -113867.8)

**One hit** = the in-place PBD record; **two+ hits** = a load-time copy exists —
the copy IS the glint feeder's working array. Set a READ breakpoint on the hit's
position field, ride/point the camera at that lamp: the PC that trips per-frame
is the glint drawer. No trip at the record but glints on screen → watch the other
hit. (Position is the one field any projector must read every frame.)

## Spec + port

Conclusions live in the spec: the light record's type enum + `spriteRes` + the
load-time bake (`spec:220-light`), and the type-2 decorative flare lights with the
glow-sprite-resolution reading (`spec:160-flare-lights`, `spec:160-light-bake`).
The Unity reproduction (snowknife bakes the co-located light's hue + `spriteRes` +
prop radius into the emitter; the importer tints the plume and builds a static
halo) is `Unity/docs/` — port guidance does not belong in this folder.

## Derivation — addresses (kept; the trail behind the spec conclusions)

- **Lights are bake-time.** Accessor `Pbd_GetLight` 0x00254fb0 (`LightsOffset +
  i·92`); the **sole** consumer is the load-time per-cell resolver
  `PbdLights_ResolvePerCellIllum` 0x00252d10. An exhaustive render-region scan for
  any per-frame read of a cell's light-lists (`+0x2A/+0x2C` count, `+0x48/+0x4C`
  ptr) or of a light record returns **nothing** (negative result).
- **The flare is a prop.** Instances resolve via `Pbd_GetInstance` 0x00254f58
  (stride 256, table 0x00347688; render callers 0x00190d1c/0x00193314/…). The
  blend gate is material `+0x40` (JSON `UnknownInt18`) `&0x40002` (0x001b8378 /
  0x001bc188); the blend value is the GS `ALPHA` enum from `GsBlend_BuildAlphaReg`
  0x001c0900 (3=`0x44` alpha, 5=`0x48` additive, 6=`0x81` lightmap). `Mdl_Flare`
  material 22 = `0x15008`, `&0x40002 = 0` → **opaque, full-bright** (instance
  ambient `[256,256,256]`). One model (`ModelID 26`), mesh `Meshes/31.obj` (a
  6×64×6 column), texture `0019.png` (opaque red→white vertical gradient).
- **Flare ↔ light co-location** (the basis for tinting): every type-2 light sits
  0–7 u from a `Mdl_Flare` instance; the 2 cauldron lights ~150 u from a
  `Mdl_Lantern_Stone`; snow cannons have no type-2 light within ~600 u.
