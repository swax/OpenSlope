import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-library-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const gba = join(root, 'tricky.gba');
execFileSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    '-c',
    'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from ssx_gba_import_test import rom;Path(sys.argv[2]).write_bytes(rom())',
    resolve('../Native/tests'),
    gba,
  ],
  { windowsHide: true },
);
const api = await startApiService({ port: 0, host: '127.0.0.1' });
const mountain = defaultMountain();
await fetch(`${api.url}/api/projects`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'PRIVATE_LINES', document: mountain }),
});
const courses = [
  ['TRICKY_GARI', 'Garibaldi'],
  ['TRICKY_SNOW', 'Snowdream'],
  ['SSX_SNOW', 'Snowdream'],
  ['SSX3_PEAK1', 'Peak One'],
  ['SSXOT_SNOW', 'On Tour'],
  ['AVALANCHE_CRS00_00', 'Crystal Lake'],
  ['MADTRIX_AN_ANTARTICA', 'Antarctica'],
  ['SSXGBA_GARIBALDI', 'Garibaldi'],
].map(([id, name]) => ({ id, name, kind: 'reference', source: 'server', retailData: true, isoCourses: [id] }));
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/public/courses', route => route.fulfill({ json: { courses } }));
page.setDefaultTimeout(30_000);
try {
  await page.goto(origin + '/');
  await page.getByRole('heading', { name: 'Map library', exact: true }).waitFor();
  await page.getByRole('article', { name: 'PRIVATE LINES', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'ISO', exact: true }).count(),
    0,
  );
  assert.equal(await page.getByRole('region', { name: 'Disc game support' }).getByRole('button').count(), 7);
  assert(await page.getByRole('button', { name: 'Open mountain folder…', exact: true }).isVisible());
  await page.locator('.public-users-toggle').click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.public-community-panel.is-open')?.getBoundingClientRect();
    const library = document.querySelector('.map-library')?.getBoundingClientRect();
    return panel && library && library.right <= panel.left + 1;
  });
  await page.locator('.public-users-toggle').click();
  const local = await page.evaluate(async () => {
    const path = '/src/app/state/local-projects.ts';
    const { openLocalProjects } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../src/app/state/local-projects');
    const workspace = await openLocalProjects();
    const created = await workspace.createNew();
    workspace.close();
    return created.project;
  });
  assert(local.id);
  await page.reload();
  await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).waitFor();
  await page.locator('.public-course[data-course="SSXGBA_GARIBALDI"]').waitFor();
  const search = page.getByRole('searchbox', { name: 'Search maps' });
  await search.fill('GBA');
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 1);
  await search.fill('garibaldi');
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 2);
  await search.fill('');
  await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('device');
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 1);
  await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Custom maps', exact: true }).click();
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 2);
  await page.getByRole('button', { name: 'All maps', exact: true }).click();
  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await page.reload();
  assert.equal(await page.locator('.map-library').getAttribute('data-layout'), 'cards');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.locator('#public-iso').setInputFiles(gba);
  await page.locator('.public-iso-status').filter({ hasText: '8 maps found' }).waitFor({ timeout: 90_000 });
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(new URL(page.url()).searchParams.get('game'), 'tricky-gba');
  const game = page.getByRole('button', { name: 'SSX Tricky (GBA)', exact: true });
  assert.equal(await game.getAttribute('aria-pressed'), 'true');
  const card = page.locator('.public-iso-map[data-course="SSXGBA_GARIBALDI"]');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.evaluate(`(() => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    Object.defineProperty(navigator.storage, 'persist', {configurable:true,value:async()=>{await waiting;return true;}});
    window.releaseLibraryImport = release;
  })()`);
  const geometry = () =>
    page.locator('.public-iso-map').evaluateAll(rows =>
      rows.map(row => {
        const { x, y, width, height } = row.getBoundingClientRect();
        return { x, y: y + scrollY + document.body.scrollTop, width, height };
      }),
    );
  const beforeImport = await geometry();
  await card.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  assert.deepEqual(await geometry(), beforeImport, 'loading keeps list rows stable');
  await page.evaluate(() => (window as typeof window & { releaseLibraryImport: () => void }).releaseLibraryImport());
  await card.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor({ timeout: 90_000 });
  assert.deepEqual(await geometry(), beforeImport, 'loaded actions keep list rows stable');
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(
    new URL(
      (await card.getByRole('link', { name: 'Play Garibaldi', exact: true }).getAttribute('href'))!,
    ).searchParams.get('source'),
    'iso',
  );
  await search.fill('snowdream');
  assert.equal(await page.locator('.public-iso-map:visible').count(), 1);
  await search.fill('not a course');
  await page.getByText('No courses match “not a course”.', { exact: true }).waitFor();
  await search.fill('');
  await page.getByRole('heading', { name: 'Map library', exact: true }).click();
  await page.screenshot({ path: join(root, 'library-game-desktop.png') });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await page.screenshot({ path: join(root, 'library-game-mobile.png') });
  await page.goto(origin + '/isos');
  await page.getByRole('heading', { name: 'Map library', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await page.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor();
  await page.goto(origin + '/maps');
  await page.getByRole('heading', { name: 'Map library', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(root, 'library-all-desktop.png') });
  assert.deepEqual(errors, []);
  console.log(
    'MAP LIBRARY PASS: root and legacy links, games, duplicate names, source/search/layout filters, local/private maps, real GBA import, reload and responsive layouts. ' +
      root,
  );
} catch (error) {
  await page.screenshot({ path: join(root, 'failure.png') });
  console.error(root, errors);
  throw error;
} finally {
  await browser.close();
  void vite.close();
  void api.close();
}
process.exit(0);
