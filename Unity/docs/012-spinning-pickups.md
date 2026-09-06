# 012 — Spinning Pickups

SSX's trick-multiplier "gem" pickups — the glowing **×2 / ×3 / ×5 snowflake icons** scattered down the
course — revolve continuously in place in the game. After import they sit dead still, because every prop
is welded into one batched mesh and so has no transform of its own to turn. This doc covers how we give
them their spin back. It's the *geometry* sibling of [008 — Texture Animation](008-texture-animation.md)
(which animates pixels, not transforms). Developed against a locally converted level.

Code: `Snowknife/Bundle/ParticleBundle.cs` (`GemTargets` — the `MainType 14` gem detection) +
`Snowknife/Bundle/PropsBundle.cs` (the spinner divert), `Importer/Editor/PropBuilder.cs`
(`Build`, `BuildSpinners`), `VRC/World/SpinnerManager.cs` (the Udon behaviour that spins all
gems from one `Update`), `Importer/Editor/ImportConfig.cs`
(`AnimateSpinners` / `SpinnerDegreesPerSec`).

## What spins, and why it's static

A course has its `Gem_TrickMultiplier_*` instances (e.g. 79) in three tiers (`YellowX2`, `OrangeX3`, `RedX5`), all `Visable=true`,
all baked into the single merged `Props` mesh ([003 — Props](unity/003-props.md)). That's exactly why they
freeze: a prop in the batched mesh is just a block of vertices, with no transform to rotate. (Despite the
shared `Gem_` name, the `Gem_RailSupport_*` instances are **not** spinners — they're static rail structure
and carry no pickup effect. A gem is identified by the **`MainType 14` (MultiplierScore) node** in its
`CollisionEffectSlot` — its trick-multiplier pickup effect — not by model name, so renamed/custom gems divert too.)

There is **no per-instance spin field** in the data. An instance carries `Rotation` (its authored resting
yaw), `Scale`, and an `EffectSlotIndex` (its pickup logic — see [011](011-triggers-and-interactivity.md)),
but the revolve itself is constant engine animation on the pickup model. So we don't read a rate — **we
choose one** (`SpinnerDegreesPerSec`, default 90 °/s ≈ one turn every 4 s).

## Our approach

`PropsBundle` diverts an instance flagged by `ParticleBundle.GemTargets` (its `CollisionEffectSlot` runs a
`MainType 14` MultiplierScore node) from the static merge, and `PropBuilder` gives it its own GameObject:

1. Collect the spinner geometry with its native split normals. A unique mesh carries ambient + three
   key/direction pairs in COLOR/TEXCOORD2..7; repeated model geometry can remain shared and receive that
   same payload through a per-renderer property block ([010](unity/010-object-lighting.md)).
2. Compute the **centroid** of those verts and recentre the mesh on it, so the prop's middle is the
   pivot. Create a GameObject at that centroid under a new `Spinners` root (sibling of `Props`, same
   identity-under-`OpenSlope_Map` transform), give it the gem mesh + the gem's own material, and attach
   `SpinnerMarker`.
3. Reconstructable copies of one model share a model-local mesh; exceptional copies fall back to a unique baked
   mesh. Persisted meshes are sub-assets of `Props.mesh`, avoiding loose assets without sacrificing instancing.

Everything else is unchanged: the gems leave the merged mesh (e.g. ~300k → **282k** verts, 91 → **83**
submeshes), and collision is untouched (it never came from the render mesh — [009](009-collision.md)).

## The spin axis

SSX pickups revolve about the **vertical**, and the importer rotates the level root −90° about X to stand
it upright ([004 — Orientation & Scale](unity/004-orientation-and-scale.md)), so vertical is **Unity world-up**.
Confirmed straight from the baked geometry: a gem's world bounding box is a thin upright plate
(≈ 1.4 wide × 9.3 tall × 10.5 deep) — spinning it about world `+Y` sweeps the flat face through
face → edge → face, which is the in-game look.

`SpinnerManager` computes its angle from **absolute time composed over the rest orientation**
(`rotation = AngleAxis(Phase + Speed·t, Axis) · rest`) rather than accumulating per-frame deltas, so it
never drifts and restores cleanly. Each gem gets a **golden-angle phase offset** (`index × 137.5° mod
360`) so a cluster doesn't revolve in eerie lockstep.

## The component (`SpinnerManager`)

A single `UdonSharpBehaviour` on `Spinners` (`BehaviourSyncMode.None`, purely local/cosmetic) drives all 79
gems' spin from one `Update`, via parallel arrays — one Udon `Update` dispatch instead of one per gem (see
[025 — Performance](vrchat/025-performance.md)). `PropBuilder.BuildSpinners` tags a
`SpinnerMarker`; the VRChat wiring pass (`VrcWiring`) realizes `SpinnerManager` from it ([013](vrchat/013-udon-components.md)). Each gem's angle
recomposes from absolute time over the rest orientation captured at `Start`,
so it never drifts:

```csharp
transform.rotation = Quaternion.AngleAxis(PhaseDegrees + DegreesPerSecond * Time.time, Axis) * _rest;
```

Udon runs only in Play mode (ClientSim) and in the upload — **not** in the Scene view — so the gems sit at
their authored angle while you're editing and revolve once you enter Play.

## What we learned (the gotchas)

### 1. Animating a prop means pulling it out of the batch
A prop welded into the one merged mesh has no transform; the only way to move *one* is to give it its own
GameObject. The cost is 79 extra draw calls — cut by GPU instancing on the gem materials + shader (they're
only 3 distinct models), so the 79 gems render through the instanced path. See
[025 — Performance](vrchat/025-performance.md).

### 2. Shared meshes move lighting out of the vertex payload
Repeated gems can share one model-local mesh. Their authored rotation lives on the GameObject, while
`_InstAmbient`, `_InstKey1..3`, and `_InstDir1..3` arrive through a `MaterialPropertyBlock`. The spinner
manager reapplies that block in `Start` because property blocks are not serialized into play/build. Unique
absolute meshes use the equivalent vertex streams.

### 3. Match on the pickup effect — not name, not texture, not `Visable`
The gems are `Visable=true` (so the [003 gotcha 4](unity/003-props.md) skip doesn't touch them), and they share
textures with other props, so neither flag identifies them. `ParticleBundle.GemTargets` marks an instance a
spinner when its `CollisionEffectSlot` header runs a `MainType 14` (MultiplierScore) node — the gem's own
trick-multiplier pickup effect (the same signal [023](023-gem-pickups.md) reads for the collect) — which pins
the real gems exactly and catches renamed/custom gems.

## Diagnostics that worked

- **The props log line**: `… (58 hidden via Visable=false, 79 spinning), 281,985 verts, 83 submeshes …
  79 spinners under Spinners @ 90 deg/s`. The spinning count + the verts/submesh drop confirm the
  extraction at a glance.
- **Two Scene-view screenshots** of one gem a couple of seconds apart: face-on (full snowflake) then
  nearly edge-on (thin sliver) proves it's revolving about the vertical, not tumbling.
- **`localEulerAngles.z` advancing** between two Inspector reads confirms the edit-mode pump is
  actually turning it (and that the per-instance phase offset landed).

## Lighting — the shaded edge that sweeps as it spins

The gem gets the exact per-instance **three-light** term live: each native normal is dotted against the
record's three fixed Unity-world directions, with its own key colour and ambient floor. As the mesh revolves,
the same faces move in and out of those lobes, reproducing the sweeping edge. `_PROPLIGHT` then modulates the
texture in the PS2 byte/sRGB domain. The shared `_DIRLIGHT` mechanism and coordinate contract are in
[010 — Object Lighting → Directional object lighting](unity/010-object-lighting.md#directional-object-lighting).

## See also

[003 — Props](unity/003-props.md) (the merged mesh these are carved out of), [004 — Orientation &
Scale](unity/004-orientation-and-scale.md) (why vertical is world-up), [008 — Texture
Animation](008-texture-animation.md) (the pixel-animation sibling and the identical Udon caveat),
[010 — Object Lighting](unity/010-object-lighting.md) (the baked vertex colour the gems keep + the directional sweep),
[011 — Triggers & Interactivity](011-triggers-and-interactivity.md) (the pickup logic the gems also carry).
