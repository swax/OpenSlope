# Material alpha mode — the alpha-pass flag (`UnknownInt18 & 0x40000`) — RESOLVED (engine-confirmed)

> Status: **resolved; engine read-site traced.** The opaque/cutout/
> blend mode of a placed-geometry material is an explicit per-material **flag
> bit** at material offset `0x40`, not a property recoverable from the texture
> pixels. The engine reads it in `RenderObjectMeshes_MaterialDispatch`
> (`0x001e2468`) and dispatches the draw on it. Confirms + sharpens the
> `170-materials.md` `[[170-alpha-flag]]` trace — cutout *with holes* (leaves,
> fences, flags) has the bit **set**, alongside true alpha-blend.

## The question

How does the engine decide whether a placed surface draws opaque, alpha-tested
(cutout), or alpha-blended? `170-materials.md` lists the three modes and names
the blend surfaces (glass, `Mdl_Water_River`, LCD jumbotrons), but `220-level-pbd.md`
had the material record as "66 of 72 bytes undecoded… alpha mode has no decoded
field… recoverable from the texture's pixels." The pixel route is unreliable:
the half-bright store (`210-textures-ssh.md`) keeps **opaque** alpha at `0x80`
(128), so a building skin whose windows are painted at `0x80` is byte-for-byte
indistinguishable from a translucent glass pane at `0x80`. Any pixel heuristic
must therefore *guess* opaque-vs-translucent and will be wrong for one of those
two classes. We want the authoritative source.

## Method

The library reads each `TrickyMaterial` record into named + `Unknown*` fields
(`PBDHandler.cs`). Correlate each `Unknown*` field against a ground-truth role
for the material, derived from the **model names** that reference it
(`Models.json` → `MeshData.MaterialID`), across two levels (GARI, ELYSIUM):

- *blend* role  ← `Glass` / `Water` / `Lcd` / `Screen`
- *cutout* role ← `Tree…Leaves` / `Fence` / `Flag` / `Billboard` / crowd
- *opaque* role ← `Tree…Trunk` / building skins / terrain / `MediaTower` body

## Finding

`UnknownInt18` separates cleanly. Distinct values seen: `0x15008` (plain opaque,
the base word), `0x55008` (= base + `0x40000`), `0x35008` (= base + `0x20000`).

- **Bit `0x40000` (bit 18) = alpha-pass**: the material composites with the
  texture's alpha. **Set** on every alpha-test material *and* every alpha-blend
  material; **clear** only on opaque ones. Sharp tell within one model family:
  tree **leaves** `0x55008` (set) vs the same tree's **trunk** `0x15008` (clear);
  **flag** set vs **flagpole** clear.
- **Cutout vs blend** *among* alpha-pass materials is then the texture's own
  shape — a hard transparent/opaque hole mask (a<≈3% near-zero over ≥0.3% of
  texels) is cutout; a smooth partial-alpha band is blend. (This half *is*
  pixel-derivable and reliable; only opaque-vs-not needs the flag.)
- **Bit `0x20000` (bit 17)** appears alone (`0x35008`, bit 18 clear) on a few
  decal/overlay props — `Mdl_Lcdscan`, the firework cylinder, `Mdl_Finish_Coral`
  — an opaque draw-order priority bit (decoded below).

Consistency checks:

- Across GARI (137 tex / 55 with materials) and ELYSIUM (125 / 66): **no texture
  is referenced by both a set and a clear material** — so the flag aggregates to
  the texture without conflict.
- Every name-confirmed blend surface (`Mdl_HalfPipeThing_Glass`,
  `Mdl_Water_River`, `Mdl_Lcd_ScreenLogo`, `Mdl_StartGate` banner) is bit-18 set;
  every `Mdl_MediaTower` body and solid skin is bit-18 clear.
- The old pixel heuristic agreed ~99% but mis-classified exactly the `0x80`
  ambiguous cases: it called `Mdl_MediaTower` windows *blend* (should be opaque)
  and `Mdl_Billboard_EABig` *opaque* (should be blend) — both fixed by the flag.

## Engine read-site

`RenderObjectMeshes_MaterialDispatch` (`0x001e2468`, db func + topic
`object-material`) is the per-mesh object draw loop. For each mesh it resolves
the material pointer from `table[mesh+0x04]`, binds the texture named by the
record's `TextureID`, and routes the draw on the **appearance-flags word**:

| flag | meaning |
|---|---|
| bit 18 (`0x40000`) set | draw as alpha/translucent (`sub_001e8aa8`, itself gated by `ctx+0x640`) |
| bit 18 clear | draw as opaque |
| bit 17 (`0x20000`) | tested **only** on the opaque route; sets descriptor `+0x0e` |

This **pins the byte offset** (flag word = material `+0x40`; TextureID `+0x00`
i16 — the library's sequential read loop matches the record map exactly).
Because bit 17 is read only when bit 18 is clear, it is inert on translucent
materials; its full decode (an opaque draw-order priority, the `0x35008` decal
props) is below.

## Render-path consumption is closed

The loop is reached indirectly through a function-pointer slot at `0x00394b2c`
(`RenderMethod_ObjectMeshes_vptr`; `this`=`a0`, material-pointer table = `a2`,
saved `sp+0x71c`). A whole-`.text` scan for any instruction that loads a `+0x40`
word and bit-tests it against a flag mask returns **exactly one** site
(`0x1e2b58`), and the only masks ever tested are `0x40000` and `0x20000`. So the
renderer reads only `material+0x00` (TextureID) and `material+0x40` (flags), and
the base bits (`0x8/0x1000/0x4000/0x10000`, `0x100`) are **never branched on** —
they are authoring/build metadata, not runtime selectors.

## Material fields not read by the renderer

The PBD is consumed in place; every `TrickyMaterial*` reader is enumerated —
render `0x1e2468` reads `+0x00`/`+0x40`; the loader
`Course_RemapMaterialTextureIds` (`0x260c28`) reads/writes `+0x00` and walks
`+0x44`. The colour blocks (`+0x08`/`+0x20`), the file-scope constants
(`+0x18`/`+0x1C`), and `+0x04` are authoring/build data the engine leaves alone.

## The `0x40000` branch: a per-object depth ordinal, not a state change (resolved)

The open question below — *what the alpha branch changes at the GS level* — is
**resolved: nothing.** The branch changes the draw list's sort key, not the raster
state, and the full decode now lives in `400-rendering.md` "Draw order".

In short: descriptor byte `+0x0e` is a **sort-key source selector** (0 → constant
1023, 1 → constant 1022, 2 → read the halfword at `+0x04`, ≥3 → 0;
`RenderNode_BuildSortKey` @0x001c7598–0x001c75e8). The alpha branch passes
`src = 2` with an ordinal computed in VU0 macro mode @0x001e2b84–0x001e2bdc:
`clamp(trunc(cameraDepth × 1023/40000), 0, 1023)` — the object origin through the
view matrix at `ctx+0x5b0`, ≈ 39 world units per bucket (constants @0x001dd080).
`RadixSort16` sorts **descending**, so translucent object meshes draw
**back-to-front**, after opaque, ahead of the additive sprites (which claim rank 0).

Z-write is **untouched** on that branch. ZMSK is descriptor `+0x11`, written only
by `SetZWrite` (vtable slot `+0x1c4` @0x001e99e0), and the object-mesh dispatch
never loads that slot; its initializers set 0 = write enabled. The additive sprite
batch @0x0012f1e0 is the control case — it calls the same `+0x1ec` slot *and*
`SetZWrite(1)` and blend enum 5, which is what a real translucent state change
looks like here.

Two consequences worth carrying: the depth sort is single-viewport only
(split-screen substitutes a flat ordinal, `ctx+0x640`), and a port whose
transparent draws are **batched** — one renderer per material spanning the level —
cannot inherit this ordering and must compensate some other way, because its sort
granularity is the batch, not the object.

Method note: the VU0 block reads as `.word`/`cop2` in the repo disassembler, which
is why this sat open — it has to be decoded against the COP2 special tables by
hand. Every claim above is read off an instruction; the only item left open is
whether an earlier draw could leak `+0x11 = 1` into the object pass, which the
set-off/restore-on discipline (e.g. @0x001d9150/0x001d9218) makes unlikely but
only a PCSX2 RAM watch closes.

## `0x20000` = opaque draw-order priority (VU disasm + EE trace)

`RenderDescriptor_SetSortKeySource` (`0x1e98e0`, named `SetOpaqueSubmode` before the
value-2 case was decoded) sets descriptor `+0x0e`;
`RenderNode_BuildSortKey` (`0x1c7580`) folds it into the per-draw control word as
a selector (`+0x0e=0 → 1023` default, `=1 → 1022`, `=2 → the halfword at +0x04`),
whose high half `node+0x2a` is
the sort key consumed by `RenderDrawList_SortByPriority` (`0x1c4798`)
→ `RadixSort16` (`0x2d0dd8`). `node+0x2a = (19-mode)<<11 | selector<<1 | primtype`,
so descriptor *mode* is the major key and `0x20000` (1022 vs 1023, Δ2) moves the
draw **one rank later within its mode** — the sort is descending
(bucket-offset loop `0x2d0e64` walks 255→0), and later is the correct end for a
painter's-order tiebreaker on the
coplanar decal/overlay props that carry it (LCD scanline, firework cylinder,
finish coral), since the depth test passes on equality. The object-mesh VU program **P5** (`vu_disasm` program 5,
disassembled with `tools/analysis/vu_disasm.py`) transforms and rasterizes; the sort key is
the selector's only consumer.

## Object-mesh composite state, and the `0x35008` decals

Object meshes share one GS state: alpha-over blend (`ALPHA = 0x44`, set batch-wide
as enum 3 at `0x1e2758` → `GsPacket_AppendAlphaBlendMode` table[3] `0x1c0930`) and
a low alpha test (`ATE=1, ATST=GREATER, AREF=12`; `GsPacket_AppendTestRegister`
`0x1c0ad0`, descriptor `+0x06`), z-write on. A material's mode is therefore its
texture's shape under this shared state: a binary-mask page renders cutout (the
AREF=12 test discards the holes), a smooth partial-alpha page renders translucent.
The `0x35008` decal props ride binary-mask pages with near-black clear texels
(`0063`/`0025` ~98% clear, mean RGB ≈ 0,7,7), so they render cutout — the
importer's cutout classification (`Snowknife/Snowknife/Bundle/TextureBundle.cs`) matches the
engine. `0x20000` itself is an engine-internal opaque sort order with no
Unity-visible counterpart (Unity depth-sorts opaque geometry).

## Open

- ~~**What the `0x40000` branch changes at the GS level.**~~ RESOLVED: nothing —
  it installs a per-object depth ordinal into the sort key and leaves every raster
  state alone. See "The `0x40000` branch" above and `400-rendering.md` "Draw order".
  Residual: that no earlier draw leaks z-write off (`+0x11 = 1`) into the object
  pass — unlikely given the set-off/restore-on discipline, closed only by a
  PCSX2 RAM watch.
- **Offline meaning of `+0x18`/`+0x1C`.** Defined only by the level compiler (no
  engine reader); a `+0x1C ≈` level far-distance reading is a data-side guess.
