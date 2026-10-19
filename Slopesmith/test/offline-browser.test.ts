/** Production-only offline contract: cold Chrome starts, lazy chunks, local assets, ISO WASM and safe updates. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { defaultMountain } from '../src/core/doc/mountain';
import { createMountainArchive, readMountainArchive } from '../src/app/mountain/archive';
import type { ProjectBundle } from '../src/core/project/transfer';
import { encodePng } from '../src/server/routes/png';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-offline-'));
const dist = join(root, 'dist');
await build({ root: process.cwd(), logLevel: 'error', build: { outDir: dist, emptyOutDir: true } });
const iso = join(root, 'fixture.iso');
execFileSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    '-c',
    [
      'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
      'from import_test import iso,big,course_members,record',
      "archive=big({name.replace('fixture','gari'):data for name,data in course_members().items()})",
      'image=iso(archive)',
      "rows=record(b'\\0',26,2048,True)+record(b'\\1',26,2048,True)+record('GARI.BIG;1',28,len(archive))",
      'image[26*2048:27*2048]=rows+bytes(2048-len(rows))',
      'Path(sys.argv[2]).write_bytes(image)',
    ].join('\n'),
    resolve('../Native/tests'),
    iso,
  ],
  { windowsHide: true },
);

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const apiRequests: string[] = [];
let failPrecache = false;
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  if (failPrecache && path.endsWith('.wasm')) {
    res.statusCode = 503;
    res.end();
    return;
  }
  if (path.startsWith('/api/')) {
    apiRequests.push(`${req.method} ${path}`);
    res.setHeader('content-type', 'application/json');
    if (path === '/api/auth/session') res.end(JSON.stringify({ accounts: 'required' }));
    else if (path === '/api/play/config') res.end(JSON.stringify({ enabled: false }));
    else if (path === '/api/public/courses') res.end(JSON.stringify({ courses: [] }));
    else {
      res.statusCode = 503;
      res.end('{}');
    }
    return;
  }
  try {
    const file = /^\/(?:$|maps\/?$|isos\/?$|(?:editor|play)(?:\/|$))/.test(path) ? 'index.html' : path.slice(1);
    const bytes = await readFile(join(dist, file));
    res.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
    res.end(bytes);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const profile = join(root, 'chrome');
let context: BrowserContext | undefined;
let page: Page | undefined;
const errors: string[] = [];
const watchdog = setTimeout(() => {
  console.error(`Offline test timed out. Artifacts: ${root}`);
  process.exit(1);
}, 180_000);
async function launch(offline: boolean) {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumExecutable(),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  await context.setOffline(offline);
  page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', error => errors.push(error.message));
  return page;
}
async function editorReady() {
  await page!.waitForFunction(() => document.documentElement.dataset.projectSave === 'saved', undefined, {
    timeout: 30_000,
  });
  await page!.locator('#load-status').waitFor({ state: 'hidden' });
}
async function fileAction(label: string) {
  await page!.getByRole('button', { name: 'File menu', exact: true }).click();
  await page!.getByRole('button', { name: label, exact: true }).click();
}
try {
  await launch(false);
  await page!.goto(`${origin}/maps`);
  await page!.waitForFunction(
    () => !!navigator.serviceWorker.controller && document.querySelector<HTMLElement>('[data-offline-status]')?.dataset.state === 'ready',
  );
  const offlineStatus = page!.locator('.public-about-panel [data-offline-status]');
  assert.equal(await page!.locator('#offline-status').count(), 0, 'offline setup creates no bottom overlay');
  assert(await offlineStatus.isHidden(), 'readiness stays inside the closed info panel');
  await page!.getByRole('button', { name: 'About Slopesmith', exact: true }).click();
  assert(await offlineStatus.isVisible());
  assert.equal(await offlineStatus.innerText(), 'Ready for offline use');
  await page!.getByRole('button', { name: 'About Slopesmith', exact: true }).press('Escape');
  assert(await offlineStatus.isHidden());
  assert.deepEqual(
    await page!.evaluate(async () => {
      const keys = await caches.keys();
      const cache = await caches.open(keys.find(key => key.startsWith('slopesmith-app-'))!);
      return (await cache.keys())
        .filter(request => new URL(request.url).pathname.startsWith('/api/'))
        .map(request => request.url);
    }),
    [],
    'the app cache contains no API or account responses',
  );
  const onlineRequests = apiRequests.length;
  await context!.setOffline(true);
  // The editor and player have not been visited: their lazy chunks must already be in the app cache.
  await page!.getByRole('link', { name: 'New map', exact: true }).click();
  await editorReady();
  const mountain = defaultMountain();
  mountain.name = 'OFFLINE_RUN';
  mountain.quadTex = { 0: 'Custom/snow.png' };
  const art = Buffer.from(encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }));
  const hash = createHash('sha256').update(art).digest('hex');
  const bundle: ProjectBundle = {
    kind: 'slopesmith-project',
    schema: 1,
    name: mountain.name,
    revision: 0,
    takenAt: new Date().toISOString(),
    document: mountain,
    assets: [{ kind: 'texture', name: 'snow.png', hash, size: art.length }],
    blobs: { [hash]: art.toString('base64') },
    missing: [],
  };
  const archive = createMountainArchive(bundle);
  const chooser = page!.waitForEvent('filechooser');
  await fileAction('Import mountain…');
  await (
    await chooser
  ).setFiles({
    name: 'offline.slopesmith.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await archive.blob.arrayBuffer()),
  });
  await page!.getByRole('button', { name: 'Import', exact: true }).click();
  await page!.waitForFunction(() => document.title === 'OFFLINE_RUN - Slopesmith');
  await editorReady();
  const editorUrl = page!.url();
  const id = new URL(editorUrl).searchParams.get('local')!;
  const playerUrl = `${origin}/play/OFFLINE_RUN?${new URLSearchParams({ local: id })}`;
  await fileAction('Rename mountain…');
  await page!.locator('.sp-ask input').fill('OFFLINE_SAVED');
  await page!.getByRole('button', { name: 'Rename', exact: true }).click();
  await page!.waitForFunction(() => document.title === 'OFFLINE_SAVED - Slopesmith');
  await editorReady();
  const savedEditorUrl = page!.url();
  const download = page!.waitForEvent('download');
  await fileAction('Export mountain…');
  const exported = await readMountainArchive(new Blob([readFileSync((await (await download).path())!)]));
  assert.equal(exported.document.name, 'OFFLINE_SAVED');
  assert.equal(exported.blobs?.[hash], art.toString('base64'), 'custom art survives offline edits and export');
  await page!.goto(playerUrl);
  await page!.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert(await page!.getByRole('button', { name: 'Edit map', exact: true }).isVisible());
  assert.equal(await page!.getByRole('button', { name: 'Inspect map', exact: true }).count(), 0);
  await page!.getByRole('button', { name: 'Play', exact: true }).click();
  await page!.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  console.log('OFFLINE: editor/import/save/export and solo player passed');

  await page!.goto(`${origin}/isos`);
  await page!.locator('#public-iso').setInputFiles(iso);
  await page!.locator('.public-iso-status').filter({ hasText: '1 map found' }).waitFor();
  await page!.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  await page!.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor();
  const isoCard = page!.locator('.public-iso-map[data-course="GARI"]');
  assert.equal(await isoCard.locator('.public-primary').count(), 1);
  assert(await isoCard.getByRole('link', { name: 'Play Garibaldi', exact: true }).evaluate(el => el.classList.contains('public-primary')));
  assert.equal(await isoCard.getByRole('button', { name: 'Unload Garibaldi', exact: true }).evaluate(el => el.classList.contains('public-primary')), false);
  const isoUrl = await page!.getByRole('link', { name: 'Play Garibaldi', exact: true }).getAttribute('href');
  await page!.goto(isoUrl!);
  await page!.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert(await page!.getByRole('button', { name: 'Inspect map', exact: true }).isVisible());
  assert.equal(await page!.getByRole('button', { name: 'Edit map', exact: true }).count(), 0);
  await page!.getByRole('button', { name: 'Play', exact: true }).click();
  await page!.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  console.log('OFFLINE: WASM ISO scan/extract and ISO player passed');
  assert.equal(
    apiRequests.length,
    onlineRequests,
    'offline editing, exports, importing and riding make no server requests',
  );

  await context!.close();
  await launch(true);
  await page!.goto(origin);
  await page!.getByRole('link', { name: 'Play OFFLINE_SAVED', exact: true }).waitFor();
  await page!.getByRole('button', { name: 'About Slopesmith', exact: true }).click();
  await page!.locator('[data-offline-status][data-state=ready]').waitFor();
  assert.equal(await page!.locator('[data-offline-status]').innerText(), 'Ready for offline use');
  await page!.getByRole('button', { name: 'About Slopesmith', exact: true }).press('Escape');
  await page!.goto(`${origin}/editor/OFFLINE_SAVED`);
  await editorReady();
  assert.equal(new URL(page!.url()).searchParams.get('local'), id, 'a plain editor bookmark opens the saved local map');
  await page!.goto(savedEditorUrl);
  await editorReady();
  assert.equal(await page!.title(), 'OFFLINE_SAVED - Slopesmith');
  await page!.goto(playerUrl);
  await page!.getByRole('button', { name: 'Play', exact: true }).waitFor();
  await page!.goto(isoUrl!);
  await page!.getByRole('button', { name: 'Play', exact: true }).waitFor();
  await page!.getByRole('button', { name: 'Inspect map', exact: true }).click();
  await editorReady();
  assert.match(new URL(page!.url()).pathname, /^\/editor(?:\/|$)/);
  assert.equal(new URL(page!.url()).searchParams.get('reference'), 'GARI');
  await page!.goto(`${origin}/maps`);
  await page!.getByRole('link', { name: 'Play OFFLINE_SAVED', exact: true }).waitFor();
  await page!.getByRole('button', { name: 'Play Garibaldi', exact: true }).waitFor();
  const savedCard = page!.getByRole('article', { name: 'OFFLINE_SAVED', exact: true });
  assert.equal(await savedCard.locator('.public-primary').count(), 1);
  assert.equal(await savedCard.getByRole('link', { name: 'Edit OFFLINE_SAVED', exact: true }).evaluate(el => el.classList.contains('public-primary')), false);
  await savedCard.click({ position: { x: 12, y: 12 } });
  await page!.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert.equal(new URL(page!.url()).pathname, '/play/OFFLINE_SAVED');
  assert.equal(new URL(page!.url()).searchParams.get('local'), id);
  await page!.getByRole('button', { name: 'Edit map', exact: true }).click();
  await editorReady();
  assert.equal(new URL(page!.url()).pathname, '/editor/OFFLINE_SAVED');
  assert.equal(new URL(page!.url()).searchParams.get('local'), id);
  await page!.goto(`${origin}/editor?reference=GARI`);
  await editorReady();
  assert.deepEqual(errors, []);

  // A failed download must leave the current release and all local work usable.
  await context!.setOffline(false);
  const originalWorker = readFileSync(join(dist, 'sw.js'), 'utf8');
  failPrecache = true;
  writeFileSync(join(dist, 'sw.js'), originalWorker.replace(/slopesmith-app-([a-f0-9]+)/g, 'slopesmith-app-broken-$1'));
  await page!.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await page!.waitForFunction(
    async () =>
      !(await navigator.serviceWorker.getRegistration())?.installing &&
      (await caches.keys()).filter(key => key.startsWith('slopesmith-app-')).length === 1,
  );
  await context!.setOffline(true);
  await page!.goto(savedEditorUrl);
  await editorReady();
  failPrecache = false;

  // A new release installs beside an open editor, without taking it over or clearing its saved maps.
  await context!.setOffline(false);
  const worker = originalWorker.replace(/slopesmith-app-([a-f0-9]+)/g, 'slopesmith-app-update-$1');
  writeFileSync(join(dist, 'sw.js'), worker);
  await page!.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await page!.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
  assert.equal(
    await page!.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('slopesmith-app-')).length),
    2,
  );
  await context!.close();
  await launch(false);
  await page!.goto(`${origin}/maps`);
  await page!.waitForFunction(
    async () => (await caches.keys()).filter(key => key.startsWith('slopesmith-app-')).length === 1,
  );
  await context!.setOffline(true);
  await page!.goto(savedEditorUrl);
  await editorReady();
  console.log(
    `OFFLINE BROWSER PASS: cold Chrome reopen, local maps/art, ISO maps/importer, solo riding and deferred updates. Artifacts: ${root}`,
  );
} catch (error) {
  console.error(
    error,
    errors,
    await page
      ?.locator('body')
      .innerText()
      .catch(() => ''),
  );
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  clearTimeout(watchdog);
}
