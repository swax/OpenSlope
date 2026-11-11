import type { V3 } from '../doc/types';
import { add, mul } from './vec';

/** Faces use cyclic winding, unlike the terrain's [A,B,C,D] tensor-product order. */
export type SubdivisionMesh = { points: V3[]; faces: number[][]; creases: [number, number][]; corners?: number[] };
const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
const average = (points: V3[]): V3 =>
  mul(
    points.reduce((a, b) => add(a, b), [0, 0, 0]),
    1 / points.length,
  );

function adjacency(mesh: SubdivisionMesh) {
  const edges = new Map<string, { a: number; b: number; faces: number[]; sharp: boolean }>();
  const vertices = mesh.points.map(() => ({ faces: [] as number[], neighbors: [] as number[], sharp: [] as number[] }));
  const sharp = new Set(mesh.creases.map(([a, b]) => edgeKey(a, b)));
  mesh.faces.forEach((face, f) =>
    face.forEach((a, i) => {
      vertices[a].faces.push(f);
      const b = face[(i + 1) % 4],
        key = edgeKey(a, b);
      let edge = edges.get(key);
      if (!edge) {
        edge = { a, b, faces: [], sharp: sharp.has(key) };
        edges.set(key, edge);
      }
      edge.faces.push(f);
    }),
  );
  for (const edge of edges.values()) {
    edge.sharp ||= edge.faces.length === 1;
    const { a, b } = edge;
    vertices[a].neighbors.push(b);
    vertices[b].neighbors.push(a);
    if (edge.sharp) {
      vertices[a].sharp.push(b);
      vertices[b].sharp.push(a);
    }
  }
  return { edges, vertices };
}

/** Reject disconnected, inconsistently wound and non-manifold cages before allocating refinement. */
export function validateSubdivisionMesh(mesh: SubdivisionMesh) {
  if (
    !mesh.faces.length ||
    mesh.faces.length > 1024 ||
    mesh.points.length > 4096 ||
    mesh.points.some(p => p.length !== 3 || p.some(n => !Number.isFinite(n)))
  )
    throw new Error('Select between 1 and 1,024 quad faces with finite cage points.');
  if (
    mesh.faces.some(
      f =>
        f.length !== 4 ||
        new Set(f).size !== 4 ||
        f.some(v => !Number.isInteger(v) || v < 0 || v >= mesh.points.length),
    )
  )
    throw new Error('Subdivision cages require proper quad faces; triangles and collapsed faces are unsupported.');
  const { edges, vertices } = adjacency(mesh);
  for (const e of edges.values()) {
    if (e.faces.length > 2) throw new Error('The subdivision cage must be manifold.');
    if (e.faces.length === 2) {
      const directions = e.faces.map(f => mesh.faces[f][(mesh.faces[f].indexOf(e.a) + 1) % 4] === e.b);
      if (directions[0] === directions[1])
        throw new Error('Orient adjacent cage faces consistently before converting.');
    }
  }
  const linked = mesh.faces.map(() => new Set<number>());
  for (const e of edges.values()) for (const f of e.faces) for (const g of e.faces) linked[f].add(g);
  const flood = (allowed: Set<number>) => {
    const seen = new Set<number>(),
      queue = [allowed.values().next().value!];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const g of linked[f]) if (allowed.has(g) && !seen.has(g)) queue.push(g);
    }
    return seen.size === allowed.size;
  };
  if (!flood(new Set(mesh.faces.map((_, i) => i)))) throw new Error('Select one connected cage.');
  for (const [i, v] of vertices.entries()) {
    if (!v.faces.length || !flood(new Set(v.faces))) throw new Error('The cage has a non-manifold vertex.');
    const boundary = v.neighbors.filter(n => edges.get(edgeKey(i, n))!.faces.length === 1);
    // A disk fan has one more incident edge than face; a closed fan has equal counts.
    if (
      (boundary.length !== 0 && boundary.length !== 2) ||
      v.neighbors.length !== v.faces.length + (boundary.length ? 1 : 0)
    )
      throw new Error('The cage has a non-manifold vertex.');
  }
  if (mesh.creases.some(([a, b]) => !edges.has(edgeKey(a, b)))) throw new Error('A crease names a missing cage edge.');
  if (mesh.corners?.some(v => !Number.isInteger(v) || v < 0 || v >= mesh.points.length))
    throw new Error('A sharp corner names a missing cage point.');
}

/** One Catmull-Clark step, with infinitely sharp creases and the edge-only boundary rule. */
export function subdivideCage(mesh: SubdivisionMesh): SubdivisionMesh {
  const corners = new Set(mesh.corners);
  const { edges, vertices } = adjacency(mesh),
    centers = mesh.faces.map(f => average(f.map(v => mesh.points[v])));
  const points = mesh.points.map((p, i): V3 => {
    const v = vertices[i],
      n = v.faces.length;
    if (corners.has(i) || v.sharp.length >= 3) return [...p];
    if (v.sharp.length === 2)
      return add(mul(p, 0.75), mul(add(mesh.points[v.sharp[0]], mesh.points[v.sharp[1]]), 0.125));
    const F = average(v.faces.map(f => centers[f]));
    const R = average(v.neighbors.map(j => mul(add(p, mesh.points[j]), 0.5)));
    return mul(add(add(F, mul(R, 2)), mul(p, n - 3)), 1 / n);
  });
  const edgePoints = new Map<string, number>(),
    creases: [number, number][] = [];
  for (const [key, e] of edges) {
    const at = points.length;
    edgePoints.set(key, at);
    points.push(
      e.sharp
        ? mul(add(mesh.points[e.a], mesh.points[e.b]), 0.5)
        : average([mesh.points[e.a], mesh.points[e.b], ...e.faces.map(f => centers[f])]),
    );
    if (e.sharp) creases.push([e.a, at], [at, e.b]);
  }
  const start = points.length;
  points.push(...centers);
  const faces = mesh.faces.flatMap((face, f) =>
    face.map((a, i) => [
      a,
      edgePoints.get(edgeKey(a, face[(i + 1) % 4]))!,
      start + f,
      edgePoints.get(edgeKey(face[(i + 3) % 4], a))!,
    ]),
  );
  return { points, faces, creases, ...(mesh.corners?.length ? { corners: mesh.corners } : {}) };
}

/** A dart has one sharp edge but uses the smooth vertex rule. Its limit stencil differs from the
 * ordinary smooth mask. Refine only its closed one-ring, keeping the sharp neighbor first; this
 * converges to floating-point precision without expanding the rest of the mesh. */
function dartLimit(mesh: SubdivisionMesh, vertex: number, faces: number[], sharpNeighbor: number): V3 {
  const ring = new Map<number, { next: number; diagonal: number }>();
  for (const f of faces) {
    const face = mesh.faces[f],
      at = face.indexOf(vertex);
    ring.set(face[(at + 1) % 4], { next: face[(at + 3) % 4], diagonal: face[(at + 2) % 4] });
  }
  let p = mesh.points[vertex],
    next = sharpNeighbor;
  let neighbors: V3[] = [],
    diagonals: V3[] = [];
  do {
    const entry = ring.get(next)!;
    neighbors.push(mesh.points[next]);
    diagonals.push(mesh.points[entry.diagonal]);
    next = entry.next;
  } while (next !== sharpNeighbor);
  const n = neighbors.length;
  for (let step = 0; step < 64; step++) {
    const centers = neighbors.map((q, j) => average([p, q, diagonals[j], neighbors[(j + 1) % n]]));
    const center = mul(
      add(add(average(centers), mul(average(neighbors.map(q => mul(add(p, q), 0.5))), 2)), mul(p, n - 3)),
      1 / n,
    );
    neighbors = neighbors.map((q, j) =>
      j === 0 ? mul(add(p, q), 0.5) : average([p, q, centers[j], centers[(j + n - 1) % n]]),
    );
    diagonals = centers;
    p = center;
  }
  return p;
}

/** Limit positions of an all-quad Catmull-Clark control mesh, with numerical convergence at darts. */
export function subdivisionLimitPoints(mesh: SubdivisionMesh): V3[] {
  const { vertices } = adjacency(mesh);
  const corners = new Set(mesh.corners);
  return mesh.points.map((p, i) => {
    const v = vertices[i],
      n = v.faces.length;
    if (corners.has(i) || v.sharp.length >= 3) return [...p];
    if (v.sharp.length === 2) return mul(add(mul(p, 4), add(mesh.points[v.sharp[0]], mesh.points[v.sharp[1]])), 1 / 6);
    if (v.sharp.length === 1) return dartLimit(mesh, i, v.faces, v.sharp[0]);
    const opposite = v.faces.map(f => mesh.points[mesh.faces[f][(mesh.faces[f].indexOf(i) + 2) % 4]]);
    return mul(
      add(
        add(
          mul(p, n * n),
          mul(
            v.neighbors.reduce((a, j) => add(a, mesh.points[j]), [0, 0, 0] as V3),
            4,
          ),
        ),
        opposite.reduce((a, b) => add(a, b), [0, 0, 0] as V3),
      ),
      1 / (n * (n + 5)),
    );
  });
}

type UV = [number, number];
const mid = (a: UV, b: UV): UV => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
// Inverse cubic Bernstein collocation at 0, 1/4, 3/4, 1.
const inverse = [
  [1, 0, 0, 0],
  [-10 / 9, 8 / 3, -8 / 9, 1 / 3],
  [1 / 3, -8 / 9, 8 / 3, -10 / 9],
  [0, 0, 0, 1],
];
const transform = (samples: V3[]) =>
  inverse.map(row => row.reduce((p, w, i) => add(p, mul(samples[i], w)), [0, 0, 0] as V3));
export const MAX_SUBDIVISION_PATCHES = 4096;

/** Bicubic interpolation of exact limit samples. Regular spans are exact; extraordinary spans are an
 * approximation refined by level. Shared edges read identical samples, so the quilt stays watertight. */
export function subdivisionPatches(cage: SubdivisionMesh, level: number) {
  validateSubdivisionMesh(cage);
  if (!Number.isInteger(level) || level < 1 || level > 4) throw new Error('Subdivision level must be between 1 and 4.');
  if (cage.faces.length * 4 ** level > MAX_SUBDIVISION_PATCHES)
    throw new Error('This cage exceeds 4,096 terrain patches. Use a lower subdivision level or a smaller cage.');
  let mesh = cage;
  let keys = cage.faces.map((_, i) => `${i}`);
  for (let i = 0; i < level; i++) {
    mesh = subdivideCage(mesh);
    keys = keys.flatMap(k => [0, 1, 2, 3].map(j => `${k}/${j}`));
  }
  const output = mesh;
  let charts = output.faces.map((_, root) => ({
    root,
    uv: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ] as UV[],
  }));
  for (let step = 0; step < 2; step++) {
    mesh = subdivideCage(mesh);
    charts = charts.flatMap(({ root, uv }) =>
      uv.map((a, i) => ({
        root,
        uv: [a, mid(a, uv[(i + 1) % 4]), mid(mid(uv[0], uv[1]), mid(uv[2], uv[3])), mid(uv[(i + 3) % 4], a)],
      })),
    );
  }
  const limits = subdivisionLimitPoints(mesh),
    samples = output.faces.map(() => new Map<string, V3>());
  charts.forEach(({ root, uv }, i) => uv.forEach((p, j) => samples[root].set(p.join(','), limits[mesh.faces[i][j]])));
  const nodes = [0, 0.25, 0.75, 1];
  const controls = samples.map(grid => {
    const rows = nodes.map(u => transform(nodes.map(v => grid.get(`${u},${v}`)!)));
    const cols = nodes.map((_, v) => transform(rows.map(row => row[v])));
    return nodes.flatMap((_, u) => cols.map(col => col[u]));
  });
  return {
    points: subdivisionLimitPoints(output),
    faces: output.faces.map(([a, b, c, d]) => [a, b, d, c]),
    controls,
    keys,
  };
}
