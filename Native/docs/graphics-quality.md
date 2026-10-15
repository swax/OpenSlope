# Native graphics quality

Build 0.56 uses reversed D32 depth for distant layered surfaces and enables up
to 4x diffuse anisotropic filtering when supported. Sky and lightmap samplers
retain their own filtering. See `merquer-playtest-0.56.md` for the millimetre-gap
GPU regression, all-scene checks and remaining worn-appearance verification.

Windows window/capture rendering defaults to four samples per pixel. The desktop
`--msaa 1|2|4|8` option requests a count; the renderer selects the highest count
at or below it supported by both the colour format and D32 depth format, also
respecting framebuffer sample limits. Capture logs report the actual count.
Invalid counts and explicit MSAA options combined with `--xr` are rejected.

Each multisample target owns colour and depth attachments. The render pass
resolves colour to the existing single-sample capture/swapchain image before
its normal transfer/presentation transition. Pipeline sample counts match the
attachments. Single-sample mode retains its two-attachment path. Recreating
targets releases the owned images/views/memory while retaining shared scene
textures and geometry. This policy uses standard Vulkan rasterization and is
an application image-quality improvement, not original-hardware emulation.

OpenXR defaults to 4x MSAA while retaining single-sample runtime swapchain images;
the renderer resolves into them. The Quest launcher persists independent eye-size
and edge-smoothing choices: 100/125/150% and Off/2x/4x. The size multiplier applies
to both recommended dimensions, bounded by the runtime's maximum. At 125% this
means 56.25% more pixels, not 25%. The connected Quest 3 reports 1680x1760 per eye
at 100%, and accepts 2100x2200 at 125%. Recommended size is distinct from physical
panel resolution; see [Meta render scale](https://developers.meta.com/vr/documentation/native/android/os-render-scale/).
MSAA increases colour/depth memory and fill cost. Other headsets and longer rides
still need quality, comfort and performance validation.

Android Debug builds retain debug symbols and installability but compile native
code with `-O2`. The generated compilation database confirms optimization for all
39 native translation units. Desktop release compilation remains unchanged.

The XR renderer queues each eye's GPU work without waiting for it at submission.
It waits before reusing that renderer's command buffer, visible indices, placements
or dynamic geometry. Placements now live in a renderer-local storage buffer and
descriptor set; immutable scene textures/geometry remain shared. This matters when
each eye compacts a different prop list. Captures and desktop presentation retain
synchronous completion. OpenXR permits releasing an image after its referencing
commands are submitted; see the [Vulkan synchronization contract](https://registry.khronos.org/OpenXR/specs/1.1/man/html/XR_KHR_vulkan_enable-concurrency.html).

Five-second logs report rendered FPS, predicted display Hz, focus, actual eye
dimensions/MSAA and average wait-frame, simulation, tracking/avatar, image-wait,
render-submit, resource-wait and end-frame times. GPU timestamps refer to each
eye's previous completed submission. Non-rendered/session-idle periods reset the
sample window. Runtime/compositor FPS for an idle app is not gameplay evidence.

The original 0.20.0 Quest 3 ALASKA session reports 31–36 app fps against 72 Hz,
despite roughly 3–6 ms of GPU rendering for both eyes. The optimized/queued 0.21.0
build records four focused five-second samples at 71.5/72.0/72.0/72.0 fps, with
1680x1760, 4x MSAA and mounting/riding. Full-body tracking and actual high fidelity
are observed, with procedural fallback when tracking becomes unavailable.
Resource waits average 0.02–0.09 ms and both-eye GPU time 4.41–6.40 ms. The user
reports the result is much better. This is a live-session comparison of the
combined changes, not a controlled replay attributing gains to individual fixes
or a worst-case full-course performance guarantee.

Diffuse terrain/prop mipmaps and trilinear minification remain enabled. Lightmap
atlas filtering retains the existing patch boundary policy. MSAA smooths geometric
edges; shader-discarded cutout edges still need coverage preservation or another
anti-aliasing policy. Anisotropy, atlas-safe lightmap mips, terrain LOD/stitching
and full memory profiling remain outstanding.

Terrain frustum selection and adaptive submission are now implemented; see
terrain-culling.md for all-course equivalence and measurement limits.

Actual Vulkan tests cover UNORM/sRGB at 1x and requested 4x, with 1,130 assertions
for textures, lightmaps, transparency, minification, diagonal-edge coverage and
queued stereo placement isolation, plus 52 avatar/label/stereo checks.
Diagonal edges produce partial pixel coverage only in multisample mode. Target
recreation and reuse of pending renderer resources are exercised. All 17 portable
suites pass. Earlier desktop swapchain, collision replay and audio capture evidence
is retained in the corresponding feature documents.
Matched local GARI captures report actual 1x/4x with identical visible prop/draw
counts. These captures are rendering evidence, not a complete performance baseline.
The Quest APK/test APK build, Android lint reports zero errors/four existing warnings,
and package signatures verify. The full objective remains tracked in desktop-parity.md.
