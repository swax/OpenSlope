import * as THREE from 'three';
import type { Stage } from '../stage';

/** HTML distance/angle pill anchored beside the shared transform gizmo during a drag. */
export function createGizmoReadout(stage: Stage) {
  const element = document.createElement('div');
  element.style.cssText =
    'position:absolute;display:none;pointer-events:none;z-index:7;padding:5px 8px;border:1px solid rgba(255,255,255,.22);border-radius:5px;background:rgba(15,24,33,.92);color:#f7fbff;box-shadow:0 2px 8px rgba(0,0,0,.35);font:600 12px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap';
  stage.container.appendChild(element);

  let drag: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; mode: 'move' | 'rotate' | 'scale' } | null = null;

  function begin(mode: 'move' | 'rotate' | 'scale') {
    const object = stage.gizmo.object;
    if (!object) return;
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
    object.getWorldPosition(position);
    object.getWorldQuaternion(quaternion);
    object.getWorldScale(scale);
    drag = { position, quaternion, scale, mode };
    element.style.display = 'block';
    update();
  }

  function update() {
    const object = stage.gizmo.object;
    if (!drag || !object) return;
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
    object.getWorldPosition(position);
    object.getWorldQuaternion(quaternion);
    object.getWorldScale(scale);
    if (drag.mode === 'rotate') element.textContent = `${THREE.MathUtils.radToDeg(drag.quaternion.angleTo(quaternion)).toFixed(1)}°`;
    else if (drag.mode === 'scale') {
      const factors = scale.divide(drag.scale);
      element.textContent = `× ${factors.x.toFixed(2)} · ${factors.y.toFixed(2)} · ${factors.z.toFixed(2)}`;
    } else element.textContent = `${drag.position.distanceTo(position).toFixed(1)} m`;

    const projected = position.clone().project(stage.camera);
    const width = stage.container.clientWidth, height = stage.container.clientHeight;
    if (!width || !height || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return;
    const anchorX = (projected.x * 0.5 + 0.5) * width;
    const anchorY = (-projected.y * 0.5 + 0.5) * height;
    const readoutWidth = element.offsetWidth || 60, readoutHeight = element.offsetHeight || 22;
    const desiredTop = anchorY - readoutHeight - 18;
    element.style.left = `${Math.round(THREE.MathUtils.clamp(anchorX + 18, 8, Math.max(8, width - readoutWidth - 8)))}px`;
    element.style.top = `${Math.round(THREE.MathUtils.clamp(desiredTop >= 8 ? desiredTop : anchorY + 18, 8, Math.max(8, height - readoutHeight - 8)))}px`;
  }

  function end() {
    drag = null;
    element.style.display = 'none';
  }

  return { begin, update, end };
}

export type GizmoReadout = ReturnType<typeof createGizmoReadout>;
