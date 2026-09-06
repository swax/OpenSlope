// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  clampThirdPersonZoom, createRideCamera, DEFAULT_THIRD_PERSON_ZOOM, keepThirdPersonCameraAboveGround, thirdPersonFollowEye,
  thirdPersonWheelZoomFactor,
} from '../src/app/ride/camera';
import { createRideModel } from '../src/app/ride/physics';

const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
const rideCamera = createRideCamera({
  camera,
  castSeg: () => null,
  toWorld: new THREE.Matrix4(),
});
const pos = new THREE.Vector3(10, 20, 30);
const forward = new THREE.Vector3(0, 0, 1);

assert.deepEqual(
  thirdPersonFollowEye(new THREE.Vector3(10, 20, 30), forward, 3, 1).toArray(),
  [10, 21, 27],
  'the shared neutral third-person placement is behind and above its character',
);

rideCamera.setHeading(forward);
rideCamera.update(1 / 60, pos, forward.clone().multiplyScalar(20), forward, true, false);
const retailFovY = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(0.825) / (4 / 3)));
assert.ok(Math.abs(camera.fov - retailFovY) < 1e-12,
  'ride mode converts the retail 0.825-rad horizontal half-angle to Three vertical FOV');
assert.equal(camera.near, 0.15, 'ride mode applies the retail 15-unit / 0.15-m near clip');
const cameraSample = rideCamera.telemetry(1 / 60);
assert.deepEqual(cameraSample.subjectPosition, pos.toArray(), 'telemetry captures the interpolated render subject');
assert.deepEqual(cameraSample.candidatePosition, camera.position.toArray(),
  'an unobstructed camera reports its pre-clearance candidate');
assert.equal(cameraSample.clearance, 'none');
assert.ok(Math.abs(cameraSample.fovYDeg - retailFovY) < 1e-12);
assert.equal(cameraSample.nearClipM, 0.15);
assert.equal(cameraSample.aspect, 16 / 9);
assert.equal(cameraSample.correctionDistanceM, 0);
assert.deepEqual(cameraSample.probes.map(probe => [probe.kind, probe.hit]), [
  ['origin-unbury', false], ['line-of-sight', false], ['ground', false], ['lateral', false],
  ['filtered-line-of-sight', false],
]);
const authoredBoom = 1.8;
const cameraPitch = -0.16 - Math.atan2(35, 180);
const framingDistance = Math.cos(cameraPitch) * authoredBoom;
const framingHeight = 1 - Math.sin(cameraPitch) * authoredBoom;
assert.ok(Math.abs(camera.position.z - (30 - framingDistance)) < 1e-9,
  'the chase-near candidate projects the authored 1.8-m full boom into its horizontal trail');
assert.ok(
  Math.abs(camera.position.y - (20 + framingHeight)) < 1e-9,
  'camera height combines the local 35/180 vector pitch with the associated -0.16 rad bias',
);
camera.updateMatrixWorld();
const subjectNdc = pos.clone().add(new THREE.Vector3(0, 1, 0)).project(camera);
assert.ok(Math.abs(subjectNdc.y) < 1e-9, 'the retail one-metre rider subject sits at vertical screen centre');

{
  const wideCamera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const wideRideCamera = createRideCamera({
    camera: wideCamera, castSeg: () => null, toWorld: new THREE.Matrix4(),
    initialThirdPersonZoom: DEFAULT_THIRD_PERSON_ZOOM,
  });
  wideRideCamera.setHeading(forward);
  wideRideCamera.update(1, pos, forward.clone().multiplyScalar(20), forward, true, false);
  const subject = pos.clone().addScaledVector(THREE.Object3D.DEFAULT_UP, 1);
  assert.ok(Math.abs(wideCamera.position.distanceTo(subject) / camera.position.distanceTo(subject) - 2) < 1e-9,
    'mobile and desktop playtests start with a third-person boom twice the retail trace distance');
}

// The outer retail driver filters corrected eye translation separately from its 15/16 angular response. At
// 60 Hz the recurrence is exactly 80% retained eye + 20% current candidate.
{
  const followCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const rc = createRideCamera({ camera: followCam, castSeg: () => null, toWorld: new THREE.Matrix4() });
  const start = new THREE.Vector3(0, 0, 0), moved = new THREE.Vector3(0, 0, 1);
  rc.setHeading(forward);
  rc.update(1, start, forward.clone().multiplyScalar(20), forward, true, false);
  const previousEye = followCam.position.clone();
  rc.update(1 / 60, moved, forward.clone().multiplyScalar(20), forward, true, false);
  const candidate = new THREE.Vector3().fromArray(rc.telemetry(1 / 60).candidatePosition);
  const expected = previousEye.clone().multiplyScalar(0.8).addScaledVector(candidate, 0.2);
  assert.ok(followCam.position.distanceTo(expected) < 1e-9,
    'one 60-Hz update admits exactly 20% of the new corrected chase eye');
}

// Preserve the same response in time rather than applying 20% once per browser frame: one 30-Hz update must
// equal two 60-Hz updates toward an unchanged candidate (effective alpha 1 - 0.8^2 = 0.36).
{
  const setup = () => {
    const followCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
    const rc = createRideCamera({ camera: followCam, castSeg: () => null, toWorld: new THREE.Matrix4() });
    rc.setHeading(forward);
    rc.update(1, new THREE.Vector3(), forward.clone().multiplyScalar(20), forward, true, false);
    return { followCam, rc };
  };
  const at = new THREE.Vector3(0, 0, 4), one = setup(), two = setup();
  one.rc.update(1 / 30, at, forward.clone().multiplyScalar(20), forward, true, false);
  two.rc.update(1 / 60, at, forward.clone().multiplyScalar(20), forward, true, false);
  two.rc.update(1 / 60, at, forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(one.followCam.position.distanceTo(two.followCam.position) < 1e-9,
    'the eye filter has the same time response at 30 and 60 rendered Hz');
}

// Respawns and view-mode changes are cuts: stale chase history must never make the camera fly across the map.
{
  const cutCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const rc = createRideCamera({ camera: cutCam, castSeg: () => null, toWorld: new THREE.Matrix4() });
  const start = new THREE.Vector3(), warped = new THREE.Vector3(50, 8, -30);
  rc.setHeading(forward);
  rc.update(1, start, forward.clone().multiplyScalar(20), forward, true, false);
  rc.update(1 / 60, warped, forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(cutCam.position.distanceTo(new THREE.Vector3().fromArray(rc.telemetry(1 / 60).candidatePosition)) > 1,
    'an ordinary update retains chase history');
  rc.resetAim(warped);
  rc.update(1 / 60, warped, forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(cutCam.position.distanceTo(new THREE.Vector3().fromArray(rc.telemetry(1 / 60).candidatePosition)) < 1e-9,
    'respawn/reset invalidates the retained eye');
  rc.updateFirstPerson(new THREE.Vector3(70, 9, -50), forward, new THREE.Vector3(0, 1, 0));
  rc.update(1 / 60, warped, forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(cutCam.position.distanceTo(new THREE.Vector3().fromArray(rc.telemetry(1 / 60).candidatePosition)) < 1e-9,
    'returning from first person reseats third person instead of interpolating from its old eye');
}

// Filtering a collision-safe target can cross the wall between the old and new eyes. Slopesmith rechecks the
// filtered sight line: obstruction ingress stays safe/immediate, while release back to the full boom is damped.
{
  const safeCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const wallZ = -0.8;
  let blocked = false;
  const rc = createRideCamera({
    camera: safeCam, toWorld: new THREE.Matrix4(),
    castSeg: (from, to) => {
      if (!blocked || to.z >= wallZ || from.z <= wallZ) return null;
      return {
        point: from.clone().lerp(to, (from.z - wallZ) / (from.z - to.z)),
        faceIndex: 0, normal: new THREE.Vector3(0, 0, 1),
      };
    },
  });
  rc.setHeading(forward);
  rc.update(1, new THREE.Vector3(), forward.clone().multiplyScalar(20), forward, true, false);
  blocked = true;
  rc.update(1 / 60, new THREE.Vector3(), forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(Math.abs(safeCam.position.z - (wallZ + 0.4)) < 1e-9,
    'the filtered sight-line guard keeps obstruction ingress on the rider side of the wall');
  assert.equal(rc.telemetry(1 / 60).probes.find(probe => probe.kind === 'filtered-line-of-sight')?.hit, true);
  blocked = false;
  const closeEye = safeCam.position.clone();
  rc.update(1 / 60, new THREE.Vector3(), forward.clone().multiplyScalar(20), forward, true, false);
  const releasedCandidate = new THREE.Vector3().fromArray(rc.telemetry(1 / 60).candidatePosition);
  const releasedExpected = closeEye.multiplyScalar(0.8).addScaledVector(releasedCandidate, 0.2);
  assert.ok(safeCam.position.distanceTo(releasedExpected) < 1e-9,
    'clearing the wall eases back to the full boom through the retail eye filter');
}

// Wheel/pinch zoom scales the existing chase boom rather than independently changing its height or bearing.
{
  const subject = pos.clone().addScaledVector(THREE.Object3D.DEFAULT_UP, 1);
  const nearBoom = camera.position.clone().sub(subject);
  rideCamera.setThirdPersonZoom(2);
  rideCamera.update(0, pos, forward.clone().multiplyScalar(20), forward, true, false);
  const farBoom = camera.position.clone().sub(subject);
  assert.ok(farBoom.distanceTo(nearBoom.clone().multiplyScalar(2)) < 1e-9,
    'zooming out moves the riding camera directly along its existing camera-to-avatar line');
  rideCamera.setThirdPersonZoom(1);
  rideCamera.update(0, pos, forward.clone().multiplyScalar(20), forward, true, false);

  assert.ok(thirdPersonWheelZoomFactor(-100) < 1, 'wheel up zooms the third-person camera in');
  assert.ok(thirdPersonWheelZoomFactor(100) > 1, 'wheel down zooms the third-person camera out');
  assert.equal(clampThirdPersonZoom(0), 0.35, 'the closest boom stays outside the avatar');
  assert.equal(clampThirdPersonZoom(100), 4, 'the farthest boom remains a useful chase view');

  const walkingTarget = new THREE.Vector3(0, 1.1, 0);
  const walkingNear = thirdPersonFollowEye(walkingTarget, forward, 3, 1).sub(walkingTarget);
  const walkingFar = thirdPersonFollowEye(walkingTarget, forward, 6, 2).sub(walkingTarget);
  assert.ok(walkingFar.distanceTo(walkingNear.multiplyScalar(2)) < 1e-9,
    'walking zoom scales height and distance together along the same avatar-to-camera line');
}

// The walking camera has no terrain LOS/volume pass, so it retains its separate long-range vertical floor guard.
{
  const below = new THREE.Vector3(2, -3, 4);
  assert.equal(keepThirdPersonCameraAboveGround(
    below, 1.6, () => ({ y: 0, normal: new THREE.Vector3(0, 1, 0) }),
  ), true, 'a deeply buried walking follow eye is detected beyond the short clearance window');
  assert.equal(below.y, 0.4, 'the walking follow eye is seated at the shared clearance above terrain');
}

// A walking/board ground query deliberately reports the topmost vertical hit. Reusing it for the riding camera
// makes a tunnel roof look like a floor: the old hard-floor pass lifted the eye over the roof, then the volume
// pass projected it 0.45 m back underneath on every frame. Riding instead stays in the rider's open tunnel cell.
{
  const tunnelCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const tunnelFloorY = 0, tunnelRoofY = 2.2;
  let topmostGroundQueries = 0;
  const deps = {
    camera: tunnelCam, castSeg: () => null, toWorld: new THREE.Matrix4(),
    closestTerrainPoint: (point: THREE.Vector3, maxDistance: number) => {
      const floorDistance = Math.abs(point.y - tunnelFloorY);
      const roofDistance = Math.abs(point.y - tunnelRoofY);
      const distance = Math.min(floorDistance, roofDistance);
      if (distance >= maxDistance) return null;
      const roof = roofDistance < floorDistance;
      return {
        point: new THREE.Vector3(point.x, roof ? tunnelRoofY : tunnelFloorY, point.z),
        normal: new THREE.Vector3(0, roof ? -1 : 1, 0), distance,
      };
    },
    // Deliberately present as legacy host data: createRideCamera must not consume this topmost-surface query.
    groundAt: () => {
      topmostGroundQueries++;
      return { y: tunnelRoofY, normal: new THREE.Vector3(0, 1, 0) };
    },
  };
  const rc = createRideCamera(deps);
  rc.setHeading(forward);
  for (let i = 0; i < 30; i++)
    rc.update(i === 0 ? 1 : 1 / 60, new THREE.Vector3(), forward.clone().multiplyScalar(20), forward, true, false);
  assert.equal(topmostGroundQueries, 0, 'the riding camera never asks the walking query for a topmost floor');
  assert.ok(tunnelCam.position.y < tunnelRoofY - 0.45,
    'the chase eye remains freely below the tunnel ceiling instead of sticking to its clearance shell');
  assert.equal(rc.telemetry(1 / 60).clearance, 'none');
}

rideCamera.orbit(-Math.PI / 2 / 0.006, 0);
rideCamera.update(0, pos, forward.clone().multiplyScalar(20), forward, true, false);
assert.ok(Math.abs(camera.position.x - (pos.x - framingDistance)) < 1e-9,
  'RMB yaw orbits the chase seat around the rider while retaining its distance');
assert.ok(Math.abs(camera.position.z - pos.z) < 1e-9,
  'a quarter-turn user orbit reaches the rider side instead of changing the chase bearing');
rideCamera.orbit(Math.PI / 2 / 0.006, 0); // return to the retail seat for the tests below

// V's on-board first person sits on the rider's solved eye bridge and needs the close projection plane used by
// the headset rather than the chase boom's wall plane.
{
  const eye = new THREE.Vector3(4, 7, 9);
  rideCamera.updateFirstPerson(eye, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  assert.deepEqual(camera.position.toArray(), eye.toArray(), 'first person seats the camera at the rider eye');
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9,
    'first person looks through the rider head rather than back at the chase subject');
  assert.equal(camera.near, 0.03, 'first person uses a close plane that does not clip the local body');
  assert.deepEqual(rideCamera.telemetry(1 / 60).probes, [], 'an eye-level view does not spend chase boom casts');
  rideCamera.orbit(10, 10);
  rideCamera.updateFirstPerson(eye, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  const mouseLook = camera.getWorldDirection(new THREE.Vector3());
  const screenRight = new THREE.Vector3(0, 0, 1).cross(new THREE.Vector3(0, 1, 0));
  assert.ok(mouseLook.dot(screenRight) > 0, 'in first person, moving the mouse right turns toward screen right');
  assert.ok(mouseLook.y < 0, 'in first person, moving the mouse down looks down rather than up');
  rideCamera.orbit(-10, -10); // return the retained look offsets to neutral
  rideCamera.update(0, pos, forward.clone().multiplyScalar(20), forward, true, false);
  assert.equal(camera.near, 0.15, 'returning to third person restores the retail chase near plane');
}

// Boost retains the authored farther seat, but eases onto and off it so a button edge cannot make the rider
// jump in screen size. Keep this on its own camera so the following trajectory checks start at the near seat.
{
  const boostCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const rc = createRideCamera({ camera: boostCam, castSeg: () => null, toWorld: new THREE.Matrix4() });
  rc.setHeading(forward);
  rc.update(1, pos, forward.clone().multiplyScalar(20), forward, true, false);
  const nearZ = boostCam.position.z;
  rc.update(1 / 60, pos, forward.clone().multiplyScalar(20), forward, true, true);
  const firstBoostZ = boostCam.position.z;
  const firstBoostCandidateZ = rc.telemetry(1 / 60).candidatePosition[2];
  assert.ok(firstBoostZ < nearZ && firstBoostZ > 30 - framingDistance * (1 + 30 / 180),
    'the first held-boost frame begins the pull-back without snapping to the far seat');
  rc.update(1 / 60, pos, forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(rc.telemetry(1 / 60).candidatePosition[2] > firstBoostCandidateZ,
    'releasing boost immediately turns its eased candidate back toward the near seat');
  assert.ok(boostCam.position.z > 30 - framingDistance * (1 + 30 / 180) && boostCam.position.z < nearZ,
    'the retained eye remains between the authored seats instead of snapping on release');
  for (let i = 0; i < 120; i++) rc.update(1 / 60, pos, forward.clone().multiplyScalar(20), forward, true, true);
  assert.ok(
    Math.abs(boostCam.position.z - (30 - framingDistance * (1 + 30 / 180))) < 1e-6,
    'sustained boost settles at the authored 30/180 pull-back ratio',
  );
}

rideCamera.resetAim(pos);
rideCamera.setHeading(forward);
const falling = new THREE.Vector3(0, -10, 20);
rideCamera.update(1 / 60, pos, falling, forward, false, false);
const firstFallPitch = (Math.atan2(-10, 20) / 2) / 16;
assert.ok(
  Math.abs(new THREE.Vector3().fromArray(rideCamera.telemetry(1 / 60).candidatePosition).y
    - (21 - Math.sin(cameraPitch + firstFallPitch) * authoredBoom)) < 1e-9,
  'falling pitch is halved and closes one sixteenth of its error on the first 60 Hz update',
);

rideCamera.resetAim(pos);
const rising = new THREE.Vector3(0, 10, 20);
rideCamera.update(1 / 60, pos, rising, forward, false, false);
const firstRisePitch = Math.atan2(10, 20) / 16;
assert.ok(
  Math.abs(new THREE.Vector3().fromArray(rideCamera.telemetry(1 / 60).candidatePosition).y
    - (21 - Math.sin(cameraPitch + firstRisePitch) * authoredBoom)) < 1e-9,
  'rising pitch uses the full trajectory angle before the same angular easing',
);

rideCamera.setHeading(forward);
const right = new THREE.Vector3(1, 0, 0);
rideCamera.update(1 / 60, pos, right.clone().multiplyScalar(20), right, true, false);
const followedHeading = new THREE.Vector3().fromArray(rideCamera.telemetry(1 / 60).targetHeading);
const followedYaw = Math.atan2(followedHeading.x, followedHeading.z);
assert.ok(
  Math.abs(followedYaw - Math.PI / 32) < 1e-9,
  'at 60 Hz the chase heading closes one sixteenth of a 90-degree yaw error',
);

// ---- terrain clearance ([Trailmap: 400-camera-terrain]) ----
// Every correction offsets the eye along the HIT SURFACE NORMAL: never a vertical lift, never a boom shortening.

// Slope clearance: the ±0.4 m vertical window through the eye crosses a 30° slope → the eye must land at
// hit + 0.4 m along the slope NORMAL (so it also moves horizontally off the hill face).
{
  const slopeNormal = new THREE.Vector3(0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)).normalize();
  const hit = { point: new THREE.Vector3(), faceIndex: 0, normal: slopeNormal.clone() };
  const groundCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const rc = createRideCamera({
    camera: groundCam,
    // Only the vertical clearance probe hits: a downward segment (from above the eye to below it).
    castSeg: (from, to) => (to.y < from.y && Math.abs(from.x - to.x) < 1e-9
      ? { ...hit, point: from.clone().setY((from.y + to.y) / 2), normal: hit.normal.clone() } : null),
    toWorld: new THREE.Matrix4(),
  });
  rc.setHeading(forward);
  rc.update(1, pos, forward.clone().multiplyScalar(20), forward, true, false);
  // The probe hit at the segment midpoint (the pre-clearance eye), so the eye must sit exactly one clearance
  // along the slope normal from there — off-vertical, proving a normal offset rather than a lift.
  const preClear = pos.clone()
    .addScaledVector(forward, -framingDistance)
    .addScaledVector(new THREE.Vector3(0, 1, 0), framingHeight);
  const expected = preClear.clone().addScaledVector(slopeNormal, 0.4);
  assert.ok(groundCam.position.distanceTo(expected) < 1e-6,
    'slope clearance pins the eye 0.4 m along the slope normal, not vertically');
  assert.equal(rc.telemetry(1).clearance, 'ground', 'camera telemetry identifies the slope-clearance branch');
}

// Blocked sight line: the eye lands ON the blocking surface padded 0.4 m along its normal, toward the rider —
// not pulled in along the boom.
{
  const wallNormal = new THREE.Vector3(0, 0, 1); // wall face toward the rider (+z side)
  const losCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const wallZ = 30 - 1; // between rider (z=30) and the candidate eye (z ≈ 28.31)
  const rc = createRideCamera({
    camera: losCam,
    // Only the origin→eye cast hits (its segment travels away from the rider, -z), at the wall plane.
    castSeg: (from, to) => (to.z < from.z - 1
      ? { point: from.clone().lerp(to, (from.z - wallZ) / (from.z - to.z)), faceIndex: 0, normal: wallNormal.clone() } : null),
    toWorld: new THREE.Matrix4(),
  });
  rc.setHeading(forward);
  rc.update(1, pos, forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(Math.abs(losCam.position.z - (wallZ + 0.4)) < 1e-6,
    'a blocked sight line puts the eye on the wall padded 0.4 m along the wall normal');
  assert.equal(rc.telemetry(1).clearance, 'line-of-sight',
    'camera telemetry identifies the blocked sight-line branch');
  const hitProbe = rc.telemetry(1).probes.find(probe => probe.kind === 'line-of-sight')!;
  assert.equal(hitProbe.source, 'terrain');
  assert.ok(hitProbe.point && hitProbe.normal && hitProbe.hitDistance! > 0,
    'camera telemetry retains the terrain hit geometry');
}

// Solid prop/collision geometry shares the line-of-sight pass with terrain. This is distinct from the rider's
// ride-through foliage: only the physics model's solid obstacle query is supplied here.
{
  const obstacleCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  const wallZ = 29;
  const rc = createRideCamera({
    camera: obstacleCam,
    castSeg: () => null,
    castObstacleSeg: (from, to) => (to.z < from.z - 1
      ? {
          point: from.clone().lerp(to, (from.z - wallZ) / (from.z - to.z)),
          normal: new THREE.Vector3(0, 0, 1), key: 'reference:wall-42',
        } : null),
    toWorld: new THREE.Matrix4(),
  });
  rc.setHeading(forward);
  rc.update(1, pos, forward.clone().multiplyScalar(20), forward, true, false);
  assert.ok(Math.abs(obstacleCam.position.z - (wallZ + 0.4)) < 1e-6,
    'solid obstacle walls run the same padded line-of-sight correction as terrain');
  const hitProbe = rc.telemetry(1).probes.find(probe => probe.kind === 'line-of-sight')!;
  assert.equal(hitProbe.source, 'obstacle');
  assert.equal(hitProbe.obstacleKey, 'reference:wall-42');
}

// A closest-surface volume pass closes the diagonal and concave-corner gaps left by the retail axis segments.
// Model two adjacent faces that are each 0.1 m from the current eye. The first projection reveals the second;
// the bounded re-query must solve both during this render update.
{
  const volumeCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2_000);
  let queryCount = 0;
  const rc = createRideCamera({
    camera: volumeCam, castSeg: () => null, toWorld: new THREE.Matrix4(),
    closestTerrainPoint: point => {
      const normal = queryCount === 0
        ? new THREE.Vector3(1, 0, 0)
        : queryCount === 1 ? new THREE.Vector3(0, 0, 1) : null;
      queryCount++;
      if (!normal) return null;
      return { point: point.clone().addScaledVector(normal, -0.1), normal, distance: 0.1 };
    },
  });
  rc.setHeading(forward);
  rc.update(1, pos, forward.clone().multiplyScalar(20), forward, true, false);
  const candidate = new THREE.Vector3().fromArray(rc.telemetry(1).candidatePosition);
  assert.ok(volumeCam.position.distanceTo(candidate.clone().add(new THREE.Vector3(0.35, 0, 0.35))) < 1e-9,
    'the volume guard iteratively pads the eye off both neighbouring faces');
  assert.equal(rc.telemetry(1).clearance, 'volume');
  assert.deepEqual(rc.telemetry(1).probes.filter(probe => probe.kind === 'volume')
    .map(probe => [probe.iteration, probe.hit, probe.hitDistance]), [
      [0, true, 0.1], [1, true, 0.1], [2, false, undefined],
    ], 'volume telemetry retains each bounded closest-surface iteration');
}

// The live model's camera query actually reaches the flattened native obstacle BVH supplied by reference props.
{
  const floorGeometry = new THREE.BufferGeometry();
  floorGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -10, 0, -10, -10, 0, 10, 10, 0, -10, 10, 0, 10,
  ], 3));
  floorGeometry.setIndex([0, 1, 2, 2, 1, 3]);
  const terrain = new THREE.Mesh(floorGeometry);
  terrain.updateMatrixWorld(true);
  const wallGeometry = new THREE.BufferGeometry();
  wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -5, 0, -2, 5, 0, -2, -5, 5, -2, 5, 5, -2,
  ], 3));
  wallGeometry.setIndex([0, 1, 2, 1, 3, 2]);
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), terrain, surfaceOf: () => 1, oobFloorY: -100,
    keys: { left: false, right: false, tuck: false, brake: false, boost: false },
    stick: { active: false, x: 0 }, onRespawn: () => {},
    obstacles: [{
      key: 'reference:wall-42', object: { kind: 'reference', index: 42 }, geometry: wallGeometry,
      matrixWorld: new THREE.Matrix4(), solid: true, bounce: 0, surface: -1,
    }],
  });
  model.start();
  const hit = model.castCameraObstacle(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, -4));
  assert.ok(hit);
  assert.equal(hit.key, 'reference:wall-42');
  assert.ok(Math.abs(hit.point.z + 2) < 1e-6);
  assert.ok(hit.normal.z > 0.99);
  const terrainNear = model.closestCameraTerrain(new THREE.Vector3(0, 0.2, 0), 0.4);
  assert.ok(terrainNear && Math.abs(terrainNear.distance - 0.2) < 1e-6,
    'the live terrain BVH exposes closest rendered-surface distance to the camera');
  assert.ok(terrainNear.normal.y > 0.99);
  assert.equal(model.closestCameraTerrain(new THREE.Vector3(0, 0.5, 0), 0.4), null,
    'the closest terrain query is bounded by the camera clearance radius');
}

console.log('RIDE CAMERA: PASS');
