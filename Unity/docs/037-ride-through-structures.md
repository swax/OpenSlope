# 037 — Ride-through structures

This page documents the Unity collision approximation for no-proxy props whose
authored body contains an opening. Canonical SSX shape eligibility and response
semantics live in [Trailmap: 130-collision-data, 370-world-interaction].

Related implementation pages: [009 collision](009-collision.md) and
[036 breakables](036-breakable-props.md).

## Implementation boundary

Props that ship a collision proxy use the imported triangle collision path. A
visible, solid, no-proxy prop instead enters
`CollisionBundle.BuildBoundsBoxes`. Compact props use a computed-bounds AABB;
hollow spans and other shapes for which that box would create substantial
phantom collision use the body decomposition below.

Breakables are excluded upstream. This lets, for example, a breakable cover use
its own trigger while the surrounding scaffold retains solid posts and an open
passage.

## Snowknife decomposition

`Snowknife/SsxPhysicsBodies.cs` decodes the mode-3 body into an occupancy grid.
`CollisionBundle.TryEmitBody` then selects a more detailed representation when
one of these implementation heuristics applies:

- a rider-sized through-corridor is flanked by solid cells;
- the reachable occupied volume is too sparse for a faithful AABB; or
- an instance transform would inflate an axis-aligned box excessively.

Doorway and sparse bodies become a small set of capsules and merged boxes.
Simple tilted runs become capsules; other tilted bodies use a body-local box.
The thresholds and merge limits are conversion policy, not SSX format facts.

The bundle writes the result to `Collision.Bodies[]` as an instance pose plus
body-local `Boxes[]` and `Capsules[]` records.

## Unity import

`CollisionBuilder.ImportBodyColliders` creates one object per body under
`PropsBodyCollision`. Boxes are attached directly; each capsule gets an
axis-aligned child transform because Unity `CapsuleCollider` orientation is
local-axis based. The object also receives the standard prop-impact audio path.

The AABB fallback remains intentional for compact props. If a fringe detail
must block but is lost by the decomposition, add a real proxy upstream rather
than closing the opening with another bounds box.

## Verification

- Cast ray fans through representative arches and scaffolds: their openings
  must remain clear while posts and lintels block.
- Check compact rocks, signs, and upright trunks for a single bounds collider.
- Check leaning trunks and thin poles for tight body collision without a trail-
  blocking world AABB.
- Watch static collider count and Quest cost when changing merge thresholds.
