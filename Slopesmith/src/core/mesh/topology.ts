import type { V3, QuadMeshDoc } from '../doc/types';
import { add, mul, sub, cross, dot, len, norm } from '../math/vec';
import { besselTangent, pushCubicEdge } from '../math/bezier';
import type { SurfaceTopology } from './surface';
import { readVertex, undirectedEdgeKey as ekey } from './primitives';

/**
 * A terrain surface as a GENERAL quad mesh: a vertex cloud plus quads and optional free control edges, the
 * topology-agnostic form the preview and the export both consume. A rectangular control net is one
 * instance of this (see mountain.ts `deriveQuadMesh`, which builds one from the grid); a poled /
 * partial-loop mesh is another. Both derive into the SAME bicubic quilt via `quadControlPoints`, so a grid
 * doc and a free-patch doc render and bake through one path - the seam `surface.ts` was written toward.
 *
 * Corner order matches the reference + bezier convention: [A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)] -
 * so within a quad A->B and C->D run +v (across), A->C and B->D run +u (down the spine). Same winding the
 * reference loader records (terrain.ts `patchCorners`), so a quad and a reference patch read the same way.
 */
export interface QuadMesh {
  /** Vertex positions, editor metres, xyz flat (3 per vertex); vertex id `i` is at `vertices[i*3 .. +2]`.
   *  Float64 (`number[]`, matching the doc's `corners`), so the derived control points - and the exported
   *  Patches.json - carry the doc's full precision, not a float32-rounded copy. */
  vertices: number[];
  /** Per quad, its four corner vertex ids [A, B, C, D] (A@(0,0) B@(0,1) C@(1,0) D@(1,1)). */
  quads: number[][];
  /** Explicit edges with no incident surface quad. */
  freeEdges: [number, number][];
  quadCount: number;
  vertexCount: number;
  /** Quad adjacency for cell selection / face loops - the shared surface.ts substrate (faceLoop / faceBlock). */
  topology: SurfaceTopology;
}

/**
 * The tangent HANDLE for a directed edge: the offset from vertex `from` to the cubic Bezier control point
 * one-third of the way along the edge toward vertex `to`. This is the one piece of per-edge shape data the
 * bicubic quilt needs - a smooth default is the Bessel tangent, a crease is an override on the directed
 * edge. It is the general form of bezier.ts's u-/u+/v-/v+ directional handles, which presuppose a
 * valence-4 grid vertex; keyed by (from, to) it is well defined at a 3/5 pole and on a free edge too.
 */
export type EdgeHandle = (from: number, to: number) => V3;

const vAt = (m: QuadMesh, i: number): V3 => readVertex(m.vertices, i);
const ZERO3: V3 = [0, 0, 0];

/**
 * The 16 bicubic Bezier control points of one quad, row-major (rows along u), from its four corner
 * positions and the directed-edge handles. On a regular lattice this reduces EXACTLY to the classic grid form:
 * each edge control point is a corner plus its handle toward the in-quad neighbour, and each interior
 * control point is a corner plus its TWO in-quad handles (zero twist - the Ferguson patch). The only
 * change is that adjacency comes from the quad's corner ids, not (row, col), so it also holds at a pole
 * where there is no global u/v lattice. Feed it to patchPoint / patchNormal exactly like a grid cell's CPs.
 *
 * `twist` (optional, `[A, B, C, D]`) offsets the four interior CPs (cp5@A, cp6@B, cp9@C, cp10@D) PAST the
 * zero-twist prediction — the doc's per-quad `quadTwist` sculpt (docs/020). Omitted ⇒ pure Ferguson, so
 * every caller that doesn't sculpt interiors is byte-identical to before.
 */
export function quadControlPoints(mesh: QuadMesh, eh: EdgeHandle, quad: number, twist?: readonly V3[] | null): V3[] {
  const [ai, bi, ci, di] = mesh.quads[quad];
  const A = vAt(mesh, ai), B = vAt(mesh, bi), C = vAt(mesh, ci), D = vAt(mesh, di);
  // one handle per in-quad directed edge (A<->B and C<->D across v; A<->C and B<->D down u)
  const hAB = eh(ai, bi), hBA = eh(bi, ai), hAC = eh(ai, ci), hCA = eh(ci, ai);
  // A WEDGE [A,B,C,C] (di===ci) folds the D–C side to point C (docs/017 S3): its two handles are zero, giving a
  // collapsed-edge bicubic (the u=1 control row folds to C) byte-compatible with the reference wedge encoding.
  // eh must not be asked for that self-edge; B<->D is still the real B–C edge, so it reads normally.
  const collapsed = di === ci;
  const hBD = eh(bi, di), hDB = eh(di, bi);
  const hCD = collapsed ? ZERO3 : eh(ci, di), hDC = collapsed ? ZERO3 : eh(di, ci);

  const cp: V3[] = new Array(16);
  cp[0] = A;
  cp[1] = add(A, hAB);              // A -> +v (toward B)
  cp[2] = add(B, hBA);              // B -> -v (toward A)
  cp[3] = B;
  cp[4] = add(A, hAC);              // A -> +u (toward C)
  cp[5] = add(add(A, hAC), hAB);    // interior at A (zero twist)
  cp[6] = add(add(B, hBA), hBD);    // interior at B
  cp[7] = add(B, hBD);              // B -> +u (toward D)
  cp[8] = add(C, hCA);              // C -> -u (toward A)
  cp[9] = add(add(C, hCA), hCD);    // interior at C
  cp[10] = add(add(D, hDB), hDC);   // interior at D
  cp[11] = add(D, hDB);             // D -> -u (toward B)
  cp[12] = C;
  cp[13] = add(C, hCD);             // C -> +v (toward D)
  cp[14] = add(D, hDC);             // D -> -v (toward C)
  cp[15] = D;
  if (twist) {                       // sculpt the interiors off zero-twist (order A/B/C/D → cp 5/6/9/10)
    if (twist[0]) cp[5] = add(cp[5], twist[0]);
    if (twist[1]) cp[6] = add(cp[6], twist[1]);
    if (twist[2]) cp[9] = add(cp[9], twist[2]);
    if (twist[3]) cp[10] = add(cp[10], twist[3]);
  }
  return cp;
}

/** The interior control-point index (in the row-major 16) for corner slot 0/1/2/3 = A/B/C/D — the CP a
 *  `quadTwist` corner offset moves (cp5@A, cp6@B, cp9@C, cp10@D). */
export const INTERIOR_CP = [5, 6, 9, 10] as const;

/**
 * The quad adjacency of a raw vertex-id quad list - the SurfaceTopology the selection / face loops read
 * (surface.ts), built directly from the quads (not by position-dedup like the reference loader, which
 * has no ids). Each quad's four boundary edges are recorded in the perimeter order [A-B, B-D, D-C, C-A],
 * so opposite pairs are (0,2) / (1,3) - the row-major ordering a promoted lattice carries, so its face
 * loops are identical. A vertex is an extraordinary POLE when it is INTERIOR (every incident edge shared
 * by two quads) yet its incident-quad count is not four - so a pristine grid flags none (loops run rim to
 * rim) and only a real 3/5 fan stops a loop.
 */
export function topologyFromQuads(quads: number[][], vertexCount: number): SurfaceTopology {
  const edgeId = new Map<string, number>();
  const edgeCells: number[][] = [];
  const edgeEnds: [number, number][] = [];
  const getEdge = (a: number, b: number): number => {
    const k = ekey(a, b);
    let id = edgeId.get(k);
    if (id === undefined) { id = edgeCells.length; edgeId.set(k, id); edgeCells.push([]); edgeEnds.push(a < b ? [a, b] : [b, a]); }
    return id;
  };
  // A wedge's collapsed side (docs/017 S3) is a PRIVATE single-cell edge — never the shared "C,C" key (which
  // would fuse every same-apex wedge), so face loops treat it as a wall (a strip ends there, like a rim).
  const wallEdge = (a: number): number => { const id = edgeCells.length; edgeCells.push([]); edgeEnds.push([a, a]); return id; };
  const cellEdges: number[][] = new Array(quads.length);
  const vertQuads: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let q = 0; q < quads.length; q++) {
    const [A, B, C, D] = quads[q];
    // D===C ⇒ a wedge [A,B,C,C]: its D–C side is collapsed (a private wall); the other three sides are real.
    const e = [getEdge(A, B), getEdge(B, D), D === C ? wallEdge(C) : getEdge(D, C), getEdge(C, A)];
    cellEdges[q] = e;
    for (const id of e) edgeCells[id].push(q);
    for (const v of quads[q]) vertQuads[v].add(q);
  }
  // a vertex is interior iff every incident edge is shared by two quads; a boundary (rim) edge un-flags both ends
  const interior = new Array<boolean>(vertexCount).fill(true);
  for (let id = 0; id < edgeCells.length; id++) {
    if (edgeCells[id].length < 2) { const [a, b] = edgeEnds[id]; interior[a] = false; interior[b] = false; }
  }
  const isPole = (v: number) => interior[v] && vertQuads[v].size !== 4;
  const edgeTouchesPole = edgeEnds.map(([a, b]) => isPole(a) || isPole(b));
  return { cellCount: quads.length, cellEdges, edgeCells, edgeTouchesPole };
}

/** Wrap a vertex cloud + quad/free-edge list as a QuadMesh (surface topology still comes from the quads). */
export function buildQuadMesh(vertices: number[], quads: number[][], freeEdges: [number, number][] = []): QuadMesh {
  return { vertices, quads, freeEdges, quadCount: quads.length, vertexCount: vertices.length / 3, topology: topologyFromQuads(quads, vertices.length / 3) };
}

/**
 * The directed-edge handle over a general quad mesh: an OVERRIDE if the doc pinned one, else the smooth
 * (Bessel) default. The default is the chord-weighted tangent at `from` along the axis through the edge to
 * `to`, using the OPPOSITE neighbour across `from` - the unique incident edge sharing NO quad with the
 * from→to edge (the same "onward edge" rule the reference loop tracer uses). At a regular valence-4 vertex
 * that opposite is exactly the lattice's −u/−v (or −v/−u) neighbour, so this reproduces the grid tangents bit for
 * bit; at a rim vertex there is no opposite and it falls to the one-sided tangent (also grid-identical).
 * At an extraordinary interior pole the axis is ambiguous, so all outgoing chords are projected into one
 * angle-weighted tangent plane fitted to the incident quad fan. That gives the pole a shared smooth frame
 * instead of making its automatic handles indistinguishable from a one-sided crease.
 */
export function meshEdgeHandles(mesh: QuadMesh, overrides?: Record<string, V3>,
  adj: MeshAdjacency = meshAdjacency(mesh)): EdgeHandle {
  const { neighbors, edgeQuads } = adj;
  const P = (i: number): V3 => readVertex(mesh.vertices, i);
  const poles = extraordinaryPoles(adj);
  // Position-derived, so the cache belongs to THIS handle provider and never to the shared topology index —
  // a provider rebuilt after a vertex move starts with an empty one and reads the corners as they now stand.
  const poleNormals = new Map<number, V3>();
  const poleNormal = (id: number): V3 => {
    const cached = poleNormals.get(id);
    if (cached) return cached;
    const incident = new Set<number>();
    for (const nb of neighbors[id]) for (const quad of edgeQuads.get(ekey(id, nb)) ?? []) incident.add(quad);
    let sum: V3 = [0, 0, 0], areaFallback: V3 = [0, 0, 0];
    for (const quad of incident) {
      const corners = mesh.quads[quad], slot = corners.indexOf(id);
      if (slot < 0) continue;
      const [A, B, C, D] = corners.map(P);
      const dv = slot < 2 ? sub(B, A) : sub(D, C);
      const du = slot === 0 || slot === 2 ? sub(C, A) : sub(D, B);
      const face = cross(dv, du), dvLen = len(dv), duLen = len(du);
      if (len(face) < 1e-10 || dvLen < 1e-10 || duLen < 1e-10) continue;
      // Winding already establishes the correct side. Do not flip a legitimate concave contribution toward
      // the first face; weight its unit normal by the sector's corner angle so long/skewed quads cannot own
      // the pole frame merely because their chords have more area.
      const cosine = Math.max(-1, Math.min(1, dot(dv, du) / (dvLen * duLen)));
      sum = add(sum, mul(face, Math.acos(cosine) / len(face)));
      areaFallback = add(areaFallback, face);
    }
    const result = len(sum) > 1e-10 ? norm(sum) : len(areaFallback) > 1e-10 ? norm(areaFallback) : [0, 1, 0] as V3;
    poleNormals.set(id, result);
    return result;
  };
  return (from, to) => {
    const ov = overrides?.[`${from}>${to}`];
    if (ov) return ov;
    const qs = edgeQuads.get(ekey(from, to)) ?? [];
    let opp = -1, count = 0;
    for (const x of neighbors[from]) {
      if (x === to) continue;
      const qx = edgeQuads.get(ekey(from, x)) ?? [];
      if (!qx.some(q => qs.includes(q))) { opp = x; count++; } // shares no quad with from→to: the opposite axis edge
    }
    let t: V3;
    if (count === 1) t = besselTangent(P(opp), P(from), P(to)); // two-sided: grid-interior identical
    else if (poles.has(from)) {
      const chord = sub(P(to), P(from)), normal = poleNormal(from);
      const projected = sub(chord, mul(normal, dot(chord, normal)));
      t = len(projected) > 1e-10 ? projected : chord;
    } else t = besselTangent(null, P(from), P(to)); // one-sided rim/free edge
    return mul(t, 1 / 3);
  };
}

/**
 * The control-net edges of a GENERAL quad mesh as CURVED cubic-Bezier polylines: every edge is the shared
 * boundary curve (a corner, its directional handle toward the neighbour, the neighbour's handle back, the
 * neighbour), sampled into `seg` straight sub-segments — the SAME curve the quilt bakes, so the cage draws
 * the terrain's true edges, not straight chords between corners. The topology-general form of bezier.ts
 * the old rectangular-grid cage builder; `eh` is the doc's directed-edge handle
 * (`meshEdgeHandles`), the same one `quadControlPoints` reads, so a cage edge coincides with its patches'
 * boundary exactly. `interior` = edges shared by two quads (the quilt's seams), `boundary` = the outer rim
 * (an edge on a single quad), so the outline can draw a distinct colour. `adj` defaults to a fresh build but
 * the caller can pass one it already has.
 */
export function meshCageEdges(mesh: QuadMesh, eh: EdgeHandle, adj: MeshAdjacency = meshAdjacency(mesh), seg = 6):
  { interior: number[]; boundary: number[] } {
  const P = (id: number): V3 => readVertex(mesh.vertices, id);
  const interior: number[] = [], boundary: number[] = [];
  for (let a = 0; a < adj.neighbors.length; a++) {
    for (const b of adj.neighbors[a]) {
      if (b < a) continue; // each undirected edge once
      const quads = adj.edgeQuads.get(ekey(a, b)) ?? [];
      const Pa = P(a), Pb = P(b);
      pushCubicEdge(quads.length >= 2 ? interior : boundary, Pa, add(Pa, eh(a, b)), add(Pb, eh(b, a)), Pb, seg);
    }
  }
  return { interior, boundary };
}

/** The degenerate cage of an authored polygon MODEL (`doc.linearCage`): every handle is chord/3 — no
 *  Bessel, no overrides — so every patch boundary is the straight edge. Stored curvature channels are
 *  deliberately ignored; models never persist them. Pair with `bilinearTwist` for the exact interior. */
export function linearEdgeHandles(mesh: QuadMesh): EdgeHandle {
  const P = (i: number): V3 => readVertex(mesh.vertices, i);
  return (from, to) => mul(sub(P(to), P(from)), 1 / 3);
}

/**
 * The extraordinary interior POLES of a quad mesh: an interior vertex (every incident edge shared by two
 * quads) whose incident-quad fan is not four. They are the vertices whose automatic handles are fitted to a
 * shared tangent plane instead of an axis, which is what makes them the one place a corner's handle reads
 * further than its own edges — see `meshEdgeHandles` above, and the dependency radius in `incremental.ts`.
 *
 * Derived from the topology alone, so it is cached against the adjacency it was read from: the same index
 * serves every handle provider built over one topology, and turns over with it when a mesh op hands back
 * fresh arrays.
 */
const poleSets = new WeakMap<MeshAdjacency, Set<number>>();
export function extraordinaryPoles(adj: MeshAdjacency): ReadonlySet<number> {
  const cached = poleSets.get(adj);
  if (cached) return cached;
  const { neighbors, edgeQuads } = adj;
  const poles = new Set<number>();
  for (let id = 0; id < neighbors.length; id++) {
    const incident = neighbors[id];
    if (incident.length < 3 || !incident.every(nb => (edgeQuads.get(ekey(id, nb)) ?? []).length === 2)) continue;
    const quads = new Set<number>();
    for (const nb of incident) for (const quad of edgeQuads.get(ekey(id, nb)) ?? []) quads.add(quad);
    if (quads.size !== 4) poles.add(id);
  }
  poleSets.set(adj, poles);
  return poles;
}

/** The interior twist that makes a flat-cage quad the EXACT bilinear (doubly-ruled) surface of its
 *  corners: degree-elevating S(u,v) = ΣAB­CD·(1−u,u)(1−v,v) puts each interior CP T/9 PAST the zero-twist
 *  Ferguson prediction, where T = A − B − C + D is the bilinear's constant mixed partial (zero only on a
 *  parallelogram — zero-twist alone is NOT flat on a non-planar quad). Order [A,B,C,D] matches
 *  `quadControlPoints`' twist argument; the formula holds for the collapsed wedge too. */
export function bilinearTwist(mesh: QuadMesh, quad: number): [V3, V3, V3, V3] {
  const [ai, bi, ci, di] = mesh.quads[quad];
  const P = (i: number): V3 => readVertex(mesh.vertices, i);
  const A = P(ai), B = P(bi), C = P(ci), D = P(di);
  const T: V3 = [(A[0] - B[0] - C[0] + D[0]) / 9, (A[1] - B[1] - C[1] + D[1]) / 9, (A[2] - B[2] - C[2] + D[2]) / 9];
  const N: V3 = [-T[0], -T[1], -T[2]];
  return [T, N, N, T];
}

/** The handle provider a doc's evaluation mode selects: linear for a model's flat cage, Bessel+overrides
 *  for the mountain. Every derivation path (preview, ops, cage, export) routes through this choice.
 *  `adj` lets a caller that already holds the mesh's adjacency skip rebuilding it — the incremental preview
 *  rebuilds a handle provider per change, and the topology it reads has not moved. */
export function docEdgeHandles(mesh: QuadMesh, doc: QuadMeshDoc, adj?: MeshAdjacency): EdgeHandle {
  return doc.linearCage ? linearEdgeHandles(mesh) : meshEdgeHandles(mesh, doc.edgeHandles, adj ?? meshAdjacency(mesh));
}

/** A mesh doc's renderable form: the QuadMesh + its directed-edge handle provider (overrides + Bessel). */
export function meshFromDoc(doc: QuadMeshDoc): { mesh: QuadMesh; edgeHandle: EdgeHandle } {
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  return { mesh, edgeHandle: docEdgeHandles(mesh, doc) };
}

/** Per-vertex adjacency of a quad mesh: incident neighbour vertex ids, and (undirected edge → its quads)
 *  for the opposite-edge test. Built once and shared by the neighbour-ring queries below. */
export interface MeshAdjacency {
  neighbors: number[][];
  edgeQuads: Map<string, number[]>;
}
export function meshAdjacency(mesh: QuadMesh): MeshAdjacency {
  const nbr: Set<number>[] = Array.from({ length: mesh.vertexCount }, () => new Set<number>());
  const edgeQuads = new Map<string, number[]>();
  for (let q = 0; q < mesh.quads.length; q++) {
    const [A, B, C, D] = mesh.quads[q];
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
      if (a === b) continue; // a wedge's collapsed D–C side (docs/017): no self-edge, no self-neighbour
      nbr[a].add(b); nbr[b].add(a);
      const k = ekey(a, b);
      let arr = edgeQuads.get(k); if (!arr) { arr = []; edgeQuads.set(k, arr); }
      arr.push(q);
    }
  }
  for (const [a, b] of mesh.freeEdges) {
    if (a === b || a < 0 || b < 0 || a >= mesh.vertexCount || b >= mesh.vertexCount) continue;
    nbr[a].add(b); nbr[b].add(a);
    if (!edgeQuads.has(ekey(a, b))) edgeQuads.set(ekey(a, b), []);
  }
  return { neighbors: nbr.map(s => [...s]), edgeQuads };
}

/** The incident neighbour vertex ids of `id` (the sculpt-smooth ring). */
export function vertexNeighbors(adj: MeshAdjacency, id: number): number[] {
  return adj.neighbors[id] ?? [];
}

/** Ordinary topological valence: the number of unique control-net edges incident to a vertex. Shared by
 * authored and reference selection details so both surfaces report the same quantity. */
export function vertexValence(adj: MeshAdjacency, id: number): number {
  return vertexNeighbors(adj, id).length;
}

/**
 * The two surface AXES through vertex `id`: each a pair of opposite neighbour vertex ids `[a, b]` (−1 where
 * the net ends), pairing each incident edge with the one sharing NO quad with it — the same opposite-edge
 * rule the tangent uses. At a regular valence-4 vertex the pairs are exactly the grid's row axis (id∓cols)
 * and column axis (id∓1), so on a promoted grid this reproduces the old central-difference frame; at a rim
 * one side of an axis is −1 (one-sided); at a 3/5 pole the leftover edges fall into an axis unpaired. Feeds
 * the gizmo surface frame + the ratio-preserving slide (the generalisation of viewport's idx±cols/idx±1).
 */
export function vertexAxes(adj: MeshAdjacency, id: number): { u: [number, number]; v: [number, number] } {
  const nbrs = adj.neighbors[id] ?? [];
  const qsOf = (x: number) => adj.edgeQuads.get(ekey(id, x)) ?? [];
  const axes: [number, number][] = [];
  const used = new Set<number>();
  for (const x of nbrs) {
    if (used.has(x)) continue;
    used.add(x);
    let opp = -1;
    for (const y of nbrs) {
      if (y === x || used.has(y)) continue;
      if (!qsOf(x).some(q => qsOf(y).includes(q))) { opp = y; break; } // shares no quad with x → its opposite
    }
    if (opp >= 0) used.add(opp);
    axes.push([x, opp]);
  }
  return { u: axes[0] ?? [-1, -1], v: axes[1] ?? [-1, -1] };
}

/**
 * The surface tangent frame at vertex `id`: two axis tangents `tu` / `tv` (central difference over the axis
 * neighbours, one-sided at a rim) and a SKYWARD normal `n` (their cross, flipped to +Y for the heightfield
 * convention). The general form of viewport's `cornerFrame` / mountain's `cornerNormal` (identical up to the
 * axis labelling on a regular grid). Drives the Edit gizmo's Surface frame + slide and the sculpt brush's
 * along-normal push. `pos` is the flat xyz vertex buffer (doc `vertices` / `corners`).
 */
export function vertexFrame(pos: number[], adj: MeshAdjacency, id: number): { tu: V3; tv: V3; n: V3 } {
  const P = (i: number): V3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const axisVec = ([a, b]: [number, number]): V3 =>
    a >= 0 && b >= 0 ? sub(P(b), P(a)) : b >= 0 ? sub(P(b), P(id)) : a >= 0 ? sub(P(id), P(a)) : [0, 0, 0];
  const { u, v } = vertexAxes(adj, id);
  const tu = axisVec(u), tv = axisVec(v);
  let n = cross(tv, tu);
  if (n[1] < 0) n = [-n[0], -n[1], -n[2]]; // skyward (heightfield convention)
  return { tu, tv, n: norm(n) };
}

/**
 * A 2-colouring of the quads (0/1) over quad adjacency, for the preview's checkerboard shade - the
 * topology-general form of the grid's `(row+col)%2`, which it reproduces (up to a global flip) on a
 * bipartite grid. Purely cosmetic: a mesh with an odd adjacency cycle (possible around a pole) just gets
 * one arbitrary seam where equal colours touch. Flood-fills each connected component from its first quad.
 */
export function quadParity(mesh: QuadMesh): number[] {
  const topo = mesh.topology;
  const color = new Array<number>(mesh.quadCount).fill(-1);
  for (let seed = 0; seed < mesh.quadCount; seed++) {
    if (color[seed] >= 0) continue;
    color[seed] = 0;
    const stack = [seed];
    while (stack.length) {
      const q = stack.pop()!;
      for (const e of topo.cellEdges[q]) {
        for (const nb of topo.edgeCells[e] ?? []) {
          if (nb !== q && color[nb] < 0) { color[nb] = color[q] ^ 1; stack.push(nb); }
        }
      }
    }
  }
  return color;
}
