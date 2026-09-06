import { constants } from 'node:fs';
import { access, link, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export type UpdateState = 'queued' | 'installing' | 'succeeded' | 'failed';

export interface UpdateStatus {
  available: boolean;
  reason?: string;
  state?: UpdateState;
  revision?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
}

export class UpdateAlreadyQueuedError extends Error {}

export const validUpdateRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/** Undefined on a developer checkout: self-update is enabled only by the root-owned production installer. */
export function configuredUpdateRoot(): string | undefined {
  const value = process.env.SLOPESMITH_UPDATE_ROOT?.trim();
  return value ? resolve(value) : undefined;
}

/** The root runner publishes only the repository identifier, separately from its credentials and build
 * identity. This file is readable by the service but reaches browsers only through the admin-only route. */
export async function readUpdateRepository(root = configuredUpdateRoot()): Promise<string | undefined> {
  if (!root) return undefined;
  try {
    const repository = (await readFile(join(root, 'repository'), 'utf8')).trim();
    return repository && !/[\r\n\0]/.test(repository) ? repository : undefined;
  } catch { return undefined; }
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

const wait = (milliseconds: number): Promise<void> =>
  new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

const safeStatus = (value: unknown): Omit<UpdateStatus, 'available'> => {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as Record<string, unknown>;
  const state = ['queued', 'installing', 'succeeded', 'failed'].includes(String(candidate.state))
    ? candidate.state as UpdateState : undefined;
  const revision = validUpdateRevision(candidate.revision) ? candidate.revision : undefined;
  const startedAt = typeof candidate.startedAt === 'string' ? candidate.startedAt : undefined;
  const finishedAt = typeof candidate.finishedAt === 'string' ? candidate.finishedAt : undefined;
  const exitCode = Number.isInteger(candidate.exitCode) ? candidate.exitCode as number : undefined;
  return { state, revision, startedAt, finishedAt, exitCode };
};

/** What Settings can safely learn from the privileged runner's root-owned status record. */
export async function readUpdateStatus(root = configuredUpdateRoot()): Promise<UpdateStatus> {
  if (!root) return { available: false, reason: 'Automatic updates are not installed on this server.' };
  const inbox = join(root, 'inbox');
  try { await access(inbox, constants.W_OK); }
  catch { return { available: false, reason: 'The automatic-update inbox is unavailable.' }; }

  // A newly queued request outranks the previous run's retained status until the runner claims it.
  try {
    const revision = (await readFile(join(inbox, 'request'), 'utf8')).trim();
    return { available: true, state: 'queued', ...(validUpdateRevision(revision) ? { revision } : {}) };
  } catch (error) {
    if (!missing(error)) return { available: false, reason: 'The automatic-update request cannot be read.' };
  }

  try {
    const value = JSON.parse(await readFile(join(root, 'status.json'), 'utf8')) as unknown;
    return { available: true, ...safeStatus(value) };
  } catch (error) {
    if (!missing(error)) return { available: false, reason: 'The automatic-update status is unreadable.' };
  }
  return { available: true };
}

/**
 * Queue exactly one full SHA. A hard-link publishes the already-complete temporary file without overwriting
 * an existing request; the systemd path unit never has a chance to read a partially written revision.
 */
export async function queueUpdate(revision: string, root = configuredUpdateRoot()): Promise<void> {
  if (!validUpdateRevision(revision)) throw new Error('An update needs a full 40-character lowercase commit.');
  if (!root) throw new Error('Automatic updates are not installed on this server.');
  const inbox = join(root, 'inbox');
  const request = join(inbox, 'request');
  const temporary = join(inbox, `.request-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${revision}\n`, { flag: 'wx', mode: 0o640 });
    try { await link(temporary, request); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UpdateAlreadyQueuedError('Another update is already queued.');
      }
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

interface LatestRevisionRecord { hash: string; checkedAt: string }

async function readLatestRevision(root: string): Promise<LatestRevisionRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8')) as Record<string, unknown>;
    if (!validUpdateRevision(value.hash) || typeof value.checkedAt !== 'string') return undefined;
    return { hash: value.hash, checkedAt: value.checkedAt };
  } catch { return undefined; }
}

/**
 * Ask the root-owned runner to resolve the one fixed remote ref with the deploy account's private-repository
 * credentials. The web process receives only a commit hash; it never reads the credentials or chooses a URL.
 */
export async function resolveLatestRevision(root = configuredUpdateRoot()): Promise<LatestRevisionRecord> {
  if (!root) throw new Error('The privileged version resolver is not installed on this server.');
  const inbox = join(root, 'inbox');
  const before = await readLatestRevision(root);
  const request = join(inbox, 'version-check');
  const temporary = join(inbox, `.version-check-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, 'check\n', { flag: 'wx', mode: 0o640 });
    try { await link(temporary, request); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another browser already asked. Share the fixed root-side lookup it has in flight.
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }

  for (let attempt = 0; attempt < 300; attempt++) {
    await wait(100);
    const latest = await readLatestRevision(root);
    if (latest && latest.checkedAt !== before?.checkedAt) return latest;
  }
  throw new Error('The privileged version resolver did not answer within 30 seconds.');
}
