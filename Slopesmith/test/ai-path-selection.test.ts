// tier: integration
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { aiPathColor, aiPathEventStyle } from '../src/app/ai-path-style';
import { CAGE_OCCLUDED_DIM } from '../src/app/viewport/constants';
import { GreaterDepth } from 'three';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./ai-path-selection.fixture.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Fulfill the page in memory: browser storage needs an origin, while the fixture needs no network service.
  const styles = ['base', 'dock', 'toolbar']
    .map(name => readFileSync(new URL(`../src/app/styles/${name}.css`, import.meta.url), 'utf8'))
    .join('\n');
  await page.route('http://ai-path.test/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>${styles}\nbody{margin:0;background:#101820}.lil-gui.lil-root{width:100%}</style>`,
    }),
  );
  await page.goto('http://ai-path.test/');
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  await page
    .waitForFunction(() => (window as any).aiPathSelection, undefined, { timeout: 10_000 })
    .catch(() => assert.fail(errors.join('\n') || 'AI path fixture did not load'));
  const press = (index: number, offset = 0) =>
    page.evaluate(([i, px]) => (window as any).aiPathSelection.press(i, px), [index, offset]);
  let state = await press(1, 3);
  assert.deepEqual(errors, [], 'Pointer selection must complete without browser errors');
  assert.equal(state.highlighted, 1, 'A near-line click selects the stable source row through the real pointer router');
  const expectedPixel = [16, 8, 0].map(shift => (state.expectedColor >> shift) & 255);
  assert(
    state.selectedPixel.slice(0, 3).every((channel: number, i: number) => Math.abs(channel - expectedPixel[i]) < 12),
    'Selection retains its rating colour on snow through the mirrored reference frame',
  );
  assert.equal(state.category, 'aiPaths');
  assert.equal(state.referenceSelections, 0, 'An AI path wins over its underlying reference terrain');
  const values = Object.fromEntries(state.details.map((row: any) => [row.label, row.value]));
  assert.equal(values['line rating'], '80 / 100');
  assert.equal(values.respawnable, 'No');
  assert.equal(values['start-grid slots'], '1, 3');
  assert.equal(values.length, '20.00 m');
  assert.equal(values.segments, '2');
  assert.equal(values['avg segment length'], '10.00 m');
  assert(
    !('vertices' in values) && !('bounds min (m)' in values) && !('3D length' in values),
    'Geometry keeps only the requested summary',
  );
  assert.equal(values['target speed'], '95 km/h');
  assert.equal(values['cruise target'], '71 km/h', 'Cruise speed uses the whole value without jump flag decoding');
  assert.equal(values['trick flag A'], 'Yes');
  assert.equal(values['trick flag B'], 'Yes');
  assert(
    state.details.every((row: any) => row.readOnly),
    'Reference properties are selectable read-only values',
  );
  assert.deepEqual(
    state.eventTitles,
    ['1. Jump', '2. Reset after region', '3. Cruise speed', '4. Reselect path', '5. Unidentified', '6. Unidentified'],
    'Event titles show their names and list numbers without raw event IDs',
  );
  assert(state.eventTitleSymbols.every(Boolean), 'Every event title starts with its matching symbol');
  assert.deepEqual(
    state.detailFolders,
    ['Events (6)', 'Reference path', 'Geometry'],
    'Events appear before reference-path properties and geometry',
  );
  assert(
    state.text.indexOf('Event spans on all paths') < state.text.indexOf('Events (6)'),
    'The event list follows the rating and shape legend',
  );
  assert.deepEqual(
    state.details.filter((row: any) => row.label === 'type').map((row: any) => row.value),
    ['100', '105', '101', '300', '777', '102'],
    'Raw type IDs remain available inside each event',
  );
  assert(state.text.includes('current path may still win'), 'Reselection does not promise a different path');
  assert(
    state.text.includes('no active caller was found'),
    'The type-102 note distinguishes a helper from active behavior',
  );
  assert.deepEqual(state.materials, [
    { index: 1, color: aiPathColor(80), dashed: true, width: 4.5 },
    { index: 2, color: aiPathColor(50), dashed: false, width: 2.5 },
  ]);
  assert.deepEqual(state.eventLabels, [0, 1, 2, 3, 4, 5], 'Ranged and point events have matching numbered map markers');
  assert.deepEqual(
    state.eventShapes,
    { 0: 'triangle', 1: 'diamond', 2: 'circle', 3: 'flag', 4: 'square', 5: 'square' },
    'Selected events use distinct marker shapes for jumps, speeds, resets and reselection',
  );
  assert.deepEqual(
    state.eventRanges.map((range: any) => range.stations),
    [
      [5, 7],
      [8, 9],
      [10, 11],
      [12, 13],
      [17.5, 18],
    ],
  );
  assert.equal(state.eventRanges[2].color, aiPathEventStyle(101).color, 'Cruise-speed ranges use their event colour');
  assert.deepEqual(
    state.eventRanges[0].positions,
    [5, 1.5, 0, 7, Math.fround(1.7), 0],
    'Jump range starts and ends at its exact horizontal stations',
  );
  const difference = (a: number[], b: number[]) => Math.hypot(...a.slice(0, 3).map((value, i) => value - b[i]));
  for (const textured of [false, true]) {
    await page.evaluate(on => (window as any).aiPathSelection.textured(on), textured);
    const depths = await page.evaluate(() => (window as any).aiPathSelection.depthSamples());
    for (const [selection, sample] of depths.entries()) {
      for (let i = 0; i < 3; i++) {
        const exposed = difference(sample.exposed[i], sample.background[i]);
        const occluded = difference(sample.occluded[i], sample.background[i]);
        assert(
          exposed > 20,
          `Paths remain visible in ${textured ? 'textured' : 'surface-type'} shading, selected=${selection === 0}`,
        );
        assert(occluded > 3, 'Terrain-covered paths and event markers remain visible as ghosts');
        assert(occluded < exposed * 0.9, 'Occluded paths and event markers are dimmer than exposed sections');
      }
    }
  }
  await page.evaluate(() => (window as any).aiPathSelection.textured(false));
  const authored = await page.evaluate(() => (window as any).aiPathSelection.authoredFade());
  assert(Math.abs(authored.faded[1] - 0.4 * CAGE_OCCLUDED_DIM) < 1e-8);
  assert.deepEqual(authored.restored, [1, CAGE_OCCLUDED_DIM], 'Course-drawing fade preserves the occluded dim ratio');
  assert.equal(authored.depth, GreaterDepth);
  assert(authored.sharedGeometry && authored.cleared, 'Authored path twins share geometry and clear with the layer');
  if (process.env.SLOPESMITH_AI_PATH_SCREENSHOT)
    await page.screenshot({ path: process.env.SLOPESMITH_AI_PATH_SCREENSHOT, fullPage: true });
  assert(
    await page
      .locator('.lil-title')
      .filter({ hasText: /^1\. Jump$/ })
      .isVisible(),
    'The Events panel starts expanded',
  );
  await page
    .locator('.lil-title')
    .filter({ hasText: /^1\. Jump$/ })
    .click();
  await page.locator('.sp-detail').filter({ hasText: 'target speed' }).locator('input').waitFor({ state: 'visible' });
  state = await press(2);
  assert.equal(state.highlighted, 2, 'Duplicate names remain distinct selectable objects');
  assert(state.text.includes('This path has no events.'));
  assert.equal(
    state.materials[0].color,
    aiPathColor(80),
    'Selecting another path preserves the first path’s rating colour',
  );
  assert.equal(state.materials[0].width, 2.5);
  assert.deepEqual(state.eventLabels, [], 'Numbered annotations belong only to the selected route');
  const showPaths = page.locator('.lil-controller').filter({ hasText: 'show AI paths' }).locator('input');
  assert.equal(
    await page.locator('.lil-controller').filter({ hasText: 'colour by' }).count(),
    0,
    'The combined view needs no colour-mode selector',
  );
  assert.equal(
    await page.locator('.lil-controller').filter({ hasText: 'reference path' }).count(),
    0,
    'Reference paths are selected by clicking the map, without a dropdown',
  );
  state = await page.evaluate(() => (window as any).aiPathSelection.select(null));
  assert(
    state.overviewVisible && state.overviewCount > 0,
    'Events are visible across the network without selecting a path',
  );
  assert.deepEqual(
    state.overviewShapes,
    ['circle', 'diamond', 'flag', 'square', 'triangle'],
    'The whole network uses the same event symbols',
  );
  assert.deepEqual(state.eventLabels, [], 'The whole-network overview has no numbered labels');
  assert(
    state.text.includes('Event spans on all paths') && state.text.includes('Rating: 0 (green)'),
    'The combined legend explains rating colours and event symbols',
  );
  assert.deepEqual(
    state.materials.map((path: any) => path.color),
    [aiPathColor(80), aiPathColor(50)],
    'Each path keeps its rating colour beneath the event spans',
  );
  const expectedEventColors = [
    aiPathColor(80),
    ...[100, 103, 101, 777, 102, 300].map(type => aiPathEventStyle(type).color),
  ];
  for (const textured of [false, true]) {
    await page.evaluate(on => (window as any).aiPathSelection.textured(on), textured);
    const pixels = await page.evaluate(() =>
      (window as any).aiPathSelection.pixels(1, [2, 6, 8.2, 10.2, 12.2, 17.6, 20]),
    );
    for (const [i, pixel] of pixels.entries()) {
      const expected = [16, 8, 0].map(shift => (expectedEventColors[i] >> shift) & 255);
      assert(
        pixel.slice(0, 3).every((channel: number, j: number) => Math.abs(channel - expected[j]) < 12),
        `Unselected rating/event span ${i} keeps its colour in ${textured ? 'textured' : 'surface-type'} shading: ${pixel}`,
      );
    }
    const plain = await page.evaluate(() => (window as any).aiPathSelection.pixels(2, [2]));
    assert(
      plain[0]
        .slice(0, 3)
        .every((channel: number, i: number) => Math.abs(channel - ((aiPathColor(50) >> (16 - i * 8)) & 255)) < 12),
      'Paths without events also retain their own rating colour',
    );
  }
  await page.evaluate(() => (window as any).aiPathSelection.textured(false));
  if (process.env.SLOPESMITH_AI_PATH_SCREENSHOT)
    await page.screenshot({ path: `${process.env.SLOPESMITH_AI_PATH_SCREENSHOT}.network.png`, fullPage: true });
  await showPaths.uncheck();
  assert(!(await page.evaluate(() => (window as any).aiPathSelection.snapshot())).overviewVisible);
  state = await page.evaluate(() => (window as any).aiPathSelection.snapshot());
  assert(!state.visible && !state.overviewVisible, 'One visibility toggle hides both rating lines and event overlays');
  await showPaths.check();
  state = await page.evaluate(() => (window as any).aiPathSelection.reload());
  assert(
    state.overviewVisible && state.overviewCount > 0 && state.materials[0].color === aiPathColor(80),
    'Reference replacement rebuilds both rating lines and event geometry',
  );
  state = await page.evaluate(() => (window as any).aiPathSelection.reload(true));
  assert.deepEqual(
    state.overviewShapes,
    ['circle', 'cross', 'diamond', 'flag', 'square', 'triangle'],
    'Disabled and unidentified events keep different symbols even though they share a colour',
  );
  const overlapPixels = await page.evaluate(() => (window as any).aiPathSelection.pixels(1, [4.2, 6, 16]));
  for (const [i, type] of [101, 100, -1].entries()) {
    const color = aiPathEventStyle(type).color;
    assert(
      overlapPixels[i]
        .slice(0, 3)
        .every((channel: number, shift: number) => Math.abs(channel - ((color >> (16 - 8 * shift)) & 255)) < 12),
      'Overlapping cruise regions retain visible jump spans and shaped point events',
    );
  }
  await page.evaluate(() => (window as any).aiPathSelection.reload());
  state = await press(1);
  assert.deepEqual(
    state.eventLabels,
    [0, 1, 2, 3, 4, 5],
    'Selected events retain their numbered annotations in the combined view',
  );
  assert(
    state.overviewVisible && state.materials[0].color === aiPathColor(80),
    'Selection preserves both the rating colours and network events',
  );
  await page.evaluate(() => (window as any).aiPathSelection.anchor(true));
  state = await press(1);
  assert.equal(state.highlighted, null, 'Course handles retain priority over paths beneath them');
  assert.equal(state.attachedGizmo, 'anchor');
  await page.evaluate(() => (window as any).aiPathSelection.anchor(false));
  await page.evaluate(() => (window as any).aiPathSelection.building(true));
  assert.equal((await press(1)).highlighted, null, 'Paths covered by scenery do not capture clicks through buildings');
  await page.evaluate(() => (window as any).aiPathSelection.building(false));
  await page.evaluate(() => (window as any).aiPathSelection.occlude(true));
  state = await press(1);
  assert.equal(state.highlighted, null, 'Terrain occludes paths instead of allowing selection through the mountain');
  await page.evaluate(() => (window as any).aiPathSelection.occlude(false));
  state = await press(1);
  assert.equal(state.highlighted, 1);
  await page.evaluate(() => (window as any).aiPathSelection.hide());
  state = await press(1);
  assert.equal(state.highlighted, null, 'A hidden overlay cannot capture a scene click');
  assert.equal(state.annotationsVisible, false, 'Event annotations follow path overlay visibility');
  await page.evaluate(() => (window as any).aiPathSelection.show());
  assert.equal((await press(1)).highlighted, 1);
  assert.equal(
    (await page.evaluate(() => (window as any).aiPathSelection.leave())).highlighted,
    null,
    'Leaving Scene clears the path selection',
  );
  await page.evaluate(() => (window as any).aiPathSelection.enter());
  assert.equal((await press(2)).highlighted, 2);
  state = await page.evaluate(() => (window as any).aiPathSelection.clearReference());
  assert.equal(state.highlighted, null, 'Replacing or clearing the reference removes stale inspection');
  assert.equal(state.annotationCount, 0, 'Clearing the reference removes its event annotations');
  assert.equal(state.overviewCount, 0, 'Clearing the reference also removes the event overview');
  assert(state.text.includes('Load a reference mountain with AI paths'));
  assert(await page.evaluate(() => (window as any).aiPathSelection.unchanged()));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: AI path data → transformed overlay raycast → Scene inspector, properties, selection, visibility, occlusion and reference cleanup',
  );
} finally {
  await browser.close();
}
