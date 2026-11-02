import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { encodePng } from '../src/server/routes/png';

const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  plugins: [
    {
      name: 'cache-fixture',
      configureServer(server) {
        server.middlewares.use('/cache-fixture', (_req, res) => {
          res.setHeader('content-type', 'text/html');
          res.end('<!doctype html><html><body></body></html>');
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0 },
});
await vite.listen();
const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = value => value');
  await page.goto(`${origin}/cache-fixture`);
  const urls = await page.evaluate(async () => {
    const moduleUrl = '/src/app/net/asset-cache.ts';
    const { browserAssetCache } = await import(/* @vite-ignore */ moduleUrl);
    const cache = browserAssetCache(async () => 'large-mountain-test');
    const level = `asset1:ssx-tricky:TRICKY_GARI:${'a'.repeat(64)}`;
    const urls = Array.from({ length: 320 }, (_, i) => {
      const url = new URL('/api/texture', location.origin);
      url.searchParams.set('level', level);
      url.searchParams.set('name', `${i}.png`);
      return url.href;
    });
    await Promise.all(urls.map((url, i) => cache.put(url, new Response(`tile ${i}`), 8)));
    return urls;
  });
  await page.reload();
  let networkReads = 0;
  await page.route('**/api/**', route => {
    networkReads++;
    return route.abort();
  });
  const tiles = await page.evaluate(async urls => {
    const moduleUrl = '/src/app/net/workspace.ts';
    const { configureWorkspace, workspaceFetch } = await import(/* @vite-ignore */ moduleUrl);
    configureWorkspace(false, async () => null, 'large-mountain-test');
    return Promise.all(
      urls.map(async url => {
        const response = await workspaceFetch(url);
        return { status: response.status, text: await response.text() };
      }),
    );
  }, urls);
  assert.deepEqual(
    tiles,
    urls.map((_, i) => ({ status: 200, text: `tile ${i}` })),
  );
  assert.equal(networkReads, 0, 'a full page reload reuses all 320 cached assets without contacting the server');
  console.log('Reference browser cache: all 320 assets survive reload with zero network requests PASS');
  await page.unroute('**/api/**');
  const imageRequests: string[] = [];
  const png = encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) });
  await page.route('**/api/texture?**', route => {
    imageRequests.push(new URL(route.request().url()).searchParams.get('level')!);
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  const crowd = await page.evaluate(async imageBytes => {
    const cacheUrl = '/src/app/net/asset-cache.ts',
      workspaceUrl = '/src/app/net/workspace.ts';
    const loaderUrl = '/src/app/props/level-loader.ts',
      texturesUrl = '/src/app/props/textures.ts';
    const { browserAssetCache } = await import(/* @vite-ignore */ cacheUrl);
    const { configureWorkspace } = await import(/* @vite-ignore */ workspaceUrl);
    const { createPropLevelLoader } = await import(/* @vite-ignore */ loaderUrl);
    const { PropTextureCache } = await import(/* @vite-ignore */ texturesUrl);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(imageBytes)))]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const propId = `asset2:ssx-tricky:TRICKY_MERQUER:prop:48:${'a'.repeat(64)}`;
    const frames = Array.from({ length: 16 }, (_, i) => `cd${String(i).padStart(2, '0')}.png`);
    const ids = frames.map(name => `asset2:ssx-tricky:TRICKY_MERQUER:texture:${name}:${hash}`);
    const manifest = {
      schema: 'openslope-assets/v1',
      game: 'ssx-tricky',
      map: 'TRICKY_MERQUER',
      assets: [
        { id: propId, kind: 'prop', key: '48', files: {} },
        ...ids.map((id, i) => ({ id, kind: 'texture', key: frames[i], files: { [`textures/${frames[i]}`]: hash } })),
      ],
    };
    configureWorkspace(
      false,
      async (url: URL) => {
        if (url.pathname === '/api/levels')
          return Response.json({
            levels: ['server:MERQUER'],
            maps: [{ name: 'server:MERQUER', course: 'TRICKY_MERQUER' }],
          });
        if (url.pathname === '/api/map-asset-manifest')
          return url.searchParams.get('mapSource') === 'local'
            ? new Response('', { status: 404 })
            : Response.json(manifest);
        if (url.pathname === '/api/props') throw new Error('The old prop payload must come from persistent storage.');
        return null;
      },
      'crowd-cache-test',
    );
    const url = new URL('/api/props', location.origin);
    url.searchParams.set('level', propId);
    const text = JSON.stringify({ level: propId, models: [], materials: [], instances: [], crowdFrames: frames });
    await browserAssetCache(async () => 'crowd-cache-test').put(url.href, new Response(text), text.length);
    let resolved: string[] = [];
    const loader = createPropLevelLoader({
      levels: new Map(),
      url: () => url.href,
      register: (props: { crowdFrames: string[] }) => {
        resolved = props.crowdFrames;
      },
    });
    await loader.ensure(propId);
    const textures = new PropTextureCache();
    const loaded = resolved.map(frame => textures.texture(propId, frame));
    const deadline = performance.now() + 15000;
    while (loaded.some(texture => !texture.image) && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    return {
      ids,
      resolved,
      loaded: loaded.filter(texture => texture.image?.width === 1 && !texture.userData.missingAsset).length,
    };
  }, Array.from(png));
  assert.deepEqual(crowd.resolved, crowd.ids, 'cached old prop payloads acquire independent crowd texture identities');
  assert.equal(crowd.loaded, 16, 'all sixteen crowd frames load through the real prop texture loader');
  assert.deepEqual(
    [...imageRequests].sort(),
    [...crowd.ids].sort(),
    'crowd frame requests never use the incomplete prop identity',
  );
  console.log('Crowd browser cache: old saved payload, all 16 frames, independent texture requests PASS');
} finally {
  await browser.close();
  await vite.close();
}
