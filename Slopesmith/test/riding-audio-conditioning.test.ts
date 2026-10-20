// tier: fast
import assert from 'node:assert/strict';
import { adaptedRidingPitch, adaptedRidingRole, conditionRidingPcm } from '../src/core/audio/riding-conditioning';

assert.equal(adaptedRidingPitch(false, 0), 0.9);
assert.equal(adaptedRidingPitch(false, 1), 1.02);
assert.equal(adaptedRidingPitch(true, 1), 1.05);

const left = Float32Array.from({ length: 6000 }, (_, i) => 0.1 + 0.8 * Math.sin(i * 0.13));
const right = Float32Array.from({ length: 6000 }, (_, i) => -0.1 + 0.8 * Math.cos(i * 0.19));
const saved = [left.slice(), right.slice()];
const pcm = conditionRidingPcm([left, right], 16000, 'openslope_board', 4)!;
assert(pcm.gain < 0.3 && pcm.rmsAfter <= 0.120001 && pcm.peakAfter <= 0.800001);
assert.equal(pcm.edgeFrames, 80);
for (let c = 0; c < 2; c++) {
  assert.equal(pcm.channels[c].length, 6000);
  assert(Math.abs(pcm.channels[c][0] - pcm.channels[c][5999]) < 1e-7, 'The loop wrap has no amplitude step');
}
assert.deepEqual([left, right], saved, 'The shared raw PCM cache remains untouched');
const quiet = Float32Array.from({ length: 1000 }, (_, i) => 0.01 * Math.sin(i * 0.2));
assert.equal(conditionRidingPcm([quiet], 22050, 'openslope_board', 3)!.gain, 1);
const land = conditionRidingPcm([left], 16000, 'openslope_board', 1)!;
assert.equal(land.edgeFrames, 0);
assert(land.rmsAfter <= 0.200001);
assert.equal(land.channels[0][0], Math.fround(left[0] * land.gain), 'A transient retains its attack');
assert.equal(conditionRidingPcm([left], 16000, 'zboard', 4), null, 'Original banks keep their own levels');
assert.equal(adaptedRidingRole('openslope_rider', 115), null);
assert.equal(adaptedRidingRole('openslope_rider', 32), 'wind');
assert.equal(adaptedRidingRole('openslope_rider', 122), 'boost');
assert.throws(() => conditionRidingPcm([new Float32Array([NaN])], 16000, 'openslope_board', 4));
console.log('PASS: adapted riding level ceilings, loop joins, transient attacks and source preservation');
