// tier: fast
import assert from 'node:assert/strict';
import { createRegisterSync } from '../src/app/net/register-sync';
import type { RegisterAssignment } from '../src/app/net/session-channel';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { linkedFieldRegisters, objectFieldOf } from '../src/core/doc/registers';

const oldLevel = `asset1:ssx-tricky:TRICKY_GARI:${'a'.repeat(64)}`;
const newLevel = `asset2:ssx-tricky:TRICKY_GARI:prop:1:${'b'.repeat(64)}`;

function harness() {
  let doc = migrateMountain(defaultMountain());
  doc.props = Array.from({ length: 828 }, (_, i) => ({
    id: `prop-${i}`,
    name: 'Tree',
    level: oldLevel,
    model: 1,
    pos: [0, 0, 0] as [number, number, number],
    yaw: 0,
    scale: 1,
  }));
  const sent: { batch: number; changes: RegisterAssignment[] }[] = [];
  let failAfter = Infinity;
  const sync = createRegisterSync({
    getDoc: () => doc,
    setDoc: next => {
      doc = next;
    },
    channel: {
      assign: (changes, batch) => {
        if (sent.length >= failAfter) return false;
        sent.push({ batch, changes: structuredClone(changes) });
        return true;
      },
      claim: () => true,
      checkDrift: () => true,
      fetchSections: () => true,
    },
  });
  sync.adopt(doc);
  sync.connect();
  return {
    sync,
    sent,
    get doc() {
      return doc;
    },
    failAfter(count: number) {
      failAfter = count;
    },
    upgrade() {
      for (const prop of doc.props!) prop.level = newLevel;
      doc.quadTex = { ...doc.quadTex, 0: 'Custom/one.png', 1: 'Custom/two.png' };
      sync.noteEdit();
      sync.flush();
    },
  };
}

function assertBatches(sent: ReturnType<typeof harness>['sent']) {
  assert.equal(sent.length, 2, 'the captured 4,142-change upgrade needs two messages');
  assert(
    sent.every(entry => entry.changes.length <= 4096),
    'each message fits the server limit',
  );
  assert.equal(sent.flatMap(entry => entry.changes).length, 4142, 'every assignment is retained');
  const owners = new Map<string, number>();
  for (const entry of sent) {
    const keys = new Set(entry.changes.map(([key]) => key));
    for (const [key] of entry.changes) {
      const field = objectFieldOf(key);
      if (!field) continue;
      assert.equal(owners.get(field.object) ?? entry.batch, entry.batch, 'linked prop fields land together');
      owners.set(field.object, entry.batch);
      for (const linked of linkedFieldRegisters(key))
        assert(keys.has(linked), 'the whole linked field group is present');
    }
  }
}

{
  const { sync, sent, upgrade } = harness();
  upgrade();
  assertBatches(sent);
  const step = sync.sealStep();
  assert(step);
  assert.equal(step.afters.length, 4142, 'message boundaries preserve one undo step');
  assert.equal(sync.status().inFlight, 4142);
  sync.landed({ batch: sent[0].batch });
  assert.equal(sync.status().inFlight, sent[1].changes.length);
  assert.equal(sync.status().landed, false, 'one acknowledgement cannot mark the whole upgrade saved');
  sync.landed({ batch: sent[1].batch });
  assert.equal(sync.status().landed, true);
  sync.reassert(step.priors);
  assertBatches(sent.slice(2));
  sync.stop();
}

{
  const state = harness();
  state.failAfter(1);
  state.upgrade();
  assert.equal(state.sent.length, 1);
  assert(state.sync.status().held > 0, 'a failed later batch remains available for reconnection');
  assert.equal(state.sync.status().inFlight + state.sync.status().held, 4142);
  state.sync.landed({ batch: state.sent[0].batch });
  state.failAfter(Infinity);
  state.sync.replayHeld();
  assertBatches(state.sent);
  state.sync.landed({ batch: state.sent[1].batch });
  assert.equal(state.sync.status().landed, true, 'replaying the unsent tail completes the save');
  state.sync.stop();
}

console.log('SYNC BATCHES PASS');
