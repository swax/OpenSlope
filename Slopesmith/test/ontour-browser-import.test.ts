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
import type { MapDataSource } from '../src/shared/map-data';
import { readReferenceEffects } from '../src/shared/map-effects';
import { decodeReferenceEffects, referenceUvScroll } from '../src/core/reference/effects';
import { editorUvScrollDelta } from '../src/core/effects/world-effects';

const root = fileURLToPath(new URL('../..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'slopesmith-ontour-'));
const server = createServer();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const fixture = join(work, 'mountain.iso');
  const generated = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [join(root, 'Native/tests/ontour_import_test.py'), '--fixture', fixture],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const worker = join(work, 'worker.js');
  await build({
    entryPoints: [join(root, 'Slopesmith/src/app/public/iso-worker.ts')],
    outfile: worker,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  const cache = join(work, 'cache.js');
  const adapter = join(work, 'local-data.js');
  await build({
    entryPoints: [join(root, 'Slopesmith/src/app/public/local-map-data.ts')],
    outfile: adapter,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  await build({
    entryPoints: [join(root, 'Slopesmith/src/app/public/iso-cache.ts')],
    outfile: cache,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  server.on('request', (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/worker.js' || path === '/cache.js' || path === '/local-data.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(readFileSync(path === '/worker.js' ? worker : path === '/cache.js' ? cache : adapter));
    } else if (/^\/iso-importer\/openslope_browser_import\.(js|wasm)$/.test(path)) {
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'application/wasm');
      response.end(readFileSync(join(root, 'Slopesmith/public', path)));
    } else response.end('<!doctype html><title>On Tour browser importer test</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = fn => fn;');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async encoded => {
    const file = new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'ontour-fixture.iso');
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
        worker.postMessage({ operation, file, courses: operation === 'scan' ? [] : ['SSXOT_ER1_NIGHT'] });
      });
    const scan = await run('scan');
    await run('extract');
    const request = indexedDB.open('slopesmith-local-disc', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = async (key: string) => {
      const request = db.transaction('files').objectStore('files').get(`SSXOT_ER1_NIGHT/${key.toLowerCase()}`);
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
    const soundBindings = await read('SoundBindings.json');
    const lights = (await read('Lights.json')).Lights;
    const spot = lights.find((light: { UnknownFloat2?: number }) => light.UnknownFloat2 === 0.75);
    const halo = lights.find((light: { LightName: string }) => light.LightName.startsWith('Halo '));
    const deferred = await read('Audio/SFX/EMTR_DEFERRED/bank.json');
    const sky = await read('Skybox/Models.json');
    const soundIndex = await read('Audio/SoundIndex.json');
    const riding = await read('Audio/RidingImport.json');
    const courseRequest = db.transaction('courses').objectStore('courses').get('SSXOT_ER1_NIGHT');
    const course = await new Promise<{ files: number }>(resolve => {
      courseRequest.onsuccess = () => resolve(courseRequest.result);
    });
    db.close();
    const moduleUrl = '/cache.js';
    const { needsCollisionSoundUpdate, cachedIsoCourses } = await import(/* @vite-ignore */ moduleUrl);
    const adapterUrl = '/local-data.js';
    const { localMapData } = await import(adapterUrl);
    const local = await localMapData(['SSXOT_ER1_NIGHT']);
    const bankInfo = await (await fetch(local.resolveAsset('/api/board-audio?level=SSXOT_ER1_NIGHT'))).json();
    const wave = await (
      await fetch(local.resolveAsset('/api/board-sound?bank=zboard&slot=4&loop=1&level=SSXOT_ER1_NIGHT'))
    ).arrayBuffer();
    const missing = await (
      await fetch(local.resolveAsset('/api/board-sound?bank=zboard&slot=4&level=MISSING'))
    ).arrayBuffer();
    local.dispose();
    return {
      courses: scan.courses,
      ridingBanks: [bankInfo.boardBank, bankInfo.boostBank],
      patches: patches.Patches.length,
      instances: instances.Instances.length,
      texture: patches.Patches[0].TexturePath,
      game: effects.target.game,
      movingSlot: instances.Instances[1].EffectSlotIndex,
      helperSlot: instances.Instances[0].EffectSlotIndex,
      resetMain: effects.graphs.find((graph: { id: string }) => graph.id === 'openslope-playtest:reset')?.nodes[0]
        ?.mainType,
      scroll: effects.graphs[0]?.nodes[0]?.payload.type0.UVScroll,
      frames: materials.Materials[0].TextureFlipbook,
      effectDocument: effects,
      instanceDocument: instances,
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
      cone: spot?.UnknownFloat2,
      haloBrightness: halo?.UnknownFloat1,
      haloHasNoReach:
        JSON.stringify(halo?.LowestXYZ) === JSON.stringify(halo?.Position) &&
        JSON.stringify(halo?.HighestXYZ) === JSON.stringify(halo?.Position),
      files: course.files,
      deferredCodec: deferred.DeferredSlots[0].Codec,
      skyModels: sky.Models.length,
      soundResolver: soundIndex.ResolverState,
      soundLevel: soundIndex.Level,
      needsSoundUpdate: await needsCollisionSoundUpdate(['SSXOT_ER1_NIGHT']),
      cached: await cachedIsoCourses(),
    };
  }, readFileSync(fixture).toString('base64'));
  assert(result.courses?.includes('SSXOT_ER1_DAY'));
  assert(result.courses?.includes('SSXOT_ER1_NIGHT'));
  assert(!result.courses?.some(course => course.includes('ALL')));
  assert.equal(result.patches, 1);
  assert.equal(result.instances, 2);
  assert.equal(result.texture, '0000_o.png');
  assert.equal(result.game, 'ssx-on-tour');
  assert.equal(result.movingSlot, 0);
  assert.equal(result.helperSlot, -1);
  assert.equal(result.resetMain, undefined);
  assert(Math.abs(result.scroll.U1 - 0.01) < 1e-7 && Math.abs(result.scroll.U2 + 0.02) < 1e-7);
  assert.deepEqual(result.frames, ['0000_o.png', '0001_o.png']);
  assert.equal(result.soundsDeferred, 'Deferred');
  assert.equal(result.soundRows, 3);
  assert.equal(result.riding, 'Approximate');
  assert.deepEqual(result.ridingBanks, ['openslope_board', 'openslope_rider']);
  assert.equal(result.boardWave, 'RIFF');
  assert.equal(result.boardFrames, 44);
  assert.equal(result.missingSoundBytes, 0, 'An explicit missing course must not borrow audio');
  const io: MapDataSource = {
    root: 'maps',
    async readJsonOr<T>(path: string, fallback: T): Promise<T> {
      if (path.endsWith('/Effects.json')) return result.effectDocument as T;
      if (path.endsWith('/Instances.json')) return result.instanceDocument as T;
      return fallback;
    },
    async readTextOrNull() {
      return null;
    },
    async readBytesOrNull() {
      return null;
    },
    async listDir() {
      return [];
    },
    async listEntries() {
      return [];
    },
    async pathExists() {
      return true;
    },
  };
  const playback = decodeReferenceEffects(await readReferenceEffects(io, 'SSXOT_ER1_NIGHT'));
  const scroll = referenceUvScroll(playback, 1);
  assert(scroll, 'Imported instance -> persistent slot -> normalized graph must reach material playback');
  const [u, v] = editorUvScrollDelta(scroll, 30);
  assert(Math.abs(u - 0.3) < 1e-7 && Math.abs(v - 0.6) < 1e-7, 'Half a second preserves U and converts V axes');
  assert.equal(referenceUvScroll(playback, 0), null, 'Hidden helper does not acquire a UV modifier');
  assert.equal(result.helperVisible, false);
  assert.equal(result.helperSolid, false);
  assert.equal(result.helperContact, true, 'A hidden helper retains its original pass-through contact shape');
  assert.deepEqual(result.helperProxy, ['0_0.obj']);
  assert.equal(result.cone, 0.75);
  assert(result.haloBrightness > 0 && result.haloHasNoReach);
  assert(result.files > 15);
  assert.equal(result.deferredCodec, 23);
  assert.equal(result.skyModels, 1);
  assert.equal(result.soundResolver, 'Deferred');
  assert.equal(result.soundLevel, 'SSXOT_ER1_NIGHT');
  assert.equal(result.needsSoundUpdate, false, 'Deferred On Tour audio must not block play with an ISO reload prompt');
  assert.deepEqual(result.cached, ['SSXOT_ER1_NIGHT'], 'The current importer must publish a current cache version');
  console.log('On Tour browser Wasm worker: scan, extraction and IndexedDB map publication PASS');
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
