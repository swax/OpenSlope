import { APP_ROOT } from '../workspace-config';
import {
  fetchLatestVersion, inspectCheckout, updateBranchLabel, type CheckoutVersion, type RemoteVersion,
} from '../version';
import { configuredUpdateRoot, resolveLatestRevision } from '../update';
import { createLogger } from '../log';
import { jsonResponse, type ApiHandler } from './common';

export type AppVersionInfo = CheckoutVersion & Partial<RemoteVersion> & { checkError?: string };

const log = createLogger('version');

// Capture HEAD while the module is loaded, rather than when Settings happens to be opened. That makes
// "current" mean the code in this process even if another terminal changes the checkout underneath it.
const startupCheckout = inspectCheckout(APP_ROOT);
let lastRemote: (Partial<RemoteVersion> & { checkError?: string }) | undefined;
let checkInFlight: Promise<Partial<RemoteVersion> & { checkError?: string }> | undefined;
const branchLabel = (): string => configuredUpdateRoot() ? 'configured repository/main' : updateBranchLabel();

/** One shared check prevents several open browsers from launching duplicate fetches at the same moment. */
async function checkRemote(checkout: CheckoutVersion): Promise<Partial<RemoteVersion> & { checkError?: string }> {
  if (!checkout.available || !checkout.current) return { checkError: checkout.reason };
  if (checkInFlight) return await checkInFlight;
  const check = configuredUpdateRoot()
    ? resolveLatestRevision().then(({ hash, checkedAt }) => ({
      latest: { hash }, latestBranch: branchLabel(),
      relation: hash === checkout.current?.hash ? 'current' as const : 'unknown' as const,
      ahead: 0, behind: 0, checkedAt,
    }))
    : fetchLatestVersion(APP_ROOT, checkout.current.hash);
  checkInFlight = check
    .catch(error => {
      log.error('update repository check failed', { error });
      return {
        checkError: 'Could not reach the configured update repository’s main branch. '
          + 'Check this server’s network access, update configuration, and Git credentials.',
      };
    })
    .then(result => (lastRemote = result))
    .finally(() => { checkInFlight = undefined; });
  return await checkInFlight;
}

/** Shared with the update route so “latest” is resolved by the server at the moment it is requested. */
export async function appVersionInfo(refresh = false): Promise<AppVersionInfo> {
  const checkout = await startupCheckout;
  const remote = refresh ? await checkRemote(checkout) : lastRemote;
  return { ...checkout, latestBranch: branchLabel(), ...remote };
}

export const versionRoutes: Record<string, ApiHandler> = {
  '/api/version': async (req, res) => {
    if (req.method === 'GET') {
      jsonResponse(res, 200, await appVersionInfo());
      return;
    }
    if (req.method === 'POST') {
      jsonResponse(res, 200, await appVersionInfo(true));
      return;
    }
    res.statusCode = 405;
    res.end('GET or POST only');
  },
};
