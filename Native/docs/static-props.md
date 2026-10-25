# Static world props

The independent C++ importer emits the existing `Models.json`, `Instances.json`,
`Materials.json` and `Meshes/*.obj` rendering contracts. The desktop and OpenXR
players consume those same contracts from any selected course. Custom terrain-only
maps remain valid. If any prop JSON is present, all three tables are required;
missing meshes, invalid transforms, corrupt JSON and unsafe paths reject playback.
Missing optional textures use a warm neutral diffuse fallback with the instance lighting.
An empty or null texture reference is accepted as an untextured material.

## Specification authority and format boundaries

The clean bodies of Trailmap 120, 160, 170, 220, 230 and 400 govern this slice:
shared models and hierarchy, model-local instance lighting, authored normals and
material flags, PBD packet layouts, SSF visibility joins, and draw ordering.
Implementation sources and provenance annotations from other components are
outside the boundary. Authored packet fixtures exercise the reader independently;
generated reference maps are validation inputs only.

The PBD reader follows absolute section offsets, model-relative pointer tables,
object-relative rest/mesh/animation offsets and material-block indirection. Mesh
entry offsets are relative to their own pointer words. The animation's channel
table holds animation-relative pointers; each channel contains a segment count
and a channel-relative segment-array offset. Those pointer origins clarify the
compact chapter 220 prose and are tested explicitly. Bounded VIF transfers decode
signed UVs, packed normals and dequantized positions; alternating triangle-strip
winding survives OBJ output. Packed vertex normals and distinct UV/normal corners
are preserved. No smoothing or lighting regeneration is performed.

The generated material table contains the static base texture and flags used by
this renderer. Material names are neutral labels: the linker material namespace
is larger than the PBD table and has no established row correspondence. Remaining
material behavior fields are deferred. Per-instance material blocks that differ
from their model are rejected until the portable contract supports variants.

An optional `TransformMatrix` extension stores the exact column-major affine
matrix in the raw coordinate frame. Existing position/quaternion/scale fields
remain present. Readers without the extension can consume those existing fields;
the native loader prefers the exact matrix, preserving affine source transforms.
Model hierarchy transforms compose before placement. Raw centimetres become
`(x,z,-y)/100`, using the same chirality correction as terrain.

Source libraries may also provide `Models[].PlacementDefaults` and an optional
`PlacementCollisionPath` naming a model-local OBJ under `Collision/`. Slopesmith
uses these for authored copies, including separate tree-trunk hulls beneath visible
foliage. They do not alter the source course's instance collision. Canonical export
compiles the hull into ordinary `CollsionModelPaths` and placement transforms;
native playback continues to consume the existing instance collision contract.

Model animation data is retained, but rendering samples clip time zero only.
Channel values replace local pose components, cubic coefficients use Horner
order, and rotation uses Z-Y-X Euler composition in degrees. Unchannelled rotation
is zero and an animated object's rest matrix does not enter its sampled pose.
SSF authored visibility seeds each retained instance. Hidden trigger volumes and
pre-broken twins stay resident but never enter the draw list; runtime visibility
logic, animation clocks and scripted mesh swaps are deferred.

## Lighting and materials

Instance lighting uses authored model-local normals and directions:
`ambient + sum(max(0, dot(normal, direction)) * keyColour)`. Stored colours divide
by 256 without clipping the input records. The first-party play profile normalizes
the interpolated stored normal per fragment and clamps the final light factor to
`[0,1]` before diffuse multiplication. Instance rotation affects placement, not
the baked lighting dot product. Texture PNGs
already carry their import brightening; the shader does not brighten them again
or apply terrain lightmaps to props. Texture sampling remains RGBA8 UNORM and the
final colour is converted only when an sRGB attachment requires it.

This staging deliberately matches Slopesmith's visible textured preview. Clean
400 describes vertex-stage lighting and interpolation for the original renderer;
Native does not claim to reproduce that Gouraud stage. A black-box calibration
with independently authored geometry/textures distinguishes these paths, verifies
texture-true saturation even for HDR ambient input, and supplies pixel regression
cases. See prop-lighting-0.57.md for the evidence and boundary. The fallback colour
is the first-party neutral clay `(194,187,170)`; white effect/board tiles remain
separate.

Flag bit 18 explicitly selects the alpha pass; alpha bytes cannot turn an opaque
material transparent. An alpha-pass image with only binary alpha uses a 0.5
cutout threshold, otherwise it uses source-alpha blending. Opaque and cutout
meshes share the depth-writing pipeline; priority bit 17 draws later. Translucent
submissions sort back to front in stable quantized camera-depth buckets and also
write depth with LEQUAL. Cutout classification and threshold are application
choices for this milestone, not recovered alpha-test behavior.

Translucency on UNORM attachments blends in the original byte domain. On sRGB
attachments Vulkan blends in linear space after the output conversion, so these
translucent materials are an approximation. Pixel tests explicitly distinguish
the two results. Opaque/cutout colour output is checked on both attachment types.
Flipbooks, texture scrolling, environment/reflection modes and live object effects
remain deferred. The existing single-mip bilinear sampling limitation also applies.

## Resource ownership and culling

Each model's geometry is uploaded once and shared across placements and stereo
eyes. Opaque/cutout placements group by mesh part and use indexed instanced draws.
CPU geometry is released after upload. Placement matrices and baked lighting use
a bounded std430 storage buffer. Eye renderers currently serialize and wait for
completion, making the shared placement buffer safe to reuse between eyes.
Concurrent frames or multiview will require revisiting this ownership rule.

Every eye builds a draw list from authored visibility, distance to the instance
AABB (300 metre fallback range), and six Vulkan clip-plane tests. Intersecting
bounds are retained. This is an application culler, not a port of the original
world grid. Render geometry remains visual only: authored collision assets supply
solid, rideable and pass-through contacts separately. See world-contacts.md.
Live animation, break/rearm and scripted effects remain outstanding.

Each JSON/OBJ file is limited to 64 MiB, with table/object/count/path checks and
a 256 MiB decoded prop geometry limit. The Android document cache copies only
referenced meshes and images, with separate 256 MiB encoded mesh/image budgets.
GPU texture/storage limits are checked before allocating scene resources. These
are protective bounds, not measured Quest memory or performance targets.

The Windows title shows visible props, draw counts and GPU time. OpenXR logs a
frame sample every five seconds (`adb logcat -s OpenSlopeNative` on Quest), summing
submissions and render timings across both eyes. The reported render wall time
includes culling, command recording and the GPU fence wait. GPU time comes from
timestamp queries when supported, otherwise it is -1. These are samples, not
averages or whole-frame headset timing; device profiling remains necessary.

## Validation

Portable checks cover hierarchy, placement, model-local lighting, hidden objects,
shared geometry, animation snapshots, frustum/distance culling, path bounds and
corrupt packet cleanup. Production Vulkan pixel checks cover opaque alpha handling,
cutouts, translucency, HDR lighting and rotated placements on UNORM/sRGB targets.
The authored Android fixture includes shared models, visibility and mesh copying;
the test APK builds, but its instrumentation requires a connected device.

`tools/native/native-compare-props.py` reads generated files only. It checks counts, names,
visibility, material flags/texture references, hierarchy, transforms and animation
records; source locations, lighting and animation scalars must recover identical float32 bytes.
Expanded ordered triangles must preserve winding, UVs and normals. Position
tolerance is 0.001 raw cm, UV/normal tolerance 1e-6, and transform tolerances are
reported in the tool. Material labels and deferred behavior fields are excluded.
No retail fixtures or generated maps enter the APK or source control.

Local validation imported all eleven supported course archives. GARI's generated
output comparison passed for 648 models, 3,393 placements, 125 materials, 824
meshes and 32,590 triangles at the default position tolerance, with a maximum
position delta of 0.000800 raw cm. The other ten comparisons used an explicit
`--point-tolerance-cm 0.01` allowance (0.1 mm); their largest observed delta was
0.001000 raw cm (0.01 mm), at the default tolerance's floating-point boundary.
These decimal/rounding differences do not change UVs, normals, winding, recovered
source positions or baked lighting. Material and behavior exclusions still apply.
