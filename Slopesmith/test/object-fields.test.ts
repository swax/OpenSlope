// tier: fast

import { createRegisterSync, type RegisterSync } from '../src/app/net/register-sync';
import type { RegisterAssignment } from '../src/app/net/session-channel';
import { canonicalJson } from '../src/core/doc/canonical';
import { documentDiff, revertAssignments } from '../src/core/doc/compare';
import { digestDocument, textHash, updateDigest } from '../src/core/doc/digest';
import type { EditDoc } from '../src/core/doc/doc-edit';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import {
  linkedFieldRegisters, objectFieldChanges, objectFieldOf, objectFieldRegister, objectRegister, readRegister,
  registerSection, writeRegister,
} from '../src/core/doc/registers';
import type { PlacedProp } from '../src/core/doc/types';
import { check, failures } from './check';

/**
 * An object edited a field at a time (docs/039, *Objects*): the key form, what a field write may and may not do
 * to a document, what a replica sends for an edit, and the rule that keeps a replica's own unacknowledged writes
 * from being overwritten by values the room sequenced before them.
 */

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const prop = (id: string, extra: Partial<PlacedProp> = {}): PlacedProp =>
  ({ id, level: 'Custom', model: 0, name: `Mdl_${id}`, pos: [0, 0, 0], yaw: 0, scale: 1, ...extra });

function lab(): EditDoc {
  const doc = migrateMountain(defaultMountain());
  doc.props = [prop('prop:a'), prop('prop:b')];
  doc.models = [{ id: 'model:0001', name: 'crate', anchor: [0, 0, 0], vertices: [], quads: [] }];
  return doc;
}

// ---- the key ----
const posKey = objectFieldRegister('prop', 'pos', 'prop:a');
check(posKey === 'o/prop.pos/prop:a', 'a field key names the family and field before the id', posKey);
check(sameJson(objectFieldOf(posKey), { family: 'prop', field: 'pos', id: 'prop:a', object: 'o/prop/prop:a' }),
  'and parses back into the object it belongs to');
check(objectFieldOf('o/prop.pos/prop:with/slash')?.id === 'prop:with/slash',
  'an id carrying slashes still parses one way, because the field sits before it');
check([
  'o/prop/prop:a', 'o/model.name/model:0001', 'o/effect-node.payload/graphs/graph:0000/node:0001',
  'o/prop.id/prop:a', 'o/prop.__proto__/prop:a', 'o/prop.not-a-name/prop:a', 'o/prop.pos/',
].every(key => objectFieldOf(key) === null),
'whole keys, families that stay whole, an object’s own id and non-identifier names are not field keys');

// ---- writing one field ----
{
  const doc = lab();
  const held = doc.props![0];
  check(writeRegister(doc, posKey, [1, 2, 3]) === 'landed' && doc.props![0] === held
    && sameJson(held.pos, [1, 2, 3]) && held.name === 'Mdl_prop:a',
  'a field lands on the object in place, leaving the object the editor holds and its other fields alone');
  check(sameJson(readRegister(doc, posKey), [1, 2, 3]), 'and reads back as the field');
  check(writeRegister(doc, objectFieldRegister('prop', 'pitch', 'prop:a'), undefined) === 'landed'
    && !('pitch' in held), 'assigning nothing clears the field');
  const props = doc.props!.length;
  check(writeRegister(doc, objectFieldRegister('prop', 'pos', 'prop:gone'), [9, 9, 9]) === 'retired'
    && doc.props!.length === props, 'a field for an object the document does not hold retires, and creates nothing');
  check(writeRegister(doc, 'o/model.name/model:0001', 'barrel') === 'refused' && doc.models![0].name === 'crate',
    'a family that stays whole refuses field keys');
  check(registerSection(doc, posKey) === registerSection(doc, objectRegister('prop', 'prop:a')),
    'a field is hashed in the section of the object it belongs to');
  const before = digestDocument(doc, textHash);
  writeRegister(doc, posKey, [4, 5, 6]);
  check(sameJson(updateDigest(doc, before, [posKey], textHash), digestDocument(doc, textHash)),
    'maintaining a digest across a field write matches rehashing from scratch');
}

// ---- the id index never answers with a stale slot ----
{
  const doc = lab();
  const props = doc.props!;
  const key = (id: string) => objectRegister('prop', id);
  const nameOf = (id: string) => (readRegister(doc, key(id)) as PlacedProp | undefined)?.name;
  check(nameOf('prop:b') === 'Mdl_prop:b', 'an object is found by its id');
  props.splice(0, 1);
  check(nameOf('prop:b') === 'Mdl_prop:b' && nameOf('prop:a') === undefined,
    'after a removal shifts it down the list, and the removed one is gone');
  props[0] = prop('prop:c');
  check(nameOf('prop:c') === 'Mdl_prop:c' && nameOf('prop:b') === undefined,
    'after its slot is given to another object in place');
  props.unshift(prop('prop:b', { name: 'again' }));
  writeRegister(doc, objectFieldRegister('prop', 'yaw', 'prop:c'), 33);
  check(nameOf('prop:b') === 'again' && props[1].yaw === 33 && props[0].yaw === 0,
    'and after one is inserted ahead of it: reads and field writes land on the object the id names');
}

// ---- what an edit sends ----
{
  const same = (a: unknown, b: unknown) => sameJson(a, b);
  const was = prop('prop:a');
  const moved = objectFieldChanges(objectRegister('prop', 'prop:a'), was, { ...was, pos: [1, 1, 1] }, same);
  check(sameJson(moved, [[posKey, [1, 1, 1], [0, 0, 0]]]), 'a moved prop is one field: its new and its prior value');
  const swapped = objectFieldChanges(objectRegister('prop', 'prop:a'), was, { ...was, model: 4 }, same)!;
  check(sameJson(swapped.map(([key]) => objectFieldOf(key)!.field).sort(),
    ['group', 'level', 'model', 'name', 'specialKind'])
    && swapped.find(([key]) => key.endsWith('.group/prop:a'))?.[1] === undefined,
  'a changed model brings its whole linked group, a field nobody set travelling as nothing');
  check(sameJson(linkedFieldRegisters(objectFieldRegister('light', 'cone', 'light:1')).sort(), [
    'o/light.cone/light:1', 'o/light.dir/light:1', 'o/light.kind/light:1',
  ]), 'a light’s kind, direction and cone are one group');
  check(objectFieldChanges(objectRegister('model', 'model:0001'), { name: 'a' }, { name: 'b' }, same) === null
    && objectFieldChanges(objectRegister('prop', 'prop:a'), was, { ...was, 'odd-name': 1 }, same) === null,
  'a family that stays whole, or a change no key can name, travels as the whole object');
}

// ---- a scoped revert at field grain ----
{
  const was = lab();
  const now = structuredClone(was);
  Object.assign(now.props![0], { pos: [5, 5, 5], name: 'Mdl_New', model: 3 });
  const diff = documentDiff(was, now);
  const objectKey = objectRegister('prop', 'prop:a');
  const fieldsOnly = revertAssignments(diff, { keys: [posKey] });
  check(sameJson(fieldsOnly, [[posKey, [0, 0, 0]]]), 'a revert credited one field puts back that field alone');
  const groupOnly = revertAssignments(diff, { keys: [objectFieldRegister('prop', 'model', 'prop:a')] });
  check(groupOnly.length === 5 && groupOnly.every(([key]) => objectFieldOf(key)?.field !== 'pos'),
    'a field of a linked group reverts with its whole group, and with nothing else');
  check(sameJson(revertAssignments(diff, { keys: [objectKey] }), [[objectKey, was.props![0]]]),
    'a whole-object credit with nothing kept reverts the object whole, as before');
  const kept = revertAssignments(diff, { keys: [objectKey], kept: [posKey] });
  check(kept.length === 5 && !kept.some(([key]) => key === posKey),
    'and with a later field written by somebody else, reverts every field but that one');
}

// ---- a replica's side, over a transport that records rather than sends ----
interface Harness { sync: RegisterSync; doc: () => EditDoc; sent: RegisterAssignment[][]; batches: number[] }

function harness(): Harness {
  let doc = lab();
  const sent: RegisterAssignment[][] = [];
  const batches: number[] = [];
  const sync = createRegisterSync({
    getDoc: () => doc, setDoc: next => { doc = next; },
    channel: {
      assign: (changes, batch) => { sent.push(structuredClone(changes)); batches.push(batch); return true; },
      claim: () => true, checkDrift: () => true, fetchSections: () => true,
    },
  });
  sync.connect();
  return { sync, doc: () => doc, sent, batches };
}

{
  const { sync, doc, sent } = harness();
  doc().props![0].yaw = 90;
  sync.noteEdit(); sync.flush();
  check(sameJson(sent.at(-1), [[objectFieldRegister('prop', 'yaw', 'prop:a'), 90]]),
    'turning an existing prop sends its yaw, not the prop');
  doc().props!.push(prop('prop:new'));
  sync.noteEdit(); sync.flush();
  check(sameJson(sent.at(-1), [[objectRegister('prop', 'prop:new'), prop('prop:new')]]),
    'a new prop travels whole: that is a creation');
  doc().props = doc().props!.filter(held => held.id !== 'prop:b');
  sync.noteEdit(); sync.flush();
  check(sameJson(sent.at(-1), [[objectRegister('prop', 'prop:b'), undefined]]), 'and a deleted one is cleared whole');
  const step = sync.sealStep();
  check(!!step && step.priors.some(([key, value]) => key === objectFieldRegister('prop', 'yaw', 'prop:a') && value === 0),
    'undo remembers the field it changed and what that field held');
  check(sync.pending().length === 0, 'and with everything collected, nothing is left to send');
}

{
  // The room relays somebody else's batch before acknowledging this tab's: it was sequenced first, so this
  // tab's in-flight value is what the room ends up holding, and the arriving one must not replace it.
  const { sync, doc, batches } = harness();
  const yawKey = objectFieldRegister('prop', 'yaw', 'prop:a');
  doc().props![0].yaw = 45;
  sync.noteEdit(); sync.flush();
  sync.applySync([[yawKey, 10]], 'jed');
  check(doc().props![0].yaw === 45 && sync.pending().length === 0,
    'a value arriving for a field this tab has in flight is the older one: it is not written');
  sync.applySync([[objectRegister('prop', 'prop:a'), prop('prop:a', { name: 'Mdl_Jed', yaw: 10 })]], 'jed');
  check(doc().props![0].name === 'Mdl_Jed' && doc().props![0].yaw === 45 && sync.pending().length === 0,
    'an object arriving whole is written, with this tab’s in-flight field put back on top, as the room will hold it');
  sync.landed({ batch: batches.at(-1)! });
  sync.applySync([[yawKey, 12]], 'jed');
  check(doc().props![0].yaw === 12, 'once this tab’s write is acknowledged, a later value lands as usual');

  doc().props![1].scale = 3;
  sync.noteEdit();
  sync.applySync([[objectFieldRegister('prop', 'scale', 'prop:b'), 7]], 'jed');
  check(doc().props![1].scale === 3, 'an edit not yet sent is sent first, so an older arriving value cannot erase it');

  sync.landed({ batch: batches.at(-1)! });
  doc().props = doc().props!.filter(held => held.id !== 'prop:b');
  sync.noteEdit();
  sync.applySync([[objectFieldRegister('prop', 'pos', 'prop:b'), [8, 8, 8]]], 'jed');
  check(!doc().props!.some(held => held.id === 'prop:b'),
    'a field arriving for a prop this tab just deleted does not bring it back');
}

if (failures) process.exitCode = 1;
