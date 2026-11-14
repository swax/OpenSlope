import type { QuadMeshDoc } from '../../core/doc/types';
import { bendSubdivisionCage, defaultBendSettings, type BendSettings } from '../../core/mesh/subdivision-bend';
import { subdivisionSource } from '../../core/mesh/subdivision-object';
import type { Store } from '../state/store';
import type { EditViewportPort } from './viewport-port';
import { commitEditMesh } from './mesh-target';
import { toast } from '../ui/components/toast';

type BendDeps = {
  store: Store;
  viewport(): EditViewportPort;
  commitHistory?: () => void;
  scheduleRebuild(): void;
  rebuildTools(): void;
  updateCmdSheet(): void;
  selectSurfaceControls(id: string): void;
  clearSelection(): void;
};

/** A private preview, like prop deformation: every update starts from the captured cage, Apply is one edit. */
export function createSubdivisionBendTools(deps: BendDeps) {
  const { store } = deps;
  let session: {
    id: string;
    name: string;
    live: QuadMeshDoc;
    input: QuadMeshDoc;
    stamp: string;
    settings: BendSettings;
    result: ReturnType<typeof bendSubdivisionCage> | null;
    error: string | null;
  } | null = null;
  const active = () => store.currentMode === 'edit' && store.surgeryTool === 'bend' && session !== null;

  function updateSubdivisionBend(values: Partial<BendSettings>) {
    if (!active() || !session) return;
    Object.assign(session.settings, values);
    if (session.settings.direction === session.settings.axis)
      session.settings.direction = session.settings.axis === 1 ? 0 : 1;
    session.result = null;
    session.error = null;
    try {
      if (store.mdoc !== session.live)
        throw new Error('The document changed during this preview. Cancel and start Bend again.');
      session.result = bendSubdivisionCage(session.input, session.id, session.settings);
      deps.viewport().showEditDraftPreview?.(session.result.doc);
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      if (store.mdoc === session.live) deps.viewport().showEditDraftPreview?.(session.input);
    }
  }

  function beginSubdivisionBend(id: string) {
    if (store.modelEditId || store.surgeryTool) return;
    const surface = store.mdoc.surfaces?.find(s => s.id === id);
    if (!surface?.subdivision) return;
    try {
      const settings = defaultBendSettings(subdivisionSource(store.mdoc, surface).points);
      deps.commitHistory?.();
      session = {
        id,
        name: surface.name,
        live: store.mdoc,
        input: structuredClone(store.mdoc),
        stamp: JSON.stringify(store.mdoc),
        settings,
        result: null,
        error: null,
      };
      deps.clearSelection();
      store.surgeryTool = 'bend';
      deps.viewport().setSurgeryTool('bend');
      updateSubdivisionBend({});
      deps.rebuildTools();
      deps.updateCmdSheet();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'err');
    }
  }

  function cancelSubdivisionBend(restoreSelection = true) {
    if (!active() || !session) {
      session = null;
      return;
    }
    const { id, live } = session;
    session = null;
    store.surgeryTool = null;
    deps.viewport().setSurgeryTool(null);
    if (store.mdoc !== live) deps.scheduleRebuild();
    if (restoreSelection) deps.selectSurfaceControls(id);
    deps.rebuildTools();
    deps.updateCmdSheet();
  }

  function applySubdivisionBend() {
    if (!active() || !session || !session.result || session.error || session.settings.angle === 0) return;
    if (store.mdoc !== session.live || JSON.stringify(store.mdoc) !== session.stamp) {
      session.result = null;
      session.error = 'The document changed during this preview. Cancel and start Bend again.';
      deps.rebuildTools();
      return;
    }
    const { id, result } = session;
    session = null;
    store.surgeryTool = null;
    deps.viewport().setSurgeryTool(null);
    deps.commitHistory?.();
    commitEditMesh(store, result.doc);
    deps.scheduleRebuild();
    deps.selectSurfaceControls(id);
    deps.commitHistory?.();
    deps.rebuildTools();
    deps.updateCmdSheet();
    toast('Bend applied · the subdivision cage remains editable', 'ok');
  }

  return {
    beginSubdivisionBend,
    updateSubdivisionBend,
    applySubdivisionBend,
    cancelSubdivisionBend,
    subdivisionBendState() {
      if (!active() || !session) return null;
      return {
        id: session.id,
        name: session.name,
        settings: { ...session.settings },
        error: session.error,
        radiusM: session.result?.radiusM ?? null,
        canApply: !!session.result && !session.error && session.settings.angle !== 0,
      };
    },
  };
}
