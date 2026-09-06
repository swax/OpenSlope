import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPolicyCategory,
  externalPackageNames,
  installedDependencyClosure,
  readDependencyPolicy,
  renderInstalledNotices,
} from '../tools/dependency-notices.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(appRoot, 'dist-server');
if (dirname(outdir) !== appRoot || basename(outdir) !== 'dist-server') {
  throw new Error(`refusing to clean unexpected server output path: ${outdir}`);
}
await rm(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: {
    main: resolve(appRoot, 'src/server/main.ts'),
    'reference-worker': resolve(appRoot, 'src/server/workers/reference-worker.ts'),
  },
  outdir,
  entryNames: '[name]',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: true,
  sourcesContent: true,
  treeShaking: true,
  legalComments: 'none',
  metafile: true,
});

const policy = await readDependencyPolicy(appRoot);
const external = externalPackageNames(result.metafile);
assertPolicyCategory('NOTICE server-external dependencies', external, policy.server);

const thirdPartyDir = resolve(outdir, 'ThirdPartyNotices');
await mkdir(thirdPartyDir, { recursive: true });
const closure = await installedDependencyClosure(appRoot, external);
const notices = await renderInstalledNotices(closure,
  'Slopesmith server deployment — installed external runtime licenses and notices');
await writeFile(resolve(thirdPartyDir, 'npm-server-externals.txt'), notices, 'utf8');
await writeFile(resolve(outdir, 'dependency-manifest.json'), `${JSON.stringify({
  version: 1,
  build: 'esbuild packages=external',
  externalPackages: [...external].sort(),
  installedRuntimeClosure: closure.map(({ path, name, version }) => ({ path, name, version })),
}, null, 2)}\n`, 'utf8');
