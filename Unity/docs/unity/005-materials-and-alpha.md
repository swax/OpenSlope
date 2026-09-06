# 005 — Materials and alpha

This page documents Unity material resolution and render-state mapping.
Canonical SSX material fields, alpha modes, blend/depth behavior, and texture
animation semantics live in [Trailmap: 170-materials, 410-texture-animation].
Animation realization is covered by [008 texture animation](../008-texture-animation.md).

## Portable inputs

The bundle manifest resolves each glTF material slot to a texture plus optional
flipbook, scroll, alpha-mode, glow, and sheet metadata. Terrain slots and prop
material ids are resolved upstream; Unity must not reinterpret a numeric slot
without its bundle context.

Slopesmith object-part suffixes are removed only for material lookup. Animated
segments may use the base slot, so the bundle enumerates material names from
written glTF nodes as well as compatibility OBJ inputs.

`TextureAlpha.overrides.json` is the explicit project-authoring override. It
wins over extracted or inferred modes.

## MaterialFactory

`Importer/Editor/MaterialFactory.cs` converts a manifest material record into a
cached Unity `Material`. The cache key includes texture, complete frame list,
scroll profile, lighting variant, alpha mode, and sheet state; keying by texture
alone would incorrectly merge distinct animated or depth-writing clients.

The factory selects these shader paths:

- opaque;
- cutout with a low hole clip and alpha-to-coverage;
- alpha blend with serialized blend factors;
- glow blend with a transparent-background clip; and
- blend sheet with depth writes disabled.

Closed blend geometry keeps depth writes so separate transparent objects do not
paint through it. Single-facing sheets disable depth writes so stacked layers
remain visible. Those choices come from the semantic bundle record, not a new
Unity pixel-only interpretation of SSX flags.

`Importer/Editor/AlphaClassifier.cs` remains a fallback for authored PNGs and
older bundles. It uses alpha distribution for cutout-versus-blend, a smooth
bright signature for glow, and the supplied sheet classification. Treat its
thresholds as OpenSlope heuristics, not format constants.

Material properties and keywords must be set before `CreateAsset`; otherwise a
domain reload can silently restore the default variant.

## Diagnostics

- Import logs list opaque, cutout, blend, glow, sheet, flipbook, and scroll
  classifications.
- Inspect stacked water/banner sheets from both sides for missing layers.
- Inspect closed translucent props for far-side bleed and cross-renderer sort
  artifacts.
- Verify cutout holes in Game view with and without MSAA.
- Reload the domain and confirm serialized keywords, render queue, blend
  factors, and depth-write state survive.
