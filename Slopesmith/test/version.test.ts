import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  configuredUpdateRepository, displayUpdateRepository, fetchLatestVersion, inspectCheckout,
  resolveUpdateRepository, updateBranchLabel,
} from '../src/server/version';
import { removeTestTree } from './http-test-support';
import { check, failures } from './check';

const execFileAsync = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'slopesmith-version-'));
const remote = join(root, 'origin.git');
const fork = join(root, 'fork.git');
const local = join(root, 'local');
const publisher = join(root, 'publisher');

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true,
  });
}

try {
  const previousRepository = process.env.SLOPESMITH_UPDATE_REPOSITORY;
  process.env.SLOPESMITH_UPDATE_REPOSITORY = ' https://example.invalid/a-fork.git ';
  check(configuredUpdateRepository() === 'https://example.invalid/a-fork.git'
    && updateBranchLabel() === 'configured repository/main',
  'the server trims an operator-configured update repository and describes its fixed main branch');
  check(displayUpdateRepository('https://token:secret@example.invalid/private/repo.git')
    === 'https://example.invalid/private/repo.git',
  'the repository shown in Settings strips accidentally embedded HTTP credentials');
  if (previousRepository === undefined) delete process.env.SLOPESMITH_UPDATE_REPOSITORY;
  else process.env.SLOPESMITH_UPDATE_REPOSITORY = previousRepository;

  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'init', '--initial-branch=main', local);
  await git(local, 'config', 'user.name', 'Slopesmith test');
  await git(local, 'config', 'user.email', 'slopesmith@example.invalid');
  mkdirSync(join(local, 'Slopesmith'));
  writeFileSync(join(local, 'Slopesmith', 'version.txt'), 'one\n');
  writeFileSync(join(local, 'unrelated.txt'), 'outside the app\n');
  await git(local, 'add', '.');
  await git(local, 'commit', '-m', 'first version');
  await git(local, 'remote', 'add', 'origin', remote);
  await git(local, 'push', '-u', 'origin', 'main');

  const appRoot = join(local, 'Slopesmith');
  check(await resolveUpdateRepository(appRoot) === remote,
    'a developer server reports the checkout origin it actually uses for updates');
  const running = await inspectCheckout(appRoot);
  check(running.available && running.branch === 'main' && running.current?.subject === 'first version'
    && running.dirty === false,
  'the running version captures the commit, branch, subject, and clean Slopesmith subtree');

  // Dirt elsewhere in a monorepo must not make Slopesmith claim its own source has changed.
  writeFileSync(join(local, 'unrelated.txt'), 'changed outside the app\n');
  const unrelatedDirty = await inspectCheckout(appRoot);
  check(unrelatedDirty.dirty === false, 'uncommitted sibling changes do not mark the Slopesmith folder dirty');

  await git(root, 'clone', remote, publisher);
  await git(publisher, 'config', 'user.name', 'Slopesmith test');
  await git(publisher, 'config', 'user.email', 'slopesmith@example.invalid');
  writeFileSync(join(publisher, 'Slopesmith', 'version.txt'), 'two\n');
  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-m', 'second version');
  await git(publisher, 'push', 'origin', 'main');

  if (!running.current) throw new Error('fixture checkout had no current commit');
  const checked = await fetchLatestVersion(appRoot, running.current.hash);
  check(checked.latest.subject === 'second version' && checked.latestBranch === 'origin/main'
    && checked.relation === 'behind' && checked.ahead === 0 && checked.behind === 1,
  'checking origin/main finds its exact latest commit and reports the running process one commit behind');

  // A host may intentionally follow a fork even when the checkout's own origin points somewhere else.
  await git(root, 'init', '--bare', '--initial-branch=main', fork);
  await git(publisher, 'remote', 'add', 'fork', fork);
  writeFileSync(join(publisher, 'Slopesmith', 'version.txt'), 'forked\n');
  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-m', 'fork version');
  await git(publisher, 'push', 'fork', 'main');
  const forked = await fetchLatestVersion(appRoot, running.current.hash, fork);
  check(forked.latest.subject === 'fork version' && forked.latestBranch === 'configured repository/main'
    && forked.relation === 'behind' && forked.ahead === 0 && forked.behind === 2,
  'a configured repository overrides origin and compares the running commit with that fork’s main branch');

  writeFileSync(join(local, 'Slopesmith', 'version.txt'), 'locally changed\n');
  const appDirty = await inspectCheckout(appRoot);
  check(appDirty.dirty === true, 'uncommitted changes inside Slopesmith are reported beside its commit');

  const releaseHash = '1234567890abcdef1234567890abcdef12345678';
  const release = join(root, releaseHash);
  mkdirSync(release);
  const immutable = await inspectCheckout(release);
  check(immutable.available && immutable.current?.hash === releaseHash && immutable.branch === 'release'
    && immutable.dirty === false,
  'an immutable production release with no .git is identified by its exact release directory');

  const stamped = join(root, 'packaged-app');
  mkdirSync(stamped);
  writeFileSync(join(stamped, '.slopesmith-revision'), `${releaseHash}\n`);
  const packaged = await inspectCheckout(stamped);
  check(packaged.available && packaged.current?.hash === releaseHash && packaged.branch === 'release',
    'a packaged release uses the revision stamp written by the deploy helper');
  const packagedFork = await fetchLatestVersion(stamped, releaseHash, fork);
  check(packagedFork.latest.hash === forked.latest.hash
    && packagedFork.latestBranch === 'configured repository/main' && packagedFork.relation === 'unknown',
  'a packaged release without Git metadata checks the configured fork instead of a hard-coded repository');

  const unavailable = await inspectCheckout(root);
  check(!unavailable.available && !!unavailable.reason,
    'a deployment without Git metadata gets a useful unavailable answer instead of an exception');
} finally {
  removeTestTree(root);
}

if (failures) process.exitCode = 1;
