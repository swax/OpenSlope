import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { discCourseName } from '../src/core/reference/disc-courses';

const courses = Array.from({ length: 7 }, (_, family) =>
  [0, 1, 2, 3]
    .filter(variant => !((family === 0 && (variant === 1 || variant === 2)) || (family === 6 && variant === 1)))
    .map(variant => `AVALANCHE_CRS0${family}_0${variant}`),
).flat();
const selected = process.argv[3]?.split(',') ?? courses;
const sourceUV = process.argv[4]
  ? (JSON.parse(readFileSync(process.argv[4], 'utf8')) as Record<string, number[][][]>)
  : null;
assert(selected.length && selected.every(course => courses.includes(course)), 'Unknown Avalanche test course');

const root = mkdtempSync(join(tmpdir(), 'slopesmith-avalanche-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const fixture = process.argv[2] ? resolve(process.argv[2]) : join(root, 'authored.rvz');
if (!process.argv[2]) {
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      [
        'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
        'from avalanche_import_test import course_packages,gcm,rvz',
        'Path(sys.argv[2]).write_bytes(rvz(gcm(course_packages()),packing=True))',
      ].join('\n'),
      resolve('../Native/tests'),
      fixture,
    ],
    { windowsHide: true },
  );
}
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 960, height: 680 } });
  await page.addInitScript('globalThis.__name = fn => fn;');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/isos`);
  assert.match((await page.locator('#public-iso').getAttribute('accept')) ?? '', /\.rvz/);
  await page.locator('#public-iso').setInputFiles(fixture);
  await page.locator('.public-iso-status').filter({ hasText: '25 maps found' }).waitFor({ timeout: 120_000 });
  const game = page.getByRole('button', { name: '1080° Avalanche', exact: true });
  assert.equal(await game.getAttribute('aria-pressed'), 'true');
  for (const course of selected) {
    console.log(`AVALANCHE BROWSER CHECK: ${course}`);
    const name = discCourseName(course);
    await page.getByRole('button', { name: `Load ${name}`, exact: true }).click();
    await page.getByRole('button', { name: `Unload ${name}`, exact: true }).waitFor({ timeout: 120_000 });
    const result = await page.evaluate(async course => {
      const request = indexedDB.open('slopesmith-local-disc', 1);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = async (path: string) => {
        const request = db.transaction('files').objectStore('files').get(`${course}/${path.toLowerCase()}`);
        const row = await new Promise<{ blob: Blob }>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!row) throw new Error(`Missing imported ${path}`);
        return JSON.parse(await row.blob.text());
      };
      const patches = await read('Patches.json');
      const paths = await read('AIP.json');
      const report = await read('Import.json');
      db.close();
      const url = '/test/avalanche-play.fixture.ts';
      const { verifyAvalancheRide, verifyAvalancheCollision, verifyAvalancheEnvironment, verifyAvalancheTerrainUV } =
        await import(/* @vite-ignore */ url);
      const triangles = await verifyAvalancheCollision(course);
      if (triangles !== report.CollisionTriangles) throw new Error('Browser Play lost source collision triangles');
      const environment = await verifyAvalancheEnvironment(course);
      if (environment.skyTriangles !== report.Environment.SkyTriangles)
        throw new Error('Browser lost background triangles');
      const uvPatches = verifyAvalancheTerrainUV(patches.Patches);
      return { ...(await verifyAvalancheRide(course, patches.Patches, paths)), uvPatches, triangles, ...environment };
    }, course);
    if (sourceUV) {
      const actual: number[][][] = await page.evaluate(async course => {
        const url = '/src/app/public/iso-cache.ts';
        const { readCachedCourse } = await import(/* @vite-ignore */ url);
        const files = await readCachedCourse(course);
        return JSON.parse(await files.get('patches.json').text()).Patches.map(
          (p: { UVPoints: number[][] }) => p.UVPoints,
        );
      }, course);
      const wanted = sourceUV[course];
      assert.equal(actual.length, wanted.length);
      for (let patch = 0; patch < wanted.length; patch++)
        for (let corner = 0; corner < 4; corner++)
          for (let axis = 0; axis < 2; axis++)
            assert(
              Math.abs(actual[patch][corner][axis] - wanted[patch][corner][axis]) < 1e-9,
              `WASM material UV differs from source on ${course} patch ${patch}`,
            );
    }
    assert(result.grounded > 45, JSON.stringify(result));
    assert(result.skywardFraction > 0.7, 'Terrain must face upward for texture lighting: ' + JSON.stringify(result));
    assert(result.travelled > 1 && result.resetGrounded, JSON.stringify(result));
    assert(result.restartDistance < 2 && result.triangles > 0, JSON.stringify(result));
    await page.getByRole('link', { name: `Play ${name}`, exact: true }).click();
    await page.getByRole('group', { name: 'Play options', exact: true }).waitFor({ timeout: 120_000 });
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Exit play', exact: true }).waitFor({ timeout: 60_000 });
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => {
      for (let i = 0; i < 30; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    const capture = async (name: string) => {
      const path = join(root, `${course}-${name}`);
      await page!.screenshot({ path });
      const image = await loadImage(path),
        canvas = createCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      let terrainPixels = 0;
      for (let y = 220; y < image.height - 180; y++)
        for (let x = 330; x < image.width - 40; x++) {
          if (x > image.width * 0.43 && x < image.width * 0.57) continue; // the avatar cannot satisfy the terrain check
          const at = (y * image.width + x) * 4;
          if (Math.max(data[at], data[at + 1], data[at + 2]) > 90) terrainPixels++;
        }
      assert(terrainPixels > 2000, `Terrain is missing or black in ${name}: ${terrainPixels} visible pixels`);
    };
    await capture('avalanche-riding-before-reset.png');
    await page.keyboard.press('r');
    await page.evaluate(async () => {
      for (let i = 0; i < 30; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    await capture('avalanche-riding.png');
    await page.getByRole('button', { name: 'Exit play', exact: true }).click();
    await page.reload();
    await page.getByRole('group', { name: 'Play options', exact: true }).waitFor({ timeout: 120_000 });
    assert.deepEqual(errors, []);
    console.log(
      `AVALANCHE BROWSER PASS: ${course}; RVZ picker → shared WASM → cache → textured public play; ground, spawn, reset and reload. ${JSON.stringify(result)} Artifacts: ${root}`,
    );
    await page.goto(`${origin}/isos`);
    await page.getByRole('button', { name: `Unload ${name}`, exact: true }).waitFor({ timeout: 120_000 });
  }
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') });
  console.error('Avalanche browser artifacts:', root);
  console.error(
    await page?.locator('.public-iso-status, .public-iso-load-status, .public-player-error').allTextContents(),
  );
  throw error;
} finally {
  await browser?.close();
  await api.close();
  await vite.close();
}
