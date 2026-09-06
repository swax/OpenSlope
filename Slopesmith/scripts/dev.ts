import { createServer } from 'vite';
import { adminCodeBanner } from '../src/server/accounts/bootstrap';
import { parseApiArgs, startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';

/**
 * `npm run dev`: the API service and the Vite dev server, side by side in one terminal.
 *
 * The two are separate servers on purpose. Vite restarts itself whenever its config changes and re-evaluates
 * modules on every hot update, so anything the API holds across requests — the response cache, the maps watch,
 * and in time a socket, a write lease and a presence table — would be reset at moments nobody chose. Here the
 * API object is held in this script's scope, where a Vite restart cannot reach it. Vite forwards `/api` to it.
 *
 * Both halves bind loopback unless `--host` is passed. A network bind must also use `--accounts`; the explicit
 * `--unsafe-open-network` escape hatch is only for a trusted, isolated network.
 */
const options = parseApiArgs(process.argv.slice(2));
// Vite quietly steps to the next free port; the API cannot, because the config's proxy has to name it.
let api: Awaited<ReturnType<typeof startApiService>>;
let restarting = false;
const restart = async () => {
  if (restarting) return;
  restarting = true;
  console.log('[api] restart requested; closing sessions and rebuilding startup state');
  try {
    await api.close();
    // A process restart naturally drops this module cache. Development stays in-process, so discard it
    // explicitly before startup resolves the workspace and maps roots again.
    forgetWorkspaceConfig();
    api = await startApiService({ ...options, restart });
    console.log(`[api] restarted at ${api.url}/api/`);
  } finally {
    restarting = false;
  }
};
api = await startApiService({ ...options, restart }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error('The API port is already in use — another Slopesmith is running. Stop it, or set PORT.');
  return process.exit(1);
});
// The config reads PORT for its proxy target, so the port the service actually took is the one Vite forwards to.
process.env.PORT = String(api.port);
// A restart must reclaim the same listener Vite is about to proxy. This also makes an explicit --port 0
// deterministic after the operating system chooses the initial free port.
options.port = api.port;

const vite = await createServer(options.host ? { server: { host: options.host } } : {});
await vite.listen();

console.log('');
vite.printUrls();
console.log(`  ➜  API:      ${api.url}/api/`);
// Enrolment happens in a browser, and the browser goes to the editor — which forwards `/api` to the service
// rather than being it. So the code is announced here, against the address a person actually opens.
if (api.adminCode) {
  const url = vite.resolvedUrls?.local[0] ?? vite.resolvedUrls?.network[0] ?? api.url;
  console.log(`\n${adminCodeBanner(api.adminCode, url.replace(/\/+$/, ''))}`);
}
vite.bindCLIShortcuts({ print: true });
