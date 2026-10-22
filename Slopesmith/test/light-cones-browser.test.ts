// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: ['test/light-cones-browser.fixture.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(
    request.url === '/fixture.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><script type="module" src="/fixture.js"></script>',
  );
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 950 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.getByRole('button', { name: 'edit copy in Mountain', exact: true }).click();
  const rows = page.locator('.lil-controller');
  const angle = rows
    .filter({ has: page.getByText('cone half-angle (°)', { exact: true }) })
    .last()
    .locator('input');
  assert(
    Math.abs(Number(await angle.inputValue()) - 85) < 0.01,
    'A recovered 85-degree cone must not be clipped to the old editor maximum',
  );
  await angle.fill('27.5');
  await angle.press('Tab');
  await page.waitForFunction(() => {
    const state = (window as unknown as { lightEditor: { value(): { cone: number }; rebuilds(): number } }).lightEditor;
    return state.value().cone === 27.5 && state.rebuilds() > 0;
  });
  const full = rows
    .filter({ has: page.getByText('full cone angle (°)', { exact: true }) })
    .last()
    .locator('input');
  await page.waitForFunction(input => (input as HTMLInputElement).value === '55', await full.elementHandle());
  const cosine = rows.filter({ has: page.getByText('exported cone cosine', { exact: true }) }).locator('input');
  assert(Math.abs(Number(await cosine.inputValue()) - Math.cos((27.5 * Math.PI) / 180)) < 0.000001);
  assert.deepEqual(errors, []);
  await mkdir('temp', { recursive: true });
  const screenshot = resolve(`temp/light-cones-${process.pid}.png`);
  await page.screenshot({ path: screenshot });
  console.log(`PASS: recovered/editable cone values, live width/cosine, preview rebuild; ${screenshot}`);
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close(error => (error ? reject(error) : done())));
}
