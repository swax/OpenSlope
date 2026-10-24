import type { QuadMeshDoc, SurfaceObject, SurfaceSide, V3 } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { readVertex } from './primitives';

type Station = { vertex: number; at: number };
const EPS = 1e-7;

/** Source stations, rather than generated patch divisions, identify the editable controls on a seam. */
export function surfaceSideControls(doc: QuadMeshDoc, surface: SurfaceObject, side: SurfaceSide): Station[] {
  const ids = nameIndex(doc.vertexIds),
    along = side[0] === 'u' ? 'V' : 'U',
    end = Number(side[1]),
    points = new Map<number, Station>();
  surface.guides?.forEach((guide, i) => {
    if (guide.axis === along && Math.abs(guide.at - end) < EPS) {
      surface.controls[i].forEach((id, j) => {
        const vertex = ids.get(id);
        if (vertex !== undefined) points.set(vertex, { vertex, at: guide.knots[j] });
      });
    } else if (guide.axis !== along) {
      const vertex = ids.get(end ? surface.controls[i].at(-1)! : surface.controls[i][0]);
      if (vertex !== undefined) points.set(vertex, { vertex, at: guide.at });
    }
  });
  return [...points.values()].sort((a, b) => a.at - b.at);
}

function controlLinks(doc: QuadMeshDoc) {
  const ids = nameIndex(doc.vertexIds),
    links: { a: Station[]; b: Station[] }[] = [];
  for (const surface of doc.surfaces ?? [])
    for (const stitch of surface.stitches ?? []) {
      const [lo, hi] = stitch.range;
      const a = surfaceSideControls(doc, surface, stitch.side)
        .filter(p => p.at >= lo - EPS && p.at <= hi + EPS)
        .map(p => ({ ...p, at: (p.at - lo) / (hi - lo) }));
      let b: Station[];
      if ('surface' in stitch.target) {
        const ref = stitch.target,
          target = doc.surfaces?.find(s => s.id === ref.surface);
        if (!target) continue;
        b = surfaceSideControls(doc, target, ref.side)
          .filter(p => p.at >= Math.min(...ref.range) - EPS && p.at <= Math.max(...ref.range) + EPS)
          .map(p => ({ ...p, at: (p.at - ref.range[0]) / (ref.range[1] - ref.range[0]) }));
      } else {
        const vertices = stitch.target.vertices.map(id => ids.get(id));
        if (vertices.some(v => v === undefined)) continue;
        const stations = [0];
        for (let i = 1; i < vertices.length; i++) {
          const p = readVertex(doc.vertices, vertices[i]!),
            q = readVertex(doc.vertices, vertices[i - 1]!);
          stations.push(stations[i - 1] + Math.hypot(...p.map((n, k) => n - q[k])));
        }
        if (stations.at(-1)! < EPS) continue;
        b = vertices.map((vertex, i) => ({ vertex: vertex!, at: stations[i] / stations.at(-1)! }));
      }
      links.push({ a, b: b.sort((x, y) => x.at - y.at) });
    }
  return links;
}

/** A seam is editable from either authoring cage. A complete selected span also carries intermediate
 * controls on the other side, so differing guide/ordinary-quad counts cannot leave points behind. */
export function linkedSurfaceVertexTargets(
  doc: QuadMeshDoc,
  targets: readonly { vertex: number; pos: V3 }[],
  locked: Set<number>,
): { vertex: number; pos: V3 }[] {
  if (!doc.surfaces?.some(s => s.stitches?.length) || !targets.length) return [...targets];
  const links = controlLinks(doc),
    parent = new Map<number, number>();
  const root = (v: number): number => (parent.has(v) ? root(parent.get(v)!) : v);
  for (const { a, b } of links)
    for (const p of a) {
      const match = b.find(q => Math.abs(p.at - q.at) < EPS);
      if (match && root(p.vertex) !== root(match.vertex)) parent.set(root(p.vertex), root(match.vertex));
    }
  const groups = new Map<number, number[]>();
  for (const v of new Set(links.flatMap(link => [...link.a, ...link.b].map(p => p.vertex)))) {
    const r = root(v);
    groups.set(r, [...(groups.get(r) ?? []), v]);
  }
  const blocked = new Set(
    [...groups].filter(([, group]) => group.some(v => locked.has(v))).flatMap(([, group]) => group),
  );
  const moves = new Map(
    targets
      .filter(t => !blocked.has(t.vertex))
      .map(t => {
        const old = readVertex(doc.vertices, t.vertex);
        return [t.vertex, t.pos.map((v, i) => v - old[i]) as V3] as const;
      }),
  );
  const put = (vertex: number, delta: V3) => {
    if (moves.has(vertex) || locked.has(vertex) || blocked.has(vertex)) return false;
    moves.set(vertex, delta);
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups.values()) {
      const v = group.find(v => moves.has(v));
      if (v !== undefined) for (const other of group) changed = put(other, moves.get(v)!) || changed;
    }
    for (const { a, b } of links)
      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        if (from.length < 2 || from[0].at > EPS || from.at(-1)!.at < 1 - EPS || from.some(p => !moves.has(p.vertex)))
          continue;
        for (const p of to) {
          const i = Math.max(0, Math.min(from.length - 2, from.findIndex(q => q.at >= p.at - EPS) - 1)),
            x = from[i],
            y = from[i + 1],
            t = (p.at - x.at) / (y.at - x.at),
            dx = moves.get(x.vertex)!,
            dy = moves.get(y.vertex)!;
          changed = put(p.vertex, dx.map((v, k) => v * (1 - t) + dy[k] * t) as V3) || changed;
        }
      }
  }
  return [...moves].map(([vertex, delta]) => ({
    vertex,
    pos: readVertex(doc.vertices, vertex).map((v, i) => v + delta[i]) as V3,
  }));
}
