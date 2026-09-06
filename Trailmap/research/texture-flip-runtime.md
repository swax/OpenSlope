# Texture flip at runtime — where the applied frame lives, and what silences it

2026-08-06. Static pass over the PAL ELF (SLES-50545), read-only against
`extracted/SLES_505.45` with `tools/analysis/ssx_analyze.py`. Motivating
question: the live PCSX2/PINE harness proved a texture-flip effect graph
*dispatches*, but observed no visible flip. This note pins the exact field a
flip writes, the pointer chain to read it from an entity, and every gate on the
path that can make the write invisible or absent.

Everything is marked **CONFIRMED** (instructions read) or **INFERRED**.
Companion notes: `texture-flip-timing.md` (node struct, accumulator, pause
mode), `prop-collision-semantics.md` (`entity+0xe4` lifetime). Nothing here
contradicts them; it extends the material side.

## 1. Dispatch: MainType 0 and its Sub-11 arm

**CONFIRMED.** `EffectPayload_OpcodeDispatcher 0x0013bfd8` bounds-checks
`MainType < 27` (`0x0013c010`) and jumps through `0x0036c830`. Entry 0 =
**`0x0013c034`**, a thunk that passes the effect thread and raw effect record to
`EffectRegistry_BuildEffectNode 0x0013c5d8`, then returns `1` to continue the
chain. The call itself is at `0x0013c038`; the return-value assignment is at
`0x0013c044`.

`EffectRegistry_BuildEffectNode 0x0013c5d8` bounds-checks `SubType < 260`
(`0x0013c724`) and jumps through **`0x0036c9e0`**. Entry 11 = `0x0036ca0c` →
**`0x0013cb1c`**, the TexFlip arm: name string `a3 = 0x0036c928` = `"TexFlip"`,
allocator `0x0023d8d0(pool 0x00347048, size 724, 0x40000000, 0, 0)`, heap tag
`0xdeadc0de` @`0x0013cb54`, then loads the thread's bound entity from `+0xe4`
at `0x0013cb5c` and calls `cTextureFlipNode::ctor(node, 3, entity, record)` at
`0x0013cb68`.

MainType 0 is therefore *only* a node factory. It never touches a material
directly.

## 2. What the Sub-11 arm actually writes

**CONFIRMED — it never writes a level material.** The node builds a private,
node-local material table and the renderer is handed that table instead of the
instance's.

### 2.1 Level material record layout (72 bytes, stride confirmed)

`0x00255020` resolves material *i* as `level->+0x50 + 72*i`, count
`level->+0x14` (`addiu v0, zero, 72` @`0x00255030`). Fields used on this path,
from `Course_RemapMaterialTextureIds 0x00260c28`:

| offset | meaning | evidence |
|---|---|---|
| +0x00,+0x02,+0x04,+0x06 | four `u16` texture ids (slot 0 = the drawn one) | remap loop `0x00260c88`–`0x00260ca8` (4 halfwords, `bltz` skips −1) |
| +0x40 | render-state word (copied verbatim into the override) | `lw a0, 64(t1)` @`0x00142bd8` |
| +0x44 | pointer to the **flip table**, 0 = not a flipbook | `lw a3, 68(t1)` @`0x00260cac` |

Flip table: `[0]` = frame count (int), entries from `+0x04`, **stride 4**, the
texture id being the low `u16` of each entry (`lhu v0, 4(a3)` @`0x00260cf8`).
The loader stamps the resting frame with `sh v0, 0(t1)` @`0x00260cfc` —
`material->TextureID := flipTable[0]`. That confirms the existing spec claim.

### 2.2 The instance material table

**CONFIRMED.** `entity+0xF0` is a **pointer** to `[count][ptr0][ptr1]…` —
`count` at `+0x00`, material pointer *i* at `+0x04 + 4*i`. It starts life as an
authored index and is relocated in place at `0x00253978`–`0x00253998`
(`lw v0,0xf0(s0)` → `sll v0,v0,2` → `addu` level`->+0x08` → `lw v1,0(v0)` →
`sw v1,0xf0(s0)`).

Note the ordinary world draw does **not** use it: it passes `*(model+0x0C)`
(`lw a2, 12(a1)` @`0x00200a7c`). `entity+0xF0` is the per-instance override
list, `model+0x0C` the model's default. The flip node reads `entity+0xF0`
(`lw v0, 0xf0(a1)` @`0x00142b14`).

### 2.3 The node-local override table (`flipState`, embedded at `node+0x58`)

Built by `cTextureFlipState::Init 0x00142af8(a0=flipState, a1=entity, a2=frame)`.
Layout **CONFIRMED**:

| flipState off | node off | meaning | evidence |
|---|---|---|---|
| +0x00 | +0x58 | bound entity (not a material) | `sw a1, 0(s0)` @`0x00142b10` |
| +0x04 | **+0x5C** | **applied frame index (clamped)** | `sw a1, 4(s0)` @`0x00142d30` |
| +0x08 | +0x60 | material count = `*(entity+0xF0)` | `sw a0, 8(s0)` @`0x00142b20` |
| +0x0C | +0x64 | frame count = `flipTable[0]` of the **first** material that has one | `sw v0, 12(s0)` @`0x00142b44`/`0x00142b80` |
| +0x10 | **+0x68** | override table: count word — **this is what the renderer is given** | `sw t2, 16(s0)` @`0x00142bb0`; `addiu a2, s0, 16` @`0x00142e54` |
| +0x14+4i | +0x6C+4i | override material pointer *i* | `sw v0, 0(v1)` @`0x00142c00`; shared record if no flipbook @`0x00142c58` |
| +0x34+72i | **+0x8C+72i** | override material copy *i*; its `u16` at +0x00 is the **live texture id** | `sh v0, 52(a0)` @`0x00142c4c` and @`0x00142d90` |
| +0x274 | +0x2CC | flipState vtable = `0x0036e238` | `sw v1, 628(a0)` @`0x00142ae0` |

**Capacity is exactly 8 materials.** `memset(flipState+0x10, 0, 612)`
@`0x00142b9c`; `0x10 + 612 = 0x274`; pointer array `0x14..0x33` (8×4) then
copies `0x34..0x273` (8×72). **The init loop has no clamp against 8** — a 9th
material would run over the flipState vtable at `+0x274` and the node's
`enabled` word. INFERRED consequence: authored instances never exceed 8
materials; an over-8 instance is memory corruption, not a silent no-op.

**The "copies" are not copies.** Only two fields are written per entry —
`copy+0x40 = mat+0x40` (`sw a0, 64(v0)` @`0x00142bfc`) and `copy+0x00 =
texture id`. Everything else is the memset's zero, including `copy+0x44` (so
the override is correctly not itself a flipbook). Copy **0** additionally gets
`-1` into its `+0x02/+0x04/+0x06` texture-id slots (`sh t4, 0(a2)` @`0x00142c10`
with `a2 = flipState+0x36`, unrolled ×3) — and that address is loop-invariant,
so copies 1..7 keep zeros in those slots while copy 0 gets −1. INFERRED: −1 is
"no texture in this stage", 0 is texture id 0; only copy 0 gets the correct
disable value. Harmless for single-material flipbooks (every authored flip case
seen so far), potentially a stage artefact on multi-material ones.

### 2.4 The apply routine — the actual per-frame write

`cTextureFlipState::ApplyFrame 0x00142d48(a0=flipState)`, **CONFIRMED**:

```text
if materialCount <= 0: return
for each instance material i:
    if material[i].flipTable exists:
        override[i].textureId = material[i].flipTable.frames[flipState.frame]
```

The material-count gate is at `0x00142d50`, the null-flip-table gate at
`0x00142d70`, the low-`u16` frame lookup at `0x00142d88`, and the write to the
node-local 72-byte override record at `0x00142d90`. Source offsets are
`entity+0xf0`, `material+0x44`, and `flipState+0x04`; the destination is
`flipState+0x34+72*i`.

Called from exactly three sites (whole-ELF `jal` sweep): **`0x00142e48`** (the
flip node's own draw), `0x00146568` (sub-19 `UVScrollTexFlip`), `0x0019ae08`
(sub-259 `AnimTexFlip`) — the three classes that embed the same `flipState`.
**It is called from the draw, not from Update.** Consequence for the harness:
`flipState+0x04` (the frame) updates on the simulation tick, but the texture-id
copy at `flipState+0x34` only updates on a tick where the node actually drew.

### 2.5 The draw hand-off

`cTextureFlipNode::Render 0x001433c0` → `0x00142db0(flipState)`, **CONFIRMED**:

```text
if not node.enabled: return
if renderer.frustumCull(entity.bounds): return
ApplyFrame(flipState)
renderer.DrawModel(entity.model, flipState.overrideTable, entity, entity+0x40, 0, 0)
```

The enabled gate is `0x001433c0`–`0x001433c4`. The frustum call and gate are
`0x00142e34`–`0x00142e40`, using bounds at `entity+0xCC..+0xD4` and
`entity+0xD8..+0xE0`. `ApplyFrame` is called at `0x00142e48`, and the renderer's
`+0x2ac` virtual is invoked at `0x00142e78` with the override table rooted at
`flipState+0x10`.

The ordinary world instance draw (`0x002009f0`, inside `0x00200888`) issues the
same `[+0x2ac]` virtual with `a2 = *(model+0x0C)`. So the two draws are
identical except for the material table.

## 3. Read recipe from an entity pointer

All offsets **CONFIRMED**. Given `E` = entity pointer (what the harness already
resolves per instance):

```
N = *(u32*)(E + 0xE4)                 ; live effect node, 0 = none
  identify: *(u32*)(N + 0x08) == 0x0036E158   (cTextureFlipNode vtable)
            *(u32*)(N + 0x14) == 11           (SubType, "TexFlip")
            *(u32*)(N + 0x28) == E            (back-pointer)

frame      = *(s32*)(N + 0x5C)        ; APPLIED frame — the primary signal
frameRaw   = *(s32*)(N + 0x48)        ; node's own counter, pre-clamp
matCount   = *(s32*)(N + 0x60)
frameCount = *(s32*)(N + 0x64)
tableCount = *(s32*)(N + 0x68)        ; what the renderer is handed
matPtr[i]  = *(u32*)(N + 0x6C + 4*i)
texId[i]   = *(u16*)(N + 0x8C + 72*i) ; LIVE displayed texture id, per material
enabled    = *(s32*)(N + 0x2D0)
killTicks  = *(s32*)(N + 0x38)   accum = *(f32*)(N + 0x3C)   inc = *(f32*)(N + 0x40)
```

**Use `N+0x5C` as the proof-of-application signal.** It is written by
`SetFrame 0x00142c80` from both the accumulator (`0x00143358`) and the
MainType-3 control op (`0x00143498`), and it is independent of visibility.
`N+0x8C` is the ground-truth *texture id* but only refreshes on a tick the node
drew (§2.4/§2.5), so it reads stale when the prop is off-screen.

Cross-check against the resting value: `*(u16*)matPtr_level[i]` where
`matPtr_level[i] = *(u32*)(*(u32*)(E+0xF0) + 4 + 4*i)` — the level material's
own texture id, which the loader set to `flipTable[0]` and which **no node ever
writes**.

### If you have no entity: the global node registry

**CONFIRMED.** Every effect node registers itself in a global registry object
at **`0x00348E60`** (`0x0017d008` → `0x0017d5a0`), class **3** for all
effect-graph nodes and threads:

```
buckets = *(u32*)0x00348E64
bucket3 = buckets + 52*3                  ; = buckets + 156
head    = *(u32*)(bucket3 + 0x04)         ; empty iff head == bucket3 + 0x10
next    = *(u32*)(node + 0x00)            ; sentinel-terminated
```

Filter `*(u32*)(node+0x14)`: **11** = TexFlip, **1001** = effect thread
(`CollisionEffectNode_Construct 0x0013b8c8` passes 1001 @`0x0013b904`).
`NodeRegistry_UpdateAll 0x0017da08` (vt+0x14) is called with class 3 and 4 at
`0x00265b20`/`0x00265b2c`; `NodeRegistry_RenderAll 0x0017da90` (vt+0x1C) at
`0x00265730`/`0x0026573c`, **after** the world instance draw
(`jal 0x00200888` @`0x0026571c`). So a live flip node is ticked and drawn every
frame with no further opt-in.

## 4. MainType 3 — `material.texture-frame`

**CONFIRMED.** Jump table entry 3 = `0x0013c070` (entry 9 = `0x0013c084`, the
same code minus the first guard):

```text
entity = thread.boundEntity
node = entity?.liveNode
if node exists: node.ControlOp(payload.U0, payload.U1)
return CONTINUE
```

The bound-entity and live-node null gates are at `0x0013c074` and
`0x0013c08c`; both silently return `1`. The virtual `ControlOp` dispatch is at
`0x0013c094`–`0x0013c0a8`, with the command and value read from payload
offsets `+0x08` and `+0x0c`.

For a `cTextureFlipNode` the receiver is **`0x001433e0`** (vtable
`0x0036e158 + 0xC4`). Its command decode, **CONFIRMED**:

| cmd | action | address |
|---:|---|---|
| 1 | `node+0x40 = value` (set per-tick increment) | `0x00143424` |
| **2** | **select frame**: `node+0x48 = (int)value`, then `SetFrame` | `0x0014342c`–`0x00143498` |
| 3 | advance: `node+0x48++`, wrap to **1** (not 0) if `>= frameCount`, then `SetFrame` | `0x001434a0`–`0x001434c8` |
| 4 | `node+0x2D0 = (value != 0.0)` — enable/disable rendering | `0x001434cc`–`0x001434ec` |
| other | falls through to `EffectNodeBase_ControlOp 0x0013aa50` (cmds 7/8 = clear/set `entity+0xE8` bit 0x0800) | `0x001434f0` |

So the button recipe's `MainType 3 {U0:2, U1:1.0}` writes `node+0x48 = 1` and
`node+0x5C = 1` (via `SetFrame`), and the next draw copies
`flipTable[1]`'s texture id into `node+0x8C`.

## 5. Gates that make the write a no-op

Ordered by how likely they are to explain "graph dispatched, nothing flipped".

### G1 — the factory refuses to build over a live node of the same sub-type
**CONFIRMED, highest value.** `EffectRegistry_BuildEffectNode` prologue:

```text
existing = thread.entity.liveNode
if existing is null: build the requested node
if existing.subType == 5: return
if existing.busy() and existing.subType == requested.subType:
    existing.refresh()
    return
if not existing.busy() and existing.subType == requested.subType:
    return
# different-sub-type paths continue elsewhere
```

The live-node lookup and null/build branch are `0x0013c604`–`0x0013c610`; the
Sub-5 early return is `0x0013c620`; the busy virtual call is `0x0013c634`; and
the two same-sub-type returns are rooted at `0x0013c648` and `0x0013c670`.

`cTextureFlipNode`'s `vt+0x64` is the base stub **`0x0013b7d8` = `return 0`**
(vtable `0x0036e158+0x60`). So the second branch applies: **a Sub-11 fired at
an instance that already carries a live Sub-11 constructs nothing and refreshes
nothing.** The chain still returns 1 and keeps walking, so the following
MainType-3 lands on the *old* node — which is why a re-crossing during a live
pulse changes the frame but does not restart the lifetime, and why a second
distinct flip graph on the same instance is completely inert.

`vt+0x74` (refresh) is also the base no-op `0x0013b7c8` (`jr ra; nop`), so even
the "busy" branch would do nothing for this class.

### G2 — a live sub-type-5 (`DeadNode`) blocks every property node
**CONFIRMED.** `0x0013c620: beq existing->+0x14, 5 → 0x0013d0a0` returns before
any construction. An instance killed/hidden by a Sub-5 node can never take a
flip afterwards.

### G3 — MainType 3 with no installed node is silent
**CONFIRMED**, `0x0013c08c`. If the Sub-11 in front of it was suppressed by G1
or G2, or if the node died in a prior tick, the frame select evaporates with a
success return. This is the specific failure mode that looks like "the graph
dispatched fine".

### G4 — MainType 3 cmd 2 range check
**CONFIRMED.** `0x00143434`: requires `0.0 <= U1`; `0x00143450`: requires
`U1 < 9.0` (`0x41100000`). Out of range → `0x001434f8`, `jr ra`, nothing
written. Authored `U1 = 1.0` passes.

### G5 — no flipbook material on the instance
**CONFIRMED.** Two independent effects:
- `ApplyFrame` skips any material whose `+0x44` is 0 (`0x00142d70`), and the
  init points that override slot at the *shared* level record (`0x00142c58`), so
  the surface renders identically forever.
- `flipState+0x0C` (frameCount) is only set if some material has a flip table
  (`0x00142b30`/`0x00142b70`); otherwise it stays 0 and `SetFrame`'s clamp
  (`slt v1,a1,a0` / `movz a1,frameCount-1` @`0x00142d20`–`0x00142d28`) writes
  **−1** into `flipState+0x04`. `frame == -1` with `matCount > 0` is a
  diagnosable signature.

### G6 — empty instance material table
**CONFIRMED.** `0x00142b1c: blez *(entity+0xF0), 0x00142b84` skips the whole
override build; `flipState+0x08/+0x0C/+0x10` all stay 0. The node then hands the
renderer a **zero-length material table** while the instance's own draw is
already suppressed (G8), i.e. the prop renders untextured or not at all.

### G7 — `enabled` and the frustum cull
**CONFIRMED.** `node+0x2D0 == 0` (settable by control cmd 4) skips the draw
entirely (`0x001433c4`). The frustum test at `0x00142e34`–`0x00142e40` uses
`entity+0xCC..+0xD4` and `entity+0xD8..+0xE0`; returning 1 skips both the draw
**and** the `ApplyFrame` call, so the texture-id copies freeze while
`flipState+0x04` keeps advancing. An instance with unset/degenerate world bounds
is culled here and the prop vanishes for the node's whole lifetime.

### G8 — the render hand-off flag (`entity+0xE8` bits 0 and 1)
**CONFIRMED, and it is the reason a broken flip is a *disappearance*, not a
stale texture.** The world instance loop draws an instance only when
`(entity+0xE8 & 3) == 3`; the three-instruction test spans
`0x002009f0`–`0x002009f8`.

The flip node's ctor tail clears bit 1 and sets bit 2, equivalent to
`entity.flags = (entity.flags & ~0x2) | 0x4` (`0x00143018`–`0x00143038`).

Node death restores it (`EffectNodeBase_EndNodeWithSlot4Handoff 0x0013a988`:
`and 0xFFFF0100`, `or (v0>>16)`, `or 2`, `sw` @`0x0013a9b0`–`0x0013a9d0`; the
`vt+0xBC` teardown `0x0013a930` does the same with mask `0xFFFF0000`).
So **while a flip node lives, the node's draw is the only draw of that prop.**
If the node exists but its draw is gated off (G6/G7, or `enabled = 0`), the prop
disappears. If the prop is still visible and unchanged, the node does **not**
exist on that entity — look at G1/G2/G3 first, not at the material.

Corollary, **INFERRED**: the node's Render never consults `entity+0xE8` bit 0,
so a flip node installed on a *hidden* instance will draw it anyway.

### G9 — upstream chain gates (not material-specific, but they precede everything)
**CONFIRMED.** `EffectThread_Tick 0x0013be80` refuses to dispatch while its wait
timer `thread+0x40 > 0`, decrementing by 1/60 (`0x0013be98`–`0x0013bed0`) —
authored `Debounce`. MainType-5 mode 3 (`0x0013c1cc`) reads
`thread->entity->+0xE4` and **kills the chain** (returns −1) when a live node
exists. MainType 7 (`0x0013c2ec`) returns 1 silently if
`LevelInstanceTable_ResolveByIndex 0x00254f58` cannot resolve the target index
(`beq s3, zero, 0x0013c5ac` @`0x0013c300`) — a bad instance index is an
invisible no-op. When it does resolve, `CollisionEffectNode_Construct 0x0013b8c8`
binds the sub-thread to the **target** entity (`sw s4, 0xe4(s0)` @`0x0013b928`)
and ticks it immediately (`jal 0x0013be80` @`0x0013b94c`), which is what makes
the Sub-11 + MainType-3 pair land on the button in the same frame.

## 6. Negative results (things that do not exist)

- **There is no global material table carrying a "current frame".** The level's
  material array (`level->+0x50`, stride 72, count `level->+0x14`) holds only
  the *resting* texture id, written once at load by
  `Course_RemapMaterialTextureIds 0x00260c28`. No flip path ever stores into it:
  the only `sh` writes on the flip path are `0x00142c4c` and `0x00142d90`, both
  into the node-local copy. There is nothing to index by material id.
- **There is no per-material "frame" field.** The frame lives once per *node*,
  at `flipState+0x04`, shared by every material that node overrides — all
  flipbook materials on one instance necessarily show the same frame index.
- **`ApplyFrame` is not called from Update.** No tick-driven refresh of the
  texture id exists; only the draw refreshes it.
- **No frame-count sanity check that no-ops.** `SetFrame` clamps rather than
  rejecting, and clamps to `frameCount-1`, which is −1 when `frameCount == 0`.
- **`node+0x50` (warmup, = 30) is decremented and never read** — reconfirmed
  here (`0x001430e0`–`0x001430ec`, no other reader).

## 7. Suggested live probes

1. On a button crossing, read `E+0xE4`. **Null ⇒ G1/G2/G3**: no node was built;
   the MainType-3 was a no-op. Non-null ⇒ check `*(u32*)(N+0x14) == 11`.
2. If the node exists, sample `N+0x5C` every frame. It should jump to the
   MainType-3 value on the construction frame, then step on the accumulator.
   If it reads **−1**, the instance has no flipbook material (G5) — check
   `N+0x60` (matCount) and `N+0x64` (frameCount).
3. If `N+0x5C` moves but nothing renders: read `N+0x2D0` (enabled), `N+0x68`
   (table count — 0 means G6), and watch `N+0x8C` — if it never changes while
   `N+0x5C` does, the draw is being culled (G7) and the prop should also be
   invisible, which is independently checkable via `E+0xE8 & 3`.
4. Breakpoint `0x0013c66c` (the same-sub-type early return) and `0x0013c620`
   (DeadNode return). Either firing on a crossing is a direct positive for G1/G2.
5. Registry sweep as a global sanity net: walk class 3 from
   `*(u32*)0x00348E64 + 156 + 4` and count nodes with `+0x14 == 11` — this
   answers "did any TexFlip node exist anywhere this frame" without needing the
   right entity.

## 8. Open leads

1. Level material `+0x08..+0x3F` is **zero** in every override copy, yet retail
   flips look correct. Either those bytes are load-time-only (name/asset refs)
   or the draw path ignores them. Decoding `[renderer+0x2ac]`'s material
   consumption would settle it, and would also say whether the `-1` triple at
   `flipState+0x36` (copy 0 only, `0x00142c10`) is meaningful or vestigial.
2. `entity+0xF0` vs `*(model+0x0C)`: the node builds overrides from the former
   while the world loop draws from the latter. If an instance's authored
   material-table index names a table with a different *count* than the model's
   material slots, the override table handed to `[+0x2ac]` is the wrong length.
   No shipped case checked.
3. The `movn s4, s1, v1` at `0x0013c614` (`s4 = thread+0x50` when
   `thread+0xD0 != 0`) is threaded into every node ctor as `t0`; the TexFlip arm
   drops it. What the contact-result block does for other classes is untraced.
4. `flipState`'s own vtable `0x0036e238` — slots `+0x04 = 0x00149a18`,
   `+0x0C = 0x001499f0` (the dtor `texture-flip-timing.md` already names),
   `+0x14 = 0x00149aa8`. The other two are unexamined.
5. Whether sub-19 `UVScrollTexFlip` and sub-259 `AnimTexFlip` place their
   embedded `flipState` at the same node offset (they share `0x00142af8` /
   `0x00142d48`, so the field layout is identical, but the base offset within
   their node structs is not verified — `0x00145508`, `0x00146234`,
   `0x0019abd0` are their init call sites).
