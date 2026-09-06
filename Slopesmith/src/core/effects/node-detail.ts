import type { EffectNode } from './document';
import {
  EFFECT_TEMPLATES, UNAUTHORABLE_EFFECT_NODES,
  type EffectTemplate, type EffectTemplateProof,
} from './authoring';

/**
 * What is known about one node, wherever it came from.
 *
 * A node in a RETAIL level and a node the editor just laid down are the same opcode, and until now they read
 * as two different things: the authored one carried a label, a plain-language description and — where a PS2
 * run had demonstrated it — the evidence, while the reference one showed a de-punctuated wire string
 * ("property cracked", "instance flag 0x800 set") and a bare list of numbers. That asymmetry is backwards.
 * The reference viewer is where the knowledge is worth MOST, because there the reader is trying to work out
 * what a shipped level is doing, and everything we know about the node is already written down one module
 * over.
 *
 * So this derives one record per semantic type out of the two places that already hold the vocabulary:
 * `EFFECT_TEMPLATES` (what the editor can lay down, with its validation record) and
 * `UNAUTHORABLE_EFFECT_NODES` (what it will not, with the reason). Deriving rather than restating is the
 * point — a template that gains a `proven` badge, or a node that stops being blocked, changes both surfaces
 * at once and cannot drift between them.
 */
export interface EffectNodeDetail {
  /** The human name — the authoring template's own label, so the picker and the inspector agree. */
  label: string;
  /** What the node does, in one or two plain sentences. Always safe to show; this is the tier a reader sees
   *  without asking. Absent for a type with neither a template nor a reason. A BLOCKED node repeats its
   *  reason here rather than leaving this empty, so a caller that only reads `summary` still shows something
   *  true — a UI that renders both should prefer `blocked`. */
  summary?: string;
  /** Usage guidance for the author who has already chosen this node and wants to get it right. Shown on
   *  demand, never inline: it is the tier that would drown the fields it sits above. */
  detail?: string;
  /** What a live PS2 run demonstrated, when one has. */
  validated?: EffectTemplateProof;
  /** Why the editor will not lay this node down, when it will not. */
  blocked?: string;
  /** The authoring template this reading came from, for callers that want to offer it. */
  templateId?: EffectTemplate['id'];
}

/**
 * Names for nodes that have neither a template nor an unauthorable entry, and whose wire string reads worse
 * than what the node does. The `semanticType` is the Snowknife interchange contract and is deliberately NOT
 * renamed; this is the display layer only.
 */
const FALLBACK_LABELS: Readonly<Record<string, string>> = {
  'condition.gate': 'Only if… (other test)',
  'property.dead-node': 'Stop a node (other mode)',
  'node.control.command': 'Command to another prop',
};

/** Templates that declare a given semantic type, in declaration order. */
const templatesBySemanticType = (): Map<string, EffectTemplate[]> => {
  const out = new Map<string, EffectTemplate[]>();
  for (const template of EFFECT_TEMPLATES)
    for (const node of template.nodes ?? []) {
      if (!node.semanticType) continue;
      const list = out.get(node.semanticType);
      if (list) { if (!list.includes(template)) list.push(template); }
      else out.set(node.semanticType, [template]);
    }
  return out;
};

const TEMPLATES_BY_TYPE = templatesBySemanticType();
const BLOCKED_BY_TYPE = new Map(UNAUTHORABLE_EFFECT_NODES.map(entry => [entry.semanticType, entry]));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every numeric leaf of a payload, keyed by its dotted path. Two nodes of one sub-type share a shape, so
 *  comparing leaves is comparing the words that distinguish them. */
function numericLeaves(value: unknown, prefix = '', out = new Map<string, number>()): Map<string, number> {
  if (typeof value === 'number') { out.set(prefix, value); return out; }
  if (isObject(value)) for (const [key, child] of Object.entries(value))
    numericLeaves(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

/**
 * Which of several templates sharing one semantic type this node actually is.
 *
 * Several semantic types carry more than one template, and for two different reasons. Some are two MACHINES
 * in one record rather than one node with a setting — a Flipbook and a Dwell screen are both sub-type 11 and
 * differ by one word — and calling a retail dwell screen "Flipbook" would be a confident wrong answer where
 * the old de-punctuated string was merely unhelpful. The rest are recipes that embed a node another template
 * already offers alone.
 *
 * So the pick is made on the payload: score each candidate by how many numeric words it agrees with the node
 * on, and take the best. That separates the machines. Declaration order breaks a tie, which handles the
 * recipes — a recipe is declared after the node it embeds, so the plain node wins whenever the payloads are
 * identical (`debounce` over the ride-over button, `anim-object` over `one-shot-clip`).
 */
function pickTemplate(candidates: readonly EffectTemplate[], semanticType: string,
  node: Pick<EffectNode, 'payload'>): EffectTemplate {
  if (candidates.length === 1) return candidates[0];
  const leaves = numericLeaves(node.payload);
  let best = candidates[0], bestScore = -1;
  for (const template of candidates) {
    const own = template.nodes?.find(item => item.semanticType === semanticType);
    const templateLeaves = numericLeaves(own?.payload ?? {});
    let score = 0;
    for (const [path, value] of templateLeaves) if (leaves.get(path) === value) score++;
    if (score > bestScore) { best = template; bestScore = score; }
  }
  return best;
}

/**
 * The honest last resort. A numeric fallback type is the decoder saying "this is a real node of a kind
 * nothing has named", so it is spelled out as the number it is rather than de-punctuated into "main 6",
 * which reads like a word that got mangled instead of like an opcode nobody has recovered.
 */
const fallbackLabel = (semanticType: string | undefined, mainType: number): string => {
  if (!semanticType) return `Main type ${mainType}`;
  if (FALLBACK_LABELS[semanticType]) return FALLBACK_LABELS[semanticType];
  const command = /^node\.control\.command-(-?\d+)$/.exec(semanticType);
  if (command) return `${FALLBACK_LABELS['node.control.command']} ${command[1]}`;
  const numeric = /^(property|emitter|main)\.(-?\d+)$/.exec(semanticType);
  if (numeric) return numeric[1] === 'main' ? `Main type ${numeric[2]}`
    : numeric[1] === 'emitter' ? `Emitter sub-type ${numeric[2]}` : `Property sub-type ${numeric[2]}`;
  return semanticType.replace(/[._-]+/g, ' ');
};

/**
 * Everything known about a node, for display. Never throws and never returns null: an unrecognised node still
 * gets a label, because a blank where a name belongs reads as a bug in the viewer rather than as a gap in the
 * vocabulary.
 */
export function effectNodeDetail(node: Pick<EffectNode, 'mainType' | 'semanticType' | 'payload'>): EffectNodeDetail {
  const semanticType = node.semanticType;
  const candidates = semanticType ? TEMPLATES_BY_TYPE.get(semanticType) : undefined;
  const blocked = semanticType ? BLOCKED_BY_TYPE.get(semanticType) : undefined;
  if (candidates?.length && semanticType) {
    const template = pickTemplate(candidates, semanticType, node);
    return {
      label: template.label,
      summary: template.summary,
      ...(template.detail ? { detail: template.detail } : {}),
      ...(template.proven ? { validated: template.proven } : {}),
      templateId: template.id,
    };
  }
  if (blocked) return { label: blocked.label, summary: blocked.reason, blocked: blocked.reason };
  return { label: fallbackLabel(semanticType, node.mainType) };
}

/** The display name alone — the common case, and the one the trees call per row. */
export const effectNodeLabel = (node: Pick<EffectNode, 'mainType' | 'semanticType' | 'payload'>): string =>
  effectNodeDetail(node).label;
