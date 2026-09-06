# 260 — Audio Containers and Codecs

All audio ships in two containers, four codecs, and two small sidecar
files. The **SCHl** streamed container carries music stems (intro music
archives), the in-race music chunks inside `.mus` files
(`270-music-graph.md`), and speech banks (runs of streams in one `.dat`).
The **BNKl** bank container carries the SFX banks (`.bnk` in the shared
audio archive) and the interactive-music system's per-song async loop banks
(`.bnk` in the music archive, `270-music-graph.md`). The codecs are EA-XA
ADPCM (music), PS-ADPCM (the PS2 bank default), signed 8-bit PCM (short
SFX), and the MicroTalk speech vocoder.
The two sidecars are the per-level `.adl` (binds collision sounds to
instances) and the text config `BANKS.INF` (binds bank groups to `.bnk`
files), both below. Bank/slot/group *semantics* — groups, event remaps, the
no-fallback rule, instance sound binding — are `190-audio-data.md`; this
chapter is the bytes and the codec math. [observed] [[260-overview]]()

A codec id identifies the coding in both containers: 0x04 = MicroTalk,
0x05 = PS-ADPCM (also the default when no codec tag is present), 0x09 =
signed 8-bit PCM, 0x0A = EA-XA. [measured] [[260-codec-ids]]()

> [[260-overview]]() music, bank, and speech containers all have a working
> decode; container split per the disc inventory in `200-archives.md`.

> [[260-codec-ids]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/BnkHandler.cs
> `DecodeSound`/`ParsePatchHeader` defaults,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EAAudioHandler.cs
> `Codec`; each verified against vgmstream as the decode oracle. Note: a
> stale BnkHandler comment claims the no-tag default is EA-XA; the code and
> the original crowd-static bug establish PS-ADPCM 0x05.

## SCHl streamed container

A stream is a sequence of chunks, each `[4 ASCII bytes magic][u32 LE total
size]` then payload: `SCHl` (header), `SCCl` (a single u32 LE count of the
following data blocks), `SCDl` × N (audio data; payload = size − 8), `SCEl`
(end). A loop chunk (`SCLl`) exists in the wider EA family but is unused
here — the PS2 music streams carry no loop points. Streams concatenate
back-to-back inside one file (`.mus`, speech `.dat`); a walker reads
`[magic][size]`, parses a stream at each `SCHl`, and skips other chunks by
size. [observed] [[260-schl-chunks]]()

> [[260-schl-chunks]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EAAudioHandler.cs
> `Load(Stream)` (vgmstream ea_schl.c is its cited upstream); legacy raw-scan
> splitter doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/DATAudio.cs
> `ExtractGuess`.

### The header patch table

The `SCHl` payload starts with a 4-byte platform dword — ASCII `PT` plus a
u16 platform id (5 = PS2) — followed by a variable-length **patch table**: a
stream of tagged fields, each `[u8 tag][u8 length][length bytes of value,
big-endian]`. The big-endian patch values are an endianness island inside an
otherwise little-endian container. Unknown tags are skippable by length.
[observed] [[260-pt]]()

| Tag | Meaning |
|---:|---|
| 0x06 | **voice priority**, 0–100 — passed to the voice allocator when a bank sound starts (course, crowd and board sounds ship 90–100); stream headers carry it too (101 on the music chunks) but no stream-side consumer was found |
| 0x0B | no reader — skipped by length like any unknown tag |
| 0x80 | version |
| 0x82 | channel count (default 1) |
| 0x84 | sample rate in Hz (default 22,050 on PS2 when absent) |
| 0x85 | total sample count per channel |
| 0x8C | **residency / addressing flags** (u16, default 8): 8 = sample data resident in sound-processor RAM (bank sounds uploaded at load); 0x100 = resident in a main-memory block; 4 = addressed in place relative to its container — every streamed chunk header and every in-place bank carries 4, and the stream parser then adds the chunk base to the channel offsets |
| 0xA0 | codec id (absent → 0x05 PS-ADPCM) |
| 0xFD | info-header marker |
| 0xFF | end of header (stream parser then aligns to 4) |

The engine's parsers know more of the vocabulary than a decoder needs: in
stream headers, per-channel data offsets (0x88/0x89/0x94/0x95/0xA2/0xA3, up
to six channels), a data-start override (0x8A), per-channel pan offsets
(0x9C–0x9F/0xA6/0xA7, added to a default pan table), per-channel blobs
(0x98–0x9B/0xA4/0xA5), an alternate flags encoding (0xA1, folded into 0x8C),
single-byte patch fields (0x06/0x0A/0x13) and up to four user-data blobs
(0x14). Bank patch headers additionally use 0x07 = root note (default 60),
0x0A/0x0E/0x11/0x14 = pitch, volume and random-variation parameters, 0x1D/0x20
= self-relative pointers to envelope data, and 0x01–0x04 = key/velocity zone
ranges — a header may hold several zones separated by 0xFC/0xFD. The
header's sample count can disagree slightly with the sum of the data
blocks' counts; the decoded blocks are authoritative. [measured] [[260-pt]]()

> [[260-pt]]() EAAudioHandler.cs `PlatformID`/`PatchRead` (byte-reversed
> value read), BnkHandler.cs `ParsePatchHeader` (same tag grammar),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EAAudioHandler.cs;
> defaults `case 0x05 → 22050`, channels 1; header-vs-blocks sample-count
> mismatch observed. Engine: stream tag parser `Snd_ParseStreamHeaderTags`
> `0x002d7288` (switch `0x002d7348–0x002d7650`: 0xA0 → fmt+3, 0x82 → fmt+2,
> 0x84/0x85 → +0, 0x88.. → +4.., 0x8C → s5 (default 8) → `patch+8` at
> `0x002d76a4`, 0xA1 map at `0x002d7664–a0`, 0x06 → `patch+2` at `0x002d757c`,
> 0x0A → +6, 0x13 → +5, 0x14 at `0x002d7630`, pans at `0x002d7360..`; flags & 4
> base add at `0x002d7720–3c`, & 0x308 / 0x8A at `0x002d7744–80`); bank tag
> walker `Snd_ParseBankPatchTags` `0x002d65e8` (defaults tag 2/4/14 = 127, tag
> 7 = 60, tag 9 = 1, tag 12 = 64, 0x82 = 1, 0x84 = 22050, 0x86/0x87 = −1, 0x8C =
> 8, 0xA0 = 5, 0xA1 = 1; parsed `+0x18` = 0x8C used as memory type in
> `0x002d2858` at `0x002d289c–a4`; `+0x0c` = tag 6 → voice alloc `Snd_AllocVoices`
> `0x002d5cc0` at `0x002d6c40`; zone loop `0x002d7080/0x002d714c`); voice start
> `Snd_BankStartVoice` `0x002d6bb0` (tag 7 at `0x002d6cb0`, 12/13 at
> `0x002d6c68–94`, 14/15 at `0x002d6d14–58`, 10 at `0x002d6d60`, 16/17 at
> `0x002d6ca8/0x002d6cd4`). Data: topbomb.mus chunk-0 tags 06 = 0x65, 0B = 2,
> 80 = 2, 82 = 2, 84 = 36000, A0 = 0x0A, 8C = 4; `bnktags.py`: Coyote/Wind1/
> C_Gen 0x8C = 4, 0xA0 = 0x0A; garibaldi1/Crowd no 0x8C, tag 6 = 0x5A/0x5F;
> zboard 0x8C = 0x100, 0xA0 = 9. map:"EA sound library: stream tags, banks,
> codecs and speech scripts".

### Data-block payloads

**EA-XA blocks** (music): u32 LE sample count (per channel); u32 LE
per-channel data offset × channels (channel 0 = 0); then, **at the head of
every channel's region, one 32-bit word before its first 15-byte frame** —
what looked like a single extra word after the offsets is channel 0's copy,
and both stored offsets already account for it. The word holds two 16-bit
sample-like values tracking the decoder history at the block boundary (zero
on silent blocks); it is close to but not bit-identical with a continuously
carried history, i.e. the encoder's own state, presumably for
block-independent seeking. The engine hands it to the decoder with the
channel data and at runtime overwrites the word before channel 0 with a
back-pointer to the block; a sequential decoder can keep ignoring it. Then
the channel data — each channel's region a run of mono 15-byte EA-XA frames,
with predictor history carrying continuously across blocks per channel.
[measured] [[260-scdl-eaxa]]()

**MicroTalk blocks** (speech): u32 LE sample count; u32 LE per-channel
offset × channels (no extra u32); each channel's region starts with **one
flag byte** before the bitstream — a **header-present flag**: non-zero means
the bytes that follow begin with the per-stream MicroTalk header (bandwidth
flag, multipulse threshold, gains) and the decoder re-initialises from it;
zero means the region continues the stream and the bit reader restarts
byte-aligned at the next byte. Shipped speech uses the header form on a
stream's first block and zero afterwards. Frames are variable-bitrate, but
every block is byte-aligned per channel: the bit reader restarts each block
while decoder state (LPC history, gains, the once-per-stream header) carries
across. [measured] [[260-scdl-mt]]()

> [[260-scdl-eaxa]]() EAAudioHandler.cs `DecodeEaXa` (block-body layout
> comment),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EAAudioHandler.cs;
> verified on the GARI stems (silent intro decodes to digital zero). Engine:
> `Snd_StreamHandleSCDl` `0x002d3060` (`ch[c] = chunk + 12 + 4·nch + off[c]` at
> `0x002d30a4–e0`; `sw chunk,-4(ch0)` at `0x002d3148`); EA-XA coefficient
> pairs `0x0035b900` (refs `0x002e3aac/0x002e3ea0`). Data: `scdl_prefix.py` on
> topbomb.mus — 2917/3000 blocks non-zero prefix on both channels, 166 zero;
> `eaxa_check2.py`: 0/58 exact matches vs a carried history under ±128
> rounding × clamped/unclamped (deltas of a few LSB to a few hundred).

> [[260-scdl-mt]]() EAAudioHandler.cs `DecodeMicroTalk` + doc comment
> (channel base + flag byte per vgmstream),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EAAudioHandler.cs;
> vgmstream-matched on SSX speech (identical counts, 99.8% bit-identical).
> Engine: `Utk_DecodeBlocks` `0x002e29b0` (flag test `lbu 0(v1); bne →
> Utk_ParseStreamHeader 0x002e4250(v1+1)` at `0x002e2a54–68`, else bitbuf =
> byte 1, ptr = +2 at `0x002e2a74–88`); `Utk_DecodeFrame` `0x002e43c8`;
> `Utk_InitStream` `0x002e2940`; tables `0x0035b93c` (rc) / `0x0035ba38`
> (codebooks). Codec placement: EA-XA and MicroTalk decode on the EE (rate
> table `Snd_CodecBytesPerSecond` `0x002d2a18` knows codecs 4, 5, 8, 10, 14,
> 15); PS-ADPCM is SPU2 hardware through the IOP modules `libsd.irx` /
> `snddrv.irx` (strings `0x003ba43d/0x003ba478`).

The prefetch that makes graph-chained music gapless is runtime behavior
owned by `430-music-and-announcer.md`. [observed] [[260-streaming]]()

> [[260-streaming]]() db:music-system (pathxSND.c layer 0x002232a8–
> 0x00224258, prefetch observation); intro stems opened as sound-stream
> group 2 by IntroMusic_LoadLevelBig @0x00215358; speech `.dat`/`.hdr`
> loaders @0x00228030, events.evt @0x00228268, db:speech-events.

## BNKl bank container

Header: ASCII `BNK` at offset 0 (full magic `BNKl`), a u8 version at offset
4, an unused byte at offset 5 (zero), a u16 LE sound count at offset 6. The
slot entry table starts at offset 12 for version 2 or offset 20 for versions
4/5, and the three words at 8–19 are the bank's **memory plan**: the
data-region offset (the size of the header block kept in main memory — head,
entry table and every patch header), the size of the **sound-processor-
resident** sample block, and the size of the **main-memory-resident** sample
block (honoured only at version 5). At load the engine keeps the header
block, copies the main-memory block (which starts at the data-region offset)
into a heap buffer, uploads the processor block that follows it in 4 KB
pieces, and rewrites every sound's data-offset tags from file-absolute to
"block base + (offset − data-region offset)", each sound's block chosen by
its residency flags tag. Banks whose two block sizes are zero — one-sound
environment banks, chant banks, music-loop banks — keep everything in the
header block and play in place. Every shipped bank is version 5 and the
three words tile the file exactly (offset + processor size + main size =
file size); no version-4 bank ships. [measured] [[260-bnk-blocks]]()

> [[260-bnk-blocks]]() `Snd_BankLoad` `0x002d2170` (`lbu +4 == 5 → lw +0x10` at
> `0x002d21d8–e0`; `lw +8` as source offset at `0x002d2208/0x002d22ec`; `lw
> +0xc` at `0x002d22b0`; alloc `Snd_AllocBlock` `0x002df820` (256 = EE heap via
> `0x0030e820`, 8 = 64-byte-unit SPU allocator at `0x003543c0+0xab8`); DMA
> `0x002defa8` × 0x1000; table `+0x14` at `0x002d226c`; relocate
> `Snd_BankRelocateSoundOffsets` `0x002d2858` → `Snd_PatchRelocateOffset`
> `0x002deb70`). `bnkcensus.py` over 172 shipped banks: all version 5, byte 5
> = 0; single-sound banks word 8 = size; course/crowd banks word 8 + word 12 =
> size; zboard word 8 + word 16 = size.

Each table entry
is a u32 LE offset **relative to that entry's own file position**; an entry
of **0 is an empty slot** — the encoding behind the no-fallback silence rule
of `190-audio-data.md`. [observed] [[260-bnk]]()

At each sound's offset: the same `PT` platform dword and tag grammar as the
stream header, with bank differences: extra tags **0x88 / 0x89** hold the
channel-0 / channel-1 data offsets as **absolute file offsets within the
bank**; **0x86 / 0x87** hold the loop start / end in samples and appear on
exactly those sounds meant to sustain, alongside the frame flags that carry the
same region; 0xFC/0xFD are payload-less info markers; 0xFE/0xFF terminate.
Typical bank sounds carry samples/rate/channels plus the channel offsets and
*no* codec tag — hence PS-ADPCM at 22,050 Hz mono as the effective default.
[observed] [[260-bnk-sound]]()

Sample data is **contiguous raw codec frames** at the channel offsets — no
data blocks, no per-block counts; decode runs until the sample count is met.
Stereo is two separate mono runs, not interleaved frames. The frame stride
belongs to the **codec**, not the container: EA-XA 15 bytes, PS-ADPCM 16
bytes (decoding PS-ADPCM at 15 drifts one byte per frame and produces
static). EA-XA in banks uses the same 15-byte frames and +128 rounding as in
streams. [measured] [[260-bnk-data]]()

> [[260-bnk]]() BnkHandler.cs `Load`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/BnkHandler.cs;
> empty-slot semantics: mesabanca1.bnk slot 83 entry word = 0,
> map:"SSF effect-graph sound".

> [[260-bnk-sound]]() BnkHandler.cs `ParsePatchHeader` (verified on
> garibaldi1.bnk),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/BnkHandler.cs.

> [[260-bnk-data]]() BnkHandler.cs `DecodeSound` (0x05/0x09/0x0A branches;
> 8-bit PCM widened ×256),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/BnkHandler.cs;
> Wind1.bnk stride proof + v1 rounding; the EA-XA decoder's padded-frame
> variant knob exists but shipped banks use gap 0,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EaXaCodec.cs
> `DecodeChannel`. 15-vs-16-byte stride proven by length arithmetic on a
> real bank (165,536 samples = 5,912 frames; ×16 overruns the available
> bytes, ×15 fits exactly) and byte-exact decode.

## EA-XA ADPCM (codec 0x0A)

4-bit ADPCM in mono 15-byte frames: one header byte (coefficient index =
high nibble, shift code = low nibble) + 14 data bytes = 28 samples. Data
nibbles decode **high nibble first**. Per nibble n: [measured] [[260-eaxa]]()

```
shift  = (header AND 15) + 8
pred   = (n << 28) >> shift                 (arithmetic; sign-extends the nibble)
sample = (pred + c1·hist1 + c2·hist2 + 128) >> 8
sample = clamp to s16
hist2 = hist1;  hist1 = sample              (history feeds back the CLAMPED sample)
```

The +128 term is the "v1" rounding; it and the 15-byte (unpadded) frame are
fixed for this title in both containers. History carries across frames and
across stream blocks per channel. Coefficient pairs by index: 0 → (0, 0),
1 → (240, 0), 2 → (460, −208), 3 → (392, −220); only indices 0–3 occur in
shipped data. [measured] [[260-eaxa]]()

> [[260-eaxa]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EaXaCodec.cs
> (class doc, `DecodeChannel`, `TABLE`); byte-exact vs vgmstream ("v1");
> call sites EAAudioHandler.cs `DecodeEaXa` / BnkHandler.cs `DecodeSound`.

## PS-ADPCM (codec 0x05)

Sony VAG-family 4-bit ADPCM in 16-byte frames of 28 samples: byte 0 =
predictor index (high nibble) + shift (low nibble); byte 1 = loop/flag byte;
bytes 2–15 = data. Data nibbles decode **low nibble first** — opposite of
EA-XA. Per nibble n: [measured] [[260-psadpcm]]()

```
s      = sign-extended nibble:  (s16)(n << 12) >> shift
sample = s + (f0·hist1 + f1·hist2) >> 6
out    = clamp to s16
hist2 = hist1;  hist1 = sample              (history feeds back UN-clamped)
```

The unclamped history feedback mirrors the SPU's internal precision and is
load-bearing for exactness. Predictor pairs (×64): 0 → (0, 0), 1 → (60, 0),
2 → (115, −52), 3 → (98, −55), 4 → (122, −60); an out-of-range index decodes
as 0. [measured] [[260-psadpcm]]()

The flag byte is ignored by PCM decode, and its 16-byte recurrence is a useful
stride fingerprint — but it is what decides whether a voice **stops** at the end
of the sample or wraps, so it is the only thing separating a one-shot from a
sound that can be held. Shipped banks use two conventions and never mix them: a
one-shot leaves the body clear and marks its last frame "end", while a
sustaining sound sets the loop bit through the body, marks the frame the repeat
address points at, and finishes on "end **and** repeat". The distinction is not
cosmetic — a sound encoded the one-shot way is released when its samples run
out no matter what asked it to play, so a placed emitter built on one is
inaudible rather than merely short. [measured] [[260-psadpcm-loop]]()

> [[260-psadpcm]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/PsAdpcmCodec.cs
> (class doc, `DecodeChannel`, `F0`/`F1`, index guard); byte-exact vs
> vgmstream.

A rebuilt course bank must also **not exceed the size the level shipped with**, and the consequence of
exceeding it is silence rather than a diagnostic: the disc builds, the sound rows are correct, and the engine
allocates voices at the right gain and position for emitters that produce nothing. The budget belongs to the
individual bank rather than to the disc — the largest bank shipped is half again the size of the smallest
course's, so a bank comfortably inside "what retail ships" can still be far past its own level's. Replacing a
sound the bank already carries reclaims its bytes; filling a slot the bank left empty does not.
[measured] [[260-bank-budget]]()

Two details of that marking are **load-bearing rather than stylistic**, and both were established the
expensive way. The repeat marker belongs on the frame **after** the one the loop-start sample falls in, which
every shipped looping sound does without exception — putting it on the frame itself **hangs the console
during level load**, not merely failing to loop. And a loop region starting at sample zero is read as no loop
region at all: the sound plays once and stops, exactly as an unmarked one-shot does. Shipped data never uses
a zero start, and its smallest is a single frame. [measured] [[260-psadpcm-loopmark]]()

> [[260-psadpcm-loop]]() Flag byte, measured across shipped banks. One-shot =
> 0x00 through the body and 0x01 on the final frame (mesabanca1 slot 1,
> merqurycity1 slot 33, and every hit-sound slot examined). Sustaining = 0x02
> through the body, 0x06 on the frame holding the repeat address, 0x03 on every
> frame past the loop region; exemplar merqurycity1 slot 24, frame 0 = 0x00,
> 1..485 = 0x02, 486 = 0x06, 487..640 = 0x02, 641..642 = 0x03. Bits therefore
> read as the standard VAG assignment: 0x01 end, 0x02 repeat, 0x04 loop start.
> The three sustaining slots in that bank are 24/35/36 — the hydrant spray, car
> alarm and police siren behind interactive-ambient events 28/16/57
> (`420-audio-runtime.md`) — and they are exactly the slots carrying loop-point
> tags; no one-shot slot in the same bank carries either.

> [[260-psadpcm-loopmark]]() Marker placement, all three of merqurycity1's looping slots: 0x86=13580
> (frame 485.00) marks frame 486; 0x86=84 (frame 3.00) marks 4; 0x86=28 (frame 1.00) marks 2. No shipped
> looping sound starts at sample 0, and 28 — one frame — is the smallest start used. Both rules confirmed on
> hardware against an injected garibaldi1: a zero start played once and stopped, and a marker on the
> start frame rather than one past it froze the EE during level load with the level data already resident
> (heap static across 8 KB over 3 s, rider placed at the gate, level clock never advancing). Correct
> placement plays and sustains.

Which slot a custom clip is given is therefore a real decision, and the first rule about it is the one that
is hardest to see.

**A slot the bank leaves empty plays a custom clip perfectly well.** [[260-shipped-slot]]() records the
opposite reading — that only shipped slots sound — and why it looked right, because the reasoning behind it
is worth not repeating. What actually silenced those
builds was the loop encoding below: a bed that plays one pass and stops, at 12 dB under the bank's median
level, is indistinguishable from silence to someone riding past it.

Choosing a slot the level no longer reaches is therefore what it always was — a way to buy back bytes against
[[260-bank-budget]]() — and not a condition for being heard.

It is bounded from the other side too.

**Slot 64 of a course bank is the glass smash.** All ten course banks on the disc carry the same 54,688 bytes
there — 2.17 s, stereo, 22,050 Hz, one-shot, byte-identical bank to bank — and event 63 is the only id that
reaches it in any of the eight extracted mountains. Retail hangs that event on the props whose whole job is
to break: the LCD
screens on every course, Merqury City's parliament windows and skylight, Elysium's halfpipe glass, Aloha's
breakable shortcut covers, Mesa's SSX sign. So it is a SHARED cue duplicated into each bank rather than a
sound a level authored, which is both why every bank has one and why it is the only multi-channel sound any
of them ships. [measured] [[260-slot-64]]()

That makes it the largest single reclaim a course bank has to offer, and the one most worth being careful
with. Two rules follow, and they are different rules. A level that still ships a prop on event 63 reserves
the slot like any other reachable one, so the smash is never taken out from under something that can play
it. A build that ships none — `--bare-slot` — may put a **hit sound** there, which is measured to ride, but
never a **continuing emitter**: a mono loop written into slot 64 and placed as an emitter freezes the level
clock at frame 0 with the rider already placed and the machine still responsive. The same loop in four mono
slots rides, that slot's own stock stereo sound played as an emitter rides, and a mono one-shot there rides —
so what is fatal is the combination, and the slot is what distinguishes it. [measured]
[[260-emitter-routing]]()

One slot costs no correctness and a great deal of TIME. **A sustaining loop in garibaldi1 slot 083 makes the
console run at about half speed** — the level is identical, the rider reaches the start gate at the same
frame, and the host takes 90 seconds to emulate what takes 51 everywhere else. It sounds perfect while it
does it, which is why it reads as "the level hangs on loading" rather than as an audio fault at all.
[measured] [[260-slow-sustain]]()

Retail places a sustaining emitter on only **three** ordinary course-bank ids across all eight mountains
(68, 149, 151), which for a long time was read as a bound on what a custom emitter may be given. It is not
one: an emitter takes any slot the bank ships, mono or empty, and the only refusal left is the multi-channel
slot. What made the narrow reading look right was that every level load which froze at frame 0 — and there
were several, each blamed on the slot the bed had just been moved to — was ridden with a **malformed loop**.
Fixing the encoding cleared all of them, including the slot singled out as worst.

> [[260-slow-sustain]]() Wall-clock from launching PCSX2 to the rider standing at the gate, `--bare-slot`,
> CANDYLAND on GARI, one ambient bed moved between slots and nothing else changed. Untouched retail disc:
> **51.4 / 51.7 s**.
>
> | bed in slot | shipped | seconds to the gate |
> |---|---|---|
> | 010 | no | 50.8, 50.8 |
> | 052 | yes | 50.6, 50.7, 50.9, 51.8, 52.3, 56.2 |
> | 081 | yes | 50.6, 53.0 |
> | **083** | yes | **87.9, 90.7, 91.1, 95.3** |
>
> Not the size of the write: a clip that SHRINKS 083 (20,576 into 22,304) and one that GROWS it (23,776) are
> both slow, and clips that shrink (12,800) and grow (20,576) slot 052 are both fast. Not the level either —
> every run above reaches the gate at frame 307-328, so the same game frames simply take longer to emulate,
> which is what separates this from a load that is doing more work. The sound itself is correct and audible
> throughout.
>
> Mechanism [open]. The confound worth naming: on GARI only event 26 reaches slot 083, so the SLOT and the
> ID cannot be told apart without another mountain — `CustomSoundRouting.SlowSustainSlots` is keyed by bank
> and slot, which is the narrower of the two guesses. Only sustaining voices were measured; a one-shot there
> is untested and is still routed to it, being the bank's largest single reclaim.

> [[260-shipped-slot]]() **WITHDRAWN — the claim was that only slots a bank already ships can be heard, and
> it is false.** A later build of the same course carries a sustaining bed in slot 024, which garibaldi1
> leaves empty, and its author reports it audible and looping. Kept because the way it was reached is a
> failure mode worth recognising.
>
> It came from two builds of one course that differed in the slots their beds occupied — reserved ids 179/181
> on empty slots 010/012, versus events 26/22 on shipped slots 083/052 — and from the author hearing the
> second and not the first. Both were true. The inference was not: the beds in BOTH builds carried the broken
> loop encoding below, so each played a single 2.25 s pass at −25.8 dBFS and stopped, and what actually
> differed was that the second build also HUNG at frame 0, parking the listener next to the emitter with
> nothing else happening. One pass noticed while standing still, missed while riding past, and a slot theory
> assembled out of the difference.
>
> Two lessons, and the second is the general one. The bench cannot referee this: `audio_voices` grades
> ALLOCATION and `audio_tone` grades BYTES, and a bed that plays once passes both — which is how a clip sat
> on slot 010 through three green batches with nobody hearing it. And when the only instrument is a person
> reporting what they heard, the confound is usually not in their ears but in everything else that moved
> between the two builds they are comparing.

> [[260-slot-64]]() Read out of AUDIO.BIG's BNKl headers (0x82 channel count and the 0x88/0x89 pair) for every
> bank on the PAL disc, and the runs hashed. All ten course banks — alaska1, elysium1, garibaldi1, iceberg,
> megaplex1, merqurycity1, mesabanca1, pipedream1, snowdream1, tricktutorial — carry exactly one multi-channel
> sound and it is slot 64 in every one: 2 channels, 22,050 Hz, 47,852 samples, 2×27,344 bytes, no loop tags,
> flags 0x00×1708 + 0x01, and the two channel runs are decorrelated (r = +0.17) so it is authored stereo
> rather than a doubled mono. Both runs hash identically across all ten banks and appear nowhere else on the
> disc — 318 distinct runs over 162 members — so it is one cue duplicated ten times. The front-end and global
> banks (zbxfe, zBxsfx, tricky, LoadingScreen, Tunnel1, MineShaft, Sewer) carry other multi-channel sounds;
> no course bank does.
>
> What it is, from the props: event 63 is the only group-2 id resolving to slot 64 in all eight extracted
> mountains, and 163 retail instances name it — `Mdl_Lcd_ScreenLogo*` and `Mdl_LcdscanRed` (every course),
> `Mdl_ParlamentShatterWindow`/`Mdl_ParlamentShatterBase`/`Mdl_Skylight_Break`/`Mdl_Building_cheatWindow`
> (MERQUER), `Mdl_HalfPipeThing_GlassAwhole` (ELYSIUM), `Mdl_Barrier_ShortcutCover` ×33 (ALOHA),
> `Mdl_SignBreakable_SSX` (MESA). MEGAPLE names it from 26 MainType-8 `SoundPlay` nodes instead and no
> instance at all. The decode agrees: full-scale peak, 90 % of it reached in 10 ms, spectral centroid 4.2 kHz
> with 49 % of the energy above 4 kHz, and a 2-second tail whose zero-crossing rate RISES from 4,495/s to
> 6,383/s — a crash followed by falling shards.
>
> [[260-emitter-routing]]() Substitution measured on GARI, PCSX2, `--bare-slot`, a mono loop written into the
> named slot and placed as an emitter. Slots 035, 081, 083 and 112 (events 16, 29, 26, 67) all start a voice
> and ride.
>
> **Slot 052 (event 22) froze the level clock at frame 0** — rider placed, PINE answering, the course's other
> custom sounds audible through the hang — and then rode, fast and sustaining, once the loop encoding was
> corrected. Nothing about the slot changed between the two builds; the bed went from one wrap frame and a
> length ending part way into a frame to retail's two-frame, frame-aligned shape. So the hang was the
> ENCODING, and the slot was a coincidence of which build happened to carry it.
>
> That is worth stating plainly because the same coincidence was mistaken for a slot rule twice, and each
> time the rule was written into routing and cost real headroom. A malformed loop marker was already recorded
> below as freezing the EE during level load; every emitter hang seen since is the same finding arriving in
> a different disguise. The one refusal that survives is the multi-channel slot, and it is the one case never
> re-ridden with a correct loop.
>
> The slot-064 round, which has the same caveat and was never retested:
> slot 064 (event 63) freezes at frame 0 with the emulator responsive and the rider placed — the same
> signature as the loop-marker hang above. Five controls isolate it: the same clip as a ONE-SHOT in slot 064
> rides; an emitter on event 63 over garibaldi1's own untouched stereo slot 064, on a disc whose AUDIO.BIG was
> never rewritten, rides AND holds a voice for 129 samples, so the sustaining path on that id is exercised
> without harm; the identical hanging bank bytes with the retail AUDIO.BIG restored ride; and the same build
> with routing off rides. So the id, the loop, the bank layout and the ADL rewrite are each excluded
> independently, and what is left is a mono sustaining voice in the slot the engine ships stereo everywhere.
>
> Retail emitter ids, counted over every shipped `Sounds.ExternalSounds` record in the extracted corpus
> (ALASKA, ALOHA, ELYSIUM, GARI, MEGAPLE, MERQUER, MESA, SNOW; 555 records): outside the special-bank ranges,
> the crowd ids and the interactive class {16,28,57}, only 68 (floodlight hum, MERQUER) and 149/151 (MEGAPLE)
> are ever placed. Event 63 is not among them, so routing cannot pair an emitter with slot 64 from the id side
> either; the slot rule is the same cliff fenced twice.
>
> Mechanism untraced [open]. Knowing the cue does not explain the hang: a glass smash is a one-shot and
> nothing in the engine need care that a sustaining voice sits where one used to, and the three candidate
> causes — the channel count, the sustain, and whatever the engine keeps about that slot between bank load
> and voice start — are still not separated. The tag parser is as far as it has been read: `0x82` lands as a
> BYTE at +2 of the format record and `0x84` as the halfword at +0, while `0x88`/`0x89` land at +4/+8 of the
> patch record, so the engine holds room for exactly two channel offsets and no more. What a mono write into
> slot 64 leaves inconsistent, if anything, is not visible from there. Routing takes the slot for ONE-SHOTS,
> which is what the measurement supports and is worth 54,688 bytes; it refuses it to emitters.

> [[260-bank-budget]]() Ten builds of one course, garibaldi1 (324,992 bytes shipped): every bank at or under
> that size played its injected sounds (321,136 / 322,832 / 324,992), every bank over it was wholly silent
> (347,024 / 371,280 / 420,336 / 446,224 / 509,872 / 706,368) with no other property separating them —
> loop encoding, slot novelty, sample rate, clip level and donor ambience were each varied independently and
> none tracked the outcome. Mechanism untraced [open]; the rule is empirical and is enforced at inject.

## MicroTalk (codec 0x04)

An LPC multipulse speech vocoder, decoded per channel with state persisting
across blocks, as follows. [measured] [[260-utk]]()

- **Bit reader**: LSB-first within each byte; Huffman lookup peeks 8 bits
  then consumes the code's true length; reads past the end return zeros.
- **Stream header** (once per stream, at the front of the first frame):
  1 bit reduced-bandwidth flag; 4 bits u → multipulse threshold = 32 − u;
  4 bits g → first fixed gain = 8 × (1 + g); 6 bits m → gain ladder ratio =
  1.04 + m × 0.001; 64 fixed gains, each the previous × ratio.
- **Frame** = 432 samples = 4 subframes × 108. Per frame, 12
  reflection-coefficient indices (first: 6 bits, and if it is below the
  multipulse threshold the frame uses multipulse excitation; next three:
  6 bits; remaining eight: 5 bits offset +16) select from a fixed
  antisymmetric 64-entry table (±0.996776 extremes); the working
  coefficients step toward the frame's targets by quarters each subframe.
- **Per subframe**: 8 bits pitch lag; 4 bits pitch value (gain = value/15);
  6 bits fixed-gain index; then 108 excitation samples; output excitation =
  fixed gain × excitation + pitch gain × adaptive-codebook sample, the
  codebook being the previous 324 output samples (index clamped at 0, may
  run forward into the current frame).
- **Multipulse excitation**: a two-model Huffman code over 8-bit peeks
  (commands switch the model; code lengths 2–8 bits). Commands above 3 write
  fixed pulse values (±1…±6 in half steps) and advance; commands 2–3 are a
  zero-run of 7 + a 6-bit count; commands 0–1 are an escape pulse: magnitude
  7, +1 per continuation 1-bit, then a sign bit (0 = negative).
- **Ternary excitation** (non-multipulse): 108 samples from 2-bit peeks:
  `01` → −2, `11` → +2 (2 bits each), `x0` → 0 (1 bit).
- **Reduced-bandwidth mode**: per subframe 1 alignment bit + 1 zero flag;
  excitation decodes on every other sample; the other phase is zeroed (flag
  set) or interpolated with the symmetric 3-tap kernel (0.59738597,
  −0.11459156, 0.01803268 at offsets ±1/±3/±5) with the fixed gain halved.
- **Synthesis**: the reflection coefficients convert to 12 LPC coefficients
  by lattice recursion; a 12th-order all-pole filter with persistent
  12-sample history runs over the output (subframes 0–2 filter 12 samples
  each; the final subframe filters the remaining 396). Samples round
  half-away-from-zero and clamp to s16. A final partial frame's tail beyond
  the block's sample count is dropped; the next block restarts byte-aligned.

> [[260-utk]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/UtkCodec.cs
> (port of vgmstream utkdec.c, itself matched to EA's UTALKSTATE; `RcTable`,
> `RcToLpc`, `Codebooks`/`CmdCodeSize`/`CmdNextModel`/`CmdPulseValue`); the
> port is verified against vgmstream on shipped SSX speech — identical
> sample counts, 99.8% bit-identical output.

## ADL sidecar layout

The per-level `.adl` binds collision sounds to instances
(`190-audio-data.md` has the semantics). Little-endian: a 4-byte head (first
byte 0, then three pad bytes), an f32 version (1.0), a u32 row count, then
`count` × 8-byte rows: u32 instance name-hash (`200-archives.md` hash), u32
absolute file offset of a sound record. Multiple rows may share one record
(the writer deduplicates). A sound record: u32 collision-sound **event id**
(not a bank slot — resolved through the event remap of `190-audio-data.md`),
u32 external-emitter count, then `count` emitter records whose length
depends on their **type** word — 0x1C, 0x30, 0x30 and 0x18 bytes for types
0–3. Every record starts (type, sound index, then three floats = the emitter
offset added to the instance position); the rest is per type: **type 0**
(point) — radius (active while the listener is nearer than it) and a curve
selector; **type 1** (ellipsoid) — three half-extents, an orientation axis,
and a curve; **type 2** (cone) — a radius gate, a cone axis, a radial curve
applied to distance ÷ radius, the cosine of the cone half-angle (silent
unless the listener direction's dot against the axis exceeds it), and an
angular curve applied to the normalised angle inside the cone, the gain
being the product; **type 3** — a radius and a constant gain, as a
non-maintained voice. No shipped course places a type-2 record. The runtime
walker advances by type and never reads a terminator, so the file's trailing
0xFF byte is writer convention only. [measured] [[260-adl]]()

> [[260-adl]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/ADLHandler.cs
> (round-trips shipped files; `Save` dedup);
> doc:../research/extracted-data.md "Prop collision sounds from ADL and
> BANKS.INF". Engine `ADL_UpdateExternalSoundsNearListenerCandidate`
> `0x0022b868`: strides at `0x0022b994–0x0022b9ec`; type-2 branch
> `0x0022bd88–0x0022bed4` (`+8/+0xc/+0x10` offset; `+0x14` radius at
> `0x0022bdf8`; axis dot `+0x18/+0x1c/+0x20` at `0x0022be34–60`; `+0x28` cosine
> gate at `0x0022be5c–6c`; curve `0x0022c138` with `+0x24` at `0x0022be78` and
> `+0x2c` at `0x0022bea0`; `acos` `0x00251500`; f23 = 1.0, f25 = π/2 at
> `0x0022b93c–50`); no read past the last record.

## Speech bank headers and event scripts

The speech configuration names, per speech set (front end, announcer, rider
chatter, narrator, animation), a base path inside the mounted speech
archive. There sits a small nested archive holding one **bank header** per
bank plus one **event script**; the engine mounts it, registers every header
member as a bank (bank name = member name without extension; its lines are
in the `.dat` beside it) and registers the script, falling back to loose
files when the nested archive is missing. [measured] [[260-speech-mount]]()

**Bank header (`.hdr`)** — a 12-byte head: u16 bank id; u16 always −1; u8
layout byte; u8 line count; u8 history depth; u8 offset-unit shift; u16 end
offset (in units); u16 reserved. The layout byte's low nibble is the number
of **attribute bytes** per line, bits 4–6 the count of optional 16-bit
key/value tags, bit 7 selects a "played" bitmap instead of a history ring.
The line table starts at byte 12: each entry is a 16-bit **big-endian**
offset in units of 256 × (shift + 1) bytes followed by the attribute bytes;
the top bit of the first offset byte marks an alias entry whose second byte
is the index of the real entry. A line's length is the next non-alias
entry's offset minus its own (the last line ends at the head's end offset).
After the table come the optional tags (3-bit key, 13-bit value), then —
only when the depth is non-zero — one write-index byte that must be zero and
`depth` history bytes that must be 0xFF, or the header is rejected at load.
The ring records recently played line indices for no-repeat selection; the
attribute bytes are variant tags the event scripts match on. Shipped
announcer headers use 0–4 attribute bytes, unit 256 (1024 on the narrator
staging banks), no tags and no bitmaps; exactly one shipped header is
malformed and rejected — dead data. [measured] [[260-speech-hdr]]()

**Event script (`events.evt`)** — a 24-byte head: u16 magic 0x0803; u16
(0x073C in every shipped file); u32 0; u8 speech-set class (front end 0,
announcer 1, rider 3, narrator 4, animation 5); u8 sub-class 0; three u16 of
unassigned role; u16 event count; u16 0; u16 probability scale (100); u16
priority threshold (500). Then `count` u16 record offsets in 4-byte units
from file start. A **record**: u16 event id; u16 timeout (the voice is
killed when it has played longer); u16 priority; u8 choice count; u8
condition count; u8 repeat limit; u8 fire probability (0–100 against a
random 0–99); u8 flags (0x20 = channel-exclusive; four other bits for
chaining, interrupt, choice masks and follow-up are never set in shipped
data); u8 pad; then u16 choice offsets (×4 from the record start), 3-byte
conditions (none shipped) and optional per-choice masks (none shipped). A
**choice**: u8 weight (a 3-bit scale and 5-bit mantissa through a scale
table; 0x39 = normal, 0x14/0x08 = rare), two zero bytes, u8 (line count × 4
| mode), then one byte per line = line entry offset ×4 from the choice
start. A **line entry** (16 bytes): u16 bank id; u8 argument index; u8
select mode (0 = a line of that bank; 2 = the line whose attributes match
the caller's argument; 1 = bank id from the argument); u8 selector count;
three pad; up to four selector bytes (254 = random line, 255 = must match
the attribute chosen for the previous line, 1–7 = header tag lookup); u32
−1. A fired event picks one choice by weighted random and plays its lines in
sequence — most begin with a "silence" bank as a gap — each resolved through
that bank's header and history ring. The game fires events by id, the
posted word's upper byte carrying the set class so the library finds the
right script; event ids and bank ids share a number space (an event's
primary bank usually has the same id) but are separate tables. [measured]
[[260-speech-evt]]()

> [[260-speech-mount]]() `SpeechSys_ParseSpeechInfAndMount` `0x00228268` (keys
> BIGFILE `0x003a1638` / BASEPATH `0x003a1640` / BANK `0x003a1680`;
> `%sheaders.big` `0x003a1650` via `0x002c9240`, member walk
> `0x002cd388/0x002ccf98`, `%seventdat\events.evt` `0x003a1660`); per member
> `SpeechSys_LoadBankHeaders` `0x00228030` → `%s.hdr` + register
> `SpeechLib_RegisterBankHeader` `0x002bc6c8`; bank object {+0 lib slot, +4
> name[128], +0x84 data, +0x88 owns}; evt register `0x002bbf48` →
> `SpeechLib_RegisterEvt` `0x002bbe50` (u16 magic 0x0803, registry
> `0x0034a010[8]` keyed on evt bytes +8/+9). db:speech-events.

> [[260-speech-hdr]]() `SpeechLib_HdrDecodeEntry` `0x002bfc20` (`(b4 & 0xF) + 2`
> stride, table at +12, alias bit 0x80, unit `(b7 + 1) << 8`, end = next entry
> or `lhu +8`); tag lookup `SpeechLib_HdrTagLookup` `0x002be1b0` (3-bit
> key / 13-bit value tags at `hdr + 12 + entsize × count`); history ring push
> `0x002bc4b0` / recency `0x002bc548` / register check `0x002bc6c8` (index byte
> 0 + ring 0xFF, skipped when depth 0), bitmap init `0x002bc608`.
> `hdrcensus.py` over 177 headers: layout ∈ {0..4}, shift ∈ {0, 1, 3}, no
> bitmaps/tags; only `mc\Grab\Grab.hdr` fails (write-index 0xFF). Entries are
> {u16 BE offset, N attribute bytes} at +12, not the {u8, u24, u8, u8}-at-11
> layout `HDRHandler.cs` assumes for types 1/3.

> [[260-speech-evt]]() record lookup `SpeechLib_EvtFindRecord` `0x002bc7e8`
> (`lhu +0x10`, u16 table at +0x18, records keyed by u16 id); fire
> `SpeechLib_FireEvent` `0x002bcc58` (`lb +9` probability vs `0x002bfae0(100)`;
> `lhu +4` priority vs `evt+0x16` at `0x002bd10c`; `lbu +10` & 0x20 via
> `0x002bcc28`; `lhu +2` timeout at `0x002bd0a0–0x002bd12c`); line selection
> `SpeechLib_VoiceSelectLines` `0x002bf018` (`lbu +6`, `lb +7`, `lbu +10` bits
> 0/3, condition table `0x003ba120`); weighted order
> `SpeechLib_ChoiceWeightedOrder` `0x002bdfb0`, weight decode `0x002bdf88`
> (table `0x00349b38`); choice walk `SpeechLib_ChoiceResolveLines` `0x002be250`
> (`lbu +3 >> 2`, byte offsets at +4); entry resolve
> `SpeechLib_LineEntryResolveBank` `0x002bda28` (u16 bank at 0, u8 arg at 2,
> u8 mode at 3; `0x002bc358/0x002bc3c8/0x002bc448`); variant pick
> `SpeechLib_PickLineVariant` `0x002be608` (selectors 254/255 at entry+8..).
> Post helpers `0x0022f6c0..0x0022f83c` build `0x0100_20xx`; announcer hooks
> post 0x2051–0x2056 (others 0x202B–0x2037, 0x2046–0x2050), rider chatter
> 0x600F–0x6038, narrator 0x8000–0x8005. Data: `evt_mc.txt` (39 records
> 0x200F–0x2056), `evt_others.txt` (narrator 23, rider 21, front end 1,
> animation 1); every offset in bounds, every referenced bank id exists.
> Unnamed: evt head words +2/+0xA/+0xC/+0xE, flags 0x01/0x04/0x10, condition
> types 0/3 (`0x002bf5cc` → `0x002bf3f0`), timeout units.

## BANKS.INF layout

A plain INI-style text file in the config directory: one `[LEVEL]` section
per course, each key naming one `.bnk` for a bank group. The engine's parser
assigns key → group index: MAIN = 0, BOARD = 1, BANK = 2 (the course bank),
CROWD = 3, AUX = 4, TRICKY = 5. A section may omit groups (one example level
ships no AUX line).

`SWAP` is different: every reviewed retail course section repeats the same
roughly 90 bank names, including `Wind1` and `Wind2`. The parser copies each
name into the sound manager's swap-candidate array and increments its count;
it does not assign a group and does not start a voice. These rows are an
on-demand bank registry, **not a per-course background-sound selection**.
[verified] [[260-banksinf]]()

> [[260-banksinf]]() parser @0x00211590 (group indices 0–5), db:audio;
> independently summarized GARI observation in
> doc:../research/extracted-data.md. `SWAP` branch `0x00211a64..0x00211ab8`
> copies a 64-byte bank name to manager array `+14560` and increments count
> `+14556`; PAL `BANKS.INF` course-section comparison shows the repeated list.

## Real examples

Shared assigned banks (identical for every course): `zbxsfx` (MAIN), `zboard`
(BOARD), `Crowd`, and `tricky`. `Wind1` and `Wind2` are fixed environment
banks available through the repeated `SWAP` registry; availability is not
evidence that either one plays. Course banks are `<level>1` with
EA-truncated names (`garibaldi1`, `mesabanca1`, `merqurycity1`, …; two ship
without the suffix). The Garibaldi intro-music archive holds 16 stems
(`Garibaldi-A1..A4`, `B1..B4`, `C1..C8`) plus `end`; each A/B/C stem is
128,291 samples ≈ 5.8 s at 22,050 Hz. Course banks are sparse — a typical
one populates a couple dozen slots, and a slot present in one level's course
bank may be the empty entry in another's. [observed] [[260-examples]]()

> [[260-examples]]() odd stored casing `zBxsfx.bnk` noted; GARI stem inventory
> from the extracted set; garibaldi1 decodes 23 slots, slot 83 = the 2.4 s
> firework bang while mesabanca1's slot-83 word is 0, map:"SSF effect-graph
> sound".

<!-- DIRTY
Open questions (derivations: elf-map "EA sound library: stream tags, banks,
codecs and speech scripts"):
- EA-XA per-channel prefix pair: exact encoder recipe (not bit-equal to a
  sequential history under any rounding variant tried). Decisive: encode a
  known PCM input with EA's sx.exe and compare the emitted pairs.
- Stream tag 0x06 consumer (byte at stream slot +0x26) and 0x8C bits
  0x20/0x40/0x200: grep the snd library beyond 0x002d2000-0x002d8000 for
  `lbu +0x26` / `lhu +0x2c` on slot pointers.
- .evt head words +2/+0xA/+0xC/+0xE, record flags 0x01/0x04/0x10, condition
  types 0/3 (0x002bf5cc -> 0x002bf3f0): none exercised by shipped data.
- Bank tags 0x1D/0x1E/0x20/0x21/0x22 (board-bank envelopes) and 0x0A: trace
  0x002d6bb0 -> 0x002deba8 if the port needs board-loop envelopes.
DIRTY -->
