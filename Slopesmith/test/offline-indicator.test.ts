/** Exercise browser network events and socket-only outages independently, including a fresh reconnect. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, type Browser, type WebSocketRoute } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const member = { id: 'fixture', username: 'Fixture', role: 'viewer', anonymous: true };
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'connection-fixture',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          if (path === '/connection-fixture') {
            res.setHeader('content-type', 'text/html');
            res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="public-play"><script type="module">
            import '/src/app/public/home.css';
            import { publicHeader } from '/src/app/public/header.ts';
            const account = new URL(location.href).searchParams.has('offline') ? { accounts: 'open', offline: true } : { accounts: 'required' };
            document.body.append(publicHeader('maps', account).header);
          </script></body></html>`);
            return;
          }
          if (!path?.startsWith('/api/')) {
            next();
            return;
          }
          res.setHeader('content-type', 'application/json');
          if (path === '/api/play/config') {
            res.end(JSON.stringify({ enabled: true, socketPath: '/api/play/session', ticketPath: '/api/play/ticket' }));
          } else if (path === '/api/public/visitor') {
            res.end(JSON.stringify({ member }));
          } else if (path === '/api/play/ticket')
            res.end(JSON.stringify({ ticket: 'fixture', expiresAt: Date.now() + 60_000 }));
          else {
            res.statusCode = 503;
            res.end('{}');
          }
        });
      },
    },
  ],
});
let browser: Browser | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const sockets = new Set<WebSocketRoute>();
  let accept = true;
  let presence = true;
  let welcomes = 0;
  const snapshot = () => JSON.stringify({ t: 'site-presence', online: 3, courses: {}, members: [] });
  await context.routeWebSocket('**/api/play/session', socket => {
    if (!accept) {
      socket.close({ code: 1012, reason: 'Fixture outage' });
      return;
    }
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage(data => {
      const message = JSON.parse(String(data));
      if (message.t !== 'hello') return;
      welcomes++;
      socket.send(
        JSON.stringify({
          t: 'welcome',
          protocol: 1,
          sessionId: `fixture-${welcomes}`,
          member,
          color: '#ffffff',
          serverTime: Date.now(),
          courseId: '@site',
          roomId: 'site',
          publishMs: 100,
        }),
      );
      if (presence) socket.send(snapshot());
    });
  });
  const page = await context.newPage();
  let navigations = 0;
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations++;
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${vite.resolvedUrls!.local[0]}connection-fixture`);
  const counter = page.locator('.public-online');
  const label = counter.locator('.public-online-label');
  const count = counter.locator('.public-online-number');
  const dot = counter.locator('.public-online-dot');
  await page.getByRole('button', { name: 'Online users', exact: true }).waitFor();
  await page.locator('.public-online[data-count="3"]').waitFor();
  const onlineDotColor = await dot.evaluate(el => getComputedStyle(el).backgroundColor);

  // Chrome may keep a localhost socket reachable; its offline event must still clear the live badge.
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Offline — users and chat', exact: true }).waitFor();
  assert.equal(await label.innerText(), 'Offline');
  assert(await label.isVisible(), 'Offline remains readable on desktop');
  assert(await count.isHidden(), 'disconnection removes the stale player count');
  await page.setViewportSize({ width: 320, height: 700 });
  assert(await label.isHidden(), 'the narrow header uses its compact connection indicator');
  assert(await page.getByRole('button', { name: 'Offline — users and chat', exact: true }).isVisible());
  assert(await page.locator('.public-users-icon').isVisible());
  assert(await dot.isVisible(), 'connection status remains visible on narrow screens');
  assert.notEqual(
    await dot.evaluate(el => getComputedStyle(el).backgroundColor),
    onlineDotColor,
    'the mobile status dot distinguishes an outage from a live connection',
  );
  await page.setViewportSize({ width: 1280, height: 900 });

  // Network availability alone must not revive the previous player count.
  presence = false;
  const previousWelcomes = welcomes;
  await context.setOffline(false);
  async function waitForWelcome(previous: number) {
    const deadline = Date.now() + 10_000;
    while (welcomes <= previous && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert(welcomes > previous);
  }
  await waitForWelcome(previousWelcomes);
  assert.equal(await label.innerText(), 'Offline');
  for (const socket of sockets) socket.send(snapshot());
  await page.getByRole('button', { name: 'Online users', exact: true }).waitFor();
  await page.locator('.public-online[data-count="3"]').waitFor();

  // A service/socket outage can occur while Chrome still reports a working network.
  assert(await page.evaluate(() => navigator.onLine));
  accept = false;
  for (const socket of sockets) socket.close({ code: 1012, reason: 'Fixture outage' });
  await page.getByRole('button', { name: 'Offline — users and chat', exact: true }).waitFor();
  assert(await count.isHidden());
  accept = presence = true;
  await page.getByRole('button', { name: 'Online users', exact: true }).waitFor();
  await page.locator('.public-online[data-count="3"]').waitFor();

  assert.equal(navigations, 1, 'network and socket reconnects retain the original page');
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    'OFFLINE INDICATOR PASS: native browser network events, socket reconnect, player count visibility and responsive outage styling.',
  );
} finally {
  await browser?.close();
  await vite.close();
}
