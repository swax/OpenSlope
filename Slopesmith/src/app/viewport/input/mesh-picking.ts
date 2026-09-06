import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { EdgeHandle, MeshAdjacency } from '../../../core/mesh/topology';
import { ekey, hoveredEdge } from '../../../core/mesh/ops';
import { mul, sub } from '../../../core/math/vec';
import { cubicPoint } from '../../../core/math/bezier';
import type { MeshControlPoint, MeshControlPointId } from '../../../core/mesh/control-points';
import type { PreviewData } from '../../../core/mesh/tessellation';
import type { ReferenceMesh } from '../../../core/reference/terrain';
import { CTRL_NET_SEG, EDGE_PICK_PX } from '../constants';
import type { Stage } from '../stage';

export type MeshComponentHit = {
  kind: 'vertex' | 'line' | 'surface';
  source: 'authored' | 'reference';
};

/** The live substrate the pick helpers read, on both sides of the authored ⇄ reference parity: the authored
 *  quad net + tessellated preview + cached directed-edge handle and its terrain mesh, the loaded reference
 *  solid + data + control-point list, the current edge selection, the Edit-mode hidden-component filters,
 *  and the cage / pinned-sub-cage state that gates point picks. The shell owns all of it and hands it in as
 *  closures, null where nothing is loaded. */
export interface MeshPickingAccess {
  net(): { positions: number[]; adj: MeshAdjacency } | null;
  preview(): PreviewData | null;
  meshHandle(): EdgeHandle | null;
  terrain(): THREE.Mesh;
  reference(): THREE.Mesh | null;
  refData(): ReferenceMesh | null;
  referenceControlPoints(): readonly MeshControlPoint<number>[];
  selectedEdges(): readonly [number, number][];
  vertexHidden(vertex: number): boolean;
  edgeHidden(a: number, b: number): boolean;
  quadHidden(quad: number): boolean;
  controlPointHidden(id: MeshControlPointId): boolean;
  authoredControlPointVisible<Id>(id: MeshControlPointId<Id>): boolean;
  referenceControlPointVisible(id: MeshControlPointId<number>): boolean;
  cage(): boolean;
  subCage(): boolean;
  referenceSubCage(): boolean;
  authoredControlPoints(): readonly MeshControlPoint[];
}

/**
 * The screen-space mesh pick helpers shared by selection, pointer routing and the placement tools — vertex >
 * edge > face precedence, over both the authored net and the read-only reference, all measured against the
 * drawn cubic curves in CSS pixel space.
 */
export function createMeshPicking(stage: Stage, access: MeshPickingAccess) {
  /** Nearest visible surface under the drag's first pixel; only a tie-breaker when both point clouds are boxed. */
  function vertexSourceAtPointer(): 'authored' | 'reference' | null {
    const reference = access.reference();
    const targets: THREE.Object3D[] = [access.terrain()];
    if (reference) targets.push(reference);
    const hit = stage.ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    return hit.object === reference ? 'reference' : 'authored';
  }

  /** Nearest control-net corner to the cursor in SCREEN space (within a pixel radius), front-most when
   *  several overlap. Screen-space so you grab the control point you SEE: a 3D surface-distance test missed
   *  corners on steep faces, where the corner floats well off the rendered surface the ray hits. */
  function pickCorner(): number | null {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const cx = ((stage.pointer.x + 1) / 2) * rect.width;  // cursor -> CSS pixels (stage.pointer is the click NDC)
    const cy = ((1 - stage.pointer.y) / 2) * rect.height;
    return cornerAtScreen(cx, cy);
  }

  /** Nearest visible non-corner dot in the explicitly pinned authored sub-cages. Screen-space picking matches the point
   * sprites (and works on edge-on/overhanging views where a terrain ray is the wrong interaction primitive). */
  function pickSubCagePoint(pxThresh = 11): MeshControlPointId | null {
    if (!access.subCage() || !access.cage() || !access.authoredControlPoints().length) return null;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const cx = ((stage.pointer.x + 1) / 2) * rect.width, cy = ((1 - stage.pointer.y) / 2) * rect.height;
    const maxD2 = pxThresh * pxThresh, v = new THREE.Vector3();
    let best: MeshControlPointId | null = null, bestD2 = Infinity, bestZ = Infinity;
    for (const cp of access.authoredControlPoints()) {
      if (cp.id.kind === 'vertex' || access.controlPointHidden(cp.id) || !access.authoredControlPointVisible(cp.id)) continue;
      v.set(cp.pos[0], cp.pos[1], -cp.pos[2]).project(stage.camera);
      if (v.z < -1 || v.z > 1) continue;
      const x = ((v.x + 1) / 2) * rect.width, y = ((1 - v.y) / 2) * rect.height;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 > maxD2) continue;
      if (d2 < bestD2 - 0.25 || (Math.abs(d2 - bestD2) <= 0.25 && v.z < bestZ)) {
        best = cp.id; bestD2 = d2; bestZ = v.z;
      }
    }
    return best;
  }

  function pickReferenceSubCagePoint(pxThresh = 11): MeshControlPointId<number> | null {
    if (!access.referenceSubCage() || !access.cage() || !access.reference() || !access.referenceControlPoints().length) return null;
    const rect = stage.renderer.domElement.getBoundingClientRect(), o = stage.refRoot.position;
    const cx = ((stage.pointer.x + 1) / 2) * rect.width, cy = ((1 - stage.pointer.y) / 2) * rect.height;
    const maxD2 = pxThresh * pxThresh, v = new THREE.Vector3();
    let best: MeshControlPointId<number> | null = null, bestD2 = Infinity, bestZ = Infinity;
    for (const cp of access.referenceControlPoints()) {
      if (cp.id.kind === 'vertex' || !access.referenceControlPointVisible(cp.id)) continue;
      v.set(cp.pos[0] + o.x, cp.pos[1] + o.y, -(cp.pos[2] + o.z)).project(stage.camera);
      if (v.z < -1 || v.z > 1) continue;
      const x = ((v.x + 1) / 2) * rect.width, y = ((1 - v.y) / 2) * rect.height;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 > maxD2) continue;
      if (d2 < bestD2 - 0.25 || (Math.abs(d2 - bestD2) <= 0.25 && v.z < bestZ)) {
        best = cp.id; bestD2 = d2; bestZ = v.z;
      }
    }
    return best;
  }

  /** Nearest read-only reference control-net vertex in screen space. This is the reference twin of
   * cornerAtScreen, including the loaded reference offset and the scene's authored-Z mirror. */
  function pickReferenceCorner(pxThresh = 16): number | null {
    const refData = access.refData();
    if (!access.reference() || !refData) return null;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const cx = ((stage.pointer.x + 1) / 2) * rect.width, cy = ((1 - stage.pointer.y) / 2) * rect.height;
    const o = stage.refRoot.position;
    return vertexAtScreen(refData.cornerPts, [o.x, o.y, o.z], cx, cy, pxThresh,
      vertex => access.referenceControlPointVisible({ kind: 'vertex', vertex }));
  }

  /** Shared authored/reference vertex picker. Both maps use identical projection, radius and front-most rules;
   * only their point buffer and placement offset differ. */
  function vertexAtScreen(points: ArrayLike<number>, offset: V3, cx: number, cy: number, pxThresh: number,
    visible: (vertex: number) => boolean = () => true): number | null {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const maxD2 = pxThresh * pxThresh, v = new THREE.Vector3();
    let best = -1, bestZ = Infinity;
    for (let i = 0; i < points.length; i += 3) {
      if (!visible(i / 3)) continue;
      v.set(points[i] + offset[0], points[i + 1] + offset[1], -(points[i + 2] + offset[2])).project(stage.camera);
      if (v.z < -1 || v.z > 1) continue;
      const x = ((v.x + 1) / 2) * rect.width, y = ((1 - v.y) / 2) * rect.height;
      if ((x - cx) ** 2 + (y - cy) ** 2 > maxD2) continue;
      if (v.z < bestZ) { best = i / 3; bestZ = v.z; }
    }
    return best >= 0 ? best : null;
  }

  /** The control-net corner nearest a CSS-pixel point, within a click radius, front-most when several overlap. */
  function cornerAtScreen(cx: number, cy: number, pxThresh = 16): number | null {
    const net = access.net();
    if (!net) return null;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const maxD2 = pxThresh * pxThresh, v = new THREE.Vector3(), points = net.positions;
    let best = -1, bestZ = Infinity;
    for (let vertex = 0; vertex < points.length / 3; vertex++) {
      if (access.vertexHidden(vertex) || !access.authoredControlPointVisible({ kind: 'vertex', vertex })) continue;
      const i = vertex * 3;
      v.set(points[i], points[i + 1], -points[i + 2]).project(stage.camera);
      if (v.z < -1 || v.z > 1) continue;
      const x = ((v.x + 1) / 2) * rect.width, y = ((1 - v.y) / 2) * rect.height;
      if ((x - cx) ** 2 + (y - cy) ** 2 > maxD2) continue;
      if (v.z < bestZ) { best = vertex; bestZ = v.z; }
    }
    return best >= 0 ? best : null;
  }

  /** A host corner's data-space position (the authored net's control point = the mesh vertex), or null. */
  function cornerPos(id: number): V3 | null {
    const net = access.net();
    if (!net || id < 0 || id * 3 + 2 >= net.positions.length) return null;
    const c = net.positions;
    return [c[id * 3], c[id * 3 + 1], c[id * 3 + 2]];
  }

  /** The control-net edge nearest the cursor on the selected terrain quad. Distance is measured against the
   *  actual sampled cubic cage edge in SCREEN space—not its endpoint chord—inside a generous pick band. A
   *  corner still wins first, and a miss falls through to the cell face: vertex > edge > face. */
  function pickEdgeAt(quad: number): [number, number] | null {
    const preview = access.preview();
    if (!preview || !access.net() || access.quadHidden(quad)) return null;
    const [A, B, C, D] = preview.mesh.quads[quad];
    const edges = [[A, B], [B, D], [D, C], [C, A]] as [number, number][];
    let best: [number, number] | null = null, bestD2 = Infinity;
    for (const [a, b] of edges) {
      if (a === b || access.edgeHidden(a, b)) continue; // wedge's collapsed side and hidden edges are not selectable
      const d2 = curveScreenDist2(a, b);
      if (d2 < bestD2) { bestD2 = d2; best = a < b ? [a, b] : [b, a]; }
    }
    return bestD2 <= EDGE_PICK_PX * EDGE_PICK_PX ? best : null;
  }

  /** Orthographic edge-on fallback: a face ray has zero area when viewed exactly from the side, so scan the
   *  visible control net directly in screen space. Pixel distance wins; coincident lines prefer the front-most
   *  edge, matching cornerAtScreen's overlap rule. Called only after the terrain raycast misses. */
  function pickAnyEdgeAt(): [number, number] | null {
    const net = access.net();
    if (!net) return null;
    const limit = EDGE_PICK_PX * EDGE_PICK_PX;
    let best: [number, number] | null = null, bestD2 = limit, bestZ = Infinity;
    const c = net.positions, mid = new THREE.Vector3();
    for (let a = 0; a < net.adj.neighbors.length; a++) {
      for (const b of net.adj.neighbors[a] ?? []) {
        if (b <= a || access.edgeHidden(a, b)) continue; // each visible undirected edge once
        const d2 = curveScreenDist2(a, b);
        if (d2 > limit) continue;
        mid.set((c[a * 3] + c[b * 3]) / 2, (c[a * 3 + 1] + c[b * 3 + 1]) / 2,
          -(c[a * 3 + 2] + c[b * 3 + 2]) / 2).project(stage.camera);
        if (d2 < bestD2 - 0.25 || (Math.abs(d2 - bestD2) <= 0.25 && mid.z < bestZ)) {
          best = [a, b]; bestD2 = d2; bestZ = mid.z;
        }
      }
    }
    return best;
  }

  /** Screen-space boundary pick used by Create Edge. Unlike a face raycast, this still finds the outside seam
   * when the cursor sits a pixel beyond the rendered terrain silhouette. */
  function pickBoundaryEdgeAt(): [number, number] | null {
    const net = access.net();
    if (!net) return null;
    const limit = EDGE_PICK_PX * EDGE_PICK_PX;
    let best: [number, number] | null = null, bestD2 = limit, bestZ = Infinity;
    const c = net.positions, mid = new THREE.Vector3();
    for (let a = 0; a < net.adj.neighbors.length; a++) for (const b of net.adj.neighbors[a] ?? []) {
      if (b <= a || access.edgeHidden(a, b) || (net.adj.edgeQuads.get(ekey(a, b))?.length ?? 0) !== 1) continue;
      const d2 = curveScreenDist2(a, b);
      if (d2 > limit) continue;
      mid.set((c[a * 3] + c[b * 3]) / 2, (c[a * 3 + 1] + c[b * 3 + 1]) / 2,
        -(c[a * 3 + 2] + c[b * 3 + 2]) / 2).project(stage.camera);
      if (d2 < bestD2 - 0.25 || (Math.abs(d2 - bestD2) <= 0.25 && mid.z < bestZ)) {
        best = [a, b]; bestD2 = d2; bestZ = mid.z;
      }
    }
    return best;
  }

  /** Free edges have no terrain face to raycast, so pick their drawn cubic directly in screen space. */
  function pickFreeEdgeAt(): [number, number] | null {
    const mesh = access.preview()?.mesh;
    const net = access.net();
    if (!mesh?.freeEdges.length || !net) return null;
    const limit = EDGE_PICK_PX * EDGE_PICK_PX;
    let best: [number, number] | null = null, bestD2 = limit, bestZ = Infinity;
    const c = net.positions, mid = new THREE.Vector3();
    for (const [a, b] of mesh.freeEdges) {
      if (access.edgeHidden(a, b)) continue;
      const d2 = curveScreenDist2(a, b);
      if (d2 > limit) continue;
      mid.set((c[a * 3] + c[b * 3]) / 2, (c[a * 3 + 1] + c[b * 3 + 1]) / 2,
        -(c[a * 3 + 2] + c[b * 3 + 2]) / 2).project(stage.camera);
      if (d2 < bestD2 - 0.25 || (Math.abs(d2 - bestD2) <= 0.25 && mid.z < bestZ)) {
        best = a < b ? [a, b] : [b, a]; bestD2 = d2; bestZ = mid.z;
      }
    }
    return best;
  }

  /** Squared screen distance to the true cubic boundary generated by the current effective handles. Twelve
   *  segments match the control-net study tessellation and are ample for a 14 px interaction band. */
  function curveScreenDist2(a: number, b: number): number {
    return curveScreenClosest(a, b).d2;
  }

  /** Closest point on a sampled authored cubic to the pointer, in screen space. Used both by ordinary edge
   * picking and Create Edge's exact boundary-split placement. */
  function curveScreenClosest(a: number, b: number): { d2: number; t: number; pos: V3 } {
    const c = access.net()!.positions, eh = access.meshHandle();
    const P = (id: number): V3 => [c[id * 3], c[id * 3 + 1], c[id * 3 + 2]];
    const p0 = P(a), p3 = P(b);
    const hab = eh?.(a, b) ?? mul(sub(p3, p0), 1 / 3), hba = eh?.(b, a) ?? mul(sub(p0, p3), 1 / 3);
    const p1: V3 = [p0[0] + hab[0], p0[1] + hab[1], p0[2] + hab[2]];
    const p2: V3 = [p3[0] + hba[0], p3[1] + hba[1], p3[2] + hba[2]];
    let prev = p0, best = Infinity, bestT = 0;
    for (let i = 1; i <= CTRL_NET_SEG; i++) {
      const cur = cubicPoint(p0, p1, p2, p3, i / CTRL_NET_SEG);
      const closest = chordScreenClosest(
        new THREE.Vector3(prev[0], prev[1], -prev[2]), new THREE.Vector3(cur[0], cur[1], -cur[2]));
      if (closest.d2 < best) { best = closest.d2; bestT = (i - 1 + closest.s) / CTRL_NET_SEG; }
      prev = cur;
    }
    return { d2: best, t: bestT, pos: cubicPoint(p0, p1, p2, p3, bestT) };
  }

  /** Squared screen-pixel distance from the current click (stage.pointer) to the chord between two WORLD-space
   *  endpoints, projecting both like pickCorner does. The chord approximates the drawn bicubic wire — plenty
   *  for a click gate on the mostly-gentle terrain edges. Shared by the authored + reference edge picks. */
  function chordScreenDist2(aw: THREE.Vector3, bw: THREE.Vector3): number {
    return chordScreenClosest(aw, bw).d2;
  }

  function chordScreenClosest(aw: THREE.Vector3, bw: THREE.Vector3): { d2: number; s: number } {
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const cx = ((stage.pointer.x + 1) / 2) * rect.width, cy = ((1 - stage.pointer.y) / 2) * rect.height;
    const A = aw.clone().project(stage.camera), B = bw.clone().project(stage.camera);
    const ax = ((A.x + 1) / 2) * rect.width, ay = ((1 - A.y) / 2) * rect.height;
    const bx = ((B.x + 1) / 2) * rect.width, by = ((1 - B.y) / 2) * rect.height;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const s = l2 > 1e-6 ? Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy) / l2)) : 0;
    const ex = ax + s * dx - cx, ey = ay + s * dy - cy;
    return { d2: ex * ex + ey * ey, s };
  }

  /** True when the current pointer is actually over one of the selected cubic edges. Testing the selected set
   * directly also works in orthographic edge-on and cage-only views, where the terrain face has no ray hit. */
  function selectedEdgeAtPointer(): boolean {
    const limit = (EDGE_PICK_PX * 1.35) ** 2;
    return access.selectedEdges().some(([a, b]) => curveScreenDist2(a, b) <= limit);
  }

  /** The reference patch under the cursor (the ray must already be cast), or none — but only when the
   *  reference is the NEAREST surface hit, so authored terrain in front of it still selects its own cell
   *  (nearest-wins, like paintSelectAtPointer). Its face index resolves to a patch as the other ref picks do. */
  function pickRefPatch(): number | null {
    const reference = access.reference(), refData = access.refData();
    if (!reference || !refData) return null;
    const hit = stage.ray.intersectObjects([access.terrain(), reference], false)[0];
    if (hit && hit.object === reference && hit.faceIndex != null) return Math.floor(hit.faceIndex / refData.facesPerPatch);
    return null;
  }

  /** The reference control-net edge under the cursor (raycast the reference, nearest edge of the hit patch,
   *  gated by screen distance) — the read-only twin of pickEdgeAt, on the reference's own QuadMesh. */
  function pickRefEdge(): [number, number] | null {
    const data = access.refData(), reference = access.reference();
    if (!data || !reference) return null;
    const hit = stage.ray.intersectObjects([access.terrain(), reference], false)[0];
    if (!hit || hit.object !== reference || hit.faceIndex == null) return null; // authored terrain in front wins
    const patch = Math.floor(hit.faceIndex / data.facesPerPatch);
    const o = stage.refRoot.position;
    const point: V3 = [hit.point.x - o.x, hit.point.y - o.y, -hit.point.z - o.z]; // world hit → reference-native data
    const [a, b] = hoveredEdge(data.mesh, patch, point);
    const c = data.cornerPts;
    const aw = new THREE.Vector3(c[a * 3] + o.x, c[a * 3 + 1] + o.y, -(c[a * 3 + 2] + o.z)); // native + offset → world (Z flip)
    const bw = new THREE.Vector3(c[b * 3] + o.x, c[b * 3 + 1] + o.y, -(c[b * 3 + 2] + o.z));
    if (chordScreenDist2(aw, bw) > EDGE_PICK_PX * EDGE_PICK_PX) return null;
    return a < b ? [a, b] : [b, a];
  }

  /** Identify the mesh component under the pointer in every editor view, using the same point > edge > face
   * precedence as Edit selection. Ordinary vertices / edges remain detectable when the cage is hidden; visible
   * sub-cage dots participate too. When authored and reference terrain overlap, only the component on the
   * nearest surface is eligible. */
  function pickMeshComponent(): MeshComponentHit | null {
    const reference = access.reference();
    const targets: THREE.Object3D[] = reference ? [access.terrain(), reference] : [access.terrain()];
    const surfaceHit = stage.ray.intersectObjects(targets, false)[0];
    const surfaceSource: 'authored' | 'reference' | null = !surfaceHit ? null
      : surfaceHit.object === reference ? 'reference' : 'authored';

    // Pinned sub-cage dots are points too. They win over corners exactly as their Edit click path does.
    const authoredPoint = pickSubCagePoint() ?? (pickCorner() !== null ? { kind: 'vertex' as const } : null);
    const referencePoint = pickReferenceSubCagePoint() ?? (pickReferenceCorner() !== null ? { kind: 'vertex' as const } : null);
    if (surfaceSource === 'authored' && authoredPoint) return { kind: 'vertex', source: 'authored' };
    if (surfaceSource === 'reference' && referencePoint) return { kind: 'vertex', source: 'reference' };
    if (!surfaceSource) {
      if (authoredPoint) return { kind: 'vertex', source: 'authored' };
      if (referencePoint) return { kind: 'vertex', source: 'reference' };
    }

    if (surfaceSource === 'authored') {
      const freeEdge = pickFreeEdgeAt();
      if (freeEdge) return { kind: 'line', source: 'authored' };
      const preview = access.preview();
      const quad = preview && surfaceHit?.faceIndex != null
        ? Math.floor(surfaceHit.faceIndex / preview.facesPerCell) : null;
      if (quad !== null && pickEdgeAt(quad)) return { kind: 'line', source: 'authored' };
    } else if (surfaceSource === 'reference') {
      if (pickRefEdge()) return { kind: 'line', source: 'reference' };
    } else {
      if (pickFreeEdgeAt() || (stage.isOrtho && pickAnyEdgeAt())) return { kind: 'line', source: 'authored' };
    }

    return surfaceSource ? { kind: 'surface', source: surfaceSource } : null;
  }

  return {
    vertexSourceAtPointer,
    pickCorner, pickSubCagePoint, pickReferenceSubCagePoint, pickReferenceCorner,
    vertexAtScreen, cornerAtScreen, cornerPos,
    pickEdgeAt, pickAnyEdgeAt, pickBoundaryEdgeAt, pickFreeEdgeAt,
    curveScreenDist2, curveScreenClosest, chordScreenDist2, chordScreenClosest,
    selectedEdgeAtPointer, pickRefPatch, pickRefEdge, pickMeshComponent,
  };
}

export type MeshPicking = ReturnType<typeof createMeshPicking>;
