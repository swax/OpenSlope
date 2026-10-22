# SSX 3 PS2 import

Slopesmith's `/isos` page and the native Windows/Quest importers use the same
independent C++ SSX 3 reader. Choose the user-supplied PS2 ISO, then load an event,
hub, connector, or peak. Browser extraction stays local in
IndexedDB. Native extraction publishes an ordinary `Maps/SSX3_<selection>` folder.
Existing maps are preserved and failed/cancelled imports are removed atomically.

```powershell
./temp/native-core/Release/openslope_import.exe list discs/ssx-3-usa.iso
./temp/native-core/Release/openslope_import.exe extract discs/ssx-3-usa.iso SSX3_PEAK1 Maps
./temp/native-core/Release/openslope_import.exe extract discs/ssx-3-usa.iso SSX3_ARA1 Maps
```

The supported layout is the PS2 NTSC-U mountain archive. Discovery reads the
streaming database without decompressing the mountain. Extraction reads bounded
streaming groups directly from the disc; it never copies the ISO into memory.
An event includes its connectors. Peaks select hubs A/B, C/D, or E and their
events/connectors. Every selection retains the same centimetre, Z-up coordinates.
Whole-mountain import is deliberately unavailable because of its size;
select an event or peak for practical browser/headset memory budgets.
[Trailmap: 510-container, 510-ssb, 510-empty, 511-locations, 511-peaks, 511-one-space]

The shared map output includes:

- `Patches.json`, diffuse PNGs and lightmap PNGs. Texture colours remain full
  range, padded interleaved palettes are decoded completely, opaque pages lose
  gloss-mask alpha, and lightmaps are resampled/re-encoded for the shared blend
  and texel-centre convention.
- `Models.json`, `Meshes/`, `Materials.json` and `Instances.json`, including
  authored names, object rest transforms, separate uniform instance scale,
  render-state alpha modes, and per-placement `VertexLighting`/mesh stream bases.
- `Collision/` and instance bindings shared by every placement of a model in
  its section. Helper names supplement the debug-page classification, including
  reset planes, emitters and load markers. Scripted volumes retain proxies
  without becoming solid walls; permanent fence proxies remain solid.
- `AIP.json` with the complete selected AI network and starts matched by
  position; `Splines.json` with approximate name-selected grind rails enabled.
- `Lights.json` with local lights and separate halos, `ParticleModels.json` and
  `ParticleInstances.json` for fog banks, and the selected `Skybox/` dome.
  Spotlights publish the shared cone field the browser consumes. Halos retain
  native sparkle brightness and have no diffuse-light influence.
- Seven configured shared environmental/equipment sound banks under `Audio/SFX/`,
  decoded WAVs and loop slices, bank manifests, `SNOW.INF`, `BANKS.INF`, and a
  sound index. Speech slots and per-location speech banks are omitted.
- Retail `Origin.json`, capability/deferred information in `Import.json`, and
  selected non-speech source records with a resource manifest in `Source/`.

[Trailmap: 511-lm-base, 511-lm-edges, 512-full-range, 512-palette-extent,
512-render-state, 512-terrain-mask, 513-scale, 513-binding, 513-vertex-light,
514-start-slots, 514-splines, 514-sky, 515-light-record, 515-halo-record,
515-fog-model, 515-fog-placement, 510-snow, 260-bnk]

`Import.json` reports `Complete: false`. SSX 3 has compiled world scripts rather
than Tricky's effect graphs; `Effects.json` identifies `ssx-3` and contains empty
graph tables. Scripts are preserved without executing them as Tricky logic.
Ordered material frame lists and all referenced pages are exported; their clocks
and source-script bindings remain deferred. `SoundBindings.json` preserves the
structured sound attachments, collision-event lists and external emitter tails
with source identities and optional portable instance indices. Sound assets are
exported, but event-to-bank routing, activation and the board surface selector
remain unresolved. Music, animated models, sphere-tree collision, material
animation playback, secondary texture passes and exact SSX 3 riding behavior
remain deferred. Multiple triangle-proxy variants select the first and emit a warning.
[Trailmap: 510-logic, 510-adl, 513-sphere-trees, 511-secondary,
516-material-frames, 517-attachments]

Riding sounds now have a practical common-format adapter: decoded snow/hard
loops, landing/approximate jump transients, wind and boost feed the existing
players through derived banks. Exact original routing remains deferred; see
[common riding audio](common-riding-audio.md) for the approximation and backfill.

Slopesmith consumes the exported per-placement vertex colours. Native builds
currently use neutral prop lighting and their existing light/glint renderer;
matching SSX 3 vertex colours and spot-cone playback still requires renderer work.
Suns/ambients in the source are mostly placeholders and are excluded. Source path
ratings are preserved as `SourceRatingWord`, with a neutral shared AI rating.
Peak race lines cover hubs only; they do not establish a continuous race through
the event connectors. Surface labels and rail admission are approximations.
[Trailmap: 515-placeholder, 514-peak-coverage, 511-surface-names, 514-splines]

Synthetic checks exercise streamed records after empty slots, repeated resources,
padded palettes, raw geometry, scale/mirroring, vertex colours, shared collision,
WAV export, speech omission, malformed extents/references, existing-map protection,
and failure cleanup. A browser test runs the checked-in WebAssembly through the
actual `/isos` worker and checks its IndexedDB files and completion marker.

Streamed diffuse pages are converted from their GS upload order before palette
lookup. Model positions precede normals in these streams, unlike Tricky. The
material render-state field controls cutout, blend and glow modes. Browser cache
revision 6 requires a one-time reload of earlier SSX 3 and On Tour conversions
for the helper, collision, lighting, material and sound-record fixes. SSX and Tricky
caches retain their existing revision. The browser also reads the cone field from
older streamed exports. Existing native map folders can use `polish-streamed-map`
for helper/lighting approximations and inferred reset-box retirement with backups; all conversion
changes require a fresh import into a new destination.

See [the fidelity audit](streamed-world-fidelity.md) for the remaining geometry,
audio, animation and effect gaps and their implementation priorities.

```text
python Native/tests/ssx3_import_test.py <openslope_import executable>
npm --prefix Slopesmith run test:full -- --only ssx3
```

No retail content belongs in source control or release packages. Headset fidelity
and original script-driven behavior are not established by these import tests.
