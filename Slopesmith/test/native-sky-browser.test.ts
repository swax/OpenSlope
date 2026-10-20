// tier: integration
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./native-sky-browser.fixture.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
  plugins: [
    {
      name: 'vite-text-imports',
      setup(plugin) {
        plugin.onResolve({ filter: /\?raw$/ }, args => ({
          path: resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: 'raw',
        }));
        plugin.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({
          contents: await readFile(args.path, 'utf8'),
          loader: 'text',
        }));
        plugin.onResolve({ filter: /^virtual:slopesmith-dependency-notices$/ }, args => ({
          path: args.path,
          namespace: 'notices',
        }));
        plugin.onLoad({ filter: /.*/, namespace: 'notices' }, () => ({ contents: 'export default "";' }));
      },
    },
  ],
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
  const errors: string[] = [],
    escaped: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/')) escaped.push(request.url());
  });
  await page.route('**/slow.png', async route => {
    await new Promise(resolve => setTimeout(resolve, 100));
    await route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window as any).nativeSkyResult || (window as any).nativeSkyError, undefined, {
    timeout: 15_000,
  });
  const result = await page.evaluate(() => ({
    result: (window as any).nativeSkyResult,
    error: (window as any).nativeSkyError,
  }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.result.catalogue, ['SSXOT_ER4_DAY', 'SSXOT_ER4_NIGHT']);
  assert.deepEqual(escaped, [], 'Cached course skies never request a server asset');
  assert.deepEqual(errors, []);
  console.log(`PASS: native course sky ${result.result.checks}`);
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
