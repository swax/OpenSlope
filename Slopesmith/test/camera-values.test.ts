// tier: fast
import assert from 'node:assert/strict';
import { cameraPointToData, cameraPointToWorld, cameraValues, cameraView } from '../src/app/ui/chrome/camera-values';
import { isValidView } from '../src/app/state/storage';
import type { ViewState } from '../src/app/viewport/types';

const view: ViewState = {
  pos: [100, 270, -80], target: [184, 187, 25], up: [0, 1, 0],
  ortho: false, fov: 55, near: 0.5, zoom: 1, orthoHalfH: 100,
};
const origin: [number, number, number] = [90, 310, -30];
const relative = cameraValues(view, origin);
assert.deepEqual(relative.position, [10, -40, 110]);
assert.deepEqual(relative.target, [94, -123, 5]);
assert.deepEqual(cameraView(relative, origin, view), view);
// A reference moved in all three axes uses its translated centre, including the Z mirror.
const movedReference: [number, number, number] = [2050, 160, -420];
assert.deepEqual(cameraPointToData([2070, 180, 400], movedReference), [20, 20, 20]);
assert.deepEqual(cameraPointToWorld([20, 20, 20], movedReference), [2070, 180, 400]);

const before = structuredClone(view);
const changed = cameraView({ ...relative, position: [10, 40, 140] }, origin, view);
assert.deepEqual(changed.pos, [100, 350, -110]);
assert.deepEqual(view, before, 'editing a draft does not mutate the restore snapshot');

const ortho = cameraView({ ...relative, ortho: true, height: 240 }, origin, view);
assert.equal(ortho.orthoHalfH, 120);
assert.equal(ortho.zoom, 1);
assert.equal(cameraValues({ ...ortho, zoom: 3 }, origin).height, 80);
// Switching projection uses the perspective's visible height at the target, preserving scale there.
const expectedHeight = 2 * Math.hypot(84, -83, 105) * Math.tan(55 * Math.PI / 360);
assert.ok(Math.abs(relative.height - expectedHeight) < 1e-10);

for (const value of [NaN, Infinity, -Infinity]) {
  assert.throws(() => cameraView({ ...relative, position: [value, 0, 0] }, origin, view), /finite number/);
}
assert.throws(() => cameraView({ ...relative, target: relative.position }, origin, view), /apart/);
assert.throws(() => cameraView({ ...relative, height: 0 }, origin, view), /height/);
assert.throws(() => cameraView({ ...relative, fov: 180 }, origin, view), /Field of view/);
assert.throws(() => cameraView({ ...relative, fov: 0 }, origin, view), /Field of view/);
assert.ok(isValidView(view));
assert.ok(isValidView({ pos: [1, 2, 3], target: [0, 0, 0], ortho: false, zoom: 1, orthoHalfH: 100 }),
  'views saved before lens controls still load');
assert.ok(!isValidView({ ...view, fov: NaN }));
assert.ok(!isValidView({ ...view, up: [0, 0, 0] }));
assert.ok(!isValidView({ ...view, near: 0 }));
console.log('CAMERA VALUES TESTS PASSED');
