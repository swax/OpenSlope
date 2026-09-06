# 00 — Authoring Pipeline: Authored Level → Ride-Ready in Unity

Runbook for taking an **authored** Maps level (one emitted by code / Slopesmith, not extracted
from the game ISO) all the way to a rideable VRChat scene — including standing up a **fresh**
project. The authored folder goes through the *same* `snowknife gltf` → importer pipeline as an
original level (Snowknife docs/001 and 034); the only extra is bootstrapping the OpenSlope framework when the
target project is new.

See also: [vocabulary/01 — terrain vocabulary](../../../Slopesmith/docs/authoring/vocabulary/01-terrain-vocabulary.md),
[vocabulary/02 — scored build loop](../../../Slopesmith/docs/authoring/vocabulary/02-scored-build-loop.md) (how the authored data is produced + scored),
and [README](README.md) for the full authoring map.

## 0. What an authored folder contains

Minimum the bake needs: `Patches.json`, `Props.obj` (≥1 visible group), `Textures/*.png`; optional
`AIP.json` (course path → spawn + OOB reset). Everything else (Lights/Lightmaps/Splines/SOP/
Instances/Skybox/Audio/particles) is **gracefully skipped** — the importer logs a benign warning and
the corresponding system is simply absent. Two consequences worth expecting:

- **Terrain renders flat-white** (no `Lightmaps/` ⇒ vertex luminance = 1.0). Cosmetic, not a defect.
- No rails / fireworks / crowd audio / skybox / probes unless authored.

`Effects.json` is the one optional input that is **not** silently skipped. It is the level's SSF
effect document and the sole source for every SSF-driven feature the bake produces — spline movers,
boost pads, trigger volumes, particle emitters, breakables. `snowknife gltf` validates it against the
effects schema when present, and when absent prints an explicit warning naming the fix rather than a
benign one, because the difference between "this level authored no effects" and "this level lost its
effects" is invisible in the output otherwise. For a hand-authored folder with no effects, the
warning is expected and harmless. For anything derived from an extracted level, it means the
`effects-export` step is missing — re-run `snowknife import`, or produce it directly with
`snowknife effects-export <level.ssf> <mapDir>/Effects.json`.

## 1. Bake — `snowknife gltf`

```
Snowknife/Snowknife/bin/Debug/net10.0/snowknife.exe gltf Maps/<NAME> <name>
```

Writes `Maps/<NAME>/gltf/{manifest.json, terrain.glb, props.glb}`. Success line:
`Bundle written to …/gltf`. (The exe is also auto-invoked by Slopesmith's `EXPORT`; build Snowknife
first if `bin/.../snowknife.exe` is missing.)

## 2. Bootstrap a fresh project (skip if the target is already an OpenSlope project)

A new VRChat world has no OpenSlope framework. Copy it from a working OpenSlope project that shares the same
**VRChat SDK** (check `Packages/vpm-manifest.json` — both must be e.g. `com.vrchat.base 3.10.3`):

```
SRC=<working project>/Assets ; DST=<new project>/Assets
cp -r $SRC/Importer $DST/ ; cp $SRC/Importer.meta $DST/
cp -r $SRC/VRC      $DST/ ; cp $SRC/VRC.meta      $DST/
```

Copy **with the `.meta` files** so GUIDs/program-asset refs resolve. What's inside: `Importer`
= the importer + bundle readers + builders; `VRC` = the rideable board, Udon behaviours, shaders
(`VRC/Shaders/*.shader`), and the UdonSharp program `.asset` files. No `.asmdef`, so it
compiles into the default assembly. The `.cs` source-of-truth lives in the repo at `Unity/Importer`
+ `Unity/VRC` (but the repo's `.meta` are gitignored — that's why we copy meta from a working
project, then can overlay the repo `.cs` if newer). The `SerializedUdonPrograms` cache does **not**
need copying — UdonSharp regenerates it on compile.

## 3. Stage the level — `snowknife unity`

```
snowknife.exe unity Maps/<NAME> "<project>/Assets/OpenSlope/Maps/<NAME>"
```

Copies the 6 level files + the `Shared` sibling (boards/announcer, ~575 files) into the project's
`Assets/OpenSlope/Maps/`. Unity then imports them (glb via the Importer's own glTF reader — note Unity has
no built-in glTF, so this only works once §2 is in place).

## 4. Import — non-interactive entry

The menu `OpenSlope/Load/Map…` (owned by `ImportAll`, in VRC) uses an interactive folder picker. For
automation use the programmatic entry it wraps (validates nothing — pass a project-relative folder that has
`gltf/manifest.json`):

```csharp
ImportAll.ImportFolder("Assets/OpenSlope/Maps/<NAME>");
```

Builds `OpenSlope_Map` (terrain + per-SurfaceType colliders + props + course path), realizes the markers into VRChat
behaviours (the wiring pass, [013](../vrchat/013-udon-components.md)), recenters the world to
the terrain centre, and spawns at the level's own start anchor, faced down the nearest course line. Three
anchors are tried in order:

1. **`Mdl_StartGate`** — the arch the run leaves through. Measured against where the AI start paths actually put
   the riders, it lands **2.6–2.7 m** away on six of the seven single-gate retail courses: the same number every
   time, because it is the authored offset of the grid behind the arch. A level may author more than one (Alaska
   ships two, 71 m apart), so the bundle carries them all and the gate nearest the head of the longest race line
   wins — `BundleManifestReader.BestLocator`.
2. **`Mdl_StageArea_Start_0`** — the placeholder the engine resolves to place the six-rider grid. It reads like
   the obvious anchor but measures 16–71 m from the grid and up to 16 m out vertically, so it is the FALLBACK,
   for the authored/test maps that carry no gate.
3. the course path's highest endpoint, which is only the start on a single top-to-bottom run (a lap course's
   network peaks at its lift/tube exit, far above the grid).

An anchor is then seated onto the snow — but only ever a **correction**, never a fall. Aloha's grid stands on a
platform of `Mdl_startAreaFloor*` PROP instances suspended over the mountain, and the seat ignores props (the
gate's own bounce box sits ~5 m overhead), so an unbounded seat dropped the spawn 685 m onto the hillside below
and put the riders in the middle of the map. Past `StartMarkerSeatDrop` the authored height stands.

## 5. Ride-ready — board, audio, flight

```csharp
SetupAll.Run(false);   // non-interactive: spawns start-gate boards + music + flight + race audio, no modal
```

`Run(true)` is the `OpenSlope/Setup All` menu (human; pops a dialog on the first pass). **First call on a
fresh project returns `false`** — it had to create the UdonSharp program assets, which UdonSharp
finalizes on the next recompile. Force a recompile, then call `Run(false)` again to finish (it
returns `true` and you'll see `N rideable boards` spawned at the gate). `EnsureAssets()` /
`RunSteps()` are exposed if a driver wants to control the recompile wait explicitly. (Probe bake is
deliberately separate — `OpenSlope/Setup/Bake & Apply Probes`, a blocking lightmapper pass; needed before a
VRChat upload for avatar shade lighting, not for a local ride.)

Then **enter Play mode (ClientSim) or upload** to ride: look at a board at the gate, Use/click to
mount, ride down. Riding itself is interactive — it isn't scriptable from the editor.

## Driving this over Unity-MCP — gotchas

- **`execute_editor_command` uses an old Mono compiler:** no C# local functions (use `static`
  helper methods on the `EditorCommand` class), and `Type.GetMethod(name)` throws
  `AmbiguousMatchException` on overloaded methods — always pass an explicit signature
  (`GetMethod(name, new[]{ typeof(...) })` or filter `GetMethods()` by parameter count).
- **Modals block the call.** Anything that pops `EditorUtility.DisplayDialog` mid-command hangs until
  it times out. That's why `SetupAll.Run(false)` exists; prefer non-interactive entry points.
- **Unfocused Editor throttles.** A first big import / domain reload can exceed the 55 s timeout
  while Unity is in the background — focus the Editor window (or Preferences ▸ General ▸ Interaction
  Mode = *No Throttling*) and retry. `get_logs` still works and is a cheap way to tell "busy" from
  "errored".
- **Naming:** type names carry no prefix; the layer's **namespace** does that work —
  `OpenSlope.Importer` (`LevelImporter`, `MapLayout`), `OpenSlope.VrcPlugin` (`RideableBoard`, `SetupAll`,
  `StartGateSetup`) and `OpenSlope.BasisPlugin`. Reflect by namespace.

## Known asymmetry: authored raw ≠ original raw axis

An authored `Patches.json` (Slopesmith `toRaw = [-100x, -100z, 100y]`, vertical at raw index 2) is
**not** in the same axis frame as an extracted original level (−Y-up, vertical at raw index 1). The
bake's manifest `RootEuler [270,0,0]` reorients it at import, so the ride is correct either way — but
any tool that reads the raw files directly (e.g. `Slopesmith/tools/mountain-study/score.ts`) must pick the convention per level
(it keys on `PatchName` = `Cell_r*` for authored). Detail: [vocabulary/02 Finding D](../../../Slopesmith/docs/authoring/vocabulary/02-scored-build-loop.md).
