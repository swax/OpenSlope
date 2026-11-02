// tier: fast
import assert from 'node:assert/strict';
import { createAssetMigrationVerifier } from '../src/core/reference/asset-migration-verifier';
import { previewAssetMigration, applyAssetMigration } from '../src/core/reference/asset-migration';
import { assetDefinitionHash, propAssetDefinition, sha256 } from '../src/core/reference/asset-hash';
import { referenceAssetId, type ReferenceAsset, type ReferenceAssetKind } from '../src/core/reference/asset-manifest';
import { assetVersion } from '../src/core/reference/asset-version';
import type { PropsPayload } from '../src/core/reference/props';

const bytes = new Uint8Array([1, 2, 3]);
const imageHash = await sha256(bytes);
const payload: PropsPayload = {
  level: 'GARI',
  models: [{ id: 19, name: 'Tree', subs: [{ mat: 0, pos: 'positions', uv: 'uvs', idx: 'indices' }] }],
  materials: [{ id: 0, tex: 'tile.png', frames: ['frame.png'] }],
  physicsBodies: [{ id: 7, sph: 'spheres', com: [1, 2, 3], ii: 'inertia' }],
  instances: [],
};
async function asset(kind: ReferenceAssetKind, key: string): Promise<ReferenceAsset> {
  const definition =
    kind === 'prop' ? propAssetDefinition(payload, key) : kind === 'body' ? payload.physicsBodies![0] : undefined;
  const payloadHash = definition ? await assetDefinitionHash(definition, {}) : undefined;
  const files =
    kind === 'body'
      ? {}
      : { 'textures/tile.png': imageHash, ...(kind === 'prop' ? { 'textures/frame.png': imageHash } : {}) };
  const hash = kind === 'texture' ? imageHash : await assetDefinitionHash(definition, files);
  return {
    id: referenceAssetId('ssx-tricky', 'TRICKY_GARI', kind, key, hash),
    game: 'ssx-tricky',
    map: 'TRICKY_GARI',
    kind,
    key,
    hash,
    files,
    ...(payloadHash ? { payloadHash } : {}),
  };
}
const texture = await asset('texture', 'tile.png'),
  prop = await asset('prop', '19'),
  body = await asset('body', '7');
const reads: string[] = [];
function verifier(options: { payload?: PropsPayload; differentImage?: string; unavailable?: boolean } = {}) {
  return createAssetMigrationVerifier({
    async texture(level, name) {
      reads.push(`${level}/${name}`);
      if (options.unavailable) throw new Error('offline');
      return name === options.differentImage ? new Uint8Array([9]) : bytes;
    },
    async props(level) {
      reads.push(level);
      if (options.unavailable) throw new Error('offline');
      return options.payload ?? payload;
    },
  });
}
const reference = (asset: ReferenceAsset) => ({ level: 'GARI', kind: asset.kind, key: asset.key });
const verify = verifier();
assert.equal(await verify(reference(texture), texture), true);
assert.equal(await verify(reference(prop), prop), true);
assert.equal(await verify(reference(body), body), true);
assert.equal(reads.filter(read => read === 'GARI/tile.png').length, 1, 'shared images are hashed once per preview');
assert.equal(reads.filter(read => read === 'GARI').length, 1, 'props and bodies share one current payload');
assert(
  reads.every(read => !read.includes('asset2:')),
  'verification reads the old reference, never the proposed identity',
);
assert.equal(await verifier({ differentImage: 'tile.png' })(reference(texture), texture), false);
assert.equal(
  await verifier({ differentImage: 'frame.png' })(reference(prop), prop),
  false,
  'flipbook dependencies must match',
);
for (const change of ['geometry', 'material', 'body'] as const) {
  const changed = structuredClone(payload);
  if (change === 'geometry') changed.models[0].subs[0].pos = 'different';
  if (change === 'material') changed.materials[0].blend = true;
  if (change === 'body') changed.physicsBodies![0].ii = 'different';
  const selected = change === 'body' ? body : prop;
  assert.equal(
    await verifier({ payload: changed })(reference(selected), selected),
    false,
    `${change} changes must not be verified`,
  );
}
assert.equal(await verifier({ unavailable: true })(reference(texture), texture), undefined);
assert.equal(await verifier({ unavailable: true })(reference(prop), prop), undefined);
assert.equal(await verifier()(reference(prop), { ...prop, payloadHash: undefined }), undefined);
assert.equal(
  await verifier()(reference(prop), { ...prop, files: {} }),
  undefined,
  'incomplete dependency hashes cannot certify a prop',
);

const doc = {
  quadTex: { a: 'GARI/tile.png', b: 'GARI/tile.png' },
  props: [{ level: 'GARI', model: 19, nativeCollision: { physicsSource: { level: 'GARI', body: 7 } } }],
};
const sources = {
  maps: async () => [
    { name: 'local:TRICKY_GARI', source: 'local' as const },
    { name: 'server:TRICKY_GARI', source: 'server' as const },
  ],
  manifest: async () => ({
    schema: 'openslope-assets/v1' as const,
    game: prop.game,
    map: prop.map,
    assets: [texture, prop, body],
  }),
  version: async () => assetVersion(prop.game, prop.map, 'a'.repeat(64)),
};
const before = structuredClone(doc);
const preview = await previewAssetMigration(doc, { ...sources, verify: verifier() });
assert(preview.rows.every(row => row.status === 'matching'));
assert(preview.rows.every(row => row.source === 'local:TRICKY_GARI'));
assert.deepEqual(
  preview.rows.filter(row => row.from === 'GARI').map(row => [row.kind, row.key]),
  [
    ['prop', '19'],
    ['body', '7'],
  ],
  'source labels can distinguish a model from its physics body in the same bank',
);
assert.equal(preview.rows[0].paths.length, 2);
assert.deepEqual(doc, before, 'checking hashes does not change the map');
const migrated = applyAssetMigration(
  doc,
  preview,
  preview.rows.map(row => row.id),
);
assert.equal(migrated.quadTex.a, texture.id);
assert.equal(migrated.props[0].level, prop.id);
assert.equal(migrated.props[0].nativeCollision.physicsSource.level, body.id);
const mismatched = await previewAssetMigration(doc, { ...sources, verify: verifier({ differentImage: 'tile.png' }) });
assert.equal(mismatched.rows[0].status, 'different');
const unavailable = await previewAssetMigration(doc, { ...sources, verify: verifier({ unavailable: true }) });
assert(unavailable.rows.every(row => row.status === 'current'));
const matchingServer = await previewAssetMigration(doc, {
  ...sources,
  manifest: async location => ({
    ...(await sources.manifest()),
    assets: location.startsWith('local:') ? [{ ...texture, hash: 'b'.repeat(64) }] : [texture, prop, body],
  }),
  verify: verifier(),
});
assert.equal(matchingServer.rows[0].source, 'server:TRICKY_GARI', 'a byte match beats stale local metadata');
console.log(
  'ASSET MIGRATION VERIFIER PASS: exact current texture/prop/body matches, changed geometry/materials/flipbooks, unavailable bytes, grouped apply and matching-source selection.',
);
