// tier: fast
import assert from 'node:assert/strict';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { createStore } from '../src/app/state/store';
import { reconcileSyncContext } from '../src/app/state/sync-context';
import { createRebuilder } from '../src/app/state/rebuild';
import { createRegisterSync, type RegisterStep, type RegisterSync } from '../src/app/net/register-sync';
import type { RegisterAssignment } from '../src/app/net/session-channel';
import { createHistory } from '../src/app/state/history';
import { readRegister, vertexRegister, writeRegister } from '../src/core/doc/registers';
import { topologyDelta, type TopologyDelta } from '../src/core/doc/topology-delta';

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

// A losing optimistic edit hears the winner's broadcast and then its claim rejection (docs/039). The broadcast
// was sequenced ahead of the claim, so it is ignored; the rejection carries it among the steps since the claim's
// base, and that is the one replacement and the one notice.
function harness(start: typeof before) {
  const state = {
    doc: structuredClone(start), batch: 0, replacements: 0, rejections: 0,
    applied: [] as string[], fetches: [] as string[][], claims: [] as { delta: TopologyDelta; changes: RegisterAssignment[] }[],
    assigns: [] as { batch: number; changes: RegisterAssignment[] }[],
  };
  const sync = createRegisterSync({
    getDoc: () => state.doc, setDoc: next => { state.doc = next; state.replacements++; },
    channel: {
      assign: (changes, id) => { state.assigns.push({ batch: id, changes: structuredClone(changes) }); return true; },
      claim: (_ids, delta, changes, id) => { state.batch = id; state.claims.push({ delta, changes }); return true; },
      checkDrift: () => true, fetchSections: sections => { state.fetches.push([...sections]); return true; },
    },
    onApplied: kind => state.applied.push(kind),
    onTopologyRejected: () => { state.rejections++; },
  });
  sync.connect();
  return { state, sync };
}

const winnerDoc = applyMeshDelete(structuredClone(before), { quads: [1] });
assert(winnerDoc.ok);
const winnerStep = { delta: topologyDelta(before, winnerDoc.doc), changes: [['g/name', 'Winner']] as RegisterAssignment[] };
{
  const { state, sync } = harness(before);
  state.doc = structuredClone(removed.doc);
  sync.noteEdit();
  sync.flush();
  assert(state.batch > 0 && state.claims.length === 1, 'the local delete claims');
  assert(state.claims[0].delta.quads.length <= 3, 'with a delta of a few runs, not the mountain');
  sync.applyTopology(winnerStep);
  assert.equal(state.replacements, 0, 'a broadcast sequenced ahead of an outstanding claim is left for its answer');
  const live = state.doc;
  sync.claimed({ batch: state.batch + 1, ok: false, steps: [winnerStep] });
  assert.equal(state.rejections, 0, 'an unrelated acknowledgement cannot notify or settle our claim');
  assert.equal(state.doc, live);
  sync.claimed({ batch: state.batch, ok: false, steps: [winnerStep] });
  assert.equal(state.replacements, 1);
  assert.deepEqual(state.applied, ['topology'], 'the loser rebuilds its base and replays the steps onto it');
  assert.equal(state.rejections, 1, 'a rejected edit is explained once');
  assert.deepEqual(state.doc.quadIds, winnerDoc.doc.quadIds, 'and holds the winner’s structure');
  assert.equal(state.doc.name, 'Winner', 'and the registers that came with it');
  assert.deepEqual(sync.pending(), [], 'with nothing left to say to the room');
  sync.claimed({ batch: state.batch, ok: false, steps: [winnerStep] });
  assert.equal(state.rejections, 1, 'duplicate rejection acknowledgements stay quiet');
  const settled = state.doc;
  sync.applyTopology(winnerStep);
  assert.equal(state.doc, settled, 'a repeated broadcast does not land a second time');
  assert.deepEqual(state.fetches.at(-1), ['topology'], 'it fails to verify, so the replica asks for the topology');
  sync.repair({ registers: [], document: structuredClone(state.doc) });
  assert.equal(state.doc, settled, 'an identical drift repair preserves the live object');
  assert.deepEqual(state.applied, ['topology'], 'an identical drift repair does not redraw');
  // The comparison must read the live document, not the already-matching sync shadow.
  state.doc.name = 'Unsent local value';
  sync.noteEdit();
  const room = structuredClone(state.doc);
  room.name = 'Winner';
  sync.repair({ registers: [], document: room });
  assert.equal(state.doc.name, 'Winner');
  assert.equal(state.replacements, 2, 'a repair that changes live content is still applied');
  assert.deepEqual(state.applied, ['topology', 'document']);
  const accepted = applyMeshDelete(state.doc, { quads: [0] });
  assert(accepted.ok);
  state.doc = accepted.doc;
  sync.noteEdit();
  sync.flush();
  sync.claimed({ batch: state.batch, ok: true });
  assert.equal(state.rejections, 1, 'accepted local edits do not notify');
  sync.stop();
}

// A local topology edit that has not been claimed yet when somebody else's arrives was sequenced after it: the
// replica rewinds to what the room held, applies the arrival there, and says its edit was not applied.
{
  const { state, sync } = harness(before);
  state.doc = structuredClone(removed.doc);
  sync.noteEdit(); // not flushed: the edit sits inside the coalescing tick
  sync.applyTopology(winnerStep);
  assert.deepEqual(state.doc.quadIds, winnerDoc.doc.quadIds, 'the arrival wins over the unclaimed edit');
  assert.equal(state.rejections, 1, 'and the lost edit is explained');
  sync.flush();
  assert.equal(state.claims.length, 0, 'nothing is claimed for an edit that already lost');
  assert.deepEqual(sync.pending(), []);
  sync.stop();
}

// A claim still out when the socket drops lost its answer with it: the whole document settles it.
{
  const { state, sync } = harness(before);
  state.doc = structuredClone(removed.doc);
  sync.noteEdit();
  sync.flush();
  sync.disconnect();
  sync.caughtUp({ steps: [] });
  assert.deepEqual(state.fetches.at(-1), ['topology'], 'an unanswered claim is settled with the topology');
  assert.equal(sync.status().landed, false, 'and nothing counts as landed until it arrives');
  sync.repair({ registers: [], document: structuredClone(winnerDoc.doc) });
  assert.deepEqual(state.doc.quadIds, winnerDoc.doc.quadIds);
  assert.equal(sync.status().landed, true, 'after which the replica is settled again');
  sync.stop();
}

// A loser's register edits made while its claim was out are put back onto the rebuilt document and sent at once,
// before any drift check could compare against them and repair them away.
{
  const { state, sync } = harness(before);
  state.doc = structuredClone(removed.doc);
  sync.noteEdit();
  sync.flush();
  const corner = state.doc.vertexIds.find(id => winnerDoc.doc.vertexIds.includes(id))!;
  writeRegister(state.doc, vertexRegister(corner), [9, 9, 9]);
  sync.noteEdit();
  sync.flush(); // held back: the claim is still out
  const assignsBefore = state.assigns.length;
  sync.claimed({ batch: state.batch, ok: false, steps: [winnerStep] });
  assert.deepEqual(readRegister(state.doc, vertexRegister(corner)), [9, 9, 9], 'the edit survives the rebuild');
  assert(state.assigns.slice(assignsBefore).some(sent => sent.changes.some(([key]) => key === vertexRegister(corner))),
    'and goes to the room straight away');
  assert.equal(state.fetches.length, 0, 'with no drift check racing it');
  sync.stop();
}

// A catch-up step that fails to land asks for the document once, not once per route that noticed.
{
  const { state, sync } = harness(before);
  sync.disconnect();
  sync.caughtUp({ steps: [{ delta: { ...winnerStep.delta, structure: 'not this one' }, changes: [] }] });
  assert.deepEqual(state.fetches, [['topology']], 'one whole-document request');
  sync.stop();
}

// A resync asked before the room was open — just after a project switch — is asked again on joining it.
{
  const { state, sync } = harness(before);
  sync.applyTopology({ delta: { ...winnerStep.delta, structure: 'not this one' }, changes: [] });
  assert.deepEqual(state.fetches, [['topology']]);
  sync.connect();
  assert.deepEqual(state.fetches, [['topology'], ['topology']], 'joining asks again rather than waiting for ever');
  sync.repair({ registers: [], document: structuredClone(before) });
  assert.equal(sync.status().landed, true);
  sync.stop();
}

// A relayed value for a register this replica has in flight was sequenced before its write and is skipped —
// unless the room refuses that write, when the relayed value is what the room holds after all.
{
  const { state, sync } = harness(before);
  const key = vertexRegister(state.doc.vertexIds[3]);
  writeRegister(state.doc, key, [5, 5, 5]);
  sync.noteEdit();
  sync.flush();
  const sent = state.assigns.at(-1)!;
  sync.applySync([[key, [6, 6, 6]]], 'Jed');
  assert.deepEqual(readRegister(state.doc, key), [5, 5, 5], 'a relay for an in-flight register is superseded');
  sync.landed({ batch: sent.batch, retired: [], refused: [] });
  assert.deepEqual(readRegister(state.doc, key), [5, 5, 5], 'and stays superseded once the write lands');
  writeRegister(state.doc, key, [7, 7, 7]);
  sync.noteEdit();
  sync.flush();
  const refusedBatch = state.assigns.at(-1)!;
  sync.applySync([[key, [8, 8, 8]]], 'Jed');
  sync.landed({ batch: refusedBatch.batch, retired: [], refused: [key] });
  assert.deepEqual(readRegister(state.doc, key), [8, 8, 8], 'a refused write gives way to the value it skipped');
  assert.deepEqual(sync.pending(), []);
  sync.stop();
}

// Somebody else's topology no longer resets undo (docs/039). Register entries name registers by stable id and
// survive the renumbering; whole-document entries describe a structure that is gone and are dropped; and the
// arrival itself is never sealed into the next entry as if this participant had made it.
{
  let live = structuredClone(before);
  let pendingStep: RegisterStep | null = null;
  const reasserted: RegisterAssignment[][] = [];
  const registers = {
    sealStep: () => { const sealed = pendingStep; pendingStep = null; return sealed; },
    resetSteps: () => { pendingStep = null; },
    reassert: (changes: readonly RegisterAssignment[]) => { reasserted.push([...changes]); },
  } as unknown as RegisterSync;
  const history = createHistory({
    getDocJson: () => JSON.stringify(live),
    onRestore: json => { live = JSON.parse(json) as typeof live; },
    refreshButtons: () => {},
    registers: () => registers,
  });
  history.commit();
  const key = vertexRegister(live.vertexIds[0]);
  const prior = readRegister(live, key);
  writeRegister(live, key, [1, 2, 3]);
  pendingStep = { priors: [[key, prior]], afters: [[key, [1, 2, 3]]] };
  history.commit();
  const own = applyMeshDelete(live, { quads: [2] });
  assert(own.ok);
  live = own.doc;
  history.commit();
  assert.deepEqual(history.entries().map(entry => entry.summary).slice(1).map(summary => summary.split(' ')[0]),
    ['Move', 'Mesh'], 'a register entry, then this participant’s own topology edit');
  const remote = applyMeshDelete(live, { quads: [0] });
  assert(remote.ok);
  live = remote.doc;
  history.followTopology();
  assert.equal(history.entries().length, 2, 'the register entry survives; the whole-document entry is dropped');
  history.commit();
  assert.equal(history.entries().length, 2, 'the remote topology is not recorded as a local change');
  history.undo();
  assert.deepEqual(reasserted, [[[key, prior]]], 'and undoing the surviving entry re-asserts its prior');
}
console.log('Sync context, frame coalescing, conflict notices, and duplicate recovery passed.');
