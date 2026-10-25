import { surfaceStyle, type QuadMeshDoc, type SurfaceObject } from '../doc/types';
import type { MeshAdjacency, QuadMesh } from './topology';
import { CREASE_DEGREES } from './creases';
import { guideCharts } from './surface-guides';
import { patchNormal } from '../math/bezier';
import type { Patch } from './loft-surface';

/** Shading reads the quilt's buffers and connectivity without depending on its tessellation implementation. */
interface SurfaceShadingData {
  normals: Float32Array;
  colors: Float32Array;
  facesPerCell: number;
  cellSurf: readonly number[];
  parity: readonly number[];
  mesh: Pick<QuadMesh, 'quads'>;
  adjacency: Pick<MeshAdjacency, 'edgeQuads'>;
}

const rawNormals = new WeakMap<SurfaceShadingData, { normals: Map<number, Float32Array>; owners: Set<number> }>();

/** Carry the analytic seam inputs alongside a worker's already-blended display normals. */
export function surfaceRawNormals(preview: SurfaceShadingData, quad: number, size: number): Float32Array {
  return rawNormals.get(preview)?.normals.get(quad) ?? preview.normals.subarray(quad * size, (quad + 1) * size);
}

export function adoptSurfaceRawNormals(
  preview: SurfaceShadingData,
  quads: readonly number[],
  normals: Float32Array,
  size: number,
) {
  const state = rawNormals.get(preview);
  if (!state) return;
  quads.forEach((quad, i) => {
    if (state.owners.has(quad)) state.normals.set(quad, normals.slice(i * size, (i + 1) * size));
  });
}

/** Smooth fitted seams according to the source curves, rather than treating fitting error as a crease. */
export function applySurfaceShading(
  doc: QuadMeshDoc,
  preview: SurfaceShadingData,
  changed?: ReadonlySet<number>,
): Set<number> {
  if (!doc.surfaces?.length && !rawNormals.has(preview)) return new Set<number>();
  const owners = new Map<number, string>(),
    domains = new Map<number, SurfaceObject['patches'][number]>(),
    indices = new Map(doc.quadIds.map((id, q) => [id, q]));
  for (const surface of doc.surfaces ?? [])
    for (const patch of surface.patches) {
      const q = indices.get(patch.quad);
      if (q !== undefined) {
        owners.set(q, surface.id);
        domains.set(q, patch);
      }
    }
  const updated = new Set<number>();
  const res = Math.round(Math.sqrt(preview.facesPerCell / 2)),
    side = res + 1,
    count = side * side;
  let state = rawNormals.get(preview);
  if (!state) {
    state = { normals: new Map(), owners: new Set() };
    rawNormals.set(preview, state);
  }
  const raw = state.normals;
  for (const q of state.owners)
    if (!owners.has(q)) {
      if (raw.has(q)) preview.normals.set(raw.get(q)!, q * count * 3);
      const tint = surfaceStyle(preview.cellSurf[q]).color,
        shade = preview.parity[q] === 0 ? 1 : 0.93;
      for (let i = q * count * 3; i < (q + 1) * count * 3; i++) preview.colors[i] = tint[i % 3] * shade;
      raw.delete(q);
      updated.add(q);
    }
  const ownershipChanged = state.owners.size !== owners.size || [...owners.keys()].some(q => !state.owners.has(q));
  state.owners = new Set(owners.keys());
  if (!owners.size || (!ownershipChanged && changed && ![...changed].some(q => owners.has(q)))) return updated;
  const touched = changed && !ownershipChanged ? new Set([...changed].map(q => owners.get(q))) : undefined,
    active = touched ? new Map([...owners].filter(([, owner]) => touched.has(owner))) : owners;
  for (const q of owners.keys()) {
    if (!raw.has(q) || !changed || changed.has(q))
      raw.set(q, preview.normals.slice(q * count * 3, (q + 1) * count * 3));
  }
  const parent = new Map<number, number>();
  const root = (i: number): number => {
    let at = i;
    while (parent.get(at)! !== at) at = parent.get(at)!;
    while (i !== at) {
      const next = parent.get(i)!;
      parent.set(i, at);
      i = next;
    }
    return at;
  };
  const samples = (q: number, a: number, b: number) => {
    const [A, B, C, D] = preview.mesh.quads[q];
    for (const [x, y, slot] of [
      [A, B, 0],
      [B, D, 1],
      [D, C, 2],
      [C, A, 3],
    ])
      if ((x === a && y === b) || (x === b && y === a)) {
        return Array.from({ length: side }, (_, i) => {
          const t = x === a ? i : res - i;
          const local =
            slot === 0 ? t : slot === 1 ? t * side + res : slot === 2 ? res * side + res - t : (res - t) * side;
          return q * count + local;
        });
      }
    return [];
  };
  const normal = (i: number, d: number) => raw!.get(Math.floor(i / count))![(i % count) * 3 + d];
  type SourceSample = { chart?: Patch; u: number; v: number; normal?: number[] };
  const sources = new Map<string, Patch[] | undefined>(),
    sourceNormals = new Map<number, SourceSample>();
  const sourceSample = (i: number): SourceSample => {
    const cached = sourceNormals.get(i);
    if (cached) return cached;
    const q = Math.floor(i / count),
      owner = owners.get(q)!,
      output = domains.get(q)!;
    if (!sources.has(owner)) {
      const surface = doc.surfaces!.find(s => s.id === owner)!;
      try {
        sources.set(owner, surface.guides?.length ? guideCharts(doc, surface) : undefined);
      } catch {
        // Invalid authoring history must not prevent the existing terrain from rendering.
        sources.set(owner, undefined);
      }
    }
    const sample: SourceSample = { u: 0, v: 0 };
    const charts = sources.get(owner);
    if (charts) {
      const u = Math.floor((i % count) / side) / res,
        v = (i % side) / res,
        d = output.domain,
        uv = output.uv ?? [
          [d[0], d[2]],
          [d[0], d[3]],
          [d[1], d[2]],
          [d[1], d[3]],
        ],
        // Sample the source on this patch's side of a shared boundary, preserving intentional creases.
        s = u + (0.5 - u) * 1e-7,
        t = v + (0.5 - v) * 1e-7,
        at = [0, 1].map(
          k => (1 - s) * (1 - t) * uv[0][k] + (1 - s) * t * uv[1][k] + s * (1 - t) * uv[2][k] + s * t * uv[3][k],
        ),
        chart = charts.find(
          p => at[0] >= p.domain[0] && at[0] <= p.domain[1] && at[1] >= p.domain[2] && at[1] <= p.domain[3],
        );
      if (chart) {
        sample.chart = chart;
        sample.u = (at[0] - chart.domain[0]) / (chart.domain[1] - chart.domain[0]);
        sample.v = (at[1] - chart.domain[2]) / (chart.domain[3] - chart.domain[2]);
      }
    }
    sourceNormals.set(i, sample);
    return sample;
  };
  const creaseNormal = (i: number, s: SourceSample) =>
    (s.normal ??= s.chart ? patchNormal(s.chart.controls, s.u, s.v) : [normal(i, 0), normal(i, 1), normal(i, 2)]);
  const borders = new Set<number>();
  for (const q of active.keys())
    for (let i = 0; i < side; i++)
      for (const local of [i, res * side + i, i * side, i * side + res]) borders.add(q * count + local);
  const limit = Math.cos((CREASE_DEGREES * Math.PI) / 180);
  for (const [key, quads] of preview.adjacency.edgeQuads) {
    if (quads.length !== 2 || !active.has(quads[0]) || owners.get(quads[0]) !== owners.get(quads[1])) continue;
    const [a, b] = key.split(',').map(Number),
      x = samples(quads[0], a, b),
      y = samples(quads[1], a, b);
    if (
      !x.length ||
      x.some((v, i) => {
        const a = sourceSample(v),
          b = sourceSample(y[i]);
        // Most fitted edges lie inside a single smooth source chart; no derivative evaluation is needed.
        if (a.chart && a.chart === b.chart) return false;
        return creaseNormal(v, a).reduce((sum, n, d) => sum + n * creaseNormal(y[i], b)[d], 0) < limit;
      })
    )
      continue;
    x.forEach((v, i) => {
      const w = y[i];
      if (!parent.has(v)) parent.set(v, v);
      if (!parent.has(w)) parent.set(w, w);
      parent.set(root(v), root(w));
    });
  }
  const sums = new Map<number, number[]>();
  for (const v of parent.keys()) {
    const id = root(v),
      sum = sums.get(id) ?? [0, 0, 0];
    for (let d = 0; d < 3; d++) sum[d] += normal(v, d);
    sums.set(id, sum);
  }
  for (const sum of sums.values()) {
    const length = Math.hypot(...sum);
    for (let d = 0; d < 3; d++) sum[d] = Math.fround(sum[d] / length);
  }
  for (const v of borders) {
    const average = parent.has(v) ? sums.get(root(v)) : undefined;
    for (let d = 0; d < 3; d++) {
      const value = average?.[d] ?? normal(v, d),
        at = v * 3 + d;
      if (preview.normals[at] !== value) {
        preview.normals[at] = value;
        updated.add(Math.floor(v / count));
      }
    }
  }
  return updated;
}
