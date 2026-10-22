# Common course ambience for streamed maps

Fresh SSX3 and On Tour imports adapt a conservative subset of placed sound
records into ordinary `Sounds.ExternalSounds` records and a standard PCM bank.
`Audio/AmbientImport.json` records `Fidelity: Approximate`, source banks/slots,
owner-hint counts and unresolved emitter counts.

The original event resolver remains unresolved. The adapter groups source events
by their owning placements and chooses a harmless ambience family from a unique
highest count of descriptive owner names: crowds, lifts, gondolas, flags, lodges,
fire or waterfalls. It creates no positions, collision sounds or scripted alarms.
Unknown or tied families stay deferred. Source-resource identity binds placements;
older portable indices cannot attach sound to the wrong prop.

Only decoded original loop regions lasting at least 0.75 seconds qualify. Source
banks remain intact; loop copies in `Audio/SFX/openslope_ambient` receive the
common glide RMS/peak and seam treatment. Crowd variants cycle deterministically.
Both players use explicit `SoundBank`, `SoundSlot`, `Activation: Proximity`
routes while preserving original event and region fields. Those IDs never enter
Tricky's resolver or hit gate. Invalid routes stay silent. The browser retains
audio-only placements without drawable geometry.

On Tour base crowd banks currently contain unsupported codec 8 or omitted speech
slots. Decoded medium crowd chants provide an approximate crowd bed. SSX3's
additional environment families have no admitted non-speech PCM, so the validated
Peak 1 result adds crowds; other ambience remains deferred. Bank names do not
establish original event routing or gates.

Existing maps with `SoundBindings.json` and decoded source banks can run:

```text
openslope_import adapt-course-ambience <map-folder>
```

This preserves existing Sounds and explicitly muted placements, saves
`Audio/Instances.before-ambience.json`, stages publication, rolls back failures
and leaves a completed rerun unchanged. Generated media is bounded to 128 MiB,
source WAVs and metadata to 64 MiB each, and the complete Audio tree to 512 MiB
and 20,000 entries. Browser-local courses require reimport at cache revision 7;
the mountain draft is separate from extracted reference files.

Local validation adds 54 of 105 source emitters on SSX3 Peak 1 and 28 of 60 on
On Tour ER1 day. Both installed maps were backfilled while checking every
pre-existing instance field and other root JSON documents for preservation.
Synthetic tests cover stale indices, loop admission, ambiguous families, missing
clips, authored/muted preservation, malformed routes, idempotence and failure
atomicity. Native mixer tests exercise explicit routes and gate bypass. Browser
checks exercise packing, geometry-free anchors, URLs, field gain and rebuilt Wasm
workers. These are functional checks, not listening parity.

[Trailmap: 523-streamed-course-ambience]
