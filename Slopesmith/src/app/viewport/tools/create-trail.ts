import * as THREE from 'three';
import type { PathHandles, V3 } from '../../../core/doc/types';
import { sampleRail } from '../../../core/rails/rails';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import type { Stage } from '../stage';
import { dataToScene, sceneToData } from '../coordinates';

const POINT_GEO = new THREE.SphereGeometry(1.15, 10, 8);
const POINT_COLOR = 0x50d8d0;
const SNAP_COLOR = 0xffc040; // amber: a knot about to land on another trail's
/** How near, on screen, the cursor or a dragged knot has to come to another trail's knot to snap onto it. */
const SNAP_PX = 14;
const LINE_COLOR = 0x8ffff8;

/**
 * The trail's centre spline in Edit mode (docs/023): a bulb per knot of the shown trail, the rail Catmull-Rom
 * guide through them, and the translate gizmo on the selected knot — the way a rail shows its nodes, except that
 * the knots stay pickable while the trail is still being drawn, so an earlier knot can be moved before the last
 * one is laid.
 *
 * The knots belong to the host (`edit/trails.ts`), which shows them with `setKnots`; this layer only reports.
 * While drawing (`setActive(true)`), a click that lands on no bulb asks the host to append a knot at the surface
 * point under it, lifted like the original Create Trail placement, and the guide runs on to the cursor — from the
 * last knot, from the first when the host draws onto the start, or from a branch's tip (`TrailShape.draw`). Each
 * hover is reported too, so the host can ghost what the click would lay.
 *
 * A trail with branches (docs/023 · Branches) shows every knot as one list — its own, then each branch's — and a
 * guide per branch from its junction knot; the host says which is which (`TrailShape`).
 *
 * Knots of other trails a trail's end may join (`TrailShape.snaps`, docs/023 · Merging) catch the cursor, and a
 * dragged knot, within `SNAP_PX` on screen: the point lands exactly on that knot, marked in amber, and the host
 * merges the trails when it is laid or dropped there.
 *
 * A trail selected as a whole, with no knot picked, carries the gizmo at its ribbon's centre (kind `'trail'`):
 * Move, Rotate and Scale take every knot and every dragged Bézier handle with them, from the drag's start, and
 * the host re-cuts the trail from them — the patches follow, and patches joined to it stretch.
 */
/** Where the next knot of a trail being drawn goes: onto an end of the trail, or onto one of the branches the
 *  shape lists (by its place in `branches`). */
export type TrailDrawTarget = { end: 'start' | 'end' } | { branch: number };

/** How the knots `setKnots` shows divide up: the first `main` are the trail's own, the rest its branches', each
 *  branch drawn from its junction knot (its path's first node). */
export interface TrailShape {
  main: number;
  branches: readonly (readonly V3[])[];
  draw?: TrailDrawTarget;
  /** Other trails' knots the next knot, or a dragged end knot, snaps onto. */
  snaps?: readonly V3[];
}

export function createTrailToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false;
  /** Where new knots go, and the guide and the placement run from. */
  let drawTarget: TrailDrawTarget = { end: 'end' };
  /** Every knot shown: the trail's own (`mainCount` of them), then its branches'. */
  let knots: V3[] = [];
  let mainCount = 0;
  /** Each branch's path, from its junction knot. */
  let branchPaths: V3[][] = [];
  /** Knots of other trails to snap onto, and the one the hover or a drag sits on now. */
  let snaps: V3[] = [];
  let snapped: V3 | null = null;
  let handles: readonly (PathHandles | null | undefined)[] | undefined;
  let selected: number | null = null;
  let hover: PlacementEndpoint | null = null;
  let surfaceLiftM = 0.25;
  let listener: (() => void) | null = null;
  let onAppend: ((pos: V3) => void) | null = null;
  let onSelect: ((knot: number | null) => void) | null = null;
  let onTransform: ((knots: V3[], handles: (PathHandles | null)[]) => void) | null = null;
  let onHoverAt: ((pos: V3 | null) => void) | null = null;
  /** Where the gizmo sits while the trail is selected as a whole (data space); null when it is not. */
  let wholePivot: V3 | null = null;
  /** A whole-trail drag's start, scene space: the anchor's pose, every knot, and every dragged handle's offset. */
  let wholeDrag: {
    pivot: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3;
    knots: THREE.Vector3[]; handles: ({ in?: THREE.Vector3; out?: THREE.Vector3 } | null)[];
  } | null = null;
  const pointMat = new THREE.MeshBasicMaterial({ color: POINT_COLOR, depthTest: false, depthWrite: false });
  const snapDot = new THREE.Mesh(POINT_GEO, new THREE.MeshBasicMaterial({ color: SNAP_COLOR, depthTest: false, depthWrite: false }));
  const selectedMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
  const dots = new THREE.Group();
  const knotDots: THREE.Mesh[] = [];
  const hoverDot = new THREE.Mesh(POINT_GEO, pointMat);
  const lineMat = new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, depthWrite: false });
  const line = new THREE.Line(new THREE.BufferGeometry(), lineMat);
  const branchLines: THREE.Line[] = [];
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

  /** The knot the next one is laid from: the end, or the branch tip, being drawn onto. */
  const drawFrom = (): V3 | null => ('branch' in drawTarget
    ? branchPaths[drawTarget.branch]?.at(-1)
    : drawTarget.end === 'start' ? knots[0] : knots[mainCount - 1]) ?? null;

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
    // Another trail's knot under the cursor takes the knot exactly, so the host can join the two trails there.
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
    const main = knots.slice(0, mainCount);
    const drawing = !next || 'branch' in drawTarget ? null : drawTarget.end;
    if (drawing === 'start') setLine(line, [next!, ...main], handles?.length ? [null, ...handles] : handles);
    else if (drawing === 'end') setLine(line, [...main, next!], handles);
    else setLine(line, main, handles);
    while (branchLines.length < branchPaths.length) {
      const branchLine = new THREE.Line(new THREE.BufferGeometry(), lineMat);
      branchLine.renderOrder = 10_000;
      branchLine.raycast = () => { /* the knot bulbs are picked explicitly by pickKnot */ };
      branchLines.push(branchLine);
      stage.worldRoot.add(branchLine);
    }
    branchLines.forEach((branchLine, b) => {
      const path = branchPaths[b];
      if (!path) { branchLine.visible = false; return; }
      setLine(branchLine, next && 'branch' in drawTarget && drawTarget.branch === b ? [...path, next] : path);
    });
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

  /** A whole-trail drag starts — freeze the trail as it stands — or ends, which squares the anchor back up. */
  function wholeDragging(dragging: boolean) {
    if (!dragging) {
      wholeDrag = null;
      wholeHandle.quaternion.identity();
      wholeHandle.scale.setScalar(1);
      return;
    }
    wholeDrag = {
      pivot: wholeHandle.position.clone(), quaternion: wholeHandle.quaternion.clone(), scale: wholeHandle.scale.clone(),
      knots: knots.map(p => dataToScene(p)),
      handles: knots.map((_, i) => {
        const own = handles?.[i];
        return own ? { ...(own.in ? { in: dataToScene(own.in) } : {}), ...(own.out ? { out: dataToScene(own.out) } : {}) } : null;
      }),
    };
  }

  /** The whole-trail gizmo moved, turned or scaled: report every knot and dragged handle as the drag-start trail
   *  under that transform. A handle is an offset from its knot, so it turns and stretches but does not move;
   *  the automatic ones follow from the knots on their own. */
  function wholeChanged() {
    const drag = wholeDrag;
    if (!drag) return;
    const turn = wholeHandle.quaternion.clone().multiply(drag.quaternion.clone().invert());
    const stretch = wholeHandle.scale.clone().divide(drag.scale);
    stretch.set(Math.max(0.01, stretch.x), Math.max(0.01, stretch.y), Math.max(0.01, stretch.z));
    const vector = (v: THREE.Vector3) => v.clone().multiply(stretch).applyQuaternion(turn);
    const point = (p: THREE.Vector3) => vector(p.clone().sub(drag.pivot)).add(wholeHandle.position);
    onTransform?.(
      drag.knots.map(p => sceneToData(point(p))),
      drag.handles.map(own => own ? {
        ...(own.in ? { in: sceneToData(vector(own.in)) } : {}),
        ...(own.out ? { out: sceneToData(vector(own.out)) } : {}),
      } : null),
    );
  }

  /** Arm or disarm drawing: while armed, a click on no knot appends one and the guide runs on to the cursor. */
  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    hover = null;
    redraw();
  }

  /** Show a trail's knots (none hides them), with `knot` selected and carrying the gizmo — or, with no knot and a
   *  `pivot`, the whole trail carrying it there; its guide bends through `nextHandles` where they were dragged.
   *  `shape` says which knots are the trail's own and which its branches', and where drawing goes on. */
  function setKnots(next: readonly V3[], knot: number | null, nextHandles?: readonly (PathHandles | null | undefined)[],
    pivot: V3 | null = null, shape?: TrailShape) {
    knots = next.map(p => [p[0], p[1], p[2]]);
    mainCount = shape ? Math.min(shape.main, knots.length) : knots.length;
    branchPaths = (shape?.branches ?? []).map(path => path.map(p => [p[0], p[1], p[2]] as V3));
    drawTarget = shape?.draw ?? { end: 'end' };
    snaps = (shape?.snaps ?? []).map(p => [p[0], p[1], p[2]] as V3);
    handles = nextHandles;
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
    /** A dragged knot at `pos`: onto another trail's knot when it is near enough on screen, else where it is. */
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
      transform: (knots: V3[], handles: (PathHandles | null)[]) => void;
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
