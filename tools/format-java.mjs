// Reuse Slopesmith's locked Prettier and Java plugin without loading the Android build.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) {
  console.error('Usage: node tools/format-java.mjs [--check]');
  process.exit(1);
}

const prettier = join(root, 'Slopesmith/node_modules/prettier/bin/prettier.cjs');
const plugin = join(root, 'Slopesmith/node_modules/prettier-plugin-java/dist/index.mjs');
if (!existsSync(prettier) || !existsSync(plugin)) {
  console.error('Java formatting needs Slopesmith dependencies; run `npm ci --prefix Slopesmith`.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    prettier,
    args.includes('--check') ? '--check' : '--write',
    '--config',
    'Native/.prettierrc.json',
    'Native/android/app/src/**/*.java',
    'Native/tests/**/*.java',
    'Native/tools/**/*.java',
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (result.error) {
  console.error(`Java formatter failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
