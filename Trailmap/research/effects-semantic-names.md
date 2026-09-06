# SSF effects semantic-name census

Date: 2026-07-14. Corpus: all 12 PAL retail level SSFs reconstructed during the
P1 round-trip proof (9,067 graph/function nodes).

## Result

The retail data contains no unknown main-type-0 property subtype. Every authored
subtype maps either to an original engine registry name or, for subtype 5, to a
behavior confirmed from its handler. Snowknife now emits these stable semantic
labels while preserving the native `mainType`, `SubType`, payload and references
needed for lossless repackaging.

| Sub | Engine/community identity | Portable semantic label | Typical attached models |
|---:|---|---|---|
| 0 | Roller | `property.roller` | garbage cans/lids, hydrant top lids, crash bags |
| 2 | Debounce | `property.debounce` | hydrant bases and trigger volumes |
| 5 mode 0..4 | unnamed handler (community “DeadNode”) | `property.node-destroy`, `property.node-pause`, `property.node-tombstone`, `property.node-tombstone-flagged`, `property.breakable-kill` | gems for mode 2; fences, signs, hole covers and balloon animals for mode 4 |
| 6 | Counter | `property.counter` | Metro City building strike sequence |
| 7 | Boost | `property.boost` | the engine's general directional velocity driver — `Mdl_Trigger_Boost*` and sand-boost volumes, but also Megaplex's conveyors, exhaust vents and air shafts and Untracked's `Mdl_ForceWind_*` (spec:360-node) |
| 10 | UVScroll | `property.uv-scroll` | LCD scan layers, jumbotrons and boost-pad materials |
| 11 | TexFlip | `property.texture-flip` | LCD logo screens, checkpoint tops and warning/directional signs |
| 12 | Fence | `property.fence` | `Fnc_*` chain-link/directional fence pieces |
| 13 | Flag | `property.flag` | `Flg_Flag_*` and tapered banner models |
| 14 | Cracked | `property.cracked` | `Mdl_Glass_Pane_*` two-stage breakable glass (MEGAPLE only, 20) |
| 15 | LapBoost | `property.lap-boost` | `Mdl_Endboost_Lap_1000` finish tube (MEGAPLE only, 1) |
| 17 | CrowdBox | `property.crowd-box` | `Mdl_4x4_people*` crowd grids |
| 18 | ZBoost | `property.z-boost` | `Mdl_twinAirShaft_BOOST_0` air shafts + `Mdl_Endboost_Z_1000` (MEGAPLE only, 3) |
| 20 | cMeshAnim | `property.mesh-animation` | broken glass/fence debris and burn-tree branches |
| 23 | Movie | `property.movie` | finish screens and advertising billboards |
| 24 | TubeEndBoost | `property.tube-end-boost` | `Mdl_Endboost_End_1000` finish tube (MEGAPLE only, 1) |
| 256 | AnimObject | `property.anim-object` | spinning trick-multiplier gems |
| 257 | AnimDelta | `property.anim-delta` | `Mdl_DynKicker_Event1_*` hinged kickers |
| 258 | AnimCombo | `property.anim-combo` | Aloha's `Mdl_BarrierDynamic_SideToSide_*` (5) + one unattached Megaplex slot |

The engine string block also identifies live constructors absent from retail
authoring: Timer (8), Rail (9), RandomBoost (16), UVScrollTexFlip (19),
TrickTrigger (21), Particle (22), and AnimTexFlip (259). Their names are safe;
some payload field meanings remain open and the current SSF adapter must not
invent them.

**Single-course sub-types.** Four registry names are authored on MEGAPLE and
nowhere else — 25 nodes in total, every one on the collision circumstance. A
census over any narrower corpus reports them as unauthored, so they are called
out here as well as in the table above:

| Sub | Count | Where |
|---:|---:|---|
| 14 Cracked | 20 | the `Mdl_Glass_Pane_*` panes; the collision chain only *cracks*, and the shatter is the slot's column-5 deferred-trigger chain (spec:150-deferred-trigger, spec:370-breakables) |
| 15 LapBoost | 1 | `Mdl_Endboost_Lap_1000` (spec:360-boost-subtypes) |
| 18 ZBoost | 3 | `Mdl_twinAirShaft_BOOST_0` ×2 (paired with a persistent particle plume) + `Mdl_Endboost_Z_1000` (spec:360-boost-subtypes) |
| 24 TubeEndBoost | 1 | `Mdl_Endboost_End_1000` (spec:360-boost-subtypes) |

Re-derive with `snowknife effects-export` over each retail `.ssf`, then group
`graphs[].nodes[].payload.type0.SubType` across all 12 documents.

## The boost sub-types are one family, not five

Five registry names — Boost (7), LapBoost (15), RandomBoost (16), ZBoost (18),
TubeEndBoost (24) — share one mechanism, and the class structure says so
directly. `BoostNode_ConstructFromEffectPayload` @0x001404a0 is the base: the
RandomBoost ctor @0x00141210 and the TubeEndBoost ctor @0x00141690 both open by
calling it, and TubeEndBoost's vtable slot 2 *is* `BoostNode_Update` @0x00140690
— it overrides only the apply. ZBoost and LapBoost are separate classes but lay
out the same three fields at the same node offsets (+0x40 direction, +0x50
target ×100, +0x54 rate), and ZBoost's push block @0x00141ea4 is
instruction-for-instruction the base's.

So a reader meeting any one of them should expect the same rate/target/axis
triple and reach for spec:360-node first. What each *adds* is in
`../specs/360-speed-and-boost.md`. Only sub-16's payload semantics remain
untraced, and it is unauthored across the whole corpus.

## Naming policy

The portable labels track the **engine's own registry name** wherever one
exists, and a confirmed behavior only where none does (subtype 5, the
main-type-5 conditions, the main-type-3/9 controls). That is deliberate and
worth preserving: it keeps a label greppable 1:1 against the ELF's
`EffectName_*` and RTTI strings and against this table, and — the reason that
matters most — it keeps the wire vocabulary **stable as understanding
improves**. Nothing here needed renaming when sub-7/15/18/24 were traced, even
though what they do turned out to be a good deal more specific than their names
suggest.

A label is therefore not the place to carry the current best description of
behavior. Consumers should render their own display names on top: Slopesmith
does exactly this, showing "Vertical lift (Z boost)" for `property.z-boost`
while the wire value stays put.

## Numeric-fallback census

Before semantic labeling, the 12-level corpus contained 3,358 generic property
labels, 453 generically named main-type-5 conditions, and 206 generic
main-type-3/9 controls. The most common were subtype 5 (1,510), subtype 20
(474), subtype 0 (467), main type 5 (453), subtype 256 (291), subtype 11 (211),
and subtype 2 (151). After engine-name mapping and receiver-aware control
tracing, the numeric-fallback count is zero for the corpus.

## Circumstance-column census (2026-07-22)

Derivation for spec:150-column-census and spec:150-deferred-trigger. Method:
`snowknife effects-export` over each of the 12 retail `.ssf` files, then a
`slots[].circumstances.* → graphs[].nodes` join counting the nodes behind every
reference — so an authored-but-empty reference is distinguishable from an
absent one, which a raw "is it −1" scan cannot do.

Populated slots per column, and how many of those point at a **zero-node**
chain:

| Level | slots | col1 persist | col2 collision | col3 | col4 | col5 trigger | col6 | col7 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ALASKA | 44 | 24 | 31 | 1 (1 empty) | · | · | · | · |
| ALOHA | 68 | 57 | 32 | · | 1 (1 empty) | · | · | · |
| ELYSIUM | 109 | 35 | 88 | 1 (1 empty) | 1 (1 empty) | · | · | · |
| GARI | 78 | 48 | 56 | · | · | · | · | · |
| MEGAPLE | 190 | 22 | 179 | 20 (20 empty) | · | 20 | · | · |
| MERQUER | 391 | 42 | 362 (2 empty) | · | · | 1 | · | · |
| MESA | 106 | 42 | 82 | 1 (1 empty) | · | · | · | · |
| PIPE | 44 | 10 | 41 | 1 (1 empty) | · | 1 | · | · |
| SNOW | 57 | 38 | 38 | · | · | · | · | · |
| SSXFE | 3 | · | · | · | 3 (3 empty) | · | · | · |
| TRICK | 4 | 3 | 1 | · | · | · | · | · |
| UNTRACK | 11 | 6 | 5 | · | · | · | · | · |
| **total** | **1,105** | **327** | **915** | **24 (all empty)** | **5 (all empty)** | **22** | **0** | **0** |

Readings:

- **Columns 3 and 4 never carry nodes** — all 29 references resolve to empty
  chains — because an empty chain is their authored form. They are suppression
  latches; see §Columns 3 and 4 below for the engine derivation.
- **Column 5 is real and is the deferred continuation of its own slot** —
  fired by a runtime node another circumstance installed. 22 uses, three
  distinct shapes, all joined to their host instances:
  - MEGAPLE ×20 — Cracked (collision) → glass shatter.
  - MERQUER ×1 — slot 345, Counter `Count`=10 persistent on
    `Mdl_Building_SkyCorner2_2014`; column 5 flips `Mdl_Strike_Sign_2000`
    into a UV-scroll (sub-10 + main-type-9 V-offset).
  - PIPE ×1 — slot 9, Counter `Count`=24 persistent on
    `Mdl_Target_Stands_1001`; column 5 plays course-bank sound 82 then reveals
    36 `Mdl_FireEmitter_*` spaced by 0.2 s main-type-4 waits (the Pipedream
    flame wave).
- **MERQUER's 2 empty collision chains** are the trigger-driven sewer walls
  already described in spec:370-breakables — corroboration, not a new case.
- GARI, the level most of the early SSF decode was built from, authors
  **none** of columns 3–7, which is why the whole area read as dead.

The property-name evidence is independent in three ways:

1. the original name strings at ELF `0x0036c8a0..0x0036c9d4` mechanically map
   factory branches to subtype numbers;
2. the node constructors and virtual handlers establish behavior; and
3. slot → property → instance joins correlate the nodes with descriptive retail
   model names across five locally extracted maps.

## Columns 3 and 4 are suppression latches (2026-07-24)

Derivation for spec:150-slot-columns. Question the census could not answer from
authored data: is a column with only empty references an unused column or a
circumstance the engine never reaches? Settled by an exhaustive call-site
census of the only reader, `EffectSlotTable_ResolveField` `0x002603a8` — every
`jal` to it in the ELF, with the `a2` field immediate recovered from the delay
slot or the preceding twelve instructions:

| Field | Slot column | Call sites |
|---:|---|---|
| 0 | `PersistantEffectSlot` | `0x00260514` (`daddu a2,zero,zero`) |
| 1 | `CollisionEffectSlot` | `0x0013ab3c` `0x0013bda8` `0x0013f4f0` `0x001993f4` |
| **2** | **`Slot3`** | **`0x00260704` — one site** |
| **3** | **`Slot4`** | **`0x0013aa1c` — one site** |
| 4 | `EffectTriggerSlot` | `0x0013b1a8` `0x0013fedc` `0x0014562c` `0x00147ba8` |
| 5, 6 | `Slot6`, `Slot7` | **none** |

So columns 6/7 are genuinely dead, and 3/4 each have exactly one reader.

**Field 2 — on region deactivate.** The site is inside
`PersistentEffect_DeactivateCellInstances` `0x00260638`, the mirror of the
activation walker that reads field 0. Per instance in the deactivating cell
(skipped only when its registered node's `+0x14` is 5, a DeadNode tombstone):
field 2 ≥ 0 → `PersistentEffectThread_Create` `0x0013d540` on that header and
**branch past** the teardown; field 2 = −1 → if a node is registered, call its
vtbl `+0xbc` (`AnimNode_OnDeactivate_Teardown` `0x001996f8`: restore instance
flag word `+0xe8` low half from its high-half backup, `or 0x2`, then destruct →
model reverts to bind pose, clip phase lost). Column 3 is consulted for **every**
instance in a deactivating cell, registered node or not.

**Field 3 — on node self-end.** `EffectNodeBase_TryHandoffToSlot4` `0x0013aa00`
resolves field 3 on the node's bound entity: populated, it starts a thread there
and the **node survives**; empty, the node runs its class's normal end — restore
instance flags, destruct. Every node class shares that rule (all seven `+0xb4`
overrides route through this one helper), so a populated column 4 keeps a prop
animated instead of returning it to rest, whatever kind of node it is.

`MainType 10` (`0x0013c0b8`) reaches the same virtual with `a1` = payload `U0`,
which corrects its earlier "pause/resume" reading: it is "end the installed
node", `U0` choosing whether the column-4 handoff is allowed. Authored-zero.

**How an `AnimObject` self-ends.** A play-once clip (loop mode 0) stops exactly
at its last frame rather than running past the window, and marks itself ended
(`AnimObjectNode_Update`, clip-end block `0x00199624`). That mark is what
triggers the handoff, and because the node checks it before doing anything else
the handoff fires **exactly once** — a node parked at its last frame does not
churn a thread per frame.

**Why empty is the authored form.** A populated column is answered with
`PersistentEffectThread_Create`, and a zero-node header finalizes on its prime
tick (`EffectThread_FinalizeAndFree`), so an empty chain costs one alloc/free
and nothing else. The sentinel thread also cannot displace the instance's
registered node — `CollisionEffectNode_Construct` `0x0013b8c8` records the
entity on the *node*, not the node on the entity. Empty is therefore the
minimal legal "yes" — the 29 empty references are the mechanism.

**Authored joins.** ELYSIUM slot 34 holds `Mdl_Elys_Door_5000` (instance 3851)
and nothing else: persistent −1, collision −1, `Slot3` = 97, `Slot4` = 98, both
zero-node. The ten `Mdl_Trigger_iristrigger_500N` volumes are on slot 35, whose
collision header 99 is `MainType 7` "play effect 100 on 3851" = `Sub256` with
`U0 = 0`, play-once. Effect 98 latches the door at the fully-open frame; effect
97 keeps it open when the region deactivates. MESA slot 102 holds
`Mdl_TreeTrunk_EvergreenB_Fall_0/1` with `Slot3` = 220 zero-node and
`Slot4` = −1 — the trees are played by `Sub257` `AnimDelta` effects 226/227
(`MainType 3` grants of 107 and 84 frames), and an `AnimDelta`'s update gates
the clock on `node+0xc` and jumps to the eval-only tail once the budget is
spent, so it never reaches the clip-end block and column 4 is unreachable for
it. That is why the door — a free-running `Sub256` — is the corpus's only slot
populating both columns.

Verified locally since (ALASKA/ALOHA/MEGAPLE joined the `Maps/` extraction):
ALASKA's one column 3 is `Mdl_WindDebrisEmitter_5000`; MEGAPLE's twenty are the
`Mdl_Glass_Pane_*` panes, whose shattered state is exactly what column 3
preserves; ALOHA's one column 4 is `Mdl_BarrierDynamic_KickerAnimated_2001`.
All twenty-two are the empty sentinel the census predicted. **PIPE column 3 and
SSXFE column 4 remain unverified** — those two SSFs are still absent locally.

## UVScroll modes and timing

The six-word Sub10 payload is now closed by the native constructor/update,
superseding the old axis-length guess:

| Field | Runtime meaning |
|---|---|
| `U0` | mode: 0 linear, 1 eased ping-pong, 2 constant-speed ping-pong |
| `U1` / `U2` | horizontal / vertical UV advance per 60 Hz tick |
| `U3` | active interval in seconds |
| `U4` | pause interval in seconds |
| `U5` | total lifetime in seconds; zero has no countdown |

`UVScrollNode_ConstructFromEffectPayload` 0x00141FF8 reads `U5` as a float,
multiplies it by 60, rounds it to the node-frame countdown, and copies `U0`–`U4`
into the state. `UVScrollNode_Update` 0x001422E8 increments its phase by 1/60.
At `U3` it resets phase, enters the `U4` pause when positive, and negates U/V
rates for exact modes 1 or 2. Exact mode 1 scales each moving tick by
`min(phase, U3-phase) / U3`; mode 2 keeps the raw rate. Every other mode takes
the direct-add path. Both offsets wrap at ±1, independent of `U3`/`U4`.

Across the currently extracted ELYSIUM/GARI/MERQUER/MESA/SNOW course set, the
portable JSON census finds 103 mode-0 nodes and five identical mode-2 nodes
(`U=-0.00417`, `U3=0.5`, `U4=1.5`), one in each level. No retail mode-1 node is
present there; its semantics are established by executable code rather than a
shipped authoring example.

## Main-type 3/9 controls are receiver-dependent

The last apparently unknown nodes were commands such as `main.3` and `main.9`.
Disassembly shows both call vtable `+0xc4` on the one property node currently
installed on the bound instance. The payload command is not globally named; it
must be interpreted with the receiver:

| Receiver | Command | Semantic label | Retail use |
|---|---:|---|---|
| Counter | 1 | `counter.mark` | register a numbered strike/input |
| Counter | 3 | `counter.decrement` | decrement and, at zero, fire the trigger chain in column 5 of the Counter's **own** effect slot (spec:150-deferred-trigger) |
| UVScroll | 6 | `material.uv-offset-v` | set current V phase |
| TexFlip | 2 | `material.texture-frame` | countdown/start-light frame selection |
| AnimDelta | 2 | `animation.delta-grant` | grant kicker animation budget |
| AnimCombo | 3 | `animation.combo-trigger` | play the second clip window over the pose being held (§AnimCombo) |
| base handler | 7 | `instance.flag-0x800.clear` | clear runtime instance flag |
| base handler | 8 | `instance.flag-0x800.set` | set runtime instance flag |

The full command census is 89 type-3 command-2, 28 type-9 command-2, 26 type-3
command-3, 22 type-9 command-8, 20 type-9 command-7, 11 type-9 command-6, and
10 type-9 command-1 nodes. A single initially unresolved Megaplex command-3 was
in an unattached slot: its persistent circumstance installs AnimCombo and its
collision circumstance sends command 3, confirming `animation.combo-trigger`.
Aloha authors the same pair on five attached barriers, and §AnimCombo below
decodes what the command does.

Relevant implementations are `EffectNodeBase_ControlOp` 0x0013aa50,
`CounterNode_ControlOp` 0x0013b2f8, `UVScrollNode_ControlOp` 0x00142950,
`TextureFlipNode_ControlOp` 0x001433e0, `AnimObjectNode_ControlOp` 0x00199d48,
AnimDelta control 0x0019a3a8, and `AnimComboNode_ControlOp` 0x0019a7c8.

## Remaining honest unknowns

- Main type 1 constructs a real node, but its role is still unidentified and it
  is not authored in the retail corpus.
- Several live-but-unauthored property constructors have unresolved payload
  layouts or field meanings despite having trustworthy engine names.
- `U7 = 3` on every authored sub-257 and sub-258 node. The constructor tests
  only for 4 (reversed), so 3 behaves as "forward" — but nothing says it MEANS
  forward rather than being an unread third value.
- A main-type-3/9 command outside a provable slot/instance receiver flow must
  remain `node.control.command-N`; guessing from the numeric command alone would
  be wrong.

These boundaries let Slopesmith show useful names without weakening the raw,
round-trip-safe representation.

### AnimCombo (sub 258): decoded (2026-08-11)

Closed. The node is an **AnimObject carrying a second window of the same model
clip**, played once by control command 3 and composed onto the pose the prop is
holding. Derivation for spec:230-anim-combo and spec:150-anim-combo.

**Where the entry points led.** The prior note located the vtable `0x0038d6d0`
(installed at `node+0x54`, not offset 0), the destructor `0x0019a6a0`, and two
further vtable-installing sites `0x0019a468` / `0x0019a5d4`. The second of those
is the copy constructor (function start `0x0019a5a0`); the first is the tail of
the real constructor, whose start is **`0x0019a418`**.

**The first eight words are not the node's own.** The constructor opens by
calling `AnimObjectNode_Init` `0x00198d08` with `a0 = node+0x1c`, `a2 = 258` and
the payload in `t0` — the same init sub 256 and sub 257 use. So the sub-258
record is the sub-256 record plus four, at the same offsets, whatever
SSFHandler.cs declares them as (it types 257/258 differently from 256; the
engine does not). Offsets calibrated against `UVScrollNode_ConstructFromEffectPayload`
`0x00141ff8`, whose field meanings were already closed: the node begins
`MainType`/`ByteSize`/`SubType`, so `U0` is at `+0x0c`.

| Field | Off | Runtime meaning |
|---|---|---|
| U0 | +0x0c | loop mode, read `lhu` — 1 wrap, 2 ping-pong, else once |
| U1 | +0x10 | idle window start, 30 fps frames; `<0` → 0 |
| U2 | +0x14 | idle window end, frames; `<0` → the model's `AnimTime` |
| U3 | +0x18 | idle rate; 30 = realtime |
| U4 | +0x1c | random-rate upper bound; `0.0` takes U3 straight, else `rand(U3,U4)` |
| U5 | +0x20 | **collision re-fire debounce, seconds** (×60 → ticks) |
| U6 | +0x24 | random start phase flag |
| U7 | +0x28 | `== 4` plays reversed |
| U8 | +0x2c | **combo window start**, frames; `<0` → U2 |
| U9 | +0x30 | **combo window end**, frames; `<0` → the model's `AnimTime` |
| U10 | +0x34 | **combo rate**; 30 = realtime |
| U11 | +0x38 | **end behaviour, read for its SIGN** |

**U5 is a debounce, and that is new for sub 256/257 too.** It was the last
unnamed word of the shared record. `AnimObjectNode_Init` stores `U5 × 60` at
obj+0x18, which is the RELOAD value for the counter at obj+0x1c;
`0x001993d0` bails while that counter is non-zero and otherwise resolves
`EffectSlotTable_ResolveField(obj+0x58, field 1 = CollisionEffectSlot)` at
`0x001993f4` — one of the four collision-column call sites already censused in
§Circumstance-column census — and reloads it. `0x00199528` steps it down once
per eval. So an AnimObject-family node runs its host's own collision chain with
a built-in re-fire interval, and U5 is that interval.

**The two fallbacks differ, and the difference is the design.** A negative combo
START falls back to U2, the IDLE window's end — "carry straight on from where
the loop stops" — while a negative combo END falls back to the clip length, the
same fallback U2 itself takes. Retail spells both out anyway.

**What command 3 does** (`AnimComboNode_ControlOp` `0x0019a7c8`), finishing the
half the prior note left open: it refuses when the u16 at `node+0x18` is
non-zero — that halfword covers BOTH state bytes, the running flag and the
latch, so a spent one-shot cannot be re-armed — then walks the bound model's
sub-object list (`[node+0x74]+0xc0` → count `+0x04`, entries `+0x08`, stride 24,
skipping entries whose `+0x10` is null) copying a 64-byte 4×4 matrix per live
part from `[node+0x7c] + i*208 + 0x90` into `[node+0x84] + i*64`. It then sets
`node+0x0c = node+0x10` (the combo clock to the window start) and marks active.
The prior note's guess was right: `node+0x78` is the live part count and
`node+0x84` the saved-pose array — both set by the shared init.

**Update** `0x0019a710` (vtbl+0x14):

- `node+0x19` (latched) → `0x00199528` only, the eval-without-advance path;
- `node+0x18` clear → ordinary `AnimObjectNode_Update` `0x00199550`;
- active → eval the base object without advancing it, then
  `node+0x0c += node+0x08`; at `node+0x14` clamp, clear active, and set the
  latch if `node+0x1a` — **in that order, before the apply** — then dispatch
  vtbl+0xe4.

**Apply** `0x0019a970` (vtbl+0xe4): with the combo active, or latched and
`node+0x1b`, evaluate every part's curve at the combo clock and then
`part.matrix = saved × part.matrix` through the VU0 4×4 concat `0x001cbb50`
(a0 = the part, a1 = the saved matrix; it reads `a0+0x90`, multiplies, and
writes back there). Otherwise the ordinary base apply `0x00199750`.

That composition is the whole of what "combo" means here: the second window is
applied **relative to the pose at trigger time**. A window authored to start at
identity therefore joins seamlessly, and one authored with motion of its own
would double it.

**U11's three behaviours** fall out of the two bytes the constructor derives —
`node+0x1a = (U11 != 0)` decides whether the end latches, `node+0x1b = (U11 < 0)`
decides whether a latched node keeps drawing the combo pose:

- `0` — resume the idle loop; re-triggerable. (The only authored value.)
- `>0` — latch: the idle clip stops advancing and the pose reverts to it.
- `<0` — latch holding the last combo frame.

**Corpus.** Two nodes, ALOHA effect 227 and MEGAPLE effect 80, byte-identical:
`U0=2 U1=0 U2=60 U3=30 U4=0 U5=1 U6=1 U7=3 U8=61 U9=100 U10=30 U11=0`.

**The authored join, which is what closes it.** ALOHA slot 37 —
persistent 227 (install), collision 228 = one `MainType 3 {command 3, 0.0}` —
carries five `Mdl_BarrierDynamic_SideToSide_*` placements (instances 686, 1788,
1799, 1816, 1817; ModelIDs 241 and 467). MEGAPLE's copy sits in an unattached
slot, which is why the earlier census could only say "its persistent
circumstance installs AnimCombo and its collision circumstance sends command 3".
ALOHA was not in the local `Maps/` extraction when that was written.

The model agrees to the last digit. `Mdl_BarrierDynamic_SideToSide_4001` has
`AnimTime 100.0` = U9, two ModelObjects (an identity root and one animated
child) and `AnimationAction 9` = bits 0 and 3, so translate-X and rotate-X:

| Channel | Segment span | Value |
|---|---|---|
| translate-X | 0.0 → 2.002 s | −430 → +430 cm, then crashed to 0 by 2.0387 and held |
| rotate-X | **2.0333333** → **3.3333333** s | 0° → −90° by ~2.17, held, back to 0 at the end |

2.0333333 is 61/30 = U8; 3.3333333 is 100/30 = U9. So the idle window (0–60
frames, ping-pong, realtime, random start) is the side-to-side slide, and the
combo window (61–100, once, realtime) is the barrier being knocked flat and
popping back up. The combo window's own translation is authored at ZERO, which
is exactly what the composition needs: the snapshot supplies the slide offset
and the reaction supplies the rotation, so the barrier falls over where it
stands. Read absolutely it would teleport to the middle of its travel first.

**Not measured on hardware.** The reading is disassembly plus an authored join
whose numbers agree exactly. Both corpus nodes are byte-identical, so nothing
shipped exercises a non-zero U11, a negative window bound, or a non-30 combo
rate; those three are read from the constructor and the update alone.

**Still open.** `U7 = 3` on both nodes — not 4, so not reversed, but 3 is not
obviously a default either; the constructor only ever tests for 4. The same
value appears on retail's sub-257 nodes.
