# 009 — Collision

A VRChat world needs walkable collision or the player capsule falls straight through. This document covers
the bundle/import/runtime realization of terrain, prop, and trigger collision.
The original collision modes, eligibility, response mass, bounce tiers, and
rideable-surface semantics are specified in [Trailmap: 130-collision-data] and
[Trailmap: 370-world-interaction].

> **Normative collision source:** the shape, `PlayerCollision`, collision response mass,
> `PlayerBounce`, and Roller rules below implement [Trailmap:
> 130-collision-data, 150-logic, 370-world-interaction]. Those chapters are
> the shared behavior contract for Slopesmith, Snowknife, and Unity; their
> citations trace the rules to reverse engineering and PCSX2 observations.
> Unity-only approximations are identified explicitly.

> **Bundle-only:** the terrain per-SurfaceType collision split, the prop bounce-bucketing
> (exact-zero response mass + PlayerBounce response gates), the computed-bounds boxes and the foliage-swish trigger boxes described
> here are produced once by `snowknife` (terrain collision inside `terrain.glb`, prop buckets in
> `collision.glb`, the box metadata in `manifest.json`). The importer consumes that bundle; a bundle that
> carries no collision proxies at all yields no prop proxy colliders.
> See [034 — The Bundle Pipeline](../../Snowknife/docs/034-bundle-pipeline.md).

Code: `Snowknife/Bundle/CollisionBundle.cs` (terrain per-SurfaceType split + prop bounce-bucketing + bounds /
foliage boxes → `collision.glb` + manifest), `Importer/Editor/CollisionBuilder.cs` (imports those —
`ImportCollision` / `ImportComputedBoundsColliders` / `ImportFoliageSwishTriggers`) and
`TerrainBuilder` (terrain colliders from `terrain.glb`),
`VRC/Riding/SurfaceDetector.cs` (runtime UdonSharp).

## TL;DR

| Domain | Collider source | Grouping |
|---|---|---|
| Terrain | MeshCollider over the rendered Bézier mesh | one collider **per SSX `SurfaceType`** (`Surf_<type>`); type 17 excluded |
| Props | the game's **real** collision proxies (`PropsCollision.obj`) | invisible MeshColliders bucketed by `PlayerBounce`/`PlayerBounceAmmount` |
| Feel | `SurfaceDetector` raycasts down, reads `Surf_<type>` | footstep audio + snow + respawn (cosmetic; VRChat has no friction) |

## Specification dependency

Source record fields and their meanings are not repeated here. See
[Trailmap: 130-collision-data] for terrain and object collision data and
[Trailmap: 370-world-interaction] for rider response. The bundle resolves those
records into Unity-ready mesh buckets, oriented boxes, body shapes, triggers,
and response metadata; the importer does not reinterpret their semantics.

## Our approach

- **Terrain** → a MeshCollider over the *same* tessellated patches we render, but split into one
  collider per `SurfaceType` under `OpenSlope_Map/Collision/Surf_<type>` (built as `TerrainCollision`, then re-exposed
  at the `OpenSlope_Map` top as `Collision`), each a compacted
  collision-only mesh keeping only the vertices that type actually uses. `SurfaceType 17`
  ("No Collision") still renders but gets no collider.
- **Props** → import the game's **real proxies**: `snowknife` bakes the per-instance collision models
  (`Collision/*.obj`, for instances flagged `PlayerCollision`) into `PropsCollision.obj`; the importer
  parses its `o inst{N}_...` groups, maps each group back to `Instances.json`, and applies the native rider-response
  gates. Exact `ResponseMass == 0` or `PlayerBounce == false` remains contact-capable but does not become a wall.
  The remaining response-enabled proxies become invisible MeshCollider buckets by
  `PlayerBounceAmmount` **× the `CollisonSound` material id** (so each
  merged collider is one material → one impact clip; 9 buckets, 8 with a per-material `AudioSource` the board
  plays on contact — trunk/rock/fence/rail/etc.; see docs/015). Each bucket carries
  `PropBounce`, so the rideable board applies the authored rebound and native eject floor.
  Every face is emitted **double-sided** (both windings): the game's collision models are wound *inconsistently*
  (some — e.g. the `Mdl_Radiotower_PhantomBox` invisible shells — are inside-out), and on a single-sided
  MeshCollider an inverted shell lets you walk *through* the wall from outside but traps you from inside (the
  "walk into the thin tower, can't get out" bug). Double-siding makes winding irrelevant — verts are shared, only
  the triangle-index count doubles, negligible for static collision.
  If that file is absent, no prop proxy colliders are built.
- **Props with no triangle proxy** → native mode 2 uses the model's own box turned with the placement, and
  mode 3 uses its referenced physics-body sphere tree. Unity preserves decoded hollow mode-3 bodies in
  `PropsBodyCollision`; compact mode-2/mode-3 shapes are flattened to bundle boxes by `snowknife` and
  `ImportComputedBoundsColliders` drops a `BoxCollider` under `OpenSlope_Map/PropsBoundsCollision` (**265** in
  the current GARI bundle). Those boxes are **oriented**: `EmitBoxes` carries each instance's placed vertices
  back into its own frame before taking min/max, and the record's `Rotation`/`LocalCenter` place the holder and
  the box on it. Emitting the axis-aligned envelope instead inflates 62% of the shipped mode-2 colliders —
  median 1.6x the volume, and hundreds of times over for thin turned things like rail supports, jumbotron
  screens and banners. Bundles written before this carry no `Rotation`, which reads as identity and reproduces
  the old behaviour, so re-bundle a level to pick the fix up. This is the compact Unity approximation for signs, billboards, jumbotrons, crowd
  stands, and authored source-sphere profiles. Each retail and authored box carries the same
  `PropBounceMarker` response/bounce/SurfaceType metadata
  as a mesh bucket, so changing shape does not discard the profile's ride behavior. Each box that has a
  resolvable collision sound also gets a **per-material impact `AudioSource`** (`AttachImpactSound` maps the
  instance's `CollisonSound` ADL id → the course bank slot the game uses → the extracted clip; **258**
  of the 265, the rest are id-0 = silent) **tagged `SpatialAudio` so the VRChat wiring pass pairs it with a
  `VRCSpatialAudioSource`** — every SSX source is (VRChat force-spatializes bare sources with a 40 m default and a
  bare `PlayOneShot` comes out silent on upload; the same `SpatialAudio` rule `AudioBuilder.ConfigureSpatial`
  applies). `RideableBoard` reads that AudioSource off the hit collider and
  one-shots it on contact, volume scaled by the into-wall closing speed — no Udon on the prop. The merged proxy
  buckets (trunks/fences/rocks) share two colliders with no per-prop identity, so their sounds are a follow-up.
  See docs/015 (audio) and [Trailmap: 420-audio-runtime] (the ADL→bank remap). **`Visable=false` is
  excluded from this solid-fallback pass**, not from contact: hidden firework/reset volumes are emitted by
  the trigger builders as `BoxCollider(isTrigger)`. Treating them as solids would create invisible walls.
  The same **response-mass gate** applies here (the 94 zero-response-mass no-proxy props — gems / trick-multipliers,
  boost pads, LCD logos — would otherwise get invisible boxes you'd bonk into; the gate skips them). See docs/vrchat/017.
- **Leaf swish-through triggers** → the zero-response-mass *cutout foliage* (tree leaves `CollisonSound 7 → 050`, bushy
  leaves `12 → 051`) is dropped by both passes above (the bounce buckets skip it via the response-mass gate, the computed-
  bounds pass skips it because it *has* a proxy mesh), so the game's leaf-**swish** sound never fired. The board
  is meant to *ride through* leaves (only the trunk blocks), so `ImportFoliageSwishTriggers` gives each leaf
  instance a **trigger `BoxCollider`** (AABB from its visible `Props.obj` group) under `OpenSlope_Map/PropsFoliage`,
  grouped by sound into `Snd7`/`Snd12` sub-objects that each carry **one** swish `AudioSource` (the board reads
  the clip off the box's parent, so it's two sources, not one per box). Triggers never wall a `CharacterController`
  or the board's obstacle sweep (`QueryTriggerInteraction.Ignore`), so you swish straight through. `RideableBoard.
  CheckFoliageSwish` runs a separate `CapsuleCastNonAlloc(..., Collide)` each frame, and when the rider capsule is inside
  a leaf box it one-shots the group clip on the board's 2D event source, scaled by ride speed and debounced (one
  swish per leaf cloud). **1011** boxes (885 tree-leaf / 126 bushy-leaf).
- **The exact response-mass gate** → [Trailmap: 130-collision-data] requires an exact-zero test of the
  collision response mass (`ObjectProperties.U0` on disc) in every shape mode. Zero means no
  solid rider response; every nonzero value (`0.2`, `5`, `20`, or `1E+30`) admits the mode-specific response.
  `PlayerBounce == false` suppresses physical rider response while preserving contact dispatch. The spec's RE
  provenance includes the 16-cell PCSX2 collision lab and its live-confirmed seventeenth mode-1 follow-up:
  both the white mode-2 and cyan mode-1 controls emitted their marker and remained ride-through.
  Dynamic motion is separate: only a collision `property.roller` effect activates the native body and supplies
  its scalar dynamic mass. This is why leaves can swish without blocking, while a zero-response-mass path marker may still topple.
- **Feel** → `SurfaceDetector` (UdonSharp, runs on the local player) raycasts straight down, finds
  which `Surf_<type>` collider is underfoot, and plays per-surface footsteps / snow puffs / respawns on
  a Reset (type 0) surface.

## What we learned (the gotchas)

### 1. No collider = fall through; and a *down-facing* collider is just as bad
Terrain always gets a collider (or you fall through the world). But it's not enough for one to *exist*
— the X-negate ([004](unity/004-orientation-and-scale.md)) flips face normals **down**, and a MeshCollider
with down-facing normals lets the capsule fall through anyway (and downward raycasts miss it, since
queries skip back-faces). The terrain faces are wound up specifically to fix this — see
[004](unity/004-orientation-and-scale.md) gotcha 4.

### 2. Billboards must be excluded, and you can only drop them by submesh
Cutout sheets — crowd, trees, flags, fences — are flat camera-facing quads you'd constantly snag on, so
they're left non-solid. But Unity merges all props into **one mesh with a submesh per material**, so
there's no per-billboard GameObject to disable; the collider is built from the **opaque submeshes
only**, dropping cutouts by submesh index (`AlphaClassifier.IsCutout`, [005](unity/005-materials-and-alpha.md)).

### 3. Per-`SurfaceType` colliders, not one merged mesh
It's tempting to merge all terrain collision into one collider, but then nothing can tell snow from ice
from rock underfoot. Splitting by `SurfaceType` lets `SurfaceDetector` raycast down, match the hit
collider to its `Surf_<type>`, and react. A shipped level has 8 collidable types (powder/snow/rock/ice/ramp/wall/…)
+ type 17 excluded.

### 4. We collide against the *real* proxies — accuracy, not poly count
The proxies aren't a poly-count optimisation: the real collision (≈172k tris) is *more* than the
opaque-submesh approximation (≈139k) but less than the full visual mesh (≈305k). The point is **what
the player collides with matches the game** (authored collision, no billboard snags), not that it's
lighter. This proxy pass deliberately contains mode 1 only; mode 2 AABBs and
mode 3 physics bodies are realized by their corresponding bounds/body passes.

### 5. VRChat has no per-surface friction — "feel" is cosmetic + respawn only
The VRChat player capsule is engine-controlled and ignores `PhysicMaterial`, so there's **no real ice
sliding**. `SurfaceDetector` is therefore limited to footstep audio, snow particles, and
out-of-bounds respawn (on type 0). It's a plain local UdonSharp behaviour the user adds to the scene
(it auto-finds `Collision` + an `AudioSource`); the SurfaceType buckets (snow/ice/rock/metal)
mirror the game's PBDHandler legend.

## Diagnostics that worked

- **The collision log** — `terrain collision -> 8 per-SurfaceType colliders, 124128 tris (SurfaceType
  17 excluded)` and the prop-collision count — confirms the right types were built and the right ones
  excluded, without opening the hierarchy.

## Note

`snowknife` extracts ~412 unique collision proxy meshes (`Collision/*.obj`) and bakes the collidable
instances into `PropsCollision.obj`. The OBJ object names preserve the instance index, which is why
`CollisionBuilder.ImportCollision` can recover the authored bounce metadata even though the visual prop mesh is
merged. The proxy file has 2599 groups. The bundle classifies each group by shape eligibility, exact-zero response mass,
`PlayerBounce`, and the independent Roller diversion rather than by a finite/`1E+30` threshold. Friction and
ice-sliding are not implemented.
