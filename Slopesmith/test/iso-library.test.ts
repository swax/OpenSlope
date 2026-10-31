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
import { isoCourseCacheVersion } from '../src/app/public/iso-cache';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-iso-library-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const tricky = join(root, 'tricky.iso');
const ssx = join(root, 'ssx.iso');
const madtrix = join(root, 'madtrix.bin');
const gba = join(root, 'ssx-tricky.gba');
execFileSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    '-c',
    [
      'import sys,struct; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
      'from audio_import_test import disc',
      'from import_test import big,course_members,iso',
      'from ssx_import_test import members',
      'from madtrix_import_test import package,members as madtrix_members,name_hash,raw_bin,BOOT,music_bank',
      "files={f'DATA/MODELS/{slot.upper()}.BIG':big({name.replace('fixture',slot):data for name,data in course_members().items()}) for slot in ['gari','snow']}",
      'Path(sys.argv[2]).write_bytes(disc(files))',
      'Path(sys.argv[3]).write_bytes(iso(big(members(),compact=False)))',
      "name='AN_antartica.pak'; pak=package(madtrix_members(sky=True,keyed=True,rails=True,signs=True,audio=True,waterfalls=True))",
      "index_size,strings_size,data_size=struct.unpack_from('<3I',pak,len(pak)-12)",
      "manifest=name.encode().ljust(64,b'\\0')+struct.pack('<4I',name_hash(name),data_size,index_size,strings_size)",
      "Path(sys.argv[4]).write_bytes(raw_bin(disc({BOOT:b'fixture','DATA/E942715C.DAT':manifest,f'DATA/{name_hash(name):X}.DAT':pak,'MUSIC/MUSIC.MET':music_bank()})))",
      'from ssx_gba_import_test import rom as gba_rom',
      'Path(sys.argv[5]).write_bytes(gba_rom(unpaired=True))',
    ].join('\n'),
    resolve('../Native/tests'),
    tricky,
    ssx,
    madtrix,
    gba,
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
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    const starts: number[] = [];
    const gbaStarts: number[] = [];
    Object.assign(window, { madtrixMusicStarts: starts, gbaMusicStarts: gbaStarts });
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<AudioBufferSourceNode['start']>) {
      const duration = this.buffer?.duration ?? 0;
      if (gbaStarts.length < 2000 && !this.loop && Math.abs(duration - 276 / 10512) < 0.001) gbaStarts.push(duration);
      if (starts.length < 2000 && (Math.abs(duration - 3.997) < 0.001 || Math.abs(duration - 2800 / 44100) < 0.001))
        starts.push(duration);
      return original.apply(this, args);
    };
  });
  const errors: string[] = [];
  const invalidLightmapRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/lightmap' && url.searchParams.get('id') === '-1')
      invalidLightmapRequests.push(request.url());
  });
  await page.goto(`${origin}/isos`);
  const games = page.getByRole('region', { name: 'Disc game support', exact: true });
  const trickyGame = games.getByRole('button', { name: 'SSX Tricky', exact: true });
  const ssxGame = games.getByRole('button', { name: 'SSX', exact: true });
  const madtrixGame = games.getByRole('button', { name: 'Jonny Moseley Mad Trix', exact: true });
  const gbaGame = games.getByRole('button', { name: 'SSX Tricky (GBA)', exact: true });
  await trickyGame.waitFor();
  assert(await page.getByRole('heading', { name: 'Map library', exact: true }).isVisible());
  assert(await trickyGame.isEnabled());
  assert(await ssxGame.isEnabled());
  assert(await madtrixGame.isEnabled());
  assert.equal(await games.getByText('No disc selected', { exact: true }).count(), 7);
  const filters = page.getByRole('group', { name: 'Filter ISO maps', exact: true });
  assert(await filters.isHidden());
  const sidebar = await page.locator('.library-sidebar').boundingBox();
  const workspace = await page.locator('.library-workspace').boundingBox();
  assert(sidebar && workspace && sidebar.x + sidebar.width < workspace.x, 'games sit beside the course library');

  await page.locator('#public-iso').setInputFiles(tricky);
  await page.locator('.public-iso-status').filter({ hasText: '2 maps found' }).waitFor();
  assert(await trickyGame.isEnabled());
  assert(await ssxGame.isEnabled());
  assert.equal(await trickyGame.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(
    await page
      .locator('.public-iso-map')
      .evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.course).sort()),
    ['TRICKY_GARI', 'TRICKY_SNOW'],
  );
  const trickyCard = page.locator('.public-iso-game-card').filter({
    has: page.getByRole('button', { name: 'SSX Tricky', exact: true }),
  });
  assert.match((await trickyCard.getAttribute('title'))!, /0 of 2 maps loaded/);
  assert.match((await trickyCard.getAttribute('title'))!, /Disc saved · tricky.iso/);
  assert.equal(await page.locator('.public-iso-map .public-iso-badge.missing').count(), 2);
  assert.equal(await page.locator('.public-iso-map .public-iso-open:visible').count(), 0);
  await filters.getByRole('button', { name: 'Loaded (0)', exact: true }).click();
  assert.equal(await page.locator('.public-iso-map:visible').count(), 0);
  assert(await page.getByText(/No loaded maps for this game\./).isVisible());
  await filters.getByRole('button', { name: 'Not loaded (2)', exact: true }).click();
  assert.equal(await page.locator('.public-iso-map:visible').count(), 2);
  await page.locator('#public-iso').setInputFiles(ssx);
  await page.locator('.public-iso-status').filter({ hasText: '1 map found' }).waitFor();
  assert(await trickyGame.isEnabled());
  assert(await ssxGame.isEnabled());
  assert.equal(await ssxGame.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.public-iso-map').count(), 1);
  assert.equal(await page.locator('.public-iso-map').getAttribute('data-course'), 'SSX_FIXTURE');
  await page.locator('#public-iso').setInputFiles(madtrix);
  await page.locator('.public-iso-status').filter({ hasText: 'madtrix.bin · 1 map found' }).waitFor();
  assert(await madtrixGame.isEnabled());
  assert.equal(await madtrixGame.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.public-iso-map').getAttribute('data-course'), 'MADTRIX_AN_ANTARTICA');
  assert(await page.getByRole('button', { name: 'Load Antarctica (Mad Trix)', exact: true }).isEnabled());
  assert.match(
    await games
      .locator('.public-iso-game-card')
      .evaluateAll(cards => cards.map(card => card.getAttribute('title')).join(' ')),
    /11 courses · Preliminary support/,
  );
  await trickyGame.click();
  assert.equal(await page.locator('.public-iso-map').count(), 2, 'switching games restores that disc’s maps');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('heading', { name: 'Map library', exact: true }).waitFor();
  await trickyGame.click();
  await trickyGame.waitFor();
  assert.equal(await trickyGame.getAttribute('aria-pressed'), 'true');
  assert(
    await page.getByRole('button', { name: 'Load Garibaldi', exact: true }).isEnabled(),
    'the saved ISO can extract more maps after navigation',
  );
  assert.match(
    await games
      .locator('.public-iso-game-card')
      .evaluateAll(cards => cards.map(card => card.getAttribute('title')).join(' ')),
    /tricky.iso/,
  );
  assert.match(
    await games
      .locator('.public-iso-game-card')
      .evaluateAll(cards => cards.map(card => card.getAttribute('title')).join(' ')),
    /ssx.iso/,
  );
  assert.match(
    await games
      .locator('.public-iso-game-card')
      .evaluateAll(cards => cards.map(card => card.getAttribute('title')).join(' ')),
    /madtrix.bin/,
  );
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
  for (const name of ['Refresh image', 'Remove image…', 'Unload game…'])
    assert(
      await page.getByRole('button', { name, exact: true }).isDisabled(),
      'Source changes are blocked during imports',
    );
  await ssxGame.click();
  await page.getByRole('button', { name: 'Load SSX_FIXTURE', exact: true }).click();
  assert.equal(await page.locator('.public-iso-map').getAttribute('data-state'), 'queued');
  assert.equal(await page.locator('.public-iso-map-summary').innerText(), '0 of 1 maps loaded · 1 not loaded');
  await madtrixGame.click();
  await page.getByRole('button', { name: 'Load Antarctica (Mad Trix)', exact: true }).click();
  assert.equal(await page.locator('.public-iso-map').getAttribute('data-state'), 'queued');
  await page.evaluate(() => (window as unknown as { releaseIsoImports: () => void }).releaseIsoImports());
  await page.locator('.public-iso-map .public-iso-badge.loaded').waitFor({ timeout: 90_000 });
  await page.getByText('3 loaded', { exact: true }).waitFor();
  assert.equal(await page.locator('.public-iso-map-summary').innerText(), '1 of 1 maps loaded · 0 not loaded');
  assert(
    await page
      .locator('.public-iso-map')
      .getByText('Ready to Play or Inspect. Saved in this browser.', { exact: true })
      .count(),
  );
  await filters.getByRole('button', { name: 'Not loaded (0)', exact: true }).click();
  assert.equal(await page.locator('.public-iso-map:visible').count(), 0);
  assert(await page.getByText('All listed maps are loaded and ready to play.', { exact: true }).isVisible());
  await filters.getByRole('button', { name: 'Loaded (1)', exact: true }).click();
  assert.equal(await page.locator('.public-iso-map:visible').count(), 1);
  const playHref = await page
    .getByRole('link', { name: 'Play Antarctica (Mad Trix)', exact: true })
    .getAttribute('href');
  assert(playHref);
  const play = new URL(playHref);
  assert.equal(play.searchParams.get('reference'), 'MADTRIX_AN_ANTARTICA');
  assert.equal(play.searchParams.get('source'), 'iso');
  assert(await page.getByRole('link', { name: 'Inspect Antarctica (Mad Trix)', exact: true }).isVisible());
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('slopesmith-local-disc', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = db.transaction('files').objectStore('files').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const version = await new Promise<number>((resolve, reject) => {
        const request = db.transaction('courses').objectStore('courses').get('MADTRIX_AN_ANTARTICA');
        request.onsuccess = () => resolve((request.result as { version: number }).version);
        request.onerror = () => reject(request.error);
      });
      const alphaSamples: number[][] = [];
      for (const path of ['textures/fixture_snow.png', 'skybox/textures/madtrix-sky-0.png']) {
        const file = await new Promise<{ blob: Blob }>((resolve, reject) => {
          const request = db.transaction('files').objectStore('files').get(`MADTRIX_AN_ANTARTICA/${path}`);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const image = await createImageBitmap(file.blob);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        image.close();
        const pixels = ctx.getImageData(0, 0, 2, 2).data;
        alphaSamples.push([pixels[3], pixels[7], pixels[11], pixels[15]]);
      }
      const patchFile = await new Promise<{ blob: Blob }>((resolve, reject) => {
        const request = db.transaction('files').objectStore('files').get('MADTRIX_AN_ANTARTICA/patches.json');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const colors = JSON.parse(await patchFile.blob.text()).Patches[0].LightColorPoints as number[][];
      return { keys, version, alphaSamples, colors };
    } finally {
      db.close();
    }
  });
  assert.equal(stored.version, isoCourseCacheVersion('MADTRIX_AN_ANTARTICA'));
  assert.deepEqual(stored.colors[0], [0.25, 0.5, 1], 'Worker retains source baked RGB at its neutral scale');
  assert.deepEqual(stored.colors[1], [0.25, 0.5625, 1], 'Worker transposes colors with geometry');
  assert.deepEqual(
    stored.alphaSamples,
    [
      [0, 128, 0, 255],
      [0, 128, 0, 255],
    ],
    'worker terrain and sky preserve cutout keys and ordinary alpha',
  );
  for (const path of [
    'patches.json',
    'aip.json',
    'models.json',
    'instances.json',
    'materials.json',
    'splines.json',
    'effects.json',
    'audio/soundindex.json',
    'audio/ridingimport.json',
    'audio/music/playlist.json',
    'audio/music/track1/graph.json',
    'audio/music/track1/chunk_002.wav',
    'audio/music/track9/chunk_000.wav',
    'audio/sfx/openslope_board/004.loop.wav',
    'textures/madtrix-sign-0-on.png',
    'textures/madtrix-waterfall-1.png',
    'skybox/models.json',
    'skybox/textures/madtrix-sky-0.png',
  ])
    assert(stored.keys.includes(`MADTRIX_AN_ANTARTICA/${path}`), `Mad Trix worker persisted ${path}`);
  await page.getByRole('link', { name: 'Play Antarctica (Mad Trix)', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(new URL(page.url()).searchParams.get('reference'), 'MADTRIX_AN_ANTARTICA');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  await page.waitForFunction(
    () => ((window as typeof window & { madtrixMusicStarts: number[] }).madtrixMusicStarts?.length ?? 0) >= 2,
    undefined,
    { timeout: 20_000 },
  );
  await page.getByRole('button', { name: 'Exit play', exact: true }).click();
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await madtrixGame.click();
  await madtrixGame.waitFor();
  assert(await page.getByRole('button', { name: 'Unload Antarctica (Mad Trix)', exact: true }).isEnabled());
  await page.getByRole('link', { name: 'Inspect Antarctica (Mad Trix)', exact: true }).click();
  await page
    .getByText('Source baked vertex colors loaded.', { exact: true })
    .waitFor({ state: 'attached', timeout: 90_000 });
  const propsToggle = page.locator('button.sp-seg-icon[aria-label="Props"]:not([aria-pressed])');
  await propsToggle.click();
  await propsToggle.click();
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 30_000 });
  assert.equal(await page.getByText(/no Instances\.json|Instances\.json.*missing|lighting study failed/i).count(), 0);
  assert.deepEqual(invalidLightmapRequests, [], 'Baked vertex colors must not request image lightmap -1');
  await page.goto(`${origin}/isos`);
  await madtrixGame.waitFor();
  await trickyGame.click();
  assert(await page.getByRole('button', { name: 'Unload Garibaldi', exact: true }).isEnabled());
  assert(await page.getByRole('button', { name: 'Load Snowdream', exact: true }).isEnabled());
  assert(
    (await filters.getByRole('button', { name: 'All maps (2)', exact: true }).getAttribute('aria-pressed')) === 'true',
  );
  assert.equal(await page.locator('.public-iso-map-summary').innerText(), '1 of 2 maps loaded · 1 not loaded');
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(root, 'mixed-map-states.png') });
  await filters.getByRole('button', { name: 'Loaded (1)', exact: true }).click();
  assert.deepEqual(
    await page
      .locator('.public-iso-map:visible')
      .evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.course)),
    ['TRICKY_GARI'],
  );
  await page.getByRole('button', { name: 'Unload Garibaldi', exact: true }).click();
  await filters.getByRole('button', { name: 'Loaded (0)', exact: true }).waitFor();
  assert.equal(
    await page.locator('.public-iso-map:visible').count(),
    0,
    'unloading removes a map from the Loaded filter',
  );
  assert.match((await trickyCard.getAttribute('title'))!, /Disc saved · tricky.iso/);
  await filters.getByRole('button', { name: 'Not loaded (2)', exact: true }).click();
  assert(
    await page.getByRole('button', { name: 'Load Garibaldi', exact: true }).isEnabled(),
    'the saved disc can reload an unloaded map',
  );
  assert.equal(await page.locator('.public-iso-map .public-iso-open:visible').count(), 0);
  await ssxGame.click();
  await page.reload();
  await ssxGame.waitFor();
  assert.equal(await ssxGame.getAttribute('aria-pressed'), 'true', 'the selected game survives reload');
  assert(await page.getByRole('button', { name: 'Unload SSX_FIXTURE', exact: true }).isEnabled());
  await madtrixGame.click();
  assert(await page.getByRole('button', { name: 'Unload Antarctica (Mad Trix)', exact: true }).isEnabled());
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'the game selector fits mobile screens');
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(root, 'saved-disc-library-mobile.png') });
  const secondTab = await context.newPage();
  await secondTab.goto(`${origin}/isos`);
  const otherGames = secondTab.getByRole('region', { name: 'Disc game support', exact: true });
  assert(await otherGames.getByRole('button', { name: 'SSX Tricky', exact: true }).isEnabled());
  assert(await otherGames.getByRole('button', { name: 'Jonny Moseley Mad Trix', exact: true }).isEnabled());
  assert(
    await otherGames.getByRole('button', { name: 'SSX', exact: true }).isEnabled(),
    'saved discs are available in another browser tab',
  );
  await secondTab.close();
  // A saved reference with the old bare ID can still load from a newly namespaced disc scan.
  await page.goto(`${origin}/isos?reference=GARI&source=iso`);
  await page.getByRole('button', { name: 'Load required maps', exact: true }).click();
  await page
    .locator('.public-iso-map[data-course="GARI"]')
    .getByRole('button', { name: 'Unload Garibaldi', exact: true })
    .waitFor();
  assert.equal(
    await page.locator('.public-iso-map[data-course="TRICKY_GARI"]').count(),
    0,
    'the required legacy map does not offer a duplicate namespaced import',
  );
  await page.goto(`${origin}/isos`);
  await page
    .getByRole('button', { name: 'Clear all ISO maps', exact: true, includeHidden: true })
    .waitFor({ state: 'attached' });
  assert.match((await page.locator('#public-iso').getAttribute('accept'))!, /\.gba/);
  await page.locator('#public-iso').setInputFiles(gba);
  await page.locator('.public-iso-status').filter({ hasText: '8 maps found' }).waitFor();
  assert.equal(await gbaGame.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.public-iso-map').count(), 8);
  const gbaGaribaldi = page.locator('.public-iso-map[data-course="SSXGBA_GARIBALDI"]');
  await gbaGaribaldi.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  await gbaGaribaldi.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor({ timeout: 90_000 });
  // Fresh native exports must be skyward. Recreate an older cache to cover its read-time repair too.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('slopesmith-local-disc', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const file = await new Promise<{ key: string; course: string; path: string; blob: Blob }>((resolve, reject) => {
        const request = db.transaction('files').objectStore('files').get('SSXGBA_GARIBALDI/patches.json');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const data = JSON.parse(await file.blob.text()) as { Patches: { Points: number[][]; UVPoints: number[][] }[] };
      for (const patch of data.Patches) {
        const p = patch.Points;
        const du = [0, 1].map(k => p[12][k] + p[15][k] - p[0][k] - p[3][k]);
        const dv = [0, 1].map(k => p[3][k] + p[15][k] - p[0][k] - p[12][k]);
        if (du[0] * dv[1] - du[1] * dv[0] < 0) throw new Error('Fresh GBA terrain faces downward');
        patch.Points = Array.from({ length: 16 }, (_, i) => p[(i % 4) * 4 + Math.floor(i / 4)]);
        const uv = patch.UVPoints;
        patch.UVPoints = [uv[0], uv[2], uv[1], uv[3]];
      }
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('files', 'readwrite');
        transaction
          .objectStore('files')
          .put({ ...file, blob: new Blob([JSON.stringify(data)], { type: 'application/json' }) });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  });
  await page.reload();
  await gbaGaribaldi.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(root, 'gba-courses-loaded.png') });
  await gbaGaribaldi.getByRole('link', { name: 'Play Garibaldi', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await page.evaluate(async () => {
    const path = '/src/app/ride/session.ts';
    const { TestRide } = (await import(/* @vite-ignore */ path)) as typeof import('../src/app/ride/session');
    const start = TestRide.prototype.start;
    TestRide.prototype.start = function (...args) {
      Object.assign(window, { gbaRideForTest: this });
      return start.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const groundSamples = await page.evaluate(async () => {
    const samples: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      samples.push(
        (window as typeof window & { gbaRideForTest: import('../src/app/ride/session').TestRide }).gbaRideForTest.state
          .grounded,
      );
    }
    return samples;
  });
  assert(
    groundSamples.filter(Boolean).length > 8,
    'Older cached GBA triangles support the browser rider through spawn',
  );
  await page.waitForFunction(() => document.body.innerText.includes('sink'), null, { timeout: 30_000 });
  await page.waitForFunction(
    () => ((window as typeof window & { gbaMusicStarts: number[] }).gbaMusicStarts?.length ?? 0) >= 2,
    undefined,
    { timeout: 20_000 },
  );
  await page.screenshot({ path: join(root, 'gba-course-riding.png') });
  await page.goto(`${origin}/isos`);
  await page.locator('.library-storage summary').click();
  await page.getByRole('button', { name: 'Clear all ISO maps', exact: true, includeHidden: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Unload all ISO maps?', exact: true })
    .getByRole('button', { name: 'Unload all maps', exact: true })
    .click();
  await page.getByText('0 loaded', { exact: true }).waitFor();
  assert(await trickyGame.isEnabled());
  assert(await ssxGame.isEnabled());
  assert(await madtrixGame.isEnabled());
  assert(await gbaGame.isEnabled());
  await page.reload();
  await trickyGame.waitFor();
  assert(await trickyGame.isEnabled());
  assert(await ssxGame.isEnabled());
  assert(await madtrixGame.isEnabled());
  assert.equal(
    await page.locator('.public-iso-map').count(),
    0,
    'Clear all removes saved discs as well as extracted maps',
  );
  assert.deepEqual(errors, []);
  console.log(
    `ISO LIBRARY PASS: disc and map states, Loaded/Not loaded filters, SSX and Mad Trix imports, Play/Inspect, persistence, mobile layout and clearing. Screenshots: ${root}`,
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
