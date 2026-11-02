// tier: fast

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { DiagnosticSnapshot } from '../src/app/net/diagnostics';

const storageKey = 'slopesmith:diagnostics:v1';
const previous: DiagnosticSnapshot = {
  requests: [{ id: 'previous', page: 'previous', at: 0, method: 'GET', url: '/pending', status: 'pending' }],
  phases: [],
  stalls: [],
};
let stored = JSON.stringify(previous);
let writes = 0;
let storageBlocked = false;
const fakeWindow = new EventTarget();
const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
let observeStalls: (list: { getEntries(): { duration: number; startTime: number }[] }) => void;
const globals = {
  window: fakeWindow,
  document: fakeDocument,
  sessionStorage: {
    getItem: () => stored,
    setItem: (key: string, value: string) => {
      assert.equal(key, storageKey);
      if (storageBlocked) throw new Error('Storage blocked');
      stored = value;
      writes++;
    },
  },
  PerformanceObserver: class {
    static supportedEntryTypes = ['longtask'];
    constructor(callback: typeof observeStalls) {
      observeStalls = callback;
    }
    observe() {}
  },
};
const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const saved = () => JSON.parse(stored) as DiagnosticSnapshot;

try {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { beginRequestDiagnostic, beginDiagnosticPhase, clearDiagnostics, diagnosticsSnapshot } =
    await import('../src/app/net/diagnostics');
  mock.timers.enable({ apis: ['setTimeout'] });

  assert.equal(diagnosticsSnapshot().requests[0]?.id, 'previous', 'reload retains the last pending request');
  clearDiagnostics();
  assert.deepEqual(saved(), { requests: [], phases: [], stalls: [] }, 'clear immediately removes persisted history');
  writes = 0;

  const response = new Response('{}', { headers: { 'x-slopesmith-request-id': 'test' } });
  for (let i = 0; i < 50; i++) {
    const request = beginRequestDiagnostic(`/burst/${i}`);
    request.headers(response);
    request.complete();
  }
  for (let i = 0; i < 20; i++) beginDiagnosticPhase('props', `burst:${i}`).complete();
  assert.equal(writes, 0, 'a burst of successful requests and phases performs no synchronous storage writes');
  assert.equal(diagnosticsSnapshot().requests.filter(entry => entry.status === 'ok').length, 50);
  assert.equal(diagnosticsSnapshot().phases.filter(entry => entry.status === 'ok').length, 20);
  mock.timers.tick(249);
  assert.equal(writes, 0);
  mock.timers.tick(1);
  assert.equal(writes, 1, '190 diagnostic updates share one storage write');
  assert.equal(saved().requests.length, 50);
  assert.equal(saved().requests.at(-1)?.serverId, 'test', 'batched records retain response metadata');
  assert.equal(saved().phases.length, 20);

  const pending = beginRequestDiagnostic('/still-loading');
  mock.timers.tick(125);
  pending.headers(response);
  const phase = beginDiagnosticPhase('terrain', 'pending');
  mock.timers.tick(125);
  assert.equal(writes, 2, 'continued activity does not postpone the original checkpoint');
  assert.equal(saved().requests.at(-1)?.status, 'pending');
  assert.equal(saved().requests.at(-1)?.httpStatus, 200);
  assert.equal(saved().phases.at(-1)?.status, 'pending');
  mock.timers.tick(1000);
  assert.equal(writes, 2, 'unchanged diagnostics do not keep writing');

  pending.complete();
  fakeWindow.dispatchEvent(new Event('pagehide'));
  assert.equal(writes, 3, 'leaving the page flushes the latest diagnostic state');
  assert.equal(saved().requests.at(-1)?.status, 'ok');
  assert.equal(saved().phases.at(-1)?.status, 'pending');
  mock.timers.tick(250);
  assert.equal(writes, 3, 'lifecycle flush cancels the queued write');

  phase.complete();
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(writes, 3, 'a visible tab does not force a synchronous write');
  fakeDocument.visibilityState = 'hidden';
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(writes, 4, 'hiding the tab saves completed phases before timers may be suspended');
  assert.equal(saved().phases.at(-1)?.status, 'ok');
  fakeDocument.visibilityState = 'visible';

  beginRequestDiagnostic('/failed').fail(new Error('Request failed'));
  assert.equal(writes, 5, 'request errors are persisted immediately');
  assert.equal(saved().requests.at(-1)?.error, 'Request failed');
  beginDiagnosticPhase('props', 'failed').fail(new Error('Decode failed'));
  assert.equal(writes, 6, 'phase errors are persisted immediately');
  assert.equal(saved().phases.at(-1)?.error, 'Decode failed');
  mock.timers.tick(250);
  assert.equal(writes, 6, 'immediate error flushes leave no redundant queued write');

  observeStalls!({
    getEntries: () => [
      { duration: 75, startTime: 1000 },
      { duration: 90, startTime: 1200 },
    ],
  });
  assert.equal(diagnosticsSnapshot().stalls.length, 2, 'observed stalls remain immediately inspectable');
  assert.equal(writes, 6, 'stall reporting also batches storage work');
  mock.timers.tick(250);
  assert.equal(writes, 7);
  assert.equal(saved().stalls.length, 2);

  beginRequestDiagnostic('/discarded');
  clearDiagnostics();
  assert.equal(writes, 8);
  assert.deepEqual(saved(), { requests: [], phases: [], stalls: [] });
  mock.timers.tick(1000);
  assert.equal(writes, 8, 'clear cancels pending persistence without resurrecting old records');

  storageBlocked = true;
  beginRequestDiagnostic('/blocked-storage');
  assert.doesNotThrow(() => mock.timers.tick(250), 'unavailable storage does not interrupt loading');
  assert.equal(diagnosticsSnapshot().requests.at(-1)?.status, 'pending');
  storageBlocked = false;
  beginDiagnosticPhase('terrain', 'recovered-storage');
  fakeWindow.dispatchEvent(new Event('pagehide'));
  assert.equal(saved().requests.at(-1)?.url, '/blocked-storage', 'a subsequent checkpoint recovers retained records');
  assert.equal(saved().phases.at(-1)?.name, 'recovered-storage');
  assert.equal(writes, 9);
  fakeWindow.dispatchEvent(new Event('pagehide'));
  assert.equal(writes, 9, 'clean lifecycle events do not rewrite storage');
} finally {
  mock.timers.reset();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}

console.log('DIAGNOSTICS PERSISTENCE PASS');
