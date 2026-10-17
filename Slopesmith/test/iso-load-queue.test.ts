// tier: fast
import assert from 'node:assert/strict';
import { createIsoLoadQueue } from '../src/app/public/iso-load-queue';

const file = new File([], 'disc.iso');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const jobs = new Map<string, ReturnType<typeof deferred>>();
const started: string[] = [];
let concurrent = 0,
  peak = 0;
let report: (text: string) => void = () => {};
const queue = createIsoLoadQueue(
  async (_file, slot, progress) => {
    started.push(slot);
    peak = Math.max(peak, ++concurrent);
    report = progress;
    const job = deferred();
    jobs.set(slot, job);
    try {
      await job.promise;
    } finally {
      concurrent--;
    }
  },
  () => {},
);

const finished = queue.add(file, ['GARI']);
void queue.add(file, ['SNOW', 'GARI', 'MESA', 'SNOW']);
assert.deepEqual(started, ['GARI']);
assert.equal(queue.state('SNOW')?.phase, 'queued');
queue.cancel('MESA');
report('Saving Garibaldi…');
assert.equal(queue.state('GARI')?.message, 'Saving Garibaldi…');
jobs.get('GARI')!.resolve();
await tick();
assert.deepEqual(started, ['GARI', 'SNOW'], 'duplicate selections never start duplicate imports');
assert.equal(queue.state('GARI'), undefined);
jobs.get('SNOW')!.reject(new Error('Disc read failed'));
await finished;
assert.equal(peak, 1, 'extractors and cache writes never overlap');
assert.equal(queue.busy, false);
assert.deepEqual(queue.state('SNOW'), { phase: 'error', message: 'Disc read failed' });
const retry = queue.add(file, ['SNOW']);
jobs.get('SNOW')!.resolve();
await retry;
assert.equal(queue.state('SNOW'), undefined, 'failed maps can be retried');

const cancellation = deferred(),
  cleanup = deferred();
const order: string[] = [];
const cancelled = createIsoLoadQueue(
  async (_file, slot, _progress, signal) => {
    order.push(slot);
    if (slot === 'GARI') {
      signal.addEventListener('abort', () => cancellation.reject(new Error('Cancelled')), { once: true });
      try {
        await cancellation.promise;
      } finally {
        await cleanup.promise;
      }
    } else if (slot === 'MESA') throw new Error('Bad map');
  },
  () => {},
);
const cancelledFinished = cancelled.add(file, ['GARI', 'MESA', 'SNOW']);
cancelled.cancel('GARI');
await tick();
assert.deepEqual(order, ['GARI'], 'cancellation waits for importer cleanup before starting another map');
cleanup.resolve();
await cancelledFinished;
assert.deepEqual(order, ['GARI', 'MESA', 'SNOW'], 'cancelled and failed imports do not block later maps');
assert.equal(cancelled.state('GARI'), undefined);
assert.equal(cancelled.state('MESA')?.phase, 'error');
assert.equal(cancelled.busy, false);

const leaving = deferred();
const pageQueue = createIsoLoadQueue(
  async (_file, _slot, _progress, signal) => {
    signal.addEventListener('abort', () => leaving.reject(new Error('Page closed')), { once: true });
    await leaving.promise;
  },
  () => {},
);
const leavingFinished = pageQueue.add(file, ['GARI', 'SNOW']);
pageQueue.dispose();
await leavingFinished;
assert.equal(pageQueue.busy, false, 'leaving the page cancels active and queued imports');
assert.equal(pageQueue.state('SNOW'), undefined);
console.log('ISO LOAD QUEUE PASS: sequential imports, deduplication, cancellation, failure recovery and page cleanup.');
