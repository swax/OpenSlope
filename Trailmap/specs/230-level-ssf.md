# 230 — SSF Level File

The `.ssf` member of the level archive (`200-archives.md`) carries the
level's behavior data: the shared object-properties records, the effect-slot
logic graph and its chains, named functions, the collision proxy pool, the
physics body pool, the instance join table, and per-spline logic descriptors.
It is the on-disc encoding behind `130-collision-data.md` (collision and
physics bodies), `150-logic.md` (effect slots, chains, functions), and parts
of `180-particles-data.md` (emitter parameter blocks). [measured] [[230-role]]()

All scalars are **little-endian**; types are 32-bit ints and IEEE-754
singles, 16-bit ints, raw bytes, and one fixed 16-character NUL-padded ASCII
name field. Linear units are engine centimeters (`002-conventions.md`).
[measured] [[230-conventions]]()

> [[230-role]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `Load`/`Save` (the modder round-trip independently confirms record sizes);
> raw PAL `gari.ssf` parsed byte-level for this chapter.

> [[230-conventions]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Utilities/StreamUtil.cs
> LE defaults (SSF never passes BigEndian); cm frame, scale 0.01.

## Header — 76 bytes

Nineteen 32-bit fields: three unknowns, then eight (count, absolute offset)
pairs. On the example level the section extents **tile the file exactly** —
header + slots + pointer tables + functions + chains + pools + properties +
instance table + splines = the file size — which pins every record size below
independently of any parser. [measured] [[230-header]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | tool stamp — the same value (1,966,592) on every retail level; never read [[230-loader-accept]]() |
| 0x04 | u16, u16 | **format tag**: the low half-word must be **0x1500** or the loader discards the whole file; the high half (0x0010 on every level) is never read [[230-loader-accept]]() |
| 0x08 | f32 | exporter stamp (≈0.00607, differing per level only in the fifth digit); never read [[230-loader-accept]]() |
| 0x0C | u32 ×2 | effect-slot count, offset |
| 0x14 | u32 ×2 | physics-pool pointer count, offset |
| 0x1C | u32 ×2 | collision-pool pointer count, offset |
| 0x24 | u32 ×2 | anonymous effect-chain count, offset (the chain *header* table) |
| 0x2C | u32 ×2 | named-function count, offset |
| 0x34 | u32 ×2 | object-properties count, offset |
| 0x3C | u32 ×2 | instance count (== the PBD instance count), offset of the join table |
| 0x44 | u32 ×2 | spline count, offset |

The file is loaded whole into one buffer and its eight section offsets are
relocated in place — the on-disc header is the runtime structure. The loader
accepts it under exactly three conditions: the file exists, the format tag at
offset 4 reads 0x1500, and the header's instance count equals the PBD's. On
any failure the buffer is freed and the level runs with **no** behavior file:
every instance is then bound to one built-in default properties record —
response mass 1000, bounce 0.5, visible, collision mode 0, no shape, no
effect slot. The 0x1500 tag is the same stamp the PBD's magic opens with, so it
is a shared level-file format tag rather than a per-file version.
[measured] [[230-loader-accept]]()

> [[230-loader-accept]]() `SsfFile_LoadAndLink` `0x0025fac8`, called from the
> course side-file loader `0x0025f320` at `0x0025f778` with the `.ssf` name
> built from `0x003a97a0`; exists-check `0x002c9010` at `0x0025fba0`, read
> `0x002c9c48` at `0x0025fbb0`, buffer stored `sw a1,0x14(s4)` (`world+0x14`,
> world = the `0x00347688` singleton) at `0x0025fbc0`; version test `lhu
> v0,4(a1)` / `addiu v1,zero,0x1500` / `bne` at `0x0025fbbc–0x0025fbc8`;
> instance-count test `[hdr+0x3c] == [[world+4]+0xc]` at `0x0025fbd0–0x0025fbdc`;
> reject path frees via `0x0014a048` and zeroes `world+0x14` at
> `0x0025fbe4–0x0025fbf8`; relocation of `+0x10/+0x18/…/+0x48` at
> `0x0025fbfc–0x0025fc74` (words `+0x00/+0x04/+0x08` untouched); default record
> `0x003d4070` built at `0x0025fb10–0x0025fb6c` (1000.0 = `0x447a0000`, 0.5,
> flags `(…|1)&~4|2` << 16, `sh -1` at +0x12/+0x14) and bound to every
> instance at `0x0025fb78–0x0025fb9c`. Twelve-level census (all PAL SSFs):
> word 0 = `0x001E0200`, word 1 = `0x00101500` on 12/12; float at 8 in
> `0x3bc6cfc2…0x3bc6ec35` (0.0060672–0.0060706, never identical between two
> levels). Sweep of every `lw rX,0x14(rB)` followed by a load at +0/+4/+8
> (68/11/3 sites) found no reader of those words reachable from the world
> object; the header consumers `EffectSlotTable_ResolveField` `0x002603a8`,
> `EffectHeaderTable_ResolveByIndex` `0x002603e8`, `SsfFunctionTable_FindByName`
> `0x00261308` read only `+0x0c…+0x48`. map:"SSF loader: validation, pools,
> physics records, spline records".

Physical section order: header → effect slots → physics pointer table →
collision pointer table → function table → effect-chain header table →
chain node data → (16-align) → physics payloads → (16-align) → collision
payloads → object properties → instance table → splines. [measured]
[[230-order]]()

Two offset conventions coexist. Header fields and pool pointers are
**absolute** file offsets. Chain offsets (in the effect-chain header table
and the function table) are **chain-relative**: relative to the end of the
chain header table, i.e. to `chain header offset + count × 8`. [measured]
[[230-offsets]]()

> [[230-header]]() SSFHandler.cs `Load()` read order,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs;
> GARI tiling: 76 + 78×28 = 2,260 (physics table) + 56×12 = 2,932 (collision
> table) + 412×12 = 7,876 (functions) + 20×24 = 8,356 (chain headers);
> properties 342,864 + 531×24 = 355,608 (instance table) + 3,393×4 = 369,180
> (splines) + 169×8 = 370,532 = file size.

> [[230-order]]() SSFHandler.cs `Save()` write order, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs (matches the GARI read
> offsets).

> [[230-offsets]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs — `Load()` computes the chain base after the
> header table (GARI chain base = 10,804) and adds it to both
> `EffectHeaderStruct.EffectOffset` and `Function.Offset`.

## Index spaces and joins

The file is one join web, anchored on the instance table: [measured]
[[230-joins]]()

- `instance table[i]` (one u32 per PBD instance, in instance order) → an
  object-properties record index. Properties records are **shared**: 3,393
  instances resolve onto 531 records on the example level, every record
  reachable, no out-of-range values.
- A properties record's shape index slot is **mode-disambiguated**
  (`130-collision-data.md`): collision mode 1 reads it as a collision-pool
  index, mode 3 as a physics-pool index; −1 = none.
- A properties record's effect-slot index (−1 = none) → the effect-slot
  table; slot columns hold anonymous-chain indices.
- Chain nodes address other spaces by payload: run-function nodes index the
  named-function table; act-on-instance nodes index the *instance* table;
  spline nodes index the spline records; sound nodes carry a raw course-bank
  slot number (`190-audio-data.md`).

> [[230-joins]]() join = `ObjectProperties[InstanceState[i]]`,
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs lines
> 241–275; GARI InstanceState spans 0..530 over 531 records [measured];
> runtime instance resolve for type 7/24 = LevelInstanceTable_ResolveByIndex
> @0x00254f58 (bounds-checked, 0x100-byte runtime stride), db:sign-break.

## Effect-slot record — 28 bytes

Seven i32 columns; −1 = empty; populated values index the anonymous-chain
pool. Column 1 is the **persistent** circumstance, column 2 the **collision**
circumstance, column 3 **region-deactivate**, column 4 **node-end**, and
column 5 the **deferred-trigger** circumstance (`150-logic.md`). Columns 3–5
are each authored on only a handful of the twelve courses, so a single-level
sample is likely to miss them entirely. Columns 3 and 4 always point at an
**empty** chain, which is their normal authored form — they are suppression
latches whose populated-ness is the whole signal (`150-logic.md`). Columns 6
and 7 are never referenced on any course and no engine path reads them.
[measured] [[230-slot]]()

> [[230-slot]]() SSFHandler.cs `EffectSlot`; export names
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/SSFJsonHandler.cs
> (PersistantEffectSlot, CollisionEffectSlot, Slot5 "EffectTriggerSlot" — the
> "EffectTriggerSlot" name is corroborated by authored data, not only by the
> handler's label). GARI: 78 slots, col1 populated on 48 (0..118), col2 on 56
> (0..196), cols 3–7 all −1 — it authors no deferred triggers, so it is not a
> usable sample for columns 3–7. Samples: slot 0 = {0,1,−1,…} boost pad,
> slot 15 = {50,49,−1,…} jumbotron logo-break, db:sign-break. Full 12-course
> per-column counts and the empty-chain result: `150-logic.md`
> [[150-column-census]]().

## Pool pointer tables — 12 bytes per entry

The physics and collision pools share one shape: an array of
`{u32 absolute offset, u32 byte size, u32 count}` entries. The **count is
load-bearing and the byte size is not**: an entry with count N is N
consecutive payloads, and the loader walks them by each payload's own decoded
size, never reading the entry's byte-size field (in either pool). At runtime
the entry becomes {first payload, count}, and the narrow phase takes payload
j for the j-th collision-bearing sub-object of the model, in model-object
order — the same rule gives the collision pool one triangle proxy per
sub-object. The scripted knock-off body always takes payload 0. On the
example level every entry has count 1, but retail does ship multi-payload
entries: a four-body subway train and a 21-body breakable gargoyle in Merqury
City, two-body pinball bumpers in Tokyo Megaplex, and multi-proxy collision
entries on five other courses. A reader that decodes only the first payload
of an entry misreads those. [measured] [[230-pools]]()

> [[230-pools]]() SSFHandler.cs `PhysicsHeader` / `CollisonModelPointer`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs;
> GARI: all 56 + 412 entries count==1; physics entry 6 ByteSize 224 =
> 16+96+4×12+63+1 exactly. Engine: `SsfFile_LoadAndLink` `0x0025fac8` sums
> counts at `0x0025fed0–0x0025ff00`, allocates count×0x150 at
> `0x0025ff04–0x0025ff3c`, builds `world+0x18[i] = {first, count}` at
> `0x0025ffc8/0x0025ffcc` and loops bodies with `s0 += v0` (the body ctor
> `0x00239860` returns the consumed byte size, `subu v0,t0,s0` at
> `0x00239990`) at `0x00260008–0x0026001c`; the collision pool is built the
> same way at `0x00260140–0x00260214` (20-byte runtime records `{faces, verts,
> idx, verts, normals}`); entry `+4` is unread in both. Consumers:
> `WorldEntity_ResolvePhysicsPoolEntry` `0x002611d0` (`lh 0x12(props)`);
> narrow phase mode 3 `first + objCounter×336` at `0x0025c99c–0x0025c9c4`,
> mode 1 `first + objCounter×20` at `0x0025c9f8–0x0025ca1c`, counter at
> `sp+0x6d8` incremented per gated sub-object; Roller `lw a1,0(v0)` at
> `0x0013d7cc`. Twelve-level census: MERQUER phys[5]=4
> `Mdl_Subway_TrainLeft_0`, phys[57]=21 `Mdl_Gargoyle_StoneAnim_Break_400x`,
> MEGAPLE phys[0]/[1]=2 `Pinball_Bumper*`; multi-proxy collision entries
> ELYSIUM (5), MEGAPLE (9, 7), MERQUER (2 ×3), MESA (4), SNOW (2); ByteSize ==
> sum of consumed sizes on 1,088/1,088 entries. Not verified live: a model
> with more collision-bearing sub-objects than the entry's count would index
> into the next entry.

## Named-function table — 24 bytes per entry

`{u32 node count, u32 chain-relative offset, char[16] name}`. A function is
a named effect chain (`150-logic.md`); an empty function (node count 0) is
legal. Example-level names: the countdown/mode set (`CountDownStart`,
`RaceMode`, `ShowoffMode`, `FreerideMode`, `EndCountDown` with 0 nodes, …)
plus per-screen `BreakLogo<uid>` functions. [measured] [[230-functions]]()

> [[230-functions]]() SSFHandler.cs `Function` (fixed 16-byte name read),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs;
> GARI 20 functions raw (HideShowOff = 164 nodes, the largest); MESA 15.

## Effect chains and node encoding

The anonymous-chain header table is `{u32 node count, u32 chain-relative
offset}` per chain. A chain is `count` consecutive nodes; it is walked by
count, not by terminator. [measured] [[230-chains]]()

Every node begins with an 8-byte frame: `{u32 main type, u32 byte size}`,
where **byte size is the total node size including the frame**. The engine's
chain walker keeps an index cursor and a byte cursor: after each node it
increments the index and adds the node's stored byte size to the byte
cursor, and the next node is resolved as chain base + byte cursor. Handlers
advance nothing and no node pointer table is pre-built, so an unknown main
type is harmless (`150-logic.md` — the 27-entry dispatch table's unused slots
point at a return stub) only while its byte size is correct, and one wrong
byte size derails every node after it. [measured] [[230-frame]]()

> [[230-chains]]() SSFHandler.cs `EffectHeaderStruct`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs; GARI: 306 anonymous
> chains + 20 functions = 700 nodes.

> [[230-frame]]() verified by walking all 700 GARI nodes strictly by ByteSize
> with zero mis-steps; `SaveEffectData` writes size = end − sizeFieldPos + 4;
> dispatcher @0x0013bfd8, jump table @0x0036c830 (27 entries, return stub),
> map:"SSF effect-node opcode dispatcher", db:sign-break. Engine walk:
> `EffectThread_Tick` `0x0013be80` — `lw a0,0x3c(s0)` byte cursor, `lw v0,4(a2)`
> chain base, `lw a1,4(v0+a0)` = node ByteSize, `+0x38 += 1`, `+0x3c += a1` at
> `0x0013bf2c–0x0013bf4c` (and again at `0x0013bf70–0x0013bf94`); the
> dispatcher resolves `s1 = [hdr+4] + [thread+0x3c]` and reads `lw v1,0(s1)` at
> `0x0013bffc–0x0013c00c`; the walk terminates on index == count.

### Main-type payloads

Node sizes verified on real data except where marked. The semantics column
names the owning chapter; `150-logic.md` defines the dispatch behavior.
[measured] [[230-maintypes]]()

| Main type | Node size | Payload after the frame | Semantics |
|---:|---:|---|---|
| 0 | varies | u32 sub-type + sub-payload (below) | property-effect family |
| 2 | varies | u32 sub-type + sub-payload (below) | emitter family (`180-particles-data.md`) |
| 3 | 16 | u32 command, f32 value | virtual control message to the installed property node; receiver-dependent, null-guarded (`150-logic.md` `[[150-control]]()`) |
| 4 | 12 | f32 wait time (seconds) | chain delay |
| 5 | 20 | u32 mode, u32 selector, f32 threshold/probability | conditional gate — kills the chain on failure; modes 2/3 read no payload fields (`150-logic.md` `[[150-gate]]()`). The layout here is the RUNTIME's; `SSX-Library`'s record types the last two words the other way round (`float U1; int U2`), so a JSON round trip prints the selector as a denormal float and the threshold as a large int — Merqury City's 1106247680 is 30.0 |
| 7 | 16 | u32 instance index, u32 effect index | act on instance |
| 8 | 12 | u32 sound slot | course-bank sound, raw slot, fixed group, no empty-slot fallback (`190-audio-data.md`) |
| 9 | 16 | u32 command, f32 value | as main type 3, minus its missing-node guard (`150-logic.md` `[[150-control]]()`) |
| 13 | 12 | f32 (ignored) | course-reset trigger [[230-reset]]() |
| 14 | 12 | f32 score multiplier | `390-pickups-and-race.md` |
| 17 | 12 | f32 boost amount | speed boost |
| 18 | 12 | f32 boost amount | trick boost |
| 21 | 12 | u32 function index | run named function |
| 24 | 12 | u32 instance index | teleport to instance; size parser-derived [inferred] |
| 25 | 16 | u32 spline index, u32 on/off | spline toggle |

> [[230-maintypes]]() SSFHandler.cs `LoadEffectsData` field sequences; GARI
> walk pins every (type, size) pair present (3/5/24 absent from GARI; MESA
> JSON shows 4×type-3, 30×type-5). Runtime consumers: type 4 delay-store
> @0x0013c164; type 7 @0x0013c2ec; type 8 @0x0013c38c →
> SsfSoundPlay_QueueCourseBankSound @0x00216ac0 (group 2 hardcoded
> @0x00216b7c), map:"SSF effect-graph sound"; type 17 @0x0013c408 →
> Boarder_RequestBoostAmount 0x0011e918; type 18 @0x0013c42c; type 21
> @0x0013c450; type 25 @0x0013c530. GARI census (700 nodes): 0×222, 2×107,
> 4×4, 7×202, 8×61, 9×4, 13×9, 14×3, 17×3, 18×3, 21×16, 25×66.

A type-7 hop is confirmed on hardware from an AUTHORED level. A gate whose
collision chain led with a hop filled a second instance's live effect-node slot
in three passes of three, while the rider never came within
116 m of that instance and it carried no chain of its own. The node read the
sub-type authored into the hop's graph and nowhere else in the level, so the
index resolved to the intended row rather than to a neighbour. [measured]
[[230-hop-live]]()

This also pins the failure mode from the other side, and it is the reason the
packer refuses an unresolved hop rather than guessing: an out-of-range index is
bounds-checked away and the chain around it dispatches normally, so a broken hop
and a working one are indistinguishable from the host. Only the target says.

> [[230-hop-live]]() Live evidence: `Trailmap/tools/autotest`, runs
> 20260806-072247, -072612 and -072938 (fixture cells `hop-remote` and
> `hop-remote-target`); the slot watched is `entity+0xe4`. Authoring path:
> [Snowknife repack technical reference, "Acting on another instance"](../../Snowknife/docs/repack-technical-reference.md#acting-on-another-instance).

> [[230-reset]]() Handler `0x0013c3a8` (inline in the opcode dispatcher):
> sets `boarder+0x304 = 1` and calls `Boarder_CourseResetEntry` @0x00118f18
> with a fixed 101.46 placement parameter — the payload f32 is not read.
> That entry is the same one every control-state update polls for the
> manual reset button: it averages the *other* riders' distance-to-finish
> (`+0x374`) for a rubber-band-informed placement, then @0x00119be8 stores
> {param, clamped DTF-diff, −1} into
> `[boarder+0x5ae0]+0x81c/+0x820/+0x824` and switches to control state
> 4 → 22 (the course-reset warp) — **not** the wipeout-recover path
> @0x0010f178, a plausible-looking candidate that is in fact unrelated to
> this reset. Always on the CollisionEffectSlot;
> hosts are `Mdl_ResetZone*`, `Water_River`, back-of-course walls + crowd
> stands. Host instances: GARI 199, MESA 202, SNOW 53, ELYSIUM 256,
> MERQUER 44.

### Main-type 0 sub-payloads

The payload is a u32 sub-type followed by the fields below (node size =
12 + payload). A sub-type outside this set is unparseable [open]; none occur
in the surveyed levels, though the engine constructs nodes for eight more
(Timer 8, Rail 9, RandomBoost 16, UVScrollTexFlip 19, TrickTrigger 21,
Particle 22, TubeEndBoost 24, AnimTexFlip 259 — payload layouts [open]). The
sub-type names are the engine's **original** name strings (`150-logic.md`
`[[150-type0]]()`), except sub 5 whose "DeadNode" is a community name.
[measured] [[230-sub0]]()

| Sub | Node size | Fields after the sub-type |
|---:|---:|---|
| 0 | 36 | f32 mass, f32 (copied into the body and never consumed), f32 (never read), 3 × f32 launch direction (all-zero = launch along the instance's own transform) — the "roller" scripted knock-off body: makes the target instance a short-lived dynamic rigid body (`370-world-interaction.md`); the two inert words have no runtime effect whatever is authored [[230-roller]]() |
| 2 | 16 | f32 debounce time (s, ×60 → frames): positive counts down and then ends itself through the ordinary end-node request; **0** holds until the slot's region unloads; **negative** holds for the rest of the level — it refuses both the end-node request and region-deactivate teardown, and only a dead-node action or level teardown removes it [[230-debounce]]() |
| 5 | 16 | u32 mode (0-4) — the "dead node": 0 destroys the instance's installed node, 1 stops it, 2 destroys it and **tombstones the instance** — no static draw, no player collision or bounce, an inert owning node — which is the engine's hide-and-disarm primitive (gem despawn `390-pickups-and-race.md`, one-shot boost pads, every scripted hide), 3 = mode 2 plus a **kill request** honoured by the nodes that do not register on the instance (particle emitters, spline-path movers), 4 = mode 2 with a breakable-specific tag (`370-world-interaction.md`). Only 2, 3 and 4 are authored in retail [[230-deadnode-modes]]() |
| 6 | 20 | u32 count, f32 — count-down sequencer: on elapse fires a target instance's trigger slot [[230-logic-nodes]]() (size parser-derived [inferred]; MERQUER 1) |
| 7 | 40 | u32 mode, f32, f32, f32 boost amount (×100 → engine units), 3 × f32 boost direction — directional velocity-impulse volume, distinct from the type-17/18 pads (`360-speed-and-boost.md`) [[230-logic-nodes]]() (MERQUER 8) |
| 10 | 36 | u32 scroll mode, f32 H-speed/tick, f32 V-speed/tick, f32 active seconds, f32 pause seconds, f32 lifetime seconds (0 = until slot unload) (UV scroll, `170-materials.md`) |
| 11 | 32 | u32, u32 direction (0 = forward), f32 speed, f32 length, u32 (texture flip, `170-materials.md`) |
| 12 | 20 | u32, f32 flex amount — collision-triggered damped-spring fence flex: springs on ride-through, settles, self-removes (`370-world-interaction.md`) [[230-logic-nodes]]() |
| 13 | 28 | u32 pole end (0 = the first sampled end is fixed, else the opposite end), f32 wave **speed** (cycles per second), f32 ripple **amplitude** (peak free-end displacement in the model's own vertex units divided by its X scale), f32 lifetime (s; 0 = until slot unload) — persistent procedural flag/banner cloth wave: eight stations from pole to free end, each displaced along model X by amplitude × (k/8) × sin(2π(k/8 − phase)), one full wave per flag length growing linearly from the pole, with a random start phase per flag; there is no wavelength parameter [[230-flag]]() |
| 14 | 20 | f32 crack lifetime (s, ×60 → frames; ≤ 0 never expires), f32 strength — the two-stage breakable surface: it soaks up damage per accepted hit and fires its own slot's trigger column when the strength crosses zero (`370-world-interaction.md`) [[230-cracked]]() (MEGAPLE 20, all `−1` / `5`; absent from the GARI/MESA censuses) |
| 15 | 32 | 5 × f32 (lap boost): approach rate, target speed, 3 × direction — field roles and float typing are established in `360-speed-and-boost.md`; absent from the GARI/MESA censuses |
| 17 | 24 | u32, u32 rows, u32 columns (crowd box) |
| 18 | 40 | 7 × f32 (Z-boost): approach rate, target speed, 3 × direction, target world Z, snap tolerance — field roles and float typing are established in `360-speed-and-boost.md`; absent from the GARI/MESA censuses |
| 20 | 52 | u32, f32 frame step (s), f32 duration (s; stored internally as duration×60 frames), f32 ×3 authored throw direction (zero = use the collision direction), f32 ×3 per-axis velocity scale (cm/s), f32 direction scale — the procedural mesh-throw animation (`370-world-interaction.md`) |
| 23 | 12 | no payload — in-world video-screen driver: streams `data/video/j<level>.sss` (128×64) onto a billboard / finish-screen instance [[230-logic-nodes]]() |
| 24 | 88 | tube-end boost — the sub-7 directional-boost payload (mode, window, rate, target, 3 × direction) followed by 3 × direction vector then 3 × speed; the constructor derives from sub-7's, see `360-speed-and-boost.md`. Absent from the GARI/MESA censuses |
| 256 | 44 | u32 loop mode (1 wrap, 2 ping-pong, else once), f32 ×2 play window (30 fps frames; negative → full clip, and a zero-length window plays nothing), f32 rate (30 = realtime), f32 random-rate upper bound (0 = none), f32 collision re-fire debounce (s, ×60 → ticks), u32 random start phase flag, u32 (4 = reversed) — plays the model's object animation (`120-objects.md`) [[230-anim-shared]]() |
| 257 | 44 | the sub-256 record exactly, at the same offsets and read by the same init — the clock is what differs (anim delta) [[230-anim-shared]]() |
| 258 | 60 | the sub-256 record, then f32 combo window start (frames; negative → the sub-256 window's END), f32 combo window end (frames; negative → full clip), f32 combo rate (30 = realtime), i32 end behaviour read for its SIGN (0 resume the idle window, >0 latch on the idle pose, <0 latch holding the last combo frame) — an AnimObject carrying a second window that control command 3 plays over the top of the first (anim combo) [[230-anim-combo]]() |

> [[230-debounce]]() ctor `DebounceNode_ConstructFromEffectPayload` `0x0013fbf8`
> (base `0x0013a848` a2=2; `lwc1 f0,12(s1)` × 60.0 `cvt.w.s` → `node+0x2c`;
> vtable `0x0036dcf8`). Update `0x0013fcb0` (vt+0x14): `blez` at `0x0013fcc0`
> skips non-positive counts, else decrement, and on zero calls vt+0xb4 with
> a1=1 (`0x0013fce0`). vt+0xb4 = `0x0013fd38` (end-node request): `bltz
> [node+0x2c]` at `0x0013fd60` → refuse; vt+0xbc = `0x0013fcf8`
> (region-deactivate teardown): `bltz` at `0x0013fd08` → refuse, else destruct.
> Control virtual is the base handler (commands 7/8). Sub-8 Timer `0x0013fdd8`
> is the two-word twin. Census over 12 SSFs: 151 nodes — 3 s ×75 (MEGAPLE
> buttons), 7 s ×27 (MERQUER hydrants), 0 ×25, 2 ×15, 1.5 ×3, −1 ×3 (SNOW,
> hop-reached), 1/10/4 ×1. The negative-pin behaviour is read, not measured.

> [[230-flag]]() ctor `FlagNode_ConstructFromEffectPayload` `0x00144780` (base
> a2=13, vtable `0x0036deb8`, payload pointer kept at `node+0x48`); init
> `0x00144940`: `lw v1,12(v0)` pole select → `node+0x38`; `lwc1 f0,16(v0)`
> × 1/60 → phase step `node+0x3c`; `lwc1 f1,20(v0)` amplitude → `node+0x40`;
> `lwc1 f0,24(v0)` × 60 `cvt.w.s` → lifetime frames `node+0x34`; random start
> phase → `node+0x44` (`0x00144aec`); sentinels `c.eq.s −1.0` at `0x001449bc`
> (amplitude → random ×45+5, then ÷60 — a copy-paste slip) and at `0x00144a20`
> on the already-scaled speed (so random speed 0.5–2.0 cycles/s needs an
> authored −60). Model X scale = `[instance+0xc0]+0x18` (PBD model header
> `Scale.x`; `AnimTime` is `+0x14`), clamped ≥ 1 at `0x00144bd0`, `div.s` into
> the amplitude at `0x00144c0c`; station build `0x00144c50–0x00144e14` (rows
> at `node+0x50` and `+0xb0`). Update `0x00144e50`: lifetime `blez`/decrement,
> zero → vt+0xb4 a1=1 (`0x00144ebc`); phase += step, wrap at 1.0
> (`0x00144e84`). Ripple `0x00144ed0`: `bne [node+0x38],zero` at `0x00144f6c`
> selects ascending (`0x00144f74`) vs descending (`0x00145010`) fill; angle =
> −2π·phase + 2π·(k/8) → `Math_SinApproxRadians` `0x00251290`; displacement =
> amplitude × (k/8) × sin into x only (`0x00144fe0–0x00144ff0`), added to
> both edge arrays (`0x00145130–0x00145170`). Flags: instance bit 2 set,
> bit 1 cleared; deform buffer from render-manager vt+0x22c/+0x228 →
> `node+0x4c`, freed by the dtor `0x001448d0` via vt+0x234. Census over 12
> SSFs: 5 nodes, all persistent — ELYSIUM `1,1.5,25,0`, MEGAPLE `1,1.5,40,0`,
> SNOW `1,1.5,40,0`, MESA `0,1.5,25,0` ×2 (U3 is a float 0.0, not the parser's
> u32). Open: which model edge is station 0 (the corner supplier at
> render-manager vt+0x2b4, called `0x00144ba4`, was not read) and the
> amplitude's absolute unit (the `×250`/`×0.004` pair at `0x00144c0c`/
> `0x00144c1c` against the compressed-vertex scale).

> [[230-sub0]]() SSFHandler.cs `LoadEffectsData`; names verified
> against the ELF's own registry string block 0x0036c8a0..0x0036c9d4
> (0 Roller, 2 Debounce, 6 Counter, 7 Boost, 8 Timer, 9 Rail, 10 UVScroll,
> 11 TexFlip, 12 Fence, 13 Flag, 14 Cracked, 15 LapBoost, 16 RandomBoost,
> 17 CrowdBox, 18 ZBoost, 19 UVScrollTexFlip, 20 cMeshAnim, 21 TrickTrigger,
> 22 Particle, 23 Movie (`cMovieNode`), 24 TubeEndBoost, 256 AnimObject,
> 257 AnimDelta, 258 AnimCombo, 259 AnimTexFlip — each factory branch passes
> its own name string in a3; sub 5 has no string); sizes cross-checked on the
> GARI walk. The sub-20 throw direction is f32 ×3, not u32 — it reads 0
> wherever the throw follows the collision direction (the type is ambiguous
> there), and an authored non-zero direction stores as a float bit pattern.
> Runtime: sub 7 ctor BoostNode_ConstructFromEffectPayload
> @0x001404a0 (mode 16-bit, ×60 → frames, ×100 → engine units), map:"Boost
> effect constructor"; sub 20 = cMeshAnim::Init @0x001466c0 semantics
> validated in practice; breakables key on sub 5 mode 4; sub 256 =
> AnimObjectNode_Init @0x00198d08, map:"World-prop model animation",
> db:anim-object. Censuses: GARI {0:3, 5:158, 10:22, 11:14, 12:1, 17:2,
> 20:11, 23:8, 256:3}; MESA {0:7, 2:6, 5:81, 10:21, 11:11, 13:2, 17:2, 20:46,
> 23:1, 256:8, 257:4}. Play-window census over
> ELYSIUM/GARI/MERQUER/MESA/SNOW: all 32 sub-256 nodes author the full-clip
> form, as do 8 of the 11 sub-257 nodes; the remaining 3 carry an explicit
> 0→30 frame window (the MESA falling trees). No shipped node authors a
> zero-length window; that one plays nothing was measured on an authored
> PCSX2 canary whose prop stood still until the window was made full-clip.

> [[230-anim-shared]]() `AnimObjectNode_Init` 0x00198d08 reads the record for
> ALL THREE of subs 256/257/258 — each of their constructors calls it with its
> own sub-type — so the eight words mean the same thing in every one, whatever
> the SSX-Library record declares. Offsets from the node base (`MainType`,
> `ByteSize`, `SubType`, then the payload at +0x0c), calibrated against
> `UVScrollNode_ConstructFromEffectPayload` 0x00141ff8: loop mode `lhu +0x0c`
> → obj+0x08 (a u16, so the record's u32 is read half-wide); window start
> `+0x10` and end `+0x14`, each `<0` replaced (start → 0, end → the model's
> clip length at `[instance+0xc0]+0x14`) then ÷30 → obj+0x28/+0x2c; rate
> `+0x18` and random upper `+0x1c` — `U4 == 0.0` takes `U3` straight,
> otherwise `rand(U3, U4)` via 0x0023da80 — as `(x/30)/60` → obj+0x20;
> `+0x20` ×60 rounded → obj+0x18; random-start flag `+0x24` seeds obj+0x24
> from 0x0023da18 when non-zero, else from the window start; `+0x28 == 4`
> negates obj+0x20. **The sixth word is the collision re-fire debounce**, not
> an unnamed float: obj+0x18 is the RELOAD value for the counter at obj+0x1c,
> which `AnimObjectNode_TryRunCollisionChain` 0x001993d0 refuses to fire
> through while non-zero — it otherwise resolves
> `EffectSlotTable_ResolveField(obj+0x58, field 1)` at 0x001993f4, one of the
> four known collision-column call sites (`150-logic.md`
> `[[150-slot-columns]]`), and reloads obj+0x1c = obj+0x18. The counter steps
> down once per eval in 0x00199528. ALOHA's barriers author 1.0 s.

> [[230-anim-combo]]() Sub-258 ctor
> `AnimComboNode_ConstructFromEffectPayload` **0x0019a418** — calls
> `AnimObjectNode_Init` 0x00198d08 on `node+0x1c` with sub-type 258 (hence
> `[[230-anim-shared]]` for the first eight words), then installs vtable
> **0x0038d6d0** at `node+0x54` and reads the four extra words: `+0x2c` (`<0`
> → the window end `+0x14`) ÷30 → node+0x10, the combo window START; `+0x30`
> (`<0` → `[instance+0xc0]+0x14`, the clip length) ÷30 → node+0x14, its END;
> `+0x34` as `(x/30)/60` → node+0x08, its per-tick advance; and `+0x38` twice
> — `!= 0` → node+0x1a, `< 0` → node+0x1b — which is what makes the last word
> a SIGN rather than a magnitude. Update (vtbl+0x14) **0x0019a710**: latched
> (node+0x19) → eval only; inactive (node+0x18) → ordinary
> `AnimObjectNode_Update` 0x00199550; active → eval the base object WITHOUT
> advancing it (0x00199528), `node+0x0c += node+0x08`, and on reaching
> node+0x14 clamp, clear active, and set the latch if node+0x1a — in that
> order, before the pose is chosen, which is why a resume never shows its last
> combo frame. ControlOp (vtbl+0xc4) **0x0019a7c8** refuses when the u16 at
> node+0x18 is non-zero (both state bytes at once, so a spent one-shot cannot
> re-arm), copies each live part's 4×4 matrix from `[node+0x7c] + i*208 +
> 0x90` into `[node+0x84] + i*64`, sets node+0x0c = node+0x10 and marks
> active. Apply (vtbl+0xe4) **0x0019a970**: with the combo active — or latched
> and node+0x1b — evaluate every part at node+0x0c and then
> `part.matrix = saved × part.matrix` per part via the VU0 4×4 concat
> **0x001cbb50** (which writes back to `part+0x90`); otherwise the ordinary
> base apply 0x00199750. Copy-ctor 0x0019a5a0, dtor 0x0019a6a0.
> Corpus: two nodes, ALOHA effect 227 and MEGAPLE effect 80, byte-identical —
> `U0=2 U1=0 U2=60 U3=30 U4=0 U5=1 U6=1 U7=3 U8=61 U9=100 U10=30 U11=0`.
> ALOHA slot 37 joins it to five `Mdl_BarrierDynamic_SideToSide_*` (instances
> 686, 1788, 1799, 1816, 1817): persistent 227 installs it, collision 228 is a
> lone `MainType 3 {command 3, 0.0}`. The model closes the reading — `AnimTime
> 100.0` = U9, and its one animated part carries a translate-X curve running
> −430 → +430 cm over 0 → 2.002 s (the idle slide) and a rotate-X curve whose
> segments span **2.0333333** (= 61/30 = U8) to **3.3333333** (= 100/30 = U9),
> swinging 0 → −90° and back (the knock-down). The combo window's own
> translation is authored at zero, so the composition above is what keeps the
> barrier falling over where it stands. Derivation:
> doc:../research/effects-semantic-names.md §AnimCombo.

> [[230-cracked]]() Sub-14 ctor `CrackedNode_ConstructFromEffectPayload`
> @0x00145460 (vtable `0x0036dddc`, 696-byte node), reached from
> `EffectRegistry_BuildEffectNode` via SubType table `0x0036c9e0[14]`
> @0x0013cc90. Payload at `node+0x0c`: U0 → `(int)(U0 × 60)` at `node+0x34`
> (`lui at,0x4270`; the lifetime countdown), U1 → `node+0x3c` verbatim (the
> strength). The constructor also seeds the 30-frame gate `node+0x38` and
> applies the constructing contact immediately. Virtual slot 24 (`+0xc0`)
> @0x001457b0 is the runtime setter for the same two words — parameter 1
> re-derives the lifetime from seconds, parameter 2 writes the strength —
> which is what types both fields independently of the authored corpus.
> Damage: slot 18 (`+0x90`) @0x001457f0 refuses a contact while `node+0x38`
> is non-zero and otherwise tail-jumps to `CrackedNode_ApplyHit` @0x00145810,
> which ignores an already-spent surface (`node+0x3c ≤ 0`), reloads the gate
> to 30, and subtracts `|reduce(contact[+0x10] × contact[+0x20]) ×
> contact[+0x30]| × 0.036` — a VU0 componentwise product horizontally
> accumulated into `vf04.x` and read back with `QMFC2`. Which of the two
> contact quadwords is the normal and which the relative velocity is
> [inferred] from the shape; the arithmetic is read. Update slot 2 (`+0x10`)
> @0x001455a8 steps the gate, steps the lifetime and retires on zero, then
> fires the trigger column — see `150-logic.md` [[150-deferred-trigger]]().
>
> [[230-roller]]() Sub-0 ctor `RollerNode_ConstructFromEffectPayload`
> @0x0013d6c8 (class `cRollerNode`, RTTI `11cRollerNode`, vtable `0x0036e990`,
> Update slot `+0x14` = `PhysicsBody_UpdateAndSettleCandidate` @0x0013e8b0),
> reached from `EffectRegistry_BuildEffectNode` via SubType table
> `0x0036c9e0[0]` @0x0013c748 (848-byte body node). Payload at `node+0x0c`:
> U0 = mass (`1/U0` → inverse-mass `node+0x38`; default launch speed
> `clamp(5000/U0 + 100, ≤600)` @0x0013dd48); U1 (`node+0x10`→`+0xd0`,
> `0x0013d814`) is stored and **never consumed**: exhaustive scan of the class
> region `0x0013d6c8–0x0013fbf8` (16 functions incl. Update `0x0013e8b0`,
> terrain `0x0013edb0`, dtor `0x0013e0c0`) and the embedded dynamics object
> (`node+0x30`, ctor `0x001537e8`, region to `0x00155b28`) finds no load of
> that slot; the only reader binary-wide is the accessor `0x00149e38` (`jr ra;
> lwc1 f0,208(a0)`, siblings `0x00149e40`/`0x00149e48`), which appears in no
> vtable and has no `jal` (no call to any of the three appears in the executable) — dead code.
> U2 (`node+0x14`) is **never loaded** (the only `20(...)` load `0x0013d8b0` is
> off the inertia block) and the payload pointer is not retained; the ground
> restitution it mirrors is a hardcoded 0.5 at `node+0xdc` (terrain response
> reads `+0xd8/+0xdc/+0xe0` at `0x0013f008`/`0x0013f038`). Census over 12
> retail SSFs: 467 nodes, 14 tuples — U1 ∈ {0.7, 0.002, 0.4, 0.3, 0.1, 0},
> U2 ∈ {0.5, 1.5}. U3/U4/U5
> = launch direction — all-zero launches along the instance transform, else
> normalize + launch that way (`RollerNode_LaunchAlongAuthoredDirection`
> @0x0013dbf0). The ctor flips the target instance flags `entity+0xe8` (set
> 0x1|0x4|0x40, clear 0x2|0x20). db:roller; the moved-body run is
> `[[370-bodysim]]()`/`[[370-roller]]()`. MERQUER hydrant `TopLid` uses
> `(U0=6,U1=0.002,U2=1.5,U3=0,U4=1000,U5=0)` (U4=1000 → launches up). Census:
> MERQUER 448, GARI 3, MESA 7.

> [[230-deadnode-modes]]() DeadNode's handler (`0x0013ac90`) bounds-checks
> mode < 5 and dispatches through a 5-entry jump table at `0x0036c2d0`; modes
> are construct/destroy actions on whatever SSF node is currently installed
> at the firing instance's persistent-effect slot, called through that
> node's own vtable. Mode 0 (`0x0013accc`): destroy the active node only (no
> replacement). Mode 1 (`0x0013ad1c`): same target, a different virtual
> (vtable slot 2 vs slot 1) — stop/pause rather than destroy. Mode 2
> (`0x0013ad44`, used by gems — `390-pickups-and-race.md`): destroy the
> active node, then construct a fresh `DeadNode` (SubType 5) in its place as
> a one-shot tombstone (the SubType==5 guard at entry makes it inert on a
> second firing). **The tombstone hides and disarms the instance:** the shared
> ctor `0x0013af40` masks the instance's runtime status word `entity+0xe8`
> `&0xffffff0f`, `&0xfffffffd`, `|0x0004` (`0x0013af70–0x0013af9c`), clearing
> the static-draw bit 0x02 (sole consumer: the placed-object submit walk
> `0x00200888`, `andi 3; bne 3 → skip` at `0x002009f0`), PlayerCollision 0x20
> (broadphase gates `0x0025bb74`/`0x0025c0f8` skip the instance), live-body
> 0x40 and PlayerBounce 0x80, and setting node-owned 0x04; the installed
> 44-byte node's vtable `0x0036c4a8` overrides only slots 0/1 of the base
> `0x0036c588`, so nothing draws or updates it. The authored `Visable` bit
> (0x01) is never written at runtime. Mode 3 (`0x0013add0`): mode 2 plus
> `ori 0x0804` (`0x0013afa0`, a2=1) — bit **0x0800 is a kill request** polled
> by the nodes that never register on `entity+0xe4`: the Type2/Sub0 emitter
> Update `0x00147e68` and Type2/Sub1 spline-emitter Update `0x00148950` (both
> `andi 0x0900; == 0x100 → run, else self-destroy`) and `cSplinePathNode`
> Update `0x001fab98` (`0x001fabb8–0x001fabec`, RTTI `15cSplinePathNode`
> `0x0039b9f0`); the same bit is set/cleared by `EffectNodeBase_ControlOp`
> `0x0013aa50` commands 8/7 (`0x0013aa88`/`0x0013aa6c`), which no level
> authors. Sole authored use across 18 `SSFLogic.json` exports: ALOHA
> `EffectHeaders[102]/[103]`, reached from `EffectHeaders[24]` (the
> `Mdl_Trigger_topDissapear_1000` start-area disappear) on instances 814/918
> `Mdl_Structure_Firepot_*`, whose persistent effect is a `T2/Sub0` fire
> emitter — plain mode 2 would leave the flame burning in mid-air. Census of
> modes: {2: 2538, 3: 6, 4: 273}; modes 0/1 authored nowhere. Mode 4
> (`0x0013ae5c`, breakables — `370-world-interaction.md`): the same masks, but
> the tombstone is tagged SubType 1006 (not 5) — a distinct marker the entry
> guard also treats as already-dead, so a breakable's kill cannot be
> reapplied; the `BreakLogo*` "hide intact logo" is this tombstone (GARI headers
> 46/48). `AnimObjectNode`'s own destructor (`0x001992a0`) only frees its
> animation-state allocation and restores `live = template | 2`
> (`0x0019970c`) — the hide is entirely the tombstone's. Race-restart restore
> `0x00190c78` re-applies stored tombstones. map:"Instance runtime status word
> (`entity+0xe8`)".
> Modes 0, 1 and 2 measured on hardware, 2026-08-06, GARI/AUTOTEST2 under
> `tools/autotest` (cells `dead-destroy`/`dead-pause`/`dead-tombstone`, three
> passes each). Each authored behind a `Debounce` node and a one-second
> MainType-4 wait, so the action lands on a live receiver a sampler can see:
> the instance's `+0xe4` slot, held 3.00–3.05 s by an untouched 3 s Debounce,
> instead cleared at 0.98–1.07 s under mode 0 and at 1.00–1.03 s under
> mode 1 — the two are not separable from the slot, though their jump-table
> entries call different virtuals. Mode 2 left `+0xe4` occupied for the
> remainder of every run with `+0x14` reading 5, and fired once where modes
> 0/1 re-fired on each crossing, which is the SubType==5 entry guard. Mode 4's
> distinct tag is confirmed from the other side: the breakable cell's
> `+0x14` reads 1006.

> [[230-logic-nodes]]() Runtime of the property-effect logic nodes, built by
> `EffectRegistry_BuildEffectNode` (sub-type table `0x0036c9e0`). **Fence** (12)
> ctor `0x00143558` (vtable `0x0036df98`), Update slot 5 `0x00143b70` = a
> damped-spring oscillator (pos += vel, damping 0.5/0.1, settle ≈0.00997);
> constructed at ride-through on the collision slot, springs back to rest,
> self-removes; the per-vertex deform uses COP2/VU ops not disassembled
> [inferred]. Census GARI 359, SNOW 577, MERQUER 680. **Flag** (13) ctor
> `0x00144780` (vtable `0x0036deb8`), Update `0x00144e50` = a wrapping phase
> accumulator driving a per-vertex cloth ripple `0x00144ed0`; persistent slot
> → continuous. MESA/SNOW/ELYSIUM; fields in `[[230-flag]]()`. **Movie** (23) `cMovieNode` ctor
> `0x00148a78` (vtable `0x0036d770`), init `0x00148b30` selects
> `data/video/j<level>.sss` (128×64) and opens it via the movie manager
> `0x00200428`; persistent, on ad-billboard + finish-screen instances; the
> central MPEG decode/upload loop is untraced [open]. 12 total (GARI 8, the
> others 1 finish-screen each). **Counter** (6) ctor `0x0013b0c0`, Update
> `0x0013b180` = count-down (count from payload, frames = f32×60) that fires
> its own slot's EffectTriggerSlot (column 5) on elapse — not another
> instance's. 2 in the corpus, both with that column populated, so the fire
> path is confirmed by data as well as by the disassembly: MERQUER 1
> (`Count`=10, a timed sign) and PIPE 1 (`Count`=24, the 36-emitter flame
> wave), both detailed in `150-logic.md`. **Boost** (7) ctor `[[230-sub0]]()` above — a directional
> velocity impulse when the rider enters the invisible AABB trigger, carrying
> a unit direction + (amount×100) magnitude + (duration×60) window; the apply
> method is untraced [inferred]. MERQUER 8 (sandboost gate-rows + 2 timed),
> absent elsewhere.

### Main-type 2 sub-payloads

| Sub | Node size | Payload | Semantics |
|---:|---:|---|---|
| 0 | 216 | u32 sub-type + i32 `U0..U1` + f32 `U2..U48` + i32 `U49..U50` | timer particle emitter — the 51-field block of `180-particles-data.md` |
| 1 | 56 | u32 spline index, u32 end mode, u32 orientation mode, u32 instance count, f32 animation speed, f32 yaw offset, u32, f32, f32 ×3 RGB | spline-path animation — walks the owning prop (+ instance-count copies) along the named spline; persistent slot (the MERQUER subway). Detailed below |
| 2 | 216 | 51 words; semantically i32 `U0..U1`, f32 `U2..U48`, i32 `U49..U50` (legacy reader exposes all as i32 bit patterns) | collision emitter — same P6 law as sub 0, but live contact replaces origin U9..U11 and redirects base speed `length(U18..U20)` along the outward normal; UNTRACK effect 10 is the shipped snow-tree burst |

[measured; sub 1/2 sizes parser-derived [inferred]] [[230-sub2]]()

For emitter sub-types 0 and 2, `U33..U48` holds four colour stops in native
**A,R,G,B** quartet order (`U33=A, U34=R, U35=G, U36=B` for stop 0). The
runtime reader rotates each quartet to RGBA before P6 rendering; see
`180-particles-data.md` `[[180-emitter-colour-order]]()`.

> [[230-sub2]]() SSFHandler.cs `LoadEffectsData` type-2 branch; runtime
> dispatch @0x0013d138, SubType-2 branch @0x0013d210, particle ctor
> @0x00148568 and payload override @0x00148750 (collision shell chain
> 0x00125090 → 0x0013bd48); map:"The collision shell and the SSF MainType 2 /
> SubType 2 particle"; GARI/MESA use only sub 0 (107/176 nodes).

The timer emitter's `U9` is an f32 even though it is zero in every surveyed
retail node. The reader uses `lwc1`, the writer emits an IEEE-754 single, and a
non-integral synthetic value survives save/reload. Typing it as i32 happened to
round-trip the retail corpus because zero has the same bits in either type, but
would corrupt newly authored X offsets. [measured] [[230-emitter-u9]]()

> [[230-emitter-u9]]() `ParticleEmitter_ReadType2Sub0Payload` @0x001d8988
> reads `U9..U11` with `lwc1`; corrected SSFHandler + JSON DTO and
> `SsfEmitterRoundTripTests.Type2Sub0_U9_RoundTripsAsFloat` exercise
> `(123.25, -45.5, 67.75)`.

#### Spline-path animation (sub 1)

The node is built only when the spline index is valid; a −1 index leaves the
prop static. It keeps one pose — a position and an Euler triple — per copy, and
rebuilds every pose each tick from the spline alone. **The prop's own authored
instance rotation is never read**: a spline mover's orientation comes entirely
from the spline and this payload, so the heading a level author gave the
template model is immaterial. The instance record supplies only the model, the
bounding box (for culling), and the status flags.

Each copy advances a distance along the spline and takes its pose from the
analytic curve there: position from the cubic, orientation from the normalized
first derivative — the unit tangent. Only yaw and pitch are ever set; the roll
angle is held at zero, the spline's own normal is never computed, and the prop
does not bank into a turn.

**Yaw** is `(yaw offset + π/2) − the tangent's compass angle`. With a zero
offset this aims the model's **+Y** axis down the track (+X across, +Z up), so
the payload's **yaw offset** is not a trim but the choice of *which model axis
leads*: a value near π turns the model a quarter-turn on the spot, putting a
model's **X** axis on the rails instead. The shipped subway authors 1.62 rad,
which lands its long −X axis on the track (with a 2.8° hand-trim), so the train
leads with −X and its +X end is the tail.

**Pitch** is the tangent's vertical component read directly as an angle in
radians — a small-angle approximation of its true inclination, which
under-pitches on steep track (a 30° grade poses as 28.6°). It is applied about
the model's **X** axis, in raw model space, and is *not* re-derived from the yaw
offset: a model re-aimed onto its X axis would therefore **roll** rather than
pitch. Such props disable pitch (below), so this does not arise in shipped data.

The **orientation mode** selects which of those the tangent drives:

| Mode | Yaw | Pitch |
|---:|---|---|
| 0 | from the tangent | from the tangent |
| 1 | from the tangent | none — the prop stays level |
| 2 | fixed (the yaw offset alone) | from the tangent |
| 3 | fixed | none |

The shipped subway authors mode 1: yaw from the tangent, and no pitch — being
re-aimed onto its X axis, a pitch would roll it. It rides perfectly level.
The implementation special-cases only 1, 2, and 3: every other integer follows
both yaw and pitch exactly like mode 0; there are no additional orientation modes.
The common ping-pong return-leg π turn still applies to every mode: “fixed yaw”
means the curve's tangent angle is suppressed, not that the travel-direction flip
is suppressed.

A further payload flag makes the node draw **the spline itself** as a line, in a
colour and alpha the payload carries. It is a 1-pixel line — no thickness, no
texture, flat vertex colour — laid along the analytic curve at ten samples per
segment (uniform in the curve parameter, not arc length), each segment
frustum-culled on its own. This is what puts the **running cable** under a
chairlift's chairs: the mountain's static wire props are short struts, and
nothing else in the engine draws along a spline. A mover with no line to draw
(a subway on its own track) authors the flag off, and a transparent black
colour with it.

**Instance count** copies ride one spline, sharing the one model, spaced evenly
by arc length: the spacing is the spline's total length divided by the count, so
the copies are distributed around the whole curve rather than trailing each other
by a body length. Every copy poses from its own distance, so each takes the
orientation of the track beneath it.

**Animation speed** is authored in metres per second. The constructor always
initializes the shared route cursor to distance zero, including for negative
speed. Only ping-pong mode reverses at that starting end; modes 0, 1, 3 and
out-of-range modes clamp there, so a negative authored speed does not create a
backward wrap loop. On a ping-pong return leg the speed sign flips the pitch and
adds π to yaw so the model continues to lead. The **end mode** decides what
happens at the forward end:

| Mode | Behavior at the end |
|---:|---|
| 0 | mark the mover finished; its next update destroys the node and frees its pose buffer |
| 1 | wrap around and continue (the looping case) |
| 2 | ping-pong: reverse, turning the prop 180° so its nose leads |
| 3 | zero the speed and hold the end pose while the mover remains alive |

Every end-mode value outside 0–3 takes the same forward-wrap branch as mode 1.
At the starting end, only mode 2 reverses; all other values clamp to zero.

[measured] [[230-splinemover]]()

> [[230-splinemover]]() `cSplinePathNode`, RTTI `15cSplinePathNode`
> @0x0039b9f0, vtable 0x0039b980, 160-byte node. Ctor @0x001fa600 (reached
> from the type-2 dispatch @0x0013d138, sub-1 branch @0x0013d284, which bails
> on spline index −1); Update = vtable+0x14 @0x001fab98; pose builder
> @0x001fadd0; render = vtable+0x1c @0x001fb0c0. Per-copy pose buffer is
> tagged "SplinePathModelPoses" @0x0039b968 (count × 32 B: vec4 position,
> vec3 Euler). Payload offsets: +0x0C spline index, +0x10 end mode, +0x14
> orientation mode, +0x18 instance count, +0x1C speed, +0x20 yaw offset,
> +0x24 bool gating the spline-line draw @0x00251c78 (called from @0x001fb100,
> its only caller in .text), +0x28 that line's alpha and +0x2C..0x34 its RGB —
> each x128 into one GS RGBAQ by the packer @0x001e84b8, so 128 = 1.0 (the
> gondolas' 0.1 grey + 1.0 alpha = an opaque near-black #181818; the subway
> authors 0/0, i.e. transparent black, and gates it off anyway). The line
> walks every segment (count @spline+0x1c, next @seg+0x54), each culled by
> @0x00251fc8, emitting 10 vertices at t = k/9 (step 0x3de38e39 @0x00251dec)
> from the same cubic; the clipper @0x001e3b50 processes (prev, current)
> pairs = line-strip topology; texture id -1 (untextured) via vt+0x1f4. No
> width/radius is computed anywhere - a GS line is 1 pixel. Authored rotation:
> the class touches only instance +0xC0 (model),
> +0xCC/+0xD8 (bbox), +0xE4/+0xE8 (flags) and the ctor's translation row
> (0x30, for the cull AABB) — the rotation rows +0x00/+0x10/+0x20 are never
> read, and the matrix's translation row is overwritten wholesale from the
> pose @0x001fb5cc. Render composes three Rodrigues rotations (X applied
> first, then Y, then Z); the Y (roll) Euler is hard-zeroed @0x001faf78. The
> rotations are CLOCKWISE about each axis: for Z, the images of the model
> basis are (cos θ, −sin θ, 0) and (sin θ, cos θ, 0) — read off the quadwords
> directly, since the VU macro (VMULAx/VMADDAy/VMADDAz/VMADDw) makes quadword
> i the image of basis vector i, no row/column convention needed. Yaw =
> (π/2 + offset) − atan2(t.y, t.x) @0x001faed4-0x001faf2c (the helper
> @0x00251628 is a plain atan of t.y/t.x built in the delay slot, with
> quadrant fixups @0x001faeec-0x001faf20), so at a ZERO offset the image of
> model +Y is the tangent; pitch = −t.z rad @0x001faf44 about model X (sign
> flipped when speed < 0). The offset is therefore the lead-axis selector, not
> a trim: MERQUER's two byte-identical sub-1 chains (751/752, from
> data/models/merquer.ssf inside MERQUER.BIG) author spline 38, end mode 1,
> orient mode 1, count 1, speed 35.0, offset 1.62 — putting the train's long
> −X axis on the track and disabling the (now roll-inducing) pitch.
> Spacing = arc length ÷ count @0x001fa728. Speed =
> payload × 100/60 @0x001fa70c → cm per 60 Hz tick, i.e. m/s authored (the 60
> is hardcoded, so a 50 Hz PAL tick runs it ~0.83×). End modes @0x001fac30 and
> @0x001fac60; the reverse leg adds π to yaw @0x001fae40. Mode 0 sets
> `node+0x40`, whose next Update dispatches the vtable `+0x0c` destructor
> @0x001fab38; mode 3 instead zeros `node+0x4c` and stays resident. Live PINE on
> MERQUER found the one-copy subway mover (spline 38, 35 m/s, end/orient 1/1)
> with instance `+0xe8 = 0`, so the optional count-one callback is gated off;
> its controller vtable target is @0x0013b760, a literal `jr ra; nop`. It cannot
> add a hidden pose transform. [verified]
> Live PINE confirmation (SNOW, `SLES-50545`): the 15-copy gondola mover at
> 0x0085d770 carried the runtime orientation word at +0x38. Advancing the paused
> VM after reversible writes produced `(pitch, roll, yaw)` pose triples with
> both pitch/yaw varying for 0, yaw-only for 1, pitch varying with yaw fixed at
> π/2 for 2, and `(0, 0, π/2)` for every copy in mode 3. The word was restored
> to its retail value 1 after the sweep. Static branches @0x001fae6c and
> @0x001faf34 establish the out-of-range fallback above. [verified]

## Object-properties record — 24 bytes

The shared behavior record of `120-objects.md`/`130-collision-data.md`;
this is its byte layout. [measured] [[230-props]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | f32 | rider-response mass (`130-collision-data.md`; zero vs nonzero, not the dynamic-body mass) |
| 0x04 | f32 | player-bounce magnitude |
| 0x08 | u16 | initial live-status half-word — copied with the flags into the instance's runtime status word as its low (live) half, then overwritten wholesale by the authored flags on the first activation; zero on every retail record, so it is dead in shipped data [[230-props-flags]]() |
| 0x0A | u16 | bit flags (assignments: `120-objects.md`); only five bits are ever set in the surveyed levels. The engine tests only the visible, player-collision, player-bounce and UV-scroll bits of the authored word; bit 12, set on a fifth of retail records, has **no reader** — it is a tool-side marker for instances whose own model is the subject of a model-modifying effect (fences, flags, gems, rollers, throw pieces, flip targets), and a reader may ignore it [[230-props-flags]]() |
| 0x0C | i32 | surface type (−1 = none; populated only on rideable proxies) |
| 0x10 | i16 | collision mode 0–3 |
| 0x12 | i16 | shape index — collision-pool index when mode ≠ 3, physics-pool index when mode = 3; one shared slot, disambiguated by the mode; −1 allowed |
| 0x14 | i16 | effect-slot index (−1 = none) |
| 0x16 | i16 | padding — no reader anywhere in the executable; zero on every retail record [[230-props-flags]]() |

> [[230-props-flags]]() loader copy `lw a0,8(v0)` / `sw a0,0xe8(a1)` at
> `0x0025fd5c/0x0025fd70` in `SsfFile_LoadAndLink` `0x0025fac8` (v0 =
> `[hdr+0x38] + idx*24`); bit-13 test `sra v1,a0,16; andi 0x2000` at
> `0x0025fd64–0x0025fd6c` and `lh a0,0xea(a1); andi 0x2000` at
> `0x0025fd84–0x0025fd88` → `[entity+0xc0]+0x10 |= 0x10`; live-half init
> `authored | 0x0102` at `0x0025f8f0–0x0025f96c`; the 14-site restore idiom
> rebuilds the low half from the high (`120-objects.md`
> `[[120-runtime-hide]]()`). Exhaustive mask scan over every `lw/lh/lhu/lb/lbu`
> at `+0xe8..+0xeb` (16-instruction window, tracking moves/`sra`/`ext`):
> tested masks are 0x3, 0x4, 0x20, 0x80, 0x200, 0x400, 0x800, 0x900 and the
> clears 0xfffd/0xfff9 — no 0x1000 in either half. Properties-record readers
> via `[x+0xec]`: +0x00 (`0x00125a58`, `0x0025cc48`), +0x04 (`0x00125a68`),
> +0x0c ×23, +0x10 (`0x0025c4cc`), +0x12 (`0x0025c99c`, `0x002611d8`), +0x14
> (`0x002603c0`) — nothing at +0x08/+0x0a/+0x16. Twelve-level census (5,413
> records / 25,470 instances): flag values {0:2, 1:25, 32:189, 33:50, 160:52,
> 161:2545, 4096:9, 4097:58, 4128:78, 4129:143, 4256:22, 4257:2090, 8193:21,
> 8225:27, 8353:57, 12289:45}; bit 12 vs slot columns: bit12 & collision-only
> 2166, bit12 & no-slot 51, no-bit12 & has-slot 761; GARI bit-12 =
> `Fnc_FenceChainLink_NoLogo` 332, `PathMarker` 39, gems 79, `FWTrigger` 23,
> `CrashBagA` 22, `Lcd_ScreenLogo/Broken/scan` 9+9+9; GARI no-bit-12 with a
> slot = `Crowdstand_S_Reset` 64, `4x4_people` 64, `Water_River` 44, signs,
> `ResetZone_40x40` 20, jumbotrons. Fields +0x08/+0x16 zero on all 5,413.
> map:"SSF loader: validation, pools, physics records, spline records".

> [[230-props]]() SSFHandler.cs `ObjectPropertiesStruct` (record size pinned
> by section tiling); bit numbering = TrickyLevelInterface BitArray decode
> lines 247–257; GARI 531 records: movability {1e30×483, 0×45, 5.0×3},
> bounce {0.5×165, 0.6×359, 0.2×4, 0.03×3} (consumed @0x00125a68,
> db:prop-bounce), surface −1 ×531 (MESA: one record = 12 wood, the bridge
> twin, db:anim-object), modes {0:14, 1:412, 2:48, 3:57}, max shape indices
> exactly fill both pools; BitFlags values: 4257×374, 161×57, 8353×44,
> 4128×23 (invisible+collidable), 11 distinct total.

The instance join table is one u32 per instance (instance order): the index
of that instance's properties record. The mode-2 collision box is **not**
stored here, and it is **not** the instance's PBD bounding box either — that one
is the cull box, and the collider is the model's own local box
(`130-collision-data.md`). The PBD box is, for a static prop, exactly the
axis-aligned bounds of the model under the instance's own transform, so a
reimplementation may compute it rather than carry it. **An animated prop is the
exception**: its shipped box is enlarged to cover the whole clip's sweep, by up
to several metres, and a recomputed static-pose box is too small for it.
[measured] [[230-instance-table]]()

> [[230-instance-table]]() SSFHandler.cs instance loop +
> TrickyLevelInterface line 241; mode-2 runtime =
> WorldLine_IntersectAABBSlab @0x0025e178 fed by instance bounds (the rider's
> own mode-2 path is `370-world-interaction.md` `[[370-probe-modes]]`),
> db:collision. Stored box read directly from `aloha.pbd`: header = 4-byte
> magic `00 15 1B 01`, 15 u32 counts, 18 u32 offsets; `NumInstances` @0x0C =
> 1997, `InstanceOffset` @0x48 = 0x13A0D0, **stride 256** (pinned both by
> section tiling to `ParticleInstancesOffset` and by `ModelID` at +0xC0
> matching `Instances.json` on all 1997 records), bounds at +0xCC / +0xD8.
> Census vs the transformed-model AABB: 1934 of 1997 agree within 0.5 units,
> and all 63 outliers are animated models (`Mdl_MediaTower_Tall` ×6 up to 552
> units, `Mdl_FanBlade`, `Mdl_BarrierDynamic_SideToSide` ×4 at 423). Rotation
> alone produces no disagreement — 1447 instances carry one. Worst mode-2
> disagreement across 249 instances: 94.8 units. Decode note: PBD model
> pointers are relative to `ModelsOffset`, not absolute (PBDHandler.cs:379);
> SSX-Library reads the instance bounds into `LowestXYZ`/`HighestXYZ`
> (PBDHandler.cs:203) but the Tricky JSON exporter drops both, so
> `Instances.json` does not carry them.

## Spline records — 8 bytes

`{i16, i16, u32 style}` per spline, parallel to the PBD spline section
(`220-level-pbd.md` holds the geometry). Every spline on all twelve retail
levels ships the i16 pair as **(1, 1)** except the handful of non-rail path
splines (train/subway movers, gondola wires, half-pipe movers), which ship
**(−1, −2)** with style −1; style 13 = grind rail (`140-paths.md`). The
loader **discards the first value** and stores the **second in both halves
of the spline object's status word**, whose bit 0 is the rail-candidacy gate:
the nearest-rail query rejects a segment whose bit 0 is clear before any
curve math, and the spline-toggle node sets or clears that same bit
(`350-rails.md`). So the second value is the spline's **initial
grindability** — 1 = candidate; −2 and 0 both have bit 0 clear — which is why
a repacked level whose rails carried (0, 0, 13) produced no rail lock-on
in-game with geometry, grid listing and style all intact. Authored levels
must ship 1 there for any rail meant to be grindable from load. The first
value is padding as far as the engine is concerned (retail ships it equal in
sign to the second). One tension remains: Mesa's two fallen-trunk splines
ship (1, 1) and are therefore candidates from load by this gate, so whatever
keeps them non-grindable until their enable toggle is a different gate.
Spline-toggle nodes and spline-path emitters address these records by index.
[measured] [[230-splines]]()

> [[230-splines]]() SSFHandler.cs `Spline`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs; GARI: 169 records, all
> (1, 1, 13). Twelve-level census: (1, 1) on 1,650 splines of styles
> 13/12/5/1; (−1, −2, −1) on 13 movers (ELYSIUM 7, MERQUER 3, SNOW 3); MESA
> 87/88 = (1, 1, 1). Loader spline loop `0x0025fdb4–0x0025fe18` in
> `SsfFile_LoadAndLink` `0x0025fac8`: `0x00255050(world, i)` → spline object;
> record read `ldl/ldr a0,7/0(v1)` (v1 = `[hdr+0x48] + i*8`) at
> `0x0025fdec/0x0025fdf0`; style `lw a0,4(sp)` → `sw a0,0x24(v0)` at
> `0x0025fdfc/0x0025fe00`; the second i16 is duplicated into both halves of
> `sceneObject+0x18` (`sw v1,0x18(v0)` at `0x0025fe18`, five instructions from
> `0x0025fe04`; first i16 dropped). Gate: a four-instruction test of bit 0 of
> `sceneObject+0x18` ending `bnel` at `0x00259c04` (from `0x00259bf8`) in
> `RailQuery_FindNearestRailCandidate`; writer
> `RailMan_ApplyRailFlagToSceneObject` `ori 1` at `0x00148f3c` / `and -2` at
> `0x00148f50`. The upper half (`+0x1a`) has no traced reader. Dead-rail
> repro (MOUNTAIN12 repack GARI): 6 authored rails written (0, 0, 13) → no
> lock-on riding the disc, while the same build's PBD spline/segment sections
> (6/55), `.ltg` node SplineIndex lists (55) and style 13 checked out offline.

## Collision proxy payload (mode 1)

Reached via the collision pool pointer table. Each model: [measured]
[[230-proxy]]()

| Offset | Content |
|---:|---|
| 0x00 | u32 face count |
| 0x04 | u32 vertex count |
| 0x08 | u32 alignment pad size — pad bytes inserted after the index list so the vertex array starts 16-aligned |
| 0x0C | u32 × 3 × face count: triangle indices |
| … | the pad bytes |
| … | f32 ×4 × vertex count: positions (model space, cm; w = 1.0) |
| … | f32 ×4 × face count: precomputed per-triangle face normals (w = 0.0) |

The example level's pool holds 412 unique proxy meshes totalling 6,092
triangles / 5,642 vertices of unique geometry (the larger figure cited in
`130-collision-data.md` is after per-instance replication). [measured]
[[230-proxy]]()

> [[230-proxy]]() SSFHandler.cs `CollisonModel`; GARI: pad distribution
> {12×385, 4×21, 8×6}, `(indexEnd + pad) % 16 == 0` on all 412; w components
> verified 1.0/0.0 on all models; model 0 = 436 faces / 270 verts. Runtime
> consumer WorldTriangleList_IntersectLineCandidate @0x0025d908 via the
> narrowphase dispatch @0x0025c900 (table @0x003a8d18), map:"Prop collision
> SHAPE", db:collision.

## Physics body payload (mode 3)

Reached via the physics pool pointer table. Each body: [measured]
[[230-body]]()

| Offset | Content |
|---:|---|
| 0x00 | u32 end-alignment pad size (1–4; pads the record end to 4 bytes) |
| 0x04 | u32 mask-data byte count |
| 0x08 | u32 mask encoding: **1** = the occupancy masks are run-length encoded and are decoded through a small cache every time the body is probed; **0** = stored raw, one byte per node in level order, used in place with no decoding |
| 0x0C | u32 tree depth − 1 |
| 0x10 | f32 × 24 mass-properties block |
| 0x70 | 12 bytes × depth: per-level records `{f32 radius, f32 child offset, u32 stride}` |
| … | the occupancy masks (RLE or raw, per 0x08) |
| … | the pad bytes |

Retail ships raw bodies: the fire-hydrant lid and two gargoyle break pieces
in Merqury City and the red flares in Untracked — all depth-3 bodies with
exactly 73 raw mask bytes. Every other body is compressed. A decoder that
always RLE-decodes misreads those four. [measured] [[230-mask-encoding]]()

> [[230-mask-encoding]]() body ctor `0x00239860(wrapper, payload, index)`:
> memcpy `+0x08 → sub+0x08` (wrapper+0xd8) at `0x002398bc–0x002398c8`; flag
> branch `lw v1,8(a3); beq → sub+0x28 = sub+0x24` (raw masks used in place)
> at `0x00239964–0x0023997c`, else `sw zero,0x28` at `0x00239974`; levels ptr
> `sub+0x20 = payload+0x70` at `0x00239948`, masks ptr `sub+0x24 = levels +
> depth×12` at `0x0023995c`; decode-through-cache
> `PhysicsBody_GetDecodedMaskCached` `0x00239470` (two rings at `0x00344ba0`…,
> keyed by body index, RLE decoder `0x0023a040` at `0x00239538/0x00239630`),
> gated on `sub+0x08` at `0x00239a00`, `0x00239c2c`, `0x0023a6c0`,
> `0x0023a770`, `0x0023a818`, `0x0023a900`, `0x0023a9f4`, `0x0023aa14`; element
> test reads `[sub+0x28]+offset` at `0x0023ad0c–0x0023ad20`. Twelve-level
> census: flag 0 on MERQUER phys[14] `Mdl_FireHyDrant_TopLid` ×6 (depth 3,
> 73 mask bytes), phys[57] pieces 11/12, UNTRACK phys[0] `Mdl_Flare_Red`.

**Mass-properties block** (`130-collision-data.md`): floats 0–2 = the
**collision shape's center** — the root of the sphere tree, body space, cm —
consumed only by the contact probe; floats 3–5 = the body's **center of
mass** in model space, consumed only by the dynamic-body path: when a
knock-off body is created the engine rotates that offset by the instance's
orientation and adds it to the instance position to get the rigid body's
reference position, and every tick rotates it by the body's live orientation
and subtracts it to recover the model transform — the body pivots about
floats 3–5 and the model is drawn at body − R·(floats 3–5). Floats 6–14 =
the symmetric 3×3 inertia tensor (row-major), floats 15–23 = its inverse,
which the knock-off body copies scaled by 0.075. The two points differ on
798 of 800 shipped bodies (median offset 6–13 % of the root radius); the
coincident case is the exception. [measured] [[230-mass]]()

**The occupancy tree.** The shape is a depth-N, base-8 occupancy tree over a
cube centered on the root center. Per level d: `radius[d]` is the node
sphere radius at that depth (a leaf is tested as a sphere of this radius);
`child offset[d]` is the signed center offset from a parent at depth d−1 to
its children (level 0's is always 0); `stride[d]` is the child mask-offset
stride, equal to 8^d in every surveyed body. The child addressing rule is
**child mask offset = parent offset + (bit + 1) × stride[d−1]** — i.e. a
parent at depth d−1 indexes its own depth's stride entry to place its
children at depth d; the +1 is essential; with these strides the levels lay
out level-sequentially in the decompressed mask array (root 0, depth 1 at
1–8 using `stride[0]` = 1, depth 2 at 9–72 using `stride[1]` = 8, …).
Child centers are parent + octant × child offset, with octant signs decoded
from the child bit as x = bit∧4, y = bit∧2, z = bit∧1. A node whose mask is
zero, or at maximum depth, is a solid leaf covering its whole sub-cube.
[measured] [[230-tree]]()

**Mask RLE.** The mask bytes are run-length encoded: read a signed control
byte; negative = copy that many literal bytes; positive = repeat the next
byte (control + 1) times; zero = stop. Each decoded mask byte's bit b set
means child octant b is occupied. A full depth-5 tree decodes to
1+8+64+512+4096 = 4,681 bytes. [measured] [[230-rle]]()

Decoded bodies reproduce real prop shapes — including **hollow** gateway
structures (cave scaffolds with open mouths, finish arches), which is how
ride-through works with no flag (`130-collision-data.md`,
`370-world-interaction.md`). [observed] [[230-body-practice]]()

> [[230-body]]() SSFHandler.cs `PhysicsData`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs, + section/ByteSize tiling
> (physics 6: 224 = 16+96+4×12+63+1); GARI: 56 bodies, depth {5×54, 4×2},
> end-alignment {1:17, 2:10, 3:18, 4:11}.

> [[230-mass]]() db:physics-body; raw re-measurement: path marker root
> center (0, 0, 87.211), inertia diag (1959.52, 1959.52, 122.33), inverse diag
> exact reciprocals; crash bag root center (−14.46, −50.54, 4.33) vs center of
> mass (−14.28, −20.75, 4.33) — not coincident, db:crash-bag. Readers: floats
> 0–2 (`sub+0x14`, wrapper `+0x90` with w=1 at `0x002399ac/0x002399b0`) are
> passed as the root center `addiu a2,a0,0x90` at `0x0023a6fc` into
> `PhysicsBody_SphereContactElementTest` `0x0023ac48`; floats 3–5 (`sub+0x2c`)
> have one reader binary-wide, the Roller ctor `0x0013d7f8` (`lw v0,0xa0(s3)`
> → `lwc1 0x2c/0x30/0x34` at `0x0013d81c–0x0013d834` → `sqc2 vf2,0x130(s2)`,
> w=0), which rotates it by the instance quaternion (`0x00250a20` at
> `0x0013d8f8`; v + 2w(q×v) + 2(q×(q×v)) at `0x0013d900–0x0013d9cc`), adds the
> instance position (`0x0013d9d0–0x0013da10`) and stores the body position
> `sqc2 vf2,0x60(s2)` at `0x0013da2c`; the per-tick inverse
> `PhysicsBody_ModelPoseFromBodyState` `0x0013e6a8` rotates `node+0x130` by
> `node+0x70` and subtracts (scale −1.0 at `0x0013e7ec`), callers `0x0013ec38`,
> `0x0013dfac`, `0x0013fa7c`. Inverse tensor `sub+0x5c..0x7f` → `node+0x100`
> ×0.075 (`0x3d99999a` at `0x0013d808`) at `0x0013d844–0x0013d8f4`.
> Twelve-level census: |CoM − root|/r0 median ALASKA 0.057, GARI 0.064, MESA
> 0.135, max 0.46; coincident (< 1 % r0) 21/800.

> [[230-tree]]() map:"Mode-3 sphere-tree payload layout"; the (bit+1)×stride
> multiply @0x0023adb8 inside PhysicsBody_SphereContactElementTest
> @0x0023ac48; octant sign table filled @0x0023bfd0 (body ctor copies it
> @0x0023a0c8, re-orients @0x0023a280); runtime payload pointers
> [payload+0x20]/[+0x0c]/[+0x28]; measured strides (1,8,64,512,4096) on all
> 54 five-level GARI bodies. Sample: crash bag
> radii 263.35/171.41/89.26/46.48/24.20 cm, offsets 0/121.21/63.11/32.86/17.11.

> [[230-rle]]() decoder @0x0023a040; GARI record 6 = 63 mask bytes, record 7
> = 479.

> [[230-body-practice]]() collision-body emission measured on MESA: Cavescaf
> physIdx 52 → 4.7×14×9.7 m slab with the cave mouth empty;
> FinishArch 18 → hollow 23 m arch; 956 mode-3 candidates → 908 AABBs + 48
> doorway props. Runtime contact: mode-3 line query = no-hit stub
> @0x0025e170; real contact via the object probe @0x00125090 →
> @0x002399c8 → @0x0023ac48; movable bodies → impulse solver @0x00154350,
> db:collision.

## Writer and fresh-graph append conformance

The current writer has a corpus-level semantic conformance gate. It parses,
validates every cross-reference, saves, reloads, strips only physical layout
fields (absolute/relative offsets, byte sizes, alignment padding), and requires
the complete remaining object graph to compare equal. All 12 PAL retail level
SSFs pass: 9,067 chain nodes and 25,470 instance joins in total, with every
rebuilt file also retaining its original byte length. This is stronger than a
parse-only smoke test and catches type-asymmetric reader/writer bugs such as the
`U9` issue above. [measured] [[230-writer-conformance]]()

Appending a fresh effect without disturbing shared records uses this exact
sequence: [measured] [[230-append-recipe]]()

1. append the new node list as a new anonymous effect-chain header;
2. append an effect-slot record whose selected circumstance points at that
   header;
3. clone the host's resolved shared property record
   `ObjectProperties[InstanceState[host]]`, put the new slot index on the clone,
   and append it; and
4. redirect only `InstanceState[host]` to the cloned property record.

Cloning in step 3 is mandatory: editing the old property in place silently
changes every instance sharing it. GARI's fresh-emitter canary applied the
recipe to previously effectless instance 215, appending slot 78, header 306 and
property record 531. It saved/reloaded semantically, was RefPack-compressed into
a rebuilt `GARI.BIG`, installed into a *copy* of the retail ISO (the BIG grew and
was relocated), then extracted back and compared equal; all ten unrelated BIG
members remained byte-for-byte identical. This proves new graph topology and
the full ISO write path independently of the future editor UI. Runtime/visual
acceptance is a separate gate. [measured] [[230-iso-canary]]()

> [[230-writer-conformance]]() `snowknife ssf-check <file|directory>`;
> retail corpus ALASKA/ALOHA/ELYSIUM/GARI/MEGAPLE/MERQUER/MESA/PIPE/SNOW/
> SSXFE/TRICK/UNTRACK = 12/12;
> doc:../research/effects-authoring-p0.md.
>
> [[230-append-recipe]]() the canary recipe; the property table is
> shared exactly as described by `[[230-joins]]()`;
> doc:../research/effects-authoring-p0.md.
>
> [[230-iso-canary]]() `snowknife ssf-canary` followed by
> `snowknife ssf-install-iso`; the installer re-extracts the output image and
> verifies both the authored SSF semantics and every untouched raw BIG member;
> doc:../research/effects-authoring-p0.md.

### Portable authoring interchange

The engine-neutral authoring boundary is `Effects.json` (`openslope-effects` version
1), not the legacy extracted `SSFLogic.json`. The portable document represents
every semantic SSF table but gives graphs, functions, slots, nodes, shared
properties, instance bindings and resources stable string IDs. Cross-table
links name those IDs; array order requests the next compact SSF export order and
`originalIndex` is provenance only. Known and partially known node data retains
the native field names under `payload`, while reference-bearing integer fields
are promoted to stable `references` and reconstructed only during binary
compilation. [measured] [[230-effects-interchange]]()

Snowknife refuses dangling/duplicate IDs and unknown payload members, compiles the
document to an SSF, saves/reloads it, and requires the complete semantic graph to
remain equal. The full 12-level PAL corpus passes the two-way adapter: 9,067
nodes and 25,470 instance bindings. Slopesmith and Unity consume the same
versioned document; non-SSF preview metadata is isolated under `extensions` and
ignored by the binary compiler. [measured] [[230-effects-interchange]]()

Slopesmith P2 edits those ordered lists directly and keeps its authored
prop-to-slot join under `extensions.slopesmith.attachments`, keyed by a stable
prop ID. That join is intentionally not claimed as SSF data: the native graph
and slot are in SSF, but the owning object's `EffectSlotIndex` is written in the
level instance table. The timer-emitter spatial handle writes the native
`U9..U11` local point in engine centimetres, using the coordinate and prop-pose
conversion documented in `180-particles-data.md`. [measured]
[[230-effects-editor]]()

The read-only reference viewer resolves the shipped object-side join by
matching `Instances.json[].EffectSlotIndex` to a portable slot's
`originalIndex`, then follows that slot's stable circumstance references to the
graphs. Its preview executes known flow/emitter nodes but is explicitly an
approximation: native collision volumes, sprite rendering and audio are not
claimed until their consumers are implemented. [measured]
[[230-reference-preview]]()

> [[230-effects-interchange]]() P1 design, corpus results and command contract;
> doc:../research/effects-authoring-p1.md.

> [[230-effects-editor]]() P2 editor contract, tests and remaining packaging
> boundary; doc:../research/effects-authoring-p2.md.

> [[230-reference-preview]]() Reference join and preview/runtime limitations;
> doc:../research/effects-authoring-p2.md.

## Real counts

| Section | GARI (raw file) | MESA (export) |
|---|---:|---:|
| Effect slots | 78 | 106 |
| Physics pool | 56 | 89 |
| Collision pool | 412 | — |
| Anonymous chains | 306 | 288 |
| Named functions | 20 | 15 |
| Properties records | 531 | — |
| Instances | 3,393 | 3,082 |
| Splines | 169 | — |
| Total chain nodes | 700 | 762 |

Per-instance collision-mode distributions and movability tallies are in
`130-collision-data.md`; note the per-*record* tallies differ (one shared
record serves many instances). [measured] [[230-counts]]()

> [[230-counts]]() GARI from the raw .ssf this pass, parsed per
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs;
> MESA from the PAL-disc JSON export (SSFLogic.json / Instances.json).

<!-- DIRTY
Open questions (derivations: elf-map "SSF loader: validation, pools, physics
records, spline records"):
- Flag (sub 13): which model edge is station 0, and the amplitude's absolute
  unit (render-manager corner supplier vt+0x2b4 unread). Debounce negative pin
  read, not measured (one autotest cell `Debounce −1` vs `0` on a region the
  rider leaves settles it).
- BitFlags bit 12's authoring-side rule ("the instance's own model is the
  subject of a model-modifying effect") is a correlation over 5,413 records,
  not a definition; a repack flipping it on a fence/gem and a reset zone
  (predicted: no change) would license packers to ignore it.
- The "payload j ↔ j-th collision-bearing sub-object" rule for multi-payload
  pool entries is read from index arithmetic (0x0025c99c–0x0025ca1c); a live
  check on MEGAPLE coll[74] (9 proxies) would close it, as would reading what
  fills objectRecord+4.
- Spline status word upper half (sceneObject+0x1a): reader untraced; and the
  gate that keeps MESA's (1,1) style-1 trunk splines non-grindable before
  their toggle (check the .ltg segment lists or a style test).
- Header float +0x08 provenance (exporter stamp) and word 0 = 0x001E0200
  (tool version?) — engine-ignored, cosmetic.
- Roller's ×0.075 inverse-inertia scale and the decoded-mask cache ring
  thresholds (0x00239010(…,10,4,2,5)) noted, not chased.
DIRTY -->
