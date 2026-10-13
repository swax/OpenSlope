# Native source provenance

The implementation inputs are the clean Trailmap specification bodies, the Apache-2.0 shared
OpenSlope contracts and standard mathematical/protocol identities. Evidence annotations and
other components' implementation sources are outside this implementation boundary.

| Importer part | Implementation authority |
|---|---|
| Primary ISO9660 directory access | [Trailmap: 200-iso]; bounded, seekable document/file reads. |
| Archive table and compression | [Trailmap: 200-c0fb, 200-bigf, 200-refpack-header, 200-refpack-commands]. Format identifiers and byte-command equations are interoperability facts. |
| Terrain records and names | [Trailmap: 200-map-manifest, 220-header, 220-patch, 220-power-basis]; the public OpenSlope patch contract. |
| Basis conversion | Direct tensor transform using `t^k = sum(i=k..n) C(i,k)/C(n,k) B_i^n(t)` with `n=3`. Accumulation uses double precision and does not reproduce another decoder's staged float recurrence. |
| Texture/lightmap decoding | [Trailmap: 210-directory, 210-chunk, 210-longname, 210-palette, 210-swizzle, 210-alpha, 210-color, 210-lightmap-profile]. |
| PNG output | Standard PNG RGBA8, CRC-32, Adler-32 and stored DEFLATE blocks; no image-conversion dependency. |

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
