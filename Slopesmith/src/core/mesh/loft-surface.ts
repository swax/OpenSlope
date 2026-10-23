import type { LoftDomain, LoftSurface, QuadMeshDoc, V3 } from '../doc/types';
import { appendMeshIds, nameIndex } from '../doc/ids';
import { add, sub, mul, len, dot } from '../math/vec';
import { cubicPoint, patchNormal, splitCubic, splitPatchU, splitPatchV } from '../math/bezier';
import { edgeIsLocked, lockedEdgeSet } from './locks';
import { quadPerimeterEdges } from './primitives';
import { meshAdjacency, meshFromDoc, quadControlPoints } from './topology';
import { readVertex } from './primitives';
import { finishMeshRewrite } from './ops/contract';

const EPS = 1e-8;
const MAX_PATCHES = 16384;
const copy = (v: readonly number[]): V3 => [v[0], v[1], v[2]];
export type Patch = { domain: LoftDomain; controls: V3[] };
type Result = { ok: true; doc: QuadMeshDoc; loft: LoftSurface } | { ok: false; error: string };

/** Curves are evaluated before geometry is touched, so failures cannot partially rebuild a surface. */
export function sourceCurves(doc: QuadMeshDoc, profiles: readonly (readonly string[])[]): V3[][] {
  if (profiles.length < 2 || profiles.some(p => p.length < 2))
    throw new Error('Use at least two profiles, each with two or more points.');
  const index = nameIndex(doc.vertexIds),
    { mesh, edgeHandle } = meshFromDoc(doc);
  const adj = meshAdjacency(mesh);
  const curves = profiles.map(profile =>
    profile.slice(1).flatMap((name, s) => {
      const a = index.get(profile[s]),
        b = index.get(name);
      if (a === undefined || b === undefined || a === b || !adj.neighbors[a]?.includes(b))
        throw new Error(
          'A source profile lost an edge. Undo the topology edit or bake this loft before changing its profiles.',
        );
      const A = readVertex(doc.vertices, a),
        B = readVertex(doc.vertices, b);
      return [A, add(A, edgeHandle(a, b)), add(B, edgeHandle(b, a)), B];
    }),
  );
  if (curves.some(curve => curve.some(p => p.some(n => !Number.isFinite(n)))))
    throw new Error('A source profile contains a non-finite control point.');
  // A compatible partition preserves every original cubic, including profiles with different point counts.
  const knots = sortedCuts(profiles.flatMap(p => p.map((_, i) => i / (p.length - 1))));
  return curves.map(curve =>
    knots.slice(1).flatMap((hi, i) => {
      const segments = curve.length / 4,
        lo = knots[i],
        segment = Math.min(segments - 1, Math.floor(((lo + hi) / 2) * segments));
      const start = lo * segments - segment,
        end = hi * segments - segment;
      let controls = curve.slice(segment * 4, segment * 4 + 4) as [V3, V3, V3, V3];
      if (end < 1 - EPS) controls = splitCubic(...controls, end).left;
      if (start > EPS) controls = splitCubic(...controls, start / end).right;
      return controls;
    }),
  );
}

/** Interpolate corresponding cubic profile controls: a tensor-product cubic Hermite loft. */
export function masterPatches(source: V3[][], curvature: number): Patch[] {
  const out: Patch[] = [];
  for (let v = 0; v < source.length - 1; v++) {
    for (let u = 0; u < source[0].length / 4; u++) {
      const controls: V3[] = [];
      for (let r = 0; r < 4; r++) {
        const at = u * 4 + r;
        const a = source[v][at],
          b = source[v + 1][at];
        const before = source[Math.max(0, v - 1)][at],
          after = source[Math.min(source.length - 1, v + 2)][at];
        const chord = sub(b, a);
        const ta = v === 0 ? chord : mul(sub(b, before), 0.5);
        const tb = v + 2 === source.length ? chord : mul(sub(after, a), 0.5);
        const blend = (t: V3) => add(chord, mul(sub(t, chord), curvature));
        controls.push(copy(a), add(a, mul(blend(ta), 1 / 3)), sub(b, mul(blend(tb), 1 / 3)), copy(b));
      }
      out.push({ domain: [u, u + 1, v, v + 1], controls });
    }
  }
  return out;
}

/** Exact polynomial restriction; it preserves all sixteen controls, including interior detail. */
export function restrict(cp: V3[], domain: LoftDomain, to: LoftDomain): V3[] {
  const [u0, u1, v0, v1] = domain;
  let net = cp;
  const hiU = (to[1] - u0) / (u1 - u0),
    loU = (to[0] - u0) / (u1 - u0);
  const hiV = (to[3] - v0) / (v1 - v0),
    loV = (to[2] - v0) / (v1 - v0);
  if (hiU < 1 - EPS) net = splitPatchU(net, hiU).lower;
  if (loU > EPS) net = splitPatchU(net, loU / hiU).upper;
  if (hiV < 1 - EPS) net = splitPatchV(net, hiV).lower;
  if (loV > EPS) net = splitPatchV(net, loV / hiV).upper;
  return net.map(copy);
}

/** Measure once; surface fitting can redistribute a whole row without inheriting source span boundaries. */
export function measureSurfaceAxis(
  masters: Patch[],
  axis: 0 | 2,
  draft = false,
  mode: 'longest' | 'average' = 'longest',
) {
  const average = mode === 'average';
  const boundaries = sortedCuts(masters.flatMap(p => [p.domain[axis], p.domain[axis + 1]]));
  const acrossAxis = axis === 0 ? 2 : 0,
    acrossStart = Math.min(...masters.map(p => p.domain[acrossAxis])),
    acrossEnd = Math.max(...masters.map(p => p.domain[acrossAxis + 1]));
  const distances = [{ at: boundaries[0], distance: 0 }];
  for (let at = 0; at < boundaries.length - 1; at++) {
    const interval = boundaries[at],
      end = boundaries[at + 1];
    const charts = masters.filter(p => p.domain[axis] === interval);
    const cumulative = [0];
    // Each cross-section is one cubic. Collapse the other parameter once instead of evaluating a
    // bicubic twice for every step (including the previous point we already sampled).
    const acrossCount = draft ? 3 : 5,
      steps = draft ? 16 : 64;
    const section = (chart: Patch, t: number) =>
      Array.from({ length: 4 }, (_, i) =>
        axis === 0
          ? cubicPoint(...(chart.controls.slice(i * 4, i * 4 + 4) as [V3, V3, V3, V3]), t)
          : cubicPoint(chart.controls[i], chart.controls[4 + i], chart.controls[8 + i], chart.controls[12 + i], t),
      ) as [V3, V3, V3, V3];
    // Fixed stations across the whole surface keep the average independent of source subdivisions.
    const sections = average
      ? Array.from({ length: acrossCount }, (_, i) => {
          const t = acrossStart + ((acrossEnd - acrossStart) * i) / (acrossCount - 1),
            chart = charts.find(p => t >= p.domain[acrossAxis] - EPS && t <= p.domain[acrossAxis + 1] + EPS)!;
          return section(
            chart,
            (t - chart.domain[acrossAxis]) / (chart.domain[acrossAxis + 1] - chart.domain[acrossAxis]),
          );
        })
      : charts.flatMap(chart =>
          Array.from({ length: acrossCount }, (_, across) => section(chart, across / (acrossCount - 1))),
        );
    let previous = sections.map(cp => cp[0]);
    for (let k = 1; k <= steps; k++) {
      let longest = 0,
        total = 0;
      const current = sections.map((cp, i) => {
        const p = cubicPoint(...cp, k / steps);
        const distance = len(sub(p, previous[i]));
        longest = Math.max(longest, distance);
        total += distance * (i === 0 || i === sections.length - 1 ? 0.5 : 1);
        return p;
      });
      previous = current;
      cumulative.push(cumulative[k - 1] + (average ? total / (sections.length - 1) : longest));
    }
    const offset = distances.at(-1)!.distance;
    for (let k = 1; k <= steps; k++)
      distances.push({ at: interval + ((end - interval) * k) / steps, distance: offset + cumulative[k] });
  }
  const interpolate = (value: number, from: 'at' | 'distance', to: 'at' | 'distance') => {
    let lo = 0,
      hi = distances.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (distances[mid][from] < value) lo = mid;
      else hi = mid;
    }
    const a = distances[lo],
      b = distances[hi];
    return a[to] + (b[to] - a[to]) * Math.max(0, Math.min(1, (value - a[from]) / Math.max(EPS, b[from] - a[from])));
  };
  const distanceAt = (t: number) => interpolate(t, 'at', 'distance');
  return {
    boundaries,
    length: distances.at(-1)!.distance,
    distanceAt,
    cuts: (count: number, from = boundaries[0], to = boundaries.at(-1)!) => {
      const a = distanceAt(from),
        b = distanceAt(to);
      return Array.from({ length: count + 1 }, (_, i) =>
        i === 0
          ? from
          : i === count
            ? to
            : b - a < EPS
              ? from + ((to - from) * i) / count
              : interpolate(a + ((b - a) * i) / count, 'distance', 'at'),
      );
    },
  };
}

/** A common cut schedule measured in 3-D across the chart, not equal parameter increments. */
export function metricCuts(masters: Patch[], axis: 0 | 2, target: number, preserveSpans = true): number[] {
  const metric = measureSurfaceAxis(masters, axis),
    boundaries = preserveSpans ? metric.boundaries : [metric.boundaries[0], metric.boundaries.at(-1)!];
  return boundaries.slice(1).flatMap((hi, i) => {
    const lo = boundaries[i],
      count = Math.max(1, Math.ceil((metric.distanceAt(hi) - metric.distanceAt(lo)) / target));
    if (count > (preserveSpans ? 256 : MAX_PATCHES))
      throw new Error('This surface needs too many spans. Increase the target patch size.');
    return metric.cuts(count, lo, hi).slice(i ? 1 : 0);
  });
}

const sortedCuts = (values: number[]) => values.sort((a, b) => a - b).filter((x, i, all) => !i || x - all[i - 1] > EPS);
const contains = (outer: LoftDomain, inner: LoftDomain) =>
  outer[0] <= inner[0] + EPS && outer[1] >= inner[1] - EPS && outer[2] <= inner[2] + EPS && outer[3] >= inner[3] - EPS;

function detailPatches(doc: QuadMeshDoc, loft: LoftSurface): Patch[] {
  const ids = nameIndex(doc.quadIds),
    { mesh, edgeHandle } = meshFromDoc(doc);
  let unchanged = loft.detail !== undefined;
  const current = loft.patches.flatMap(p => {
    const q = ids.get(p.quad);
    if (q === undefined)
      throw new Error(
        'Generated patches were removed. Undo the topology edit or bake this loft to keep the remaining mesh.',
      );
    if (doc.quads[q].some((v, i) => doc.vertexIds[v] !== p.corners[i]))
      throw new Error(
        'Generated patch topology changed. Undo that edit or bake this loft before continuing its construction history.',
      );
    const current = quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]);
    const controls = current.map((point, i) => sub(point, p.base[i]));
    if (unchanged) {
      const layer = loft.detail!.find(layer => contains(layer.domain, p.domain));
      const expected = layer ? restrict(layer.controls, layer.domain, p.domain) : null;
      unchanged = controls.every((point, i) => len(sub(point, expected?.[i] ?? [0, 0, 0])) <= EPS);
    }
    return controls.some(v => len(v) > EPS) ? [{ domain: p.domain, controls }] : [];
  });
  return unchanged ? loft.detail! : current;
}

/** Install explicit full cages, so source-curve edits never modify the generated surface before evaluation. */
function writeCages(doc: QuadMeshDoc, patches: Patch[], quads: number[]): void {
  const handles = (doc.edgeHandles ??= {});
  for (let i = 0; i < patches.length; i++) {
    const q = doc.quads[quads[i]],
      cp = patches[i].controls;
    const [a, b, c, d] = q;
    for (const [from, to, control, corner] of [
      [a, b, 1, 0],
      [b, a, 2, 3],
      [a, c, 4, 0],
      [c, a, 8, 12],
      [b, d, 7, 3],
      [d, b, 11, 15],
      [c, d, 13, 12],
      [d, c, 14, 15],
    ])
      handles[`${from}>${to}`] = sub(cp[control], cp[corner]);
  }
  const twist = (doc.quadTwist ??= {});
  patches.forEach((patch, i) => {
    const [a, b, c, d] = doc.quads[quads[i]];
    // Every boundary handle was just written explicitly. Derive the four Ferguson interiors directly;
    // building the mountain's topology and Bessel adjacency cannot change these pinned values.
    twist[quads[i]] = [
      [a, b, c, 5],
      [b, a, d, 6],
      [c, a, d, 9],
      [d, b, c, 10],
    ].map(([v, u, w, at]) =>
      sub(patch.controls[at], add(readVertex(doc.vertices, v), add(handles[`${v}>${u}`], handles[`${v}>${w}`]))),
    ) as [V3, V3, V3, V3];
  });
}

export function rebuildLoftSurface(doc: QuadMeshDoc, loft: LoftSurface): Result {
  try {
    if (
      !Number.isFinite(loft.patchSizeM) ||
      loft.patchSizeM < 0.5 ||
      !Number.isFinite(loft.curvature) ||
      loft.curvature < 0 ||
      loft.curvature > 2
    )
      throw new Error('Use a finite patch size of at least 0.5 m and curvature between 0 and 2.');
    const source = sourceCurves(doc, loft.profiles);
    const locks = lockedEdgeSet(doc);
    const qIndex = nameIndex(doc.quadIds);
    if (
      loft.patches.some(p => {
        const at = qIndex.get(p.quad);
        return (
          at !== undefined &&
          (doc.quadLocked?.[at] || quadPerimeterEdges(doc.quads[at]).some(([a, b]) => edgeIsLocked(doc, a, b, locks)))
        );
      })
    )
      throw new Error('This loft has locked patches. Unlock them before rebuilding its profiles or density.');
    const detail = detailPatches(doc, loft);
    const masters = masterPatches(source, loft.curvature);
    const us = sortedCuts([...metricCuts(masters, 0, loft.patchSizeM), ...detail.flatMap(p => p.domain.slice(0, 2))]);
    const vs = sortedCuts([...metricCuts(masters, 2, loft.patchSizeM), ...detail.flatMap(p => p.domain.slice(2, 4))]);
    if ((us.length - 1) * (vs.length - 1) > MAX_PATCHES)
      throw new Error('This loft exceeds 16,384 patches. Increase patch size or bake its finished detail.');
    const base: Patch[] = [],
      finished: Patch[] = [];
    for (let v = 0; v < vs.length - 1; v++)
      for (let u = 0; u < us.length - 1; u++) {
        const domain: LoftDomain = [us[u], us[u + 1], vs[v], vs[v + 1]];
        const master = masters.find(p => contains(p.domain, domain));
        if (!master) throw new Error('Loft subdivision no longer matches its source profiles.');
        const controls = restrict(master.controls, master.domain, domain);
        const layer = detail.find(p => contains(p.domain, domain));
        base.push({ domain, controls });
        const displacement = layer ? restrict(layer.controls, layer.domain, domain) : null;
        finished.push({ domain, controls: displacement ? controls.map((p, i) => add(p, displacement[i])) : controls });
      }
    const installed = installSurfaceCharts(doc, loft, base, finished, us, vs);
    const out = installed.doc;
    const next: LoftSurface = {
      ...loft,
      source,
      detail,
      vertices: installed.vertices,
      patches: installed.patches,
      evaluated: { patchSizeM: loft.patchSizeM, curvature: loft.curvature },
    };
    delete next.error;
    out.lofts = out.lofts?.some(l => l.id === loft.id)
      ? out.lofts.map(l => (l.id === loft.id ? next : l))
      : [...(out.lofts ?? []), next];
    return { ok: true, doc: out, loft: next };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createLoftSurface(
  doc: QuadMeshDoc,
  profiles: readonly (readonly number[])[],
  options: { patchSizeM?: number; curvature?: number; facing?: V3 } = {},
): Result {
  const names = profiles.map(p => p.map(i => doc.vertexIds[i]));
  if (names.some(p => p.some(id => !id)))
    return { ok: false, error: 'A selected profile names a point that no longer exists.' };
  try {
    const masters = masterPatches(sourceCurves(doc, names), options.curvature ?? 1);
    const facing = options.facing ?? [0, 1, 0];
    if (masters.reduce((sum, p) => sum + dot(patchNormal(p.controls, 0.5, 0.5), facing), 0) < 0)
      names.forEach(profile => profile.reverse());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  let n = 1;
  while (doc.lofts?.some(l => l.id === `loft:${n}`)) n++;
  return rebuildLoftSurface(doc, {
    id: `loft:${n}`,
    name: `Loft ${n}`,
    profiles: names,
    patchSizeM: options.patchSizeM ?? 25,
    curvature: options.curvature ?? 1,
    vertices: [],
    patches: [],
    source: [],
    evaluated: { patchSizeM: 0, curvature: 0 },
  });
}

/** A whole-object transform already moved both the inputs and output. Carry the base with it, instead of
 * applying the source motion twice. Keep the layout stable during the drag; resample when it ends. */
export function rebaseLoftTransforms(doc: QuadMeshDoc, moved: readonly number[]): QuadMeshDoc {
  const names = new Set(moved.map(i => doc.vertexIds[i]));
  const quads = nameIndex(doc.quadIds);
  let changed = false;
  const lofts = doc.lofts?.map(loft => {
    if (
      loft.error ||
      !loft.vertices.length ||
      !loft.vertices.every(id => names.has(id)) ||
      !loft.profiles.every(p => p.every(id => names.has(id))) ||
      !loft.patches.every(p => {
        const q = quads.get(p.quad);
        return q !== undefined && doc.quads[q].every((v, i) => doc.vertexIds[v] === p.corners[i]);
      })
    )
      return loft;
    try {
      const source = sourceCurves(doc, loft.profiles);
      if (JSON.stringify(source) === JSON.stringify(loft.source)) return loft;
      const masters = masterPatches(source, loft.curvature);
      const patches = loft.patches.map(p => {
        const master = masters.find(m => contains(m.domain, p.domain));
        if (!master) throw new Error('Source topology changed.');
        return { ...p, base: restrict(master.controls, master.domain, p.domain) };
      });
      changed = true;
      return { ...loft, source, patches };
    } catch {
      return loft; // Ordinary evaluation reports invalid history without changing its last valid base.
    }
  });
  return changed ? { ...doc, lofts } : doc;
}

/** Run at the edit/render boundary, so undo and save include both recipe and evaluated geometry. */
export function refreshLoftSurfaces(doc: QuadMeshDoc): QuadMeshDoc {
  let out = doc;
  for (const loft of doc.lofts ?? []) {
    const report = (error: string) => {
      if (loft.error !== error) out = { ...out, lofts: out.lofts!.map(l => (l.id === loft.id ? { ...l, error } : l)) };
    };
    try {
      const source = sourceCurves(out, loft.profiles);
      const quads = nameIndex(out.quadIds);
      const valid = loft.patches.every(p => {
        const at = quads.get(p.quad);
        return at !== undefined && out.quads[at].every((v, i) => out.vertexIds[v] === p.corners[i]);
      });
      if (
        valid &&
        !loft.error &&
        JSON.stringify(source) === JSON.stringify(loft.source) &&
        loft.patchSizeM === loft.evaluated.patchSizeM &&
        loft.curvature === loft.evaluated.curvature
      )
        continue;
      const result = rebuildLoftSurface(out, loft);
      if (result.ok) out = result.doc;
      else report(result.error);
    } catch (error) {
      report(String(error instanceof Error ? error.message : error));
    }
  }
  return out;
}

export function bakeLoftSurface(doc: QuadMeshDoc, id: string): QuadMeshDoc {
  const lofts = (doc.lofts ?? []).filter(l => l.id !== id);
  const out = { ...doc };
  if (lofts.length) out.lofts = lofts;
  else delete out.lofts;
  return out;
}

/** Shared terrain installation for profile history and editable spline surfaces. */
export function installSurfaceCharts(
  doc: QuadMeshDoc,
  owner: Pick<LoftSurface, 'vertices' | 'patches'>,
  base: Patch[],
  finished: Patch[],
  us: number[],
  vs: number[],
) {
  // Retire only this surface's isolated output. Sources and every unrelated channel remain intact.
  const ownVertices = new Set(owner.vertices),
    ownQuads = new Set(owner.patches.map(p => p.quad));
  const vIndex = nameIndex(doc.vertexIds),
    qIndex = nameIndex(doc.quadIds);
  const owned = new Set([...ownVertices].map(id => vIndex.get(id)).filter((i): i is number => i !== undefined));
  if (
    doc.quads.some((q, i) => !ownQuads.has(doc.quadIds[i]) && q.some(v => owned.has(v))) ||
    doc.freeEdges?.some(edge => edge.some(v => owned.has(v)))
  )
    throw new Error('Other geometry is attached to this loft. Bake it before changing its profiles or density.');
  // Moving a cut in parameter space changes positions, not connectivity. Retain names and topology
  // whenever the grid dimensions agree, so a source drag can update the existing terrain buffers.
  const sameLayout =
    owner.patches.length === base.length &&
    owner.vertices.length === us.length * vs.length &&
    new Set(owner.patches.map(p => p.domain[0])).size === us.length - 1 &&
    new Set(owner.patches.map(p => p.domain[2])).size === vs.length - 1;
  let out: QuadMeshDoc, generated: number[], cells: number[];
  const positions: V3[] = [];
  for (let v = 0; v < vs.length; v++)
    for (let u = 0; u < us.length; u++) {
      const pu = Math.min(u, us.length - 2),
        pv = Math.min(v, vs.length - 2);
      const patch = finished[pv * (us.length - 1) + pu];
      positions.push(patch.controls[(u === pu ? 0 : 12) + (v === pv ? 0 : 3)]);
    }
  if (sameLayout) {
    out = {
      ...doc,
      vertices: doc.vertices.slice(),
      edgeHandles: { ...doc.edgeHandles },
      quadTwist: { ...doc.quadTwist },
    };
    generated = owner.vertices.map(id => vIndex.get(id)!);
    cells = owner.patches.map(p => qIndex.get(p.quad)!);
    if (generated.some(i => i === undefined))
      throw new Error('Generated points were removed. Undo the topology edit or bake this loft.');
  } else {
    const quads = doc.quads.map((q, i) => (ownQuads.has(doc.quadIds[i]) ? null : q));
    const kept = finishMeshRewrite(doc, {
      ...doc,
      vertices: doc.vertices,
      quads,
      freeEdges: doc.freeEdges,
      keepVertices: doc.vertices.reduce<number[]>((ids, _, i) => {
        if (i % 3 === 0 && !owned.has(i / 3)) ids.push(i / 3);
        return ids;
      }, []),
    }).doc;
    const start = kept.vertices.length / 3,
      first = kept.quads.length;
    generated = positions.map((_, i) => start + i);
    const append: number[][] = [];
    for (let v = 0; v < vs.length - 1; v++)
      for (let u = 0; u < us.length - 1; u++) {
        const a = start + v * us.length + u;
        append.push([a, a + us.length, a + 1, a + us.length + 1]);
      }
    out = {
      ...kept,
      vertices: [...kept.vertices, ...positions.flat()],
      quads: [...kept.quads, ...append],
      ...appendMeshIds(kept, positions.length, append.length),
      edgeHandles: { ...kept.edgeHandles },
      quadTwist: { ...kept.quadTwist },
    };
    cells = append.map((_, i) => first + i);
    // Transfer appearance by source-domain location, including hand-painted cells.
    base.forEach((p, i) => {
      const old = owner.patches.find(old =>
        contains(old.domain, [
          (p.domain[0] + p.domain[1]) / 2,
          (p.domain[0] + p.domain[1]) / 2,
          (p.domain[2] + p.domain[3]) / 2,
          (p.domain[2] + p.domain[3]) / 2,
        ]),
      );
      const at = old ? qIndex.get(old.quad) : undefined;
      if (at === undefined) return;
      for (const field of ['quadPaint', 'quadTex', 'quadOrient', 'quadLabels'] as const) {
        const value = doc[field]?.[at];
        if (value !== undefined) (out[field] ??= {} as never)[cells[i]] = structuredClone(value) as never;
      }
    });
  }
  positions.forEach((p, i) => out.vertices.splice(generated[i] * 3, 3, ...p));
  writeCages(out, finished, cells);
  return {
    doc: out,
    vertices: generated.map(i => out.vertexIds[i]),
    patches: base.map((p, i) => ({
      quad: out.quadIds[cells[i]],
      corners: out.quads[cells[i]].map(v => out.vertexIds[v]),
      domain: p.domain,
      base: p.controls,
    })),
  };
}
