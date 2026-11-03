// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { encodePng } from '../src/server/routes/png';

const [fixture, worker] = await Promise.all([
  build({
    entryPoints: ['test/terrain-lighting-cache-browser.fixture.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  }),
  build({
    entryPoints: ['src/app/viewport/mesh/lighting-worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  }),
]);
const maskPng = encodePng({
  w: 4,
  h: 4,
  data: Uint8Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? (Math.floor(i / 4) % 4 < 2 ? 255 : 0) : 80)),
});
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/texture')) {
    res.setHeader('content-type', 'image/png');
    res.end(maskPng);
    return;
  }
  const script = req.url === '/fixture.js' ? fixture : req.url === '/worker.js' ? worker : undefined;
  res.setHeader('content-type', script ? 'text/javascript' : 'text/html');
  res.end(script ? script.outputFiles[0].text : '<!doctype html><script type="module" src="/fixture.js"></script>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.waitForFunction(() => !!window.checkTerrainLighting);
  const cold = await page.evaluate(() => window.checkTerrainLighting());
  assert.equal(cold.workers, 1, 'cold load computes all three lighting buffers in one worker');
  assert(cold.heartbeat > 0, 'the browser event loop remains responsive during worker preparation');
  await page.reload();
  await page.waitForFunction(() => !!window.checkTerrainLighting);
  const warm = await page.evaluate(() => window.checkTerrainLighting());
  assert.equal(warm.workers, 0, 'a full reload restores lighting from IndexedDB without starting a worker');
  await page.evaluate(() => window.checkLightingEviction());
  const updates = await page.evaluate(() => window.checkBatchedPropLighting());
  assert(updates.heartbeat > 0, 'the browser stays responsive while updating real prop shadows');
  assert.equal(updates.updates, 2);
  const masked = await page.evaluate(() => window.checkMaskedPropLighting());
  assert.equal(masked.workers, 1);
  assert(masked.heartbeat > 0);
  assert.deepEqual(errors, []);
  console.log(
    `TERRAIN LIGHTING BROWSER PASS: exact cold/warm output, responsive worker, reload reuse and bounded LRU (${cold.elapsed.toFixed(1)}ms cold; ${warm.elapsed.toFixed(1)}ms warm)`,
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
