// tier: fast

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTestTree } from './http-test-support';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-cli-help-'));
const app = join(root, 'absent-release');
const workspace = join(root, 'absent-workspace');
const maps = join(root, 'absent-maps');
try {
  for (const command of ['help', '--help', '-h']) {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../src/server/main.ts', import.meta.url)), command],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        env: {
          ...process.env,
          SLOPESMITH_APP_ROOT: app,
          SLOPESMITH_WORKSPACE_ROOT: workspace,
          SLOPESMITH_MAPS_ROOT: maps,
        },
      },
    );
    assert.equal(child.status, 0, `${command}: ${child.stderr || child.error}`);
    assert(child.stdout.includes('Slopesmith server'));
    for (const directory of [app, workspace, maps])
      assert(!existsSync(directory), `${command} must not initialize ${directory}`);
  }
  console.log('CLI HELP PASS: all help aliases succeed without creating application or storage directories.');
} finally {
  removeTestTree(root);
}
