import type { EdgeEmbeddedTJunction, LabelDefinition, QuadMeshDoc, V3 } from '../doc/types';
import { appendMeshIds } from '../doc/ids';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles, quadControlPoints, type EdgeHandle, type QuadMesh } from './topology';
import type { MeshNaming } from './selection';
import { add, sub } from '../math/vec';
import { nextLabelId } from '../doc/labels';

/**
 * Slopesmith's internal vertex clipboard. Vertices are stored in their eventual authored/world data frame;
 * quads and every sparse shape/paint map use clipboard-local ids, so a paste is a simple append and re-key.
 * Every selected vertex enters the clipboard. Selected edges and fully enclosed patches bring their topology;
 * lone points remain loose vertices.
 */
export interface MeshVertexClipboard {
  version: 1;
  vertices: number[];
  quads: number[][];
  freeEdges?: [number, number][];
  tJunctions?: EdgeEmbeddedTJunction[];
  edgeHandles?: Record<string, V3>;
  quadPaint?: Record<number, number>;
  quadTex?: Record<number, string>;
  quadOrient?: Record<number, { rot: number; mirror: boolean }>;
  quadLocked?: Record<number, true>;
  quadTwist?: Record<number, [V3, V3, V3, V3]>;
  quadLabels?: Record<number, string[]>;
  /** Definitions used by `quadLabels`, so a clipboard can be pasted into a document that lacks them. */
  labels?: LabelDefinition[];
}

export interface MeshClipboardTextContext {
  source: 'authored' | 'reference';
  /** Loaded reference level, when the copied geometry came from the read-only reference quilt. */
  level?: string;
  /** Translation already folded into a reference clipboard's vertex positions. Subtract it for native map space. */
  referenceOffset?: V3;
}

/**
 * A portable, human-readable twin of Slopesmith's session-local mesh clipboard. The editor keeps the compact
 * `MeshVertexClipboard` for its own Paste command; this form is written as `text/plain` so a reference edge
 * study can be pasted into a text editor, issue, or chat without losing the exact cubic boundary curves.
 */
export function meshClipboardText(clip: MeshVertexClipboard, context: MeshClipboardTextContext): string {
  const vertices = Array.from({ length: clip.vertices.length / 3 }, (_, i) =>
    clip.vertices.slice(i * 3, i * 3 + 3) as V3);
  const edges = (clip.freeEdges ?? []).map(([from, to]) => {
    const fromHandle = clip.edgeHandles?.[`${from}>${to}`];
    const toHandle = clip.edgeHandles?.[`${to}>${from}`];
    return {
      vertices: [from, to] as [number, number],
      // These are the exact p0..p3 controls of the selected boundary cubic, not sampled points.
      bezier: fromHandle && toHandle
        ? [vertices[from], add(vertices[from], fromHandle), add(vertices[to], toHandle), vertices[to]]
        : null,
    };
  });
  const selection: Record<string, unknown> = { vertices, edges, patches: clip.quads };
  if (clip.tJunctions?.length) selection.tJunctions = clip.tJunctions;
  if (clip.quadPaint && Object.keys(clip.quadPaint).length) selection.patchSurfaces = clip.quadPaint;
  if (clip.quadTex && Object.keys(clip.quadTex).length) selection.patchTextures = clip.quadTex;
  if (clip.quadOrient && Object.keys(clip.quadOrient).length) selection.patchOrientations = clip.quadOrient;
  if (clip.quadLocked && Object.keys(clip.quadLocked).length) selection.lockedPatches = Object.keys(clip.quadLocked).map(Number);
  if (clip.quadTwist && Object.keys(clip.quadTwist).length) selection.patchTwist = clip.quadTwist;
  if (clip.quadLabels && Object.keys(clip.quadLabels).length) selection.patchLabels = clip.quadLabels;
  if (clip.labels?.length) selection.labels = clip.labels;

  return JSON.stringify({
    format: 'slopesmith-mesh-selection',
    version: 1,
    source: context.source,
    ...(context.level ? { referenceLevel: context.level } : {}),
    ...(context.referenceOffset ? { referenceOffset: context.referenceOffset } : {}),
    coordinates: {
      space: 'Slopesmith editor/data space',
      units: 'metres',
      upAxis: 'Y',
      ...(context.source === 'reference'
        ? { note: 'Vertex positions include referenceOffset; subtract it to recover native reference-map coordinates.' }
        : {}),
    },
    selection,
  }, null, 2);
}

/** A topology-neutral source: authored and reference meshes both provide this same shape. The selection
 *  arrives in whatever the surface calls its geometry — stable ids on the authored mountain, indices on the
 *  read-only reference — and `naming` is what resolves it onto `mesh` (docs/039). */
export interface MeshVertexCopySource<Id = string> {
  mesh: QuadMesh;
  naming: MeshNaming<Id>;
  /** How the selection names QUADS. One document keeps two tables, so a mountain hands in both; the
   *  reference names everything by index and omits this, taking `naming` for quads as well. */
  quadNaming?: MeshNaming<Id>;
  selectedVertices: readonly Id[];
  /** Undefined derives enclosed patches from a corner selection; [] forces point/edge-only; names copy exact surfaces. */
  selectedQuads?: readonly Id[];
  /** Undefined derives every selected mesh connection; an explicit list preserves exactly the selected edges. */
  selectedEdges?: readonly (readonly [Id, Id])[];
  edgeHandle: EdgeHandle;
  /** Translation from source-local coordinates into the authored/world data frame (the reference offset). */
  offset?: V3;
  /** Exact 16-point cage for a source quad. Supplying it preserves interior twist as well as its boundary. */
  controls?: (quad: number) => readonly V3[];
  paint?: (quad: number) => number | undefined;
  texture?: (quad: number) => string | undefined;
  orientation?: (quad: number) => { rot: number; mirror: boolean } | undefined;
  locked?: (quad: number) => boolean;
  labels?: (quad: number) => readonly string[] | undefined;
  labelDefinitions?: readonly LabelDefinition[];
  tJunctions?: readonly EdgeEmbeddedTJunction[];
}

const EDGES: readonly (readonly [number, number])[] = [[0, 1], [1, 3], [3, 2], [2, 0]];
const INTERIOR = [5, 6, 9, 10] as const;
const moved = (p: readonly number[], o: V3): V3 => [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
const hasVector = (v: V3) => v.some(n => Math.abs(n) > 1e-10);

/**
 * Capture selected mesh vertices through one path for both the authored mountain and the read-only reference.
 * Every selected vertex is copied. Fully enclosed quads are copied as well; their effective edge handles are
 * pinned into the clipboard, making the pasted boundary independent of neighbours that were not copied, and
 * exact source controls recover their four interior twist offsets so each complete patch remains unchanged.
 */
export function copyMeshVertices<Id>(source: MeshVertexCopySource<Id>): MeshVertexClipboard | null {
  const { naming } = source;
  const at = (name: Id): number | null => {
    const index = naming.index(name);
    return index !== null && Number.isInteger(index) && index >= 0 ? index : null;
  };
  const selected = [...new Set(source.selectedVertices.flatMap(name => at(name) ?? []))]
    .filter(i => i < source.mesh.vertexCount)
    .sort((a, b) => a - b);
  if (!selected.length) return null;

  const quadNaming = source.quadNaming ?? naming;
  const quadAt = (name: Id): number | null => {
    const index = quadNaming.index(name);
    return index !== null && Number.isInteger(index) && index >= 0 ? index : null;
  };
  const selectedSet = new Set(selected);
  const sourceQuads = source.selectedQuads === undefined
    ? source.mesh.quads.flatMap((quad, q) => quad.every(id => selectedSet.has(id)) ? [q] : [])
    : [...new Set(source.selectedQuads.flatMap(name => quadAt(name) ?? []))]
      .filter(q => q < source.mesh.quads.length && source.mesh.quads[q].every(id => selectedSet.has(id)))
      .sort((a, b) => a - b);

  const offset = source.offset ?? [0, 0, 0];
  const localOf = new Map(selected.map((id, local) => [id, local] as const));
  const vertices: number[] = [];
  for (const id of selected) {
    const i = id * 3;
    vertices.push(
      source.mesh.vertices[i] + offset[0],
      source.mesh.vertices[i + 1] + offset[1],
      source.mesh.vertices[i + 2] + offset[2],
    );
  }

  const quads = sourceQuads.map(q => source.mesh.quads[q].map(id => localOf.get(id)!));
  const coveredEdges = new Set<string>();
  for (const q of sourceQuads) {
    const quad = source.mesh.quads[q];
    for (const [x, y] of EDGES) {
      const a = quad[x], b = quad[y];
      if (a !== b) coveredEdges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  }
  const edgeSource: readonly (readonly [number, number])[] = source.selectedEdges === undefined
    ? (() => {
      const adj = meshAdjacency(source.mesh), edges: [number, number][] = [];
      for (let a = 0; a < adj.neighbors.length; a++) for (const b of adj.neighbors[a]) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (a < b && selectedSet.has(a) && selectedSet.has(b) && !coveredEdges.has(key)) edges.push([a, b]);
      }
      return edges;
    })()
    : source.selectedEdges.flatMap(([a, b]) => {
      const from = at(a), to = at(b);
      return from !== null && to !== null ? [[from, to] as [number, number]] : [];
    });
  const seenEdges = new Set<string>();
  const sourceEdges: [number, number][] = [];
  for (const [a0, b0] of edgeSource) {
    if (!selectedSet.has(a0) || !selectedSet.has(b0) || a0 === b0) continue;
    const a = Math.min(a0, b0), b = Math.max(a0, b0), key = `${a},${b}`;
    if (!seenEdges.has(key)) { seenEdges.add(key); sourceEdges.push([a, b]); }
  }
  sourceEdges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const freeEdges = sourceEdges.map(([a, b]) => [localOf.get(a)!, localOf.get(b)!] as [number, number]);

  const edgeHandles: Record<string, V3> = {};
  const pinEdge = (from: number, to: number, localFrom: number, localTo: number) => {
    edgeHandles[`${localFrom}>${localTo}`] = [...source.edgeHandle(from, to)] as V3;
    edgeHandles[`${localTo}>${localFrom}`] = [...source.edgeHandle(to, from)] as V3;
  };
  for (let i = 0; i < sourceQuads.length; i++) {
    const sq = source.mesh.quads[sourceQuads[i]], lq = quads[i];
    for (const [x, y] of EDGES) {
      const from = sq[x], to = sq[y], lf = lq[x], lt = lq[y];
      if (from === to) continue; // wedge's collapsed side has no directed handle
      pinEdge(from, to, lf, lt);
    }
  }
  for (let i = 0; i < sourceEdges.length; i++) {
    const [from, to] = sourceEdges[i], [lf, lt] = freeEdges[i];
    pinEdge(from, to, lf, lt);
  }

  const out: MeshVertexClipboard = { version: 1, vertices, quads };
  if (freeEdges.length) out.freeEdges = freeEdges;
  const copiedEdgeKeys = new Set([...coveredEdges, ...sourceEdges.map(([a, b]) => a < b ? `${a},${b}` : `${b},${a}`)]);
  const tJunctions = (source.tJunctions ?? []).flatMap(node => {
    const vertex = localOf.get(node.vertex), a = localOf.get(node.edge[0]), b = localOf.get(node.edge[1]);
    const key = node.edge[0] < node.edge[1] ? `${node.edge[0]},${node.edge[1]}` : `${node.edge[1]},${node.edge[0]}`;
    return vertex !== undefined && a !== undefined && b !== undefined && copiedEdgeKeys.has(key)
      ? [{ vertex, edge: [a, b] as [number, number], t: node.t }] : [];
  });
  if (tJunctions.length) out.tJunctions = tJunctions;
  if (Object.keys(edgeHandles).length) out.edgeHandles = edgeHandles;

  const localMesh = buildQuadMesh(vertices, quads, freeEdges);
  const localHandle = meshEdgeHandles(localMesh, out.edgeHandles);
  const quadTwist: Record<number, [V3, V3, V3, V3]> = {};
  const quadPaint: Record<number, number> = {};
  const quadTex: Record<number, string> = {};
  const quadOrient: Record<number, { rot: number; mirror: boolean }> = {};
  const quadLocked: Record<number, true> = {};
  const quadLabels: Record<number, string[]> = {};
  for (let q = 0; q < sourceQuads.length; q++) {
    const sourceQuad = sourceQuads[q];
    if (source.controls) {
      const exact = source.controls(sourceQuad);
      const zero = quadControlPoints(localMesh, localHandle, q);
      const twist = INTERIOR.map((cp, corner) => sub(moved(exact[cp], offset), zero[INTERIOR[corner]])) as [V3, V3, V3, V3];
      if (twist.some(hasVector)) quadTwist[q] = twist;
    }
    const paint = source.paint?.(sourceQuad);
    if (paint !== undefined) quadPaint[q] = paint;
    const texture = source.texture?.(sourceQuad);
    if (texture !== undefined) quadTex[q] = texture;
    const orientation = source.orientation?.(sourceQuad);
    if (orientation !== undefined) quadOrient[q] = { ...orientation };
    if (source.locked?.(sourceQuad)) quadLocked[q] = true;
    const labels = source.labels?.(sourceQuad);
    if (labels?.length) quadLabels[q] = [...new Set(labels)].sort();
  }
  if (Object.keys(quadTwist).length) out.quadTwist = quadTwist;
  if (Object.keys(quadPaint).length) out.quadPaint = quadPaint;
  if (Object.keys(quadTex).length) out.quadTex = quadTex;
  if (Object.keys(quadOrient).length) out.quadOrient = quadOrient;
  if (Object.keys(quadLocked).length) out.quadLocked = quadLocked;
  if (Object.keys(quadLabels).length) {
    out.quadLabels = quadLabels;
    const used = new Set(Object.values(quadLabels).flat());
    const definitions = (source.labelDefinitions ?? []).filter(label => used.has(label.id));
    if (definitions.length) out.labels = definitions.map(label => ({ ...label }));
  }
  return out;
}

export interface PasteMeshVerticesResult {
  doc: QuadMeshDoc;
  vertices: number[];
  quads: number[];
  freeEdges: [number, number][];
}

/**
 * Append a clipboard as a disconnected chart and report its new ids so the host can select it immediately.
 * `translation` is the placement ghost's final centroid-to-cursor delta; handles/twists are vectors and stay
 * unchanged while vertex positions move into place.
 */
export function pasteMeshVertices(doc: QuadMeshDoc, clip: MeshVertexClipboard, translation: V3 = [0, 0, 0]): PasteMeshVerticesResult {
  const firstVertex = doc.vertices.length / 3;
  const firstQuad = doc.quads.length;
  const vertices = Array.from({ length: clip.vertices.length / 3 }, (_, i) => firstVertex + i);
  const quads = Array.from({ length: clip.quads.length }, (_, i) => firstQuad + i);
  const freeEdges = (clip.freeEdges ?? []).map(([a, b]) => [a + firstVertex, b + firstVertex] as [number, number]);
  const next: QuadMeshDoc = {
    ...doc,
    ...appendMeshIds(doc, clip.vertices.length / 3, clip.quads.length),
    vertices: [...doc.vertices, ...Array.from({ length: clip.vertices.length / 3 }, (_, i) => [
      clip.vertices[i * 3] + translation[0],
      clip.vertices[i * 3 + 1] + translation[1],
      clip.vertices[i * 3 + 2] + translation[2],
    ] as V3).flat()],
    quads: [...doc.quads, ...clip.quads.map(q => q.map(v => v + firstVertex))],
    freeEdges: [...(doc.freeEdges ?? []), ...freeEdges],
    tJunctions: [...(doc.tJunctions ?? []), ...(clip.tJunctions ?? []).map(node => ({
      vertex: node.vertex + firstVertex,
      edge: [node.edge[0] + firstVertex, node.edge[1] + firstVertex] as [number, number],
      t: node.t,
    }))],
  };
  if (!next.freeEdges?.length) delete next.freeEdges;

  if (clip.edgeHandles && Object.keys(clip.edgeHandles).length) {
    next.edgeHandles = { ...(doc.edgeHandles ?? {}) };
    for (const [key, value] of Object.entries(clip.edgeHandles)) {
      const [from, to] = key.split('>').map(Number);
      next.edgeHandles[`${from + firstVertex}>${to + firstVertex}`] = [...value] as V3;
    }
  }
  const copyQuadMap = <T>(source: Record<number, T> | undefined, existing: Record<number, T> | undefined, clone: (v: T) => T): Record<number, T> | undefined => {
    if (!source || !Object.keys(source).length) return existing;
    const target = { ...(existing ?? {}) };
    for (const [key, value] of Object.entries(source)) target[Number(key) + firstQuad] = clone(value);
    return target;
  };
  next.quadPaint = copyQuadMap(clip.quadPaint, doc.quadPaint, v => v);
  next.quadTex = copyQuadMap(clip.quadTex, doc.quadTex, v => v);
  next.quadOrient = copyQuadMap(clip.quadOrient, doc.quadOrient, v => ({ ...v }));
  next.quadLocked = copyQuadMap(clip.quadLocked, doc.quadLocked, () => true);
  next.quadTwist = copyQuadMap(clip.quadTwist, doc.quadTwist,
    v => v.map(p => [...p] as V3) as [V3, V3, V3, V3]);
  if (clip.quadLabels && Object.keys(clip.quadLabels).length) {
    const definitions = [...(doc.labels ?? [])].map(label => ({ ...label }));
    const idMap = new Map<string, string>();
    for (const label of clip.labels ?? []) {
      const sameId = definitions.find(held => held.id === label.id);
      if (sameId && sameId.name.toLocaleLowerCase() === label.name.toLocaleLowerCase()) {
        idMap.set(label.id, sameId.id); continue;
      }
      const sameName = definitions.find(held => held.name.toLocaleLowerCase() === label.name.toLocaleLowerCase());
      if (sameName) { idMap.set(label.id, sameName.id); continue; }
      const id = sameId ? nextLabelId(definitions) : label.id;
      definitions.push({ ...label, id }); idMap.set(label.id, id);
    }
    const known = new Set(definitions.map(label => label.id));
    for (const labels of Object.values(clip.quadLabels)) for (const id of labels)
      if (!idMap.has(id) && known.has(id)) idMap.set(id, id);
    const memberships = Object.fromEntries(Object.entries(clip.quadLabels).flatMap(([quad, labels]) => {
      const mapped = [...new Set(labels.flatMap(id => idMap.get(id) ?? []))].sort();
      return mapped.length ? [[quad, mapped]] : [];
    }));
    next.quadLabels = copyQuadMap(memberships, doc.quadLabels, v => [...v]);
    if (definitions.length) next.labels = definitions;
  }

  return { doc: next, vertices, quads, freeEdges };
}
