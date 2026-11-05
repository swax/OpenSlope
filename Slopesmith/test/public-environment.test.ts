import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { DEFAULT_SUN } from '../src/core/doc/types';
import { createFogVolume } from '../src/core/particles/volumes';
import { retailExtractOrigin } from '../src/core/export/origin';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { createProject } from '../src/server/projects';
import { setPublished } from '../src/server/public-courses';
import { encodePng } from '../src/server/routes/png';
import type { PublicCourse } from '../src/core/session/public-courses';
import type { ProjectBundle } from '../src/core/project/transfer';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-public-environment-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const donor = join(root, 'Maps', 'GARI');
mkdirSync(join(donor, 'Textures', 'Particles'), { recursive: true });
writeFileSync(join(donor, 'Patches.json'), JSON.stringify({ Patches: [] }));
writeFileSync(join(donor, 'Origin.json'), JSON.stringify(retailExtractOrigin('GARI')));
for (const name of ['Models', 'Materials', 'Instances'])
  writeFileSync(join(donor, name + '.json'), JSON.stringify({ [name]: [] }));
const sprite = encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) });
writeFileSync(join(donor, 'Textures', 'Particles', 'fog0.png'), sprite);
writeFileSync(join(donor, 'Textures', 'tile.png'), sprite);
const document = blankMountain('ENVIRONMENT');
document.vertices = [0, 0, 0, 20, 0, 0, 0, 0, 20, 20, 0, 20];
document.quads = [[2, 3, 0, 1]];
document.quadTex = { 0: 'Custom/white.png' };
Object.assign(document, appendMeshIds(document, 4, 1));
document.sun = { ...DEFAULT_SUN, on: true, ambient: 0.1, sun: 0, ao: 0, shadow: 0, skyTint: '#ffffff' };
document.lights = [{ id: 'light:0', kind: 'point', pos: [10, 5, 10], color: '#ff0000', intensity: 6, reach: 30 }];
document.models = [
  {
    id: 'model:0000',
    name: 'Billboard',
    anchor: [0, 0, 0],
    vertices: [-1, 0, 0, 1, 0, 0, -1, 2, 0, 1, 2, 0],
    quads: [[0, 1, 2, 3]],
  },
];
document.props = [
  { id: 'prop:sign', level: '@models', model: 0, name: 'Mdl_Billboard_fixture', pos: [1000, 0, 0], yaw: 0, scale: 1 },
  {
    id: 'prop:group',
    level: '@models',
    model: 0,
    name: 'Lamp assembly',
    pos: [1000, 0, 0],
    yaw: 0,
    scale: 1,
    group: 'lamp',
    groupDefinition: {
      id: 'lamp',
      name: 'Lamp',
      level: '@models',
      occurrences: 1,
      props: [{ model: 0, name: 'Lamp', relPos: [0, 0, 0], relYaw: 0 }],
      lights: [
        {
          name: 'Lamp',
          kind: 'point',
          relPos: [0, 5, 0],
          dir: [0, -1, 0],
          color: '#0000ff',
          intensity: 1,
          reach: 4,
          coneCos: 1,
        },
      ],
    },
  },
];
document.particleVolumes = [createFogVolume([10, 5, 10])];
document.particleVolumes[0].objects[0].puffs = [{ position: [0, 0, 0], scale: [1, 1, 1], radius: 500 }];
const privateMap = await createProject(document, undefined, false);
mkdirSync(join(privateMap.project.folder, 'assets', 'textures'), { recursive: true });
writeFileSync(join(privateMap.project.folder, 'assets', 'textures', 'white.png'), sprite);
const publicDocument = structuredClone(document);
publicDocument.name = 'CUSTOM_FOG';
publicDocument.particleVolumes![0].texture = 'Custom/mist.png';
const publicMap = await createProject(publicDocument, undefined, false);
mkdirSync(join(publicMap.project.folder, 'assets', 'textures'), { recursive: true });
writeFileSync(join(publicMap.project.folder, 'assets', 'textures', 'mist.png'), sprite);
writeFileSync(join(publicMap.project.folder, 'assets', 'textures', 'white.png'), sprite);
await setPublished('project', publicMap.project.id, true, { id: 'owner', role: 'admin' });
const missingServerDocument = structuredClone(document);
missingServerDocument.name = 'MISSING_SERVER_ASSETS';
missingServerDocument.quadTex = { 0: 'TRICKY_SNOW/tile.png' };
const missingServerMap = await createProject(missingServerDocument, undefined, false);
const api = await startApiService({ host: '127.0.0.1', port: 0 });
process.env.PORT = String(api.port);
const vite = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
  plugins: [
    {
      name: 'public-environment-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/environment.html') return next();
          res.setHeader('content-type', 'text/html');
          res.end(
            '<!doctype html><style>html,body,#view{margin:0;width:100%;height:100%}</style><div id="view"></div><script type="module" src="/test/public-environment.fixture.ts"></script>',
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  for (const [snapshot, privateCourse] of [
    [privateMap, true],
    [publicMap, false],
  ] as const) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (
        response.status() >= 400 &&
        /\/api\/(?:texture\?|map-asset-|particle-texture\?name=fog0)/.test(response.url())
      )
        errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(vite.resolvedUrls!.local[0] + 'environment.html');
    await page.waitForFunction(() => !!window.checkPublicEnvironment);
    const course: PublicCourse = {
      kind: 'project',
      id: snapshot.project.id,
      name: snapshot.project.name,
      isoCourses: [],
      retailData: privateCourse,
      ...(privateCourse ? { private: true } : {}),
    };
    const result = (await page.evaluate(course => window.checkPublicEnvironment(course), course)) as {
      lights: number;
      lit: number[];
      unlit: number[];
      fogged: number[];
      fog: { instances: number; width: number; missing: boolean };
      markers: boolean;
      bounds: boolean;
    };
    assert.equal(result.lights, 3, 'free, derived sign and assembly lights reach the player rig');
    assert(result.lit[0] > result.unlit[0] + 20, `custom light reaches the framebuffer: ${JSON.stringify(result)}`);
    assert(result.lit[0] > result.lit[1] + 20, 'the light retains its authored red color');
    assert(result.fogged[1] > result.unlit[1] + 20, 'fog changes the framebuffer over the terrain');
    assert.deepEqual(result.fog, { instances: 1, width: 1, missing: false });
    assert.equal(result.markers, false, 'riding does not expose light editing handles');
    assert.equal(result.bounds, false, 'riding does not expose fog editing bounds');
    assert.deepEqual(errors, []);
    await page.close();
  }
  const loadingPage = await browser.newPage();
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>(resolve => {
    releaseSnapshot = resolve;
  });
  const sawSnapshot = loadingPage.waitForRequest('**/api/public/project?*');
  await loadingPage.route('**/api/public/project?*', async route => {
    await snapshotGate;
    await route.continue();
  });
  try {
    const loadingUrl = new URL('/play/CUSTOM_FOG', vite.resolvedUrls!.local[0]).href;
    await loadingPage.goto(loadingUrl, { waitUntil: 'commit' });
    await sawSnapshot;
    const overlay = loadingPage.locator('#load-status');
    await overlay.waitFor({ state: 'visible' });
    assert.equal(await overlay.getAttribute('aria-busy'), 'true');
    assert(
      await loadingPage.getByRole('group', { name: 'Play options', exact: true }).isHidden(),
      'launch controls stay hidden while the loading card owns pointer input',
    );
    assert.equal(await loadingPage.locator('#load-title').innerText(), 'Loading CUSTOM FOG');
    assert.equal(await loadingPage.locator('#load-label').innerText(), 'Preparing the mountain…');
    assert.equal(
      await loadingPage.locator('#load-progress').getAttribute('aria-valuenow'),
      null,
      'unknown work has no invented percentage',
    );
    const card = await overlay.locator('.sp-load-card').boundingBox();
    const viewport = loadingPage.viewportSize()!;
    assert(
      card &&
        Math.abs(card.x + card.width / 2 - viewport.width / 2) < 2 &&
        Math.abs(card.y + card.height / 2 - viewport.height / 2) < 2,
      'preparation status is centered on the screen',
    );
    await loadingPage.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await loadingPage.locator('#load-progress-fill').evaluate(el => getComputedStyle(el).animationName),
      'none',
    );
    releaseSnapshot();
    await loadingPage.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
    await overlay.waitFor({ state: 'hidden' });
    assert.equal(await overlay.getAttribute('aria-busy'), 'false');
    await loadingPage.unroute('**/api/public/project?*');
    await loadingPage.route('**/api/public/project?*', route =>
      route.fulfill({ status: 503, body: 'Loading fixture unavailable' }),
    );
    await loadingPage.goto(loadingUrl, { waitUntil: 'commit' });
    await loadingPage.locator('#load-status.error').waitFor({ state: 'visible' });
    assert.match(
      (await loadingPage.locator('.public-status').textContent()) ?? '',
      /Return to Maps to try again/,
      'persistent recovery guidance is ready while the error card is displayed',
    );
    assert.equal(await loadingPage.locator('#load-label').innerText(), 'Could not finish loading');
    await overlay.waitFor({ state: 'hidden' });
    assert.equal(await overlay.getAttribute('aria-busy'), 'false');
    await loadingPage
      .locator('.public-status')
      .getByText(/Return to Maps to try again/)
      .waitFor();
  } finally {
    releaseSnapshot();
    await loadingPage.close();
  }
  const localPage = await browser.newPage();
  await localPage.goto(vite.resolvedUrls!.local[0] + 'environment.html');
  const localDocument = structuredClone(document);
  localDocument.name = 'DOWNLOADED_REQUIREMENTS';
  const oldTexture = `asset2:ssx-tricky:TRICKY_GARI:texture:tile.png:${'b'.repeat(64)}`;
  localDocument.quadTex = { 0: `${oldTexture}/tile.png` };
  localDocument.skybox = { on: true, source: { kind: 'level', level: 'old-snow' }, topColor: '#ffffff' };
  localDocument.particleVolumes = [];
  localDocument.props!.push({
    id: 'prop:missing-source',
    name: 'Custom source prop',
    level: `asset2:slopesmith:LOCAL_SOURCE:prop:3:${'d'.repeat(64)}`,
    model: 3,
    pos: [1000, 0, 0],
    yaw: 0,
    scale: 1,
  });
  const bundle: ProjectBundle = {
    kind: 'slopesmith-project',
    schema: 1,
    name: localDocument.name,
    revision: 28703,
    takenAt: '2026-11-04T19:47:11Z',
    document: localDocument,
    assets: [],
    isoAliases: { 'old-snow': 'TRICKY_SNOW' },
  };
  const localMap = await localPage.evaluate(async text => {
    const bundle = JSON.parse(text);
    const path = '/src/app/state/local-projects.ts';
    const projects = await (await import(/* @vite-ignore */ path)).openLocalProjects();
    try {
      const snapshot = await projects.copyPublic(bundle, 'https://example.test/map-download');
      return { id: String(snapshot.project.id), name: String(snapshot.project.name) };
    } finally {
      projects.close();
    }
  }, JSON.stringify(bundle));
  const localUrl = new URL(`/play/${localMap.name}`, vite.resolvedUrls!.local[0]);
  localUrl.searchParams.set('local', localMap.id);
  localUrl.searchParams.set('compatible', '0');
  await localPage.goto(localUrl.href);
  await localPage.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  const assets = localPage.locator('.public-assets-summary');
  assert.match(
    (await assets.getAttribute('aria-label')) ?? '',
    /0 of 3 source maps loaded; 2 asset versions unavailable/,
  );
  await assets.click();
  const requirements = localPage.getByRole('region', { name: 'Required ISO maps' });
  await requirements.getByText('SSX Tricky · Garibaldi · Not loaded', { exact: true }).waitFor();
  await requirements.getByText('SSX Tricky · Snowdream · Not loaded', { exact: true }).waitFor();
  await requirements.getByText('LOCAL_SOURCE · Source map assets needed', { exact: true }).waitFor();
  await requirements.getByText('Unavailable asset versions (2)', { exact: true }).waitFor();
  await requirements.locator('code').getByText(localDocument.props!.at(-1)!.level, { exact: true }).waitFor();
  await localPage.evaluate(async png => {
    const path = '/src/app/public/iso-cache.ts';
    const cache = await import(/* @vite-ignore */ path);
    const db = await cache.openIsoCache();
    try {
      const files = [
        { path: 'Patches.json', blob: new Blob([JSON.stringify({ Patches: [] })], { type: 'application/json' }) },
        {
          path: 'Textures/tile.png',
          blob: new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: 'image/png' }),
        },
      ];
      await cache.cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
        for (const file of files)
          store.put({ ...file, key: `TRICKY_GARI/${file.path.toLowerCase()}`, course: 'TRICKY_GARI' });
      });
      await cache.cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) => {
        store.put({ course: 'TRICKY_GARI', version: cache.isoCourseCacheVersion('TRICKY_GARI'), files: files.length });
      });
    } finally {
      db.close();
    }
  }, Buffer.from(sprite).toString('base64'));
  await localPage.reload();
  await localPage.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await localPage.locator('.public-assets-summary').click();
  assert.match(
    (await localPage.locator('.public-assets-summary').getAttribute('aria-label')) ?? '',
    /1 of 3 source maps loaded; 2 asset versions unavailable/,
  );
  await requirements.getByText('Imported version differs', { exact: false }).waitFor();
  await requirements.getByRole('link', { name: 'Use matching imported assets' }).click();
  await localPage.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(
    new URL(localPage.url()).searchParams.get('compatible'),
    null,
    'matching imported versions are the default',
  );
  await localPage.locator('.public-assets-summary').click();
  await requirements
    .getByText('Using 1 matching imported version for this play session. Saved references are unchanged.', {
      exact: true,
    })
    .waitFor();
  await requirements.getByText('Unavailable asset versions (1)', { exact: true }).waitFor();
  const persistedTexture = await localPage.evaluate(async id => {
    const path = '/src/app/state/local-projects.ts';
    const { readLocalProject } = await import(/* @vite-ignore */ path);
    return (await readLocalProject(id)).document.quadTex[0];
  }, localMap.id);
  assert.equal(persistedTexture, `${oldTexture}/tile.png`, 'compatible playback preserves saved pinned references');
  const stableSummary = await localPage.locator('.public-assets-summary').elementHandle();
  await localPage.evaluate(async () => {
    const path = '/src/app/net/asset-versions.ts';
    const { reportImportedAssetReplacements, importedAssetReplacements } = await import(/* @vite-ignore */ path);
    reportImportedAssetReplacements(importedAssetReplacements());
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  assert(await stableSummary!.evaluate(el => el.isConnected), 'live asset counts retain the active toggle node');
  assert.notEqual(await localPage.locator('.public-requirements-host').getAttribute('open'), null);
  await localPage.setViewportSize({ width: 320, height: 700 });
  const popup = await requirements.boundingBox();
  assert(popup && popup.x >= 0 && popup.x + popup.width <= 320, 'live missing-version details stay on a narrow screen');
  await localPage.setViewportSize({ width: 1440, height: 1000 });
  await requirements.press('Escape');
  assert.equal(
    await localPage.locator('.public-assets-summary').evaluate(el => window.document.activeElement === el),
    true,
    'closing live asset diagnostics returns focus to its summary',
  );
  await localPage.locator('.public-assets-summary').click();
  await requirements.getByText('SSX Tricky · Garibaldi · Loaded', { exact: true }).waitFor();
  await requirements.getByText('SSX Tricky · Snowdream · Not loaded', { exact: true }).waitFor();
  const loadMaps = requirements.getByRole('link', { name: 'Load ISO maps' });
  assert.equal(new URL((await loadMaps.getAttribute('href'))!).searchParams.get('local'), localMap.id);
  await loadMaps.click();
  const libraryRequirements = localPage.getByRole('heading', { name: 'Required maps', exact: true }).locator('..');
  await libraryRequirements.waitFor();
  await libraryRequirements.getByText('SSX Tricky · Garibaldi · Loaded', { exact: true }).waitFor();
  await libraryRequirements.getByText('SSX Tricky · Snowdream · Not loaded', { exact: true }).waitFor();
  assert.equal(new URL(localPage.url()).searchParams.get('local'), localMap.id);
  await localPage.goto(vite.resolvedUrls!.local[0] + '?view=private');
  const localCard = localPage.getByRole('article', { name: localMap.name, exact: true });
  const localRequirements = localCard.locator('.public-map-requirements');
  await localRequirements.getByText('Missing requirements (2)', { exact: true }).click();
  await localRequirements.getByText('SSX Tricky · Snowdream · Not loaded', { exact: true }).waitFor();
  await localRequirements.getByText('LOCAL_SOURCE · Source map assets needed', { exact: true }).waitFor();
  assert.equal(
    new URL(localPage.url()).searchParams.get('view'),
    'private',
    'expanding requirements stays in the library',
  );
  assert.equal(
    new URL(
      (await localRequirements.getByRole('link', { name: 'Load ISO maps' }).getAttribute('href'))!,
    ).searchParams.get('local'),
    localMap.id,
  );
  await localPage.setViewportSize({ width: 390, height: 844 });
  assert(
    await localPage.evaluate(() => window.document.body.scrollWidth <= innerWidth),
    'expanded requirements fit a phone',
  );
  await localPage.close();
  const serverPage = await browser.newPage();
  const inspected: string[] = [];
  serverPage.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/projects/')) inspected.push(request.url());
  });
  await serverPage.goto(vite.resolvedUrls!.local[0] + '?view=private');
  const serverCard = serverPage.getByRole('article', { name: privateMap.project.name, exact: true });
  await serverCard.getByText('Check requirements', { exact: true }).waitFor();
  assert.equal(inspected.length, 0, 'listing private maps does not fetch every full document');
  await serverCard.getByText('Check requirements', { exact: true }).click();
  await serverCard.getByText('Requirements met', { exact: true }).waitFor();
  await serverCard.getByText('SSX Tricky · Garibaldi · Loaded', { exact: true }).waitFor();
  assert.equal(new URL(serverPage.url()).searchParams.get('view'), 'private');
  const missingCard = serverPage.getByRole('article', {
    name: missingServerMap.project.name.replace(/_/g, ' '),
    exact: true,
  });
  await missingCard.getByText('Check requirements', { exact: true }).click();
  await missingCard.getByText('Missing requirements (1)', { exact: true }).waitFor();
  await missingCard.getByText('SSX Tricky · Snowdream · Not loaded', { exact: true }).waitFor();
  await serverPage.close();
  console.log(
    'PASS: player lighting/fog, downloaded map requirements, partial ISO cache and custom source-map diagnostics.',
  );
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
