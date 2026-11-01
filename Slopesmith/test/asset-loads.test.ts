// tier: fast
import assert from 'node:assert/strict';
import {
  beginPropLoad,
  propLoadState,
  reportPropModels,
  reportTextureLoad,
  setAssetLoadScope,
  textureLoadState,
} from '../src/app/state/asset-loads';

assert.equal(propLoadState('UNKNOWN', 7), 'loading');
const failed = beginPropLoad('UNKNOWN');
assert.equal(propLoadState('UNKNOWN', 7), 'loading');
failed();
assert.equal(propLoadState('UNKNOWN', 7), 'missing');
const stale = beginPropLoad('UNKNOWN');
beginPropLoad('UNKNOWN');
stale();
assert.equal(propLoadState('UNKNOWN', 7), 'loading', 'an older error never overwrites a pending retry');
reportPropModels('UNKNOWN', [7]);
assert.equal(propLoadState('UNKNOWN', 7), 'ready');
assert.equal(propLoadState('UNKNOWN', 8), 'missing', 'a loaded catalogue can confirm an absent model');
stale();
assert.equal(propLoadState('UNKNOWN', 7), 'ready');
setAssetLoadScope('first');
reportPropModels('@models', [7]);
setAssetLoadScope('second');
assert.equal(propLoadState('@models', 7), 'loading', 'authored model IDs stay scoped to their mountain');
reportTextureLoad('first/Custom/snow.png', 'missing');
assert.equal(textureLoadState('second/Custom/snow.png'), 'loading');
reportTextureLoad('first/Custom/snow.png', 'loading');
assert.equal(textureLoadState('first/Custom/snow.png'), 'loading');
reportTextureLoad('first/Custom/snow.png', 'ready');
assert.equal(textureLoadState('first/Custom/snow.png'), 'ready');
console.log('Asset loads: pending, confirmed absence, retry, recovery and project isolation PASS');
