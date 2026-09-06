# 031 — Out-of-bounds reset

This page documents the Unity board recovery system. Canonical SSX reset
sources, rider-state behavior, wedge integration, race-line selection, and
rubber-band placement live in [Trailmap: 110-terrain, 230-level-ssf,
300-rider-states, 390-pickups-and-race].

The port is board-only and local. Free-walking behavior is intentionally
unchanged.

## Inputs and detection

Snowknife delta-decodes and deduplicates eligible `AIP.json` and `SOP.json`
lines into `manifest.Paths.Course`. `CoursePathBuilder` realizes those
root-local polylines as a `CoursePath` marker backed by the same nearest-point
query used for rails.

`RideableBoard.OutOfBounds` accepts three implementation inputs during an
active timed run:

- `ResetZone.TriggerReset`, including the generated floor;
- grounded contact with an imported `Surf_0` collider; and
- the object-contact wedge integrator fed by `ResolveObstacles`.

The wedge input excludes terrain and uses only blocking contacts. Mount,
teleport, and reset clear its accumulated state. Grinding clears stale ground
sensor state before contact polling resumes.

The feature is race-gated and cooldown-protected. The port does not infer an
out-of-bounds condition from airtime, fall distance, or missing terrain.

## Generated floor

`VolumeBuilder.BuildOobFloor` adds a map-wide reset trigger as a safety net for
gaps between authored zones. It least-squares fits a plane through terrain
collision vertices, anchors the slab at the fit centroid, and shifts it below
the most restrictive residual plus `OobFloorDrop`. The exhaustive residual
pass is what guarantees that the top face stays below all sampled terrain.

`OobFloorTilt` may disable the slope fit. `OobFloorMargin` controls horizontal
overhang and `OobFloorThickness` controls tunneling headroom versus broadphase
cost. The generated trigger has no custom runtime path; it uses the same
`ResetZoneMarker` as authored volumes.

Map setup places VRChat's `RespawnHeightY` below the floor top evaluated over
the actual map extent. It ignores trigger bounds and unrelated world-system
renderers so VRChat does not eject the rider before the board recovery runs.

## Restore policy

`ResetToTrack` uses `RespawnAt` to carry the station passenger without a
dismount, selecting the first available destination:

1. nearest point on the authored course path within `courseResetMaxDist`,
   projected onto real terrain and oriented down-course;
2. an earlier on-track breadcrumb when no usable course path exists; or
3. a full eject/respawn when neither source is safe.

Repeated resets in a short interval escalate to the full fallback to break a
bad landing loop. Breadcrumbs are recorded only while grounded on a normal
surface and are cleared on mount or teleport.

## Deliberate divergences

- The port chooses the nearest course-line point and does not implement the
  original multiplayer rubber-band bias.
- `ResetToTrack` also fires the port's knockdown feedback, while the original
  game keeps wipeout recovery and course reset distinct.
- The generated map-wide floor is an OpenSlope safety volume, not an original
  SSX rule.

## Configuration and verification

Board controls are `resetToTrackOnOOB`, `resetWhenWedged`,
`courseResetMaxDist`, `crumbSpacing`, and `resetBackDistance`. Import controls
are `EmitOobFloor`, `OobFloorTilt`, `OobFloorDrop`, `OobFloorMargin`,
`OobFloorThickness`, `EmitResetZones`, `ResetZoneInflate`, and
`BuildCoursePath`.

Rebuild with **OpenSlope > Refresh > Reset & Boost Volumes**, then rerun map
respawn fitting. Verify all authored zones, `Surf_0`, wedge-only object contact,
course projection, downhill facing, breadcrumb fallback, anti-loop escalation,
floor clearance, and that VRChat's respawn line remains below the floor.

See [053 hazards](053-hazards-movers-and-wind.md),
[017 rideable board](vrchat/017-rideable-board.md), and
[026 rails](026-rail-grinding.md).
