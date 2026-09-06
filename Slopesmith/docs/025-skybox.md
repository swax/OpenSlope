# 025 — Skybox

This page documents Slopesmith sky authoring, preview, export, and repack.
Canonical SSX ring geometry, panel UVs, source files, texture tiers, top-fill
color, and renderer behavior live in [Trailmap: 220-level-pbd,
400-rendering, 442-sky-color].

## Editor model

Slopesmith edits the wall panels as one horizon panorama while preserving the
target ring as the export authority. `core/sky/ring.ts` owns the portable ring
description and `core/sky/slice.ts` converts between its measured panels and
the panorama.

Panel spans come from Snowknife's `Skybox/Ring.json`. The editor uses a generic
authoring ring only when no extracted ring is available; it does not claim that
fallback reproduces a particular shipped mesh.

An imported image is normalized into the ring band and stored under
`assets/skies`. Roughly equirectangular inputs are reprojected; other aspect
ratios are treated as an existing band. The mountain document stores a small
reference (`level` or `custom`), `topColor`, and optional resolution tier rather
than embedding pixels.

## UI and preview

**Scene > Skybox > Reference** previews the loaded reference and can adopt it.
**Scene > Skybox > _mountain_** selects a donor or custom panorama, loads or
generates an image, edits the open-top fill, and chooses the custom resolution
tier.

The shared Preview card in Skybox and God Rays explicitly selects My mountain
or Reference. Elsewhere, the viewport chooses the nearest world with a
scale-aware dead band; Test mode locks presentation to the active ride target.
The skybox and god-ray preview layers remain independently switchable.

## Generated skies

`sky/sky-gen.ts` uses the existing texture-generation proxy and normal image-
upload path. The optional wrap blend is local post-processing; the optional
panorama model uses the queued API because it may take several minutes.

`calmTop` blends the panorama toward a uniform upper edge so the single-color
fill can meet the ring without a visible seam. Generation metadata records the
actual model endpoints, time, and reviewed policy references beside the image;
it does not store the prompt or API key.

These generation choices are Slopesmith features and do not extend the SSX sky
specification.

## Export contract

An authored sky writes:

```text
Skybox/Models.json, Materials.json, Meshes/
Skybox/Ring.json
Skybox/Textures/*.png
Skybox/Sky.json
```

A donor sky preserves the donor pages and ring assets. A custom sky is sliced
against the target's measured ring; its ground page is derived from the lower
panorama edge. A mountain with no selected sky writes no `Skybox` directory, so
repack leaves the target unchanged.

## ISO repack

`RepackService.InjectSkybox` handles two implementation paths:

- `map`: copy the donor sky PBD and SSH from its course archive without
  transcoding;
- `custom`: encode the authored pages into a new SSH bank while retaining the
  target ring geometry.

Unless disabled, repack applies `TopColor` to the target course's executable
override entry. `repack-many` accumulates those per-course edits before the
final image is published.

Custom pages use the hardware-compatible full-color encoding and therefore
have a larger VRAM/upload budget than paletted donor pages. The export preflight
prices the selected tier and warns on the high tier. The encoder also applies
the existing source brightness convention so hardware output matches the
editor preview; those format rules remain canonical in Trail Map/Snowknife.

## Verification

`npx tsx test/sky.test.ts` verifies measured panel coverage, seam placement,
panorama round trips, and both export shapes. Also inspect the rolled preview
for horizontal wrap, the top edge against `topColor`, donor byte preservation,
custom bank encoding, and multi-course color-table isolation.
