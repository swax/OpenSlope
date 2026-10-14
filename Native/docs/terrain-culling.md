# Terrain visibility and submission

Terrain tessellation now records each patch's index span, material batch and
bounds of its generated float vertices. A median-split visibility hierarchy
gathers patch IDs with a three-state test against the camera's Vulkan clip
volume. Bounds crossing a plane or containing the view are retained; a
scale-aware float-rounding margin favours extra work over disappearing edges.
Sorted IDs preserve source material/primitive order. Imported Maps schemas are
unchanged: these records are generated at runtime, not additional map files.

Sparse views pack admitted indices into a renderer-owned coherent index buffer,
then issue one draw per surviving material. Buffer capacity grows with demand
and persists across target recreation. Scene geometry, source indices and the
hierarchy are shared between eyes; visibility and packed indices are separate
for each eye. A view retaining more than 75% of the original indices reuses the
original submission instead. The threshold is application tuning, introduced
after a dense-view measurement showed that copying nearly all indices was costly.
Empty views submit no terrain. Meshes without patch metadata retain their
original path. Span/material partitions, bounds and referenced vertices are
validated before uploading the scene.

This is independently authored geometric culling and submission policy using
standard AABB, homogeneous clip-plane and BVH identities. Clean Trailmap 400
requires rendering/collision independence and describes original grid gathering
and adaptive density. This milestone does not implement that grid or adaptive
tessellation. Collision control points/probes and render density stay unchanged.
There is no new distance cutoff, streaming, occlusion culling or density reduction.
Render-time bounds must be regenerated if later terrain geometry changes.

Desktop `--no-terrain-culling` provides the full-submission comparison path.
Capture diagnostics report patch survivors, submitted/total indices, draws,
tested bounds, visibility CPU time and packed frames. The option is desktop-only;
OpenXR uses the shared culling path with its own eye matrices. Device behavior
and frame budgets remain unverified without hardware.

Portable checks cover all six clip planes, enclosing/near-boundary bounds,
independent stereo eyes, ordered results and subtree rejection. Twenty random
perspective queries over 1,024 boxes agree with an independent eight-corner
oracle. Actual Vulkan tests compare full and selected submissions pixel-for-pixel
on UNORM/sRGB at 1x/4x, including mixed materials and empty views, with 674
assertions. All eleven owned-course initial captures also match exactly.
Jump/switch-landing, four authored contact cases and gameplay-audio captures pass.

The benchmark tool runs fixed replays, records rendering/simulation/visibility
times, and checks final gameplay state and final pixel equality. Captures and
logs stay in a new local output directory; no retail media enters source control.

```powershell
python Native/tools/benchmark_terrain.py temp/native/Release/openslope_player.exe <Maps-root> <new-output> --courses GARI MERQUER --ticks 180 --runs 2
```

The final local check rendered 1,440 frames at 1280x720 and 4x MSAA. Medians of
the two per-mode run averages were:

| Course | Average submitted indices, full / selected | GPU ms, full / selected | Render wall ms, full / selected | Visibility CPU ms, selected |
|---|---:|---:|---:|---:|
| GARI | 1,491,840 / ~52,216 | 5.23 / 0.23 | 5.66 / 0.55 | 0.028 |
| MERQUER | 1,048,704 / 1,048,704 | 2.55 / 2.42 | 2.94 / 2.88 | 0.109 |

GARI removed about 96.5% of submitted indices. Merqury's dense view deliberately
uses the full buffer; there is no geometry reduction to claim there. Timings are
limited local diagnostics: GARI's full-run GPU averages varied from 3.29 to 7.18
ms, and the tiny dense-view timing difference is within normal run variability.
These headless measurements exclude presentation and final capture transfer;
they are not a full game/VR performance baseline or a portable speed guarantee.
Resident index copies and per-eye buffer growth add memory that still needs
profiling. Terrain LOD/stitching, prop spatial gathering, upload batching,
GPU wait reduction, larger trajectories and hardware VR checks remain tracked.
