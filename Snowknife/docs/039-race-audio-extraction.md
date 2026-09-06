# 039 — Race-audio extraction (EA PathFinder + announcer)

> How SSX Tricky's in-race audio actually works: the race soundtrack is **EA PathFinder interactive
> music** (per-song `.mpf` node graph + `.mus` chunk stream), the start gate plays the per-level
> **intro stems**, and the MC announcer is an **event-fired voice-bank system** (EA MicroTalk
> speech codec). snowknife decodes all three; `snowknife race-music` / `snowknife speech` are the new
> commands. The runtime transition rules: [Trailmap: 270-music-graph].

> **These recordings carry third-party rights.** The compositions and sound recordings belong to their
> publishers and labels, and the performances to the performers; they are licensed to EA rather than
> owned by it, so a permission from EA would not extend to them. Decode from your own disc for
> interoperability work. Decoded audio is not redistributable, including as an attachment to an issue,
> a discussion, or an example bundle. See the audio paragraph in `Snowknife/NOTICE`.

## The three music layers

| Layer | Data | When it plays |
|---|---|---|
| **Intro stems** | `DATA\AUDIO\<LEVEL>.BIG` — 16 equal-length EA-XA SCHl stems (`mesa-A1..A4`, `B1..B4`, `C1..C8`, `end`; the stems' bars are 5.818 s) | The start gate / course intro. `data/config/intromus.inf` maps track→BIG; `audio.inf` `INTRODUCK=70` ducks it under speech |
| **Race songs** | `DATA\AUDIO\MUSIC.BIG` — per song `<name>.mpf` (PathFinder graph) + `<name>.mus` (EA-XA chunk stream) + `<name>.bnk` (async loop bank) | During the race, following the riding via the graph |
| **Jukebox** | `DATA\AUDIO\JUKEBOX.BIG` (incl. `itstricky`) | The jukebox playlist; "It's Tricky" is the full-Tricky-meter song |

`data/config/musicmap.inf` is the per-track playlist — **one level = "Top" (Top Bomb), "Hip" (Hip Hop
Phenomenon), "Bass" (Bassinvaders)** — and `data/config/music.inf` carries each song's
`PATHDATA`/`MUSDATA`/`LOOPDATA` member names plus BPM, delay-effect and level parameters (Top Bomb:
100 BPM, PATHLEVEL/ASYNCLEVEL 90). The short name selects the first music.inf section containing it
("Top" → `[Top Bomb]`).

## The PathFinder graph (MPF v3.1)

A song is a directed graph of ~2.4 s music chunks; the engine walks it chunk by chunk and picks a
link at each node from game state — that's how the music "follows" the riding without ever
hard-cutting. Layout (validated against vgmstream's parser AND every sample offset of the three
songs landing on an `SCHl` header):

- Header: `'PFDx'` (LE `xDFP`), version 3.1; counts at `0x0d`-`0x13`: tracks, sections, events,
  routers, vars, nodes (u16). Top Bomb = 1 track / 4 sections / 11 events / 12 routers / 2 vars /
  **232 nodes / 202 chunks**; Hip Hop = 254/224; Bassinvaders = 471/445.
- Node-offset table (u16 × nodes, each ×4) at `0x24`. Node entry = 12-byte header (`+0x00` u16
  sample index, `0xffff` = logic node; `+0x03` flags — `0x81` entry node, `0xff` logic; `+0x0b` u8
  link count) + links (u32 each: next-node id in the high u16, a low-u16 parameter).
- After the last node: the **event table** (events × tracks × sections bytes — values index the
  router list), **routers** (u32 each — most carry a node id: the jump target a fired event routes
  the playhead to; `0xffff____` entries are special actions), **vars**, then the samples table
  (u32 `.mus` offset ×4 + u32 meta per chunk).
- The `.mus` chunks are plain EA SCHl/EA-XA streams (stereo 36 kHz here), decoded by the existing
  codec path; chunk boundaries are musical (median 2.40 s at Top Bomb's 100 BPM = one 4-beat bar).

Most sample nodes carry **two links** (152 of Top Bomb's 232): the chunk that continues the current
musical line vs a jump to another line. Logic nodes (one link, no sample) sit between musical
sections. **The branch rule** [Trailmap: 270-music-graph]: a link is
`{min, max, next}` and the first link whose inclusive range contains the stream's **PATH LEVEL**
(0..127) wins — verified in data: every node's links partition 0..127 contiguously across all 954
nodes. The game holds path level **80** in a race, raises it to ~90 in an über-trick tier,
127 on "It's Tricky". **Events** are queued s16 commands
consumed at the next chunk boundary: `eventTable[event, section]` → router `{action, flags,
targetNode}` jumps the playhead (game: trick-tier enter 1/3/5, exit 2/4/6, normal 0, finish 10).
Full runtime spec: [Trailmap: 270-music-graph].

`snowknife race-music <iso> <courseSlot> <mapDir>` decodes every chunk to
`Audio/Music/<song>/chunk_NNN.wav` + a `graph.json` (nodes, links, event table, routers, samples)
per song. MUSIC.BIG (451 MB) is unpacked once into a stable temp cache.

## The announcer (MC) — event-fired voice banks

`DATA\AUDIO\SPEECH.BIG` ships voice banks under `data\speech\` (config `speech.inf`): `mc\` = the
in-race announcer, `char\` = rider chatter, `narr\` = the World Circuit narrator, `fe\` = front
end, plus crowd **chants** (`chant.inf`: 4 banks per character — name-chants — and 12 general).
The MC banks are named **per race event** — `Big_Air`, `Big_Jump`, `Land` (161 lines!),
`Knockdown`, `Pass`, `Position`/`Positioning`, `Takeoff`, `Spins`, `Flip`, `Grab`, `Combo_Trick`,
`Boost_Icon`, `Sweet`, `Slow`, `Go`, `Agression`, `Bonus`, `showoff`… — each `.dat` is N voice-line
variants back to back; the game fires an event and plays a variant.

Each line is an EA SCHl stream with **codec2 `0x04` = EA MicroTalk (MT10:1)**, EA's LPC speech
vocoder — new decoder `UtkCodec.cs`, ported **into the SSX-Library submodule** from vgmstream's
`utkdec.c` (the same oracle the other three codecs were verified against) and carrying vgmstream's
ISC copyright and permission notice in its own header. The non-obvious block rule: MT frames are
VBR and each SCDl block is byte-aligned per channel with one flag byte before the data, so the
**bit reader restarts every block while the LPC state carries across** (vgmstream's
`flush_ea_mt`); a channel's block region starts at `payload + 4 + 4*ch + offset + 1`.

`snowknife speech <file.dat|dir> <outDir>` decodes a bank (or a folder of them) to
`<bank>/NNN.wav`. The 18 core MC event banks = 529 lines (stereo 36 kHz). Validated against
vgmstream (which names the codec "Electronic Arts MicroTalk"): identical sample counts, 99.8 % of
samples byte-identical, the rest ±1 LSB (float rounding) — audibly exact.

The game gates each announcer fire through a per-event × 10-excitement-level probability table; the
boarder-state event dispatcher posts both the music events and the speech rows.
[Trailmap: 430-music-and-announcer]

## Sound-level configs

`data/config/audio.inf`: front-end vs in-game level scaling (`IGLEVELSCALING`: SFX 100, MUSIC 93,
CHARSPCH 150, PASPCH 85, INTRODUCK 70 — one level overrides 45). `chant.inf`/`crowd.inf` list the
crowd banks; `jukebox.inf` is the jukebox playlist order.

## Unity runtime handoff

Graph walking, scheduled chunk playback, ride-state events, and announcer playback now live in [Unity 039 — Race-audio runtime](../../Unity/docs/039-race-audio-runtime.md).

## See also

[015 — Audio extraction](015-audio-extraction.md), [Unity 039 — Race-audio runtime](../../Unity/docs/039-race-audio-runtime.md), and [Trailmap: 270-music-graph, 430-music-and-announcer].
