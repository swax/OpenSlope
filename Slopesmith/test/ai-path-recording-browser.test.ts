// tier: integration
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./ai-path-recording.fixture.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1040, height: 1000 } });
  const errors: string[] = [];
  const styles = ['base', 'dock', 'toolbar']
    .map(name => readFileSync(new URL(`../src/app/styles/${name}.css`, import.meta.url), 'utf8'))
    .join('\n');
  async function mount(target: Page) {
    target.on('pageerror', error => errors.push(error.message));
    await target.route('http://ai-recording.test/**', route =>
      route.fulfill(
        new URL(route.request().url()).pathname.startsWith('/api/')
          ? {
              contentType: 'application/json',
              body: '{}',
            }
          : {
              contentType: 'text/html',
              body: `<!doctype html><style>${styles}\nbody{margin:0;background:#101820}.lil-gui.lil-root{width:100%}</style>`,
            },
      ),
    );
    await target.goto('http://ai-recording.test/');
    await target.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
    await target
      .waitForFunction(() => (window as any).aiRecording, undefined, { timeout: 15000 })
      .catch(() => assert.fail(errors.join('\n')));
  }
  await mount(page);
  const state = () => page.evaluate(() => (window as any).aiRecording.state());
  const section = (name: string) =>
    page.locator('#test-tools .sp-edit-section').filter({
      has: page.locator(':scope > .lil-title', { hasText: name }),
    });
  assert(await section('Sound settings').getByText('Game volume', { exact: true }).count());
  assert(await section('Sound settings').getByText('Music', { exact: true }).count());
  assert(await section('Sound settings').getByText('Announcer', { exact: true }).count());
  assert(await section('AI settings').getByText('Show AI paths', { exact: true }).count());
  assert(await section('AI settings').getByText('AI riders', { exact: true }).count());
  assert.equal(await section('Tuning').getByText('Show AI paths', { exact: true }).count(), 0);
  await section('AI settings').getByRole('button', { name: '● Record AI run', exact: true }).click();
  assert((await state()).recording && (await state()).riding, 'Recording launches the run with capture active');
  assert.equal((await state()).buttons, 0, 'There is no separate recording button in the ride HUD');
  await page.evaluate(() => (window as any).aiRecording.runTo(350));
  assert.match(await page.locator('[data-ai-recording]').innerText(), /Recording AI run.*3\d\d m.*Esc/);
  assert((await state()).preview > 0, 'A visible trail grows during recording');
  await page.keyboard.press('Escape');
  const saved = await state();
  assert(!saved.riding && !saved.recording, 'One Escape stops and saves the recording run');
  assert(
    saved.paths.length >= 2 && saved.canUndo,
    JSON.stringify({
      paths: saved.paths.map((p: any) => ({ points: p.points.length, first: p.points[0], last: p.points.at(-1) })),
      canUndo: saved.canUndo,
      errors,
    }),
  );
  assert(saved.paths.some((path: any) => path.events.some((event: any) => event.type === 100)));
  assert.equal(saved.preview, 0);
  assert.equal(
    await page.getByText('Recorded AI path 1', { exact: true }).count(),
    0,
    'Paths are picked in the viewport rather than listed',
  );
  await page.evaluate(() => (window as any).aiRecording.undo());
  assert.equal((await state()).paths.length, 0);
  await page.evaluate(() => (window as any).aiRecording.redo());
  assert.equal((await state()).paths.length, saved.paths.length);
  await page.evaluate(() => (window as any).aiRecording.reload());
  assert.deepEqual((await state()).paths, saved.paths);
  await page.evaluate(() => (window as any).aiRecording.selectPath());
  assert.deepEqual((await state()).selectedPaths, [0], 'Generated routes do not shift recorded-path selection');
  await page.evaluate(() => (window as any).aiRecording.frameOverview());
  mkdirSync(new URL('../../temp', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../../temp/ai-path-recording.png', import.meta.url)) });
  await page.getByRole('button', { name: '● Record AI run', exact: true }).click();
  await page.evaluate(() => (window as any).aiRecording.runTo(50));
  await page.locator('canvas').click();
  await page.keyboard.press('v');
  await page.waitForFunction(() => !!document.pointerLockElement);
  await page.keyboard.press('Escape');
  assert(!(await state()).riding, 'First Escape also saves and exits a captured first-person recording');
  assert((await state()).paths.length > saved.paths.length);
  await page.evaluate(() => (window as any).aiRecording.setTarget('reference'));
  assert(await page.getByRole('button', { name: '● Record AI run', exact: true }).isDisabled());
  await page.evaluate(() => (window as any).aiRecording.start(false, true));
  assert(!(await state()).recording, 'Reference/public sessions cannot capture authored paths');
  await page.evaluate(() => (window as any).aiRecording.stop());
  const mobile = await browser.newPage({ viewport: { width: 844, height: 500 }, hasTouch: true, isMobile: true });
  await mount(mobile);
  await mobile.evaluate(() => {
    const container = document.querySelector('canvas')!.parentElement!;
    container.style.width = '100vw';
    container.style.height = '100dvh';
    document.querySelector<HTMLElement>('#dock-right')!.style.display = 'none';
    window.dispatchEvent(new Event('resize'));
  });
  await mobile.getByRole('button', { name: '● Record AI run', exact: true }).tap();
  await mobile.evaluate(() => (window as any).aiRecording.runTo(80));
  assert((await mobile.evaluate(() => (window as any).aiRecording.state())).recording);
  assert.equal(await mobile.locator('.os-ai-record').count(), 0);
  await mobile.screenshot({ path: fileURLToPath(new URL('../../temp/ai-path-recording-touch.png', import.meta.url)) });
  await mobile.getByRole('button', { name: 'Stop ride', exact: true }).tap();
  assert((await mobile.evaluate(() => (window as any).aiRecording.state())).paths.length > 0);
  await mobile.evaluate(() => (window as any).aiRecording.stop());
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Test Sound/AI sections, recording launch, Escape/captured cursor, live preview, persistence, reference exclusion and touch Stop',
  );
} finally {
  await browser.close();
}
