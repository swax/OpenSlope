# 013 — Udon Components (making props run in VRChat)

SSX's interactive props — the spinning trick-multiplier gems, the knock-and-tumble physics props, the
firework triggers, the crowd/sign flipbooks — need to *do* something in-world, and VRChat only runs
**Udon**, never user MonoBehaviours. The importer itself is platform-neutral ([060](../unity/060-platform-neutral-importer.md)):
it tags each interactive object with an `*Marker` carrying that behaviour's config. This doc is the **VRChat
wiring pass** — how `VrcWiring` turns those markers into `UdonSharpBehaviour`s, run as part of
`OpenSlope/Load/Map...`, so the imported scene is ready to build. Developed against a locally converted level, VRChat Worlds SDK 3.10.x.

> The *general* "how do I attach a working Udon component from code" recipe — the three linked objects (program
> asset + backing `UdonBehaviour` + proxy), the hidden `AddUdonSharpComponent` extension method, why a new
> script has no program asset, `CopyProxyToUdon`, the editor-snippet C# limits — is **not SSX-specific** and
> lives with the tooling that does it: the **UnityMCP** project's `docs/006-udonsharp-components.md`. This doc
> covers the SSX-specific shape: one shared helper, realize-during-wiring, and the fresh-project bootstrap.

## The shared helper: `UdonTools` (`VRC/Editor/UdonTools.cs`)

Wraps the UdonSharp attach recipe (VRChat-side — the neutral importer never touches it):

- `EnsureProgramAsset<T>(out bool created)` / `EnsureAllProgramAssets()` — find (or create + compile) the
  `UdonSharpProgramAsset` for a behaviour. `AddUdonSharpComponent` *throws* unless the program asset already
  exists, so this must run first.
- `AddConfigured<T>(GameObject go, Action<T> configure)` — `AddUdonSharpComponent<T>()`, run the field-setting
  callback on the proxy, then `CopyProxyToUdon` to push those values into the backing `UdonBehaviour`'s heap.

`VrcWiring.Wire()` calls `AddConfigured` once per marker and copies the marker's fields onto the behaviour by
name, so the configuration a builder computed rides across without per-type wiring code:

| Marker (importer tags) | Realized behaviour | Under | Carries |
|---|---|---|---|
| `SpinnerMarker` | `SpinnerManager` | `Spinners` | one manager spins all gems (their transforms + shared axis/speed) |
| `PhysicsPropMarker` | `PhysicsProp` | `Physics` | knock tuning (Rigidbody/collider built alongside) |
| `FireworkMarker` | `FireworkTrigger` | `Triggers` | `Fireworks[]`, `VolleyStagger`, `Cooldown` |
| `FlipbookMarker` | `FlipbookAnimator` | `Flipbooks` | flattened renderer/slot/frame arrays |

(…and the rest: gems, breakables, boost pads, teleports, rails, rail gates, reset/boost volumes, ambient emitters,
animated props + triggers/pokers, the range culler, terrain patches — one `Realize<Marker, Behaviour>` line each.)

`SpinnerManager`, `PhysicsProp` and `FlipbookAnimator` are `UdonBehaviourSyncMode.None` — purely
cosmetic/local, every client runs its own copy, nothing networked (like `SurfaceDetector`'s respawn).
`FireworkTrigger` is the exception: it **broadcasts** its volley to everyone (docs/vrchat/043), so it must be
`BehaviourSyncMode.Manual` — `None` blocks `SendCustomNetworkEvent`. The flipbook is the one with a data-shape twist: UdonSharp
can't serialize a `List` of a custom class, so `FlipbookAccum` flattens the targets into parallel arrays
(`Renderers`/`Slots`/`Fps`/`FrameCounts` + one concatenated `Frames`) the marker carries straight to it.

## The fresh-project bootstrap (the only two-click)

`ImportAll.ImportFolder()` calls `UdonTools.EnsureAllProgramAssets()` **before the neutral build**. A program
asset that was just created can't be attached in the same call — UdonSharp finalizes a new program only on
the next editor tick. So if any were created this run, it logs *"created … program assets — run
OpenSlope/Load/Map... again"* and returns without building. This is a **once-per-fresh-project** two-click; the
assets persist, so every later import (including re-imports, which rebuild `OpenSlope_Map`) is a single pass. The
`…U.asset` program assets are generated locally (not committed) so their GUIDs stay local to the project.

The creator stamps a new asset's `ScriptVersion` as UdonSharp's `CurrentVersion` before saving it. OpenSlope's
checked-in behaviours are already authored in the current source format, so they do not need UdonSharp's legacy
source-rewrite upgrader. Leaving the default version `0` can make that upgrader run a whole-project Roslyn pass
during first-import/domain-reload timing; on SDK 3.10.x that can briefly lose its framework references and flood
the Console with false `System.Int32 is not defined or imported` errors. The normal forced Udon compile still runs
after creation and produces the required serialized program.

## The first-run workflow

1. Fresh project: install VRC Worlds SDK + UdonSharp, add `Assets/OpenSlope/Importer` + `Assets/OpenSlope/VRC`, stage the
   decoded data with `snowknife unity` (→ `Assets/OpenSlope/Maps/<LEVEL>` + `Assets/OpenSlope/Maps/Shared`).
2. **`OpenSlope/Load/Map...`** — first run on a brand-new project bootstraps the program assets and asks you to run
   it again; the second run (and every run after) builds the neutral scene, then the wiring pass realizes the
   markers into Udon + pairs the spatial audio.
3. **Upload.** Probes/skybox bake during import.

## Verifying

Quickest definitive check is **Play mode** (ClientSim) or an upload — Udon runs there, so anything that
moves/animates *is* the Udon behaviour. For a static check after a wiring pass, confirm there are **no leftover
`*Marker`s** under `OpenSlope_Map` (the pass strips each once realized) and that each proxy has a backing
`UdonBehaviour` (`UdonSharpEditorUtility.GetBackingUdonBehaviour(proxy) != null`). A full level import realizes and
clears its markers (e.g. ~1195) with every subsystem backed and zero missing scripts.

One snag worth knowing: a half-finished attach can leave an object with **two** backing UdonBehaviours (one
wired, one orphan with a null `programSource`). `AddConfigured` produces exactly one; if you've been poking at
an object by hand, drop the unwired duplicate.

## When an Udon behaviour silently stops (exception halts)

The most confusing failure mode in Udon: a **single uncaught exception permanently halts the whole
UdonBehaviour** — `Update`, `Interact`, every `Input*` / `OnTrigger*` callback stops firing for good on that one
behaviour. There is **no `try/catch` in UdonSharp**, so you can't recover after the fact — the guard has to be
upfront. And it's **invisible in-world**: the exception only lands in VRChat's `output_log.txt`, so to a player
the prop just freezes. The rideable board's "open-the-menu freeze" was exactly this — a `NullReferenceException`
in the collide-and-slide sweep halted the board, so the rider froze mid-air, couldn't dismount, and the ride
loops kept droning. The menu was a red herring (with steering released you just cruise into a wall and the bug
fires).

**The trap that bites most often** is a `Physics.*NonAlloc` result whose `.collider` is null. A reused results
buffer slot can come back with a null collider (a hit invalidated mid-frame, a degenerate overlap), and the next
line usually dereferences it. Worse, UdonSharp **hides** the deref: `someCollider.GetComponent<MyUdonBehaviour>()`
(for a UdonSharpBehaviour type) compiles down to `someCollider.transform.GetComponents<UdonBehaviour>()` — so a
null `Collider` throws inside an innocent-looking `GetComponent` call.

Rules that keep behaviours alive:

- **First line in every `*NonAlloc` loop body: `if (c == null) continue;`** (`Raycast` / `Capsule` / `Overlap`).
- **Null-check the collider / GameObject before any `GetComponent<…>` of a U# type** (the hidden `.transform`).
- Treat every cached or looked-up Unity Object reference as possibly-destroyed (Unity "fake-null") before deref.
- Null-check event args (`OnPlayerTriggerEnter`'s `player`, `OnTriggerEnter`'s `other`, …).

**Detecting them** (so they're never hidden): after a playtest, grep
`%USERPROFILE%\AppData\LocalLow\VRChat\VRChat\output_log_*.txt` for `will be halted`, `UdonVMException`, or
`NullReferenceException` — any hit is a real bug. ClientSim (Play mode) with the Console open catches most NREs
*with a source-mapped stack trace*; the gap is physics edge cases (like the null collider), which is where the
log-grep covers you. A toggleable heartbeat `Debug.Log` is a lightweight halt detector — a heartbeat that
*stops* is the tell-tale.

**Pinpointing a live halt** from the log's `Program Counter was at: N`, in an editor script:
`UdonSharpProgramAsset.GetProgramAssetForClass(typeof(X)).GetRealProgram()` →
`UdonEditorManager.Instance.DisassembleProgram(program)` to find the instruction at address `N` →
`program.SymbolTable.GetSymbolFromAddress(addr)` maps the heap operands (e.g. `__lcl_c_UnityEngineCollider_1` = a
local `Collider c`) and fields back to names, landing you on the exact source line.

## See also

[012 — Spinning Pickups](../012-spinning-pickups.md), [016 — Physics Props](../016-physics-props.md),
[017 — Rideable Board](017-rideable-board.md) (where this exception-halt bit),
[019 — Fireworks](../019-fireworks.md), [008 — Texture Animation](../008-texture-animation.md) (the behaviours
this realizes), [015 — Audio](../015-audio-runtime.md) (the wiring pass realizes `VRCSpatialAudioSource` from an
`SpatialAudio` tag in the same spirit), [011 — Triggers & Interactivity](../011-triggers-and-interactivity.md).
