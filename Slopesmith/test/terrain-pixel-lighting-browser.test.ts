// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./terrain-pixel-lighting-browser.fixture.ts', import.meta.url))],
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
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage(),
    errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.waitForFunction(() => (window as any).terrainPixelResult || (window as any).terrainPixelError);
  const result = await page.evaluate(() => ({
    result: (window as any).terrainPixelResult,
    error: (window as any).terrainPixelError,
  }));
  assert.equal(result.error, undefined);
  assert.deepEqual(errors, []);
  console.log(
    `TERRAIN PIXEL LIGHTING PASS: ${result.result.checks} framebuffer checks for lighting, textures, invisible helpers, reference fallback and shader reuse.`,
  );
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
