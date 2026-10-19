// Format repository tooling with Slopesmith's locked Prettier and the pinned Python formatter.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonCommand } from './python.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) {
  console.error('Usage: node tools/format-tools.mjs [--check]');
  process.exit(1);
}

const prettier = join(root, 'Slopesmith/node_modules/prettier/bin/prettier.cjs');
if (!existsSync(prettier)) {
  console.error('Tools formatting needs Slopesmith dependencies; run `npm ci --prefix Slopesmith`.');
  process.exit(1);
}
const python = pythonCommand();
const probe = spawnSync(python, ['-m', 'ruff', '--version'], { cwd: root, stdio: 'ignore', windowsHide: true });
if (probe.error || probe.status !== 0) {
  console.error('Tools formatting needs Ruff; run `python -m pip install -r tools/requirements-format.txt`.');
  console.error('Use an activated virtual environment, or set PYTHON to its interpreter.');
  process.exit(1);
}

const check = args.includes('--check');
const steps = [
  [
    process.execPath,
    [prettier, check ? '--check' : '--write', '--config', 'Slopesmith/.prettierrc.json', 'tools/**/*.{mjs,mts}'],
  ],
  [
    python,
    ['-m', 'ruff', 'format', '--no-cache', '--config', 'tools/ruff.toml', ...(check ? ['--check'] : []), 'tools'],
  ],
];
let exitCode = 0;
for (const [command, commandArgs] of steps) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) {
    console.error(`Tools formatter failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) exitCode = result.status ?? 1;
}
process.exit(exitCode);
