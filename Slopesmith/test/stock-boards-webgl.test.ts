import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./stock-boards-webgl.fixture.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const server = createServer((request, response) => {
  const id = /^\/equipment\/boards\/(contour|sunset|timberline|night-shift)\.png(?:\?|$)/.exec(request.url ?? '')?.[1];
  if (id) {
    response.setHeader('content-type', 'image/png');
    response.end(readFileSync(new URL(`../public/equipment/boards/${id}.png`, import.meta.url)));
    return;
  }
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(
    request.url === '/fixture.js'
      ? bundle.outputFiles[0].contents
      : '<script type="module" src="/fixture.js"></script>',
  );
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    chromiumSandbox: false,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1120, height: 680 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => !!document.documentElement.dataset.stockBoards, null, { timeout: 45000 });
  const result = JSON.parse(await page.evaluate(() => document.documentElement.dataset.stockBoards!)) as {
    ok: boolean;
    error?: string;
  };
  assert(result.ok, result.error);
  assert.deepEqual(errors, []);
  const output = new URL('../../temp/board-art/', import.meta.url);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('slopesmith-boards.png', output)), fullPage: true });
  console.log('STOCK BOARDS WEBGL TEST PASSED', result);
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
