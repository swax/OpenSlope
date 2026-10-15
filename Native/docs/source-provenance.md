# Native source provenance

The implementation inputs are the clean Trailmap specification bodies, the Apache-2.0 shared
OpenSlope contracts and standard mathematical/protocol identities. Evidence annotations and
other components' implementation sources are outside this implementation boundary.

Build 0.45 independently recovers board-family routes from the scalar selector
described by clean 190/420. Provider/normalizer dataflow, checked dispatch,
constant returns and bounded interpretation use standard ELF/MIPS semantics;
the terrain domain comes from the shared ride contract. No mapping rows or
retail addresses/instructions are compiled. Existing Shared output validates
the result only; no other decoder/runtime implementation supplies the reader.
See board-audio-import.md for admission rules, tests and remaining playback parity.

Build 0.44's collision-event recovery uses clean 190/420, standard ELF/MIPS scalar
semantics and independently inspected user-supplied data for interface validation.
The bounded control-flow evaluator and unrelated authored programs are new Native
code. No retail addresses, instruction words or event-row arrays are compiled,
and no other decoder/runtime implementation supplies the reader. Existing map
sidecars validate outputs only. See collision-audio-import.md for bounds and scope.

Build 0.43's independent sun/sky recovery uses clean 400/442, the shared relative
world-layout contract, standard ELF/MIPS scalar conventions and user-supplied
data for validation. No retail addresses, instructions or settings table are
compiled. The bounded constant evaluator and authored ISO/ELF fixtures are new
native code. See world-settings-import.md for limits and comparison evidence.

Build 0.42's celestial layer uses clean 400, public Slopesmith documentation/tests,
the first-party shared spoke pattern and standard homogeneous projection,
half-plane clipping and ray-query identities. Runtime geometry, fading, Vulkan
buffers and fallback art are independently authored. Existing private World.json
records are input/comparison data. Build 0.43 adds independent ISO sun-setting
recovery. No other runtime implementation was read or ported; see celestial.md.

Build 0.41 uses clean 350/410 and public Slopesmith ride documentation/tests for
rail presentation rates and sampled texture-coordinate behavior. Its independent
control and Vulkan changes retain the shared ride contract. Owned Aloha mesh data
supplies direction comparison only; see rail-water.md for evidence and limits.

Build 0.37's mesh-throw fields and break-chain structure follow the sanitized
230/370 bodies. Kinematics, piece spread/tumble and transform composition are
independently authored application math. Priority-material alpha is a Slopesmith
public `texture-array.test.ts` acceptance behavior. Private map data is used for
comparison only. No other runtime or differently licensed library implementation
was read or ported for this work; see shatter.md for the remaining sound gap.

Build 0.38's live rigid props use the sanitized 130/230/370 bodies and standard
rigid-body impulse, rotation and constraint identities. Terrain/compound contact
gathering and the sequential manifold solver are independently authored. Shared
map output is comparison data only. Application launch/friction/sleep tuning,
desktop evidence and remaining solver/device limits are explicit in rigid-props.md.

| Importer part | Implementation authority |
|---|---|
| World particles | Clean 150/180/230/400 bodies, the Apache short-identifier particle registry contract and standard affine/billboard/blend identities. Independently authored compact emitter records, seeded sampling, graph/contact lifecycle and Vulkan batches. The registry is independently compared with user-image data and Slopesmith's public API; no other runtime or library implementation is a port input. See world-particles.md for application choices and remaining fidelity/device work. |
| Primary ISO9660 directory access | [Trailmap: 200-iso]; bounded, seekable document/file reads. |
| Course events and clocks | Clean 250/390 bodies, standard segment/plane math and the public Slopesmith manifest/checkpoint/lap/clock tests. Independently authored mode datasets, stored horizontal DTF, active-line event crossings, clocks/lap order, bounded portable settings and labelled controller panel. Application gates/tuning and incomplete race systems are explicit in course-runs.md. |
| Walking and boarding | Independently authored application mode, vector/slide math and solid floor/sphere queries. Slopesmith public walking/coasting tests establish feature inventory; clean 300/340/350/370 retain recovered riding authority. This mode does not claim recovered retail walking behavior; tuning and limits are in boarding.md. |
| Crash and animated recovery | Clean 300/340/370 bodies and standard rotation/interpolation identities. Independently authored crash lifecycle, bounded pose tracks/events, relative get-up, camera separation and run-gated fallbacks. Retail character clips are out of scope, and tumble timing and exact landing thresholds are not supplied by these inputs; explicit application tuning and remaining gaps are in crash-recovery.md. |
| Sky panorama and fog | Clean 220/400/442 bodies, existing portable sky/world contracts and standard Vulkan depth/projection identities. Independently authored model-only loading, shared bounded art, per-eye camera centring, seam sampling and radial fog. Original sky colour values are not compiled; defaults/tuning and remaining limits are explicit in world-appearance.md. Generated OBJ/PNG data supplies validation only. |
| Four-rail carve sheet | Clean 380 establishes the distinct connected sheet, quarter-metre columns, fixed half-metre tail, upper-rail throw multipliers and life. Clean 180/400 and owned named art establish texture/compositing inputs. Independent bounded state, ground probes and a literal-world additive pass; per-row/throw/drag/colour/UV bindings remain application tuning in spray-sheet.md. |
| Carved wake | Clean 380 wake gate/table/model facts and 400 alpha compositing; independently authored bounded paired history, terrain/rideable-prop probes and two-pass strip renderer. Exact width/fade/offset bindings remain explicit application tuning in carved-wake.md; owned named art and synthetic alpha/depth/repeat captures supply validation only. |
| Riding clouds / particle art | Clean 180/380/400 bodies establish distinct gates, lifetimes and compositing. Independent fixed-tick bounded state and camera-facing additive quads; application signal/opacity tuning remains explicit. Particle RGB-range/association policy is validated by authored palettes and all 38 owned generated sprite RGBA images, without decoder implementation input. |
| Desktop MSAA | Standard Vulkan colour/depth sample-count queries, multisample rasterization and render-pass resolve. Independently authored resource ownership and synthetic diagonal-edge pixel checks; an application quality policy rather than recovered original-hardware filtering. |
| Terrain visibility/submission | Standard homogeneous Vulkan clip planes, AABB support intervals and median-split BVH identities; first-party ordered index packing and dense-view reuse. Clean 400 establishes rendering/collision independence; original grid/LOD behavior remains separate work. Authored clip/GPU oracles and generated course captures establish comparison evidence without decoder implementation input. |
| Automatic Audio import | Clean 190/200/260/270/420 bodies and the shared fixed-environment identifier contract; independently authored config matching, variable-stride ADL reads, serialized manifest-hash joins and bounded asset staging. All eleven generated courses/WAVs are comparison data only. Executable collision routes are now independently recovered (collision-audio-import.md); board-family routes are recovered in build 0.45 (board-audio-import.md). Neither table is compiled into the importer. |
| Archive table and compression | [Trailmap: 200-c0fb, 200-bigf, 200-refpack-header, 200-refpack-commands]. Format identifiers and byte-command equations are interoperability facts. |
| Terrain records and names | [Trailmap: 200-map-manifest, 220-header, 220-patch, 220-power-basis]; the public OpenSlope patch contract. |
| Runtime coordinate conversion | Proper -90 degree X rotation and centimetre scale, preserving the observed course turns. The disputed extra reflection in chapter 002 is documented in spec-alignment.md; output maps remain in their canonical raw frame. |
| Basis conversion | Direct tensor transform using `t^k = sum(i=k..n) C(i,k)/C(n,k) B_i^n(t)` with `n=3`. Accumulation uses double precision and does not reproduce another decoder's staged float recurrence. |
| Texture/lightmap decoding | [Trailmap: 210-directory, 210-chunk, 210-longname, 210-palette, 210-swizzle, 210-alpha, 210-color, 210-lightmap-profile]. |
| PNG output | Standard PNG RGBA8, CRC-32, Adler-32 and stored DEFLATE blocks; no image-conversion dependency. |
| PNG input | Standalone LodePNG, checksum-pinned upstream revision with its complete license retained. No game-format readers are supplied by this dependency. |
| Terrain appearance | [Trailmap: 110-uv-rotation, 160-tile, 160-luminance, 160-transpose, 400-double, 400-lighting]; first-party GLSL, UV evaluation, image bounds and Vulkan resource ownership. Synthetic PNGs and GPU pixel assertions are authored independently of course exports. |
| Static prop decoding | Clean chapters 120, 170, 220 and 230; bounded independent PBD/VIF/SSF readers and standard OBJ output. Pointer origins are checked against source bytes and authored synthetic records, never another decoder's implementation. |
| Prop placement/lighting/rendering | Clean chapters 120, 160, 170 and 400; standard affine/quaternion identities, first-party OBJ parser, model-local baked lighting and Vulkan instancing/culling. Generated outputs are comparison data only; see static-props.md for deliberate limits. |
| Course path decoding | Clean chapter 250 and independent byte-layout fixtures. Relative section offsets, header shapes, displacement expansion and event retention are authored here. Generated AIP/SOP output supplies validation only. |
| Desktop rider controls | Clean chapters 300, 330, 340 and 360 plus the unchanged shared contract. Slopesmith establishes the desktop feature/control vocabulary; Native's state, launch, contact and replay code are independently authored. Port tuning and presentation differences are explicit in desktop-controls.md. |
| Authored collision foundation | Clean chapters 120, 130, 220, 230 and 370; independent pool/payload readers, retained source box bounds, portable proxy/body contracts, standard affine geometry and BVHs. Synthetic format and query fixtures establish supported cases; gameplay integration and provisional double-sided/ellipsoid behavior are recorded in collision-foundation.md. |
| Playable prop contact | Clean chapters 130, 300, 320, 340 and 370; shared ground probes, continuous posed-volume sweeps, independent contact lifecycle and specified bounce/wipeout transition. Exact limb probe profile, bounded solver and pending animation/world-logic behavior are explicit in world-contacts.md. |
| Audio data and playback | Clean chapters 190, 200, 260, 270, 420 and 430; independent bounded disc-member access, PCM/container/codec handling, expression programs, graph walking and stereo mixing. Generated clips/graphs provide validation data only. Windows and Android output use platform audio APIs; tuning and unfinished extraction/runtime paths are explicit in audio-playback.md. |

Texture association is not marked by the course bank. Native's application policy only infers
associated alpha when there is at least one fractional texel and every fractional texel has all
normalized colour channels at or below alpha. It then divides those channels by alpha to produce
unassociated PNG pixels. A violation leaves the image unchanged. This inference can confuse dark
straight-alpha art with associated art; it is an explicit provisional viewing policy, not a format
claim. It uses no fractional-band percentages, near-opaque cutoffs or tolerated-violation counts.

Required file magic, section labels and public JSON property names remain as specified so maps
interoperate. Internal types, routines, control flow and comments are authored here. Dependency
archives are explicitly enumerated and checksum-pinned in `cmake/dependencies.cmake`; their
notices are retained under `ThirdPartyNotices/`. There is no cross-component decoder linkage.

`npm run verify:native` checks source and documentation for prohibited component references and
known decoder identifiers, including files not yet staged. The guard lives in repository tooling
outside this component. It is a reference check, not proof of authorship. Provenance review and
synthetic format/math tests are also required when adding an importer stage. Output comparison
tools live outside Native and consume generated map files only.

## Recorded output differences

Against the existing local GARI reference, direct double accumulation changes control coordinates
by at most 0.03879 raw cm (0.3879 mm). Metadata is unchanged. The terrain surface is also tested
against an independently declared mixed cubic polynomial, avoiding reliance on another converter's
floating-point operation order.

The strict associated-alpha inference leaves `0083.png` and `0108.png` unchanged where a reference
exporter's heuristic alters them. The other 119 course textures and all 16 raw lightmaps match
decoded pixels exactly. These differences are explicit application-policy differences; they are
not reported as exact extraction parity. No per-course texture-ID special cases enter the decoder.

Static-prop comparison checks generated model/placement/material contracts and expanded triangle
corners, including UVs, packed normals, winding, visibility and animation data. Different JSON
decimal spellings are compared at recovered float32 precision for source locations/lighting/animation scalars.
Mesh positions permit 0.001 raw cm; no per-course mesh exceptions are used. Material labels are
neutral because linker names do not have an established PBD material-row correspondence.
Exact source matrices are retained through an optional portable-contract extension. Deferred
material/behavior fields are not reported as equivalent. See static-props.md for the comparison scope.

Rail conversion and gameplay use clean chapters 140, 220, 230 and 350, public
Splines.json keys and standard cubic/BVH math. The own power-to-control transform
uses double accumulation; generated JSON supplies comparison data only. Exact
source coefficients remain available to runtime nearest queries. See rails.md
for declared control-rounding bounds and unresolved lifecycle details.

The stick figure is the unchanged Apache-2.0 first-party Slopesmith asset, with
its original attribution retained. Native independently loads its rigid GLB
skin and authors procedural posing, generic controllers and text geometry.
OpenXR body/full-body/fidelity integration follows public Meta/Khronos ABI and
API documentation; clean Trailmap gameplay state remains separate. See avatar.md.

The optimized Android build, renderer-local placement descriptors, deferred XR
completion, timing instrumentation and resolution/MSAA controls are independently
authored platform work using standard CMake, Vulkan and OpenXR contracts. They
preserve clean 400's depth, lighting and draw-order authority. Synthetic queued-eye
fixtures compare rendered pixels without consulting another renderer's implementation.
See graphics-quality.md for the device measurements and remaining limits.

Native trick scoring is independently authored from clean 360/390 and behavioral
examples in the first-party score tests. Its rounded energy-fill profile and
unimplemented recovered fields are explicit in trick-scoring.md. VR controls use
first-party public head-steer/XR tests and documented tuning values, with new
fixed-tick input/seat integration; see vr-steering.md. No other runtime or decoder
source supplies these implementations.

Course recovery uses clean 250/300/390, portable path data and first-party public
course-reset behavioral examples. Projection, candidate ranking, support checks,
bounded trail history and trap handling are authored independently. The application
fallback/boundary choices, post-placement fade-in and clock-expiry policy are
explicit in course-recovery.md, alongside the remaining viewport effect and
world triggers. The shared Vulkan fade uses standard shader colour scaling.
Local course files supply validation data only.

World logic is independently authored from clean 150/230/390 and first-party
Effects v1 interfaces and public behavioral tests. Source words and typed node
payloads are compared only against generated Maps data; no decoder source is
consulted. Integer-encoded payload words retain their portable data contract.
The bounded scheduler, runtime instance flags, collision ordering, Vulkan prop
filter and sound dispatch are new native code. See world-logic.md for scope.

Model-object animation, per-instance clocks, persistent region dispatch and
matching moving collision/support are independently authored from clean
120/150/230/400, first-party public animation/lifecycle behavioral examples and
standard transform/BVH math. Existing exported Models/Effects data supply only
validation inputs. The source LTG grid is not decoded; cell/range choices and
temporal/rotational approximations are explicit in prop-animations.md.

Spline-path drawing is independently authored from clean 150/230, first-party
public cursor/orientation/lifecycle behavioral examples and standard quadrature,
root bracketing and affine transforms. No separately licensed decoder or runtime
code supplies the sampler, cursor, scheduler or Vulkan cable/copy path. Existing
course geometry/behavior data is used only for interoperability and local renders.
Application bounds and unsupported collision/lifecycle profiles remain explicit
in spline-movers.md.

Counter/checklist state, gated fragile properties, legacy material-directory
reads, private frame descriptors and paired contact/material integration are
independently authored from clean 150/170/220/230/370, first-party public
behavioral tests and exported contact-profile constants. Existing Maps and saved
source bytes are comparison inputs only; all eleven frame lists are compared to
independent existing exports. No other decoder/runtime implementation supplies
these algorithms. Application force/proximity choices and outstanding throw,
UV, respawn and exact-trajectory scope are explicit in deferred-world.md.

UV/flip clocks, per-material selections, graph lifecycle and private shader UV
state are independently authored from clean 150/170/230/410 and first-party
public behavior tests. Standard fixed-step accumulation, modular coordinates
and Vulkan placement storage supply the implementation. Existing course data
only validates joins, activation and output; no other runtime code supplies
these clocks or material algorithms. See material-playback.md for scope.

Crowd cell playback, shared-bank/profile import, per-eye page selection and node
lifecycle are independently authored from clean 150/170/200/230/410, public
authoring descriptor examples and standard random/fixed-step/filesystem/Vulkan
facilities. Owned source bytes and existing model exports only validate art and
material order. No other decoder/runtime implementation supplies this controller
or its binding algorithms. Activity and RNG fidelity limits are explicit in
crowd-playback.md.

Flag/banner clocks and mesh subdivision are independently authored from clean
150/230 and standard sine/interpolation/graph traversal/Vulkan operations.
Existing owned map data validates strip topology, units and activation only.
No external runtime or decoder supplies the cloth implementation. Application
randomness and outstanding lighting/contact fidelity are recorded in
flag-cloth.md.

Quest button alignment uses Slopesmith's public manual/tests as behavior evidence.
Native binding tables, equipment-only recall and presentation state are authored
independently. Controller/hand frames use Khronos OpenXR grip definitions and
ordinary orthonormal bind transforms; no runtime control or avatar implementation
from another project supplies the code. See quest-controls.md for primary links.

Equipment interaction, throw filtering and UI are independently authored from the
public Slopesmith ride manual/behavior inventory and standard rigid frames, OBB
slabs, axis-angle rotations and platform input protocols. The chase camera uses
clean 400 bodies, independently authored cached sphere/triangle guards and
time-based exponential responses. Its near framing is an application choice,
not a claim about the original default. The font is factored from Native's
existing first-party controller-label geometry. See equipment-camera-ui.md.

On-foot flight and movement are independently authored from the public first-party
ride manual, exported profile values and measured public-API behavior traces.
Terrain sweeps use the existing cached patches and standard sphere/triangle
queries. Stock snowboard geometry is intentionally reused first-party art, baked
through its public API into an attributed GLB. Native consumes only that saved
asset; no authoring runtime implementation is copied or linked. See foot-flight.md.

Board audio performance is independently authored from sanitized Trailmap 190/420,
the public Slopesmith audio docs/tests and public-API observations. The shared
board-audio profile contains first-party response/mix tuning rather than retail
expression sequences. A separate tool compares the compiled Native response with
the public first-party API; Native does not import that runtime. WAV/loop matching,
cache admission, ramping and revision-checked background music use ordinary PCM,
string matching and synchronization operations. See board-audio-performance.md.
