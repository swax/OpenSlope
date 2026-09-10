// Universal SSX level scorecard. Measures any Maps/<NAME> folder against GARI's terrain
// vocabulary, computing GARI live as the reference column so the tool is self-validating
// (scoring GARI vs GARI yields ~zero deltas). Measures profile rhythm, surface mix and quilt
// continuity; see docs/authoring/064-terrain-vocabulary.md for design terms and interpretation.
// This reference comparison is one feedback signal for authoring a new mountain.
//
//   tsx Slopesmith/tools/mountain-study/score.ts            # GARI vs GARI (sanity: all deltas ~0)
//   tsx Slopesmith/tools/mountain-study/score.ts ELYSIUM    # does the vocabulary generalize to another original level?
//   tsx Slopesmith/tools/mountain-study/score.ts OpenSlope01      # score an authored candidate
//
// Space: raw SSX is -Y-up, cm. Decoded to metres as (east,up,north) = (-x/100, -y/100, z/100).
import { readFileSync, existsSync } from "node:fs";
import { MAPS_DIR } from "./paths.ts";

const ROOT = MAPS_DIR;
type V3 = [number, number, number];

// ----------------------------------------------------------------- decode helpers
// Two raw conventions reach this tool in the SAME on-disk shape:
//   original (extracted SSX): -Y-up, vertical at raw index 1  -> up=-raw1, north=raw2
//   authored (Slopesmith toRaw=[-100x,-100z,100y]): vertical at raw index 2 -> up=raw2, north=-raw1
// We pick per level (PatchName "Cell_r*" = authored) so GARI and a candidate are scored in the
// same physical frame. Area/angle metrics are frame-invariant; only the up axis (profile) cares.
let dec: (p: number[]) => V3 = (p) => [-p[0] / 100, -p[1] / 100, p[2] / 100]; // (east, up, north) m, original
const decOriginal = (p: number[]): V3 => [-p[0] / 100, -p[1] / 100, p[2] / 100];
const decAuthored = (p: number[]): V3 => [-p[0] / 100, p[2] / 100, -p[1] / 100];
const horiz = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a: V3): V3 => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const med = (xs: number[]) => pct(xs, 0.5);

// ----------------------------------------------------------------- surface families
const FAMILY: Record<number, string> = {
  0: "reset", 2: "reset", 1: "snow", 15: "snow", 3: "powder", 4: "powder",
  5: "ice", 9: "rock", 10: "rock", 17: "nocol", 18: "ramp",
};
const RIDEABLE = new Set(["snow", "powder", "ice", "rock", "ramp"]);
const FAM_ORDER = ["snow", "powder", "ice", "rock", "ramp", "reset", "nocol"];

interface Metrics {
  name: string;
  patches: number;
  altLo: number; altHi: number; drop: number;
  // spine profile (main course line)
  spineLen: number; spineDrop: number; avgGrade: number;
  bandFlat: number; bandEasy: number; bandMid: number; bandSteep: number; // % of length, grade |g|
  crestSpacing: number; convexFrac: number; concaveFrac: number;
  // surface mix: ha + % of rideable area
  surfHa: Record<string, number>; surfPct: Record<string, number>;
  // continuity
  sharedEdges: number; watertight: number; dihedralMed: number; dihedralP75: number; creaseFrac: number;
}

function loadJson(dir: string, f: string): any {
  const path = `${dir}/${f}`;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

// ------------------------------------------------------------- main course spine
// Pick Race Line 0 if present, else the longest race line, else the longest Respawnable AIPath.
function bakeLine(e: any): V3[] {
  if (!e.PathPoints || e.PathPoints.length < 2) return [];
  let [ax, ay, az] = e.PathPos ?? [0, 0, 0];
  const pts: V3[] = [];
  for (const p of e.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push(dec([ax, ay, az])); }
  return pts;
}
function pickSpine(dir: string): V3[] {
  const cands: { name: string; race: boolean; pts: V3[]; len: number }[] = [];
  for (const f of ["AIP.json", "SOP.json"]) {
    const pf = loadJson(dir, f); if (!pf) continue;
    for (const rl of pf.RaceLines ?? []) { const pts = bakeLine(rl); if (pts.length > 2) cands.push({ name: rl.Name, race: true, pts, len: arcLen(pts) }); }
    for (const ap of pf.AIPaths ?? []) { const pts = bakeLine(ap); if (pts.length > 2) cands.push({ name: ap.Name, race: false, pts, len: arcLen(pts) }); }
  }
  if (!cands.length) return [];
  const rl0 = cands.find(c => c.race && /Race Line 0\b/.test(c.name));
  if (rl0) return rl0.pts;
  const races = cands.filter(c => c.race).sort((a, b) => b.len - a.len);
  if (races.length) return races[0].pts;
  return cands.sort((a, b) => b.len - a.len)[0].pts;
}
function arcLen(pts: V3[]) { let d = 0; for (let i = 1; i < pts.length; i++) d += dist3(pts[i], pts[i - 1]); return d; }

// Resample a polyline to uniform 3D arc-length step.
function resample(pts: V3[], ds: number): V3[] {
  if (pts.length < 2) return pts;
  const out: V3[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist3(pts[i - 1], pts[i]);
    if (seg < 1e-6) continue;
    const dir = sub(pts[i], pts[i - 1]).map(x => x / seg) as V3;
    let t = ds - carry;
    while (t <= seg) { out.push([pts[i - 1][0] + dir[0] * t, pts[i - 1][1] + dir[1] * t, pts[i - 1][2] + dir[2] * t]); t += ds; }
    carry = seg - (t - ds);
  }
  return out;
}

// ------------------------------------------------------------- profile rhythm
function profileMetrics(spine: V3[]): Pick<Metrics, "spineLen" | "spineDrop" | "avgGrade" | "bandFlat" | "bandEasy" | "bandMid" | "bandSteep" | "crestSpacing" | "convexFrac" | "concaveFrac"> {
  const empty = { spineLen: 0, spineDrop: 0, avgGrade: 0, bandFlat: 0, bandEasy: 0, bandMid: 0, bandSteep: 0, crestSpacing: NaN, convexFrac: 0, concaveFrac: 0 };
  if (spine.length < 3) return empty;
  const P = resample(spine, 6); // 6 m steps
  const N = P.length;
  const s: number[] = [0]; for (let i = 1; i < N; i++) s.push(s[i - 1] + dist3(P[i - 1], P[i]));
  const total = s[N - 1];
  const drop = P[0][1] - P[N - 1][1];
  let hrun = 0; for (let i = 1; i < N; i++) hrun += horiz(P[i - 1], P[i]); // horizontal arc length

  // windowed grade (drop/run over ~100 m) -> band fractions, weighted by step length
  let len = 0, lf = 0, le = 0, lm = 0, ls = 0;
  for (let i = 1; i < N; i++) {
    const si = s[i]; let a = i, b = i;
    while (a > 0 && si - s[a] < 50) a--;
    while (b < N - 1 && s[b] - si < 50) b++;
    const run = horiz(P[a], P[b]); const vd = P[a][1] - P[b][1];
    const g = run > 1 ? Math.abs(vd / run) : 0;
    const w = s[i] - s[i - 1]; len += w;
    if (g < 0.15) lf += w; else if (g < 0.50) le += w; else if (g < 0.90) lm += w; else ls += w;
  }

  // vertical curvature: pitch angle over ~12 m, delta over the neighbourhood.
  // convex (crest/roll, terrain falls away = kicker) = pitch increasing downhill; concave = compression.
  const pitch: number[] = new Array(N).fill(0);
  for (let i = 1; i < N - 1; i++) {
    const run = horiz(P[i - 1], P[i + 1]); const vd = P[i - 1][1] - P[i + 1][1];
    pitch[i] = Math.atan2(vd, Math.max(run, 1e-3));
  }
  let convex = 0, concave = 0;
  const crestS: number[] = [];
  const span = 2; // +-12 m
  const events: { s: number }[] = [];
  for (let i = span; i < N - span; i++) {
    const dth = pitch[i + span] - pitch[i - span];
    const arc = s[i + span] - s[i - span];
    const R = arc / Math.max(1e-4, Math.abs(dth));
    if (R < 125) { if (dth > 0) convex++; else concave++; }
    // crest event: local maximum of convex curvature, R<125, non-max-suppressed within 30 m
    if (dth > 0 && R < 125) {
      const dprev = pitch[i + span - 1] - pitch[i - span - 1];
      const dnext = pitch[i + span + 1] - pitch[i - span + 1];
      if (dth >= dprev && dth >= dnext) {
        if (!events.length || s[i] - events[events.length - 1].s > 30) events.push({ s: s[i] });
      }
    }
  }
  for (let i = 1; i < events.length; i++) crestS.push(events[i].s - events[i - 1].s);
  const denom = convex + concave + Math.max(1, N - 2 * span - convex - concave);

  return {
    spineLen: total, spineDrop: drop, avgGrade: (drop / Math.max(1, hrun)) * 100,
    bandFlat: 100 * lf / len, bandEasy: 100 * le / len, bandMid: 100 * lm / len, bandSteep: 100 * ls / len,
    crestSpacing: med(crestS), convexFrac: 100 * convex / denom, concaveFrac: 100 * concave / denom,
  };
}

// ------------------------------------------------------------- patches: surface + continuity
function patchMetrics(patches: any[]): Pick<Metrics, "patches" | "altLo" | "altHi" | "drop" | "surfHa" | "surfPct" | "sharedEdges" | "watertight" | "dihedralMed" | "dihedralP75" | "creaseFrac"> {
  const surfArea: Record<string, number> = {};
  let altLo = 1e9, altHi = -1e9;
  // edge index: key by the two rounded endpoints -> list of {normal}
  const edges = new Map<string, { n: V3; exact: boolean }[]>();
  const key = (a: V3, b: V3) => {
    const r = (v: V3) => `${Math.round(v[0] * 10)},${Math.round(v[1] * 10)},${Math.round(v[2] * 10)}`; // 10 cm bucket
    const ka = r(a), kb = r(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const exactKey = (a: V3, b: V3) => {
    const r = (v: V3) => `${Math.round(v[0] * 100)},${Math.round(v[1] * 100)},${Math.round(v[2] * 100)}`; // 1 cm
    const ka = r(a), kb = r(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const exactSeen = new Map<string, number>();

  const triArea = (u: V3, v: V3, w: V3) => { const c = cross(sub(v, u), sub(w, u)); return Math.hypot(c[0], c[1], c[2]) / 2; };

  for (const p of patches) {
    if (!p.Points || p.Points.length < 16) continue;
    const C = (i: number) => dec(p.Points[i]);
    const a = C(0), b = C(3), d = C(15), c = C(12); // surface corners A,B,D,C (CCW)
    for (const q of [a, b, c, d]) { if (q[1] < altLo) altLo = q[1]; if (q[1] > altHi) altHi = q[1]; }
    const fam = FAMILY[p.SurfaceType] ?? "rock";
    surfArea[fam] = (surfArea[fam] ?? 0) + triArea(a, b, d) + triArea(a, d, c);
    // face normal (Newell over the 4 corners)
    const ring = [a, b, d, c]; let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < 4; i++) { const u = ring[i], v = ring[(i + 1) % 4]; nx += (u[1] - v[1]) * (u[2] + v[2]); ny += (u[2] - v[2]) * (u[0] + v[0]); nz += (u[0] - v[0]) * (u[1] + v[1]); }
    const fn = nrm([nx, ny, nz]);
    const corners = [a, b, d, c];
    for (let i = 0; i < 4; i++) {
      const e0 = corners[i], e1 = corners[(i + 1) % 4];
      const k = key(e0, e1);
      (edges.get(k) ?? edges.set(k, []).get(k)!).push({ n: fn, exact: false });
      const ek = exactKey(e0, e1); exactSeen.set(ek, (exactSeen.get(ek) ?? 0) + 1);
    }
  }

  // shared edges: keys seen by exactly 2 patches -> dihedral between their face normals
  const dih: number[] = [];
  let shared = 0;
  for (const [, arr] of edges) {
    if (arr.length !== 2) continue;
    shared++;
    let d = Math.acos(Math.max(-1, Math.min(1, arr[0].n[0] * arr[1].n[0] + arr[0].n[1] * arr[1].n[1] + arr[0].n[2] * arr[1].n[2]))) * 180 / Math.PI;
    if (d > 90) d = 180 - d; // unoriented faces
    dih.push(d);
  }
  let watertight = 0; for (const [, n] of exactSeen) if (n >= 2) watertight++;

  const totRide = FAM_ORDER.filter(f => RIDEABLE.has(f)).reduce((s, f) => s + (surfArea[f] ?? 0), 0);
  const surfHa: Record<string, number> = {}, surfPct: Record<string, number> = {};
  for (const f of FAM_ORDER) { surfHa[f] = (surfArea[f] ?? 0) / 1e4; surfPct[f] = RIDEABLE.has(f) && totRide > 0 ? 100 * (surfArea[f] ?? 0) / totRide : NaN; }

  return {
    patches: patches.length, altLo, altHi, drop: altHi - altLo,
    surfHa, surfPct,
    sharedEdges: shared, watertight, dihedralMed: med(dih), dihedralP75: pct(dih, 0.75),
    creaseFrac: 100 * dih.filter(x => x > 15).length / Math.max(1, dih.length),
  };
}

function measure(name: string): Metrics {
  const dir = `${ROOT}/${name}`;
  const pj = loadJson(dir, "Patches.json");
  if (!pj) throw new Error(`no Patches.json in ${dir}`);
  dec = (pj.Patches[0]?.PatchName ?? "").startsWith("Cell_r") ? decAuthored : decOriginal;
  const pm = patchMetrics(pj.Patches);
  const prof = profileMetrics(pickSpine(dir));
  return { name, ...pm, ...prof } as Metrics;
}

// ----------------------------------------------------------------- report
function fmt(x: number, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : "  -"; }
function row(label: string, ref: number, tgt: number, unit: string, tol: number, d = 1) {
  const delta = tgt - ref;
  const flag = !Number.isFinite(ref) || !Number.isFinite(tgt) ? " " : Math.abs(delta) <= tol ? "ok " : Math.abs(delta) <= tol * 2.5 ? "~  " : "XX ";
  console.log(`  ${flag}${label.padEnd(26)} ref ${fmt(ref, d).padStart(8)}  tgt ${fmt(tgt, d).padStart(8)}  Δ ${(delta >= 0 ? "+" : "") + fmt(delta, d)} ${unit}`);
}

const refName = "GARI";
const tgtName = process.argv[2] ?? "GARI";
const ref = measure(refName);
const tgt = measure(tgtName);

console.log(`\n=== SCORECARD: ${tgtName}  (reference: ${refName}) ===`);
console.log(`\n-- size --`);
console.log(`     ${"patches".padEnd(26)} ref ${String(ref.patches).padStart(8)}  tgt ${String(tgt.patches).padStart(8)}`);
row("altitude drop", ref.drop, tgt.drop, "m", 200, 0);

console.log(`\n-- spine profile (main course line) --`);
row("length", ref.spineLen, tgt.spineLen, "m", 150, 0);
row("drop", ref.spineDrop, tgt.spineDrop, "m", 100, 0);
row("avg grade", ref.avgGrade, tgt.avgGrade, "%", 10);
row("band flat  <15%", ref.bandFlat, tgt.bandFlat, "% len", 8);
row("band easy  15-50%", ref.bandEasy, tgt.bandEasy, "% len", 8);
row("band mid   50-90%", ref.bandMid, tgt.bandMid, "% len", 8);
row("band steep >90%", ref.bandSteep, tgt.bandSteep, "% len", 8);
row("terrace crest spacing", ref.crestSpacing, tgt.crestSpacing, "m", 20, 0);
row("convex (R<125m)", ref.convexFrac, tgt.convexFrac, "%", 10);
row("concave (R<125m)", ref.concaveFrac, tgt.concaveFrac, "%", 10);

console.log(`\n-- surface mix (% of rideable area) --`);
for (const f of ["snow", "powder", "ice", "rock"]) row(f, ref.surfPct[f], tgt.surfPct[f], "%", 8);
console.log(`     (rideable ha: ref ${FAM_ORDER.filter(f => RIDEABLE.has(f)).reduce((s, f) => s + ref.surfHa[f], 0).toFixed(0)}  tgt ${FAM_ORDER.filter(f => RIDEABLE.has(f)).reduce((s, f) => s + tgt.surfHa[f], 0).toFixed(0)})`);

console.log(`\n-- quilt continuity --`);
console.log(`     ${"shared edges".padEnd(26)} ref ${String(ref.sharedEdges).padStart(8)}  tgt ${String(tgt.sharedEdges).padStart(8)}`);
row("face dihedral median", ref.dihedralMed, tgt.dihedralMed, "deg", 3);
row("face dihedral p75", ref.dihedralP75, tgt.dihedralP75, "deg", 8);
row("crease frac (>15deg)", ref.creaseFrac, tgt.creaseFrac, "%", 8);
console.log("");
