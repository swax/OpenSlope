# 036 — Breakable props

This page documents the Snowknife-to-Unity realization of breakable obstacles.
Canonical effect dispatch, fragile surfaces, mesh-piece throws, source sounds,
and respawn behavior live in [Trailmap: 150-logic, 180-particles-data,
230-level-ssf, 370-world-interaction, 410-texture-animation,
420-audio-runtime].

This implementation generalizes [028 breakable signs](028-breakable-signs.md)
and interoperates with [016 physics props](016-physics-props.md).

## Classification

`Snowknife/BreakableClassifier` follows collision slots, functions, and named-
instance hops. It accepts chains that hide the visible source, reveal or throw
a hidden twin, or install a fragile-surface continuation. Merely having an
effect slot is not sufficient: signs, boost pads, flexing props, and event
volumes use the same graph infrastructure.

The classifier produces clusters with semantic roles such as `intact`,
`broken`, `piece`, `support`, and `smash`. Separate passes cover:

- inline hide/reveal and self-throw chains;
- invisible-trigger-driven walls and sequenced roll-away props;
- fragile glass with independently disableable support collision; and
- physics bodies that also throw a hidden contents cluster.

Source graph fields remain lossless in the bundle. The semantic cluster is the
portable contract used by Unity.

## Bundle construction

`PropsBundle` diverts rendered break members from the static merge.
`CollisionBundle` omits pass-through breakables from ordinary solid buckets,
but emits fragile-glass supports as single-instance collision buckets so the
runtime can disable them independently.

For mesh throws, `PropsBundle.EmitPieces` splits the affected model into
connected components, recenters each component, and attaches the extracted
throw record. A relaxed component cap is used only when an authored throw
explicitly proves that a large twin is intended to separate.

Sequenced roll-away intacts are also emitted through `AnimatedPropsBundle` as
break-owned clips. The break cluster carries the delay and terminal sound while
the animation owns the moving intact renderers.

## Unity construction

`Importer/Editor/PropBuilder.BuildBreakableLogos` builds each cluster under the
breakable root with the applicable combination of:

- intact and broken renderers;
- hidden, individually pivoted throw pieces;
- a pass-through contact trigger;
- support colliders supplied later by `CollisionBuilder`;
- crack, impact, and terminal audio anchors;
- authored P6 burst layers, with a project fallback for older bundles; and
- a `BreakableLogoMarker` for platform realization.

Roll-away clusters use the animated renderers instead of a second flat divert.
Spill-only clusters have no trigger of their own; their linked `PhysicsProp`
fires them.

## Runtime mapping

`BreakableLogoU` and `BasisBreakableLogo` share four implementation paths:

1. Immediate swap: hide intact renderers, reveal the broken twin, and play
   feedback.
2. Piece throw: integrate the component meshes in level-local coordinates,
   then hide and reset them for an optional re-arm.
3. Sequenced roll-away: trigger the owned clip, delay the swap, and play the
   terminal cue at the pieces' landing anchor.
4. Fragile glass: drain a per-instance strength pool while occupied, select a
   cracked texture frame through per-renderer state, then disable the support
   colliders when the break fires.

The glass damage boundary and per-piece jitter are Unity approximations because
the port does not reconstruct every native contact vector or randomness input.
Area-unload suppression is not ported; optional respawn is project policy.

Break presentation uses authored emitter layers where available. The legacy
balloon fallback and grow-back animation remain importer/runtime features, not
canonical SSX rules.

## Verification and open edges

- Confirm every classified member is absent from the merged static mesh and no
  stale solid collider blocks pass-through breakables.
- Exercise inline, trigger-driven, roll-away, glass, spill, and self-throw
  clusters through both walking and board contact.
- Verify cracked state is per instance, support colliders disable and restore,
  piece pivots are local, and delayed callbacks cannot affect a restored cycle.
- Verify course-bank event ids and raw graph sound slots use their respective
  resolution paths.
- Props with no resolvable break effect remain ordinary scenery until their
  mechanism is understood and added to Trail Map first.

See also [014 particles](unity/014-particles.md) and
[013 Udon components](vrchat/013-udon-components.md).
