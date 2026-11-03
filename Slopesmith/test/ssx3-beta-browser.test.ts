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

const work = mkdtempSync(join(tmpdir(), 'slopesmith-ssx3-beta-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(work, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(work, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const fixture = process.env.SLOPESMITH_SSX3_BETA_ISO ?? join(work, 'preview.iso');
if (!process.env.SLOPESMITH_SSX3_BETA_ISO)
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [resolve('../Native/tests/ssx3_beta_import_test.py'), '--fixture', fixture],
    { windowsHide: true },
  );
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript('globalThis.__name = fn => fn;');
page.setDefaultTimeout(120_000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const address = vite.httpServer!.address();
  assert(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/isos`);
  await page.locator('#public-iso').setInputFiles(fixture);
  await page.locator('.public-iso-status').filter({ hasText: 'maps found' }).waitFor();
  assert((await page.getByRole('button', { name: 'SSX 3 Beta', exact: true }).getAttribute('aria-pressed')) === 'true');
  const card = page.locator('.public-iso-map[data-course="SSX3B_ARA1"]');
  await card.waitFor();
  const advanced = page.getByRole('checkbox', { name: 'Show all SSX 3 Beta map types', exact: true });
  const defaults = await page.locator('.public-iso-map').count();
  await advanced.check();
  assert((await page.locator('.public-iso-map').count()) > defaults);
  await advanced.uncheck();
  await card.locator('.public-iso-map-actions button').first().click();
  await page.locator('.public-iso-map[data-course="SSX3B_ARA1"][data-state="loaded"]').waitFor();
  const metadata = await page.evaluate(async () => {
    const cachePath = '/src/app/public/iso-cache.ts';
    const { readCachedCourse, cachedIsoCourses, needsCollisionSoundUpdate } = await import(
      /* @vite-ignore */ cachePath
    );
    const files: Map<string, Blob> = await readCachedCourse('SSX3B_ARA1');
    const read = async (name: string) => JSON.parse(await files.get(name.toLowerCase())!.text());
    return {
      courses: await cachedIsoCourses(),
      origin: await read('Origin.json'),
      info: await read('Import.json'),
      patches: (await read('Patches.json')).Patches.length,
      needsSound: await needsCollisionSoundUpdate(['SSX3B_ARA1']),
    };
  });
  assert(metadata.courses.includes('SSX3B_ARA1'));
  assert(!metadata.courses.includes('SSX3_ARA1'));
  assert.equal(metadata.origin.Game, 'ssx-3-beta');
  assert.equal(metadata.info.WorldId, 'ssx-3-beta:bam');
  assert(metadata.patches > 0);
  assert.equal(metadata.needsSound, false);
  await page.reload();
  await page.getByRole('button', { name: 'SSX 3 Beta', exact: true }).click();
  await card.getByRole('link', { name: /^Play / }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  await page.evaluate(async () => {
    const path = '/src/app/ride/session.ts';
    const { TestRide } = (await import(/* @vite-ignore */ path)) as typeof import('../src/app/ride/session');
    const start = TestRide.prototype.start;
    TestRide.prototype.start = function (...args) {
      Object.assign(window, { betaRideForTest: this });
      return start.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  if (process.env.SLOPESMITH_SSX3_BETA_ISO) {
    const grounded = await page.evaluate(async () => {
      let count = 0;
      for (let i = 0; i < 40; ++i) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (
          (window as typeof window & { betaRideForTest: import('../src/app/ride/session').TestRide }).betaRideForTest
            .state.grounded
        )
          ++count;
      }
      return count;
    });
    assert(grounded > 0, 'The real preview terrain supports the rider after spawn');
  }
  await page.screenshot({ path: join(work, 'beta-riding.png') });
  assert.deepEqual(errors, []);
  console.log(
    `SSX 3 beta browser discovery, import, persistence and riding passed (${metadata.patches} patches). ${work}`,
  );
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
