# PINE — reading SSX Tricky's live state out of PCSX2

Read-only inspection of a running (ideally paused) PCSX2 session over its PINE socket. Built to
answer questions about **animated world props** that otherwise cost a full authoring → export →
repack → look-at-it cycle: with these you author a canary once, then read the engine's own computed
matrices directly.

Everything here emits only PINE read opcodes (`Read8/16/32/64`) plus the three informational
messages. **There is deliberately no write, savestate or loadstate path anywhere in this folder** —
a stray write into a live session can corrupt or crash it, and these tools exist to observe.

## Setup

Enable PINE in PCSX2 (`Settings → Advanced → PINE`, default slot 28011) and load a level. Pause
before dumping: a paused session gives a coherent snapshot, and every offset below is read from one.

No dependencies — plain Node ESM, run from this folder.

```
node ee-dump.mjs                    # snapshot all 32 MB of EE RAM -> ee.bin (~1.5 s)
node anim-nodes.mjs                 # list every live AnimObject / AnimDelta node
node anim-nodes.mjs 859dc0          # full per-sub-object dump for one node
node anim-nodes.mjs --refresh …     # re-snapshot first, then run the above
node dis.mjs 1cb990 60              # disassemble 60 R5900 instructions at 0x001cb990
```

`ee.bin` is a 32 MB dump and is gitignored. PINE takes ~40,000 batched `Read64` commands per message
(120,000 fails with status 255), giving roughly 100 MiB/s — dump once, then work offline against the
file rather than round-tripping per read.

| file | what it does |
|---|---|
| `pinelib.mjs` | the read-only client: framing, batched `readBlock`, `bxStringHash` / `instanceHash` |
| `ee-dump.mjs` | whole-EE snapshot to `ee.bin` |
| `anim-nodes.mjs` | **the main tool** — live animation nodes, per-sub-object channels, base vs live values, the computed 4×4, and where each local axis lands |
| `order-check.mjs` | fits all six Euler composition orders against measured matrices |
| `formula.mjs` | checks the transcribed `BuildLocalMatrix` closed form against `transpose(Rz·Ry·Rx)` |
| `dis.mjs` | small MIPS R5900 disassembler over `ee.bin` |

## Build dependence

**Every address here is PAL Europe, `SLES-50545`** — the same baseline as the rest of the spec
(`specs/002-conventions.md`). They will not transfer to an NTSC disc without being re-derived; the
structure *shapes* should, since they come from the same code.

Verify with `node -e "import('./pinelib.mjs').then(async m => console.log(await (await new m.Pine().connect()).info()))"`
before trusting a reading.

## What was established with these

Offsets and findings are written up in `../../research/extracted-data.md` §Runtime animation
records, and the behavioural conclusions in `../../specs/120-objects.md`. In short:

- the instance hash table is at `0x012c7a40`, 3518 sorted `(entityPtr, hash)` pairs;
- an animated sub-object's record is 0xD0 bytes, with live channel values at `+0x4c`..`+0x60` and
  the consumed 4×4 local matrix at `+0x90`;
- an animated object's rotation comes from its **channels** alone, and multi-channel rotation
  composes **ZYX**;
- an animated model may carry at most **27 total packed native `ModelObjects`**. The 28th overruns
  `sub_00199818`'s fixed stack matrix workspace; this counts static roots and mesh-less mounts, not
  just animated records or hierarchy depth.

**Identify props structurally, not by name hash.** `bxStringHash` is a 28-bit ELF hash; reversing
live hashes back to authored names collided for 101 of 238 candidates and produced two confidently
wrong matches. Base translations plus channel masks are unambiguous — that is how the canaries in
`Slopesmith/tools/re-canaries/` are located.
