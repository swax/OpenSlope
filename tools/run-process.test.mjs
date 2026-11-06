import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runProcess } from './run-process.mjs';

test('verification preserves the exit code and reports spawn failures', async () => {
  assert.equal(
    (
      await runProcess(process.execPath, ['-e', 'process.exit(7)'], {
        timeout: 5000,
        stdio: 'ignore',
      })
    ).status,
    7,
  );
  assert.equal(
    (
      await runProcess('openslope-command-that-does-not-exist', [], {
        timeout: 5000,
        stdio: 'ignore',
      })
    ).error.code,
    'ENOENT',
  );
});

test('a timed-out verification step terminates its descendants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openslope-process-tree-'));
  const marker = join(directory, 'survived');
  try {
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 2000)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.argv[1]], {stdio:'ignore'}); setInterval(() => {}, 1000)`;
    const result = await runProcess(process.execPath, ['-e', parent, marker], {
      timeout: 750,
      stdio: 'ignore',
    });
    assert.equal(result.error?.code, 'ETIMEDOUT');
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert(!existsSync(marker), 'the descendant must not survive and write after the timeout');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
