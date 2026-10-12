import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { gridCornersFromClicks, type GridCorner, type GridCorners } from '../../../core/mesh/ops/grid';
import { dataToScene, sceneToData } from '../coordinates';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import type { Stage } from '../stage';
import { DRAW_POINT_GEO, scaleDrawMarkers } from './draw-markers';

const POINT_COLOR = 0x50d8d0;
const SNAP_COLOR = 0x62f0b6;
const LINE_COLOR = 0x8ffff8;
/** A draft's corner handles are larger than the placement dots: they are click targets, not just markers. */
const CORNER_PX = 6;
/** How near a corner handle, in CSS pixels, a click must land to pick it up. */
const CORNER_PICK_PX = 14;

/** Create Grid in two phases. PLACING: three clicks — the first side's two ends, then a point that sets the width
 * — with the cursor standing in for the third so the host can preview the lattice; a later corner lands on the
 * level plane through the previous one, so a grid drawn in open space is flat, and Ctrl puts it on the surface.
 * DRAFT: the third click squares the corners off into four, which stay editable until Enter. A click on a free
 * corner seats the shared gizmo on it; a click on the grid itself seats it at the centre and moves, turns or
 * scales the whole draft — but only while no corner is snapped, since a snapped corner pins the grid to what it
 * attaches to. This layer owns the corners, the guides and the lattice lines; the host plans the lattice and
 * fills it through the shared loft preview. */
export function createGridToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false;
  let points: PlacementEndpoint[] = [];
  let hover: PlacementEndpoint | null = null;
  /** The draft's four corners once the third is placed; null while placing. */
  let corners: GridCorners | null = null;
  /** What the gizmo is on: a corner, the whole draft, or nothing. */
  let selected: number | 'whole' | null = null;
  /** A whole-draft drag's start: the anchor's pose and the corners it moves from. */
  let wholeDrag: { pivot: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; corners: GridCorners } | null = null;
  /** The camera when the third corner went down, so orbiting before Enter never turns the grid over. */
  let placedEye: V3 | null = null;
  let listener: (() => void) | null = null;
  const material = (color: number) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
  const pointMat = material(POINT_COLOR), snapMat = material(SNAP_COLOR), selectedMat = material(0xffffff);
  const dots = Array.from({ length: 4 }, () => new THREE.Mesh(DRAW_POINT_GEO, pointMat));
  const hoverDot = new THREE.Mesh(DRAW_POINT_GEO, pointMat);
  const lineMat = new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, depthWrite: false });
  const line = new THREE.Line(new THREE.BufferGeometry(), lineMat);
  // The fill alone hides the divisions being chosen, so the lattice is drawn as lines too.
  const lattice = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
  for (const object of [...dots, hoverDot, line, lattice]) {
    object.visible = false;
    object.renderOrder = 10_000;
    object.raycast = () => { /* corners are picked on screen; the guides never are */ };
    stage.worldRoot.add(object);
  }
  const cornerHandle = new THREE.Object3D(); // scene-root gizmo anchors, Z negated by hand
  const wholeHandle = new THREE.Object3D();
  stage.scene.add(cornerHandle, wholeHandle);
  const scratch = new THREE.Vector3();

  const liveEye = (): V3 => sceneToData(stage.camera.getWorldPosition(new THREE.Vector3()));
  const free = (pos: V3): GridCorner => ({ pos, vertex: null });
  const pinned = (corner: GridCorner) => corner.vertex !== null;
  const ownsGizmo = () => stage.gizmoKind === 'gridcorner' || stage.gizmoKind === 'grid';

  function placement(axisLocked = false, onSurface = false): PlacementEndpoint | null {
    return resolvePlacementEndpoint(
      { stage, terrain, pickVertex }, points.at(-1)?.pos ?? null, { axisLocked, onSurface, levelPlane: true },
    );
  }

  function redraw() {
    const shown: readonly GridCorner[] = corners ?? points;
    dots.forEach((dot, i) => {
      const corner = shown[i];
      dot.visible = !!corner;
      if (!corner) return;
      dot.material = corner.vertex !== null ? snapMat : selected === i ? selectedMat : pointMat;
      dot.position.set(corner.pos[0], corner.pos[1], corner.pos[2]);
    });
    hoverDot.visible = !!(active && !corners && hover);
    if (hover) {
      hoverDot.material = hover.vertex !== null ? snapMat : pointMat;
      hoverDot.position.set(hover.pos[0], hover.pos[1], hover.pos[2]);
    }
    const side = corners ? [] : points.length >= 2 ? [points[0].pos, points[1].pos]
      : points.length === 1 && hover ? [points[0].pos, hover.pos] : [];
    if (side.length === 2) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(side.map(p => new THREE.Vector3(p[0], p[1], p[2])));
      line.visible = true;
    } else line.visible = false;
    listener?.();
  }

  /** The draft's own frame, scene space: X along the first side, Y off its face (upward where it can be), Z across.
   *  Scale handles always run along the anchor's own axes, so seating them here stretches the grid's length and
   *  width rather than shearing a turned grid along the world's; Move and Rotate stay on world axes. */
  function gridFrame(draft: GridCorners): THREE.Quaternion {
    const [a, b, , d] = draft.map(corner => dataToScene(corner.pos));
    const x = b.clone().sub(a).normalize();
    const y = new THREE.Vector3().crossVectors(d.clone().sub(a), x).normalize();
    if (x.lengthSq() < 0.5 || y.lengthSq() < 0.5) return new THREE.Quaternion();
    if (y.y < 0) y.negate();
    const z = new THREE.Vector3().crossVectors(x, y);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }

  /** Keep the gizmo on the selected corner or the draft's centre, except while it is being dragged: then it owns
   *  its own pose. */
  function syncGizmo() {
    if (!corners || selected === null) {
      if (ownsGizmo()) stage.detachGizmo();
      return;
    }
    if (ownsGizmo() && stage.gizmo.dragging) return;
    if (selected === 'whole') {
      const centre = corners.reduce((sum, c) => sum.add(dataToScene(c.pos, scratch)), new THREE.Vector3()).multiplyScalar(0.25);
      wholeHandle.position.copy(centre);
      wholeHandle.quaternion.copy(gridFrame(corners));
      wholeHandle.scale.setScalar(1);
      if (stage.gizmoKind !== 'grid' || stage.gizmo.object !== wholeHandle) stage.attachGizmo(wholeHandle, 'grid', -1);
      return;
    }
    dataToScene(corners[selected].pos, cornerHandle.position);
    if (stage.gizmoKind !== 'gridcorner' || stage.gizmoKnot !== selected) stage.attachGizmo(cornerHandle, 'gridcorner', selected);
  }

  function select(next: number | 'whole' | null) {
    selected = next;
    redraw();
    syncGizmo();
  }

  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    points = [];
    hover = null;
    corners = null;
    selected = null;
    wholeDrag = null;
    placedEye = null;
    if (!on) {
      dots.forEach(dot => { dot.visible = false; });
      hoverDot.visible = false;
      line.visible = false;
      lattice.visible = false;
      if (ownsGizmo()) stage.detachGizmo();
    }
    listener?.();
  }

  /** The free corner handle under the (already cast) pointer, by screen distance. Snapped corners are pinned. */
  function cornerAtPointer(): number | null {
    if (!corners) return null;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const cx = ((stage.pointer.x + 1) / 2) * rect.width, cy = ((1 - stage.pointer.y) / 2) * rect.height;
    let best: number | null = null, bestD2 = CORNER_PICK_PX ** 2;
    for (let i = 0; i < corners.length; i++) {
      if (pinned(corners[i])) continue;
      const v = dataToScene(corners[i].pos, scratch).project(stage.camera);
      if (v.z < -1 || v.z > 1) continue;
      const d2 = (((v.x + 1) / 2) * rect.width - cx) ** 2 + (((1 - v.y) / 2) * rect.height - cy) ** 2;
      if (d2 <= bestD2) { best = i; bestD2 = d2; }
    }
    return best;
  }

  /** Whether the (already cast) pointer ray crosses the draft's outline. */
  function fillAtPointer(): boolean {
    if (!corners) return false;
    const [a, b, c, d] = corners.map(corner => dataToScene(corner.pos));
    const ray = stage.ray.ray, hit = new THREE.Vector3();
    return !!(ray.intersectTriangle(a, b, c, false, hit) || ray.intersectTriangle(a, c, d, false, hit));
  }

  /** A draft click: pick up a free corner, or the whole draft when nothing pins it; anywhere else lets go. */
  function pick() {
    const corner = cornerAtPointer();
    if (corner !== null) { select(corner); return; }
    select(corners && !corners.some(pinned) && fillAtPointer() ? 'whole' : null);
  }

  function onHover(event: PointerEvent): boolean {
    if (!active) return false;
    if (corners) return true; // a draft is edited through its handles, not re-placed
    stage.castAt(event);
    hover = placement(event.shiftKey, event.ctrlKey || event.metaKey);
    redraw();
    return true;
  }

  function onCommit(axisLocked = false, onSurface = false) {
    if (!active) return;
    if (corners) { pick(); return; }
    const endpoint = placement(axisLocked, onSurface);
    if (!endpoint) return;
    if (points.some(point => (point.vertex !== null && point.vertex === endpoint.vertex) || Math.hypot(
      point.pos[0] - endpoint.pos[0], point.pos[1] - endpoint.pos[1], point.pos[2] - endpoint.pos[2],
    ) < 1e-3)) return;
    points.push(endpoint);
    hover = null;
    if (points.length === 3) {
      placedEye = liveEye();
      corners = gridCornersFromClicks(points[0], points[1], points[2]);
      // A free draft comes up ready to move; one pinned to existing points waits for a corner to be picked.
      selected = corners.some(pinned) ? null : 'whole';
    }
    redraw();
    syncGizmo();
  }

  function refresh() {
    if (!active || corners) return;
    hover = placement(false);
    redraw();
  }

  /** A gizmo drag on the draft starts — remember where the whole draft was — or ends, squaring the anchor up. */
  function gizmoDragging(dragging: boolean) {
    if (!dragging) {
      wholeDrag = null;
      syncGizmo();
      return;
    }
    if (selected === 'whole' && corners) wholeDrag = {
      pivot: wholeHandle.position.clone(), quaternion: wholeHandle.quaternion.clone(), scale: wholeHandle.scale.clone(), corners,
    };
  }

  /** The gizmo moved: carry the picked corner to it, or move, turn and scale the whole draft from the drag's
   *  start about its centre. */
  function gizmoChanged() {
    if (!corners) return;
    if (typeof selected === 'number') {
      const next = [...corners] as GridCorner[];
      next[selected] = free(sceneToData(cornerHandle.position));
      corners = next as unknown as GridCorners;
    } else if (selected === 'whole' && wholeDrag) {
      const drag = wholeDrag, unframe = drag.quaternion.clone().invert();
      const turn = wholeHandle.quaternion.clone().multiply(unframe);
      const stretch = wholeHandle.scale.clone().divide(drag.scale);
      stretch.set(Math.max(0.01, stretch.x), Math.max(0.01, stretch.y), Math.max(0.01, stretch.z));
      // The stretch is along the anchor's own axes (the grid's sides, gridFrame), so it is applied in that frame.
      corners = drag.corners.map(corner => free(sceneToData(dataToScene(corner.pos).sub(drag.pivot)
        .applyQuaternion(unframe).multiply(stretch).applyQuaternion(drag.quaternion)
        .applyQuaternion(turn).add(wholeHandle.position)))) as unknown as GridCorners;
    }
    redraw();
  }

  /** The host resized the draft (a typed length or width). */
  function setCorners(next: GridCorners) {
    if (!corners) return;
    corners = next;
    redraw();
    syncGizmo();
  }

  /** Draw the planned lattice's row and column lines (row-major, columns + 1 points a row), or hide them. */
  function setLattice(plan: { points: readonly V3[]; columns: number; rows: number } | null) {
    lattice.visible = !!plan && active;
    if (!plan || !active) return;
    const stride = plan.columns + 1, segments: number[] = [];
    const join = (a: V3, b: V3) => segments.push(...a, ...b);
    for (let j = 0; j <= plan.rows; j++) for (let i = 0; i <= plan.columns; i++) {
      if (i < plan.columns) join(plan.points[j * stride + i], plan.points[j * stride + i + 1]);
      if (j < plan.rows) join(plan.points[j * stride + i], plan.points[(j + 1) * stride + i]);
    }
    lattice.geometry.dispose();
    lattice.geometry = new THREE.BufferGeometry();
    lattice.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
  }

  return {
    setActive, onHover, onCommit, refresh, setLattice, setCorners, gizmoDragging, gizmoChanged,
    /** Per frame: hold the corner and cursor dots at a constant size on screen. */
    scaleMarkers() {
      scaleDrawMarkers(stage, dots, corners ? CORNER_PX : undefined);
      scaleDrawMarkers(stage, [hoverDot]);
    },
    setListener(next: (() => void) | null) { listener = next; },
    get active() { return active; },
    get points(): readonly PlacementEndpoint[] { return points; },
    get hover(): PlacementEndpoint | null { return hover; },
    get corners(): GridCorners | null { return corners; },
    /** Whether the gizmo holds the whole draft, which it can move, turn and scale; a corner only moves. */
    get wholeSelected() { return selected === 'whole'; },
    /** The camera, in data space: the side the grid is drawn from becomes its front. */
    get eye(): V3 { return placedEye ?? liveEye(); },
  };
}

export type GridToolLayer = ReturnType<typeof createGridToolLayer>;
