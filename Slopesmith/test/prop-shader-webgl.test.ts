/**
 * Real browser/WebGL regression for prop materials. It bundles the tiny fixture beside this file, serves it
 * from loopback, and launches an installed Chromium-family browser through playwright-core (no downloaded
 * browser binary). Run: `npx tsx test/prop-shader-webgl.test.ts`
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

interface ShaderSmokeResult {
  ok: boolean;
  error?: string;
  programs?: number;
  customPixel?: number[];
  nativePixel?: number[];
  batchedNativePixel?: number[];
  clayLitPixel?: number[];
  clayDarkPixel?: number[];
  clayNoSunPixel?: number[];
  clayInstancedFrontPixel?: number[];
  clayInstancedBackPixel?: number[];
  clayContactPixel?: number[];
  sunTintPixel?: number[];
  flipIntactPixel?: number[];
  flipCrackedPixel?: number[];
  flipOtherPixel?: number[];
  partialAlphaPixel?: number[];
  cutoutCoverage?: number;
  lollipopAtlasPixel?: number[];
  renderer?: string;
}

interface GlbJson {
  images?: Array<{ bufferView?: number; mimeType?: string }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength?: number }>;
}

function embeddedPng(glb: Buffer): Buffer {
  assert.equal(glb.toString('ascii', 0, 4), 'glTF', 'Lollipop fixture is not a binary glTF');
  const jsonLength = glb.readUInt32LE(12);
  assert.equal(glb.toString('ascii', 16, 20), 'JSON', 'GLB has no leading JSON chunk');
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength).trimEnd()) as GlbJson;
  const image = json.images?.find(candidate => candidate.mimeType === 'image/png');
  assert(image?.bufferView !== undefined, 'Lollipop GLB has no embedded PNG');
  const view = json.bufferViews?.[image.bufferView];
  assert(view?.byteLength !== undefined, 'Embedded lollipop PNG has no buffer view');
  const binaryHeader = 20 + jsonLength;
  assert.equal(glb.toString('ascii', binaryHeader + 4, binaryHeader + 8), 'BIN\0', 'GLB has no binary chunk');
  const start = binaryHeader + 8 + (view.byteOffset ?? 0);
  const png = glb.subarray(start, start + view.byteLength);
  assert.equal(png.readUInt32BE(0), 0x89504e47, 'Embedded lollipop image is not a PNG');
  return png;
}

const work = mkdtempSync(join(tmpdir(), 'slopesmith-prop-shader-'));
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const server = createServer();

try {
  const bundle = join(work, 'fixture.js');
  await build({
    entryPoints: [fileURLToPath(new URL('./prop-shader-webgl.fixture.ts', import.meta.url))],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    sourcemap: 'inline',
    logLevel: 'silent',
  });
  const script = readFileSync(bundle);
  const lollipopGlb = readFileSync(fileURLToPath(new URL(
    '../tools/prop-recipes/props/WrappedLollipopRed.glb', import.meta.url)));
  const lollipopAtlas = embeddedPng(lollipopGlb);
  server.on('request', (request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(script);
      return;
    }
    if (request.url === '/wrapped-lollipop.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(lollipopAtlas);
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
  await page.waitForFunction(() => !!document.documentElement.dataset.propShaderSmoke, null, { timeout: 15_000 });
  const result = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __propShaderSmoke?: ShaderSmokeResult }).__propShaderSmoke);
  assert(result, 'Browser fixture did not publish a result');
  assert(result.ok, result.error ?? 'WebGL shader fixture failed');
  assert.deepEqual(consoleErrors, [], `Browser emitted shader errors:\n${consoleErrors.join('\n')}`);
  console.log(`PROP SHADER WEBGL TEST PASSED (${result.programs} programs, ${result.renderer}; `
    + `custom ${result.customPixel?.join('/')}, native ${result.nativePixel?.join('/')}, `
    + `batched native ${result.batchedNativePixel?.join('/')}, `
    + `surface clay lit ${result.clayLitPixel?.join('/')} dark ${result.clayDarkPixel?.join('/')} `
    + `no-sun ${result.clayNoSunPixel?.join('/')}, `
    + `instanced front ${result.clayInstancedFrontPixel?.join('/')} back ${result.clayInstancedBackPixel?.join('/')}, `
    + `contact tint ${result.clayContactPixel?.join('/')}, `
    + `sun tint ${result.sunTintPixel?.join('/')}, `
    + `cutout coverage ${result.cutoutCoverage?.toFixed(3)}, `
    + `partial alpha ${result.partialAlphaPixel?.join('/')}, `
    + `lollipop atlas ${result.lollipopAtlasPixel?.join('/')}, `
    + `flip intact/cracked/other ${result.flipIntactPixel?.join('/')}/${result.flipCrackedPixel?.join('/')}`
    + `/${result.flipOtherPixel?.join('/')})`);
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
