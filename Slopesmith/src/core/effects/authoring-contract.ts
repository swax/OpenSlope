import type { EffectSlot, EffectsDocument } from './document';
import { animObjectFromNode } from './world-effects';

export type EffectOwnerKind = 'graph' | 'function';
export interface EffectSelection {
  ownerKind: EffectOwnerKind;
  ownerId: string;
  nodeId?: string;
}

export type EffectCircumstance = keyof EffectSlot['circumstances'];
export type AuthoredEffectCircumstance = Extract<EffectCircumstance, 'persistent' | 'collision' | 'trigger'>;

/** Wire keys stay `slot3`/`slot4` (shipped openslope-effects-v1); the labels carry the recovered engine meaning:
 * column 3 runs on world-grid region DEACTIVATION and column 4 when an installed node self-ends, each
 * *instead of* the default node teardown + instance-flag restore [Trailmap: 150-logic §slot-columns].
 * Columns 6/7 have no engine reader at all. */
const EFFECT_CIRCUMSTANCE_LABEL: Record<EffectCircumstance, string> = {
  persistent: 'Persistent',
  collision: 'Collision',
  slot3: 'Region exit',
  slot4: 'Effect end',
  trigger: 'Trigger',
  slot6: 'Slot 6',
  slot7: 'Slot 7',
};

export const effectCircumstanceLabel = (circumstance: EffectCircumstance): string =>
  EFFECT_CIRCUMSTANCE_LABEL[circumstance];

export type EffectLatchCircumstance = Extract<EffectCircumstance, 'slot3' | 'slot4'>;
export const EFFECT_LATCH_CIRCUMSTANCES: readonly EffectLatchCircumstance[] = ['slot3', 'slot4'];

/** One-line semantic reading for a populated latch column. Both are measured on hardware, each against an
 * unlatched control carrying the identical chain, and the pair is the reason both are offered: which one an
 * effect needs is decided by HOW ITS NODE ENDS, not by what the effect does. A play-once clip and a pulsing
 * flipbook end themselves and are held by slot4; a breakable kill's tombstone never self-ends and is only
 * reached by slot3. Checking the wrong one is a silent no-op. */
export const EFFECT_LATCH_SUMMARY: Record<EffectLatchCircumstance, string> = {
  slot3: 'Keeps the prop as it is when the rider leaves the area, instead of resetting it. This is the one that keeps a broken prop broken.',
  slot4: 'Holds a finished effect where it ended — a play-once clip stays on its last frame — instead of resetting. Only works on effects that finish by themselves.',
};

export const isEffectLatchCircumstance = (circumstance: EffectCircumstance): circumstance is EffectLatchCircumstance =>
  circumstance === 'slot3' || circumstance === 'slot4';

/** True when a slot's populated latch column has the retail authored shape: a reference to a zero-node graph. */
export function effectSlotLatchIsEmptyGraph(document: EffectsDocument, slot: EffectSlot,
  circumstance: EffectLatchCircumstance): boolean {
  const graphId = slot.circumstances[circumstance];
  if (!graphId) return false;
  const graph = document.graphs.find(item => item.id === graphId);
  return !!graph && graph.nodes.length === 0;
}

/** The engine's own test — populated-ness, regardless of what the referenced chain contains. */
export const effectSlotHoldsAtEnd = (slot: EffectSlot | null | undefined): boolean =>
  !!slot?.circumstances.slot4;
export const effectSlotHoldsOnRegionExit = (slot: EffectSlot | null | undefined): boolean =>
  !!slot?.circumstances.slot3;

/** True when some effect reachable on this slot can self-end and so consult the Effect-end latch: a
 * play-once model clip in the slot's own graphs, or a MainType-7 hand-off anywhere in the document that
 * plays a play-once clip on an instance bound to this slot (the Elysium iris door's shape — its own slot
 * carries only the two latches; the clip arrives from the trigger volumes' collision graph). A delta-gated
 * Sub257 clip never reaches its end block and never counts [Trailmap: 150-logic §slot-columns]. */
export function effectSlotCanSelfEnd(document: EffectsDocument, slot: EffectSlot): boolean {
  const graphById = new Map(document.graphs.map(graph => [graph.id, graph]));
  const playsOnce = (graphId: string | null | undefined): boolean => {
    const graph = graphId ? graphById.get(graphId) : null;
    return !!graph?.nodes.some(node => animObjectFromNode(node)?.loopMode === 0);
  };
  if (Object.values(slot.circumstances).some(playsOnce)) return true;
  const propertyById = new Map(document.objectProperties.map(property => [property.id, property]));
  const slotOfInstance = (instanceId: string | null | undefined): string | null => {
    const binding = instanceId ? document.instances.find(item => item.id === instanceId) : null;
    const property = binding?.property ? propertyById.get(binding.property) : null;
    return property?.references.effectSlot ?? null;
  };
  for (const owner of [...document.graphs, ...document.functions])
    for (const node of owner.nodes)
      if (node.mainType === 7 && playsOnce(node.references?.effectGraph)
        && slotOfInstance(node.references?.instance) === slot.id) return true;
  return false;
}
