import type { Gem, PlacedProp } from '../doc/types';
import type { EffectsDocument } from '../effects/document';
import { attachEffectTemplateToProp, createEmptyEffectsDocument, nextPlacedPropId } from '../effects/authoring';
import type { PropEffectTemplate } from './effect-defaults';
import { DEFAULT_EFFECT_CIRCUMSTANCES } from './effect-defaults';
import type { StampBehaviour } from './defaults';

/** A retail gem's complete, self-contained spin / pickup chain, with fresh authoring identities. */
export function gemEffectTemplate(level: string, doc: EffectsDocument, slotIndex: number): PropEffectTemplate | null {
  const slot = doc.slots.find((item, index) => (item.originalIndex ?? index) === slotIndex);
  if (!slot) return null;
  const circumstances: PropEffectTemplate['circumstances'] = {};
  const portable = new Set(['property.anim-object', 'score.multiplier', 'particle.timer', 'property.node-tombstone']);
  for (const [column, graphId] of Object.entries(slot.circumstances)) {
    if (!graphId) continue;
    if (!(DEFAULT_EFFECT_CIRCUMSTANCES as readonly string[]).includes(column)) return null;
    const graph = doc.graphs.find(item => item.id === graphId);
    if (!graph || graph.nodes.some(node => !portable.has(node.semanticType ?? '')
      || Object.values(node.references ?? {}).some(ref => ref != null))) return null;
    circumstances[column as keyof typeof circumstances] = graph.nodes.map(node => ({
      mainType: node.mainType, semanticType: node.semanticType, payload: structuredClone(node.payload), references: {},
    }));
  }
  if (!circumstances.collision?.some(node => node.semanticType === 'score.multiplier')) return null;
  return { key: `gem:${level}:${slotIndex}`, circumstances };
}

/** Upgrade only the requested legacy gem. It becomes a real prop with real editable graphs, once. */
export function promoteGem(doc: { name: string; gems?: Gem[]; props?: PlacedProp[]; effects?: EffectsDocument },
  id: string, model: { level: string; model: number; name: string }, defaults: StampBehaviour,
  template: PropEffectTemplate): PlacedProp | null {
  const gem = doc.gems?.find(item => item.id === id);
  if (!gem) return null;
  const props = doc.props ??= [];
  const prop: PlacedProp = { ...structuredClone(defaults), ...model, id: nextPlacedPropId(props),
    specialKind: 'gem', pos: [...gem.pos], yaw: 0, scale: 1, modePresence: 'showoff',
    nativeCollision: { mode: 2, playerCollision: true, responseMass: 0, playerBounce: false, bounceAmount: 0 } };
  const effect = structuredClone(template);
  // Legacy gems each own their tier. Opening one must not start sharing its editable multiplier with others.
  effect.key = `${template.key}:${prop.id}`;
  for (const node of effect.circumstances.collision ?? [])
    if (node.semanticType === 'score.multiplier') node.payload.MultiplierScore = gem.value ?? 2;
  attachEffectTemplateToProp(doc.effects ??= createEmptyEffectsDocument(doc.name), prop.id!, effect, 'Gem');
  props.push(prop);
  doc.gems = doc.gems!.filter(item => item !== gem);
  return prop;
}
