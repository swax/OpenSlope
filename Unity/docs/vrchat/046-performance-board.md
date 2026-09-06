# 046 — In-world performance controls

**The Performance Board is retired.** It started as one panel of "turn the heavy cosmetics off for yourself"
checkboxes and ended up as the odd one out: half its rows were things a *visitor* sets once for comfort, and half were
things a *developer* flips while staring at a frame counter. Those are different jobs, so the rows moved to the two
boards that already did each job, and the panel itself was deleted rather than kept as a near-empty third.

This document is now the map of **where each performance control lives** — plus the world's performance model and
profiling notes, which were always about the world rather than the board.

## Where the controls went

The rows split once, then settled. Today every performance claw-back is on **one** panel — the **Tuning Board** (bench
slot 4; its class and scene object keep the older `Diagnostics` name, and it's still `OpenSlope/Setup/Diagnostics Board` in
the menu) — and the Settings Board is purely the visitor's own taste.

| Control | Now on | Section |
|---|---|---|
| **Falling snow** → *Snow effect* | Settings Board ([047](047-settings-board.md)) | WORLD |
| **Show FPS / debug** (+ the head-following HUD it shows) | Tuning Board | DIAGNOSTICS |
| **Ride telemetry log** | Tuning Board | DIAGNOSTICS |
| **Snow cannons** + **Road flares** + **Ambient emitters** + **Fireworks** → one *Particles* row | Tuning Board | PERF |
| **Fog banks** | Tuning Board | PERF |
| **Cull distant geometry** | Tuning Board | PERF |
| **Other riders' FX** | Tuning Board | PERF |
| **My board FX** | Tuning Board | PERF |

The emitter controls became **one**, labelled *Particles (fireworks, flares, etc.)*: the snow-cannon plumes, the road
flares/lanterns, collision-triggered ambient bursts and firework trigger volumes are the same kind of thing to a player,
and nobody flipped them independently — the parenthetical is there so the row still names what it actually switches off.
The setup collects the persistent `Emitters` groups and the collision-driven `AmbientEmitters` root; the static mesh
billboards under `Particles` remain on the separate *Fog banks* row. The label is the **longest label on any bench board**,
and these `Text`s overflow rather than wrap, so re-measure before lengthening it further.

### Rows that were deleted outright

| Control | Why it's gone |
|---|---|
| **HD terrain** | the render-terrain swap. Nothing switches `TerrainHD` on any more — the importer ships that root **inactive**, so the base terrain is now what everyone sees. Activate the root by hand in the editor to look at the HD bake. |
| **Crowd / sign anim** | the flipbook driver now simply runs. |
| **Gem spin** | the spinner manager now simply runs. |
| **Collide with props** · **Wall ride** · **Ride solid props** | the ride-physics A/B switches. The fields still exist on `RideableBoard` (`collideWithProps` / `wallRide` / `rideSolidProps`, all defaulting **true**), so the ride is unchanged — they're just inspector knobs again rather than in-world rows. |
| **Mode-2 body sphere collision** | the targeted A/B is complete and the sphere pass is now locked in as default shipping behaviour. `RideableBoard.bodySphereCollision` remains default-on as an inspector/code fallback for disabling only that pass. |
| **Ground VR view: 25%** · **Ground VR view: pinned** · **Board yaw from stick: 50%** · **Stick carve lean: 50%** · **Precision stick curve** | headset testing completed. The successful behavior is now part of the ride model: 25% grounded VR view carry, full air/rail carry, and the precision curve in every ride state with 100% output at hard lock. The alternatives were removed. |

Everything that survived kept its switch mechanism, its default, and its per-map "only build the row if that system
exists" rule. Both boards are still **per-player and local** (sync `None`): a click changes only the local client's
view, and every system they touch is itself a local cosmetic, so nothing networked is disturbed.

## Per-platform starting state

`DiagnosticsBoard.ApplyPlatformDefaults()` (run on `Start`, before `Apply`) sets the *initial* state of the two
board-FX rows — the only PERF rows that don't start ON. It's compiled **per-build** with `#if UNITY_ANDROID`: a VRChat
**Quest** upload defines `UNITY_ANDROID`, the **PC** upload defines `UNITY_STANDALONE`, and UdonSharp respects the
active build target, so the Quest branch lands in the Quest build only. Each user runs their own platform's build, so
each gets the right defaults; the boards are sync `None`, so a mixed PC/Quest instance doesn't conflict. (It moved here
from `SettingsBoard` with the two rows themselves.)

| toggle | PC start | Quest start |
|--------|:--------:|:-----------:|
| My board FX (your own wake / spray) | on | **off** |
| Other riders' FX | on | **off** |
| everything else (sound, snow, particles, fog, cull) | on | on |
| Ride telemetry log · Show FPS / debug | off | off |

Rationale: the world cosmetics run fine on both platforms, so everything starts on. Quest starts the two per-frame
Udon board-FX pipelines off — your own board's wake isn't visible in first person, and remote riders' FX are the cost
that scales with a busy instance; a Quest player can re-check both. **Fog banks** starts on everywhere despite being the
biggest fill-rate lever: the fog is part of how a course looks, so trading it away is the visitor's call rather than
ours. The distance cull starts **on** both platforms but its *range* is per-platform (Quest 600 m / PC 1200 m, set at
build time in `ObjectCuller`), so on PC it barely culls. **Gotcha:** to *see* the Quest set in ClientSim you must
switch the editor Build Target to **Android** (so `UNITY_ANDROID` is defined and the Udon program recompiles);
otherwise the editor runs the PC defaults.

## Wiring notes

- `EmitterBuilder` groups the continuous emitters into `Emitters/Cannons` (the `Mdl_SnowBlower_*` plumes) and
  `Emitters/Flares` (the road flares + stone lanterns), while `AmbientEmitterBuilder` puts collision-triggered water,
  dust, spark and fire effects under `AmbientEmitters`. The Tuning Board collects those roots plus every
  `FireworkTrigger` into one `particleObjects` array behind the single *Particles* row. Turning it off deactivates the
  ambient trigger colliders and Udon along with their particle systems. Empty groups are pruned, so a map with no
  emitters at all gets no row.
- The "Other riders' FX" toggle works because the pooled boards are **pre-placed scene objects**:
  `DiagnosticsBoardSetup` writes a `diagnosticsBoard` ref onto each (`RideableBoard.diagnosticsBoard`) and pushes
  it. `RideableBoard.Fx.cs` early-outs of the **remote** FX path when `diagnosticsBoard.remoteRiderFx` is false; a
  null ref defaults to FX-on (so un-rewired boards are unaffected). Your **own** board's FX are never gated by that row.
  (The Settings Board did this push until the two rows moved; both the ref and the field it reads changed name with
  them, so an old scene needs one `OpenSlope/Setup/Diagnostics Board` run to be re-wired.)
- The "My board FX" toggle is the local counterpart: each board reads `diagnosticsBoard.boardLocalFx` via
  `RideableBoard.LocalFxOn()` and, when off, stops driving **its own** `UpdateWakeTrail` + `UpdateSpray` (the ride
  call site in `RideableBoard.cs` and the riderless-coast wake in `.Mount.cs`), fading any laid ribbon via
  `WakeAgeOnly`. Profiling showed the local wake+spray is ~1–2 ms of Udon per ridden frame on desktop (more on Quest),
  so this is the biggest player-facing lever for a weak headset.
- The "Fog banks" row is a **renderer switch**, and its renderers are found by the `Fog*` name prefix under the
  `Particles` root rather than by "everything under `Particles`" — that root also carries sparkles, smoke and spray, and
  a row labelled *Fog banks* must not quietly take those with it. It is the largest fill-rate claw-back the world has:
  a puff is a camera-facing `ZWrite`-off sprite, so inside a bank it shades every viewport pixel once per overlapping
  puff, doubled for stereo (measured on Aloha's tunnel: 61 puffs within 250 m, ~27× viewport of blended coverage).
- The "Cull distant geometry" row is a **two-tier range switch, not an on/off** (see [unity/006](../unity/006-skybox.md)):
  the culler stays active either way — Quest can't afford unbounded draw — and `SetCull` swaps the tight range for the
  wider one, with the distance fog following. **Checked = tight cull**, the faster state.
- Analytic ride contact (the bounded bicubic probe/patch solve) **isn't a row on either panel** — it is an
  unconditional part of the shared ride model when patch data exists. Re-profile the bounded solver on Quest before
  claiming its final cost; the old one-eval measurement does not cover it.

## Apply / gotchas

Apply by re-importing the map (for the emitter `Cannons`/`Flares` split) then `OpenSlope/Setup All`, which builds the
Settings Board and then the Tuning Board **last**, so all of their refs are live.

- **Each board holds LIVE refs to every system it toggles, so it must be (re)built AFTER them.** Rebuilding a
  controlled system *after* its board orphans that ref and makes the row a no-op. If you rebuild one system by hand,
  re-run `OpenSlope/Setup/Settings Board` or `OpenSlope/Setup/Diagnostics Board` afterward.
- A scene built before the retirement still carries a `GateBench/PerfBoard` object. `DiagnosticsBoardSetup` deletes
  it on its next run (it is now the sole heir of that board's rows), so no manual cleanup is needed — just re-run the
  setup. It clears a legacy `RideTuneBoard` the same way.
- **A scene built before the board-FX rows moved needs one Tuning Board run**, because the pooled boards' ref changed
  from `settingsBoard` to `diagnosticsBoard`. Until that run every board reads a null ref — which floors to FX-on, so
  the worst case is the two claw-backs doing nothing, never FX stuck off.

---

## Performance model

The per-frame cost on this world is **Udon `Update` self-time**, not rendering — see [025 —
Performance](025-performance.md) for the full cost model, the optimization systems (one-manager Updates,
frame-throttles, pool sizing, draw-call batching, geometry chunking + range-cull), and the measuring tools. The board
checkboxes are the player-facing levers; the measured ones:

| lever | measured Udon |
|-------|:----:|
| My board FX (wake + spray) | ~1–2 ms / ridden frame (more on Quest) |
| analytic patch contact (always-on for patch-backed terrain) | ~0.8 ms / grounded frame |

The cosmetic ratings (particles, fog) are GPU-overdraw estimates, unmeasured — every profiling run had them off. The
single biggest Quest cost is **none of these** — it's the board's rail lock-on scan, which is grid-accelerated
([026](../026-rail-grinding.md)). Read the board's own per-section `Update` timing via the Tuning Board's
**Show FPS / debug** toggle to see where a frame actually goes.

## Profiling notes

- **On Quest:** the self-timing HUD above + **OVR Metrics Tool** (real app CPU/GPU ms, FPS, GPU utilisation) —
  Unity's profiler can't attach to VRChat-on-Quest.
- **In editor:** read the Profiler programmatically via `ProfilerDriver.GetHierarchyFrameDataView` (sum
  `columnSelfTime` per marker — the bottleneck marker is `UdonBehaviour.ManagedUpdate`); bin frames by
  `frameTimeMs` (standing / riding / hitch) and report per-bin. **Never judge framerate in ClientSim** —
  `EditorLoop` overhead dominates, and the editor throttles while unfocused.
- **A/B a flag in Play:** write the **backing** var (`UdonBehaviour.SetProgramVariable(...)`), not the UdonSharp
  proxy field (the proxy reads stale in Play); **Pause** (don't Stop) to freeze the buffer for reading.
