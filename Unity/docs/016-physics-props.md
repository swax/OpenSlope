# 016 — Physics props

This page describes how OpenSlope turns effect-driven movable props into Unity
objects. Canonical collision modes, response mass, Roller activation, body
impulses, and authored fields live in [Trailmap: 130-collision-data,
150-logic, 370-world-interaction].

Related implementation pages: [009 collision](009-collision.md),
[011 interactivity](011-triggers-and-interactivity.md), and
[036 breakables](036-breakable-props.md).

## Classification and bundle output

`Snowknife/Bundle/PropsBundle.cs` follows each instance's collision effect graph
and classifies the targets of Roller nodes as physics diverts. Classification is
graph-based because response mass and model names do not determine whether an
instance moves. The Roller payload supplies the portable scalar mass; the
instance's `PhysicsIndex` and collision fields remain separate inputs.

Roller targets are removed from the static render and collision buckets to
avoid duplicate geometry. Their diverted mesh retains the instance lighting
record and may carry a spill-cluster link consumed by the breakable pipeline.
Malformed or non-positive Roller masses stay represented in the source graph
but are not emitted as portable moving bodies.

## Unity construction

`Importer/Editor/PropBuilder.cs` recenters each diverted mesh on its centroid
and creates it under `Physics` with:

- a `Rigidbody` using the extracted dynamic mass;
- a solid bounds `BoxCollider` and an inflated knock-sensor trigger;
- a deduplicated `PhysicMaterial` using importer bounce/friction policy;
- continuous speculative collision detection;
- the prop's resolved positional impact cue; and
- a `PhysicsPropMarker` for the platform wiring pass.

The box is an intentional Unity approximation of the native body. Exact SSX
shape and inertia semantics remain in Trail Map even when the importer does not
realize all of them.

## Runtime behavior

`VRC/World/PhysicsProp.cs` starts the body kinematic. This prevents it sliding
down a steep course before contact and works around avatars being
`CharacterController`s that do not impart useful rigidbody force.

The walking-player callback and the board's `RiderProbe` call the same knock
path. That path makes the body dynamic, derives an approximate launch from the
local rider velocity or the authored Roller direction, adds tumble, and plays
the impact cue. Once speed remains below the configured threshold for the
settle interval, the component can re-anchor the body at its new pose.

The port does not reconstruct the native contact normal or inertia-driven
torque; velocity-direction launch and randomized spin are explicit
approximations. State is local rather than network synchronized.

Targeted Roller nodes, such as a lid activated by a different instance, use the
same component but are fired by the resolved effect connection. A physics
divert with `SpillCluster` also calls the associated breakable's `HitFrom` path
so the body and its contents react together.

## Configuration and verification

`ImportConfig` owns `BuildPhysicsProps`, `PhysicsExcludeModels`,
`PhysicsMassFromRoller`, `PhysicsStartKinematic`,
`PhysicsKnockSensorInflate`, `PhysicsMinPlayerSpeed`,
`PhysicsKnockVelInherit`, `PhysicsKnockUpBias`, `PhysicsReAnchor`,
`PhysicsSettleSpeed`, and `PhysicsSettleTime`.

Verify that Roller targets are absent from static buckets, remain anchored at
load, respond to both walking and ridden contact, play the resolved course-bank
cue, collide with terrain after activation, re-anchor without drift, and fire
any linked spill exactly once.
