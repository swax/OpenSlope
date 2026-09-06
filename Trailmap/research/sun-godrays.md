# The sun's god-rays — what draws the beams

Look toward the sun on Elysium Alps, Mesablanca, Aloha Ice Jam or Pipedream and a
fan of light beams sweeps across the view, over the mountain and over the rider.
This is how that is drawn, where its numbers live, and — first — which earlier
conclusion it overturns. Boot ELF `SLES_505.45` (PAL); all addresses virtual.

## Correction: `cPS2LensFXObjNode` is not the sun flare

`light-flares.md` ruled the map flares out by identifying
**`cPS2LensFXObjNode`** as "the single, screen-space sun/sky lens flare …
hand-unrolled core+rays+ghosts (atlas slots 55/10/12-15/42) … occlusion fade …
~0.7 Hz pulse". **That reading is wrong in every part except the class name**,
and no part of the sun effect lives in that class.

The class is real (RTTI `17cPS2LensFXObjNode` @0x003951a0 via the typeinfo
accessor 0x001eba78; vtable 0x003955a8 installed by the ctor 0x001ebac8; 0x4ac
bytes; the single construct site is 0x001a769c, one node among the ~two dozen the
overlay builder 0x001a74b0 news up). Its vtable slot 13, 0x001ecd00, is what the
old note called `DrawComposition`. What it actually draws is a **bottom-of-screen
message panel**:

- an untextured rect from `(0, y)` to the screen bottom (`x=obj+0x35c`=0,
  `w=obj+0x364`=640, `h=480−y`), colour ≈ (0.88, 0.1, 0.1, 0.1);
- a trim graphic spanning the full width as **two halves of sprite 55** (sub 2 at
  x=−20, sub 3 at x=320, each scaled to 340 px — together −20…660, centred on
  320 because the 340 constant is *screen-centre + 20*);
- right-aligned **localized text**: string ids **362/363** through the string
  lookup 0x002c6338, measured by the text-width call 0x0019e170, positioned at
  `obj+0x360 − width − 42`.

Its sub-drawer 0x001ed398 (called on both branches) is wall-to-wall string-table
lookups — ids **3770, 3564, 362, 363, 17**. `obj+0x350` is not a pulse: it is the
panel's **slide position**, moved 6 px/frame toward a target of 480 (off-screen),
360, or 105 by 0x001ecc20, with `obj+0x4a4` set while it is still moving. The
"atlas slots 10/12-15/42" were **arguments to vtable calls**, not sprite indices.

So: negative result recorded, and the search moved to the glint module.

## The sun lives in `GlintMan_PackSprites` 0x001cd538

Despite the name, this function is **entirely the celestial (sun/moon) builder** —
it is not shared with the lamp glints. Its first act is to read the per-course
enable flag, and if that is clear it branches to **0x001ce11c, the function's own
epilogue**, doing nothing else.

The parameter block is `s5 = [[0x00338e58 + 0x730] + 0x2c]` — i.e.
`courseRuntime+0x2c`, **the selected per-course `WorldConf` record**, the same
148-byte record that carries the sky colour (`spec:442-load`). Combining this
builder with the deferred manager reads in the final draw gives the complete
glare field map:

| offset | type | role |
|---|---|---|
| `+0x00` | int | celestial enable |
| `+0x04`/`+0x08`/`+0x0c` | int 0-255 | **fan/core** RGB (→ glint+0x7c/0x80/0x84, ÷255) |
| `+0x10` | float | per-course **fan intensity** |
| `+0x14` | float | world **radius / half-extent** of the sun quad |
| `+0x18`/`+0x1c`/`+0x20` | int 0-255 | **lens/rim** RGB (→ glint+0x6c/0x70/0x74, ÷255) |
| `+0x24` | float | per-course **corona intensity** |
| `+0x28` | float | **azimuth**, degrees |
| `+0x2c` | float | **elevation**, degrees |
| `+0x30` | float | placement **distance** |

That resolves all nine glare fields `spec:442-record-map` lists, including
both of its "two further colours, unidentified" triples and two of its
"distance-scale floats". The builder itself copies the colours, size and placement into the glare object;
the two intensities take a short deferred path described below.

**Direction.** Both angles are multiplied by π/180 (0x3c8efa35) and fed to the
sincos helper 0x00251140, whose convention is `sincos(x, &sin, &cos)` (verified
on its quadrant-0 exit, 0x00251254: `*a0 = f6`, `*a1 = f1`). The vector built at
0x001cd6a4–0x001cd7c8 is

```
dir = ( cos(az)·cos(el),  sin(az)·cos(el),  sin(el) )
```

so the third component is up. (Cross-check: read any other way, every enabled
course puts its sun tens of degrees *below* the horizon.) The drawn point is
`cameraPos + dir × distance`, assembled through VU0 at 0x001cd7d8–0x001cd7f4 —
the sun therefore rides with the camera and behaves as a body at infinity.

**Sprite.** The glint manager binds particle-bank index **28 = `lens`**
(`emitter-sprite-index.md` for the name table) at 0x001cc28c, from
`[[0x00338e58]+0x30][28]` into `mgr+0x2fc0`. The decoded 256×256 art is a 2×2
atlas: a translucent annulus at top left, a broad soft corona at top right, a
many-spiked star at bottom left, and an empty bottom-right tile. The corona is
not a compact dot: nonzero alpha covers 72.5% of its 128×128 tile, and its radial
mean closely follows `1 - smoothstep(0, 1, radius)` (about 59% at half-radius).

The celestial draw selects **only the top-right corona tile**: live object UV
`(128,0,128,128)`, submitted as `(128,0)` through `(255,127)`. The neighbouring
ring and star tiles are not part of the sun. The builder does calculate a fixed
**16×16-pixel** rectangle at 0x001cd844–0x001cd898 and clamps it into the viewport
at 0x001cd89c–0x001cd930, but the final celestial draw never reads those fields
and the live DMA contains no packet for it. It is dead/legacy intermediate data,
not a second core primitive.

The world quad uses `+0x14` directly as its **radius**: the VU operations at
0x001cda58 and 0x001cdb4c offset opposite camera-plane points by `-size` and
`+size`, and the projection block then takes their full separation. There is no
half-size multiply. If the viewport's far value is nearer than `+0x30`, both the
distance and this radius scale down proportionally (0x001cd5d8–0x001cd61c).

## The beams: a 37-spoke screen-space fan

The rest of the function (0x001cdd94–0x001ce0d8) builds the glare itself, and it
is not a sprite at all — it is a **triangle fan in screen space**.

**The spoke table is authored data at 0x00392F68**: 37 entries, stride 8, each a
`(angle_radians, intensity)` pair, terminated by an all-zero entry at
0x00393090. Every angle is a **whole number of degrees** and every intensity is
exactly **n/21** with n ∈ [4, 18] — hand-authored, and identical on every course.
The ordered pairs are a potentially expressive visual selection rather than a
file-format requirement, so the public note does not reproduce them. The local
recovery recipe is given below; a port that does not need exact visual comparison
can use its own angles and intensity curve while preserving the fan interface.

Construction:

1. A 4-iteration loop (0x001cddd8–0x001cdea8) takes the **angles from the sun's
   NDC position to the four screen corners** — the unit-square points (1,1),
   (−1,1), (−1,−1), (1,−1) — via the arctangent helper 0x00251628 with the usual
   `+π` / `±π/2` quadrant fixups and a `+2π` wrap.
2. A 37-iteration loop (0x001cdef0–0x001ce0d8) walks the spoke table and those
   four corner angles **merged in angular order**, so the corners are spliced in
   as fan vertices wherever they fall and the polygon stays convex.
3. Each vertex is pushed **out to the screen border**: solve
   `centre + dir·t = ±1` per axis (0x001cdf50–0x001cdfd4) and take the nearer
   crossing.
4. Per-vertex brightness is the table's intensity times a falloff
   `alpha = (C − min(d², C)) / C` with **C = 3.0** (0x001ce05c–0x001ce0b4), d
   being the NDC distance from the sun — so a ray that must cross the whole
   screen to reach a far corner arrives dimmer than one leaving through a near
   edge.
5. Vertices land as `(x, y)` float pairs at `glint+140`, stride 8, count at
   `glint+0x88`; the two per-vertex scalars go to `glint+500`/`+504`, stride 8.
   NDC → pixels is the usual `(ndc + 1)·0.5·extent + origin` (f24 = 0.5).

## Final draw: the two missing gains and the actual colour packing

The per-frame manager update at **0x001cc4d0** copies `WorldConf +0x24` to
`manager+0x2fd0`, then **0x001cc4dc** copies `WorldConf +0x10` to
`manager+0x2fd4`. The final `cPS2LightMan` draw routine at **0x001eb5a0** resolves
their roles and the questions the builder alone could not answer:

- The one textured sun primitive uses **rim RGB** and `manager+0x2fd0`, the `+0x24`
  **sprite intensity**. Its UVs select only the white top-right corona tile.
- The fan begins at **0x001eb848** and uses **core RGB on every vertex**, not a
  core-to-rim colour ramp. Its loop at **0x001eb8d8–0x001eba44** gives each
  triangle's centre the spoke intensity × `manager+0x2fd4` × visibility, and its
  two rim vertices the same value times their stored squared-distance falloff.
  Each wedge is therefore contrast-preserving and independently packed.
- Both RGB triples are converted to the GS convention with ×128. There is no
  smooth radial core boost or colour interpolation hidden downstream.
- The sprite is submitted before the fan. Both use exact GS `ALPHA_1 = 0x48`,
  `(Cs - 0) * As / 128 + Cd`: additive blending. `TEST_1 = 0x30000` selects an
  always-passing depth test and `ZBUF_1` has `ZMSK=1`, so neither primitive can
  be occluded or write depth.

### Paused Mesa packet capture: why the corona washes the fan out

A read-only PINE snapshot of PCSX2 2.6.3, PAL `SLES-50545`, paused on Mesa with
the sun visible, located both celestial double buffers by their six exact colour
floats. The active object had visibility 1, projected centre `(143,189)`, corona
destination `(67,87,152,204)`, UV `(128,0,128,128)`, and 42 fan vertices. Its
manager gains were the extracted Mesa values exactly. The generated DMA was
equally decisive: state occupied qwords 0–19, the sole textured corona qwords
20–41, and the fan began immediately at qword 42. No second textured/core draw
exists between them.

The state packet also explains the apparent brightness. GS vertex colours use
128 as unity. At the corona centre the white texture supplies RGB and alpha 255;
under texture modulation followed by `ALPHA=0x48`, the normalized display-byte
contribution is approximately

```
corona = RimColour/255 * SpriteIntensity * atlasAlpha * (255/128)
fan    = CoreColour/255 * FanIntensity * spokeAmplitude * (128/255)
```

(ignoring integer truncation and the fan's rim-distance falloff). Thus the
textured corona has almost **four times the base weight relative to the
untextured fan**. For the live Mesa centre this is about `(0.85, 0.61, 0.056)`
from the corona versus at most `(0.29, 0.15, 0.026)` from its brightest fan
wedge before the destination colour and clamp. The corona saturates the sunset
background first, which is why the retail rays disappear into a broad washed-out
solar body without a separate dot.

**There is no Z anywhere in the fan** — the builder's vertices are two floats
each and the final path emits a flat overlay. That is exactly why the beams read
as shining *through* the mountain and across the rider: for the fan, occlusion
does not exist.

## Per-course parameters

Recovered by emulating the `WorldConf` initializer 0x002582f0 (1180 instructions,
no calls, fp-relative frame, stride 148 — the same straight-line constant-store
pass `ElfPatchService.ExtractMipsWorldConfigTable` uses, extended to track
`swc1` and `mtc1`). **Validated**: the `+0x48`/`+0x4c`/`+0x50` triples it
recovers reproduce all thirteen documented sky colours exactly
(`spec:442-load`), so the same pass's other fields can be trusted.

The glare is enabled on **four of thirteen** course slots: ELYSIUM, MESA, ALOHA
and PIPE. The exact per-course colour, intensity, size, direction and distance rows are
another authored visual selection, so they remain local to the extraction rather
than being reproduced here.

Every enabled course puts its sun within **0.05°–12.6° of the horizon** — a low
sun you ride toward — and the colours are sunset colours. The nine disabled
slots still carry values (GARI/MERQUER/TRICK share one set, MEGAPLE and ALASKA
another), so a value being present says nothing about the effect being on.

## Still open

- **Whether the corona and fan are separately gated.** The
  enable flag switches the whole function.

## Local extraction recipes

These values are no longer read by hand: `snowknife import` recovers the record
from the executable in the ISO and writes it into the map folder as `World.json`
(`snowknife world <iso> <SLOT> <mapDir>` runs just that step on an existing map).
The extraction reuses the sky-colour patch's per-build initializer recipe and
gates on its digest — the same recovered frame must first reproduce the verified
13-course sky table, so an unrecognised executable yields nothing rather than
plausible noise. The pass had to grow `swc1`/`mtc1` tracking to see the float
fields; every one of them is materialised from `lui`/`ori` immediates, so no
`.rodata` access is needed. Verification against a local retail disc confirms
that the pass recovers every enabled record and all of the fields listed above;
the exact rows do not need to enter the repository.

The fixed spoke selection can likewise be recovered from a local PAL executable:
starting at 0x00392F68, decode successive little-endian pairs of 32-bit floats
until the all-zero terminator. Reject the result unless it has 37 nonzero rows,
strictly increasing angles that convert to whole degrees, intensities that become
integers when multiplied by 21, and the terminator at 0x00393090. Those checks
distinguish the measured table shape without publishing its ordered creative
choices. Other builds require their table address to be established independently.

## Port

The Unity reproduction — the spoke table baked into a mesh, and why VR gets a
sky-anchored billboard instead of the console's screen-filling law — is
`Unity/docs/unity/046-sun-god-rays.md`. Port guidance does not belong in this
folder.
