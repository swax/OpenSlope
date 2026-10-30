// tier: integration
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./ai-path-editing.fixture.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const styles = ['base', 'dock', 'toolbar']
    .map(name => readFileSync(new URL(`../src/app/styles/${name}.css`, import.meta.url), 'utf8'))
    .join('\n');
  await page.route('http://ai-editing.test/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>${styles}\nbody{margin:0;background:#101820}.lil-gui.lil-root{width:100%}</style>`,
    }),
  );
  await page.goto('http://ai-editing.test/');
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  await page
    .waitForFunction(() => (window as any).aiEditing, undefined, { timeout: 15000 })
    .catch(() => assert.fail(errors.join('\n')));
  const state = () => page.evaluate(() => (window as any).aiEditing.state());
  assert.equal((await state()).lines.length, 8);
  assert.equal(await page.getByText('Recorded run', { exact: true }).count(), 0, 'No recorded-path list');
  await page.getByRole('checkbox', { name: 'Use auto-generated paths', exact: true }).uncheck();
  assert.equal((await state()).automatic, false);
  assert.equal((await state()).lines.length, 2, 'Disabling generated routes leaves only recordings');
  const point = await page.evaluate(() => (window as any).aiEditing.pixel([-15, 4, 9]));
  await page.mouse.click(point.x, point.y);
  assert.deepEqual((await state()).selected, [0], JSON.stringify({ state: await state(), errors }));
  assert.equal((await state()).nodes, 4);
  assert((await page.getByRole('textbox', { name: 'name', exact: true }).inputValue()) === 'Recorded run');
  assert.equal(await page.getByText('Other run', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Reselect path here', exact: true }).count(), 0);
  const node = await page.evaluate(() => (window as any).aiEditing.nodePixel(1));
  await page.mouse.click(node.x, node.y);
  assert.equal((await state()).gizmo, 'ainode');
  assert.equal(await page.getByText('selected node', { exact: true }).count(), 1);
  const withoutReselect = (await state()).paths;
  const reselect = () => page.getByRole('checkbox', { name: 'Reselect path here', exact: true });
  await reselect().check();
  const placed = await state();
  const event = placed.paths[0].events.find((event: any) => event.type === 300);
  assert(event && Math.abs(event.start - Math.hypot(6, 18)) < 1e-9 && event.end === event.start);
  assert(placed.eventShapes.includes('flag'), 'Reselect event appears as a flag on the path');
  assert(await reselect().isChecked());
  assert.equal(
    await page
      .locator('.lil-title')
      .filter({ hasText: /^3\. Reselect path$/ })
      .count(),
    1,
  );
  await page.evaluate(() => (window as any).aiEditing.undo());
  assert.deepEqual((await state()).paths, withoutReselect, 'Event placement is undoable');
  assert(!(await reselect().isChecked()));
  await page.evaluate(() => (window as any).aiEditing.redo());
  assert.deepEqual((await state()).paths, placed.paths);
  await reselect().uncheck();
  assert.deepEqual((await state()).paths, withoutReselect, 'The node checkbox can remove its event');
  assert(!(await state()).eventShapes.includes('flag'));
  await reselect().check();
  const before = (await state()).paths;
  const handle = await page.evaluate(() => (window as any).aiEditing.handlePixel());
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  assert((await state()).dragging, 'A real pointer drag captures the transform gizmo');
  await page.mouse.move(handle.x + 48, handle.y, { steps: 8 });
  await page.mouse.up();
  const edited = await state();
  assert(!edited.dragging);
  assert(Math.abs(edited.paths[0].points[1][0] - before[0].points[1][0]) > 2, 'X gizmo changes the node');
  assert.deepEqual(
    edited.paths[0].points[1].slice(1),
    before[0].points[1].slice(1),
    'Data-space Y/Z survive the mirrored root',
  );
  assert.notDeepEqual(edited.paths[0].events, before[0].events, 'Event ranges follow their edited segments');
  const movedReselect = edited.paths[0].events.find((event: any) => event.type === 300);
  assert(Math.abs(movedReselect.start - Math.hypot(edited.paths[0].points[1][0] + 18, 18)) < 1e-9);
  assert(await reselect().isChecked(), 'The reselect event stays attached to its moved node');
  assert.deepEqual(edited.paths[1], before[1], 'Another path remains untouched');
  await page.evaluate(() => (window as any).aiEditing.undo());
  assert.deepEqual((await state()).paths, before);
  await page.evaluate(() => (window as any).aiEditing.redo());
  assert.deepEqual((await state()).paths, edited.paths);
  await page.evaluate(() => (window as any).aiEditing.reload());
  assert.deepEqual((await state()).paths, edited.paths);
  assert.equal((await state()).automatic, false);
  assert(await reselect().isChecked(), 'Reselect event survives save/reload');
  mkdirSync(new URL('../../temp', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../../temp/ai-path-editing.png', import.meta.url)) });
  await page.getByRole('button', { name: 'Insert node after', exact: true }).click();
  const afterInsert = (await state()).paths;
  assert.equal(afterInsert[0].points.length, edited.paths[0].points.length + 1);
  assert.deepEqual(
    afterInsert[0].points[2],
    edited.paths[0].points[1].map((v: number, i: number) => (v + edited.paths[0].points[2][i]) / 2),
  );
  assert.deepEqual(afterInsert[0].events, edited.paths[0].events);
  assert(!(await reselect().isChecked()), 'Insertion selects the new unflagged node');
  assert.equal((await state()).nodes, afterInsert[0].points.length);
  assert.equal((await state()).gizmo, 'ainode');
  await page.evaluate(() => (window as any).aiEditing.undo());
  assert.deepEqual((await state()).paths, edited.paths);
  await page.evaluate(() => (window as any).aiEditing.redo());
  assert.deepEqual((await state()).paths, afterInsert);
  await page.evaluate(() => (window as any).aiEditing.reload());
  assert.deepEqual((await state()).paths, afterInsert);
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  assert.deepEqual((await state()).paths, edited.paths, 'Deleting an inserted midpoint restores the original geometry');
  const flaggedNode = await page.evaluate(() => (window as any).aiEditing.nodePixel(1));
  await page.mouse.click(flaggedNode.x, flaggedNode.y);
  assert(await reselect().isChecked());
  await page.getByRole('button', { name: 'Insert node before', exact: true }).click();
  assert.equal((await state()).paths[0].points.length, edited.paths[0].points.length + 1);
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  assert.deepEqual((await state()).paths, edited.paths);
  assert(await reselect().isChecked(), 'The surviving flagged node is selected after deletion');
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  assert.equal((await state()).paths[0].points.length, 3);
  assert(!(await state()).paths[0].events.some((event: any) => event.type === 300), 'Deleting a node removes its flag');
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  assert.equal((await state()).paths[0].points.length, 2);
  assert(!(await page.getByRole('button', { name: 'Delete node', exact: true }).isEnabled()));
  await page.evaluate(() => (window as any).aiEditing.undo());
  await page.evaluate(() => (window as any).aiEditing.undo());
  assert.deepEqual((await state()).paths, edited.paths);
  await page.getByRole('checkbox', { name: 'Use auto-generated paths', exact: true }).check();
  assert.equal((await state()).lines.length, 8);
  await page.getByRole('button', { name: 'delete path', exact: true }).click();
  assert.equal((await state()).paths.length, 1);
  assert.equal((await state()).gizmo, null);
  assert.equal((await state()).nodes, 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: generated-path toggle, path/node selection, insert/delete nodes, reselect flags, real gizmo drag, event remapping, undo/redo, reload and delete',
  );
} finally {
  await browser.close();
}
