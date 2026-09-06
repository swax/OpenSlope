import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const REVISION_FILE = '.slopesmith-revision';
export const DEFAULT_UPDATE_REPOSITORY = 'https://github.com/swax/OpenSlope.git';
export const DEFAULT_UPDATE_BRANCH = 'main';

/** A machine operator may point update checks at a fork. The privileged production updater reads the same
 *  variable from its root-owned config; it is never accepted from an HTTP request. */
export function configuredUpdateRepository(): string | undefined {
  const value = process.env.SLOPESMITH_UPDATE_REPOSITORY?.trim();
  return value || undefined;
}

/** Presentation only: do not return a repository URL to every signed-in viewer. A private repository's name
 *  can itself be private, and credentials never belong in version API output. */
export const updateBranchLabel = (): string => configuredUpdateRepository()
  ? `configured repository/${DEFAULT_UPDATE_BRANCH}`
  : `origin/${DEFAULT_UPDATE_BRANCH}`;

/** Remove HTTP user-info before a repository identifier is shown in the administrator UI. Configuration
 * explicitly forbids credentials in the URL, but a display path should stay safe even when that rule is
 * accidentally broken. SSH's conventional `git@host:path` form is not URL user-info and remains intact. */
export function displayUpdateRepository(repository: string): string {
  const value = repository.trim();
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch { /* Git also accepts filesystem paths and scp-style SSH remotes. */ }
  return value;
}

export interface GitRevision {
  hash: string;
  committedAt?: string;
  subject?: string;
}

export interface CheckoutVersion {
  available: boolean;
  current?: GitRevision;
  branch?: string;
  dirty?: boolean;
  reason?: string;
}

export type VersionRelation = 'current' | 'behind' | 'ahead' | 'diverged' | 'unknown';

export interface RemoteVersion {
  latest: GitRevision;
  latestBranch: string;
  relation: VersionRelation;
  ahead: number;
  behind: number;
  checkedAt: string;
}

/** Run Git without ever opening an interactive credentials prompt in the server process. */
async function git(appRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', appRoot, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 64 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout.trim();
}

async function optionalGit(appRoot: string, args: string[]): Promise<string> {
  try { return await git(appRoot, args); } catch { return ''; }
}

/** The source a developer checkout will use for updates. Production's root-owned source is published through
 * the updater state instead, because the web service deliberately cannot read `/etc/slopesmith-update.env`. */
export async function resolveUpdateRepository(appRoot: string): Promise<string> {
  const configured = configuredUpdateRepository();
  if (configured) return displayUpdateRepository(configured);
  const origin = await optionalGit(appRoot, ['remote', 'get-url', 'origin']);
  return displayUpdateRepository(origin || DEFAULT_UPDATE_REPOSITORY);
}

/** One commit in the small, presentation-ready shape the browser needs. */
async function revision(appRoot: string, name: string): Promise<GitRevision> {
  const output = await git(appRoot, ['show', '-s', '--format=%H%x00%cI%x00%s', name]);
  const [hash, committedAt, ...subject] = output.split('\0');
  if (!/^[0-9a-f]{40}$/i.test(hash ?? '') || !committedAt) throw new Error('Git returned an invalid revision.');
  return { hash, committedAt, subject: subject.join('\0') };
}

/** An immutable production release has no `.git`: deployment stamps the SHA, and older releases can still
 *  be identified by the exact 40-character directory the atomic deploy helper installs them under. */
async function releaseRevision(appRoot: string): Promise<string> {
  try {
    const stamped = (await readFile(join(appRoot, REVISION_FILE), 'utf8')).trim();
    if (/^[0-9a-f]{40}$/i.test(stamped)) return stamped.toLowerCase();
  } catch { /* Releases made before the stamp use their immutable directory name below. */ }
  try {
    const installed = basename(await realpath(appRoot));
    return /^[0-9a-f]{40}$/i.test(installed) ? installed.toLowerCase() : '';
  } catch { return ''; }
}

/**
 * Capture what this server process is running from. The caller deliberately retains this answer for the
 * process lifetime: if somebody fetches or checks out another commit underneath a running service, HEAD has
 * changed but the already-loaded server code has not.
 */
export async function inspectCheckout(appRoot: string): Promise<CheckoutVersion> {
  try {
    const current = await revision(appRoot, 'HEAD');
    const [branch, changes] = await Promise.all([
      optionalGit(appRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      // Scope dirtiness to Slopesmith when it lives inside the larger OpenSlope checkout. Unrelated sibling
      // experiments should not make the app claim that its own source differs from the named commit.
      git(appRoot, ['status', '--porcelain', '--untracked-files=normal', '--', '.']),
    ]);
    return { available: true, current, branch: branch || 'detached HEAD', dirty: !!changes };
  } catch {
    const hash = await releaseRevision(appRoot);
    if (hash) return { available: true, current: { hash }, branch: 'release', dirty: false };
    return { available: false, reason: 'This Slopesmith build does not contain revision information.' };
  }
}

/**
 * Contact the configured repository (or this checkout's origin) and compare the process's captured commit with
 * its latest main commit. `git fetch` writes only Git's object/FETCH_HEAD metadata: it never pulls, merges,
 * checks out, or changes the worktree. Passing a repository is useful to callers and tests that must override
 * the process environment; production normally receives it through `SLOPESMITH_UPDATE_REPOSITORY`.
 */
export async function fetchLatestVersion(
  appRoot: string,
  currentHash: string,
  repository = configuredUpdateRepository(),
): Promise<RemoteVersion> {
  const checkout = await optionalGit(appRoot, ['rev-parse', '--is-inside-work-tree']);
  if (checkout !== 'true') {
    const source = repository?.trim() || DEFAULT_UPDATE_REPOSITORY;
    const output = await git(appRoot, ['ls-remote', '--', source, `refs/heads/${DEFAULT_UPDATE_BRANCH}`]);
    const hash = output.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('The update repository’s main branch returned no revision.');
    return {
      latest: { hash }, latestBranch: repository?.trim()
        ? `configured repository/${DEFAULT_UPDATE_BRANCH}`
        : `origin/${DEFAULT_UPDATE_BRANCH}`,
      relation: hash === currentHash.toLowerCase() ? 'current' : 'unknown',
      ahead: 0, behind: 0, checkedAt: new Date().toISOString(),
    };
  }

  const source = repository?.trim() || 'origin';
  await git(appRoot, ['fetch', '--quiet', '--no-tags', '--', source, `refs/heads/${DEFAULT_UPDATE_BRANCH}`]);
  const latest = await revision(appRoot, 'FETCH_HEAD');
  let ahead = 0, behind = 0;
  let relation: VersionRelation = 'unknown';
  try {
    const counts = (await git(appRoot, ['rev-list', '--left-right', '--count', `${currentHash}...${latest.hash}`]))
      .split(/\s+/).map(Number);
    if (counts.length === 2 && counts.every(Number.isFinite)) {
      [ahead, behind] = counts;
      relation = ahead === 0 && behind === 0 ? 'current'
        : ahead === 0 ? 'behind'
        : behind === 0 ? 'ahead'
        : 'diverged';
    }
  } catch { /* A shallow/disconnected checkout can still show both exact commits without claiming ancestry. */ }
  return {
    latest,
    latestBranch: repository?.trim()
      ? `configured repository/${DEFAULT_UPDATE_BRANCH}`
      : `origin/${DEFAULT_UPDATE_BRANCH}`,
    relation,
    ahead,
    behind,
    checkedAt: new Date().toISOString(),
  };
}
