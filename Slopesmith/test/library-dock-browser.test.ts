// tier: integration
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { assetVersion } from '../src/core/reference/asset-version';

// Mount the real libraries and their handles without the terrain renderer or a server workspace.
const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    contents: `
      import { TextureLibrary } from '../src/app/paint/library';
      import { PropLibrary } from '../src/app/props/library';
      import { DockTab } from '../src/app/ui/components/dock-tab';
      let active = 0;
      const tabs = [];
      const sync = () => {
        tabs.forEach((tab, i) => tab.setVisible(i === active));
        document.body.dataset.libraryHeight = String(libraries[active].el.offsetHeight);
      };
      const texture = new TextureLibrary({ onBrush() {}, onHeightChange: sync, onClose: () => texture.hide() });
      const prop = new PropLibrary({
        levels: async () => ['TEST'], groups: async () => [], onPick() {}, onPickGroup() {},
        loadLevel: async level => ({ level, models: [], instances: [], materials: new Map(), crowdFrames: [] }),
        onHeightChange: sync, onClose: () => prop.hide(),
      });
      const libraries = [texture, prop];
      for (const [i, label] of ['Texture Library', 'Prop Library'].entries()) {
        tabs.push(new DockTab({ id: 'tab-' + i, label, icon: '', tip: 'Open library', panel: libraries[i].el,
          onToggle: open => { if (open) libraries[i].show(); else libraries[i].hide(); sync(); } }));
      }
      await Promise.all(libraries.map(library => library.init('TEST')));
      window.showLibrary = i => {
        libraries[active].hide(); active = i; libraries[active].show(); sync();
      };
      window.showLibrary(0);
    `,
  },
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
const css = ['base', 'dock', 'responsive']
  .map(name => readFileSync(new URL(`../src/app/styles/${name}.css`, import.meta.url), 'utf8'))
  .join('\n');
const temp = fileURLToPath(new URL('../temp/', import.meta.url));
mkdirSync(temp, { recursive: true });
const screenshots = mkdtempSync(resolve(temp, 'library-dock-'));
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://library.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/levels') return route.fulfill({ json: { levels: ['TEST'] } });
    if (url.pathname === '/api/map-asset-version')
      return route.fulfill({ json: assetVersion('unknown', 'TEST', 'a'.repeat(64)) });
    if (url.pathname === '/api/textures') {
      const level = url.searchParams.get('level');
      return route.fulfill({
        json: level
          ? {
              level,
              tiles: level === 'Custom' ? [] : Array.from({ length: 500 }, (_, i) => ({ name: `${i}.png`, count: 1 })),
            }
          : { levels: ['TEST'] },
      });
    }
    if (url.pathname === '/api/texture')
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#668795"/><path d="M0 48 23 19 40 36 52 12 64 48Z" fill="#d2e4e8"/></svg>',
      });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 204 });
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>${css}#dock-right>div{height:100%;background:#263a4c}</style><div id="dock-right"><div>Tools</div></div>`,
    });
  });
  await page.goto('http://library.test/');
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
  await page.locator('.sp-tile').first().waitFor();
  for (const [i, label, id] of [
    [0, 'Texture Library', 'texture-library'],
    [1, 'Prop Library', 'prop-library'],
  ] as const) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(index => (window as any).showLibrary(index), i);
    const panel = page.locator(`#${id}`);
    const size = panel.locator('.sp-library-size');
    assert.equal(await size.getAttribute('aria-label'), `Expand ${label}`);
    let box = (await panel.boundingBox())!;
    const tools = (await page.locator('#dock-right').boundingBox())!;
    assert.equal(box.height, 250);
    assert.equal(box.x + box.width, tools.x - 8, 'Wide libraries leave a gap before the toolbox');
    await size.click();
    assert.equal(await size.getAttribute('aria-expanded'), 'true');
    box = (await panel.boundingBox())!;
    assert.equal(box.height, 750, 'Expand fills three quarters of the viewport');
    await page.screenshot({ path: resolve(screenshots, `${id}-wide.png`) });
    await page.waitForFunction(index => {
      const tab = document.getElementById(`tab-${index}`)!.getBoundingClientRect();
      const library = document.querySelector('.sp-library-dock[style*="flex"]')!.getBoundingClientRect();
      return Math.abs(tab.bottom - library.top) < 1;
    }, i);
    if (i === 0) {
      const body = panel.locator('.sp-body');
      assert(await body.evaluate(el => el.scrollHeight > el.clientHeight), 'The expanded grid still scrolls');
      await body.evaluate(el => (el.scrollTop = el.scrollHeight));
      assert(await body.evaluate(el => el.scrollTop > 0));
    }

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 932, height: 430 },
    ]) {
      await page.setViewportSize(viewport);
      box = (await panel.boundingBox())!;
      assert.equal(box.x, 0);
      assert.equal(box.width, viewport.width, 'Compact screens use the entire width');
      assert.equal(box.height, viewport.height * 0.75);
      await page.waitForFunction(() => {
        const library = document.querySelector<HTMLElement>('.sp-library-dock[style*="flex"]')!;
        return document.body.dataset.libraryHeight === String(library.offsetHeight);
      });
      assert(await size.isVisible(), 'Expand/shrink stays visible before the scrollable header controls');
      const above = await panel.evaluate(el => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.right - 5, box.top + 10));
      });
      assert(above, 'The library receives clicks above the overlapping right toolbox');
      await page.screenshot({ path: resolve(screenshots, `${id}-${viewport.width}.png`) });
      const tab = page.locator(`#tab-${i}`);
      await tab.click();
      assert(!(await panel.isVisible()));
      await tab.click();
      assert.equal(
        (await panel.boundingBox())!.height,
        viewport.height * 0.75,
        'Reopening remembers the expanded size',
      );
    }
    await size.click();
    assert.equal(await size.getAttribute('aria-expanded'), 'false');
    assert.equal((await panel.boundingBox())!.height, 250);
    await page.setViewportSize({ width: 1440, height: 1000 });
    box = (await panel.boundingBox())!;
    assert.equal(box.x + box.width, tools.x - 8, 'Resizing back restores the space beside the toolbox');

    // The existing wrist palette keeps its fixed footprint even when the desktop library was expanded.
    await size.click();
    await page.evaluate(() => document.body.classList.add('os-xr-editing'));
    box = (await panel.boundingBox())!;
    assert.equal(box.width, 480);
    assert.equal(box.height, 400);
    await page.evaluate(() => document.body.classList.remove('os-xr-editing'));
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Both libraries expand, shrink, scroll, remember size, clear wide toolboxes and overlay compact toolboxes; XR footprint preserved',
  );
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
}
