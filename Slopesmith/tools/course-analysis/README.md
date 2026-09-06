# Course analysis

`metrics.mjs` parses retail AIP race lines and applies the same resampling, curvature, grade, and corridor
measurements to retail and authored routes. Course-specific renderers import it and retain ownership of their
layout and visual design.

Retail data defaults to `temp/patch-trailer-retail/` at the OpenSlope root, a local extraction from your own disc
(nothing under `temp/` is tracked or distributed). Set `SLOPESMITH_RETAIL_ROOT` to use another extraction.
