import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-iso-library-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const tricky = join(root, 'tricky.iso');
const ssx = join(root, 'ssx.iso');
execFileSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    '-c',
    [
      'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
      'from audio_import_test import disc',
      'from import_test import big,course_members,iso',
      'from ssx_import_test import members',
      "files={f'DATA/MODELS/{slot.upper()}.BIG':big({name.replace('fixture',slot):data for name,data in course_members().items()}) for slot in ['gari','snow']}",
      'Path(sys.argv[2]).write_bytes(disc(files))',
      'Path(sys.argv[3]).write_bytes(iso(big(members(),compact=False)))',
    ].join('\n'),
    resolve('../Native/tests'),
    tricky,
    ssx,
  ],
  { windowsHide: true },
);
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Browser | undefined;
let page: Page | undefined;
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/isos`);
  const games = page.getByRole('region', { name: 'Disc game support', exact: true });
  const trickyGame = games.getByRole('button', { name: 'SSX Tricky', exact: true });
  const ssxGame = games.getByRole('button', { name: 'SSX', exact: true });
  await trickyGame.waitFor();
  assert(await trickyGame.isDisabled());
  assert(await ssxGame.isDisabled());
  const actions = await page.locator('.public-iso-actions').boundingBox();
  const gameBounds = await games.boundingBox();
  assert(actions && gameBounds && gameBounds.y >= actions.y + actions.height, 'games sit below Load ISO');

  await page.locator('#public-iso').setInputFiles(tricky);
  await page.locator('.public-iso-status').filter({ hasText: '2 maps found' }).waitFor();
  assert(await trickyGame.isEnabled());
  assert(await ssxGame.isDisabled());
  assert.equal(await trickyGame.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(
    await page
      .locator('.public-iso-map')
      .evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.course).sort()),
    ['GARI', 'SNOW'],
  );
  await page.locator('#public-iso').setInputFiles(ssx);
  await page.locator('.public-iso-status').filter({ hasText: '1 map found' }).waitFor();
  assert(await trickyGame.isEnabled());
  assert(await ssxGame.isEnabled());
  assert.equal(await ssxGame.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.public-iso-map').count(), 1);
  assert.equal(await page.locator('.public-iso-map').getAttribute('data-course'), 'SSX_FIXTURE');
  await trickyGame.click();
  assert.equal(await page.locator('.public-iso-map').count(), 2, 'switching games restores that disc’s maps');
  await page.getByRole('link', { name: 'Maps', exact: true }).click();
  await page.getByRole('heading', { name: 'Maps', exact: true }).waitFor();
  await page.getByRole('link', { name: 'ISO', exact: true }).click();
  await trickyGame.waitFor();
  assert.equal(await trickyGame.getAttribute('aria-pressed'), 'true');
  assert(
    await page.getByRole('button', { name: 'Load Garibaldi', exact: true }).isEnabled(),
    'the saved ISO can extract more maps after navigation',
  );
  assert.match(await games.innerText(), /tricky.iso/);
  assert.match(await games.innerText(), /ssx.iso/);
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(root, 'saved-disc-library.png') });

  // Queue one real native extraction from each restored disc, switching games while the first is active.
  await page.evaluate(`(() => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    Object.defineProperty(navigator.storage, 'persist', {
      configurable: true, value: async () => { await waiting; return true; }
    });
    window.releaseIsoImports = release;
  })()`);
  await page.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  await ssxGame.click();
  await page.getByRole('button', { name: 'Load SSX_FIXTURE', exact: true }).click();
  assert.equal(await page.locator('.public-iso-map').getAttribute('data-state'), 'queued');
  await page.evaluate(() => (window as unknown as { releaseIsoImports: () => void }).releaseIsoImports());
  await page.locator('.public-iso-map .public-iso-badge.loaded').waitFor({ timeout: 90_000 });
  await page.getByText('2 loaded', { exact: true }).waitFor();
  await trickyGame.click();
  assert(await page.getByRole('button', { name: 'Unload Garibaldi', exact: true }).isEnabled());
  assert(await page.getByRole('button', { name: 'Load Snowdream', exact: true }).isEnabled());
  await ssxGame.click();
  await page.reload();
  await ssxGame.waitFor();
  assert.equal(await ssxGame.getAttribute('aria-pressed'), 'true', 'the selected game survives reload');
  assert(await page.getByRole('button', { name: 'Unload SSX_FIXTURE', exact: true }).isEnabled());
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'the game selector fits mobile screens');
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(root, 'saved-disc-library-mobile.png') });
  const secondTab = await context.newPage();
  await secondTab.goto(`${origin}/isos`);
  const otherGames = secondTab.getByRole('region', { name: 'Disc game support', exact: true });
  assert(await otherGames.getByRole('button', { name: 'SSX Tricky', exact: true }).isEnabled());
  assert(
    await otherGames.getByRole('button', { name: 'SSX', exact: true }).isEnabled(),
    'saved discs are available in another browser tab',
  );
  await secondTab.close();
  await page.getByRole('button', { name: 'Clear all ISO maps', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Unload all ISO maps?', exact: true })
    .getByRole('button', { name: 'Unload all maps', exact: true })
    .click();
  await page.getByText('0 loaded', { exact: true }).waitFor();
  assert(await trickyGame.isDisabled());
  assert(await ssxGame.isDisabled());
  await page.reload();
  await trickyGame.waitFor();
  assert(await trickyGame.isDisabled());
  assert(await ssxGame.isDisabled());
  assert.equal(
    await page.locator('.public-iso-map').count(),
    0,
    'Clear all removes saved discs as well as extracted maps',
  );
  assert.deepEqual(errors, []);
  console.log(
    `ISO LIBRARY PASS: game switching, native imports from multiple saved discs, navigation/reload/new-tab persistence, mobile layout and clearing. Screenshots: ${root}`,
  );
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') });
  console.error('ISO library artifacts:', root);
  console.error(await page?.locator('.public-iso-status, .public-iso-load-status').allTextContents());
  throw error;
} finally {
  await browser?.close();
  await api.close();
  await vite.close();
}
