import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const work = mkdtempSync(join(tmpdir(), 'slopesmith-local-presentation-'));
const server = createServer();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const bundle = join(work, 'fixture.js');
  await build({ entryPoints: [fileURLToPath(new URL('./local-iso-presentation.fixture.ts', import.meta.url))],
    outfile: bundle, bundle: true, format: 'esm', platform: 'browser', logLevel: 'silent' });
  const script = readFileSync(bundle);
  server.on('request', (request, response) => {
    response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/fixture.js' ? script : '<!doctype html><script type="module" src="/fixture.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => !!(globalThis as typeof globalThis & { localIsoResult?: unknown }).localIsoResult);
  const result = await page.evaluate(() => (globalThis as typeof globalThis & { localIsoResult?: { ok: boolean; error?: string } }).localIsoResult);
  assert(result?.ok, result?.error); assert.deepEqual(errors, []);
  console.log('LOCAL ISO PRESENTATION: PASS (cached collision audio repair and actual sky seam pixels)');
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
