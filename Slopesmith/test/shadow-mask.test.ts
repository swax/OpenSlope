// tier: fast
import assert from 'node:assert/strict';
import { textureShadowMask, shadowMaskVisible } from '../src/core/lighting/shadow-mask';
import { lightingGeometry } from '../src/core/lighting/occluders';
import { bakeSunShadow, bakeAO } from '../src/core/lighting/occlusion';
import { terrainLightingKeys } from '../src/app/viewport/mesh/lighting-client';
import { preparePropShadowMasks } from '../src/core/export/shadow-masks';
import { placedPropOccluders, type ModelGeometry } from '../src/core/export/props';
import type { PlacedProp } from '../src/core/doc/types';

const image = { w: 2, h: 2, data: new Uint8Array([40, 80, 20, 255, 40, 80, 20, 0, 40, 80, 20, 0, 40, 80, 20, 255]) };
const mask = textureShadowMask(image, { pixelAlpha: true })!;
assert(mask, 'the cutout image produces a mask');
assert.equal(textureShadowMask(image, {}), undefined, 'native opaque policy ignores texture alpha');
assert.equal(
  textureShadowMask(image, { mode: 'opaque', pixelAlpha: true }),
  undefined,
  'explicit opaque overrides pixels',
);
assert.equal(textureShadowMask(image, { mode: 'glow' }), null, 'emissive glow sheets do not cast hard shadows');
const transparent = { ...image, data: image.data.map((_v, i) => (i % 4 === 3 ? 0 : 80)) };
assert.equal(textureShadowMask(transparent, { pixelAlpha: true }), null);
assert.equal(textureShadowMask(transparent, {}), undefined, 'even clear alpha is ignored by native opaque surfaces');
const glass = { ...image, data: image.data.map((_v, i) => (i % 4 === 3 ? 120 : 80)) };
assert.equal(textureShadowMask(glass, { alphaPass: true }), null, 'translucent sheets do not cast opaque shadows');
assert.equal(
  textureShadowMask(undefined, { pixelAlpha: true }),
  undefined,
  'unavailable pixels keep the mesh fallback',
);
assert(shadowMaskVisible(mask, 0.25, 0.75));
assert(!shadowMaskVisible(mask, 0.75, 0.75), 'image row 0 is UV top, matching TextureLoader.flipY');
assert(!shadowMaskVisible(mask, 0.25, 0.25));
assert(shadowMaskVisible(mask, 0.75, 0.25));
assert.equal(shadowMaskVisible(mask, -0.25, 1.75), shadowMaskVisible(mask, 0.75, 0.75), 'negative/repeated UVs wrap');

const indices = new Uint32Array([0, 2, 1, 1, 2, 3]);
const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10]);
const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
const roof = {
  positions: new Float32Array([0, 3, 0, 10, 3, 0, 0, 3, 10, 10, 3, 10]),
  indices,
  uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
  mask: { width: 2, height: 1, alpha: new Uint8Array([255, 0]), cutoff: 128 },
};
const geometry = lightingGeometry({ positions, indices }, [roof]);
const query = new Float32Array([2.5, 0, 5, 7.5, 0, 5]);
const shadow = bakeSunShadow(geometry.positions, geometry.indices, [0, 1, 0], 128, query, geometry.cutouts);
assert.deepEqual(Array.from(shadow), [0, 1], 'real triangles cast shadows only through their opaque texels');
const solid = lightingGeometry({ positions, indices }, [{ ...roof, mask: undefined }]);
const queryNormals = new Float32Array([0, 1, 0, 0, 1, 0]);
const ao = bakeAO(
  geometry.positions,
  geometry.indices,
  normals,
  16,
  128,
  { positions: query, normals: queryNormals },
  geometry.cutouts,
);
const solidAO = bakeAO(solid.positions, solid.indices, normals, 16, 128, { positions: query, normals: queryNormals });
assert(ao[1] > solidAO[1] + 0.1, 'transparent texels also admit ambient sky light');
const underneath = { positions: roof.positions.map((v, i) => (i % 3 === 1 ? 1 : v)), indices };
const layers = lightingGeometry({ positions, indices }, [underneath, roof]);
assert.deepEqual(
  Array.from(bakeSunShadow(layers.positions, layers.indices, [0, 1, 0], 128, query, layers.cutouts)),
  [0, 0],
  'a transparent foreground texel never erases a solid blocker behind it',
);
const fallback = lightingGeometry({ positions, indices }, [{ ...roof, uvs: undefined }]);
assert.deepEqual(
  Array.from(bakeSunShadow(fallback.positions, fallback.indices, [0, 1, 0], 128, query, fallback.cutouts)),
  [0, 0],
  'missing UVs retain the opaque geometry fallback',
);

const input = { positions, indices, normals, dir: [0, 1, 0] as [number, number, number], rig: null, occluders: [roof] };
const keys = await terrainLightingKeys(input);
for (const changed of [
  { ...roof, uvs: roof.uvs.map(v => v * 0.5) },
  { ...roof, mask: { ...roof.mask, alpha: new Uint8Array([0, 255]) } },
  { ...roof, mask: { ...roof.mask, cutoff: 64 } },
  { ...roof, mask: { ...roof.mask, width: 1, height: 2 } },
]) {
  const next = await terrainLightingKeys({ ...input, occluders: [changed] });
  assert.notEqual(next.ao, keys.ao);
  assert.notEqual(next.shadow, keys.shadow);
  assert.equal(next.glow, keys.glow);
}

const model: ModelGeometry = { subs: [{ mat: 0, positions: roof.positions, indices, uvs: roof.uvs }] };
const prop: PlacedProp = { level: 'DONOR', model: 0, name: 'Fence', pos: [0, 0, 0], scale: 1, yaw: 0 };
let reads = 0;
const resolve = await preparePropShadowMasks(
  [prop, { ...prop, model: 1 }],
  () => model,
  () => ({ tex: 'leaves.png', frames: [], pixelAlpha: true }),
  async () => {
    reads++;
    return image;
  },
);
assert.equal(reads, 1, 'instances/models sharing a texture read its pixels once');
assert(resolve(prop, model.subs[0]));
const cutouts = placedPropOccluders([prop], () => model, resolve);
assert.equal(cutouts[0].mask!.alpha.length, 4);
assert.deepEqual(
  placedPropOccluders(
    [prop],
    () => model,
    () => null,
  ),
  [],
  'nonblocking materials contribute no occluder',
);
const failed = await preparePropShadowMasks(
  [prop],
  () => model,
  () => ({ tex: 'missing.png', frames: [], pixelAlpha: true }),
  async () => {
    throw new Error('unavailable');
  },
);
assert.equal(failed(prop, model.subs[0]), undefined);
console.log(
  'SHADOW MASK PASS: material policy, UV orientation/wrapping, sun/AO holes, layered blockers, cache keys and export lookups',
);
