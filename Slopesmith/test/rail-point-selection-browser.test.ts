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
import { sampleRail } from '../src/core/rails/rails';
import type { QuadMeshDoc, Rail, V3 } from '../src/core/doc/types';
import type { Viewport } from '../src/app/viewport/viewport';
import type { Mesh, MeshBasicMaterial } from 'three';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-rail-selection-'));
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
  rail: number | null;
  nodes: number[];
  selectedNode: number | null;
  kind: string | null;
  axis: string | null;
  screen: number[];
  directions: Record<'X' | 'Z', number[]>;
  outlines: number;
  marked: V3[];
};
type Observation = {
  slopesmith: { doc(): QuadMeshDoc; errors(): unknown[]; settled(): Promise<unknown> };
  railState(): State;
  projectPoint(point: V3): number[];
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined;
try {
  const doc = blankMountain('RAIL_SELECTION', 30);
  const rail: Rail = {
    id: 'rail:1',
    height: 10,
    style: 13,
    nodes: [
      [0, 10, 0],
      [30, 12, 0],
      [60, 8, 0],
      [90, 16, 0],
      [120, 10, 0],
    ],
    handles: [null, { in: [-10, 1, -2], out: [10, -1, 2] }, null, null, null],
  };
  doc.rails = [
    rail,
    {
      id: 'rail:2',
      height: 10,
      nodes: [
        [0, 10, 50],
        [30, 10, 50],
      ],
      style: 13,
    },
  ];
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
      pos: [60, 220, -25],
      target: [60, 0, -25],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: 100,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(prefix + '-view-v1', view);
  });
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/RAIL_SELECTION?agent=1');
  const loaded = () =>
    page!.waitForFunction(
      () =>
        !!(window as unknown as Observation).slopesmith &&
        document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
      undefined,
      { timeout: 60_000 },
    );
  await loaded();
  const capture = () =>
    page!.evaluate(async () => {
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
            const bounds = viewport.stage.renderer.domElement.getBoundingClientRect();
            point.project(viewport.stage.camera);
            return [bounds.x + ((point.x + 1) * bounds.width) / 2, bounds.y + ((1 - point.y) * bounds.height) / 2];
          };
          observation.projectPoint = point =>
            screen(viewport.stage.camera.position.clone().set(point[0], point[1], -point[2]));
          observation.railState = () => {
            const gizmo = viewport.stage.gizmo,
              anchor = gizmo.object;
            const at = anchor ? screen(anchor.position.clone()) : [];
            const directions = Object.fromEntries(
              (['X', 'Z'] as const).map((axis, i) => {
                const vector = viewport.stage.camera.position.clone().set(i === 0 ? 1 : 0, 0, i === 1 ? 1 : 0);
                if (anchor && gizmo.space === 'local') vector.applyQuaternion(anchor.quaternion);
                const tip = anchor ? screen(anchor.position.clone().add(vector)) : [];
                const length = Math.hypot(tip[0] - at[0], tip[1] - at[1]) || 1;
                return [axis, [(tip[0] - at[0]) / length, (tip[1] - at[1]) / length]];
              }),
            ) as Record<'X' | 'Z', number[]>;
            let outlines = 0;
            const marked: V3[] = [];
            viewport.rails.railGroup.traverse(object => {
              const material = (object as Mesh).material as MeshBasicMaterial | undefined;
              if ((object as Mesh).material === viewport.assets.propOutlineMat) outlines++;
              if (object.userData.railNode !== undefined && material?.color?.getHex() === 0xffffff)
                marked.push(object.position.toArray() as V3);
            });
            return {
              rail: viewport.rails.selectedRail,
              nodes: [...viewport.rails.selectedNodes],
              selectedNode: viewport.rails.selectedNode,
              kind: viewport.stage.gizmoKind,
              axis: gizmo.axis,
              screen: at,
              directions,
              outlines,
              marked,
            };
          };
        },
      });
    });
  await capture();
  await page.getByRole('button', { name: 'Props', exact: true }).first().click();
  await page.keyboard.press('Escape');
  const read = () => page!.evaluate(() => (window as unknown as Observation).slopesmith.doc());
  const state = () => page!.evaluate(() => (window as unknown as Observation).railState());
  const clickData = async (pos: V3, shift = false, twice = false) => {
    const at = await page!.evaluate(pos => (window as unknown as Observation).projectPoint(pos), pos);
    if (shift) await page!.keyboard.down('Shift');
    if (twice) await page!.mouse.dblclick(at[0], at[1]);
    else await page!.mouse.click(at[0], at[1]);
    if (shift) await page!.keyboard.up('Shift');
    await page!.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  };
  const clickPoint = async (index: number, shift = false) => clickData((await read()).rails![0].nodes[index], shift);
  const drag = async (axis: 'X' | 'Z') => {
    const s = await state(),
      direction = s.directions[axis];
    let at = s.screen;
    for (const offset of [25, 35, 45, 55, 65]) {
      at = s.screen.map((n, i) => n + direction[i] * offset);
      await page!.mouse.move(at[0], at[1]);
      if ((await state()).axis === axis) break;
    }
    assert.equal((await state()).axis, axis, 'the selected points share a usable Move gizmo');
    await page!.mouse.down();
    await page!.mouse.move(at[0] + direction[0] * 50, at[1] + direction[1] * 50, { steps: 10 });
    await page!.mouse.up();
    await page!.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  };
  await clickData(sampleRail(rail.nodes, 24, rail.handles)[1]);
  assert.deepEqual((await state()).nodes, [0]);
  assert.equal((await state()).outlines, 0, 'one selected point does not outline the whole pipe');
  const singleBefore = await read();
  await drag('X');
  const singleAfter = await read();
  assert(Math.hypot(...singleAfter.rails![0].nodes[0].map((n, axis) => n - singleBefore.rails![0].nodes[0][axis])) > 1);
  assert.deepEqual(
    singleAfter.rails![0].nodes.slice(1),
    singleBefore.rails![0].nodes.slice(1),
    'a single-point drag only moves that point',
  );
  await page.keyboard.press('Control+z');
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await clickPoint(0);
  await clickPoint(2, true);
  assert.deepEqual((await state()).nodes, [0, 2]);
  assert.equal((await state()).marked.length, 2);
  assert((await state()).outlines > 0);
  const before = await read();
  await drag('X');
  const subset = await read(),
    delta = subset.rails![0].nodes[0].map((n, i) => n - before.rails![0].nodes[0][i]);
  assert(Math.hypot(...delta) > 1);
  for (let i = 0; i < rail.nodes.length; i++) {
    const expected = before.rails![0].nodes[i].map((n, axis) => n + ([0, 2].includes(i) ? delta[axis] : 0));
    assert(
      subset.rails![0].nodes[i].every((n, axis) => Math.abs(n - expected[axis]) < 1e-6),
      'only selected points move, by one shared delta',
    );
  }
  assert.deepEqual(subset.rails![0].handles, before.rails![0].handles);
  assert.deepEqual(
    (await state()).marked,
    [subset.rails![0].nodes[0], subset.rails![0].nodes[2]],
    'selected markers follow the drag',
  );
  await page.keyboard.press('Control+z');
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  assert.deepEqual((await read()).rails, before.rails, 'one undo restores all moved points');
  await clickPoint(1);
  await clickPoint(3, true);
  await clickPoint(1, true);
  assert.deepEqual((await state()).nodes, [3], 'Shift-click removes a point from the group');
  assert.equal((await state()).outlines, 0);
  await clickPoint(4);
  assert.deepEqual((await state()).nodes, [4], 'a plain click returns to a single point');
  await clickPoint(4, true);
  assert.equal((await state()).rail, null, 'Shift-click can deselect the point beneath its own gizmo');
  const railNow = (await read()).rails![0];
  await clickData(sampleRail(railNow.nodes, 24, railNow.handles)[1]);
  await clickData((await read()).rails![0].nodes[1], false, true);
  assert.deepEqual((await state()).nodes, [0, 1, 2, 3, 4], 'double-click selects every point on the rail');
  await clickPoint(2);
  assert.deepEqual((await state()).nodes, [2], 'a plain click on the point beneath the group gizmo selects only it');
  assert.equal((await state()).outlines, 0);
  await clickData((await read()).rails![0].nodes[1], false, true);
  assert.deepEqual((await state()).nodes, [0, 1, 2, 3, 4]);
  const allBefore = await read();
  await drag('Z');
  const allAfter = await read(),
    wholeDelta = allAfter.rails![0].nodes[0].map((n, i) => n - allBefore.rails![0].nodes[0][i]);
  assert(Math.hypot(...wholeDelta) > 1);
  assert(
    allAfter.rails![0].nodes.every((point, i) =>
      point.every((n, axis) => Math.abs(n - allBefore.rails![0].nodes[i][axis] - wholeDelta[axis]) < 1e-6),
    ),
    'the entire rail moves rigidly, including the flipped Z axis',
  );
  assert.deepEqual(allAfter.rails![0].handles, allBefore.rails![0].handles);
  await page.screenshot({ path: join(root, 'rail-group.png') });
  await clickData(allAfter.rails![1].nodes[0], true);
  assert.equal((await state()).rail, 1);
  assert.deepEqual((await state()).nodes, [0], 'Shift-clicking another rail starts a new selection');
  const saved = await read();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.documentElement.dataset.projectSave === 'shared');
  await page.reload();
  await loaded();
  assert.deepEqual((await read()).rails, saved.rails, 'save/reload preserves the group move');
  await capture();
  await page.getByRole('button', { name: 'Props', exact: true }).first().click();
  await clickData(sampleRail(saved.rails![0].nodes, 24, saved.rails![0].handles)[1]);
  assert.deepEqual((await state()).nodes, [0]);
  await clickPoint(2, true);
  assert.deepEqual((await state()).nodes, [0, 2]);
  await page.keyboard.press('Delete');
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  assert.deepEqual(
    (await read()).rails![0].nodes,
    [allAfter.rails![0].nodes[1], allAfter.rails![0].nodes[3], allAfter.rails![0].nodes[4]],
    'Delete removes selected points instead of the entire rail',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  console.log(
    `RAIL POINT SELECTION BROWSER: PASS (single, Shift-click add/remove, double-click all, group drags, markers/outlines, undo, save/reload and subset deletion). Artifacts: ${root}`,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(await page.locator('#dock-right').innerText());
    console.error(JSON.stringify(await page.evaluate(() => (window as unknown as Observation).railState()), null, 2));
    console.error(`Rail selection failure: ${root}`);
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
