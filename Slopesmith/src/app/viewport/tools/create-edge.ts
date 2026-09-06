import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { EdgeCrossing } from '../../../core/mesh/edge-crossings';
import type { CoincidentVertices } from '../../../core/mesh/coincident-vertices';
import type { Stage } from '../stage';

const POINT_GEO = new THREE.SphereGeometry(1.1, 10, 8);
const POINT_COLOR = 0x9a5cff;
const SNAP_COLOR = 0x62f0b6;
const LINE_COLOR = 0xd7b3ff;
const T_JUNCTION_COLOR = 0xff2424;
const T_JUNCTION_SIZE_PX = 18;
const EDGE_CROSSING_SIZE_PX = 20;
const EDGE_OVERLAP_SIZE_PX = 17;
const COINCIDENT_VERTEX_SIZE_PX = 19;

function circleTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(32, 32, 28, 0, Math.PI * 2); ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function crossTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 11; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(13, 13); ctx.lineTo(51, 51); ctx.moveTo(51, 13); ctx.lineTo(13, 51); ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function diamondTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(32, 5); ctx.lineTo(59, 32); ctx.lineTo(32, 59); ctx.lineTo(5, 32); ctx.closePath(); ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Transient endpoint + segment preview for the mesh-native Create Edge tool. */
export function createEdgeLayer(stage: Stage) {
  let armed = false;
  let start: V3 | null = null;
  let hover: V3 | null = null;
  let path: V3[] = [];
  let diagnosticsVisible = true;
  const pointMat = new THREE.MeshBasicMaterial({ color: POINT_COLOR, depthTest: false, depthWrite: false });
  const snapMat = new THREE.MeshBasicMaterial({ color: SNAP_COLOR, depthTest: false, depthWrite: false });
  const startDot = new THREE.Mesh(POINT_GEO, pointMat);
  const hoverDot = new THREE.Mesh(POINT_GEO, pointMat);
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    color: LINE_COLOR, depthTest: false, depthWrite: false,
  }));
  let junctionCount = 0;
  let edgeCrossings: EdgeCrossing[] = [];
  let coincidentVertices: CoincidentVertices[] = [];
  const junctionMat = new THREE.PointsMaterial({
    color: T_JUNCTION_COLOR, map: circleTexture(), size: T_JUNCTION_SIZE_PX, sizeAttenuation: false,
    transparent: true, alphaTest: 0.2, depthTest: false, depthWrite: false,
  });
  const junctionPoints = new THREE.Points(new THREE.BufferGeometry(), junctionMat);
  const crossingPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
    color: 0xff3030, map: crossTexture(), size: EDGE_CROSSING_SIZE_PX, sizeAttenuation: false,
    transparent: true, alphaTest: 0.2, depthTest: false, depthWrite: false,
  }));
  const overlapPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
    color: 0xffb020, map: circleTexture(), size: EDGE_OVERLAP_SIZE_PX, sizeAttenuation: false,
    transparent: true, alphaTest: 0.2, depthTest: false, depthWrite: false,
  }));
  const coincidentPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
    color: 0xff4fd8, map: diamondTexture(), size: COINCIDENT_VERTEX_SIZE_PX, sizeAttenuation: false,
    transparent: true, alphaTest: 0.2, depthTest: false, depthWrite: false,
  }));
  for (const o of [startDot, hoverDot, line]) {
    o.visible = false;
    o.renderOrder = 10_000;
    o.raycast = () => { /* placement preview is never a pick target */ };
    stage.worldRoot.add(o);
  }
  junctionPoints.renderOrder = 10_001;
  junctionPoints.raycast = () => { /* diagnostics are never pick targets */ };
  for (const points of [crossingPoints, overlapPoints, coincidentPoints]) {
    points.renderOrder = 10_002;
    points.raycast = () => { /* screen-space picking is handled below */ };
  }
  stage.worldRoot.add(junctionPoints, crossingPoints, overlapPoints, coincidentPoints);

  function refreshJunctionVisibility() {
    junctionPoints.visible = diagnosticsVisible && !armed && junctionCount > 0;
    crossingPoints.visible = diagnosticsVisible && !armed && edgeCrossings.some(crossing => crossing.kind === 'crossing');
    overlapPoints.visible = diagnosticsVisible && !armed && edgeCrossings.some(crossing => crossing.kind === 'near-overlap');
    coincidentPoints.visible = diagnosticsVisible && !armed && coincidentVertices.length > 0;
  }

  /** Persistent topology diagnostics: unresolved vertex-on-edge contacts, hidden while a chain is active. */
  function setTJunctions(points: readonly V3[]) {
    junctionPoints.geometry.dispose();
    junctionPoints.geometry = new THREE.BufferGeometry().setAttribute('position',
      new THREE.Float32BufferAttribute(points.flatMap(point => [point[0], point[1], point[2]]), 3));
    junctionCount = points.length;
    refreshJunctionVisibility();
  }

  function setEdgeCrossings(crossings: readonly EdgeCrossing[]) {
    edgeCrossings = crossings.map(crossing => ({ ...crossing, edges: [crossing.edges[0], crossing.edges[1]],
      t: [...crossing.t], points: [crossing.points[0], crossing.points[1]], point: [...crossing.point] as V3 }));
    const set = (target: THREE.Points, kind: EdgeCrossing['kind']) => {
      target.geometry.dispose();
      target.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(
        edgeCrossings.filter(crossing => crossing.kind === kind).flatMap(crossing => crossing.point), 3));
    };
    set(crossingPoints, 'crossing'); set(overlapPoints, 'near-overlap');
    refreshJunctionVisibility();
  }

  function setCoincidentVertices(diagnostics: readonly CoincidentVertices[]) {
    coincidentVertices = diagnostics.map(diagnostic => ({
      ...diagnostic, vertices: [...diagnostic.vertices], points: [diagnostic.points[0], diagnostic.points[1]],
      point: [...diagnostic.point] as V3,
    }));
    coincidentPoints.geometry.dispose();
    coincidentPoints.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(
      coincidentVertices.flatMap(diagnostic => diagnostic.point), 3));
    refreshJunctionVisibility();
  }

  function pickDiagnostic<T>(items: readonly T[], pointOf: (item: T) => V3): T | null {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    let best: T | null = null, bestDistance2 = 12 * 12, bestDepth = Infinity;
    for (const item of items) {
      const projected = new THREE.Vector3(...pointOf(item)).applyMatrix4(stage.worldRoot.matrixWorld).project(stage.camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const dx = (projected.x - stage.pointer.x) * rect.width / 2;
      const dy = (projected.y - stage.pointer.y) * rect.height / 2;
      const distance2 = dx * dx + dy * dy;
      if (distance2 < bestDistance2 || (Math.abs(distance2 - bestDistance2) < 0.25 && projected.z < bestDepth)) {
        best = item; bestDistance2 = distance2; bestDepth = projected.z;
      }
    }
    return best;
  }

  function pickEdgeCrossing(): EdgeCrossing | null {
    if (!diagnosticsVisible || armed || !edgeCrossings.length) return null;
    return pickDiagnostic(edgeCrossings, crossing => crossing.point);
  }

  function pickCoincidentVertices(): CoincidentVertices | null {
    if (!diagnosticsVisible || armed || !coincidentVertices.length) return null;
    return pickDiagnostic(coincidentVertices, diagnostic => diagnostic.point);
  }

  function setDiagnosticsVisible(on: boolean) {
    diagnosticsVisible = on;
    refreshJunctionVisibility();
  }

  function refreshLine(end: V3 | null) {
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry();
    if (!armed || !start || !end) { line.visible = false; return; }
    const points = (path.length ? [...path, end] : [start, end])
      .map(point => new THREE.Vector3(point[0], point[1], point[2]));
    const spline = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    line.geometry.setFromPoints(spline.getPoints(Math.max(16, (points.length - 1) * 16)));
    line.visible = true;
  }

  function setArmed(on: boolean, from: V3 | null = null) {
    armed = on;
    start = from;
    hover = null;
    path = [];
    startDot.visible = !!(on && from);
    if (from) startDot.position.set(from[0], from[1], from[2]);
    if (!on) { hoverDot.visible = false; line.visible = false; }
    refreshJunctionVisibility();
  }

  function setStart(from: V3 | null) {
    start = from;
    startDot.visible = !!(armed && from);
    if (from) startDot.position.set(from[0], from[1], from[2]);
    if (!from) line.visible = false;
  }

  function setPath(points: readonly V3[]) {
    path = points.map(point => [...point] as V3);
    refreshLine(hover);
  }

  function showGhost(pos: V3 | null, snapped: boolean) {
    hover = pos ? [...pos] as V3 : null;
    if (!armed || !pos) { hoverDot.visible = false; line.visible = false; return; }
    hoverDot.material = snapped ? snapMat : pointMat;
    hoverDot.position.set(pos[0], pos[1], pos[2]);
    hoverDot.visible = true;
    refreshLine(pos);
  }

  return {
    get armed() { return armed; },
    get start() { return start; },
    get hover() { return hover; },
    setArmed,
    setStart,
    setPath,
    showGhost,
    setTJunctions,
    setEdgeCrossings,
    setCoincidentVertices,
    pickEdgeCrossing,
    pickCoincidentVertices,
    setDiagnosticsVisible,
  };
}

export type CreateEdgeLayer = ReturnType<typeof createEdgeLayer>;
