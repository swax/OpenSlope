// tier: fast
import assert from 'node:assert/strict';
import { createAssetUpgrades } from '../src/app/state/asset-upgrades';
import {
  previewAssetMigration,
  upgradeExactAssetReferences,
  type AssetMigrationSources,
} from '../src/core/reference/asset-migration';
import { referenceAssetId, type ReferenceAssetKind } from '../src/core/reference/asset-manifest';
import { assetVersion } from '../src/core/reference/asset-version';

const game = 'ssx-tricky',
  map = 'TRICKY_GARI';
const original = assetVersion(game, map, 'a'.repeat(64));
const missing = assetVersion(game, map, 'b'.repeat(64));
const asset = (kind: ReferenceAssetKind, key: string) => ({
  ...original,
  kind,
  key,
  files: {},
  id: referenceAssetId(game, map, kind, key, 'c'.repeat(64)),
  hash: 'c'.repeat(64),
});
const texture = asset('texture', 'tile.png'),
  prop = asset('prop', '19'),
  body = asset('body', '7');
const sources: AssetMigrationSources = {
  maps: async () => [{ name: 'local:TRICKY_GARI', source: 'local' }],
  manifest: async () => ({ schema: 'openslope-assets/v1', game, map, assets: [texture, prop, body] }),
  version: async () => original,
  verify: async reference => (reference.level === 'GARI' ? true : reference.level === 'local:GARI' ? false : undefined),
};
const makeDoc = () => ({
  name: 'Local course',
  quadTex: {
    exact: `${original.id}/tile.png`,
    current: 'GARI/tile.png',
    replacement: `${missing.id}/tile.png`,
    different: 'local:GARI/tile.png',
    unverified: 'server:GARI/tile.png',
    own: 'Custom/mine.png',
  },
  props: [{ level: original.id, model: 19, nativeCollision: { physicsSource: { level: original.id, body: 7 } } }],
});
const doc = makeDoc();
const preview = await previewAssetMigration(doc, sources);
doc.name = 'Edited while checking';
assert.equal(upgradeExactAssetReferences(doc, preview), 4);
assert.equal(doc.quadTex.exact, texture.id);
assert.equal(doc.quadTex.current, texture.id);
assert.equal(doc.props[0].level, prop.id);
assert.equal(doc.props[0].nativeCollision.physicsSource.level, body.id);
assert.equal(doc.name, 'Edited while checking');
assert.equal(doc.quadTex.replacement, `${missing.id}/tile.png`);
assert.equal(doc.quadTex.different, 'local:GARI/tile.png');
assert.equal(doc.quadTex.unverified, 'server:GARI/tile.png');
assert.equal(doc.quadTex.own, 'Custom/mine.png');
assert.equal(upgradeExactAssetReferences(doc, preview), 0, 'an upgrade is idempotent');
const edited = makeDoc();
const editedPreview = await previewAssetMigration(edited, sources);
edited.quadTex.exact = 'Custom/new.png';
edited.props[0].model = 20;
edited.props[0].nativeCollision.physicsSource.body = 8;
assert.equal(upgradeExactAssetReferences(edited, editedPreview), 1, 'new texture/model/body choices survive discovery');
assert.equal(edited.quadTex.exact, 'Custom/new.png');
assert.equal(edited.props[0].level, original.id);
assert.equal(edited.props[0].nativeCollision.physicsSource.level, original.id);

let document = makeDoc(),
  context = 'project1:workspace1',
  writable = true,
  writes = 0;
let nextSources = sources;
const persisted: string[] = [];
const upgrades = createAssetUpgrades({
  getDoc: () => document,
  context: () => context,
  writable: () => writable,
  sources: () => nextSources,
  changed: count => {
    writes++;
    persisted.push(JSON.stringify(document));
    assert(count > 0);
  },
});
await upgrades.request();
assert.equal(writes, 1);
assert.equal(JSON.parse(persisted[0]).quadTex.exact, texture.id, 'normal persistence receives upgraded references');
await upgrades.request();
assert.equal(writes, 1, 'reopening an upgraded map needs no additional write');
for (const change of ['project', 'workspace', 'document', 'permissions', 'preview'] as const) {
  document = makeDoc();
  context = 'project1:workspace1';
  writable = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let started!: () => void;
  const checking = new Promise<void>(resolve => {
    started = resolve;
  });
  nextSources = {
    ...sources,
    maps: async () => {
      started();
      await gate;
      return sources.maps();
    },
  };
  const pending = upgrades.request();
  await checking;
  if (change === 'project') context = 'project2:workspace1';
  if (change === 'workspace') context = 'project1:workspace2';
  if (change === 'document') document = makeDoc();
  if (change === 'permissions' || change === 'preview') writable = false;
  release();
  await pending;
  assert.equal(writes, 1, `${change} while checking prevents an outdated upgrade`);
  assert.equal(document.quadTex.exact, `${original.id}/tile.png`);
}
writable = false;
let checkedReadOnly = false;
nextSources = {
  ...sources,
  maps: async () => {
    checkedReadOnly = true;
    return sources.maps();
  },
};
await upgrades.request();
assert.equal(checkedReadOnly, false, 'read-only maps do not run automatic migration');
writable = true;
nextSources = {
  ...sources,
  manifest: async () => {
    throw new Error('local assets not loaded');
  },
};
await upgrades.request();
assert.equal(writes, 1, 'unavailable local assets leave the saved references alone');
nextSources = sources;
await upgrades.request();
assert.equal(writes, 2, 'discovery can retry when the original assets become available');
assert.equal(document.quadTex.exact, texture.id);
document = makeDoc();
const oldDocument = document;
let release!: () => void, started!: () => void;
const checking = new Promise<void>(resolve => {
  started = resolve;
});
const gate = new Promise<void>(resolve => {
  release = resolve;
});
let first = true;
nextSources = {
  ...sources,
  maps: async () => {
    if (first) {
      first = false;
      started();
      await gate;
    }
    return sources.maps();
  },
};
const oldRequest = upgrades.request();
await checking;
document = makeDoc();
context = 'project3:workspace1';
const newRequest = upgrades.request();
release();
await Promise.all([oldRequest, newRequest]);
assert.equal(oldDocument.quadTex.exact, `${original.id}/tile.png`);
assert.equal(document.quadTex.exact, texture.id, 'a queued request checks the newest project after a switch');
assert.equal(writes, 3);
console.log(
  'ASSET UPGRADES PASS: exact-only automatic upgrades, persistent callbacks, concurrent edits, project/workspace switches, read-only/preview guards, retries and idempotence.',
);
