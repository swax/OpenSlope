import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Locator } from 'playwright-core';
import { chromiumExecutable, clickMapAction } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { addUser } from '../src/server/accounts/users';
import { createProject } from '../src/server/projects';
import { defaultMountain } from '../src/core/doc/mountain';
import { readMountainArchive } from '../src/app/mountain/archive';
import { encodePng } from '../src/server/routes/png';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-library-export-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
mkdirSync(process.env.SLOPESMITH_MAPS_ROOT);
forgetWorkspaceConfig();
forgetAccounts();
const admin = await addUser({
  username: 'admin',
  password: 'library export password',
  role: 'admin',
  inviteHandle: 'test',
});
const mountain = defaultMountain();
const published = await createProject(
  { ...mountain, name: 'PUBLIC_EXPORT', quadTex: { 0: 'Custom/public-snow.png' } },
  undefined,
  false,
  admin.id,
);
const privateProject = await createProject(
  { ...mountain, name: 'PRIVATE_EXPORT', quadTex: { 0: 'Custom/private-snow.png' } },
  undefined,
  false,
  admin.id,
);
for (const [snapshot, name, color] of [
  [published, 'public-snow.png', [255, 0, 0, 255]],
  [privateProject, 'private-snow.png', [0, 255, 0, 255]],
] as const) {
  const folder = join(snapshot.project.folder!, 'assets', 'textures');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), encodePng({ w: 1, h: 1, data: new Uint8Array(color) }));
}
for (const [name, retail] of [
  ['ORIGINAL_EXPORT', false],
  ['RETAIL_EXPORT', true],
] as const) {
  const folder = join(root, 'Maps', name);
  mkdirSync(folder);
  writeFileSync(join(folder, 'Patches.json'), '{"Patches":[]}');
  writeFileSync(
    join(folder, 'Origin.json'),
    JSON.stringify({
      Schema: 'openslope-origin/v1',
      Origin: retail ? 'retail' : 'slopesmith',
      RetailData: retail,
      Reasons: retail ? ['retail-extract'] : [],
    }),
  );
}
const gba = process.env.SLOPESMITH_TEST_GBA ?? join(root, 'fixture.gba');
if (!process.env.SLOPESMITH_TEST_GBA)
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from ssx_gba_import_test import rom; Path(sys.argv[2]).write_bytes(rom(unpaired=True))',
      resolve('../Native/tests'),
      gba,
    ],
    { windowsHide: true },
  );
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
try {
  assert(
    (
      await page.request.post(`${origin}/api/auth/login`, {
        data: { username: 'admin', password: 'library export password' },
      })
    ).ok(),
  );
  for (const [kind, id] of [
    ['project', published.project.id],
    ['reference', 'ORIGINAL_EXPORT'],
  ] as const)
    assert(
      (await page.request.put(`${origin}/api/publication?kind=${kind}&id=${id}`, { data: { published: true } })).ok(),
    );
  await page.goto(origin);
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  async function download(card: Locator, name: string, purpose: string) {
    await card.getByRole('button', { name: `Map actions for ${name}`, exact: true }).click();
    await card.getByRole('button', { name: `Export ${name}`, exact: true }).click();
    await dialog.getByLabel('Export for', { exact: true }).selectOption(purpose);
    const commands = dialog.getByRole('region', { name: 'Snowknife commands', includeHidden: true });
    const snowknife = purpose.startsWith('snowknife-');
    assert.equal(await commands.isVisible(), snowknife);
    const commandLabel = purpose === 'snowknife-iso' ? 'ISO command' : 'mod manager command';
    const command = snowknife ? await dialog.getByLabel(commandLabel, { exact: true }).innerText() : null;
    if (snowknife) {
      const otherLabel = purpose === 'snowknife-iso' ? 'mod manager command' : 'ISO command';
      assert(await dialog.getByLabel(otherLabel, { exact: true }).isHidden());
      assert(await dialog.getByRole('link', { name: 'Get Snowknife', exact: true }).isVisible());
      assert.equal(
        await dialog.getByRole('link', { name: 'Get SSX Mod Manager', exact: true, includeHidden: true }).isVisible(),
        purpose === 'snowknife-mod-manager',
      );
      assert.equal(command!.includes('--mod-manager'), purpose === 'snowknife-mod-manager');
    }
    assert.equal(await dialog.getByRole('checkbox').count(), 0);
    const pending = page.waitForEvent('download', { timeout: 120_000 });
    await dialog
      .getByRole('button', { name: `Download .${snowknife ? 'snowknife' : 'slopesmith'}.zip`, exact: true })
      .click();
    const result = await pending;
    if (command)
      assert(command.includes(result.suggestedFilename()), 'The command uses the downloaded archive filename');
    await result.saveAs(join(root, result.suggestedFilename()));
    await dialog.waitFor({ state: 'detached' });
    return { result, bytes: readFileSync((await result.path())!) };
  }
  for (const [name, kind] of [
    ['PUBLIC_EXPORT', 'project'],
    ['PRIVATE_EXPORT', 'private'],
  ] as const) {
    const card = page
      .locator(`article[data-kind="${kind}"]`)
      .filter({ has: page.getByRole('heading', { name: name.replace(/_/g, ' '), exact: true }) });
    await card.waitFor();
    const editable = await download(card, name, 'slopesmith');
    assert.equal((await readMountainArchive(new Blob([editable.bytes]))).document.name, name);
    const native = await download(card, name, kind === 'project' ? 'snowknife-iso' : 'snowknife-mod-manager');
    assert(native.bytes.includes(Buffer.from('Patches.json')));
    assert(native.bytes.includes(Buffer.from('Repack.md')));
    assert(native.bytes.includes(Buffer.from('Lights.json')));
    assert(native.bytes.includes(Buffer.from('Lightmaps/')));
    assert(native.bytes.includes(Buffer.from(name === 'PUBLIC_EXPORT' ? 'public-snow.png' : 'private-snow.png')));
  }
  await page.evaluate(async () => {
    const projectsUrl = '/src/app/state/local-projects.ts',
      mountainUrl = '/src/core/doc/mountain.ts';
    const projects = await (await import(/* @vite-ignore */ projectsUrl)).openLocalProjects();
    const document = (await import(/* @vite-ignore */ mountainUrl)).defaultMountain();
    document.name = 'LOCAL_EXPORT';
    await projects.seed(document);
    projects.close();
  });
  await page.reload();
  const local = page
    .locator('article[data-kind="local"]')
    .filter({ has: page.getByRole('heading', { name: 'LOCAL_EXPORT', exact: true }) });
  await local.waitFor();
  assert.equal(
    (await readMountainArchive(new Blob([(await download(local, 'LOCAL_EXPORT', 'slopesmith')).bytes]))).name,
    'LOCAL_EXPORT',
  );
  assert((await download(local, 'LOCAL_EXPORT', 'snowknife-mod-manager')).bytes.includes(Buffer.from('Patches.json')));
  const remove = local.getByRole('button', { name: 'Delete LOCAL_EXPORT', exact: true, includeHidden: true });
  assert(await remove.isHidden());
  await local.getByRole('button', { name: 'Map actions for LOCAL_EXPORT', exact: true }).click();
  assert(await remove.isVisible());
  await page.screenshot({ path: join(root, 'local-menu.png') });
  await remove.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Delete LOCAL_EXPORT?', exact: true });
  assert(
    await confirmation
      .getByRole('button', { name: 'Cancel', exact: true })
      .evaluate(button => button === document.activeElement),
  );
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert(await local.isVisible());
  await clickMapAction(remove);
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
  await local.waitFor({ state: 'detached' });
  const original = page.locator('article[data-course="ORIGINAL_EXPORT"]');
  assert((await download(original, 'ORIGINAL_EXPORT', 'snowknife-iso')).bytes.includes(Buffer.from('Origin.json')));

  // Anonymous readers receive only explicitly published original reference files, never retail folders.
  const anonymous = await browser.newContext();
  assert((await anonymous.request.get(`${origin}/api/map-files?level=ORIGINAL_EXPORT`)).ok());
  assert.equal((await anonymous.request.get(`${origin}/api/map-files?level=RETAIL_EXPORT`)).status(), 401);
  assert.equal(
    (
      await anonymous.request.get(`${origin}/api/map-files?level=ORIGINAL_EXPORT&path=../RETAIL_EXPORT/Patches.json`)
    ).status(),
    400,
  );
  assert.equal(
    (await anonymous.request.get(`${origin}/api/map-files?level=ORIGINAL_EXPORT&path=Origin.json`)).status(),
    200,
  );
  const guest = await anonymous.newPage();
  await guest.goto(origin);
  const guestMap = guest
    .locator('article[data-kind="project"]')
    .filter({ has: guest.getByRole('heading', { name: 'PUBLIC EXPORT', exact: true }) });
  await guestMap.getByRole('button', { name: 'Map actions for PUBLIC_EXPORT', exact: true }).click();
  await guestMap.getByRole('button', { name: 'Export PUBLIC_EXPORT', exact: true }).click();
  const guestDialog = guest.getByRole('dialog', { name: 'Export', exact: true });
  await guestDialog.getByLabel('Export for', { exact: true }).selectOption('snowknife-mod-manager');
  const guestDownload = guest.waitForEvent('download');
  await guestDialog.getByRole('button', { name: 'Download .snowknife.zip', exact: true }).click();
  assert(readFileSync((await (await guestDownload).path())!).includes(Buffer.from('public-snow.png')));
  await anonymous.close();

  await page.locator('#public-iso').setInputFiles(gba);
  await page.locator('.public-iso-status').filter({ hasText: '8 maps found' }).waitFor({ timeout: 90_000 });
  const imported = page.locator('.public-iso-map[data-course="SSXGBA_GARIBALDI"]');
  await imported.getByRole('button', { name: 'Load local Garibaldi', exact: true }).click();
  await imported
    .getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true })
    .waitFor({ state: 'attached', timeout: 120_000 });
  await page.screenshot({ path: join(root, 'gba-row.png') });
  const native = await download(imported, 'Garibaldi', 'snowknife-mod-manager');
  assert.equal(native.result.suggestedFilename(), 'SSXGBA_GARIBALDI.snowknife.zip');
  assert(native.bytes.includes(Buffer.from('source_gba-opaque.png')));
  assert(native.bytes.includes(Buffer.from('Meshes/gba-scenery-0.obj')));
  assert(native.bytes.includes(Buffer.from('SourceRecord')));
  assert(native.bytes.includes(Buffer.from('Collision/gba-world.obj')));
  await clickMapAction(imported.getByRole('button', { name: 'Unload Garibaldi', exact: true, includeHidden: true }));
  await imported.getByRole('button', { name: 'Load local Garibaldi', exact: true }).waitFor();
  assert.equal(await imported.getByRole('button', { name: 'Export Garibaldi', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    `LIBRARY EXPORT PASS: public/private/local authored maps, GBA import and Snowknife ZIP, unload, reference file access. Artifacts: ${root}`,
  );
} catch (e) {
  await page.screenshot({ path: join(root, 'failure.png') });
  console.error(`Library export artifacts: ${root}`);
  throw e;
} finally {
  await browser.close();
  await api.close();
  await vite.close();
}
