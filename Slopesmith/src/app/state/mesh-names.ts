import type { QuadMeshDoc } from '../../core/doc/types';
import type { MeshNaming } from '../../core/mesh/selection';
import type { MeshControlPointId } from '../../core/mesh/control-points';
import type { SurfaceCutPoint } from '../../core/mesh/ops';
import type { EdgeCrossing } from '../../core/mesh/edge-crossings';
import type { CoincidentVertices } from '../../core/mesh/coincident-vertices';

/**
 * The editor's id⇄index boundary (docs/039).
 *
 * Everything the store remembers about the authored mesh — which corner is selected, which sub-cage is
 * pinned, what the clipboard holds, what a frozen drag plan is about to move — names its geometry by the
 * document's own stable ids. Everything that RENDERS or COMPUTES works on array indices, because an index is
 * a direct subscript and the preview, the tessellation, the pure ops and the picking are all written against
 * one. This module is where the two meet: resolve on the way in, name on the way out.
 *
 * That split is what makes a selection survive an edit. A topology op renumbers the arrays, so an index kept
 * across one addresses different terrain afterwards; an id does not move. A name the document no longer
 * carries resolves to nothing and is dropped quietly — the geometry it named is gone, so there is nothing to
 * select, and refusing would be refusing a selection for having been made before a delete.
 */

/** A vertex, a quad and an undirected edge, named the way the document names them. */
export type VertexName = string;
export type QuadName = string;
export type NamedEdge = [VertexName, VertexName];

/** A point of a provisional surface cut, named — an existing vertex, or a fraction along one cubic edge. */
export type NamedSurfaceCutPoint = { vertex: VertexName } | { edge: NamedEdge; t: number };

/** The two diagnostics a click can park on the store, named by the geometry they report on. */
export type NamedEdgeCrossing = Omit<EdgeCrossing, 'edges'> & { edges: [NamedEdge, NamedEdge] };
export type NamedCoincidentVertices = Omit<CoincidentVertices, 'vertices'> & { vertices: [VertexName, VertexName] };

/** Both ends of an edge in canonical order, so one undirected edge has exactly one named form. Ids are
 *  opaque strings, so the order is theirs rather than the array positions they happen to sit at today. */
export const canonicalNamedEdge = (a: VertexName, b: VertexName): NamedEdge => a <= b ? [a, b] : [b, a];

// The id→index map docs/039 has the document rebuild on load, cached per identity array. Every op hands back
// fresh arrays, so the cache turns over with the topology; the size check catches an in-place append.
const lookups = new WeakMap<readonly string[], Map<string, number>>();
function lookup(ids: readonly string[]): Map<string, number> {
  const cached = lookups.get(ids);
  if (cached && cached.size === ids.length) return cached;
  const at = new Map<string, number>();
  ids.forEach((id, index) => at.set(id, index));
  lookups.set(ids, at);
  return at;
}

export const vertexIndex = (doc: QuadMeshDoc, name: VertexName): number | null =>
  lookup(doc.vertexIds).get(name) ?? null;
export const quadIndex = (doc: QuadMeshDoc, name: QuadName): number | null =>
  lookup(doc.quadIds).get(name) ?? null;
export const vertexName = (doc: QuadMeshDoc, index: number): VertexName | null => doc.vertexIds[index] ?? null;
export const quadName = (doc: QuadMeshDoc, index: number): QuadName | null => doc.quadIds[index] ?? null;

/** How the authored mountain names its vertices / its quads — what the shared selection and clipboard
 *  helpers take so they serve this surface and the index-named reference from one implementation. */
export const vertexNaming = (doc: QuadMeshDoc): MeshNaming<VertexName> => ({
  index: name => vertexIndex(doc, name),
  name: index => vertexName(doc, index),
  canonical: canonicalNamedEdge,
});
export const quadNaming = (doc: QuadMeshDoc): MeshNaming<QuadName> => ({
  index: name => quadIndex(doc, name),
  name: index => quadName(doc, index),
  canonical: canonicalNamedEdge,
});

/** Name a set of live indices. Anything the mesh does not carry is skipped rather than named. */
export const vertexNames = (doc: QuadMeshDoc, indices: Iterable<number>): VertexName[] =>
  [...indices].flatMap(index => vertexName(doc, index) ?? []);
export const quadNames = (doc: QuadMeshDoc, indices: Iterable<number>): QuadName[] =>
  [...indices].flatMap(index => quadName(doc, index) ?? []);

/** Resolve names back onto this document, dropping every one it no longer carries. */
export const vertexIndices = (doc: QuadMeshDoc, names: Iterable<VertexName>): number[] =>
  [...names].flatMap(name => vertexIndex(doc, name) ?? []);
export const quadIndices = (doc: QuadMeshDoc, names: Iterable<QuadName>): number[] =>
  [...names].flatMap(name => quadIndex(doc, name) ?? []);

export function namedEdge(doc: QuadMeshDoc, edge: readonly [number, number]): NamedEdge | null {
  const a = vertexName(doc, edge[0]), b = vertexName(doc, edge[1]);
  return a === null || b === null ? null : canonicalNamedEdge(a, b);
}

export function edgeIndex(doc: QuadMeshDoc, edge: readonly [VertexName, VertexName]): [number, number] | null {
  const a = vertexIndex(doc, edge[0]), b = vertexIndex(doc, edge[1]);
  return a === null || b === null ? null : a < b ? [a, b] : [b, a];
}

export const namedEdges = (doc: QuadMeshDoc, edges: Iterable<readonly [number, number]>): NamedEdge[] =>
  [...edges].flatMap(edge => { const named = namedEdge(doc, edge); return named ? [named] : []; });
export const edgeIndices = (doc: QuadMeshDoc, edges: Iterable<readonly [VertexName, VertexName]>): [number, number][] =>
  [...edges].flatMap(edge => { const at = edgeIndex(doc, edge); return at ? [at] : []; });

/** A directed edge keeps its direction: a crease handle belongs to the end that owns it. */
export function directedEdgeIndex(doc: QuadMeshDoc, from: VertexName, to: VertexName): [number, number] | null {
  const a = vertexIndex(doc, from), b = vertexIndex(doc, to);
  return a === null || b === null ? null : [a, b];
}

/** A control point resolved onto this document, or null when it names geometry the mesh no longer carries. */
export function controlPointIndex(doc: QuadMeshDoc, id: MeshControlPointId): MeshControlPointId<number> | null {
  if (id.kind === 'vertex') {
    const vertex = vertexIndex(doc, id.vertex);
    return vertex === null ? null : { kind: 'vertex', vertex };
  }
  if (id.kind === 'edge') {
    const from = vertexIndex(doc, id.from), to = vertexIndex(doc, id.to);
    return from === null || to === null ? null : { kind: 'edge', from, to };
  }
  const quad = quadIndex(doc, id.quad);
  return quad === null ? null : { kind: 'twist', quad, corner: id.corner };
}

export const controlPointIndices = (doc: QuadMeshDoc, ids: Iterable<MeshControlPointId>): MeshControlPointId<number>[] =>
  [...ids].flatMap(id => controlPointIndex(doc, id) ?? []);

/** Every vertex a control-point selection puts a name on — the corners it holds directly plus the corners
 *  that own its floating tangents and interiors, which is what the bulk crease / smooth tools act on. */
export const controlPointVertexNames = (ids: Iterable<MeshControlPointId>): VertexName[] =>
  [...ids].flatMap(id => id.kind === 'vertex' ? [id.vertex] : []);

export function namedSurfaceCutPoint(doc: QuadMeshDoc, point: SurfaceCutPoint): NamedSurfaceCutPoint | null {
  if ('vertex' in point) {
    const vertex = vertexName(doc, point.vertex);
    return vertex === null ? null : { vertex };
  }
  const edge = namedEdge(doc, point.edge);
  return edge === null ? null : { edge, t: point.t };
}

export function surfaceCutPointIndex(doc: QuadMeshDoc, point: NamedSurfaceCutPoint): SurfaceCutPoint | null {
  if ('vertex' in point) {
    const vertex = vertexIndex(doc, point.vertex);
    return vertex === null ? null : { vertex };
  }
  const edge = edgeIndex(doc, point.edge);
  return edge === null ? null : { edge, t: point.t };
}

export const namedSurfaceCutPath = (doc: QuadMeshDoc, path: readonly SurfaceCutPoint[]): NamedSurfaceCutPoint[] =>
  path.flatMap(point => namedSurfaceCutPoint(doc, point) ?? []);
export const surfaceCutPathIndices = (doc: QuadMeshDoc, path: readonly NamedSurfaceCutPoint[]): SurfaceCutPoint[] =>
  path.flatMap(point => surfaceCutPointIndex(doc, point) ?? []);

export function namedEdgeCrossing(doc: QuadMeshDoc, crossing: EdgeCrossing): NamedEdgeCrossing | null {
  const first = namedEdge(doc, crossing.edges[0]), second = namedEdge(doc, crossing.edges[1]);
  return first && second ? { ...crossing, edges: [first, second] } : null;
}

export function edgeCrossingIndex(doc: QuadMeshDoc, crossing: NamedEdgeCrossing): EdgeCrossing | null {
  const first = edgeIndex(doc, crossing.edges[0]), second = edgeIndex(doc, crossing.edges[1]);
  return first && second ? { ...crossing, edges: [first, second] } : null;
}

export function namedCoincidentVertices(doc: QuadMeshDoc, pair: CoincidentVertices): NamedCoincidentVertices | null {
  const a = vertexName(doc, pair.vertices[0]), b = vertexName(doc, pair.vertices[1]);
  return a !== null && b !== null ? { ...pair, vertices: [a, b] } : null;
}

export function coincidentVertexIndices(doc: QuadMeshDoc, pair: NamedCoincidentVertices): [number, number] | null {
  const a = vertexIndex(doc, pair.vertices[0]), b = vertexIndex(doc, pair.vertices[1]);
  return a !== null && b !== null ? [a, b] : null;
}
