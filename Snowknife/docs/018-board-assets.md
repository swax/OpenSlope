# 018 — Board assets (decks, skins, and skis)

The Unity rideable board can use the game's deck meshes and skins rather than a primitive. This document owns
the extraction side: locating those assets, exporting portable geometry, decoding skins, and producing the
optional SSX On Tour ski assets. Unity placement belongs to
[Unity 018](../../Unity/docs/018-board-visual.md).

Code: `Export/CharExporter.cs` (`ExportBoard`) and `Services/ModelService.cs` (`board` command).

## What the game stores

Every rider rides **one shared model**: `DATA\CHAR\MDLPS2.BIG` → `board.mpf`. There's no per-character board —
the per-rider look was *texture*, not geometry. Inside, `board.mpf` is **six decks** plus their shadow volumes:

| Sub-model | Group type | What |
|---|---|---|
| `Al`, `Bx`, `Fr` | 1 (render) | three deck shapes, regular stance |
| `AlGoofy`, `BxGoofy`, `FrGoofy` | 1 (render) | the same three, mirrored for a goofy stance |
| `shdwAl`, `shdwBx`, … | 17 (shadow) | flat shadow-caster volumes (skipped) |

They're all stacked at the origin, so anything that reads "the whole file" gets six overlapping boards. We
want the three regular **shapes** kept apart — they're genuinely different decks (`Al` 106v/88t, `Bx`
128v/104t, `Fr` 125v/107t), not LODs — and we skip the goofy mirrors (a left/right flip adds nothing on a
rideable board) and the shadow volumes.

## Exporting the decks + skins

```
snowknife board ssx-tricky.iso Maps/Shared/chars
```

(Boards are level-independent, so this normally runs as part of the one-shot `snowknife shared <iso>
Maps\Shared` project bootstrap; `snowknife unity` then stages `Shared/` into the project's
`Assets/OpenSlope/Maps/Shared`.)

`CharExporter.ExportBoard` ([001](001-cli-export-pipeline.md)) pulls `MDLPS2.BIG` out of the ISO (the same
extract the `rider` rider-height step uses — [004](../../Unity/docs/unity/004-orientation-and-scale.md)), parses `board.mpf` with the
shared `TrickyPS2MPF` model reader, and writes the **three regular decks** — `board_Al.obj`, `board_Bx.obj`,
`board_Fr.obj` — each with positions, **UVs and normals**. (The rider export only needed positions for its
height measurement; the board keeps UVs so it can be textured.) It takes only the standard render group
(type 1), skipping the `shdw*` shadow volumes and the `*Goofy` mirrors, and logs each deck's size. A plain
`board.obj` (a copy of `Al`) is also written so the old single-deck callers / the box fallback still resolve.
Geometry stays in raw SSX model units / unflipped handedness, exactly like the rider export — scale and
orientation are applied where it's placed (next section).

The same command then decodes the **deck skins** (next-but-one section) into `BoardTextures/`. Everything
lands in `Maps/Shared/chars/` — the same gitignored export tree the level data lives in, so it's a build
artifact of *your* disc, not committed.

## Texture (the real deck skins)

The deck's graphic is the 4-char texture id **`bord`** — and it lives in the **char texture bank**
`DATA\CHAR\TEXPS2.BIG`, *not* the level bank (which is why the `import` texture path never saw it). That bank
holds one `data/char/<rider><N>_bord.ssh` per board skin: **146** in all — twelve numbered skins (`1`–`12`)
for each of the twelve riders, plus two specials (`mallora`, `mmm`). Each is the old-PS2 `SHPS` variant, so
the *same* `OldShapeHandler` the crowd/particle banks use decodes it ([001](001-cli-export-pipeline.md)) to a
single 128×128 image whose shortname is literally `bord` — exactly the id the deck materials reference.

So the same `snowknife board` step (`ExportBoardTextures` in `Services/ModelService.cs`) pulls `TEXPS2.BIG` out of the ISO,
`BIG.Extract`s it, and writes every `*_bord.ssh` to `Maps/Shared/chars/BoardTextures/<id>.png` (e.g.
`mac1.png`, `psymon3.png`). They're real deck atlases — deck-top art on the left, the binding straps on the
right — and the deck OBJs' authored UVs already map onto that layout, so a skin lands correctly with no .mtl.

The decode `*2`-**brightens** each skin (`BrightenImage`), the same PS2 modulate2× inverse the level/skybox
textures use ([001](001-cli-export-pipeline.md) gotcha 5). Without it the skins import uniformly dim — the
`bord` atlases are authored half-bright (opaque pixels cap at 128) because the GS doubles texture colour at
draw, so the raw decode looks washed-out grey next to the game's vivid decks.

`BuildBoardVisual` dresses each spawned deck in a **random rider skin** (× a random deck shape). The pool is
**all 144 rider boards** — `BoardSkinIds()` enumerates every `<id>.png` under `BoardTextures/` (via the asset
database, cached for the session) and drops only the two non-rider specials (`mallora`, `mmm1`), leaving the
12 skins × 12 riders. `GetOrCreateBoardMaterial` builds a plain `OpenSlope/UnlitDoubleSided` material from
`BoardTextures/<id>.png` the first time a skin is picked and caches it under `chars/BoardMaterials/<id>.mat`,
so materials accrue lazily as skins come up (≤144 ever); it falls back to the model's default material if the
skins aren't imported (you skipped `snowknife board`). Texture cost is negligible — each skin is 128² DXT1
(~22 KB), the full set ~3 MB of VRAM, and only the picked skins ship in the Unity build.

## SSX On Tour skis (`snowknife skis`)

SSX On Tour — a *different* game on its own disc (`ssx-on-tour.iso`, PS2) — has skiers as
well as boarders, and its ski "deck" is the direct analogue of `board.mpf`. `snowknife skis <iso> [outDir]`
rips it the same way `board` does, into drop-in OBJ + skins:

```
snowknife skis ssx-on-tour.iso Maps/Shared/chars
```

→ `ski_SkisA_H.obj` / `ski_SkisP_H.obj` (+ a back-compat `ski.obj`) and `SkiTextures/skis_<brand>_NNN.png`.
Code: `Export/SkiExporter.cs` and `Services/ModelService.cs` (`skis` command). It mirrors `board`,
but On Tour is a later engine, so three things differ:

- **Where the model lives.** On Tour keeps equipment in a separate **vehicle** archive
  `DATA\CHAR\V_MDLPS2.BIG` (skis / poles / boards), not `MDLPS2.BIG` (bodies + clothing). Each piece is its
  own `.mpf` member at several LODs (`vehicles_SkisA_H/M/L`) plus a `_Shdw` shadow volume; `skis` takes the
  highest-detail render decks (`SkisA`, `SkisP`) and skips the shadows.
- **The model reader.** On Tour `.mpf` is a different format (id 14 vs Tricky's 8 — see
  [Trailmap: 240-models-mpf]): 112-byte directory entries and **RefPack-compressed** per-model
  data blocks. It's read by the shared library's `SSXOnTourMPF` + `SSXOnTourPS2ModelCombiner`, which hand
  back a flat triangle list; `SkiExporter` writes those straight to OBJ (positions + UVs + normals, no
  skinning — the skis are a rigid prop). *(Fixing a latent null-deref in that loader — it computed each
  block's size but never read the bytes before decompressing — was the one library change this needed.)*
- **The skin format.** On Tour char skins are the mixed-case **`ShpS`** variant → `NewShapeHandler` (the
  Tricky `bord` skins above are uppercase `SHPS` → `OldShapeHandler`; both are documented in
  [Trailmap: 210-textures-ssh]). `NewShapeHandler` already doubles the half-bright *alpha* at
  decode but not RGB, so `skis` applies the RGB half of the `*2` brighten (gotcha 5) itself to match every
  other displayed bank.

Scale is the same 100 u = 1 m (`~0.01`): a ski reads ~2 m long. This is **drop-in geometry + skins only** —
there is no rideable-skis vehicle yet ([017](../../Unity/docs/vrchat/017-rideable-board.md) is snowboard-only); a ski-ride mode
would build on this the way `board` feeds the rideable board.

## Unity runtime handoff

Deck placement, orientation, scale, skin materials, and the fallback visual now live in [Unity 018 — Board visual](../../Unity/docs/018-board-visual.md).

## See also

[001 — CLI export pipeline](001-cli-export-pipeline.md), [Unity 018 — Board visual](../../Unity/docs/018-board-visual.md), and [Trailmap: 210-textures-ssh, 240-models-mpf].
