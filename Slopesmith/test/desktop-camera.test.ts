// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TestRide } from '../src/app/ride/session';

// Run the shared /play and editor test session's production camera methods without a renderer or DOM HUD.
const camera = new THREE.PerspectiveCamera();
const root = new THREE.Vector3(2, 0, 3);
const host = Object.assign(Object.create(TestRide.prototype) as object, {
  started: true,
  onFootFlag: true,
  walkThirdPerson: true,
  walkYaw: 0,
  walkPitch: 0,
  walkOrbitYaw: 0,
  walkOrbitPitch: 0,
  walkCrouch: 0,
  thirdPersonZoom: 1,
  walkForward: new THREE.Vector3(),
  walkCameraForward: new THREE.Vector3(),
  walkEye: new THREE.Vector3(),
  walkTarget: new THREE.Vector3(),
  walkFlatForward: new THREE.Vector3(),
  walkBodyQuaternion: new THREE.Quaternion(),
  walkHeadQuaternion: new THREE.Quaternion(),
  walkLookMatrix: new THREE.Matrix4(),
  walker: { position: () => root },
  o: { camera },
});
const ride = host as unknown as TestRide;
ride.orbitCamera(0, 0);
const initialEye = camera.position.clone();
const body = host.walkBodyQuaternion.clone();
const head = host.walkHeadQuaternion.clone();
const forward = host.walkForward.clone();
ride.orbitCamera(250, 40, false);
assert.ok(camera.position.distanceTo(initialEye) > 1, 'RMB moves the eye around the avatar');
assert.ok(host.walkBodyQuaternion.angleTo(body) < 1e-8, 'RMB preserves the avatar body heading');
assert.ok(host.walkHeadQuaternion.angleTo(head) < 1e-8, 'RMB does not turn the avatar through head tracking');
assert.ok(host.walkForward.distanceTo(forward) < 1e-8, 'RMB preserves the walking and flight input direction');
assert.deepEqual(root.toArray(), [2, 0, 3], 'RMB does not move the avatar root');
const orbitEye = camera.position.clone();
ride.orbitCamera(0, 0, true);
assert.ok(camera.position.distanceTo(orbitEye) < 1e-8, 'LMB takes over the orbit without jumping the camera');
assert.ok(host.walkBodyQuaternion.angleTo(body) > 0.5, 'LMB turns the avatar to the current camera bearing');
const cameraBearing = root.clone().sub(camera.position).setY(0).normalize();
const bodyBearing = new THREE.Vector3(0, 0, 1).applyQuaternion(host.walkBodyQuaternion);
assert.ok(bodyBearing.dot(cameraBearing) > 0.999, 'LMB keeps the avatar back toward the camera');
ride.orbitCamera(100, 0, true);
assert.ok(host.walkForward.distanceTo(forward) > 0.5, 'further LMB dragging turns the movement direction');
host.walkThirdPerson = false;
ride.orbitCamera(100, 0, false);
assert.ok(host.walkBodyQuaternion.angleTo(body) > 0.9, 'first person retains its existing mouse-look body turn');
assert.ok(camera.position.distanceTo(host.walkEye) < 1e-8, 'first person remains at the avatar eyes');
console.log('desktop camera orbit and avatar-turn checks passed');
