# Repack technical reference

This document records the implementation contracts behind [`snowknife repack`](../REPACK.md). It is for format work, authoring-tool integration, and diagnosis; the main guide owns the normal build procedure and executable-patch recovery steps.

## Level archive contract

SSX Tricky uses a primary-volume ISO9660 image. A course is normally one `DATA/MODELS/<LEVEL>.BIG` C0FB archive with 11 RefPack-compressed members:

```text
<level>.ssh       <level>_L.ssh    <level>_sky.ssh
<level>.pbd       <level>_sky.pbd  <level>.ltg
<level>.map       <level>.ssf      <level>.aip
<level>.sop       <level>.adl
```

The PBD carries terrain, models, instances, materials, lights, splines, and other level data. The main SSH is the texture bank; `_L.ssh` holds lightmaps. AIP and SOP contain per-mode paths and start tables. Texture references are SSH page indexes: a JSON `TexturePath` of `"0028.png"` means page 28.

Unchanged RefPack members are re-containered byte-verbatim. Changed members use Snowknife's fast RefPack encoder; the library's maximum-compression mode is intentionally avoided because its time cost is disproportionate.

## Build modes and preservation

### Terrain-only builds

For terrain-only exports, `SurgicalPatchSwap` keeps the target PBD byte-verbatim except for relocatable authored sections:

- terrain patches are always replaced;
- lights are replaced only when the export supplies authored lighting; and
- counts such as `NumPatches`, `NumLights`, and `NumTextures` come from the generated build.

A replacement section overwrites its original region when it fits. Otherwise it is appended and the PBD header is repointed. Keeping the target models, instances, materials, and meshes avoids re-encoding retail prop geometry through OBJ and losing triangle-strip optimization.

### Prop builds

When an export contains authored props, Snowknife ships the fully regenerated PBD and regenerates the index-coupled SSF and MAP. It appends the authored population, then delists original static scenery from the world grid instead of deleting rows. This keeps instance indexes, Prev/Next chains, and SSF/MAP alignment stable. Original race markers and gem pickups remain listed.

Without authored props, target scenery remains unless `--bare-slot` is selected. That option delists donor scenery while preserving the StageArea start/finish instance. It is useful for a deliberately empty authored slot; it is not required to replace scenery when a custom prop population is present.

## World grid (`.ltg`)

The LTG is both the collision broad-phase and the per-frame render-gather grid. Every regenerated PBD must ship with an LTG regenerated from its final patches and instances.

`LTGHandler.RegenerateCentreLTG` reuses the compact topology of the target LTG. The from-scratch origin-grid path produces a much larger grid and is not used for repacking.

The observed retail rules are:

- each terrain patch is listed exactly once, in the cell containing its bounding-box center;
- terrain collision still covers patch geometry extending beyond that cell;
- per-cell light lists are empty; and
- light-crossing lists contain each applicable light index once.

Listing a patch in every overlapped cell is incorrect and expensive. A measured grid averaging about 4.7 entries per patch reduced a stationary PCSX2 run under Full GS blending from 50 to 30 fps. `snowknife ltg-stats` exposes per-cell totals for comparison.

Authored props and gems use their final placement bounds when the grid is regenerated. Static authored props are listed with state 0; original scenery replaced by authored props is changed to state -1 so neither rendering nor collision reaches it.

## Texture bank contract

### Index and count invariants

The PBD texture-count field must equal the shipped main SSH page count. A zero count makes the engine allocate no texture-index space and terrain renders untextured.

Snowknife seeds the generated material table from the target SSH. This preserves numeric page identity: `"0028.png"` remains index 28 instead of becoming an index determined by first use. The target SSH is not decoded and rebuilt; untouched pages retain their original chunk-chain bytes and alignment.

### Texture provenance

A Slopesmith export's `Slopesmith.json` maps each flattened `TexturePath` to its source. Snowknife resolves it as follows:

| Provenance | Result |
|---|---|
| Target course | Reuse the target page in place |
| Another retail course | Copy that donor page verbatim from the source ISO |
| `Custom` | Encode the staged PNG |

Explicit `DONOR/NNNN.png` and `custom/NAME.png` references encode the same intent without a sidecar. An unlisted loose PNG in the export is treated as generated authored art and encoded. `texture-plan` reports this resolution without reading a disc.

### Reuse-before-append allocation

Before installing pages, the allocator protects:

- slot `0000`;
- target slots used by replacement terrain;
- target pages used by retained material paths and flipbook frames; and
- target pages used by authored props.

Unprotected original slots are reusable. New pages take them in ascending order; only overflow is appended. Replacing a page rebuilds offsets while retaining all untouched page bytes and 16-byte alignment. Every authored reference is rewritten to the assigned bare slot.

Appending beyond a course's original count is supported and has been verified in game at 127 pages, six above GARI's original 121. Going beyond the measured range produces a warning rather than an invented hard limit.

### Borrowed and authored pages

Borrowed retail pages are spliced from the donor SSH without decoding or re-encoding. A missing donor BIG or page is reported and left for fallback normalization.

Authored PNGs can use either:

- type 5, the half-bright 32-bit format also proven for lightmaps; or
- type 2 under `--texture-type2`, an 8-bit indexed page matching the retail GARI bank.

Both paths use half-bright RGB and alpha conventions expected by the GS draw state. Type 2 stores one byte per texel plus a 256-entry type-33 palette, quantizing images with more than 256 colors. It uses one quarter of type 5's pixel footprint. Native and borrowed pages stay verbatim regardless of the selected authored-page format. Authored sky pages use their separate type-5 path.

The measured aggregate type-5 behavior on GARI under PCSX2 is:

- about 0.64 MB of authored pages renders cleanly;
- about 2.0 MB corrupts later uploads even though a re-extraction proves the ISO bytes correct; and
- the actual hardware boundary between those points is not characterized.

This is a proven-clean budget, not a claimed hardware limit. Dry-run findings identify the selected format and any overage.

### Page-size conformance

The repacker prices the complete authored set and selects the largest power-of-two ceiling that fits the measured budget: 512, 256, or 128. Each edge is independently snapped down within `[16, ceiling]`; non-square pages stay non-square. Area-average resampling preserves wrapping behavior without padding seams.

If the set still exceeds the budget at the retail terrain size of 128, Snowknife leaves staged dimensions intact and reports an alert. The build remains nonfatal because an export may target Unity rather than PS2. Type-5 alerts also report whether the same set fits as type 2.

### Overrides and flipbooks

Loose material PNG names are encoded and installed like other authored pages. A cloned material resolves from the imported level's `Textures/`; prop-bake art resolves from the export's `Textures/`. An unresolved name falls back to slot `0000` with a warning, so the PBD never carries an out-of-range page index.

Every `TextureFlipbook` frame is resolved separately and protected separately. An authored `TextureFlip` graph node can advance only through pages that were actually installed; an empty flipbook leaves the material on its resting page. See [Trailmap 410](../../Trailmap/specs/410-texture-animation.md).

## Placed props

The canonical prop interchange is `Materials.json`, `Models.json`, `Instances.json`, model-local `Meshes/`, and `Collision/`. `Props.obj` is a world-space preview with instance/model group names; it is not the semantic rebuild source.

`CanonicalMapProps` appends authored model and instance rows and copies their meshes and collision proxies. It adjusts only target-relative joins: material and texture indexes, compiled effect-slot indexes, and compatible physics-body references. Bounding boxes are recomputed from the appended model under its actual placement pose.

Materials append to the target table. Target textures reuse bare slots, cross-course textures use the donor-page allocator, authored pages are encoded, and untextured submeshes share one generated flat-grey page.

### Lighting and contact

Static props are lit from instance fields, not terrain lightmaps: ambient plus up to three directional colors/vectors. Slopesmith bakes shadow and ambient-occlusion results into those canonical fields, using the game's half-bright convention. Snowknife preserves them into the PBD.

The collision contract comes from [Trailmap 130](../../Trailmap/specs/130-collision-data.md), [150](../../Trailmap/specs/150-logic.md), and [370](../../Trailmap/specs/370-world-interaction.md). Slopesmith resolves mode, `PlayerCollision`, response mass, bounce settings, optional native physics-body donor, transform, and rideable surface into each instance row before repacking.

- Mode 1 uses a generated local proxy.
- Mode 2 uses packed instance bounds.
- Mode 3 may reuse a physics body only from the same target course.
- A missing or cross-course donor warns and produces no mode-3 shape; it never aliases the same integer in another course.

Dynamic movement is authored through the collision `property.roller` behavior. Arbitrary native geometry still requires a valid sphere-tree shape and inertia before the PS2 engine can move it as a body.

Hit sounds are event IDs and ambient sounds are external-sound rows. The regenerated ADL must include the instance-hash lookup rows or populated PBD fields remain silent. Variable-sized donor ADL tails for external-sound types 1 and 2 are restored from the freshly extracted target data before regeneration.

## Authored effects

An export with Slopesmith `attachments` and `bakedGroups` compiles referenced circumstance graphs into the regenerated SSF and stamps each packed instance with its appended effect-slot index. Unattached slots are ignored.

Collision effects do not override explicit collision profiles. The placement must already be eligible for contact. `Visable` remains render-only, and choosing a physics-body-sphere mode without a valid body does not create contact.

A UV-scroll node sets the instance `UVScroll` bit; the rate remains in the compiled graph. Show message nodes are stripped unless `hud-text` is selected with `--patches`, because stock executables dispatch their opcode to an inert case.

### Shared functions (MainType 21)

Authored functions append after donor functions so existing indexes remain stable. A call resolves by authored name to the appended index; a missing or unnamed function refuses the slot instead of risking an unrelated donor function.

Names are trimmed to 15 characters because the fixed field is padded without guaranteed termination. Appending also means an authored function cannot replace the first donor function of the same name; runtime mode lookup continues to find the donor entry.

Function bodies run on a new thread carrying the caller's owner. Instance wiring therefore follows ordinary calls, but not hops that deliberately select another instance.

## Acting on another instance

MainType 7 targets another placement. Its packed instance index is not known while graphs are first compiled, so Snowknife emits -1 and records a backpatch. After prop rows are appended, `ResolveHops` converts the placement name to the corresponding `Instances.json` row index, which is also the SSF instance-table index.

An unresolved target remains -1 and produces a warning. The runtime bounds-check makes -1 inert; guessing an in-range index would act on an unrelated object. A graph referenced only by a hop is still pulled into the build. See [Trailmap 230](../../Trailmap/specs/230-level-ssf.md).

Vector payloads are normalized between the document's `{X,Y,Z}` objects and the library's float arrays during compilation.

### Gate word encoding

Two Type5 gate fields are declared differently from how the engine reads them. Author the engine representation:

- the selector is a float carrying integer bits; selector 1 is represented by the float printed near `1e-45`, not `1.0`;
- the threshold is an integer carrying IEEE-754 float bits; `1056964608` represents 0.5 and `1106247680` represents 30.0.

A conventionally typed value can pack successfully yet change or disable the gate. The evidence and runtime semantics live in [Trailmap 150](../../Trailmap/specs/150-logic.md).

## Authored model clips

An authored moving prop packs as an animated PBD model. The export preserves its object hierarchy, rest poses, six translation/rotation channels, and the placement-to-model pose. Material-run object tags keep mesh pieces associated with the object that owns them even when multiple pieces share an atlas page.

Object 0 is the unanimated identity root. Translation channels use raw model-local centimeters; rotation bases use radians. The placement frame is composed once at the top of the hierarchy. Descendants are already parent-relative and must not receive the same conversion again.

Spline movers are the exception: the native spline node owns world orientation and ignores source-instance rotation and scale. Their instance keeps the pivot with identity rotation/scale while geometry retains the authored lead axis and size.

An animated object cannot also hold the placement frame because the engine constructs its local pose from bases and channels without consulting its rest matrix. When a real frame change is required above an animated top-level object, Snowknife inserts an unanimated mount. Imported arbitrary-axis rotation similarly uses an unanimated tilted mount with a cardinal-axis animated child.

The PS2 safety warning is 27 final `ModelObjects`, including object 0 and genuine meshless mounts. The PAL runtime's 28th composed matrix overwrites live workspace and can freeze the game. Snowknife warns but does not block because larger models remain valid for Unity-only output.

Each object's mesh is written in its own local frame by undoing the accumulated parent rest pose. Otherwise the engine applies that pose a second time. Collision proxies remain one merged instance-local static shape.

Playing the clip is separate graph work, normally an `AnimObject` node. Its window fields select the frame range; the conventional negative value selects the entire clip, while a zero-length `(0, 0)` window plays nothing. See [Trailmap 120](../../Trailmap/specs/120-objects.md).

## Dependent-member validation

### SSF sanitation

A prop/gem build rebuilds the SSF spline table from the authored mountain while retaining donor graphs. Donor nodes that reference now-missing splines would index beyond the new table and can crash at load. Snowknife removes those individual spline-follow/spline-animation nodes without deleting their graph or function, logs the count, then runs `ssf-check` on the file that will ship. Any remaining error blocks ISO publication.

### Lightmap member name

Retail truncates the `_L.ssh` member stem to six characters, such as `merque_L.ssh`. Snowknife replaces that exact member. Writing an untruncated seven-letter stem would create a dead second member while leaving the retail lightmap active.

## Audio

### Prop and ambient sounds

Native event IDs resolve through the executable's global table to course-bank slots, but unused slots can be empty in a particular course bank. `CourseBankInject` rebuilds `DATA/AUDIO/AUDIO.BIG`, filling required empty slots byte-verbatim from a sibling course that contains them.

For authored samples, Slopesmith stages normalized PCM16 mono WAVs and assigns reserved event IDs or direct custom-sound joins. Snowknife resolves the course slot and PS-ADPCM-encodes the sample. Since that slot is course-global, it warns when a custom sample replaces a slot used by original target instances. Untouched BIGF and BNKl payloads remain verbatim. `bank-verify` checks the no-op rebuild and encoder path independently.

The rebuilt bank must fit inside the byte size the target level shipped with; over that, the disc plays no custom sound at all, so the injection is refused and the retail banks kept. `CustomSoundRouting` runs before the ADL is regenerated and re-points each reserved event ID onto a slot the target bank already ships and the built course no longer reaches — reclaiming the shipped clip's bytes instead of paying full price for an empty slot — then rewrites the authored instances so the ADL and the injection agree. Donor fills are shed largest-first if the budget is still short, ahead of any authored clip. Hit-gated IDs (16/28/57) and continuing emitters are constrained: an emitter is only offered one of the six ordinary IDs retail itself sustains, and never a multi-channel slot. Slot 64 is the only multi-channel slot any course bank ships — the shared 2.17 s stereo glass smash behind event 63 — and at 54,688 bytes it is the largest reclaim available, so it is offered to hit sounds and refused to emitters. `<out>.sounds.json` records the final event, slot and loop state per clip; `--no-sound-routing` disables the step.

### Custom race music

`Music/track.wav` replaces the target course's first playlist song in `DATA/AUDIO/MUSIC.BIG`. Snowknife converts it to 36 kHz stereo and fills the donor song's existing SCHl sample slots without changing their byte ranges or MPF record layout.

Optional `Music/arrangement.json` version 1 selects `linear-loop` or `retail-graph` and supplies BPM and loop bounds. Linear mode rewires existing link targets into sample order while retaining required race-start, reset, and finish dispatchers. Retail mode leaves the donor MPF byte-identical and is the default. See the [Slopesmith music workflow](../../Slopesmith/docs/031-custom-race-music.md).

## Skybox

An export with `Skybox/Sky.json` replaces the target sky. Without it, both target sky members remain verbatim.

The retail sky is an open-topped ring of 25 textured panels. Its geometry is portable across courses:

- `"Source":"level"` copies the donor `_sky.pbd` and `_sky.ssh` whole from the source ISO, retaining native indexed pages;
- `"Source":"custom"` type-5 encodes the 25 PNGs into a fresh `_sky.ssh` and uses the target ring geometry.

The usual 128/64 custom tier is about 1.05 MB versus roughly 0.85 MB for GARI's native bank. The 256/128 tier is about 3.4 MB and does not have a characterized hardware-performance budget.

The ring has no top geometry. The executable supplies a per-course flat color above it. `TopColor` updates only the selected entry in a digest-verified 13-course table; subsequent repacks preserve earlier customized entries.

## Paths and start placement

Race and Freeride load AIP; Show Off loads SOP. Each dataset contains `StartPosList`, AI paths, and race lines and must resolve six valid rider start paths. Repack fills missing `PathEvents`, normalizes the six slots, and uses AIP as the SOP fallback when SOP is absent.

The six initial riders do not spawn directly at those path origins. They use a fixed formation local to `Mdl_StageArea_Start_0`. With authored paths, Snowknife moves and rotates that existing instance so the formation is centered at the authored race-line origin and faces its first nonzero horizontal step. The instance row and indexes remain intact.

## Coordinate alignment

A mountain following the target course's original path can reuse its AIP, SOP, and StageArea placement. A mountain authored elsewhere must ship its own path datasets and relocate the StageArea instance; otherwise start placement, progress, and reset logic continue to refer to the old course.

With no authored `AIP.json`, Snowknife preserves target AIP/SOP and the StageArea transform verbatim.

## ISO replacement

`iso-replace` overwrites a file within its allocated sector span when the replacement fits. Otherwise it appends the file, updates that directory record's extent and length, and grows the primary-volume size. Other file extents remain unchanged. The original allocation is `ceil(size / 2048) * 2048` bytes.

Executable patches are a separate, digest-verified layer. They are selected from the boot executable named by `SYSTEM.CNF`, support PAL and NTSC-U, and refuse unknown or partially patched builds. Recovery is documented in [Restoring the original bytes](../REPACK.md#restoring-the-original-bytes).

## Verification contract

A structural verification should prove:

- the BIG extracted from the output ISO equals the BIG produced by the build;
- regenerated members equal their build outputs;
- preserved members equal the clean source;
- the PBD texture count equals the shipped SSH page count;
- SSF validation passes and LTG totals are plausible for the authored population; and
- executable differences, if any, are confined to selected patch regions and revert byte-exactly.

Runtime verification should cover spawn placement, collision and reset behavior, every game mode's paths, texture animation, authored effects, prop contact, lighting, sky, audio, and frame rate under the intended GS blending setting.
