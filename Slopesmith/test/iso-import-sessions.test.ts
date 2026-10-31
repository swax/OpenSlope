// tier: fast
import assert from 'node:assert/strict';
import { createIsoImportSessions, type ImportReply, type ImportWorker } from '../src/app/public/iso-import-sessions';

class Worker implements ImportWorker {
  onmessage: ImportWorker['onmessage'] = null;
  onerror: ImportWorker['onerror'] = null;
  requests: unknown[] = [];
  stopped = false;
  postMessage(request: unknown) {
    this.requests.push(request);
  }
  terminate() {
    this.stopped = true;
  }
  reply(data: ImportReply) {
    this.onmessage?.({ data } as MessageEvent<ImportReply>);
  }
}
const workers: Worker[] = [];
const sessions = createIsoImportSessions(() => {
  const worker = new Worker();
  workers.push(worker);
  return worker;
});
const file = new File(['disc'], 'same.iso');
const request = { file, operation: 'scan' as const, courses: [] };
const received: string[] = [];
let first = sessions.run(request, reply => received.push(reply.type));
workers[0].reply({ type: 'progress', message: 'Reading' });
workers[0].reply({ type: 'done', courses: ['TRICKY_GARI'] });
assert.deepEqual((await first).courses, ['TRICKY_GARI']);
assert.deepEqual(received, ['progress', 'done']);
const extract = sessions.run({ ...request, operation: 'extract', courses: ['TRICKY_GARI'] }, () => {});
assert.equal(workers.length, 1, 'scan and extraction reuse the same disc worker');
const other = new File(['different disc'], 'same.iso', { lastModified: file.lastModified });
const queued = sessions.run({ ...request, file: other }, () => {});
assert.equal(workers.length, 1, 'different disc operations remain serialized');
workers[0].reply({ type: 'done' });
await extract;
await new Promise<void>(resolve => queueMicrotask(resolve));
assert.equal(workers.length, 2, 'separate File objects never share a reader based on their filename');
workers[1].reply({ type: 'done' });
await queued;

const aborted = new AbortController();
first = sessions.run(request, () => {}, aborted.signal);
const rejected = assert.rejects(first, { name: 'AbortError' });
aborted.abort();
await rejected;
assert(workers[0].stopped, 'cancellation terminates the active WASM instance');
first = sessions.run(request, () => {});
assert.equal(workers.length, 3, 'retrying a cancelled disc creates a clean worker');
workers[2].reply({ type: 'done' });
await first;

const third = new File(['third'], 'third.iso');
first = sessions.run({ ...request, file: third }, () => {});
assert(workers[1].stopped, 'the least recently used worker is released at the two-disc limit');
const waitingAbort = new AbortController();
const waiting = sessions.run({ ...request, file: other }, () => {}, waitingAbort.signal);
const waitingRejected = assert.rejects(waiting, { name: 'AbortError' });
waitingAbort.abort();
await waitingRejected;
assert.equal(workers.length, 4, 'a cancelled queued request never initializes a worker');
workers[3].reply({ type: 'error', message: 'Bad map' });
await assert.rejects(first, /Bad map/);
first = sessions.run({ ...request, file: third }, () => {});
assert.equal(workers.length, 4, 'a map error preserves a usable disc session');
workers[3].reply({ type: 'done' });
await first;
const active = sessions.run(request, () => {});
const closed = assert.rejects(active, { name: 'AbortError' });
sessions.close();
await closed;
assert(workers.every(worker => worker.stopped));
console.log('ISO IMPORT SESSIONS PASS: disc reuse, bounded workers, serial requests, cancellation, retry and cleanup.');
