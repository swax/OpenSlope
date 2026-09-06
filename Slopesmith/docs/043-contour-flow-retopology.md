# 043 — Contour-flow retopology

The Retopology toolbox offers two strategies in its **strategy** dropdown. **QuadWild** hands the unlocked
mountain to the native global cross-field solver (docs/045-retopology-benchmark.md). **Elevation loops** is
the built-in contour-flow sweep: pure TypeScript, no native install, `src/core/mesh/retopology/contour.ts`.
Both feed the same job pipeline — hole-mode preparation, the direct conforming join, bicubic surface fit,
and every validation gate — so a strategy choice changes only how the candidate cage is generated.

Run it from the editor (Edit ▸ Retopology ▸ strategy) or through the job API
(`options.strategy: 'contour-flow'`). `npx tsx test/contour-retopo.test.ts` exercises the generator on synthetic terrain
(cone, twin peaks with a col, a pit — each carrying a locked hole) and the whole job pipeline on a bicubic
mountain document.

## What it builds

The rows of the generated cage are edge loops along the terrain's **graded elevation lines**; the columns
flow up the gradient. The result reads as the hill's own contour map, in contrast to the survey lattice a
new mountain starts with.

1. **Raster.** The unlocked surface (tessellated past the control cage, so contours see the bicubic
   shape) is sampled to a height grid, with a chamfer distance field recording each node's clearance from
   every rim and locked hole.
2. **Grade.** The height grid is box-blurred at the cell scale. Its contours are the graded elevation
   lines — the hill's shape without every mogul's wiggle.
3. **Sweep.** Contour levels are scheduled so consecutive loops stand about one cell apart on the surface
   (the elevation step follows the mean gradient of the band being crossed, floored so a bench cannot
   demand unbounded loops). Marching squares extracts each level's curves, clipped to stand one knit ring
   off every boundary. Bands between consecutive levels mesh as ladders; kite rows (3/5-pole pairs)
   absorb vertex-count changes; peaks and pits cap with centre fans; loops that split or merge across a
   band compose into figure-eight cycles with a welded col pole. Chains chopped by holes knit into their
   hosts piecewise — a chain's footprint on its host comes from every vertex's projection, split wherever
   the projections jump, because a hooked chain faces its host's two ends with far ground between.
4. **Join.** Every boundary loop of the swept sheet knits to its region-boundary target with one cyclic
   ring of quads, paired by monotone arc-length buckets so heterogeneous rings knit to the geometry that
   actually faces them. Locked rims first receive an **intermediate ring** at the same vertex count — one
   rectangular strip quad per rim edge — so no kite ever wraps a feature corner; the count-absorbing
   kites land one ring out, on unlocked ground. Free rims (the mountain perimeter) resample at the cell
   size, keeping sharp corners.

The candidate is all quads. Parity is real: an all-quad patch fixes each boundary loop's edge-count parity,
so free rims pick matching counts and each odd locked rim costs the join one temporary triangle; triangles
then cancel in pairs by pushing through the quad sheet (triangle + neighbour = pentagon, re-split one face
along), the constructive equivalent of the parity routing QuadWild's BiMDF solve performs. Safety nets
catch the sweep's rough edges before they can reach the join: pinch vertices split into separate boundary
fans, small enclosed gaps cap shut, stray fragments (slivers the sweep could not hold together) are
removed for the join ring to pave, and any face draped over uncovered ground pulls itself out along the
clearance gradient — or fails the job loudly.

After integration the job chord-creases every generated edge that touches a locked rim vertex: under
Bessel tangents a first-row edge bows metres past its chord wherever the ring kinks (the trail flow
sheet's crease lesson), and a bowed first row reaches over the locked outline in top view.

## Choosing a strategy

- **Elevation loops** needs no native install and makes terrain whose edge flow follows the mountain
  itself — corduroy, moraines, and traversals read along contours. Cells stretch on benches and crowd on
  cliffs (contour spacing follows the band's mean gradient, not every local slope).
- **QuadWild** solves a global field that can also honor a trail-tangent guidance field, and is the only
  strategy for **selected-region** scope. It needs the patched native build
  (tools/retopology/quadwild-patches/README.md).

Both strategies require every locked feature rim to be a closed hole standing clear of other rims — a
strip of mountain narrower than about two and a half patches between two rims (or a rim and the mountain
edge) is the shared narrow-neck limitation; production trail generators must guarantee that separation.
`SLOPESMITH_CONTOUR_TRACE=1` adds per-band composition notes to a job's `contour-notes.log` for
diagnosing a sweep on new terrain.
