# SSX (2000) PS2 import

The shared C++ importer supports the original NTSC-U SSX disc alongside SSX Tricky.
Slopesmith's `/isos` page runs that same importer in its local browser worker.
Select a plain `.iso` or the `.bin` from a Mode 2 Form 1 BIN/CUE dump. The CUE is
not needed for this single-track data disc. Desktop discovery accepts `.iso` and
`.bin` beside the executable; Quest's existing document picker accepts either.
The importer reads logical sectors on demand without making an ISO copy.

SSX maps use separate identifiers (`SSX_SNOW`, `SSX_MERQUERY`, and so on), so they
can coexist with Tricky maps. Browser maps remain in IndexedDB. Native imports
publish the ordinary `Maps/<identifier>` folder and retain existing folders.

```powershell
./temp/native-core/Release/openslope_import.exe list "discs/SSX (USA).bin"
./temp/native-core/Release/openslope_import.exe extract "discs/SSX (USA).bin" SSX_SNOW Maps
```

The reader was written for this change using the existing native helpers,
portable map contracts, the local Trailmap 500 format summary, and measurements
from the supplied disc. It flattens the spatial cells into portable documents,
resolves terrain materials to their texture slots, and preserves the shared
centimetre coordinate frame.
[Trailmap: 500-disc, 500-members, 500-cells, 500-patch, 500-instance, 500-wfx, 500-aip, 500-ssh]

The exported map contains:

- `Patches.json`, diffuse PNGs and lightmap PNGs.
- `Models.json`, `Meshes/*.obj`, `Materials.json` and `Instances.json`, including
  placement transforms, visibility, material flipbooks and instance lighting.
- Original material appearance words in `SSXRenderFlags`, translated alpha flags,
  and explicit `AlphaMode` policies shared by Slopesmith and the native renderer.
  Alpha-enabled sheets use their existing PNG alpha; black RGB is never a key.
  Crowd sheets, trees and fences cut out; partial-alpha pages blend.
- `Collision/*.obj` and `Physics.json`, with placement collision bindings.
- `Lights.json`, `AIP.json` with all eight start slots, and `Splines.json`.
- `Skybox/` using the same mesh and material contracts as other maps.
- `Effects.json` with converted UV scroll, four-frame crowd/material flipbooks,
  wait/control/gate commands, cell-local instance calls, sound commands, particle
  emitters and compatible fence/flag properties. The original packed frames live
  in `extensions.ssxNativeNodes`. A graph containing an unsupported command stays
  disabled as a whole and retains its frames in `extensions.ssxUnresolvedNodes`.
  No unknown original opcode is executed as a shared runtime opcode.
- `Textures/Particles/` and `RidingEffects.json`, including puff/wake/spray art and
  emitter sprites in the original executable's 34-entry registration order. The
  original NTSC-U registration table is read and validated against the image tags;
  it is distinct from SSH directory order and includes repeated mip entries.
- `Audio/SFX/` with main, course, crowd and configured swap banks, loop WAVs,
  configuration sources, `SoundIndex.json` and the recovered board surface index.
  Original SSX's MAIN bank supplies the board role. Swap banks are assets, not an
  automatically played ambient list. Intro streams are decoded into `Audio/Intro/`
  and are available to native and Slopesmith playback independently of race music.
- Retail provenance in `Origin.json`, capability/deferred information in
  `Import.json`, and lossless local archive members in `Source/`.

Build 0.83 also translates original SSX's compact real-time animation setup and
score-multiplier commands. Rigid model curves convert their frame/radian domain
to the portable second/degree domain. Pickup-bearing placements receive a
`Gem x2/x3/x5` label and explicit Showoff state; model labels identify their tier
while preserving source names and all indices. The classifier uses converted
reward effects, not fixed model IDs or visual resemblance. Decorative copies
without pickup effects keep their ordinary mode presence.

The supplied Pipedream course imports 59 multiplier pickups: 28 x2, 20 x3 and
11 x5. Model 1 / Instance 691 is an x2 pickup. Native runtime checks exercise
its spin, collection, duplicate-contact suppression, restart and Showoff gate;
the decorative Model 1 / Instance 91 keeps its ordinary visibility. Browser
checks also verify the imported animation and pickup commands reach Slopesmith's
reference runtime.

`Import.json` deliberately reports `Complete: false`, with counts of active nodes
and deferred graphs. Remaining work includes unsupported effect commands, model
animation property kinds 257/258, automatic rail candidacy, executable-derived
world settings, spatial and collision sound routing, and original `PFDx`
version-1 race music graphs.
Those graphs differ from the existing `xDFP` version-3 reader; unsupported race
music does not prevent useful sound assets or intro stems from being imported.
The spline curves and effect source records are retained for later stages. A
non-finite source instance lighting block
uses neutral lighting and adds an explicit import warning; geometry and transform
numbers still fail validation. No retail content is committed or packaged.

Validation covers synthetic plain/raw sector parity, portable outputs, bad
versions/counts/references, non-finite lighting, atomic failure and existing-map
protection. Desktop library tests exercise BIN discovery and installation. All
nine courses on the supplied NTSC-U disc were exported and exercised through the
native scene assembler and effect runtime. Synthetic regressions cover alpha
policy, flipbook playback, cross-instance particles, sprite registration order,
sound roles, invalid references and atomic failure through ISO and raw BIN input.
The browser worker test covers the same outputs, board/intro Blob routes, loop
selection and replacement of stale cached files. This does not establish exact
retail timing or headset fidelity. The adapter and probes were independently
authored from disc measurements and the existing portable contracts.

Previously cached SSX maps request a reload in `/isos` so the new materials,
effects, gem animations and sound assets are extracted. Tricky and other games
keep their cache versions. Native imports continue to protect existing map folders; export into a
new destination when comparing a fresh import with an older map.

```text
python Native/tests/ssx_import_test.py <openslope_import executable>
python Native/tests/ssx_fidelity_test.py <openslope_import executable> <openslope_ssx_fidelity_tests executable>
```
