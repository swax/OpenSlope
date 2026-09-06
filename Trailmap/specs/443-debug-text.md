# 443 — Debug text (ELF patch)

A **byte patch to the boot executable** that gives SSF main type 12 a body: an authorable effect node
that puts a line of text on the in-race HUD while the rider is on the course. Retail sends main type 12
to its dispatcher's inert default, so a level carrying such a node runs unchanged on a stock
executable — the node and the patch are only useful together. Applied to any pipeline ISO by
`snowknife repack … --patches hud-text`, which also decides whether the nodes reach the disc at all;
authored by `tools/patches/debug_text_patch.py` (this workspace). [[443-overview]]()

> [[443-overview]]() db:elf; boot ELF SLES_505.45 (PAL) and SLUS_203.26 (NTSC-U).

## Per-build targets

The patch is authored against **both** builds. Everything it depends on structurally is shared:
the ring's stride and slot fields, the node's payload layout, the step from a rider to its
trick-score state. Every hooked region is the **same instructions** in both executables — the banner
branch, the numeric loop and the dispatcher were compared word for word across the whole window each
hook sits in, and the only divergences are absolute (a jump target, a `lui` half, or the low half of
a global paired with one). So the NTSC-U anchors were **found by matching the PAL instruction
window** rather than by re-reading the code, and each match is unique in the image.

A match that is merely unique is not a match that is right, so each one is checked against the
executable it names rather than accepted from the search: the hook sites hold the words the patch
expects to replace, entry 12 is that build's **own** inert default, the ring slot survives in its
register all the way to the call, and the HUD's colour block is re-derived from the retail draw's
own store. The section layout mirrors PAL's, which puts both alignment gaps at the same **sizes** —
but they were re-vetted in NTSC-U rather than assumed from it. [[443-targets]]()

> [[443-targets]]() db:elf; PAL SLES_505.45 vs NTSC-U SLUS_203.26 — banner `jal LocString`
> 0x001A52C0 / 0x001A4DC8; slot formed at 0x001A51B8 / 0x001A4CC0; `LocString`
> 0x002C6338 / 0x002C5160; jump table 0x0036C830 / 0x0036B630, entry 12 at
> 0x0036C860 / 0x0036B660; shared epilogue 0x0013C5B0 / 0x0013C5A8;
> `AddHudScoreEvent` 0x00157348 / 0x00157330; numeric kind-10 test 0x001A653C / 0x001A6044,
> body 0x001A6544 / 0x001A604C, tail 0x001A6630 / 0x001A6138; HUD text colour
> block 0x003391E8 / 0x00337FE8; caves 0x003BCA90 / 0x003BB790 (112 B) and
> 0x003BCBD8 / 0x003BB8D8 (40 B). Everything after `.text` sits 0x1200 lower in NTSC-U, which the
> colour block agrees with independently — the numeric loop's own `lui a1,0x34` global moves
> 0x003393E4 → 0x003381E4 by the same amount.

## What the HUD already does

The in-race HUD keeps a **twelve-slot event ring** on the rider's trick-score state. One poster
fills a slot and the HUD renderer walks the ring once per frame, with a separate scan loop per event
**kind**. A slot carries its kind, one free **value** word, one free **aux** word, and a pair of
floats — the lifetime it was posted with, and how much of that has elapsed. [[443-ring]]()

Kind **10** is the **CHECKPOINT** banner, and it is **two draws half a lifetime apart**. One loop
resolves a **fixed** localization string id (3648) through the shared string lookup and draws the
result over the **first** half of the slot's lifetime. A second loop draws a **signed time** over
the **second** half, formatted from that same slot's **value** word — which for a checkpoint is the
seconds it awarded. Both sit behind the same HUD-detail bit, and nothing about either is
checkpoint-specific except the id one hardcodes and the units the other assumes. [[443-kind10]]()

> [[443-ring]]() `AddHudScoreEvent` 0x00157348 — 12 slots × 0x14 at `state+0x15C`, and the state is
> `boarder+0x5820`; slot fields `+0x00` kind, `+0x04` value, `+0x08` duration (f32),
> `+0x0C` elapsed (f32, counts up), `+0x10` aux; the
> initialiser 0x00157490 stores a3 at `+0x10`, f12 at `+0x08`, a1 at `+0x00`, a2 at `+0x04` and
> zero at `+0x0C`. Kinds in retail use: 1 final score, 2 spin, 3 flip, 4 KNOCKDOWN!, 5 landed,
> 6 pickup points, 7/8 uber, 9 multiplier, 10 CHECKPOINT, 11 TIME BONUS, 12 gem badge, 13 laps,
> 15 held grab, 16 big air, 17 lesson.

> [[443-kind10]]() the TEXT branch is 0x001A5258..0x001A52DC inside the renderer 0x001A546C; the
> slot pointer is formed at 0x001A51B8 (`addu v1, s7, v1`) and is not reassigned before the
> branch's string call; the string id is the immediate at 0x001A52A4 and the lookup is
> `LocString(buf, id)` 0x002C6338, called at 0x001A52C0. Its fade gate at 0x001A5288 draws while
> `2·elapsed/duration < 1`. The NUMERIC loop is 0x001A6478..0x001A6630, reaching kind 10 by falling
> through its kind-11 test (`bne a0, v1(=11)` at 0x001A648C → 0x001A653C, `bne a0, v0(=10)` →
> 0x001A6630); it reads the slot's value at 0x001A6578, picks '+' or '-' at 0x001A65B8/0x001A658C
> and formats through the time helper 0x001A7098, whose clamp string is `59:59.99` (0x0038F4F0).
> Its gate at 0x001A6564 is the complement — it draws while `1 < 2·elapsed/duration`. Both loops
> sit behind a HUD-detail test at 0x001A5170 (`lw a3, 0x104(s4)`, bit 0x00400000), measured open on
> a live showoff run.

## What the patch adds

**Three hooks, no new rendering.** The banner, its layout, its fade and its lifetime are all the
retail ones; only where its text comes from — and which of its two draws applies — changes.

| Hook | Purpose |
| --- | --- |
| opcode jump table entry 12 | give main type 12 a handler that posts a ring slot |
| the text loop's string call | return the slot's text pointer when the slot is this patch's |
| the numeric loop's kind-10 test | leave this patch's slots to the text loop alone |

An effect-opcode handler is entered holding **the effect thread** and **the node it is running**, and
the thread carries the rider the chain is firing for — the same route the boost-meter and speed-pad
opcodes take to reach theirs. From that rider the trick-score state is a fixed step away, and it is
exactly what the ring's poster takes. So the handler is a dozen instructions: post kind 10 with the
node's inline text as the **value** and a **sentinel** as the **aux**, then rejoin the dispatcher's
shared epilogue with the return value that means *continue the chain*. [[443-handler]]()

The shim discriminates on the **aux word**, not on the value's sign or magnitude. The retail
kind-10 poster writes a **negative** payload into the value word, so every range or sign test
aliases against real checkpoint crossings; aux is written by the same initialiser, is zero on every
retail poster, and is read by nothing in the renderer. A slot without the sentinel gets the stock
id and the stock lookup, so retail behaviour is unchanged rather than merely unlikely to be
noticed. [[443-shim]]()

The **third** hook exists because the second draw is easy to miss: a text pointer read as seconds
renders as the time helper's clamp, `+59:59.99`, in green, immediately after every message. Adding
*and the aux word is zero* to that loop's kind-10 test keeps the number with the checkpoints it
describes. Two hooks looked sufficient right up until a run was watched rather than only reported —
the harness records the banner and had nothing to say about what was drawn next to it.
[[443-numeric]]()

> [[443-numeric]]() the hook replaces `bne a0, v0, 0x001A6630` at 0x001A653C with a jump; that
> branch's delay slot 0x001A6540 (`addiu a1, a1, 1`, the loop counter) runs before the transfer, so
> the retail path re-enters at 0x001A6544 rather than at the delay slot.

> [[443-handler]]() handler entry registers s0 = effect thread, s1 = node; rider at `thread+0xE8`,
> trick-score state at `rider+0x5820`; return `v0 = 1` continues the chain.
> dispatcher `EffectPayload_OpcodeDispatcher` 0x0013BFD8; jump table 0x0036C830,
> entry 12 at 0x0036C860 = 0x0013C5AC (the inert default) in retail; shared epilogue 0x0013C5B0;
> entries 12/19/20/22 are all wired to that default, so four opcodes were free.

> [[443-shim]]() retail's kind-10/11 poster 0x00155C78 converts its float argument with `cvt.w.s`
> and negates it for kind 10, and passes `a3 = 0`; the only other kind-10 writer is the checkpoint
> handler `RaceCheckpoint_Handler` 0x0011E700, gated to game modes {3,5}.

## The text rides in the node

Effect nodes are **variable length**: a node is `MainType`, `ByteSize`, payload, and the chain
walker advances by that size field. So a main-type-12 node carries its message inline as
**NUL-terminated UTF-16LE**, needing no string table in the executable and travelling with the
level. The engine's string routines are 16-bit throughout — the localization file is UTF-16LE and
the HUD's formatter is a wide `sprintf` — so the text the shim hands back is the same shape
`LocString` would have returned. [[443-inline]]()

The payload carries **three colour channels ahead of the string**, and that order is what makes one
word reach both. The ring gives the shim a single value word; pointing it at the text puts the
colour at a fixed step behind it, so the shim copies R, G and B straight into the block the HUD
writes immediately before each draw. It stores **after** retail's own write and before the draw,
which is the one position where an override neither fights the fade nor persists past the banner.
The alpha word above the three is retail's fade and is left alone. [[443-colour]]()

> [[443-colour]]() payload layout R, G, B (f32) then the string, so the text pointer is
> `node + 8 + 12` and the channels are at `-12`, `-8`, `-4` from it; the HUD colour block is four
> f32 — alpha, R, G, B — written per draw, 1,1,1 by the text loop and 0,1,0 / 1,0,0 by the numeric
> one. The writer defaults an unset channel to 1.0, so a node authored without colour draws white,
> which is what the unshimmed banner draws.

Node size **must stay a multiple of 4**: the walker adds it to a byte offset and the next node's
main type is read with a word load, which faults unaligned on the EE. The writer pads accordingly.
[[443-inline]]()

> [[443-inline]]() chain walker 0x0013BF2C..0x0013BF4C — `a1 = [node+4]`, `a0 += a1`,
> `[thread+0x3C] = a0`; `LocString` 0x002C6338 returns a pointer into the loaded `.LOC` image,
> whose strings are UTF-16LE; the 16-bit string length helper is 0x002C64D0.

## Caves

**Two alignment gaps**, both in the same shape: all zero, inside the executable's single RWX load
segment, and carrying **no reference of any kind** — no 32-bit pointer anywhere in the image, no
`lui`+low-half pair constructing an address in it, and no branch or call target. The gap between
`.rodata` and `.gcc_except_table` (112 B) holds the handler and the shim; the one between
`.gcc_except_table` and `.sdata` (40 B) holds the numeric skip. The split is not aesthetic: once the
shim also copied colour, the three no longer fit one gap, and the skip is the routine with no reason
to sit next to the others. Each is left with 8 B spare.

They are deliberately **not** the dead-code blob the noclip patch draws from — that blob's free tail
is the input-ring probe's working space, and taking any of it costs that tool half its buffer.
[[443-cave]]()

> [[443-cave]]() gaps 0x003BCA90..0x003BCB00 (112 B, 104 used) and 0x003BCBD8..0x003BCC00 (40 B,
> 32 used) on PAL; handler 44 B, shim 60 B, skip 32 B, and identical lengths on both builds. The
> noclip blob is 0x002B4C40..0x002B50C0 with noclip itself topping out at 0x002B4EB8, and
> `tools/instrumentation/input_ring.py` sizes its ring from what is left above that.

## Authored data

The node is authored like any other: main type 12, semantic type `hud.message`, with the message
under the payload's `HudText` key and its colour under `HudRed` / `HudGreen` / `HudBlue`. Slopesmith
calls it **Show message**. The name is in the interchange schema's own vocabulary rather than its
`x-` experimental namespace, which is the claim that this opcode is a settled part of the authoring
surface and not a trial.

`repack --patches hud-text` is one selection doing both halves — keeping the nodes and baking the patch —
because either alone shows nothing. **Without** the flag the repack strips the nodes on the way to
the SSF, so an ordinary disc carries no main type 12 at all.

The **patch** keeps the name `debug-text`, and the difference is deliberate: what an author places
is a message on the HUD, while what this does to a retail executable is give a dead opcode a body
for debugging. The RE side names a patch by what it does to the game.

Reading such a disc back needs reader support: a main type with no branch used to abandon the rest
of its chain, so an unknown opcode silently deleted itself and every node after it. That is now a
skip-by-size that keeps the bytes, which makes any future opcode survive a round trip rather than
only this one.

## Verifying it

The banner path is checkable live, with no ISO build, through
`tools/instrumentation/hud_message_probe.py`: it installs the patch into EE RAM over PINE, parks a
coloured string in scratch, posts a slot by hand and reverts. It reads which build the emulator is
running and follows it. Posting a slot with **aux 0** is the negative control — it must still read
CHECKPOINT. Its scratch is **not** part of the patch and never reaches a disc: the two gaps have 8 B
left between them, so the probe uses `.sbss`/`.bss` alignment padding, which the loader allocates and
zeroes but no shipped byte occupies. [[443-scratch]]()

> [[443-scratch]]() 0x003BCFA4 / 0x003BBCA4, 92 B, past the load segment's `filesz` and inside its
> `memsz`; laid out colour-then-text like a node, so the probe exercises the shim's colour copy too.

The autotest harness carries the other half. A fixture built with `--patches hud-text` puts a message node
behind each cell's debounce, and `verdict.py` samples the ring every tick and records one entry per
**posting** — the transition into occupancy, not per-frame presence. A banner is a second witness to
dispatch that shares no mechanism with the live-node slot the cells are graded on: it is posted by
the engine from the effect chain itself. `run.py --region usa` rides the same fixture on the NTSC-U
disc.
