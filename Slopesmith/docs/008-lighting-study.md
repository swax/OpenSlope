# 008 — Lighting study

This page documents Slopesmith's reference-light fitting, authored-lighting UI,
and export bake. Canonical SSX lightmap encoding, GS blend, UV mapping,
per-instance object lights, normalization, and color domain live in
[Trailmap: 160-lighting-data, 400-rendering].

## Reference pipeline

`server/routes/levels.ts` exposes patch lightmap references and serves the PNG
assets. `app/main.ts` decodes the unique maps, and
`core/reference/terrain.ts` samples the canonical light intensity at reference
mesh vertices.

`core/lighting/lightmap.ts` fits a directional model to vertex normals and
sampled intensity by searching candidate sun directions, solving ambient and
diffuse weights, and refining the best direction. It separately fits color
channels so the UI can recover a useful sun and sky tint. The result reports
direction, colors, R², RMS, azimuth, and elevation.

The study optionally adds geometry-derived sun visibility and ambient
occlusion from `core/lighting/occlusion.ts`. `refitWithOcclusion` solves their
non-negative darkening weights at the fixed sun direction. These are analysis
features: the fit quality says how much of a reference bake the simple authored
model can explain; it does not redefine the original renderer.

## Reference views

**Scene > Lighting > Reference** provides:

- lightmap: decoded reference lighting;
- model: the current fitted directional/occlusion model;
- residual: signed model error; and
- cast-shadow and ambient-occlusion diagnostics.

**Use for my map** copies the fitted direction and colors into the authored
mountain. Shade mode controls whether lighting is shown alone, multiplied by
texture, or combined with surface/contact-class color.

Display-domain lighting is converted exactly once at the Three.js vertex-color
boundary by `core/lighting/color-space.ts`. The fit, report, export encoder, and
stored authored colors remain in their defined source domain. Tests should pin
this crossing because a duplicate conversion washes out saturated lighting.

The current reference view decodes light against a white diffuse base. That is
an acknowledged visualization approximation on dark, strongly colored tiles;
the export path below includes the actual diffuse sample.

## Prop surface-view diagnostics

Reference and authored props share `core/props/contact.ts` for surface-view
classification. Batching partitions by contact class so clay colors can expose
rideable, blocking, pass-through, and decorative placements without changing
their authored texture view.

`SURFACE_STYLE` must cover the readable source vocabulary even when a type is
not offered by an authoring menu. The legend groups entries by where Slopesmith
allows them to be authored. A graded, sun-relative backface tint uses stored
normals and remains camera-independent; this is an editor diagnostic, not an
SSX material flag.

## Authored lighting

**Scene > Lighting > _mountain_** and the top-bar light control edit sun
direction/color, sky color, ambient/sun/shadow/AO strengths, and presets. A
reference fit can seed those values. `computeModelColored` updates the smooth
viewport model while shadow/AO caches are keyed by geometry and sun direction.

This live model is the authoring preview. Its tunable parameters and presets
are Slopesmith policy, not recovered constants.

## Export bake

`core/lighting/bake.ts` samples the selected model into per-patch lightmap
tiles. It delegates the encoded channel math and UV convention to the canonical
Trail Map contract and includes each patch's diffuse base when constructing the
stored terms. Unity and PS2 consumers can therefore reconstruct texture times
light on snow, rock, ice, and painted tiles.

The **baked (in-game) view** round-trips through the same quantization and
decode, then composites the full-resolution diffuse tile. Use it to inspect
clipping and quantization, not to retune the source formula locally.

## Verification

- Compare fit and residual views on directional, canyon, and ambient-dominant
  references.
- Run the terrain light-space tests in both display and working color spaces.
- Confirm toggling shade modes does not change the underlying fit.
- Check per-instance prop contact colors and sun-relative tint through mirrors
  and negative instance scales.
- Round-trip authored lightmaps through Unity and PCSX2, including dark colored
  terrain where a white-base approximation is easiest to spot.
