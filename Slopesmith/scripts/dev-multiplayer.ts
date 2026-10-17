import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { appRoot, cargo, run } from './multiplayer.mjs';

await run(cargo, ['build', '--manifest-path', 'multiplayer/Cargo.toml', '--locked', '--bin', 'slopesmith-multiplayer']);
process.env.SLOPESMITH_MULTIPLAYER_SECRET ||= randomBytes(32).toString('base64url');
const binary = join(
  appRoot,
  'multiplayer',
  'target',
  'debug',
  `slopesmith-multiplayer${process.platform === 'win32' ? '.exe' : ''}`,
);
const relay = spawn(binary, [], {
  cwd: appRoot,
  windowsHide: true,
  env: { ...process.env, SLOPESMITH_MULTIPLAYER_BIND: '127.0.0.1:0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const stop = () => {
  relay.kill();
};
process.once('exit', stop);
const upstream = await new Promise<string>((resolve, reject) => {
  let output = '';
  const timeout = setTimeout(() => {
    stop();
    reject(new Error('Multiplayer did not start.'));
  }, 10_000);
  relay.stdout.on('data', chunk => {
    output += String(chunk);
    const match = /multiplayer listening on (127\.0\.0\.1:\d+)/.exec(output);
    if (match) {
      clearTimeout(timeout);
      resolve(`http://${match[1]}`);
    }
  });
  relay.once('error', error => {
    clearTimeout(timeout);
    reject(error);
  });
  relay.once('exit', code => {
    clearTimeout(timeout);
    reject(new Error(`Multiplayer exited (${code}).`));
  });
});
process.env.SLOPESMITH_MULTIPLAYER_URL = upstream;
console.log(`Multiplayer: ${upstream} (browser connections use /api/play/session)`);
process.once('SIGINT', () => {
  stop();
  process.exit(0);
});
process.once('SIGTERM', () => {
  stop();
  process.exit(0);
});
await import('./dev');
