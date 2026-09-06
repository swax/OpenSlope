// tier: fast

/**
 * Terrain light colour space (docs/008): the light term reaches the colour attribute in three's LINEAR
 * working space, so the viewport's `tile × light` lands where the engine's gamma-space GS blend lands.
 * Run: tsx test/terrain-light-space.test.ts
 *
 * Every light buffer in `core/lighting` is display-domain — `computeModelColored` multiplies the sun / sky
 * tints straight out of their authored hex, `decodeLightmapTexel` works on the lightmap's stored bytes — and
 * that is correct, because the GS blend those numbers reproduce ran on display bytes too ([Trailmap: 400]).
 * Three does not colour-manage a vertex-colour attribute: it multiplies `vColor` raw in the working space and
 * sRGB-encodes on output. Handing it the display-domain light encoded that light a second time.
 *
 * Three claims here, each pinned against a foreign authority rather than against our own arithmetic:
 *
 *  1. **The transfer function is three's**, cross-checked through `THREE.Color` — not a hand-copied curve
 *     that could drift from the encode the renderer actually applies.
 *  2. **The composite reproduces the engine.** `toLinear(C_D)·toLinear(L)` encodes back to `C_D·L`, so an
 *     sRGB-sampled tile times a linearised light equals the gamma-space product [Unity: 007] computes in
 *     `_LIGHTMAP_GS` — reproduced, not approximated.
 *  3. **The old path was measurably wrong**, in the direction the bug reported: brighter and desaturated.
 *     MESA's sun tint is the worst case a shipped level offers, so it is the one pinned.
 */
import * as THREE from 'three';
import { srgbToLinear, lightToWorkingSpace } from '../src/core/lighting/color-space';
import { decodeLightmapTexel } from '../src/core/lighting/bake';
import { check, failures } from './check';

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

/** What the renderer puts on screen for a working-space value: three's own working -> sRGB output encode. */
const scratch = new THREE.Color();
const toDisplay = (r: number, g: number, b: number): [number, number, number] => {
  scratch.setRGB(r, g, b).getRGB(scratch, THREE.SRGBColorSpace);
  return [scratch.r, scratch.g, scratch.b];
};
/** Saturation and warm ratio, the two the bug report named ("orange glow", "not as deep"). */
const sat = (c: readonly number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c, 1e-6);
const warm = (c: readonly number[]) => c[0] / Math.max(c[2], 1e-6);

console.log('== 1. the curve is three\'s own, not a copy that can drift from the renderer ==');
{
  // THREE.Color.setRGB(..., SRGBColorSpace) is the sRGB -> working conversion the renderer uses for a
  // managed colour. Ours has to agree with it channel for channel, or the terrain light is converted by a
  // curve the output encode will not undo.
  for (const v of [0, 0.01, 0.04044, 0.04046, 0.116, 0.4095, 0.5, 1]) {
    const three = scratch.setRGB(v, v, v, THREE.SRGBColorSpace).r;
    check(near(srgbToLinear(v), three, 1e-6), `srgbToLinear(${v}) = ${srgbToLinear(v).toFixed(6)} matches THREE`);
  }
  check(srgbToLinear(0) === 0 && near(srgbToLinear(1), 1, 1e-6), 'the endpoints are fixed, so nothing clips at either rail');
}

console.log('\n== 2. buffer conversion is elementwise and leaves the source alone ==');
{
  const light = new Float32Array([1, 0.4095, 0.116, 0.5, 0.5, 0.5]);
  const before = Float32Array.from(light);
  const work = lightToWorkingSpace(light);
  check(work !== light, 'a fresh array comes back — `groundLit` stays the bake\'s field, not a display buffer');
  check(light.every((v, i) => v === before[i]), 'the source buffer is untouched');
  check(work.length === light.length, 'length is preserved, so it still matches the vertex count');

  // The buffer path interpolates a table rather than calling Math.pow per channel (a full relight converts
  // ~600k channels). Sweep the whole domain against the exact curve rather than trusting the error bound —
  // an off-by-one in the table's indexing would still pass a handful of spot checks.
  let worst = 0, worstAt = 0;
  const sweep = new Float32Array(200_001).map((_, i) => i / 200_000);
  const swept = lightToWorkingSpace(sweep);
  for (let i = 0; i < sweep.length; i++) {
    const off = Math.abs(swept[i] - srgbToLinear(sweep[i]));
    if (off > worst) { worst = off; worstAt = sweep[i]; }
  }
  check(worst < 1e-5, `the table tracks the exact curve everywhere: worst ${worst.toExponential(1)} at `
    + `${worstAt.toFixed(4)} (an 8-bit step is 3.9e-3, so this is ~${Math.round(3.92e-3 / worst)}x below one)`);
  check(swept[0] === 0 && near(swept[swept.length - 1], 1, 1e-6), 'both rails stay exact');
  check(near(lightToWorkingSpace(new Float32Array([1.5]))[0], srgbToLinear(1.5), 1e-6),
    'and a value past the table\'s domain falls through to the exact curve rather than being clamped');
}

console.log('\n== 3. tile x light reproduces the engine\'s gamma-space product ==');
{
  // The claim that makes this the RIGHT fix rather than a lucky one: toLinear(C_D)*toLinear(L) encodes back
  // to C_D*L, so the viewport's linear multiply of an sRGB-sampled tile by a linearised light IS the product
  // [Unity: 007] does in gamma space. It reproduces it rather than equalling it: sRGB is piecewise, a linear
  // toe under a shifted power curve, so f(a)*f(b) = f(ab) only under the pure power law. The residual is
  // bounded well inside an 8-bit step's visibility — the tolerance below is that bound, measured, and it is
  // the whole error budget of the route. Encoding the light TWICE, by contrast, costs whole tenths (§5).
  const cases: Array<[number, number]> = [[0.9, 0.8], [0.685, 0.35], [0.343, 0.62], [0.25, 1], [1, 0.05]];
  for (const [cd, l] of cases) {
    const [shown] = toDisplay(srgbToLinear(cd) * srgbToLinear(l), 0, 0);
    const off = Math.abs(shown - cd * l);
    check(off <= 0.015, `C_D ${cd} x light ${l} draws as ${shown.toFixed(4)} (engine ${(cd * l).toFixed(4)}, `
      + `off by ${(off * 255).toFixed(1)}/255)`);
  }
}

console.log('\n== 4. a MESA lightmap texel over a snow tile lands on the Unity shader\'s result ==');
{
  // One texel of MESA's baked page, decoded the way the reference view decodes it, then composited over a
  // patch's terrain tile. Unity's _LIGHTMAP_GS computes saturate((C_D*_LmBaseScale - C_S)*(A_S*_LmAsScale))
  // in gamma space; we have to arrive at the same pixel by a different route.
  const [r8, g8, b8, a8] = [0, 14, 23, 196];       // R residual ~0: red is the peak channel, a warm sun
  const k = a8 / 128;
  const unityPixel = (cd: readonly number[]) =>
    cd.map((c, i) => Math.min(1, Math.max(0, (0.5 * c - [r8, g8, b8][i] / 255) * k)));
  const shownPixel = (cd: readonly number[]) => {
    const work = lightToWorkingSpace(Float32Array.from(decodeLightmapTexel(r8, g8, b8, a8))); // white-base decode
    return toDisplay(srgbToLinear(cd[0]) * work[0], srgbToLinear(cd[1]) * work[1], srgbToLinear(cd[2]) * work[2]);
  };

  const snow = [0.873, 0.908, 0.920];              // MESA's snow tile (0051.png), measured mean
  const shown = shownPixel(snow), unity = unityPixel(snow);
  check(shown.every((v, i) => near(v, unity[i], 0.02)),
    `snow texel draws [${shown.map(v => v.toFixed(3)).join(' ')}] vs Unity [${unity.map(v => v.toFixed(3)).join(' ')}]`);
  check(near(warm(shown), warm(unity), 0.05),
    `and carries the same warmth: R/B ${warm(shown).toFixed(2)} vs ${warm(unity).toFixed(2)}`);

  // The OUTSTANDING gap, pinned so it stays visible rather than being rediscovered. The reference view
  // decodes with a white diffuse base (`decodeLightmapTexel` with no C_D), but a retail C_S has the patch's
  // own texture baked into it — so the decode adds a neutral wash of (1 - C_D), and the wash is worst where
  // the tile is darkest. Snow above is why it goes unnoticed; MESA is ~40% dark orange rock, which is why it
  // does not. Folding each patch's C_D into the decode is the second pass; when it lands, this check is what
  // should change.
  const rock = [0.685, 0.477, 0.343];              // MESA's orange rock tile (0054.png), measured mean
  const dark = shownPixel(rock), darkUnity = unityPixel(rock);
  check(warm(dark) < warm(darkUnity) - 0.5,
    `KNOWN GAP — over dark rock the white-base decode is still short of the engine's warmth: `
    + `R/B ${warm(dark).toFixed(2)} vs ${warm(darkUnity).toFixed(2)}`);
}

console.log('\n== 5. the regression this fixes: the display-domain light drew washed out ==');
{
  // MESA's Lights.json type-0 record normalises to #ff681e. Encoded twice it drew as a pale peach — this is
  // the failure the bug reported, so it is the one pinned. If the conversion is ever dropped, these flip.
  const tint: [number, number, number] = [1, 0.4095, 0.116];
  const wrong = toDisplay(...tint);                                  // treated as linear, encoded on output
  const right = toDisplay(...(lightToWorkingSpace(Float32Array.from(tint)) as unknown as [number, number, number]));
  const hex = (c: readonly number[]) => '#' + [...c].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

  check(hex(right) === '#ff681e', `the fixed path draws the authored tint back exactly (${hex(right)})`);
  check(hex(wrong) === '#ffab60', `the old path drew it as a pale peach (${hex(wrong)})`);
  check(sat(wrong) < sat(right) - 0.2,
    `saturation was lost, not just brightness: ${sat(wrong).toFixed(3)} -> ${sat(right).toFixed(3)}`);
  check(warm(wrong) < warm(right),
    `and the warm ratio with it: R/B ${warm(wrong).toFixed(2)} -> ${warm(right).toFixed(2)}`);
  check(wrong[1] > right[1] && wrong[2] > right[2],
    'the wash was the shadow channels riding up, which is why contrast flattened too');
}

console.log(failures ? `\n${failures} FAILED` : '\nall terrain light-space checks passed');
process.exit(failures ? 1 : 0);
