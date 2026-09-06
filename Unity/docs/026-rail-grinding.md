# 026 — Rail Grinding (Unity port)

Rail data, candidacy, analytic travel, control, and exit behavior are specified
in [Trailmap: 140-paths], [Trailmap: 230-level-ssf], and
[Trailmap: 350-rails]. This document covers the bundle-to-Unity pipeline and the
VRChat board's realization and divergences.

## Data pipeline

Snowknife samples exported cubic splines once and writes flattened points,
per-rail ranges, styles, and gating sets under `manifest.Paths.Rails`.
Style-less legacy manifests retain the importer fallback described by the
bundle pipeline; see [Snowknife: 034-bundle-pipeline].

Mode-specific content stays present in the bundle:

- showoff rail indices are carried separately from their visible prop meshes;
- collision and prop nodes carry the same mode mask as their source instance;
- runtime-gated rails start disabled and are paired with their enabling trigger;
  and
- race/showoff/free-ride selection changes visibility and rail candidacy without
  rebuilding the map.

This is an implementation transport. The meaning of spline styles and logic
nodes remains canonical in Trailmap.

## Importer

`Importer/Editor/RailBuilder.cs` reads the manifest, bakes one flattened local
point array plus rail start/count/style arrays, and places a `RailMarker` on the
map's `Rails` child. `VrcWiring` realizes the marker as `RailNetwork`.

The rail points use the same per-vertex handedness mapping and map-root
transform as terrain and props; see
[004 — Orientation & World Scale](unity/004-orientation-and-scale.md). Grinding
uses mathematical queries and creates no per-rail collider.

`RailDebugDraw` can add temporary line renderers for alignment inspection.
`BuildRails` and `RailSamplesPerSegment` control import-time generation.

## `RailNetwork`

`VRC/Riding/RailNetwork.cs` world-bakes the static points at startup and bins
segments into a uniform spatial grid. It has no `Update`; boards drive its
queries. Public result fields are used instead of return tuples or `out`
parameters to stay within the Udon cross-behavior contract.

The runtime exposes three query shapes:

- nearest enabled rail near a point for entry;
- nearest point on one known rail for continued travel and endpoint detection;
  and
- best aligned endpoint on another rail for a junction transfer.

If the grid cannot be built, the implementation falls back to its bounded
per-rail search. `SetRailEnabled` changes runtime candidacy independently of
mode selection.

## Board state

`RideableBoard.Rail.cs` is an early, self-contained path in the board update.
Entry queries the network, applies the configured speed/alignment gates, and
captures the selected rail. While active it owns position, orientation, exit,
and grind effects before returning to the normal Ground/Air branches.

The port keeps rail travel on the sampled network, reprojects every tick, and
can transfer between authored rail endpoints. The rail's style selects the
generated surface row. Boost, ollie, and carried velocity are integrated with
the board's existing input and state machinery.

### Deliberate control differences

The VRChat port prioritizes headset and free-look comfort. It allows the deck
heading to steer independently of the rail travel direction and uses a
configurable ollie-off split. Optional curve-fling is disabled by default, and
the port does not add a balance minigame. These are Unity/VRChat choices, not
alternate statements of [Trailmap: 350-rails].

Jumping, endpoint exit, low-speed drop, failed contact, and station exit all
cleanly release the rail state. A short cooldown prevents immediate relock.

## Mode and trigger realization

The Settings Board applies the manifest's mode sets locally:

- Race hides/disables showoff-only content;
- Trick/Showoff enables it and hides race-only content; and
- Free ride disables both authored mode-only sets.

Independent rail gates, such as an animated object that later becomes
rideable, use `RailGateBuilder` and `RailGate` to enable their listed rail
indices. A mode change does not erase that trigger state.

## Grind effects

`RideableBoardSetup` creates a looping grind `AudioSource` and a spark
`ParticleSystem` under `BoardFX`. `UpdateGrindFx` drives both from the active
grind state and places sparks at the rail contact, independent of the freely
steered deck heading. Missing assets fall back or remain silent without
breaking rail physics.

Re-run `OpenSlope/Setup/Start Gate Boards` after changing the board schema or
effect setup.

## Tuning

Board settings cover entry radius/speed/alignment, deck height, low-speed and
distance exits, ollie-off behavior, optional curve fling, junction transfer,
slope/boost acceleration, logging, and grind volume. These values are Unity
port tuning. Canonical source constants stay in Trailmap and shared generated
contracts where applicable.

## Verification

- Confirm the import log reports the expected bundle rail and sampled-point
  counts for the selected map.
- Compare rail world bounds with terrain bounds to catch scale or handedness
  errors.
- Probe on-rail, endpoint, junction, disabled-rail, and far-away cases.
- Use debug lines to verify mathematical paths lie on visible props.
- Exercise all three mode selections plus an independently gated rail.
- Ride-test entry, transfer, ollie, endpoint, station-exit, and cooldown paths.

## Known gaps

- Entry/seat tolerances still require per-map ride tuning.
- Deck-only free steering cannot rotate the station avatar independently of the
  VR view.
- Continuous rail-trick scoring is a separate future layer.
- Board ownership/networking follows
  [017 — Rideable Board](vrchat/017-rideable-board.md).

## See also

[003 — Props](unity/003-props.md) owns visible rail geometry;
[013 — Udon Components](vrchat/013-udon-components.md) owns realization;
[015 — Audio](015-audio-runtime.md) owns bank playback; and
[020 — Surface Physics](vrchat/020-surface-physics.md) owns generated surface
consumption.
