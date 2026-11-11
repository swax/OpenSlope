import * as THREE from 'three';
import type { QuadMeshDoc, V3 } from '../../../core/doc/types';
import {
  applyPlannedEdgeExtrusion,
  edgeChainExtrusionPlacement,
  pathEdgeExtrusionPlacement,
  edgeExtrusionPlacementPreviewDoc,
  edgeExtrusionSegmentCount,
  planEdgeExtrusion,
  planPatchExtrusion,
  translatedEdgeExtrusionPlacement,
  type EdgeExtrusionPlacement,
  type EdgeExtrusionPlan,
} from '../../../core/mesh/ops';
import { sampleRail } from '../../../core/rails/rails';
import { buildQuadMesh, meshAdjacency, meshCageEdges, meshFromDoc } from '../../../core/mesh/topology';
import { meshEdgeSegments } from '../../../core/mesh/selection';
import { buildMountainPreview } from '../../../core/mesh/tessellation';
import { BRIDGE_RAIL_COLORS, EDIT_EDGE_SEL_WIDTH, LOFT_PREVIEW_FILL_COLOR, LOOP_RENDER_ORDER } from '../constants';
import { addCageLines, clearGlyphGroup, glyphLines } from '../shared/overlays';
import type { Stage } from '../stage';
import {
  edgeIndices,
  quadIndex,
  quadIndices,
  quadName,
  vertexIndex,
  vertexNames,
  type NamedEdge,
  type QuadName,
  type VertexName,
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
  return [
    ...new Set([
      ...(plan.topQuads ?? []).map(top => top.sourceQuad),
      ...(plan.sideQuads ?? []).map(side => side.sourceQuad),
    ]),
  ].sort((a, b) => a - b);
}

/** Boundary/free-edge extrusion workflow. Owns the frozen topology plan, optional drag plane, pointer capture, snapping,
 * exact ruled-strip preview, and commit/cancel cleanup. */
export function createEdgeExtrusionLayer(stage: Stage, deps: EdgeExtrusionDeps) {
  let sideHint: QuadName | null = null;
  let mode: 'pull' | 'path' = 'pull';
  let pathId = '';
  let reversePath = false;
  let turnOverride: boolean | null = null; // mesh-edge path: turn with it, run parallel, or (null) the path decides
  let pathTurns = false; // what the current mesh-edge placement actually did
  let pathError = '';
  let pathWarning = ''; // the path is fine to commit, but its sweep folds somewhere (EdgeExtrusionPathResult.warning)
  let pathSegments = 0;
  let segmentLengthOverride: number | null = null;
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
    base: EdgeExtrusionPlacement;
  } | null = null;
  const anchor = new THREE.Object3D();
  anchor.visible = false;
  stage.scene.add(anchor);

  const group = new THREE.Group();
  group.name = 'edge-extrusion-preview';
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
  fill.raycast = () => {
    /* action preview, never a pick target */
  };
  group.add(fill, cage);
  group.visible = false;
  stage.worldRoot.add(group);

  // Captured source is independent of the live yellow guide selection and remains visible without a valid preview.
  const sourceHighlight = new THREE.Group();
  sourceHighlight.name = 'edge-extrusion-source';
  sourceHighlight.visible = false;
  stage.worldRoot.add(sourceHighlight);

  function rebuildSourceHighlight(source: QuadMeshDoc | null) {
    clearGlyphGroup(sourceHighlight);
    sourceHighlight.visible = false;
    if (!staged || mode !== 'path' || !source || !planIntact(source, staged.plan, staged.names)) return;
    const { mesh, edgeHandle } = meshFromDoc(source);
    glyphLines(
      sourceHighlight,
      meshEdgeSegments(mesh, edgeHandle, edgeIndices(source, staged.edges)),
      BRIDGE_RAIL_COLORS[0],
      1,
      [stage.container.clientWidth || 1, stage.container.clientHeight || 1],
      EDIT_EDGE_SEL_WIDTH + 0.5,
      LOOP_RENDER_ORDER + 2,
      false,
    );
    sourceHighlight.children.forEach(child => {
      child.raycast = () => {};
    });
    sourceHighlight.visible = true;
  }

  /**
   * A plan is frozen once and then transformed, previewed and finally applied — so between staging it and
   * committing it the document may have been renumbered under it. `names` records what its `vertices` were
   * called at plan time; when those names no longer sit where the plan says they do, the plan describes
   * geometry that has moved and applying it would extrude the wrong corners (docs/039).
   */
  const planIntact = (source: QuadMeshDoc, plan: EdgeExtrusionPlan, names: readonly VertexName[]): boolean =>
    plan.vertices.length === names.length &&
    plan.vertices.every((index, at) => vertexIndex(source, names[at]) === index);

  function planSelection(): {
    source: QuadMeshDoc;
    edges: NamedEdge[];
    plan: EdgeExtrusionPlan;
    names: VertexName[];
    center: THREE.Vector3;
  } | null {
    const source = deps.meshDoc(),
      selected = deps.selectedEdges(),
      selectedQuads = deps.selectedQuads();
    if (!source || (!selected.length && !selectedQuads.length)) return null;
    const side = sideHint === null ? null : quadIndex(source, sideHint);
    const planned = selected.length
      ? planEdgeExtrusion(source, edgeIndices(source, selected), side)
      : planPatchExtrusion(source, quadIndices(source, selectedQuads));
    if (!planned.ok) {
      stage.cb.onExtrudeEdgesInvalid?.(planned.error);
      return null;
    }
    if (segmentLengthOverride !== null) planned.plan.segmentLength = segmentLengthOverride;

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
      stage.camera.getWorldDirection(new THREE.Vector3()),
      ready.center,
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
    if (mode === 'path') {
      const source = deps.meshDoc();
      if (!source) return null;
      const selected = deps.selectedEdges(),
        edges = edgeIndices(source, selected);
      const rail = pathId ? source.rails?.find(rail => rail.id === pathId) : null;
      const points = rail ? sampleRail(rail.nodes, 12, rail.handles) : [];
      if (reversePath) points.reverse();
      const result = pathId
        ? rail
          ? pathEdgeExtrusionPlacement(source, staged.plan, points)
          : { ok: false as const, error: 'That path is no longer available. Choose another path.' }
        : selected.length !== edges.length
          ? { ok: false as const, error: 'The selected edge path has changed. Select its edges again.' }
          : edgeChainExtrusionPlacement(
              source,
              staged.plan,
              edges,
              turnOverride === null ? {} : { turn: turnOverride },
            );
      pathError = result.ok ? '' : result.error;
      pathTurns = result.ok && result.turns;
      pathWarning = result.ok ? (result.warning ?? '') : '';
      return result.ok ? result.placement : null;
    }
    anchor.updateMatrixWorld(true);
    const vertices: Record<number, V3> = {},
      handles: Record<string, V3> = {};
    const q = anchor.quaternion,
      scale = anchor.scale;
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
    const source = deps.meshDoc();
    rebuildSourceHighlight(source);
    if (staged && source && !planIntact(source, staged.plan, staged.names)) {
      pathError = 'That extrusion was staged over geometry this mountain has since changed.';
      pathSegments = 0;
      group.visible = false;
      deps.suppressSourceQuads([]);
      deps.restoreOtherPreview();
      return;
    }
    const placed = placement();
    if (mode === 'path') pathSegments = placed?.stations?.length ?? 0;
    if (!staged || !source || !placed) {
      group.visible = false;
      deps.suppressSourceQuads([]);
      deps.restoreOtherPreview();
      return;
    }
    // Start on the source rim: no degenerate preview or hidden source faces until the user pulls it away.
    if (!placementMoved(source, staged.plan, placed)) {
      group.visible = false;
      deps.suppressSourceQuads([]);
      deps.restoreOtherPreview();
      return;
    }
    if (mode === 'path') {
      const checked = applyPlannedEdgeExtrusion(source, staged.plan, placed);
      if (!checked.ok) {
        pathError = checked.error;
        group.visible = false;
        deps.suppressSourceQuads([]);
        deps.restoreOtherPreview();
        return;
      }
    }
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
    // Direct pull gestures use the same literal direction as the Move gizmo.
    const next = makeStage(drag.edges, drag.plan, drag.names, delta);
    if (!next) return;
    const saved = staged;
    staged = next;
    anchor.position.copy(next.center);
    anchor.quaternion.identity();
    anchor.scale.setScalar(1);
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
    const source = deps.meshDoc(),
      origin = sourceCenter(plan);
    if (!source || !origin || !planIntact(source, plan, names)) return null;
    const base = translatedEdgeExtrusionPlacement(source, plan, delta);
    const center = placementCenter(plan, base);
    return {
      edges,
      plan,
      names,
      center,
      sourceCenter: origin,
      base,
    };
  }

  function stagePlacement(edges: NamedEdge[], plan: EdgeExtrusionPlan, names: VertexName[], delta: V3) {
    const next = makeStage(edges, plan, names, delta);
    if (!next) return;
    staged = next;
    anchor.position.copy(next.center);
    anchor.quaternion.identity();
    anchor.scale.setScalar(1);
    anchor.visible = true;
    rebuild();
    stage.attachGizmo(anchor, 'edgeextrusion', -1);
    stage.cb.onExtrudeStageChange?.(true);
  }

  /** The source is frozen; the moving rim follows the gizmo's full translation / rotation / scale. */
  function onGizmoChange() {
    if (!staged || mode === 'path') return;
    rebuild();
  }

  function placementMoved(source: QuadMeshDoc, plan: EdgeExtrusionPlan, placed: EdgeExtrusionPlacement): boolean {
    return (placed.stations ?? [placed]).some(ring =>
      plan.vertices.some(v => {
        const p = ring.vertices[v],
          i = v * 3;
        return (
          Math.hypot(p[0] - source.vertices[i], p[1] - source.vertices[i + 1], p[2] - source.vertices[i + 2]) >= 1e-4
        );
      }),
    );
  }

  /** Toolbox entry: place the gizmo on the existing edge / face without creating an initial offset. */
  function beginStage(): boolean {
    if (staged || drag) return false;
    const ready = planSelection();
    if (!ready) return false;
    stagePlacement(ready.edges, ready.plan, ready.names, [0, 0, 0]);
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

  function clearStage(restoreSource = false) {
    if (!staged) return;
    const sourceEdges = restoreSource && mode === 'path' ? staged.edges : null;
    staged = null;
    mode = 'pull';
    pathId = '';
    reversePath = false;
    turnOverride = null;
    pathError = '';
    pathWarning = '';
    pathSegments = 0;
    anchor.visible = false;
    anchor.position.set(0, 0, 0);
    anchor.quaternion.identity();
    anchor.scale.setScalar(1);
    group.visible = false;
    fill.geometry.dispose();
    fill.geometry = new THREE.BufferGeometry();
    clearGlyphGroup(cage);
    clearGlyphGroup(sourceHighlight);
    sourceHighlight.visible = false;
    if (stage.gizmoKind === 'edgeextrusion') stage.detachGizmo();
    deps.suppressSourceQuads([]);
    deps.restoreOtherPreview();
    if (sourceEdges) stage.cb.onExtrudeEdgeSelection?.(sourceEdges);
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
    if (!placed) {
      stage.cb.onExtrudeEdgesInvalid?.(pathError || 'Choose a path before committing the extrusion.');
      return;
    }
    if (!placementMoved(source, staged.plan, placed)) {
      stage.cb.onExtrudeEdgesInvalid?.('Drag the extrusion gizmo away from the source before committing.');
      return;
    }
    if (placed && stage.cb.onCommitExtrudeEdges?.(staged.plan, placed) !== false) clearStage();
  }

  function segmentCount(): number {
    if (mode === 'path') return pathSegments;
    const source = deps.meshDoc(),
      placed = placement();
    return staged &&
      source &&
      placed &&
      placementMoved(source, staged.plan, placed) &&
      planIntact(source, staged.plan, staged.names)
      ? edgeExtrusionSegmentCount(source, staged.plan, placed)
      : 0;
  }

  /** Flip an interior-edge extrusion's incident strip while retaining the direction already pulled. */
  function flipSide(): boolean {
    const source = deps.meshDoc();
    if (!staged?.plan.sideQuads?.length || !source || !staged.edges.length) return false;
    if (!planIntact(source, staged.plan, staged.names)) return false;
    const first = staged.plan.edges[0],
      incident =
        meshAdjacency(buildQuadMesh(source.vertices, source.quads, source.freeEdges)).edgeQuads.get(
          first.from < first.to ? `${first.from},${first.to}` : `${first.to},${first.from}`,
        ) ?? [];
    const opposite = incident.find(quad => quad !== first.sideQuad);
    if (opposite === undefined) return false;
    const planned = planEdgeExtrusion(source, edgeIndices(source, staged.edges), opposite);
    if (!planned.ok) {
      stage.cb.onExtrudeEdgesInvalid?.(planned.error);
      return false;
    }
    planned.plan.segmentLength = staged.plan.segmentLength;
    sideHint = quadName(source, opposite);
    const names = vertexNames(source, planned.plan.vertices);
    if (names.length !== planned.plan.vertices.length) return false;
    const delta = sceneToData(anchor.position.clone().sub(staged.sourceCenter));
    stagePlacement(staged.edges, planned.plan, names, delta);
    return true;
  }

  function setMode(value: 'pull' | 'path') {
    if (!staged || value === mode || (value === 'path' && staged.plan.kind !== 'edge')) return;
    mode = value;
    pathError = '';
    pathWarning = '';
    if (mode === 'path') {
      anchor.visible = false;
      stage.detachGizmo();
      stage.cb.onExtrudeEdgeSelection?.([]);
    } else {
      stage.cb.onExtrudeEdgeSelection?.(staged.edges);
      anchor.visible = true;
      stage.attachGizmo(anchor, 'edgeextrusion', -1);
    }
    rebuild();
    stage.cb.onExtrudeStageChange?.(true);
  }

  function setSegmentLength(value: number) {
    if (!staged || !Number.isFinite(value) || value <= 0) return;
    segmentLengthOverride = value;
    staged.plan.segmentLength = value;
    rebuild();
  }

  return {
    begin,
    beginStage,
    update,
    finish,
    onGizmoChange,
    flipSide,
    setMode,
    setSegmentLength,
    setPath(value: string) {
      pathId = value;
      reversePath = false;
      rebuild();
    },
    setReversePath(value: boolean) {
      reversePath = value;
      rebuild();
    },
    setTurnWithPath(value: boolean) {
      turnOverride = value;
      rebuild();
    },
    refreshPath() {
      if (staged && mode === 'path') rebuild();
    },
    setSideHint(quad: number | null) {
      const source = deps.meshDoc();
      sideHint = quad === null || !source ? null : quadName(source, quad);
    },
    commitStage,
    cancel() {
      if (drag) finish(null, false);
      else clearStage(true);
    },
    get active() {
      return !!drag || !!staged;
    },
    get dragging() {
      return !!drag;
    },
    get staged() {
      return !!staged;
    },
    get sideFlippable() {
      return mode === 'pull' && !!staged?.plan.sideQuads?.length;
    },
    get segments() {
      return segmentCount();
    },
    get mode() {
      return mode;
    },
    get pathAvailable() {
      return staged?.plan.kind === 'edge';
    },
    get segmentLength() {
      return staged?.plan.segmentLength ?? segmentLengthOverride ?? 10;
    },
    get path() {
      return pathId;
    },
    get reversePath() {
      return reversePath;
    },
    /** Whether a mesh-edge path extrusion turns the run with the path (else carries it parallel). */
    get turnWithPath() {
      return pathTurns;
    },
    get error() {
      return pathError;
    },
    get warning() {
      return pathError ? '' : pathWarning;
    },
  };
}

export type EdgeExtrusionLayer = ReturnType<typeof createEdgeExtrusionLayer>;
