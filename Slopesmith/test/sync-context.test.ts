// tier: fast
import assert from 'node:assert/strict';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { createStore } from '../src/app/state/store';
import { reconcileSyncContext } from '../src/app/state/sync-context';
import { createRebuilder } from '../src/app/state/rebuild';
import { createRegisterSync } from '../src/app/net/register-sync';

const before = migrateMountain(defaultMountain());
before.props = ['one', 'two'].map(id => ({ id, name: id, level: 'Custom', model: 0, pos: [0, 0, 0], yaw: 0, scale: 1 }));
before.rails = ['one', 'two'].map(id => ({ id, nodes: [[0, 0, 0], [1, 0, 0]], height: 1 }));
const store = createStore({ mdoc: before, currentMode: 'edit', storedUi: {} });
const selected = before.quadIds[1];
store.cellSel = [before.quadIds[0], selected];
store.hiddenQuads = [...store.cellSel];
store.controlCageQuads = [...store.cellSel];
store.selectedProp = 1;
store.multiSel = [0, 1];
store.selectedRail = 1;
store.selectedNode = 1;
store.surgeryTool = 'loopcut';
store.selected = 0;
const removed = applyMeshDelete(before, { quads: [0] });
assert(removed.ok);
store.mdoc = structuredClone(removed.doc);
store.mdoc.props = [store.mdoc.props![1]];
store.mdoc.rails = [store.mdoc.rails![1]];
reconcileSyncContext(store, before, store.mdoc);
assert.deepEqual(store.cellSel, [selected]);
assert.deepEqual(store.hiddenQuads, [selected]);
assert.deepEqual(store.controlCageQuads, [selected]);
assert.equal(store.selectedProp, 0);
assert.deepEqual(store.multiSel, [0]);
assert.equal(store.selectedRail, 0);
assert.equal(store.selectedNode, 1);
assert.equal(store.selected, 0);
assert.equal(store.surgeryTool, 'loopcut');
assert.equal(store.currentMode, 'edit');
const previous = structuredClone(store.mdoc);
store.mdoc.props = [];
store.mdoc.rails = [];
store.mdoc.course.knots.reverse();
reconcileSyncContext(store, previous, store.mdoc);
assert.equal(store.selectedProp, null);
assert.deepEqual(store.multiSel, []);
assert.equal(store.selectedRail, null);
assert.equal(store.selectedNode, null);
assert.equal(store.selected, null);

// Repeated snapshots schedule one render, without manufacturing a local save/history commit. A real edit
// made AFTER the replacement still wins the coalescing window and must be persisted normally.
const frames: FrameRequestCallback[] = [];
const originalRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = callback => frames.push(callback);
try {
  let commits = 0;
  const rendered: boolean[] = [];
  const rebuild = createRebuilder({
    scheduleCommit: () => { commits++; }, render: edited => rendered.push(edited), onError: error => { throw error; },
  });
  rebuild.scheduleRemoteRebuild(true);
  rebuild.scheduleRemoteRebuild(true);
  assert.equal(frames.length, 1);
  frames.shift()!(0);
  assert.deepEqual(rendered, [false]);
  assert.equal(commits, 0);
  rebuild.scheduleRebuild();
  rebuild.scheduleRemoteRebuild(true);
  frames.shift()!(0);
  assert.deepEqual(rendered, [false, false]);
  rebuild.scheduleRemoteRebuild(true);
  rebuild.scheduleRebuild();
  frames.shift()!(0);
  assert.deepEqual(rendered, [false, false, true]);
} finally {
  globalThis.requestAnimationFrame = originalRaf;
}

// A losing optimistic edit hears both the winner's broadcast and its claim rejection. Only the first
// changes the live map; the rejection still acknowledges the outstanding claim and settles sync status.
let doc = structuredClone(before), batch = 0, replacements = 0, rejections = 0;
const applied: string[] = [];
const sync = createRegisterSync({
  getDoc: () => doc, setDoc: next => { doc = next; replacements++; },
  channel: {
    assign: () => true, claim: (_ids, _doc, id) => { batch = id; return true; },
    checkDrift: () => true, fetchSections: () => true,
  },
  onApplied: kind => applied.push(kind),
  onTopologyRejected: () => { rejections++; },
});
sync.connect();
doc = structuredClone(removed.doc);
sync.noteEdit();
sync.flush();
assert(batch > 0);
const winner = structuredClone(before);
winner.name = 'Winner';
sync.applyTopology(structuredClone(winner));
const live = doc;
sync.claimed({ batch: batch + 1, ok: false, document: structuredClone(winner) });
assert.equal(rejections, 0, 'an unrelated acknowledgement cannot notify or settle our claim');
sync.claimed({ batch, ok: false, document: structuredClone(winner) });
assert.equal(doc, live, 'duplicate rejection preserves document object identity');
assert.equal(replacements, 1);
assert.deepEqual(applied, ['document']);
assert.equal(rejections, 1, 'a rejected edit is explained even when its winning snapshot already arrived');
sync.claimed({ batch, ok: false, document: structuredClone(winner) });
assert.equal(rejections, 1, 'duplicate rejection acknowledgements stay quiet');
sync.applyTopology(structuredClone(winner));
assert.equal(replacements, 1, 'duplicate topology broadcast is also quiet');
sync.repair({ registers: [], document: structuredClone(winner) });
assert.equal(doc, live, 'an identical drift repair preserves the live object');
assert.deepEqual(applied, ['document'], 'an identical drift repair does not redraw');
// The comparison must read the live document, not the already-matching sync shadow.
doc.name = 'Unsent local value';
sync.noteEdit();
sync.repair({ registers: [], document: structuredClone(winner) });
assert.equal(doc.name, 'Winner');
assert.equal(replacements, 2, 'a repair that changes live content is still applied');
assert.deepEqual(applied, ['document', 'document']);
const accepted = applyMeshDelete(doc, { quads: [0] });
assert(accepted.ok);
doc = accepted.doc;
sync.noteEdit();
sync.flush();
sync.claimed({ batch, ok: true });
assert.equal(rejections, 1, 'accepted local edits do not notify');
sync.stop();
console.log('Sync context, frame coalescing, conflict notices, and duplicate recovery passed.');
