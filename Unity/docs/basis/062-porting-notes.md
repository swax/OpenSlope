# 062 — Basis porting notes

Reusable patterns and platform gotchas for porting OpenSlope/SSX systems from the VRChat/UdonSharp target to Basis. This is
the cross-cutting reference; the running feature log is in the [overview](061-overview.md), and the behaviours themselves live in
[`Basis/`](../../Basis). Read this before porting a new subsystem — most of the work is one of the
patterns below.

## The wiring seam: markers → behaviours

The neutral importer (`Unity/Importer`) builds platform-agnostic geometry plus `*Marker` components and does **no**
platform wiring. Each platform's wiring pass realizes markers into its own runtime behaviours. `Basis/Editor/
BasisWiring.cs` is the Basis pass: for each ported subsystem it calls `Realize<Marker, Behaviour>()` — add the behaviour,
copy the marker's public fields onto it **by name** — and `ClearMarkers<Marker>()` — strip the realized markers. Every
un-ported marker is left in place and **reported** in the console, so what remains to port is always visible.

To land a new behaviour: give it the same public field names as its marker (the copy is name-driven), then add one
`Realize<>` line and one `ClearMarkers<>` line. This differs from `VrcWiring`, which realizes everything and strips all
markers; the Basis pass is partial by design, one subsystem at a time. Realized: FX/audio, gems, rails, course-flow
(reset zones / teleports / boost pads / boost volumes), the object culler, physics props, prop bounce, contact sounds,
breakables, animated props, and animated textures. Still reported (un-ported): the door/kicker/button trigger volumes,
glint-fade, and terrain-patches.

**Glint-fade is the one un-ported marker with a visible cost.** The shared importer builds a `OpenSlope/FlareHalo` billboard per
authored glow light ([045 — Light Glints](../unity/045-flares.md)) and, because the VRChat design makes the
source-visibility fade the *only* occlusion, gives each glint material `_ZTest Always`. `BasisWiring` never realizes
`GlintFadeMarker`, so nothing drives the shader's `_Visibility` and **every glint reads through terrain and buildings**
from anywhere on the course. Porting `GlintFade` (a plain `MonoBehaviour` — it needs only the local head position and
`Physics.RaycastNonAlloc`) closes it; until then, importing with `LightGlowFade = false` is the honest stopgap, which falls
the materials back to `_ZTest LEqual` + the camera-ward pull.

## Detection without `OnPlayerTriggerEnter` (the universal poll)

Basis raises no VRChat-style `OnPlayerTriggerEnter`, and a physics trigger **misses** two cases SSX depends on: a seated
board rider (the seat driver disables the player's `CharacterController`) and a teleport-in (the root is moved with no
enter/exit). So every SSX trigger volume **polls** the local player against its own collider each frame and fires on the
rising edge (outside → inside). `World/BasisLocalPlayerProbe.cs` centralizes the tests — `InsideBox`, `PointInBox`,
`NearSphere`, `TryGetPosition`.

`BasisLocalPlayer.Instance.transform.position` (the feet) is written every frame whether the player **walks** (the
character driver writes the root) or **rides** a `BasisSeat` (the seat driver writes the same root), so a board rider
skiing through a volume is caught exactly like a walking one. While riding, the seated root can sit off the deck, so a
volume that the *board* plows through (physics props, breakables) also tests `BasisBoard.LocalRider.transform.position`.

## No player-velocity API

Basis has no read/write player-velocity API; the character driver regenerates motion from input each frame. Two
consequences shape the port:

- **Reading velocity** (knock direction, closing speed) — `BasisLocalPlayerProbe` estimates it from the root's per-frame
  delta, sampled continuously by a hidden always-on tracker (`BasisPlayerVelocityTracker`, installed via
  `[RuntimeInitializeOnLoadMethod]` + `DontDestroyOnLoad`) in `LateUpdate`, cached, and clamped to 60 m/s so a
  teleport/respawn warp can't spike it. Consumers read the cache (`TryGetVelocity`); they must **not** sample on demand — a
  consumer that reads only on a rare crossing frame would difference against a position from seconds ago. While riding,
  prefer the board's own `RiderVelocity`.
- **Writing velocity** (on-foot flight) — you can't add thrust on top of the walking driver, so flight installs a custom
  `IMovementMode` on `driver.CurrentMode` that owns its own ballistic velocity (gravity + aimed thrust), seeded from
  `characterController.velocity` on takeoff and handed back to walk on landing. **Trap:** `driver.SetMode` early-outs when
  `CurrentModeKind` already equals the target, so entering the custom mode must also set `CurrentModeKind = Mode.Fly`, or
  the return-to-walk is a no-op that strands you flying.

## Shared events over `BasisNetworkBehaviour`

Transient one-shots — a gem pop, a firework volley, an ambient burst, a breakable shatter — subclass `BasisNetEvent` (a
`BasisNetworkBehaviour`): do the effect locally, call `Broadcast()`, and replay it in `OnRemoteEvent`. Basis's send
excludes the sender (no self-echo, so none of the VRChat dedupe window is needed), and the `NetworkID` derives from the
object's stable hierarchy path — a level imports identically on every client, so there's no ID authoring/baking step.
Offline it no-ops (the local effect still runs), so solo play is unchanged. Anything that is the acting player's own — a
score award, the collector's chime, the crossing rider's speed boost — stays in the local trigger handler, **not** the
replay.

## URP shader porting

Every Built-in-RP `OpenSlope/*` shader gets a URP twin under `Basis/Shaders/` answering to the **same** `Shader
"OpenSlope/…"` name its Built-in twin under `VRC/Shaders/` uses, so the neutral builders' `Shader.Find` resolves to whichever
render pipeline's copy is in the project (the OpenSlope names are absent in a Built-in/VRChat project, so that build is
unchanged). Two gotchas:

- URP's `Color.hlsl` does **not** expose `LinearToSRGB` / `SRGBToLinear` by name — inline Unity's own gamma↔linear
  polynomial approximations rather than assuming Built-in `UnityCG.cginc` helper names exist.
- Unity's Legacy particle shaders don't exist in URP (they render magenta) — the particle builders try the
  `OpenSlope/ParticleAdditive` / `OpenSlope/ParticleAlpha` URP names first and fall back to the Legacy names.
- **Keyword/property parity is load-bearing: when the Built-in shader gains a variant, the URP twin must too.** The
  GPU-instanced prop path (docs/012) added `_DIRLIGHT_INST` to `OpenSlope/UnlitDoubleSided`: a row of identical props
  (parking meters, pylons, trick gems) shares ONE light-stream-free mesh and reads its per-instance SSX ambient,
  three keys, and three fixed world directions from a `MaterialPropertyBlock`. The URP port needs matching
  `_PROPLIGHT` and `_DIRLIGHT_INST` variants plus a `UNITY_INSTANCING_BUFFER_START(Props)` holding
  `_InstAmbient`, `_InstKey1..3`, and `_InstDir1..3`.
  **URP-only divergence from the Built-in twin: scope that instancing cbuffer under `#ifdef _DIRLIGHT_INST`.** Built-in
  declares it unconditionally (Built-in has no SRP batcher); under URP an unconditional non-`UnityPerMaterial` cbuffer
  drops SRP-batcher compatibility on the terrain / plain-prop variants that never read it, costing them batching. The
  `_DIRLIGHT_INST` variant is always drawn instanced, so scoping the buffer to it loses nothing. The rest of the frag
  plumbing (`multi_compile_instancing`, `UNITY_TRANSFER_INSTANCE_ID`, `UNITY_SETUP_INSTANCE_ID(i)`)
  is already present. Without the variant the importer's `EnableKeyword("_DIRLIGHT_INST")` is a no-op and the shared
  light-stream-free mesh falls back to its material defaults instead of receiving its instance record.
- **A `MaterialPropertyBlock` is runtime-only (never serialized), so the importer's edit-time per-instance light is
  gone by play.** Each realized Basis behaviour re-pushes it in `Start`: `BasisPhysicsProp` (one block) and
  `BasisSpinnerManager` (per-gem, over the near set's renderers). Push with **`SetVector`, not `SetColor`** —
  `SetColor` sRGB→linear-converts on the way to the GPU, but these are raw `/256` display-space factors;
  `SetVector` preserves them for `_PROPLIGHT`'s explicit sRGB modulation. The `Instanced`/`InstAmbient`/
  `InstKey1..3`/`InstDir1..3` fields ride across from the neutral marker via `CopyFieldsByName`, so no
  wiring change is needed — just matching field names on the behaviour.

## Level-folder assets the importer reads at import

The particle builders bind each sprite from `<LevelFolder>/Textures/Particles/` at import time; if that folder is missing,
the material imports with a null `_MainTex`, which the shader defaults to opaque white — fog renders as white squares. The
per-level copy that populates the Basis project (`Assets/OpenSlope/Maps/<level>/`) must include `Textures/Particles/` alongside the
terrain and skybox textures so a level's fog and sparks bind on import.

## Unity 6 API deltas

- `Object.GetInstanceID()` is a **hard compile error** (CS0619, obsolete → `GetEntityId`, not pragma-suppressible). Portable
  fix: key dedup dictionaries/sets and material-group lookups on the object **reference** instead of an int id (2022.3 has
  no `GetEntityId`, so don't switch to that).
- `Rigidbody.velocity` → `linearVelocity` (guard `#if UNITY_6000_0_OR_NEWER`, like `PropBuilder`'s `linearDamping`).
- `FindObjectsOfType`, `RenderToCubemap`, `Experimental.Rendering` are warnings only — non-blocking.

## World UI that's actually clickable

A plain uGUI world Canvas is **not** clickable in Basis — its pointer is a physics-collider raycast that needs a collider on
a UI layer. Interactive world UI is a `BasisInteractableObject` plate instead (a Cube + BoxCollider you point-and-trigger in
VR and desktop, modeled on the `BasisInteractableButton` example; OpenSlope uses a latching variant, `BasisWorldToggle`).
Display-only panels with no interaction can be a plain 3D `TextMesh` with no raycast plumbing.

## Editor tooling

The UnityMCP plugin that drives the editor needs a Unity-6 fix: its command executor uses CodeDom, unavailable under
Unity 6's .NET Standard profile, so it falls back to the bundled Roslyn compiler there. Two operational notes when driving the
editor headlessly: an **unfocused** editor throttles the main thread — editor commands time out and Scene-view captures
return black (render the game view with a positioned camera and a far clip past the ~2.7 km mountain instead), and a big
recompile or a ~74 s level import triggers a domain reload / exceeds the plugin's main-thread wait, so a call can return a
timeout while the work keeps running — confirm from the console log rather than re-running.
