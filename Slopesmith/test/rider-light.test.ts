// tier: fast
import assert from 'node:assert/strict';
import {
  evaluateRiderLight,
  referenceRiderProbes,
  RiderLightField,
  type RiderLightProbe,
} from '../src/core/lighting/rider-light';
import type { PropInstance } from '../src/core/reference/props';
import type { V3 } from '../src/core/doc/types';

const close = (a: number, b: number) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const probes: RiderLightProbe[] = [
  { position: [0, 0, 0], ambient: [0.8, 0.7, 0.6], keys: [] },
  { position: [10, 0, 0], ambient: [0.08, 0.07, 0.06], keys: [] },
];
const field = new RiderLightField(probes);
close(field.sample([5, 0, 0])!.ambient[0], 0.44);
assert(field.sample([0, 0, 0])!.ambient[0] > field.sample([10, 0, 0])!.ambient[0] * 8);
assert(Math.abs(field.sample([4.999, 0, 0])!.ambient[0] - field.sample([5.001, 0, 0])!.ambient[0]) < 0.001);
assert.equal(new RiderLightField([]).sample([0, 0, 0]), null);
assert.equal(field.sample([NaN, 0, 0]), null);
assert.deepEqual(
  evaluateRiderLight({ ambient: [0.1, 0.2, 0.3], keys: [{ color: [0.5, 0, 0], direction: [0, 0, -1] }] }, [0, 0, -2]),
  [0.6, 0.2, 0.3],
);

const donor = (partial: Partial<PropInstance>) =>
  ({ loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], ...partial }) as PropInstance;
const converted = referenceRiderProbes([
  donor({
    lighting: { ambient: [25.6, 51.2, 76.8], keys: [{ color: [128, 0, 0], direction: [1, 0, 0] }] },
    rot: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    scale: [2, 3, 4],
  }),
  donor({ lighting: { ambient: [256, 256, 256], keys: [] } }),
  donor({ loc: [100, 0, 0], lighting: { ambient: [0, 0, 0], keys: [] } }),
  donor({ loc: [200, 0, 0] }),
]);
assert.equal(converted.length, 2, 'self-lit/missing records excluded and black records retained');
assert.deepEqual(converted[1].position, [-1, 0, -0]);
close(converted[0].keys[0].direction[2], -1);
close(converted[0].keys[0].color[0], 0.5);

// Independent full-scan oracle: exercise all kd-tree branches and stacked ground.
const many: RiderLightProbe[] = Array.from({ length: 257 }, (_, i) => ({
  position: [(i * 17) % 67, (i * 11) % 43, (i * 23) % 71] as V3,
  ambient: [i / 257, 0.2, 0.1] as V3,
  keys: [],
}));
const indexed = new RiderLightField(many);
for (let i = 0; i < 40; i++) {
  const p: V3 = [i * 2.37, i * 0.71, i * 1.21];
  const nearest = many
    .map(probe => ({ probe, d: probe.position.reduce((s, v, j) => s + (v - p[j]) ** 2, 0) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4);
  const total = nearest.reduce((s, item) => s + 1 / (1 + item.d), 0);
  close(
    indexed.sample(p)!.ambient[0],
    nearest.reduce((s, item) => s + item.probe.ambient[0] / (1 + item.d) / total, 0),
  );
}
console.log('RIDER LIGHT TEST PASSED (coloured/dark probes, placement frames, interpolation and full-scan oracle)');
