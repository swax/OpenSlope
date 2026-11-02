// tier: fast
import assert from 'node:assert/strict';
import { browserAssetCache } from '../src/app/net/asset-cache';

const buckets = new Map<string, Map<string, Response>>();
let matches = 0;
Object.assign(globalThis, {
  caches: {
    async open(name: string) {
      let entries = buckets.get(name);
      if (!entries) buckets.set(name, (entries = new Map()));
      return {
        async keys() {
          return [...entries.keys()].map(url => new Request(url));
        },
        async match(input: string | Request) {
          matches++;
          return entries.get(typeof input === 'string' ? input : input.url)?.clone();
        },
        async put(key: string, response: Response) {
          entries.set(key, response.clone());
        },
        async delete(input: string | Request) {
          return entries.delete(typeof input === 'string' ? input : input.url);
        },
      };
    },
  },
});

const key = (index: number) => `http://localhost/api/texture?entry=${index}`;
let scope = 'member:one';
const cache = browserAssetCache(async () => scope);
await Promise.all(Array.from({ length: 320 }, (_, i) => cache.put(key(i), new Response(`tile ${i}`), 8)));
assert(matches < 640, `writing a mountain must not reread every cached body for every tile (${matches} matches)`);
const reopened = browserAssetCache(async () => scope);
for (let i = 0; i < 320; i++)
  assert.equal(
    await (await reopened.get(key(i)))?.text(),
    `tile ${i}`,
    'a mountain larger than 256 assets stays cached',
  );
scope = 'member:two';
assert.equal(await reopened.get(key(0)), undefined, 'account scopes remain isolated');
await reopened.put(key(1000), new Response('large'), 100 * 1024 * 1024);
await reopened.put(key(1001), new Response('large'), 100 * 1024 * 1024);
assert.equal(await reopened.get(key(1000)), undefined, 'the byte budget still evicts older entries');
assert.equal(await (await reopened.get(key(1001)))?.text(), 'large');
console.log('Reference cache: linear bookkeeping, large mountains, reopen, account isolation and byte limit PASS');
