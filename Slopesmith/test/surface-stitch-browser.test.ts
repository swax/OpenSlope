import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { createSurfaceFromProfiles } from '../src/core/mesh/surface-object';
import { createSurfaceFromDrawnBoundary } from '../src/core/mesh/surface-boundary';
import { surfaceSideControls } from '../src/core/mesh/surface-stitch-controls';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { quadPerimeterEdges, undirectedEdgeKey } from '../src/core/mesh/primitives';
import { addSurfaceStitch } from '../src/core/mesh/surface-stitch';
import { surfaceCornerBoundary } from '../src/core/mesh/surface-corner-edit';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-stitch-'));
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
type Observation = {
  slopesmith: {
    doc(): QuadMeshDoc;
    errors(): unknown[];
    settled(): Promise<unknown>;
    snapshot(): { selection: { meshEdges: [string, string][]; meshVertices: string[] } };
  };
};
function plain(name: string) {
  const doc = blankMountain(name, 20);
  doc.vertices = [0, 0, 0, 0, 0, 80, 40, 0, 0, 40, 0, 80];
  doc.quads = [[0, 1, 2, 3]];
  Object.assign(doc, appendMeshIds(doc, 4, 1));
  return doc;
}
function addSurface(doc: QuadMeshDoc, x0: number, x1: number, rise = 15) {
  const start = doc.vertices.length / 3;
  const input = {
    ...doc,
    vertices: [...doc.vertices, x0, 0, 0, x0, 0, 80, x1, rise, 0, x1, rise, 80],
    ...appendMeshIds(doc, 4, 0),
    freeEdges: [
      ...(doc.freeEdges ?? []),
      [start, start + 1] as [number, number],
      [start + 2, start + 3] as [number, number],
    ],
  };
  const result = createSurfaceFromProfiles(
    input,
    [
      [start, start + 1],
      [start + 2, start + 3],
    ],
    { patchSizeM: 20 },
  );
  assert(result.ok, result.ok ? '' : result.error);
  return result.doc;
}
async function project(doc: QuadMeshDoc) {
  const response = await fetch(api.url + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc }),
  });
  assert(response.ok);
}
function shared(doc: QuadMeshDoc, a: string, b: string) {
  const key = undirectedEdgeKey(doc.vertexIds.indexOf(a), doc.vertexIds.indexOf(b));
  return doc.quads.filter(q => quadPerimeterEdges(q).some(([a, b]) => undirectedEdgeKey(a, b) === key)).length;
}
try {
  const drawn = (doc: QuadMeshDoc, points: V3[], corners?: number[]) => {
    const result = createSurfaceFromDrawnBoundary(
      doc,
      points.map(pos => ({ pos, vertex: null })),
      20,
      corners,
    );
    assert(result.ok, result.ok ? '' : result.error);
    return result.doc;
  };
  let cornerDoc = drawn(blankMountain('STITCH_CORNERS', 20), [
    [0, 0, 0],
    [0, 0, 30],
    [40, 0, 30],
    [40, 0, 0],
  ]);
  cornerDoc = drawn(
    cornerDoc,
    [
      [40, 0, 0],
      [40, 0, 10],
      [40, 0, 20],
      [40, 0, 30],
      [40, 0, 50],
      [40, 0, 80],
      [120, 0, 80],
      [120, 0, 0],
    ],
    [0, 3, 6, 7],
  );
  cornerDoc = addSurfaceStitch(
    cornerDoc,
    cornerDoc.surfaces![1].id,
    { side: 'v0', range: [0, 1] },
    { surface: cornerDoc.surfaces![0].id, side: 'v1', range: [0, 1] },
  );
  await project(cornerDoc);
  await project(blankMountain('STITCH_CORNERS_DRAW', 20));
  await project(addSurface(plain('STITCH_MESH'), 44, 120));
  await project(addSurface(addSurface(blankMountain('STITCH_SURFACES', 20), 0, 40), 44, 120));
  await project(plain('STITCH_DRAW'));
  const mixed = addSurface(plain('STITCH_MIXED_DRAW'), 40, 80, 0);
  await project(
    addSurfaceStitch(
      mixed,
      mixed.surfaces![0].id,
      { side: 'v0', range: [0, 1] },
      { vertices: mixed.vertexIds.slice(2, 4) },
    ),
  );
  await project(
    migrateMountain(
      JSON.parse(readFileSync(new URL('./fixtures/surface-stitch-mixed-gari.json', import.meta.url), 'utf8')),
    ),
  );
  const square = createSurfaceFromDrawnBoundary(
    blankMountain('STITCH_SURFACE_DRAW', 20),
    [
      [0, 0, 0],
      [0, 0, 80],
      [40, 0, 80],
      [40, 0, 0],
    ].map(pos => ({ pos: pos as V3, vertex: null })),
    20,
  );
  assert(square.ok);
  await project(square.doc);
  await project(
    migrateMountain(JSON.parse(readFileSync(new URL('./fixtures/surface-stitch-gari.json', import.meta.url), 'utf8'))),
  );
  await vite.listen();
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const gari = location.pathname.endsWith('/STITCH_GARI');
    const mixedGari = location.pathname.endsWith('/STITCH_MIXED_GARI');
    const view = JSON.stringify(
      mixedGari
        ? { pos: [-480, 600, 600], target: [-480, 200, 600], up: [0, 0, -1], ortho: true, zoom: 1, orthoHalfH: 90 }
        : gari
          ? {
              pos: [-640, 700, 675],
              target: [-640, 0, 675],
              up: [0, 0, -1],
              ortho: true,
              zoom: 1,
              orthoHalfH: 300,
            }
          : {
              pos: [60, 220, -40],
              target: [60, 0, -40],
              up: [0, 0, -1],
              ortho: true,
              zoom: 1,
              orthoHalfH: 100,
            },
    );
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
  const checkpoint = async (name: string) =>
    writeFileSync(join(root, name + '.json'), JSON.stringify(await read(), null, 2));
  const settle = () => page!.evaluate(() => (window as unknown as Observation).slopesmith.settled());
  const panel = page.locator('#dock-right > .lil-gui:visible'),
    button = (name: string) => panel.getByRole('button', { name, exact: true });
  const select = (name: string) =>
    panel
      .locator('.lil-controller')
      .filter({ has: page!.locator('.lil-name', { hasText: new RegExp(`^${name}$`) }) })
      .locator('select');
  const field = (name: string) =>
    panel
      .locator('.lil-controller')
      .filter({ has: page!.locator('.lil-name', { hasText: name }) })
      .locator('input')
      .last();
  const click = async (x: number, z: number) => {
    const box = await page!.locator('canvas').first().boundingBox();
    assert(box);
    await page!.mouse.click(
      box.x + box.width / 2 + ((x - 60) * box.height) / 200,
      box.y + box.height / 2 + ((40 - z) * box.height) / 200,
    );
  };
  const open = async (name: string) => {
    await page!.goto(vite.resolvedUrls!.local[0] + `editor/${name}?agent=1`);
    await loaded();
    await page!.getByRole('button', { name: 'Edit', exact: true }).first().click();
  };
  await open('STITCH_CORNERS');
  await settle();
  const cornerBefore = await read();
  await button('Surface 2').click();
  await button('edit corners…').click();
  await button('infer corners again').click();
  await settle();
  assert.deepEqual(await read(), cornerBefore, 'corner preview never mutates the authored/saved document');
  await page.screenshot({ path: join(root, 'corners-preview.png') });
  await button('cancel corners (Esc)').click();
  await settle();
  assert.deepEqual(await read(), cornerBefore, 'cancel leaves no edit');
  await button('edit corners…').click();
  await button('pick corners').click();
  await click(40, 0);
  await click(120, 80);
  assert(await button('apply corners (Enter)').isDisabled(), 'partial picks cannot apply a new corner layout');
  await page.keyboard.press('Enter');
  await settle();
  assert.deepEqual(await read(), cornerBefore, 'Enter while picking cannot commit the surface');
  await page.keyboard.press('Escape');
  await button('pick corners').waitFor();
  assert.deepEqual(await read(), cornerBefore, 'Escape cancels picks without cancelling the corner preview');
  await button('pick corners').click();
  for (const [x, z] of [
    [40, 0],
    [120, 0],
    [40, 80],
    [120, 80],
  ])
    await click(x, z);
  await button('pick corners').waitFor();
  await button('apply corners (Enter)').click();
  await settle();
  let cornerAfter = await read();
  assert.deepEqual(surfaceCornerBoundary(cornerAfter, cornerAfter.surfaces![1]).corners, [0, 5, 6, 7]);
  assert.equal(cornerAfter.surfaces![1].stitches?.length, 1);
  assert(!cornerAfter.surfaces!.some(s => s.error));
  assert(
    cornerAfter.surfaces![0].patches.some(
      p => p.corners.filter(id => cornerAfter.surfaces![1].patches.some(q => q.corners.includes(id))).length >= 2,
    ),
  );
  await page.keyboard.press('Control+z');
  await settle();
  assert.deepEqual(surfaceCornerBoundary(await read(), (await read()).surfaces![1]).corners, [0, 3, 6, 7]);
  await page.keyboard.press('Control+Shift+z');
  await settle();
  await page.reload();
  await loaded();
  await settle();
  cornerAfter = await read();
  assert.deepEqual(surfaceCornerBoundary(cornerAfter, cornerAfter.surfaces![1]).corners, [0, 5, 6, 7]);
  assert.equal(cornerAfter.surfaces![1].stitches?.length, 1, 'the remapped stitch survives undo/redo and reload');
  await open('STITCH_CORNERS_DRAW');
  await button('▱ create surface').click();
  for (const [x, z] of [
    [0, 0],
    [0, 10],
    [0, 20],
    [0, 30],
    [0, 50],
    [0, 80],
    [120, 80],
    [120, 0],
  ])
    await click(x, z);
  await click(0, 0);
  assert.equal(await select('boundary curves').inputValue(), 'Smooth', 'creation starts with smooth boundary curves');
  await select('boundary curves').selectOption({ label: 'Creased' });
  await button('pick corners').click();
  await click(0, 0);
  await click(0, 30);
  await page.keyboard.press('Backspace');
  await click(0, 30);
  await click(120, 80);
  await click(120, 0);
  await button('pick corners').waitFor();
  await button('infer corners again').click();
  await button('pick corners').click();
  for (const [x, z] of [
    [0, 0],
    [120, 0],
    [0, 30],
    [120, 80],
  ])
    await click(x, z);
  await button('pick corners').waitFor();
  await button('create surface (Enter)').click();
  await settle();
  const manual = await read();
  assert.deepEqual(
    surfaceCornerBoundary(manual, manual.surfaces![0]).corners,
    [0, 3, 6, 7],
    'manual creation overrides automatic corners',
  );
  await page.keyboard.press('Control+z');
  await settle();
  assert.equal((await read()).surfaces?.length ?? 0, 0, 'manual creation is one undoable edit');
  // Smooth is applied to source cubics, with preview, undo and persistence using the same controls.
  await button('▱ create surface').click();
  for (const [x, z] of [
    [0, 0],
    [50, -15],
    [120, 0],
    [120, 80],
    [0, 80],
  ])
    await click(x, z);
  await click(0, 0);
  await select('boundary curves').selectOption({ label: 'Smooth' });
  await button('pick corners').click();
  for (const [x, z] of [
    [0, 0],
    [0, 80],
    [120, 0],
    [120, 80],
  ])
    await click(x, z);
  await button('pick corners').waitFor();
  await page.screenshot({ path: join(root, 'smooth-boundary-preview.png') });
  await button('create surface (Enter)').click();
  await settle();
  const smoothDoc = await read(),
    smoothSurface = smoothDoc.surfaces![0];
  const middle = smoothSurface.controls.flat().find(id => {
    const at = smoothDoc.vertexIds.indexOf(id) * 3;
    return Math.hypot(smoothDoc.vertices[at] - 50, smoothDoc.vertices[at + 2] + 15) < 1e-6;
  })!;
  assert(middle, 'the intermediate curved boundary point remains editable');
  const path = smoothSurface.controls.find(row => row.includes(middle))!,
    at = path.indexOf(middle),
    from = smoothDoc.vertexIds.indexOf(middle);
  const handles = [path[at - 1], path[at + 1]].map(
    id => smoothDoc.edgeHandles![`${from}>${smoothDoc.vertexIds.indexOf(id)}`],
  );
  assert(
    Math.hypot(...handles[0].map((n, i) => n + handles[1][i])) < 1e-6,
    'Smooth creates continuous source tangents',
  );
  await page.reload();
  await loaded();
  await settle();
  assert.deepEqual(
    (await read()).surfaces,
    smoothDoc.surfaces,
    'the picked corners and smoothed source survive reload',
  );
  await open('STITCH_MESH');
  const original = await read();
  await click(44, 40);
  await button('stitch selected edges…').click();
  await button('apply stitch').waitFor();
  assert(await button('apply stitch').isDisabled());
  await page.keyboard.press('Escape');
  assert.deepEqual((await read()).surfaces, original.surfaces, 'cancel creates no document edit');
  await click(44, 40);
  await button('stitch selected edges…').click();
  await click(40, 40);
  await select('join').selectOption({ label: 'Crease' });
  await button('apply stitch').click();
  await button('detach all stitching').waitFor();
  let current = await read();
  assert.equal(current.surfaces![0].stitches?.[0].continuity, 'crease');
  assert.equal(shared(current, original.vertexIds[2], original.vertexIds[3]), 2);
  await checkpoint('joined');
  await select('join').selectOption({ label: 'Smooth' });
  await checkpoint('smoothed');
  await field('patch size (m)').fill('25');
  await field('patch size (m)').press('Enter');
  await settle();
  await checkpoint('resized');
  current = await read();
  assert.equal(current.surfaces![0].patchSizeM, 25);
  assert.equal(shared(current, original.vertexIds[2], original.vertexIds[3]), 2);
  await page.screenshot({ path: join(root, 'mesh-stitch.png') });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces![0].patchSizeM === 20);
  await settle();
  await checkpoint('undo-size');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].stitches?.[0].continuity === 'crease',
  );
  await settle();
  await checkpoint('undo-smooth');
  await page.keyboard.press('Control+z');
  await settle();
  await checkpoint('undo-stitch');
  await page.waitForFunction(
    () => !(window as unknown as Observation).slopesmith.doc().surfaces![0].stitches?.length,
    undefined,
    { timeout: 5000 },
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].stitches?.[0].continuity === 'crease',
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![0].stitches?.[0].continuity === 'smooth',
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.doc().surfaces![0].patchSizeM === 25);
  await settle();
  await page.reload();
  await loaded();
  current = await read();
  assert.equal(current.surfaces![0].stitches?.[0].continuity, 'smooth');
  assert.equal(shared(current, original.vertexIds[2], original.vertexIds[3]), 2);
  await page.keyboard.press('Escape');
  await click(40, 0);
  await button('World').click();
  const box = await page.locator('canvas').first().boundingBox();
  assert(box);
  const pivot = {
    x: box.x + box.width / 2 - (20 * box.height) / 200,
    y: box.y + box.height / 2 + (40 * box.height) / 200,
  };
  await page.mouse.move(pivot.x + 45, pivot.y);
  await page.mouse.down();
  await page.mouse.move(pivot.x + 75, pivot.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction((id: string) => {
    const d = (window as unknown as Observation).slopesmith.doc();
    return Math.abs(d.vertices[d.vertexIds.indexOf(id) * 3] - 40) > 0.1;
  }, original.vertexIds[2]);
  await settle();
  current = await read();
  assert(!current.surfaces![0].error, current.surfaces![0].error);
  assert.equal(shared(current, original.vertexIds[2], original.vertexIds[3]), 2);
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+z');
  await page.waitForFunction((id: string) => {
    const d = (window as unknown as Observation).slopesmith.doc();
    return Math.abs(d.vertices[d.vertexIds.indexOf(id) * 3] - 40) < 1e-6;
  }, original.vertexIds[2]);
  await page.keyboard.press('Escape');
  await button('Surface 1').click();
  await button('detach all stitching').click();
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces![0].stitches?.length);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !!(window as unknown as Observation).slopesmith.doc().surfaces![0].stitches?.length);
  await button('Surface 1').click();
  await button('bake surface').click();
  await page.waitForFunction(() => !(window as unknown as Observation).slopesmith.doc().surfaces?.length);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => !!(window as unknown as Observation).slopesmith.doc().surfaces?.[0].stitches?.length,
  );
  await open('STITCH_SURFACES');
  await click(44, 40);
  await button('stitch selected edges…').click();
  await click(40, 40);
  await button('apply stitch').click();
  current = await read();
  assert.equal(current.surfaces![1].stitches?.length, 1);
  assert(current.surfaces![1].patches.some(p => p.corners.some(id => current.surfaces![0].vertices.includes(id))));
  await page.keyboard.press('Escape');
  await button('Surface 1').click();
  await button('detach all stitching').click();
  await page.waitForFunction(() =>
    (window as unknown as Observation).slopesmith.doc().surfaces!.every(s => !s.stitches?.length),
  );
  await open('STITCH_DRAW');
  await button('▱ create surface').click();
  for (const [x, z] of [
    [40, 0],
    [40, 80],
    [120, 80],
    [120, 0],
  ])
    await click(x, z);
  await page.keyboard.press('Enter');
  await button('detach all stitching').waitFor();
  current = await read();
  assert.equal(current.surfaces![0].stitches?.length, 1);
  assert.equal(shared(current, current.vertexIds[2], current.vertexIds[3]), 2);
  await page.screenshot({ path: join(root, 'automatic-stitch.png') });
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  await open('STITCH_SURFACE_DRAW');
  await button('▱ create surface').click();
  for (const [x, z] of [
    [40, 0],
    [40, 80],
    [120, 80],
    [120, 0],
  ])
    await click(x, z);
  await page.keyboard.press('Enter');
  await button('detach all stitching').waitFor();
  await settle();
  current = await read();
  const attachment = current.surfaces![1].stitches![0];
  assert(attachment && 'surface' in attachment.target, 'drawing on a Surface boundary automatically stitches');
  const sourceIds = surfaceSideControls(current, current.surfaces![1], attachment.side).map(
      p => current.vertexIds[p.vertex],
    ),
    targetIds = surfaceSideControls(current, current.surfaces![0], attachment.target.side).map(
      p => current.vertexIds[p.vertex],
    ),
    positions = (doc: QuadMeshDoc, ids: string[]) =>
      ids.map(id => doc.vertices.slice(doc.vertexIds.indexOf(id) * 3, doc.vertexIds.indexOf(id) * 3 + 3));
  const checkSourceSeam = (doc: QuadMeshDoc) => {
    assert(!doc.surfaces!.some(s => s.error), doc.surfaces!.map(s => s.error).join());
    const a = positions(doc, sourceIds),
      b = positions(doc, targetIds);
    for (const p of a)
      assert(
        b.some(q => Math.hypot(...p.map((v, i) => v - q[i])) < 1e-6),
        'both source cages stay on the seam',
      );
    assert(
      doc.surfaces![0].patches.some(
        p => p.corners.filter(id => doc.surfaces![1].patches.some(q => q.corners.includes(id))).length >= 2,
      ),
      'the generated seam stays shared',
    );
  };
  checkSourceSeam(current);
  const beforeDrag = positions(current, targetIds);
  // The guides coincide, so choose the follower's curve explicitly in its inspector.
  const follower = current.surfaces![1],
    axis = attachment.side[0] === 'u' ? 'V' : 'U',
    rows = follower.guides!.filter(g => g.axis === axis).sort((a, b) => a.at - b.at),
    row = rows.findIndex(g => Math.abs(g.at - Number(attachment.side[1])) < 1e-7);
  await select('direction').selectOption(axis);
  await field('curve').fill(String(row + 1));
  await field('curve').press('Enter');
  await button('select curve').click();
  const selected = await page.evaluate(
    () => (window as unknown as Observation).slopesmith.snapshot().selection.meshVertices,
  );
  assert(
    selected.length === sourceIds.length && selected.every(id => sourceIds.includes(id)),
    'the follower authoring edge is selected',
  );
  await button('World').click();
  const surfaceBox = await page.locator('canvas').first().boundingBox();
  assert(surfaceBox);
  const seamPivot = {
    x: surfaceBox.x + surfaceBox.width / 2 - (20 * surfaceBox.height) / 200,
    y: surfaceBox.y + surfaceBox.height / 2,
  };
  await page.mouse.move(seamPivot.x + 45, seamPivot.y);
  await page.mouse.down();
  await page.mouse.move(seamPivot.x + 75, seamPivot.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction((ids: string[]) => {
    const d = (window as unknown as Observation).slopesmith.doc();
    return ids.every(id => Math.abs(d.vertices[d.vertexIds.indexOf(id) * 3] - 40) > 0.1);
  }, targetIds);
  await settle();
  current = await read();
  checkSourceSeam(current);
  const afterDrag = positions(current, targetIds);
  assert(afterDrag.every((p, i) => p[0] > beforeDrag[i][0] + 0.1));
  await page.screenshot({ path: join(root, 'shared-source-drag.png') });
  await page.keyboard.press('Control+z');
  await page.waitForFunction((ids: string[]) => {
    const d = (window as unknown as Observation).slopesmith.doc();
    return ids.every(id => Math.abs(d.vertices[d.vertexIds.indexOf(id) * 3] - 40) < 1e-6);
  }, targetIds);
  await settle();
  checkSourceSeam(await read());
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction((ids: string[]) => {
    const d = (window as unknown as Observation).slopesmith.doc();
    return ids.every(id => Math.abs(d.vertices[d.vertexIds.indexOf(id) * 3] - 40) > 0.1);
  }, targetIds);
  await settle();
  await page.reload();
  await loaded();
  await settle();
  current = await read();
  checkSourceSeam(current);
  assert.deepEqual(positions(current, targetIds), afterDrag, 'both source cages survive undo/redo and saving');
  await open('STITCH_MIXED_DRAW');
  await button('▱ create surface').click();
  for (const [x, z] of [
    [0, 80],
    [40, 80],
    [80, 80],
    [80, 130],
    [0, 130],
  ])
    await click(x, z);
  await page.keyboard.press('Enter');
  await button('detach all stitching').waitFor();
  await settle();
  current = await read();
  assert.equal(current.surfaces![1].stitches?.length, 2, 'the drawn boundary auto-stitches to both kinds of terrain');
  assert(current.surfaces![1].stitches!.some(st => 'surface' in st.target));
  assert(current.surfaces![1].stitches!.some(st => 'vertices' in st.target));
  assert(!current.surfaces!.some(s => s.error));
  await page.screenshot({ path: join(root, 'mixed-drawn-stitch.png') });
  await open('STITCH_MIXED_GARI');
  await button('Surface 2').click();
  await settle();
  const mixedBefore = await read(),
    plainAttachment = mixedBefore.surfaces![1].stitches![0];
  assert.equal(mixedBefore.surfaces![1].stitches?.length, 1);
  await page.screenshot({ path: join(root, 'mixed-gari-before.png') });
  await button('stitch touching boundaries').click();
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![1].stitches?.length === 2,
  );
  await settle();
  current = await read();
  const checkMixed = (doc: QuadMeshDoc) => {
    assert.equal(doc.surfaces![1].stitches?.length, 2);
    assert.deepEqual(doc.surfaces![1].stitches![0], plainAttachment);
    assert(!doc.surfaces!.some(s => s.error));
    assert(
      doc.surfaces![0].patches.some(
        p => p.corners.filter(id => doc.surfaces![1].patches.some(q => q.corners.includes(id))).length >= 2,
      ),
    );
  };
  checkMixed(current);
  await page.screenshot({ path: join(root, 'mixed-gari-repaired.png') });
  // A shared corner can ask the stitch fitter for an impossible transition. Reject the edit itself,
  // including the source/host movement, rather than leaving the last terrain underneath a moved cage.
  const accepted = current,
    cornerId = 'local:137637',
    hostSurface = accepted.surfaces![0],
    cornerCurve = hostSurface.controls.findIndex(path => path.includes(cornerId)),
    cornerAxis = hostSurface.guides![cornerCurve].axis,
    cornerRows = hostSurface
      .guides!.map((g, i) => ({ ...g, i }))
      .filter(g => g.axis === cornerAxis)
      .sort((a, b) => a.at - b.at),
    cornerRow = cornerRows.findIndex(g => g.i === cornerCurve);
  await page.keyboard.press('Escape');
  await button('Surface 1').click();
  await select('direction').selectOption(cornerAxis);
  await field('curve').fill(String(cornerRow + 1));
  await field('curve').press('Enter');
  await field('control point').fill(String(hostSurface.controls[cornerCurve].indexOf(cornerId) + 1));
  await field('control point').press('Enter');
  await button('select control point').click();
  await button('World').click();
  const rejectBox = await page.locator('canvas').first().boundingBox();
  assert(rejectBox);
  const cornerAt = accepted.vertexIds.indexOf(cornerId) * 3,
    rejectPivot = {
      x: rejectBox.x + rejectBox.width / 2 + ((accepted.vertices[cornerAt] + 480) * rejectBox.height) / 180,
      y: rejectBox.y + rejectBox.height / 2 + ((-600 - accepted.vertices[cornerAt + 2]) * rejectBox.height) / 180,
    };
  await page.mouse.move(rejectPivot.x + 45, rejectPivot.y);
  await page.mouse.down();
  await page.mouse.move(rejectPivot.x + 45 - (30 * rejectBox.height) / 180, rejectPivot.y);
  await page.mouse.up();
  await settle();
  assert.match(await page.locator('#log-text').innerText(), /Surface edit cancelled/);
  current = await read();
  assert.deepEqual(current.vertices, accepted.vertices, 'failed drag restores both cages and generated terrain');
  assert.deepEqual(current.surfaces, accepted.surfaces);
  assert.deepEqual(current.edgeHandles, accepted.edgeHandles);
  assert.deepEqual(current.quads, accepted.quads);
  // A rejected drag adds no undo step: the next undo still removes the preceding successful repair.
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![1].stitches?.length === 1,
  );
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    () => (window as unknown as Observation).slopesmith.doc().surfaces![1].stitches?.length === 2,
  );
  await settle();
  await page.reload();
  await loaded();
  await settle();
  checkMixed(await read());
  assert.deepEqual((await read()).vertices, accepted.vertices, 'saving cannot retain rejected source positions');
  await button('Surface 2').click();
  await button('detach all stitching').click();
  await settle();
  await page.reload();
  await loaded();
  await settle();
  assert(!(await read()).surfaces![1].stitches?.length, 'reload does not rediscover explicitly detached contacts');
  await open('STITCH_GARI');
  await settle();
  current = await read();
  assert(!current.surfaces!.some(s => s.error), current.surfaces!.map(s => s.error).join());
  assert.equal(
    Math.abs(current.surfaces![1].patches.length - current.surfaces![1].fitted!.length),
    1,
    'the saved circular transition repairs when opened',
  );
  assert(!current.surfaces![1].outputKeys!.some(k => k.includes('/inner:')));
  await button('Surface 2').click();
  await page.screenshot({ path: join(root, 'gari-stitch.png') });
  await checkpoint('gari-repaired');
  await page.reload();
  await loaded();
  await settle();
  current = await read();
  assert.equal(Math.abs(current.surfaces![1].patches.length - current.surfaces![1].fitted!.length), 1);
  assert(
    !current.surfaces![1].outputKeys!.some(k => k.includes('/inner:')),
    'the repaired strip survives saving and reloading',
  );
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  assert.deepEqual(errors, []);
  console.log(
    'SURFACE STITCH BROWSER PASS: smooth/creased boundary creation, four-click corner picking/cancel/undo, existing corner preview/cancel/apply, corner undo/redo/reload with stitches, manual mesh/surface joins, cancel, smooth/crease, density refit, undo/redo, save/reload, detach from either side, bake undo, automatic mesh/Surface/mixed creation, coupled source-edge drag, invalid shared-corner drag rollback, saved mixed GARI repair and circular-transition repair. Screenshots: ' +
      root,
  );
} catch (error) {
  if (page) {
    writeFileSync(
      join(root, 'failure.json'),
      JSON.stringify(await page.evaluate(() => (window as unknown as Observation).slopesmith.doc()), null, 2),
    );
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error('Stitch screenshot: ' + join(root, 'failure.png'));
    console.error(await page.locator('#dock-right').innerText());
    await page.getByLabel('Undo and redo history', { exact: true }).click();
    console.error(await page.locator('.sp-menu:visible').allTextContents());
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
