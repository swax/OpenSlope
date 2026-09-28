# 068 — VR Editing

The wrist watch in a WebXR session has an **EDIT** button. Turning it on does three things:

- **The palette.** A palette on the left controller shows the editor's own **File / undo**, **Mode** and **View**
  strips stacked in that order, the **current toolbox** under them, the **colour keys**, and the **Texture** or
  **Prop Library** docked to the toolbox's bottom right. The panels are the real ones, not VR copies: switching to
  Sculpt from the palette rebuilds the actual Sculpt toolbox, and that is what the palette then shows.
- **The right hand is the editor's mouse.** A short translucent laser comes out of it. Where it points at the
  mountain, the editor hovers exactly as it does under a desktop mouse: brush ring, highlighted prop, vertex under
  the cursor. The **trigger** is the left button and **A** the right.
- **Edit flight.** The player is no longer affected by gravity or collisions. The sticks fly, one grip drags the
  map, and both grips together make the player bigger or smaller, turn the map, and drag it.

In a headset that offers passthrough, the View strip also carries a **Mixed reality** button: the room in place
of the sky (below).

It began as a proof of concept for one question: can the live DOM be shown and driven inside a headset cheaply
enough? The first headset pass said yes, and editing the world was built on top of it.

## Controls while EDIT is on

| Control | Does |
|---|---|
| Right trigger | Left mouse button: on the palette, the watch, or the mountain, whichever the laser is on when it is pressed. A press stays with whichever took it until it is released, so a slider or a sculpt stroke keeps going when the hand strays. |
| Right A | Right mouse button, with the same rule. On the palette it opens right-click menus, such as the Palette cell's ride-feel menu. In the world it does nothing yet: the viewport's only right-click meaning is camera orbit, which the headset owns. |
| Left stick | Fly where you look. The speed is 6 m/s at life size and scales with the player. |
| Left stick click | Undo. |
| Right stick ↔ | Smooth turn, about the head. |
| Right stick ↕ | Rise and sink. Over the palette it scrolls whatever scrolls under the laser instead. |
| Right stick click | Redo. (Outside EDIT it toggles first / third person.) |
| One grip, move | Drag the map with that hand, including up and down. Flying and turning wait while it is held. |
| Both grips, pull apart / push together | Smaller (the map stretches out between the hands: zoom in) / bigger (zoom out). Size runs against the spread squared, so one comfortable pull is about 9×. The limits are 0.05× to 1000×. |
| Both grips, twist | Turn the map with the hands. |
| Both grips, move together | Drag the map along with the hands, including up and down. |
| EDIT (watch) | Leave edit mode: back to life size with the eyes where they are, standing on the topmost surface beneath them. |

Left trigger, left X and right B do nothing while EDIT is on. The virtual controllers' printed labels follow
the mode: the right trigger reads CLICK, A reads R CLICK, the sticks read FLY and TURN/RISE with UNDO and REDO
printed on their caps, and both grips read GRAB WORLD. Unbound controls carry no label. The wrist's CONTROLS page
shows the same map under EDITING.

A bigger player moves faster everywhere: flying scales with size, and so does every physical step and reach,
because the whole rig — eyes, hands, watch and palette — is scaled together. The grip gestures are solved
against the moment the grips closed (`ride/xr/world-grab.ts`), and start afresh whenever a hand joins or lets
go, so the map never jumps. One hand keeps the world point it grabbed in the hand. For two:

- the world point between the hands stays between them;
- the map keeps the heading the hands gave it;
- the size runs against the hands' spread. The first headset pass had pulling apart grow the player, which read
  backwards: stretching the hands apart should stretch the map.

Solving from the grab's start every frame, rather than adding up small per-frame changes, keeps a still pair of
hands from drifting.

While flying, the snowfall is off (snow belongs to a run, not to an editor), and the body is still drawn. It is
posed at life size in the rig's own frame — feet on the play space's floor under the head, arms on the tracked
hands — and then carried by the rig, so it grows, turns and flies with the player.

**Culling a scaled rig** (`ride/xr/scaled-camera.ts`). three culls a stereo frame with one frustum fitted around
both eyes, and it measures the eye separation in world units, which grow with the rig. It then adds offsets
derived from that separation to a near plane in view units. At 100× the union's near plane landed about 2.5
view-metres ahead of the eyes, so the hands, watch, palette and body were culled away as the player grew. The
session now refits that union with the separation in the rig's units, right after three's own camera update.
Drawing was never wrong; each eye renders with its own projection.

EDIT can be turned on only on foot, and mounting the board turns it off. Carrying the board when it is turned on
drops the board. T-POSE is unavailable while EDIT is on: a calibration measures a life-size body standing on the
floor. RESTART leaves edit mode for the gate.

## The right hand as a mouse

The editor's pointer router picks from a client pixel. It casts `stage.camera` through that pixel, and it
measures vertex, edge and marquee picks in screen pixels around it. So the hand drives that same path
(`ride/xr/world-pointer.ts`) instead of teaching every tool a second input model:

1. The controller ray is met with the visible mountain (`editSurfaceHit` in `viewport/scene/ride.ts`: the
   authored terrain or the loaded reference, through the same BVH picks a mouse hover uses).
2. That point is projected through the camera the router casts from. WebXR keeps that camera on the headset's
   pose.
3. Pointer and mouse events go to the canvas at the resulting client position.

Hover, click, drag, the gizmo and box select then run exactly the code a mouse runs.

What the router sees is therefore the **eye's** ray through where the hand points, not the hand's own ray. The
two meet at the surface point, and the cursor dot is drawn there. So whatever the dot covers from the eye is what
gets picked, including a vertex or gizmo handle standing in front of the surface. Where the ray meets no surface,
a far point along it stands in.

The router and three's TransformControls capture the pointer on a press. A synthetic pointer is not one the
browser tracks, and a standalone headset browser may have no mouse at all. So capture calls are made inert for
the duration of each dispatch, and the per-frame moves are what keep a drag going.

### Depth: what a mouse cannot do

Every prop and point move in the editor is a drag on the move gizmo (TransformControls), and a mouse drags a
handle across a plane: the arrow's or square's plane turned toward the eye, or a plane facing the eye for the free
centre. Nothing a mouse does carries a prop or point toward or away from the viewer. The hand can
(`ride/xr/hand-drag.ts`):

- Once a trigger press has picked up a gizmo handle, the pointer stops sending moves.
- The grabbed point rides the laser at the distance it was grabbed from. Pointing sweeps it, moving the hand
  carries it, and pushing the hand out along the laser or pulling it in changes its distance. The cursor dot
  marks it.
- Depth scales with distance. Pushing the hand half a metre further out doubles the point's distance from where
  the hand began; pulling back as far brings it to where the hand began. A 1:1 push would leave anything more
  than a few metres away all but fixed in depth. Near the hand the push is never less than 1:1.
- The motion is masked to the grabbed handle and snapped exactly as TransformControls masks and snaps a mouse
  drag: an arrow moves along its axis, a square within its plane, and the free centre anywhere. The anchor is
  then set and reported through the gizmo's own events (`Stage.driveGizmoTo`), so every drag kind's callback, the
  undo merge and the end-of-drag commit run unchanged.
- The release is an ordinary pointerup.

Full 3D needs the free centre, and a corner's default Surface frame hides it. Switch to World (the Surface ⇄ World
pill) to move a point anywhere.

**Screen-constant handles.** Handles sized in pixels (`Stage.worldPerPixel`) measured their distance from
`camera.position`. In a headset that is the head's offset inside the rig, not where the head is, so a point far
out on the mountain got a marker the size of a house. They now measure from the camera's world position and count
the eye buffer's pixels. At that true size the selected point's yellow ball was a speck too small to aim a laser
at, so in a headset it takes the size of the gizmo's centre handle — the one a prop is moved by
(`Stage.pointMarkerRadius`). The desk keeps its six pixels.

## Mixed reality

The View strip's **Mixed reality** button (next to Skybox) shows only in a headset session whose runtime offers
`immersive-ar`, which on a Quest means the passthrough cameras. Turning it on puts the skybox away and shows the
room wherever the mountain is not. Turning it off, or leaving the headset, brings the sky back as it was. The
skybox change is not saved as a view preference.

- **How the room shows.** In an `immersive-ar` session three clears each frame transparent (`alpha-blend`) when
  the scene background is a plain colour, which the editor's is whenever no sky is drawn. The compositor fills
  those pixels with passthrough.
- **Why the session is swapped.** A session's mode is fixed when it is requested, and an opaque `immersive-vr`
  session never shows passthrough. So the button ends the session presenting and requests the other mode
  (`setMixedReality` in `ride/xr/session.ts`). The rig, the edit state and the palette carry across; only the
  session under them changes. The headset shows its own brief transition.
- **Activation.** Like any `requestSession`, the swap needs user activation. The press that asks for it reaches
  the page as a synthetic click from the palette, so activation has to come from the real controller `select`
  behind it, which WebXR allows a browser to count. Whether the Quest browser does so here is untested. The
  request is made straight away, without awaiting anything first.
- **Failure.** If the new mode is refused, the old mode is requested again. Only if that is refused too does VR
  end, as it would from the watch.
- **Scope.** VR always starts as `immersive-vr`. Passthrough is only ever asked for from this button, and stays
  on until it is turned off or VR ends, riding included.

Edits need a page animation frame to rebuild (`state/rebuild.ts`), and a standalone headset browser may not run
page frames while it is immersive. The viewport therefore flushes any pending rebuild on every headset frame
(`Viewport.onXrFrame`).

## The palette: why rasterize the DOM

An `immersive-vr` session composites only the WebGL layer. WebXR's DOM overlay is for handheld AR, so no amount
of CSS gets page HTML into a headset. The choices are to rebuild each panel for VR, or to draw the real panels
into a texture. Rebuilding forks every panel, and the toolbox alone has about 230 lil-gui controls across 195
rebuild sites. `app/ride/xr/dom-mirror.ts` does the drawing instead:

1. **Clone** the panel root (`#dock-top`, `#dock-right`, `#lowerleft`, `#texture-library`, `#prop-library` and
   the two library tabs) and bake in what a clone loses:
   - the `value`, `checked` and `selectedIndex` properties lil-gui writes, which a clone would otherwise drop;
   - canvases, as data-URL snapshots;
   - same-origin images and inline `url()` backgrounds, fetched into a data-URL cache that evicts the least
     recently drawn asset once it holds 256;
   - scroll offsets, emulated by translating each scrolled element's children.

   Hidden subtrees are pruned. An element lying wholly outside the drawn region keeps its box but loses its
   contents, so a library scrolled through hundreds of tiles inlines only the art on screen.
2. **Wrap** the clone in stand-ins for `html`, `body` and its ancestors, so selectors like `#dock-right …` still
   match. Place it where it sits on the page, relative to the region being drawn.
3. **Embed the page's CSS, flattened.** Inside an SVG image, media queries are evaluated against the image's
   size, so a 300 px toolbox would match `max-width: 760px` and switch to the phone layout. The flattening
   resolves every `@media`/`@supports` against the real window first. Only rules whose class/id requirements are
   present in the clone are kept (`selectorRequirements`); negations and `:is()`/`:has()` arguments never count
   as required.
4. **Decode** the result as an `<svg><foreignObject>` image into a canvas, which becomes a `CanvasTexture`.

A panel can be cropped to **parts**: the union of the elements carrying a `data-xr-edit` key. The top bar
contributes its `file` (File menu, undo / redo, history), `mode` and `view` groups (`top-bar.ts`), and the palette
stacks them one per row; the legend panels carry `legend` (`legends.ts`). The toolbox is cropped to its rendered
panels, so the see-through part of the dock below them takes no palette space. A library tab is drawn whole
(`ownBox`), padding and all.

Because the image is laid out exactly as on the page, input needs no model of the panel. The path from a
controller ray to a real control is:

- ray hit on a plane → texture UV → client point;
- `elementsFromPoint` at that point → the real control;
- `createDomPointer` → the `pointerdown`/`mousedown` … `click` sequence a mouse would have produced (or
  `contextmenu` for A).

Moves go to the pressed element for as long as the button is held. Past the panel's edge, the ray is intersected
with the panel's plane instead, so a lil-gui slider (which listens on `window`) follows an overshooting hand the
way it follows a mouse.

Other details:

- The palette is drawn at **0.8 mm per CSS pixel**. That is twice the first pass's size, after it read small in
  the headset. It is seated about 20 cm out ahead of the left controller, half a metre below it and 15 cm
  outboard (`XR_EDIT_PALETTE_POSITION`), hangs half its own height below that seat
  (`XR_EDIT_PALETTE_DROP`), and leans away at 45°. Headset passes moved it there from the wrist, where it filled
  the view and hung high.
- **Libraries.** The Texture Library (Paint) and Prop Library (Props) stand on the toolbox's bottom edge, right
  of it; the colour keys hang from its top edge above them (`layoutWorkBlock`). While a library is closed in its
  own mode, its pull-up tab (`dock-tab.ts`) stands there instead, turned upright; pressing it opens the library.
  While the palette is open the page narrows each library to 480 × 400 px just left of the dock, and wraps its
  header so the ✕ is never scrolled off sideways.
- **Dropdowns** step to the next option on each press, because a native `<select>` popup is browser UI the
  headset never sees. The status strip names the new choice.
- While the palette is open, the page gets `body.os-xr-editing`. That clamps `#dock-right` to 720 px so the
  toolbox's own scrollbar is the one the stick drives, and the desktop mirror shows the same shorter dock.
- Mode switching works from the palette while the session stays up. Two small guards make that safe in
  `viewport/scene/ride.ts`: leaving Test keeps the headset session's AI field, and the setup flag stays hidden
  while a session is up.

### Without a headset

`?xrpanels=1` (dev builds only) draws the same mirrors, driven through the same pointer, in a floating window
beside the real panels. The mouse buttons stand in for trigger and A, and the wheel for the stick.

## What a repaint costs

Each mirror repaints at most eight times a second, and only when something changed. It is marked dirty by a
MutationObserver, by `input`/`change`/`scroll` events, or by a once-a-second poll that catches lil-gui's `.listen()`
rows. The palette lets only one mirror serialize per frame. An unchanged serialization is dropped before any
decode or texture upload.

The palette's top strip reports each panel's sync+decode milliseconds, the SVG size, and whether the page's
`requestAnimationFrame` is still running. Every five seconds the same figures, broken down further, go to the
console as `[xr edit]`.

Measured in desktop Chrome on the development machine (2026-09-24, `?xrpanels=1`):

| Panel | Sync (clone + serialize) | Decode (async) | SVG | Nodes | CSS rules kept |
|---|---|---|---|---|---|
| Mode + View strips | 1.5–2 ms | 6–40 ms | 28 KB | 78 | 37 |
| Toolbox (Edit / Sculpt / Scene) | 2.5–4.5 ms | 6–14 ms | 24–29 KB | 60–77 | 74–90 |
| Legend (Surface view) | 1.2–1.5 ms | 7–26 ms | 12–13 KB | 76–86 | 15 |

The first decode of a session is slow: 140–700 ms, which includes lil-gui's embedded glyph font. The toolbox was
forced to repaint about seven times a second for 2.5 s: no frame went over 17.5 ms at 60 Hz, and there were no
long tasks.

## Known gaps

- **Input the DOM cannot fake.** Text and number entry need a keyboard; numbers can still be scrubbed by
  dragging. Colour and file pickers are desktop-only, and hover-only tooltips never appear.
- **Popup menus.** The File and History menus and the right-click menus open in the page body, outside every
  mirrored panel, so the headset does not show them. Undo and redo are plain buttons and work. Dragging a
  library tile up into the Palette is an HTML drag the synthetic pointer cannot make; clicking a tile still
  arms it.
- **Modifier keys.** Shift and Ctrl (range select, height drag, toggle) have no controller binding yet.
  Double-click, and so edge-loop selection, is not sent either.
- **Mouse wheel.** It is not sent, so tools that use it (prop ghost rotation, loop-cut slide) cannot be adjusted
  from the hand.
- **Floating targets.** The eye-through-the-surface-point rule picks what the dot covers. A handle floating well
  in front of the surface is picked only when the dot sits over it from the eye, not when the laser merely passes
  through it.
- **Scale and the world.**
  - Fog distance and depth precision scale with the player.
  - Remote players keep seeing the body where it was when EDIT opened, at life size.
- **Rendering.** `vh`/`vw` inside a panel resolve against the image, not the window. `:hover` styling is
  replaced by the palette's own highlight.
