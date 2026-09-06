# Series comparison — SSX (2000), SSX 3 and On Tour against the Tricky baseline

Derivation notes behind `../specs/500-series-ssx-2000.md` (spec:500-role),
`../specs/510-series-ssx-3.md` (spec:510-role) and
`../specs/520-series-ssx-on-tour.md` (spec:520-role).
Conclusions live in those chapters; what stays here is method, the full
interface inventories too bulky for a citation, negative results, and open leads.

Everything was measured from the reader's own discs. Nothing extracted is
committed — the same rule as the rest of this repo.

## Sources

| Title | Image | Boot ELF | Example data |
|---|---|---|---|
| SSX (2000) | NTSC-U CD, Mode 2 Form 1 | `SLUS_200.95` | `DATA/MODELS/MERQUERY.BIG` |
| SSX Tricky | NTSC-U DVD | `SLUS_203.26` | `DATA/MODELS/MERQUER.BIG`, GARI |
| SSX 3 | NTSC-U DVD | `SLUS_207.72` | `DATA/WORLDS/BAM.BIG` |
| SSX On Tour | NTSC-U DVD | `SLUS_212.78` | `DATA/WORLDS/BAM.BIG` |

Merqury City ships in both SSX (2000) and Tricky, so every count in the
comparison is a true A/B on the same course rather than a cross-course guess.

## Method

- **CD conversion.** The 2000 disc is a raw 2,352-byte-sector image. Sector 0
  reads sync + Mode 2 header (mode byte 2) and sector 16 carries `\x01CD001`
  at offset 24, so user data is `[24 : 24+2048]` per sector. A straight slice
  produces an image the ordinary ISO reader opens.
- **Cell walk (2000).** `WDXHandler.cs` header is 72 bytes (the four trailing
  u16 fields are easy to miscount as u32 and put every grid offset out of
  range), then the model directory, then the cell offset/size table. Each cell:
  align 16, 3 × Vector3, 6 × i16 counts, 16 × 48-byte fixed entries, count-sized
  4-byte entries, align 16, then instances (272 B), patches (448 B), spline
  segments (128 B), lights (88 B). Residual check = declared end vs walked end:
  119/131 exact on Merqury City. The 12 stragglers were not chased.
- **Chunk walk (SSX 3).** Length-prefixed chunks, each RefPack; accumulate
  until a `CEND` chunk, then read the group as `id u8 | size u24 | track u8 |
  rid u24 | body`. RefPack decoder ported from `Refpack.cs`.
- **Block walk (On Tour).** Fixed 32,768-byte blocks, 12-byte header
  (`CBXS`/`CEND`, u32 block size, then a type byte + u24). 5,247 + 532 blocks
  tile the file exactly. Type 3 = payload starts with `10 FB`; type 11 =
  payload is not compressed. Reassembly attempts and their yield over the
  first 120 groups: decompress type 3, append type 11 whole → 6/120 clean
  record walks; append only the header's u24 bytes of type 11 → 15/120;
  concatenate all payloads then scan for streams → worse. Over the whole
  file the best of these reaches 38/532. **Unsolved.** The u24 is not the
  used length (it exceeds the payload on type 11 blocks), and streams do not
  span blocks (block 0's stream terminates at 32,709 of 32,756 payload bytes
  with zero padding after it, while the next block's payload is not a
  stream). Next thing to try is the ELF loader rather than more pattern
  matching.
- **Plane fit.** Per patch, the eigenvector of the smallest eigenvalue of the
  centred corner-cache covariance. Ordering-independent, which matters because
  SSX 3's corner order does not give consistent winding under a naive cross
  product (a first attempt using edge cross products produced signed means near
  zero and no usable axis).

### Trap worth remembering

The sixteen stored per-patch vectors are **power-basis coefficients**, not
Bézier control points (spec:110-patch-model). Statistics taken over them
directly are meaningless — the first attempt reported "patches" spanning 1.5 km
and a world 13.9 km tall. Geometry stats must come from the stored corner
cache or the stored bounds.

## Node-kind name tables

The engine's effect-node kind names, one contiguous table per title. This is
the primary evidence for spec:500-nodes and spec:510-nodes.

**SSX (2000)** — `SLUS_200.95` @0x001a9dd8, kill node at @0x001a9ab8:

```
DeadNode · Debounce · AnimObject · AnimDelta · AnimCombo · UVScroll ·
UVScrollTexFlip · LapBoost · RandomBoost · CrowdBox · AnimTexFlip ·
cMeshAnim · TrickTrigger · Particle · SplinePath
```

**Tricky** — `SLUS_203.26` @0x0026c6a0, kill node at @0x0026c0a8:

```
cMeshAnim · Roller · Debounce · AnimObject · AnimDelta · AnimCombo · Counter ·
Boost · Timer · Rail · UVScroll · TexFlip · UVScrollTexFlip · Fence · Flag ·
Cracked · LapBoost · RandomBoost · CrowdBox · ZBoost · AnimTexFlip ·
TrickTrigger · Particle · Movie · TubeEndBoost · Camera · Emitter ·
CollideEmitter · SplinePath
```

Tricky additionally carries the full RTTI class list for these — `cRollerNode`,
`cBoostNode`, `cCounterNode`, `cCrowdBoxNode`, `cFenceNode`, `cFlagNode`,
`cUVScrollNode`, `cTexFlipNode`, `cMeshAnimNode`, `cTubeEndBoostNode`,
`cZBoostNode`, `cTrickTriggerNode`, `cCollideEmitterNode` and a `…State` twin
for each. **None of those class names appear in the SSX 3 ELF.**

**SSX 3** — `SLUS_207.72` @0x0038a658 (and a second copy @0x00382658):

```
AnimDelta · AnimCombo · AnimTeeter · Conveyor · Floating · AnimObject ·
DeadNode · RestoreNode · DeadFade · Debounce · FlexBridge · MeshAnim ·
ParticleNode · FloatRail · SpringRail
classes: cParticleNode · cMeshAnim · cDebounce · cDeadFade
```

`"Invalid token."` sits at @0x0038a5d0, immediately before the table — the
names are a text parser's vocabulary.

**On Tour** — `SLUS_212.78`: **no table**. Probing the whole string table for
every name above returns zero hits, as do `Luno*`, `WorldTriggerManager` and
`Invalid token.`; `WScriptMan` is the only survivor. The longest identifier
run in the ELF (479 entries @0x0040e1b8) is the rider animation clip table
(`IDLE_A_CYC`, `R_FWD_CYC`, `R_ICE_TS_1_CYC`, …), not an effect vocabulary.
(spec:520-nodes)

## SSX 3 authoring evidence

- **Names.** `bam.psm` holds 89,676 authored names in five arrays matching the
  bin counts. Convention `<type>_<track>_<description>_<serial>`, e.g.
  `patch_ERA5_sec3patchs_3400`, `mdl_DBC2_rock_de_bolder_e_01_3009`,
  `spline_EBC3_logbreakteeteranim_1000`,
  `mdl_ARA1_stump_redwood_a_2000_CollideModel_ConvexHull`.
  Shipped residue includes `patch_BRA2_bsdkfgdso_1410`, `mdl_DSS2_temple1`,
  `mdl_ERA5_newrocksummit_1040`.
- **Editors.** `DATA/CONFIG/INPUT.MAP` is commented plain text. Its field-name
  families expose a general editor (`Editor*`), a path editor (`PE*`), a
  collision viewer (`CV*`) and script-camera editing. Representative interface
  identifiers are `EditorHelp`, `PEAddEvent` and `CVToggleDisplayMode`; a comment
  also identifies `mbxscriptengine.cpp`. The retail comments and binding rows
  are paraphrased rather than reproduced.
- **Scripting.** `LunoVMRegister`, `LunoVMCallParam`, `cLunoTable`,
  `cLunoTableEntry`, `WScriptMan`, `WScriptTasks`, `WScriptProcess`,
  `WScriptMission`, `cWScriptCache`, `WScriptFile`, `InputParser`.
  `DATA/SCRIPTS/SCDAT.BIG` = `scmaster.dat` + ~100 bundles of
  `scr*.isb` + `anm*.afl` + `snd*.bnk`.
- **Trigger runtime.** `WorldTriggerManager`, `m_aWorldTriggerInstances`,
  `m_aTriggerInfoInstances`, adjacent to `data/config/watrig.adl`.

Zero editor / VM / world-script symbols in the 2000 or Tricky ELFs.

## Instance tail — readings considered

The bytes past the 160-byte fixed part of an SSX 3 instance (spec:510-instance-tail).
Observed: 16-byte entries, first word `0x3000000C`-shaped, second word a small
multiple of 16, groups closed by `0x60000000`, trailing `0xDEADBEEF` filler.

- *Nested chunk directory* (mirroring the outer container's id+size): rejected —
  the second word reaches 1,888 on records whose whole tail is 1,056 bytes, so
  it cannot be a size within the record.
- *(class id, allocation size) manifest*: possible, and was the working reading
  for a while; does not explain the strict 16-alignment of every second word.
- *Console transfer-chain tags* (adopted, `[inferred]`): the tag field position
  and its two observed values are the reference and return tags; every address
  is qword-aligned across all 41,113 records, which a size field would not be;
  the alternating large/small pairs read as geometry packet + register packet.

Confirming this properly means tracing the consumer in the ELF. Not done.

## On Tour authoring evidence

- **Names.** `BAM.psm` parses with the SSX 3 reader unchanged: 68,928 names in
  **eight** arrays (SSX 3 has five). Extra arrays are placements/layers (805,
  e.g. `night_objects_f_wood_er3_stadium_1023 er3`, `f_trigger_3475 wr3`),
  missions (286, e.g. `vb4_medal_race_4_r3`, `wr1_shred_airtime_1`,
  `Freeride_np2`) and effect instances (209, e.g. `er4_fw_archlights0g`,
  `np3_fallingsnow_smoke0`, `er3_torch_spark`), plus 29 start/finish areas.
  Fifteen track codes: vb1–4, wr1–4, er1–4, np2/np3/npp, vh1.
- **Day/night.** Layer prefixes `day_objects_` / `night_objects_` /
  `common_objects_` / `common_patches_`; per-track sidecar members `<track>d`
  and `<track>n` with `.tp` and `.sp` extensions (magic `Biii` / `ciii` — the
  same `*iii` family as SSX 3's path bin magic `iiii`); word census day 1,773,
  night 1,500.
- **Characters.** `DATA/CHAR/*.TXT`, one per rider, is commented plain text.
  Each `mdl` row supplies the fields `mdl_file_name`, `part_name`, `LOD` and
  `variant`. `MDLPS2.BIG` (BIG4) holds 1,227 members, one per part per tier,
  with names matching those local config rows.
- **Editors.** `DATA/CONFIG/INPUT.CFG`, commented plain text: every SSX 3
  editor family plus additional browse controls, a larger `ScriptEdit*` family
  and mission-debug controls. `EditorBrowseRenderToggle` and
  `MissionDebugRecord` are retained as short interface examples; the original
  comments and binding sequences are not. Front end is Flash-style
  (`cAptObjNode`, `cloneNode`, `createTextNode`).

## Negative results

- **No strings in SSX 3 world logic bins.** Full scan of bins 3, 13, 15, 16
  and 17: no meaningful ASCII. The node-kind vocabulary is engine-side only,
  so the shipped data addresses kinds numerically. (spec:510-nodes-absent)
- **The baseline collision-sound sidecar layout does not read SSX 3's
  equivalent.** `{hash, offset}` pairs parse the Tricky file 3,881/3,881 and
  the SSX 3 per-track bin 8/456. The SSX 3 stride is 24 bytes, pinned by
  `16 + 456 × 24 = 10,960` = the payload offset stored in every entry.
  Same leading magic, different body. (spec:510-adl)
- **The group terminator is not universal.** SSX (2000) course and lightmap
  banks contain zero occurrences of `Buy ERTS`; only the sky bank has one.
  This contradicts the blanket claim in spec:210-directory, which is now
  qualified there. (spec:500-ssh)
- **SSX 3 surface labels do not transfer.** Value 10 (baseline: *wall*) is the
  flattest class in the mountain at 0.85 mean up-component; value 9
  (baseline: *rock*) is the steepest at 0.13. In the 2000 title the same
  value 10 measures 0.38 against snow's 0.66–0.77, i.e. it behaves as a wall
  there. Shared value space, re-assigned meanings. (spec:510-surface)

- **SSX 3's path tuple does not occur in On Tour.** The leading constant
  tuple `(2, 100, 4)` has zero occurrences there because On Tour's path lead
  carries **three** properties (`#iii`, 1, 3, (100,4,v), (101,4,1),
  (102,4,v)); the 9,721 path records are found only once the container is
  reassembled (below). A tuple scan is not a path census. (spec:520-paths)
- **On Tour has no effect-node name table.** See the table section above;
  the behaviour ships as compiled `LUN` bytecode in world bins 21–23
  instead. (spec:520-nodes spec:520-scripts)

## On Tour container

Derivation scripts `t1_headers.py` … `t17_coll.py` and their `*.out.txt`
(analysis scratch, not vendored); conclusions in spec 520. The short form:

- Block header = `{tag CBXS|CEND, 32768, flags:8 | carry:24}`. Flags bits:
  0 day, 1 night, 3 raw. Carry = offset of the first record header inside
  this block's decoded payload. Compressed payloads are self-contained
  RefPack streams (decode 32,821–81,920 B, 80 KB input cap) + zero fill; raw
  payloads are the full 32,756 B.
- Composition: decode each compressed block independently, take raw blocks
  whole, concatenate in file order through the `CEND` block. 532/532 groups
  walk clean; sizes match the `.sdb` sector table 532/532.
- Record header = `{bin:8 | mask:2 | size:22}`, `{sector:16 | rid:16}`
  (SSX 3 used 8/24). Sector = group index + 2; sector 0 = globals, duplicated
  into every group that needs them.
- Bins: 0 materials, 1 patches (432 B, 22,896 + 14,906 night twins), 2 models,
  3 instances (176 + chain), 4/5 particles, 6 lights, 7 halos, 8 splines
  (48 + 128n/144n), 9 textures, 10 lightmaps, 11 curtains, 12 collision, 13
  hash table, 14 AI paths (9,721; `#iii` + 3 properties; 20-byte points),
  15 per-track tables, 18 `ABKC` banks, 21 script bindings (28 B, keyed by
  instance), 22 `LUN` scripts, 23 per-track script list, 24 effects (220 B).
- `.sdb`: 328-byte header (per-bin totals at +56, capacities at +164), 532 ×
  108-byte sector entries (id +26, size +36, per-bin counts +52..+107),
  named-line table (40-byte entries), area table (29 entries).
- Name map arrays 0/1/2/4 = patches/instances/models/splines; 3 = textures
  (not placements); 6 = effects; 7 = areas.

## Open leads

- Decode the SSX 3 per-track bins (13, 15, 16, 17). No decoder covers them,
  they carry no strings, and the instance carries no back-reference to them,
  so the relation is one-way from an undecoded blob. This is the blocking
  item for any statement about how SSX 3 wires behavior to a placement.
- **On Tour field-level leads** (container: section above): patch template
  id/flags, surface labels, path properties 100/102 and event kinds,
  instance +148/+152/+168/+170, the `LUN` bytecode, the hash-table payload,
  the `.sdb` unnamed words, and the reader side (does the loader resume
  through the carry?) — a trace of `SLUS_212.78` from the `Refpack` symbol at
  file offset 0x427B40 / `data/worlds/%s` at 0x3E3B55 would settle the last.
- SSX (2000) `.wds` contents; the 12 non-tiling cells in the example course.
- Whether the 2000 title's node kinds share the baseline's per-node payload
  layouts. Only the vocabulary and the container were measured.
- Both titles' Part 3 constants. Nothing here touches rider physics; the 2000
  title is the tractable target (same engine lineage, same node container,
  an ELF of comparable size), SSX 3 is not.
