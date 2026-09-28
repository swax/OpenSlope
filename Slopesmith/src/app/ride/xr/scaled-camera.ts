import * as THREE from 'three';

/**
 * Culling for a SCALED XR rig (docs/068).
 *
 * three's WebXRManager culls a stereo frame with one frustum fitted around both eyes (`setProjectionFromUnion`).
 * It measures the eye separation from the eye cameras' WORLD positions, then adds offsets derived from it to a
 * near plane that is in VIEW units, which is only the same thing while the camera's parent is unscaled. Edit
 * flight scales the rig. At 100× the eyes are 6 m apart in the world, the union's near plane lands about 2.6
 * view-metres ahead of the eyes, and everything closer — the hands, the watch, the palette, one's own body — is
 * culled. Drawing is unaffected; each eye renders with its own correct projection. Only the cull, and the user
 * camera three copies the union into, are wrong.
 *
 * `correctXrUnionForScale` redoes that union with the separation in view units, and `installScaledRigCullFix`
 * runs it straight after three's own camera update, before the frame is culled. At scale 1 it does nothing.
 */

const posL = new THREE.Vector3(), posR = new THREE.Vector3(), scaleOf = new THREE.Vector3();

/** Refit `cameraXR`'s culling union for its eyes' world scale, then re-seat `userCamera` on it the way three's
 *  `updateUserCamera` does. False (and nothing touched) when the rig is unscaled or not stereo. */
export function correctXrUnionForScale(cameraXR: THREE.ArrayCamera, userCamera: THREE.Camera): boolean {
  if (cameraXR.cameras.length !== 2) return false;
  const [cameraL, cameraR] = cameraXR.cameras;
  const scale = scaleOf.setFromMatrixScale(cameraL.matrixWorld).x;
  if (!(scale > 0) || Math.abs(scale - 1) < 1e-6) return false;

  // Exactly three's setProjectionFromUnion, except that the eye separation is measured in the rig's own units and
  // the resulting offsets are converted back to world units only where they move the camera.
  posL.setFromMatrixPosition(cameraL.matrixWorld);
  posR.setFromMatrixPosition(cameraR.matrixWorld);
  const ipd = posL.distanceTo(posR) / scale;
  const projL = cameraL.projectionMatrix.elements, projR = cameraR.projectionMatrix.elements;
  const near = projL[14] / (projL[10] - 1);
  const far = projL[14] / (projL[10] + 1);
  const topFov = (projL[9] + 1) / projL[5];
  const bottomFov = (projL[9] - 1) / projL[5];
  const leftFov = (projL[8] - 1) / projL[0];
  const rightFov = (projR[8] + 1) / projR[0];
  const left = near * leftFov, right = near * rightFov;
  const zOffset = ipd / (-leftFov + rightFov);
  const xOffset = zOffset * -leftFov;

  cameraL.matrixWorld.decompose(cameraXR.position, cameraXR.quaternion, cameraXR.scale);
  cameraXR.translateX(xOffset * scale);
  cameraXR.translateZ(zOffset * scale);
  cameraXR.matrixWorld.compose(cameraXR.position, cameraXR.quaternion, cameraXR.scale);
  cameraXR.matrixWorldInverse.copy(cameraXR.matrixWorld).invert();
  if (projL[10] === -1) {
    cameraXR.projectionMatrix.copy(cameraL.projectionMatrix);
    cameraXR.projectionMatrixInverse.copy(cameraL.projectionMatrixInverse);
  } else {
    const near2 = near + zOffset, far2 = far + zOffset;
    cameraXR.projectionMatrix.makePerspective(
      left - xOffset, right + (ipd - xOffset), topFov * far / far2 * near2, bottomFov * far / far2 * near2, near2, far2,
    );
    cameraXR.projectionMatrixInverse.copy(cameraXR.projectionMatrix).invert();
  }

  const parent = userCamera.parent;
  if (parent) userCamera.matrix.copy(parent.matrixWorld).invert().multiply(cameraXR.matrixWorld);
  else userCamera.matrix.copy(cameraXR.matrixWorld);
  userCamera.matrix.decompose(userCamera.position, userCamera.quaternion, userCamera.scale);
  userCamera.updateMatrixWorld(true);
  userCamera.projectionMatrix.copy(cameraXR.projectionMatrix);
  userCamera.projectionMatrixInverse.copy(cameraXR.projectionMatrixInverse);
  if (userCamera instanceof THREE.PerspectiveCamera) {
    userCamera.fov = THREE.MathUtils.RAD2DEG * 2 * Math.atan(1 / userCamera.projectionMatrix.elements[5]);
    userCamera.zoom = 1;
  }
  return true;
}

/** Follow three's per-frame XR camera update with the scale correction. Returns the uninstall. */
export function installScaledRigCullFix(xr: THREE.WebXRManager): () => void {
  const manager = xr as unknown as { updateCamera(camera: THREE.Camera): void };
  const original = manager.updateCamera;
  manager.updateCamera = function (this: unknown, camera: THREE.Camera) {
    original.call(this, camera);
    correctXrUnionForScale(xr.getCamera(), camera);
  };
  return () => { manager.updateCamera = original; };
}
