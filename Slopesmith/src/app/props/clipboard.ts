import type { V3 } from '../../core/doc/types';
import {
  copyPlacements,
  pasteGhost,
  pasteLightGhost,
  pastePlacements,
  type PropClipboard,
} from '../../core/props/clipboard';
import { isEffectTriggerProp } from '../../core/effects/trigger-volume';
import { hasSelectedSet, selectedPlacementLights, selectedSetLights, setSelectedSet, type Store } from '../state/store';
import type { EditSession } from '../edit/session';
import type { Viewport } from '../viewport/viewport';
import type { Mode } from '../viewport/types';
import type { PropOps } from './operations';
import { toast } from '../ui/components/toast';

/**
 * Prop/light copy / cut / paste (docs/012): Ctrl+C / X / V over a selected placement, light or box-selected set in
 * Props or Edit mode. Pasting enters Props mode for the same placement workflow as a Library pick.
 * A paste is held like a prop from the Library: its ghost rides the terrain under the cursor — turned with
 * Alt+wheel or ← / →, resized with Shift+wheel — until a click drops it, selected under the move gizmo, or Esc
 * puts it down. The set keeps its shape about the anchor it was copied by. The clipboard is session-local and
 * outlives a mountain switch; core/props/clipboard.ts decides what survives one.
 */

export type PropClipboardDeps = {
  store: Store;
  edit: Pick<EditSession, 'mixedEditSelection'>;
  setMode: (mode: Mode) => void;
  viewport: Pick<Viewport, 'setLightArmed' | 'setPropArmed' | 'propPastePlacing' | 'groundHeightAt'>;
  propOps: Pick<
    PropOps,
    | 'disarmProp'
    | 'deselectPropOrLight'
    | 'deleteSelectedProp'
    | 'deleteMultiSelProps'
    | 'shortPropName'
    | 'ensurePropLevel'
    | 'ensureGroupDefs'
  >;
  deleteSelectedLight: () => void;
  /** Pasted props arrive under the move gizmo, whatever tool the last selection left it on. */
  resetGizmoMode: () => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
};

export function createPropClipboard(deps: PropClipboardDeps) {
  const {
    store,
    edit,
    setMode,
    viewport,
    propOps,
    deleteSelectedLight,
    resetGizmoMode,
    scheduleRebuild,
    rebuildTools,
    updateCmdSheet,
  } = deps;
  let clipboard: PropClipboard | null = null;
  /** The clipboard on the cursor, while its ghost is out. */
  let placingClip: PropClipboard | null = null;

  const plural = (n: number) => `${n} prop${n === 1 ? '' : 's'}`;
  /** The placements a copy would take: the box selection, else the one selected placement. */
  const selection = (): number[] =>
    store.multiSel.length ? store.multiSel : store.selectedProp !== null ? [store.selectedProp] : [];
  const lightSelection = (): string[] => selectedPlacementLights(store);
  /** What a toast names: the prop itself for one, a count for a set. */
  const label = (names: readonly string[]) =>
    names.length === 1 ? propOps.shortPropName(names[0]) : plural(names.length);
  const selectionLabel = (names: readonly string[], lights: readonly { name?: string }[]) => {
    const props = names.length ? label(names) : '';
    const lightLabel =
      lights.length === 1 && !props
        ? (lights[0].name ?? '1 light')
        : `${lights.length} light${lights.length === 1 ? '' : 's'}`;
    return [props, lights.length ? lightLabel : ''].filter(Boolean).join(' + ');
  };
  const clipLabel = (clip: PropClipboard) =>
    selectionLabel(
      clip.entries.map(entry => entry.prop.name),
      clip.lights ?? [],
    );

  function available(): boolean {
    return (
      store.currentMode === 'props' ||
      (store.currentMode === 'edit' && !store.modelEditId && store.bridgeRails === null)
    );
  }
  function canCopy(): boolean {
    return (
      available() &&
      (selection().length > 0 || lightSelection().length > 0) &&
      (store.currentMode !== 'edit' || !edit.mixedEditSelection())
    );
  }
  /** Not while another tool owns the click: a rail or prop line being drawn, a held gem. */
  function canPaste(): boolean {
    return (
      available() &&
      store.clipboardKind === 'props' &&
      !!clipboard &&
      !store.railDrawing &&
      !store.lineDrawing &&
      !store.gemArmed
    );
  }
  function count(): number {
    return (clipboard?.entries.length ?? 0) + (clipboard?.lights?.length ?? 0);
  }
  const summary = () => (clipboard ? clipLabel(clipboard) : plural(0));
  /** Whether the paste ghost is out. Anything else that takes the cursor — a prop from the Library, a rail,
   *  leaving Props — puts the paste down with it, so this asks the viewport rather than trusting itself. */
  function placing(): boolean {
    if (placingClip && !viewport.propPastePlacing) placingClip = null;
    return placingClip !== null;
  }

  function capture(): PropClipboard | null {
    if (!canCopy()) return null;
    const clip = copyPlacements(
      store.mdoc,
      selection(),
      (x, z, nearY) => viewport.groundHeightAt(x, z, nearY),
      lightSelection(),
    );
    if (!clip) {
      toast('nothing copied — Effects trigger volumes are copied in Effects mode', 'warn');
      return null;
    }
    clipboard = clip;
    store.clipboardKind = 'props';
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
    if (hasSelectedSet(store)) {
      setSelectedSet(
        store,
        store.multiSel.filter(i => !isEffectTriggerProp(store.mdoc.props?.[i])),
        selectedSetLights(store),
      );
      propOps.deleteMultiSelProps();
    } else if (store.selectedLight !== null) deleteSelectedLight();
    else propOps.deleteSelectedProp();
    toast(`cut ${clipLabel(clip)} · Ctrl+V to paste`, 'ok');
    updateCmdSheet();
  }

  /** Put the clipboard on the cursor. */
  async function paste() {
    if (!canPaste() || !clipboard) return;
    const clip = clipboard;
    const mode = store.currentMode,
      mountain = store.mdoc.name;
    const ghost = pasteGhost(store.mdoc, clip);
    const ghostLights = pasteLightGhost(clip);
    if (!ghost.length && !ghostLights.length) {
      toast('nothing to paste — the copied props are models from another mountain', 'warn');
      return;
    }
    // The ghost draws from loaded geometry, and a set copied on another mountain can name levels not loaded here.
    try {
      await Promise.all([
        ...[...new Set(ghost.map(p => p.level))].map(level => propOps.ensurePropLevel(level)),
        ...[...new Set(ghost.filter(p => p.group).map(p => p.level))].map(level => propOps.ensureGroupDefs(level)),
      ]);
    } catch (e) {
      toast(`props load failed: ${e}`, 'err');
      return;
    }
    if (!canPaste() || clipboard !== clip || store.currentMode !== mode || store.mdoc.name !== mountain) return;
    if (store.currentMode !== 'props') setMode('props');
    propOps.disarmProp(); // the paste is what is in hand now
    viewport.setLightArmed(false); // …a held light included
    propOps.deselectPropOrLight(); // …and the ghost replaces whatever inspector was open
    store.selectedRail = null;
    store.selectedNode = null;
    store.selectedGem = null;
    viewport.setPropArmed({
      level: ghost[0]?.level ?? '',
      model: ghost[0]?.model ?? 0,
      baseOffset: 0,
      paste: ghost,
      pasteLights: ghostLights,
    });
    placingClip = clip;
    rebuildTools();
    updateCmdSheet();
    toast(`${clipLabel(clip)} — click to place · Alt+scroll or ← → turns · Esc cancels`, 'info');
  }

  /** Esc, or the panel's cancel: put the paste down, placing nothing. */
  function cancel() {
    if (!placing()) return;
    placingClip = null;
    viewport.setPropArmed(null);
    rebuildTools();
    updateCmdSheet();
  }

  /** The click: drop the set where its ghost stood — the anchor at `pos`, turned and scaled as the ghost was —
   *  and select what landed. One click places one copy; Ctrl+V again holds another. */
  function place(pos: V3, yaw: number, scale: number) {
    if (!placing() || !placingClip) return;
    const clip = placingClip;
    placingClip = null;
    viewport.setPropArmed(null);
    const { indices, skipped, lights } = pastePlacements(store.mdoc, clip, { pos, yaw, scale });
    resetGizmoMode();
    // A light that landed in a group is selected with its group; the rest ride in the set beside the props.
    const free = lights.filter(id => !store.mdoc.lights?.find(light => light.id === id)?.assembly);
    const set = indices.length + free.length > 1;
    store.selectedProp = set ? null : (indices[0] ?? null);
    store.selectedLight = !set && !indices.length ? (free[0] ?? null) : null;
    setSelectedSet(store, set ? indices : [], set ? free : []);
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    const pasted = selectionLabel(
      indices.map(index => store.mdoc.props![index].name),
      clip.lights ?? [],
    );
    const missing = skipped ? ` · ${plural(skipped)} skipped — their models belong to another mountain` : '';
    toast(`pasted ${pasted}${missing}`, skipped ? 'warn' : 'ok');
  }

  return { canCopy, canPaste, count, summary, placing, copy, cut, paste, cancel, place };
}

export type PropClipboardSession = ReturnType<typeof createPropClipboard>;
