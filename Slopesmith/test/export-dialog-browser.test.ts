import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { addUser } from '../src/server/accounts/users';
import { readMountainArchive } from '../src/app/mountain/archive';
import { authoredAiNetwork } from '../src/core/doc/ai-paths';
import { reconstructPathLine, type CoursePathFile } from '../src/core/reference/terrain';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-export-dialog-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
mkdirSync(process.env.SLOPESMITH_MAPS_ROOT);
forgetWorkspaceConfig();
forgetAccounts();
await addUser({
  username: 'admin',
  password: 'export dialog test password',
  role: 'admin',
  inviteHandle: 'test:admin',
});
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
let preflightRequests = 0;
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/preflight') preflightRequests++;
});
await page.addInitScript(`Object.defineProperty(window, 'showDirectoryPicker', {
  configurable: true,
  value: () => { throw new Error('Export must always download a ZIP'); }
})`);
await page.addInitScript(`Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async value => { document.documentElement.dataset.copiedCommand = value; } }
})`);

try {
  assert(
    (
      await page.request.post(`${origin}/api/auth/login`, {
        data: { username: 'admin', password: 'export dialog test password' },
      })
    ).ok(),
  );
  await page.goto(`${origin}/editor`);
  await page.waitForFunction(() =>
    ['saved', 'shared', 'following'].includes(document.documentElement.dataset.projectSave ?? ''),
  );
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  const open = async () => {
    await page.getByRole('button', { name: 'File menu', exact: true }).click();
    await page.getByRole('button', { name: 'Export…', exact: true }).click();
  };
  await open();
  assert.equal(await dialog.getByLabel('Export for', { exact: true }).inputValue(), 'slopesmith');
  assert.deepEqual(await dialog.locator('select[aria-label="Export for"] option').allTextContents(), [
    'Another Slopesmith instance',
    'Snowknife — Custom ISO',
    'Snowknife — Mod Manager',
  ]);
  assert.equal(await dialog.locator('.sp-preflight').count(), 0);
  assert(await dialog.getByRole('region', { name: 'Snowknife commands', includeHidden: true }).isHidden());
  await page.screenshot({ path: join(root, 'slopesmith.png') });
  const editableDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download .slopesmith.zip', exact: true }).click();
  const editable = await editableDownload;
  assert(editable.suggestedFilename().endsWith('.slopesmith.zip'));
  const mountain = await readMountainArchive(new Blob([readFileSync((await editable.path())!)]));
  assert.equal(mountain.document.name, 'MOUNTAIN01');

  await open();
  await dialog.getByLabel('Export for', { exact: true }).selectOption('snowknife-iso');
  assert.equal(await dialog.getByRole('checkbox').count(), 0);
  assert.equal(await dialog.getByText('What ships', { exact: true }).count(), 0);
  const isoCommand = await dialog.getByLabel('ISO command', { exact: true }).innerText();
  assert.equal(
    isoCommand,
    'snowknife repack ssx-tricky.iso GARI Maps/TRICKY_GARI MOUNTAIN01.snowknife.zip ssx-tricky-mountain01.iso --texture-type2 --bare-slot --no-skycolor',
  );
  assert(await dialog.getByLabel('mod manager command', { exact: true }).isHidden());
  assert.match(await dialog.locator('.sp-modal-note').innerText(), /a custom PS2 Tricky ISO/);
  for (const [name, href] of [
    ['Get Snowknife', 'https://github.com/swax/OpenSlope/tree/main/Snowknife'],
    ['Get SSX Mod Manager', 'https://github.com/GlitcherOG/SSXModManager'],
  ]) {
    const link = dialog.getByRole('link', { name, exact: true, includeHidden: true });
    assert.equal(await link.isVisible(), name === 'Get Snowknife');
    assert.equal(await link.getAttribute('href'), href);
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  }
  await dialog.getByRole('button', { name: 'Copy ISO command', exact: true }).click();
  await page.waitForFunction(command => document.documentElement.dataset.copiedCommand === command, isoCommand);
  assert(await dialog.getByText('Import Garibaldi (only needed once)', { exact: true }).isVisible());
  assert(await dialog.getByLabel('setup command', { exact: true }).isVisible());
  assert.equal(
    await dialog.getByLabel('setup command', { exact: true }).innerText(),
    'snowknife import ssx-tricky.iso GARI Maps/TRICKY_GARI',
  );
  await page.screenshot({ path: join(root, 'snowknife.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await dialog.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 390 && box.height <= 844);
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'Long commands stay within the dialog');
  assert(
    await dialog.getByLabel('ISO command', { exact: true }).evaluate(pre => pre.scrollWidth > pre.clientWidth),
    'Commands scroll horizontally',
  );
  await page.screenshot({ path: join(root, 'snowknife-mobile.png') });
  const mapDownload = page.waitForEvent('download', { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Download .snowknife.zip', exact: true }).click();
  const map = await mapDownload;
  assert.equal(map.suggestedFilename(), 'MOUNTAIN01.snowknife.zip');
  await map.saveAs(join(root, map.suggestedFilename()));
  const bytes = readFileSync((await map.path())!);
  assert(bytes.includes(Buffer.from('Patches.json')));
  assert(bytes.includes(Buffer.from('Repack.md')));
  assert(bytes.includes(Buffer.from(isoCommand)), 'The displayed build command also ships inside Repack.md');
  assert(bytes.includes(Buffer.from('Lights.json')), 'Lighting is always exported');
  assert(bytes.includes(Buffer.from('Lightmaps/')), 'Terrain lighting is always baked');
  const aip: CoursePathFile = JSON.parse(
    execFileSync(
      'python',
      [
        '-c',
        'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("MOUNTAIN01/AIP.json").decode())',
        join(root, map.suggestedFilename()),
      ],
      { encoding: 'utf8' },
    ),
  );
  const network = authoredAiNetwork(mountain.document.course, mountain.document.aiSeed, mountain.document.aiPaths);
  assert.deepEqual(aip.StartPosList, network.starts);
  for (const [i, path] of network.paths.entries()) {
    assert.equal(aip.AIPaths![i].U3, path.rating);
    const actual = reconstructPathLine(aip.AIPaths![i]).slice(1); // Tricky start routes include a zero delta.
    assert.equal(actual.length, path.points.length);
    actual.forEach((point, j) => point.forEach((value, k) => assert(Math.abs(value - path.points[j][k]) < 1e-6)));
  }
  await open();
  await dialog.getByLabel('Export for', { exact: true }).selectOption('snowknife-mod-manager');
  assert(await dialog.getByRole('link', { name: 'Get SSX Mod Manager', exact: true }).isVisible());
  assert(await dialog.getByLabel('ISO command', { exact: true }).isHidden());
  assert.match(await dialog.locator('.sp-modal-note').innerText(), /a ZIP for SSX Mod Manager/);
  const managerCommand = await dialog.getByLabel('mod manager command', { exact: true }).innerText();
  assert.match(managerCommand, /MOUNTAIN01\.snowknife\.zip mountain01\.zip --mod-manager/);
  await dialog.getByRole('button', { name: 'Copy mod manager command', exact: true }).click();
  await page.waitForFunction(command => document.documentElement.dataset.copiedCommand === command, managerCommand);
  await page.screenshot({ path: join(root, 'snowknife-mod-manager-mobile.png') });
  const managerDownload = page.waitForEvent('download', { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Download .snowknife.zip', exact: true }).click();
  const manager = await managerDownload;
  assert.equal(manager.suggestedFilename(), 'MOUNTAIN01.snowknife.zip');
  const managerBytes = readFileSync((await manager.path())!);
  assert(managerBytes.includes(Buffer.from('Patches.json')));
  assert(managerBytes.includes(Buffer.from(managerCommand)));
  assert(managerBytes.includes(Buffer.from('Lights.json')));
  assert.equal(preflightRequests, 0, 'Export no longer requests a preflight summary');
  assert.deepEqual(errors, []);
  console.log(
    `EXPORT DIALOG PASS: Slopesmith and both Snowknife destinations, tool links, desktop and mobile. Artifacts: ${root}`,
  );
} catch (error) {
  await page.screenshot({ path: join(root, 'failure.png') });
  console.error('Export dialog artifacts:', root);
  throw error;
} finally {
  await browser.close();
  await api.close();
  await vite.close();
}
