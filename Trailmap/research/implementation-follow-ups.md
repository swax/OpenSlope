# Implementation follow-ups

Spec findings that bear on Snowknife, Slopesmith or the Unity port — where the
implementation currently does something the executable does differently, or
where a rule is now exact enough to adopt. Each item names what the spec
establishes, what the code does today (checked, not assumed), and the change.
Close an item by fixing it or by recording the deviation as deliberate in the
owning component's docs, then delete it here.

## Snowknife — repack and extraction

### BNK rebuild keeps a stale memory plan

`Formats/BnkFile.cs::Write` copies header bytes 0–19 verbatim and patches only
the slot count. Words 8/12/16 are the engine's memory plan: data-region
offset, sound-processor-resident block size, main-memory block size
(spec:260-bnk-blocks). The loader uploads exactly `[word8, word8 + word12)` to
the SPU and relocates every sound as `base + (offset − word8)`. A rebuilt bank
that grows past the shipped size therefore never gets its tail uploaded —
which is the observed "must not exceed the size the level shipped with, or
nothing plays" rule in `Snowknife/REPACK.md`. Recompute the three words on
write (offset = start of the sample region, SPU size = file end − offset,
main = 0 for course banks); the budget then becomes SPU RAM, not the shipped
file size.

### PBD strip table is a signed 8-bit unpack

Each strip entry is the byte pair (3 × vertex count, 0), unpacked as
`V2-8` signed (spec:220-chunk-layout), so a strip may hold at most 42 vertices
and retail never exceeds 32. `objTriPBDHandler.GenerateTristripDataOneNew`
caps a *chunk* at 50 vertices but has no per-strip cap; a stripper output of
43 or more vertices in one strip would be read as a negative length. Cap
strips at 32.

### SSF acceptance is all-or-nothing

If the u16 at offset 4 is not 0x1500, or the SSF instance count differs from
the PBD's, the engine discards the whole behaviour file and binds every
instance to the default record — mass 1000, bounce 0.5, no shape, no effects
(spec:230-loader-accept). A repack that appends instances to one file and
not the other ships a level whose props all lost their behaviour with no
error. Validate both conditions in the repack.

### Rail candidacy is the spline record's second value

The behaviour file's spline record `{i16, i16, u32 style}`: the first i16 is
discarded, the second is stored into the rail's status word and bit 0 is the
grindable gate (spec:230-splines). The dead `(0, 0, 13)` rails were exactly
that; write 1 for any rail meant to be grindable from load.

### Physics pools and the mass block

- The community decoder reads only payload [0] of a pool entry and always
  RLE-decodes the occupancy masks. Retail ships multi-payload entries (the
  Merqury train ×4, the Merqury gargoyle ×21, Megaplex bumpers ×2) and four
  raw-mask bodies (Merqury hydrant lid ×6, two gargoyle pieces, Untracked
  red flare) (spec:230-pools, spec:230-mask-encoding). Reference imports of
  those levels decode those props wrong.
- Floats 0–2 of the mass block are the tree root / shape centre, which
  `Bundle/SsxPhysicsBodies.RootCenter` reads correctly; floats 3–5 are the
  centre of mass the knock-off body pivots about (spec:230-mass). Verify
  which floats feed the bundle's `physicsBodies.com` — the roller pivot must
  be 3–5.

### Smaller format points

- C0FB header-size field = table end − 4 (spec:200-c0fb); `COFB.cs` writes the
  absolute table end. The engine's walk then covers four zero bytes past the
  last entry — benign, but off-spec.
- PBD instance `+0xF0` is a per-instance material-block index, not an SSF
  index (spec:220-instance-runtime); every retail instance names its model's
  own block. Appended instances must carry the model's block index.
- Object LOD medium/low offsets are never read by the renderer
  (spec:220-object-header); sharing one offset is the right thing to write.
- Every SSH image chunk needs an explicit non-zero size — the engine's chunk
  walker treats size 0 as end of chain (spec:210-directory). Rider and board
  banks ship trimmed palettes (28–255 entries); honour the count
  (spec:210-palette).
- The arc-length polynomial the level compiler writes is a least-squares
  cubic over 1,025 samples uniform in arc length (spec:220-arclength-fit);
  the 200-sample parameter-uniform fit in `BezierUtil.CalcCoefficients` is a
  close approximation, not the original.
- The speech bank header layout in `HDRHandler.cs` ({u8, u24, u8, u8} at 11)
  is not the engine's ({u16 BE offset, N attribute bytes} at 12,
  spec:260-speech-hdr); only matters if announcer banks are ever rebuilt.

## Slopesmith — editor and ride runtime

### Flag node fields are mislabelled

`core/effects/semantic-fields.ts` and the `flag-wave` entry in
`play-runtime.ts` read U0 as a shape variant, U1 as amplitude and U2 as
wavelength. The node is U0 = pole-end select, U1 = wave speed in cycles per
second, U2 = amplitude (free-end displacement in model vertex units ÷ model X
scale), U3 = lifetime in seconds, and there is no wavelength — one full wave
per flag length (spec:230-flag).

### Gate threshold unit

The at-least selector's threshold is authored in km/h (×100000/3600 into
engine units); `play-runtime.ts` already applies the factor, but any label
saying "100 km/h units" should say km/h (spec:150-gate). Random gates:
selector 0 continues with probability p, selector 1 with 1 − p, any other
selector always continues.

### Debounce semantics

Zero holds the node until the region unloads; a negative value holds it for
the rest of the level and refuses both the end-node request and region
teardown (spec:230-debounce). Worth surfacing in the field tip, since `0` and
`−1` read as the same "infinite" today.

### AI riders (`app/ride/ai.ts`)

- Tricks are named picks: at the jump press a roll against the trick stat
  selects a random entry from the character's 15-entry trick list, the
  marker's two flags select which rotation axes (spin / flip) are allowed
  after a second roll, and a late-release flag is rolled against skill
  (spec:395-air-tricks). The model currently rides the flags "unused".
- The push gesture: pad bits 23–24 are written every sixth frame toward the
  objective rival when it is 30°–150° off the nose within 2 m
  (spec:395-push).
- The path range query returns every event whose window *overlaps* the asked
  interval, and a raw-type-300 event overlapping the interval just travelled
  is the tracker's third re-select trigger (spec:395-range-query,
  spec:250-reset-events). `OFF_PATH` re-choice and running out of path are
  modelled; the type-300 trigger is not.
- The course reset is now exact: request refused while inside a no-reset
  window; 0.8 s hold with fade; six nearest respawn-enabled paths scored by
  distance to the closest point plus the point 8 m further along, rejecting
  candidates within 2 m of their end, keeping the current path when it wins;
  station nudged by respawn windows; 30 km/h along the segment; 1 m drop-in;
  forward bias 0.8 × the neighbouring rider's speed in race modes
  (spec:390-reset-placement, spec:390-reset-bias). Seven triggers, including
  a death plane 100 m under the grid origin, a prop-bounce accumulator
  (> 4.49, decaying 4.4 %/frame), a hard-impact accumulator (> 12) and a
  wipeout that fails to resolve in 7 s (spec:390-reset-triggers).

## Unity port

### Boost pads are one-shot

`docs/040-boost-pads.md` says the engine has no per-instance consume and
adds a 2 s cooldown. The gold speed pads and red/green trick pads end their
contact chain with the same dead-node tombstone that despawns a gem: undrawn
and untouchable for the rest of the run, re-applied from the snapshot on a
race restart (spec:360-pads-oneshot). The cooldown is a deliberate deviation
now, in the same way the gem pop-and-regrow is; record it as one.

### What "hidden" means

The authored visible flag is never rewritten at runtime. Every scripted hide
— gems, pads, mode-presence functions, start-gate and start-area hides, the
breakable-sign logo — is the tombstone: static draw off, player collision
off, an inert owning node (spec:120-runtime-hide, spec:390-gem-despawn). A
"MainType 7 hide" on a breakable is a mode-4 tombstone on the target.

### Music graph walker (`docs/039-race-audio-runtime.md`)

- Node flag 0x80 is a cancel-pending marker, not end-of-song; song end is
  router flag 0x40 (spec:270-node-runtime, spec:270-tail).
- The router action byte is a volume override (0–127; −1 untouched).
- Router flag 0x80, read from the section-0 cell at queue time, excludes that
  track from the queued command.
- Node byte 5 is the beat count: chunk duration ÷ count is the beat period,
  and the next node is fetched when the beat counter reaches the count.
- The event table is indexed track-major, then event, then section.
- Variables are a boundary list over `{match, replacement}` words, chained.

Check the walker's reading of each before assuming it matches.

### Per-character body radius

The prop-probe body sphere is per character, 0.70–1.00 m (0.85 m is
Eddie's), scaled ×100 into world units at construction
(spec:370-probe-volume). Only matters if the cast widens beyond one rider.

### Crowd chant

Mac is pinned to the generic chant set at every race position
(spec:420-chant-select). Only matters once name chants are wired.

## New capability

On Tour's world container is decoded to the record level: 432-byte patches
with the SSX 3 coefficient layout, instances naming their model and
collision proxy directly, splines with 128-byte segments, a script-binding
layer instead of effect nodes (spec:520-patch, spec:520-instance,
spec:520-scripts). An On Tour reference importer is feasible; the copied
`SDBHandler` does not apply to its streaming database (spec:520-sdb).
