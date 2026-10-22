# SSX 3 and On Tour fidelity audit

The browser `/isos` flow and native Windows/Quest builds share the streamed-world
reader in `src/ssx3_import.cpp`. Improvements to that conversion require rebuilding
the bundled browser importer as well as the native executable. The browser and
native renderers consume different subsets of the resulting portable map.

## Corrected conversion gaps

- **Helpers borrowing normal textures were drawn and could block the rider.**
  The debug texture alone does not identify reset planes, effect emitters, load
  markers, cutscene barriers and other helpers. Named helper admission now hides
  those placements and excludes scripted volumes from permanent collision.
  Ordinary fence art, `startright` names and `noCollide` art remain visible;
  permanent collision fences and proxies remain solid. Source collision meshes
  are retained even for inactive helpers. These are conservative admission rules,
  not an implementation of event visibility or scripts.
- **SSX 3 collision could leak between sections.** A model's triangle proxy is
  shared by its placements within a section. The lookup now includes that section;
  a proxy from another section cannot replace it. On Tour continues using the
  placement's direct proxy reference. [Trailmap: 513-binding, 520-instance]
- **Spotlights lost their cones at the browser boundary.** The importer exported
  `OuterConeCosine`, while the browser read `UnknownFloat2` and defaulted to 1,
  yielding no light pool. New imports publish both; the browser accepts the old
  field when opening earlier exports.
- **Halos vanished in native playback and added unwanted browser lighting.**
  The exported zero brightness suppressed native sparkle. Halos now carry positive
  sparkle brightness, and their shared influence bounds collapse to their position
  so they cannot add diffuse point light. Their original sprite culling bounds
  remain in the preserved source records. [Trailmap: 515-halo-record]
- **Material frame lists were discarded.** Both formats now export their ordered
  embedded frame lists and every referenced texture page. These lists do not
  establish a clock: state-selected signs retain their initial state until their
  controlling script is supported. [Trailmap: 516-literal-setup]
- **On Tour constant UV setups never reached material playback.** A bounded
  decoder translates complete unconditional setup programs through the placement's
  persistent slot into shared UV-scroll nodes. It supports literal rates, register
  negation, active/pause timing and current-placement targeting. Any branch,
  unknown call or unsupported target/mode defers the entire program. Model motion
  remains separate. No general source-script VM runs. [Trailmap: 516-setup-bindings]
- **Sound attachment records were opaque source bytes.** `SoundBindings.json`
  now retains both hash halves, source section/instance identity, optional portable
  instance index, every collision event and every variable-length external emitter.
  Shared payloads and unbound rows survive. Event routing stays explicitly deferred;
  these IDs never enter Tricky's fixed-event resolver. [Trailmap: 517-attachments]

Fresh local SSX 3 Peak 1 conversion hides 202 previously visible helpers and
removes 72 helper walls while preserving all 11,187 terrain patches and 16,169
placements. The local On Tour ER1 day import had no additional visible helper
matches; synthetic coverage exercises the rules for both formats. Fresh imports
also validated ER1 day and WR1 night, including 49 and 72 halo records respectively.
No retail content is included in the tests or this document.

The follow-up local Peak 1 import exports seven material frame lists and 12,411
sound binding rows with 105 external emitters. ER1 day exports four lists and
1,943 sound rows with 60 emitters. Three persistent On Tour scrolling programs
translate to three placements; 27 other bound programs remain deferred. SSX 3
placement-to-program binding remains unresolved, so its graph tables stay empty.
These are conversion counts, not matched-camera or listening validation.

## Remaining work, in priority order

| Area | Current support | Next useful work |
| --- | --- | --- |
| Native prop lighting | Imports preserve per-placement packed vertex colours and each mesh's stream base. The browser consumes them; native rendering uses the ordinary ambient/directional prop path. | Add a GPU colour stream addressed per placement and mesh vertex. Keep shared geometry, multipart stream offsets and mirrored placements; avoid copying every mesh for every instance. |
| Geometry and collision | Bicubic terrain, static prop parts, rest hierarchies, placement transforms, triangle proxies and lightmaps are converted. | Add sphere-tree collision from a validated format contract. Investigate remaining multiple proxy variants within one section and event-dependent admission. |
| Moving textures | Ordered frame lists and their images are exported. Complete supported On Tour constant UV setups reach shared playback. | Establish SSX 3 setup bindings, flipbook clocks/state selection, other UV modes and per-part targets. Do not animate signs by texture name. |
| Moving props and effects | Static rest transforms, local lights, halo sprites and fog banks survive. Supported On Tour UV setup scripts translate; other compiled programs remain in Source. | Decode model animation channels, conditional activation, timers, event-dependent targets and particle commands. Event props still need mode visibility. |
| Sounds | Common riding banks now provide approximate jump, landing, glide/carve, rail, wind and boost playback using each game's decoded clips. Banks and structured world sound bindings are exported. | Refine riding sample choices and surface routes. Resolve world-event namespaces, activation, coordinates, ranges and ambient lifetimes separately. |
| Terrain materials | Diffuse pages, alpha admission and converted lightmaps are available. | Implement secondary material passes and their masks. Preserve gloss/glitter masks separately before extending the current opaque-alpha conversion. |
| Local lights | Browser spotlight cones now work. Native light/glint rendering still lacks equivalent local diffuse spotlight playback. | Implement and test native cone attenuation; avoid adding halo influence or applying baked lighting twice. |

The unresolved bindings are reported in `Import.json` and the selected non-speech
records remain under `Source/`. `Complete: false` remains intentional. Animation,
sound routing and script effects need further format evidence; static imports do
not establish parity with the games' playback.

## Practical playtest approximations

Fresh imports also apply common-map playtest policies, recorded in
`PlaytestImport.json` as `Approximate`. Named script helpers remain hidden and
nonblocking; names alone do not establish activation. Permanent fence proxies
remain solid. The earlier name-based reset-box approximation is retired: a
diagonal plane's box includes empty space and caused reset loops on SSX3_EBA3.
The shared browser reader and Native world loader ignore only the reserved
`openslope-playtest:reset:slot` collision binding. Authored reset graphs retain
their behavior. Older browser caches receive this fix on reload without ISO
reimport or rewriting the mountain draft.

Native prop lighting now uses the average of each placement's packed vertex
colours through the existing ambient field, rather than a uniform half-bright
fill. Browser per-vertex lighting keeps its full colour stream. Custom ambient
or directional lighting is preserved. Native still lacks per-vertex gradients
and equivalent local spotlight playback.

The browser permits surface/fall/wedge and graph-driven recovery in free riding
and after a scored run finishes. Mounted recovery waits through pause, countdown
and walking; on-foot falls use their existing walker recovery.

Browser reference triangle proxies now receive the same object rest transforms
as the rendered meshes, including parent transforms. This fixes ER4's open rink
doors retaining closed-pose collision. The panels keep their solid collision;
no gate scripts or collision exemptions are added. Older generated props payloads
rebuild on reload without an ISO reimport. Native already applies these transforms.

Browser references also choose the enabled version of uniquely paired On Tour
event-start/finish terrain. Both versions were drawn with different baked lightmaps,
causing camera-dependent coloured triangle flicker around ER4 cell585. Inactive
variants retain their source records and cell numbers but emit no visible/contact
triangles. This is a static playtest approximation; original event switching remains
deferred. Reloading applies it to existing imports without rewriting source maps.

Existing streamed map folders can receive helper, light, tint and reset-box
retirement changes without replacing geometry or audio:

```text
openslope_import polish-streamed-map <map-folder>
```

Changed originals are retained in `PlaytestBackup-v4`. Known v1/v2/v3 reports may be
upgraded and are backed up too; their earlier backup folders remain intact.
An unchanged rerun writes nothing. Conflicting backups/unknown reports are
refused. The repair stages documents before publishing and rolls back
cancellation/failure. It does not backfill older geometry, UV program translations
or world sound scripts.

On Tour's complete `mdl_<track>_impassableleft/right` and
`mdl_<track>_trg_fw_archlights/start/finish/finish_final` helper families are hidden
and nonblocking. Numbered variants, including multi-number archlights, qualify.
Existing collision shapes become pass-through sensors with zero response mass
and bounce disabled. Helpers without a configured shape remain dormant; no new
boxes or effects are inferred. Common authored effect bindings remain usable,
while original controller and conditional effect programs remain unresolved.
Instance and referenced model labels both qualify. Ordinary
fences and similarly named art stay unchanged. Native and browser readers apply
this policy to older references in memory, so a reload fixes cached imports
without rewriting a mountain draft or reimporting the ISO. New borrowed helper
stamps default to no collision; existing explicit authored profiles are preserved.
They remain selectable as wireframes in Reference Effects even without a translated
effect slot, and as hidden-prop icons in Sources. These overlays disappear in Play.
Selecting an untranslated helper opens its read-only identity and import-status
card rather than rejecting it as an ordinary prop.
`polish-streamed-map` can persist the same policy with v4 backups. Earlier v3 repairs
detached helper bindings; their originals remain in the earlier backup rather than
being reconstructed from names.

## Verification and cache refresh

Synthetic native import tests cover helper visibility/collision, visible-name
exceptions, shared models with different section proxies, spotlight fields and
halo brightness/reach. Browser tests run the rebuilt WebAssembly in the actual
worker and read back the IndexedDB output. A renderer-data test verifies that a
legacy spotlight lights a surface inside its cone and leaves one outside unlit,
and that a halo produces a glint without diffuse lighting. Added coverage checks
ordered frame files, whole-program rejection, both scroll directions, native
clock/reset behavior, the browser slot-to-graph playback bridge, shared sound
payloads, all four emitter tails, unbound rows and atomic malformed-input failure.
Reset regressions cover the old cached binding, a former box at spawn, preserved
authored MainType13 behavior and cancellation during publication. Boundary
regressions include real collision sweeps, preserved fences, alternate legacy
bindings, pass-through contacts, renderer wireframe selection, source immutability
and reversible backup upgrades.

Browser cache revision 7 invalidates earlier SSX 3 and On Tour imports only. On Tour
night courses use revision 8 for the corrected night-archive resource mask; day,
SSX 3, SSX and Tricky revisions remain unchanged by that sky fix. Reimport native maps into a fresh
destination for all conversion changes, or use the targeted repair above. These checks
do not replace matched-camera visual comparison against the original games or
performance testing on a headset.

Original streamed sky meshes now appear in the editor's sky catalogue independently
of measured panorama rings. Editor and browser Play share camera centering,
visibility, top-fill restoration and texture disposal. Whole-sky adoption/export
preserves the source geometry and images. Synthetic checks cover a night-only sky,
day fallback, actual WebGL rendering through the local editor API, camera movement,
late texture completion, toggling, Play and both server/browser byte-preserving
exports. A fresh owned-disc ER4 night extraction confirms one sky model and nine
night texture pages. [Trailmap: 546]

The browser's original sky renderer keeps opaque, cutout, blended and glow tiles
ahead of all world geometry. Alpha tiles use explicit GPU blending in the early
background queue; the ordinary transparent queue would paint them over opaque
terrain and riders with depth testing disabled. Sky group priority also precedes
world group priorities. Actual WebGL regressions cover foreground/farther geometry,
translucent props, camera movement and preserved sky alpha composition. This fixes
existing imports on reload without a cache revision or ISO reimport. [Trailmap: 547]

The [common riding adapter](common-riding-audio.md) deliberately supplies usable
audio before exact original routing is recovered. Its own manifest labels the
approximation; it does not turn unresolved world-event bindings into playable cues.

A [common course-ambience adapter](common-course-ambience.md) now enables a
conservative subset of those bindings using an explicit approximate policy.
Native and browser playback accept map-local named-bank routes; unresolved
source events retain their deferred status. Fresh imports apply this adapter,
and both installed streamed maps have been backfilled with backups.
