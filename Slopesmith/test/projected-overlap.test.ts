// tier: fast

/** Focused checks for the view-projected patch-mask point query. Run: `npx tsx test/projected-overlap.test.ts` */
import {
  pointsInProjectedTriangles, polygonsIntersectProjectedTriangles, type ProjectedTriangle,
} from '../src/core/mesh/projected-overlap';
import { check, failures } from './check';

const triangles: ProjectedTriangle[] = [
  [[0, 0], [2, 0], [0, 2]],
  [[3, 3], [3, 5], [5, 3]], // opposite winding
];
const result = pointsInProjectedTriangles([
  { id: 9, x: 0.5, y: 0.5 },
  { id: 3, x: 1, y: 1 },       // boundary
  { id: 7, x: 1.5, y: 1.5 },   // first triangle's AABB, outside its diagonal
  { id: 5, x: 3.5, y: 3.5 },
  { id: 1, x: -1, y: -1 },
], triangles);
check(JSON.stringify(result) === JSON.stringify([9, 3, 5]),
  'projected mask: union accepts interiors and boundaries in input order, independent of winding');

check(pointsInProjectedTriangles([{ id: 4, x: 0, y: 0 }], [
  [[0, 0], [1, 1], [2, 2]],
]).length === 0, 'projected mask: degenerate projected triangles do not select points');

check(pointsInProjectedTriangles([], triangles).length === 0
  && pointsInProjectedTriangles([{ id: 1, x: 0, y: 0 }], []).length === 0,
'projected mask: empty inputs are harmless');

const crossing = polygonsIntersectProjectedTriangles([
  { id: 1, points: [[-.5, .5], [.5, .5], [.5, 1.5], [-.5, 1.5]] },
  { id: 2, points: [[0, 0], [2, 0], [2, -1], [0, -1]] }, // boundary contact only
  { id: 3, points: [[.2, .2], [.4, .2], [.4, .4], [.2, .4]] },
  { id: 4, points: [[10, 10], [11, 10], [11, 11], [10, 11]] },
], [[[0, 0], [2, 0], [0, 2]]]);
check(JSON.stringify(crossing) === JSON.stringify([1, 3]),
  'projected polygons: crossing and contained faces overlap, boundary-only contact does not');

if (failures) {
  console.error(`\nPROJECTED OVERLAP: ${failures} FAILED`);
  process.exitCode = 1;
} else console.log('\nPROJECTED OVERLAP: PASS');
