# Native prototype specification alignment

The clean bodies of Trailmap chapters 002, 110, 160, 200, 210, 220, 310, 320, 330, 340, 360, and 400 were consulted for the
initial terrain/contact milestone. Raw provenance annotations are not implementation guidance.
`Contracts/ride-v1.json` matches the current local `Trailmap/specs/data/ride-v1.json` byte for byte.
The native build consumes the tracked Contracts copy, so it works without the optional local spec.

| Slice | Authority | Current implementation / validation |
|---|---|---|
| Centimetres, axes, fixed simulation | [Trailmap: 002-units, 002-axes, 002-timestep] | Z-up centimetres rotate to Y-up metres as `(x,z,-y)/100`; the disputed extra X reflection is omitted as explained below. 60 Hz clock with bounded catch-up and render interpolation. |
| Bicubic terrain | [Trailmap: 110-patch-model, 110-analytic-normal] | Row-major Bernstein evaluation; BVH broad phase; 9x9 coarse brackets; up to four Newton steps solve both patch parameters and ray distance. Analytic normal is independent of render tessellation. |
| Disc containers | [Trailmap: 200-iso, 200-c0fb, 200-bigf, 200-refpack-header, 200-refpack-commands] | Bounded primary ISO9660 access, absolute archive offsets and decompression, tested with authored synthetic discs and the local disc. No title executable or character imports. |
| Canonical terrain conversion | [Trailmap: 200-map-manifest, 220-header, 220-patch, 220-power-basis] | Linker patch names; exact tensor basis change from reversed coefficient storage; raw centimetres and UV/lightmap conventions retained in Patches.json. |
| Texture/lightmap extraction | [Trailmap: 210-directory, 210-chunk, 210-longname, 210-alpha, 210-color] | Bounded SHPS parsing, palette/colour handling and raw lightmap RGBA; PNG comparison against reference maps. Alpha association inference is an application policy with no sample-count thresholds. |
| Terrain appearance | [Trailmap: 110-uv-rotation, 160-tile, 160-luminance, 160-transpose, 400-double, 400-lighting] | Diffuse corner binding, repeating UVs, transposed page-tile UVs, byte-domain `(base - residual) * intensity`, and no additional normal lighting or second brightening of exported PNGs. Independent PNG/UV tests and actual Vulkan pixel checks on UNORM/sRGB targets. See terrain-appearance.md for sampling and limits. |
| Surface response table | [Trailmap: 310-table] | All 20 rows embedded from the shared contract; type 15 is the unknown-type fallback. Type 17 is excluded from terrain contact. |
| Contact spring | [Trailmap: 320-spring, 320-spring-accel] | Three zones, centimetre acceleration conversion, capped pushout, position-before-velocity integration. Direct tests distinguish zones and units. |
| Grounded redirect | [Trailmap: 320-redirect] | Re-probe after integration; rotate normal velocity with speed preservation; skip powder types 3 and 4. |
| Forward / lateral resistance | [Trailmap: 330-resistance, 330-lateral] | Independent C++ equations run against the shared synthetic scalar fixtures with the same relative tolerance as the TypeScript suite. |
| Heading closure | [Trailmap: 330-yaw, 330-alignment-basis] | Mode-dependent lead, slip sign, speed gate and per-tick yaw cap; direct rest/cap checks. Full trajectory parity has not yet been established. |
| Complete rider, world, rendering, audio | Chapters 130, 170, 300, 340-430 | Not complete: jump/landing detail, walls/undersides, props, rails, triggers, authored spawn/reset, remaining material/blend modes, effects, audio and races remain ports. |

## Deliberate difference from existing ports

Chapter 002 currently prescribes an X reflection in addition to a -90 degree rotation about X.
Applied to the portable map coordinates in this right-handed camera frame, that reflection
mirrors the mountain: GARI's observed opening right turn becomes a left turn. The loader now uses
only the proper rotation, `(x,y,z) -> (x,z,-y)/100`. This preserves route chirality and leaves
the canonical centimetre files unchanged. The spec's handedness claim needs clarification; this
is a recorded discrepancy rather than a claim that the paragraph has already been corrected.
Authored CPU route tests and an asymmetric raw-coordinate fixture through the actual Vulkan
view/projection pipeline reject the old reflection. The correction applies to map loading on
every native host; it does not add a camera mirror or per-course exception.

Chapter 320 currently specifies unconditional damping for both normal-velocity signs in the
above-surface spring zone. The existing TypeScript and Unity helpers only apply that zone's damping
when separating. This native slice follows the prose specification; its approaching-velocity test
would fail if the older one-sided formula were substituted. This difference does not establish a
bug in every existing runtime, and the native work does not silently change those implementations.

## Prototype choices, not recovered behavior

The demo uses original procedural terrain, colour-only rendering, a simple board quad, a
highest-rideable-patch start, initial 3 m/s movement, input smoothing, and recovery below the course.
Terrain normals are oriented toward the sky for this initial upper-surface player. Full underside
and wall orientation handling needs the complete rider/collision port. Controller mappings and the
standing-camera fallback are application choices. No retail character or trick repertoire is included.

The conformance tests validate the named helpers and format/geometry boundaries. A playable native
ride is not evidence of full state-machine, collision-object, rendering, or game parity. Expand the
matrix and independent fixtures as each later specification slice lands.
