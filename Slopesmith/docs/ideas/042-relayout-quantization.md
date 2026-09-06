# 042 — Whole-mountain relayout with owned quantization

The design in two lines: **keep the global relayout that produced the accepted MOUNTAIN01_2 result — flowing
field, coarse patch layout, exact locked reinsertion — and take ownership of its final stage, quantization**,
so that every locked-feature seam is conforming **by construction** and patch density is a controlled gradient
instead of a uniform constant. No transition collars, no T-nodes, no seam repair: those exist only to survive
a mismatched join, and the mismatch is what this design deletes.

## What the accepted result actually proved

The `045` "secret sauce" solve is the quality bar: whole-surface resolution-1 proxy, the exact trail loop as a
hard feature, QuadWild's automatic field, cut and reinsert the exact locked patches. Its patches flow with the
terrain, aspect stayed at 1.25 median / 2.00 p95, and the trail joined without a collar or T-node — because
"the accepted solve happens to expose 60 candidate hole edges for 60 protected edges." *Happens to.* The join
quality was luck in the quantizer, and every path added since — T-node embedding, transition collars, the
boundary-constrained retry, crossing repair, seam conforming — is compensation for solves where the counts did
not land. Collar-preserving and grid-preserving alternatives were both inspected and judged worse: a retained
grid collar concentrates distortion at the seam, and a straight grid cannot follow hills and valleys — edge
flow has to come from a global relayout aware of the locked patches and the whole mountain's geometry.

QuadWild-BiMDF is three stages: (1) uniform-density feature-preserving remesh, (2) cross-field + tracing that
decomposes the surface into a coarse patch layout, (3) `quad_from_patches` — an integer optimization choosing
a subdivision count for every layout arc, then filling each patch from templates. Stages 1–2 are where the
flow quality lives and are kept as-is. Stage 3 is where counts are chosen, and it currently knows nothing
about the authored trail's 40 corners. The stage-3 intermediates are plain text we already retain per job
(`input_rem_p0.obj`, `.patch` = per-triangle patch id, `.corners` = per-patch corner vertices, `.feature` /
`.c_feature` = feature chains): the MOUNTAIN01_4 solve is a 16-patch layout. Quantization over a layout that
size is a small, transparent problem — the part of QuadWild worth owning.

## Design

Replace `quad_from_patches` with a SlopeSmith quantizer + filler over the traced layout:

1. **Prescribed seams.** Every locked-feature boundary loop's arcs receive counts that sum exactly to the
   authored corner count (60 on MOUNTAIN01_2, 40 on MOUNTAIN01_4), distributed along the loop by arc length
   against the trail's own corner spacing. The candidate hole then has exactly one boundary vertex per
   protected corner, sitting on the feature-preserved trail polyline: the join is a rotation-only cyclic
   alignment plus a small snap — the accepted solve's "lucky" join, made deterministic. The direct-join,
   footprint, inversion, and deviation gates are unchanged; the collar, wedge, and T-node machinery is never
   entered by a new solve.
2. **Graded density.** Each layout arc's target count comes from a sizing field sampled along it, not a single
   global scale: pinned fine spacing at locked seams (the trail's own corner spacing), relaxing to the
   requested target size away from features. This is the "high density flowing smoothly into low density"
   requirement stated directly in the objective — a 50 m mountain target coexists with a 13 m trail seam
   because the gradient between them is what the quantizer optimizes, with a bounded ratio between adjacent
   counts so the transition never jumps.
3. **Texture-friendly regularity.** The objective keeps opposite sides of each layout patch equal where
   possible (tensor fill), penalizes count choices that skew a patch away from its geometric aspect, and
   charges deviations from the sizing field symmetrically — similar length/width cells are the optimum, not
   an accident. Mismatched sides fill through the standard singularity templates, so poles stay at layout
   corners where the field put them, not scattered.
4. **Hole mode always.** The locked feature is a real hole in the proxy for every solve, first or repeat —
   prescribed counts remove the reason the internal-guide path existed, and a hole cannot bridge a hairpin's
   parallel banks. Repeat solves become identical to first solves; the boundary-constrained retry ladder is
   retired for new jobs.
5. **Everything downstream is reused.** Exact locked reinsertion, vertical bicubic seating with shared Bessel
   edges and zero-twist Ferguson interiors, upward-winding enforcement, paint/texture transfer, and the full
   validation gate suite run unchanged.

Two implementation routes for the same contract, chosen by a short spike (M0):

- **Route A — constrain the existing solver.** Patch `quad_from_patches` (the checkout is already built from
  source) to accept fixed counts on named feature arcs and per-arc targets. Smallest diff to first result;
  keeps its mature template filler; leaves density gradation limited to what its objective admits.
- **Route B — own stage 3 in TypeScript.** Parse `.patch`/`.corners`, quantize with a chain-structured DP /
  small branch-and-bound (16-patch layouts need no ILP library), fill with tensor + standard singularity
  templates, smooth with the existing relax. More work up front; full control of the objective, no native
  dependency beyond stages 1–2, and the natural home for the sizing field.

Route B is the destination either way; Route A is acceptable as M1 scaffolding if the spike shows the BiMDF
formulation takes boundary constraints cleanly.

## Acceptance

- **MOUNTAIN01_2 at 25 m** reproduces the accepted result's quality with the luck removed: a conforming
  60-to-60 join by construction, aspect ≤ 1.25 median / 2.00 p95, zero T-junctions, zero inversions, scored
  side-by-side against the retained `quad_from_patches` candidates with `tools/retopology/benchmark.ts
  score`.
- **MOUNTAIN01_4 at 25 m and 50 m**: conforming 40-to-40 join, hairpin clean under hole mode, zero collars,
  zero T-junctions, all normals up; generated sizes within ±20 % of the sizing field at p95; adjacent-patch
  size ratio ≤ 1.3 across the density gradient; cross-field alignment near the trail no worse than the
  automatic-field baseline.
- Every gate in the current job pipeline still passes; the retail maps' patch-size and pole distributions
  remain the reference for what "texture friendly" means.

## Milestones

1. **M0 — spike.** Parse `.patch`/`.corners` from a kept job, reconstruct the layout graph, and re-derive the
   counts `quad_from_patches` chose (proving the format is understood). Assess the BiMDF boundary-constraint
   patch. Pick the route.
2. **M1 — prescribed seams.** Uniform sizing plus exact loop counts; MOUNTAIN01_2 conforming-join
   reproduction and A/B score.
3. **M2 — hole-mode hairpin.** MOUNTAIN01_4 at 25 m and 50 m; retire the boundary-constrained retry for new
   solves.
4. **M3 — sizing field.** Feature-pinned graded density, the adjacent-ratio gate, and the ±20 % size gate.
5. **M4 — product wiring.** The quantizer behind the same job contract, queue, snapshot, and Apply path;
   `quad_from_patches` retained as an A/B baseline in the benchmark harness only.

## Open questions

- Per-arc prescription versus loop-total-with-free-phase: pinning each arc by trail arc length is simpler and
  probably right, but a hairpin apex may want counts biased toward the tight bank.
- Which singularity template set the filler needs — terrain layouts are quad-dominant, but the traced layout
  can contain 3- and 5-sided patches; enumerate from retained `.corners` files before committing to Route B.
- Sizing-field authorship: automatic (distance-to-feature falloff from the trail spacing to the target) first;
  painted density as a later editor feature if automatic gradients prove insufficient.
- Whether stage-1/2 remains the native QuadWild prepare forever or is eventually also reduced; nothing in this
  design depends on answering that now.
