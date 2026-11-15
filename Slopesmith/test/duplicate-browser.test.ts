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
import { appendMeshIds } from '../src/core/doc/ids';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import type { Viewport } from '../src/app/viewport/viewport';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-duplicate-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
type State = {
  pending: boolean;
  kind: string | null;
  axis: string | null;
  screen: number[];
  direction: number[];
  ghostOffset?: number[];
  points: number;
  edges: number;
  patches: number;
};
type Observation = {
  slopesmith: { doc(): QuadMeshDoc; errors(): unknown[]; settled(): Promise<unknown> };
  duplicateState(): State;
  projectPoint(point: V3): number[];
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined;
try {
  const doc = blankMountain('DUPLICATE_BROWSER', 30);
  doc.vertices = [0, 0, 0, 0, 0, 60, 60, 0, 0, 60, 0, 60];
  doc.quads = [[0, 1, 2, 3]];
  Object.assign(doc, appendMeshIds(doc, 4, 1));
  const response = await fetch(api.url + '/api/projects', {
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
  await page.addInitScript('globalThis.__name = value => value');
  await page.addInitScript(() => {
    const view = JSON.stringify({
      pos: [30, 220, -30],
      target: [30, 0, -30],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: 80,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(prefix + '-view-v1', view);
  });
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/DUPLICATE_BROWSER?agent=1');
  await page.waitForFunction(
    () =>
      !!(window as unknown as Observation).slopesmith &&
      document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 60_000 },
  );
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
        const screen = (p: ReturnType<typeof viewport.stage.camera.position.clone>) => {
          const rect = viewport.stage.renderer.domElement.getBoundingClientRect();
          p.project(viewport.stage.camera);
          return [rect.x + ((p.x + 1) * rect.width) / 2, rect.y + ((1 - p.y) * rect.height) / 2];
        };
        observation.projectPoint = point =>
          screen(viewport.stage.camera.position.clone().set(point[0], point[1], -point[2]));
        observation.duplicateState = () => {
          const gizmo = viewport.stage.gizmo,
            anchor = gizmo.object;
          const at = anchor ? screen(anchor.position.clone()) : [];
          const axis = viewport.stage.camera.position.clone().set(1, 0, 0);
          if (anchor && gizmo.space === 'local') axis.applyQuaternion(anchor.quaternion);
          const tip = anchor ? screen(anchor.position.clone().add(axis)) : [];
          const length = Math.hypot(tip[0] - at[0], tip[1] - at[1]) || 1;
          const ghost = viewport.stage.worldRoot.children.find(
            object => object.name === 'mesh-clipboard-preview' && object.visible,
          );
          return {
            pending: viewport.duplicateTool.active,
            kind: viewport.stage.gizmoKind,
            axis: gizmo.axis,
            screen: at,
            direction: [(tip[0] - at[0]) / length, (tip[1] - at[1]) / length],
            ghostOffset: ghost?.position.toArray(),
            points:
              viewport.sel.edgeSel.length || viewport.sel.cellSel.length
                ? 0
                : viewport.selection.cornerGroupIdx.length + Number(viewport.sel.selectedCorner !== null),
            edges: viewport.sel.edgeSel.length,
            patches: viewport.sel.cellSel.length,
          };
        };
      },
    });
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.keyboard.press('Escape');
  const read = () => page!.evaluate(() => (window as unknown as Observation).slopesmith.doc());
  const state = () => page!.evaluate(() => (window as unknown as Observation).duplicateState());
  const original = await read();
  const click = async (point: V3) => {
    const at = await page!.evaluate(point => (window as unknown as Observation).projectPoint(point), point);
    await page!.mouse.click(at[0], at[1]);
  };
  const arm = async () => {
    const before = await read();
    await page!.keyboard.press('Control+d');
    await page!.getByRole('button', { name: 'cancel duplicate (Esc)', exact: true }).waitFor();
    assert.equal((await state()).kind, 'duplicate');
    assert.deepEqual(await read(), before, 'Ctrl+D does not change the document');
  };
  const handle = async () => {
    const s = await state();
    let at = s.screen;
    for (const offset of [25, 35, 45, 55, 65]) {
      at = s.screen.map((n, i) => n + s.direction[i] * offset);
      await page!.mouse.move(at[0], at[1]);
      if ((await state()).axis === 'X') break;
    }
    assert.equal((await state()).axis, 'X', 'the copy move handle is pickable');
    return { at, direction: s.direction };
  };
  await click([25, 0, 25]);
  assert.equal((await state()).patches, 1);
  await arm();
  let h = await handle();
  await page.mouse.down();
  await page.mouse.up();
  assert.deepEqual(await read(), original, 'a stationary gizmo click creates nothing');
  assert.equal((await state()).pending, false);
  await arm();
  h = await handle();
  await page.mouse.down();
  await page.mouse.move(h.at[0] + h.direction[0] * 55, h.at[1] + h.direction[1] * 55, { steps: 8 });
  assert(Math.hypot(...(await state()).ghostOffset!) > 1, 'the rendered ghost follows the drag');
  assert.deepEqual(await read(), original, 'even a moving preview does not enter the document');
  await page.mouse.move(h.at[0], h.at[1], { steps: 8 });
  await page.mouse.up();
  assert.deepEqual(await read(), original, 'a drag back to the start creates nothing');
  await arm();
  h = await handle();
  await page.mouse.down();
  await page.mouse.move(h.at[0] + h.direction[0] * 55, h.at[1] + h.direction[1] * 55, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.move(h.at[0] + h.direction[0] * 85, h.at[1] + h.direction[1] * 85, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(await read(), original, 'Escape during a drag discards the preview');
  for (const [kind, point] of [
    ['patch', [25, 0, 25]],
    ['edge', [0, 0, 30]],
    ['point', [0, 0, 0]],
  ] as const) {
    await page.keyboard.press('Escape');
    await click([...point]);
    const before = await read();
    if (kind === 'point') {
      await arm();
      await page.keyboard.press('Escape');
      assert.equal((await state()).kind, 'corner', 'cancelling restores the original point gizmo');
      assert.deepEqual(await read(), before);
    }
    await arm();
    h = await handle();
    await page.mouse.down();
    await page.mouse.move(h.at[0] + h.direction[0] * 55, h.at[1] + h.direction[1] * 55, { steps: 8 });
    const offset = (await state()).ghostOffset!;
    assert.deepEqual(await read(), before);
    if (kind === 'patch') await page.screenshot({ path: join(root, 'duplicate-preview.png') });
    await page.mouse.up();
    // Point handles refresh on the next frame after the document commit.
    const selection = kind === 'patch' ? 'patches' : kind === 'edge' ? 'edges' : 'points';
    await page.waitForFunction<boolean, 'patches' | 'edges' | 'points'>(
      key => (window as unknown as Observation).duplicateState()[key] === 1,
      selection,
    );
    const next = await read(),
      selected = await state();
    const added = kind === 'patch' ? 4 : kind === 'edge' ? 2 : 1;
    assert.equal(next.vertices.length, original.vertices.length + added * 3);
    assert.equal(next.quads.length, kind === 'patch' ? 2 : 1);
    assert.deepEqual(
      next.vertices.slice(0, original.vertices.length),
      original.vertices,
      'the original stays in place',
    );
    assert.equal(selected[selection], 1);
    assert(Math.abs(next.vertices[original.vertices.length] - offset[0]) < 1e-4);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().vertices.length === 12);
    assert.deepEqual(
      { ...(await read()), nextId: 0, tombstones: [] },
      { ...original, nextId: 0, tombstones: [] },
      'one undo removes the entire duplicate while retaining retired IDs',
    );
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(
      length => (window as unknown as Observation).slopesmith.doc().vertices.length === length,
      next.vertices.length,
    );
    assert.deepEqual(
      { ...(await read()), nextId: 0, tombstones: [] },
      { ...next, nextId: 0, tombstones: [] },
      'redo restores the moved copy',
    );
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().vertices.length === 12);
  }
  await page.keyboard.press('Escape');
  await click([0, 0, 0]);
  const beforeCancel = await read();
  await arm();
  await page.keyboard.press('Control+z');
  assert.equal((await state()).pending, false, 'Undo cancels an unplaced copy');
  assert.deepEqual(await read(), beforeCancel, 'cancelling an unplaced copy does not undo earlier work');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  console.log(
    `DUPLICATE BROWSER: PASS (Ctrl+D, private preview, zero movement, return to start, Escape mid-drag, points/edges/patches, undo/redo). Artifacts: ${root}`,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(await page.locator('#dock-right').innerText());
    console.error(`Duplicate browser failure: ${root}`);
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
