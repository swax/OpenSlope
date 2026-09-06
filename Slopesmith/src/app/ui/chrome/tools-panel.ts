import { editMesh } from '../../edit/mesh-target';
import { AUTHORED_MODEL_LEVEL, modelIdFromNumber } from '../../../core/doc/models';
import GUI from 'lil-gui';
import { segmented, toggleBar, label } from '../components/controls';
import type { GizmoFrame } from '../../viewport/types';
import type { Mode } from '../../viewport/types';
import { MultiSelectList } from '../../props/multi-select-list';
import { BridgeRailList } from '../components/bridge-rail-list';
import { clearGui, detail, tip } from '../components/gui';
import { createCommandSheet } from './command-sheet';
import { createEditSections, type ToolsContext } from '../tool-panels/widgets';
import type { ToolsPanelDeps } from '../tool-panels/tools-panel-deps';
import { buildSculptTools } from '../tool-panels/sculpt';
import { buildPlayTools } from '../tool-panels/play';
import { createPropTools } from '../tool-panels/props';
import { buildTrickTools } from '../tool-panels/tricks';
import { createCreateTools } from '../tool-panels/create';
import { createMeshSelectTools } from '../tool-panels/mesh-selection';
import { createRetopologyTools } from '../tool-panels/retopology';
import { createLabelTools } from '../tool-panels/labels';
import { MODE_ICON } from '../components/icons';
import {
  buildBridgeTools, buildEdgeWeldTools, buildExtrudePlacementTools,
  buildPastePlacementTools, buildPointWeldTools,
} from '../tool-panels/staged';

/**
 * The right-dock Tools panel + the mode UI it drives: the per-mode toolbox content (rebuildTools swaps in the
 * sculpt brush / edit corner tools / props · lights · rails · gems / play controls; Info mode shows the Scene
 * block instead, and Users mode the server's roster), the held/selected prop preview card, the bottom-dock library visibility + viewport arming
 * (updatePaintUi), and the bottom help overlays (updateCmdSheet). It reads editor state from the shared
 * `store` and calls out to the host for the actual edit / play / delete ops + the shared widgets, so it stays
 * a view over the state, not the owner of the operations. This module is the coordinator: it owns the lil-gui
 * host, its persistent children (the Palette / preview cards / gizmo pills), and the rebuild dispatch; the
 * per-mode toolbox content lives in the ui/tool-panels/ builders, each handed the shared ToolsContext.
 */

/** Panel header per mode, matching the top-bar segment labels. The 'info' mode (shown as Scene) hides this
 *  panel in favour of the Scene block, whose own header carries the same title. */
const MODE_TITLE: Record<Mode, string> = {
  info: 'Scene Mode', edit: 'Edit Mode', sculpt: 'Sculpt Mode', paint: 'Paint Mode',
  props: 'Props Mode', effects: 'Effects Mode', play: 'Test Mode',
};

/** lil-gui owns the collapsible root title, but its text can still carry the same mode glyph as the top bar. */
function setModeTitle(gui: GUI, mode: Mode, title: string): void {
  gui.title(title);
  gui.$title.classList.add('sp-mode-title');
  const icon = document.createElement('span');
  icon.className = 'sp-mode-title-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = MODE_ICON[mode];
  const label = document.createElement('span');
  label.textContent = title;
  gui.$title.replaceChildren(icon, label);
}

export type { ToolsPanelDeps } from '../tool-panels/tools-panel-deps';
export function createToolsPanel(deps: ToolsPanelDeps) {
  const {
    store, viewport, edit, palette, propPreview, propLib, library, propLibToggle,
    showScene, refreshShowFilters, syncAddTrickBtns, persistUi, cageActive,
    clearPaintSel, syncPropLibBtn, syncDockTabs, propBaseOffset, identifyMultiProp, removeFromMultiSel,
  } = deps;
  const pastePlacing = () => viewport.pastePlacing;

  const rightGui = new GUI({ autoPlace: false, title: 'Tools' });
  document.getElementById('dock-right')!.appendChild(rightGui.domElement);
  const editSection = createEditSections(rightGui);
  // The Palette lives INSIDE the collapsible Tools panel — in Paint mode it (with its preview of the
  // current tile) is the panel's whole content. clearGui only destroys controllers/folders, so this
  // appended element survives every rebuildTools; it's hidden by palette.setVisible outside Paint mode.
  rightGui.$children.appendChild(palette.el);
  // The prop preview card lives in the Tools panel too (survives clearGui like the Palette); shown only in
  // Props mode, at the top of the prop tools. Prepend so it sits above the yaw/size controls buildPropTools adds.
  rightGui.$children.prepend(propPreview.el);
  // The multi-selection list rides just under the preview card (props mode, after a box-select drag): click a
  // row to identify its prop in 3D, double-click to frame it, ✕ to drop it from the set. Persistent like the card.
  const multiList = new MultiSelectList({
    onIdentify: identifyMultiProp,
    onFocus: index => { viewport.focusProp(index); },
    onRemove: removeFromMultiSel,
  });
  propPreview.el.after(multiList.el);
  const bridgeList = new BridgeRailList({ onReverse: edit.reverseBridgeRail, onRemove: edit.removeBridgeRail, onMove: edit.moveBridgeRail });
  multiList.el.after(bridgeList.el);
  // The Prop Library show/hide toggle sits above the preview card — the very top of the Prop Tools.
  rightGui.$children.prepend(propLibToggle);
  // Effects is a custom dense graph/inspector view rather than a stack of lil-gui scalar controllers. It is
  // persistent across clearGui just like the libraries/cards, and owns its own redraw when selected.
  rightGui.$children.appendChild(deps.effects.el);
  // The World / Local / Surface gizmo pill (docs/006) sits at the top of the Edit tools. Local re-frames the
  // corner gizmo to the slope but moves freely; Surface adds the exact surface slide; World uses world axes.
  // Hold Shift while dragging for a one-off World move. Persistent like the cards; Edit + cage only.
  const framePill = segmented<GizmoFrame>(
    [
      { value: 'world', label: 'World', title: 'Use world X / Y / Z for the transform.' },
      { value: 'local', label: 'Local', title: 'Align the axes to the slope, but move freely without sliding along it.' },
      { value: 'surface', label: 'Surface', title: 'Align the axes to the slope; Move glides along it. Shift-drag for a one-off free move.' },
    ],
    () => store.gizmoFrame,
    v => { store.gizmoFrame = v; viewport.setGizmoFrame(v); persistUi(); },
  );
  const framePillRow = document.createElement('div');
  framePillRow.className = 'sp-frame-pill';
  const framePillLabel = label('Move in');
  framePillRow.append(framePillLabel, framePill.el);
  rightGui.$children.prepend(framePillRow);
  viewport.setGizmoFrame(store.gizmoFrame); // sync the viewport to the restored pill

  // Transform tool for selections with an actual orientation / footprint. Point-only selections deliberately
  // remain Move: rotating or scaling one point around itself has no visible meaning.
  const transformPill = segmented<'move' | 'rotate' | 'scale'>(
    [
      { value: 'move', label: 'Move', title: 'Move the selected item or group (W).' },
      { value: 'rotate', label: 'Rotate', title: 'Rotate around the selected item’s origin or the group centroid (E).' },
      { value: 'scale', label: 'Scale', title: 'Scale around the selected item’s origin or the group centroid (R).' },
    ],
    () => viewport.edgeExtrusionFanMode ? null : store.gizmoMode,
    v => {
      store.gizmoMode = v;
      viewport.setGizmoMode(v);
      framePillLabel.textContent = v === 'rotate' ? 'Rotate in' : v === 'scale' ? 'Scale in' : 'Move in';
      updateCmdSheet();
      if (viewport.edgeExtrusionStaged) rebuildTools();
    },
  );
  const transformPillRow = document.createElement('div');
  transformPillRow.className = 'sp-frame-pill';
  transformPillRow.append(label('Transform'), transformPill.el);
  rightGui.$children.prepend(transformPillRow); // above the coordinate frame and the selected-item details
  // The two persistent gizmo rows are one conceptual control. Wrap them in the same visual language as the
  // lil-gui task folders instead of leaving two unlabelled strips floating above Selection.
  const transformSection = document.createElement('section');
  transformSection.className = 'sp-tool-section sp-transform-section';
  const transformSectionTitle = document.createElement('div');
  transformSectionTitle.className = 'sp-tool-section-title';
  transformSectionTitle.textContent = 'Transform';
  transformSection.append(transformSectionTitle, transformPillRow, framePillRow);
  rightGui.$children.prepend(transformSection);
  viewport.setGizmoMode(store.gizmoMode);

  const hasMeshTransformSelection = () => store.selectedCorner !== null || store.controlSel.length > 0 || store.regionSel.length > 0
    || (store.bridgeRails === null && (store.edgeSel.length > 0 || store.cellSel.length > 0));
  const movableControlPointCount = () => {
    return store.controlSel.length;
  };
  const canRotateSelection = () => store.currentMode === 'props'
    ? store.selectedProp !== null || store.multiSel.length > 0
    : viewport.edgeExtrusionStaged || store.currentMode === 'edit' && !mixedEditSelection()
      && store.bridgeRails === null && cageActive() && (store.controlSel.length
      ? movableControlPointCount() > 1
      : store.edgeSel.length > 0 || store.cellSel.length > 0);
  type EditSelectionKind = 'point' | 'edge' | 'patch' | 'prop';
  const editSelectionCounts = (): { kind: EditSelectionKind; count: number; readOnly: boolean }[] => {
    const authoredPoints = store.controlSel.length || store.regionSel.length || (store.selectedCorner !== null ? 1 : 0);
    return [
      { kind: 'point', count: authoredPoints + store.refControlSel.length, readOnly: !authoredPoints && store.refControlSel.length > 0 },
      { kind: 'edge', count: store.edgeSel.length + store.refEdgeSel.length, readOnly: !store.edgeSel.length && store.refEdgeSel.length > 0 },
      { kind: 'patch', count: store.cellSel.length + store.refCellSel.length, readOnly: !store.cellSel.length && store.refCellSel.length > 0 },
      { kind: 'prop', count: store.multiSel.length || (store.selectedProp !== null ? 1 : 0), readOnly: false },
    ];
  };
  const mixedEditSelection = () => editSelectionCounts().filter(selection => selection.count > 0).length > 1;
  const editSelection = (): { kind: 'control points' | 'edges' | 'patches' | 'mixed selection'; readOnly: boolean } | null => {
    const counts = editSelectionCounts().filter(selection => selection.count > 0);
    if (counts.length > 1) return { kind: 'mixed selection', readOnly: counts.every(selection => selection.readOnly) };
    if (store.edgeSel.length) return { kind: 'edges', readOnly: false };
    if (store.cellSel.length) return { kind: 'patches', readOnly: false };
    if (store.selectedCorner !== null || store.regionSel.length || store.controlSel.length)
      return { kind: 'control points', readOnly: false };
    if (viewport.referenceControlPointSelectionCount()) return { kind: 'control points', readOnly: true };
    const reference = viewport.refMeasure();
    return reference ? { kind: reference.kind === 'edge' ? 'edges' : 'patches', readOnly: true } : null;
  };
  const updateCmdSheet = createCommandSheet({
    store,
    cageActive,
    pastePlacing,
    canRotateSelection,
    editSelection,
    selectedControlCagesVisible: edit.selectedControlCagesVisible,
    canEditCurvature: edit.canEditCurvature,
    edgeExtrusionStaged: () => viewport.edgeExtrusionStaged,
    edgeExtrusionFanMode: () => viewport.edgeExtrusionFanMode,
    edgeExtrusionSideFlippable: () => viewport.edgeExtrusionSideFlippable,
    paletteSurfaceView: () => palette.surfaceView,
    desktopRiding: () => viewport.riding && !viewport.xrPlaying,
    rideWalking: () => viewport.rideWalking,
    rideFirstPerson: () => viewport.rideFirstPerson,
  });

  // Ordinary Edit-pick filter: independent toggles because focused work often wants combinations (edges +
  // patches), but never an empty set. It appears only in the default, empty-selection Edit toolbox.
  const editPickBar = toggleBar<'point' | 'edge' | 'patch' | 'prop'>(
    [
      { value: 'point', label: 'Point', title: 'Allow ordinary clicks and box selection to select control points.' },
      { value: 'edge', label: 'Edge', title: 'Allow clicks, double-clicks, and box selection to select edges and edge loops.' },
      { value: 'patch', label: 'Patch', title: 'Allow clicks, double-clicks, and box selection to select patches and patch loops.' },
      { value: 'prop', label: 'Prop', title: 'Allow clicks and box selection to select placed props. Off, clicks pass through to the mesh beneath.' },
    ],
    kind => store.editPickKinds[kind],
    kind => {
      const enabledCount = Object.values(store.editPickKinds).filter(Boolean).length;
      if (store.editPickKinds[kind] && enabledCount === 1) return;
      store.editPickKinds[kind] = !store.editPickKinds[kind];
      updateCmdSheet();
    },
  );
  const editPickRow = document.createElement('div');
  editPickRow.className = 'sp-frame-pill sp-edit-pick-filter';
  editPickRow.append(editPickBar.el);
  const editPickSection = document.createElement('section');
  editPickSection.className = 'sp-tool-section sp-edit-pick-section';
  const editPickTitle = document.createElement('div');
  editPickTitle.className = 'sp-tool-section-title';
  editPickTitle.textContent = 'Select';
  editPickSection.append(editPickTitle, editPickRow);
  rightGui.$children.prepend(editPickSection);

  // The shared context every mode builder works in: the panel's deps plus the coordinator-owned host,
  // section factory, rebuild lifecycle, and persistent list widgets (ui/tool-panels/widgets.ts).
  const ctx: ToolsContext = { ...deps, gui: rightGui, editSection, rebuildTools, updateCmdSheet, multiList, bridgeList };
  const createTools = createCreateTools(ctx);
  const retopologyTools = createRetopologyTools(ctx);
  const labelTools = createLabelTools(ctx);
  const meshSelect = createMeshSelectTools(ctx, retopologyTools.openSelected, labelTools.buildAssignment);
  const propTools = createPropTools(ctx);

  /** The library/special-add stack is the empty-selection state, not a header over selected-item details. */
  function propLaunchersVisible(): boolean {
    return store.currentMode === 'props'
      && store.selectedProp === null && store.selectedRefProp === null && store.multiSel.length === 0
      && store.selectedLight === null && store.selectedRefLight === null
      && store.selectedRail === null && store.selectedGem === null
      && store.selectedScreen === null && store.selectedRefScreen === null
      // A HELD tool has replaced the launcher with its own panel, and its cancel is the way back — leaving the
      // Prop Library toggle above it would offer a second exit that puts nothing down.
      && !store.railDrawing && !store.gemArmed && !viewport.lightPlacing;
  }

  function buildMixedEditSelectionTools() {
    const selected = editSelectionCounts().filter(selection => selection.count > 0);
    const total = selected.reduce((sum, selection) => sum + selection.count, 0);
    const section = editSection('mixed-selection', 'Selection');
    detail(section, `${total} items selected`);
    if (selected.some(selection => !selection.readOnly)) {
      detail(section, 'use the shared gizmo to move or rotate everything together');
      const gizmoType = segmented<'move' | 'rotate'>(
        [
          { value: 'move', label: 'Move', title: 'Move every selected type together around the shared centroid (W).' },
          { value: 'rotate', label: 'Rotate', title: 'Rotate every selected type together around the shared centroid (E).' },
        ],
        () => store.gizmoMode === 'rotate' ? 'rotate' : 'move',
        value => { edit.setGizmoMode(value); updateCmdSheet(); },
      );
      gizmoType.setEnabled('rotate', edit.rotatableSelection());
      const gizmoTypeRow = document.createElement('div');
      gizmoTypeRow.className = 'sp-frame-pill';
      gizmoTypeRow.append(label('Gizmo'), gizmoType.el);
      section.$children.appendChild(gizmoTypeRow);
    }
    detail(section, 'choose a type to narrow the selection and open its tools');
    const noun: Record<EditSelectionKind, [string, string]> = {
      point: ['point', 'points'], edge: ['edge', 'edges'], patch: ['patch', 'patches'], prop: ['prop', 'props'],
    };
    for (const item of selected) {
      const label = noun[item.kind][item.count === 1 ? 0 : 1];
      tip(section.add({ choose: () => edit.narrowEditSelection(item.kind) }, 'choose')
        .name(`${item.count} ${label}`), `Keep only the selected ${label} and open their type-specific toolbox.`);
    }
    tip(section.add({ deselect: edit.deselectEdit }, 'deselect').name('deselect all (Esc)'),
      'Clear every selected type and return to the general Edit toolbox.');
    labelTools.buildAssignment();
  }

  function rebuildTools() {
    createTools.reset();
    clearGui(rightGui);
    multiList.hide(); // only buildPropTools' multi branch shows the selection list
    bridgeList.hide();
    viewport.setLoftPreview(null); // clear any loft ghost; the Edit edge branch re-arms it when the dry-run holds
    refreshShowFilters(); // keep the top-bar Props / Tricks filters in sync
    syncAddTrickBtns(); // and the Prop Tools' Add rail / gem / light pressed highlight
    propLibToggle.style.display = propLaunchersVisible() ? 'block' : 'none';
    const canRotate = canRotateSelection();
    // Mixed selections own their compact Move / Rotate chooser inside the count panel, so they deliberately
    // hide the persistent single-family transform bar. Rotation is still a valid mode and must survive this
    // rebuild (notably the rebuild requested by the E shortcut).
    const mixedCanRotate = store.currentMode === 'edit' && mixedEditSelection() && edit.rotatableSelection();
    if (!canRotate && !mixedCanRotate && store.gizmoMode !== 'move') { store.gizmoMode = 'move'; viewport.setGizmoMode('move'); }
    transformPillRow.style.display = canRotate ? 'flex' : 'none';
    transformPill.refresh();
    framePillLabel.textContent = store.gizmoMode === 'rotate' ? 'Rotate in' : store.gizmoMode === 'scale' ? 'Scale in' : 'Move in';
    const frameVisible = store.currentMode === 'edit' && cageActive() && hasMeshTransformSelection()
      && !mixedEditSelection() && !viewport.edgeExtrusionStaged;
    framePillRow.style.display = frameVisible ? 'flex' : 'none';
    framePill.refresh();
    transformSection.style.display = canRotate || frameVisible ? '' : 'none';
    // Users mode owns the whole dock while it is on: it is about the server, so neither the Scene block nor
    // the current mode's toolbox belongs under it (docs/038).
    if (deps.usersActive()) {
      showScene(false);
      rightGui.domElement.style.display = 'none';
      return;
    }
    // Info mode's toolbox IS the Scene block (category launcher + paired Mountain / Reference detail); other modes show
    // their own Tools gui. One panel, swapped per mode.
    const info = store.currentMode === 'info';
    if (store.currentMode === 'effects') deps.effects.render();
    showScene(info); // the Scene block (owned by the scene panel) is the Info-mode toolbox
    rightGui.domElement.style.display = info ? 'none' : '';
    if (info) return;
    setModeTitle(rightGui, store.currentMode, store.currentMode === 'edit' && store.modelEditId
      ? `Edit Mode · ${deps.modelEdit.activeName() ?? 'model'}`
      : MODE_TITLE[store.currentMode]);
    rightGui.domElement.classList.toggle('sp-edit-tools', store.currentMode === 'edit');
    rightGui.domElement.classList.toggle('sp-effects-tools', store.currentMode === 'effects');
    editPickSection.style.display = 'none';
    editPickBar.refresh();
    if (store.currentMode === 'play') { buildPlayTools(ctx); return; }
    if (store.currentMode === 'sculpt') { buildSculptTools(ctx); return; }
    if (store.currentMode === 'paint') return; // the Palette (mounted in $children) is the Tools content while painting
    if (store.currentMode === 'effects') return;
    if (store.currentMode === 'props') {
      // Routed off what is actually in hand rather than off `trickTool`, which outlives the object it named —
      // deleting the last rail used to leave the panel in a Tricks branch with nothing to draw.
      if (store.railDrawing || store.selectedRail !== null || store.selectedGem !== null || store.gemArmed) buildTrickTools(ctx);
      else if (store.selectedLight !== null || store.selectedRefLight !== null) propTools.buildLightTools();
      else if (viewport.lightPlacing) propTools.buildLightPlacementTools(); // a held light presets before the click
      else propTools.buildPropTools();
      return;
    }
    if (viewport.edgeExtrusionStaged) { buildExtrudePlacementTools(ctx); return; }
    // A live selection OWNS the Edit toolbox: show its details/actions only, ending in Deselect. General creation
    // and surgery buttons appear only in the true empty-selection state below. Create Edge owns the panel while
    // drawing; once finished, its resulting selected edge chain gets the normal mesh-selection state.
    if (pastePlacing()) { buildPastePlacementTools(ctx); return; }
    if (store.bridgeRails !== null) { buildBridgeTools(ctx); return; }
    if (store.createEdgeTool) { createTools.buildCreateEdgeTools(); return; }
    if (store.surgeryTool === 'tube') { createTools.buildCreateTubeTools(); return; }
    if (store.surgeryTool === 'trail') { createTools.buildCreateTrailTools(); return; }
    if (store.surgeryTool === 'patch' || store.surgeryTool === 'loopcut') { createTools.buildCreateEdgeTools(); return; }
    if (store.weldTool === 'weld') { buildPointWeldTools(ctx); return; }
    if (store.weldTool === 'edge-weld') { buildEdgeWeldTools(ctx); return; }
    if (retopologyTools.isOpen()) { retopologyTools.build(); return; }

    const mdoc = editMesh(store);
    if (store.currentMode === 'edit' && mixedEditSelection()) { buildMixedEditSelectionTools(); return; }
    if ((store.selectedEdgeCrossing || store.selectedCoincidentVertices || cageActive()) && meshSelect.buildMeshSelectionTools(mdoc)) return;

    // Once a mixed marquee is narrowed to Props, reuse the ordinary multi-prop list / delete / deselect tools
    // without switching modes. The selection and transform handle stay exactly where the Edit drag left them.
    if (store.currentMode === 'edit' && store.multiSel.length > 0 && !store.modelEditId) {
      propTools.buildPropTools();
      labelTools.buildAssignment();
      return;
    }

    // A placed prop selected in Edit mode OWNS the toolbox, like any other Edit selection: the amber box
    // + move gizmo it has in Props mode, with its way into editing here — a MODEL placement opens its
    // edit session, a reference placement (read-only source geometry) offers the revised COPY (docs/028).
    if (store.currentMode === 'edit' && store.selectedProp !== null && !store.modelEditId) {
      const index = store.selectedProp;
      const pp = store.mdoc.props?.[index];
      if (!pp) store.selectedProp = null;
      else if (pp.level === AUTHORED_MODEL_LEVEL) {
        const g = editSection('prop-selected', `Tiled prop · ${pp.name || `#${pp.model}`}`);
        detail(g, 'drag the gizmo to move this placement');
        tip(g.add({ edit: () => deps.modelEdit.enter(modelIdFromNumber(pp.model), index) }, 'edit').name('✎ edit shape'),
          'Open this prop’s edit session; edits change every placement of it.');
        tip(g.add({ revise: () => deps.modelEdit.createRevision(index) }, 'revise').name('⧉ revise prop (v2)'),
          'Fork this prop as “<name> v2” and edit the copy; this placement swaps over.',
          'Other placements keep the original. Effects attached to this placement come with the copy.');
        tip(g.add({ deselect: edit.deselectEdit }, 'deselect').name('deselect (Esc)'),
          'Drop this placement selection — the same as clicking off it.');
        labelTools.buildAssignment();
        return;
      } else {
        const g = editSection('prop-selected', `Textured prop · ${pp.name || `#${pp.model}`}`);
        detail(g, 'drag the gizmo to move this placement');
        detail(g, 'reference props are read-only — revise one to get your own copy');
        if (pp.group) detail(g, 'group props can’t be revised yet');
        else tip(g.add({ revise: () => deps.modelEdit.createRevision(index) }, 'revise').name('⧉ revise prop (v2)'),
          'Copy this prop into your library as “<name> v2” and point this placement at it.',
          'The copy keeps its UV layout, materials, and look, so nothing moves and nothing greys out — '
          + 'effects attached to this placement come with it. Edit the copy in Blender (docs/046).');
        tip(g.add({ deselect: edit.deselectEdit }, 'deselect').name('deselect (Esc)'),
          'Drop this placement selection — the same as clicking off it.');
        labelTools.buildAssignment();
        return;
      }
    }

    // Nothing selected: this is the ONLY state that shows the non-specific Edit tools.
    editPickSection.style.display = '';
    createTools.buildCreateEdgeTools();
    if (!store.modelEditId) retopologyTools.buildLauncher();
    labelTools.buildBrowser();
    if (edit.canPasteVertices()) {
      const clipboard = editSection('clipboard', 'Clipboard', false);
      tip(clipboard.add({ paste: edit.pasteSelectedVertices }, 'paste').name('paste (Ctrl+V)'),
        'Preview the clipboard over your mountain, then click to place its points, free edges, and surfaces.');
    }
    if (edit.hiddenMeshCount() || edit.controlCageCount()) {
      const visibility = editSection('visibility', 'Visibility');
      if (edit.hiddenMeshCount()) {
        const parts = [
          store.hiddenVertices.length ? `${store.hiddenVertices.length} ${store.hiddenVertices.length === 1 ? 'point' : 'points'}` : '',
          store.hiddenEdges.length ? `${store.hiddenEdges.length} ${store.hiddenEdges.length === 1 ? 'edge' : 'edges'}` : '',
          store.hiddenQuads.length ? `${store.hiddenQuads.length} ${store.hiddenQuads.length === 1 ? 'patch' : 'patches'}` : '',
          store.refHiddenQuads.length ? `${store.refHiddenQuads.length} reference ${store.refHiddenQuads.length === 1 ? 'patch' : 'patches'}` : '',
        ].filter(Boolean).join(' · ');
        detail(visibility, parts, 'hidden');
        tip(visibility.add({ show: edit.showAllHidden }, 'show').name('show all hidden (Alt+H)'),
          'Reveal everything hidden with H. An editor-only filter — the mountain is unchanged.');
      }
      if (edit.controlCageCount()) {
        const parts = [
          store.controlCageEdges.length ? `${store.controlCageEdges.length} ${store.controlCageEdges.length === 1 ? 'edge' : 'edges'}` : '',
          store.controlCageQuads.length ? `${store.controlCageQuads.length} ${store.controlCageQuads.length === 1 ? 'patch' : 'patches'}` : '',
          store.refControlCageEdges.length ? `${store.refControlCageEdges.length} reference ${store.refControlCageEdges.length === 1 ? 'edge' : 'edges'}` : '',
          store.refControlCageQuads.length ? `${store.refControlCageQuads.length} reference ${store.refControlCageQuads.length === 1 ? 'patch' : 'patches'}` : '',
        ].filter(Boolean).join(' · ');
        detail(visibility, parts, 'control cages');
        tip(visibility.add({ hide: edit.hideSubCages }, 'hide').name('hide control cages'),
          'Hide every pinned edge and patch control cage; the coarse cage stays.');
      }
    }
    if (!cageActive()) return; // mesh surgery needs the control cage; Create Edge turns it on when armed

  }

  /** Show the bottom dock for the active mode: the Texture Library + Palette while painting, or the Prop
   *  Library while placing props (picking either jumps you straight into that mode). */
  function updatePaintUi() {
    const painting = store.currentMode === 'paint';
    const propping = store.currentMode === 'props';
    // A library shows only in its own mode, and only if its remembered open intent is set — so returning to Paint
    // / Props reopens the library if it was open before. The tool-box toggle + the panel's ✕ update that intent.
    // A texture pick outranks that rule: it is raised from Edit mode and owns the panel until it resolves.
    if (library.picking) { /* the pick holds the panel open, whatever mode we are in */ }
    else if (painting && store.libraryWanted) library.show();
    else library.hide();
    if (painting) palette.setLibraryOpen(store.libraryWanted);
    else clearPaintSel(); // leaving paint also drops the cell selection
    if (propping) { if (store.propLibWanted) propLib.show(); else propLib.hide(); } else propLib.hide(); // leaving props hides it
    syncPropLibBtn();
    syncDockTabs(); // the same rule's other half: a hidden library offers its pull-up tab in its own mode
    propLibToggle.style.display = propLaunchersVisible() ? 'block' : 'none';
    propTools.updatePropPreview(); // show the held/selected prop preview in Props mode, hide it otherwise
    viewport.setPropArmed(propping && store.armedProp // an armed prop places (and ghosts) only in Props mode
      ? { level: store.armedProp.level, model: store.armedProp.model, baseOffset: propBaseOffset(store.armedProp.level, store.armedProp.model) }
      : null);
    palette.setVisible(painting);   // the Palette shows while painting
    updateCmdSheet();
  }

  viewport.setCreateEdgePreviewListener(createTools.refreshCreateEdgeSummary);
  viewport.setCreatePatchPreviewListener(createTools.refreshCreatePatchSummary);
  viewport.setCreateTubePreviewListener(createTools.refreshCreateTubeSummary);
  viewport.setCreateTrailPreviewListener(createTools.refreshCreateTrailSummary);
  return { rebuildTools, updatePaintUi, updateCmdSheet };
}

export type ToolsPanel = ReturnType<typeof createToolsPanel>;
