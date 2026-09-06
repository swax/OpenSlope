/**
 * Measure what Slopesmith's fog banks actually composite, so the number can be put beside Unity's and the
 * PS2's rather than asserted from the material literal.
 *
 * The material says `opacity: 0.48`, and that is NOT the answer: what reaches the framebuffer is the fog0
 * texture's own alpha times that, and fog0 is a cloudy texture whose alpha varies by a quarter of its own
 * magnitude between neighbouring pixels ([Trailmap: tools/autotest/README.md]). So this renders the real
 * Sprite path four times — two backdrops, fogged and clear — which is exactly what lets the alpha-over
 * algebra solve at EVERY pixel with nothing assumed about the texture.
 *
 *   npx tsx tools/reference-study/fog-opacity.ts [--out DIR] [--level ALOHA]
 *   python ../Trailmap/tools/autotest/fog_meter.py map <the four PNGs> --transfer srgb --centre ...
 *
 * The rig is a deliberate copy of the Unity one (same fov, size, distances, backdrop greys), so a difference
 * between the two readings is a difference between the RENDERERS and not between two test setups.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

interface FogShot { name: string; png: string }
interface FogResult {
  ok: boolean; error?: string; renderer?: string; shots?: FogShot[];
  geometry?: Record<string, number>; material?: Record<string, number | string>;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const LEVEL = option('level', 'ALOHA');
const OUT = resolve(option('out', join(tmpdir(), 'slopesmith-fog-opacity')));

function chromiumExecutable(): string {
  const candidates = process.platform === 'win32' ? [
    process.env.SLOPESMITH_CHROMIUM,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : process.platform === 'darwin' ? [
    process.env.SLOPESMITH_CHROMIUM,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : [
    process.env.SLOPESMITH_CHROMIUM, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  const executable = candidates.find((path): path is string => !!path && existsSync(path));
  assert(executable, 'No Chromium browser found; install Chrome/Edge/Chromium or set SLOPESMITH_CHROMIUM');
  return executable;
}

// The same extracted texture Unity imports, so the two renderers are shown the identical bytes.
const fogPng = resolve(fileURLToPath(new URL('../../../Maps', import.meta.url)),
  LEVEL, 'Textures', 'Particles', 'fog0.png');
assert(existsSync(fogPng), `no fog0.png for ${LEVEL} at ${fogPng} — this needs an extracted Maps/ library`);

const work = mkdtempSync(join(tmpdir(), 'slopesmith-fog-'));
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const server = createServer();

try {
  const bundle = join(work, 'fixture.js');
  await build({
    entryPoints: [fileURLToPath(new URL('./fog-opacity.fixture.ts', import.meta.url))],
    outfile: bundle, bundle: true, format: 'esm', platform: 'browser',
    sourcemap: 'inline', logLevel: 'silent',
  });
  const script = readFileSync(bundle);
  const texture = readFileSync(fogPng);
  server.on('request', (request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(script); return;
    }
    if (request.url === '/fog0.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(texture); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><script type="module" src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert(address && typeof address === 'object');

  browser = await chromium.launch({
    executablePath: chromiumExecutable(), headless: true, chromiumSandbox: false,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.stack ?? error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.documentElement.dataset.fogOpacity, null, { timeout: 30_000 });
  const result = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __fogOpacity?: FogResult }).__fogOpacity);
  assert(result, 'Browser fixture did not publish a result');
  assert(result.ok, result.error ?? 'fog opacity fixture failed');
  assert.deepEqual(consoleErrors, [], `Browser emitted errors:\n${consoleErrors.join('\n')}`);

  mkdirSync(OUT, { recursive: true });
  for (const shot of result.shots ?? []) {
    writeFileSync(join(OUT, `${shot.name}.png`),
      Buffer.from(shot.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
  }
  const g = result.geometry ?? {};
  // Closed-form because the camera is on axis: this is what the analyzer needs to talk about radii.
  const pxPerMetreAt = (z: number) => (g.width / 2) / (z * Math.tan((g.fov / 2) * Math.PI / 180) * (g.width / g.height));
  const halfWidthPx = g.halfWidthM * pxPerMetreAt(g.puffZ);
  writeFileSync(join(OUT, 'geometry.json'), JSON.stringify({
    ...g, renderer: result.renderer, material: result.material,
    centreX: g.width / 2, centreY: g.height / 2, puffHalfWidthPx: halfWidthPx, transfer: 'srgb',
  }, null, 2));

  console.log(`Slopesmith fog rendered by ${result.renderer}`);
  console.log(`  material: ${JSON.stringify(result.material)}`);
  console.log(`  wrote ${(result.shots ?? []).length} frames to ${OUT}`);
  console.log(`  puff half-width on screen: ${halfWidthPx.toFixed(1)} px, centre (${g.width / 2}, ${g.height / 2})`);
  console.log('\nnow: python ../Trailmap/tools/autotest/fog_meter.py map \\');
  console.log(`  "${join(OUT, 's-dark-fog.png')}" "${join(OUT, 's-light-fog.png')}" \\`);
  console.log(`  "${join(OUT, 's-dark-clear.png')}" "${join(OUT, 's-light-clear.png')}" \\`);
  console.log(`  --transfer srgb --centre ${g.width / 2},${g.height / 2},${halfWidthPx.toFixed(1)}`);
} finally {
  await browser?.close();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(work, { recursive: true, force: true });
}
