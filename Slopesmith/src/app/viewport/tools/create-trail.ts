import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { sampleRail } from '../../../core/rails/rails';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import type { Stage } from '../stage';

const POINT_GEO = new THREE.SphereGeometry(1.15, 10, 8);
const POINT_COLOR = 0x50d8d0;
const LINE_COLOR = 0x8ffff8;

/** Multi-click centre-spline placement for Create Trail. The mesh itself is derived by the host through the
 * shared trail generator and loft-preview layer; this controller owns only transient knots and their exact
 * rail/motion-path Catmull-Rom guide. Surface contacts are lifted so the generated trail sits above its base. */
export function createTrailToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false;
  let points: PlacementEndpoint[] = [];
  let hover: PlacementEndpoint | null = null;
  let surfaceLiftM = 0.25;
  let listener: ((pointsChanged: boolean) => void) | null = null;
  const pointMat = new THREE.MeshBasicMaterial({ color: POINT_COLOR, depthTest: false, depthWrite: false });
  const dots = new THREE.Group();
  const pointDots: THREE.Mesh[] = [];
  const hoverDot = new THREE.Mesh(POINT_GEO, pointMat);
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

  function placement(axisLocked = false): PlacementEndpoint | null {
    return resolvePlacementEndpoint(
      { stage, terrain, pickVertex }, points.at(-1)?.pos ?? null, axisLocked, surfaceLiftM,
    );
  }

  function redraw(pointsChanged = false) {
    while (pointDots.length < points.length) {
      const dot = new THREE.Mesh(POINT_GEO, pointMat);
      dot.renderOrder = 10_000;
      dot.raycast = () => { /* placement guides are never pick targets */ };
      pointDots.push(dot);
      dots.add(dot);
    }
    while (pointDots.length > points.length) dots.remove(pointDots.pop()!);
    points.forEach((point, i) => pointDots[i].position.set(point.pos[0], point.pos[1], point.pos[2]));
    dots.visible = active && points.length > 0;
    hoverDot.visible = !!(active && hover);
    if (hover) hoverDot.position.set(hover.pos[0], hover.pos[1], hover.pos[2]);
    const guide = sampleRail([
      ...points.map(point => point.pos),
      ...(hover ? [hover.pos] : []),
    ], 16);
    if (guide.length >= 2) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(guide.map(p => new THREE.Vector3(p[0], p[1], p[2])));
      line.visible = active;
    } else line.visible = false;
    listener?.(pointsChanged);
  }

  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    points = [];
    hover = null;
    redraw(true);
  }

  function onHover(event: PointerEvent): boolean {
    if (!active) return false;
    stage.castAt(event);
    hover = placement(event.shiftKey);
    redraw();
    return true;
  }

  function onCommit(axisLocked = false) {
    if (!active) return;
    const endpoint = placement(axisLocked);
    if (!endpoint) return;
    const previous = points.at(-1)?.pos;
    if (previous && Math.hypot(
      previous[0] - endpoint.pos[0], previous[1] - endpoint.pos[1], previous[2] - endpoint.pos[2],
    ) < 0.1) return;
    points.push(endpoint);
    hover = null;
    redraw(true);
  }

  function removeLast() {
    if (!active || !points.length) return;
    points.pop();
    hover = null;
    redraw(true);
  }

  function refresh() {
    if (!active) return;
    hover = placement(false);
    redraw();
  }

  return {
    setActive, onHover, onCommit, removeLast, refresh,
    setSurfaceLift(value: number) { surfaceLiftM = Math.max(0, value); refresh(); },
    setListener(next: ((pointsChanged: boolean) => void) | null) { listener = next; },
    get active() { return active; },
    get points(): readonly V3[] { return points.map(point => point.pos); },
    get hover(): V3 | null { return hover?.pos ?? null; },
  };
}

export type TrailToolLayer = ReturnType<typeof createTrailToolLayer>;
