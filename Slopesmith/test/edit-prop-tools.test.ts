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
  snapshot(): { mode: string; selection: { prop: number | null; props: number[]; light: string | null } };
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
  doc.lights = [{ id: 'light:fixture', kind: 'point', pos: [90, 10, 50], color: '#ffcc88', intensity: 1, reach: 20 }];
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

  // A free light selects in Edit like a placement: moved by its gizmo, its full panel a button away in Props.
  const sources = page.getByRole('button', { name: 'Sources', exact: true }).first();
  if (await sources.getAttribute('aria-pressed') !== 'true') await sources.click();
  await page.evaluate(() => (window as unknown as Observation).slopesmith.refresh());
  const bulb = await page.locator('[data-agent-ref="light:fixture"]').boundingBox();
  assert(bulb, 'the free light is mirrored once Sources shows it');
  const lightHit = await page.evaluate(box => {
    for (let dy = -12; dy <= 12; dy += 2) for (let dx = -12; dx <= 12; dx += 2) {
      const x = box.x + box.width / 2 + dx, y = box.y + box.height / 2 + dy;
      if ((window as unknown as Observation).slopesmith.pickAt(x, y)?.target === 'light') return { x, y };
    }
    return null;
  }, bulb);
  assert(lightHit, 'the free light has a pickable bulb');
  await page.mouse.click(lightHit.x, lightHit.y);
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.snapshot().selection.light === 'light:fixture');
  await button('open in Props mode').waitFor({ state: 'visible' });
  // Details are read-only inputs, so their text is their value rather than the panel's inner text.
  const details = await panel.locator('input').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  assert(details.some(value => /Use the gizmo to move the light/i.test(value)), details.join(' | '));
  assert(!/Contact|Members \(|colour|delete light/i.test(await panel.innerText()), 'Edit keeps the light compact');
  await page.screenshot({ path: join(root, 'edit-light.png') });
  await button('open in Props mode').click();
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.snapshot().mode === 'props');
  assert.equal((await page.evaluate(() => (window as unknown as Observation).slopesmith.snapshot().selection)).light,
    'light:fixture', 'Props opens the same light');
  assert(await button('✕ delete light').isVisible(), 'with its full panel');
  await enterEdit();
  assert.equal((await page.evaluate(() => (window as unknown as Observation).slopesmith.snapshot().selection)).light,
    null, 'Esc in Edit lets the light go');

  // Ctrl+click builds a set of props and lights in Edit as it does in Props, and Props opens it ready to group.
  await page.mouse.click(hit.x, hit.y);
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.snapshot().selection.prop === 0);
  // Let the gizmo render on the prop before pressing: its invisible pickers follow it only when a frame draws, and
  // a press before then is hit-tested against where they last stood — over the light, which had the gizmo earlier.
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
  await page.mouse.move(lightHit.x, lightHit.y);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForFunction(() => [...document.querySelectorAll('#dock-right input')]
    .some(input => (input as HTMLInputElement).value === '1 prop + 1 light selected'));
  assert.deepEqual(await selected(), { prop: null, props: [0] }, 'the prop holds the set, the light rides beside it');
  await page.screenshot({ path: join(root, 'edit-prop-light.png') });
  await button('open in Props mode').click();
  await page.waitForFunction(() => (window as unknown as Observation).slopesmith.snapshot().mode === 'props');
  assert(await button('⊞ group 1 prop + 1 light').isVisible(), await panel.innerText());
  await enterEdit();
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  assert.deepEqual(errors, []);
  console.log(`EDIT PROP TOOLS PASS: compact single/group/multi selection, transforms, labels, a free light and Props handoff. Screenshots: ${root}`);
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
