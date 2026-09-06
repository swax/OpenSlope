# 023 — Gem Pickups (Unity port)

Gem tiers, mode visibility, scoring, despawn/regrow behavior, effects, and chime
selection are specified in [Trailmap: 390-pickups-and-race],
[Trailmap: 420-audio-runtime], and [Trailmap: 180-particles-data]. This document
covers Unity import, collision detection, presentation, and networking.

Code: `Importer/Editor/PropBuilder.cs`, `VRC/World/GemPickup.cs`,
`Importer/Editor/CollisionBuilder.cs`, and `Importer/Editor/ImportConfig.cs`.

## Bundle and importer mapping

The bundle identifies gem instances, multiplier value, showoff-only mode mask,
resolved collision-burst layers, and available bank clips. `BuildSpinners`
already gives each gem an independently rotating object. `AttachGemPickup`
adds:

- a spherical trigger sized from the visible mesh;
- a kinematic `Rigidbody` so board-trigger callbacks fire;
- a `GemMarker`, realized by `VrcWiring` as `GemPickup`;
- the tier's resolved one-shot `AudioSource`, when available; and
- either the resolved P6 collision-burst layers or the authored/fallback
  sparkle system.

The trigger is spherical because a thin spinning mesh would make a box gate
rotate in and out of the rider's path. Mode masking disables the renderer,
trigger, audio, and spinner together outside the selected gameplay mode.

## Runtime detection

Walking players enter through `OnPlayerTriggerEnter`. A rider seated in a
`VRCStation` does not produce the same callback, so the board's `RiderProbe`
enters through `OnTriggerEnter`. The latter is accepted only while the board is
actively ridden and satisfies the configured minimum speed.

`GemPickup` keeps the object alive and changes its scale during the pop cycle;
this avoids fighting `SpinnerManager`, which owns rotation. Delayed custom
events advance only an active cycle, so idle gems have no per-object update.
The trigger remains unavailable during the hold interval to prevent a slow
crossing from collecting twice.

The visual pop is broadcast when networking is enabled, while the pickup chime
is local to the collector. A short dedupe window swallows the collector's echo.
The scoring consumer remains on the local board.

## Burst and audio realization

When collision-burst layers are present, `P6EmitterBuilder` builds them at the
gem's level-root-local origin and `GemPickup` plays them on collection. This is
the same generic path used for other resolved effect-graph bursts. Gems from an
older or authored bundle without those layers use `BuildGemSparkle`.

The importer consumes the bank clip resolved for the multiplier tier. It does
not infer source sound semantics from an SSF node or duplicate the canonical
slot table in this document. Spatial-audio wiring is attached with the same
marker path as other one-shot sources.

## Tuning

`ImportConfig` exposes the feature switch, trigger radius, minimum ride speed,
per-tier clip paths/rolloff, and fallback-sparkle settings. `GemPickup` owns the
hold and grow durations. These are Unity controls; canonical source values stay
in Trailmap.

## Verification

- Test walking and riding entries independently.
- Confirm showoff/race/free-ride mode changes disable the complete gem object.
- Check a slow pass cannot retrigger during the hold and a later pass can.
- Check local audio and shared visual networking with two clients.
- Exercise both resolved P6 layers and the authored/legacy fallback sparkle.
- Confirm repeated setup does not duplicate colliders, rigidbodies, markers, or
  audio sources.

## See also

[012 — Spinning Pickups](012-spinning-pickups.md),
[011 — Triggers and Interactivity](011-triggers-and-interactivity.md),
[016 — Physics Props](016-physics-props.md), and
[015 — Audio](015-audio-runtime.md).
