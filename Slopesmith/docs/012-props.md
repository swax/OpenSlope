# 012 — Props

A **props** capability that mirrors texture paint: where paint has an Asset Library of a level's real
tiles, props works from a level's real placed objects — trees, boulders, banners, scaffolding, lanterns.

> **Normative collision source:** Slopesmith's contact shape, `PlayerCollision`, exact-zero/nonzero collision response mass,
> `PlayerBounce`, and Roller decisions implement [Trailmap: 130-collision-data, 150-logic,
> 370-world-interaction]. Those chapters are the product contract; their citations trace each rule to
> the reverse-engineering and PCSX2 evidence. Slopesmith Test is a preview of that contract, with any
> approximation called out below.

The staged plan, all built:

1. **Show a reference level's props on its terrain** — the read pipeline + co-registration.
2. A **Prop Library** panel (the props answer to the texture Asset Library): every distinct model for a
   chosen reference world, shown as searchable 3/4 thumbnails.
3. **Placement**: click a library prop to arm it, click the mountain to drop it, gizmo to move + Tools to
   turn / size / delete; exported **textured** into `Props.obj` (+ `Materials.json` + copied tiles) so props
   ship with their real look.

## Where props live in an extracted level

`snowknife import` writes the prop render, contact, material, and sound inputs the view reads from `Maps/<LEVEL>/`:

- **`Models.json`** — the model table. `Models[]` in order; a model is `{ ModelName, ModelObjects[] }`, each
  object carrying `MeshData[] = { MeshPath: "N.obj", MaterialID }`. An instance's `ModelID` is the **array
  index** into `Models[]` (verified: `Models[11]` = `Mdl_RockBoulder_AlpsC_SharpSnow_2`, the model instance
  0 references).
- **`Instances.json`** — the placements. `Instances[]`, each `{ InstanceName, Location, Rotation, Scale,
  ModelID, Visable, … }`, including player collision, collision response mass (native `ObjectProperties.U0`),
  bounce, SurfaceType, physics-body index,
  collision-sound event, and ambience records. `Location` is raw SSX space (cm, Z-up, X-mirrored — the same space as
  `Patches.json` `Points`); `Rotation` is a quaternion `(x,y,z,w)`; `Scale` is per-axis.
- **`Meshes/N.obj`** — per-mesh geometry (model-local cm), the `MeshPath`s the models reference. A mesh can
  be shared by several models. Faces are `a/b/c` triples, already triangulated, carrying UVs (`vt`).
- **`Materials.json`** — the material table. `MeshData.MaterialID` indexes `Materials[]`; each record's
  `TexturePath` is the tile (`"0009.png"` in `Textures/`) and `UnknownInt18` carries the recovered appearance
  flags, including bit 17 draw priority and bit 18 alpha blending.
- **`Collision/N.obj`** — dedicated model-local triangle proxies referenced by mode-1 instances. These are
  not interchangeable with the visible mesh.
- **`Effects.json` physics bodies** — mode-3 sphere trees (`physics[].data.PhysicsDatas[0]`, native order,
  so an instance's `PhysicsIndex` indexes it directly) decoded to their model-local leaf spheres.

A prop-heavy reference level carries hundreds of models across hundreds of meshes, placed by thousands of
visible instances — tens of thousands of verts / tris of distinct geometry, which packs to a few MB of JSON.

(`Props.obj` in the same folder is the fully-baked, world-placed merge of all of this — used by the Unity
importer. The props view rebuilds from `Models`+`Instances`+`Meshes` instead, so it can instance per model
and keep everything in the same raw→editor pipeline as the terrain.)

## The transform (why props land on the terrain)

Reference terrain is drawn by mapping each `Patches.json` control point through
`ref-level.editorFromRaw(x,y,z) = (-x/100, z/100, -y/100)` and parenting it under `refRoot` (itself under
`worldRoot`, which holds the game-chirality Z flip). Props go through the **same** map, expressed as a
matrix:

```
RAW_TO_EDITOR =  -0.01   0      0     0
                  0      0      0.01  0
                  0     -0.01   0     0
                  0      0      0     1
```

Each instance's matrix is `RAW_TO_EDITOR × compose(Location, Rotation, Scale)`, and model vertices stay
model-local cm — `RAW_TO_EDITOR`'s `1/100` scales the geometry to metres along with the placement. Because
`editorFromRaw(rawPoint) = RAW_TO_EDITOR × rawPoint`, a prop vertex lands at
`editorFromRaw(instanceMatrix × localVertex)` — the identical native-editor frame the terrain lives in.
`refRoot` then supplies the chirality flip for both, so props and terrain co-register by construction and
follow the reference's placement offset together. `RAW_TO_EDITOR` carries the X-mirror (a reflection);
composed with `worldRoot`'s Z flip the on-screen result is proper-handed, matching the terrain. Materials
are double-sided, so the mixed instance/flip windings light correctly either way.

Verified numerically against a reference level: the props' editor-space bounding box overlaps the terrain's 100% in X
and Z, with props sitting on the surface (Y −2703..75 m vs terrain −2717..23 m) and extending just above it.

## Pipeline

- **`server/routes/props.ts`** — `levelsWithProps()` (folders with `Models.json` + `Instances.json` + `Meshes/`)
  and `readLevelProps(level)`. The latter groups each *instanced* model's meshes by `MaterialID` into UV'd
  submeshes (welded on `(vIdx, tIdx)` so seams split cleanly; a shared mesh is parsed once), packs each
  submesh's positions + uvs (Float32) and indices (Uint32) as base64, sends a `MaterialID → texture file`
  map, packs each referenced collision proxy and player-collidable sphere body once, and returns renderable plus
  hidden-collidable instances as raw-space transforms.
- **`server/api/props.ts`** — `GET /api/props` → `{ levels }`, `GET /api/props?level=<LEVEL>` → the payload. Prop
  tiles are served by the existing `GET /api/texture?level=…&name=…` (same `Textures/` the palette reads).
- **`core/reference/props.ts`** — `decodeProps(payload)` → typed-array `LevelProps` (`{ models, instances,
  materials, collisionMeshes, physicsBodies }`, each model a list of `{ mat, positions, uvs, indices }`
  submeshes). Browser-safe; the server
  does the disk + OBJ work.
- **`app/props/textures.ts`** — `PropTextureCache`: textures + lit double-sided materials cached by `(level, file)`,
  loaded from `/api/texture`. The material's appearance word first decides whether alpha participates; the
  decoded PNG then refines an alpha-pass page into **cutout** (bimodal holes), **blend**, or soft **glow**, the
  same histogram Snowknife records for Unity. Cutout draws use a low `alphaTest` (0.05), stay in the opaque pass,
  and write depth, so overlapping leaves/fences cannot show through their solid pixels. **Test ▸ Tuning ▸ MSAA +
  smooth cutouts** defaults on: the default framebuffer uses MSAA and cutouts feed their continuous alpha to
  sample coverage. They remain opaque-pass depth writers, so a glass-faced building still reveals its interior
  rather than acquiring blend sorting errors. The same setting requests MSAA on the next WebXR layer. Turning it
  off reloads the renderer without MSAA and uses Three's stable `alphaHash` to turn partial alpha into grainier
  single-sample screen coverage rather than a hard clip.
  Water/glass remain
  translucent, which is why the river reads bright in game: the water composites over the snow.
  A blend material keeps
  **depth write**, so a closed blend shell (the GARI Radiotower) cannot composite its far wall through its near
  one — unless the submesh is a single-facing **sheet** (`isSingleFacingSheet`: every normal within 0.5 of their
  mean), which has no far wall and cannot afford the depth write: MESA's river is two stacked sheets, a fast
  scroll over a slow one, and whichever wrote depth first would depth-reject the other. Prop UVs are
  raw OBJ `vt` (bottom-left origin), so the tiles keep `flipY` at its default — unlike the terrain tiles.
- **`app/viewport/scene/reference-decor.ts`** — `setProps(props)` packs static submeshes from different models
  into one **textured** `BatchedMesh` per shared material and view layer. Transparent materials use separate,
  depth-sorted batches; model-animated and private command-controlled geometry stays in isolated `InstancedMesh`
  batches. Ambient UV-scroll, flipbook, and crowd materials batch by their exact live material identity (including
  their frame law and randomized dwell seed). Merely owning an effect graph does not isolate a prop: Play visibility, rigid/spline motion, and piece
  throws update the original source slots inside the material batch. When `WEBGL_multi_draw` is unavailable,
  static opaque batches physically merge into
  one indexed mesh per material instead of accepting Three's one-call-per-slot fallback; the Play profiler labels
  which path is active and reports batched versus isolated prop draws. Every draw
  slot retains its native source index, model/submesh geometry, and surface metadata so picking, outlines,
  Paint inspection, collision bounds, and Play-time visibility/matrix effects do not depend on the combined GPU
  buffer. Extracted `vn` normals are sent and used when present, because the native per-instance light vectors
  are model-local and the PS2 dots them against that exact stream; only legacy/authored payloads without `vn`
  fall back to recomputed normals.
- **`test/prop-shader-webgl.test.ts`** — the runtime shader regression. It launches an installed
  Chromium-family browser (override with `SLOPESMITH_CHROMIUM`) and makes Three compile and draw both the
  custom no-colour material variant and the native instance-colour lookup variant. Keep this real WebGL check
  beside the faster source-anchor assertions: object-dependent shader defines do not exist during a string test.
- **`app/main.ts`** — a global **Props** on/off pill in the top bar (right of the Textures shade radio, in
  `viewProps`) that drives BOTH the placed props and the loaded reference's props (`propsVisible`, persisted,
  on by default). Reference props load on demand the first time they're shown with a level open, and
  auto-show when a reference loads (`applyPropsVisible` / `ensureRefProps`).

## Library + placement (phases 2–3)

**`MountainDoc.props`** — placements are `PlacedProp[]` (`{ level, model, name, pos, yaw, scale }`, plus
optional `pitch` / `roll` and semantic `modePresence: 'showoff'`) on the doc, in editor/data coords like `corners`, so undo/redo + persistence come
free (the net-model migration passes the field through). The model geometry is *not* stored — only which
model, from which level.

**The placement rotation** is those three angles, composed YXZ — `Ry(yaw) · Rx(pitch) · Rz(roll)` —
resolved in one place, `core/props/pose.ts`. `yaw` is the angle placement authors (the wheel turns it, Tools
names it "turn"), and `pitch` / `roll` are absent on a prop nobody tilted, so an upright placement resolves
to exactly `Ry(yaw)`. Everything that poses a prop reads the rotation from that resolver rather than
building its own `cos`/`sin` pair off `yaw`: the viewport matrix, the OBJ bake, the canonical instance
quaternion, sign lights, attached emitter frames and group members. That is what keeps a tilted prop from
rendering at one angle and shipping at another — the render/bake parity and the native-instance agreement
are both asserted (`test/prop-picking.test.ts`, `test/imported-props.test.ts`).

**Prop Library** (`app/props/library.ts`, a bottom dock like the Asset Library): a per-level, searchable grid
of every model, each a **textured** 3/4 thumbnail rendered client-side by `app/props/thumb-renderer.ts` (one shared
offscreen WebGLRenderer with its own tile loader; each render loads the model's tiles first, then snapshots;
lazy via an IntersectionObserver + a serial queue so 600+ models stay cheap). Clicking a prop arms it and
jumps to **Props mode** (a new `Mode`, alongside view/edit/paint/sculpt). **Right-clicking** one of the
author's own models — the Custom view's authored cages and imported GLBs — raises rename / duplicate /
replace / delete, the props answer to the Texture Library's tile menu
([032](032-imported-props.md#managing-a-model-right-click-in-the-prop-library)); an extracted level's models
carry no menu, because they are the reference rather than the work. The panel opens on the shared rule
(`ui/components/library-default.ts`, [026](026-effects-editor.md)): the Custom view when the author owns any
models — authored cages or imported GLBs, the two it mixes — otherwise the loaded reference level. It is
re-derived on first open as well as at `init`, since boot chooses before the reference and the Custom
catalogues are known; an explicit pick by the author stands afterwards. Closed, it leaves a **pull-up tab**
in the middle of the bottom edge — the twin of the Texture Library's, and the only route back once a prop is
selected and the Prop Tools' own toggle steps aside for the selection's details
([005](005-texture-paint.md#the-asset-library--one-flat-list-of-textures)).

**Placement** (in `Props` mode): the mode has two states, shown in the lower-left control sheet — **placing**
(a prop is held) and **select** (nothing held). Picking a prop from the Library — or **middle-clicking** any
prop in the world, placed or reference (select + arm) — arms placing; **Esc**
puts the prop down.

While **placing**, the cursor changes to the **Props box with a plus**, and a translucent textured **ghost** of
the held model rides beneath it over the terrain at
the exact pose a click commits — seated, at the pending turn / size. The **wheel** turns it (15° per notch),
**Shift+wheel** resizes it (0.1–5×, kept across drops), and a **click** places it; the tool stays armed, so
repeat clicks stamp more. The turn starts random and re-rolls per drop — a scatter of one model doesn't look
stamped — until the wheel takes manual control, after which the turn holds across drops (fence lines). Every
drop **seats the model's lowest point on the clicked terrain**, not its origin: origins sit anywhere in the
mesh (some at the base, some at the centre), so `propBaseOffset` (the lowest vertex's height above the origin,
`minRawZ/100`) × scale is subtracted from the click height. Resizing keeps that base on the ground (scaling is
about the origin, so the size slider nudges the height to compensate). The seat lives in the stored `pos`, so
the export bakes it seated too — verified: every model at every scale lands its bottom on the click to 0.0000 m.

In **select** mode, a click grabs whatever's **nearest** under the cursor — a placed prop, light, rail node,
gem, or a **reference prop** — or clears the selection over bare terrain. A selected placed prop keeps its
tiles and shows an **amber edge outline** (cached `EdgesGeometry` fat lines over the textured meshes), and
seats the gizmo; Tools gives turn / tilt / roll / size sliders + delete (Del also removes); Esc deselects.
The Rotate gizmo (**R**) shows all three rings, because a placement authors a full rotation — tipping a prop
onto a slope or laying it on its side is an ordinary drag, and the Tools sliders are the same three angles
typed.
A selected **reference prop** is **read-only**: the same outline (seated at that instance's transform, riding
the reference's offset) and the preview card — no gizmo, no Del; middle-click it to pick
the model up. Middle-clicking a placed prop likewise picks its model up to place more of them. Placed props render as one `Group` per placement under
`worldRoot` in data coords — a **textured** `Mesh` per material submesh, the submesh geometry cached per
`<level>:<model>` and shared — through `placedPropMatrix` = `compose(pos, rotation, scale) · RAW_TO_EDITOR`,
so a prop stands at real size and rides the chirality flip like everything else. The gizmo drives a
persistent scene-root handle (like the reference move handle), so it survives the per-edit rebuild.
Props-view selecting is a lightweight scene-state change, not a document edit: `setSelection` attaches/removes cached
outline decoration beneath those existing placement groups, refreshes the facing arrows / emitter range, and
seats the gizmo without sending terrain, every prop, authored lighting, persistence, or undo through
`renderDoc`. Moving, rotating, scaling, placing, or deleting still uses the normal document rebuild funnel.

The course-knot cleanup used by scene-object picks is idempotent: `onSelectKnot(null)` returns immediately when
the knot state is already empty, rather than scheduling a full `renderDoc` merely to reaffirm mutual exclusion.

**Multi-select** (select mode): a **left-drag** rubber-bands a box — the press is deferred, so a still
click still selects on release while a drag past the tap threshold draws the marquee — and every placed
prop whose origin projects inside becomes one selection set. Each member shows the amber outline, and the
the one gizmo parks at the set's **centroid**; dragging it moves every member by the same data-space
delta (the viewport reports deltas via `onMoveProps`, the host applies them to its `multiSel` indices).
Rotating the set turns it **rigidly** about that centroid — each member's origin swings and its own
rotation composes the same turn, so a fence line keeps its shape (`onRotateProps`).
The Tools panel lists the set (`app/props/multi-select-list.ts`, under the preview card): clicking a row **identifies**
its prop (a white box flashes around it in 3D and the preview card shows it), the
row's **✕** drops it from the set (the prop stays placed), and **delete N props** / the **Del** key remove
the whole set. A single click, arming any tool, Esc, or undo clears the set. Box-selecting in edit mode
(corners) and props mode share the marquee overlay; `marqueeKind` routes the finished rectangle.

**Prop Tools preview** (`app/props/preview.ts`): the top of the Tools panel in Props mode shows the name,
a big 3/4 thumbnail, and the tri / vert counts of the prop you're **holding** (armed from the Library or middle-clicked off the world) or
the placed prop you have **selected** — the props answer to the paint Palette's current-tile preview.

Under the name it also prints the **full model name**, and for a selected placement the **instance id**. The
name above them is a browsing label with the `Mdl_` prefix and the trailing `_<n>` dropped, which is right when
that number is a copy id (`FireHyDrant_Base_1005`) and wrong when it separates different models: Megaplex ships
twenty glass panes, `Mdl_Glass_Pane_2000` through `_5004`, each with its own mesh, and every one of them labels
as `Glass_Pane`. Effects attach to the *instance*, so the two extra lines are what say which pane a chain will
land on. Rendered
by its own `ThumbRenderer` (a size up from the library swatches), cached per `(level, model)`. So the flow
reads: pick a prop up (Library click, or middle-click one in the world) → see it in the preview and as the
ghost under your cursor → click your mountain to drop it.

The library, placement and the reference-props view all fetch through one `ensurePropLevel(level)` cache, so
a level's few-MB payload is fetched at most once per session; `registerPropModels` hands its geometries to
the viewport.

### Instance and surface details

A selected **reference** placement exposes the native instance rather than guessing from its appearance. Its
**Mode presence** section reports the exact LTG list state (`-1` unlisted, `0` common `InstanceIndex`, `1`
`RaceInstanceIndex`, `2` Showoff `GemIndex`). State 2 is the live-verified Showoff-only object layer; state 0
can still be hidden by a mode effect, and state 1 remains provenance rather than an authoring promise until its
general-purpose runtime behavior is validated. A selected authored placement exposes the semantic control
**all modes / showoff only** instead of a raw integer. Copies retain it, and Showoff-only writes canonical
`LTGState: 2`; Test, Unity bundle mode masks, and PS2 LTG regeneration all retire its model and collider in
Race and Freeride.

Its
**Contact & collision** section is the read-only twin of the authored one: the same rows in the same order
under the same names — collision shape, player contact, player bounce, collision response mass, bounce amount,
ride surface, physics body index, physics source level, effective collision result — taken from one shared
vocabulary (`COLLISION_SHAPE_OPTIONS` / `CONTACT_HELP` in `ui/tool-panels/props.ts`) so a retail instance and
your placement read against each other row for row, and `place prop` hands those exact values over as editable
defaults. Roller **dynamic mass** follows the result line when the level's own collision effect activates the
body; it is effect payload rather than an instance field, so it has no authored twin. Where retail ships no
record for a row (an untouchable instance has no kickback), the contact class default is shown and the row's
help says so. A reference instance also reports—when present—its collision-sound event with an audition button named for the
resolved extracted WAV (for example `GARI/garibaldi1/032.wav`). Props with no hit-sound record show no button.
The native event value `0` is also silent and omitted.
Every variable-sized
`Sounds.ExternalSounds` record retains its native type/event/offset/U5+ payload; the inspector interprets the
recovered point, ellipsoid, directional, and alternate-voice forms plus their ranges and known falloff curves.
The external-event resolver also follows the retail fixed global-bank dispatcher, so machinery and wildlife
emitters name and audition their decoded source (for example Snowdream event 90 is
`SNOW/Snowmachine/000.wav`) instead of being mistaken for silent collision events.
Events **16**, **28**, and **57** — Merquer's cars, fire hydrants, and police cars — are the *interactive
ambient class* and read as `point · hit-gated`: they are silent at any range until the rider hits that exact
instance during Test, and then sound for the rest of the run [Trailmap: 420-interactive-gate]. The arming
follows the contact rather than the prop's collision row, which is what makes hydrants work at all — every
retail hydrant base pairs its spray with the silent collision sentinel, so waiting for an audible impact would
leave all 22 of them dry. Leaving Test disarms them again, as retail's full audio reset does.

Placed ambience **only sounds during Test**. It is a continuing bed of dozens of voices, and running it while
the author is panning a camera or dragging a gizmo is noise nobody asked for — the whole mountain sounding is
a run-time fact, not an editing one. Hearing one emitter on purpose is what the inspector's **▶ play loop**
button is for: it auditions that record's real BNKl loop region, looped, so the seam can be judged the way the
bed will actually play it. Because a loop has no natural end it is a toggle — the same button reads **■ stop
loop** while it holds — and it stops on its own when the selection changes or the prop is deselected, so a
sound can never outlive the control that stops it. Starting any other preview ends it too.

An authored prop's own ambience is editable across the region forms whose every parameter has a settled
meaning: **shape** is a point sphere (native type 0, one radius) or an **axis-aligned ellipsoid** (type 1,
a half-extent per axis — how retail covers a long highway module or a wide fan of grandstand), and **falloff**
is any of the six exact curves the runtime evaluates, defaulting to linear. Switching shape seeds the new form
from the old one's size, so a region does not jump when its shape changes. Type 2 directional regions stay
read-only on purpose: their angular gate has no stable semantic label yet, and Slopesmith does not author data
it cannot also reproduce. Type 3 is placed nowhere in retail, so it is not offered either.

Both readings of that authored region — the cyan outline in the viewport and the native record the export
stamps — are derived from one spec in `core/effects/external-sound`, because editor and native disagree on
more than scale: editor `(x, y, z)` is native `(x, z, y)`. A sphere hides that, being permutation-invariant;
an ellipsoid does not, and a hand-written second reading would ship a volume that is not the one drawn.
Snowknife carries the offset and curve through as-is and approximates a type-1 ellipsoid to Unity with
its volume-equivalent sphere, so an ellipsoid is exact on PS2 and close elsewhere.

Authored ambience sounds in Test alongside the reference bed, through the same field — a placement's emitter
is the same kind of thing a reference instance's is, so it belongs in the mix rather than in a preview of its
own. It carries the prop's own source level, because a placement keeps the bank of the level its model came
from, which need not be the reference level currently loaded. Assigning **16**, **28**, or **57** to an
authored prop makes it hit-gated exactly as a retail one is — the class is fixed in the engine, so the id
alone decides it, whether or not the author meant it. The inspector says so where the id is chosen, and warns
when a gated event lands on a prop with no player contact: nothing can hit it, so nothing can ever arm it, and
it would ship silent for the whole run.

An uploaded WAV can be hit-gated too, by **claiming** one of the three ids — the only way, since the engine's
class test is three literal compares and nothing in level data extends it. `MountainMeta.hitGatedSounds` is
the claim: an ordered list where position picks the id (0 → 16, 1 → 28, 2 → 57), toggled from the emitter
section beside the file it applies to. Deriving the id from position rather than storing it means the editor
and the export allocate identically without coordinating, a file cannot hold two ids, and an id cannot be
held by two files. Releasing **blanks** a slot rather than closing the gap, because compacting would slide
every later claim onto a different event — and so onto a different bank slot, silently changing which retail
props it overrides. A claimed file keeps supplying the clip while the event supplies the routing, so
`isInteractiveAmbientEvent` gates it through the ordinary id test and no second notion of "gated" is threaded
through the runtime.

The cost is real and mountain-wide: claiming event 28 takes over the course-bank slot that id resolves to for
the **entire target level**, so any retail prop using it plays this clip instead. Merqury City is the only
shipped course that places these events at all — 21 cars, 22 hydrants, 10 police cars, plus three props using
28 as a hit sound — so everywhere else the slots are unclaimed and a claim costs nothing. The export names
each claim in its log, and `snowknife repack` warns per overridden slot for hit sounds **and** for ambient
emitters (the emitter half was previously a blind spot, so taking event 28 rewrote every hydrant's spray
silently).

The reverse trade is worth knowing, because it is free. A prop given an existing retail event plays that
event's shipped clip and adds nothing to the bank, and the richest of those is **event 63**: every course
bank carries the same 2.17-second stereo glass smash in the slot it resolves to, which retail uses for the
LCD screens, the breakable windows and the shortcut covers [Trailmap: 260-slot-64]. An authored breakable
wanting a shatter should take it rather than ship a clip. The corollary is that leaving it alone is also
worth something: on a course that reaches it from nowhere, it is the largest slot `snowknife repack` can
reclaim for a custom clip — 54,688 bytes, a sixth of Garibaldi's whole bank budget.
The top-bar **Sources** view turns every non-silent record into a speaker icon at `instance location + native
offset`; clicking it draws only that emitter's listener range and selects its owning prop for these details.
The selected prop's **show collider** switch draws both sides of the export seam: cyan is the exact native mesh,
model AABB, or mode-3 leaf-sphere tree; slate retains configured native geometry whose `PlayerCollision` gate is
off; orange is the simplified box/capsule collider the current Unity bundle rules emit. Thus a selected extracted
mode-3 body keeps all of its native spheres visible while its doorway/sparse/tilted body decomposition is overlaid,
and an authored mode-3 placement shows donor spheres plus its explicit visual-bounds Unity proxy. Mode 1 and mode 2
do not add a coincident orange duplicate when their native proxy/AABB is already the exported geometry. Visibility
is independent—an invisible utility/collision twin is still a collision source when `PlayerCollision` enables it. A selected emitter's
listener region is drawn as cyan great circles, including its instance-relative center offset and a type-1 ellipsoid
where the full record is available.

The separate texture-details surface reports the exact clicked submesh's texture,
opaque/cutout/translucent appearance, bit-17 draw priority, and flipbook/UV-scroll animation. In Paint mode that
same submesh alone receives a yellow clicked-surface outline and can be inspected and sampled as a brush, so a
multi-material model yields the surface actually under the cursor. Its UV wireframe uses the same yellow over
the texture preview; native flipbooks add a scrollable frame strip, and selecting a frame promotes it to that
large UV preview. A Play/Pause link beside the frame count runs the same recovered direction, `speed` fps rate,
and dwell law as the viewport material. This surface browses frames, so a one-shot's node lifetime is dropped
from that playback and reported in the animation row instead — otherwise inspecting a megaplex button would
show a third of a second of animation and stop. The frame count lives only in that header instead of repeating beneath
the appearance readout. This stays in Texture Details without duplicating material fields or outlines in Prop Details.

## Materials & textures, in the prop inspector

Texture Details answers "what is the surface under my cursor". The prop inspector's **Materials & textures**
section answers the other half — what the selected placement's *model* is made of — and is where the material
table is authored. It lists every material the model draws with: its resting tile, how many submeshes and
triangles wear it, its appearance (opaque / alpha pass, bit-17 priority, any declared scroll), and its flipbook
state list.

Both are shown as the **art**, not as file names. The resting tile is a swatch (the same `texturePreview`
control the Edit-model banner uses), and a flipbook is a strip of swatches in playback order, each badged with
its frame number and `rest` for frame 0. That is the whole reason to show a state list rather than list one:
what tells a button's two frames apart is that one is green and one is red, which a pair of numeric file names
conveys not at all. Refs stay on hover, where they identify the tile far worse than the tile does.

**A material belongs to the model, not the placement.** The native table is level-wide and a mesh indexes into
it, so retexturing changes every placement of that model at once; the section says so above the rows rather
than letting an author discover it by editing one prop and watching the rest follow. It is also why editing
stops at reference models — their materials come out of an extracted level's `Materials.json`, which
Slopesmith reads and never authors. Those still list, because comparing a retail flipbook against an authored
one is how you check the authored one.

For a model Slopesmith owns the section is editable:

- **`@import`** (GLB props, docs/032) — pick the material's tile, and append / drop / clear flipbook frames.
  Clicking a frame swatch replaces that state. Frame 0's swatch is deliberately inert: it is the texture
  field above, and two controls writing one value would hide that the state list is headed by the resting
  tile. Frames are ordinary bank tiles, so choosing one is the same Texture Library pick as any other
  texture; they must live in the same bank as the material's own tile, because that is what the renderer
  resolves a frame list against. Edits go through `POST /api/custom-prop-materials`, a narrow patch rather than the
  whole-record replace an import uses: this edits a model the author is already using, so it must not be able
  to arrive carrying a different mesh. The server re-heads the state list onto the material's own tile, so
  re-picking the texture moves frame 0 rather than stranding a flipbook on a tile the surface no longer rests
  on, and a list that falls below two frames drops the flipbook entirely.
- **`@models`** (authored polygon models) — the same controls. The tile is the field the Edit-session banner's
  swatch sets, reachable here without opening the session; the state list is `AuthoredModel.frames` beside it.
  Both are document edits, so they go through history like any other and a mis-pick is one Ctrl+Z away —
  unlike an imported model's table, which lives in the prop catalogue and is patched over HTTP.

`frames[0] === texture` is an invariant on both sides, held by construction rather than by the caller: the
resolvers re-head the list onto the model's own tile, so re-picking the texture moves frame 0 and a list
inherited from an older document cannot drift. A list that falls below two entries resolves to no flipbook at
all, because a state list of one *is* a still image. Renaming or deleting a tile retargets frames alongside
`texture` — a dropped frame shortens the list rather than leaving a dead ref, and the delete confirmation
counts frames toward what it costs.

`syncLiveModels`'s content signature covers the material fields for the same reason it covers the clip:
retexturing moves no vertex, so a geometry-only signature would call the model unchanged and keep drawing the
tile it first registered.

A selected **placed** prop can assign a native collision-sound event or upload/choose/audition a custom WAV, plus
a positional **ambient loop** and audible radius. Uploads are normalized to PCM16 mono (maximum ten seconds) under
the mountain's `assets/sounds/`; its selected radius previews through the same cyan range overlay. Authored loops currently
write the fully understood type-0, origin-centered, linear-falloff subset, while the shared lossless emitter model
leaves the other shape/offset/curve controls as an incremental editor extension. Every new placement materializes
a complete collision profile: shape (none/mesh/bounds/source spheres), Player contact, solid-response gate,
`responseMass`, bounce amount, optional source physics body, and rideable SurfaceType. Borrowed model-only art
defaults to the conventional solid mesh profile; arbitrary authored/imported geometry defaults decorative.
Copying a concrete source instance preserves its exact independent gates/values and its sphere-body donor when
present. These are editable defaults, not restrictions. To make a prop move, add the collision effect template
**Roller / knockable prop**: its semantic **Mass** drives Slopesmith's Roller preview and the Unity
Rigidbody path, while the same graph compiles into an ISO. Per the collision spec, an arbitrary custom native
prop still needs sphere-tree shape/inertia data before the game has a body to move; Roller does not invent that body.
Every resolved impact, collision, or ambient sound ends with a read-only **filepath**, and each authored sound
block then closes with the same three actions in the same order — **🔊 browse…**, **⤒ load custom wav…**,
**▶ play sound**. The fields above stay a description of the sound; the ways to change or hear it sit together
at the bottom, in the same order in the Impact, Emitters and Play sound blocks alike
([026](026-effects-editor.md)). Silent or unresolved records keep their diagnostic filepath without a dead Play
action. A picked *reference* instance keeps the plain filepath-then-Play pairing: an extracted level's own
record is the reference, not the work, so there is nothing to browse or load on it.

Both event ids are pickable by ear rather than by number: browse opens the Sound Library in its event mode,
listing each id with its material or bank name — `6 — rock`, `31 — metal rail`, `90 — Snowmachine` — where it
resolves, and ▶ to hear it against a chosen level's bank. The numeric field stays for the ids the tables leave
unlabelled. Uploaded WAVs come from one library shared with the effects inspector, so a clip loaded for a prop
is immediately offered to a Play sound node and the reverse.

Contact effects and sounds never rewrite those settings. Contact & physics always shows the effective result
under the editable fields, then places yellow diagnostics immediately below it when a value is ignored, the
chosen shape/body is unavailable, an effect/sound cannot receive contact, a trigger was made physically solid,
or Roller can preview/export to Unity but a custom ISO prop has no native sphere-tree body/inertia. Maps saved
before complete profiles existed retain their former inferred Solid/effect behavior until the first collision edit
materializes that result. Thus old maps remain stable while new maps can express every combination the spec permits.
These defaults are authoring conveniences, not additional validity rules: effective contact and response are
evaluated directly from the independent fields defined by collision-data spec 130, whose behavior is grounded in
the documented engine reverse engineering. Diagnostics explain surprising combinations without changing them.

**File → New mountain → collision lab (GARI)** builds the reusable first matrix: sixteen labeled crash bags in
four down-course mode/control bands and four cross-course response-mass lanes, each with a distinct collision-burst color,
plus one centred downhill follow-up for nonzero mode 1 with PlayerBounce off. That follow-up was live-confirmed:
its cyan marker fires but the rider passes through, proving contact dispatch survives while physical response is suppressed.
Following one lane downhill therefore visits modes 1, 2, 3, then a control; crossing one band compares response masses.
An isolated six-box outer column is a straight-down regression pass: no shape (no marker), PlayerCollision off
(no marker), zero response mass (orange marker / through), PlayerBounce off (cyan marker / through), bounce amount
zero (yellow marker / solid with the universal minimum eject), then bounce 0.6 (magenta marker / stronger rebound).
The first station from spawn begins a six-box downhill calibration column that holds shape and response mass constant
while varying only bounce amount: 0, 0.03, 0.2, 0.5, 0.6, and 1.0. The first five cover the floor plus every retail
tier; 1.0 is a deliberately non-retail elastic stress control. The boxes are 190 m apart so one run can regain speed
and continue through the entire sequence. Similar low-normal-speed
results are expected where the universal 2 km/h floor dominates; record rebound and rider crash/fall separately,
because the game tests the full velocity delta against an orientation-adjusted threshold. With incoming normal
speed `s`, bounce `b`, outward contact normal `n`, and board-up row `u`, the native rule is
`max(s·(1+b), s+55.556) > 1944.444 + 833.333·dot(u,n)` in cm/s. A continuous live trace crossed that threshold
only on the `0.6` specimen; the `1.0` control was approached more slowly and remained just below it. A follow-up
caller probe confirmed that fall came from the bounce hard-impact branch rather than the separate wall-surface path.
The generated slope is intentionally widened and lengthened: every fixture has at least 40 m of horizontal clearance,
and an eight-metre footprint around every host is verified as rideable snow rather than shoulder/reset terrain. Unlike
an ordinary generated mountain, the lab expands snow across its whole safe interior while retaining the slow and OOB
edge rings, so choosing a test lane cannot change approach speed through a powder surface.
Mode-3 cases all point at the same GARI body 7. The native marker is a 1.5-second additive halo fountain so
visible color proves contact/effect dispatch; no color means the shape/gate produced no contact. Use Test for a
quick local pass, export/repack as GARI for the authoritative PCSX2 result, and save the mountain normally if you
modify the matrix. A mode-3 donor is level-local: exporting that profile to another target warns and packs no
body instead of silently borrowing an unrelated index.

**Export** (`server/routes/props.ts buildPlacedProps`, appended in `export.ts`): each placed prop's model submeshes
are transformed to raw SSX space at its pose and appended to `Props.obj` after the start gate — the SAME
THREE math the viewport renders with, so what's placed is what ships. Because `toRaw(RAW_TO_EDITOR·v) = v`, an
identity placement bakes the model's own mesh verbatim (verified: round-trip max error 0.0005 cm; translate
= `toRaw(pos)`; scale exact; faces `v/vt` offset past the start gate's vertices). The model's own OBJ `vt`
are emitted as-is (the winding + UVs the shipped `Props.obj` carries). Imported GLB props (docs/032) share
this emission path verbatim through `emitPosedSubs` — their decoded submeshes are the same shape — differing
only in that their materials resolve through the combiner's tile slot rather than a source `MaterialID`.

Props import **textured**. The bundler resolves a prop `usemtl mat_<id>` by parsing `<id>` and reading the
exported level's `Materials.json[id].TexturePath` → a PNG in `Textures/` (`MaterialBundle`); it never reads a
`.mtl`. Source `MaterialID`s from different levels collide, so each distinct `(level, MaterialID)` used gets a
**fresh id** in one combined `Materials.json`, and each referenced tile is copied into `Textures/` under a
prop-namespaced name (`p_<LEVEL>_<file>`, disjoint from terrain tiles, deduped across props). The source
material's `UnknownInt18` (alpha-blend flag) rides along, so `TextureBundle` classifies each tile exactly as
the source level does — a rock bakes **opaque**, tree leaves / banners bake **cutout** (verified end-to-end:
`snowknife gltf` builds `props.glb` and the manifest resolves `mat_0 → opaque`, `mat_1 → cutout`).
Source `TextureFlipbook` lists are re-keyed to the same prop namespace, every frame PNG is copied, and the
frame list is preserved in the combined material. In the editor viewport, the top-bar Effects toggle previews
attached `property.uv-scroll`, `property.texture-flip`, and `property.crowd-box` graphs. Ordinary flipbooks use
the recovered `speed` frame rate and direction; warning-screen dwell flipbooks preserve their recovered
long-hold / 0.1-second-flash behavior with independent stable per-prop randomization; a flip with an authored
`Length` is a one-shot that rests on frame zero until a graph runs it (docs/027). Crowd props draw from the
extracted shared `cd00.png` … `cd15.png` bank at the existing 8 fps editor/Unity approximation.

Collision sounds, ambient loops and contact tuning use the same stable placement-id → baked-group join as attached
effects. Export writes `collisionSounds`, `collisionSoundClips`, `ambientSounds`, legacy `propBounce`,
`propSurfaces`, and each placement's exact `nativeCollisions` profile under `extensions.slopesmith`; every resolvable
direct-import clip is staged in `Sounds/`.
Custom prop/ambient WAVs additionally allocate one of eight reserved event ids and write `customSoundEvents`
(event id → filename). Those ids are IDENTITIES rather than destinations: they keep the editor, the export and
the ADL agreeing on which clip is which, and they say nothing about where the clip should live, because an
export does not know which disc or course slot it will be packed into. `repack` resolves them through the
target ISO's executable and then usually MOVES them — a rebuilt course bank must not exceed the size its level
shipped with or it plays nothing at all, and the reserved ids land on slots banks leave empty, which charges
each clip full price. It re-points them onto slots the target bank already ships and the built course no
longer reaches, stamps collision/ambient instance + ADL rows, donor-fills needed empty course-bank slots, and
PS-ADPCM-encodes custom WAVs. The finished disc carries a `<iso>.sounds.json` naming the event and slot each
clip actually landed on. `snowknife gltf` consumes the same effect graph: Roller targets divert into the
knock-and-tumble physics-prop path with the Roller's mass, solid collision buckets keep bounce/surface/sound,
ghosts get sound triggers, and ambient becomes a placed loop.

## Next

- Measure the native fixed crowd playback rate; the editor and Unity path currently use 8 fps.
- Scatter / brush placement (drop many at once), snap-to-surface normal (drop already tilted to the slope,
  rather than tilting by hand afterwards), grid/align.
- In-engine bake + ride test to confirm prop winding / lighting (export + `snowknife gltf` verified; a Unity /
  Basis import + look is the remaining check).
