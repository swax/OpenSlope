# 028 — Tiled props (authored models)

> **Vocabulary.** What a person sees in the editor is a **tiled prop**: one tile, mapping computed per quad,
> editable with the mesh tools. Its counterpart is a **textured prop** — its own UV layout across however many
> materials — which is what an imported GLB (docs/032) and a shipped level's own props both are.
>
> The line is drawn on *are the UVs computed or authored*, not on where the geometry came from, because that
> is the only property that predicts anything: a computed mapping survives reshaping, an authored one does
> not. Provenance is a clause at the end of the line ("from MEGAPLE"), not an identity. `describeProp`
> (`core/props/kind.ts`) is the single source of those words; the selection panel, the prop library and the
> Blender add-on all read from it. In code the record is still `AuthoredModel`, because there the
> definition/instance split needs its own noun.

Polygon models built with the mesh tools and placed as props — the definition/instance split over the
same editor that sculpts the terrain. A model is its own grouped geometry, never part of the mountain
net; its placements are ordinary props, so effects (docs/026), the viewport, and the export treat them
exactly like borrowed reference props. The motivating case is the river: a ribbon of flat quads wearing
`GARI/0106.png` with a *Persistent · UV scroll* + *Collision · Reset zone* pair — the retail
`Mdl_Water_River` anatomy, authored from scratch.

Code: `src/core/doc/models.ts` (the container + bakes), `src/app/edit/mesh-target.ts` (the edit-stack
routing seam), `linearCage` evaluation in `src/core/mesh/topology.ts` (`linearEdgeHandles`,
`bilinearTwist`) / `src/core/doc/mountain.ts` / `src/core/mesh/tessellation.ts`,
`buildAuthoredModelProps` + `resolveTileSlot` in `src/server/routes/props.ts`.

## The flat cage is derived, never stored

A model's mesh is a `QuadMeshDoc` evaluated with `linearCage`: every edge handle derives as chord/3 and
the interior twist derives as the **bilinear** offsets `[T,−T,−T,T]/9`, `T = A−B−C+D` — together they
degree-elevate each quad to the exact doubly-ruled surface of its corners. (Zero twist alone is NOT flat
on a non-planar quad: the bilinear's mixed partial is `T ≠ 0` off a parallelogram — the regression test
asserts exactness to 1e-9.) No curvature channel is ever persisted: anything an op writes (a split's
inherited crease, a slide re-cut's twist) is dropped at commit, and under the linear derivation the same
flat shape reproduces — the model self-heals to polygons. Bakes ship two triangles per quad (a wedge one).

## Editing (Edit mode)

- **＋ create model** in the create toolbox: name it and the panel becomes **Editing \<model\>**. The
  mountain keeps rendering exactly as it normally does (tiles, tint and sun through a second terrain
  layer) as a read-only context surface — patch/tube endpoint clicks land on it, but its points and
  patches are not editable — so a model is built fitted against the real terrain; use Hide if it is in
  the way. All mesh tools
  (create edge/patch/tube, loop cut, slide, weld, delete, clipboard) route at the model's mesh through
  the one `editMesh`/`commitEditMesh` seam. The curvature tools — the control-cage pin (G), crease/smooth
  (C/S), and reset shape — are mountain-only: a model's flat cage derives every handle, so there is no
  curvature to expose or edit (`canEditCurvature` in the edit session).
- The banner carries the **name**, the **tiled prop** kind row, the **texture** swatch and its **tile turn**
  controls, **deselect**, and **🔒 lock** (pin the session —
  while locked, clicks off the model stay in it and the button becomes **✔ done editing**, the way out).
  The empty-selection toolbox splits creation into **Create Terrain** (edge / tube / patch) and **Create
  Prop** (model) panels; inside a session the geometry tools retitle to **Add to Model** — they grow the
  model, never the mountain. There is no save/commit gate: edits are the document — undo/redo,
  persistence and `.slope` save cover models with no extra machinery.
- The first exit from a built model seats its HOME placement at the anchor (the geometry's base
  centre), so what you authored stays in the world as a prop with a stable id effects can target. An
  EMPTY model (no geometry, no placements) is deleted on exit — nothing of it would exist to click
  back into.
- Clicking a placed prop in Edit mode SELECTS it — the same amber box + move gizmo Props mode shows, so
  a placement moves without leaving Edit; any mesh pick or a plain click off (the mountain backdrop or
  empty space) drops the selection. A selected MODEL placement enters its edit session on a second
  click (or **✎ edit model**, in Edit or Props mode) — the session opens AT that placement:
  `rebaseModelToPlacement` bakes its pose into the definition's stored frame and re-derives every other
  placement's rotation/scale (poses compose closed under translate·rotate·uniform-scale, so nothing
  rendered moves — regression-tested with tilt, where the absorbed rotation has to right-multiply rather
  than subtract an angle; attached emitter offsets re-frame the same way). Only the picked placement
  hides behind the substrate; the model's other placements stay visible and update live as the shared
  definition changes. From inside a session a plain click off returns to terrain editing (unless
  locked; armed modal tools keep their own click meanings). Leaving Edit mode ends the session. Esc
  mirrors the clicks in layers: clear the selection, then give up the lock, then leave the session.
- **⧉ revise prop (v2)**, directly under **＋ place prop** on a selected placement (the Edit banner or the
  Props panel), means one thing whatever is selected: **put a copy of this prop in your library as
  `<name> v2` and point THIS placement at it.** Other placements keep the original. The placement is
  MUTATED rather than replaced, so it keeps its `id` and every effect attached to it comes with it.
  Group props can't be revised yet.

  What differs is only which library the copy can land in:

  | selected | copy lands as | and then |
  |---|---|---|
  | a tiled prop | a tiled prop — the definition duplicates | its edit session opens |
  | anything else (a reference prop, an imported one) | a **textured** prop | edit it in Blender ([046](046-blender-bridge.md)) |

  The second row used to bake into a tiled cage and arrive as grey clay, because a tiled prop computes its
  mapping as the full 0–1 rect per quad and no shipped prop has a mapping like that — measured on GARI's
  river, a segment spans its tile exactly ONCE across two quads, split at `0.532` where the bend falls, so
  the tiled rule would show the texture twice. `recordFromReferenceProp` (`core/props/adopt.ts`) lands it
  in the textured lane instead, where every channel has somewhere to go: it is a **re-pack, not a
  conversion**. Both sides already store model-local raw cm with raw OBJ `vt`, so not one coordinate, UV or
  index changes; only the material ids are renumbered to a record's local 0…n−1 and their texture refs
  qualified to the level they came from (`0106.png` → `GARI/0106.png`). Flipbook frames, the alpha-blend
  flag and any declared motion carry. Nothing moves and nothing greys out.

  The **art is copied too**, into your Custom bank, because a ref into an extracted level's read-only bank
  is paint you cannot change and revise is supposed to hand you a prop you own outright. One atlas page
  shared by a dozen props still costs one tile. Details in [032](032-imported-props.md).

  `reviseModelFromProp` — the old triangles-to-wedge-quads bake — remains in `core/doc/models.ts` as the
  exact inverse of `authoredModelLevelProps`, which is the property its regression test pins; it is simply
  no longer what the button does.

A model can also leave the editor entirely and come back. **⬈ edit in Blender** sits in the session's Model
actions — beside deselect and lock, because that is where the mesh tools running out is discovered — and the
same action is on the library tile's right-click menu. It pulls the cage into Blender AS QUADS, and a push
returns it to this same definition, so every placement follows and the corner order the derived UVs are read
off survives the trip ([046](046-blender-bridge.md)). Curvature is not carried, which costs nothing here: a
model's flat cage derives every handle anyway.

## Texture — the scroll-safe form

A model wears ONE tile (`texture: "LEVEL/NNNN.png"`, the terrain `quadTex` ref convention). Every quad
maps the full 0–1 tile — A(0,0) B(1,0) C(0,1) D(1,1), V down the A→C spine — so UVs wrap continuously
across quads under `RepeatWrapping`. That is deliberately NOT the terrain's inset-tile scheme: a
UV-scroll material can never cross an inset or atlas seam (docs/008), and full-rect per-quad UVs are
what lets a river flow unbroken down the strip. Untextured models render the neutral clay.

The session banner names the thing you are editing in the shared vocabulary — **tiled prop · 6 quads · one
tile**, from `describeProp` (`core/props/kind.ts`), with the "what's the deal" note on hover. The mesh tools
are open on this prop *because* it is tiled, so the session says so rather than leaving it to be inferred from
the texture field being one swatch.

It shows that tile as a **swatch**: clicking it raises the Texture Library at the bottom in
pick mode (docs/005), where the choice is made off the art — every level's bank, the user's own **Custom**
tiles, and a **∅ no texture** cell that returns the model to clay. Picking commits, so it undoes.

**Turning the tile.** A model wears its tile at one **D4 orientation** (`orient: { rot, mirror }`, absent =
upright) — quarter turns plus a mirror, the same state a painted terrain quad stores. ONE state for the whole
prop, not one per quad: the mapping is computed, and a prop whose quads each carried their own would be
storing a UV layout, which is what makes a prop *textured* instead. The banner states it (**tile turn · 90°
⇋**), draws the swatch at it, and offers **↻ / ↺ turn tile** and **⇋ mirror tile**; ← / → (⇧ to mirror) do the
same from the keyboard, the one gesture Paint uses for a brush, a Palette cell and a placed tile (docs/005).
The step is the shared `turnD4`, so → turns a prop's tile the same way on screen as it turns the mountain's.

Three places derive the mapping and all three take the orientation through the one `tiledPropUV`: the
viewport bake (`authoredModelLevelProps`), the export bake (`bakeAuthoredModelProps`), and the edit
substrate, which gets it as a per-quad `quadOrient` derived at materialize time — so the session previews
what its placements render, and the tile-orientation F overlay reads it like any painted cell. A turn that
reached only two of the three would be invisible until an ISO was built, which is what
`test/tiled-prop-turn.test.ts` pins.

## Placements and the pipeline

Placements live under the **Custom** entry of the prop library's level dropdown (the synthetic
`@models` level, which also lists imported GLB props — docs/032). `authoredModelLevelProps` bakes the
definitions into the same `LevelProps` shape an
extracted level decodes to — raw cm, Z-up, anchor-local — so the grid, thumbnails, arming ghost,
seating offsets and instance rendering all run through the existing prop pipeline; `syncLiveModels`
re-registers by replacement (content-signature-skipped) every rebuild, which is what makes definition
edits propagate to instances live. During a model's edit session the placement it opened AT hides — the
edit substrate stands in its place — while the model's other placements stay visible, re-rendering live
as the definition changes.

**Export** (`buildAuthoredModelProps`): each placement bakes into `Props.obj` as `o Model_<i>_<name>`
at its pose, with the tile resolved through the combiner's tile slot — inheriting the source level's
`UnknownInt18` alpha-blend flag, which is authored data, not pixel-derivable — and a placement carrying
a UV-scroll attachment emits the `mat_<slot>_scr<k>` tag beside the deduped `Scroll.json`, the exact
dialect the bundle already resolves for retail river segments. The bake also reports the placement's
group name into `Effects.json` `extensions.slopesmith.bakedGroups`, the join `repack` compiles an
effect attachment through (docs/026 · ISO compile). A placement with the **solid** toggle on bakes as
`o ModelSolid_<i>_<name>` instead, which the canonical TypeScript exporter ships with a collision
model; the default is ghost geometry (the river wants exactly that — its stop is the Collision · Reset
zone effect, as in retail). Imported GLBs bake through the same toggle under their own `Import_` /
`ImportSolid_` prefixes (docs/032).

Authored-model placements are lit by the same authored-sun per-instance lighting imported props get — ambient
+ one directional key, with cast shadow and AO resolved at each placement's position (docs/032 · lighting).
Before that they inherited whichever donor instance the packer cloned, so the sun panel had no effect on them.

**Orientation is authored data — and normals, not sides, are the variable.** How the game handles thin
props (fences, leaves, banners): a **single sheet, no duplicate faces**. Object lighting is computed
per-vertex from the authored normal (ambient + clamped directional keys) and the GS neither
backface-culls nor re-lights per side — the back of a fence shows *exactly the same Gouraud shading as
its front*. "Lit on both sides" is really "lit once, shown from both sides"; the Unity port matches (the
level shader is `Cull Off`), and so does the double-sided viewport. Census over all 648 GARI models
(225k triangles): reversed-twin faces exist only in the MediaTower family (62/2083), where roughly a
third carry *different UVs* — retail doubles faces only to un-mirror readable art on a panel's back,
never for lighting. The consequence that matters for authoring: normals facing away from the key light
mean **ambient-only dark from every view** (the lava lesson — a quad's front is `∂u×∂v`, the side the
bake winds toward).

**The orientation instrument is the selection's facing arrows, riding the F toggle.** With the top bar's
**Orientation (F)** button on — the same switch that draws the tile/patch orientation Fs — selecting a
prop draws green face-normal arrows over it (`facing-arrows.ts`; green matching the F-overlay's
patch-orientation reading), sampled per face (capped so a leafy tree stays legible), sized to the model,
drawn through the instance transform so they show the true data-space front the game lights from. They
work on every selection kind: a placed authored model, a placed retail prop, and the **reference map's
read-only instance selection** — so the parity loop is direct: click the shipped fence on the reference
level, click your model, match the arrows. Arrows
aiming into the ground = the sheet ships dark; fix it in the edit session — select its patches, **flip**
("ridable side reversed") — and re-export. The export's `FRONT-DOWN` warning is the last-line backstop.

**A shipped model's own stored normals are what that read compares against, not its winding.** Retail art
carries explicit per-vertex normals (`PropSub.normals`) and the GS lights from those; `∂u×∂v` is only the
answer where a model ships none, which is every authored and imported one. The two genuinely disagree in
shipped data: 87 of MEGAPLE's 172 `Fnc_TokyoFence*` models store a normal OPPOSED to their winding,
alternating panel by panel the way mirrored duplicate art does. It costs those fences nothing in game —
they sit edge-on to the key either way, 36–46% of texture-true on both readings — but an instrument that
answered from the winding would point half a fence line backwards and hand that error to any model matched
against it. Both the arrows and the Surface view's darkness tint read the stored normal.

The arrows read one selection at a time; the **Surface view reads the whole mountain at once**. There every
prop drops its art for flat clay (silhouette kept — the tile's alpha still cuts it) and goes magenta in
proportion to how little of the sun's key its faces catch, so a sheet that ships dark is visible without
clicking it (docs/008 · shade view). Like the terrain tint it shares a hue with, the reading is a property
of the surface rather than of the camera, and it holds on both faces of a sheet — which is the honest answer,
since the game lights that sheet once and shows the result from either side.
