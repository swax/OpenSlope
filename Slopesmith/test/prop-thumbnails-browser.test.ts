// tier: integration
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { assetVersion } from '../src/core/reference/asset-version';
import type {} from './prop-thumbnails-browser.fixture';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-prop-thumbnails-'));
const vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const version = assetVersion('unknown', 'TEST', 'a'.repeat(64));
async function ready(page: Page, count = 4) {
  await page.waitForFunction(
    count => document.querySelectorAll('.pl-thumb[data-state="ready"]').length === count,
    count,
  );
}
async function visiblePixels(page: Page) {
  return page
    .locator('.pl-thumb')
    .first()
    .evaluate(async element => {
      let canvas = element.querySelector('canvas');
      if (!canvas) {
        const image = new Image();
        image.src = element.style.backgroundImage.slice(5, -2);
        await image.decode();
        canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext('2d')!.drawImage(image, 0, 0);
      }
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visible++;
      return visible;
    });
}
try {
  for (const exportMode of ['normal', 'throws', 'undefined', 'empty', 'invalid'] as const) {
    const blockExport = exportMode !== 'normal';
    const context = await browser.newContext({ viewport: { width: 850, height: 500 } });
    const page = await context.newPage();
    const errors: string[] = [];
    const thumbnailWarnings: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.text().startsWith('Prop thumbnail failed')) thumbnailWarnings.push(message.text());
    });
    await page.route('**/thumbnail-fixture', route =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><body style="background:#16202c"><script type="module" src="/test/prop-thumbnails-browser.fixture.ts"></script>',
      }),
    );
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/levels') return route.fulfill({ json: { levels: ['TEST'] } });
      if (url.pathname === '/api/map-asset-version') return route.fulfill({ json: version });
      if (url.pathname === '/api/texture' && url.searchParams.get('name') === 'crate.png')
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#c58c43"/><path d="M0 0 32 32M32 0 0 32" stroke="#663d16" stroke-width="4"/></svg>',
        });
      return route.fulfill({ status: 404, json: { error: 'Missing fixture texture' } });
    });
    if (blockExport)
      await page.addInitScript(mode => {
        HTMLCanvasElement.prototype.toDataURL = function () {
          if (mode === 'throws') throw new DOMException('Canvas image export is blocked', 'SecurityError');
          if (mode === 'undefined') return undefined as unknown as string;
          return mode === 'empty' ? '' : 'data:,';
        };
      }, exportMode);
    await page.goto(`${vite.resolvedUrls!.local[0]}thumbnail-fixture`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.querySelectorAll('.pl-thumb[data-state="ready"], .pl-thumb[data-state="error"]').length === 4,
    );
    assert.deepEqual(thumbnailWarnings, [], `${exportMode} export does not fail thumbnail display`);
    await ready(page);
    assert((await visiblePixels(page)) > 500, 'the thumbnail contains visible model pixels');
    assert.equal(await page.locator('.pl-thumb canvas').count(), blockExport ? 4 : 0);
    await page.screenshot({ path: join(root, `${exportMode}.png`) });

    // Rerendering the grid must copy cached fallback canvases rather than move them or lose their pixels.
    await page.getByRole('button', { name: 'Misc', exact: true }).click();
    await ready(page);
    assert((await visiblePixels(page)) > 500, 'cached snapshots retain their pixels');
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await ready(page, 1);
    assert((await visiblePixels(page)) > 500, 'assembly thumbnails support the same export fallback');
    await page.getByRole('button', { name: 'Misc', exact: true }).click();
    await ready(page);

    // An individual WebGL/render failure must not poison the queue or prevent picking the model.
    await page.evaluate(() => window.propThumbnails.refresh(true));
    await page.locator('.pl-tile[data-model="0"] .pl-thumb[data-state="error"]').waitFor();
    await ready(page, 3);
    await page.locator('.pl-tile[data-model="0"]').click();
    assert.deepEqual(await page.evaluate(() => window.propThumbnails.picked), [0]);
    await page.evaluate(() => window.propThumbnails.refresh());
    await ready(page);
    assert((await visiblePixels(page)) > 500, 'a failed queue can run again');

    if (!blockExport) {
      await page.evaluate(() => window.propThumbnails.loseContext());
      await page.waitForFunction(() => document.querySelectorAll('.pl-thumb[data-state="error"]').length === 4);
      await page.evaluate(() => window.propThumbnails.restoreContext());
      await ready(page);
      assert((await visiblePixels(page)) > 500, 'context restoration retries previews instead of caching blank PNGs');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    `PROP THUMBNAILS PASS: textured/missing models, blocked/invalid exports, cached copies, groups, queue and context recovery. ${root}`,
  );
} finally {
  await browser.close();
  await vite.close();
}
