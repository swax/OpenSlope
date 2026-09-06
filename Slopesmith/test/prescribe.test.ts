// tier: fast

/** Focused checks for prescribed seam subdivisions. Run: `npx tsx test/prescribe.test.ts` */
import type { V3 } from '../src/core/doc/types';
import type { InterfaceCurve } from '../src/core/mesh/retopology/benchmark';
import type { PolygonMesh } from '../src/core/mesh/retopology/obj';
import {
  boundaryLoops, formatFixedSubsides, lockedRimLoops, parseCornersFile, prescribeRimSubsides,
} from '../src/core/mesh/retopology/prescribe';
import { check, failures } from './check';

/** Octagonal annulus in the XZ plane: inner rim vertices 0-7 (radius 5), outer 8-15 (radius 10). */
function annulus(): PolygonMesh {
  const vertices: V3[] = [];
  for (const radius of [5, 10]) {
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      vertices.push([radius * Math.cos(angle), 0, radius * Math.sin(angle)]);
    }
  }
  const faces: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const next = (i + 1) % 8;
    faces.push([i, next, 8 + next], [i, 8 + next, 8 + i]);
  }
  return { vertices, faces };
}

const mesh = annulus();
const authoredAt = (angles: number[]): V3[] =>
  angles.map(degrees => {
    const angle = (degrees * Math.PI) / 180;
    return [5 * Math.cos(angle), 0, 5 * Math.sin(angle)] as V3;
  });

{
  const loops = boundaryLoops(mesh).map(loop => loop.length).sort((a, b) => a - b);
  check(JSON.stringify(loops) === '[8,8]', 'boundary loops: annulus has two 8-edge rims');
}

{
  // authored rim of 12 uniform corners over inner-rim arcs of 3, 2, and 3 octagon edges
  const authored = authoredAt([0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);
  const { records, loops, movedVertices } = prescribeRimSubsides(mesh, new Set([0, 3, 5]), [authored]);
  check(loops.length === 1 && loops[0].authoredEdges === 12 && loops[0].rimEdges === 8 && loops[0].arcs === 3,
    'prescription: authored loop matches the inner rim and splits at the three corners');
  check(records.reduce((sum, record) => sum + record.count, 0) === 12,
    'prescription: counts sum to the authored edge count exactly');
  check(JSON.stringify(records.map(record => record.count).sort((a, b) => a - b)) === '[3,4,5]',
    'prescription: uniform authored corners distribute by arc length');
  check(records.every(record => record.v0 < 8 && record.v1 < 8 && (record.vMid === -1 || record.vMid < 8)),
    'prescription: records reference inner-rim vertices only');
  check(records.every(record => (record.vMid === -1) === (Math.abs(record.v0 - record.v1) % 6 === 1)),
    'prescription: vMid is -1 exactly for single-edge subsides');
  check(records.every(record => record.fractions.length === record.count - 1),
    'prescription: every arc carries count-1 split fractions');
  check(records.every(record => record.fractions.every((fraction, index) => fraction > 0 && fraction < 1
    && (index === 0 || fraction > record.fractions[index - 1]))),
    'prescription: split fractions are strictly increasing inside (0, 1)');
  // corner 0 sits on an authored corner; corners 3 and 5 sit half an octagon edge away and
  // conform onto their paired authored corners (the gate allows ~1.9 m here)
  check(loops[0].movedCorners === 2 && movedVertices.has(3) && movedVertices.has(5) && !movedVertices.has(0),
    'prescription: off-authored layout corners conform onto their paired authored corners');
  check(loops[0].worstResidualM < 1e-6,
    'prescription: conformed corners leave no residual pairing distance');
  // splits should sit near uniform positions along their arcs (authored corners are uniform)
  check(records.every(record => record.fractions.every((fraction, index) =>
    Math.abs(fraction - (index + 1) / record.count) < 0.1)),
    'prescription: uniform authored corners give near-uniform split fractions');
}

{
  // all authored corners in one distant span: the monotone pairing still keeps one subdivision
  // per arc, and pairings far beyond the conforming gate leave the corners where tracing put them
  const authored = authoredAt([180, 210, 240, 270]);
  const { records, loops } = prescribeRimSubsides(mesh, new Set([0, 1, 2]), [authored]);
  check(JSON.stringify(records.map(record => record.count).sort((a, b) => a - b)) === '[1,1,2]',
    'prescription: the monotone pairing reaches the one-per-arc minimum');
  check(loops[0].movedCorners === 0 && loops[0].worstResidualM > 1,
    'prescription: pairings beyond the conforming gate are reported as residual, not moved');
}

{
  let threw = '';
  try {
    prescribeRimSubsides(mesh, new Set([0, 3, 5]), [authoredAt([0, 120, 240]).map(([x, y, z]) => [x + 50, y, z] as V3)]);
  } catch (error) {
    threw = (error as Error).message;
  }
  check(threw.includes('matches no remesh boundary loop'), 'prescription: distant authored loop is rejected');
}

{
  const curves: InterfaceCurve[] = [];
  for (let i = 0; i < 8; i++) {
    curves.push({
      edgeVertexIds: [`inner:${i}`, `inner:${(i + 1) % 8}`],
      samples: [mesh.vertices[i], mesh.vertices[(i + 1) % 8]],
    });
  }
  const locked = lockedRimLoops(mesh, curves);
  check(locked.length === 1 && locked[0].length === 8, 'locked rims: only the interface-traced rim is selected');
}

{
  const text = formatFixedSubsides([
    { v0: 4, v1: 9, vMid: -1, count: 3, fractions: [0.25, 0.625] },
    { v0: 9, v1: 4, vMid: 7, count: 2, fractions: [] },
  ]);
  check(text === '2\n4 9 -1 3 0.250000 0.625000\n9 4 7 2\n',
    'sidecar: record formatting matches the quad_from_patches loader');
}

{
  const corners = parseCornersFile('2\n3\n10 20 30\n2\n20 40\n');
  check(corners.size === 4 && [10, 20, 30, 40].every(vertex => corners.has(vertex)),
    'corners: per-patch lists parse into a distinct vertex set');
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all prescription checks passed');
