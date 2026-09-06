// tier: fast

/** Focused checks for the spine-guided network mesher. Run: `npx tsx test/flow.test.ts` */
import { buildFlow, type FlowRun } from '../src/core/mesh/flow';
import type { SheetPoint } from '../src/core/mesh/sheet';
import { check, failures } from './check';

/** Exact union-of-capsules field — the same region the generator is asked to stay inside. */
const fieldOf = (runs: readonly FlowRun[]) => (x: number, z: number): number => {
  let best = 1e9;
  for (const run of runs) {
    for (let s = 0; s + 1 < run.line.length; s++) {
      const a = run.line[s], b = run.line[s + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      const h = run.half[s] + (run.half[s + 1] - run.half[s]) * t;
      best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) - h);
    }
  }
  return best;
};

const line = (from: SheetPoint, to: SheetPoint, points = 12): SheetPoint[] =>
  Array.from({ length: points }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / (points - 1),
    z: from.z + ((to.z - from.z) * i) / (points - 1),
  }));
const widths = (points: number, half: number): number[] => new Array(points).fill(half);

const build = (runs: FlowRun[]) => buildFlow({ runs, distanceAt: fieldOf(runs), cellM: 12 });

interface Measured {
  inverted: number;
  flowMean: number;
  areaM2: number;
  /** Interior vertices not of valence 4, with the spread of their corner angles. */
  poles: { valence: number; spreadDeg: number }[];
  /** Worst side-length ratio and smallest corner among the junction-patch cells. */
  junctionAspect: number;
  junctionMinAngle: number;
}
const measure = (flow: Extract<ReturnType<typeof buildFlow>, { ok: true }>): Measured => {
  let inverted = 0, errSum = 0, directed = 0, areaM2 = 0;
  let junctionAspect = 1, junctionMinAngle = 90;
  const valence = new Map<number, number>();
  const corners = new Map<number, number[]>();
  const boundary = flow.boundary;
  flow.quads.forEach((q, i) => {
    const ring = [q[0], q[1], q[3], q[2]];
    const p = ring.map(v => flow.points[v]);
    let doubled = 0;
    const sides: number[] = [];
    for (let k = 0; k < 4; k++) {
      doubled += p[k].x * p[(k + 1) % 4].z - p[(k + 1) % 4].x * p[k].z;
      sides.push(Math.hypot(p[(k + 1) % 4].x - p[k].x, p[(k + 1) % 4].z - p[k].z));
    }
    areaM2 += Math.abs(doubled / 2);
    if (Math.sign(doubled / 2) !== flow.winding && doubled !== 0) inverted++;
    ring.forEach((v, k) => {
      valence.set(v, (valence.get(v) ?? 0) + 1);
      const a = p[(k + 3) % 4], b = p[k], c = p[(k + 1) % 4];
      const angle = Math.abs(Math.atan2(
        Math.abs((a.x - b.x) * (c.z - b.z) - (a.z - b.z) * (c.x - b.x)),
        (a.x - b.x) * (c.x - b.x) + (a.z - b.z) * (c.z - b.z))) * 180 / Math.PI;
      (corners.get(v) ?? (corners.set(v, []), corners.get(v)!)).push(angle);
      if (flow.kinds[i] === 'junction') junctionMinAngle = Math.min(junctionMinAngle, angle);
    });
    if (flow.kinds[i] === 'junction') {
      junctionAspect = Math.max(junctionAspect, Math.max(...sides) / Math.max(1e-9, Math.min(...sides)));
    }
    const bearing = flow.flowAngle[i];
    if (bearing === null) return;
    const a = flow.points[q[0]], b = flow.points[q[1]], c = flow.points[q[2]];
    const off = (axis: number) => Math.abs((((bearing - axis) * 180) / Math.PI % 180 + 270) % 180 - 90);
    errSum += Math.min(off(Math.atan2(b.z - a.z, b.x - a.x)), off(Math.atan2(c.z - a.z, c.x - a.x)));
    directed++;
  });
  const poles: { valence: number; spreadDeg: number }[] = [];
  for (const [v, count] of valence) {
    if (boundary.has(v) || count === 4) continue;
    const angles = corners.get(v)!;
    poles.push({ valence: count, spreadDeg: Math.max(...angles) - Math.min(...angles) });
  }
  return { inverted, flowMean: directed ? errSum / directed : 0, areaM2, poles, junctionAspect, junctionMinAngle };
};

// A straight run is a pure grid: every cell flows exactly, the rim is the capsule's own edge.
{
  const runs: FlowRun[] = [{ line: line({ x: 0, z: 0 }, { x: 400, z: 0 }), half: widths(12, 14), from: 0, to: 1 }];
  const flow = build(runs);
  check(flow.ok, 'straight: builds');
  if (flow.ok) {
    const m = measure(flow);
    check(flow.made.wye === 0 && flow.made.junction === 0, 'straight: ladder only');
    check(m.inverted === 0, 'straight: nothing inverted');
    check(m.flowMean < 0.5, `straight: flow exact (${m.flowMean.toFixed(2)}° mean)`);
    check(flow.loops.length === 1, 'straight: one rim loop');
    check(flow.fit.meanM < 0.5, `straight: rim on the survey (${flow.fit.meanM.toFixed(2)} m mean)`);
    check(flow.made.cap > 0, `straight: the trail ends close with caps (${flow.made.cap} cells)`);
    check(m.poles.length === 0, 'straight: no interior poles');
    // 400 m × 28 m of capsule plus the rounded caps the ends now carry
    check(m.areaM2 > 0.85 * 400 * 28 && m.areaM2 < 1.05 * (400 * 28 + Math.PI * 14 * 14),
      `straight: covers its ground (${(m.areaM2 / 1e4).toFixed(2)} ha)`);
  }
}

// A symmetric Y carries the junction's ONE structural pole — a valence-3 centre with even sectors — and
// nothing else irregular: the mouths are grids, and every cell stays near-square.
{
  const runs: FlowRun[] = [
    { line: line({ x: -400, z: 0 }, { x: 0, z: 0 }), half: widths(12, 13), from: 0, to: 1 },
    { line: line({ x: 0, z: 0 }, { x: 200, z: 346 }), half: widths(12, 13), from: 1, to: 2 },
    { line: line({ x: 0, z: 0 }, { x: 200, z: -346 }), half: widths(12, 13), from: 1, to: 3 },
  ];
  const flow = build(runs);
  check(flow.ok, 'wye-less Y: builds');
  if (flow.ok) {
    const m = measure(flow);
    check(flow.made.junction > 0, `wye-less Y: carries a junction patch (${flow.made.junction} cells)`);
    check(m.inverted === 0 && flow.loops.length === 1, 'wye-less Y: one manifold sheet, one rim');
    check(m.poles.length === 1 && m.poles[0].valence === 3,
      `wye-less Y: exactly one pole, the valence-3 centre (${m.poles.map(p => `v${p.valence}`).join(' ') || 'none'})`);
    check(m.poles.length === 1 && m.poles[0].spreadDeg < 45,
      `wye-less Y: the centre's sectors stay even (${m.poles[0]?.spreadDeg.toFixed(0)}° spread)`);
    check(m.junctionAspect < 3.5 && m.junctionMinAngle > 30,
      `wye-less Y: junction cells stay square-ish (aspect ${m.junctionAspect.toFixed(1)}, min angle ${m.junctionMinAngle.toFixed(0)}°)`);
  }
}

// A shallow fork is a wye: the shared ground is one ladder that rips where the rims part — no junction patch
// wide enough to matter, nothing refused, and the result is still one manifold sheet with one rim.
{
  const runs: FlowRun[] = [
    { line: line({ x: -320, z: 0 }, { x: 0, z: 0 }), half: widths(12, 15), from: 0, to: 1 },
    { line: line({ x: 0, z: 0 }, { x: 420, z: 44 }), half: widths(12, 12), from: 1, to: 2 },
    { line: line({ x: 0, z: 0 }, { x: 420, z: -44 }), half: widths(12, 12), from: 1, to: 3 },
  ];
  const flow = build(runs);
  check(flow.ok, 'shallow fork: builds — a 12° fork is a wye, not a refusal');
  if (flow.ok) {
    const m = measure(flow);
    check(flow.made.wye > 0, `shallow fork: carries a wye (${flow.made.wye} cells)`);
    check(m.inverted === 0 && flow.loops.length === 1, 'shallow fork: one manifold sheet, one rim');
    check(m.flowMean < 4, `shallow fork: flow follows the trails (${m.flowMean.toFixed(1)}° mean)`);
  }
}

// A hairpin apex needs no junction at all: two runs out of one node, merged for as long as they overlap.
{
  const runs: FlowRun[] = [
    { line: line({ x: 0, z: 0 }, { x: 400, z: 55 }), half: widths(12, 12), from: 0, to: 1 },
    { line: line({ x: 0, z: 0 }, { x: 400, z: -55 }), half: widths(12, 12), from: 0, to: 2 },
  ];
  const flow = build(runs);
  check(flow.ok, 'hairpin: builds');
  if (flow.ok) {
    const m = measure(flow);
    check(flow.made.junction === 0, 'hairpin: apex is a cap, not a patch');
    check(m.inverted === 0 && flow.loops.length === 1, 'hairpin: one manifold sheet, one rim');
  }
}

// Honest crossings get a junction patch that welds to every ladder edge-for-edge: all quads, no T-junctions,
// which the rim-fork check inside the builder would reject if the weld missed.
{
  const runs: FlowRun[] = [
    { line: line({ x: -300, z: -20 }, { x: 0, z: 0 }), half: widths(12, 12), from: 0, to: 1 },
    { line: line({ x: 0, z: 0 }, { x: 300, z: 20 }), half: widths(12, 12), from: 1, to: 2 },
    { line: line({ x: -40, z: 300 }, { x: 0, z: 0 }), half: widths(12, 13), from: 3, to: 1 },
    { line: line({ x: 0, z: 0 }, { x: 40, z: -300 }), half: widths(12, 13), from: 1, to: 4 },
  ];
  const flow = build(runs);
  check(flow.ok, 'crossing: builds');
  if (flow.ok) {
    const m = measure(flow);
    check(flow.made.junction > 0, `crossing: carries a junction patch (${flow.made.junction} cells)`);
    check(m.inverted === 0 && flow.loops.length === 1, 'crossing: one manifold sheet, one rim');
    check(flow.quads.every(q => new Set(q).size === 4), 'crossing: every cell is a true quad');
    check(m.poles.length === 0, `crossing: an even crossing needs no pole at all (${m.poles.length})`);
    check(m.junctionAspect < 3.5 && m.junctionMinAngle > 30,
      `crossing: junction cells stay square-ish (aspect ${m.junctionAspect.toFixed(1)}, min angle ${m.junctionMinAngle.toFixed(0)}°)`);
  }
}

// Two runs braiding the same ground between the same two nodes are one corridor, not two overlapping wyes:
// the fused sheet covers the union once, so its area is far under the two swaths counted separately.
{
  const bend = (sign: number): SheetPoint[] => Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return { x: 500 * t, z: sign * 14 * Math.sin(t * Math.PI) };
  });
  const runs: FlowRun[] = [
    { line: bend(1), half: widths(24, 13), from: 0, to: 1 },
    { line: bend(-1), half: widths(24, 13), from: 0, to: 1 },
  ];
  const flow = build(runs);
  check(flow.ok, 'braid: builds');
  if (flow.ok) {
    const m = measure(flow);
    check(flow.notes.some(note => note.includes('fused')), 'braid: the pair fuses into one corridor');
    check(m.inverted === 0, 'braid: nothing inverted');
    check(m.areaM2 < 500 * 54 * 1.15, `braid: the union is covered once (${(m.areaM2 / 1e4).toFixed(2)} ha)`);
  }
}

process.exit(failures ? 1 : 0);
