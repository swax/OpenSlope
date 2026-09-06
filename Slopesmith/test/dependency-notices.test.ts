import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packageRootFromModuleId,
  installedDependencyClosure,
  readDependencyPolicy,
  recordsFromModuleIds,
  renderInstalledNotices,
} from '../tools/dependency-notices.mjs';
import { check, failures } from './check';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const policy = await readDependencyPolicy(appRoot);
check([...policy.browser].sort().join(',') ===
  ['lil-gui', 'livekit-client', 'three', 'three-mesh-bvh'].join(','),
'NOTICE identifies the four browser-bundled direct dependencies');
check([...new Set([...policy.browser, ...policy.server])].sort().join(',') ===
  Object.keys(policy.manifest.dependencies ?? {}).sort().join(','),
'browser and server NOTICE categories cover runtime dependencies in both directions');
check([...policy.development].sort().join(',') ===
  Object.keys(policy.manifest.devDependencies ?? {}).sort().join(','),
'development-only NOTICE category covers devDependencies in both directions');

const moduleIds = [...policy.browser].map((name) => join(appRoot, 'node_modules', ...name.split('/'), 'index.js'));
const records = await recordsFromModuleIds(moduleIds, appRoot);
const livekit = records.find((record) => record.name === 'livekit-client');
check(livekit?.version === '2.22.2' && livekit.legalFiles.join(',') === 'LICENSE',
'installed LiveKit client contributes its Apache LICENSE and does not invent an absent NOTICE');
const report = await renderInstalledNotices(records, 'test browser notices');
check(report.includes('livekit-client@2.22.2') && report.includes('Apache License'),
'generated browser legal text carries the installed LiveKit license');
const closure = await installedDependencyClosure(appRoot, policy.browser);
check(closure.some((record) => record.name === '@livekit/protocol')
  && closure.some((record) => record.name === 'sdp-transform'),
'browser legal inventory follows runtime dependencies hidden inside prebundled LiveKit ESM');
check(packageRootFromModuleId('C:/app/node_modules/@scope/pkg/dist/index.js')?.replaceAll('\\', '/') ===
  'C:/app/node_modules/@scope/pkg',
'module ids resolve to scoped installed package roots');

if (failures) process.exitCode = 1;
else console.log('DEPENDENCY NOTICES PASS');
