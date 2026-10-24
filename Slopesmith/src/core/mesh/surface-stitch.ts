import type {
  QuadMeshDoc,
  SurfaceObject,
  SurfaceBoundary,
  SurfaceSide,
  SurfaceStitch,
  V3,
  LoftDomain,
} from '../doc/types';
import { nameIndex } from '../doc/ids';
import { add, sub, mul, len, dot } from '../math/vec';
import { splitCubic, patchNormal, cubicPoint } from '../math/bezier';
import { restrict, writeCages, type Patch } from './loft-surface';
import { chartPoint, guideCharts, readGuideCurves, sourceGuideSurface } from './surface-guides';
import { compactSurfaceCharts } from '../math/spline-surface';
import { fitSurface } from './surface-fit';
import { meshFromDoc, quadControlPoints } from './topology';
import { readVertex, quadPerimeterEdges, undirectedEdgeKey } from './primitives';
import { finishMeshRewrite, checkManifold, createQuadSurfaceMaps, inheritQuadSurface } from './ops/contract';
import { releaseSurfaceShape } from './surface-stitch-release';
import { setMeshControlPoints } from './control-points';
import { surfaceSideControls } from './surface-stitch-controls';

type UV = [number, number];
type Cell = { key: string; nodes: string[]; uv: UV[]; cp: V3[]; domain: LoftDomain };
type Quilt = {
  surface: SurfaceObject;
  points: Map<string, V3>;
  uv: Map<string, UV>;
  cells: Cell[];
  charts: Patch[];
  junctions?: [string, string][];
};
type Curve = { nodes: [string, string]; cp: V3[]; inward: V3[] };
const EPS = 1e-7;
const CP = [
  [0, 1, 2, 3],
  [3, 7, 11, 15],
  [15, 14, 13, 12],
  [12, 8, 4, 0],
];
const IN = [
  [4, 5, 6, 7],
  [2, 6, 10, 14],
  [11, 10, 9, 8],
  [13, 9, 5, 1],
];
const PERIM = [0, 1, 3, 2];
type StitchEvaluation = {
  vertexIds: string[];
  quads: number[][];
  participants: SurfaceObject[];
  controls: number[];
  faces: number[];
  shape: number[];
};
const evaluations = new WeakMap<SurfaceObject[], StitchEvaluation>();
const participantEvaluations = new WeakMap<SurfaceObject, StitchEvaluation>();

/** Include incoming links and ordinary-edge links that name generated corners as well as outgoing links. */
function stitchParticipants(doc: QuadMeshDoc): SurfaceObject[] {
  const surfaces = doc.surfaces ?? [],
    ids = new Set<string>(),
    meshTargets = new Set<string>();
  for (const s of surfaces)
    for (const st of s.stitches ?? []) {
      ids.add(s.id);
      if ('surface' in st.target) ids.add(st.target.surface);
      else st.target.vertices.forEach(id => meshTargets.add(id));
    }
  return surfaces.filter(s => ids.has(s.id) || s.patches.some(p => p.corners.some(id => meshTargets.has(id))));
}

export function surfaceHasStitches(doc: QuadMeshDoc, surface: string): boolean {
  return stitchParticipants(doc).some(s => s.id === surface);
}
const sides: SurfaceSide[] = ['u0', 'u1', 'v0', 'v1'];
const edgeKey = (a: string, b: string) => JSON.stringify([a, b].sort());
const cuts = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const axis = (side: SurfaceSide) => (side[0] === 'u' ? 1 : 0);
const onSide = (uv: UV, side: SurfaceSide) => Math.abs(uv[1 - axis(side)] - Number(side[1])) < EPS;
const atSide = (side: SurfaceSide, t: number): UV => (side[0] === 'u' ? [Number(side[1]), t] : [t, Number(side[1])]);
const blend = (a: V3, b: V3, t: number) => add(mul(a, 1 - t), mul(b, t));
const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) < 1e-7);
const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, i) => name === b[i]);
function hostShape(doc: QuadMeshDoc, faces: number[]) {
  return faces.flatMap(i => {
    const q = doc.quads[i];
    if (!q) return [-1];
    return [
      ...q,
      ...q.flatMap(v => readVertex(doc.vertices, v)),
      ...quadPerimeterEdges(q).flatMap(([a, b]) => [
        ...(doc.edgeHandles?.[`${a}>${b}`] ?? [0, 0, 0]),
        ...(doc.edgeHandles?.[`${b}>${a}`] ?? [0, 0, 0]),
      ]),
      ...(doc.quadTwist?.[i]?.flat() ?? []),
    ];
  });
}
const area = (uv: UV[]) =>
  uv.reduce((sum, p, i) => {
    const q = uv[(i + 1) % uv.length];
    return sum + p[0] * q[1] - p[1] * q[0];
  }, 0);

function curve(cell: Cell, a: string, b: string): Curve | undefined {
  for (let e = 0; e < 4; e++) {
    const from = cell.nodes[PERIM[e]],
      to = cell.nodes[PERIM[(e + 1) % 4]];
    if ((a === from && b === to) || (a === to && b === from)) {
      const indices = a === from ? CP[e] : [...CP[e]].reverse();
      const inward = a === from ? IN[e] : [...IN[e]].reverse();
      return {
        nodes: [a, b],
        cp: indices.map(i => cell.cp[i]),
        inward: inward.map((i, j) => sub(cell.cp[i], cell.cp[indices[j]])),
      };
    }
  }
}

function boundary(q: Quilt, side: SurfaceSide) {
  const counts = new Map<string, number>();
  for (const c of q.cells)
    for (let e = 0; e < 4; e++) {
      const a = c.nodes[PERIM[e]],
        b = c.nodes[PERIM[(e + 1) % 4]];
      const key = edgeKey(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const nodes = new Set<string>();
  for (const c of q.cells)
    for (let e = 0; e < 4; e++) {
      const a = c.nodes[PERIM[e]],
        b = c.nodes[PERIM[(e + 1) % 4]];
      if (counts.get(edgeKey(a, b)) === 1 && onSide(q.uv.get(a)!, side) && onSide(q.uv.get(b)!, side)) {
        nodes.add(a);
        nodes.add(b);
      }
    }
  return [...nodes].sort((a, b) => q.uv.get(a)![axis(side)] - q.uv.get(b)![axis(side)]);
}

function natural(surface: SurfaceObject, input: Patch[]): Quilt {
  const us = cuts(input.flatMap(p => p.domain.slice(0, 2))),
    vs = cuts(input.flatMap(p => p.domain.slice(2)));
  const q: Quilt = { surface, charts: input, points: new Map(), uv: new Map(), cells: [] };
  for (const p of input) {
    const [u0, u1, v0, v1] = p.domain;
    const uv: UV[] = [
      [u0, v0],
      [u0, v1],
      [u1, v0],
      [u1, v1],
    ];
    const nodes = uv.map(([u, v], i) => {
      const key = `${surface.id}/g:${us.indexOf(u)}:${vs.indexOf(v)}`;
      q.points.set(key, p.controls[[0, 3, 12, 15][i]]);
      q.uv.set(key, [u, v]);
      return key;
    });
    q.cells.push({ key: `g:${us.indexOf(u0)}:${vs.indexOf(v0)}`, nodes, uv, cp: p.controls, domain: p.domain });
  }
  return q;
}

/** Endpoints of partial attachments are real boundary knots, independent of source guide divisions. */
function splitAnchors(input: Patch[], refs: SurfaceBoundary[]): Patch[] {
  let out = input;
  for (const ref of refs)
    for (const t of ref.range) {
      const a = axis(ref.side) === 0 ? 0 : 2;
      out = out.flatMap(p => {
        if (t <= p.domain[a] + EPS || t >= p.domain[a + 1] - EPS) return [p];
        const left = [...p.domain] as LoftDomain,
          right = [...p.domain] as LoftDomain;
        left[a + 1] = t;
        right[a] = t;
        return [left, right].map(domain => ({ domain, controls: restrict(p.controls, p.domain, domain) }));
      });
    }
  return out;
}

function hostMesh(
  doc: QuadMeshDoc,
  names: string[],
): { nodes: string[]; points: Map<string, V3>; curves: Curve[]; stations: number[] } {
  const index = nameIndex(doc.vertexIds),
    { mesh, edgeHandle } = meshFromDoc(doc);
  const owned = new Set(doc.surfaces?.flatMap(s => s.patches.map(p => p.quad)));
  const nodes = names.map(id => `mesh:${id}`),
    points = new Map<string, V3>(),
    curves: Curve[] = [],
    stations = [0];
  names.forEach((id, i) => {
    const v = index.get(id);
    if (v === undefined) throw new Error('A stitched mesh boundary was removed. Undo or detach the surface.');
    points.set(nodes[i], readVertex(doc.vertices, v));
  });
  for (let i = 0; i < names.length - 1; i++) {
    const a = index.get(names[i])!,
      b = index.get(names[i + 1])!;
    const faces = doc.quads.flatMap((cell, j) =>
      !owned.has(doc.quadIds[j]) &&
      quadPerimeterEdges(cell).some(([x, y]) => undirectedEdgeKey(x, y) === undirectedEdgeKey(a, b))
        ? [j]
        : [],
    );
    if (faces.length !== 1) throw new Error('Stitch to an open terrain boundary with one incident patch per edge.');
    const f = faces[0],
      cp = quadControlPoints(mesh, edgeHandle, f, doc.quadTwist?.[f]);
    curves.push(
      curve({ nodes: doc.quads[f].map(v => `mesh:${doc.vertexIds[v]}`), cp } as Cell, nodes[i], nodes[i + 1])!,
    );
    stations.push(stations.at(-1)! + len(sub(points.get(nodes[i + 1])!, points.get(nodes[i])!)));
  }
  if (!(stations.at(-1)! > EPS)) throw new Error('The stitched boundary has zero length.');
  return { nodes, points, curves, stations: stations.map(t => t / stations.at(-1)!) };
}

function target(qs: Map<string, Quilt>, doc: QuadMeshDoc, stitch: SurfaceStitch) {
  if ('vertices' in stitch.target) return hostMesh(doc, stitch.target.vertices);
  const ref = stitch.target,
    q = qs.get(ref.surface);
  if (!q) throw new Error('The stitched target surface was removed. Undo or detach the surface.');
  const lo = Math.min(...ref.range),
    hi = Math.max(...ref.range);
  let nodes = boundary(q, ref.side).filter(n => {
    const t = q.uv.get(n)![axis(ref.side)];
    return t >= lo - EPS && t <= hi + EPS;
  });
  if (ref.range[0] > ref.range[1]) nodes = nodes.reverse();
  if (nodes.length < 2) throw new Error('The target surface has no matching open boundary.');
  const curves = nodes.slice(1).map((b, i) => {
    const a = nodes[i],
      faces = q.cells.filter(c => curve(c, a, b));
    if (faces.length !== 1) throw new Error('The target boundary is already stitched. Choose an open boundary.');
    return curve(faces[0], a, b)!;
  });
  return {
    nodes,
    points: q.points,
    curves,
    stations: nodes.map(n => (q.uv.get(n)![axis(ref.side)] - ref.range[0]) / (ref.range[1] - ref.range[0])),
  };
}

function convexQuality(nodes: string[], uv: Map<string, UV>, points: Map<string, V3>) {
  const ps = nodes.map(n => uv.get(n)!);
  const sign = Math.sign(area(ps));
  if (!sign) return Infinity;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i],
      b = ps[(i + 1) % ps.length],
      c = ps[(i + 2) % ps.length];
    if (((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) * sign < 1e-12) return Infinity;
  }
  const lengths = nodes.map((n, i) => len(sub(points.get(n)!, points.get(nodes[(i + 1) % nodes.length])!)));
  const aspect = Math.max(...lengths) / Math.min(...lengths);
  return aspect ** 3;
}

/** Match two rows as a strip, spending count differences in small 3-to-1 blocks.
 * A whole-rim polygon fill loses the existing row direction, even for a two-patch mismatch. */
function transitionStrip(q: Quilt, polygon: string[], front: string[], side: SurfaceSide, prefix: string) {
  const along = axis(side),
    across = 1 - along,
    depth = (n: string) => Math.abs(q.uv.get(n)![across] - Number(side[1])),
    far = Math.max(...polygon.map(depth));
  const back = polygon
    .filter(n => Math.abs(depth(n) - far) < EPS)
    .sort((a, b) => q.uv.get(a)![along] - q.uv.get(b)![along]);
  const rail = (t: number) =>
    polygon.filter(n => Math.abs(q.uv.get(n)![along] - t) < EPS).sort((a, b) => depth(a) - depth(b));
  const left = rail(0),
    right = rail(1),
    m = front.length - 1,
    n = back.length - 1;
  // Only a rectangular, two-row rim has these templates. Previously stitched irregular rims
  // still use the general polygon filler, without disturbing any pinned edge.
  if (
    n < 1 ||
    left.length !== 3 ||
    ![3, 4].includes(right.length) ||
    new Set([...front, ...back, ...left, ...right]).size !== polygon.length
  )
    return;
  const node = (key: string, uv: UV) => {
    key = `${q.surface.id}/${prefix}/${key}`;
    q.uv.set(key, uv);
    q.points.set(key, chartPoint(q.charts, ...uv));
    return key;
  };
  const mix = (a: string, b: string, t: number): UV =>
    q.uv.get(a)!.map((v, k) => v * (1 - t) + q.uv.get(b)![k] * t) as UV;
  const mid = (i: number, j: number) => {
    if (!i && !j) return left[1];
    if (i === m && j === n) return right[1];
    return node(`row:${i}:${j}`, mix(front[i], back[j], depth(left[1]) / far));
  };
  const tile = (i: number, j: number, a: number, b: number): string[][] | undefined => {
    const l = mid(i, j),
      r = mid(i + a, j + b),
      bottom = front.slice(i, i + a + 1),
      top = back.slice(j, j + b + 1),
      odd = (a + b) % 2 === 1;
    if (odd && (i + a !== m || j + b !== n || right.length !== 4)) return;
    if (!odd && i + a === m && j + b === n && right.length !== 3) return;
    if (a === 1 && b === 1)
      return [
        [bottom[0], bottom[1], r, l],
        [l, r, top[1], top[0]],
      ];
    const low = a > b ? bottom : top,
      high = a > b ? top : bottom;
    const point = (key: string, lowUV: UV, highUV: UV, t: number) =>
      node(`${i}:${j}:${a}:${b}:${key}`, lowUV.map((v, k) => v * (1 - t) + highUV[k] * t) as UV);
    if (!odd) {
      const x = point('x', q.uv.get(low[1])!, mix(high[0], high[1], 0.25), 0.4),
        y = point('y', q.uv.get(low[2])!, mix(high[0], high[1], 0.6), 0.3);
      return [
        [low[0], low[1], x, l],
        [low[1], low[2], y, x],
        [low[2], low[3], r, y],
        [x, y, r, high[1]],
        [x, high[1], high[0], l],
      ];
    }
    const rs = a > b ? right : [...right].reverse(),
      x = point('x', q.uv.get(low[1])!, mix(high[0], high[1], 0.5), 0.25),
      y = point('y', mix(low[0], low[2], 0.5), mix(high[0], high[1], 0.5), 0.75);
    return [
      [low[0], low[1], x, l],
      [low[1], low[2], rs[1], x],
      [x, rs[1], rs[2], y],
      [x, y, high[0], l],
      [y, rs[2], high[1], high[0]],
    ];
  };
  const best = new Map<string, { score: number; cells: string[][] }>([['0:0', { score: 0, cells: [] }]]);
  const steps =
    m === n
      ? [[1, 1]]
      : m > n
        ? [
            [1, 1],
            [3, 1],
            [2, 1],
          ]
        : [
            [1, 1],
            [1, 3],
            [1, 2],
          ];
  for (let i = 0; i <= m; i++)
    for (let j = 0; j <= n; j++) {
      const from = best.get(`${i}:${j}`);
      if (!from) continue;
      for (const [a, b] of steps) {
        if (i + a > m || j + b > n) continue;
        const cells = tile(i, j, a, b);
        if (!cells) continue;
        const score = from.score + cells.reduce((s, ns) => s + convexQuality(ns, q.uv, q.points), 0),
          key = `${i + a}:${j + b}`;
        if (score < (best.get(key)?.score ?? Infinity)) best.set(key, { score, cells: [...from.cells, ...cells] });
      }
    }
  return best.get(`${m}:${n}`)?.cells;
}

/** General fallback for irregular rims that cannot use the structured strip templates. */
function quadrangulate(q: Quilt, polygon: string[], prefix: string): string[][] {
  const ears = (loop: string[]): string[][] | undefined => {
    const cells: string[][] = [];
    loop = [...loop];
    while (loop.length > 4) {
      let best = -1,
        score = Infinity;
      for (let i = 0; i < loop.length; i++) {
        const ns = Array.from({ length: 4 }, (_, j) => loop[(i + j) % loop.length]);
        const s = convexQuality(ns, q.uv, q.points);
        if (s < score) {
          score = s;
          best = i;
        }
      }
      if (best < 0) return;
      loop = [...loop.slice(best), ...loop.slice(0, best)];
      cells.push(loop.slice(0, 4));
      loop.splice(1, 2);
    }
    if (!Number.isFinite(convexQuality(loop, q.uv, q.points))) return;
    return [...cells, loop];
  };
  const simple = ears(polygon);
  if (simple) return simple;
  const ps = polygon.map(n => q.uv.get(n)!);
  const min: UV = [Math.min(...ps.map(p => p[0])), Math.min(...ps.map(p => p[1]))];
  const max: UV = [Math.max(...ps.map(p => p[0])), Math.max(...ps.map(p => p[1]))];
  const center: UV = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  const inner = polygon.map((n, i) => {
    const p = q.uv.get(n)!,
      angle = Math.atan2((p[1] - center[1]) / (max[1] - min[1]), (p[0] - center[0]) / (max[0] - min[0]));
    const uv: UV = [
      center[0] + 0.3 * (max[0] - min[0]) * Math.cos(angle),
      center[1] + 0.3 * (max[1] - min[1]) * Math.sin(angle),
    ];
    const key = `${q.surface.id}/${prefix}/inner:${i}`;
    q.uv.set(key, uv);
    q.points.set(key, chartPoint(q.charts, ...uv));
    return key;
  });
  const ring = polygon.map((n, i) => [n, polygon[(i + 1) % polygon.length], inner[(i + 1) % inner.length], inner[i]]);
  const inside = ears(inner);
  if (!inside || ring.some(ns => !Number.isFinite(convexQuality(ns, q.uv, q.points))))
    throw new Error(
      'This seam needs more room for non-inverted transition quads. Increase the surface width or choose a shorter boundary.',
    );
  return [...ring, ...inside];
}

const interpolate = (p: V3[]) => [
  p[0],
  mul(add(add(mul(p[1], 18), mul(p[2], -9)), add(mul(p[3], 2), mul(p[0], -5))), 1 / 6),
  mul(add(add(mul(p[2], 18), mul(p[1], -9)), add(mul(p[0], 2), mul(p[3], -5))), 1 / 6),
  p[3],
];
function cellFromUV(q: Quilt, perimeter: string[], key: string): Cell {
  if (area(perimeter.map(n => q.uv.get(n)!)) > 0) perimeter = [...perimeter].reverse();
  const nodes = [perimeter[0], perimeter[1], perimeter[3], perimeter[2]],
    uv = nodes.map(n => q.uv.get(n)!);
  const deltas = nodes.map((n, i) => sub(q.points.get(n)!, chartPoint(q.charts, ...uv[i])));
  const bilinear = (values: V3[], u: number, v: number) =>
    blend(blend(values[0], values[1], v), blend(values[2], values[3], v), u);
  const samples: V3[] = [];
  for (let u = 0; u < 4; u++)
    for (let v = 0; v < 4; v++) {
      const param = bilinear(
        uv.map(p => [...p, 0] as V3),
        u / 3,
        v / 3,
      );
      samples.push(add(chartPoint(q.charts, param[0], param[1]), bilinear(deltas, u / 3, v / 3)));
    }
  const rows = Array.from({ length: 4 }, (_, u) => interpolate(samples.slice(u * 4, u * 4 + 4)));
  const cp = Array.from({ length: 16 }, (_, i) => interpolate(rows.map(row => row[i % 4]))[Math.floor(i / 4)]);
  return {
    nodes,
    uv,
    cp,
    key,
    domain: [
      Math.min(...uv.map(p => p[0])),
      Math.max(...uv.map(p => p[0])),
      Math.min(...uv.map(p => p[1])),
      Math.max(...uv.map(p => p[1])),
    ],
  };
}

function stitchSide(
  q: Quilt,
  side: SurfaceSide,
  stitches: SurfaceStitch[],
  quilts: Map<string, Quilt>,
  doc: QuadMeshDoc,
) {
  const original = boundary(q, side),
    pins = new Map<string, Curve>(),
    smooth = new Map<string, Curve>();
  let replacement = [...original];
  for (const stitch of [...stitches].sort((a, b) => a.range[0] - b.range[0])) {
    const host = target(quilts, doc, stitch),
      [lo, hi] = stitch.range;
    host.nodes.forEach((n, i) => {
      q.points.set(n, host.points.get(n)!);
      q.uv.set(n, atSide(side, lo + (hi - lo) * host.stations[i]));
    });
    replacement = [
      ...replacement.filter(n => q.uv.get(n)![axis(side)] < lo - EPS),
      ...host.nodes,
      ...replacement.filter(n => q.uv.get(n)![axis(side)] > hi + EPS),
    ];
    for (const c of host.curves) {
      pins.set(edgeKey(...c.nodes), c);
      if (stitch.continuity === 'smooth') smooth.set(edgeKey(...c.nodes), c);
    }
  }
  const removed = new Set(q.cells.filter(c => c.nodes.some(n => onSide(q.uv.get(n)!, side))));
  if (replacement.length !== original.length) {
    const first = new Set([...removed].flatMap(c => c.nodes));
    q.cells.filter(c => c.nodes.some(n => first.has(n))).forEach(c => removed.add(c));
  }
  const edges = new Map<string, { a: string; b: string; count: number; c: Cell }>();
  for (const c of removed)
    for (let e = 0; e < 4; e++) {
      const a = c.nodes[PERIM[e]],
        b = c.nodes[PERIM[(e + 1) % 4]],
        key = edgeKey(a, b),
        held = edges.get(key);
      if (held) held.count++;
      else edges.set(key, { a, b, count: 1, c });
    }
  const perimeter = [...edges.values()].filter(e => e.count === 1);
  const neighbors = new Map<string, string[]>();
  for (const { a, b } of perimeter) {
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }
  if (perimeter.length > 256 || [...neighbors.values()].some(ns => ns.length !== 2))
    throw new Error('Choose a simple, connected surface boundary for stitching.');
  const start = original[0],
    end = original.at(-1)!;
  const rest = [end];
  let previous = original.at(-2)!;
  while (rest.at(-1) !== start && rest.length <= perimeter.length) {
    const next = neighbors.get(rest.at(-1)!)!.find(n => n !== previous)!;
    previous = rest.at(-1)!;
    rest.push(next);
  }
  if (rest.at(-1) !== start) throw new Error('Could not trace the local stitch boundary.');
  // Keep the exact retained rim and any previous seam; only the attached side is replaced.
  for (const e of perimeter)
    if (!(onSide(q.uv.get(e.a)!, side) && onSide(q.uv.get(e.b)!, side)))
      pins.set(edgeKey(e.a, e.b), curve(e.c, e.a, e.b)!);
  // Corners can be shared with another already-stitched side. Rewire the adjacent rim endpoint too.
  const rewires = new Map([
    [start, replacement[0]],
    [end, replacement.at(-1)!],
  ]);
  for (const [a, b] of rewires)
    if (a !== b && !a.startsWith(`${q.surface.id}/`)) {
      if (len(sub(q.points.get(a)!, q.points.get(b)!)) > 1e-5)
        throw new Error('Align the endpoints where these stitched sides meet.');
      (q.junctions ??= []).push([a, b]);
    }
  for (const [a, b] of rewires)
    if (a !== b)
      for (const pin of pins.values()) {
        // A target curve already names b. Only move a source rim curve that actually
        // lost endpoint a, or the endpoint correction would deform the authoritative host.
        if (!pin.nodes.includes(a)) continue;
        pin.nodes = pin.nodes.map(n => (n === a ? b : n)) as [string, string];
        const delta = sub(q.points.get(b)!, q.points.get(a)!);
        if (pin.nodes[0] === b) {
          pin.cp = pin.cp.map((p, i) => add(p, mul(delta, 1 - i / 3)));
        } else if (pin.nodes[1] === b) pin.cp = pin.cp.map((p, i) => add(p, mul(delta, i / 3)));
      }
  const pinMap = new Map([...pins.values()].map(c => [edgeKey(...c.nodes), c]));
  let polygon = [...replacement, ...rest.slice(1, -1).map(n => rewires.get(n) ?? n)];
  if (polygon.length % 2) {
    // An odd boundary cannot be filled with quads. Split a free side rail, never an untouched host patch.
    const allCounts = new Map<string, number>();
    for (const c of q.cells)
      for (let e = 0; e < 4; e++) {
        const k = edgeKey(c.nodes[PERIM[e]], c.nodes[PERIM[(e + 1) % 4]]);
        allCounts.set(k, (allCounts.get(k) ?? 0) + 1);
      }
    let inserted = false;
    for (let i = replacement.length - 1; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      const oldA = a === replacement[0] ? start : a === replacement.at(-1) ? end : a;
      const oldB = b === replacement[0] ? start : b === replacement.at(-1) ? end : b;
      if (allCounts.get(edgeKey(oldA, oldB)) !== 1 || smooth.has(edgeKey(a, b))) continue;
      const pin = pinMap.get(edgeKey(a, b));
      if (!pin) continue;
      const cp = pin.nodes[0] === a ? pin.cp : [...pin.cp].reverse();
      const halves = splitCubic(cp[0], cp[1], cp[2], cp[3], 0.5),
        key = `${q.surface.id}/stitch:${side}/parity`;
      q.uv.set(key, q.uv.get(a)!.map((n, j) => (n + q.uv.get(b)![j]) / 2) as UV);
      q.points.set(key, halves.left[3]);
      pinMap.delete(edgeKey(a, b));
      pinMap.set(edgeKey(a, key), { nodes: [a, key], cp: halves.left, inward: [] });
      pinMap.set(edgeKey(key, b), { nodes: [key, b], cp: halves.right, inward: [] });
      polygon = [...polygon.slice(0, i + 1), key, ...polygon.slice(i + 1)];
      inserted = true;
      break;
    }
    if (!inserted)
      throw new Error(
        'These boundary counts need another split on a free surface rim. Extend the selection to a corner.',
      );
  }
  const prefix = `stitch:${side}`;
  let perimeters: string[][];
  if (replacement.length === original.length && removed.size === original.length - 1)
    perimeters = [...removed].map(c =>
      PERIM.map(i => {
        const at = original.indexOf(c.nodes[i]);
        return at < 0 ? c.nodes[i] : replacement[at];
      }),
    );
  else perimeters = transitionStrip(q, polygon, replacement, side, prefix) ?? quadrangulate(q, polygon, prefix);
  const newCells = perimeters.map((ns, i) => cellFromUV(q, ns, `${prefix}:${i}`));

  // One curve per generated edge, including exact inherited outer and host boundary cubics.
  const shared = new Map<string, Curve>(pinMap);
  const smoothHandles = new Map<string, V3>();
  for (const c of newCells)
    for (let e = 0; e < 4; e++) {
      const a = c.nodes[PERIM[e]],
        b = c.nodes[PERIM[(e + 1) % 4]],
        k = edgeKey(a, b);
      let held = shared.get(k);
      if (!held) {
        held = curve(c, a, b)!;
        shared.set(k, held);
      }
      const cps = held.nodes[0] === a ? held.cp : [...held.cp].reverse();
      CP[e].forEach((at, i) => {
        c.cp[at] = cps[i];
      });
    }
  for (const c of newCells)
    for (let e = 0; e < 4; e++) {
      const a = c.nodes[PERIM[e]],
        b = c.nodes[PERIM[(e + 1) % 4]],
        host = smooth.get(edgeKey(a, b));
      if (!host) continue;
      const reversed = host.nodes[0] !== a,
        offsets = reversed ? [...host.inward].reverse() : host.inward;
      const edge = CP[e].map(i => c.cp[i]);
      const tangents = edge.slice(1).map((p, i) => mul(sub(p, edge[i]), 3));
      const resolve = (i: 0 | 3) => {
        const h = mul(offsets[i], -1),
          t = tangents[i === 0 ? 0 : 2];
        const d = sub(c.cp[IN[e][i]], edge[i]);
        const hh = dot(h, h),
          tt = dot(t, t),
          ht = dot(h, t),
          determinant = hh * tt - ht * ht;
        if (determinant < 1e-12) return { a: 1, b: 0 };
        return {
          a: (dot(d, h) * tt - dot(d, t) * ht) / determinant,
          b: (dot(d, t) * hh - dot(d, h) * ht) / determinant,
        };
      };
      const start = resolve(0),
        end = resolve(3),
        scale = Math.max(0.01, Math.min(20, (start.a + end.a) / 2));
      // Retain tangential shear in a transition quad. A constant cross-boundary scale plus a linear
      // multiple of the quadratic seam derivative stays cubic and shares the host's complete tangent plane.
      const shear = [
        mul(tangents[0], start.b),
        add(mul(tangents[0], end.b / 3), mul(tangents[1], (2 * start.b) / 3)),
        add(mul(tangents[1], (2 * end.b) / 3), mul(tangents[2], start.b / 3)),
        mul(tangents[2], end.b),
      ];
      IN[e].forEach((at, i) => {
        c.cp[at] = add(sub(edge[i], mul(offsets[i], scale)), shear[i]);
      });
      smoothHandles.set(JSON.stringify([a, c.nodes[PERIM[(e + 3) % 4]]]), c.cp[IN[e][0]]);
      smoothHandles.set(JSON.stringify([b, c.nodes[PERIM[(e + 2) % 4]]]), c.cp[IN[e][3]]);
    }
  for (const c of newCells)
    for (let e = 0; e < 4; e++) {
      const a = c.nodes[PERIM[e]],
        b = c.nodes[PERIM[(e + 1) % 4]];
      const from = smoothHandles.get(JSON.stringify([a, b])),
        to = smoothHandles.get(JSON.stringify([b, a]));
      if (from) c.cp[CP[e][1]] = from;
      if (to) c.cp[CP[e][2]] = to;
    }
  q.cells = [...q.cells.filter(c => !removed.has(c)), ...newCells];
}

function orderedSurfaces(surfaces: SurfaceObject[]) {
  const out: SurfaceObject[] = [],
    pending = new Set<string>(),
    seen = new Set<string>(),
    byId = new Map(surfaces.map(s => [s.id, s]));
  const visit = (s: SurfaceObject) => {
    if (pending.has(s.id))
      throw new Error('This stitch would create a dependency loop. Detach the opposite stitch first.');
    if (seen.has(s.id)) return;
    pending.add(s.id);
    for (const st of s.stitches ?? [])
      if ('surface' in st.target) {
        const host = byId.get(st.target.surface);
        if (!host) throw new Error('A stitched target surface is missing.');
        visit(host);
      }
    pending.delete(s.id);
    seen.add(s.id);
    out.push(s);
  };
  surfaces.forEach(visit);
  return out;
}

const controlSync = new WeakMap<
  SurfaceObject[],
  { vertices: number[]; handles: QuadMeshDoc['edgeHandles']; quads: number[][]; stamp: number[] }
>();
function controlStamp(doc: QuadMeshDoc, surfaces = doc.surfaces ?? []) {
  const ids = nameIndex(doc.vertexIds),
    paths = surfaces.flatMap(s => [
      ...s.controls,
      ...(s.stitches ?? []).flatMap(st => ('vertices' in st.target ? [st.target.vertices] : [])),
    ]);
  return paths.flatMap(path =>
    path.flatMap((id, i) => {
      const a = ids.get(id),
        b = ids.get(path[i + 1]);
      return a === undefined
        ? [-1]
        : [
            ...readVertex(doc.vertices, a),
            ...(b === undefined
              ? []
              : [...(doc.edgeHandles?.[`${a}>${b}`] ?? []), ...(doc.edgeHandles?.[`${b}>${a}`] ?? [])]),
          ];
    }),
  );
}
function rememberControls(doc: QuadMeshDoc) {
  if (doc.surfaces?.some(s => s.stitches?.length))
    controlSync.set(doc.surfaces, {
      vertices: doc.vertices,
      handles: doc.edgeHandles,
      quads: doc.quads,
      stamp: controlStamp(doc),
    });
}

/** Keep the attached authoring boundary on its host. The controls retain independent identities so
 * detaching remains reversible, while edits are coupled by surface-stitch-controls before they reach here. */
function synchronizeStitchControls(doc: QuadMeshDoc): QuadMeshDoc {
  if (!doc.surfaces?.some(s => s.stitches?.length)) return doc;
  const cached = controlSync.get(doc.surfaces),
    stamp = controlStamp(doc);
  if (
    cached?.vertices === doc.vertices &&
    cached.handles === doc.edgeHandles &&
    cached.quads === doc.quads &&
    sameNumbers(cached.stamp, stamp)
  )
    return doc;
  let out = doc;
  const writable = () => {
    if (out === doc) out = { ...doc, vertices: doc.vertices.slice(), edgeHandles: { ...doc.edgeHandles } };
  };
  for (const original of orderedSurfaces(doc.surfaces)) {
    let surface = out.surfaces!.find(s => s.id === original.id)!;
    let changed = !!surface.seed || !!surface.guides?.some(g => g.reference);
    for (const stitch of surface.stitches ?? []) {
      let sample: (t: number) => V3;
      if ('surface' in stitch.target) {
        const ref = stitch.target,
          host = out.surfaces!.find(s => s.id === ref.surface)!;
        const charts = host.guides
          ? guideCharts(out, host)
          : (host.fitted ?? host.patches.map(p => ({ domain: p.domain, controls: p.base })));
        sample = t => chartPoint(charts, ...atSide(ref.side, ref.range[0] + t * (ref.range[1] - ref.range[0])));
      } else {
        const host = hostMesh(out, stitch.target.vertices);
        sample = t => {
          const hi = host.stations.findIndex((at, i) => i > 0 && at >= t - EPS),
            i = hi < 0 ? host.curves.length - 1 : hi - 1,
            local = (t - host.stations[i]) / (host.stations[i + 1] - host.stations[i]);
          return cubicPoint(...(host.curves[i].cp as [V3, V3, V3, V3]), local);
        };
      }
      const row = surface.guides?.findIndex(
        g => g.axis === (stitch.side[0] === 'u' ? 'V' : 'U') && Math.abs(g.at - Number(stitch.side[1])) < EPS,
      );
      if (row === undefined || row < 0) continue;
      const guide = surface.guides![row],
        names = surface.controls[row],
        [lo, hi] = stitch.range,
        at = (t: number) => sample((t - lo) / (hi - lo)),
        targets = names.flatMap((id, i) => {
          const t = guide.knots[i];
          if (t < lo - EPS || t > hi + EPS) return [];
          const position = at(t),
            index = out.vertexIds.indexOf(id);
          return sameNumbers(position, readVertex(out.vertices, index))
            ? []
            : [{ id: { kind: 'vertex' as const, vertex: id }, pos: position }];
        });
      if (targets.length) {
        writable();
        changed = true;
        setMeshControlPoints(out, targets, { followStitches: false });
      }
      for (let i = 0; i < names.length - 1; i++) {
        const a = guide.knots[i],
          b = guide.knots[i + 1];
        if (a < lo - EPS || b > hi + EPS) continue;
        const cp = interpolate([at(a), at(a + (b - a) / 3), at(a + (2 * (b - a)) / 3), at(b)]),
          x = out.vertexIds.indexOf(names[i]),
          y = out.vertexIds.indexOf(names[i + 1]);
        for (const [key, value] of [
          [`${x}>${y}`, sub(cp[1], cp[0])],
          [`${y}>${x}`, sub(cp[2], cp[3])],
        ] as const)
          if (!sameNumbers(out.edgeHandles?.[key] ?? [], value)) {
            writable();
            changed = true;
            out.edgeHandles![key] = value;
          }
      }
    }
    if (!changed) continue;
    surface = sourceGuideSurface(surface);
    const curves = readGuideCurves(out, surface),
      patches = fitSurface(compactSurfaceCharts(guideCharts(out, surface)), surface.patchSizeM).patches;
    const next = {
      ...surface,
      fitted: patches,
      evaluated: { points: curves.map(c => c.points.flat()), patchSizeM: surface.patchSizeM },
    };
    out = { ...out, surfaces: out.surfaces!.map(s => (s.id === surface.id ? next : s)) };
  }
  rememberControls(out);
  return out;
}

/** Evaluate a dependency graph first, then atomically install shared topology. No source controls are welded. */
export function evaluateSurfaceStitches(doc: QuadMeshDoc): QuadMeshDoc {
  doc = synchronizeStitchControls(doc);
  const surfaces = doc.surfaces ?? [];
  if (!surfaces.length) return doc;
  const quilts = new Map<string, Quilt>();
  // The old ring filler could also apply a source-endpoint correction to a target cubic.
  // Recover those hosts from their authored guides once when upgrading an existing ring.
  const legacyHosts = new Set(
    surfaces.flatMap(s =>
      s.outputKeys?.some(key => key.includes('/inner:'))
        ? (s.stitches ?? []).flatMap(st => ('surface' in st.target ? [st.target.surface] : []))
        : [],
    ),
  );
  for (const s of surfaces) {
    const refs = surfaces.flatMap(other =>
      (other.stitches ?? []).flatMap(st => ('surface' in st.target && st.target.surface === s.id ? [st.target] : [])),
    );
    let input = s.fitted ?? s.patches.map(p => ({ domain: p.domain, controls: p.base }));
    if (!s.fitted && s.guides && legacyHosts.has(s.id))
      input = fitSurface(compactSurfaceCharts(guideCharts(doc, s)), s.patchSizeM, {
        us: cuts(input.flatMap(p => p.domain.slice(0, 2))),
        vs: cuts(input.flatMap(p => p.domain.slice(2))),
      }).patches;
    quilts.set(s.id, natural(s, splitAnchors(input, refs)));
  }
  for (const s of orderedSurfaces(surfaces))
    for (const side of sides) {
      const stitches = s.stitches?.filter(st => st.side === side) ?? [];
      if (stitches.length) stitchSide(quilts.get(s.id)!, side, stitches, quilts, doc);
    }
  // Adjacent seams may arrive at the same source corner through different owners. Give that junction one id.
  const aliases = new Map<string, string>();
  const root = (key: string): string => (aliases.has(key) ? root(aliases.get(key)!) : key);
  const unite = (first: string, second: string) => {
    const a = root(first),
      b = root(second);
    if (a === b) return;
    if (a.startsWith('mesh:') && b.startsWith('mesh:'))
      throw new Error('Weld the existing terrain corners before stitching both boundaries to them.');
    const keep = a.startsWith('mesh:') ? a : b.startsWith('mesh:') ? b : [a, b].sort()[0];
    aliases.set(keep === a ? b : a, keep);
  };
  for (const q of quilts.values()) q.junctions?.forEach(([a, b]) => unite(a, b));
  for (const q of quilts.values()) {
    const stations = new Map<string, string>();
    for (const n of new Set(q.cells.flatMap(c => c.nodes))) {
      const uv = q.uv.get(n)!,
        station = uv.map(t => Math.round(t * 1e9)).join(',');
      const previous = stations.get(station);
      if (!previous) {
        stations.set(station, n);
        continue;
      }
      const a = root(previous),
        b = root(n);
      if (a === b) continue;
      if (len(sub(q.points.get(previous)!, q.points.get(n)!)) > 1e-5)
        throw new Error(
          'Two stitched boundaries demand different positions at their shared corner. Align those endpoints first.',
        );
      unite(a, b);
    }
  }
  for (const q of quilts.values())
    for (const c of q.cells)
      c.nodes = c.nodes.map(n => {
        const key = root(n);
        if (key !== n) {
          q.points.set(key, q.points.get(n)!);
          q.uv.set(key, q.uv.get(n)!);
        }
        return key;
      });
  const oldV = new Map<string, string>(),
    oldQ = new Map<string, string>();
  const outputQuads = new Set(surfaces.flatMap(s => s.patches.map(p => p.quad))),
    outputVertices = new Set(surfaces.flatMap(s => s.vertices));
  const meshHostNames = new Set(
    surfaces.flatMap(s => (s.stitches ?? []).flatMap(st => ('vertices' in st.target ? st.target.vertices : []))),
  );
  for (const s of surfaces) {
    if (s.outputKeys) s.outputKeys.forEach((key, i) => oldV.set(key, s.vertices[i]));
    else {
      const q = natural(
        s,
        s.patches.map(p => ({ domain: p.domain, controls: p.base })),
      );
      q.cells.forEach((cell, i) => cell.nodes.forEach((key, j) => oldV.set(key, s.patches[i].corners[j])));
    }
    const naturalKeys = s.patches.some(p => !p.key)
      ? natural(
          s,
          s.patches.map(p => ({ domain: p.domain, controls: p.base })),
        ).cells
      : [];
    s.patches.forEach((p, i) => oldQ.set(`${s.id}/${p.key ?? naturalKeys[i]?.key}`, p.quad));
  }
  const rawVertices = doc.vertices.slice(),
    rawQuads: (number[] | null)[] = doc.quads.map((q, i) => (outputQuads.has(doc.quadIds[i]) ? null : q));
  const rawVertexIds: (string | null)[] = [...doc.vertexIds],
    rawQuadIds: (string | null)[] = [...doc.quadIds];
  const vi = nameIndex(doc.vertexIds),
    qi = nameIndex(doc.quadIds),
    assigned = new Map<string, number>(),
    used = new Set<number>();
  const cells: { q: Quilt; cell: Cell; at: number }[] = [];
  const appearance = createQuadSurfaceMaps(doc, true);
  for (const q of quilts.values())
    for (const cell of q.cells) {
      const indices = cell.nodes.map(key => {
        let at = assigned.get(key);
        if (at !== undefined) return at;
        const id = key.startsWith('mesh:') ? key.slice(5) : oldV.get(key);
        at = id ? vi.get(id) : undefined;
        if (at === undefined) {
          at = rawVertices.length / 3;
          rawVertices.push(...q.points.get(key)!);
          rawVertexIds.push(null);
        } else if (!sameNumbers(rawVertices.slice(at * 3, at * 3 + 3), q.points.get(key)!))
          rawVertices.splice(at * 3, 3, ...q.points.get(key)!);
        assigned.set(key, at);
        used.add(at);
        return at;
      });
      let at = qi.get(oldQ.get(`${q.surface.id}/${cell.key}`) ?? '');
      if (at === undefined) {
        at = rawQuads.length;
        rawQuadIds.push(null);
        rawQuads.push(indices);
        const u = cell.uv.reduce((sum, p) => sum + p[0], 0) / 4,
          v = cell.uv.reduce((sum, p) => sum + p[1], 0) / 4;
        const previous = q.surface.patches.find(
          p => u >= p.domain[0] - EPS && u <= p.domain[1] + EPS && v >= p.domain[2] - EPS && v <= p.domain[3] + EPS,
        );
        const old = previous ? qi.get(previous.quad) : undefined;
        if (old !== undefined) inheritQuadSurface(doc, appearance, old, at);
      } else rawQuads[at] = indices;
      cells.push({ q, cell, at });
    }
  for (let i = 0; i < doc.quads.length; i++)
    if (
      !outputQuads.has(doc.quadIds[i]) &&
      doc.quads[i].some(
        v => outputVertices.has(doc.vertexIds[v]) && (!used.has(v) || !meshHostNames.has(doc.vertexIds[v])),
      )
    )
      throw new Error(
        'Plain geometry is attached to generated output. Detach or bake that connection before refitting.',
      );
  const valid = checkManifold(rawQuads.filter((q): q is number[] => q !== null));
  if (!valid.ok) throw new Error(valid.error);
  const result = finishMeshRewrite(doc, {
    ...doc,
    ...appearance,
    vertices: rawVertices,
    quads: rawQuads,
    vertexIds: rawVertexIds,
    quadIds: rawQuadIds,
    keepVertices: rawVertexIds.flatMap((id, i) => (id && outputVertices.has(id) && !used.has(i) ? [] : [i])),
  });
  const out = result.doc;
  // raw ids for freshly allocated cells are exposed by the surviving raw order.
  const rawCellNames = rawQuads.flatMap((q, i) => (q ? [i] : []));
  const newAt = new Map(rawCellNames.map((raw, i) => [raw, i]));
  const patches = cells.map(({ cell }) => ({ domain: cell.domain, controls: cell.cp }));
  writeCages(
    out,
    patches,
    cells.map(c => newAt.get(c.at)!),
  );
  // Adding neighbours changes automatic Bessel inference. Pin existing host patches before that can alter them.
  if (meshHostNames.size) {
    const { mesh, edgeHandle } = meshFromDoc(doc),
      outIndex = nameIndex(out.quadIds);
    const hosts = doc.quads.flatMap((quad, i) =>
      !outputQuads.has(doc.quadIds[i]) && quad.some(v => meshHostNames.has(doc.vertexIds[v])) ? [i] : [],
    );
    writeCages(
      out,
      hosts.map(i => ({ domain: [0, 1, 0, 1], controls: quadControlPoints(mesh, edgeHandle, i, doc.quadTwist?.[i]) })),
      hosts.map(i => outIndex.get(doc.quadIds[i])!),
    );
  }
  const actual = meshFromDoc(out);
  for (const { q, cell, at } of cells) {
    const index = newAt.get(at)!;
    cell.cp = quadControlPoints(actual.mesh, actual.edgeHandle, index, out.quadTwist?.[index]);
    if (!cell.key.startsWith('stitch:')) continue;
    for (const u of [0.15, 0.5, 0.85])
      for (const v of [0.15, 0.5, 0.85]) {
        const uv = [0, 1].map(
          k =>
            cell.uv[0][k] * (1 - u) * (1 - v) +
            cell.uv[1][k] * (1 - u) * v +
            cell.uv[2][k] * u * (1 - v) +
            cell.uv[3][k] * u * v,
        );
        const p = q.charts.find(
          p =>
            uv[0] >= p.domain[0] - EPS &&
            uv[0] <= p.domain[1] + EPS &&
            uv[1] >= p.domain[2] - EPS &&
            uv[1] <= p.domain[3] + EPS,
        )!;
        const reference = patchNormal(
          p.controls,
          (uv[0] - p.domain[0]) / (p.domain[1] - p.domain[0]),
          (uv[1] - p.domain[2]) / (p.domain[3] - p.domain[2]),
        );
        if (dot(reference, patchNormal(cell.cp, u, v)) <= 0)
          throw new Error(
            'This stitch folds a transition patch. Move the boundaries closer or leave more room inside the surface.',
          );
      }
  }
  out.quadLocked = { ...out.quadLocked };
  out.surfaces = surfaces.map(s => {
    const q = quilts.get(s.id)!,
      usedKeys = new Set(q.cells.flatMap(c => c.nodes)),
      own = [...assigned.keys()].filter(key => key.startsWith(`${s.id}/`) && usedKeys.has(key));
    const oldPatches = new Map(s.patches.map(p => [p.quad, p]));
    const next: SurfaceObject = {
      ...s,
      vertices: own.map(key => out.vertexIds[result.vertexMap.get(result.rawVertexIds[assigned.get(key)!]!)!]),
      outputKeys: own,
      patches: cells
        .filter(c => c.q === q)
        .map(({ cell, at }) => {
          const index = newAt.get(at)!;
          out.quadLocked![index] = true;
          const patch = {
            quad: out.quadIds[index],
            corners: out.quads[index].map(v => out.vertexIds[v]),
            key: cell.key,
            uv: cell.uv,
            domain: cell.domain,
            base: cell.cp,
          };
          const previous = oldPatches.get(patch.quad);
          // Register values arrive with canonical property order. Reusing equal metadata prevents a render
          // after undo from appearing to be another edit merely because its JSON keys were reordered.
          return previous &&
            previous.key === patch.key &&
            sameNames(previous.corners, patch.corners) &&
            sameNumbers(previous.domain, patch.domain) &&
            sameNumbers(previous.uv?.flat() ?? [], patch.uv.flat()) &&
            sameNumbers(previous.base.flat(), patch.base.flat())
            ? previous
            : patch;
        }),
    };
    if (s.stitches?.length) next.fitted = s.fitted ?? q.charts;
    else {
      delete next.fitted;
      delete next.stitches;
    }
    delete next.error;
    if (
      !s.error &&
      s.fitted === next.fitted &&
      s.stitches === next.stitches &&
      sameNames(s.vertices, next.vertices) &&
      sameNames(s.outputKeys ?? [], next.outputKeys ?? []) &&
      s.patches.length === next.patches.length &&
      next.patches.every((p, i) => p === s.patches[i])
    )
      return s;
    return next;
  });
  // Keep reference identity for topology-neutral drags so the existing incremental viewport can stream them.
  if (
    JSON.stringify(out.vertexIds) === JSON.stringify(doc.vertexIds) &&
    JSON.stringify(out.quads) === JSON.stringify(doc.quads) &&
    JSON.stringify(out.quadIds) === JSON.stringify(doc.quadIds)
  ) {
    out.vertexIds = doc.vertexIds;
    out.quadIds = doc.quadIds;
    out.quads = doc.quads;
  }
  if (out.edgeHandles) {
    const handles = out.edgeHandles;
    const keys = [...new Set([...Object.keys(doc.edgeHandles ?? {}), ...Object.keys(handles)])];
    out.edgeHandles = Object.fromEntries(
      keys
        .filter(key => handles[key] !== undefined)
        .map(key => [
          key,
          doc.edgeHandles?.[key] && sameNumbers(doc.edgeHandles[key], handles[key])
            ? doc.edgeHandles[key]
            : handles[key],
        ]),
    );
  }
  for (const key of Object.keys(out.quadTwist ?? {})) {
    const index = Number(key),
      old = doc.quadTwist?.[index],
      next = out.quadTwist![index];
    if (out.quadIds[index] === doc.quadIds[index] && old && sameNumbers(old.flat(), next.flat()))
      out.quadTwist![index] = old;
  }
  const generatedIds = new Set(out.surfaces!.flatMap(s => s.patches.map(p => p.quad)));
  const hosts = out.quads.flatMap((quad, i) =>
    !generatedIds.has(out.quadIds[i]) && quad.some(v => meshHostNames.has(out.vertexIds[v])) ? [i] : [],
  );
  const outputIndex = nameIndex(out.quadIds),
    participants = stitchParticipants(out),
    faces = [...new Set([...hosts, ...participants.flatMap(s => s.patches.map(p => outputIndex.get(p.quad)!))])],
    evaluation: StitchEvaluation = {
      vertexIds: out.vertexIds,
      quads: out.quads,
      participants,
      controls: controlStamp(out, participants),
      faces,
      shape: hostShape(out, faces),
    };
  evaluations.set(out.surfaces!, evaluation);
  for (const surface of participants) participantEvaluations.set(surface, evaluation);
  rememberControls(out);
  return out;
}

export function refreshSurfaceStitches(doc: QuadMeshDoc): QuadMeshDoc {
  if (!doc.surfaces?.some(s => s.stitches?.length)) return doc;
  const participants = stitchParticipants(doc),
    cached = evaluations.get(doc.surfaces) ?? (participants[0] && participantEvaluations.get(participants[0]));
  if (
    cached &&
    cached.vertexIds === doc.vertexIds &&
    cached.quads === doc.quads &&
    cached.participants.length === participants.length &&
    cached.participants.every((s, i) => s === participants[i]) &&
    sameNumbers(cached.controls, controlStamp(doc, participants)) &&
    sameNumbers(cached.shape, hostShape(doc, cached.faces))
  ) {
    evaluations.set(doc.surfaces, cached);
    return doc;
  }
  try {
    return evaluateSurfaceStitches(doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (doc.surfaces.every(s => !s.stitches?.length || s.error === message)) return doc;
    return { ...doc, surfaces: doc.surfaces.map(s => (s.stitches?.length ? { ...s, error: message } : s)) };
  }
}

export function addSurfaceStitch(
  doc: QuadMeshDoc,
  surface: string,
  source: Omit<SurfaceBoundary, 'surface'>,
  targetRef: SurfaceStitch['target'],
  continuity: SurfaceStitch['continuity'] = 'smooth',
): QuadMeshDoc {
  const owner = doc.surfaces?.find(s => s.id === surface);
  if (!owner) throw new Error('Select an editable surface boundary first.');
  const range = [...source.range].sort((a, b) => a - b) as [number, number];
  if (range[1] - range[0] < EPS || range.some(t => t < -EPS || t > 1 + EPS))
    throw new Error('Select a nonzero boundary span.');
  if (
    owner.stitches?.some(
      st => st.side === source.side && Math.min(st.range[1], range[1]) > Math.max(st.range[0], range[0]) + EPS,
    )
  )
    throw new Error('That boundary is already stitched. Detach it before replacing the stitch.');
  targetRef = orientStitchTarget(doc, { surface, side: source.side, range }, targetRef);
  let i = 1;
  while (owner.stitches?.some(st => st.id === `stitch:${i}`)) i++;
  const next = {
    ...owner,
    fitted: owner.fitted ?? owner.patches.map(p => ({ domain: p.domain, controls: p.base })),
    stitches: [
      ...(owner.stitches ?? []),
      { id: `stitch:${i}`, side: source.side, range, target: targetRef, continuity },
    ],
  };
  return evaluateSurfaceStitches({ ...doc, surfaces: doc.surfaces!.map(s => (s.id === surface ? next : s)) });
}

export function detachSurfaceStitches(doc: QuadMeshDoc, id: string): QuadMeshDoc {
  let out = doc;
  const surfaces = (doc.surfaces ?? []).map(s => {
    const stitches = s.id === id ? [] : s.stitches?.filter(st => !('surface' in st.target) || st.target.surface !== id);
    if ((s.stitches?.length ?? 0) === (stitches?.length ?? 0)) return s;
    const released = releaseSurfaceShape(out, s);
    out = released.doc;
    return { ...released.surface, stitches };
  });
  return evaluateSurfaceStitches({ ...out, surfaces });
}

function installedBoundary(surface: SurfaceObject, side: SurfaceSide, range: [number, number]) {
  const points = new Map<string, UV>();
  for (const p of surface.patches) {
    const uv =
      p.uv ??
      ([
        [p.domain[0], p.domain[2]],
        [p.domain[0], p.domain[3]],
        [p.domain[1], p.domain[2]],
        [p.domain[1], p.domain[3]],
      ] as UV[]);
    p.corners.forEach((id, i) => {
      if (
        onSide(uv[i], side) &&
        uv[i][axis(side)] >= Math.min(...range) - EPS &&
        uv[i][axis(side)] <= Math.max(...range) + EPS
      )
        points.set(id, uv[i]);
    });
  }
  const names = [...points.keys()].sort((a, b) => points.get(a)![axis(side)] - points.get(b)![axis(side)]);
  return range[0] > range[1] ? names.reverse() : names;
}

/** Baking keeps the actual seam. Other live surfaces now follow the baked ordinary patches. */
export function bakeSurfaceStitchLinks(doc: QuadMeshDoc, id: string): QuadMeshDoc {
  const baked = doc.surfaces?.find(s => s.id === id);
  if (!baked) return doc;
  return {
    ...doc,
    surfaces: doc.surfaces!.map(s => {
      if (s.id === id) return s;
      const stitches = (s.stitches ?? []).map(st =>
        'surface' in st.target && st.target.surface === id
          ? { ...st, target: { vertices: installedBoundary(baked, st.target.side, st.target.range) } }
          : st,
      );
      for (const st of baked.stitches ?? [])
        if ('surface' in st.target && st.target.surface === s.id) {
          const reversed = st.target.range[0] > st.target.range[1];
          const names = installedBoundary(baked, st.side, st.range);
          stitches.push({
            id: `baked:${id}:${st.id}`,
            side: st.target.side,
            range: [...st.target.range].sort((a, b) => a - b) as [number, number],
            target: { vertices: reversed ? names.reverse() : names },
            continuity: st.continuity,
          });
        }
      return {
        ...s,
        stitches,
        ...(stitches.length
          ? { fitted: s.fitted ?? s.patches.map(p => ({ domain: p.domain, controls: p.base })) }
          : {}),
      };
    }),
  };
}

export function setSurfaceStitchContinuity(
  doc: QuadMeshDoc,
  id: string,
  continuity: SurfaceStitch['continuity'],
): QuadMeshDoc {
  return evaluateSurfaceStitches({
    ...doc,
    surfaces: doc.surfaces?.map(s => ({
      ...s,
      stitches: s.stitches?.map(st =>
        s.id === id || ('surface' in st.target && st.target.surface === id) ? { ...st, continuity } : st,
      ),
    })),
  });
}

/** Source-guide edges and generated boundary edges both resolve to stable surface parameters. */
export function selectedSurfaceBoundary(
  doc: QuadMeshDoc,
  edges: readonly (readonly [string, string])[],
  exclude?: string,
): SurfaceBoundary | undefined {
  if (!edges.length) return;
  for (const s of doc.surfaces ?? []) {
    if (s.id === exclude) continue;
    // A shared corner can be picked as a source point, a generated corner or an ordinary host
    // vertex. All of those identities describe the same boundary station; a span may mix them.
    const stations = new Map(sides.map(side => [side, new Map<string, number>()]));
    for (const side of sides)
      for (const p of surfaceSideControls(doc, s, side)) stations.get(side)!.set(doc.vertexIds[p.vertex], p.at);
    for (const p of s.patches) {
      const uv =
        p.uv ??
        ([
          [p.domain[0], p.domain[2]],
          [p.domain[0], p.domain[3]],
          [p.domain[1], p.domain[2]],
          [p.domain[1], p.domain[3]],
        ] as UV[]);
      p.corners.forEach((id, i) => {
        for (const side of sides) if (onSide(uv[i], side)) stations.get(side)!.set(id, uv[i][axis(side)]);
      });
    }
    const spans: { side: SurfaceSide; a: number; b: number }[] = [];
    for (const [a, b] of edges) {
      let found: { side: SurfaceSide; a: number; b: number } | undefined;
      for (const side of sides) {
        const x = stations.get(side)!.get(a),
          y = stations.get(side)!.get(b);
        if (x !== undefined && y !== undefined && Math.abs(x - y) > EPS)
          found = { side, a: Math.min(x, y), b: Math.max(x, y) };
      }
      if (!found) break;
      spans.push(found);
    }
    if (spans.length !== edges.length || spans.some(p => p.side !== spans[0].side)) continue;
    spans.sort((a, b) => a.a - b.a);
    if (spans.some((p, i) => i > 0 && Math.abs(p.a - spans[i - 1].b) > EPS)) continue;
    return { surface: s.id, side: spans[0].side, range: [spans[0].a, spans.at(-1)!.b] };
  }
}

export function meshBoundaryChain(doc: QuadMeshDoc, edges: readonly (readonly [string, string])[]): string[] {
  if (!edges.length) throw new Error('Select matching boundary edges.');
  const neighbors = new Map<string, string[]>();
  for (const [a, b] of edges) {
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }
  const ends = [...neighbors].filter(([, ns]) => ns.length === 1);
  if (ends.length !== 2 || [...neighbors.values()].some(ns => ns.length > 2))
    throw new Error('Select one connected open chain of boundary edges.');
  const chain = [ends[0][0]];
  while (chain.length <= edges.length) {
    const next = neighbors.get(chain.at(-1)!)!.find(n => n !== chain.at(-2));
    if (!next) break;
    chain.push(next);
  }
  if (chain.length !== edges.length + 1) throw new Error('Select one connected open boundary chain.');
  hostMesh(doc, chain);
  return chain;
}

export function orientStitchTarget(
  doc: QuadMeshDoc,
  source: SurfaceBoundary,
  targetRef: SurfaceStitch['target'],
): SurfaceStitch['target'] {
  const s = doc.surfaces!.find(s => s.id === source.surface)!;
  const charts = s.fitted ?? s.patches.map(p => ({ domain: p.domain, controls: p.base }));
  const a = chartPoint(charts, ...atSide(source.side, source.range[0])),
    b = chartPoint(charts, ...atSide(source.side, source.range[1]));
  let ps: V3[];
  if ('vertices' in targetRef) ps = targetRef.vertices.map(id => readVertex(doc.vertices, doc.vertexIds.indexOf(id)));
  else {
    const host = doc.surfaces!.find(s => s.id === targetRef.surface)!;
    const cp = host.fitted ?? host.patches.map(p => ({ domain: p.domain, controls: p.base }));
    ps = targetRef.range.map(t => chartPoint(cp, ...atSide(targetRef.side, t)));
  }
  const reverse = len(sub(a, ps[0])) + len(sub(b, ps.at(-1)!)) > len(sub(a, ps.at(-1)!)) + len(sub(b, ps[0]));
  return !reverse
    ? targetRef
    : 'vertices' in targetRef
      ? { vertices: [...targetRef.vertices].reverse() }
      : { ...targetRef, range: [targetRef.range[1], targetRef.range[0]] };
}

/** Snapping over an existing patch is a copied fill, not an automatic attachment on top of that patch. */
export function automaticStitchFacesOppose(
  doc: QuadMeshDoc,
  source: SurfaceBoundary,
  targetRef: SurfaceStitch['target'],
): boolean {
  const s = doc.surfaces!.find(s => s.id === source.surface)!;
  const quilts = new Map(
    (doc.surfaces ?? []).map(s => [
      s.id,
      natural(s, s.fitted ?? s.patches.map(p => ({ domain: p.domain, controls: p.base }))),
    ]),
  );
  const host = target(quilts, doc, {
    id: '',
    side: source.side,
    range: source.range,
    target: targetRef,
    continuity: 'smooth',
  });
  const c = host.curves[Math.floor(host.curves.length / 2)];
  const at = atSide(source.side, (source.range[0] + source.range[1]) / 2),
    inside = [...at] as UV;
  inside[1 - axis(source.side)] = source.side[1] === '0' ? 0.05 : 0.95;
  const cp = s.fitted ?? s.patches.map(p => ({ domain: p.domain, controls: p.base }));
  const inward = sub(chartPoint(cp, ...inside), chartPoint(cp, ...at));
  const hostInward = mul(add(c.inward[1], c.inward[2]), 0.5);
  return inward.reduce((sum, n, i) => sum + n * hostInward[i], 0) < -EPS;
}
