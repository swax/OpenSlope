import type { EditDoc } from '../../core/doc/doc-edit';
import type { Store } from '../state/store';
import { commitModelEditDoc, findModel, modelEditDocFor } from '../../core/doc/models';

/**
 * The edit stack's mesh TARGET: the mountain net, or — while a model is being edited — that model's
 * materialized linearCage substrate. Every Edit-mode read goes through `editMesh` and every whole-doc
 * op result through `commitEditMesh`, so the same tools sculpt terrain and author polygon models.
 *
 * In-place mutations (gizmo drags, setVertex, handle writes) need no commit call: the model substrate
 * SHARES the model record's arrays, so they are already the document's state. A pure op replaces arrays;
 * committing writes them back into the model (dropping curvature — the flat cage is derived, not stored)
 * and re-materializes the substrate so the viewport rebuilds from the new topology.
 */
export const editMesh = (store: Store): EditDoc => store.modelEditDoc ?? store.mdoc;

export function commitEditMesh(store: Store, doc: EditDoc): void {
  const model = findModel(store.mdoc, store.modelEditId);
  if (store.modelEditId && model) {
    commitModelEditDoc(model, doc);
    store.modelEditDoc = modelEditDocFor(store.mdoc, model);
  } else {
    store.mdoc = doc;
  }
}

/** Re-seat the substrate after the document itself was replaced (undo restore / load); exits stale ids. */
export function refreshModelEditTarget(store: Store): void {
  const model = findModel(store.mdoc, store.modelEditId);
  if (!model) { store.modelEditId = null; store.modelEditDoc = null; store.modelEditPlacementId = null; return; }
  store.modelEditDoc = modelEditDocFor(store.mdoc, model);
}
