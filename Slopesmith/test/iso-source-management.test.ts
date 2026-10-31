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

const root = mkdtempSync(join(tmpdir(), 'slopesmith-source-management-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const source = join(root, 'ssx3.iso');
execFileSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    '-c',
    "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from course_titles_test import boot_files,executable;from ssx3_import_test import members;from audio_import_test import disc,archive;Path(sys.argv[2]).write_bytes(disc({'DATA/WORLDS/BAM.BIG':archive(members()),**boot_files(executable(streamed=True))}))",
    resolve('../Native/tests'),
    source,
  ],
  { windowsHide: true },
);
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript('globalThis.__name = fn => fn');
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(origin + '/');
  await page.locator('#public-iso').setInputFiles(source);
  await page
    .locator('.public-iso-status')
    .filter({ hasText: /maps found/ })
    .waitFor({ timeout: 90000 });
  await page.evaluate(async () => {
    const discPath = '/src/app/public/iso-discs.ts',
      cachePath = '/src/app/public/iso-cache.ts';
    const discs = (await import(/* @vite-ignore */ discPath)) as typeof import('../src/app/public/iso-discs');
    const cache = (await import(/* @vite-ignore */ cachePath)) as typeof import('../src/app/public/iso-cache');
    const saved = (await discs.savedIsoDiscs()).find(d => d.game === 'ssx3')!;
    await discs.saveIsoDisc({ ...saved, names: {} });
    await discs.saveIsoDisc({
      game: 'tricky',
      file: new File(['other image'], 'tricky.iso'),
      courses: ['TRICKY_GARI'],
    });
    const db = await cache.openIsoCache();
    try {
      await cache.cacheTransaction(db, 'courses', 'readwrite', store => {
        for (const course of ['SSX3_A', 'TRICKY_GARI', 'AVALANCHE_CRS01_00'])
          store.put({
            course,
            version: cache.isoCourseCacheVersion(course),
            files: course === 'SSX3_A' ? 2 : 1,
            ...(course.startsWith('AVALANCHE') ? { displayName: '1080° Avalanche · Tenderfoot Pass' } : {}),
          });
      });
      await cache.cacheTransaction(db, 'files', 'readwrite', store => {
        store.put({
          key: 'SSX3_A/import.json',
          course: 'SSX3_A',
          path: 'Import.json',
          blob: new Blob([JSON.stringify({ Game: 'ssx-3', Preserved: { value: 42 } })]),
        });
        for (const course of ['SSX3_A', 'TRICKY_GARI', 'AVALANCHE_CRS01_00'])
          store.put({
            key: course + '/geometry.bin',
            course,
            path: 'Geometry.bin',
            blob: new Blob([new Uint8Array([1, 3, 5, 7])]),
          });
      });
    } finally {
      db.close();
    }
  });
  await page.reload();
  await page.getByRole('checkbox', { name: 'Show all SSX 3 map types', exact: true }).check();
  const card = page.locator('.public-iso-map[data-course="SSX3_A"]');
  await card.getByRole('heading', { name: 'A (SSX 3)', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh image', exact: true }).click();
  await card.getByRole('heading', { name: 'Disc Village', exact: true }).waitFor({ timeout: 90000 });
  await page.locator('.public-iso-status').filter({ hasText: 'Course names refreshed' }).waitFor();
  assert(await card.getByRole('link', { name: 'Play Disc Village', exact: true }).isVisible());
  assert.equal(
    new URL(
      (await card.getByRole('link', { name: 'Play Disc Village', exact: true }).getAttribute('href'))!,
    ).searchParams.get('reference'),
    'SSX3_A',
  );
  const refreshed = await page.evaluate(async () => {
    const discPath = '/src/app/public/iso-discs.ts',
      cachePath = '/src/app/public/iso-cache.ts';
    const discs = (await import(/* @vite-ignore */ discPath)) as typeof import('../src/app/public/iso-discs');
    const cache = (await import(/* @vite-ignore */ cachePath)) as typeof import('../src/app/public/iso-cache');
    const files = await cache.readCachedCourse('SSX3_A');
    return {
      metadata: JSON.parse(await files.get('import.json')!.text()),
      geometry: Array.from(new Uint8Array(await files.get('geometry.bin')!.arrayBuffer())),
      name: (await discs.savedIsoDiscs()).find(d => d.game === 'ssx3')!.names!.SSX3_A,
    };
  });
  assert.deepEqual(refreshed, {
    metadata: {
      Game: 'ssx-3',
      Preserved: { value: 42 },
      DisplayName: 'Disc Village',
      MapType: 'hub',
      WorldId: 'ssx-3:bam',
      ParentMap: 'SSX3_PEAK1',
      SourceSections: ['A'],
    },
    geometry: [1, 3, 5, 7],
    name: 'Disc Village',
  });
  await page.screenshot({ path: join(root, 'refreshed-source.png') });
  await page.getByRole('button', { name: 'All maps', exact: true }).click();
  await page.locator('.public-local-maps').getByRole('article', { name: 'Disc Village', exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Disc game support' })
    .getByRole('button', { name: '1080° Avalanche', exact: true })
    .click();
  await page.locator('.public-iso-map').getByRole('heading', { name: 'Tenderfoot Pass', exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Disc game support' })
    .getByRole('button', { name: 'SSX 3', exact: true })
    .click();
  await page.getByRole('checkbox', { name: 'Show all SSX 3 map types', exact: true }).check();
  await page.getByRole('button', { name: 'Remove image…', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove SSX 3 image?', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  assert(await page.getByRole('button', { name: 'Refresh image', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Remove image…', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove SSX 3 image?', exact: true })
    .getByRole('button', { name: 'Remove image', exact: true })
    .click();
  await page.locator('.public-iso-status').filter({ hasText: 'image removed' }).waitFor();
  assert(
    await card.getByRole('link', { name: 'Play Disc Village', exact: true }).isVisible(),
    'Removing the image preserves imported maps',
  );
  await page.reload();
  await page.getByRole('checkbox', { name: 'Show all SSX 3 map types', exact: true }).check();
  await card.getByRole('heading', { name: 'Disc Village', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Refresh image', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Unload game…', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Unload SSX 3?', exact: true })
    .getByRole('button', { name: 'Unload game', exact: true })
    .click();
  await page.locator('.public-iso-status').filter({ hasText: 'SSX 3 unloaded' }).waitFor();
  const remaining = await page.evaluate(async () => {
    const cachePath = '/src/app/public/iso-cache.ts',
      discPath = '/src/app/public/iso-discs.ts';
    const cache = (await import(/* @vite-ignore */ cachePath)) as typeof import('../src/app/public/iso-cache');
    const discs = (await import(/* @vite-ignore */ discPath)) as typeof import('../src/app/public/iso-discs');
    return { courses: (await cache.cachedIsoCourses()).sort(), games: (await discs.savedIsoDiscs()).map(d => d.game) };
  });
  assert.deepEqual(remaining, { courses: ['AVALANCHE_CRS01_00', 'TRICKY_GARI'], games: ['tricky'] });
  await page.locator('#public-iso').setInputFiles(source);
  await page
    .locator('.public-iso-status')
    .filter({ hasText: /maps found/ })
    .waitFor({ timeout: 90000 });
  await page.getByRole('checkbox', { name: 'Show all SSX 3 map types', exact: true }).check();
  await card.getByRole('heading', { name: 'Disc Village', exact: true }).waitFor();
  assert(await card.getByRole('button', { name: 'Load Disc Village', exact: true }).isEnabled());
  await page.setViewportSize({ width: 375, height: 900 });
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(
    'SOURCE MANAGEMENT PASS: stale SSX 3 names, live relabeling, persistent metadata-only refresh, Avalanche labels, remove/cancel, scoped unload, reload and mobile layout. ' +
      root,
  );
} catch (error) {
  await page.screenshot({ path: join(root, 'failure.png') });
  console.error('Source management artifacts:', root);
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
