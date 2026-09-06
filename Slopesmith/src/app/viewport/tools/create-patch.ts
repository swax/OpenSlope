import * as THREE from 'three';
import type { LoftPreviewLayer } from './loft-preview';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import type { Stage } from '../stage';

const POINT_GEO = new THREE.SphereGeometry(1.1, 10, 8);
const POINT_COLOR = 0x9a5cff;
const SNAP_COLOR = 0x62f0b6;
const LINE_COLOR = 0xd7b3ff;

/** Three/four-click patch placement. Corners are collected in perimeter order and can reuse existing vertices
 * or be placed on terrain / a screen-facing construction plane. The prospective final corner drives the
 * triangle/quad preview; dots and an outline keep the earlier steps readable. While drawing a quad, clicking
 * any of its first three corners again closes those three distinct corners as a triangle. */
export function createPatchToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  preview: LoftPreviewLayer,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false;
  let sides: 3 | 4 = 4;
  let points: PlacementEndpoint[] = [];
  let hover: PlacementEndpoint | null = null;
  let listener: (() => void) | null = null;
  const pointMat = new THREE.MeshBasicMaterial({ color: POINT_COLOR });
  const snapMat = new THREE.MeshBasicMaterial({ color: SNAP_COLOR });
  const dots = Array.from({ length: 4 }, () => new THREE.Mesh(POINT_GEO, pointMat));
  const hoverDot = new THREE.Mesh(POINT_GEO, pointMat);
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: LINE_COLOR }));
  for (const object of [...dots, hoverDot, line]) {
    object.visible = false;
    object.raycast = () => { /* placement previews are never pick targets */ };
    stage.worldRoot.add(object);
  }

  function placement(axisLocked = false): PlacementEndpoint | null {
    return resolvePlacementEndpoint({ stage, terrain, pickVertex }, points.at(-1)?.pos ?? null, axisLocked);
  }

  function samePoint(a: PlacementEndpoint, b: PlacementEndpoint) {
    return (a.vertex !== null && b.vertex !== null && a.vertex === b.vertex)
      || Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < 1e-6;
  }

  function closesTriangle(endpoint: PlacementEndpoint | null) {
    return sides === 4 && points.length === 3 && !!endpoint && points.some(point => samePoint(point, endpoint));
  }

  function redraw() {
    dots.forEach((dot, i) => {
      const point = points[i];
      dot.visible = !!point;
      if (point) dot.position.set(point.pos[0], point.pos[1], point.pos[2]);
    });
    hoverDot.visible = !!(active && hover);
    if (hover) {
      hoverDot.material = hover.vertex !== null ? snapMat : pointMat;
      hoverDot.position.set(hover.pos[0], hover.pos[1], hover.pos[2]);
    }
    const outline = [...points.map(point => point.pos), ...(hover ? [hover.pos] : [])];
    if (outline.length >= 2) {
      const draw = outline.length === sides ? [...outline, outline[0]] : outline;
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(draw.map(p => new THREE.Vector3(p[0], p[1], p[2])));
      line.visible = true;
    } else line.visible = false;
    if (closesTriangle(hover)) {
      preview.setPreview([[0, 1, 2, 2]], points.flatMap(point => point.pos));
    } else if (points.length === sides - 1 && hover) {
      const positions = [...points.map(point => point.pos), hover.pos].flat();
      preview.setPreview(sides === 3 ? [[0, 1, 2, 2]] : [[0, 1, 3, 2]], positions);
    } else preview.setPreview(null);
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
      preview.setPreview(null);
    }
    listener?.();
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
    if (closesTriangle(endpoint)) {
      const corners = points as [PlacementEndpoint, PlacementEndpoint, PlacementEndpoint];
      if (stage.cb.onCreatePatch?.(corners) !== false) points = [];
      hover = null;
      redraw();
      return;
    }
    if (points.some(point => samePoint(point, endpoint))) return;
    points.push(endpoint);
    hover = null;
    if (points.length === sides) {
      const corners = points as [PlacementEndpoint, PlacementEndpoint, PlacementEndpoint]
        | [PlacementEndpoint, PlacementEndpoint, PlacementEndpoint, PlacementEndpoint];
      if (stage.cb.onCreatePatch?.(corners) === false) points.pop();
      else points = [];
    }
    redraw();
  }

  function refresh() {
    if (!active) return;
    hover = placement(false);
    redraw();
  }

  return {
    setActive,
    setSides(next: 3 | 4) {
      if (sides === next) return;
      sides = next;
      points = [];
      hover = null;
      redraw();
    },
    onHover,
    onCommit,
    refresh,
    setPreviewListener(next: (() => void) | null) { listener = next; listener?.(); },
    get active() { return active; },
    get points(): readonly PlacementEndpoint[] { return points; },
    get hover(): PlacementEndpoint | null { return hover; },
  };
}

export type PatchToolLayer = ReturnType<typeof createPatchToolLayer>;
