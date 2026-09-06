# 150 — Logic

An object's dynamic behavior — boost pads, breakables, fireworks triggers,
scrolling textures, swinging bridges, the start-gate sequence — is not encoded
on the instance. The instance's properties record points at an **effect slot**,
and the effect slot points into the level's **logic graph**: a pool of **effect
chains** built from typed **nodes**. This chapter defines that graph's data
model. The on-disc encoding is in `230-level-ssf.md`; the behaviors the nodes
produce are specified where each behavior lives — world interaction
(`370-world-interaction.md`), pickups and race events (`390-pickups-and-race.md`),
texture animation (`410-texture-animation.md`), particles (`180-particles-data.md`),
and audio (`190-audio-data.md`).

## The effect slot

An instance reaches the logic graph through a two-step indirection: the
instance names a properties record (`120-objects.md`), and the properties record
holds an **effect-slot index** (or −1 for "no logic"). The named **effect slot**
is a bundle of up to seven references into the chain pool, each a different
**circumstance** under which its chain runs. Five circumstances are
established: [[150-slot]]()

- a **persistent** chain — runs when the instance's surrounding world-grid
  region ACTIVATES (ambient model animation, UV scroll, an always-on particle
  emitter — the snow cannons). Regions activate around every racer *and the
  camera* (the pre-race flyby wakes course cells as it pans); the chain runs
  **once** per activation as a short-lived thread, and the runtime nodes it
  installs (animation players, scrollers, emitters) live on until the region
  deactivates — one beat after everyone leaves — which destroys them and
  reverts the model to its rest pose. Re-approach re-creates them fresh, so a
  persistent effect is continuous *while the area is populated*, not from
  level load. [measured]
- a **player-collision** chain — runs when the rider contacts the instance
  (break, boost, trigger payload).
- a **region-deactivate** chain — runs when that same world-grid region
  DEACTIVATES, and runs *instead of* the default teardown. With the column
  empty the engine destroys whatever runtime node the instance is carrying and
  restores the instance's saved render flags, so the model snaps back to its
  bind pose; with the column populated the teardown is skipped and the
  instance keeps its node and its current pose. [measured]
  [[150-slot-columns]]()
- a **node-end** chain — runs when a runtime node installed on the instance
  reaches its own end and asks to be retired, and again runs *instead of* the
  default. With the column empty the node restores the instance's saved flags
  and destructs; with the column populated the chain runs and the node is left
  alive, holding its final state. A **play-once** model animation is the
  authored case: it clamps at its last frame and then ends exactly once.
  [measured] [[150-slot-columns]]()
- a **deferred-trigger** chain — the only circumstance with no external event
  of its own. It is the continuation that a *runtime node installed by the
  persistent or collision chain* fires when that node's own condition elapses.
  Two installers are authored: the **count-down timer** a persistent chain
  places, which fires the trigger chain when its count runs out [measured],
  and the **crack** handler a collision chain places on a fragile surface,
  which fires it when the surface finally gives way [measured]. The two are
  the same mechanism reached from two conditions: each holds a quantity that
  its own Update walks down, and each resolves circumstance column 5 on its
  own instance and runs that chain the moment the quantity is spent. The
  chain itself then does ordinary work — play a sound, kill the
  source, flip hidden instances visible, start an animation — so the
  circumstance is a *scheduling* mechanism, not a new kind of action.
  [[150-deferred-trigger]]()

Because the reference is indirect, many instances can share one slot (every
speed-boost pad points at the same one). [[150-slot]]()

The region-deactivate and node-end circumstances are **suppression latches**.
The engine asks only whether the column is populated; whatever chain it names
runs *in place of* the revert, not in addition to it. Because a chain with zero
nodes finishes on the tick that starts it, an **empty pool entry is the cheapest
way to answer "yes"** — and every one of the 29 references to these two columns
in the retail corpus is empty. They are the mechanism, not residue: an instance
whose changed state has to outlive the event that caused it is authored exactly
this way, and a port that ignores them puts the state back. [measured]
[[150-column-census]]() [[150-slot-columns]]()

The Elysium iris door is the worked example and the only slot in the corpus to
populate both. It carries no persistent and no collision chain of its own; a
separate slot of trigger volumes plays a **play-once** model animation on it.
Its node-end column keeps the door latched at the fully-open frame instead of
destructing back to the closed bind pose, and its region-deactivate column
keeps it open after everyone leaves. Mesa's pair of falling tree trunks author
the region-deactivate column the same way, and only that one — their animation
is budget-gated rather than free-running, so it never self-ends and the node-end
circumstance can never be reached. [measured] [[150-slot-columns]]()

The two remaining columns are dead. Nothing in the corpus references them and
**no engine path reads them**, so they carry neither authored nor latent
behavior. [measured] [[150-slot-columns]]()

The slot reference alone is not sufficient to fire a collision chain. The
instance must first produce a successful native shape contact: `PlayerCollision`
must be set and its `CollsionMode` must resolve a real proxy, AABB, or physics
body (`130-collision-data.md`). Visibility is not part of that gate, and `U0=0`
keeps the contact eligible while suppressing the solid response.
[[150-collision-eligibility]]()

On contact, the collision chain does not run in place — the engine builds a
disposable copy of the same per-frame chain-walker the persistent chain uses,
seeded with the contacted instance's `CollisionEffectSlot` header, and runs it
immediately. The instance holds that spawned node in one live-node slot. While
the node remains alive, later contact walks reuse/no-op that slot rather than
constructing the chain again. The chain re-arms only when the node reaches its
end and its destructor clears the slot; leaving the contact shape does not
clear it. Authored waits and `Debounce` therefore control the effective
re-fire interval, and an infinite debounce can keep the chain fired once for
the rest of the instance lifetime. There is no universal frame-count cooldown
on this contact path. A separate self-repeating node family does use a
30-frame gate, but that gate is not collision-chain debounce.
[[150-dispatch-runtime]]()

> [[150-slot]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> struct `EffectSlot` = 7 int refs; `Slot1` = `PersistantEffectSlot`, `Slot2`
> = `CollisionEffectSlot`, `Slot5` = `EffectTriggerSlot`; the rest unnamed —
> the three names are corpus-confirmed (see [[150-column-census]]()), and
> `Slot3`/`Slot4` are named by the engine paths that read them
> ([[150-slot-columns]]()).
> Instance join: `ObjectProperties[InstanceState[i]].EffectSlotIndex` →
> `EffectSlots[]`, doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs.
> Collision chain fully traced (db:sign-break, db:course-boost); persistent
> chain observed on the bridge, boost pads, and the Snowdream snow cannons /
> flares / lanterns (a persistent particle emitter, `180-particles-data.md`)
> (db:anim-object, db:course-boost).

> [[150-slot-columns]]() db:effect-slot-columns;
> doc:../research/effects-semantic-names.md §Columns 3 and 4 —
> exhaustive census of the 11 `jal EffectSlotTable_ResolveField` (`0x002603a8`)
> sites with every field immediate recovered: field 0 persistent `0x00260514`;
> field 1 collision `0x0013ab3c` `0x0013bda8` `0x0013f4f0` `0x001993f4`;
> **field 2 (`Slot3`) `0x00260704` only**; **field 3 (`Slot4`) `0x0013aa1c`
> only**; field 4 trigger `0x0013b1a8` `0x0013fedc` `0x0014562c` `0x00147ba8`;
> **fields 5/6 zero sites**. Field 2's site is inside
> `PersistentEffect_DeactivateCellInstances` `0x00260638`: populated →
> `PersistentEffectThread_Create` `0x0013d540` and skip the teardown; −1 →
> node vtbl+0xbc (`AnimNode_OnDeactivate_Teardown` `0x001996f8`, which restores
> the instance flag word `+0xe8` low half from its high-half backup and
> destructs). Field 3's site is `EffectNodeBase_TryHandoffToSlot4`
> `0x0013aa00`, called by all seven class overrides of virtual `+0xb4`
> ("end this node", `a1` = allow-handoff), each shaped
> `if (a1 && TryHandoff(this)) return;` before its default end; `MainType 10`
> reaches the same virtual with `a1` = `U0`. `AnimObject`'s vtable
> `0x0038d8c0+0xb4` is the base override `0x0013a988`;
> `AnimObjectNode_Update` `0x00199550` clamps a loop-mode-0 clip at its window
> end, sets `node+0x10`, and calls `+0xb4` with `a1=1` — and early-outs on
> `node+0x10` at its head, so it fires exactly once. A zero-node header
> finalizes on its prime tick (`EffectThread_FinalizeAndFree`), and
> `CollisionEffectNode_Construct` writes only `node+0xe4`, so the spawned
> sentinel thread cannot disturb the instance's registered node. Authored
> joins: ELYSIUM slot 34 = `Mdl_Elys_Door_5000` (inst 3851) alone,
> `Slot3`=97 `Slot4`=98 both zero-node, opened by slot 35's ten
> `Mdl_Trigger_iristrigger_500N` volumes → header 99 = `MainType 7` play
> effect 100 = `Sub256` `U0=0`; MESA slot 102 =
> `Mdl_TreeTrunk_EvergreenB_Fall_0/1`, `Slot3`=220 zero-node, `Slot4`=−1,
> played by `Sub257` `AnimDelta` effects 226/227 whose update gates the clock
> on `node+0xc` and never reaches the clip-end block.
> db:effect-slot-columns; derivation in
> doc:../research/effects-semantic-names.md §Circumstance-column census.
> Both columns measured on hardware, 2026-08-06, GARI/AUTOTEST2 under
> `tools/autotest`, each as a latched cell against an unlatched control
> carrying the identical chain one field uphill — three passes, byte-identical
> in all three. Field 2 (`Slot3`), cells `latch-persist-region` /
> `latch-persist-control`: a persistent `Flag` (sub 13) installs ahead of the
> rider on both; the control's `instance+0xe4` empties and `+0xe8` reverts
> `0x00a101a5` → `0x00a100a3`, while the latched slot NEVER empties and its
> flag word settles at `0x00a100a5` — the node and the `0x04` it set are kept
> and only the `0x0100` region bit clears. Same column with a breakable kill,
> cells `latch-kill-region` / `latch-kill-control`: both hide the prop
> (`0x00a101a3` → `0x00a10105`, slot sub-type 1006), the control is restored to
> `0x00a100a3` when its node goes, the latched one ends at `0x00a10005` with
> the slot still occupied — the prop stays hidden. Field 3 (`Slot4`), cells
> `latch-flip-end` / `latch-flip-control`: the ride-over button's `TexFlip`
> pulse (authored `Length` 0.5) self-ends, and the control builds and releases
> **three** nodes over 2.6 s where the latched cell builds **one** that holds
> the slot for 10.6 s. Re-measured on the authored case the column exists for —
> a play-once `AnimObject`, cells `clip-once-latched` / `clip-once-plain` /
> `clip-model-loops`: the latched cell holds a sub-256 node whose clip-finished
> flag (allocation `+0x10`, i.e. −0x20 from the registered sub-object) reads 1
> and whose slot never releases, while the unlatched cell releases in every pass
> and is never once caught with that flag set — the node is destroyed on the
> tick that sets it. A `LoopMode` 1 clip on the same model never sets the flag
> at all, which is what makes it a reading rather than a coincidence.
>
> Those passes ran on GARI's `Gem_TrickMultiplier` (`ModelID` 269), whose clip
> reaches the runtime with a play window of **zero** — the donor declares
> `AnimTime 60`, the borrow path does not carry it. So the play-once end being
> measured arrives on the node's first tick rather than after a clip, and what
> the passes establish is the COLUMN's behaviour at an end, not a clip playing.
> The distinction does not weaken the latch reading: field 3 acts on the
> self-end signal, and a zero-length clip raises it like any other. Reading a
> non-zero window at all needs the imported-prop path (cell
> `clip-real-keyframes`, window 1.3333 s from 40 authored frames). `latch-kill-end` shows the complement — field 3 does
> nothing for a kill (identical to its control in all three passes), because
> the tombstone never reaches a self-end and so never consults the column.
> Which latch an authored effect needs is therefore decided by how its node
> ends, not by what the effect does.

> [[150-deferred-trigger]]() doc:../research/effects-semantic-names.md
> §Circumstance-column census — all three authored uses of column 5, each
> joined end-to-end from the slot to the affected instances. Both installers
> are disassembly-traced: the Counter's fire of column 5 in
> `230-level-ssf.md` [[230-logic-nodes]](), and the Cracked node's in its
> Update `CrackedNode_Update` @0x001455a8, which on `node+0x3c ≤ 0` calls
> `EffectSlotTable_ResolveField` @0x002603a8 with **field 4** — column 5 —
> against its own instance, and hands the resolved header to
> `CollisionEffectNode_Construct` @0x0013b8c8, the same constructor a contact
> uses, so the chain runs that frame. A slot with column 5 absent resolves
> −1 and the node retires instead (`0x0013abf8`), which is the whole of what
> an unfinished crack does. The node payload is `230-level-ssf.md`
> [[230-cracked]](). **The two installers differ in what may go in the
> column they fire**, and it is a lifetime difference rather than a
> convention: the Counter fires column 5 *and then retires*, so a chain that
> installs on the same instance pulls the counter out from under itself,
> while the Cracked Update returns without touching a member after the call
> and leaves the node alive. That is why twenty Megaplex panes can put a
> self-kill and three reveals in a Cracked-fired column while the corpus's
> one Counter-fired column carries a single hop.
> Live evidence for the crack half: `Trailmap/tools/autotest`, runs
> 20260807-075619, -075854 and -080130, cells `cracked-shatters` /
> `cracked-tough`. Both author the same collision chain and the same column-5
> hop onto a companion prop that carries no chain of its own and that the
> rider never approaches, so a node in the companion's slot has exactly one
> possible sender. The companion beside the strength-0.1 surface held one in
> ALL THREE passes; the companion beside the identical strength-1000 surface
> held one in NONE. The column fires where the pool is spent and nowhere else.
> Choosing that instrument was itself a finding: a bound-node command is the
> obvious payload and cannot answer the question, because the Cracked node is
> what such a command addresses and its control method (`230-level-ssf.md`
> [[230-cracked]]()) answers to two parameters only — so a column that fired
> correctly would read as one that never ran.
> **Crack installer**
> (MEGAPLE ×20, the `Mdl_Glass_Pane_*` panes): collision = Cracked (type-0
> sub 14, payload `U0`=−1 `U1`=5 on all twenty) + a crack sound; column 5 =
> shatter sound, a sub-5/dead-mode-2 self-kill, and main-type-7 flips of the
> pane's hidden `Mdl_Glass_Surface_*` / `Mdl_Glass_JunkA_*` twins (14 slots
> flip two, 6 flip three). **Counter installer** (2 slots, the corpus's only
> Counter nodes): MERQUER slot 345 on `Mdl_Building_SkyCorner2_2014`,
> persistent Counter `Count`=10 `U1`=−1.0, column 5 flips
> `Mdl_Strike_Sign_2000` into a UV-scroll (sub-10 + main-type-9 V-offset);
> PIPE slot 9 on `Mdl_Target_Stands_1001`, persistent Counter `Count`=24
> `U1`=0.0, column 5 = course-bank sound 82 then 36 `Mdl_FireEmitter_*`
> reveals spaced by main-type-4 waits of 0.2 s each — the Pipedream flame
> wave. Both installers fire the trigger chain of **their own slot**, not
> another instance's (`230-level-ssf.md`).

> [[150-column-census]]() doc:../research/effects-semantic-names.md
> §Circumstance-column census — over all 12 retail course SSFs
> (`230-level-ssf.md` writer-conformance corpus), slots populated per
> column / of which the referenced chain has zero nodes: col1 persistent 327,
> col2 collision 915 (MERQUER 2 empty — the trigger-driven sewer walls,
> `370-world-interaction.md`), col3 24/**24 empty** (ALASKA 1, ELYSIUM 1,
> MEGAPLE 20, MESA 1, PIPE 1), col4 5/**5 empty** (ALOHA 1, ELYSIUM 1,
> SSXFE 3), col5 trigger 22 all non-empty (MEGAPLE 20, MERQUER 1, PIPE 1),
> col6 0, col7 0. Method: `snowknife effects-export` per retail SSF, then a
> slot→graph join counting nodes behind every circumstance reference.

> [[150-collision-eligibility]]() spec:130-contact-state; db:collision;
> mode/gate disassembly and the authored mode-1 trigger isolation are cited by
> `130-collision-data.md` `[[130-contact-state]]` and
> `[[130-authored-trigger]]`.

> [[150-dispatch-runtime]]() map:"Collision-trigger dispatch:
> `EffectSlots[].CollisionEffectSlot` resolved and run" —
> `EffectSlotTable_ResolveField` `0x002603a8` (field 1 = `CollisionEffectSlot`)
> → `EffectHeaderTable_ResolveByIndex` `0x002603e8` → `CollisionEffectNode_Construct`
> `0x0013b8c8` installs the header on a transient node reusing
> `EffectThread_Tick`'s own cursor/timer/header fields and runs it that frame.
> `CollisionEffectNode_GetOrCreate` `0x0013bd48` reads the live node at
> `entity+0xe4`; construction attaches it there, and destruction clears it.
> Full call-site and lifetime sweep:
> doc:../research/prop-collision-semantics.md "Collision-effect re-fire rule".
> The two 30-frame gates (`0x00142698`, `0x00143380`) call the separate
> `SpawnFromContactResult` path `0x0013ab00`; their owning repeat-node class
> remains open and they are not the contact walk's re-fire mechanism.

## Effect chains and nodes

An effect chain is an ordered list of **nodes**. Each node begins with a
**main type** (an integer opcode) and a size, followed by a type-dependent
payload. At run time the engine walks a chain and dispatches each node by its
main type through a fixed jump table of a couple of dozen entries; an out-of-range
main type is inert. [[150-dispatch]]()

The pool comes in two parallel stores: **anonymous chains**, referenced by index
(what effect slots point at), and **named functions**, referenced by index *and*
carrying an authored name — reusable scripted sequences such as the per-screen
"break" routines and the start-line countdown/mode sequence. A node can call a
named function (see the dispatch table), so chains compose. [[150-stores]]()

A called body is not run inline. The main-type-21 handler allocates a fresh
240-byte effect thread, hands it the CALLING thread's owner, and points it at the
function; the calling chain carries straight on. Both halves of that are measured
on an authored level: a call whose body held a single main-type-7 hop put a node
on an instance 130 m away on the sample the caller fired, and a call whose body
held only a speed pad wrote the authored 5.0 into the triggering rider's boost
request, three passes of three. Passing the owner down is the whole difference
between this opcode and **26**, which does the same construction with the owner
argument zero. [measured] [[150-call-runs]]()

**The name is load-bearing, not documentation.** The engine also reaches a level
function by NAME: `SsfFunctionTable_FindByName` walks the function table
comparing the 16-byte name field and returns its index, and
`SsfFunction_RunByName` runs whatever it finds on a fresh effect thread with **no
owning rider** — the same allocation and construct tail main type 21 uses, with
the owner argument zero. Nineteen call sites reach it, among them the game-mode
switch, which dispatches the literals `FreerideMode`, `RaceMode` and
`ShowoffMode`. So a level's own chains can be invoked by the engine on its
schedule rather than by a collision, and which ones is decided by what they are
called. A function whose name matches nothing is simply never found (-1).
[measured] [[150-by-name]]()

Three consequences for anything that writes a function table. A name is matched
by `strcmp`, so it needs its terminating zero inside the 16 bytes — 15 characters
is the real limit, and the level writer pads without terminating. The scan
returns the FIRST match, so a table carrying two functions of one name has one
that can never be reached this way. And a name is a behavioural choice rather
than a label, which is why a tool that rewrites a level's functions should
preserve it exactly.

> [[150-dispatch]]() map:"SSF effect-node opcode dispatcher and the
> logo break" — `EffectPayload_OpcodeDispatcher` 0x0013bfd8 reads the node's
> main type, bounds-checks < 27, and jumps via the 27-entry table 0x0036c830;
> node = `MainType` int + `ByteSize` int + payload,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `LoadEffectsData`. db:sign-break; db:course-boost.

> [[150-stores]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `EffectHeaders[]` (anonymous, `EffectCount`+`Effects[]`) vs `Functions[]`
> (named, 16-byte `FunctionName`+`Effects[]`). GARI: 306 effect headers, 20
> named functions (`CountDownStart`, `RaceMode`, `HideStartGate`,
> `BreakLogo1000`…`BreakLogo7000`, …).

> [[150-call-runs]]() `EffectOpcode21_RunSsfFunction` 0x0013c450 — reads the
> node's `FunctionRunIndex` at `+8`, bails if negative, allocates 240 bytes
> (0x0023d8d0) and tail-calls the shared construct path 0x0013b980 with `a1=3`,
> `a2` = the index and `a3` = the calling thread's owner `s0+0xe8`; 26 →
> 0x0013c544 is the same tail with `a3=0`. Measured on the authored side by
> `Trailmap/tools/autotest` cells `call-function-hop` and `call-function-rider`,
> runs 20260807-230446 / -230633 / -230815 (AUTOTEST6, showoff): companion node
> at 129.8 m in 3/3, boost request 4.933 / 5.000 / 5.000 against an authored 5.0,
> re-read three seconds downhill at 1.95.

> [[150-by-name]]() `SsfFunctionTable_FindByName` 0x00261308 — linear scan of
> `level+0x14` (the SSF struct): count `+0x2c`, base `+0x30`, stride 24, name at
> `+8`, compared with `strcmp` 0x002fde78; returns the index or -1. That record
> is `230-level-ssf.md`'s `{u32 node count, u32 chain-relative offset,
> char[16] name}` exactly. `SsfFunction_RunByName` 0x0013bae0 — resolve, bail on
> negative, allocate 240 bytes (0x0023d8d0, `0xdeadc0de` fill) and enter the
> shared construct tail 0x0013b980 with `a1=3`, `a3=0` (no owner). 19 incoming
> calls; the mode switch's three thunks at 0x0011257c/0x00112588/0x00112594 pass
> `FreerideMode` 0x003656f8, `RaceMode` 0x00365708, `ShowoffMode` 0x00365718
> through the jump table at 0x00365730. The remaining callers' names are not
> enumerated here.

## Dispatch types

The established node main types are: [[150-types]]()

| Main type | Effect | Specified in |
|---:|---|---|
| 0 | a family of **property effects**, sub-typed (below) | various |
| 2 | a family of **particle emitters**, sub-typed | `180-particles-data.md` |
| 3 | **bound-node control message** — dispatch `{command, value}` to the property node currently installed on the instance; meaning is receiver-dependent (below) | this chapter |
| 4 | **wait** — a chain delay in seconds before the next node runs | this chapter |
| 5 | a **conditional gate** — continue or kill the chain on a speed / random-roll / human-rider / node-liveness test | this chapter |
| 7 | **act on a named instance** — show, hide, or play a sub-effect on another instance by index | `370-world-interaction.md` |
| 8 | **play a sound** from the course bank (the value is a direct course-bank slot) | `420-audio-runtime.md` |
| 9 | as main type 3, minus its missing-instance guard (both fall through silently on a missing node) | this chapter |
| 13 | trigger the **course reset** — re-place the rider on the race line | `390-pickups-and-race.md` |
| 14 | apply a **score multiplier** (showoff modes only; the chime is not gated) | `390-pickups-and-race.md` |
| 17 | **speed boost** (raises the rider's boost amount) | `360-speed-and-boost.md` |
| 18 | **trick boost** | `360-speed-and-boost.md` |
| 21 | **run a named function** | this chapter |
| 24 | **teleport** the rider near a named instance | `390-pickups-and-race.md` |
| 25 | toggle a **spline's** rail-riding candidacy | `140-paths.md` |

The dispatcher accepts more opcodes than the shipped data uses. Beyond the
table, real handlers exist for: **6** and **15** — fill the rider's boost
meter (int payload converted through the trick-score module, and a raw float,
respectively), **16** — a **time bonus** added to the run clock, all three
gated to the showoff game modes — the **same gate main type 14 carries**, so
the scoring opcodes are a family of four rather than a set of three plus an
ordinary one; **10/11** — pause/resume and tear-down ops
on a bound instance's installed property node (virtual companions of main types
3/9); **26** — run a named function *detached*, with no owning rider; **23**
— a two-float camera operation on the triggering player's viewport; and **1**
— a node constructor whose product is unidentified. None of these are
authored in the extracted levels, and dispatcher entries 12/19/20/22 are
wired to the inert default outright. [[150-types-open]]()

> [[150-types]]() jump table 0x0036c830, map:"SSF effect-node opcode
> dispatcher and the logo break": 4 → 0x0013c164 (delay-store onto the
> effect thread's wait timer, `+0x40`), 7 → 0x0013c2ec (act-on-instance,
> `LevelInstanceTable_ResolveByIndex` 0x00254f58, stride 0x100), 8 → 0x0013c38c
> (`SsfSoundPlay_QueueCourseBankSound` 0x00216ac0, group 2, raw slot,
> map:"SSF effect-graph sound (firework `SoundPlay`)"), 17 → 0x0013c408
> (db:course-boost), 18 → 0x0013c42c (db:course-boost), 21 → 0x0013c450,
> 24 → 0x0013c504, 25 → 0x0013c530; 5 → 0x0013c174 (`[[150-gate]]()`), 13 →
> 0x0013c3a8 → `Boarder_CourseResetEntry` 0x00118f18 (`390-pickups-and-race.md`;
> ResetZone volumes carry single-node `[13]` collision chains — MERQUER 29,
> GARI 20). Types 14/24 and payloads from
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `LoadEffectsData`; boost values doc:../research/extracted-data.md "Boost and
> scoring effects".

> [[150-types-open]]() Sweep of jump table 0x0036c830 (all 27
> entries), cross-checked against the bxtools dispatch table
> (bxtools `ssx2_world_logic.py` — its BoostMeterFill6/15, TimeBonus,
> and Reset names are hereby RE-confirmed; its "Camera" for type 1 stays
> unverified). 6 → 0x0013c2d8 → 0x0011e610 (int → score-module 0x00155b28 →
> `Boarder_AddBoostMeter` 0x0011b020); 15 → 0x0013c3e0 → 0x0011e960 (float →
> same); 16 → 0x0013c3f4 → 0x0011e8a8 (score-module call + adds f32 seconds
> to the run-clock field [0x00348e58]→+0x730→+0x1c→+0x14); all three gate on
> game-mode ∈ {3,5}. 10 → 0x0013c0b8 (bound node vtbl+0xb4, a1=U0 0/1), 11 →
> 0x0013c124 (vtbl+0xbc teardown when U0==0). 26 → 0x0013c544 (node-construct
> tail 0x0013bc80 as type 21 but a3=0 — no owner). 23 → 0x0013c4d4 (viewport
> via boarder+0x38 → 0x00181528, then 0x00177770(view, U1, U0×[+0x11c→+0xcc])
> into the camera module). 1 → 0x0013c048 → `EffectMainType1_NodeFactory`
> 0x0013d0c0 (200-byte node, ctor 0x00148220) — consumer real, product
> unidentified [open]. Authored census over ELYSIUM/GARI/MERQUER/MESA/SNOW:
> types 1/6/10/11/15/16/23/26 all zero.

### Bound-node controls (main types 3 and 9)

Main types 3 and 9 are not animation opcodes by themselves. Both resolve the
firing thread's bound instance, load the single property node installed on that
instance, and dispatch a `{u32 command, f32 value}` payload to the node's
virtual control method. When the bound instance carries no installed node,
**both** opcodes fall through silently; the one difference sits a level up —
type 3 also tolerates a thread with no bound instance at all, which type 9
assumes. The same command number therefore has different semantics for
different main-type-0 receivers. [[150-control]]()

The receiver/command combinations observed in the complete 12-level PAL corpus
are:

| Installed property node | Command | Operation |
|---|---:|---|
| `Counter` (sub 6) | 1 | mark the numbered input, and step the remaining count down with it |
| `Counter` (sub 6) | 2 | the same, but only if the input BELOW this one is already marked — an ordered variant, unauthored in the corpus |
| `Counter` (sub 6) | 3 | step the remaining count down without marking anything |
| `UVScroll` (sub 10) | 6 | set the current V offset/phase |
| `TexFlip` (sub 11) | 2 | select texture frame 0..8 |
| `AnimDelta` (sub 257) | 2 | grant animation time/budget in seconds |
| `AnimCombo` (sub 258) | 3 | play the node's SECOND clip window once, over the pose the prop is holding |
| any receiver using the base handler | 7 | clear instance status flag `0x0800` |
| any receiver using the base handler | 8 | set instance status flag `0x0800` |

The `AnimCombo` command is the one in this table that is a whole behaviour rather
than a state write, so it is worth stating in full. Sub 258 is an `AnimObject`
carrying a second window of the same model clip (`230-level-ssf.md`). The first
window free-runs as ordinary ambient motion; command 3 snapshots the matrix every
animated part is currently holding, rewinds a second clock to the start of the
second window, and from then on draws each part as **snapshot × the second
window's pose** — so the reaction is applied RELATIVE to wherever the idle
animation had reached, not from the clip's origin. The idle clock does not
advance while it runs. At the end of the window the node either resumes the idle
loop and re-arms, or latches; which of the three the authored last word chooses
is read from its SIGN. A command arriving while one is already running, or after
a latch, is refused. [[150-anim-combo]]()

Aloha's five `Mdl_BarrierDynamic_SideToSide_*` are the corpus's only attached
use and show what the composition buys. Their clip slides the barrier ±430 cm
over frames 0–60 and, over frames 61–100, rotates it flat and back with its own
translation authored at ZERO. Composed onto the snapshot, a barrier knocked over
mid-slide falls where it stands; applied absolutely it would jump to the middle
of its travel first. The trigger is the barrier's own collision chain — one
`MainType 3` node and nothing else — and the re-fire interval is the sixth word
of the sub-258 record, an `AnimObject`-family collision debounce authored at one
second (see `230-level-ssf.md`). [measured] [[150-anim-combo]]()

Instance status flag `0x0800` is not inert. A **spline mover** re-reads its host
instance every update and destroys itself the frame it finds the bit set — the
one consumer of that bit anywhere in the executable — so setting it on a moving
prop is a stop command, and an irreversible one, because clearing the bit again
cannot rebuild a destroyed node. The same update also ends the node when the
host's registered-node slot is empty, which is why the packer's mover preamble
parks a never-expiring debounce there. [[150-flag-0800-reader]]()

An authored mover **runs**, and its travel is the node's own word rather than
anything on the instance: the distance along the route advances by the authored
per-tick amount every tick and **wraps to near zero** on reaching the route's end
distance, while the host prop never moves at all. The mover is not reachable from
its host in either direction that instrumentation can normally take — the host's
registered-node slot holds the preamble's debounce, not the mover — so it has to
be found by the pointer it holds *back* to the host. [measured]
[[150-mover-live]]()

A counter that is marked or decremented to zero fires the **trigger column of
its own instance's slot** on its next update — not a separately configured
target. That is the whole of how column 5 is reached from a counter, and it
makes the counter the one authorable way to schedule a deferred chain: the
count is the condition and the trigger column is the continuation.
[[150-counter-elapse]]()

Each receiver also keeps the state its commands write **on the node itself**,
at fixed offsets. Those matter because nothing in this family except the two
instance-flag commands leaves a mark on the *instance*: without them a delivered
command is indistinguishable from a dropped one, and every operation in the
table above except 7 and 8 was unobservable for that reason.
[[150-control-state]]()

Other implemented receiver commands include UV-scroll speed, active/pause
duration and U/V phase controls (commands 1..6), texture-flip rate/select/advance/enable
(commands 1..4), and AnimObject hold/seek (commands 1 and 4). They are live
engine behavior but are not all authored in the retail corpus. A semantic tool
must keep the raw main type, command and value and only assign the specific
operation name when it can prove the installed receiver from the effect slot or
instance flow. [[150-control]]()

> [[150-control]]() Dispatcher `0x0013c070` (type 9 enters at `0x0013c084`)
> loads thread→bound instance→installed node and calls vtable `+0xc4`.
> Receiver implementations: `EffectNodeBase_ControlOp` 0x0013aa50 (commands
> 7/8 clear/set `instance+0xe8` bit 0x0800), `CounterNode_ControlOp` 0x0013b2f8,
> `UVScrollNode_ControlOp` 0x00142950, `TextureFlipNode_ControlOp` 0x001433e0,
> `AnimObjectNode_ControlOp` 0x00199d48, AnimDelta override 0x0019a3a8, and
> `AnimComboNode_ControlOp` 0x0019a7c8. The receiver-aware corpus census and
> model-name correlations are recorded in
> `../research/effects-semantic-names.md`; db:effects-control-semantics.
> Commands 7 and 8 measured on hardware, 2026-08-06, GARI/AUTOTEST2 under
> `tools/autotest` (cells `flag-set`/`flag-set-clear`, three passes each), on
> a `Debounce` receiver — whose vtable control entry is `EffectNodeBase_ControlOp`
> itself (node ctor 0x0013fbf8 installs vtable 0x0036dcf8, whose `+0xc4` holds
> 0x0013aa50). Command 8 set `instance+0xe8` bit 0x0800 on the same sample the
> receiving node was built and the bit SURVIVED that node's teardown; command 7
> on the same chain, one MainType-4 second later, cleared it. The handler takes
> its instance from `node+0x28`.

> [[150-anim-combo]]() Full runtime derivation in `230-level-ssf.md`
> [[230-anim-combo]]() — ctor 0x0019a418, Update 0x0019a710, ControlOp
> 0x0019a7c8, apply 0x0019a970, matrix concat 0x001cbb50, vtable 0x0038d6d0 at
> `node+0x54`. Authored join and the model cross-check (ALOHA slot 37 →
> instances 686/1788/1799/1816/1817; `AnimTime 100.0` against `U9 = 100`, and
> the rotate-X channel spanning exactly 61/30 s to 100/30 s) are recorded
> there and derived in doc:../research/effects-semantic-names.md §AnimCombo.
> Not measured on hardware: the reading is disassembly plus an authored join
> whose numbers agree to the last digit, and the two corpus nodes are
> byte-identical, so no shipped example exercises a non-zero end word.

> [[150-flag-0800-reader]]() `cSplinePathNode` Update 0x001fab98: loads the
> host from `node+0x78`, bails to the vtable `+0xc` destruct (`a1`=3) when
> `instance+0xe4` is zero OR `instance+0xe8 & 0x0800` is set, and only
> otherwise advances `node+0x50` (distance along the spline) by `node+0x4c`
> against the end distance at `node+0x74`. The only `andi ..., 0x0800` consumer
> in .text. Corroborated on hardware, 2026-08-06, GARI/AUTOTEST2 under
> `tools/autotest`: cell `flag-set-plain` sets the bit on an ordinary prop in
> all three passes (`instance+0xe8` 0x00a101a3 → 0x00a108a3/0x00a109a3) while
> `spline-mover-halt`, carrying the identical chain on a mover's host, never
> shows it — the mover's packed source instance reads undrawn (low bits `a0`
> against an ordinary prop's `a3`), so no contact reaches its chain at all.

> [[150-control-state]]() Node-local state written by each receiver's control
> method, read out of the handlers themselves. `CounterNode_ControlOp`
> 0x0013b2f8: remaining count `node+0x34` (s16, floored at 0 by the shared tail
> at 0x0013b4f4), marked-input mask `node+0x36` (u16, bit `1 << (value-1)` for
> f32 values 1.0..10.0) — so one 32-bit read at `+0x34` carries both halves as
> `mask<<16 | count`. Commands 1 and 2 both refuse an input already marked and
> then neither mark nor decrement; command 2 additionally requires bit
> `(bit>>1)` set unless the value is 1.0. `UVScrollNode_ControlOp` 0x00142950:
> commands 1/2 → rates `node+0x54`/`+0x58` (range −1.0..1.0), 3/4 → durations
> `+0x5c`/`+0x60` (0.0..60.0), 5/6 → live U/V phase `+0x3c`/`+0x40`
> (−4.0..4.0); a value out of range is dropped, and commands outside 1..6 tail
> into `EffectNodeBase_ControlOp`. AnimDelta override 0x0019a3a8: command 2
> computes `node+0x68 += value / 30.0` — the authored word is FRAMES at the
> 30 fps timebase and the stored budget is seconds — and every other command
> falls through to `AnimObjectNode_ControlOp` 0x00199d48.

> [[150-mover-live]]() Live evidence: `Trailmap/tools/autotest`, runs
> 20260806-185405/-185914/-190525 (AUTOTEST1, cell `spline-mover`, `--frames
> 14400`). Found by searching the heap for the host entity at `node+0x78`; of
> the candidates (3, 4 and 4 across the three passes) exactly one changes each
> time, at a different address each run. On it: `node+0x4c` constant 33.3333,
> `node+0x50` advancing 2000.3/2000.3/2007.2 units/s against the 2000.0 that
> rate implies at 60 Hz, `node+0x74` constant 12715.74, and `+0x50` wrapping
> from 12704.93 to 55.86 — inside one tick's advance of the end — in the two
> passes whose window happened to span a wrap. `node+0x40` reads 0 throughout,
> so the halt path was never taken. The host's own `entity+0x30` holds one value
> for the whole run, and its `entity+0xe4` holds a node whose `+0x78` is 0 —
> i.e. not the mover. The short window is required: a full-length pass ends by
> restarting, which replaces the level before the search can run.

> [[150-counter-elapse]]() `CounterNode` update 0x0013b180 reads `node+0x34`
> and, when it is not positive, calls `EffectSlotTable_ResolveField`
> (0x002603a8) with the instance from `node+0x28` and field immediate **4** —
> the trigger column, the same field the census attributes to column 5 — then
> dispatches the resolved graph through 0x0013d540. A −1 column short-circuits
> the dispatch. `Counter.U1` is a separate countdown at `node+0x38` stepped on
> the count-still-positive branch and disabled by the corpus-modal −1, which
> fails its `blez` guard.

### Conditional gates (main type 5)

A gate node either lets the walk continue to the next node or **kills the
whole chain** — the walker treats its failure return as end-of-chain and
frees the thread, so nothing after the gate runs that firing. There is no
hold-and-retry: the test happens once per firing. The payload's first word
selects the test: [[150-gate]]()

- **0 — speed filter**: continue only if the rider's speed passes an authored
  threshold; a second selector picks the direction — selector 0 is *at most*,
  compared in engine units per second; selector 1 is *at least*, with the
  threshold authored in **kilometres per hour** (the runtime scales it by
  100000/3600 into engine units per second); any other selector passes
  unconditionally, and a rider-less firing passes;
- **1 — random roll**: continue with authored probability (selector 0
  continues with probability p, selector 1 with 1 − p, any other selector
  always continues) — the shipped levels' workhorse: fireworks and
  ambient one-shots author p = 0.05–0.8 so only some activations fire;
- **2 — human rider**: continue only when the triggering rider is
  player-controlled — AI riders' contacts die at the gate;
- **3 — no live node**: continue only if the bound instance has no effect
  node currently installed — a don't-retrigger guard for chains that install
  players/animations.

> [[150-gate]]() inline at 0x0013c174 in the opcode dispatcher (jump table
> 0x0036c830[5]); mode from payload+8, selector +0xc (`lw` at `0x0013c1f0`/
> `0x0013c264`), threshold/probability f32 +0x10; speed = |velocity| from
> `boarder+0x150` (VU0 magnitude, `0x0013c1f4–0x0013c21c`); no rider → pass;
> selector 0 `c.olt.s f0(thr),f2(speed)` at `0x0013c22c`, `bc1f` → pass;
> selector 1 multiplies by `0x41de38e3` = 27.77778 = **100000/3600** at
> `0x0013c244` (km/h → cm/s) then `c.olt.s f2,f0` at `0x0013c258`; selector
> ≠ 1 `bne v1,a0` → pass at `0x0013c238`. Random `0x0023da18(0,1)`: selector 0
> `c.olt.s f1(p),f0(roll)` at `0x0013c288`, `bc1f` → pass; selector 1
> `c.olt.s f0,f1` at `0x0013c2c0`, `bc1t` → kill; selector ∉ {0,1} `bne` →
> pass at `0x0013c2a0`. Mode 2 reads `boarder+0x41c` (human flag, cf. the gem
> chime gate; no null-rider check); mode 3 reads instance→+0xe4 node slot;
> out-of-range mode → `0x0013c5b4` with v0=1 (pass). Return −1 →
> `EffectThread_FinalizeAndFree` 0x0013bd28. Census over 12 SSFs: 453 nodes —
> 62 random (p 0.05–0.8, all selector 0, MESA/SNOW), 390 mode-3 (MERQUER
> 387, SNOW 3; tool residue `0x02270020`/`0x01d80020` plus a small integer in
> the unread words), 1 speed gate (MERQUER: mode 0, selector 1, 30.0 →
> "at least 30 km/h").
> bxtools listed all four modes as "?" — the semantics are new here.

Modes 1, 2 and 3 are confirmed on hardware, and so is the mode-0 **selector**.
A random gate authored at p=1 passed every pass and the same gate at p=0 passed
none, over three passes each: the probability field is the chance of CONTINUING,
and a gate that fails ends its chain with nothing constructed on the host. Mode
2 passed for the player, which is the half of it a single-board fixture can
reach. Mode 3 passed on an idle instance; its rejecting half is unreachable from
a dispatch-slot reading, because an instance already holding a node reports that
slot as spoken for. [measured] [[150-gate-live]]()

**The mode-0 selector is settled and it stops chains.** Holding the threshold at
zero and moving the selector alone, selector 0 blocked in all three passes while
a non-zero selector passed in all three. Selector 0 is therefore the at-most
side — a moving rider fails "at most zero" — and this is the first speed gate
observed to stop anything. [measured] [[150-gate-live]]()

**Both parameter words are typed against the engine, in opposite directions**,
and reading them the way the record declares them is what makes a gate look
inert. The runtime reads the selector as an **integer** and the threshold as a
**float**, while the record declares them the other way round — so the selector
field is a float holding an integer, and the threshold field an integer holding
a float. Two consequences, both silent:

- a plainly written threshold of `10` carries the bit pattern of a denormal,
  which every comparison sees as zero;
- a plainly written probability of `0.5` is not an integer at all.

Read through the corrected types, retail's **one** authored speed gate becomes
legible: Merqury City writes `U2 = 1106247680`, which is **30.0**, against a
non-zero selector. [measured] [[150-gate-typing]]()

**On the at-most side the threshold is read, and it is compared in engine
centimetres.** Thresholds of 0.0 and 30.0 each blocked all three passes while 1e6
passed all three, so the word is consumed — and since the rider crosses at
roughly 25 m/s and a ceiling of 30 still shut the gate, the quantity compared
against is not metres per second. It lies above 30 and below 1e6, which is the
engine's own units at ≈2500. Merqury City's 30.0 sits on the *at-least* side,
so it reads as "at least 30 km/h" — open at any riding speed — rather than the
near-closed ceiling the same number would be on the at-most side. [measured]
[[150-gate-threshold]]()

**The at-least side works too, once the selector is spelled exactly.** Authored
as `1.0f` it never blocked anything at any threshold, including 1e6 — which for
two batches looked like a branch that ignores its own parameter. It is the typing
trap again: `1.0f` reaches the runtime as 1065353216, while retail writes the
float whose *bits* are 1. Carrying that value instead, the branch gates properly
— threshold 30.0 passed all three passes and 1e6 blocked all three. The selector
is therefore matched by VALUE, and a near-miss does not fall back to a default
sense; it falls through to a path that passes unconditionally. [measured]
[[150-gate-selector]]()

So the node is fully tunable in both directions, and the only thing standing
between an author and a working speed gate is writing both parameter words the
way the engine reads them rather than the way the record declares them.

> [[150-gate-live]]() Live evidence: `Trailmap/tools/autotest`. Modes 1/2 and the
> at-least anomaly from runs 20260806-072247, -072612 and -072938 (AUTOTEST1
> cells `gate-random-always`, `gate-random-never`, `gate-human`,
> `gate-speed-open`, `gate-speed-shut`); the selector sweep and mode 3 from runs
> 20260806-081511, -081741 and -082007 (AUTOTEST2 cells `gate-speed-u1lo-u2z`,
> `gate-speed-u1hi-u2z`, `gate-speed-u1lo-u2o`, `gate-speed-u1hi-u2o`,
> `gate-no-live-node`). The sweep moved one word between neighbouring cells: the
> two selector-0 cells blocked 0/3 and the two non-zero cells fired 3/3, and the
> two values paired against each selector made no difference — both are ~0.0 as
> floats, which is why an earlier pair that moved only that word got the same
> answer twice.

> [[150-gate-threshold]]() Live evidence: `Trailmap/tools/autotest`, runs
> 20260806-083132, -083333 and -083533 (AUTOTEST2 cells `gate-speed-atmost-0`
> 0/3, `gate-speed-atmost-30` 0/3, `gate-speed-atmost-huge` 3/3,
> `gate-speed-atleast-30` 3/3). Each cell is one full-corridor gate on the same
> fall line 90 m apart, differing only in the two payload words, and every one
> was crossed within 6 m in every pass.

> [[150-gate-selector]]() Live evidence: `Trailmap/tools/autotest`, runs
> 20260806-090633, -090834 and -091034 (AUTOTEST2 cells `gate-speed-bit1-huge`
> 0/3 and `gate-speed-bit1-30` 3/3, against `gate-speed-atmost-30` 0/3 as the
> same-course control). Both cells carry `U1` = 1.401298464324817e-45, the float
> whose bit pattern is 1; the two earlier batches carried 1.0f and fired at every
> threshold.

> [[150-gate-typing]]() db:effects-control-semantics — runtime offsets from [[150-gate]] above
> against the record in `SSX-Library` `SSFHandler.Type5`: mode at +8, selector
> read as an int at +0xc, threshold read as f32 at +0x10, against a declared
> `int U0; float U1; int U2`. A threshold written as `10` is therefore the bit
> pattern 0x0000000A. Corpus: the only
> mode-0 gate in the censused levels is MERQUER's, `U2` 1106247680 =
> `0x41F00000` = 30.0f, selector 1e-45 (the float whose bits are 1). MERQUER's
> mode-3 gates carry unread residue in the same two words, which is why they
> print as small ints and near-denormal floats.

### Property effects (main type 0)

Main type 0 is itself a family, selected by a **sub-type**, covering most of the
small per-instance behaviors: UV scroll and texture flip (`170-materials.md`,
`410-texture-animation.md`), world-prop model animation and the mesh-animation
"throw"/reveal used by breakables (`370-world-interaction.md`), a boost node, a
fence-flex rattle, a crowd-grid descriptor, and others. The sub-type names are
**original**: the engine keeps a name string per sub-type and each factory
branch registers its node under it, so the family's vocabulary (Roller,
Debounce, Counter, Boost, Timer, Rail, UVScroll, TexFlip, Fence, Flag,
Cracked, LapBoost, RandomBoost, CrowdBox, ZBoost, MeshAnim, TrickTrigger,
Particle, Movie, TubeEndBoost, UVScrollTexFlip, AnimObject, AnimDelta,
AnimCombo, AnimTexFlip) is the developers' own — the mesh-anim node's string
even keeps its C++ class prefix. The engine constructs nodes
for more sub-types than the shipped levels author — Timer, Rail, RandomBoost,
Particle, TrickTrigger, TubeEndBoost, UVScrollTexFlip, and AnimTexFlip all
have live constructors but appear nowhere in the extracted data. The
behaviors are specified in their respective chapters; the catalogue of
sub-types and their payload fields is part of the format detail in
`230-level-ssf.md`. [[150-type0]]()

> [[150-type0]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `LoadEffectsData` sub-type switch: 10 UVScroll, 11 TextureFlip, 12 FenceFlex,
> 20 cMeshAnim (breakable throw/reveal), 7 a boost node
> (`BoostNode_ConstructFromEffectPayload` 0x001404a0, distinct from collision
> main types 17/18), 17 CrowdBox, 256 AnimObject (model animation,
> map:"World-prop model animation"), among others. The
> factory `EffectRegistry_BuildEffectNode` 0x0013c5d8 dispatches sub-types
> through a **260-entry** jump table 0x0036c9e0 (bounds `sltiu 260` at
> 0x0013c724 — 256..259 index directly, no remap), preceded by the original
> name-string block 0x0036c8a0..0x0036c9d4; each branch passes its own name in
> a3, so name↔sub-type binding is mechanical. Live-but-unauthored branches:
> 8 Timer (ctor 0x0013fdd8 — two f32 seconds ×60 → frame counts), 9 Rail
> (`RailNode_ConstructFromEffectPayload` 0x001400e0), 16 RandomBoost (ctor
> 0x00141210 on the same base 0x001404a0 as sub-7 Boost), 19 UVScrollTexFlip,
> 21 TrickTrigger, 22 Particle (`cParticleNode_Construct` 0x00147f90, RTTI
> `13cParticleNode`), 24 TubeEndBoost (full original name; 448-byte node),
> 259 AnimTexFlip. Subs 1/3/4 and 25..255 hit the inert default 0x0013d09c.
> Sub 5 has **no** name string ("DeadNode" is a community name). Census over
> the five extracted levels: authored = {0, 2, 5, 6, 7, 10, 11, 12, 13, 17,
> 20, 23, 256, 257}; SSFHandler.cs cannot parse the unauthored set (payload
> layouts [open]). bxtools' sub-type names match this string block verbatim.

## Worked examples

These trace how the pieces compose; the *behavior* each produces is specified in
the chapter named.

**A breakable LCD screen.** The intact screen is a pass-through instance with a
collision chain. On rider contact the chain runs a named "break" function, which
in turn acts on three instances by index — hiding the intact screen, showing its
pre-placed broken twin, and hiding a scanline overlay. The break **sound** is not
part of this chain: it rides the separate prop-collision audio path keyed by the
instance (`190-audio-data.md`, `420-audio-runtime.md`). [[150-ex-logo]]()

**A smash-through wall.** A breakable can carry its break chain on a *neighbour*
rather than the source: the visible wall is a **solid** instance with an **empty**
collision chain, and a **separate hidden pass-through trigger** volume sits at it,
whose chain acts by index on the wall (hide it) and its pre-placed broken twin
(show it, then run a mesh-throw sub-effect that flings the twin's pieces,
`230-level-ssf.md` sub-type 20). Structurally this is the fireworks trigger below
— a hidden volume naming other instances — but its target set is a hidden-source +
thrown twin, not launchers; the mesh-throw of a hidden twin is what makes it a
break and not a scripted event (`370-world-interaction.md`). [[150-ex-wall]]()

**A swinging bridge.** The visible bridge model's slot carries a *persistent*
chain: one node plays the model's looping hinge animation, and a second node
chains the same animation onto the bridge's invisible collision twin, so the
collidable surface tracks the rendered sway (`120-objects.md`,
`370-world-interaction.md`). [[150-ex-bridge]]()

**A fireworks trigger.** A hidden trigger volume carries a collision chain that
names a set of launcher instances; each launcher's sub-effect emits a particle
burst (`180-particles-data.md`) and plays a course-bank report sound. [[150-ex-fw]]()

**The up/down kicker ramps.** Three identical hinged ramps show the
*delta-gated* animation player (`120-objects.md`) and how phase emerges from
gameplay rather than authored offsets. Each ramp's persistent chain installs
the gated player; the centre ramp's chain also carries one animation-budget op,
so it swings one half-cycle each time its region activates. The two outside
ramps' chains are bare — they move only when a rider crosses one of four
landing-trigger volumes scattered upcourse, whose shared collision chain
(debounced) grants one budget op to **all three** ramps at once. Each grant is
half the ping-pong cycle, so every poke toggles a ramp between its up and down
poses: the outside pair, always granted together, stays in lockstep, while the
centre — with its extra per-activation grants — drifts against them. A race's
worth of riders crossing the landing zones keeps all three pumping, mutually
out of phase, with no authored phase anywhere. [measured] [[150-ex-kicker]]()

**A boost pad.** The pad's slot carries both circumstances at once: a persistent
chain scrolls the chevron texture, and a collision chain applies the speed (or
trick) boost when the rider crosses it (`360-speed-and-boost.md`). [[150-ex-boost]]()

**A burst-on-break balloon.** A pass-through prop whose collision chain both
**self-destructs and emits**: a kill node hides the prop (the breakable
hide-source action, `370-world-interaction.md`) and two particle-emitter nodes
spray a one-shot **coloured star** burst (`180-particles-data.md`), the colour
authored per instance. It is the one observed breakable whose chain *also*
emits particles, and it shows the timer-type emitter (main type 2 / sub-type 0)
fired **one-shot from a collision chain** rather than on a timer — distinct from
the dedicated collision emitter (sub-type 2), which stays authored-zero
(`370-world-interaction.md`). [[150-ex-balloon]]()

> [[150-ex-logo]]() db:sign-break — instance 1470 (`CollsionMode 2`,
> pass-through), `EffectSlots[15].CollisionEffectSlot = 49` → main type 21
> `FunctionRunIndex 6` → `Functions[6] = BreakLogo4001` = three main-type-7
> nodes (hide 1470, show broken twin 1469, hide scanline 1468),
> map:"BreakLogo". Break sound = the prop-collision
> path 0x00217148, not this chain.

> [[150-ex-wall]]() db:sign-break — the trigger-driven wall break (the
> MERQUER sewer brick walls): a solid wall instance with an empty collision
> chain + a separate invisible pass-through trigger whose collision chain
> acts by index on the wall (main-type-7 hide) and its pre-placed broken twin
> (main-type-7 reveal → a type-0 sub-20 mesh-throw, `230-level-ssf.md`). The
> hidden twin's sub-20 mesh-throw is the break-vs-scripted-event
> discriminator (`370-world-interaction.md`).

> [[150-ex-bridge]]() db:anim-object — `EffectSlots[71].PersistantEffectSlot
> = 149` = a sub-type-256 AnimObject node (3.0 s hinge clip) + a main-type-7
> node chaining an identical clip onto the invisible collision twin (instance
> 1447); map:"World-prop model animation".

> [[150-ex-fw]]() map:"SSF effect-graph sound (firework `SoundPlay`)"
> — a trigger volume's collision chain → per-launcher sub-effects, each a
> main-type-2 sub-type-0 emitter + a main-type-8 SoundPlay (course bank, raw
> slot 82/83); doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.

> [[150-ex-kicker]]() db:anim-delta-kicker — three hinged ramps on the
> delta-gated animation player (`120-objects.md`): each ramp's persistent
> chain installs the gated player; the centre ramp's chain carries one
> per-activation animation-budget op, the two outside ramps are bare and are
> granted only by four upcourse landing-trigger volumes whose shared,
> debounced collision chain pokes all three at once. Each grant is half the
> 2 s ping-pong cycle, so pokes toggle up/down poses; no phase is authored.

> [[150-ex-boost]]() db:course-boost — boost-pad slot: persistent
> sub-type-10 UV scroll + collision main type 17 (speed, value 3.0/5.0) or 18
> (trick, 10.0/15.0); map:"Visible speed/trick boost pads";
> doc:../research/extracted-data.md "Boost and scoring effects".

> [[150-ex-balloon]]() db:sign-break — Snowdream balloon animals (three
> shapes): each shape's `EffectSlots[*].CollisionEffectSlot` chain (effects
> 77/79/81 of the level's SSF) = two main-type-2 sub-type-0 emitter nodes +
> one main-type-0 sub-type-5 dead-node mode 4 (hide source). The two emitters
> carry the per-instance burst colour in their colour-ramp first stop
> (`180-particles-data.md` `U33..U36`, serialized `A,R,G,B`): green, blue,
> tan across the shapes;
> the sprite is a star from the shared bank. Contrast `[[150-ex-fw]]()` (the
> same emitter node, but reached from a hidden trigger volume, not the prop's
> own collision slot).
