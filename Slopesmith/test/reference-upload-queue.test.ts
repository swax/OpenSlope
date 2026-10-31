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
const starts: string[] = [];
let concurrent = 0,
  peak = 0,
  report = (_message: string) => {};
const queue = createReferenceUploadQueue(
  async (course, _signal, progress) => {
    starts.push(course);
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
const done = queue.add('GARI');
void queue.add('SNOW');
void queue.add('TRICKY_GARI');
void queue.add('MESA');
assert.deepEqual(starts, ['GARI']);
assert.equal(queue.state('TRICKY_SNOW')?.phase, 'queued');
queue.cancel('TRICKY_MESA');
report('4 files reused · Uploading reference… 40%');
assert.match(queue.state('TRICKY_GARI')!.message, /40%/);
jobs.get('GARI')!.resolve();
await tick();
assert.deepEqual(starts, ['GARI', 'SNOW'], 'duplicate legacy aliases do not queue twice');
assert.equal(queue.state('GARI')?.phase, 'complete');
assert.match(queue.state('GARI')!.message, /3 files reused/);
jobs.get('SNOW')!.reject(new Error('Connection failed'));
await done;
assert.equal(peak, 1);
assert.equal(queue.busy, false);
assert.equal(queue.state('SNOW')?.phase, 'error');
const retry = queue.add('SNOW');
jobs.get('SNOW')!.resolve();
await retry;
queue.clear('SNOW');
assert.equal(queue.state('SNOW'), undefined);

const active = deferred(),
  cleanup = deferred();
const order: string[] = [];
const cancellations = createReferenceUploadQueue(
  async (course, signal) => {
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
const stopped = cancellations.add('GARI');
void cancellations.add('MESA');
void cancellations.add('SNOW');
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
  async (_course, signal) => {
    signal.addEventListener('abort', () => leave.reject(new Error('Page closed')), { once: true });
    await leave.promise;
    return {};
  },
  () => {},
);
const left = leaving.add('GARI');
void leaving.add('SNOW');
leaving.dispose();
await left;
assert.equal(leaving.busy, false);
assert.equal(leaving.state('SNOW'), undefined);
console.log('Reference upload queue: serial jobs, legacy aliases, progress, cancellation, retry and page cleanup PASS');
