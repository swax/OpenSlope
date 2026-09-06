import type { EdgeEmbeddedTJunction, QuadMeshDoc, V3 } from './types';
import { nameIndex } from './ids';

/**
 * The keying boundary (docs/039): a mountain names its geometry by STABLE ID on disk and by ARRAY INDEX in
 * memory, and this file is the only place a document's channels are converted between the two.
 *
 * `edgeHandles`, `quadPaint`, `quadTex`, `quadOrient`, `quadLocked`, `quadTwist`, `quadLabels`, `freeEdges` and `tJunctions` all key off a
 * vertex or a quad. An index is a rendering and serialization detail: topology surgery renumbers the arrays,
 * so an index stored on Monday names different terrain after Tuesday's delete, and every one of those channels
 * lands on the wrong face when the document is read back. An id does not move, so the same delete costs the
 * document nothing — which is what makes a save, a topology edit and a reload compose.
 *
 * Interior code reads indices, because an index is a direct array subscript and the editor, the preview and
 * the export are all written against it. Converting at the two ends of the file is what buys durability
 * without making every reader resolve a name first.
 *
 * `edgeHandles` is the dangerous channel, because it fails silently: its key is compound (`"from>to"`), and a
 * key that cannot be resolved has no symptom beyond the edge falling back to its Bessel default and the
 * terrain quietly changing shape. So a name this document does not carry is an error here rather than a skip,
 * and both directions count what they carried across.
 */

/** The channels that key off a vertex or a quad — everything the two namings disagree about. */
type KeyedChannel =
  'freeEdges' | 'tJunctions' | 'edgeHandles' | 'quadPaint' | 'quadTex' | 'quadOrient' | 'quadLocked' | 'quadTwist' | 'quadLabels';

/** A T-node as stored: its own vertex and the two ends of its host edge, each named by id. */
export interface StoredTJunction {
  vertex: string;
  edge: [string, string];
  t: number;
}

/** A mountain as it is stored: the live document with every keyed channel named by stable id. */
export interface StoredMountain extends Omit<QuadMeshDoc, KeyedChannel> {
  /**
   * How this file's keyed channels name their geometry. Set on everything written to disk; absent from a
   * document in memory or on the wire, where a key is an array index.
   *
   * It is its own field rather than a `version` bump because the same document version travels both ways: the
   * editor posts its in-memory, index-keyed document back to save it, and reads the id-keyed one off disk. A
   * marker the writer sets makes the conversion opt-in, so a document that never went through this file is
   * read exactly as it was written instead of having its indices mistaken for names.
   */
  keying: 'id';
  freeEdges?: [string, string][];
  tJunctions?: StoredTJunction[];
  edgeHandles?: Record<string, V3>;
  quadPaint?: Record<string, number>;
  quadTex?: Record<string, string>;
  quadOrient?: Record<string, { rot: number; mirror: boolean }>;
  quadLocked?: Record<string, true>;
  quadTwist?: Record<string, [V3, V3, V3, V3]>;
  quadLabels?: Record<string, string[]>;
}

/** The separator in a directed-edge key `"from>to"`. Neither end may contain it, which is what lets one split
 *  take a compound key apart whatever names its ends carry. */
const EDGE_SEPARATOR = '>';

/** A crease's compound key, from either naming. Exported alongside its parser because the register model
 *  (docs/039) names a crease by the same compound key over ids, and a key that fails silently is exactly the
 *  key that must not have two readers. */
export const directedEdgeName = (from: string | number, to: string | number): string =>
  `${from}${EDGE_SEPARATOR}${to}`;

/** The two ends of a directed-edge key, or null when the key is not one. */
export function directedEdgeEnds(key: string): [string, string] | null {
  const at = key.indexOf(EDGE_SEPARATOR);
  if (at <= 0 || at >= key.length - 1) return null;
  const to = key.slice(at + 1);
  return to.includes(EDGE_SEPARATOR) ? null : [key.slice(0, at), to];
}

/**
 * One sparse channel re-keyed through `rename`, which answers with a key's new name or null when the key
 * names nothing at all. Two keys renaming onto one would merge their entries out of sight, so the count is
 * checked rather than assumed.
 */
function rekeyed<T>(what: string, channel: Record<string, T> | undefined, rename: (key: string) => string | null):
  Record<string, T> | undefined {
  if (!channel) return undefined;
  const out: Record<string, T> = {};
  let named = 0;
  for (const key in channel) {
    const to = rename(key);
    if (to === null) continue;
    named++;
    out[to] = channel[key];
  }
  if (Object.keys(out).length !== named) {
    throw new Error(`Storing ${what} collapsed ${named} entries onto ${Object.keys(out).length}: `
      + 'two elements of this mountain answer to one name.');
  }
  return out;
}

/** True for a document whose keyed channels name their geometry by id — the form this file writes. */
export function storedById(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as { keying?: unknown }).keying === 'id';
}

/**
 * A mountain as it is stored: every keyed channel named by stable id.
 *
 * An index that names no vertex or quad is dead data — it addresses geometry the mesh does not have and has
 * had no effect on the surface for as long as that was true — so it is dropped rather than stored under a
 * name invented for it. What must never be dropped is a key naming live geometry, and the guard for that is
 * up front: identity that does not cover the mesh cannot store the mesh.
 */
export function serializeMountain(doc: QuadMeshDoc): StoredMountain {
  const vertexCount = doc.vertices.length / 3;
  if (doc.vertexIds?.length !== vertexCount || doc.quadIds?.length !== doc.quads.length) {
    throw new Error(`This mountain cannot be stored: its identity names ${doc.vertexIds?.length ?? 0} vertices `
      + `and ${doc.quadIds?.length ?? 0} quads for a mesh of ${vertexCount} and ${doc.quads.length}.`);
  }
  const vertexName = (index: string | number): string | null => doc.vertexIds[Number(index)] ?? null;
  const quadName = (index: string): string | null => doc.quadIds[Number(index)] ?? null;
  const handleName = (key: string): string | null => {
    const ends = directedEdgeEnds(key);
    if (!ends) return null;
    const from = vertexName(ends[0]), to = vertexName(ends[1]);
    return from !== null && to !== null ? directedEdgeName(from, to) : null;
  };

  // Written over a copy of the document rather than assembled fresh, so the file carries every field the
  // document has — including any this file has never heard of — in the order the document has them.
  const { freeEdges, tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels } = doc;
  const stored = { ...doc } as unknown as StoredMountain;
  stored.freeEdges = freeEdges?.flatMap(([a, b]) => {
    const from = vertexName(a), to = vertexName(b);
    return from !== null && to !== null ? [[from, to] as [string, string]] : [];
  });
  stored.tJunctions = tJunctions?.flatMap(node => {
    const vertex = vertexName(node.vertex);
    const a = vertexName(node.edge[0]), b = vertexName(node.edge[1]);
    return vertex !== null && a !== null && b !== null ? [{ vertex, edge: [a, b] as [string, string], t: node.t }] : [];
  });
  stored.edgeHandles = rekeyed('edge handles', edgeHandles, handleName);
  stored.quadPaint = rekeyed('quad paint', quadPaint as Record<string, number> | undefined, quadName);
  stored.quadTex = rekeyed('quad tiles', quadTex as Record<string, string> | undefined, quadName);
  stored.quadOrient = rekeyed('quad tile orientation',
    quadOrient as Record<string, { rot: number; mirror: boolean }> | undefined, quadName);
  stored.quadLocked = rekeyed('quad locks', quadLocked as Record<string, true> | undefined, quadName);
  stored.quadTwist = rekeyed('quad twist', quadTwist as Record<string, [V3, V3, V3, V3]> | undefined, quadName);
  stored.quadLabels = rekeyed('quad labels', quadLabels as Record<string, string[]> | undefined, quadName);
  stored.keying = 'id';
  return stored;
}

/**
 * Name a stored mountain's channels by index, in place — the load half, and the inverse of the above.
 *
 * This is the direction that can lose a crease, and losing one is invisible in the surface it produces, so a
 * name that resolves to nothing is never merely skipped. It has exactly two ways of resolving to nothing, and
 * they are not the same thing:
 *
 *   retired   the document deleted that geometry after this channel was written — a file saved before the
 *             delete, and in time an edit that was in flight during it. The entry is discarded quietly,
 *             because the alternative is refusing a write that is only late (docs/039 tombstones).
 *   unknown   a name this document has never had. Nothing legitimate produces one, so it raises.
 */
export function keyMountainByIndex(doc: QuadMeshDoc): { retiredHandles: number } {
  const stored = doc as unknown as StoredMountain;
  const vertexAt = nameIndex(doc.vertexIds), quadAt = nameIndex(doc.quadIds);
  const retired = new Set(doc.tombstones ?? []);
  let retiredHandles = 0;
  const resolve = (at: Map<string, number>, id: string, what: string): number | null => {
    const index = at.get(id);
    if (index !== undefined) return index;
    if (retired.has(id)) return null;
    throw new Error(`This mountain names ${what} it does not carry: ${id}`);
  };
  const vertexIndex = (id: string) => resolve(vertexAt, id, 'a vertex');
  const quadIndex = (id: string): string | null => {
    const at = resolve(quadAt, id, 'a patch');
    return at === null ? null : String(at);
  };
  const handleIndex = (key: string): string | null => {
    const ends = directedEdgeEnds(key);
    if (!ends) throw new Error(`This mountain carries a crease under a key that names no edge: ${key}`);
    const from = vertexIndex(ends[0]), to = vertexIndex(ends[1]);
    if (from !== null && to !== null) return directedEdgeName(from, to);
    retiredHandles++;
    return null;
  };

  const { freeEdges, tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels } = stored;
  doc.freeEdges = freeEdges?.flatMap(([a, b]) => {
    const from = vertexIndex(a), to = vertexIndex(b);
    return from !== null && to !== null ? [[from, to] as [number, number]] : [];
  });
  doc.tJunctions = tJunctions?.flatMap((node): EdgeEmbeddedTJunction[] => {
    const vertex = vertexIndex(node.vertex);
    const a = vertexIndex(node.edge[0]), b = vertexIndex(node.edge[1]);
    return vertex !== null && a !== null && b !== null ? [{ vertex, edge: [a, b], t: node.t }] : [];
  });
  doc.edgeHandles = rekeyed('edge handles', edgeHandles, handleIndex);
  doc.quadPaint = rekeyed('quad paint', quadPaint, quadIndex);
  doc.quadTex = rekeyed('quad tiles', quadTex, quadIndex);
  doc.quadOrient = rekeyed('quad tile orientation', quadOrient, quadIndex);
  doc.quadLocked = rekeyed('quad locks', quadLocked, quadIndex);
  doc.quadTwist = rekeyed('quad twist', quadTwist, quadIndex);
  doc.quadLabels = rekeyed('quad labels', quadLabels, quadIndex);
  delete (doc as { keying?: unknown }).keying;
  return { retiredHandles };
}
