import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** Serialized into the production worker. Open pages keep their release until they navigate or reload. */
function offlineWorker(cacheName, paths) {
  const scope = globalThis;
  const prefix = 'slopesmith-app-';
  const metadata = () => scope.caches.open('slopesmith-offline-clients-v1');
  const key = name => new URL(`/__slopesmith-offline/${name}`, scope.location.origin).href;
  const clientKey = id => key(`client/${id}`);
  const releaseKey = name => key(`release/${name}`);
  let activated = Promise.resolve();
  async function ready() {
    const worker = scope.registration.active;
    // Chromium can deliver controllerchange messages before dispatching this worker's activate event.
    if (worker?.state === 'activating')
      await new Promise(resolve => worker.addEventListener('statechange', resolve, { once: true }));
    await activated;
  }
  async function prune() {
    const state = await metadata();
    const clients = await scope.clients.matchAll({ type: 'all', includeUncontrolled: true });
    const live = new Set(clients.map(client => clientKey(client.id)));
    const keep = new Set([cacheName]);
    for (const client of clients) {
      const binding = await state.match(clientKey(client.id));
      if (binding) keep.add(await binding.text());
    }
    for (const name of await scope.caches.keys()) {
      // An installing worker's cache has no release record yet; never remove a download in progress.
      if (name.startsWith(prefix) && !keep.has(name) && (await state.match(releaseKey(name)))) {
        await scope.caches.delete(name);
        await state.delete(releaseKey(name));
      }
    }
    for (const request of await state.keys()) {
      if (request.url.startsWith(key('client/')) && !live.has(request.url)) await state.delete(request);
    }
  }
  scope.addEventListener('install', event => {
    event.waitUntil(
      (async () => {
        try {
          const cache = await scope.caches.open(cacheName);
          await cache.addAll(paths.map(path => new Request(path, { cache: 'reload' })));
          await scope.skipWaiting();
        } catch (error) {
          await scope.caches.delete(cacheName);
          throw error;
        }
      })(),
    );
  });
  scope.addEventListener('activate', event => {
    activated = (async () => {
      const state = await metadata();
      const names = (await scope.caches.keys()).filter(name => name.startsWith(prefix));
      const active = await state.match(key('active'));
      const activeName = active ? await active.text() : null;
      const tracked = activeName && names.includes(activeName);
      // Legacy activation removed older caches: its first cache is active, later ones are waiting updates.
      const previous = tracked ? activeName : names.find(name => name !== cacheName);
      if (!tracked && !scope.registration.installing) {
        for (const name of names.filter(name => name !== cacheName)) {
          if (await (await scope.caches.open(name)).match('/index.html'))
            await state.put(releaseKey(name), new Response('active'));
        }
      }
      if (previous && names.includes(previous)) await state.put(releaseKey(previous), new Response('active'));
      for (const client of await scope.clients.matchAll({ type: 'all', includeUncontrolled: true })) {
        const binding = await state.match(clientKey(client.id));
        if (!binding || !names.includes(await binding.text()))
          await state.put(clientKey(client.id), new Response(previous ?? cacheName));
      }
      await state.put(releaseKey(cacheName), new Response('active'));
      await state.put(key('active'), new Response(cacheName));
      await scope.clients.claim();
      await prune();
    })();
    event.waitUntil(activated);
  });
  scope.addEventListener('message', event => {
    const client = event.source;
    const release = event.data?.cacheName;
    if (event.data?.type !== 'slopesmith-client-release' || !client?.id || typeof release !== 'string') return;
    event.waitUntil(
      (async () => {
        await ready();
        const state = await metadata();
        if (release.startsWith(prefix) && (await state.match(releaseKey(release)))) {
          await state.put(clientKey(client.id), new Response(release));
          await prune();
        }
        client.postMessage({ type: 'slopesmith-release-active', cacheName });
      })(),
    );
  });
  async function navigate(event) {
    try {
      await ready();
      const state = await metadata();
      if (event.resultingClientId) await state.put(clientKey(event.resultingClientId), new Response(cacheName));
      const cached = await (await scope.caches.open(cacheName)).match('/index.html');
      if (cached) return cached;
    } catch {
      // A cache read failure should still allow a network recovery attempt.
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      // Retry one transient rejection; both network attempts share the same deadline.
      for (let attempt = 0; attempt < 2 && !controller.signal.aborted; attempt++) {
        try {
          const response = await fetch(event.request, { cache: 'reload', signal: controller.signal });
          const html = await response.clone().text();
          const release = /<meta name="slopesmith-app-cache" content="(slopesmith-app-[a-f0-9]{24})">/.exec(html)?.[1];
          // The server may be newer than this worker. Never give its page this worker's stable WASM/assets.
          if (release && event.resultingClientId) {
            const state = await metadata();
            await state.put(clientKey(event.resultingClientId), new Response(release));
          }
          if (response.ok && release === cacheName) {
            const copy = response.clone();
            event.waitUntil(
              scope.caches
                .open(cacheName)
                .then(cache => cache.put('/index.html', copy))
                .catch(() => {}),
            );
          }
          return response;
        } catch {
          // A navigation must resolve to a Response even if both cache and network are unavailable.
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slopesmith</title></head><body><main><h1>Slopesmith couldn’t load</h1><p>Check your connection and try again.</p><a href="">Try again</a></main></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
    );
  }
  scope.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== scope.location.origin || url.pathname.startsWith('/api/')) return;
    const navigation =
      request.mode === 'navigate' && /^\/(?:$|maps\/?$|isos\/?$|(?:editor|play)(?:\/|$))/.test(url.pathname);
    if (navigation) {
      event.respondWith(navigate(event));
      return;
    }
    event.respondWith(
      (async () => {
        await ready();
        const state = await metadata();
        let release = cacheName;
        if (event.clientId) {
          const binding = await state.match(clientKey(event.clientId));
          if (binding) release = await binding.text();
        }
        // Dedicated workers (including the ISO importer) inherit their owner's release too.
        if (event.resultingClientId) await state.put(clientKey(event.resultingClientId), new Response(release));
        // Only build-time static files are stored. Even stable WASM URLs stay bound to the page's release.
        const cache = await scope.caches.open(release);
        return (await cache.match(url.pathname)) ?? fetch(request);
      })(),
    );
  });
}

/** Build after Vite has written chunks, workers and public files, so lazy imports are offline too. */
export function offlinePlugin() {
  return {
    name: 'slopesmith-offline',
    apply: 'build',
    async writeBundle(options) {
      await writeOfflineWorker(resolve(options.dir ?? 'dist'));
    },
  };
}

/** Shared by the production build and the isolated multi-release browser regression. */
export async function writeOfflineWorker(directory) {
  const files = [];
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(folder, entry.name), `${name}/`);
      else if (name !== 'sw.js' && !name.endsWith('.map')) files.push(name);
    }
  }
  await walk(directory);
  files.sort();
  const index = join(directory, 'index.html');
  const html = (await readFile(index, 'utf8')).replace(/<meta name="slopesmith-app-cache"[^>]*>/g, '');
  const hash = createHash('sha256').update(offlineWorker.toString());
  for (const file of files)
    hash.update(file).update(file === 'index.html' ? html : await readFile(join(directory, file)));
  const cache = `slopesmith-app-${hash.digest('hex').slice(0, 24)}`;
  await writeFile(index, html.replace('</head>', `<meta name="slopesmith-app-cache" content="${cache}"></head>`));
  await writeFile(
    join(directory, 'sw.js'),
    `(${offlineWorker.toString()})(${JSON.stringify(cache)},${JSON.stringify(files.map(file => `/${file}`))});\n`,
  );
}
