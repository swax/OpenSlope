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
    if (path === '/worker.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(readFileSync(worker));
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
    const courseRequest = db.transaction('courses').objectStore('courses').get('SSX3_A');
    const course = await new Promise<{ files: number }>(resolve => {
      courseRequest.onsuccess = () => resolve(courseRequest.result);
    });
    db.close();
    return {
      courses: scan.courses,
      patches: patches.Patches.length,
      instances: instances.Instances.length,
      texture: patches.Patches[0].TexturePath,
      game: effects.target.game,
      files: course.files,
    };
  }, readFileSync(fixture).toString('base64'));
  assert(result.courses?.includes('SSX3_PEAK1'));
  assert(!result.courses?.includes('SSX3_ALL'));
  assert.equal(result.patches, 1);
  assert.equal(result.instances, 2);
  assert.equal(result.texture, '0000_o.png');
  assert.equal(result.game, 'ssx-3');
  assert(result.files > 15);
  console.log('SSX3 browser Wasm worker: scan, extraction and IndexedDB map publication PASS');
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
