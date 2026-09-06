import * as THREE from 'three';
import type { CoursePath, V3 } from '../../../core/doc/types';
import { aiPathLines } from '../../../core/doc/course';
import type { Stage } from '../stage';

/**
 * The authored mountain's AI opponent lines — the SAME six gate-anchored wandering paths the AIP.json
 * export ships (core/doc/course `aiPathLines`, derived from the course + the doc's seed), drawn amber like
 * the reference overlay's gate paths (every authored line IS a `StartPosList` gate path). Lives at scene
 * root with Z negated by hand, like the course guide it annotates, but rides its own Info toggle ("Show AI
 * paths") — six extra lines over the spine read as clutter while shaping the run.
 */
export function createAiPathsLayer(stage: Stage) {
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xffc24a });
  let visible = false;
  let built = false;

  const flip = (p: V3): V3 => [p[0], p[1], -p[2]];

  /** Re-derive + rebuild the lines from the course and seed (null / short course clears them). */
  function setCourse(course: CoursePath | null, seed: number) {
    for (const c of group.children) (c as THREE.Line).geometry.dispose();
    group.clear();
    built = !!course && course.knots.length >= 2;
    group.visible = visible && built;
    if (!course || !built) return;
    for (const line of aiPathLines(course, seed)) {
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(line.map(p => { const q = flip(p); return new THREE.Vector3(q[0], q[1], q[2]); })),
        mat,
      ));
    }
  }

  /** Shown on the Info "Show AI paths" toggle (independent of the course guide). */
  function setVisible(on: boolean) {
    visible = on;
    group.visible = on && built;
  }

  stage.scene.add(group);
  return { setCourse, setVisible };
}

export type AiPathsLayer = ReturnType<typeof createAiPathsLayer>;
