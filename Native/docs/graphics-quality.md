# Native graphics quality

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

OpenXR keeps its existing single-sample targets and swapchain contract. The
shared renderer's multisample path cross-builds for Quest, but headset quality,
comfort, controller behavior and performance require hardware validation.
MSAA increases colour/depth attachment memory and fill cost; it does not remove
the serialized GPU waits or establish a headset frame-rate budget.

Diffuse terrain/prop mipmaps and trilinear minification remain enabled. Lightmap
atlas filtering retains the existing patch boundary policy. MSAA smooths geometric
edges; shader-discarded cutout edges still need coverage preservation or another
anti-aliasing policy. Anisotropy, atlas-safe lightmap mips, terrain LOD/stitching,
configurable quality UI and full frame/memory profiling remain outstanding.

Terrain frustum selection and adaptive submission are now implemented; see
terrain-culling.md for all-course equivalence and measurement limits.

Actual Vulkan tests cover UNORM/sRGB at 1x and requested 4x, with 628 assertions
for textures, lightmaps, transparency, minification and diagonal-edge coverage.
Diagonal edges produce partial pixel coverage only in multisample mode. Target
recreation is exercised. Eleven portable tests, the desktop swapchain smoke,
four rendered collision replays and gameplay-triggered audio captures pass.
Matched local GARI captures report actual 1x/4x with identical visible prop/draw
counts. These captures are rendering evidence, not a complete performance baseline.
Quest APK/test-APK compilation and signature validation do not establish device
behavior. The full objective remains tracked in desktop-parity.md.
