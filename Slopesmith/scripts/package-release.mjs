import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedDependencyClosure } from '../tools/dependency-notices.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
if (
  process.platform !== 'linux' ||
  !['x64', 'arm64'].includes(process.arch) ||
  process.versions.node.split('.')[0] !== '24'
)
  throw new Error('Build the release on its target Linux architecture with Node 24.');
const revision =
  option('--revision') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: app, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('A release requires its full source commit.');
const output = resolve(option('--output') ?? join(app, 'temp', 'releases'));
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, '.package-'));
if (dirname(stage) !== output) throw new Error('Unexpected packaging temporary directory.');
try {
  for (const directory of ['dist', 'dist-server', 'ThirdPartyNotices'])
    await cp(join(app, directory), join(stage, directory), { recursive: true, dereference: true });
  await mkdir(join(stage, 'deploy'));
  for (const name of [
    'release_manager.py',
    'deploy-slopesmith',
    'slopesmith-update-runner',
    'install-updater.sh',
    'run-api',
    'slopesmith.service',
    'slopesmith-multiplayer.service',
    'slopesmith.slice',
    'slopesmith.target',
    'slopesmith-update.service',
    'slopesmith-update.path',
    'slopesmith-update.conf',
    'slopesmith.env.example',
    'Caddyfile.example',
    'install-livekit.sh',
  ])
    await copyFile(join(app, 'deploy', name), join(stage, 'deploy', name));
  const dependencies = JSON.parse(await readFile(join(app, 'dist-server', 'dependency-manifest.json'), 'utf8'));
  const closure = await installedDependencyClosure(app, dependencies.externalPackages);
  for (const record of closure) {
    const source = await realpath(record.root);
    if (relative(join(app, 'node_modules'), source).startsWith('..'))
      throw new Error('Dependency escapes node_modules.');
    await mkdir(dirname(join(stage, record.path)), { recursive: true });
    // A parent package copy includes its nested dependency roots; later copies are harmless.
    await cp(source, join(stage, record.path), { recursive: true, dereference: true });
  }
  await mkdir(join(stage, 'runtime', 'bin'), { recursive: true });
  await copyFile(process.execPath, join(stage, 'runtime', 'bin', 'node'));
  await chmod(join(stage, 'runtime', 'bin', 'node'), 0o755);
  const runtimeLicense = option('--node-license') ?? join(dirname(process.execPath), '..', 'LICENSE');
  await copyFile(runtimeLicense, join(stage, 'runtime', 'LICENSE'));
  await mkdir(join(stage, 'multiplayer'), { recursive: true });
  await copyFile(
    join(app, 'multiplayer', 'target', 'release', 'slopesmith-multiplayer'),
    join(stage, 'multiplayer', 'slopesmith-multiplayer'),
  );
  await chmod(join(stage, 'multiplayer', 'slopesmith-multiplayer'), 0o755);
  await cp(
    join(app, 'multiplayer', 'target', 'release', 'ThirdPartyNotices'),
    join(stage, 'multiplayer', 'ThirdPartyNotices'),
    { recursive: true },
  );
  for (const name of ['NOTICE', 'LICENSE']) await copyFile(join(app, name), join(stage, name));
  await writeFile(
    join(stage, 'package.json'),
    JSON.stringify({ name: 'slopesmith-release', private: true, type: 'module' }) + '\n',
  );
  await writeFile(join(stage, '.slopesmith-revision'), revision + '\n');
  const protocol = await readFile(join(app, 'src', 'core', 'session', 'protocol.ts'), 'utf8');
  const play = await readFile(join(app, 'src', 'core', 'session', 'play-protocol.generated.ts'), 'utf8');
  const metadata = {
    revision,
    platform: `linux-${process.arch}`,
    node: process.version,
    documentProtocol: Number(/DOCUMENT_VERSION = (\d+)/.exec(protocol)[1]),
    coreProtocol: /CORE_VERSION = '([^']+)'/.exec(protocol)[1],
    playProtocol: Number(/PLAY_PROTOCOL_VERSION = (\d+)/.exec(play)[1]),
    dataFormat: 1,
    livekit: /LIVEKIT_VERSION="([^"]+)"/.exec(await readFile(join(app, 'deploy', 'install-livekit.sh'), 'utf8'))[1],
    lockDigest: createHash('sha256')
      .update(await readFile(join(app, 'package-lock.json')))
      .digest('hex'),
  };
  await writeFile(join(stage, 'release-input.json'), JSON.stringify(metadata));
  execFileSync(process.env.PYTHON ?? 'python3', [join(app, 'deploy', 'release_manager.py'), 'package', stage, output], {
    stdio: 'inherit',
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}
