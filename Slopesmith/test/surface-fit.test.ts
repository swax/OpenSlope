// tier: fast
import assert from 'node:assert/strict';
import type { LoftDomain, V3 } from '../src/core/doc/types';
import { patchPoint } from '../src/core/math/bezier';
import { len, sub } from '../src/core/math/vec';
import { masterPatches, metricCuts, restrict, type Patch } from '../src/core/mesh/loft-surface';
import { fitSurface, surfaceFitTolerance } from '../src/core/mesh/surface-fit';

function hill(rows: number, height = (v: number) => 12 * Math.sin(Math.PI * v)): Patch[] {
  const profiles: V3[][] = Array.from({ length: rows }, (_, j) => {
    const v = j / (rows - 1),
      h = height(v);
    return [
      [0, 0, 45 * v],
      [20, h, 45 * v],
      [40, h, 45 * v],
      [60, 0, 45 * v],
    ];
  });
  return masterPatches(profiles, 1).flatMap(p =>
    Array.from({ length: 12 }, (_, i) => {
      const domain: LoftDomain = [i / 12, (i + 1) / 12, p.domain[2] / (rows - 1), p.domain[3] / (rows - 1)],
        normalized: LoftDomain = [0, 1, p.domain[2] / (rows - 1), p.domain[3] / (rows - 1)];
      return { domain, controls: restrict(p.controls, normalized, domain) };
    }),
  );
}

function checkFit(source: Patch[], fitted: ReturnType<typeof fitSurface>, target: number) {
  // Independently verify the conservative Bernstein bound on every overlapping source/output pair.
  let maxError = 0;
  for (const patch of fitted.patches)
    for (const original of source) {
      const d: LoftDomain = [
        Math.max(patch.domain[0], original.domain[0]),
        Math.min(patch.domain[1], original.domain[1]),
        Math.max(patch.domain[2], original.domain[2]),
        Math.min(patch.domain[3], original.domain[3]),
      ];
      if (d[1] - d[0] < 1e-9 || d[3] - d[2] < 1e-9) continue;
      const a = restrict(patch.controls, patch.domain, d),
        b = restrict(original.controls, original.domain, d);
      for (let i = 0; i < 16; i++) maxError = Math.max(maxError, len(sub(a[i], b[i])));
    }
  assert(maxError <= surfaceFitTolerance(target) + 1e-7, `fit error ${maxError}`);
  const width = fitted.us.length - 1;
  fitted.patches.forEach((p, i) => {
    if (i % width < width - 1)
      for (let j = 0; j < 4; j++)
        assert(len(sub(p.controls[12 + j], fitted.patches[i + 1].controls[j])) < 1e-7, 'U boundary is watertight');
    if (i + width < fitted.patches.length)
      for (let j = 0; j < 4; j++)
        assert(
          len(sub(p.controls[j * 4 + 3], fitted.patches[i + width].controls[j * 4])) < 1e-7,
          'V boundary is watertight',
        );
  });
}

{
  const source = hill(25),
    fitted = fitSurface(source, 15),
    forced = (metricCuts(source, 0, 15).length - 1) * (metricCuts(source, 2, 15).length - 1);
  checkFit(source, fitted, 15);
  assert(fitted.patches.length <= 25, 'a broad hill uses metre-scale patches, not one patch per source span');
  assert(fitted.patches.length < forced / 8, `${fitted.patches.length} fitted vs ${forced} source-aligned patches`);
  assert(
    fitted.patches.some(p => (p.domain[0] < 0.5 && p.domain[1] > 0.5) || (p.domain[2] < 0.5 && p.domain[3] > 0.5)),
  );
  assert(
    fitted.patches.some(p => Math.abs(p.controls[5][1] - p.controls[0][1]) > 0.1),
    'interior controls carry hill curvature',
  );
  const preview = fitSurface(
    hill(25, v => 18 * Math.sin(Math.PI * v)),
    15,
    fitted,
  );
  assert.equal(preview.us.length, fitted.us.length);
  assert.equal(preview.vs.length, fitted.vs.length);
  assert.notDeepEqual(
    preview.patches.map(p => p.domain),
    fitted.patches.map(p => p.domain),
    'drag preview redistributes spacing without changing grid dimensions',
  );
  const collapsed = fitSurface(
    source.map(p => ({ ...p, controls: p.controls.map((): V3 => [0, 0, 0]) })),
    15,
    fitted,
  );
  assert.equal(collapsed.patches.length, fitted.patches.length);
  assert(
    collapsed.patches.every(p => p.controls.every(point => point.every(Number.isFinite))),
    'a collapsed draft remains finite',
  );
}
{
  // A narrow summit falls between a coarse sampling grid. Whole-span error bounds must still find it.
  const source = hill(65, v => (v === 31 / 64 ? 9 : 0)),
    fitted = fitSurface(source, 100);
  checkFit(source, fitted, 100);
  assert(fitted.patches.length > 1, 'adaptive refinement retains a narrow source feature');
  const summit = source.find(p => p.domain[2] === 31 / 64)!;
  const expected = patchPoint(summit.controls, 0.5, 0);
  const u = (summit.domain[0] + summit.domain[1]) / 2,
    v = summit.domain[2],
    output = fitted.patches.find(p => u >= p.domain[0] && u <= p.domain[1] && v >= p.domain[2] && v <= p.domain[3])!;
  assert(
    len(
      sub(
        patchPoint(
          output.controls,
          (u - output.domain[0]) / (output.domain[1] - output.domain[0]),
          (v - output.domain[2]) / (output.domain[3] - output.domain[2]),
        ),
        expected,
      ),
    ) <= surfaceFitTolerance(100),
  );
}
{
  const source = hill(3);
  // Deliberately crease the middle row by flattening the incoming derivatives on one side.
  for (const patch of source.filter(p => p.domain[3] === 0.5))
    for (let i = 0; i < 4; i++) patch.controls[i * 4 + 2] = [...patch.controls[i * 4 + 3]];
  const fitted = fitSurface(source, 100);
  assert(fitted.vs.includes(0.5), 'a deliberate crease remains a patch boundary');
  checkFit(source, fitted, 100);
}
{
  // Target size is a preferred physical size, rather than a maximum that always rounds up subdivisions.
  const source: Patch[] = [
    {
      domain: [0, 1, 0, 1],
      controls: Array.from({ length: 16 }, (_, i): V3 => [(Math.floor(i / 4) * 21) / 3, 0, ((i % 4) * 22) / 3]),
    },
  ];
  const fitted = fitSurface(source, 20);
  assert.equal(fitted.patches.length, 1, 'a 21 × 22 m plane should stay one roughly 20 m patch');
  checkFit(source, fitted, 20);
}
console.log(
  'SURFACE FIT: sparse physical layout, sixteen-control fitting, whole-span error bounds, narrow details, watertight seams, creases and fixed drag layouts passed.',
);
