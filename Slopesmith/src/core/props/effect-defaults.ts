import type { EffectCircumstance } from '../effects/authoring-contract';
import type { EffectNode, EffectsDocument } from '../effects/document';

/**
 * Effect defaults (docs/069 · Effects): the effect a shipped level's MODEL most often carries, handed to every new
 * placement of it — a crash bag arrives knockable, a fence flexes, a jumbotron scrolls.
 *
 * A retail instance names an EffectSlot, and in practice the slot is per model the way its ObjectProperties row
 * is: in GARI and ELYSIUM, 533 of the 547 placed models that carry an effect have most copies on one identical
 * effect. So the default is the same whole-tuple vote the behaviour defaults use, over the model's visible copies.
 *
 * Only effects that act on the prop ALONE and read nothing from their level's tables qualify: every node one of
 * `DEFAULT_EFFECT_KINDS`, no node naming another instance, graph, function or spline. That leaves out level wiring
 * (a glass pane that breaks its neighbours, a screen that switches others) and, for now, sounds, particles, crowds
 * and gems, whose payloads point into the source level's banks and tables.
 */

/** A node as a template carries it: everything but the ids its placement's own graph assigns. */
export type PropEffectNode = Omit<EffectNode, 'id' | 'originalIndex'>;

/** The slot columns an effect default may populate — the three authoring exposes. */
export const DEFAULT_EFFECT_CIRCUMSTANCES = ['persistent', 'collision', 'trigger'] as const satisfies readonly EffectCircumstance[];
export type DefaultEffectCircumstance = typeof DEFAULT_EFFECT_CIRCUMSTANCES[number];

/** One effect a placement can be given when it is stamped: its slot's node chains, per column. */
export interface PropEffectTemplate {
  /** The effect's identity across placements: one key, one shared slot, as retail instances share one. */
  key: string;
  circumstances: Partial<Record<DefaultEffectCircumstance, PropEffectNode[]>>;
}

/** Which of a level's effect templates a model defaults to, and how many of its visible copies carry it. */
export interface PropEffectDefault {
  template: number;
  matching: number;
  total: number;
}

/**
 * Node kinds an effect default may be made of, with what each does to the prop. Each plays in Test on an authored
 * placement exactly as on a reference instance, and reads only the prop's own model and materials.
 */
const EFFECT_KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ['property.roller', 'knockable'],
  ['property.fence', 'flexes when hit'],
  ['property.texture-flip', 'flips its texture'],
  ['property.uv-scroll', 'scrolls its texture'],
  ['property.uv-scroll-texture-flip', 'scrolls and flips its texture'],
  ['property.mesh-animation', 'breaks into pieces'],
  ['rider.reset', 'resets the rider'],
  // Structural: they order and gate the nodes above rather than doing anything visible.
  ['property.debounce', ''], ['wait', ''], ['property.node-tombstone', ''],
]);
export const DEFAULT_EFFECT_KINDS: ReadonlySet<string> = new Set(EFFECT_KIND_LABELS.keys());

/** What a template does, in the words the held-prop panel uses: "knockable · breaks into pieces". */
export function effectTemplateLabel(template: PropEffectTemplate): string {
  const words = new Set<string>();
  for (const nodes of Object.values(template.circumstances))
    for (const node of nodes ?? []) {
      const word = node.semanticType === 'rider.boost' ? 'speed boost'
        : node.semanticType === 'trick.boost' ? 'trick boost'
          : EFFECT_KIND_LABELS.get(node.semanticType ?? '');
      if (word) words.add(word);
    }
  return [...words].join(' · ') || 'effect';
}

/** Key-order-independent serialization, so two slots authored in different orders compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a, hex: a compact key for a signature that can run to kilobytes of payload. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

const hasReference = (node: EffectNode): boolean =>
  Object.values(node.references ?? {}).some(value => value !== null && value !== undefined);

/**
 * One slot as an effect template, or null when it may not be one: a column outside the authored three, a node
 * of a kind that is not a default kind, or a node that names anything outside the prop. `level` scopes the key —
 * the same bytes mean a different texture flip on another level's model.
 */
export function slotEffectTemplate(level: string, document: EffectsDocument,
  slot: EffectsDocument['slots'][number]): PropEffectTemplate | null {
  const graphs = new Map(document.graphs.map(graph => [graph.id, graph]));
  const circumstances: PropEffectTemplate['circumstances'] = {};
  for (const [circumstance, graphId] of Object.entries(slot.circumstances) as [EffectCircumstance, string | null][]) {
    if (!graphId) continue;
    const graph = graphs.get(graphId);
    if (!graph?.nodes.length) continue;
    if (!(DEFAULT_EFFECT_CIRCUMSTANCES as readonly string[]).includes(circumstance)) return null;
    for (const node of graph.nodes)
      if (!DEFAULT_EFFECT_KINDS.has(node.semanticType ?? '') || hasReference(node)) return null;
    circumstances[circumstance as DefaultEffectCircumstance] = graph.nodes.map(node => {
      const copy: PropEffectNode = { mainType: node.mainType, payload: structuredClone(node.payload) };
      if (node.semanticType) copy.semanticType = node.semanticType;
      if (node.extensions) copy.extensions = structuredClone(node.extensions);
      return copy;
    });
  }
  if (!Object.keys(circumstances).length) return null;
  return { key: `${level}:${hash(stable(circumstances))}`, circumstances };
}

/** One reference instance as the vote reads it, passed in Instances.json order so its position is its source
 *  index. `slot` is its EffectSlotIndex, -1 or absent for none. */
export interface EffectVoteInstance {
  model: number;
  visible: boolean;
  name: string;
  slot?: number;
}

/**
 * A level's effect defaults: the templates its models and instances may carry, which template each qualifying
 * instance carries, and each model's default — the effect its visible copies most often carry, when that effect
 * qualifies. Invisible copies and junk/reset twins do not vote, exactly as for the behaviour defaults; a copy with
 * no effect, or one that does not qualify, still votes, so a billboard of which 7 of 43 play a movie defaults to none.
 */
export function referenceEffectDefaults(level: string, document: EffectsDocument | null,
  instances: readonly EffectVoteInstance[]): {
    templates: PropEffectTemplate[];
    byInstance: Map<number, number>;
    byModel: Map<number, PropEffectDefault>;
  } {
  const templates: PropEffectTemplate[] = [];
  const byInstance = new Map<number, number>();
  const byModel = new Map<number, PropEffectDefault>();
  if (!document) return { templates, byInstance, byModel };
  const slots = new Map(document.slots.map((slot, index) => [slot.originalIndex ?? index, slot]));
  // Each slot is resolved once, however many instances name it: -1 for "carries no qualifying template".
  const templateOfSlot = new Map<number, number>();
  const templateIndex = new Map<string, number>();
  const resolve = (slotIndex: number): number => {
    const known = templateOfSlot.get(slotIndex);
    if (known !== undefined) return known;
    const slot = slots.get(slotIndex);
    const template = slot ? slotEffectTemplate(level, document, slot) : null;
    let index = -1;
    if (template) {
      index = templateIndex.get(template.key) ?? templates.push(template) - 1;
      templateIndex.set(template.key, index);
    }
    templateOfSlot.set(slotIndex, index);
    return index;
  };

  const votes = new Map<number, Map<string, number>>();
  instances.forEach((instance, sourceIndex) => {
    const slotIndex = Number.isInteger(instance.slot) && instance.slot! >= 0 && slots.has(instance.slot!)
      ? instance.slot! : -1;
    const template = slotIndex >= 0 ? resolve(slotIndex) : -1;
    if (template >= 0) byInstance.set(sourceIndex, template);
    if (!instance.visible || /junk|_reset/i.test(instance.name)) return;
    // A qualifying effect votes as its template; any other slot votes as itself, so it can win and default to none.
    const ballot = template >= 0 ? `t${template}` : slotIndex >= 0 ? `s${slotIndex}` : 'none';
    const tally = votes.get(instance.model) ?? new Map<string, number>();
    tally.set(ballot, (tally.get(ballot) ?? 0) + 1);
    votes.set(instance.model, tally);
  });
  for (const [model, tally] of votes) {
    let best = '', count = 0, runnerUp = 0, total = 0;
    for (const [ballot, n] of tally) {
      total += n;
      if (n > count) { runnerUp = count; best = ballot; count = n; } else if (n > runnerUp) runnerUp = n;
    }
    // A tie is no mandate: a model whose copies split evenly over an effect gets none rather than a coin toss.
    if (best.startsWith('t') && count > runnerUp)
      byModel.set(model, { template: Number(best.slice(1)), matching: count, total });
  }
  return { templates, byInstance, byModel };
}
