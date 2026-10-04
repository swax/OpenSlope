import type { Gem, PlacedProp, V3 } from '../doc/types';
import {
  addEffectTemplateToProp, bindRiderTeleport, bindZBoostToPlacement, createEmptyEffectsDocument,
  effectAttachments, effectNode, nextPlacedPropId,
} from '../effects/authoring';
import type { EffectNode, EffectsDocument } from '../effects/document';
import type { EffectTemplateId } from '../effects/authoring-catalogue';
import { EFFECT_TRIGGER_LEVEL, effectTriggerCollisionProfile } from '../effects/trigger-volume';

export const SPECIAL_LABELS = {
  'speed-boost': 'Speed boost', 'trick-boost': 'Trick boost', 'reset-zone': 'Reset zone',
  'teleport-entrance': 'Teleport entrance', 'teleport-destination': 'Teleport destination',
  'wind-zone': 'Wind zone', 'vertical-lift': 'Vertical lift', gem: 'Gem',
} as const;
export type SpecialPropKind = keyof typeof SPECIAL_LABELS;
export type SpecialZoneKind = Exclude<SpecialPropKind, 'speed-boost' | 'trick-boost' | 'gem'>;
export type SpecialDocument = { name: string; props?: PlacedProp[]; gems?: Gem[]; effects?: EffectsDocument };

const SEMANTICS: Partial<Record<SpecialPropKind, string>> = {
  'speed-boost': 'rider.boost', 'trick-boost': 'trick.boost', 'reset-zone': 'rider.reset',
  'teleport-entrance': 'rider.teleport', 'wind-zone': 'property.boost',
  'vertical-lift': 'property.z-boost', gem: 'score.multiplier',
};
const TEMPLATES: Record<Exclude<SpecialZoneKind, 'teleport-destination'>, EffectTemplateId> = {
  'reset-zone': 'rider-reset', 'teleport-entrance': 'rider-teleport',
  'wind-zone': 'directional-boost', 'vertical-lift': 'z-boost',
};

export function specialPropNodes(effects: EffectsDocument | undefined, prop: PlacedProp): EffectNode[] {
  const attachment = effects && effectAttachments(effects).find(item => item.target.id === prop.id && item.enabled);
  const slot = attachment && effects!.slots.find(item => item.id === attachment.slot);
  if (!slot) return [];
  const ids = new Set(Object.values(slot.circumstances));
  return effects!.graphs.filter(graph => ids.has(graph.id)).flatMap(graph => graph.nodes);
}

/** Recognize existing pads and authored effects too; adding shortcuts must not strand older placements. */
export function specialPropKind(prop: PlacedProp | undefined, effects?: EffectsDocument): SpecialPropKind | null {
  if (!prop) return null;
  if (prop.specialKind && prop.specialKind in SPECIAL_LABELS) return prop.specialKind;
  const nodes = specialPropNodes(effects, prop);
  return (Object.keys(SEMANTICS) as SpecialPropKind[])
    .find(kind => nodes.some(node => node.semanticType === SEMANTICS[kind])) ?? null;
}

export function specialPropNode(effects: EffectsDocument | undefined, prop: PlacedProp,
  kind: SpecialPropKind): EffectNode | undefined {
  return specialPropNodes(effects, prop).find(node => node.semanticType === SEMANTICS[kind]);
}

/** Add an ordinary invisible prop and wire its ordinary effect. The destination is a non-contact marker. */
export function addSpecialZone(doc: SpecialDocument, kind: SpecialZoneKind, position: V3): PlacedProp {
  const props = (doc.props ??= []);
  const size: V3 = kind === 'reset-zone' ? [40, 2, 40]
    : kind === 'teleport-destination' ? [2, 2, 2] : [12, 6, 12];
  const prop: PlacedProp = {
    id: nextPlacedPropId(props), level: EFFECT_TRIGGER_LEVEL, model: 0,
    name: `${SPECIAL_LABELS[kind]} ${props.filter(item => item.specialKind === kind).length + 1}`,
    specialKind: kind, pos: [...position], yaw: 0, scale: 1, effectTrigger: { size },
    nativeCollision: effectTriggerCollisionProfile(),
  };
  if (kind === 'teleport-destination') {
    prop.nativeCollision!.playerCollision = false;
    prop.nativeCollision!.mode = 0;
  }
  props.push(prop);
  if (kind !== 'teleport-destination') {
    const effects = (doc.effects ??= createEmptyEffectsDocument(doc.name));
    const selection = addEffectTemplateToProp(effects, prop.id!, TEMPLATES[kind]);
    if (kind === 'vertical-lift') bindZBoostToPlacement(effects, selection, prop.pos[1]);
    if (kind === 'teleport-entrance') {
      // A fresh pair is immediately valid. Picking another destination later can make a shared destination.
      const destination = addSpecialZone(doc, 'teleport-destination', [position[0] + 20, position[1], position[2]]);
      bindRiderTeleport(effects, effectNode(effects, selection)!, destination.id!);
    }
  }
  return prop;
}

export function teleportDestination(doc: SpecialDocument, node: EffectNode): PlacedProp | undefined {
  const ref = doc.effects?.instances.find(item => item.id === node.references?.instance);
  const id = (ref?.extensions?.slopesmith as { placement?: string } | undefined)?.placement;
  return id ? doc.props?.find(prop => prop.id === id) : undefined;
}
