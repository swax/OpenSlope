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
  const state = () => page.evaluate(() => (window as any).sceneToolboxes.state());
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
    assert.equal((await state()).target, 'authored');
    await beforeSwitch(`.sp-scene-card:visible:has(> .lil-title:text-is("${common}"))`);
    await choose('Reference');
    const ref = await state();
    assert.equal(ref.target, 'reference');
    if (name !== 'AI Paths') assert(ref.cards.includes('Reference: Garibaldi'));
    if (name === 'Skybox' || name === 'God Rays') assert.equal(ref.skyTarget, 'reference');
    await beforeSwitch(`.sp-scene-card:visible:has(> .lil-title:text-is("${common}"))`);
    if (name === 'Camera') {
      assert.equal(await page.getByRole('spinbutton', { name: 'Camera position X', exact: true }).inputValue(), '100');
      await choose('Mountain');
      assert.equal(await page.getByRole('spinbutton', { name: 'Camera position X', exact: true }).inputValue(), '10');
      await choose('Reference');
      assert.equal(await page.getByRole('combobox', { name: 'Camera coordinates' }).count(), 0);
      await page.getByRole('spinbutton', { name: 'Camera position X', exact: true }).fill('125');
      await choose('Mountain');
      assert.equal(await page.getByRole('spinbutton', { name: 'Camera position X', exact: true }).inputValue(), '35');
      await choose('Reference');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      assert.equal((await state()).view.pos[0], 125, 'Changing coordinate frames preserves the pending camera edit');
    }
  }
  await page.locator('.sp-scene-categories .sp-out-row').filter({ hasText: 'Lighting' }).click();
  assert.equal((await state()).target, 'reference', 'Each section remembers its side');
  await page.evaluate(() => (window as any).sceneToolboxes.selectKnot());
  assert((await state()).cards.includes('Knot 0'));
  await choose('Reference');
  assert(!(await state()).cards.includes('Knot 0'), 'Mountain knot controls are hidden on Reference');
  await page.evaluate(() => (window as any).sceneToolboxes.selectPath());
  assert.equal((await state()).category, 'aiPaths');
  assert.equal((await state()).target, 'reference');
  await page.locator('.sp-scene-categories .sp-out-row').filter({ hasText: 'Sound' }).click();
  assert(await page.locator('.sp-scene-card:visible').getByText('Rider sound', { exact: true }).count());
  await page.evaluate(() => (window as any).sceneToolboxes.reference(''));
  assert(await category('Reference: None').count());
  await page.locator('.sp-scene-categories .sp-out-row').filter({ hasText: 'Camera' }).click();
  assert(await page.getByRole('spinbutton', { name: 'Camera position X', exact: true }).isDisabled());
  await page.evaluate(() => (window as any).sceneToolboxes.reference('Snowdream'));
  assert(await category('Reference: Snowdream').count());
  assert(!(await page.getByRole('spinbutton', { name: 'Camera position X', exact: true }).isDisabled()));
  mkdirSync(new URL('../../temp', import.meta.url), { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(880, 1080);
  await page.screenshot({ path: fileURLToPath(new URL('../../temp/scene-toolboxes.png', import.meta.url)) });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Scene reference labels, shared controls, seven Mountain/Reference switches, selection routing, sky preview and camera coordinates',
  );
} finally {
  await browser.close();
}
