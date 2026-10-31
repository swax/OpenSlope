# 072 — Local GBA course reconstruction

The owner-ROM-backed Garibaldi mountain is an editable reconstruction from the
GBA mesh. Source interfaces, event identities and confidence live in
[Trailmap chapter 610](../../Trailmap/specs/610-tricky-gba.md), when the optional
local research checkout is present. This document describes Slopesmith's adapter.

## First-class ROM loading

The shared native importer now reads supported `.gba` files directly through
`/isos`. Choose **SSX Tricky (GBA)**, load one of its eight named courses, then
Play or Inspect it. This uses the local source/cache workflow and the same
converter used by Windows and Quest. It does not require the private research
mountains described below. See [the native importer guide](../../Native/docs/ssx-gba-import.md)
for supported revision, reconstruction policy and current limits.

## Terrain and presentation

`GARIBALDI_GBA_MERGED_20` retains the accepted course, collision and scenery scale.
Smooth UV-matched triangle pairs become bicubic quad patches. Source creases
above the selected 20-degree threshold stay between patches. Boundary controls
and texture coordinates remain shared; interior fitting removes the artificial
diagonal. Fitting does not claim recovery of original authoring controls.

The current owner-calibrated scale is 0.1 metres per source unit. This doubled
the earlier map/collision dimensions while retaining the rider's physical size.
The 2D GBA horizon is wrapped into a project-owned panorama with an authored sky
fill. The selected GBA music arrangement is a project-owned looping track.

## Riding sound assignments

`BoardSoundMix.clips` optionally names mountain-owned WAVs by riding event. Its
presence selects an explicit course profile: missing assignments stay silent
and never fall through to a same-numbered clip from another game's shared bank.
Omitting the profile preserves the existing shared-bank behavior.

The Sound panel exposes assignments and the existing gain controls. Glide,
carve, grind and boost are performed loops; jump and landing use actual physics
edges. Braking is an onset, and the large-air clip is an apex one-shot. Race,
checkpoint, score, pickup, pause and recovery callbacks own their respective
cues. Exit disposes loops and prevents pending event decodes from starting.
Countdown follows the Test setting. Pickup and checkpoint cues use authored
gameplay triggers; their original placements are still unrecovered here.

Garibaldi uses the recovered effect IDs for the corresponding riding events.
UI-only and unresolved clips remain in its library. The original game also uses
hardware contact noise; the adapter supplies three original, seeded friction
beds for snow, carving and rails. These are explicitly authored replacements,
not mislabeled extracted effects or a cycle-accurate hardware reproduction.
The apex timing, mix and scoring cadence follow Slopesmith's own ride signals.

Project asset dependency collection includes clip assignments, so saved and
duplicated mountains carry their required WAVs. The native effects stay local
with the owner-derived mountain; no retail waveform is committed.

## Grind paths

Eight bare grind paths follow the measured red/white cap strips. The existing
terrain artwork supplies their visible shape; no second pipe or support mesh
is added. Each source strip becomes a straight cubic span, retaining corner
locations without Catmull-Rom overshoot. Metal is an authored riding material.

The paths are editable through the normal rail tools and export through the
normal spline writer. They establish Slopesmith rideability, not a recovered
native GBA rail format. Terrain vertices, patch controls and textures are
unchanged by this stage.

## Verification

The local study uses production patch contact and rail queries. Each of the
eight paths catches the rider from an airborne approach and retains metal rail
contact without an unwanted reset. Focused board-audio checks cover event edges,
course isolation, missing-role silence, loop disposal and late decodes. Browser
checks use the saved mountain, a controlled approach through the existing ride
relocation API with a seeded airborne approach, real physics acquisition and
actual audio sources/output. Owned clips decode while public terrain loads,
before the first riding event. Detailed generated
reports and captures stay in the ignored local study directory.

## Other extracted courses

The remaining seven AXYE courses are saved as separate private mountains. They
use the accepted 0.1 metres per source unit, editable curved terrain and the
20-degree crease threshold. Every source display triangle is accounted for as
terrain, scenery or a recorded degenerate. Flat-colour type-5 quads are retained
in scenery; the courses have their own palette and atlas dimensions.

| Original course | Slopesmith mountain | Terrain patches | Approximate route |
|---|---|---:|---:|
| Snowdream | `SNOWDREAM_GBA` | 9,193 | 1.83 km |
| Elysium Alps | `ELYSIUM_ALPS_GBA` | 7,888 | 1.77 km |
| Mesablanca | `MESABLANCA_GBA` | 10,879 | 2.15 km |
| Merqury City | `MERQURY_CITY_GBA` | 5,373 | 1.66 km |
| Tokyo Megaplex | `TOKYO_MEGAPLEX_GBA` | 6,372 | 1.54 km |
| Aloha Ice Jam | `ALOHA_ICE_JAM_GBA` | 8,693 | 1.91 km |
| Alaska | `ALASKA_GBA` | 8,251 | 1.64 km |

Each project owns its recovered horizon, 23 original effects and the same
riding-event assignments as Garibaldi, with the three authored friction beds.
The selected GBA playlist follows the course directory index; the original
course-to-music binding remains unverified. Sky fill is an authored adaptation.
Pickup/checkpoint placement remains unrecovered. Each mountain now also has
editable bare grind paths recovered from its own rail surfaces:

| Course | Grind paths | Approximate rail length |
|---|---:|---:|
| Snowdream | 8 | 251 m |
| Elysium Alps | 15 | 508 m |
| Mesablanca | 15 | 307 m |
| Merqury City | 10 | 254 m |
| Tokyo Megaplex | 10 | 242 m |
| Aloha Ice Jam | 9 | 183 m |
| Alaska | 11 | 232 m |

The adapter consumes the native special-surface predicate described in
[Trailmap chapter 610](../../Trailmap/specs/610-tricky-gba.md), rather than
assuming Garibaldi's colour indices apply to other palettes. It excludes
almost vertical support faces using a world-up normal component greater than
0.1, traces triangle-edge midpoints into chains, and retains bends as straight
cubic spans. Four small endpoint seams are joined within 0.15 m. These are
reconstructed contact paths, not recovered native authoring splines.

All 78 added paths catch and carry an airborne rider through production patch
contact and grind physics without an unexpected reset. Each saved course is
also checked in the browser for a moving metal grind and its owned grind
audio loop. Native bank spline exports and named project checkpoints accompany
the changes. Terrain, textures, presentation and sound assignments are preserved.

Validation covers native control-point round trips, original triangle
accounting, texture coverage, protected creases, terrain/scenery ground support
and production riding physics. An unstable Megaplex quad pair stays as its two
source triangles. Standalone GLBs preserve the compiled meshes with embedded
textures; these are separate from the editable patch reconstructions.

### Course identity correction

The first seven-map batch incorrectly paired resource rows directly with the
display-string table. The native menu applies a separate name-index lookup;
[Trailmap chapter 610](../../Trailmap/specs/610-tricky-gba.md) now specifies it.
The correction was independently checked by executing the native title, menu
and geometry-selection instruction snippets for all eight course IDs.

Project names, selected sky/music labels and GLB/export labels now follow that
lookup. Existing project IDs, geometry edits and bank identifiers are preserved.
Some internal bank/evidence paths retain their original mistaken label as a
stable asset key; their corrected `Import.json` identity and native resource ID
are authoritative. Named checkpoints and legacy media remain available.
