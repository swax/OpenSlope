// tier: integration
// browser: smoke
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { encodePng } from '../src/server/routes/png';

const bundle = await build({
  entryPoints: ['test/browser-platform.fixture.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
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
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const png = Array.from(encodePng({ w: 1, h: 1, data: new Uint8Array([255, 0, 0, 255]) }));
  let id: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.waitForFunction(() => (window as any).browserPlatform);
    const result = await page.evaluate(png => (window as any).browserPlatform(png), png);
    if (id) assert.equal(result.id, id, 'a real page reload reopens the same project');
    id = result.id;
    assert.equal(result.name, 'EDITED');
    assert.deepEqual(result.bytes, png, 'archive and IndexedDB retain original PNG bytes');
    assert.deepEqual(result.pixel, [255, 0, 0, 255], 'real browser image decode and canvas pixels');
    assert(result.filename.endsWith('.slopesmith.zip'));
    if (!attempt) await page.reload();
  }
  assert.deepEqual(errors, []);
  console.log('PASS real IndexedDB save/reload, editable archive round trip, Blob URLs and PNG pixels');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
