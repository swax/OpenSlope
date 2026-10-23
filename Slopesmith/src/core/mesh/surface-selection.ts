import type { QuadMeshDoc, SurfaceObject } from '../doc/types';
import type { EdgeSelectMode } from './selection';

type Edge = [string, string];
const key = ([a, b]: readonly string[]) => (a < b ? `${a},${b}` : `${b},${a}`);
const edgesOf = (path: string[]): Edge[] => path.slice(1).map((b, i) => [path[i], b]);

export function surfaceGuideForEdge(doc: QuadMeshDoc, edge: readonly string[]) {
  const want = key(edge);
  for (const surface of doc.surfaces ?? [])
    if (surface.guides)
      for (let curve = 0; curve < surface.controls.length; curve++) {
        const edges = edgesOf(surface.controls[curve]),
          segment = edges.findIndex(e => key(e) === want);
        if (segment >= 0) return { surface, curve, segment, edges };
      }
  return null;
}

/** Shortest source-only path through shared crossings. Generated terrain and unrelated free edges cannot
 * divert selection at a junction; a same-curve range below never leaves that curve. */
function pathBetween(surface: SurfaceObject, from: string[], to: Set<string>): Edge[] | null {
  const adjacent = new Map<string, Edge[]>();
  for (const edge of surface.controls.flatMap(edgesOf))
    for (const id of edge) adjacent.set(id, [...(adjacent.get(id) ?? []), edge]);
  const seen = new Map<string, { parent: string; edge: Edge } | null>(from.map(id => [id, null])),
    queue = [...from];
  for (let at = 0; at < queue.length; at++) {
    const id = queue[at];
    if (to.has(id)) {
      const path: Edge[] = [];
      let next = seen.get(id);
      while (next) {
        path.unshift(next.edge);
        next = seen.get(next.parent);
      }
      return path;
    }
    for (const edge of adjacent.get(id) ?? []) {
      const other = edge[0] === id ? edge[1] : edge[0];
      if (seen.has(other)) continue;
      seen.set(other, { parent: id, edge });
      queue.push(other);
    }
  }
  return null;
}

export function surfaceEdgeSelection(
  doc: QuadMeshDoc,
  current: readonly Edge[],
  anchor: Edge | null,
  edge: Edge,
  mode: EdgeSelectMode,
) {
  const hit = surfaceGuideForEdge(doc, edge);
  if (!hit) return null;
  const merge = (incoming: Edge[]) => [...new Map([...current, ...incoming].map(e => [key(e), e])).values()];
  if (mode === 'replace') return { edges: [edge], anchor: edge };
  if (mode === 'toggle')
    return {
      edges: current.some(e => key(e) === key(edge)) ? current.filter(e => key(e) !== key(edge)) : [...current, edge],
      anchor: edge,
    };
  if (mode === 'loop' || mode === 'loopAdd')
    return { edges: mode === 'loop' ? hit.edges : merge(hit.edges), anchor: edge };
  if (!anchor) return { edges: [edge], anchor: edge };
  const start = surfaceGuideForEdge(doc, anchor);
  if (!start || start.surface !== hit.surface) return { edges: merge([edge]), anchor };
  if (start.curve === hit.curve)
    return {
      edges: merge(hit.edges.slice(Math.min(start.segment, hit.segment), Math.max(start.segment, hit.segment) + 1)),
      anchor,
    };
  const guides = hit.surface.guides!,
    a = guides[start.curve],
    b = guides[hit.curve];
  if (a.axis === b.axis) {
    const lo = Math.min(a.knots[start.segment], b.knots[hit.segment]),
      hi = Math.max(a.knots[start.segment + 1], b.knots[hit.segment + 1]);
    const band = hit.surface.controls.flatMap((path, i) => {
      const g = guides[i];
      return g.axis === a.axis && g.at >= Math.min(a.at, b.at) && g.at <= Math.max(a.at, b.at)
        ? edgesOf(path).filter((_, j) => g.knots[j] < hi - 1e-8 && g.knots[j + 1] > lo + 1e-8)
        : [];
    });
    return { edges: merge(band), anchor };
  }
  return { edges: merge([anchor, ...(pathBetween(hit.surface, anchor, new Set(edge)) ?? []), edge]), anchor };
}

export function surfacePointRange(doc: QuadMeshDoc, anchor: string, target: string): string[] | null {
  const surface = doc.surfaces?.find(
    s => s.guides && s.controls.some(row => row.includes(anchor)) && s.controls.some(row => row.includes(target)),
  );
  if (!surface) return null;
  const path = surface.controls.find(row => row.includes(anchor) && row.includes(target));
  if (path)
    return path.slice(
      Math.min(path.indexOf(anchor), path.indexOf(target)),
      Math.max(path.indexOf(anchor), path.indexOf(target)) + 1,
    );
  const edges = pathBetween(surface, [anchor], new Set([target]));
  return edges ? [...new Set([anchor, ...edges.flat(), target])] : [anchor, target];
}
