# 015 — Audio extraction (music + sound effects)

How SSX Tricky's audio is found, decoded, and exported as portable WAV assets, including the
non-obvious format details needed to make those files sound right. Unity placement and playback are a
separate consumer concern documented by the Unity library.

Code: `Export/AudioExporter.cs` (orchestration + WAV writer), `Services/AudioService.cs` (the
`intro-music` / `sfx` / `sound-index` / `board-sound-index` / `bnk` / `audio-file` commands,
`import` step 8), and
`Services/SoundIndexService.cs` (BANKS.INF plus boot-ELF routing). Decoders live in the `swax`
SSX-Library fork: `FileHandlers/Audio/EAAudioHandler.cs` (SCHl streams), `BnkHandler.cs` (BNKl banks),
`EaXaCodec.cs` (EA-XA ADPCM), and `PsAdpcmCodec.cs` (PlayStation ADPCM).

## TL;DR

Audio lives in `DATA\AUDIO\*.BIG`. Two containers, **three** codecs, all decoded in pure C# and
verified **byte-exact against vgmstream**:

| Source | Container | Codec | Used for |
|---|---|---|---|
| `<level>.BIG` (e.g. `<LEVEL>.BIG`) | EA **SCHl** stream | **EA-XA** (`0xA0`==`0x0A`) | the level's start-gate INTRO music stems |
| `AUDIO.BIG` member `*.bnk` | EA **BNKl** bank | **PS-ADPCM / VAG** (default, no `0xA0`) | crowd, ambient loops, voices |
| `AUDIO.BIG` member `*.bnk` | EA **BNKl** bank | **S8** PCM (`0xA0`==`0x09`) | board / short SFX (e.g. `zboard.bnk`) |

EA-XA also turns up *inside* a bank (`0xA0`==`0x0A`; one course's `Wind1.bnk` is one) — same 15-byte frame as the
streamed music, verified byte-exact (see [gotcha 2](#2-frame-size-is-the-codecs-not-the-containers)).

The split follows the lightmap precedent ([007](../../Unity/docs/unity/007-terrain-lighting.md)): the reusable **format/codec**
knowledge is in the library fork; the **orchestration** (pull from ISO, name files, write WAVs) is in the
CLI. `snowknife import` decodes both the music (step 8) and the level's SFX banks; `snowknife sfx <iso> <courseSlot> <mapDir>`
re-runs just the SFX, and `snowknife bnk <file.bnk> <out>` decodes any one of `AUDIO.BIG`'s ~170 banks. Which
banks belong to a level comes directly from that disc's `DATA/CONFIG/BANKS.INF`. Snowknife also interprets
the boot ELF's collision-event resolver and writes the joined result beside the WAVs as
`Audio/SoundIndex.json`; `snowknife sound-index <iso> <courseSlot> <mapDir>` regenerates only that small file.
The same pass writes `Audio/Environment.json`, the explicit OpenSlope off-board fallback contract. Its current
default is `Wind1/000` at gain `0.15`, and `snowknife sfx` always decodes that named bank so consumers never
infer a background choice from the retail event dispatcher. This is deliberate port policy, not evidence of
a retail per-course wind bed; Trailmap 420 retains the zero-emitter/no-course-load finding.
The same service recognizes the executable's board-surface dispatcher and interprets its constant-return
handlers into `Maps/Shared/Audio/BoardSoundIndex.json`. `snowknife shared` writes it during shared-data
bootstrap, while `snowknife board-sound-index <iso> <sharedDir>` refreshes it independently. Slopesmith reads
that local sidecar, so the surface routing is neither duplicated in its source nor inferred from level names.

**Referenced-but-missing course-bank slots get filled from a sibling course** (`FillMissingCourseSlots`):
course-bank slot meanings are global (the engine's event-id→slot table is one table for every level, and the
SSF `SoundPlay` path plays its id raw from the course bank), but each level's bank ships only a subset — and
the engine has **no empty-slot fallback**, so a referenced-but-unshipped slot is silent in the real game
(a `Bomb_Event` prop's `SoundPlay 83` vs a course bank's empty slot 83). After decoding, `snowknife sfx` reads the
level's `Effects.json` (when it sits in the output folder), finds `SoundPlay` ids with no `NNN.wav` in the
course bank, and decodes that slot from the first sibling course bank that ships it,
printing each fill — better-than-game by design, and auditable.

## How the game stores audio

`DATA\AUDIO\` holds: per-level **music** BIGs (one `<LEVEL>.BIG` each; ~1–2 MB), the shared
**`AUDIO.BIG`** (13.7 MB, ~170 SFX banks), and the big **`MUSIC.BIG`** / **`SPEECH.BIG`** /
**`JUKEBOX.BIG`** (the soundtrack, announcer, and jukebox; 250–680 MB).

**The music BIG is 16 music stems** — `A1…A4`, `B1…B4`, `C1…C8`, plus `end` — each an EA SCHl
stream, all the same length. They're the level's **intro music** (`data/config/intromus.inf` maps each
track to its BIG; `audio.inf`'s `INTRODUCK` ducks it under speech): the start-gate / course-intro bed,
in three intensity arrangements plus an outro sting. The **in-race** soundtrack is the separate EA
PathFinder system (`MUSIC.BIG` `.mpf`+`.mus` songs, `musicmap.inf` per-track playlists —
[039](039-race-audio-extraction.md)). How the stems fit together is its own section,
[below](#how-the-intro-music-fits-together).

Everything is EA's audio family, so two file shapes recur:

### EA SCHl streams (the music)
A `SCHl` header (magic, size, platform), then a **patch list** — tagged fields, each `[tag][len][big-endian
value]`: `0x80` version, `0x82` channels, `0x84` sample rate, `0x85` sample count, `0xA0` codec, `0xFF`
end. Then `SCCl` (a block count) and **N × `SCDl` data blocks**. PS2 streams omit the `0x84` rate, so we
default to **22050 Hz**.

A PS2 EA-XA `SCDl` block is `[SCDl][size][block_samples][per-channel data offset × nch][reserved][channel
data]` — channel data starts at **block + 0x18** for stereo. Each channel's region is a run of EA-XA
frames; the predictor history carries continuously across blocks.

### EA BNKl banks (the SFX)
`[BNKl][version @0x04][sound count @0x06][…]`, then a **uint32 entry table** (at `0x14` for v4/v5, `0x0C`
for v2 — [Trailmap: 260-audio-files]). Each entry is a *relative* offset: `header_offset = entry_position + value`; a `0` entry is an
empty slot. Each sound's header is a 4-byte platform word (`"PT"` + platform) followed by **the same patch
tag-stream as SCHl** — so the SCHl patch parser is reused verbatim. Extra tags appear here: `0x88`/`0x89`
(per-channel data offset), `0x86`/`0x87` (loop start/end), `0xFC`/`0xFD` (no-payload markers), `0xFE`/`0xFF`
(terminators). Unlike streams, **bank sample data is contiguous raw frames** at the `0x88`/`0x89` offsets —
no `SCDl` wrapper.

### The three codecs
- **EA-XA** (`0x0A`) — 4-bit ADPCM. Frame = 1 header byte (`coef index`<<4 \| `shift`) + 14 data bytes →
  28 samples, **high nibble first** (a **15-byte** frame). `coef = EA_XA_TABLE[index]`, `shift = (h & 0xF) + 8`,
  `s = ((nibble<<28)>>shift) + coef1·h1 + coef2·h2 + 0x80; clamp16`. The `+0x80` rounding and **clamped**
  history are part of the codec — *not* the container — so EA-XA decodes identically whether it's a streamed
  SCHl block or a bank sound (verified on `Wind1.bnk`, [gotcha 2](#2-frame-size-is-the-codecs-not-the-containers)).
- **PS-ADPCM / Sony VAG** (the PS2's native SPU format) — 4-bit ADPCM. Frame = 16 bytes:
  `[predictor<<4 | shift][loop-flag][14 data]` → 28 samples, **low nibble first**. VAG coef table
  `f0={0,60,115,98,122}`, `f1={0,0,-52,-55,-60}`; `s = ((int16)(nibble<<12)>>shift) + ((f0·h1+f1·h2)>>6)`;
  output `clamp16`, history **un-clamped** (see gotcha 3).
- **S8** (`0x09`) — uncompressed signed 8-bit PCM; `sample16 = (sbyte)byte << 8`.

## How the intro music fits together

The music BIG's 16 stems are the **course theme in three intensity arrangements plus an outro**, and the
layout itself tells you how the intro bed was arranged — these numbers come straight from the
decoded WAVs (equal length, per-stem RMS, and a full cross-correlation matrix):

| Tier | Stems | Loudness | Role | Internal structure (correlation) |
|---|---|---|---|---|
| **A** | A1–A4 | ~−19 dB (quiet) | low intensity — cruising | 4 *distinct* phrases (mutual corr ~0.1) |
| **B** | B1–B4 | ~−11.6 dB (loud) | mid intensity | 2 pairs — {B1,B2} near-twins (0.92), {B3,B4} (0.55) |
| **C** | C1–C8 | ~−11.6 dB (loud) | high intensity | 2 groups of near-twins — {C1–4}, {C5–8} (~0.9 within, ~0.5 across) |
| **end** | end | ~−25 dB, half length | outro sting | — |

Three things fall out of the data:

- **Every stem is exactly the same length** — 128 291 frames = **5.818 s** at 22 050 Hz, grid-aligned from
  sample 0 (`end` is exactly half, 2.909 s). That sample-exact equality is the engineering tell: the engine
  swaps stems at the loop boundary, which only works if they're identical length and share a downbeat.
- **A/B/C is an intensity ladder, not song sections.** Every A stem sits ~7 dB quieter than every B/C stem,
  uniformly, and the three tiers are mutually *uncorrelated* (A1 vs B1 ≈ 0.00) — they're genuinely different
  re-orchestrations of the theme, not the same audio at different volume.
- **The numbers are interchangeable variant bars**, cycled so a tier doesn't audibly repeat. C carries the
  most (8) because that's the "money" state where you spend the exciting seconds; A's four are the most
  distinct (real melodic movement), while B/C's consecutive bars are near-twins (a relentless groove with
  small fills).

And one thing the data **rules out: these are swapped one-at-a-time, not layered.** Each B/C stem is already
at ~−11.6 dB with peaks near full-scale, so summing two would clip hard — there's no vertical multitrack mix
here, just **horizontal re-sequencing** (play one full-mix bar, crossfade to the next at the boundary).

What's *not* in the data: the actual transition rules — what trips A→B→C, whether variants advance
in order or at random, the crossfade length. Those live in the game's music-manager code; the `.BIG` ships
no sequencing table and the SCHl streams are pure PCM (no loop points on the PS2 music streams either).
The music director ([Unity 015](../../Unity/docs/015-audio-runtime.md)) sequences these stems by design. The **in-race**
soundtrack is the separate PathFinder song system — graph data the game DOES ship, decoded in
[039](039-race-audio-extraction.md).

## Our approach

1. `snowknife` pulls `DATA\AUDIO\<level>.BIG` from the ISO, unpacks it, and decodes every SCHl member to
   `Audio/Music/<name>.wav` (`AudioExporter.ExportMusic`). Wired into `import` as step 8; also standalone via
   `snowknife intro-music <iso> <courseSlot> <mapDir>`.
2. `snowknife bnk <file.bnk> <out>` parses a BNKl bank, decodes each sound by its codec, and writes
   `<bank>/NNN.wav`. `--verbose` dumps each sound's parsed patch tags (how we reverse-engineered the format).
3. Decoders return raw PCM; the CLI writes the canonical 44-byte WAV header. The decoded set lands in the
   `Maps/<LEVEL>/Audio/{Music,SFX}` intermediate, with `Audio/SoundIndex.json` carrying explicit event routes
   and bank paths recovered from the same disc; `snowknife unity` stages it into the project's
   `Assets/OpenSlope/Maps/<LEVEL>/Audio/` (gitignored).

## What we learned (the gotchas)

### 1. The crowd "static" was a wrong codec, not a decode bug
The BNK crowd/ambient sounds carry **no `0xA0` codec tag**, so we first defaulted them to EA-XA. They
decoded to recognizable-but-static audio — because they're actually **PS-ADPCM (the PS2's native VAG)**,
not EA-XA. Both are 4-bit ADPCM with similar frame shapes, so the wrong codec reproduces the rough envelope
but mangles the detail → broadband static. vgmstream's metadata (`encoding: PlayStation 4-bit ADPCM`) was
what finally named it. **The default when there is no `0xA0` tag on PS2 is PS-ADPCM**, with `0x09` → S8 and
`0x0A` → EA-XA called out explicitly.

### 2. Frame size is the *codec's*, not the container's
EA-XA frames are **15 bytes** (header + 14 data); PS-ADPCM frames are **16 bytes** (it spends a byte on its
loop-flag). The trap is assuming the *container* sets the stride. It doesn't — the codec does. We first
decoded the PS-ADPCM crowd with the 15-byte EA-XA stride, which drifts one byte per frame; the accumulating
misalignment is the **"crinkly popcorn."** The 16-byte PS-ADPCM stride is provable from the data: the sound's
byte length is exactly `frames × 16`, and the loop-flag byte recurs every 16 bytes.

The symmetric trap bit us the other way on EA-XA-*in-a-bank*. We'd guessed (untested, no sample) that a bank
would pad EA-XA to 16 bytes with a reserved byte, and decoded it with a 16-byte stride + no rounding. A course's
`Wind1.bnk` (one EA-XA sound, `0xA0`==`0x0A`, 165 536 samples) was the first real sample, and it ran off the
end of the buffer: `165536 / 28 = 5912` frames × 16 = 94 592 bytes, but only ~88 700 are there. At **15** bytes
it's `5912 × 15 = 88 680` — a near-exact fit. So EA-XA-in-bank is the **same 15-byte v1 frame as SCHl**, full
stop; vgmstream agrees (`encoding: EA-XA 4-bit ADPCM v1`) and our decode is **100 % byte-exact** once the
stride is 15 and the `+0x80` rounding is back. (The `headerGap`/`round` knobs on `EaXaCodec.DecodeChannel`
survive for any future variant, but every EA-XA we've seen — stream or bank — wants gap 0 + rounding.)

### 3. PS-ADPCM feeds back the *un-clamped* sample
The decoder clamps its **output** to int16, but the predictor history (`h1`/`h2`) keeps the **full-precision**
value — the SPU carries extra internal precision before the output stage. This only changes samples that clip
hard (≈0–3 % of samples on 3 of ~90 course sounds). We A/B'd clamped vs un-clamped by ear: **audibly identical**.
We kept un-clamped because it's the hardware-accurate model and matches vgmstream byte-for-byte — i.e. anyone
can re-verify correctness with a one-line diff. (EA-XA, by contrast, clamps its history, and *that* matches
vgmstream for the music. The two codecs genuinely differ here.)

### 4. One patch parser, reused
The BNK per-sound header is the same tagged field stream as the SCHl header (after a 4-byte platform word),
so channels/rate/sample-count/offsets/loop-points all parse with the same code. Reverse-engineering it was a
matter of dumping the raw tags (`bnk --verbose`) against a real bank and reading off which tag carried what.

## Decode validation

We used **vgmstream** (r2117, `vgmstream-cli -i -s <subsong> <file>`) as a ground-truth oracle and diffed its
output against ours sample-by-sample. Results are **100 % byte-exact** across every path: EA-XA music
(256 582 int16s on stem `A1`), EA-XA-in-bank (`Wind1.bnk`, 165 536 samples — see gotcha 2), mono PS-ADPCM
(Crowd 1/2/3, 681 k samples), stereo PS-ADPCM (the one 2-ch sound — confirms L/R order), and S8. The
crowd / course-bank output was also ear-confirmed clean.

vgmstream is a **debug oracle only** — it is not a build or runtime dependency, and the shipped decoders are
pure C#. A 100 % vgmstream match proves our decode equals the de-facto reference (itself validated against
real hardware over ~20 years); it does **not** independently validate metadata that doesn't affect the
samples (sample rate, loop points). Those read as standard values and sound correct, but a real-PS2 / PCSX2
capture is the only true hardware check if ever needed.

## Unity runtime handoff

Decoded assets are consumed by the Unity importer, spatial-audio wiring, surface-audio setup, and music directors. That implementation now lives in [Unity 015 — Audio runtime](../../Unity/docs/015-audio-runtime.md).

## See also

[001 — CLI export pipeline](001-cli-export-pipeline.md), [039 — Race-audio extraction](039-race-audio-extraction.md), [Unity 015 — Audio runtime](../../Unity/docs/015-audio-runtime.md), and [Trailmap: 190-audio-data, 260-audio-files, 420-audio-runtime].
