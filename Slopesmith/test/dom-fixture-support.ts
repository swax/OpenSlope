import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

/** Load an actual UI module with the same raw-text imports as Vite, without an HTTP server or Chromium. */
export async function loadDomFixture(entry: URL) {
  const empty = 'data:text/javascript,export%20default%20%22%22';
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.endsWith('.css') || specifier === 'virtual:slopesmith-dependency-notices')
        return { url: empty, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.endsWith('?raw')) {
        const file = new URL(url);
        file.search = '';
        return {
          format: 'module',
          shortCircuit: true,
          source: `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`,
        };
      }
      return next(url, context);
    },
  });
  try {
    await import(entry.href);
    return async () => hooks.deregister();
  } catch (error) {
    hooks.deregister();
    throw error;
  }
}
