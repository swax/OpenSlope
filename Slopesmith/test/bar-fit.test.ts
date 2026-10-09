// tier: integration
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

/**
 * The fitted top bar (src/app/ui/chrome/bar-fit.ts) in a real browser, against the editor's own bar stylesheets:
 * a window narrowed step by step gives up a prefix of the ladder and never more than it needs, a folded panel
 * lists its groups in bar order whatever order they folded in, widening restores the bar exactly, content the bar
 * gains later is fitted too, nothing folds while the headset's wrist palette mirrors the bar, and the panels keep
 * or close on a press as asked.
 */

const source = `
import { group, label } from './src/app/ui/components/controls';
import { barFold, fitBar } from './src/app/ui/chrome/bar-fit';
const bar = document.getElementById('dock-top');
const named = (name, width) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.style.cssText = 'width:' + width + 'px;flex:none;box-sizing:border-box';
  const g = group(b);
  g.dataset.name = name;
  return g;
};
const caption = group(label('View'));
caption.dataset.name = 'caption';
const [a, b, c, m] = [named('A', 100), named('B', 100), named('C', 100), named('M', 60)];
const more = barFold({ label: 'More', icon: '…', heading: 'View' });
const pick = barFold({ label: 'Pick', icon: '▾', heading: 'Mode', closeOnPick: true });
more.el.dataset.name = 'more';
pick.el.dataset.name = 'pick';
bar.append(pick.el, m, caption, a, b, c, more.el);
fitBar(bar, [
  { compact: 'sp-fit-captions' },
  { fold: c, into: more }, { fold: a, into: more }, { fold: b, into: more },
  { fold: m, into: pick },
]);
const names = el => [...el.children].filter(child => child.dataset.name && !child.hidden
  && getComputedStyle(child).display !== 'none').map(child => child.dataset.name);
window.barState = () => ({
  classes: [...bar.classList].filter(cls => cls.startsWith('sp-fit-')),
  bar: names(bar),
  more: names(more.list),
  pick: names(pick.list),
  overflow: bar.scrollWidth > bar.clientWidth,
});
window.frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
window.ready = true;
`;

const root = fileURLToPath(new URL('..', import.meta.url));
const css = ['base', 'dock', 'toolbar', 'menus']
  .map(name => readFileSync(new URL(`../src/app/styles/${name}.css`, import.meta.url), 'utf8')).join('\n');
const bundle = await build({ stdin: { contents: source, resolveDir: root, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].text
    : `<!doctype html><style>${css}</style><div id="dock-top"></div><script type="module" src="/fixture.js"></script>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

interface BarState { classes: string[]; bar: string[]; more: string[]; pick: string[]; overflow: boolean }
type FixtureWindow = Window & { ready?: boolean; barState(): BarState; frames(): Promise<void> };

const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.waitForFunction(() => (window as unknown as FixtureWindow).ready);
  const state = async (width?: number) => {
    if (width !== undefined) await page.setViewportSize({ width, height: 300 });
    await page.evaluate(() => (window as unknown as FixtureWindow).frames());
    return page.evaluate(() => (window as unknown as FixtureWindow).barState());
  };
  // How far down the ladder a state is, asserting it is a prefix: nothing given up before a cheaper loss.
  const ladder: ((s: BarState) => boolean)[] = [
    s => s.classes.includes('sp-fit-captions'),
    s => s.more.includes('C'), s => s.more.includes('A'), s => s.more.includes('B'), s => s.pick.includes('M'),
  ];
  const given = (s: BarState) => {
    const taken = ladder.map(step => step(s));
    const count = taken.indexOf(false) < 0 ? taken.length : taken.indexOf(false);
    assert.deepEqual(taken, taken.map((_, i) => i < count), `the ladder is taken in order: ${JSON.stringify(s)}`);
    return count;
  };

  const whole = await state();
  assert.deepEqual(whole, { classes: [], bar: ['M', 'caption', 'A', 'B', 'C'], more: [], pick: [], overflow: false },
    'a wide window shows the whole bar, its fold triggers hidden');

  let last = 0;
  const seen = new Map<string, BarState>();
  for (let width = 900; width >= 40; width -= 10) {
    const s = await state(width);
    const count = given(s);
    assert(count >= last, `narrowing never gives back what a wider bar gave up (at ${width}px)`);
    if (count < ladder.length) assert(!s.overflow, `the bar fits once it stops giving things up (at ${width}px)`);
    seen.set(s.more.join(','), s);
    last = count;
  }
  assert.equal(last, ladder.length, 'the narrowest window takes the whole ladder');
  assert(seen.has('C'), 'a width exists where only the first group is folded');
  assert(seen.has('A,C'), 'the panel lists folded groups in bar order, not in the order they folded');
  assert.deepEqual(seen.get('A,B,C')!.bar.filter(name => name === 'more'), ['more'], 'the trigger shows while it holds groups');

  assert.deepEqual(await state(900), whole, 'widening restores the bar exactly, in its own order');

  // Content the bar gains later (the account menu arrives after the bar is built) is fitted too.
  const roomy = await state(420);
  assert.equal(given(roomy), 1, 'at 420px only the caption goes');
  await page.evaluate(() => {
    const extra = document.createElement('div');
    extra.className = 'sp-group';
    extra.style.cssText = 'width:120px;flex:none';
    document.getElementById('dock-top')!.append(extra);
  });
  const crowded = await state();
  assert(given(crowded) > 1 && !crowded.overflow, `a group appended later folds the bar further: ${JSON.stringify(crowded)}`);

  // While the headset's wrist palette mirrors the bar, nothing folds; words still compact.
  await page.evaluate(() => document.body.classList.add('os-xr-editing'));
  const xr = await state(200);
  assert.deepEqual([xr.more, xr.pick, xr.classes], [[], [], ['sp-fit-captions']],
    'the wrist palette keeps every group in the bar');
  await page.evaluate(() => document.body.classList.remove('os-xr-editing'));
  assert(given(await state()) > 1, 'folding resumes when the palette closes');

  // A View panel stays open across presses; a choice panel closes on one; a click outside closes either.
  await state(150);
  const open = () => page.evaluate(() => !!document.querySelector('.sp-panel-pop'));
  await page.click('button[aria-label="More"]');
  assert(await open(), 'the trigger opens its panel');
  await page.click('.sp-panel-pop button:text-is("A")');
  assert(await open(), 'a toggle pressed inside the panel leaves it open');
  await page.mouse.click(5, 250);
  assert(!(await open()), 'a click outside closes it');
  await state(60);
  await page.click('button[aria-label="Pick"]');
  assert(await open(), 'the choice trigger opens its panel');
  await page.click('.sp-panel-pop button:text-is("M")');
  assert(!(await open()), 'picking from a choice panel closes it');

  assert.deepEqual(errors, []);
  console.log('BAR FIT BROWSER TEST PASSED');
} finally { await browser.close(); server.close(); }
