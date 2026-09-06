# Emitter sprite index (`U49`) and the one runtime bank-index space

Resolves how an SSF particle emitter picks its `PARTICLE.SSH` sprite, and closes
the "which bank-index ordering does the runtime use" question that
`spec:180-bank-select` and `elf-map.md` left open. Boot ELF `SLES_505.45`
(PAL); all addresses virtual.

## Result

- **`U49` is the emitter's sprite index.** The `type2Sub0`/`type2Sub2` field reader
  copies `U49` verbatim to `node+0x4`, and the spawn tick uses it as a raw index
  into the shared particle sprite handle table. `U50` → `node+0x8` is a separate
  small mode value (clamped ≤ 10, indexes a per-substep param table at
  `0x00393f68`); it is not the sprite.
- **There is exactly one runtime sprite-index space: the name-table / registration
  order** (`part`=0 … `brk1‑3`=5‑7, `ndl1/2`=8‑9 … `str1`=18, `str2`=19,
  `str3`=20 … `tral`=23). Emitters (`U49`), the board snow-spray
  (`surface+0x44`), and the wake trail all raw-index the same array with it.
- There is also an SSH-internal/file numbering (the `asset_index` column where
  `brk1`=0, `ndl1`=3), used inside the `.SSH` asset itself. No runtime sprite
  lookup uses it; the runtime resolves every index through the name-table order
  above (so snow-spray `+0x44`=16 is `blb1`, index 16 in that order).

## Proof chain

1. **Field reader `ParticleEmitter_ReadType2Sub0Payload` (`0x001d8988`).** Called
   with `a2 = &U0`. First actions: `lw v0, 196(a2)` (`U49`, at `&U0+0xC4`) →
   `sw v0, 4(node)`; `lw v0, 200(a2)` (`U50`) → `sw v0, 8(node)`. So `U49` and
   `U50` are stored opaquely for spawn-time use; the reader itself does no bank
   lookup.

2. **Spawn tick `EmitterNode_SpawnTick` (`0x001d90c0`).** The texture bind reads:
   `lw a0, *(GlobalGameState)`; `lw v0, 4(node)` (= `U49`); `lw v1, 0x30(a0)`
   (handle-table base); `sll v0, v0, 2`; `addu v1, v1, v0`; `lw a1, 0(v1)` — a
   raw `table[U49]` fetch, no remap — then binds `a1` as the emitter's sprite.
   (`node+0x8` = `U50` is separately clamped to `[0,10]` and indexes
   `0x00393f68`.)

3. **The handle table is name-table order.** `ParticleSsh_LoadAndRegisterSubtextures`
   (`0x001cb3f0`) walks the 12-byte-stride name table at `0x0033fff0`, resolves
   each name in the loaded `PARTICLE.SSH` by name, and writes the returned handle
   into a flat 4-byte-stride array **in name-table order** (`array[i] =
   handle_of(nameTable[i])`, missing names get a null slot but still consume the
   index — no shift). Its caller (`0x0017b904`) stores the array at
   `*(GlobalGameState)+0x30` — the exact base steps 2 and 4 read.

4. **The name table (ground truth) — the 38 sprite identifiers the table at
   `0x0033fff0` declares, in table order.** These four-character asset names are
   the functional index the lookups below resolve through; carrying them is what
   interoperating with `PARTICLE.SSH` requires:

   ```
    0 part   1 snfl   2 clod   3 spry   4 halo   5 brk1   6 brk2   7 brk3
    8 ndl1   9 ndl2  10 swd1  11 swd2  12 swp1  13 swp2  14 cnf1  15 cnf2
   16 blb1  17 blb2  18 str1  19 str2  20 str3  21 nois  22 strk  23 tral
   24 ex06  25 ex07  26 ex08  27 ex09  28 lens  29 blnk  30 mip1  31 mip1
   32 mip2  33 beam  34 fog0  35 spec  36 envr  37 exlm
   ```

   Independently validated by the wake-trail draw reading offset 92 (= index 23)
   for `tral`, and by the emitter/board-spray lookups above sharing this base.

5. **Board snow-spray uses the same space.** `BoardSpray_AssetHandleResolve`
   (`0x00131b00`): `surface+0x44` (`spray_asset_index`) → `sll ,2` → `+
   *(GlobalGameState)+0x30` → `lw` handle → `slot+0x180`. Same table, same raw
   index. So the runtime ordering is unambiguous and shared.

## What the shipped levels actually emit

The original five-level census enumerated `U49` over every authored
`type2Sub0` emitter and found **zero** `type2Sub2` records in those five:

| Level | emitters | `U49` values → sprite |
|---|--:|---|
| GARI | 107 | 0 `part` ×71, 2 `clod` ×4, 19 `str2` ×32 |
| MESA | 176 | 0 `part` ×139, 2 `clod` ×5, 19 `str2` ×32 |
| SNOW | 184 | 0 `part` ×120, 2 `clod` ×9, 11 `swd2` ×1, 18 `str1` ×6, 19 `str2` ×48 |
| ELYSIUM | 58 | 0 `part` ×22, 2 `clod` ×4, 19 `str2` ×32 |
| MERQUER | 73 | 0 `part` ×6, 2 `clod` ×34, 13 `swp2` ×1, 19 `str2` ×32 |

Correlating with `U0` (count) on GARI: the **200-spark fireworks resolve
`U49`=0 → `part`** (the soft white point); the 40-count gem sparkles use
`str2` (index 19, the soft star — the same sprite ambient snowfall draws); the
100-count puffs use `clod`.

The later full twelve-course census adds exactly one SubType-2 graph: UNTRACK
effect 10, shared by 34 `Mdl_Tree_SnowGhost_*` instances. It selects `clod`
(U49=2), so it does not expand the sprite union. Its burst begins at the live
contact point and launches along the outward normal; the stored origin/direction
are replaced by the constructor (`elf-map.md`, "The collision shell and the SSF
MainType 2 / SubType 2 particle").

The union of emitter sprites across the five-level table (and the added UNTRACK
collision graph) is
`{part, clod, swd2, swp2, str1, str2}`. **`brk1‑3` (indices 5‑7) and `ndl1/2`
(8‑9) never appear.** Including the one collision emitter, the **bark and
needle sprites are loaded into the bank but referenced by nothing** — orphan
source art. (The only surfaces whose `spray_asset_index` even names a `brk`/`ndl`
slot — type 12 `brk3`, type 16 `ndl1` — have `spray_emit_rate = 0`, so they
spray nothing; vestigial defaults.)

## Board snow-spray sprites, re-read in the correct order

`spray_asset_index` per spraying surface, resolved against the name-table order:

| surface | `+0x44` | sprite | emit rate |
|---|--:|---|--:|
| 1 standard snow | 16 | `blb1` | 0.075 |
| 2 standard off-track | 13 | `swp2` | 0.159 |
| 3 powdered snow | 20 | `str3` | 0.505 |
| 5 ice standard | 15 | `cnf2` | 0.200 |
| 6 bounce/unskiable | 13 | `swp2` | 1.000 |
| 9 rock/off-track | 13 | `swp2` | 0.032 |
| 18 show-off ramp/metal | 15 | `cnf2` | 1.854 |
