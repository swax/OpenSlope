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
import Ajv2020 from 'ajv/dist/2020.js';
import { readReferenceEffects } from '../src/shared/map-effects';
import type { MapDataSource } from '../src/shared/map-data';
import { effectPlayCommand } from '../src/core/effects/play-runtime';
import { nativeInstanceIsShowoffOnly } from '../src/core/effects/mode-functions';
import { decodeReferenceEffects } from '../src/core/reference/effects';
import {
  animObjectFromGraph,
  createAnimObjectPlayback,
  stepAnimObjectPlayback,
} from '../src/core/effects/world-effects';

const root = fileURLToPath(new URL('../..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'slopesmith-ssx-fidelity-'));
const server = createServer();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const fixture = join(work, 'original.iso');
  const generated = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [join(root, 'Native/tests/ssx_fidelity_test.py'), '--fixture', fixture],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const gemFixture = join(work, 'gem.iso');
  const generatedGem = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [join(root, 'Native/tests/ssx_fidelity_test.py'), '--gem-fixture', gemFixture],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(generatedGem.status, 0, generatedGem.stderr);
  const worker = join(work, 'worker.js');
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
    entryPoints: [join(root, 'Slopesmith/src/app/public/iso-worker.ts')],
    outfile: worker,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  server.on('request', (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/local-data.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(readFileSync(adapter));
    } else if (path === '/worker.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(readFileSync(worker));
    } else if (/^\/iso-importer\/openslope_browser_import\.(js|wasm)$/.test(path)) {
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'application/wasm');
      response.end(readFileSync(join(root, 'Slopesmith/public', path)));
    } else response.end('<!doctype html><title>Original SSX fidelity test</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = fn => fn;');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const encodedFiles = [readFileSync(fixture).toString('base64'), readFileSync(gemFixture).toString('base64')];
  const result = await page.evaluate(async encodedFiles => {
    const [encoded, gemEncoded] = encodedFiles;
    let file = new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'ssx.iso');
    const extract = () =>
      new Promise<void>((resolve, reject) => {
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
            resolve();
          }
        };
        worker.postMessage({ operation: 'extract', file, courses: ['SSX_FIXTURE'] });
      });
    await extract();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('slopesmith-local-disc', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = <T>(store: string, key: string) =>
      new Promise<T | undefined>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const json = async (path: string) => {
      const stored = await row<{ blob: Blob }>('files', `SSX_FIXTURE/${path.toLowerCase()}`);
      if (!stored) throw new Error(`Missing cached ${path}`);
      return JSON.parse(await stored.blob.text());
    };
    const materials = await json('Materials.json');
    const effects = await json('Effects.json');
    const sprites = await json('RidingEffects.json');
    const sounds = await json('Audio/SoundIndex.json');
    const cached = await row<{ version: number }>('courses', 'SSX_FIXTURE');
    const wave = await row<{ blob: Blob }>('files', 'SSX_FIXTURE/audio/sfx/course/000.wav');
    if (!cached || !wave) throw new Error('Missing completed course or decoded sound');
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['files', 'courses'], 'readwrite');
      transaction.objectStore('files').put({
        key: 'SSX_FIXTURE/stale.txt',
        course: 'SSX_FIXTURE',
        path: 'stale.txt',
        blob: new Blob(['old import']),
      });
      transaction.objectStore('courses').put({ course: 'SSX_FIXTURE', version: 1, files: 1 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    await extract();
    const stale = await row('files', 'SSX_FIXTURE/stale.txt');
    const adapterUrl = '/local-data.js';
    const { localMapData } = await import(adapterUrl);
    const local = await localMapData(['SSX_FIXTURE']);
    const board = await (await fetch(local.resolveAsset('/api/board-audio'))).json();
    const boardWav = await fetch(local.resolveAsset('/api/board-sound?bank=zboard&slot=0&loop=1'));
    const boardBytes = await boardWav.arrayBuffer();
    const music = await (await fetch(local.resolveAsset('/api/reference-music?level=SSX_FIXTURE'))).json();
    const intro = await fetch(local.resolveAsset('/api/reference-intro-music?level=SSX_FIXTURE&stem=auth-c1.wav'));
    const introBytes = await intro.arrayBuffer();
    local.dispose();
    file = new File([Uint8Array.from(atob(gemEncoded), c => c.charCodeAt(0))], 'gem.iso');
    await extract();
    const gemModels = await json('Models.json');
    const gemInstances = await json('Instances.json');
    const gemEffects = await json('Effects.json');
    db.close();
    return {
      material: materials.Materials[0],
      enabled: effects.graphs.map((g: { nodes: unknown[] }) => g.nodes.length),
      sprite: sprites.EmitterSprites[0],
      sourceExecutable: sprites.SourceExecutable,
      banks: sounds.Banks,
      sounds,
      wav: wave.blob.type,
      version: cached.version,
      stale: !!stale,
      board,
      boardSignature: new TextDecoder().decode(boardBytes.slice(0, 4)),
      boardFrames: (boardBytes.byteLength - 44) / 2,
      intro: music.intro,
      introSignature: new TextDecoder().decode(introBytes.slice(0, 4)),
      gemModel: gemModels.Models[0],
      gemInstance: gemInstances.Instances[0],
      gemEffects,
    };
  }, encodedFiles);
  assert.equal(result.material.AlphaMode, 'cutout');
  assert.equal(result.material.SSXRenderFlags, 0x69);
  assert.deepEqual(result.enabled, [3, 1, 0]);
  assert.equal(result.sprite, 'Particles/part.png');
  assert.equal(result.sourceExecutable, 'AUTHORED.ELF');
  assert.equal(result.banks['1'], 'main');
  assert.equal(result.banks['2'], 'course');
  assert.equal(result.wav, 'audio/wav');
  assert.equal(result.version, 3);
  assert.equal(result.stale, false);
  assert.equal(result.board.board, 'main');
  assert.equal(result.board.surfaceGroups.length, 20);
  assert.equal(result.boardSignature, 'RIFF');
  assert.equal(result.boardFrames, 2);
  assert.deepEqual(result.intro, { tier: 'C', stems: ['auth-c1.wav', 'auth-c2.wav'] });
  assert.equal(result.introSignature, 'RIFF');
  assert.equal(result.gemModel.ModelName, 'SSX_Gem_Multiplierx2 (Model 0)');
  assert.equal(result.gemModel.SourceModelName, 'Model 0');
  assert.equal(result.gemModel.AnimTime, 60);
  assert.equal(result.gemModel.ModelObjects[0].IncludeAnimation, true);
  assert.equal(result.gemInstance.InstanceName, 'Gem x2 (Instance 0)');
  assert.equal(result.gemInstance.LTGState, 2);
  assert.equal(result.gemInstance.ModelID, 0);
  assert.equal(result.gemEffects.graphs[0].nodes[0].payload.type0.SubType, 256);
  assert.equal(result.gemEffects.graphs[1].nodes[0].payload.MultiplierScore, 2);
  const files = new Map<string, unknown>([
    ['SSX_FIXTURE/Models.json', { Models: [result.gemModel] }],
    ['SSX_FIXTURE/Instances.json', { Instances: [result.gemInstance] }],
    ['SSX_FIXTURE/Effects.json', result.gemEffects],
  ]);
  const source: MapDataSource = {
    root: '',
    async readJsonOr<T>(path: string, fallback: T) {
      return structuredClone(files.get(path) ?? fallback) as T;
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
    async pathExists(path) {
      return files.has(path);
    },
  };
  const playable = decodeReferenceEffects(await readReferenceEffects(source, 'SSX_FIXTURE'));
  assert(nativeInstanceIsShowoffOnly(playable.instances[0]));
  const animation = animObjectFromGraph(playable.document.graphs[0]);
  assert(animation);
  const playback = createAnimObjectPlayback(animation, result.gemModel.AnimTime);
  assert.equal(stepAnimObjectPlayback(playback, animation, 0.5), 15);
  assert.deepEqual(playable.document.graphs[1].nodes.map(effectPlayCommand), [
    { kind: 'score-multiplier', multiplier: 2 },
    { kind: 'instance-hide', killDetached: false },
  ]);
  const validateSound = new Ajv2020({ strict: false }).compile<Record<string, unknown>>(
    JSON.parse(readFileSync(join(root, 'Snowknife/Snowknife/schemas/course/sound-index-v1.schema.json'), 'utf8')),
  );
  assert(validateSound(result.sounds), JSON.stringify(validateSound.errors));
  assert(!validateSound({ ...result.sounds, ResolverState: undefined }), 'Unresolved routes must be explicit');
  assert(!validateSound({ ...result.sounds, accidentalProperty: true }), 'Sound indexes retain a closed schema');
  console.log(
    'Original SSX Wasm import: gems, animation, alpha, effects, particles, sound assets and fresh cache replacement PASS',
  );
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
