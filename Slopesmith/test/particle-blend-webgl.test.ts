/**
 * Real browser/WebGL regression for SSF emitter blend modes, stereo billboards and atlas restoration.
 * It bundles the fixture beside this file,
 * serves it from loopback, and launches an installed Chromium-family browser through playwright-core (no
 * downloaded browser binary). Run: `npx tsx test/particle-blend-webgl.test.ts`
 *
 * Why a browser: the bug this pins was a blend-state bug. Every value in the emitter law decoded correctly and
 * the particles were spawned, sized and positioned correctly — they simply reached the framebuffer through an
 * additive blend, where a near-black plume adds nothing. Only a real blend unit can tell those two apart.
 * The atlas check also resets this isolated browser's GPU process: losing only WebGL leaves Canvas2D pixels
 * intact and misses the PCVR failure. SLOPESMITH_WEBGL_BACKEND=d3d11 selects the Windows hardware backend;
 * the default SwiftShader backend keeps the test portable.
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

interface ParticleBlendResult {
  ok: boolean;
  error?: string;
  renderer?: string;
  legacyAtlasCleared?: boolean;
  backgroundPixel?: number[];
  additivePixel?: number[];
  darkenPixel?: number[];
  alphaPixel?: number[];
  darkenDrawnAdditivePixel?: number[];
  flareBlend?: string;
}

const work = mkdtempSync(join(tmpdir(), 'slopesmith-particle-blend-'));
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const server = createServer();

try {
  const bundle = join(work, 'fixture.js');
  await build({
    entryPoints: [fileURLToPath(new URL('./particle-blend-webgl.fixture.ts', import.meta.url))],
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

  const backend = process.env.SLOPESMITH_WEBGL_BACKEND ?? 'swiftshader';
  assert(['swiftshader', 'd3d11'].includes(backend), 'SLOPESMITH_WEBGL_BACKEND must be swiftshader or d3d11');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    chromiumSandbox: false,
    args: [
      `--use-angle=${backend}`, '--enable-gpu-benchmarking',
      ...(backend === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
    ],
  });
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.stack ?? error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.documentElement.dataset.particleBlend, null, { timeout: 25_000 });
  const result = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __particleBlend?: ParticleBlendResult }).__particleBlend);
  assert(result, 'Browser fixture did not publish a result');
  assert(result.ok, result.error ?? 'Particle blend fixture failed');
  assert.deepEqual(consoleErrors, [], `Browser emitted shader errors:\n${consoleErrors.join('\n')}`);
  console.log(`PARTICLE WEBGL: PASS (${result.renderer}; blend modes, stereo billboards, atlas updates and context recovery; `
    + `legacy atlas cleared: ${result.legacyAtlasCleared})`);
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
