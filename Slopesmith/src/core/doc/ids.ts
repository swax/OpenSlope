import type { AuthoredLight, Gem, QuadMeshDoc, Screen } from './types';

/**
 * Stable vertex and quad identity (docs/039). An id is `installId:counter`, minted once when the element is
 * created and carried for as long as it exists: `vertexIds[i]` names the vertex at `vertices[i*3 .. +2]` and
 * `quadIds[q]` names `quads[q]`, so a topology edit that renumbers the arrays moves an id without changing
 * it. Both kinds draw from the document's single `nextId`, which is what keeps a vertex id and a quad id
 * from ever being the same string.
 *
 * The counter is per document and the install half is per build, so allocation needs no coordination: two
 * installs editing the same mountain never mint the same id.
 */

/** The install half of every id this build mints. `src/core` is deterministic and fs-free — it has no clock
 *  or machine fingerprint to read — so the constant is what keeps the smoke fixtures byte-reproducible. */
export const INSTALL_ID = 'local';

/** The id belonging to counter value `n`. */
export const meshId = (n: number): string => `${INSTALL_ID}:${n}`;

/** The identity a mesh-bearing document carries alongside its `vertices` and `quads`. */
export type MeshIds = Pick<QuadMeshDoc, 'vertexIds' | 'quadIds' | 'nextId'>;

/** Identity for a mesh built whole: ids for its vertices, then its quads, minted from counter `from`. */
export function seedMeshIds(from: number, vertexCount: number, quadCount: number): MeshIds {
  const mint = (start: number, count: number) => Array.from({ length: count }, (_, i) => meshId(start + i));
  return {
    vertexIds: mint(from, vertexCount),
    quadIds: mint(from + vertexCount, quadCount),
    nextId: from + vertexCount + quadCount,
  };
}

/** Identity after appending `vertexCount` points and `quadCount` cells to the ENDS of a document's arrays —
 *  the shape every append-only op returns, where existing elements keep both their index and their id. */
export function appendMeshIds(doc: MeshIds, vertexCount: number, quadCount: number): MeshIds {
  const fresh = seedMeshIds(doc.nextId, vertexCount, quadCount);
  return {
    vertexIds: [...doc.vertexIds, ...fresh.vertexIds],
    quadIds: [...doc.quadIds, ...fresh.quadIds],
    nextId: fresh.nextId,
  };
}

/**
 * Where each name lives now — the id→index map docs/039 has the document rebuild on load.
 *
 * Cached against the identity array it was built from, because resolving a name is on the path of every
 * register write and every section a hash is maintained over, and rebuilding the map per name would make each
 * of those a scan of the mesh. Every mesh op hands back fresh arrays, so the cache turns over with the
 * topology on its own; the size check is what catches an append made in place.
 */
const indexes = new WeakMap<readonly string[], Map<string, number>>();

export function nameIndex(ids: readonly string[]): Map<string, number> {
  const cached = indexes.get(ids);
  if (cached && cached.size === ids.length) return cached;
  const at = new Map<string, number>();
  ids.forEach((id, index) => at.set(id, index));
  indexes.set(ids, at);
  return at;
}

// ---- tombstones: the names this document used to have ------------------------------------------------------

/** A document's retired names, or none. */
export type Tombstoned = Pick<QuadMeshDoc, 'tombstones'>;

/** True once the document has retired `id` — geometry it had and no longer has. */
export function tombstoned(doc: Tombstoned, id: string): boolean {
  return !!doc.tombstones?.includes(id);
}

/**
 * Retire names, so what arrives for them later can be told from a name nobody ever minted.
 *
 * A tombstone is what makes "already gone" a quiet outcome. Something addressed by id can reach the document
 * after the geometry it names has been deleted — a channel read off a file saved before the delete, and in
 * time an edit that was in flight while somebody else removed it. Without the record there is no way to
 * distinguish that from a name out of nowhere, and the choice is between resurrecting geometry and refusing an
 * edit that was merely late. With it the late one is discarded and the nonsense one still raises.
 *
 * They accumulate for the life of the document, which is bounded by how much has ever been deleted from it.
 */
export function retireMeshIds(doc: Tombstoned, ids: Iterable<string>): void {
  const retired = new Set(doc.tombstones ?? []);
  for (const id of ids) retired.add(id);
  if (retired.size) doc.tombstones = [...retired]; else delete doc.tombstones;
}

// ---- lights and gems: the object families with no module of their own ---------------------------------------

/**
 * A light or a gem is named `<family>:<counter>` — the same identity props, rails, models and particle volumes
 * carry, and for the same reason: a register, a selection or an edit in flight names one object rather than the
 * position that object happens to sit at, so deleting the light below it moves nothing (docs/039). The counter
 * is the lowest the list does not already use, which keeps the ids of one document short and readable.
 *
 * The other four families mint theirs beside the code that gives them meaning; these two have no such module,
 * so their identity lives here with the mesh's.
 */
type Identified = { id?: string };

function nextObjectId(objects: readonly Identified[], family: string): string {
  const used = new Set(objects.map(object => object.id).filter((id): id is string => !!id));
  for (let i = 0; ; i++) {
    const id = `${family}:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

export const nextLightId = (lights: readonly AuthoredLight[]): string => nextObjectId(lights, 'light');
export const nextGemId = (gems: readonly Gem[]): string => nextObjectId(gems, 'gem');
export const nextScreenId = (screens: readonly Screen[]): string => nextObjectId(screens, 'screen');

/** Name in place what a document carries unnamed — one saved before these families had ids, or one whose list
 *  holds the same id twice, which is two objects answering to one register. */
function ensureObjectIds(objects: Identified[] | undefined, family: string): void {
  if (!objects) return;
  const used = new Set<string>();
  for (const object of objects) {
    if (typeof object.id === 'string' && object.id && !used.has(object.id)) used.add(object.id);
    else {
      object.id = nextObjectId([...used].map(id => ({ id })), family);
      used.add(object.id);
    }
  }
}

export const ensureLightIds = (lights: AuthoredLight[] | undefined): void => ensureObjectIds(lights, 'light');
export const ensureGemIds = (gems: Gem[] | undefined): void => ensureObjectIds(gems, 'gem');
export const ensureScreenIds = (screens: Screen[] | undefined): void => ensureObjectIds(screens, 'screen');
