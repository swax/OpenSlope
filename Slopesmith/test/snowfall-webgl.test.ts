/**
 * Real browser/WebGL check for the ambient snowfall (docs/050). It bundles the tiny fixture beside this file,
 * serves it from loopback, and launches an installed Chromium-family browser through playwright-core (no
 * downloaded browser binary). Run: `npx tsx test/snowfall-webgl.test.ts`
 *
 * Why a browser: the whole effect is one vertex shader. `snowfall.test.ts` pins the law it implements and the
 * layer that hosts it, and neither can see a program that failed to compile, a uniform the driver never got,
 * or a flake that landed behind the near plane. Those failures all look the same from Node — an empty sky —
 * and they are the only ways this feature can break silently.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

interface SnowfallResult {
  ok: boolean;
  error?: string;
  renderer?: string;
  idleLight?: number;
  ridingLight?: number;
  clearedLight?: number;
  farLight?: number[];
  parallaxDiff?: number;
  periodDiff?: number;
  brightnessByAmount?: { amount: number; mean: number }[];
}

const work = mkdtempSync(join(tmpdir(), 'slopesmith-snowfall-'));
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const server = createServer();

try {
  const bundle = join(work, 'fixture.js');
  await build({
    entryPoints: [fileURLToPath(new URL('./snowfall-webgl.fixture.ts', import.meta.url))],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    sourcemap: 'inline',
    logLevel: 'silent',
  });
  const script = readFileSync(bundle);
  server.on('request', (request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(script);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><script type="module" src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');

  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    chromiumSandbox: false,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.stack ?? error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.documentElement.dataset.snowfall, null, { timeout: 30_000 });
  const result = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __snowfall?: SnowfallResult }).__snowfall);
  assert(result, 'Browser fixture did not publish a result');
  assert(result.ok, result.error ?? 'Snowfall fixture failed');
  assert.deepEqual(consoleErrors, [], `Browser emitted shader errors:\n${consoleErrors.join('\n')}`);
  console.log(`SNOWFALL WEBGL TEST PASSED (${result.renderer}; editor view ${result.idleLight}, `
    + `riding ${result.ridingLight}, dialled to clear ${result.clearedLight}, `
    + `far eyes ${result.farLight?.join('/')}, 3 m of parallax moved ${result.parallaxDiff}, `
    + `a whole box moved ${result.periodDiff};\n  the dial, as mean white out of 255: `
    + `${result.brightnessByAmount?.map(s => `${s.amount}=${s.mean.toFixed(1)}`).join(' ')})`);
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
