// tier: fast

import assert from 'node:assert/strict';
import type { LevelProps } from '../src/core/reference/props';
import { createPropLevelLoader, type PropLoadProgress } from '../src/app/props/level-loader';
import { fetchText, type DownloadProgress } from '../src/app/net/fetch-json';
import { referencePropBuildStatus, referencePropLoadStatus } from '../src/app/reference/prop-progress';

const originalFetch = globalThis.fetch;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
try {
  let requests = 0,
    registrations = 0,
    paints = 0;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const text = JSON.stringify({ level: 'TEST', models: [], materials: [], instances: [], name: 'snow 🏂' });
  const encoded = new TextEncoder().encode(text);
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      new ReadableStream({
        start: controller => {
          body = controller;
        },
      }),
      {
        headers: { 'content-length': String(encoded.byteLength) },
      },
    );
  };
  const levels = new Map<string, LevelProps>();
  const loader = createPropLevelLoader({
    levels,
    url: level => `/api/props?level=${level}`,
    register: () => {
      registrations++;
    },
  });
  loader.prefetch('TEST');
  loader.prefetch('TEST');
  await tick();
  assert.equal(requests, 1, 'speculative requests share one download');
  assert.equal(levels.size, 0);
  assert.equal(registrations, 0, 'prefetch does not construct geometry while terrain is loading');

  const progress: PropLoadProgress[] = [],
    sharedProgress: PropLoadProgress[] = [];
  const first = loader.ensure('TEST', {
    onProgress: update => progress.push(update),
    afterPaint: async () => {
      paints++;
      await tick();
    },
  });
  const second = loader.ensure('TEST', { onProgress: update => sharedProgress.push(update) });
  body.enqueue(encoded.subarray(0, 8));
  await tick();
  assert(progress.some(update => update.phase === 'download' && update.receivedBytes === 8));
  body.enqueue(encoded.subarray(8));
  body.close();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(requests, 1, 'reference/library consumers reuse the prefetch');
  assert.equal(registrations, 1, 'concurrent consumers decode/register once');
  assert.equal(paints, 2, 'decode and registration each paint their phase before synchronous work');
  assert.deepEqual([...new Set(progress.map(update => update.phase))], ['download', 'decode', 'register', 'ready']);
  assert.deepEqual(
    [...new Set(sharedProgress.map(update => update.phase))],
    ['download', 'decode', 'register', 'ready'],
  );
  const lastProgress = progress.length;
  await loader.ensure('TEST');
  assert.equal(requests, 1, 'a completed level remains cached');
  assert.equal(progress.length, lastProgress, 'completed consumers unsubscribe from progress');

  // A completed download can remain speculative: even invalid JSON is not parsed before terrain is ready.
  globalThis.fetch = async () => new Response('{broken');
  loader.prefetch('LATE');
  await tick();
  assert.equal(levels.has('LATE'), false);
  await assert.rejects(loader.ensure('LATE'), SyntaxError);
  globalThis.fetch = async () => Response.json({ level: 'LATE', models: [], materials: [], instances: [] });
  assert.equal((await loader.ensure('LATE')).level, 'LATE', 'a decode failure leaves the level retryable');

  let attempts = 0;
  globalThis.fetch = async () =>
    ++attempts === 1
      ? new Response('unavailable', { status: 503 })
      : Response.json({ level: 'RETRY', models: [], materials: [], instances: [] });
  loader.prefetch('RETRY');
  await tick();
  assert.equal((await loader.ensure('RETRY')).level, 'RETRY', 'failed abandoned prefetches are handled and retry');

  // Response chunks can split a UTF-8 character, and compressed Content-Length counts different bytes.
  for (const encoding of [undefined, 'br']) {
    const updates: DownloadProgress[] = [];
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
        {
          headers: {
            'content-length': String(encoded.byteLength),
            ...(encoding ? { 'content-encoding': encoding } : {}),
          },
        },
      );
    assert.equal(await fetchText('/api/props', update => updates.push(update)), text);
    assert.equal(updates.at(-1)?.receivedBytes, encoded.byteLength);
    assert.equal(updates.at(-1)?.totalBytes, encoding ? undefined : encoded.byteLength);
  }
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('connection lost'));
        },
      }),
    );
  await assert.rejects(
    fetchText('/api/props', () => {}),
    /connection lost/,
  );

  assert.equal(referencePropLoadStatus({ phase: 'download', receivedBytes: 512, totalBytes: 1024 }).progress, 82.5);
  assert.equal(referencePropLoadStatus({ phase: 'download', receivedBytes: 1024 }).detail, '1 KB received');
  assert.equal(referencePropLoadStatus({ phase: 'decode' }).label, 'Decoding reference props');
  assert.equal(referencePropBuildStatus({ phase: 'models', completed: 5, total: 10 }).progress, 92);
  assert.equal(referencePropBuildStatus({ phase: 'placements', completed: 50, total: 100 }).progress, 94.5);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('PROP LEVEL LOADING TESTS PASSED');
