import type { QuadMeshDoc, V3 } from '../../core/doc/types';
import { bendSubdivisionCage, defaultBendSettings, type BendSettings } from '../../core/mesh/subdivision-bend';
import { subdivisionSource } from '../../core/mesh/subdivision-object';
import type { Store } from '../state/store';
import type { EditViewportPort } from './viewport-port';
import { commitEditMesh } from './mesh-target';
import { toast } from '../ui/components/toast';
import type { BendHandleMode } from '../viewport/tools/subdivision-bend';
import type { GizmoMode } from '../viewport/types';

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
    source: ReturnType<typeof subdivisionSource>;
    offsets: V3[];
    mode: BendHandleMode;
    index: number;
    dragging: boolean;
  } | null = null;
  const active = () => store.currentMode === 'edit' && store.surgeryTool === 'bend' && session !== null;

  function sections() {
    if (!session) return [];
    const axis = session.settings.axis;
    const stations = new Map<number, number[]>();
    session.source.points.forEach((p, i) => {
      const ids = stations.get(p[axis]) ?? [];
      ids.push(i);
      stations.set(p[axis], ids);
    });
    return [...stations].sort(([a], [b]) => a - b).map(([, ids]) => ids);
  }
  const selected = () => (session!.mode === 'point' ? [session!.index] : sections()[session!.index]);
  function handlePosition(): V3 {
    const points = session!.result?.points ?? session!.source.points;
    const ids = selected();
    return [0, 1, 2].map(a => ids.reduce((n, i) => n + points[i][a], 0) / ids.length) as V3;
  }
  function showHandles() {
    const current = session;
    deps.viewport().setSubdivisionBendHandles?.(
      current?.result
        ? {
            points: current.result.points,
            edges: current.source.faces.flatMap(face =>
              face.map((a, i) => [a, face[(i + 1) % face.length]] as [number, number]),
            ),
            sections: sections(),
            mode: current.mode,
            index: current.index,
            onSelect: index => selectSubdivisionBendHandle(current.mode, index),
            onChange(points, finished) {
              if (session !== current || !active() || !current.result) return;
              current.offsets = points.map(
                (p, i) => p.map((n, a) => current.offsets[i][a] + (n - current.result!.points[i][a])) as V3,
              );
              current.dragging = !finished;
              updateSubdivisionBend({});
              if (finished) deps.rebuildTools();
            },
          }
        : null,
    );
  }

  function selectSubdivisionBendHandle(mode: BendHandleMode, index = 0) {
    if (!active() || !session || session.dragging) return;
    session.mode = mode;
    const count = mode === 'point' ? session.source.points.length : sections().length;
    session.index = Math.max(0, Math.min(count - 1, Math.round(index)));
    transformSubdivisionBend('move');
    showHandles();
    deps.rebuildTools();
  }
  function transformSubdivisionBend(mode: GizmoMode) {
    if (!active() || !session || session.dragging || (mode !== 'move' && selected().length < 2)) return;
    store.gizmoMode = mode;
    deps.viewport().setGizmoMode?.(mode);
  }
  function moveSubdivisionBendHandle(axis: number, value: number) {
    if (!active() || !session || session.dragging || !Number.isFinite(value)) return;
    const delta = value - handlePosition()[axis];
    for (const i of selected()) session.offsets[i][axis] += delta;
    updateSubdivisionBend({});
  }
  function resetSubdivisionBend(manualOnly = false) {
    if (!active() || !session || session.dragging) return;
    session.offsets = session.source.points.map(() => [0, 0, 0]);
    updateSubdivisionBend(manualOnly ? {} : { angle: 0, risePerTurn: 0 });
    deps.rebuildTools();
  }

  function updateSubdivisionBend(values: Partial<BendSettings>) {
    if (!active() || !session) return;
    Object.assign(session.settings, values);
    if (values.axis !== undefined) session.index = 0;
    if (session.settings.direction === session.settings.axis)
      session.settings.direction = session.settings.axis === 1 ? 0 : 1;
    session.result = null;
    session.error = null;
    try {
      if (store.mdoc !== session.live)
        throw new Error('The document changed during this preview. Cancel and start Bend again.');
      session.result = bendSubdivisionCage(session.input, session.id, session.settings, session.offsets);
      deps.viewport().showEditDraftPreview?.(session.result.doc);
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      if (store.mdoc === session.live) deps.viewport().showEditDraftPreview?.(session.input);
    }
    showHandles();
  }

  function beginSubdivisionBend(id: string) {
    if (store.modelEditId || store.surgeryTool) return;
    const surface = store.mdoc.surfaces?.find(s => s.id === id);
    if (!surface?.subdivision) return;
    try {
      const source = subdivisionSource(store.mdoc, surface);
      const settings = { ...defaultBendSettings(source.points), risePerTurn: 0 };
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
        source,
        offsets: source.points.map(() => [0, 0, 0]),
        mode: 'section',
        index: 0,
        dragging: false,
      };
      deps.clearSelection();
      store.surgeryTool = 'bend';
      deps.viewport().setSurgeryTool('bend');
      transformSubdivisionBend('move');
      updateSubdivisionBend({});
      deps.rebuildTools();
      deps.updateCmdSheet();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'err');
    }
  }

  function cancelSubdivisionBend(restoreSelection = true) {
    deps.viewport().setSubdivisionBendHandles?.(null);
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
    if (
      !active() ||
      !session ||
      !session.result ||
      session.error ||
      session.dragging ||
      session.result.doc === session.input
    )
      return;
    if (store.mdoc !== session.live || JSON.stringify(store.mdoc) !== session.stamp) {
      session.result = null;
      session.error = 'The document changed during this preview. Cancel and start Bend again.';
      deps.rebuildTools();
      return;
    }
    const { id, result } = session;
    deps.viewport().setSubdivisionBendHandles?.(null);
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
    selectSubdivisionBendHandle,
    transformSubdivisionBend,
    moveSubdivisionBendHandle,
    resetSubdivisionBend,
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
        mode: session.mode,
        index: session.index,
        count: session.mode === 'point' ? session.source.points.length : sections().length,
        position: handlePosition(),
        canTransform: selected().length > 1,
        transform: store.gizmoMode,
        manual: session.offsets.some(p => p.some(n => n !== 0)),
        canApply: !!session.result && !session.error && !session.dragging && session.result.doc !== session.input,
      };
    },
  };
}
