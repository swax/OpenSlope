// browser: smoke
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import type { QuadMeshDoc } from '../src/core/doc/types';
import type { Viewport } from '../src/app/viewport/viewport';
import type { BufferGeometry, Object3D } from 'three';
import { bendFixture } from './subdivision-bend.fixture';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-bend-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined;
type Visuals = { cage: number[]; terrain: number[] };
type Observation = {
  slopesmith: { doc(): QuadMeshDoc; errors(): unknown[]; settled(): Promise<unknown> };
  bendVisuals?(): Visuals;
};
try {
  const fixture = bendFixture('SUBDIVISION_BEND_BROWSER');
  const response = await fetch(`${api.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: fixture.doc }),
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
  await page.addInitScript(() => {
    const view = JSON.stringify({
      pos: [60, 220, -15],
      target: [60, 0, -15],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: 100,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(`${prefix}-view-v1`, view);
  });
  const loaded = () =>
    page!.waitForFunction(
      () =>
        !!(window as unknown as Observation).slopesmith &&
        document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
      undefined,
      { timeout: 60_000 },
    );
  const read = () => page!.evaluate(() => (window as unknown as Observation).slopesmith.doc());
  await page.goto(`${vite.resolvedUrls!.local[0]}editor/SUBDIVISION_BEND_BROWSER?agent=1`);
  await loaded();
  // Observe actual rendered cage and terrain buffers independently of the authored document.
  await page.evaluate(async () => {
    const moduleName = '/src/app/viewport/viewport.ts';
    const { Viewport: ViewportClass } = (await import(moduleName)) as { Viewport: { prototype: Viewport } };
    const prototype = ViewportClass.prototype,
      mode = Object.getOwnPropertyDescriptor(prototype, 'mode')!;
    Object.defineProperty(prototype, 'mode', {
      ...mode,
      set(value) {
        Object.defineProperty(prototype, 'mode', mode);
        mode.set!.call(this, value);
        const viewport = this as Viewport;
        (window as unknown as Observation).bendVisuals = () => {
          const cage: number[] = [];
          viewport.stage.worldRoot.traverse(object => {
            const geometry = (object as Object3D & { geometry?: BufferGeometry }).geometry;
            if (geometry?.name === 'source-cage-points') cage.push(...geometry.getAttribute('position').array);
          });
          return { cage, terrain: Array.from(viewport.terrainLayer.terrain.geometry.getAttribute('position').array) };
        };
      },
    });
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const panel = page.locator('#dock-right > .lil-gui:visible');
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const controller = (name: string) =>
    panel.locator('.lil-controller').filter({ has: page!.locator('.lil-name', { hasText: name }) });
  const angle = () => controller('angle (°)').locator('input');
  const visuals = () => page!.evaluate(() => (window as unknown as Observation).bendVisuals!());
  const canvas = page.locator('canvas').first();
  const rect = await canvas.boundingBox();
  assert(rect);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await button('bend cage…').waitFor();
  const original = await read();
  const originalVisuals = await visuals();
  assert(originalVisuals.cage.length > 0);
  await button('bend cage…').click();
  assert(await button('apply bend (Enter)').isDisabled());
  await button('quarter pipe (90°)').click();
  const quarter = await visuals();
  assert.notDeepEqual(quarter.cage, originalVisuals.cage, 'the source cage preview bends');
  assert.notDeepEqual(quarter.terrain, originalVisuals.terrain, 'the rendered SubD terrain follows the preview');
  assert.deepEqual((await read()).vertices, original.vertices, 'preview does not reach the authored document');
  await button('arch (180°)').click();
  assert.equal(await angle().inputValue(), '-180');
  assert.notDeepEqual((await visuals()).cage, quarter.cage);
  await controller('length axis').locator('select').selectOption({ label: 'World Z' });
  assert(
    await button('apply bend (Enter)').isDisabled(),
    'a cage too sparse along the chosen axis cannot collapse into an arch',
  );
  assert.match(await panel.innerText(), /more divisions/);
  await controller('length axis').locator('select').selectOption({ label: 'World X' });
  assert(await button('apply bend (Enter)').isEnabled());
  await button('quarter pipe (90°)').click();
  assert.deepEqual((await visuals()).cage, quarter.cage, 'returning to the same angle never accumulates deformation');
  await angle().focus();
  await page.keyboard.press('Escape');
  await button('bend cage…').waitFor();
  assert.deepEqual((await visuals()).cage, originalVisuals.cage, 'Esc from an input restores the original cage');
  assert.deepEqual((await visuals()).terrain, originalVisuals.terrain, 'cancel restores the original terrain');
  assert.deepEqual((await read()).vertices, original.vertices);
  await button('bend cage…').click();
  await button('arch (180°)').click();
  // Orbit while the modal preview owns selection, to inspect the real arch in three dimensions.
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(rect.x + rect.width / 2 + 110, rect.y + rect.height / 2 + 130, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await page.screenshot({ path: join(root, 'subdivision-arch-preview.png') });
  await canvas.click({ position: { x: 40, y: 200 } });
  await page.keyboard.press('Enter');
  await button('bend cage…').waitFor();
  const bent = await read();
  assert.notDeepEqual(bent.vertices, original.vertices);
  assert.deepEqual(bent.surfaces![0].subdivision, original.surfaces![0].subdivision);
  assert.deepEqual(bent.quadIds, original.quadIds);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    original =>
      JSON.stringify((window as unknown as Observation).slopesmith.doc().vertices) === JSON.stringify(original),
    original.vertices,
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    bent => JSON.stringify((window as unknown as Observation).slopesmith.doc().vertices) === JSON.stringify(bent),
    bent.vertices,
  );
  await page.waitForTimeout(1200);
  await page.reload();
  await loaded();
  const stored = await read();
  assert.deepEqual(stored.vertices, bent.vertices, 'autosave retains the bend');
  assert.deepEqual(stored.surfaces![0].subdivision, bent.surfaces![0].subdivision, 'the saved cage remains editable');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  console.log(
    `SUBDIVISION BEND BROWSER: PASS (rendered preview, presets, axes, sparse guard, cancel, apply, undo/redo, autosave). Screenshot: ${join(root, 'subdivision-arch-preview.png')}`,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(`Bend browser failure: ${join(root, 'failure.png')}`);
    console.error(await page.locator('#dock-right').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
