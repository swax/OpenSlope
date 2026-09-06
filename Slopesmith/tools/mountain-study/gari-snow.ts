// GARI snow-cover study: how snow meets rock.
//  A. slope -> surface-type rule (when does terrain stop being snow?)
//  B. snow-rock shared patch edges: lip (ridge) vs fillet (valley), crease angles
//  C. fillet geometry at rock bases (drift wedge height/width) + lip rounding at cliff tops
//  D. overhangs: snow shelves plan-covering steep rock faces
// Figure: cross-profiles through representative lip and fillet edges.
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const patches = (JSON.parse(readFileSync(`${DIR}/Patches.json`, "utf8")).Patches as any[]).filter(p => p.Points?.length >= 16);

const SNOW = new Set([1, 3, 4, 5]);
const ROCK = new Set([9, 10]);

// ---------------- Bézier helpers (metres, east/up/north = -x/100, -y/100, z/100)
const M = (q: number[]) => [-q[0]! / 100, -q[1]! / 100, q[2]! / 100];
const bez1 = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
const bez1d = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c); };
function evalPatch(P: number[][], u: number, v: number, deriv = false) {
  // rows along u (4 rows of 4), then columns along v
  const pt: number[] = [], du: number[] = [], dv: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = [0, 1, 2, 3].map(rr => bez1(P[rr * 4]![i]!, P[rr * 4 + 1]![i]!, P[rr * 4 + 2]![i]!, P[rr * 4 + 3]![i]!, u));
    pt.push(bez1(r[0]!, r[1]!, r[2]!, r[3]!, v));
    if (deriv) {
      const rd = [0, 1, 2, 3].map(rr => bez1d(P[rr * 4]![i]!, P[rr * 4 + 1]![i]!, P[rr * 4 + 2]![i]!, P[rr * 4 + 3]![i]!, u));
      du.push(bez1(rd[0]!, rd[1]!, rd[2]!, rd[3]!, v));
      dv.push(bez1d(r[0]!, r[1]!, r[2]!, r[3]!, v));
    }
  }
  return { pt, du, dv };
}
const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: number[]) => { const n = Math.hypot(...a) || 1; return a.map(x => x / n); };

// ---------------- heightfields: combined max + snow-only + rock-only
let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
for (const p of patches) for (const q of p.Points) { const m = M(q); if (m[0]! < mnx) mnx = m[0]!; if (m[0]! > mxx) mxx = m[0]!; if (m[2]! < mnz) mnz = m[2]!; if (m[2]! > mxz) mxz = m[2]!; }
const CELL = 2;
const GW = Math.ceil((mxx - mnx) / CELL) + 2, GH = Math.ceil((mxz - mnz) / CELL) + 2;
const hAll = new Float32Array(GW * GH).fill(NaN);
const hSnow = new Float32Array(GW * GH).fill(NaN);
const hRock = new Float32Array(GW * GH).fill(NaN);
const tAll = new Int8Array(GW * GH).fill(-1);
const gi = (x: number, z: number) => [Math.round((x - mnx) / CELL), Math.round((z - mnz) / CELL)];
for (const p of patches) {
  const P = p.Points.map(M);
  let a1 = 1e9, a2 = -1e9, b1 = 1e9, b2 = -1e9;
  for (const q of P) { a1 = Math.min(a1, q[0]!); a2 = Math.max(a2, q[0]!); b1 = Math.min(b1, q[2]!); b2 = Math.max(b2, q[2]!); }
  const ru = Math.min(96, Math.max(6, Math.ceil((a2 - a1) / CELL) + 1));
  const rv = Math.min(96, Math.max(6, Math.ceil((b2 - b1) / CELL) + 1));
  for (let a = 0; a <= ru; a++) for (let b = 0; b <= rv; b++) {
    const s = evalPatch(P, a / ru, b / rv).pt;
    const [cx, cz] = gi(s[0]!, s[2]!);
    if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) continue;
    const o = cz! * GW + cx!;
    if (isNaN(hAll[o]!) || s[1]! > hAll[o]!) { hAll[o] = s[1]!; tAll[o] = p.SurfaceType; }
    if (SNOW.has(p.SurfaceType) && (isNaN(hSnow[o]!) || s[1]! > hSnow[o]!)) hSnow[o] = s[1]!;
    if (ROCK.has(p.SurfaceType) && (isNaN(hRock[o]!) || s[1]! > hRock[o]!)) hRock[o] = s[1]!;
  }
}
const H = (F: Float32Array, x: number, z: number) => {
  const fx = (x - mnx) / CELL, fz = (z - mnz) / CELL;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const q = (xx: number, zz: number) => F[Math.min(GH - 1, Math.max(0, zz)) * GW + Math.min(GW - 1, Math.max(0, xx))]!;
  const h00 = q(x0, z0), h10 = q(x0 + 1, z0), h01 = q(x0, z0 + 1), h11 = q(x0 + 1, z0 + 1);
  if ([h00, h10, h01, h11].some(isNaN)) return NaN;
  const tx = fx - x0, tz = fz - z0;
  return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
};

// ---------------- A. slope -> type rule (analytic patch normals, area-weighted)
console.log("=== A. SLOPE -> SURFACE-TYPE RULE (patch-analytic, area-weighted) ===");
const slopeBins = Array.from({ length: 9 }, (_, i) => ({ lo: i * 10, hi: i * 10 + 10, snow: 0, rock: 0, other: 0 }));
const typeSlopes = new Map<number, { deg: number; w: number }[]>();
for (const p of patches) {
  const P = p.Points.map(M);
  const t = p.SurfaceType;
  for (let a = 0; a < 7; a++) for (let b = 0; b < 7; b++) {
    const e = evalPatch(P, (a + 0.5) / 7, (b + 0.5) / 7, true);
    const n = cross(e.du, e.dv);
    const area = Math.hypot(...n) / 49; // sample area weight
    const ny = Math.abs(n[1]!) / (Math.hypot(...n) || 1);
    const deg = (Math.acos(Math.min(1, ny)) * 180) / Math.PI; // angle from horizontal
    const bin = slopeBins[Math.min(8, Math.floor(deg / 10))]!;
    if (SNOW.has(t)) bin.snow += area; else if (ROCK.has(t)) bin.rock += area; else bin.other += area;
    if (!typeSlopes.has(t)) typeSlopes.set(t, []);
    typeSlopes.get(t)!.push({ deg, w: area });
  }
}
console.log("slope-bin   snow%   rock/wall%   (area ha)");
for (const b of slopeBins) {
  const n = b.snow + b.rock + b.other;
  if (n < 1e4) continue;
  console.log(`${String(b.lo).padStart(2)}-${b.hi}°      ${(100 * b.snow / n).toFixed(0).padStart(3)}%     ${(100 * b.rock / n).toFixed(0).padStart(3)}%       ${(n / 1e4).toFixed(1)}`);
}
const TN: Record<number, string> = { 1: "snow", 3: "powder", 4: "slow-powder", 5: "ice", 9: "rock", 10: "wall", 18: "ramp", 0: "reset", 17: "nocol" };
console.log("per-type slope median/p90 (area-weighted):");
for (const [t, arr] of [...typeSlopes.entries()].sort((a, b) => a[0] - b[0])) {
  arr.sort((a, b) => a.deg - b.deg);
  const tot = arr.reduce((s, x) => s + x.w, 0);
  if (tot < 1e3) continue;
  const wq = (p: number) => { let acc = 0; for (const x of arr) { acc += x.w; if (acc >= tot * p) return x.deg; } return arr[arr.length - 1]!.deg; };
  console.log(`  ${String(t).padStart(2)} ${(TN[t] ?? "?").padEnd(12)} ${wq(0.5).toFixed(0).padStart(3)}° / ${wq(0.9).toFixed(0)}°   (${(tot / 1e4).toFixed(1)} ha)`);
}

// ---------------- B. snow-rock shared edges
console.log("\n=== B. SNOW-ROCK PATCH EDGES ===");
const EDGES = [
  { idx: [0, 1, 2, 3] }, { idx: [12, 13, 14, 15] }, { idx: [0, 4, 8, 12] }, { idx: [3, 7, 11, 15] },
];
const snap = (q: number[]) => `${Math.round(q[0]! / 2)},${Math.round(q[1]! / 2)},${Math.round(q[2]! / 2)}`; // raw cm /2
const edgeMap = new Map<string, { pi: number; e: number }[]>();
patches.forEach((p, pi) => {
  EDGES.forEach((E, e) => {
    const k = E.idx.map(i => snap(p.Points[i])).sort().join("|");
    if (!edgeMap.has(k)) edgeMap.set(k, []);
    edgeMap.get(k)!.push({ pi, e });
  });
});
// edge midpoint uv per edge index
const EDGE_UV: [number, number][] = [[0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]];
interface SREdge { mid: number[]; dir: number[]; dihedral: number; ridge: boolean; snowPi: number }
const srEdges: SREdge[] = [];
let snowRockShared = 0;
for (const arr of edgeMap.values()) {
  if (arr.length < 2) continue;
  for (let i = 0; i < arr.length; i++) for (let k = i + 1; k < arr.length; k++) {
    const A = arr[i]!, B = arr[k]!;
    const ta = patches[A.pi]!.SurfaceType, tb = patches[B.pi]!.SurfaceType;
    const aSnow = SNOW.has(ta), bSnow = SNOW.has(tb), aRock = ROCK.has(ta), bRock = ROCK.has(tb);
    if (!((aSnow && bRock) || (aRock && bSnow))) continue;
    snowRockShared++;
    const Sn = aSnow ? A : B, Rk = aSnow ? B : A;
    const Ps = patches[Sn.pi]!.Points.map(M), Pr = patches[Rk.pi]!.Points.map(M);
    const [us, vs] = EDGE_UV[Sn.e]!, [ur, vr] = EDGE_UV[Rk.e]!;
    const es = evalPatch(Ps, us, vs, true), er = evalPatch(Pr, ur, vr, true);
    let ns = norm(cross(es.du, es.dv)); if (ns[1]! < 0) ns = ns.map(x => -x);
    let nr = norm(cross(er.du, er.dv)); if (nr[1]! < 0) nr = nr.map(x => -x);
    const dih = (Math.acos(Math.min(1, Math.max(-1, ns[0]! * nr[0]! + ns[1]! * nr[1]! + ns[2]! * nr[2]!))) * 180) / Math.PI;
    // ridge vs valley: edge height vs heights 4 m into each patch (plan)
    const mid = es.pt;
    const inward = (E: { pi: number; e: number }, P: number[][]) => {
      const [u0, v0] = EDGE_UV[E.e]!;
      const ci = evalPatch(P, 0.5 + (0.5 - u0) * 0.4, 0.5 + (0.5 - v0) * 0.4).pt; // toward patch centre
      const d = [ci[0]! - mid[0]!, ci[2]! - mid[2]!];
      const n2 = Math.hypot(...d) || 1;
      return [d[0]! / n2, d[1]! / n2];
    };
    const ds = inward(Sn, Ps), dr = inward(Rk, Pr);
    const hs4 = H(hAll, mid[0]! + ds[0]! * 5, mid[2]! + ds[1]! * 5);
    const hr4 = H(hAll, mid[0]! + dr[0]! * 5, mid[2]! + dr[1]! * 5);
    if (isNaN(hs4) || isNaN(hr4)) continue;
    const ridge = mid[1]! > hs4 - 0.5 && mid[1]! > hr4 + 2;   // edge above rock side by 2 m+ -> cliff top lip
    const valley = mid[1]! < hr4 - 2 && mid[1]! <= hs4 + 0.5; // rock rises above -> base fillet
    if (!ridge && !valley) { srEdges.push({ mid, dir: ds, dihedral: dih, ridge: false, snowPi: -1 }); continue; }
    srEdges.push({ mid, dir: ds, dihedral: dih, ridge, snowPi: Sn.pi });
  }
}
const ridges = srEdges.filter(e => e.ridge && e.snowPi >= 0);
const valleys = srEdges.filter(e => !e.ridge && e.snowPi >= 0);
const flats = srEdges.length - ridges.length - valleys.length;
console.log(`snow-rock shared edges: ${snowRockShared} -> cliff-top lips ${ridges.length}, base fillets ${valleys.length}, flush/other ${flats}`);
const dStats = (es: SREdge[]) => {
  const a = es.map(e => e.dihedral).sort((x, y) => x - y);
  return a.length ? `med ${a[Math.floor(a.length / 2)]!.toFixed(0)}° p75 ${a[Math.floor(a.length * .75)]!.toFixed(0)}° p90 ${a[Math.floor(a.length * .9)]!.toFixed(0)}°` : "-";
};
console.log(`dihedral (surface-normal kink) at lips:    ${dStats(ridges)}`);
console.log(`dihedral at base fillets:                  ${dStats(valleys)}`);

// ---------------- C. profiles across edges: lip rounding + drift wedge
// profile: from 20 m on the snow side to 20 m past the edge on the rock side, 0.5 m steps, heights from hAll
function profile(e: SREdge): number[] {
  const out: number[] = [];
  for (let s = -20; s <= 20; s += 0.5) out.push(H(hAll, e.mid[0]! - e.dir[0]! * s, e.mid[2]! - e.dir[1]! * s)); // s>0 = away from snow (rock side)
  return out;
}
// fillet: deviation of snow surface from far-field line fitted at 12-20 m out on the snow side
function filletMetrics(e: SREdge) {
  const pr = profile(e);
  const at = (s: number) => pr[Math.round((s + 20) / 0.5)]!;
  const f1 = at(-20), f2 = at(-12);
  if (isNaN(f1) || isNaN(f2)) return null;
  const slope = (f2 - f1) / 8; // per metre toward edge
  const predict = (s: number) => f2 + slope * (s + 12);
  let wedgeH = 0, wedgeW = 0;
  for (let s = -11.5; s <= 0; s += 0.5) {
    const dev = at(s) - predict(s);
    if (isNaN(dev)) continue;
    if (dev > wedgeH) wedgeH = dev;
    if (dev > 0.5) wedgeW = Math.max(wedgeW, -s + 0.5);
  }
  return { wedgeH, wedgeW };
}
// lip: snow-side surface angle change in the last metres before the edge
function lipMetrics(e: SREdge) {
  const pr = profile(e);
  const at = (s: number) => pr[Math.round((s + 20) / 0.5)]!;
  const aFar = Math.atan2(at(-8) - at(-14), 6); // far slope (rad, + = rising toward edge)
  const aNear = Math.atan2(at(-0.5) - at(-3.5), 3);
  if ([aFar, aNear].some(isNaN)) return null;
  return { droop: ((aFar - aNear) * 180) / Math.PI }; // + = surface curls down approaching the lip
}
const fm = valleys.map(filletMetrics).filter(Boolean) as { wedgeH: number; wedgeW: number }[];
const lm = ridges.map(lipMetrics).filter(Boolean) as { droop: number }[];
const q = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.floor(a.length * p)]!;
if (fm.length) console.log(`\nbase FILLET (drift wedge rising onto the rock): height med ${q(fm.map(f => f.wedgeH), .5).toFixed(1)} m p75 ${q(fm.map(f => f.wedgeH), .75).toFixed(1)} m; width med ${q(fm.map(f => f.wedgeW), .5).toFixed(1)} m p75 ${q(fm.map(f => f.wedgeW), .75).toFixed(1)} m (n=${fm.length})`);
if (lm.length) console.log(`cliff-top LIP (snow curling down toward the edge): droop med ${q(lm.map(l => l.droop), .5).toFixed(1)}° p75 ${q(lm.map(l => l.droop), .75).toFixed(1)}° over the last ~3 m (n=${lm.length}; negative = kicker-style upward lip)`);

// ---------------- D. overhang: steep rock plan-covered by higher snow
let faceCells = 0, shelfCells = 0;
for (let z = 2; z < GH - 2; z++) for (let x = 2; x < GW - 2; x++) {
  const o = z * GW + x;
  if (isNaN(hRock[o]!)) continue;
  const gx = (hRock[o + 2]! - hRock[o - 2]!) / (4 * CELL), gz = (hRock[o + 2 * GW]! - hRock[o - 2 * GW]!) / (4 * CELL);
  if (isNaN(gx) || isNaN(gz) || Math.hypot(gx, gz) < Math.tan((55 * Math.PI) / 180)) continue;
  faceCells++;
  if (!isNaN(hSnow[o]!) && hSnow[o]! > hRock[o]! + 2) shelfCells++;
}
console.log(`\n=== D. SNOW SHELVES OVER ROCK FACES ===\nsteep-rock cells (>55°): ${faceCells}; plan-covered by snow ≥2 m higher: ${shelfCells} (${(100 * shelfCells / Math.max(1, faceCells)).toFixed(1)}%)`);

// ---------------- figure: 12 profiles (6 fillets, 6 lips)
const PWi = 2200, PHi = 1200, COLS = 4, ROWS = 3;
const img = Buffer.alloc(PWi * PHi * 4);
for (let i = 0; i < PWi * PHi; i++) { img[i * 4] = 24; img[i * 4 + 1] = 26; img[i * 4 + 2] = 34; img[i * 4 + 3] = 255; }
const put = (x: number, y: number, c: number[]) => { if (x >= 0 && y >= 0 && x < PWi && y < PHi) { const o = (y * PWi + x) * 4; img[o] = c[0]!; img[o + 1] = c[1]!; img[o + 2] = c[2]!; } };
const picks = [...valleys.filter((_, i) => i % Math.ceil(valleys.length / 6) === 0).slice(0, 6), ...ridges.filter((_, i) => i % Math.ceil(ridges.length / 6) === 0).slice(0, 6)];
picks.forEach((e, idx) => {
  const gx = idx % COLS, gy = Math.floor(idx / COLS);
  const ox = gx * (PWi / COLS) + 25, oy = gy * (PHi / ROWS) + 25, w = PWi / COLS - 50, h = PHi / ROWS - 50;
  const pr = profile(e);
  const c0 = pr[Math.round(20 / 0.5)]!; // edge height
  for (let k = 1; k < pr.length; k++) {
    if (isNaN(pr[k - 1]!) || isNaN(pr[k]!)) continue;
    const x0 = ox + ((k - 1) / pr.length) * w, x1 = ox + (k / pr.length) * w;
    const y0 = oy + h / 2 - Math.max(-h / 2, Math.min(h / 2, (pr[k - 1]! - c0) * 6));
    const y1 = oy + h / 2 - Math.max(-h / 2, Math.min(h / 2, (pr[k]! - c0) * 6));
    const steps = Math.max(1, Math.ceil(Math.abs(x1 - x0) + Math.abs(y1 - y0)));
    const col = idx < 6 ? [140, 220, 250] : [250, 200, 120];
    for (let s = 0; s <= steps; s++) for (let ww = 0; ww < 2; ww++) put(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps) + ww, col);
  }
  for (let yy = 0; yy < h; yy += 4) put(Math.round(ox + w / 2), oy + yy, [255, 70, 70]); // the edge
});
writeFileSync(tempFile("gari-snowrock.png"), encodePng({ w: PWi, h: PHi, data: img }));
console.log("\nprofiles -> temp/gari-snowrock.png (rows 1-1.5: base fillets (blue), rows 2-3: cliff-top lips (orange); red line = the snow-rock edge, snow side LEFT, 40 m span, 6x vertical exaggeration... none — 6 px/m)");
