# 032 — Imported props (textured props)

> **Vocabulary.** An imported GLB is a **textured prop** — it carries its own UV layout across however many
> materials. So is a shipped level's prop; importing is how one *arrives*, not what it *is*. The other kind is
> a **tiled prop** (docs/028): one tile, mapping computed per quad, and therefore editable with the mesh
> tools. See `describeProp` in `core/props/kind.ts` for the one place those words are defined.

GLB/glTF models loaded into the editor and placed as props — the third way geometry becomes placeable,
beside the models borrowed from an extracted level (docs/012) and the quad cages authored with the mesh
tools (docs/028). Load one with the **＋** tile in the Prop Library view named for the open mountain — or generate one
from a description with the **✨** tile beside it — and it lands in the same grid as the authored models,
arms like any prop, and places with the same click / scroll-turn / ⇧scroll-resize.

Code: `src/core/props/imported.ts` (the level constant, cap, record shape, and the generated-model
rescale), `src/app/props/glb-import.ts` (the conversion), `src/app/props/library.ts` (the ＋ / ✨ tiles and
the merged Custom grid), `src/app/props/prop-gen.ts` (the Generate prop dialog),
`src/core/props/glb-decode.ts` (the headless glTF reader) and `src/server/props/import-glb.ts` (the
headless conversion and texture staging), `src/server/routes/imported-props.ts` (the store),
`buildImportedProps` in `src/server/routes/props.ts` (the bake), `resolvePropTex` in
`src/core/paint/textures.ts`.

## Why it needs almost no new pipeline

`PropSub` already *is* "per-material submesh with real UVs and indexed triangles" — exactly what a glTF
primitive unpacks into. So an imported model decodes into the same `LevelProps` an extracted level does, and
the library grid, thumbnails, arming ghost, seating offsets, selection outlines, multi-select and instance
rendering all run through the existing prop pipeline unchanged. The server even answers in `PropsPayload`,
so the client reuses `decodeProps` verbatim.

A dropped file is parsed **in the tab**, through the `GLTFLoader` already in the bundle for the Play rider
models (docs/030). A file a *script* imports is parsed on the **server**, through `core/props/glb-decode.ts`
— a dependency-free reader of exactly what Blender's exporter emits — because nothing headless can hold a
`canvas` or a `Blob`. The two are separate machinery under one conversion: `server/props/import-glb.ts`
reproduces `app/props/glb-import.ts` step for step, and `test/glb-import.test.ts` holds them to the same
claim `tools/prop-recipes/check.py` makes of the recipe — that a closed prop's stored geometry encloses a
positive raw volume.

This is deliberately *not* routed through `AuthoredModel`. That is a quad cage wearing ONE uniform tile, so
a multi-material triangle mesh cannot round-trip through it — `reviseModelFromProp` says as much ("UVs and
materials do NOT carry"). Keeping `@import` a level of its own also lets the export and its preflight tell
"quad cage I can bake" from "arbitrary triangle soup I cannot" by level string alone.

That symmetry is what **⧉ revise prop** rides on ([028](028-authored-models.md)): revising a *reference* prop
produces a record HERE rather than a cage, because a shipped prop and an imported one are the same shape of
thing. `recordFromReferenceProp` (`core/props/adopt.ts`) is that re-pack — same model-local raw cm, same raw
OBJ `vt`, same indices — with only the material ids localised to 0…n−1 and their refs qualified to the source
level (`0106.png` → `GARI/0106.png`).

**The art comes with it.** A qualified ref resolves, so a copy stopping there *draws* correctly — and cannot
be repainted, because an extracted level's `Textures/` is the reference and is never written. The Texture
Library will not manage that tile, `⟳ replace art` cannot reach it, and a generated texture has nowhere to
land. A copy you can reshape but not retexture is half a copy, from a button called revise. So
`/api/custom-prop-import?adopt=1` — what both revise paths send — runs `adoptRecordArt`
(`server/props/adopt-art.ts`) first: every non-Custom ref is read out of its bank, stored as a Custom tile
named for its source (`GARI_0106`), and the record repointed at it. Frames included.

The reason eager copying is affordable is `saveSharedCustomTexture`: a retail tile is usually an atlas page a
dozen props share, and a name taken by *the same bytes* is not taken, compared on the canonical re-encoding.
Twelve adoptions off one page land **one** tile and twelve refs to it. A bank that cannot be read is not an
error — the ref is left where it was, so the prop still draws against the reference. The flag is opt-in
because the GLB path stages its own art and would only pay for a pass that finds nothing.

A prop that still holds a reference ref — adopted before this, or hand-written — is not stuck: painting its
tile in Blender forks a Custom copy on push ([046](046-blender-bridge.md)).

## Generating a prop (✨)

`props/prop-gen.ts` — describe an object ("a weathered wooden trail sign on a single post", or a preset)
and fal.ai builds a textured GLB of it, which then rides the ordinary import path above: same conversion,
same texture staging into the Custom bank, same record, same replace-by-name contract. Downstream there is
no such thing as a generated prop — only an imported one. Same key, same dialog contract as the texture
and skybox generators (docs/033, docs/025): nothing billed until a button is pressed, nothing stored until
Add, sticky modal.

Two billed steps, checkpointed apart because they are priced ~an order of magnitude apart:

1. **Concept image** — the ordinary text-to-image catalogue paints one studio-shot object view (single
   subject, plain background, three-quarter view — the framing the image-to-3D models are built for).
   Cheap and seconds-long, so you iterate HERE, not on the mesh.
2. **Build 3D** — an image-to-3D model from `FAL_3D_MODELS` (flat per-run prices, so the quote is exact:
   Trellis at $0.02, Hyper3D Rodin at $0.40) turns that view into a textured GLB through `/api/fal-3d`,
   which runs fal's queue API like the panorama pass — these models take minutes. Rodin also carries a
   **Detail** menu — its medium/low/extra-low quality tiers plus the Sketch tier — same flat price, lighter
   mesh; the menu is a catalogue fact (`details`), the proxy rejects a detail the model doesn't offer, and
   Trellis (one level only) simply shows no menu. The result previews **live**: drag the model box to
   orbit the parsed GLB (the dialog twin of the Prop Tools preview card, rendering the glTF scene directly
   since its textures aren't staged until Add), with its tri/vert counts in the caption. Like the other
   fal catalogues the schema differences per vendor (image field name, whether the prompt is read, fixed
   extras) are recorded on the catalogue entry, so the proxy has no per-model special cases and the
   allow-list stays disjoint from the image ones. Hunyuan3D is deliberately absent: it prices in opaque
   "units" and its meshes routinely land past the triangle cap, so both the quote and the import would be
   a gamble.

One thing a picked file doesn't need: a **real size**. A generated mesh arrives normalized to roughly a
unit box — its authored scale means nothing — so the dialog asks for the longest side in metres
(`scaleDraftTo`, uniform, longest-side anchored) instead of importing at the meaningless authored scale
and making the user eyeball ⇧scroll from there. The triangle cap still applies at Add, where the importer
recounts exactly; the dialog's caption warns when a build lands past it (rebuild, or use Trellis, which
simplifies its own meshes hardest).

Both model selectors show their exact fal model licence/status and the provider Terms/API Terms/AUP warning
described in docs/033. **Add to library** embeds one canonical `generation` snapshot in the prop's stored
JSON: the concept-image endpoint that produced the concept actually used, the image-to-3D endpoint that
built the GLB, their reviewed commercial-use status/pages, and the generation time. The same snapshot rides
the extracted material textures' `.generation.json` sidecars. Regenerating a concept does not mislabel an
older built GLB—the provenance is captured when Build succeeds—and neither prompts nor API keys are stored.

## The frame change is a mirror, so the winding reverses with it

glTF is Y-up metres and so is the editor, so conversion is only: flatten the node hierarchy into world
space, then apply the inverse of the raw→editor map every prop stores its vertices in —
`editorFromRaw(x,y,z) = (−x/100, z/100, −y/100)`, so `rawFromEditor(x,y,z) = (−100x, −100z, 100y)`
(`viewport/constants.ts`).

That map is **orientation-reversing**, so each triangle emits as `a, c, b`. Rendering applies the mirror
again on the way out, so an imported model *stands* in the editor exactly as it does in a glTF viewer — but
position round-tripping is not the property that matters. What matters is the **stored** winding, because it
is the only thing a prop's normals come from: `computeVertexNormals` runs over the raw buffer
(`prop-assets.ts`), and the hardware lights each face as `ambient + Σ max(0, N·L)·key` against that normal,
shown identically from both sides (docs/028).

So mirroring positions while leaving indices alone points every face **into** the model. Nothing looks
missing — prop meshes are double-sided, so the geometry still draws — it just draws ambient-only dark from
every view, in the editor's PS2 shading preview and on the ISO alike, with the selection's facing arrows
pointing inward to say so.

The reversal is not special pleading for imports. `authoredModelLevelProps` reverses for the identical
reason ("reversed vs editor CCW — the raw mirror flips it back", `models.ts`), and retail agrees: measured
over shipped props — GARI's boulder set, SNOW's snow blower and its pipe runs — **every one encloses a
positive signed volume in raw space**, the orientation this reversal reproduces. A prop whose raw volume
comes out negative is inside-out, which is a cheap thing to check when a new import reads dark.

The other flip is UV V, and it is unrelated: glTF's V runs top-down, prop UVs are raw OBJ `vt`
(bottom-left origin, loaded with `flipY`), so `v_prop = 1 − v_gltf`.

Scale is taken as authored: 1 glTF unit = 1 metre = 100 raw cm. A model built in centimetres arrives 100×
too large, which is obvious on screen and fixed with ⇧scroll rather than guessed at — the import toast
reports the resulting footprint so the mistake is legible instead of silent. Horizontally the model is
recentred on its own bounding box so a click drops it under the cursor; vertically it is left alone, because
`propBaseOffset` reads the lowest vertex to stand it on the terrain.

## Textures ride with the mountain

Each material's base-colour image is extracted, capped to 512 per edge, and POSTed through the **existing**
`/api/texture-upload` — so it lands in the project's `assets/textures/` exactly like a tile added by hand (docs/005)
and shows up in the Texture Library too. The record then references it as `"Custom/<name>.png"`, the
cross-level ref form `resolvePropTex` resolves for both the viewport materials and the library thumbnails.
No new texture route, no new serving path, and custom-tile export staging and VRAM accounting apply
unchanged the day imported props do bake.

A material with no map but a non-white base colour stages an 8×8 flat tile of that colour, so a
textureless-but-coloured GLB does not flatten to grey clay. A plain white material stages nothing — the
neutral clay already approximates it, and a bank slot is not free.

`resolvePropTex` is shared with `registerPropModels` and `ThumbRenderer`, which previously did not split
level-qualified refs at all. Fixing it in one place also gave authored models textured library thumbnails,
which they had silently been missing.

## Storage and numbering

One JSON record per model under the open project's `assets/props/<stem>.json`, geometry already in the base64 packing the
wire format uses, so serving the catalogue is a remap rather than a re-encode.

Two numbering rules carry the weight:

- **A record file that is taken is stepped past** — `<stem>_2.json`, `<stem>_3.json`
  ([038](038-hosted-sessions.md)) — and every stored record is issued its own number, from a high-water
  mark kept beside that project-local prop catalogue. That pairing is what makes numbers safe: placements persist
  the number, so a number must name the same geometry for as long as its record exists, and a number is never
  reused. The mark is stored rather than derived because a number has to stay spent after its record is
  deleted; a reader takes the larger of the mark and `max(existing) + 1`, so a catalogue written before the
  file existed still allocates above everything it holds.
- **Material ids are LOCAL to each record** (0…n−1) and are rebased onto a running counter when the
  catalogue is assembled, so importing one model can never renumber another's materials.

`@import` **replace**-registers through `syncLiveModels` (the content-signature path authored models use)
rather than the register-once `registerPropModels`, and an import drops the geometry-derived caches keyed on
the numbers it touched — base offsets, local boxes, thumbnails — so the catalogue and the viewport agree
about which mesh each number names.

A record that fails to parse is skipped rather than poisoning the catalogue: one bad import must not cost
the user every other model they have loaded.

## Managing a model (right-click in the Prop Library)

The props answer to the Texture Library's tile menu, and on the same gesture for the same reason: a tile's
ordinary click means *place this*, which is the frequent harmless act, so managing the model takes the
deliberate one. It is offered on the author's own geometry only — the Custom view's two levels — because an
extracted level's models are the reference, not the work.

| | keeps the model number | what follows it |
|---|---|---|
| **Rename** | yes | every placement's name; an imported record's file is renamed to match |
| **Duplicate** | no — mints one | nothing; the copy starts unplaced |
| **Replace geometry** (imported only) | yes | every placement, in every mountain, re-renders against the new mesh |
| **Delete** | spends it | the placements go with the model |

Two of those need saying out loud.

**Edit in Blender** is the same move without the file: the bridge pulls a record's mesh into Blender over HTTP
and a push writes it straight back to the record, keeping the number, the name and the material table
([046](046-blender-bridge.md)). Replace stays the answer for a model rebuilt somewhere the bridge does not
reach.

**Replace geometry** is the escape hatch from "names never overwrite". Re-importing a rebuilt GLB lands
*beside* the original with its own number ([038](038-hosted-sessions.md)), which is right — nothing
placed can change underfoot from a file name collision — but it leaves every placement on the old mesh, and
the author who just fixed a model in Blender wants the opposite. Replace writes the record in place: same
file, same number, same name, new geometry and materials. That is safe here in a way it is not for a texture,
because the catalogue is served as one revalidated payload rather than per-model URLs, so no cache holds a
stale record. Its textures come in through the ordinary upload route, exactly as an import stages them.

**Delete** spends both of the model's identities. The record's file name retires like a tile's, and its
NUMBER retires one step further in — a placement in another mountain, or in this one's undo stack, must never
find someone else's geometry under a number it still holds, and `max(existing) + 1` alone would hand the
newest record's number straight to the next import. On the document side the model's placements go with it:
leaving them would make an invisible object that cannot be clicked and only reappears as an export warning.
That half is one commit, so it is one Ctrl+Z away — the file itself is not.

The server half is four routes beside the import (`/api/custom-prop-rename`, `-clone`, `-replace`,
`-delete`), all at the editor gate. The document half — placements, authored definitions, history — belongs
to the host, so the panel asks for it through `DocModelOps` rather than reaching into the document itself.
An authored model's actions are document edits all the way down; it has no Replace, because its geometry is
changed by editing it.

## The triangle cap

`MAX_IMPORT_TRIS = 50,000`, enforced *before* any upload so a rejected model leaves nothing behind. Grounded
in the retail census from docs/028: all 648 GARI models together are ~225k triangles, so a shipped prop
averages ~350. The cap is ~140× that — generous for GLB content that was never authored to a PS2 budget,
while still refusing the 200k-triangle scans that could never become a prop. The editor viewport would
survive those; the eventual `Props.obj` bake would not.

## A model can declare its own material motion

glTF carries `extras` — free-form JSON — on almost everything it defines, and three.js hands a material's
back as `userData`. An imported model uses that to say how one of its surfaces moves:

```json
{ "OpenSlope_effect": "{\"uvScroll\":{\"mode\":0,\"uPerTick\":-0.0225,\"vPerTick\":0,\"activeDuration\":1,\"pauseDuration\":0,\"lifetime\":0}}" }
```

`importedMaterialScroll` recovers it and `ImportedPropRecord.materials[].scroll` stores it. That is a
**declaration**, not a rendering path: placing the model turns it into a real `UVScroll` node in a real graph,
exactly as an emitter becomes a real emitter node. Nothing renders it by a private route.

That matters more than it sounds. A scroll that bypassed the graph would work on screen and then be invisible
in the Effects editor, unexportable, and a second mechanism to keep alive forever. Going through the graph
means one mechanism: the node decodes with the retail reader, shows up when you click the prop in Effects, can
be retuned or deleted there, and exports as a native node.

**Per material, not per placement.** A snow gun's plume scrolls while its bodywork does not, and
`authoredPropMaterialEffects` had only ever resolved one effect for a whole placement — which is correct for
retail, where a scrolling surface is its own single-material prop. A node may now name the material it drives:

```json
{ "mainType": 0, "payload": { "type0": { "SubType": 10, "UVScroll": { … } } },
  "extensions": { "slopesmith": { "material": 1 } } }
```

The scope lives in `extensions`, never the payload, so the payload stays byte-shaped like the native record.
An **unscoped node still covers every material**, so every retail graph resolves exactly as before.
`PropSubGeom.mat` carries the material id to the draw, and `authoredPropMaterialEffects(doc, propId, mat)`
resolves per submesh.

**Why the declaration exists at all.** Every other prop effect attaches to a *placement*. That works for
reference props, which come from a level that has graphs. An imported model has none — and re-authoring the
same plume against every gun someone stamps down is work the file can simply carry.

**The extras are untrusted.** They are whatever was in a file dropped on the library, so every field is
checked rather than cast: non-finite rates, absurd rates, malformed JSON, non-positive active duration, and
negative pause/lifetime are refused. `activeDuration` is the moving portion of the native cycle,
`pauseDuration` is the stopped portion, and `lifetime=0` runs until the effect slot unloads. The former
`uLength`/`vLength` spellings remain accepted as legacy aliases for active/pause duration; those names came
from the superseded axis-length interpretation. A declared-but-stationary scroll is dropped so it never
allocates an animated material.

**A scroll moves a surface, not a part.** Turning geometry is a separate declaration, below.

## …and its own material STATES

The same `OpenSlope_effect` block declares the other thing a material can be — a flipbook:

```json
{ "OpenSlope_effect": "{\"flipbook\":{\"frames\":2}}" }
```

Only a count, and deliberately so. A frame list is a **state list**; what plays it is an SSF effect authored
against the placement ([Trailmap: 410-texture-animation]). The same two-frame page is a strobing sign under a
persistent `Sub11 TextureFlip`, a ride-over button's red flash under a finite-`Length` one, and a still image
under nothing at all — the art cannot know which, so it does not claim to. Declaring a rate here would put a
second, private animator beside the graph, which is exactly what the scroll declaration above refuses to be.

**The page is a vertical filmstrip**: N frames of one identical layout stacked top to bottom, and
`glb-import` cuts it into N bank tiles. The layout being identical is what lets UVs be authored against a
single frame and address every frame, so the geometry never learns that the material has states. It is also
how flipbook art actually works — the frames of a warning screen or a button differ in paint, not in shape.

Each frame stages as its own Custom-bank tile (`<stem>_<mat>_f<n>`), because that is what a frame list is
downstream: `ImportedPropRecord.materials[].frames` is the state list in ref form with `frames[0] === tex`,
the payload hands the renderer bare names in the tile's own bank, and `resolveTileSlot(ref, frames)` writes
them to the baked `Materials.json` as `TextureFlipbook` with every frame queued for copy. A tile used both
plainly and as a flipbook takes two combined slots — the state list is part of what the material *is*.

`tools/prop-recipes` writes the declaration from `surface(frames=N)` / `finish(frames=N)`, and
`_atlas.filmstrip()` stacks the painted frames. `misc/ride_button.py` is the worked example: a floor button
whose lamp rests green and pulses red under the editor's **Ride-over button** effect
(Slopesmith [docs/026](026-effects-editor.md)).

A GLB is not the only way in. The prop inspector's **Materials & textures** section
([docs/012](012-props.md)) edits an imported model's table directly — pick the resting tile, append or drop
flipbook frames from the Texture Library — through `POST /api/custom-prop-materials`. The declaration is what
a *file* can carry; the panel is what an author can change afterwards, and both land in the same
`ImportedPropRecord.materials[]`.

## …and its own moving parts

A node can declare that its geometry **spins**, which is how a snow gun's fan turns inside a barrel that
stays bolted down.

```json
{ "OpenSlope_animation": "{\"spin\":{\"axis\":[0.914,0.407,0],\"revsPerSecond\":0.75}}" }
{ "OpenSlope_animation": "{\"swing\":{\"axis\":[0,0,1],\"amplitudeDegrees\":58,\"periodSeconds\":4.8}}" }
```

The node's own translation is the pivot and the declared axis is read through its world rotation, so both
take the same frame change the vertices take — the pivot as a point (re-centring included), the axis as a
direction. `MAX_IMPORT_SPINS` caps them per model.

**It becomes a `PropModelAnimation`, not a private clip format.** The importer builds the same
object-hierarchy shape an extracted level's `ModelObjects` decode to, which is the shape retail's own snow
blower ships — SNOW model 35 is object 0 (the base) plus object 1 parented to it, one rotation channel,
`AnimTime: 15.0`, 120 rpm. So the viewport's clip registry, `hierarchyDeltas` and the Model clip effect all
play an imported clip through the path they already played a borrowed one through. Placing the model auto-attaches the looping
`property.anim-object` node that runs it.

**Each spin is a PAIR of objects, and that is the whole trick.** The renderer rebuilds an animated object's
pose from `baseEuler` plus whichever channels carry curves, ignoring its `restRotation` — so one object that
both tilted and turned would have to express its tilt as an Euler triple in the renderer's composition order,
with the animated component as one factor of it rather than a turn about the tilted axis. Splitting them
sidesteps the question: an unanimated **mount** carries the tilt as an exact quaternion, and its animated
child turns about a plain local Y from a zero base. The delta the renderer applies is a conjugation, so the
result is a rotation about the declared axis through the declared pivot whatever the Euler order is.

**Submeshes split by material *and* object.** A material is how a run draws and an object is how it moves,
and a `PropSub` carries one of each — a fan wears the same steel page as the mast it turns in front of. So
`ImportedPropDraft.textures` / `.scrolls` are indexed by MATERIAL while `subs` are per run, and
`draftToRecord` numbers the materials from the material list rather than from the submeshes.

**One clip serves every declared rotation**, with the window set by the slowest and the others snapped to
whole turns or pendulum cycles within it — a fractional cycle would jump back at the wrap. A swing is four
native cubic Hermite segments per cycle: rest → positive apex → rest → negative apex → rest, with matching
velocity at the boundary so it loops without a hitch.

**Declared node ancestry is motion ancestry.** A spin node nested below another spin node becomes a child
of the outer spin's turning object, rather than another child of the static root. Its declaration still uses
the model-space pivot and axis visible in the GLB; `importedSpinAnimation` derives the mount's parent-local
rest transform. This is what makes a carnival car orbit with its platform and then counter-spin around its
own handle. The nearest declaring ancestor wins, matching the rule that assigns a mesh to the nearest spin.
glTF traversal visits parents before children, which also makes cycles unrepresentable in a valid import.

**And it reaches the disc.** A repacked ISO turns the fan, through three joins that follow the ones every
other authored prop fact already rides:

- the bake tags each run with the object that owns it — `usemtl mat_<slot>[_scr<n>]_obj<k>`, the same
  `usemtl` dialect the scroll variant uses. The tag is load-bearing rather than cosmetic: a fan and the
  housing around it routinely share one atlas page, so without it the structured bake merges them into one
  submesh by material and the moving part can no longer be told apart.
  The engine-neutral bundle keeps that split geometry, but strips only the terminal `_obj<k>` while resolving
  the material: `mat_9_obj4` and `mat_9_scr2_obj4` still use authored material 9 (and the latter scroll speed 2).
  The bundle enumerates the base slots used by its split animated GLB nodes as well as the aliases in
  `Props.obj`; otherwise the node asks Unity for `mat_9` while only `mat_9_obj4` exists and renders white.
- `extensions.slopesmith.propClips` carries each placement's clip **verbatim** — the object hierarchy, rest
  poses and all six channels, in model-local raw cm, exactly the `PropModelAnimation` the viewport previews
  and an extracted level's `ModelObjects` decode to. Beside it rides `pose`, the similarity the placement's
  vertices were baked through (`world = origin + scale·(rotation·v)`), read back off the same posed-point map
  the `v` lines take. Nothing is summarised, so the packer transliterates rather than reconstructs; object 0
  is the unanimated identity root, which is what makes `_obj0` mean "the part that does not move".
- `canonical-props.ts` writes the result as native `ModelObjects` + `AnimTime`, with each object's
  vertices taken into **its own** frame. The engine poses a model object through its matrix chain, so
  geometry left in model space is transformed twice and the part floats off the machine by its own pivot;
  retail settles it, since SNOW's spinning blower head (`43.obj`) is centred on zero while its object sits
  at `y = -111.8`. The static root has no matrix and is untouched.

Slopesmith export consumes those joins once while the geometry is still structured. It reverses the placement
and accumulated object rest transforms, writes native-shaped `Models.json` plus model-local `Meshes/`, and
places the complete instance pose in `Instances.json`. From that seam onward Unity glTF bundling and PS2 repacking use the same ordinary
animated-prop implementation as an extracted retail map. The derived `Props.obj` omits animated groups in
exactly the same classifier pass, preventing a second motionless rest-pose copy.

Spline-moved hosts use one shared native rule: the spline runtime supplies their world pose and ignores
source-instance rotation/scale. Canonical export writes only the pivot on the instance and leaves authored
rotation/scale baked into model geometry. The PS2 node then preserves the authored size and lead axis, while
Unity sees an identity `SplineMovers[].Rotation` and therefore does not un-bake that same basis.

**The frame change belongs at the top of the hierarchy, and only there.** A clip is authored in MODEL space
while the packed model stands in the INSTANCE's local space; everything below the top level is already
expressed relative to its parent, so exactly one composition has to move. The packer measures it rather than
recomputing it — the placement origin and the images of its three unit axes go through the very `LocalPoint`
a vertex takes — which is how an effect host's pivot and an explicit collision profile's rotation and scale
reach the clip by construction. Translations carry the scale (an animated travel is centimetres); rotations
and degrees do not. And a non-identity frame can only ride on an **unanimated** object, because the engine builds
an animated object's local pose from its base plus its channels and never reads its rest matrix. The usual
placement-localized frame is identity and is omitted; a top-level mover gets a helper mount only when there is
an actual rotation/scale/translation left to hold.

**An animated model has a hard budget of 27 packed native `ModelObjects`.** This is the PAL runtime's
matrix-composition capacity, not a limit on moving parts or parent depth: object 28 overwrites live stack
locals and freezes the game. Count the final packed array, including the static root and every real
unanimated/mesh-less mount. Canonical export omits identity placement mounts, so *n* direct or nested movers
normally become `1 + n` packed objects (26 reaches the safe edge; 27 reaches the failing 28th object).
Imported GLB rotations already author their necessary mount/child pairs, so the
current `MAX_IMPORT_SPINS = 4` produces only nine objects and remains comfortably inside the engine limit.
The editor projects the normal packed count when a prop is selected and shows an amber PS2 warning above
27; export checks the actual packed result so a rare non-identity helper mount is still counted. This is deliberately
not a document/export cap: Unity can use larger hierarchies. If such a map is repacked for PS2,
Snowknife prints a red `ALERT` with the actual packed count but continues, preserving Unity-only workflows.

**The clip window has to be right in the document, not just in the player.** A `property.anim-object` node's
`U1`/`U2` are the window in frames and **negative means the whole clip** — what 40 of retail's 43 anim nodes
carry. A zero-length `(0, 0)` window plays nothing on hardware, and `createAnimObjectPlayback` repairs one
silently (`endFrame <= startFrame` snaps to the clip end), so a prop with that payload animates in Preview
and stands still in a repacked ISO. `migrateMountainEffects` rewrites exactly `(0, 0)` to `(-1, -1)` on load;
any other window is a real authored choice and is left alone.

**The tilt lives one level up, on a MOUNT.** A rotation channel drives one component of its own object's
Euler triple, and the engine applies that OUTSIDE that object's rest tilt — so a spinning object can only
ever turn about a plain model axis. Retail never needs more: the police helicopter's rotor turns about Z,
both snow-blower fans and the trick gems about Y or Z, each with the geometry authored so its axis already
IS that cardinal one. An imported GLB cannot be asked to do that — a snow gun's barrel points wherever it
points — so `importedSpinAnimation` builds each declared spin as a pair: an unanimated **mount** carrying
the pivot and the tilt as a rest quaternion, and a **child** of it holding the mesh and one Y rotation
channel with a zero base and no rest transform. The child is then byte-shaped like MERQUER's
`Mdl_FanAnim_Sewer_3000`, and the mount has already aimed its Y down the barrel. Parent transforms compose —
retail's helicopter hangs its rotor off an animated body three levels deep — so the child turns about the
authored axis. The pair is an ordinary two-level hierarchy, and everything downstream of it treats it as
one: declared spins are the only clip SOURCE today, not a special case in the bake or the packer.

**A moving object's mesh sits in its own frame** — the rest pose accumulated down its parent chain, undone.
The engine draws a model object through its matrix chain, so geometry left in model space is posed twice and
the part hangs off the machine by its own pivot; retail settles it, since SNOW's spinning blower head
(`43.obj`) is centred on zero while its object sits at `y = -111.8`.

`imported-props.test.ts` replicates the packer's frame change and object layout and checks it moves a vertex
where the viewport's own `hierarchyDeltas` moves it, over several probe points and every few frames of the
clip, under a yawed and scaled placement with a rotated instance profile. It also replays the shipped `pose`
over the record's raw verts and compares against the `v` lines the placement actually baked — a pose that
drifts from the geometry animates a part correctly about a pivot the machine is not standing on.

## …and its own particle emitters

The same idea, one level up: a model can declare particle emitters on its glTF **node** extras.

```json
{ "OpenSlope_emitters": "[{\"at\":[1.44,3.92,0],\"fields\":{\"U0\":64,\"U20\":1500,\"U32\":-340,\"U49\":1}}]" }
```

`fields` is SSX's own `type2Sub0` timer-emitter payload — the identical record `Effects.json` stores and
`timerEmitterPreviewLaw` decodes. That is the whole design: **nothing new renders particles.** An emitter
declared in a GLB and one authored in the Effects editor are the same object, so the existing runtime plays
both, and an exported level ships a real native emitter rather than something that only lived in the editor.
A private particle format would have had to be translated at every boundary and at export.

**Node extras, not material extras**, because an emitter is a *point*, not a surface property. The importer
already walks the nodes it collects meshes from, so nothing new traverses the file.

**The spawn point is the fiddly part.** `U9…U11` is model-local raw cm, and the importer writes it from the
file's `at` — because only the importer knows the horizontal bounding-box re-centring it applies to the
geometry. `rawFromGltfPoint` is factored out of the vertex path precisely so a test can assert the two agree;
a spawn point that takes a slightly different route lands a metre off and reads as a physics bug rather than
an import one. `scaleDraftTo` carries the spawn point and particle size when a model is scaled at import, but
deliberately not velocity or gravity: those are physics, and a bigger snow gun still throws snow at the speed
snow leaves a barrel.

**Attachment happens on placement.** `attachModelEffectsToProp` materialises everything a model declared —
emitters *and* scrolling surfaces — into one persistent graph plus a slot and an attachment. An ordinary effect
from that moment, which the Effects editor can open, retune or delete. It is a no-op for a prop that already
carries an attachment, so it is safe on every placement and never overwrites what someone has since edited.
The declaration lives in the model so the author does not re-author the same plume against every gun they stamp
down; what plays it is the ordinary runtime, reached the ordinary way.

**The payload stays model-local after export.** `Props.obj` vertices are already baked through the placement,
but the timer record is deliberately the same local `U9…U32` record the preview runs. The export therefore writes
`extensions.slopesmith.propPoses`: placement id → `{origin, rotation, scale}` in raw space, derived through the
same posed-point map as the vertices. Snowknife joins that through `bakedGroups` and applies it to the emitter origin,
spawn axes, base/variation velocities, and gravity before writing the Unity bundle. Treating the flattened OBJ
group's AABB centre as an identity instance seats the origin near the prop but leaves a yawed snow-gun plume firing
in model +X — the observed quarter-turn mismatch. Animated models carry the identical similarity in
`propClips.pose`; that is also accepted as the placement source so motion and particles cannot disagree.

**Bounded, because the file is untrusted**: `MAX_IMPORT_EMITTERS` per model, particle count clamped, and any
emitter with a non-finite field or a malformed spawn point is dropped rather than passed on half-formed.

## Export

`buildImportedProps` is the third prop bake beside `buildPlacedProps` and `buildAuthoredModelProps`, and the
shortest of them — because the record already holds what the export wants. `decodeProps` hands back
per-material submeshes of indexed triangles in raw cm, model-local, which is exactly what
`readModelGeometries` produces for a reference prop, so geometry needs no conversion at all. Both bakes emit
through one shared `emitPosedSubs`, so the pose transform and the `v`/`vt`/`f` index bookkeeping cannot drift
apart between them.

The only real difference is where a material comes from. An imported material's texture is a
`"Custom/<name>.png"` ref, which is the same form `resolveTileSlot` already takes for an authored model's
skin — so the tile copies into `Textures/`, inherits its alpha-blend flag, and counts against the custom-page
VRAM budget with no new staging path. Preflight counts those tiles for the same reason.

For the engine-neutral bundle, a `model_Custom_*` material's `UnknownInt18 = 0` is a neutral authored
placeholder, not a retail "force opaque" flag. Its conventional PNG pixels are therefore authoritative:
hole-shaped tree atlases become cutout, while fully solid ride and machinery atlases remain opaque. An
explicit `TextureAlpha.overrides.json` entry still has highest priority when an authored surface needs a
mode its pixels cannot express unambiguously.

An imported GLB can make that choice explicitly too. glTF `alphaMode: "MASK"` is stored as **cutout** and
`"BLEND"` as **blend** by both the browser and headless importers; an omitted/default opaque mode retains
the conventional-PNG auto classification above for compatibility. The base-colour factor's alpha is folded
into the staged PNG when one of those modes participates, so a half-opacity material does not become a fully
opaque page after import. The explicit mode travels through thumbnails, the viewport and export; export
writes it against the renamed staged page in `TextureAlpha.overrides.json`, so Snowknife does not have to
guess it again from a page histogram.

The **round trip is checked**, not assumed: an identity placement must bake the record's stored raw
coordinates verbatim, because the client renders through `RAW_TO_EDITOR` and the bake undoes exactly that map.
Drift there would ship every imported prop displaced from where it was placed, so `imported-props.test.ts`
asserts the literal vertex lines.

### Solid follows the authored-model convention

`Import_<i>` bakes a ghost; `ImportSolid_<i>` opts into a collision mesh, driven by the same per-placement
**solid** toggle authored models use. Imported GLBs are arbitrary user geometry, so forcing every one solid
the way `Prop_*` does would wrap decorative art — a banner, a bush — in walls the rider cannot pass.

The prefixes are distinct from `Model_`/`ModelSolid_` rather than shared: both bakes number from 0, so a
shared prefix could collide on group names, and those names are the join the ISO packer compiles effect
attachments through (docs/026). The canonical exporter recognises `ImportSolid_` as collision-bearing.

### Lighting: props are lit from their own instance

SSX lights static props from data on the **instance** — `AmbentLightColour` plus up to three directional keys
(`LightColour1..3` / `LightVector1..3`), evaluated `ambient + Σ max(0, N·L)·key` per vertex. Not from the
terrain lightmap, and not from the PBD light list (that drives *dynamic* objects). Retail authored those
values offline per prop, which is why a boulder in shade reads dim and cool while an exposed one reads bright
and warm — a measured 3–5× spread.

Slopesmith exports those values on each canonical instance. Each placed prop rides the lightmap bake as a
**probe point**. Its key is **read from the light on the ground beneath it** — the baked lightmap value the snow under it
ships with — while its fill is attenuated by the AO at its own position. The terms mirror `computeModelColored`
exactly, minus the `N·L`, which is the hardware's job; that is also why one sample per prop is the right
granularity rather than a compromise, since the record itself is per-instance.

`LightVector1` is stored in the placement's **model-local raw frame**, not as one world-space vector copied to
every instance. The engine dots it directly with the model's stored normal. Export therefore inverse-rotates
the world sun by each placement quaternion — for an untilted prop that reduces to rotating it by the editor
yaw after the raw-space handedness change, and a tilted one takes the same inverse about its full axis.
This is measurable in retail GARI: applying inverse placement yaw to its global sun
reproduces each instance's stored vector. Writing the global vector unchanged made a turned lighting gnomon
light its local nose in PCSX2 while SlopeSmith correctly lit the opposite world-facing side.

**The key is read from the ground, not re-derived at the prop.** That is measured. Scored against retail's own
shipped instances — the factor it baked, `key ÷ (sun record × 128)` — over 2994 GARI instances and 2553 on MESA:

| predictor of retail's per-instance key | GARI | MESA |
| --- | --- | --- |
| **the baked lightmap under the prop** | **0.615** | **0.352** |
| a fresh cast-shadow query at the prop | 0.001 | 0.040 |
| ground `N·L` | 0.136 | −0.083 |
| `N·L` × cast shadow | 0.054 | 0.018 |

and the lightmap relation is monotone across all seven bins on GARI — ground A_S 0.0–0.4 → key 0.44, rising
steadily to A_S ≥ 0.97 → key 0.86. Re-deriving occlusion at the prop correlates with what retail shipped at
essentially **zero, under every configuration tried**: terrain-only or with all 2.4 M triangles of the level's
prop geometry added as occluders, probed at the origin or at the standing point. Retail's prop lighting is not
recomputed from the scene; it is *read* from the ground. Switching to it takes GARI from 29% to 37% of
instances within ±10% and MESA from 17% to 21%, and — unlike the cast-shadow term, whose p25 collapses from
0.96 to 0.07 as shadow strength rises — it stays stable across the strength knob.

The invariant this bake exists for, *a prop and the snow under it are lit by the same numbers*, is
**structural**: the prop reads the snow's own baked value. Sampling is nearest-vertex in **3D**, not in XZ,
so where the quilt folds over itself a prop
reads the floor it stands on rather than the roof above it.

Worth keeping in view: **ELYSIUM is a counterexample.** Its instances sit at ~0.90 regardless of the ground,
including 1053 standing on lightmap A_S < 0.4. This is the rule on the daylight/tree levels, not a universal
law. It does not model a prop's own burial; only the sampled ground and ambient-occlusion terms affect it.

**The probe goes where the prop STANDS, not at `pos`.** `pos` is the model's own origin, which sits wherever
the artist put it; placement stores `pos.y = terrainY − scale×baseOffset` so the model's *bottom* lands on the
ground. Measured on GARI's own instances, `Mdl_Tree_BushyLeaves` carries a **+15.4 m** offset (geometry above
its origin) and `Mdl_MediaTower_Tall` a **−15.0 m** one — so probing `pos` samples the occlusion 15 m inside
the mountain for a tree and 15 m in the air for a tower. MOUNTAIN38 shipped that: **70 of 89 placements**
flagged fully shadowed and authored at half key, while the ground they stood on was in full sun, and the sign
of each model's offset predicted its verdict exactly. Probing the standing point (`pos.y + scale×baseOffset`)
dropped that to 21, all real terrain occlusion.

Reading the key from the ground supersedes that fix and makes the failure unrepresentable: ground light is a
property of *where the prop stands*, so an origin buried 15 m inside the mountain cannot darken anything. The
standing point still matters — it is what the AO term and the 3D ground lookup resolve against, and it is what
picks the right surface under an overhang — so the seating machinery below stays load-bearing.

The seating offset is a `LevelFileOpts.propBaseOffset` callback the **server** supplies, because core owns no
filesystem and the geometry lives in the source levels' `Meshes/` (and, for imports, the Custom catalogue) —
the same discipline `groundTex` and `copyTextures` follow. It is the server twin of the app's
`placedBaseOffset`, group case included: a group seats on its lowest member, so it probes there too.

Probes are kept out of the depth map's **projection** and only query it — the map's bounds and cell size come
from the geometry rasterised into it, so letting a distant prop widen that would coarsen the map the *terrain*
is shaded with.

**The scale is retail's own rule, measured rather than fitted:**

```
instance key     = sun record colour     × 128 × the ground's baked light
instance ambient = ambient record colour × 128 × AO
```

The brightest instance key in a shipped level is *exactly* its type-0 sun record × 128 — GARI 2.470 → 316.16,
ELYSIUM 2.200 → 281.60, MERQUER 0.629 → 80.49, MESA 2.230 → 285.39: ratio 128.00 to the digit across sun
records spanning 4×. (SNOW's brightest key is a 6858-magnitude lamp, not the sun, so it doesn't bound the
sun's scale.) That 128 is the same half-bright constant as the `AmbentLightColour` alpha every instance
carries, and it holds live in EE RAM: a GARI fence reads key (311, 282, 257) against 316.16 and ambient 77
against 0.678 × 128 = 86.8 — 98% and 89% of full, which is the shadow and AO.

### Self-lit props

The one lighting setting the shipped data justifies **authoring by hand**. A self-lit surface emits rather
than receives: it ships at full texture brightness and the sun never touches it.

Retail's own convention, and the data says it is a **flag, not a value** — a full-bright instance carries no
key at all and an `AmbentLightColour` of exactly 256:

```
Mdl_Jumbotron_GariTop_1000    amb [256,256,256,128]   key1 [0,0,0,0]
Mdl_DirectionalSign_Blue_1001 amb [256,256,256,128]   key1 [0,0,0,0]
```

Min and max are both 256 across every one of GARI's 112 and MERQUER's 544, with zero spread, and the ambient
alpha is 128 on all of them — the same half-bright constant every instance carries. On the ×128 law that RGB
is an ambient of exactly 2.0. What wears it is exactly what you'd expect:

| level | self-lit | of total | what carries it |
| --- | --- | --- | --- |
| GARI | 112 | 3.3% | `Billboard_EABig_Top`×33, `DirectionalSign_Blue`×24, `WarningSign_Jump`×20, `Lcd_ScreenLogo`×9 |
| ELYSIUM | 209 | 5.3% | |
| MERQUER | 544 | **12.2%** | `StreetLight_Tall`×171, `DirectionalSign_Red`×39, `ParlamentBuilding`×19, `Jumbotron_Top`×13 |
| MESA | 145 | 4.7% | |
| SNOW | 257 | 8.0% | |

Sign faces, LCD screens, jumbotrons, lamp heads, lit building facades. MERQUER is the night city, hence 12%.
Without the flag an authored billboard face or sign is shaded like snow and reads dull beside a retail one in
the same scene — and there is no way to author around it, because every *other* aspect of a prop's lighting
is derived (key magnitude from the ground, direction from the sun) rather than authored.

`PlacedProp.fullBright` carries it, beside `solid`. In the export it is a branch taken **before** the
occlusion terms — a sign emits, so neither the ground it stands on nor the sky it can see may dim it. In the
preview the material moves its tile to the **emissive** channel and blacks out `color`: emissive is added
after shading and a black diffuse zeroes the lit term, so the result is exactly the tile, while keeping the
Lambert material the cache already wires up (a scrolling or flipbooked sign keeps animating, and the
alpha-test cutout still punches through since alpha still comes from the map). Swapping in a
`MeshBasicMaterial` would have meant plumbing all of that a second time.

Both terms take the **RAW** record value, the one `buildLightsJson` ships — not the bake-exposed pair. Terrain
normalises separately (it saturates at the lightmap's LDR ceiling) and `bakeExposure` is what decouples the
two, which is exactly why `applyRecordSun` sets it to `1/sun`: a GARI-seeded map authors sun 2.47 with
exposure 0.405, so the terrain bake still saturates while props land on retail's 316.

This constant was wrong twice, in opposite directions, and both times because it was calibrated on one
hand-picked number: 127.5 on the raw sun (the right *rule*, never validated), then 268 on the bake-EXPOSED
sun after MOUNTAIN37 shipped dark — whose real cause turned out to be the buried lighting probes above, found
two rounds later. `tools/reference-study/ref-lighting.ts` exists so that can't happen again: it feeds each shipped level its
own light records and measures the residual against that level's own baked instances. The 268 rule ran
**1.6–2.2× too bright on ambient on all five levels**; the ×128 law lands the median at 0.76–1.03 and takes
GARI's ambient from 8% to 69% of instances within ±10%.

What the harness still reports as open, in priority order:

- **Magnitude.** Even reading the ground, the median prediction runs ~1.15–1.25× bright on GARI and MESA — we
  reproduce *which* props are shaded far better than *how much*. The residual is a calibration question (the
  shadow-strength knob), not a predictor question.
- **Key direction on the lamp-heavy levels.** Retail's `LightVector1` sits a median 25–36° off the sun there
  because it is the dominant direction of *total* incident light — sun plus the 216–940 local lamps — not the
  sun alone. (SNOW is the extreme case: 87.8° off, hue 29°.)
- **Whether our terrain shadow term is too strong at all.** Against retail's own lightmaps, plain `N·L`
  predicts them better than `N·L` × our cast shadow does (GARI 0.812 vs 0.741, MESA 0.630 vs 0.649,
  ELYSIUM 0.762 vs 0.301) — retail's lightmaps are closer to unshadowed lambert than ours. Adding prop
  geometry as occluders makes the fit *worse* on both daylight levels (GARI 0.485 → 0.443, MESA 0.468 → 0.253),
  so baked tree shadows are not what is missing — though thin fence/rail geometry at 1536² will also produce
  shadow acne, so treat that as suggestive rather than settled. This one is a **terrain** question and would
  change every level's preview, so it is deliberately not acted on here.

`lighting: false` ships no terrain lightmaps or authored prop samples; canonical prop instances use their
neutral full-bright payload. With lighting enabled, **every** placement follows the mountain's own sun,
including reference-library props and imported GLBs.

The viewport's **Lighting** toggle previews props from the same **raw** sun and ambient the instance
records use. Its exposure is absolute against retail's self-lit reference: raw factor 2 / instance ambient
256 is texture-true, so the default 1.0 sun + 0.3 ambient reaches 65% on a fully sun-facing white surface
before tint and per-prop ground attenuation. The last step matters: the GS multiplies the half-bright texture
by its interpolated 8-bit vertex colour in **byte/sRGB space**, then saturates; Three's normal Lambert path
decodes the texture and multiplies in linear light, which made the same 52% gnomon face look roughly 75–80%
bright. The prop shader recovers Three's light factor, applies it to the sRGB texel with a 256 full-bright
reference, saturates at 1, and returns to linear only for the renderer's output transform. It is deliberately
*not* normalised back to the studio rig's total — doing that made a dark ISO look texture-bright in Slopesmith.
With Lighting off, props keep the flat texture-true studio rig for judging art. The preview's key light **negates Z**: it lives at scene root
while props hang under `worldRoot`, which flips Z to show the game's handedness, so without the flip the
editor lights props from the opposite side to the ISO. Terrain never needed this — its lighting is
per-vertex colour computed in JS against data-space normals, not a real light in the scene graph.

Retail reference props do **not** borrow that authored per-ground value. Their `Instances.json` already owns
the answer, so the reference payload preserves `AmbentLightColour` plus all three `LightColour` /
`LightVector` pairs. It also preserves the extracted OBJ's `vn` stream through object rest transforms instead
of recomputing smooth normals. In Sun-lighting mode a float lookup texture supplies each rendered instance's
exact ambient and three keys; the shader evaluates `ambient + Σ max(0,N·L)·key` against that model-local native
normal before the same byte/sRGB modulation used for authored props. The ordinary per-instance RGB channel
carries only the 24-bit source index into that table. This matters on SNOW's `Mdl_Rock_CliffWall_*`: its low
ambient and three local key directions differ sharply from the global moon; a single global direction leaves
whole faces ambient-only black even though PCSX2 lights them. Native `(ambient 256, keys 0)` records fall out of
the same exact equation rather than requiring a separate self-lit approximation.

The lighting gnomon keeps two deliberately different UV regimes: its stand spans the real 0..1 tile so a
lost/flattened texture is visible, while the cardinal measurement cards sample one flat texel so texture
detail cannot be mistaken for illumination. Test it at a non-cardinal yaw. A world-space direction copied
unchanged can appear correct at yaw zero and still light the prop's local nose after it turns; the arbitrary
yaw is what exposed the missing world→model conversion.

There are also **two real WebGL shader variants**, even though both wear `MeshLambertMaterial`. Native retail
draws allocate Three's instance-colour channel and use it as a 24-bit lighting-table index; ordinary authored
draws do not, so Three omits its `USE_COLOR` define and never declares `vColor`. A runtime uniform branch does
not help: GLSL compiles both sides, and one unguarded `vColor` made every custom prop's fragment program fail.
Native-only symbols therefore stay behind a compile-time `#ifdef USE_COLOR`. `npx tsx test/prop-shader-webgl.test.ts`
bundles a minimal browser fixture, launches an installed Chromium/Edge through `playwright-core`, renders both
variants through Three's real `WebGLRenderer`, and fails on a shader/link error or a black result. The existing
source-anchor checks remain useful for Three upgrades, but they are not a substitute for this runtime compile.

**Each prop previews at its own key**, read from the ground under it exactly as the export reads it. The
preview and bake call one `groundLightSampler` over one field, so a prop in a cliff's shade differs from one
in full sun in both the editor and exported instance data. The terrain layer keeps its per-vertex lit colour
(the bake's `colored`, snapshotted *before* the
baked-view round-trip and the surface-tint multiply, which are display-only) and props sample it.

Two details carry weight:

- **The scale lands on the key alone**, through a `uKeyScale` uniform patched into `lights_fragment_begin`
  so it multiplies `directLight` only. Tinting `material.color` would have been far simpler and would have
  been wrong: Lambert folds that into the ambient term too, over-darkening a prop in shade — the exact case
  the preview exists to show. `propKeyScaleShaderApplies()` guards the anchor, since a three.js rename would
  otherwise flatten every prop back to one key while still looking plausible.
- **Ground light is quantised into 12 buckets** for the preview, and materials are cached per (texture,
  bucket). Props share materials by texture, so one material per placement would multiply draw state across a
  prop-heavy mountain; the bucket step is well under what a viewer can pick out. The export writes the
  unrounded value — the quantisation never reaches the ISO.

A sun-slider drag re-lights the terrain every frame, so `relightGround` re-picks cached bucket materials
rather than rebuilding the prop scene, and `setTerrainLight` drives it — which also covers the ordering,
since `setPropLight` runs first and has no lit terrain to sample yet.

### What the exporter tells you about imported models

The export dialog's texture details carry an **Imported models** section — one row per placed model:
placements × per-copy triangles, plus its texture pages priced in the currently selected size/format mode
(the same pages also appear in Installed pages under their "(imported)" labels; this is the view BY MODEL,
so a heavy generated prop is legible as a model rather than as an anonymous texture row). A total
baked-triangle line goes loud at the same ~150k point the export log flags. The summary is attached by the
server route (`withImportedModels`), which owns the record store the pure classifier cannot read.

The export log mirrors it: after the aggregate "baked N imported GLB placement(s)" line, one
`imported "<name>": count × tris = baked` line per model — because the aggregate hides *which* import is
the heavy one, and geometry bakes once per placement.

Beyond that, the log will tell you:

- **A placement whose record is gone.** Delete a JSON from the mountain's `assets/props/` and its placements stay in the
  document — still visible in the editor. The bake names them rather than dropping them silently, since a
  level quietly missing something you can still see is the worse failure — and the dialog's Imported models
  section shows the same placement as a flagged row.
- **Triangle density.** `MAX_IMPORT_TRIS` is an *editor* cap; the browser viewport holds far more than a PS2
  does. There is no measured triangle ceiling for a repacked level the way there is a proven-clean VRAM
  footprint, so past ~150k baked imported triangles the log flags it as a place to look — the reference point
  being docs/028's census, where GARI's entire 648-model prop library is ~225k triangles. It is a hint, not a
  limit, and it says so.
