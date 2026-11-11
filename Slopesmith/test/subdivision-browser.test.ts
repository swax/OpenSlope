// browser: smoke
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { createSubdivisionCage } from '../src/core/mesh/subdivision-object';
import { averageSurfacePatchSize } from '../src/core/mesh/surface-measure';
import type { QuadMeshDoc } from '../src/core/doc/types';
import type { Viewport } from '../src/app/viewport/viewport';
import { Color, type BufferGeometry, type Object3D } from 'three';
import { SUBDIVISION_SHARP_EDGE_COLOR, SUBDIVISION_SHARP_CORNER_COLOR } from '../src/app/viewport/constants';

mkdirSync(join(process.cwd(), 'temp'), { recursive: true });
const root = mkdtempSync(join(process.cwd(), 'temp', 'subdivision-browser-'));
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
type Visuals = {
  sharpCorners: number;
  cornerOverlays: number;
  edgeMarkers: number;
  pointColors: number[][];
  edgeColors: number[][];
  cornerPositions: number[][];
};
type Observation = {
  slopesmith: { doc(): QuadMeshDoc; errors(): unknown[]; settled(): Promise<unknown> };
  subdivisionVisuals?(): Visuals;
};
try {
  const doc = blankMountain('SUBDIVISION_BROWSER', 20);
  doc.vertices = [0, 0, 0, 0, 0, 40, 40, 0, 0, 40, 0, 40];
  doc.quads = [[0, 1, 2, 3]];
  Object.assign(doc, appendMeshIds(doc, 4, 1));
  const response = await fetch(api.url + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc }),
  });
  assert(response.ok);
  const rangeSource = blankMountain('SUBDIVISION_RANGE', 20);
  rangeSource.vertices = [];
  rangeSource.quads = [];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 5; z++) rangeSource.vertices.push(x * 40, 0, z * 40);
  for (let x = 0; x < 2; x++)
    for (let z = 0; z < 4; z++) {
      const a = x * 5 + z;
      rangeSource.quads.push([a, a + 1, a + 5, a + 6]);
    }
  Object.assign(rangeSource, appendMeshIds(rangeSource, 15, 8));
  const rangeCage = createSubdivisionCage(
    rangeSource,
    rangeSource.quads.map((_, i) => i),
    1,
  );
  const rangeResponse = await fetch(api.url + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: rangeCage.doc }),
  });
  assert(rangeResponse.ok);
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
      pos: [20, 180, -20],
      target: [20, 0, -20],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: 50,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(prefix + '-view-v1', view);
  });
  const loaded = () =>
    page!.waitForFunction(
      () =>
        !!(window as unknown as Observation).slopesmith &&
        document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
      undefined,
      { timeout: 60000 },
    );
  const read = () => page!.evaluate(() => (window as unknown as Observation).slopesmith.doc());
  const captureViewport = () =>
    page!.evaluate(async (sharpColor: number[]) => {
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
          (window as unknown as Observation).subdivisionVisuals = () => {
            const result: Visuals = {
              sharpCorners: 0,
              cornerOverlays: 0,
              edgeMarkers: 0,
              pointColors: [],
              edgeColors: [],
              cornerPositions: [],
            };
            const seen = new Set<BufferGeometry>();
            viewport.stage.worldRoot.traverse(object => {
              const geometry = (object as Object3D & { geometry?: BufferGeometry }).geometry;
              if (!geometry || seen.has(geometry)) return;
              seen.add(geometry);
              const points = geometry.getAttribute('position');
              if (geometry.name === 'subdivision-sharp-corners') {
                result.cornerOverlays += points.count;
              }
              if (geometry.name === 'subdivision-sharp-edges') result.edgeMarkers = points.count;
              if (geometry.name === 'source-cage-points' || geometry.name === 'source-cage-edges') {
                const colors = geometry.getAttribute('color');
                const unique = new Map<string, number[]>();
                for (let i = 0; i < colors.count; i++) {
                  const color = [colors.getX(i), colors.getY(i), colors.getZ(i)];
                  unique.set(color.join(','), color);
                  if (
                    geometry.name === 'source-cage-points' &&
                    color.every((v, d) => Math.abs(v - sharpColor[d]) < 1e-6)
                  ) {
                    result.sharpCorners++;
                    result.cornerPositions.push([points.getX(i), points.getY(i), points.getZ(i)]);
                  }
                }
                if (geometry.name === 'source-cage-points') result.pointColors = [...unique.values()];
                else result.edgeColors = [...unique.values()];
              }
            });
            return result;
          };
        },
      });
    }, new Color(SUBDIVISION_SHARP_CORNER_COLOR).toArray());
  const waitMarks = (corners: number, edges: number) =>
    page!.waitForFunction(
      ({ corners, edges }) => {
        const state = (window as unknown as Observation).subdivisionVisuals?.();
        return state?.sharpCorners === corners && state.edgeMarkers === edges && state.cornerOverlays === 0;
      },
      { corners, edges },
    );
  const visuals = () => page!.evaluate(() => (window as unknown as Observation).subdivisionVisuals!());
  const hasColor = (colors: number[][], hex: number) => {
    const expected = new Color(hex).toArray();
    return colors.some(c => c.every((v, i) => Math.abs(v - expected[i]) < 1e-6));
  };
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SUBDIVISION_BROWSER?agent=1');
  await loaded();
  await captureViewport();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const panel = page.locator('#dock-right > .lil-gui:visible');
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const field = (name: string) =>
    panel
      .locator('.lil-controller')
      .filter({
        has: page!.locator('.lil-name', { hasText: new RegExp('^' + name + '$') }),
      })
      .locator('input')
      .last();
  await page.keyboard.press('Escape');
  const canvas = await page.locator('canvas').first().boundingBox();
  assert(canvas);
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await button('create subdivision cage').click();
  await button('bake subdivision cage').waitFor();
  let current = await read();
  assert.equal(current.surfaces![0].subdivision!.level, 1);
  assert.equal(current.surfaces![0].patches.length, 4);
  const sizeText = (d: QuadMeshDoc) => {
    const size = averageSurfacePatchSize(d.surfaces![0])!;
    return `${size.length.toFixed(1)} × ${size.width.toFixed(1)} m`;
  };
  const initialSize = sizeText(current);
  const waitSize = (expected: string) =>
    page!.waitForFunction(
      expected =>
        [...document.querySelectorAll<HTMLInputElement>('#dock-right input')].some(input => input.value === expected),
      expected,
    );
  await waitSize(initialSize);
  assert.equal(await field('avg patch size').inputValue(), initialSize);
  assert(await field('avg patch size').evaluate(input => (input as HTMLInputElement).readOnly));
  assert.equal(
    await field('subdivision level').evaluate(
      input => input.closest('.lil-controller')?.nextElementSibling?.querySelector('.lil-name')?.textContent,
    ),
    'avg patch size',
    'Generated size appears directly below the subdivision level',
  );
  assert.equal(await button('stitch selected edges…').count(), 0);
  const sources = current.surfaces![0].controls[0],
    source = sources[0];
  await field('subdivision level').fill('0');
  await field('subdivision level').press('Tab');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].patches.length === 1,
  );
  const zero = await read(),
    zeroSurface = zero.surfaces![0];
  assert.equal(zeroSurface.subdivision!.level, 0);
  await waitSize(sizeText(zero));
  assert.equal(await field('avg patch size').inputValue(), sizeText(zero));
  assert.notEqual(sizeText(zero), initialSize, 'The readout updates when generated patches get coarser');
  assert.deepEqual(zeroSurface.controls[0], sources);
  assert(
    zeroSurface.patches[0].corners.every(id => {
      const at = zero.vertexIds.indexOf(id) * 3;
      return zero.vertices[at] > 0 && zero.vertices[at] < 40 && zero.vertices[at + 2] > 0 && zero.vertices[at + 2] < 40;
    }),
    'Level 0 keeps the smoothed boundary rather than returning the flat cage faces',
  );
  await page.screenshot({ path: join(root, 'subdivision-level-zero.png') });
  await field('subdivision level').fill('1');
  await field('subdivision level').press('Tab');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].patches.length === 4,
  );
  await waitSize(initialSize);
  assert.equal(
    await field('avg patch size').inputValue(),
    initialSize,
    'Returning to level 1 restores its generated size',
  );
  await button('sharp corners (C)').click();
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].subdivision!.corners?.length === 4,
  );
  await waitMarks(4, 0);
  assert(hasColor((await visuals()).pointColors, SUBDIVISION_SHARP_CORNER_COLOR));
  await button('sharp corners (C)').blur();
  await page.keyboard.press('s');
  await waitMarks(0, 0);
  // A boundary edge is already geometrically creased, so this also checks coloring when only its mark changes.
  await page.keyboard.press('Escape');
  await page.mouse.click(canvas.x + canvas.width / 2 - (20 * canvas.height) / 100, canvas.y + canvas.height / 2);
  await button('sharp edges (C)').click();
  await waitMarks(0, 1);
  assert(hasColor((await visuals()).edgeColors, SUBDIVISION_SHARP_EDGE_COLOR));
  await button('smooth edges (S)').click();
  await waitMarks(0, 0);
  assert(!hasColor((await visuals()).edgeColors, SUBDIVISION_SHARP_EDGE_COLOR));
  await button('sharp edges (C)').click();
  await waitMarks(0, 1);
  await page.waitForTimeout(700); // Commit the edge gesture before the separately undoable corner edit.
  await page.keyboard.press('Escape');
  await page.mouse.click(
    canvas.x + canvas.width / 2 - (20 * canvas.height) / 100,
    canvas.y + canvas.height / 2 + (20 * canvas.height) / 100,
  );
  await button('sharp corners (C)').click();
  await waitMarks(1, 1);
  await button('sharp corners (C)').blur();
  await page.keyboard.press('Control+z');
  await waitMarks(0, 1);
  await page.keyboard.press('Control+Shift+z');
  await waitMarks(1, 1);
  await page.screenshot({ path: join(root, 'subdivision-sharpness.png') });
  await button('select all cage points').click();
  await button('select all cage points').blur();
  // The group gizmo sits at the center of the four selected cage points.
  const before = await read(),
    oldX = before.vertices[before.vertexIds.indexOf(source) * 3];
  const pivot = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  await page.keyboard.press('w');
  await page.mouse.move(pivot.x + 45, pivot.y);
  await page.mouse.down();
  await page.mouse.move(pivot.x + 75, pivot.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(
    ({ source, oldX }) => {
      const d = (window as unknown as Observation).slopesmith.doc();
      return d.vertices[d.vertexIds.indexOf(source) * 3] > oldX + 1;
    },
    { source, oldX },
  );
  await page.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  current = await read();
  assert.deepEqual(current.surfaces![0].controls[0], sources);
  assert.deepEqual(current.quadIds, before.quadIds, 'a native gizmo drag retains terrain topology');
  await waitMarks(1, 1);
  const corner = (await visuals()).cornerPositions[0];
  const pointIndex = current.vertexIds.indexOf(source);
  assert(
    corner.every((n, d) => Math.abs(n - current.vertices[pointIndex * 3 + d]) < 1e-5),
    'sharp marker follows the native drag',
  );
  await page.keyboard.press('Delete');
  assert.deepEqual((await read()).surfaces![0].controls[0], sources, 'Delete cannot change cage topology');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.documentElement.dataset.projectSave === 'shared');
  await page.reload();
  await loaded();
  assert.equal((await read()).surfaces![0].subdivision!.level, 1);
  assert.equal((await read()).surfaces![0].subdivision!.corners?.length, 1);
  assert.equal((await read()).surfaces![0].subdivision!.creases.length, 1);
  await captureViewport();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await waitMarks(1, 1);
  // The original cage corner remains pickable after saved-document normalization.
  const loadedDoc = await read(),
    index = loadedDoc.vertexIds.indexOf(source);
  const x = loadedDoc.vertices[index * 3],
    z = loadedDoc.vertices[index * 3 + 2];
  const bounds = await page.locator('canvas').first().boundingBox();
  assert(bounds);
  await page.mouse.click(
    bounds.x + bounds.width / 2 + ((x - 20) * bounds.height) / 100,
    bounds.y + bounds.height / 2 + ((20 - z) * bounds.height) / 100,
  );
  await page.keyboard.press('h');
  await waitMarks(0, 0);
  await page.keyboard.press('Alt+h');
  await waitMarks(1, 1);
  await page.mouse.click(
    bounds.x + bounds.width / 2 + ((x - 20) * bounds.height) / 100,
    bounds.y + bounds.height / 2 + ((20 - z) * bounds.height) / 100,
  );
  await button('bake subdivision cage').click();
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  await waitMarks(0, 0);
  const baked = await read();
  assert.equal(baked.quads.length, 4);
  assert(!baked.freeEdges?.length);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !!(window as unknown as Observation).slopesmith.doc().surfaces?.[0].subdivision);
  await waitMarks(1, 1);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  await waitMarks(0, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  await page.screenshot({ path: join(root, 'subdivision-baked.png') });
  // A four-edge run on the source cage: native Shift-click selects every intermediate edge in either direction.
  await page.addInitScript(() => {
    const view = JSON.stringify({
      pos: [40, 200, -80],
      target: [40, 0, -80],
      up: [0, 0, -1],
      ortho: true,
      zoom: 1,
      orthoHalfH: 110,
    });
    for (const prefix of ['slopesmith', 'slopesmith-local']) localStorage.setItem(prefix + '-view-v1', view);
  });
  await page.goto(vite.resolvedUrls!.local[0] + 'editor/SUBDIVISION_RANGE?agent=1');
  await loaded();
  await captureViewport();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.keyboard.press('Escape');
  const rangeBounds = await page.locator('canvas').first().boundingBox();
  assert(rangeBounds);
  const rangePoint = (z: number) => ({
    x: rangeBounds.x + rangeBounds.width / 2,
    y: rangeBounds.y + rangeBounds.height / 2 + ((80 - z) * rangeBounds.height) / 220,
  });
  const track = rangeCage.surface.controls[0]
    .filter(id => rangeCage.doc.vertices[rangeCage.doc.vertexIds.indexOf(id) * 3] === 40)
    .sort(
      (a, b) =>
        rangeCage.doc.vertices[rangeCage.doc.vertexIds.indexOf(a) * 3 + 2] -
        rangeCage.doc.vertices[rangeCage.doc.vertexIds.indexOf(b) * 3 + 2],
    );
  const expectedEdges = track
    .slice(1)
    .map((b, i) => [track[i], b].sort().join('>'))
    .sort();
  for (const [from, to] of [
    [20, 140],
    [140, 20],
  ]) {
    await page.keyboard.press('Escape');
    const first = rangePoint(from),
      last = rangePoint(to);
    await page.mouse.click(first.x, first.y);
    await button('sharp edges (C)').waitFor();
    await page.keyboard.down('Shift');
    await page.mouse.click(last.x, last.y);
    await page.keyboard.up('Shift');
    assert.equal(
      (await read()).surfaces![0].subdivision!.creases.length,
      0,
      'Range picking does not mark or edit the cage',
    );
    await button('sharp edges (C)').click();
    await waitMarks(0, 4);
    assert.deepEqual(
      (await read()).surfaces![0].subdivision!.creases.map(e => [...e].sort().join('>')).sort(),
      expectedEdges,
    );
    await page.screenshot({ path: join(root, `subdivision-range-${from}.png`) });
    await button('smooth edges (S)').click();
    await waitMarks(0, 0);
  }
  await button('revert cage to patches').click();
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  const reverted = await read();
  assert.equal(reverted.quads.length, 8, 'Revert keeps the eight coarse cage faces instead of the 32 smoothed patches');
  assert.equal(reverted.vertexIds.length, 15);
  assert(!reverted.freeEdges?.length);
  assert(!reverted.quadLocked || !Object.values(reverted.quadLocked).some(Boolean));
  await button('create subdivision cage').waitFor();
  assert(
    await button('create subdivision cage').isEnabled(),
    'The converted faces are selected and ready to subdivide again',
  );
  await page.screenshot({ path: join(root, 'subdivision-reverted.png') });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !!(window as unknown as Observation).slopesmith.doc().surfaces?.[0].subdivision);
  assert.equal((await read()).quads.length, 32);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  assert.equal((await read()).quads.length, 8);
  await page.keyboard.press('Escape');
  const appendEdge = {
    x: rangeBounds.x + rangeBounds.width / 2 - (40 * rangeBounds.height) / 220,
    y: rangePoint(20).y,
  };
  await page.mouse.click(appendEdge.x, appendEdge.y);
  await page.keyboard.press('x');
  await button('cancel extrusion (Esc)').waitFor();
  await page.mouse.move(appendEdge.x + 35, appendEdge.y);
  await page.mouse.down();
  await page.mouse.move(appendEdge.x - 70, appendEdge.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().quads.length > 8);
  const extended = await read();
  assert(!extended.surfaces?.length);
  assert.deepEqual(
    extended.vertices.slice(0, reverted.vertices.length),
    reverted.vertices,
    'Appending leaves the reverted coarse corners in place',
  );
  await page.screenshot({ path: join(root, 'subdivision-appended.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  console.log(
    '✓ browser cage creation, sharpness, native drag, save/reload, bake/revert, undo/redo, Shift-click ranges and appending reverted patches; screenshot: ' +
      root,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(await page.locator('#dock-right').innerText());
    console.error(
      await page.evaluate(() => ({
        errors: (window as unknown as Observation).slopesmith?.errors(),
        visuals: (window as unknown as Observation).subdivisionVisuals?.(),
        cages: (window as unknown as Observation).slopesmith
          ?.doc()
          .surfaces?.map(s => ({ id: s.id, subdivision: s.subdivision, error: s.error })),
      })),
    );
  }
  console.error('Subdivision browser artifacts: ' + root);
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
