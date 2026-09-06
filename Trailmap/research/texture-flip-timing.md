# Texture flip timing — `cTextureFlipNode`

The SSF `TextureFlip` effect (Type0 Sub11; fields `U0 / Direction / Speed / Length / U4`)
is executed by `cTextureFlipNode`: size 0x2D4, vtable `0x0036E158`, constructor
`0x00142E98`, update `0x001430C0`, frame-set helper `0x00142C80` (embedded flip
state ctor `0x00142AD0` / init `0x00142AF8`), render `0x001433C0`, control op
`0x001433E0`, allocated at call site `0x0013CB68`
(724 bytes, receives the raw effect record). The node runs on the texture-animation
update list at **60 Hz** — the same tick the UV-scroll rate rides.

The tick rate is measured. A megaplex button's finite flip
(`Speed 3.5`) starts on its selected frame and leaves it at the accumulator's
first crossing, which is tick `ceil(1 / (3.5/60))` = **18**. That segment is
**0.3 s** on a stopwatch against retail, so the list advances 60 times a second;
a 30 Hz list would have given 0.6 s. Everything below is stated in those ticks,
so the durations are `ticks / 60`.

**The node does not mutate the level's material.** `flipState+0` is the bound
*instance* (`node+0x28`, from `EffectNodeBase_CtorBindEntity` `0x0013A848`), and
init builds a **private material override table** inside the node's own 724-byte
allocation — pointer array at `flipState+0x14`, 72-byte copies from
`flipState+0x34` (memset of 612 bytes @`0x00142B9C`). Materials with no flipbook
point back at the shared record (@`0x00142C58`). The frame is applied by an `sh`
into that node-local copy (`0x00142C44`/`0x00142D90`), and the node's draw passes
`flipState+0x10` as its material table (@`0x00142E54`) where an ordinary instance
draw passes `instance+0xF0`. So a flip is a **draw-time per-node override**: two
instances sharing a material never affect one another.

Raw record layout as passed to the ctor (matches SSFHandler.cs read order):
`MainType@+0, ByteSize@+4, SubType@+8, U0@+0xC, Direction@+0x10, Speed@+0x14, Length@+0x18, U4@+0x1C`.

## Node struct offsets (set by ctor `0x00142E98`)

| offset | name | value | evidence |
|---|---|---|---|
| +0x34 | mode | = `U4` | `lw v0,28(s1); sw v0,52(s0)` @0x142F28 — the 0/1/2 state machine value |
| +0x38 | killTicks | = (int)(`Length` × 60.0) | `lwc1 f0,24(s1)`; ×0x42700000 @0x142EDC–0x142EFC; 0 = infinite |
| +0x3C | accum (f32) | = 0 | phase accumulator |
| +0x40 | incCur (f32) | = `Speed` × (1/60) | `mul.s` by 0x3C888889 @0x142F20, `swc1 f1,64(s0)` @0x142F5C; REWRITTEN by the pause path |
| +0x44 | incBase (f32) | = `Speed` × (1/60) | `swc1 f1,68(s0)` @0x142F4C; constant, read only by the pause re-arm |
| +0x48 | frame | = `U0` if ≥ 0, else ceil(8·rand01) | @0x142F38–0x142FC4 (clamped later by SetFrame) |
| +0x4C | direction | = `Direction` | @0x142F0C/0x142F1C; consumed in mode 0 only |
| +0x50 | warmup | = 30 | never read — nothing observable depends on it |
| +0x54 | randomEachAdvance | = 1 iff `U0` == −2 | @0x142FC8–0x142FF4; mode-0 only |
| +0x58 | flipState (embedded) | instance@+0, curFrame@+4, frameCount@+0xC, override table@+0x14/+0x34 | the bound entity, NOT a material; frame count from the material's flip-table entry |
| +0x2D0 | enabled | = 1 | |

## Update `0x001430C0` (per 60 Hz tick)

A node runs on a **phase accumulator**: each tick adds `incCur`, and a frame advances
whenever the accumulator crosses `1.0`. The excess carries into the next tick rather than
being discarded, so the flip rate **does not drift** at any authored speed. `Speed` 0
leaves the node static (`incCur ≤ 0` never advances), and a node given a `Length`
ends itself when `killTicks` expires.

What an advance does depends on the mode:

- **Continuous (`U4` = 0)** — steps exactly one frame per advance, forward or backward
  according to `Direction`, wrapping at either end. When `randomEachAdvance` is set
  (`U0` == −2) and the flipbook has at least two frames, an advance instead picks a
  uniformly random frame rather than stepping.
- **Pause (`U4` ≠ 0)** — alternates dwell and flash, advancing one frame (with wrap) at
  each change. Each change also sets the rate for the *next* phase, which is what makes
  flash a fixed `1/6`-per-tick and dwell a randomized fraction of the authored rate — see
  *Timing consequences* below for the resulting durations.

`Direction` is consumed in continuous mode only; `warmup` is decremented but never read,
so nothing observable depends on it.

The **kill test precedes the accumulate**, at the top of the update
(`0x001430F0`…`0x00143118`, counter at `+0x38`, exit through `vt+0xB0`): a
non-positive counter means *infinite* and skips the test entirely; otherwise the
counter is decremented and written back every tick, and the tick that takes it to
zero ends the node then and there.

So ticks 1…N−1 accumulate and tick N kills **without** accumulating. Because
`incCur` and `killTicks` both scale by the same 60, the advance *count* — and
therefore the parity — is independent of the tick rate the list actually runs at.

## Node death (`vt+0xB0` → `EffectNodeBase_EndNodeWithSlot4Handoff` `0x0013A988`)

The frame is left wherever the last advance put it. The end path tries a slot-4 handoff
(`0x0013AA00`, resolved through `0x00347688`; an instance with `EffectSlotIndex`
−1 has none), restores `instance+0xE8` from its high-half backup
(@`0x0013A9B0`–`0x0013A9D0`, undoing the ctor's `&~0x2 | 0x4` @`0x00143018`),
then runs the flip-state dtor (`0x001499F0`, no write-back), the base dtor
(`0x0013A8E8`), clears `instance+0xE4` (`0x0013AAB8`) and frees the 724 bytes.
The private override table simply goes away, so the instance resumes drawing
through its own material table at whatever the level loader put there.

## Timing consequences

- **Continuous (U4 = 0)**: a frame advances every `1/incCur` = `60/Speed` ticks →
  on-screen rate = **`Speed` fps**, uniform. Authored speeds
  across the five PAL levels: 1, 3.5, 9.5 → 1 / 3.5 / 9.5 fps.
- **Pause (U4 ≠ 0)**: modes 1↔2 toggle forever; each rewrite of `incCur` sets the
  duration of the *next* phase.
  - **Flash** = `1 / (1/6)` = 6 ticks = **0.1 s exactly**, Speed-independent.
  - **Dwell** = `1 / (incBase·u)` ticks, `u ~ U[0.25, 1.0)` → `1/(Speed·u)` s:
    at Speed 1 that is **(1, 4] s, mean (1/0.75)·ln 4 ≈ 1.85 s, median ≈ 1.6 s**
    (uniform in *rate*, not in time). The **first** hold uses the ctor's
    un-randomized `incCur` = exactly `1/Speed` s.
  - `Direction`, the negative-`U0` randomizers, and `Length` (kill timer only,
    any mode) do not participate in the pause path.
- `killTicks` is `Length × 60` decremented once per update, so an authored
  lifetime elapses at exactly `Length` wall-clock seconds — `Length` is literally
  seconds. This is corroborated independently: `EffectThread_Tick` decrements its
  own wait timer by `1/60` per call (`0x0013BEAC`–`0x0013BEBC`), which is what
  makes a chain's authored `Debounce 3.0` mean three seconds.

## The finite-lifetime path: triggered pulses

The five PAL levels author `Length 0` on every flip, so the finite path is
exercised only by levels with ride-over buttons — Tokyo Megaplex authors 77
`Length` 0.5/1.0 flips, all reached by a `MainType-7` hop from a trigger volume's
collision header rather than from any persistent slot.

Such a graph carries **two** nodes, and the second is what picks the colour:

```
node 0: MainType 0 / Sub 11  TextureFlip {U0:0, Direction:0, Speed:3.5, Length:0.5|1.0, U4:0}
node 1: MainType 3           {U0:2, U1:1.0}
```

`EffectThread_Tick` (`0x0013BE80`) loops `DispatchOne` (`0x0013BFD8`) while the
opcode returns non-zero, and both MainType 0 and MainType 3 return 1 — so both
run in the same tick. MainType 3 (`0x0013C070`) calls `[[instance+0xE4]+8]+0xC4`
with `a1 = U0`, `f12 = U1`; on a `cTextureFlipNode` that is the control op
`0x001433E0`, where **command 2 selects a frame** (`sw v0,72(a2)` + `SetFrame`
@`0x00143498`). The same opcode grants clip budget on an animation node, so it
must always be read against the node class the hop targets.

The ctor's own `frame = U0` (= 0) is therefore overwritten before anything
renders. The node then advances on the accumulator until its lifetime expires:
at `Speed 3.5`, `Length 0.5` gives **one** advance (tick 18 of 30) and
`Length 1.0` gives **three** (ticks 18/35/52 of 60). Both are ODD, so a
two-frame material ends on the frame it started the level with — which is what
makes the node's death invisible. That is not an accident; it is what turns a
flip node into a momentary pulse.

The resting frame is set at load, not by the node: `Course_RemapMaterialTextureIds`
(`0x00260C28`) writes `material->TextureID := flipbook[0]` (`lhu v0,4(a3)` /
`sh v0,0(t1)` @`0x00260CF8`). So the sequence a player sees on one crossing is
frame `U1` immediately, an odd number of steps back, then frame 0 again. Retail
observation of the megaplex buttons matches: they read green (frame 0), flash red
(frame 1) for roughly a third of a second on a crossing, and return to green;
crossing again repeats it with nothing carried over. The barricade that opens
alongside is the sibling `Sub256 AnimObject` hop and is a separate one-shot,
which is why re-crossing does not extend it. [measured]

## Authored data census (the five PAL levels)

`U4` is only ever 0 or 1. Every `U4 = 1` record is `{U0: 0, Direction: 0,
Speed: 1, Length: 0}` on a two-equal-frame flip list (the LCD dwell screens —
12 materials: GARI 4 / MERQUER 1 / MESA 2 / SNOW 2 / ELYSIUM 3), so frame 0
dwells and frame 1 flashes. Function labels and struct fields are persisted in
`analysis.sqlite`.

## How OpenSlope implements it

`snowknife MaterialBundle` emits the law as the manifest material record's
`Dwell = [1/Speed, 0.1]` (frames stay `[A,B]`); `FlipbookAnimator` runs the
same machine per slot — first hold `1/Speed`, then `base/u` re-rolled each cycle,
flash fixed. Continuous flips use `FlipSpeedScale = 1` (authored `Speed` is the
on-screen fps).
Only a **persistent** flip reaches that path at all: `Flip.json` records
`Length 0` nodes and nothing else, so a material's frame list never animates on
the strength of having frames.

Triggered pulses are replayed offline instead of re-simulated — `snowknife`
`TriggeredFlipClassifier` walks the M7 hops, reads the MainType-3 selected frame,
runs the accumulator over `killTicks`, and ships the resulting (frame, hold)
segments on the button's diverted prop record; `ButtonU` just walks that list
on a crossing. The megaplex's two shapes are `[1,0]` holding `0.30/0.20 s` and
`[1,0,1,0]` holding `0.30/0.28/0.28/0.13 s` — the first of which is the
stopwatch measurement the 60 Hz tick rests on.
Spec: [`410-texture-animation.md`](../specs/410-texture-animation.md) (playback
+ pause mode), [`230-level-ssf.md`](../specs/230-level-ssf.md) (Sub11 fields).
