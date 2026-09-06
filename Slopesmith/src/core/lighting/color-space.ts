/**
 * The colour-space boundary for a light buffer.
 *
 * Every light this folder produces is DISPLAY-domain. `computeModelColored` multiplies the sun / sky tints
 * straight out of their authored hex, and `decodeLightmapTexel` works on the lightmap's stored bytes — which
 * is right, because the GS blend those numbers reproduce ran on display bytes too (Trailmap: 400-rendering).
 * The Unity port converts around gamma for the same reason, and its own note says why: a linear-space blend
 * washes the lighting out ~2× (Unity docs/unity/007-terrain-lighting.md).
 *
 * Three does NOT colour-manage a vertex-colour attribute: `color_fragment` multiplies `vColor` raw in the
 * linear working space, and the renderer sRGB-encodes the result on output. So a display-domain light handed
 * to the colour attribute is encoded a SECOND time — brighter, flatter and desaturated, worst on the most
 * saturated light a level ships. Measured over MESA's 2448 patches, that cost 33% of the terrain's saturation
 * and pushed its warm ratio from R/B 1.65 to 1.28: the level's sun tint `#ff681e` drew as `#ffab60`, a deep
 * orange as pale peach. The tint tables next door (`SURFACE_STYLE`) already hold linear triples for exactly
 * this reason, so the light was the one term in the composite living in the wrong space.
 *
 * The light therefore crosses here, at the one boundary where it stops being data and becomes a colour
 * attribute — and only there. `groundLit` (what props sample their key from and what `bakeLightmaps` encodes),
 * the lightmap round-trip and the sun fit all keep the display domain they are defined in.
 *
 * The route is principled rather than tuned: `toLinear(C_D)·toLinear(L)` encodes back to `C_D·L`, so an
 * sRGB-sampled tile times a linearised light REPRODUCES the engine's gamma-space product. It does not equal
 * it — sRGB is piecewise, a linear toe under a shifted power curve, so the identity is only exact under the
 * pure power law — but the whole residual is ≤ ~3/255 (`test/terrain-light-space.test.ts` pins the bound),
 * against the whole tenths that encoding the light twice was costing.
 */

/** Three's own sRGB EOTF (`SRGBToLinear`), matched constant for constant so this is the exact inverse of the
 *  encode the renderer applies on output. */
export function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/**
 * `srgbToLinear` sampled over [0, 1], read back by linear interpolation below. A full relight runs the
 * conversion over every vertex — 198k on MESA's reference mesh, three channels each — and a `Math.pow` per
 * channel made that the most expensive step in a sun-slider drag, several times the lighting maths it was
 * converting (10.4 ms over that mesh). Interpolating a table takes it to 2.2 ms, for an error the curve
 * cannot make visible: the second
 * derivative peaks at ~3.0, so the interpolation error is bounded by `h²/8 · 3.0` ≈ 4e-7, four orders below
 * an 8-bit step. `terrain-light-space.test.ts` sweeps it rather than trusting the bound.
 */
const LUT_STEPS = 1024;
const LUT = /* @__PURE__ */ (() => {
  const table = new Float32Array(LUT_STEPS + 1); // +1 so the top interval has a right-hand sample
  for (let i = 0; i <= LUT_STEPS; i++) table[i] = srgbToLinear(i / LUT_STEPS);
  return table;
})();

/** Move a per-vertex display-domain light into three's linear working space, into a FRESH array: the source
 *  stays the light it was, so a caller can hand the same buffer to the bake and to the colour attribute. */
export function lightToWorkingSpace(display: Float32Array): Float32Array {
  const out = new Float32Array(display.length);
  for (let i = 0; i < display.length; i++) {
    const c = display[i];
    if (c > 0 && c < 1) {
      const t = c * LUT_STEPS, k = t | 0;
      out[i] = LUT[k] + (LUT[k + 1] - LUT[k]) * (t - k);
    } else {
      // The rails and anything outside the table's domain go through the exact curve. Light buffers are
      // clamped to 0..1 upstream, so this is the endpoints in practice — but a silent clamp on a caller that
      // one day hands in an HDR light would be a lie, and it costs one branch not to tell it.
      out[i] = srgbToLinear(c);
    }
  }
  return out;
}
