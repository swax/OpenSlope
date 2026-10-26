import type { QuadMeshDoc, SurfaceObject, V3 } from '../doc/types';
import { appendMeshIds, nameIndex } from '../doc/ids';
import { add, sub, mul, dot, len } from '../math/vec';
import { patchNormal } from '../math/bezier';
import {
  greville,
  insertSplineRow,
  removeSplineKnot,
  splineCharts,
  splineFromCharts,
  compactSurfaceCharts,
  type SplineNet,
  type SurfaceAxis,
} from '../math/spline-surface';
import { installSurfaceCharts, type Patch } from './loft-surface';
import { fitSurface, surfaceFitTolerance } from './surface-fit';
import { materializeSurfaceShape } from './surface-source';
import { meshFromDoc, quadControlPoints } from './topology';
import { finishMeshRewrite } from './ops/contract';
import { readVertex } from './primitives';
import {
  addGuide,
  detachGuide,
  appendGuide,
  curveAt,
  chartPoint,
  evaluateCharts,
  guideCharts,
  guideCuts,
  guideRows,
  isSurfaceBoundaryGuide,
  readGuideCurves,
  sourceGuideSurface,
  splitGuide,
  sectionCurve,
  GUIDE_STATION_EPS,
  type GuideCurve,
} from './surface-guides';
import { splitCubic } from '../math/bezier';
import { inferSurfaceCorners } from './surface-corners';
import {
  evaluateSurfaceStitches,
  refreshSurfaceStitches,
  detachSurfaceStitches,
  bakeSurfaceStitchLinks,
  surfaceHasStitches,
} from './surface-stitch';

export type SurfaceResult =
  { ok: true; doc: QuadMeshDoc; surface: SurfaceObject; deviationM?: number } | { ok: false; error: string };
const failure = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});
// Register round-trips convert edge offsets to absolute controls and back. Ignore their sub-nanometre noise.
const sameSourcePoints = (a: V3[][], b: V3[][]) =>
  a.length === b.length &&
  a.every(
    (row, i) => row.length === b[i].length && row.every((p, j) => p.every((n, k) => Math.abs(n - b[i][j][k]) < 1e-9)),
  );
// A drag redistributes spacing with the same grid dimensions. Check the error budget at release.
// This is transient editor state: saved documents always contain usable evaluated terrain.
const layoutPending = new WeakSet<SurfaceObject>();

/** Worker previews have the same provisional layout contract as previews evaluated in this realm. */
export function markSurfaceLayoutsPending(doc: QuadMeshDoc, ids: readonly string[]) {
  for (const s of doc.surfaces ?? []) if (ids.includes(s.id)) layoutPending.add(s);
}
type SurfaceEvaluation = { interactive?: boolean };

export function surfaceNet(doc: QuadMeshDoc, surface: SurfaceObject): SplineNet {
  if (surface.guides) return splineFromCharts(guideCharts(doc, surface));
  const index = nameIndex(doc.vertexIds);
  const points = surface.controls.map(row =>
    row.map(id => {
      const at = index.get(id);
      if (at === undefined) throw new Error('A source control was removed. Undo that edit or bake the surface.');
      const point = readVertex(doc.vertices, at);
      if (point.some(n => !Number.isFinite(n))) throw new Error('A source control has a non-finite position.');
      return point;
    }),
  );
  return { points, knotsU: surface.knotsU, knotsV: surface.knotsV };
}

function cageEdges(controls: string[][]): [string, string][] {
  return controls.flatMap((row, v) =>
    row.flatMap((id, u) => [
      ...(u ? [[row[u - 1], id] as [string, string]] : []),
      ...(v ? [[controls[v - 1][u], id] as [string, string]] : []),
    ]),
  );
}

/** Source cage links are straight control polygons, never additional cubic shape inputs. */
function straightenCage(doc: QuadMeshDoc, surface: SurfaceObject): void {
  if (surface.guides) return;
  const index = nameIndex(doc.vertexIds),
    handles = (doc.edgeHandles ??= {});
  for (const [from, to] of cageEdges(surface.controls)) {
    const a = index.get(from)!,
      b = index.get(to)!;
    const delta = mul(sub(readVertex(doc.vertices, b), readVertex(doc.vertices, a)), 1 / 3);
    handles[`${a}>${b}`] = delta;
    handles[`${b}>${a}`] = mul(delta, -1);
  }
}

function replaceCage(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  net: SplineNet,
): { doc: QuadMeshDoc; surface: SurfaceObject } {
  if (net.points.length * net.points[0].length > 4096)
    throw new Error('A surface can have at most 4,096 source controls.');
  const owned = new Set(surface.controls.flat());
  const indices = new Set(doc.vertexIds.flatMap((id, i) => (owned.has(id) ? [i] : [])));
  if (
    doc.quads.some(q => q.some(v => indices.has(v))) ||
    doc.freeEdges?.some(([a, b]) => indices.has(a) !== indices.has(b))
  )
    throw new Error('Other geometry is attached to this source cage. Undo that attachment before editing rows.');
  const kept = indices.size
    ? finishMeshRewrite(doc, {
        ...doc,
        freeEdges: doc.freeEdges?.filter(([a, b]) => !indices.has(a) && !indices.has(b)),
        keepVertices: doc.vertexIds.flatMap((_, i) => (indices.has(i) ? [] : [i])),
      }).doc
    : doc;
  const start = kept.vertexIds.length,
    count = net.points.length * net.points[0].length;
  const out: QuadMeshDoc = {
    ...kept,
    ...appendMeshIds(kept, count, 0),
    vertices: [...kept.vertices, ...net.points.flat(2)],
    edgeHandles: { ...kept.edgeHandles },
  };
  const controls = net.points.map((row, v) => row.map((_, u) => out.vertexIds[start + v * row.length + u]));
  const next = { ...surface, controls, knotsU: net.knotsU, knotsV: net.knotsV };
  const index = nameIndex(out.vertexIds);
  out.freeEdges = [
    ...(out.freeEdges ?? []),
    ...cageEdges(controls).map(([a, b]) => [index.get(a)!, index.get(b)!] as [number, number]),
  ];
  straightenCage(out, next);
  return { doc: out, surface: next };
}

export function rebuildSurface(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  options: SurfaceEvaluation = {},
): SurfaceResult {
  try {
    if (surface.controls.flat().length > 4096) throw new Error('A surface can have at most 4,096 source controls.');
    if (surface.guides) surface = sourceGuideSurface(surface);
    if (!Number.isFinite(surface.patchSizeM) || surface.patchSizeM < 0.5)
      throw new Error('Patch size must be at least 0.5 metres.');
    if (
      surface.fitToleranceM !== undefined &&
      (!Number.isFinite(surface.fitToleranceM) ||
        surface.fitToleranceM <= 0 ||
        surface.fitToleranceM > surface.patchSizeM)
    )
      throw new Error('Fit error must be positive and no greater than patch size.');
    const qIndex = nameIndex(doc.quadIds);
    for (const patch of surface.patches) {
      const q = qIndex.get(patch.quad);
      if (q === undefined || doc.quads[q].some((v, i) => doc.vertexIds[v] !== patch.corners[i]))
        throw new Error(
          'Generated terrain topology changed. Undo that edit or bake the surface before changing topology.',
        );
    }
    const net = surface.guides ? undefined : surfaceNet(doc, surface),
      // Redundant guide stations do not force edges into the generated terrain grid.
      charts = surface.guides ? compactSurfaceCharts(guideCharts(doc, surface)) : splineCharts(net!);
    const previous = surface.fitted ?? surface.patches;
    const previousU = guideCuts(previous.flatMap(p => p.domain.slice(0, 2))),
      previousV = guideCuts(previous.flatMap(p => p.domain.slice(2)));
    const reuseLayout = !!options.interactive && surface.patches.length > 0;
    const { patches, us, vs } = fitSurface(
      charts,
      surface.patchSizeM,
      reuseLayout ? { us: previousU, vs: previousV } : undefined,
      surface.fitToleranceM,
    );
    if (surfaceHasStitches(doc, surface.id)) {
      const surfaces = doc.surfaces ?? [];
      const next: SurfaceObject = {
        ...surface,
        fitted: patches,
        evaluated: {
          points: surface.guides ? readGuideCurves(doc, surface).map(c => c.points.flat()) : net!.points,
          patchSizeM: surface.patchSizeM,
          ...(surface.fitToleranceM === undefined ? {} : { fitToleranceM: surface.fitToleranceM }),
        },
      };
      const assembled = evaluateSurfaceStitches({
        ...doc,
        surfaces: surfaces.some(s => s.id === next.id)
          ? surfaces.map(s => (s.id === next.id ? next : s))
          : [...surfaces, next],
      });
      const evaluated = assembled.surfaces!.find(s => s.id === next.id)!;
      if (reuseLayout) layoutPending.add(evaluated);
      return { ok: true, doc: assembled, surface: evaluated };
    }
    const installed = installSurfaceCharts(doc, surface, patches, patches, us, vs);
    const next: SurfaceObject = {
      ...surface,
      vertices: installed.vertices,
      patches: installed.patches,
      evaluated: {
        points: surface.guides ? readGuideCurves(doc, surface).map(c => c.points.flat()) : net!.points,
        patchSizeM: surface.patchSizeM,
        ...(surface.fitToleranceM === undefined ? {} : { fitToleranceM: surface.fitToleranceM }),
      },
    };
    delete next.outputKeys;
    delete next.fitted;
    delete next.error;
    if (reuseLayout) layoutPending.add(next);
    const out = installed.doc;
    out.quadLocked = { ...out.quadLocked };
    const installedQuads = nameIndex(out.quadIds);
    next.patches.forEach(p => {
      out.quadLocked![installedQuads.get(p.quad)!] = true;
    });
    out.surfaces = out.surfaces?.some(s => s.id === next.id)
      ? out.surfaces.map(s => (s.id === next.id ? next : s))
      : [...(out.surfaces ?? []), next];
    straightenCage(out, next);
    return { ok: true, doc: out, surface: next };
  } catch (error) {
    return failure(error);
  }
}

function createFromNet(
  doc: QuadMeshDoc,
  net: SplineNet,
  origin: SurfaceObject['origin'],
  inputs: string[],
  patchSizeM: number,
  existing?: Pick<SurfaceObject, 'vertices' | 'patches' | 'name'>,
): SurfaceResult {
  let n = 1;
  while (doc.surfaces?.some(s => s.id === `surface:${n}`)) n++;
  const surface: SurfaceObject = {
    id: `surface:${n}`,
    name: existing?.name ?? `Surface ${n}`,
    origin,
    inputs,
    patchSizeM,
    controls: [],
    knotsU: net.knotsU,
    knotsV: net.knotsV,
    vertices: existing?.vertices ?? [],
    patches: existing?.patches ?? [],
    evaluated: { points: [], patchSizeM: 0 },
  };
  const cage = replaceCage(doc, surface, net);
  return rebuildSurface(cage.doc, cage.surface);
}

function crossing(a: GuideCurve, b: GuideCurve): { u: number; v: number } | undefined {
  let u = 0.5,
    v = 0.5,
    best = Infinity;
  for (let i = 1; i < 32; i++)
    for (let j = 1; j < 32; j++) {
      const distance = len(sub(curveAt(a, i / 32), curveAt(b, j / 32)));
      if (distance < best) {
        best = distance;
        u = i / 32;
        v = j / 32;
      }
    }
  let angle = 0;
  for (let i = 0; i < 20; i++) {
    const derivative = (c: GuideCurve, t: number) => mul(sub(curveAt(c, t + 1e-5), curveAt(c, t - 1e-5)), 50000);
    const A = derivative(a, u),
      B = derivative(b, v),
      r = sub(curveAt(a, u), curveAt(b, v));
    const aa = dot(A, A),
      bb = dot(B, B),
      ab = dot(A, B),
      det = aa * bb - ab * ab;
    angle = Math.abs(ab) / Math.sqrt(aa * bb);
    if (det < 1e-12) return undefined;
    const du = (-bb * dot(A, r) + ab * dot(B, r)) / det,
      dv = (-ab * dot(A, r) + aa * dot(B, r)) / det;
    u = Math.max(0, Math.min(1, u + du));
    v = Math.max(0, Math.min(1, v + dv));
    if (Math.abs(du) + Math.abs(dv) < 1e-10) break;
  }
  return u > 0.01 && u < 0.99 && v > 0.01 && v < 0.99 && angle < 0.95 && len(sub(curveAt(a, u), curveAt(b, v))) < 1e-5
    ? { u, v }
    : undefined;
}

function splitCurve(curve: GuideCurve, t: number): GuideCurve {
  if (curve.knots.some(s => Math.abs(s - t) < 1e-8)) return curve;
  const i = curve.knots.findIndex((hi, j) => j > 0 && hi > t) - 1;
  const parts = splitCubic(
    ...(curve.points[i] as [V3, V3, V3, V3]),
    (t - curve.knots[i]) / (curve.knots[i + 1] - curve.knots[i]),
  );
  return {
    ...curve,
    knots: [...curve.knots.slice(0, i + 1), t, ...curve.knots.slice(i + 1)],
    points: [...curve.points.slice(0, i), parts.left, parts.right, ...curve.points.slice(i + 1)],
  };
}

function createFromGuides(
  doc: QuadMeshDoc,
  curves: GuideCurve[],
  origin: SurfaceObject['origin'],
  inputs: string[],
  patchSizeM: number,
  curvature: number,
  hill = false,
  adopt?: { surface: SurfaceObject; seed: Patch[] },
  fitToleranceM?: number,
): SurfaceResult {
  let n = 1;
  while (doc.surfaces?.some(s => s.id === `surface:${n}`)) n++;
  let surface: SurfaceObject = {
    id: `surface:${n}`,
    name: `Surface ${n}`,
    origin,
    controls: [],
    guides: [],
    interpolation: 'natural',
    curvature,
    ...(fitToleranceM === undefined ? {} : { fitToleranceM }),
    knotsU: [],
    knotsV: [],
    inputs: [...new Set(inputs)],
    patchSizeM,
    vertices: [],
    patches: [],
    evaluated: { points: [], patchSizeM: 0 },
  };
  if (adopt)
    surface = {
      ...surface,
      id: adopt.surface.id,
      name: adopt.surface.name,
      vertices: adopt.surface.vertices,
      patches: adopt.surface.patches,
    };
  let out = doc;
  // Keep the original sketches independently. The visible editable curves are exact owned copies.
  for (let curve of curves) {
    const cross = new Map<number, string>();
    surface.guides!.forEach((g, i) => {
      if (g.axis === curve.axis) return;
      const split = splitGuide(out, surface, i, curve.at);
      out = split.doc;
      surface = split.surface;
      const p = readVertex(out.vertices, out.vertexIds.indexOf(split.id));
      if (len(sub(p, curveAt(curve, g.at))) > 1e-5)
        throw new Error('The control curves do not meet at their crossings.');
      curve = splitCurve(curve, g.at);
      cross.set(g.at, split.id);
    });
    const appended = appendGuide(out, curve, cross);
    out = appended.doc;
    surface = {
      ...surface,
      controls: [...surface.controls, appended.names],
      guides: [...surface.guides!, { axis: curve.axis, at: curve.at, knots: curve.knots }],
    };
  }
  const charts = guideCharts(out, surface);
  if (charts.reduce((sum, p) => sum + patchNormal(p.controls, 0.5, 0.5)[1], 0) < 0) {
    surface.controls = surface.controls.map((row, i) => (surface.guides![i].axis === 'U' ? [...row].reverse() : row));
    surface.guides = surface.guides!.map(g =>
      g.axis === 'U' ? { ...g, knots: [...g.knots].reverse().map(t => 1 - t) } : { ...g, at: 1 - g.at },
    );
  }
  if (hill) {
    // The two arches imply an outline. Make it explicit so adding another guide cannot change an
    // unbounded single-curve basis into a different fill, and every part of the hill stays editable.
    const outline = guideCharts(out, surface);
    for (const axis of ['U', 'V'] as const)
      for (const at of [0, 1]) {
        const added = addGuide(out, surface, axis, 0, at, outline);
        out = added.doc;
        surface = added.surface;
      }
  }
  if (adopt) {
    const visible = materializeSurfaceShape(out, surface, adopt.seed, surfaceFitTolerance(patchSizeM) / 2);
    out = visible.doc;
    surface = visible.surface;
  }
  return rebuildSurface(out, surface);
}

export function createSurfaceFromProfiles(
  doc: QuadMeshDoc,
  profiles: readonly (readonly number[])[],
  settings: {
    patchSizeM?: number;
    curvature?: number;
    fitToleranceM?: number;
    /** Correspondence along each curve, independent of how many source points it carries. */
    pointStations?: readonly (readonly number[])[];
    /** Placement of the profiles across the loft. Omission retains uniform ordering. */
    profileStations?: readonly number[];
  } = {},
): SurfaceResult {
  try {
    const names = profiles.map(row => row.map(i => doc.vertexIds[i]));
    if (names.length < 2) throw new Error('Use at least two control curves.');
    const stations = (values: readonly number[] | undefined, count: number) => {
      if (count < 2) throw new Error('Each profile needs at least two source points.');
      if (!values) return Array.from({ length: count }, (_, i) => i / (count - 1));
      if (
        count < 2 ||
        values.length !== count ||
        values[0] !== 0 ||
        values.at(-1) !== 1 ||
        values.some((t, i) => !Number.isFinite(t) || (i > 0 && t - values[i - 1] < GUIDE_STATION_EPS))
      )
        throw new Error('Profile stations must increase from 0 to 1 and match their source points.');
      return [...values];
    };
    if (settings.pointStations && settings.pointStations.length !== names.length)
      throw new Error('Provide point stations for every profile.');
    const across = stations(settings.profileStations, names.length);
    const guides = names.map((row, i) => ({
      axis: 'U' as const,
      at: across[i],
      knots: stations(settings.pointStations?.[i], row.length),
    }));
    const curves = readGuideCurves(doc, { controls: names, guides } as SurfaceObject);
    const cross = curves.length === 2 ? crossing(curves[0], curves[1]) : undefined;
    if (cross) {
      curves[0].at = cross.v;
      curves[1].axis = 'V';
      curves[1].at = cross.u;
      return createFromGuides(
        doc,
        curves,
        'profiles',
        names.flat(),
        settings.patchSizeM ?? 25,
        settings.curvature ?? 1,
        true,
        undefined,
        settings.fitToleranceM,
      );
    }
    return createFromGuides(
      doc,
      curves,
      'profiles',
      names.flat(),
      settings.patchSizeM ?? 25,
      settings.curvature ?? 1,
      false,
      undefined,
      settings.fitToleranceM,
    );
  } catch (error) {
    return failure(error);
  }
}

/** Order a single topological loop, including free construction curves as well as terrain boundaries. */
export function surfaceBoundaryLoop(
  doc: QuadMeshDoc,
  edges: readonly (readonly number[])[],
): { ok: true; loop: number[] } | { ok: false; error: string } {
  const adjacent = new Map<number, number[]>(),
    keys = new Set<string>();
  for (const edge of edges) {
    const [a, b] = edge;
    if (edge.length !== 2 || a === b || !doc.vertexIds[a] || !doc.vertexIds[b])
      return { ok: false, error: 'Select one valid closed edge loop.' };
    const key = [a, b].sort((x, y) => x - y).join(',');
    if (keys.has(key)) return { ok: false, error: 'The boundary contains a duplicate edge.' };
    keys.add(key);
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
    adjacent.set(b, [...(adjacent.get(b) ?? []), a]);
  }
  if (edges.length < 4 || [...adjacent.values()].some(row => row.length !== 2))
    return { ok: false, error: 'A surface boundary needs one closed, unbranched loop with at least four edges.' };
  const start = Math.min(...adjacent.keys()),
    loop = [start];
  let previous = start,
    current = Math.min(...adjacent.get(start)!);
  while (current !== start && loop.length <= edges.length) {
    loop.push(current);
    const next = adjacent.get(current)!.find(v => v !== previous)!;
    previous = current;
    current = next;
  }
  return loop.length === edges.length && current === start
    ? { ok: true, loop }
    : { ok: false, error: 'Select one connected boundary loop.' };
}

export function boundarySurfaceInput(
  doc: QuadMeshDoc,
  edges: readonly (readonly number[])[],
  corners?: readonly number[],
) {
  const ordered = surfaceBoundaryLoop(doc, edges);
  if (!ordered.ok) throw new Error(ordered.error);
  const loop = ordered.loop;
  const chosen = corners ?? inferSurfaceCorners(loop.map(i => readVertex(doc.vertices, i))).map(i => loop[i]);
  const stops = chosen.map(v => loop.indexOf(v));
  if (chosen.length !== 4 || new Set(chosen).size !== 4 || stops.some(i => i < 0))
    throw new Error('Choose four distinct corners on the selected loop.');
  const offset = stops[0];
  const relative = stops.map(i => (i - offset + loop.length) % loop.length);
  if (relative.some((n, i) => i > 0 && n <= relative[i - 1]))
    throw new Error('The four corners must follow the loop in order.');
  const rotated = [...loop.slice(offset), ...loop.slice(0, offset), loop[offset]];
  const runs = relative.map((at, i) => rotated.slice(at, (relative[i + 1] ?? loop.length) + 1));
  const paths = [runs[0], [...runs[2]].reverse(), [...runs[3]].reverse(), runs[1]];
  const guides = paths.map((row, i) => ({
    axis: i < 2 ? ('U' as const) : ('V' as const),
    at: i % 2,
    knots: row.map((_, j) => j / (row.length - 1)),
  }));
  // A two-point side has no internal shape controls. Missing handles should describe its chord,
  // rather than borrowing automatic tangents from the other sides around the closed loop.
  const source = { ...doc, edgeHandles: { ...doc.edgeHandles } };
  for (const row of paths) {
    if (row.length !== 2) continue;
    const [a, b] = row,
      A = readVertex(doc.vertices, a),
      B = readVertex(doc.vertices, b);
    source.edgeHandles[`${a}>${b}`] ??= mul(sub(B, A), 1 / 3);
    source.edgeHandles[`${b}>${a}`] ??= mul(sub(A, B), 1 / 3);
  }
  const curves = readGuideCurves(source, {
    controls: paths.map(row => row.map(i => doc.vertexIds[i])),
    guides,
  } as SurfaceObject);
  return { loop, curves, paths };
}

/** Exact Coons fill for a boundary draft, without generating or installing terrain patches. */
export function boundarySurfaceCharts(
  doc: QuadMeshDoc,
  edges: readonly (readonly number[])[],
  corners?: readonly number[],
  orient = true,
): Patch[] {
  const { curves } = boundarySurfaceInput(doc, edges, corners),
    [bottom, top, left, right] = curves,
    [a, b, c, d] = [curveAt(bottom, 0), curveAt(bottom, 1), curveAt(top, 0), curveAt(top, 1)];
  const charts = evaluateCharts(
    guideCuts(curves.filter(c => c.axis === 'U').flatMap(c => c.knots)),
    guideCuts(curves.filter(c => c.axis === 'V').flatMap(c => c.knots)),
    (u, v) =>
      sub(
        add(
          add(mul(curveAt(bottom, u), 1 - v), mul(curveAt(top, u), v)),
          add(mul(curveAt(left, v), 1 - u), mul(curveAt(right, v), u)),
        ),
        add(add(mul(a, (1 - u) * (1 - v)), mul(b, u * (1 - v))), add(mul(c, (1 - u) * v), mul(d, u * v))),
      ),
  );
  return orient && charts.reduce((sum, p) => sum + patchNormal(p.controls, 0.5, 0.5)[1], 0) < 0
    ? charts.map(p => ({
        domain: [1 - p.domain[1], 1 - p.domain[0], p.domain[2], p.domain[3]],
        controls: [3, 2, 1, 0].flatMap(i => p.controls.slice(i * 4, i * 4 + 4)),
      }))
    : charts;
}

export function createSurfaceFromBoundary(
  doc: QuadMeshDoc,
  edges: readonly (readonly number[])[],
  corners?: readonly number[],
  patchSizeM = 25,
): SurfaceResult {
  try {
    const { loop, curves } = boundarySurfaceInput(doc, edges, corners);
    return createFromGuides(
      doc,
      curves,
      'boundary',
      loop.map(i => doc.vertexIds[i]),
      patchSizeM,
      1,
    );
  } catch (error) {
    return failure(error);
  }
}

export function insertSurfaceRow(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  axis: SurfaceAxis,
  row: number,
): SurfaceResult {
  try {
    if (surface.guides) {
      const added = addGuide(doc, surface, axis, row);
      return installGuideEdit(added.doc, added.surface, guideCharts(doc, surface));
    }
    const net = surfaceNet(doc, surface),
      knots = axis === 'U' ? net.knotsU : net.knotsV;
    const index = Math.min(Math.max(0, row), knots.length - 6);
    const t = (greville(knots, index) + greville(knots, index + 1)) / 2;
    const cage = replaceCage(doc, surface, insertSplineRow(net, axis, t));
    return rebuildSurface(cage.doc, cage.surface);
  } catch (error) {
    return failure(error);
  }
}

function installGuideEdit(doc: QuadMeshDoc, surface: SurfaceObject, before?: Patch[]): SurfaceResult {
  if (surface.controls.flat().length > 4096) throw new Error('A surface can have at most 4,096 source controls.');
  const clean = sourceGuideSurface(surface),
    charts = guideCharts(doc, clean),
    previous = doc.surfaces?.find(s => s.id === surface.id);
  // A redundant new section or exact Bezier split does not need to regenerate fitted terrain.
  if (
    !before ||
    previous?.seed ||
    previous?.guides?.some(g => g.reference) ||
    !before.every(p =>
      [0, 0.25, 0.5, 0.75, 1].every(u =>
        [0, 0.25, 0.5, 0.75, 1].every(v => {
          const x = p.domain[0] + u * (p.domain[1] - p.domain[0]),
            y = p.domain[2] + v * (p.domain[3] - p.domain[2]);
          return len(sub(chartPoint(before, x, y), chartPoint(charts, x, y))) < 1e-7;
        }),
      ),
    )
  )
    return rebuildSurface(doc, clean);
  const curves = readGuideCurves(doc, clean),
    next = {
      ...clean,
      evaluated: {
        points: curves.map(c => c.points.flat()),
        patchSizeM: surface.patchSizeM,
        ...(surface.fitToleranceM === undefined ? {} : { fitToleranceM: surface.fitToleranceM }),
      },
    };
  delete next.error;
  return { ok: true, doc: { ...doc, surfaces: doc.surfaces!.map(s => (s.id === next.id ? next : s)) }, surface: next };
}

/** Sample a visible curve on the current surface. A moved curve replaces its old shape constraint. */
export function placeSurfaceGuide(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  axis: SurfaceAxis,
  at: number,
  replace?: number,
): SurfaceResult {
  try {
    if (!surface.guides) throw new Error('Convert this surface to control curves before placing guides.');
    const charts = compactSurfaceCharts(guideCharts(doc, surface));
    let base = { doc, surface: sourceGuideSurface(surface) };
    if (replace !== undefined) {
      if (surface.guides[replace]?.axis !== axis) throw new Error('Select a control curve in this direction.');
      if (Math.abs(surface.guides[replace].at - at) < GUIDE_STATION_EPS) return { ok: true, doc, surface };
      base = detachGuide(doc, base.surface, replace);
    }
    const added = addGuide(base.doc, base.surface, axis, 0, at, charts);
    return installGuideEdit(added.doc, added.surface, charts);
  } catch (error) {
    return failure(error);
  }
}

/** Remove one source point and reconnect its neighbouring curve segments. */
function detachSurfacePoint(doc: QuadMeshDoc, surface: SurfaceObject, curve: number, point: number) {
  const names = surface.controls[curve],
    guide = surface.guides?.[curve];
  if (!guide || point <= 0 || point >= names.length - 1 || !Number.isInteger(point))
    throw new Error('Keep the two curve endpoints.');
  const id = names[point];
  if (surface.controls.some((row, i) => i !== curve && row.includes(id)))
    throw new Error('This point joins crossing curves. Reposition or remove the crossing curve instead.');
  const [a, v, b] = [names[point - 1], id, names[point + 1]].map(id => doc.vertexIds.indexOf(id));
  if (
    doc.quads.some(q => q.includes(v)) ||
    doc.freeEdges?.some(([x, y]) => (x === v && y !== a && y !== b) || (y === v && x !== a && x !== b))
  )
    throw new Error('Other geometry is attached to this control point.');
  const c = readGuideCurves(doc, surface)[curve],
    left = c.points[point - 1],
    right = c.points[point];
  const span = guide.knots[point + 1] - guide.knots[point - 1];
  const controls = surface.controls.map((row, i) => (i === curve ? row.filter((_, j) => j !== point) : row));
  const guides = surface.guides!.map((g, i) =>
    i === curve ? { ...g, reference: undefined, knots: g.knots.filter((_, j) => j !== point) } : g,
  );
  const edgeHandles = { ...doc.edgeHandles };
  edgeHandles[`${a}>${b}`] = mul(sub(left[1], left[0]), span / (guide.knots[point] - guide.knots[point - 1]));
  edgeHandles[`${b}>${a}`] = mul(sub(right[2], right[3]), span / (guide.knots[point + 1] - guide.knots[point]));
  const out = finishMeshRewrite(doc, {
    ...doc,
    edgeHandles,
    freeEdges: [...(doc.freeEdges ?? []).filter(([x, y]) => x !== v && y !== v), [Math.min(a, b), Math.max(a, b)]],
    keepVertices: doc.vertexIds.flatMap((_, i) => (i === v ? [] : [i])),
  }).doc;
  return { doc: out, surface: { ...surface, controls, guides } };
}

export function removeSurfacePoint(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  curve: number,
  point: number,
): SurfaceResult {
  if (!surface.guides?.[curve] || !surface.controls[curve]?.[point])
    return failure(new Error('Select a control point.'));
  return deleteSurfaceControls(doc, surface, { points: [surface.controls[curve][point]] });
}

/** Delete shape constraints. Only the remaining visible curves define the rebuilt terrain. */
export function deleteSurfaceControls(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  remove: { curves?: readonly number[]; points?: readonly string[] },
): SurfaceResult {
  try {
    if (!surface.guides) throw new Error('Select a surface control curve or point.');
    const deleted = new Set(remove.curves ?? []);
    if (!deleted.size && !remove.points?.length) throw new Error('Select a control curve or point to delete.');
    if ([...deleted].some(i => !Number.isInteger(i) || !surface.guides![i]))
      throw new Error('That control curve no longer exists.');
    if ([...deleted].some(i => isSurfaceBoundaryGuide(surface, i)))
      throw new Error('Keep the surface boundary curves. Move their points or tangents to reshape the outline.');
    if (surface.guides.length - deleted.size < 2)
      throw new Error('Keep at least two curves to define the surface extent.');
    const points = new Set(remove.points ?? []),
      onDeleted = new Set([...deleted].flatMap(i => surface.controls[i]));
    for (const point of points)
      if (!surface.controls.some(row => row.includes(point)))
        throw new Error('That surface control point no longer exists.');
    let base = { doc, surface: sourceGuideSurface(surface) };
    for (const curve of [...deleted].sort((a, b) => b - a)) base = detachGuide(base.doc, base.surface, curve);
    for (let curve = 0; curve < base.surface.controls.length; curve++) {
      const row = base.surface.controls[curve],
        selected = row.filter(id => points.has(id) && !onDeleted.has(id));
      if (!selected.length) continue;
      for (const point of selected) {
        const at = base.surface.controls[curve].indexOf(point);
        base = detachSurfacePoint(base.doc, base.surface, curve, at);
      }
      // Rebuild smooth Hermite tangents from the remaining controls rather than keeping the deleted
      // point's bulge in its neighbours' handles. Parameter spacing is retained at shared crossings.
      const guide = base.surface.guides![curve],
        names = base.surface.controls[curve],
        positions = names.map(id => readVertex(base.doc.vertices, base.doc.vertexIds.indexOf(id))),
        handles = { ...base.doc.edgeHandles };
      const tangent = (i: number) => {
        const a = Math.max(0, i - 1),
          b = Math.min(names.length - 1, i + 1);
        return mul(sub(positions[b], positions[a]), 1 / (guide.knots[b] - guide.knots[a]));
      };
      for (let i = 0; i < names.length - 1; i++) {
        const a = base.doc.vertexIds.indexOf(names[i]),
          b = base.doc.vertexIds.indexOf(names[i + 1]),
          h = (guide.knots[i + 1] - guide.knots[i]) / 3;
        handles[`${a}>${b}`] = mul(tangent(i), h);
        handles[`${b}>${a}`] = mul(tangent(i + 1), -h);
      }
      base.doc = { ...base.doc, edgeHandles: handles };
    }
    return rebuildSurface(base.doc, sourceGuideSurface(base.surface));
  } catch (error) {
    return failure(error);
  }
}

export function placeSurfacePoint(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  curve: number,
  at: number,
  replace?: number,
): SurfaceResult {
  try {
    if (!surface.guides?.[curve]) throw new Error('Select a control curve.');
    if (!Number.isFinite(at) || at <= GUIDE_STATION_EPS || at >= 1 - GUIDE_STATION_EPS)
      throw new Error('Place the point between the curve endpoints.');
    if (surface.guides[curve].knots.some((t, i) => i !== replace && Math.abs(t - at) < GUIDE_STATION_EPS))
      throw new Error('A control point already occupies that position.');
    const charts = guideCharts(doc, surface);
    let base = { doc, surface: sourceGuideSurface(surface) };
    if (replace !== undefined) base = detachSurfacePoint(doc, base.surface, curve, replace);
    const split = splitGuide(base.doc, base.surface, curve, at);
    if (replace !== undefined) {
      const g = split.surface.guides![curve];
      const point = chartPoint(charts, g.axis === 'U' ? at : g.at, g.axis === 'U' ? g.at : at);
      split.doc.vertices.splice(split.doc.vertexIds.indexOf(split.id) * 3, 3, ...point);
    }
    return installGuideEdit(split.doc, split.surface, charts);
  } catch (error) {
    return failure(error);
  }
}

export function surfaceRowRemoval(doc: QuadMeshDoc, surface: SurfaceObject, axis: SurfaceAxis, row: number) {
  const net = surfaceNet(doc, surface),
    knots = axis === 'U' ? net.knotsU : net.knotsV;
  if (!Number.isInteger(row) || row <= 0 || row >= knots.length - 5)
    throw new Error('Keep the two outer control rows.');
  const t = greville(knots, row);
  let at = 4;
  for (let i = 5; i < knots.length - 4; i++) if (Math.abs(knots[i] - t) < Math.abs(knots[at] - t)) at = i;
  return removeSplineKnot(net, axis, at);
}

export function deleteSurfaceRow(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  axis: SurfaceAxis,
  row: number,
): SurfaceResult {
  try {
    if (surface.guides) {
      if (surface.guides.length <= 1) throw new Error('Keep one editable control curve.');
      const at = guideRows(surface, axis)[row];
      if (at === undefined) throw new Error('Select a control curve to remove.');
      return deleteSurfaceControls(doc, surface, { curves: [at] });
    }
    const removed = surfaceRowRemoval(doc, surface, axis, row);
    const cage = replaceCage(doc, surface, removed.net),
      result = rebuildSurface(cage.doc, cage.surface);
    return result.ok ? { ...result, deviationM: removed.deviationM } : result;
  } catch (error) {
    return failure(error);
  }
}

/** Construction components used by other geometry or another live object must survive cleanup. */
function unusedSurfaceConstruction(doc: QuadMeshDoc, surface: SurfaceObject, removedQuads?: ReadonlySet<string>) {
  const candidate = new Set([...surface.controls.flat(), ...surface.inputs]);
  const index = nameIndex(doc.vertexIds);
  const removable = new Set([...candidate].flatMap(id => (index.has(id) ? [index.get(id)!] : [])));
  const protectedVertices = new Set(doc.quads.flatMap((q, i) => (removedQuads?.has(doc.quadIds[i]) ? [] : q)));
  for (const other of doc.surfaces ?? [])
    if (other.id !== surface.id)
      for (const name of [...other.controls.flat(), ...other.inputs, ...other.vertices]) {
        const v = index.get(name);
        if (v !== undefined) protectedVertices.add(v);
      }
  for (const loft of doc.lofts ?? [])
    for (const name of loft.profiles.flat()) {
      const v = index.get(name);
      if (v !== undefined) protectedVertices.add(v);
    }
  for (const [a, b] of doc.freeEdges ?? []) {
    if (removable.has(a) !== removable.has(b)) {
      protectedVertices.add(a);
      protectedVertices.add(b);
    }
  }
  const adjacent = new Map<number, number[]>();
  for (const [a, b] of doc.freeEdges ?? [])
    if (removable.has(a) && removable.has(b)) {
      adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
      adjacent.set(b, [...(adjacent.get(b) ?? []), a]);
    }
  const pending = [...protectedVertices];
  while (pending.length) {
    const v = pending.pop()!;
    if (!removable.delete(v)) continue;
    pending.push(...(adjacent.get(v) ?? []));
  }
  return removable;
}

export function bakeSurface(doc: QuadMeshDoc, id: string): QuadMeshDoc {
  doc = bakeSurfaceStitchLinks(doc, id);
  const surface = doc.surfaces?.find(s => s.id === id);
  if (!surface) return doc;
  // A bake keeps the evaluated terrain, not coincident copies of its hidden sketches and guides.
  const removable = unusedSurfaceConstruction(doc, surface);
  const out: QuadMeshDoc = { ...doc, quadLocked: { ...doc.quadLocked } },
    remaining = doc.surfaces?.filter(s => s.id !== id);
  surface.patches.forEach(p => {
    delete out.quadLocked![doc.quadIds.indexOf(p.quad)];
  });
  if (!Object.keys(out.quadLocked!).length) delete out.quadLocked;
  if (remaining?.length) out.surfaces = remaining;
  else delete out.surfaces;
  if (!removable.size) return out;
  return finishMeshRewrite(out, {
    ...out,
    freeEdges: out.freeEdges?.filter(([a, b]) => !removable.has(a) && !removable.has(b)),
    keepVertices: out.vertexIds.flatMap((_, i) => (removable.has(i) ? [] : [i])),
  }).doc;
}

export function deleteSurfaceObject(
  doc: QuadMeshDoc,
  id: string,
): { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  try {
    if (
      doc.surfaces?.some(s =>
        s.stitches?.some(st => s.id === id || ('surface' in st.target && st.target.surface === id)),
      )
    )
      doc = detachSurfaceStitches(doc, id);
    const surface = doc.surfaces?.find(s => s.id === id);
    if (!surface) throw new Error('That surface no longer exists.');
    const ownNames = new Set([...surface.controls.flat(), ...surface.vertices]);
    const owned = new Set(doc.vertexIds.flatMap((name, i) => (ownNames.has(name) ? [i] : [])));
    const ownQuads = new Set(surface.patches.map(p => p.quad));
    const source = new Set(surface.controls.flat());
    if (
      doc.quads.some((q, i) => !ownQuads.has(doc.quadIds[i]) && q.some(v => owned.has(v))) ||
      doc.freeEdges?.some(
        ([a, b]) => (owned.has(a) || owned.has(b)) && !(source.has(doc.vertexIds[a]) && source.has(doc.vertexIds[b])),
      )
    )
      throw new Error('Other geometry is attached to this surface. Bake it before deleting the attached mesh.');
    const inputs = new Set(surface.inputs);
    for (const v of unusedSurfaceConstruction(doc, surface, ownQuads)) if (inputs.has(doc.vertexIds[v])) owned.add(v);
    const remaining = doc.surfaces!.filter(s => s.id !== id);
    const base = { ...doc, surfaces: remaining.length ? remaining : undefined };
    if (!remaining.length) delete base.surfaces;
    const result = finishMeshRewrite(base, {
      ...base,
      quads: doc.quads.map((q, i) => (ownQuads.has(doc.quadIds[i]) ? null : q)),
      freeEdges: doc.freeEdges?.filter(([a, b]) => !owned.has(a) && !owned.has(b)),
      keepVertices: doc.vertexIds.flatMap((_, i) => (owned.has(i) ? [] : [i])),
    });
    return { ok: true, doc: result.doc };
  } catch (error) {
    return failure(error);
  }
}

export function refreshSurfaces(doc: QuadMeshDoc, options: SurfaceEvaluation = {}): QuadMeshDoc {
  let out = doc;
  let failed = false;
  // Old saved lofts keep their evaluated shape, including any finishing edits, when adopted as a source cage.
  for (const loft of doc.lofts ?? []) {
    try {
      const { mesh, edgeHandle } = meshFromDoc(out),
        ids = nameIndex(out.quadIds);
      const charts = loft.patches.map(p => {
        const q = ids.get(p.quad);
        if (q === undefined) throw new Error('Legacy output was removed.');
        return { domain: p.domain, controls: quadControlPoints(mesh, edgeHandle, q, out.quadTwist?.[q]) };
      });
      const without = { ...out, lofts: out.lofts?.filter(l => l.id !== loft.id) };
      const result = createFromNet(
        without,
        splineFromCharts(charts),
        'legacy',
        loft.profiles.flat(),
        loft.patchSizeM,
        loft,
      );
      if (result.ok) out = result.doc;
    } catch {
      /* Preserve legacy geometry if its history cannot be adopted. */
    }
  }
  for (const previous of out.surfaces ?? []) {
    // A host rebuild can also replace its stitched dependents' evaluated topology in this same pass.
    const surface = out.surfaces?.find(s => s.id === previous.id);
    if (!surface) continue;
    try {
      if (!surface.guides) {
        const charts = splineCharts(surfaceNet(out, surface));
        const u0 = surface.knotsU[0],
          u1 = surface.knotsU.at(-1)!,
          v0 = surface.knotsV[0],
          v1 = surface.knotsV.at(-1)!;
        const seed = charts.map(p => ({
          ...p,
          domain: [
            (p.domain[0] - u0) / (u1 - u0),
            (p.domain[1] - u0) / (u1 - u0),
            (p.domain[2] - v0) / (v1 - v0),
            (p.domain[3] - v0) / (v1 - v0),
          ] as Patch['domain'],
        }));
        const source = new Set(surface.controls.flat()),
          input = new Set(surface.inputs),
          seen = new Set<string>();
        let count = 0;
        for (const id of input) {
          if (seen.has(id)) continue;
          count++;
          const pending = [id];
          while (pending.length) {
            const name = pending.pop()!;
            if (seen.has(name)) continue;
            seen.add(name);
            for (const [a, b] of out.freeEdges ?? []) {
              const A = out.vertexIds[a],
                B = out.vertexIds[b];
              if (A === name && input.has(B) && !seen.has(B)) pending.push(B);
              if (B === name && input.has(A) && !seen.has(A)) pending.push(A);
            }
          }
        }
        const curves =
          surface.origin !== 'boundary' && count >= 2 && count <= 32
            ? Array.from({ length: count }, (_, i) => sectionCurve(seed, 'U', i / (count - 1)))
            : [
                sectionCurve(seed, 'U', 0),
                sectionCurve(seed, 'U', 1),
                sectionCurve(seed, 'V', 0),
                sectionCurve(seed, 'V', 1),
              ];
        const removed = new Set(out.vertexIds.flatMap((id, i) => (source.has(id) ? [i] : [])));
        if (
          out.quads.some(q => q.some(v => removed.has(v))) ||
          out.freeEdges?.some(([a, b]) => removed.has(a) !== removed.has(b))
        )
          throw new Error('Other geometry is attached to this source cage. Bake it before converting its controls.');
        const base = finishMeshRewrite(out, {
          ...out,
          freeEdges: out.freeEdges?.filter(([a, b]) => !removed.has(a) && !removed.has(b)),
          keepVertices: out.vertexIds.flatMap((_, i) => (removed.has(i) ? [] : [i])),
        }).doc;
        // Normalize legacy output domains too, retaining its exact positions and appearance.
        const adopted = {
          ...surface,
          patches: surface.patches.map(p => ({
            ...p,
            domain: [
              (p.domain[0] - u0) / (u1 - u0),
              (p.domain[1] - u0) / (u1 - u0),
              (p.domain[2] - v0) / (v1 - v0),
              (p.domain[3] - v0) / (v1 - v0),
            ] as Patch['domain'],
          })),
        };
        const result = createFromGuides(
          base,
          curves,
          surface.origin,
          surface.inputs,
          surface.patchSizeM,
          1,
          false,
          {
            surface: adopted,
            seed,
          },
          surface.fitToleranceM,
        );
        if (!result.ok) throw new Error(result.error);
        out = result.doc;
        continue;
      }
      const points = surface.guides
        ? readGuideCurves(out, surface).map(c => c.points.flat())
        : surfaceNet(out, surface).points;
      const quads = nameIndex(out.quadIds);
      const valid = surface.patches.every(p => {
        const q = quads.get(p.quad);
        return q !== undefined && out.quads[q].every((v, i) => out.vertexIds[v] === p.corners[i]);
      });
      if (
        valid &&
        !surface.seed &&
        !surface.guides?.some(g => g.reference) &&
        !surface.error &&
        (options.interactive || !layoutPending.has(surface)) &&
        sameSourcePoints(points, surface.evaluated.points) &&
        surface.patchSizeM === surface.evaluated.patchSizeM &&
        surface.fitToleranceM === surface.evaluated.fitToleranceM
      )
        continue;
      const result = rebuildSurface(out, surface, options);
      if (result.ok) out = result.doc;
      else {
        failed = true;
        if (result.error !== surface.error)
          out = { ...out, surfaces: out.surfaces!.map(s => (s.id === surface.id ? { ...s, error: result.error } : s)) };
      }
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      if (surface.error !== message)
        out = { ...out, surfaces: out.surfaces!.map(s => (s.id === surface.id ? { ...s, error: message } : s)) };
    }
  }
  // Do not retry a rejected fit using its previous output: that can hide the failure from the drag guard.
  return failed ? out : refreshSurfaceStitches(out);
}
