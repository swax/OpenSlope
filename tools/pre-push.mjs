// Audit each pushed tip, then run the affected fast suites from .github/workflows/verify.yml.
//
// Most red CI runs on a repository like this one are not regressions that slipped past a local run; they
// are checks that never ran locally at all: the hygiene gate (a runtime address in a comment, an undeclared
// binary, dirty residue outside an annotation) and fast-tier failures the gate would have reported in under
// a minute. Each costs a round trip to GitHub, a red commit on main, and a fix-up commit. This hook runs the
// same fast-suite selection CI makes. Hygiene and Native source audits always inspect an isolated checkout
// of each pushed tip, so uncommitted fixes cannot conceal a failure in the commit being published.
//
// `npm run verify` remains the full gate, and the daily Full Windows workflow remains the coverage run.
//
//   npm run hooks:install                 point core.hooksPath at .githooks, once per clone
//   node tools/pre-push.mjs --range A B   run it by hand for the commits between A and B

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVERY_SUITE, affectedSuites, changedPaths } from './affected-suites.mjs';
import { pythonCommand } from './python.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const selection = selectSuites();
if (!selection) process.exit(0);
const { suites, heads } = selection;
const started = Date.now();

try {
  for (const head of heads) auditCommit(head);
} catch (error) {
  console.error(`\npre-push: ${error.message}; nothing was pushed.`);
  process.exit(1);
}

const steps = [
  ...(suites.snowknife ? [['Snowknife fast suite', 'node tools/snowknife-tests.mjs']] : []),
  ...(suites.slopesmith
    ? [
        ['Rust multiplayer unit tests and generated contracts', 'npm --prefix Slopesmith run multiplayer:unit'],
        ['Slopesmith type-check', 'npm --prefix Slopesmith run typecheck'],
        ['Slopesmith lint', 'npm --prefix Slopesmith run lint'],
        ['Slopesmith fast tier', 'npm --prefix Slopesmith run test:fast'],
      ]
    : []),
];

if (suites.slopesmith && !existsSync(join(root, 'Slopesmith', 'node_modules'))) {
  console.error('pre-push: Slopesmith/node_modules is missing; run `npm ci --prefix Slopesmith` first.');
  process.exit(1);
}

console.log(
  `pre-push: ${steps.map(([label]) => label).join(', ')}` +
    ` (snowknife=${suites.snowknife}, slopesmith=${suites.slopesmith})`,
);
for (const [label, command] of steps) {
  console.log(`\n=== ${label} ===`);
  // A fixed command string through the shell: npm is `npm.cmd` on Windows, and spawn refuses .cmd without one.
  const result = spawnSync(command, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(
      `\npre-push: ${label} failed${result.error ? ` (${result.error.message})` : ''}; nothing was pushed.`,
    );
    console.error('          Fix the failure before pushing.');
    process.exit(result.status ?? 1);
  }
}
console.log(`\npre-push: PASS (${((Date.now() - started) / 1000).toFixed(0)}s)`);

function auditCommit(head) {
  const temporary = mkdtempSync(join(tmpdir(), 'openslope-pre-push-'));
  const snapshot = join(temporary, 'checkout');
  const environment = { ...process.env };
  const localVariables = spawnSync('git', ['rev-parse', '--local-env-vars'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (localVariables.error || localVariables.status !== 0) throw new Error('Cannot isolate the audit environment');
  for (const name of localVariables.stdout.trim().split(/\r?\n/)) delete environment[name];
  const run = (label, command, args, cwd) => {
    console.log(`\n=== ${label} (${head.slice(0, 12)}) ===`);
    const result = spawnSync(command, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      env: environment,
    });
    if (result.error || result.status !== 0)
      throw new Error(`${label} failed${result.error ? ` (${result.error.message})` : ''}`);
  };
  try {
    run('Prepare committed source', 'git', ['clone', '--quiet', '--shared', '--no-checkout', root, snapshot], root);
    run('Select pushed commit', 'git', ['-C', snapshot, 'checkout', '--quiet', '--detach', head], root);
    run('Repository hygiene gate', pythonCommand(), ['tools/hygiene.py'], snapshot);
    run('Native source boundary', process.execPath, ['tools/native/native-source-audit.mjs'], snapshot);
  } finally {
    // Only the unique temporary clone belongs to this hook; never remove the user's checkout.
    if (resolve(dirname(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('openslope-pre-push-'))
      throw new Error('Unexpected temporary audit directory');
    rmSync(temporary, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

/**
 * What this push touches, from git's pre-push protocol on stdin (`<local ref> <local sha> <remote ref>
 * <remote sha>` per line) or from `--range A B` for a manual run. Null when there is nothing to check:
 * an empty push, or one that only deletes remote refs.
 */
function selectSuites() {
  const at = process.argv.indexOf('--range');
  const pairs =
    at >= 0
      ? [[process.argv[at + 1], process.argv[at + 2]]]
      : readStdin()
          .split('\n')
          .map(line => line.trim().split(/\s+/))
          .filter(([, local]) => local)
          .filter(([, local]) => !/^0+$/.test(local)) // deleting a remote ref pushes no commits
          .map(([, local, , remote]) => [remote, local]);
  if (pairs.length === 0) return null;

  const heads = [
    ...new Set(
      pairs.map(([, head]) => {
        const result = spawnSync('git', ['rev-parse', '--verify', `${head}^{commit}`], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
        });
        if (result.error || result.status !== 0) throw new Error('Cannot resolve the pushed commit');
        return result.stdout.trim();
      }),
    ),
  ];

  try {
    const changed = new Set();
    for (const [base, head] of pairs) {
      if (!base || /^0+$/.test(base)) return { suites: EVERY_SUITE, heads }; // a new remote ref: no base to diff against
      for (const path of changedPaths([base, head])) changed.add(path);
    }
    return { suites: affectedSuites([...changed]), heads };
  } catch (error) {
    // Typically the remote's tip is not fetched locally. The safe reading of "unknown" is "everything".
    console.log(
      `pre-push: could not diff against the remote (${String(error.message).split('\n')[0]}); running every suite.`,
    );
    return { suites: EVERY_SUITE, heads };
  }
}

function readStdin() {
  return readFileSync(0, 'utf8');
}
