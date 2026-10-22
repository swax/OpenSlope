# Terrain visibility and submission

Terrain tessellation now records each patch's index span, material batch and
bounds of its generated float vertices. A median-split visibility hierarchy
gathers patch IDs with a three-state test against the camera's Vulkan clip
volume and a 600 metre camera-centred sphere. Distance tests use the nearest
edge of each AABB, retaining whole patches that intersect the range. Fully
distant hierarchy nodes are rejected together. Bounds crossing a plane or
containing the view are retained; a scale-aware float-rounding margin favours
extra work over disappearing edges.
Sorted IDs preserve source material/primitive order. Imported Maps schemas are
unchanged: these records are generated at runtime, not additional map files.

Sparse views pack admitted indices into a renderer-owned coherent index buffer,
then issue one draw per surviving material. Buffer capacity grows with demand
and persists across target recreation. Scene geometry, source indices and the
hierarchy are shared between eyes; visibility and packed indices are separate
for each eye. The original buffer is reused only when every index survives.
The earlier 75% dense-view fallback could reintroduce out-of-range geometry, so
it no longer applies to this bounded submission path.
Empty views submit no terrain. Meshes without patch metadata retain their
original path. Span/material partitions, bounds and referenced vertices are
validated before uploading the scene.

This is independently authored geometric culling and submission policy using
standard AABB, homogeneous clip-plane and BVH identities. Clean Trailmap 400
requires rendering/collision independence and describes original grid gathering
and adaptive density. This milestone does not implement that grid or adaptive
tessellation. Collision control points/probes and render density stay unchanged.
Build 0.81 adds the distance gate on desktop and Quest. The sky retains its
existing far clip. Fog fades from 300 to 600 metres using the course's fog colour;
authored fog ending sooner is preserved. Maps without enabled fog receive the
same range haze. There is no streaming, occlusion culling or density reduction.
Render-time bounds must be regenerated if later terrain geometry changes.

Desktop `--no-terrain-culling` disables frustum selection for comparison, while
retaining the same 600 metre distance gate and fog.
Capture diagnostics report patch survivors, submitted/total indices, draws,
tested bounds, visibility CPU time and packed frames. The option is desktop-only;
OpenXR uses the shared culling path with its own eye matrices. Its five-second
logs also identify the course, current terrain patch/index/draw counts, range
and last-eye visibility CPU time. Device frame budgets require live measurement.

Portable checks cover the 600 metre boundary, large crossing bounds, spherical
off-axis rejection, range-only and combined subtree rejection, all six clip
planes, enclosing/near-boundary bounds,
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

Before the 0.81 distance gate, a local check rendered 1,440 frames at 1280x720
and 4x MSAA. Medians of
the two per-mode run averages were:

| Course | Average submitted indices, full / selected | GPU ms, full / selected | Render wall ms, full / selected | Visibility CPU ms, selected |
|---|---:|---:|---:|---:|
| GARI | 1,491,840 / ~52,216 | 5.23 / 0.23 | 5.66 / 0.55 | 0.028 |
| MERQUER | 1,048,704 / 1,048,704 | 2.55 / 2.42 | 2.94 / 2.88 | 0.109 |

GARI removed about 96.5% of submitted indices. Merqury's dense view deliberately
used the then-current full-buffer fallback; there was no geometry reduction to
claim there. Timings are
limited local diagnostics: GARI's full-run GPU averages varied from 3.29 to 7.18
ms, and the tiny dense-view timing difference is within normal run variability.
These headless measurements exclude presentation and final capture transfer;
they are not a full game/VR performance baseline or a portable speed guarantee.
Resident index copies and per-eye buffer growth add memory that still needs
profiling. Terrain LOD/stitching, prop spatial gathering, upload batching,
GPU wait reduction, larger trajectories and hardware VR checks remain tracked.

The 0.81 Peak 1 check used the same 120-frame replay at 1920x1080 scene resolution
and 4x MSAA before and after the distance gate. Average submitted terrain indices
fell from 2,177,980 to 330,480 (84.8% fewer); local GPU averages fell from 7.68 to
2.05 ms, and visibility/packing CPU averages from 4.84 to 0.55 ms. Final gameplay
state and this near-view capture's pixels matched exactly before/after. With the
new range policy, frustum-enabled and
range-only submissions also produced identical final pixels. This is one desktop
trajectory, not a Quest FPS claim; the range/fog intentionally changes distant
pixels compared with the old 10 km view. Synthetic Vulkan checks cover dense
range rejection, movement, empty submissions and fog pixels on UNORM/sRGB at
1x/4x MSAA.

A subsequent focused Quest 3 Peak 1 ride retained 2520x2640 eyes, 4x MSAA and
the 120 Hz target. Seven five-second windows recorded 52.6–74.5 rendered fps
(median 62.5), with 13.39–18.96 ms of previous both-eye GPU time. Current left-eye
samples admitted 299–800 of 11,187 terrain patches and spent 0.28–0.50 ms gathering
and packing them. Earlier 0.80 slow views recorded roughly 21–39 fps. These are
different ridden positions and directions, not a synchronized device replay or
a complete-course minimum-FPS claim. The app remains GPU limited in these views
and does not yet hold the 120 fps target at this resolution/MSAA setting.
