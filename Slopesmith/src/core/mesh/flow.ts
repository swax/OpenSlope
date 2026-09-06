/**
 * Quad-mesh a trail NETWORK so the quads flow along the trails — a spine down the middle of every run, side
 * edges at its surveyed width, and the cells laid between them.
 *
 * `sheet.ts` meshes the same ground as a region under a lattice, which fits everything but points its cells
 * where the lattice points. This asks the question the other way around: the network arrives as a GRAPH —
 * runs with centrelines and widths, meeting at nodes — and that graph already is the quad layout's structure,
 * so the cells are generated from it directly rather than discovered by a field. (That is the lesson of the
 * field-guided quadrangulators this replaces for this domain: the smooth direction field is the easy half,
 * and extracting a quad mesh from one is the unreliable half. A corridor network never needs the extraction,
 * because its corridors are given.)
 *
 * ## The shapes
 *
 * **Ladders.** Each run's free middle is swept: rows perpendicular to the spine at the cell size, columns
 * spread across the cleared width. Every cell's edge points along the trail exactly, because the trail's own
 * tangent built it.
 *
 * **Wyes.** Two runs leaving a node inside `mergeDeg` of each other share cleared ground for as long as it
 * takes their rims to separate — which for six degrees is a very long time, and is the shape a swept junction
 * fan can only refuse. Here they are one wider ladder down the shared ground that RIPS in two at the point
 * where the rims actually part: the last merged row hands one slice of its vertices to each child, sharing a
 * single pinch vertex, and each child ladder continues from there. Nothing is refused at any angle; a shallow
 * fork is simply a corridor that narrows twice.
 *
 * **Junction patches.** Runs meeting at honest angles are cut back just far enough that their end rows clear
 * each other, and the ground between is laid out the way a road crew paints an intersection: each road gets a
 * MOUTH — a grid block from its cut row to a stop-line just inside the junction — and the ground between the
 * stop-lines is a small k-sided court meshed as k corner blocks around ONE centre vertex. That centre is the
 * junction's only structural pole and its valence is the junction's own degree: a Y carries a single
 * valence-3 point, a crossing's centre is an ordinary valence-4 vertex, a five-way carries a single
 * valence-5. Where counts cannot agree — a wide road against a narrow stop-line, or a lopsided court — the
 * mismatch is absorbed by KITES, cells with two edges on the wider row whose off-count vertices are one
 * valence-3/valence-5 pair; a tiny per-junction solver picks the stop-line splits that need the fewest of
 * them, which is the same choice QuadWild's quantization stage makes over its patch layout, owned here
 * because the layout is ours. Blocks share their boundary rows by vertex id, so the patch meets every ladder
 * edge-for-edge with no T-junctions.
 *
 * **Caps.** A node with one cluster and nothing else — a trail end, a hairpin apex — closes with a single
 * block between its last row and the rim traced round the capsule tip, so the mesh follows the survey's own
 * rounded end instead of stopping on a blunt row.
 *
 * A node's incident runs first cluster by departure bearing — clusters merge into wyes, and the junction
 * patch sees each wye as one wide incident.
 *
 * ## Normalizing the network
 *
 * Overlap is modelled only where runs share a node, so the graph is first normalized until that is true of
 * every stretch of shared ground: two corridors sharing ground away from every node they share get a node
 * put there (a crossing becomes a junction, a mid-run brush a pair of wyes, a switchback apex a wye rounded
 * by its own cap), braided pairs fuse into one corridor, junctions joined by runs shorter than their own
 * stop-lines contract into one, and claims on a run's two ends reconcile by ripping the deeper wye earlier.
 * The region's signed distance field is still the authority on the rim: ladders and arcs land near it, and
 * the same fit-and-relax the lattice sheet uses walks the boundary onto the zero set while the interior
 * keeps the cells from shearing. After the fit, the sheet answers to the editor's own geometry diagnostics:
 * unconnected edges inside the marker tolerance are pushed apart, folds across shared edges reflect open,
 * and seam edges that stay snug are named in `creases` for the document to render straight.
 */
import type { Sheet, SheetPoint } from './sheet';
import { TAU, angleGap, cross2, distToPolyline, lengthOf, resample, rowEnds, segCross } from './flow-plane';
import {
  type Corridor, type FlowRun, frameRun, innerRim, leafCorridor, mergeCorridors, outerRim,
} from './flow-corridors';

export type { FlowRun };

export interface FlowOptions {
  runs: readonly FlowRun[];
  /** Metres outside the cleared region; negative inside. Only the sign and zero set are read. */
  distanceAt(x: number, z: number): number;
  cellM: number;
  /** Two runs leaving a node within this of each other share a wye instead of a junction patch. */
  mergeDeg?: number;
  /** Rounds of fit-and-relax. */
  rounds?: number;
  /** Emit a note describing each node's clusters and cuts within this circle — plumbing for offline diagnosis. */
  debug?: { x: number; z: number; radius: number };
}

export interface Flow extends Sheet {
  /**
   * Per quad: the bearing of the trail that built it — ladder and wye cells were swept along it, a junction
   * mouth and a cap continue it — or null for the cells of a junction's central court, which genuinely
   * belong to no one trail.
   */
  flowAngle: (number | null)[];
  /** Per quad: which shape laid it. */
  kinds: ('ladder' | 'wye' | 'junction' | 'cap')[];
  /** Per quad: the generator part that laid it — `run 3`, `mouth 1@1088,680` — for offline diagnostics. */
  parts: string[];
  /**
   * Edges to CREASE straight in the document (vertex-id pairs). The editor draws its diagnostics on the
   * rendered cubics, whose Bessel default bows past the straight line at kinks; where two unconnected
   * edges stay snug after every pass, straightening them keeps the bow from closing a gap the plain
   * geometry clears. Consumers write chord handles ((far − near)/3, both directions) for each pair.
   */
  creases: [number, number][];
  made: { ladder: number; wye: number; junction: number; cap: number };
  notes: string[];
}

export type FlowResult = ({ ok: true } & Flow) | { ok: false; error: string };

// ---- the builder -------------------------------------------------------------------------------------------

export function buildFlow(options: FlowOptions): FlowResult {
  const cell = options.cellM;
  if (!(cell > 0)) return { ok: false, error: 'Flow needs a positive cell size.' };
  if (!options.runs.length) return { ok: false, error: 'Flow needs at least one run.' };
  const { distanceAt } = options;
  const mergeRad = ((options.mergeDeg ?? 50) * Math.PI) / 180;
  const notes: string[] = [];

  /**
   * Fuse braided pairs — two runs between the SAME two nodes whose swaths overlap most of the way. A wye
   * models ground that is shared out of one node and parts; a braid shares its ground out of BOTH nodes at
   * once, so left alone each end would lay a wye over the whole pair and cover it twice. The pair is really
   * one corridor as wide as both, which is what it becomes here; the rim fit still reads the true edge off
   * the distance field. Runs sharing both nodes WITHOUT overlapping — two honest ways around a stand of
   * forest — part quickly and are left alone.
   */
  const runs: FlowRun[] = options.runs.map(run => ({ ...run }));
  const fuseBraids = (): void => {
    for (let fused = true; fused;) {
      fused = false;
      pairs: for (let i = 0; i < runs.length && !fused; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          const a = runs[i], b = runs[j];
          const same = (a.from === b.from && a.to === b.to);
          const opposed = (a.from === b.to && a.to === b.from);
          if (!same && !opposed) continue;
          const fa = frameRun(a), fb = frameRun(b);
          const samples = 24;
          let covered = 0;
          const centre: SheetPoint[] = [], half: number[] = [];
          for (let k = 0; k <= samples; k++) {
            const p = fa.pointAt((fa.length * k) / samples);
            const q = fb.pointAt(opposed ? fb.length - (fb.length * k) / samples : (fb.length * k) / samples);
            const apart = Math.hypot(p.x - q.x, p.z - q.z);
            const ha = fa.halfAt((fa.length * k) / samples);
            const hb = fb.halfAt(opposed ? fb.length - (fb.length * k) / samples : (fb.length * k) / samples);
            // The pair is one corridor wherever the ground BETWEEN the spines is cleared — swaths openly
            // overlapping, or a sliver of "stand" between two near-parallel rims the region says isn't
            // there. Only a real hole in the footprint separates two ways around it; spines far apart are
            // genuinely two places even when other cleared ground happens to lie between them.
            const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
            if (apart < ha + hb || (apart < 2 * (ha + hb) && distanceAt(mid.x, mid.z) < -0.5)) covered++;
            centre.push(mid);
            half.push((apart + ha + hb) / 2);
          }
          if (covered < samples * 0.7) {
            if (options.debug) {
              const at = fa.pointAt(fa.length / 2);
              if (Math.hypot(at.x - options.debug.x, at.z - options.debug.z) <= options.debug.radius * 2) {
                notes.push(`DEBUG braid ${i}:${a.from}->${a.to} × ${j}:${b.from}->${b.to}: covered ${covered}/${samples + 1}`);
              }
            }
            continue;
          }
          notes.push(`runs ${i} and ${j} braid the same ground — fused into one corridor`);
          runs.splice(j, 1);
          runs[i] = { line: centre, half, from: a.from, to: a.to };
          fused = true;
          continue pairs;
        }
      }
    }
  };
  fuseBraids();

  /**
   * Put a node wherever two corridors share ground AWAY from every node they share — one trail crossing
   * another mid-run, two swaths brushing between junctions, a switchback folding over its own clearing.
   * The graph models shared ground only at nodes (wyes, junctions and braids all hang off one), so ground
   * shared anywhere else is simply paved twice. Splitting the runs at the overlap's centre hands that
   * ground to the ordinary machinery: a crossing becomes a junction, a brush becomes a pair of wyes that
   * rip where the rims part, a switchback apex becomes a wye rounded off by its own cap.
   */
  {
    let nextNode = runs.reduce((top, run) => Math.max(top, run.from, run.to), 0) + 1;
    const step = Math.max(2, cell / 2);
    /** Split `runs[r]` at arc `s`, seating the cut on `at`, and hand both halves the node `id`. The spine
     *  BENDS to reach `at` over the last few cells rather than kinking — the node's incidents must leave
     *  one shared point or every merge scan at the node reads them as already parted — and the bend lives
     *  inside the junction zone the cuts step past anyway. */
    const cutRun = (r: number, s: number, at: SheetPoint, id: number): void => {
      const run = runs[r], frame = frameRun(run);
      const seat = frame.pointAt(s);
      const shift = { x: at.x - seat.x, z: at.z - seat.z };
      const blend = 2.5 * cell;
      const headLine: SheetPoint[] = [], headHalf: number[] = [];
      const tailLine: SheetPoint[] = [], tailHalf: number[] = [];
      for (let k = 0; k < run.line.length; k++) {
        const behind = frame.cumulative[k] < s - 1e-6;
        const ease = Math.max(0, 1 - Math.abs(frame.cumulative[k] - s) / blend);
        const point = { x: run.line[k].x + shift.x * ease, z: run.line[k].z + shift.z * ease };
        (behind ? headLine : tailLine).push(point);
        (behind ? headHalf : tailHalf).push(run.half[k]);
      }
      headLine.push(at); headHalf.push(frame.halfAt(s));
      tailLine.unshift(at); tailHalf.unshift(frame.halfAt(s));
      runs[r] = { line: headLine, half: headHalf, from: run.from, to: id };
      runs.push({ line: tailLine, half: tailHalf, from: id, to: run.to });
    };
    for (let round = 0; round < 40; round++) {
      const frames = runs.map(frameRun);
      const samples = runs.map((run, r) => {
        const out: { s: number; x: number; z: number; h: number }[] = [];
        for (let s = 0; s <= frames[r].length; s += step) {
          const p = frames[r].pointAt(s);
          out.push({ s, x: p.x, z: p.z, h: frames[r].halfAt(s) });
        }
        return out;
      });
      const boxes = samples.map(list => {
        const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
        for (const p of list) {
          box.minX = Math.min(box.minX, p.x - p.h); box.maxX = Math.max(box.maxX, p.x + p.h);
          box.minZ = Math.min(box.minZ, p.z - p.h); box.maxZ = Math.max(box.maxZ, p.z + p.h);
        }
        return box;
      });
      let acted = false;
      search: for (let i = 0; i < runs.length; i++) {
        for (let j = i; j < runs.length; j++) {
          if (boxes[i].minX > boxes[j].maxX || boxes[j].minX > boxes[i].maxX
            || boxes[i].minZ > boxes[j].maxZ || boxes[j].minZ > boxes[i].maxZ) continue;
          // Where run i's swath is buried in run j's, by more than a graze. A run against itself only
          // counts a FOLD — the spine path between the two samples far longer than the ground between
          // them — so an ordinary curve, whose arc and chord agree, never trips it.
          const marks: { s: number; sj: number }[] = [];
          for (const p of samples[i]) {
            let best = { depth: -Infinity, sj: 0 };
            for (const q of samples[j]) {
              const d = Math.hypot(p.x - q.x, p.z - q.z);
              const depth = p.h + q.h - d;
              if (i === j && Math.abs(p.s - q.s) <= d * 1.2 + cell * 0.5) continue;
              // Openly overlapping swaths always count. Rims merely CLOSE count when no ridge of forest
              // stands between them in the region — the footprint joins such rims into one edge, the two
              // boundaries land fitted onto the same line, and the editor flags every landing.
              let together = depth > 1;
              if (!together && depth > -2.5 && d > 1e-6) {
                const t = (p.h + (d - p.h - q.h) / 2) / d;
                together = distanceAt(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t) < 0.3;
              }
              if (!together) continue;
              if (depth > best.depth) best = { depth, sj: q.s };
            }
            if (best.depth > -Infinity) marks.push({ s: p.s, sj: best.sj });
          }
          if (!marks.length) continue;
          const intervals: { a: number; b: number; sj: number }[] = [];
          for (const mark of marks) {
            const last = intervals[intervals.length - 1];
            if (last && mark.s - last.b <= step * 2.5) last.b = mark.s;
            else intervals.push({ a: mark.s, b: mark.s, sj: mark.sj });
          }
          const shared = i === j ? [runs[i].from, runs[i].to]
            : [runs[i].from, runs[i].to].filter(n => n === runs[j].from || n === runs[j].to);
          const attach = 2.5 * cell;
          const near = (r: number, s: number, node: number): boolean =>
            (runs[r].from === node && s < attach) || (runs[r].to === node && frames[r].length - s < attach);
          for (const [at, interval] of intervals.entries()) {
            if (options.debug) {
              const mid = frames[i].pointAt((interval.a + interval.b) / 2);
              if (Math.hypot(mid.x - options.debug.x, mid.z - options.debug.z) <= options.debug.radius) {
                notes.push(`DEBUG overlap ${i}:${runs[i].from}->${runs[i].to} × ${j}:${runs[j].from}->${runs[j].to}`
                  + ` [${interval.a.toFixed(0)}..${interval.b.toFixed(0)}] of ${frames[i].length.toFixed(0)}`
                  + ` sj ${interval.sj.toFixed(0)} of ${frames[j].length.toFixed(0)} shared ${shared.join(',') || 'none'}`);
              }
            }
            if (interval.b - interval.a < cell) continue;
            if (shared.some(n => near(i, interval.a, n) || near(i, interval.b, n))) continue;
            if (i === j) {
              // The fold's apex sits in the gap between this interval and its mirror; one merged interval
              // straddles the apex itself.
              const twin = intervals[at + 1];
              const apex = twin ? (interval.b + twin.a) / 2 : (interval.a + interval.b) / 2;
              if (apex < 2 * cell || frames[i].length - apex < 2 * cell) continue;
              const p = frames[i].pointAt(apex);
              notes.push(`run ${i} folds over its own clearing — split at the apex ${p.x.toFixed(0)},${p.z.toFixed(0)}`);
              cutRun(i, apex, p, nextNode++);
              acted = true;
              break search;
            }
            const si = (interval.a + interval.b) / 2;
            const pi = frames[i].pointAt(si);
            let sj = interval.sj, bestD = Infinity;
            for (const q of samples[j]) {
              const d = Math.hypot(pi.x - q.x, pi.z - q.z);
              if (d < bestD) { bestD = d; sj = q.s; }
            }
            const pj = frames[j].pointAt(sj);
            const middle = { x: (pi.x + pj.x) / 2, z: (pi.z + pj.z) / 2 };
            const iMid = si >= 2 * cell && frames[i].length - si >= 2 * cell;
            const jMid = sj >= 2 * cell && frames[j].length - sj >= 2 * cell;
            if (iMid && jMid) {
              notes.push(`runs ${i} and ${j} share ground away from their nodes — node added at `
                + `${middle.x.toFixed(0)},${middle.z.toFixed(0)}`);
              const id = nextNode++;
              cutRun(i, si, middle, id);
              cutRun(j, sj, middle, id);
            } else if (iMid !== jMid) {
              // One side of the overlap is already a node's own doorstep: hang the other run off that node.
              const [whole, ended] = iMid ? [i, j] : [j, i];
              const s = iMid ? si : sj;
              const endS = iMid ? sj : si;
              const id = endS < 2 * cell ? runs[ended].from : runs[ended].to;
              const anchor = endS < 2 * cell ? frames[ended].pointAt(0)
                : frames[ended].pointAt(frames[ended].length);
              notes.push(`run ${whole} crosses the door of node ${id} — split there`);
              cutRun(whole, s, anchor, id);
            } else {
              continue;
            }
            acted = true;
            break search;
          }
        }
      }
      if (!acted) break;
      fuseBraids();
    }
  }

  let frames = runs.map(frameRun);
  for (const [index, frame] of frames.entries()) {
    if (!(frame.length > cell * 0.5)) return { ok: false, error: `Run ${index} is shorter than half a cell.` };
  }

  /** Cells across a run — even, so junction patches can pair their boundary edges two by two. */
  const columnsOf = (run: FlowRun): number => {
    const width = 2 * run.half.reduce((sum, h) => sum + h, 0) / run.half.length;
    return Math.max(2, 2 * Math.round(width / (2 * cell)));
  };
  let runColumns = runs.map(columnsOf);

  // ---- vertices, rows, cells ------------------------------------------------------------------------------
  const xs: number[] = [], zs: number[] = [];
  const vertex = (p: SheetPoint): number => { xs.push(p.x); zs.push(p.z); return xs.length - 1; };
  /** Perimeter-ordered cells, converted to the quilt's storage order on return. */
  const cells: [number, number, number, number][] = [];
  const cellFlow: (number | null)[] = [];
  const cellKind: ('ladder' | 'wye' | 'junction' | 'cap')[] = [];
  const cellPart: string[] = [];
  let currentPart = '';
  /** Name the generator part for the cells laid until the next call — provenance, not geometry. */
  const part = (label: string) => { currentPart = label; };
  const made = { ladder: 0, wye: 0, junction: 0, cap: 0 };
  const addCell = (a: number, b: number, c: number, d: number, flow: number | null, kind: keyof typeof made) => {
    cells.push([a, b, c, d]); cellFlow.push(flow); cellKind.push(kind); cellPart.push(currentPart); made[kind]++;
  };

  /** A realized cross row: vertex ids ordered from the −n̂ side to the +n̂ side of its owner. */
  type Row = number[];

  /**
   * Cells across at ONE arc position — the local width's own even count. A run's `columns` is its average;
   * a row realized at a junction cut takes the width it actually stands on, and the sweep knits the
   * difference away with kite rows where the trail itself swells or narrows.
   */
  const columnsAtS = (corridor: Corridor, s: number): number =>
    Math.max(2, 2 * Math.round(corridor.halfAt(s) / cell));

  const rowFor = (corridor: Corridor, s: number, columns?: number): SheetPoint[] => {
    if (corridor.kind === 'merged') {
      const { left, right } = corridor;
      const lo = outerRim(left!, right!, s), ro = outerRim(right!, left!, s);
      const li = innerRim(left!, right!, s), ri = innerRim(right!, left!, s);
      const seam = { x: (li.x + ri.x) / 2, z: (li.z + ri.z) / 2 };
      const points: SheetPoint[] = [];
      // Left slice runs +n̂→seam? Order the whole row −n̂ to +n̂ of the merged tangent: right outer first when
      // the right child is on the −n̂ side. The merged tangent's −n̂ side is the clockwise side, which is where
      // `right` sits by the merge's own left/right choice.
      for (let k = 0; k <= right!.columns; k++) {
        const t = k / right!.columns;
        points.push({ x: ro.x + (seam.x - ro.x) * t, z: ro.z + (seam.z - ro.z) * t });
      }
      for (let k = 1; k <= left!.columns; k++) {
        const t = k / left!.columns;
        points.push({ x: seam.x + (lo.x - seam.x) * t, z: seam.z + (lo.z - seam.z) * t });
      }
      return points;
    }
    const p = corridor.pointAt(s), t = corridor.tangentAt(s), h = corridor.halfAt(s);
    const nx = -t.z, nz = t.x;
    const n = columns ?? corridor.columns;
    return Array.from({ length: n + 1 }, (_, k) => {
      const w = (2 * k) / n - 1;
      return { x: p.x + nx * h * w, z: p.z + nz * h * w };
    });
  };

  const bearingOf = (corridor: Corridor, s: number): number => {
    const t = corridor.tangentAt(s);
    return Math.atan2(t.z, t.x);
  };

  /** Sweep cells between two realized rows of equal length. */
  const ladderBetween = (from: Row, to: Row, flow: number, kind: keyof typeof made) => {
    for (let k = 0; k + 1 < from.length; k++) addCell(from[k], from[k + 1], to[k + 1], to[k], flow, kind);
  };

  /**
   * Sweep cells between rows whose edge counts differ by an even number. Each two edges of difference knit
   * away as one KITE — a triangle-shaped cell with two edges on the wider row — whose apex is a valence-5
   * point on the narrow row paired with a valence-3 point mid-wide-row: the one pole pair a quad mesh pays
   * wherever a strip changes width. Kites spread evenly across the row so the poles stay apart, and the
   * relax evens their sector angles like any other interior pole.
   */
  const ladderKnit = (from: Row, to: Row, flow: number, kind: keyof typeof made) => {
    if (from.length === to.length) { ladderBetween(from, to, flow, kind); return; }
    const shrink = from.length > to.length;
    const wide = shrink ? from : to, narrow = shrink ? to : from;
    const wideEdges = wide.length - 1, narrowEdges = narrow.length - 1;
    const kites = (wideEdges - narrowEdges) / 2;
    let iw = 0, ik = 0, laid = 0;
    while (iw < wideEdges) {
      const wantKite = laid < kites
        && (narrowEdges - ik <= 0 || wideEdges - iw <= 2 * (kites - laid)
          || iw >= ((laid + 0.5) * wideEdges) / kites - 1);
      if (wantKite && iw + 2 <= wideEdges) {
        if (shrink) addCell(wide[iw], wide[iw + 1], wide[iw + 2], narrow[ik], flow, kind);
        else addCell(narrow[ik], wide[iw + 2], wide[iw + 1], wide[iw], flow, kind);
        iw += 2; laid++;
        continue;
      }
      if (shrink) addCell(wide[iw], wide[iw + 1], narrow[ik + 1], narrow[ik], flow, kind);
      else addCell(narrow[ik], narrow[ik + 1], wide[iw + 1], wide[iw], flow, kind);
      iw += 1; ik += 1;
    }
  };

  // ---- nodes and their incident corridors -----------------------------------------------------------------
  interface Incident { corridor: Corridor; bearing: number }
  interface Node { at: SheetPoint; incidents: Incident[] }
  const nodes = new Map<number, Node>();
  const leafAt = (node: number, run: number, end: 'from' | 'to') => {
    const corridor = leafCorridor(runs[run], frames[run], end, run, runColumns[run]);
    const reach = Math.min(45, frames[run].length / 2);
    const found = nodes.get(node) ?? (() => {
      const fresh: Node = { at: corridor.pointAt(0), incidents: [] };
      nodes.set(node, fresh);
      return fresh;
    })();
    found.incidents.push({ corridor, bearing: bearingOf(corridor, reach) });
  };
  /**
   * Would these two corridors still be sharing ground at the distance a junction would cut them? If so, no
   * rim passes between their cut rows, a patch there would have nothing to trace its side along — and more to
   * the point, ground shared PAST the junction is exactly what a wye is. Overlap decides the merge, not just
   * bearing; the angle threshold merely spares the arithmetic where the bearings alone settle it.
   */
  const sealedTogether = (a: Incident, b: Incident): boolean => {
    const gap = Math.abs(angleGap(a.bearing, b.bearing));
    if (gap > Math.PI * 0.55) return false;
    const ha = a.corridor.halfAt(0), hb = b.corridor.halfAt(0);
    const reach = Math.min(1.3 * (ha + hb) / (2 * Math.max(Math.sin(gap / 2), 0.1)),
      a.corridor.limit * 0.5, b.corridor.limit * 0.5);
    const p = a.corridor.pointAt(reach), q = b.corridor.pointAt(reach);
    return Math.hypot(p.x - q.x, p.z - q.z) < a.corridor.halfAt(reach) + b.corridor.halfAt(reach);
  };

  /**
   * Cluster a node's incidents and merge each cluster into one corridor. What remains is the node's GROUPS —
   * the junction patch's actual incidents, each one run or one nested wye.
   */
  const groupsAt = (node: Node): Incident[] => {
    const sorted = [...node.incidents].sort((a, b) => a.bearing - b.bearing);
    if (sorted.length < 2) return sorted;
    // Cut the ring at the widest gap, then sweep: neighbours that merge join the open cluster.
    let widest = 0, widestGap = -1;
    for (let i = 0; i < sorted.length; i++) {
      const next = sorted[(i + 1) % sorted.length];
      const gap = ((next.bearing - sorted[i].bearing) % TAU + TAU) % TAU;
      if (gap > widestGap) { widestGap = gap; widest = (i + 1) % sorted.length; }
    }
    const ring = [...sorted.slice(widest), ...sorted.slice(0, widest)];
    const clusters: Incident[][] = [[ring[0]]];
    for (let i = 1; i < ring.length; i++) {
      const previous = clusters[clusters.length - 1];
      const gap = ((ring[i].bearing - previous[previous.length - 1].bearing) % TAU + TAU) % TAU;
      // The spread cap keeps neighbour-by-neighbour merging from chaining a basin's whole compass into
      // one "corridor": sealed pairs may chain, but never past the widest pair sealedTogether itself
      // accepts — incidents spanning more than that are a junction, whatever their overlaps say.
      const spread = ((ring[i].bearing - previous[0].bearing) % TAU + TAU) % TAU;
      const joins = spread <= Math.PI * 0.55
        && (gap < mergeRad || sealedTogether(previous[previous.length - 1], ring[i]));
      if (joins) previous.push(ring[i]);
      else clusters.push([ring[i]]);
    }
    // One cluster holding the whole node is a hairpin ONLY if its legs genuinely leave together. A basin
    // junction seals every neighbour pair — chaining would glue its roads into one "corridor" and cap a
    // blob — so a wide lone cluster re-clusters on bearing alone and takes an ordinary junction patch.
    if (clusters.length === 1 && ring.length >= 2) {
      const spread = ((ring[ring.length - 1].bearing - ring[0].bearing) % TAU + TAU) % TAU;
      if (spread > mergeRad) {
        clusters.length = 0;
        clusters.push([ring[0]]);
        for (let i = 1; i < ring.length; i++) {
          const previous = clusters[clusters.length - 1];
          const gap = ((ring[i].bearing - previous[previous.length - 1].bearing) % TAU + TAU) % TAU;
          if (gap < mergeRad) previous.push(ring[i]);
          else clusters.push([ring[i]]);
        }
      }
    }
    return clusters.map(cluster => {
      while (cluster.length > 1) {
        // Merge the closest pair first, so the tightest fork rips last.
        let at = 0, best = Infinity;
        for (let i = 0; i + 1 < cluster.length; i++) {
          const gap = Math.abs(angleGap(cluster[i + 1].bearing, cluster[i].bearing));
          if (gap < best) { best = gap; at = i; }
        }
        const label = `node at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}`;
        const trace = !!options.debug
          && Math.hypot(node.at.x - options.debug.x, node.at.z - options.debug.z) <= options.debug.radius;
        const merged = mergeCorridors(cluster[at].corridor, cluster[at + 1].corridor, cell, notes, label, trace);
        const bearing = Math.atan2(
          Math.sin(cluster[at].bearing) + Math.sin(cluster[at + 1].bearing),
          Math.cos(cluster[at].bearing) + Math.cos(cluster[at + 1].bearing));
        cluster.splice(at, 2, { corridor: merged, bearing });
      }
      return cluster[0];
    });
  };

  // ---- cuts: how far each group steps back from its node --------------------------------------------------
  /** Interface rows already realized, keyed by run and end, with the arc distance they sit at. */
  const runStart = new Map<string, { s: number; row: Row }>();
  const runEndKey = (run: number, end: 'from' | 'to') => `${run}:${end}`;

  const cutFor = (groups: Incident[], index: number): number => {
    // A lone MERGED cluster is a fold — a hairpin's two legs out of their apex. Rows near the fold twist
    // around the degenerate tip where the legs' inner rims coincide, so the wye starts well out and the
    // cap's dome owns the whole tip.
    if (groups.length < 2) return groups[index]?.corridor.kind === 'merged' ? cell * 2.5 : 0;
    const own = groups[index];
    let cut = Math.max(cell, own.corridor.halfAt(0) * 0.9);
    for (const offset of [-1, 1]) {
      const other = groups[(index + offset + groups.length) % groups.length];
      if (other === own) continue;
      const gap = Math.min(Math.abs(angleGap(own.bearing, other.bearing)), Math.PI);
      const spread = Math.max(Math.sin(gap / 2), Math.sin(mergeRad / 2));
      cut = Math.max(cut, 1.15 * (own.corridor.halfAt(0) + other.corridor.halfAt(0)) / (2 * spread));
    }
    return Math.min(cut, own.corridor.limit * 0.6);
  };

  /**
   * Lay a corridor's ladder from its node-side cut to wherever it ends, realizing shared rows exactly once.
   * A merged corridor recurses into its children at the rip; a leaf records its start row for the run sweep.
   */
  const realizeRow = (points: SheetPoint[]): Row => points.map(vertex);
  const buildCorridor = (corridor: Corridor, fromS: number, startRow: Row | null): Row | null => {
    if (corridor.kind === 'leaf') {
      if (!startRow) {
        const other = runStart.get(runEndKey(corridor.run!, corridor.end === 'from' ? 'to' : 'from'));
        if (other) {
          // Each junction cuts its row perpendicular to ITS OWN local tangent; on a short curving
          // connector the two rows scissor — crossing at one end while their arcs say there is room.
          // Whenever this row would LAND on the other end's (by claims, or measured column against
          // column), the two junctions build against one shared row instead.
          const points = rowFor(corridor, fromS, columnsAtS(corridor, fromS));
          const n = other.row.length;
          const lands = sharedRows.has(corridor.run!)
            || (points.length === n && points.some((p, k) => {
              const q = other.row[n - 1 - k];
              return Math.hypot(p.x - xs[q], p.z - zs[q]) < cell * 0.5;
            }));
          if (lands) {
            const row = [...other.row].reverse();
            runStart.set(runEndKey(corridor.run!, corridor.end!),
              { s: frames[corridor.run!].length - other.s, row });
            return row;
          }
          const row = realizeRow(points);
          runStart.set(runEndKey(corridor.run!, corridor.end!), { s: fromS, row });
          return row;
        }
      }
      const row = startRow ?? realizeRow(rowFor(corridor, fromS, columnsAtS(corridor, fromS)));
      runStart.set(runEndKey(corridor.run!, corridor.end!), { s: fromS, row });
      return row;
    }
    // A rip within a cell of the cut has no room for a band of rows — laying one anyway squeezes a strip
    // of sliver cells against the junction's own blocks. The corridor rips ON its cut row instead, the
    // children reading their slices straight off it.
    if (corridor.split! <= fromS + cell * 0.6) {
      const row = startRow ?? realizeRow(rowFor(corridor, fromS));
      const right = corridor.right!, left = corridor.left!;
      const pinch = right.columns;
      buildCorridor(right, Math.max(corridor.split!, fromS), row.slice(0, pinch + 1));
      buildCorridor(left, Math.max(corridor.split!, fromS), row.slice(pinch));
      return row;
    }
    const start = Math.min(fromS, Math.max(0, corridor.split! - cell * 0.75));
    const span = Math.max(cell * 0.5, corridor.split! - start);
    const rows = Math.max(1, Math.round(span / cell));
    let previous = startRow ?? realizeRow(rowFor(corridor, start));
    const first = previous;
    const origin = corridor.pointAt(0);
    part(`wye@${origin.x.toFixed(0)},${origin.z.toFixed(0)}`);
    for (let r = 1; r <= rows; r++) {
      const s = start + (span * r) / rows;
      const row = realizeRow(rowFor(corridor, s));
      ladderBetween(previous, row, bearingOf(corridor, s - span / rows / 2), 'wye');
      previous = row;
    }
    // The rip: the right child reads the row −n̂-side first, exactly the order the merged row was laid in.
    const right = corridor.right!, left = corridor.left!;
    const pinch = right.columns;
    buildCorridor(right, corridor.split!, previous.slice(0, pinch + 1));
    buildCorridor(left, corridor.split!, previous.slice(pinch));
    return first;
  };

  interface PatchPlan { node: Node; groups: { incident: Incident; cut: number; row: Row }[] }
  interface NodePlan { node: Node; groups: Incident[]; cuts: number[] }
  const plans: NodePlan[] = [];
  const noted = new Set<string>();
  for (let attempt = 0; attempt < 8; attempt++) {
  nodes.clear();
  plans.length = 0;
  runs.forEach((run, index) => {
    if (run.from === run.to && !noted.has(`loop:${run.from}`)) {
      noted.add(`loop:${run.from}`);
      notes.push(`run ${index} loops back to its own node — treated as two incidents`);
    }
    leafAt(run.from, index, 'from');
    leafAt(run.to, index, 'to');
  });
  for (const node of nodes.values()) {
    let groups = groupsAt(node);
    let cuts = groups.map((_, index) => cutFor(groups, index));
    // A merge whose rims part before the junction's own cut row is no wye at all — every scrap of its
    // shared ground is junction interior, and one merged row cannot face two directions at once: a child
    // departing sideways gets its slice pinched to a needle at the patch's waist. The children stand as
    // sides of the junction in their own right, each with a cut row square to its OWN bearing.
    if (groups.length >= 2) {
      for (let round = 0; round < 8; round++) {
        const at = groups.findIndex((group, index) =>
          group.corridor.kind === 'merged' && group.corridor.split! <= cuts[index] + cell * 0.6);
        if (at < 0) break;
        const merged = groups[at].corridor;
        const children = [merged.left!, merged.right!].map(child => ({
          corridor: child,
          bearing: bearingOf(child, Math.min(45, child.limit / 2)),
        }));
        groups.splice(at, 1, ...children);
        groups = [...groups].sort((a, b) => a.bearing - b.bearing);
        cuts = groups.map((_, index) => cutFor(groups, index));
        notes.push(`node at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: `
          + `a wye ripping on the junction's own cut row dissolved into separate sides`);
      }
    }
    if (groups.length >= 2) {
      // The pair formula assumed two capsules; a wye's edge member or a wide overlap can leave a cut row's
      // CORNER buried inside the neighbouring swath, and a rim arc cannot start underground. Push each group
      // whose corner is buried until both its corners surface. A corner buried under an unrelated crossing
      // trail may never surface — the push gives up at its bound and the chord fallback carries that side.
      // Pushing only helps against an ADJACENT swath, whose overlap fades at the junction's own scale; a
      // corner under an unrelated crossing trail would push forever, so the bound stays a few cells and the
      // chord fallback carries what remains.
      const bounds = groups.map(({ corridor }, index) => Math.min(corridor.limit * 0.6, cuts[index] + 4 * cell));
      for (let round = 0; round < 24; round++) {
        let pushed = false;
        for (const [index, group] of groups.entries()) {
          if (cuts[index] >= bounds[index] - 1e-6) continue;
          const points = rowFor(group.corridor, cuts[index]);
          const ends = rowEnds(points, group.bearing, node.at);
          if (distanceAt(ends.cw.x, ends.cw.z) < -1 || distanceAt(ends.ccw.x, ends.ccw.z) < -1) {
            cuts[index] = Math.min(cuts[index] + cell, bounds[index]);
            pushed = true;
          }
        }
        // A row corner lying almost ON the neighbouring row's line — yet nowhere near its corner — is the
        // other way a cut fails: neither corner is buried, but the patch side between the rows would run
        // the length of a ladder at sliver width. Push the encroaching group until its row pulls clear.
        for (let i = 0; i < groups.length && groups.length > 1; i++) {
          const next = (i + 1) % groups.length;
          const rowI = rowFor(groups[i].corridor, cuts[i]);
          const rowN = rowFor(groups[next].corridor, cuts[next]);
          const endI = rowEnds(rowI, groups[i].bearing, node.at).ccw;
          const startN = rowEnds(rowN, groups[next].bearing, node.at).cw;
          const apart = Math.hypot(endI.x - startN.x, endI.z - startN.z);
          if (apart <= cell * 1.5) continue;
          if (cuts[next] < bounds[next] - 1e-6 && distToPolyline(startN, rowI) < cell * 0.6) {
            cuts[next] = Math.min(cuts[next] + cell, bounds[next]);
            pushed = true;
          }
          if (cuts[i] < bounds[i] - 1e-6 && distToPolyline(endI, rowN) < cell * 0.6) {
            cuts[i] = Math.min(cuts[i] + cell, bounds[i]);
            pushed = true;
          }
        }
        if (!pushed) break;
      }
    }
    plans.push({ node, groups, cuts });
    if (options.debug && Math.hypot(node.at.x - options.debug.x, node.at.z - options.debug.z) <= options.debug.radius) {
      const describe = (corridor: Corridor): string => corridor.kind === 'leaf'
        ? `run ${corridor.run}:${runs[corridor.run!].from}->${runs[corridor.run!].to}`
        : `merge(${describe(corridor.left!)}, ${describe(corridor.right!)})@split ${corridor.split!.toFixed(0)}`;
      notes.push(`DEBUG node ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: ${groups.length} group(s) of `
        + `${node.incidents.length} incident(s) — ${groups.map((group, index) =>
          `[${describe(group.corridor)} bearing ${(group.bearing * 180 / Math.PI).toFixed(0)}° cut ${cuts[index].toFixed(0)}]`).join(' ')}`);
    }
  }

  /**
   * Two junctions joined by a run shorter than the two cuts that claim it are ONE junction — a road crew
   * paints a single big intersection where two stop lines would overlap. Contract the run: its far node's
   * incidents move to its near node, the run's ground becomes junction interior, and the planning starts
   * over on the smaller graph. Only plain-cut ends contract; an end merged into a wye can give ground by
   * ripping earlier instead, which the claims pass below arranges.
   */
  {
    // Only plain-cut ends contract; an end merged into a wye can give ground by ripping earlier instead,
    // which the claims pass below arranges.
    const cutClaims = new Map<string, number>();
    for (const plan of plans) {
      plan.groups.forEach((incident, index) => {
        if (incident.corridor.kind === 'leaf') {
          cutClaims.set(runEndKey(incident.corridor.run!, incident.corridor.end!), plan.cuts[index]);
        }
      });
    }
    let contracted = -1;
    for (const [index, run] of runs.entries()) {
      if (run.from === run.to || frames[index].length > 3.5 * cell) continue;
      const head = cutClaims.get(runEndKey(index, 'from')), tail = cutClaims.get(runEndKey(index, 'to'));
      if (head === undefined || tail === undefined) continue;
      if (frames[index].length >= head + tail + cell * 0.5) continue;
      contracted = index;
      break;
    }
    if (contracted >= 0 && attempt < 7) {
      const gone = runs[contracted];
      const keep = gone.from, drop = gone.to;
      const keepAt = gone.line[0];
      notes.push(`nodes ${keep} and ${drop} sit closer than their junctions need — contracted into one`);
      // Every short parallel between the pair is junction interior now, not a corridor of its own.
      for (let r = runs.length - 1; r >= 0; r--) {
        const between = (runs[r].from === keep && runs[r].to === drop)
          || (runs[r].from === drop && runs[r].to === keep);
        if (between && frameRun(runs[r]).length <= 6 * cell) runs.splice(r, 1);
      }
      // The moved incidents BEND onto the kept node's own point: a node whose incidents start from
      // scattered points reads every pair as already parted, and its whole patch folds.
      const bendEnd = (run: FlowRun, end: 'from' | 'to'): void => {
        const frame = frameRun(run);
        const tip = end === 'from' ? run.line[0] : run.line[run.line.length - 1];
        const shift = { x: keepAt.x - tip.x, z: keepAt.z - tip.z };
        const blend = 2.5 * cell;
        run.line = run.line.map((p, k) => {
          const away = end === 'from' ? frame.cumulative[k] : frame.length - frame.cumulative[k];
          const ease = Math.max(0, 1 - away / blend);
          return { x: p.x + shift.x * ease, z: p.z + shift.z * ease };
        });
      };
      for (const run of runs) {
        if (run.from === drop) { bendEnd(run, 'from'); run.from = keep; }
        if (run.to === drop) { bendEnd(run, 'to'); run.to = keep; }
      }
      frames = runs.map(frameRun);
      runColumns = runs.map(columnsOf);
      continue;
    }
  }
  break;
  }

  /**
   * Reconcile CLAIMS before any cell is laid. Each node-side structure owns a run up to the point it
   * hands the run's ladder its first row — a junction cut, or the rip of whatever wye tree the run end
   * is merged into. The two ends never consult each other, and on a short run their claims can overlap:
   * two wyes ripping past each other pave the middle twice, and their rows pile onto one point. The
   * deeper rip gives way until the claims fit — a wye that rips before its rims part is already a
   * supported shape (the clamp note and the unfold pass exist for it), where doubled ground is not.
   */
  for (let round = 0; round < 12; round++) {
    interface Claim { handover: number; chain: Corridor[]; plan: NodePlan; group: number }
    const claims = new Map<string, Claim>();
    for (const plan of plans) {
      plan.groups.forEach((incident, index) => {
        const walk = (corridor: Corridor, from: number, chain: Corridor[]): void => {
          if (corridor.kind === 'leaf') {
            claims.set(runEndKey(corridor.run!, corridor.end!), { handover: from, chain, plan, group: index });
            return;
          }
          walk(corridor.left!, corridor.split!, [...chain, corridor]);
          walk(corridor.right!, corridor.split!, [...chain, corridor]);
        };
        walk(incident.corridor, plan.cuts[index], []);
      });
    }
    let adjusted = false;
    for (const [index, frame] of frames.entries()) {
      const head = claims.get(runEndKey(index, 'from')), tail = claims.get(runEndKey(index, 'to'));
      if (!head || !tail) continue;
      let excess = head.handover + tail.handover - (frame.length - cell * 0.5);
      if (excess <= 1e-6) continue;
      // The deeper wye-backed side gives way first, innermost rip outward; each rip keeps a row's room
      // past the rip of the merge enclosing it.
      const sides = [head, tail].filter(side => side.chain.length).sort((a, b) => b.handover - a.handover);
      for (const side of sides) {
        for (let at = side.chain.length - 1; at >= 0 && excess > 1e-6; at--) {
          const merge = side.chain[at];
          const floor = at > 0 ? side.chain[at - 1].split! + cell * 0.25 : cell * 0.75;
          const give = Math.min(excess, merge.split! - floor);
          if (give <= 1e-6) continue;
          merge.split = merge.split! - give;
          merge.limit = merge.split;
          excess -= give;
          adjusted = true;
        }
      }
    }
    if (!adjusted) break;
  }

  /**
   * Runs whose two junction cuts still overlap after every reconciliation have no ground of their own —
   * the junctions stand back to back. Both patches build against ONE shared row there; minting a row per
   * end would stack two rows of vertices on the same line, which is the coincident-vertex pile the editor
   * diagnoses, with a band of zero-thickness cells between.
   */
  const sharedRows = new Set<number>();
  {
    const ends = new Map<string, { handover: number; leaf: boolean }>();
    for (const plan of plans) {
      plan.groups.forEach((incident, index) => {
        const walk = (corridor: Corridor, from: number, depth: number): void => {
          if (corridor.kind === 'leaf') {
            ends.set(runEndKey(corridor.run!, corridor.end!), { handover: from, leaf: depth === 0 });
            return;
          }
          walk(corridor.left!, corridor.split!, depth + 1);
          walk(corridor.right!, corridor.split!, depth + 1);
        };
        walk(incident.corridor, plan.cuts[index], 0);
      });
    }
    for (const [index, frame] of frames.entries()) {
      const head = ends.get(runEndKey(index, 'from')), tail = ends.get(runEndKey(index, 'to'));
      if (!head?.leaf || !tail?.leaf) continue;
      // Under a cell of ground between the two cuts cannot carry a row of its own — cells swept into
      // that slot come out thinner than the diagnostics' tolerance once the fit settles.
      if (head.handover + tail.handover > frame.length - cell) sharedRows.add(index);
    }
  }

  // Wye trees build FIRST, plain leaves second: a rip hands each child its slice of the merged row, and
  // a leaf at the run's other end can only reuse that slice if it already exists — build order was
  // deciding whether a scissored pair shared its row or doubled it.
  const patches: PatchPlan[] = [];
  const underway = new Map<NodePlan, PatchPlan>();
  const buildGroup = (plan: NodePlan, index: number): void => {
    const planned = underway.get(plan) ?? (() => {
      const fresh: PatchPlan = { node: plan.node, groups: [] };
      underway.set(plan, fresh);
      patches.push(fresh);
      return fresh;
    })();
    const row = buildCorridor(plan.groups[index].corridor, plan.cuts[index], null);
    if (row) planned.groups.push({ incident: plan.groups[index], cut: plan.cuts[index], row });
  };
  for (const plan of plans) {
    plan.groups.forEach((incident, index) => { if (incident.corridor.kind === 'merged') buildGroup(plan, index); });
  }
  for (const plan of plans) {
    plan.groups.forEach((incident, index) => { if (incident.corridor.kind === 'leaf') buildGroup(plan, index); });
  }

  // ---- the run sweeps -------------------------------------------------------------------------------------
  runs.forEach((run, index) => {
    const frame = frames[index];
    const head = runStart.get(runEndKey(index, 'from')), tail = runStart.get(runEndKey(index, 'to'));
    if (!head || !tail) throw new Error(`run ${index} never received both of its end rows`);
    // Both junctions built against ONE row: the run's ground is all junction interior, nothing to sweep.
    if (head.row.length === tail.row.length && head.row.every((v, i) => v === tail.row[tail.row.length - 1 - i])) {
      notes.push(`run ${index} is junction interior on both sides — its two patches share one row`);
      return;
    }
    let sA = head.s, sB = frame.length - tail.s;
    if (sB - sA < cell * 0.5) {
      notes.push(`run ${index} is shorter than its junctions — one row squeezed between them`);
      const middle = (sA + sB) / 2;
      sA = Math.min(sA, middle - cell * 0.25); sB = Math.max(sB, middle + cell * 0.25);
    }
    const rows = Math.max(1, Math.round((sB - sA) / cell));
    part(`run ${index}:${run.from}->${run.to}`);
    // Column counts row by row: the end rows keep what their junctions realized; interior rows follow the
    // LOCAL width, with half a cell of deadband so a width hovering at a rounding boundary cannot flicker
    // columns in and out, then a backward pass walks the schedule onto the tail count no faster than one
    // kite pair per interval. The knit itself absorbs any leftover difference, so the caps only place the
    // poles — they never decide whether the ladder closes.
    const corridor = leafCorridor(run, frame, 'from', index, runColumns[index]);
    const counts: number[] = [head.row.length - 1];
    for (let r = 1; r < rows; r++) {
      const ratio = frame.halfAt(sA + ((sB - sA) * r) / rows) / cell;
      let c = counts[r - 1];
      while (ratio >= c / 2 + 0.75) c += 2;
      while (c > 2 && ratio <= c / 2 - 0.75) c -= 2;
      counts.push(c);
    }
    counts.push(tail.row.length - 1);
    for (let r = rows - 1; r >= 1; r--) {
      counts[r] = Math.max(2, Math.max(counts[r + 1] - 2, Math.min(counts[r + 1] + 2, counts[r])));
    }
    // The head row was realized leaving `from` (−n̂ of the outward tangent); sweeping from `from` to `to`
    // keeps that orientation. The tail row was realized leaving `to`, so its order is reversed from here.
    let previous = head.row;
    for (let r = 1; r <= rows; r++) {
      const s = sA + ((sB - sA) * r) / rows;
      const t = frame.tangentAt(s - (sB - sA) / rows / 2);
      if (r < rows) {
        // A corridor brushing its own swath pinches consecutive rows together on the inside of the fold;
        // a row landing on the one before it would sweep a strip of sliver cells, so the next row spans on.
        const points = rowFor(corridor, s, counts[r]);
        if (points.length === previous.length
          && points.some((p, k) => Math.hypot(p.x - xs[previous[k]], p.z - zs[previous[k]]) < 0.5)) continue;
        const row = realizeRow(points);
        ladderKnit(previous, row, Math.atan2(t.z, t.x), 'ladder');
        previous = row;
        continue;
      }
      const row = [...tail.row].reverse();
      ladderKnit(previous, row, Math.atan2(t.z, t.x), 'ladder');
      previous = row;
    }
  });

  // ---- junction patches -----------------------------------------------------------------------------------

  /**
   * Walk the region's edge counterclockwise around `node` from one rim point to another. The leash is what
   * keeps a junction arc a junction arc: with no rim between the two rows the zero set still connects them —
   * the LONG way, around whatever basin of forest happens to be next door — and a patch built on that walk
   * paves the basin. Better to fail here and bridge the side straight.
   */
  const traceArc = (from: SheetPoint, to: SheetPoint, node: SheetPoint): SheetPoint[] | null => {
    const leash = 3 * cell + 1.6 * Math.max(Math.hypot(from.x - node.x, from.z - node.z),
      Math.hypot(to.x - node.x, to.z - node.z));
    const step = Math.max(1, cell / 2);
    const project = (p: SheetPoint): SheetPoint => {
      let { x, z } = p;
      for (let i = 0; i < 4; i++) {
        const h = step / 2;
        const d = distanceAt(x, z);
        const gx = (distanceAt(x + h, z) - distanceAt(x - h, z)) / (2 * h);
        const gz = (distanceAt(x, z + h) - distanceAt(x, z - h)) / (2 * h);
        const g2 = gx * gx + gz * gz;
        if (!(g2 > 1e-9)) break;
        x -= (d * gx) / g2; z -= (d * gz) / g2;
      }
      return { x, z };
    };
    const points: SheetPoint[] = [];
    let at = project(from);
    let lastDir: SheetPoint | null = null;
    for (let i = 0; i < 400; i++) {
      if (Math.hypot(at.x - node.x, at.z - node.z) > leash) return null;
      if (Math.hypot(at.x - to.x, at.z - to.z) <= step * 1.25 && i > 0) return points;
      const h = step / 2;
      const gx = (distanceAt(at.x + h, at.z) - distanceAt(at.x - h, at.z)) / (2 * h);
      const gz = (distanceAt(at.x, at.z + h) - distanceAt(at.x, at.z - h)) / (2 * h);
      const g = Math.hypot(gx, gz);
      if (!(g > 1e-6)) return null;
      let dir = { x: -gz / g, z: gx / g };
      const ccw = cross2(at.x - node.x, at.z - node.z, dir.x, dir.z) >= 0;
      if (!ccw) dir = { x: -dir.x, z: -dir.z };
      if (lastDir && dir.x * lastDir.x + dir.z * lastDir.z < 0) dir = { x: -dir.x, z: -dir.z };
      lastDir = dir;
      at = project({ x: at.x + dir.x * step, z: at.z + dir.z * step });
      points.push(at);
    }
    return null;
  };

  /**
   * Mesh one quadrilateral block as a grid. The sides are vertex-id polylines in cyclic boundary order —
   * S0, S1, S2, S3 walks the block's rim — with cells laid in strips from S0 toward S2, one strip per S1
   * edge, interiors seeded by Coons interpolation of the four sides. S1 and S3 must carry the same count;
   * S0 and S2 may differ by an even number, and each two of that difference are absorbed by a KITE — a cell
   * with two edges on the wider row — whose off-count vertices are one valence-3 and one valence-5 point,
   * the pair a quad mesh pays wherever a seam changes width. Kites take the middle strips and stay a column
   * off the sides, which keeps the poles interior and lets the relax even their angles out.
   */
  const fillBlock = (S0: number[], S1: number[], S2: number[], S3: number[],
    flow: number | null, kind: keyof typeof made): void => {
    const strips = S1.length - 1;
    if (S3.length - 1 !== strips) throw new Error(`block sides disagree: ${S1.length - 1} vs ${S3.length - 1}`);
    const w0 = S0.length - 1, wEnd = S2.length - 1;
    if ((w0 - wEnd) % 2) throw new Error(`block widths differ oddly: ${w0} vs ${wEnd}`);
    const at = (id: number): SheetPoint => ({ x: xs[id], z: zs[id] });
    const sample = (ids: number[], t: number): SheetPoint => {
      const f = Math.max(0, Math.min(1, t)) * (ids.length - 1);
      const i = Math.min(ids.length - 2, Math.floor(f)), u = f - i;
      const a = at(ids[i]), b = at(ids[i + 1]);
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
    };
    const bottom = S0, top = [...S2].reverse(), left = [...S3].reverse(), right = S1;
    const steps = (wEnd - w0) / 2;
    const kitesPer = new Array<number>(strips).fill(0);
    if (steps !== 0) {
      const order = Array.from({ length: strips }, (_, j) => j).sort((a, b) =>
        Math.abs(a - (strips - 1) / 2) - Math.abs(b - (strips - 1) / 2));
      for (let n = 0; n < Math.abs(steps); n++) kitesPer[order[n % strips]]++;
    }
    const widths = [w0];
    for (let j = 0; j < strips; j++) widths.push(widths[j] + Math.sign(steps) * 2 * kitesPer[j]);
    const rows: number[][] = [bottom];
    const p00 = at(bottom[0]), p10 = at(bottom[w0]), p01 = at(top[0]), p11 = at(top[wEnd]);
    for (let j = 1; j < strips; j++) {
      const w = widths[j], v = j / strips;
      const row: number[] = [left[j]];
      for (let i = 1; i < w; i++) {
        const u = i / w;
        const b = sample(bottom, u), t = sample(top, u), l = sample(left, v), r = sample(right, v);
        row.push(vertex({
          x: (1 - v) * b.x + v * t.x + (1 - u) * l.x + u * r.x
            - ((1 - u) * (1 - v) * p00.x + u * (1 - v) * p10.x + (1 - u) * v * p01.x + u * v * p11.x),
          z: (1 - v) * b.z + v * t.z + (1 - u) * l.z + u * r.z
            - ((1 - u) * (1 - v) * p00.z + u * (1 - v) * p10.z + (1 - u) * v * p01.z + u * v * p11.z),
        }));
      }
      row.push(right[j]);
      rows.push(row);
    }
    rows.push(top);
    for (let j = 0; j < strips; j++) {
      const lo = rows[j], up = rows[j + 1];
      const wLo = lo.length - 1, wUp = up.length - 1;
      if (wLo === wUp) {
        for (let i = 0; i < wLo; i++) addCell(lo[i], lo[i + 1], up[i + 1], up[i], flow, kind);
        continue;
      }
      const wide = Math.max(wLo, wUp), kites = (wide - Math.min(wLo, wUp)) / 2;
      const margin = wide >= 2 * kites + 2 ? 1 : 0;
      // A kite folds its cell around the wide row's vertex at c+1, so it belongs on the row's FLATTEST
      // stretch — a kite laid over a bend becomes a dart. Take the straightest columns that keep their
      // spacing; fall back to an even spread when the greedy pick cannot seat them all.
      const wRow = wLo > wUp ? lo : up;
      const turnAt = (c: number): number => {
        const a = { x: xs[wRow[c]], z: zs[wRow[c]] }, b = { x: xs[wRow[c + 1]], z: zs[wRow[c + 1]] };
        const d = { x: xs[wRow[c + 2]], z: zs[wRow[c + 2]] };
        return Math.abs(angleGap(Math.atan2(d.z - b.z, d.x - b.x), Math.atan2(b.z - a.z, b.x - a.x)));
      };
      const ranked = Array.from({ length: wide - 1 - 2 * margin }, (_, i) => margin + i)
        .sort((a, b) => turnAt(a) - turnAt(b));
      const kiteAt = new Set<number>();
      for (const c of ranked) {
        if (kiteAt.size === kites) break;
        if (![...kiteAt].some(other => Math.abs(other - c) < 2)) kiteAt.add(c);
      }
      if (kiteAt.size < kites) {
        kiteAt.clear();
        const cols: number[] = [];
        for (let r = 0; r < kites; r++) cols.push(Math.round(((r + 1) * wide) / (kites + 1)) - 1);
        for (let r = 0; r < kites; r++) cols[r] = Math.max(cols[r], r ? cols[r - 1] + 2 : margin);
        for (let r = kites - 1; r >= 0; r--) cols[r] = Math.min(cols[r], r < kites - 1 ? cols[r + 1] - 2 : wide - 2 - margin);
        for (const c of cols) kiteAt.add(c);
      }
      let n = 0;
      if (wLo > wUp) {
        for (let i = 0; i < wLo;) {
          if (kiteAt.has(i)) { addCell(lo[i], lo[i + 1], lo[i + 2], up[n], flow, kind); i += 2; }
          else { addCell(lo[i], lo[i + 1], up[n + 1], up[n], flow, kind); i += 1; n += 1; }
        }
      } else {
        for (let i = 0; i < wUp;) {
          if (kiteAt.has(i)) { addCell(lo[n], up[i + 2], up[i + 1], up[i], flow, kind); i += 2; }
          else { addCell(lo[n], lo[n + 1], up[i + 1], up[i], flow, kind); i += 1; n += 1; }
        }
      }
    }
  };

  /**
   * Fill a block whose S0 side may be BENT — a wye's cut row is a chevron, because it wraps two roads
   * around their corner — by splitting at the sharpest bend and running a divider down its bisector to the
   * matching point of S2, then recursing on each flank. The bend vertex ends up with two ladder cells above
   * and one block corner either side: an ordinary valence-4 vertex, where one flat-topped block would have
   * pinched a pole into the apex and fanned needles from it. S1 and S3 must carry equal counts; every
   * divider carries that same count, so each piece keeps the pair equal by construction.
   */
  const fillBent = (S0: number[], S1: number[], S2: number[], S3: number[],
    flow: number | null, kind: keyof typeof made): void => {
    const w = S0.length - 1, sig = S2.length - 1;
    let bend = -1, sharpest = 0.6; // ~35°: gentler than that, one Coons block absorbs it
    for (let i = 1; i < w; i++) {
      const a = { x: xs[S0[i - 1]], z: zs[S0[i - 1]] }, b = { x: xs[S0[i]], z: zs[S0[i]] };
      const c = { x: xs[S0[i + 1]], z: zs[S0[i + 1]] };
      const turn = Math.abs(angleGap(Math.atan2(c.z - b.z, c.x - b.x), Math.atan2(b.z - a.z, b.x - a.x)));
      if (turn > sharpest) { sharpest = turn; bend = i; }
    }
    if (bend < 0 || sig < 2 || w < 2) { fillBlock(S0, S1, S2, S3, flow, kind); return; }
    // S2[0] sits past S0's end, so S0's fraction b/w lands at S2's fraction 1 − b/w; nudged for parity.
    let split = sig - Math.round((sig * bend) / w);
    if ((bend - (sig - split)) % 2) split += split > sig / 2 ? -1 : 1;
    split = Math.max(1, Math.min(sig - 1, split));
    if ((bend - (sig - split)) % 2) { fillBlock(S0, S1, S2, S3, flow, kind); return; }
    const depth = S1.length - 1;
    const from = S0[bend], to = S2[split];
    const divider = [from];
    for (let s = 1; s < depth; s++) {
      const t = s / depth;
      divider.push(vertex({ x: xs[from] + (xs[to] - xs[from]) * t, z: zs[from] + (zs[to] - zs[from]) * t }));
    }
    divider.push(to);
    fillBent(S0.slice(0, bend + 1), divider, S2.slice(split), S3, flow, kind);
    fillBent(S0.slice(bend), S1, S2.slice(0, split + 1), [...divider].reverse(), flow, kind);
  };

  for (const patch of patches) {
    const node = patch.node;
    // Boundary counterclockwise: cross each group's row entering on its clockwise side, then arc to the next.
    const groups = [...patch.groups].sort((a, b) => a.incident.bearing - b.incident.bearing);
    const k = groups.length;
    const orderedRows = groups.map(group => {
      const row = group.row;
      const endA = { x: xs[row[0]], z: zs[row[0]] }, endB = { x: xs[row[row.length - 1]], z: zs[row[row.length - 1]] };
      // Entering clockwise of the group's bearing means the end that sits at bearing − 90°.
      const side = (p: SheetPoint) => angleGap(Math.atan2(p.z - node.at.z, p.x - node.at.x), group.incident.bearing);
      return side(endA) < side(endB) ? row : [...row].reverse();
    });
    const m = orderedRows.map(row => row.length - 1);

    // The rim between consecutive rows. A lone row's is the region rim traced round its own tip; between
    // two rows it is the corridors' OWN rims, walked inward from each row corner until the two walls cross —
    // and the crossing IS the mouth corner. Walking the corridors' rims rather than the union's keeps the
    // wall out of foreign swaths: the union's rim bulges around whatever third road overlaps the junction,
    // and a mouth built against that bulge paves the third road's own ladder. A pair whose walls never
    // cross inward is sealed at every cut this junction may take; its notch is folded into the rows below.
    let blunt = false;
    const arcs: SheetPoint[][] = [];
    const pairParts: ([SheetPoint[], SheetPoint[]] | null)[] = [];
    const rimWalk = (index: number, from: SheetPoint, s0: number): SheetPoint[] => {
      const corridor = groups[index].incident.corridor;
      const steps = Math.max(2, Math.ceil(Math.max(s0, cell) / (cell / 3)));
      const walk = [from];
      for (let n = 1; n <= steps; n++) {
        const row = rowFor(corridor, (s0 * (steps - n)) / steps);
        const head = row[0], tail = row[row.length - 1];
        const previous = walk[walk.length - 1];
        walk.push(Math.hypot(head.x - previous.x, head.z - previous.z)
          <= Math.hypot(tail.x - previous.x, tail.z - previous.z) ? head : tail);
      }
      return walk;
    };
    for (let i = 0; i < k && !blunt; i++) {
      const next = (i + 1) % k;
      const from = orderedRows[i][m[i]], to = orderedRows[next][0];
      const exit = { x: xs[from], z: zs[from] }, target = { x: xs[to], z: zs[to] };
      if (k === 1) {
        const traced = traceArc(exit, target, node.at);
        if (!traced) {
          // A chord straight across its own row is no cap at all; the corridor keeps its plain end.
          notes.push(`trail end at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: no walkable rim round the tip — cap left blunt`);
          blunt = true;
          break;
        }
        arcs.push([exit, ...traced, target]);
        pairParts.push(null);
        continue;
      }
      if (Math.hypot(exit.x - target.x, exit.z - target.z) < cell * 1.2) {
        // The corners already touch: the wall between the rows is one short corner edge.
        const middle = { x: (exit.x + target.x) / 2, z: (exit.z + target.z) / 2 };
        arcs.push([exit, middle, target]);
        pairParts.push([[exit, middle], [middle, target]]);
        continue;
      }
      const wallA = rimWalk(i, exit, groups[i].cut);
      const wallB = rimWalk(next, target, groups[next].cut);
      let met: { onA: number; onB: number; at: SheetPoint } | null = null;
      search: for (let a2 = 0; a2 + 1 < wallA.length; a2++) {
        for (let b2 = 0; b2 + 1 < wallB.length; b2++) {
          const at = segCross(wallA[a2], wallA[a2 + 1], wallB[b2], wallB[b2 + 1]);
          if (at) { met = { onA: a2, onB: b2, at }; break search; }
        }
      }
      if (!met) {
        // Walls that graze without crossing — pushed rows often start exactly on the crossing — still meet.
        let graze = { apart: Infinity, onA: 0, onB: 0 };
        for (let a2 = 1; a2 < wallA.length; a2++) {
          for (let b2 = 1; b2 < wallB.length; b2++) {
            const apart = Math.hypot(wallA[a2].x - wallB[b2].x, wallA[a2].z - wallB[b2].z);
            if (apart < graze.apart) graze = { apart, onA: a2, onB: b2 };
          }
        }
        if (graze.apart < cell * 0.8) {
          met = {
            onA: graze.onA - 1, onB: graze.onB - 1,
            at: {
              x: (wallA[graze.onA].x + wallB[graze.onB].x) / 2,
              z: (wallA[graze.onA].z + wallB[graze.onB].z) / 2,
            },
          };
        }
      }
      if (!met) {
        // The corridors' own rims never cross: the ground between the rows may still reach the region rim
        // the LONG way, round a bay neither corridor walls off. The region's edge knows that path — walk
        // it, and put the side's elbow at the bay's deepest reach. Only when even the region's edge finds
        // no walkable way does the side fall back to a chord and fold into its rows.
        const traced = traceArc(exit, target, node.at);
        if (traced && traced.length) {
          const arc = [exit, ...traced, target];
          let deep = 1, best = -1;
          for (const [at, point] of arc.entries()) {
            const away = Math.hypot(point.x - node.at.x, point.z - node.at.z);
            if (away > best) { best = away; deep = at; }
          }
          const elbow = Math.max(1, Math.min(arc.length - 2, deep));
          arcs.push(arc);
          pairParts.push([arc.slice(0, elbow + 1), arc.slice(elbow)]);
          continue;
        }
        arcs.push([exit, { x: (exit.x + target.x) / 2, z: (exit.z + target.z) / 2 }, target]);
        pairParts.push(null);
        continue;
      }
      const partA = [...wallA.slice(0, met.onA + 1), met.at];
      const partB = [met.at, ...wallB.slice(0, met.onB + 1).reverse()];
      arcs.push([...partA, ...partB.slice(1)]);
      pairParts.push([partA, partB]);
    }
    if (blunt) continue;

    let doubled = 0;
    {
      const ring: SheetPoint[] = [];
      for (let i = 0; i < k; i++) {
        for (const v of orderedRows[i]) ring.push({ x: xs[v], z: zs[v] });
        ring.push(...arcs[i].slice(1, -1));
      }
      for (let i = 0; i < ring.length; i++) {
        const j = (i + 1) % ring.length;
        doubled += ring[i].x * ring[j].z - ring[j].x * ring[i].z;
      }
    }
    if (doubled < 0) {
      notes.push(`junction at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: boundary wound clockwise — patch skipped`);
      continue;
    }

    /**
     * Fold sealed notches into their rows. A pair whose rim walls never cross has no boundary between its
     * rows — the roads stay overlapped past every cut this junction may take — so the notch is not a side a
     * mouth can stand against: the two rows become ONE bent side across a short chord, and the bend
     * splitter meshes that side as the single edge of ground it is.
     */
    const hugged = pairParts.map(part => k >= 2 && part === null);
    if (k >= 2 && hugged.every(Boolean)) {
      // Every notch sealed — keep the longest chord as the boundary any patch still needs.
      let keep = 0, best = -1;
      for (let i = 0; i < k; i++) {
        const span = lengthOf(arcs[i]);
        if (span > best) { best = span; keep = i; }
      }
      hugged[keep] = false;
    }
    if (hugged.some(Boolean)) {
      notes.push(`junction at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: `
        + `${hugged.filter(Boolean).length} sealed notch(es) folded into their rows`);
    }
    // Sides: chains of rows joined across folded notches. Counts first — a folded notch's edge count is the
    // one free number that can fix a two-sided block's parity — then the vertices.
    const sideStart: number[] = [];
    for (let i = 0; i < k; i++) if (!hugged[(i + k - 1) % k]) sideStart.push(i);
    const chains = sideStart.map(start => {
      const chain = [start];
      for (let g2 = start; hugged[g2]; g2 = (g2 + 1) % k) chain.push((g2 + 1) % k);
      return chain;
    });
    const chainArcCount = chains.map(chain => chain.slice(0, -1).map(g2 =>
      Math.max(1, Math.round(lengthOf(arcs[g2]) / cell))));
    const K = chains.length;
    const countOf = (c: number) => chains[c].reduce((s, g2) => s + m[g2], 0)
      + chainArcCount[c].reduce((s, v) => s + v, 0);
    if (K === 2 && (countOf(0) - countOf(1)) % 2) {
      const c = chainArcCount[0].length ? 0 : 1;
      if (chainArcCount[c].length) chainArcCount[c][0]++;
      else notes.push(`junction at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: sides disagree by an odd count`);
    }
    const sides = chains.map((chain, c) => {
      const ids = [...orderedRows[chain[0]]];
      for (let j = 1; j < chain.length; j++) {
        const pts = resample(arcs[chain[j - 1]], chainArcCount[c][j - 1]);
        ids.push(...pts.slice(1, -1).map(vertex), ...orderedRows[chain[j]]);
      }
      return { ids, flow: chain.length === 1 ? groups[chain[0]].incident.bearing : null };
    });
    const sideArcs = chains.map(chain => arcs[chain[chain.length - 1]]);
    const M = sides.map(side => side.ids.length - 1);

    const where = `${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}`;
    if (K === 1) {
      // CAP: one block from the last row round the survey's own tip — shoulders at one depth either side,
      // the crown between them at the row's own count, so the block is a grid with no poles at all.
      part(`cap@${where}`);
      const depth = Math.max(1, Math.round((lengthOf(sideArcs[0]) - M[0] * cell) / (2 * cell)));
      const pts = resample(sideArcs[0], M[0] + 2 * depth);
      const ids = [sides[0].ids[M[0]], ...pts.slice(1, -1).map(vertex), sides[0].ids[0]];
      fillBent(sides[0].ids, ids.slice(0, depth + 1), ids.slice(depth, depth + M[0] + 1),
        ids.slice(depth + M[0]), sides[0].flow, k === 1 ? 'cap' : 'junction');
      continue;
    }

    if (K === 2) {
      // A pass-through or a bend: the two sides are simply opposite walls of one block, rims at one depth.
      // The SHORTER rim sets it — depth beyond what the short side measures packs its cells thinner than
      // the diagnostics' tolerance, where the long side merely stretches.
      part(`through@${where}`);
      const depth = Math.max(1, Math.round(Math.min(lengthOf(sideArcs[0]), lengthOf(sideArcs[1])) / cell));
      const rimA = [sides[0].ids[M[0]], ...resample(sideArcs[0], depth).slice(1, -1).map(vertex), sides[1].ids[0]];
      const rimB = [sides[1].ids[M[1]], ...resample(sideArcs[1], depth).slice(1, -1).map(vertex), sides[0].ids[0]];
      const b0 = sides[0].flow, b1 = sides[1].flow;
      const through = b0 !== null && b1 !== null
        && Math.abs(angleGap(b0, b1 + Math.PI)) < (25 * Math.PI) / 180 ? b0 : null;
      fillBent(sides[0].ids, rimA, sides[1].ids, rimB, through, 'junction');
      continue;
    }

    // K ≥ 3: a mouth block per side, and between the stop-lines a central court of K corner blocks around
    // one centre vertex whose valence IS the junction's degree — the one structural pole the shape needs.
    if (K >= 6) notes.push(`junction at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: ${K}-way — centre pole of valence ${K}`);
    const parts = chains.map(chain => pairParts[chain[chain.length - 1]]!);
    const elbowId = parts.map(([first]) => vertex(first[first.length - 1]));
    const centre = {
      x: elbowId.reduce((s, id) => s + xs[id], 0) / K,
      z: elbowId.reduce((s, id) => s + zs[id], 0) / K,
    };

    // Stop-line counts and splits. Side i's stop-line carries σ_i edges — same parity as its row, sized by
    // what the stop-line MEASURES, not by what the road is: a wide road entering a narrow throat must knit
    // down before it, and every two edges of that difference is a kite pair in its mouth. The court side i
    // splits at g_i edges from its own elbow, and chord j inherits g_{j−1}, which ties the counts together.
    // The search takes the assignment needing the fewest kites, then edges nearest the cell size and the
    // evenest splits. QuadWild answers this same question with an ILP across its whole patch layout; one
    // junction's version is small enough to answer by enumeration.
    const chordTarget = sides.map((_, j) => {
      const a = elbowId[(j + K - 1) % K], b = elbowId[j];
      return Math.max(1, Math.round(Math.hypot((xs[a] + xs[b]) / 2 - centre.x, (zs[a] + zs[b]) / 2 - centre.z) / cell));
    });
    const stopTarget = sides.map((_, i) => {
      const a = elbowId[i], b = elbowId[(i + K - 1) % K];
      return Math.hypot(xs[a] - xs[b], zs[a] - zs[b]) / cell;
    });
    // How many strips each mouth's own rims physically afford — a kite needs a strip, so σ may not ask
    // for more taper than the rim walls have room to carry; packing them in anyway lays strips thinner
    // than the editor's own tolerance.
    const rimDepth = sides.map((_, i) => Math.max(1,
      Math.round((lengthOf(parts[(i + K - 1) % K][1]) + lengthOf(parts[i][0])) / 2 / cell)));
    const sigmaOptions = M.map((mi, i) => {
      const wanted = 2 * Math.max(1, Math.round(stopTarget[i] / 2));
      const near = mi % 2 ? wanted + 1 : wanted;  // keep σ ≡ m (mod 2) so the mouth taper stays even
      const options = [...new Set([mi, near, near - 2, near + 2])]
        .filter(s => s >= 2 && s <= mi + 2 && Math.abs(s - mi) / 2 <= rimDepth[i]);
      return options.length ? options : [mi];
    });
    const found = { cost: Infinity, sigma: [] as number[], g: [] as number[] };
    const sigma = new Array<number>(K).fill(0);
    const growSigma = (i: number, pole: number): void => {
      if (pole >= found.cost) return;
      if (i < K) {
        for (const s of sigmaOptions[i]) {
          sigma[i] = s;
          growSigma(i + 1, pole + 3 * (Math.abs(s - M[i]) / 2) + 2 * Math.abs(s - stopTarget[i]));
        }
        return;
      }
      const options = sigma.map(s => [...new Set([Math.floor(s / 2), Math.ceil(s / 2), Math.floor(s / 2) - 1, Math.ceil(s / 2) + 1])]
        .filter(g2 => g2 >= 1 && g2 <= s - 1));
      const g = new Array<number>(K).fill(0);
      const walk = (j: number): void => {
        if (j === K) {
          let cost = pole;
          for (let i2 = 0; i2 < K; i2++) {
            const taper = Math.abs(g[(i2 + K - 1) % K] - (sigma[(i2 + 1) % K] - g[(i2 + 1) % K]));
            if (taper % 2) return;
            cost += 3 * (taper / 2) + 0.2 * Math.abs(sigma[i2] - 2 * g[i2])
              + 0.5 * Math.abs(g[(i2 + K - 1) % K] - chordTarget[i2]);
          }
          if (cost < found.cost) { found.cost = cost; found.sigma = [...sigma]; found.g = [...g]; }
          return;
        }
        for (const choice of options[j]) { g[j] = choice; walk(j + 1); }
      };
      walk(0);
    };
    growSigma(0, 0);
    if (!found.sigma.length) throw new Error(`junction at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)} found no stop-line counts`);
    const { g } = found;
    for (let i = 0; i < K; i++) sigma[i] = found.sigma[i];

    // A mouth is as deep as its own rim asks — and never shallower than its taper, so each kite gets a strip.
    const depth = sides.map((_, i) => Math.max(1,
      Math.round((lengthOf(parts[(i + K - 1) % K][1]) + lengthOf(parts[i][0])) / 2 / cell),
      Math.abs(M[i] - sigma[i]) / 2));
    const arcIds = sideArcs.map((_, i) => {
      const p1 = resample(parts[i][0], depth[i]);
      const p2 = resample(parts[i][1], depth[(i + 1) % K]);
      return [sides[i].ids[M[i]],
        ...p1.slice(1, -1).map(vertex), elbowId[i], ...p2.slice(1, -1).map(vertex),
        sides[(i + 1) % K].ids[0]];
    });
    const kitePairs = sigma.reduce((s, v, i) => s + Math.abs(v - M[i]) / 2, 0)
      + sides.reduce((s, _, j) => s + Math.abs(g[(j + K - 1) % K] - (sigma[(j + 1) % K] - g[(j + 1) % K])) / 2, 0);
    if (kitePairs > 0) {
      notes.push(`junction at ${node.at.x.toFixed(0)},${node.at.z.toFixed(0)}: ${kitePairs} kite pair(s) absorb mismatched widths`);
    }

    const stopIds = sides.map((_, i) => {
      const a = elbowId[i], b = elbowId[(i + K - 1) % K];
      const ids = [a];
      for (let s = 1; s < sigma[i]; s++) {
        const t = s / sigma[i];
        ids.push(vertex({ x: xs[a] + (xs[b] - xs[a]) * t, z: zs[a] + (zs[b] - zs[a]) * t }));
      }
      ids.push(b);
      return ids;
    });
    if (options.debug && Math.hypot(node.at.x - options.debug.x, node.at.z - options.debug.z) <= options.debug.radius) {
      for (let i = 0; i < K; i++) {
        const rowA = sides[i].ids[0], rowB = sides[i].ids[M[i]];
        notes.push(`DEBUG junction @${where} side ${i}: chain [${chains[i].join(',')}] M=${M[i]} σ=${sigma[i]}`
          + ` g=${g[i]} depth=${depth[i]} rimDepth=${rimDepth[i]} stopTarget=${stopTarget[i].toFixed(1)}`
          + ` wallL=${lengthOf(parts[i][0]).toFixed(1)} wallR=${lengthOf(parts[(i + K - 1) % K][1]).toFixed(1)}`
          + ` row ${rowA}(${xs[rowA].toFixed(0)},${zs[rowA].toFixed(0)})..${rowB}(${xs[rowB].toFixed(0)},${zs[rowB].toFixed(0)})`
          + ` elbow ${elbowId[i]}(${xs[elbowId[i]].toFixed(0)},${zs[elbowId[i]].toFixed(0)})`);
      }
    }
    for (let i = 0; i < K; i++) {
      const before = (i + K - 1) % K;
      part(`mouth ${i}@${where}`);
      fillBent(sides[i].ids, arcIds[i].slice(0, depth[i] + 1), stopIds[i],
        arcIds[before].slice(depth[before]), sides[i].flow, 'junction');
    }
    const centreId = vertex(centre);
    const central = stopIds.map(ids => [...ids].reverse());
    const chordIds = sides.map((_, j) => {
      const before = (j + K - 1) % K;
      const mid = central[j][sigma[j] - g[j]];
      const ids = [centreId];
      for (let s = 1; s < g[before]; s++) {
        const t = s / g[before];
        ids.push(vertex({ x: centre.x + (xs[mid] - centre.x) * t, z: centre.z + (zs[mid] - centre.z) * t }));
      }
      ids.push(mid);
      return ids;
    });
    for (let j = 0; j < K; j++) {
      const next = (j + 1) % K;
      part(`court ${j}@${where}`);
      fillBlock(chordIds[j], central[j].slice(sigma[j] - g[j]),
        central[next].slice(0, sigma[next] - g[next] + 1), [...chordIds[next]].reverse(), null, 'junction');
    }
  }

  if (!cells.length) return { ok: false, error: 'The network produced no cells.' };

  // ---- one winding ----------------------------------------------------------------------------------------
  const px = new Float64Array(xs), pz = new Float64Array(zs);
  const ringArea = (ring: readonly number[]): number => {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      area += px[a] * pz[b] - px[b] * pz[a];
    }
    return area / 2;
  };
  let positive = 0;
  for (const ring of cells) if (ringArea(ring) > 0) positive++;
  const winding = positive * 2 >= cells.length ? 1 : -1;
  for (const ring of cells) {
    if (Math.sign(ringArea(ring)) !== winding && ringArea(ring) !== 0) ring.reverse();
  }

  // ---- the rim, and whether this is one surface -----------------------------------------------------------
  const edgeUse = new Map<string, { a: number; b: number; count: number }>();
  for (const ring of cells) {
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const seen = edgeUse.get(key);
      if (seen) seen.count++; else edgeUse.set(key, { a, b, count: 1 });
    }
  }
  for (const { a, b, count } of edgeUse.values()) {
    if (count > 2) {
      return { ok: false, error: `edge ${a}–${b} near ${px[a].toFixed(0)},${pz[a].toFixed(0)} belongs to ${count} cells` };
    }
  }
  const boundary = new Set<number>();
  const rimNext = new Map<number, number[]>();
  for (const { a, b, count } of edgeUse.values()) {
    if (count !== 1) continue;
    boundary.add(a); boundary.add(b);
    (rimNext.get(a) ?? (rimNext.set(a, []), rimNext.get(a)!)).push(b);
    (rimNext.get(b) ?? (rimNext.set(b, []), rimNext.get(b)!)).push(a);
  }
  const forked = [...rimNext.entries()].filter(([, list]) => list.length !== 2);
  if (forked.length) {
    const [at] = forked[0];
    return {
      ok: false,
      error: `${forked.length} rim vertices sit on more than one loop — first near ${px[at].toFixed(0)},${pz[at].toFixed(0)}`,
    };
  }
  const loops: number[][] = [];
  const walked = new Set<number>();
  for (const start of rimNext.keys()) {
    if (walked.has(start)) continue;
    const loop = [start];
    walked.add(start);
    let previous = start, current = rimNext.get(start)![0];
    while (current !== start) {
      loop.push(current); walked.add(current);
      const pair = rimNext.get(current)!;
      const onward = pair[0] === previous ? pair[1] : pair[0];
      previous = current; current = onward;
    }
    loops.push(loop);
  }

  // ---- fit the rim to the region, and let the inside follow -----------------------------------------------
  const neighbours: number[][] = Array.from({ length: xs.length }, () => []);
  for (const { a, b } of edgeUse.values()) { neighbours[a].push(b); neighbours[b].push(a); }
  /** Cells around each interior pole: a pole smoothed toward its cell CENTROIDS evens its sector angles,
   *  where plain neighbour-averaging lets whichever neighbour sits farthest drag the sectors apart. */
  const poleCells = new Map<number, number[]>();
  {
    const use = new Map<number, number[]>();
    cells.forEach((ring, index) => {
      for (const v of ring) (use.get(v) ?? (use.set(v, []), use.get(v)!)).push(index);
    });
    for (const [v, list] of use) {
      if (!boundary.has(v) && list.length !== 4) poleCells.set(v, list);
    }
  }

  const project = (x: number, z: number): SheetPoint => {
    const h = cell * 0.25;
    const d = distanceAt(x, z);
    const gx = (distanceAt(x + h, z) - distanceAt(x - h, z)) / (2 * h);
    const gz = (distanceAt(x, z + h) - distanceAt(x, z - h)) / (2 * h);
    const g2 = gx * gx + gz * gz;
    if (!(g2 > 1e-9)) return { x, z };
    let sx = -(d * gx) / g2, sz = -(d * gz) / g2;
    const step = Math.hypot(sx, sz), cap = cell * 0.5;
    if (step > cap) { sx *= cap / step; sz *= cap / step; }
    return { x: x + sx, z: z + sz };
  };

  const rounds = options.rounds ?? 24;
  const tryX = new Float64Array(xs.length), tryZ = new Float64Array(xs.length);
  for (let round = 0; round < rounds; round++) {
    tryX.set(px); tryZ.set(pz);
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const v = loop[i], before = loop[(i - 1 + loop.length) % loop.length], after = loop[(i + 1) % loop.length];
        tryX[v] = px[v] + 0.5 * ((px[before] + px[after]) / 2 - px[v]);
        tryZ[v] = pz[v] + 0.5 * ((pz[before] + pz[after]) / 2 - pz[v]);
      }
    }
    for (const v of boundary) {
      const onto = project(tryX[v], tryZ[v]);
      tryX[v] = onto.x; tryZ[v] = onto.z;
    }
    for (let v = 0; v < xs.length; v++) {
      if (boundary.has(v) || !neighbours[v].length) continue;
      let mx = 0, mz = 0;
      const around = poleCells.get(v);
      if (around) {
        for (const c of around) {
          const ring = cells[c];
          mx += (px[ring[0]] + px[ring[1]] + px[ring[2]] + px[ring[3]]) / 4;
          mz += (pz[ring[0]] + pz[ring[1]] + pz[ring[2]] + pz[ring[3]]) / 4;
        }
        mx /= around.length; mz /= around.length;
      } else {
        for (const n of neighbours[v]) { mx += px[n]; mz += pz[n]; }
        mx /= neighbours[v].length; mz /= neighbours[v].length;
      }
      tryX[v] = px[v] + 0.35 * (mx - px[v]);
      tryZ[v] = pz[v] + 0.35 * (mz - pz[v]);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const bad = cells.filter(ring => {
        let area = 0;
        for (let i = 0; i < 4; i++) {
          const a = ring[i], b = ring[(i + 1) % 4];
          area += tryX[a] * tryZ[b] - tryX[b] * tryZ[a];
        }
        return Math.sign(area / 2) !== winding;
      });
      if (!bad.length) break;
      const stuck = new Set(bad.flat());
      const last = attempt === 5;
      for (const v of stuck) {
        tryX[v] = last ? px[v] : (tryX[v] + px[v]) / 2;
        tryZ[v] = last ? pz[v] : (tryZ[v] + pz[v]) / 2;
      }
    }
    px.set(tryX); pz.set(tryZ);
  }

  // A clamped wye can leave a folded sliver where its child rows overlap their merged ground: a cell of no
  // area, sometimes wound backwards by a hair. The fold is local, so its neighbourhood knows which way is
  // out — ease each folded cell's interior vertices toward the neighbouring cells' centres until it opens.
  {
    const cellsAt: number[][] = Array.from({ length: xs.length }, () => []);
    cells.forEach((ring, index) => { for (const v of ring) cellsAt[v].push(index); });
    // A cell can hold healthy area yet still be Z-FOLDED — its own opposite edges crossing within a
    // hair — which the same point-reflection untwists: unfolding a Z recovers the cancelled area, so
    // the area-gain machinery below serves both.
    const pinched = (ring: readonly number[]): boolean => {
      for (const [a, b, c, d] of [[0, 1, 2, 3], [1, 2, 3, 0]] as const) {
        const ux = px[ring[b]] - px[ring[a]], uz = pz[ring[b]] - pz[ring[a]];
        const vx = px[ring[d]] - px[ring[c]], vz = pz[ring[d]] - pz[ring[c]];
        const wx = px[ring[a]] - px[ring[c]], wz = pz[ring[a]] - pz[ring[c]];
        const uu = ux * ux + uz * uz, vv = vx * vx + vz * vz, uv = ux * vx + uz * vz;
        const ud = ux * wx + uz * wz, vd = vx * wx + vz * wz;
        const den = uu * vv - uv * uv;
        let s = den > 1e-12 ? Math.max(0, Math.min(1, (uv * vd - vv * ud) / den)) : 0;
        const t = vv > 1e-12 ? Math.max(0, Math.min(1, (uv * s + vd) / vv)) : 0;
        s = uu > 1e-12 ? Math.max(0, Math.min(1, (uv * t - ud) / uu)) : 0;
        const dx = px[ring[a]] + ux * s - (px[ring[c]] + vx * t);
        const dz = pz[ring[a]] + uz * s - (pz[ring[c]] + vz * t);
        if (dx * dx + dz * dz < 0.15 * 0.15) return true;
      }
      return false;
    };
    const loopMates = new Map<number, [number, number]>();
    for (const loop of loops) {
      loop.forEach((v, i) => loopMates.set(v, [loop[(i - 1 + loop.length) % loop.length], loop[(i + 1) % loop.length]]));
    }
    let leftover = 0;
    for (let round = 0; round < 24; round++) {
      leftover = 0;
      for (const [index, ring] of cells.entries()) {
        if (ringArea(ring) * winding > 0.05 && !pinched(ring)) continue;
        leftover++;
        // A bowtie opens when its twisted vertex crosses back over the line of its ring neighbours: try
        // each interior vertex point-reflected through its neighbours' midpoint, keep the best opening.
        // A BOUNDARY vertex cannot reflect but may SLIDE along the rim — its loop-mates' midpoint put
        // back on the zero set — which is how a cell folded into a rim notch backs out of it.
        let bestGain = ringArea(ring) * winding, bestV = -1, bestX = 0, bestZ = 0;
        for (let corner = 0; corner < 4; corner++) {
          const v = ring[corner];
          let rx: number, rz: number;
          if (boundary.has(v)) {
            const mates = loopMates.get(v);
            if (!mates) continue;
            const slid = project((px[mates[0]] + px[mates[1]]) / 2, (pz[mates[0]] + pz[mates[1]]) / 2);
            rx = slid.x; rz = slid.z;
          } else {
            const before = ring[(corner + 3) % 4], after = ring[(corner + 1) % 4];
            rx = px[before] + px[after] - px[v]; rz = pz[before] + pz[after] - pz[v];
          }
          const keepX = px[v], keepZ = pz[v];
          px[v] = rx; pz[v] = rz;
          const opened = ringArea(ring) * winding;
          px[v] = keepX; pz[v] = keepZ;
          if (opened > bestGain) { bestGain = opened; bestV = v; bestX = rx; bestZ = rz; }
        }
        if (bestV >= 0 && bestGain > 0.05) {
          const keepX = px[bestV], keepZ = pz[bestV];
          px[bestV] = bestX; pz[bestV] = bestZ;
          const safe = cellsAt[bestV].every(other =>
            other === index || ringArea(cells[other]) * winding > 0.05);
          if (safe) continue;
          px[bestV] = keepX; pz[bestV] = keepZ;
        }
        // No single reflection opens it — ease its interior toward the neighbourhood instead.
        for (const v of ring) {
          if (boundary.has(v)) continue;
          let mx = 0, mz = 0, count = 0;
          for (const other of cellsAt[v]) {
            if (other === index) continue;
            const r2 = cells[other];
            mx += (px[r2[0]] + px[r2[1]] + px[r2[2]] + px[r2[3]]) / 4;
            mz += (pz[r2[0]] + pz[r2[1]] + pz[r2[2]] + pz[r2[3]]) / 4;
            count++;
          }
          if (!count) continue;
          px[v] += 0.25 * (mx / count - px[v]);
          pz[v] += 0.25 * (mz / count - pz[v]);
        }
      }
      if (!leftover) break;
    }
    if (leftover) notes.push(`${leftover} folded cell(s) would not open — expect them where a wye was clamped`);
  }

  /**
   * SEPARATION: the editor flags any two unconnected edges that pass within its tolerance, measured on
   * the rendered cubics, which bow past the straight lines at kinks. Two cells of one sheet meet through
   * shared vertex ids, so an unconnected pair this close is always a defect — a seam landed on a ladder's
   * rim, a mouth fan grazing a wye. Push every such pair apart until plain separation clears the
   * tolerance with cubic headroom, a step per round, guarded by the winding like every pass before it.
   */
  /**
   * Open FOLDS ACROSS SHARED EDGES: two positive-area cells lying on the same side of the edge between
   * them — a mouth corner lapped over its neighbour at a rim notch. The unfold pass above only sees
   * inverted cells, and both of these are healthy by area; the tell is their far corners agreeing on a
   * side. The shallower cell's far corners reflect across the shared edge, winding-guarded.
   */
  {
    const cellsOn = new Map<string, number[]>();
    const cellsAtVertex: number[][] = Array.from({ length: xs.length }, () => []);
    cells.forEach((ring, index) => {
      for (const w of ring) cellsAtVertex[w].push(index);
      for (let i = 0; i < 4; i++) {
        const a = ring[i], b = ring[(i + 1) % 4];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        (cellsOn.get(key) ?? (cellsOn.set(key, []), cellsOn.get(key)!)).push(index);
      }
    });
    for (let round = 0; round < 24; round++) {
      let opened = 0;
      for (const [key, pair] of cellsOn) {
        if (pair.length !== 2) continue;
        const [u, v] = key.split(',').map(Number);
        const ex = px[v] - px[u], ez = pz[v] - pz[u];
        const sideOf = (cellIndex: number): number => {
          let sum = 0;
          for (const w of cells[cellIndex]) {
            if (w === u || w === v) continue;
            sum += cross2(ex, ez, px[w] - px[u], pz[w] - pz[u]);
          }
          return sum;
        };
        const sideA = sideOf(pair[0]), sideB = sideOf(pair[1]);
        if (sideA * sideB < 0 || (sideA === 0 && sideB === 0)) continue;
        // The shallower cell folds back across; its far corners reflect to their own side — kept only
        // when every cell those corners touch stays as open as it was. A reflection that turns a healthy
        // neighbour over trades a graze for an inverted patch, which no gate downstream accepts.
        const flat = Math.abs(sideA) <= Math.abs(sideB) ? pair[0] : pair[1];
        const e2 = ex * ex + ez * ez;
        if (e2 < 1e-12) continue;
        const moved: [number, number, number][] = [];
        const touched = new Set<number>();
        for (const w of cells[flat]) {
          if (w === u || w === v || boundary.has(w)) continue;
          moved.push([w, px[w], pz[w]]);
          for (const c of cellsAtVertex[w]) touched.add(c);
        }
        if (!moved.length) continue;
        const before = new Map<number, number>();
        for (const c of touched) before.set(c, ringArea(cells[c]) * winding);
        for (const [w] of moved) {
          const wx = px[w] - px[u], wz = pz[w] - pz[u];
          const along = (wx * ex + wz * ez) / e2;
          px[w] = 2 * (px[u] + ex * along) - px[w];
          pz[w] = 2 * (pz[u] + ez * along) - pz[w];
        }
        const safe = [...touched].every(c => {
          const now = ringArea(cells[c]) * winding;
          return now > 0.05 || now >= before.get(c)! - 1e-9;
        });
        if (!safe) {
          for (const [w, wx, wz] of moved) { px[w] = wx; pz[w] = wz; }
          continue;
        }
        opened++;
      }
      if (!opened) break;
    }
  }

  const creases: [number, number][] = [];
  {
    // The margin scales with the shorter edge: the rendered cubic's bow grows with its edge's own length,
    // so long ladder edges need the full headroom while a court's short edges neither need nor have it.
    const APART = 1.0, STEP = 0.2;
    const marginFor = (e1: { a: number; b: number }, e2: { a: number; b: number }): number => {
      const len1 = Math.hypot(px[e1.b] - px[e1.a], pz[e1.b] - pz[e1.a]);
      const len2 = Math.hypot(px[e2.b] - px[e2.a], pz[e2.b] - pz[e2.a]);
      return Math.max(0.35, Math.min(APART, 0.12 * Math.min(len1, len2)));
    };
    const edges = [...edgeUse.values()];
    const keepX = new Float64Array(px.length), keepZ = new Float64Array(pz.length);
    const pushX = new Float64Array(px.length), pushZ = new Float64Array(pz.length);
    const pushes = new Float64Array(px.length);
    let grazes = 0;
    for (let round = 0; round < 200; round++) {
      keepX.set(px); keepZ.set(pz);
      pushX.fill(0); pushZ.fill(0); pushes.fill(0);
      const buckets = new Map<string, number[]>();
      const H = cell;
      edges.forEach(({ a, b }, index) => {
        const minX = Math.floor((Math.min(px[a], px[b]) - APART) / H), maxX = Math.floor((Math.max(px[a], px[b]) + APART) / H);
        const minZ = Math.floor((Math.min(pz[a], pz[b]) - APART) / H), maxZ = Math.floor((Math.max(pz[a], pz[b]) + APART) / H);
        for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
          const key = `${ix},${iz}`;
          (buckets.get(key) ?? (buckets.set(key, []), buckets.get(key)!)).push(index);
        }
      });
      grazes = 0;
      const seen = new Set<number>();
      for (const bucket of buckets.values()) {
        for (let i = 0; i < bucket.length; i++) {
          for (let j = i + 1; j < bucket.length; j++) {
            const e1 = edges[Math.min(bucket[i], bucket[j])], e2 = edges[Math.max(bucket[i], bucket[j])];
            const pairKey = Math.min(bucket[i], bucket[j]) * edges.length + Math.max(bucket[i], bucket[j]);
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);
            if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) continue;
            // Closest points of the two plan segments.
            const ax = px[e1.a], az = pz[e1.a], bx = px[e1.b], bz = pz[e1.b];
            const cx = px[e2.a], cz = pz[e2.a], dx = px[e2.b], dz = pz[e2.b];
            const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, wx = ax - cx, wz = az - cz;
            const uu = ux * ux + uz * uz, vv = vx * vx + vz * vz, uv = ux * vx + uz * vz;
            const uw = ux * wx + uz * wz, vw = vx * wx + vz * wz;
            const den = uu * vv - uv * uv;
            let s = den > 1e-12 ? (uv * vw - vv * uw) / den : 0;
            s = Math.max(0, Math.min(1, s));
            let t = vv > 1e-12 ? (uv * s + vw) / vv : 0;
            t = Math.max(0, Math.min(1, t));
            s = uu > 1e-12 ? Math.max(0, Math.min(1, (uv * t - uw) / uu)) : 0;
            const qx = ax + ux * s, qz = az + uz * s;
            const rx = cx + vx * t, rz = cz + vz * t;
            const apart = Math.hypot(qx - rx, qz - rz);
            const margin = marginFor(e1, e2);
            if (apart >= margin) continue;
            grazes++;
            let nx = qx - rx, nz = qz - rz;
            const length = Math.hypot(nx, nz);
            if (length > 1e-9) { nx /= length; nz /= length; }
            else {
              // Touching or crossing: separate along e1's own normal, whichever side e2's middle is not.
              nx = -uz; nz = ux;
              const n = Math.hypot(nx, nz) || 1;
              nx /= n; nz /= n;
              const side = (cx + dx) / 2 - qx, sideZ = (cz + dz) / 2 - qz;
              if (nx * side + nz * sideZ > 0) { nx = -nx; nz = -nz; }
            }
            // A pair down at the editor's own tolerance moves NOW, directly — urgency must not be
            // averaged away against merely-snug neighbours. Each side's RING comes along at half
            // strength, so the room is taken from fat cells further out instead of pinching the thin
            // ones next door into the winding guard.
            if (apart < 0.25) {
              const give = Math.min(0.1, (0.3 - apart) / 2);
              const drag = (v: number, sign: number, amount: number): void => {
                px[v] += nx * amount * sign; pz[v] += nz * amount * sign;
                for (const n of neighbours[v]) {
                  if (n === e1.a || n === e1.b || n === e2.a || n === e2.b) continue;
                  px[n] += nx * amount * sign * 0.5; pz[n] += nz * amount * sign * 0.5;
                }
              };
              drag(e1.a, 1, give * (1 - s)); drag(e1.b, 1, give * s);
              drag(e2.a, -1, give * (1 - t)); drag(e2.b, -1, give * t);
              continue;
            }
            const give = Math.min(STEP, (margin - apart) / 2);
            pushX[e1.a] += nx * give * (1 - s); pushZ[e1.a] += nz * give * (1 - s); pushes[e1.a]++;
            pushX[e1.b] += nx * give * s; pushZ[e1.b] += nz * give * s; pushes[e1.b]++;
            pushX[e2.a] -= nx * give * (1 - t); pushZ[e2.a] -= nz * give * (1 - t); pushes[e2.a]++;
            pushX[e2.b] -= nx * give * t; pushZ[e2.b] -= nz * give * t; pushes[e2.b]++;
          }
        }
      }
      if (round % 50 === 0 && options.debug) notes.push(`DEBUG separation round ${round}: ${grazes} grazing pair(s)`);
      if (!grazes) break;
      for (let v = 0; v < px.length; v++) {
        if (!pushes[v]) continue;
        px[v] += pushX[v] / pushes[v];
        pz[v] += pushZ[v] / pushes[v];
      }
      // The winding is the guard here as everywhere — but only against cells a push made WORSE. A sliver
      // sits under the area floor before any push touches it, and the very moves that would fatten it
      // open its area; pinning everything under the floor would pin the slivers shut forever.
      const wasArea = (ring: readonly number[]): number => {
        let area = 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          area += keepX[a] * keepZ[b] - keepX[b] * keepZ[a];
        }
        return (area / 2) * winding;
      };
      for (let attempt = 0; attempt < 6; attempt++) {
        const bad = cells.filter(ring => {
          const now = ringArea(ring) * winding;
          return now <= 0.05 && now < wasArea(ring) - 1e-9;
        });
        if (!bad.length) break;
        const last = attempt === 5;
        for (const v of new Set(bad.flat())) {
          px[v] = last ? keepX[v] : (px[v] + keepX[v]) / 2;
          pz[v] = last ? keepZ[v] : (pz[v] + keepZ[v]) / 2;
        }
      }
    }
    if (grazes) notes.push(`${grazes} unconnected edge pair(s) still graze inside their margin after separation`);

    // No pass may hand an inverted cell downstream: whatever the pushes left wound backwards eases back
    // toward its neighbourhood until it opens.
    for (let attempt = 0; attempt < 12; attempt++) {
      const bad = cells.filter(ring => ringArea(ring) * winding <= 0);
      if (!bad.length) break;
      for (const v of new Set(bad.flat())) {
        if (boundary.has(v) || !neighbours[v].length) continue;
        let mx = 0, mz = 0;
        for (const n of neighbours[v]) { mx += px[n]; mz += pz[n]; }
        px[v] += 0.5 * (mx / neighbours[v].length - px[v]);
        pz[v] += 0.5 * (mz / neighbours[v].length - pz[v]);
      }
    }
    const stillInverted = cells.filter(ring => ringArea(ring) * winding <= 0).length;
    if (stillInverted) notes.push(`${stillInverted} cell(s) still wound backwards after separation recovery`);

    // Whatever still sits snug gets its edges CREASED straight in the document: the editor's diagnostics
    // measure rendered cubics, and the Bessel default bows past the straight line exactly at the kinked
    // seams where these pairs live. One last sweep names them.
    {
      const buckets = new Map<string, number[]>();
      const H = cell;
      edges.forEach(({ a, b }, index) => {
        const minX = Math.floor((Math.min(px[a], px[b]) - APART) / H), maxX = Math.floor((Math.max(px[a], px[b]) + APART) / H);
        const minZ = Math.floor((Math.min(pz[a], pz[b]) - APART) / H), maxZ = Math.floor((Math.max(pz[a], pz[b]) + APART) / H);
        for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
          const key = `${ix},${iz}`;
          (buckets.get(key) ?? (buckets.set(key, []), buckets.get(key)!)).push(index);
        }
      });
      const seen = new Set<number>(), listed = new Set<string>();
      for (const bucket of buckets.values()) {
        for (let i = 0; i < bucket.length; i++) {
          for (let j = i + 1; j < bucket.length; j++) {
            const e1 = edges[Math.min(bucket[i], bucket[j])], e2 = edges[Math.max(bucket[i], bucket[j])];
            const pairKey = Math.min(bucket[i], bucket[j]) * edges.length + Math.max(bucket[i], bucket[j]);
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);
            if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) continue;
            const ax = px[e1.a], az = pz[e1.a], bx = px[e1.b], bz = pz[e1.b];
            const cx = px[e2.a], cz = pz[e2.a], dx = px[e2.b], dz = pz[e2.b];
            const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, wx = ax - cx, wz = az - cz;
            const uu = ux * ux + uz * uz, vv = vx * vx + vz * vz, uv = ux * vx + uz * vz;
            const uw = ux * wx + uz * wz, vw = vx * wx + vz * wz;
            const den = uu * vv - uv * uv;
            let s = den > 1e-12 ? (uv * vw - vv * uw) / den : 0;
            s = Math.max(0, Math.min(1, s));
            let t = vv > 1e-12 ? (uv * s + vw) / vv : 0;
            t = Math.max(0, Math.min(1, t));
            s = uu > 1e-12 ? Math.max(0, Math.min(1, (uv * t - uw) / uu)) : 0;
            const apart = Math.hypot(ax + ux * s - (cx + vx * t), az + uz * s - (cz + vz * t));
            // The full headroom band, not the per-pair margin: a pair the pushes DID clear can still be
            // reached by a kinked neighbour's bow, and a straight edge is harmless where a bowed one is
            // a marker.
            if (apart >= APART) continue;
            for (const edge of [e1, e2]) {
              const key = edge.a < edge.b ? `${edge.a},${edge.b}` : `${edge.b},${edge.a}`;
              if (listed.has(key)) continue;
              listed.add(key);
              creases.push([edge.a, edge.b]);
            }
          }
        }
      }
    }
  }

  let sum = 0, worst = 0;
  for (const v of boundary) {
    const off = Math.abs(distanceAt(px[v], pz[v]));
    sum += off; worst = Math.max(worst, off);
  }

  return {
    ok: true,
    points: Array.from({ length: xs.length }, (_, v) => ({ x: px[v], z: pz[v] })),
    // Perimeter order p0→p1→p2→p3 stored as the quilt's [A, B, C, D] with perimeter A→B→D→C.
    quads: cells.map(([p0, p1, p2, p3]) => [p0, p1, p3, p2] as [number, number, number, number]),
    boundary, loops,
    filled: 0, dropped: 0,
    fit: { meanM: boundary.size ? sum / boundary.size : 0, worstM: worst },
    winding,
    flowAngle: cellFlow,
    kinds: cellKind,
    parts: cellPart,
    creases,
    made, notes,
  };
}
