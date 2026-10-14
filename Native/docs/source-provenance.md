# Native source provenance

The implementation inputs are the clean Trailmap specification bodies, the Apache-2.0 shared
OpenSlope contracts and standard mathematical/protocol identities. Evidence annotations and
other components' implementation sources are outside this implementation boundary.

| Importer part | Implementation authority |
|---|---|
| Primary ISO9660 directory access | [Trailmap: 200-iso]; bounded, seekable document/file reads. |
| Automatic Audio import | Clean 190/200/260/270/420 bodies and the shared fixed-environment identifier contract; independently authored config matching, variable-stride ADL reads, serialized manifest-hash joins and bounded asset staging. All eleven generated courses/WAVs are comparison data only. Executable collision/board rows remain unresolved and are not compiled into the importer. |
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
| Playable prop contact | Clean chapters 130, 300, 320, 340 and 370; shared ground probes, continuous posed-volume sweeps, independent contact lifecycle and specified bounce/wipeout transition. Original limb profile, bounded solver and pending animation/world-logic behavior are explicit in world-contacts.md. |
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
