import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import type { Stage } from '../stage';

const POINT_GEO = new THREE.SphereGeometry(1.15, 10, 8);
const POINT_COLOR = 0x50d8d0;
const SNAP_COLOR = 0x62f0b6;
const LINE_COLOR = 0x8ffff8;

/** Two-click tube-axis placement. This layer owns only the endpoints and axis guide; the host derives the live
 * quad shell from its current diameter/section controls and displays it through the shared loft preview. */
export function createTubeToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false;
  let points: PlacementEndpoint[] = [];
  let hover: PlacementEndpoint | null = null;
  let listener: (() => void) | null = null;
  const pointMat = new THREE.MeshBasicMaterial({ color: POINT_COLOR, depthTest: false, depthWrite: false });
  const snapMat = new THREE.MeshBasicMaterial({ color: SNAP_COLOR, depthTest: false, depthWrite: false });
  const dots = Array.from({ length: 2 }, () => new THREE.Mesh(POINT_GEO, pointMat));
  const hoverDot = new THREE.Mesh(POINT_GEO, pointMat);
  const line = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, depthWrite: false }),
  );
  for (const object of [...dots, hoverDot, line]) {
    object.visible = false;
    object.renderOrder = 10_000;
    object.raycast = () => { /* placement guides are never pick targets */ };
    stage.worldRoot.add(object);
  }

  function placement(axisLocked = false): PlacementEndpoint | null {
    return resolvePlacementEndpoint({ stage, terrain, pickVertex }, points[0]?.pos ?? null, axisLocked);
  }

  function redraw() {
    dots.forEach((dot, i) => {
      const point = points[i];
      dot.visible = !!point;
      if (point) {
        dot.material = point.vertex !== null ? snapMat : pointMat;
        dot.position.set(point.pos[0], point.pos[1], point.pos[2]);
      }
    });
    hoverDot.visible = !!(active && points.length < 2 && hover);
    if (hover) {
      hoverDot.material = hover.vertex !== null ? snapMat : pointMat;
      hoverDot.position.set(hover.pos[0], hover.pos[1], hover.pos[2]);
    }
    const axis = points.length === 2 ? points.map(point => point.pos)
      : points.length === 1 && hover ? [points[0].pos, hover.pos] : [];
    if (axis.length === 2) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(axis.map(p => new THREE.Vector3(p[0], p[1], p[2])));
      line.visible = true;
    } else line.visible = false;
    listener?.();
  }

  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    points = [];
    hover = null;
    if (!on) {
      dots.forEach(dot => { dot.visible = false; });
      hoverDot.visible = false;
      line.visible = false;
    }
    listener?.();
  }

  function onHover(event: PointerEvent): boolean {
    if (!active) return false;
    if (points.length >= 2) return true;
    stage.castAt(event);
    hover = points.length < 2 ? placement(event.shiftKey) : null;
    redraw();
    return true;
  }

  function onCommit(axisLocked = false) {
    if (!active || points.length >= 2) return;
    const endpoint = placement(axisLocked);
    if (!endpoint) return;
    if (points[0] && Math.hypot(
      points[0].pos[0] - endpoint.pos[0], points[0].pos[1] - endpoint.pos[1], points[0].pos[2] - endpoint.pos[2],
    ) < 1e-3) return;
    points.push(endpoint);
    hover = null;
    redraw();
  }

  function refresh() {
    if (!active || points.length >= 2) return;
    hover = placement(false);
    redraw();
  }

  return {
    setActive, onHover, onCommit, refresh,
    setListener(next: (() => void) | null) { listener = next; },
    get active() { return active; },
    get points(): readonly V3[] { return points.map(point => point.pos); },
    get hover(): V3 | null { return hover?.pos ?? null; },
  };
}

export type TubeToolLayer = ReturnType<typeof createTubeToolLayer>;
