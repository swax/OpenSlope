import type { V3 } from '../../core/doc/types';
import { copyPlacements, pasteGhost, pastePlacements, type PropClipboard } from '../../core/props/clipboard';
import { isEffectTriggerProp } from '../../core/effects/trigger-volume';
import type { Store } from '../state/store';
import type { Viewport } from '../viewport/viewport';
import type { PropOps } from './operations';
import { toast } from '../ui/components/toast';

/**
 * Props-mode copy / cut / paste (docs/012): Ctrl+C / X / V over the selected placement or the box-selected set.
 * A paste is held like a prop from the Library: its ghost rides the terrain under the cursor — turned with
 * Alt+wheel or ← / →, resized with Shift+wheel — until a click drops it, selected under the move gizmo, or Esc
 * puts it down. The set keeps its shape about the anchor it was copied by. The clipboard is session-local and
 * outlives a mountain switch; core/props/clipboard.ts decides what survives one.
 */

export type PropClipboardDeps = {
  store: Store;
  viewport: Pick<Viewport, 'setLightArmed' | 'setPropArmed' | 'propPastePlacing' | 'groundHeightAt'>;
  propOps: Pick<PropOps, 'disarmProp' | 'deselectPropOrLight' | 'deleteSelectedProp' | 'deleteMultiSelProps'
    | 'shortPropName' | 'ensurePropLevel' | 'ensureGroupDefs'>;
  /** Pasted props arrive under the move gizmo, whatever tool the last selection left it on. */
  resetGizmoMode: () => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
};

export function createPropClipboard(deps: PropClipboardDeps) {
  const { store, viewport, propOps, resetGizmoMode, scheduleRebuild, rebuildTools, updateCmdSheet } = deps;
  let clipboard: PropClipboard | null = null;
  /** The clipboard on the cursor, while its ghost is out. */
  let placingClip: PropClipboard | null = null;

  const plural = (n: number) => `${n} prop${n === 1 ? '' : 's'}`;
  /** The placements a copy would take: the box selection, else the one selected placement. */
  const selection = (): number[] =>
    store.multiSel.length ? store.multiSel : store.selectedProp !== null ? [store.selectedProp] : [];
  /** What a toast names: the prop itself for one, a count for a set. */
  const label = (names: readonly string[]) => names.length === 1 ? propOps.shortPropName(names[0]) : plural(names.length);
  const clipLabel = (clip: PropClipboard) => label(clip.entries.map(entry => entry.prop.name));

  function canCopy(): boolean { return store.currentMode === 'props' && selection().length > 0; }
  /** Not while another tool owns the click: a rail or prop line being drawn, a held gem. */
  function canPaste(): boolean {
    return store.currentMode === 'props' && !!clipboard && !store.railDrawing && !store.lineDrawing && !store.gemArmed;
  }
  function count(): number { return clipboard?.entries.length ?? 0; }
  /** Whether the paste ghost is out. Anything else that takes the cursor — a prop from the Library, a rail,
   *  leaving Props — puts the paste down with it, so this asks the viewport rather than trusting itself. */
  function placing(): boolean {
    if (placingClip && !viewport.propPastePlacing) placingClip = null;
    return placingClip !== null;
  }

  function capture(): PropClipboard | null {
    if (!canCopy()) return null;
    const clip = copyPlacements(store.mdoc, selection(), (x, z, nearY) => viewport.groundHeightAt(x, z, nearY));
    if (!clip) { toast('nothing copied — Effects trigger volumes are copied in Effects mode', 'warn'); return null; }
    clipboard = clip;
    return clip;
  }

  function copy() {
    const clip = capture();
    if (!clip) return;
    toast(`copied ${clipLabel(clip)} · Ctrl+V to paste`, 'ok');
    rebuildTools();
  }

  function cut() {
    const clip = capture();
    if (!clip) return;
    // Only what was copied goes: a trigger volume in the set stays, since the clipboard could not take it.
    if (store.multiSel.length) {
      store.multiSel = store.multiSel.filter(i => !isEffectTriggerProp(store.mdoc.props?.[i]));
      propOps.deleteMultiSelProps();
    } else propOps.deleteSelectedProp();
    toast(`cut ${clipLabel(clip)} · Ctrl+V to paste`, 'ok');
    updateCmdSheet();
  }

  /** Put the clipboard on the cursor. */
  async function paste() {
    if (!canPaste() || !clipboard) return;
    const clip = clipboard;
    const ghost = pasteGhost(store.mdoc, clip);
    if (!ghost.length) { toast('nothing to paste — the copied props are models from another mountain', 'warn'); return; }
    // The ghost draws from loaded geometry, and a set copied on another mountain can name levels not loaded here.
    try {
      await Promise.all([
        ...[...new Set(ghost.map(p => p.level))].map(level => propOps.ensurePropLevel(level)),
        ...[...new Set(ghost.filter(p => p.group).map(p => p.level))].map(level => propOps.ensureGroupDefs(level)),
      ]);
    } catch (e) { toast(`props load failed: ${e}`, 'err'); return; }
    if (!canPaste() || clipboard !== clip) return; // the editor moved on while it loaded
    propOps.disarmProp();          // the paste is what is in hand now
    viewport.setLightArmed(false); // …a held light included
    propOps.deselectPropOrLight(); // …and the ghost replaces whatever inspector was open
    store.selectedRail = null; store.selectedNode = null; store.selectedGem = null;
    viewport.setPropArmed({ level: ghost[0].level, model: ghost[0].model, baseOffset: 0, paste: ghost });
    placingClip = clip;
    rebuildTools(); updateCmdSheet();
    toast(`${clipLabel(clip)} — click to place · Alt+scroll or ← → turns · Esc cancels`, 'info');
  }

  /** Esc, or the panel's cancel: put the paste down, placing nothing. */
  function cancel() {
    if (!placing()) return;
    placingClip = null;
    viewport.setPropArmed(null);
    rebuildTools(); updateCmdSheet();
  }

  /** The click: drop the set where its ghost stood — the anchor at `pos`, turned and scaled as the ghost was —
   *  and select what landed. One click places one copy; Ctrl+V again holds another. */
  function place(pos: V3, yaw: number, scale: number) {
    if (!placing() || !placingClip) return;
    const clip = placingClip;
    placingClip = null;
    viewport.setPropArmed(null);
    const { indices, skipped } = pastePlacements(store.mdoc, clip, { pos, yaw, scale });
    resetGizmoMode();
    store.selectedProp = indices.length === 1 ? indices[0] : null;
    store.multiSel = indices.length > 1 ? indices : [];
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    const pasted = label(indices.map(index => store.mdoc.props![index].name));
    const missing = skipped ? ` · ${plural(skipped)} skipped — their models belong to another mountain` : '';
    toast(`pasted ${pasted}${missing}`, skipped ? 'warn' : 'ok');
  }

  return { canCopy, canPaste, count, placing, copy, cut, paste, cancel, place };
}

export type PropClipboardSession = ReturnType<typeof createPropClipboard>;
