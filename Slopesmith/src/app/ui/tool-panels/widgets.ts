import type GUI from 'lil-gui';
import type { MultiSelectList } from '../../props/multi-select-list';
import type { BridgeRailList } from '../components/bridge-rail-list';
import type { ToolsPanelDeps } from './tools-panel-deps';
import { note, tip } from '../components/gui';

/**
 * The shared vocabulary of the per-mode Tools builders (ui/tool-panels/*): the metric formatters every read-out
 * uses, the persistent-open-state Edit section factory, and the ToolsContext the coordinator
 * (ui/chrome/tools-panel.ts) hands each builder — the panel's deps plus the lil-gui host, the rebuild lifecycle,
 * and the persistent list widgets the builders show per mode.
 */

/** The context a mode builder works in: the panel's deps plus what the coordinator owns on their behalf. */
export type ToolsContext = ToolsPanelDeps & {
  /** The lil-gui host every mode's toolbox builds into (cleared each rebuild; persistent children survive). */
  gui: GUI;
  /** Task-oriented toolbox groups whose open/closed state survives toolbox rebuilds (see createEditSections).
   *  Edit's sections are most of them; Play's Position section is one too. */
  editSection: (key: string, title: string, defaultOpen?: boolean) => GUI;
  /** The coordinator's rebuild lifecycle, for controls that change which toolbox / help sheet shows. */
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  /** Persistent panel children (survive clearGui) that the builders show / hide per mode. */
  multiList: MultiSelectList;
  bridgeList: BridgeRailList;
};

/**
 * The way out of a placement tool, ending the rail / gem / light panels alike.
 *
 * Each of those tools is entered from a button in the idle Prop Tools launcher and then REPLACES that launcher
 * with its own panel, so without this the only way back is Escape — a key with no affordance in a panel full
 * of them. Last row, under the tool's own actions, so it reads as leaving rather than as one more thing to do.
 */
export function placementCancelButton(ctx: ToolsContext) {
  const { gui, store, cancelPlacement } = ctx;
  tip(gui.add({ cancel: () => cancelPlacement() }, 'cancel').name('◀ cancel'),
    store.railDrawing
      ? 'Put the rail tool down; a rail with fewer than two points is discarded.'
      : 'Put the tool down; nothing already placed is removed.');
}

/**
 * A path's Bézier handles (docs/014), the same rows on every panel that edits one — rail, motion path, prop line,
 * trail: how to bend the curve, then the resets once something has been bent. The node reset acts on the point
 * whose handle (or bulb) is selected; the path reset on every point.
 */
export function pathHandleActions(ctx: ToolsContext, g: GUI) {
  const { pathHandles } = ctx;
  const state = pathHandles.resetState();
  note(g, 'drag a pink handle of the selected point to bend the curve · hold Alt to move one side alone');
  if (state.node) tip(g.add({ reset: pathHandles.resetNode }, 'reset').name('↺ reset this point’s handles'),
    'Put this point back on the automatic smooth curve.');
  if (state.path) tip(g.add({ resetAll: pathHandles.resetPath }, 'resetAll').name('↺ reset all handles'),
    'Put every point back on the automatic smooth curve.');
}

/** Metric read-outs (Edit toolbox): a length in metres to one decimal, an area in m² (whole numbers once it's
 *  big enough that a decimal is noise). The core measures off the real quilt (core/mesh/measure.ts). */
export const fmtM = (m: number) => `${m.toFixed(1)} m`;
export const fmtArea = (m: number) => `${m >= 100 ? Math.round(m).toString() : m.toFixed(1)} m²`;

/** Task-oriented toolbox groups. Their open/closed state survives toolbox rebuilds caused by selection changes. */
export function createEditSections(gui: GUI) {
  const editSectionOpen = new Map<string, boolean>();
  return function editSection(key: string, title: string, defaultOpen = true): GUI {
    const folder = gui.addFolder(title);
    folder.domElement.classList.add('sp-edit-section');
    folder.open(editSectionOpen.get(key) ?? defaultOpen);
    folder.onOpenClose(changed => editSectionOpen.set(key, !changed._closed));
    return folder;
  };
}
