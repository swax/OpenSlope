// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./gem-asset-placement.fixture.ts', import.meta.url))],
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
      : '<!doctype html><div id="toast"></div><script type="module" src="/fixture.js"></script>',
  );
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.getByRole('button', { name: 'Add gem', exact: true }).click();
  const propSettings = page.getByRole('button', { name: 'Prop settings', exact: true });
  assert(await propSettings.isDisabled());
  await page.getByRole('button', { name: 'Drop gem', exact: true }).click();
  await page.waitForFunction(() => (window as any).gemPlacement.state().document.props?.length === 1);
  assert(await propSettings.isEnabled());
  await propSettings.click();
  let state = await page.evaluate(() => (window as any).gemPlacement.state());
  assert.equal(state.advanced, `prop:${state.document.props[0].id}`);
  assert.match(state.document.props[0].level, /^asset2:.*:prop:203:/);
  await page.getByRole('button', { name: 'Add gem', exact: true }).click();
  await page.getByRole('button', { name: 'Drop gem', exact: true }).click();
  await page.waitForFunction(() => (window as any).gemPlacement.state().document.props?.length === 2);
  await page.getByRole('button', { name: 'Effects', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).gemPlacement.state().opened), 'effects');
  await page.evaluate(() => (window as any).gemPlacement.armRail('ALASKA/rail.png'));
  state = await page.evaluate(() => (window as any).gemPlacement.state());
  assert.match(state.document.rails.at(-1).texture, /^asset2:.*:texture:rail.png:/);
  await page.evaluate(() => (window as any).gemPlacement.armRail('Custom/my-rail.png'));
  state = await page.evaluate(() => (window as any).gemPlacement.state());
  assert.equal(state.document.rails.at(-1).texture, 'Custom/my-rail.png');
  const before = JSON.stringify(state.document);
  await page.evaluate(() => (window as any).gemPlacement.armRail('ALASKA/missing.png'));
  assert.equal(JSON.stringify(await page.evaluate(() => (window as any).gemPlacement.state().document)), before);
  assert.deepEqual(errors, []);
  console.log(
    'Gem/rail browser placement: asset2 art, Prop settings/Effects navigation, custom textures and missing-art isolation PASS',
  );
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}
