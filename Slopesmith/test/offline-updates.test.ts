/** Real service-worker upgrades: old and new tabs, stable assets, safe reloads and legacy adoption. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { writeOfflineWorker } from '../tools/offline.mjs';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-offline-updates-'));
const dist = join(root, 'dist');
await mkdir(join(dist, 'assets'), { recursive: true });
let failPrecache = false;
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, 'http://localhost').pathname;
  response.setHeader('cache-control', 'no-store');
  if (failPrecache && path === '/stable.txt') {
    response.writeHead(503).end();
    return;
  }
  if (path.startsWith('/api/')) {
    response.end('network only');
    return;
  }
  try {
    const file = /^\/(?:maps|editor)?$/.test(path) ? 'index.html' : path.slice(1);
    response.setHeader(
      'content-type',
      ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<string, string>)[
        extname(file)
      ] ?? 'text/plain',
    );
    response.end(await readFile(join(dist, file)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const context = await browser.newContext();
const errors: string[] = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));

async function publish(version: number, legacy = false) {
  for (const file of await readdir(join(dist, 'assets'))) await rm(join(dist, 'assets', file));
  const entry = `entry-${version}.js`;
  await build({
    stdin: {
      contents: `
        import { prepareOffline, offlineStatus, beforeAppUpdate } from './src/app/offline';
        import { holdUnsavedWork } from './src/app/state/unsaved-work';
        window.work = { draft: false, busy: false, fail: false, saving: false, saves: 0 };
        holdUnsavedWork(() => window.work.draft ? 'the terrain draft' : null);
        beforeAppUpdate(async () => {
          if (window.work.busy) throw new Error('Finish ISO loading first.');
          if (window.work.fail) throw new Error('Save failed.');
          window.work.saves++;
          window.work.saving = true;
          await new Promise(resolve => setTimeout(resolve, 200));
          window.work.saving = false;
          localStorage.setItem('saved-work', String(window.work.saves));
        });
        document.body.append(offlineStatus());
        void prepareOffline();
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    define: { 'import.meta.env.PROD': 'true' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
    outfile: join(dist, 'assets', entry),
  });
  await writeFile(
    join(dist, 'index.html'),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module" src="/assets/${entry}"></script><link rel="stylesheet" href="/assets/entry-${version}.css"></head><body><h1>Release ${version}</h1></body></html>`,
  );
  await writeFile(join(dist, 'stable.txt'), `stable asset ${version}`);
  await writeFile(join(dist, `assets/lazy-${version}.js`), `export default ${version};`);
  await writeFile(
    join(dist, `assets/background-${version}.js`),
    `self.onmessage = async () => self.postMessage(await (await fetch('/stable.txt')).text());`,
  );
  await writeOfflineWorker(dist);
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  const cache = /name="slopesmith-app-cache" content="([^"]+)"/.exec(html)![1];
  const worker = await readFile(join(dist, 'sw.js'), 'utf8');
  await writeOfflineWorker(dist);
  assert.equal(await readFile(join(dist, 'sw.js'), 'utf8'), worker, 'regenerating a release keeps its cache identity');
  if (legacy) {
    const paths = [
      '/index.html',
      '/stable.txt',
      `/assets/${entry}`,
      `/assets/entry-${version}.css`,
      `/assets/lazy-${version}.js`,
      `/assets/background-${version}.js`,
    ];
    // Match the previous production worker: cache-first, no version messages, no forced activation.
    await writeFile(
      join(dist, 'sw.js'),
      `
      const name = ${JSON.stringify(cache)}, paths = ${JSON.stringify(paths)};
      self.addEventListener('install', event => event.waitUntil(caches.open(name).then(cache => cache.addAll(paths))));
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', event => {
        const url = new URL(event.request.url);
        if (url.pathname.startsWith('/api/')) return;
        event.respondWith(caches.open(name).then(async cache => (await cache.match(event.request.mode === 'navigate' ? '/index.html' : url.pathname)) ?? fetch(event.request)));
      });
    `,
    );
  }
  return cache;
}

try {
  const first = await publish(1, true);
  const old = await context.newPage();
  await old.goto(`${origin}/maps`);
  await old.waitForFunction(() => !!navigator.serviceWorker.controller);
  await old.evaluate(() => {
    (window as any).background = new Worker('/assets/background-1.js');
  });
  let oldNavigations = 0;
  old.on('framenavigated', frame => {
    if (frame === old.mainFrame()) oldNavigations++;
  });
  const superseded = await publish(99, true);
  await old.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await old.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
  const second = await publish(2);
  await old.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await old.getByRole('region', { name: 'App update' }).waitFor();
  assert.equal(await old.locator('h1').innerText(), 'Release 1');
  assert.equal(await old.evaluate(async () => (await fetch('/stable.txt')).text()), 'stable asset 1');
  assert.equal(
    await old.evaluate(
      () =>
        new Promise(resolve => {
          const worker = (window as any).background as Worker;
          worker.onmessage = event => resolve(event.data);
          worker.postMessage('read');
        }),
    ),
    'stable asset 1',
    'an existing importer worker retains its release',
  );
  assert.equal(
    await old.evaluate(
      () =>
        new Promise(resolve => {
          const worker = new Worker('/assets/background-1.js');
          worker.onmessage = event => {
            worker.terminate();
            resolve(event.data);
          };
          worker.postMessage('read');
        }),
    ),
    'stable asset 1',
    'a worker started by an older tab inherits that tab’s assets',
  );
  assert.equal(
    await old.evaluate(async () => {
      const path = '/assets/lazy-1.js';
      return (await import(path)).default;
    }),
    1,
    'old lazy chunks survive removal from the server',
  );

  const fresh = await context.newPage();
  await fresh.goto(`${origin}/maps`);
  assert.equal(
    await fresh.locator('h1').innerText(),
    'Release 2',
    'a fresh visit uses the update while the old tab remains open',
  );
  assert.equal(await fresh.evaluate(async () => (await fetch('/stable.txt')).text()), 'stable asset 2');
  // Identifying the new page also reclaims obsolete releases asynchronously.
  await fresh.waitForFunction(async superseded => !(await caches.keys()).includes(superseded), superseded);
  const cdp = await context.newCDPSession(old);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  assert.equal(
    await old.evaluate(async () => (await fetch('/stable.txt')).text()),
    'stable asset 1',
    'client release bindings survive worker suspension',
  );
  await cdp.detach();

  const reload = old.getByRole('button', { name: 'Reload to update', exact: true });
  await old.evaluate(() => {
    (window as any).work.draft = true;
  });
  await reload.click();
  await old.getByRole('alert').filter({ hasText: 'terrain draft' }).waitFor();
  await old.evaluate(() => {
    (window as any).work.draft = false;
    (window as any).work.busy = true;
  });
  await reload.click();
  await old.getByRole('alert').filter({ hasText: 'Finish ISO loading' }).waitFor();
  await old.evaluate(() => {
    (window as any).work.busy = false;
    (window as any).work.fail = true;
  });
  await reload.click();
  await old.getByRole('alert').filter({ hasText: 'Save failed' }).waitFor();
  assert.equal(oldNavigations, 0, 'updates neither reload automatically nor abandon blocked work');
  await old.evaluate(() => {
    (window as any).work.fail = false;
  });
  await old.setViewportSize({ width: 320, height: 700 });
  assert(await old.evaluate(() => document.querySelector('.app-update')!.getBoundingClientRect().right <= innerWidth));
  await old.screenshot({ path: join(root, 'update-ready-mobile.png') });
  await reload.click();
  await old.locator('h1').filter({ hasText: 'Release 2' }).waitFor();
  assert.equal(
    await old.evaluate(() => localStorage.getItem('saved-work')),
    '2',
    'save preparation finishes before the reload',
  );
  assert.equal(
    await old.getByRole('region', { name: 'App update' }).count(),
    0,
    'the current release does not keep prompting',
  );
  assert.equal(await fresh.locator('h1').innerText(), 'Release 2');
  await old.waitForFunction(async first => !(await caches.keys()).includes(first), first);

  failPrecache = true;
  await publish(3);
  await old.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await old.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration())?.installing);
  assert(await old.evaluate(async second => (await caches.keys()).includes(second), second));
  assert.equal(await old.evaluate(async () => (await fetch('/stable.txt')).text()), 'stable asset 2');
  assert.equal(
    await old.getByRole('region', { name: 'App update' }).count(),
    0,
    'a failed download cannot offer an incomplete release',
  );
  await context.setOffline(true);
  await old.reload();
  assert.equal(await old.locator('h1').innerText(), 'Release 2');
  assert.deepEqual(errors, []);
  console.log(
    `OFFLINE UPDATES PASS: legacy migration, independent tabs, retained lazy/stable assets, worker restart, safe reload and failed downloads. Artifacts: ${root}`,
  );
} catch (error) {
  for (const page of context.pages())
    await page.screenshot({ path: join(root, `failure-${context.pages().indexOf(page)}.png`) }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
