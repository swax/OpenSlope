/** Parallel terrain/props requests, visible load phases, cache reuse and superseded reference loads. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { defaultMountain } from '../src/core/doc/mountain';

const temp = join(process.cwd(), 'temp');
mkdirSync(temp, { recursive: true });
const root = mkdtempSync(join(temp, 'reference-loading-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
mkdirSync(process.env.SLOPESMITH_MAPS_ROOT);
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const terrain = JSON.stringify({
  patches: [
    {
      SurfaceType: 1,
      Points: Array.from({ length: 16 }, (_, index) => [(index % 4) * 1000, Math.floor(index / 4) * 1000, 0]),
    },
  ],
});
const packed = (array: Float32Array | Uint32Array) => Buffer.from(array.buffer).toString('base64');
function props(level: string) {
  return JSON.stringify({
    level,
    models: [
      {
        id: 0,
        name: 'Tree',
        subs: [
          {
            mat: -1,
            pos: packed(new Float32Array([0, 0, 0, 100, 0, 0, 0, 0, 100])),
            uv: packed(new Float32Array([0, 0, 1, 0, 0, 1])),
            idx: packed(new Uint32Array([0, 1, 2])),
          },
        ],
      },
    ],
    materials: [],
    instances: [
      {
        i: 0,
        m: 0,
        p: [0, 0, 0],
        q: [0, 0, 0, 1],
        s: [1, 1, 1],
        n: 'Tree',
        v: true,
        pc: false,
        pb: false,
        c: 0,
      },
    ],
    padding: 'x'.repeat(4096),
  });
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const fixtures = new Map(
  ['LOAD_ONE', 'LOAD_OLD', 'LOAD_NEW'].map(level => [
    level,
    {
      terrain: signal(),
      props: signal(),
      terrainResponse: undefined as ServerResponse | undefined,
      propsResponse: undefined as ServerResponse | undefined,
      terrainRequests: 0,
      propRequests: 0,
      bytes: Buffer.from(props(level)),
    },
  ]),
);
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  plugins: [
    {
      name: 'reference-loading-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? '', 'http://localhost');
          const fixture = fixtures.get(url.searchParams.get('level') ?? url.searchParams.get('name') ?? '');
          if (!fixture) return next();
          if (url.pathname === '/api/level') {
            fixture.terrainRequests++;
            res.setHeader('content-type', 'application/json');
            if (fixture.terrainRequests > 1) res.end(terrain);
            else {
              fixture.terrainResponse = res;
              fixture.terrain.resolve();
            }
          } else if (url.pathname === '/api/props') {
            fixture.propRequests++;
            res.setHeader('content-type', 'application/json');
            res.setHeader('content-length', fixture.bytes.byteLength);
            fixture.propsResponse = res;
            fixture.props.resolve();
          } else next();
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Browser | undefined, page: Page | undefined;
const errors: string[] = [];
const watchdog = setTimeout(() => {
  console.error(`Reference loading test timed out: ${root}`);
  process.exit(1);
}, 90_000);
type TestWindow = Window & {
  slop: { state: { level: string }; load(): Promise<void>; data: { mesh: { patchCount: number } | null } };
  referenceLoad: Promise<void>;
  loadLabels: string[];
};
async function choose(level: string) {
  await page!.evaluate(name => {
    const test = window as unknown as TestWindow;
    test.slop.state.level = name;
    test.referenceLoad = test.slop.load();
  }, level);
}
async function requested(level: string) {
  const fixture = fixtures.get(level)!;
  await Promise.all([fixture.terrain.promise, fixture.props.promise]);
  assert(!fixture.terrainResponse!.writableEnded, 'props starts before terrain finishes');
  return fixture;
}
async function ready() {
  await page!.evaluate(() => (window as unknown as TestWindow).referenceLoad);
  await page!.locator('#load-status').waitFor({ state: 'hidden' });
}
try {
  const created = await fetch(`${api.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: defaultMountain() }),
  });
  assert(created.ok);
  const { project } = (await created.json()) as { project: { id: string } };
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/editor?project=${project.id}`);
  await page.waitForFunction(() => !!(window as unknown as TestWindow).slop);
  await page.locator('#load-status').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    const test = window as unknown as TestWindow;
    test.loadLabels = [];
    new MutationObserver(() => test.loadLabels.push(document.querySelector('#load-label')!.textContent!)).observe(
      document.querySelector('#load-label')!,
      { childList: true },
    );
  });

  await choose('LOAD_ONE');
  const first = await requested('LOAD_ONE');
  first.terrainResponse!.end(terrain);
  await page.waitForFunction(
    () => document.querySelector('#load-label')?.textContent === 'Downloading reference props',
  );
  assert.equal(
    await page.evaluate(() => (window as unknown as TestWindow).slop.data.mesh?.patchCount),
    1,
    'terrain is installed before the unfinished props download blocks loading',
  );
  first.propsResponse!.write(first.bytes.subarray(0, 2048));
  await page.waitForFunction(() => document.querySelector('#load-detail')?.textContent?.includes('received'));
  assert.match(await page.locator('#load-detail').innerText(), /2 KB \/ .* KB received/);
  await page.screenshot({ path: join(root, 'download-progress.png') });
  first.propsResponse!.end(first.bytes.subarray(2048));
  await ready();
  const labels = await page.evaluate(() => (window as unknown as TestWindow).loadLabels);
  for (const label of [
    'Downloading reference props',
    'Decoding reference props',
    'Preparing reference prop models',
    'Building reference props',
  ])
    assert(labels.includes(label), `visible phase: ${label}`);
  await page.screenshot({ path: join(root, 'loaded.png') });

  await choose('LOAD_ONE');
  await ready();
  assert.equal(first.propRequests, 1, 'reloading a reference reuses decoded model data');

  await choose('LOAD_OLD');
  const old = await requested('LOAD_OLD');
  old.terrainResponse!.end(terrain);
  await page.waitForFunction(
    () => document.querySelector('#load-label')?.textContent === 'Downloading reference props',
  );
  await choose('LOAD_NEW');
  const next = await requested('LOAD_NEW');
  next.terrainResponse!.end(terrain);
  await page.waitForFunction(
    () =>
      document.querySelector('#load-title')?.textContent === 'Loading LOAD_NEW' &&
      document.querySelector('#load-label')?.textContent === 'Downloading reference props',
  );
  old.propsResponse!.end(old.bytes);
  await page.waitForFunction(async () => {
    const url = '/src/app/net/diagnostics.ts';
    const { diagnosticsSnapshot } = await import(/* @vite-ignore */ url);
    return diagnosticsSnapshot().phases.some(
      (phase: { name: string; status: string }) => phase.name === 'LOAD_OLD:load-total' && phase.status === 'ok',
    );
  });
  assert.equal(await page.locator('#load-title').innerText(), 'Loading LOAD_NEW');
  assert.equal(
    await page.locator('#load-label').innerText(),
    'Downloading reference props',
    'a superseded download cannot overwrite the current progress or start a stale scene build',
  );
  next.propsResponse!.end(next.bytes);
  await ready();
  assert.deepEqual(errors, []);
  console.log(`REFERENCE LOADING BROWSER TESTS PASSED (${root})`);
} finally {
  clearTimeout(watchdog);
  for (const fixture of fixtures.values()) {
    fixture.terrainResponse?.end();
    fixture.propsResponse?.end();
  }
  await browser?.close();
  await vite.close();
  await api.close();
}
