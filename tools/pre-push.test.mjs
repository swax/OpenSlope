import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Git invokes both mandatory audits on committed files and refuses failed pushes', { timeout: 120_000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'openslope-hook-test-'));
  const checkout = join(temporary, 'source');
  const remote = join(temporary, 'remote.git');
  const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd, args, expected = 0, extraEnvironment = {}) => {
    const result = spawnSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
      env: { ...environment, ...extraEnvironment },
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    if (expected === 0) assert.equal(result.status, 0, output);
    else assert.notEqual(result.status, 0, output);
    return output;
  };
  const commitState = (state, message) => {
    writeFileSync(join(checkout, 'audit-state.txt'), state);
    git(checkout, ['add', 'audit-state.txt']);
    git(checkout, ['commit', '-m', message]);
  };
  try {
    mkdirSync(checkout);
    git(checkout, ['init', '--initial-branch=main']);
    git(checkout, ['config', 'user.name', 'Hook test']);
    git(checkout, ['config', 'user.email', 'hook@example.invalid']);
    for (const path of ['.githooks/pre-push', 'tools/pre-push.mjs', 'tools/affected-suites.mjs', 'tools/python.mjs']) {
      mkdirSync(dirname(join(checkout, path)), { recursive: true });
      copyFileSync(join(root, path), join(checkout, path));
    }
    chmodSync(join(checkout, '.githooks/pre-push'), 0o755);
    mkdirSync(join(checkout, 'tools/native'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(checkout, 'tools/hygiene.py'),
      'from pathlib import Path\nimport sys\nstate = Path("audit-state.txt").read_text()\nprint("AUDIT hygiene " + state)\nsys.exit(1 if state == "hygiene" else 0)\n',
    );
    writeFileSync(
      join(checkout, 'tools/native/native-source-audit.mjs'),
      'import { readFileSync } from "node:fs";\nconst state = readFileSync("audit-state.txt", "utf8");\nconsole.log("AUDIT native " + state);\nprocess.exitCode = state === "native" ? 1 : 0;\n',
    );
    writeFileSync(join(checkout, 'audit-state.txt'), 'clean');
    git(checkout, ['add', '.']);
    git(checkout, ['commit', '-m', 'Baseline']);
    const baseline = git(checkout, ['rev-parse', 'HEAD']).trim();
    mkdirSync(remote);
    git(remote, ['init', '--bare', '--initial-branch=main']);
    git(remote, ['fetch', checkout, 'main:refs/heads/main']);
    git(checkout, ['remote', 'add', 'origin', remote]);
    git(checkout, ['config', 'core.hooksPath', '.githooks']);

    commitState('hygiene', 'Hygiene failure');
    const rejectedTip = git(checkout, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(checkout, 'audit-state.txt'), 'clean');
    const hygiene = git(checkout, ['push', 'origin', 'HEAD:main'], 1, { OPENSLOPE_SKIP_PREPUSH: '1' });
    assert.match(hygiene, /AUDIT hygiene hygiene/);
    assert.match(hygiene, /Repository hygiene gate failed/);
    assert.equal(git(remote, ['rev-parse', 'main']).trim(), baseline);

    mkdirSync(join(checkout, 'Native/docs'), { recursive: true });
    writeFileSync(join(checkout, 'Native/docs/fixture.md'), 'Native-only change\n');
    git(checkout, ['add', 'Native/docs/fixture.md']);
    commitState('native', 'Native audit failure');
    writeFileSync(join(checkout, 'audit-state.txt'), 'clean');
    const native = git(checkout, ['push', 'origin', 'HEAD:main'], 1, { GIT_WORK_TREE: checkout });
    assert.match(native, /AUDIT hygiene native/);
    assert.match(native, /AUDIT native native/);
    assert.match(native, /Native source boundary failed/);
    assert.equal(git(remote, ['rev-parse', 'main']).trim(), baseline);

    commitState('clean', 'Both audits pass');
    const accepted = git(checkout, ['push', 'origin', 'HEAD:main']);
    assert.match(accepted, /AUDIT hygiene clean/);
    assert.match(accepted, /AUDIT native clean/);
    assert.match(accepted, /pre-push: PASS/);
    assert.equal(git(remote, ['rev-parse', 'main']).trim(), git(checkout, ['rev-parse', 'HEAD']).trim());

    const multiple = git(
      checkout,
      ['push', 'origin', 'HEAD:refs/heads/clean-branch', `${rejectedTip}:refs/heads/unsafe-branch`],
      1,
    );
    assert.match(multiple, /AUDIT hygiene hygiene/);
    git(remote, ['show-ref', '--verify', 'refs/heads/clean-branch'], 1);
    git(remote, ['show-ref', '--verify', 'refs/heads/unsafe-branch'], 1);
  } finally {
    assert.equal(resolve(dirname(temporary)), resolve(tmpdir()));
    assert(basename(temporary).startsWith('openslope-hook-test-'));
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
