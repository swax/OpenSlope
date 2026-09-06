// tier: fast

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk, fetchForTest, removeTestTree } from './http-test-support';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-restart-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;

const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
const { forgetAccounts } = await import('../src/server/accounts/store');
forgetWorkspaceConfig();
forgetAccounts();

const { startApiService } = await import('../src/server/main');

let service: Awaited<ReturnType<typeof startApiService>> | undefined;
const api = (path: string): string => `${service!.url}${path}`;

try {
  service = await startApiService({ port: 0, host: '127.0.0.1' });
  const unsupported = await (await expectOk(fetchForTest(api('/api/restart')),
    'reading unsupervised restart status')).json() as { available?: boolean; reason?: string };
  check(unsupported.available === false && /not managed/.test(unsupported.reason ?? ''),
    'an embedded service refuses to promise a restart when its host supplied no return path');
  check((await fetchForTest(api('/api/restart'), { method: 'POST' })).status === 503,
    'and the restart action stays unavailable instead of stopping that service permanently');
  await service.close();

  let requested = 0;
  service = await startApiService({
    port: 0,
    host: '127.0.0.1',
    restart: () => { requested++; },
  });
  const supported = await (await expectOk(fetchForTest(api('/api/restart')),
    'reading managed restart status')).json() as { available?: boolean; instance?: string };
  check(supported.available === true && /^[0-9a-f-]{36}$/.test(supported.instance ?? ''),
    'a restart-capable host exposes an opaque service instance for browser recovery');

  const accepted = await (await expectOk(fetchForTest(api('/api/restart'), { method: 'POST' }),
    'requesting restart')).json() as { restarting?: boolean; instance?: string };
  check(accepted.restarting === true && accepted.instance === supported.instance,
    'the accepted action tells the browser which service instance is going away');
  check((await fetchForTest(api('/api/restart'), { method: 'POST' })).status === 409,
    'a second click cannot schedule another restart while the first is pending');
  await new Promise(resolve => setTimeout(resolve, 900));
  check(requested === 1, 'the host callback runs once, after the accepted response has flushed');

  await service.close();
  service = await startApiService({ port: service.port, host: '127.0.0.1', restart: () => { requested++; } });
  const returned = await (await expectOk(fetchForTest(api('/api/restart')),
    'reading reconstructed service status')).json() as { instance?: string };
  check(Boolean(returned.instance) && returned.instance !== supported.instance,
    'reconstructing startup state changes the instance marker the waiting browser polls');
} finally {
  if (service) await service.close();
  removeTestTree(root);
}

if (failures) process.exitCode = 1;
