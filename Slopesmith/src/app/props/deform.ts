import type { PlacedProp } from '../../core/doc/types';
import { IMPORTED_PROP_LEVEL, type ImportedPropRecord } from '../../core/props/imported';
import {
  bindDeformSource, cageFolded, createPropCage, decodeDeformSource, deformSource,
  subdivideDeformSource, validatePropCage, type PropCage,
} from '../../core/props/deform';
import type { Store } from '../state/store';
import type { Viewport } from '../viewport/viewport';
import type { GizmoMode } from '../viewport/types';
import { fetchJson, postJson } from '../net/fetch-json';
import { toast } from '../ui/components/toast';
import { placedPropCollisionProfile } from '../../core/props/contact';

interface DeformDeps {
  store: Store;
  viewport: Viewport;
  isWritable(): boolean;
  ensureModels(): Promise<unknown>;
  reloadModels(): Promise<unknown>;
  commit(): void;
  rebuild(): void;
  tools(): void;
}
type Snapshot = { cage: PropCage; slices: number };

/** Cage edits are a private draft. Applying saves a new library asset and changes only this placement's
 * model reference. The shared document, its undo stack and other editors never see half a drag. */
export function createPropDeformOps(deps: DeformDeps) {
  const { store, viewport } = deps;
  let session: {
    index: number; placement: PlacedProp; signature: string; document: Store['mdoc'];
    record: ImportedPropRecord; draft: Snapshot; history: Snapshot[]; at: number;
    source: ReturnType<typeof decodeDeformSource>; prepared: ReturnType<typeof decodeDeformSource>;
    bindings: ReturnType<typeof bindDeformSource>; folded: boolean; busy: boolean;
  } | null = null;
  let loading = 0;
  const layer = viewport.propDeform;
  const signature = (p: PlacedProp) => JSON.stringify(p);
  const current = () => !!session && store.mdoc === session.document && store.currentMode === 'props'
    && store.selectedProp === session.index && store.mdoc.props?.[session.index] === session.placement
    && signature(session.placement) === session.signature;

  function redraw() {
    if (!session) return;
    layer.geometry(deformSource(session.prepared, session.draft.cage, session.bindings));
    session.folded = cageFolded(session.draft.cage);
  }
  function prepare() {
    if (!session) return;
    session.prepared = subdivideDeformSource(session.source, session.draft.cage, session.draft.slices);
    session.bindings = bindDeformSource(session.prepared, session.draft.cage);
    redraw();
  }
  function remember() {
    if (!session) return;
    if (JSON.stringify(session.history[session.at]) !== JSON.stringify(session.draft)) {
      session.history.splice(session.at + 1);
      session.history.push(structuredClone(session.draft)); session.at++;
    }
    deps.tools();
  }
  function cancel() {
    loading++;
    if (!session) return;
    session = null; layer.close(); viewport.stage.gizmo.enabled = true; deps.rebuild(); deps.tools();
  }
  async function start(index: number) {
    cancel();
    const token = ++loading, document = store.mdoc, placement = document.props?.[index];
    if (!placement || placement.level !== IMPORTED_PROP_LEVEL || placement.group || placement.line) {
      toast('Revise a single textured prop before deforming it. Prop-line members must first be released from their line.', 'warn'); return;
    }
    if (!deps.isWritable()) { toast('This mountain is read-only.', 'warn'); return; }
    if (placedPropCollisionProfile(placement).mode === 3) {
      toast('Set this prop’s contact shape to mesh proxy before deforming it.', 'warn'); return;
    }
    const before = signature(placement);
    try {
      const record = await fetchJson<ImportedPropRecord>(`/api/custom-prop-record?id=${placement.model}`);
      await deps.ensureModels();
      if (token !== loading || store.mdoc !== document || store.selectedProp !== index
        || store.currentMode !== 'props' || document.props?.[index] !== placement || signature(placement) !== before) return;
      if (record.animation || record.emitters?.length) throw new Error('Cage deformation currently supports static props without emitters.');
      const source = decodeDeformSource(record.deformation?.source ?? record.subs);
      const cage = record.deformation ? validatePropCage(record.deformation.cage, source) : createPropCage(source);
      const draft = { cage, slices: record.deformation?.slices ?? 16 };
      let prepared;
      try { prepared = subdivideDeformSource(source, cage, draft.slices); }
      catch (e) {
        if (record.deformation) throw e;
        // A dense source can already bend without extra cuts. Still let its owner open the editor.
        draft.slices = 1; prepared = subdivideDeformSource(source, cage, 1);
        toast('This prop is already dense. Bend detail starts at Original to stay within the triangle limit.', 'warn');
      }
      const template = viewport.props.placedPropMeshes[index];
      if (!template) throw new Error('The prop mesh is still loading. Try again in a moment.');
      viewport.focusProp(index);
      store.propLibWanted = false;
      session = { index, placement, signature: before, document, record, draft,
        history: [structuredClone(draft)], at: 0, source, prepared,
        bindings: bindDeformSource(prepared, cage), folded: false, busy: false };
      layer.open(cage, template, (next, finished) => {
        if (!session || session.busy) return;
        session.draft.cage = next; redraw(); if (finished) remember();
      }, deps.tools);
      store.gizmoMode = 'move'; viewport.setGizmoMode('move');
      redraw(); deps.rebuild(); deps.tools();
    } catch (e) {
      if (token !== loading) return;
      cancel(); toast(`Deform: ${e instanceof Error ? e.message : e}`, 'err', 6000);
    }
  }
  function changeDraft(run: (draft: Snapshot) => void) {
    if (!session || session.busy) return;
    const before = structuredClone(session.draft);
    try { run(session.draft); prepare(); layer.setCage(session.draft.cage); remember(); }
    catch (e) { session.draft = before; prepare(); toast(e instanceof Error ? e.message : String(e), 'err'); deps.tools(); }
  }
  function transform(mode: GizmoMode) {
    if (!session || session.busy || (mode !== 'move' && layer.selection.mode === 'corner')) return;
    store.gizmoMode = mode; viewport.setGizmoMode(mode); deps.tools();
  }
  function history(direction: number) {
    if (!session || session.busy || viewport.stage.gizmo.dragging) return;
    const at = Math.max(0, Math.min(session.history.length - 1, session.at + direction));
    session.at = at; session.draft = structuredClone(session.history[at]);
    prepare(); layer.setCage(session.draft.cage); deps.tools();
  }
  async function apply() {
    if (!session || session.busy || session.folded || !current() || !deps.isWritable() || viewport.stage.gizmo.dragging) return;
    const savedSession = session;
    savedSession.busy = true; viewport.stage.gizmo.enabled = false; deps.tools();
    try {
      const saved = await postJson<{ id: number; name: string }>(`/api/custom-prop-deform?id=${session.record.id}`,
        JSON.stringify(session.draft));
      // A project/selection switch during the request must never repoint an unrelated placement.
      if (session !== savedSession || !current()) return;
      await deps.reloadModels();
      if (session !== savedSession || !current()) return;
      deps.commit();
      const prop = session.placement;
      prop.model = saved.id; prop.name = saved.name;
      // Model bounds cannot follow a bend. Decorative props stay decorative; collidable ones use the baked mesh.
      const collision = placedPropCollisionProfile(prop);
      if (collision.mode === 2) prop.nativeCollision = { ...collision, mode: 1 };
      deps.commit(); cancel();
      toast(`Saved ${saved.name}. This placement uses it; Undo restores its previous shape.`, 'ok');
    } catch (e) { toast(`Deform failed: ${e instanceof Error ? e.message : e}`, 'err', 6000); }
    finally { savedSession.busy = false; viewport.stage.gizmo.enabled = !session?.busy; deps.tools(); }
  }
  return {
    start, cancel, apply, transform, undo: () => history(-1), redo: () => history(1),
    get active() { return session !== null; },
    get state() { return session ? { name: session.record.name, axis: session.draft.cage.axis,
      slices: session.draft.slices, folded: session.folded, busy: session.busy,
      triangles: session.prepared.reduce((n, sub) => n + sub.indices.length / 3, 0),
      canUndo: session.at > 0, canRedo: session.at + 1 < session.history.length, ...layer.selection } : null; },
    hiddenIndex(): number | null { return session && current() ? session.index : null; },
    sync() { if (!session) return; if (!current()) cancel(); else layer.sync(); },
    setAxis(axis: 0 | 1 | 2) { changeDraft(draft => { draft.cage = createPropCage(session!.source, axis); }); },
    setSlices(slices: number) { changeDraft(draft => { draft.slices = slices; }); },
    reset() { changeDraft(draft => { draft.cage = createPropCage(session!.source, draft.cage.axis); }); },
    setMode(mode: 'section' | 'corner') {
      if (!session || session.busy) return;
      if (mode === 'corner') transform('move');
      layer.setMode(mode);
    },
    select(index: number) { if (!session?.busy) layer.select(index); },
  };
}
export type PropDeformOps = ReturnType<typeof createPropDeformOps>;
