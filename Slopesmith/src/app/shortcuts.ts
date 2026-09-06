import { quadVerts } from '../core/doc/doc-edit';
import type { Store } from './state/store';
import { quadIndices, vertexNames } from './state/mesh-names';
import type { EditSession } from './edit/session';
import type { PropOps } from './props/operations';
import type { TrickTools } from './tricks/operations';
import type { Viewport } from './viewport/viewport';
import type { BrushOp } from '../core/doc/mountain';
import { modeForShortcut } from './mode-shortcuts';
import type { Mode } from './viewport/types';
import type { EffectsEditor } from './effects/editor';

/**
 * The editor's global keyboard shortcuts: one window keydown listener routing undo / redo, the Edit-mode mesh
 * operations (hide, connected-select, copy / cut / paste, bridge, weld, extrude, rip, split selected patches,
 * show control cage, crease / smooth, dissolve, flip ridable side, the modal-tool Enters), 1–6 top-level view switching, the
 * W / E / R gizmo tool picks, F to frame, Paint's ← / → tile turn, Delete across every mode's selection, and the layered Escape
 * (first put the held tool down, then clear the selection). Installed once
 * at compose time, after every service it routes to exists — so every dependency arrives direct. A live test
 * ride owns movement / ollie / respawn / Esc-to-exit (or release first-person / RMB capture); this layer retains P so it can pause and refresh the UI.
 *
 * T and / open the chat box (docs/038), and the rule that makes chat safe at all is enforced here: while the
 * box holds focus, **nothing** below reaches the editor. Everything in this file is bound as a bare single
 * key, so a sentence typed into a box that did not take the keyboard would be a burst of mode switches — and
 * the `typing` guard further down is not enough on its own, because Ctrl+Z and the ride's P sit above it.
 * `chatFocused` is therefore the very first thing this listener asks, before any other branch.
 */

export type ShortcutDeps = {
  store: Store;
  viewport: Viewport;
  edit: EditSession;
  trickTools: TrickTools;
  propOps: PropOps;
  sculptBrush: { op: BrushOp; radius: number };
  // history
  undo: () => void;
  redo: () => void;
  setMode: (mode: Mode) => void;
  // panel + scene refreshes
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  scheduleRebuild: () => void;
  refreshSelection: () => void;
  deleteKnot: () => void;
  // host glue that stays with the compose root (cage / focus / the paint-selection helpers)
  cageActive: () => boolean;
  focusActive: () => void;
  clearPaintSel: () => void;
  deleteSelectedLight: () => void;
  deleteSelectedScreen: () => void;
  deleteSelectedPaintTile: () => void;
  /** Paint's ← / → : turn the live texture a quarter (−1 = CW on screen), or mirror it with `flip`. False
   *  when nothing was armed or selected to turn, so the arrow key stays unhandled. */
  turnPaintTexture: (dir: 1 | -1, flip: boolean) => boolean;
  /** The same turn inside a tiled prop's Edit session, over the ONE tile the prop wears. False when the
   *  prop is untextured clay. */
  turnModelTexture: (dir: 1 | -1, flip: boolean) => boolean;
  disarmBrush: () => void;
  stopWatch: () => void;
  cancelStartPlacement: () => void;
  exitModelEdit: () => void;
  sceneBack: () => boolean;
  effects: EffectsEditor;
  // chat (docs/038): whether the box is holding the keyboard, and the two ways of asking for it
  chatFocused: () => boolean;
  openChat: (prefill?: string) => void;
};

/** Install the window keydown listener. */
export function installShortcuts(deps: ShortcutDeps) {
  const {
    store, viewport, edit, trickTools, propOps, sculptBrush,
    undo, redo, setMode, rebuildTools, updateCmdSheet, scheduleRebuild, refreshSelection, deleteKnot,
    cageActive, focusActive, clearPaintSel, deleteSelectedLight, deleteSelectedScreen, deleteSelectedPaintTile, turnPaintTexture,
    turnModelTexture, disarmBrush, stopWatch,
    cancelStartPlacement, exitModelEdit, sceneBack, effects, chatFocused, openChat,
  } = deps;
  const {
    transformSelectionActive, rotatableSelection, setGizmoMode, activeEditFamily, mixedEditSelection,
    clearCellSel, clearEdgeSel, deselectEdit, refreshHandles,
    hideSelectedMesh, showAllHidden, canHideSelection, toggleSelectedControlCages, canEditCurvature,
    selectConnected, canSelectConnected,
    startBridge, addBridgeRail, cancelBridge, completeBridge,
    finishCreateEdge, clearCreateEdge, finishCreateTube, cancelCreateTube,
    finishCreateTrail, cancelCreateTrail, undoCreateTrailPoint,
    beginEdgeExtrusion, flipEdgeExtrusionSide, commitEdgeExtrusion, ripEdges,
    creaseVertices, smoothVertices,
    beginPointWeld, cancelPointWeld, commitPointWeld, beginEdgeWeld, cancelEdgeWeld, commitEdgeWeld,
    copySelectedVertices, cutSelectedVertices, canCopyVertices,
    pasteSelectedVertices, canPasteVertices, cancelPastePlacement,
    deleteSelectedMesh, dissolveSelectedMesh, canDissolveSelectedMesh,
    flipSelectedMesh, canFlipSelectedMesh,
    insertCellEdge,
  } = edit;

  window.addEventListener('keydown', e => {
    // The chat box holds the keyboard, so the editor gets nothing at all — not a mode digit, not Ctrl+Z, not
    // the ride's P. This is first for that reason: every other guard below it is about *which* shortcut, and
    // this one is about whether the keys are the editor's at all (docs/038).
    if (chatFocused()) return;
    const typing = !!(e.target as HTMLElement)?.matches?.('input, textarea, select');
    if (viewport.riding) {
      // The ride input owns movement and Esc; pause lives here so a keyboard toggle can also refresh the
      // Play panel's Pause / Resume button without coupling the ride session back to editor UI code.
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p' && !e.repeat) {
        e.preventDefault();
        viewport.toggleRidePause();
        rebuildTools();
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (typing) return; // let knot/param text fields handle their own keys
    // The room (docs/038): T opens the box, / opens it on a command. From here the box holds the keyboard and
    // the guard at the top of this listener is what keeps the sentence out of the editor.
    if (!mod && !e.altKey && (key === 't' || e.key === '/')) {
      e.preventDefault();
      openChat(e.key === '/' ? '/' : '');
      return;
    }
    const shortcutMode = !mod && !e.altKey ? modeForShortcut(e.key) : null;
    if (shortcutMode) {
      e.preventDefault();
      if (shortcutMode !== store.currentMode) setMode(shortcutMode);
      return;
    }
    if (!mod && !e.altKey && store.currentMode === 'sculpt') {
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        sculptBrush.radius = Math.min(250, Math.max(10, sculptBrush.radius + (e.key === '[' ? -5 : 5)));
        viewport.brushRadius = sculptBrush.radius;
        rebuildTools();
        return;
      }
    }
    // ← / → turn the live texture a quarter (→ = CW on screen), ⇧ mirrors it. One gesture for every place a
    // tile's D4 is authored — the held brush, a focused Palette cell, the selected placed cell(s), and the
    // ONE tile a tiled prop wears while its Edit session is open — replacing the wheel-over-the-ghost and
    // right-click-the-tile pair that each covered only one of them. The arrows are otherwise unbound in Edit,
    // and a prop with no tile declines, leaving the key to the browser.
    if (!mod && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      && (store.currentMode === 'paint' || (store.currentMode === 'edit' && store.modelEditId))) {
      const dir = e.key === 'ArrowLeft' ? 1 : -1;
      const turned = store.currentMode === 'paint'
        ? turnPaintTexture(dir, e.shiftKey)
        : turnModelTexture(dir, e.shiftKey);
      if (turned) e.preventDefault();
      return;
    }
    if (!mod && e.altKey && key === 'h' && store.currentMode === 'edit') {
      e.preventDefault(); showAllHidden(); return;
    }
    if (!mod && !e.altKey && key === 'h' && canHideSelection()) {
      e.preventDefault(); hideSelectedMesh(); return;
    }
    const referenceCageSelection = !!store.refEdgeSel?.length || !!store.refCellSel?.length;
    if (!mod && !e.altKey && key === 'g' && store.currentMode === 'edit' && cageActive()
      && (referenceCageSelection || canEditCurvature())
      && store.bridgeRails === null && !store.surgeryTool && !store.weldTool && !store.createEdgeTool
      && !viewport.pastePlacing && !viewport.edgeExtrusionStaged && !mixedEditSelection()
      && (referenceCageSelection || store.edgeSel.length > 0 || store.cellSel.length > 0)) {
      e.preventDefault(); toggleSelectedControlCages(); return;
    }
    if (mod && !e.altKey && key === 'a' && canSelectConnected()) {
      e.preventDefault(); selectConnected(); return;
    }
    if (mod && e.key.toLowerCase() === 'c' && !mixedEditSelection() && canCopyVertices()) { e.preventDefault(); copySelectedVertices(); return; }
    if (mod && e.key.toLowerCase() === 'x' && !mixedEditSelection() && canCopyVertices()) { e.preventDefault(); cutSelectedVertices(); return; }
    if (mod && e.key.toLowerCase() === 'v' && canPasteVertices()) { e.preventDefault(); pasteSelectedVertices(); return; }
    if (store.currentMode === 'edit' && store.bridgeRails !== null) {
      if (!mod && !e.altKey && key === 'a') { e.preventDefault(); addBridgeRail(); return; }
      if (e.key === 'Enter') { e.preventDefault(); completeBridge(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearEdgeSel(); rebuildTools(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelBridge(); return; }
    }
    if (e.key === 'Enter' && store.railDrawing) { e.preventDefault(); trickTools.finishRail(); return; } // Enter finishes the rail being laid
    if (e.key === 'Enter' && viewport.edgeExtrusionStaged) { e.preventDefault(); commitEdgeExtrusion(); return; }
    if (!mod && !e.altKey && key === 'f' && viewport.edgeExtrusionStaged && viewport.edgeExtrusionSideFlippable) {
      e.preventDefault(); flipEdgeExtrusionSide(); return;
    }
    if (e.key === 'Enter' && store.weldTool === 'weld') { e.preventDefault(); commitPointWeld(); return; }
    if (e.key === 'Enter' && store.weldTool === 'edge-weld') { e.preventDefault(); commitEdgeWeld(); return; }
    if (e.key === 'Enter' && store.createEdgeTool) { e.preventDefault(); finishCreateEdge(); return; }
    if (e.key === 'Enter' && store.surgeryTool === 'tube') { e.preventDefault(); finishCreateTube(); return; }
    if (e.key === 'Enter' && store.surgeryTool === 'trail') { e.preventDefault(); finishCreateTrail(); return; }
    if (e.key === 'Enter' && store.surgeryTool === 'patch') { e.preventDefault(); edit.finishCreatePatch(true); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && store.surgeryTool === 'trail') {
      e.preventDefault(); undoCreateTrailPoint(); return;
    }
    const creationShortcutAvailable = !mod && !e.altKey && store.currentMode === 'edit'
      && store.bridgeRails === null && !store.surgeryTool && !store.weldTool && !store.createEdgeTool
      && !viewport.pastePlacing && !viewport.edgeExtrusionStaged && !transformSelectionActive()
      && !mixedEditSelection()
      && viewport.referenceControlPointSelectionCount() === 0 && !viewport.refMeasure();
    if (creationShortcutAvailable && key === 'l') { e.preventDefault(); edit.armCreateEdge(); return; }
    if (creationShortcutAvailable && key === 'p') { e.preventDefault(); edit.armCreatePatch(); return; }
    if (!mod && !e.altKey && key === 'm' && store.currentMode === 'edit' && cageActive()
      && store.bridgeRails === null && !store.surgeryTool && !store.weldTool && !store.createEdgeTool
      && !mixedEditSelection()) {
      const points = store.controlSel.length
        ? store.controlSel.flatMap(id => id.kind === 'vertex' ? [id.vertex] : [])
        : store.regionSel.length ? store.regionSel
        : store.selectedCorner !== null ? [store.selectedCorner] : [];
      if (points.length) { e.preventDefault(); beginPointWeld(); return; }
      if (store.edgeSel.length) { e.preventDefault(); beginEdgeWeld(); return; }
    }
    if (!mod && !e.altKey && store.currentMode === 'edit' && cageActive() && store.bridgeRails === null
      && !store.surgeryTool && !store.weldTool && !store.createEdgeTool && !mixedEditSelection()
      && (store.edgeSel.length || store.cellSel.length)) {
      if (key === 'x') { e.preventDefault(); beginEdgeExtrusion(); return; }
      if (store.edgeSel.length && key === 'k') { e.preventDefault(); ripEdges(); return; }
      if (store.edgeSel.length && key === 'b') { e.preventDefault(); startBridge(); return; }
    }
    if (!mod && !e.altKey && store.currentMode === 'edit' && cageActive() && canEditCurvature() && store.bridgeRails === null
      && !store.surgeryTool && !store.weldTool && !store.createEdgeTool && !mixedEditSelection()
      && (key === 'c' || key === 's')) {
      const vertices = store.controlSel.length
        ? store.controlSel.flatMap(id => id.kind === 'vertex' ? [id.vertex] : [])
        : store.regionSel.length ? store.regionSel
        : store.selectedCorner !== null ? [store.selectedCorner]
        : store.edgeSel.length ? store.edgeSel.flatMap(([a, b]) => [a, b])
        : vertexNames(store.mdoc, quadIndices(store.mdoc, store.cellSel).flatMap(quad => quadVerts(store.mdoc, quad)));
      const unique = [...new Set(vertices)];
      if (unique.length) {
        e.preventDefault();
        if (key === 'c') creaseVertices(unique); else smoothVertices(unique);
        return;
      }
    }
    if (!mod && !e.altKey && key === 'd' && store.currentMode === 'edit' && cageActive()
      && store.bridgeRails === null && !store.surgeryTool && !store.weldTool && !store.createEdgeTool
      && canDissolveSelectedMesh()) {
      e.preventDefault(); dissolveSelectedMesh(); return;
    }
    if (!mod && !e.altKey && key === 'i' && store.currentMode === 'edit' && cageActive()
      && store.bridgeRails === null && !store.surgeryTool && !store.weldTool && !store.createEdgeTool
      && store.cellSel.length && !mixedEditSelection()) {
      e.preventDefault(); insertCellEdge(); return;
    }
    if (!mod && !e.altKey && key === 'n' && store.bridgeRails === null
      && !store.surgeryTool && !store.weldTool && !store.createEdgeTool && canFlipSelectedMesh()) {
      e.preventDefault(); flipSelectedMesh(); return;
    }
    if (!mod && (key === 'w' || key === 'e' || key === 'r') && transformSelectionActive()) {
      if (key === 'r' && mixedEditSelection()) return; // mixed families share Move + Rotate; Scale has no cross-type contract
      if (key !== 'w' && !rotatableSelection()) return; // a point has no visible rotation or scale around itself
      e.preventDefault();
      setGizmoMode(key === 'e' ? 'rotate' : key === 'r' ? 'scale' : 'move', true);
      return;
    }
    if (e.key.toLowerCase() === 'f') focusActive(); // frame the course / mountain (Unity-style)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (store.currentMode === 'effects') { if (effects.deleteSelection()) e.preventDefault(); }
      else if (store.currentMode === 'props' && store.multiSel.length) propOps.deleteMultiSelProps();
      else if (store.currentMode === 'props' && (store.railDrawing || store.selectedRail !== null)) { if (store.selectedNode !== null) trickTools.deleteSelectedRailNode(); else trickTools.deleteSelectedRail(); }
      else if (store.currentMode === 'props' && store.selectedGem !== null) trickTools.deleteSelectedGem();
      else if (store.currentMode === 'props' && store.selectedScreen !== null) deleteSelectedScreen();
      else if (store.currentMode === 'props' && store.selectedLight !== null) deleteSelectedLight();
      else if (store.currentMode === 'props' && store.selectedProp !== null) propOps.deleteSelectedProp();
      else if (store.currentMode === 'props' && store.selectedRefProp) { /* the reference is read-only */ }
      else if (store.currentMode === 'edit' && (store.selectedCorner !== null || store.regionSel.length || store.edgeSel.length || store.cellSel.length)) { e.preventDefault(); deleteSelectedMesh(); }
      else if (store.currentMode === 'paint' && store.selectedPaintCell !== null) deleteSelectedPaintTile();
      else if (store.currentMode === 'paint' && store.selectedRefPatch !== null) { /* the reference is read-only */ }
      else deleteKnot();
    }
    if (e.key === 'Escape') {
      if (store.currentMode === 'effects' && effects.clearSelection()) { e.preventDefault(); return; }
      if (store.currentMode === 'info' && sceneBack()) { e.preventDefault(); return; }
      if (store.placingStart) { cancelStartPlacement(); return; } // the armed one-shot: Esc puts it down, like any other placement
      if (viewport.watching) { stopWatch(); return; } // spectating the AI field: Esc puts it away, as it stops a ride
      // A headset session: the same key that stops a ride ends it, from the desk. Ahead of the ride's own Esc
      // because in VR a board is something you are riding INSIDE the session, and Esc ends the outer thing.
      if (viewport.xrPlaying) { viewport.stopXrPlay(); return; }
      if (store.railDrawing) { trickTools.finishRail(); return; } // Esc finishes the rail (as the placement toast says)
      if (store.createEdgeTool) { finishCreateEdge(); return; }
      if (store.currentMode === 'edit' && store.surgeryTool === 'tube') { cancelCreateTube(); return; }
      if (store.currentMode === 'edit' && store.surgeryTool === 'trail') { cancelCreateTrail(); return; }
      if (store.currentMode === 'edit' && store.surgeryTool === 'patch') { edit.finishCreatePatch(false); return; }
      // first Esc cancels placement mode (puts the held prop / brush / surgery / weld tool down); the next clears the selection
      if (store.currentMode === 'edit' && viewport.pastePlacing) { cancelPastePlacement(); return; }
      if (store.currentMode === 'edit' && store.surgeryTool) { store.surgeryTool = null; viewport.setSurgeryTool(null); rebuildTools(); updateCmdSheet(); return; }
      if (store.currentMode === 'edit' && store.weldTool === 'weld') { cancelPointWeld(); return; }
      if (store.currentMode === 'edit' && store.weldTool === 'edge-weld') { cancelEdgeWeld(); return; }
      if (store.currentMode === 'edit') {
        // Layered Esc in a model edit session: a live selection clears first; then a locked session gives
        // up its lock; an unlocked one ends — the keyboard mirror of the click-on / click-off flow.
        const selectionLive = activeEditFamily() !== null || store.selected !== null
          || !!store.selectedEdgeCrossing || !!store.selectedCoincidentVertices
          || store.selectedProp !== null || store.multiSel.length > 0
          || store.refControlSel.length > 0 || store.refEdgeSel.length > 0 || store.refCellSel.length > 0;
        if (store.modelEditId && !selectionLive) {
          if (store.modelEditLocked) { store.modelEditLocked = false; rebuildTools(); updateCmdSheet(); return; }
          exitModelEdit(); return;
        }
        deselectEdit(); return;
      }
      if (store.currentMode === 'props' && store.armedProp) { propOps.disarmProp(); return; }
      if (store.currentMode === 'paint' && store.paintBrush) { disarmBrush(); return; }
      if (store.currentMode === 'props' && (store.selectedProp !== null || store.multiSel.length > 0
        || store.selectedRefProp !== null || store.selectedLight !== null || store.selectedRefLight !== null
        || store.selectedScreen !== null || store.selectedRefScreen !== null)) {
        propOps.deselectPropOrLight(); return;
      }
      store.selected = null;
      store.selectedKnots = [];
      store.selectedCorner = null;
      store.anchorCorner = null;
      store.selectedProp = null;
      store.multiSel = [];
      store.selectedLight = null;
      store.selectedRefLight = null;
      store.selectedScreen = null;
      store.selectedRefScreen = null;
      store.selectedRail = null;
      store.selectedNode = null;
      store.selectedGem = null;
      store.gemArmed = false; viewport.setGemArmed(false); store.trickTool = null; // drop the trick tools
      clearCreateEdge();
      viewport.setLightArmed(false); // cancel a held light too
      clearPaintSel(); // drop any selected painted cell / reference patch
      viewport.clearRefPropSelection(); // …and any read-only reference-prop selection (its callback clears our state)
      viewport.clearScreenSelection();
      store.regionSel = [];
      store.controlSel = [];
      clearCellSel();
      clearEdgeSel();
      viewport.clearCornerSelection();
      refreshHandles();
      refreshSelection();
      if (store.currentMode === 'props') rebuildTools(); // Edit returned through deselectEdit above
      scheduleRebuild(); // setPlacedProps(..., null) drops any placed-prop selection in the viewport
    }
  });
}
