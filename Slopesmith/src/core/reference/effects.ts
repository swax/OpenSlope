import {
  parseEffectsDocument,
  type EffectFunction,
  type EffectGraph,
  type EffectNode,
  type EffectSlot,
  type EffectsDocument,
} from '../effects/document';
import type { V3 } from '../doc/types';
import type { ParticleVolume } from '../particles/volumes';
import { effectGraphDisplayName, timerEmitterFields, type EffectCircumstance, type EffectOwnerKind, type EffectSelection } from '../effects/authoring';
import { effectNodeLabel } from '../effects/node-detail';
import { effectPlayCommand } from '../effects/play-runtime';
import { timerEmitterPreviewLaw, type TimerEmitterPreviewLaw } from '../effects/emitter-preview';
import {
  animComboFromGraph, animDeltaFromGraph, animObjectFromGraph,
  materialControlFromGraph, materialWorldEffectsFromGraph,
  type AnimComboEffect, type AnimObjectEffect,
  type MaterialControl,
  type MaterialWorldEffects,
  type UvScrollEffect,
} from '../effects/world-effects';

/** One native Instances.json placement. Effects can target animated/effect-only models with no static mesh,
 * so the reference effect payload retains every instance instead of only the ones the prop renderer draws. */
export interface ReferenceEffectInstance {
  index: number;
  name: string;
  /** Models.json display name; `name` is the concrete Instances.json placement name. */
  modelName: string;
  model: number;
  loc: V3;
  rot: [number, number, number, number];
  scale: V3;
  effectSlotIndex: number;
  /** Native LTG membership: 0=common, 1=race list, 2=GemIndex/Showoff object layer. */
  ltgState?: number;
  visible: boolean;
  /** ADL collision-sound event id (`Sounds.CollisonSound`), or -1 when the instance ships none. An event id,
   * not a bank slot — resolve through core/effects/collision-sound.ts [Trailmap: 420-audio-runtime]. */
  collisionSound: number;
  /** Effective native response used to select the Unity-matched blocking or ride-through sound curve. */
  contact: 'through' | 'solid';
}

export interface ReferenceEffectsPayload {
  level: string;
  document: unknown;
  instances: ReferenceEffectInstance[];
  /** Standalone PBD fog banks. They share the Effects-mode viewport but are not SSF graphs/attachments. */
  particleVolumes?: ParticleVolume[];
  error?: string;
}

export interface ReferenceEffectsData extends Omit<ReferenceEffectsPayload, 'document' | 'error'> {
  document: EffectsDocument;
}

export type ReferenceEffectsState =
  | { status: 'empty' }
  | { status: 'idle'; level: string }
  | { status: 'loading'; level: string }
  | { status: 'ready'; data: ReferenceEffectsData }
  | { status: 'error'; level: string; message: string };

export interface ReferenceGraphBinding {
  slot: EffectSlot;
  circumstance: EffectCircumstance;
  graph: EffectGraph;
}

export function decodeReferenceEffects(payload: ReferenceEffectsPayload): ReferenceEffectsData {
  if (payload.error) throw new Error(payload.error);
  return { ...payload, document: parseEffectsDocument(payload.document) };
}

/** Resolve a native slot index without assuming the portable array remained in original order. */
export function referenceSlot(document: EffectsDocument, nativeIndex: number): EffectSlot | null {
  return document.slots.find((slot, index) => (slot.originalIndex ?? index) === nativeIndex) ?? null;
}

/** Resolve a spline reference to the shared native Splines.json table. Retail documents use direct ids such as
 * `spline:0038`; authored exports keep semantic ids such as `spline:path:0000`, whose resource row retains the
 * actual table index. As with slots, array position is the lossless fallback when provenance is absent. */
export function referenceSplineOriginalIndex(document: EffectsDocument | null | undefined,
  stableId: string | null | undefined): number | null {
  if (!stableId) return null;
  const native = /^spline:(\d+)$/.exec(stableId);
  if (native) return Number(native[1]);
  const resource = document?.splines.find(item => item.id === stableId);
  if (!resource || !document) return null;
  const index = resource.originalIndex ?? document.splines.indexOf(resource);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** One node in a shipped level that names native spline row `originalIndex`. */
export interface ReferenceSplineUse {
  ownerKind: EffectOwnerKind;
  ownerId: string;
  node: EffectNode;
}

/** Every node naming native spline row `originalIndex`, whatever id dialect the document stores it in — the
 *  reference twin of `splineEffectUses`, which cannot be reused directly because retail ids are positional
 *  (`spline:0038`) while an authored export keeps a semantic id whose row carries the table index. */
export function referenceSplineEffectUses(data: ReferenceEffectsData,
  originalIndex: number): ReferenceSplineUse[] {
  const out: ReferenceSplineUse[] = [];
  for (const [ownerKind, owners] of
    [['graph', data.document.graphs], ['function', data.document.functions]] as const)
    for (const owner of owners)
      for (const node of owner.nodes)
        if (referenceSplineOriginalIndex(data.document, node.references?.spline) === originalIndex)
          out.push({ ownerKind, ownerId: owner.id, node });
  return out;
}

/** One native instance a shipped spline is paired with, and the node naming the spline that led there. */
export interface ReferenceSplinePairedInstance {
  instance: ReferenceEffectInstance;
  use: ReferenceSplineUse;
}

/**
 * The instances a shipped spline is PAIRED with, by the same shared-graph rule the authored side uses
 * (`splinePairedProps`, docs/014): the placements that the graphs naming this spline also aim a `MainType 7`
 * at. On a retail level this is exactly the `HideShowOff` pair — the rail's spline toggled in one node, its
 * tube hidden in the next — which is why a rail tube shows purple in Effects mode while carrying no effect
 * slot of its own: something acts on it from elsewhere, and this is what.
 */
export function referenceSplinePairedInstances(data: ReferenceEffectsData, originalIndex: number,
  splineControls?: readonly number[][] | null): ReferenceSplinePairedInstance[] {
  const out: ReferenceSplinePairedInstance[] = [];
  const seen = new Set<number>();
  for (const use of referenceSplineEffectUses(data, originalIndex)) {
    const owner = use.ownerKind === 'graph'
      ? data.document.graphs.find(item => item.id === use.ownerId)
      : data.document.functions.find(item => item.id === use.ownerId);
    for (const node of owner?.nodes ?? []) {
      const target = referenceInstanceEffectCall(data, node)?.target;
      if (!target || seen.has(target.index)) continue;
      seen.add(target.index);
      out.push({ instance: target, use });
    }
  }
  if (!splineControls?.length || out.length < 2) return out;
  // A retail graph is often a BULK switch — GARI's `HideShowOff` toggles 66 splines and hides ~100 tubes in
  // one function, because nothing joins a curve to its model and the level therefore has to name all of both.
  // The effect still decides WHICH instances are candidates; distance only orders the ones it already named,
  // so the nearest is offered first. That is a ranking inside a real join, not a join invented from proximity.
  const near = (loc: V3): number => {
    let best = Infinity;
    for (const control of splineControls) {
      const d = (control[0] - loc[0]) ** 2 + (control[1] - loc[1]) ** 2 + (control[2] - loc[2]) ** 2;
      if (d < best) best = d;
    }
    return best;
  };
  return out
    .map(entry => ({ entry, d: near(entry.instance.loc) }))
    .sort((a, b) => a.d - b.d)
    .map(item => item.entry);
}

export function referenceInstanceBindings(data: ReferenceEffectsData,
  instance: ReferenceEffectInstance): ReferenceGraphBinding[] {
  const slot = referenceSlot(data.document, instance.effectSlotIndex);
  if (!slot) return [];
  const out: ReferenceGraphBinding[] = [];
  for (const circumstance of Object.keys(slot.circumstances) as EffectCircumstance[]) {
    const graphId = slot.circumstances[circumstance];
    if (!graphId) continue;
    const graph = data.document.graphs.find(x => x.id === graphId);
    if (graph) out.push({ slot, circumstance, graph });
  }
  return out;
}

/** Visible hosts whose own collision chain destroys them immediately. These are the native smash-through
 * breakables: contact must still dispatch the graph (and its pop particles/sound), but it must not apply a solid
 * rider response first. A positive Wait or a condition ahead of the kill keeps the host solid because the chain
 * may not remove it on this contact; calls that destroy some other instance are deliberately not self-breaks. */
export function referenceImmediateBreakInstances(
  data: ReferenceEffectsData | null | undefined,
): Set<number> {
  const out = new Set<number>();
  if (!data) return out;
  const slots = new Map<number, EffectSlot>();
  data.document.slots.forEach((slot, index) => slots.set(slot.originalIndex ?? index, slot));
  const graphs = new Map(data.document.graphs.map(graph => [graph.id, graph]));
  for (const instance of data.instances) {
    if (!instance.visible) continue;
    const graphId = slots.get(instance.effectSlotIndex)?.circumstances.collision;
    const graph = graphId ? graphs.get(graphId) : null;
    if (!graph) continue;
    let unconditional = true;
    for (const node of graph.nodes) {
      if (node.mainType === 4) {
        const wait = typeof node.payload.WaitTime === 'number' && Number.isFinite(node.payload.WaitTime)
          ? node.payload.WaitTime : 0;
        if (wait > 0) unconditional = false;
        continue;
      }
      if (node.mainType === 5) {
        unconditional = false;
        continue;
      }
      if (unconditional && effectPlayCommand(node)?.kind === 'instance-hide') {
        out.add(instance.index);
        break;
      }
    }
  }
  return out;
}

/** Resolve all native instance material motions in one indexed pass. Reference prop construction consumes the
 * whole map, avoiding repeated linear slot/graph searches across thousands of placed objects. */
export function referenceMaterialWorldEffects(data: ReferenceEffectsData | null | undefined): Map<number, MaterialWorldEffects> {
  const out = new Map<number, MaterialWorldEffects>();
  if (!data) return out;
  const slots = new Map<number, EffectSlot>();
  data.document.slots.forEach((slot, index) => slots.set(slot.originalIndex ?? index, slot));
  const graphs = new Map(data.document.graphs.map(graph => [graph.id, graph]));
  const circumstanceOrder: EffectCircumstance[] = ['persistent', 'collision', 'slot3', 'slot4', 'trigger', 'slot6', 'slot7'];
  for (const instance of data.instances) {
    const slot = slots.get(instance.effectSlotIndex);
    if (!slot) continue;
    for (const circumstance of circumstanceOrder) {
      const graphId = slot.circumstances[circumstance];
      const effect = graphId ? materialWorldEffectsFromGraph(graphs.get(graphId)) : null;
      if (effect) {
        out.set(instance.index, effect.textureFlip?.dwell
          ? { ...effect, textureFlip: { ...effect.textureFlip, seed: instance.index + 1 } }
          : effect);
        break;
      }
    }
  }
  return out;
}

export type ReferenceMaterialControl = MaterialControl;

export interface ReferenceRaceCountdownCue {
  at: number;
  label: string;
}

/** A race-start hold recovered from the reference's named lifecycle function. `holdSeconds` ends exactly when
 * the final texture-frame command selects GO; the UI-only READY cue occupies the function's initial wait. */
export interface ReferenceRaceCountdown {
  functionId: string;
  holdSeconds: number;
  cues: readonly ReferenceRaceCountdownCue[];
}

/** Recover the gameplay clock behind the native start-light function. This intentionally requires the full,
 * observed shape: a named countdown entry point, positive Wait timing, and consecutive absolute texture-frame
 * selections 1..N. A similarly named but structurally unknown function must not hold the rider on a guess. */
export function referenceRaceCountdown(data: ReferenceEffectsData | null | undefined): ReferenceRaceCountdown | null {
  if (!data) return null;
  const functions = new Map(data.document.functions.map(fn => [fn.id, fn]));
  const graphs = new Map(data.document.graphs.map(graph => [graph.id, graph]));
  const normalizedName = (name: string) => name.toLowerCase().replace(/[^a-z]/g, '');
  const start = data.document.functions.find(fn => normalizedName(fn.name) === 'startcountdown')
    ?? data.document.functions.find(fn => normalizedName(fn.name) === 'countdownstart');
  if (!start) return null;

  const frames: { at: number; frame: number; target: string | null }[] = [];
  const walk = (owner: EffectGraph | EffectFunction, startAt: number, path: Set<string>, depth: number): number => {
    if (depth > 8 || path.has(owner.id)) return startAt;
    const nextPath = new Set(path); nextPath.add(owner.id);
    let at = startAt;
    for (const node of owner.nodes) {
      if (node.mainType === 4) {
        const wait = typeof node.payload.WaitTime === 'number' && Number.isFinite(node.payload.WaitTime)
          ? node.payload.WaitTime : 0;
        at += Math.max(0, Math.min(wait, 30));
        continue;
      }
      if ((node.mainType === 21 || node.mainType === 26) && node.references?.function) {
        const called = functions.get(node.references.function);
        if (called) at = Math.max(at, walk(called, at, nextPath, depth + 1));
        continue;
      }
      if (node.mainType !== 7 || !node.references?.effectGraph) continue;
      const called = graphs.get(node.references.effectGraph);
      if (!called) continue;
      const command = called.nodes.map(effectPlayCommand)
        .find(item => item?.kind === 'property-control' && item.command === 2);
      if (command?.kind === 'property-control' && Number.isInteger(command.value))
        frames.push({ at, frame: command.value, target: node.references.instance ?? null });
    }
    return at;
  };
  walk(start, 0, new Set(), 0);
  frames.sort((a, b) => a.at - b.at || a.frame - b.frame);
  if (frames.length < 2 || frames[0].at <= 0) return null;
  for (let i = 0; i < frames.length; i++) if (frames[i].frame !== i + 1) return null;
  const targetId = frames[0].target;
  if (!targetId || frames.some(frame => frame.target !== targetId)) return null;
  const target = referenceInstanceByStableId(data, targetId);
  if (!target || referenceMaterialControls(data).get(target.index)?.receiver !== 'texture-flip') return null;
  const holdSeconds = frames.at(-1)!.at;
  if (!(holdSeconds > 0)) return null;
  return {
    functionId: start.id,
    holdSeconds,
    cues: [
      { at: 0, label: 'READY' },
      ...frames.map(({ at, frame }) => ({ at, label: frame === frames.length ? 'GO' : String(frames.length - frame) })),
    ],
  };
}

/** Resolve material control receivers by native instance index. Most are installed by an instance's own
 * circumstance graph; race lifecycle functions also use MainType-7 to install a property on an otherwise
 * unattached object (the five-frame start lights are the retail worked example). Pre-resolving both paths lets
 * the renderer allocate an independent material before the delayed control messages arrive. */
export function referenceMaterialControls(data: ReferenceEffectsData | null | undefined): Map<number, ReferenceMaterialControl> {
  const candidates = new Map<number, ReferenceMaterialControl>();
  if (!data) return candidates;
  const slots = new Map<number, EffectSlot>();
  data.document.slots.forEach((slot, index) => slots.set(slot.originalIndex ?? index, slot));
  const graphs = new Map(data.document.graphs.map(graph => [graph.id, graph]));
  const functions = new Map(data.document.functions.map(fn => [fn.id, fn]));
  const controlled = new Set<number>();
  const hasBoundControl = (owner: EffectGraph | EffectFunction, seen = new Set<string>()): boolean => {
    if (seen.has(owner.id)) return false;
    seen.add(owner.id);
    if (owner.nodes.some(node => node.mainType === 3 || node.mainType === 9)) return true;
    return owner.nodes.some(node => {
      const fn = node.references?.function ? functions.get(node.references.function) : null;
      return !!fn && hasBoundControl(fn, seen);
    });
  };
  const circumstanceOrder: EffectCircumstance[] = ['persistent', 'collision', 'slot3', 'slot4', 'trigger', 'slot6', 'slot7'];
  for (const instance of data.instances) {
    const slot = slots.get(instance.effectSlotIndex);
    if (!slot) continue;
    for (const circumstance of circumstanceOrder) {
      const graphId = slot.circumstances[circumstance];
      const graph = graphId ? graphs.get(graphId) : null;
      const control = materialControlFromGraph(graph);
      if (control && !candidates.has(instance.index)) candidates.set(instance.index, control);
      if (graph && hasBoundControl(graph)) controlled.add(instance.index);
    }
  }

  // A function/graph can bind another instance and run a tiny property-constructor graph on it. These dynamic
  // installs intentionally override the static slot inference above, matching the native single receiver.
  for (const owner of [...data.document.graphs, ...data.document.functions]) {
    for (const node of owner.nodes) {
      if (node.mainType !== 7) continue;
      const target = referenceInstanceByStableId(data, node.references?.instance);
      const called = node.references?.effectGraph ? graphs.get(node.references.effectGraph) : null;
      const control = materialControlFromGraph(called);
      if (target && control) candidates.set(target.index, control);
      if (target && called && hasBoundControl(called)) controlled.add(target.index);
    }
  }
  return new Map([...candidates].filter(([sourceIndex]) => controlled.has(sourceIndex)));
}

/** Resolve persistent AnimObject players by native Instances.json index. Triggered AnimObject graphs are kept
 * out of this always-on map; they need a circumstance event rather than advancing as ambient world motion. */
export function referenceAnimObjectEffects(data: ReferenceEffectsData | null | undefined): Map<number, AnimObjectEffect> {
  const out = new Map<number, AnimObjectEffect>();
  if (!data) return out;
  const slots = new Map<number, EffectSlot>();
  data.document.slots.forEach((slot, index) => slots.set(slot.originalIndex ?? index, slot));
  const graphs = new Map(data.document.graphs.map(graph => [graph.id, graph]));
  for (const instance of data.instances) {
    const graphId = slots.get(instance.effectSlotIndex)?.circumstances.persistent;
    const effect = graphId ? animObjectFromGraph(graphs.get(graphId)) : null;
    if (effect) out.set(instance.index, effect);
  }
  return out;
}

/** Resolve persistent AnimDelta players separately from free-running AnimObject clips. Both share the model
 * animation payload, but Sub257 must remain frozen until its installed receiver gets a control-message grant. */
export function referenceAnimDeltaEffects(data: ReferenceEffectsData | null | undefined): Map<number, AnimObjectEffect> {
  const out = new Map<number, AnimObjectEffect>();
  if (!data) return out;
  const slots = new Map<number, EffectSlot>();
  data.document.slots.forEach((slot, index) => slots.set(slot.originalIndex ?? index, slot));
  const graphs = new Map(data.document.graphs.map(graph => [graph.id, graph]));
  for (const instance of data.instances) {
    const graphId = slots.get(instance.effectSlotIndex)?.circumstances.persistent;
    const effect = graphId ? animDeltaFromGraph(graphs.get(graphId)) : null;
    if (effect) out.set(instance.index, effect);
  }
  return out;
}

/** Resolve persistent AnimCombo players. Their IDLE half is free-running world motion like an AnimObject's,
 * which is why they are collected as always-on; what separates them is the second window, and that one waits
 * for control command 3 rather than for the world clock. */
export function referenceAnimComboEffects(data: ReferenceEffectsData | null | undefined): Map<number, AnimComboEffect> {
  const out = new Map<number, AnimComboEffect>();
  if (!data) return out;
  const slots = new Map<number, EffectSlot>();
  data.document.slots.forEach((slot, index) => slots.set(slot.originalIndex ?? index, slot));
  const graphs = new Map(data.document.graphs.map(graph => [graph.id, graph]));
  for (const instance of data.instances) {
    const graphId = slots.get(instance.effectSlotIndex)?.circumstances.persistent;
    const effect = graphId ? animComboFromGraph(graphs.get(graphId)) : null;
    if (effect) out.set(instance.index, effect);
  }
  return out;
}

export function referenceUvScrolls(data: ReferenceEffectsData | null | undefined): Map<number, UvScrollEffect> {
  const out = new Map<number, UvScrollEffect>();
  for (const [index, effect] of referenceMaterialWorldEffects(data)) if (effect.uvScroll) out.set(index, effect.uvScroll);
  return out;
}

/** Resolve one native instance's always-on UV material motion. */
export function referenceUvScroll(data: ReferenceEffectsData | null | undefined, sourceIndex: number): UvScrollEffect | null {
  return referenceMaterialWorldEffects(data).get(sourceIndex)?.uvScroll ?? null;
}

/** Choose the most useful effect owned by a native instance. Incoming MainType-7 calls belong to their caller
 * props, so selecting a called model stays on that model; the editor presents its callers as navigation links. */
export function referenceEffectSelection(data: ReferenceEffectsData,
  instance: ReferenceEffectInstance): EffectSelection | null {
  const bindings = referenceInstanceBindings(data, instance);
  const binding = bindings.find(item => item.graph.nodes.some(node => !!timerEmitterFields(node)))
    ?? bindings.find(item => item.graph.nodes.some(node => !!referenceFireworkCall(data, node)))
    ?? bindings[0];
  if (binding) {
    const node = binding.graph.nodes.find(item => !!timerEmitterFields(item))
      ?? binding.graph.nodes.find(item => !!referenceFireworkCall(data, item))
      ?? binding.graph.nodes[0];
    return { ownerKind: 'graph', ownerId: binding.graph.id, ...(node ? { nodeId: node.id } : {}) };
  }
  return null;
}

/** Contextual graph name from the native owning model plus the slot circumstance that fires it. Prefer the
 * currently selected instance because one graph may be shared by several model variants. */
export function referenceEffectDisplayName(data: ReferenceEffectsData, graphId: string,
  preferredInstanceIndex?: number | null): string | null {
  const preferred = preferredInstanceIndex == null ? null
    : data.instances.find(instance => instance.index === preferredInstanceIndex) ?? null;
  const candidates = preferred ? [preferred, ...data.instances.filter(instance => instance !== preferred)] : data.instances;
  for (const instance of candidates) {
    const binding = referenceInstanceBindings(data, instance).find(item => item.graph.id === graphId);
    if (binding) return effectGraphDisplayName(binding.graph, binding.circumstance);
  }
  return null;
}

export function attachedReferenceInstances(data: ReferenceEffectsData): ReferenceEffectInstance[] {
  return data.instances.filter(instance => instance.effectSlotIndex >= 0 && !!referenceSlot(data.document, instance.effectSlotIndex));
}

/** The engine's Effect-end latch test for one native instance: is its slot's column 4 populated? A finished
 * play-once clip then keeps its node — the pose holds at the last frame instead of reverting to the bind
 * pose (the Elysium iris door) [Trailmap: 150-logic §slot-columns]. Populated-ness is the whole test; the
 * referenced chain is an empty sentinel in every retail level. */
export function referenceInstanceHoldsAtEnd(data: ReferenceEffectsData | null | undefined,
  sourceIndex: number): boolean {
  if (!data) return false;
  const instance = data.instances.find(item => item.index === sourceIndex);
  const slot = instance ? referenceSlot(data.document, instance.effectSlotIndex) : null;
  return !!slot?.circumstances.slot4;
}

export function referenceInstanceByStableId(data: ReferenceEffectsData, stableId: string | null | undefined): ReferenceEffectInstance | null {
  if (!stableId) return null;
  const match = /^instance:(\d+)$/.exec(stableId);
  if (!match) return null;
  const index = Number(match[1]);
  return data.instances.find(x => x.index === index) ?? null;
}

/** Human-readable resolution of a MainType-7 cross-instance call. The native node stores two otherwise opaque
 * indices: the instance supplies the world-space receiver/origin, and the graph supplies the behavior to run.
 * Keeping this join in the reference model lets every inspector describe fireworks, breakables, animated props,
 * and other instance calls without teaching the UI model-name heuristics. */
export interface ReferenceInstanceEffectCall {
  target: ReferenceEffectInstance | null;
  graph: EffectGraph | null;
  targetLabel: string;
  graphLabel: string;
}

export function referenceInstanceEffectCall(data: ReferenceEffectsData,
  node: EffectNode): ReferenceInstanceEffectCall | null {
  if (node.mainType !== 7 || (!node.references?.instance && !node.references?.effectGraph)) return null;
  const target = referenceInstanceByStableId(data, node.references?.instance);
  const graph = node.references?.effectGraph
    ? data.document.graphs.find(item => item.id === node.references!.effectGraph) ?? null : null;
  const targetRef = node.references?.instance ?? '(none)';
  const graphRef = node.references?.effectGraph ?? '(none)';
  return {
    target,
    graph,
    targetLabel: target ? `${target.name} · #${target.index}` : targetRef,
    graphLabel: graph ? `${graph.name ?? graph.id} · ${graph.id}` : graphRef,
  };
}

export interface ReferenceFireworkLayer {
  node: EffectNode;
  law: TimerEmitterPreviewLaw;
}

export interface ReferenceFireworkEffect {
  graph: EffectGraph;
  layers: readonly ReferenceFireworkLayer[];
  sounds: readonly { node: EffectNode; slot: number }[];
}

/** A native firework is a cross-instance call whose target graph combines one or more P6 timer-emitter layers
 * with a PlaySound report. This is the same data-derived discriminator used by the bundle pipeline: silent
 * collision emitters are ambient dust/fire/water, while the report-bearing graph is authored pyro. */
export interface ReferenceFireworkCall extends ReferenceFireworkEffect {
  call: ReferenceInstanceEffectCall & { target: ReferenceEffectInstance; graph: EffectGraph };
}

/** Classify the called payload itself so its details can live with the launcher model/effect rather than the
 * parent Run node. The call-level wrapper below retains the native relationship for navigation and preview. */
export function referenceFireworkEffect(graph: EffectGraph): ReferenceFireworkEffect | null {
  const layers = graph.nodes.flatMap(candidate => {
    const law = timerEmitterPreviewLaw(candidate);
    return law ? [{ node: candidate, law }] : [];
  });
  const sounds = graph.nodes.flatMap(candidate => {
    const value = candidate.mainType === 8 ? candidate.payload.SoundPlay : null;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? [{ node: candidate, slot: Math.trunc(value) }] : [];
  });
  return layers.length && sounds.length ? { graph, layers, sounds } : null;
}

export function referenceFireworkCall(data: ReferenceEffectsData,
  node: EffectNode): ReferenceFireworkCall | null {
  const call = referenceInstanceEffectCall(data, node);
  if (!call?.target || !call.graph) return null;
  const effect = referenceFireworkEffect(call.graph);
  return effect ? { call: { ...call, target: call.target, graph: call.graph }, ...effect } : null;
}

export interface ReferenceIncomingEffectSource {
  instance: ReferenceEffectInstance;
  circumstance: EffectCircumstance;
  /** Concrete attached graph that reaches the call, used to preview the complete trigger rather than one leaf. */
  graph: EffectGraph;
}

/** One graph/function node that acts on the selected instance. `sources` identifies every directly attached
 * graph host that can reach the owning graph/function through the native function-call graph. */
export interface ReferenceIncomingEffectCall {
  ownerKind: 'graph' | 'function';
  owner: EffectGraph | EffectFunction;
  node: EffectNode;
  call: ReferenceInstanceEffectCall;
  sources: ReferenceIncomingEffectSource[];
}

// A decoded reference document is immutable for the lifetime of its loaded data object. Cache this relatively
// expensive graph/function reachability join once; all selection-level incoming/outgoing views derive from it.
const referenceEffectCallLinkCache = new WeakMap<ReferenceEffectsData, ReferenceIncomingEffectCall[]>();

function referenceEffectCallLinks(data: ReferenceEffectsData): ReferenceIncomingEffectCall[] {
  const cached = referenceEffectCallLinkCache.get(data);
  if (cached) return cached;
  const sourcesByGraph = new Map<string, ReferenceIncomingEffectSource[]>();
  for (const instance of data.instances) for (const binding of referenceInstanceBindings(data, instance)) {
    let sources = sourcesByGraph.get(binding.graph.id);
    if (!sources) sourcesByGraph.set(binding.graph.id, (sources = []));
    sources.push({ instance, circumstance: binding.circumstance, graph: binding.graph });
  }
  // MainType-7 calls frequently live in a shared function rather than the instance's attached graph. Carry
  // each graph's concrete hosts through nested function calls so a unique indirect source remains selectable.
  const functions = new Map(data.document.functions.map(fn => [fn.id, fn]));
  const sourcesByFunction = new Map<string, ReferenceIncomingEffectSource[]>();
  for (const graph of data.document.graphs) {
    const sources = sourcesByGraph.get(graph.id);
    if (!sources?.length) continue;
    const reachable = new Set<string>();
    const visit = (owner: EffectGraph | EffectFunction): void => {
      for (const node of owner.nodes) {
        const functionId = node.references?.function;
        if (!functionId || reachable.has(functionId)) continue;
        reachable.add(functionId);
        const fn = functions.get(functionId);
        if (fn) visit(fn);
      }
    };
    visit(graph);
    for (const functionId of reachable) {
      let resolved = sourcesByFunction.get(functionId);
      if (!resolved) sourcesByFunction.set(functionId, (resolved = []));
      for (const source of sources) if (!resolved.some(item => item.instance.index === source.instance.index
        && item.circumstance === source.circumstance)) resolved.push(source);
    }
  }
  const out: ReferenceIncomingEffectCall[] = [];
  const collect = (ownerKind: 'graph' | 'function', owner: EffectGraph | EffectFunction) => {
    for (const node of owner.nodes) {
      const call = referenceInstanceEffectCall(data, node);
      if (!call?.target) continue;
      out.push({ ownerKind, owner, node, call,
        sources: ownerKind === 'graph' ? sourcesByGraph.get(owner.id) ?? [] : sourcesByFunction.get(owner.id) ?? [] });
    }
  };
  for (const graph of data.document.graphs) collect('graph', graph);
  for (const fn of data.document.functions) collect('function', fn);
  referenceEffectCallLinkCache.set(data, out);
  return out;
}

export function referenceIncomingEffectCalls(data: ReferenceEffectsData,
  targetIndex: number): ReferenceIncomingEffectCall[] {
  return referenceEffectCallLinks(data).filter(entry => entry.call.target?.index === targetIndex);
}

/**
 * Incoming calls that no attached prop reaches — the acting node exists and names this instance, but the
 * graph or function holding it is not called from anything with an `EffectSlotIndex`.
 *
 * GARI is the case that matters: its rail tubes are hidden by `HideShowOff`, a shared function called only by
 * `FreerideMode` / `RaceMode`, which the engine runs at mode select rather than any placement. So the tube is
 * marked in Effects mode (`referenceEffectInstanceIndices` counts every MainType-7 target) while the
 * caller-centric tree, which expands per source prop, has no branch to show. Without this the prop reads as
 * "highlighted for no reason", when in fact something very specific acts on it.
 */
export function referenceUnhostedIncomingEffectCalls(data: ReferenceEffectsData,
  targetIndex: number): ReferenceIncomingEffectCall[] {
  return referenceIncomingEffectCalls(data, targetIndex).filter(entry => !entry.sources.length);
}

export interface ReferenceIncomingEffectBranch {
  graph: EffectGraph | null;
  graphId: string | null;
  entries: ReferenceIncomingEffectCall[];
}

export interface ReferenceIncomingEffectCallerBranch {
  instance: ReferenceEffectInstance;
  entries: ReferenceIncomingEffectCall[];
  effects: ReferenceIncomingEffectBranch[];
}

/** Build the target-centric hierarchy used by the reference editor. One MainType-7 node is one edge, but a
 * shared source graph can give that edge several concrete caller props and several edges can converge on the
 * same remote graph. Expand the sources first, then group remote graphs below each caller without losing calls. */
export function referenceIncomingEffectTree(data: ReferenceEffectsData,
  targetIndex: number): ReferenceIncomingEffectCallerBranch[] {
  const callers = new Map<number, {
    instance: ReferenceEffectInstance;
    entries: ReferenceIncomingEffectCall[];
    effects: Map<string, ReferenceIncomingEffectBranch>;
  }>();
  const entryKey = (entry: ReferenceIncomingEffectCall): string =>
    `${entry.ownerKind}:${entry.owner.id}:${entry.node.id}`;
  for (const entry of referenceIncomingEffectCalls(data, targetIndex)) {
    for (const source of entry.sources) {
      let caller = callers.get(source.instance.index);
      if (!caller) {
        caller = { instance: source.instance, entries: [], effects: new Map() };
        callers.set(source.instance.index, caller);
      }
      const key = entryKey(entry);
      if (!caller.entries.some(candidate => entryKey(candidate) === key)) caller.entries.push(entry);
      const graphId = entry.call.graph?.id ?? entry.node.references?.effectGraph ?? null;
      const graphKey = graphId ?? `missing:${key}`;
      let effect = caller.effects.get(graphKey);
      if (!effect) {
        effect = { graph: entry.call.graph, graphId, entries: [] };
        caller.effects.set(graphKey, effect);
      }
      if (!effect.entries.some(candidate => entryKey(candidate) === key)) effect.entries.push(entry);
    }
  }
  return [...callers.values()]
    .sort((a, b) => a.instance.modelName.localeCompare(b.instance.modelName) || a.instance.index - b.instance.index)
    .map(caller => ({
      instance: caller.instance,
      entries: caller.entries,
      effects: [...caller.effects.values()].sort((a, b) => {
        const ai = a.graph?.originalIndex ?? Number.MAX_SAFE_INTEGER;
        const bi = b.graph?.originalIndex ?? Number.MAX_SAFE_INTEGER;
        return ai - bi || (a.graph?.name ?? a.graphId ?? '').localeCompare(b.graph?.name ?? b.graphId ?? '');
      }),
    }));
}

/** Concrete effect hosts that can reach a cross-instance call targeting one placed instance. A target can be
 * reached by several nodes and shared functions, so collapse the reverse edges to unique native placements in
 * map order. This is the reverse join used by the editor's explicit caller navigation. */
export function referenceIncomingEffectSources(data: ReferenceEffectsData,
  targetIndex: number): ReferenceEffectInstance[] {
  const indices = new Set<number>();
  for (const entry of referenceIncomingEffectCalls(data, targetIndex))
    for (const source of entry.sources) indices.add(source.instance.index);
  return data.instances.filter(instance => indices.has(instance.index));
}

/** Every cross-instance action reachable from effects attached to one concrete prop. Unlike the reverse target
 * lookup, this preserves sibling calls in a shared function (hide intact, show broken, hide collision proxy). */
export function referenceOutgoingEffectCalls(data: ReferenceEffectsData,
  sourceIndex: number): ReferenceIncomingEffectCall[] {
  return referenceEffectCallLinks(data).filter(entry => entry.sources.some(source => source.instance.index === sourceIndex));
}

/** Outgoing calls that are not already visible as nodes in this instance's directly attached graph tree. Calls
 * owned by a reached function remain useful supplemental detail; repeating graph-owned nodes would duplicate the
 * collision/persistent/etc. list already shown for the selected prop. */
export function referenceSupplementalOutgoingEffectCalls(data: ReferenceEffectsData,
  sourceIndex: number): ReferenceIncomingEffectCall[] {
  const instance = data.instances.find(candidate => candidate.index === sourceIndex);
  const directGraphIds = new Set(instance
    ? referenceInstanceBindings(data, instance).map(binding => binding.graph.id)
    : []);
  return referenceOutgoingEffectCalls(data, sourceIndex)
    .filter(entry => entry.ownerKind !== 'graph' || !directGraphIds.has(entry.owner.id));
}

/** Native instances exposed in Effects mode: direct slot owners plus cross-instance targets. */
export function referenceEffectInstanceIndices(data: ReferenceEffectsData): number[] {
  const indices = new Set(attachedReferenceInstances(data).map(instance => instance.index));
  for (const owner of [...data.document.graphs, ...data.document.functions])
    for (const node of owner.nodes) {
      const target = referenceInstanceEffectCall(data, node)?.target;
      if (target) indices.add(target.index);
    }
  return [...indices];
}

/** Contextual node label for the prop-centric tree. Most nodes are self-contained opcodes; MainType 7 is a
 * visible edge to another placed instance and graph, so show both ends instead of the generic instance.state. */
export function referenceNodeDisplayName(data: ReferenceEffectsData, node: EffectNode): string {
  const call = referenceInstanceEffectCall(data, node);
  if (!call) return effectNodeLabel(node);
  const target = call.target?.name ?? node.references?.instance ?? '(no instance)';
  const graph = call.graph?.name ?? node.references?.effectGraph ?? '(no effect)';
  return `Run ${target} → ${graph}`;
}
