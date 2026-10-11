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
import { loadStored, saveStored } from '../state/storage';
import { toast } from '../ui/components/toast';
import { placedPropCollisionProfile } from '../../core/props/contact';

interface DeformDeps {
  store: Store;
  viewport: Viewport;
  /** The open project's id: a parked draft belongs to one project's placement and library record. */
  projectId(): string;
  isWritable(): boolean;
  ensureModels(): Promise<unknown>;
  reloadModels(): Promise<unknown>;
  commit(): void;
  rebuild(): void;
  tools(): void;
}
type Snapshot = { cage: PropCage; slices: number };

/** Unapplied cage drafts, newest first: the latest draft of each library record, kept across reloads and
 *  restored the next time that record is deformed. */
export const DEFORM_DRAFTS_KEY = 'slopesmith-deform-drafts-v1';
const KEPT_DRAFTS = 8;
const STILL_LOADING = 'The prop mesh is still loading. Try again in a moment.';
type StoredDraft = { project: string; record: number; draft: Snapshot };

function storedDrafts(): StoredDraft[] {
  const list = loadStored<StoredDraft[]>(DEFORM_DRAFTS_KEY);
  return Array.isArray(list) ? list.filter(entry => typeof entry?.project === 'string'
    && Number.isInteger(entry.record) && Array.isArray(entry.draft?.cage?.points) && Number.isInteger(entry.draft.slices)) : [];
}
function storeDraft(project: string, record: number, draft: Snapshot | null) {
  const rest = storedDrafts().filter(entry => entry.project !== project || entry.record !== record);
  saveStored(DEFORM_DRAFTS_KEY, (draft ? [{ project, record, draft: structuredClone(draft) }, ...rest] : rest).slice(0, KEPT_DRAFTS));
}

/** Cage edits are a private draft. Applying saves a new library asset and changes only this placement's
 * model reference. The shared document, its undo stack and other editors never see half a drag.
 *
 * A changed draft PARKS rather than dying when its prop leaves the editor — another mode, another selection, a
 * collaborator moving it — and resumes when Props shows that placement again. It ends only when its placement is
 * gone, no longer shows this record, or the project changes. The draft is also mirrored to localStorage per
 * record, so one that ended — closed with Escape, lost to a reload — comes back on the next deform of that record.
 * Only Apply, Discard, or undoing back to the record's own cage forgets it. */
export function createPropDeformOps(deps: DeformDeps) {
  const { store, viewport } = deps;
  let session: {
    index: number; placementId: string | undefined; placement: PlacedProp; signature: string; project: string;
    record: ImportedPropRecord; draft: Snapshot; history: Snapshot[]; at: number;
    source: ReturnType<typeof decodeDeformSource>; prepared: ReturnType<typeof decodeDeformSource>;
    bindings: ReturnType<typeof bindDeformSource>; folded: boolean; busy: boolean;
    /** Closed in the viewport, its draft held until Props shows the placement again. */
    parked: boolean;
    /** The handle picked when it parked, so resuming lands where the author left off. */
    selection: { mode: 'section' | 'corner'; index: number };
  } | null = null;
  let loading = 0;
  const layer = viewport.propDeform;
  const signature = (p: PlacedProp) => JSON.stringify(p);
  const dirty = () => !!session && JSON.stringify(session.draft) !== JSON.stringify(session.history[0]);

  /** The session's placement in the live document, found by its stable id (indices shift and a remote install
   *  replaces the objects), or null when it can no longer take this draft. */
  function locate(): number | null {
    if (!session || deps.projectId() !== session.project) return null;
    const props = store.mdoc.props ?? [];
    const { placementId, placement } = session;
    const index = placementId ? props.findIndex(p => p.id === placementId) : props.indexOf(placement);
    const prop = props[index];
    if (!prop || prop.level !== IMPORTED_PROP_LEVEL || prop.model !== session.record.id || prop.group || prop.line
      || placedPropCollisionProfile(prop).mode === 3) return null;
    return index;
  }
  const shown = (index: number) => store.currentMode === 'props' && store.selectedProp === index;

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
  /** Mirror the draft to storage: a changed one is what the next deform restores; one back at the record's own
   *  cage leaves nothing to restore. */
  function keep() {
    if (session) storeDraft(session.project, session.record.id, dirty() ? session.draft : null);
  }
  function remember() {
    if (!session) return;
    if (JSON.stringify(session.history[session.at]) !== JSON.stringify(session.draft)) {
      session.history.splice(session.at + 1);
      session.history.push(structuredClone(session.draft)); session.at++;
    }
    keep(); deps.tools();
  }
  /** Close the viewport side of an open session: the cage, the private preview, and the hidden placement. */
  function closeLayer() {
    if (session && !session.parked) session.selection = layer.selection;
    layer.close(); viewport.stage.gizmo.enabled = true;
  }
  /** End the session. Its draft, if changed, is already in storage; `note` says so to the author. */
  function end(note?: string) {
    loading++;
    if (!session) return;
    const kept = dirty() ? session.record.name : null;
    closeLayer(); session = null; deps.rebuild(); deps.tools();
    if (kept && note) toast(note.replace('$name', kept), 'info', 6000);
  }
  /** The author's Escape / Close: the editor goes, the stored draft stays for the next deform. */
  function close() {
    end('Closed the cage draft for $name. Deform with cage brings it back; Discard draft throws it away.');
  }
  /** Throw the draft away: the session and the stored copy. */
  function discard() {
    if (!session || session.busy) return;
    const { project, record } = session, changed = dirty();
    end(); storeDraft(project, record.id, null);
    if (changed) toast(`Discarded the cage draft for ${record.name}.`, 'info');
  }
  /** Put the draft aside, closed in the viewport, until Props shows its placement again. */
  function park(announce: boolean) {
    if (!session || session.parked) return;
    closeLayer(); session.parked = true; deps.rebuild(); deps.tools();
    if (announce) toast(`Kept the cage draft for ${session.record.name}. Select that prop in Props mode to continue.`, 'info', 6000);
  }
  /** Its placement left the editor. An unchanged draft has nothing to keep; one still saving parks too, so its
   *  Apply can land. */
  function leave() {
    if (!session) return;
    if (!dirty() && !session.busy) end(); else park(dirty());
  }
  /** Open the editor around the placement as it stands now. Its mesh must be built, so the placement is shown;
   *  until it is (still loading), the session stays parked and a later render tries again. `start` wants the
   *  reason instead, so it can report it. */
  function open(index: number, quiet = true): boolean {
    if (!session) return false;
    const template = viewport.props.placedPropMeshes[index];
    if (!template) return false;
    const placement = store.mdoc.props![index];
    Object.assign(session, { index, placement, signature: signature(placement), parked: false });
    try {
      layer.open(session.draft.cage, template, (next, finished) => {
        if (!session || session.busy) return;
        session.draft.cage = next; redraw(); if (finished) remember();
      }, deps.tools);
      layer.setMode(session.selection.mode); layer.select(session.selection.index);
      redraw();
    } catch (e) {
      layer.close(); session.parked = true;
      if (!quiet) throw e;
      return false;
    }
    store.gizmoMode = 'move'; viewport.setGizmoMode('move');
    deps.rebuild(); deps.tools();
    return true;
  }

  async function start(index: number) {
    const document = store.mdoc, placement = document.props?.[index];
    if (session && placement && locate() === index) { if (session.parked) open(index); return; }
    end('Kept the cage draft for $name. Deform with cage on it again brings it back.');
    const token = ++loading;
    if (!placement || placement.level !== IMPORTED_PROP_LEVEL || placement.group || placement.line) {
      toast('Revise a single textured prop before deforming it. Prop-line members must first be released from their line.', 'warn'); return;
    }
    if (!deps.isWritable()) { toast('This mountain is read-only.', 'warn'); return; }
    if (placedPropCollisionProfile(placement).mode === 3) {
      toast('Set this prop’s contact shape to mesh proxy before deforming it.', 'warn'); return;
    }
    const before = signature(placement), project = deps.projectId();
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
      if (!viewport.props.placedPropMeshes[index]) throw new Error(STILL_LOADING);
      viewport.focusProp(index);
      store.propLibWanted = false;
      session = { index, placementId: placement.id, placement, signature: before, project, record, draft,
        history: [structuredClone(draft)], at: 0, source, prepared,
        bindings: bindDeformSource(prepared, cage), folded: false, busy: false,
        parked: false, selection: { mode: 'section', index: 3 } };
      if (!open(index, false)) throw new Error(STILL_LOADING);
      restoreStored();
    } catch (e) {
      if (token !== loading) return;
      end(); toast(`Deform: ${e instanceof Error ? e.message : e}`, 'err', 6000);
    }
  }
  const editing = () => !!session && !session.parked && !session.busy;
  function changeDraft(run: (draft: Snapshot) => void): boolean {
    if (!editing()) return false;
    const before = structuredClone(session!.draft);
    try { run(session!.draft); prepare(); layer.setCage(session!.draft.cage); remember(); return true; }
    catch (e) { session!.draft = before; prepare(); toast(e instanceof Error ? e.message : String(e), 'err'); deps.tools(); return false; }
  }
  function transform(mode: GizmoMode) {
    if (!editing() || (mode !== 'move' && layer.selection.mode === 'corner')) return;
    store.gizmoMode = mode; viewport.setGizmoMode(mode); deps.tools();
  }
  function history(direction: number) {
    if (!session || !editing() || viewport.stage.gizmo.dragging) return;
    const at = Math.max(0, Math.min(session.history.length - 1, session.at + direction));
    session.at = at; session.draft = structuredClone(session.history[at]);
    prepare(); layer.setCage(session.draft.cage); keep(); deps.tools();
  }
  /** Pick up where the last session of this record left off, as one undoable step after its own cage. A stored
   *  draft that no longer fits the record is dropped rather than refused on every open. */
  function restoreStored() {
    if (!session) return;
    const { project, record, source } = session;
    const stored = storedDrafts().find(entry => entry.project === project && entry.record === record.id)?.draft;
    if (!stored) return;
    let cage: PropCage;
    try { cage = validatePropCage(structuredClone(stored.cage), source); }
    catch {
      storeDraft(project, record.id, null);
      toast(`Dropped an older cage draft for ${record.name}: it no longer fits this prop.`, 'warn', 6000);
      return;
    }
    const restored = changeDraft(draft => { draft.cage = cage; draft.slices = stored.slices; });
    if (restored) toast(`Restored the unapplied cage draft for ${record.name}. Ctrl+Z returns to its current shape.`, 'info', 6000);
    else storeDraft(project, record.id, null);
  }
  async function apply() {
    if (!session || !editing() || session.folded || locate() !== session.index || !deps.isWritable()
      || viewport.stage.gizmo.dragging) return;
    const savedSession = session;
    savedSession.busy = true; viewport.stage.gizmo.enabled = false; deps.tools();
    try {
      const saved = await postJson<{ id: number; name: string }>(`/api/custom-prop-deform?id=${session.record.id}`,
        JSON.stringify(session.draft));
      // The placement is found again by its id: a project switch or a deletion during the request must never
      // repoint an unrelated placement. Leaving Props meanwhile only parked the draft, so the save still lands.
      if (session !== savedSession || locate() === null) return;
      await deps.reloadModels();
      const index = locate();
      if (session !== savedSession || index === null) return;
      deps.commit();
      const prop = store.mdoc.props![index];
      prop.model = saved.id; prop.name = saved.name;
      // Model bounds cannot follow a bend. Decorative props stay decorative; collidable ones use the baked mesh.
      const collision = placedPropCollisionProfile(prop);
      if (collision.mode === 2) prop.nativeCollision = { ...collision, mode: 1 };
      deps.commit();
      storeDraft(savedSession.project, savedSession.record.id, null);
      end();
      toast(`Saved ${saved.name}. This placement uses it; Undo restores its previous shape.`, 'ok');
    } catch (e) { toast(`Deform failed: ${e instanceof Error ? e.message : e}`, 'err', 6000); }
    finally { savedSession.busy = false; viewport.stage.gizmo.enabled = !session?.busy; deps.tools(); }
  }
  return {
    start, close, discard, leave, apply, transform, undo: () => history(-1), redo: () => history(1),
    /** Open in the viewport and taking input. A parked draft is not active. */
    get active() { return !!session && !session.parked; },
    get parked() { return !!session?.parked; },
    get state() { return session ? { name: session.record.name, axis: session.draft.cage.axis,
      slices: session.draft.slices, folded: session.folded, busy: session.busy,
      triangles: session.prepared.reduce((n, sub) => n + sub.indices.length / 3, 0),
      canUndo: session.at > 0, canRedo: session.at + 1 < session.history.length,
      changed: dirty(), ...layer.selection } : null; },
    /** What a page unload would lose, for the unsaved-work guard: a changed draft, open or parked. */
    get unsaved(): string | null { return session && dirty() ? `an unapplied cage draft for ${session.record.name}` : null; },
    /** Whether a library record has an unapplied draft stored in this project. */
    hasStoredDraft(record: number) {
      const project = deps.projectId();
      return storedDrafts().some(entry => entry.project === project && entry.record === record);
    },
    hiddenIndex(): number | null { return session && !session.parked ? locate() : null; },
    /** Follow the document, the mode and the selection: park a draft whose prop left the editor, re-seat one whose
     *  placement moved under it, resume a parked one Props shows again, and end one whose placement is gone. */
    sync() {
      if (!session) return;
      const index = locate();
      if (index === null) { end('Stopped deforming $name: its placement changed. The draft is kept; deform that prop again to bring it back.'); return; }
      session.index = index;
      if (!shown(index)) { leave(); return; }
      if (session.parked) { if (!session.busy) open(index); return; }
      // The preview was built around the old pose and the placement is hidden, so its new mesh cannot be read
      // yet: park quietly, and the render that shows it again resumes the editor around it.
      if (signature(store.mdoc.props![index]) !== session.signature) park(false);
      else layer.sync();
    },
    setAxis(axis: 0 | 1 | 2) { changeDraft(draft => { draft.cage = createPropCage(session!.source, axis); }); },
    setSlices(slices: number) { changeDraft(draft => { draft.slices = slices; }); },
    reset() { changeDraft(draft => { draft.cage = createPropCage(session!.source, draft.cage.axis); }); },
    setMode(mode: 'section' | 'corner') {
      if (!editing()) return;
      if (mode === 'corner') transform('move');
      layer.setMode(mode);
    },
    select(index: number) { if (editing()) layer.select(index); },
  };
}
export type PropDeformOps = ReturnType<typeof createPropDeformOps>;
