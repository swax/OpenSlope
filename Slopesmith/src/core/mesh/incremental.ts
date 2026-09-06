import type { QuadMeshDoc } from '../doc/types';
import { meshAdjacency, type MeshAdjacency, type QuadMesh } from './topology';
import { undirectedEdgeKey as ekey } from './primitives';

/**
 * What a change to the control net can move, and how to tell what changed (docs/039, stage 6).
 *
 * A remote assignment arrives at up to 25 Hz from every other participant. Re-tessellating and re-lighting the
 * whole mountain for each one is affordable at the pace of one human hand and is not affordable at the pace of
 * several; `010` names that cost as owed regardless of how the collaboration itself is built. This module is
 * the two halves of paying it: the DEPENDENCY RADIUS — which patches a moved corner or a re-creased edge can
 * actually change — and the WATCHER that says which corners and edges moved at all.
 *
 * The watcher reads the document rather than being told, which is the whole reason to trust it. An edit tool
 * that has to declare its own dirt declares it wrongly exactly once and leaves a patch stale on somebody
 * else's screen forever after; a comparison against what was last drawn cannot be forgotten, and it covers a
 * local drag, a remote assignment and an undo re-assertion with one mechanism.
 */

// ---- the dependency radius --------------------------------------------------------------------------------

/**
 * Which patches read a given corner's position, and which read a given edge's crease.
 *
 * **A moved corner changes exactly the patches incident to its CLOSED ONE-RING** — the corner itself and the
 * vertices one control-net edge away. On a regular grid that is twelve patches: the four sharing the corner,
 * plus two more beyond each of its four axis directions, because a smooth tangent reaches one corner further
 * than the patch it shapes.
 *
 * The radius is derived from what `quadControlPoints` reads, not guessed. One patch's sixteen control points
 * come from three places, and each lands inside that one ring:
 *
 *  1. **Its four corners.** Those quads are incident to `v` itself.
 *  2. **Eight directed in-quad edge handles.** Each is either the document's crease override for that directed
 *     edge or the Bessel tangent at `from`, which reads the OPPOSITE neighbour across `from` — one corner
 *     beyond the patch. So a patch reads `v` this way only when some corner of it is a neighbour of `v`, which
 *     puts the patch among the quads incident to `N(v)`.
 *  3. **At an extraordinary POLE corner, a tangent plane fitted to the pole's incident quad fan.** Per quad in
 *     the fan that fit reads the pole and the two corners ADJACENT to it — never the quad's far diagonal (see
 *     `meshEdgeHandles`' `poleNormal`, whose `dv`/`du` are both taken from the pole's own slot). So the plane
 *     reads only `N[p]`, and a patch reads `v` this way only when it is in the fan of a pole `p` with
 *     `v ∈ N[p]` — equivalently `p ∈ N[v]`, so again a quad incident to the one ring.
 *
 * Case (3) is why the fan is worth stating: it is the one place a corner's handle looks past its own edges,
 * and it is exactly *not* wide enough to need a wider radius. The mesh suite proves all of this by brute
 * force — moving each corner of a grid, a poled net and a closed all-pole barrel and comparing against a full
 * rebuild — rather than by trusting the reading above.
 *
 * A crease is narrower: an override replaces one directed handle and nothing else reads it, so a change to
 * `a>b` moves exactly the patches incident to the edge `{a, b}` — two of them, or one at a rim.
 */
export interface PatchDependency {
  /** The patches a set of moved corners can change. */
  ofVertices(vertices: Iterable<number>): Set<number>;
  /** The patches a set of re-creased edges can change. */
  ofEdges(edges: Iterable<readonly [number, number]>): Set<number>;
  /** Both at once, plus patches named directly (a quad attribute moves only its own patch). */
  of(change: { vertices?: Iterable<number>; edges?: Iterable<readonly [number, number]>; quads?: Iterable<number> }): Set<number>;
}

/** Which quads each corner belongs to. Derived from the topology alone, so it is cached against the mesh it
 *  was read from and turns over with it — a stream of changes over one net builds it once. */
const vertexQuadIndex = new WeakMap<QuadMesh, number[][]>();
function vertexQuadsOf(mesh: QuadMesh): number[][] {
  const cached = vertexQuadIndex.get(mesh);
  if (cached) return cached;
  const vertexQuads: number[][] = Array.from({ length: mesh.vertexCount }, () => []);
  for (let q = 0; q < mesh.quads.length; q++) {
    for (const corner of new Set(mesh.quads[q])) vertexQuads[corner]?.push(q);
  }
  vertexQuadIndex.set(mesh, vertexQuads);
  return vertexQuads;
}

export function patchDependency(mesh: QuadMesh, adj: MeshAdjacency = meshAdjacency(mesh)): PatchDependency {
  const vertexQuads = vertexQuadsOf(mesh);
  const addVertex = (v: number, out: Set<number>): void => {
    if (v < 0 || v >= mesh.vertexCount) return;
    for (const q of vertexQuads[v]) out.add(q);
    for (const nb of adj.neighbors[v] ?? []) for (const q of vertexQuads[nb] ?? []) out.add(q);
  };
  const addEdge = (a: number, b: number, out: Set<number>): void => {
    for (const q of adj.edgeQuads.get(ekey(a, b)) ?? []) out.add(q);
  };

  const ofVertices = (vertices: Iterable<number>): Set<number> => {
    const out = new Set<number>();
    for (const v of vertices) addVertex(v, out);
    return out;
  };
  const ofEdges = (edges: Iterable<readonly [number, number]>): Set<number> => {
    const out = new Set<number>();
    for (const [a, b] of edges) addEdge(a, b, out);
    return out;
  };
  return {
    ofVertices,
    ofEdges,
    of(change) {
      const out = new Set<number>();
      for (const v of change.vertices ?? []) addVertex(v, out);
      for (const [a, b] of change.edges ?? []) addEdge(a, b, out);
      for (const q of change.quads ?? []) if (q >= 0 && q < mesh.quadCount) out.add(q);
      return out;
    },
  };
}

// ---- the watcher ------------------------------------------------------------------------------------------

/** What changed about the control net since it was last drawn. */
export interface NetChange {
  /**
   * `none` — nothing the terrain draws moved (an object assignment, a selection, a global the quilt does not
   * read). `patches` — corners, creases or face attributes moved, and only the patches named below can have
   * changed. `whole` — which vertices and quads exist has moved, or a field every patch reads has, and only a
   * full rebuild is correct.
   */
  kind: 'none' | 'patches' | 'whole';
  /** Corners whose position moved. */
  vertices: number[];
  /** Edges whose crease override was set, changed or removed. */
  edges: [number, number][];
  /** Faces whose paint, tile, orientation, lock state or interior twist moved. */
  quads: number[];
  /**
   * Which vertices and quads exist has moved, so every index into the mesh is now suspect — what a selection
   * held by index, a retained cage range or a pinned control point has to be dropped for. A `whole` rebuild
   * asked for by a global the quilt reads is NOT this: the numbering stood still.
   */
  renumbered: boolean;
  /** Why a `whole` rebuild was called for, in the words a log line wants. */
  reason: string;
}

const NOTHING: NetChange = { kind: 'none', vertices: [], edges: [], quads: [], renumbered: false, reason: '' };
const whole = (reason: string, renumbered: boolean): NetChange => ({ ...NOTHING, kind: 'whole', renumbered, reason });

/** The per-face attribute channels, each a sparse index→value map on the document. */
const QUAD_CHANNELS = ['quadPaint', 'quadTex', 'quadOrient', 'quadLocked', 'quadTwist'] as const;
type QuadChannel = typeof QUAD_CHANNELS[number];

/** A sparse channel flattened to the values it holds, so the next comparison is a lookup rather than a walk. */
type Channel = Map<string, unknown>;

/**
 * One channel entry reduced to something `===` decides.
 *
 * Paint and tiles are a number and a string, so they compare as themselves and cost nothing; an orientation
 * and a twist are small objects that could also be edited in place, so they are frozen to text. The two can
 * never be confused: `JSON.stringify` of an object always begins with `{` or `[`, which no tile ref does.
 */
const cellValue = (value: unknown): unknown =>
  value === null || typeof value !== 'object' ? value : JSON.stringify(value);

const channelOf = (record: Record<string, unknown> | undefined): Channel => {
  const out: Channel = new Map();
  if (!record) return out;
  for (const key in record) {
    const value = record[key];
    if (value !== undefined) out.set(key, cellValue(value));
  }
  return out;
};

/** Every key the two channels disagree about — added, removed, or holding a different value. */
function channelDiff(was: Channel, now: Channel, onKey: (key: string) => void): void {
  for (const [key, value] of now) if (was.get(key) !== value) onKey(key);
  for (const key of was.keys()) if (!now.has(key)) onKey(key);
}

/**
 * Which vertices and quads exist, as one comparable name — the part no register owns and no incremental path
 * can follow, because renumbering moves every index the retained quilt is addressed by.
 *
 * Two 32-bit accumulators over the corner ids, the free edges and the T-nodes, mixed at the end: the same
 * shape of name `doc/digest.ts` uses to detect drift, and for the same reason — it has to be exact about
 * CONTENT (a mesh op that rewires a quad in place is a topology change however the arrays were allocated) and
 * cheap enough to run on every rendered frame, which serializing a few thousand quads is not.
 */
function shapeOf(doc: QuadMeshDoc): string {
  let low = 0x9e3779b1, high = 0x85ebca6b;
  const mix = (value: number): void => {
    low = Math.imul(low ^ value, 2654435761);
    high = Math.imul(high ^ (value + 0x9e3779b9), 1597334677);
  };
  mix(doc.vertices.length);
  mix(doc.quads.length);
  for (const quad of doc.quads) { mix(quad.length); for (const corner of quad) mix(corner); }
  const free = doc.freeEdges ?? [];
  mix(free.length);
  for (const [a, b] of free) { mix(a); mix(b); }
  const nodes = doc.tJunctions ?? [];
  mix(nodes.length);
  for (const node of nodes) { mix(node.vertex); mix(node.edge[0]); mix(node.edge[1]); mix(Math.round(node.t * 1e9)); }
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  return `${(high >>> 0).toString(16)}:${(low >>> 0).toString(16)}`;
}

/** The document-wide fields EVERY patch reads: the base surface each unpainted face falls back to, the cage
 *  mode that decides how all handles are derived, and the net's spacing. Cheaper to rebuild whole than to fan
 *  out, and none of them moves during ordinary editing. */
const wholeQuiltFieldsOf = (doc: QuadMeshDoc): string =>
  JSON.stringify([doc.spacing, doc.baseSurface, doc.linearCage ?? false]);

interface NetSnapshot {
  shape: string;
  globals: string;
  vertices: Float64Array;
  handles: Channel;
  quads: Record<QuadChannel, Channel>;
}

const snapshotOf = (doc: QuadMeshDoc): NetSnapshot => {
  const record = doc as unknown as Record<string, Record<string, unknown> | undefined>;
  return {
    shape: shapeOf(doc),
    globals: wholeQuiltFieldsOf(doc),
    vertices: Float64Array.from(doc.vertices),
    handles: channelOf(doc.edgeHandles as Record<string, unknown> | undefined),
    quads: Object.fromEntries(QUAD_CHANNELS.map(channel => [channel, channelOf(record[channel])])) as
      Record<QuadChannel, Channel>,
  };
};

/**
 * Tracks the control net a viewport has drawn and says what has moved since.
 *
 * Cost is a pass over the corner buffer and the sparse channels — some tens of microseconds on a mountain of a
 * few thousand corners — against the hundreds of milliseconds a full rebuild spends. It runs once per rendered
 * frame, so a burst of assignments arriving together is compared once and answers with their UNION: several
 * remote changes in one frame produce one rebuild of everything they touched between them, never one each.
 */
export function createNetWatcher() {
  let held: NetSnapshot | null = null;

  /** Compare the document against what was last drawn, and take it as the new baseline. */
  function note(next: QuadMeshDoc): NetChange {
    const was = held;
    held = snapshotOf(next);
    if (!was) return whole('first build', true);
    // The comparison is over the mesh rather than over the object holding it, so a document REPLACED whole —
    // an undo restore, a resync from the room — is incremental too whenever it left the topology alone. What
    // makes that legal is exactly what the shape names: the same corner ids in the same quads means the same
    // numbering, so the retained buffers and the channel keys still address what they always did.
    if (was.shape !== held.shape) return whole('the mesh topology moved', true);
    if (was.globals !== held.globals) return whole('a field every patch reads moved', false);

    const vertices: number[] = [];
    const positions = held.vertices, before = was.vertices;
    for (let v = 0, at = 0; at < positions.length; at += 3, v++) {
      if (positions[at] !== before[at] || positions[at + 1] !== before[at + 1]
        || positions[at + 2] !== before[at + 2]) vertices.push(v);
    }
    const edges: [number, number][] = [];
    channelDiff(was.handles, held.handles, key => {
      // A crease is keyed by its directed ends; the patches on either side read it whichever way it points.
      const cut = key.indexOf('>');
      const from = Number(key.slice(0, cut)), to = Number(key.slice(cut + 1));
      if (cut > 0 && Number.isInteger(from) && Number.isInteger(to)) edges.push([from, to]);
    });
    // A lock changes no tessellated position or material, but it recolours topology edges in the authored
    // wireframe. That batch is partitioned by material only during a cage rebuild, so this rare UI operation
    // deliberately takes the full path rather than pretending a patch-buffer refresh can change its colour.
    let locksChanged = false;
    channelDiff(was.quads.quadLocked, held.quads.quadLocked, () => { locksChanged = true; });
    if (locksChanged) return whole('patch protection changed', false);
    const quads = new Set<number>();
    for (const channel of QUAD_CHANNELS) {
      if (channel === 'quadLocked') continue;
      channelDiff(was.quads[channel], held.quads[channel], key => {
        const at = Number(key);
        if (Number.isInteger(at)) quads.add(at);
      });
    }
    if (!vertices.length && !edges.length && !quads.size) return { ...NOTHING };
    return { kind: 'patches', vertices, edges, quads: [...quads], renumbered: false, reason: '' };
  }

  return {
    note,
    /** Forget what was drawn, so the next comparison asks for a full rebuild — what a render that threw
     *  half-way leaves behind, since nothing finished painting the document it had already taken as drawn. */
    reset(): void { held = null; },
  };
}

export type NetWatcher = ReturnType<typeof createNetWatcher>;

/** The contiguous quilt-vertex spans a set of patches owns, merged and in order — what lets a per-vertex
 *  lighting pass be re-run over exactly the patches that moved. `stride` is `PATCH_VERTS`. */
export function patchVertexSpans(quads: Iterable<number>, stride: number): [number, number][] {
  const sorted = [...new Set(quads)].sort((a, b) => a - b);
  const spans: [number, number][] = [];
  for (const q of sorted) {
    const from = q * stride, to = from + stride;
    const last = spans[spans.length - 1];
    if (last && last[1] === from) last[1] = to; else spans.push([from, to]);
  }
  return spans;
}
