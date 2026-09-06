// tier: fast

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  queueUpdate, readUpdateRepository, readUpdateStatus, resolveLatestRevision,
  UpdateAlreadyQueuedError, validUpdateRevision,
} from '../src/server/update';
import { removeTestTree } from './http-test-support';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-update-'));
const inbox = join(root, 'inbox');
mkdirSync(inbox);

const revision = '1234567890abcdef1234567890abcdef12345678';

try {
  writeFileSync(join(root, 'repository'), 'git@github.com:example/private-fork.git\n');
  check(await readUpdateRepository(root) === 'git@github.com:example/private-fork.git',
    'the service reads the root runner’s published update source without reading its private configuration');

  check(validUpdateRevision(revision) && !validUpdateRevision(revision.slice(0, 39))
    && !validUpdateRevision(revision.toUpperCase()) && !validUpdateRevision(`${revision}; reboot`),
  'an update accepts only one full lowercase commit hash');

  const idle = await readUpdateStatus(root);
  check(idle.available && idle.state === undefined, 'an installed updater with no request reports idle');

  await queueUpdate(revision, root);
  check(readFileSync(join(inbox, 'request'), 'utf8') === `${revision}\n`,
    'queueing atomically publishes only the validated revision for the root runner');
  const queued = await readUpdateStatus(root);
  check(queued.available && queued.state === 'queued' && queued.revision === revision,
    'the browser can see the queued request before the privileged runner claims it');

  let duplicate = false;
  try { await queueUpdate(revision, root); }
  catch (error) { duplicate = error instanceof UpdateAlreadyQueuedError; }
  check(duplicate, 'a second request cannot replace one already waiting in the inbox');

  rmSync(join(inbox, 'request'));
  writeFileSync(join(root, 'status.json'), JSON.stringify({
    state: 'succeeded', revision, startedAt: '2026-08-13T00:00:00Z',
    finishedAt: '2026-08-13T00:01:00Z', exitCode: 0,
    privateRootDetail: '/root/must-not-pass-through',
  }));
  const succeeded = await readUpdateStatus(root);
  check(succeeded.state === 'succeeded' && succeeded.revision === revision && succeeded.exitCode === 0
    && !('privateRootDetail' in succeeded),
  'status exposes the fixed public schema and drops any unexpected privileged-runner fields');

  writeFileSync(join(root, 'status.json'), '{not json');
  const corrupt = await readUpdateStatus(root);
  check(!corrupt.available && /unreadable/.test(corrupt.reason ?? ''),
    'a corrupt privileged status record disables updates instead of being mistaken for idle');

  let invalid = false;
  try { await queueUpdate('main', root); } catch { invalid = true; }
  check(invalid, 'a branch name cannot enter the privileged request inbox');

  const resolvedHash = 'abcdef1234567890abcdef1234567890abcdef12';
  const resolving = resolveLatestRevision(root);
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const observe = () => {
      try {
        if (readFileSync(join(inbox, 'version-check'), 'utf8') === 'check\n') {
          writeFileSync(join(root, 'latest.json'), JSON.stringify({
            hash: resolvedHash, checkedAt: '2026-08-14T00:00:00Z',
          }));
          resolve();
          return;
        }
      } catch { /* The atomic request has not appeared yet. */ }
      if (Date.now() >= deadline) reject(new Error('version-check request did not appear'));
      else setTimeout(observe, 10);
    };
    observe();
  });
  const latest = await resolving;
  check(latest.hash === resolvedHash,
    'a private-repository check publishes only the fixed request and receives a root-resolved commit');
} finally {
  removeTestTree(root);
}

if (failures) process.exitCode = 1;
