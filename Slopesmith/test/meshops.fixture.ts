/**
 * The shared fixture bench for the `meshops-*` topology-surgery checks (docs/017). Not a check itself — it
 * holds the manifold/orientation predicates those checks assert with and the one explicit promoted lattice
 * they all cut, slide and loft. The `check()` tally they report through is `./check`, the one shared with the
 * rest of the suite.
 */
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { ekey } from '../src/core/mesh/ops';
import type { QuadMeshDoc } from '../src/core/doc/types';

/** Every interior edge shared by exactly 2 quads, no edge by 3+, and count the boundary (rim) edges. */
export function watertight(doc: QuadMeshDoc): { ok: boolean; over: number; boundary: number } {
  const count = new Map<string, number>();
  for (const q of doc.quads) for (const [a, b] of [[q[0], q[1]], [q[1], q[3]], [q[3], q[2]], [q[2], q[0]]] as [number, number][]) {
    if (a === b) continue; // wedge triangles encode their collapsed fourth side as C-C; it is not topology
    const k = ekey(a, b); count.set(k, (count.get(k) ?? 0) + 1);
  }
  let over = 0, boundary = 0;
  for (const n of count.values()) { if (n > 2) over++; if (n === 1) boundary++; }
  return { ok: over === 0, over, boundary };
}

/** Every shared seam must be traversed in opposite directions by its two incident patches. This is the
 * topological normal-orientation rule: adjacent front faces agree even when their geometric normals meet at
 * a deliberate crease such as an extrusion wall. */
export function normalsAgreeAcrossSeams(doc: QuadMeshDoc): boolean {
  const uses = new Map<string, [number, number][]>();
  for (const q of doc.quads) for (const [a, b] of [[q[0], q[1]], [q[1], q[3]], [q[3], q[2]], [q[2], q[0]]] as [number, number][]) {
    if (a === b) continue;
    const key = ekey(a, b), list = uses.get(key) ?? [];
    list.push([a, b]); uses.set(key, list);
  }
  return [...uses.values()].every(list => list.length < 2 || (list.length === 2
    && list[0][0] === list[1][1] && list[0][1] === list[1][0]));
}
export const hasNaN = (doc: QuadMeshDoc) => doc.vertices.some(x => !Number.isFinite(x));

// ---- an explicit promoted lattice: dims for the row/column-insert regression -------------------------------
// New mountains are course lofts, so topology surgery uses its own rectangular fixture instead of depending
// on an application generator. `meshFromNet` keeps vertex ids (id = r*cols + c).
const FIXTURE_ROWS = 74, FIXTURE_COLS = 48, FIXTURE_SPACING = 30;
const fixtureNoise = (x: number, z: number): number => {
  const h = (ix: number, iz: number) => {
    let n = ix * 374761393 + iz * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return (((n ^ (n >> 16)) >>> 0) % 10000) / 10000;
  };
  const ix = Math.floor(x), iz = Math.floor(z);
  const sx = x - ix, sz = z - iz;
  const fx = sx * sx * (3 - 2 * sx), fz = sz * sz * (3 - 2 * sz);
  const a = h(ix, iz), b = h(ix + 1, iz), c = h(ix, iz + 1), d = h(ix + 1, iz + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
};
const fixtureDescent = new Array<number>(FIXTURE_ROWS);
fixtureDescent[FIXTURE_ROWS - 1] = 0;
const fixtureBench = (t: number) => Math.max(0.18, Math.min(2.2,
  1 + 0.7 * Math.sin(t * Math.PI * 3 + 0.6) + 0.25 * Math.sin(t * Math.PI * 7 + 2.1)));
for (let r = FIXTURE_ROWS - 2; r >= 0; r--) {
  fixtureDescent[r] = fixtureDescent[r + 1]
    + FIXTURE_SPACING * 0.65 * (fixtureBench(r / (FIXTURE_ROWS - 1)) + fixtureBench((r + 1) / (FIXTURE_ROWS - 1))) / 2;
}
const fixtureCorners: number[] = [];
for (let r = 0; r < FIXTURE_ROWS; r++) for (let c = 0; c < FIXTURE_COLS; c++) {
  const x = r * FIXTURE_SPACING, z = c * FIXTURE_SPACING;
  const relief = 0.6 * (
    55 * (fixtureNoise(x / 780 + 5.2, z / 620 + 8.9) - 0.5)
    + 26 * fixtureNoise(x / 420, z / 420)
    + 11 * fixtureNoise(x / 150 + 31.7, z / 150 + 7.3)
    + 3.5 * fixtureNoise(x / 55 + 11.1, z / 55 + 91.4)
  );
  fixtureCorners.push(x, fixtureDescent[r] + relief, z);
}
export const grid = meshFromNet({
  rows: FIXTURE_ROWS, cols: FIXTURE_COLS, spacing: FIXTURE_SPACING,
  corners: fixtureCorners, paint: {},
}, { name: 'MESHOPS', course: starterCourse(), baseSurface: 1 });
export const GRID_COLS = grid.quads[0][2];
export const GRID_ROWS = grid.vertices.length / 3 / GRID_COLS;
export const freshGrid = (): QuadMeshDoc => structuredClone(grid); // each case mutates its own copy
export const cellRows = GRID_ROWS - 1, cellCols = GRID_COLS - 1;
export const V0 = GRID_ROWS * GRID_COLS, Q0 = cellRows * cellCols;
console.log(`default grid: ${GRID_ROWS}x${GRID_COLS} corners, ${cellRows}x${cellCols} cells (V=${V0}, Q=${Q0})\n`);
