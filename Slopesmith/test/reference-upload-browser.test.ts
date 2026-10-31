import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { addUser } from '../src/server/accounts/users';
import { startSession } from '../src/server/accounts/sessions';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-reference-upload-browser-'));
const maps = join(root, 'Maps');
await mkdir(maps);
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = maps;
forgetWorkspaceConfig();
forgetAccounts();
const admin = await addUser({
  username: 'admin',
  password: 'reference browser password',
  role: 'admin',
  inviteHandle: 'test:admin',
});
const editor = await addUser({
  username: 'editor',
  password: 'reference browser password',
  role: 'editor',
  inviteHandle: 'test:editor',
});
const adminSession = await startSession(admin.id),
  editorSession = await startSession(editor.id);
const image = join(root, 'tricky.iso');
execFileSync(
  process.platform === 'win32' ? 'python' : 'python3',
  [
    '-c',
    [
      'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
      'from audio_import_test import disc,fixture',
      'from import_test import big',
      'from prop_import_test import members',
      "files=fixture(); files.pop('DATA/MODELS/FIXTURE.BIG')",
      "for slot in ['gari','snow','mesa']: files[f'DATA/MODELS/{slot.upper()}.BIG']=big({name.replace('fixture',slot):data for name,data in members().items()})",
      "files={path:data.replace(b'FIXTURE',b'GARI') if path.endswith('.INF') else data for path,data in files.items()}",
      "for path in ['DATA/CONFIG/BANKS.INF','DATA/CONFIG/MUSICMAP.INF','DATA/CONFIG/INTROMUS.INF']: section=files[path].split(b'[TRICK]')[0]; files[path]+=section.replace(b'GARI',b'SNOW')+section.replace(b'GARI',b'MESA')",
      'Path(sys.argv[2]).write_bytes(disc(files))',
    ].join('\n'),
    resolve('../Native/tests'),
    image,
  ],
  { windowsHide: true },
);
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Browser | undefined;
let activePage: Page | undefined;
const errors: string[] = [];
let releaseHeldUpload = () => {};
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await context.addCookies([{ name: 'slopesmith_session', value: adminSession, url: origin }]);
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/isos`);
  await page.locator('#public-iso').setInputFiles(image);
  const card = page.locator('.public-iso-map[data-course="TRICKY_GARI"]');
  await card.getByRole('button', { name: 'Load local Garibaldi', exact: true }).waitFor();
  assert(
    await card.getByRole('button', { name: 'Reference Garibaldi', exact: true }).isHidden(),
    'unloaded maps have no upload action',
  );
  await card.getByRole('button', { name: 'Load local Garibaldi', exact: true }).click();
  await page.waitForFunction(() =>
    ['loaded', 'error'].includes(
      document.querySelector<HTMLElement>('[data-course="TRICKY_GARI"]')?.dataset.state ?? '',
    ),
  );
  assert.equal(await card.getAttribute('data-state'), 'loaded', await card.innerText());
  await card.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor({ timeout: 90_000 });
  const toggle = card.getByRole('button', { name: 'Reference Garibaldi', exact: true });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert(!(await card.getByRole('checkbox', { name: 'Include music' }).isChecked()), 'music is opt-in');
  const snowCard = page.locator('.public-iso-map[data-course="TRICKY_SNOW"]');
  const mesaCard = page.locator('.public-iso-map[data-course="TRICKY_MESA"]');
  await snowCard.getByRole('button', { name: 'Load local Snowdream', exact: true }).click();
  await mesaCard.getByRole('button', { name: 'Load local Mesablanca', exact: true }).click();
  await snowCard.getByRole('button', { name: 'Unload Snowdream', exact: true }).waitFor({ timeout: 90_000 });
  await mesaCard.getByRole('button', { name: 'Unload Mesablanca', exact: true }).waitFor({ timeout: 90_000 });
  const snowToggle = snowCard.getByRole('button', { name: 'Reference Snowdream', exact: true });
  const mesaToggle = mesaCard.getByRole('button', { name: 'Reference Mesablanca', exact: true });
  await snowCard.getByRole('checkbox', { name: 'Include music' }).check();
  const plans: Array<{ course: string; reusedFiles: number; uploadedBytes: number; totalBytes: number }> = [];
  page.on('response', async response => {
    if (
      !response.url().endsWith('/api/reference-maps/uploads') ||
      response.request().method() !== 'POST' ||
      !response.ok()
    )
      return;
    const plan = await response.json();
    const manifest = response.request().postDataJSON() as { course: string; files: Array<{ size: number }> };
    plans.push({
      course: manifest.course,
      reusedFiles: plan.reusedFiles,
      uploadedBytes: plan.missing.reduce((sum: number, index: number) => sum + manifest.files[index].size, 0),
      totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    });
  });
  let receivedChunk!: () => void;
  const received = new Promise<void>(resolve => {
    receivedChunk = resolve;
  });
  const held = new Promise<void>(resolve => {
    releaseHeldUpload = resolve;
  });
  let lostReply = false;
  await page.route('**/api/reference-maps/uploads/*?offset=*', async route => {
    if (lostReply) {
      await route.continue();
      return;
    }
    lostReply = true;
    await route.fetch();
    receivedChunk();
    await held;
    await route.abort('failed');
  });
  await toggle.click();
  await received;
  await snowToggle.click();
  assert.equal(await snowToggle.textContent(), 'Queued', 'another loaded map can queue while an upload is active');
  await page.getByRole('navigation', { name: 'Library views' }).getByRole('button', { name: 'All maps' }).click();
  const loadedMaps = page.locator('.library-catalogue');
  assert.equal(
    await loadedMaps.getByRole('button', { name: 'Reference Garibaldi', exact: true }).textContent(),
    'Cancel upload',
    'the catalogue shares the active upload with the game view',
  );
  assert.equal(
    await loadedMaps.getByRole('button', { name: 'Reference Snowdream', exact: true }).textContent(),
    'Queued',
  );
  await loadedMaps.getByRole('button', { name: 'Reference Mesablanca', exact: true }).click();
  await page.locator('.library-sidebar .public-iso-game[data-game="tricky"]').click();
  assert.equal(await mesaToggle.textContent(), 'Queued', 'catalogue jobs share the same queue with game cards');
  await mesaToggle.click();
  assert.equal(await mesaToggle.textContent(), 'Reference', 'clicking a queued toggle cancels only that map');
  assert.equal(plans.length, 1, 'a queued reference does not negotiate while another upload owns the queue');
  releaseHeldUpload();
  await page.waitForFunction(
    () => document.querySelector('.public-iso-reference')?.getAttribute('aria-pressed') === 'true',
  );
  assert.equal((await readFile(join(maps, 'TRICKY_GARI/Origin.json'), 'utf8')).includes('retail'), true);
  assert((await readdir(join(maps, 'TRICKY_GARI/Source'))).length > 0, 'native sidecars arrive intact');
  await assert.rejects(readdir(join(maps, 'TRICKY_GARI/Audio/Music')), /ENOENT/);
  assert(await card.getByRole('checkbox', { name: 'Include music' }).isHidden());
  await page.waitForFunction(
    () =>
      document.querySelector('[data-course="TRICKY_SNOW"] .public-iso-reference')?.getAttribute('aria-pressed') ===
      'true',
  );
  const snowPlan = plans.find(plan => plan.course === 'TRICKY_SNOW');
  assert(
    snowPlan && snowPlan.reusedFiles > 0 && snowPlan.uploadedBytes < snowPlan.totalBytes,
    'the queued map skips bytes already installed by the preceding map',
  );
  assert(
    (await readdir(join(maps, 'TRICKY_SNOW/Audio/Music'))).length > 0,
    'queued maps retain their own music setting',
  );
  assert.equal(await mesaToggle.getAttribute('aria-pressed'), 'false');
  assert(lostReply, 'the upload recovered after losing an accepted chunk response');
  await page.unroute('**/api/reference-maps/uploads/*?offset=*');
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'server state survives reload');
  await page.goto(`${origin}/maps`);
  const serverReferences = page.locator('.library-catalogue');
  const mapsToggle = serverReferences.getByRole('button', { name: 'Reference Garibaldi', exact: true });
  await mapsToggle.waitFor();
  assert.equal(
    await mapsToggle.getAttribute('aria-pressed'),
    'true',
    'Maps lists installed references even when unpublished',
  );
  await mapsToggle.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove reference', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-course="TRICKY_GARI"] .public-iso-reference')?.getAttribute('aria-pressed') ===
      'false',
  );
  const localMap = page.locator('.library-catalogue');
  const localToggle = localMap.getByRole('button', { name: 'Reference Garibaldi', exact: true });
  await localToggle.waitFor();
  assert.equal(await localToggle.getAttribute('aria-pressed'), 'false');
  await localToggle.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-course="TRICKY_GARI"] .public-iso-reference')?.getAttribute('aria-pressed') ===
      'true',
  );
  assert.equal(await mapsToggle.getAttribute('aria-pressed'), 'true', 'Maps can upload an already extracted local map');
  const publication = await page.request.put(`${origin}/api/publication?kind=reference&id=TRICKY_GARI`, {
    headers: { origin },
    data: { published: true },
  });
  assert(publication.ok(), await publication.text());
  await page.goto(`${origin}/isos`);
  await toggle.waitFor();
  const publishedReference = card.getByRole('img', { name: 'Available on server', exact: true });
  await publishedReference.waitFor();
  await toggle.click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove Garibaldi reference?', exact: true });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'cancel preserves the installed reference');
  await toggle.click();
  await confirm.getByRole('button', { name: 'Remove reference', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.public-iso-reference')?.getAttribute('aria-pressed') === 'false',
  );
  await publishedReference.waitFor({ state: 'hidden' });
  assert(
    await card.getByRole('button', { name: 'Unload Garibaldi', exact: true }).isEnabled(),
    'removal keeps the local map',
  );

  await card.getByRole('checkbox', { name: 'Include music' }).check();
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('.public-iso-reference')?.getAttribute('aria-pressed') === 'true',
  );
  assert((await readdir(join(maps, 'TRICKY_GARI/Audio/Music'))).length > 0, 'opt-in music reaches the server');
  await card.getByRole('button', { name: 'Unload Garibaldi', exact: true }).click();
  await card.getByRole('button', { name: 'Load local Garibaldi', exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'server-only reference remains manageable');
  await page.getByText('Device storage', { exact: true }).click();
  await page.getByRole('button', { name: 'Clear all ISO maps', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Unload all maps', exact: true }).click();
  await page.getByText('0 loaded', { exact: true }).waitFor();
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'server-only card survives without a saved disc');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  await card.screenshot({
    path: process.env.SLOPESMITH_REFERENCE_SCREENSHOT ?? join(root, 'reference-toggle-mobile.png'),
  });
  await toggle.click();
  await confirm.getByRole('button', { name: 'Remove reference', exact: true }).click();
  await card.waitFor({ state: 'detached' });

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
  await page.locator('#public-iso').setInputFiles(gba);
  const gbaCard = page.locator('.public-iso-map[data-course="SSXGBA_GARIBALDI"]');
  await gbaCard.getByRole('button', { name: 'Load local Garibaldi', exact: true }).click();
  await gbaCard.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor({ timeout: 90_000 });
  const gbaToggle = gbaCard.getByRole('button', { name: 'Reference Garibaldi', exact: true });
  await gbaToggle.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.public-iso-map[data-course="SSXGBA_GARIBALDI"] .public-iso-reference')
        ?.getAttribute('aria-pressed') === 'true',
  );
  const gbaImport = JSON.parse(await readFile(join(maps, 'SSXGBA_GARIBALDI/Import.json'), 'utf8'));
  assert.equal(gbaImport.SourceGameCode, 'AXYE', 'new GBA imports retain their source metadata');
  assert.equal(gbaImport.SourceRevision, 0);
  await gbaToggle.click();
  await confirm.getByRole('button', { name: 'Remove reference', exact: true }).click();
  await gbaCard.getByRole('button', { name: 'Unload Garibaldi', exact: true }).click();

  for (const session of [editorSession, '']) {
    await context.clearCookies();
    if (session) await context.addCookies([{ name: 'slopesmith_session', value: session, url: origin }]);
    await page.goto(`${origin}/isos`);
    await page.locator('#public-iso').setInputFiles(image);
    await card.getByRole('button', { name: 'Load local Garibaldi', exact: true }).waitFor();
    await card.getByRole('button', { name: 'Load local Garibaldi', exact: true }).click();
    await card.getByRole('button', { name: 'Unload Garibaldi', exact: true }).waitFor({ timeout: 90_000 });
    assert(await toggle.isHidden(), 'only admins see the toggle even for a loaded map');
    await card.getByRole('button', { name: 'Unload Garibaldi', exact: true }).click();
    await card.getByRole('button', { name: 'Load local Garibaldi', exact: true }).waitFor();
  }
  assert.deepEqual(errors, []);
  console.log(
    'Native extraction → queued admin uploads with hash reuse, per-map music, cancellation, pressed state and confirmed removal PASS',
  );
} catch (error) {
  console.error('Reference browser page errors:', errors);
  console.error('Reference browser cards:', await activePage?.locator('.public-iso-map').allTextContents());
  console.error(
    'Reference row visibility:',
    await activePage?.locator('.public-iso-map').evaluateAll(rows =>
      rows.map(row => ({
        course: (row as HTMLElement).dataset.course,
        hidden: (row as HTMLElement).hidden,
        referenceHidden: (row.querySelector('.public-iso-reference') as HTMLElement)?.hidden,
        parent: row.parentElement?.outerHTML.slice(0, 180),
      })),
    ),
  );
  console.error('Reference URL:', activePage?.url());
  throw error;
} finally {
  releaseHeldUpload();
  await browser?.close();
  await vite.close();
  await api.close();
  await rm(root, { recursive: true, force: true });
}
