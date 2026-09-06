import type { QuadMeshDoc, V3 } from '../../doc/types';
import { deriveQuadMesh } from '../../doc/mountain';
import { cubicPoint, patchPoint } from '../../math/bezier';
import { add, cross, len, sub } from '../../math/vec';
import { meshAdjacency, quadControlPoints } from '../topology';
import type { PolygonMesh } from './obj';

export interface RetopologyBenchmarkOptions {
  /** Exact patch rings grown outward from the locked selection. */
  collarRings: number;
  /** Desired control-patch edge length in editor metres. */
  targetPatchSizeM: number;
  /** Samples per bicubic edge/axis in the triangle interchange mesh. */
  tessellationResolution: number;
  /** Remesh the locked feature and mountain as one surface; locks become geometric/paint guides, not a hole. */
  wholeSurface?: boolean;
  /** Run the bounded cage-shape optimizer after fold repair. */
  regularizeCandidate?: boolean;
  /** Insert protected corners into coarse candidate boundary edges. */
  refineBoundaryCorners?: boolean;
  /** Parameterize an already ordered candidate interface by chord length instead of independent projection. */
  arcLengthInterfaceParameters?: boolean;
}

export interface InterfaceCurve {
  /** Stable ids of the original control-net edge. */
  edgeVertexIds: [string, string];
  /** Exact samples of its cubic Bezier boundary, including both endpoints. */
  samples: V3[];
}

export interface RetopologyConstraints {
  version: 1;
  sourceName: string;
  options: RetopologyBenchmarkOptions;
  lockedQuadIds: string[];
  protectedQuadIds: string[];
  remeshQuadIds: string[];
  interface: InterfaceCurve[];
  sourceAreaM2: number;
  targetFaces: number;
  warnings: string[];
}

export interface PreparedRetopologyBenchmark {
  /** Triangulated, seam-welded remainder supplied to an external candidate. */
  input: PolygonMesh;
  /** Triangulated visualization of the exact region that will not be replaced. */
  protected: PolygonMesh;
  constraints: RetopologyConstraints;
}

const DEFAULT_OPTIONS: RetopologyBenchmarkOptions = {
  collarRings: 1,
  targetPatchSizeM: 30,
  tessellationResolution: 8,
  wholeSurface: false,
  regularizeCandidate: false,
  refineBoundaryCorners: true,
  arcLengthInterfaceParameters: false,
};

const perimeter = ([A, B, C, D]: readonly number[]): [number, number][] =>
  [[A, B], [B, D], [D, C], [C, A]];
const edgeKey = (a: number, b: number): string => a < b ? `${a},${b}` : `${b},${a}`;
const pointAt = (vertices: readonly number[], vertex: number): V3 => {
  const at = vertex * 3;
  return [vertices[at], vertices[at + 1], vertices[at + 2]];
};

/** Locked patches plus N edge-adjacent rings. This is the same collar the eventual editor operation retains. */
export function protectedQuadSet(doc: QuadMeshDoc, collarRings: number): Set<number> {
  const derived = deriveQuadMesh(doc), protectedQuads = new Set<number>();
  for (const key of Object.keys(doc.quadLocked ?? {})) {
    const quad = Number(key);
    if (doc.quadLocked?.[quad] === true && quad >= 0 && quad < doc.quads.length) protectedQuads.add(quad);
  }
  const rings = Math.max(0, Math.min(3, Math.floor(collarRings)));
  for (let ring = 0; ring < rings; ring++) {
    const frontier = [...protectedQuads];
    for (const quad of frontier) for (const edge of derived.mesh.topology.cellEdges[quad] ?? []) {
      for (const neighbor of derived.mesh.topology.edgeCells[edge] ?? []) protectedQuads.add(neighbor);
    }
  }
  return protectedQuads;
}

/** Count edge-connected components in a source-patch set. Vertex-only contact does not make one editable
 * region: it would leave two independent boundary cycles touching at a non-manifold point. */
export function quadRegionCount(doc: QuadMeshDoc, quads: ReadonlySet<number>): number {
  const derived = deriveQuadMesh(doc), remaining = new Set(quads);
  let regions = 0;
  while (remaining.size) {
    regions++;
    const seed = remaining.values().next().value as number, queue = [seed];
    remaining.delete(seed);
    while (queue.length) {
      const quad = queue.pop()!;
      for (const edge of derived.mesh.topology.cellEdges[quad] ?? []) {
        for (const neighbor of derived.mesh.topology.edgeCells[edge] ?? []) {
          if (remaining.delete(neighbor)) queue.push(neighbor);
        }
      }
    }
  }
  return regions;
}

function growQuadSet(doc: QuadMeshDoc, seed: ReadonlySet<number>, requestedRings: number): Set<number> {
  const derived = deriveQuadMesh(doc), grown = new Set(seed);
  const rings = Math.max(0, Math.min(5, Math.floor(requestedRings)));
  for (let ring = 0; ring < rings; ring++) {
    const frontier = [...grown];
    for (const quad of frontier) for (const edge of derived.mesh.topology.cellEdges[quad] ?? []) {
      for (const neighbor of derived.mesh.topology.edgeCells[edge] ?? []) grown.add(neighbor);
    }
  }
  return grown;
}

/** A topology key for one tessellation lattice point, welding shared bicubic boundaries without position fuzz. */
function sampleKey(quad: readonly number[], q: number, u: number, v: number, resolution: number): string {
  const [A, B, C, D] = quad;
  if (u === 0 && v === 0) return `v:${A}`;
  if (u === 0 && v === resolution) return `v:${B}`;
  if (u === resolution && v === 0) return `v:${C}`;
  if (u === resolution && v === resolution) return `v:${D}`;
  const edge = (a: number, b: number, step: number): string => {
    if (a === b) return `v:${a}`;
    return a < b ? `e:${a},${b}:${step}/${resolution}` : `e:${b},${a}:${resolution - step}/${resolution}`;
  };
  if (u === 0) return edge(A, B, v);
  if (u === resolution) return edge(C, D, v);
  if (v === 0) return edge(A, C, u);
  if (v === resolution) return edge(B, D, u);
  return `q:${q}:${u},${v}`;
}

export function tessellateQuads(doc: QuadMeshDoc, quads: ReadonlySet<number>, resolution: number): PolygonMesh {
  const derived = deriveQuadMesh(doc), vertices: V3[] = [], faces: number[][] = [];
  const welded = new Map<string, number>();
  const res = Math.max(1, Math.floor(resolution));
  for (const q of [...quads].sort((a, b) => a - b)) {
    const quad = derived.mesh.quads[q];
    if (!quad) continue;
    const controls = quadControlPoints(derived.mesh, derived.edgeHandle, q, derived.twistOf(q));
    const lattice: number[][] = Array.from({ length: res + 1 }, () => new Array<number>(res + 1));
    for (let u = 0; u <= res; u++) for (let v = 0; v <= res; v++) {
      const key = sampleKey(quad, q, u, v, res);
      let index = welded.get(key);
      if (index === undefined) {
        index = vertices.length;
        vertices.push(patchPoint(controls, u / res, v / res));
        welded.set(key, index);
      }
      lattice[u][v] = index;
    }
    for (let u = 0; u < res; u++) for (let v = 0; v < res; v++) {
      const a = lattice[u][v], b = lattice[u][v + 1], c = lattice[u + 1][v], d = lattice[u + 1][v + 1];
      // Match the production tessellator's skyward winding. Collapsed wedge facets are omitted.
      if (new Set([a, d, c]).size === 3) faces.push([a, d, c]);
      if (new Set([a, b, d]).size === 3) faces.push([a, b, d]);
    }
  }
  return { vertices, faces };
}

function triangleArea(a: V3, b: V3, c: V3): number {
  return len(cross(sub(b, a), sub(c, a))) / 2;
}

export function polygonArea(mesh: PolygonMesh): number {
  let area = 0;
  for (const face of mesh.faces) {
    for (let i = 1; i + 1 < face.length; i++) area += triangleArea(
      mesh.vertices[face[0]], mesh.vertices[face[i]], mesh.vertices[face[i + 1]],
    );
  }
  return area;
}

/** The protected set split into edge-connected components, so "does this sheet float?" can be asked of the
 *  whole sheet rather than of one quad that happens to sit on a boundary. */
function protectedComponents(
  mesh: { quads: readonly number[][] },
  adjacency: ReturnType<typeof meshAdjacency>,
  protectedQuads: ReadonlySet<number>,
): number[][] {
  const components: number[][] = [], visited = new Set<number>();
  for (const start of protectedQuads) {
    if (visited.has(start)) continue;
    const component: number[] = [], stack = [start];
    visited.add(start);
    while (stack.length) {
      const quad = stack.pop()!;
      component.push(quad);
      const corners = mesh.quads[quad];
      if (!corners) continue;
      for (const [a, b] of perimeter(corners)) {
        for (const neighbor of adjacency.edgeQuads.get(edgeKey(a, b)) ?? []) {
          if (!protectedQuads.has(neighbor) || visited.has(neighbor)) continue;
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function interfaceCurves(doc: QuadMeshDoc, protectedQuads: ReadonlySet<number>, resolution: number): InterfaceCurve[] {
  const derived = deriveQuadMesh(doc), adjacency = meshAdjacency(derived.mesh);
  const curves: InterfaceCurve[] = [], seen = new Set<string>();
  const append = (a: number, b: number) => {
    const key = edgeKey(a, b);
    if (a === b || seen.has(key)) return;
    seen.add(key);
    const p0 = pointAt(doc.vertices, a), p3 = pointAt(doc.vertices, b);
    const p1 = add(p0, derived.edgeHandle(a, b)), p2 = add(p3, derived.edgeHandle(b, a));
    const samples = Array.from({ length: resolution + 1 }, (_, i) => cubicPoint(p0, p1, p2, p3, i / resolution));
    curves.push({ edgeVertexIds: [doc.vertexIds[a], doc.vertexIds[b]], samples });
  };
  for (let q = 0; q < derived.mesh.quadCount; q++) {
    if (protectedQuads.has(q)) continue;
    for (const [a, b] of perimeter(derived.mesh.quads[q])) {
      const neighbors = adjacency.edgeQuads.get(edgeKey(a, b)) ?? [];
      if (neighbors.some(neighbor => protectedQuads.has(neighbor))) append(a, b);
    }
  }
  // A locked feature may FLOAT: a document whose terrain was cut back leaves the locked sheet with no
  // unlocked neighbours at all (as in a flow-sheet rebuild with 47 separate surfaces). Its rim is
  // then the locked set's own boundary: edges used by exactly one quad, that quad protected. In a welded
  // document every such edge has an unlocked neighbour and is already captured above.
  //
  // "Floats" is a property of the whole protected COMPONENT, not of one quad. A selected-region solve
  // (`prepareSelectedRetopology`) protects the entire rest of the mountain, so the ambient terrain's own
  // outer rim is also one-quad-per-edge — testing quads individually would drag the mountain rim in as an
  // interface it never borders. A component that touches the remesh region anywhere is already stitched by
  // the loop above and contributes no rim of its own.
  for (const component of protectedComponents(derived.mesh, adjacency, protectedQuads)) {
    const touchesRemesh = component.some(q => (derived.mesh.quads[q] ? perimeter(derived.mesh.quads[q]) : [])
      .some(([a, b]) => (adjacency.edgeQuads.get(edgeKey(a, b)) ?? [])
        .some(neighbor => !protectedQuads.has(neighbor))));
    if (touchesRemesh) continue;
    for (const q of component) {
      const quad = derived.mesh.quads[q];
      if (!quad) continue;
      for (const [a, b] of perimeter(quad)) {
        if ((adjacency.edgeQuads.get(edgeKey(a, b)) ?? []).length === 1) append(a, b);
      }
    }
  }
  // A completed integration may put additional candidate vertices *inside* an exact protected edge. Those
  // vertices are explicit T-nodes, so the candidate's short edge segments are not ordinary adjacency matches
  // for the unsplit protected edge. Restore that host edge to the interface or a second retopo sees an open
  // protected chain (degree 1) instead of the same closed loop used by the first solve.
  for (const junction of doc.tJunctions ?? []) {
    const [a, b] = junction.edge, neighbors = adjacency.edgeQuads.get(edgeKey(a, b)) ?? [];
    if (neighbors.filter(quad => protectedQuads.has(quad)).length === 1) append(a, b);
  }
  return curves;
}

/** Prepare the external-tool input and the constraint sidecar from one live or migrated SlopeSmith document. */
export function prepareRetopologyBenchmark(
  doc: QuadMeshDoc,
  requested: Partial<RetopologyBenchmarkOptions> = {},
): PreparedRetopologyBenchmark {
  const options: RetopologyBenchmarkOptions = {
    collarRings: Math.max(0, Math.min(3, Math.floor(requested.collarRings ?? DEFAULT_OPTIONS.collarRings))),
    targetPatchSizeM: Math.max(.01, requested.targetPatchSizeM ?? DEFAULT_OPTIONS.targetPatchSizeM),
    // Resolution 1 is useful for topology-only solves: it exposes one boundary segment per authored patch
    // edge, then the integration stage fits the resulting layout back to the original bicubic surface.
    tessellationResolution: Math.max(1, Math.floor(requested.tessellationResolution ?? DEFAULT_OPTIONS.tessellationResolution)),
    wholeSurface: requested.wholeSurface === true,
    regularizeCandidate: requested.regularizeCandidate === true,
    refineBoundaryCorners: requested.refineBoundaryCorners !== false,
    arcLengthInterfaceParameters: requested.arcLengthInterfaceParameters === true,
  };
  const locked = new Set<number>();
  for (const key of Object.keys(doc.quadLocked ?? {})) if (doc.quadLocked?.[Number(key)] === true) locked.add(Number(key));
  if (!locked.size) throw new Error('Retopology benchmark needs at least one locked patch to define the preserved region');
  const lockedGuideQuads = protectedQuadSet(doc, 0);
  const protectedQuads = options.wholeSurface ? new Set<number>() : protectedQuadSet(doc, options.collarRings);
  const remeshQuads = new Set(Array.from({ length: doc.quads.length }, (_, q) => q)
    .filter(q => options.wholeSurface || !protectedQuads.has(q)));
  if (!remeshQuads.size) throw new Error('The protected region and collar cover the whole mountain');
  const input = tessellateQuads(doc, remeshQuads, options.tessellationResolution);
  const protectedMesh = tessellateQuads(doc, options.wholeSurface ? lockedGuideQuads : protectedQuads, options.tessellationResolution);
  const sourceAreaM2 = polygonArea(input);
  const warnings: string[] = [];
  if (doc.tJunctions?.length) warnings.push(
    `${doc.tJunctions.length} T-junction(s) are present; candidates should be checked for manifold preprocessing changes.`,
  );
  const targetFaces = Math.max(1, Math.round(sourceAreaM2 / (options.targetPatchSizeM ** 2)));
  return {
    input,
    protected: protectedMesh,
    constraints: {
      version: 1,
      sourceName: doc.name,
      options,
      lockedQuadIds: [...locked].sort((a, b) => a - b).map(q => doc.quadIds[q]),
      protectedQuadIds: [...protectedQuads].sort((a, b) => a - b).map(q => doc.quadIds[q]),
      remeshQuadIds: [...remeshQuads].sort((a, b) => a - b).map(q => doc.quadIds[q]),
      // Field guidance needs the actual curve even when the topology input deliberately uses resolution 1.
      interface: interfaceCurves(doc, options.wholeSurface ? lockedGuideQuads : protectedQuads,
        Math.max(8, options.tessellationResolution)),
      sourceAreaM2,
      targetFaces,
      warnings,
    },
  };
}

/** Prepare one connected selected patch region. The selected region plus influence rings is the only topology
 * supplied to the solver; every other patch and every locked patch is an exact protected surface. Consequently
 * its outer selection boundary and any locked islands inside it are handled by the same plural loop integrator. */
export function prepareSelectedRetopology(
  doc: QuadMeshDoc,
  selectedQuadIds: readonly string[],
  influenceRings: number,
  requested: Partial<RetopologyBenchmarkOptions> = {},
): PreparedRetopologyBenchmark {
  const byId = new Map(doc.quadIds.map((id, quad) => [id, quad]));
  const selected = new Set<number>();
  for (const id of selectedQuadIds) {
    const quad = byId.get(id);
    if (quad === undefined) throw new Error(`Selected patch ${id} is no longer part of the mountain`);
    selected.add(quad);
  }
  if (!selected.size) throw new Error('Select one connected patch region before regional retopology');
  const selectedRegions = quadRegionCount(doc, selected);
  if (selectedRegions !== 1) throw new Error(`Selected-region retopology requires one connected patch region; found ${selectedRegions}`);
  const topology = deriveQuadMesh(doc).mesh.topology;
  const rimQuads = new Set<number>();
  for (let quad = 0; quad < doc.quads.length; quad++) if ((topology.cellEdges[quad] ?? [])
    .some(edge => (topology.edgeCells[edge] ?? []).length === 1)) rimQuads.add(quad);
  if ([...selected].some(quad => rimQuads.has(quad))) {
    throw new Error('Selected-region retopology must leave at least one frozen patch ring at the mountain rim');
  }

  const options: RetopologyBenchmarkOptions = {
    collarRings: 0,
    targetPatchSizeM: Math.max(.01, requested.targetPatchSizeM ?? DEFAULT_OPTIONS.targetPatchSizeM),
    tessellationResolution: Math.max(1, Math.floor(requested.tessellationResolution ?? DEFAULT_OPTIONS.tessellationResolution)),
    wholeSurface: false,
    regularizeCandidate: requested.regularizeCandidate === true,
    refineBoundaryCorners: requested.refineBoundaryCorners !== false,
    arcLengthInterfaceParameters: requested.arcLengthInterfaceParameters === true,
  };
  const locked = protectedQuadSet(doc, 0);
  const influenced = growQuadSet(doc, selected, influenceRings);
  // Influence is allowed to spread toward the rim, but it never consumes that final exact host ring.
  for (const quad of rimQuads) influenced.delete(quad);
  const remeshQuads = new Set([...influenced].filter(quad => !locked.has(quad)));
  if (!remeshQuads.size) throw new Error('The selected region contains only locked patches');
  const protectedQuads = new Set(Array.from({ length: doc.quads.length }, (_unused, quad) => quad)
    .filter(quad => !remeshQuads.has(quad)));
  const input = tessellateQuads(doc, remeshQuads, options.tessellationResolution);
  const protectedMesh = tessellateQuads(doc, protectedQuads, options.tessellationResolution);
  const sourceAreaM2 = polygonArea(input);
  const warnings: string[] = [];
  if (doc.tJunctions?.length) warnings.push(
    `${doc.tJunctions.length} T-junction(s) are present; candidates should be checked for manifold preprocessing changes.`,
  );
  return {
    input,
    protected: protectedMesh,
    constraints: {
      version: 1,
      sourceName: doc.name,
      options,
      lockedQuadIds: [...locked].sort((a, b) => a - b).map(quad => doc.quadIds[quad]),
      protectedQuadIds: [...protectedQuads].sort((a, b) => a - b).map(quad => doc.quadIds[quad]),
      remeshQuadIds: [...remeshQuads].sort((a, b) => a - b).map(quad => doc.quadIds[quad]),
      interface: interfaceCurves(doc, protectedQuads, Math.max(8, options.tessellationResolution)),
      sourceAreaM2,
      targetFaces: Math.max(1, Math.round(sourceAreaM2 / (options.targetPatchSizeM ** 2))),
      warnings,
    },
  };
}
