import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import type { QuadMeshDoc, SurfaceObject, V3 } from '../src/core/doc/types';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { cubicPoint } from '../src/core/math/bezier';
import { add } from '../src/core/math/vec';
import { findCoincidentVertices } from '../src/core/mesh/coincident-vertices';
import { findEdgeCrossings } from '../src/core/mesh/edge-crossings';
import {
  appendGuide,
  chartPoint,
  curveAt,
  guideCharts,
  readGuideCurves,
  sectionCurve,
} from '../src/core/mesh/surface-guides';
import { installSurfaceCharts, type Patch } from '../src/core/mesh/loft-surface';
import { fitSurface } from '../src/core/mesh/surface-fit';
import { createSurfaceFromProfiles } from '../src/core/mesh/surface-object';
import { materializeSurfaceShape } from '../src/core/mesh/surface-source';
import { measureSurfaceObject } from '../src/core/mesh/surface-measure';
import { fmtArea, fmtM } from '../src/app/ui/tool-panels/widgets';
import type { Viewport } from '../src/app/viewport/viewport';
import type { CageLayer } from '../src/app/viewport/mesh/cage';
import type { SelectionLayer } from '../src/app/viewport/mesh/selection';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-surface-'));
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
  surfaceRenders?: { whole: number; streamed: number; extraWires: number };
  surfaceVisibility?: () => {
    sketches: number;
    visibleSketchPoints: number;
    visibleSketchEdges: number;
    drawnSketchEdges: number;
    hiddenOutputPoints: number;
    outputPoints: number;
    drawnTerrainEdges: number;
    terrainIndices: number;
  };
  slopesmith: {
    doc(): QuadMeshDoc;
    errors(): unknown[];
    snapshot(): { selection: { meshVertices: string[]; meshEdges: [string, string][] } };
    settled(): Promise<unknown>;
  };
};

async function project(doc: QuadMeshDoc) {
  const response = await fetch(api.url + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc }),
  });
  assert(response.ok);
}
try {
  const doc = blankMountain('SURFACE_BROWSER', 50);
  for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) doc.vertices.push(r * 30, r === 1 && s === 1 ? 8 : 0, s * 20);
  Object.assign(doc, appendMeshIds(doc, 9, 0));
  doc.freeEdges = [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
    [6, 7],
    [7, 8],
  ];
  await project(doc);
  await project(blankMountain('SURFACE_DRAW', 20));
  const measured = createSurfaceFromProfiles(
    { ...doc, name: 'SURFACE_MEASURE_SNAP' },
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    { patchSizeM: 15 },
  );
  assert(measured.ok, measured.ok ? '' : measured.error);
  await project(measured.doc);
  const boundary = blankMountain('SURFACE_BOUNDARY', 20);
  boundary.vertices = [0, 0, 0, 60, 0, 0, 60, 12, 40, 0, 0, 40];
  Object.assign(boundary, appendMeshIds(boundary, 4, 0));
  boundary.freeEdges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ];
  await project(boundary);
  const arches = blankMountain('SURFACE_ARCHES', 20);
  arches.vertices = [0, 0, 20, 30, 20, 20, 60, 0, 20, 30, 0, -10, 30, 20, 20, 30, 0, 50];
  Object.assign(arches, appendMeshIds(arches, 6, 0));
  arches.freeEdges = [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
  ];
  await project(arches);
  const chain = blankMountain('SURFACE_CHAIN', 20);
  chain.vertices = [0, 0, 0, 0, 0, 40, 60, 0, 0, 60, 0, 40];
  chain.quads = [[0, 1, 2, 3]];
  Object.assign(chain, appendMeshIds(chain, 4, 1));
  await project(chain);
  // Reproduce the saved GARI boundary surface with its old 7 × 32 strip layout, in an isolated project.
  for (const [fixtureName, projectName] of [
    ['surface-layout-gari-boundary', 'SURFACE_FIT_BOUNDARY'],
    ['surface-layout-gari-flat', 'SURFACE_FIT_FLAT'],
  ]) {
    const regression = JSON.parse(readFileSync(new URL(`./fixtures/${fixtureName}.json`, import.meta.url), 'utf8')) as {
      charts: Patch[];
      patchSizeM: number;
      us: number[];
      vs: number[];
    };
    const positions = regression.charts.flatMap(p => p.controls),
      shift = [0, 2].map(
        (axis, i) =>
          [30, 20][i] - (Math.min(...positions.map(p => p[axis])) + Math.max(...positions.map(p => p[axis]))) / 2,
      ),
      seed = regression.charts.map(p => ({
        ...p,
        controls: p.controls.map(([x, y, z]): V3 => [x + shift[0], y, z + shift[1]]),
      })),
      sources = [sectionCurve(seed, 'U', 0), sectionCurve(seed, 'U', 1)];
    let sourceDoc = blankMountain(projectName, regression.patchSizeM);
    const controls = sources.map(source => {
      const appended = appendGuide(sourceDoc, source);
      sourceDoc = appended.doc;
      return appended.names;
    });
    const sourceSurface: SurfaceObject = {
      id: 'surface:1',
      name: 'Surface 1',
      origin: 'boundary',
      interpolation: 'natural',
      controls,
      guides: sources.map(c => ({ axis: c.axis, at: c.at, knots: c.knots })),
      knotsU: [],
      knotsV: [],
      inputs: [],
      vertices: [],
      patches: [],
      patchSizeM: regression.patchSizeM,
      evaluated: { points: sources.map(c => c.points.flat()), patchSizeM: regression.patchSizeM },
    };
    const visible = materializeSurfaceShape(sourceDoc, sourceSurface, seed, regression.patchSizeM * 0.01),
      regressionSurface = visible.surface;
    const strips = fitSurface(seed, regression.patchSizeM, regression),
      installed = installSurfaceCharts(
        visible.doc,
        regressionSurface,
        strips.patches,
        strips.patches,
        strips.us,
        strips.vs,
      );
    installed.doc.surfaces = [{ ...regressionSurface, vertices: installed.vertices, patches: installed.patches }];
    await project(installed.doc);
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
  await page.addInitScript(() => {
    const flat = window.location.pathname.includes('SURFACE_FIT_FLAT');
    const view = JSON.stringify({
      pos: [30, flat ? 500 : 180, -20],
      target: [30, 0, -20],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: flat ? 210 : 65,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(prefix + '-view-v1', view);
  });
  const loaded = async () =>
    page!.waitForFunction(
      () =>
        !!(window as unknown as Observation).slopesmith &&
        document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
      undefined,
      { timeout: 60000 },
    );
  const read = async () => page!.evaluate(() => (window as unknown as Observation).slopesmith.doc());
  const terrain = (doc: QuadMeshDoc, surface = doc.surfaces![0]) => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    const state = {
      ids: surface.vertices,
      patches: surface.patches,
      points: surface.vertices.map(id => {
        const i = doc.vertexIds.indexOf(id);
        return doc.vertices.slice(i * 3, i * 3 + 3);
      }),
      cages: surface.patches.map(p => {
        const q = doc.quadIds.indexOf(p.quad);
        return quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]);
      }),
    };
    // Serializing absolute handles and restoring offsets introduces sub-nanometre roundoff.
    return JSON.parse(
      JSON.stringify(state, (_key, value) => (typeof value === 'number' ? Math.round(value * 1e8) / 1e8 : value)),
    );
  };
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_BROWSER?agent=1');
  await loaded();
  await page.waitForFunction(() => document.documentElement.dataset.projectSave === 'shared', undefined, {
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const panel = page.locator('#dock-right > .lil-gui:visible');
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const field = (name: string) =>
    panel
      .locator('.lil-controller')
      .filter({
        has: page!.locator('.lil-name', {
          hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
        }),
      })
      .locator('input')
      .last();
  const canvas = await page.locator('canvas').first().boundingBox();
  assert(canvas);
  const point = (x: number, z: number) => ({
    x: canvas.x + canvas.width / 2 + ((x - 30) * canvas.height) / 130,
    y: canvas.y + canvas.height / 2 + ((20 - z) * canvas.height) / 130,
  });
  let p = point(0, 10);
  await page.mouse.dblclick(p.x, p.y);
  await button('surface from profiles (B)').click();
  for (const x of [30, 60]) {
    p = point(x, 10);
    await page.mouse.dblclick(p.x, p.y);
    await button('add profile (A)').click();
  }
  await button('create surface (Enter)').click();
  await button('select all control curves').waitFor({ state: 'visible' });
  let current = await read();
  assert.equal(current.surfaces?.length, 1);
  const created = current.surfaces![0];
  assert.equal(created.guides!.length, 3);
  assert.equal(created.controls.flat().length, 9);
  assert(created.patches.every(p => current.quadLocked?.[current.quadIds.indexOf(p.quad)]));
  // Capture the real viewport on the next UI mode switch, then restore its setter immediately.
  await page.evaluate(async () => {
    const moduleName = '/src/app/viewport/viewport.ts';
    const { Viewport: ViewportClass } = (await import(moduleName)) as { Viewport: { prototype: Viewport } };
    const prototype = ViewportClass.prototype;
    const mode = Object.getOwnPropertyDescriptor(prototype, 'mode')!;
    Object.defineProperty(prototype, 'mode', {
      ...mode,
      set(value) {
        Object.defineProperty(prototype, 'mode', mode);
        mode.set!.call(this, value);
        const viewport = this as unknown as {
          cage: boolean;
          meshDoc: QuadMeshDoc;
          cageLayer: CageLayer;
          selection: SelectionLayer;
          terrain: { geometry: { index: { count: number } } };
        };
        (window as unknown as Observation).surfaceVisibility = () => {
          // Test with the optional cage enabled, just as when examining a course in wireframe.
          viewport.cage = true;
          const d = viewport.meshDoc,
            surface = d.surfaces![0],
            terrain = new Set(d.quads.flat()),
            sketches = new Set(surface.inputs.map(id => d.vertexIds.indexOf(id)).filter(v => !terrain.has(v))),
            edges = (d.freeEdges ?? []).filter(([a, b]) => sketches.has(a) || sketches.has(b)),
            outputs = surface.vertices.map(id => d.vertexIds.indexOf(id));
          return {
            sketches: sketches.size,
            visibleSketchPoints: [...sketches].filter(v => !viewport.selection.vertexHidden(v)).length,
            visibleSketchEdges: edges.filter(([a, b]) => !viewport.selection.edgeHidden(a, b)).length,
            drawnSketchEdges: edges.filter(([a, b]) => viewport.cageLayer.edgeRange(a < b ? `${a},${b}` : `${b},${a}`))
              .length,
            hiddenOutputPoints: outputs.filter(v => viewport.selection.vertexHidden(v)).length,
            outputPoints: outputs.length,
            drawnTerrainEdges: d.quads
              .flatMap(([a, b, c, e]) => [
                [a, b],
                [b, e],
                [e, c],
                [c, a],
              ])
              .filter(([a, b]) => viewport.cageLayer.edgeRange(a < b ? `${a},${b}` : `${b},${a}`)).length,
            terrainIndices: viewport.terrain.geometry.index.count,
          };
        };
      },
    });
  });
  for (const name of ['Test', 'Edit']) {
    await page.getByRole('button', { name, exact: true }).first().click();
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    const visibility: ReturnType<NonNullable<Observation['surfaceVisibility']>> = await page.evaluate(() =>
      (window as unknown as Observation).surfaceVisibility!(),
    );
    assert(visibility.sketches > 0, 'the original construction sketch is retained');
    assert.equal(visibility.visibleSketchPoints, 0, `${name} hides consumed sketch points`);
    assert.equal(visibility.visibleSketchEdges, 0, `${name} hides consumed sketch edges`);
    assert.equal(visibility.drawnSketchEdges, 0, `${name} omits the original outline from the cage buffers`);
    assert.equal(visibility.hiddenOutputPoints, name === 'Edit' ? visibility.outputPoints : 0);
    assert.equal(visibility.drawnTerrainEdges > 0, name === 'Test', 'terrain wires remain available in Test');
    assert(visibility.terrainIndices > 0, 'the generated terrain remains rendered');
  }
  assert.deepEqual(await read(), current, 'changing modes only changes visibility');
  await button('Surface 1').click();
  await button('World').click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const peakHeight = (doc: QuadMeshDoc) => chartPoint(guideCharts(doc, doc.surfaces![0]), 0.5, 0.5)[1];
  await page.keyboard.press('Escape');
  p = point(30, 10);
  await page.mouse.dblclick(p.x, p.y);
  await button('copy curve (Ctrl+C)').waitFor();
  const beforeCopy = await read();
  await page.keyboard.press('Control+c');
  assert(await button('paste curve (Ctrl+V)').isEnabled(), 'Ctrl+C captures the selected control curve');
  await page.keyboard.press('Control+d');
  await button('cancel placement (Esc)').waitFor();
  p = point(45, 20);
  await page.mouse.move(p.x, p.y);
  assert.deepEqual(await read(), beforeCopy, 'a duplicate preview does not change the surface');
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].guides!.length === 4,
  );
  const duplicated = await read(),
    duplicatedCurve = readGuideCurves(duplicated, duplicated.surfaces![0]).at(-1)!;
  assert(Math.abs(curveAt(duplicatedCurve, 0.5)[1] - 8) < 1e-5, 'duplicate keeps the copied bump profile');
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].guides!.length === 3,
  );
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await button('Surface 1').click();
  await page.keyboard.press('Control+v');
  await button('cancel placement (Esc)').waitFor();
  p = point(15, 20);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('Escape');
  assert.equal((await read()).surfaces![0].guides!.length, 3, 'Esc cancels a pasted preview');
  await page.keyboard.press('Control+v');
  await button('cancel placement (Esc)').waitFor();
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].guides!.length === 4,
  );
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].guides!.length === 3,
  );
  await page.keyboard.press('Escape');
  p = point(30, 20);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Delete');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].controls[1].length === 2,
  );
  assert(Math.abs(peakHeight(await read())) < 1e-7, 'Delete removes the peak and reshapes the surface');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].controls[1].length === 3,
  );
  assert(Math.abs(peakHeight(await read()) - peakHeight(current)) < 1e-7, 'undo restores the point and hill');
  await button('Surface 1').click();
  await panel
    .locator('.lil-controller')
    .filter({ has: page.locator('.lil-name', { hasText: /^direction$/ }) })
    .locator('select')
    .selectOption({ label: 'V' });
  const beforeOrientation = await read();
  await button('add control curve').click();
  await button('orientation: V → U').click();
  await button('orientation: U → V').waitFor();
  assert.deepEqual(await read(), beforeOrientation, 'switching curve orientation is transient');
  await button('orientation: U → V').click();
  await button('orientation: V → U').waitFor();
  p = point(45, 12);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await field('curve').waitFor();
  const crossed = await read(),
    guidePath = crossed.surfaces![0].controls[1];
  assert.equal(crossed.surfaces![0].guides!.at(-1)!.axis, 'V', 'the new curve uses the chosen orientation');
  assert.deepEqual(terrain(crossed), terrain(beforeOrientation), 'changing orientation preserves the surface');
  const edgeSelection = () =>
    page!.evaluate(() => (window as unknown as Observation).slopesmith.snapshot().selection.meshEdges);
  await page.keyboard.press('Escape');
  p = point(30, 7);
  await page.mouse.dblclick(p.x, p.y);
  assert.equal(
    (await edgeSelection()).length,
    guidePath.length - 1,
    'double-click selects the whole control curve through a crossing',
  );
  assert(
    (await edgeSelection()).every(e => e.every(id => guidePath.includes(id))),
    'selection stays on this curve',
  );
  await page.keyboard.press('Escape');
  await page.mouse.click(p.x, p.y);
  assert.equal((await edgeSelection()).length, 1);
  p = point(30, 30);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  assert.equal(
    (await edgeSelection()).length,
    guidePath.length - 1,
    'Shift-click ranges along a guide through shared crossings',
  );
  await page.keyboard.press('Delete');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].guides!.length === 3,
  );
  assert(peakHeight(await read()) < peakHeight(crossed) - 0.1, 'deleting the selected control curve relaxes its shape');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].guides!.length === 4,
  );
  assert.deepEqual((await read()).surfaces![0].controls, crossed.surfaces![0].controls, 'undo restores the curve');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].guides!.length === 3,
  );
  await page.waitForTimeout(1000);
  assert.deepEqual((await read()).surfaces![0].controls, created.controls, 'undo the temporary cross-guide');
  await button('Surface 1').click();
  await button('World').click();
  const monitorRenders = () =>
    page!.evaluate(async () => {
      const moduleName = '/src/app/viewport/viewport.ts';
      const { Viewport: ViewportClass } = (await import(moduleName)) as { Viewport: { prototype: Viewport } };
      const counts = { whole: 0, streamed: 0, extraWires: 0 };
      (window as unknown as Observation).surfaceRenders = counts;
      const whole = ViewportClass.prototype.setMountain,
        streamed = ViewportClass.prototype.previewMeshEdit;
      ViewportClass.prototype.setMountain = function (...args) {
        counts.whole++;
        return whole.apply(this, args);
      };
      ViewportClass.prototype.previewMeshEdit = function (...args) {
        counts.streamed++;
        const result = streamed.apply(this, args);
        const overlay = this as unknown as { liveEditCageGroup: { children: unknown[] } };
        counts.extraWires = Math.max(counts.extraWires, overlay.liveEditCageGroup.children.length);
        return result;
      };
    });
  await monitorRenders();
  const center = point(30, 20);
  await page.mouse.move(center.x + 45, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 85, center.y, { steps: 8 });
  const duringDrag = await read();
  assert.deepEqual(duringDrag.surfaces![0].vertices, created.vertices, 'drag frames retain output names');
  assert.deepEqual(
    duringDrag.surfaces![0].patches.map(p => [p.quad, p.corners]),
    created.patches.map(p => [p.quad, p.corners]),
    'spacing can move during a drag while terrain connectivity stays fixed',
  );
  await page.waitForFunction(() => (window as unknown as Observation).surfaceRenders!.streamed > 0);
  const renders = await page.evaluate(() => (window as unknown as Observation).surfaceRenders!);
  assert.equal(renders.whole, 0, 'dragging does not rebuild the full viewport');
  assert(renders.streamed > 0, 'source motion reaches the incremental viewport preview');
  assert.equal(renders.extraWires, 0, 'streaming does not expose hidden generated terrain edges');
  await page.screenshot({ path: join(root, 'live-surface-drag.png') });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const d = (window as unknown as Observation).slopesmith.doc(),
      s = d.surfaces![0];
    return (
      d.vertices[d.vertexIds.indexOf(s.controls[0][0]) * 3] > 1 &&
      d.vertices[d.vertexIds.indexOf(s.vertices[0]) * 3] > 1
    );
  });
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  assert.deepEqual(
    (await page.evaluate(() => (window as unknown as Observation).slopesmith.snapshot())).selection.meshVertices,
    created.controls.flat(),
    'the source gesture retains its control selection',
  );
  const direction = () =>
    panel
      .locator('.lil-controller')
      .filter({ has: page!.locator('.lil-name', { hasText: /^direction$/ }) })
      .locator('select');
  await page.waitForTimeout(1200); // Let the initial creation/transform reach the room before separate placement gestures.
  for (const axis of ['U', 'V']) {
    await direction().selectOption({ label: axis });
    if (axis === 'U') {
      await field('curve').fill('2');
      await field('curve').press('Tab');
    }
    const before = (await read()).surfaces![0];
    const beforePlacement = await read(),
      output = terrain(beforePlacement);
    const count = before.guides!.filter(g => g.axis === axis).length;
    await button('add control curve').click();
    await button('cancel placement (Esc)').waitFor();
    p = point(45, 12);
    await page.mouse.move(p.x, p.y);
    assert.deepEqual(await read(), beforePlacement, 'placement hover is transient');
    if (axis === 'U') {
      await page.screenshot({ path: join(root, 'guide-placement.png') });
      await page.keyboard.press('Escape');
      await button('add control curve').waitFor();
      assert.deepEqual(await read(), beforePlacement, 'Escape cancels without document changes');
      await button('add control curve').click();
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.click(p.x, p.y);
    await page.waitForFunction(
      ({ axis, count }) => {
        const s = (window as unknown as Observation).slopesmith.doc().surfaces![0];
        return s.guides!.filter(g => g.axis === axis).length === count + 1;
      },
      { axis, count },
    );
    assert.deepEqual(
      terrain(await read()),
      output,
      'setting a new guide preserves the generated vertices and patch cages',
    );
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    await page.waitForTimeout(700);
    await button('reposition curve on surface').click();
    await button('cancel placement (Esc)').waitFor();
    assert.equal(
      await panel.getByRole('button', { name: /^orientation:/ }).count(),
      0,
      'existing curves keep their axis during repositioning',
    );
    p = point(50, 27);
    const beforeMove = await read();
    await page.mouse.move(p.x, p.y);
    assert.deepEqual(await read(), beforeMove, 'reposition hover is transient');
    await page.mouse.click(p.x, p.y);
    await button('reposition curve on surface').waitFor();
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    await page.waitForTimeout(700);
    assert(!(await read()).surfaces![0].seed, 'reposition uses visible controls without a hidden rest shape');
    await button('delete control curve').click();
    await page.waitForFunction(
      ({ axis, count }) => {
        const s = (window as unknown as Observation).slopesmith.doc().surfaces![0];
        return s.guides!.filter(g => g.axis === axis).length === count;
      },
      { axis, count },
    );
    await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
    await page.waitForTimeout(700);
    assert.equal(
      (await read()).surfaces![0].guides!.filter(g => g.axis === axis).length,
      count,
      'guide removal persists after the committed action',
    );
  }
  // New points split explicit curves; deletion rebuilds them from the remaining controls.
  await direction().selectOption({ label: 'U' });
  const beforePoints = await read(),
    pointTerrain = terrain(beforePoints);
  const guideIndex = beforePoints.surfaces![0].guides!.findIndex(g => g.axis === 'U');
  const oldPointCount = beforePoints.surfaces![0].controls[guideIndex].length;
  await button('add control point').click();
  p = point(20, 25);
  await page.mouse.move(p.x, p.y);
  assert.deepEqual(await read(), beforePoints, 'point preview does not edit the document');
  await page.mouse.click(p.x, p.y);
  await field('control point').waitFor();
  assert.equal((await read()).surfaces![0].controls[guideIndex].length, oldPointCount + 1);
  assert.deepEqual(terrain(await read()), pointTerrain);
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await page.waitForTimeout(700);
  await button('reposition control point').click();
  const beforePointMove = await read();
  p = point(20, 12);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  assert.deepEqual(await read(), beforePointMove, 'an occupied point station does not commit');
  p = point(20, 7);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await field('control point').waitFor();
  assert.deepEqual(terrain(await read()), pointTerrain);
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await page.waitForTimeout(700);
  await button('delete control point').click();
  await field('control point').waitFor();
  assert.equal((await read()).surfaces![0].controls[guideIndex].length, oldPointCount);
  assert(!(await read()).surfaces![0].seed, 'deleting the point rebuilds from visible controls');
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await page.waitForTimeout(700);
  // A selected row uses the ordinary gizmo, changing source controls and evaluated terrain together.
  await direction().selectOption({ label: 'V' });
  await button('add control curve').click();
  p = point(45, 12);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await field('curve').waitFor();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  current = await read();
  const curveIndex = current.surfaces![0].guides!.findIndex(g => g.axis === 'V');
  const row = current.surfaces![0].controls[curveIndex].map(id => current.vertexIds.indexOf(id));
  const mid = row.reduce(
    (p, i) => [p[0] + current.vertices[i * 3] / row.length, p[1] + current.vertices[i * 3 + 2] / row.length],
    [0, 0],
  );
  const pivot = point(mid[0], mid[1]);
  const sourceX = current.vertices[row[0] * 3];
  await page.mouse.move(pivot.x + 45, pivot.y);
  await page.mouse.down();
  await page.mouse.move(pivot.x + 75, pivot.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction((oldX: number) => {
    const d = (window as unknown as Observation).slopesmith.doc();
    const index = d.surfaces![0].guides!.findIndex(g => g.axis === 'V');
    return d.vertices[d.vertexIds.indexOf(d.surfaces![0].controls[index][0]) * 3] > oldX + 1;
  }, sourceX);
  const sourceIds = (await read()).surfaces![0].controls;
  assert(
    (await page.evaluate(() => (window as unknown as Observation).slopesmith.snapshot())).selection.meshVertices
      .length > 0,
    'a source drag retains its named selection',
  );
  await page.waitForTimeout(700); // Commit the shape gesture before the separately undoable density edit.
  await field('patch size (m)').fill('10');
  await field('patch size (m)').press('Tab');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces![0].patchSizeM === 10);
  const dense = await read();
  assert(dense.surfaces![0].patches.length > created.patches.length);
  assert.deepEqual(dense.surfaces![0].controls, sourceIds, 'density does not change the control curves');
  const denseAverage = measureSurfaceObject(dense, dense.surfaces![0]).averagePatchSize!;
  const denseAverageText = `${denseAverage.length.toFixed(1)} × ${denseAverage.width.toFixed(1)} m`;
  await page.waitForFunction(
    expected =>
      [...document.querySelectorAll<HTMLInputElement>('#dock-right input')].some(input => input.value === expected),
    denseAverageText,
  );
  assert.equal(
    await field('avg patch size').inputValue(),
    denseAverageText,
    'average patch size follows density edits',
  );
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces?.[0]?.patchSizeM === 50,
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces![0].patchSizeM === 10);
  await page.waitForTimeout(1200);
  await page.reload();
  await loaded();
  assert.deepEqual((await read()).surfaces![0].controls, sourceIds);
  await page.keyboard.press('Escape');
  await button('Surface 1').click();
  const beforeRefit = await read();
  await button('refit patch layout').click();
  await button('bake surface').waitFor();
  assert.deepEqual(
    (await read()).surfaces![0].controls,
    beforeRefit.surfaces![0].controls,
    'refit keeps source controls',
  );
  await page.screenshot({ path: process.env.SLOPESMITH_SURFACE_SCREENSHOT ?? join(root, 'surface.png') });
  const beforeBake = await read(),
    beforeBakeTerrain = terrain(beforeBake);
  await button('bake surface').click();
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  const baked = await read();
  assert(!Object.keys(baked.quadLocked ?? {}).length);
  assert.equal(baked.freeEdges?.length ?? 0, 0, 'bake removes hidden construction curves');
  assert.equal(findCoincidentVertices(baked).length, 0, 'bake creates no coincident copies');
  assert.equal(findEdgeCrossings(baked).length, 0, 'baked terrain has no overlapping source edges');
  assert.deepEqual(terrain(baked, beforeBake.surfaces![0]), beforeBakeTerrain);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces?.length === 1);
  assert.deepEqual((await read()).surfaces, beforeBake.surfaces, 'immediate undo restores the source object');
  assert.deepEqual(terrain(await read()), beforeBakeTerrain);
  await button('Surface 1').click();
  await button('bake surface').waitFor();
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces?.length === 1);
  await page.waitForTimeout(1200);
  const restoredBake = await read();
  assert.equal(restoredBake.surfaces?.length, 1, 'autosave keeps the undone bake');
  assert.deepEqual(restoredBake.surfaces, beforeBake.surfaces);
  await page.reload();
  await loaded();
  assert.deepEqual((await read()).surfaces, beforeBake.surfaces, 'restored source object survives reload');
  assert.deepEqual(terrain(await read()), beforeBakeTerrain);
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_BOUNDARY?agent=1');
  await loaded();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const handle = meshFromDoc(boundary).edgeHandle;
  const A = [boundary.vertices[0], boundary.vertices[1], boundary.vertices[2]] as [number, number, number];
  const B = [boundary.vertices[9], boundary.vertices[10], boundary.vertices[11]] as [number, number, number];
  const boundaryMid = cubicPoint(A, add(A, handle(0, 3)), add(B, handle(3, 0)), B, 0.5);
  p = point(boundaryMid[0], boundaryMid[2]);
  await page.mouse.dblclick(p.x, p.y);
  await button('create surface from loop').click();
  await button('select all control curves').waitFor();
  const filled = await read();
  assert.equal(filled.surfaces![0].origin, 'boundary');
  assert(filled.surfaces![0].patches.length > 0);
  assert(
    filled.surfaces![0].evaluated.points.flat().some(p => p[1] > 1),
    'nonplanar boundary carries its elevation into the surface',
  );
  const boundaryOutput = terrain(filled);
  for (const axis of ['U', 'V']) {
    await direction().selectOption({ label: axis });
    for (const row of [1, 2]) {
      await field('curve').fill(String(row));
      await field('curve').press('Tab');
      for (const action of ['delete control curve', 'delete control curve', 'reposition curve on surface'])
        assert(await button(action).isDisabled(), `${axis} boundary ${row} protects ${action}`);
      await button('select curve').click();
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await page.keyboard.press('Delete');
      await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
      assert.deepEqual((await read()).surfaces, filled.surfaces, 'Delete cannot remove a boundary curve');
      assert.deepEqual(terrain(await read()), boundaryOutput);
    }
  }
  await page.keyboard.press('Escape');
  const boundaryCorner = filled.surfaces![0].controls[0][0],
    cornerIndex = filled.vertexIds.indexOf(boundaryCorner),
    cornerPosition = filled.vertices.slice(cornerIndex * 3, cornerIndex * 3 + 3);
  p = point(cornerPosition[0], cornerPosition[2]);
  await page.mouse.click(p.x, p.y);
  await button('World').click();
  await page.mouse.move(p.x + 45, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 70, p.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    ({ id, x }) => {
      const doc = (window as unknown as Observation).slopesmith.doc();
      return Math.abs(doc.vertices[doc.vertexIds.indexOf(id) * 3] - x) > 1;
    },
    { id: boundaryCorner, x: cornerPosition[0] },
  );
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const cornerMoved = await read();
  for (const curve of readGuideCurves(cornerMoved, cornerMoved.surfaces![0])) {
    assert.equal(curve.points.length, 1);
    const cp = curve.points[0];
    for (let i = 1; i < 3; i++)
      assert(
        Math.hypot(...cp[i].map((v, axis) => v - (cp[0][axis] * (1 - i / 3) + (cp[3][axis] * i) / 3))) < 1e-6,
        'moving a boundary corner does not invent curvature in a two-point side',
      );
  }
  await page.screenshot({ path: join(root, 'straight-boundary-drag.png') });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    ({ id, x }) => {
      const doc = (window as unknown as Observation).slopesmith.doc();
      return Math.abs(doc.vertices[doc.vertexIds.indexOf(id) * 3] - x) < 1e-6;
    },
    { id: boundaryCorner, x: cornerPosition[0] },
  );
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await button('add control curve').click();
  p = point(30, 15);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await button('reposition curve on surface').waitFor();
  await button('reposition curve on surface').click();
  await button('cancel placement (Esc)').waitFor();
  p = point(30, 15);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await button('reposition curve on surface').waitFor();
  assert.deepEqual(
    terrain(await read()),
    boundaryOutput,
    'interior guides still slide without changing the terrain while the four boundary curves remain',
  );
  await page.waitForTimeout(1200);
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_ARCHES?agent=1');
  await loaded();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  p = point(15, 20);
  await page.mouse.dblclick(p.x, p.y);
  await button('surface from profiles (B)').click();
  p = point(30, 5);
  await page.mouse.dblclick(p.x, p.y);
  await button('add profile (A)').click();
  await button('create surface (Enter)').click();
  await button('select all control curves').waitFor();
  const hill = (await read()).surfaces![0];
  assert.equal(hill.guides!.length, 6, 'the hill has two arches and four explicit boundary guides');
  assert.deepEqual([...new Set(hill.guides!.map(g => g.axis))].sort(), ['U', 'V']);
  assert(
    hill.controls[0].some(id => hill.controls[1].includes(id)),
    'the two input arches share their peak',
  );
  await page.screenshot({ path: join(root, 'crossing-arches.png') });
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_CHAIN?agent=1');
  await loaded();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  await page.keyboard.press('l');
  await button('✔ finish edge chain (Enter)').waitFor();
  const chainBefore = await read();
  await monitorRenders();
  for (const [x, z] of [
    [10, 10],
    [20, 15],
    [30, 10],
    [40, 15],
  ]) {
    const at = point(x, z);
    await page.mouse.click(at.x, at.y);
  }
  await page.keyboard.press('Enter');
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const chainAfter = await read();
  assert.equal(chainAfter.freeEdges?.length, 3);
  assert.deepEqual(chainAfter.quads, chainBefore.quads, 'a loose chain leaves terrain topology alone');
  assert.deepEqual(chainAfter.vertices.slice(0, 12), chainBefore.vertices);
  assert.equal(
    (await page.evaluate(() => (window as unknown as Observation).surfaceRenders!)).whole,
    0,
    'chain clicks retain the terrain buffers',
  );
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_FIT_BOUNDARY?agent=1');
  await loaded();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  assert.equal((await read()).surfaces![0].patches.length, 224, 'saved strip layout reproduces the report');
  await button('Surface 1').click();
  const sourceBeforeRefit = (await read()).surfaces![0];
  await page.screenshot({ path: join(root, 'gari-boundary-before.png') });
  await button('refit patch layout').click();
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].patches.length <= 12,
  );
  const refitted = (await read()).surfaces![0];
  assert(refitted.patches.length <= 12, 'refit uses broad fitted patches instead of source-derivative strips');
  const boundaryFitCount = refitted.patches.length;
  assert.deepEqual(refitted.controls, sourceBeforeRefit.controls);
  assert.deepEqual(refitted.seed, sourceBeforeRefit.seed);
  assert.deepEqual(refitted.evaluated.points, sourceBeforeRefit.evaluated.points);
  await page.screenshot({ path: join(root, 'gari-boundary-after.png') });
  await page.waitForTimeout(1200);
  await page.reload();
  await loaded();
  assert.equal(
    (await read()).surfaces![0].patches.length,
    boundaryFitCount,
    'the fitted layout survives autosave/reload',
  );
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_FIT_FLAT?agent=1');
  await loaded();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await button('Surface 1').click();
  const flatBefore = await read();
  assert.equal(flatBefore.surfaces![0].patches.length, 966, 'reproduce the current GARI flat-fill strip count');
  assert.equal(flatBefore.surfaces![0].patchSizeM, 20);
  assert(measureSurfaceObject(flatBefore, flatBefore.surfaces![0]).averagePatchSize!.length < 6);
  await page.screenshot({ path: join(root, 'gari-flat-before.png') });
  await button('refit patch layout').click();
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].patches.length <= 200,
  );
  const flatAfter = await read(),
    flatAverage = measureSurfaceObject(flatAfter, flatAfter.surfaces![0]).averagePatchSize!;
  const flatFitCount = flatAfter.surfaces![0].patches.length;
  assert(flatFitCount >= 130 && flatFitCount <= 180);
  assert(flatAverage.length > 16 && flatAverage.length < 24);
  assert(flatAverage.width > 16 && flatAverage.width < 24);
  assert.deepEqual(
    flatAfter.surfaces![0].controls,
    flatBefore.surfaces![0].controls,
    'refitting preserves the source guides',
  );
  assert.deepEqual(
    flatAfter.surfaces![0].seed,
    flatBefore.surfaces![0].seed,
    'refitting does not introduce a hidden base shape',
  );
  assert.equal(
    await field('avg patch size').inputValue(),
    `${flatAverage.length.toFixed(1)} × ${flatAverage.width.toFixed(1)} m`,
  );
  await page.screenshot({ path: join(root, 'gari-flat-after.png') });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].patches.length === 966,
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    count => (window as unknown as Observation).slopesmith.doc().surfaces![0].patches.length === count,
    flatFitCount,
  );
  await page.waitForTimeout(1200);
  await page.reload();
  await loaded();
  assert.equal(
    (await read()).surfaces![0].patches.length,
    154,
    'the target-sized layout survives undo, redo and save/reload',
  );
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_MEASURE_SNAP?agent=1');
  await loaded();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await button('Surface 1').click();
  const metricSource = await read(),
    metrics = measureSurfaceObject(metricSource, metricSource.surfaces![0]);
  assert.equal(await field('area').inputValue(), fmtArea(metrics.area));
  assert.equal(
    await field('avg patch size').inputValue(),
    `${metrics.averagePatchSize!.length.toFixed(1)} × ${metrics.averagePatchSize!.width.toFixed(1)} m`,
  );
  assert.equal(
    await field('area').evaluate(
      input => input.closest('.lil-controller')?.nextElementSibling?.querySelector('.lil-name')?.textContent,
    ),
    'avg patch size',
    'average dimensions sit directly below surface area',
  );
  await field('curve').fill('2');
  await field('curve').press('Tab');
  await page.waitForFunction(
    expected =>
      [...document.querySelectorAll<HTMLInputElement>('#dock-right input')].some(input => input.value === expected),
    fmtM(metrics.curveLength(1)),
  );
  assert.equal(
    await field('length').inputValue(),
    fmtM(metrics.curveLength(1)),
    'selected curve displays its full curved length',
  );
  assert(parseFloat(await field('length').inputValue()) > 40);
  const sourceShape = async () => {
    const doc = await read();
    return readGuideCurves(doc, doc.surfaces![0]).map(curve => curve.points);
  };
  const curvatureKey = async (key: string) => {
    // lil-gui intentionally stops global shortcuts while a controller has focus.
    await page!.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page!.keyboard.press(key);
    await page!.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  };
  const smoothCurve = await sourceShape();
  await button('crease (C)').click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const creasedCurve = await sourceShape();
  assert.notDeepEqual(creasedCurve[1], smoothCurve[1], 'the curve button creases the selected control curve');
  assert.deepEqual(creasedCurve[0], smoothCurve[0], 'other control curves are unchanged');
  assert.deepEqual(creasedCurve[2], smoothCurve[2]);
  await button('smooth (S)').click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const buttonSmoothedCurve = await sourceShape();
  await curvatureKey('c');
  assert.deepEqual(await sourceShape(), creasedCurve, 'curve button matches the C shortcut');
  await curvatureKey('s');
  assert.deepEqual(await sourceShape(), buttonSmoothedCurve, 'curve button matches the S shortcut');
  await page.keyboard.press('Escape');
  p = point(30, 20);
  await page.mouse.click(p.x, p.y);
  await button('crease (C)').click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const creasedPoint = await sourceShape();
  await button('smooth (S)').click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const smoothPoint = await sourceShape();
  assert.notDeepEqual(creasedPoint[1], smoothPoint[1], 'point buttons reshape the selected source point');
  await curvatureKey('c');
  assert.deepEqual(await sourceShape(), creasedPoint, 'point button matches the C shortcut');
  await curvatureKey('s');
  assert.deepEqual(await sourceShape(), smoothPoint, 'point button matches the S shortcut');
  await page.screenshot({ path: join(root, 'surface-point-shape-buttons.png') });
  await direction().selectOption({ label: 'V' });
  await button('add control curve').click();
  const snapBefore = await read();
  p = point(30, 20.6); // Near the middle points, but deliberately not exactly on their station.
  await page.mouse.move(p.x, p.y);
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLInputElement>('#dock-right input')].some(
      input => input.value === 'reuse 3 points',
    ),
  );
  assert.deepEqual(await read(), snapBefore, 'snapped preview is transient');
  await page.screenshot({ path: join(root, 'guide-snap-preview.png') });
  await page.keyboard.press('Escape');
  await button('add control curve').waitFor();
  assert.deepEqual(await read(), snapBefore, 'cancelling a snapped preview changes nothing');
  await button('add control curve').click();
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await button('reposition curve on surface').waitFor();
  const snappedDoc = await read();
  assert.deepEqual(
    snappedDoc.surfaces![0].controls.at(-1),
    snapBefore.surfaces![0].controls.map(row => row[1]),
    'click reuses exactly the existing point IDs highlighted by the preview',
  );
  assert.equal(snappedDoc.surfaces![0].guides!.at(-1)!.at, 0.5);
  assert.deepEqual(terrain(snappedDoc), terrain(snapBefore));
  assert.equal(await field('area').inputValue(), fmtArea(metrics.area));
  await page.waitForTimeout(1200);
  await page.reload();
  await loaded();
  assert.deepEqual(
    (await read()).surfaces![0].controls,
    snappedDoc.surfaces![0].controls,
    'shared source points survive save/reload',
  );
  await page.keyboard.press('Escape');
  await button('Surface 1').click();
  await button('select all control curves').click();
  await button('crease (C)').click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const wholeCreased = await sourceShape(),
    wholeBefore = await read();
  await button('smooth (S)').click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const wholeSmoothed = await sourceShape(),
    wholeAfter = await read();
  assert.notDeepEqual(wholeSmoothed, wholeCreased, 'whole-surface Smooth changes the control curves');
  const wholeCurves = readGuideCurves(wholeAfter, wholeAfter.surfaces![0]);
  assert(wholeCurves.some(c => c.axis === 'U') && wholeCurves.some(c => c.axis === 'V'));
  for (const curve of wholeCurves) {
    for (let i = 1; i < curve.knots.length - 1; i++) {
      const before = curve.points[i - 1],
        after = curve.points[i];
      for (let axis = 0; axis < 3; axis++) {
        const incoming = (before[3][axis] - before[2][axis]) / (curve.knots[i] - curve.knots[i - 1]),
          outgoing = (after[1][axis] - after[0][axis]) / (curve.knots[i + 1] - curve.knots[i]);
        assert(Math.abs(incoming - outgoing) < 1e-6, 'every internal U/V control point is smooth through its crossing');
      }
    }
  }
  for (const id of wholeAfter.surfaces![0].controls.flat()) {
    const a = wholeBefore.vertexIds.indexOf(id),
      b = wholeAfter.vertexIds.indexOf(id);
    assert.deepEqual(
      wholeAfter.vertices.slice(b * 3, b * 3 + 3),
      wholeBefore.vertices.slice(a * 3, a * 3 + 3),
      'smoothing keeps the guide points fixed',
    );
  }
  await curvatureKey('c');
  assert.deepEqual(await sourceShape(), wholeCreased, 'whole-surface Crease button matches C');
  await curvatureKey('s');
  assert.deepEqual(await sourceShape(), wholeSmoothed, 'whole-surface Smooth button matches S across all guide curves');
  await page.screenshot({ path: join(root, 'whole-surface-smooth.png') });
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SURFACE_DRAW?agent=1');
  await loaded();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await button('▦ create grid').waitFor();
  const emptyDrawing = await read();
  await button('▱ create surface').click();
  const clickBoundary = async (x: number, z: number) => {
    const p = point(x, z);
    await page!.mouse.click(p.x, p.y);
  };
  const boundaryCount = async (expected: number) =>
    page!.waitForFunction(expected => {
      const row = [...document.querySelectorAll('#dock-right .lil-controller')].find(
        el => el.querySelector('.lil-name')?.textContent === 'boundary points',
      );
      return row?.querySelector('input')?.value === String(expected);
    }, expected);
  const draftReadout = async (name: string, value: string) =>
    page!.waitForFunction(
      ({ name, value }) => {
        const row = [...document.querySelectorAll('#dock-right .lil-controller')]
          .reverse()
          .find(el => el.getClientRects().length > 0 && el.querySelector('.lil-name')?.textContent === name);
        return row?.querySelector('input')?.value === value;
      },
      { name, value },
    );
  await field('patch size (m)').fill('15');
  await field('patch size (m)').press('Tab');
  for (const [x, z] of [
    [0, 0],
    [60, 0],
    [60, 40],
  ])
    await clickBoundary(x, z);
  await boundaryCount(3);
  p = point(0, 40);
  await page.mouse.move(p.x, p.y);
  await draftReadout('current edge length', fmtM(60));
  await draftReadout('surface area', fmtArea(2400));
  assert.deepEqual(await read(), emptyDrawing, 'surface drawing and hover do not edit the document');
  await page.screenshot({ path: join(root, 'surface-draw-preview.png') });
  await page.keyboard.press('Backspace');
  await boundaryCount(2);
  await clickBoundary(60, 40);
  await clickBoundary(0, 40);
  await boundaryCount(4);
  p = point(0, 0);
  await page.mouse.move(p.x + 5, p.y + 4);
  await page.mouse.click(p.x + 5, p.y + 4);
  await draftReadout('preview', 'edit boundary points · Enter to create');
  assert.deepEqual(await read(), emptyDrawing, 'closing keeps the boundary editable without committing');
  await clickBoundary(0, 40);
  await draftReadout('current edge length', fmtM(40));
  p = point(0, 40);
  const moveX = point(10, 40).x - p.x;
  await page.mouse.move(p.x + 45, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 45 + moveX, p.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('#dock-right .lil-controller')].find(
      el => el.querySelector('.lil-name')?.textContent === 'surface area',
    );
    const area = Number.parseFloat(row?.querySelector('input')?.value ?? '');
    return area > 2100 && area < 2350;
  });
  const draftArea = Number.parseFloat(await field('surface area').inputValue());
  assert(
    Number.parseFloat(await field('current edge length').inputValue()) > 40,
    'segment length follows the moved boundary',
  );
  assert.deepEqual(await read(), emptyDrawing, 'boundary point drags only update the transient draft');
  await page.screenshot({ path: join(root, 'surface-draft-edit.png') });
  await page.keyboard.press('Enter');
  await button('select all control curves').waitFor();
  const drawn = await read();
  assert.equal(drawn.surfaces?.length, 1);
  assert.equal(drawn.surfaces![0].origin, 'boundary');
  assert.equal(drawn.surfaces![0].guides!.length, 4);
  assert.equal(drawn.surfaces![0].patchSizeM, 15);
  assert(drawn.surfaces![0].patches.length > 1);
  assert(
    Math.abs(measureSurfaceObject(drawn, drawn.surfaces![0]).area - draftArea) < 0.6,
    'committed surface matches the moved draft and its area',
  );
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  assert.deepEqual(
    (await read()).vertices,
    emptyDrawing.vertices,
    'one undo removes the surface and its entire boundary sketch',
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces?.length === 1);
  await page.waitForTimeout(1200);
  await page.reload();
  await loaded();
  const storedDrawing = await read();
  assert.deepEqual(storedDrawing.surfaces, drawn.surfaces, 'the drawn surface survives redo, save and reload');
  await page.keyboard.press('Escape');
  await button('▱ create surface').click();
  for (const [x, z] of [
    [10, 5],
    [40, 5],
    [40, 30],
    [10, 30],
  ])
    await clickBoundary(x, z);
  await clickBoundary(10, 5);
  await draftReadout('preview', 'edit boundary points · Enter to create');
  await page.keyboard.press('Escape');
  await button('▱ create surface').waitFor();
  assert.deepEqual(await read(), storedDrawing, 'cancelling discards every draft point');
  await button('▱ create surface').click();
  for (const [x, z] of [
    [10, 5],
    [40, 5],
    [40, 30],
  ])
    await clickBoundary(x, z);
  await page.keyboard.press('Enter');
  await button('cancel surface (Esc)').waitFor();
  assert.deepEqual(await read(), storedDrawing, 'an unfinished loop cannot partially create a surface');
  await clickBoundary(10, 30);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces?.length === 2);
  const twoDrawn = await read();
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces?.length === 1);
  assert.deepEqual(
    (await read()).surfaces,
    storedDrawing.surfaces,
    'creating another surface does not alter the existing object',
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces?.length === 2);
  assert.deepEqual((await read()).surfaces, twoDrawn.surfaces);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  assert.deepEqual(errors, []);
  console.log(
    'SURFACE BROWSER PASS: profiles, boundary drawing/closure/draft point drags/live length and area/Enter/cancel/undo/save, crossing arches, explicit guide editing and deletion, redundant-section output reuse, shape drags, density, undo, bake, GARI refitting, measurements, snapped reuse and Crease/Smooth button parity. Screenshots: ' +
      root,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error('Surface failure screenshot: ' + join(root, 'failure.png'));
    console.error(await page.locator('#dock-right').innerText());
    console.error(
      await page.locator('#dock-right .lil-controller').evaluateAll(rows =>
        rows.map(row => ({
          name: row.querySelector('.lil-name')?.textContent,
          value: row.querySelector('input')?.value,
        })),
      ),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
