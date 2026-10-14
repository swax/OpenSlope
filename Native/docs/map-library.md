# Quest map library and ISO import

The library root is an ordinary Maps folder. Its immediate subdirectories are courses; a
`Patches.json` in a course directory makes it available to select. This is the existing OpenSlope
terrain contract, including custom Slopesmith maps. `Shared/`, incomplete imports, and hidden
staging directories do not appear as courses. Playback validates terrain, present props, collision assets and PNGs before entering VR;
invalid JSON or corrupt PNGs report an error in the library. Selecting a course never requires an ISO.

## Android storage

The small Java launcher owns Android's system document pickers. The game, ISO9660/BIG/RefPack
readers, terrain converter and texture decoder remain C++. `ACTION_OPEN_DOCUMENT_TREE` grants
access to a selected Maps root; the URI and persistable read/write grants survive app relaunches.
The root can be read-only for custom-map playback. Import requires write access and provider
support for directory renaming. See [Android's document storage guidance](https://developer.android.com/training/data-storage/shared/documents-files).

The library is a 2D panel, and the OpenXR player is a separate immersive activity/task. Playing
a course closes the panel; leaving the game opens Home with a pending library intent. The manifest
declares both activity modes and Horizon OS 69+ hybrid support, following
[Meta's hybrid-app transitions](https://developers.meta.com/vr/documentation/spatial-sdk/hybrid-apps-overview/).

Document URIs are opaque identifiers, never converted to guessed filesystem paths. Folder listing
and publication use `DocumentsContract`. For playback, the selected `Patches.json`, optional complete
prop JSON set, optional AIP/SOP, Physics/SSFLogic, World and RiderAnimations metadata, optional model-only Skybox tables, and only their referenced `Textures/`, `Lightmaps/`, `Meshes/`, `Collision/` and `Skybox/Textures`/`Skybox/Meshes` assets are copied
into an isolated application cache directory. C++ readers provide the reference list, keeping
Java independent of map-record parsing. Separate encoded image/geometry budgets are 256 MiB each;
render meshes and collision proxies share the geometry budget.
The native host receives that path; the cache is removed when the game activity ends. The source
library remains authoritative. Missing optional images use the renderer's fallback. Copy failure
or cancellation removes the newly created cache. Missing meshes reject playback. Import source
sidecars are not copied. The optional Audio library copies WAV/JSON/INF bank,
program and music assets under its own 512 MiB budget, plus the shared board
routing sidecar when present. See audio-playback.md. Maps without prop tables
remain valid terrain-only courses.

The alternative app Maps root is `Android/data/org.openslope.nativeplayer/files/Maps` in external
application storage. Courses written there by the application are listed with the same rule. ADB
may not create app-readable files in this directory on Quest firmware; use a
public Downloads ISO and the app's normal import flow, or a selected SAF Maps
folder, when direct transfer is restricted. The system
folder picker cannot choose Android/data on current Android versions, so **Use app Maps folder**
selects this root directly. Missing/moved folders and revoked grants ask the user to choose again.

An ISO selection opens a read-only descriptor. `lseek` verifies random access, and the C++ reader
uses bounded 64-bit `pread`. It does not duplicate a multi-gigabyte ISO into app storage. Providers
that supply nonseekable streams are rejected with a message to select a local copy instead.

## Import contract

The current reader accepts the PS2 SSX Tricky PBD version, primary ISO9660, C0FB/BIGF/BIG4 archives
and the specified RefPack streams. It discovers course archives under `DATA/MODELS`; the front
end is excluded. Unsupported titles/platforms and corrupt data report errors before publication.
The user selects any subset of courses. Existing names, including custom courses, are skipped.

Each course is extracted into a fresh app cache directory, validated with the same terrain/image/prop loaders
used by playback, copied into a hidden staging directory under Maps, then renamed to its course
name. A course becomes visible only after publication. Failed/cancelled imports clean up only
their own new directories. Completed courses survive cancellation of a later course. Process death
can leave a hidden staging directory; it remains unlisted and can be removed through a file manager.

| Output | Compatibility |
|---|---|
| `Patches.json` | Shared OpenSlope schema, raw centimetres, 16 Bernstein control points, patch names, UV corner ordering, lightmap rectangle, surface type and trick-only flag. |
| `Textures/<name>.png` | SSH directory names; decoded RGBA and modulate2x colour conversion. Associated-alpha inference uses the strict normalized colour bound, as described in the source-provenance notes. |
| `Lightmaps/<name>.png` | Raw full-range RGBA; both lighting blend terms retained, without colour brightening. |
| `Models.json`, `Meshes/*.obj` | Shared model hierarchy, raw mesh positions, authored UV/normal splits, material IDs, rest poses and animation records. Optional exact affine matrix extension; rendering samples animation at time zero. |
| `Instances.json` | Model IDs, names, raw placement TRS/matrix, lighting, authored visibility, collision/response flags, mass/bounce/surface, proxy paths, physics index and effect slot. When ADL is present, serialized manifest hashes join `IncludeSound`/`Sounds` and typed external emitters. |
| `Collision/*.obj`, `Physics.json` | All SSF pool payloads; raw proxy positions and normals, preserved physics centre/inertia, level records and raw/RLE mask bytes. Models carry source local `CollisionBounds`. Older exported physics data in `SSFLogic.json` also loads. |
| `Materials.json` | Static base-texture references and flags; neutral labels, with remaining material behavior fields deferred. |
| `Skybox/` (when present) | Separate model/material/OBJ/PNG panorama. Camera-local rendering needs no placement or ring metadata; see world-appearance.md. |
| `AIP.json`, `SOP.json` (when present) | Existing start-slot, AI/race-line and event contracts; expanded displacement steps, raw seeds, DTF and path attributes. Runtime retains the seed vertex and uses the middle start slot. |
| `RidingEffects.json`, `Textures/particle-*.png` (when the shared particle bank is present) | Native optional profile and named particle art. Playback references independent optional puff/wake/sheet slots; the cache copies their images and metadata. Sprite registration-index mapping and full effect runtime remain deferred. |
| `Audio/` (when configured) | Complete assigned sound banks, loop slices, placed fixed-environment banks, preserved configs, course music graphs/chunks and configured async banks/intro stems. Empty slots stay empty. Executable collision/board indexes, dynamic chants and speech remain deferred; see audio-import.md. |
| `Origin.json` | Existing `openslope-origin/v1`, `retail`, course name and `retail-extract` reason. |
| `Source/` | Decompressed level archive sidecars retained locally for later conversion stages. Not a portable runtime contract. |
| `Import.json` | Explicit stage report: `Complete` is false, with emitted and deferred stage names. |

This imports canonical terrain, static-prop rendering, collision data, AIP/SOP paths and configured audio assets; complete course conversion
remains to be implemented. Live object behavior, rail splines, original world settings, effects and complete audio routing/runtime
remain deferred. A folder already produced by a compatible extractor or Slopesmith
is also accepted. Rendering those systems is separate from converting them.
The implemented terrain appearance contract is described in [terrain appearance](terrain-appearance.md).
See [static props](static-props.md) for geometry, lighting, alpha behavior, culling and limitations.
Older native terrain-only imports continue to play; importing into a fresh Maps root adds props.
Re-importing into a fresh root also adds the authored start and course paths.
Existing course folders are always skipped, including earlier imports.

## Verification

`npm run verify:native` runs authored synthetic disc fixtures, with no retail bytes. The fixtures
exercise both archive variants, compressed members, a known polynomial surface, named textures,
raw lightmaps, provenance, corrupt/truncated inputs, failed-import cleanup and existing-map protection.
Native unit checks cover all RefPack forms and overlap, bounds, cancellation and custom-map discovery.

For a local disc, use `openslope_import` to extract into a separate Maps root, then run
`python tools/native-compare-maps.py <native-course> <reference-course>`. The comparator checks
patch metadata at float32 precision, controls within 0.01 raw cm (0.1 mm), exact decoded RGBA
texture/lightmap pixels and provenance. PNG compression and JSON number spelling may differ.
The independent double basis transform and the application alpha policy can differ from a reference
exporter; any tolerance change or named texture exception must be explicit. The provenance notes
record the current local GARI comparison. Defaults do not permit texture mismatches.
Run `python tools/native-compare-props.py <native-course> <reference-course>` for the static-prop
contracts and expanded mesh triangles. The tool checks hierarchy, placements, visibility, flags,
lighting and animation records, with explicit geometry tolerances. Deferred behavior/material
fields and neutral material labels are excluded; it reads generated files only.
Run `python tools/native-compare-paths.py <native-course> <reference-course>` for AIP/SOP output.
Seeds, slots, attributes, DTF and event stations compare at recovered float32 precision; expanded
displacements permit 0.01 raw cm. Reversed authored event intervals are preserved, not normalized.
No reference output or retail fixture is tracked or packaged.

The Android APK and its JNI exports are build-checked. Document picker behavior, provider grants,
VR transitions, interruption, and controller behavior require a connected headset. A desktop
extraction comparison does not establish that the headset UI or storage provider works.
