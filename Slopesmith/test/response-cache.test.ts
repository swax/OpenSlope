// tier: fast

import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { ResponseCache, responseCache } from '../src/server/response-cache';

type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };

let builds = 0;
let revision = 1;
const lruCache = new ResponseCache(1_500);
const lruBuilds = new Map<string, number>();
const selectiveBuilds = new Map<string, number>();
responseCache.clear();

const server = createServer(async (req, res) => {
  if (req.url === '/preencoded') {
    await responseCache.jsonBytes(req, res, 'preencoded', () => Buffer.from('{"already":"json"}'));
    return;
  }
  if (req.url?.startsWith('/lru/')) {
    const key = req.url.slice('/lru/'.length);
    await lruCache.bytes(req, res, key, 'application/octet-stream', 'private, no-cache', () => {
      lruBuilds.set(key, (lruBuilds.get(key) ?? 0) + 1);
      return Buffer.alloc(900, key);
    });
    return;
  }
  if (req.url?.startsWith('/select/')) {
    const key = req.url.slice('/select/'.length);
    await responseCache.json(req, res, `props:${key}`, () => {
      selectiveBuilds.set(key, (selectiveBuilds.get(key) ?? 0) + 1);
      return { key };
    });
    return;
  }
  await responseCache.json(req, res, 'large-payload', async () => {
    builds++;
    await new Promise(resolve => setTimeout(resolve, 25));
    return { revision, data: 'slopesmith'.repeat(1_000) };
  });
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
const port = address.port;

function get(headers: Record<string, string> = {}, path = '/'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end();
  });
}

try {
  const [first, joined] = await Promise.all([
    get({ 'accept-encoding': 'gzip' }),
    get({ 'accept-encoding': 'gzip' }),
  ]);
  assert.equal(builds, 1, 'concurrent cold requests share one generated payload');
  assert.equal(first.headers['x-slopesmith-cache'], 'miss');
  assert.equal(joined.headers['x-slopesmith-cache'], 'hit');
  assert.equal(first.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(gunzipSync(first.body).toString()).revision, 1);
  assert.equal(responseCache.stats().gzipBuilds, 1,
    'concurrent gzip clients share one requested representation');
  assert.equal(responseCache.stats().brotliBuilds, 0,
    'a cold gzip request does not also build an unused Brotli representation');

  const refusedBrotli = await get({ 'accept-encoding': 'br;q=0' });
  assert.equal(refusedBrotli.headers['content-encoding'], undefined,
    'an explicitly refused encoding is never selected');
  assert.equal(JSON.parse(refusedBrotli.body.toString()).revision, 1);

  const spacedBrotli = await get({ 'accept-encoding': 'gzip;q=0.5, br ; q=1' });
  assert.equal(spacedBrotli.headers['content-encoding'], 'br',
    'optional whitespace before encoding parameters is accepted');
  assert.equal(JSON.parse(brotliDecompressSync(spacedBrotli.body).toString()).revision, 1);
  assert.equal(responseCache.stats().brotliBuilds, 1,
    'Brotli is built lazily when a client first prefers it');

  const preencoded = await get({}, '/preencoded');
  assert.equal(preencoded.body.toString(), '{"already":"json"}',
    'pre-serialized JSON is cached and sent without being stringified as a JSON string');

  await get({}, '/lru/a');
  await get({}, '/lru/b'); // completing b pushes the raw cache past 1,500 bytes and evicts a
  const bHit = await get({}, '/lru/b');
  const aAgain = await get({}, '/lru/a');
  assert.equal(bHit.headers['x-slopesmith-cache'], 'hit', 'the most-recent bounded entry is retained');
  assert.equal(aAgain.headers['x-slopesmith-cache'], 'miss', 'the least-recent completed entry is evicted');
  assert.deepEqual(Object.fromEntries(lruBuilds), { a: 2, b: 1 });

  await get({}, '/select/DONOR');
  await get({}, '/select/DONOR2');
  assert.equal(responseCache.invalidate(key => key.toLowerCase() === 'json:props:donor'), 1,
    'selective invalidation reports the removed response');
  const donorAgain = await get({}, '/select/DONOR');
  const donor2Again = await get({}, '/select/DONOR2');
  assert.equal(donorAgain.headers['x-slopesmith-cache'], 'miss', 'the changed level is rebuilt');
  assert.equal(donor2Again.headers['x-slopesmith-cache'], 'hit', 'an unrelated level stays warm');
  assert.deepEqual(Object.fromEntries(selectiveBuilds), { DONOR: 2, DONOR2: 1 });

  const etag = String(first.headers.etag);
  const validated = await get({ 'if-none-match': etag });
  assert.equal(validated.status, 304);
  assert.equal(validated.body.length, 0);
  assert.equal(validated.headers['x-slopesmith-cache'], 'hit');

  revision = 2;
  responseCache.clear();
  const refreshed = await get();
  assert.equal(builds, 2, 'clear forces one rebuild for the new source revision');
  assert.notEqual(refreshed.headers.etag, etag);
  assert.equal(JSON.parse(refreshed.body.toString()).revision, 2);

  console.log('RESPONSE CACHE TESTS PASSED');
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  responseCache.clear();
  lruCache.clear();
}
