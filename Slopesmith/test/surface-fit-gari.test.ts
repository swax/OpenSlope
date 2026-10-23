// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { LoftDomain, V3 } from '../src/core/doc/types';
import { patchPoint } from '../src/core/math/bezier';
import { len, sub } from '../src/core/math/vec';
import { restrict, type Patch } from '../src/core/mesh/loft-surface';
import { fitSurface, surfaceFitTolerance } from '../src/core/mesh/surface-fit';
import { cellMetrics } from '../src/core/mesh/measure';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/surface-layout-gari.json', import.meta.url), 'utf8')) as {
  patchSizeM: number;
  us: number[];
  vs: number[];
  charts: Patch[];
};

function aspect(patch: Patch): number {
  const length = (axis: number) => {
    let distance = 0,
      previous = patchPoint(patch.controls, axis ? 0.5 : 0, axis ? 0 : 0.5);
    for (let k = 1; k <= 20; k++) {
      const point = patchPoint(patch.controls, axis ? 0.5 : k / 20, axis ? k / 20 : 0.5);
      distance += len(sub(point, previous));
      previous = point;
    }
    return distance;
  };
  const u = length(0),
    v = length(1);
  return Math.max(u, v) / Math.max(1e-9, Math.min(u, v));
}
function check(source: Patch[], output: ReturnType<typeof fitSurface>, target = fixture.patchSizeM) {
  let deviation = 0;
  for (const patch of output.patches)
    for (const original of source) {
      const d: LoftDomain = [
        Math.max(original.domain[0], patch.domain[0]),
        Math.min(original.domain[1], patch.domain[1]),
        Math.max(original.domain[2], patch.domain[2]),
        Math.min(original.domain[3], patch.domain[3]),
      ];
      if (d[1] - d[0] < 1e-9 || d[3] - d[2] < 1e-9) continue;
      const a = restrict(original.controls, original.domain, d),
        b = restrict(patch.controls, patch.domain, d);
      for (let i = 0; i < 16; i++) deviation = Math.max(deviation, len(sub(a[i], b[i])));
    }
  assert(deviation <= surfaceFitTolerance(target) + 1e-7, `whole-surface fitting bound: ${deviation}`);
  assert(Math.max(...output.patches.map(aspect)) < 3, 'the GARI layout must not contain long thin strips');
  const width = output.us.length - 1;
  output.patches.forEach((p, i) => {
    if (i % width !== width - 1)
      for (let j = 0; j < 4; j++) assert(len(sub(p.controls[12 + j], output.patches[i + 1].controls[j])) < 1e-7);
    if (i + width < output.patches.length)
      for (let j = 0; j < 4; j++)
        assert(len(sub(p.controls[j * 4 + 3], output.patches[i + width].controls[j * 4])) < 1e-7);
  });
}

const fitted = fitSurface(fixture.charts, fixture.patchSizeM);
check(fixture.charts, fitted);
assert(fitted.patches.length <= 80, 'fitting must use patch interiors instead of blindly decomposing the source quilt');
for (const axis of [0, 2] as const) {
  const stations = fixture.charts.flatMap(p => p.domain.slice(axis, axis + 2)).filter(t => t > 0 && t < 1),
    output = (axis === 0 ? fitted.us : fitted.vs).slice(1, -1);
  assert(
    output.some(t => !stations.some(s => Math.abs(s - t) < 1e-7)),
    'output spacing crosses source partitions; only useful fitting anchors are retained',
  );
}
const moved = fixture.charts.map(p => ({
  ...p,
  controls: p.controls.map(([x, y, z]): V3 => [x * 0.7, y + z * 0.3, z * 1.3]),
}));
const preview = fitSurface(moved, fixture.patchSizeM, fixture);
assert.equal(preview.us.length, fixture.us.length);
assert.equal(preview.vs.length, fixture.vs.length);
assert.notDeepEqual(preview.us, fixture.us, 'the drag preview redistributes old thin spans');
assert(Math.max(...preview.patches.map(aspect)) < 3);
check(moved, fitSurface(moved, fixture.patchSizeM));

// Merely splitting the exact source polynomial cannot force another output boundary.
const split = fixture.charts.flatMap(p =>
  p.domain[0] < 0.41 && p.domain[1] > 0.41
    ? [
        [p.domain[0], 0.41, p.domain[2], p.domain[3]],
        [0.41, p.domain[1], p.domain[2], p.domain[3]],
      ].map(domain => ({
        domain: domain as LoftDomain,
        controls: restrict(p.controls, p.domain, domain as LoftDomain),
      }))
    : [p],
);
const repartitioned = fitSurface(split, fixture.patchSizeM);
assert.equal(repartitioned.patches.length, fitted.patches.length);
assert(
  repartitioned.us.every((t, i) => Math.abs(t - fitted.us[i]) < 1e-8),
  'an exact source split cannot anchor or move an output cut',
);
assert(repartitioned.vs.every((t, i) => Math.abs(t - fitted.vs[i]) < 1e-8));
check(split, repartitioned);

// A later closed-boundary surface has smooth geometry but very uneven source parameter speeds.
// Pinning corner derivatives previously needed 224 patches (7 × 32) at a 20 m target, mostly 5 × 1.3 m.
const boundary = JSON.parse(
  readFileSync(new URL('./fixtures/surface-layout-gari-boundary.json', import.meta.url), 'utf8'),
) as { charts: Patch[]; patchSizeM: number };
const boundaryFit = fitSurface(boundary.charts, boundary.patchSizeM);
check(boundary.charts, boundaryFit, boundary.patchSizeM);
assert(boundaryFit.patches.length <= 12, 'fit span positions instead of oversampling source endpoint derivatives');
assert(Math.max(...boundaryFit.patches.map(aspect)) < 2.1, 'the boundary surface uses broad, regular patches');
const boundaryPreview = fitSurface(boundary.charts, boundary.patchSizeM, boundaryFit);
assert.equal(boundaryPreview.us.length, boundaryFit.us.length);
assert.equal(boundaryPreview.vs.length, boundaryFit.vs.length);
check(boundary.charts, boundaryPreview, boundary.patchSizeM);

// GARI Surface 2, after later boundary edits: a nearly flat 55,000 m² fill previously became 46 × 21
// patches averaging 4.8 × 13.8 m at a 20 m target. Parameter-speed changes must not shrink whole rows.
const flat = JSON.parse(readFileSync(new URL('./fixtures/surface-layout-gari-flat.json', import.meta.url), 'utf8')) as {
  charts: Patch[];
  patchSizeM: number;
};
const flatFit = fitSurface(flat.charts, flat.patchSizeM);
check(flat.charts, flatFit, flat.patchSizeM);
const dimensions = flatFit.patches.map(p => cellMetrics(p.controls));
const meanLength = dimensions.reduce((total, m) => total + m.length, 0) / dimensions.length,
  meanWidth = dimensions.reduce((total, m) => total + m.width, 0) / dimensions.length;
assert(flatFit.patches.length <= 200, 'a gentle fill uses target-sized patches instead of hundreds of thin strips');
for (const size of [meanLength, meanWidth])
  assert(size >= 16 && size <= 24, `average patch dimension ${size} should stay close to the 20 m target`);
assert(Math.max(...flatFit.patches.map(aspect)) < 2.5, 'the flat fill retains reasonably square patches');
console.log(
  `GARI SURFACE FIT: ${fitted.patches.length} profile patches, ${boundaryFit.patches.length} boundary patches, ${flatFit.patches.length} flat-fill patches averaging ${meanLength.toFixed(1)} × ${meanWidth.toFixed(1)} m; bounded error, watertight edges, redistribution during drags and source-partition independence passed.`,
);
