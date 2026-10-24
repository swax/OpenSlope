// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';
import { createSurfaceFromDrawnBoundary } from '../src/core/mesh/surface-boundary';
import {
  rebuildSurface,
  refreshSurfaces,
  placeSurfaceGuide,
  deleteSurfaceControls,
} from '../src/core/mesh/surface-object';
import {
  chartPoint,
  guideCharts,
  readGuideCurves,
  isSurfaceBoundaryGuide,
  detachGuide,
} from '../src/core/mesh/surface-guides';
import type { V3 } from '../src/core/doc/types';

const made = createSurfaceFromDrawnBoundary(
  blankMountain('VISIBLE_SOURCE', 20),
  [
    [0, 0, 0],
    [0, 0, 60],
    [80, 0, 60],
    [80, 0, 0],
  ].map(pos => ({ pos: pos as V3, vertex: null })),
  20,
);
assert(made.ok, made.ok ? '' : made.error);
const added = placeSurfaceGuide(made.doc, made.surface, 'U', 0.5);
assert(added.ok, added.ok ? '' : added.error);
const crossed = placeSurfaceGuide(added.doc, added.surface, 'V', 0.5);
assert(crossed.ok, crossed.ok ? '' : crossed.error);
const doc = structuredClone(crossed.doc),
  s = doc.surfaces![0];
const center = s.controls.at(-1)!.find(id => s.controls.at(-2)!.includes(id))!;
doc.vertices[doc.vertexIds.indexOf(center) * 3 + 1] = 30;
const shaped = rebuildSurface(doc, s);
assert(shaped.ok, shaped.ok ? '' : shaped.error);
assert(chartPoint(guideCharts(shaped.doc, shaped.surface), 0.5, 0.5)[1] > 29);

// Reproduce the old file state: the hill is saved in a rest quilt, all interior guides are gone,
// and the four surviving boundaries are referenced against that frozen hill.
const interior = shaped.surface.guides!.flatMap((_, i) => (isSurfaceBoundaryGuide(shaped.surface, i) ? [] : [i]));
const deleted = deleteSurfaceControls(shaped.doc, shaped.surface, { curves: interior });
assert(deleted.ok, deleted.ok ? '' : deleted.error);
let retired = { doc: shaped.doc, surface: shaped.surface };
for (const i of [...interior].sort((a, b) => b - a)) retired = detachGuide(retired.doc, retired.surface, i);
const legacy = structuredClone({ ...retired.doc, surfaces: [retired.surface] }),
  old = legacy.surfaces![0];
old.seed = guideCharts(shaped.doc, shaped.surface);
old.guides = old.guides!.map((g, i) => ({ ...g, reference: readGuideCurves(legacy, old)[i].points }));
old.evaluated = { ...old.evaluated, points: readGuideCurves(legacy, old).map(c => c.points.flat()) };
const before = JSON.stringify(legacy);
assert(
  old.patches.some(p => p.base.some(cp => cp[1] > 25)),
  'legacy generated terrain still contains the retired hill',
);
for (const u of [0, 0.2, 0.5, 0.8, 1])
  for (const v of [0, 0.2, 0.5, 0.8, 1])
    assert(
      Math.abs(chartPoint(guideCharts(legacy, old), u, v)[1]) < 1e-7,
      'a retired seed cannot produce an uncontrolled bump',
    );
const refreshed = refreshSurfaces(migrateMountain(serializeMountain(legacy)));
const addedToLegacy = placeSurfaceGuide(legacy, old, 'U', 0.25);
assert(addedToLegacy.ok, addedToLegacy.ok ? '' : addedToLegacy.error);
assert(
  addedToLegacy.surface.patches.every(p => p.base.every(cp => Math.abs(cp[1]) < 1e-7)),
  'adding a redundant guide cannot validate and retain stale generated relief',
);
assert(!refreshed.surfaces![0].seed && !refreshed.surfaces![0].guides!.some(g => g.reference));
assert(
  refreshed.surfaces![0].patches.every(p => p.base.every(cp => Math.abs(cp[1]) < 1e-7)),
  'generated terrain is rebuilt from the visible boundaries',
);
assert.equal(JSON.stringify(legacy), before, 'migration and refresh do not mutate their input');
assert.deepEqual(
  refreshed.surfaces![0].controls,
  deleted.surface.controls,
  'clearing hidden history does not invent guides',
);
const saved = migrateMountain(serializeMountain(refreshed));
assert.equal(refreshSurfaces(saved), saved, 'a control-defined surface is stable after reload');
console.log(
  'SURFACE SOURCE: retired seed/reference history cannot hold a hill; source-only refresh, boundary identities, purity and save/reload passed.',
);
