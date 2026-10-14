# Terrain textures and baked lightmaps

The renderer consumes the same course directory as the importer and custom-map library:
`Patches.json`, `Textures/<TexturePath>`, and `Lightmaps/<LightmapID padded to four digits>.png`.
Raw positions convert to Y-up metres with `(x,z,-y)/100`, preserving course turns; the coordinate
paragraph discrepancy is recorded in [specification alignment](spec-alignment.md).
PNG rows remain top-down. The map's stored UVs select orientation, repetition and mirroring;
the loader does not apply a global V flip. Filenames must be single safe basenames, and images
must resolve inside the course directory, including after resolving filesystem links.

## Specification mapping

The clean Trailmap chapter bodies supply these terrain rules:

| Input | Rule |
|---|---|
| Diffuse UV corners | `[110-uv-rotation]`: stored UV1/UV2/UV3/UV4 pair with geometry `(0,0)/(1,0)/(0,1)/(1,1)`. Evaluate bilinearly on each tessellated patch. |
| Lightmap tile | `[160-tile, 160-transpose]`: page UV is `rect.xy + (v,u) * rect.zw`, independent of the diffuse UVs. |
| Lighting | `[160-luminance, 400-lighting]`: retain the page's RGB residual and alpha intensity; compute `clamp((base.rgb - lightmap.rgb) * lightmap.a, 0, 1)` using normalized portable PNG values. Static terrain has no extra Lambert shading. |
| Colour conversion | `[210-color, 400-double]`: shared diffuse PNGs already include the exporter's colour doubling. Apply it once at extraction, with no second brighten at rendering. Lightmaps remain raw RGBA. |

Both sampled image types use RGBA8 UNORM, keeping residual subtraction in the exported byte
domain. When OpenXR selects an sRGB output format, the fragment shader converts the final display
colour to linear so the attachment's sRGB encoding applies exactly once. UNORM output uses the
display colour directly. PNG gamma metadata does not change these map values.

Diffuse sampling is linear and repeats. Lightmap sampling is linear and clamps to the tile's
texel centres, rather than just the page's edges. That last clamp is an application sampling
policy to prevent neighbouring tiles bleeding into a patch on pages with no gutters. It retains
the specified tile origin, size and axis swap. There are no mip levels or anisotropic filtering
in this first implementation; headset image quality and frame cost still need profiling.

## Loading and ownership

Only referenced PNGs are decoded. The portable loader accepts standard PNG variants and produces
RGBA8 through pinned LodePNG. Limits are 4096 pixels per axis, 64 MiB per file/decoded image,
and 256 MiB of decoded images per course. Android's document play cache also caps encoded image
copies at 64 MiB each and 256 MiB total. A present corrupt image fails validation; an absent
diffuse image uses surface/normal colours, while an absent lightmap leaves the diffuse image visible.
An empty/default lightmap rectangle has no lighting page. A fully transparent diffuse texel is
discarded; remaining terrain is opaque. Static prop materials have a separate
[rendering path](static-props.md), including opaque, cutout and provisional alpha blending.

The Vulkan scene owns geometry, sampled images, samplers and per-material descriptors. Both
OpenXR eye renderers retain the same scene, so the map is decoded and uploaded once. Draws group
patches by diffuse filename and lightmap page. Target resize recreates render targets and pipelines
without uploading the scene again. Resource destruction waits for GPU completion; rendering
remains serialized between eyes in this prototype.

Folder providers supply opaque document URIs. The launcher copies terrain into a fresh private
cache, asks C++ for its unique asset references, and copies only those files from `Textures/`,
`Lightmaps/` and optional prop `Meshes/` contracts. Native validates the prepared terrain,
props and images before launching the immersive activity.
Direct app-storage maps load in place. Custom maps use this path without selecting an ISO.

## Validation

Diffuse terrain/prop images now carry a complete mip chain with trilinear
minification. CPU area averages include odd-sized edges and weight straight-alpha
colour by coverage, avoiding transparent-colour fringes. Filtering stays in the
exported byte domain; this is an image-quality policy, not a claim to reproduce
the original hardware's texture filter. The same uploaded chain serves both eyes.
Lightmap atlases retain base-level sampling to prevent unrelated patch tiles
bleeding into each other. GPU sampled-image allocations, including driver padding,
are capped at 512 MiB; the existing 256 MiB decoded base-image budget remains.
Anisotropic filtering, mask coverage preservation, atlas-safe lightmap mips,
terrain LOD/stitching and upload batching remain outstanding. Hierarchical frustum
selection and adaptive index submission are now supported; see terrain-culling.md. Desktop geometric MSAA
is now supported; see graphics-quality.md for its evidence and remaining limits.

Portable fixtures cover odd/rectangular reductions, alpha fringes and invalid
storage. Actual Vulkan captures minify a high-frequency checker to its area mean
on UNORM/sRGB targets while retaining existing orientation, atlas-edge and prop
alpha assertions.

Portable checks cover diffuse corner binding, negative/repeating/mirrored UVs, asymmetric
transposed tiles, draw grouping, RGB-residual/alpha intensity, PNG palette/transparency/interlace
and metadata handling, invalid PNGs, missing files and path traversal.

`openslope_render_tests` runs the production shaders and image upload path on a Vulkan GPU.
Authored fixtures assert exact orientation, repeated/negative coordinates, residual colours,
independent alpha intensity, clipping of negative results, and tile-edge samples beside hostile
neighbouring tiles. Two renderers share each scene; every assertion runs against UNORM and sRGB
attachments with a one-byte tolerance. Invoke it with the fixture generator described in README.
An asymmetric raw-coordinate fixture additionally uses the production view/projection matrices
to distinguish screen left from right; unlike the UV fixtures it does not invert the loader's mapping.
The device-test APK additionally checks referenced-image copies and cancelled cache cleanup.
Those device tests require a connected headset; a successful cross-build is not a device run.
