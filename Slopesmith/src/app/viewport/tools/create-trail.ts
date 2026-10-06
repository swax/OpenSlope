import * as THREE from 'three';
import type { PathHandles, V3 } from '../../../core/doc/types';
import { sampleRail } from '../../../core/rails/rails';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import type { Stage } from '../stage';
import { dataToScene, sceneToData } from '../coordinates';
import type { TrailTransform } from '../types';

export type { TrailTransform };

const POINT_GEO = new THREE.SphereGeometry(1.15, 10, 8);
const POINT_COLOR = 0x50d8d0;
const SNAP_COLOR = 0xffc040; // amber: a point about to land on one already there
/** How near, on screen, the cursor or a dragged point has to come to another point to snap onto it. */
const SNAP_PX = 14;
const LINE_COLOR = 0x8ffff8;

/**
 * A trail's centre splines in Edit mode (docs/023): a bulb per shown point, the rail Catmull-Rom guide along each
 * shown path, and the translate gizmo on the picked point — the way a rail shows its nodes, except that the points
 * stay pickable while a path is still being drawn, so an earlier point can be moved before the last one is laid.
 *
 * The points belong to the host (`edit/trails.ts`), which shows them with `setKnots` and says which paths run
 * through them (`TrailShape`); this layer only reports. While drawing (`setActive(true)`), a click that lands on no
 * bulb asks the host to append a point at the surface point under it, lifted like the original Create Trail
 * placement, and the guide runs on to the cursor — from the end of the path being drawn, or from the point a new
 * path leaves (`TrailShape.draw`). Each hover is reported too, so the host can ghost what the click would lay.
 *
 * Points a moving point may land on (`TrailShape.snaps`, docs/023 · Networks) catch the cursor, and a dragged point,
 * within `SNAP_PX` on screen: the point lands exactly there, marked in amber, and the host joins the two.
 *
 * Paths selected with no point picked carry the gizmo at their patches' centre (kind `'trail'`): Move, Rotate and
 * Scale report the transform from the drag's start (`TrailTransform`), and the host takes every point and dragged
 * Bézier handle of theirs through it and re-cuts — the patches follow, and patches joined to them stretch.
 */
/** One shown path: its knots as places in the shown list, and its dragged handles. */
export interface TrailShapePath {
  nodes: readonly number[];
  handles?: readonly (PathHandles | null | undefined)[];
}

/** What the shown points are part of: the paths through them, where drawing goes on — the end of one of those
 *  paths, or a new path from the shown point `from` — and the points a moving point snaps onto. */
export interface TrailShape {
  paths: readonly TrailShapePath[];
  draw?: { path: number | null; end: 'start' | 'end'; from: number | null };
  snaps?: readonly V3[];
}

export function createTrailToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false;
  /** Every point shown, the paths through them, and where drawing goes on. */
  let knots: V3[] = [];
  let paths: TrailShapePath[] = [];
  let draw: TrailShape['draw'] = undefined;
  /** Points to snap onto, and the one the hover or a drag sits on now. */
  let snaps: V3[] = [];
  let snapped: V3 | null = null;
  let selected: number | null = null;
  let hover: PlacementEndpoint | null = null;
  let surfaceLiftM = 0.25;
  let listener: (() => void) | null = null;
  let onAppend: ((pos: V3) => void) | null = null;
  let onSelect: ((knot: number | null) => void) | null = null;
  let onTransform: ((xf: TrailTransform) => void) | null = null;
  let onHoverAt: ((pos: V3 | null) => void) | null = null;
  /** Where the gizmo sits while the trail is selected as a whole (data space); null when it is not. */
  let wholePivot: V3 | null = null;
  /** A whole-selection drag's start, scene space: the anchor's pose. */
  let wholeDrag: { pivot: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } | null = null;
  const pointMat = new THREE.MeshBasicMaterial({ color: POINT_COLOR, depthTest: false, depthWrite: false });
  const snapDot = new THREE.Mesh(POINT_GEO, new THREE.MeshBasicMaterial({ color: SNAP_COLOR, depthTest: false, depthWrite: false }));
  const selectedMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
  const dots = new THREE.Group();
  const knotDots: THREE.Mesh[] = [];
  const hoverDot = new THREE.Mesh(POINT_GEO, pointMat);
  const lineMat = new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, depthWrite: false });
  const line = new THREE.Line(new THREE.BufferGeometry(), lineMat); // a new path, from its point to the cursor
  const pathLines: THREE.Line[] = [];
  const moveHandle = new THREE.Object3D(); // scene-root gizmo anchor for the selected knot, Z negated by hand
  const wholeHandle = new THREE.Object3D(); // …and for the whole trail, at its ribbon's centre
  for (const object of [dots, hoverDot, line, snapDot]) {
    object.visible = false;
    object.renderOrder = 10_000;
    object.raycast = () => { /* the knot bulbs are picked explicitly by pickKnot */ };
    stage.worldRoot.add(object);
  }
  moveHandle.visible = false;
  stage.scene.add(moveHandle);
  wholeHandle.visible = false;
  stage.scene.add(wholeHandle);

  /** The point the next one is laid from: the end being drawn onto, or the point a new path leaves. */
  function drawFrom(): V3 | null {
    if (!draw) return null;
    const nodes = draw.path === null ? null : paths[draw.path]?.nodes;
    const at = nodes ? (draw.end === 'start' ? nodes[0] : nodes.at(-1)) : draw.from;
    return at === null || at === undefined ? null : knots[at] ?? null;
  }

  /** A polyline through `nodes` on `target`, or hidden when there are not two. */
  function setLine(target: THREE.Line, nodes: readonly V3[], nodeHandles?: readonly (PathHandles | null | undefined)[]) {
    const guide = sampleRail(nodes, 16, nodeHandles);
    if (guide.length < 2) { target.visible = false; return; }
    target.geometry.dispose();
    target.geometry = new THREE.BufferGeometry().setFromPoints(guide.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    target.visible = true;
  }

  /** The snap knot nearest a point, by `distance` in the scene, within `SNAP_PX` on screen of it — or null. */
  function snapNear(distance: (at: THREE.Vector3) => number): V3 | null {
    let best: V3 | null = null, bestRatio = 1;
    for (const target of snaps) {
      const at = dataToScene(target);
      const ratio = distance(at) / (SNAP_PX * stage.worldPerPixel(at));
      if (ratio <= bestRatio) { best = target; bestRatio = ratio; }
    }
    return best;
  }

  function placement(axisLocked = false): PlacementEndpoint | null {
    // A point under the cursor takes the new one exactly, so the host can join the two there.
    snapped = snapNear(at => stage.ray.ray.distanceToPoint(at));
    if (snapped) return { pos: [snapped[0], snapped[1], snapped[2]], vertex: null };
    // a trail is drawn over the ground, so every knot takes the surface (lifted), not just the first
    return resolvePlacementEndpoint(
      { stage, terrain, pickVertex }, drawFrom(), { axisLocked, surfaceLiftM, followsGround: true },
    );
  }

  function redraw() {
    while (knotDots.length < knots.length) {
      const dot = new THREE.Mesh(POINT_GEO, pointMat);
      dot.renderOrder = 10_000;
      dot.raycast = () => { /* scene-wide picks pass the bulbs by; knotAtPointer tests them itself */ };
      dot.userData.trailKnot = knotDots.length;
      knotDots.push(dot);
      dots.add(dot);
    }
    while (knotDots.length > knots.length) dots.remove(knotDots.pop()!);
    knots.forEach((knot, i) => {
      knotDots[i].position.set(knot[0], knot[1], knot[2]);
      knotDots[i].material = i === selected ? selectedMat : pointMat;
      knotDots[i].scale.setScalar(i === selected ? 1.5 : 1);
    });
    dots.visible = knots.length > 0;
    hoverDot.visible = !!(active && hover) && !snapped;
    if (hover) hoverDot.position.set(hover.pos[0], hover.pos[1], hover.pos[2]);
    snapDot.visible = !!snapped && (!!(active && hover) || stage.gizmo.dragging);
    if (snapped) { snapDot.position.set(snapped[0], snapped[1], snapped[2]); snapDot.scale.setScalar(1.8); }
    const next = active && hover ? hover.pos : null;
    while (pathLines.length < paths.length) {
      const pathLine = new THREE.Line(new THREE.BufferGeometry(), lineMat);
      pathLine.renderOrder = 10_000;
      pathLine.raycast = () => { /* the knot bulbs are picked explicitly by pickKnot */ };
      pathLines.push(pathLine);
      stage.worldRoot.add(pathLine);
    }
    pathLines.forEach((pathLine, p) => {
      const path = paths[p];
      if (!path) { pathLine.visible = false; return; }
      const nodes = path.nodes.map(node => knots[node]).filter(Boolean);
      // The path being drawn runs on to the cursor, from whichever end grows.
      if (next && draw?.path === p && draw.end === 'start') setLine(pathLine, [next, ...nodes], path.handles?.length ? [null, ...path.handles] : path.handles);
      else if (next && draw?.path === p) setLine(pathLine, [...nodes, next], path.handles);
      else setLine(pathLine, nodes, path.handles);
    });
    // A new path not laid yet is its point alone, so the guide runs from there to the cursor.
    const from = draw && draw.path === null ? drawFrom() : null;
    if (next && from) setLine(line, [from, next]); else line.visible = false;
  }

  /** Keep the gizmo on the selected knot, or on the whole trail, except while it is being dragged: then it owns
   *  its own pose. */
  function syncGizmo() {
    const knot = selected === null ? undefined : knots[selected];
    if (knot) {
      wholeHandle.visible = false;
      if (stage.gizmoKind === 'trailknot' && stage.gizmo.dragging) return;
      moveHandle.position.set(knot[0], knot[1], -knot[2]);
      moveHandle.visible = true;
      if (stage.gizmoKind !== 'trailknot' || stage.gizmoKnot !== selected) stage.attachGizmo(moveHandle, 'trailknot', selected!);
      return;
    }
    moveHandle.visible = false;
    if (stage.gizmoKind === 'trailknot') stage.detachGizmo();
    if (wholePivot && knots.length >= 2) {
      if (stage.gizmoKind === 'trail' && stage.gizmo.dragging) return;
      const c = wholePivot;
      wholeHandle.position.set(c[0], c[1], -c[2]);
      wholeHandle.quaternion.identity();
      wholeHandle.scale.setScalar(1);
      wholeHandle.visible = true;
      if (stage.gizmoKind !== 'trail' || stage.gizmo.object !== wholeHandle) stage.attachGizmo(wholeHandle, 'trail', -1);
    } else {
      wholeHandle.visible = false;
      if (stage.gizmoKind === 'trail') stage.detachGizmo();
    }
  }

  /** A whole-selection drag starts — remember the anchor's pose — or ends, which squares the anchor back up. */
  function wholeDragging(dragging: boolean) {
    if (!dragging) {
      wholeDrag = null;
      wholeHandle.quaternion.identity();
      wholeHandle.scale.setScalar(1);
      return;
    }
    wholeDrag = { pivot: wholeHandle.position.clone(), quaternion: wholeHandle.quaternion.clone(), scale: wholeHandle.scale.clone() };
  }

  /** The whole-selection gizmo moved, turned or scaled: report the transform from the drag's start. A handle is an
   *  offset from its point, so it turns and stretches but does not move; the automatic ones follow the points. */
  function wholeChanged() {
    const drag = wholeDrag;
    if (!drag) return;
    const turn = wholeHandle.quaternion.clone().multiply(drag.quaternion.clone().invert());
    const stretch = wholeHandle.scale.clone().divide(drag.scale);
    stretch.set(Math.max(0.01, stretch.x), Math.max(0.01, stretch.y), Math.max(0.01, stretch.z));
    const position = wholeHandle.position.clone();
    const vector = (v: THREE.Vector3) => v.clone().multiply(stretch).applyQuaternion(turn);
    onTransform?.({
      point: p => sceneToData(vector(dataToScene([p[0], p[1], p[2]]).sub(drag.pivot)).add(position)),
      vector: v => sceneToData(vector(dataToScene([v[0], v[1], v[2]]))),
    });
  }

  /** Arm or disarm drawing: while armed, a click on no knot appends one and the guide runs on to the cursor. */
  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    hover = null;
    redraw();
  }

  /** Show points (none hides them), with `knot` picked and carrying the gizmo — or, with none picked and a `pivot`,
   *  the selected paths carrying it there. `shape` says which paths run through them, bent through their dragged
   *  handles, and where drawing goes on. */
  function setKnots(next: readonly V3[], knot: number | null, pivot: V3 | null = null, shape?: TrailShape) {
    knots = next.map(p => [p[0], p[1], p[2]]);
    paths = (shape?.paths ?? []).map(path => ({ nodes: [...path.nodes], handles: path.handles }));
    draw = shape?.draw;
    snaps = (shape?.snaps ?? []).map(p => [p[0], p[1], p[2]] as V3);
    wholePivot = pivot ? [pivot[0], pivot[1], pivot[2]] : null;
    selected = knot !== null && knot < knots.length ? knot : null;
    redraw();
    syncGizmo();
  }

  /** The knot bulb under the (already cast) pointer ray, if any. */
  function knotAtPointer(): number | null {
    if (!dots.visible) return null;
    const hits: THREE.Intersection[] = [];
    for (const dot of knotDots) THREE.Mesh.prototype.raycast.call(dot, stage.ray, hits);
    hits.sort((a, b) => a.distance - b.distance);
    const hit = hits[0]?.object.userData.trailKnot;
    return typeof hit === 'number' ? hit : null;
  }

  /** A click on a knot bulb selects that knot and seats the gizmo on it; returns whether one was hit. */
  function pickKnot(): boolean {
    const knot = knotAtPointer();
    if (knot === null) return false;
    selected = knot;
    redraw();
    syncGizmo();
    onSelect?.(knot);
    return true;
  }

  function onHover(event: PointerEvent): boolean {
    if (!active) return false;
    if (stage.gizmo.dragging) return true; // a knot drag owns the pointer; the next-knot ghost waits
    stage.castAt(event);
    snapped = null;
    hover = knotAtPointer() === null ? placement(event.shiftKey) : null;
    redraw();
    listener?.();
    onHoverAt?.(hover?.pos ?? null);
    return true;
  }

  /** A drawing click that hit no knot: ask the host to append one at the surface point under the cursor. */
  function onCommit(axisLocked = false) {
    if (!active) return;
    const endpoint = placement(axisLocked);
    if (!endpoint) return;
    const previous = drawFrom();
    if (previous && Math.hypot(
      previous[0] - endpoint.pos[0], previous[1] - endpoint.pos[1], previous[2] - endpoint.pos[2],
    ) < 0.1) return;
    hover = null;
    onAppend?.(endpoint.pos);
  }

  function refresh() {
    if (!active) return;
    hover = placement(false);
    redraw();
  }

  return {
    setActive, setKnots, pickKnot, onHover, onCommit, refresh, wholeDragging, wholeChanged,
    /** A dragged point at `pos`: onto a point it may land on when it is near enough on screen, else where it is. */
    snapDrag(pos: V3): V3 {
      snapped = snapNear(at => at.distanceTo(dataToScene(pos)));
      redraw();
      return snapped ? [snapped[0], snapped[1], snapped[2]] : pos;
    },
    /** A drag ended: no snap any more. */
    clearSnap() { snapped = null; redraw(); },
    setSurfaceLift(value: number) { surfaceLiftM = Math.max(0, value); refresh(); },
    /** Hover changes, for the panel's next-segment read-out. */
    setListener(next: (() => void) | null) { listener = next; },
    setHost(host: {
      append: (pos: V3) => void; select: (knot: number | null) => void;
      transform: (xf: TrailTransform) => void;
      /** Where a click would lay the next knot now (null: nowhere), for the host's ghost of it. */
      hover?: (pos: V3 | null) => void;
    }) {
      onAppend = host.append; onSelect = host.select; onTransform = host.transform; onHoverAt = host.hover ?? null;
    },
    get active() { return active; },
    get knots(): readonly V3[] { return knots; },
    get selectedKnot() { return selected; },
    get hover(): V3 | null { return hover?.pos ?? null; },
  };
}

export type TrailToolLayer = ReturnType<typeof createTrailToolLayer>;
