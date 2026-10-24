import type { QuadMeshDoc } from '../../core/doc/types';
import { carryIdentity } from '../../core/doc/ids';
import { refreshSurfaces } from '../../core/mesh/surface-object';

// A source drag also moves shared plain-terrain controls. A failed rebuild must restore that whole mesh
// together, including index-keyed channels if a fit changed topology. Objects and other map settings stay live.
const meshKeys = [
  'vertices',
  'vertexIds',
  'quads',
  'quadIds',
  'nextId',
  'tombstones',
  'freeEdges',
  'tJunctions',
  'edgeHandles',
  'quadTwist',
  'vertexRoll',
  'quadPaint',
  'quadTex',
  'quadOrient',
  'quadLabels',
  'quadLocked',
  'edgeLocked',
  'surfaces',
  'lofts',
  'trails',
] as const satisfies readonly (keyof QuadMeshDoc)[];
type MeshSnapshot = Pick<QuadMeshDoc, (typeof meshKeys)[number]>;

function snapshot(doc: QuadMeshDoc): MeshSnapshot {
  return structuredClone(
    Object.fromEntries(meshKeys.filter(key => key in doc).map(key => [key, doc[key]])),
  ) as MeshSnapshot;
}

function withMesh(doc: QuadMeshDoc, mesh: MeshSnapshot): QuadMeshDoc {
  // Overwrite in place in the object order: history stores JSON, so deleting/re-appending these keys would
  // manufacture an undo entry even when a rejected drag restored every value exactly.
  const out = { ...doc, ...mesh };
  for (const key of meshKeys) if (!(key in mesh)) Reflect.deleteProperty(out, key);
  return out;
}

/** Keep the last fully fitted mesh. Interactive fits are provisional until the release/commit fit succeeds.
 *  Take one checkpoint per full rebuild, never a mountain copy per pointer move. */
export function createSurfaceEditGuard(evaluate = refreshSurfaces) {
  let accepted: MeshSnapshot | null = null;
  let pending = false;

  function reset() {
    accepted = null;
    pending = false;
  }

  function refresh(doc: QuadMeshDoc, options: { interactive?: boolean; authored?: boolean } = {}) {
    const next = evaluate(doc, { interactive: options.interactive });
    return accept(doc, next, options);
  }

  function accept(doc: QuadMeshDoc, next: QuadMeshDoc, options: { interactive?: boolean; authored?: boolean } = {}) {
    // Loading, receiving and restoring documents establishes a new baseline, including any pre-existing
    // errors. This guard prevents new failed edits; it does not repair someone else's saved geometry.
    const prior = options.authored === false ? null : accepted;
    const failed =
      prior && next.surfaces?.find(surface => surface.error && !prior.surfaces?.find(s => s.id === surface.id)?.error);
    if (failed) {
      const restored = withMesh(doc, structuredClone(prior));
      carryIdentity(restored, doc);
      pending = false;
      return { doc: restored, rejected: `${failed.name}: ${failed.error}` };
    }
    pending = !!options.interactive;
    if (!pending) accepted = next.surfaces?.length ? snapshot(next) : null;
    return { doc: next, rejected: null };
  }

  /** Autosave can run in the middle of a drag. Give read-only serializers the fully fitted geometry until
   *  the provisional edit has passed its final fit; keep unrelated object/settings edits current. */
  function forPersistence(doc: QuadMeshDoc): QuadMeshDoc {
    if (!pending || !accepted) return doc;
    return withMesh(doc, accepted);
  }

  return {
    refresh,
    accept,
    reset,
    forPersistence,
    pending: () => pending,
    beginPreview: () => {
      pending = true;
    },
  };
}
