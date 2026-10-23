import * as THREE from 'three';
import type { Stage } from '../stage';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import { DRAW_POINT_GEO, scaleDrawMarkers } from './draw-markers';
import { MAX_SURFACE_BOUNDARY_POINTS } from '../../../core/mesh/surface-boundary';
import { dataToScene, sceneToData } from '../coordinates';

/** A transient boundary loop. Close it to edit its points; Enter commits the Surface atomically. */
export function createSurfaceToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false,
    points: PlacementEndpoint[] = [],
    hover: PlacementEndpoint | null = null,
    closing = false,
    closed = false,
    selected: number | null = null;
  const material = new THREE.MeshBasicMaterial({ color: 0xeaa6ff, depthTest: false, depthWrite: false }),
    selectedMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }),
    snapMaterial = new THREE.MeshBasicMaterial({ color: 0x62f0b6, depthTest: false, depthWrite: false }),
    dots: THREE.Mesh[] = [];
  const cursor = new THREE.Mesh(DRAW_POINT_GEO, material),
    line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xeaa6ff, depthTest: false, depthWrite: false }),
    );
  for (const object of [cursor, line]) {
    object.visible = false;
    object.renderOrder = 16;
    object.raycast = () => {};
    stage.worldRoot.add(object);
  }
  const pointHandle = new THREE.Object3D(); // scene-root anchor, outside the mirrored worldRoot
  stage.scene.add(pointHandle);
  function pointAtPointer() {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    let nearest: number | null = null,
      distance = 14 ** 2;
    points.forEach((p, i) => {
      const point = new THREE.Vector3(...p.pos).applyMatrix4(stage.worldRoot.matrixWorld).project(stage.camera),
        d =
          (((point.x - stage.pointer.x) * rect.width) / 2) ** 2 +
          (((point.y - stage.pointer.y) * rect.height) / 2) ** 2;
      if (point.z >= -1 && point.z <= 1 && d < distance) {
        nearest = i;
        distance = d;
      }
    });
    return nearest;
  }
  function syncGizmo() {
    if (!active || selected === null || !points[selected]) {
      if (stage.gizmoKind === 'surfacepoint') stage.detachGizmo();
      return;
    }
    if (stage.gizmo.dragging) return;
    dataToScene(points[selected].pos, pointHandle.position);
    if (stage.gizmoKind !== 'surfacepoint' || stage.gizmoKnot !== selected)
      stage.attachGizmo(pointHandle, 'surfacepoint', selected);
  }
  function placement(axisLocked = false, onSurface = false) {
    closing = !closed && points.length >= 4 && pointAtPointer() === 0;
    return closing
      ? points[0]
      : resolvePlacementEndpoint({ stage, terrain, pickVertex }, points.at(-1)?.pos ?? null, {
          axisLocked,
          onSurface,
          levelPlane: true,
        });
  }
  function redraw() {
    while (dots.length < points.length) {
      const dot = new THREE.Mesh(DRAW_POINT_GEO, material);
      dot.renderOrder = 16;
      dot.raycast = () => {};
      stage.worldRoot.add(dot);
      dots.push(dot);
    }
    dots.forEach((dot, i) => {
      dot.visible = active && i < points.length;
      if (dot.visible) {
        dot.position.set(...points[i].pos);
        dot.material = selected === i ? selectedMaterial : points[i].vertex !== null ? snapMaterial : material;
      }
    });
    cursor.visible = active && !!hover;
    if (hover) {
      cursor.position.set(...hover.pos);
      cursor.material = closing || hover.vertex !== null ? snapMaterial : material;
    }
    const outline = [...points.map(p => p.pos), ...(closed ? [points[0].pos] : hover ? [hover.pos] : [])];
    if (outline.length >= 2) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(outline.map(p => new THREE.Vector3(...p)));
      line.visible = true;
    } else line.visible = false;
    syncGizmo();
    stage.cb.onCreateSurfaceChange?.();
  }
  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    points = [];
    hover = null;
    closing = false;
    closed = false;
    selected = null;
    redraw();
  }
  function onHover(event: PointerEvent) {
    if (!active) return false;
    if (closed || selected !== null) return true;
    stage.castAt(event);
    hover = placement(event.shiftKey, event.ctrlKey || event.metaKey);
    redraw();
    return true;
  }
  function onCommit(axisLocked = false, onSurface = false) {
    if (!active) return;
    const picked = pointAtPointer();
    if (picked !== null) {
      if (!closed && picked === 0 && points.length >= 4) closed = true;
      selected = picked;
      hover = null;
      closing = false;
      redraw();
      return;
    }
    selected = null;
    if (closed) {
      redraw();
      return;
    }
    const endpoint = placement(axisLocked, onSurface);
    if (!endpoint) return;
    if (
      points.length >= MAX_SURFACE_BOUNDARY_POINTS ||
      points.some(p => Math.hypot(...p.pos.map((n, i) => n - endpoint.pos[i])) < 1e-6)
    )
      return;
    points.push({ pos: [...endpoint.pos], vertex: endpoint.vertex });
    hover = null;
    redraw();
  }
  return {
    setActive,
    onHover,
    onCommit,
    gizmoDragging(dragging: boolean) {
      if (!dragging) syncGizmo();
    },
    gizmoChanged() {
      if (!active || selected === null || stage.gizmoKind !== 'surfacepoint') return;
      // A snap copies an existing boundary. Moving the draft point releases that copy's binding.
      points[selected] = { pos: sceneToData(pointHandle.position), vertex: null };
      hover = null;
      closing = false;
      redraw();
    },
    undo() {
      if (active) {
        points.pop();
        hover = null;
        closing = false;
        closed = false;
        selected = null;
        redraw();
      }
    },
    scaleMarkers: () => scaleDrawMarkers(stage, [...dots, cursor], 6),
    get active() {
      return active;
    },
    get points(): readonly PlacementEndpoint[] {
      return points;
    },
    get hover() {
      return hover;
    },
    get closing() {
      return closing;
    },
    get closed() {
      return closed;
    },
    get selected() {
      return selected;
    },
  };
}
export type SurfaceToolLayer = ReturnType<typeof createSurfaceToolLayer>;
