// tier: fast
import assert from 'node:assert/strict';
import { createAssetResolver } from '../src/shared/asset-resolver';
import { referenceAssetCacheKey } from '../src/app/net/asset-cache';
import { assetVersion } from '../src/core/reference/asset-version';
import { configureWorkspace, workspaceFetch } from '../src/app/net/workspace';

const stored = new Map<string, Response>(),
  calls: string[] = [];
let local = true,
  remoteStatus = 200;
const options = {
  key: (input: RequestInfo | URL) => String(input),
  maxBytes: 3,
  cache: {
    async get(key: string) {
      calls.push('persistent');
      return stored.get(key)?.clone();
    },
    async put(key: string, response: Response) {
      stored.set(key, response);
    },
  },
  async local() {
    calls.push('local');
    return local ? new Response('abc') : new Response('', { status: 404 });
  },
  async remote() {
    calls.push('remote');
    return new Response('def', { status: remoteStatus });
  },
};
let resolver = createAssetResolver(options);
assert.equal(await (await resolver.fetch('one')).text(), 'abc');
assert.deepEqual(calls, ['persistent', 'local']);
calls.length = 0;
assert.equal(await (await resolver.fetch('one')).text(), 'abc');
assert.deepEqual(calls, [], 'memory precedes persistent storage');
resolver = createAssetResolver(options);
assert.equal(await (await resolver.fetch('one')).text(), 'abc');
assert.deepEqual(calls, ['persistent'], 'persistent storage precedes providers across resolver instances');
local = false;
calls.length = 0;
assert.equal(await (await resolver.fetch('two')).text(), 'def');
assert.deepEqual(calls, ['persistent', 'local', 'remote']);
calls.length = 0;
assert.equal(await (await resolver.fetch('one')).text(), 'abc');
assert.deepEqual(calls, ['persistent'], 'memory is bounded and evicts old entries');
remoteStatus = 404;
calls.length = 0;
assert.equal((await resolver.fetch('missing')).status, 404);
remoteStatus = 200;
assert.equal(await (await resolver.fetch('missing')).text(), 'def', 'misses can recover without a cache reset');
assert.equal(stored.get('missing')?.status, 200);
let reads = 0;
const concurrent = createAssetResolver({
  key: () => 'same',
  local: async () => {
    reads++;
    return new Response('shared');
  },
  remote: options.remote,
});
const pair = await Promise.all([concurrent.fetch('same'), concurrent.fetch('same')]);
assert.deepEqual(await Promise.all(pair.map(response => response.text())), ['shared', 'shared']);
assert.equal(reads, 1, 'concurrent callers share work but receive independent response bodies');
let largeReads = 0;
const largeMountain = createAssetResolver({
  key: String,
  local: async () => {
    largeReads++;
    return new Response('small tile');
  },
  remote: options.remote,
});
for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 320; i++) await largeMountain.fetch(`tile-${i}`);
assert.equal(largeReads, 320, 'a mountain with more than 256 small assets stays in memory within the byte budget');
let finishOld!: () => void,
  raceReads = 0;
const race = createAssetResolver({
  key: () => 'same',
  local: async () => {
    if (++raceReads === 1) {
      await new Promise<void>(resolve => {
        finishOld = resolve;
      });
      return new Response('old');
    }
    return new Response('new');
  },
  remote: options.remote,
});
const old = race.fetch('same');
await new Promise(resolve => setTimeout(resolve, 0));
race.clear();
assert.equal(await (await race.fetch('same')).text(), 'new');
finishOld();
await old;
assert.equal(
  await (await race.fetch('same')).text(),
  'new',
  'a completed old request cannot repopulate a cleared workspace cache',
);
const validated = createAssetResolver({
  key: () => 'revision',
  local: async () => new Response('wrong'),
  remote: async () => new Response('right'),
  validate: async (_input, response) => (await response.clone().text()) === 'right',
  cache: { get: async () => new Response('bad cache'), put: async () => {} },
});
assert.equal(
  await (await validated.fetch('revision')).text(),
  'right',
  'invalid cached and local bytes fall through to the matching remote copy',
);
const denied = createAssetResolver({
  key: () => undefined,
  local: async () => new Response('', { status: 403 }),
  remote: async () => {
    throw new Error('must not bypass a refusal');
  },
});
assert.equal((await denied.fetch('secret')).status, 403);
const noStorage = createAssetResolver({
  ...options,
  cache: {
    async get() {
      throw new Error('storage blocked');
    },
    async put() {
      throw new Error('quota');
    },
  },
});
assert.equal((await noStorage.fetch('offline-cache')).status, 200);
const id = assetVersion('ssx-tricky', 'TRICKY_GARI', 'a'.repeat(64)).id;
assert.equal(referenceAssetCacheKey('/api/texture?level=GARI&name=tile.png'), undefined);
assert.equal(referenceAssetCacheKey('/api/texture?level=Custom&name=tile.png&v=1'), undefined);
const revision = 'A'.repeat(43);
assert.equal(referenceAssetCacheKey(`/api/texture?level=local:Custom&name=tile.png&v=${revision}`), undefined);
assert(referenceAssetCacheKey(`/api/texture?level=Custom_GARI&name=tile.png&v=${revision}`));
assert.equal(referenceAssetCacheKey('/api/texture?level=GARI&name=tile.png&project=private&v=1'), undefined);
assert.equal(referenceAssetCacheKey(`https://other.test/api/texture?level=${id}&name=tile.png`), undefined);
assert.equal(
  referenceAssetCacheKey(`/api/texture?level=${id}&name=tile.png`),
  referenceAssetCacheKey(`/api/texture?name=tile.png&level=${id}`),
);
const workspaceReads: string[] = [];
configureWorkspace(false, async url => {
  const source = url.searchParams.get('mapSource') ?? 'legacy';
  workspaceReads.push(source);
  return new Response(source === 'local' ? 'missing' : 'remote bytes', { status: source === 'local' ? 404 : 200 });
});
assert.equal(await (await workspaceFetch('/api/texture?level=GARI&name=partial.png')).text(), 'remote bytes');
assert.deepEqual(workspaceReads, ['local', 'server']);
workspaceReads.length = 0;
assert.equal((await workspaceFetch('/api/texture?level=local:GARI&name=partial.png')).status, 404);
assert.deepEqual(workspaceReads, ['local'], 'an explicit local reference never falls through to the server');
configureWorkspace(
  true,
  async url => new Response('', { status: url.searchParams.get('mapSource') === 'server' ? 403 : 404 }),
);
assert.equal(
  (await workspaceFetch('/api/props?level=MISSING')).status,
  404,
  'an offline local miss remains a missing asset',
);
assert.equal(
  (await workspaceFetch('/api/props?level=server:MISSING')).status,
  403,
  'explicit server access still requires permission',
);
console.log('Shared asset resolver: cache order, exact keys, bounds, concurrent reads, retry and access refusal PASS');
