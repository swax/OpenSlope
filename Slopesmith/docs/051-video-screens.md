# 051 — Video Screens

A **screen** is the flat rectangle on a course where a runtime plays video: the ad face of a billboard, the
drum of a jumbotron, a wall you decided to project onto. Slopesmith authors them, `snowknife billboards`
measures them off a shipped course, and both write the same file — `Billboards.json` in the map folder.

Code: `core/props/screen.ts` (the pose resolver + the fit), `app/props/screens.ts` (the authoring
operations), `app/viewport/scene/screens.ts` (drawing + picking), `core/export/level.ts`
(`buildBillboardsJson`), `core/reference/screens.ts` (reading a reference course's own). Consumers:
`Snowknife/Bundle/BillboardBundle.cs` → `manifest.Billboards`, `Unity/Importer/Editor/BillboardScreenBuilder.cs`
→ the quad catalog VRChat's video system drives ([Unity docs/vrchat/041](../../Unity/docs/vrchat/041-video-billboards.md)).

## Why a rectangle and not geometry

An SSX billboard is welded into the merged static prop mesh with shared atlas materials, so no engine can
retexture one board's face on its own — the video would smear onto every prop sharing that material, and the
face is not an isolable object. Every consumer therefore lays its **own** quad flush over the face, and all it
needs from the map is *where that face is*: a centre, a normal, an up, a width and a height.

That is engine-agnostic geometry, so it is settled once, outside every consumer. Nothing about a screen ships
in the mountain's own mesh: the export writes the rectangle and the runtime with video builds the quad.

## The two kinds

|  | Stored in | Rides the board | Made by |
|---|---|---|---|
| **Attached** (`prop` set) | the placement's own frame | yes — move, turn or resize the board and the screen follows | **＋ add screen** on a selected prop |
| **Free-standing** (no `prop`) | world/editor space | n/a | **Add screen** in the Props launcher |

The attached case is the one that matters in practice: a billboard is a prop you placed, and marking it as a
screen should not become a thing you keep re-fixing every time the board moves. Storing the pose in the prop's
frame — and resolving it through `screenPose` at every read — is what makes that hold. `PlacedProp.scale`
multiplies the screen's size and offset exactly as it multiplies the geometry the screen covers.

A free screen is the escape hatch: a rectangle in world space you drag onto whatever you meant it for. Deleting
a board deletes the screens attached to it; a free screen belongs to nobody and stays.

## Fitting one to a board

`fitScreenToMeshes` is the local half of the recipe `snowknife billboards` runs over a whole course, applied to
one model's own geometry (in the prop's frame, so the result is directly storable):

1. Group triangles by **(submesh, quantized facing)**. A submesh is one texture page, which is what separates a
   board's ad image from the structural frame welded right behind it — the two share a plane, and grouping by
   facing alone unions their UV boxes and loses both.
2. Drop anything steeper than `|n.y| > 0.6` — a roof or the ground is not a screen.
3. Prefer a group whose UV box spans a **single, non-repeating** showing of its page (0.4–1.2 on both axes):
   that is an ad image. A tiled structural face repeats; a flip-book cell spans a fraction. With no such group,
   the largest near-vertical face of any texturing wins, which is right for an authored panel that carries no ad
   convention at all.
4. Size the quad to that face's in-plane extent and sit it `SCREEN_PROUD` (0.1 m) off the front.
5. **Which side is the front** is decided by where the author is looking. A board is two-sided and its winding
   is an authoring coin-flip; the camera is the one signal that always means something here. (The detector uses
   the course for the same decision — it has no camera, and the riders are what its boards face.)

**↻ refit to board** re-runs it, which is the repair when a board is revised or replaced.

## Authoring

Everything is in **Props** mode.

- Select a prop → **Video screens** → **＋ add screen**. The fit lands on its board; the screen is selected.
- Nothing selected → **Add screen** in the launcher row (beside Add rail pipe / gem / light) drops a free
  screen at the view centre, facing you.
- A selected screen shows its own inspector: name, width, height, turn, tilt, **nudge out / in** along its own
  normal (the one adjustment a fitted screen usually wants), refit, and delete. The shared translate gizmo moves
  it; on an attached screen the drag is written back through the board's frame, so dragging cannot silently
  detach it.
- `Delete` removes the selected screen.

Screens ride the top-bar **Sources** view with the light bulbs and the sound speakers, because that is what
they are: a marker at every place the world emits something, wanted while you are asking that question and
clutter the rest of the time. Adding one turns the view on, the way Add light does.

With **Sources on**, every screen draws an opaque classic colour-bar test card with a lit border, a stub out of
the front face showing which way it looks, and a **movie marker** at its centre. The card is the coverage mask:
any strip of the original billboard still visible around that solid rectangle is a bad fit. The movie marker is
one constant-screen-size icon in the same batched cloud the bulbs and speakers use, because a board 400 m down
the run is a few pixels of panel and would otherwise be missed. Clicking the marker selects the screen exactly
as clicking its panel does; selection turns only its border and movie marker yellow/bold because every card is
already opaque. Names are deliberately not drawn: a course carries dozens of boards, and a field of floating
labels buries the thing it annotates — the marker says WHERE and the inspector says WHICH.

The shared **Users → Jukebox** is the runtime exception. With a working local Yattee bridge, its one page-level
decoder portal is positioned over the Jukebox panel outside a ride. During a ride every authored and reference
screen shares that decoder's `VideoTexture`; the portal parks offscreen without detaching the decoder.
With Sources off, only those live video quads draw and they do not steal clicks. Turning Sources on replaces
the live picture with the opaque test card and adds borders, facing stubs, movie icons, and screen pick targets;
turning it off returns immediately to video. An empty queue, decode failure, or turning local playback off
removes the live material immediately; the test cards remain visible only when Sources is on. Queue state is ephemeral
server activity rather than mountain content. Audio stays on the one underlying media element as ordinary
non-spatial page output; duplicating the picture onto screens never duplicates or positions sound. The server
syncs the public URL, queuer, queue and playhead, while every browser keeps and uses only its own local Yattee
credentials. Mute and volume are local browser preferences; pause/play, seek, and queue changes are shared.

If Yattee is unavailable, Jukebox uses YouTube's DOM iframe for panel playback and ordinary page audio. The
iframe remains under that stable portal when the disposable Users UI is rebuilt, because reparenting it would
destroy its browsing context and stop playback. It cannot supply pixels to `VideoTexture`, so this fallback
deliberately leaves every in-course screen dark, including in WebXR, while preserving the same shared transport
and local mute/volume controls.

## Reading a reference course's screens

Loading a reference level also loads its `Billboards.json` (`/api/level` → `billboards`), and the same layer
draws those in grey under `refRoot`. Click either its panel or movie icon to select it read-only. The inspector
shows the screen `Name`, expanded native model `Family`, original `Instances.json` row, texture `Page`, and
measured size. Every reference panel gets the same colour-bar coverage card as an authored one while Sources is
on; selecting one highlights it but gives it no transform gizmo. They are inspected, not adopted — like the
level's sky and its glare. During in-ride Jukebox
playback they receive the same active texture as authored screens. Seeing where a shipped course already carries
screens, and exactly which source billboard each rectangle names, is what tells an author where their own belong.

An extracted folder gets that file from `snowknife import` (or `snowknife billboards <mapDir>` on a folder
extracted before the contract existed).

## Billboards.json

Contract: [`course/billboards-v1.schema.json`](../../Snowknife/Snowknife/schemas/course/billboards-v1.schema.json).
Everything is SSX **mesh space** — centimetres, Z up, X as the bundle stores it — the frame the manifest and
every downstream consumer already speak. `editor → mesh` is `(100·x, −100·z, 100·y)`, a proper rotation, so
directions map through unchanged and cross products keep their handedness.

```jsonc
{
  "Schema": "openslope-billboards/v1",
  "Source": "authored",              // or "detected" — see below
  "Screens": [{
    "Name": "Jumbotron",             // unique; a consumer names its object after it
    "Family": "Mdl_Billboard_Ad_A",  // the board it sits on / an author grouping; consumers group by it
    "Center": [0, -200, 600],
    "Normal": [0, -1, 0],            // out of the screen, toward the viewer
    "Up": [0, 0, 1],
    "Width": 1000, "Height": 500     // centimetres
  }]
}
```

**`Source` is load-bearing.** `snowknife billboards` writes `detected`; Slopesmith writes `authored`, and the
detector refuses to overwrite an authored document without `--force`. A hand-placed screen set is the author's,
not the tool's — running `snowknife import` again over a folder someone has edited must not silently discard it.

The file is a `gltf` input: `snowknife gltf` folds it into `manifest.Billboards` and the Unity staging step
skips it, because the importer reads only the bundle.

## Verification

`test/video-screens.test.ts` (fast tier) covers the things that have to hold: playback and Sources retain
their independent panel/inspection/picking gates, Sources gives every screen an opaque colour-bar coverage card
without disturbing icon selection, detected identity survives reference decoding, and an attached screen rides its
board through move / turn / resize, the fit lands on the ad face rather than the tiled slab behind it and takes
its front from the viewpoint, and the export puts the rectangle in mesh space exactly where the editor drew it —
checked by decoding the written document straight back through the reference reader. It also asserts a screen is
an ordinary register (docs/039) and survives a save/load round trip, including one saved before screens had ids.
