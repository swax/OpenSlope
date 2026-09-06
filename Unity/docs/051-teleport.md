# 051 — Teleport portals

This page describes the OpenSlope port of SSX teleport triggers. The canonical
opcode, target resolution, source timing, and landing behavior belong to
[Trailmap: 390-pickups-and-race].

## Bundle pipeline

`Snowknife/Bundle/ParticleBundle.cs` scans collision effect slots for teleport
nodes, resolves the named destination instance, obtains the source bounds, and
captures the optional sound node. It writes `manifest.Teleports` records with
the trigger box, resolved destination, and cue id. The discovery is data-driven
and does not depend on model names.

## Unity import

`Importer/Editor/TeleportBuilder.cs` creates a `Teleports` root containing:

- an inflated trigger `BoxCollider` at the source;
- a destination anchor that follows level recentering and scaling;
- an optional local, non-spatial entry cue; and
- a `TeleportMarker` consumed by `VrcWiring`.

The cue is intentionally 2D because the local listener moves away from the
source immediately. Refresh the generated objects with
**OpenSlope > Refresh > Teleports**.

## Runtime mapping

`VRC/World/Teleport.cs` handles the local walking player with
`VRCPlayerApi.TeleportTo`. A ridden board is detected through `RiderProbe` and
uses `RideableBoard.RespawnAt`, which carries the station passenger and keeps
the ride state coherent.

The behavior is local and has no synchronized component state. A cooldown
prevents immediate re-entry. OpenSlope derives facing from source to
destination and applies `TeleportUpOffset` to walking arrivals; both are
implementation choices rather than additions to the canonical SSX spec.

## Configuration and verification

Relevant `ImportConfig` fields are `EmitTeleports`,
`TeleportTriggerInflate`, `TeleportCooldown`, `TeleportUpOffset`, and the
teleport cue volume/distance controls.

Verify source bounds, destination placement after world transforms, walking
and ridden entry, retained board occupancy, cue playback, facing, ground
clearance, cooldown behavior, and maps with no teleport records.
