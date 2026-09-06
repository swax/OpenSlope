// The interpreter the gate runs its Python checks with.
//
// `python` is what Windows and CI (actions/setup-python) provide; stock macOS and Debian-family Linux
// ship only `python3`. Honour $PYTHON, then take the first candidate that answers `--version`, so the
// same `npm run verify` works on every contributor's machine without a shim package. Windows tries
// `python` first because its `python3` is often the Store-install stub, which answers with an error.

import { spawnSync } from 'node:child_process';

export function pythonCommand() {
  const order = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  const candidates = [process.env.PYTHON, ...order].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error(`No Python 3 interpreter answered (tried ${candidates.join(', ')}); install one or set PYTHON.`);
}
