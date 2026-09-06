import { appVersionInfo } from './version';
import { APP_ROOT } from '../workspace-config';
import { displayUpdateRepository, resolveUpdateRepository } from '../version';
import { jsonResponse, readJsonBody, type ApiHandler } from './common';
import {
  configuredUpdateRoot, queueUpdate, readUpdateRepository, readUpdateStatus,
  UpdateAlreadyQueuedError, validUpdateRevision,
} from '../update';

/** Production publishes its root-owned choice into the updater state. A development server instead reports
 * the configured override or the checkout's actual origin. Never guess the default on a production updater
 * whose older helper has not published its choice yet. */
async function updateRepository(): Promise<string | undefined> {
  const updateRoot = configuredUpdateRoot();
  const repository = updateRoot ? await readUpdateRepository(updateRoot) : await resolveUpdateRepository(APP_ROOT);
  return repository ? displayUpdateRepository(repository) : undefined;
}

export const updateRoutes: Record<string, ApiHandler> = {
  '/api/update': async (req, res) => {
    if (req.method === 'GET') {
      const [status, repository] = await Promise.all([readUpdateStatus(), updateRepository()]);
      jsonResponse(res, 200, { ...status, repository });
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('GET or POST only');
      return;
    }

    try {
      const availability = await readUpdateStatus();
      if (!availability.available) {
        jsonResponse(res, 503, { error: availability.reason });
        return;
      }
      if (availability.state === 'queued' || availability.state === 'installing') {
        jsonResponse(res, 409, { error: 'Another update is already in progress.', update: availability });
        return;
      }
      const body = await readJsonBody(req, 4 * 1024) as { target?: unknown };
      let revision: string;
      if (body.target === 'latest') {
        const version = await appVersionInfo(true);
        if (!version.latest || version.checkError) {
          jsonResponse(res, 502, {
            error: version.checkError ?? 'Could not resolve the configured update repository’s main branch.',
          });
          return;
        }
        revision = version.latest.hash;
      } else if (validUpdateRevision(body.target)) revision = body.target;
      else {
        jsonResponse(res, 400, { error: 'Choose latest or enter a full 40-character lowercase commit.' });
        return;
      }

      await queueUpdate(revision);
      jsonResponse(res, 202, { queued: true, revision });
    } catch (error) {
      if (error instanceof UpdateAlreadyQueuedError) {
        jsonResponse(res, 409, { error: error.message, update: await readUpdateStatus() });
      } else {
        jsonResponse(res, 500, { error: String(error instanceof Error ? error.message : error) });
      }
    }
  },
};
