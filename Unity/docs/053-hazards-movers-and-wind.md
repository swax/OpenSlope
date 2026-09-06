# 053 — Hazards, movers, and soft-body wind

This page collects Unity realizations of several data-derived SSF world
features. Canonical node fields, timing, containment tests, mover laws, lap
state, and native soft-body behavior live in [Trailmap: 150-logic,
230-level-ssf, 360-speed-and-boost, 390-pickups-and-race].

## Reset zones

`ParticleBundle.BuildResetZones` bakes host bounds into
`manifest.ResetZones`. `VolumeBuilder` creates trigger colliders and
`ResetZoneMarker`s; platform wiring realizes the runtime component.

`ResetZone` calls the board's existing `TriggerReset` path only for a local
rider in a timed run. Walking and free-ride players are not moved.

An animated host is a special Unity case: a rest-pose volume would continue to
cover the opening after the prop moved. The importer instead tags that host's
real collider with `_R`; the board reads the tag from an actual obstacle hit
and invokes `ResetOnContact`. No component is added to the swept collider.

## Boost volumes

`ParticleBundle.BuildBoostVolumes` writes each resolved volume's bounds,
semantic kind, shared vector/rate fields, lifetime mode, and kind-specific
altitude or stage data to `manifest.BoostVolumes`. `VolumeBuilder` creates an
inflated broadphase trigger and marker. Altitudes and lengths are converted
where the level transform is known; directions remain trigger-local.

`BoostVolume` and `BasisBoostVolume` run while the rider is inside the trigger,
then perform a swept board-position test against the authored box after
subtracting `BroadphaseMargin`. This avoids early activation from the inflated
collider and catches fast crossings of thin volumes.

The board exposes the portable operations used by the volume kinds:

- `ApplyBoostPush` for the authored-axis velocity approach;
- `KillBoostHorizontalVelocity` for lift behavior;
- `SnapToBoostAltitude` for arrival handling; and
- `BoostStage` for the lap-stage/tube-end handoff.

The runtime deliberately does not treat a volume like an arrow pad or infer a
new speed-cap tier. Mode handling and kind-specific retirement follow the
semantic bundle record; their original rules are specified only in Trail Map.

### Lap configuration

`LeaderboardSetup` copies `manifest.Race.Laps` to the map's `FinishLine`. The
board auto-discovers that object, seeds `LapsRemaining`, and shares the value
with lap-gated boost volumes. Authored maps supply the value through their
export rather than a Unity course-name table.

Inspector edits are replaced by the next leaderboard rebuild, so persistent
changes belong in the map source. Basis currently treats the run as a score run
until its finish-trigger path supplies equivalent lap transitions.

## Spline movers

`ParticleBundle.BuildSplineMovers` resolves direct and named-instance mover
graphs, samples the referenced path, and writes speed, copy count, display
metadata, template rotation, and end/orientation modes. The target is diverted
from the merged prop mesh with its instance origin as the pivot.

`PropBuilder` creates the template under `Movers`. `SplineMoverBuilder` adds a
marker, clones renderer-only copies, distributes their start distances by arc
length, and optionally builds the cable as a zero-width ribbon rendered by
`OpenSlope/ScreenLine` in clip-space pixels.

At runtime every copy samples a shared distance cursor and applies its own
offset. `SplineMover` handles open-path wrap, removal, ping-pong, or endpoint
hold, plus the extracted yaw/pitch policy. It works in level-local mesh space
and compensates for the baked template transform. Movers are cosmetic and have
no collider.

The moving objects are excluded from the static range culler because its
positions are cached. When changing orientation code, verify model-axis
selection, handedness, return-leg facing, pitch policy, and both open and
closed paths.

## Flag wave and fence flex

`SoftBodyTargets` diverts applicable instances as `softflag` or `softfence`.
`PropBuilder.BuildSoftBodies` batches each kind by material, writes a per-vertex
flap weight to `UV0.w`, and selects the `_WIND` shader variant.

The shader applies a location-phased horizontal sway weighted from anchored
base to free edge. Flags use it as a continuous implementation of their
persistent effect. Batched fences use a low constant shimmer as a deliberate
approximation: Unity does not currently reproduce per-fence contact-driven
spring state.

Importer controls are `WindFlagStrength/Speed/Freq` and
`WindFenceStrength/Speed/Freq`.

## Culling, refresh, and verification

`ObjectCullerSetup` includes the `Emitters` root after emitter construction but
continues to exclude movers. This prevents distant snow cannons and flares from
remaining visible solely because they are in the camera frustum.

Rebuild volumes with **OpenSlope > Refresh > Reset & Boost Volumes**, movers
with **OpenSlope > Refresh > Spline Movers**, and soft bodies/culling through
the prop reload path. Verify local-only activation, transformed bounds,
high-speed swept entry, finish-tube stage handoff, mover copy spacing, cable
width, anchored wind vertices, and emitter range culling.
