// browser: smoke
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: ['src/app/net/diagnostics.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const server = createServer((req, res) => {
  if (req.url === '/diagnostics.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(bundle.outputFiles[0].contents);
  } else {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body></body></html>');
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true, timeout: 30_000 });
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = value => value');
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const burst = await page.evaluate(async () => {
    const moduleUrl = '/diagnostics.js';
    const { beginRequestDiagnostic, beginDiagnosticPhase, clearDiagnostics, diagnosticsSnapshot } = await import(
      /* @vite-ignore */ moduleUrl
    );
    clearDiagnostics();
    const nativeSetItem = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'slopesmith:diagnostics:v1') writes++;
      nativeSetItem.call(this, key, value);
    };
    const response = new Response('{}', { headers: { 'x-slopesmith-request-id': 'browser-test' } });
    for (let i = 0; i < 100; i++) {
      const request = beginRequestDiagnostic(`/burst/${i}`);
      request.headers(response);
      request.complete();
    }
    // These updates happen as navigation starts, so the normal checkpoint timer cannot be relied on.
    window.addEventListener('beforeunload', () => {
      beginRequestDiagnostic('/pending-at-reload').headers(response);
      beginDiagnosticPhase('terrain', 'pending-at-reload');
    });
    return { writes, requests: diagnosticsSnapshot().requests.length };
  });
  assert.deepEqual(burst, { writes: 0, requests: 100 }, 'real browser keeps a request burst in memory');

  await page.reload();
  const recovered = await page.evaluate(async () => {
    const moduleUrl = '/diagnostics.js';
    const { diagnosticsSnapshot } = await import(/* @vite-ignore */ moduleUrl);
    return diagnosticsSnapshot();
  });
  assert.equal(recovered.requests.length, 101, 'a real reload retains the completed request burst');
  assert.equal(recovered.requests[0].status, 'ok');
  assert.equal(recovered.requests.at(-1)?.url, '/pending-at-reload');
  assert.equal(recovered.requests.at(-1)?.status, 'pending', 'reload retains an unfinished request');
  assert.equal(recovered.requests.at(-1)?.serverId, 'browser-test');
  assert.equal(recovered.phases.at(-1)?.name, 'pending-at-reload');
  assert.equal(recovered.phases.at(-1)?.status, 'pending', 'reload retains an unfinished client phase');
  console.log('DIAGNOSTICS BROWSER PASS: batched updates and pending records survive a real reload');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}
