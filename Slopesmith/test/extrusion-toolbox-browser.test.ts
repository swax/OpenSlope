// tier: integration
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
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import type { EditDoc } from '../src/core/doc/doc-edit';
import type { Viewport } from '../src/app/viewport/viewport';

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
  extrusionState(): {
    kind: string | null;
    anchor: number[] | undefined;
    screen: number[] | undefined;
    edgeScreen: number[];
    mode: string;
    axes: boolean[];
    axis: string | null;
    preview: boolean;
  };
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
  await page.addInitScript(() => {
    const view = JSON.stringify({
      pos: [50, 200, -50],
      target: [50, 0, -50],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: 120,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(prefix + '-view-v1', view);
  });
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
  // Observe the real viewport without changing app state; gestures below still go through native pointer events.
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
        (window as unknown as Observation).extrusionState = () => {
          const { stage } = viewport,
            gizmo = stage.gizmo,
            rect = stage.renderer.domElement.getBoundingClientRect(),
            point = gizmo.object?.position.clone().project(stage.camera),
            edge = stage.camera.position.clone().set(0, 0, -50).project(stage.camera);
          return {
            kind: stage.gizmoKind,
            anchor: gizmo.object?.position.toArray(),
            screen: point
              ? [rect.x + ((point.x + 1) * rect.width) / 2, rect.y + ((1 - point.y) * rect.height) / 2]
              : undefined,
            edgeScreen: [rect.x + ((edge.x + 1) * rect.width) / 2, rect.y + ((1 - edge.y) * rect.height) / 2],
            mode: gizmo.mode,
            axes: [gizmo.showX, gizmo.showY, gizmo.showZ],
            axis: gizmo.axis,
            preview: stage.worldRoot.getObjectByName('edge-extrusion-preview')!.visible,
          };
        };
      },
    });
  });
  const state = () => page!.evaluate(() => (window as unknown as Observation).extrusionState());
  const read = () => page!.evaluate(() => (window as unknown as Observation).slopesmith.doc());
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
    assert.deepEqual((await state()).anchor, [50, 0, -50], 'Patch extrusion also starts on its source');
    assert.equal((await state()).mode, 'translate');
    assert.deepEqual((await state()).axes, [true, true, true]);
    assert.equal((await state()).preview, false, 'No overlapping ghost is drawn before the first pull');
    for (const mode of ['Rotate', 'Scale', 'Move']) {
      await button(mode).click();
      await checkExtruding();
    }
    await page.screenshot({ path: join(root, `extrusion-${enter}.png`) });
    if (enter === 'button') await button('cancel extrusion (Esc)').click();
    else await page.keyboard.press('Escape');
    await checkSelection();
  }
  // Select a boundary line and pull it against the positive X handle, proving signed direction is preserved.
  await page.keyboard.press('Escape');
  const edgeScreen = (await state()).edgeScreen;
  await page.mouse.click(edgeScreen[0], edgeScreen[1]);
  await checkSelection();
  await page.keyboard.press('x');
  await checkExtruding();
  const initial = await state();
  assert.deepEqual(initial.anchor, [0, 0, -50], 'The extrusion gizmo starts on the selected line');
  assert.equal(initial.mode, 'translate');
  assert.deepEqual(initial.axes, [true, true, true]);
  await page.keyboard.press('Enter');
  await checkExtruding();
  assert.equal((await read()).quads.length, 1, 'Enter before pulling cannot create overlapping geometry');
  let handleX = 0;
  for (const offset of [30, 40, 50, 60]) {
    handleX = initial.screen![0] + offset;
    await page.mouse.move(handleX, initial.screen![1]);
    if ((await state()).axis === 'X') break;
  }
  assert.equal((await state()).axis, 'X', 'A visible full-gizmo handle is pickable at the source edge');
  await page.mouse.down();
  await page.mouse.move(handleX - 105, initial.screen![1], { steps: 12 });
  await page.mouse.up();
  const pulled = await state();
  assert(pulled.anchor![0] < -10, 'Dragging left extrudes left instead of following a preset continuation');
  assert.equal(pulled.anchor![1], 0);
  assert.equal(pulled.anchor![2], -50);
  assert(pulled.preview, 'Pulling draws the staged extrusion');
  assert.equal((await read()).quads.length, 1, 'Pulling remains a preview until Enter');
  await page.screenshot({ path: join(root, 'pulled-edge.png') });
  await page.keyboard.press('Enter');
  await checkSelection();
  const committed = await read();
  assert(committed.quads.length > 1);
  assert.deepEqual(committed.vertices.slice(0, doc.vertices.length), doc.vertices, 'Existing corners stay in place');
  assert.equal(Math.min(...committed.vertices.filter((_, i) => i % 3 === 0)), pulled.anchor![0]);
  await page.screenshot({ path: join(root, 'committed.png') });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().quads.length === 1);
  assert.deepEqual((await read()).vertices, doc.vertices, 'One undo removes the committed extrusion');
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  assert.deepEqual(errors, []);
  console.log(`Extrusion: source gizmo, signed pull, transforms, cancel, commit and undo PASS. ${root}`);
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
