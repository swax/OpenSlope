// tier: fast
import assert from 'node:assert/strict';
import {
  attenuateRiderLight,
  evaluateRiderLight,
  fallbackRiderLight,
  RiderLightField,
  sampleReferenceRiderLight,
} from '../src/core/lighting/rider-light';
import { referenceGroundLightSampler } from '../src/app/viewport/mesh/reference-lighting';
import { groundLightingFixture } from './reference-ground-light.fixture';
import type { V3 } from '../src/core/doc/types';

const close = (actual: V3 | null, expected: V3) => {
  assert(actual);
  for (let c = 0; c < 3; c++) assert(Math.abs(actual[c] - expected[c]) < 1e-6, `${actual} != ${expected}`);
};
const { data, geometry, sample } = groundLightingFixture([0.1, 0.2, 0.3]);
close(sample([0, 1, 0]), [0.1, 0.2, 0.3]);
close(sample([0, 9, 0]), [0.8, 0.7, 0.6]);
close(sample([20, 1, 0]), [1, 1, 1]);
assert.equal(sample([40, 1, 0]), null, 'Legacy probes must not receive a second baked attenuation');
assert.equal(sample([100, 1, 0]), null, 'No ground keeps the source rig');
assert.equal(sample([0, -1, 0]), null, 'Do not sample a surface overhead');
const light = { ambient: [0.2, 0.4, 0.6] as V3, keys: [{ color: [0.5, 0.4, 0.3] as V3, direction: [0, 1, 0] as V3 }] };
const lit = attenuateRiderLight(light, sample([0, 1, 0])!);
close(evaluateRiderLight(lit, [0, 1, 0]), [0.07, 0.16, 0.27]);
assert.deepEqual(light.ambient, [0.2, 0.4, 0.6], 'Sampling one actor cannot change the shared source rig');
const saved = data.lightColor;
data.lightColor = undefined;
assert.equal(sample([0, 1, 0]), null);
data.lightColor = saved;
close(sample([0, 1, 0]), [0.1, 0.2, 0.3]);
assert.equal(referenceGroundLightSampler(geometry, { ...data, patchLightmapMultiply: undefined }), null);
geometry.dispose();
const vertex = groundLightingFixture([0.1, 0.2, 1.25], 'vertex');
close(vertex.sample([0, 1, 0]), [0.1, 0.2, 1.25]);
close(vertex.sample([0, 9, 0]), [0.8, 0.7, 0.6]);
const empty = new RiderLightField([]);
const fallback = sampleReferenceRiderLight(empty, [0, 1, 0], vertex.sample([0, 1, 0]), true)!;
close(fallback.ambient, [0.06, 0.12, 0.75]);
close(fallback.keys[0].color, [0.04, 0.08, 0.5]);
assert.equal(sampleReferenceRiderLight(empty, [100, 1, 0], vertex.sample([100, 1, 0]), true), null);
const probes = new RiderLightField([{ position: [0, 1, 0], ambient: [0.3, 0.4, 0.5], keys: [] }]);
close(sampleReferenceRiderLight(probes, [0, 1, 0], vertex.sample([0, 1, 0]), true)!.ambient, [0.3, 0.4, 0.5]);
close(
  evaluateRiderLight(fallbackRiderLight(), [0, 1, 0]),
  Array(3).fill(0.6 + (0.4 * 0.8) / Math.hypot(0.3, 0.8, 0.5)) as V3,
);
vertex.geometry.dispose();
console.log('RGB actor shade: floor/roof separation, colour, fill/key attenuation, no-hit and legacy fallback PASS');
