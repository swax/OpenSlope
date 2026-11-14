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
import { blankMountain } from '../src/core/doc/mountain';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import type { Viewport } from '../src/app/viewport/viewport';

// Real pointer placement, rendered preview, commit/selection, undo and autosave use the full editor.
const root = mkdtempSync(join(tmpdir(), 'slopesmith-box-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
type Observation = {
  slopesmith: { doc(): QuadMeshDoc; errors(): unknown[]; snapshot(): { selection: { meshPatches: string[] } } };
  resizeState(): {
    screen: number[];
    directions: Record<'X' | 'Y' | 'Z', number[]>;
    axis: string | null;
    axes: boolean[];
    mode: string;
    space?: string;
  };
  projectDraftPoint(point: V3): number[];
  resizeView(mode: 'top' | 'oblique'): void;
};
try {
  const response = await fetch(`${api.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: blankMountain('BOX_BROWSER', 30) }),
  });
  assert(response.ok);
  const downResponse = await fetch(`${api.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: blankMountain('BOX_DOWN_BROWSER', 30) }),
  });
  assert(downResponse.ok);
  const gridResponse = await fetch(`${api.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: blankMountain('GRID_RESIZE_BROWSER', 30) }),
  });
  assert(gridResponse.ok);
  await vite.listen();
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('globalThis.__name = value => value');
  await page.addInitScript(() => {
    const view = JSON.stringify({
      pos: [45, 250, -30],
      target: [45, 0, -30],
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
  await page.goto(`${vite.resolvedUrls!.local[0]}editor/BOX_BROWSER?agent=1`);
  await loaded();
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
        const viewport = this as Viewport,
          observation = window as unknown as Observation;
        const screen = (point: ReturnType<typeof viewport.stage.camera.position.clone>) => {
          const rect = viewport.stage.renderer.domElement.getBoundingClientRect(),
            p = point.project(viewport.stage.camera);
          return [rect.x + ((p.x + 1) * rect.width) / 2, rect.y + ((1 - p.y) * rect.height) / 2];
        };
        observation.projectDraftPoint = point =>
          screen(viewport.stage.camera.position.clone().set(point[0], point[1], -point[2]));
        observation.resizeState = () => {
          const gizmo = viewport.stage.gizmo,
            anchor = gizmo.object!;
          const at = screen(anchor.position.clone());
          const directions = Object.fromEntries(
            (['X', 'Y', 'Z'] as const).map((axis, i) => {
              const vector = anchor.position.clone().set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
              if (gizmo.space === 'local') vector.applyQuaternion(anchor.quaternion);
              const tip = screen(anchor.position.clone().add(vector));
              const dx = tip[0] - at[0],
                dy = tip[1] - at[1],
                length = Math.hypot(dx, dy) || 1;
              return [axis, [dx / length, dy / length]];
            }),
          ) as Record<'X' | 'Y' | 'Z', number[]>;
          return {
            screen: at,
            directions,
            axis: gizmo.axis,
            axes: [gizmo.showX, gizmo.showY, gizmo.showZ],
            mode: gizmo.mode,
          };
        };
        observation.resizeView = mode =>
          viewport.applyView(
            mode === 'top'
              ? { pos: [45, 250, -30], target: [45, 0, -30], up: [0, 0, -1], ortho: true, zoom: 1, orthoHalfH: 100 }
              : { pos: [160, 140, -180], target: [45, 15, -30], up: [0, 1, 0], ortho: true, zoom: 1, orthoHalfH: 100 },
          );
      },
    });
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const panel = page.locator('#dock-right > .lil-gui:visible');
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const field = (name: string) =>
    panel
      .locator('.lil-controller')
      .filter({
        has: page!
          .locator('.lil-name')
          .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
      })
      .locator('input')
      .last();
  const change = async (name: string, value: string) => {
    await field(name).fill(value);
    await field(name).press('Tab');
  };
  const resizeState = () => page!.evaluate(() => (window as unknown as Observation).resizeState());
  const clickPoint = async (point: V3) => {
    const at = await page!.evaluate(point => (window as unknown as Observation).projectDraftPoint(point), point);
    await page!.mouse.click(at[0], at[1]);
  };
  const dragAxis = async (axis: 'X' | 'Y' | 'Z', distance: number) => {
    await page!.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const start = await resizeState(),
      direction = start.directions[axis];
    let at = start.screen;
    for (const offset of [25, 35, 45, 55, 65]) {
      at = [start.screen[0] + direction[0] * offset, start.screen[1] + direction[1] * offset];
      await page!.mouse.move(at[0], at[1]);
      if ((await resizeState()).axis === axis) break;
    }
    assert.equal((await resizeState()).axis, axis, `the ${axis} resize handle is pickable`);
    await page!.mouse.down();
    await page!.mouse.move(at[0] + direction[0] * distance, at[1] + direction[1] * distance, { steps: 12 });
    await page!.mouse.up();
  };
  await button('▦ create grid').waitFor();
  await button('▣ create box').click();
  assert.equal(await field('patch size (m)').inputValue(), '30');
  assert.equal(await field('placement steps').inputValue(), '0 / 4');
  const canvas = page.locator('canvas').first();
  const rect = await canvas.boundingBox();
  assert(rect);
  const placeBase = async () => {
    for (const [x, z] of [
      [0, 0],
      [90, 0],
      [90, 60],
    ])
      await page!.mouse.click(
        rect.x + rect.width / 2 + ((x - 45) * rect.height) / 200,
        rect.y + rect.height / 2 + ((30 - z) * rect.height) / 200,
      );
  };
  const pullHeight = async (height: number, confirm = true) => {
    const x = rect.x + rect.width / 2 + ((90 - 45) * rect.height) / 200;
    const y = rect.y + rect.height / 2 + ((30 - 60 - height) * rect.height) / 200;
    await page!.mouse.move(x, y, { steps: 8 });
    if (confirm) await page!.mouse.click(x, y);
  };
  await placeBase();
  assert.equal(await field('placement steps').inputValue(), '3 / 4');
  assert(await button('✔ create box (Enter)').isDisabled(), 'the third click only fixes the base');
  assert.equal(await field('height (m)').inputValue(), '0.0');
  await pullHeight(30, false);
  assert.equal(await field('height (m)').inputValue(), '30.0');
  assert(await button('✔ create box (Enter)').isDisabled(), 'moving previews height without confirming it');
  await pullHeight(30);
  assert.equal(await field('placement steps').inputValue(), '4 / 4');
  assert.equal(await field('quad patches').inputValue(), '22');
  assert.equal((await read()).quads.length, 0, 'preview leaves the document untouched');
  await page.evaluate(() => (window as unknown as Observation).resizeView('oblique'));
  await clickPoint([20, 30, 20]);
  assert.equal(await field('selected').inputValue(), 'height end face');
  assert.deepEqual((await resizeState()).axes, [false, true, false]);
  assert.equal((await resizeState()).mode, 'translate');
  await dragAxis('Y', 50);
  assert(Number(await field('height (m)').inputValue()) > 35, 'a face drag updates the height field live');
  assert.equal(await field('length (m)').inputValue(), '90.0');
  await change('height (m)', '30');
  await clickPoint([90, 30, 20]);
  assert.equal(await field('selected').inputValue(), 'edge along width');
  assert.deepEqual((await resizeState()).axes, [true, true, false]);
  await dragAxis('X', 50);
  assert(Number(await field('length (m)').inputValue()) > 95, 'an edge drag resizes the adjoining boundary');
  assert.equal(await field('width (m)').inputValue(), '60.0');
  assert.equal(await field('height (m)').inputValue(), '30.0');
  await change('length (m)', '90');
  assert.equal((await read()).quads.length, 0, 'component drags remain private until Enter');
  await page.evaluate(() => (window as unknown as Observation).resizeView('top'));
  const sectionNames = await panel.locator('.sp-edit-section > .lil-title').allTextContents();
  assert(sectionNames.indexOf('Dimensions') < sectionNames.indexOf('Grid Size'));
  await change('height (m)', '60');
  assert.equal(await field('quad patches').inputValue(), '32');
  const sizing = panel
    .locator('.lil-controller')
    .filter({ has: page.locator('.lil-name', { hasText: /^divide by$/ }) })
    .locator('select');
  await sizing.selectOption({ label: 'divisions along axes' });
  await change('along length', '2');
  await change('across width', '3');
  await change('up height', '4');
  assert.equal(await field('quad patches').inputValue(), '52');
  await sizing.selectOption({ label: 'patch size' });
  assert.equal(await field('quad patches').inputValue(), '32');
  await button('select whole box').click();
  await button('select whole box').evaluate(element => (element as HTMLButtonElement).blur());
  await page.keyboard.press('e');
  assert.equal(await button('Rotate').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('r');
  assert.equal(await button('Scale').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: join(root, 'box-preview.png') });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().quads.length === 32);
  const created = await read();
  assert.equal(
    await page.evaluate(() => (window as unknown as Observation).slopesmith.snapshot().selection.meshPatches.length),
    32,
  );
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().quads.length === 0);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().quads.length === 32);
  await page.waitForTimeout(1200);
  await page.reload();
  await loaded();
  assert.deepEqual((await read()).quads, created.quads, 'autosave retains the box topology');
  assert.deepEqual((await read()).edgeHandles, created.edgeHandles, 'autosave retains sharp box edges');
  await page.keyboard.press('Escape');
  await button('▣ create box').click();
  await placeBase();
  await pullHeight(-30, false);
  await page.keyboard.press('Escape');
  await button('▣ create box').waitFor();
  assert.deepEqual((await read()).quads, created.quads, 'cancel discards only the preview');
  await page.goto(`${vite.resolvedUrls!.local[0]}editor/BOX_DOWN_BROWSER?agent=1`);
  await loaded();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await button('▣ create box').click();
  await placeBase();
  await pullHeight(-30);
  assert.equal(await field('placement steps').inputValue(), '4 / 4');
  await canvas.click({ position: { x: 40, y: 200 } });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().quads.length === 22);
  const below = await read();
  const heights = below.vertices.filter((_, i) => i % 3 === 1);
  assert(
    Math.abs(Math.min(...heights) + 30) < 1e-3 && Math.abs(Math.max(...heights)) < 1e-3,
    'pulling downward creates the volume below the base',
  );
  await page.goto(`${vite.resolvedUrls!.local[0]}editor/GRID_RESIZE_BROWSER?agent=1`);
  await loaded();
  // Capture the new viewport instance through the same mode transition used by the editor.
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
        const viewport = this as Viewport,
          observation = window as unknown as Observation;
        const screen = (point: ReturnType<typeof viewport.stage.camera.position.clone>) => {
          const rect = viewport.stage.renderer.domElement.getBoundingClientRect(),
            p = point.project(viewport.stage.camera);
          return [rect.x + ((p.x + 1) * rect.width) / 2, rect.y + ((1 - p.y) * rect.height) / 2];
        };
        observation.projectDraftPoint = point =>
          screen(viewport.stage.camera.position.clone().set(point[0], point[1], -point[2]));
        observation.resizeState = () => {
          const gizmo = viewport.stage.gizmo,
            anchor = gizmo.object!,
            at = screen(anchor.position.clone());
          const directions = Object.fromEntries(
            (['X', 'Y', 'Z'] as const).map((axis, i) => {
              const vector = anchor.position.clone().set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
              if (gizmo.space === 'local') vector.applyQuaternion(anchor.quaternion);
              const tip = screen(anchor.position.clone().add(vector));
              const dx = tip[0] - at[0],
                dy = tip[1] - at[1],
                length = Math.hypot(dx, dy) || 1;
              return [axis, [dx / length, dy / length]];
            }),
          ) as Record<'X' | 'Y' | 'Z', number[]>;
          return {
            screen: at,
            directions,
            axis: gizmo.axis,
            axes: [gizmo.showX, gizmo.showY, gizmo.showZ],
            mode: gizmo.mode,
            space: gizmo.space,
          };
        };
      },
    });
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await button('▦ create grid').click();
  for (const point of [
    [0, 0, 0],
    [60, 0, 45],
    [24, 0, 93],
  ] as V3[])
    await clickPoint(point);
  await clickPoint([42, 0, 69]);
  assert.equal(await field('selected').inputValue(), 'edge 2');
  assert.equal((await resizeState()).space, 'local', 'Grid edge handles use the grid frame');
  const localX = (await resizeState()).directions.X;
  assert(
    Math.abs(localX[0]) > 0.5 && Math.abs(localX[1]) > 0.5,
    'the edge handle follows the rotated grid in screen space',
  );
  await dragAxis('X', -50);
  assert(
    Number(await field('length (m)').inputValue()) > 80,
    'a local-axis Grid edge drag updates the dimension field',
  );
  assert.equal(await field('width (m)').inputValue(), '60.0');
  await change('length (m)', '120');
  await clickPoint([25, 0, 40]);
  assert.equal(await field('selected').inputValue(), 'whole grid');
  assert.equal((await read()).quads.length, 0);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().quads.length === 8);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  console.log(
    `CREATE BOX/GRID BROWSER: PASS (signed placement, face/edge picks, real gizmo resizing, live dimensions, whole transforms, commit, undo/redo, autosave, cancel). Screenshot: ${join(root, 'box-preview.png')}`,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(`Box browser failure: ${join(root, 'failure.png')}`);
    console.error(await page.locator('#dock-right').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
