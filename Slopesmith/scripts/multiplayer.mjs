import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('..', import.meta.url));
const installedCargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
export const cargo = process.env.CARGO ?? (existsSync(installedCargo) ? installedCargo : 'cargo');
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: appRoot, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'test';
  const manifest = ['--manifest-path', 'multiplayer/Cargo.toml'];
  if (mode === 'build') {
    await run(cargo, ['build', ...manifest, '--release', '--locked']);
    await run(process.execPath, ['scripts/cargo-notices.mjs']);
  } else if (mode === 'serve') await run(cargo, ['run', ...manifest, '--locked', '--bin', 'slopesmith-multiplayer']);
  else if (mode === 'generate' || mode === 'check') {
    await run(cargo, [
      'run',
      ...manifest,
      '--locked',
      '--bin',
      'export-protocol',
      ...(mode === 'check' ? ['--', '--check'] : []),
    ]);
    await run(process.execPath, ['scripts/generate-play-validators.mjs', ...(mode === 'check' ? ['--check'] : [])]);
  } else if (mode === 'test' || mode === 'bench') {
    await run(cargo, ['test', ...manifest, '--locked']);
    await run(cargo, ['run', ...manifest, '--locked', '--bin', 'export-protocol', '--', '--check']);
    await run(process.execPath, ['scripts/generate-play-validators.mjs', '--check']);
    await run(
      process.execPath,
      ['--import', 'tsx', 'test/multiplayer.test.ts'],
      mode === 'bench' ? { env: { ...process.env, SLOPESMITH_MULTIPLAYER_LOAD: '1' } } : {},
    );
  } else if (mode === 'unit') {
    await run(cargo, ['test', ...manifest, '--locked']);
    await run(cargo, ['run', ...manifest, '--locked', '--bin', 'export-protocol', '--', '--check']);
    await run(process.execPath, ['scripts/generate-play-validators.mjs', '--check']);
  } else throw new Error(`Unknown multiplayer command: ${mode}`);
}
