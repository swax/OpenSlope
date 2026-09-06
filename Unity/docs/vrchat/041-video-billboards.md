# 041 — Video Billboards (YouTube → in-world screens)

Stream a video (e.g. a YouTube URL, resolved client-side by VRChat) onto the course's billboard **screens**.
SSX billboards are welded into the merged static `Props` mesh with **shared atlas materials**, so a single
screen face can't be retextured on its own — the video would smear onto every prop sharing that material, and the
face isn't an isolable object. Instead we lay a **video-ready quad** flush over each screen's front face and feed
them all from **one** AVPro player. Verified against locally converted levels.

**Where each quad goes is not decided here.** Finding a board's ad face is engine-agnostic geometry, so it lives
in snowknife: `snowknife billboards` measures the rectangles off the placed prop geometry and writes
`Billboards.json`, which `snowknife gltf` folds into `manifest.Billboards`
([Snowknife docs/034](../../../Snowknife/docs/034-bundle-pipeline.md)). Slopesmith authors the same file for a
mountain of its own and draws a reference course's ([Slopesmith docs/051](../../../Slopesmith/docs/051-video-screens.md)).
This chapter owns what Unity does with the result: the quad catalog, the one AVPro player, and the wiring.

Code: `Importer/Editor/BillboardScreenBuilder.cs` (the neutral screen-quad catalog, built at import),
`VRC/Video/VideoBillboards.cs` (the Udon controller),
`VRC/Shaders/VideoScreen.shader` (the unlit/emissive screen shader), and
`VRC/Video/Editor/VideoBillboardsSetup.cs` (the `OpenSlope/Setup/Video Billboards` menu that builds the
`VideoBillboards` scene object). Validated on a locally converted level: a test pattern renders correctly oriented and flush inside
the bezel on a cataloged screen's front face.

## Why overlay quads, not a material swap

The world ships as one asset bundle of the active scene; only scene-reachable assets are packed. The billboard
geometry lives inside the merged `Props` mesh (submesh per atlas material), so:

- assigning the video texture to "the billboard's material" hits **every** prop on that atlas slot;
- the screen face is welded in with atlas UVs — not a grabbable object.

So we overlay a fresh quad ~0.1 m proud of the face. The merged world is untouched; only the quads we choose to
drive carry video.

## Where the screens come from

The rectangles are measured by **snowknife**, not here: `snowknife billboards` searches the placed prop geometry
for each board's ad face — grouping by texture page and facing, gating on the UV span that tells a single ad
image from a tiled structural face, splitting a cluster into one screen per board, and turning each toward the
riders — and writes `Billboards.json`; `snowknife gltf` folds it into `manifest.Billboards`. The recipe, the
family list, and what it measures on converted levels are documented at its source
([Snowknife docs/051](../../../Snowknife/docs/051-billboard-screens.md)). An authored mountain supplies the same
section from screens placed in Slopesmith ([Slopesmith docs/051](../../../Slopesmith/docs/051-video-screens.md)).

Each record is an oriented rectangle in root-local **mesh space** (SSX centimetres, X negated) — `Center`,
`Normal` (out of the screen, toward the viewer), `Up`, `Width`, `Height`, plus a `Name` and the `Family` to
group by.

Screen detection happens in Snowknife while canonical prop identities and texture-page indices are intact.
That avoids reconstructing them after `TextureArrayPacker` combines pages into `Texture2DArray` submeshes and
`StaticChunker` moves static triangles into `Props_chunk_*` children.

## The quad (BillboardScreenBuilder)

`Importer/Editor/BillboardScreenBuilder.cs` is the thin half: one quad per manifest record, under
`Billboards/<family>/Screen_<name>`, **disabled** — the hidden catalog a platform's video setup consumes. The
family qualifies the object name because instance ids **repeat across families** (`Ad_A_1000` and
`EABigBottom_1000` are different boards) and the screens are later flattened into one container.

Three things about the quad are Unity's own:

- **It sits in its own frame.** The GameObject is placed at the record's centre with
  `LookRotation(normal, up)` — local `+X/+Y/+Z` are the quad's right/up/front — and the mesh is stored **local**
  to it. Leaving absolute verts on an identity transform would park every screen's pivot at the world origin,
  sending the move gizmo, the hierarchy double-click frame and every `transform.position` read a kilometre
  off-board.
- **U is reversed** (`u=0` at `+X`): `+X` (= `up × normal`) points to the *left* of someone facing the front, so
  a naive `0..1` map shows the video mirrored. V is left as-is — panel top = image top, matching the AVPro
  no-flip orientation. The mesh is built **double-sided**.
- **It is built under `Level` and then re-exposed at the map root.** Mesh-space centimetres are the quad's local
  coordinates that way (the level root carries the −90°X rotation and the 0.01 scale for it, as it does for
  every bundle placement), and `LevelImporter` reparents the catalog to `OpenSlope_Map/Billboards` afterwards —
  everything under `Level` belongs to the optimization passes, and a video screen is neither static world
  geometry nor an atlas participant.

The catalog rebuilds with the map. **`OpenSlope/Refresh/Billboard Screens`** re-catalogs from the bundle without
a full import (after re-running `snowknife billboards` + `gltf`, or to throw away hand-edited screens) and hands
the result straight to the video system.

## Screens and the culling / chunking work

The screens live at `OpenSlope_Map/VideoBillboards/Screens` — **outside** `OpenSlope_Map/Level`, so neither the static chunker
nor the texture-array packer touches them. What they cost, and what gates them:

- **Nothing, by default.** Video is opt-in: with an empty queue the quads are inactive and players see the original
  billboards.
- **One decode, any number of screens.** The zero-scale `_Driver` writes into the shared material asset, so screen
  count doesn't touch the AVPro cost — the expensive part. The Jukebox's per-player **Screens: ON/OFF (for me)** stops
  it; neither the Settings nor the Diagnostics board has a video row.
- **Frustum culled for free.** Each quad is its own renderer with tight bounds.
- **Range culled with their boards.** `VideoBillboardsSetup.RegisterScreensWithCuller()` appends the screen
  renderers to `ObjectCuller` after the catalog is consumed, so a screen gates at the same distance (Quest 600 m /
  PC 1200 m, wide tier 1200/3000) as the `Props_chunk_*` its billboard sits in. Without it the screen **outlives its
  board** past the cull range, and only the distance fog — whose end `ApplyFog` pins to the active cull range — hides
  the difference; a fog-disabled level would show unlit quads floating where the boards were dropped.
  `ObjectCullerSetup` gathers from `Level/{Spinners, BreakableLogos, Physics, AnimatedProps, Emitters}` and the
  chunk children, so it can never pick the screens up on its own, and it runs before they exist. Rebuilding the culler
  (`OpenSlope/Optimize/Chunk Static Geometry`) drops them, so that menu re-registers afterwards.
- Registration skips the "currently drawn" filter the placed-object roots use — the screens are **deliberately
  inactive** — and prunes destroyed entries, so a re-catalog can't leave the culler holding dangling references
  to the previous screen set.

## The VideoBillboards system

`OpenSlope/Setup/Video Billboards` (VideoBillboardsSetup) builds, under `OpenSlope_Map/VideoBillboards`:

```
VideoBillboards (GameObject)
├─ VRCAVProVideoPlayer            // the ONE decoder (autoPlay off, native loop OFF — the queue advances on OnVideoEnd)
├─ AudioSource + VRCAVProVideoSpeaker + VRCSpatialAudioSource  // audio: speaker.mode StereoMix; 2D (spatialization off)
├─ VideoBillboards (Udon)     // the local renderer: PlayUrl / Seek / StopVideo, driven by the Jukebox's Jukebox
├─ _Driver                       // zero-scale (invisible) quad; its VRCAVProVideoScreen (useSharedMaterial) writes
│                                //   the live frame into the shared VideoScreen.mat every frame
└─ Screens                       // container; drag catalog Screen_* quads in here (hidden until a URL is set)
     └─ Screen_Ad_A_1000, Screen_EABigBottom_2032_0, …
```

**What plays is decided elsewhere.** This object is just the **renderer**; the shared queue, the now-playing video, the
scrub bar and seeking all live on the **Jukebox** (`Jukebox`, docs/vrchat/049), which drives this player. This setup
just stands up the player + screens.

- **Video is OPT-IN.** With nothing playing (an empty queue AND an empty inspector `url`) the screen quads stay
  **hidden**, so players just see the original SSX billboards. Queuing a video at the Jukebox (docs/vrchat/049) — or setting
  the inspector `url` for the standalone fallback — reveals the quads and plays it. So the setup seeds **no default URL**.
- **One player → one shared material → every quad shows the one stream.** VRChat caps simultaneous AVPro
  instances, so a single shared player is both required and ideal for "same video on many screens". The
  `VRCAVProVideoScreen` lives on a hidden `_Driver` quad with `useSharedMaterial = true`, so it writes the frame
  into the material **asset** (`Assets/OpenSlope/VRC/VideoScreen.mat`) — every quad referencing it updates from that
  one decode. The driver is a real quad (the screen component needs a `Renderer`) but scaled to zero so it draws
  nothing.
- **`VideoBillboards`** (UdonSharp, sync None — the local renderer): on `Start` it assigns the shared material to
  every `MeshRenderer` under `Screens` and hides them; thereafter the Jukebox's `Jukebox` drives it —
  `PlayUrl(url)` shows + plays the now-playing video, `Seek(t)` jumps the local decode to the shared playhead, and
  `StopVideo()` stops + hides. It exposes `CurrentTime()` / `Duration()` for the scrub bar and reports `OnVideoEnd` /
  `OnVideoReady` / `OnVideoError` back to the queue (which, on the owner, advances). It sits on the **same GameObject**
  as the player because the video events only fire on Udon behaviours on the player's object. `url` is a `VRCUrl` —
  VRChat forbids building one from a string at runtime, so every queued URL comes from a `VRCUrlInputField`. With **no
  queue** assigned it falls back to looping its inspector `url` standalone.
- **Native loop is OFF.** The queue is the brain — it must see `OnVideoEnd` to pop the next item (or loop the current
  one itself when the queue is empty). A native loop would silently restart the stream and the queue would never advance.
- **`OnVideoError` is hardened** against the retry storm that shows up in the VRChat log: a `_retryPending` guard
  keeps **at most one** retry scheduled at a time (a failing `PlayURL` raises the error repeatedly, and naive
  `SendCustomEventDelayedSeconds` calls would stack into a runaway loop of yt-dlp resolves that trips the
  rate-limit). `InvalidURL` isn't retried (a bad URL won't fix itself); `AccessDenied` backs off to `2×
  retrySeconds` and logs the likely cause (untrusted-URL setting / restricted video); other transient errors retry
  at `retrySeconds` (default 15 s).
- **UX = parenting + re-run.** Drag a `Screen_*` from the `Billboards` catalog under `VideoBillboards/Screens` and
  re-run `OpenSlope/Setup/Video Billboards` (idempotent — it never deletes the object or your screens, just re-asserts
  wiring and lights up whatever is under `Screens`). At runtime `Start` also assigns/activates, so a freshly
  dragged screen plays on next entry even without a re-run.
- **Screen shader** `OpenSlope/VideoScreen` (`VideoScreen.shader`): **unlit + Cull Off**, emissive (outputs the texture
  at full brightness so the screen reads bright in shade). `_MainTex` defaults to **black** (dark until the stream
  loads). No V-flip and no gamma by default — matching VRChat's own `Video/RealtimeEmissiveGamma` (the AVPro player
  normalises orientation; the SDK screen material ships `_ApplyGamma = 0`). Both are exposed as `_FlipV` /
  `_ApplyGamma` toggles in case a particular source needs them.

### AVPro API (confirmed against the installed SDK by introspection)

- `VRC.SDK3.Video.Components.AVPro.VRCAVProVideoPlayer` — methods `LoadURL`, `PlayURL`, `Play`, `Pause`, `Stop`,
  `GetDuration`, `GetTime`, `SetTime`; serialized fields `videoURL` (VRCUrl), `autoPlay`, `loop`,
  `maximumResolution`, `useLowLatency`.
- `VRCAVProVideoScreen` — `[RequireComponent(Renderer)]`; serialized `videoPlayer`, `materialIndex`,
  `textureProperty` (`_MainTex`), `useSharedMaterial`. Set via `SerializedObject` from the menu.
- `VRCAVProVideoSpeaker` — `[RequireComponent(AudioSource)]`; serialized `videoPlayer` + `mode` (enum
  `ChannelMode`: `StereoMix`=0…). Spatialization/volume are on the AudioSource, **not** the speaker (the prefab's
  Gain/Far/Near fields belong to a separate `VRCSpatialAudioSource`).
- **Pair the AudioSource with a `VRCSpatialAudioSource`** (the project rule — every AudioSource is 1:1 with one).
  Without it VRChat force-spatializes the source at load with a default 40 m rolloff that discards our 2D setting,
  and the build validator warns. We set `EnableSpatialization = false` (one shared source → 2D, heard everywhere,
  not pinned to this object's origin) + `UseAudioSourceVolumeCurve = true` — same recipe as `MusicDirectorSetup`.

### Music ducking — video audio wins

The video speaker is a 2D bed heard everywhere, so it would otherwise pile on top of the two music layers
([039](../039-race-audio-runtime.md)): the start-area background theme (`MusicDirector`) and the race
PathFinder song (`RaceMusicDirector`). So while a video is sounding, the music **ducks to silence** — the
same idea as the game's INTRODUCK, reusing the proven duck channel:

- `MusicDirector` already carries a race-driven `duck`; we add a **second, independent** `videoDuck` and
  multiply them (`volume · duck · videoDuck`), so the race duck and the video duck never overwrite each other —
  whichever is lower silences the bed.
- `RaceMusicDirector` gets a matching `externalDuck` folded into its source volume on top of the
  mount/dismount fade.
- `VideoBillboards` drives both every frame in `Update`: it eases `_musicDuck` 1 → `musicDuckTo` (default
  **0** = silent; set ~0.1 to leave a faint bed) over `duckFadeSeconds` (1 s) whenever a video is **active**, and
  back to 1 when none is. "Active" = a URL is set and the screens are shown, and it **survives transient
  errors/retries and loop gaps** (so the music doesn't pop back in between loops) but clears on `InvalidURL` (no
  audio will ever come, so let the music return).
- All local: the directors, the player, and this controller are all `sync None`, so each client ducks its own
  music when its own video is playing — no networking.
- The setup menu auto-finds both directors in the scene and fills the `musicDirector` / `raceMusicDirector` slots
  (only if empty, so a manual choice survives a re-run); both are optional — absence just means no music to duck.
- **Alternative model (not built):** a spatial speaker per main screen — audible only near a jumbotron, music left
  playing elsewhere — for course-side ambience instead of the current shared, world-ducking soundtrack feel.

## Gotchas

- **ClientSim doesn't play video** — its AVPro stub is a no-op, so the screen stays black in Play mode. Verify the
  pipeline in-editor by writing a test texture into `VideoScreen.mat`'s `_MainTex` (what AVPro does at runtime);
  real video only plays on a **PC upload**.
- **Orientation** — no flip/gamma is applied; the AVPro player normalises orientation and the horizontal mirror is
  handled in the quad's UVs (see the recipe). If a source ever looks wrong, toggle `_FlipV` / `_ApplyGamma` on the
  material.
- **Quest/Android** — AVPro has codec limits and caps YouTube ~720p; some videos won't play. PC is unrestricted.
- **One player** — don't add a player per screen; share the single one (`useSharedMaterial` fans it out). Two video
  players in the scene fight over VRChat's single AVPro slot — the second preempts the first (looks like "plays a
  few seconds then goes black").
- **Untrusted URLs** — a direct CDN `.mp4` (e.g. the old `commondatastorage.googleapis.com` sample) is an
  *untrusted* domain and needs the viewer's "Allow Untrusted URLs" on — and that sample now 403s anyway, so it
  never loads. **YouTube/Twitch/etc. are trusted** and play without that toggle, so prefer them. A specific YouTube
  video can still fail if it's age/region/embed-restricted (resolves but the stream is denied) — try another.
- **yt-dlp** — YouTube URLs are resolved client-side; resolution occasionally breaks until VRChat ships an update
  (outside our control).
- **Disabled catalog quads still ship** in the bundle (cheap — tiny meshes — but a build step could strip the ones
  not parented under `VideoBillboards`).
- **A map with no screens is not a failure.** A demo or non-SSX map whose bundle carries no `Billboards` section
  simply gets no catalog, and the move into `VideoBillboards/Screens` is a no-op — the video object stands up
  with nothing to drive.

## How to use

0. **Have the screens in the bundle.** `snowknife import` (or `snowknife billboards <mapDir>` on an older
   extract) writes `Billboards.json`; `snowknife gltf` puts it in the manifest; `OpenSlope/Load` builds the
   `Billboards/` catalog from it. A map imported without it has no screens to drive.
1. **`OpenSlope/Setup All`** does the rest: it stands up `VideoBillboards` (the one AVPro player) and the
   **Jukebox** (the shared queue) by the start gate, then **moves every catalog screen under
   `VideoBillboards/Screens` and bakes** the live `VideoScreen` material onto them — so all billboards are video-ready with no manual dragging.
   It's idempotent (`Screens` is cleared + repopulated from the catalog, and once consumed there is no catalog
   left to move, so re-running can't duplicate). On a brand-new project the Udon program assets are created on the first pass — run `Setup All` again after
   the recompile to finish. The screens don't need to be active in the editor; the Udon shows/hides them at runtime by URL.
2. Manual / piecemeal alternative (e.g. to curate a subset): `OpenSlope/Setup/Video Billboards` (run twice on a
   fresh project — first bootstraps the Udon program asset, second builds the object), then drag the `Screen_*`
   quads you want out of the `Billboards/` catalog into `VideoBillboards/Screens`. To re-apply the
   material after hand-editing screens, use **`OpenSlope/Setup/Rebake Video Screens`** (it doesn't rebuild the player / Jukebox);
   **`OpenSlope/Refresh/Billboard Screens`** re-catalogs from the bundle and consumes it again.
3. Upload to PC (ClientSim won't show video). In-world, walk to the **Jukebox behind the start gate** — point at
   **▶ Add video** for the tooltip, press Use, and VRChat's keyboard opens; enter a YouTube URL and it joins the shared
   queue (and plays at once if nothing's playing). When a video ends the next is popped for everyone; drag the scrub bar
   to seek. Empty queue → players see the plain billboards. (Or pre-set the `VideoBillboards` component's `url` in the
   inspector for the standalone fallback.) See docs/vrchat/049.
