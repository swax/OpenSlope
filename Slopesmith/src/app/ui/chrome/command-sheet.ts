import type { Store } from '../../state/store';
import { rideControlHelp } from '../../ride/control-help';

const helpRow = ([key, description]: [string, string]) => `<div class="ll-row"><b>${key}</b> ${description}</div>`;
const helpPanel = (title: string, ...groups: [string, string][][]) =>
  `<div class="ll-title">${title}</div>`
  + groups.filter(group => group.length).map(group => group.map(helpRow).join('')).join('<div class="ll-sep"></div>');

export type CommandSheetDeps = {
  store: Store;
  cageActive: () => boolean;
  pastePlacing: () => boolean;
  canRotateSelection: () => boolean;
  editSelection: () => { kind: 'control points' | 'edges' | 'patches' | 'mixed selection'; readOnly: boolean } | null;
  selectedControlCagesVisible: () => boolean;
  canEditCurvature: () => boolean;
  edgeExtrusionStaged: () => boolean;
  edgeExtrusionFanMode: () => boolean;
  edgeExtrusionSideFlippable: () => boolean;
  paletteSurfaceView: () => boolean;
  desktopRiding: () => boolean;
  rideWalking: () => boolean;
  rideFirstPerson: () => boolean;
};

/** Bottom keyboard/mouse help overlays. Kept outside the tools builder because this is a mode projection, not
 * lil-gui construction, and it is refreshed independently by viewport selection/tool changes. */
export function createCommandSheet(deps: CommandSheetDeps) {
  const { store, cageActive, pastePlacing, canRotateSelection, editSelection, selectedControlCagesVisible, canEditCurvature, edgeExtrusionStaged, edgeExtrusionFanMode,
    edgeExtrusionSideFlippable, paletteSurfaceView, desktopRiding, rideWalking, rideFirstPerson } = deps;
  const cmdSheet = document.getElementById('cmdsheet')!;
  const paintControls = document.getElementById('paintctl')!;
  const lowerLeft = document.getElementById('lowerleft')!;
  const toolHelp = document.getElementById('toolhelp')!;
  const lowerRight = document.getElementById('lowerright')!;

  function editSelectionHelp() {
    const selection = editSelection();
    if (!selection) {
      const clickKinds = [store.editPickKinds.point ? 'point' : '', store.editPickKinds.edge ? 'edge' : '',
        store.editPickKinds.patch ? 'patch' : '', store.editPickKinds.prop ? 'prop' : ''].filter(Boolean).join(' / ');
      const dragKinds = [store.editPickKinds.point ? 'points' : '', store.editPickKinds.edge ? 'edges' : '',
        store.editPickKinds.patch ? 'patches' : '', store.editPickKinds.prop ? 'props' : ''].filter(Boolean).join(' / ');
      const loopKinds = [store.editPickKinds.edge ? 'edge' : '', store.editPickKinds.patch ? 'patch' : '']
        .filter(Boolean).join(' / ');
      return helpPanel('Edit Mode',
      [
        ['LMB', `select ${clickKinds}`],
        ...(loopKinds ? [['double-click', `select ${loopKinds} loop`] as [string, string]] : []),
        ['drag', `box-select ${dragKinds}`],
      ],
      [['⇧LMB', 'extend range / block'], ['Ctrl+LMB', 'toggle item'],
        ['⇧ drag', 'add boxed items'], ['Ctrl drag', 'remove boxed items'],
        ...(store.hiddenVertices.length || store.hiddenEdges.length || store.hiddenQuads.length || store.refHiddenQuads.length
          ? [['Alt+H', 'show all hidden'] as [string, string]] : [])],
      );
    }
    if (selection.kind === 'mixed selection') {
      return helpPanel('Edit Mode — mixed selection',
        selection.readOnly ? [] : [['W / E', 'move / rotate all selected types together']],
        [['Ctrl+LMB', 'toggle any enabled type'], ['Tools count', 'keep one selected type'], ['Esc', 'deselect all']]);
    }
    return helpPanel(`Edit Mode — ${selection.kind}`,
      [
        ['Ctrl+LMB', 'toggle selection'],
        ['⇧LMB', 'extend range / block'],
        ['drag', 'box-select control points'],
      ],
      [['⇧ drag', 'add boxed points'], ['Ctrl drag', 'remove boxed points']],
      selection.readOnly
        ? [
          ...(store.refCellSel.length ? [['H', 'hide reference patch selection'] as [string, string]] : []),
          ...(store.refEdgeSel.length || store.refCellSel.length
            ? [['G', `${selectedControlCagesVisible() ? 'hide' : 'show'} control cage`] as [string, string]] : []),
          ...(store.hiddenVertices.length || store.hiddenEdges.length || store.hiddenQuads.length || store.refHiddenQuads.length
            ? [['Alt+H', 'show all hidden'] as [string, string]] : []),
        ]
        : [
          ...(canRotateSelection() ? [['W / E / R', 'move / rotate / scale'] as [string, string]] : []),
          ['Ctrl+A', 'select connected'],
          ['H', 'hide selection'],
          ...((store.edgeSel.length || store.cellSel.length) && canEditCurvature()
            ? [['G', `${selectedControlCagesVisible() ? 'hide' : 'show'} control cage`] as [string, string]] : []),
          ['Alt+H', 'show all hidden'],
          ['D', 'dissolve when topology permits'],
          ...(store.cellSel.length ? [['I', 'split selected patch strip'] as [string, string]] : []),
          ...(store.cellSel.length ? [['N', 'flip ridable side'] as [string, string]] : []),
        ],
    );
  }

  return function updateCommandSheet() {
    const rideHelp = desktopRiding() ? rideControlHelp(rideWalking(), rideFirstPerson()) : null;
    cmdSheet.innerHTML = rideHelp
      ? helpPanel(rideHelp.title, ...rideHelp.groups)
      : helpPanel('View',
        [['RMB', 'orbit'], ['Alt+RMB', 'fly · WASD/QE'], ['MMB', 'pan'], ['wheel', 'zoom'], ['F', 'frame'], ['1–7', 'switch main view']]);
    cmdSheet.style.display = cmdSheet.innerHTML ? '' : 'none';
    paintControls.innerHTML = rideHelp ? '' : store.currentMode === 'info'
      ? helpPanel('Scene Mode — course', [['LMB point', 'select + move'], ['drag', 'box-select points'], ['Del', 'delete selected points'], ['Esc', 'deselect']])
      : store.currentMode === 'play'
        ? (store.placingStart
          ? helpPanel('Test Mode — set start', [['LMB', 'place the ride start'], ['Esc', 'cancel']])
          : helpPanel('Test Mode', [['LMB', 'drop an AI rider'], ['▶ Play', 'ride it yourself'], ['👁 Watch', 'watch the AI field']]))
      : store.currentMode === 'paint'
      ? (store.paintBrush
        ? helpPanel('Paint Mode — placing', [['LMB', 'place tile'], ['MMB', 'select + arm texture'], ['← →', 'turn brush'], ['⇧← →', 'mirror'], ['Esc', 'put down']])
        : helpPanel('Paint Mode — select', [['LMB', 'select / inspect'], ['MMB', 'select + arm texture'], ['⇧LMB', 'select range'], ['← →', 'turn tile'], ['⇧← →', 'mirror'], ['Del', 'clear tiles'], ['Esc', 'deselect']]))
      : store.currentMode === 'effects'
        ? helpPanel('Effects Mode — select', [['LMB', 'select'], ['Ctrl/Cmd+LMB', 'select many'],
          ['gizmo', 'move / resize'], ['Del', 'remove authored'], ['Esc', 'deselect']])
      : store.currentMode === 'props'
        ? (store.armedProp
          ? helpPanel('Props Mode — placing', [['LMB', 'place'], ['scroll', 'turn'], ['⇧scroll', 'resize'], ['MMB', 'select + arm prop'], ['Esc', 'put down']])
          : helpPanel('Props Mode — select', [['LMB', 'select'], ['drag', 'box-select many'], ['MMB', 'select + arm prop'],
            ...(canRotateSelection() ? [['W / E / R', 'move / rotate / scale'] as [string, string]] : []),
            ['Del', 'remove'], ['Esc', 'deselect']]))
        : store.currentMode === 'edit' && edgeExtrusionStaged()
          ? edgeExtrusionFanMode()
            ? helpPanel('Edit Mode — extrude', [['distance handle', 'set extrusion depth'],
              ...(edgeExtrusionSideFlippable() ? [['F', 'flip interior side'] as [string, string]] : []),
              ['W', 'full move gizmo'], ['E / R', 'rotate / scale']])
            : helpPanel('Edit Mode — extrude', [['W / E / R', 'move / rotate / scale']])
        : store.currentMode === 'edit' && pastePlacing()
          ? helpPanel('Edit Mode — paste', [['move', 'position on terrain or space'], ['LMB', 'place']])
        : store.currentMode === 'edit' && store.bridgeRails !== null
          ? helpPanel('Edit Mode — bridge', [['LMB / double-click', 'select candidate rail'], ['⇧LMB', 'extend candidate']])
        : store.currentMode === 'edit' && store.createEdgeTool
          ? helpPanel('Edit Mode — create edge', [['LMB vertex', 'start / finish'], ['LMB edge point', 'start / finish on edge'], ['LMB terrain / space', 'place free point'], ['⇧LMB', 'axis-lock free edge']])
        : store.currentMode === 'edit' && store.surgeryTool === 'tube'
          ? helpPanel('Edit Mode — create tube', [['LMB', 'place axis endpoint'], ['⇧LMB', 'lock world axis'], ['Enter', 'create + select patches'], ['Esc', 'cancel']])
        : store.currentMode === 'edit' && store.surgeryTool === 'trail'
          ? helpPanel('Edit Mode — create trail', [['LMB', 'add spline knot'], ['⇧LMB', 'lock world axis'], ['Backspace', 'undo last knot'], ['Enter', 'create + select patches'], ['Esc', 'cancel']])
        : store.currentMode === 'edit' && cageActive()
          ? (store.surgeryTool === 'patch'
            ? helpPanel('Edit Mode — create patch', [['LMB', 'place next corner'], ['repeat corner', 'close three corners as triangle'], ['⇧LMB', 'lock world axis'], ['Enter', 'finish + select created'], ['Esc', 'finish · keep unselected']])
            : store.surgeryTool === 'loopcut'
            ? helpPanel('Edit Mode — loop cut', [['hover', 'an edge'], ['scroll', 'slide the cut'], ['LMB', 'cut']])
            : store.weldTool === 'edge-weld'
            ? helpPanel('Edit Mode — weld edges', [['LMB / ⇧LMB', 'select target edges'], ['double-click', 'select target loop'], ['Enter', 'commit'], ['Esc', 'cancel']])
            : store.weldTool === 'weld'
            ? helpPanel('Edit Mode — weld points', [['LMB / ⇧LMB', 'select target points'], ['drag', 'box-select targets'], ['Enter', 'commit']])
            : editSelectionHelp())
          : '';
    paintControls.style.display = paintControls.innerHTML ? '' : 'none';

    if (store.currentMode === 'paint') {
      toolHelp.innerHTML = paletteSurfaceView()
        ? helpPanel('Palette', [['＋ paint', 'arm preview'], ['click cell', 'use as brush'], ['R-click', 'set ride feel'], ['drag', 'reorder'], ['⇧drag', 'copy'], ['✕', 'clear cell']])
        : helpPanel('Palette', [['＋ paint', 'arm preview'], ['click cell', 'use as brush'], ['← →', 'turn active tile'], ['⇧← →', 'mirror'], ['drag', 'reorder'], ['⇧drag', 'copy'], ['✕', 'clear cell'], ['orange', 'edges don’t align']]);
    } else if (store.currentMode === 'sculpt') {
      toolHelp.innerHTML = helpPanel('Sculpt', [['LMB', 'raise / lower'], ['[ ]', 'brush size']]);
    } else if (store.currentMode === 'props' && store.propLibWanted) {
      toolHelp.innerHTML = helpPanel('Prop Library', [['click', 'pick a prop'], ['search', 'filter by name'], ['level', 'choose a world']]);
    } else {
      toolHelp.innerHTML = '';
    }
    lowerRight.classList.toggle('on', !!toolHelp.innerHTML);

    const panel = document.querySelector<HTMLElement>(store.currentMode === 'props' ? '.pl-pal' : '.sp-pal');
    const overPanel = (store.currentMode === 'paint' || store.currentMode === 'props') && panel && panel.style.display !== 'none';
    const bottom = overPanel ? `${panel!.offsetHeight + 8}px` : '8px';
    lowerLeft.style.bottom = bottom;
    lowerRight.style.bottom = bottom;
  };
}
