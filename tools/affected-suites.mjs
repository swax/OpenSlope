// Which fast suites a change touches: the one answer shared by CI's path filter and the pre-push hook.
//
// The Verify workflow runs Snowknife's and Slopesmith's fast suites only when their sources changed (a
// docs-only push costs one hygiene job, not three), and the pre-push hook makes the same call before the
// push leaves the machine. Two copies of that rule - one in YAML, one here - would drift the way
// tools/hygiene.py describes its own list drifting, so this file is the rule and both callers run it.
//
//   node tools/affected-suites.mjs <base> <head>      two commits, as `git diff` takes them (a push)
//   node tools/affected-suites.mjs <base>...<head>    merge-base form (a pull request)
//   node tools/affected-suites.mjs --all              everything, for a manual run
//
// Prints `snowknife=<bool>` and `slopesmith=<bool>`, one per line, ready for $GITHUB_OUTPUT.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A path is in when any listed prefix or exact name matches it. */
const SNOWKNIFE = {
  prefixes: ['Snowknife/Snowknife/', 'Snowknife/Snowknife.Tests/', 'Snowknife/tools/', '.github/workflows/'],
  exact: ['Snowknife/SSX-Library', '.gitmodules', 'package.json', 'package-lock.json',
    'tools/snowknife-tests.mjs', 'tools/affected-suites.mjs'],
};
const SLOPESMITH = {
  prefixes: ['Slopesmith/', '.github/workflows/'],
  exact: ['tools/affected-suites.mjs'],
};
/** Prose and licences under Slopesmith/ are nothing the suite can fail on. */
const SLOPESMITH_PROSE = {
  prefixes: ['Slopesmith/docs/', 'Slopesmith/ThirdPartyNotices/'],
  exact: ['Slopesmith/README.md', 'Slopesmith/LICENSE', 'Slopesmith/NOTICE'],
};

const matches = (path, rule) =>
  rule.prefixes.some(prefix => path.startsWith(prefix)) || rule.exact.includes(path);

/** @param {string[]} changed repository-relative paths with forward slashes, as `git diff --name-only` prints them */
export function affectedSuites(changed) {
  return {
    snowknife: changed.some(path => matches(path, SNOWKNIFE)),
    slopesmith: changed.some(path => matches(path, SLOPESMITH) && !matches(path, SLOPESMITH_PROSE)),
  };
}

export const EVERY_SUITE = Object.freeze({ snowknife: true, slopesmith: true });

/** The paths `git diff --name-only <diffArgs>` reports. Throws when git cannot resolve the commits. */
export function changedPaths(diffArgs) {
  const result = spawnSync('git', ['diff', '--name-only', '-z', ...diffArgs],
    { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git diff ${diffArgs.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const suites = args.includes('--all') ? EVERY_SUITE : affectedSuites(changedPaths(args));
  for (const [name, on] of Object.entries(suites)) console.log(`${name}=${on}`);
}
