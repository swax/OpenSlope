// tier: fast

/**
 * Effect defaults (docs/069 · Effects), checked without a browser:
 *  - a slot becomes a template only when every node acts on the prop alone — a default kind, naming nothing
 *    outside it — in one of the three authored columns; the key ignores key order and is scoped by level;
 *  - a model's default is the effect its visible copies most often carry, by whole-effect vote in which copies
 *    with no effect (or a non-portable one) vote too, junk and hidden copies do not, and a tie means none;
 *  - placements of one effect share one slot, built on first use and rebuilt if deleted, and a placement that
 *    already carries an effect is left alone;
 *  - the props payload carries templates, model defaults and instance effects, and drops dangling indices.
 *
 * Run: tsx test/effect-defaults.test.ts
 */
import type { EffectNode, EffectsDocument, EffectSlot } from '../src/core/effects/document';
import {
  attachEffectTemplateToProp, createEmptyEffectsDocument, effectAttachments,
} from '../src/core/effects/authoring';
import { effectTemplateLabel, referenceEffectDefaults, slotEffectTemplate } from '../src/core/props/effect-defaults';
import { decodeProps, type PropsPayload } from '../src/core/reference/props';
import { check, failures } from './check';

const roller = (mass: number): Omit<EffectNode, 'id'> => ({ mainType: 0, semanticType: 'property.roller',
  payload: { type0: { SubType: 0, type0Sub0: { U0: mass, U1: 0.002, U2: 1.5, U3: 0, U4: 0, U5: 0 } } }, references: {} });
const scroll: Omit<EffectNode, 'id'> = { mainType: 0, semanticType: 'property.uv-scroll',
  payload: { type0: { SubType: 10, UVScroll: { U0: 0, U1: -0.05, U2: 0, U3: 1, U4: 0, U5: 0 } } }, references: {} };
const particle: Omit<EffectNode, 'id'> = { mainType: 2, semanticType: 'particle.timer',
  payload: { type2: { SubType: 0 } }, references: {} };
const hop = (target: string): Omit<EffectNode, 'id'> => ({ ...roller(5), references: { instance: target } });

/** A level document whose slots each run one graph in one column. */
function level(slots: { column: keyof EffectSlot['circumstances']; nodes: Omit<EffectNode, 'id'>[] }[]): EffectsDocument {
  const doc = createEmptyEffectsDocument('TEST');
  slots.forEach((slot, index) => {
    const graphId = `graph:${index}`;
    doc.graphs.push({ id: graphId, nodes: slot.nodes.map((node, n) => ({ ...node, id: `${graphId}/node:${n}` })) });
    const circumstances = { persistent: null, collision: null, slot3: null, slot4: null, trigger: null, slot6: null,
      slot7: null } as EffectSlot['circumstances'];
    circumstances[slot.column] = graphId;
    doc.slots.push({ id: `slot:${index}`, originalIndex: index, circumstances });
  });
  return doc;
}

// ---- what may be a template
{
  const doc = level([
    { column: 'collision', nodes: [roller(5)] },
    { column: 'persistent', nodes: [scroll, particle] },
    { column: 'collision', nodes: [hop('instance:000003')] },
    { column: 'slot3', nodes: [scroll] },
  ]);
  const bag = slotEffectTemplate('GARI', doc, doc.slots[0]);
  check(!!bag && bag.circumstances.collision?.length === 1 && effectTemplateLabel(bag) === 'knockable',
    'a lone collision Roller is a knockable template');
  check(!!bag && !('id' in bag.circumstances.collision![0]), 'template nodes carry no ids of their own');
  check(slotEffectTemplate('GARI', doc, doc.slots[1]) === null, 'a particle emitter keeps the whole effect out');
  check(slotEffectTemplate('GARI', doc, doc.slots[2]) === null, 'a node naming another instance is level wiring');
  check(slotEffectTemplate('GARI', doc, doc.slots[3]) === null, 'a column outside the authored three is out');
  const reordered = level([{ column: 'collision', nodes: [{ references: {}, payload: roller(5).payload,
    semanticType: 'property.roller', mainType: 0 }] }]);
  check(slotEffectTemplate('GARI', reordered, reordered.slots[0])?.key === bag?.key,
    'the key ignores the order a node’s fields were written in');
  check(slotEffectTemplate('ELYSIUM', doc, doc.slots[0])?.key !== bag?.key, 'and is scoped by level');
}

// ---- the vote
{
  const doc = level([
    { column: 'collision', nodes: [roller(5)] },
    { column: 'persistent', nodes: [scroll, particle] },
    { column: 'persistent', nodes: [scroll] },
  ]);
  const at = (model: number, slot: number, over: { visible?: boolean; name?: string } = {}) =>
    ({ model, slot, visible: over.visible ?? true, name: over.name ?? 'Mdl' });
  const out = referenceEffectDefaults('GARI', doc, [
    at(1, 0), at(1, 0), at(1, 0), at(1, -1),          // crash bags: 3 of 4 knockable
    at(2, 1), at(2, 1), at(2, 2),                     // boost pads: most carry a particle, so no default
    at(3, 2), at(3, -1),                              // a split screen: a tie is no default
    at(4, -1), at(4, -1), at(4, 2),                   // billboards: most carry nothing
    at(5, 2, { visible: false }), at(5, 2, { name: 'Mdl_Junk_1' }), at(5, -1), // only the plain copy votes
  ]);
  const bag = out.byModel.get(1);
  check(!!bag && effectTemplateLabel(out.templates[bag.template]) === 'knockable' && bag.matching === 3 && bag.total === 4,
    'a model defaults to the effect most of its copies carry, counted over every visible copy');
  check(!out.byModel.has(2), 'a winning effect that is not portable means no default, not the runner-up');
  check(!out.byModel.has(3), 'an even split means no default');
  check(!out.byModel.has(4), 'copies with no effect vote for none');
  check(!out.byModel.has(5), 'hidden copies and junk twins do not vote');
  check(out.byInstance.get(12) === out.byInstance.get(7) && out.byInstance.has(12),
    'every copy still reports its own portable effect, hidden ones included');
  check(!out.byInstance.has(4), 'a copy whose effect is not portable reports none');
  check(out.templates.length === 2, 'each distinct portable effect is one template');
}

// ---- attaching: one shared slot per effect
{
  const source = level([{ column: 'collision', nodes: [roller(5)] }]);
  const template = slotEffectTemplate('GARI', source, source.slots[0])!;
  const doc = createEmptyEffectsDocument('MINE');
  check(attachEffectTemplateToProp(doc, 'prop:0000', template, 'CrashBag'), 'the first placement gets the effect');
  check(attachEffectTemplateToProp(doc, 'prop:0001', template, 'CrashBag'), 'and so does the second');
  const attachments = effectAttachments(doc);
  check(doc.slots.length === 1 && doc.graphs.length === 1 && attachments.length === 2
    && attachments.every(item => item.slot === doc.slots[0].id && item.circumstance === 'collision'),
  'placements of one effect share one slot, as retail instances do');
  check(doc.graphs[0].nodes[0].semanticType === 'property.roller' && doc.graphs[0].nodes[0].id.startsWith(doc.graphs[0].id),
    'the slot runs the template’s nodes under ids of its own graph');
  check(!attachEffectTemplateToProp(doc, 'prop:0000', template, 'CrashBag') && effectAttachments(doc).length === 2,
    'a placement that already carries an effect is left alone');
  doc.graphs = [];
  check(attachEffectTemplateToProp(doc, 'prop:0002', template, 'CrashBag') && doc.slots.length === 2,
    'a shared slot whose graph was deleted is not reused; a fresh one is built');
}

// ---- payload
{
  const source = level([{ column: 'collision', nodes: [roller(5)] }]);
  const template = slotEffectTemplate('GARI', source, source.slots[0])!;
  const payload = {
    level: 'GARI', materials: [], effects: [template],
    models: [{ id: 1, name: 'bag', subs: [], fx: { t: 0, n: 22, of: 22 } }, { id: 2, name: 'x', subs: [], fx: { t: 4, n: 1, of: 1 } }],
    instances: [{ i: 0, m: 1, p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], n: 'a', fx: 0 },
      { i: 1, m: 2, p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], n: 'b', fx: 9 }],
  } as unknown as PropsPayload;
  const props = decodeProps(payload);
  check(props.effects?.length === 1 && props.models[0].effect?.matching === 22 && props.instances[0].effect === 0,
    'the payload’s templates, model defaults and instance effects decode');
  check(props.models[1].effect === undefined && props.instances[1].effect === undefined,
    'an index that lands on no template decodes as no effect');
}

console.log(failures ? `\n${failures} failure(s)` : '\neffect-defaults: ok');
process.exit(failures ? 1 : 0);
