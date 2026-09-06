# 034 — The Bundle Pipeline (snowknife → glTF + manifest → thin importer)

The engine-agnostic SSX-data transformation lives in `snowknife`, not the Unity importer: `snowknife` emits a
standard **bundle** (glTF `.glb` meshes + a `manifest.json` sidecar + corrected textures + a lightmap
atlas). Blender opens the glb directly; the Unity importer is a thin loader that **requires** the bundle —
all engine-agnostic computation stays in `snowknife`. Developed against a locally converted level.

> Collision classification and Roller diversion implement
> [Trailmap: 130-collision-data, 150-logic, 370-world-interaction]. Those
> chapters are normative; their citations hold the reverse-engineering and
> live-game evidence. The bundle records the specified result once so every
> consumer receives the same decision.

## Why

The repo has two tools (see [`Unity/README.md`](../../Unity/README.md) and [`Snowknife/README.md`](../README.md)):

- **`snowknife`** — a standalone .NET CLI (engine-agnostic) that reads the PS2 ISO and exports intermediate
  files (OBJ / PNG / WAV / JSON). It wraps the `SSX-Library` submodule for format parsing.
- **`Unity/Importer/`** — Unity Editor scripts that read those intermediates and build the scene.

The *high-value, engine-agnostic* transforms (analytic Bézier normals, lightmap atlas, alpha
classification, premultiply correction, per-instance lighting bake, collision bucketing, rail/path sampling)
belong outside the Unity importer, because `OBJ` can't carry them: no second UV set, no vertex colours, no
guaranteed normals, no material alpha-mode, no per-object metadata. A Blender user running plain `snowknife`
without the bundle gets a strictly worse result — faceted terrain, flat-lit props, wrong-alpha textures, no
collision/rail data.

`snowknife` does this heavy, engine-agnostic work once and ships it in a **bundle**. The importer (and
a future Blender addon, Godot, etc.) just loads it.

## One canonical map input

The bundle has no authored-prop interpretation. An ISO extraction and a Slopesmith export both contain
native-shaped `Instances.json`, `Models.json`, model-local `Meshes/`, and local `Collision/`; world-space
`Props.obj` and `PropsCollision.obj` are projections carrying the same `o inst<n>_*` identity join.

Slopesmith creates that representation directly in TypeScript while it still owns structured submeshes,
placement similarities and model clips. It localizes each mesh once, writes native `ModelObjects` and
`AnimTime`, and stamps lighting, effect-slot, collision, Roller ownership and audio fields on the ordinary
instance row. Those canonical rows are the semantic source that `snowknife gltf` validates and consumes;
the world OBJ files remain projections for preview and static geometry. Animation, lighting, particles,
collision, sound and prop classification therefore consume one table from the first backend boundary onward.
`repack` appends those canonical rows to its chosen donor and performs only target-relative material,
compiled effect-slot and compatible physics-body remaps.

## The bundle

`snowknife gltf <mapDir> [bundleName]` writes `<mapDir>/gltf/`:

| File | Contents |
|---|---|
| `terrain.glb` | terrain render mesh (submesh/material, UV0, **UV1 lightmap**, vertex-colour luminance, baked normals), a render-only **`TerrainHD`** node (the same patches at `TerrainResHd`, the per-player high-detail swap) + one **collision** mesh per SurfaceType (`TerrainCol_<n>`, welded normals the board reads; always at the base `TerrainRes`) |
| `props.glb` | the merged **static** prop mesh (`Props` node — submesh/MaterialID, per-instance baked lighting in vertex colour, outward normals) **plus one `Divert_<index>` node per diverted instance** (gems/physics/breakable, absolute geometry + normals + UV0; the importer tags each with its `*Marker`) |
| `collision.glb` | one position-only mesh per **bounce bucket** (double-sided), named `PropsCollision_<label>` |
| `LightmapAtlas.png` | 512² atlas, 4×4 grid of the 16 corrected lightmaps (top-left origin) |
| `manifest.json` | the sidecar — everything that isn't mesh geometry (below) |

No texture copies: each glb material is **named** after its texture file, and every consumer resolves the
PNGs from the level's top-level `Textures/` — which `import` ships **finished** (half-bright corrected and
premultiplied art un-multiplied at decode, `TextureFinish`), so Unity and Blender read the same set.

The bundle lives **alongside** the raw export (the OBJ/JSON/PNG are still written — Blender and the
single-stage `snowknife` re-run commands read them), but the **Unity importer reads only the bundle**.
`snowknife gltf-info <file.glb>` dumps a glb's mesh/vertex/bounds for inspection.

(glTF vertex counts run slightly lower than the raw OBJ export — the format dedups bit-identical welded
verts — but bounds match exactly.)

Code: Slopesmith `src/core/export/canonical-props.ts` (canonical serializer),
`Repack/CanonicalMapProps` (target-relative append), and `Bundle/` — `GltfMeshWriter`,
`BundleManifest`, `BundleExporter`, `SsxInstance` (shared
Instances.json loader), `SsfLogic` (the shared read-only view of a level's SSF effect semantics, read from
`Effects.json` and cached per level dir — every bundler's one source for slots/graphs/functions/physics),
`TerrainBundle`, `TextureBundle`, `PropsBundle`, `CollisionBundle`, `PathBundle`.

## Coordinate convention (locked — verified by algebra *and* matching bounds)

The glb is **standard glTF: right-handed, Y-up, metres** — so it opens upright and correctly scaled in
Blender with no extra transform. The authoring transform, from SSX "mesh space" (raw centimetres, **X already
negated**, Z-up — the verts the importer places in its `Mesh`):

```
pos_gltf = (x, z, y) * 0.01      // swap Y/Z (Z-up→Y-up, flips handedness), cm→m
nrm_gltf = (x, z, y)             // same swap
```

…and each triangle is oriented **CCW about its normal** (glTF front-face) so back-faces/normals read right
in Blender (`GltfMeshWriter.OrientCcw`). Position-only collision meshes skip that and keep their baked
double-sided winding.

The Unity loader applies the **inverse**, returning to mesh space so a bundle mesh dropped under the
importer's existing `OpenSlope_Map/Level` child (which carries the −90°X rotation + 0.01 scale + recenter) lands in
the *identical* world position a directly-tessellated mesh would:

```
pos_mesh = (gx, gz, gy) / 0.01 ;  nrm_mesh = (gx, gz, gy) ;  uv = (u, 1 - v)   // glTF top-left → Unity bottom-left
```

This is what lets a bundle mesh drop straight under `Level` with no per-system conversion. Polyline/box
metadata in the manifest (collision boxes, rails, course) is stored in **mesh space** (X-negated cm) so the
importer feeds it straight into colliders / the `RailMarker` with no conversion.

## manifest.json

The canonical v3 contract is
[`bundle-manifest-v3.schema.json`](../Snowknife/schemas/bundle/bundle-manifest-v3.schema.json).
It is PascalCase JSON, grows one section per phase, and consumers must tolerate missing sections.
Version 3 makes each diverted/animated prop's exact `Ambient`, `Key1..3`, and `Direction1..3` lighting payload
mandatory and removes the version-2 summed-key/flat-animated migration fields. Re-run `snowknife gltf` for a
version-2 retail bundle before importing it into Unity.

- `Space` — `Scale` (0.01), `RootEuler` (270,0,0), up/handed/units (documents the convention above).
- `Recenter` — `ToOrigin`, `AxisMask` (the importer still does the per-import recenter on `Level`).
- `Meshes[]` — `{File, Kind}` references to the glb files.
- `Lightmap` — `{Atlas, Size, MapsFound, UvMode}`.
- `Textures[]` — `{File, Alpha: opaque|cutout|blend}` per texture (replaces the importer's
  pixel inspection).
- `Collision` — `Buckets[]` `{Node, ModeMask, PlayerBounce, PlayerBounceAmmount, InstanceCount, CollisonSound}`;
  `ComputedBounds[]` and `Foliage[]` `{Name, ModeMask, Center[3], Size[3], CollisonSound}` (mesh space);
  `Bodies[]` `{Name, ModeMask, InstanceIndex, PhysicsIndex, Center[3], Rotation[4], CollisonSound, Boxes[], Capsules[]}` —
  no-proxy mode-3 instances whose decoded occupancy body is emitted as body-local shapes on the rotated
  instance instead of one computed-bounds AABB. Three per-instance reasons select a body: a player-sized
  doorway through it, a sparse fill of its own bounds, or an instance rotation that inflates the world
  AABB past `MaxAabbInflation` (a leaning trunk walls the trail as a flat box). Doorway and sparse
  bodies emit `Capsules[]` `{A[3], B[3], Radius}` for genuinely **elongated** cell runs (segment ≥
  ~1.75 diameters — sphere-swept, the rounded surface the engine's own leaf-sphere contact presented)
  and greedy boxes for everything blob- or slab-like; neither shape covers an empty cell, so openings
  stay open. A tilted body is 1–2 clean capsules (a leaning trunk) or one tight body-local OBB (a
  yawed dumpster). A compact upright body stays one `ComputedBounds` AABB.
  The three solid sections (`Buckets`, `ComputedBounds`, `Bodies`) cover only instances that stand still:
  a breakable, animated, or roller-diverted instance is excluded from all three, because its divert
  already carries the collider that travels with it (`Props.Animated[]` segment meshes, the physics body,
  the break trigger). A static shape alongside one would stay behind as a wall where the prop used to be.
  `ModeMask` is shared with the source render instance, including the native `LTGState == 2` Showoff layer,
  so a mode change cannot hide a support prop while leaving its bounds collider behind. Canonical Slopesmith
  props authored as **showoff only** carry that same state 2; ISO regeneration preserves it instead of
  normalizing every appended prop onto the common state-0 list.
- `Props` — `Diverted[]` `{Index, Kind: spinner|physics|breakable, Node, Model, Role?, ClusterKey?, Center[3],
  DynamicMass, Bounce, CollisonSound, Ambient[3], Key[3], Light[3]}` — the classification (which instances divert, into
  which kind) + per-instance lighting done **once** in snowknife. `Center` is the
  recentre pivot (mesh space; 0 for breakable = stays absolute so a screen's three meshes align). For physics
  diverts, `DynamicMass` is decoded from the collision Roller's raw payload `U0`; it is independent of the
  instance's `ResponseMass`, per
  [Trailmap: 130-collision-data, 370-world-interaction]. `Animated[]` carries each model-clip root plus its
  object hierarchy: `Segments[] {Node?, Parent, RestPos, RestEuler, RestScale, Curves?}`. Every folder sources
  those nodes from `Models.json` + `Meshes/`. Slopesmith's canonical exporter compiles `propClips` and
  `_obj<n>` runs into that representation before the folder reaches any bundle classifier.
- `Paths` — `Rails` and `Course`, each `{Points[][3], Start[], Count[]}` polylines (mesh space). `Rails` also carries
  optional `Style[]`, parallel to `Start[]`/`Count[]`, preserving each source `SplineStyle` as the runtime grind-surface
  row (older bundles omit it and consumers default to metal style 13). `Course` also carries
  the race lines' authored `LineDtf[]` + `RaceLineCount` (the course-progress metric) and `FinishArch` `{Center[3],
  Size[3]}` — the AABB of the level's `Mdl_FinnishGate_*` parts, which straddle the DTF=0 crossing and size the
  leaderboard's finish trigger (Unity docs/050).
- `Particles` — `Effects[]` `{Name, Sprite, Puffs[] {Center[3], Radius}}` — fog/cloud billboard volumes
  (mesh-space centres + authored SSX-unit radii; for non-unit editor-authored instance scale, radius uses the
  largest absolute scale axis because the output remains a spherical billboard; the importer builds the quads).
- `Fireworks` — `Launchers[]` `{Index, Muzzle[3], Barrel[3], Colors[4][4]?}` (barrel/muzzle from the canister
  geometry; the authored 4-stop RGBA ramp or null) and `Triggers[]` `{Index, Name, Slot, Center[3], Size[3],
  Launchers[]}` (the SSF-graph launcher indices, empty → importer radius fallback).
- `Emitters` / every embedded `EmitterLayerInfo` — the complete P6 origin, spawn basis, velocity envelope,
  gravity, timing, size/lifetime, colour, sprite, and blend law in root-local mesh space. Every row supplies its
  transform through canonical `Instances.json`; Slopesmith resolves `propPoses` into that table during export.
- `Audio` — `PlacedLoops[]` carries retail type-0 point emitters: crowd (`Kind=native-crowd`, events 97–99) and
  fixed global-bank ambience (`Kind=native-environment`, explicit `Audio/SFX/<bank>/000.wav`), both with exact
  offset/radius/falloff. Normal group-2 external events carry the event id for importer resolution. Dynamic special
  programs 95/102/134 are omitted. `CrowdCentroids[][3]` is emitted only when a map has no native crowd records.
  The importer drops spatial `AudioSource`s and one shared listener-proximity gate.
- `Probes` — `{MinSpacing, Positions[][3]}` — de-duped avatar light-probe sample points (the importer places a
  `LightProbeGroup`; the SH authoring + CPU bake stay engine-side).
- `Billboards` — `Screens[]` `{Name, Family?, Center[3], Normal[3], Up[3], Width, Height, Instance?, Page?}` —
  the flat rectangle on each of the course's boards a video can be laid over, carried straight from the map
  folder's `Billboards.json` (measured by `snowknife billboards` from the placed prop geometry, or authored in
  Slopesmith). A board's ad face is welded into the merged prop mesh with a shared atlas material, so no
  consumer can retexture one; each lays its own quad over the rectangle instead (docs/051, Unity docs/vrchat/041).
- `Race` — `{Laps}` — how many PASSES from the start gate to the finish the course is raced over, so an engine
  seeds its own lap countdown from one number instead of carrying a course table. Retail holds no lap data: the
  count is a property of the disc SLOT, hardcoded for MEGAPLE alone, which is raced over **3**
  ([Trailmap: 390-lap-counter, 390-lap-rate] — note the engine's own rider counter is seeded 4 and ticks twice a
  lap, so it is not the pass count). `RaceBundle` supplies it from the level name. An authored map has no slot
  until it is packed onto one, so its author owns the number and it arrives in the export's `Slopesmith.json`,
  which wins over the retail table.

## What moved, and what stays engine-side

The rule: *would Blender/Godot/any engine also need this?* → snowknife. Touches GameObject / Component /
Shader / LightProbes / RenderSettings / Collider / Udon / `AssetDatabase` → stays engine-side (the importer builds it;
Udon is the platform wiring pass's job, [060](../../Unity/docs/unity/060-platform-neutral-importer.md)).

| System | Moved to snowknife | Stays engine-side (importer build + platform wiring) |
|---|---|---|
| Terrain | tessellation, analytic normals + seam welding, lightmap atlas + UV1, vtx-colour lum, per-surface collision split | Mesh/MeshFilter/MeshRenderer/MeshCollider, material build |
| Textures | alpha classify (cutout/blend/opaque): extracted retail materials use the native appearance flag to resolve SSX's ambiguous 0x80 alpha, while Slopesmith `model_Custom_*` materials use their conventional PNG pixels because their zero flag word is only a neutral placeholder; the premultiply un-multiply sits even further upstream — `import` bakes it into `Textures/` at decode (`TextureFinish`) | `TextureImporter.alphaIsTransparency`, material keywords/queues |
| Props | Props.obj parse + weld + per-instance lighting + normals + static directional bake + classification (which instances divert, into which kind) + **the diverted instance geometry** (one `Divert_<i>` node + record each) | only the **engine binding** for the diverted instances — GameObjects + `*Marker`s realized to Udon by the wiring pass (`SpinnerManager`, `GemPickup`, `PhysicsProp`, `BreakableLogoU`) + colliders + ParticleSystems (it reads the records, no Props.obj parse / re-classify) |
| Collision | PropsCollision.obj parse, response-mass gate, bounce bucketing, collision-sound split, computed-bounds + foliage AABBs | MeshCollider/BoxCollider, `PropBounceMarker`, impact AudioSources, the `Foliage` layer |
| Rails / paths | Bézier sampling, AIP/SOP delta-accumulation + dedupe | `RailMarker` (realized to the `RailNetwork` Udon component) |
| Particles (fog) | per-puff placement (instance matrix × puff-local) + authored radius + sprite pick | the billboard quad mesh (shader-specific UV1 offsets), material |
| Fireworks | launcher muzzle/barrel (covariance/power-iteration on the cylinder verts), trigger volume AABBs, Effects.json decode (slot→launcher map + authored colour ramps) | `ParticleSystem` config, `BoxCollider`+`FireworkTrigger` Udon, firing-sound `AudioSource`, the radius fallback |
| Audio (placed) | classify ADL type-0 crowd, fixed global-environment, and normal course-bank events; preserve offset/radius/falloff and resolved fixed-bank clip path; geometry crowd clustering only as fallback | `AudioSource`/`VRCSpatialAudioSource`, clip binding, one throttled listener-proximity manager, ambient/music |
| Billboard screens | which face of each board is its ad image, how big it is, and which way it looks — the page/facing grouping, the contiguous-UV gate, the board-cell split and the front-side choice (docs/051) | one quad per record (the mesh, its UV mirror and its own frame), and the platform's video wiring |
| Light probes | de-duped sample positions (instance cells on a spacing grid) | `LightProbeGroup`, the SH authoring + CPU probe bake (Unity `SphericalHarmonicsL2`/`Lightmapping`) |
| Skybox / fog | *(nothing — stays engine-side)* | the whole bake: the sky-fill / horizon-fog colours are derived from the **GPU-rendered cubemap** (`RenderToCubemap`), which has no snowknife equivalent |

## The Unity-side consumers

- `Unity/Importer/Editor/Bundle/GlbMeshLoader.cs` — a small, **dependency-free** GLB reader (no glTFast
  package). We author the glb ourselves, so it only handles our structure: single buffer, float
  POSITION/NORMAL/TEXCOORD, FLOAT or normalized-byte COLOR_0, USHORT/UINT indices, interleaved bufferViews.
  Returns mesh-space geometry (applies the inverse transform above).
- `Unity/Importer/Editor/Bundle/BundleManifestReader.cs` — parses `manifest.json` (Newtonsoft); one
  place that knows the bundle layout. Exposes Scale, TextureAlpha, Materials, Collision (buckets/boxes), Paths,
  **Props `Diverted[]`**, particles/fireworks/audio/probes.
- The builders consume the bundle directly, so the **full `OpenSlope/Load` is bundle-driven**: `AlphaClassifier`
  reads `TextureAlpha`; `TerrainBuilder` loads `terrain.glb`; `PropBuilder` loads the `Props` node (`MeshFromNode`)
  **and each `Divert_<i>` node (`MeshFromDivert`), reading the `Diverted[]` records to tag each with its `*Marker`**
  — without parsing `Props.obj` or classifying/lighting instances itself; `CollisionBuilder`,
  `RailBuilder`/`CoursePathBuilder`, `ParticleBuilder`/`TriggerBuilder`, `AudioBuilder` and `ProbeBuilder` all
  consume the manifest. (`InstanceLighting`/`Instances.json` is read only by `ProbeBuilder`, for the
  engine-side probe SH bake.) **The importer requires the bundle** — `LevelImporter`
  fails the import up front (with the exact `snowknife gltf …` command) when it's absent, and each builder reads
  only the bundle, with no local recompute path. This is what makes the importer a thin loader rather than a
  duplicate of `snowknife`'s engine-agnostic compute.

## Verification tooling

`OpenSlope/Dev/Load Terrain (gltf test)` and `OpenSlope/Dev/Load Props (gltf test)` (props also builds collision + rails + course) build the
bundle-driven systems standalone, without a full level import — useful for isolating one system when
debugging the bundle or a builder.

## Decisions & remaining options

What deliberately **stays engine-side** (a deliberate choice, not unfinished work):

- **Texture import flag.** The pixel corrections (half-bright, premultiplied-alpha un-multiply) are baked at
  decode time into the level's single top-level `Textures/` (`TextureFinish`, applied per decode site — level
  bank, crowd, skybox, particles, board skins), so every consumer reads finished pixels and the bundle carries
  no texture copies. The one thing left engine-side is the thing a PNG can't carry: Unity's
  `alphaIsTransparency` importer flag (`TexturePostprocessor`). The alpha *classification* is
  manifest-driven.
- **Skybox / fog colours.** Derived from the GPU `RenderToCubemap` output — no lossless snowknife equivalent
  (see the what-moved table). Stays a per-engine bake.
- **Probe SH authoring + CPU bake.** `ProbeBuilder` takes the probe *positions* from the bundle, but the
  per-instance spherical-harmonics authoring and the Unity probe bake (`Bake & Apply Probes`) are Unity
  light-probe operations with no engine-agnostic form, so they stay in `ProbeBuilder.ComputeProbes`/`BakeAndApply`.
- **Diverted-instance Udon wiring.** The diverted gems / physics bodies / breakable logos come from
  the bundle — one `Divert_<i>` glb node + a `Diverted[]` record each — so `PropBuilder` doesn't parse
  `Props.obj` or run classification/lighting itself. What's left engine-side
  is irreducible: the GameObjects + `*Marker`s the wiring pass realizes to Udon (`SpinnerManager`/`GemPickup`/`PhysicsProp`/`BreakableLogoU`),
  colliders, and ParticleSystems the records drive. `Instances.json` is read only by `ProbeBuilder` (probe SH bake).

Each builder reads only the bundle. Tessellation, collision OBJ bucketing, the merged-prop build + static
directional bake, particle/firework
placement, crowd clustering, probe gridding, rail/course sampling, and the texture alpha pixel-histogram all
live in `snowknife`, not in any builder. The bundle is a hard prerequisite; `OpenSlope/Refresh/*`
and the `OpenSlope/Dev/Load *(gltf test)` loaders also run bundle-only. Run `snowknife gltf <mapDir> <name>` after every `snowknife import`.

## Shared helpers and what stays outside the bundle

There is no terrain OBJ exporter and no `terrain` command: the bundle tessellates `Patches.json`
itself, so nothing would consume a `Terrain.obj`. The skybox is the opposite case — it stays **out**
of the bundle because the Unity `SkyboxBaker` bakes its cubemap from the OBJ directly, so
`Export/SkyboxExporter.cs` and the `skybox` command still emit `Skybox.obj` for it. The
`Props.obj` / `PropsCollision.obj` / `Lightmaps/` exporters remain as bundle inputs.

Cubic point/derivative/patch evaluation lives in one place, `Bundle/Bezier.cs`, shared by the terrain
tessellator, the terrain bundle, and the rail bundle — the rail runtime (`RailNetwork`) must agree with what
`PathBundle` samples, so a single implementation matters.

The coordinate convention (emit a `Vector3` as `[x,y,z]`; read an SSX triple into a mesh-space `Vector3` with
the −X flip) lives in one place too, `Bundle/BundleSpace.cs`, shared by every builder.

`BundleManifestReader` deserializes each manifest section with Newtonsoft `ToObject<T>` plus a
`Vector3`/`Color` converter, rather than hand-walking `JObject` fields.

Optional future work:

- glb materials carry only a name (texture file / MaterialID); embedding texture references for nicer Blender
  display is a possible polish.
- A Blender path could emit the sky-dome geometry as `skybox.glb` + panel→texture mapping (the colour bake
  would still be per-engine).
