# SSX On Tour PS2 import

The shared independent Native importer reads the PS2 NTSC-U On Tour ISO in
Slopesmith's `/isos` worker and native Windows/Quest builds. It writes the usual
`Maps/SSXOT_<track>_DAY` or `Maps/SSXOT_<track>_NIGHT` folder. Browser imports stay
local in IndexedDB. Failed or cancelled imports remove only their new staging
folder; existing maps and edits are preserved.

Discovery offers 15 individual tracks and the 10 night variants present on the
disc. Track codes are ER1–ER4, NP2, NP3, NPP, VB1, VB2, VB4, VH1, and WR1–WR4.
Night variants exist for ER3, ER4, NP3, VB1, VB4, VH1, and WR1–WR4. There is no
whole-mountain selection. Named terrain, props and rails determine the streaming
sectors needed for the chosen track. Overlapping unnamed sectors retain lights,
fog and paths, and nearby objects in shared sectors remain with it. Terrain
from other tracks is excluded. Coordinates remain centimetres, Z-up.
[Trailmap: 520-names, 520-daynight, 520-records]

```powershell
./temp/native-core/Release/openslope_import.exe list 'discs/SSX on Tour (USA).iso'
./temp/native-core/Release/openslope_import.exe extract 'discs/SSX on Tour (USA).iso' SSXOT_ER1_DAY Maps
./temp/native-core/Release/openslope_import.exe extract 'discs/SSX on Tour (USA).iso' SSXOT_WR1_NIGHT Maps
```

The reader validates the On Tour database and reassembles only selected streaming
groups from fixed-size blocks, including raw blocks, independently compressed
blocks, split records, carry boundaries, padding and day/night masks. Sector and
resource identifiers retain their separate 16-bit halves. Global resources are
deduplicated within a selection and conflicting copies are rejected.
[Trailmap: 520-blocks, 520-sdb, 520-records]

The common map output includes:

- Bicubic terrain, diffuse PNGs and lightmaps. Sector-local lightmap identifiers
  are assigned distinct common atlas slots; day and night use their own records.
- Models, meshes, materials and placements, including uniform scale, mirrored
  transforms and per-placement baked vertex colours. The reserved engine texture
  page absent from the archive uses a reported neutral white fallback.
- Triangle collision bound directly to each placement's source proxy reference.
- AI paths, per-track race lines, start matching and approximate name-selected
  grind rails. Source path properties, packed normals and event data are retained.
- Local lights, halos, fog models/placements and the selected region's sky dome.
  VH1's night selection reports its fallback to the available day sky.
- Environmental/equipment audio from embedded sound-bank extents, WAVs, loop
  slices and bank manifests. Unsupported codec slots are listed in each bank's
  `DeferredSlots`; original selected audio wrappers are bundled in `Source/`.
  Speech slots and wrappers containing them are omitted, along with the separate
  speech, character and music archives.
- Retail origin and import capability metadata, name maps, the streaming database,
  selected track sidecars and selected non-speech world records in `Source/`.

[Trailmap: 520-patch, 520-instance, 520-paths, 520-other-records, 260-bnk]

`Import.json` reports `Complete: false`. Compiled scripts, effect instances and
script bindings are preserved without executing them. `Effects.json` identifies
`ssx-on-tour` and contains empty graph tables. Path events remain `SourceEvents`
until their meanings are established. Mission behavior, animated models/materials,
secondary terrain textures, exact surface labels, sphere-tree collision, complex
collision admission, sound-trigger routing, some sound codecs, board-surface
selection and music playback remain deferred. Source terrain currently uses
neutral snow contact behavior. Native prop vertex-colour rendering and local
spot-cone playback have the same limitations as the SSX3 importer.
[Trailmap: 520-scripts, 520-paths, 520-other-records, 520-instance]

Implementation inputs are the format specifications, existing independent Native
helpers and direct measurements of the user-supplied disc. No external converter
or format-library implementation is linked or ported. Synthetic fixtures contain
only independently authored data; retail content stays outside source control.

The shared streamed decoder converts GS pixel order and reads position and normal
streams in their authored order. Material state controls foliage cutouts and
blending. Red helper-page models remain hidden while collision bindings are
retained. Browser cache revision 2 requires reloading older converted maps once.

```text
python Native/tests/ontour_import_test.py <openslope_import executable>
npm --prefix Slopesmith run test:full -- --only ontour
```
