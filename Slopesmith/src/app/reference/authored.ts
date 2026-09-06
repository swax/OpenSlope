import type { QuadMeshDoc } from '../../core/doc/types';
import { deriveQuadMesh } from '../../core/doc/mountain';
import { quadControlPoints } from '../../core/mesh/topology';
import { toRaw } from '../../core/export/level';
import { buildReferenceMesh, type RawPatch, type ReferenceMesh } from '../../core/reference/terrain';

/**
 * An authored document as reference geometry, so a checkpoint can be studied beside the live mountain
 * (docs/040).
 *
 * The reference slot already renders a map folder's `Patches.json` — sixteen Bezier control points per patch
 * in raw SSX space — and that is exactly what the export path writes out of a document. So a checkpoint needs
 * no viewer of its own: it becomes the same patch records the reference layer has always tessellated, and
 * then-and-now sit in one viewport with the placement controls that already exist. That is a far better
 * answer to *"what changed?"* than reading a JSON diff, and it costs almost nothing.
 *
 * Only geometry and surface type travel. A checkpoint is drawn as a ghost of the mountain, tinted by surface
 * the way an untextured reference is: the tile a face wears belongs to a level's own art folder, and looking
 * up a project's paint through the reference layer's per-level texture resolver would ask a map folder that
 * does not exist for images nobody needs to see the shape of what changed.
 */

/** One document's faces as the reference layer reads them: the same records `Patches.json` carries, minus the
 *  appearance a stored level supplies. Patch order is quad order, so a record's index is its quad's. */
export function authoredPatches(doc: QuadMeshDoc): RawPatch[] {
  const derived = deriveQuadMesh(doc);
  const { mesh, edgeHandle } = derived;
  const patches: RawPatch[] = new Array(mesh.quadCount);
  for (let quad = 0; quad < mesh.quadCount; quad++) {
    patches[quad] = {
      Points: quadControlPoints(mesh, edgeHandle, quad, derived.twistOf(quad)).map(toRaw),
      SurfaceType: derived.surfOf(quad),
    };
  }
  return patches;
}

/** A document tessellated into the quilt the reference slot holds. Nothing here touches the live project:
 *  the document is read, and what comes back is render geometry with no way back into the editor's grammar. */
export const authoredReferenceMesh = (doc: QuadMeshDoc): ReferenceMesh =>
  buildReferenceMesh(authoredPatches(doc));
