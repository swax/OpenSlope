# Automatic course Audio extraction

The ordinary ISO importer now stages Audio alongside terrain, props and paths.
The Windows CLI and Quest JNI use the same independent implementation. Existing
course folders remain protected: import into a fresh Maps root to add these
assets. No disc, decoded WAV or generated resolver data enters the application
package or source control.

Clean Trailmap chapters 190, 200, 260, 270 and 420 establish the contracts.
`Contracts/external-sound-banks-v1.json` is a byte-identical tracked copy of the
reviewed fixed-environment bank identifiers in Trailmap's data contract; CMake
embeds this copy so building does not require the optional local specification.
These are routing facts, not decoded media or executable collision resolver rows.
Regional executable verification of these fixed routes remains outstanding.

`BANKS.INF` binds groups 0–5 to complete decoded banks in `Audio/SFX/<bank>`.
Every populated slot has a full WAV; sustaining slots also have their exact
`.loop.wav` region. `bank.json` preserves empty slots, frames, format, priority
and loop points. Banks shared by multiple groups are converted once. `SWAP`
remains an availability registry: its entries do not start an ambient bed and
unused registry banks are not copied.

The `.map` manifest's fixed-width hash field joins ADL records to instances.
ADL absolute offsets, shared records and all four emitter strides are checked.
The three header padding bytes are ignored. Raw positions and type-specific
floats stay in the existing `Sounds.ExternalSounds` contract; shorter types do
not acquire invented trailing fields. `Hash`, `IncludeSound` and `Sounds` are
written to `Instances.json`. The existing runtime performs the coordinate change.

Placed fixed environmental events and crowd slots receive explicit paths in
`Audio/ExternalIndex.json`. Missing referenced environmental banks are reported
and stay unresolved. Event 102 needs the gameplay-dependent character/generic
chant selector. Build 0.44 independently recovers ordinary collision-event routes from the
user executable; see collision-audio-import.md. Supported sources write the
portable SourceExecutable/Banks/CollisionEvents contract. Unrecognized sources
retain the empty `ResolverState: Deferred` index; no slot mappings are guessed.
Build 0.45 independently extracts the per-surface board index into the course's
Audio folder; see board-audio-import.md. Missing/unrecognized routing retains
the PACK fallback. `SNOW.INF` is copied from the user's disc.

`MUSICMAP.INF` selects the ordered course playlist. Names resolve to exact or
unique prefix sections in `MUSIC.INF`; ambiguous names reject import. Every song
gets its complete graph, all addressed WAV chunks, configured BPM/path gain,
preserved settings and decoded async loop bank. The full-meter swap song is
staged separately in `special-song.json`. `INTROMUS.INF` selects the intro archive;
all its stems and their format/frame metadata are decoded into `Audio/Intro`.
Race/menu stem sequencing, full-meter song swaps, async mixing and delay remain
runtime work; extraction is not evidence that those consumers are implemented.

Archive tables are bounded and only needed members are read, including members
of the large music archive. Aggregate decoded bank memory is capped at 128 MiB.
The completed Audio tree is bounded to 512 MiB, 20,000 entries and 64 MiB per
file, matching Quest caching. PCM writes use 64 KiB batches and loop export copies
only the loop slice. Cancellation checkpoints run between records, slots, chunks
and stems. Any conversion error/cancellation rolls back the new course staging
directory; no playable partial course is published.

Authored synthetic ISO tests cover shared banks/records, nonzero ADL padding,
every emitter layout, config prefixes, crowd/fixed routes, silent unresolved
events, relocated executable collision routes and branch delay slots, music triplets, intro stems, missing members, invalid offsets/graphs,
ambiguous names and whole-course rollback. All eleven owned local course imports
matched 25,128 instance hash/sound joins and 10,343 existing WAV PCM payloads.
All Audio trees fit the cache budget. A production Vulkan/PCM capture plays a
fresh GARI import directly. Build 0.44 passes 98 Quest cache/JNI checks and a
bounded ALASKA activity startup; worn listening remains unverified.
Full desktop/VR parity remains tracked in desktop-parity.md.
