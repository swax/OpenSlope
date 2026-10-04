// tier: fast
import assert from 'node:assert/strict';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import type { PlacedProp } from '../src/core/doc/types';
import { createStore } from '../src/app/state/store';
import { behaviourOf, instanceBehaviour } from '../src/core/props/defaults';
import { addEmptyEffectToProp, createEmptyEffectsDocument, effectAttachments } from '../src/core/effects/authoring';
import type { LevelProps, PropInstance } from '../src/core/reference/props';
import type { GroupDef } from '../src/core/reference/groups';

Object.defineProperty(globalThis, 'document', {
  configurable: true, value: { getElementById: () => ({ textContent: '', className: '' }) },
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 0, setInterval: () => 0 } });
const { createPropOps } = await import('../src/app/props/operations');
const store = createStore({ mdoc: migrateMountain(defaultMountain()), currentMode: 'props', storedUi: {} });
const instance: PropInstance = {
  sourceIndex: 42, model: 2, name: 'World lamp', loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
  ltgState: 2, visible: true, playerCollision: true, playerBounce: false, contact: 'through',
  responseMass: 0, collisionSound: 7, bounce: 0, surface: 12, shape: 1, dynamicMass: -1, physicsBody: -1,
  externalSounds: [],
};
const levels = new Map<string, LevelProps>([['TEST', {
  level: 'TEST', models: [{ id: 1, name: 'Original', subs: [] }, { id: 2, name: 'Lamp', subs: [] }],
  instances: [instance], materials: new Map(), crowdFrames: [],
}]]);
const group: GroupDef = { id: 'lamp', name: 'Lamp assembly', level: 'TEST', occurrences: 1, lights: [],
  props: [{ model: 2, name: 'Lamp', relPos: [0, 0, 0], relYaw: 0 }] };
let rebuilds = 0;
const ops = createPropOps({
  store, propLevels: levels, groupDefIdx: new Map(),
  viewport: { registerPropModels() {}, registerGroupDefs() {}, setPropArmed() {}, setLineDrawing() {},
    setLightArmed() {}, setRailArmed() {}, setGemArmed() {}, clearRefPropSelection() {}, clearScreenSelection() {} },
  propLib: { highlight() {} },
  setMode: (mode: typeof store.currentMode) => { store.currentMode = mode; },
  scheduleRebuild: () => { rebuilds++; }, rebuildTools() {}, updateCmdSheet() {},
} as unknown as Parameters<typeof createPropOps>[0]);
function reset() {
  store.mdoc = migrateMountain(defaultMountain());
  const target: PlacedProp = { id: 'prop:0000', level: 'TEST', model: 1, name: 'Original',
    pos: [12, 8, -3], yaw: 123, pitch: 20, roll: -15, scale: 2.4, labels: ['label:0000'],
    group: 'old-group', fullBright: true, ambientSoundFile: 'old.wav', specialKind: 'speed-boost' };
  const source: PlacedProp = { id: 'prop:0001', level: 'TEST', model: 2, name: 'Source lamp',
    pos: [50, 0, 20], yaw: 0, scale: 1, collisionSoundFile: 'new.wav', fullBright: true };
  store.mdoc.props = [target, source];
  store.selectedProp = 0; store.armedProp = null; store.multiSel = []; store.currentMode = 'props';
  rebuilds = 0;
  return { target, source };
}
const pose = (p: PlacedProp) => [p.id, p.labels, p.pos, p.yaw, p.pitch, p.roll, p.scale];

// A library pick updates exactly one placement, preserving its pose and stable joins.
{
  const { target, source } = reset();
  const originalPose = structuredClone(pose(target)), originalSource = structuredClone(source);
  store.mdoc.effects = createEmptyEffectsDocument('TEST');
  addEmptyEffectToProp(store.mdoc.effects, target.id!, 'collision');
  ops.replaceSelectedProp();
  assert.equal(ops.isReplacingProp(), true);
  await ops.armProp('TEST', 2, 'Lamp');
  assert.equal(target.model, 2);
  assert.equal(target.name, 'Lamp');
  assert.deepEqual(pose(target), originalPose);
  assert.equal(target.group, undefined);
  assert.equal(target.specialKind, undefined);
  assert.equal(target.ambientSoundFile, undefined);
  assert.deepEqual(behaviourOf(target), ops.propDefaults('TEST', 2).behaviour);
  assert.deepEqual(source, originalSource);
  assert.equal(effectAttachments(store.mdoc.effects).length, 0, 'the old model effect is detached');
  assert.equal(store.mdoc.props!.length, 2);
  assert.equal(store.selectedProp, 0);
  assert.equal(store.armedProp, null);
  assert.equal(ops.isReplacingProp(), false);
  assert.equal(rebuilds, 1, 'the replacement is one ordinary document edit');
}

// A world placement supplies its own settings and effect, not the model's library defaults.
{
  const { target, source } = reset();
  store.mdoc.effects = createEmptyEffectsDocument('TEST');
  addEmptyEffectToProp(store.mdoc.effects, target.id!, 'persistent');
  addEmptyEffectToProp(store.mdoc.effects, source.id!, 'collision');
  const sourceSlot = effectAttachments(store.mdoc.effects).find(a => a.target.id === source.id)!.slot;
  ops.replaceSelectedProp();
  await ops.armProp(source.level, source.model, source.name, { behaviour: behaviourOf(source), placementId: source.id });
  assert.equal(target.collisionSoundFile, 'new.wav');
  assert.equal(effectAttachments(store.mdoc.effects).filter(a => a.slot === sourceSlot).length, 2);
  assert.equal(effectAttachments(store.mdoc.effects).length, 2, 'only target and source share the chosen effect');
  target.nativeCollision!.responseMass = 12;
  assert.equal(source.nativeCollision, undefined, 'replacement settings are independent of the source');
  const before = structuredClone(store.mdoc);
  ops.replaceSelectedProp();
  await ops.armProp(target.level, target.model, target.name, { behaviour: behaviourOf(target), placementId: target.id });
  assert.deepEqual(store.mdoc, before, 'clicking the target itself is a no-op, including its effects');
}

// A reference world instance and a library group use the same replacement path.
{
  const { target } = reset();
  ops.replaceSelectedProp();
  await ops.armProp('TEST', 2, instance.name, { sourceIndex: instance.sourceIndex });
  assert.deepEqual(behaviourOf(target), instanceBehaviour('TEST', instance));
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ level: 'TEST', groups: [group] });
  try {
    ops.replaceSelectedProp();
    await ops.armGroupById('TEST', 'lamp');
    assert.equal(target.group, 'lamp');
    assert.equal(target.model, 2);
    assert.equal(target.name, 'Lamp assembly');
    assert.equal(store.armedProp, null);
  } finally { globalThis.fetch = fetchBefore; }
}

// Cancellation, undo/document replacement and a deleted target invalidate even a pick already loading.
for (const cancel of [() => ops.cancelPropReplacement(),
  () => { store.mdoc = structuredClone(store.mdoc); },
  () => { store.mdoc.props!.splice(0, 1); },
  () => { store.currentMode = 'edit'; }]) {
  reset();
  const before = structuredClone(store.mdoc);
  ops.replaceSelectedProp();
  const pending = ops.armProp('TEST', 2, 'Lamp'); // cached geometry still resolves asynchronously
  cancel();
  const cancelled = structuredClone(store.mdoc);
  await pending;
  assert.deepEqual(store.mdoc, cancelled);
  assert.equal(store.mdoc.props!.at(-1)!.model, before.props!.at(-1)!.model);
  assert.equal(store.armedProp, null, 'a stale replacement must not become placement mode');
  assert.equal(ops.isReplacingProp(), false);
  assert.equal(rebuilds, 0);
}

// A multi-selection takes one library pick, preserves every pose and identity, and schedules one undo edit.
{
  const { target, source } = reset();
  const outside = { ...structuredClone(source), id: 'prop:0002' };
  store.mdoc.props!.push(outside);
  store.selectedProp = null; store.multiSel = [0, 1];
  const before = structuredClone(store.mdoc.props);
  ops.replaceSelectedProp();
  assert.equal(ops.isReplacingProp(), true);
  await ops.armGroupById('TEST', 'lamp');
  assert.deepEqual([target, source].map(pose), before!.slice(0, 2).map(pose));
  assert([target, source].every(p => p.group === 'lamp' && p.model === 2));
  assert.deepEqual(outside, before![2], 'unselected placements stay unchanged');
  assert.deepEqual(store.multiSel, [0, 1], 'the batch stays selected');
  assert.equal(store.selectedProp, null);
  assert.equal(store.armedProp, null);
  assert.equal(rebuilds, 1, 'the whole set is one document edit');
  target.nativeCollision!.responseMass = 3;
  assert.notEqual(source.nativeCollision!.responseMass, 3, 'each target receives independent settings');
}

// A member of the set can be the source: its effects stay intact while the other members take them.
{
  const { target, source } = reset();
  store.selectedProp = null; store.multiSel = [1, 0, 1]; // duplicate selection entries must not stamp twice
  store.mdoc.effects = createEmptyEffectsDocument('TEST');
  addEmptyEffectToProp(store.mdoc.effects, target.id!, 'persistent');
  addEmptyEffectToProp(store.mdoc.effects, source.id!, 'collision');
  const sourceSlot = effectAttachments(store.mdoc.effects).find(a => a.target.id === source.id)!.slot;
  const originalSource = structuredClone(source);
  ops.replaceSelectedProp();
  await ops.armProp(source.level, source.model, source.name, { behaviour: behaviourOf(source), placementId: source.id });
  assert.equal(target.model, source.model);
  assert.equal(target.collisionSoundFile, source.collisionSoundFile);
  assert.deepEqual(source, originalSource);
  assert(effectAttachments(store.mdoc.effects).every(a => a.slot === sourceSlot));
  assert.equal(effectAttachments(store.mdoc.effects).length, 2);
  assert.equal(rebuilds, 1);
}

// Edit's multi-selection opens the same picker; model-less triggers and generated line members stay intact.
{
  const { target, source } = reset();
  const trigger = { ...structuredClone(source), id: 'prop:0002', level: '@effects', effectTrigger: { size: [1, 1, 1] as [number, number, number] } };
  const lineMember = { ...structuredClone(source), id: 'prop:0003', line: 'line:0000' };
  store.mdoc.props!.push(trigger, lineMember);
  const excluded = structuredClone([trigger, lineMember]);
  store.currentMode = 'edit'; store.selectedProp = null; store.multiSel = [0, 1, 2, 3];
  ops.replaceSelectedProp();
  assert.equal(store.currentMode, 'props');
  assert.equal(ops.isReplacingProp(), true);
  await ops.armProp('TEST', 2, instance.name, { sourceIndex: instance.sourceIndex });
  assert.deepEqual([target, source].map(behaviourOf), [instanceBehaviour('TEST', instance), instanceBehaviour('TEST', instance)]);
  assert.deepEqual([trigger, lineMember], excluded);
  assert.deepEqual(store.multiSel, [0, 1, 2, 3]);
}

// A changed selection or deleted member cancels the entire pending batch, without partially replacing it.
for (const cancel of [() => ops.cancelPropReplacement(),
  () => { store.multiSel = [0]; },
  () => { store.selectedProp = 0; store.multiSel = []; },
  () => { store.mdoc.props!.splice(1, 1); },
  () => { store.mdoc = structuredClone(store.mdoc); }]) {
  reset();
  store.selectedProp = null; store.multiSel = [0, 1];
  ops.replaceSelectedProp();
  const pending = ops.armProp('TEST', 2, 'Lamp');
  cancel();
  const before = structuredClone(store.mdoc);
  await pending;
  assert.deepEqual(store.mdoc, before);
  assert.equal(store.armedProp, null);
  assert.equal(ops.isReplacingProp(), false);
  assert.equal(rebuilds, 0);
}

// A completed replacement is one-shot; later library picks resume ordinary placement.
reset();
ops.replaceSelectedProp();
await ops.armProp('TEST', 2, 'Lamp');
await ops.armProp('TEST', 1, 'Original');
const heldModel = () => store.armedProp?.model;
assert.equal(heldModel(), 1);
assert.equal(store.selectedProp, null);
console.log('Prop replacement: single and multi-selection, library, world, reference, group, pose, effects and cancellation passed.');
