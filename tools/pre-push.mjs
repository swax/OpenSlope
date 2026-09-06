// The push-time mirror of .github/workflows/verify.yml.
//
// Most red CI runs on a repository like this one are not regressions that slipped past a local run; they
// are checks that never ran locally at all: the hygiene gate (a runtime address in a comment, an undeclared
// binary, dirty residue outside an annotation) and fast-tier failures the gate would have reported in under
// a minute. Each costs a round trip to GitHub, a red commit on main, and a fix-up commit. This hook runs the
// same selection CI makes, with the same commands, on the commits about to leave the machine, so the answer
// arrives before the push instead of after it.
//
// It is deliberately the same selection as CI rather than everything: `npm run verify` remains the full
// gate, and the daily Full Windows workflow remains the coverage run.
//
//   npm run hooks:install                 point core.hooksPath at .githooks, once per clone
//   OPENSLOPE_SKIP_PREPUSH=1 git push     skip it once (`git push --no-verify` also works)
//   node tools/pre-push.mjs --range A B   run it by hand for the commits between A and B

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVERY_SUITE, affectedSuites, changedPaths } from './affected-suites.mjs';
import { pythonCommand } from './python.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

if (process.env.OPENSLOPE_SKIP_PREPUSH) {
  console.log('pre-push: skipped, OPENSLOPE_SKIP_PREPUSH is set.');
  process.exit(0);
}

const suites = selectSuites();
if (!suites) process.exit(0);

const steps = [
  ['Repository hygiene gate', `"${pythonCommand()}" tools/hygiene.py`],
  ...(suites.snowknife ? [['Snowknife fast suite', 'node tools/snowknife-tests.mjs']] : []),
  ...(suites.slopesmith ? [
    ['Slopesmith type-check', 'npm --prefix Slopesmith run typecheck'],
    ['Slopesmith lint', 'npm --prefix Slopesmith run lint'],
    ['Slopesmith fast tier', 'npm --prefix Slopesmith run test:fast'],
  ] : []),
];

if (suites.slopesmith && !existsSync(join(root, 'Slopesmith', 'node_modules'))) {
  console.error('pre-push: Slopesmith/node_modules is missing; run `npm ci --prefix Slopesmith` first.');
  console.error('          (or skip once with OPENSLOPE_SKIP_PREPUSH=1 git push)');
  process.exit(1);
}

console.log(`pre-push: ${steps.map(([label]) => label).join(', ')}`
  + ` (snowknife=${suites.snowknife}, slopesmith=${suites.slopesmith})`);
const started = Date.now();
for (const [label, command] of steps) {
  console.log(`\n=== ${label} ===`);
  // A fixed command string through the shell: npm is `npm.cmd` on Windows, and spawn refuses .cmd without one.
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true, windowsHide: true });
  if (result.status !== 0) {
    console.error(`\npre-push: ${label} failed${result.error ? ` (${result.error.message})` : ''}; nothing was pushed.`);
    console.error('          Fix it, or skip once with OPENSLOPE_SKIP_PREPUSH=1 git push (or git push --no-verify).');
    process.exit(result.status ?? 1);
  }
}
console.log(`\npre-push: PASS (${((Date.now() - started) / 1000).toFixed(0)}s)`);

/**
 * What this push touches, from git's pre-push protocol on stdin (`<local ref> <local sha> <remote ref>
 * <remote sha>` per line) or from `--range A B` for a manual run. Null when there is nothing to check:
 * an empty push, or one that only deletes remote refs.
 */
function selectSuites() {
  const at = process.argv.indexOf('--range');
  const pairs = at >= 0
    ? [[process.argv[at + 1], process.argv[at + 2]]]
    : readStdin().split('\n').map(line => line.trim().split(/\s+/)).filter(([, local]) => local)
      .filter(([, local]) => !/^0+$/.test(local))   // deleting a remote ref pushes no commits
      .map(([, local, , remote]) => [remote, local]);
  if (pairs.length === 0) return null;

  try {
    const changed = new Set();
    for (const [base, head] of pairs) {
      if (!base || /^0+$/.test(base)) return EVERY_SUITE;   // a new remote ref: no base to diff against
      for (const path of changedPaths([base, head])) changed.add(path);
    }
    return affectedSuites([...changed]);
  } catch (error) {
    // Typically the remote's tip is not fetched locally. The safe reading of "unknown" is "everything".
    console.log(`pre-push: could not diff against the remote (${String(error.message).split('\n')[0]}); running every suite.`);
    return EVERY_SUITE;
  }
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}
