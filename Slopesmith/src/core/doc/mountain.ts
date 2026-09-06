import type { CoursePath, CourseKnot, MountainMeta, PaintMap, TexPaintMap, QuadMeshDoc, V3 } from './types';
import { normalizeEnvironmentBed } from '../audio/environment';
import { ensureGemIds, ensureLightIds, ensureScreenIds, seedMeshIds } from './ids';
import { keyMountainByIndex, storedById } from './serialize';
import { frameAt, sampleSpine, spineAt, totalLength, type SpineSample } from '../math/spine';
import { add, dot, lerp, mul, norm, sub } from '../math/vec';
import { clamp, smoothstep } from '../math/scalar';
import { directedEdgeKey, readVertex } from '../mesh/primitives';
import { patchNormal, type HandleDir } from '../math/bezier';
import {
  bilinearTwist, buildQuadMesh, docEdgeHandles, meshEdgeHandles, quadControlPoints, quadParity, meshAdjacency,
  vertexNeighbors, vertexAxes, vertexFrame, INTERIOR_CP,
  type QuadMesh, type EdgeHandle, type MeshAdjacency,
} from '../mesh/topology';
import type { TexRef } from '../paint/textures';
import { inferGeometricTJunctions, normalizeTJunctions } from '../mesh/t-junctions';
import { applyLoft } from '../mesh/loft';
import { surfaceHeightAt } from '../mesh/surface-height';
import { parseEffectsDocument, type EffectsDocument } from '../effects/document';
import { createEmptyEffectsDocument, ensurePlacedPropIds } from '../effects/authoring';
import { ensureRailIds } from '../rails/rails';
import { normalizeLabels } from './labels';
import { normalizeParticleVolumes } from '../particles/volumes';
import { normalizeRaceMusicArrangement } from '../music/arrangement';
import { normalizeBoardSound } from '../audio/board-sound';
import { normalizeCheckpointBonus, normalizeLaps } from './race';
import { courseSamples, seatSample } from './run-shaping';
import { edgeIsLocked, lockedEdgeSet, lockedVertexSet, quadIsLocked } from '../mesh/locks';

export type { HandleDir } from '../math/bezier';

/**
 * Sculpt mode: an editable bicubic-Bezier CONTROL NET (docs/006-surface-net.md). The document is a general
 * quad mesh (`QuadMeshDoc`); its vertices are patch corner control points in full 3D, so the surface can fold
 * into walls and overhangs rather than being a heightfield. It derives into the watertight quilt the bake
 * consumes (corners are shared between neighbouring patches -> watertight by construction; tangents default
 * to Bessel = smooth, with per-edge handle overrides as creases).
 *
 * Legacy saves migrate through a rows×cols `GridNet` and `meshFromNet` promotes them — the ONE seam past which
 * row/col addressing does not exist. New mountains are lofted directly from their course. Everything after
 * either entry path (edit tools, preview, export) speaks vertex and quad ids.
 *
 * The course is a path ON the surface: it exports the AIP line + start gate and seeds the ride. It grooves
 * the net only at seed / migration time (`seatCourse`), never live.
 *
 * Net orientation: rows along +X, cols along +Z, so the quilt's u x v cross points DOWN in editor space (the
 * bake's winding turns that into skyward normals - true while the net stays a heightfield; once overhangs
 * exist the bake winds by net orientation instead, see 006).
 */

/**
 * A rows×cols corner lattice: the BUILD-TIME form of a mountain surface, and the only place row/col
 * addressing survives. It remains only for legacy document migration; new terrain is built directly with
 * `buildMeshFromCourse`. `meshFromNet` promotes a migrated grid to the `QuadMeshDoc` the editor holds, saves
 * and exports. A grid never crosses that seam, so nothing downstream knows a row from a column.
 */
export interface GridNet {
  /** Corner-grid dimensions (rows along +X, cols along +Z) and parameter spacing, metres. */
  rows: number;
  cols: number;
  spacing: number;
  /** rows*cols*3 corner control points, full 3D editor metres, row-major (foldable). */
  corners: number[];
  /** Sparse tangent-handle overrides keyed "i,j:dir" (dir in u-/u+/v-/v+); absent => Bessel (smooth). */
  handles?: Record<string, V3>;
  /** SurfaceType per cell, keyed "r,c". */
  paint: PaintMap;
  /** Real-tile overrides per cell, keyed "r,c" — only a migrated grid save carries these. */
  texPaint?: TexPaintMap;
  /** Per-cell tile orientation (D4), keyed "r,c" — likewise. */
  texOrient?: Record<string, { rot: number; mirror: boolean }>;
}

/** A GridNet cell's paint key. */
const cellKey = (row: number, col: number) => `${row},${col}`;

/** Just the corner lattice — what cornerAt / baseHeightAt read. A generator holds one of these before its
 *  doc exists (the starter run is sampled off the net it will carry). */
export type CornerNet = Pick<GridNet, 'rows' | 'cols' | 'spacing' | 'corners'>;

export const cornerAt = (doc: CornerNet, r: number, c: number): V3 => {
  const i = (r * doc.cols + c) * 3;
  return [doc.corners[i], doc.corners[i + 1], doc.corners[i + 2]];
};

/** Surface height at (x, z) sampled from the corner grid's Y, bilinear (used for seeding / snapping;
 *  assumes a roughly heightfield net, which the generators and migration produce). */
export function baseHeightAt(doc: CornerNet, x: number, z: number): number {
  const fr = Math.max(0, Math.min(doc.rows - 1.001, x / doc.spacing));
  const fc = Math.max(0, Math.min(doc.cols - 1.001, z / doc.spacing));
  const r = Math.floor(fr), c = Math.floor(fc);
  const tr = fr - r, tc = fc - c;
  const y00 = cornerAt(doc, r, c)[1], y01 = cornerAt(doc, r, c + 1)[1];
  const y10 = cornerAt(doc, r + 1, c)[1], y11 = cornerAt(doc, r + 1, c + 1)[1];
  return (y00 * (1 - tc) + y01 * tc) * (1 - tr) + (y10 * (1 - tc) + y11 * tc) * tr;
}

// ---- ribbon seat (one-shot: deform the net to the run's cross-section, at seed/migration/on demand) ----

/**
 * Seat the run into the net once: deform corner heights toward the ribbon's cross-section (a banked,
 * walled channel laid into the hill) and paint the floor strip. Walls/banks/width come from the knots.
 *
 * A seed step, not an editor op: it runs on the build-time GridNet, inside the starter-course generator
 * (makeMountain) and the legacy-carve migration, before `meshFromNet` promotes it to the quad mesh the
 * editor holds. Past that promotion the net is the terrain's only shape, edited corner-wise in Edit / Sculpt.
 */
export function seatCourse(doc: GridNet, course: CoursePath, subsamples = 4, footprintCells = 1.2) {
  const cs = courseSamples(course);
  if (!cs) return;

  // Antialias the seat. The cross-section's wall + edges are far finer than the grid spacing, so a
  // diagonal run sampled one point per corner staircases - its wall iso-lines jump cell to cell. Average
  // each corner's seated height over a cell-sized footprint (a box low-pass at the grid frequency) so the
  // wall lands as a smooth ramp the bicubic net holds cleanly. This is the relax-by-hand pass that already
  // fixes it, baked in: a wall can be no crisper than the grid here, but it is now continuously smooth. A
  // crisp *and* smooth wall at any angle is the run-as-its-own-surface path (006 S5). (seatSample reads the
  // precomputed spine samples, not doc.corners, so mutating heights in place mid-loop is safe.)
  const N = Math.max(1, subsamples);        // NxN subsamples per corner (1 = legacy one-point seat)
  const R = doc.spacing * footprintCells / 2; // half-window (footprintCells wide) -> the box low-pass width
  const at = (k: number) => N === 1 ? 0 : (k / (N - 1) - 0.5) * 2 * R; // even spread across [-R, +R]
  for (let r = 0; r < doc.rows; r++) {
    for (let c = 0; c < doc.cols; c++) {
      const p = cornerAt(doc, r, c);
      let sum = 0, hit = false;
      for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
        const seat = seatSample(cs, p[0] + at(a), p[2] + at(b));
        if (seat) hit = true;
        sum += seat ? seat.y * seat.t + p[1] * (1 - seat.t) : p[1];
      }
      if (hit) doc.corners[(r * doc.cols + c) * 3 + 1] = sum / (N * N); // leave corners no run reaches
    }
  }
  const cellCols = doc.cols - 1;
  for (let r = 0; r < doc.rows - 1; r++) {
    for (let c = 0; c < cellCols; c++) {
      const seat = seatSample(cs, (r + 0.5) * doc.spacing, (c + 0.5) * doc.spacing);
      if (seat && seat.onFloor) doc.paint[cellKey(r, c)] = seat.surface;
    }
  }
}

// ---- derive: the net -> QuadMesh the preview / export consume (the topology-general path) ----

/**
 * The authored net as a general QuadMesh plus the directed-edge handles + per-quad appearance the preview and
 * the export both read (docs/006). Consumers only call the per-quad accessors below and `quadControlPoints`,
 * so they are blind to the net's topology — a promoted lattice and a hand-poled mesh read the same.
 */
export interface DerivedQuadMesh {
  mesh: QuadMesh;
  /** Directed-edge tangent handle; feeds topology.ts `quadControlPoints`. */
  edgeHandle: EdgeHandle;
  /** SurfaceType per quad (paint over base). */
  surfOf: (q: number) => number;
  /** Painted real tile per quad, or null to show the SurfaceType's procedural tile. */
  texOf: (q: number) => TexRef | null;
  /** Painted D4 tile orientation per quad, or null. */
  orientOf: (q: number) => { rot: number; mirror: boolean } | null;
  /** Per-quad interior twist offsets ([A,B,C,D] for cp5/6/9/10), or null for pure zero-twist — feeds
   *  topology.ts `quadControlPoints`. Null for a quad with no interior sculpt (`quadTwist`). */
  twistOf: (q: number) => readonly V3[] | null;
  /** Checkerboard parity (0/1) per quad, for the preview shade (cosmetic). */
  parity: (q: number) => number;
  /** The quad's stable id — what the export names a patch by and joins its ordinal to (docs/039). */
  id: (q: number) => string;
}

export function deriveQuadMesh(doc: QuadMeshDoc): DerivedQuadMesh {
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const edgeHandle = docEdgeHandles(mesh, doc);
  const parity = quadParity(mesh);
  return {
    mesh, edgeHandle,
    surfOf: (q) => doc.quadPaint?.[q] ?? doc.baseSurface,
    texOf: (q) => doc.quadTex?.[q] ?? null,
    orientOf: (q) => doc.quadOrient?.[q] ?? null,
    parity: (q) => parity[q],
    id: (q) => doc.quadIds[q],
    // a model's flat cage ignores stored twist and derives the BILINEAR interior — the exact ruled quad
    twistOf: (q) => doc.linearCage ? bilinearTwist(mesh, q) : doc.quadTwist?.[q] ?? null,
  };
}

/**
 * Promote a build-time `GridNet` into the `QuadMeshDoc` everything downstream holds — the ONE seam where
 * row/col addressing ends. Corners become vertices (index = r*cols + c, unchanged order), cells become quads
 * (r-major, so quad index = r*cellCols + c), each `u-/u+/v-/v+` handle becomes a directed-edge override
 * `"from>to"`, and paint / texPaint / texOrient re-key from `"r,c"` to the quad index. Every vertex and quad
 * is minted its stable id here, since a lattice carries none. Lossless, and it is what lets a later loop cut
 * write the poles and partial loops a rectangular `corners` array cannot hold.
 */
export function meshFromNet(net: GridNet, meta: Omit<MountainMeta, 'kind' | 'spacing'>): QuadMeshDoc {
  const doc = net;
  const { rows, cols } = doc;
  const cellCols = cols - 1, cellRows = rows - 1;
  const vertices = doc.corners.slice();
  const quads: number[][] = new Array(cellRows * cellCols);
  for (let r = 0; r < cellRows; r++) {
    for (let c = 0; c < cellCols; c++) {
      const A = r * cols + c;
      quads[r * cellCols + c] = [A, A + 1, A + cols, A + cols + 1];
    }
  }
  // handles "r,c:dir" -> directed edge "from>to" (the neighbour that dir points at)
  let edgeHandles: Record<string, V3> | undefined;
  if (doc.handles) {
    edgeHandles = {};
    for (const key in doc.handles) {
      const m = /^(\d+),(\d+):(u[-+]|v[-+])$/.exec(key);
      if (!m) continue;
      const r = +m[1], c = +m[2], dir = m[3];
      const tr = r + (dir === 'u+' ? 1 : dir === 'u-' ? -1 : 0); // the neighbour (tr, tc) this handle points at
      const tc = c + (dir === 'v+' ? 1 : dir === 'v-' ? -1 : 0);
      if (tr < 0 || tr >= rows || tc < 0 || tc >= cols) continue; // points off the net edge (a rim handle, not stored)
      edgeHandles[`${r * cols + c}>${tr * cols + tc}`] = doc.handles[key];
    }
    if (!Object.keys(edgeHandles).length) edgeHandles = undefined;
  }
  // per-cell maps "r,c" -> quad id (r*cellCols + c)
  const remap = <T>(src?: Record<string, T>): Record<number, T> | undefined => {
    if (!src) return undefined;
    const out: Record<number, T> = {}; let any = false;
    for (const k in src) {
      const m = /^(\d+),(\d+)$/.exec(k);
      if (!m) continue;
      out[+m[1] * cellCols + +m[2]] = src[k]; any = true;
    }
    return any ? out : undefined;
  };
  const { name, course, baseSurface, props, lights, rails, gems, labels, sun, skybox, raceMusic, raceMusicArrangement, environmentBed,
    boardSound, laps, aiSeed, effects, particleVolumes } = meta;
  return {
    kind: 'mountain', version: 5, name, spacing: net.spacing, course, baseSurface, props, lights, rails, gems, labels, sun,
    skybox, raceMusic, raceMusicArrangement, environmentBed, boardSound, laps, aiSeed, effects, particleVolumes,
    vertices, quads, ...seedMeshIds(0, vertices.length / 3, quads.length), edgeHandles, tJunctions: [],
    quadPaint: remap(doc.paint), quadTex: remap(doc.texPaint), quadOrient: remap(doc.texOrient),
  };
}

// ---- sculpt brushes (surface-space dabs + stable view-plane Grab gesture) ----

export type BrushOp = 'raise' | 'lower' | 'smooth' | 'flatten' | 'grab' | 'push';
/** Which way raise/lower pushes: straight up, or out of the slope face (build walls / overhangs). */
export type BrushDir = 'vertical' | 'normal';
/** How brush strength changes from its centre to the edge of its surface-space footprint. */
export type BrushFalloff = 'smooth' | 'linear' | 'sharp' | 'constant';
/** Plane used by Flatten: world-height, the exact hit tangent, or a weighted footprint-area estimate. */
export type FlattenMode = 'height' | 'surface' | 'area';
/** Whether a Flatten stroke keeps its press-time plane or resamples it under every dab. */
export type FlattenPlaneBehavior = 'locked' | 'follow';
export type FlattenBrushPlane = { point: V3; normal: V3 };

/** Strength multiplier at a normalized surface distance (0 = centre, 1 = footprint edge). */
export function brushFalloffWeight(falloff: BrushFalloff, normalizedDistance: number): number {
  const t = Math.max(0, Math.min(1, normalizedDistance));
  if (t >= 1) return 0;
  if (falloff === 'constant') return 1;
  if (falloff === 'linear') return 1 - t;
  if (falloff === 'sharp') return (1 - t) ** 2;
  const q = 1 - t * t;
  return q * q; // preserve the original smooth bell
}

/** Connected surface distance from a hit inside `seedQuad` to every editable corner, bounded by `radius`.
 * The control-net boundary edges plus both diagonals of each quad form a compact intrinsic-distance graph:
 * unlike the old XZ footprint it follows walls / folds in 3D and cannot jump to a disconnected surface stacked
 * over the same horizontal spot. Infinity means the corner lies outside this dab's connected radius. */
export function surfaceBrushDistances(doc: QuadMeshDoc, center: V3, radius: number, seedQuad: number): Float64Array {
  const count = doc.vertices.length / 3;
  const distance = new Float64Array(count); distance.fill(Infinity);
  const quad = doc.quads[seedQuad];
  if (!quad?.length || radius <= 0) return distance;

  const surfaceMesh = buildQuadMesh(doc.vertices, doc.quads);
  const neighbors = meshAdjacency(surfaceMesh).neighbors.map(row => row.slice());
  const link = (a: number, b: number) => {
    if (a === b || a < 0 || b < 0 || a >= count || b >= count) return;
    if (!neighbors[a].includes(b)) neighbors[a].push(b);
    if (!neighbors[b].includes(a)) neighbors[b].push(a);
  };
  // Boundary-only graph distance makes a square grid diamond-shaped. Both patch diagonals give the control
  // lattice its eight-neighbour approximation to a circular intrinsic footprint.
  for (const [A, B, C, D] of doc.quads) { link(A, D); link(B, C); }

  const point = (id: number): V3 => readVertex(doc.vertices, id);
  const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const heap: { id: number; d: number }[] = [];
  const push = (item: { id: number; d: number }) => {
    let i = heap.push(item) - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].d <= item.d) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = item;
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (true) {
        let child = i * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1].d < heap[child].d) child++;
        if (heap[child].d >= last.d) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return top;
  };

  for (const id of new Set(quad)) {
    if (id < 0 || id >= count) continue;
    const d = dist(center, point(id));
    if (d < radius && d < distance[id]) { distance[id] = d; push({ id, d }); }
  }
  while (heap.length) {
    const current = pop();
    if (current.d !== distance[current.id] || current.d >= radius) continue;
    const from = point(current.id);
    for (const id of neighbors[current.id]) {
      const d = current.d + dist(from, point(id));
      if (d < radius && d < distance[id]) { distance[id] = d; push({ id, d }); }
    }
  }
  return distance;
}

/** Frozen source positions + influence weights for one Grab gesture. The footprint is captured on press so
 * dragging a folded surface cannot change membership or accumulate error as the live preview rebuilds. */
export type GrabBrushState = { vertices: number[]; weights: Float64Array };

export function createGrabBrushState(
  doc: QuadMeshDoc, center: V3, radius: number, seedQuad: number, falloff: BrushFalloff,
): GrabBrushState {
  const distance = surfaceBrushDistances(doc, center, radius, seedQuad);
  const weights = new Float64Array(distance.length);
  const locked = lockedVertexSet(doc);
  if (radius > 0) for (let id = 0; id < distance.length; id++) {
    if (!locked.has(id) && distance[id] < radius) weights[id] = brushFalloffWeight(falloff, distance[id] / radius);
  }
  return { vertices: doc.vertices.slice(), weights };
}

/** Move a captured Grab footprint by the total pointer displacement. Every update evaluates from the press
 * snapshot rather than adding frame deltas, keeping the result independent of pointer-event frequency. */
export function applyGrabBrush(doc: QuadMeshDoc, state: GrabBrushState, delta: V3) {
  const count = Math.floor(Math.min(doc.vertices.length, state.vertices.length) / 3);
  const locked = lockedVertexSet(doc);
  for (let id = 0; id < count; id++) {
    const w = state.weights[id];
    if (w <= 0 || locked.has(id)) continue;
    const i = id * 3;
    doc.vertices[i] = state.vertices[i] + delta[0] * w;
    doc.vertices[i + 1] = state.vertices[i + 1] + delta[1] * w;
    doc.vertices[i + 2] = state.vertices[i + 2] + delta[2] * w;
  }
}

/** Shove the live connected footprint along one pointer-motion segment. Unlike Grab, membership is sampled
 * anew at every hit, so a stroke continuously picks up terrain as it travels. Motion is projected onto the
 * current hit tangent before falloff is applied; authored handles/twists stay as offsets and follow their
 * owning corners without losing the patch's finer Bezier shape. */
export function applyPushBrush(
  doc: QuadMeshDoc, center: V3, radius: number, seedQuad: number, falloff: BrushFalloff,
  strokeDelta: V3, hitNormal: V3, amount = 1,
) {
  const n = norm(hitNormal);
  const tangentDelta = sub(strokeDelta, mul(n, dot(strokeDelta, n)));
  const scale = Math.max(0, amount);
  if (radius <= 0 || scale <= 0 || Math.hypot(...tangentDelta) < 1e-12) return;
  const distance = surfaceBrushDistances(doc, center, radius, seedQuad);
  const locked = lockedVertexSet(doc);
  for (let id = 0; id * 3 + 2 < doc.vertices.length; id++) {
    const d = distance[id];
    if (d >= radius || locked.has(id)) continue;
    const w = scale * brushFalloffWeight(falloff, d / radius);
    if (w <= 0) continue;
    const i = id * 3;
    doc.vertices[i] += tangentDelta[0] * w;
    doc.vertices[i + 1] += tangentDelta[1] * w;
    doc.vertices[i + 2] += tangentDelta[2] * w;
  }
}

function flattenPlaneFromFootprint(
  doc: QuadMeshDoc, center: V3, radius: number, falloff: BrushFalloff, mode: FlattenMode, hitNormal: V3,
  surfaceDistance: Float64Array, adj: MeshAdjacency | null,
): FlattenBrushPlane {
  let point = center;
  let normal: V3 = mode === 'height' ? [0, 1, 0] : norm(hitNormal);
  if (mode !== 'area' || !adj) return { point, normal };

  const pos = doc.vertices;
  let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, total = 0;
  for (let id = 0; id * 3 + 2 < pos.length; id++) {
    const d = surfaceDistance[id];
    if (d >= radius) continue;
    const w = brushFalloffWeight(falloff, d / radius);
    if (w <= 0) continue;
    const i = id * 3;
    px += pos[i] * w; py += pos[i + 1] * w; pz += pos[i + 2] * w; total += w;
    let n = vertexFrame(pos, adj, id).n;
    if (dot(n, normal) < 0) n = mul(n, -1);
    nx += n[0] * w; ny += n[1] * w; nz += n[2] * w;
  }
  if (total > 1e-12) point = [px / total, py / total, pz / total];
  if (Math.hypot(nx, ny, nz) > 1e-12) normal = norm([nx, ny, nz]);
  return { point, normal };
}

/** Sample the target plane for a Flatten stroke. Store this result for locked/original-plane behavior. */
export function createFlattenBrushPlane(
  doc: QuadMeshDoc, center: V3, radius: number, seedQuad: number, falloff: BrushFalloff,
  mode: FlattenMode, hitNormal: V3,
): FlattenBrushPlane {
  const distance = surfaceBrushDistances(doc, center, radius, seedQuad);
  const adj = mode === 'area' ? meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges)) : null;
  return flattenPlaneFromFootprint(doc, center, radius, falloff, mode, hitNormal, distance, adj);
}

const pointAt = readVertex;

function projectControlPoint(point: V3, plane: FlattenBrushPlane, factor: number): V3 {
  const offset = dot(sub(point, plane.point), plane.normal) * factor;
  return sub(point, mul(plane.normal, offset));
}

/** Flatten the effective bicubic cage, not just its four shared corners. Boundary controls are written once
 * through their directed-edge identity and interiors are written after corners/handles, so the document's
 * dependency representation still reconstructs the exact projected 16-point patch. */
function flattenControlCage(
  doc: QuadMeshDoc, surfaceDistance: Float64Array, radius: number, falloff: BrushFalloff,
  plane: FlattenBrushPlane, amount: number,
) {
  const beforeMesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const beforeHandle = meshEdgeHandles(beforeMesh, doc.edgeHandles);
  const lockedVertices = lockedVertexSet(doc);
  const factor = (vertex: number) => {
    if (lockedVertices.has(vertex)) return 0;
    const d = surfaceDistance[vertex];
    return d < radius ? Math.min(1, amount * brushFalloffWeight(falloff, d / radius)) : 0;
  };

  const vertices: { id: number; pos: V3 }[] = [];
  for (let id = 0; id < beforeMesh.vertexCount; id++) {
    const f = factor(id);
    if (f > 0) vertices.push({ id, pos: projectControlPoint(pointAt(doc.vertices, id), plane, f) });
  }

  const edges = new Map<string, { from: number; to: number; pos: V3 }>();
  const addEdge = (from: number, to: number) => {
    if (from === to || factor(from) <= 0) return;
    const key = `${from}>${to}`;
    if (edges.has(key)) return;
    const control = add(pointAt(doc.vertices, from), beforeHandle(from, to));
    edges.set(key, { from, to, pos: projectControlPoint(control, plane, factor(from)) });
  };
  for (const [A, B, C, D] of doc.quads) {
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
      addEdge(a, b); addEdge(b, a);
    }
  }

  const interiors: { quad: number; corner: 0 | 1 | 2 | 3; pos: V3 }[] = [];
  for (let quad = 0; quad < doc.quads.length; quad++) {
    const corners = doc.quads[quad];
    const cp = quadControlPoints(beforeMesh, beforeHandle, quad, doc.quadTwist?.[quad] ?? null);
    for (let corner = 0 as 0 | 1 | 2 | 3; corner < 4; corner = (corner + 1) as 0 | 1 | 2 | 3) {
      const f = factor(corners[corner]);
      if (f > 0) interiors.push({ quad, corner, pos: projectControlPoint(cp[INTERIOR_CP[corner]], plane, f) });
    }
  }

  // Dependency order: absolute corners, boundary controls relative to their moved owners, then interiors
  // relative to the final zero-twist cage.
  for (const target of vertices) {
    const i = target.id * 3;
    doc.vertices[i] = target.pos[0]; doc.vertices[i + 1] = target.pos[1]; doc.vertices[i + 2] = target.pos[2];
  }
  for (const target of edges.values()) {
    meshSetHandle(doc, target.from, target.to, sub(target.pos, pointAt(doc.vertices, target.from)));
  }
  if (interiors.length) {
    const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
    const handle = meshEdgeHandles(mesh, doc.edgeHandles);
    for (const target of interiors) {
      const base = quadControlPoints(mesh, handle, target.quad)[INTERIOR_CP[target.corner]];
      meshSetTwist(doc, target.quad, target.corner, sub(target.pos, base));
    }
  }
}

/** Smooth is shape-aware: corners relax from a frozen snapshot, while authored crease/interior deviations
 * fade toward the newly derived automatic Ferguson cage. It never treats neighbouring patch interiors as a
 * fine triangle mesh, and sparse overrides disappear again once their residual reaches zero.
 *
 * The creases under the brush are reached through the mesh's own adjacency rather than by taking their keys
 * apart: a handle key is only ever written, so a crease never depends on the shape of its own key (docs/039). */
function relaxSmoothDetail(
  doc: QuadMeshDoc, surfaceDistance: Float64Array, radius: number, falloff: BrushFalloff, amount: number,
  adj: MeshAdjacency,
) {
  const lockedVertices = lockedVertexSet(doc), lockedEdges = lockedEdgeSet(doc);
  const smoothFactor = (vertex: number) => {
    if (lockedVertices.has(vertex)) return 0;
    const d = surfaceDistance[vertex];
    return d < radius ? Math.min(1, amount * brushFalloffWeight(falloff, d / radius)) : 0;
  };
  if (doc.edgeHandles) {
    const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
    const automatic = meshEdgeHandles(mesh);
    for (let from = 0; from < mesh.vertexCount; from++) {
      const f = smoothFactor(from);
      if (f <= 0) continue;
      for (const to of adj.neighbors[from] ?? []) {
        if (edgeIsLocked(doc, from, to, lockedEdges)) continue;
        const key = edgeKey(from, to), stored = doc.edgeHandles[key];
        if (stored === undefined) continue;
        const target = automatic(from, to), next = lerp(stored, target, f);
        if (Math.hypot(next[0] - target[0], next[1] - target[1], next[2] - target[2]) < 1e-9) {
          delete doc.edgeHandles[key];
        } else doc.edgeHandles[key] = next;
      }
    }
    if (!Object.keys(doc.edgeHandles).length) doc.edgeHandles = undefined;
  }
  if (doc.quadTwist) {
    for (const key of Object.keys(doc.quadTwist)) {
      const quad = +key, corners = doc.quads[quad], twist = doc.quadTwist[quad];
      if (!corners || !twist || quadIsLocked(doc, quad)) continue;
      for (let corner = 0; corner < 4; corner++) {
        const f = smoothFactor(corners[corner]);
        if (f > 0) twist[corner] = mul(twist[corner], 1 - f);
      }
      if (twist.every(v => Math.hypot(v[0], v[1], v[2]) < 1e-9)) delete doc.quadTwist[quad];
    }
    if (!Object.keys(doc.quadTwist).length) doc.quadTwist = undefined;
  }
}

/**
 * Apply one brush dab to the authored control net at surface `center`, seeded by the tessellated hit's quad.
 * raise/lower push each corner under the
 * brush by `strength·falloff` - vertically, or along its local surface normal so the brush works on a
 * wall face and can pull an overhang. smooth relaxes corners toward their 3D neighbour average (folds
 * included); flatten projects toward a horizontal, hit-tangent, or footprint-area plane.
 * `surfaceBrushDistances` supplies the connected 3D footprint, so walls and overhangs use real surface travel
 * instead of horizontal projection.
 * Raise/lower remain broad corner-shape operations (dependent controls follow while authored detail offsets
 * survive); Flatten projects the effective 16-point cages; Smooth relaxes corners plus explicit detail.
 * Normals + smoothing come from the mesh's own adjacency, so a pole is no special case.
 */
export function applyBrush(
  doc: QuadMeshDoc, op: BrushOp, center: V3, radius: number, strength: number, dir: BrushDir = 'vertical',
  seedQuad = -1, falloff: BrushFalloff = 'smooth', flattenMode: FlattenMode = 'height',
  hitNormal: V3 = [0, 1, 0], lockedFlattenPlane: FlattenBrushPlane | null = null,
  smoothAmount = 0.5, flattenAmount = 0.35,
) {
  if (op === 'grab' || op === 'push') return; // Gesture brushes use their dedicated displacement functions.
  const pos = doc.vertices;
  const lockedVertices = lockedVertexSet(doc);
  const surfaceDistance = surfaceBrushDistances(doc, center, radius, seedQuad);
  const needsAdj = op === 'smooth' || (dir === 'normal' && (op === 'raise' || op === 'lower'))
    || (op === 'flatten' && flattenMode === 'area');
  const adj = needsAdj ? meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges)) : null;
  const flattenPlane = lockedFlattenPlane ?? (op === 'flatten'
    ? flattenPlaneFromFootprint(doc, center, radius, falloff, flattenMode, hitNormal, surfaceDistance, adj)
    : { point: center, normal: [0, 1, 0] as V3 });
  if (op === 'flatten') {
    flattenControlCage(doc, surfaceDistance, radius, falloff, flattenPlane, Math.max(0, flattenAmount));
    return;
  }
  if (op === 'smooth' && adj) {
    const before = pos.slice();
    for (let id = 0; id * 3 + 2 < pos.length; id++) {
      const d = surfaceDistance[id];
      if (d >= radius || lockedVertices.has(id)) continue;
      const w = brushFalloffWeight(falloff, d / radius);
      let sx = 0, sy = 0, sz = 0, count = 0;
      for (const nb of vertexNeighbors(adj, id)) {
        sx += before[nb * 3]; sy += before[nb * 3 + 1]; sz += before[nb * 3 + 2]; count++;
      }
      if (!count) continue;
      const i = id * 3, f = Math.min(1, Math.max(0, smoothAmount) * w);
      pos[i] += (sx / count - before[i]) * f;
      pos[i + 1] += (sy / count - before[i + 1]) * f;
      pos[i + 2] += (sz / count - before[i + 2]) * f;
    }
    relaxSmoothDetail(doc, surfaceDistance, radius, falloff, Math.max(0, smoothAmount), adj);
    return;
  }
  for (let id = 0; id * 3 + 2 < pos.length; id++) {
    const i = id * 3;
    const d = surfaceDistance[id];
    if (d >= radius || lockedVertices.has(id)) continue;
    const w = brushFalloffWeight(falloff, d / radius);
    if (op === 'raise' || op === 'lower') {
      const s = (op === 'raise' ? 1 : -1) * strength * w;
      if (dir === 'normal' && adj) {
        const n = vertexFrame(pos, adj, id).n;
        pos[i] += n[0] * s; pos[i + 1] += n[1] * s; pos[i + 2] += n[2] * s;
      } else {
        pos[i + 1] += s;
      }
    }
  }
}

// ---- tangent handles & creases: directed-edge overrides on the mesh (pull a handle; crease for a kink) ----

export const HANDLE_DIRS: HandleDir[] = ['u-', 'u+', 'v-', 'v+'];
const edgeKey = directedEdgeKey;
const vpos = readVertex;

/** A mesh vertex's four axis-neighbour vertex ids as u-/u+/v-/v+ slots (-1 where the net ends) - the
 *  general form of the grid's directional handles. At a regular valence-4 vertex these are the two opposite
 *  edge pairs; the Edit nub UI keys on these slots (a pole leaves some slots empty, refined with loop-cut). */
export function meshDirNeighbors(adj: MeshAdjacency, id: number): Record<HandleDir, number> {
  const { u, v } = vertexAxes(adj, id);
  return { 'u-': u[0], 'u+': u[1], 'v-': v[0], 'v+': v[1] };
}

/** True if the vertex has any pulled directed-edge handle (so the UI can offer "smooth"). */
export function meshVertexHasHandles(doc: QuadMeshDoc, adj: MeshAdjacency, id: number): boolean {
  return !!doc.edgeHandles && (adj.neighbors[id] ?? []).some(nb => doc.edgeHandles![edgeKey(id, nb)] !== undefined);
}

/** An interior vertex whose incident surface fan is not the regular four-quad/four-edge grid case. */
export function meshVertexIsExtraordinary(adj: MeshAdjacency, id: number): boolean {
  const neighbors = adj.neighbors[id] ?? [];
  if (neighbors.length < 3 || !neighbors.every(nb => (adj.edgeQuads.get(id < nb ? `${id},${nb}` : `${nb},${id}`) ?? []).length === 2)) return false;
  const quads = new Set<number>();
  for (const nb of neighbors) for (const quad of adj.edgeQuads.get(id < nb ? `${id},${nb}` : `${nb},${id}`) ?? []) quads.add(quad);
  return quads.size !== 4;
}

/** Smooth is useful either to clear authored handles or to synthesize the tangent fan an extraordinary pole
 * cannot derive from a unique opposite neighbor. */
export function meshVertexCanSmooth(doc: QuadMeshDoc, adj: MeshAdjacency, id: number): boolean {
  return meshVertexHasHandles(doc, adj, id) || meshVertexIsExtraordinary(adj, id);
}

/** Pin one directed-edge handle to an offset (the editor calls this while dragging a nub). */
export function meshSetHandle(doc: QuadMeshDoc, from: number, to: number, offset: V3) {
  if (doc.quadLocked && edgeIsLocked(doc, from, to)) return;
  (doc.edgeHandles ??= {})[edgeKey(from, to)] = offset;
}

/** Pin one interior twist offset: quad `quad`, corner slot 0/1/2/3 = A/B/C/D, the offset added to that
 *  corner's interior CP (cp5/6/9/10) PAST the zero-twist position (the editor calls this while dragging an
 *  interior handle). Seeds the quad's four-corner tuple to zeros on first touch so the other three stay put. */
export function meshSetTwist(doc: QuadMeshDoc, quad: number, corner: number, offset: V3) {
  if (quadIsLocked(doc, quad)) return;
  const map = (doc.quadTwist ??= {});
  const tup = map[quad] ?? ([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] as [V3, V3, V3, V3]);
  tup[corner] = offset;
  map[quad] = tup;
}

/** Crease the mesh vertices `ids`: pin each incident edge's handle to the one-sided chord toward its
 *  neighbour, so the smooth (Bessel) collinearity breaks and the surface kinks - a sharp wall-top / lip. */
export function meshCreaseVertices(doc: QuadMeshDoc, ids: number[]) {
  const adj = meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges));
  const h = (doc.edgeHandles ??= {});
  const lockedEdges = lockedEdgeSet(doc);
  for (const id of ids) {
    const p = vpos(doc.vertices, id);
    for (const nb of adj.neighbors[id] ?? []) {
      if (edgeIsLocked(doc, id, nb, lockedEdges)) continue;
      const q = vpos(doc.vertices, nb);
      h[edgeKey(id, nb)] = [(q[0] - p[0]) / 3, (q[1] - p[1]) / 3, (q[2] - p[2]) / 3];
    }
  }
}

/** Smooth the mesh vertices `ids`: drop their incident overrides. Regular/rim vertices return to Bessel;
 * extraordinary poles return to meshEdgeHandles' shared one-ring tangent plane. */
export function meshSmoothVertices(doc: QuadMeshDoc, ids: number[]) {
  if (!doc.edgeHandles) return;
  const adj = meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges));
  const lockedEdges = lockedEdgeSet(doc);
  for (const id of ids) for (const nb of adj.neighbors[id] ?? []) {
    if (!edgeIsLocked(doc, id, nb, lockedEdges)) delete doc.edgeHandles[edgeKey(id, nb)];
  }
  if (!Object.keys(doc.edgeHandles).length) doc.edgeHandles = undefined;
}

/** Reset selected patches to their automatic control shape without moving any corner: every selected patch
 *  corner returns to Bessel boundary handles, and the patches' four interior twist offsets are cleared. */
export function meshResetShape(doc: QuadMeshDoc, quads: number[]) {
  const corners = new Set<number>();
  const editable = quads.filter(q => !quadIsLocked(doc, q));
  for (const q of editable) for (const v of doc.quads[q] ?? []) corners.add(v);
  meshSmoothVertices(doc, [...corners]);
  if (!doc.quadTwist) return;
  for (const q of editable) delete doc.quadTwist[q];
  if (!Object.keys(doc.quadTwist).length) doc.quadTwist = undefined;
}

// ---- generators ----

/** Deterministic value noise (integer-lattice hash, smoothstep-interpolated). */
function noise2(x: number, z: number): number {
  const h = (ix: number, iz: number) => {
    let n = ix * 374761393 + iz * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return (((n ^ (n >> 16)) >>> 0) % 10000) / 10000;
  };
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smoothstep(x - ix), fz = smoothstep(z - iz);
  const a = h(ix, iz), b = h(ix + 1, iz), c = h(ix, iz + 1), d = h(ix + 1, iz + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

const clampN = clamp;

export const DEFAULT_COURSE_HEIGHT_M = 1500;

/** Vertical extent of a course, matching the reference panel's maxY − minY "drop" readout. */
export function courseHeight(line: CoursePath): number {
  if (!line.knots.length) return 0;
  const ys = line.knots.map(k => k.pos[1]);
  return Math.max(...ys) - Math.min(...ys);
}

/**
 * A Gari-shaped editable top-to-bottom course used by New mountain before the shared loft generator runs.
 * Retail courses consistently read from the high/max-X,max-Z corner to the low/min-X,min-Z corner in course
 * profile view. Keep those endpoints exact, while the generation seed varies the interior line through the box.
 */
export function starterCourse(heightM = DEFAULT_COURSE_HEIGHT_M, widthM = 400, seed = 1): CoursePath {
  const height = clampN(heightM, 50, 6000), width = clampN(widthM, 30, 3000);
  const seedN = Math.abs(Math.trunc(seed)) % 0x80000000;
  // Normalised samples from Gari's overall course profile. X and Z descend at different rates, creating the
  // long traverses and direction changes of the retail line instead of a symmetric sine down one axis.
  const profile = [
    [1, 0, 1], [0.94, 0.10, 0.91], [0.94, 0.20, 0.76], [0.81, 0.33, 0.65],
    [0.68, 0.48, 0.48], [0.61, 0.57, 0.37], [0.32, 0.65, 0.37], [0.13, 0.77, 0.29],
    [0.11, 0.86, 0.12], [0, 1, 0],
  ] as const;
  const xSpan = height * 0.68, zSpan = height;
  const knots: CourseKnot[] = profile.map(([baseX, baseDrop, baseZ], i) => {
    const endpoint = i === 0 || i === profile.length - 1;
    const jitter = (salt: number) => noise2(i * 13.17 + seedN * 0.001 + salt, seedN * 0.013 + salt * 7.31) - 0.5;
    const x = endpoint ? baseX : clampN(baseX + jitter(3) * 0.12, 0.04, 0.96);
    const z = endpoint ? baseZ : clampN(baseZ + jitter(7) * 0.12, 0.04, 0.96);
    const drop = endpoint ? baseDrop : clampN(baseDrop + jitter(11) * 0.05, 0.04, 0.96);
    return {
      // Start at the box's high corner (0,0,0), finish at its opposite low corner.
      pos: [-xSpan * (1 - x), -height * drop, -zSpan * (1 - z)] as V3,
      width, wall: 0, bank: 0, shoulder: 8,
    };
  });
  return { knots, blend: 30, surface: 1 };
}

/** Pitch of a blank mountain's guide run, degrees — a steady rideable grade, gentler than a black run. */
export const DEFAULT_BLANK_SLOPE_DEG = 25;

/**
 * A straight fall-line course: the ONLY thing a blank mountain starts with. It descends at a constant pitch
 * through empty space, so it reads as a guide line to build patches along rather than terrain in its own
 * right. The retail course-profile convention `starterCourse` follows is kept — start at the high/max-X,max-Z
 * corner of its box, finish at the opposite low corner — so a blank mountain frames and exports like any other.
 */
export function straightCourse(
  heightM = DEFAULT_COURSE_HEIGHT_M, widthM = 400, slopeDeg = DEFAULT_BLANK_SLOPE_DEG,
): CoursePath {
  const height = clampN(heightM, 50, 6000), width = clampN(widthM, 30, 3000);
  const run = height / Math.tan((clampN(slopeDeg, 5, 60) * Math.PI) / 180); // horizontal reach of the drop
  const step = run / Math.SQRT2;                                           // its share of each of -X and -Z
  // Editable knots roughly every 150 m of slope length, the spacing a recovered reference line resamples to.
  const n = clampN(Math.round(Math.hypot(run, height) / 150) + 1, 4, 40);
  const knots: CourseKnot[] = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { pos: [-step * t, -height * t, -step * t] as V3, width, wall: 0, bank: 0, shoulder: 8 };
  });
  return { knots, blend: 30, surface: 1 };
}

/**
 * Match a top-to-bottom course to an exact vertical extent. Shorter requests trim at an interpolated
 * downhill crossing; taller requests extrapolate the final downhill direction. The source is never mutated.
 */
export function courseAtHeight(line: CoursePath, heightM: number): CoursePath {
  if (line.knots.length < 2) return { ...line, knots: line.knots.map(k => ({ ...k, pos: [...k.pos] as V3 })) };
  const height = clampN(heightM, 50, 6000);
  const current = courseHeight(line);
  const clone = (k: CourseKnot): CourseKnot => ({ ...k, pos: [...k.pos] as V3 });
  if (Math.abs(current - height) < 1e-6) return { ...line, knots: line.knots.map(clone) };

  const topY = Math.max(...line.knots.map(k => k.pos[1]));
  const targetY = topY - height;
  if (height < current) {
    const knots: CourseKnot[] = [clone(line.knots[0])];
    for (let i = 1; i < line.knots.length; i++) {
      const a = line.knots[i - 1], b = line.knots[i];
      if (b.pos[1] <= targetY && a.pos[1] > targetY) {
        const t = (targetY - a.pos[1]) / (b.pos[1] - a.pos[1]);
        knots.push({
          ...b,
          pos: lerp(a.pos, b.pos, t),
          width: a.width + (b.width - a.width) * t,
          wall: a.wall + (b.wall - a.wall) * t,
          bank: a.bank + (b.bank - a.bank) * t,
          shoulder: a.shoulder + (b.shoulder - a.shoulder) * t,
        });
        return { ...line, knots };
      }
      knots.push(clone(b));
    }
    return { ...line, knots };
  }

  const knots = line.knots.map(clone);
  const last = knots[knots.length - 1];
  let prior = knots.length - 2;
  while (prior > 0 && last.pos[1] >= knots[prior].pos[1] - 1e-6) prior--;
  let direction = sub(last.pos, knots[prior].pos);
  if (direction[1] >= -1e-6) direction = sub(last.pos, knots[0].pos);
  if (direction[1] >= -1e-6) direction = [height / 0.6, -height, 0];
  const scale = (targetY - last.pos[1]) / direction[1];
  knots.push({ ...last, pos: add(last.pos, mul(direction, scale)) });
  knots[knots.length - 1].pos[1] = targetY; // pin the requested height despite floating-point extrapolation
  return { ...line, knots };
}

/** Options for lofting fresh terrain from perpendicular cross-course edges. */
export interface CourseTerrainOpts {
  widthM?: number;          // full endpoint-to-endpoint length of every generated cross edge
  roughness?: number;       // deterministic height variation along each cross edge
  targetPatchM?: number;    // desired maximum spacing both across and between cross edges
  seed?: number;            // same course/options/seed reproduce the same generated terrain
}

const GENERATED_SURFACE = {
  oob: 0, snow: 1, slow: 2, powder: 3, slowPowder: 4, ice: 5, rock: 9,
} as const;

/** Nearest overhead point on the sampled course, including its interpolated height. */
function nearestCourseXZ(samples: readonly SpineSample[], p: V3): { distance: number; y: number } {
  let best2 = Infinity, bestY = samples[0]?.pos[1] ?? p[1];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i].pos, b = samples[i + 1].pos;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const d2 = dx * dx + dz * dz;
    const t = d2 > 1e-9 ? clampN(((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / d2, 0, 1) : 0;
    const ex = p[0] - (a[0] + dx * t), ez = p[2] - (a[2] + dz * t);
    const distance2 = ex * ex + ez * ez;
    if (distance2 < best2) { best2 = distance2; bestY = a[1] + (b[1] - a[1]) * t; }
  }
  return { distance: Math.sqrt(best2), y: bestY };
}

/**
 * Paint a freshly lofted course chart. Topology owns the safety bands, then terrain shape and course proximity
 * classify the interior: OOB rim → slow/off-track ring → extreme rock / steep ice → 75 m snow corridor → powder country.
 * A gentle far-field pocket substantially below its nearest course point becomes slow powder; ice is left for
 * authored painting because geometry alone does not provide a meaningful frozen/wet cue.
 */
function paintGeneratedCourseSurfaces(
  doc: QuadMeshDoc, samples: readonly SpineSample[], quadsAcross: number,
) {
  const lanes = Math.round(doc.quads.length / quadsAcross);
  if (quadsAcross < 1 || lanes < 1 || lanes * quadsAcross !== doc.quads.length) return;
  const derived = deriveQuadMesh(doc);
  const paint: Record<number, number> = {};
  const iceNormalY = Math.cos(Math.PI / 4);         // 45° or steeper
  const rockNormalY = Math.cos((65 * Math.PI) / 180); // only extreme faces / walls
  const gentleNormalY = Math.cos((15 * Math.PI) / 180);
  for (let lane = 0; lane < lanes; lane++) {
    for (let across = 0; across < quadsAcross; across++) {
      const q = lane * quadsAcross + across;
      const perimeter = lane === 0 || lane === lanes - 1 || across === 0 || across === quadsAcross - 1;
      const slowRing = lane === 1 || lane === lanes - 2 || across === 1 || across === quadsAcross - 2;
      if (perimeter) { paint[q] = GENERATED_SURFACE.oob; continue; }
      if (slowRing) { paint[q] = GENERATED_SURFACE.slow; continue; }

      const corners = doc.quads[q].map(id => readVertex(doc.vertices, id));
      const center: V3 = [0, 0, 0];
      for (const p of corners) for (let axis = 0; axis < 3; axis++) center[axis] += p[axis] / corners.length;
      const normal = patchNormal(quadControlPoints(derived.mesh, derived.edgeHandle, q), 0.5, 0.5);
      if (normal[1] <= rockNormalY) { paint[q] = GENERATED_SURFACE.rock; continue; }
      if (normal[1] <= iceNormalY) { paint[q] = GENERATED_SURFACE.ice; continue; }

      const nearest = nearestCourseXZ(samples, center);
      if (nearest.distance <= 75) { paint[q] = GENERATED_SURFACE.snow; continue; }
      const deepGentlePocket = nearest.distance >= 110 && normal[1] >= gentleNormalY && center[1] < nearest.y - 20;
      paint[q] = deepGentlePocket ? GENERATED_SURFACE.slowPowder : GENERATED_SURFACE.powder;
    }
  }
  doc.quadPaint = paint;
}

/**
 * Generate perpendicular, random-height edge chains along a run, discard chains whose overhead projection
 * intersects an earlier survivor, then bridge the survivors with the shared loft operation. Width is the
 * complete cross-edge length: there is no separately flattened rideable floor or concave/convex profile.
 */
export function buildMeshFromCourse(
  line: CoursePath,
  opts: CourseTerrainOpts = {},
  meta: Partial<Omit<MountainMeta, 'kind' | 'course' | 'spacing'>> = {},
): QuadMeshDoc | null {
  if (line.knots.length < 2) return null;
  const width = clampN(opts.widthM ?? 400, 30, 3000);
  const rough = clampN(opts.roughness ?? 0.5, 0, 3);
  const target = clampN(Math.round(opts.targetPatchM ?? 50), 5, 500);
  const seed = Math.abs(Math.trunc(opts.seed ?? 0)) % 0x80000000;
  const seedX = seed % 100000, seedZ = Math.floor(seed / 100000);

  const samples = sampleSpine(line.knots);
  const total = totalLength(samples);
  const behind = Math.min(100, total * 0.25);
  const ahead = Math.min(180, total * 0.4);
  const at = (s: number): { pos: V3; fwd: V3 } => {
    if (s < 0) { const a = samples[0]; return { pos: [a.pos[0] + a.fwd[0] * s, a.pos[1] + a.fwd[1] * s, a.pos[2] + a.fwd[2] * s], fwd: a.fwd }; }
    if (s > total) { const b = samples[samples.length - 1], e = s - total; return { pos: [b.pos[0] + b.fwd[0] * e, b.pos[1] + b.fwd[1] * e, b.pos[2] + b.fwd[2] * e], fwd: b.fwd }; }
    return spineAt(samples, s);
  };

  type CrossEdge = {
    points: V3[]; a: V3; b: V3; centre: V3; authored: boolean;
    jumpOffsets: number[]; courseOffset: number;
  };
  const orient = (a: V3, b: V3, c: V3) => (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
  const intersectsOverhead = (p: CrossEdge, q: CrossEdge): boolean => {
    const eps = 1e-7;
    const o1 = orient(p.a, p.b, q.a), o2 = orient(p.a, p.b, q.b);
    const o3 = orient(q.a, q.b, p.a), o4 = orient(q.a, q.b, p.b);
    const on = (a: V3, b: V3, c: V3) => Math.abs(orient(a, b, c)) <= eps
      && c[0] >= Math.min(a[0], b[0]) - eps && c[0] <= Math.max(a[0], b[0]) + eps
      && c[2] >= Math.min(a[2], b[2]) - eps && c[2] <= Math.max(a[2], b[2]) + eps;
    return (o1 * o2 < -eps && o3 * o4 < -eps)
      || (Math.abs(o1) <= eps && on(p.a, p.b, q.a)) || (Math.abs(o2) <= eps && on(p.a, p.b, q.b))
      || (Math.abs(o3) <= eps && on(q.a, q.b, p.a)) || (Math.abs(o4) <= eps && on(q.a, q.b, p.b));
  };
  const bridgeFacesUp = (p: CrossEdge, q: CrossEdge): boolean => {
    for (let c = 0; c < p.points.length - 1; c++) {
      // applyLoft stores [p[c], q[c], p[c+1], q[c+1]] and patchNormal uses dv × du.
      // In XZ, that is skyward only when both projected triangle orientations are clockwise.
      if (orient(p.points[c], q.points[c], p.points[c + 1]) >= -1e-7
        || orient(q.points[c], q.points[c + 1], p.points[c + 1]) >= -1e-7) return false;
    }
    return true;
  };
  // A near-vertical course transition is a wall/overhang, not a plan-view self-intersection. Its cross
  // rails may overlap or even cross in XZ while remaining well separated in Y. Let the loft span that
  // 3D transition instead of collapsing both rails laterally in an attempt to make it a heightfield.
  const isVerticalWall = (p: CrossEdge, q: CrossEdge): boolean => {
    const plan = Math.hypot(q.centre[0] - p.centre[0], q.centre[2] - p.centre[2]);
    const vertical = Math.abs(q.centre[1] - p.centre[1]);
    return vertical > Math.max(1, plan);
  };
  const railsConflict = (p: CrossEdge, q: CrossEdge): boolean =>
    intersectsOverhead(p, q) && !isVerticalWall(p, q);
  const bridgeCanConnect = (p: CrossEdge, q: CrossEdge): boolean =>
    bridgeFacesUp(p, q) || isVerticalWall(p, q);
  const shrinkAroundCourse = (edge: CrossEdge, scale: number): CrossEdge => {
    const points = edge.points.map((p): V3 => [
      edge.centre[0] + (p[0] - edge.centre[0]) * scale,
      p[1],
      edge.centre[2] + (p[2] - edge.centre[2]) * scale,
    ]);
    return { ...edge, points, a: points[0], b: points[points.length - 1] };
  };

  // Authored knots are the primary loft rails. Only the two runout rails are synthetic; applyLoft inserts
  // any additional loops needed to meet targetPatchM between these primary sections.
  const stations = [{ s: -behind, authored: false }];
  for (let k = 0; k < line.knots.length; k++) {
    stations.push({ s: samples[Math.min(samples.length - 1, k * 32)].s, authored: true });
  }
  stations.push({ s: total + ahead, authored: false });
  const uniqueStations = stations.filter((station, i) =>
    i === 0 || Math.abs(station.s - stations[i - 1].s) > 1e-6);
  let crossSegments = Math.max(2, Math.ceil(width / target));
  if (crossSegments % 2) crossSegments++; // retain an exact course-centre vertex without making a flat floor
  const kept: CrossEdge[] = [];
  for (let r = 0; r < uniqueStations.length; r++) {
    const station = uniqueStations[r];
    const sp = at(station.s);
    const { side } = frameAt(sp.fwd);
    const profileNoise = (c: number, wx: number, wz: number) =>
      0.6 * noise2(wx / 65 + 5.3 + seedX * 0.17, wz / 65 + 1.9 + seedZ * 0.23)
      + 0.4 * noise2(r * 0.73 + 17.1 + seedX, c * 1.37 + 9.4 + seedZ);
    const centre = crossSegments / 2;
    const centreNoise = profileNoise(centre, sp.pos[0], sp.pos[2]);
    const previous = kept[kept.length - 1];
    const perturbation = (c: number) => noise2(r * 17 + 31 + seedX, c * 23 + 14 + seedZ);
    const centrePerturbation = perturbation(centre);
    const evolution = Math.min(1, rough * 0.6);
    const jumpChance = Math.min(0.35, rough * 0.12);
    const freshJump = (c: number) => {
      if (!previous || noise2(r * 37 + 7 + seedX, c * 41 + 19 + seedZ) >= jumpChance) return 0;
      const magnitude = rough * width * (0.12 + 0.18 * noise2(r * 43 + 11 + seedX, c * 47 + 23 + seedZ));
      return noise2(r * 53 + 17 + seedX, c * 59 + 29 + seedZ) < 0.5 ? -magnitude : magnitude;
    };
    const jumpOffsets = Array.from({ length: crossSegments + 1 }, (_, c) =>
      (previous?.jumpOffsets[c] ?? 0) * 0.12 + freshJump(c));
    const courseOffset = previous
      ? previous.courseOffset * 0.45 + rough * 0.08 * width * (noise2(r * 67 + 13 + seedX, 71 + seedZ) - 0.5)
      : 0;
    const points: V3[] = [];
    for (let c = 0; c <= crossSegments; c++) {
      // +side -> -side gives this transposed use of Loft (cross edges as rails, course as rail order)
      // skyward patch winding. The XZ projection remains a straight perpendicular edge.
      const lat = (0.5 - c / crossSegments) * width;
      const wx = sp.pos[0] + side[0] * lat, wz = sp.pos[2] + side[2] * lat;
      const inheritedRelative = previous
        ? previous.points[c][1] - previous.points[centre][1]
          - (previous.jumpOffsets[c] - previous.jumpOffsets[centre])
        : 0;
      const y = previous
        ? sp.pos[1] - 1.5 + courseOffset
          + inheritedRelative * (1 - evolution)
          + rough * 0.24 * width * (perturbation(c) - centrePerturbation) * evolution
          + jumpOffsets[c]
        : sp.pos[1] - 1.5 + rough * 0.24 * width * (profileNoise(c, wx, wz) - centreNoise);
      points.push([wx, y, wz]);
    }
    let edge: CrossEdge = {
      points, a: points[0], b: points[points.length - 1], centre: [...sp.pos] as V3,
      authored: station.authored, jumpOffsets, courseOffset,
    };
    const fits = (candidate: CrossEdge) => !kept.some(other => railsConflict(other, candidate))
      && (!kept.length || bridgeCanConnect(kept[kept.length - 1], candidate));
    if (!fits(edge)) {
      if (!edge.authored) continue; // runout is expendable; a green course knot is not
      // A leading synthetic runout can cross a newly redirected first course segment. Drop that helper
      // before narrowing the authored rail; it must never win over the line the author can see and move.
      for (let i = kept.length - 1; i >= 0; i--) {
        if (!kept[i].authored && (railsConflict(kept[i], edge)
          || (i === kept.length - 1 && !bridgeCanConnect(kept[i], edge)))) kept.splice(i, 1);
      }
      // Tight bends make full-width perpendiculars overlap in plan view. Preserve the rail and its exact
      // course-centre vertex, narrowing only its lateral reach until the next loft strip is unambiguous.
      // This makes every authored green knot a hard terrain constraint instead of silently cutting it out.
      const fullEdge = edge;
      let scale = 0.85;
      while (scale >= 0.01 && !fits(edge)) {
        edge = shrinkAroundCourse(fullEdge, scale);
        scale *= 0.8;
      }
      if (!fits(edge) && kept.length) {
        // On a harder turn the inside end of the PREVIOUS full-width rail can cross the new centreline,
        // so narrowing only the incoming rail can never succeed. Solve that adjacent pair together while
        // checking the earlier strip too; both authored centre vertices remain fixed on their green knots.
        const priorIndex = kept.length - 1;
        const fullPrior = kept[priorIndex];
        const earlier = kept.slice(0, priorIndex);
        const scales: number[] = [1];
        for (let s = 0.85; s >= 0.01; s *= 0.8) scales.push(s);
        pair: for (const priorScale of scales) {
          const prior = shrinkAroundCourse(fullPrior, priorScale);
          const priorFits = !earlier.some(other => railsConflict(other, prior))
            && (!earlier.length || bridgeCanConnect(earlier[earlier.length - 1], prior));
          if (!priorFits) continue;
          for (const nextScale of scales) {
            const next = shrinkAroundCourse(fullEdge, nextScale);
            if (earlier.some(other => railsConflict(other, next))
              || railsConflict(prior, next) || !bridgeCanConnect(prior, next)) continue;
            kept[priorIndex] = prior;
            edge = next;
            break pair;
          }
        }
      }
      if (!fits(edge)) return null; // a self-crossing centreline cannot be represented by one loft chart
    }
    kept.push(edge);
  }
  if (kept.length < 2) return null;

  const vertices: number[] = [];
  const rails: number[][] = [];
  const freeEdges: [number, number][] = [];
  for (const edge of kept) {
    const rail: number[] = [];
    for (const p of edge.points) { rail.push(vertices.length / 3); vertices.push(...p); }
    for (let i = 0; i < rail.length - 1; i++) freeEdges.push([rail[i], rail[i + 1]]);
    rails.push(rail);
  }
  const name = meta.name?.trim() || 'MOUNTAIN01';
  const doc: QuadMeshDoc = {
    kind: 'mountain', version: 5, name, spacing: target,
    course: { ...line, knots: line.knots.map(k => ({ ...k, pos: [...k.pos] as V3 })) },
    baseSurface: meta.baseSurface ?? 1, props: meta.props, lights: meta.lights, rails: meta.rails,
    gems: meta.gems, sun: meta.sun, skybox: meta.skybox, raceMusic: meta.raceMusic,
    raceMusicArrangement: meta.raceMusicArrangement,
    environmentBed: normalizeEnvironmentBed(meta.environmentBed),
    boardSound: meta.boardSound, laps: meta.laps,
    aiSeed: meta.aiSeed,
    effects: meta.effects ?? createEmptyEffectsDocument(name),
    particleVolumes: normalizeParticleVolumes(meta.particleVolumes),
    vertices, quads: [], ...seedMeshIds(0, vertices.length / 3, 0), freeEdges, tJunctions: [],
  };
  const loft = applyLoft(doc, rails, {
    preserveRailOrder: true, targetPatchM: target, connectionCurve: 1,
  });
  if (!loft.ok) return null;
  const generated = loft.doc;
  // Finish exactly like Edit → select every point → Smooth: positions stay fixed while every boundary
  // tangent returns to the automatic Bessel surface. Generated lofts normally have no overrides already,
  // but using the shared command keeps this invariant explicit if the generator gains authored handles later.
  meshSmoothVertices(generated, Array.from({ length: generated.vertices.length / 3 }, (_, id) => id));
  for (const knot of generated.course.knots) {
    const y = surfaceHeightAt(generated, knot.pos[0], knot.pos[2]);
    if (y !== null) knot.pos[1] = y;
  }
  paintGeneratedCourseSurfaces(generated, samples, crossSegments);
  return generated;
}

/** Convert a recovered/reference polyline into the same editable CoursePath consumed by terrain regeneration. */
export function coursePathFromLine(points: V3[], widthM = 400, heightM?: number): CoursePath {
  if (points.length < 2) throw new Error('A course line needs at least 2 points.');
  const width = clampN(widthM, 30, 3000);
  // Height belongs to the recovered path itself. Adjust before resampling so choosing the reference's shown
  // height is a true no-op; doing this afterward can lose a raw extremum, falsely trigger tail extension and
  // create an enormous invalid final rail on a nearly flat finish segment.
  const source = heightM === undefined ? points : courseAtHeight({
    blend: 30, surface: 1, knots: points.map(pos => ({
      pos: [...pos] as V3, width, wall: 0, bank: 0, shoulder: 8,
    })),
  }, heightM).knots.map(k => k.pos);

  // Resample to evenly arc-length-spaced knots (~1 per 150 m) so the Catmull-Rom run keeps the line's
  // turns and sharp changes in descent without inheriting every raw path vertex (the source line is hundreds
  // of points). buildMeshFromCourse handles vertically stacked rails as walls rather than width conflicts.
  const cum = [0];
  for (let i = 1; i < source.length; i++) {
    const a = source[i], b = source[i - 1];
    cum.push(cum[i - 1] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  const total = cum[cum.length - 1];
  const n = clampN(Math.round(total / 150) + 1, 8, 60);
  const resampled: V3[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = (total * i) / (n - 1);
    while (j < source.length - 2 && cum[j + 1] < s) j++;
    const span = Math.max(1e-9, cum[j + 1] - cum[j]);
    resampled.push(lerp(source[j], source[j + 1], (s - cum[j]) / span));
  }

  // Keep native editor coordinates so the authored mountain overlays the loaded reference and round-trips.
  const knots: CourseKnot[] = resampled.map(q => ({
    pos: [q[0], q[1], q[2]] as V3, width, wall: 0, bank: 0, shoulder: 8,
  }));
  return { knots, blend: 30, surface: 1 };
}

/**
 * A mountain with NO SURFACE AT ALL: no vertices, no quads, just its identity, its spacing and a straight
 * guide run hanging in space. Every patch is then authored by hand with Edit ▸ create patch, which needs no
 * existing geometry — it falls back to a screen-facing construction plane through the view target. This is the
 * empty-mesh state a model session already edits in (`createAuthoredModel`), promoted to a whole mountain, and
 * every consumer downstream already guards for it (`buildQuadMesh`, `surfaceHeightAt`, `focusMountain`).
 */
export function blankMountain(
  name = 'MOUNTAIN01', heightM = DEFAULT_COURSE_HEIGHT_M, slopeDeg = DEFAULT_BLANK_SLOPE_DEG, spacingM = 50,
): QuadMeshDoc {
  const level = name.trim() || 'MOUNTAIN01';
  return {
    kind: 'mountain', version: 5, name: level,
    spacing: clampN(Math.round(spacingM), 5, 500),
    course: straightCourse(heightM, 400, slopeDeg),
    baseSurface: 1,
    raceMusicArrangement: { mode: 'linear-loop', bpm: 120, loopStartSeconds: 0, loopEndSeconds: 0 },
    environmentBed: normalizeEnvironmentBed(undefined),
    effects: createEmptyEffectsDocument(level),
    particleVolumes: normalizeParticleVolumes(undefined),
    vertices: [], quads: [], ...seedMeshIds(0, 0, 0), freeEdges: [], tJunctions: [],
  };
}

/** Stock document for first launch and invalid legacy input: the same course-loft workflow as New mountain. */
export function defaultMountain(): QuadMeshDoc {
  const generated = buildMeshFromCourse(starterCourse(DEFAULT_COURSE_HEIGHT_M, 400, 1), {
    widthM: 400, roughness: 0.5, targetPatchM: 50, seed: 1,
  }, { name: 'MOUNTAIN01', baseSurface: 1 });
  if (!generated) throw new Error('The default starter course could not be lofted.');
  return generated;
}

/** Upgrade Effects documents embedded in mountain saves across contract-only renames. */
function migrateMountainEffects(raw: unknown, level: string): EffectsDocument {
  if (raw === undefined) return createEmptyEffectsDocument(level);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const document = raw as Record<string, unknown>;
    // 'ssx-effects' and 'swx-effects' are earlier spellings of the same v1 contract — only the names changed.
    if ((document.kind === 'ssx-effects' || document.kind === 'swx-effects') && document.version === 1) {
      document.kind = 'openslope-effects';
      if (document.$schema === 'ssx-effects-v1.schema.json' || document.$schema === 'swx-effects-v1.schema.json')
        document.$schema = 'openslope-effects-v1.schema.json';
    }
    // A model-clip node's U1/U2 are the clip WINDOW in frames, and a zero-length one plays nothing on
    // hardware. Documents exist carrying (0, 0) — the editor's own playback repairs a degenerate window to
    // the full clip, so the prop animated in Preview and stood still in a repacked ISO. Rewrite exactly
    // (0, 0) to the (-1, -1) "whole clip" sentinel that 40 of retail's 43 anim nodes carry; any other
    // window is a real authored choice and is left alone.
    for (const graphs of ['graphs', 'functions'] as const)
      for (const graph of Array.isArray(document[graphs]) ? document[graphs] as Record<string, unknown>[] : [])
        for (const node of Array.isArray(graph?.nodes) ? graph.nodes as Record<string, unknown>[] : []) {
          const type0 = (node?.payload as Record<string, unknown> | undefined)?.type0 as
            Record<string, unknown> | undefined;
          const anim = (type0?.type0Sub256 ?? type0?.type0Sub257) as Record<string, unknown> | undefined;
          if (anim && anim.U1 === 0 && anim.U2 === 0) { anim.U1 = -1; anim.U2 = -1; }
        }
  }
  return parseEffectsDocument(raw);
}

/**
 * Bring any persisted mountain up to the live model: a general quad mesh (`QuadMeshDoc`). A mesh doc passes
 * through; any older save (a rows×cols grid net, or the legacy `verts` heightfield + carves) is read back into
 * a `GridNet` and PROMOTED by `meshFromNet`, so the editor only ever holds a mesh. The grid remains an
 * internal generator / interchange format (export still reads it); the editor does not.
 *
 * This is also the load half of the keying boundary (docs/039, doc/serialize.ts): a mountain read off disk
 * names its keyed channels by stable id, and comes out of here naming them by index, which is what every
 * reader downstream speaks. The same shape arrives already index-keyed when the editor posts a document back
 * to save it, so the conversion follows the stored document's own marker rather than its version.
 */
export function migrateMountain(raw: unknown): QuadMeshDoc {
  const d = raw as Record<string, unknown>;
  if (!d || typeof d !== 'object') return defaultMountain();

  // the document form: pass through, just settle its run.
  if (Array.isArray(d.vertices) && Array.isArray(d.quads)) {
    const doc = raw as QuadMeshDoc;
    const handleKeys = Object.keys(doc.edgeHandles ?? {}).length;
    // A document may carry `tracks` / `guides` fields — retired generator metadata layered alongside the real
    // mesh geometry. Drop them and keep that geometry as ordinary editable vertices/quads.
    delete d.tracks;
    delete d.guides;
    const vcount = doc.vertices.length / 3;
    // Identity, and with it the document's keying, before anything reads a key. Version 5 is the marker for
    // stable vertex / quad identity (docs/039); below it — or with an id array a hand edit left out of step
    // with its geometry — the whole mesh is named once, in index order. A document stored by id then has its
    // channels named by index, the form every reader past this point uses (doc/serialize.ts).
    const named = Array.isArray(doc.vertexIds) && doc.vertexIds.length === vcount
      && Array.isArray(doc.quadIds) && doc.quadIds.length === doc.quads.length && Number.isInteger(doc.nextId);
    const tombstones = Array.isArray(doc.tombstones) ? [...new Set(doc.tombstones.filter(id => typeof id === 'string'))] : [];
    if (tombstones.length) doc.tombstones = tombstones; else delete doc.tombstones;
    let retiredHandles = 0;
    if (storedById(d)) {
      if (!named) {
        throw new Error('This mountain is stored by stable id, but its identity does not name its mesh — '
          + 'nothing in it can be resolved.');
      }
      retiredHandles = keyMountainByIndex(doc).retiredHandles;
    } else if (d.version !== 5 || !named) {
      // Named afresh, so the retired names belong to a numbering this document no longer has.
      Object.assign(doc, seedMeshIds(0, vcount, doc.quads.length));
      delete doc.tombstones;
    }
    doc.version = 5;
    const seen = new Set<string>();
    const freeEdges: [number, number][] = [];
    for (const edge of Array.isArray(d.freeEdges) ? d.freeEdges : []) {
      if (!Array.isArray(edge) || edge.length !== 2) continue;
      const a0 = edge[0], b0 = edge[1];
      if (!Number.isInteger(a0) || !Number.isInteger(b0) || a0 < 0 || b0 < 0 || a0 >= vcount || b0 >= vcount || a0 === b0) continue;
      const a = Math.min(a0, b0), b = Math.max(a0, b0), key = `${a},${b}`;
      if (!seen.has(key)) { seen.add(key); freeEdges.push([a, b]); }
    }
    if (freeEdges.length) doc.freeEdges = freeEdges; else delete doc.freeEdges;
    const rawTJunctions = Array.isArray(d.tJunctions) ? d.tJunctions : null;
    const explicitFormat = rawTJunctions !== null && rawTJunctions.every(record => !!record && typeof record === 'object'
      && Number.isInteger((record as Record<string, unknown>).vertex)
      && Array.isArray((record as Record<string, unknown>).edge)
      && Number.isFinite((record as Record<string, unknown>).t));
    doc.tJunctions = explicitFormat
      ? normalizeTJunctions(doc, rawTJunctions as QuadMeshDoc['tJunctions'])
      : inferGeometricTJunctions(doc).map(({ vertex, edge, t }) => ({ vertex, edge, t }));
    doc.course = normalizeCourse(doc.course, doc.vertices, doc.spacing);
    if (typeof d.raceMusic !== 'string' && d.raceMusic !== null) delete doc.raceMusic;
    if (d.raceMusicArrangement !== undefined)
      doc.raceMusicArrangement = normalizeRaceMusicArrangement(d.raceMusicArrangement);
    doc.environmentBed = normalizeEnvironmentBed(d.environmentBed);
    if (d.boardSound !== undefined) doc.boardSound = normalizeBoardSound(d.boardSound);
    doc.effects = migrateMountainEffects(doc.effects, doc.name);
    doc.particleVolumes = normalizeParticleVolumes(doc.particleVolumes);
    ensurePlacedPropIds(doc.props);
    ensureRailIds(doc.rails);
    ensureLightIds(doc.lights);
    ensureGemIds(doc.gems);
    ensureScreenIds(doc.screens);
    normalizeLabels(doc);
    // A dropped `edgeHandles` key raises nothing: the edge falls back to its Bessel default and the terrain
    // quietly changes shape (docs/039). Loading a stored mountain re-keys every one of them from an id to an
    // index, so hold that conversion to the count it started with, less the creases it was right to discard
    // — the ones naming geometry this document has since deleted.
    const migratedKeys = Object.keys(doc.edgeHandles ?? {}).length;
    if (migratedKeys + retiredHandles !== handleKeys) {
      throw new Error(`Migration changed the mountain's edge-handle count `
        + `(${handleKeys} → ${migratedKeys}${retiredHandles ? `, ${retiredHandles} retired` : ''}).`);
    }
    return doc;
  }
  if (typeof d.rows !== 'number' || typeof d.cols !== 'number') return defaultMountain();

  /** The doc fields a saved net carries alongside its lattice. */
  const meta = (course: CoursePath, baseSurface: number): Omit<MountainMeta, 'kind' | 'spacing'> => {
    const props = d.props as MountainMeta['props'];
    ensurePlacedPropIds(props);
    const rails = d.rails as MountainMeta['rails'];
    ensureRailIds(rails);
    const lights = d.lights as MountainMeta['lights'];
    ensureLightIds(lights);
    const gems = d.gems as MountainMeta['gems'];
    ensureGemIds(gems);
    const screens = d.screens as MountainMeta['screens'];
    ensureScreenIds(screens);
    return {
      name: typeof d.name === 'string' ? d.name : 'MOUNTAIN01',
      course,
      baseSurface,
      props,
      lights,
      rails,
      gems,
      screens,
      labels: d.labels as MountainMeta['labels'],
      sun: d.sun as MountainMeta['sun'],
      skybox: d.skybox as MountainMeta['skybox'],
      raceMusic: typeof d.raceMusic === 'string' || d.raceMusic === null
        ? d.raceMusic as MountainMeta['raceMusic'] : undefined,
      raceMusicArrangement: d.raceMusicArrangement === undefined
        ? undefined : normalizeRaceMusicArrangement(d.raceMusicArrangement),
      environmentBed: normalizeEnvironmentBed(d.environmentBed),
      boardSound: d.boardSound === undefined ? undefined : normalizeBoardSound(d.boardSound),
      laps: normalizeLaps(d.laps),
      aiSeed: d.aiSeed as MountainMeta['aiSeed'],
      effects: migrateMountainEffects(d.effects, typeof d.name === 'string' ? d.name : 'MOUNTAIN01'),
      particleVolumes: normalizeParticleVolumes(d.particleVolumes),
    };
  };

  // a saved grid net (`corners`): promote it, settling the run on the way.
  if (Array.isArray(d.corners)) {
    const net: GridNet = {
      rows: d.rows, cols: d.cols, spacing: (d.spacing as number) ?? 30,
      corners: [...(d.corners as number[])],
      handles: d.handles as GridNet['handles'],
      paint: (d.paint as PaintMap) ?? {},
      texPaint: d.texPaint as TexPaintMap | undefined,
      texOrient: d.texOrient as GridNet['texOrient'],
    };
    const course = normalizeCourse(d.course, net.corners, net.spacing);
    return meshFromNet(net, meta(course, (d.baseSurface as number) ?? 1));
  }

  // the v1 heightfield (`verts` + `carves`): rebuild the net, recover the run, re-cut what it carved.
  if (!Array.isArray(d.verts)) return defaultMountain();
  const net: GridNet = {
    rows: d.rows, cols: d.cols, spacing: (d.spacing as number) ?? 30,
    corners: [...(d.verts as number[])],
    paint: (d.paint as PaintMap) ?? {},
    texPaint: d.texPaint as TexPaintMap | undefined,
  };
  // seat only what the doc actually carved. normalizeCourse hands a runless doc a swept fall line, and
  // grooving THAT would cut a channel the author never drew.
  const carved = Array.isArray(d.carves) && (d.carves as CoursePath[]).some(c => c?.knots?.length >= 2);
  const course = normalizeCourse(d.carves, net.corners, net.spacing);
  if (carved) seatCourse(net, course); // re-create the legacy carve as a seated (flat) channel
  return meshFromNet(net, meta(course, (d.baseSurface as number) ?? 2));
}

/**
 * Settle a saved `course` field onto the ONE run a mountain has, and fill the fields legacy carves / S1 docs
 * lacked (the ribbon cross-section). A doc saved when a mountain could hold several runs carries an array —
 * the first run with a sweepable spine wins, the rest are dropped, since only the first ever reached the
 * export. A doc carrying no usable run gets a swept fall line, because the export needs one (AIP + gate).
 */
function normalizeCourse(saved: unknown, positions: number[], spacing = 30): CoursePath {
  const found = Array.isArray(saved)
    ? (saved as CoursePath[]).find(l => l?.knots?.length >= 2)
    : (saved as CoursePath | undefined);

  // rebuilt, not patched: a doc saved with a per-run `name` (or any other retired field) leaves it behind
  const src = found && Array.isArray(found.knots) && found.knots.length >= 2 ? found : fallLineRun(positions, spacing);
  const c: CoursePath = {
    knots: src.knots,
    blend: typeof src.blend === 'number' ? src.blend : 30,
    surface: typeof src.surface === 'number' ? src.surface : 1,
  };
  const anchor = (value: unknown): { pos: V3 } | undefined => {
    const pos = (value as { pos?: unknown } | undefined)?.pos;
    return Array.isArray(pos) && pos.length === 3 && pos.every(Number.isFinite)
      ? { pos: [...pos] as V3 }
      : undefined;
  };
  c.start = anchor(src.start);
  c.finish = anchor(src.finish);
  for (const k of c.knots) {
    if (typeof k.width !== 'number') k.width = Math.max(22, spacing * 2);
    if (typeof k.wall !== 'number') k.wall = 0;
    if (typeof k.bank !== 'number') k.bank = 0;
    if (typeof k.shoulder !== 'number') k.shoulder = 6;
    const checkpointBonus = normalizeCheckpointBonus(k.checkpointBonus);
    if (checkpointBonus === undefined) delete k.checkpointBonus;
    else k.checkpointBonus = checkpointBonus;
  }
  return c;
}

/**
 * The run a doc gets when it carries none: a straight line from the net's highest vertex to its lowest,
 * riding 2 m under the surface. On a net with no fall (every vertex level, or one vertex) it runs the
 * longer horizontal axis of the bounding box instead, so the spine always has length to sweep.
 */
function fallLineRun(P: number[], spacing: number): CoursePath {
  const width = Math.max(22, spacing * 2);
  const knot = (pos: V3): CourseKnot => ({ pos, width, wall: 0, bank: 0, shoulder: 6 });
  const run = (a: V3, b: V3): CoursePath => ({
    knots: [knot(a), knot([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]), knot(b)],
    blend: 30,
    surface: 1,
  });
  if (P.length < 6) return run([0, 0, 0], [Math.max(100, width * 4), -50, 0]); // no net to read

  let hi = 0, lo = 0;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < P.length; i += 3) {
    if (P[i + 1] > P[hi + 1]) hi = i;
    if (P[i + 1] < P[lo + 1]) lo = i;
    for (let k = 0; k < 3; k++) { if (P[i + k] < min[k]) min[k] = P[i + k]; if (P[i + k] > max[k]) max[k] = P[i + k]; }
  }
  const top: V3 = [P[hi], P[hi + 1] - 2, P[hi + 2]];
  const foot: V3 = [P[lo], P[lo + 1] - 2, P[lo + 2]];
  if (Math.hypot(foot[0] - top[0], foot[2] - top[2]) >= 1) return run(top, foot);

  const y = (min[1] + max[1]) / 2 - 2; // a level net: sweep the long horizontal axis at mid height
  return max[0] - min[0] >= max[2] - min[2]
    ? run([min[0], y, (min[2] + max[2]) / 2], [max[0], y, (min[2] + max[2]) / 2])
    : run([(min[0] + max[0]) / 2, y, min[2]], [(min[0] + max[0]) / 2, y, max[2]]);
}
