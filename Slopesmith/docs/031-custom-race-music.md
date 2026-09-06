# 031 — Custom Race Music Packing

## Status

An editable sequential-loop arrangement is now packable. It is intentionally a small MVP rather than a full
adaptive score editor: Slopesmith maps one ordinary song across a retail song's proven short streaming slots,
then rewires that donor graph into sample-table order without changing its record layout or stream offsets.

The editor workflow is:

1. Add a `.wav`, `.mp3`, `.flac`, `.ogg`, `.m4a`, or `.aac` source to the open mountain's music library.
2. Open **Scene → Sound → `<mountain name>`**, choose it under **race music**, and optionally preview it.
3. Keep **linear loop (MVP)**, set the BPM and optional loop start/end in seconds. A loop end of zero means the
   source file's end. **retail adaptive graph** remains available as the older compatibility mode.
4. Export the mountain. `Music/track.wav` is staged into the folder, where `snowknife repack` picks it up.

In **Test**, that selected master is the authored mountain's on-board race track. It fades in over 1.5 seconds
when the rider gets on the board and fades out when they get off, matching Unity's `RaceMusicDirector` mount
lifecycle. An authored mountain does not invent an off-board intro bed: those stems belong to a retail course
slot and are only available when test-riding an extracted reference. Instead, its explicitly authored
environment filler is used off-board; mounting fades it away as the board
and race layers take over.

Scene → Sound → **Environment filler** chooses `Wind1`, `Wind2`, or off and authors its gain. Export expands
that small setting into the same portable contract Snowknife writes for extracted maps:

```text
Maps/<LEVEL>/Audio/
  Environment.json              openslope-environment-audio/v1
  SFX/<bank>/000.wav            complete decoded program
  SFX/<bank>/000.loop.wav       tagged sustain region preferred by looping consumers
```

The contract is an explicit OpenSlope silence-filler policy, not a claim that SSX Tricky played Wind1 as a
per-course ambient bed. Both Slopesmith and Unity use it only off-board, in preference to intro stems;
neither derives it from events 116/117, weather, or placed emitters. `Bed: null` is the portable authored-off
state.

The filename is stored in the mountain document as `raceMusic`. Export normalizes the selected source to
36 kHz stereo PCM16 at the packer's authored-folder contract — in the browser, by decoding it into an
`OfflineAudioContext(2, n, 36000)` and writing the rendered channels out as a PCM16 WAV (`037`):

```text
Maps/<AUTHORED>/
  Music/
    track.wav          PCM16 RIFF WAV, mono or stereo, any positive sample rate
    arrangement.json  version, mode, BPM, loopStartSeconds, loopEndSeconds
```

The same export invocation then runs `snowknife repack`, which detects that file automatically. Selecting
**none** removes a previously editor-staged track so an ISO repack keeps the target course's retail playlist.
For compatibility, a document saved before `raceMusic` existed still preserves a manually staged
`Music/track.wav`.

The older byte-identical-retail-graph proof can still be run without repacking terrain:

```powershell
snowknife music-inject discs\ssx-tricky.iso <courseSlot> .\my-track.wav discs\ssx-tricky-custom-music.iso
```

## What the packer does

Race music is not stored in a level BIG. `DATA\AUDIO\MUSIC.BIG` holds a triplet per song:

- `.mpf`: the PathFinder node graph;
- `.mus`: 128-byte-aligned SCHl audio chunks;
- `.bnk`: a separately mixed asynchronous phrase bank.

`DATA\CONFIG\MUSICMAP.INF` selects songs for each course, while `MUSIC.INF` names the triplet and its mix
settings. Intro/start-gate stems are a different system in `DATA\AUDIO\<LEVEL>.BIG` and are left unchanged.

For either arrangement mode, Snowknife:

1. Reads the target course's first retail song as a compatible graph donor.
2. Converts the WAV to 36,000 Hz stereo and slices it to the exact frame count of every retail sample slot.
   The source first plays from zero to loop end, then wraps to loop start while filling the donor's full span.
3. Encodes every slice as an independent PS2 EA-XA v1 SCHl stream and installs it at the corresponding
   128-byte-aligned retail MUS offset. Sample metadata, chunk-count fields, and offsets remain unchanged.
4. For **linear loop**, rewrites every audio node's existing target fields to the next sample-table node, sends
   the last sample back to the first, and maps mid-race gameplay-event slots to a retained no-jump router. The
   native event-zero race-reset/start dispatcher and final finish dispatcher are required and remain unchanged.
   The MPF length, node records, link counts, router records, and sample table remain donor-shaped. For **retail
   adaptive graph**, the complete MPF remains byte-for-byte unchanged.
5. Replaces that song's `.mpf` and `.mus` members while streaming every other byte of the 451 MB BIGF archive
   through unchanged.
6. Narrows the target course playlist to the donor song, writes the arranged BPM, and sets its
   asynchronous/delay mix to zero so the retail `.bnk` phrases do not play over the custom master.

Both modes retain the game's original short-stream loading and buffering shape. Linear loop removes normal
path-level/event jumps and is the default for new selections; retail adaptive deliberately retains them for
comparison and compatibility testing.

## Reference sound study

Load an extracted retail level in **Scene → Reference**, then open **Sound → Reference**.
The panel reads `Audio/Environment.json`, the level's top-level intro stems,
`Audio/Music/playlist.json`, and each song's `graph.json`.
It selects the same intro tier as Unity (C, then A, then B), exposes every chosen-tier stem for a finite preview,
and offers a twelve-chunk normal-path preview of the selected race song. It also shows the race graph's BPM,
node/sample count, sections, event slots, routers, and average streamed-sample length. **open annotated graph…**
opens a read-only diagram of the complete native PathFinder graph:

- node index runs left-to-right and the graph's authored section becomes a horizontal lane;
- audio, control/marker, and loop nodes have distinct colours;
- solid edges are unconditional while dashed edges show path-level ranges;
- event badges mark the node-changing router targets; the sidebar labels the known trick-tier/reset/finish
  events and deliberately marks unresolved event IDs as unresolved;
- clicking an event, node, or outgoing link focuses the corresponding dot and shows its raw sample, section,
  chunk-count, duration, and branch range;
- **play sample** auditions one dot, while **follow path** schedules up to 32 decoded WAVs on one audio clock.
  Its 0–127 path-level slider applies the native first-matching-range rule (80 is the normal race default), so
  ordinary two-link audio nodes no longer end the preview immediately. The current sample pulses in the graph.
  Playback stops at a loop/terminal/safety limit, or at a loop-counter choice the static study cannot resolve;
  gameplay event jumps are not simulated because only the live game knows when they fire.

This is a study of the reference graph, not a simulation of a whole race. It explains which transitions the
retained graph permits and where gameplay event dispatch can jump, while the live game still decides the
current path level and when each event fires.

Reference **Test** is the live simulation: a declared environment filler plays while the rider is off-board.
Mounting starts the playlist's lead PathFinder song and crossfades it up over 1.5 seconds while fading the
environment out; dismounting reverses that mix. Intro stems remain the fallback for an extracted reference
without `Audio/Environment.json`. Race links use the same 0–127 path level derived from speed, air and boost, and
boost edges queue the same tier-one enter/exit events at a native chunk boundary. All decoded buffers use the
page-lifetime interactive AudioContext shared with board and world audio.

**Test → Options → Game volume** is the master gain above that complete live-game graph: environment and race
music, board beds and big-air wind, positional emitters, prop hits, and collision/effect cues. It is persisted as
0–100%, and zero is a real mute without stopping or resetting the voices underneath it. Scene → Sound auditions
deliberately bypass this master so a muted Test run does not prevent authoring or previewing sounds. The authored
and reference Sound study subsections start collapsed but remain independently expandable.

## Superseded single-stream proof

The original proof collapsed the MPF to one sample containing an entire song. Offline extraction and decode
worked, but PCSX2 selected System Overload without producing audio. Retail System Overload uses 318
independent streams of about 1.73 seconds each; the proof instead supplied one 165-second stream with 2,473
data blocks and also changed a per-node chunk-count byte from four to one. The short-stream canary above was
introduced to restore every one of those runtime-tested constraints.

### Original offline verification

The proof build used a 12-second, 44.1 kHz stereo identification WAV against the retail GARI slot:

- resampled stream: 36,000 Hz stereo, 432,000 frames;
- encoded `.mus`: 468,096 bytes;
- encoder→repository decoder round trip: 55.8 dB SNR on the identification tones;
- rebuilt MPF: 348 retained nodes, exactly one sample, node sample values only `-1`, `0`, and `1`;
- rebuilt `MUSIC.BIG`: parsed and extracted successfully after being written back through the ISO;
- ISO re-extract: one 12.000-second, 36 kHz stereo chunk at MUS offset zero, with the MPF duration field
  exactly 12,000 ms.

The first proof disc was `discs/ssx-tricky-custom-music-test.iso`. It established the encoder, container,
BIGF, and ISO round trips, but its single full-length stream did not play in PCSX2. The current retail-shaped
canary subsequently passed its in-game playback acceptance test in PCSX2.

### Retail-shaped canary verification

The current Slopesmith integration was verified with a project-local `test_song.mp3`, a 165.4-second
44.1 kHz stereo source staged as a 23,814,978-byte 36 kHz stereo PCM16 WAV. A complete
MOUNTAIN33-over-GARI repack produced `discs/ssx-tricky-mountain33-shortstreams.iso`:

- the System Overload MPF is byte-identical to retail (matching SHA-256);
- its 318 sample offsets still address 318 independent SCHl streams, spanning 550.9 seconds of graph slots;
- the rebuilt MUS is exactly the retail 21,545,600-byte length;
- all 318 streams re-extract and decode as 36 kHz stereo WAVs of about 1.73 seconds;
- the first encoded slice passed the repository decoder at 34.7 dB round-trip SNR and its ISO-extracted WAV
  measured -21.1 dB mean / -7.0 dB peak;
- MUSICMAP still selects only System Overload and its retail graph remains intact.

This proves the authored-folder, encoder, fixed-offset MUS, BIGF, and ISO round trips; the resulting ISO was
also confirmed audible during an in-game race in PCSX2.

### Linear-loop MVP verification

The first editable arrangement build used the same 165.4-second source with BPM 120 and a full-file loop.
MOUNTAIN33-over-GARI produced `discs/ssx-tricky-mountain33-linear-mvp.iso`. Re-extracting its packed
System Overload song proved the container and links, but an in-game test was silent because it incorrectly
neutralized event zero—the race-reset/start dispatcher—leaving the runtime without a live starting node.

The corrected `discs/ssx-tricky-mountain33-linear-mvp-v2.iso` retains event zero and the finish event while
neutralizing only the nine mid-race event rows. Its offline round trip proved:

- the MPF remains 10,172 bytes with all 348 donor nodes and all 318 donor samples;
- node zero targets the first audio node, every audio node targets the next sample in table order, and sample
  318 targets sample 1; no linear-link mismatches were found;
- all seven startup/reset and seven finish slots are byte-identical to the donor, while the 63 mid-race slots
  select donor router zero, whose flags do not change the current node;
- the MUS remains exactly 21,545,600 bytes and all 318 independent chunks re-extract and decode as 36 kHz
  stereo WAVs;
- MUSIC.INF reports the arranged BPM and MUSICMAP selects only System Overload.

This is a complete offline container/graph proof, and the corrected v2 ISO was subsequently confirmed audible
in an in-game race. That runtime acceptance also proves event zero must remain native: the otherwise-identical
v1 build that neutralized it was silent, while v2 starts normally with the reset/start row restored.

## Current behavior and limits

- The custom song begins at **race start**. The start-area intro stems remain retail.
- **linear loop** plays the source beginning once and then repeats the authored loop region. Its edit surface
  is intentionally limited to BPM and loop points; it does not yet expose arbitrary nodes, stems, branches,
  fades, or event rules.
- **retail adaptive graph** still branches. Because its sample identities were authored for System Overload,
  a branch can jump between positions in the custom source. This mode is retained as the previously proven
  playback-compatibility fallback.
- Filling the Tricky meter can still trigger the game's special global `SlayBreak` song.
- The implementation replaces a retail song identity. Any other course whose playlist names that same song
  will hear the replacement too. This matters most in multi-course ISOs; choose target slots with different
  lead songs or move to the unique-song extension described below.
- Loop edits are sample-time cuts, not beat-snapped or cross-faded. Choose zero crossings or prepare a
  seamless source/loop boundary to avoid a click at the wrap.
- Staging uses the browser's own audio decoder, so the library formats it accepts are the ones that browser
  can play — every format above, on a current Chromium, Firefox or Safari. A headless export (`npm run
  smoke`, the export tests) decodes uncompressed WAV sources only. A missing source or a failed conversion
  stops the export instead of silently packing the wrong soundtrack.
- A repacked ISO carries retail data; keep it private and distribute the authored source, not the image (`Snowknife/REPACK.md`). Whatever you do share, pack only audio you have the right to redistribute.

## What full adaptive authoring would add

The format work needed for a real adaptive custom soundtrack is now bounded rather than mysterious:

1. Split authored stems into beat/bar-aligned SCHl chunks and snap/cross-fade editable loop boundaries.
2. Generate an MPF graph whose sections and link ranges express calm, normal, boost, and high-intensity paths.
3. Set exact per-chunk duration and 128-byte MUS offsets rather than retaining donor-sized slots.
4. Optionally author the asynchronous BNKl phrase bank and expose mix controls.
5. Add a unique song section to `MUSIC.INF` and append uniquely named MPF/MUS/BNK members, avoiding the
   current retail-song sharing caveat.
6. Add rights metadata/warnings, loudness analysis, and richer export preflight detail.

The remaining uncertainty is game-side behavior for newly named config/archive members and authored async
banks. The donor-shaped linear loop avoids both, which is why it is the appropriate editable MVP.
