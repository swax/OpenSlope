import * as THREE from 'three';
import type { PathHandles, V3 } from '../../../core/doc/types';
import { sampleRail } from '../../../core/rails/rails';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import type { Stage } from '../stage';
import { dataToScene, sceneToData } from '../coordinates';
import type { TrailTransform } from '../types';

export type { TrailTransform };

const POINT_GEO = new THREE.SphereGeometry(1, 12, 8); // unit: every marker is sized on screen, each frame
const POINT_COLOR = 0x50d8d0;
const SNAP_COLOR = 0xffc040; // amber: a point a moving one may land on, and the one it is about to
const RIM_COLOR = 0x041416; // the dark edge that keeps a marker apart from the ribbon under it
/** How near, on screen, the cursor or a dragged point has to come to another point to snap onto it. */
const SNAP_PX = 14;
const LINE_COLOR = 0x8ffff8;
/** Marker radii on screen, px: a point's bulb, the picked one's, the dark rim round each, the amber ring round a
 *  point a moving one may land on (with a dark middle, where no bulb fills it), and the point it is about to. */
const POINT_PX = 6.5, PICKED_PX = 8.5, RIM_PX = 2, CATCH_PX = 12, CATCH_RING_PX = 3, SNAPPED_PX = 10;
/** Draw order among the markers, which all draw over everything (each marker group's own order is 10 000). */
const enum Layer { Catch = 1, CatchHole, Rim, Bulb, PickedRim, Picked, SnapRim, Snapped }

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
 * Points a moving point may land on (`TrailShape.snaps` for the next one drawn, `dragSnaps` for the picked one
 * dragged; docs/023 · Networks) are ringed in amber while it moves, and catch the cursor, or the dragged point,
 * within `SNAP_PX` on screen — overlapping in the view, at whatever depth — and the point lands exactly there,
 * filled amber, and the host joins the two. Every marker keeps its size on screen however far off the camera is,
 * with a dark rim to stand out from the ribbon.
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
 *  paths, or a new path from the shown point `from` — and the points the next point drawn (`snaps`) and the picked
 *  point dragged (`dragSnaps`) snap onto. */
export interface TrailShape {
  paths: readonly TrailShapePath[];
  draw?: { path: number | null; end: 'start' | 'end'; from: number | null };
  snaps?: readonly V3[];
  dragSnaps?: readonly V3[];
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
  /** Points to snap onto — the next point drawn, and the picked one dragged — and the one it sits on now. */
  let snaps: V3[] = [];
  let dragSnaps: V3[] = [];
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
  const markerMat = (color: number) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
  const pointMat = markerMat(POINT_COLOR), selectedMat = markerMat(0xffffff), rimMat = markerMat(RIM_COLOR);
  const snapMat = markerMat(SNAP_COLOR);
  /** A marker `px` across on screen, drawn at `layer`; never hit by a scene-wide pick (pickKnot tests the rims). */
  const marker = (material: THREE.Material, layer: Layer, px: number) => {
    const mesh = new THREE.Mesh(POINT_GEO, material);
    mesh.renderOrder = layer;
    mesh.userData.px = px;
    mesh.raycast = () => { /* picked explicitly */ };
    return mesh;
  };
  const dots = new THREE.Group(); // a bulb and a rim per shown point
  const knotDots: THREE.Mesh[] = [];
  const knotRims: THREE.Mesh[] = [];
  const catches = new THREE.Group(); // an amber ring per point a moving one may land on
  const catchRings: THREE.Mesh[] = [];
  const cursor = new THREE.Group(); // the next point's ghost, or the point it snaps onto
  const hoverRim = marker(rimMat, Layer.Rim, POINT_PX + RIM_PX);
  const hoverDot = marker(pointMat, Layer.Bulb, POINT_PX);
  const snapRim = marker(rimMat, Layer.SnapRim, SNAPPED_PX + RIM_PX);
  const snapDot = marker(snapMat, Layer.Snapped, SNAPPED_PX);
  cursor.add(hoverRim, hoverDot, snapRim, snapDot);
  const lineMat = new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, depthWrite: false });
  const line = new THREE.Line(new THREE.BufferGeometry(), lineMat); // a new path, from its point to the cursor
  const pathLines: THREE.Line[] = [];
  const moveHandle = new THREE.Object3D(); // scene-root gizmo anchor for the selected knot, Z negated by hand
  const wholeHandle = new THREE.Object3D(); // …and for the whole trail, at its ribbon's centre
  for (const object of [dots, catches, cursor, line]) {
    object.visible = false;
    object.renderOrder = 10_000;
    object.raycast = () => { /* the knot bulbs are picked explicitly by pickKnot */ };
    stage.worldRoot.add(object);
  }
  const scratch = new THREE.Vector3();

  /** Hold every shown marker at its size on screen, wherever the camera has gone (the render loop calls it). */
  function scaleMarkers() {
    for (const group of [dots, catches, cursor]) {
      if (!group.visible) continue;
      for (const child of group.children) {
        if (!child.visible) continue;
        const px = (child.userData.px as number | undefined) ?? POINT_PX;
        child.scale.setScalar(Math.max(1e-4, stage.pointMarkerRadius(child.getWorldPosition(scratch), px)));
      }
    }
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

  /** Where a scene-space point shows on the canvas, in CSS px, and its depth there — null off the view. */
  function onScreen(at: THREE.Vector3): { x: number; y: number; z: number } | null {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const v = at.clone().project(stage.camera);
    if (v.z < -1 || v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height, z: v.z };
  }

  /** The cursor on the canvas, in CSS px. */
  function cursorOnScreen(): { x: number; y: number } {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    return { x: ((stage.pointer.x + 1) / 2) * rect.width, y: ((1 - stage.pointer.y) / 2) * rect.height };
  }

  /**
   * The snap point showing nearest `from` on the canvas, within `SNAP_PX` — the front-most of any showing together
   * — or null. Only the view counts, never depth: two points overlapping on screen are as near as anyone can line
   * them up by eye, whatever lies between them along the view.
   */
  function snapNear(targets: readonly V3[], from: { x: number; y: number } | null): V3 | null {
    if (!from) return null;
    let best: V3 | null = null, bestD2 = SNAP_PX * SNAP_PX, bestZ = Infinity;
    for (const target of targets) {
      const at = onScreen(dataToScene(target));
      if (!at) continue;
      const d2 = (at.x - from.x) ** 2 + (at.y - from.y) ** 2;
      if (d2 > SNAP_PX * SNAP_PX) continue;
      if (d2 < bestD2 - 0.25 || (Math.abs(d2 - bestD2) <= 0.25 && at.z < bestZ)) { best = target; bestD2 = d2; bestZ = at.z; }
    }
    return best;
  }

  function placement(axisLocked = false): PlacementEndpoint | null {
    // A point under the cursor takes the new one exactly, so the host can join the two there.
    snapped = snapNear(snaps, cursorOnScreen());
    if (snapped) return { pos: [snapped[0], snapped[1], snapped[2]], vertex: null };
    // a trail is drawn over the ground, so every knot takes the surface (lifted), not just the first
    return resolvePlacementEndpoint(
      { stage, terrain, pickVertex }, drawFrom(), { axisLocked, surfaceLiftM, followsGround: true },
    );
  }

  /** Whether the picked point is being dragged now. */
  const draggingKnot = () => stage.gizmoKind === 'trailknot' && stage.gizmo.dragging;

  /** Keep `pool` at `count` markers, made by `make` for the one at each place, in `group`. */
  function fill(pool: THREE.Mesh[], group: THREE.Group, count: number, make: (i: number) => THREE.Mesh) {
    while (pool.length < count) { const mesh = make(pool.length); pool.push(mesh); group.add(mesh); }
    while (pool.length > count) group.remove(pool.pop()!);
  }

  function redraw() {
    fill(knotDots, dots, knots.length, () => marker(pointMat, Layer.Bulb, POINT_PX));
    fill(knotRims, dots, knots.length, i => {
      const rim = marker(rimMat, Layer.Rim, POINT_PX + RIM_PX);
      rim.userData.trailKnot = i; // a click on a point has to hit the bulb or its rim
      return rim;
    });
    knots.forEach((knot, i) => {
      const px = i === selected ? PICKED_PX : POINT_PX;
      knotDots[i].position.set(knot[0], knot[1], knot[2]);
      knotDots[i].material = i === selected ? selectedMat : pointMat;
      knotDots[i].userData.px = px;
      knotDots[i].renderOrder = i === selected ? Layer.Picked : Layer.Bulb; // over any point at the same place
      knotRims[i].position.set(knot[0], knot[1], knot[2]);
      knotRims[i].userData.px = px + RIM_PX;
      knotRims[i].renderOrder = i === selected ? Layer.PickedRim : Layer.Rim;
    });
    dots.visible = knots.length > 0;
    // Where the point moving now may land: the next one drawn, or the picked one dragged.
    const dragging = draggingKnot();
    const targets = dragging ? dragSnaps : active ? snaps : [];
    fill(catchRings, catches, targets.length * 2, i => i % 2
      ? marker(rimMat, Layer.CatchHole, CATCH_PX - CATCH_RING_PX) : marker(snapMat, Layer.Catch, CATCH_PX));
    catchRings.forEach((ring, i) => { const at = targets[i >> 1]; ring.position.set(at[0], at[1], at[2]); });
    catches.visible = targets.length > 0;
    const ghost = !!(active && hover) && !snapped && !dragging;
    hoverDot.visible = hoverRim.visible = ghost;
    if (hover) for (const dot of [hoverDot, hoverRim]) dot.position.set(hover.pos[0], hover.pos[1], hover.pos[2]);
    snapDot.visible = snapRim.visible = !!snapped && (!!(active && hover) || dragging);
    if (snapped) for (const dot of [snapDot, snapRim]) dot.position.set(snapped[0], snapped[1], snapped[2]);
    cursor.visible = ghost || snapDot.visible;
    scaleMarkers();
    const next = active && hover && !dragging ? hover.pos : null;
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
    dragSnaps = (shape?.dragSnaps ?? []).map(p => [p[0], p[1], p[2]] as V3);
    wholePivot = pivot ? [pivot[0], pivot[1], pivot[2]] : null;
    selected = knot !== null && knot < knots.length ? knot : null;
    redraw();
    syncGizmo();
  }

  /** The knot bulb under the (already cast) pointer ray, if any. */
  function knotAtPointer(): number | null {
    if (!dots.visible) return null;
    const hits: THREE.Intersection[] = [];
    for (const rim of knotRims) THREE.Mesh.prototype.raycast.call(rim, stage.ray, hits);
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
      snapped = snapNear(dragSnaps, onScreen(dataToScene(pos)));
      redraw();
      return snapped ? [snapped[0], snapped[1], snapped[2]] : pos;
    },
    /** A point drag began — ring where it may land — or ended: no snap any more. */
    knotDragging(dragging: boolean) { if (!dragging) snapped = null; redraw(); },
    scaleMarkers,
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
