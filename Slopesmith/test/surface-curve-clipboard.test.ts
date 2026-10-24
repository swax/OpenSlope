// tier: fast
import assert from 'node:assert/strict';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { createSurfaceFromProfiles, placeSurfaceGuide } from '../src/core/mesh/surface-object';
import { copySurfaceCurve, pasteSurfaceCurve, positionedSurfaceCurve } from '../src/core/mesh/surface-curve-clipboard';
import { curveAt, guideCharts, readGuideCurves } from '../src/core/mesh/surface-guides';
import type { V3 } from '../src/core/doc/types';

function fixture(width = 40) {
  const doc = blankMountain('CURVE_COPY');
  for (let r = 0; r < 3; r++)
    for (let s = 0; s < 3; s++) doc.vertices.push(r * 30, r === 1 && s === 1 ? 8 : 0, (s * width) / 2);
  Object.assign(doc, appendMeshIds(doc, 9, 0));
  doc.freeEdges = [0, 3, 6].flatMap(
    i =>
      [
        [i, i + 1],
        [i + 1, i + 2],
      ] as [number, number][],
  );
  const result = createSurfaceFromProfiles(
    doc,
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    { patchSizeM: 15 },
  );
  assert(result.ok, result.ok ? '' : result.error);
  return result;
}
const near = (a: V3, b: V3) => assert(Math.hypot(...a.map((x, i) => x - b[i])) < 1e-6, `${a} != ${b}`);
const source = fixture(),
  before = structuredClone(source.doc);
const clipboard = copySurfaceCurve(source.doc, source.surface, 1),
  copied = structuredClone(clipboard);
const preview = positionedSurfaceCurve(clipboard, guideCharts(source.doc, source.surface), 'U', 0.75);
near(curveAt(preview, 0.5), [45, 8, 20]);
const pasted = pasteSurfaceCurve(source.doc, source.surface, clipboard, 'U', 0.75);
assert(pasted.ok, pasted.ok ? '' : pasted.error);
const curve = readGuideCurves(pasted.doc, pasted.surface).at(-1)!;
for (let i = 0; i <= 32; i++) near(curveAt(curve, i / 32), curveAt(preview, i / 32));
assert.deepEqual(source.doc, before, 'copy, preview and paste leave their input document unchanged');
assert.deepEqual(clipboard, copied, 'clipboard owns a stable snapshot');
assert(
  !pasted.surface.seed && !pasted.surface.guides!.some(g => g.reference),
  'the pasted profile is visible source geometry',
);
assert(!pasteSurfaceCurve(pasted.doc, pasted.surface, clipboard, 'U', 0.75).ok, 'an occupied station is rejected');

const cross = placeSurfaceGuide(source.doc, source.surface, 'V', 0.4);
assert(cross.ok, cross.ok ? '' : cross.error);
const crossing = pasteSurfaceCurve(cross.doc, cross.surface, clipboard, 'U', 0.75);
assert(crossing.ok, crossing.ok ? '' : crossing.error);
const g = crossing.surface.guides!.length - 1,
  perpendicular = crossing.surface.guides!.findIndex(g => g.axis === 'V');
const p = crossing.surface.guides![g].knots.findIndex(t => Math.abs(t - 0.4) < 1e-8);
const q = crossing.surface.guides![perpendicular].knots.findIndex(t => Math.abs(t - 0.75) < 1e-8);
assert.equal(
  crossing.surface.controls[g][p],
  crossing.surface.controls[perpendicular][q],
  'crossings share a real control point',
);
for (let i = 0; i <= 32; i++)
  near(curveAt(readGuideCurves(crossing.doc, crossing.surface)[g], i / 32), curveAt(preview, i / 32));
assert.doesNotThrow(() => guideCharts(crossing.doc, crossing.surface), 'all copied crossings remain consistent');

const wide = fixture(80),
  transferred = pasteSurfaceCurve(wide.doc, wide.surface, clipboard, 'U', 0.25);
assert(transferred.ok, transferred.ok ? '' : transferred.error);
near(curveAt(readGuideCurves(transferred.doc, transferred.surface).at(-1)!, 0.5), [15, 8, 40]);
console.log(
  'SURFACE CURVE CLIPBOARD PASS: copied relief, exact preview/placement, shared crossings, boundary fit, repeat paste and input purity',
);
