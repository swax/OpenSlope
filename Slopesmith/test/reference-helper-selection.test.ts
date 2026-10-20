// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./reference-helper-selection.fixture.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(
    request.url === '/fixture.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><script type="module" src="/fixture.js"></script>',
  );
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { waitUntil: 'networkidle' });
  await page
    .waitForFunction(() => (window as any).helperSelection, undefined, { timeout: 10_000 })
    .catch(() => assert.fail(errors.join('\n') || 'Helper selection fixture did not load'));
  const click = (index: number, additive = false) =>
    page.evaluate(([i, add]) => (window as any).helperSelection.press(i, add), [index, additive] as const);
  let state = await click(0);
  assert.deepEqual(
    state.selected,
    [0],
    'An untranslated purple helper selects through the pointer router and real Effects editor',
  );
  assert.deepEqual(state.unavailable, [], 'The helper does not produce the prop/mode error');
  assert(state.text.includes('mdl_er4_trg_fw_archlights_4_1001'));
  assert(state.text.includes('No playable effects have been imported for this helper yet.'));
  assert.deepEqual(
    await page.evaluate(() => (window as any).helperSelection.refresh()),
    [0],
    'A panel refresh retains the selection',
  );
  state = await click(1, true);
  assert.deepEqual(state.selected, [0, 1], 'Ctrl-click also selects a deferred boundary helper');
  state = await click(0, true);
  assert.deepEqual(state.selected, [1], 'Ctrl-click toggles helpers out of the selection');
  assert(state.text.includes('mdl_er4_impassableleft_17'));
  state = await click(2);
  assert.deepEqual(state.selected, [1]);
  assert.deepEqual(state.unavailable, ['prop'], 'Ordinary unbound scenery keeps its existing mode hint');
  assert(
    await page.evaluate(() => (window as any).helperSelection.unchanged()),
    'Inspection does not fabricate graphs or change stored data',
  );
  assert.equal(
    await page.evaluate(() => (window as any).helperSelection.stop()),
    false,
    'Leaving Effects hides editor helper overlays',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: browser pointer → helper raycast → Effects selection/inspector, additive selection, refresh and source preservation',
  );
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
