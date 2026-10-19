import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** Serialized into the production worker. Only this release's static files belong in its cache. */
function offlineWorker(cacheName, paths) {
  const scope = globalThis;
  const assets = new Set(paths);
  scope.addEventListener('install', event => {
    event.waitUntil(
      (async () => {
        try {
          const cache = await scope.caches.open(cacheName);
          await cache.addAll(paths.map(path => new Request(path, { cache: 'reload' })));
        } catch (error) {
          await scope.caches.delete(cacheName);
          throw error;
        }
      })(),
    );
    // Updates wait for all old tabs to close. Never replace the code beneath an unsaved editor.
  });
  scope.addEventListener('activate', event => {
    event.waitUntil(
      (async () => {
        await Promise.all(
          (await scope.caches.keys())
            .filter(key => key.startsWith('slopesmith-app-') && key !== cacheName)
            .map(key => scope.caches.delete(key)),
        );
        await scope.clients.claim();
      })(),
    );
  });
  scope.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== scope.location.origin || url.pathname.startsWith('/api/')) return;
    const navigation =
      request.mode === 'navigate' && /^\/(?:$|maps\/?$|isos\/?$|(?:editor|play)(?:\/|$))/.test(url.pathname);
    const path = navigation ? '/index.html' : url.pathname;
    if (!navigation && !assets.has(path)) return;
    // Match revision queries only for the static allowlist. API data and user assets are never cached.
    event.respondWith(
      (async () => {
        const cache = await scope.caches.open(cacheName);
        return (await cache.match(path)) ?? fetch(request);
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
      const directory = resolve(options.dir ?? 'dist');
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
      const hash = createHash('sha256').update(offlineWorker.toString());
      for (const file of files) hash.update(file).update(await readFile(join(directory, file)));
      const cache = `slopesmith-app-${hash.digest('hex').slice(0, 24)}`;
      await writeFile(
        join(directory, 'sw.js'),
        `(${offlineWorker.toString()})(${JSON.stringify(cache)},${JSON.stringify(files.map(file => `/${file}`))});\n`,
      );
    },
  };
}
