import type { V3 } from '../../core/doc/types';
import { getVertex, quadVerts } from '../../core/doc/doc-edit';
import { meshFromDoc, quadControlPoints } from '../../core/mesh/topology';
import {
  copyMeshVertices, meshClipboardText, pasteMeshVertices, type MeshVertexClipboard,
} from '../../core/mesh/clipboard';
import type { MeshControlPointId } from '../../core/mesh/control-points';
import type { Store } from '../state/store';
import {
  namedEdges, quadIndices, quadNaming, vertexNames, vertexNaming, type VertexName,
} from '../state/mesh-names';
import { commitEditMesh, editMesh } from './mesh-target';
import type { EditViewportPort } from './viewport-port';
import { toast } from '../ui/components/toast';

export type MeshClipboardDeps = {
  store: Store;
  viewport: () => EditViewportPort;
  cageActive: () => boolean;
  selectedAuthoredVertices: () => VertexName[];
  editMoveSet: () => number[];
  seatMoveGizmo: () => void;
  resetGizmoMode: () => void;
  deselectEdit: () => void;
  refreshHandles: () => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  deleteSelectedMesh: () => void;
};

/** Session-local topology-aware mesh clipboard and one-shot placement workflow. */
export function createMeshClipboardSession(deps: MeshClipboardDeps) {
  const {
    store, viewport: getViewport, cageActive, selectedAuthoredVertices, editMoveSet, seatMoveGizmo,
    resetGizmoMode, deselectEdit, refreshHandles, scheduleRebuild, rebuildTools, updateCmdSheet,
    deleteSelectedMesh,
  } = deps;
  const view = () => getViewport();
  const mdoc = () => editMesh(store); // the edit target: the mountain net, or the model being edited
  let clipboard: MeshVertexClipboard | null = null;
  let pasteArmed = false;

  /** The vertices a copy would take, named — the union of whichever family is live. */
  function selectedCopyVertices(): VertexName[] {
    const selected = selectedAuthoredVertices();
    if (selected.length) return selected;
    const doc = mdoc();
    const vertices = new Set<VertexName>();
    if (store.edgeSel.length) for (const [a, b] of store.edgeSel) { vertices.add(a); vertices.add(b); }
    else for (const quad of quadIndices(doc, store.cellSel)) for (const vertex of vertexNames(doc, quadVerts(doc, quad))) vertices.add(vertex);
    return [...vertices].sort();
  }

  function copySelectionVertexCount(): number { return selectedCopyVertices().length || view().referenceCopyVertexCount(); }
  function canCopyVertices(): boolean { return store.currentMode === 'edit' && store.bridgeRails === null && cageActive() && copySelectionVertexCount() > 0; }
  function canPasteVertices(): boolean { return store.currentMode === 'edit' && store.bridgeRails === null && cageActive() && !!clipboard?.vertices.length; }

  function captureSelectedVertices(): { source: 'authored' | 'reference'; clip: MeshVertexClipboard } | null {
    if (!canCopyVertices()) return null;
    const selectedVertices = selectedCopyVertices();
    const referenceSelected = !selectedVertices.length && view().referenceCopyVertexCount() > 0;
    let clip = referenceSelected ? view().copyReferenceMeshSelection() : null;
    if (!referenceSelected) {
      const doc = mdoc();
      const { mesh, edgeHandle } = meshFromDoc(doc);
      clip = copyMeshVertices({
        mesh,
        naming: vertexNaming(doc),
        quadNaming: quadNaming(doc),
        selectedVertices,
        selectedQuads: store.edgeSel.length ? [] : store.cellSel.length ? store.cellSel : undefined,
        selectedEdges: store.edgeSel.length ? store.edgeSel : store.cellSel.length ? [] : undefined,
        edgeHandle,
        controls: quad => quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad] ?? null),
        paint: quad => doc.quadPaint?.[quad],
        texture: quad => doc.quadTex?.[quad],
        orientation: quad => doc.quadOrient?.[quad],
        locked: quad => doc.quadLocked?.[quad] === true,
        labels: quad => doc.quadLabels?.[quad],
        labelDefinitions: doc.labels,
        tJunctions: doc.tJunctions,
      });
    }
    if (!clip) { toast('nothing copied — select at least one vertex', 'warn'); return null; }
    clipboard = clip;
    return { source: referenceSelected ? 'reference' : 'authored', clip };
  }

  function clipboardSummary(clip: MeshVertexClipboard): string {
    const vertices = clip.vertices.length / 3, edges = clip.freeEdges?.length ?? 0, patches = clip.quads.length;
    return `${vertices} ${vertices === 1 ? 'vertex' : 'vertices'}${edges ? ` · ${edges} ${edges === 1 ? 'edge' : 'edges'}` : ''}${patches ? ` · ${patches} ${patches === 1 ? 'patch' : 'patches'}` : ''}`;
  }

  function copySelectedVertices() {
    const captured = captureSelectedVertices();
    if (!captured) return;
    const summary = clipboardSummary(captured.clip);
    const referenceLevel = captured.source === 'reference' ? view().refLevelName : undefined;
    const referenceOffset = captured.source === 'reference' ? view().referenceOffset?.() : undefined;
    const text = meshClipboardText(captured.clip, {
      source: captured.source,
      ...(referenceLevel ? { level: referenceLevel } : {}),
      ...(referenceOffset ? { referenceOffset } : {}),
    });
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      toast(`copied ${summary} inside Slopesmith — system text clipboard is unavailable`, 'warn');
    } else {
      void navigator.clipboard.writeText(text).then(
        () => toast(`copied ${summary} · text ready to paste`, 'ok'),
        () => toast(`copied ${summary} inside Slopesmith — browser blocked the text clipboard`, 'warn'),
      );
    }
    rebuildTools();
  }

  function cutSelectedVertices() {
    const captured = captureSelectedVertices();
    if (!captured) return;
    if (captured.source === 'reference') {
      toast(`reference is read-only — copied ${clipboardSummary(captured.clip)} instead`, 'warn');
      rebuildTools();
      return;
    }
    deleteSelectedMesh();
  }

  function pasteSelectedVertices() {
    if (!canPasteVertices() || !clipboard) return;
    if (store.surgeryTool) { store.surgeryTool = null; view().setSurgeryTool(null); }
    if (store.weldTool) { store.weldTool = null; store.weldSource = []; store.weldEdgeSource = []; view().setWeldTool(false); }
    deselectEdit();
    pasteArmed = true;
    view().setPasteTool(clipboard);
    rebuildTools(); updateCmdSheet();
    toast('paste ready — click terrain or empty space to place it · Esc cancels', 'info');
  }

  function cancelPastePlacement(refresh = true) {
    if (!pasteArmed && !view().pastePlacing) return;
    pasteArmed = false;
    view().setPasteTool(null);
    if (refresh) { rebuildTools(); updateCmdSheet(); }
  }

  function commitPastedVertices(translation: V3) {
    if (!pasteArmed || !clipboard) return;
    const pasted = pasteMeshVertices(mdoc(), clipboard, translation);
    cancelPastePlacement(false);
    commitEditMesh(store, pasted.doc);
    resetGizmoMode();
    const doc = mdoc();
    const edgeOnly = pasted.freeEdges.length > 0 && pasted.quads.length === 0;
    const vertices = vertexNames(doc, pasted.vertices);
    const freeEdges = namedEdges(doc, pasted.freeEdges);
    store.regionSel = edgeOnly ? [] : vertices;
    store.controlSel = edgeOnly ? [] : vertices.map(vertex => ({ kind: 'vertex', vertex }) as MeshControlPointId);
    store.edgeSel = edgeOnly ? freeEdges : [];
    store.anchorEdge = edgeOnly ? freeEdges[0] ?? null : null;
    store.selectedCorner = null;
    store.anchorCorner = edgeOnly ? null : vertices[0] ?? null;
    scheduleRebuild();
    requestAnimationFrame(() => {
      if (edgeOnly) {
        view().refreshEditEdges(); seatMoveGizmo();
      } else {
        const move = editMoveSet();
        view().setCornerGroup(move.map(vertex => getVertex(mdoc(), vertex)), move);
        refreshHandles();
      }
    });
    rebuildTools(); updateCmdSheet();
    const points = pasted.vertices.length, edges = pasted.freeEdges.length, patches = pasted.quads.length;
    toast(`pasted ${points} ${points === 1 ? 'vertex' : 'vertices'}${edges ? ` · ${edges} ${edges === 1 ? 'edge' : 'edges'}` : ''}${patches ? ` · ${patches} ${patches === 1 ? 'patch' : 'patches'}` : ''}`, 'ok');
  }

  return {
    copySelectedVertices, cutSelectedVertices, copySelectionVertexCount, canCopyVertices,
    pasteSelectedVertices, canPasteVertices, cancelPastePlacement, commitPastedVertices,
  };
}

export type MeshClipboardSession = ReturnType<typeof createMeshClipboardSession>;
