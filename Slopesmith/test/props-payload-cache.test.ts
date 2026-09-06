// tier: fast

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PropsPayload } from '../src/core/reference/props';
import { readPersistentPropsJson, readPersistentPropsPayload } from '../src/server/props-payload-cache';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-props-cache-'));
const source = join(root, 'SOURCE'), cache = join(root, 'cache');
mkdirSync(join(source, 'Meshes'), { recursive: true });
mkdirSync(join(source, 'Collision'), { recursive: true });
writeFileSync(join(source, 'Models.json'), '{"Models":[]}');
writeFileSync(join(source, 'Instances.json'), '{"Instances":[]}');
writeFileSync(join(source, 'Materials.json'), '{"Materials":[]}');
writeFileSync(join(source, 'Meshes', 'mesh.obj'), 'v 0 0 0\n');
writeFileSync(join(source, 'Collision', 'body.obj'), 'v 0 0 0\n');

let builds = 0;
const build = async (): Promise<PropsPayload> => ({
  level: 'SOURCE', models: [], materials: [], instances: [{
    i: builds++, m: 0, p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], n: 'test', v: true,
    pc: false, pb: false, c: 0,
  }],
});

try {
  const first = await readPersistentPropsPayload('SOURCE', source, build, cache);
  const second = await readPersistentPropsPayload('SOURCE', source, build, cache);
  check(first.cache === 'miss' && second.cache === 'hit' && builds === 1,
    'a generated prop payload survives beyond the producing call');
  check(second.payload.instances[0]?.i === 0, 'a persistent hit restores the serialized payload');

  let jsonBuilds = 0;
  const jsonCache = join(root, 'json-cache');
  const serialized = () => {
    jsonBuilds++;
    return Promise.resolve(new TextEncoder().encode(JSON.stringify({
      level: 'SOURCE', models: [], materials: [], instances: [], marker: 'worker bytes',
    })));
  };
  const jsonFirst = await readPersistentPropsJson('SOURCE', source, serialized, jsonCache);
  const jsonSecond = await readPersistentPropsJson('SOURCE', source, serialized, jsonCache);
  check(jsonFirst.cache === 'miss' && jsonSecond.cache === 'hit' && jsonBuilds === 1
    && JSON.parse(jsonSecond.json.toString()).marker === 'worker bytes',
  'pre-serialized worker bytes persist and return without another build');

  writeFileSync(join(source, 'Instances.json'), '{"Instances":[{"ModelID":0}]}');
  const manifestChanged = await readPersistentPropsPayload('SOURCE', source, build, cache);
  check(manifestChanged.cache === 'miss' && builds === 2 && manifestChanged.fingerprint !== first.fingerprint,
    'an in-place manifest edit invalidates the fingerprint');

  writeFileSync(join(source, 'TextureAlpha.overrides.json'), '{"glass.png":"cutout"}');
  const alphaChanged = await readPersistentPropsPayload('SOURCE', source, build, cache);
  check(alphaChanged.cache === 'miss' && builds === 3
    && alphaChanged.fingerprint !== manifestChanged.fingerprint,
  'an alpha-sidecar edit invalidates the prop payload that carries its explicit material modes');

  writeFileSync(join(source, 'Meshes', 'mesh.obj'), 'v 1 0 0\n');
  const meshChanged = await readPersistentPropsPayload('SOURCE', source, build, cache);
  check(meshChanged.cache === 'miss' && builds === 4 && meshChanged.fingerprint !== alphaChanged.fingerprint,
    'an in-place mesh edit invalidates the fingerprint');

  const cacheFile = join(cache, 'SOURCE', `${meshChanged.fingerprint}.json`);
  writeFileSync(cacheFile, '{truncated');
  const recovered = await readPersistentPropsPayload('SOURCE', source, build, cache);
  check(recovered.cache === 'miss' && builds === 5
    && JSON.parse(readFileSync(cacheFile, 'utf8')).level === 'SOURCE',
  'a truncated persistent entry is rebuilt atomically');
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
else console.log('PERSISTENT PROP CACHE TESTS PASSED');
