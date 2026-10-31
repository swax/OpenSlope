// tier: integration
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { blankMountain } from '../src/core/doc/mountain';
import { encodePng } from '../src/server/routes/png';
import { authoredOrigin, retailExtractOrigin } from '../src/core/export/origin';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-game-maps-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
const games = [
  'ssx',
  'ssx-tricky',
  'ssx-3',
  'ssx-on-tour',
  '1080-avalanche',
  'jonny-moseley-mad-trix',
  'future-game-1',
  'future-game-2',
  'future-game-3',
  'future-game-4',
];
const png = encodePng({ w: 2, h: 2, data: new Uint8Array(16).fill(255) });
const patch = {
  SurfaceType: 1,
  TexturePath: '0000.png',
  Points: Array.from({ length: 16 }, (_, i) => [(i % 4) * 1000, Math.floor(i / 4) * 1000, 0]),
};
function map(name: string, files: Record<string, unknown>) {
  const dir = join(root, 'Maps', name);
  mkdirSync(join(dir, 'Textures'), { recursive: true });
  mkdirSync(join(dir, 'Meshes'));
  writeFileSync(join(dir, 'Textures', '0000.png'), png);
  for (const [file, data] of Object.entries({
    'Patches.json': { Patches: [patch] },
    'Models.json': { Models: [] },
    'Instances.json': { Instances: [] },
    ...files,
  }))
    writeFileSync(join(dir, file), JSON.stringify(data));
}
for (const [g, game] of games.entries())
  for (let i = 0; i < 10; i++)
    map(g === 4 && i === 1 ? 'AVALANCHE_CRS01_01' : `BANK_${g}_${i}`, {
      'Origin.json': {
        ...retailExtractOrigin('renamed'),
        Course: g === 4 && i === 0 ? 'AVALANCHE_CRS01_00' : g === 4 && i === 9 ? 'AVALANCHE_CRS06_03' : 'renamed',
        ...(i % 2 ? {} : { Game: game }),
      },
      'Import.json': { Game: game, ...(g === 4 && i === 0 ? { DisplayName: 'Disc Tenderfoot' } : {}) },
    });
map('MYSTERY', {});
map('AUTHORED', {
  'Origin.json': authoredOrigin({
    source: 'slopesmith-authored',
    publicDistribution: 'allowed',
    retailDerived: false,
    userSupplied: false,
    reasons: [],
  }),
});
const api = await startApiService({ host: '127.0.0.1', port: 0 });
process.env.PORT = String(api.port);
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
try {
  for (const path of ['/api/levels', '/api/textures', '/api/props']) {
    const response = await fetch(api.url + path);
    assert(response.ok);
    const body = (await response.json()) as { levels: string[]; maps: { name: string; game: string }[] };
    assert.equal(body.maps.length, 102);
    for (const game of games) assert.equal(body.maps.filter(map => map.game === game).length, 10, path);
    assert.equal(body.maps.find(map => map.name === 'MYSTERY')?.game, 'unknown');
    assert.equal(body.maps.find(map => map.name === 'AUTHORED')?.game, 'slopesmith');
    assert.equal(
      (body.maps.find(map => map.name === 'BANK_4_0') as { displayName?: string })?.displayName,
      'Disc Tenderfoot',
    );
  }
  const created = await fetch(api.url + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: blankMountain('GAME_PICKERS') }),
  });
  assert(created.ok);
  await vite.listen();
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${vite.resolvedUrls!.local[0]}editor/GAME_PICKERS?agent=1`);
  await page.waitForFunction(
    () => document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 60_000 },
  );
  const game = (context: string) => page!.getByRole('combobox', { name: `${context} game`, exact: true });
  const maps = (context: string) => page!.getByRole('combobox', { name: `${context} map`, exact: true });
  const terrainReads: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/level') terrainReads.push(request.url());
  });
  const storedReference = () =>
    page!.evaluate(async () => {
      const moduleUrl = '/src/app/state/storage.ts';
      const { REF_KEY } = await import(/* @vite-ignore */ moduleUrl);
      return JSON.parse(localStorage.getItem(REF_KEY) ?? 'null')?.level ?? null;
    });
  assert.equal(await page.getByRole('combobox', { name: 'Reference source', exact: true }).isVisible(), false);

  await page.getByRole('button', { name: 'Scene', exact: true }).first().click();
  await game('Reference').selectOption('ssx-3');
  assert.equal(await maps('Reference').locator('option').count(), 11);
  await maps('Reference').selectOption('BANK_2_4');
  await page.waitForTimeout(150);
  assert.equal(terrainReads.length, 0, 'changing reference combos never loads terrain');
  assert.equal(await storedReference(), null, 'pending choices do not replace the saved reference');
  await page.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  assert.equal(await storedReference(), 'BANK_2_4');
  const loadedReads = terrainReads.length;
  await game('Reference').selectOption('ssx');
  assert.equal(await storedReference(), 'BANK_2_4', 'changing a game keeps the active reference');
  assert.equal(terrainReads.length, loadedReads);
  await page.reload();
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 60_000 });
  await game('Reference').waitFor();
  assert.equal(await game('Reference').inputValue(), 'ssx-3', 'restoring a reference restores its game too');
  assert.equal(await maps('Reference').inputValue(), 'BANK_2_4');
  await page.screenshot({ path: join(root, 'references.png') });
  await page.locator('.ref-clear-btn').click();
  assert.equal(await maps('Reference').inputValue(), '(none)');
  await game('Reference').selectOption('unknown');
  assert.deepEqual(await maps('Reference').locator('option').allTextContents(), ['(none)', 'MYSTERY']);
  await game('Reference').selectOption('1080-avalanche');
  for (const title of ['Disc Tenderfoot', 'Powder Threat', "Wit's Thicket"])
    assert((await maps('Reference').locator('option').allTextContents()).includes(title));
  await maps('Reference').selectOption({ label: "Wit's Thicket" });
  await page.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  assert.equal(await maps('Reference').inputValue(), 'BANK_4_9', 'Friendly names preserve the folder used to load');
  await page.screenshot({ path: join(root, 'named-reference.png') });

  await page.getByRole('button', { name: 'Paint', exact: true }).first().click();
  const textureToggle = page.getByRole('button', { name: 'Open Texture Library', exact: true }).first();
  if (await textureToggle.isVisible()) await textureToggle.click();
  await game('Texture library').selectOption('ssx-on-tour');
  assert.equal(await maps('Texture library').locator('option').count(), 10);
  await maps('Texture library').selectOption('BANK_3_7');
  await page.locator('[data-ref="BANK_3_7/0000.png"]').waitFor();
  await game('Texture library').selectOption('ssx');
  await game('Texture library').selectOption('ssx-on-tour');
  assert.equal(await maps('Texture library').inputValue(), 'BANK_3_7', 'each game remembers its last map');
  await game('Texture library').selectOption('1080-avalanche');
  assert((await maps('Texture library').locator('option').allTextContents()).includes('Disc Tenderfoot'));
  await maps('Texture library').selectOption({ label: "Wit's Thicket" });
  assert.equal(await maps('Texture library').inputValue(), 'BANK_4_9');
  assert.equal(await maps('Texture library').locator('option[value="BANK_4_2"]').textContent(), 'BANK_4_2');
  await page.locator('[data-ref="BANK_4_9/0000.png"]').waitFor();
  await page.screenshot({ path: join(root, 'textures.png') });

  await page.getByRole('button', { name: 'Props', exact: true }).first().click();
  const propToggle = page.getByRole('button', { name: 'Open Prop Library', exact: true }).first();
  if (await propToggle.isVisible()) await propToggle.click();
  await game('Prop library').selectOption('1080-avalanche');
  assert((await maps('Prop library').locator('option').allTextContents()).includes('Disc Tenderfoot'));
  assert.equal(await maps('Prop library').locator('option').count(), 10);
  await maps('Prop library').selectOption({ label: "Wit's Thicket" });
  assert.equal(await maps('Prop library').inputValue(), 'BANK_4_9');
  await game('Prop library').selectOption('slopesmith');
  assert((await maps('Prop library').locator('option').allTextContents()).includes('GAME_PICKERS'));
  await game('Prop library').selectOption('1080-avalanche');
  assert.equal(await maps('Prop library').inputValue(), 'BANK_4_9');
  await page.screenshot({ path: join(root, 'props.png') });

  // A sampled texture / selected prop can move the two controls across game boundaries without a user event.
  const programmatic = await page.evaluate(async () => {
    const moduleUrl = '/src/app/ui/components/game-map-select.ts';
    const { GameMapSelect } = await import(/* @vite-ignore */ moduleUrl);
    const picker = new GameMapSelect(document.createElement('select'), 'Test', () => {});
    picker.setMaps(
      [
        { name: 'a', game: 'ssx' },
        { name: 'b', game: 'ssx-3' },
      ],
      'a',
    );
    picker.select('b');
    return [picker.gameSelect.value, picker.mapSelect.value, picker.mapSelect.options.length];
  });
  assert.deepEqual(programmatic, ['ssx-3', 'b', 1]);
  const sourcePicks = await page.evaluate(async () => {
    const moduleUrl = '/src/app/ui/components/game-map-select.ts';
    const { GameMapSelect } = await import(/* @vite-ignore */ moduleUrl);
    const picker = new GameMapSelect(document.createElement('select'), 'Sources', () => {});
    picker.setMaps([{ name: 'server:TRICKY_GARI' }, { name: 'local:TRICKY_GARI' }]);
    picker.select('server:TRICKY_GARI');
    const server = [picker.sourceSelect.value, picker.gameSelect.value, picker.mapSelect.value];
    picker.select('TRICKY_GARI');
    const legacy = [picker.sourceSelect.value, picker.mapSelect.value];
    picker.select('local:MISSING');
    return { server, legacy, unavailable: picker.mapSelect.disabled && picker.mapSelect.options.length === 0 };
  });
  assert.deepEqual(sourcePicks, {
    server: ['server', 'ssx-tricky', 'server:TRICKY_GARI'],
    legacy: ['local', 'local:TRICKY_GARI'],
    unavailable: true,
  });
  // Both copies keep independent IDs, assets, selections and geometry caches.
  await page.evaluate(
    async png => {
      const moduleUrl = '/src/app/public/iso-cache.ts';
      const { openIsoCache, cacheTransaction, ISO_CACHE_VERSION } = await import(/* @vite-ignore */ moduleUrl);
      const db = await openIsoCache();
      const files: Record<string, unknown> = {
        'Patches.json': {
          Patches: [
            {
              SurfaceType: 1,
              TexturePath: 'local.png',
              Points: Array.from({ length: 16 }, (_, i) => [(i % 4) * 1000, Math.floor(i / 4) * 1000, 123]),
            },
          ],
        },
        'Import.json': { Game: 'ssx', DisplayName: 'Local shared map' },
        'Models.json': {
          Models: [
            {
              ModelName: 'LocalOnly',
              ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'triangle.obj', MaterialID: 0 }] }],
            },
          ],
        },
        'Materials.json': { Materials: [{ TexturePath: 'local.png' }] },
        'Instances.json': {
          Instances: [{ ModelID: 0, Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1], Visable: true }],
        },
      };
      await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
        for (const [path, value] of Object.entries(files))
          store.put({ key: `BANK_0_0/${path}`, course: 'BANK_0_0', path, blob: new Blob([JSON.stringify(value)]) });
        store.put({
          key: 'BANK_0_0/Meshes/triangle.obj',
          course: 'BANK_0_0',
          path: 'Meshes/triangle.obj',
          blob: new Blob(['v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n']),
        });
        store.put({
          key: 'BANK_0_0/Textures/local.png',
          course: 'BANK_0_0',
          path: 'Textures/local.png',
          blob: new Blob([new Uint8Array(png)]),
        });
      });
      await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
        store.put({ course: 'BANK_0_0', version: ISO_CACHE_VERSION, files: 7 }),
      );
      db.close();
    },
    Array.from(
      encodePng({ w: 2, h: 2, data: new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) }),
    ),
  );
  await page.evaluate(async png => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction, ISO_CACHE_VERSION } = await import(/* @vite-ignore */ moduleUrl);
    const db = await openIsoCache();
    await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
      for (const [path, value] of Object.entries({
        'Models.json': { Models: [] },
        'Instances.json': { Instances: [] },
        'Import.json': { Game: 'ssx', DisplayName: 'Matching local copy' },
      }))
        store.put({ key: `BANK_0_1/${path}`, course: 'BANK_0_1', path, blob: new Blob([JSON.stringify(value)]) });
      store.put({
        key: 'BANK_0_1/Textures/0000.png',
        course: 'BANK_0_1',
        path: 'Textures/0000.png',
        blob: new Blob([new Uint8Array(png)]),
      });
    });
    await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
      store.put({ course: 'BANK_0_1', version: ISO_CACHE_VERSION, files: 4 }),
    );
    db.close();
  }, Array.from(png));
  await page.reload();
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 60_000 });
  const source = (context: string) => page!.getByRole('combobox', { name: `${context} source`, exact: true });
  await page.getByRole('button', { name: 'Scene', exact: true }).first().click();
  await source('Reference').selectOption('server');
  await game('Reference').selectOption('ssx');
  await maps('Reference').selectOption('server:BANK_0_0');
  await page.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  await source('Reference').selectOption('local');
  await game('Reference').selectOption('ssx');
  await maps('Reference').selectOption('local:BANK_0_0');
  await page.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  assert.deepEqual(await maps('Reference').locator('option').allTextContents(), ['(none)', 'Local shared map']);
  const copies = await page.evaluate(async () => {
    const moduleUrl = '/src/app/net/fetch-json.ts';
    const { fetchJson } = (await import(/* @vite-ignore */ moduleUrl)) as typeof import('../src/app/net/fetch-json');
    const assetModuleUrl = '/src/app/net/asset-paths.ts';
    const { textureUrl } = await import(/* @vite-ignore */ assetModuleUrl);
    const result = [];
    for (const source of ['local', 'server']) {
      const id = `${source}:BANK_0_0`;
      const terrain = await fetchJson<{ name: string; patches: { Points: number[][] }[] }>(
        `/api/level?name=${encodeURIComponent(id)}`,
      );
      const textures = await fetchJson<{ level: string; tiles: { name: string }[] }>(
        `/api/textures?level=${encodeURIComponent(id)}`,
      );
      const props = await fetchJson<{ level: string; models: { name: string }[] }>(
        `/api/props?level=${encodeURIComponent(id)}`,
      );
      const bitmap = await createImageBitmap(
        await (await fetch(textureUrl(id, source === 'local' ? 'local.png' : '0000.png'))).blob(),
      );
      const canvas = new OffscreenCanvas(2, 2);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      result.push({
        name: terrain.name,
        z: terrain.patches[0].Points[0][2],
        level: textures.level,
        tiles: textures.tiles.map(tile => tile.name),
        props: props.level,
        models: props.models.map(model => model.name),
        pixel: [...ctx.getImageData(0, 0, 1, 1).data],
      });
    }
    return result;
  });
  assert.deepEqual(copies, [
    {
      name: 'local:BANK_0_0',
      z: 123,
      level: 'local:BANK_0_0',
      tiles: ['local.png'],
      props: 'local:BANK_0_0',
      models: ['LocalOnly'],
      pixel: [255, 0, 0, 255],
    },
    {
      name: 'server:BANK_0_0',
      z: 0,
      level: 'server:BANK_0_0',
      tiles: ['0000.png'],
      props: 'server:BANK_0_0',
      models: [],
      pixel: [255, 255, 255, 255],
    },
  ]);
  const unavailableServer = /\/api\/level\?name=BANK_0_0&mapSource=server$/;
  await page.route(unavailableServer, route => route.fulfill({ status: 404, body: 'Map unavailable' }));
  const missingCopy = await page.evaluate(async () => {
    const moduleUrl = '/src/app/net/fetch-json.ts';
    const { fetchJson } = await import(/* @vite-ignore */ moduleUrl);
    try {
      await fetchJson('/api/level?name=server:BANK_0_0');
      return 'wrong fallback';
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.match(missingCopy, /404/, 'a failed server request must not fall back to the local map');
  await page.unroute(unavailableServer);
  await page.reload();
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 60_000 });
  await page.getByRole('button', { name: 'Scene', exact: true }).first().click();
  assert.equal(await source('Reference').inputValue(), 'local');
  assert.equal(await maps('Reference').inputValue(), 'local:BANK_0_0');
  for (const [context, mode, panel] of [
    ['Texture library', 'Paint', 'texture-library'],
    ['Prop library', 'Props', 'prop-library'],
  ]) {
    await page.getByRole('button', { name: mode, exact: true }).first().click();
    const toggle = page
      .getByRole('button', { name: `Open ${context === 'Texture library' ? 'Texture' : 'Prop'} Library`, exact: true })
      .first();
    if (await toggle.isVisible()) await toggle.click();
    for (const location of ['server', 'local', 'server']) {
      await source(context).selectOption(location);
      await game(context).selectOption('ssx');
      await maps(context).selectOption(`${location}:BANK_0_0`);
      if (context === 'Texture library')
        await page
          .locator(`[data-ref="${location}:BANK_0_0/${location === 'local' ? 'local.png' : '0000.png'}"]`)
          .waitFor();
      else if (location === 'local')
        await page.locator('#prop-library .pl-tile[data-source-level="local:BANK_0_0"][data-model="0"]').waitFor();
      assert.equal(await source(context).inputValue(), location);
      assert.equal(await maps(context).inputValue(), `${location}:BANK_0_0`);
      if (context === 'Texture library') {
        await page
          .locator(`[data-ref="${location}:BANK_0_0/${location === 'local' ? 'local.png' : '0000.png'}"]`)
          .click();
        const details = page.locator('.sc-details');
        await details
          .locator('[data-detail="source"] .sc-detail-value')
          .filter({ hasText: location === 'local' ? 'Local' : 'Server' })
          .waitFor();
        assert.equal(await details.locator('[data-detail="game"] .sc-detail-value').textContent(), 'SSX');
        assert.equal(
          await details.locator('[data-detail="map"] .sc-detail-value').textContent(),
          location === 'local' ? 'Local shared map' : 'BANK_0_0',
        );
      } else if (location === 'local') {
        await page.locator('#prop-library .pl-tile[data-source-level="local:BANK_0_0"][data-model="0"]').click();
        const details = page.locator('.pp-card.on .pp-source');
        await details.locator('[data-detail="source"] .pp-source-value').filter({ hasText: 'Local' }).waitFor();
        assert.equal(await details.locator('[data-detail="game"] .pp-source-value').textContent(), 'SSX');
        assert.equal(await details.locator('[data-detail="map"] .pp-source-value').textContent(), 'Local shared map');
      }
    }
    await page.screenshot({ path: join(root, `${panel}-sources.png`) });
  }
  const versions = await page.evaluate(async () => {
    const moduleUrl = '/src/app/net/asset-versions.ts';
    const { pinAssetMap } = await import(/* @vite-ignore */ moduleUrl);
    return {
      local: await pinAssetMap('local:BANK_0_1'),
      server: await pinAssetMap('server:BANK_0_1'),
      differentLocal: await pinAssetMap('local:BANK_0_0'),
      differentServer: await pinAssetMap('server:BANK_0_0'),
    };
  });
  assert.equal(versions.local, versions.server, 'matching copies save the same source-neutral asset identity');
  assert.notEqual(versions.differentLocal, versions.differentServer, 'different contents keep separate identities');
  const localCheck = await page.evaluate(async () => {
    const moduleUrl = '/src/app/net/workspace.ts';
    const { workspaceFetch } = await import(/* @vite-ignore */ moduleUrl);
    const texture = await workspaceFetch('/api/texture?level=local:BANK_0_1&name=0000.png');
    return {
      status: texture.status,
      catalogue: await (await workspaceFetch('/api/levels')).json(),
      detail: texture.ok ? '' : await texture.text(),
    };
  });
  assert.equal(localCheck.status, 200, JSON.stringify(localCheck));
  await page.route('**/api/texture?**', route =>
    new URL(route.request().url()).searchParams.get('level') === versions.server
      ? route.fulfill({ status: 404, body: 'Preferred server unavailable' })
      : route.continue(),
  );
  const fallback = await page.evaluate(async id => {
    const moduleUrl = '/src/app/net/asset-images.ts';
    const { imageAssetUrl } = await import(/* @vite-ignore */ moduleUrl);
    const workspaceUrl = '/src/app/net/workspace.ts';
    const { workspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
    const check = await workspaceFetch(`/api/texture?level=${encodeURIComponent(id)}&name=0000.png&fallback-test=0`);
    if (!check.ok) throw new Error(JSON.stringify(await check.json()));
    const url = await imageAssetUrl(`/api/texture?level=${encodeURIComponent(id)}&name=0000.png&fallback-test=1`);
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const versionsUrl = '/src/app/net/asset-versions.ts';
    const { assetLocation, assetPreference } = await import(/* @vite-ignore */ versionsUrl);
    return {
      pixels: Array.from(ctx.getImageData(0, 0, 1, 1).data),
      location: assetLocation(id),
      preference: assetPreference(id),
    };
  }, versions.server);
  assert.deepEqual(
    fallback,
    { pixels: [255, 255, 255, 255], location: 'local:BANK_0_1', preference: 'server' },
    'image decoding uses the matching local copy when the preferred server fails',
  );
  await page.unroute('**/api/texture?**');
  const sampled = await page.evaluate(async id => {
    const moduleUrl = '/src/app/paint/library.ts';
    const { TextureLibrary } = await import(/* @vite-ignore */ moduleUrl);
    let picked = '';
    const library = new TextureLibrary({
      onBrush(brush: { ref: string }) {
        picked = brush.ref;
      },
    });
    await library.init('server:BANK_0_1');
    await library.pickTexture(`${id}/0000.png`, 1);
    library.el.remove();
    return picked;
  }, versions.server);
  assert.equal(sampled, `${versions.server}/0000.png`, 'sampling preserves an existing content version');
  writeFileSync(
    join(root, 'Maps', 'BANK_0_0', 'Textures', '0000.png'),
    encodePng({ w: 1, h: 1, data: new Uint8Array([0, 255, 0, 255]) }),
  );
  const changedSample = await page.evaluate(async id => {
    const moduleUrl = '/src/app/paint/library.ts';
    const { TextureLibrary } = await import(/* @vite-ignore */ moduleUrl);
    let picked = '';
    const library = new TextureLibrary({
      onBrush(brush: { ref: string }) {
        picked = brush.ref;
      },
    });
    await library.init('server:BANK_0_0');
    let rejected = false;
    try {
      await library.pickTexture(`${id}/0000.png`, 1);
    } catch {
      rejected = true;
    }
    library.el.remove();
    return { picked, rejected };
  }, versions.differentServer);
  assert.deepEqual(
    changedSample,
    { picked: '', rejected: true },
    'sampling a missing version cannot silently pick the current different bank',
  );
  assert.deepEqual(errors, []);
  console.log(
    `Source → Game → Map: duplicate copies, terrain/models/pixels, failure isolation, restore, 100 server maps across 10 games PASS. ${root}`,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(join(root, 'failure.png'));
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
