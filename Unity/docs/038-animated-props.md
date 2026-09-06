# 038 — Animated Props (Unity port)

Model hierarchy animation, the AnimObject/AnimDelta/AnimCombo records, their
drive modes, curve evaluation, and source examples are specified in
[Trailmap: 120-objects], [Trailmap: 150-logic],
[Trailmap: 230-level-ssf], and [Trailmap: 370-world-interaction]. This document
covers bundle classification, Unity object construction, Udon playback, and
performance consolidation.

## Bundle classification

`Snowknife/Bundle/AnimatedPropsBundle.cs` resolves persistent, delta-gated,
combo, triggered, and break-owned animation carriers. It captures model
hierarchies and curves, rebinds cross-instance effect hops, associates trigger
volumes, and removes claimed instances from the static prop/collision paths.

The manifest's `Props.Animated` records carry instance placement, clip windows,
loop/trigger policy, surface and collision-sound metadata, hierarchy parents,
rest transforms, and curve channels. Coordinate and rotation conversion is
performed before Unity consumes the record. Slopesmith-authored models export
the same portable hierarchy rather than selecting a separate importer path.

Animation classifiers yield to more specific spinner, physics, and breakable
classifiers where an object participates in one of those systems. A clip-less
carrier remains static.

## Unity construction

`PropBuilder.BuildAnimated` creates one hierarchy under `AnimatedProps` per
manifest record. Segment transforms reproduce the portable parent/rest shape.
Visible segments receive render meshes and live prop-lighting data; collidable
segments receive moving, double-sided `PropsCollision_*` meshes.

The collision prefix lets `RideableBoard` recognize a moving rideable surface.
Surface metadata is encoded on the collider for audio/contact lookup. Visible
and collision twins remain in one animation hierarchy so their poses cannot
drift.

The builder adds neutral markers for the selected drive mode. `VrcWiring`
realizes them as `AnimatedPropU`, `AnimTriggerU`, and `AnimPokerU` where
required.

## Runtime playback

`AnimatedPropU` evaluates flattened piecewise curves and writes segment local
poses. It skips transform writes when clip time is unchanged; this matters for
Rigidbody-less `MeshCollider`s because a redundant write can force PhysX to
update its static tree.

The Unity runtime supports:

- free-running clips driven from shared time;
- delta-gated clips whose local budget advances only after a poke;
- combo clips that suspend an idle window for a triggered reaction window;
- collision-triggered one-shots with an optional Unity auto-reset; and
- break-owned clips triggered and reset by the breakable component.

Walking and riding triggers use the same dual callback pattern as other world
interactions: player-trigger callbacks for a walking avatar and ordinary
trigger callbacks for the board's RiderProbe.

`AnimPokerU` is an optional local embellishment that keeps delta-gated scenery
active when no AI riders cross its authored triggers. Disable it for strict
trigger-only playback.

## Consolidation

An import initially creates one behavior per animated instance.
`OpenSlope/Optimize/Consolidate Animated Props` concatenates those arrays into
one `AnimatedPropManager`, reroutes trigger/poker targets, and disables the
individual ticking behaviors while retaining their serialized source data.

The manager must remain under `OpenSlope_Map`; map replacement destroys the
animated segment objects it references. The pass reparents a stray host and is
idempotent. It preserves per-prop update throttles while staggering work across
frames. `Setup All` runs the pass after map construction and it must be rerun
after each new import.

The consolidation is primarily a Udon dispatch-count and frame-smoothing
optimization. Do not present noisy desktop timing as a source-behavior fact.

## Unity-specific policy

- Moving meshes are double-sided to tolerate inconsistent source winding under
  Unity's back-face query rules.
- Triggered clips may auto-close after a configured delay; zero retains the
  hold-at-end behavior.
- Delta-gated proximity activation and `AnimPokerU` are port conveniences.
- Curve scheduling and collider-write suppression are Unity/Udon concerns and
  do not belong in the SSX specification.

## Verification

- Compare render and collision bounds throughout a clip.
- Test all supported drive modes and their reset/retrigger rules.
- Confirm source surface/audio metadata follows moving colliders.
- Verify a re-import followed by Setup All leaves one manager under the map and
  no active duplicate tickers.
- Exercise walking and RiderProbe trigger paths with two clients where the
  trigger is networked.
- Use the Trailmap chapters to verify source semantics; keep map-specific
  examples and constants out of this implementation page.

## See also

[009 — Collision](009-collision.md),
[035 — Rideable Prop Surfaces](vrchat/035-rideable-prop-surfaces.md), and
[036 — Breakable Props](036-breakable-props.md).
