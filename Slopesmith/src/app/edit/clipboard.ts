import type { V3 } from '../../core/doc/types';
import { getVertex, quadVerts } from '../../core/doc/doc-edit';
import { meshFromDoc, quadControlPoints } from '../../core/mesh/topology';
import { edgeLockIsSet } from '../../core/mesh/locks';
import {
  copyMeshVertices,
  meshClipboardText,
  pasteMeshVertices,
  type MeshVertexClipboard,
} from '../../core/mesh/clipboard';
import type { MeshControlPointId } from '../../core/mesh/control-points';
import { clonePlacementTables, copyPlacements, pastePlacements, type PropClipboard } from '../../core/props/clipboard';
import { isEffectTriggerProp } from '../../core/effects/trigger-volume';
import { selectedSetLights, setSelectedSet, type Store } from '../state/store';
import {
  edgeIndices,
  namedEdges,
  quadIndices,
  quadNames,
  quadNaming,
  vertexIndices,
  vertexNames,
  vertexNaming,
  type VertexName,
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
  refreshMixedSelection?: () => void;
};

/** Session-local topology-aware mesh clipboard and one-shot placement workflow. */
export function createMeshClipboardSession(deps: MeshClipboardDeps) {
  const {
    store,
    viewport: getViewport,
    cageActive,
    selectedAuthoredVertices,
    editMoveSet,
    seatMoveGizmo,
    resetGizmoMode,
    deselectEdit,
    refreshHandles,
    scheduleRebuild,
    rebuildTools,
    updateCmdSheet,
    deleteSelectedMesh,
    refreshMixedSelection,
  } = deps;
  const view = () => getViewport();
  const mdoc = () => editMesh(store); // the edit target: the mountain net, or the model being edited
  let clipboard: MeshVertexClipboard | null = null;
  let clipboardProps: PropClipboard | null = null;
  let clipboardSkippedProps = 0;
  let clipboardSelection: { points: number[]; edges: [number, number][]; patches: boolean; mixed: boolean } | null =
    null;
  let pasteArmed = false;

  /** All selected authored components share one vertex table in the clipboard. */
  function selectedCopyVertices(): VertexName[] {
    const doc = mdoc();
    const vertices = new Set<VertexName>(selectedAuthoredVertices());
    for (const point of store.controlSel) if (point.kind === 'vertex') vertices.add(point.vertex);
    for (const [a, b] of store.edgeSel) {
      vertices.add(a);
      vertices.add(b);
    }
    for (const quad of quadIndices(doc, store.cellSel))
      for (const vertex of vertexNames(doc, quadVerts(doc, quad))) vertices.add(vertex);
    return [...vertices].sort();
  }

  function copySelectionVertexCount(): number {
    return selectedCopyVertices().length || view().referenceCopyVertexCount();
  }
  function canCopyVertices(): boolean {
    return store.currentMode === 'edit' && store.bridgeRails === null && cageActive() && copySelectionVertexCount() > 0;
  }
  function canPasteVertices(): boolean {
    return (
      store.currentMode === 'edit' &&
      (store.clipboardKind === 'mesh' || store.clipboardKind === 'mixed') &&
      store.bridgeRails === null &&
      cageActive() &&
      !!clipboard?.vertices.length
    );
  }

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
        selectedQuads: store.cellSel.length ? store.cellSel : store.edgeSel.length ? [] : undefined,
        selectedEdges: store.edgeSel.length ? store.edgeSel : store.cellSel.length ? [] : undefined,
        edgeHandle,
        controls: quad => quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad] ?? null),
        paint: quad => doc.quadPaint?.[quad],
        texture: quad => doc.quadTex?.[quad],
        orientation: quad => doc.quadOrient?.[quad],
        locked: quad => doc.quadLocked?.[quad] === true,
        edgeLocked: (a, b) => edgeLockIsSet(doc, a, b),
        labels: quad => doc.quadLabels?.[quad],
        labelDefinitions: doc.labels,
        tJunctions: doc.tJunctions,
      });
    }
    if (!clip) {
      toast('nothing copied — select at least one vertex', 'warn');
      return null;
    }
    clipboard = clip;
    const props = store.modelEditId
      ? []
      : store.multiSel.length
        ? store.multiSel
        : store.selectedProp !== null
          ? [store.selectedProp]
          : [];
    clipboardSelection = null;
    if (!referenceSelected) {
      const doc = mdoc();
      const ordered = [...new Set(vertexIndices(doc, selectedVertices))].sort((a, b) => a - b);
      const local = new Map(ordered.map((index, at) => [index, at] as const));
      const pointNames = [
        ...new Set([
          ...selectedAuthoredVertices(),
          ...store.controlSel.flatMap(point => (point.kind === 'vertex' ? [point.vertex] : [])),
        ]),
      ];
      const points = vertexIndices(doc, pointNames).flatMap(index => local.get(index) ?? []);
      const edges = edgeIndices(doc, store.edgeSel).flatMap(([a, b]) => {
        const from = local.get(a),
          to = local.get(b);
        return from !== undefined && to !== undefined ? [[from, to] as [number, number]] : [];
      });
      const patches = store.cellSel.length > 0;
      clipboardSelection = {
        points,
        edges,
        patches,
        mixed: Number(points.length > 0) + Number(edges.length > 0) + Number(patches) + Number(props.length > 0) > 1,
      };
    }
    clipboardSkippedProps = props.filter(index => isEffectTriggerProp(store.mdoc.props?.[index])).length;
    clipboardProps = props.length ? copyPlacements(store.mdoc, props, undefined, selectedSetLights(store)) : null;
    if (clipboardProps) {
      // The mesh ghost supplies the shared placement delta. Keep prop origins in that same frame.
      const count = clip.vertices.length / 3;
      clipboardProps.anchor = [0, 1, 2].map(
        axis => clip.vertices.reduce((sum, value, index) => (index % 3 === axis ? sum + value : sum), 0) / count,
      ) as V3;
    }
    store.clipboardKind = clipboardProps ? 'mixed' : 'mesh';
    return { source: referenceSelected ? 'reference' : 'authored', clip };
  }

  function clipboardSummary(clip: MeshVertexClipboard): string {
    const vertices = clip.vertices.length / 3,
      edges = clip.freeEdges?.length ?? 0,
      patches = clip.quads.length;
    return `${vertices} ${vertices === 1 ? 'vertex' : 'vertices'}${edges ? ` · ${edges} ${edges === 1 ? 'edge' : 'edges'}` : ''}${patches ? ` · ${patches} ${patches === 1 ? 'patch' : 'patches'}` : ''}`;
  }

  function copySelectedVertices() {
    const captured = captureSelectedVertices();
    if (!captured) return;
    const summary =
      clipboardSummary(captured.clip) +
      (clipboardProps
        ? ` · ${clipboardProps.entries.length} ${clipboardProps.entries.length === 1 ? 'prop' : 'props'}`
        : '') +
      (clipboardSkippedProps
        ? ` · ${clipboardSkippedProps} trigger ${clipboardSkippedProps === 1 ? 'volume' : 'volumes'} skipped`
        : '');
    const referenceLevel = captured.source === 'reference' ? view().refLevelName : undefined;
    const referenceOffset = captured.source === 'reference' ? view().referenceOffset?.() : undefined;
    let text = meshClipboardText(captured.clip, {
      source: captured.source,
      ...(referenceLevel ? { level: referenceLevel } : {}),
      ...(referenceOffset ? { referenceOffset } : {}),
    });
    if (clipboardProps) {
      const payload = JSON.parse(text) as { selection: Record<string, unknown> };
      payload.selection.placements = clipboardProps;
      text = JSON.stringify(payload, null, 2);
    }
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
    // A trigger volume belongs to Effects and was deliberately omitted by copyPlacements.
    // Leave it in the document when cutting a mixed selection as well.
    if (store.multiSel.length) {
      const lights = selectedSetLights(store);
      const copyable = store.multiSel.filter(index => !isEffectTriggerProp(store.mdoc.props?.[index]));
      setSelectedSet(store, copyable, copyable.length ? lights : []);
    } else if (store.selectedProp !== null && isEffectTriggerProp(store.mdoc.props?.[store.selectedProp])) {
      store.selectedProp = null;
    }
    if (captured.source === 'reference') {
      if (clipboardProps) deleteSelectedMesh();
      toast(
        `reference is read-only — copied its geometry${clipboardProps ? ' and cut the selected props' : ' instead'}`,
        'warn',
      );
      rebuildTools();
      return;
    }
    deleteSelectedMesh();
  }

  function pasteSelectedVertices() {
    if (!canPasteVertices() || !clipboard) return;
    if (store.surgeryTool) {
      store.surgeryTool = null;
      view().setSurgeryTool(null);
    }
    if (store.weldTool) {
      store.weldTool = null;
      store.weldSource = [];
      store.weldEdgeSource = [];
      view().setWeldTool(false);
    }
    deselectEdit();
    pasteArmed = true;
    view().setPasteTool(
      clipboard,
      store.clipboardKind === 'mixed' ? clipboardProps?.entries.map(entry => entry.prop.pos) : undefined,
    );
    rebuildTools();
    updateCmdSheet();
    toast(
      clipboardProps && store.clipboardKind === 'mixed'
        ? `paste ready — click to place geometry and ${clipboardProps.entries.length} ${clipboardProps.entries.length === 1 ? 'prop' : 'props'} · Esc cancels`
        : 'paste ready — click terrain or empty space to place it · Esc cancels',
      'info',
    );
  }

  function cancelPastePlacement(refresh = true) {
    if (!pasteArmed && !view().pastePlacing) return;
    pasteArmed = false;
    view().setPasteTool(null);
    if (refresh) {
      rebuildTools();
      updateCmdSheet();
    }
  }

  function commitPastedVertices(translation: V3) {
    if (!pasteArmed || !clipboard) return;
    // pastePlacements appends to document tables in place; isolate those tables from the prior history state.
    const source = store.clipboardKind === 'mixed' && clipboardProps ? clonePlacementTables(mdoc()) : mdoc();
    const pasted = pasteMeshVertices(source, clipboard, translation);
    const propsClip = clipboardProps;
    const placed =
      store.clipboardKind === 'mixed' && propsClip
        ? pastePlacements(pasted.doc, propsClip, {
            pos: [0, 1, 2].map(axis => propsClip.anchor[axis] + translation[axis]) as V3,
            yaw: 0,
            scale: 1,
          })
        : null;
    cancelPastePlacement(false);
    commitEditMesh(store, pasted.doc);
    resetGizmoMode();
    const doc = mdoc();
    const edgeOnly = pasted.freeEdges.length > 0 && pasted.quads.length === 0;
    const vertices = vertexNames(doc, pasted.vertices);
    const freeEdges = namedEdges(doc, pasted.freeEdges);
    const mixed = clipboardSelection?.mixed === true;
    const selectedPoints = mixed
      ? vertexNames(
          doc,
          clipboardSelection!.points.map(local => pasted.vertices[local]),
        )
      : edgeOnly
        ? []
        : vertices;
    const selectedEdges = mixed
      ? namedEdges(
          doc,
          clipboardSelection!.edges.map(([a, b]) => [pasted.vertices[a], pasted.vertices[b]] as [number, number]),
        )
      : edgeOnly
        ? freeEdges
        : [];
    store.regionSel = selectedPoints;
    store.controlSel = selectedPoints.map(vertex => ({ kind: 'vertex', vertex }) as MeshControlPointId);
    store.edgeSel = selectedEdges;
    store.cellSel = mixed && clipboardSelection!.patches ? quadNames(doc, pasted.quads) : [];
    store.anchorEdge = selectedEdges[0] ?? null;
    store.anchorCell = store.cellSel[0] ?? null;
    store.selectedCorner = null;
    store.anchorCorner = selectedPoints[0] ?? null;
    if (placed?.indices.length) {
      store.selectedProp = null;
      setSelectedSet(store, placed.indices, placed.lights);
    }
    scheduleRebuild();
    requestAnimationFrame(() => {
      if ((mixed || placed?.indices.length) && refreshMixedSelection) refreshMixedSelection();
      else if (edgeOnly) {
        view().refreshEditEdges();
        seatMoveGizmo();
      } else {
        const move = editMoveSet();
        view().setCornerGroup(
          move.map(vertex => getVertex(mdoc(), vertex)),
          move,
        );
        refreshHandles();
      }
    });
    rebuildTools();
    updateCmdSheet();
    const points = pasted.vertices.length,
      edges = pasted.freeEdges.length,
      patches = pasted.quads.length;
    toast(
      `pasted ${points} ${points === 1 ? 'vertex' : 'vertices'}${edges ? ` · ${edges} ${edges === 1 ? 'edge' : 'edges'}` : ''}${patches ? ` · ${patches} ${patches === 1 ? 'patch' : 'patches'}` : ''}${placed?.indices.length ? ` · ${placed.indices.length} ${placed.indices.length === 1 ? 'prop' : 'props'}` : ''}${placed?.skipped ? ` · ${placed.skipped} incompatible props skipped` : ''}`,
      placed?.skipped ? 'warn' : 'ok',
    );
  }

  return {
    copySelectedVertices,
    cutSelectedVertices,
    copySelectionVertexCount,
    canCopyVertices,
    pasteSelectedVertices,
    canPasteVertices,
    cancelPastePlacement,
    commitPastedVertices,
  };
}

export type MeshClipboardSession = ReturnType<typeof createMeshClipboardSession>;
