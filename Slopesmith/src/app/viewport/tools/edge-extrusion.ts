import * as THREE from 'three';
import type { QuadMeshDoc, V3 } from '../../../core/doc/types';
import { edgeExtrusionPlacementPreviewDoc, edgeExtrusionSegmentCount, planEdgeExtrusion, planPatchExtrusion, tangentEdgeExtrusionPlacement, type EdgeExtrusionPlacement, type EdgeExtrusionPlan } from '../../../core/mesh/ops';
import { buildQuadMesh, meshAdjacency, meshCageEdges } from '../../../core/mesh/topology';
import { buildMountainPreview } from '../../../core/mesh/tessellation';
import { LOFT_PREVIEW_FILL_COLOR } from '../constants';
import { addCageLines, clearGlyphGroup } from '../shared/overlays';
import type { Stage } from '../stage';
import {
  edgeIndices, quadIndex, quadIndices, quadName, vertexIndex, vertexNames,
  type NamedEdge, type QuadName, type VertexName,
} from '../../state/mesh-names';
import { dataToScene, sceneToData } from '../coordinates';

export type EdgeExtrusionDeps = {
  canBegin: () => boolean;
  selectedEdges: () => readonly NamedEdge[];
  selectedQuads: () => readonly QuadName[];
  meshDoc: () => QuadMeshDoc | null;
  cornerPos: (vertex: number) => V3 | null;
  snap: () => { enabled: boolean; step: number };
  hideOtherPreview: () => void;
  restoreOtherPreview: () => void;
  suppressSourceQuads: (quads: readonly number[]) => void;
};

/** Source faces represented by the local extrusion ghost. Hiding only these faces lets a downward extrusion
 * remain readable without making unchanged terrain disappear (boundary/free-edge extrusions hide nothing). */
export function edgeExtrusionOccludingSourceQuads(plan: EdgeExtrusionPlan): number[] {
  return [...new Set([
    ...(plan.topQuads ?? []).map(top => top.sourceQuad),
    ...(plan.sideQuads ?? []).map(side => side.sourceQuad),
  ])].sort((a, b) => a - b);
}

/** Boundary/free-edge extrusion workflow. Owns the frozen topology plan, optional drag plane, pointer capture, snapping,
 * exact ruled-strip preview, and commit/cancel cleanup. */
export function createEdgeExtrusionLayer(stage: Stage, deps: EdgeExtrusionDeps) {
  let sideHint: QuadName | null = null;
  let drag: {
    pointerId: number;
    x: number;
    y: number;
    edges: NamedEdge[];
    plan: EdgeExtrusionPlan;
    /** The plan's `vertices`, named — what proves it still addresses the geometry it was built over. */
    names: VertexName[];
    center: THREE.Vector3;
    plane: THREE.Plane;
    start: THREE.Vector3;
    delta: V3 | null;
  } | null = null;
  let staged: {
    edges: NamedEdge[];
    plan: EdgeExtrusionPlan;
    names: VertexName[];
    center: THREE.Vector3;
    sourceCenter: THREE.Vector3;
    moveAxis: THREE.Vector3;
    distance: number;
    tangentMove: boolean;
    fanMode: boolean;
    frame: THREE.Quaternion;
    base: EdgeExtrusionPlacement;
  } | null = null;
  const anchor = new THREE.Object3D();
  anchor.visible = false;
  stage.scene.add(anchor);

  const group = new THREE.Group();
  const fill = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: LOFT_PREVIEW_FILL_COLOR,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    }),
  );
  const cage = new THREE.Group();
  fill.renderOrder = 9;
  fill.visible = false;
  fill.raycast = () => { /* action preview, never a pick target */ };
  group.add(fill, cage);
  group.visible = false;
  stage.worldRoot.add(group);

  /**
   * A plan is frozen once and then transformed, previewed and finally applied — so between staging it and
   * committing it the document may have been renumbered under it. `names` records what its `vertices` were
   * called at plan time; when those names no longer sit where the plan says they do, the plan describes
   * geometry that has moved and applying it would extrude the wrong corners (docs/039).
   */
  const planIntact = (source: QuadMeshDoc, plan: EdgeExtrusionPlan, names: readonly VertexName[]): boolean =>
    plan.vertices.length === names.length
    && plan.vertices.every((index, at) => vertexIndex(source, names[at]) === index);

  function planSelection(): { source: QuadMeshDoc; edges: NamedEdge[]; plan: EdgeExtrusionPlan; names: VertexName[]; center: THREE.Vector3 } | null {
    const source = deps.meshDoc(), selected = deps.selectedEdges(), selectedQuads = deps.selectedQuads();
    if (!source || (!selected.length && !selectedQuads.length)) return null;
    const side = sideHint === null ? null : quadIndex(source, sideHint);
    const planned = selected.length
      ? planEdgeExtrusion(source, edgeIndices(source, selected), side)
      : planPatchExtrusion(source, quadIndices(source, selectedQuads));
    if (!planned.ok) { stage.cb.onExtrudeEdgesInvalid?.(planned.error); return null; }

    const members = planned.plan.vertices;
    const center = new THREE.Vector3();
    for (const vertex of members) {
      const point = deps.cornerPos(vertex);
      if (!point) return null;
      center.add(dataToScene(point));
    }
    center.multiplyScalar(1 / members.length);
    const names = vertexNames(source, members);
    if (names.length !== members.length) return null;
    return { source, edges: selected.map(edge => [...edge] as NamedEdge), plan: planned.plan, names, center };
  }

  function begin(event: PointerEvent): boolean {
    if (!deps.canBegin() || staged) return false;
    const ready = planSelection();
    if (!ready) return true;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      stage.camera.getWorldDirection(new THREE.Vector3()), ready.center,
    );
    const start = stage.ray.ray.intersectPlane(plane, new THREE.Vector3());
    if (!start) return false;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      edges: ready.edges,
      plan: ready.plan,
      names: ready.names,
      center: ready.center,
      plane,
      start: start.clone(),
      delta: null,
    };
    (event.target as Element).setPointerCapture?.(event.pointerId);
    stage.controls.enabled = false;
    stage.gizmo.enabled = false;
    stage.renderer.domElement.style.cursor = 'copy';
    return true;
  }

  function placement(): EdgeExtrusionPlacement | null {
    if (!staged) return null;
    anchor.updateMatrixWorld(true);
    const vertices: Record<number, V3> = {}, handles: Record<string, V3> = {};
    // The initial fan handle uses a local X axis rotated onto the average continuation direction. Its resting
    // quaternion is display orientation, not an authored rotation, so remove it before transforming geometry.
    const q = anchor.quaternion.clone().multiply(staged.frame.clone().invert()).normalize(), scale = anchor.scale;
    for (const vertex of staged.plan.vertices) {
      const base = staged.base.vertices[vertex];
      const local = dataToScene(base).sub(staged.center);
      const p = local.multiply(scale).applyQuaternion(q).add(anchor.position);
      vertices[vertex] = sceneToData(p);
    }
    for (const [from, to] of staged.plan.movingHandles) {
      const h = staged.base.handles[`${from}>${to}`];
      const v = dataToScene(h).multiply(scale).applyQuaternion(q);
      handles[`${from}>${to}`] = sceneToData(v);
    }
    let twists: EdgeExtrusionPlacement['twists'];
    if (staged.base.twists) {
      twists = {};
      for (const [quad, source] of Object.entries(staged.base.twists))
        twists[+quad] = source.map(offset => {
          const v = dataToScene(offset).multiply(scale).applyQuaternion(q);
          return sceneToData(v);
        }) as [V3, V3, V3, V3];
    }
    return { vertices, handles, ...(twists ? { twists } : {}) };
  }

  function rebuild() {
    const source = deps.meshDoc(), placed = placement();
    if (!staged || !source || !placed) return;
    if (!planIntact(source, staged.plan, staged.names)) { group.visible = false; return; }
    const preview = buildMountainPreview(edgeExtrusionPlacementPreviewDoc(source, staged.plan, placed));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(preview.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(preview.indices, 1));
    fill.geometry.dispose();
    fill.geometry = geometry;
    fill.visible = true;
    clearGlyphGroup(cage);
    const edges = meshCageEdges(preview.mesh, preview.edgeHandle);
    addCageLines(cage, edges.interior, LOFT_PREVIEW_FILL_COLOR, 0.95, false, 11);
    addCageLines(cage, edges.boundary, LOFT_PREVIEW_FILL_COLOR, 0.95, false, 11);
    group.visible = true;
    deps.suppressSourceQuads(edgeExtrusionOccludingSourceQuads(staged.plan));
    deps.hideOtherPreview();
  }

  function update(event: PointerEvent) {
    if (!drag || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= 4) return;
    stage.castAt(event);
    const point = stage.ray.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!point) return;
    const scene = point.sub(drag.start);
    let delta = sceneToData(scene);
    const snap = deps.snap();
    if (snap.enabled) delta = delta.map(value => Math.round(value / snap.step) * snap.step) as V3;
    if (Math.hypot(delta[0], delta[1], delta[2]) < 1e-4) {
      drag.delta = null;
      group.visible = false;
      deps.suppressSourceQuads([]);
      deps.restoreOtherPreview();
      return;
    }
    drag.delta = delta;
    // The drag magnitude advances each boundary point along its own outward surface tangent. Free edges have
    // no source surface and retain the literal translation fallback.
    const next = makeStage(drag.edges, drag.plan, drag.names, delta);
    if (!next) return;
    const saved = staged;
    staged = next;
    anchor.position.copy(next.center);
    anchor.quaternion.copy(next.frame); anchor.scale.setScalar(1);
    rebuild();
    staged = saved;
  }

  function placementCenter(plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement): THREE.Vector3 {
    const center = new THREE.Vector3();
    for (const vertex of plan.vertices) {
      const p = placement.vertices[vertex];
      center.add(dataToScene(p));
    }
    return center.multiplyScalar(1 / plan.vertices.length);
  }

  function sourceCenter(plan: EdgeExtrusionPlan): THREE.Vector3 | null {
    const center = new THREE.Vector3();
    for (const vertex of plan.vertices) {
      const p = deps.cornerPos(vertex);
      if (!p) return null;
      center.add(dataToScene(p));
    }
    return center.multiplyScalar(1 / plan.vertices.length);
  }

  function makeStage(edges: NamedEdge[], plan: EdgeExtrusionPlan, names: VertexName[], delta: V3) {
    const source = deps.meshDoc(), origin = sourceCenter(plan);
    if (!source || !origin || !planIntact(source, plan, names)) return null;
    const distance = Math.hypot(delta[0], delta[1], delta[2]);
    const base = tangentEdgeExtrusionPlacement(source, plan, delta);
    const center = placementCenter(plan, base);
    const moveAxis = center.clone().sub(origin).multiplyScalar(1 / Math.max(distance, 1e-8));
    // A surface continuation has one meaningful fan distance. A free edge has no tangent field, so it keeps
    // the ordinary rigid Move gizmo and can be positioned in any direction.
    const tangentMove = distance > 1e-8 && moveAxis.lengthSq() > 1e-8 && plan.edges.every(edge => !!edge.continuation);
    const frame = tangentMove
      ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), moveAxis.clone().normalize())
      : new THREE.Quaternion();
    return { edges, plan, names, center, sourceCenter: origin, moveAxis, distance, tangentMove, fanMode: tangentMove, frame, base };
  }

  function stagePlacement(edges: NamedEdge[], plan: EdgeExtrusionPlan, names: VertexName[], delta: V3) {
    const next = makeStage(edges, plan, names, delta);
    if (!next) return;
    staged = next;
    anchor.position.copy(next.center);
    anchor.quaternion.copy(next.frame); anchor.scale.setScalar(1);
    anchor.visible = true;
    rebuild();
    stage.attachGizmo(anchor, 'edgeextrusion', -1);
    stage.cb.onExtrudeStageChange?.(true);
  }

  /** The initial single handle controls one shared continuation distance, rebuilding each outer endpoint on its
   * own frozen tangent so fan-in/fan-out survives. Choosing a transform tool exits this constrained state. */
  function onGizmoChange() {
    if (!staged) return;
    if (!staged.fanMode || !staged.tangentMove) { rebuild(); return; }
    const axisLen2 = staged.moveAxis.lengthSq();
    if (axisLen2 < 1e-8) { staged.tangentMove = false; rebuild(); return; }
    let distance = anchor.position.clone().sub(staged.sourceCenter).dot(staged.moveAxis) / axisLen2;
    const snap = deps.snap();
    if (snap.enabled) distance = Math.round(distance / snap.step) * snap.step;
    // An edge only continues outward. A patch region may cross its source plane: positive raises a mesa,
    // negative pushes a canyon, both using the same normal-aligned handle.
    if (staged.plan.kind === 'edge') distance = Math.max(1e-3, distance);
    else if (Math.abs(distance) < 1e-3) distance = distance < 0 ? -1e-3 : 1e-3;
    const source = deps.meshDoc();
    if (!source) return;
    staged.distance = distance;
    staged.base = tangentEdgeExtrusionPlacement(source, staged.plan, [distance, 0, 0]);
    staged.center = placementCenter(staged.plan, staged.base);
    anchor.position.copy(staged.center);
    anchor.quaternion.copy(staged.frame);
    anchor.scale.setScalar(1);
    rebuild();
  }

  /** Move / Rotate / Scale was explicitly chosen. Preserve the fan-shaped placement, then replace the one-axis
   * continuation handle with the ordinary world gizmo for unrestricted rigid transforms. */
  function enableTransform() {
    if (!staged?.fanMode) return;
    staged.fanMode = false;
    staged.tangentMove = false;
    staged.frame.identity();
    anchor.position.copy(staged.center);
    anchor.quaternion.identity();
    anchor.scale.setScalar(1);
    rebuild();
  }

  /** Toolbox entry: stage a visible one-step extrusion that can then be transformed. */
  function beginStage(): boolean {
    if (staged || drag) return false;
    const ready = planSelection();
    if (!ready) return false;
    const step = deps.snap().enabled ? deps.snap().step : 10;
    stagePlacement(ready.edges, ready.plan, ready.names, [step, 0, 0]);
    return true;
  }

  function finish(event: PointerEvent | null, keep: boolean) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    stage.controls.enabled = true;
    stage.gizmo.enabled = true;
    stage.renderer.domElement.style.cursor = '';
    const target = event?.target instanceof Element ? event.target : stage.renderer.domElement;
    if (target.hasPointerCapture?.(finished.pointerId)) target.releasePointerCapture?.(finished.pointerId);
    if (keep && finished.delta) stagePlacement(finished.edges, finished.plan, finished.names, finished.delta);
    else {
      group.visible = false;
      clearGlyphGroup(cage);
      deps.suppressSourceQuads([]);
      deps.restoreOtherPreview();
    }
  }

  function clearStage() {
    if (!staged) return;
    staged = null;
    anchor.visible = false;
    anchor.position.set(0, 0, 0); anchor.quaternion.identity(); anchor.scale.setScalar(1);
    group.visible = false;
    fill.geometry.dispose(); fill.geometry = new THREE.BufferGeometry();
    clearGlyphGroup(cage);
    if (stage.gizmoKind === 'edgeextrusion') stage.detachGizmo();
    deps.suppressSourceQuads([]);
    deps.restoreOtherPreview();
    stage.cb.onExtrudeStageChange?.(false);
  }

  function commitStage() {
    if (!staged) return;
    const source = deps.meshDoc();
    if (!source || !planIntact(source, staged.plan, staged.names)) {
      stage.cb.onExtrudeEdgesInvalid?.('That extrusion was staged over geometry this mountain has since changed.');
      clearStage();
      return;
    }
    const placed = placement();
    if (placed && stage.cb.onCommitExtrudeEdges?.(staged.plan, placed) !== false) clearStage();
  }

  function segmentCount(): number {
    const source = deps.meshDoc(), placed = placement();
    return staged && source && placed && planIntact(source, staged.plan, staged.names)
      ? edgeExtrusionSegmentCount(source, staged.plan, placed) : 1;
  }

  /** Flip an interior-edge extrusion to the opposite incident strip and restart its constrained placement. */
  function flipSide(): boolean {
    const source = deps.meshDoc();
    if (!staged?.plan.sideQuads?.length || !source || !staged.edges.length) return false;
    if (!planIntact(source, staged.plan, staged.names)) return false;
    const first = staged.plan.edges[0], incident = meshAdjacency(buildQuadMesh(source.vertices, source.quads, source.freeEdges))
      .edgeQuads.get(first.from < first.to ? `${first.from},${first.to}` : `${first.to},${first.from}`) ?? [];
    const opposite = incident.find(quad => quad !== first.sideQuad);
    if (opposite === undefined) return false;
    const planned = planEdgeExtrusion(source, edgeIndices(source, staged.edges), opposite);
    if (!planned.ok) { stage.cb.onExtrudeEdgesInvalid?.(planned.error); return false; }
    sideHint = quadName(source, opposite);
    const names = vertexNames(source, planned.plan.vertices);
    if (names.length !== planned.plan.vertices.length) return false;
    stagePlacement(staged.edges, planned.plan, names, [Math.max(1e-3, staged.distance), 0, 0]);
    return true;
  }

  return {
    begin,
    beginStage,
    update,
    finish,
    onGizmoChange,
    enableTransform,
    flipSide,
    setSideHint(quad: number | null) {
      const source = deps.meshDoc();
      sideHint = quad === null || !source ? null : quadName(source, quad);
    },
    commitStage,
    cancel() { if (drag) finish(null, false); else clearStage(); },
    get active() { return !!drag || !!staged; },
    get dragging() { return !!drag; },
    get staged() { return !!staged; },
    get fanMode() { return !!staged?.fanMode; },
    get sideFlippable() { return !!staged?.plan.sideQuads?.length; },
    get segments() { return segmentCount(); },
  };
}

export type EdgeExtrusionLayer = ReturnType<typeof createEdgeExtrusionLayer>;
