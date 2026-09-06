// tier: fast

/**
 * The contract between what hardware has PROVEN, what the editor can AUTHOR, and what the inspector SHOWS.
 *
 * Three bodies of work drift apart on their own. `Trailmap/tools/autotest` grows cells that tune payload words
 * on real hardware; `core/effects/authoring.ts` grows templates and validation badges; `semantic-fields.ts`
 * grows the controls an author actually turns. Nothing has ever joined them, so the failures are all silent:
 *
 *   - a cell demonstrates that a word is read and tunable, and the editor offers no control for it, so the
 *     one number the batch established can only be reached by hand-editing Raw;
 *   - a `tune` hook writes a path that no longer exists in the template it is tuning, so the cell rides the
 *     DEFAULT and reports a perfectly clean result about a question it never asked;
 *   - a template's `proven` badge cites a cell that has since been renamed, so the evidence cannot be re-run;
 *   - a new semantic type lands in the vocabulary with neither a template nor a reason, and reads to an
 *     author as "SSX has no such thing".
 *
 * Every one of those costs a twenty-minute ride to notice, or is never noticed at all. They are all decidable
 * offline, which is what this does. Run: tsx test/effects-catalogue.test.ts
 */
import {
  EFFECT_TEMPLATES, UNAUTHORABLE_EFFECT_NODES, addEffectNodeTemplate, createEmptyEffectsDocument,
  effectNode, type EffectTemplate, type EffectNodeTemplateId,
} from '../src/core/effects/authoring';
import {
  CANONICAL_SEMANTIC_TYPES, compatibleEffectSemanticTypes, validateEffectsDocument,
  type EffectNode, type JsonObject,
} from '../src/core/effects/document';
import {
  semanticInspectorForNode, semanticNumberValue, type EffectSemanticNumberField,
} from '../src/core/effects/semantic-fields';
import { effectNodeDetail } from '../src/core/effects/node-detail';
import { AUTO_TEST_FIXTURES, type AutoTestCase } from '../src/core/collision/autotest';
import { check, failures } from './check';

/** One failing line per offender rather than one for the whole family: a list of eight names in a single
 *  message is read as one problem, and each of these is its own. */
const checkNone = (offenders: readonly string[], label: string): void => {
  if (!offenders.length) { check(true, label); return; }
  for (const offender of offenders) check(false, `${label}: ${offender}`);
};

const templateNodes = (template: EffectTemplate) => template.nodes ?? [];
const asNode = (mainType: number, semanticType: string | undefined, payload: JsonObject): EffectNode =>
  ({ id: 'probe', mainType, ...(semanticType ? { semanticType } : {}), payload, references: {} });

// ---------------------------------------------------------------------------------------------------------
console.log('\n# the vocabulary is fully accounted for');

const authorableTypes = new Set<string>();
for (const template of EFFECT_TEMPLATES)
  for (const node of templateNodes(template)) if (node.semanticType) authorableTypes.add(node.semanticType);
const blockedTypes = new Map(UNAUTHORABLE_EFFECT_NODES.map(entry => [entry.semanticType, entry]));

// A canonical type with neither an entry reads as an absence, and an absence reads as "the engine has no such
// node" — which is the one thing it never means. Either the editor lays it down or it says what stands in the
// way, and adding a type to the vocabulary is what forces that decision.
checkNone([...CANONICAL_SEMANTIC_TYPES].filter(type => !authorableTypes.has(type) && !blockedTypes.has(type)),
  'every canonical semantic type is either authorable or blocked with a reason');
checkNone([...blockedTypes.keys()].filter(type => !CANONICAL_SEMANTIC_TYPES.has(type)),
  'every blocked entry names a canonical semantic type');
checkNone([...authorableTypes].filter(type => blockedTypes.has(type)),
  'no semantic type is both authorable and blocked');
checkNone(UNAUTHORABLE_EFFECT_NODES.filter(entry => !entry.reason.trim() || !entry.label.trim())
  .map(entry => entry.semanticType), 'every blocked entry carries a label and a reason');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# every template is a node the engine would recognise');

// The declared meaning and the payload are two statements about one node, written in two places. A template
// whose sub-type is edited without its `semanticType` exports a node that does something other than what the
// picker promised, and nothing downstream re-derives it.
checkNone(EFFECT_TEMPLATES.flatMap(template => templateNodes(template).flatMap(node => {
  const compatible = compatibleEffectSemanticTypes({ mainType: node.mainType, payload: node.payload });
  return node.semanticType && !(compatible ?? []).includes(node.semanticType)
    ? [`${template.id} declares ${node.semanticType}, payload decodes to ${(compatible ?? ['nothing']).join(' | ')}`]
    : [];
})), 'every template payload decodes to the semantic type it declares');

const laydownFailures: string[] = [];
for (const template of EFFECT_TEMPLATES) {
  if (!template.nodes?.length) continue;
  const doc = createEmptyEffectsDocument('CATALOGUE');
  const graphId = 'graph:0000';
  doc.graphs.push({ id: graphId, name: 'probe', nodes: [] });
  const selection = addEffectNodeTemplate(doc, { ownerKind: 'graph', ownerId: graphId },
    template.id as EffectNodeTemplateId);
  if (!selection || !effectNode(doc, selection)) { laydownFailures.push(`${template.id} laid down nothing`); continue; }
  const issues = validateEffectsDocument(doc);
  if (issues.length) laydownFailures.push(`${template.id}: ${issues.map(i => `${i.path} ${i.message}`).join('; ')}`);
}
checkNone(laydownFailures, 'every template lays down into a document that validates');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# every authorable node has controls, and every control reaches a real word');

// "No named semantic controls are mapped for this node yet" is the inspector's honest fallback for a payload
// nobody has decoded. On a node the editor OFFERS it is a different statement — the author is looking at
// something the tool told them to use — so a template either exposes fields or says in a note why it has none.
checkNone(EFFECT_TEMPLATES.flatMap(template => templateNodes(template).flatMap(node => {
  const inspector = semanticInspectorForNode(asNode(node.mainType, node.semanticType, node.payload));
  return inspector.fields.length || inspector.note
    ? [] : [`${template.id} / ${node.semanticType ?? `main ${node.mainType}`}`];
})), 'every authorable template node has semantic fields or an explaining note');

// A field whose path has drifted renders nothing at all, so the control silently disappears rather than
// erroring — which looks exactly like a node that has no such setting.
checkNone(EFFECT_TEMPLATES.flatMap(template => templateNodes(template).flatMap(node => {
  const probe = asNode(node.mainType, node.semanticType, node.payload);
  return semanticInspectorForNode(probe).fields
    .filter(spec => semanticNumberValue(probe, spec) === null)
    .map(spec => `${template.id} / ${node.semanticType}: "${spec.label}" at ${spec.path.join('.')}`);
})), 'every semantic field resolves against its own template default');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# every validation badge can be re-run');

// Every row a run can report, which is not the same as every case: a cell with a `companion` also produces a
// `<id>-target` row for the prop the hop lands on, and for the hop cells that row is where the evidence
// actually is — the host would report dispatch whether or not the hop resolved.
const cellIds = new Set<string>();
for (const fixture of AUTO_TEST_FIXTURES) for (const test of fixture.cases) {
  cellIds.add(test.id);
  if (test.companion) cellIds.add(`${test.id}-target`);
}

/** A `proven.cell` is a slash-separated list of cell ids, and a couple are prose ("every gold-map cell")
 *  because the claim really is about all of them. A token with a space in it is prose; anything else is an
 *  id and has to resolve, or the evidence cannot be found and re-ridden. */
const citedCells = (cell: string): string[] =>
  cell.split('/').map(part => part.trim()).filter(part => part && !part.includes(' '));

checkNone(EFFECT_TEMPLATES.flatMap(template => {
  const proven = template.proven;
  if (!proven) return [];
  const missing = citedCells(proven.cell).filter(id => !cellIds.has(id));
  const problems = missing.map(id => `${template.id} cites cell "${id}", which no fixture carries`);
  if (!proven.run.trim()) problems.push(`${template.id} names no run`);
  if (!proven.observed.trim()) problems.push(`${template.id} records no observation`);
  return problems;
}), 'every proven template cites a live fixture cell, a run and an observation');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# every fixture cell is internally consistent');

const allCases: { fixture: string; test: AutoTestCase }[] = AUTO_TEST_FIXTURES
  .flatMap(fixture => fixture.cases.map(test => ({ fixture: fixture.name, test })));

checkNone(AUTO_TEST_FIXTURES.flatMap(fixture => {
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const test of fixture.cases) { if (seen.has(test.id)) duplicates.add(test.id); seen.add(test.id); }
  return [...duplicates].map(id => `${fixture.name} carries "${id}" twice`);
}), 'cell ids are unique within a fixture');

// A graded cell without provenance is an assertion nobody can trace back to the batch that earned it, which
// is the difference between a catalogue and a wish list.
checkNone(allCases.filter(({ test }) =>
  (test.expect || test.expectRider || test.expectSlot || test.expectPaint) && !test.demonstrated)
  .map(({ fixture, test }) => `${fixture}/${test.id}`),
  'every graded cell names the run that demonstrated it');

// `expectSlot` grades the ordered trace of the live-node slot, which only exists when the cell asks for it.
// Without the trace the bound is evaluated against nothing and the cell passes for free.
checkNone(allCases.filter(({ test }) => test.expectSlot && !test.watchLiveNode)
  .map(({ fixture, test }) => `${fixture}/${test.id}`),
  'every slot-graded cell traces the live-node slot');

// A flip cannot paint on a single-frame material, and a cell without tiles is dropped from the build — so an
// `expectPaint` on one would grade a cell that is not on the course.
checkNone(allCases.filter(({ test }) => test.expectPaint && !test.needsFlipbook)
  .map(({ fixture, test }) => `${fixture}/${test.id}`),
  'every paint-graded cell asks for the two-frame material it needs');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# every tune hook changes the node it is handed');

const numericLeaves = (value: unknown, prefix = '', out = new Map<string, number>()): Map<string, number> => {
  if (typeof value === 'number') { out.set(prefix, value); return out; }
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [key, child] of Object.entries(value)) numericLeaves(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
};

const templateById = new Map(EFFECT_TEMPLATES.map(template => [template.id as string, template]));

/** The words one tune hook rewrites, run against a fresh copy of the template it will be handed. */
const tuned = (templateId: string, hook: (payload: Record<string, unknown>, ...rest: never[]) => void,
  args: unknown[]): { paths: string[]; template: EffectTemplate } | null => {
  const template = templateById.get(templateId);
  const first = template && templateNodes(template)[0];
  if (!template || !first) return null;
  const payload = structuredClone(first.payload) as Record<string, unknown>;
  const before = numericLeaves(structuredClone(payload));
  (hook as (payload: Record<string, unknown>, ...rest: unknown[]) => void)(payload, ...args);
  const after = numericLeaves(payload);
  const paths = [...after].filter(([path, value]) => before.get(path) !== value).map(([path]) => path);
  for (const path of before.keys()) if (!after.has(path)) paths.push(path);
  return { paths, template };
};

/**
 * The one cell whose tune deliberately writes the template's own default.
 *
 * `gate-speed-threshold` is the cell that proved the threshold word is READ, and the reading it needed is the
 * open end of the sweep — which is exactly what the template ships at, because a gate template has to ship
 * open. Writing the value out rather than relying on the default is what keeps the three speed cells legible
 * as a set: each states its whole triple, and the one that happens to coincide with the default should not
 * be the one that looks different.
 */
const INERT_TUNE_BY_DESIGN = new Set(['gate-speed-threshold:tuneLead']);

const inertTunes: string[] = [];
const unreachableWords = new Map<string, Set<string>>();

for (const { fixture, test } of allCases) {
  const record = (templateId: string, hookName: string, hook: unknown, args: unknown[], require: boolean) => {
    const result = tuned(templateId, hook as never, args);
    if (!result) { inertTunes.push(`${fixture}/${test.id}: ${hookName} has no template "${templateId}"`); return false; }
    for (const path of result.paths) {
      const probe = asNode(templateNodes(result.template)[0].mainType,
        templateNodes(result.template)[0].semanticType, templateNodes(result.template)[0].payload);
      const named = new Set(semanticInspectorForNode(probe).fields
        .map((spec: EffectSemanticNumberField) => spec.path.join('.')));
      if (named.has(path)) continue;
      const key = `${templateId} :: ${path}`;
      if (!unreachableWords.has(key)) unreachableWords.set(key, new Set());
      unreachableWords.get(key)!.add(`${fixture}/${test.id}`);
    }
    if (require && !result.paths.length && !INERT_TUNE_BY_DESIGN.has(`${test.id}:${hookName}`))
      inertTunes.push(`${fixture}/${test.id}: ${hookName} leaves ${templateId} at its default`);
    return result.paths.length > 0;
  };
  if (test.tuneLead && test.leadNode) record(test.leadNode, 'tuneLead', test.tuneLead, [], true);
  if (test.tuneExtra && test.extraNode) record(test.extraNode, 'tuneExtra', test.tuneExtra, [], true);
  if (test.tuneCompanion && test.companion) record(test.companion, 'tuneCompanion', test.tuneCompanion, [], true);
  if (test.tunePersistent && test.persistentNode)
    record(test.persistentNode, 'tunePersistent', test.tunePersistent, [], true);
  // A tail hook is handed every tail in turn and legitimately no-ops on the ones it does not name, so the
  // claim is only that it moved SOMETHING across the set.
  if (test.tuneTail && test.tailNodes?.length) {
    const hit = test.tailNodes.map((tail, index) =>
      record(tail, 'tuneTail', test.tuneTail, [tail, index], false)).some(Boolean);
    if (!hit) inertTunes.push(`${fixture}/${test.id}: tuneTail leaves every tail at its default`);
  }
}
checkNone(inertTunes, 'every tune hook rewrites the node it is handed');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# every word hardware tunes is reachable from the editor');

// This is the join the whole file exists for. A cell that moves a payload word and grades the outcome has
// DEMONSTRATED that the word matters; if the inspector has no control for it, the finding cannot be applied
// to an authored level except by hand-assembling Raw. Both halves of that are our own work, so a gap here is
// a gap we can simply close.
checkNone([...unreachableWords].sort().map(([word, cells]) =>
  `${word} — tuned by ${[...cells].sort().join(', ')} with no named authoring control`),
  'every payload word a hardware cell tunes has a named authoring control');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# every node reads as something in the inspector');

checkNone([...CANONICAL_SEMANTIC_TYPES].flatMap(type => {
  const detail = effectNodeDetail({ mainType: 0, semanticType: type, payload: {} });
  if (!detail.label.trim()) return [`${type} has no display label`];
  // The de-punctuated wire string is the fallback for a type nothing has named. A canonical one always has
  // either a template or a blocked entry, so seeing the fallback here means the registry missed it.
  return detail.label === type.replace(/[._-]+/g, ' ') ? [`${type} falls back to its wire string`] : [];
}), 'every canonical semantic type resolves to a human label');

checkNone([...CANONICAL_SEMANTIC_TYPES].filter(type =>
  !effectNodeDetail({ mainType: 0, semanticType: type, payload: {} }).summary)
  .map(type => `${type} has no summary`),
  'every canonical semantic type carries a summary a reader can use');

// ---------------------------------------------------------------------------------------------------------
console.log('\n# coverage');

const provenTemplates = EFFECT_TEMPLATES.filter(template => template.proven);
const validatedTypes = new Set(provenTemplates.flatMap(template =>
  templateNodes(template).map(node => node.semanticType).filter((type): type is string => !!type)));
// Every cell in every fixture is marked with a `timer-emitter` (`addCollisionMarkerNode`), so that template
// has ridden more chains than any other. Counting it here rather than leaving it in the gap list keeps the
// coverage line true — but CARRIED is not GRADED: the marker is always the last node in its chain, which is
// why the fixture had to add cells that put one at the head.
const cellTemplates = new Set<string>(['timer-emitter']);
for (const { test } of allCases) {
  for (const id of [test.leadNode, test.extraNode, test.persistentNode, test.companion,
    ...(test.tailNodes ?? []), ...(test.triggerNodes ?? []),
    ...(test.persistentTailNodes ?? []), ...(test.functionNodes ?? [])]) if (id) cellTemplates.add(id);
  if (test.recipe === 'ride-over-button') cellTemplates.add('ride-over-button');
  // The call node itself is never named by a cell: `functionNodes` is what an author writes, and the builder
  // appends the call that reaches them — the same shape the editor's picker produces.
  if (test.functionNodes?.length) cellTemplates.add('call-function');
}

/**
 * Templates that will never earn a cell, with the reason — so the coverage line reads as a decision rather
 * than as a gap nobody got to.
 *
 * `anim-combo-trigger` packs to the same bytes as `counter-decrement`, which three passes have already shown
 * arriving: command 3, value 0. The two differ only in which receiver the author means, and the engine
 * settles that at the receiver. A cell would re-measure a proven node under a second name.
 */
const NO_CELL_BY_DESIGN = new Set(['anim-combo-trigger']);

const unridden = EFFECT_TEMPLATES
  .filter(template => template.nodes?.length && !cellTemplates.has(template.id) && !template.proven
    && !NO_CELL_BY_DESIGN.has(template.id))
  .map(template => template.id);

console.log(`     ${CANONICAL_SEMANTIC_TYPES.size} semantic types: `
  + `${authorableTypes.size} authorable, ${blockedTypes.size} blocked with a reason`);
console.log(`     ${validatedTypes.size} of the ${authorableTypes.size} authorable types carry a PS2 validation record`);
console.log(`     ${cellTemplates.size} templates are exercised by at least one fixture cell`);
console.log(`     ${[...NO_CELL_BY_DESIGN].join(', ')} needs no cell of its own (see NO_CELL_BY_DESIGN)`);
// Not a failure — a template can be added long before the ride that earns it — but it is the list that
// answers "what is left to validate", which is the question this file was written to keep answerable.
if (unridden.length) console.log(`     NO CELL AND NO BADGE YET: ${unridden.sort().join(', ')}`);
else console.log('     every authorable template is either ridden by a cell or carries a badge');

// A ratchet, not a target. Evidence is expensive — each of these cost a twenty-minute ride — so the suite
// should notice a badge being deleted, and the number only ever moves up when a batch earns it.
const PROVEN_FLOOR = 30;
check(provenTemplates.length >= PROVEN_FLOOR,
  `at least ${PROVEN_FLOOR} templates carry a validation record (have ${provenTemplates.length})`);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
