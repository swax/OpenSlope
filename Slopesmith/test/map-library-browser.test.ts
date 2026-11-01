import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';
import type { PublicCourse } from '../src/core/session/public-courses';
import { encodePng } from '../src/server/routes/png';

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
const otherFolder = join(root, 'Maps', 'Training_Hill');
mkdirSync(join(otherFolder, 'Textures'), { recursive: true });
writeFileSync(
  join(otherFolder, 'Origin.json'),
  JSON.stringify({
    Schema: 'openslope-origin/v1',
    Origin: 'slopesmith',
    RetailData: false,
    Reasons: [],
  }),
);
writeFileSync(
  join(otherFolder, 'Patches.json'),
  JSON.stringify({
    Patches: [
      {
        Points: Array.from({ length: 16 }, (_, i) => [(i % 4) * 1000, Math.floor(i / 4) * 1000, 0]),
        TexturePath: '0000.png',
        LightmapID: -1,
      },
    ],
  }),
);
writeFileSync(
  join(otherFolder, 'Textures', '0000.png'),
  encodePng({ w: 1, h: 1, data: new Uint8Array([64, 128, 192, 255]) }),
);
for (const file of ['Models', 'Materials', 'Instances'])
  writeFileSync(join(otherFolder, `${file}.json`), JSON.stringify({ [file]: [] }));
assert.equal(
  (
    await fetch(`${api.url}/api/publication?kind=reference&id=Training_Hill`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })
  ).status,
  200,
);
const mountain = defaultMountain();
await fetch(`${api.url}/api/projects`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'PRIVATE_LINES', document: mountain }),
});
const courses: PublicCourse[] = [
  ['TRICKY_GARI', 'Garibaldi'],
  ['TRICKY_SNOW', 'Snowdream'],
  ['SSX_SNOW', 'Snowdream'],
  ['SSX3_PEAK1', 'Peak One'],
  ['SSXOT_SNOW', 'On Tour'],
  ['AVALANCHE_CRS00_00', 'Crystal Lake'],
  ['MADTRIX_AN_ANTARTICA', 'Antarctica'],
  ['SSXGBA_GARIBALDI', 'Garibaldi'],
].map(([id, name]) => ({ id, name, kind: 'reference', source: 'server', retailData: true, isoCourses: [id] }));
courses.push({ id: 'published-lines', name: 'PUBLIC LINES', kind: 'project', retailData: false, isoCourses: [] });
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
await page.route('**/api/reference-maps', route => route.fulfill({ json: { maps: [] } }));
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
  assert.equal(await page.getByRole('region', { name: 'References' }).getByRole('button').count(), 8);
  assert(await page.getByRole('heading', { name: 'References', exact: true }).isVisible());
  const loadMap = page.getByRole('button', { name: 'Load map', exact: true });
  const loadMapPanel = page.getByRole('group', { name: 'Load map', exact: true });
  const newMapBounds = await page.getByRole('button', { name: 'New map', exact: true }).boundingBox();
  const loadMapBounds = await loadMap.boundingBox();
  assert(
    newMapBounds && loadMapBounds && loadMapBounds.x >= newMapBounds.x + newMapBounds.width,
    'Load map sits to the right of New map',
  );
  await loadMap.focus();
  await page.keyboard.press('ArrowDown');
  await loadMapPanel.waitFor();
  assert(
    await loadMapPanel
      .getByRole('button', { name: 'Import from file', exact: true })
      .evaluate(button => button === document.activeElement),
  );
  assert(await loadMapPanel.getByRole('button', { name: 'Link folder', exact: true }).isEnabled());
  await page.keyboard.press('Escape');
  await loadMapPanel.waitFor({ state: 'hidden' });
  assert(await loadMap.evaluate(button => button === document.activeElement));
  assert.equal(await page.locator('.library-folder, .public-import-mountain').count(), 0);
  assert.equal(await page.locator('.library-actions').getByRole('button', { name: 'Load', exact: true }).count(), 0);
  const primary = page.getByRole('navigation', { name: 'Primary', exact: true });
  const more = page.getByRole('button', { name: 'More', exact: true });
  const morePanel = page.getByRole('region', { name: 'More links', exact: true });
  assert(await primary.getByRole('link', { name: 'Help', exact: true }).isVisible());
  for (const width of [320, 375, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await more.waitFor();
    assert.equal((await page.locator('.public-header').boundingBox())?.height, 48);
    assert.deepEqual(await primary.getByRole('link').allTextContents(), ['Library', 'Editor']);
    assert(await page.locator('.public-users-icon').isVisible());
    assert(await page.locator('.public-users-toggle .public-online-label').isHidden());
    const targets = await page
      .locator('.public-header a.public-brand, .public-navigation > a, .public-about > summary, .public-users-toggle')
      .evaluateAll(items =>
        items
          .map(item => item.getBoundingClientRect())
          .filter(rect => rect.width > 0)
          .map(rect => ({ left: rect.left, right: rect.right, bottom: rect.bottom })),
      );
    assert(
      targets.every(
        (rect, index) =>
          rect.left >= 0 &&
          rect.right <= width &&
          rect.bottom <= 48 &&
          (!index || rect.left >= targets[index - 1].right),
      ),
      `header targets fit at ${width}`,
    );
    await more.click();
    await morePanel.waitFor();
    assert(await morePanel.getByRole('link', { name: 'Help', exact: true }).isVisible());
    assert(await morePanel.getByRole('link', { name: 'GitHub', exact: true }).isVisible());
    assert(await morePanel.getByRole('link', { name: 'Discord', exact: true }).isVisible());
    assert.equal(await morePanel.getByRole('link', { name: /^Return to / }).count(), 0);
    const panel = await morePanel.boundingBox();
    assert(panel && panel.x >= 0 && panel.x + panel.width <= width && panel.y + panel.height <= 800);
    await page.screenshot({ path: join(root, `library-header-more-${width}.png`) });
    await more.press('Escape');
    await morePanel.waitFor({ state: 'hidden' });
    assert(await more.evaluate(button => button === document.activeElement));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'About Slopesmith', exact: true }).waitFor();
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
  const sourceFilters = page.getByRole('group', { name: 'Filter map sources', exact: true });
  const sourceButton = (label: string) => sourceFilters.getByRole('button', { name: new RegExp(`^${label} \\(`) });
  assert.equal(await sourceButton('All maps').getAttribute('aria-pressed'), 'true');
  assert.equal(await sourceButton('Local').innerText(), 'Local (1)');
  await sourceButton('Server').click();
  assert.equal(await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).isVisible(), false);
  assert(await page.getByRole('article', { name: 'PRIVATE LINES', exact: true }).isVisible());
  assert(await page.locator('.public-course[data-course="SSXGBA_GARIBALDI"]').isVisible());
  await sourceButton('All maps').click();
  await search.fill('GBA');
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 1);
  await search.fill('garibaldi');
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 2);
  await search.fill('');
  await sourceButton('Local').click();
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 1);
  assert.equal(await sourceButton('Local').getAttribute('aria-pressed'), 'true');
  await sourceButton('All maps').click();
  const publicView = page.getByRole('button', { name: 'Public', exact: true });
  const privateView = page.getByRole('button', { name: 'Private', exact: true });
  const allView = page
    .getByRole('navigation', { name: 'Library views' })
    .getByRole('button', { name: 'All maps', exact: true });
  assert.equal(await allView.locator('.library-game-count').innerText(), '10');
  assert.equal(await publicView.locator('.library-game-count').innerText(), '8');
  assert.equal(await privateView.locator('.library-game-count').innerText(), '2');
  assert.equal(await page.getByRole('button', { name: 'Custom maps', exact: true }).count(), 0);
  assert(
    await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).locator('.library-map-origin').isVisible(),
  );
  await publicView.click();
  assert(await page.getByRole('article', { name: 'PUBLIC LINES', exact: true }).isVisible());
  assert(
    await page.getByRole('article', { name: 'PUBLIC LINES', exact: true }).locator('.library-map-origin').isHidden(),
  );
  assert(await page.getByRole('article', { name: 'PRIVATE LINES', exact: true }).isHidden());
  assert(await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).isHidden());
  assert.equal(await sourceButton('Local').innerText(), 'Local (0)');
  assert.equal(await sourceButton('Server').innerText(), 'Server (8)');
  assert.equal(
    await page
      .getByRole('article', { name: 'PUBLIC LINES', exact: true })
      .getByRole('img', { name: 'Available on server', exact: true })
      .getAttribute('data-visibility'),
    'public',
  );
  assert.equal(
    await page
      .getByRole('article', { name: 'PUBLIC LINES', exact: true })
      .getByRole('img', { name: 'Available on server', exact: true })
      .locator('ellipse')
      .count(),
    1,
    'public maps use a globe',
  );
  await page.reload();
  await page.getByRole('article', { name: 'PUBLIC LINES', exact: true }).waitFor();
  assert.equal(await publicView.getAttribute('aria-pressed'), 'true', 'visibility survives reload');
  await page.goto(origin + '/?view=custom');
  await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).waitFor();
  assert.equal(await privateView.getAttribute('aria-pressed'), 'true', 'old custom-view bookmarks open Private');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'private');
  assert(
    await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).locator('.library-map-origin').isHidden(),
  );
  assert(
    await page.getByRole('article', { name: 'PRIVATE LINES', exact: true }).locator('.library-map-origin').isHidden(),
  );
  assert(await page.getByRole('article', { name: 'PUBLIC LINES', exact: true }).isHidden());
  assert.equal(
    await page
      .getByRole('article', { name: 'PRIVATE LINES', exact: true })
      .getByRole('img', { name: 'Available on server', exact: true })
      .getAttribute('data-visibility'),
    'private',
  );
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 2);
  assert.equal(await sourceButton('All maps').innerText(), 'All maps (2)');
  assert.equal(await sourceButton('Local').innerText(), 'Local (1)');
  assert.equal(await sourceButton('Server').innerText(), 'Server (1)');
  await sourceButton('Server').click();
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 1);
  assert(await page.getByRole('article', { name: 'PRIVATE LINES', exact: true }).isVisible());
  await search.fill('MOUNTAIN01');
  assert.equal(
    await allView.locator('.library-game-count').innerText(),
    '10',
    'All maps totals include game maps despite filters',
  );
  assert.equal(await publicView.locator('.library-game-count').innerText(), '8', 'sidebar totals ignore search');
  assert.equal(await privateView.locator('.library-game-count').innerText(), '2');
  assert.equal(await sourceButton('Local').innerText(), 'Local (1)');
  assert.equal(await sourceButton('Server').innerText(), 'Server (0)');
  await page.getByRole('heading', { name: 'No maps found', exact: true }).waitFor();
  await sourceButton('Local').focus();
  await page.keyboard.press('Space');
  assert(await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).isVisible());
  assert.equal(await sourceButton('Local').getAttribute('aria-pressed'), 'true');
  await search.fill('does not exist');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await search.inputValue(), '');
  assert.equal(await sourceButton('All maps').getAttribute('aria-pressed'), 'true');
  await privateView.click();
  await page.setViewportSize({ width: 375, height: 900 });
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  await loadMap.click();
  await loadMapPanel.waitFor();
  assert(
    await loadMapPanel.evaluate(panel => {
      const rect = panel.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }),
  );
  await page.screenshot({ path: join(root, 'library-load-map-mobile.png') });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(root, 'library-private-source-filters-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/reference-maps', route =>
    route.fulfill({
      json: {
        maps: [
          { name: 'TRICKY_GARI', course: 'TRICKY_GARI', displayName: 'Garibaldi' },
          { name: 'TRICKY_MESA', course: 'TRICKY_MESA', displayName: 'Mesablanca' },
        ],
      },
    }),
  );
  await page
    .getByRole('navigation', { name: 'Library views' })
    .getByRole('button', { name: 'All maps', exact: true })
    .click();
  await page.evaluate(() => localStorage.setItem('slopesmith.library.layout', 'cards'));
  await page.reload();
  await page.locator('.public-iso-map[data-course="TRICKY_MESA"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reference maps', exact: true }).count(), 0);
  assert.equal(await page.getByRole('group', { name: 'Map layout' }).count(), 0);
  assert.equal(
    await page.locator('.map-library').getAttribute('data-layout'),
    'list',
    'old card preferences are ignored',
  );
  assert.equal(
    await page.locator('.public-course[data-course="TRICKY_GARI"]').count(),
    1,
    'public and installed references share a row',
  );
  const serverMap = page.locator('.public-course[data-course="TRICKY_MESA"]');
  assert(await serverMap.getByRole('img', { name: 'Available on server', exact: true }).isVisible());
  assert.equal(
    await serverMap.getByRole('img', { name: 'Available on server', exact: true }).locator('ellipse').count(),
    0,
    'private references keep their cloud',
  );
  assert.equal(
    await serverMap.getByRole('img', { name: 'Available from disc or local import', exact: true }).count(),
    0,
  );
  await privateView.click();
  assert(await serverMap.isHidden(), 'unpublished game references stay out of private custom maps');
  assert(await page.locator('.public-course[data-course="TRICKY_GARI"]').isHidden());
  await publicView.click();
  assert(await serverMap.isHidden(), 'unpublished references stay out of Public');
  assert(await page.locator('.public-course[data-course="TRICKY_GARI"]').isVisible());
  const game = page.getByRole('button', { name: 'SSX Tricky (GBA)', exact: true });
  await game.click();
  const loadGame = page.getByRole('button', { name: 'Load GBA ROM…', exact: true });
  assert(await loadGame.isVisible(), 'a game with only server maps can load its local image');
  assert(await page.locator('.library-game-actions').isHidden());
  const loadHeading = page.locator('.library-context').getByRole('heading', { name: 'SSX Tricky (GBA)', exact: true });
  const loadHeadingBounds = await loadHeading.boundingBox();
  const loadBounds = await loadGame.boundingBox();
  assert(
    loadHeadingBounds &&
      loadBounds &&
      loadBounds.x >= loadHeadingBounds.x + loadHeadingBounds.width &&
      loadBounds.x - loadHeadingBounds.x - loadHeadingBounds.width < 24,
    'Load sits beside the selected game name',
  );
  await page.setViewportSize({ width: 375, height: 900 });
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(root, 'library-game-load-mobile.png') });
  const chooseGame = page.waitForEvent('filechooser');
  await loadGame.click();
  await (await chooseGame).setFiles(gba);
  await page.locator('.public-iso-status').filter({ hasText: '8 maps found' }).waitFor({ timeout: 90_000 });
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(new URL(page.url()).searchParams.get('game'), 'tricky-gba');
  assert.equal(await game.getAttribute('aria-pressed'), 'true');
  assert(await loadGame.isHidden(), 'a saved image switches Load to the actions menu before extracting maps');
  assert(await page.getByRole('button', { name: 'Game actions for SSX Tricky (GBA)', exact: true }).isVisible());
  assert(await sourceFilters.isHidden(), 'source filters only appear in All, Public and Private views');
  assert(await page.getByRole('group', { name: 'Filter ISO maps', exact: true }).isVisible());
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
  assert(await card.locator('.public-iso-badge').isHidden(), 'unloaded maps have no status badge');
  await card.getByRole('button', { name: 'Load local Garibaldi', exact: true }).click();
  await card.locator('.public-iso-badge.loading').waitFor();
  assert.deepEqual(await geometry(), beforeImport, 'loading keeps list rows stable');
  await page.evaluate(() => (window as typeof window & { releaseLibraryImport: () => void }).releaseLibraryImport());
  await card
    .getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true })
    .waitFor({ state: 'attached', timeout: 90_000 });
  assert.deepEqual(await geometry(), beforeImport, 'loaded actions keep list rows stable');
  assert(await card.locator('.public-iso-badge').isHidden(), 'loaded maps have no status badge');
  const rowActions = card.getByRole('button', { name: 'Map actions for Garibaldi', exact: true });
  const rowPanel = card.getByRole('group', { name: 'Map actions for Garibaldi', exact: true });
  assert.equal(await card.getByRole('button', { name: 'Unload Garibaldi', exact: true }).count(), 0);
  await rowActions.focus();
  await page.keyboard.press('ArrowDown');
  await rowPanel.waitFor();
  assert(
    await rowPanel
      .getByRole('button', { name: 'Unload Garibaldi', exact: true })
      .evaluate(button => button === document.activeElement),
  );
  assert(await rowPanel.getByRole('button', { name: 'Upload as reference', exact: true }).isVisible());
  assert(
    await rowPanel.getByRole('button', { name: 'Upload as reference', exact: true }).evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }),
    'neighboring rows do not cover the map menu',
  );
  assert(
    await rowPanel.evaluate(panel => {
      const rect = panel.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }),
  );
  await page.screenshot({ path: join(root, 'library-map-actions-mobile.png') });
  await page.keyboard.press('Escape');
  assert(await rowActions.evaluate(button => button === document.activeElement));
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(
    new URL(
      (await card.getByRole('link', { name: 'Play Garibaldi', exact: true }).getAttribute('href'))!,
    ).searchParams.get('source'),
    'iso',
  );
  assert.equal(await card.getByRole('img', { name: 'Available from disc or local import', exact: true }).count(), 1);
  assert.equal(await card.getByRole('img', { name: 'Available on server', exact: true }).count(), 1);
  assert.equal(
    await card.getByRole('img', { name: 'Available on server', exact: true }).locator('ellipse').count(),
    1,
    'public references use a globe beside the disc',
  );
  await page
    .getByRole('navigation', { name: 'Library views' })
    .getByRole('button', { name: 'All maps', exact: true })
    .click();
  assert.equal(
    await page.locator('.public-course[data-course="SSXGBA_GARIBALDI"]').count(),
    1,
    'local and server copies share a row in All maps',
  );
  await privateView.click();
  assert(await card.isHidden(), 'loaded game maps stay out of private custom maps');
  assert.equal(await page.locator('.public-iso-map:visible').count(), 0);
  assert.equal(await sourceButton('All maps').innerText(), 'All maps (2)');
  assert.equal(await sourceButton('Local').innerText(), 'Local (1)');
  assert.equal(await sourceButton('Server').innerText(), 'Server (1)');
  assert.equal(
    await privateView.locator('.library-game-count').innerText(),
    '2',
    'game imports do not add private maps',
  );
  assert.equal(
    await allView.locator('.library-game-count').innerText(),
    '18',
    'All maps counts local and server copies once',
  );
  await sourceButton('Server').click();
  assert(await card.isHidden());
  assert(await page.getByRole('article', { name: 'PRIVATE LINES', exact: true }).isVisible());
  await sourceButton('Local').click();
  assert(await card.isHidden());
  assert(await page.getByRole('article', { name: 'MOUNTAIN01', exact: true }).isVisible());
  await publicView.click();
  await sourceButton('All maps').click();
  assert(await card.isVisible(), 'the published server copy is also available under Public');
  assert.equal(await sourceButton('Local').innerText(), 'Local (0)');
  await page
    .getByRole('navigation', { name: 'Library views' })
    .getByRole('button', { name: 'All maps', exact: true })
    .click();
  await sourceButton('Server').click();
  assert(await card.isVisible(), 'a map with both copies matches the server source');
  await sourceButton('Local').click();
  assert(await card.isVisible(), 'the same row also matches the device source');
  // A Local choice in All maps must not filter the game view's server-only courses.
  await game.click();
  assert(await sourceFilters.isHidden());
  assert(await serverMap.isHidden(), 'other games remain excluded by the selected game');
  await page.getByRole('button', { name: 'SSX Tricky', exact: true }).click();
  assert(await serverMap.isVisible(), 'visibility and location choices do not leak into game browsing');
  assert(await page.getByRole('button', { name: 'Load PS2 image…', exact: true }).isVisible());
  await game.click();
  await search.fill('snowdream');
  assert.equal(await page.locator('.public-iso-map:visible').count(), 1);
  await search.fill('not a course');
  await page.getByText('No courses match “not a course”.', { exact: true }).waitFor();
  await search.fill('');
  await page.getByRole('heading', { name: 'Map library', exact: true }).click();
  await page.screenshot({ path: join(root, 'library-game-desktop.png') });
  for (const width of [320, 375, 600, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth), `overflow at ${width}`);
    if (width <= 600) {
      const snowdreamTitle = await page.locator('.public-iso-map[data-course="SSXGBA_SNOWDREAM"] h3').boundingBox();
      assert(snowdreamTitle && snowdreamTitle.height < 30, `mobile titles retain room at ${width}`);
      await page.screenshot({ path: join(root, `library-game-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await page.screenshot({ path: join(root, 'library-game-mobile.png') });
  const returnHref = (await card.getByRole('link', { name: 'Play Garibaldi', exact: true }).getAttribute('href'))!;
  const returnEditor = (await card.getByRole('link', { name: 'Inspect Garibaldi', exact: true }).getAttribute('href'))!;
  await page.evaluate(
    async ({ href, editorHref }) => {
      const path = '/src/app/public/last-map.ts';
      (await import(/* @vite-ignore */ path)).rememberPublicMap('Garibaldi', href, editorHref, ['SSXGBA_GARIBALDI']);
    },
    { href: returnHref, editorHref: returnEditor },
  );
  await page.goto(origin + '/isos');
  await page.getByRole('heading', { name: 'Map library', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await page
    .getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true })
    .waitFor({ state: 'attached' });
  await page.goto(origin + '/maps');
  await page.getByRole('heading', { name: 'Map library', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await more.click();
  const returnMap = morePanel.getByRole('link', { name: 'Return to Garibaldi', exact: true });
  assert.equal(await returnMap.getAttribute('href'), returnHref);
  assert(await primary.getByRole('link', { name: 'Garibaldi', exact: true }).isHidden());
  await page.screenshot({ path: join(root, 'library-header-return-map-mobile.png') });
  await more.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert(await primary.getByRole('link', { name: 'Garibaldi', exact: true }).isVisible());
  await page.screenshot({ path: join(root, 'library-all-desktop.png') });
  assert(await page.locator('.library-game-actions').isHidden(), 'game actions stay out of All maps');
  await game.click();
  const gameActions = page.getByRole('button', { name: 'Game actions for SSX Tricky (GBA)', exact: true });
  const actionsPanel = page.getByRole('group', { name: 'Game actions for SSX Tricky (GBA)', exact: true });
  assert.equal(await gameActions.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByRole('button', { name: 'Refresh image', exact: true }).count(), 0);
  const gameHeading = page.locator('.library-context').getByRole('heading', { name: 'SSX Tricky (GBA)', exact: true });
  const headingBounds = await gameHeading.boundingBox();
  const triggerBounds = await gameActions.boundingBox();
  assert(
    headingBounds &&
      triggerBounds &&
      triggerBounds.x >= headingBounds.x + headingBounds.width &&
      triggerBounds.x - headingBounds.x - headingBounds.width < 24,
    'the menu sits beside the selected game name',
  );
  await gameActions.focus();
  await page.keyboard.press('Enter');
  await actionsPanel.waitFor();
  for (const name of ['Refresh image', 'Remove image…', 'Unload game…'])
    assert(await actionsPanel.getByRole('button', { name, exact: true }).isEnabled());
  await page.keyboard.press('Escape');
  await actionsPanel.waitFor({ state: 'hidden' });
  assert(
    await gameActions.evaluate(button => button === document.activeElement),
    'Escape returns focus to the menu trigger',
  );
  await gameActions.focus();
  await page.keyboard.press('Space');
  await actionsPanel.waitFor();
  await gameHeading.click();
  await actionsPanel.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 375, height: 900 });
  await gameActions.click();
  await actionsPanel.waitFor();
  assert(
    await actionsPanel.evaluate(panel => {
      const rect = panel.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }),
    'the menu fits the mobile viewport',
  );
  await page.screenshot({ path: join(root, 'library-game-actions-mobile.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gameActions.evaluate(button => button.focus({ preventScroll: true }));
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.keyboard.press('ArrowDown');
  assert(
    await actionsPanel
      .getByRole('button', { name: 'Refresh image', exact: true })
      .evaluate(button => button === document.activeElement),
    'ArrowDown enters the menu',
  );
  await page.keyboard.press('Enter');
  await page.locator('.public-iso-status').filter({ hasText: 'Course names refreshed.' }).waitFor({ timeout: 90_000 });
  await actionsPanel.waitFor({ state: 'hidden' });
  await card
    .getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true })
    .waitFor({ state: 'attached' });
  await gameActions.click();
  await actionsPanel.getByRole('button', { name: 'Unload game…', exact: true }).click();
  const unloadGame = page.getByRole('alertdialog', { name: 'Unload SSX Tricky (GBA)?', exact: true });
  await unloadGame.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card
    .getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true })
    .waitFor({ state: 'attached' });
  await gameActions.click();
  await actionsPanel.getByRole('button', { name: 'Remove image…', exact: true }).click();
  const removeImage = page.getByRole('alertdialog', { name: 'Remove SSX Tricky (GBA) image?', exact: true });
  await removeImage.getByRole('button', { name: 'Cancel', exact: true }).click();
  await gameActions.click();
  await actionsPanel.getByRole('button', { name: 'Remove image…', exact: true }).click();
  await removeImage.getByRole('button', { name: 'Remove image', exact: true }).click();
  await page.locator('.public-iso-status').filter({ hasText: 'image removed. Imported courses are kept.' }).waitFor();
  await card
    .getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true })
    .waitFor({ state: 'attached' });
  await gameActions.click();
  assert.equal(await actionsPanel.getByRole('button', { name: 'Refresh image', exact: true }).count(), 0);
  assert.equal(await actionsPanel.getByRole('button', { name: 'Remove image…', exact: true }).count(), 0);
  const restoreImage = page.waitForEvent('filechooser');
  await actionsPanel.getByRole('button', { name: 'Load GBA ROM…', exact: true }).click();
  await (await restoreImage).setFiles([]);
  await card
    .getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true })
    .waitFor({ state: 'attached' });
  await gameActions.click();
  await actionsPanel.getByRole('button', { name: 'Unload game…', exact: true }).click();
  await unloadGame.getByRole('button', { name: 'Unload game', exact: true }).click();
  await page.locator('.public-iso-status').filter({ hasText: 'SSX Tricky (GBA) unloaded.' }).waitFor();
  await gameActions.waitFor({ state: 'hidden' });
  await loadGame.waitFor();
  await page.setViewportSize({ width: 375, height: 900 });
  await more.click();
  assert.equal(
    await morePanel.getByRole('link', { name: /^Return to / }).count(),
    0,
    'unloading also removes the mobile return link',
  );
  await more.press('Escape');
  assert(
    await page.evaluate(async () => {
      const path = '/src/app/state/local-projects.ts';
      return (await (await import(/* @vite-ignore */ path)).listLocalProjects()).some(
        (project: { name: string }) => project.name === 'MOUNTAIN01',
      );
    }),
    'game actions preserve custom mountains',
  );
  const borrowed = courses.find(course => course.id === 'published-lines')!;
  borrowed.retailData = true;
  borrowed.isoCourses = ['GARI'];
  await page.goto(origin + '/?view=public');
  const borrowedCard = page.getByRole('article', { name: 'PUBLIC LINES', exact: true });
  const requirement = borrowedCard.locator('.public-iso-badge');
  await requirement.waitFor();
  assert.equal(await borrowedCard.locator('.public-requirements').innerText(), 'Game assets missing');
  assert.equal(await requirement.innerText(), 'SSX Tricky · Garibaldi · Not loaded');
  assert(await requirement.isVisible(), 'single-map dependencies stay visible in the list');
  assert(await borrowedCard.getByRole('button', { name: 'Play PUBLIC LINES', exact: true }).isEnabled());
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await requirement.isVisible(), `the game and source map remain visible at ${width}px`);
    assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
    await borrowedCard.screenshot({ path: join(root, `library-required-map-${width}.png`) });
  }
  await page.evaluate(async () => {
    const path = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction, isoCourseCacheVersion } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../src/app/public/iso-cache');
    const db = await openIsoCache();
    try {
      await cacheTransaction(db, 'courses', 'readwrite', store =>
        store.put({ course: 'TRICKY_GARI', version: isoCourseCacheVersion('TRICKY_GARI'), files: 1 }),
      );
    } finally {
      db.close();
    }
  });
  await page.reload();
  await requirement.waitFor();
  assert.equal(await requirement.innerText(), 'SSX Tricky · Garibaldi · Loaded');
  assert.equal(await borrowedCard.locator('.public-requirements').count(), 0, 'a new extract satisfies an old map');
  assert.equal(await borrowedCard.getByRole('link', { name: 'Load ISO maps', exact: true }).count(), 0);
  await page.evaluate(async () => {
    const modulePath = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction } = await import(/* @vite-ignore */ modulePath);
    const db = await openIsoCache();
    try {
      await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
        store.put({ course: 'GARI', version: 1, files: 1 }),
      );
    } finally {
      db.close();
    }
  });
  courses.push({
    id: 'Training_Hill',
    name: 'Training Hill',
    kind: 'reference',
    source: 'server',
    retailData: false,
    isoCourses: [],
  });
  let installedOther = [
    { name: 'TRICKY_GARI', course: 'TRICKY_GARI', origin: 'retail', game: 'ssx-tricky' },
    { name: 'Training_Hill', course: 'Training_Hill', origin: 'slopesmith', retailData: false },
    { name: 'MYSTERY', course: 'MYSTERY' },
    { name: 'TRICKY_OUR_HILL', course: 'TRICKY_OUR_HILL', origin: 'slopesmith', retailData: false },
    { name: 'GARI', course: 'GARI', displayName: 'Practice Gari', origin: 'slopesmith', retailData: false },
  ];
  const removedReferences: string[] = [];
  await page.route('**/api/reference-maps', route => route.fulfill({ json: { maps: installedOther } }));
  await page.route('**/api/reference-maps/maps/*', async route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    removedReferences.push(name);
    installedOther = installedOther.filter(map => map.name !== name);
    await route.fulfill({ json: { removed: true } });
  });
  await page.goto(origin + '/?view=other');
  const otherView = page.getByRole('button', { name: 'Other', exact: true });
  const training = page.getByRole('article', { name: 'Training Hill', exact: true });
  await training.waitFor();
  assert.equal(await otherView.getAttribute('aria-pressed'), 'true');
  assert.equal(await otherView.locator('.library-game-count').innerText(), '4');
  assert.equal(await page.locator('.library-catalogue .public-course:visible').count(), 4);
  assert(await page.getByRole('article', { name: 'Practice Gari', exact: true }).isVisible());
  const mystery = page.getByRole('article', { name: 'MYSTERY', exact: true });
  assert.equal(
    new URL(
      (await mystery.getByRole('link', { name: 'Inspect MYSTERY', exact: true }).getAttribute('href'))!,
    ).searchParams.get('reference'),
    'MYSTERY',
  );
  assert.equal(await training.getByRole('button', { name: /Load local/ }).count(), 0);
  assert(await page.getByRole('button', { name: 'Load PS2 image…', exact: true }).isHidden());
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await otherView.isVisible());
    assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(root, `library-other-references-${width}.png`) });
  }
  await page.getByRole('button', { name: 'SSX Tricky', exact: true }).click();
  assert(await page.getByRole('article', { name: 'Garibaldi', exact: true }).isVisible());
  assert.equal(await page.getByRole('article', { name: 'Practice Gari', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('article', { name: 'TRICKY_OUR_HILL', exact: true }).count(),
    0,
    'authored names do not imply a game',
  );
  installedOther = installedOther.filter(map => map.name !== 'TRICKY_GARI');
  await page.reload();
  const localGari = page.getByRole('article', { name: 'Garibaldi', exact: true });
  await localGari.waitFor();
  await localGari.getByRole('button', { name: 'Map actions for Garibaldi', exact: true }).click();
  assert(
    await localGari.getByRole('button', { name: 'Upload as reference', exact: true }).isVisible(),
    'a same-name authored reference is not the installed reference for a local game map',
  );
  assert.equal(await localGari.getByRole('button', { name: 'Remove reference from server', exact: true }).count(), 0);
  await otherView.click();
  await page.reload();
  await training.waitFor();
  assert.equal(await otherView.getAttribute('aria-pressed'), 'true');
  await mystery.getByRole('button', { name: 'Map actions for MYSTERY', exact: true }).click();
  await mystery.getByRole('button', { name: 'Remove reference from server', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(removedReferences, []);
  await mystery.getByRole('button', { name: 'Map actions for MYSTERY', exact: true }).click();
  await mystery.getByRole('button', { name: 'Remove reference from server', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove reference', exact: true }).click();
  await mystery.waitFor({ state: 'hidden' });
  assert.deepEqual(
    removedReferences,
    ['MYSTERY'],
    'management uses the physical server folder without a Tricky prefix',
  );
  assert.equal(await otherView.locator('.library-game-count').innerText(), '3');
  const serverTexture = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/texture' && url.searchParams.get('level') === 'Training_Hill';
  });
  await training.getByRole('link', { name: 'Play Training Hill', exact: true }).click();
  assert.equal((await serverTexture).status(), 200, 'clean server references use their server textures');
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.deepEqual(errors, []);
  console.log(
    'MAP LIBRARY PASS: public/private visibility, local and published copies, source counts, legacy views, games, imports, reload and responsive layouts. ' +
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
