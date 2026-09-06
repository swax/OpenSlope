import { defineConfig, loadEnv, type Plugin } from 'vite';
import { dependencyNoticesPlugin } from './tools/dependency-notices.mjs';

/** Where the `/api/*` service listens. `src/server/main.ts` reads the same variable, so moving the port moves
 * both halves of `npm run dev` together. */
const API_PORT = Number(process.env.PORT ?? 5180);

/** Extra DNS Host headers the dev server and API will answer to, comma-separated and empty by default:
 * `SLOPESMITH_ALLOWED_HOSTS=.ngrok-free.app,.ngrok.io npm run dev`. A leading dot matches a domain and all
 * its subdomains, which is what a tunnel needs when its free hostname changes every run. This is left to
 * the operator rather than shipped: Vite's host check is what stops a page on another origin from driving
 * this server, the API applies the same list independently, and one machine's tunnelling habit is no reason
 * for every clone to accept those names. */
/** Correlated API timing in the dev-server terminal. The browser records the same request id, which makes it
 * possible to separate time before Node receives a request from server work, body transfer/JSON parsing, and
 * the scene phase that consumes it. A two-second heartbeat also exposes a handler that is still running. */
function requestLogEndpoint(): Plugin {
  return {
    name: 'slopesmith-request-log',
    configureServer(server) {
      let sequence = 0;
      server.middlewares.use((req, res, next) => {
        const url = req.originalUrl ?? req.url ?? '/';
        if (!url.startsWith('/api/')) { next(); return; }
        const id = `api-${String(++sequence).padStart(5, '0')}`;
        const started = performance.now();
        let logged = false;
        res.setHeader('x-slopesmith-request-id', id);
        const slowTimer = setTimeout(() => {
          server.config.logger.warn(`[api] ${id} ${req.method ?? 'GET'} ${url} still running after 2.0s`, {
            timestamp: true,
          });
        }, 2000);
        slowTimer.unref();
        const finish = (aborted = false) => {
          if (logged) return;
          logged = true;
          clearTimeout(slowTimer);
          const elapsed = performance.now() - started;
          const rawLength = res.getHeader('content-length');
          const bytes = typeof rawLength === 'number' ? rawLength
            : typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
          const size = bytes === null ? '' : bytes >= 1024 * 1024
            ? ` ${(bytes / 1024 / 1024).toFixed(2)}MiB`
            : ` ${(bytes / 1024).toFixed(1)}KiB`;
          const cache = res.getHeader('x-slopesmith-cache');
          const suffix = `${res.statusCode} ${elapsed.toFixed(1)}ms${size}`
            + (cache ? ` cache=${String(cache)}` : '') + (aborted ? ' aborted' : '');
          const message = `[api] ${id} ${req.method ?? 'GET'} ${url} -> ${suffix}`;
          if (elapsed >= 1000 || aborted || res.statusCode >= 500) server.config.logger.warn(message, { timestamp: true });
          else server.config.logger.info(message, { timestamp: true });
        };
        res.once('finish', () => finish());
        res.once('close', () => { if (!res.writableFinished) finish(true); });
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'SLOPESMITH_');
  const allowedHosts = (process.env.SLOPESMITH_ALLOWED_HOSTS ?? env.SLOPESMITH_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    plugins: [requestLogEndpoint(), dependencyNoticesPlugin(process.cwd())],
    // Loopback only: the API this proxies to is unauthenticated, so reaching the editor from a phone on the
    // same Wi-Fi is a deliberate act — `npm run dev -- --host` binds the LAN address on both halves and then
    // http://<desktop-ip>:5179 works (the terminal prints the Network: URL on start).
    // allowedHosts: set SLOPESMITH_ALLOWED_HOSTS to tunnel the editor to a phone — see the constant above.
    // proxy: `/api` belongs to the standalone service, which outlives the restarts and hot updates this server
    // performs on itself. `ws: true` carries a WebSocket upgrade on the same path through to it.
    server: {
      port: 5179,
      allowedHosts,
      proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, ws: true } },
    },
  };
});
