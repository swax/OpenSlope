import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { WELD_AIM_COLOR, WELD_FROM_COLOR, WELD_FROM_PX } from '../constants';
import type { Stage } from '../stage';
import { dataToScene, setScenePositionFromData } from '../coordinates';

export type WeldToolDeps = {
  terrain: () => THREE.Mesh;
  pickCorner: () => number | null;
  cornerPos: (vertex: number) => V3 | null;
};

/** Weld scene feedback. Point and edge weld both display their captured source vertices while ordinary
 * selection gathers an equal-size target set; the application validates and commits the complete set. */
export function createWeldToolLayer(stage: Stage, deps: WeldToolDeps) {
  let active = false;
  let from: number[] = [];
  let edgeFrom: [number, number][] = [];

  const fromGeometry = new THREE.SphereGeometry(1, 12, 8);
  const fromMaterial = new THREE.MeshBasicMaterial({ color: WELD_FROM_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
  const fromDots = new THREE.Group();
  fromDots.renderOrder = 14;
  stage.scene.add(fromDots);
  const fromEdges = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: WELD_FROM_COLOR, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  fromEdges.renderOrder = 14;
  fromEdges.visible = false;
  fromEdges.raycast = () => { /* feedback only */ };
  stage.scene.add(fromEdges);

  const aimLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: WELD_AIM_COLOR, transparent: true, opacity: 0.7, depthTest: false }),
  );
  aimLine.renderOrder = 14;
  aimLine.visible = false;
  aimLine.raycast = () => { /* feedback only */ };
  stage.scene.add(aimLine);

  function scaleMarker() {
    for (const child of fromDots.children) {
      const dot = child as THREE.Mesh;
      dot.scale.setScalar(Math.max(1e-4, WELD_FROM_PX * stage.worldPerPixel(dot.position)));
    }
  }

  function setFrom(vertices: readonly number[]) {
    from = [...new Set(vertices)];
    fromDots.clear();
    for (const vertex of from) {
      const point = deps.cornerPos(vertex);
      if (!point) continue;
      const dot = new THREE.Mesh(fromGeometry, fromMaterial);
      setScenePositionFromData(dot.position, point);
      dot.renderOrder = 14;
      dot.raycast = () => { /* feedback only */ };
      fromDots.add(dot);
    }
    scaleMarker();
    if (!fromDots.children.length) aimLine.visible = false;
  }

  function setActive(vertices: readonly number[] | false) {
    active = vertices !== false && vertices.length > 0;
    edgeFrom = [];
    fromEdges.visible = false;
    setFrom(vertices === false ? [] : vertices);
  }

  function setEdgeActive(edges: readonly [number, number][] | null) {
    active = !!edges?.length;
    edgeFrom = edges?.map(edge => [...edge] as [number, number]) ?? [];
    setFrom([...new Set(edgeFrom.flatMap(edge => edge))]);
    const positions = edgeFrom.flatMap(([a, b]) => {
      const pa = deps.cornerPos(a), pb = deps.cornerPos(b);
      return pa && pb ? [pa[0], pa[1], -pa[2], pb[0], pb[1], -pb[2]] : [];
    });
    fromEdges.geometry.dispose();
    fromEdges.geometry = new THREE.BufferGeometry();
    if (positions.length) fromEdges.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    fromEdges.visible = positions.length > 0;
  }

  /** Targets use the ordinary selection machinery (including Shift, loops, and marquee where applicable), then
   * the toolbox's Commit button performs the merge. */
  function onCommit(): boolean {
    return false;
  }

  function onHover(event: PointerEvent): boolean {
    if (!active) return false;
    stage.castAt(event);
    const points = from.map(vertex => deps.cornerPos(vertex)).filter((point): point is V3 => point !== null);
    const source: V3 | null = points.length
      ? points.reduce<V3>((sum, p) => [sum[0] + p[0] / points.length, sum[1] + p[1] / points.length, sum[2] + p[2] / points.length], [0, 0, 0])
      : null;
    // the aim line re-solves per pointer move — accelerated through the surface's cached tree (Stage.pickSurface)
    const hit = source ? stage.pickSurface(deps.terrain()) : undefined;
    if (source && hit) {
      (aimLine.geometry as THREE.BufferGeometry).setFromPoints([
        dataToScene(source), hit.point.clone(),
      ]);
      aimLine.visible = true;
    } else aimLine.visible = false;
    return false;
  }

  return {
    setActive,
    setEdgeActive,
    onCommit,
    onHover,
    scaleMarker,
    get active() { return active; },
  };
}

export type WeldToolLayer = ReturnType<typeof createWeldToolLayer>;
