import type { V3 } from '../../doc/types';
import type { InterfaceCurve } from './benchmark';
import type { PolygonMesh } from './obj';

/**
 * Prescribed subdivision counts for QuadWild patch-layout subsides (docs/ideas/042).
 *
 * A locked-feature rim in the hole-mode proxy must quantize to exactly one candidate edge per
 * protected corner so the exact-patch join is conforming by construction. The remesh decomposes
 * each rim into corner-to-corner subside arcs; every authored rim vertex is projected onto the
 * rim polyline by arc length (the remesh resamples the rim, so authored vertices lie on the
 * curve, not at remesh vertices) and each arc receives the projections in its span, minimum 1,
 * summing exactly to the authored edge count. The patched quad_from_patches consumes the records
 * as an input_rem_p0.fixed sidecar and pins them as lower == upper bounds in the BiMDF solve.
 */

export interface PrescribedSubside {
  /** Endpoint mesh vertex ids of the subside in the remesh. */
  v0: number;
  v1: number;
  /** Any interior polyline vertex id, -1 for a single-edge subside. */
  vMid: number;
  count: number;
  /**
   * count-1 strictly increasing arc-length split fractions in (0, 1) measured from v0: the
   * authored corner positions inside the arc, so the generated boundary vertices land on them
   * instead of at uniform arc spacing. Empty for count 1.
   */
  fractions: number[];
}

export interface PrescribedLoop {
  authoredEdges: number;
  rimEdges: number;
  arcs: number;
  worstProjectionM: number;
  /** Layout corners re-seated onto their paired authored corners in the remesh. */
  movedCorners: number;
  worstCornerMoveM: number;
  /** Worst remaining corner-to-paired-authored distance (corners past the conforming gate). */
  worstResidualM: number;
}

export interface RimPrescription {
  records: PrescribedSubside[];
  loops: PrescribedLoop[];
  /**
   * Remesh vertex position updates from corner conforming: layout corners moved onto their
   * paired authored corners, with the rim vertices between them redistributed proportionally.
   * Must be applied to input_rem_p0.obj before quad_from_patches consumes the sidecar, or the
   * emitted split fractions will not measure the solved rim.
   */
  movedVertices: Map<number, V3>;
}

/** How far an authored rim vertex may sit from the remesh rim polyline and still match it. */
const PROJECTION_TOLERANCE_M = 2;

const distance = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const edgeKey = (a: number, b: number): string => `${Math.min(a, b)}_${Math.max(a, b)}`;

/** Boundary loops of a polygon mesh as cyclic vertex-id sequences. */
export function boundaryLoops(mesh: PolygonMesh): number[][] {
  const edgeUse = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let edge = 0; edge < face.length; edge++) {
      const key = edgeKey(face[edge], face[(edge + 1) % face.length]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const adjacency = new Map<number, number[]>();
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    for (const [from, to] of [[a, b], [b, a]] as const) {
      let list = adjacency.get(from);
      if (!list) adjacency.set(from, (list = []));
      list.push(to);
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    for (let previous = -1, at = start, guard = 0; ;) {
      if (guard++ > adjacency.size + 2) throw new Error('mesh boundary loop does not close');
      const [n1, n2] = adjacency.get(at)!;
      const next = n1 === previous ? n2 : n1;
      previous = at;
      at = next;
      if (at === start) break;
      loop.push(at);
      seen.add(at);
    }
    loops.push(loop);
  }
  return loops;
}

/** First line is the record count; each record is "v0 v1 vMid count [f1 ... fn]" (see load_save.cpp). */
export function formatFixedSubsides(records: PrescribedSubside[]): string {
  return `${records.length}\n${records.map(r => [
    `${r.v0} ${r.v1} ${r.vMid} ${r.count}`,
    ...r.fractions.map(fraction => fraction.toFixed(6)),
  ].join(' ')).join('\n')}\n`;
}

/** QuadWild .corners sidecar: patch count, then per patch a corner count and vertex ids. */
export function parseCornersFile(text: string): Set<number> {
  const tokens = text.trim().split(/\s+/).map(Number);
  const corners = new Set<number>();
  let at = 1;
  for (let patch = 0; patch < tokens[0]; patch++) {
    const count = tokens[at++];
    for (let i = 0; i < count; i++) corners.add(tokens[at++]);
  }
  return corners;
}

/** How far a proxy rim vertex may sit from an interface curve and still count as locked. */
const LOCKED_RIM_TOLERANCE_M = 1;

/**
 * Boundary loops of the hole-mode proxy that trace a locked feature: every loop vertex lies on
 * an interface curve. The proxy's outer mountain rim is a boundary but not a locked seam.
 */
export function lockedRimLoops(proxy: PolygonMesh, curves: InterfaceCurve[]): V3[][] {
  const locked: V3[][] = [];
  for (const loop of boundaryLoops(proxy)) {
    const onInterface = loop.every(vertex => {
      const point = proxy.vertices[vertex];
      for (const curve of curves) {
        for (let i = 0; i + 1 < curve.samples.length; i++) {
          const a = curve.samples[i];
          const b = curve.samples[i + 1];
          const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
          const ap: V3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
          const t = Math.max(0, Math.min(1, len2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2 : 0));
          if (distance(point, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]) < LOCKED_RIM_TOLERANCE_M) {
            return true;
          }
        }
      }
      return false;
    });
    if (onInterface) locked.push(loop.map(vertex => proxy.vertices[vertex]));
  }
  return locked;
}

function projectOntoLoop(point: V3, positions: V3[], cumulative: number[]): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < positions.length; i++) {
    const a = positions[i];
    const b = positions[(i + 1) % positions.length];
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const ap: V3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
    const t = Math.max(0, Math.min(1, len2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2 : 0));
    const q: V3 = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
    const d = distance(point, q);
    if (d < best.d) best = { s: cumulative[i] + t * Math.sqrt(len2), d };
  }
  return best;
}

/** Point at cyclic arc-length position s on a closed polyline. */
function pointOnLoop(positions: V3[], cumulative: number[], s: number): V3 {
  const total = cumulative[positions.length];
  const t = ((s % total) + total) % total;
  let low = 0, high = positions.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (cumulative[mid] <= t) low = mid;
    else high = mid - 1;
  }
  const a = positions[low];
  const b = positions[(low + 1) % positions.length];
  const span = cumulative[low + 1] - cumulative[low];
  const u = span > 0 ? (t - cumulative[low]) / span : 0;
  return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2])];
}

/**
 * Pair every layout corner with an authored corner: the cyclically monotone assignment (so each
 * arc keeps at least one subdivision) minimizing the largest corner-to-authored arc distance,
 * ties broken by total distance. Returned indices are unwrapped ascending positions into the
 * arc-length-sorted authored list (take mod authored count to address it).
 */
function pairCornersToAuthored(cornerS: number[], authoredS: number[], total: number): number[] {
  const corners = cornerS.length, authored = authoredS.length;
  const cyclic = (cornerIndex: number, unwrapped: number): number => {
    const raw = Math.abs(cornerS[cornerIndex] - authoredS[unwrapped % authored]);
    return Math.min(raw, total - raw);
  };
  let best: { max: number; sum: number; assignment: number[] } | undefined;
  for (let anchor = 0; anchor < authored; anchor++) {
    // offsets from the anchor: corner j sits at authored index anchor + offset[j], offsets
    // strictly increasing from 0 and leaving room for the corners after j
    const max = [new Array<number>(authored).fill(Infinity)];
    const sum = [new Array<number>(authored).fill(Infinity)];
    const parent: number[][] = [];
    max[0][0] = cyclic(0, anchor);
    sum[0][0] = max[0][0];
    for (let j = 1; j < corners; j++) {
      max.push(new Array<number>(authored).fill(Infinity));
      sum.push(new Array<number>(authored).fill(Infinity));
      parent.push(new Array<number>(authored).fill(-1));
      let bestPrior = -1;
      for (let offset = j; offset <= authored - 1 - (corners - 1 - j); offset++) {
        const prior = offset - 1;
        if (max[j - 1][prior] < Infinity && (bestPrior < 0
          || max[j - 1][prior] < max[j - 1][bestPrior]
          || (max[j - 1][prior] === max[j - 1][bestPrior] && sum[j - 1][prior] < sum[j - 1][bestPrior]))) {
          bestPrior = prior;
        }
        if (bestPrior < 0) continue;
        const d = cyclic(j, anchor + offset);
        max[j][offset] = Math.max(d, max[j - 1][bestPrior]);
        sum[j][offset] = d + sum[j - 1][bestPrior];
        parent[j - 1][offset] = bestPrior;
      }
    }
    for (let offset = corners - 1; offset < authored; offset++) {
      const last = corners - 1;
      if (max[last][offset] === Infinity) continue;
      if (best && (max[last][offset] > best.max
        || (max[last][offset] === best.max && sum[last][offset] >= best.sum))) continue;
      const offsets = [offset];
      for (let j = last; j > 0; j--) offsets.unshift(parent[j - 1][offsets[0]]);
      best = {
        max: max[last][offset],
        sum: sum[last][offset],
        assignment: offsets.map(value => anchor + value),
      };
    }
  }
  if (!best) throw new Error('no monotone corner-to-authored pairing exists');
  return best.assignment;
}

/**
 * Prescribe every authored rim loop onto its matching remesh boundary loop. Rims split into
 * subside arcs at layout corners alone: every boundary junction of the traced patch layout is a
 * declared corner. Each layout corner is paired with an authored corner (cyclically monotone,
 * minimizing the largest pairing distance) and, within the conforming gate, moved onto it; the
 * authored corners between two paired ones become the arc's subdivision count and split
 * fractions. Throws when an authored loop matches no remesh rim or has fewer authored corners
 * than the rim has layout corners.
 */
export function prescribeRimSubsides(
  remesh: PolygonMesh,
  corners: ReadonlySet<number>,
  authoredLoops: V3[][],
): RimPrescription {
  if (remesh.faces.some(face => face.length !== 3)) throw new Error('prescription requires the triangle remesh');

  const rims = boundaryLoops(remesh);
  const records: PrescribedSubside[] = [];
  const loops: PrescribedLoop[] = [];
  const movedVertices = new Map<number, V3>();
  const claimed = new Set<number[]>();

  for (const authored of authoredLoops) {
    // match the remesh rim whose polyline the authored vertices project onto
    let rim: number[] | undefined;
    let positions: V3[] = [];
    let rimCumulative: number[] = [];
    let rimTotal = 0;
    let authoredS: number[] = [];
    let worst = Infinity;
    for (const candidate of rims) {
      if (claimed.has(candidate)) continue;
      const candidatePositions = candidate.map(v => remesh.vertices[v]);
      const cumulative = [0];
      for (let i = 1; i <= candidatePositions.length; i++) {
        cumulative.push(cumulative[i - 1]
          + distance(candidatePositions[i - 1], candidatePositions[i % candidatePositions.length]));
      }
      const params: number[] = [];
      let candidateWorst = 0;
      for (const point of authored) {
        const projected = projectOntoLoop(point, candidatePositions, cumulative);
        candidateWorst = Math.max(candidateWorst, projected.d);
        if (candidateWorst >= PROJECTION_TOLERANCE_M) break;
        params.push(projected.s);
      }
      if (candidateWorst < PROJECTION_TOLERANCE_M) {
        rim = candidate;
        positions = candidatePositions;
        rimCumulative = cumulative;
        rimTotal = cumulative[candidatePositions.length];
        authoredS = params;
        worst = candidateWorst;
        break;
      }
    }
    if (!rim) throw new Error(`authored rim loop (${authored.length} edges) matches no remesh boundary loop`);
    claimed.add(rim);

    const cornerIndices = rim.map((v, i) => (corners.has(v) ? i : -1)).filter(i => i >= 0);
    if (cornerIndices.length < 2) throw new Error('remesh rim has fewer than two layout corners');
    if (cornerIndices.length > authored.length) {
      throw new Error(`${cornerIndices.length} layout corners exceed the ${authored.length} authored corners`);
    }

    // authored corners in rim traversal order
    const sorted = authored
      .map((point, index) => ({ point, s: authoredS[index] }))
      .sort((a, b) => a.s - b.s);
    const cornerS = cornerIndices.map(index => rimCumulative[index]);
    const assignment = pairCornersToAuthored(cornerS, sorted.map(entry => entry.s), rimTotal);

    // conform layout corners onto their paired authored corners; a pairing beyond the gate keeps
    // the corner where tracing put it (the join absorbs the residual there instead)
    const conformGateM = 0.75 * (rimTotal / authored.length);
    const unwrap = (s: number, near: number): number =>
      [s - rimTotal, s, s + rimTotal].reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a));
    const conform = cornerIndices.map((index, j) => {
      const paired = sorted[assignment[j] % sorted.length];
      const pairedS = unwrap(paired.s, cornerS[j]);
      return {
        paired,
        newS: Math.abs(pairedS - cornerS[j]) <= conformGateM ? pairedS : cornerS[j],
        moveM: distance(positions[index], paired.point),
      };
    });
    // a conformed corner must not cross or crowd a neighbor: revert the larger offender until
    // every arc keeps a positive span
    const minimumSpanM = 0.5;
    for (let guard = 0; guard <= cornerIndices.length; guard++) {
      let worstPair = -1;
      let worstSpan = minimumSpanM;
      for (let j = 0; j < cornerIndices.length; j++) {
        const next = (j + 1) % cornerIndices.length;
        const originalSpan = (cornerS[next] - cornerS[j] + rimTotal) % rimTotal || rimTotal;
        const span = originalSpan + (conform[next].newS - cornerS[next]) - (conform[j].newS - cornerS[j]);
        if (span < worstSpan) { worstSpan = span; worstPair = j; }
      }
      if (worstPair < 0) break;
      const next = (worstPair + 1) % cornerIndices.length;
      const offender = Math.abs(conform[worstPair].newS - cornerS[worstPair])
        >= Math.abs(conform[next].newS - cornerS[next]) ? worstPair : next;
      if (conform[offender].newS === cornerS[offender]) {
        throw new Error('corner conforming cannot keep every rim arc a positive span');
      }
      conform[offender].newS = cornerS[offender];
    }
    let movedCorners = 0;
    let worstCornerMoveM = 0;
    let worstResidualM = 0;
    const newCornerS: number[] = [];
    for (let j = 0; j < cornerIndices.length; j++) {
      newCornerS.push(conform[j].newS);
      if (conform[j].newS !== cornerS[j]) {
        if (conform[j].moveM > 1e-6) {
          movedCorners++;
          worstCornerMoveM = Math.max(worstCornerMoveM, conform[j].moveM);
          movedVertices.set(rim[cornerIndices[j]], conform[j].paired.point);
        }
      } else {
        worstResidualM = Math.max(worstResidualM, conform[j].moveM);
      }
    }

    // redistribute the rim vertices between corners proportionally along the original polyline,
    // so a moved corner stretches its arcs smoothly instead of degenerating its first rim edge
    for (let j = 0; j < cornerIndices.length; j++) {
      const next = (j + 1) % cornerIndices.length;
      const fromS = cornerS[j], toS = cornerS[j] + ((cornerS[next] - cornerS[j] + rimTotal) % rimTotal || rimTotal);
      const newFromS = newCornerS[j], newToS = newCornerS[j]
        + ((newCornerS[next] - newCornerS[j] + rimTotal) % rimTotal || rimTotal);
      if (Math.abs(newFromS - fromS) < 1e-9 && Math.abs(newToS - toS) < 1e-9) continue;
      for (let i = (cornerIndices[j] + 1) % rim.length; i !== cornerIndices[next]; i = (i + 1) % rim.length) {
        const s = fromS + ((rimCumulative[i] - fromS + rimTotal) % rimTotal);
        const remapped = newFromS + ((s - fromS) / (toS - fromS)) * (newToS - newFromS);
        const point = pointOnLoop(positions, rimCumulative, remapped);
        if (distance(point, positions[i]) > 1e-6) movedVertices.set(rim[i], point);
      }
    }

    // conformed rim geometry: split fractions must measure the polyline the solver will see
    const newPositions = rim.map((v, i) => movedVertices.get(v) ?? positions[i]);
    const newCumulative = [0];
    for (let i = 1; i <= newPositions.length; i++) {
      newCumulative.push(newCumulative[i - 1]
        + distance(newPositions[i - 1], newPositions[i % newPositions.length]));
    }
    const newTotal = newCumulative[newPositions.length];

    for (let j = 0; j < cornerIndices.length; j++) {
      const next = (j + 1) % cornerIndices.length;
      const count = assignment[(j + 1) % assignment.length] - assignment[j]
        + (next === 0 ? sorted.length : 0);
      if (count < 1) throw new Error('corner pairing produced an empty arc');
      const arcFromS = newCumulative[cornerIndices[j]];
      const arcLength = (newCumulative[cornerIndices[next]] - arcFromS + newTotal) % newTotal || newTotal;
      const fractions: number[] = [];
      for (let split = assignment[j] + 1; split < assignment[j] + count; split++) {
        const projected = projectOntoLoop(sorted[split % sorted.length].point, newPositions, newCumulative);
        let offset = (projected.s - arcFromS + newTotal) % newTotal;
        // an unconformed corner can leave its neighboring authored corner just outside the arc
        // span; the join pairs that vertex at the corner anyway, so clamp to the nearer end
        if (offset > arcLength) offset = newTotal - offset < offset - arcLength ? 0 : arcLength;
        fractions.push(offset / arcLength);
      }
      // authored corners project in arc order; keep a strict (0, 1) staircase against rounding
      const epsilon = 1e-4;
      for (let k = 0; k < fractions.length; k++) {
        fractions[k] = Math.min(Math.max(fractions[k], (k + 1) * epsilon), 1 - (fractions.length - k) * epsilon);
        if (k > 0 && fractions[k] <= fractions[k - 1]) fractions[k] = fractions[k - 1] + epsilon;
      }
      if (fractions.some(fraction => fraction <= 0 || fraction >= 1)) {
        throw new Error('split fractions escape the open unit interval');
      }

      const verts: number[] = [];
      for (let i = cornerIndices[j]; ; i = (i + 1) % rim.length) {
        verts.push(rim[i]);
        if (i === cornerIndices[next] && verts.length > 1) break;
      }
      records.push({
        v0: verts[0],
        v1: verts[verts.length - 1],
        vMid: verts.length > 2 ? verts[1] : -1,
        count,
        fractions,
      });
    }

    const total = records.slice(-cornerIndices.length).reduce((sum, record) => sum + record.count, 0);
    if (total !== authored.length) {
      throw new Error(`distributed ${total} subdivisions for a ${authored.length}-edge authored loop`);
    }
    loops.push({
      authoredEdges: authored.length,
      rimEdges: rim.length,
      arcs: cornerIndices.length,
      worstProjectionM: worst,
      movedCorners,
      worstCornerMoveM,
      worstResidualM,
    });
  }
  return { records, loops, movedVertices };
}

/**
 * Pin every corner-to-corner arc of near-interface unlocked hole rims at its own remesh edge
 * count. A freely quantized hole near a locked feature collapses to a handful of target-size
 * quads whose ring can physically cross the locked outline (and the footprint cut then merges
 * the hole into the locked rim, destroying the prescribed interface). Remesh-resolution counts
 * keep the ring local; the ordinary n-to-m hole seating handles the authored join downstream.
 * Rims without at least two layout corners are skipped (their subsides cannot be addressed).
 */
export function prescribeNearbyHoleSubsides(
  remesh: PolygonMesh,
  corners: ReadonlySet<number>,
  curves: InterfaceCurve[],
  claimedVertices: ReadonlySet<number>,
  nearDistanceM: number,
): { records: PrescribedSubside[]; holes: number } {
  const loops = boundaryLoops(remesh);
  const outer = loops.reduce((a, b) => (b.length > a.length ? b : a));
  const records: PrescribedSubside[] = [];
  let holes = 0;
  for (const loop of loops) {
    if (loop === outer || loop.some(vertex => claimedVertices.has(vertex))) continue;
    const cornerIndices = loop.map((v, i) => (corners.has(v) ? i : -1)).filter(i => i >= 0);
    if (cornerIndices.length < 2) continue;
    const near = loop.some(vertex => {
      const point = remesh.vertices[vertex];
      for (const curve of curves) {
        for (let i = 0; i + 1 < curve.samples.length; i++) {
          const a = curve.samples[i];
          const b = curve.samples[i + 1];
          const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
          const ap: V3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
          const t = Math.max(0, Math.min(1, len2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2 : 0));
          if (distance(point, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]) < nearDistanceM) return true;
        }
      }
      return false;
    });
    if (!near) continue;
    holes++;
    for (let k = 0; k < cornerIndices.length; k++) {
      const verts: number[] = [];
      for (let i = cornerIndices[k]; ; i = (i + 1) % loop.length) {
        verts.push(loop[i]);
        if (i === cornerIndices[(k + 1) % cornerIndices.length] && verts.length > 1) break;
      }
      records.push({
        v0: verts[0],
        v1: verts[verts.length - 1],
        vMid: verts.length > 2 ? verts[1] : -1,
        count: verts.length - 1,
        fractions: [],
      });
    }
  }
  return { records, holes };
}

/**
 * Apply prescription vertex moves to OBJ text by rewriting only the affected `v` lines, keeping
 * every other line (and the face order the .patch sidecar indexes) byte-identical.
 */
export function applyVertexMovesToObj(objText: string, moves: ReadonlyMap<number, V3>): string {
  if (!moves.size) return objText;
  let vertex = -1;
  let applied = 0;
  const lines = objText.split('\n').map(line => {
    if (!/^v\s/.test(line)) return line;
    vertex++;
    const move = moves.get(vertex);
    if (!move) return line;
    applied++;
    return `v ${move[0]} ${move[1]} ${move[2]}`;
  });
  if (applied !== moves.size) {
    throw new Error(`applied ${applied} of ${moves.size} vertex moves (vertex ids beyond the OBJ pool?)`);
  }
  return lines.join('\n');
}
