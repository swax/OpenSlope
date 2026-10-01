# 068 — VR Editing

The wrist watch in a WebXR session has an **EDIT** button. Turning it on does three things:

- **The palette.** A palette laid out around the watch, in the watch's plane, shows the editor's own panels:
  - the **current toolbox**, to the watch's left;
  - the **File / undo**, **Mode** and **View** strips stacked above both;
  - the **colour keys**, to the watch's right;
  - the **Texture** or **Prop Library**, right of the toolbox and below the watch.

  The panels are the real ones, not VR copies: switching to Sculpt from the palette rebuilds the actual Sculpt
  toolbox, and that is what the palette then shows.
- **The right hand is the editor's mouse.** A short translucent laser comes out of it. Where it points at the
  mountain, the editor hovers exactly as it does under a desktop mouse: brush ring, highlighted prop, vertex under
  the cursor. The **trigger** is the left button and **A** the right.
- **Edit flight.** The player is no longer affected by gravity or collisions. The sticks fly, one grip drags the
  map, and both grips together make the player bigger or smaller, turn the map, and drag it.

While EDIT is on, two watch buttons change job: RESTART becomes **MOVE UI**, which shows the palette's placement
bar, and 3RD PERSON becomes **MIXED REALITY**, which shows the room in place of the sky in a headset that offers
passthrough (below).

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
| MOVE UI (watch, in RESTART's place) | Show or hide the palette's placement bar. Hidden by default. |
| MIXED REALITY (watch, in 3RD PERSON's place) | Passthrough on or off. Dimmed in a headset that does not offer it. |

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

**Sprites in a scaled rig.** A desktop camera drops its parents' scale from its view matrix, but WebXR's eye
cameras keep the rig's (three's `WebXRManager.updateCamera`), so in a headset one view unit is the player's size
in metres. Anything that adds a world size in view space then grows with the player:

- The effect particles (`particle-batches.ts`) now convert their width by the view matrix's own scale. Before
  that, a 20× player saw the level's fog banks 20× as wide. They filled the view with blue-grey haze, and their
  overdraw made the headset choppy.
- three's `Sprite` does the same with its scale. Remote players' name tags and chat bubbles divide by the
  viewer's scale to stay the size they should be (`remote-players.ts`). The editor's other sprites, such as
  course markers and peer labels, still grow with the player.

EDIT can be turned on only on foot, and mounting the board turns it off. Carrying the board when it is turned on
drops the board. T-POSE is unavailable while EDIT is on: a calibration measures a life-size body standing on the
floor. RESTART and 3RD PERSON come back when EDIT is turned off.

**Both mountains, all of them.** A headset session puts away the mountain it is not riding, as a desktop ride
does. While EDIT is open that mountain comes back, as the desktop editor shows both, and closing EDIT puts it away
again (`showOtherMountain` in `viewport/scene/ride.ts`). The ride's draw distance is off while EDIT is open too:
nothing is dropped past it, and nothing is hazed. The fog itself is held, pushed out of reach, rather than removed
(`RangeCull.setRange`'s `holdFog`), because removing a scene's fog recompiles every fogged material, which would
stall the headset each time EDIT opened and again when it closed.

**What others see.** While EDIT is open, other people see the desktop editor's avatar: standing at life size
under the headset, facing where it looks, with the tracked hands on it (`editPlayerPose`). The walk pose would
not do. The walker waits where EDIT began, so the body stayed there while the head and hands flew off with the
rig. A grown rig also holds the hands metres from the head, so they are brought back to life size about it.

## The right hand as a mouse

The editor's pointer router picks from a client pixel. It casts `stage.camera` through that pixel, and it
measures vertex, edge and marquee picks in screen pixels around it. So the hand drives that same path
(`ride/xr/world-pointer.ts`) instead of teaching every tool a second input model:

1. The controller ray is met with the first thing on it the editor picks (`editAimHit` in
   `viewport/scene/ride.ts`):
   - the authored terrain or the loaded reference, through the same BVH picks a mouse hover uses;
   - a prop, light, source marker, rail, prop line node, gem, screen or course knot, through the editor's own
     scene picks;
   - a move-gizmo handle (`Stage.gizmoHandleHit`).
2. That point is projected through the camera the router casts from. WebXR keeps that camera on the headset's
   pose.
3. Pointer and mouse events go to the canvas at the resulting client position.

Hover, click, drag, the gizmo and box select then run exactly the code a mouse runs.

What the router sees is therefore the **eye's** ray through where the hand points, not the hand's own ray. The
two meet at that point, and the cursor dot is drawn there. So whatever the dot covers from the eye is what gets
picked. Where the ray meets nothing, a far point along it stands in.

The first pass met the ray with the mountain alone. Aimed at a prop, the laser went on to the ground behind it,
and the eye's ray to that ground passed beside the prop by as much as the hand sits from the eyes. Particle
volumes are still left out, because their bounds enclose the props and ground the laser is usually aimed at.

The router and three's TransformControls capture the pointer on a press. A synthetic pointer is not one the
browser tracks, and a standalone headset browser may have no mouse at all. So capture calls are made inert for
the duration of each dispatch, and the per-frame moves are what keep a drag going.

### Clicks and reach

- **Click slop.** The router turns a press that moves 4 px into a drag, which in Props and Edit is a box select.
  Pulling a trigger turns the hand by a degree or so, which is well over 4 px, so most clicks became tiny box
  selects that selected nothing. A press now holds the cursor where it went down until the aim, seen from the
  eyes, has left that point by 2° (`CLICK_SLOP` in `ride/xr/world-pointer.ts`). A release before then is a click
  on the press point. Past it the press is an ordinary drag, so a sculpt or paint stroke starts 2° late.
- **Pick radii.** Point and edge picks measure their radius in the page canvas's pixels: 16 px for a corner, 14
  for an edge. In a headset that canvas is the desktop window stretched over the whole field of view, so how far
  a radius reached depended on the window's size. Each of those pixels is now worth at least 0.15° of the view at
  the cursor (`headsetPickRadiusPx` in `viewport/input/mesh-picking.ts`): about 2.4° for a corner and 2.1° for an
  edge. A radius is never smaller than the desk's.

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

Full 3D needs the free centre. At the desk a corner's default Surface frame hides it, and World or Shift brings it
back. A headset has no Shift, so there the Surface frame keeps the centre, and a point, edge or cell moves in 3D
by it exactly as a prop does. It is a free move, never a slide (`beginSlide` in `gizmo/transform.ts`); the arrows
and the tangent pad still slide.

**Screen-constant handles.** Handles sized in pixels (`Stage.worldPerPixel`) measured their distance from
`camera.position`. In a headset that is the head's offset inside the rig, not where the head is, so a point far
out on the mountain got a marker the size of a house. They now measure from the camera's world position and count
the eye buffer's pixels. At that true size the selected point's yellow ball was a speck. It first took the full
size of the gizmo's centre handle, which hid the centre: the gizmo's yellow hover highlight landed on a yellow
ball of the same size. It now takes half of it (`Stage.pointMarkerRadius`), so the translucent centre shows round
the ball and lights up under the laser, as a prop's does. The desk keeps its six pixels.

## Mixed reality

The watch's **MIXED REALITY** button takes 3RD PERSON's place while EDIT is on. It works only in a headset session
whose runtime offers `immersive-ar`, which on a Quest means the passthrough cameras; elsewhere it is dimmed. Once
the headset is showing passthrough, the skybox is put away and the room shows wherever the mountain is not.
Turning it off, or leaving the headset, brings the sky back as it was. The skybox change is not saved as a view
preference. (It began as a View strip button, which the palette showed; the watch holds it now, since it is a
headset control rather than a view of the mountain.)

- **How the room shows.** In an `immersive-ar` session three clears each frame transparent (`alpha-blend`) when
  the scene background is a plain colour, which the editor's is whenever no sky is drawn. The compositor fills
  those pixels with passthrough.
- **Why the session is swapped.** A session's mode is fixed when it is requested, and an opaque `immersive-vr`
  session never shows passthrough. So the button ends the session presenting and requests the other mode
  (`setMixedReality` in `ride/xr/session.ts`). The rig, the edit state and the palette carry across; only the
  session under them changes. The headset shows its own brief transition.
- **Activation.** Like any `requestSession`, the swap needs user activation. The press that asks for it is read
  from the controller's gamepad state, not a DOM event, so activation has to come from the real controller
  `select` behind it, which WebXR allows a browser to count. The request follows the old session's end, so that
  activation must still be live then. Whether the Quest browser allows this here is untested.
- **Failure.** If the new mode is refused, the old mode is requested again. Only if that is refused too does VR
  end, as it would from the watch.
- **Scope.** VR always starts as `immersive-vr`. Passthrough is only ever asked for from this button, and stays
  on until it is turned off or VR ends, riding included. Turning it off takes EDIT again.

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
   - scroll offsets, emulated by translating each scrolled element's children;
   - every box's size on the page (`pin`). The image lays out at one device pixel per CSS pixel. The page rounds
     borders to its own device pixels, so at a 1.75 ratio a 1 px border is 0.57 px on the page and 1 px in the
     image. Unpinned, each bordered button came out almost a pixel wider. The flex spacers gave the growth back,
     so the top bar's strips drifted left: Mode by 5 px and View by 7 px on the desktop, and further in the
     headset, where the highlight sat right of the icons and the strips' leading labels were cut off. Pinned, the
     strips land within half a pixel.

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
  the headset.
- **Around the watch** (`layoutAroundWatch`). The palette lies flat in the watch's plane, and its origin is the
  watch's top-left corner (`XR_EDIT_PALETTE_SEAT`):
  - The toolbox stands a gap left of the watch, top edges level.
  - The status, File / undo, Mode and View strips rise from just above both, left-aligned with the toolbox. They
    touch, so they read as one bar.
  - The colour keys stand right of the watch, top edges level.
  - Everything a mode switch changes grows away from the watch, so nothing above the watch or beside it moves.

  Earlier passes hung the palette on a seat of its own, below the hand and leaning away at 45°. It hung from its
  bottom edge, lowered by half its height along the grip's Y. Once the placement bar tilted it flat, that drop
  pointed straight through the palette, so each mode's toolbox height moved it nearer or further. The layout the
  bar pass settled on (toolbox beside the watch, menus over both) is now built from the watch instead.
- **Placement bar.** A strip over the palette's top strip carries IN / OUT, LEFT / RIGHT, UP / DOWN, BIGGER /
  SMALLER, TILT IN / TILT OUT and RESET buttons, and under them a readout of the seat (`ride/xr/palette-seat.ts`).
  It is for finding the seat by hand in the headset: the readout's position, tilt and mm/px are the constants
  above.
  - It shows only while the watch's MOVE UI is on, and is hidden by default.
  - Moves are 1 cm steps in the left grip's own axes, where IN is toward the eyes. Tilt steps are 2.5°, and TILT
    IN turns the top edge up toward the eyes. Size steps are 5%; the panels grow away from the watch, which keeps
    its size.
  - Holding a button repeats it.
  - The bar keeps its own size whatever the palette's size.
  - A moved seat is kept in localStorage with the defaults it was moved from, so it lapses once new defaults ship.
- **Libraries.** The Texture Library (Paint) and Prop Library (Props) stand right of the toolbox, on its bottom
  edge. Where that edge is too high for them to clear the watch and the colour keys, they stand lower instead.
  While a library is closed in its own mode, its pull-up tab (`dock-tab.ts`) stands there instead, turned
  upright; pressing it opens the library. While the palette is open the page narrows each library to 480 × 400 px
  just left of the dock, and wraps its header so the ✕ is never scrolled off sideways.
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

Pinning every box (2026-09-30) put the top bar's sync at 2.3–3 ms. Its SVG stayed at 28 KB, because the shared
declarations live in one rule and only each box's width and height are inline.

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
- **Floating targets.** The eye-through-the-laser-point rule picks what the dot covers. Scene objects and gizmo
  handles stop the laser, but a cage point or tangent handle floating off the surface does not. It is picked only
  when the dot sits over it from the eye, not when the laser merely passes through it.
- **Scale and the world.** Depth precision scales with the player.
- **Rendering.** `vh`/`vw` inside a panel resolve against the image, not the window. `:hover` styling is
  replaced by the palette's own highlight.
