import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { sampleSpine } from '../../../core/math/spine';
import { dataToScene, sceneToData } from '../coordinates';
import type { Stage } from '../stage';

/** The course knots' own handle radius (Viewport.refreshMountainOverlays), so a drawn point reads as one. */
const DOT_RADIUS = 5;
const DOT_GEO = new THREE.SphereGeometry(1, 16, 12);
const START_COLOR = 0x71e858;
const POINT_COLOR = 0x50d8d0;
const LINE_COLOR = 0x8ffff8;
/** A click this close (screen px) to the newest point finishes the line: the second half of a double-click. */
const FINISH_CLICK_PX = 8;

export type CourseDrawHandlers = {
  /** A point was added or removed. */
  changed(): void;
  /** The newest point was clicked again (a double-click): the host commits the line. */
  finish(): void;
};

/**
 * Scene ▸ Course ▸ reset course: the run redrawn by clicking the authored terrain, start first, finish last.
 * Every point is a surface hit, so the new line is seated on the snow by construction. The layer holds only the
 * transient points and their guide — the exact Catmull-Rom spine the course will follow once committed — and
 * the host turns them into knots (core/doc/course redrawCourse). The old course stays drawn until it does.
 */
export function createCourseDrawLayer(stage: Stage, terrain: () => THREE.Mesh) {
  let active = false;
  let handlers: CourseDrawHandlers | null = null;
  let points: V3[] = [];
  let hover: V3 | null = null;
  /** When the last placing click landed: the browser's dblclick arrives after the press that finished. */
  let lastClickAt = -Infinity;
  const startMat = new THREE.MeshBasicMaterial({ color: START_COLOR, depthTest: false, depthWrite: false });
  const pointMat = new THREE.MeshBasicMaterial({ color: POINT_COLOR, depthTest: false, depthWrite: false });
  const dots = new THREE.Group();
  const pointDots: THREE.Mesh[] = [];
  const hoverDot = new THREE.Mesh(DOT_GEO, pointMat);
  hoverDot.scale.setScalar(DOT_RADIUS * 0.6);
  const line = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, depthWrite: false }),
  );
  for (const object of [dots, hoverDot, line]) {
    object.visible = false;
    object.renderOrder = 10_000;
    object.raycast = () => { /* placement guides are never pick targets */ };
    stage.worldRoot.add(object);
  }

  /** The authored terrain under the current ray, in data space. Only the mountain's own surface: a course is
   *  ridden on snow, so a click on the sky or the loaded reference places nothing. */
  function surfacePoint(): V3 | null {
    const hit = stage.pickSurface(terrain());
    return hit ? sceneToData(hit.point) : null;
  }

  function redraw() {
    while (pointDots.length < points.length) {
      const dot = new THREE.Mesh(DOT_GEO, pointMat);
      dot.renderOrder = 10_000;
      dot.scale.setScalar(DOT_RADIUS);
      dot.raycast = () => { /* placement guides are never pick targets */ };
      pointDots.push(dot);
      dots.add(dot);
    }
    while (pointDots.length > points.length) dots.remove(pointDots.pop()!);
    points.forEach((point, i) => {
      pointDots[i].position.set(point[0], point[1], point[2]);
      pointDots[i].material = i === 0 ? startMat : pointMat;
    });
    dots.visible = active && points.length > 0;
    hoverDot.visible = !!(active && hover);
    if (hover) hoverDot.position.set(hover[0], hover[1], hover[2]);
    const guide = [...points, ...(hover ? [hover] : [])];
    if (active && guide.length >= 2) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(
        sampleSpine(guide.map(pos => ({ pos }))).map(s => new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2])));
      line.visible = true;
    } else line.visible = false;
  }

  function begin(next: CourseDrawHandlers) {
    active = true;
    handlers = next;
    points = [];
    hover = null;
    redraw();
  }

  function end() {
    active = false;
    handlers = null;
    points = [];
    hover = null;
    redraw();
  }

  function onHover(event: PointerEvent): boolean {
    if (!active) return false;
    stage.castAt(event);
    hover = surfacePoint();
    redraw();
    return true;
  }

  /** Whether a click at this screen position lands on the newest point — the repeat click that finishes. */
  function onNewestPoint(at: { clientX: number; clientY: number }): boolean {
    const last = points.at(-1);
    if (!last) return false;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const ndc = dataToScene(last).project(stage.camera);
    const x = rect.left + (ndc.x + 1) / 2 * rect.width;
    const y = rect.top + (1 - ndc.y) / 2 * rect.height;
    return Math.hypot(x - at.clientX, y - at.clientY) <= FINISH_CLICK_PX;
  }

  /** A click: add the terrain point under the pointer, or finish when it repeats the newest point. A touch tap
   *  arrives without a position (the ray is already cast) and so only ever adds. */
  function onCommit(at?: { clientX: number; clientY: number }) {
    if (!active) return;
    lastClickAt = performance.now();
    if (at) stage.castAt(at);
    if (at && points.length >= 2 && onNewestPoint(at)) { handlers?.finish(); return; }
    const point = surfacePoint();
    if (!point) return;
    const previous = points.at(-1);
    if (previous && Math.hypot(previous[0] - point[0], previous[1] - point[1], previous[2] - point[2]) < 0.1) return;
    points.push(point);
    hover = null;
    redraw();
    handlers?.changed();
  }

  function removeLast() {
    if (!active || !points.length) return;
    points.pop();
    redraw();
    handlers?.changed();
  }

  return {
    begin, end, onHover, onCommit, removeLast,
    /** Whether a double-click belongs to the course — while drawing, or the one whose second press finished
     *  it — rather than to Info's focus-the-camera gesture. */
    ownsDoubleClick: () => active || performance.now() - lastClickAt < 600,
    get active() { return active; },
    get points(): readonly V3[] { return points; },
  };
}

export type CourseDrawLayer = ReturnType<typeof createCourseDrawLayer>;
