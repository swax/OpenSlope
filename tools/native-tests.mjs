import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkNativeSourceBoundary } from './native-source-audit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
checkNativeSourceBoundary();
// The optional local specification is authoritative when present. Fresh clones
// still build from the tracked contracts without needing the research workspace.
for (const name of ['ride-v1.json', 'carving-response-cases-v1.json']) {
  const spec = join(root, 'Trailmap', 'specs', 'data', name);
  if (existsSync(spec) && !readFileSync(spec).equals(readFileSync(join(root, 'Contracts', name)))) {
    throw new Error(`Native spec alignment: Contracts/${name} differs from the local Trailmap specification.`);
  }
}
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 15 * 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (process.platform === 'win32') {
  run(process.execPath, ['--test', 'tools/native-source-audit.test.mjs']);
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'Native/build.ps1']);
} else {
  run(process.execPath, ['--test', 'tools/native-source-audit.test.mjs']);
  run('cmake', ['-S', 'Native', '-B', 'temp/native-core', '-DCMAKE_BUILD_TYPE=Release', '-DOPENSLOPE_BUILD_PLAYER=OFF']);
  run('cmake', ['--build', 'temp/native-core', '--parallel', '2']);
  run('ctest', ['--test-dir', 'temp/native-core', '--output-on-failure']);
}
