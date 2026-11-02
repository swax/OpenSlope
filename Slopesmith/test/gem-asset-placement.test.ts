// tier: fast
import assert from 'node:assert/strict';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { assetVersion } from '../src/core/reference/asset-version';
import { referenceAssetId } from '../src/core/reference/asset-manifest';
import type { LevelProps } from '../src/core/reference/props';
import type { NativeArt } from '../src/core/export/provider';
import { specialPropNode } from '../src/core/props/special';
import { createStore } from '../src/app/state/store';
import { configureWorkspace } from '../src/app/net/workspace';
import { clearAssetCatalogue } from '../src/app/net/asset-versions';

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { getElementById: () => ({ textContent: '', className: '' }) },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { setTimeout: () => 0, setInterval: () => 0 },
});
const { createPropOps } = await import('../src/app/props/operations');
const { createViewportCallbacks } = await import('../src/app/viewport-callbacks');
const bank = assetVersion('ssx-tricky', 'TRICKY_ALASKA', 'a'.repeat(64));
const assets = [2, 3, 5].map(tier => ({
  kind: 'prop' as const,
  key: String(200 + tier),
  hash: String(tier).repeat(64),
  files: {},
  id: referenceAssetId(bank.game, bank.map, 'prop', String(200 + tier), String(tier).repeat(64)),
}));
const art: NativeArt = {
  gemLevel: 'ALASKA',
  gemTiers: [2, 3, 5].map((tier): NativeArt['gemTiers'][number] => ({
    tier,
    model: 200 + tier,
    effect: {
      key: `gem:ALASKA:${tier}`,
      circumstances: {
        collision: [
          { mainType: 14, semanticType: 'score.multiplier', payload: { MultiplierScore: tier }, references: {} },
          {
            mainType: 0,
            semanticType: 'property.node-tombstone',
            payload: { type0: { SubType: 5, DeadNodeMode: 2 } },
            references: {},
          },
        ],
      },
    },
  })),
  railSkins: {},
};
let manifestMissing = false;
let releaseArt: (() => void) | undefined;
let artWait: Promise<void> = Promise.resolve();
configureWorkspace(true, async url => {
  if (url.pathname === '/api/props/native-art') {
    await artWait;
    return Response.json(art);
  }
  if (url.pathname === '/api/levels') return Response.json({ levels: ['local:ALASKA'] });
  if (url.pathname === '/api/map-asset-version') return Response.json(bank);
  if (url.pathname === '/api/map-asset-manifest')
    return manifestMissing
      ? new Response('', { status: 404 })
      : Response.json({ schema: 'openslope-assets/v1', game: bank.game, map: bank.map, assets });
  return new Response('', { status: 404 });
});
const store = createStore({ mdoc: migrateMountain(defaultMountain()), currentMode: 'props', storedUi: {} });
const library: LevelProps = {
  level: bank.id,
  models: assets.map(asset => ({
    id: Number(asset.key),
    name: `Gem ${asset.key}`,
    subs: [
      {
        mat: -1,
        positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0]),
        uvs: new Float32Array(),
        indices: new Uint32Array([0, 1, 2]),
      },
    ],
  })),
  materials: new Map(),
  instances: [],
  crowdFrames: [],
};
const levels = new Map<string, LevelProps>([[bank.id, library]]);
for (const asset of assets)
  levels.set(asset.id, {
    ...library,
    level: asset.id,
    models: library.models.filter(model => String(model.id) === asset.key),
  });
const viewport = { registerPropModels() {}, snapPoint: (pos: number[]) => pos };
const ops = createPropOps({ store, propLevels: levels, viewport, groupDefIdx: new Map() } as unknown as Parameters<
  typeof createPropOps
>[0]);
let rebuilds = 0;
const callbacks = createViewportCallbacks({
  store,
  edit: { viewportCallbacks: {} },
  gemTool: { height: 2, spacing: 4, value: 3 },
  propOps: () => ops,
  viewport: () => viewport,
  scheduleRebuild: () => {
    rebuilds++;
  },
  rebuildTools() {},
} as unknown as Parameters<typeof createViewportCallbacks>[0]);
store.gemArmed = true;
await callbacks.onPlaceGem!([10, 2, 30]);
assert.equal(store.mdoc.gems?.length ?? 0, 0, 'new gems never save the old implicit-donor representation');
const first = store.mdoc.props!.at(-1)!;
assert.equal(first.level, assets[1].id);
assert.equal(first.model, 203);
assert.deepEqual(first.pos, [10, 2, 30]);
assert.equal(first.modePresence, 'showoff');
assert.equal(store.selectedProp, store.mdoc.props!.indexOf(first));
assert.equal(specialPropNode(store.mdoc.effects, first, 'gem')?.payload.MultiplierScore, 3);
await callbacks.onPlaceGemLine!([0, 2, 0], [8, 2, 0]);
assert.equal(store.mdoc.props!.length, 4);
assert.equal(rebuilds, 2, 'one save/undo edit per click or complete row');
assert(store.mdoc.props!.every(prop => prop.level === assets[1].id));
specialPropNode(store.mdoc.effects, first, 'gem')!.payload.MultiplierScore = 5;
assert(
  store.mdoc
    .props!.slice(1)
    .every(prop => specialPropNode(store.mdoc.effects, prop, 'gem')?.payload.MultiplierScore === 3),
);
const reloaded = migrateMountain(JSON.parse(JSON.stringify(store.mdoc)));
assert(
  reloaded.props!.every(prop => prop.level === assets[1].id),
  'save/reload retains the exact model identity',
);
for (const value of [2, 5]) {
  const [prop] = await ops.placeGems([[value, 2, 0]], value);
  assert.equal(prop.level, assets.find(asset => asset.key === String(200 + value))!.id);
}
store.mdoc.gems = [{ id: 'gem:legacy', pos: [8, 9, 10], value: 3 }];
const promoted = await ops.editableGem('gem:legacy');
assert.equal(promoted?.level, assets[1].id, 'old gems pin their artwork when opened as editable props');
assert.deepEqual(promoted?.pos, [8, 9, 10]);
assert.equal(await ops.editableGem('gem:legacy'), null);
manifestMissing = true;
clearAssetCatalogue();
const beforeFailure = JSON.stringify(store.mdoc);
assert.deepEqual(
  await ops.placeGems(
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
    2,
  ),
  [],
);
assert.equal(JSON.stringify(store.mdoc), beforeFailure, 'failed pinning cannot partially place a row');
manifestMissing = false;
artWait = new Promise(resolve => {
  releaseArt = resolve;
});
const pending = ops.placeGems([[50, 2, 30]], 2);
const abandoned = store.mdoc;
store.mdoc = migrateMountain(defaultMountain());
releaseArt!();
assert.deepEqual(await pending, []);
assert.equal(JSON.stringify(abandoned), beforeFailure, 'switching maps cancels a pending placement');
console.log(
  'Gem placement: asset2 clicks/rows/tiers, save/reload, independent effects, legacy conversion, failure and stale-map isolation PASS',
);
