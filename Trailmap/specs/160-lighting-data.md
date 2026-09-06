# 160 — Lighting Data

Lighting in an SSX level is **baked into the data** in two independent forms:
terrain carries per-patch **lightmaps** (precomputed luminance painted across the
slope), and every object instance carries its own small **lighting block** (a
baked ambient colour plus a few directional keys). There is no dynamic light
solve at run time over the static world; the data already encodes the result.
This chapter defines that data. The lightmap texture format is in
`210-textures-ssh.md`; the patch and instance records that hold these fields are
in `220-level-pbd.md`; how the values are applied while drawing is in
`400-rendering.md`.

## Per-patch lightmaps

Each terrain patch references a rectangular **tile** inside one of the level's
shared lightmap **pages**. The patch stores the tile's origin and size in
normalized page coordinates plus the page index; a page is a 128×128-texel
square texture partitioned, without gutters, into a 16×16 grid of
**8×8-texel tiles** — one per patch, 256 patches per page. [[160-tile]]()

The tile carries the **two terms of the game's GS lighting blend**, not a plain
luminance: **alpha = A_S**, the light intensity (`max` of the light colour's
channels), ramping from deep shade to open sun; and **RGB = C_S**, a
source-colour residual that bakes in the base texture. The lit pixel is the
second-pass blend `(C_D − C_S)·A_S` — the hardware-supported form of the desired
`C_D·C_L` (how it is applied while drawing is in `400-rendering.md`). On GARI the
light is blue-dominant, so blue is the `max` channel → `C_S` blue ≈ 0 and the
faint warm residual in R/G is the visible shadow tint. A decoder that keeps only
alpha gets the intensity but loses the light's colour; one that keeps only the
colour channels throws the intensity away. [[160-luminance]]()

The tile is applied with its parametric axes **transposed** (u ↔ v swapped)
relative to the patch's own (u, v) square — a convention distinct from the
index-for-index corner binding the diffuse texture UVs use (`110-terrain.md`).
Getting this wrong puts brightness steps along one axis at every patch boundary.
[[160-transpose]]()

> [[160-tile]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> `Patch.LightMapPoint` (Vector4 origin+size in [0,1] page space; ×128 →
> texels) and `Patch.LightmapID` (page index). GARI: 16 pages, each 128×128
> texels = a 16×16 grid of 8×8-texel tiles, 256 patches per page.

> [[160-luminance]]()
> doc:../research/elf-map.md "Terrain lightmap = a two-GS-context pass" — from
> the 2002 GDC talk "Light maps on the PS2" (EA; slide © EA, not reproduced in
> this repo): `A_S = max(C_L.R,G,B)`, `C_S = C_D − (C_D·C_L)/A_S`, lit `= (C_D − C_S)·A_S`.
> FullColor (RGBA): A_S in the alpha byte (GARI ≈ 76–255), C_S in RGB (faint,
> blue ≈ 0). Library decode `OldShapeHandler.cs` keeps both channels raw. The GS
> blend that consumes it is enum 6 (`spec:400-blend`).

> [[160-transpose]]() doc:../research/extracted-data.md "Terrain patch
> orientation and seam conventions" — boundary-mismatch scored over all 8
> square symmetries: transpose 0.025 vs rot90 0.121 (~5×), and only transpose
> is smooth along both axes (`spec:110-lightmap-tile`).

## Per-instance lighting

Every object instance carries a baked **lighting block** used to shade that
instance (and to seed the lighting of dynamic objects near it): [[160-instance]]()

- an **ambient** fill colour (a cool sky tone), and
- up to **three directional key lights**, each a direction and a colour.

The colours are high-range (they can exceed full white) and vary substantially
across a level — they are genuinely per-instance bakes, not a shared default. A
minority of instances ship with no key at all, and a few ship fully dark; an
implementation must take the data as given rather than assume every instance is
lit. The shading equation that consumes these — ambient plus the clamped sum of
each key's contribution, interpolated across the mesh — is part of the render
model (`400-rendering.md`). [[160-instance-stats]]()

Each key direction is stored in the instance's **model-local raw frame**, the
same frame as the mesh normal it is dotted with—not in world space. If `R` is
the placement's model→world rotation and `Lw` is a world sun direction, the
record stores `Lm = inverse(R)·Lw`. Consequently, comparing raw `LightVector1`
values across differently turned props without first applying their placements
mixes coordinate frames. An authored exporter must localize a world sun for
every instance; copying one world vector to all placements rotates the bright
face with each prop. [measured] [[160-instance-frame]]()

The normal in that equation is the model's stored signed-normalized mesh-normal
stream. Preserve its splits and directions; recomputing or smoothing it changes
the lighting data's input. The i16 encoding represents +1 as **32767**, not
32768: a writer that multiplies +1 by 32768 and narrows without saturation wraps
it to −32768 and flips every positive-cardinal normal. [[160-instance-normal]]()

> [[160-instance]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> `Instance`: a second 4×4 matrix whose columns are `LightVector1..3` plus a
> fourth column (`AmbentLightVector`, role unconfirmed), then four colours
> `LightColour1..3` and `AmbentLightColour`.

> [[160-instance-stats]]() measured over GARI's 3,393 instances:
> `LightColour1` warm (avg ≈ R199 G181 B165, up to 316); ~12% have a zero
> primary key, ~7% fully dark; ~93% carry at least one non-zero key.
> doc:../research/extracted-data.md.

> [[160-instance-frame]]() authored arbitrary-yaw lighting gnomon in PCSX2:
> a world vector written unchanged lit the turned prop's local nose; inverse-yaw
> localization lit the same world-facing card as the editor. Retail GARI agrees:
> transform its stored primary keys through each placement and they recover the
> shared world sun. doc:../research/extracted-data.md "Per-instance lighting frame".

> [[160-instance-normal]]() PBD mesh normals are 3 × i16 / 32768
> (`220-level-pbd.md`). Repack canary cardinal normals round-tripped as
> −1 / +0.9999695 only after the writer saturated +1 to 32767; the prior unchecked
> conversion emitted −32768. doc:../research/extracted-data.md
> "Per-instance lighting frame".

## The global sun

The per-instance key directions are not arbitrary: after transforming each one
from model space through its instance placement, they cluster around a **single
dominant world direction** — the world's one "sun", high and toward one side of
the mountain — with each instance's block holding the local variation. That
dominant direction is therefore recoverable from the instance data itself (and
is corroborated by the gradient of the baked terrain lightmaps). The
forward/back component of the sun is weakly constrained, so an implementation
that wants one global light should treat that axis as the least certain.
[observed] [[160-sun]]()

> [[160-sun]]() the placement-transformed `LightVector1` directions across GARI
> instances align tightly about one direction — up and toward
> −X in the native frame; the terrain-lightmap gradient fit lands in the same
> hemisphere. The along-slope component is near zero in the instance data, so
> its sign is the weak axis. doc:../research/extracted-data.md;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> `Instance.LightVector1`.

## Authored world lights

A level also carries a separate small table of **authored lights**, each with a
**type**, a **glow-sprite resolution**, a high-range RGB **colour**, a
**direction**, a **position**, and an influence **bounding box**. Four types
occur: **0** the single global **directional** light (the sun/moon), **1** the
**point** lights (lamps along the course), **2** small **decorative "flare"**
lights, and **3** the single **ambient** term. [[160-light-types]]()

These lights are consumed in **two** ways. At level load they compute the baked
lighting: the level's **world spatial grid** (below) holds, for each cell, two
light lists — the lights that fall **inside** that cell and those that **cross**
it — and the loader resolves those lists against the light table once (also
rewriting them into direct record pointers); from there the per-patch lightmaps
and per-instance blocks above carry the result. The static world's *illumination*
is therefore bake-time data. [[160-light-bake]]()

At run time, the same records additionally feed the **lamp glint renderer**: each
frame the engine walks the visible grid cells' resolved light lists, takes every
point light whose **glow-sprite resolution is a small class (16/32/64 — the large
classes 256/512 never glint)**, and keeps the **ten nearest on-screen** such
lights, drawing each as an additive camera-facing sparkle at the light's own
position, coloured by the light's **hue** (its RGB normalized to a unit vector —
magnitude discarded) times a **per-record brightness scalar**. That scalar is
**1.0 in every light record of every shipped course**, so in practice **every
glint draws at the same brightness**: a decorative beacon whose colour magnitude
is ≈1 sparkles exactly as brightly as a floodlight whose magnitude runs into the
thousands. Only the **hue** and the **size class** distinguish one glint from
another. A record's colour magnitude is its *illumination* strength — it drives
the bake, and never reaches the sparkle. [[160-glint-brightness]]()
Each sparkle is two things at once: a **fixed 16×8-pixel
core** at the projected position (constant screen size — a far lamp still shows a
tiny constant glint), and **world-sized quads** whose base size comes from the
glow-sprite class (≈1 m / 2 m / 5 m for 16/32/64) so they grow by plain
perspective as the camera approaches. The quads **bloom toward the screen
centre** (size and brightness scale with a centredness⁴ term, up to ~2×), and
their spike-star **rotation is driven by the sparkle's screen X position**
(−π/2 × NDC.x, a second pair at +π/2 forming the cross) — the glint visibly
turns as it crosses the view; there is no time-based spin. Alpha holds at 1 out
to half the draw range, then fades linearly to 0 at the range. The sprite is
drawn **depth-tested at the light's depth**, so world geometry occludes it per
pixel: a lamp behind a ridge shows only the sliver of halo that clears the edge,
and a fully hidden lamp draws nothing — the halo never reads through terrain.
[[160-glint]]()

The **decorative lights (type 2)** are the small coloured light sources dotted
around a level — vivid on a night course (reds, blues, greens). The best-known
are the **flares**: each sits on a decorative flare prop, a small upright
glow-textured column (an ordinary opaque, full-bright object instance) that also
runs a continuous particle plume (`180-particles-data.md`). The type is not
flare-specific, though — a city course also uses it for **park lamps** and for the
**red/blue beacon pairs on parked emergency vehicles** (two records ~0.8 m apart
on a car's roof, one saturated red, one saturated blue). The light's **colour**
bakes into the snow and geometry around it, giving each its hue, and records in
the small glow-sprite classes also glint per the runtime renderer above. The
**glow-sprite resolution** field is the glint selector/size class: small values
(16/32/64) mark glinting lights, large values (256/512) mark lights that never
glint. Type-2 records are authored with a **small colour magnitude** — often ≈1,
i.e. a pure hue at unit length — where the type-1 course lamps run from tens into
the thousands; since the glint discards magnitude, the two glint identically.
[[160-flare-lights]]()

> [[160-light-types]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> struct `Light` (`Type`, `spriteRes`, `Colour`, `Direction`, `Position`, AABB)
> under `NumLights`/`OffsetLights`. Type counts — Snowdream: 1×0, 371×1, 48×2,
> 1×3; GARI: one each of 0/3, many 1, ~98 of 2. Type-2 names on Snowdream:
> `SD_pt_flare`/`redflare`/`blueflare`/`purpleflare`/`caldronlight`.
> doc:../research/light-flares.md.

> [[160-light-bake]]() the load-time reader of the light records is the per-cell
> resolver `PbdLights_ResolvePerCellIllum` (`0x00252d10`, via the accessor
> `Pbd_GetLight` `0x00254fb0`, 92-byte stride), which also rewrites the cell
> light lists into direct record pointers. db:light-flares;
> doc:../research/light-flares.md.

> [[160-glint]]() live PINE experiment on running Snowdream: poking
> a lamp record's colour recoloured its on-screen glint, poking position moved
> it; write-watchpoint on the runtime glint set led to the renderer —
> `GlintMan_Update` 0x001cc318, `GlintMan_GatherVisibleLights` 0x00200be0
> (per-cell visibility bits at cell+0x36, resolved pointer lists at cell+0x40,
> gate `spriteRes & 0x70`), `GlintMan_TryInsertNearest` 0x001cc580 (10 nearest by
> view depth, double-buffered ×2), `GlintMan_UpdateScreenQuads` 0x001cc688
> (record position +0x28 → camera projection → the 16×8-px core at
> 0x001cc7f4–0x001cc838; class size constants (100.74, 300)/(200.08, 500)/
> (500, 800) world units at 0x001cc8d4–0x001cc95c; centredness⁴ boost and the
> −π/2·NDC.x rotation at 0x001ccd84–0x001cd1cc; half-to-full-range alpha fade at
> 0x001cd4a4; colour = unit-normalized record RGB × record+0x08 at 0x001cd3f0),
> `GlintMan_PackSprites` 0x001cd538 (the separate celestial builder; its
> calculated 16×16 rect is dead and the drawer submits one authored-radius
> top-right corona tile plus the fan from two authored degree angles). Sizes/rotation corroborated
> on console (≈1.5 m sparkle on a res-32 flare; tiny constant far
> sparkle; star turns slightly while riding). Occlusion behaviorally confirmed
> on console as per-pixel depth clipping. db:light-flares;
> doc:../research/light-flares.md.

> [[160-glint-brightness]]() the glint colour is built at 0x001cd3f0 as the
> unit-normalized record RGB scaled by the record's fourth field — the float
> immediately after `Type` and `spriteRes` in the `Light` struct (`UnknownFloat1`
> in the library handler, record+0x08). Field survey over every extracted shipped
> course (Snowdream 421, Merqury City 934, Mesa 379, Elysium 218, Garibaldi 942 =
> **2894 light records**): that field is **exactly 1.0 in all of them**, so the
> scalar is a constant in practice and no shipped record dims or brightens its own
> glint. Colour magnitudes |RGB| of the *glinting* records, by type — Snowdream
> t1 449–6858 / t2 1.01–113; Merqury t1 53–125 / t2 1.00–40.5; Mesa t1 12.6–231 /
> t2 0.02; Elysium t1 139–173 / t2 30.3 — confirming magnitude is unrelated to
> glint appearance (Mesa's five `SD_Po_Event_Halo` records glint from |RGB| 0.02).
> db:light-flares; doc:../research/light-flares.md.

> [[160-flare-lights]]() Snowdream: every type-2 light sits 0–7 units from a
> `Mdl_Flare` prop instance (the cauldron lights ~150 u from a
> `Mdl_Lantern_Stone`). Merqury City's 96 glinting type-2 records are named
> `SD_Po_smallHalo_parkLight` (36), `SD_Po_mediumHalo_parkLight` (12),
> `SD_Po_smallHalo_flare` (16) and the beacon pairs `SD_SP_Police`/
> `SD_Sp_EventPolice` (32, one red + one blue per `Mdl_PoliceCar_NoSnow`
> instance, |RGB| 1.000–1.010, spriteRes 16). The spriteRes field is `16`/`32` on
> Snowdream vs `256`/`512` on Garibaldi — which is why Garibaldi shows no glints
> at all. The runtime draw is the glint renderer above ([[160-glint]]()) —
> a search that finds no direct draw call for the glow sprite has missed a
> feeder, not found an absence. doc:../research/light-flares.md.

## The world spatial grid

The per-cell light lists above are one payload of the level's **world spatial
grid** — the broad-phase index that maps any point on the course to the small set
of world elements near it. The grid is a two-level uniform partition of the
course's horizontal (XY) extent: a coarse array of square **main cells** (~10000
units across), each subdivided into a 4×4 array of finer **node cells** (~2500
units across). Every node cell stores index lists of the **patches**, **object
instances**, **splines/rails**, **lights**, and **particle instances** near it.
Patch membership is **single-cell**: each patch is listed in exactly one node
cell — the one containing its bounding-box **centre** — and routinely extends
beyond it (the terrain query tolerates that; the shipped single-listed data
rides without collision gaps). The per-cell **inside** light lists ship empty;
only the **crossing** lists carry light indices, with no repeated index. Single
patch listing is load-bearing for frame rate: the same lists feed the per-frame
render gather, which pays per listing (a grid with patches multi-listed into
every overlapped cell halves the frame rate under accurate blend emulation).
[[160-grid]]()

At run time the grid is the shared **broad phase**: a query point maps to its node
cell, and only that cell's listed elements go to the exact per-element routine that
follows. Terrain contact (`110-terrain.md`), object collision
(`130-collision-data.md`), and rail queries (`350-rails.md`) all narrow their
candidate set this way, and the same grid drives the per-frame render gather
(`400-rendering.md`). The per-cell light lists are the one payload the loader
resolves once at load rather than querying per frame. Because the grid is
**derived from the geometry**, it is rebuilt whenever the patches or instances
change. [[160-grid-use]]()

> [[160-grid]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/LTGHandler.cs
> (`gari.ltg`): `mainBboxSize` 10000 over the patch/instance/spline/light/particle
> XY bounds, each main cell a `nodeBoxWidth` 4 × 4 array of `nodeBoxSize` 2500 node
> cells; per node cell the
> `PatchIndex`/`InstanceIndex`/`SplineIndex`/`LightIndex`/`LightCrossingIndex`/`ParticleIndex`
> lists (plus race/gem instance splits). Measured on original `gari.ltg`: 3,885
> patch entries for 3,885 patches (zero multi-listed; listing node contains the
> bbox centre 3,884/3,885), `LightIndex` empty in every cell/node,
> `LightCrossingIndex` 92,728 entries with no duplicate index per list (max
> 156/node). Engine: course side-file loader builds `gari.ltg` @0x0025f320;
> world singleton @0x00347688. Frame-rate evidence: a rebuilt grid identical but
> for overlap-multi-listed patches (18,188 entries) drops PCSX2 GS
> Blending=Full from 50 to 30 fps standing still; single-listed rebuild restores 50.

> [[160-grid-use]]() the grid is the broadphase for `WorldIntersect_QueryNearest`
> (terrain + object, via @0x00128bc8), `RailQuery_FindNearestRailCandidate`
> @0x00259860 (spec:350-analytic), and the camera-range render gather over world
> singleton @0x00347688 (spec:400-obj-gather, cell size `+0x28`); the load-time
> light resolve is spec:160-light-bake. db:object-cull; map:"Object visibility —
> camera-range grid gather + frustum cull".
