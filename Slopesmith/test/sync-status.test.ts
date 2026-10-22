// tier: integration
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import type { SyncStatusChip } from '../src/app/state/sync-status';

type TestWindow = typeof window & { chip: SyncStatusChip };
const bundle = await build({
  stdin: {
    contents: `
      import { createSyncStatus } from './src/app/state/sync-status';
      window.chip = createSyncStatus({ replay() {}, discard() {}, exportMountain() {} });
      document.body.append(window.chip.indicator);
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const css = readFileSync(new URL('../src/app/styles/toolbar.css', import.meta.url), 'utf8');
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(
    request.url === '/fixture.js'
      ? bundle.outputFiles[0].text
      : `<!doctype html><style>${css}</style><script type="module" src="/fixture.js"></script>`,
  );
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'no-preference' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const indicator = page.locator('#save-status');
  await indicator.waitFor();
  assert.equal(await indicator.getAttribute('data-state'), 'idle');
  assert.equal(await indicator.getAttribute('data-destination'), 'none');
  await indicator.click();
  const details = page.getByRole('region', { name: 'Save location' });
  assert.match(await details.innerText(), /Viewing reference mountain/);
  assert.match(await details.innerText(), /Open or create a mountain to save edits/);
  assert.doesNotMatch(await details.innerText(), /Saving to server|Opening mountain|No completed save yet/);
  assert(await details.getByRole('button', { name: 'Export mountain…', includeHidden: true }).isHidden());
  await page.keyboard.press('Escape');

  // Both busy states settle even while delivery events and folder status keep repainting the chip.
  for (const state of ['saving', 'reconnecting'] as const) {
    await page.evaluate(state => {
      const { chip } = window as TestWindow;
      chip.setShared(false);
      chip.project('saved');
      if (state === 'saving') chip.project('saving', 'Saving edits');
      else {
        chip.show({ connected: false, landed: false, inFlight: 0, held: 2 });
        chip.setShared(true);
      }
    }, state);
    assert.equal(await indicator.getAttribute('data-state'), state);
    const settled = await page.evaluate(async () => {
      const { chip } = window as TestWindow;
      const icon = chip.indicator.querySelector('svg')!;
      const animation = icon.getAnimations()[0];
      if (!animation) throw new Error('Busy status should pulse briefly');
      const refresh = window.setInterval(() => {
        chip.show({ connected: false, landed: false, inFlight: 0, held: 2 });
        chip.refresh();
      }, 50);
      let timeout = 0;
      try {
        await Promise.race([
          animation.finished,
          new Promise((_, reject) => {
            timeout = window.setTimeout(() => reject(new Error('Save icon never stopped pulsing')), 5000);
          }),
        ]);
        chip.refresh();
        return {
          sameIcon: icon === chip.indicator.querySelector('svg'),
          running: icon.getAnimations().some(animation => animation.playState === 'running'),
          opacity: getComputedStyle(icon).opacity,
        };
      } finally {
        clearInterval(refresh);
        clearTimeout(timeout);
      }
    });
    assert.deepEqual(settled, { sameIcon: true, running: false, opacity: '1' });
    assert.equal(await indicator.getAttribute('data-state'), state, 'settling motion retains the actual status');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const { chip } = window as TestWindow;
    chip.setShared(false);
    chip.project('saved');
    chip.project('saving');
  });
  assert.equal(await indicator.locator('svg').evaluate(icon => icon.getAnimations().length), 0);
  await page.evaluate(() => (window as TestWindow).chip.project('error', 'Save failed'));
  assert.match((await indicator.getAttribute('aria-label'))!, /Save failed/);
  await page.evaluate(() => (window as TestWindow).chip.project('saved'));
  assert.equal(await indicator.getAttribute('data-destination'), 'server');
  assert.equal(await indicator.getAttribute('aria-label'), 'Saved to server');
  assert.deepEqual(errors, []);
  console.log('SAVE STATUS BROWSER TEST PASSED');
} finally {
  await browser.close();
  server.close();
}
