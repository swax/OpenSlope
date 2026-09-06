import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonCommand } from './python.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this gate through `npm run verify` so npm_execpath is available.');

const npmStep = (label, script) =>
  [label, process.execPath, [npmCli, '--prefix', 'Slopesmith', 'run', script], 15 * 60_000];

// The gate has to mean the same thing everywhere, so by default it runs what a checkout with no retail disc
// can run - which is what CI has. `--full` adds Snowknife's disc-backed tier for anyone who does have one.
const full = process.argv.includes('--full');
const slopesmithOnly = process.argv.includes('--slopesmith');
if (full && slopesmithOnly) throw new Error('`--full` and `--slopesmith` cannot be combined.');

const snowknifeSteps = [
  [`Snowknife tests${full ? ' (both tiers)' : ''}`, process.execPath,
    ['tools/snowknife-tests.mjs', ...(full ? ['--full'] : [])], full ? 30 * 60_000 : 5 * 60_000],
];
// One step, because tools/hygiene.py owns the list of checks (the disc-backed manifest reproduction
// check included; it self-skips without a disc) and prints its own per-check headings. Keeping a
// second copy of any check here is what let `npm run verify` fall a scanner behind `npm run hygiene`
// once already, and let the release path miss the manifest check.
const hygieneSteps = [
  ['Repository hygiene gate', pythonCommand(), ['tools/hygiene.py'], 10 * 60_000],
];
const slopesmithSteps = [
  npmStep('Slopesmith type-check', 'typecheck'),
  npmStep('Slopesmith lint', 'lint'),
  npmStep('Slopesmith deterministic tests and coverage', 'coverage'),
  npmStep('Slopesmith production build', 'build'),
  npmStep('Export to glTF smoke test', 'smoke'),
];
const steps = slopesmithOnly
  ? slopesmithSteps
  : [...hygieneSteps, ...snowknifeSteps, ...slopesmithSteps];

const started = Date.now();
for (const [label, command, args, timeout] of steps) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    timeout,
    windowsHide: true,
  });

  if (result.error) {
    const suffix = result.error.code === 'ETIMEDOUT' ? ` after ${Math.round(timeout / 60_000)} minutes` : '';
    console.error(`\nVERIFY FAILED: ${label}${suffix}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nVERIFY FAILED: ${label} exited with ${result.status ?? 'no status'}.`);
    process.exit(result.status ?? 1);
  }
}

const scope = slopesmithOnly ? ' (SLOPESMITH)' : full ? ' (FULL)' : '';
console.log(`\nVERIFY${scope}: PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`);
