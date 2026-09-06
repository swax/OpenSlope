/**
 * A slope-following pad must lie IN the terrain, not across it.
 *
 * This is the geometry that decides which damage regime a Cracked surface sees. A horizontal quad dropped on
 * a fall-line course is a ledge: the rider meets its edge, books one crossing contact worth ~87 and rides the
 * snow underneath. A panel laid in the surface carries the rider, and a carried contact is worth about 1 —
 * which is what a retail Megaplex pane measures live. Verifying it here rather than on hardware, because a
 * ride costs twenty minutes and two earlier attempts at this geometry were wrong in ways a corner check
 * would have caught immediately.
 */
import { autoTestMountain, AUTO_TEST_LAB_CASES, AUTO_TEST_LAB_NAME } from '../src/core/collision/autotest';
import { IMPORTED_PROP_LEVEL } from '../src/core/props/imported';
import { surfaceHeightAt } from '../src/core/mesh/surface-height';
import { check, failures } from './check';

const generatedClipModel = 7321;
const { doc } = autoTestMountain({
  name: AUTO_TEST_LAB_NAME, cases: AUTO_TEST_LAB_CASES, mode: 'showoff', clipModel: generatedClipModel,
});
if (!doc) throw new Error('autoTestMountain built no mesh, so there is no terrain to measure the panels against');
const props: any[] = (doc.props ?? []) as any[];
const importedProps = props.filter(prop => prop.level === IMPORTED_PROP_LEVEL);
check(importedProps.length > 0, 'the bench carries imported clip props');
check(importedProps.every(prop => prop.model === generatedClipModel),
  'headless generation can bind every clip host and companion to its allocated catalogue model');

// The cells themselves, not their hop COMPANIONS: a companion is parked half a corridor off the fall line
// precisely so the rider never reaches it, so it has no business lying in the surface.
const rideProps = props.filter(p => typeof p.name === 'string'
  && p.name.includes('cracked-ride') && !p.name.endsWith('TGT'));
check(rideProps.length >= 2, `the bench carries the slope-following ride cells (found ${rideProps.length})`);

for (const prop of rideProps) {
  const tilted = Math.abs(prop.pitch ?? 0) > 0.01 || Math.abs(prop.roll ?? 0) > 0.01;
  check(tilted, `${prop.name} is tilted to the slope (pitch ${(prop.pitch ?? 0).toFixed(2)}, `
    + `roll ${(prop.roll ?? 0).toFixed(2)})`);

  // Corners of the panel in its own frame, then posed by Ry(yaw)·Rx(pitch)·Rz(roll) and offset to `pos`.
  const d2r = Math.PI / 180;
  const [cy, sy] = [Math.cos((prop.yaw ?? 0) * d2r), Math.sin((prop.yaw ?? 0) * d2r)];
  const [cp, sp] = [Math.cos((prop.pitch ?? 0) * d2r), Math.sin((prop.pitch ?? 0) * d2r)];
  const [cr, sr] = [Math.cos((prop.roll ?? 0) * d2r), Math.sin((prop.roll ?? 0) * d2r)];
  const pose = (v: [number, number, number]): [number, number, number] => {
    // Rz
    let [x, y, z] = [v[0] * cr - v[1] * sr, v[0] * sr + v[1] * cr, v[2]];
    // Rx
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    // Ry
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    return [x, y, z];
  };

  const halfW = 60 * (prop.scale ?? 1);
  const halfD = 32 * (prop.scale ?? 1);
  let worst = 0;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const local: [number, number, number] = [sx * halfW, 0, sz * halfD];
    const [ox, oy, oz] = pose(local);
    const wx = prop.pos[0] + ox;
    const wz = prop.pos[2] + oz;
    const wy = prop.pos[1] + oy;
    const ground = surfaceHeightAt(doc, wx, wz);
    if (ground === null) continue;
    worst = Math.max(worst, Math.abs(wy - ground));
  }
  // The authored lift is 0.15 m; allow the panel to sit within half a metre of the terrain at every corner.
  // A ledge fails this by metres — the earlier 64 m horizontal pad stood ~4 m proud at its upper corners.
  check(worst < 0.5, `${prop.name} corners hug the terrain (worst deviation ${worst.toFixed(3)} m)`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAUTOTEST SLOPE TESTS PASSED');
process.exit(failures ? 1 : 0);
