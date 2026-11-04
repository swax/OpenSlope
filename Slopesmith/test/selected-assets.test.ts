// tier: fast
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from '../src/server/fs-async';
import { readAssetManifest } from '../src/shared/map-asset-manifest';
import { manifestAsset } from '../src/core/reference/asset-manifest';
import { createAssetReader } from '../src/app/net/asset-reader';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { fetchRuntimeAssetReplacement, setRuntimeAssetReplacements } from '../src/app/net/asset-replacements';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-selected-assets-'));
const level = 'SSX3_ABC1',
  bank = join(root, level);
await mkdir(join(bank, 'Meshes'), { recursive: true });
await mkdir(join(bank, 'Textures'));
const save = (name: string, value: unknown) => writeFile(join(bank, name), JSON.stringify(value));
await save('Import.json', { Game: 'ssx-3' });
await save('Models.json', {
  Models: ['Tree', 'Unrelated'].map((ModelName, id) => ({
    ModelName,
    ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: `${id}.obj`, MaterialID: id }] }],
  })),
});
await save('Instances.json', {
  Instances: [0, 1].map(ModelID => ({ ModelID, Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1] })),
});
await save('Materials.json', { Materials: [{ TexturePath: 'tree_o.png' }, { TexturePath: 'unrelated.png' }] });
for (const id of [0, 1]) await writeFile(join(bank, `Meshes/${id}.obj`), 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n');
await writeFile(join(bank, 'Textures/tree_o.png'), new Uint8Array([1, 2, 3]));
await writeFile(join(bank, 'Textures/unrelated.png'), new Uint8Array([4, 5, 6]));
const io = { root, ...fs },
  full = await readAssetManifest(io, level);
const reads: string[] = [];
const counted = {
  ...io,
  async readTextOrNull(path: string) {
    reads.push(path);
    return io.readTextOrNull(path);
  },
  async readBytesOrNull(path: string) {
    reads.push(path);
    return io.readBytesOrNull(path);
  },
  async readJsonOr<T>(path: string, fallback: T) {
    reads.push(path);
    return io.readJsonOr(path, fallback);
  },
};
const selection = { textures: [], props: [], names: ['tree'], bodies: [] };
const selected = await readAssetManifest(counted, level, undefined, selection);
assert.deepEqual(
  selected.assets,
  full.assets.filter(asset => asset.key === 'tree_o.png' || (asset.kind === 'prop' && asset.key === '0')),
);
assert(
  !reads.some(path => /1\.obj$|unrelated\.png$/.test(path)),
  'matching a prop does not decode/hash unrelated geometry or texture bytes',
);
reads.length = 0;
await readAssetManifest(counted, level, undefined, { ...selection, names: [], textures: ['tree_o.png'] });
assert(
  !reads.some(path => /Models\.json$|Instances\.json$|Effects\.json$|\.obj$/.test(path)),
  'texture-only matching never loads model banks',
);

let fullManifestReads = 0;
const payload = await buildLevelPropsUncached(io, level);
const reader = createAssetReader(async input => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/levels')
    return Response.json({ levels: [`local:${level}`], maps: [{ name: `local:${level}`, source: 'local' }] });
  if (url.pathname === '/api/map-asset-manifest') {
    if (url.searchParams.has('select')) return Response.json(selected);
    fullManifestReads++;
    throw new Error('Unexpected full bank read');
  }
  return Response.json(payload);
});
await reader.selectedManifest(`local:${level}`, selection);
const prop = manifestAsset(selected, 'prop', '0')!;
assert.deepEqual(
  await reader.crowdFrames(prop.id, ['tree_o.png']),
  [manifestAsset(selected, 'texture', 'tree_o.png')!.id],
  'selected shared animation frames resolve without rebuilding a full bank',
);
assert.equal((await reader.fetch(`/api/props?level=${encodeURIComponent(prop.id)}`)).status, 200);
assert.equal(fullManifestReads, 0, 'verified selected metadata is reused by the exact reader');

const old = prop.id.replace(':prop:0:', ':prop:17:').replace(prop.hash, 'f'.repeat(64));
setRuntimeAssetReplacements([{ original: old, replacement: prop }]);
const requested: string[] = [];
const response = await fetchRuntimeAssetReplacement(
  `/api/props?level=${encodeURIComponent(old)}`,
  undefined,
  async input => {
    const url = new URL(String(input), 'http://localhost');
    requested.push(url.searchParams.get('level')!);
    return reader.fetch(input);
  },
);
const view = await response!.json();
assert.equal(view.level, old);
assert.equal(view.models[0].id, 17, 'editor geometry occupies the saved model slot without changing the document');
assert.deepEqual(requested, [prop.id], 'only the real replacement identity reaches the immutable response cache');
assert.equal(
  await fetchRuntimeAssetReplacement(
    `https://example.test/api/props?level=${encodeURIComponent(old)}`,
    undefined,
    async () => {
      throw new Error('External requests are not replacement views');
    },
  ),
  undefined,
);
assert.equal(
  await fetchRuntimeAssetReplacement(`/api/props?level=${encodeURIComponent(old)}`, { method: 'POST' }, async () => {
    throw new Error('Writes are not replacement views');
  }),
  undefined,
);
setRuntimeAssetReplacements([]);
console.log(
  'Selected assets PASS: identical identities, no unrelated geometry/hashes, reused descriptors and runtime-only editor slots',
);
