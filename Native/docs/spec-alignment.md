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
| Sky panorama and fog | [Trailmap: 220-model-header, 400-backdrop, 442-load] | Separate imported/model-only sky contract, per-eye camera translation cancellation, far-depth unlit panorama, seam-derived or explicit clear colour and distance fog. Portable and actual stereo/GPU checks; original executable sky colours and remaining world graphics are explicit in world-appearance.md. |
| Static prop import and placement | [Trailmap: 120-tables, 120-anim-base, 120-euler-order, 160-instance-normal, 220-instance, 220-model-header, 220-chunk-layout, 220-strips, 220-material-block, 220-anim, 230-joins, 230-props] | Shared OBJ models, material-block resolution, hierarchy/rest transforms, a time-zero animation snapshot, exact affine matrix extension and authored visibility. Independent packet fixtures and generated-output comparison. See static-props.md for pointer origins and deferred behavior. |
| Prop lighting and submission | [Trailmap: 160-instance-frame, 170-alpha-flag, 400-lighting, 400-translucent-order, 400-draworder-split] | Model-local authored normals, ambient plus three keys with byte-domain HDR headroom; opaque/cutout instancing, distance/frustum culling and shared stereo resources. GPU checks exercise rotated/hidden placements and alpha flags. sRGB translucency remains an approximation as documented in static-props.md. |
| Surface response table | [Trailmap: 310-table] | All 20 rows embedded from the shared contract; type 15 is the unknown-type fallback. Type 17 is excluded from terrain contact. |
| Contact spring | [Trailmap: 320-spring, 320-spring-accel] | Three zones, centimetre acceleration conversion, capped pushout, position-before-velocity integration. Direct tests distinguish zones and units. |
| Grounded redirect | [Trailmap: 320-redirect] | Re-probe after integration; rotate normal velocity with speed preservation; skip powder types 3 and 4. |
| Forward / lateral resistance | [Trailmap: 330-resistance, 330-lateral] | Independent C++ equations run against the shared synthetic scalar fixtures with the same relative tolerance as the TypeScript suite. |
| Heading closure | [Trailmap: 330-yaw, 330-alignment-basis] | Mode-dependent lead, slip sign, speed gate and per-tick yaw cap; direct rest/cap checks. Full trajectory parity has not yet been established. |
| Desktop controls and jump/landing | [Trailmap: 300-decoupled, 330-lean, 340-charge, 340-magnitude, 340-blend, 340-landing-bands, 340-landing-seed, 360-cruise, 360-held] | Separate jump control, delayed additive launch, shaped lean, cruise/boost gates, switch riding and progressive landing bands. Swept terrain contact retains impact velocity. Authored CPU checks and a 269-frame actual Vulkan replay. Application choices and remaining trajectory/air-orientation gaps are in desktop-controls.md. |
| Crash and recovery | [Trailmap: 300-wipeout-triggers, 300-recovery, 300-wipeout-timeout, 300-reset-separate, 340-landing-gate] | Shared crash causes, provisional angular tumble, near-crash get-up with carried momentum/stance, keyframed pose events, camera separation and active-run reset gating. Original clip/tumble/landing and path/fade reset gaps remain explicit in crash-recovery.md; portable and actual-host cases cover supported behavior. |
| Course path conversion / starts | [Trailmap: 120-stagearea, 250-header, 250-section-a, 250-section-b, 250-accumulation, 250-seed-vertex, 250-events] | Independent AIP/SOP readers, retained event/DTF/rating/respawn fields, N+1 runtime polylines and middle start-slot selection. Source/generated comparisons and authored layout fixtures; race/reset/event consumers remain outstanding. |
| Authored collision foundation | [Trailmap: 130-contact-state, 220-model-header, 230-pools, 230-proxy, 230-body, 230-props, 230-joins, 370-sphere-box, 370-depenetrate, 370-bounce] | Independent multi-payload extraction, local box bounds, raw/RLE occupancy masks, affine shape queries, BVHs and contact/response separation. The shared player and asset cache consume these queries; provisional query choices are recorded in collision-foundation.md. |
| Playable prop contact | [Trailmap: 130-contact-state, 130-mode1-result, 300-wipeout-triggers, 370-probe-volume, 370-probe-mask, 370-probe-modes, 370-slide, 370-bounce, 370-pass-through] | Rider/Quest-cache integration, unified ride surfaces, posed sweeps, contact begin/stay/end and hard-impact wipeout. CPU/Vulkan fixtures and all eleven generated-contract comparisons; original pose/mask and animation-driven recovery gaps remain explicit in world-contacts.md. |
| Sound and music playback | [Trailmap: 190-bank, 190-groups, 190-collision-event-map, 260-bnk, 260-schl-chunks, 260-eaxa, 260-psadpcm, 270-node, 270-link, 270-tail, 420-oneshot, 420-ambient-curves, 420-interactive-gate, 430-choose] | Independent audio decoding/mixing, explicit map routes, posed contact/ambient/board gates and queued graph audio. Authored CPU/actual-host captures and owned-output comparisons; executable resolver normalization, exact tuning, complete race/trick/speech and device behavior remain in audio-playback.md. |
| Automatic Audio assets | [Trailmap: 200-map-manifest, 260-adl, 260-banksinf, 270-triplet, 420-ambient-banks, 420-no-flat-bed] | Typed ADL/hash bindings, config-selected banks and song/intro/async assets, explicit fixed/crowd routes, bounded staging and atomic rollback. Authored ISO cases and all eleven owned-course output comparisons; executable collision/board tables and dynamic/speech/runtime consumers remain explicit in audio-import.md. |
| Complete rider, world, rendering, audio | Chapters 130, 170, 300, 340-430 | Not complete: hard landing/crash recovery, walls/undersides, prop collision/live behavior, rails, triggers, authored course reset, remaining material/blend modes, effects, audio and races remain ports. The full desktop-parity.md matrix tracks the active objective. |

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
highest-rideable-patch fallback start and recovery below the course. Map starts prefer authored
start slots and use a one metre, zero-velocity drop-in. Desktop charge/brake/flip tuning, rendered
pitch flips, switch folding and camera separation are application choices recorded in desktop-controls.md.
Terrain normals are oriented toward the sky for this initial upper-surface player. Full underside
and wall orientation handling needs the complete rider/collision port. Controller mappings and the
standing-camera fallback are application choices. No retail character or trick repertoire is included.

The conformance tests validate the named helpers and format/geometry boundaries. A playable native
ride is not evidence of full state-machine, collision-object, rendering, or game parity. Expand the
matrix and independent fixtures as each later specification slice lands.

Rails align with clean 140, 220, 230 and 350: candidacy, exact cubic nearest,
Motion 3 / Control 15, tangent forces, snap, spin, masks and jump/exit. Unresolved
axes/post-grace blend and independent tuning are explicit in rails.md.

User-directed stick figure and controller presentation uses the existing
first-party asset and new procedural posing. Clean 300/340/350/370/400 retain
state, pose/camera and depth authority. Optional platform tracking does not
change recovered physical controls. See avatar.md for application choices.

Walking/boarding is an application mode outside clean 300's recovered riding
states, using separate ID 100 and independently authored movement/coasting.
Riding charge, rail and collision authority remains clean 340/350/370.
See boarding.md for explicit tuning, feature-test comparisons and remaining work.

Course progression and timed runs follow clean 250/390 for horizontal stored DTF,
mode-specific datasets, active-line checkpoints, slot clocks, AIP finish location
and lap/finish order. The countdown and bounded plane test are application
presentation/query choices. Full field, world, scoring, audio and reset behavior
remain separate work; see course-runs.md for evidence and limits.

Android optimization and XR submission/quality controls are application/platform
choices. Clean 400 still governs scene lighting, depth and transparent ordering;
separate eye placement buffers preserve these semantics during deferred submission.
Neither MSAA nor render scale substitutes for the outstanding terrain LOD/stitching
work. See graphics-quality.md for synthetic and live Quest evidence.

Spin/flip/rail style, bank/loss and energy gates use clean 360/390. Rounded base
energy and quarter-bar starts are the first-party play profile; character-stat,
flip divisor, airborne bleed and uber tiers remain explicit in trick-scoring.md.
VR head/stick selection and seat carry are application controls from first-party
behavioral tests, outside the original game's recovered inputs. They retain the
shared 330 carve and desktop 350 rail paths; see vr-steering.md.

Course recovery consumes clean 250-reset-events, 300's Control 22 and 390-reset-path/placement with
horizontal stations, six respawn paths, lookahead ranking, window handling and
support-aligned 30 km/h drop-in. First-party trail/trap fallbacks and the geometric
tracker are application choices. The 0.8-second hold and 0.5-second fade-out are
implemented in desktop and OpenXR; the 0.2-second fade-in and completion across
clock expiry are application choices. The separate viewport effect, field bias
and remaining world/reset triggers are still required; see course-recovery.md.

Authored graph contacts use clean 150/230/390 for counted frames, slot and stable-ID joins,
function ownership, waits/gates/debounce, reset/multiplier/audio and tombstones.
Mode functions and rail toggles share runtime instance state across desktop/OpenXR.
Application script bounds, mode fallback and remaining region/property lifecycles
are explicit in world-logic.md; full graph playback is not yet complete.

Model-object playback uses clean 120 for absolute cubic channels, parent/local
composition and rest rules, and clean 150/230 for properties 256/257/258,
budget/combo controls, persistent activation and populated region/end latches.
Shared draw/collision poses retain clean 400 ordering/lighting and existing
contact authority. The sparse 100 m/300 m activation fallback, matrix
interpolation and rotational CCD approximations are explicit application
choices. See prop-animations.md; full LTG and graph playback remain unfinished.

Detached spline movers use clean 150/230 for independent draw-node ownership,
arc-spaced copies, cursor/end modes, tangent-only orientation, stop flags and
cable lines. Host placement/collision remains authored. Route-aware cell gathering,
quadrature/inversion, explicit constructor re-arm and presentation snapping are
application choices, documented with evidence and limits in spline-movers.md.
