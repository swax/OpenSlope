# 021 — Analytic Terrain Contact (ride the Bézier, not the triangles)

> The rideable board ([017](vrchat/017-rideable-board.md)) takes its
> contact **point and normal** from the level's **exact analytic Bézier surface** ([002](unity/002-terrain-geometry.md)),
> not the faceted collision triangle it raycasts. The faceted raycast still finds the ground; we then look up the
> hit triangle's patch + corner `(u,v)` (baked once at import) and use that close seed for a **bounded four-step
> Newton intersection** with the actual probe ray. The result is accepted only when its perpendicular ray residual
> is at most 1 mm. There is no grid search or runtime allocation. A faceted fallback covers props + failed solves;
> a **sink allowance** lets the deck ride down into concave scoops without jamming. A one-eval tangent-plane
> shortcut is cheaper but can evaluate 0.86–1.30 m sideways from a probe on tight lips, so it is not an exact
> contact.

Code:
- `VRC/Riding/TerrainPatches.cs` — runtime data-holder + allocation-free bounded `Refine`. One
  instance, on `OpenSlope_Map/Collision/TerrainPatches`.
- `Importer/Editor/TerrainPatchBuilder.cs` — editor baker: reads `Patches.json`, re-tessellates each
  patch, matches every loaded collision triangle to its patch + corner `(u,v)` by geometry, bakes the packed
  per-triangle `TriKey` + per-collider `TriStart` + the control points onto a `TerrainPatchesMarker`; the VRChat
  wiring pass (`VrcWiring`) realizes `TerrainPatches` ([013](vrchat/013-udon-components.md)), which every board auto-finds.
- `VRC/Riding/Board/RideableBoard.cs` / `.Surface.cs` — `ProbeDown`/`ProbeContact` call
  `ResolveContact`, which calls `Refine`, applies the sink allowance, and falls back to the faceted hit +
  `SmoothNormal` when there's no patch.
- `Snowknife/Bundle/TerrainBundle.cs` — bakes the analytic vertex **normals** into `terrain.glb` (render shading +
  the `SmoothNormal` fallback). `Snowknife/Services/LevelPipelineService.cs` ships `Patches.json` into the project (`unity` step).

## The problem

The course is **bicubic Bézier patches** ([002](unity/002-terrain-geometry.md)); we tessellate them to triangles and the
board finds the ground by raycasting the `Surf_<type>` `MeshCollider`s ([009](009-collision.md)). Riding those
triangles throws away the surface:

- **Normal** — `RaycastHit.normal` is the flat per-triangle face normal, so the contact normal *steps* facet to
  facet. It drives the downhill direction, friction `cosθ`, the steering yaw axis and the visual bank.
- **Height/point** — `RaycastHit.point` sits on the flat chord, which **sags below the true curved surface** (~6–12
  cm on the rideable line, more on big steep patches at our coarse `TerrainRes 4`) — about the deck thickness, so
  faceted ridges **poke through** the thin board.

The PS2 avoided both by re-tessellating terrain adaptively and intersecting the real bicubic at runtime — too
costly to replicate on Quest as geometry. So we recover the *surface*: evaluate the original patch at the hit.

## Why a bounded refinement, not a search

A general solver is too heavy for Udon: it performs a coarse search plus many patch evaluations
through allocation-heavy `Vector3` operations. The faceted
raycast already names the triangle, and each triangle corner has a known `(u,v)` on a known patch, so the
barycentric blend is a very close seed. From there the current solver performs at most four analytic evaluations,
solving only the two scalar components perpendicular to the ray with the exact `∂P/∂u` and `∂P/∂v` Jacobian.
Steps are capped to 0.5 in parameter space and there is no grid, temporary array, or unbounded loop. This keeps the
solve small enough for the ride path while making “exact” a measurable condition rather than a visual estimate.

## The contact model

`ResolveContact` (in `RideableBoard.Surface.cs`) resolves every ground probe:

1. **Analytic.** If the level has patch data and the hit is real terrain
   (a `Surf_` collider), `TerrainPatches.Refine(ci, tri, bary, flatPoint, rayDir)` returns the exact point +
   normal (below).
2. **Faceted fallback.** For props, un-baked terrain, or a failed/residual-rejected refine: the point is the raw faceted hit
   with a smooth analytic **normal** from `SmoothNormal` (the baked vertex normals, barycentric-blended). If that baked
   data is unavailable, `SmoothNormal` returns the raw faceted normal.

Then the **sink allowance** bounds how far the resolved point may sit *below* the faceted collider: it may **lift**
freely (the convex poke-through fix) and **sink** up to `SinkAllowance()`, so the deck rides true concave dips too
without the rider capsule embedding in the collider (gotcha 2).

## How it's built

### Bake (`TerrainPatchBuilder`, editor)

Reads the level's `Patches.json` (the same 16-control-point patches `snowknife` tessellates) and, per collidable
patch, stores its control points in **mesh-local** space `(-x, y, z)` and **re-tessellates** the `seg×seg` grid
(same row-major eval as snowknife) to recover each generated triangle's patch + each grid point's corner `(u,v)`.
Then it walks the **loaded** `Surf_` collision meshes and matches every triangle to a generated one **by geometry**
(so it's robust to the glb's vertex dedup/reorder):

- **centroid → patch** via a quantized hash with a ±1-cell neighbour search (absorbs float jitter; generated
  centroids are hundreds of units apart, so only the true one is within ±1);
- **vertex → corner** = nearest of that patch's grid points (each grid point's index *is* its corner code), taken
  in the **loaded triangle's vertex order** so the hit's barycentric blends straight onto them.

It bakes, per triangle, one packed int `TriKey = patch | (c0<<16) | (c1<<21) | (c2<<26)` (corner code
`c = iu*(seg+1)+iv`, needs `seg ≤ 4`), flattened across colliders with per-collider `TriStart` offsets in the same
order the board caches its colliders (collisionRoot children that have a `Collider`) — the `RailNetwork`
flat-array+offsets shape. `Patches.json` is the level *source* (shipped to the project by `snowknife unity`); read
once at bake, not at runtime.

The holder is parented **identity-local under `OpenSlope_Map/Collision`**, so its `transform.TransformPoint` lands on the
**same world surface the colliders raycast** (the writer's `×scale` and loader's `÷scale` cancel; gotcha 1).

### Refine (`TerrainPatches.Refine`, runtime)

`Start` world-bakes the control points once (the level is static). Per probe, given the raycast `(ci, tri, bary)`:

1. `TriKey[TriStart[ci] + tri]` → decode `patch` + 3 corner codes → each corner's `(u,v)`.
2. `(u,v)` = barycentric blend of the three corners (the same `bary` weights the raycast returned).
3. Evaluate the bicubic point and exact tangents. Select two well-scaled components of
   `cross(P(u,v) − flatPoint, rayDir) = 0` from the ray's dominant axis and solve their 2×2 Jacobian for `(du,dv)`.
4. Repeat for at most the contract's four iterations, capping each parameter step to 0.5.
5. Evaluate once at the result. Reject unless `(u,v)` remains near the seeded patch, the along-ray correction is
   within 5 m, and the perpendicular point-to-ray residual is at most the contract's 1 mm. Return a point exactly on
   the probe ray plus the analytic normal `n = ∂P/∂u × ∂P/∂v`.

This is orientation-free, so the same call serves the down probe (`rayDir` = down) and the wall/quarter-pipe
contact probe (`rayDir` = −contactNormal). Both the point and the normal are analytic, so **ride quality is
decoupled from tessellation** — the board doesn't ride the triangles at all.

The four-iteration and 1 mm bounds live in `Trailmap/specs/data/ride-v1.json` and are generated into both ports. Unity
profiling is still required after the C# is imported: if this bounded solver misses the Quest budget, optimize the
same equations rather than silently restoring the geometrically incorrect tangent-plane shortcut.

### Seam recovery (`TerrainPatches.MarchTo`, runtime)

The ray-first design has one structural hole: the analytic surface is only reached *through* a raycast, so a tick
whose contact ray finds nothing has no surface at all — and on a wall the fallback down-probe can't see the surface
beside the board, which made a single missed tick end a wall ride irrecoverably. The ride probe's ray misses in
exactly the places wall rides live (measured on the GARI ice canyon: peel-offs, wall-sticking, tunneling out of the
level): a chord gap between facets on a tight curve, or every hit failing the front-face gate while the cached
normal swings.

`MarchTo(target)` closes the hole **without** reopening the per-tick Newton cost of a general solver: it runs
**only on the tick the ray misses**, warm-started from the last contact's `(RPatch, RU, RV)` — at 33 m/s the
contact moves ~0.04 in `(u,v)` per tick, so **3 Gauss-Newton steps** (each one `PatchAndTangents`, the cost class
of a `Refine`) converge to the closest point on the true surface. Exiting `[0,1]²` crosses to the neighbouring
patch through **`PatchAdj`** — a per-patch × 4-edge table `TerrainPatchBuilder` bakes by matching boundary control
points (the quilt is welded, so shared edges share their 4 CPs; endpoints identify the edge, the 2 interior CPs
verify it and fix the direction flip). A level boundary, pole fan, or unmatched seam is `-1`: the march clamps
there and the ray fallback owns whatever lies beyond.

The board (`ProbeContact`) uses it as bounded **recovery**, not as the primary probe: gated to steep contacts
(`n.y < 0.85` — flat-ground lips keep reading as air exactly as the traced model expects), at most
`RECOVER_TICKS_MAX = 6` consecutive ticks (0.1 s), reset by any ray-found probe, and the recovered tick keeps the
previous surface type (no ray = no fresh type read). The contact *error* still decides grounded, so a genuine
launch leaves even mid-recovery; recovery only makes discovery continuous, which is what the PS2's analytic
`.ltg` collision had natively.

Companion behaviour in [020](vrchat/020-surface-physics.md): on a steep face (`_contactN.y <
wallNormalMax`) the pushout's 0.1 m/tick cap is removed — the cap is a ground backstop, and on walls the engine's
real protection is the type-6/10 wipeout gate this port deliberately keeps off, so a wall ejects fully instead of
losing the penetration race and tunneling.

## Settings reference

Analytic contact is unconditional when patch data exists. The remaining settings bound its fallback and obstacle interaction.

| Setting | Where | Default | What it does / when to touch |
|---|---|---|---|
| `sweepFootClearance` | board | `0.6` | Raises the obstacle-sweep capsule's **bottom** to ~torso height so the deck can ride **down into concave dips** (sizes the sink allowance) without the rider capsule embedding/jamming. Bigger = deeper dips; probe reach comes from the shared contract. 0 = clamp dips at the facet. |
| `normalSmoothing` | board | `0.05` | Faceted-fallback temporal low-pass. Exact analytic normals bypass it. |
| `seg` | `TerrainPatches` | `4` | The tessellation quads/edge the `TriKey` corner codes assume; matches `TerrainRes`. Baked — don't edit. |

*Adjacent* systems often confused with contact but separate: `wallRide` / `collideWithProps` / `wallNormalMax`
(the collide-and-slide the sink allowance keeps clear of),
and the surface response/lift fields (the free contact error and visual deck offset). Leave those at their
[017](vrchat/017-rideable-board.md) defaults.

## Tessellation is a render-only choice

`TerrainRes` (4) sizes the base render/collision tessellation, but ride quality doesn't depend on it — the contact is
analytic regardless. The only reason to tessellate finer is **visual**: the board rides the true surface,
but the eye still sees the faceted **render** mesh, so on big steep patches the deck can sit up to ~1–3 m off the
visible ground (avg ~0.3 m). That's a finer-**render**-tessellation fix only — *not* finer collision,
which buys nothing for the ride and costs the Quest collider-tri budget ([025](vrchat/025-performance.md)) this whole
approach exists to avoid. The split is the bundle's **`TerrainHD`** node (`TerrainResHd`, 8 quads/edge): a
render-only densification of the same patches, imported inactive and no longer swapped in by any board row
([046](vrchat/046-performance-board.md)), while every collider — and this file's whole contact bake — stays on the
base `TerrainRes` grid. (Note: `seg`/the corner-code packing assume `TerrainRes ≤ 4`, which the HD node never touches.)

## The hard parts (gotchas)

### 1. Everything is mesh-LOCAL; the board works in WORLD space
`OpenSlope_Map` is rotated −90° about X and scaled 0.01 ([004](unity/004-orientation-and-scale.md)). The control points and the
collider verts are both in the collider's local space; the holder world-bakes the CPs with `transform.TransformPoint`
(identity-local under `Collision`, so its transform equals the colliders'), and the baker matches loaded verts to
re-tessellated CPs *in that same local space* (the `−x` convention must match, else nothing maps).

### 2. The sink allowance — riding concave dips without jamming
The terrain **collider** and the board's collide-and-slide capsule sweep (`ResolveObstacles`, [017](vrchat/017-rideable-board.md))
ride the **coarse faceted** mesh. In **concave** regions the true surface dips *below* the facet; placing the board
(and the rider capsule's bottom) there embeds the capsule and the sweep **jams the rider**. The fix is the *body*,
not the surface: `sweepFootClearance` raises the obstacle-sweep capsule's **bottom** to ~torso height (feet/legs
ride into the dip, torso still collides), and `SinkAllowance()` =
`(_capLow + sweepFootClearance) − _capRadius`, capped by the active contract probe-above distance minus 0.1 m (so a sunk board's next
down-probe still starts above the facet) ≈ 0.6 m. `ResolveContact` lets the contact **lift** freely and **sink** up
to that, clamping deeper. Trade: low standalone solid props below the raised capsule bottom aren't collide-and-slid
(walls + tall props still are; triggers/pickups use the full-height probe).

### 3. Keep the contact on the probe ray (the jerk)
The barycentric seed evaluates a nearby surface point, not necessarily the point pierced by the probe; on tight
lips the mismatch reached metre scale. Using that point directly yanks the deck sideways, while intersecting only
its tangent plane is first-order and can report the wrong height/normal on the exact curves we care about. The
bounded solve now enforces the real invariant: the accepted patch point is within 1 mm of the probe ray, and the
returned contact is placed exactly on that ray. `RRayResidual` and the `RIDE_DBG` telemetry expose the acceptance
measurement for the Unity gold run.

### 4. The baked normals (render + fallback)
`TerrainBundle` bakes per-vertex analytic normals into `terrain.glb` for **render shading** and the `SmoothNormal`
**fallback** (the analytic *contact* normal comes from the patch tangents directly, not these). The sign is
ambiguous and must be **outward**: per-vertex geometric signing (accumulate the area-weighted winding normal `gN`,
sign each analytic normal to agree with its own `gN`; where they diverge > `MaxDivergence` 30°, fall back to `gN`),
and seams **cluster** within `SmoothAngle` 60° (gentle seams average, sharp creases stay crisp).

### 5. Udon serialization + the cross-behaviour wiring gotcha
- The runtime read leans on `RaycastHit.triangleIndex`/`barycentricCoordinate`, `MeshCollider.sharedMesh`,
  `Mesh.triangles`/`normals`/`isReadable` (all Udon-whitelisted); `CacheSurfaces` guards on `isReadable`, and the
  holder guards on `TriKey`/`ControlPoints` being present, so a missing/old bake just falls back — never a crash.
- **Bake the LOADED level.** The baker reads `ImportConfig.Current().LevelFolder/Patches.json`; if the open
  scene is a different level than the json, *nothing* maps (the surfaces don't coincide). Always bake the level
  that's actually loaded.
- **Wiring:** `CopyProxyToUdon` won't convert a board's `terrainPatches` reference to a **just-created** holder
  (backing not registered yet) — so the baker **verifies each board's backing var** and direct-sets it
  (`publicVariables.TrySetVariableValue`) if needed. `CopyProxyToUdon` copies the **whole** proxy and a reference
  doesn't survive a domain reload on the proxy, so pushing *any* field re-nulls `terrainPatches` unless you re-set
  the ref on the proxy first. New public fields don't inherit their initializer on existing instances — push via
  the proxy + **verify in the backing, not the proxy**.
- **Save the scene** after baking — the holder's big serialized arrays + the wiring evaporate on the next forced
  recompile/domain reload otherwise (they survive a normal play/stop, but not a forced script recompile).

## Verification required in Unity

- Enable **Ride telemetry log** on the Diagnostics board and capture the marked Snowdream lips. Every
  `probeSource=analytic-ray` record must have `analyticResidual <= 0.001`, and takeoff-relative position,
  trajectory pitch, and board pitch should match the stored PCSX2/Slopesmith gold.
- Profile a representative 300-frame grounded run in Editor/ClientSim and on the target Quest tier. Record frame
  time, board update time and GC while comparing analytic vs faceted. Measurements taken against the one-eval
  shortcut are baselines only, not evidence for the bounded solver.
- Verify that recovery records (`probeSource=recovery`) appear only on genuine steep seam misses; they intentionally
  report no ray residual.

## Fallback behavior

The runtime does not expose a second contact model. Patch-backed terrain always takes the bounded analytic solve;
props, absent patch data, or rejected solves automatically take the smooth-normal faceted fallback.

## See also

[002 — Terrain Geometry](unity/002-terrain-geometry.md) (the Bézier patches + tessellation this reads from),
[009 — Collision](009-collision.md) (the `Surf_<type>` colliders the board raycasts),
[017 — Rideable Board](vrchat/017-rideable-board.md) (the vehicle; the collide-and-slide the sink allowance interacts with),
[020 — Surface Physics](vrchat/020-surface-physics.md) (the other half of the ride — per-surface μ/grip),
[025 — Performance](vrchat/025-performance.md) (the Quest budget behind "analytic, not finer tessellation"),
[034 — The Bundle Pipeline](../../Snowknife/docs/034-bundle-pipeline.md) (where the patch data + glb come from; `Patches.json` shipping),
[004 — Orientation & Scale](unity/004-orientation-and-scale.md) (the root transform behind gotcha 1).
