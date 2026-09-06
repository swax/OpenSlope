/**
 * Run every PS2 autotest fixture through Slopesmith's deterministic Test-mode seam.
 *
 * Each child loads the editable workspace project, builds the same terrain/prop/effect/ride runtime as Play,
 * and drives a fresh production rider through every cell. Open research cells are reported but do not fail;
 * every PS2-proven expectation must match, while unavailable slot telemetry fails explicitly.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mapsRoot } from '../src/server/workspace-config';

const FIXTURES = ['GOLD', 'AUTOTEST1', 'AUTOTEST1B', 'AUTOTEST2', 'AUTOTEST3', 'AUTOTEST4', 'AUTOTEST5', 'AUTOTEST6'];
const runner = fileURLToPath(new URL('./ai-mountain-run.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
let failed = 0;

for (const fixture of FIXTURES) {
  const plan = JSON.parse(readFileSync(join(mapsRoot(), fixture, 'autotest-plan.json'), 'utf8')) as {
    entries: { contactOptional?: boolean }[];
  };
  const driven = plan.entries.filter(entry => !entry.contactOptional).length;
  const seconds = driven * 12 + 1;
  console.log(`\n========== ${fixture} ==========`);
  const result = spawnSync(process.execPath, [tsx, runner, fixture, String(seconds), '--autotest'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', windowsHide: true,
  });
  if (result.error) { console.error(result.error); failed++; }
  else if (result.status !== 0) failed++;
}

console.log(failed
  ? `\n${failed}/${FIXTURES.length} fixture(s) have parity mismatches or unobservable assertions`
  : `\nall ${FIXTURES.length} fixtures match their PS2-proven expectations`);
process.exit(failed ? 1 : 0);
