# 003 — Props

This page documents the portable prop mesh and Unity import. Canonical SSX
model/instance layout, visibility, placement transforms, and source fields live
in [Trailmap: 120-objects, 130-collision-data]. Per-instance lighting is
documented by [010 object lighting](010-object-lighting.md); collision by
[009 collision](../009-collision.md).

## Bundle contract

Snowknife joins model geometry to instance records and writes `props.glb` with
the static visible instances merged by material. The bake applies source-space
conversion, preserves normal splits, and stores per-instance lighting in the
portable vertex/material representation.

Instances that require independent transforms or runtime state are emitted as
semantic diverts rather than welded into the static node. Current consumers
include pickups, physics bodies, breakables, animated props, movers, and soft
bodies. Invisible trigger/volume hosts emit no static render geometry.

`Props.obj` and instance records remain fallback inputs for extracting a
diverted instance when an older bundle cannot provide the needed glTF node.
The stable instance index is the join key for that compatibility path.

## Unity import

`Importer/Editor/PropBuilder.cs` loads the glTF `Props` node into one static
object with material submeshes. It registers animated material profiles and
creates each semantic divert through its specialized builder. Those builders
own the independent renderer, collider, marker, and runtime wiring appropriate
to the divert kind.

Render geometry and collision remain separate. The importer prefers the
portable collision bundle and uses render-derived collision only as an explicit
fallback when no collision source exists.

Generated meshes and deduplicated materials are stored as importer assets or
sub-assets so a refreshed scene does not depend on transient objects.

## Diagnostics

- Compare merged and diverted counts against the bundle manifest.
- Confirm invisible hosts do not render while their trigger or collision
  realization still exists.
- Confirm every divert is absent from the merged mesh and has one specialized
  owner.
- Check material-slot order, 32-bit index use, root-space bounds, and lighting
  coverage after refresh.
- If the fallback instance join is used, fail loudly when an object group does
  not resolve to exactly one instance record.
