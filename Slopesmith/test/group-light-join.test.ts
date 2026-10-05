// tier: fast

/**
 * Adding a free light to a selected authored group from its panel (docs/015 · Authored groups), and a group's
 * lights going when the group does.
 *
 *  - a selected group's ⊞ add a light… waits for a light, which joins it;
 *  - the wait lapses when the selection changes, and Esc's cancel gives it up;
 *  - deleting a whole group, or its last prop, deletes its lights; a set's selected lights go with it.
 *
 * Run: tsx test/group-light-join.test.ts
 */
import assert from 'node:assert/strict';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import type { AuthoredLight, PlacedProp } from '../src/core/doc/types';
import { createStore, selectedSetLights, setSelectedSet } from '../src/app/state/store';

Object.defineProperty(globalThis, 'document', {
  configurable: true, value: { getElementById: () => ({ textContent: '', className: '' }) },
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 0, setInterval: () => 0 } });
const { createPropOps } = await import('../src/app/props/operations');
const store = createStore({ mdoc: migrateMountain(defaultMountain()), currentMode: 'props', storedUi: {} });
const ops = createPropOps({
  store, propLevels: new Map(), groupDefIdx: new Map(),
  viewport: { registerPropModels() {}, registerGroupDefs() {}, setPropArmed() {}, setLineDrawing() {},
    setLightArmed() {}, setRailArmed() {}, setGemArmed() {}, clearRefPropSelection() {}, clearScreenSelection() {} },
  propLib: { highlight() {} },
  setMode: (mode: typeof store.currentMode) => { store.currentMode = mode; },
  scheduleRebuild() {}, rebuildTools() {}, updateCmdSheet() {},
} as unknown as Parameters<typeof createPropOps>[0]);

const prop = (id: string, extra: Partial<PlacedProp> = {}): PlacedProp =>
  ({ id, level: 'TEST', model: 1, name: 'Lamp', pos: [0, 0, 0], yaw: 0, scale: 1, ...extra });
const light = (id: string, extra: Partial<AuthoredLight> = {}): AuthoredLight =>
  ({ id, kind: 'spot', pos: [0, 5, 0], color: '#ffffff', intensity: 1, reach: 10, ...extra });
function reset() {
  store.mdoc = migrateMountain(defaultMountain());
  store.mdoc.props = [
    prop('prop:0000'),
    prop('prop:0001', { assembly: 'group:0000' }), prop('prop:0002', { assembly: 'group:0000' }),
    prop('prop:0003', { line: 'line:0000' }),
  ];
  store.mdoc.lights = [light('light:0000'), light('light:0001', { assembly: 'group:0000' })];
  store.selectedProp = null; store.multiSel = []; store.selectedLight = null; store.armedProp = null;
  store.currentMode = 'props';
}

// A group waiting for a light takes the one clicked.
{
  reset();
  store.selectedLight = 'light:0000';
  ops.startLightJoin();
  assert.equal(ops.lightJoinWaitsFor(), null, 'a light on its own has nothing to wait for');
  store.selectedLight = null;
  store.multiSel = [1, 2];
  ops.startLightJoin();
  assert.equal(ops.lightJoinWaitsFor(), 'light', 'a selected group waits for a light');
  assert.equal(ops.finishLightJoin('light:0000'), true);
  assert.equal(store.mdoc.lights![0].assembly, 'group:0000', 'the light joins the group');
  assert.deepEqual(store.multiSel, [1, 2], 'which stays selected');
  assert.equal(ops.lightJoinWaitsFor(), null, 'and the wait is over');
}

// The wait lapses with its selection, and cancels.
{
  reset();
  store.multiSel = [1, 2];
  ops.startLightJoin();
  store.multiSel = [0];
  assert.equal(ops.lightJoinWaitsFor(), null, 'selecting something else lets the wait go');
  assert.equal(ops.finishLightJoin('light:0000'), false, 'so a light click is an ordinary one again');
  store.multiSel = [1, 2];
  ops.startLightJoin();
  ops.cancelLightJoin();
  assert.equal(ops.lightJoinWaitsFor(), null, 'Esc’s cancel gives it up');
}

// A group's lights go when the group does.
{
  reset();
  store.multiSel = [1, 2];
  ops.deleteMultiSelProps();
  assert.deepEqual(store.mdoc.lights!.map(l => l.id), ['light:0000'], 'deleting a whole group deletes its lights');
  reset();
  store.mdoc.props = [prop('prop:0000', { assembly: 'group:0000' })];
  store.selectedProp = 0;
  ops.deleteSelectedProp();
  assert.deepEqual(store.mdoc.lights!.map(l => l.id), ['light:0000'], 'and so does deleting its last prop');
}

// A set's selected free lights go with it, and a ✕ in its list drops one from it.
{
  reset();
  setSelectedSet(store, [0], ['light:0000']);
  ops.removeLightFromMultiSel('light:0000');
  assert.deepEqual(selectedSetLights(store), [], 'the list’s ✕ drops a light from the set');
  assert.equal(store.mdoc.lights!.length, 2, 'without deleting it');
  setSelectedSet(store, [0], ['light:0000']);
  ops.deleteMultiSelProps();
  assert.deepEqual(store.mdoc.lights!.map(l => l.id), ['light:0001'], 'deleting the set deletes the light selected in it');
}

console.log('group-light-join: ok');
