// tier: fast
import assert from 'node:assert/strict';
import { createReferenceUploadQueue } from '../src/app/public/reference-upload-queue';

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
const starts: Array<[string, boolean]> = [];
let concurrent = 0,
  peak = 0,
  report = (_message: string) => {};
const queue = createReferenceUploadQueue(
  async (course, music, _signal, progress) => {
    starts.push([course, music]);
    peak = Math.max(peak, ++concurrent);
    report = progress;
    const job = deferred();
    jobs.set(course, job);
    try {
      await job.promise;
      return { reusedFiles: 3 };
    } finally {
      concurrent--;
    }
  },
  () => {},
);
const done = queue.add('GARI', false);
void queue.add('SNOW', true);
void queue.add('TRICKY_GARI', true);
void queue.add('MESA', false);
assert.deepEqual(starts, [['GARI', false]]);
assert.equal(queue.state('TRICKY_SNOW')?.phase, 'queued');
assert.equal(queue.state('TRICKY_SNOW')?.music, true);
queue.cancel('TRICKY_MESA');
report('4 files reused · Uploading reference… 40%');
assert.match(queue.state('TRICKY_GARI')!.message, /40%/);
jobs.get('GARI')!.resolve();
await tick();
assert.deepEqual(
  starts,
  [
    ['GARI', false],
    ['SNOW', true],
  ],
  'duplicate legacy aliases do not queue twice, and music follows its own job',
);
assert.equal(queue.state('GARI')?.phase, 'complete');
assert.match(queue.state('GARI')!.message, /3 files reused/);
jobs.get('SNOW')!.reject(new Error('Connection failed'));
await done;
assert.equal(peak, 1);
assert.equal(queue.busy, false);
assert.equal(queue.state('SNOW')?.phase, 'error');
const retry = queue.add('SNOW', false);
jobs.get('SNOW')!.resolve();
await retry;
queue.clear('SNOW');
assert.equal(queue.state('SNOW'), undefined);

const active = deferred(),
  cleanup = deferred();
const order: string[] = [];
const cancellations = createReferenceUploadQueue(
  async (course, _music, signal) => {
    order.push(course);
    if (course === 'GARI') {
      signal.addEventListener('abort', () => active.reject(new Error('Cancelled')), { once: true });
      try {
        await active.promise;
      } finally {
        await cleanup.promise;
      }
    } else if (course === 'MESA') throw new Error('Bad map');
    return {};
  },
  () => {},
);
const stopped = cancellations.add('GARI', false);
void cancellations.add('MESA', false);
void cancellations.add('SNOW', false);
cancellations.cancel('GARI');
await tick();
assert.deepEqual(order, ['GARI'], 'a cancelled upload finishes cleanup before the next one starts');
cleanup.resolve();
await stopped;
assert.deepEqual(order, ['GARI', 'MESA', 'SNOW'], 'individual cancellations and failures do not stop later uploads');
assert.equal(cancellations.state('GARI'), undefined);
assert.equal(cancellations.state('MESA')?.phase, 'error');

const leave = deferred();
const leaving = createReferenceUploadQueue(
  async (_course, _music, signal) => {
    signal.addEventListener('abort', () => leave.reject(new Error('Page closed')), { once: true });
    await leave.promise;
    return {};
  },
  () => {},
);
const left = leaving.add('GARI', true);
void leaving.add('SNOW', false);
leaving.dispose();
await left;
assert.equal(leaving.busy, false);
assert.equal(leaving.state('SNOW'), undefined);
console.log(
  'Reference upload queue: serial jobs, per-map music, legacy aliases, progress, cancellation, retry and page cleanup PASS',
);
