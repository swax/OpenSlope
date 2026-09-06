# 003 — Export Contract

What Slopesmith writes so that `snowknife gltf` (and everything after it) consumes an authored
course exactly like an extracted original level. The geometry being serialized is built in
[002 — Course Model](002-course-model.md).

Code: `src/core/export/folder.ts` + `canonical-props.ts` (folder content), `src/server/routes/export.ts` (disk write),
`src/server/routes/png.ts` (PNG encode), `scripts/smoke.ts` (end-to-end assertion). Consumer:
`Snowknife/Bundle/TerrainBundle.cs`, `PropsBundle.cs`, `PathBundle.cs`, `LightsBundle.cs`.

## The authored level folder

`EXPORT` writes `Maps/<NAME>/`, and the `Repack.md` beside it names the `snowknife gltf` invocation that bakes
it. Slopesmith runs no processes of its own (`035`); the bake is a command an author pastes. `npm run smoke` is
the other side of that seam — it runs the real CLI over a real export, locating it via the sibling Snowknife
checkout's Debug build or `SLOPESMITH_SNOWKNIFE_EXE` (`scripts/snowknife-cli.ts`), so the contract below is
proven end to end rather than mocked.

**One folder, against no particular target.** The same output feeds Unity and a disc: every painted tile ships
flattened and verbatim (`Textures/GARI_0012.png`, referenced as `"GARI_0012.png"`), and `Slopesmith.json`
records the `{level, name, staged}` each page came from. `snowknife repack` reads that provenance and decides
per page whether to reuse the target slot's own SSH entry, install a donor level's page, or encode a custom one
— it holds the slot table, the allocator and the encoder, none of which the editor models (`011`). The folder
carries the invocation: `Repack.md` spells out `texture-plan`, `repack --dry-run` and the build itself, and
`repack-many.json` is the same build in `repack-many`'s manifest schema, already naming this export and
selecting retail-shaped type-2 pages so a prop-heavy build does not cross the measured type-5 GS-VRAM edge.

| File | Status for the bake | Slopesmith writes |
|---|---|---|
| `Patches.json` | **required** | one record per grid cell |
| `Props.obj` | **required canonical preview** | world-space projection of the structured prop bake, with the extracted-map `o inst<n>_<model>` join. It includes the start gate, the two staging-anchor markers, placed reference props, authored models, imported GLBs, trigger boxes, and rail/support meshes |
| `AIP.json` | optional | Race/Freeride paths: six required start routes, the floor-centerline respawn path and the race line |
| `SOP.json` | optional | Show Off paths: six required start routes + the same race line |
| `Textures/*.png` | optional | one procedural seamless tile per surface type in use, plus a flattened verbatim copy of every painted tile |
| `Lightmaps/000N.png` | optional | 128×128 pages baked from the authored sun (`SunLight`); one per ≤ 256 patches |
| `Lights.json` | optional | the authored sun as two engine-native light records — a directional (Type 0) + an ambient (Type 3) spanning the terrain bounds |
| `Splines.json` | optional | authored grind rails as native cubic spline records |
| `Effects.json` | optional | the portable lossless SSF graph document plus Slopesmith placement joins for attached effects, hit/ambient sounds, custom sound slots, collision response, rideable prop surfaces, and Roller-driven dynamic physics |
| `Sounds/*.wav` | with prop audio | normalized PCM16-mono custom WAVs plus resolved bank clips staged for direct Unity import; custom files also feed ISO course-bank encoding |
| `ParticleInstances.json`, `ParticleModels.json` | optional | standalone authored fog-volume placements and their native puff-cluster models |
| `Billboards.json` | optional | the authored video screens as oriented mesh-space rectangles — the same contract `snowknife billboards` measures off an extracted course, marked `Source: authored` so a detector run leaves them alone ([051](051-video-screens.md)) |
| `Textures/Particles/fog0.png` | with fog volumes | shared particle-bank sprite staged automatically for the Unity importer; ISO repacking uses the disc's bank |
| `Slopesmith.json` | always | per-page `{level, name, staged}` provenance — what `repack` resolves a page's disc treatment from, and what reopens the folder as a reference (`036`) — plus `patches`, the stable quad id behind each `Patches.json` record in that file's order, and how the map is raced: `laps` above a single pass, and `showoffSeconds` once one has been authored |
| `Origin.json` | always | what this folder is and what is in it: `slopesmith`, plus whether the classification found borrowed retail art. `snowknife import` writes the same contract for an extract (`retail`, always carrying data), so one file answers the question for either kind of folder, and the Reference picker's origin row reads it — see [038 · map origin](038-hosted-sessions.md#map-origin) |
| `Repack.md`, `repack-many.json` | always | the disc step: exact type-2-safe `snowknife` invocations, and a ready-to-run `repack-many` manifest naming this export |
| `Instances.json`, `Models.json`, `Meshes/`, `Collision/` | **required canonical props** | written directly from Slopesmith's structured geometry and placement data in the same shape as an ISO extraction; animation hierarchy, lighting, effects, audio and collision live on these rows before `snowknife` sees the folder |

The export serializer is the single source boundary. While it still owns structured submeshes and placement
poses, it writes one real instance and model per baked group, localizes render/collision geometry, carries model
clips as native object hierarchies, and stamps effects/contact/lighting/sound on the instance. It projects the
same groups to `Props.obj`; that OBJ is an inspection/bundle view, never compiler input. Re-export is
deterministic and clears `Meshes/` and `Collision/` before writing their complete snapshots.

Attached and unattached groups, trigger volumes and ordinary retail props all enter the bundle classifiers
through canonical `Instances.json`. PS2 repacking also
appends these canonical models/instances/meshes, applying only donor-relative material, compiled effect-slot,
and compatible physics-body remaps.

The `Effects.json.extensions.slopesmith` joins are keyed by stable placement id and resolved through
`bakedGroups`: `collisionSounds` stores the native ADL event id per placement, `collisionSoundClips` names its
direct-import WAV, and `ambientSounds` carries `{ event, radius, clip? }`. `customSoundEvents` maps portable
reserved event ids to `Sounds/*.wav`; `customSounds` separately maps direct PlaySound course-bank slots to
WAVs. `propBounce` / `propSurfaces` carry solid-contact tuning. Dynamic movement has no
parallel editor-only join: a collision `property.roller` node is the single source of its target and mass for
Slopesmith, ISO packing, and the Unity bundle, as required by
[Trailmap: 130-collision-data, 370-world-interaction]. The spec owns that
behavioral rule and traces it to the RE evidence; this export contract only
defines how the implementations carry it.

## Spaces

| Space | Units / axes | Used by |
|---|---|---|
| editor | metres, Y-up, right-handed (Three.js) | everything in `src/` |
| raw SSX | centimetres, Z-up, X mirrored vs mesh space | every number in the authored folder |

```
raw = (-100·x, -100·z, 100·y)        // editor (x, y, z) in metres
```

The bake reads raw, mirrors X back (mesh space), and `GltfMeshWriter` converts to glTF Y-up
metres; the manifest records `Scale 0.01`, `RootEuler [270,0,0]`, `Recenter ToOrigin`, so the
Unity importer places the map at the origin — for the in-Unity ride, absolute editor coordinates
don't matter. The written **raw coordinates** are another matter: `editor → raw` is an exact
bijection (`editorFromRaw` is its precise inverse), so a mountain authored in a loaded reference
level's own frame keeps that frame in `Patches.json` and exports straight back into the level's
coordinates — the round trip behind the reference overlay and patching a custom map in place of a
original level (where the raw coordinates must line up). The editor *displays* this data flipped to
the game's left-handed chirality (a viewport-only Z mirror) so what you see matches the game, but
the data and everything in this contract stay in the right-handed editor convention.

**Winding / skyward normals.** `TerrainBundle` signs its analytic normals against the
*geometric* winding normal of its fixed triangle order, so normal direction is decided
entirely by the patch grid's orientation: the quilt's u×v tangent cross must point **down in
mesh space**. Pulled back through the raw mirror and the axis map, that is equivalent to
`(du × dv).y < 0` in editor space, which `mountain.ts` guarantees by choosing the column direction
`side = fwd × worldUp`. The smoke test asserts the result on the baked glb (every terrain
normal Y > 0). Props need no such care: editor→mesh is a pure rotation and the OBJ X-mirror is
cancelled by the reader's mirror-back, so faces are simply wound CCW-outward in editor space.

## Patches.json

One record per cell, field names exactly as `PatchesJsonHandler` deserializes them:

```jsonc
{
  "PatchName": "Cell_local_12",         // the quad's stable id (039), `:` written as `_`
  "Points": [[x,y,z], ...16],          // BÉZIER control points, raw cm, row-major, rows along u (spine)
  "UVPoints": [[u,v], ...4],           // texture corners, index-matched transpose (below)
  "SurfaceType": 1,
  "TexturePath": "snow.png",
  "TrickOnlyPatch": false,
  "LightmapID": 0,                     // which Lightmaps/000N.png page this patch's tile lives on
  "LightMapPoint": [lx, ly, lw, lh]    // the patch's 8×8 tile sub-rect on that page (fractions)
}
```

Two conventions here are easy to get wrong:

- **`Points` are Bézier control points, not monomial coefficients.** The on-disc PBD records
  store power-basis coefficients, but `snowknife import` converts at extraction time and
  `Bezier.Patch` evaluates `Points` with the Bernstein basis — so an authored file supplies
  control points directly. (Affine maps commute with Bézier evaluation, so converting the
  control points to raw space converts the surface.)
- **`UVPoints` pair index-for-index with the geometry corners.** The bake binds stored corners to
  parametric corners by a *transpose* of the same-index order (swap the off-diagonal B↔C):
  `(uvA,uvB,uvC,uvD) = (c0,c2,c1,c3)`. Slopesmith wants `d00..d11` at the natural corners, so it
  stores `[d00, d10, d01, d11]`.
  UVs are **one tile per patch, seam-inset** — the dominant SSX convention: nearly every shipped
  patch is one full tile, and most levels pull its corners inward by **0.008 per side** (ELYSIUM
  4,200/4,268 patches, MESA 2,197/2,448 and MERQUER 2,183/2,731 at exactly that value; GARI is the
  outlier at 96% exact-unit). The inset keeps bilinear + wrap sampling from bleeding the tile's
  opposite edge across patch seams, so the export applies it to every cell: rot-0 corners are
  `[[0.008,-0.008],[0.992,-0.008],[0.008,-0.992],[0.992,-0.992]]` (`UV_INSET` in `level.ts`), the
  tile filling the cell with U down the rows and V negative across the cols, independent of cell
  size. Texture density therefore follows *patch* density (denser patches → tighter tiles), the way
  the original mountains are built. The editor preview samples the full 0..1 tile — the 0.8% zoom
  difference is invisible.

## AIP.json + SOP.json

```jsonc
// AIP.json — Race/Freeride: six valid rider routes are mandatory
{ "StartPosList": [0,1,2,3,4,5],
  "AIPaths": [ ...six "AI Path N" opponent lines..., // full-course; straight or seeded wander
               { "Name": "Slopesmith Course", "U3": 50, "Respawnable": true,
                 "PathPos": [x,y,z],                  // raw cm, first floor-center
                 "PathPoints": [[0,0,0], [dx,dy,dz], ...],       // DELTAS, cumulative-summed by the bake
                 "PathEvents": [] }],
  "RaceLines": [{ "Name": "Race Line 0", "DistanceToFinish": dtf,
                  "PathPos": [x,y,z], "PathPoints": [...course deltas + a 40 m overshoot],
                  "PathEvents": [{ "EventType": 9, "EventValue": 0,
                                   "EventStart": dtf, "EventEnd": dtf }] }] }

// SOP.json — Show Off: six gate lead-ins + the same race line
{ "StartPosList": [0,1,2,3,4,5],
  "AIPaths": [ ...six "Start Gate N" paths... ],
  "RaceLines": [ ...identical to AIP.json's... ] }
```

`PathPoints` are increments from a running position seeded at `PathPos` — not absolute points.
Slopesmith emits the floor centerline (midpoint of the floor-edge columns, which the bank roll
preserves). Because the path is `Respawnable`, `PathBundle` bakes it into `manifest.Paths.Course`,
which gives the board's ride-onto-`SurfaceType 0` reset a path back onto the course.

The **AIP start routes** are the Race/Freeride field ([Trailmap: 250-paths-aip-sop]):
`StartPosList` must name exactly six valid paths, one per rider slot. Each route begins at its gate and
rides the whole course. With **AI path variation** off, all six converge on and follow the centerline;
with it on they carry independent seeded lateral wander bounded by the run floor
(`core/doc/course.ts` `aiPathLines`). The routes are derived from the course plus the document's
`aiSeed`; editing the course re-derives them and "regenerate" changes the seed. Path events are empty.

The **race line** carries the engine's progress metric: `DistanceToFinish` is the line's summed
**horizontal** raw arc length ([Trailmap: 250-paths-aip-sop] — path distance chains in the ground
plane), so DTF reaches zero exactly at the course tail; the line overshoots ~40 m past it like every
retail line so the zero crossing is interpolated inside a segment. The type-9 event at
`EventStart == DistanceToFinish` is the finish-line marker every retail level's min-DTF line carries.
How many times that finish is crossed before the race ends is the document's **lap count**, and it rides in
`Slopesmith.json` rather than any native file — retail decides a course's laps by its disc SLOT, in code
([Trailmap: 390-lap-counter]), so no level format has a field for one. `snowknife` prefers that sidecar over its
own retail table when it writes the bundle's `Race.Laps`, which is what the Unity finish line seeds from.

A course knot with `checkpointBonus > 0` also becomes a **type-11 race-line event** at that knot's
projected horizontal station. AIP carries the station with value 0 for race progress; SOP carries
`EventValue = checkpointBonus` in whole seconds. In retail Race, crossing the station announces
**CHECKPOINT** and advances a discrete checkpoint/standing counter; the payload does not alter time or points.
Slopesmith exports that native race station but Test Ride currently simulates only the Showoff time award.
This is the native trigger. A flashing
`Mdl_CheckPoint_*` sign placed beside it is optional decoration/animation, not a volume the rider must
touch. The Course viewport draws the authored station as an amber strip labelled with its exact award;
loaded references recover and label every SOP route event, grouping equal-DTF alternate-line copies as
one logical checkpoint.

The **showoff clock** (`showoffSeconds` → `Race.ShowoffSeconds`) travels the same way and for the same reason: a
trick run is a countdown, and retail seeds it per course from a table in its own executable — Garibaldi 120 s,
most courses 90, Alaska 135 — which no level file carries ([Trailmap: 390-showoff-clock]). The two differ in
what an unset value means. Laps are stored only above the single-pass default, so an ordinary mountain says
nothing about them; the clock is written whenever the mountain has been given one, so a map authored at 120 s
keeps 120 s on a slot whose own number is 90. A mountain that has never been given one omits the field and
inherits the slot it is packed onto.

`PathBundle` reads both files deduped, so the twice-shipped race line bakes once and the manifest
gains `LineDtf` (leaderboard / finish trigger) for authored mountains. Positive SOP type-11 records
travel separately as `Paths.Course.Checkpoints` with position, remaining DTF, seconds and logical route
group, so deduplicating AIP/SOP geometry cannot discard the showoff payload.

The engine loads `.aip` for Race/Freeride and `.sop` for Show Off. Both files require exactly six
valid `StartPosList` entries. SOP carries six short lead-ins at retail's ~1.4 m pitch, converging on
the course line. Initial world placement is a separate fixed six-rider formation transformed through
`Mdl_StageArea_Start_0`; the repacker aligns that instance to the shared authored race origin.
`core/doc/course.ts` computes the route gates, course frame and gate-prop boxes from the same origin.

## Where the race starts and ends

The run is a line, and the two ends of a line are not automatically the two ends of a race. The engine
resolves both by name hash from its own placed instances — `Mdl_StageArea_Start_0` stages the six-rider
formation, `Mdl_StageArea_Finish_0` anchors the post-race podium — and neither is derived from the path
network ([Trailmap: 120-objects, 390-pickups-and-race]). A lap course is where that matters: Tokyo
Megaplex stages its riders 343 m below the top of its own lap loop, so anything that guesses "the highest
point of the path network" lands nowhere near the grid.

Slopesmith therefore stores both as optional anchors on the run (`CoursePath.start` / `.finish`) and ships
them as those two instances, appended after every placed prop so their arrival doesn't renumber a level's
existing instances. Absent an anchor the head and tail of the line supply them, which is what every run
does until a flag is dragged. A placed anchor keeps the run's own heading and floor width at its station,
so a start can never end up facing uphill.

Three things follow the start anchor: the gate prop, the six SOP lead-ins, and where the AI field enters
the course. The finish anchor sets where the race line's `DistanceToFinish` reaches zero — the crossing —
which is a different place from `Mdl_StageArea_Finish_0`, the corral 20–48 m beyond it.

## Textures

An un-painted cell takes a procedural tile generated at export (`src/core/paint/ground-textures.ts`):
deterministic lattice value noise on a wrapping lattice (hence seamless), 256², opaque, one tile per surface
type referenced (snow/powder/ice/rock/offtrack/oob). No game assets are involved, and authored PNGs are
full-brightness — the half-bright doubling convention applies to textures decoded from SSH pages, not to files
supplied in `Textures/`. The bake classifies alpha per PNG (all opaque here) and ships names in the manifest;
the importer resolves them from `Textures/` as with any level.

A painted cell takes its own tile, copied byte-for-byte into `Textures/` under a flattened, collision-free
name. Nothing is resampled: what a page must shrink to is a property of the disc being patched, so
`repack` conforms it against the target's own bank, and Unity keeps the stored detail either way.

The paint reference on the document is load-bearing. Every painted quad must contribute a `textureSources`
entry to `Slopesmith.json` and a staged/copied page; an export with zero sources is an **unpainted export** and
will correctly substitute the procedural SurfaceType tiles. That failure looks like texture downscaling in
game—broad snow colour with no authored detail—but no resampler was involved. Diagnose it before changing the
codec: compare the saved document's painted-cell count with the export log/manifest source count, then hash an
extracted packed page against its donor. The 5p→5q investigation was decisive: 5p had lost all 618 quad refs;
5q carried 14 sources and its packed `0012.png` was byte-identical to MESA `0044.png`.

## Lighting

The authored sun (`SunLight` on the doc; absent ⇒ the project-authored `DEFAULT_SUN`) is baked into
lightmap pages at export (`src/core/lighting/bake.ts`), in the same original form an extracted level ships:
128×128 RGBA pages under `Lightmaps/000N.png`, **alpha = `A_S` light intensity**, **RGB = `C_S` GS colour
residual** (the warm-sun / cool-shadow tint). Each patch owns an 8×8 sub-rect of a page, packed 16×16 per
page (256 patches/page, 16 pages max), addressed by its `LightMapPoint` + `LightmapID`.

The tile is baked at an 8×8 tessellation (the engine reads a full 8×8 region per patch at its highest LOD),
so `TerrainBundle.SampleTile` recovers the authored value; lightmap UVs use mode 6 (transpose), so a tile
texel `(x,y)` carries the vertex at `(u,v) = (y/7, x/7)`. The light `Lc` is `ambient + sun·max(0,N·L)` minus
baked cast-shadow and AO (`src/core/lighting/occlusion.ts`, run headlessly over the whole quilt so cliffs shadow
across patches) — the `008` model — sun-tinted where lit, sky-tinted in shadow. **Alpha** carries the peak
intensity (`A_S`); **RGB** carries the colour residual: the Unity terrain shader's `_LIGHTMAP_GS` path
reconstructs `lit = (0.5·C_D − C_S)·(A_S·255/128)`, and the bake folds in each patch's **diffuse base** `C_D`
(its SurfaceType tile, sampled at the texel UV) as `C_S = C_D·(0.5 − Lc/(A_S·255/128))` — so the shader
reproduces **`C_D·Lc`** (texture × light, correct over dark rock / ice as well as white snow). A painted real
/ keyed tile (no pixels in core) bakes the white base `C_S = 0.5 − Lc/(A_S·255/128)`. The bake is gated by
the **export dialog's lighting setting** (default on), not the viewport's sun preview toggle — the sun
settings author the light either way. With lighting off, no pages are written and terrain ships white-lit
(an ISO repack then keeps the target level's original lights + `_L.ssh` verbatim).

**`Lights.json` — the sun in engine-native form.** Alongside the baked lightmaps (which light the
*static terrain*), the export writes the authored sun as the PBD's own light records: one directional
(`Type 0`) carrying the sun direction + colour, one ambient (`Type 3`) carrying the sky fill, both
bounded by the terrain. `Direction` is the raw-space *propagation* (from-light) vector — the linear
`toRaw` of −(to-sun), matching original `SD_Di_Directional`. This is the form that lights *dynamic*
objects: `LightsBundle` surfaces it as `manifest.Sun` (the importer orients its Directional Light and
tilts the probes from it), and the ISO repack writes it into the PBD light chunk — so a from-scratch
mountain self-describes its lighting with nothing borrowed from a reference level. Field names match
`LightJsonHandler`, so it round-trips through the repack reader unchanged.

## Verification

`npm run smoke` is the contract's regression test: build the default course, export to
`Maps/SMOKETEST/`, run the real `snowknife gltf`, then parse `terrain.glb` and assert —
plausible vertex count, every terrain normal skyward (accessor min-Y > 0), `TerrainCol_*`
collision meshes present (terrain colliders ride inside `terrain.glb`; `collision.glb` only
ever holds prop proxies), and `manifest.Paths.Course` populated.

The **reference layer** (`src/core/reference/terrain.ts`, README) is the same contract read backwards: it
parses an *extracted* `Patches.json` and renders it with the editor's own evaluator, inverting the
space map (`editor = (-rawX, rawZ, -rawY)/100`, the exact inverse of `raw` above). Because an
extracted file stores the same Bézier control points this contract writes, loading an extracted level and
seeing its terrain reproduced correctly is a live confirmation that the points, ordering, and spaces here
are right — and, the map being an exact inverse, a mountain authored over the loaded reference
round-trips into that level's own frame on export.

It also reads the level's **path tables** (`SOP.json` preferred, else `AIP.json`) and stitches the
main racing line — the descending-`DistanceToFinish` race-line chain — into editor space, so a new
mountain can be lofted on that borrowed line (`coursePathFromLine` + `buildMeshFromCourse`, the reverse
of the `AIP.json` write convention above). For the terrain it reads `Points` + `SurfaceType`; the
UV-corner binding above is write-side only.

Its **race endpoints** come from elsewhere, since neither end of that stitched line is one: `stageAreaAnchors`
reads `Mdl_StageArea_Start_0` and `Mdl_StageArea_Finish_0` off `Instances.json`, and `dtfZeroPoint` walks the
minimum-DTF race line's horizontal arc to its own `DistanceToFinish` for the finish crossing. The viewport
draws all three with the recovered line, so a reference level shows where it really starts, where it is won,
and where its podium stands.
