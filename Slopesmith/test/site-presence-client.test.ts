// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installTestDom } from './dom-test-support';

const cleanup = installTestDom('https://presence.test/');
const oldFetch = globalThis.fetch;
const oldSocket = globalThis.WebSocket;
const oldTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
Object.defineProperty(AbortSignal, 'timeout', {
  configurable: true,
  value: (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  },
});
let online = false,
  accept = true,
  welcome = true,
  presence = true;
let configFailures = 1,
  holdVisitor = true,
  configs = 0,
  visitors = 0,
  welcomes = 0;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
const member = { id: 'fixture', username: 'Fixture', role: 'viewer', anonymous: true };
const snapshot = { t: 'site-presence', online: 3, courses: {}, members: [] };
class Socket {
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  static all: Socket[] = [];
  constructor() {
    Socket.all.push(this);
    queueMicrotask(() => {
      if (!accept) this.close();
      else {
        this.readyState = 1;
        this.onopen?.();
      }
    });
  }
  send(data: string) {
    if (JSON.parse(data).t !== 'hello') return;
    welcomes++;
    if (!welcome) return;
    queueMicrotask(() => {
      this.receive({
        t: 'welcome',
        protocol: 1,
        sessionId: `fixture-${welcomes}`,
        member,
        color: '#ffffff',
        serverTime: Date.now(),
        courseId: '@site',
        roomId: 'site',
        publishMs: 100,
      });
      if (presence) this.receive(snapshot);
    });
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
globalThis.fetch = async (input, options) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === '/api/play/config') {
    configs++;
    if (configFailures-- > 0) return Response.json({}, { status: 503 });
    return Response.json({ enabled: true, socketPath: '/api/play/session', ticketPath: '/api/play/ticket' });
  }
  if (path === '/api/public/visitor') {
    visitors++;
    if (holdVisitor) {
      holdVisitor = false;
      return new Promise<Response>((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }),
      );
    }
    return Response.json({ member });
  }
  if (path === '/api/play/ticket') return Response.json({ ticket: 'fixture', expiresAt: Date.now() + 60_000 });
  throw new Error(`Unexpected presence request: ${path}`);
};
const flush = () => setImmediate();
const advance = async (ms: number) => {
  mock.timers.tick(ms);
  await flush();
};
try {
  const { watchSitePresence } = await import('../src/app/net/site-presence');
  let current: { online: number } | null = null;
  const stop = watchSitePresence(value => {
    current = value;
  });
  await flush();
  assert.equal(configs, 0, 'offline startup makes no network request');
  online = true;
  window.dispatchEvent(new Event('online'));
  await flush();
  assert.equal(configs, 1);
  await advance(5001); // retry configuration; visitor admission stalls
  assert.equal(configs, 2);
  assert.equal(visitors, 1);
  await advance(5001); // abort the visitor request
  await advance(5001); // retry the whole bootstrap
  assert.equal(configs, 3);
  assert.equal(visitors, 2);
  assert.equal(
    (current as { online: number } | null)?.online,
    3,
    'cold offline launch recovers after both API failures',
  );

  online = false;
  window.dispatchEvent(new Event('offline'));
  assert.equal(current, null);
  presence = false;
  online = true;
  window.dispatchEvent(new Event('online'));
  await flush();
  assert.equal(current, null, 'network recovery does not restore a stale player count');
  Socket.all.at(-1)!.receive(snapshot);
  assert.equal((current as { online: number } | null)?.online, 3);

  accept = false;
  Socket.all.at(-1)!.close();
  assert.equal(current, null);
  await advance(1100);
  accept = presence = true;
  await advance(2100);
  assert.equal(
    (current as { online: number } | null)?.online,
    3,
    'socket outages reconnect while navigator stays online',
  );

  const before = welcomes;
  await advance(60_001);
  assert.equal(current, null, 'a silent open connection expires after its heartbeat deadline');
  await advance(1100);
  assert(welcomes > before);
  assert.equal((current as { online: number } | null)?.online, 3);

  welcome = false;
  Socket.all.at(-1)!.close();
  await advance(1100);
  assert.equal(current, null);
  const stalled = welcomes;
  await advance(10_001);
  welcome = true;
  await advance(2100);
  assert(welcomes > stalled);
  assert.equal((current as { online: number } | null)?.online, 3, 'a stalled welcome reconnects');
  assert.equal(location.href, 'https://presence.test/', 'all recovery happens without navigation');
  stop();
  console.log(
    'PASS presence API retries, visitor abort, cold offline start, stale counts, socket outage, heartbeat and welcome deadlines',
  );
} finally {
  window.dispatchEvent(new Event('pagehide'));
  mock.timers.reset();
  Object.defineProperty(AbortSignal, 'timeout', oldTimeout);
  globalThis.fetch = oldFetch;
  globalThis.WebSocket = oldSocket;
  await cleanup();
}
