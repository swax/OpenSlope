import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import {
  boxFromClicks,
  DEFAULT_BOX_HEIGHT_M,
  moveBoxBounds,
  type BoxAxis,
  type BoxBounds,
  type BoxDraft,
  type BoxPlan,
} from '../../../core/mesh/ops/box';
import { quadPerimeterEdges } from '../../../core/mesh/primitives';
import { dataToScene, sceneToData } from '../coordinates';
import type { PlacementEndpoint } from '../input/placement-constraint';
import { resolvePlacementEndpoint } from '../input/placement';
import { pickDraftEdge } from '../input/draft-picking';
import type { Stage } from '../stage';
import { DRAW_POINT_GEO, scaleDrawMarkers } from './draw-markers';

const AXES: BoxAxis[] = ['length', 'width', 'height'];
const FACES = AXES.flatMap((axis, index) => {
  const [u, v] = [0, 1, 2].filter(i => i !== index);
  return ([0, 1] as const).map(side => {
    const at = side << index;
    return {
      bounds: { [axis]: side } as BoxBounds,
      vertices: [at, at | (1 << u), at | (1 << u) | (1 << v), at | (1 << v)],
    };
  });
});
const EDGES = AXES.flatMap((axis, index) => {
  const [u, v] = [0, 1, 2].filter(i => i !== index);
  return ([0, 1] as const).flatMap(a =>
    ([0, 1] as const).map(b => {
      const at = (a << u) | (b << v);
      return {
        along: axis,
        bounds: { [AXES[u]]: a, [AXES[v]]: b } as BoxBounds,
        vertices: [at, at | (1 << index)] as [number, number],
      };
    }),
  );
});
type BoxSelection = 'whole' | { kind: 'face' | 'edge'; index: number } | null;

/** Draw the base in three clicks, then pull perpendicular to it and click to fix the signed height. */
export function createBoxToolLayer(
  stage: Stage,
  terrain: () => THREE.Mesh,
  pickVertex: () => PlacementEndpoint | null,
) {
  let active = false;
  let points: PlacementEndpoint[] = [];
  let hover: PlacementEndpoint | null = null;
  let base: BoxDraft | null = null;
  let draft: BoxDraft | null = null;
  let selected: BoxSelection = null;
  let height = DEFAULT_BOX_HEIGHT_M;
  let listener: (() => void) | null = null;
  let drag: { draft: BoxDraft; matrix: THREE.Matrix4; position: THREE.Vector3 } | null = null;
  let heightTrace: {
    parameter: number | null;
    pointerY: number;
    height: number;
    unitsPerNdc: number;
    camera: THREE.Matrix4;
    projection: THREE.Matrix4;
  } | null = null;
  const anchor = new THREE.Object3D();
  stage.scene.add(anchor);
  const material = new THREE.MeshBasicMaterial({ color: 0x50d8d0, depthTest: false, depthWrite: false });
  const dots = Array.from({ length: 3 }, () => new THREE.Mesh(DRAW_POINT_GEO, material));
  const hoverDot = new THREE.Mesh(DRAW_POINT_GEO, material);
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x8ffff8, depthTest: false, depthWrite: false }),
  );
  const highlight = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }),
  );
  for (const object of [...dots, hoverDot, lines, highlight]) {
    object.visible = false;
    object.renderOrder = 10_000;
    object.raycast = () => {};
    stage.worldRoot.add(object);
  }
  const placement = (axisLocked = false, onSurface = false) =>
    resolvePlacementEndpoint({ stage, terrain, pickVertex }, points.at(-1)?.pos ?? null, { axisLocked, onSurface });

  const baseCorner = () => dataToScene(base!.origin).add(dataToScene(base!.length)).add(dataToScene(base!.width));
  const heightAxis = () => dataToScene(base!.height).normalize();
  function heightParameter(): number | null {
    const ray = stage.ray.ray,
      axis = heightAxis(),
      delta = ray.origin.clone().sub(baseCorner());
    const along = axis.dot(ray.direction),
      denominator = 1 - along * along;
    return denominator < 0.04 ? null : (axis.dot(delta) - along * ray.direction.dot(delta)) / denominator;
  }
  function beginHeightTrace() {
    heightTrace = {
      parameter: heightParameter(),
      pointerY: stage.pointer.y,
      height,
      unitsPerNdc: (stage.worldPerPixel(baseCorner()) * stage.renderer.domElement.getBoundingClientRect().height) / 2,
      camera: stage.camera.matrixWorld.clone(),
      projection: stage.camera.projectionMatrix.clone(),
    };
  }
  function updateHeight() {
    const parameter = heightParameter();
    if (
      !heightTrace ||
      !heightTrace.camera.equals(stage.camera.matrixWorld) ||
      !heightTrace.projection.equals(stage.camera.projectionMatrix) ||
      (parameter === null) !== (heightTrace.parameter === null)
    )
      beginHeightTrace();
    const trace = heightTrace!;
    const value =
      trace.height +
      (parameter !== null && trace.parameter !== null
        ? parameter - trace.parameter
        : (stage.pointer.y - trace.pointerY) * trace.unitsPerNdc);
    const axis = heightAxis();
    // Snap the offset, keeping the base fixed and the extrusion exactly on its perpendicular axis.
    height = dataToScene(stage.snapDataPoint(sceneToData(axis.clone().multiplyScalar(value)))).dot(axis);
    hover = { pos: sceneToData(baseCorner().addScaledVector(axis, height)), vertex: null };
  }
  const volume = (): BoxDraft => ({ ...base!, height: base!.height.map(value => value * height) as V3 });

  const vertices = () =>
    Array.from(
      { length: 8 },
      (_, bits): V3 =>
        [0, 1, 2].map(
          coordinate =>
            draft!.origin[coordinate] +
            AXES.reduce((sum, axis, i) => sum + (bits & (1 << i) ? draft![axis][coordinate] : 0), 0),
        ) as V3,
    );
  const component = () =>
    selected && selected !== 'whole'
      ? selected.kind === 'face'
        ? FACES[selected.index]
        : EDGES[selected.index]
      : null;

  function select(next: BoxSelection) {
    selected = next;
    redraw();
    syncGizmo();
  }
  function pick() {
    const points = vertices(),
      at = points.map(point => dataToScene(point)),
      hit = new THREE.Vector3();
    let face: number | null = null,
      distance = Infinity;
    FACES.forEach((part, index) => {
      const [a, b, c, d] = part.vertices.map(i => at[i]);
      for (const [p, q, r] of [
        [a, b, c],
        [a, c, d],
      ]) {
        if (!stage.ray.ray.intersectTriangle(p, q, r, false, hit)) continue;
        const depth = hit.distanceTo(stage.ray.ray.origin);
        if (depth < distance) {
          distance = depth;
          face = index;
        }
      }
    });
    const edge = pickDraftEdge(
      stage,
      points,
      EDGES.map(part => part.vertices),
      face === null ? undefined : distance,
    );
    select(edge !== null ? { kind: 'edge', index: edge } : face !== null ? { kind: 'face', index: face } : null);
  }

  function syncGizmo() {
    if (!draft || selected === null) {
      if (stage.gizmoKind === 'box') stage.detachGizmo();
      return;
    }
    if (stage.gizmo.dragging) return;
    const origin = dataToScene(draft.origin);
    const vector = (v: V3) => dataToScene(v);
    anchor.position
      .copy(origin)
      .add(vector(draft.length).add(vector(draft.width)).add(vector(draft.height)).multiplyScalar(0.5));
    const part = component();
    if (part) {
      const points = vertices();
      anchor.position.set(0, 0, 0);
      for (const index of part.vertices) anchor.position.add(dataToScene(points[index]));
      anchor.position.divideScalar(part.vertices.length);
    }
    anchor.userData.boxResizeAxes = part
      ? [part.bounds.length !== undefined, part.bounds.height !== undefined, part.bounds.width !== undefined]
      : null;
    const x = vector(draft.length).normalize(),
      y = vector(draft.height).normalize();
    if (x.lengthSq() < 0.5 || y.lengthSq() < 0.5) return;
    anchor.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)),
    );
    anchor.scale.setScalar(1);
    stage.attachGizmo(anchor, 'box', -1);
  }

  function redraw() {
    dots.forEach((dot, i) => {
      dot.visible = active && !draft && !!points[i];
      if (points[i]) dot.position.set(...points[i].pos);
    });
    hoverDot.visible = active && !draft && !!hover;
    if (hover) hoverDot.position.set(...hover.pos);
    const part = component();
    highlight.visible = !!draft && !!part;
    if (draft && part) {
      const points = vertices(),
        segments: number[] = [];
      const edges =
        part.vertices.length === 2
          ? [[part.vertices[0], part.vertices[1]]]
          : part.vertices.map((from, i) => [from, part.vertices[(i + 1) % 4]]);
      for (const [a, b] of edges) segments.push(...points[a], ...points[b]);
      highlight.geometry.dispose();
      highlight.geometry = new THREE.BufferGeometry();
      highlight.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
    }
    listener?.();
  }

  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    points = [];
    hover = null;
    draft = null;
    selected = null;
    base = null;
    heightTrace = null;
    drag = null;
    lines.visible = false;
    highlight.visible = false;
    if (stage.gizmoKind === 'box') stage.detachGizmo();
    redraw();
  }

  function onCommit(axisLocked = false, onSurface = false) {
    if (!active) return;
    if (draft) {
      pick();
      return;
    }
    if (base) {
      updateHeight();
      if (Math.abs(height) < 1e-3) return;
      draft = volume();
      selected = 'whole';
      points.push(hover!);
      hover = null;
      redraw();
      syncGizmo();
      return;
    }
    const endpoint = placement(axisLocked, onSurface);
    if (
      !endpoint ||
      points.some(point => new THREE.Vector3(...point.pos).distanceTo(new THREE.Vector3(...endpoint.pos)) < 1e-3)
    )
      return;
    if (points.length === 2) {
      const candidate = boxFromClicks(points[0].pos, points[1].pos, endpoint.pos, 1);
      if (new THREE.Vector3(...candidate.width).length() < 1e-3) return;
      base = candidate;
      height = 0;
      beginHeightTrace();
    }
    points.push(endpoint);
    hover = null;
    redraw();
    syncGizmo();
  }

  function setDraft(next: BoxDraft) {
    if (!draft) return;
    draft = next;
    height = new THREE.Vector3(...draft.height).length();
    redraw();
    syncGizmo();
  }

  return {
    setActive,
    onCommit,
    setDraft,
    selectWhole() {
      if (draft) select('whole');
    },
    setHeight(value: number) {
      height = value;
      if (base && !draft) {
        beginHeightTrace();
        hover = { pos: sceneToData(baseCorner().addScaledVector(heightAxis(), height)), vertex: null };
        redraw();
      }
    },
    setListener(next: (() => void) | null) {
      listener = next;
    },
    onHover(event: PointerEvent) {
      if (!active) return false;
      if (!draft) {
        stage.castAt(event);
        if (base) updateHeight();
        else hover = placement(event.shiftKey, event.ctrlKey || event.metaKey);
        redraw();
      }
      return true;
    },
    refresh() {
      if (!active || draft) return;
      if (base) updateHeight();
      else hover = placement();
      redraw();
    },
    setPlan(plan: Pick<BoxPlan, 'points' | 'quads'> | null) {
      const segments: number[] = [];
      const seen = new Set<string>();
      for (const quad of plan?.quads ?? [])
        for (const [a, b] of quadPerimeterEdges(quad)) {
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          segments.push(...plan!.points[a], ...plan!.points[b]);
        }
      if (!plan && points.length === 1 && hover) segments.push(...points[0].pos, ...hover.pos);
      if (!plan && points.length === 2) segments.push(...points[0].pos, ...points[1].pos);
      lines.geometry.dispose();
      lines.geometry = new THREE.BufferGeometry();
      lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
      lines.visible = active && segments.length > 0;
    },
    gizmoDragging(on: boolean) {
      if (on && draft) {
        anchor.updateMatrix();
        drag = { draft, matrix: anchor.matrix.clone().invert(), position: anchor.position.clone() };
      } else {
        drag = null;
        syncGizmo();
      }
    },
    gizmoChanged() {
      if (!draft || !drag) return;
      const part = component();
      if (part) {
        draft = moveBoxBounds(drag.draft, part.bounds, sceneToData(anchor.position.clone().sub(drag.position)));
        height = new THREE.Vector3(...draft.height).length();
        redraw();
        return;
      }
      if (selected !== 'whole') return;
      anchor.scale.clampScalar(0.01, 1000);
      anchor.updateMatrix();
      const transform = anchor.matrix.clone().multiply(drag.matrix);
      const origin = dataToScene(drag.draft.origin).applyMatrix4(transform);
      const vector = (v: V3) => sceneToData(dataToScene(v).applyMatrix3(new THREE.Matrix3().setFromMatrix4(transform)));
      draft = {
        origin: sceneToData(origin),
        length: vector(drag.draft.length),
        width: vector(drag.draft.width),
        height: vector(drag.draft.height),
      };
      height = new THREE.Vector3(...draft.height).length();
      redraw();
    },
    scaleMarkers() {
      scaleDrawMarkers(stage, [...dots, hoverDot]);
    },
    get active() {
      return active;
    },
    get points(): readonly PlacementEndpoint[] {
      return points;
    },
    get draft() {
      return draft;
    },
    get wholeSelected() {
      return selected === 'whole';
    },
    get selectionLabel() {
      if (selected === 'whole') return 'whole box';
      if (!selected) return 'none';
      if (selected.kind === 'edge') return `edge along ${EDGES[selected.index].along}`;
      const part = FACES[selected.index];
      const axis = AXES.find(axis => part.bounds[axis] !== undefined)!;
      return `${axis} ${part.bounds[axis] === 0 ? 'start' : 'end'} face`;
    },
    get candidate() {
      return (
        draft ??
        (base
          ? volume()
          : points.length === 2 && hover
            ? boxFromClicks(points[0].pos, points[1].pos, hover.pos, 0)
            : null)
      );
    },
  };
}
export type BoxToolLayer = ReturnType<typeof createBoxToolLayer>;
