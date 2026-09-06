# 061 — Basis port

Notes on porting the OpenSlope world off VRChat onto **[Basis](https://github.com/BasisVR/Basis)** — an
MIT-licensed, self-hosted social-VR framework (Unity 6 client + a standalone .NET server). This folder
tracks the port: how Basis is set up locally, what runs, how Basis differs from the VRChat/Udon
target the rest of this repo builds for, and what comes next.

Basis-side scripts we author live in the repo at [`Basis/`](../../Basis) (source of
truth), mirroring the `VRC/` convention, and are copied into the Basis Unity project. The Basis
client project itself is a checkout of the Basis repo, not part of this repo — the examples below
write `<basis>` for wherever you checked it out.

## What Basis is

- **Client**: a Unity **6** project — the cloned Basis repo *is* the project (you don't import a package).
  Runs desktop + OpenXR / SteamVR / Quest. The `developer` branch tracks Unity `6000.5.1f1`; the dated
  `long-term-support-*` branches lag a patch or two.
- **Server**: a standalone **.NET** console (`BasisNetworkConsole`) bundled in the same repo, talking
  LiteNetLib UDP. Ports: **4296/udp** (protocol), **10666/tcp** (health), **1234/tcp** (metrics). Client and
  server must share a version — build both from the same checkout.
- **Render pipeline**: **URP** (Desktop / Quest / Headless renderers under `Assets/OpenSlope/Basis/Settings`).
- **Scripting**: plain C# **MonoBehaviours compiled into a forked client** — no Udon interpreter, no API
  whitelist. (A sandboxed CIL interpreter, Cilbox, exists for scripts shipped inside downloaded content, but
  a total-conversion game builds into the client.)
- **Networking for world scripts**: `BasisNetworkBehaviour` — `SendCustomNetworkEvent()`,
  `OnNetworkMessage()`, `TakeOwnership()`, `OnPlayerJoined()`. Message/ownership based.
- **Worlds**: a scene containing a `BasisScene` component (with a `SpawnPoint`), either baked into the client
  or packaged as a `.BEE` bundle loaded by URL.

## Local dev setup

1. **Build the server** (needs the .NET SDK the `developer` branch targets — currently .NET 10):
   ```
   dotnet build "<basis>\Basis Server\BasisServerConsole\BasisNetworkConsole.csproj" -c Release
   ```
   Run `…\bin\Release\net10.0\BasisNetworkConsole.exe`. First run generates `config\config.xml`
   (password `default_password`, port 4296) plus a chat filter and content folders. Health check:
   `http://localhost:10666/health`.
2. **Run the client**: open your `<basis>` checkout in Unity 6, load the `initialization` scene, press Play.
3. **Connect**: at the Servers menu, pick the local `127.0.0.1:4296` entry (or enter it in the Advanced
   panel). Auth is DID-based; a first connection can log one "Authentication timeout" then succeed on retry.

The **world that loads on connect** is Basis's local default scene — currently the bundled NatureManufacture
meadow demo (`Assets/NatureManufacture Assets/…/Unity Standard Demo Scene.unity`), loaded locally via the
boot-content / `BundledContentHolder` mechanism, not downloaded from the server.

## What runs — a level loads as a full textured world

**OpenSlope Basis/Load/Map...** on a staged level folder (`Assets/OpenSlope/Maps/<level>`) builds the whole level into `Assets/TheScene.unity` in ~74 s:
terrain, props (crowd, grandstands, jumbotrons, the glass start-gate canopy, boost pads, ~440 renderers), all the
prop/terrain collision, the grind rails, the reset zones, the skybox, and a course-derived spawn — all textured
under the level's sky, walkable from the top-of-run start. See **Import pipeline** below; the source it reads
(`gltf/`, `Textures/`, `Skybox/`, `Patches.json`) is copied from the VRChat project into `Assets/OpenSlope/Maps/<level>/`.

On top of that geometry, Import All (with **Setup All**) brings across the **interactive layer**: the FX + audio pass,
the trick gems, the course-flow triggers (reset zones / teleports / boost pads), the knock-and-tumble physics props, the
breakable logos/signs, the animated-texture flipbooks, the object culler, and the player systems — the rideable board
rack at the gate, on-foot flight, and the start-gate Performance / Info boards. Each has its own section below, and the
Basis-specific patterns they share are in [the porting notes](062-porting-notes.md).

The importer nests the level under a `Level` child that reproduces the SSX→Unity correction — **rotate (270,0,0)**
(SSX is −Y-up, opposite-handed) and **scale 0.01** (SSX centimetres → metres), from `ImportConfig.RootEuler` /
`WorldScale` — then recenters so the terrain's middle sits near the origin (Quest precision):

```
OpenSlope_Map                      (identity, origin)
 ├ Level                     localEuler (270,0,0)  ·  localScale 0.01  ·  recentered
 │  ├ Terrain                52 OpenSlope/UnlitDoubleSided URP materials (GS lightmap), batched to 2 submeshes
 │  ├ Props / PropsShowoff / PropsRace   merged common and mode-specific prop meshes + diverted runtime props
 │  ├ BoostPads / ResetZones / … the *Marker trigger volumes
 │  └ TerrainCollision, Rails, CoursePath, …
 ├ Locations/PlayerSpawn     top-of-run, faced downhill (course-derived) → BasisScene.SpawnPoint
 └ Collision                 the board-facing colliders, re-exposed at the identity top
```

Post-transform the mountain is a **2.2 × 3.0 km footprint with 2.7 km of relief** — true mountain scale.

**Terrain shading.** The mountain is textured by `OpenSlope/UnlitDoubleSided`, a URP port of the Built-in-RP level
shader (repo source `Basis/Shaders/Unlit.shader`). It keeps the original's exact property/keyword
surface so a material the importer builds (`MaterialFactory`) lights up unchanged under URP — here the terrain
path: a diffuse tile per submesh plus the per-pixel PS2 **GS lightmap** blend `(C_D − C_S) × A_S` from the RGBA
atlas (`_LIGHTMAP_GS` + `_LightmapTex` via UV1), giving the real cool-shadow / warm-sun terrain light.

**Skybox.** The level's baked sky renders behind the mountain: the `SkyboxCubemap` cubemap on a stock `Skybox/Cubemap`
material set as `RenderSettings.skybox` (URP honours it), with linear horizon fog (300–1000 m) so distant terrain
dissolves into the haze the way SSX does. The neutral importer's `SkyboxBaker` targets URP (stock skybox
shader + `RenderSettings`), so a full in-project import bakes it; the current scene reuses the baked cubemap
directly.

## Import pipeline (in-project)

The whole neutral importer (`Unity/Importer`) is compiled into the Basis project, so Basis builds a level from
the glb the same way the VRChat side does. `Basis/Editor/BasisImportAll.cs` (menu **OpenSlope Basis/Load/Map…**)
is the Basis analogue of `ImportAll`: pick a level folder (containing `gltf/`) → `LevelImporter.Import()`
(shared neutral geometry + `*Markers` + skybox/fog/sun) → `BasisWiring.Wire()` (realizes the FX/audio markers
into Basis behaviours, reports the rest) → `BasisSetupAll.FinalizeScene()` (points `BasisScene.SpawnPoint` at the importer's
`PlayerSpawn` anchor and pins the environment). It imports the FX + audio pass too (see *Effects &amp; audio* below) — the fog / emitter / firework
particles, the collision-triggered bursts, and the crowd/placed environmental audio import alongside terrain, props, collision,
skybox and the spawn; only avatar light-probes stay off. **OpenSlope Basis/Setup All**
re-runs the finalization on a loaded map. Compiling `Unity/Importer` under Unity 6 needs one fix: `Object.
GetInstanceID()` is a hard error there (obsolete → `GetEntityId`); reference-keyed lookups compile on both 2022.3 and 6.

## How Basis differs from the VRChat/Udon target

The rest of this repo builds for VRChat + UdonSharp. The Basis target changes several load-bearing things:

| Concern | VRChat / UdonSharp (current) | Basis |
|---|---|---|
| Script runtime | Udon (interpreted, API whitelist, exception-halt) | plain C# MonoBehaviours in a forked client |
| Synced state | `[UdonSynced]` fields + sync mode | `BasisNetworkBehaviour` messages + ownership |
| Render pipeline | Built-in RP | URP |
| World delivery | uploaded VRChat world | scene in client, or `.BEE` bundle by URL |
| Player / rig | `VRCPlayerApi`, stations | `BasisLocalPlayer`, `BasisSceneFactory.SpawnPlayer` |
| Editor Unity | 2022.3 | 6 |

The net effect is favorable for a rewrite: no Udon constraints (real `try`/catch, no `SendCustomNetworkEvent`
sync-mode gotcha, no whitelist), at the cost of translating synced state to explicit messages and porting
Built-in-RP shaders to URP.

The concrete patterns those differences force — the marker→behaviour wiring seam, the poll-based trigger detection, the
player-velocity workarounds, shared events, URP shader gotchas, and the Unity-6 API deltas — are collected in
**[062 — porting notes](062-porting-notes.md)**. Read it before porting a new subsystem; the feature sections below reference it.

## Tooling

The UnityMCP plugin this workflow drives Unity with needs a Unity-6 fix: its command executor compiles via
CodeDom, which is unavailable under Unity 6's .NET Standard API profile, so it falls back to the Editor's
bundled Roslyn compiler on such projects (the CodeDom path still runs on 2022.3). Copy the plugin's
`UnityMCPPlugin/` folder into the Basis project's `Assets/` to attach it.

## Next steps

1. **Make the imported level the default local world.** Repoint Basis's local default-scene setting (boot-content /
   `BundledContentHolder`) from the meadow demo to `TheScene`, so connecting to `127.0.0.1:4296` drops straight
   onto the level (a full `OpenSlope_Map` from Import All) with no manual scene load.
2. **Multiplayer-verify the networked layer.** The gem pop, firework volley, and ambient burst broadcast over
   `BasisNetEvent` (a `BasisNetworkBehaviour`), and the board pose syncs via `BasisBoardSync` (a
   `BasisSyncedTransform`) + a `BasisSeatSync` (see [Networking](#networking) below) — built on Basis's tested
   primitives, but not yet run with a second connected player.
3. **Extend the rideable board.** The board rides, grinds rails with sparks, banks a run score (gems set the
   multiplier), and networks its pose (see below); layer on what's still deferred — a proper standing stance, VR
   gaze-steering, the carved wake + snow spray (URP shaders), the grind-scrape audio clip, and the race timer +
   finish-line leaderboard (which the run score already feeds).
4. **Runtime-test the interactive layer, then port the last markers.** The interactive systems (board, gems, physics
   props, breakables, animated textures, flight, boards) compile and are realized in the scene, but they exercise only
   at play, so they need a real in-world pass through the Basis app boot flow — the editor scene has no `BasisLocalPlayer`.
   The markers that still have no Basis behaviour — the door/kicker/button trigger volumes, glint fade and
   terrain patches among them — are reported by `BasisWiring`.

## Rideable board (MVP)

`Basis/Riding/BasisBoard*.cs` is the Basis port of the VRChat `RideableBoard` — a snowboard you
ride down the mountain with real per-surface physics. **OpenSlope Basis/Setup/Rideable Board at Spawn** (`Editor/
BasisBoardSetup.cs`) drops one at the level's `PlayerSpawn`, on the terrain, facing downhill; walk up and press
interact to mount.

It leans on Basis's native seat system instead of reinventing it: `BasisBoard` subclasses **`BasisSeat`**, so
mounting is Basis's built-in "walk up + interact" and the seat driver re-fits the rider onto the board transform
every frame (the `ExampleMovingChair` pattern). The board just hand-integrates a world-space velocity and moves its
transform; the rider goes with it. This deletes the entire VRChat station/seat/gaze/spin workaround — Basis's seat
carries the body without hijacking the view, so none of that scaffolding is needed. The board **root is the seat**,
held level and yawed to the heading so a carve never rolls the rider; a `Heading` child pivot carries the visible
deck's full bank/slope.

The ride model is ported verbatim from the VRChat board (the ride-tested feel): the per-`SurfaceType` table
(friction/grip/speed, docs/vrchat/020), the SSX carve/turn model (a stick "lean" leads the heading, the velocity
self-centers, capped + speed-gated), two-stage air gravity with stick spin + flip, the charged ollie, held boost, the
landing-quality scrub, the snow-sink contact spring, wall-riding (a contact-normal-aimed probe), and a collide-and-
slide off walls. Input is read the Basis way: `LocalCharacterDriver.MovementVector` (steer X / tuck-brake Y), the
jump axis (charged ollie), grip (VR) or Run-Shift (desktop) for held boost, and `BasisDeviceManagement.
IsCurrentModeVR()` for the platform split. Out-of-bounds (a Surf_0 reset surface, or falling below the map) snaps the
board back to its spawn.

**Getting on a board.** Setup All stands a **rack of ready-to-mount boards at the start gate** (`Editor/
BasisBoardSetup.cs`, `SpawnBoardRackAtGate`) — the Basis stand-in for the VRChat networked dispenser/pool
(`BoardSpawner`/`Manager`/`Request` + `VRCObjectPool`), which needs unported networking. **OpenSlope Basis/Setup/Board
Rack at Gate** rebuilds the rack; **Setup/Rideable Board at Spawn** drops a single board for quick testing. Boards build at scene
root with an identity parent (never under the scaled `Level`) and **drop onto the terrain** — a downward `RaycastAll`
that prefers a collider under `OpenSlope_Map/Collision` over the gate's own prop colliders (the port of the VRChat
`GroundYTerrain`), so the rack sits on the snow rather than the start-gate roof. Each wears a real extracted SSX deck
(`snowknife board`, a random rider skin apiece; a thin box if the model isn't in the project).

**Rail grinding** is ported (`Riding/BasisRailNetwork.cs` + `Riding/BasisBoard.Rail.cs`): the board auto-finds
the level's `OpenSlope_Map/Rails` network (a `BasisRailNetwork` realized by `BasisWiring` from the neutral
`RailMarker` — the near-verbatim port of the VRChat `RailNetwork`, baked polylines + source cubics + a spatial
grid for the nearest-rail query), and the grind state machine (lock-on, magnitude-preserving along-rail motion,
ollie-off, junction transfer, curve-fling) is ported from the VRChat `RideableBoard.Rail.cs`. It runs as a
self-contained state *before* the ground/air branch, so the tuned ride integration is untouched. Grinding kicks
**sparks** off the rail seam (`Riding/BasisBoard.Fx.cs` — a URP-additive `ParticleSystem` the setup builds) and
**scores** continuously (`ScoreGrindFrame` + rail-spin accrual). Stick-only steering (VR head-steer not ported, same
as the ride branch).

**Run score** (`Riding/BasisBoard.Score.cs`) is a trimmed port of the VRChat `RideableBoard.Score.cs`: a run is
one ride; spins (stick-X) + flips (stick-Y) accrue in the air and BANK on a clean landing as
`round10(rotations · scoreSpinPer360 · gemMult · scoreStyleConstant)` + a flat big-air bonus; grinding banks linear
style; a collected gem raises the multiplier MAX-not-stack (`ApplyGemMultiplier`), consumed by the next banked trick;
a bad landing / out-of-bounds wipes the uncommitted trick. `BasisBoard.Hud.cs` draws a small on-screen readout
(score / multiplier / live-or-last trick) while you ride — an IMGUI dev aid (desktop only, no assets), so the score +
gem plumbing is visible during a ride-test; `logTricks` also prints each banked/lost trick to the console. `RunScore`/
`RunGemMult` (+ `RunTrickActive`/`RunGrinding`) are exposed for the eventual in-world HUD + finish leaderboard.

**Board audio** (`Riding/BasisBoard.Audio.cs`) is the board's own glide + carve loops, the held-boost roar, and the
focused-rider big-air wind, all carried as the local rider's 2D sound (like footsteps): the ground-loop clip is
chosen by the contact surface's audio group and its
volume/pitch ride speed/lean/slip, fading out in the air and while grinding; the boost roar has a reconstructed
punch → sustain → release envelope, ground-only. The whole envelope is live — the clips aren't in the Basis project yet,
so those sources stay silent until `glideClips` / `carveClips` / `boostClip` are assigned. The recovered big-air
loop is wired automatically from shared MAIN slot 032 when available; a landing prediction strictly over 1.5 s
starts it and touchdown stops it, with no map/weather ambience contract. Assigning the remaining clips needs no
code change. One boost clip, no boost-meter tiers.

Still deferred (each needs an unported dependency): the networked board *dispenser* (the rack is the stand-in), the
carved wake + snow spray (URP shaders), and the grind-scrape audio clip. VR gaze-steering is dropped — stick steering
only — the race timer + finish-line leaderboard + boost meter are not ported (the run score already feeds them),
and the stance uses `BasisSeat`'s seated pose.

## Gems

**OpenSlope Basis/Load/Map...** realizes the level's trick-multiplier gems too. The neutral prop builder already spins each
gem's icon and tags a shared `SpinnerMarker` + a per-gem `GemMarker`; `BasisWiring` realizes them into
`World/BasisSpinnerManager.cs` (one range-gated `Update` revolves every nearby gem — the port of the VRChat
`SpinnerManager`) and `World/BasisGemPickup.cs` (each gem pops instantly in a sparkle burst + chime, holds, then
grows back and re-arms). Detection is the same poll used by the FX triggers: no Basis `OnPlayerTriggerEnter` and a
physics trigger would miss a seated board rider, so the gem tests the local player's body *column* against the
importer's pickup sphere (`BasisLocalPlayerProbe.NearSphere`) each frame, catching a walking player and a board rider
identically. Collecting one while **riding** raises the rider's run multiplier (`BasisBoard.ApplyGemMultiplier`,
read via the static `BasisBoard.LocalRider`); a walking player collects it cosmetically only. The pop is a
**networked shared event** (`BasisNetEvent`), so every player sees the gem you collect pop + regrow.

When a level's gems are one repeated model, snowknife emits them **GPU-instanced** (docs/012): every copy shares one
colour-less mesh and carries its own centroid + rotation + SSX ambient/key. `BasisSpinnerManager.Start` re-applies
each gem's per-instance light to its renderer via a `MaterialPropertyBlock` (`SetVector`, not `SetColor`) — the URP
shader's `_DIRLIGHT_INST` path reads it — because a property block is runtime-only and the importer's edit-time one is
gone by play (without it the shared mesh draws black; see [porting notes](062-porting-notes.md#urp-shader-porting)).

## Course-flow triggers

**OpenSlope Basis/Load/Map...** realizes the level's course-flow trigger volumes — the systems that keep a rider on the
course and moving. The neutral importer already builds each as an invisible trigger box + a marker (all on by default:
`EmitResetZones` / `EmitTeleports` / `EmitBoostPads`); `BasisWiring` realizes them:

- **Reset zones** (`ResetZoneMarker` → `World/BasisResetZone.cs`) — authored out-of-bounds boundaries (walls /
  water / back-of-course). Crossing one while riding snaps the board back to its spawn (on top of the board's own
  Surf_0 / below-floor OOB). A walking player isn't reset — on foot you're not meaningfully out of bounds, matching the game.
- **Teleports** (`TeleportMarker` → `World/BasisTeleport.cs`) — a start box paired with a destination anchor;
  crossing warps the local player to the exit facing along start→exit. Riding → the board's `RespawnAt` carries the
  rider out of the exit still aboard; walking → `BasisLocalPlayer.Teleport`.
- **Boost pads** (`BoostPadMarker` → `World/BasisBoostPad.cs`) — a gold **speed** pad runs the board's timed boost
  (`ApplyPadSpeedBoost` → raises the top-speed cap + lean-gated thrust for a window, folded into `BoostActive()`); a
  red/green **trick** pad is cosmetic here.
- **Boost volumes** (`BoostVolumeMarker` → `World/BasisBoostVolume.cs`) — the `MainType-0` boost family
  (docs/053): four sub-types sharing one first-order-lag push along an authored world vector. A directional volume
  shoves you (conveyors, exhaust vents, wind); a vertical lift cancels your travel and carries you to an altitude;
  the lap-gated and tube-end pair lift, classify and launch you out of the finish tube.

The first three use the same local-player poll as the FX/gem triggers (`BasisLocalPlayerProbe.InsideBox`, rising edge)
and read whether you're riding via the static `BasisBoard.LocalRider`. Reset/teleport are purely local (the moved
player + board carry to others through the avatar + pose sync); the boost pad keeps the **boost** local (only the
crossing rider speeds up) but broadcasts its **cosmetic** sparkle/chime as a `BasisNetEvent` so others see a pad
was hit.

The boost volumes poll differently on purpose: duration there is **containment**, not a rising edge, so they test the
**board's** position (`BasisLocalPlayerProbe.PointInBox`) and act every frame it is inside. A lift that fired once on
the cross would lurch instead of climb. Purely local — only the rider inside the volume moves — so nothing is
broadcast.

## Physics props (knock-and-tumble)

**OpenSlope Basis/Load/Map...** realizes SSX's knock-and-tumble props — crash bags, path markers (docs/016) — from
`PhysicsPropMarker` into `World/BasisPhysicsProp.cs`. The neutral importer already builds each prop's Rigidbody +
solid box collider + inflated knock-sensor trigger + per-material impact `AudioSource`. The prop can't be a free rigid
body (it slides off the mountain on spawn, and neither a walking player nor a seated rider imparts contact force to a
rigidbody), so it **anchors** kinematic and solid at rest — blocking like the scenery it replaces — and flips
**dynamic** on a knock, flung along the hitter's own velocity — the game's mode-3
object impulse ≈ 1.3 × closing speed along the contact normal, no up-kick — then settles and re-anchors so it's knockable
again. Detection is the [universal poll](062-porting-notes.md#detection-without-onplayertriggerenter-the-universal-poll): it
watches the local player's root — and, while riding, the board's position — cross the sensor box each frame and knocks on
the rising edge, reading the closing speed from the [player-velocity tracker](062-porting-notes.md#no-player-velocity-api).
Local-only, like the gems and pads. `Pop` / `Rearm` are exposed for a future fire-hydrant-lid pop-off (a city-level feature;
a mountain level has no hydrants). Where many copies of one prop model exist, snowknife emits them GPU-instanced (docs/012) and
`BasisPhysicsProp.Start` re-applies the copy's per-instance SSX light via a `MaterialPropertyBlock` (the same fix as
the gems — the URP `_DIRLIGHT_INST` path, `SetVector` not `SetColor`).

## Breakables (logos, signs, balloons)

**OpenSlope Basis/Load/Map...** realizes the breakable logos / signs / balloons (docs/028, docs/036) from
`BreakableLogoMarker` into `World/BasisBreakableLogo.cs`. You ride **through** a lit logo screen (or fence /
hole-cover / balloon) and it shatters with a sound — a scripted **mesh-swap**, not a physics shatter. The neutral importer
pulls the intact / broken / piece meshes into toggle-able objects and builds the pass-through trigger box + debris + break
sound; the behaviour hides the intact renderers, reveals the broken twin **or** throws its connected-component pieces (the
mode-3 Sub20 mesh-throw, integrated mesh-local under gravity along the hit direction), plays the clip + shard/star burst,
then respawns (balloons grow back from nothing like the gems; logos and fences pop back). Detection is the universal poll
(the local root plus the board while riding). The break is a **networked shared event** (`BasisNetEvent`): the breaker
shatters instantly and broadcasts so every player sees the same shatter + respawn, each client running its own respawn
timer; offline it's a local-only break.

## Animated textures (flipbook)

**OpenSlope Basis/Load/Map...** realizes the level's animated material slots — crowd billboards, flickering signs, LCD jumbotron
flips, the start gate (docs/008) — from `FlipbookMarker` into `World/BasisFlipbookAnimator.cs`, which cycles their
`_MainTex` per frame on the merged Props renderer. Purely cosmetic and local, so it's a plain MonoBehaviour with no
networking. It keeps the VRChat **material grouping**: a city authors one animation across hundreds of screen +
shatter-shard slots (a mountain level has dozens, a dense city close to a thousand), so `Start` groups slots by their shared flipbook material, instances one
material per group, and points every member at it; `Update` then walks the ~dozen groups, one texture write driving every
renderer in each, so the per-frame cost scales with the number of distinct animations, not the number of screens. LCD
screens follow the **U4 pause law** — hold the first frame for a randomized dwell, flash the second for a fixed 0.2 s — so
distinct screens drift out of sync while a screen's shards flip in lockstep with it. The material key is the `Material`
reference, not `GetInstanceID()`, which [Unity 6 makes a hard error](062-porting-notes.md#unity-6-api-deltas).

## Effects & audio

**OpenSlope Basis/Load/Map...** brings across the whole FX + audio layer, so an imported level has its fog, pyro, and
ambient sound — not just geometry. All of it rides the SAME neutral builders the VRChat side uses (`ParticleBuilder`,
`EmitterBuilder`, `AmbientEmitterBuilder`, `TriggerBuilder`, `AudioBuilder`); the only Basis-specific parts are four
URP shaders and two runtime behaviours.

**URP shaders** (repo source `Basis/Shaders/`), each answering to the same `Shader "OpenSlope/…"` name its
Built-in-RP twin under `VRC/Shaders/` uses, so the neutral builder's `Shader.Find` resolves to whichever RP's
copy is in the project:

- `OpenSlope/Particle` — the camera-facing fog billboards (view-space corner spread, alpha-blended).
- `OpenSlope/FlareHalo` — the static radial glow on flares / lanterns (additive).
- `OpenSlope/ParticleAdditive` + `OpenSlope/ParticleAlpha` — for the stock `ParticleSystem` effects (snow-cannon plumes,
  collision bursts, fireworks). Unity's Legacy particle shaders don't exist in URP (they render magenta), so the
  three ParticleSystem builders try these OpenSlope names first and fall back to the Legacy names — the OpenSlope names are
  absent in a VRChat/Built-in project, so that build is unchanged.

**Trigger behaviours** (repo source `Basis/World/`), realized from the neutral markers by `BasisWiring`:

- `BasisFirework` (← `FireworkMarker`) fires a staggered volley of the nearby launcher `ParticleSystem`s, each
  with its firing sound, when the local player crosses the trigger volume.
- `BasisAmbientEmitter` (← `AmbientEmitterMarker`) plays the collision dust/spark/fire/water bursts on contact.

Both **poll the local player's position** against their volume each frame (`BasisLocalPlayerProbe.InsideBox`) rather
than using physics triggers or a VRChat-style `OnPlayerTriggerEnter`: Basis has no such callback, and a physics
trigger misses a **seated** rider (the seat disables the player's `CharacterController`) and teleport-ins.
`BasisLocalPlayer.Instance.transform.position` is written every frame whether the player walks or rides a `BasisSeat`,
so a board rider skiing through a volume is caught exactly like a walking player.

**Audio** is stock Unity `AudioSource`s (crowd and authored environmental loops at their retail placements, plus
firework firing bangs). There is no inferred map-wide wind bed; large-jump wind belongs to the local board audio
described above. Basis's spatializer is Steam Audio, which pans a source by position/distance once spatialization is enabled —
no VRChat-style pairing component is needed, so `BasisWiring` just flips `spatialize` on for the positional sources
the importer built (the `SpatialAudio` tag).

Both are **shared across the instance** (`BasisNetEvent`, see [Networking](#networking)): the client that
crosses the volume fires the volley/burst locally *and* broadcasts it so every player sees it (the cooldown gates the
local trigger and the received echo, so simultaneous crossings collapse to one). The fire-hydrant lid pop-off reuses the
physics prop's `Pop`/`Rearm` (a city-level feature; a mountain level has no hydrants). The board's own carved wake + snow spray is board
FX, not level FX, and needs its own URP shaders, which are not ported.

## World culling & performance

`World/BasisObjectCuller.cs` (← `ObjectCullerMarker`) range-culls the placed-object renderers (gems, crash-bags,
animated props, static chunks) at a per-platform camera range — Quest/Android tighter, PC longer — the mountain-top
prop-draw perf gate. It toggles `Renderer.enabled` (not the GameObject) so a prop keeps ticking while only its draw
gates, on a 10 Hz throttle with a sliced sweep so no single frame stalls. The **Performance Board** (below) can switch
the whole culler off for full draw distance.

## On-foot flight

`World/BasisPlayerFlight.cs` is the on-foot "trigger jetpack" (jump, then hold trigger to fly where you point) — the
port of the VRChat `PlayerFlight`. Because Basis has [no player-velocity API](062-porting-notes.md#no-player-velocity-api),
it can't add thrust on top of the walking driver; instead it installs a custom `IMovementMode` on the local character
driver that owns its own ballistic velocity (gravity + aimed thrust + a turnaround assist), seeded from the controller's
velocity on takeoff and handed back to walking on touchdown. VR aims with the right hand, desktop with the view +
left-click. It's a world singleton (Setup All drops it); the board suppresses it on mount.

## Start-gate boards (Performance / Info)

`World/BasisPerfBoard.cs` + `World/BasisInfoBoard.cs` (built at the gate by `Editor/BasisBoardsSetup.cs`) are the
start-gate UI. The **Performance Board** is a panel of toggle plates that turn the heavier cosmetics — the range culler,
continuous emitters, gem spin, fireworks, your own board's grind sparks — off per-player for framerate, with per-platform
starting defaults (`#if UNITY_ANDROID`). Each plate is a `BasisWorldToggle`, a `BasisInteractableObject` you
point-and-trigger in VR or desktop whose colour shows the state, because a plain uGUI world Canvas
[isn't clickable in Basis](062-porting-notes.md#world-ui-thats-actually-clickable). The **Info Board** is a display-only
3D-TextMesh panel (no interaction, so no raycast plumbing) with the control cheat-sheet and a live rider count from
Basis's networked-player registry.

## Networking

The first OpenSlope networked layer, built on Basis's own primitives rather than a hand-port of the VRChat transport:

- **Shared events** (`World/BasisNetEvent.cs`, a `BasisNetworkBehaviour`) — a fire-and-forget one-shot any client
  triggers locally and Broadcast()s so every *other* client replays it (`SendCustomNetworkEvent` → `OnNetworkMessage`).
  The gem pop, firework volley and ambient burst subclass it. Basis's send excludes the sender (no self-echo, so none
  of the VRChat dedupe window is needed), and the `NetworkID` derives from the object's stable hierarchy path — the
  level imports identically on every client, so no ID authoring/baking step is required. Offline it no-ops (the local
  effect still runs), so solo play is unchanged.
- **Board pose** (`Riding/BasisBoardSync.cs`, a `BasisSyncedTransform`) — the board root's world pose plus the deck
  (Heading) pivot's relative rotation, owner-authoritative. Basis's sync engine already does the interpolation,
  extrapolation, jitter buffer and teleport-snap, so there's no ported dead reckoning. With a `BasisSeatSync` on the
  same board (occupancy + driving each remote rider's avatar onto the moving seat) this is the same three-part
  "networked piloted seat" recipe Basis's own `BasisNetworkedVehicle` uses. The local rider `TakeOwnership()`s on
  mount; the board's ride `Update` only runs for the local rider, so a remote copy is driven purely by the sync — no
  fight. Both companions are added by `BasisBoardSetup` and are inert offline, so single-client riding is unchanged.

**Not multiplayer-tested yet** — it compiles and is realized/wired, and rests on Basis's tested primitives, but it
hasn't been run with a second connected client.
