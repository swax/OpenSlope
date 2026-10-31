import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const root = fileURLToPath(new URL('../..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'slopesmith-ssx3-'));
const server = createServer();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const fixture = join(work, 'mountain.iso');
  const generated = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [join(root, 'Native/tests/ssx3_import_test.py'), '--fixture', fixture],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const worker = join(work, 'worker.js');
  const adapter = join(work, 'local-data.js');
  const effectsReader = join(work, 'map-effects.js');
  await build({
    entryPoints: [join(root, 'Slopesmith/src/shared/map-effects.ts')],
    outfile: effectsReader,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  await build({
    entryPoints: [join(root, 'Slopesmith/src/app/public/local-map-data.ts')],
    outfile: adapter,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  await build({
    entryPoints: [join(root, 'Slopesmith/src/app/public/iso-worker.ts')],
    outfile: worker,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  server.on('request', (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/worker.js' || path === '/local-data.js' || path === '/map-effects.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(readFileSync(path === '/worker.js' ? worker : path === '/map-effects.js' ? effectsReader : adapter));
    } else if (/^\/iso-importer\/openslope_browser_import\.(js|wasm)$/.test(path)) {
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'application/wasm');
      response.end(readFileSync(join(root, 'Slopesmith/public', path)));
    } else response.end('<!doctype html><title>SSX3 browser importer test</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = fn => fn;');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async encoded => {
    const file = new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'ssx3-fixture.iso');
    const run = (operation: 'scan' | 'extract') =>
      new Promise<{ courses?: string[] }>((resolve, reject) => {
        const worker = new Worker('/worker.js', { type: 'module' });
        worker.onerror = event => {
          worker.terminate();
          reject(new Error(event.message));
        };
        worker.onmessage = event => {
          if (event.data.type === 'error') {
            worker.terminate();
            reject(new Error(event.data.message));
          }
          if (event.data.type === 'done') {
            worker.terminate();
            resolve(event.data);
          }
        };
        worker.postMessage({ operation, file, courses: operation === 'scan' ? [] : ['SSX3_A'] });
      });
    const scan = await run('scan');
    await run('extract');
    const request = indexedDB.open('slopesmith-local-disc', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = async (key: string) => {
      const request = db.transaction('files').objectStore('files').get(`SSX3_A/${key.toLowerCase()}`);
      const row = await new Promise<{ blob: Blob }>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return JSON.parse(await row.blob.text());
    };
    const patches = await read('Patches.json');
    const instances = await read('Instances.json');
    const effects = await read('Effects.json');
    const materials = await read('Materials.json');
    const importInfo = await read('Import.json');
    const soundBindings = await read('SoundBindings.json');
    const lights = (await read('Lights.json')).Lights;
    const courseRequest = db.transaction('courses').objectStore('courses').get('SSX3_A');
    const course = await new Promise<{ files: number }>(resolve => {
      courseRequest.onsuccess = () => resolve(courseRequest.result);
    });
    const riding = await read('Audio/RidingImport.json');
    // Simulate a revision-6 cache produced by the old reset-box approximation.
    // Reloading its common reader must retire only the inferred binding without reimporting the ISO.
    const legacyEffects = structuredClone(effects);
    legacyEffects.graphs.push({
      id: 'openslope-playtest:reset',
      nodes: [{ id: 'old-reset', mainType: 13, semanticType: 'rider.reset', payload: {}, references: {} }],
    });
    legacyEffects.slots.push({
      id: 'openslope-playtest:reset:slot',
      originalIndex: legacyEffects.slots.length,
      circumstances: {
        persistent: null,
        collision: 'openslope-playtest:reset',
        slot3: null,
        slot4: null,
        trigger: null,
        slot6: null,
        slot7: null,
      },
    });
    const legacyInstances = structuredClone(instances);
    Object.assign(legacyInstances.Instances[0], {
      EffectSlotIndex: legacyEffects.slots.length - 1,
      PlayerCollision: true,
      PlayerBounce: false,
      U0: 0,
      CollsionMode: 2,
    });
    const update = db.transaction('files', 'readwrite');
    for (const [path, document] of [
      ['effects.json', legacyEffects],
      ['instances.json', legacyInstances],
    ] as const)
      update.objectStore('files').put({
        key: `SSX3_A/${path}`,
        course: 'SSX3_A',
        path,
        blob: new Blob([JSON.stringify(document)], { type: 'application/json' }),
      });
    await new Promise<void>((resolve, reject) => {
      update.oncomplete = () => resolve();
      update.onerror = () => reject(update.error);
    });
    db.close();
    const adapterUrl = '/local-data.js';
    const { localMapData } = await import(adapterUrl);
    const local = await localMapData(['SSX3_A']);
    const bankInfo = await (await fetch(local.resolveAsset('/api/board-audio?level=SSX3_A'))).json();
    const readerUrl = '/map-effects.js';
    const { readReferenceEffects } = await import(readerUrl);
    const repaired = await readReferenceEffects(local.source, 'SSX3_A');
    const stored = await local.source.readJsonOr('SSX3_A/Effects.json', null);
    const wave = await (
      await fetch(local.resolveAsset('/api/board-sound?bank=zboard&slot=4&loop=1&level=SSX3_A'))
    ).arrayBuffer();
    const missing = await (
      await fetch(local.resolveAsset('/api/board-sound?bank=zboard&slot=4&level=MISSING'))
    ).arrayBuffer();
    local.dispose();
    return {
      courses: scan.courses,
      ridingBanks: [bankInfo.boardBank, bankInfo.boostBank],
      retiredCollision: repaired.document.slots.at(-1).circumstances.collision,
      storedCollision: stored.slots.at(-1).circumstances.collision,
      patches: patches.Patches.length,
      instances: instances.Instances.length,
      texture: patches.Patches[0].TexturePath,
      game: effects.target.game,
      layout: {
        MapType: importInfo.MapType,
        WorldId: importInfo.WorldId,
        ParentMap: importInfo.ParentMap,
        SourceSections: importInfo.SourceSections,
      },
      movingSlot: instances.Instances[1].EffectSlotIndex,
      helperSlot: instances.Instances[0].EffectSlotIndex,
      scroll: effects.graphs[0]?.nodes[0]?.payload.type0?.UVScroll,
      resetMain: effects.graphs.find((graph: { id: string }) => graph.id === 'openslope-playtest:reset')?.nodes[0]
        ?.mainType,
      frames: materials.Materials[0].TextureFlipbook,
      soundsDeferred: soundBindings.ResolverState,
      soundRows: soundBindings.Bindings.length,
      riding: riding.Fidelity,
      boardWave: new TextDecoder().decode(wave.slice(0, 4)),
      boardFrames: (wave.byteLength - 44) / 2,
      missingSoundBytes: missing.byteLength,
      helperVisible: instances.Instances[0].Visable,
      helperContact: instances.Instances[0].PlayerCollision,
      helperSolid:
        instances.Instances[0].PlayerCollision &&
        instances.Instances[0].PlayerBounce !== false &&
        instances.Instances[0].U0 !== 0,
      helperProxy: instances.Instances[0].CollsionModelPaths,
      cone: lights[0].UnknownFloat2,
      haloBrightness: lights[1].UnknownFloat1,
      haloHasNoReach:
        JSON.stringify(lights[1].LowestXYZ) === JSON.stringify(lights[1].Position) &&
        JSON.stringify(lights[1].HighestXYZ) === JSON.stringify(lights[1].Position),
      files: course.files,
    };
  }, readFileSync(fixture).toString('base64'));
  assert(result.courses?.includes('SSX3_PEAK1'));
  assert(!result.courses?.includes('SSX3_ALL'));
  assert.deepEqual(result.layout, {
    MapType: 'hub',
    WorldId: 'ssx-3:bam',
    ParentMap: 'SSX3_PEAK1',
    SourceSections: ['A'],
  });
  assert.equal(result.patches, 1);
  assert.equal(result.instances, 2);
  assert.equal(result.texture, '0000_o.png');
  assert.equal(result.game, 'ssx-3');
  assert.equal(result.movingSlot, -1);
  assert.equal(result.helperSlot, -1);
  assert.equal(result.retiredCollision, null, 'An older browser cache cannot reactivate the inferred reset box');
  assert.equal(result.storedCollision, 'openslope-playtest:reset', 'Read repair preserves cached source data');
  assert.equal(result.resetMain, undefined);
  assert.equal(result.scroll, undefined, 'SSX3 script bindings remain deferred');
  assert.deepEqual(result.frames, ['0000_o.png', '0001_o.png']);
  assert.equal(result.soundsDeferred, 'Deferred');
  assert.equal(result.soundRows, 3);
  assert.equal(result.riding, 'Approximate');
  assert.deepEqual(
    result.ridingBanks,
    ['openslope_board', 'ride'],
    'An empty adapted rider bank must not replace the source bank',
  );
  assert.equal(result.boardWave, 'RIFF');
  assert.equal(result.boardFrames, 44);
  assert.equal(result.missingSoundBytes, 0, 'An explicit missing course must not borrow audio');
  assert.equal(result.helperVisible, false);
  assert.equal(result.helperSolid, false);
  assert.equal(result.helperContact, false);
  assert.deepEqual(result.helperProxy, ['1_0.obj']);
  assert.equal(result.cone, 0.75);
  assert(result.haloBrightness > 0 && result.haloHasNoReach);
  assert(result.files > 15);
  console.log('SSX3 browser Wasm worker: scan, extraction and IndexedDB map publication PASS');
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
