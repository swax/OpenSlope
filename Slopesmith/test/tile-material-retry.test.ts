// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeTexRef } from '../src/core/paint/textures';
import { createTileMaterials } from '../src/app/viewport/mesh/tile-materials';

/**
 * A failed image page is remembered so a genuinely absent retail slot does not get requested on every
 * reference rebuild. Binding a project is the exception: a fresh tab can have rendered its recovery document
 * before the project picker resolved, and those pre-bind requests used to be 409s. The rebind must make them
 * eligible for one clean retry without throwing away successfully decoded retail pages.
 */

type LoadCall = {
  url: string;
  loaded?: (texture: THREE.Texture<HTMLImageElement>) => void;
  failed?: (error: unknown) => void;
};

const calls: LoadCall[] = [];
const originalLoad = THREE.TextureLoader.prototype.load;

try {
  THREE.TextureLoader.prototype.load = function (url, onLoad, _onProgress, onError) {
    calls.push({ url: String(url), loaded: onLoad, failed: onError });
    return new THREE.Texture<HTMLImageElement>();
  };

  let settled = 0;
  const tiles = createTileMaterials(() => { settled++; });
  const ref = makeTexRef('MESA', '0059.png');

  assert.equal(tiles.ensure(ref), null);
  assert.equal(calls.length, 1, 'the first use starts one image request');
  calls[0].failed?.(new Error('409 Conflict'));
  assert.equal(settled, 1, 'a failed page settles the pending bank build');

  assert.equal(tiles.ensure(ref), null);
  assert.equal(calls.length, 1, 'ordinary rebuilds remember a failed page and do not request-loop');

  tiles.invalidateProjectAssets();
  assert.equal(tiles.ensure(ref), null);
  assert.equal(calls.length, 2, 'binding a project clears failed retail pages for one retry');

  const loaded = new THREE.Texture<HTMLImageElement>();
  calls[1].loaded?.(loaded);
  assert.equal(tiles.ensure(ref), loaded, 'the successful retry becomes the live cached page');

  tiles.invalidateProjectAssets();
  assert.equal(tiles.ensure(ref), loaded,
    'a later project switch keeps successfully decoded workspace-owned retail pages warm');
  assert.equal(calls.length, 2, 'a successful retail page is not downloaded again on project switch');
} finally {
  THREE.TextureLoader.prototype.load = originalLoad;
}

console.log('tile-material-retry: all checks passed');
