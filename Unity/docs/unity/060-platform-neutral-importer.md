# 060 — Platform-neutral importer (the marker seam)

The level importer under `Unity/Importer` builds a level as **platform-neutral** output: geometry, colliders,
particle systems, native `AudioSource`s, baked data — and, wherever a prop needs a *runtime behaviour*, a plain
`MonoBehaviour` **marker** carrying that behaviour's configuration. It has **no** VRChat/Udon (or Basis) dependency:
zero `using VRC`, zero `using UdonSharp`, and zero references to any type the platform plugins declare. Each platform plugin references the importer plus its own SDK
and runs a **wiring pass** that turns the markers into that platform's runtime behaviours. So one importer serves
VRChat (`Unity/VRC`, UdonSharp) and BasisVR (`Unity/Basis`, plain `BasisNetworkBehaviour`s) from the same
neutral scene.

```
Importer/  → geometry + *Marker components          (no platform code)
VRC/       → references importer + VRChat SDK; ImportAll owns Import All, VrcWiring realizes markers → Udon
Basis/     → references importer + Basis; BasisWiring realizes markers → BasisNetworkBehaviours (scaffold)
```

## The marker seam

A marker lives under `Importer/Runtime/`, derives from `Marker : MonoBehaviour`, and carries the exact
fields the target behaviour wants — named **identically**, so a platform copies them across by name. A builder tags
the object with its marker and moves on; the platform wiring pass realizes the behaviour:

```csharp
// TriggerBuilder (neutral): tag the firework volume with its marker.
var mk = go.AddComponent<FireworkMarker>();
mk.Fireworks = systems; mk.Cooldown = c; ...
```

Two shapes need care:

- **Cross-references.** A behaviour that points at *another* realized behaviour (a rail gate → its rail network, an
  anim trigger → its prop, an ambient emitter → the hydrant-lid physics props, a board → the terrain-patches holder)
  can't be typed on a neutral marker. The marker stores the target's **`GameObject`** (field suffix `Object` /
  `Objects`), and the wiring pass resolves it to the platform component in a second pass, after every behaviour exists.
- **Spatial audio.** `SpatialAudio` is a zero-field **tag**. The importer builds a bare `AudioSource` with its own
  3D curve; the wiring pass reads that curve (`spatialBlend > 0` ⇒ spatialize, `Near`/`Far` from min/max distance) to
  add the platform's spatial component. That one tag reproduces every positional source *and* the deliberately-2D
  teleport chime (`spatialBlend 0`), with no per-site fields.

## The wiring pass

`VrcWiring.Wire()` (`VRC/Editor`) runs over everything under `OpenSlope_Map` in three passes:

1. **Realize** — for each marker, attach its UdonSharp behaviour (the `UdonTools.AddConfigured` recipe, which lives in
   VRC) and copy the marker's fields onto it by name (`CopyFieldsByName`). Fields the behaviour keeps at its own default
   (e.g. `networked`) simply aren't on the marker, so they're untouched. Realize `SpatialAudio` tags into
   `VRCSpatialAudioSource`.
2. **Resolve** — resolve the `GameObject` cross-references onto the now-attached behaviours.
3. **Clear** — strip the consumed markers, so the built scene carries only the live behaviours.

`BasisWiring.Wire()` is the Basis analogue (a scaffold today: it walks the same markers and reports which have no
Basis behaviour ported yet; each `Realize<Marker, BasisBehaviour>` line lands as a behaviour is ported).

## Entry point (Import All)

The platform owns Import All. VRChat's `ImportAll.ImportFolder` (menu `OpenSlope/Load/Map…`):

1. `UdonTools.EnsureAllProgramAssets()` — the fresh-project two-click program-asset bootstrap (bail + rerun; see
   [013](../vrchat/013-udon-components.md)).
2. `LevelImporter.Import(cfg)` — the neutral build (geometry + markers).
3. `VrcWiring.Wire()` — realize the markers.
4. VRChat scene finalization that needs the scene descriptor: `Map.SetRespawnHeightFromMap`,
   `WarnIfWorldSettingsMissing`, `PointSceneSpawn`.

The per-subsystem `OpenSlope/Refresh/*` menus (rebuild ONE subsystem in a loaded map) live in `ImportAll` / `Refresh`
too: each rebuilds its neutral subsystem then re-runs the wiring pass. The neutral map-layout constants (`OpenSlope_Map`,
`Collision`, `Locations`, `PlayerSpawn`, …) live in the importer's `MapLayout`; VRC's `Map` re-exports them
and keeps the VRChat-only helpers (respawn floor, world-settings, locomotion, the start-gate board bench).

## Enforcing the boundary

There are no `.asmdef`s (see [authoring/00-pipeline](../authoring/00-pipeline.md)), so the boundary is a **convention**
plus a guard: **`tools/check-importer-neutral.ps1`** fails if importer code imports VRChat/Udon or names a platform type.

Each layer lives in its own namespace — `OpenSlope.Importer`, `OpenSlope.VrcPlugin`, `OpenSlope.BasisPlugin` — so the guard
asks the only question that matters: does importer code name `OpenSlope.VrcPlugin` or `OpenSlope.BasisPlugin` at all, as an
import, an alias, or a qualified type? A platform type is unreachable from the importer without one of those, so
nothing has to be kept in sync and a new platform type is covered the moment it's declared. Because the namespace
IS the boundary, the guard first asserts that every `.cs` under a layer declares that layer's namespace: a file
left in the global namespace would be reachable with no import to find. The scan reads code with comments
stripped, so the importer's prose may freely name the behaviours its markers get realized into. Run it before
relying on the split; it keeps the inversion from silently rotting.

Type names themselves are unprefixed, which is why the guard can't match on them: the platform type *names* are
ordinary words (`Refresh`, `Map`, `GemPickup`), so a name scan over importer text flags `AssetDatabase.Refresh()`
and a `"HudMessageDisplay"` GameObject name. A name cannot tell you which layer it belongs to; a namespace can.

## See also

[013 — Udon Components](../vrchat/013-udon-components.md) (the VRChat wiring pass in detail),
[034 — Bundle Pipeline](../../../Snowknife/docs/034-bundle-pipeline.md) (what the neutral build consumes),
[basis/061](../basis/061-overview.md) (the Basis port).
