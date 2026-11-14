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
import { createSurfaceFromProfiles } from '../src/core/mesh/surface-object';
import { createSubdivisionCage } from '../src/core/mesh/subdivision-object';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import type { Viewport } from '../src/app/viewport/viewport';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-surface-transform-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
type State = { mode: string; axis: string | null; screen: number[]; selected: number };
type Observation = {
  slopesmith: { doc(): QuadMeshDoc; errors(): unknown[]; settled(): Promise<unknown> };
  transformState(): State;
  projectPoint(point: V3): number[];
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined;
const sourcePoints = (doc: QuadMeshDoc) =>
  [...new Set(doc.surfaces![0].controls.flat())].map(id => {
    const at = doc.vertexIds.indexOf(id) * 3;
    return doc.vertices.slice(at, at + 3) as V3;
  });
try {
  const source = blankMountain('SURFACE_TRANSFORM', 30);
  for (let x = 0; x < 3; x++)
    for (let z = 0; z < 3; z++) source.vertices.push(x * 40, x === 1 && z === 1 ? 4 : 0, z * 30);
  source.freeEdges = [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
    [6, 7],
    [7, 8],
  ];
  Object.assign(source, appendMeshIds(source, 9, 0));
  const surface = createSurfaceFromProfiles(
    source,
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    { patchSizeM: 30 },
  );
  assert(surface.ok, surface.ok ? '' : surface.error);
  const cage = structuredClone(source);
  cage.name = 'CAGE_TRANSFORM';
  delete cage.freeEdges;
  cage.quads = [
    [0, 1, 3, 4],
    [1, 2, 4, 5],
    [3, 4, 6, 7],
    [4, 5, 7, 8],
  ];
  Object.assign(cage, appendMeshIds(cage, 0, 4));
  const subdivision = createSubdivisionCage(cage, [0, 1, 2, 3], 1);
  for (const doc of [surface.doc, subdivision.doc]) {
    const response = await fetch(api.url + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: doc }),
    });
    assert(response.ok);
  }
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
      pos: [40, 220, -30],
      target: [40, 0, -30],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: 90,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(prefix + '-view-v1', view);
  });
  const read = () => page!.evaluate(() => (window as unknown as Observation).slopesmith.doc());
  const state = () => page!.evaluate(() => (window as unknown as Observation).transformState());
  const loaded = () =>
    page!.waitForFunction(
      () =>
        !!(window as unknown as Observation).slopesmith &&
        document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
      undefined,
      { timeout: 60_000 },
    );
  for (const name of ['SURFACE_TRANSFORM', 'CAGE_TRANSFORM']) {
    await page.goto(vite.resolvedUrls!.local[0] + `editor/${name}?agent=1`);
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
            const bounds = viewport.stage.renderer.domElement.getBoundingClientRect();
            point.project(viewport.stage.camera);
            return [bounds.x + ((point.x + 1) * bounds.width) / 2, bounds.y + ((1 - point.y) * bounds.height) / 2];
          };
          observation.projectPoint = point =>
            screen(viewport.stage.camera.position.clone().set(point[0], point[1], -point[2]));
          observation.transformState = () => ({
            mode: viewport.stage.gizmo.mode,
            axis: viewport.stage.gizmo.axis,
            screen: viewport.stage.gizmo.object ? screen(viewport.stage.gizmo.object.position.clone()) : [],
            selected: viewport.selection.cornerGroupIdx.length,
          });
        },
      });
    });
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.keyboard.press('Escape');
    const point = await page.evaluate(() => (window as unknown as Observation).projectPoint([20, 0, 12]));
    await page.mouse.click(point[0], point[1]);
    await page.waitForFunction(() => (window as unknown as Observation).transformState().selected === 9);
    const panel = page.locator('#dock-right > .lil-gui:visible');
    const rotate = panel.getByRole('button', { name: 'Rotate', exact: true });
    const scale = panel.getByRole('button', { name: 'Scale', exact: true });
    assert(await rotate.isVisible(), `${name}: whole-surface selection exposes Rotate`);
    assert(await scale.isVisible(), `${name}: whole-surface selection exposes Scale`);
    await panel.getByRole('button', { name: 'World', exact: true }).click();
    await rotate.click();
    await rotate.blur();
    assert.equal((await state()).mode, 'rotate');
    const before = await read(),
      pointsBefore = sourcePoints(before),
      pivot = (await state()).screen;
    let radius = 0;
    const startAngle = Math.PI / 4;
    for (const distance of [55, 65, 75, 85, 95, 105, 115]) {
      await page.mouse.move(pivot[0] + distance * Math.cos(startAngle), pivot[1] + distance * Math.sin(startAngle));
      if ((await state()).axis === 'Y') {
        radius = distance;
        break;
      }
    }
    assert(radius > 0, 'the Y rotation ring is pickable');
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) {
      const angle = startAngle + (step * Math.PI) / 60;
      await page.mouse.move(pivot[0] + radius * Math.cos(angle), pivot[1] + radius * Math.sin(angle));
    }
    await page.mouse.up();
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    const turned = await read(),
      pointsTurned = sourcePoints(turned);
    assert(
      pointsTurned.some((p, i) => Math.hypot(...p.map((n, axis) => n - pointsBefore[i][axis])) > 1),
      'rotation moves the surface controls',
    );
    for (let i = 1; i < pointsBefore.length; i++) {
      const distance = (points: V3[]) => Math.hypot(...points[i].map((n, axis) => n - points[0][axis]));
      assert(Math.abs(distance(pointsBefore) - distance(pointsTurned)) < 1e-5, 'rotation retains the source shape');
    }
    assert.deepEqual(turned.surfaces![0].controls, before.surfaces![0].controls);
    assert(!turned.surfaces![0].error);
    await scale.click();
    await scale.blur();
    assert.equal((await state()).mode, 'scale');
    const scalePivot = (await state()).screen;
    let offset = 0;
    for (const distance of [25, 35, 45, 55, 65]) {
      await page.mouse.move(scalePivot[0] + distance, scalePivot[1]);
      if ((await state()).axis === 'X') {
        offset = distance;
        break;
      }
    }
    assert(offset > 0, 'the X scale handle is pickable');
    await page.mouse.down();
    await page.mouse.move(scalePivot[0] + offset + 35, scalePivot[1], { steps: 10 });
    await page.mouse.up();
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    const scaled = await read(),
      pointsScaled = sourcePoints(scaled);
    const span = (points: V3[]) => Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
    assert(span(pointsScaled) > span(pointsTurned) * 1.1, 'scaling enlarges the surface');
    assert(
      pointsScaled.every(
        (p, i) => Math.abs(p[1] - pointsTurned[i][1]) < 1e-6 && Math.abs(p[2] - pointsTurned[i][2]) < 1e-6,
      ),
      'a world X scale keeps Y and Z unchanged',
    );
    assert(!scaled.surfaces![0].error);
    assert.deepEqual(scaled.surfaces![0].controls, before.surfaces![0].controls);
    await page.screenshot({ path: join(root, `${name}.png`) });
    // W/E/R use the same controls and survive the toolbar rebuilding around a source-point selection.
    await page.keyboard.press('w');
    assert.equal((await state()).mode, 'translate');
    await page.keyboard.press('e');
    assert.equal((await state()).mode, 'rotate');
    await page.keyboard.press('r');
    assert.equal((await state()).mode, 'scale');
    await page.keyboard.press('Control+z');
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    assert.deepEqual(sourcePoints(await read()), pointsTurned, 'Undo restores the pre-scale surface');
    await page.keyboard.press('Control+Shift+z');
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    assert.deepEqual(sourcePoints(await read()), pointsScaled, 'Redo restores the scaled surface');
    assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  }
  assert.deepEqual(errors, []);
  console.log(
    `SURFACE TRANSFORMS: PASS (face selection, Rotate/Scale toolbar, native gizmo drags, source shape, undo/redo, W/E/R; regular and subdivision surfaces). Artifacts: ${root}`,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(await page.locator('#dock-right').innerText());
    console.error(`Surface transform failure: ${root}`);
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
