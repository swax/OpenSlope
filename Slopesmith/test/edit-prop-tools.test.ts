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
import { AUTHORED_MODEL_LEVEL, createAuthoredModel } from '../src/core/doc/models';
import type { EditDoc } from '../src/core/doc/doc-edit';

// The real mode switch clears Edit gizmos. Exercise the button in the full editor so a passing toolbox test
// cannot hide a lost selection or transform handle when Props takes over.
const root = mkdtempSync(join(tmpdir(), 'slopesmith-edit-prop-tools-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
process.env.PORT = String(api.port);
const vite = await createServer({ root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
type Observation = { slopesmith: {
  snapshot(): { mode: string; selection: { prop: number | null; props: number[] } };
  doc(): EditDoc;
  refresh(): unknown;
  errors(): unknown[];
  pickAt(x: number, y: number): { target: string; propIndex?: number } | null;
} };

try {
  const corners: number[] = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) corners.push(r * 20, 0, c * 20);
  const doc = meshFromNet({ rows: 6, cols: 6, spacing: 20, corners, paint: {} },
    { name: 'EDIT_PROP_TOOLS', course: starterCourse(), baseSurface: 1 });
  const model = createAuthoredModel(doc, 'Panel fixture');
  model.vertices = [-4, 0, -4, 4, 0, -4, -4, 0, 4, 4, 0, 4];
  model.quads = [[0, 1, 2, 3]];
  doc.labels = [{ id: 'label:solo', name: 'Solo' }, { id: 'label:group', name: 'Assembly' },
    { id: 'label:all', name: 'All props' }, { id: 'label:mixed', name: 'Mixed' }];
  doc.props = [30, 50, 70].map((x, i) => ({ id: `prop:${i}`, level: AUTHORED_MODEL_LEVEL, model: 0,
    name: `Fixture ${i}`, pos: [x, 5, 50], yaw: 0, scale: 1,
    labels: [i ? 'label:group' : 'label:solo', 'label:all', 'label:mixed'],
    ...(i ? { assembly: 'group:fixture' } : {}),
  }));
  doc.quadLabels = { 0: ['label:mixed'] };
  const response = await fetch(`${api.url}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: doc }),
  });
  assert(response.ok);
  await vite.listen();
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${vite.resolvedUrls!.local[0]}?map=EDIT_PROP_TOOLS&agent=1`);
  await page.waitForFunction(() => !!(window as unknown as Observation).slopesmith
    && document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 60_000 });
  const panel = page.locator('#dock-right > .lil-gui:visible');
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const selected = () => page!.evaluate(() => {
    const { prop, props } = (window as unknown as Observation).slopesmith.snapshot().selection;
    return { prop, props };
  });
  async function enterEdit() {
    await page!.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page!.keyboard.press('Escape');
  }
  async function checkCompact() {
    await button('open in Props mode').waitFor({ state: 'visible' });
    const text = await panel.innerText();
    assert(/Selection/i.test(text) && /Labels/i.test(text));
    assert(!/Contact|Lighting|Emitters|Members \(|revise prop|edit shape|copy group|delete group/i.test(text), text);
    for (const [key, name] of [['e', 'Rotate'], ['r', 'Scale'], ['w', 'Move']] as const) {
      await page!.keyboard.press(key);
      assert.equal(await button(name).getAttribute('aria-pressed'), 'true', `${key} selects ${name} in Edit`);
    }
  }
  async function openProps() {
    const before = await selected();
    const indices = before.props.length ? before.props : before.prop === null ? [] : [before.prop];
    await button('open in Props mode').click();
    await page!.waitForFunction(() => (window as unknown as Observation).slopesmith.snapshot().mode === 'props');
    assert.deepEqual(await selected(), indices.length === 1 ? { prop: indices[0], props: [] } : before,
      'switching toolboxes keeps the same placements and opens one prop as a single selection');
    assert(await button('Rotate').isVisible());
    assert(await button('Scale').isVisible());
  }

  await enterEdit();
  // A direct canvas pick exercises selectedProp, while label/marquee selections use multiSel.
  await page.evaluate(() => (window as unknown as Observation).slopesmith.refresh());
  const box = await page.locator('[data-agent-ref="prop:0"]').boundingBox();
  assert(box);
  const hit = await page.evaluate(box => {
    for (let dy = -16; dy <= 16; dy += 2) for (let dx = -16; dx <= 16; dx += 2) {
      const x = box.x + box.width / 2 + dx, y = box.y + box.height / 2 + dy;
      const pick = (window as unknown as Observation).slopesmith.pickAt(x, y);
      if (pick?.target === 'prop' && pick.propIndex === 0) return { x, y };
    }
    return null;
  }, box);
  assert(hit, 'the single prop has a pickable surface');
  await page.mouse.click(hit.x, hit.y);
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.snapshot().selection.prop === 0);
  await checkCompact();
  const labelInput = panel.locator('.lil-controller').filter({ has: page.locator('.lil-name', { hasText: /^new label$/ }) }).locator('input');
  await labelInput.fill('Checked');
  await button('＋ create label').click();
  await page.waitForFunction(() => {
    const doc = (window as unknown as Observation).slopesmith.doc();
    const id = doc.labels?.find(label => label.name === 'Checked')?.id;
    return !!id && doc.props?.[0].labels?.includes(id);
  });
  await page.screenshot({ path: join(root, 'edit-single.png') });
  await openProps();
  assert(/Contact/i.test(await panel.innerText()));

  await enterEdit();
  await button('Solo · 1').click();
  assert.deepEqual(await selected(), { prop: null, props: [0] });
  await checkCompact();
  await openProps();
  assert(/Contact/i.test(await panel.innerText()));

  await enterEdit();
  await button('Assembly · 2').click();
  await checkCompact();
  assert.deepEqual(await selected(), { prop: null, props: [1, 2] });
  await page.screenshot({ path: join(root, 'edit-group.png') });
  await openProps();
  assert(/Members \(2\)/i.test(await panel.innerText()));
  assert(await button('⇲ break group').isVisible());
  await page.screenshot({ path: join(root, 'props-group.png') });

  await enterEdit();
  await button('All props · 3').click();
  await checkCompact();
  await openProps();
  assert((await panel.innerText()).includes('group 3 props'));

  await enterEdit();
  await button('Mixed · 4').click();
  assert.equal(await button('open in Props mode').count(), 0, 'mixed selections keep their type chooser');
  await button('3 props').click();
  await checkCompact();
  assert.deepEqual(await selected(), { prop: null, props: [0, 1, 2] });
  await button('deselect (Esc)').click();
  assert.equal(await button('open in Props mode').count(), 0);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  assert.deepEqual(errors, []);
  console.log(`EDIT PROP TOOLS PASS: compact single/group/multi selection, transforms, labels and Props handoff. Screenshots: ${root}`);
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
