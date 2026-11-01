// tier: integration
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import type {} from './missing-assets-browser.fixture';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-missing-assets-'));
const vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let release!: () => void;
const held = new Promise<void>(resolve => {
  release = resolve;
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/missing-fixture', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
    <style>body{background:#16202c;color:#d7e3f0;font:12px system-ui;display:flex;gap:16px;padding:16px}
    #texture{width:280px}#prop{width:220px}#swatch{width:80px;height:80px;background-size:cover}</style>
    <div><div id="scene"></div><div id="swatch"></div></div><div id="prop"></div><div id="texture"></div>
    <script type="module" src="/test/missing-assets-browser.fixture.ts"></script>`,
    }),
  );
  await page.route('**/api/**', async route => {
    await held;
    return route.fulfill({ status: 404, json: { error: 'Fixture asset unavailable' } });
  });
  await page.goto(`${vite.resolvedUrls!.local[0]}missing-fixture`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.missingAssets);
  let snapshot = await page.evaluate(() => window.missingAssets.snapshot());
  assert.equal(snapshot.state, 'loading');
  assert.equal(snapshot.color, 0x9fb3c8, 'pending props stay neutral');
  assert(snapshot.texturePending && !snapshot.propMissingTexture, 'pending textures have no error marker');
  await page.screenshot({ path: join(root, 'loading-neutral.png') });
  release();
  await page.waitForFunction(
    () =>
      window.missingAssets.snapshot().state === 'missing' &&
      window.missingAssets.snapshot().missingTexture &&
      window.missingAssets.snapshot().propMissingTexture,
  );
  snapshot = await page.evaluate(() => window.missingAssets.snapshot());
  assert.equal(snapshot.color, 0xff00ff);
  assert(snapshot.pickable && snapshot.propIndex === 0, 'the error box retains its placement pick identity');
  assert.equal(snapshot.colliderCount, 0, 'an error marker is never fake collision geometry');
  assert(snapshot.unchanged, 'render markers never rewrite the placement reference');
  assert.deepEqual(snapshot.first, [25, 0, 25, 255]);
  assert.deepEqual(snapshot.second, [255, 0, 255, 255]);
  await page.evaluate(() => window.missingAssets.select());
  assert.equal((await page.evaluate(() => window.missingAssets.snapshot())).gizmo, 'prop');
  const propInfo = page.locator('.pp-card .sp-asset-source-info');
  const textureInfo = page.locator('.sc-prev .sp-asset-source-info');
  await propInfo.locator('summary').click();
  await textureInfo.locator('summary').click();
  await propInfo.locator('[data-detail="missing reference"]').filter({ hasText: 'MODEL/model/7' }).waitFor();
  await textureInfo.locator('[data-detail="status"]').filter({ hasText: 'Missing texture' }).waitFor();
  assert.match(await textureInfo.locator('[data-detail="filepath"]').innerText(), /TEXTURES\/lost.png/);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>('.sc-pframe img') === null &&
      document.getElementById('swatch')!.style.backgroundImage.startsWith('url("data:image/png'),
  );
  await page.screenshot({ path: join(root, 'missing-pink.png') });
  assert(
    await page.evaluate(() => window.missingAssets.drawTexture()),
    'the real WebGL terrain material renders the checkerboard',
  );
  await page.evaluate(() => window.missingAssets.recover());
  await page.waitForFunction(
    () => window.missingAssets.snapshot().state === 'ready' && window.missingAssets.snapshot().color === undefined,
  );
  assert.equal(await propInfo.locator('[data-detail="missing reference"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    `Missing assets: neutral pending loads, pink textures, pickable pink props, source references and recovery PASS. ${root}`,
  );
} finally {
  release();
  await browser.close();
  await vite.close();
}
