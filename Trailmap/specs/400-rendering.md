# 400 — Rendering

The **observable render model**: what the original presentation does that a
reimplementation must reproduce to look right, stated independently of the
original hardware. Six things carry the look: terrain drawn as **curved
surface** (adaptive tessellation, not a fixed mesh), a single **shared
depth-tested pipeline** (nothing gameplay-critical is drawn "on top"),
a small fixed set of **blend modes** with particle sprites composited
additively, **colour doubling** over half-bright stored textures, an
**infinite painted backdrop** with distance haze, and a **smoothed chase
camera** framing all of it. The data each section consumes is defined in
Part 1 (`110-terrain.md`, `160-lighting-data.md`, `170-materials.md`,
`180-particles-data.md`). [[400-overview]]()

> [[400-overview]]() db:terrain-render; map:"Terrain rendering";
> map:"Render z-state".

## Terrain is tessellated adaptively, per frame

The original renderer evaluates the terrain's Bézier patches **in real time,
every frame**, at a subdivision density chosen by distance from the camera —
the terrain the rider sees nearby is genuinely curved, and the same patch
drawn far away spends almost nothing. Render tessellation is completely
independent of collision, which solves against the exact surface regardless
of draw density (`110-terrain.md`). [[400-tess]]()

The observed scheme has **three density levels, selected per patch edge** so
that neighbouring patches at different levels stitch without cracks:
[measured] [[400-lod]]()

| Level | Grid per patch | ≈ triangles | Used |
|---:|---:|---:|---|
| near | 8×8 | ~98 | inside ≈ 30 m |
| mid | 6×6 | ~50 | between |
| far | 4×4 | ~18 | beyond ≈ 150 m |

The behavioral requirement this encodes is a **chord-error bound**, not a
triangle count: near the rider, the gap between the drawn surface and the
true curve stays well under the board's ~7 cm thickness. A reimplementation
that bakes the far density everywhere puts metre-scale facets under the
rider whose mid-facet sag (≈ 6–12 cm on rolling terrain) is the same order
as the deck — the terrain visibly pierces the board. Either tessellate
finely near the camera or bake finely everywhere; the original chooses the
former. [[400-chord]]()

> [[400-tess]]() db:terrain-render; map:"Terrain rendering" —
> `cPS2BezierMan` @0x001da180 evaluates patches on VU1 per frame; separate
> path from the collision Newton solver @0x0025e480.

> [[400-lod]]() db:terrain-render — per-edge factors {4, 6, 8}
> bucketed at @0x001da180; LOD distance thresholds 3000.0/15000.0 units;
> mixed-edge bucket for crack-free stitching. Distance selection is
> medium-high confidence (thresholds + per-frame projection; the compare
> itself sits in undisassembled microcode).

> [[400-chord]]() db:terrain-render; map:"Terrain rendering" —
> chord-error analysis: 4×4 on a median ≈ 28 m patch → ≈ 7 m facets,
> sagitta L²/(8R) ≈ 6–12 cm for R ≈ 50–100 m, vs the near 8×8 grid keeping
> sag well under the 7 cm deck. spec:110-adaptive-tess holds the data-side
> statement.

## Placed objects are gathered by range, not all drawn

Placed objects (`120-objects.md`) are **not** all drawn every frame. The world
keeps its instances in a **spatial grid** (the same broadphase the collision
query uses, `130-collision-data.md`), and each frame the renderer **gathers only
the objects near the camera**: it takes the grid cells within the **camera's
draw range** of the eye, then runs a **tri-state frustum test** (inside /
outside / straddling) on each gathered node, and submits only the survivors. An
object beyond the range, or outside the view frustum, is **never drawn** — even
though it stays resident. [observed] [[400-obj-gather]]()

The crucial bound for a long course is the **range**, not the frustum: looking
straight down the fall-line, every prop ahead is *inside* the frustum, so only
the range keeps the distant ones from drawing. The range is a **camera
parameter** (it travels in the camera data files, **The chase camera** below,
not the world data); the engine's built-in fallback is **30000 world units ≈
300 m** (the 100 units = 1 m scale, cross-checked against the snowfall box and
the terrain LOD distances). The grid is queried at a cell granularity of
**≈100 m**. So on a 1 km-plus drop only the props within a few hundred metres of
the rider ever cost anything; the rest of the course is free until the rider
closes on it. [inferred] [[400-obj-range]]()

Objects also carry **three level-of-detail mesh slots** per model sub-object
(high / medium / low, `220-level-pbd.md`), selected by the same global
**Near/Far LOD** distance band the terrain tessellation uses (near 1000–3000 u =
10–30 m, far 5000–15000 u = 50–150 m). In **shipped Tricky data this is inert**:
every model sub-object points all three slots at the **same mesh**, so crossing
a LOD distance swaps a mesh for an identical one. Distance detail reduction is a
capability of the format the shipped levels do not use; the cost bound is the
**range gather above**, not mesh LOD. [measured] [[400-obj-lod]]()

There is **no object streaming**: the loader resolves the **entire** instance
and model tables once at course load (`200-archives.md`), and visibility is
dynamic per-instance state (`120-objects.md`), so all placed objects are
resident from load — the per-frame range gather, not load/unload, is what keeps
the drawn set small. [negative] [[400-obj-stream]]()

> [[400-obj-gather]]() db:object-cull; map:"Object visibility — camera-range
> grid gather + frustum cull" — render gather `0x001c7d08` (ObjNode virtual,
> vtable `0x00391f24`) reads the active camera off graphics singleton
> `0x00338E58`; cell-window setup `0x002607a8` over world/grid singleton
> `0x00347688` (cell `+0x28`, dims `+0x2c/+0x30`); recursive frustum gather
> `0x00260988` calls a camera tri-state visibility method (`camera+0x280`,
> 0=out/1=in/2=straddle) → draw `0x00200df0`.

> [[400-obj-range]]() db:object-cull — draw range = `camera+0x60/+0x64`
> (selected by `camera+0x298 < 2`), fallback `30000.0` (const `0x46ea6000`);
> cell radius `= (int)((range−1)/10000)+1`, the `/10000` implying ~100 m cells.
> Scale 100 u = 1 m cross-checked vs `spec:400-snow-parallax` box (350 u =
> 3.5 m) and `spec:400-lod` (3000/15000 u = 30/150 m). The 300 m figure is a
> measured constant; that the field *is* the draw range is medium-high (the
> live value is camera-side data, not in the ELF).

> [[400-obj-lod]]() db:object-cull; spec:220-object-header — three HI/MED/LO
> mesh offsets per object header; Near/Far LOD globals built in
> `cRenderOptionsMenu` (`0x00187760–0x001877b0`, float-item builder
> `0x0018b060`; consts 1000/3000/5000/15000). Inert in the shipped data: parsing
> `gari.pbd`, all 740 sub-objects (648 models) have HI==MED==LO
> (0 distinct-LOD), doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs.

> [[400-obj-stream]]() db:object-cull; negative result — `cCourseResolve`
> resolves the full instance/model tables at load (`### RESOLVING INSTANCES`/
> `RESOLVING MODELS`); the only `stream` classes are video
> (`cVideoStreamMan`/`cStreamSys`). Visibility is dynamic per-instance state
> (`spec:120-invisible`), so instances stay resident.

## One depth-tested pipeline — the rider is not drawn on top

Terrain, props, and the rider/board all draw through the **same
depth-tested material pipeline**. Depth test and depth write are
per-material data with normal defaults (test on, write on); there is **no
player-specific depth override, bias, or late "draw the board on top"
pass**. The board reading as *on* the snow is carried entirely by the
contact model — the per-surface sink and visual lift of
`320-ground-contact.md` — over a smoothly tessellated surface. A
reimplementation that instead z-biases the rider breaks the powder look
(a buried board is *supposed* to be cut by the surface). [[400-depth]]()

> [[400-depth]]() map:"Render z-state" — the two GS depth-state
> writers (test @0x001c0ad0, z-write @0x001c0a58) are reached only from the
> universal draw-env builders (@0x001c54d8 → @0x001c5860); defaults
> descriptor +0x12 = 1 (GEQUAL-class normal test), +0x11 = 0 (write on);
> no depth term in `BoarderPose_BuildRenderTransform` @0x00129630.

## Blend modes

Placed geometry composites by its material's alpha mode — **opaque**,
**cutout** (alpha test), or **alpha blend** — exactly as the material data
declares (`170-materials.md`); the renderer translates a small per-material
blend selector into the hardware blend equation. Two compositing decisions,
however, are **fixed by the render path** and carried by no data:
[[400-blend]]()

- **Particle sprites are additive.** Every sprite the effect system draws —
  snow spray, fireworks, gem sparkles, glows, debris — is added into the
  frame (source × alpha **plus** destination). Additive compositing is why
  a light dusting of spray reads as a faint glow while a dense carve plume
  blooms toward white, and why the spray can never darken the snow behind
  it (`380-carve-effects.md`).
- **The carved-wake ribbon is alpha-blended.** The trail strip composites
  with ordinary alpha *over*, so its baked light/shadow texture can darken
  the snow into a groove (`380-carve-effects.md`).

Particle sprites are otherwise plain camera-facing billboards with a
**static** texture — a sprite's image is resolved once when it spawns and
never animates over its life. For the board snow spray specifically, each
sprite is also **frozen in world space at spawn** (re-projected by the camera
each frame) and drawn at a **fixed per-particle random size** — neither its
position nor its size changes over its life; only its alpha fades. The plume
is therefore the **accumulation of many frozen, fading sprites along the
board's path**, not particles streaming or arcing outward. [[400-sprites]]()

> [[400-blend]]() the sprite batch hard-codes additive blend enum 5
> (`0x48`, `Cs·As + Cd`) through the blend translator 0x001c08e0 / table
> 0x00391ad0, bypassing the material path; generic alpha-blend materials
> (glass, water, LCD screens) use enum 3 (`0x44`, alpha-over); the carved
> wake is a dedicated two-pass draw, not the generic material path — its
> light-edge pass uses enum 4 (`0x46`) and its shadow-edge pass uses enum 8
> (`0x49`), `380-carve-effects.md`; the terrain lightmap pass uses enum 6
> (ALPHA `0x81` = `(Cd − Cs)·As >> 7`); placed geometry's selector bytes
> live in the render descriptor (+0x15/+0x17).
> map:"Render z-state"; map:"Board snow spray & landing burst (BoardSpray)".

> [[400-sprites]]() db:powder-spray; map:"Board snow spray & landing
> burst (BoardSpray)" — sprite asset handle resolved at spawn
> (@0x00131b00); no flipbook/UV animation on particles. Board-spray draw:
> GS-driver vtable 0x00394880, emit +0x25c=0x001e2f58 → DMAtag 0x10000017 +
> VIF1 UNPACK V4-32 NUM=20 (320B slot) + MSCAL → VU1 program P6 (render-desc
> byte +0x10=6; the same virtual slot is called by SSF timer emitters), a
> 2-vertex camera-facing GS SPRITE,
> perspective-scaled. Position frozen: EE ring ages only (slot+0x08 +=
> (1/60)·slot+0x3c); P6 center = M·(world pos slot+0xa0); velocity slot+0xd0
> enters only as velocity·batch-index (intra-emission spread), never
> velocity·age; size = sizeBase(+0x1c)+sizeSlope(+0x14)·R (per-particle RNG, no
> age term); alpha fades (0.9−age01)·1.111 @0x00130c98. Open: per-emission
> sprite count (qw0.x, carve-derived) needs a PCSX2/RAM trace.

## Draw order

Placed geometry is sorted before it is drawn, and **opaque and translucent
object meshes are sorted on different principles**: [[400-draworder]]()

- **Opaque** draws carry a constant priority. Ordinary surfaces rank `1023`;
  a material carrying the decal-priority flag of `170-materials.md` ranks one
  step below that, which draws it one rank
  **later** within its render mode — the coplanar tiebreaker it is there to be,
  since the depth test passes on equality and the later draw wins.
- **Translucent** draws (the alpha-pass materials of `170-materials.md`) rank by
  **quantized camera depth**: the object's origin is transformed by the view
  matrix and bucketed to `clamp(trunc(depth × 1023/40000), 0, 1023)`, ≈ 39 world
  units per bucket. The sort is descending, so they draw **back to front**, after
  all opaque geometry. Additive particle sprites claim rank `0` and draw last.

Depth ordering is therefore a property of the *draw list*, not of the raster
state: a translucent object mesh composites with the same GS state as an opaque
one — alpha-over blend, the low alpha test, and **z-write on** — and stays
correct because the far surface is submitted first. Two stacked translucent
sheets (a river's fast layer over its slow one) both composite for exactly that
reason; drawn in the other order the near one would write depth and reject the
far one. A port whose transparent draws are batched, and so cannot sort per
object, does not inherit this and must compensate. [[400-translucent-order]]()

The depth sort is **single-viewport only**. With two or more viewports
(split-screen) the per-object ordinal is replaced by a flat constant, and
translucent object meshes fall back to submission order. [[400-draworder-split]]()

> [[400-draworder]]() `RenderNode_BuildSortKey` (@0x001c7580) reads render-
> descriptor byte `+0x0e` as a **sort-key source selector** and builds
> `node+0x2a = (19−mode)<<11 | selector<<1 | primtype`: `+0x0e = 0` → selector
> 1023, `= 1` → 1022, `= 2` → the halfword at descriptor `+0x04`, `≥ 3` → 0
> (@0x001c7598–0x001c75e8). The setter is vtable slot `+0x1ec` @0x001e98e0 —
> `RenderDescriptor_SetSortKeySource(src, ordinal)`, writing `+0x0e` = src and
> `+0x04` = ordinal (the db's older `SetOpaqueSubmode` name predates the value-2
> case). `RenderDrawList_SortByPriority` (@0x001c4798) → `RadixSort16`
> (@0x002d0dd8) sorts **descending** — its bucket-offset loop @0x002d0e64 walks
> 255→0, so the highest key is emitted first. Neither `+0x0e` nor `+0x04` reaches
> a GS register: their only other reader is the descriptor→shadow sync
> @0x001c5264/0x001c5280, which merely invalidates the cached packet.

> [[400-translucent-order]]() `RenderObjectMeshes_MaterialDispatch` (@0x001e2468)
> calls the setter with `src = 2` on the alpha branch and `0`/`1` on the opaque
> one; the ordinal is computed in the VU0 macro-mode block @0x001e2b84–0x001e2bdc
> (`M·worldPos` through the view matrix at `ctx+0x5b0`, `×vf05.w`, clamped to
> `vf05.x`, `VFTOI0`, `VMTIR`/`CFC2`). Constants @0x001dd080: `40000.0`,
> `1023.0`, `0.0255750` (= 1023/40000). The branch touches **no** depth or blend
> state — z-write is descriptor `+0x11`, written only by `SetZWrite` (vtable slot
> `+0x1c4` @0x001e99e0) which this dispatch never loads, and whose initializers
> set 0 (= write enabled). Contrast the additive sprite batch
> (@0x0012f1e0–0x0012f224): it calls the same slot with `(2, 0)` but *also*
> `SetZWrite(1)` and blend enum 5 — what a genuine translucent state change looks
> like here.

> [[400-draworder-split]]() the alpha branch reads `ctx+0x640` and passes the
> computed depth ordinal only when it is non-zero, else a flat `1`
> (@0x001e2b70/0x001e2bf8). `+0x640` is set from `(*(mgr+0x298) < 2)` @0x001c7964;
> the same `< 2` test @0x001c7934/0x001c7d64 selects camera draw-range `+0x60` vs
> `+0x64`, so `mgr+0x298` reads as the viewport/player count [inferred].

## Colour doubling and baked lighting

Textures are stored at **half brightness** and the display path **doubles**
every sampled colour component (`170-materials.md`, `210-textures-ssh.md`):
the stored mid-scale value is full intensity on screen, and stored values
above mid-scale over-brighten — the headroom the baked lighting uses. A
renderer that samples the stored bytes without the ×2 draws the whole world
at half intensity. [[400-double]]()

Lighting is applied from the baked data of `160-lighting-data.md`, with no
runtime light solve over the static world: [measured] [[400-lighting]]()

- **Terrain** is lit entirely by a **second GS blend pass** over the base
  texture — the base pass itself is a plain neutral modulate that bakes no
  per-vertex lighting (the patch record carries no normal or colour control net,
  only positions + UVs + a lightmap id, so the tessellator has nothing to shade
  from). The patch's **lightmap tile** supplies `C_S` (RGB) and `A_S` (alpha),
  and the pass computes `(C_D − C_S)·A_S` — the hardware-supported form of the
  desired `C_D·C_L` — putting the mountain's shading (cliff shade, gully shadows,
  and the cool/warm colour of the light) into the surface. Blend **enum 6**
  [[400-blend]]().
- **Objects** are shaded by their per-instance block as
  `C_L = ambient + Σ max(0, N_model·L_model)·key`, clamped at the vertex and
  interpolated across the mesh. Both the stored normal and each key direction
  are model-local; the placement does not belong inside that dot product. The
  resulting vertex colour modulates the texture in the GS byte/texture-colour
  domain (256 is texture-true), then saturates. Applying Lambert in linear-light
  space makes half-lit pale textures visibly too bright. The high-range key
  colours (above full white) rely on the doubling headroom above.

> [[400-double]]() opaque alpha cap 128 = half of 255 across all level
> banks; the ×2 is the GS colour-multiply convention,
> doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs
> `BrightenImage()`. spec:210-halfbright holds the storage-side statement.

> [[400-lighting]]() the **terrain** draw is traced: a neutral-modulate base
> pass + the enum-6 lightmap blend `(C_D − C_S)·A_S` (`spec:400-blend`;
> doc:../research/elf-map.md — `cPS2BezierMan` carries only positions/UVs/lightmap-id,
> no per-vertex normal or colour, so no Gouraud is baked into the base). The
> **object** equation/frame and byte-domain modulation are measured by the
> arbitrary-yaw/cardinal-face lighting gnomon against PCSX2, then corroborated
> across retail props; doc:../research/extracted-data.md "Per-instance lighting
> frame". Open lead: the instance record's fourth
> light vector's role.

## The infinite backdrop, and fog

The mountains and sky on the horizon are a dedicated **backdrop model** —
a small piece of level geometry shipped beside the world database with its
own texture bank (`200-archives.md`, `220-level-pbd.md`) — drawn
**centered on the camera** and behind everything, so it never parallaxes:
the painted peaks stay put however far the rider travels. The model is an
open ring panorama: discrete textured panels whose touching edges continue
each other around the horizon, with **no cap** — nothing is painted at the
zenith, and the area above the painted band must be filled with sky colour
by the renderer. [[400-backdrop]]()

Distant world geometry **fades into the horizon haze** with distance, so
terrain meets the painted backdrop without a hard silhouette. The fade is
observable in the shipped game, but **no atmosphere parameters exist in the
level data** — the world database has no fog block and the example level's
camera records are empty — so fog colour and distances are an
implementation's choice, matched to the backdrop's horizon band.
[observed] [[400-fog]]()

The drifting **fog banks** placed *inside* the world are unrelated to this
distance haze — they are particle volumes, placed data (`180-particles-data.md`).

## Celestial glare — the sun and its beams

Some courses carry a **sun**, and looking toward it fans a spray of **light beams
across the whole view**. Whether a course has one, and everything about it, comes
from that course's world-configuration record — the same per-course record that
holds the sky colour (`442-sky-color.md`) — as an **on/off flag**, two **colours**
(a bright core and a duller rim), a **size**, a **placement distance**, and the
sun's own direction as an **azimuth and elevation in degrees** above the
horizontal. Only **four of the thirteen** shipped course slots switch it on, and
every one of those places its sun within **13° of the horizon**, in a sunset hue —
this is a low sun you ride toward, not an overhead one. The remaining slots still
carry plausible-looking values, so the flag is the only thing that decides.
[[400-celestial-params]]()

The sun itself is drawn as a **glow sprite placed along that direction at the
authored distance, measured from the camera** — so it rides with the viewer and
behaves as a body at infinity rather than a point you can approach. The size
field is its world **radius / half-extent**: the builder offsets opposite
camera-plane points by `-size` and `+size`, with no half-size conversion. When
the view's far distance is nearer than the authored placement distance, both the
distance and radius scale down together, preserving apparent size.

The bound particle art is the 2×2 `lens` atlas, but the celestial UVs select only
its **broad white top-right corona**. The neighbouring ring and many-spiked star
tiles are not submitted. The builder calculates and viewport-clamps a 16×16
rectangle, but the final drawer never reads it and live DMA contains no packet
for it: it is dead intermediate data, not a compact core. The corona stays
substantial across the authored radius and washes out the fan without a central
dot. [[400-celestial-sun]]()

The **beams are not a sprite**. They are a **flat, screen-space fan of triangles
centred on the sun's projected position**, built fresh each frame from a fixed
authored table of **37 spokes** — each an angle around the sun and a brightness —
that is the same on every course. The table's angles are whole degrees and its
brightnesses are all twenty-firsts; their uneven spacing and uneven brightness
*are* the effect, giving clumped bright beams with dim gaps between. Each spoke's
outer vertex is carried **out to the edge of the screen**, and the four screen
corners are folded into the fan in angular order so it stays convex and gapless.
Brightness at an outer vertex is that spoke's authored value reduced by a
falloff that grows with the **square of the screen distance** travelled and then
holds flat, so a beam that has to cross the whole screen to reach a far corner
arrives visibly dimmer than one leaving through a near edge. Every fan vertex
uses the course's core RGB; the rim RGB belongs to the separate textured
corona sprite. Neighbouring beams are **separated by a step, not a blend** — the eye
reads them as hard-edged bands of differing brightness all the way in to the sun,
not as a smooth radial glow. [observed] [[400-celestial-fan]]()

The fan carries **no depth information at all** and is composited **additively
over the finished frame** (`ALPHA_1=0x48`, always-pass depth test, depth writes
masked). Nothing occludes it: the beams lie over terrain,
props and the rider alike, which is what makes them read as light shining
*through* the scene rather than as geometry in it. An implementation that
depth-tests the fan will not reproduce the effect. [[400-celestial-fan]]()

> [[400-celestial-params]]() db:light-flares;
> doc:../research/sun-godrays.md — the celestial build/draw path reads the selected `WorldConf`
> record (`courseRuntime+0x2c`, `spec:442-load`): `+0x00` enable, `+0x04`/`+0x08`/
> `+0x0c` fan/core RGB and `+0x10` fan intensity, `+0x18`/`+0x1c`/`+0x20`
> lens/rim RGB and `+0x24` sprite intensity, `+0x14` size, `+0x28` azimuth°,
> `+0x2c` elevation°, `+0x30` distance — resolving all nine
> fields `spec:442-record-map` had left open. Values recovered by emulating the
> record initializer @0x002582f0 and cross-validated: the same pass reproduces
> all thirteen locally extracted sky colours of `spec:442-load` exactly. Four
> slots enable the effect; exact parameter rows remain local to the extraction.

> [[400-celestial-sun]]() db:light-flares; doc:../research/sun-godrays.md —
> direction `(cos az·cos el, sin az·cos el, sin el)` built via the sincos helper
> @0x00251140, point `cameraPos + dir × distance` (@0x001cd6a4–0x001cd7f4);
> dead 16×16 rectangle construction and viewport clamp @0x001cd844–0x001cd930;
> direct `±SizeUnits` camera-plane offsets @0x001cda58/0x001cdb4c; far-plane
> proportional shrink @0x001cd5d8–0x001cd61c; particle-bank index 28 (`lens`)
> bound @0x001cc28c; final sprite draw uses rim RGB and `+0x24` intensity, with
> live UV `(128,0,128,128)` selecting only the top-right corona and `ALPHA_1=0x48`
> @0x001eb5a0–0x001eb848. A paused Mesa DMA has state qwords 0–19, the sole
> textured corona 20–41 and the fan immediately at 42. The white 255-valued
> texture yields a normalized corona gain `255/128`, while the untextured fan's
> 128-unity vertex colour yields `128/255`; doc:../research/sun-godrays.md.

> [[400-celestial-fan]]() db:light-flares; doc:../research/sun-godrays.md —
> spoke table @0x00392F68, 37 `(radians, intensity)` pairs, zero-terminated
> @0x00393090; angles are integral degrees 0…352 and every intensity is exactly
> n/21, n ∈ [4,18]. Screen-corner angles @0x001cddd8–0x001cdea8 (arctan helper
> @0x00251628), merged walk @0x001cdef0–0x001ce0d8, border solve
> @0x001cdf50–0x001cdfd4, falloff `(3 − min(d²,3))/3` @0x001ce05c–0x001ce0b4.
> Vertices are two floats each at `glint+140` (count `glint+0x88`) — no depth
> component exists in the structure. Final packing @0x001eb8d8–0x001eba44 uses
> core RGB on every fan vertex and spoke intensity × `+0x10` fan intensity,
> with the stored squared-distance factor applied to the rim.

## Weather: ambient snowfall

Snowy courses render a steady **fall of snow around the rider**. It is a
dedicated **weather subsystem**, not authored content: the level carries none
of it in its particle tables (`180-particles-data.md`), only a per-level
**enable flag** and an intensity. A course whose flag is clear renders no snow
at all; the subsystem early-outs. [[400-snow]]()

The effect is **camera-relative**. The subsystem keeps a small box of flakes —
a cube roughly **7 m across** (half-extent ≈ 3.5 m) — and **re-centres it on
the camera every frame**, so the snow always surrounds the viewer however far
the run travels, with only a few tens to a couple hundred flakes alive at once.
Crucially the re-centre is **discrete and the flakes are world-fixed, not
glued to the camera**: each frame the camera's offset from the box origin is
**floored into whole half-extent-sized cells**, and only that whole-cell shift
is applied, by **wrapping flakes across the box faces** (a flake that leaves one
face reappears on the opposite one). The box origin itself drifts on a fixed
world grid (one cell = the full box width). The visible result is **parallax**:
a flake holds its world position while the rider approaches and passes it — you
ride *through* the snow — and only jumps when it falls off an edge and is
recycled to the far face. Nothing is ever "left behind," however fast the rider
moves, yet the snow is not a rigid snow-globe locked to the view.
[[400-snow-parallax]]()

Each flake **falls** under a slow drift velocity and **spins**; it is drawn as
a **small, faint, additive camera-facing sprite** — the `str2` grain from the
shared bank (`180-particles-data.md`), a soft star that at its small on-screen
size reads as a soft, translucent, blurry dot rather than a discernible flake.
Additive compositing over the typically **night** sky of these courses is what
makes the dim flakes register as a soft glow (the additive rule is the general
one of **Blend modes** above, [[400-blend]]()). [[400-snow-sprite]]()

> [[400-snow]]() db:snowfall; map:"Ambient snowfall weather" —
> manager class `cSnowFallMan`, a 1232-byte object allocated+tagged
> "SnowFallMan" @0x0017e8c0, constructed @0x001c92b0, built once during
> course init; per-frame update/draw virtual @0x001c9c38. Per-level enable is
> a scene-weather flag (view manager +0x730, field +0x74) read at the top of
> the update; the front-end **"Snow fall:"** parameter (string @0x00389f48,
> range 0.5..2.0) scales the amount.

> [[400-snow-parallax]]() db:snowfall — box half-extent 350 (obj +0x4B8),
> wrap grid 700 (= 2×half-extent), snapped @0x001c9710; per-axis camera cell
> offset = floor((camPos − boxOrigin)/350) @0x001c9ce8–0x001c9d94 (cvt.w.s →
> integer), added×350 to a *temporary* draw origin, not the persistent origin;
> the integer offset shifts flake **lattice indices** in the recursive draw
> @0x001c9880 (toroidal recycle), so world positions are piecewise-constant
> in camera position (parallax), not a continuous carry.

> [[400-snow-sprite]]() db:snowfall — texture set @0x001c9e0c reads the
> flat PARTICLE.SSH handle array (singleton +0x30) at byte offset 76 =
> **index 19 = `str2`**; array order is the registration order from
> `ParticleSsh_LoadAndRegisterSubtextures` @0x001cb3f0 over the name table
> @0x0033fff0, cross-validated by the wake-trail draw reading offset 92 =
> index 23 = `tral` (`spec:400-blend`). Additive (GS blend enum 5, a1=5
> @0x001c9de0). Render size scalar ≈0.08 (@0x001c9d9c, the shared sprite-
> pipeline scale; per-flake size varies from an init range @0x001c96b8).
> Fall/wind velocity magnitude not pinned (written outside the analysed path).

> [[400-backdrop]]() the skybox sibling file decodes to one model-local model
> (GARI: 1 object, 25 textured sub-meshes), authored to draw camera-centered;
> panels are individual textures spanning UV [0,1] forming a continuous
> panorama; open-topped (parallax-free behavior observed in the shipped game).

> [[400-fog]]() negative result: no atmosphere/fog fields in the PBD
> format —
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> — and GARI ships an empty camera list; the distance fade is observed
> gameplay footage only.

## The chase camera

The player views a run through a rider-relative **third-person chase camera**.
Six named framing modes — reverse, board, eyes, near, far, and over — are
authored as camera data. Mode 4 selects **near** and course scripts reference
it extensively, but the camera system initializes mode 7 (`replay start`), so
the normal gameplay default is not yet proven. The camera follows a rider-root transform, not
the visibly animated board mesh, so board pose and trick animation do not by
themselves bolt the view to the deck. [[400-camera]]()

The near framing uses a **180-unit camera-local boom** and adds **30 units times
the held-boost control scalar**. It selects rider transform/joint index **4**;
the boom is oriented through that rider-relative reconstruction before producing
the world candidate. The authored full-vector lengths are 1.8 m and 2.1 m at the
100 units/m world scale; they are not the larger live eye-to-board separation,
because the outer driver adds speed-dependent translation lag below.
Its associated subject offset is **100 units**, and its authored pitch bias is
**-0.16 rad** (about -9.2 degrees).
The value 35 in that block is the third component of a local camera vector,
**not a field of view**. In the live `chase near` result its angle against the
180 back component, `atan2(35,180)` ≈ **11.0 degrees**, stacks downward with
the associated -0.16 rad bias: the neutral world reconstruction is therefore
about **-0.352 rad / -20.2 degrees** before the trajectory contribution.
The active render-gather record separately carries a **0.825 rad horizontal
half-FOV** and a **15-unit near clip**. The PS2 projection builder takes
`tan(0.825)` as its half-width, then applies its fixed 4:3 correction. That is
**94.54° horizontal FOV** and **78.15° vertical FOV** at retail 4:3. The
near-clip value is 0.15 m at the 100 units/m world scale. [[400-camera-lens]]()
On a played Garibaldi trace, the final horizontal eye-to-rider separation
approaches **3.0 m** (boost samples approach **3.5 m**), while terrain clearance
shortens the median observed result to about **2.48 m**. Those are moving output
measurements after rider-relative reconstruction, clearance, and the retained-eye
filter; they must not be fed back into that filter as a static candidate boom.

After the chase routine builds and collision-corrects its candidate, the ordinary
camera-manager path applies a second, translational response:

```text
eye[n] = 0.8 * eye[n - 1] + 0.2 * correctedCandidate[n]
```

At 60 updates/s this has a **0.0747 s time constant**, a **0.0518 s half-life**,
and reaches 95% in about **0.224 s**. Its steady-ramp delay is four ticks, or
0.0667 s: at 20 m/s it can contribute about 1.33 m of trailing separation. Camera
cuts and reset/transition branches seed or snap the retained point instead of
flying from stale history. A variable-rate implementation uses
`alpha(dt) = 1 - 0.8^(60*dt)`. [[400-camera-eye-follow]]()

The follow angle does not snap to the
rider: at the 60 Hz update rate it closes **one sixteenth of the remaining
angular error per update**, an exponential response with a time constant of
about **0.26 s**. Implementations running the camera at another update rate
should preserve that response in time rather than applying one sixteenth per
rendered frame. [[400-camera-near]]()

### Airborne landing reveal

The chase camera derives its vertical pan from the rider's **motion vector**,
not from a ledge trigger or a fixed airborne delay:

```text
flightPitch = atan2(verticalSpeed, horizontalSpeed)
basePitch   = -0.16 - atan2(35, 180)              # chase near
pitchTarget = basePitch + flightPitch / (falling ? 2 : 1)
pitch       += (pitchTarget - pitch) / 16       # each 60 Hz update
```

Thus gravity gradually turns `flightPitch` downward after the rider clears a
ledge. The falling contribution is deliberately halved, and the follow-angle
response closes one sixteenth of the remaining error each update, producing
the slow pan that reveals the landing. Rising terrain and takeoffs use the
full trajectory angle. A variable-rate implementation should preserve the
same exponential response in time. [[400-camera-air-pitch]]()

Camera framing is separate from rider contact orientation. A camera should
therefore follow the selected rider transform with its own angular response
and then aim at the rider subject point; it should not copy every frame of board roll, carve
shudder, or airborne trick rotation into the view. [[400-camera]]()

### Terrain clearance

After the boom, pitch and angular follow response have produced a candidate eye
position, the chase routine runs a **world-collision clearance pass** each frame;
the outer manager then applies the 80/20 eye filter to that corrected candidate.
It is enabled per camera mode by an authored flag, and `chase near` ships
with it **on**. Every correction it makes offsets the eye **along the hit
surface's normal** — the camera is never lifted vertically and the boom is
never shortened along its own axis. On a descent this is what keeps the
view gliding above the slope: the eye is pinned at a minimum clearance
measured perpendicular to the snow, which also pushes it horizontally away
from the hill face. [[400-camera-terrain]]()

The pass has three layers, in behavioral terms:

- **Sight line.** A segment is cast from the subject side to the candidate
  eye. If terrain blocks it, the eye moves to the blocking surface and is
  padded **0.4 m out along that surface's normal** (0.6 m for camera modes
  whose authored boom exceeds 500 units). Before this cast, a cast origin
  that itself sits under terrain — an up-facing surface within **1.5 m**
  above it — is locally lifted to **0.2 m** above that surface so a subject
  in a dip cannot false-block its own sight line.
- **Slope clearance.** With the sight line clear, a short vertical segment
  is tested **±0.4 m** through the eye. If the ground crosses that window,
  the eye is placed at the hit point plus **0.4 m along the slope normal**.
  This is the dominant behavior riding down a hill: a slope-normal minimum
  clearance, re-established every frame.
- **Lateral clearance.** Only when the vertical window is clear, the same
  ±clearance test runs sideways along the horizontal axis perpendicular to
  the boom, keeping the eye off banks and walls beside the camera path.

The clearance distance is **0.4 m** for `chase near` and grows to **1.0 m**
for modes whose authored boom exceeds 500 units. The scalar compared against
500 is the camera record's own authored boom length, not a live measured
distance. [[400-camera-terrain]]()

> [[400-camera]]() db:camera-chase; map:"Camera system (live third-person chase)";
> mode table 0x00337808, preset loader 0x00178400, selector 0x001786e8;
> `COMMONOB.CML` chase records and rider-root transform reads.

> [[400-camera-near]]() db:camera-chase; @0x0016e9f8; @0x0016edd0;
> `COMMONOB.CML` `chase near`: local boom 180 + 30·boost-scalar engine units,
> rider transform index 4, associated offset 100, pitch -0.16, follow divisor
> 16; @0x0016e960 proves the value 35
> at record `+0x94` participates in a three-component local vector, not FOV;
> frame-fenced GARI camera trace (2026-07-18, 7,087 samples / 1,029 airborne)
> measured horizontal boom p50 2.478 m, p90 2.978 m, no-boost p95 3.110 m,
> boost p50 2.919 m / p90 3.282 m. A matched-position comparison (1,225
> mutually-grounded samples within 2 m and aligned travel) measured retail
> camera pitch p50 -32.33° vs motion-derived `-0.16 + fallingPitch/2` -22.47°;
> the residual ≈-9.9° agrees with the local-vector angle `-atan2(35,180)`
> (-11.0°) within live transform/update-phase variation.

> [[400-camera-eye-follow]]() direct outer-driver trace: `sub_001748a0`
> @0x001749ec calls candidate/clearance routine `0x0016e918`, then
> `sub_00174250` @0x001742e0 and @0x001742f8 scales retained manager point
> `+0x4dc` by literal 0.8 and corrected candidate record `+0x484` by literal
> 0.2 through vector-scale helper `0x00102f80`; @0x00174310..0x0017434c adds
> and stores the result. Normal steady chase has manager `+0x04 == 0` and
> `+0x4d8 == 0`; camera-cut/transition branches bypass or reseed the recurrence.

> [[400-camera-lens]]() db:camera-chase; @0x001c7998 (active viewport slot is
> `world + index*0x80 + 0x90`); @0x001c79d8 (passes slot `+0x100/+0x104` as
> projection scalars); @0x001dc8d8 (PS2 projection builder); @0x001dcb08
> (`sin/cos(halfFovX)`), @0x001dcb30 (forms `tan(halfFovX)`), @0x001dcb40
> (half-width divided by that tangent); live slot values 0.825 and 15.0.

> [[400-camera-air-pitch]]() db:camera-air-pitch; @0x0016eb2c; @0x0016edd0;
> `chase near` camera block: dynamic-pitch enable `+0xf8`, falling divisor
> `+0x114 = 2`, rising divisor `+0x118 = 1`, follow divisor `+0x14 = 16`.

> [[400-camera-terrain]]() db:camera-terrain-clearance; @0x0016fe78
> (clearance pass, called from the update at @0x0016fa04 gated by record
> `+0xc8`); @0x0016fb20 (vertical/lateral probe helper). Constants in engine
> units: origin unbury window 150 / pad 20; sight-line pad 40 (60 above
> 500); clearance 40 (100 above 500); threshold source record `+0xcc` =
> authored boom (near: 180, enable 1 — `COMMONOB.CML` record +0x10 file
> skew). Probe query f12 param 0.5 on clearance segments [open].
