import type { EdgeEmbeddedTJunction, QuadMeshDoc, V3 } from '../../doc/types';
import { meshId, retireMeshIds, type MeshIds } from '../../doc/ids';
import {
  buildQuadMesh, docEdgeHandles, meshAdjacency,
  type QuadMesh, type EdgeHandle, type MeshAdjacency,
} from '../topology';
import { directedEdgeKey, liveQuadEdges, readVertex, undirectedEdgeKey } from '../primitives';

/**
 * The shared op contract every topology-surgery op routes through (docs/017 "The op contract"):
 *  - Indices are stable where untouched. Ops append and delete by index; `remapIds` compacts the arrays and
 *    remaps every index-keyed sparse map. An append-only op's remap is an identity — but it routes through the
 *    shared helper anyway, the one place compaction is written and tested.
 *  - Identity rides through that compaction. `vertexIds` / `quadIds` stay index-parallel with the geometry,
 *    so a surviving element keeps its id however far its index moves, and geometry the op created is minted
 *    a fresh one (docs/039, core/doc/ids.ts). An op that needs to name a point across the compaction — the
 *    cuts, the extrusion — asks by id (`RewriteIdentity`), never by where the point used to sit.
 *  - Nothing that leaves is forgotten. A name no survivor answers to is retired as a tombstone, so what
 *    arrives for it afterwards is discarded quietly instead of resurrecting the geometry.
 *  - Topology is derived, never patched: a rewrite hands back plain `vertices` / `quads`; the consumer
 *    rebuilds adjacency via `topologyFromQuads` (topology.ts) on the next preview.
 *  - New geometry is born smooth: inserted vertices carry no `edgeHandles` override, so a fresh seam is
 *    Bessel-G1 by construction. A SPLIT edge's crease (an override on the parent) is inherited by both halves.
 *  - Manifold guard: a rewrite that would make an edge shared by 3+ quads (or a degenerate quad) is rejected,
 *    so the mesh stays a manifold-with-boundary quad complex — what the export and the pole test assume.
 */

/** Undirected edge key (endpoint order independent) — the same form topology.ts's adjacency maps use. */
export const ekey = undirectedEdgeKey;

/** A cell's up-to-four perimeter edges [A-B, B-D, D-C, C-A]; a WEDGE's collapsed D-C side (D===C) drops out —
 *  it's a private wall, never a shared seam, so it never counts toward the shared-edge tally. */
export const quadEdges = liveQuadEdges;

/** A valid cell is a proper quad (4 distinct corners) or a WEDGE — the reference's collapsed-edge triangle,
 *  stored `[A,B,C,C]` with ONLY the last two corners fused (docs/017 S3). Any other collapse (a different
 *  fused pair, or a three-way collapse) is a degenerate the surgery kit must never emit. */
export const isValidCell = (c: number[]): boolean => {
  const s = new Set(c).size;
  return s === 4 || (s === 3 && c[2] === c[3]);
};

/**
 * Manifold guard: reject a rewrite whose quads would leave a non-manifold complex. Two failure modes matter
 * for the surgery kit — an edge shared by 3+ quads (a fin), and a degenerate cell (neither a proper quad nor a
 * clean `[A,B,C,C]` wedge). The wedge is allowed (it's how a bounded loop terminates, docs/017 S3); its
 * collapsed side is excluded from the shared-edge count so it doesn't read as a fin.
 */
export function checkManifold(quads: number[][]): { ok: boolean; error?: string } {
  const count = new Map<string, number>();
  for (const c of quads) {
    if (!isValidCell(c)) return { ok: false, error: 'Surgery would collapse a cell to a degenerate — rejected.' };
    for (const [a, b] of quadEdges(c)) { const k = ekey(a, b); count.set(k, (count.get(k) ?? 0) + 1); }
  }
  for (const n of count.values()) if (n > 2) return { ok: false, error: 'Surgery would make an edge shared by 3+ quads (non-manifold) — rejected.' };
  return { ok: true };
}

/** Optional per-quad / per-edge sparse maps a doc carries — remapped alongside the geometry. */
export interface MeshMaps {
  freeEdges?: [number, number][];
  tJunctions?: EdgeEmbeddedTJunction[];
  edgeHandles?: Record<string, V3>;
  quadPaint?: Record<number, number>;
  quadTex?: Record<number, string>;
  quadOrient?: Record<number, { rot: number; mirror: boolean }>;
  quadLocked?: Record<number, true>;
  quadTwist?: Record<number, [V3, V3, V3, V3]>;
  quadLabels?: Record<number, string[]>;
}

export type MeshRewrite = {
  vertices: number[];
  quads: (number[] | null)[];
  keepVertices?: readonly number[];
  /** Identity for the rewritten arrays, index-parallel with `vertices` / `quads`. An entry that is absent or
   *  `null` names geometry this op created and mints a fresh id from `nextId`. `finishMeshRewrite` seeds all
   *  three from the base document, so an op that only appends and deletes by index supplies none of them; an
   *  op that REBUILDS its quads array (the cuts) supplies `quadIds` to say which piece keeps the source's. */
  vertexIds?: readonly (string | null)[];
  quadIds?: readonly (string | null)[];
  nextId?: number;
} & MeshMaps;

export interface QuadSurfaceMaps {
  quadPaint?: Record<number, number>;
  quadTex?: Record<number, string>;
  quadOrient?: Record<number, { rot: number; mirror: boolean }>;
  quadLocked?: Record<number, true>;
  quadLabels?: Record<number, string[]>;
}

/** Allocate the sparse per-patch maps for a rewrite, either empty or seeded with the current ids. */
export function createQuadSurfaceMaps(doc: QuadMeshDoc, copy = false): QuadSurfaceMaps {
  return {
    quadPaint: doc.quadPaint ? (copy ? { ...doc.quadPaint } : {}) : undefined,
    quadTex: doc.quadTex ? (copy ? { ...doc.quadTex } : {}) : undefined,
    quadOrient: doc.quadOrient ? (copy ? { ...doc.quadOrient } : {}) : undefined,
    quadLocked: doc.quadLocked ? (copy ? { ...doc.quadLocked } : {}) : undefined,
    quadLabels: doc.quadLabels ? (copy ? Object.fromEntries(Object.entries(doc.quadLabels).map(([key, labels]) => [key, [...labels]])) : {}) : undefined,
  };
}

/** Copy paint, texture and tile orientation from one source patch to a rewritten patch id. */
export function inheritQuadSurface(doc: QuadMeshDoc, maps: QuadSurfaceMaps, source: number, target: number): void {
  if (maps.quadPaint && doc.quadPaint?.[source] !== undefined) maps.quadPaint[target] = doc.quadPaint[source];
  if (maps.quadTex && doc.quadTex?.[source] !== undefined) maps.quadTex[target] = doc.quadTex[source];
  if (maps.quadOrient && doc.quadOrient?.[source] !== undefined) maps.quadOrient[target] = doc.quadOrient[source];
  if (maps.quadLocked && doc.quadLocked?.[source] === true) maps.quadLocked[target] = true;
  if (maps.quadLabels && doc.quadLabels?.[source]?.length) maps.quadLabels[target] = [...doc.quadLabels[source]];
}

/** Vertex ids authored as standalone points rather than referenced by a patch or free edge. Topology ops keep
 * these pre-existing points unless Delete explicitly names them; otherwise an unrelated compaction would
 * silently erase valid clipboard/create output. */
export function looseVertexIds(doc: Pick<QuadMeshDoc, 'vertices' | 'quads' | 'freeEdges'>): number[] {
  const referenced = new Set<number>();
  for (const quad of doc.quads) for (const vertex of quad) referenced.add(vertex);
  for (const edge of doc.freeEdges ?? []) for (const vertex of edge) referenced.add(vertex);
  const out: number[] = [];
  for (let vertex = 0; vertex < doc.vertices.length / 3; vertex++) if (!referenced.has(vertex)) out.push(vertex);
  return out;
}

/**
 * Where the vertices a rewrite touched ended up, addressed by name (docs/039).
 *
 * An op works in its own pre-compaction numbering — the base document's indices, plus whatever it appended —
 * and compaction moves all of that. `rawVertexIds` names every point in that working numbering, minted ids
 * included, so an op can name a point it has just invented; `vertexMap` says where a name is now. A name
 * `vertexMap` does not answer for is one the rewrite removed, which is the document's tombstone.
 */
export interface RewriteIdentity {
  /** The name of each vertex in the rewrite's own numbering; absent where the rewrite dropped the point. */
  rawVertexIds: readonly (string | undefined)[];
  /** Name → index in the finished document. */
  vertexMap: ReadonlyMap<string, number>;
}

/** Where the point the rewrite knew as `raw` ended up, or undefined once it is gone. */
export function locateVertex(identity: RewriteIdentity, raw: number): number | undefined {
  const id = identity.rawVertexIds[raw];
  return id === undefined ? undefined : identity.vertexMap.get(id);
}

/**
 * Compact a working mesh after an op: drop the deleted quads (a `null` hole in `quads`) and any vertex no
 * surviving quad or free edge references, renumber both to a dense 0..n range, and carry every index-keyed sparse map onto
 * the new indices. Surviving quads / vertices keep their relative order (ascending old index), so indices only shift
 * PAST a deletion — untouched geometry keeps its index, and with no deletions this is a pure identity. This is
 * the ONE compaction pass docs/017 mandates every op share; unit-tested once against a synthetic deletion.
 *
 * `vertexIds` / `quadIds` come out index-parallel with the compacted arrays: a survivor carries the id it
 * arrived with, and anything the op created is minted from `nextId` — vertices first, then quads, in index
 * order, so the same rewrite always mints the same ids.
 */
export function remapIds(raw: MeshRewrite):
  ({ vertices: number[]; quads: number[][] } & RewriteIdentity & MeshIds & MeshMaps) {
  const survivors: { old: number; corners: number[] }[] = [];
  raw.quads.forEach((c, i) => { if (c) survivors.push({ old: i, corners: c }); });
  let nextId = raw.nextId ?? 0;
  const idAt = (source: readonly (string | null)[] | undefined, index: number) => source?.[index] ?? meshId(nextId++);

  // used vertices = every surviving quad corner or free-edge endpoint plus explicitly preserved loose points;
  // keep ascending old order (stable compaction)
  const used = new Set<number>();
  for (const s of survivors) for (const v of s.corners) used.add(v);
  for (const [a, b] of raw.freeEdges ?? []) {
    if (a !== b && a >= 0 && b >= 0 && a < raw.vertices.length / 3 && b < raw.vertices.length / 3) { used.add(a); used.add(b); }
  }
  for (const vertex of raw.keepVertices ?? [])
    if (Number.isInteger(vertex) && vertex >= 0 && vertex < raw.vertices.length / 3) used.add(vertex);
  const oldToNewV = new Map<number, number>();
  const vertices: number[] = [], vertexIds: string[] = [];
  const vcount = raw.vertices.length / 3;
  const rawVertexIds: (string | undefined)[] = new Array(vcount);
  const vertexMap = new Map<string, number>();
  for (let v = 0; v < vcount; v++) {
    if (!used.has(v)) continue;
    const at = vertices.length / 3;
    oldToNewV.set(v, at);
    vertices.push(...readVertex(raw.vertices, v));
    const id = idAt(raw.vertexIds, v);
    rawVertexIds[v] = id;
    vertexIds.push(id);
    vertexMap.set(id, at);
  }

  const oldToNewQ = new Map<number, number>();
  const quads: number[][] = survivors.map((s, ni) => { oldToNewQ.set(s.old, ni); return s.corners.map(v => oldToNewV.get(v)!); });
  const quadIds: string[] = survivors.map(s => idAt(raw.quadIds, s.old));
  const freeEdges: [number, number][] = [];
  const seenFreeEdges = new Set<string>();
  for (const [a, b] of raw.freeEdges ?? []) {
    const na = oldToNewV.get(a), nb = oldToNewV.get(b);
    if (na === undefined || nb === undefined || na === nb) continue;
    const edge: [number, number] = na < nb ? [na, nb] : [nb, na], key = `${edge[0]},${edge[1]}`;
    if (!seenFreeEdges.has(key)) { seenFreeEdges.add(key); freeEdges.push(edge); }
  }

  const remapQuadMap = <T>(m?: Record<number, T>): Record<number, T> | undefined => {
    if (!m) return undefined;
    const out: Record<number, T> = {}; let any = false;
    for (const k in m) { const nq = oldToNewQ.get(+k); if (nq !== undefined) { out[nq] = m[k]; any = true; } }
    return any ? out : undefined;
  };
  // Creases are carried by the EDGES that own them, not by taking their keys apart: walk the rewrite's own
  // seams and free edges and pick up the override each direction holds. So a handle key is only ever written
  // here, never read back apart — which is what keeps a crease from depending on the shape of its own key
  // (docs/039) — and a crease whose edge the rewrite dissolved goes with the edge.
  let edgeHandles: Record<string, V3> | undefined;
  if (raw.edgeHandles) {
    const kept: Record<string, V3> = {};
    const carry = (from: number, to: number) => {
      const offset = raw.edgeHandles![directedEdgeKey(from, to)];
      if (offset === undefined) return;
      const nf = oldToNewV.get(from), nt = oldToNewV.get(to);
      if (nf !== undefined && nt !== undefined) kept[directedEdgeKey(nf, nt)] = offset;
    };
    for (const s of survivors) for (const [a, b] of quadEdges(s.corners)) { carry(a, b); carry(b, a); }
    for (const [a, b] of raw.freeEdges ?? []) { carry(a, b); carry(b, a); }
    if (Object.keys(kept).length) edgeHandles = kept;
  }
  const liveEdges = new Set<string>();
  for (const q of quads) for (const [a, b] of liveQuadEdges(q)) liveEdges.add(ekey(a, b));
  for (const [a, b] of freeEdges) liveEdges.add(`${a},${b}`);
  const tJunctions: EdgeEmbeddedTJunction[] = [], seenTJunctions = new Set<string>();
  for (const node of raw.tJunctions ?? []) {
    const vertex = oldToNewV.get(node.vertex), a = oldToNewV.get(node.edge[0]), b = oldToNewV.get(node.edge[1]);
    if (vertex === undefined || a === undefined || b === undefined || vertex === a || vertex === b || a === b
      || !Number.isFinite(node.t) || node.t <= 1e-3 || node.t >= 1 - 1e-3) continue;
    const edgeKey = `${Math.min(a, b)},${Math.max(a, b)}`, key = `${vertex}:${edgeKey}`;
    if (!liveEdges.has(edgeKey) || seenTJunctions.has(key)) continue;
    seenTJunctions.add(key); tJunctions.push({ vertex, edge: [a, b], t: node.t });
  }
  return { vertices, quads, vertexIds, quadIds, nextId, rawVertexIds, vertexMap,
    freeEdges: freeEdges.length ? freeEdges : undefined, tJunctions, edgeHandles,
    quadPaint: remapQuadMap(raw.quadPaint), quadTex: remapQuadMap(raw.quadTex),
    quadOrient: remapQuadMap(raw.quadOrient), quadLocked: remapQuadMap(raw.quadLocked),
    quadTwist: remapQuadMap(raw.quadTwist), quadLabels: remapQuadMap(raw.quadLabels) };
}

/**
 * Compact a completed topology rewrite and consistently apply every optional mesh map to a new document.
 *
 * Whatever the rewrite ended up without is retired on the way out: a name in the base document that no
 * survivor answers to becomes a tombstone, so an id-addressed thing arriving for it later is discarded
 * quietly rather than resurrecting the geometry (docs/039).
 */
export function finishMeshRewrite(base: QuadMeshDoc, raw: MeshRewrite): { doc: QuadMeshDoc } & RewriteIdentity {
  const compact = remapIds({
    ...raw,
    vertexIds: raw.vertexIds ?? base.vertexIds,
    quadIds: raw.quadIds ?? base.quadIds,
    nextId: raw.nextId ?? base.nextId,
  });
  const doc: QuadMeshDoc = { ...base, vertices: compact.vertices, quads: compact.quads,
    vertexIds: compact.vertexIds, quadIds: compact.quadIds, nextId: compact.nextId };
  assignFreeEdges(doc, compact.freeEdges);
  assignTJunctions(doc, compact.tJunctions);
  assignMap(doc, 'edgeHandles', compact.edgeHandles);
  assignMap(doc, 'quadPaint', compact.quadPaint);
  assignMap(doc, 'quadTex', compact.quadTex);
  assignMap(doc, 'quadOrient', compact.quadOrient);
  assignMap(doc, 'quadLocked', compact.quadLocked);
  assignMap(doc, 'quadTwist', compact.quadTwist);
  assignMap(doc, 'quadLabels', compact.quadLabels);
  const survived = new Set([...compact.vertexIds, ...compact.quadIds]);
  retireMeshIds(doc, [...base.vertexIds, ...base.quadIds].filter(id => !survived.has(id)));
  return { doc, rawVertexIds: compact.rawVertexIds, vertexMap: compact.vertexMap };
}

/** Set or delete an optional doc map after a rewrite (undefined ⇒ the map is now empty, so drop the key). */
export function assignMap<K extends 'edgeHandles' | 'quadPaint' | 'quadTex' | 'quadOrient' | 'quadLocked' | 'quadTwist' | 'quadLabels'>(doc: QuadMeshDoc, key: K, value: QuadMeshDoc[K] | undefined) {
  if (value) doc[key] = value; else delete doc[key];
}

export function assignFreeEdges(doc: QuadMeshDoc, edges: [number, number][] | undefined) {
  if (edges?.length) doc.freeEdges = edges; else delete doc.freeEdges;
}

export function assignTJunctions(doc: QuadMeshDoc, nodes: EdgeEmbeddedTJunction[] | undefined) {
  doc.tJunctions = nodes ?? [];
}

/** Build the mesh + adjacency + edge-handle context a loop cut needs from a doc — the commit side's
 *  one-stop derive (the viewport caches its own from the live preview). */
export function meshContext(doc: QuadMeshDoc): { mesh: QuadMesh; adj: MeshAdjacency; edgeHandle: EdgeHandle } {
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  return { mesh, adj: meshAdjacency(mesh), edgeHandle: docEdgeHandles(mesh, doc) };
}
