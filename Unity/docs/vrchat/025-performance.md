# 025 — Performance

How the imported world stays in frame budget on PCVR **and** Quest. The scene avoids the usual VRChat traps by
construction — single-pass stereo, all Rigidbodies kinematic, every runtime behaviour `sync None`/local, heavy
`Update()`s early-return, no realtime lights (ambient-from-skybox, 0 shadow passes) — and adds the systems below
for the SSX content's specific costs. Developed against locally converted levels.

## The cost model

Three things dominate, in roughly this order on Quest:

1. **Interpreted Udon `Update`.** Two parts: the per-frame *execution* of any behaviour with an
   `Update`/`FixedUpdate`/`LateUpdate`/`PostLateUpdate`, and a fixed *registration tax* — VRChat's `UdonManager`
   bookkeeps **every** registered behaviour each frame, active or asleep, so inactive pooled objects are not free.
2. **Draw-call / SetPass submission (CPU side).** A combined mesh with one submesh+material per source texture
   issues one SetPass each; on Quest the CPU stalls submitting while the GPU finishes the trivial geometry and
   idles. The signature of this bound is **GPU utilisation dropping** during a slowdown.
3. **Overdraw** — transparent particles/cutouts, GPU fill.

Geometry (triangle count) is rarely the bound; the GPU is usually idle. So most of the work below cuts **Udon
ticks** and **draw calls**, not polygons.

## Udon: one manager, not many `Update`s

- **Spinner manager.** The 79 trick-gem spinners run from **one** `SpinnerManager` (`VRC/World`) looping
  flat parallel arrays, not 79 per-gem `Update`s. The gem *collect* logic stays per-gem on `GemPickup` — it's
  event-driven (trigger callbacks), no `Update`. ([012](../012-spinning-pickups.md))
- **Frame-throttle on the genuine ticks** that don't need 60 Hz: `AnimatedPropU` (snow-blowers) and
  `SurfaceDetector` run every Nth frame via `updateInterval` (default 3), accumulating elapsed time/travel so
  speed and cadence are unchanged.
- **Event-driven behaviours are free per-frame** and stay per-object: gems, physics props, breakables, prop
  bounce, boost pads, foliage triggers all fire on collision/Interact with no `Update`. They can't be merged into
  a manager without trading free events for per-frame polling.
- **Board pool sized to peak riders** (`StartGateSetup.BoardCap`, 32). Boards are a `VRCObjectPool` (networked,
  sync IDs assigned at scene load — a runtime-instantiated board wouldn't sync), so a pre-placed pool is
  mandatory and its *size* is the only lever against the registration tax (the board carries a heavy synced
  program). The ridden board is the only one that integrates; the rest early-return.
- **GPU instancing** on `OpenSlope/UnlitDoubleSided` (`#pragma multi_compile_instancing`; `MaterialFactory` sets
  `enableInstancing`), so the per-instance props/gems render through the instanced path.

## Draw calls: Texture2DArray batching

The combined **Props** and **Terrain** meshes carry one submesh+material per source texture (dozens each) — every
visible submesh is a SetPass. SSX textures **tile** (UVs run past `[0,1]`), so a rect-atlas can't merge them.
`TextureArrayPacker` instead stacks each render-config group's textures as the **slices of a Texture2DArray**
(each slice wraps independently, so tiling is preserved) and bakes the per-vertex slice index into **`UV0.z`**;
the `Unlit` `_TEXARRAY` path samples `UNITY_SAMPLE_TEX2DARRAY` by that slice, collapsing N per-texture
submeshes to one draw. Flipbook (`flip_`) and UV-scroll submeshes are left alone. Wired into `TerrainBuilder` /
`PropBuilder` (`ImportConfig.BatchDrawCalls`); also `OpenSlope/Optimize/Batch Draw Calls` for a live scene.

No single compressed format samples on both desktop (BC/DXT) and mobile (ASTC), so the packer bakes **both**
(`…/TexArrays/PC` BC, `…/TexArrays/Mobile` ASTC_6x6 — Quest + iOS share it) from each slice's original PNG;
`TexArrayPlatformSwap` re-points every `_TEXARRAY` material's array to the active build target, so a combined
PC/Android/iOS build ships the right format on each.

## Geometry visibility: chunk + range-cull (the engine's model)

The importer merges all placed props into **one** renderer and terrain into another, each with a **map-spanning
bounding box** — so Unity's frustum culling can never drop any of it; the whole course draws every frame. The
original engine never did this: it kept terrain in per-patch frustum-culled tessellation and placed objects in a
~100 m spatial grid drawn by **(range ∩ frustum)** (RE, Trailmap/specs/400-rendering). Two systems restore that:

- **`StaticChunker`** (`OpenSlope/Optimize/Chunk Static Geometry`) splits the merged Props/Terrain renderers into a
  spatial grid of per-cell child renderers, each with a tight bounds so frustum culling works. Chunks share the
  collapsed Texture2DArray materials (no texture duplication); the animated crowd/sign/LCD submeshes stay in the
  source renderer so the flipbook's `(renderer, slot)` wiring holds, and the static submeshes there are emptied.
  Runs as the first step of `Setup All` (idempotent via `ChunkMenu.IsChunked`, so a repeated pass skips the
  re-split) and is re-runnable from the menu to retune the cell size. The **`TerrainHD`** render swap
  ([046](046-performance-board.md)) is chunked like `Terrain` — its chunks sit under the (inactive-by-default) HD
  root, so whichever terrain is showing stays frustum/range-cullable rather than one map-spanning renderer.
- **`ObjectCuller`** (`sync None`, local) gates each placed-object renderer **and the static chunks** beyond a
  range of the local player, re-evaluating only after the player moves ~25 m. Each renderer is gated on its **mesh
  world-centre** (`Renderer.bounds.center`), not its transform position: a diverted breakable's GameObject sits at
  the level origin (its mesh carries absolute root-local coords), so `bounds.center` is what makes it cull by its
  true on-screen position (and it already equals the transform for recentred props / chunks). Range is
  **per-platform, chosen at build time** (`#if UNITY_ANDROID`): **Quest 600 m, PC 1200 m** (`rangeQuest`/`rangePC`
  fields). Its `OnDisable`
  re-shows everything, so it can be toggled off cleanly for unbounded draw distance. `ObjectCullerSetup`
  gathers the **drawn** renderers under the prop roots + the chunk hosts — the disabled breakable-shard twins are
  skipped — and is wired into `PropBuilder` and the perf menu.

## Placed props: static-batch the intact breakables

The chunker only merges the static Props/Terrain; interactive placed props (gems, breakables, animated props)
stay as individual renderers so they can spin / break / animate. Of those, the **intact breakable logos** don't
move while intact — a break HIDES the intact renderer and throws SEPARATE dynamic shard twins — so `PropBuilder`
flags them **`BatchingStatic`**. Logos sharing a material then collapse from one draw each into ~one draw per
material: on a city map, **435 intact logos across 17 materials → ~17 batched draws**. Per-object
`Renderer.enabled` toggling still works inside a static batch (a disabled renderer just drops out of it), so the
range-culler and the break's hide/respawn are unaffected; only the disabled shard/piece twins (which translate
when thrown) stay dynamic. Flipbook / UV-scroll logos batch too — static batching fixes the mesh, the shader still
animates UVs at draw.

Gems and animated props stay one draw apiece: each is a **unique mesh**, so neither static batching (they move) nor
GPU instancing (nothing to collapse) helps. Giving the gems a small shared set of meshes is the next available lever.

## The ridden board

The ridden board's `Update` is the main per-frame Udon cost; the other 31 boards early-return.

- **Rail lock-on** queries the level's rail network every frame. `RailNetwork` bins rail segments into a spatial
  grid so the query touches only nearby segments instead of scanning all ~169 rails — the same broad-phase the
  engine used. This is the board's single biggest per-frame win near rails. ([026](../026-rail-grinding.md))
- **Board FX** (your own carved wake + snow spray) is optional per-frame Udon the tester can drop via the
  Tuning Board's PERF row *My board FX*. Analytic bicubic contact is part of the ride model and is not toggleable;
  missing/rejected patch data automatically falls back. Remote riders' FX gate under *Other riders' FX*.
- **Ride telemetry** is a default-off Diagnostics-board row. It emits a long parseable `RIDE_DBG` record every local ridden
  frame and is intentionally expensive; enable it only for short gold-comparison captures, never as a shipping
  diagnostic.
- **Self-timing HUD.** The board measures its own `Update` wall-time (`dbgUpdateMs`, via `Time.realtimeSinceStartup`
  deltas) plus a per-section breakdown (`dbgSecProbe/Rail/Integ/Orient/AudioFx`) and the debug HUD shows it as
  `brd 3.1ms = pr0.3 rl0.1 in1.2 or0.5 ax0.1`. This splits a slowdown into *inside our Udon vs. outside* and then
  *which section*, so an on-device cost is localised in one ride instead of repeated blind builds. Cheap; kept as
  a permanent diagnostic. Shown by the Tuning Board's *Show FPS / debug* toggle.

## The in-world performance controls

A per-player panel of checkboxes by the start gate that turns the heavier cosmetic + board-FX systems off **for
that client**, with **per-platform starting defaults** (`#if UNITY_ANDROID`). Full breakdown in
[046 — In-world performance controls](046-performance-board.md).

## Measuring

- **In-world (best for Quest):** the board's self-timing HUD above + **OVR Metrics Tool** (real app CPU/GPU ms,
  FPS, GPU utilisation) or VRChat's stats overlay. Unity's profiler can't attach to VRChat-on-Quest.
- **Editor:** `UnityStats` gives draw-call / SetPass / triangle counts and `frameTime`/`renderTime`, valid even
  while throttled; `FindObjectsOfType` for inventory; `ShaderUtil.GetShaderMessages` for shader health.
- **Caveats.** The editor throttles to ~4 FPS while its window is unfocused (Preferences → General → Interaction
  Mode → No Throttling, or focus the Game view); frame-time reads otherwise are throttle artifacts. Editor Play
  mode carries `EditorLoop` + no IL2CPP overhead, so it's the pessimistic case — never judge framerate in
  ClientSim. VRAM/texture-memory counters only populate in a player build.

## See also

[012 — Spinning Pickups](../012-spinning-pickups.md), [013 — Udon Components](013-udon-components.md) (the
one-manager / parallel-array pattern), [008 — Texture Animation](../008-texture-animation.md) (the flipbook
manager), [026 — Rail Grinding](../026-rail-grinding.md) (the rail-query grid), [046 — Performance
Board](046-performance-board.md), [005 — Materials & Alpha](../unity/005-materials-and-alpha.md) (the `Unlit` shader),
[034 — The Bundle Pipeline](../../../Snowknife/docs/034-bundle-pipeline.md).
