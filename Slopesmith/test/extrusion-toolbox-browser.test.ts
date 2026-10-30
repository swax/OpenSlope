// tier: integration
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import type { EditDoc } from '../src/core/doc/doc-edit';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-extrusion-toolbox-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
process.env.PORT = String(api.port);
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
type Observation = {
  slopesmith: { doc(): EditDoc; errors(): unknown[] };
};

try {
  const doc = meshFromNet(
    { rows: 2, cols: 2, spacing: 100, corners: [0, 0, 0, 100, 0, 0, 0, 0, 100, 100, 0, 100], paint: {} },
    { name: 'EXTRUSION_TOOLBOX', course: starterCourse(), baseSurface: 1 },
  );
  doc.labels = [{ id: 'label:patch', name: 'Patch' }];
  doc.quadLabels = { 0: ['label:patch'] };
  const response = await fetch(`${api.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc }),
  });
  assert(response.ok);
  await vite.listen();
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${vite.resolvedUrls!.local[0]}editor/EXTRUSION_TOOLBOX?agent=1`);
  await page.waitForFunction(
    () =>
      !!(window as unknown as Observation).slopesmith &&
      document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 60_000 },
  );
  const panel = page.locator('#dock-right > .lil-gui:visible');
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const folder = (name: string) =>
    panel.locator(':scope > .lil-children > .sp-edit-section').filter({
      has: page!.locator(':scope > .lil-title', { hasText: new RegExp(`^${name}$`) }),
    });
  async function checkExtruding() {
    await button('cancel extrusion (Esc)').waitFor({ state: 'visible' });
    assert.deepEqual(
      await panel.locator(':scope > .lil-children > .sp-edit-section > .lil-title').allTextContents(),
      ['Extrude Placement', 'Actions'],
      'Only extrusion controls may occupy the toolbox while it is staged',
    );
    assert(!(await panel.locator('.sp-edit-pick-section').isVisible()));
  }
  async function checkSelection() {
    await button('▰ extrude (X)').waitFor({ state: 'visible' });
    assert.equal(await folder('Extrude Placement').count(), 0);
    assert.equal(await folder('Selection').count(), 1);
    assert.equal(await button('cancel extrusion (Esc)').count(), 0);
  }

  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.keyboard.press('Escape');
  await button('Patch · 1').click();
  await checkSelection();
  for (const enter of ['button', 'keyboard']) {
    if (enter === 'button') await button('▰ extrude (X)').click();
    else await page.keyboard.press('x');
    await checkExtruding();
    for (const mode of ['Rotate', 'Scale', 'Move']) {
      await button(mode).click();
      await checkExtruding();
    }
    await page.screenshot({ path: join(root, `extrusion-${enter}.png`) });
    if (enter === 'button') await button('cancel extrusion (Esc)').click();
    else await page.keyboard.press('Escape');
    await checkSelection();
  }
  await page.keyboard.press('x');
  await checkExtruding();
  await page.keyboard.press('Enter');
  await checkSelection();
  assert((await page.evaluate(() => (window as unknown as Observation).slopesmith.doc())).quads.length > 1);
  await page.screenshot({ path: join(root, 'committed.png') });
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  assert.deepEqual(errors, []);
  console.log(`Extrusion toolbox exclusivity: button/keyboard entry, transforms, cancel and commit PASS. ${root}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(`Browser failure screenshot: ${join(root, 'failure.png')}`);
    console.error(await page.locator('#dock-right').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
