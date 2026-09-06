# 005 — Texture paint

Paint the **real extracted SSX terrain tiles** onto the quilt, see them live in the viewport, and
export them so the level rides with those exact textures. Texture (the look) is an independent paint
channel from SurfaceType (the ride feel).

## The one hard constraint

An SSX terrain patch carries **exactly one `TexturePath`**. The bake groups a quilt's triangles by
texture and emits one material per texture (`Snowknife/Bundle/TerrainBundle.cs` — `triByTex`); the
texture bundle simply copies every `*.png` in the level's `Textures/` folder and classifies its
alpha (`TextureBundle.cs`). There is **no per-texel splat/weight map** anywhere in the patch format.

So every cell resolves to **one real tile** — there is no honest way to export a per-texel crossfade
between two tiles (it could never ride the way it previews). A painted cell stores one concrete tile
ref plus an optional D4 orientation.

## The Asset Library — one flat list of textures

The **Asset Library** (bottom panel) lists a level's real texture files in **one flat list**, no
grouping. A patch's `SurfaceType` is *physics* (ride feel), not the look, so grouping the look by it is
meaningless — tiles are just listed, most-used-on-terrain first, with the prop/skybox tiles (never
used on terrain) trailing.

- `server/routes/textures.ts` `deriveLevelTextures(level)` → `{ level, tiles }`, served at
  `/api/textures?level=…`. `tiles` is every PNG in `Textures/` as `TexTile { name, count }`, sorted
  by terrain-patch `count` desc then name (`count` 0 = a prop/skybox tile).
- `app/paint/library.ts` (class `TextureLibrary`) renders them as thumbnail swatches. A tile carries only its
  **look** here: a clicked or dragged tile lands at the default ride feel (`DEFAULT_SURFACE` = 1, snow).
  The ride feel is chosen **per-cell in the Palette's Surface mode** (see below), not here. (Sampling
  a painted patch still carries its own SurfaceType so the new brush keeps its feel.)
- Its title collapses the panel to just its header, to free screen space once tiles are staged.
- **Getting it back.** The panel shows only in Paint, and only while its open intent is set (the Palette's
  **Texture Library** toggle, the panel's **✕**, and boot-restore all go through `setLibraryWanted`). While
  it is down, a **pull-up tab** sits in the middle of the bottom edge (`ui/components/dock-tab.ts`,
  class `DockTab`) — the same glyph and words as the toggle, offered where the panel itself lives, so the ✕
  is not a near one-way door. The Prop Library has the twin of it in Props mode. Both obey one rule
  (`syncDockTabs` in `main.ts`, driven from `updatePaintUi` and the two open-intent setters): a tab shows
  when its library is hidden **and** its own mode is up, so it never competes with the panel it opens. A
  live pick holds the panel open from another mode, and the tab stands down for that too.
- **hide unused (N)** (on by default) shows only the textures the level **uses on its terrain**
  (`count > 0`); uncheck it to reveal the rest (props / skybox / spares).
- **hide staged** (on by default) drops tiles that are already placed in the Palette, so the Library
  only shows what you haven't staged yet. It reads the Palette's refs via the `stagedRefs` callback and
  re-filters (`refresh`) whenever the Palette's contents change.

### Open-mountain textures

The library opens on the shared rule (`ui/components/library-default.ts`, [026](026-effects-editor.md)):
the open mountain when it holds any tiles, otherwise the loaded reference level, otherwise the first extracted one. It is
re-derived on first open as well as at `init`, since boot chooses before the reference has loaded; an explicit
pick by the author is never overridden afterwards.

The level combo carries a pinned entry named for the open mountain — the user's own tiles, stored as real files under the
open project's `assets/textures/` so a logical `Custom/<name>.png` ref resolves through every consumer (viewport tile
materials, model textures, export copies, the combiner's tile slots) by the same disk convention as an
extracted level. The open mountain's grid leads with a **+ tile** that opens a file picker: the browser decodes
whatever image format was chosen, shrinks it to ≤512 per edge on a canvas, and POSTs PNG bytes to
`/api/texture-upload?name=<stem>`; `saveCustomTexture` re-encodes to plain 8-bit RGBA (the file kind
snowknife's reader expects) and stores it under a name that is **free** — `<stem>`, or `<stem>_2`, `<stem>_3`
… when the name is taken ([038](038-hosted-sessions.md)). The answer names the tile it landed under and
that is the one armed as the brush, so loading an image can never change art someone else's cell is wearing;
a `Custom/<name>.png` ref is a permanent address, which is why `/api/texture` serves the Custom level with
the same one-hour cache lifetime as an extracted level's pages. `levelsWithTextures()` excludes the folder: that list doubles as the export dialog's
repack-target menu, and Custom is not a course. The main use is skinning authored models (docs/028) —
pick the tile from the model banner's texture swatch (below); exports copy the tile like any borrowed
prop art, defaulting to opaque (`UnknownInt18` 0, no source material to inherit a blend flag from).

Beside the + tile sits a **✨ tile** that generates one from a description instead, through fal.ai and the
author's own API key ([033 — Generate Texture](033-generate-texture.md)). It ends at the same
`/api/texture-upload` POST as the file picker, so everything above applies to a generated tile unchanged.

### Choosing a texture from elsewhere (pick mode)

A texture is a picture, so it is chosen by looking at pictures. The same grid doubles as a one-shot
**picker**: `library.openPick({title, current, onPick})` borrows the bottom panel over whatever mode is
up, retitles it with the question, highlights `current` (loading its level if another is showing), and
routes the next tile click to `onPick` instead of arming a paint brush. A **∅ no texture** cell leads the
grid — once a tile is set that is the only way back to none. **Esc**, **Cancel** or the **✕** back out
without changing anything.

The Edit-mode model banner's texture field is the first caller: it renders as a swatch of the model's
current tile (`texturePreview` in `ui/components/gui.ts`) and opens a pick on click, replacing a free-text
box that asked the author to recall refs like `GARI/0106.png` by hand. The Generate texture dialog's
Transition and Decal tabs are the others — their A / C / source slots each open a pick, with the dialog
hiding itself while the question is up (the panel lives under the modal backdrop) and returning with the
answer (docs/033). Two rules bend for pick mode:

- **The panel outlives its mode.** The Texture Library normally shows only in Paint (`updatePaintUi`), but
  a pick is raised from Edit — so that rule consults `library.picking` first and stands aside. `setMode`
  and `exitModelEdit` cancel any live pick, since the session that asked the question is gone.
- **Esc is captured.** The picker registers a capture-phase key listener ahead of the editor's layered
  Escape (`shortcuts.ts`), which would otherwise end the model-edit session out from under the question.

`hide staged` stands down during a pick — it declutters the Library against the paint Palette, which would
only hide candidate answers here.

Custom tiles also carry management actions on **right-click** — **✎ rename**, **⧉ duplicate**,
**⟳ replace art**, **🗑 delete** — raised through the shared `contextMenu` popup (`ui/components/controls.ts`)
and served by `/api/texture-rename`, `/api/texture-clone`, `/api/texture-replace` and `/api/texture-delete`,
with `/api/texture-usage` reporting the imported-prop references the editor cannot see for itself. Rename and
duplicate obey the same non-clobbering rule as upload: an occupied target is suffixed, never written over. A
rename repoints `quadTex`, authored-model textures and imported-prop records; a delete clears the first two
and reports the third. Both document edits are undoable; the file operation is not. Details in docs/033.

**Replace art** is the deliberate iterate-on-one-tile loop, and the only action here that changes what an
already-painted cell shows. It names what it will affect first — places in this mountain plus imported props
— and is an upload plus a repoint rather than a write over the file: the new image lands under its own free
name, `quadTex`, authored models and imported-prop records are all moved onto it, and the old tile is
removed. The author gets what overwriting gave them while no URL ever answers with bytes it did not answer
with before, so there is nothing to invalidate. Replacing a tile that is itself a `_2` walks the counter on to
`_3` rather than landing `_2_2`: the name must change, but a loop this action exists for must not grow one
without a bound.

The Blender bridge takes the **same** path — `replaceCustomTextureArt`, not a copy of it — when a tile painted
in Blender comes home on a prop (docs/046). Only its document half differs: the add-on has no tab, so the ref
move is parked in the mountain's inbox and applied by whichever editor picks it up.

They sit on right-click rather than as buttons drawn on the tile because a tile's ordinary click means
"paint with this" — frequent and harmless — while managing the file is rare and destructive. Sharing one
target, the destructive action must take the deliberate gesture, or aiming at the art clips Delete. Custom
tiles are focusable so the keyboard Menu key raises the same popup.

The stored ≤512 edge is the **editor's** budget, not the console's. Custom pages default to the proven
type-5 32-bit path (4× a native paletted page's VRAM), and it is their *aggregate* that corrupts in-game
past roughly half a megabyte, not any single page. The export dialog therefore shows a VRAM bar plus
independent **cap custom tiles at 128²** and **8-bit custom tiles (type 2)** checkboxes. The latter mirrors
GARI's original indexed page layout and quarters the estimated pixel cost, but remains opt-in pending an
in-game append verification. The stored file is left alone in every mode, so Unity keeps the detail.

## Painting

Paint mode lays down tiles from the Asset Library; each tile carries its ride feel, so there is no
separate "paint physics" target — the ride feel travels with the tile.

Paint has two states, shown in the lower-left control sheet: **placing** (a brush is held) and **select**
(nothing held). Picking a tile from the Library or Palette, middle-clicking a textured viewport surface, or
pressing **＋ paint texture** beneath its preview arms placing. **Esc** puts the brush down into select mode,
and a second Esc clears any selection.

While **placing** (a brush is held):

- The viewport cursor becomes the same yellow **paint-brush icon** used by Paint mode, with its hotspot at
  the bristle tip; putting the brush down or leaving Paint restores the normal pointer.
- A translucent **ghost** of the brush tile drapes over the hovered cell — the cell's own tessellated
  surface re-UV'd to the brush's D4 orientation, exactly what a click paints (`drapePaintGhost`). A tile
  still downloading drapes flat amber until it arrives.
- **Left-click** places the tile into the cell (`texPaint["r,c"] = "<LEVEL>/<file.png>"`); a drag paints
  a stroke of them.
- **← / →** turn the brush a quarter (**→** = CW on screen); the ghost, the pad preview and the rotation
  readout all track the turn. **Shift+← / →** toggles the brush's **mirror** instead — mirroring is a
  separate, deliberate act, not part of the rotate cycle, because the original art essentially never mirrors
  a tile (a rare handful of the reference patches) and an accidental flip breaks the art's direction and its
  seam matches. The same keys turn the single tile a **tiled prop** wears while its Edit session is open
  ([028](028-authored-models.md)) — one gesture wherever a tile's D4 is authored, over the one shared step
  (`turnD4`), so → turns a prop's tile the same way on screen as it turns the mountain's.
- **Middle-click** selects the texture under the cursor and replaces the held brush with it.
- **Esc** puts the brush down (select mode).

In **select** mode (no brush held):

- **Left-click** only selects/inspects the painted cell under the cursor: its yellow outline and preview readout
  show the tile, ride feel, and orientation without arming a brush. Clicking a **reference patch** does the same
  read-only inspection, using the D4 recovered from its patch UVs. Clicking a textured prop inspects the exact
  material submesh hit and keeps its yellow surface/UV outline.
- **Middle-click** performs that same selection/inspection and also arms the texture. The **＋ paint texture**
  button directly beneath the preview arms the currently inspected texture without another viewport gesture.
- **Shift+left-click** extends the selection into the rectangular block of cells between the plain-clicked
  cell (the anchor) and the shift-clicked one — the corner range's grammar on the cell grid. Every painted
  cell in the block joins the set (unpainted cells hold no tile, so they're skipped) and gets the amber
  outline; the readout keeps describing the anchor, with the set's size shown under it. Shift-click does not
  arm a brush. The anchor stays put, so a further shift-click re-ranges from it.
- **← / →** turn the selected cell's placed tile a quarter (**Shift** mirrors it) — the whole set on a
  shift-range selection, as Delete clears the whole set. The readout tracks the turn.
- **Delete** clears the selected cell's tile — the whole set's tiles on a shift-range selection (each cell
  falls back to its ride-feel tint; the SurfaceType stays).

Paint **middle-click** samples the mountain, loaded reference, or exact material submesh of a visible
placed/reference prop and arms the brush at **the orientation it sits at relative to the patch** — the D4 turn
from the patch's green frame-F to its pink art-F. An authored cell returns the exact orientation it was painted
at (`cellOrient`); a reference patch recovers it from the patch's tile-UVs (`orientFromPatchUV` in
`core/paint/orientation.ts`, the inverse of how the F overlay draws the art-F). Painting the sampled brush
reproduces that orientation on the target patch. Sampling also adopts the patch's ride feel where known
(authored cells; reference patches default to snow). A prop surface has no patch frame or terrain SurfaceType,
so its frame-zero texture is sampled at rotation 0 / unmirrored with the default snow ride feel; a multi-material
prop yields the submesh actually hit. There is no separate eyedropper button or armed state: MMB is the direct
select-and-arm shortcut, while an MMB drag still pans the camera.

Painting a cell also writes the brush's **ride feel** (SurfaceType) into the physics paint (`paint`).
Texture (look) and SurfaceType (physics) are separate channels, but **every tile carries a ride feel** —
there is no "texture only" — so painting always stamps one: a Library tile lands at the default (`DEFAULT_SURFACE`
= 1, snow); you set a tile's ride feel per-cell in the Palette's **Surface mode** (below), or adopt one by
sampling a painted cell.

### Tile orientation is relative to the patch's own frame

Every patch — authored or original — has two parametric axes and an origin: **`u`** and **`v`** from the
patch's `A(0,0)` corner. A tile's D4 orientation only means anything **relative to that patch's own
axes** — the editor never infers a "true" down-mountain direction from the data, but it does read a tile's
D4 **relative to the patch it sits on**: sampling captures it (above), the F overlay shows it (pink
art-F against green frame-F), and the Palette's selected-texture readout spells it out in degrees — the
*brush's own* quarter-turn, so the frame the number is relative to is always explicit. Original
patches don't even agree on the sign of `u` between neighbours — their UVs usually compensate, so the
render is seamless. On the authored mountain the grid is uniform by construction — the bake lays every
cell with `+u` down the rows toward the finish (`level.ts`, `quiltPatches`) — so a Palette cell's D4
paints exactly what its art shows. Orientation is worked **visually**, with the F overlay:

**File-native display, terrain rotation sense.** Everywhere a tile's art is shown — the preview, the Palette
cells, the Asset Library thumbnails — a rot-0 tile is drawn **exactly as it sits on disk** (**0 = up**), no
view spin. There is no "ride view" to spin toward because patch frames vary in orientation (their `u` sign
disagrees between neighbours), so a screen-down `+u` can't be defined reliably; the F overlay carries the
per-patch relationship instead. A **rotated** tile is drawn the way the **terrain** renders that D4 — the 3D
patch samples through `orientUV`, whose rising `rot` reads as a **CCW** turn on the surface (the other way
when mirrored) — so `orientCss` and the preview / edge-sampler canvases use that same sense (`rotate((mirror
? rot : -rot)·90°)`). A Palette cell therefore shows a tile exactly as it sits on the mountain, not the
mirror-of-the-rotation it used to. **→** steps `rot` **down** one quarter wherever the tile lives — pad cell,
brush or placed cell — so a tile always turns the same way (CW on screen); the edge sampler (`edgesFor`) and the preview's
neighbour strips draw at that same orientation, so the alignment seams still compare the visually-adjacent
edges. This is display only — the stored orientation and the bake are unchanged.

**The F overlay (top-bar F toggle).** A top-bar **F** button (next to the Control cage toggle, never
hidden, persisted) draws a chiral pink **F** — 1/3 of the tile, centred, riding the tile's ART — on
**every tile display at once**:

- **3D terrain**: every textured reference patch and every painted authored cell, the F mapped through the
  patch's own tile UVs so it sits exactly how the art sits (rotated tile = rotated F, mirrored = mirror-
  image F). Drawn as fat lines (`LineSegments2`, `F_LINE_WIDTH` px; `DoubleSide` because the display's
  chirality flip would otherwise back-face-cull the quads); reference Fs evaluate on the corner bilinear,
  authored Fs on the preview lattice, both with a skyward lift. `appendUvGlyph` / `rebuildAuthoredF` /
  `rebuildRefF` in `viewport.ts`. The art frame accounts for the terrain's `flipY = false` sampling.
- **Asset Library** swatches, **Palette cells** and the **big preview**: the same F (a shared inline SVG /
  canvas drawer, `app/paint/glyph.ts`), inside each tile's oriented element so it rotates and mirrors with it.

One glyph language everywhere means orientation is matched **by eye**: sample a spot, look at its F on the
ground, and rotate the Palette cell until its F points the same way — no numbers, no frames to reason
about. With the **Control cage** also on, every patch additionally draws a smaller **green frame F** in
its own `u/v` square (where a rot-0 tile would sit, tucked at the patch's real `(0,0)` corner): pink
parallel to green = the tile is applied at 0° in that patch's frame, and green Fs flipping between
neighbours = the cage frames themselves disagree. In the reference, almost every tile is applied at 0° in its own
frame (all but a rare handful of patches; the few mirrored ones are all `0094.png`, and a few dozen non-wall patches are mirror-wound).

## Palette

The Tools panel in Paint mode holds the **Palette** (`app/paint/palette.ts`, class `Palette`): a 5×15
staging grid with a big preview of the active tile (and its neighbours) above it, where you compose the
exact `tile + ride feel + orientation` combos the mountain will use. (Its interaction help lives in the
lower-right **Paint** overlay — see below — not inline, and the pad has no title of its own.)

- **Drag** a tile from the Asset Library onto a cell to stage it (it lands at the default ride feel, snow),
  or **drag the big preview** down into a cell to stage the current tile (carrying its ride feel and
  orientation). Dragging is the only way to add a tile — a plain click never places one.
- **Drag a filled cell onto another** to rearrange (a swap; dragging onto a blank cell moves it).
  **Shift+drag** copies the cell instead — the source stays put and a clone lands on the target.
- A **click** on a filled cell makes it the **active paint brush** (tile + ride feel + orientation) — like
  clicking a Library swatch or sampling a viewport surface — and magnifies it in the preview; the cell's **duplicates flash**
  briefly (only the clicked cell keeps the selection glow). A click on an empty cell just focuses the
  preview. This is the same in both views: a plain click always grabs the tile as the brush. **← / →** turn
  the focused cell (rot 0..3, like the terrain) and **Shift+← / →** toggles its mirror — the same keys, in
  both views, as turn the brush and a placed cell. In **Surface** view **right-click** opens the
  **ride-feel menu** (see below); in Texture view right-click does nothing. The **✕** on hover clears a cell.
- A **Texture / Surface** view toggle: in **Texture** view a cell shows the tile art; in **Surface** view
  it shows half the tile art (left) and half the cell's ride-feel colour (right), split by a vertical line
  (no number). A **right-click** on a filled cell in Surface view opens a **ride-feel menu** (a SurfaceType
  swatch + name per option — every tile has a ride feel, so there is no "texture only" entry); picking one
  sets that cell's ride feel (`openSurfaceMenu` / `setCellSurface`). This is where ride feel is assigned — so
  the same tile can sit in the pad more than once with different surfaces. (A plain click still just grabs
  the tile as the brush, so you can select a tile and set its ride feel without leaving Surface view.)
- A big **preview** above the grid (always shown, even with nothing selected) magnifies the **active
  cell** in the middle with a thin strip of its **grid-adjacent cell** on each of the four sides — the
  tile actually placed next to it in the pad, drawn at that neighbour's grid orientation (its touching
  edge). It mirrors your arrangement rather than searching the whole Palette, and a side is blank at the
  pad edge, over an empty cell, or where the neighbour is **separated by an orange seam** (doesn't align) —
  so the preview only shows neighbours that butt cleanly. An isolated cell shows no strips, and the strips
  update live as you arrange tiles around it. Rendered to a canvas (`drawPreviewCanvas`); the per-side
  neighbour is `gridNeighbour`, using the same edge metric as the grid's orange seam markers. Above the canvas,
  an origin readout identifies the source type (**model**, **surface**, or **palette**) on the left and its
  specific model, terrain cell/patch, or texture name on the right. Terrain/library tiles then show their
  paint-context **material · rotation** before the action: the
  ride-feel swatch + `SurfaceType`, and the brush's own D4 orientation as degrees (`0° / 90° / 180° / 270°`,
  `orientText`) with a `⇋` when the tile is mirrored. Prop textures omit both because a model submesh has no
  terrain ride material or patch-relative D4. **← / →** turn whatever the preview shows — the focused pad
  cell if there is one, else the loose brush (`turnActive`), so a brush picked from the pad turns its staged
  cell with it. **Click** the preview to pulse the
  tile's duplicates elsewhere in the pad (`flashRef`), like clicking one of its cells. That degree is the tile's
  own quarter-turn state in the pad, not an orientation relative to any mountain patch frame; the F overlay
  remains the on-art instrument for matching orientation by eye.
- A full-width **＋ paint texture** button directly beneath the large texture arms exactly what that preview
  shows. For an inspected authored cell it retains its ride feel and D4; reference/prop textures default to snow,
  and a selected prop flipbook frame paints that visible frame. The inspected yellow outline stays until the
  first paint stroke, matching middle-click selection.
- Beneath the action, neutral slate **Texture Details** rows mirror Prop Details: the full texture filepath,
  alpha/appearance type (opaque, cutout, translucent, or native alpha pass), and pixel dimensions. Animated prop
  textures add frame count/timing, UV-scrolled surfaces add mapping, and
  priority materials identify their z-fight draw-order override. Flipbook thumbnails/playback remain below these
  facts; changing the promoted frame updates its filepath, type, and size without resetting the strip.

### Help overlays

Help overlays sit above the bottom Asset Library (`updateCmdSheet` in `app/main.ts`, styled by `.ll-panel`).
On the **lower-left** (`#lowerleft`): the **View** panel (camera navigation — orbit / fly / pan / zoom /
frame), always shown, and next to it a **Paint** panel (`#paintctl`) with the terrain paint keys for the
current state — **placing** (place / MMB select+arm / ←→ turn brush / mirror / Esc puts down) or
**select** (LMB inspect / MMB select+arm / range-select / ←→ turn tile / mirror / Delete clears / Esc deselects). On the **lower-right** (`#lowerright`): the **Palette**
panel — the scratch-pad actions, which follow the view toggle: **Texture** view lists use-as-brush, ←→ turn,
mirror, reorder, clear, and "orange = edges don't align"; **Surface** view lists use-as-brush, right-
click to set ride feel, reorder, clear. Sculpt mode shows its own brush keys there instead. All are hidden on mobile. The Palette's
own view toggle also carries a **?** badge whose tooltip explains staging (drag tiles in, arrange, click to
use as brush).

### Alignment check

Cells sit edge-to-edge with a 1 px seam, so the Palette doubles as a tiling preview. For each shared
edge between two filled cells, the touching edges (with each cell's D4 orientation applied) are
compared and the seam is painted **orange** when they don't match — so you can see at a glance whether
two tiles butt together seamlessly, and rotate them until they do. Edges are read by rendering each
oriented tile into a small scratch canvas (`edgesFor`).

The comparison is **not pixel-exact**, and it flags on the **worst segment, not the average**. Each
edge's outer line is averaged into a few coarse segments (`extractEdges` → `bucketize`, `EDGE_BUCKETS`),
then `edgeDiff` returns the largest per-segment colour difference. So:

- Per-pixel *grain* misalignment between two "same snow" edges doesn't read as a seam — averaging within
  each segment washes it out (a raw 1:1 pixel comparison flagged a reference tile `0075`'s left/right at 0.19 despite
  identical average colour; the bucketed compare drops it to ~0.05).
- A **partial** mismatch still flags — edges that agree at one end but step apart at the other (e.g.
  `0110` over `0025`@90°: blue matches, then `0025` turns white) score by their worst segment (~0.30),
  where a whole-edge *average* would have diluted it (~0.13) below the line and missed it.

`drawSeams` paints the markers on a `<canvas>` over the grid; the threshold is `SEAM_THRESH` (0.20). A
self-tiling texture placed next to itself reads as aligned; two unrelated tiles, or a non-tiling texture
against itself, light up orange. Texture view only.

Drag-and-drop between the two panels uses two MIME types in `app/paint/drag-drop.ts` (`DRAG_TILE`, `DRAG_CELL`).
Clicking a Palette cell makes it the brush, so its stored orientation and SurfaceType are stamped onto
whatever terrain cell you then paint. The pad persists across reloads (`localStorage`, key
`slopesmith-scratch-v1`) and is independent of the exported document.

## Export

`core/paint/orientation.ts` `orientUV` applies a cell's D4 orientation to the tile's UVs; the preview
(`core/mesh/tessellation.ts` `tessellateQuilt`) and the bake (`core/export/level.ts` `quiltPatches`) both use it so a
hand-rotated tile lands the same way it previews. A cell with no `texPaint` entry falls back to the
SurfaceType's procedural tile.
