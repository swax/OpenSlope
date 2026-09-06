import type { PlacedProp, Rail, V3 } from '../../core/doc/types';
import {
  isBareRail, isMotionPath, nextMotionPathId, nextRailId, railHasTube, railMaterialLabel, railStartsOff,
  railStyle, sampleRail,
  RAIL_STYLE_METAL,
} from '../../core/rails/rails';
import type { ParticleVolume } from '../../core/particles/volumes';
import {
  cloneParticleVolume,
  createFogVolume,
} from '../../core/particles/volumes';
import {
  EFFECT_TYPES,
  addEmptyEffect,
  addEmptyEffectToProp,
  addEffectFunction,
  addEffectNodeTemplate,
  addEffectTemplate,
  addEffectTemplateToProp,
  attachEffectToProp,
  authoredEffectBindings,
  authoredInstanceEffectCall,
  authoredSplineId,
  bindEffectSplineToMotionPath,
  bindEffectFunctionCall,
  bindEffectSplineToRail,
  bindZBoostToPlacement,
  zBoostTargetForOwner,
  createEmptyEffectsDocument,
  deleteEffectNode,
  deleteEffectOwner,
  detachEffectFromProp,
  duplicateEffectNode,
  duplicateEffectOwner,
  effectAttachments,
  effectNodeSoundFile,
  setEffectNodeSoundFile,
  effectCircumstanceLabel,
  effectGraphHasTimerEmitter,
  effectGraphDisplayName,
  effectSelectionForProp,
  effectNode,
  effectOwner,
  effectSlotCanSelfEnd,
  EFFECT_LATCH_SUMMARY,
  isEffectLatchCircumstance,
  setPropEffectLatch,
  emitterWorldPosition,
  ensurePlacedPropIds,
  graphSlots,
  moveEffectNode,
  moveEffectOwner,
  nextPlacedPropId,
  rawEmitterToEditor,
  replaceEffectNodeRaw,
  editorEmitterToRaw,
  setEmitterWorldPosition,
  syncAuthoredMotionPathEffectResources,
  splineEffectUses,
  splinePairedProps,
  particleEmitterFields,
  setParticleEmitterField,
  unassignedEffectOwnerIds,
  validateEffectsAuthoring,
  type EffectAttachment,
  type EffectCircumstance,
  type EffectOwnerKind,
  type EffectSelection,
  type SplineEffectUse,
  type AuthoredEffectCircumstance,
} from '../../core/effects/authoring';
import {
  emitterColorStopsFromNativeArgb,
  nativeArgbFieldsFromRgbaColorStops,
  type RgbaColor,
} from '../../core/effects/emitter-colors';
import {
  DEFAULT_EFFECT_TRIGGER_SIZE,
  EFFECT_TRIGGER_LEVEL,
  clampEffectTriggerSize,
  effectTriggerCollisionProfile,
  ensureEffectTriggerProps,
  isEffectTriggerProp,
} from '../../core/effects/trigger-volume';
import {
  semanticInspectorForNode,
  semanticNumberValue,
  setSemanticNumberValue,
} from '../../core/effects/semantic-fields';
import {
  type EffectGraph,
  type EffectNode,
  type EffectsDocument,
} from '../../core/effects/document';
import {
  effectPlayCommand, splineEndModeLabel, splineOrientationModeLabel,
  stepSplineMotionDistance, type EffectPlayCommand,
} from '../../core/effects/play-runtime';
import { PARTICLE_SPRITE_NAMES, emitterBlendLabel, timerEmitterPreviewLaw } from '../../core/effects/emitter-preview';
import { COURSE_BANK_LEVELS, effectSoundSource } from '../../core/effects/collision-sound';
import {
  animObjectFromNode, createAnimObjectPlayback, stepAnimObjectPlayback,
  type AnimObjectEffect, type AnimObjectPlayback,
} from '../../core/effects/world-effects';
import {
  propModelAnimationChannels, samplePropModelAnimationChannel,
  type PropModelAnimationChannel, type PropModelClip,
} from '../../core/reference/props';
import { surfaceFor } from '../ride/physics-math';
import type { Store } from '../state/store';
import type { Viewport } from '../viewport/viewport';
import { auditionCustomSound, auditionEffectSound } from '../ui/components/audition';
import {
  customSoundFilepath, customSounds, onCustomSoundsChanged, pickCustomSound,
} from '../ui/components/custom-sounds';
import { segmented } from '../ui/components/controls';
import { toast } from '../ui/components/toast';
import { ACTION_ICON, MODE_ICON } from '../ui/components/icons';
import { EffectHostPreview } from './host-preview';
import { openSoundLibrary } from './sound-library';
import {
  attachedReferenceInstances,
  referenceEffectDisplayName,
  referenceEffectSelection,
  referenceIncomingEffectCalls,
  referenceIncomingEffectTree,
  referenceOutgoingEffectCalls,
  referenceSupplementalOutgoingEffectCalls,
  referenceFireworkCall,
  referenceFireworkEffect,
  referenceInstanceEffectCall,
  referenceInstanceBindings,
  referenceNodeDisplayName,
  referenceSlot,
  referenceSplineEffectUses,
  referenceSplinePairedInstances,
  referenceUnhostedIncomingEffectCalls,
  type ReferenceSplineUse,
  type ReferenceEffectInstance,
  type ReferenceEffectsData,
  type ReferenceEffectsState,
} from '../../core/reference/effects';
import { effectCounterInstall } from '../../core/effects/counter';
import { effectNodeDetail } from '../../core/effects/node-detail';
import {
  EFFECT_NODE_TEMPLATES,
  button,
  checkboxRow,
  clampNumber,
  colorHex,
  colorRgbFromHex,
  countLabel,
  effectCallTree,
  effectHostListPanel,
  effectNodeTree,
  el,
  embedSection,
  embedSectionBody,
  helpIcon,
  iconButton,
  input,
  navigationButton,
  nodeDisplayName,
  nodeDisplayNameInGraph,
  nodeTemplateLabelInGraph,
  numberInput,
  row,
  section,
  select,
  templatePicker,
  treeActionMenu,
} from './editor-widgets';

export interface EffectsEditorDeps {
  store: Store;
  viewport: Viewport;
  scheduleRebuild: () => void;
  /** Load/cache the prop model table used by the compact effect-host preview. */
  loadPropLevel: (level: string) => Promise<import('../../core/reference/props').LevelProps>;
  /** Jump to Props mode with this effect's host selected — an authored placement by doc index, or a
   *  native reference instance by original Instances.json index. The host owns the mode switch. */
  goToProp: (target: { propIndex: number } | { sourceIndex: number }) => void;
  /** Hand a grind rail to the Tricks tools in Props view, still selected. The host owns the mode switch. */
  goToRail: (index: number) => void;
}

interface EffectsPanelView {
  readOnly: boolean;
  selection: EffectSelection | null;
  search: string;
  setSearch: (value: string) => void;
  selectOwner: (kind: EffectOwnerKind, ownerId: string, nodeId?: string) => void;
  ownerLabel: (kind: EffectOwnerKind, ownerId: string, fallback: string) => string;
  nodeLabel?: (node: EffectNode) => string;
  referenceData?: ReferenceEffectsData;
  visibleOwnerIds?: ReadonlySet<string>;
}

interface ReferenceEffectFocus {
  /** Native instance indices whose models are selected/highlighted. */
  instanceIndices: number[];
  /** Host whose tree and node inspector are open; null leaves a multi-selection at its chooser list. */
  activeInstanceIndex: number | null;
  selection: EffectSelection | null;
  /** Optional cross-instance target circled independently from the selected source hosts. */
  markerIndex: number | null;
  /** Caller branch used to open a remote graph while the receiving prop remains the active host. */
  callerIndex: number | null;
}

/**
 * Which side of the editor a clip timeline drives. The panel itself is identical for a borrowed reference
 * instance and an authored placement — same channels, same scrubbing, same playback law — and only these
 * few calls differ, so they are the seam rather than two copies of the timeline.
 */
interface ClipTarget {
  kind: 'reference' | 'authored';
  /** Section heading. The reference browser inspects a shipped level and says so. */
  title: string;
  /** Playback seed, so two placements of one model do not preview in lockstep. */
  seed: number;
  /** Hold the pose at `frame`, or release the hold back to whatever player owns the clip. */
  scrub(frame: number | null): void;
  /** Show or hide the recovered trajectory. Only reference instances have one drawn. */
  showPath(on: boolean): void;
  /** Stop a graph preview that would otherwise fight the timeline for the pose. */
  stopPreview(): void;
}

/** Everything a timeline needs before it has playback state: which clip, which player law, which side. */
interface ClipContext {
  key: string;
  target: ClipTarget;
  clip: PropModelClip;
  effect: AnimObjectEffect;
}

interface ClipViewerState {
  key: string;
  target: ClipTarget;
  clip: PropModelClip;
  effect: AnimObjectEffect;
  playback: AnimObjectPlayback;
  playing: boolean;
  loopPreview: boolean;
  engaged: boolean;
  lastTime: number;
  raf: number | null;
}

type ReferenceSplineCommand = Extract<EffectPlayCommand, { kind: 'spline-motion' }>;
type ReferenceSplineInfo = NonNullable<ReturnType<Viewport['referenceSplineMotionInfo']>>;

interface ReferenceSplineViewerState {
  key: string;
  sourceIndex: number;
  command: ReferenceSplineCommand;
  info: ReferenceSplineInfo;
  distance: number;
  direction: number;
  playing: boolean;
  loopPreview: boolean;
  engaged: boolean;
  lastTime: number;
  raf: number | null;
}

/** How many paired props a spline panel offers before it says how many more there are (see the panel). */
const PAIRED_PROP_LIMIT = 6;

const emptyReferenceEffectFocus = (): ReferenceEffectFocus => ({
  instanceIndices: [], activeInstanceIndex: null, selection: null, markerIndex: null, callerIndex: null,
});

/**
 * Effects-mode controller and view. State that ships lives in mdoc.effects plus the separate native-shaped
 * mdoc.particleVolumes channel; selection/search/view tabs are
 * deliberately transient. Every mutation uses the ordinary document rebuild funnel, so existing undo/redo,
 * local persistence, .slope save, level export, and history labels all work without a second command stack.
 */
export function createEffectsEditor(deps: EffectsEditorDeps) {
  const { store, viewport, goToProp } = deps;
  const root = el('div', 'sp-effects-editor');
  const hostPreview = new EffectHostPreview(deps.loadPropLevel);
  const calledModelPreview = new EffectHostPreview(deps.loadPropLevel, 'Called effect model preview');
  const callerModelPreview = new EffectHostPreview(deps.loadPropLevel, 'Caller model preview');
  let active = false;
  let selection: EffectSelection | null = null;
  let inspectorView: 'semantic' | 'raw' = 'semantic';
  let search = '';
  let attachmentPropId = '';
  let selectedAuthoredPropIds: string[] = [];
  let selectedAuthoredPropId: string | null = null;
  let source: 'mountain' | 'reference' = 'mountain';
  let referenceState: ReferenceEffectsState = { status: 'empty' };
  const mountainName = (): string => store.mdoc.name.trim() || 'Mountain';
  let referenceFocus = emptyReferenceEffectFocus();
  let referenceOwnerSearch = '';
  let authoredUnassignedOpen = false;
  let referenceUnassignedOpen = false;
  /** The course spline the author last clicked, so a node added afterwards binds to the rail or route they
   *  were just looking at rather than to whichever one the document lists first. */
  let lastSelectedSplineId: string | null = null;
  let selectedAuthoredParticleId: string | null = null;
  let selectedReferenceParticleIndex: number | null = null;
  /** A shipped level's grind curve, by its `Splines.json` row. The reference has no editable rail objects, so
   *  this is its own selection rather than a branch of the authored rail one. */
  let selectedReferenceSplineIndex: number | null = null;
  let clipViewer: ClipViewerState | null = null;
  /** Whether this render pass built the authored clip timeline; the sweep at the end of `render` releases
   *  a hold that nothing is showing a panel for any more. */
  let authoredClipPanelRendered = false;
  let updateClipViewerDom: (() => void) | null = null;
  let referenceSplineViewer: ReferenceSplineViewerState | null = null;
  let updateReferenceSplineViewerDom: (() => void) | null = null;

  // Effects can inspect both worlds. The switch is mounted only on the home screen; a drilled-in effect uses
  // Deselect/Escape to return before changing mountain context, matching the detail flow in other scene tools.
  const sourceTabs = segmented<'mountain' | 'reference'>(
    [
      { value: 'mountain', label: mountainName, title: () => `Edit and inspect effects on ${mountainName()}.` },
      { value: 'reference', label: 'Reference', title: () => referenceState.status === 'ready'
        ? `Inspect ${referenceState.data.level} effects and fog volumes (read only).`
        : referenceState.status === 'loading'
          ? `Inspect reference effects when ${referenceState.level} finishes loading.`
          : 'Load a reference level in Scene ▸ Reference to inspect its effects.' },
    ],
    () => source,
    setSource,
  );
  sourceTabs.el.setAttribute('role', 'group');
  sourceTabs.el.setAttribute('aria-label', 'Effects mountain context');
  const sourceTabsRow = el('div', 'sp-scene-tabs sp-fx-source-tabs');
  sourceTabsRow.appendChild(sourceTabs.el);

  const document = (): EffectsDocument | null => store.mdoc.effects ?? null;
  const props = (): PlacedProp[] => {
    const list = ensureEffectTriggerProps(store.mdoc);
    ensurePlacedPropIds(list);
    return list;
  };
  const volumes = (): ParticleVolume[] => (store.mdoc.particleVolumes ??= []);

  function setSource(next: 'mountain' | 'reference'): void {
    if (source === next) return;
    viewport.stopReferenceEffectPreview();
    source = next;
    selectedReferenceSplineIndex = null; // a reference curve cannot be inspected from the mountain tab
    viewport.selectReferenceRailSpline(null);
    viewport.setEffectHandle(null);
    if (next === 'mountain') {
      viewport.selectReferenceEffectInstances([]);
      viewport.selectReferenceParticleVolume(null);
      if (selectedAuthoredParticleId) viewport.selectAuthoredParticleVolume(selectedAuthoredParticleId);
    } else {
      viewport.selectAuthoredParticleVolume(null);
      if (referenceFocus.instanceIndices.length)
        viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, referenceFocus.markerIndex);
      if (selectedReferenceParticleIndex !== null)
        viewport.selectReferenceParticleVolume(selectedReferenceParticleIndex);
    }
    render();
  }

  function stopClipViewer(releasePose: boolean, hidePath = false): void {
    const viewer = clipViewer;
    if (viewer?.raf != null) cancelAnimationFrame(viewer.raf);
    if (viewer) {
      viewer.raf = null;
      viewer.playing = false;
      if (releasePose && viewer.engaged) {
        viewer.target.scrub(null);
        viewer.engaged = false;
      }
    }
    // With no viewer there is nothing to ask, but the reference path is drawn by the viewport rather than
    // by this panel — so it still gets the defensive hide it always had.
    if (hidePath) { if (viewer) viewer.target.showPath(false); else viewport.showReferenceAnimObjectPath(null); }
    updateClipViewerDom?.();
  }

  function disposeClipViewer(): void {
    stopClipViewer(true, true);
    clipViewer = null;
    updateClipViewerDom = null;
  }

  /** A manual graph preview owns the model pose while it runs. Release a timeline hold without hiding the
   * recovered trajectory or losing the user's current playhead. */
  function releaseClipPose(): void {
    stopClipViewer(true);
  }

  function stopReferenceSplineViewer(releasePose: boolean, hidePath = false): void {
    const viewer = referenceSplineViewer;
    if (viewer?.raf != null) cancelAnimationFrame(viewer.raf);
    if (viewer) {
      viewer.raf = null;
      viewer.playing = false;
      if (releasePose && viewer.engaged) {
        viewport.setReferenceSplineMotionDistance(viewer.sourceIndex, viewer.command, null);
        viewer.engaged = false;
      }
    }
    if (hidePath) viewport.hideReferenceSplineMotion();
    updateReferenceSplineViewerDom?.();
  }

  function disposeReferenceSplineViewer(): void {
    stopReferenceSplineViewer(true, true);
    referenceSplineViewer = null;
    updateReferenceSplineViewerDom = null;
  }

  /** A complete graph preview owns the prop while it runs; keep the recovered route visible. */
  function releaseReferenceSplinePose(): void {
    stopReferenceSplineViewer(true);
  }

  function attachmentBindings(doc: EffectsDocument, attachment: EffectAttachment):
    { circumstance: EffectCircumstance; graph: EffectGraph }[] {
    const slot = doc.slots.find(item => item.id === attachment.slot);
    if (!slot) return [];
    const out: { circumstance: EffectCircumstance; graph: EffectGraph }[] = [];
    for (const circumstance of Object.keys(slot.circumstances) as EffectCircumstance[]) {
      const graphId = slot.circumstances[circumstance];
      const graph = graphId ? doc.graphs.find(item => item.id === graphId) : null;
      if (graph) out.push({ circumstance, graph });
    }
    return out;
  }

  function authoredUnassignedOwnerIds(doc: EffectsDocument): Set<string> {
    return unassignedEffectOwnerIds(doc,
      effectAttachments(doc).filter(item => item.enabled).map(attachment => attachment.slot));
  }

  function referenceUnassignedOwnerIds(data: ReferenceEffectsData): Set<string> {
    return unassignedEffectOwnerIds(data.document, attachedReferenceInstances(data)
      .map(instance => referenceSlot(data.document, instance.effectSlotIndex)?.id)
      .filter((slotId): slotId is string => !!slotId));
  }

  function ensureDocument(): EffectsDocument {
    if (!store.mdoc.effects) store.mdoc.effects = createEmptyEffectsDocument(store.mdoc.name);
    return store.mdoc.effects;
  }

  function selectionValid(doc: EffectsDocument): boolean { return !!selection && !!effectOwner(doc, selection); }

  function normalizeSelection(doc: EffectsDocument): void {
    if (!selection) return;
    if (!selectionValid(doc)) { selection = null; return; }
    const owner = effectOwner(doc, selection);
    if (!owner) return;
    if (selection.nodeId && !owner.nodes.some(x => x.id === selection!.nodeId)) selection.nodeId = owner.nodes[0]?.id;
  }

  function dirty(rebuild = true): void {
    deps.scheduleRebuild();
    if (rebuild) render(); else syncGizmo();
  }

  /** Donor course bank chosen for auditioning direct slots on an authored mountain; null follows the attached
   *  prop's source level. Deliberately transient — the real bank is whatever the repack target ships. */
  let soundAuditionLevel: string | null = null;
  // The uploaded-WAV library is shared with the props inspector; re-render when it lands or grows.
  onCustomSoundsChanged(() => { if (active) render(); });

  function selectedAttachmentProp(doc: EffectsDocument): PlacedProp | undefined {
    if (!selection || selection.ownerKind !== 'graph') return undefined;
    const slots = new Set(graphSlots(doc, selection.ownerId).map(x => x.slot.id));
    const attachments = effectAttachments(doc).filter(x => x.enabled && slots.has(x.slot));
    const picked = attachments.find(x => x.target.id === attachmentPropId) ?? attachments[0];
    return picked ? props().find(p => p.id === picked.target.id) : undefined;
  }

  function authoredGraphDisplayName(doc: EffectsDocument, graphId: string): string | null {
    const matches = effectAttachments(doc).filter(attachment => attachment.enabled)
      .flatMap(attachment => attachmentBindings(doc, attachment)
        .filter(binding => binding.graph.id === graphId).map(binding => ({ attachment, binding })));
    const preferredPropId = selectedAuthoredPropId ?? attachmentPropId;
    const match = matches.find(item => item.attachment.target.id === preferredPropId) ?? matches[0];
    if (!match) return null;
    const graph = doc.graphs.find(item => item.id === graphId);
    return graph ? effectGraphDisplayName(graph, match.binding.circumstance) : null;
  }

  function selectedMotionPath(): { path: Rail; index: number } | null {
    const index = store.selectedRail;
    const path = index === null ? null : store.mdoc.rails?.[index];
    return index !== null && path && isMotionPath(path) ? { path, index } : null;
  }

  /** The selected GRIND rail, which Effects mode inspects rather than owns — it can be named by a toggle or a
   *  mover, and its geometry stays Props mode's to edit. */
  function selectedGrindRail(): { rail: Rail; index: number } | null {
    const index = store.selectedRail;
    const rail = index === null ? null : store.mdoc.rails?.[index];
    return index !== null && rail && !isMotionPath(rail) ? { rail, index } : null;
  }

  /**
   * The selected spline this mode may DRAW, as opposed to merely inspect: a motion path it owns outright, or
   * a bare grind rail.
   *
   * The line between the two is the tube, not the kind. A rail with a tube is a piece of course scenery that
   * Props mode draws, materials and floats; a rail without one has no geometry anywhere else in the editor,
   * so the mode that laid it down is the mode that has to be able to extend, trim and delete it.
   */
  function selectedDrawableSpline(): { rail: Rail; index: number } | null {
    const index = store.selectedRail;
    const rail = index === null ? null : store.mdoc.rails?.[index];
    return index !== null && rail && !railHasTube(rail) ? { rail, index } : null;
  }

  /** What to call the selected spline in a button or a toast. Only these two ever reach the draw actions. */
  const splineNoun = (rail: Rail): string => isMotionPath(rail) ? 'motion path' : 'rail spline';

  function dropSplineSelection(): boolean {
    if (store.selectedRail === null) return false;
    store.selectedRail = null; store.selectedNode = null; store.railDrawing = false;
    viewport.setRailArmed(false);
    viewport.setRails(store.mdoc.rails ?? [], null, null);
    return true;
  }

  /** Select an authored course spline without turning it into a prop/graph selection: an Effects-owned motion
   *  path with the clicked node live for dragging, or a grind rail as a whole for inspection. */
  function selectCourseSpline(index: number, node: number | null = null): boolean {
    if (!active || store.currentMode !== 'effects') return false;
    const path = store.mdoc.rails?.[index];
    if (!path) return false;
    if (railHasTube(path)) node = null; // a tube's points belong to the Tricks tools, not to this one
    lastSelectedSplineId = path.id ?? null;
    viewport.stopReferenceEffectPreview();
    source = 'mountain';
    selection = null; selectedAuthoredPropIds = []; selectedAuthoredPropId = null; authoredUnassignedOpen = false;
    referenceFocus = emptyReferenceEffectFocus(); referenceUnassignedOpen = false;
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    viewport.selectReferenceEffectInstances([]);
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    store.selectedRail = index; store.selectedNode = node;
    render();
    return true;
  }

  function focusParticle(sourceKind: 'authored' | 'reference', key: string | number): void {
    if (!viewport.focusParticleVolume(sourceKind, key)) toast('Could not frame this fog volume.', 'err');
  }

  function selectParticleVolume(sourceKind: 'authored' | 'reference', index: number, id?: string): boolean {
    if (!active || store.currentMode !== 'effects') return false;
    viewport.stopReferenceEffectPreview();
    dropSplineSelection();
    selection = null; selectedAuthoredPropIds = []; selectedAuthoredPropId = null; authoredUnassignedOpen = false;
    referenceFocus = emptyReferenceEffectFocus(); referenceUnassignedOpen = false;
    viewport.selectReferenceEffectInstances([]);
    if (sourceKind === 'authored') {
      const volume = (id ? volumes().find(item => item.id === id) : null) ?? volumes()[index];
      if (!volume) return false;
      source = 'mountain'; selectedAuthoredParticleId = volume.id; selectedReferenceParticleIndex = null;
      viewport.selectAuthoredParticleVolume(volume.id); viewport.selectReferenceParticleVolume(null);
    } else {
      if (referenceState.status !== 'ready' || !(referenceState.data.particleVolumes ?? [])[index]) return false;
      source = 'reference'; selectedReferenceParticleIndex = index; selectedAuthoredParticleId = null;
      viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(index);
    }
    render();
    return true;
  }

  function addFogVolume(): void {
    const list = volumes();
    const start = store.mdoc.course.knots[0]?.pos ?? [0, 0, 0];
    const volume = createFogVolume([start[0], start[1] + 12, start[2]], list);
    list.push(volume);
    selectParticleVolume('authored', list.length - 1, volume.id);
    dirty();
  }

  function addEffectTrigger(): void {
    const list = props();
    const start = store.mdoc.course.knots[0]?.pos ?? [0, 0, 0];
    const ordinal = list.filter(isEffectTriggerProp).length + 1;
    const id = nextPlacedPropId(list, 'trigger');
    const prop: PlacedProp = {
      id,
      level: EFFECT_TRIGGER_LEVEL,
      model: 0,
      name: `Trigger ${ordinal}`,
      pos: [start[0], start[1] + DEFAULT_EFFECT_TRIGGER_SIZE[1] / 2, start[2]],
      yaw: 0,
      scale: 1,
      effectTrigger: { size: [...DEFAULT_EFFECT_TRIGGER_SIZE] },
      nativeCollision: effectTriggerCollisionProfile(),
    };
    list.push(prop);
    const doc = ensureDocument();
    selection = addEffectTemplateToProp(doc, id, 'collision-trigger');
    source = 'mountain';
    selectedAuthoredPropIds = [id]; selectedAuthoredPropId = id; attachmentPropId = id;
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null; authoredUnassignedOpen = false;
    referenceFocus = emptyReferenceEffectFocus(); referenceUnassignedOpen = false;
    store.selectedProp = list.length - 1; store.multiSel = []; store.gizmoMode = 'move';
    viewport.setGizmoMode('move');
    dirty();
    toast('Trigger added with an empty collision effect — move or resize the purple box, then add its effect nodes.', 'ok');
  }

  function removeSelectedEffectTrigger(): boolean {
    if (!selectedAuthoredPropId) return false;
    const list = props(), index = list.findIndex(prop => prop.id === selectedAuthoredPropId);
    const prop = list[index];
    if (index < 0 || !isEffectTriggerProp(prop)) return false;
    if (!confirm(`Delete ${prop.name}?`)) return true;
    const doc = document();
    const attachment = doc ? effectAttachments(doc).find(item => item.target.id === prop.id) : null;
    if (doc && attachment) {
      detachEffectFromProp(doc, prop.id!);
      // Add Trigger creates a private slot. Remove it and any now-unreferenced graphs with the box, while
      // preserving a deliberately shared slot if another authored prop was attached to it later.
      if (!effectAttachments(doc).some(item => item.slot === attachment.slot)) {
        const slot = doc.slots.find(item => item.id === attachment.slot);
        const graphIds = new Set(Object.values(slot?.circumstances ?? {}).filter((id): id is string => !!id));
        doc.slots = doc.slots.filter(item => item.id !== attachment.slot);
        for (const graphId of graphIds) {
          const stillUsed = doc.slots.some(item => Object.values(item.circumstances).includes(graphId));
          if (!stillUsed) deleteEffectOwner(doc, { ownerKind: 'graph', ownerId: graphId });
        }
      }
    }
    list.splice(index, 1);
    selectedAuthoredPropIds = []; selectedAuthoredPropId = null; selection = null;
    store.selectedProp = null; store.multiSel = [];
    dirty();
    return true;
  }

  function addMotionPath(): void {
    const paths = (store.mdoc.rails ??= []);
    const ordinal = paths.filter(isMotionPath).length + 1;
    paths.push({ id: nextMotionPathId(paths), kind: 'motion', name: `Motion path ${ordinal}`,
      nodes: [], height: 1.5 });
    beginDrawing(paths.length - 1);
    toast('click the mountain to add motion-path points — Enter / Esc to finish', 'info');
  }

  /**
   * Draw a grind rail that ships as its spline alone, with no tube of its own.
   *
   * This is the shape retail's rails actually have: the curve the rail query finds and the model beside it
   * are two unrelated records (docs/014), and every original rail is a curve laid over art that was going to
   * be there anyway. Props mode's **Add rail pipe** makes both at once, which is the convenience; this makes
   * the half that matters, so a grind can follow a fallen trunk, a handrail model or a roof lip you have
   * already placed. It is here because a spline with nothing drawn on it is only visible in this mode's guide
   * layer, and because switching one on is what most of them are drawn for.
   */
  function addRailSpline(): void {
    const rails = (store.mdoc.rails ??= []);
    const ordinal = rails.filter(rail => !isMotionPath(rail)).length + 1;
    rails.push({ id: nextRailId(rails), kind: 'grind', name: `Rail spline ${ordinal}`, nodes: [],
      height: 1.5, style: RAIL_STYLE_METAL, bare: true });
    beginDrawing(rails.length - 1);
    toast('click along the shape you want to grind — Enter / Esc to finish', 'info');
  }

  /** Arm the point-chain gesture on a freshly added spline and select it, so its panel is already open. */
  function beginDrawing(index: number): void {
    store.selectedRail = index; store.selectedNode = null; store.railDrawing = true;
    viewport.setRailArmed(true);
    selectCourseSpline(index);
    dirty();
  }

  function finishDrawnSpline(): void {
    const selected = selectedDrawableSpline();
    if (!selected) return;
    const noun = splineNoun(selected.rail);
    store.railDrawing = false; viewport.setRailArmed(false);
    if (selected.rail.nodes.length < 2) {
      store.mdoc.rails!.splice(selected.index, 1);
      store.selectedRail = null; store.selectedNode = null;
      toast(`${noun} needs at least two points — discarded`, 'warn');
    } else toast(`${noun} finished`, 'ok');
    dirty();
  }

  function resumeDrawnSpline(): void {
    if (!selectedDrawableSpline()) return;
    store.selectedNode = null; store.railDrawing = true;
    viewport.setRailArmed(true);
    dirty();
    toast('click the mountain to add more points — Enter / Esc to finish', 'info');
  }

  function removeSelectedDrawnSpline(): void {
    const selected = selectedDrawableSpline();
    if (!selected || !confirm(`Delete ${selected.rail.name || `this ${splineNoun(selected.rail)}`}?`)) return;
    store.mdoc.rails!.splice(selected.index, 1);
    store.selectedRail = null; store.selectedNode = null; store.railDrawing = false;
    viewport.setRailArmed(false);
    dirty();
  }

  function removeSelectedDrawnSplineNode(): void {
    const selected = selectedDrawableSpline(), node = store.selectedNode;
    if (!selected || node === null || !selected.rail.nodes[node]) return;
    selected.rail.nodes.splice(node, 1); store.selectedNode = null;
    if (selected.rail.nodes.length < 2 && !store.railDrawing) {
      store.mdoc.rails!.splice(selected.index, 1); store.selectedRail = null;
      toast(`${splineNoun(selected.rail)} needs at least two points — removed`, 'warn');
    }
    dirty();
  }

  function copyReferenceParticle(index: number): void {
    if (referenceState.status !== 'ready') return;
    const sourceVolume = (referenceState.data.particleVolumes ?? [])[index];
    if (!sourceVolume) return;
    const list = volumes();
    const volume = cloneParticleVolume(sourceVolume, list);
    // The level it came from is its sprite donor: an export stages that extraction's copy of the shared
    // particle art, so the fog ships the bytes it was authored against rather than an arbitrary library hit.
    volume.donor = referenceState.data.level;
    list.push(volume);
    selectParticleVolume('authored', list.length - 1, volume.id);
    dirty();
    toast('Fog copied onto your mountain at the same map position.', 'ok');
  }

  function duplicateSelectedParticle(): void {
    if (!selectedAuthoredParticleId) return;
    const list = volumes(), sourceVolume = list.find(item => item.id === selectedAuthoredParticleId);
    if (!sourceVolume) return;
    const copy = cloneParticleVolume(sourceVolume, list);
    copy.pos = [copy.pos[0] + 5, copy.pos[1], copy.pos[2]];
    list.push(copy);
    selectedAuthoredParticleId = copy.id;
    viewport.selectAuthoredParticleVolume(copy.id);
    dirty();
  }

  function removeSelectedParticle(): void {
    if (!selectedAuthoredParticleId) return;
    const list = volumes(), index = list.findIndex(item => item.id === selectedAuthoredParticleId);
    if (index < 0) return;
    if (!confirm(`Delete fog volume ${list[index].name}?`)) return;
    list.splice(index, 1); selectedAuthoredParticleId = null;
    viewport.selectAuthoredParticleVolume(null);
    dirty();
  }

  function effectTreeActionMenu(doc: EffectsDocument,
    binding: { circumstance: EffectCircumstance; graph: EffectGraph }): HTMLButtonElement {
    const target: EffectSelection = { ownerKind: 'graph', ownerId: binding.graph.id };
    const index = doc.graphs.indexOf(binding.graph);
    return treeActionMenu('Effect actions', 'effect', [
      { label: 'Move up', desc: 'Move this effect earlier in the list.', disabled: index <= 0,
        onClick: () => { selection = target; if (moveEffectOwner(doc, target, -1)) dirty(); } },
      { label: 'Move down', desc: 'Move this effect later in the list.', disabled: index < 0 || index >= doc.graphs.length - 1,
        onClick: () => { selection = target; if (moveEffectOwner(doc, target, 1)) dirty(); } },
      { label: 'Copy effect', desc: 'Duplicate this effect with fresh stable IDs.', onClick: () => {
        selection = duplicateEffectOwner(doc, target) ?? target;
        dirty();
      } },
      { label: 'Delete effect', desc: 'Delete this effect and clear references to it.', onClick: () => {
        if (!confirm(`Delete ${effectGraphDisplayName(binding.graph, binding.circumstance)}?`)) return;
        if (deleteEffectOwner(doc, target)) { selection = null; dirty(); }
      } },
    ]);
  }

  function nodeTreeActionMenu(doc: EffectsDocument, binding: { graph: EffectGraph },
    node: EffectNode): HTMLButtonElement {
    const target: EffectSelection = { ownerKind: 'graph', ownerId: binding.graph.id, nodeId: node.id };
    const index = binding.graph.nodes.indexOf(node);
    return treeActionMenu('Node actions', 'node', [
      { label: 'Move up', desc: 'Move this node earlier in execution order.', disabled: index <= 0,
        onClick: () => { selection = target; if (moveEffectNode(doc, target, -1)) dirty(); } },
      { label: 'Move down', desc: 'Move this node later in execution order.',
        disabled: index < 0 || index >= binding.graph.nodes.length - 1,
        onClick: () => { selection = target; if (moveEffectNode(doc, target, 1)) dirty(); } },
      { label: 'Copy node', desc: 'Duplicate this node with a fresh stable ID.', onClick: () => {
        selection = duplicateEffectNode(doc, target) ?? target;
        dirty();
      } },
      { label: 'Delete node', desc: 'Delete this node from the effect.', onClick: () => {
        selection = deleteEffectNode(doc, target) ?? target;
        dirty();
      } },
    ]);
  }

  function openUnassigned(which: 'mountain' | 'reference'): void {
    viewport.stopReferenceEffectPreview();
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    if (which === 'mountain') {
      source = 'mountain';
      authoredUnassignedOpen = true;
      selection = null;
      selectedAuthoredPropIds = [];
      selectedAuthoredPropId = null;
      referenceUnassignedOpen = false;
      referenceFocus = emptyReferenceEffectFocus();
      viewport.selectReferenceEffectInstances([]);
    } else {
      source = 'reference';
      referenceUnassignedOpen = true;
      referenceFocus = emptyReferenceEffectFocus();
      authoredUnassignedOpen = false;
      selection = null;
      selectedAuthoredPropIds = [];
      selectedAuthoredPropId = null;
      viewport.selectReferenceEffectInstances([]);
    }
    render();
  }

  function unassignedButton(which: 'mountain' | 'reference', count: number): HTMLElement {
    const actions = el('div', 'sp-fx-actions sp-fx-unassigned-action');
    actions.appendChild(button(`Unassigned · ${count}`,
      'Effects that are not on a prop, plus the shared effects any prop can call.', () => openUnassigned(which)));
    return actions;
  }

  function syncGizmo(): void {
    if (source === 'mountain' && active && store.currentMode === 'effects' && selectedAuthoredParticleId) {
      const volume = volumes().find(item => item.id === selectedAuthoredParticleId);
      viewport.setEffectHandle(volume?.pos ?? null);
      return;
    }
    const doc = document();
    if (source !== 'mountain' || !active || store.currentMode !== 'effects' || !doc || !selection) { viewport.setEffectHandle(null); return; }
    const node = effectNode(doc, selection);
    if (!node) { viewport.setEffectHandle(null); return; }
    const pos = emitterWorldPosition(node, selectedAttachmentProp(doc));
    viewport.setEffectHandle(pos);
  }

  /** Trigger boxes borrow the placed-prop transform anchor only while their box itself is being edited. A
   *  selected spatial emitter still owns the Effects gizmo, so a rebuild cannot steal the handle mid-drag. */
  function syncTriggerTransform(): void {
    const list = props();
    const index = selectedAuthoredPropIds.length === 1
      ? list.findIndex(prop => prop.id === selectedAuthoredPropIds[0] && isEffectTriggerProp(prop)) : -1;
    const doc = document();
    const node = doc && selection ? effectNode(doc, selection) : null;
    const spatialNodeSelected = !!(node && emitterWorldPosition(node, index >= 0 ? list[index] : undefined));
    if (source === 'mountain' && active && store.currentMode === 'effects' && index >= 0 && !spatialNodeSelected) {
      if (store.gizmoMode === 'rotate') store.gizmoMode = 'move';
      store.selectedProp = index; store.multiSel = [];
      viewport.setPlacedPropSelection(index);
      viewport.setGizmoMode(store.gizmoMode === 'scale' ? 'scale' : 'move');
      return;
    }
    if (isEffectTriggerProp(list[store.selectedProp ?? -1])) store.selectedProp = null;
    viewport.setPlacedPropSelection(null);
  }

  function selectOwner(kind: EffectOwnerKind, ownerId: string, nodeId?: string): void {
    selection = { ownerKind: kind, ownerId, ...(nodeId ? { nodeId } : {}) };
    render();
  }

  function selectAuthoredPropEffect(index: number, additive = false): boolean {
    if (!active || store.currentMode !== 'effects') return false;
    const prop = props()[index];
    if (!prop?.id) return false;
    // Prop-first authoring: ANY placed prop selects here. An unattached prop opens its Add-effect panel,
    // so effects are born on their prop instead of created loose and attached afterwards.
    const doc = ensureDocument();
    viewport.stopReferenceEffectPreview();
    dropSplineSelection();
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    source = 'mountain';
    attachmentPropId = prop.id;
    const selected = new Set(selectedAuthoredPropIds);
    if (!additive) { selected.clear(); selected.add(prop.id); }
    else if (selected.has(prop.id)) selected.delete(prop.id);
    else selected.add(prop.id);
    selectedAuthoredPropIds = [...selected];
    if (!selectedAuthoredPropIds.length) {
      selectedAuthoredPropId = null;
      selection = null;
      viewport.setEffectHandle(null);
      render();
      return true;
    }
    selectedAuthoredPropId = selectedAuthoredPropIds.length === 1 ? selectedAuthoredPropIds[0] : null;
    authoredUnassignedOpen = false;
    selection = selectedAuthoredPropId ? effectSelectionForProp(doc, selectedAuthoredPropId) : null;
    referenceUnassignedOpen = false;
    referenceFocus = emptyReferenceEffectFocus();
    viewport.selectReferenceEffectInstances([]);
    render();
    return true;
  }

  /** Follow a Run-on-another-prop edge to the graph as it runs on its receiving authored placement. */
  function openAuthoredGraphOnProp(doc: EffectsDocument, target: PlacedProp, graph: EffectGraph): void {
    if (!target.id || !doc.graphs.some(candidate => candidate.id === graph.id)) return;
    viewport.stopReferenceEffectPreview();
    dropSplineSelection();
    source = 'mountain';
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    selectedAuthoredPropIds = [target.id]; selectedAuthoredPropId = target.id; attachmentPropId = target.id;
    selection = { ownerKind: 'graph', ownerId: graph.id,
      ...(graph.nodes[0] ? { nodeId: graph.nodes[0].id } : {}) };
    authoredUnassignedOpen = false;
    referenceUnassignedOpen = false;
    referenceFocus = emptyReferenceEffectFocus();
    viewport.selectReferenceEffectInstances([]);
    render();
  }

  function addEffect(circumstance: AuthoredEffectCircumstance): void {
    const doc = ensureDocument();
    selection = addEmptyEffect(doc, circumstance);
    dirty();
  }

  function addNodePicker(doc: EffectsDocument, owner: EffectSelection,
    circumstance?: EffectCircumstance): HTMLButtonElement {
    return templatePicker('+ Add node', 'Choose a node to append to this effect.',
      EFFECT_NODE_TEMPLATES, template => {
        selection = addEffectNodeTemplate(doc, owner, template.id) ?? owner;
        // The spline the author last CLICKED, not the one selected right now: reaching the prop's Add-node
        // menu means selecting the prop, and that drops the spline selection on the way. Without the memory
        // every toggle and mover would silently bind to whichever spline happens to be first in the document.
        const selectedRailId = store.mdoc.rails?.[store.selectedRail ?? -1]?.id ?? lastSelectedSplineId;
        if (template.id === 'spline-animation')
          bindEffectSplineToMotionPath(doc, selection, store.mdoc.rails, selectedRailId);
        // Both of these are unusable until bound, so they bind on the way in rather than waiting for the
        // author to discover an empty reference: a toggle to whichever rail is selected, and a lift to an
        // altitude above the prop it was just added to.
        if (template.id === 'spline-toggle')
          bindEffectSplineToRail(doc, selection, store.mdoc.rails, selectedRailId);
        if (template.id === 'z-boost') {
          const groundY = zBoostTargetForOwner(doc, store.mdoc.props ?? [], owner.ownerId);
          if (groundY !== null) bindZBoostToPlacement(doc, selection, groundY);
        }
        // A call has nothing existing to bind to on an authored mountain, so this MAKES the body it names.
        if (template.id === 'call-function') bindEffectFunctionCall(doc, selection);
        dirty();
      }, template => nodeTemplateLabelInGraph(template, circumstance));
  }

  function duplicateOwner(): void {
    const doc = document(); if (!doc || !selection) return;
    selection = duplicateEffectOwner(doc, selection) ?? selection;
    dirty();
  }

  function shiftOwner(delta: -1 | 1): void {
    const doc = document(); if (!doc || !selection) return;
    if (moveEffectOwner(doc, selection, delta)) dirty();
  }

  function removeOwner(): void {
    const doc = document(); if (!doc || !selection) return;
    if (!confirm(`Delete ${selection.ownerId} and clear references to it?`)) return;
    if (deleteEffectOwner(doc, selection)) { selection = null; dirty(); }
  }

  function duplicateNode(): void {
    const doc = document(); if (!doc || !selection) return;
    selection = duplicateEffectNode(doc, selection) ?? selection;
    dirty();
  }

  function removeNode(): void {
    const doc = document(); if (!doc || !selection?.nodeId) return;
    selection = deleteEffectNode(doc, selection) ?? selection;
    dirty();
  }

  function shiftNode(delta: -1 | 1): void {
    const doc = document(); if (!doc || !selection) return;
    if (moveEffectNode(doc, selection, delta)) dirty();
  }

  function docHeader(doc: EffectsDocument | null): HTMLElement {
    const s = section(`${mountainName()} effects`);
    if (doc) {
      const issues = validateEffectsAuthoring(doc, props(), store.mdoc.rails ?? []);
      const errors = issues.filter(x => x.severity === 'error').length;
      s.body.appendChild(el('div', `sp-fx-summary${errors ? ' bad' : ''}`,
        `${doc.graphs.length} effects · ${doc.functions.length} shared · ${doc.graphs.reduce((n, g) => n + g.nodes.length, 0) + doc.functions.reduce((n, f) => n + f.nodes.length, 0)} nodes · ${issues.length ? `${errors} errors / ${issues.length - errors} warnings` : 'valid'}`));
      s.body.appendChild(unassignedButton('mountain', authoredUnassignedOwnerIds(doc).size));
    } else s.body.appendChild(el('div', 'sp-fx-empty', `Effects initialize with ${mountainName()}.`));
    return s.root;
  }

  function particleSummaryPanel(): HTMLElement {
    const list = volumes();
    const rails = store.mdoc.rails ?? [];
    const paths = rails.filter(isMotionPath);
    const bare = rails.filter(isBareRail);
    const triggers = props().filter(isEffectTriggerProp);
    const puffs = list.reduce((count, volume) => count
      + volume.objects.reduce((subtotal, object) => subtotal + object.puffs.length, 0), 0);
    const s = section('Effect scenery');
    s.body.append(el('div', 'sp-fx-summary', `${triggers.length} triggers · ${list.length} fog volumes · ${puffs} puffs · `
      + `${paths.length} motion paths · ${bare.length} rail splines`),
      el('div', 'sp-fx-note', 'Trigger boxes carry collision effects, and motion paths are the invisible routes '
        + 'moving props travel along. Both show purple in Effects mode, as do fog banks — everything this mode '
        + 'owns. Grind rails show red: the course owns those, and this mode only switches them into and out '
        + 'of the rail network.'));
    const actions = el('div', 'sp-fx-actions');
    actions.append(button('+ Add trigger', 'Place a movable, resizable trigger box with an empty collision effect already attached.', addEffectTrigger),
      button('+ Add fog volume', 'Place a fog bank above the course start.', addFogVolume),
      button('+ Add motion path', 'Draw a motion path for a moving prop. It is invisible and cannot be grinded.', addMotionPath),
      button('+ Add rail spline', 'Draw a grindable curve with no tube of its own — the spline alone, laid along '
        + 'a prop that already has the shape. Add rail pipe in Props view draws the tube as well.', addRailSpline));
    s.body.appendChild(actions);
    return s.root;
  }

  function motionPathPanel(): HTMLElement | null {
    const selected = selectedMotionPath();
    if (!selected) return null;
    const { path } = selected;
    const sampled = sampleRail(path.nodes, 24);
    let length = 0;
    for (let i = 1; i < sampled.length; i++) length += Math.hypot(
      sampled[i][0] - sampled[i - 1][0], sampled[i][1] - sampled[i - 1][1], sampled[i][2] - sampled[i - 1][2]);
    const s = section(`Motion path: ${path.name || path.id || 'unnamed'}`);
    s.body.append(
      row('Name', input(path.name ?? '', value => { path.name = value.trim() || undefined; dirty(); })),
      row('Stable ID', input(path.id ?? '', () => {}, { readonly: true })),
      row('Points', input(String(path.nodes.length), () => {}, { readonly: true })),
      row('Length', input(`${length.toFixed(1)} m`, () => {}, { readonly: true })),
      row('Ground offset', numberInput(path.height, value => {
        const dy = value - path.height; path.height = value;
        for (const point of path.nodes) point[1] += dy;
        dirty();
      }, '0.1'), 'Height added to terrain clicks; changing it moves the complete path vertically.'),
      el('div', 'sp-fx-note', 'Invisible in game and cannot be grinded. Spline mover effects travel along it.'),
    );
    s.body.appendChild(splineDrawActions(path));
    return s.root;
  }

  /** The point-chain actions the two splines this mode draws share: finish, extend, trim, delete. Reached
   *  only from `selectedDrawableSpline`, so the buttons always act on the curve the panel is showing. */
  function splineDrawActions(rail: Rail): HTMLElement {
    const path = isMotionPath(rail);
    const actions = el('div', 'sp-fx-actions');
    actions.appendChild(store.railDrawing
      ? button(path ? '✔ Finish path' : '✔ Finish spline', 'Stop adding points and keep this curve.',
        finishDrawnSpline)
      : button('+ Add more points', 'Resume extending this curve with terrain clicks.', resumeDrawnSpline));
    if (store.selectedNode !== null)
      actions.appendChild(button('Delete point', 'Delete the selected curve point.',
        removeSelectedDrawnSplineNode, true));
    actions.appendChild(button(path ? 'Delete path' : 'Delete spline',
      'Delete this curve and clear effect references to it.', removeSelectedDrawnSpline, true));
    return actions;
  }

  /** What a node naming this spline does with it, in the words the picker used to lay it down. */
  function splineUseLabel(use: SplineEffectUse): string {
    if (use.semanticType === 'spline.toggle') return use.switchesOn ? 'switches it on' : 'switches it off';
    if (use.semanticType === 'spline.animation') return 'travels along it';
    return use.semanticType;
  }

  /** Open the effect a rail-use row names: its host prop when it has one, the Unassigned list when it does
   *  not — the same two homes every other graph in this panel has. */
  function openSplineUse(doc: EffectsDocument, use: SplineEffectUse): void {
    viewport.stopReferenceEffectPreview();
    dropSplineSelection();
    source = 'mountain';
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    referenceFocus = emptyReferenceEffectFocus(); referenceUnassignedOpen = false;
    viewport.selectReferenceEffectInstances([]);
    selection = { ownerKind: use.ownerKind, ownerId: use.ownerId, nodeId: use.nodeId };
    const host = use.ownerKind === 'graph'
      ? authoredEffectBindings(doc, props()).find(binding => binding.graph.id === use.ownerId)?.prop : undefined;
    if (host?.id) {
      selectedAuthoredPropIds = [host.id]; selectedAuthoredPropId = host.id; attachmentPropId = host.id;
      authoredUnassignedOpen = false;
    } else {
      selectedAuthoredPropIds = []; selectedAuthoredPropId = null;
      authoredUnassignedOpen = true;
    }
    render();
  }

  /**
   * A selected GRIND rail, in the mode that switches rails rather than the one that draws them.
   *
   * The panel exists because the join runs one way only: a prop's slot names a spline, and the spline knows
   * nothing about it. Everything here is that reverse lookup made visible — which effects have an opinion
   * about this rail, and whether the rail agrees with them.
   *
   * How much else it offers turns on whether the rail carries a tube. A piped rail is course scenery drawn
   * and materialled in Props mode, so this shows exactly the one field the effect side owns — whether the
   * rail is in the network to begin with — and sends the rest there. A BARE rail has no geometry in Props
   * mode to send anyone to, so this mode keeps the whole curve: its points, its height, and its deletion.
   */
  function grindRailPanel(): HTMLElement | null {
    const selected = selectedGrindRail();
    if (!selected) return null;
    const { rail } = selected;
    const bare = isBareRail(rail);
    const doc = document();
    const uses = doc ? splineEffectUses(doc, authoredSplineId(rail)) : [];
    const style = railStyle(rail);
    const surface = surfaceFor(style);
    const sampled = sampleRail(rail.nodes, 24);
    let length = 0;
    for (let i = 1; i < sampled.length; i++) length += Math.hypot(
      sampled[i][0] - sampled[i - 1][0], sampled[i][1] - sampled[i - 1][1], sampled[i][2] - sampled[i - 1][2]);
    const s = section(`${bare ? 'Rail spline' : 'Rail'}: ${rail.name || rail.id || 'unnamed'}`);
    s.body.append(
      row('Name', input(rail.name ?? '', value => { rail.name = value.trim() || undefined; dirty(); })),
      row('Stable ID', input(rail.id ?? '', () => {}, { readonly: true }),
        'What a Rail on / off node stores, so effects keep following this rail when another one is deleted.'),
      row('Points', input(String(rail.nodes.length), () => {}, { readonly: true })),
      row('Length', input(`${length.toFixed(1)} m`, () => {}, { readonly: true })),
      // These are read-only here because the Tricks tools own the rail itself. Material is the native grind
      // surface, not paint, and Speed is that surface row's cruise-drive target rather than a per-rail override.
      row('Material', input(railMaterialLabel(style), () => {}, { readonly: true }),
        `SplineStyle ${style}. This is what the board rides, not just what the pipe looks like.`),
      row('Speed', input(`${surface.target.toFixed(1)} m/s target`, () => {}, { readonly: true }),
        `Surface ${surface.type} “${surface.name}”, drag ${surface.drag.toFixed(2)}. This is the cruise target; `
        + 'gravity can carry the rider faster.'),
      row('Shape', input(bare ? 'Bare spline' : 'Pipe', () => {}, { readonly: true }),
        bare ? 'The grind curve has no generated tube of its own.' : 'This rail also builds a visible tube.'),
    );
    if (bare) s.body.appendChild(row('Ground offset', numberInput(rail.height, value => {
      const dy = value - rail.height; rail.height = value;
      for (const point of rail.nodes) point[1] += dy;
      dirty();
    }, '0.1'), 'Height added to terrain clicks — raise it to sit the grind on top of whatever the curve '
      + 'follows. Changing it moves the complete curve vertically.'));
    s.body.appendChild(checkboxRow('Starts off (an effect switches it on)', railStartsOff(rail),
      'Ship this rail OUTSIDE the rail network and let a Rail on / off node put it in — retail\'s fallen '
      + 'trunk, grindable only once the tree has come down. It exports at the non-grind style that does '
      + `this, so ${bare ? 'the prop this curve follows is untouched and the grind' : 'the tube is drawn and '
        + 'solid exactly as authored and simply'} cannot be caught yet. `
      + 'Slopesmith\'s own test ride refuses it too, because no preview here runs the toggle.',
      value => { rail.startsOff = value || undefined; dirty(); }));
    if (uses.length) {
      const list = el('div', 'sp-fx-list');
      for (const use of uses) {
        const graphName = use.ownerKind === 'graph' ? authoredGraphDisplayName(doc!, use.ownerId) : null;
        const fn = use.ownerKind === 'function'
          ? doc?.functions.find(item => item.id === use.ownerId) : null;
        const item = el('button', 'sp-fx-list-row');
        item.type = 'button';
        item.title = 'Open the effect this node belongs to.';
        item.onclick = () => { if (doc) openSplineUse(doc, use); };
        item.append(el('span', 'sp-fx-node-index', '›'),
          el('span', 'sp-fx-list-name', graphName ?? fn?.name ?? use.ownerId),
          el('span', 'sp-fx-kind', splineUseLabel(use)));
        list.appendChild(item);
      }
      s.body.append(el('div', 'sp-fx-note', `${countLabel(uses.length, 'effect node')} names this rail.`), list);
    } else {
      s.body.appendChild(el('div', 'sp-fx-note', railStartsOff(rail)
        ? 'Nothing switches this rail on, so as it stands nobody can ever grind it. Add a Rail on / off node '
          + 'to the prop that should enable it — the break chain of a tree, or a trigger the rider crosses.'
        : 'No effect names this rail; it is simply grindable from the moment the level loads. Rail on / off '
          + 'and Spline mover nodes, added from a prop\'s own effect panel, bind to whichever rail is selected.'));
    }
    // The one spline→prop join the data has: a graph that names this curve AND aims a Run-on-another-prop
    // node at a placement has said the two are one rail. Nothing else pairs them, so nothing else offers to.
    const paired = doc ? splinePairedProps(doc, props(), authoredSplineId(rail)) : [];
    if (paired.length) {
      const actions = el('div', 'sp-fx-actions');
      for (const { prop } of paired) {
        const index = props().indexOf(prop);
        if (index < 0) continue;
        actions.appendChild(button(`▸ Go to ${prop.name}`,
          `Open ${prop.name} in Props view. The effect that switches this rail also acts on it, which is the `
          + 'only thing in the data that pairs a curve with a model.', () => goToProp({ propIndex: index })));
      }
      if (actions.children.length) s.body.append(el('div', 'sp-fx-note',
        `${countLabel(paired.length, 'prop')} ${paired.length === 1 ? 'is' : 'are'} acted on by the same `
        + 'effect that names this rail.'), actions);
    }
    s.body.appendChild(el('div', 'sp-fx-note', bare
      ? 'No tube of its own: this is the grind curve alone, and the shape a rider sees is whatever it was '
        + 'laid along. Its material and a tube of its own are in the Tricks tools in Props view.'
      : 'Points, height, material and support posts belong to the Tricks tools in Props view.'));
    // A rail IS its own prop — the tube it bakes is the thing you see — so "go to the Tricks tools" needs to
    // be a button rather than a sentence. Everything above sends the author to Props view; nothing took them.
    const toTricks = el('div', 'sp-fx-actions');
    toTricks.appendChild(button('▸ Edit in Props view',
      bare ? 'Open this spline in the Tricks tools, still selected — its material, and the rail pipe checkbox '
        + 'that gives it a tube.'
        : 'Open this rail in the Tricks tools, still selected — its points, height, material, solid tube and '
          + 'support posts.',
      () => deps.goToRail(selected.index)));
    s.body.appendChild(toTricks);
    if (bare) s.body.appendChild(splineDrawActions(rail));
    return s.root;
  }

  /**
   * A shipped level's grind curve, clicked on the reference map.
   *
   * There is nothing to edit here and nothing to select but the curve itself: a reference rail exists ONLY as
   * this `Splines.json` row, and the tube a rider sees is an ordinary instance joined to nothing (docs/014).
   * So the panel answers the two questions the row can actually answer — what switches it, and which prop its
   * own effect also acts on, which is the one place the level says a curve and a model are the same rail.
   */
  function referenceRailSplinePanel(data: ReferenceEffectsData, originalIndex: number): HTMLElement | null {
    const uses = referenceSplineEffectUses(data, originalIndex);
    const nativeRow = viewport.referenceSplineRow(originalIndex);
    const paired = referenceSplinePairedInstances(data, originalIndex,
      nativeRow ? nativeRow.segments.flat() : null);
    const s = section(`${data.level} rail spline #${originalIndex}`);
    s.body.append(
      row('Native row', input(`Splines.json #${originalIndex}`, () => {}, { readonly: true }),
        'The stable table index a Rail on / off node stores — what the curve IS on disc.'),
      row('Named by', input(countLabel(uses.length, 'effect node'), () => {}, { readonly: true })),
    );
    // The same material + speed properties an authored rail gets, off the shipped row's own SplineStyle. No pipe
    // vocabulary here: on a retail level EVERY curve is bare in Slopesmith's sense, since the tube beside it
    // is an unjoined prop instance — so the only thing to report is what the board would ride.
    if (nativeRow) {
      const surface = surfaceFor(nativeRow.style);
      s.body.append(
        row('Material', input(railMaterialLabel(nativeRow.style), () => {}, { readonly: true }),
          `SplineStyle ${nativeRow.style}. This is what the board rides, not what any tube along it looks like.`),
        row('Speed', input(`${surface.target.toFixed(1)} m/s target`, () => {}, { readonly: true }),
          `Surface ${surface.type} “${surface.name}”, drag ${surface.drag.toFixed(2)}. This is the cruise target; `
          + 'gravity can carry the rider faster.'));
    }
    if (uses.length) {
      const list = el('div', 'sp-fx-list');
      for (const use of uses) {
        const owner = use.ownerKind === 'graph'
          ? data.document.graphs.find(item => item.id === use.ownerId)
          : data.document.functions.find(item => item.id === use.ownerId);
        const item = el('button', 'sp-fx-list-row');
        item.type = 'button';
        item.title = 'Open the effect this node belongs to.';
        item.onclick = () => openReferenceSplineUse(data, use);
        item.append(el('span', 'sp-fx-node-index', '›'),
          el('span', 'sp-fx-list-name', owner?.name ?? use.ownerId),
          el('span', 'sp-fx-kind', referenceNodeDisplayName(data, use.node)));
        list.appendChild(item);
      }
      s.body.appendChild(list);
    }
    if (paired.length) {
      const actions = el('div', 'sp-fx-actions');
      // A retail graph is often a BULK switch — GARI's HideShowOff toggles 66 splines and hides ~100 tubes in
      // one function, since nothing joins a curve to its model and the level must therefore name all of both.
      // Nearest-first (core ranks them), and only the near end is offered: a hundred buttons would say less.
      for (const { instance } of paired.slice(0, PAIRED_PROP_LIMIT))
        actions.appendChild(button(`▸ Go to ${instance.name}`,
          `Select ${instance.name} (#${instance.index}) on the reference map. The effect that switches this `
          + 'rail also acts on that instance, which is the only thing on disc pairing a curve with a model.',
          () => {
            selectedReferenceSplineIndex = null;
            viewport.selectReferenceRailSpline(null);
            selectReferencePropEffect(instance.index);
          }));
      s.body.append(el('div', 'sp-fx-note', paired.length > PAIRED_PROP_LIMIT
        ? `The effect naming this rail acts on ${countLabel(paired.length, 'prop')} — a bulk switch over the `
          + `level's whole rail network, so it cannot say which tube is THIS curve's. The ${PAIRED_PROP_LIMIT} `
          + 'nearest to the curve are offered.'
        : `${countLabel(paired.length, 'prop')} ${paired.length === 1 ? 'is' : 'are'} acted on by the same `
          + 'effect that names this rail — the pair that makes it a rail rather than a curve and a tube.'),
      actions);
    } else s.body.appendChild(el('div', 'sp-fx-note', uses.length
      ? 'No effect here also acts on a prop, so nothing on disc says which model this curve runs along.'
      : 'No effect names this curve: it is simply grindable from the moment the level loads, and nothing '
        + 'pairs it with a model — a spline and the tube over it are unrelated records.'));
    return s.root;
  }

  /** Open the reference effect a rail-use row names, leaving the spline selection behind. */
  function openReferenceSplineUse(data: ReferenceEffectsData, use: ReferenceSplineUse): void {
    selectedReferenceSplineIndex = null;
    viewport.selectReferenceRailSpline(null);
    const host = attachedReferenceInstances(data).find(instance =>
      referenceInstanceBindings(data, instance).some(binding => binding.graph.id === use.ownerId));
    if (host) selectReferencePropEffect(host.index);
    else { referenceUnassignedOpen = true; referenceFocus = emptyReferenceEffectFocus(); render(); }
  }

  /** A shipped grind curve was clicked on the reference map (viewport `onSelectReferenceSpline`). */
  function selectReferenceSpline(originalIndex: number): boolean {
    if (!active || store.currentMode !== 'effects' || referenceState.status !== 'ready') return false;
    viewport.stopReferenceEffectPreview();
    dropSplineSelection();
    source = 'reference';
    selection = null; selectedAuthoredPropIds = []; selectedAuthoredPropId = null; authoredUnassignedOpen = false;
    referenceFocus = emptyReferenceEffectFocus(); referenceUnassignedOpen = false;
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    selectedReferenceSplineIndex = originalIndex;
    viewport.selectReferenceRailSpline(originalIndex);
    viewport.selectReferenceEffectInstances([]);
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    render();
    return true;
  }

  function authoredParticlePanel(): HTMLElement | null {
    const volume = selectedAuthoredParticleId
      ? volumes().find(item => item.id === selectedAuthoredParticleId) : null;
    if (!volume) return null;
    const puffCount = volume.objects.reduce((count, object) => count + object.puffs.length, 0);
    const s = section(`Fog: ${volume.name}`);
    s.body.append(
      row('Name', input(volume.name, value => {
        const next = value.trim();
        if (!next) return;
        if (volumes().some(item => item !== volume && item.name.toLowerCase() === next.toLowerCase())) {
          toast('Fog names must be unique.', 'err'); return;
        }
        volume.name = next; dirty();
      })),
      row('ID', input(volume.id, () => {}, { readonly: true })),
      row('Puffs', input(String(puffCount), () => {}, { readonly: true })),
      row('X', numberInput(volume.pos[0], value => { volume.pos[0] = value; dirty(); })),
      row('Y', numberInput(volume.pos[1], value => { volume.pos[1] = value; dirty(); })),
      row('Z', numberInput(volume.pos[2], value => { volume.pos[2] = value; dirty(); })),
      row('Scale X', numberInput(volume.scale[0], value => { volume.scale[0] = value; volume.boundsOffsetMin = [NaN, NaN, NaN]; volume.boundsOffsetMax = [NaN, NaN, NaN]; dirty(); })),
      row('Scale Y', numberInput(volume.scale[1], value => { volume.scale[1] = value; volume.boundsOffsetMin = [NaN, NaN, NaN]; volume.boundsOffsetMax = [NaN, NaN, NaN]; dirty(); })),
      row('Scale Z', numberInput(volume.scale[2], value => { volume.scale[2] = value; volume.boundsOffsetMin = [NaN, NaN, NaN]; volume.boundsOffsetMax = [NaN, NaN, NaN]; dirty(); })),
      row('Rotation', input(volume.nativeRotation.join(', '), () => {}, { readonly: true }),
        'Stored rotation, kept as-is. Editing it here is not supported yet.'),
    );
    const actions = el('div', 'sp-fx-actions');
    actions.append(button('Focus fog', 'Frame this fog volume.', () => focusParticle('authored', volume.id)),
      button('Duplicate', 'Duplicate this fog bank and offset it five metres.', duplicateSelectedParticle),
      button('Delete', 'Delete this fog volume.', removeSelectedParticle, true));
    s.body.appendChild(actions);
    return s.root;
  }

  function referenceParticlePanel(data: ReferenceEffectsData): HTMLElement | null {
    if (selectedReferenceParticleIndex === null) return null;
    const volume = (data.particleVolumes ?? [])[selectedReferenceParticleIndex];
    if (!volume) return null;
    const puffCount = volume.objects.reduce((count, object) => count + object.puffs.length, 0);
    const s = section(`Fog: ${volume.name} · read only`);
    s.body.append(
      row('Name', input(volume.name, () => {}, { readonly: true })),
      row('Prop number', input(`#${selectedReferenceParticleIndex}`, () => {}, { readonly: true })),
      row('Puffs', input(String(puffCount), () => {}, { readonly: true })),
      row('Position', input(volume.pos.join(', '), () => {}, { readonly: true })),
      row('Scale', input(volume.scale.join(', '), () => {}, { readonly: true })),
      row('Rotation', input(volume.nativeRotation.join(', '), () => {}, { readonly: true })),
    );
    const actions = el('div', 'sp-fx-actions');
    actions.append(button('Focus fog', 'Frame this reference fog volume.', () => focusParticle('reference', selectedReferenceParticleIndex!)),
      button(`Copy to ${mountainName()}`, `Copy this fog bank onto ${mountainName()} at the same map position.`,
        () => copyReferenceParticle(selectedReferenceParticleIndex!)));
    s.body.appendChild(actions);
    return s.root;
  }

  function ownerList(doc: EffectsDocument, view: EffectsPanelView, title = 'Unattached & shared effects'): HTMLElement {
    const s = section(title);
    if (!view.readOnly) {
      const create = el('div', 'sp-fx-create');
      create.appendChild(templatePicker('+ Add effect', 'Choose when the new effect should run.',
        EFFECT_TYPES, type => addEffect(type.circumstance)));
      const addFunction = button('+ Function', 'Add an empty named function node-list.', () => {
        selection = addEffectFunction(doc); dirty();
      });
      s.body.append(create, addFunction);
    }
    const find = input(view.search, value => { view.setSearch(value.toLowerCase()); render(); });
    find.placeholder = 'Filter effects…'; find.classList.add('sp-fx-search'); s.body.appendChild(find);
    const list = el('div', 'sp-fx-list');
    const owners: { kind: EffectOwnerKind; id: string; name?: string; nodes: EffectNode[] }[] = [
      ...doc.graphs.map(x => ({ kind: 'graph' as const, ...x })),
      ...doc.functions.map(x => ({ kind: 'function' as const, ...x })),
    ];
    for (const owner of owners.filter(x => (!view.visibleOwnerIds || view.visibleOwnerIds.has(x.id))
      && (!view.search
        || `${x.id} ${x.name ?? ''} ${view.ownerLabel(x.kind, x.id, x.name || x.id)}`.toLowerCase().includes(view.search)))) {
      const active = view.selection?.ownerKind === owner.kind && view.selection.ownerId === owner.id;
      const label = view.ownerLabel(owner.kind, owner.id, owner.name || owner.id);
      const item = el('button', `sp-fx-list-row${active ? ' on' : ''}`);
      item.type = 'button'; item.onclick = () => view.selectOwner(owner.kind, owner.id, owner.nodes[0]?.id);
      item.append(el('span', 'sp-fx-kind', owner.kind === 'graph' ? 'G' : 'F'),
        el('span', 'sp-fx-list-name', label), el('span', 'sp-fx-count', String(owner.nodes.length)));
      list.appendChild(item);
    }
    if (!list.childElementCount) list.appendChild(el('div', 'sp-fx-empty', 'No matching effects.'));
    s.body.appendChild(list); return s.root;
  }

  function selectedOwnerPanel(doc: EffectsDocument, view: EffectsPanelView, showNodeList = true): HTMLElement | null {
    const current = view.selection;
    if (!current) return null;
    const owner = effectOwner(doc, current); if (!owner) return null;
    const storedName = owner.name ?? owner.id;
    const displayName = view.ownerLabel(current.ownerKind, owner.id, storedName);
    const graphCircumstances = current.ownerKind === 'graph'
      ? [...new Set(graphSlots(doc, current.ownerId).map(binding => binding.circumstance))] : [];
    const graphCircumstance = graphCircumstances.length === 1 ? graphCircumstances[0] : undefined;
    const s = section(`Selected ${current.ownerKind === 'function' ? 'function' : 'effect'}: ${displayName}`);
    s.root.classList.add('sp-fx-child-panel');
    const name = input(owner.name ?? '', value => { owner.name = value; dirty(); }, { readonly: view.readOnly });
    if (displayName !== storedName) {
      s.body.append(row('Effect name', input(displayName, () => {}, { readonly: true })),
        row(view.readOnly ? 'Source name' : 'Effect name', name));
    } else s.body.append(row('Name', name));
    s.body.append(row('Stable ID', input(owner.id, () => {}, { readonly: true })));
    if (!view.readOnly) {
      if (showNodeList) {
        const ownerActions = el('div', 'sp-fx-actions sp-fx-icon-actions');
        ownerActions.append(iconButton(ACTION_ICON.up, 'Move earlier', 'Move this effect earlier in the list.', () => shiftOwner(-1)),
          iconButton(ACTION_ICON.down, 'Move later', 'Move this effect later in the list.', () => shiftOwner(1)),
          iconButton(ACTION_ICON.duplicate, 'Duplicate', 'Duplicate this node-list with fresh stable IDs.', duplicateOwner),
          iconButton(ACTION_ICON.delete, 'Delete', 'Delete this node-list and clear references to it.', removeOwner, true));
        s.body.appendChild(ownerActions);
      }
      if (current.ownerKind === 'graph') {
        const prop = selectedAttachmentProp(doc);
        if (prop?.id) {
          const previewActions = el('div', 'sp-fx-actions');
          previewActions.append(
            button('▶ Preview effect', 'Run this effect on its prop in the viewport.', () => {
              const loop = effectGraphHasTimerEmitter(doc, owner as EffectGraph);
              if (!viewport.previewAuthoredEffect(prop.id!, owner.id, loop))
                toast('This effect could not be previewed on the selected prop.', 'err');
            }),
            button('■ Stop', 'Stop the current effect preview and restore the prop.', () => {
              viewport.stopReferenceEffectPreview();
            }),
          );
          s.body.appendChild(previewActions);
        }
      }
      if (graphCircumstance && isEffectLatchCircumstance(graphCircumstance))
        s.body.appendChild(el('div', 'sp-fx-note', `${EFFECT_LATCH_SUMMARY[graphCircumstance]} `
          + 'Leave this one empty. Nodes here would run instead of the reset, which is untested ground.'));
      else if (graphCircumstance) s.body.appendChild(el('div', 'sp-fx-note',
        `Every node here runs when this effect does — ${effectCircumstanceLabel(graphCircumstance)}. `
        + 'To have something run at a different moment, use + Add effect on the prop.'));
    }
    if (showNodeList) {
      const nodes = el('div', 'sp-fx-node-list');
      if (owner.nodes.length) nodes.appendChild(el('div', 'sp-fx-tree-caption', 'Nodes'));
      owner.nodes.forEach((node, index) => {
        const active = node.id === current.nodeId;
        const item = el('button', `sp-fx-node-row${active ? ' on' : ''}`);
        item.type = 'button'; item.onclick = () => view.selectOwner(current.ownerKind, owner.id, node.id);
        item.append(el('span', 'sp-fx-node-index', String(index + 1)),
          el('span', 'sp-fx-node-name', view.nodeLabel?.(node)
            ?? (graphCircumstance ? nodeDisplayNameInGraph(node, graphCircumstance) : nodeDisplayName(node))),
          el('span', 'sp-fx-kind', `M${node.mainType}`));
        nodes.appendChild(item);
      });
      if (!owner.nodes.length) nodes.appendChild(el('div', 'sp-fx-empty', 'This effect has no nodes yet.'));
      if (!view.readOnly) {
        const create = el('div', 'sp-fx-node-add');
        create.appendChild(addNodePicker(doc, current, graphCircumstance));
        nodes.appendChild(create);
      }
      s.body.appendChild(nodes);
    }
    if (!view.readOnly && showNodeList && current.nodeId) {
      const nodeActions = el('div', 'sp-fx-actions sp-fx-icon-actions');
      nodeActions.append(iconButton(ACTION_ICON.up, 'Move node earlier', 'Move this node earlier. Nodes run top to bottom.', () => shiftNode(-1)),
        iconButton(ACTION_ICON.down, 'Move node later', 'Move this node later. Nodes run top to bottom.', () => shiftNode(1)),
        iconButton(ACTION_ICON.duplicate, 'Duplicate node', 'Copy this node with a fresh stable ID.', duplicateNode),
        iconButton(ACTION_ICON.delete, 'Delete node', 'Delete this node.', removeNode, true));
      s.body.appendChild(nodeActions);
    }
    return s.root;
  }

  function mutateNode(node: EffectNode, action: () => void, rebuild = false): void {
    action(); dirty(rebuild); if (!rebuild) syncGizmo();
  }

  /**
   * What this node IS, above its fields — the same knowledge the add-node picker shows, on the node once it
   * exists.
   *
   * It is in two tiers for the same reason the picker is. The one-line summary is what someone needs every
   * time they open a node, so it is always there; the caveats and the hardware record are what they need
   * ONCE, when something is not behaving, so they fold away. Rendering both inline was the old behaviour and
   * it pushed the actual controls off the bottom of the panel behind a paragraph nobody rereads.
   *
   * The hardware record stays separate from the usage prose rather than being merged into it, because it is a
   * different kind of claim: the summary says what the node is for, and this says what a PS2 was seen to do,
   * with the cell and the run to go and re-ride. Several prove a node RUNS without proving it does its job.
   */
  function addNodeDetail(body: HTMLElement, node: EffectNode): void {
    const detail = effectNodeDetail(node);
    if (detail.blocked) {
      body.appendChild(el('div', 'sp-fx-note warn',
        `This node cannot be added yet: ${detail.blocked} An existing one still reads and exports correctly, `
        + 'and Raw shows every field.'));
      return;
    }
    if (detail.summary) body.appendChild(el('div', 'sp-fx-note', detail.summary));
    if (detail.validated) body.appendChild(el('div', 'sp-fx-valid', 'Validated on PS2 hardware.'));
    if (!detail.detail && !detail.validated) return;

    const more = el('details', 'sp-fx-more');
    more.appendChild(el('summary', '', detail.detail ? 'How to use this' : 'What was tested'));
    if (detail.detail) more.appendChild(el('div', 'sp-fx-more-body', detail.detail));
    if (detail.validated) {
      const proof = el('div', 'sp-fx-more-body proof', detail.validated.observed);
      proof.appendChild(el('div', 'sp-fx-provenance',
        `Auto-test cell ${detail.validated.cell} · ${detail.validated.run}`));
      more.appendChild(proof);
    }
    body.appendChild(more);
  }

  /**
   * A Counter's authored Count says what it needs; only the running count says what it HAS. Without this the
   * only way to tell "never installed" from "installed and counting" from "already fired" was to guess from
   * whether the trigger effect happened — which is exactly the diagnosis that is hard when it does not.
   *
   * Polled rather than pushed: the toolbox rebuilds on edits, not on ride ticks, and one text node a few
   * times a second beats wiring a runtime subscription through the panel's lifecycle. It stops itself when
   * the row leaves the DOM, so a rebuilt panel does not leave a timer behind.
   */
  function counterLivePanel(node: EffectNode): HTMLElement | null {
    const count = effectCounterInstall(node);
    if (count === null) return null;
    const readCounter = (): { remaining: number; marked: number[] } | null => {
      if (source === 'reference') {
        const index = referenceFocus.activeInstanceIndex;
        return index === null ? null : viewport.referencePlayCounter(index);
      }
      return selectedAuthoredPropId ? viewport.authoredPlayCounter(selectedAuthoredPropId) : null;
    };
    const wrap = el('div', 'sp-fx-note sp-fx-counter-live');
    const paint = (): void => {
      const state = readCounter();
      if (state) {
        const done = count - state.remaining;
        wrap.textContent = `Counting: ${done} of ${count} in`
          + `${state.marked.length ? ` · inputs marked ${state.marked.join(', ')}` : ''}`
          + `${state.remaining === 0 ? ' · finished' : ` · ${countLabel(state.remaining, 'input')} to go`}`;
      } else if (!viewport.isEffectPlayRunning()) {
        wrap.textContent = `Not counting — Play is not running. Ride the course to watch this Counter fill.`;
      } else {
        // The counter is spent and retired, or was never installed. Both read as absent, and saying so beats
        // showing a full count that nothing is actually maintaining.
        wrap.textContent = 'Not counting — no live Counter on this prop: it has either already fired its '
          + 'Trigger effect and retired, or its persistent effect never installed one.';
      }
    };
    paint();
    const timer = window.setInterval(() => {
      if (!wrap.isConnected) { window.clearInterval(timer); return; }
      paint();
    }, 250);
    return wrap;
  }

  function addKnownSemanticFields(body: HTMLElement, node: EffectNode, readOnly: boolean): void {
    const inspector = semanticInspectorForNode(node);
    // Collision-emitter fields are a decoded view over raw f32 words, not the stored object itself. Rebuild
    // after a write so the rich editor and any later colour/vector edit see the newly decoded snapshot.
    const rebuildDecodedEmitter = node.semanticType === 'particle.collision';
    let shown = 0;
    for (const spec of inspector.fields) {
      const value = semanticNumberValue(node, spec);
      if (value === null) continue;
      const named = spec.options?.find(option => option.value === Math.trunc(value));
      let control: HTMLElement;
      if (readOnly) {
        control = input(named?.label ?? (spec.options ? `Unnamed value (${Math.trunc(value)})` : String(value)),
          () => {}, { readonly: true });
      } else if (spec.options) {
        const options = spec.options.map(option => ({ value: String(option.value), label: option.label }));
        if (!named) options.push({ value: String(Math.trunc(value)), label: `Unnamed value (${Math.trunc(value)})` });
        control = select(String(Math.trunc(value)), options, next => mutateNode(node,
          () => { setSemanticNumberValue(node, spec, Number(next)); }, rebuildDecodedEmitter));
      } else {
        control = numberInput(value, next => mutateNode(node, () => { setSemanticNumberValue(node, spec, next); },
          rebuildDecodedEmitter
            || (node.mainType === 8 && spec.path.length === 1 && spec.path[0] === 'SoundPlay')), spec.step);
      }
      body.append(row(spec.label, control, spec.title));
      shown++;
    }
    const counterLive = counterLivePanel(node);
    if (counterLive) body.appendChild(counterLive);
    if (inspector.note) body.appendChild(el('div', 'sp-fx-note', inspector.note));
    // The generic fallback is for a payload nothing has decoded. When the detail block above has already
    // said what the node is — or why the editor will not add it — repeating "nothing is mapped yet"
    // underneath reads as a contradiction of the paragraph the reader just finished.
    else if (!shown && !effectNodeDetail(node).summary) {
      body.appendChild(el('div', 'sp-fx-note',
        'None of this node’s settings have been named yet. Raw shows them all.'));
    }
  }

  /** Turn either recovered emitter payload into an authoring surface instead of one undifferentiated U-field list. */
  function addAuthoredParticleEditor(body: HTMLElement, doc: EffectsDocument, node: EffectNode): boolean {
    const fields = particleEmitterFields(node);
    const law = timerEmitterPreviewLaw(node);
    if (!fields || !law) return false;

    const value = (key: string, fallback = 0): number => {
      const raw = fields[key];
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    };
    const writeValue = (key: string, next: number): void => {
      if (setParticleEmitterField(node, key, next)) fields[key] = next;
    };
    const setValue = (key: string, next: number): void => mutateNode(node, () => writeValue(key, next));
    const scalar = (current: number, change: (next: number) => void, step = 'any', min?: number,
      max?: number): HTMLInputElement => {
      const control = numberInput(current, change, step);
      if (min !== undefined) control.min = String(min);
      if (max !== undefined) control.max = String(max);
      return control;
    };
    const compactField = (label: string, control: HTMLElement, title?: string): HTMLElement => {
      const out = el('div', 'sp-fx-emitter-field');
      if (control.classList.contains('sp-fx-emitter-pair') || control.classList.contains('sp-fx-emitter-vector'))
        out.classList.add('wide');
      if (control.matches('input, select') && !control.hasAttribute('aria-label')) control.setAttribute('aria-label', label);
      const name = el('span', '', label);
      if (title) { out.title = title; name.title = title; }
      out.append(name, control);
      return out;
    };
    const group = (title: string): { root: HTMLElement; fields: HTMLElement } => {
      const root = el('div', 'sp-fx-emitter-edit-group');
      const controls = el('div', 'sp-fx-emitter-edit-fields');
      root.append(el('div', 'sp-fx-emitter-edit-title', title), controls);
      return { root, fields: controls };
    };
    const pair = (leftLabel: string, left: HTMLElement, rightLabel: string, right: HTMLElement): HTMLElement => {
      const out = el('div', 'sp-fx-emitter-pair');
      const half = (label: string, control: HTMLElement) => {
        const item = el('label', '');
        item.append(el('small', '', label), control);
        return item;
      };
      out.append(half(leftLabel, left), half(rightLabel, right));
      return out;
    };
    const rawVector = (first: number): V3 => [value(`U${first}`), value(`U${first + 1}`), value(`U${first + 2}`)];
    const rawDirectionToEditor = (raw: V3): V3 => [-raw[0], raw[2], -raw[1]];
    const editorDirectionToRaw = (editor: V3): V3 => [-editor[0], -editor[2], editor[1]];
    const setRawVector = (first: number, next: V3): void => mutateNode(node, () => {
      writeValue(`U${first}`, next[0]); writeValue(`U${first + 1}`, next[1]);
      writeValue(`U${first + 2}`, next[2]);
    });
    const vector = (current: V3, change: (next: V3) => void, step = 'any'): HTMLElement => {
      const out = el('div', 'sp-fx-emitter-vector');
      (['X', 'Y', 'Z'] as const).forEach((axis, index) => {
        const item = el('label');
        const control = numberInput(current[index], next => {
          const updated: V3 = [...current]; updated[index] = next; change(updated);
        }, step);
        control.title = axis;
        item.append(el('small', '', axis), control);
        out.appendChild(item);
      });
      return out;
    };
    const range = (centerKey: string, spanKey: string): [number, number] => {
      const center = value(centerKey), half = Math.max(0, value(spanKey)) * 0.5;
      return [Math.max(0, center - half), Math.max(0, center + half)];
    };
    const setRange = (centerKey: string, spanKey: string, changed: 'min' | 'max', next: number): void => {
      const current = range(centerKey, spanKey);
      if (changed === 'min') current[0] = Math.min(Math.max(0, next), current[1]);
      else current[1] = Math.max(current[0], next);
      mutateNode(node, () => {
        writeValue(centerKey, (current[0] + current[1]) * 0.5);
        writeValue(spanKey, current[1] - current[0]);
      });
    };

    const card = el('div', 'sp-fx-emitter-card sp-fx-emitter-editor');
    const heading = el('div', 'sp-fx-emitter-head');
    const graph = selection?.ownerKind === 'graph' ? doc.graphs.find(item => item.id === selection!.ownerId) : null;
    const circumstance = graph ? graphSlots(doc, graph.id)[0]?.circumstance : undefined;
    const spriteLabel = PARTICLE_SPRITE_NAMES[law.spriteIndex] ?? `sprite ${law.spriteIndex}`;
    const blendLabel = emitterBlendLabel(law.blendSelector);
    const collisionEmitter = node.semanticType === 'particle.collision';
    heading.append(el('strong', '', collisionEmitter ? 'Snow collision burst'
      : circumstance && circumstance !== 'persistent' ? 'Particle burst' : 'Particle emitter'),
      el('span', '', `${spriteLabel} · ${blendLabel}`));
    card.appendChild(heading);
    const prop = graph ? selectedAttachmentProp(doc) : null;

    const emission = group('Emission');
    const continuous = value('U2') < 0;
    emission.fields.append(
      compactField('Mode', collisionEmitter
        ? input('Contact burst', () => {}, { readonly: true })
        : select<'burst' | 'continuous'>(continuous ? 'continuous' : 'burst', [
          { value: 'burst', label: 'Burst' }, { value: 'continuous', label: 'Continuous' },
        ], mode => setValue('U2', mode === 'continuous'
          ? -Math.max(0.05, Math.abs(value('U2')) || 0.3) : Math.max(0.05, Math.abs(value('U2')) || 0.3)))),
      compactField('Particles', scalar(Math.round(value('U0', 1)), next => setValue('U0', Math.max(1, Math.round(next))), '1', 1)),
      compactField(continuous ? 'Cycle window' : 'Emission window',
        scalar(Math.abs(value('U2')), next => setValue('U2', continuous ? -Math.max(0.05, next) : Math.max(0, next)), '0.05', 0)),
      compactField('Time scale', scalar(value('U3', 1), next => setValue('U3', Math.max(0.01, next)), '0.05', 0.01)),
    );
    card.appendChild(emission.root);

    const appearance = group('Appearance & lifetime');
    const spriteIndex = Math.max(0, Math.round(value('U49')));
    const spriteOptions = PARTICLE_SPRITE_NAMES.map((name, index) => ({ value: String(index), label: `${index}. ${name}` }));
    if (spriteIndex >= PARTICLE_SPRITE_NAMES.length)
      spriteOptions.push({ value: String(spriteIndex), label: `${spriteIndex}. Sprite ${spriteIndex}` });
    const blendSelector = Math.max(0, Math.round(value('U50')));
    const blendOptions = [
      { value: '0', label: 'Additive' }, { value: '1', label: 'Alpha blend' }, { value: '4', label: 'Darkening' },
    ];
    if (![0, 1, 4].includes(blendSelector))
      blendOptions.push({ value: String(blendSelector), label: emitterBlendLabel(blendSelector) });
    const size = range('U4', 'U6'), life = range('U5', 'U7');
    appearance.fields.append(
      compactField('Sprite', select(String(spriteIndex), spriteOptions, next => setValue('U49', Number(next)))),
      compactField('Blend', select(String(blendSelector), blendOptions, next => setValue('U50', Number(next)))),
      compactField('Size (cm)', pair('Min', scalar(size[0], next => setRange('U4', 'U6', 'min', next), '1', 0),
        'Max', scalar(size[1], next => setRange('U4', 'U6', 'max', next), '1', 0))),
      compactField('Lifetime (s)', pair('Min', scalar(life[0], next => setRange('U5', 'U7', 'min', next), '0.05', 0),
        'Max', scalar(life[1], next => setRange('U5', 'U7', 'max', next), '0.05', 0))),
      compactField('Trail', pair('Copies', scalar(Math.round(value('U1')), next => setValue('U1', clampNumber(Math.round(next), 0, 10)), '1', 0, 10),
        'Spacing (s)', scalar(value('U8'), next => setValue('U8', Math.max(0, next)), '0.01', 0))),
    );
    card.appendChild(appearance.root);

    const motion = group(collisionEmitter ? 'Contact & motion' : 'Position & motion');
    const origin = rawEmitterToEditor(rawVector(9));
    const velocity = rawDirectionToEditor(rawVector(18));
    const gravity = rawDirectionToEditor(rawVector(30));
    if (collisionEmitter) {
      const speed = Math.hypot(...rawVector(18));
      const setNormalSpeed = (next: number): void => {
        const rawVelocity = rawVector(18);
        const length = Math.hypot(...rawVelocity);
        const direction: V3 = length > 1e-9
          ? [rawVelocity[0] / length, rawVelocity[1] / length, rawVelocity[2] / length] : [0, 0, 1];
        setRawVector(18, [direction[0] * next, direction[1] * next, direction[2] * next]);
      };
      motion.fields.append(
        compactField('Origin', input('Exact rider contact', () => {}, { readonly: true }),
          'The game replaces the stored U9–U11 seed with the exact hit point.'),
        compactField('Normal speed (cm/s)', scalar(speed, next => setNormalSpeed(Math.max(0, next)), '10', 0),
          'Only this vector’s length survives. A hit replaces its direction with the outward surface normal.'),
        compactField('Gravity', vector(gravity, next => setRawVector(30, editorDirectionToRaw(next))),
          'Particle gravity in Slopesmith-local XYZ axes.'),
      );
    } else motion.fields.append(
      compactField('Local origin (m)', vector(origin, next => setRawVector(9, editorEmitterToRaw(next)), '0.1'),
        'Emitter-local Slopesmith coordinates. The viewport gizmo edits the same position.'),
      compactField('Velocity', vector(velocity, next => setRawVector(18, editorDirectionToRaw(next))),
        'Base launch velocity in Slopesmith-local XYZ axes.'),
      compactField('Gravity', vector(gravity, next => setRawVector(30, editorDirectionToRaw(next))),
        'Particle gravity in Slopesmith-local XYZ axes.'),
    );
    card.appendChild(motion.root);
    if (collisionEmitter) card.appendChild(el('div', 'sp-fx-note',
      'On a real hit the burst starts at that contact and launches outward at Normal speed. The isolated Preview button has no contact frame, so it demonstrates the particle law at the prop origin using the stored seed direction.'));

    const colors = emitterColorStopsFromNativeArgb(fields);
    const updateColor = (index: number, next: RgbaColor): void => mutateNode(node, () => {
      const updated = emitterColorStopsFromNativeArgb(fields);
      updated[index] = next;
      for (const [key, value] of Object.entries(nativeArgbFieldsFromRgbaColorStops(updated)))
        if (typeof value === 'number') writeValue(key, value);
    });
    const colorGroup = group('Colour over particle life');
    const gradient = el('div', 'sp-fx-emitter-gradient');
    const gradientFill = el('span');
    gradientFill.style.background = `linear-gradient(90deg, ${colors.map((stop, index) => {
      const rgb = stop.slice(0, 3).map(component => Math.round(clampNumber(component, 0, 1) * 255));
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clampNumber(stop[3], 0, 1)}) ${index / Math.max(1, colors.length - 1) * 100}%`;
    }).join(', ')})`;
    gradient.appendChild(gradientFill);
    colorGroup.fields.appendChild(gradient);
    const stops = el('div', 'sp-fx-emitter-color-stops');
    colors.forEach((stop, index) => {
      const stopRow = el('div', 'sp-fx-emitter-color-stop');
      const picker = input(colorHex(stop), next => {
        const rgb = colorRgbFromHex(next);
        if (rgb) updateColor(index, [...rgb, stop[3]] as RgbaColor);
      }, { type: 'color' });
      picker.classList.add('sp-fx-emitter-color-input');
      const alpha = scalar(stop[3], next => updateColor(index,
        [stop[0], stop[1], stop[2], clampNumber(next, 0, 1)]), '0.05', 0, 1);
      stopRow.append(el('span', '', String(index + 1)), picker, el('small', '', 'Alpha'), alpha);
      stops.appendChild(stopRow);
    });
    colorGroup.fields.appendChild(stops);
    card.appendChild(colorGroup.root);

    const advancedGeometry = el('details', 'sp-fx-disclosure');
    advancedGeometry.appendChild(el('summary', '', 'Advanced particle geometry'));
    const geometryBody = el('div', 'sp-fx-disclosure-body sp-fx-emitter-advanced');
    const advancedVector = (label: string, first: number, title: string) => geometryBody.appendChild(
      compactField(label, vector(rawDirectionToEditor(rawVector(first)), next =>
        setRawVector(first, editorDirectionToRaw(next))), title));
    advancedVector('Spawn axis A', 12, 'First centered spawn-area axis in Slopesmith-local coordinates.');
    advancedVector('Spawn axis B', 15, 'Second centered spawn-area axis in Slopesmith-local coordinates.');
    advancedVector('Velocity variation A', 21, 'First centered half-range velocity axis.');
    advancedVector('Velocity variation B', 24, 'Second centered half-range velocity axis.');
    advancedVector('Velocity variation C', 27, 'Third centered half-range velocity axis.');
    advancedGeometry.appendChild(geometryBody);
    card.appendChild(advancedGeometry);

    const allProperties = el('details', 'sp-fx-disclosure');
    allProperties.appendChild(el('summary', '', 'All recovered emitter properties'));
    const allPropertiesBody = el('div', 'sp-fx-disclosure-body');
    addKnownSemanticFields(allPropertiesBody, node, false);
    allProperties.appendChild(allPropertiesBody);
    card.appendChild(allProperties);
    if (graph && prop?.id) {
      const preview = el('div', 'sp-fx-emitter-preview-actions');
      preview.append(button(collisionEmitter ? '▶ Preview burst' : '▶ Preview timer', collisionEmitter
        ? 'Preview only this snow collision burst on its attached level object.'
        : 'Preview only this particle timer on its attached level object.', () => {
        if (!viewport.previewAuthoredTimerNode(prop.id!, node, !collisionEmitter && value('U2') < 0))
          toast(`This particle ${collisionEmitter ? 'burst' : 'timer'} could not be previewed.`, 'err');
      }), button('■ Stop', 'Stop the current particle preview.', () => viewport.stopReferenceEffectPreview()));
      card.appendChild(preview);
    }
    body.appendChild(card);
    return true;
  }

  /** Upload a WAV through the shared library and assign it to this Play sound node. */
  async function loadNodeSound(node: EffectNode): Promise<void> {
    const stored = await pickCustomSound();
    if (!stored) return;
    mutateNode(node, () => setEffectNodeSoundFile(node, stored), true);
    toast(`${mountainName()} sound "${stored}" assigned.`, 'ok');
  }

  /** Read-only PlaySound readout for retail reference graphs. A shipped level names its own bank, so the slot
   *  always resolves against it and there is nothing here to author. */
  function addReferenceSoundPreview(body: HTMLElement, level: string, node: EffectNode): void {
    const rawSlot = node.payload.SoundPlay;
    if (node.mainType !== 8 || typeof rawSlot !== 'number' || !Number.isFinite(rawSlot)) return;
    const slot = Math.trunc(rawSlot);
    const filepath = effectSoundSource(level, slot);
    body.appendChild(row('Filepath', input(filepath ?? 'unresolved', () => {}, { readonly: true }), filepath
      ? 'Resolved WAV source relative to Maps/<level>/Audio/SFX.'
      : 'No sound was found in this bank at that number.'));
    if (filepath) body.appendChild(button('▶ play sound', 'Audition this PlaySound node’s course-bank clip.', () => {
      auditionEffectSound(level, slot);
    }));
  }

  /** PlaySound's authoring surface. An uploaded WAV is the primary control: a bare slot number only means
   *  something against whatever bank the repack target happens to ship, while a custom clip is allocated a
   *  reserved slot at export and this node is pointed at it. A retail graph's direct slot stays editable when
   *  no WAV is assigned, and both readings close with the same browse / load / play group as prop audio. */
  function addSoundNodePreview(body: HTMLElement, doc: EffectsDocument, node: EffectNode): void {
    if (node.mainType !== 8) return;
    const level = doc.target.level;
    const file = effectNodeSoundFile(node);
    const uploaded = customSounds();
    if (uploaded.length || file) {
      const options = [{ value: '', label: '(none — use a bank sound)' },
        ...uploaded.map(name => ({ value: name, label: name })),
        ...(file && !uploaded.includes(file) ? [{ value: file, label: `${file} (missing)` }] : [])];
      body.appendChild(row(`${mountainName()} WAV`, select(file ?? '', options,
        value => mutateNode(node, () => setEffectNodeSoundFile(node, value || null), true)),
      'Play one of your own uploaded WAVs instead of a course sound. Export finds it a place in the '
      + 'level’s sound bank for you.'));
    }
    const rawSlot = node.payload.SoundPlay;
    const slot = typeof rawSlot === 'number' && Number.isFinite(rawSlot) ? Math.trunc(rawSlot) : null;
    // A retail graph names its own level, so the slot resolves in that level's bank. An authored mountain has
    // no bank of its own — the slot will mean whatever the level it is repacked ONTO ships there — so there is
    // nothing to resolve against until a donor is named. Default to the source level of the prop this effect
    // is attached to, which is the bank the author is most likely picking slots out of.
    const own = slot === null ? null : effectSoundSource(level, slot);
    const attached = selectedAttachmentProp(doc)?.level;
    const donor = own ? level
      : soundAuditionLevel ?? (attached && COURSE_BANK_LEVELS.includes(attached) ? attached : COURSE_BANK_LEVELS[0]);
    const bankPath = slot === null ? null : own ?? effectSoundSource(donor, slot);
    // The donor picker belongs to the slot reading only: with a WAV assigned the slot is export-owned and
    // nothing is auditioned out of a bank.
    if (!file && slot !== null && !own) body.appendChild(row('Audition bank',
      select(donor, COURSE_BANK_LEVELS.map(name => ({ value: name, label: name })),
        value => { soundAuditionLevel = value; render(); }),
      `${mountainName()} has no native sound bank, so a bank sound only `
      + 'becomes real once the level is packed — this previews what the chosen course has at that number.'));
    if (file) body.appendChild(row('Filepath', input(customSoundFilepath(file, mountainName()), () => {}, { readonly: true }),
      'Your uploaded file. Its place in the sound bank is chosen for you at export, so Sound slot is locked while this is set.'));
    else if (slot !== null) body.appendChild(row('Filepath', input(bankPath ?? 'unresolved', () => {}, { readonly: true }), bankPath
      ? 'Resolved WAV source relative to Maps/<level>/Audio/SFX.'
      : 'No sound was found in this bank at that number.'));
    // The block closes with the same three actions in the same order as prop audio — browse, load, play —
    // whichever channel is driving it.
    body.appendChild(button('🔊 sound library…',
      'Browse the course sounds and your own uploads, hear each one, and pick what this node plays.', () => {
        void openSoundLibrary({
          mountainName: mountainName(),
          level: donor, slot: slot ?? undefined, file,
          // Follow the bank the slot was actually heard on — the number alone means a different sound in
          // every course bank, so keeping the old donor would preview something the author never picked.
          assign: (chosen, chosenLevel) => mutateNode(node, () => {
            node.payload.SoundPlay = chosen;
            setEffectNodeSoundFile(node, null); // a bank slot replaces the custom clip, not both at once
            // Normalized because the picker's options are the uppercase table keys, as every other
            // level-to-bank path already assumes.
            soundAuditionLevel = chosenLevel.trim().toUpperCase();
          }, true),
          assignFile: chosen => mutateNode(node, () => setEffectNodeSoundFile(node, chosen), true),
        });
      }));
    body.appendChild(button('⤒ load custom wav…',
      `Upload a WAV and assign it to this node. Stored with ${mountainName()} (PCM16 mono, ≤10 s).`,
      () => void loadNodeSound(node)));
    if (file) body.appendChild(button('▶ play sound', 'Audition this node’s custom WAV.',
      () => auditionCustomSound(file)));
    else if (bankPath && slot !== null) body.appendChild(button('▶ play sound',
      own ? 'Audition this PlaySound node’s course-bank clip.'
        : `Hear what ${donor} has at number ${slot}. The course you pack onto decides what actually plays.`,
      () => { auditionEffectSound(donor, slot); }));
  }

  function addSemanticFields(body: HTMLElement, doc: EffectsDocument, node: EffectNode): void {
    body.append(row('Stable ID', input(node.id, () => {}, { readonly: true })),
      row('Semantic type', input(node.semanticType ?? '', () => {}, { readonly: true }),
        'What Slopesmith reads this node as. Preview and the controls below follow it; the exported level does not. Change it deliberately, from Raw fields.'));
    // A custom WAV owns the slot — export allocates it and rewrites SoundPlay — so the raw number stops being
    // an authoring control and is shown read-only rather than as a field whose value is silently replaced.
    const exportOwnedSlot = !!effectNodeSoundFile(node);
    if (!addAuthoredParticleEditor(body, doc, node)) addKnownSemanticFields(body, node, exportOwnedSlot);
    addSoundNodePreview(body, doc, node);
    if (node.semanticType === 'property.anim-object') {
      const context = authoredClipContext(doc, node);
      if (context) {
        body.appendChild(el('div', 'sp-fx-note',
          `Source model clip: ${context.clip.clipFrames} frames. Preview and Test use the model’s embedded curves.`));
        embedSectionBody(body, clipTimelinePanel(ensureClipViewer(context)), 'Model animation');
        authoredClipPanelRendered = true;
      } else {
        body.appendChild(el('div', 'sp-fx-note warn',
          'This prop’s model has no animation in it, so Model clip has nothing to play.'));
      }
    }
    const routeSplines = doc.splines.filter(resource => resource.id.startsWith('spline:path:'));
    if (node.semanticType === 'spline.animation' && !routeSplines.length)
      body.appendChild(el('div', 'sp-fx-note warn', 'Add a motion path from the Effects home panel, then return here to choose it as the route.'));

    const call = authoredInstanceEffectCall(doc, props(), node);
    if (call) {
      if (!call.target || !call.graph) body.appendChild(el('div', 'sp-fx-note warn',
        'This call does not say which prop or which effect it means.'));
      const effectControl = el('div', 'sp-fx-input-help');
      effectControl.append(input(call.graphLabel, () => {}, { readonly: true }),
        helpIcon('A Run node runs this effect on the target prop. The target decides where in the world it happens.',
          'Run node behavior'));
      body.append(
        row('Target prop', input(call.targetLabel, () => {}, { readonly: true }),
          'The authored prop that receives the call, and whose position the effect runs at.'),
        row('Runs effect', effectControl, 'The effect that runs on the target prop.'),
      );
      if (call.target && call.graph) {
        const target = call.target, graph = call.graph;
        if (!isEffectTriggerProp(target)) body.appendChild(calledModelPreview.showModel(target.level, target.model));
        const actions = el('div', 'sp-fx-actions');
        actions.appendChild(navigationButton('Go to effect', MODE_ICON.effects,
          'Open the called effect on its target prop.', () => openAuthoredGraphOnProp(doc, target, graph)));
        body.appendChild(actions);
      }
    }

    const refs = node.references ?? (node.references = {});
    const referenceTargets: Record<string, readonly { id: string; name?: string }[]> = {
      instance: doc.instances, effectGraph: doc.graphs, function: doc.functions,
      spline: node.semanticType === 'spline.animation' ? routeSplines : doc.splines,
    };
    for (const [key, targets] of Object.entries(referenceTargets)) {
      if (!(key in refs)) continue;
      const options = [{ value: '', label: '(none)' }, ...targets.map(x => ({ value: x.id, label: x.name ? `${x.name} · ${x.id}` : x.id }))];
      body.append(row(`${key} ref`, select(refs[key] ?? '', options, value => mutateNode(node, () => { refs[key] = value || null; })),
        `Which ${key} this node points at.`));
    }
  }

  function inspector(doc: EffectsDocument, view: EffectsPanelView): HTMLElement | null {
    const current = view.selection;
    if (!current) return null;
    const node = effectNode(doc, current); if (!node) return null;
    const owner = effectOwner(doc, current);
    const nodeIndex = Math.max(0, owner?.nodes.indexOf(node) ?? 0) + 1;
    const s = section(`Selected node: ${nodeIndex}. ${view.nodeLabel?.(node) ?? nodeDisplayName(node)}`);
    s.root.classList.add('sp-fx-child-panel', 'sp-fx-child-panel-2');
    const tabs = segmented<'semantic' | 'raw'>([
      { value: 'semantic', label: 'Semantic', title: 'Show the decoded semantic node fields.' },
      { value: 'raw', label: 'Raw fields', title: 'Show every field on this node, exactly as it is stored.' },
    ], () => inspectorView, next => { inspectorView = next; render(); });
    tabs.el.classList.add('sp-fx-tabs');
    tabs.el.setAttribute('role', 'tablist');
    [...tabs.el.querySelectorAll('button')].forEach((tab, index) => {
      const selected = index === (inspectorView === 'semantic' ? 0 : 1);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selected));
    });
    s.body.appendChild(tabs.el);
    if (inspectorView === 'semantic') {
      addNodeDetail(s.body, node);
      if (view.readOnly && view.referenceData) addReferenceSemanticFields(s.body, view.referenceData, node);
      else if (view.readOnly) addKnownSemanticFields(s.body, node, true);
      else addSemanticFields(s.body, doc, node);
    }
    else {
      const textarea = el('textarea', 'sp-fx-raw'); textarea.spellcheck = false; textarea.readOnly = view.readOnly;
      textarea.value = JSON.stringify(node, null, 2); s.body.appendChild(textarea);
      if (!view.readOnly) s.body.appendChild(button('Apply raw JSON', 'Replace this node only after the complete Effects document validates.', () => {
          try {
            const replacement = replaceEffectNodeRaw(doc, current, textarea.value);
            current.nodeId = replacement.id; dirty(); toast('Raw node applied.', 'ok');
          } catch (error) { toast(error instanceof Error ? error.message : String(error), 'err', 6000); }
        }));
    }
    return s.root;
  }

  function authoredSelectedPropPanel(doc: EffectsDocument): HTMLElement | null {
    if (!selectedAuthoredPropId) return null;
    const prop = props().find(item => item.id === selectedAuthoredPropId);
    if (!prop) return null;
    const s = section(prop.name);
    const attachment = effectAttachments(doc).find(item => item.enabled && item.target.id === selectedAuthoredPropId);
    const slot = attachment ? doc.slots.find(item => item.id === attachment.slot) : null;
    if (isEffectTriggerProp(prop)) {
      const size = clampEffectTriggerSize(prop.effectTrigger.size);
      const setSize = (axis: 0 | 1 | 2, value: number) => {
        const next: [number, number, number] = [...size];
        next[axis] = value;
        prop.effectTrigger!.size = clampEffectTriggerSize(next);
        dirty();
      };
      s.body.append(
        row('Name', input(prop.name, value => { const next = value.trim(); if (next) { prop.name = next; dirty(); } })),
        row('Prop number', input(prop.id ?? selectedAuthoredPropId, () => {}, { readonly: true }),
          'This trigger’s number in the mountain. Effects use it to point at a particular prop, and it is what '
          + 'attaches and packs this trigger’s collision effect.'),
        row('X', numberInput(prop.pos[0], value => { prop.pos[0] = value; dirty(); })),
        row('Y', numberInput(prop.pos[1], value => { prop.pos[1] = value; dirty(); })),
        row('Z', numberInput(prop.pos[2], value => { prop.pos[2] = value; dirty(); })),
        row('Width', numberInput(size[0], value => setSize(0, value), '0.5')),
        row('Height', numberInput(size[1], value => setSize(1, value), '0.5')),
        row('Depth', numberInput(size[2], value => setSize(2, value), '0.5')),
      );
      const transform = segmented<'move' | 'scale'>([
        { value: 'move', label: 'Move', title: 'Move the trigger box with the viewport gizmo.' },
        { value: 'scale', label: 'Resize', title: 'Resize the trigger independently on each axis.' },
      ], () => store.gizmoMode === 'scale' ? 'scale' : 'move', mode => {
        store.gizmoMode = mode;
        selection = selection ? { ownerKind: selection.ownerKind, ownerId: selection.ownerId } : selection;
        viewport.setPlacedPropSelection(props().indexOf(prop));
        viewport.setGizmoMode(mode);
        render();
      });
      s.body.append(row('Transform', transform.el), el('div', 'sp-fx-note',
        'The box is invisible in game. Riding through it runs the collision effect below.'));
      s.body.appendChild(hostPreview.showTrigger());
      const triggerActions = el('div', 'sp-fx-actions');
      triggerActions.append(button('Focus trigger', 'Frame this trigger volume in the viewport.', () => {
        const index = props().indexOf(prop);
        if (index < 0 || !viewport.focusProp(index)) toast('Could not frame this trigger.', 'err');
      }), button('Delete trigger', 'Delete this trigger box and its effects.', () => {
        removeSelectedEffectTrigger();
      }, true));
      s.body.appendChild(triggerActions);
    } else {
      s.body.append(row('Model', input(prop.name, () => {}, { readonly: true }),
        'The model this prop uses. Select the text to copy it.'),
        // The same label the reference host panel gives a native prop's Instances[] row: one prop is picked out
        // of many by its number whichever kind it is, so the two panels ask and answer the same question.
        row('Prop number', input(prop.id ?? selectedAuthoredPropId, () => {}, { readonly: true }),
          'This prop’s number in the mountain. Effects use it to point at a particular prop, and it is what '
          + 'attaches this effect when the mountain is exported and repacked.'));
    }
    // Prop-first creation: an empty effect lands wired into THIS prop's slot, so no unattached graph exists.
    const addEffect = el('div', 'sp-fx-create sp-fx-effect-add');
    const availableEffectTypes = EFFECT_TYPES.filter(type => {
      const graphId = slot?.circumstances[type.circumstance];
      return !graphId || !doc.graphs.some(graph => graph.id === graphId);
    });
    if (availableEffectTypes.length) addEffect.appendChild(templatePicker('+ Add effect',
      'Choose an empty effect to add directly to this prop.', availableEffectTypes, type => {
        authoredUnassignedOpen = false;
        selection = addEmptyEffectToProp(doc, prop.id!, type.circumstance);
        dirty();
        toast('Effect added to this prop.', 'ok');
      }));
    else {
      const complete = button('+ Add effect', 'This object already has every supported effect type.', () => {});
      complete.disabled = true;
      addEffect.appendChild(complete);
    }
    // The two suppression latches [Trailmap: 150-logic §slot-columns] are slot columns, not chains to author:
    // checking one writes the retail shape (a reference to an empty graph) through the document funnel. They
    // are meaningful even on an otherwise bare slot — the retail iris door is exactly that.
    const latchPanel = (): HTMLElement => {
      const wrap = el('div', 'sp-fx-latches');
      wrap.appendChild(el('div', 'sp-fx-subtitle', 'When this effect ends'));
      wrap.append(
        checkboxRow('Hold the final state (don\'t reset)', !!slot?.circumstances.slot4,
          'Effect end latch: a finished play-once clip keeps its last frame (the iris door stays open) instead of reverting to the rest pose.',
          value => { if (setPropEffectLatch(doc, prop.id!, 'slot4', value)) dirty(); }),
        checkboxRow('Keep it when the area unloads', !!slot?.circumstances.slot3,
          'Region exit latch: the prop keeps its current state when its world region deactivates instead of reverting to the rest pose.',
          value => { if (setPropEffectLatch(doc, prop.id!, 'slot3', value)) dirty(); }),
      );
      if (slot?.circumstances.slot4 && !effectSlotCanSelfEnd(doc, slot))
        wrap.appendChild(el('div', 'sp-fx-note warn',
          'Nothing on this prop self-ends yet — this latch only matters once a play-once model clip runs here.'));
      return wrap;
    };
    if (!attachment || !slot) {
      s.body.appendChild(el('div', 'sp-fx-note', attachment
        ? 'This prop points at an effect that was deleted. Adding an effect rebuilds the link.'
        : 'No effect on this prop yet. Pick when one should run and it is wired up for you.'));
      s.body.appendChild(addEffect);
      if (!isEffectTriggerProp(prop)) s.body.appendChild(latchPanel());
      return s.root;
    }
    s.body.appendChild(row('Effects ID', input(slot.id, () => {}, { readonly: true }),
      'The ID this prop uses to find its effects. Shown for cross-referencing; nothing to edit here.'));
    const bindings = attachmentBindings(doc, attachment);
    const actions = el('div', 'sp-fx-actions');
    const propIndex = props().findIndex(item => item.id === selectedAuthoredPropId);
    if (propIndex >= 0 && !isEffectTriggerProp(prop)) {
      s.body.appendChild(hostPreview.showModel(prop.level, prop.model));
      const navigation = el('div', 'sp-fx-actions sp-fx-selection-nav');
      navigation.append(navigationButton('Go to prop', MODE_ICON.props,
        'Switch to Props mode with this prop selected.', () => goToProp({ propIndex })), selectionBackButton());
      s.body.appendChild(navigation);
      s.root.classList.add('sp-fx-has-inline-back');
    }
    actions.append(button('Detach', 'Unlink this prop from its effects.', () => {
      if (detachEffectFromProp(doc, prop.id!)) dirty();
    }, true));
    s.body.append(actions, effectNodeTree(bindings, selection, (graph, node) => {
      authoredUnassignedOpen = false;
      selection = { ownerKind: 'graph', ownerId: graph.id, nodeId: node.id };
      render();
    }, nodeDisplayName, binding => addNodePicker(doc,
      { ownerKind: 'graph', ownerId: binding.graph.id }, binding.circumstance), {
      effect: binding => effectTreeActionMenu(doc, binding),
      node: (binding, node) => nodeTreeActionMenu(doc, binding, node),
    }));
    s.body.appendChild(addEffect);
    if (!isEffectTriggerProp(prop)) s.body.appendChild(latchPanel());
    return s.root;
  }

  function authoredSelectionListPanel(doc: EffectsDocument): HTMLElement | null {
    if (selectedAuthoredPropIds.length < 2) return null;
    const selectedIds = new Set(selectedAuthoredPropIds);
    const selectedProps = props().filter(prop => !!prop.id && selectedIds.has(prop.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return effectHostListPanel(selectedProps.map(prop => ({
      label: prop.name,
      meta: prop.id!,
      active: selectedAuthoredPropId === prop.id,
      title: 'Edit this selected effect host without dropping the multi-selection.',
      select: () => {
        selectedAuthoredPropId = prop.id!;
        attachmentPropId = prop.id!;
        selection = effectSelectionForProp(doc, prop.id!);
        render();
      },
    })), 'Several props are selected. Click one below to edit its effects; Ctrl/Cmd-click in the viewport to add or remove props.');
  }

  function attachmentPanel(doc: EffectsDocument): HTMLElement | null {
    if (!selection || selection.ownerKind !== 'graph') return null;
    const slots = graphSlots(doc, selection.ownerId);
    const slotIds = new Set(slots.map(binding => binding.slot.id));
    const livePropIds = new Set(props().map(prop => prop.id).filter((id): id is string => !!id));
    const attached = effectAttachments(doc).some(attachment => attachment.enabled
      && slotIds.has(attachment.slot) && livePropIds.has(attachment.target.id));
    if (attached) return null;
    const s = section('Share these effects with another prop');
    const levelProps = props();
    if (!levelProps.length) { s.body.appendChild(el('div', 'sp-fx-empty', 'Place a prop first — effects live on props.')); return s.root; }
    if (!attachmentPropId || !levelProps.some(p => p.id === attachmentPropId)) attachmentPropId = levelProps[0].id!;
    const propSelect = select(attachmentPropId, levelProps.map((p, i) => ({ value: p.id!, label: `${i + 1}. ${p.name}` })), value => { attachmentPropId = value; render(); });
    s.body.append(row('Level prop', propSelect));
    if (!slots.length) {
      s.body.append(el('div', 'sp-fx-note', 'This effect is not on a prop yet, so nothing runs it.'),
        button('Make it run by itself', 'Put this effect on a prop so it runs by itself.', () => {
          const slotSelection = addEffectTemplate(doc, 'empty');
          const graph = doc.graphs.find(x => x.id === slotSelection.ownerId)!;
          const slot = doc.slots[doc.slots.length - 1];
          doc.graphs.splice(doc.graphs.indexOf(graph), 1);
          slot.name = `Props running ${effectOwner(doc, selection!)?.name ?? selection!.ownerId}`;
          slot.circumstances.persistent = selection!.ownerId;
          dirty();
        }));
      return s.root;
    }
    let slotId = slots[0].slot.id;
    let circumstance = slots[0].circumstance;
    const current = effectAttachments(doc).find(x => x.target.id === attachmentPropId);
    if (current && slots.some(x => x.slot.id === current.slot)) { slotId = current.slot; circumstance = current.circumstance; }
    const slotSelect = select(slotId, slots.map(x => ({ value: x.slot.id, label: x.slot.name ? `${x.slot.name} · ${effectCircumstanceLabel(x.circumstance)}` : `${x.slot.id} · ${effectCircumstanceLabel(x.circumstance)}` })), value => {
      slotId = value; circumstance = slots.find(x => x.slot.id === value)?.circumstance ?? 'persistent';
    });
    const circumstances = [...new Set(slots.filter(x => x.slot.id === slotId).map(x => x.circumstance))];
    const circumstanceSelect = select<EffectCircumstance>(circumstance,
      circumstances.map(value => ({ value, label: effectCircumstanceLabel(value) })),
      value => { circumstance = value; });
    s.body.append(row('Effects to share', slotSelect), row('Fires on', circumstanceSelect));
    const actions = el('div', 'sp-fx-actions');
    actions.append(button(current ? 'Update attachment' : 'Attach effect', 'Point this prop at the selected effects, so both props run the same ones.', () => {
      attachEffectToProp(doc, attachmentPropId, slotId, circumstance);
      selectedAuthoredPropIds = [attachmentPropId];
      selectedAuthoredPropId = attachmentPropId;
      authoredUnassignedOpen = false;
      dirty(); toast('Effect attached to level prop.', 'ok');
    }));
    s.body.appendChild(actions);
    return s.root;
  }

  function validationPanel(doc: EffectsDocument): HTMLElement {
    const issues = validateEffectsAuthoring(doc, props(), store.mdoc.rails ?? []);
    const s = section(`Validation · ${issues.length || 'clean'}`);
    if (!issues.length) s.body.appendChild(el('div', 'sp-fx-valid', 'No structural, reference, attachment, or semantic-range issues.'));
    else {
      for (const issue of issues.slice(0, 12)) {
        const item = el('div', `sp-fx-issue ${issue.severity}`);
        item.append(el('strong', '', issue.severity), el('span', '', issue.message), el('code', '', issue.path)); s.body.appendChild(item);
      }
      if (issues.length > 12) s.body.appendChild(el('div', 'sp-fx-note', `${issues.length - 12} more issues; export/check shows the complete set.`));
    }
    return s.root;
  }

  function normalizeReferenceSelection(data: ReferenceEffectsData): void {
    const validIndices = new Set(data.instances.map(instance => instance.index));
    const instanceIndices = referenceFocus.instanceIndices.filter(index => validIndices.has(index));
    const activeInstanceIndex = referenceFocus.activeInstanceIndex !== null
      && instanceIndices.includes(referenceFocus.activeInstanceIndex) ? referenceFocus.activeInstanceIndex : null;
    const activeInstance = activeInstanceIndex === null ? null
      : data.instances.find(instance => instance.index === activeInstanceIndex) ?? null;
    let current = referenceFocus.selection;
    if (current && !effectOwner(data.document, current)) current = null;
    if (current) {
      const owner = effectOwner(data.document, current);
      if (current.nodeId && !owner?.nodes.some(node => node.id === current!.nodeId))
        current = { ...current, nodeId: owner?.nodes[0]?.id };
    }
    if (instanceIndices.length && activeInstanceIndex === null) current = null;
    if (!current && activeInstance) current = referenceHostSelection(data, activeInstance);
    const preferredCaller = referenceFocus.callerIndex !== null && validIndices.has(referenceFocus.callerIndex)
      ? referenceFocus.callerIndex : null;
    referenceFocus = {
      instanceIndices,
      activeInstanceIndex,
      selection: current,
      markerIndex: referenceFocus.markerIndex !== null && validIndices.has(referenceFocus.markerIndex)
        ? referenceFocus.markerIndex : null,
      callerIndex: activeInstance ? referenceCallerIndex(data, activeInstance, current, preferredCaller) : null,
    };
  }

  function referenceHeader(data: ReferenceEffectsData): HTMLElement {
    const s = section(`${data.level} effects · read only`);
    const attached = attachedReferenceInstances(data);
    const nodes = data.document.graphs.reduce((n, graph) => n + graph.nodes.length, 0)
      + data.document.functions.reduce((n, fn) => n + fn.nodes.length, 0);
    const issues = validateEffectsAuthoring(data.document);
    const errors = issues.filter(issue => issue.severity === 'error').length;
    const particleCount = data.particleVolumes?.length ?? 0;
    s.body.appendChild(el('div', `sp-fx-summary${errors ? ' bad' : ''}`,
      `${data.document.graphs.length} effects · ${data.document.functions.length} shared · ${nodes} nodes · ${attached.length} attached props · ${particleCount} fog volumes · ${issues.length ? `${errors} errors / ${issues.length - errors} warnings` : 'valid'}`));
    s.body.appendChild(el('div', 'sp-fx-note',
      'A read-only view of the effects this shipped level was built with.'));
    s.body.appendChild(el('div', 'sp-fx-note',
      'Preview plays an effect on the spot. The Effects view toggle runs nearby self-running effects, and Play fires collision effects when you actually ride into the prop.'));
    s.body.appendChild(unassignedButton('reference', referenceUnassignedOwnerIds(data).size));
    return s.root;
  }

  function mapGuidePanel(): HTMLElement {
    const s = section(`${mountainName()} effects map`);
    s.body.appendChild(el('div', 'sp-fx-note',
      'Props with effects, trigger boxes, fog banks, and motion paths are highlighted purple — the things this '
      + 'mode owns. Every grind rail draws its curve in red: those belong to the course, and this mode only '
      + 'switches them on and off. Click one to edit it; Ctrl/Cmd-click to select several props at once.'));
    return s.root;
  }

  function referenceSelectionTargetIndex(data: ReferenceEffectsData,
    current: EffectSelection | null): number | null {
    if (!current) return null;
    const node = effectNode(data.document, current);
    return node ? referenceInstanceEffectCall(data, node)?.target?.index ?? null : null;
  }

  /** Choose a host's first useful effect. Its own slot wins; a call-only receiver falls back to the first
   * remote effect shown in its caller tree so selecting a prop never leaves the effect panel blank. */
  function referenceHostSelection(data: ReferenceEffectsData,
    instance: ReferenceEffectInstance): EffectSelection | null {
    const bindings = referenceInstanceBindings(data, instance);
    const binding = bindings.find(item => item.graph.nodes.some(node => !!particleEmitterFields(node)))
      ?? bindings.find(item => item.graph.nodes.some(node => !!referenceFireworkCall(data, node)))
      ?? bindings[0];
    if (binding) {
      const node = binding.graph.nodes.find(item => !!particleEmitterFields(item))
        ?? binding.graph.nodes.find(item => !!referenceFireworkCall(data, item))
        ?? binding.graph.nodes[0];
      return { ownerKind: 'graph', ownerId: binding.graph.id, ...(node ? { nodeId: node.id } : {}) };
    }
    for (const caller of referenceIncomingEffectTree(data, instance.index)) {
      const graph = caller.effects.find(effect => !!effect.graph)?.graph;
      if (graph) return { ownerKind: 'graph', ownerId: graph.id,
        ...(graph.nodes[0] ? { nodeId: graph.nodes[0].id } : {}) };
    }
    return referenceEffectSelection(data, instance);
  }

  /** Recover the caller branch behind an incoming graph selection. An explicit branch wins; a graph attached
   * directly to the target stays direct unless the user deliberately selected it through a caller branch. */
  function referenceCallerIndex(data: ReferenceEffectsData, target: ReferenceEffectInstance,
    current: EffectSelection | null, preferred: number | null = null): number | null {
    if (current?.ownerKind !== 'graph') return null;
    const matches = referenceIncomingEffectTree(data, target.index)
      .filter(caller => caller.effects.some(effect => effect.graph?.id === current.ownerId));
    if (preferred !== null && matches.some(caller => caller.instance.index === preferred)) return preferred;
    if (referenceInstanceBindings(data, target).some(binding => binding.graph.id === current.ownerId)) return null;
    return matches[0]?.instance.index ?? null;
  }

  function referenceTargetSelection(data: ReferenceEffectsData, targetIndex: number,
    sourceIndex: number): EffectSelection | null {
    const entry = referenceIncomingEffectCalls(data, targetIndex)
      .find(candidate => candidate.sources.some(source => source.instance.index === sourceIndex));
    return entry ? { ownerKind: entry.ownerKind, ownerId: entry.owner.id, nodeId: entry.node.id } : null;
  }

  function applyReferenceFocus(data: ReferenceEffectsData, instanceIndices: readonly number[],
    activeInstanceIndex: number | null, nextSelection: EffectSelection | null, markerIndex: number | null,
    callerIndex: number | null = null): void {
    const valid = new Set(data.instances.map(instance => instance.index));
    const unique = [...new Set(instanceIndices)].filter(index => valid.has(index));
    const activeIndex = activeInstanceIndex !== null && unique.includes(activeInstanceIndex)
      ? activeInstanceIndex : null;
    if (referenceFocus.activeInstanceIndex !== activeIndex) viewport.stopReferenceEffectPreview();
    dropSplineSelection();
    source = 'reference';
    referenceUnassignedOpen = false;
    referenceFocus = {
      instanceIndices: unique,
      activeInstanceIndex: activeIndex,
      selection: activeIndex === null ? null : nextSelection,
      markerIndex,
      callerIndex,
    };
    authoredUnassignedOpen = false;
    selection = null;
    selectedAuthoredPropIds = [];
    selectedAuthoredPropId = null;
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    viewport.selectReferenceEffectInstances(unique, markerIndex);
    render();
  }

  /** Open one graph explicitly on the model that receives it. An effect-row click opens its first node by
   * default; empty effects remain graph-only while still exposing the effect-level summary and actions. */
  function openReferenceGraphOnModel(data: ReferenceEffectsData, targetIndex: number, graph: EffectGraph,
    node: EffectNode | undefined = graph.nodes[0], callerIndex: number | null = null): void {
    if (!viewport.isReferenceEffectPreviewing(targetIndex, graph.id)) viewport.stopReferenceEffectPreview();
    const nextSelection: EffectSelection = {
      ownerKind: 'graph', ownerId: graph.id,
      ...(node?.id ? { nodeId: node.id } : {}),
    };
    const markerIndex = node ? referenceInstanceEffectCall(data, node)?.target?.index ?? targetIndex : targetIndex;
    applyReferenceFocus(data, [targetIndex], targetIndex, nextSelection, markerIndex, callerIndex);
  }

  function toggleReferenceFocus(data: ReferenceEffectsData, candidates: readonly number[], additive: boolean,
    clickedTargetIndex: number | null): void {
    const current = source === 'reference' ? referenceFocus.instanceIndices : [];
    const selected = new Set(current);
    const allSelected = candidates.length > 0 && candidates.every(index => selected.has(index));
    if (!additive) {
      selected.clear();
      for (const index of candidates) selected.add(index);
    } else if (allSelected) {
      for (const index of candidates) selected.delete(index);
    } else {
      for (const index of candidates) selected.add(index);
    }
    const next = [...selected];
    if (!next.length) { clearSelection(); return; }
    const activeIndex = next.length === 1 ? next[0] : null;
    const activeInstance = activeIndex === null ? null : data.instances.find(instance => instance.index === activeIndex) ?? null;
    const relationSelection = activeIndex !== null && clickedTargetIndex !== null
      ? referenceTargetSelection(data, clickedTargetIndex, activeIndex) : null;
    const nextSelection = relationSelection ?? (activeInstance ? referenceHostSelection(data, activeInstance) : null);
    const markerIndex = activeIndex !== null
      ? clickedTargetIndex ?? referenceSelectionTargetIndex(data, nextSelection) ?? activeIndex
      : additive && allSelected ? null : clickedTargetIndex;
    applyReferenceFocus(data, next, activeIndex, nextSelection, markerIndex);
  }

  function selectReferencePropEffect(sourceIndex: number, additive = false): boolean {
    if (!active || store.currentMode !== 'effects' || referenceState.status !== 'ready') return false;
    const data = referenceState.data;
    const instance = data.instances.find(item => item.index === sourceIndex);
    if (!instance) return false;
    if (!referenceHostSelection(data, instance) && !referenceIncomingEffectCalls(data, instance.index).length) return false;
    toggleReferenceFocus(data, [instance.index], additive, null);
    return true;
  }

  /** Props-mode reference shortcut: skip the caller inspector and open the first resolved remote effect on
   * the native prop that receives it. The ordinary Run-node button remains available when there are several. */
  function selectReferenceCalledEffect(sourceIndex: number): boolean {
    if (!active || store.currentMode !== 'effects' || referenceState.status !== 'ready') return false;
    const data = referenceState.data;
    const entry = referenceOutgoingEffectCalls(data, sourceIndex)
      .find(candidate => !!candidate.call.target && !!candidate.call.graph);
    if (!entry?.call.target || !entry.call.graph) return false;
    openReferenceGraphOnModel(data, entry.call.target.index, entry.call.graph, entry.call.graph.nodes[0], sourceIndex);
    return true;
  }

  function referenceClipContext(data: ReferenceEffectsData): ClipContext | null {
    const sourceIndex = referenceFocus.activeInstanceIndex;
    const current = referenceFocus.selection;
    if (sourceIndex === null || !current?.nodeId) return null;
    const node = effectNode(data.document, current);
    // The timeline belongs to the child model's actual Property Anim Object node. A parent Run node only
    // exposes Go to effect; it no longer proxies animation state owned by another graph and placement.
    const effect = node ? animObjectFromNode(node) : null;
    const clip = effect ? viewport.referenceAnimObjectClip(sourceIndex) : null;
    return effect && clip
      ? {
        key: ['reference', data.level, sourceIndex, current.ownerId, current.nodeId].join(':'),
        clip,
        effect,
        target: {
          kind: 'reference',
          title: 'Model animation · read only',
          seed: sourceIndex + 1,
          scrub: frame => { viewport.setReferenceAnimObjectScrubFrame(sourceIndex, frame); },
          showPath: on => { viewport.showReferenceAnimObjectPath(on ? sourceIndex : null); },
          stopPreview: () => viewport.stopReferenceEffectPreview(),
        },
      }
      : null;
  }

  /**
   * The same timeline for an AUTHORED placement's Model clip node. An imported GLB can declare a spin
   * (docs/032), so a custom prop now carries the embedded curves this panel reads — and inspecting one
   * should not mean going and finding the reference level it was modelled after.
   *
   * The differences from the reference side are all in the target: there is no recovered trajectory to
   * draw (that decoration belongs to the reference decor layer), and no preview to stop, because an
   * authored scrub already outranks every player in `stepWorldEffects` rather than racing them.
   */
  function authoredClipContext(document: EffectsDocument, node: EffectNode): ClipContext | null {
    const effect = animObjectFromNode(node);
    const propId = selectedAttachmentProp(document)?.id;
    const clip = effect && propId ? viewport.authoredAnimObjectClip(propId) : null;
    if (!effect || !clip || !propId) return null;
    // Same FNV-1a over the placement id the viewport's own preview seeds with, so the panel and the
    // ambient playback agree on where in the clip this particular placement sits.
    let seed = 0x811c9dc5;
    for (let i = 0; i < propId.length; i++) seed = Math.imul(seed ^ propId.charCodeAt(i), 0x01000193);
    return {
      key: ['authored', propId, node.id].join(':'),
      clip,
      effect,
      target: {
        kind: 'authored',
        title: 'Model animation',
        seed: seed >>> 0,
        scrub: frame => { viewport.setAuthoredAnimObjectScrubFrame(propId, frame); },
        showPath: () => {},
        stopPreview: () => {},
      },
    };
  }

  function ensureClipViewer(context: ClipContext): ClipViewerState {
    if (clipViewer?.key === context.key) return clipViewer;
    disposeClipViewer();
    clipViewer = {
      ...context,
      playback: createAnimObjectPlayback(context.effect, context.clip.clipFrames, context.target.seed),
      playing: false,
      loopPreview: context.effect.loopMode !== 0,
      engaged: false,
      lastTime: 0,
      raf: null,
    };
    context.target.showPath(true);
    applyClipFrame(clipViewer);
    return clipViewer;
  }

  function applyClipFrame(viewer: ClipViewerState, stopGraphPreview = false): void {
    if (stopGraphPreview) viewer.target.stopPreview();
    viewer.engaged = true;
    viewer.target.scrub(viewer.playback.frame);
    updateClipViewerDom?.();
  }

  function clipTick(now: number): void {
    const viewer = clipViewer;
    if (!viewer?.playing) return;
    const dt = Math.min(0.1, Math.max(0, (now - viewer.lastTime) / 1000));
    viewer.lastTime = now;
    const playbackEffect = viewer.loopPreview
      ? { ...viewer.effect, loopMode: viewer.effect.loopMode || 1 }
      : { ...viewer.effect, loopMode: 0 };
    stepAnimObjectPlayback(viewer.playback, playbackEffect, dt);
    applyClipFrame(viewer);
    const finished = !viewer.loopPreview && (viewer.playback.direction > 0
      ? viewer.playback.frame >= viewer.playback.endFrame - 1e-6
      : viewer.playback.frame <= viewer.playback.startFrame + 1e-6);
    if (finished) {
      viewer.playing = false;
      viewer.raf = null;
      updateClipViewerDom?.();
      return;
    }
    viewer.raf = requestAnimationFrame(clipTick);
  }

  function playClip(viewer: ClipViewerState): void {
    if (viewer.playing) {
      stopClipViewer(false);
      return;
    }
    const atEnd = viewer.playback.direction > 0
      ? viewer.playback.frame >= viewer.playback.endFrame - 1e-6
      : viewer.playback.frame <= viewer.playback.startFrame + 1e-6;
    if (!viewer.loopPreview && atEnd)
      viewer.playback = createAnimObjectPlayback(viewer.effect, viewer.clip.clipFrames, viewer.target.seed);
    viewer.target.stopPreview();
    viewer.playing = true;
    viewer.lastTime = performance.now();
    applyClipFrame(viewer);
    viewer.raf = requestAnimationFrame(clipTick);
  }

  function restartClip(viewer: ClipViewerState): void {
    viewer.playback = createAnimObjectPlayback(viewer.effect, viewer.clip.clipFrames, viewer.target.seed);
    viewer.lastTime = performance.now();
    applyClipFrame(viewer, true);
  }

  function formatClipValue(value: number, channel: PropModelAnimationChannel): string {
    const rounded = Math.abs(value) < 0.05 ? 0 : value;
    return `${rounded.toFixed(1)} ${channel.unit === 'deg' ? '°' : 'cm'}`;
  }

  function referenceAnimationPanel(data: ReferenceEffectsData): HTMLElement | null {
    const context = referenceClipContext(data);
    if (!context) { disposeClipViewer(); return null; }
    return clipTimelinePanel(ensureClipViewer(context));
  }

  /** The scrub / play / channel timeline over one model clip, for whichever side `viewer.target` drives. */
  function clipTimelinePanel(viewer: ClipViewerState): HTMLElement {
    const channels = propModelAnimationChannels(viewer.clip);
    const s = section(viewer.target.title);
    const clipSeconds = viewer.clip.clipFrames / 30;
    const windowFrames = viewer.playback.endFrame - viewer.playback.startFrame;
    const cycleFrames = windowFrames * (viewer.effect.loopMode === 2 ? 2 : 1);
    const playbackSeconds = viewer.playback.framesPerSecond > 0 ? cycleFrames / viewer.playback.framesPerSecond : 0;
    s.body.append(
      el('div', 'sp-fx-summary', `${viewer.clip.clipFrames.toFixed(0)} frames · ${clipSeconds.toFixed(2)} s clip · ${playbackSeconds.toFixed(2)} s at ${viewer.playback.framesPerSecond.toFixed(1)} fps`),
      el('div', 'sp-fx-note', 'Markers show where the curve changes direction, which is not always where the animator put a keyframe.'),
    );

    const actions = el('div', 'sp-fx-actions sp-fx-clip-actions');
    const play = button('', 'Play or pause this model clip while holding its pose in the viewport.', () => playClip(viewer));
    const restart = button('↺ Restart', 'Return to this prop’s starting frame.', () => restartClip(viewer));
    const loop = button('Loop', 'Keep repeating the clip while previewing.', () => {
      viewer.loopPreview = !viewer.loopPreview;
      updateClipViewerDom?.();
    });
    actions.append(play, restart, loop);
    s.body.appendChild(actions);

    const timeline = el('div', 'sp-fx-clip-timeline');
    const frameReadout = el('output', 'sp-fx-clip-readout');
    frameReadout.setAttribute('aria-live', 'polite');
    const range = el('input', 'sp-fx-clip-range');
    range.type = 'range'; range.min = '0'; range.max = String(viewer.clip.clipFrames); range.step = '0.1';
    range.setAttribute('aria-label', 'Model animation frame');
    range.oninput = () => {
      stopClipViewer(false);
      viewer.playback.frame = Number(range.value);
      viewer.playback.direction = viewer.effect.reverse ? -1 : 1;
      applyClipFrame(viewer, true);
    };
    const ruler = el('div', 'sp-fx-clip-ruler');
    ruler.append(el('span', '', '0'), el('span', '', `${(viewer.clip.clipFrames / 2).toFixed(0)}`),
      el('span', '', `${viewer.clip.clipFrames.toFixed(0)} frames`));
    timeline.append(frameReadout, range, ruler);

    const channelViews: { channel: PropModelAnimationChannel; playhead: HTMLElement; fill: HTMLElement; value: HTMLElement }[] = [];
    const playWindowStartPct = 100 * viewer.playback.startFrame / Math.max(1, viewer.clip.clipFrames);
    for (const channel of channels) {
      const channelRow = el('div', 'sp-fx-clip-channel');
      const label = el('div', 'sp-fx-clip-channel-label');
      label.append(el('span', '', channel.label), el('small', '', `${channel.segments} cubic${channel.segments === 1 ? '' : 's'}`));
      const track = el('div', 'sp-fx-clip-track');
      const windowWidth = 100 * windowFrames / Math.max(1, viewer.clip.clipFrames);
      const window = el('span', 'sp-fx-clip-window');
      window.style.left = `${playWindowStartPct}%`; window.style.width = `${windowWidth}%`;
      const fill = el('span', 'sp-fx-clip-fill');
      fill.style.left = `${playWindowStartPct}%`;
      const playhead = el('span', 'sp-fx-clip-playhead');
      track.append(window, fill);
      for (const frame of channel.boundaryFrames) {
        const marker = el('span', 'sp-fx-clip-key');
        marker.style.left = `${100 * frame / Math.max(1, viewer.clip.clipFrames)}%`;
        marker.title = `Curve boundary · frame ${frame.toFixed(1)}`;
        track.appendChild(marker);
      }
      track.appendChild(playhead);
      const value = el('span', 'sp-fx-clip-value');
      channelRow.append(label, track, value);
      timeline.appendChild(channelRow);
      channelViews.push({ channel, playhead, fill, value });
    }
    // The cyan trajectory is drawn by the reference decor layer, so only that side gets its legend.
    if (viewer.target.kind === 'reference' && channels.some(channel => channel.kind === 'translate'))
      timeline.appendChild(el('div', 'sp-fx-clip-path-note', 'Cyan: the path it travels · pale dots: curve boundaries · amber: where it is now'));
    s.body.appendChild(timeline);

    updateClipViewerDom = () => {
      if (clipViewer !== viewer) return;
      const frame = viewer.playback.frame;
      const pct = 100 * frame / Math.max(1, viewer.clip.clipFrames);
      range.value = String(frame);
      frameReadout.textContent = `Frame ${frame.toFixed(1)} / ${viewer.clip.clipFrames.toFixed(0)} · ${(frame / 30).toFixed(2)} s`;
      play.textContent = viewer.playing ? '⏸ Pause' : '▶ Play';
      loop.classList.toggle('on', viewer.loopPreview);
      loop.setAttribute('aria-pressed', String(viewer.loopPreview));
      for (const view of channelViews) {
        view.playhead.style.left = `${pct}%`;
        view.fill.style.width = `${Math.max(0, pct - playWindowStartPct)}%`;
        view.value.textContent = formatClipValue(
          samplePropModelAnimationChannel(viewer.clip, view.channel.id, frame), view.channel);
      }
    };
    updateClipViewerDom();
    return s.root;
  }

  function referenceSplineContext(data: ReferenceEffectsData): {
    key: string; sourceIndex: number; command: ReferenceSplineCommand;
  } | null {
    const sourceIndex = referenceFocus.activeInstanceIndex;
    const current = referenceFocus.selection;
    if (sourceIndex === null || !current?.nodeId) return null;
    const node = effectNode(data.document, current);
    const command = node ? effectPlayCommand(node) : null;
    return command?.kind === 'spline-motion' && command.spline
      ? { key: `${data.level}:${sourceIndex}:${node!.id}:${command.spline}`, sourceIndex, command }
      : null;
  }

  function applyReferenceSplineDistance(viewer: ReferenceSplineViewerState, stopGraphPreview = false): void {
    if (stopGraphPreview) viewport.stopReferenceEffectPreview();
    viewer.engaged = viewport.setReferenceSplineMotionDistance(
      viewer.sourceIndex, viewer.command, viewer.distance);
    updateReferenceSplineViewerDom?.();
  }

  function ensureReferenceSplineViewer(context: NonNullable<ReturnType<typeof referenceSplineContext>>):
    ReferenceSplineViewerState | null {
    if (referenceSplineViewer?.key === context.key) return referenceSplineViewer;
    disposeReferenceSplineViewer();
    const info = viewport.referenceSplineMotionInfo(context.sourceIndex, context.command);
    if (!info) return null;
    const direction = context.command.speed < 0 ? -1 : 1;
    referenceSplineViewer = {
      ...context, info,
      distance: 0,
      direction,
      playing: false,
      loopPreview: context.command.endMode !== 0 && context.command.endMode !== 3,
      engaged: false,
      lastTime: 0,
      raf: null,
    };
    applyReferenceSplineDistance(referenceSplineViewer);
    return referenceSplineViewer;
  }

  function referenceSplineTick(now: number): void {
    const viewer = referenceSplineViewer;
    if (!viewer?.playing) return;
    const dt = Math.min(0.1, Math.max(0, (now - viewer.lastTime) / 1000));
    viewer.lastTime = now;
    const endMode = viewer.loopPreview
      ? (viewer.command.endMode === 2 ? 2 : 1)
      : (viewer.command.endMode === 3 ? 3 : 0);
    const next = stepSplineMotionDistance(viewer.distance, viewer.direction,
      viewer.command.speed, dt, viewer.info.length, endMode);
    viewer.distance = next.distance;
    viewer.direction = next.direction;
    applyReferenceSplineDistance(viewer);
    if (next.stopped || Math.abs(viewer.command.speed) < 1e-8) {
      viewer.playing = false;
      viewer.raf = null;
      updateReferenceSplineViewerDom?.();
      return;
    }
    viewer.raf = requestAnimationFrame(referenceSplineTick);
  }

  function playReferenceSpline(viewer: ReferenceSplineViewerState): void {
    if (viewer.playing) {
      stopReferenceSplineViewer(false);
      return;
    }
    const atEnd = viewer.direction > 0
      ? viewer.distance >= viewer.info.length - 1e-6
      : viewer.distance <= 1e-6;
    if (!viewer.loopPreview && atEnd) {
      viewer.direction = viewer.command.speed < 0 ? -1 : 1;
      viewer.distance = 0;
    }
    viewport.stopReferenceEffectPreview();
    viewer.playing = Math.abs(viewer.command.speed) > 1e-8;
    viewer.lastTime = performance.now();
    applyReferenceSplineDistance(viewer);
    if (viewer.playing) viewer.raf = requestAnimationFrame(referenceSplineTick);
  }

  function restartReferenceSpline(viewer: ReferenceSplineViewerState): void {
    stopReferenceSplineViewer(false);
    viewer.direction = viewer.command.speed < 0 ? -1 : 1;
    viewer.distance = 0;
    viewer.lastTime = performance.now();
    applyReferenceSplineDistance(viewer, true);
  }

  function referenceSplineAnimationPanel(data: ReferenceEffectsData): HTMLElement | null {
    const context = referenceSplineContext(data);
    if (!context) { disposeReferenceSplineViewer(); return null; }
    const viewer = ensureReferenceSplineViewer(context);
    if (!viewer) return null;
    const s = section('Spline motion · read only');
    s.root.classList.add('sp-fx-spline-panel');
    const speed = Math.abs(viewer.command.speed);
    const lapSeconds = speed > 1e-8 ? viewer.info.length / speed : 0;
    s.body.append(
      el('div', 'sp-fx-summary', `Spline #${String(viewer.info.originalIndex).padStart(4, '0')} · ${viewer.info.segments} cubic${viewer.info.segments === 1 ? '' : 's'} · ${viewer.info.length.toFixed(1)} m${speed > 1e-8 ? ` · ${lapSeconds.toFixed(2)} s one way at ${speed.toFixed(1)} m/s` : ' · stationary'}`),
      el('div', 'sp-fx-note', 'This is an external world-space route. It moves the complete prop; it is separate from animation stored inside the model.'),
      el('div', 'sp-fx-spline-meta', `${splineEndModeLabel(viewer.command.endMode)} · ${splineOrientationModeLabel(viewer.command.orientationMode)} · yaw offset ${(viewer.command.yawOffset * 180 / Math.PI).toFixed(1)}° · ${viewer.command.instanceCount} instance${viewer.command.instanceCount === 1 ? '' : 's'}`),
    );

    const actions = el('div', 'sp-fx-actions sp-fx-clip-actions');
    const play = button('', 'Play or pause this prop along its recovered spline.', () => playReferenceSpline(viewer));
    play.disabled = speed <= 1e-8;
    const restart = button('↺ Restart', 'Return to the start of this route.', () => restartReferenceSpline(viewer));
    const loop = button('Loop', 'Keep travelling the route while previewing.', () => {
      viewer.loopPreview = !viewer.loopPreview;
      updateReferenceSplineViewerDom?.();
    });
    actions.append(play, restart, loop);
    s.body.appendChild(actions);

    const timeline = el('div', 'sp-fx-clip-timeline');
    const readout = el('output', 'sp-fx-clip-readout');
    readout.setAttribute('aria-live', 'polite');
    const range = el('input', 'sp-fx-clip-range');
    range.type = 'range'; range.min = '0'; range.max = String(viewer.info.length); range.step = '0.1';
    range.setAttribute('aria-label', 'Spline distance');
    range.oninput = () => {
      stopReferenceSplineViewer(false);
      viewer.distance = Number(range.value);
      viewer.direction = viewer.command.speed < 0 ? -1 : 1;
      applyReferenceSplineDistance(viewer, true);
    };
    const ruler = el('div', 'sp-fx-clip-ruler');
    ruler.append(el('span', '', '0'), el('span', '', `${(viewer.info.length / 2).toFixed(0)}`),
      el('span', '', `${viewer.info.length.toFixed(0)} m`));
    timeline.append(readout, range, ruler);

    const channelRow = el('div', 'sp-fx-clip-channel');
    const label = el('div', 'sp-fx-clip-channel-label');
    label.append(el('span', '', 'Route'), el('small', '', `${viewer.info.segments} cubic${viewer.info.segments === 1 ? '' : 's'}`));
    const track = el('div', 'sp-fx-clip-track');
    const window = el('span', 'sp-fx-clip-window'); window.style.left = '0'; window.style.width = '100%';
    const fill = el('span', 'sp-fx-clip-fill');
    const playhead = el('span', 'sp-fx-clip-playhead');
    track.append(window, fill);
    for (const distance of viewer.info.segmentDistances) {
      const marker = el('span', 'sp-fx-clip-key');
      marker.style.left = `${100 * distance / Math.max(1e-8, viewer.info.length)}%`;
      marker.title = `Cubic boundary · ${distance.toFixed(1)} m`;
      track.appendChild(marker);
    }
    track.appendChild(playhead);
    const value = el('span', 'sp-fx-clip-value');
    channelRow.append(label, track, value);
    timeline.append(channelRow,
      el('div', 'sp-fx-clip-path-note', 'Purple: the route · dark lines: control handles · pale dots: curve boundaries · amber: where it is now'));
    s.body.appendChild(timeline);

    updateReferenceSplineViewerDom = () => {
      if (referenceSplineViewer !== viewer) return;
      const pct = 100 * viewer.distance / Math.max(1e-8, viewer.info.length);
      range.value = String(viewer.distance);
      readout.textContent = `Distance ${viewer.distance.toFixed(1)} / ${viewer.info.length.toFixed(1)} m${speed > 1e-8 ? ` · ${(viewer.distance / speed).toFixed(2)} s` : ''}`;
      play.textContent = viewer.playing ? '⏸ Pause' : '▶ Play';
      loop.classList.toggle('on', viewer.loopPreview);
      loop.setAttribute('aria-pressed', String(viewer.loopPreview));
      playhead.style.left = `${pct}%`;
      fill.style.width = `${pct}%`;
      value.textContent = `${viewer.distance.toFixed(1)} m`;
    };
    updateReferenceSplineViewerDom();
    return s.root;
  }

  const shortNumber = (value: number, digits = 2): string => {
    const rounded = Number(value.toFixed(digits));
    return Number.isFinite(rounded) ? String(rounded) : String(value);
  };

  const vectorLabel = (value: readonly number[]): string =>
    `(${value.map(component => shortNumber(component, 1)).join(', ')})`;

  const emitterRangeLabel = (center: number, span: number, suffix: string): string => {
    const half = Math.max(0, span) * 0.5;
    return `${shortNumber(Math.max(0, center - half))}–${shortNumber(Math.max(0, center + half))} ${suffix}`;
  };

  /** Present one native particle-emitter node as the useful visual overview. When its owner is a classified
   * firework graph, identify the layer but keep the other layers and firing sounds on their own nodes. */
  function addReferenceParticleOverview(body: HTMLElement, data: ReferenceEffectsData, node: EffectNode): boolean {
    const law = timerEmitterPreviewLaw(node);
    if (!law) return false;
    const current = referenceFocus.selection;
    const graph = current?.ownerKind === 'graph'
      ? data.document.graphs.find(candidate => candidate.id === current.ownerId) : null;
    const firework = graph ? referenceFireworkEffect(graph) : null;
    const layerIndex = firework ? firework.layers.findIndex(layer => layer.node.id === node.id) : -1;
    const fields = particleEmitterFields(node);
    const rawTrails = typeof fields?.U1 === 'number' ? fields.U1 : law.trailCopies;
    const sprite = PARTICLE_SPRITE_NAMES[law.spriteIndex] ?? `sprite ${law.spriteIndex}`;
    const blend = emitterBlendLabel(law.blendSelector);
    const card = el('div', 'sp-fx-emitter-card');
    const heading = el('div', 'sp-fx-emitter-head');
    heading.append(el('strong', '', firework && layerIndex >= 0
      ? `Firework particle layer ${layerIndex + 1} of ${firework.layers.length}`
      : node.semanticType === 'particle.collision' ? 'Snow collision burst' : 'Particle overview'),
      el('span', '', `${sprite} · ${blend}`));
    card.appendChild(heading);
    if (firework) {
      const summary = el('div', 'sp-fx-summary sp-fx-summary-help');
      summary.append(el('span', '', `${law.count} logical particles · ${shortNumber(law.emissionDuration)} s emission`),
        helpIcon(`This effect has ${firework.layers.length} particle layer${firework.layers.length === 1 ? '' : 's'} and ${firework.sounds.length} firing sound${firework.sounds.length === 1 ? '' : 's'}. Preview effect on the model runs the complete graph together; this node remains an individually inspectable layer.`,
          'Firework layer behavior'));
      card.appendChild(summary);
    }
    const metrics = el('div', 'sp-fx-emitter-metrics');
    const metric = (label: string, value: string) => {
      const item = el('div', 'sp-fx-emitter-metric');
      item.append(el('small', '', label), el('span', '', value));
      metrics.appendChild(item);
    };
    metric('Particles', String(law.count));
    metric('Emission window', `${shortNumber(law.emissionDuration)} s`);
    metric('Trail copies', `${shortNumber(rawTrails, 0)} × ${shortNumber(law.trailStep, 3)} s`);
    metric('Particle life', emitterRangeLabel(law.particleLifeCenter, law.particleLifeSpan, 's'));
    metric('Sprite size', emitterRangeLabel(law.sizeCenter, law.sizeSpan, 'cm'));
    metric('Time scale', shortNumber(law.timeScale));
    metric(node.semanticType === 'particle.collision' ? 'Normal speed' : 'Base velocity',
      node.semanticType === 'particle.collision'
        ? `${shortNumber(Math.hypot(...law.velocityBase))} cm/s` : vectorLabel(law.velocityBase));
    metric('Gravity', vectorLabel(law.gravity));
    card.appendChild(metrics);
    if (node.semanticType === 'particle.collision') card.appendChild(el('div', 'sp-fx-note',
      'At runtime the exact hit point replaces the stored origin, and the outward hit normal replaces the base-velocity direction. The authored vector contributes only its length; velocity variation remains authored.'));

    const ramp = el('div', 'sp-fx-emitter-ramp');
    ramp.appendChild(el('small', 'sp-fx-emitter-ramp-label', 'RGBA over particle life'));
    for (const [stopIndex, stop] of law.colors.entries()) {
      const entry = el('div', 'sp-fx-emitter-stop');
      const swatch = el('span', 'sp-fx-emitter-swatch');
      const rgb = stop.slice(0, 3).map(component => Math.round(255 * Math.max(0, Math.min(1, component))));
      swatch.style.backgroundColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      entry.append(swatch, el('span', '', `${stopIndex + 1}`),
        el('code', '', `${stop.slice(0, 3).map(component => shortNumber(component)).join(', ')} · α ${shortNumber(stop[3])}`));
      ramp.appendChild(entry);
    }
    card.appendChild(ramp);
    const details = el('details', 'sp-fx-disclosure');
    details.appendChild(el('summary', '', 'All recovered emitter properties'));
    const detailsBody = el('div', 'sp-fx-disclosure-body');
    addKnownSemanticFields(detailsBody, node, true);
    details.appendChild(detailsBody);
    card.appendChild(details);
    if (referenceFocus.activeInstanceIndex !== null) {
      const sourceIndex = referenceFocus.activeInstanceIndex;
      const collisionEmitter = node.semanticType === 'particle.collision';
      const preview = el('div', 'sp-fx-emitter-preview-actions');
      preview.append(button(collisionEmitter ? '▶ Preview burst' : '▶ Preview timer', collisionEmitter
        ? 'Preview only this snow collision burst on the selected model.'
        : 'Preview only this particle timer on the selected model.', () => {
        if (!viewport.previewReferenceTimerNode(sourceIndex, node, !collisionEmitter && law.emissionDuration < 0))
          toast(`This particle ${collisionEmitter ? 'burst' : 'timer'} could not be previewed.`, 'err');
      }), button('■ Stop', 'Stop the current particle preview.', () => viewport.stopReferenceEffectPreview()));
      card.appendChild(preview);
    }
    body.appendChild(card);
    return true;
  }

  function addReferenceSemanticFields(body: HTMLElement, data: ReferenceEffectsData, node: EffectNode): void {
    body.append(row('Stable ID', input(node.id, () => {}, { readonly: true })),
      row('Semantic type', input(node.semanticType ?? '', () => {}, { readonly: true })));
    const call = referenceInstanceEffectCall(data, node);
    if (call) {
      if (!call.target || !call.graph) body.appendChild(el('div', 'sp-fx-note warn',
        'This call does not say which prop or which effect it means.'));
      const effectControl = el('div', 'sp-fx-input-help');
      effectControl.append(input(call.graphLabel, () => {}, { readonly: true }),
        helpIcon('A Run node runs this effect on the target prop. The target is what decides where in the world it happens.',
          'Run node behavior'));
      body.append(
        row('Target prop', input(call.targetLabel, () => {}, { readonly: true }),
          'The prop that receives the call, and whose position the effect runs at.'),
        row('Runs effect', effectControl,
          'The effect that runs on the target prop.'),
      );
      if (call.target && call.graph) {
        const target = call.target;
        const graph = call.graph;
        body.appendChild(calledModelPreview.showModel(data.level, target.model));
        const actions = el('div', 'sp-fx-actions');
        actions.appendChild(navigationButton('Go to effect', MODE_ICON.effects,
          'Open the called effect on its target model.',
          () => openReferenceGraphOnModel(data, target.index, graph, graph.nodes[0],
            referenceFocus.activeInstanceIndex)));
        body.appendChild(actions);
      }
    } else if (!addReferenceParticleOverview(body, data, node)) addKnownSemanticFields(body, node, true);
    addReferenceSoundPreview(body, data.level, node);
    if (node.references && Object.keys(node.references).length) {
      for (const [key, value] of Object.entries(node.references)) {
        if (call && (key === 'instance' || key === 'effectGraph')) continue;
        body.append(row(`${key} ref`, input(value ?? '(none)', () => {}, { readonly: true })));
      }
    }
  }

  function referenceSelectionListPanel(data: ReferenceEffectsData): HTMLElement | null {
    if (referenceFocus.instanceIndices.length < 2) return null;
    const instances = referenceFocus.instanceIndices
      .map(index => data.instances.find(candidate => candidate.index === index))
      .filter((instance): instance is ReferenceEffectInstance => !!instance)
      .sort((a, b) => a.name.localeCompare(b.name));
    return effectHostListPanel(instances.map(instance => ({
      label: instance.name,
      meta: `#${instance.index} · model #${instance.model}`,
      active: referenceFocus.activeInstanceIndex === instance.index,
      title: 'Inspect this selected effect host without dropping the multi-selection.',
      select: () => {
        const relationSelection = referenceFocus.markerIndex === null ? null
          : referenceTargetSelection(data, referenceFocus.markerIndex, instance.index);
        const nextSelection = relationSelection ?? referenceHostSelection(data, instance);
        referenceFocus = { ...referenceFocus, activeInstanceIndex: instance.index, selection: nextSelection,
          callerIndex: null,
          markerIndex: referenceFocus.markerIndex
            ?? referenceSelectionTargetIndex(data, nextSelection) ?? instance.index };
        viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, referenceFocus.markerIndex);
        render();
      },
    })), 'Several props are selected. Click one below to inspect its effects; Ctrl/Cmd-click in the viewport to add or remove props.');
  }

  /**
   * The effects that act on this prop from nowhere in particular — a shared function the engine runs rather
   * than any placement (`referenceUnhostedIncomingEffectCalls`).
   *
   * This is what a purple rail tube on GARI has been trying to say. The tube carries no slot of its own, so
   * the caller-centric tree below has no branch to draw; the node hiding it lives in `HideShowOff`, which
   * `FreerideMode` and `RaceMode` call at mode select. Showing the owning function directly is the honest
   * answer to "why is this highlighted" — and it is the same pairing the rail-spline panel offers in reverse.
   */
  function appendReferenceUnhostedCalls(tree: HTMLElement, data: ReferenceEffectsData,
    targetIndex: number): void {
    const entries = referenceUnhostedIncomingEffectCalls(data, targetIndex);
    if (!entries.length) return;
    const group = el('div', 'sp-fx-tree-group sp-fx-tree-caller-group');
    group.appendChild(el('div', 'sp-fx-tree-caption', 'Acted on by'));
    for (const entry of entries) {
      const active = referenceFocus.selection?.ownerId === entry.owner.id
        && referenceFocus.selection?.nodeId === entry.node.id;
      const item = el('button', `sp-fx-attachment sp-fx-tree-actor${active ? ' on' : ''}`);
      item.type = 'button';
      item.title = `Inspect ${entry.owner.name ?? entry.owner.id} · ${referenceNodeDisplayName(data, entry.node)}`
        + '. Nothing with an effect slot calls it — the engine runs it (mode select, level start), so it has '
        + 'no caller prop to hang it under.';
      item.onclick = () => {
        viewport.stopReferenceEffectPreview();
        referenceUnassignedOpen = false;
        referenceFocus = { ...referenceFocus, callerIndex: null, markerIndex: targetIndex,
          selection: { ownerKind: entry.ownerKind, ownerId: entry.owner.id, nodeId: entry.node.id } };
        viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, targetIndex);
        render();
      };
      // The owner's NAME is the answer to "what acts on this" (HideShowOff, HideStartGate, CountDownStart),
      // so it gets the flexible column. The node's own `Run <this prop> → …` label is redundant on the prop
      // it names, so the tag says which kind of effect it is and the full label rides the tooltip.
      item.append(el('span', 'sp-fx-node-index', '⇢'),
        el('span', 'sp-fx-list-name', entry.owner.name ?? entry.owner.id),
        el('span', 'sp-fx-kind', entry.ownerKind === 'function' ? 'shared' : 'effect'));
      group.appendChild(item);
    }
    group.appendChild(el('div', 'sp-fx-note', 'No prop calls these — the engine runs them (mode select, level '
      + 'start). They are why this prop is highlighted even though it carries no effect of its own.'));
    tree.appendChild(group);
  }

  /** Append caller -> remote effect branches to the same tree used by direct slot effects. The selected
   * effect's nodes live in its action panel below, keeping this tree focused on relationships. */
  function appendReferenceIncomingEffectTree(tree: HTMLElement, data: ReferenceEffectsData,
    targetIndex: number): void {
    appendReferenceUnhostedCalls(tree, data, targetIndex);
    for (const caller of referenceIncomingEffectTree(data, targetIndex)) {
      const callerGroup = el('div', 'sp-fx-tree-group sp-fx-tree-caller-group');
      const firstEntry = caller.entries[0];
      const firstGraph = caller.effects.find(effect => !!effect.graph)?.graph ?? null;
      const callerActive = referenceFocus.callerIndex === caller.instance.index;
      // A caller that runs exactly one resolved effect says the whole relationship on its own row, and its
      // child would only repeat it. Keep the branch whenever there is a choice of effect to make, or an
      // unresolved reference — that broken row is the only place the break is visible.
      const soleEffect = caller.effects.length === 1 ? caller.effects[0] : null;
      const soleGraph = soleEffect?.graph ?? null;
      const callerRow = el('button', `sp-fx-attachment sp-fx-tree-caller${callerActive ? ' on' : ''}`);
      callerRow.type = 'button';
      callerRow.title = firstGraph
        ? soleGraph
          ? `Select the effect ${caller.instance.name} runs on this model.`
          : `Select the first effect called by ${caller.instance.name} on this model.`
        : `Inspect ${caller.instance.name}'s effect call, which does not say what it means.`;
      callerRow.onclick = () => {
        if (firstGraph) {
          openReferenceGraphOnModel(data, targetIndex, firstGraph, firstGraph.nodes[0], caller.instance.index);
          return;
        }
        applyReferenceFocus(data, [caller.instance.index], caller.instance.index, {
          ownerKind: firstEntry.ownerKind, ownerId: firstEntry.owner.id, nodeId: firstEntry.node.id,
        }, targetIndex);
      };
      const effectLabel = soleGraph
        ? `${countLabel(soleGraph.nodes.length, 'node')}${soleEffect!.entries.length > 1 ? ` · ${countLabel(soleEffect!.entries.length, 'call')}` : ''}`
        : countLabel(caller.effects.length, 'effect');
      // "Run by" names the relationship rather than the prop, so a caller row cannot be misread as one of
      // this prop's own effects in the same tree. It is the Run node's sentence from the receiving end.
      callerRow.append(el('span', 'sp-fx-list-name', `Run by ${caller.instance.name}`),
        el('span', 'sp-fx-node-index', '↗'),
        el('span', 'sp-fx-kind', `#${caller.instance.index} · ${effectLabel}`));
      callerGroup.appendChild(callerRow);
      for (const effect of soleGraph ? [] : caller.effects) {
        const graph = effect.graph;
        const graphActive = !!graph && referenceFocus.selection?.ownerKind === 'graph'
          && referenceFocus.selection.ownerId === graph.id
          && (referenceFocus.callerIndex === null || referenceFocus.callerIndex === caller.instance.index);
        const effectRow = el('button', `sp-fx-attachment sp-fx-tree-effect sp-fx-tree-called-effect${graphActive ? ' on' : ''}`);
        effectRow.type = 'button';
        const calls = countLabel(effect.entries.length, 'call');
        if (graph) {
          effectRow.title = `Inspect the effect ${graph.name ?? graph.id} on ${data.instances.find(item => item.index === targetIndex)?.name ?? 'this model'}.`;
          effectRow.onclick = () => openReferenceGraphOnModel(data, targetIndex, graph,
            graph.nodes[0], caller.instance.index);
          effectRow.append(el('span', 'sp-fx-list-name', graph.name ?? graph.id),
            el('span', 'sp-fx-kind', `${countLabel(graph.nodes.length, 'node')} · ${calls}`));
        } else {
          const entry = effect.entries[0];
          effectRow.title = 'Inspect the Run node with the unresolved remote effect reference.';
          effectRow.onclick = () => applyReferenceFocus(data, [caller.instance.index], caller.instance.index, {
            ownerKind: entry.ownerKind, ownerId: entry.owner.id, nodeId: entry.node.id,
          }, targetIndex);
          effectRow.append(el('span', 'sp-fx-list-name', entry.call.graphLabel),
            el('span', 'sp-fx-kind', `Missing effect · ${calls}`));
        }
        callerGroup.appendChild(effectRow);
      }
      tree.appendChild(callerGroup);
    }
  }

  function referenceEffectHostPanel(data: ReferenceEffectsData): HTMLElement | null {
    const instance = referenceFocus.activeInstanceIndex === null ? null
      : data.instances.find(x => x.index === referenceFocus.activeInstanceIndex) ?? null;
    if (!instance) return null;
    const hostName = instance.name;
    const s = section(hostName);
    const bindings = referenceInstanceBindings(data, instance);
    const supplementalOutgoing = referenceSupplementalOutgoingEffectCalls(data, instance.index);
    s.body.append(row('Instance', input(hostName, () => {}, { readonly: true }),
      'The label attached to this exact Instances.json placement. Select the text to copy it.'),
      row('Model slot', input(`#${instance.model} · ${instance.modelName}`, () => {}, { readonly: true }),
        'The raw Models.json slot label. Custom maps can replace the art in this slot without renaming it.'),
      row('Prop number', input(`#${instance.index}`, () => {}, { readonly: true }),
        'This prop’s number in the level. Effects use it to point at a particular prop.'));
    if (referenceSlot(data.document, instance.effectSlotIndex)) s.body.appendChild(
      row('Effects ID', input(`#${instance.effectSlotIndex}`, () => {}, { readonly: true }),
        'The ID this prop uses to find its effects. Shown for cross-referencing; nothing to edit here.'));
    s.body.appendChild(hostPreview.showModel(data.level, instance.model));
    const actions = el('div', 'sp-fx-actions sp-fx-selection-nav');
    actions.append(navigationButton('Go to prop', MODE_ICON.props,
      'Switch to Props mode with this prop selected.', () => goToProp({ sourceIndex: instance.index })),
      selectionBackButton());
    s.body.appendChild(actions);
    s.root.classList.add('sp-fx-has-inline-back');
    const relationshipTree = bindings.length
      ? effectNodeTree(bindings, referenceFocus.selection, (graph, node) => {
      if (!viewport.isReferenceEffectPreviewing(instance.index, graph.id)) viewport.stopReferenceEffectPreview();
      referenceUnassignedOpen = false;
      const selection = { ownerKind: 'graph' as const, ownerId: graph.id, nodeId: node.id };
      const markerIndex = referenceInstanceEffectCall(data, node)?.target?.index ?? instance.index;
      referenceFocus = { ...referenceFocus, selection, markerIndex, callerIndex: null };
      viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, markerIndex);
      render();
    }, node => referenceNodeDisplayName(data, node), undefined, undefined, graph => {
      if (!viewport.isReferenceEffectPreviewing(instance.index, graph.id)) viewport.stopReferenceEffectPreview();
      referenceUnassignedOpen = false;
      const node = graph.nodes[0];
      const selection: EffectSelection = { ownerKind: 'graph', ownerId: graph.id,
        ...(node ? { nodeId: node.id } : {}) };
      const markerIndex = node
        ? referenceInstanceEffectCall(data, node)?.target?.index ?? instance.index
        : instance.index;
      referenceFocus = { ...referenceFocus,
        selection, markerIndex, callerIndex: null };
      viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, markerIndex);
      render();
    }, false)
      : el('div', 'sp-fx-tree');
    if (supplementalOutgoing.length) {
      const outgoingTree = effectCallTree(supplementalOutgoing, referenceFocus.selection, entry => {
        viewport.stopReferenceEffectPreview();
        referenceUnassignedOpen = false;
        // Open the owner on its first node, the way selecting one of this prop's own effects does, so the
        // card below lands with something inspected rather than empty.
        const node = entry.owner.nodes[0];
        const selection: EffectSelection = { ownerKind: entry.ownerKind, ownerId: entry.owner.id,
          ...(node ? { nodeId: node.id } : {}) };
        const markerIndex = (node ? referenceInstanceEffectCall(data, node)?.target?.index : null)
          ?? instance.index;
        referenceFocus = { ...referenceFocus, selection, markerIndex, callerIndex: null };
        viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, markerIndex);
        render();
      });
      while (outgoingTree.firstChild) relationshipTree.appendChild(outgoingTree.firstChild);
    }
    appendReferenceIncomingEffectTree(relationshipTree, data, instance.index);
    if (relationshipTree.childElementCount) s.body.appendChild(relationshipTree);
    return s.root;
  }

  /** The node list shared by the selected-effect and selected-function cards. Each row opens the inspector
   * below and moves the viewport marker to whatever prop that node acts on, falling back to the host. */
  function referenceOwnerNodeList(data: ReferenceEffectsData, ownerKind: 'graph' | 'function',
    owner: { id: string; nodes: readonly EffectNode[] }, instanceIndex: number,
    selectedNodeId: string | undefined): HTMLElement {
    const nodes = el('div', 'sp-fx-node-list sp-fx-effect-node-list');
    if (owner.nodes.length) nodes.appendChild(el('div', 'sp-fx-tree-caption', 'Nodes'));
    for (const [index, node] of owner.nodes.entries()) {
      const active = selectedNodeId === node.id;
      const item = el('button', `sp-fx-node-row${active ? ' on' : ''}`);
      item.type = 'button';
      item.title = `Inspect ${referenceNodeDisplayName(data, node)}.`;
      item.onclick = () => {
        referenceUnassignedOpen = false;
        const nextSelection: EffectSelection = { ownerKind, ownerId: owner.id, nodeId: node.id };
        const markerIndex = referenceInstanceEffectCall(data, node)?.target?.index ?? instanceIndex;
        referenceFocus = { ...referenceFocus, selection: nextSelection, markerIndex };
        viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, markerIndex);
        render();
      };
      item.append(el('span', 'sp-fx-node-index', String(index + 1)),
        el('span', 'sp-fx-node-name', referenceNodeDisplayName(data, node)),
        el('span', 'sp-fx-kind', `M${node.mainType}`));
      nodes.appendChild(item);
    }
    if (!owner.nodes.length) nodes.appendChild(el('div', 'sp-fx-empty sp-fx-effect-node-empty', 'No nodes'));
    return nodes;
  }

  /** A shared effect this prop's effects call into gets the same card its own effects get. `function` is the
   * wire-format word and stays in the code; the panel says "shared effect", matching the Call shared effect
   * node that reaches it. It carries no circumstance and runs wherever it is called from, so it has no
   * preview: previewing is anchored to one prop, and this list is the part that acts on several. */
  function referenceSelectedFunctionPanel(data: ReferenceEffectsData): HTMLElement | null {
    const selection = referenceFocus.selection;
    if (referenceFocus.activeInstanceIndex === null || selection?.ownerKind !== 'function') return null;
    const instance = data.instances.find(candidate => candidate.index === referenceFocus.activeInstanceIndex);
    const owner = data.document.functions.find(candidate => candidate.id === selection.ownerId);
    if (!instance || !owner) return null;
    // Only while this prop actually reaches it — otherwise a selection left behind by another prop would
    // keep rendering a card for a function the open prop has nothing to do with.
    if (!referenceSupplementalOutgoingEffectCalls(data, instance.index)
      .some(entry => entry.ownerKind === 'function' && entry.owner.id === owner.id)) return null;
    const s = section(`Selected shared effect · ${owner.name || owner.id}`);
    s.root.classList.add('sp-fx-selected-effect', 'sp-fx-child-panel');
    s.body.append(el('div', 'sp-fx-note',
      `Reached by a Call shared effect node in ${instance.name}'s own effect, and it runs alongside that effect rather than inside it. It lives on its own instead of on a prop, so it has no circumstance of its own and cannot be previewed on one prop.`),
      referenceOwnerNodeList(data, 'function', owner, instance.index, selection.nodeId));
    return s.root;
  }

  /** A selected graph owns graph-wide actions even while one of its nodes is open below. Keeping this card
   * separate prevents a prop with several collision/trigger effects from previewing all of them at once. */
  function referenceSelectedEffectPanel(data: ReferenceEffectsData): HTMLElement | null {
    const selection = referenceFocus.selection;
    if (referenceFocus.activeInstanceIndex === null || selection?.ownerKind !== 'graph') return null;
    const instance = data.instances.find(candidate => candidate.index === referenceFocus.activeInstanceIndex);
    const graph = data.document.graphs.find(candidate => candidate.id === selection.ownerId);
    if (!instance || !graph) return null;
    const graphBindings = referenceInstanceBindings(data, instance)
      .filter(binding => binding.graph.id === graph.id);
    const incomingEntries = referenceIncomingEffectCalls(data, instance.index)
      .filter(entry => entry.call.graph?.id === graph.id);
    const isIncoming = incomingEntries.length > 0;
    if (!graphBindings.length && !isIncoming) return null;

    const label = graphBindings.length
      ? effectGraphDisplayName(graph, graphBindings[0].circumstance)
      : graph.name ?? graph.id;
    const s = section(`Selected effect · ${label}`);
    s.root.classList.add('sp-fx-selected-effect', 'sp-fx-child-panel');
    // Directly under the title, because the title is exactly where this is missing: an effect reached from
    // another prop has no circumstance to name, so it shows as a bare graph name with nothing saying what
    // starts it. Same wording as the caller rows in the host tree, and the same reading — from this end.
    const callers = [...new Map(incomingEntries.flatMap(entry => entry.sources)
      .map(source => [source.instance.index, source.instance])).values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index);
    if (callers.length) {
      // A prop reaches its own remote effects through a shared effect, so it can be its own caller — naming
      // it back at itself reads like a second prop. Four names still fit; truncating at three would spend
      // "and 1 other prop" to save one name.
      const named = (limit: number) => callers.slice(0, limit)
        .map(item => `${item.name} #${item.index}`).join(', ');
      s.body.appendChild(el('div', 'sp-fx-note sp-fx-effect-run-by',
        callers.length === 1 && callers[0].index === instance.index
          ? 'Run by this prop\'s own effects.'
          : `Run by ${callers.length > 4
            ? `${named(3)} and ${countLabel(callers.length - 3, 'other prop')}` : named(4)}.`));
    }
    const latchBinding = graphBindings.find(binding => isEffectLatchCircumstance(binding.circumstance));
    if (latchBinding && isEffectLatchCircumstance(latchBinding.circumstance)) s.body.appendChild(
      el('div', 'sp-fx-note', `${EFFECT_LATCH_SUMMARY[latchBinding.circumstance]} ${graph.nodes.length
        ? 'Nodes here run at that moment, instead of the prop resetting itself.'
        : 'Left empty on purpose — having anything in this column at all is the whole signal.'}`));
    const caller = referenceFocus.callerIndex === null ? null
      : data.instances.find(candidate => candidate.index === referenceFocus.callerIndex) ?? null;
    const callerEntry = caller ? incomingEntries.find(entry => entry.sources
      .some(source => source.instance.index === caller.index)) ?? null : null;
    if (caller && callerEntry) {
      s.body.appendChild(callerModelPreview.showModel(data.level, caller.model));
      const callerActions = el('div', 'sp-fx-actions sp-fx-effect-caller-actions');
      callerActions.appendChild(navigationButton('Go to caller', MODE_ICON.props,
        `Open ${caller.name} and the Run node that calls this effect.`, () => {
          applyReferenceFocus(data, [caller.index], caller.index, {
            ownerKind: callerEntry.ownerKind, ownerId: callerEntry.owner.id, nodeId: callerEntry.node.id,
          }, instance.index);
        }));
      s.body.appendChild(callerActions);
    }
    const overview = el('div', 'sp-fx-effect-overview');
    const loops = graphBindings.some(binding => binding.circumstance === 'persistent')
      && effectGraphHasTimerEmitter(data.document, graph);
    const playing = viewport.isReferenceEffectPreviewing(instance.index, graph.id);
    overview.appendChild(button(playing ? '■ Stop effect' : loops ? '▶ Play effect' : '▶ Preview effect',
      playing ? 'Stop this effect preview.'
        : loops ? 'Loop this persistent effect at the selected prop until stopped.'
          : 'Preview only this effect at the selected prop.', () => {
      if (playing) {
        viewport.stopReferenceEffectPreview();
        toast('Effect preview stopped.', 'info');
        render();
        return;
      }
      releaseClipPose();
      releaseReferenceSplinePose();
      if (!viewport.previewReferenceEffects(instance.index, [graph.id], loops ? [graph.id] : [])) {
        toast('This effect could not be previewed on the selected prop.', 'err');
        return;
      }
      toast(`${loops ? 'Playing' : 'Previewing'} ${label}`, 'ok');
      if (loops) render();
    }));
    s.body.append(overview,
      referenceOwnerNodeList(data, 'graph', graph, instance.index, selection.nodeId));
    return s.root;
  }

  function referenceValidationPanel(data: ReferenceEffectsData): HTMLElement {
    const issues = validateEffectsAuthoring(data.document);
    const s = section(`Validation · ${issues.length || 'clean'}`);
    if (!issues.length) s.body.appendChild(el('div', 'sp-fx-valid', 'No structural, reference, attachment, or semantic-range issues.'));
    else {
      for (const issue of issues.slice(0, 12)) {
        const item = el('div', `sp-fx-issue ${issue.severity}`);
        item.append(el('strong', '', issue.severity), el('span', '', issue.message), el('code', '', issue.path));
        s.body.appendChild(item);
      }
      if (issues.length > 12) s.body.appendChild(el('div', 'sp-fx-note', `${issues.length - 12} more issues.`));
    }
    return s.root;
  }

  function selectionBackButton(): HTMLButtonElement {
    return button('← Deselect (Esc)', 'Clear this effect selection and return to the main Effects panel.', () => {
      clearSelection();
    });
  }

  function selectionBackPanel(): HTMLElement {
    const actions = el('div', 'sp-fx-actions sp-fx-selection-back');
    actions.appendChild(selectionBackButton());
    return actions;
  }

  function renderReference(): void {
    if (referenceState.status === 'empty') {
      disposeClipViewer();
      disposeReferenceSplineViewer();
      root.appendChild(el('div', 'sp-fx-empty sp-fx-ref-state', 'Load a reference mountain in Scene ▸ Reference to inspect its effects.'));
      return;
    }
    if (referenceState.status === 'idle') {
      disposeClipViewer();
      disposeReferenceSplineViewer();
      root.appendChild(el('div', 'sp-fx-empty sp-fx-ref-state', `${referenceState.level} effects load when this panel opens.`));
      return;
    }
    if (referenceState.status === 'loading') {
      disposeClipViewer();
      disposeReferenceSplineViewer();
      root.appendChild(el('div', 'sp-fx-empty sp-fx-ref-state', `Loading ${referenceState.level} effects…`));
      return;
    }
    if (referenceState.status === 'error') {
      disposeClipViewer();
      disposeReferenceSplineViewer();
      root.appendChild(el('div', 'sp-fx-issue error sp-fx-ref-state', `${referenceState.level}: ${referenceState.message}`));
      return;
    }
    const data = referenceState.data;
    if (selectedReferenceSplineIndex !== null) {
      disposeClipViewer();
      disposeReferenceSplineViewer();
      const spline = referenceRailSplinePanel(data, selectedReferenceSplineIndex);
      if (spline) { root.appendChild(spline); root.appendChild(selectionBackPanel()); return; }
      selectedReferenceSplineIndex = null; // the level changed under the selection
      viewport.selectReferenceRailSpline(null);
    }
    normalizeReferenceSelection(data);
    const animation = selectedReferenceParticleIndex === null && !referenceUnassignedOpen
      ? referenceAnimationPanel(data)
      : (disposeClipViewer(), null);
    const splineAnimation = selectedReferenceParticleIndex === null && !referenceUnassignedOpen
      ? referenceSplineAnimationPanel(data)
      : (disposeReferenceSplineViewer(), null);
    if (selectedReferenceParticleIndex !== null) {
      const particle = referenceParticlePanel(data);
      if (particle) root.appendChild(particle);
      root.appendChild(selectionBackPanel());
      return;
    }
    const view: EffectsPanelView = {
      readOnly: true,
      selection: referenceFocus.selection,
      search: referenceOwnerSearch,
      setSearch: value => { referenceOwnerSearch = value; },
      selectOwner: (kind, ownerId, nodeId) => {
        const selection = { ownerKind: kind, ownerId, ...(nodeId ? { nodeId } : {}) };
        referenceFocus = { ...referenceFocus, selection, callerIndex: null };
        const owner = effectOwner(data.document, selection);
        const node = nodeId ? owner?.nodes.find(item => item.id === nodeId) : null;
        const target = node ? referenceInstanceEffectCall(data, node)?.target : null;
        const markerIndex = target?.index ?? referenceFocus.activeInstanceIndex;
        referenceFocus = { ...referenceFocus, markerIndex };
        viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, markerIndex);
        render();
      },
      ownerLabel: (kind, ownerId, fallback) => kind === 'graph'
        ? referenceEffectDisplayName(data, ownerId, referenceFocus.activeInstanceIndex) ?? fallback : fallback,
      nodeLabel: node => referenceNodeDisplayName(data, node),
      referenceData: data,
    };
    if (referenceUnassignedOpen) {
      view.visibleOwnerIds = referenceUnassignedOwnerIds(data);
      root.appendChild(ownerList(data.document, view, 'Unassigned effects & functions'));
      const owner = selectedOwnerPanel(data.document, view), node = inspector(data.document, view);
      if (owner) root.appendChild(owner);
      if (node) root.appendChild(node);
      root.appendChild(selectionBackPanel());
      return;
    }
    if (referenceFocus.instanceIndices.length) {
      const list = referenceSelectionListPanel(data);
      const prop = referenceEffectHostPanel(data);
      const effect = referenceSelectedEffectPanel(data) ?? referenceSelectedFunctionPanel(data);
      const node = referenceFocus.activeInstanceIndex === null ? null : inspector(data.document, view);
      const animationEmbedded = !!(node && animation && embedSection(node, animation, 'Model animation'));
      if (list) root.appendChild(list);
      if (prop) root.appendChild(prop);
      if (effect) root.appendChild(effect);
      if (node) root.appendChild(node);
      if (animation && !animationEmbedded) root.appendChild(animation);
      if (splineAnimation) root.appendChild(splineAnimation);
      if (!prop?.classList.contains('sp-fx-has-inline-back')) root.appendChild(selectionBackPanel());
      return;
    }
    root.append(referenceHeader(data), referenceValidationPanel(data));
  }

  function renderMountainHome(doc: EffectsDocument | null): void {
    root.append(mapGuidePanel(), particleSummaryPanel(), docHeader(doc));
    if (doc) root.appendChild(validationPanel(doc));
  }

  /** The mountain switch belongs to the Effects home screen. A drilled-in prop, node, graph, or particle uses
   * its Deselect/Escape affordance to return home before changing source, matching the other scene toolboxes. */
  function hasSelectedEffect(): boolean {
    return source === 'mountain'
      ? store.selectedRail !== null || !!selectedAuthoredParticleId || authoredUnassignedOpen || !!selection || selectedAuthoredPropIds.length > 0
      : selectedReferenceParticleIndex !== null || selectedReferenceSplineIndex !== null
        || referenceUnassignedOpen
        || referenceFocus.instanceIndices.length > 0 || !!referenceFocus.selection;
  }

  function render(): void {
    root.replaceChildren();
    if (selectedAuthoredParticleId && !volumes().some(volume => volume.id === selectedAuthoredParticleId))
      selectedAuthoredParticleId = null;
    const validAuthoredPropIds = new Set(props().map(prop => prop.id).filter((id): id is string => !!id));
    selectedAuthoredPropIds = selectedAuthoredPropIds.filter(id => validAuthoredPropIds.has(id));
    if (selectedAuthoredPropId && !selectedAuthoredPropIds.includes(selectedAuthoredPropId)) {
      selectedAuthoredPropId = null;
      selection = null;
    }
    sourceTabs.refresh();
    if (!hasSelectedEffect()) root.appendChild(sourceTabsRow);
    const effectsOn = active && store.currentMode === 'effects';
    const authoredDoc = document();
    if (authoredDoc) syncAuthoredMotionPathEffectResources(authoredDoc, store.mdoc.rails);
    viewport.showEffectMotionPaths(effectsOn);
    viewport.showReferenceEffectInspector(effectsOn);
    viewport.showAuthoredEffectProps(effectsOn, authoredDoc
      ? effectAttachments(authoredDoc).filter(attachment => attachment.enabled).map(attachment => attachment.target.id)
      : [], source === 'mountain' ? selectedAuthoredPropIds : []);
    viewport.showEffectRails(effectsOn);
    syncTriggerTransform();
    // A viewer belonging to the OTHER side cannot survive the switch: it would hold its prop's pose frozen
    // with no panel left to release it.
    if (clipViewer && clipViewer.target.kind !== (source === 'reference' ? 'reference' : 'authored'))
      disposeClipViewer();
    if (source === 'reference') {
      viewport.setEffectHandle(null); renderReference(); return;
    }
    // Swept after the inspector below rather than disposed here, so scrubbing survives an ordinary
    // re-render — a viewer torn down and rebuilt would snap its playhead back to the clip's first frame
    // on every field edit.
    authoredClipPanelRendered = false;
    disposeReferenceSplineViewer();
    const doc = authoredDoc;
    if (source === 'mountain' && selectedMotionPath()) {
      const path = motionPathPanel();
      if (path) root.appendChild(path);
      root.appendChild(selectionBackPanel());
    } else if (source === 'mountain' && selectedGrindRail()) {
      const rail = grindRailPanel();
      if (rail) root.appendChild(rail);
      root.appendChild(selectionBackPanel());
    } else if (source === 'mountain' && selectedAuthoredParticleId) {
      const particle = authoredParticlePanel();
      if (particle) root.appendChild(particle);
      root.appendChild(selectionBackPanel());
    } else if (source === 'mountain' && doc
      && (authoredUnassignedOpen || selection || selectedAuthoredPropIds.length)) {
      normalizeSelection(doc);
      const view: EffectsPanelView = {
        readOnly: false,
        selection,
        search,
        setSearch: value => { search = value; },
        selectOwner,
        ownerLabel: (kind, ownerId, fallback) => kind === 'graph'
          ? authoredGraphDisplayName(doc, ownerId) ?? fallback : fallback,
      };
      if (authoredUnassignedOpen) {
        view.visibleOwnerIds = authoredUnassignedOwnerIds(doc);
        root.appendChild(ownerList(doc, view, 'Unassigned effects & functions'));
        const owner = selectedOwnerPanel(doc, view), node = inspector(doc, view), attachment = attachmentPanel(doc);
        if (owner) root.appendChild(owner);
        if (node) root.appendChild(node);
        if (attachment) root.appendChild(attachment);
        root.appendChild(selectionBackPanel());
      } else if (selection || selectedAuthoredPropIds.length) {
        const list = authoredSelectionListPanel(doc);
        const prop = authoredSelectedPropPanel(doc);
        const owner = selectedOwnerPanel(doc, view, false), node = inspector(doc, view), attachment = attachmentPanel(doc);
        if (list) root.appendChild(list);
        if (prop) root.appendChild(prop);
        if (owner) root.appendChild(owner);
        if (node) root.appendChild(node);
        if (attachment) root.appendChild(attachment);
        if (!prop?.classList.contains('sp-fx-has-inline-back')) root.appendChild(selectionBackPanel());
      }
    } else {
      renderMountainHome(doc);
    }
    // Nothing rendered a clip timeline this pass, so any authored hold is released — otherwise deselecting
    // the node would leave the placement stuck at whatever frame it was scrubbed to.
    if (!authoredClipPanelRendered && clipViewer?.target.kind === 'authored') disposeClipViewer();
    syncGizmo();
  }

  /** Mode lifecycle. Routine toolbox rebuilds call render(); only an actual mode transition enters or exits. */
  function setActive(on: boolean): void {
    if (active === on) return;
    active = on; root.style.display = on ? '' : 'none';
    if (on) {
      if (source === 'reference' && referenceFocus.instanceIndices.length)
        viewport.selectReferenceEffectInstances(referenceFocus.instanceIndices, referenceFocus.markerIndex);
      if (source === 'reference' && selectedReferenceParticleIndex !== null) viewport.selectReferenceParticleVolume(selectedReferenceParticleIndex);
      if (source === 'mountain' && selectedAuthoredParticleId) viewport.selectAuthoredParticleVolume(selectedAuthoredParticleId);
      render();
    } else {
      disposeClipViewer();
      disposeReferenceSplineViewer();
      viewport.stopReferenceEffectPreview();
      viewport.showEffectMotionPaths(false);
      viewport.showEffectRails(false);
      viewport.setEffectHandle(null); viewport.showReferenceEffectInspector(false);
      viewport.showAuthoredEffectProps(false, []);
      viewport.setPlacedPropSelection(null);
      viewport.selectReferenceEffectInstances([]);
    }
  }

  function setReferenceState(state: ReferenceEffectsState): void {
    referenceState = state;
    const data = state.status === 'ready' ? state.data : null;
    viewport.setReferenceEffects(data);
    if (!data) {
      disposeClipViewer();
      disposeReferenceSplineViewer();
      referenceFocus = emptyReferenceEffectFocus();
      selectedReferenceParticleIndex = null;
      referenceUnassignedOpen = false;
      viewport.selectReferenceEffectInstances([]);
      viewport.selectReferenceParticleVolume(null);
    }
    if (active) render();
  }

  function moveSelectedEmitter(world: [number, number, number]): void {
    if (source === 'mountain' && selectedAuthoredParticleId) {
      const volume = volumes().find(item => item.id === selectedAuthoredParticleId);
      if (volume) { volume.pos = world; deps.scheduleRebuild(); }
      return;
    }
    const doc = document(); if (!doc || !selection) return;
    const node = effectNode(doc, selection); if (!node) return;
    // Keep TransformControls' live object untouched during its drag. Re-seating it from render() on every
    // objectChange would restart the gesture; the ordinary rebuild funnel still snapshots/persists each write.
    if (setEmitterWorldPosition(node, world, selectedAttachmentProp(doc))) deps.scheduleRebuild();
  }

  function deleteSelection(): boolean {
    if (source === 'reference') return false;
    if (selectedDrawableSpline()) { removeSelectedDrawnSpline(); return true; }
    // A rail with a tube is only being INSPECTED here. Deleting one would take a piece of course scenery away
    // from a mode that cannot draw it back, so Delete declines and the Tricks tools keep the action. A bare
    // rail is drawable here, so it went the other way above.
    if (selectedGrindRail()) return false;
    if (selectedAuthoredParticleId) { removeSelectedParticle(); return true; }
    if (!selection?.nodeId && removeSelectedEffectTrigger()) return true;
    const doc = document(); if (!doc || !selection) return false;
    if (selection.nodeId) { removeNode(); return true; }
    removeOwner(); return true;
  }

  function clearSelection(): boolean {
    if (store.railDrawing && selectedDrawableSpline()) { finishDrawnSpline(); return true; }
    const hadSelection = !!selection || selectedAuthoredPropIds.length > 0 || authoredUnassignedOpen
      || !!referenceFocus.selection || referenceFocus.instanceIndices.length > 0 || referenceUnassignedOpen
      || !!selectedAuthoredParticleId || selectedReferenceParticleIndex !== null || store.selectedRail !== null
      || selectedReferenceSplineIndex !== null;
    if (!hadSelection) return false;
    selectedReferenceSplineIndex = null;
    viewport.selectReferenceRailSpline(null);
    dropSplineSelection();
    selection = null; selectedAuthoredPropIds = []; selectedAuthoredPropId = null;
    authoredUnassignedOpen = false;
    referenceFocus = emptyReferenceEffectFocus();
    referenceUnassignedOpen = false;
    selectedAuthoredParticleId = null; selectedReferenceParticleIndex = null;
    viewport.stopReferenceEffectPreview();
    viewport.selectReferenceEffectInstances([]);
    viewport.selectAuthoredParticleVolume(null); viewport.selectReferenceParticleVolume(null);
    render(); return true;
  }

  root.style.display = 'none';
  return { el: root, render, setActive, setReferenceState, moveSelectedEmitter, deleteSelection, clearSelection,
    selectAuthoredPropEffect, selectReferencePropEffect, selectReferenceCalledEffect,
    selectParticleVolume, selectCourseSpline, selectReferenceSpline,
    get referenceReady() { return referenceState.status === 'ready'; },
    get selection() { return selection; } };
}

export type EffectsEditor = ReturnType<typeof createEffectsEditor>;
