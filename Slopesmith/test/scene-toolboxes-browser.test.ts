// tier: integration
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./scene-toolboxes.fixture.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
  plugins: [
    {
      name: 'vite-text-imports',
      setup(plugin) {
        plugin.onResolve({ filter: /\?raw$/ }, args => ({
          path: resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: 'raw',
        }));
        plugin.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({
          contents: readFileSync(args.path, 'utf8'),
          loader: 'text',
        }));
        plugin.onResolve({ filter: /^virtual:slopesmith-dependency-notices$/ }, args => ({
          path: args.path,
          namespace: 'notices',
        }));
        plugin.onLoad({ filter: /.*/, namespace: 'notices' }, () => ({ contents: 'export default "";' }));
      },
    },
  ],
});
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const css = ['base', 'dock', 'toolbar']
    .map(name => readFileSync(new URL(`../src/app/styles/${name}.css`, import.meta.url), 'utf8'))
    .join('\n');
  await page.route('http://scene.test/**', route =>
    route.fulfill(
      new URL(route.request().url()).pathname.startsWith('/api/')
        ? { contentType: 'application/json', body: '{"songs":[]}' }
        : { contentType: 'text/html', body: `<!doctype html><style>${css}body{margin:0;background:#152331}</style>` },
    ),
  );
  await page.goto('http://scene.test/');
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => (window as any).sceneToolboxes);
  const category = (name: string) => page.locator('.sp-scene-categories .sp-out-row').filter({ hasText: name });
  const targets = page.getByRole('group', { name: 'Scene toolbox mountain' });
  const choose = (target: string) => targets.getByRole('button', { name: target, exact: true }).click();
  const beforeSwitch = async (selector: string) => {
    const control = await page.locator(selector).boundingBox();
    const split = await targets.boundingBox();
    assert(control && split && control.y + control.height <= split.y, `${selector} precedes the target switch`);
  };
  assert(await category('Reference: Garibaldi').count());
  assert(!(await targets.isVisible()), 'The reference picker does not show the detail switch');
  for (const [name, common] of [
    ['Course', 'Overlays'],
    ['AI Paths', 'Display'],
    ['Sound', 'Shared sound'],
    ['Lighting', 'Preview'],
    ['Skybox', 'Preview'],
    ['God Rays', 'Preview'],
    ['Camera', 'View'],
  ]) {
    await page.locator('.sp-scene-categories .sp-out-row').filter({ hasText: name }).click();
    await beforeSwitch(`.sp-scene-card:visible:has(> .lil-title:text-is("${common}"))`);
    await choose('Reference');
    await beforeSwitch(`.sp-scene-card:visible:has(> .lil-title:text-is("${common}"))`);
  }
  mkdirSync(new URL('../../temp', import.meta.url), { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(880, 1080);
  await page.screenshot({ path: fileURLToPath(new URL('../../temp/scene-toolboxes.png', import.meta.url)) });
  assert.deepEqual(errors, []);
  console.log('PASS: real Scene toolbox layout keeps shared controls above all seven Mountain/Reference switches');
} finally {
  await browser.close();
}
