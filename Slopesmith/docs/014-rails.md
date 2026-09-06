# 014 — Course splines (grind rails, motion paths, and gems)

The **trick layer** of a course — the grind rails you ride and the gem pickups you string between them —
authored under one roof and shown/hidden with one filter. It's the third authoring layer next to the props
(012) and the authored lights (013): a **Tricks** cluster in the top bar holds a view **filter** (star) that
toggles rails + gems together, plus the **Rail** and **Gem** tools that drop into the layer. Both tools live in
Props mode, entered from **Add rail pipe** / **Add gem** in the idle Prop Tools launcher, and each opens its
own panel with a **cancel** back to that launcher. A grind rail can also be drawn as the **spline alone**, from
Effects mode — see *A rail without a pipe* below.

## Grind rails

Lay a **grind rail** by hand: click points on the mountain, and the rail splines between them, floated at a
height you set. It exports to `Splines.json` — the file snowknife's `PathBundle` bakes into the ridable rail
network — so a from-scratch course carries rails the board can grind. The in-editor **test ride grinds them
too** ([Trailmap: 350], `app/ride/grind.ts`, 016): the same Bézier chain the export writes is the curve the
playtest board rides, so a rail line can be tuned without leaving Slopesmith.

## What a rail is

A rail is a chain of **node points** the user drops on the terrain, splined into a curve. The curve is the
**same uniform Catmull-Rom** the run spine uses (`core/math/spine.ts`), so a rail bends exactly like the course
paths the editor already draws. Nodes live on `MountainDoc.rails: Rail[]`, in editor/data space (m, Y-up) —
the frame `corners` use — with the ground standoff **baked into each node's Y**, so they ride undo / persist
and each node can be dragged to follow a slope.

```
Rail { kind?: 'grind' | 'motion'; nodes: V3[]; height: number; style?: number;
       startsOff?: boolean; bare?: boolean; name?: string }
```

- **`nodes`** — the point chain, floated `height` above the ground they were laid on.
- **`height`** — the standoff (m) the rail was laid at; the Tools slider re-floats every node together.
- **`kind`** — absent / `grind` for old and current grind rails; `motion` for an invisible effects route.
- **`style`** — SSX `SplineStyle`: `13` metal (default), `12` wood, `5` ice. All grind; the style colours the guide.
- **`startsOff`** — grind-only: ship the curve OUT of the rail network and let a `Rail on / off` effect put it
  in (below).
- **`bare`** — grind-only: ship the curve WITHOUT a tube of its own (below).

## A rail that starts off

Rail candidacy is a runtime bit with **no authored flag on disc**. Retail's enable-after-event rails — MESA's
fallen trunk, grindable only once the tree has come down — are authored at the non-grind **`SplineStyle 1`**,
which the rail query does not search, and the break chain's `MainType 25` toggle is what pushes them onto the
candidacy bit ([Trailmap: 140-rail-toggle], docs/026). So the **starts off** checkbox is exactly that style
swap, and nothing more: `nativeSplineFields` keeps the grind row's `(1, 1)` pair and writes `RAIL_STYLE_OFF`
in place of the selected material, while the document keeps that authored material so switching the rail back on restores
the rail the author drew.

Everything else about the rail is untouched, because the toggle switches **catchability and never
visibility**: the tube is drawn, textured, baked into `Props.obj` and solid exactly as authored. A rail
switched off with its geometry still showing is what the player reads as a rail that refuses to grind, which
is the effect the gag wants.

The in-editor test ride leaves such a rail out of its network too (`authoredGrindRails`). No preview in
Slopesmith runs a MainType-25 toggle, so grinding it here would be the one thing the console will not do on
the same course — untick the box to ride it while authoring. The pairing is validated from the document
rather than trusted: a rail that starts off with nothing to switch it on, and a toggle set to ON against a
rail that was already grindable, each warn on the rail that has the problem (docs/026).

## A rail without a pipe

**The grind and the pipe are two unrelated records on disc.** The spline is a 40-byte `.pbd` record plus a
style row in the `.ssf`, carrying no reference to any model; the tube beside it is an ordinary prop instance
pointing at something like `Mdl_Rail_Metal`, with its own collision profile ([Trailmap: 350-rails],
[Trailmap: 220-level-pbd]). Nothing joins them. The proof is retail's own `HideShowOff`, which retires a rail
with **two** nodes — a `MainType 25` by spline index *and* a `MainType 7` by instance index; one would do if
the engine knew the pairing. The counts do not pair either: GARI ships 169 grind splines against 98
`Mdl_Rail_Metal` instances.

So Slopesmith separates them too. A rail owns one node chain and normally emits both halves, but **`bare`**
drops the tube and ships the curve alone. That is the shape every original rail actually has: a grind laid
along art that was going to be there anyway — a fallen trunk, a handrail model, the lip of a roof.

- **Add rail pipe** (Props ▸ Prop Tools) draws both at once, which is the convenience.
- **Add rail spline** (Effects ▸ Effect scenery) draws the curve alone, over a prop already placed.
- **build pipe** in the Tricks tools moves an existing rail between the two.

Those are two controls, **material** and **build pipe**, because they answer two independent questions. The
material is the **grind surface** — the native `SplineStyle` that decides how the board sounds and slides
(`ride/board-audio`, `ride/physics` `surfaceFor`) — and it means as much on a curve with no pipe as on one
with. So "wood" plus "no pipe" is not the contradiction it first looks like: that pair is a log rail.

The surfaces are genuinely different rails to ride, so the Effects rail panel exposes **Material** and
**Speed** as separate read-only properties for authored and reference rails. Material comes from the rail's
retained `SplineStyle`; Speed is that surface row's cruise target, read from `RIDE_SURFACE_ROWS` so it cannot
drift from the table the test ride uses. Authored rails also report their pipe/bare **Shape** separately:

| `SplineStyle` | Surface row | Settles near | Drag |
| --- | --- | --- | --- |
| 13 metal | `off-track metal` | 16.9 m/s | 0.10 |
| 12 wood | `no sound` | 15.1 m/s | 0.89 |
| 5 named retail IceRail | `ice` | 17.8 m/s | 0.00 |

Ice is the fastest and slipperiest of the three; metal is close behind; wood is draggy and — going by the
row's own name — silent. Worth knowing before picking one for looks.

A bare rail is an ordinary grind rail in every other respect: same `(1, 1)` spline row, same material
`SplineStyle`, same `startsOff` behaviour, same test ride. `railHasTube(rail)` is what every consumer asks
instead of testing the kind, since the kind is no longer the whole answer — `bakeRailTubes` skips it,
`sweepRail` is never called on it, and its `solid` / `supports` options fall away with the tube they configure.

The surface-coloured centreline belongs to **Effects mode**, for a bare rail exactly as for a piped one and exactly as
for the reference level's own curves — that is the mode which binds toggles and movers to curves, and a
mountain wearing its whole grind network in every mode is clutter. The one exception is the **selected** rail,
which draws its curve in any mode: it is the thing the author picked rather than scenery, and for a bare rail
the curve is all there would be to see of it. (The Effects *palette* still follows the mode, so a rail
selected in Props view keeps its amber node bulbs.)

The consequence to know about: a bare rail is **not pickable in Props view**, because there is nothing of it
drawn there to click. Reach it from Effects mode — clicking its curve, then **Edit in Props view** on the rail
panel, which lands in the Tricks tools with the rail selected. And because it has no geometry in Props mode to
send an author to, Effects mode keeps the whole curve — points, height, deletion — for a bare rail, where a
piped rail is inspect-only there (docs/026).

The curve is coloured by ridden surface — **metal red, wood yellow, ice blue** — and drawn as a **fat line**
(`LineMaterial`, 2 px; 3.5 px and brighter within the same hue when selected) because
`LineBasicMaterial` is stuck at one pixel whatever its `linewidth` says, and a one-pixel thread across a whole
mountain is not findable. It rides the **Tricks view filter** like the rest of the trick layer. A loaded
reference draws its own `Splines.json` grind rows the same way (docs/026) — for a shipped level that curve is
the only place the rail exists at all.

Unlike the purple motion path, the guide **depth-tests**: a mountain's worth of grind curves showing through
the terrain is clutter, not information, so a rail behind a ridge sits behind the ridge. A generated pipe's
guide draws on its **crest** (`RAIL_PIPE_GUIDE_LIFT` = `RAIL_TUBE_RADIUS`) rather than down the centreline where
it would be buried inside its own mesh. A bare rail has no generated tube to clear and therefore draws at its
true authored contact line. The reference overlay likewise draws extracted splines without a lift: retail
already authored the rider clearance into those coordinates. A camera-ward `polygonOffset` keeps a visible
guide from z-fighting while real terrain in front still occludes it.

## Motion paths

Effects such as subway trains and gondolas need a native spline without creating a rideable or visible rail.
The Effects home panel therefore places a dedicated **motion path** beside **Add fog volume**. It uses the
same point-chain drawing, node dragging, name, height, and stable-ID machinery as grind rails, but appears as
a purple guide only in Effects mode. It does not enter the editor/Unity grind network, bake a tube or support
geometry into `Props.obj`, or appear under the Props-mode Tricks filter.

This distinction also matches the native data instead of inventing an editor-only convention: retail mover
routes use the SSF spline row `U0=-1, U1=-2, SplineStyle=-1`; grind rails use `1, 1, style 12/13`. A Spline
mover node keeps a stable `spline:path:*` resource in `Effects.json`, and ISO packing resolves that resource
to the compact `Splines.json` index written into the node's native `SplineIndex`.

## Core spline (`core/rails/rails.ts`)

Two forms of the one curve, both derived from the nodes so what you see is what ships:

- **`railBezierSegments(nodes)`** — the curve as a chain of **cubic Béziers**, one per span between
  consecutive nodes, four control points each. Uses the standard uniform CR→Bézier tangents (neighbour
  difference / 6) with the endpoints clamped (`P[-1]=P[0]`, `P[n]=P[n-1]`) — the same clamping `sampleSpine`
  does, so a rail matches the run spine. This is the form `Splines.json` stores.
- **`sampleRail(nodes, perSeg)`** — the curve sampled to a polyline for the viewport preview, both ends
  anchored on the node chain.

`RAIL_STYLE_METAL` (13) / `RAIL_STYLE_WOOD` (12) and `railStyle(rail)` (default metal) name the grind styles;
`RAIL_STYLE_OFF` (1) is retail's non-grind style for a rail an effect switches in, and `railStartsOff(rail)`
answers whether this rail is one. `nativeSplineFields(rail)` chooses between the proven grind row, that
switched-off variant of it, and the retail motion-route row at export. `railHasTube(rail)` answers whether
there is any geometry to draw or bake — false for a motion path and for a bare rail — and `isBareRail(rail)`
picks out the second of those.

## Export (`core/export/level.ts`)

`buildMountainLevel` writes `Splines.json` whenever the doc carries complete course splines.
`buildSplinesJson(rails)` turns each rail or motion path's `railBezierSegments` into the `SplineJsonHandler` shape —
`{ Splines: [{ SplineName, U0, U1, SplineStyle, Segments: [{ Points: [[x,y,z]×4] }] }] }` — with every control
point `toRaw`'d into the same raw SSX space (cm, Z-up, X-mirrored) the patches and props use. A spline with
fewer than two nodes emits no segments and is dropped, so a half-drawn path never ships a broken spline.

On the import side `snowknife`'s `PathBundle` reads `Splines.json`, promotes every style-13 / -12 spline to a
grind rail, and samples each cubic segment into the ridable polyline + keeps the analytic cubics — so the board
grinds the exact curve the editor drew (see the repo's docs/026-rail-grinding). Style -1 motion paths remain
available to the spline-mover effect bundle but are deliberately excluded from that ridable network.

## Rail placement (`app/viewport/viewport.ts` + `app/main.ts`)

Rails live in **Props mode** alongside props and free lights (all "things you drop on the course"). The
top-bar **Rail** tool arms drawing: it starts a fresh rail and, on each terrain click, appends a node — the
ground hit, floated by the rail's `height` (`onAppendRailNode`). **Enter** or **Esc** finishes the rail (a
rail left under two nodes is discarded).

- **`viewport.setRails(rails, selRail, selNode)`** builds the rail's **swept tube** (`core/rails/rail-mesh.ts`,
  below) under `railGroup` in data coords — so rails ride the game-chirality flip with the terrain. Metal
  rails wear the **native red/white skin** once `ensureTrickArt` resolves it (below); wood keeps its flat
  tint. Node **pick bulbs** draw only for the selected rail, so idle courses stay uncluttered.
- **Picking** — while drawing, a terrain click only appends (the flow stays a straight chain). Otherwise a
  click resolves nearest-under-cursor among placed props / reference props / free-light bulbs / **rail node
  bulbs** / **rail tubes** / ground: a node bulb selects that node; a hit on a tube grabs the node nearest the
  click. A selected node gets the translate gizmo (`gizmoKind` `'railnode'`, `onMoveRailNode`) on a scene-root
  handle, the same pattern as a placed prop / free light.
- **Selected look** — the selected rail's tube and posts wear the **same amber edge outline** a selected prop
  does (`propOutlineMat`, feature edges at 30°), on top of the brighter surface-coloured curve and the node bulbs. The
  curve and the bulbs are both thin by nature, and a rail's nodes can sit off-screen on a long one, so on a
  pipe the size of the thing just clicked neither answered "this one"; the outline is the tell that scales
  with the geometry, and it is already the editor's word for "the object you picked". A **bare** rail has no
  geometry to outline, so there the brighter curve remains the whole answer.

### Rails in the shade views

The tube and its support posts are the one part of a rail that is real geometry — the same sweep that bakes
into `Props.obj` — so they follow the top bar's shade view exactly as the props they ship beside do
(`applyPropShade`, docs/012): the native skin in **Textured**, neutral clay in **Surface**, the hidden-line
triangle wires in **Wireframe**. Left out of it, an authored rail was the one solid a wireframe view could not
see through. The **guide curve and the node bulbs are markers about the rail rather than the rail**, so no
shade view touches them — they keep their own colours, like the terrain's overlays.

Surface colours a rail by its **contact class**, off the same `propContactTint` table the props use: a default
tube is a **ghost** (riders pass through it; the grind is the spline's job either way) and reads ride-through,
`Rail.solid` gives it a collision model and reads as an obstacle, and the support posts read as obstacles
always, since they pack solid whatever the tube does. The tube is never itself a ride surface, so it takes the
obstacle colour rather than a SurfaceType's.
- **Tools** (`buildRailTools`) — while drawing, a hint + **finish**; once a node is selected, the rail's
  **height** (re-floats every node by the delta, so the rail keeps its shape as it moves up / down the slope),
  **material** (metal / wood / ice), **rail pipe**, **starts off**, **add more points**, **delete this point**, and
  **delete rail**. Unticking **rail pipe** takes the tube away and with it the **solid tube** / **support
  posts** options, which configure geometry that is no longer there.
  A rail some effect names says so here as a count, because nothing about the rail itself would: moving or
  deleting one that a toggle points at is otherwise silent until the export refuses the node.

Rails are part of the doc, so they persist through save / load / undo (raw passthrough in `migrateMountain`)
with no extra plumbing, and they need no server round-trip (unlike props, which fetch model geometry).

## The rail's visual tube (`core/rails/rail-mesh.ts`)

The spline is the *grind*; the **tube is the decoration along it** — and the shipped art shows exactly what
that decoration is. Every original rail is a **bespoke swept chunk**: a 3–5 sided low-poly n-gon tube whose
rings follow the spline (the reference `Mdl_Rail_Metal_*`: cross-section ~30–50 raw units, one model per chunk, each
placed exactly once with **identity rotation/scale** — the curve is baked into the verts), skinned with
`0077.png`, a 128×128 half-red/half-white tile. The shipped UV wiring (read off `148.obj`): **u wraps the
ring**, and every ring's verts share one **v that ping-pongs 0, 1, 0, 1 ring-to-ring** — each ring interval
sweeps across the red/white split, so the tube reads as **alternating candy bands** down its length, one
band pair per ring interval (~1.5–2.5 m). There is **no reusable kit piece** (only the support posts are
instanced), so a faithful custom rail is the same sweep + wiring generated along the authored curve.

`sweepRail(rail)` does that sweep ONCE for both consumers, so the tube you see is the tube that ships:
the curve resampled to the shipped **ring cadence** (`RAIL_RING_SPACING` 2.2 m — which is also the band-pair
length, independent of how far apart the authored nodes sit), pentagonal rings (radius 0.2 m — the shipped
~15–25 raw units) with **parallel-transported** frames (no twist through bends), seam vertex duplicated so u
wraps a clean 0..1, v ping-ponging exactly like the originals.

- **Viewport** — `buildRailObject` turns the sweep into a `BufferGeometry`; `setRailSkin` (fed by
  `ensureTrickArt`, which resolves the texture off the shipped rail models' own `MeshData` → `MaterialID` →
  `TexturePath`, no filename guess) supplies the textured material.
- **Export** — `buildRailTubes` (`server/routes/props.ts`) emits the same sweep as `o Rail_<i>_<name>` groups
  appended to `Props.obj`, verts `toRaw`'d, `usemtl` through the shared **MaterialCombiner** (docs/012's
  combined `Materials.json` + verbatim texture copy — the red/white tile lands as `p_<level>_0077.png`). It
  rides the standard authored-props path into `props.glb`, textured in Unity with **no collider** — matching
  the originals (`PlayerCollision: false`; grinding is the spline network's job). Wood-style rails emit
  untextured (clay), like the start gate.

### Rail options: solid tube + support posts

Two per-rail checkboxes in the Tools panel (`Rail.solid` / `Rail.supports`, both default off):

- **solid tube** — the tube bakes as `o RailSolid_<i>_<name>` instead of `Rail_<i>_<name>`, and the ISO
  repack gives that group its own mesh as a collision model, so riders bump the tube while the grind rides
  the spline as usual. This is the shipped split: some reference tubes carry full-size mesh colliders and
  still grind; others have none ([Trailmap: 350-tubeprops]). Off matches the ghost-tube default.
- **support posts** — one slim untextured post under each node point
  (`railSupportPosts`, `core/rails/rail-mesh.ts`): from the tube's underside down through the authored standoff
  (`rail.height`, already baked into every node's Y — no terrain sampler) plus a small sink, so the post
  meets the ground the node was laid on. Posts bake as `o RailSupport_<i>_<name>` and pack **always solid**,
  like the shipped levels' rail supports. The same geometry draws in the viewport (grey), so the posts you
  see are the posts that ship. Rails floating under ~0.15 m bake no posts.

## Gems

Gems are the collectible half of the trick layer — the trick-score multipliers a rider strings between rails
and over kickers. The **Gem** tool places them: **click** drops one gem, **drag** lays a **spaced row** between
the two ground points (the natural way gems come — a string down a rail or over a jump). Gems store on
`MountainDoc.gems: Gem[]` (`{ pos, value? }`) in the same editor/data space as the rails, with the float height
baked into `pos.y`.

- **`viewport.setGems(gems, selIdx)`** builds a spinning marker per gem under `gemGroup` (data coords, so
  they ride the chirality flip) — the **native tiered crystal** (`Gem_TrickMultiplier_YellowX2 / OrangeX3 /
  RedX5`: the SAME star mesh at scales 1.0 / 0.857 / 0.714 with flat colour tiles), so the editor shows the
  exact model the ISO packer clones. `ensureTrickArt` (`app/main.ts`) resolves the three tier models off the
  donor level by `ModelName` and hands them to `viewport.setGemModels`; until that geometry lands, a
  **tier-tinted octahedron** stands in. The top-bar **Effects** toggle turns them with the cloned retail
  template's recovered `AnimObject` law (45 clip frames/second over its 60-frame full-turn curve); the selected
  gem is emissive-brightened + larger. `gemTier(value)` buckets a Value exactly like the ISO packer
  (≤2 yellow, ≤4 orange, else red), so preview and disc always agree.
- **Placement** — on mouse, a press begins a drag-aware gesture (`gemPointerDown/Move/Up`): a translucent
  **ghost of the pending tier's crystal** rides the cursor at the drop height (spinning, like the prop
  ghost), a faint preview line tracks a drag, and release drops one gem (barely moved) or a row spaced by
  the Gem tool's `spacing` (`onPlaceGem` / `onPlaceGemLine`). On touch, a tap drops one (`pickOrPlaceProp`).
  Clicking a gem selects it — the translate gizmo (`gizmoKind` `'gem'`) moves it, Del removes it.
- **Tools** (`buildGemTools`) — with a gem selected, its **tier** (×2 yellow / ×3 orange / ×5 red — the three
  crystals that exist in the game); otherwise the placement defaults: float **height**, drag-row **spacing**,
  and the **tier** new gems drop as. The tier drives the crystal you see AND the exported `Value`, so what
  you pick is what Unity imports and the ISO clones.

Gems are doc data, so they persist through save / load / undo like the rails.

### Gem export

Gems export as their own authored channel — distinct from the EXTRACTED gems snowknife derives from a level's
SSF (a MainType-14 pickup effect → spinner `DivertInfo`):

- **Slopesmith** (`core/export/level.ts`) writes `Gems.json` when the doc carries gems: `{ Gems: [{ Position:
  toRaw(pos), Value }] }` (raw SSX space, like the patches / splines). The export also writes
  **`GemModels.obj`** (`buildGemModels`, `server/routes/props.ts`): the donor's three tier crystals as one
  `o GemTier<2|3|5>` group each, verts passed through **untransformed** (already model-local raw), materials
  through the shared MaterialCombiner (the flat colour tiles copy as `p_<level>_0078/79/80.png`) — so the course
  dir carries its own gem art and snowknife stays donor-free.
- **Bundle** (`Snowknife/Bundle/GemBundle.cs`) reads `Gems.json` into `manifest.Gems` (`{ Center: mesh-space,
  Value }`) and bakes `GemModels.obj` into **`gems.glb`** (`BuildGeometry`: same OBJ conventions as Props.obj
  — X negated, vt V-flipped, outward normals — one node per tier, kept OUT of props.glb so each gem
  instantiates individually), recording the tier → node map in `manifest.Gems.TierNodes`.
- **Importer** (`GemBuilder`) instantiates the **native tier crystal** per gem under a `Gems` root
  (`LoadTierMeshes`: gems.glb node → shared Mesh + `MaterialFactory` materials per tier, picked by the same
  ≤2/≤4/else Value bucketing as the ISO packer; a course without gem art falls back to a synthesized
  octahedron) and reuses the **same runtime as the extracted gems**: each gem gets a collectible trigger
  (sphere sized off the crystal's own bounds) + `GemMarker` (Multiplier = Value), and one shared
  `SpinnerMarker` revolves them all — so the platform wiring realizes pop / chime / grow-back / spin with
  no new behaviour.

*Verified:* a course exported with 7 gems (values 1 and 5) bakes `Gems.json` → the bundle logs `Gems: 7
authored pickups`, and `manifest.Gems` carries all 7 with positions matching `MeshPt(raw)` to float32 and exact
values. The importer builder is Unity-side (compiles in the editor, not headless).

**The ISO** carries gems by an **instance-section injection** — built in `repack` (`AppendAuthoredGems` +
`SurgicalPatchSwap` `swapInstances`). For each `Gems.json` entry it clones a **tier-matched shipped gem
instance** as a template (inheriting its gem model — `Gem_TrickMultiplier_YellowX2/OrangeX3/RedX5`, ids 269–271
— its `EffectSlotIndex` → the SSF **MainType-14** pickup effect, and `LTGState == 2`), moves it to the authored
raw position, and appends it to the cloned `Instances.json`. Growing the instance section forces the `.ssf`'s
per-instance `ObjectProperties`/`InstanceState` to grow with it, so gems trigger a **full `.ssf` regen**
(`SSFGenerate`) — which also rebuilds the spline-style table from `Splines.json` (so any authored rails become
grindable too, closing the rail SSF gap). The surgical swap lifts the instance section (count@0x0C /
offset@0x48) into the hybrid pbd, the regenerated `.ssf` is swapped into the members, and the `.ltg` regen lists
the gems in its `GemIndex` off `LTGState 2` — for free.

*State:* built + compiles; the last runnable build confirmed the gem append + SSF regen run
(`authored gems: N instance(s) appended`). The final count-validation + ISO production is pending a rebuild of
`snowknife` in a shell that re-applies the WDAC managed-installer tag (agent rebuilds hit `0x800711C7`), then
`snowknife repack <iso> <MAP> Maps/<MAP> <customDir-with-Gems.json> <out.iso>`.

## The Tricks layer: one tool, one filter

Rails and gems are surfaced as one **Tricks** concept with two faces (`app/main.ts`):

- **Author** — a top-bar **Tricks** cluster holds the **Rail** and **Gem** tools; picking either enters Props
  mode with that tool armed and the Tools panel showing that tool's controls (`buildTrickTools`), ending in
  **◀ cancel** — the way back to the launcher, which the rail tool hides while it is held. The panel is routed
  off what is in hand (a rail selected or being drawn, a gem selected or the gem tool armed) rather than off
  `trickTool`, which outlives the object it named: deleting the last rail hands the launcher back instead of
  leaving an empty panel. `trickTool` remains only as the Add buttons' pressed lamp.

  There is **no Rail | Gem chooser** in the panel. Add rail pipe and Add gem are the way into each tool, so a
  second chooser offered a route the author had already taken — and one that could disagree with what they had
  selected.
- **Filter** — a **Tricks** star toggle (`tricksVisible`, persisted in `StoredUi`) shows / hides the whole
  trick layer — rails **and** gems — as a unit (`viewport.showTricks` gates `railGroup` + `gemGroup`). Declutter
  to read the racing line, or flip it on to focus on trick flow. It extends naturally to imported trick objects
  later (boost pads, show-off ramps, kickers).

## Verified

A doc with a 4-node metal rail + a 2-node wood rail exports two splines: style 13 with three C0-continuous
cubic segments and style 12 with one, control points matching `railBezierSegments · toRaw`, first/last control
points anchored on the node chain, both grindable styles `PathBundle` promotes. A single-node rail exports no
`Splines.json`. A doc round-trips through save / load with its rails **and gems** intact; the gem-row math
spaces `round(len/spacing)+1` gems endpoint-to-endpoint, floated by the tool height. `tsc` + `vite build` clean.

The native-art pipeline was verified end-to-end (by a throwaway script under the gitignored `temp/`, not
distributed): a mountain with one rail + three
gem tiers exports a `Props.obj` rail-tube group bound to the red/white tile (`mat_0 → p_<level>_0077.png`),
`GemModels.obj` with all three `GemTier` groups and their colour tiles copied, and `snowknife gltf` produces
`gems.glb` whose `GemTier2/3/5` nodes carry exactly the shipped crystals' 230 unique verts — the tier meshes'
bounds match the reference's own extracted gem diverts to the centimetre. Browser-checked: the gem ghost + placed
crystals render native per tier (yellow/orange/red, authentic size gradient, spinning), the tier picker drives
both, and a drawn rail previews as the red/white swept tube. The importer compiles clean in the Unity editor.

## Next

- **Gem ISO validation** — the instance-section injection (above) is built; produce + boot an ISO with
  authored gems and count them in-game (the *State* note's WDAC rebuild caveat applies).
- **Ride / play-test** end-to-end — rails through `snowknife gltf` → the board's grind, and gems through the
  importer → collect + spin. The bundle data + export are verified offline; the in-engine feel isn't yet.
- **Rail visuals on the ISO** — authored rails grind on PS2 (splines inject) but ship no tube geometry; the
  sweep would need a NEW model + mesh section grown into the pbd, a heavier surgery than the instance append
  the gems use.
- **Rail support posts** — the one instanced kit piece in the shipped art (`Gem_RailSupport_1000`, a ~10 m
  post placed 78–116× per level); stamping them under authored rails would ground the tube visually.
- **Per-node rail height** — a node can already be dragged vertically; a per-node standoff (vs the one rail
  height) would let a rail dip and rise along a feature without hand-dragging each point.
- **Snap** a rail's first/last node — or a gem row — to a run knot or a kicker lip, so the trick layer lines up
  with the line the course already draws.
