import * as THREE from 'three';
import type { Patch } from '../../../core/mesh/loft-surface';
import type { SurfaceAxis } from '../../../core/math/spline-surface';
import {
  curveAt,
  sectionCurve,
  surfaceGuideSnapper,
  type SurfaceGuideSnapTarget,
  type GuideCurve,
} from '../../../core/mesh/surface-guides';
import { patchPoint } from '../../../core/math/bezier';
import type { V3 } from '../../../core/doc/types';
import type { Stage } from '../stage';

export type SurfaceGuidePlacement = {
  charts: Patch[];
  axis: SurfaceAxis;
  stations: number[];
  initial: number;
  pointOn?: { axis: SurfaceAxis; at: number };
  snapTargets?: SurfaceGuideSnapTarget[];
  onSnap?: (points: number) => void;
  curveAt?: (at: number) => GuideCurve;
  commit: (at: number) => void;
  cancel: () => void;
};

/** A frozen surface pick target and a transient isoparametric guide. Hover never edits the document. */
export function createSurfaceGuideLayer(stage: Stage) {
  let placement: SurfaceGuidePlacement | null = null,
    position: number | null = null,
    valid = false;
  let snap: ReturnType<typeof surfaceGuideSnapper> | undefined;
  const material = new THREE.LineBasicMaterial({ color: 0x54e6d2, depthTest: false, transparent: true, opacity: 0.95 });
  const ghost = new THREE.LineSegments(new THREE.BufferGeometry(), material);
  ghost.renderOrder = 16;
  ghost.visible = false;
  ghost.raycast = () => {
    /* feedback only */
  };
  stage.worldRoot.add(ghost);
  const pointGhost = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0x54e6d2, size: 10, sizeAttenuation: false, depthTest: false }),
  );
  pointGhost.renderOrder = 17;
  pointGhost.visible = false;
  stage.worldRoot.add(pointGhost);
  const snapGhost = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0xffcf66, size: 13, sizeAttenuation: false, depthTest: false }),
  );
  snapGhost.renderOrder = 18;
  snapGhost.visible = false;
  snapGhost.raycast = () => {
    /* feedback only */
  };
  stage.worldRoot.add(snapGhost);
  const worldPoint = new THREE.Vector3();
  const snapReach = (point: V3) => {
    worldPoint.set(...point).applyMatrix4(stage.worldRoot.matrixWorld);
    return stage.worldPerPixel(worldPoint) * 10;
  };
  const pick = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  pick.visible = false;
  stage.worldRoot.add(pick);

  function show(at: number | null) {
    const snapped = at !== null && snap ? snap(at, snapReach) : undefined;
    if (snapped) at = snapped.at;
    position = at;
    valid = at !== null && !placement!.stations.some(t => Math.abs(t - at) < 1e-4);
    ghost.visible = at !== null && !placement?.pointOn;
    pointGhost.visible = at !== null && !!placement?.pointOn;
    const reused = valid ? (snapped?.points ?? []) : [];
    snapGhost.visible = reused.length > 0;
    placement?.onSnap?.(reused.length);
    if (at === null || !placement) return;
    material.color.setHex(valid ? (reused.length ? 0xffcf66 : 0x54e6d2) : 0xff6370);
    if (reused.length) {
      snapGhost.geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          reused.flatMap(p => p.point),
          3,
        ),
      );
      snapGhost.geometry.boundingSphere = null;
    }
    if (placement.pointOn) {
      const guide = placement.pointOn;
      const point = curveAt(sectionCurve(placement.charts, guide.axis, guide.at), at);
      pointGhost.material.color.setHex(valid ? 0x54e6d2 : 0xff6370);
      pointGhost.geometry.setAttribute('position', new THREE.Float32BufferAttribute(point, 3));
      pointGhost.geometry.boundingSphere = null;
      return;
    }
    const curve = placement.curveAt?.(at) ?? sectionCurve(placement.charts, placement.axis, at);
    const positions: number[] = [];
    for (let i = 0; i < curve.knots.length - 1; i++)
      for (let j = 0; j < 16; j++) {
        const lo = curve.knots[i],
          span = curve.knots[i + 1] - lo;
        positions.push(...curveAt(curve, lo + (span * j) / 16), ...curveAt(curve, lo + (span * (j + 1)) / 16));
      }
    ghost.geometry.dispose();
    ghost.geometry = new THREE.BufferGeometry();
    ghost.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  }

  function set(next: SurfaceGuidePlacement | null) {
    placement = next;
    pick.geometry.dispose();
    pick.geometry = new THREE.BufferGeometry();
    ghost.geometry.dispose();
    ghost.geometry = new THREE.BufferGeometry();
    pointGhost.geometry.dispose();
    pointGhost.geometry = new THREE.BufferGeometry();
    snapGhost.geometry.dispose();
    snapGhost.geometry = new THREE.BufferGeometry();
    snap = next?.snapTargets ? surfaceGuideSnapper(next.charts, next.axis, next.snapTargets) : undefined;
    if (!next) {
      position = null;
      valid = false;
      ghost.visible = false;
      pointGhost.visible = false;
      snapGhost.visible = false;
      return;
    }
    const positions: number[] = [],
      uvs: number[] = [],
      indices: number[] = [];
    const steps = 12,
      side = steps + 1;
    for (const chart of next.charts) {
      const start = positions.length / 3;
      for (let u = 0; u <= steps; u++)
        for (let v = 0; v <= steps; v++) {
          positions.push(...patchPoint(chart.controls, u / steps, v / steps));
          uvs.push(
            chart.domain[0] + ((chart.domain[1] - chart.domain[0]) * u) / steps,
            chart.domain[2] + ((chart.domain[3] - chart.domain[2]) * v) / steps,
          );
        }
      for (let u = 0; u < steps; u++)
        for (let v = 0; v < steps; v++) {
          const a = start + u * side + v,
            b = a + 1,
            c = a + side,
            d = c + 1;
          indices.push(a, d, c, a, b, d);
        }
    }
    pick.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    pick.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    pick.geometry.setIndex(indices);
    show(next.initial);
  }

  function update(event?: PointerEvent) {
    if (!placement) return false;
    if (event) stage.castAt(event);
    const hit = stage.pickSurface(pick);
    if (!hit?.face || hit.faceIndex === undefined) {
      show(null);
      return true;
    }
    const points = pick.geometry.getAttribute('position'),
      uv = pick.geometry.getAttribute('uv');
    const local = hit.point.clone().applyMatrix4(pick.matrixWorld.clone().invert());
    const triangle = [hit.face.a, hit.face.b, hit.face.c];
    const [a, b, c] = triangle.map(i => new THREE.Vector3().fromBufferAttribute(points, i));
    const bary = THREE.Triangle.getBarycoord(local, a, b, c, new THREE.Vector3());
    if (!bary) {
      show(null);
      return true;
    }
    const component = placement.pointOn ? (placement.pointOn.axis === 'U' ? 0 : 1) : placement.axis === 'U' ? 1 : 0;
    const at = triangle.reduce((sum, i, j) => sum + uv.getComponent(i, component) * bary.getComponent(j), 0);
    show(Math.max(0, Math.min(1, at)));
    return true;
  }

  function commit(event?: PointerEvent) {
    if (!placement) return false;
    update(event);
    if (valid && position !== null) {
      const action = placement.commit,
        at = position;
      set(null);
      action(at);
    }
    return true;
  }
  function cancel() {
    const action = placement?.cancel;
    set(null);
    action?.();
  }
  return {
    set,
    update,
    commit,
    cancel,
    hide: () => {
      if (placement) show(null);
    },
    get active() {
      return placement !== null;
    },
    get position() {
      return position;
    },
  };
}
export type SurfaceGuideLayer = ReturnType<typeof createSurfaceGuideLayer>;
