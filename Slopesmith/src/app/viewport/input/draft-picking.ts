import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { dataToScene } from '../coordinates';
import type { Stage } from '../stage';

/** Pick a draft's boundary edges in screen pixels, optionally rejecting edges behind its nearest face. */
export function pickDraftEdge(
  stage: Stage,
  points: readonly V3[],
  edges: readonly (readonly [number, number])[],
  surfaceDistance?: number,
): number | null {
  const rect = stage.renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((stage.pointer.x + 1) * rect.width) / 2,
    ((1 - stage.pointer.y) * rect.height) / 2,
  );
  const closest = new THREE.Vector3();
  let best: number | null = null,
    bestD2 = 10 ** 2,
    bestDepth = Infinity;
  edges.forEach(([from, to], index) => {
    const a = dataToScene(points[from]),
      b = dataToScene(points[to]);
    const pa = a.clone().project(stage.camera),
      pb = b.clone().project(stage.camera);
    if (pa.z < -1 || pa.z > 1 || pb.z < -1 || pb.z > 1) return;
    const start = new THREE.Vector2(((pa.x + 1) * rect.width) / 2, ((1 - pa.y) * rect.height) / 2);
    const delta = new THREE.Vector2(((pb.x - pa.x) * rect.width) / 2, ((pa.y - pb.y) * rect.height) / 2);
    const t = THREE.MathUtils.clamp(pointer.clone().sub(start).dot(delta) / Math.max(delta.lengthSq(), 1e-12), 0, 1);
    const d2 = start.addScaledVector(delta, t).distanceToSquared(pointer);
    if (d2 > bestD2 + 1e-8) return;
    stage.ray.ray.distanceSqToSegment(a, b, undefined, closest);
    const depth = closest.distanceTo(stage.ray.ray.origin);
    if (surfaceDistance !== undefined && depth > surfaceDistance + stage.worldPerPixel(closest) * 1.5) return;
    if (Math.abs(d2 - bestD2) < 1e-8 && depth >= bestDepth) return;
    best = index;
    bestD2 = d2;
    bestDepth = depth;
  });
  return best;
}
