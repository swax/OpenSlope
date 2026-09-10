// GARI build-spec parameters — measurements related to docs/authoring/064-terrain-vocabulary.md:
//  A. bank/curvature regression across ALL race lines (wall height vs turn radius)
//  B. longitudinal roller spectrum along the spine (detrended profile, wavelengths/amplitudes)
//  C. width-transition behaviour (taper rates, pinch events)
//  D. patch continuity discipline (G0 watertightness, G1 tangent agreement across shared edges)
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

// ---------------- race lines
const aip = j("AIP.json");
interface Line { name: string; pts: number[][]; dtf: number }
const race: Line[] = aip.RaceLines.map((rl: any) => {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  return { name: rl.Name, pts, dtf: rl.DistanceToFinish / 100 };
});
const SPINE_ORDER = [0, 1, 2, 3, 4, 5];

// ---------------- heightfield (same as gari-shape, adaptive tessellation)
const patches = j("Patches.json").Patches as any[];
const bez1 = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
function surfPt(P: number[][], u: number, v: number) {
  const row = (r: number, i: number) => bez1(P[r * 4]![i]!, P[r * 4 + 1]![i]!, P[r * 4 + 2]![i]!, P[r * 4 + 3]![i]!, u);
  return [0, 1, 2].map(i => bez1(row(0, i), row(1, i), row(2, i), row(3, i), v));
}
let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
for (const p of patches) if (p.Points?.length >= 16) for (const q of p.Points) {
  const x = -q[0] / 100, z = q[2] / 100;
  if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
}
const CELL = 2;
const GW = Math.ceil((mxx - mnx) / CELL) + 2, GH = Math.ceil((mxz - mnz) / CELL) + 2;
const hf = new Float32Array(GW * GH).fill(NaN);
const tf = new Int8Array(GW * GH).fill(-1);
const gi = (x: number, z: number) => [Math.round((x - mnx) / CELL), Math.round((z - mnz) / CELL)];
const RIDE = new Set([1, 3, 4, 5, 18]);
for (const p of patches) {
  if (!p.Points || p.Points.length < 16) continue;
  const P = p.Points.map((q: number[]) => [-q[0] / 100, -q[1] / 100, q[2] / 100]);
  let pmnx = 1e9, pmxx = -1e9, pmnz = 1e9, pmxz = -1e9;
  for (const q of P) { pmnx = Math.min(pmnx, q[0]!); pmxx = Math.max(pmxx, q[0]!); pmnz = Math.min(pmnz, q[2]!); pmxz = Math.max(pmxz, q[2]!); }
  const ru = Math.min(96, Math.max(6, Math.ceil((pmxx - pmnx) / CELL) + 1));
  const rv = Math.min(96, Math.max(6, Math.ceil((pmxz - pmnz) / CELL) + 1));
  for (let a = 0; a <= ru; a++) for (let b = 0; b <= rv; b++) {
    const s = surfPt(P, a / ru, b / rv);
    const [cx, cz] = gi(s[0]!, s[2]!);
    if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) continue;
    const o = cz! * GW + cx!;
    if (isNaN(hf[o]!) || s[1]! > hf[o]!) { hf[o] = s[1]!; tf[o] = p.SurfaceType; }
  }
}
const H = (x: number, z: number) => {
  const fx = (x - mnx) / CELL, fz = (z - mnz) / CELL;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const q = (xx: number, zz: number) => hf[Math.min(GH - 1, Math.max(0, zz)) * GW + Math.min(GW - 1, Math.max(0, xx))]!;
  const h00 = q(x0, z0), h10 = q(x0 + 1, z0), h01 = q(x0, z0 + 1), h11 = q(x0 + 1, z0 + 1);
  if ([h00, h10, h01, h11].some(isNaN)) return NaN;
  const tx = fx - x0, tz = fz - z0;
  return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
};
const rideAt = (x: number, z: number) => {
  const [cx, cz] = gi(x, z);
  if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) return false;
  return RIDE.has(tf[cz! * GW + cx!]!);
};

// resample a polyline to even plan spacing
function resample(pts: number[][], step: number): number[][] {
  const out: number[][] = [pts[0]!];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const l = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
    let d = carry;
    while (d <= l) { const t = d / l; out.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]); d += step; }
    carry = d - l;
  }
  return out;
}

// ================ A. bank/curvature regression over all race lines
console.log("=== A. WALLS vs TURN RADIUS (all 14 race lines, samples every 25 m) ===");
interface Samp { R: number; inWall: number; outWall: number }
const samps: Samp[] = [];
for (const L of race) {
  const sp = resample(L.pts, 25);
  for (let i = 2; i < sp.length - 2; i++) {
    const a = sp[i - 2]!, m = sp[i]!, b = sp[i + 2]!;
    const ax = a[0]! - m[0]!, az = a[2]! - m[2]!, bx = b[0]! - m[0]!, bz = b[2]! - m[2]!;
    const cross = ax * bz - az * bx;
    const d2a = ax * ax + az * az, d2b = bx * bx + bz * bz, ch = (bx - ax) ** 2 + (bz - az) ** 2;
    const curv = Math.abs(cross) < 1e-9 ? 0 : (2 * cross) / Math.sqrt(d2a * d2b * ch);
    const R = curv === 0 ? 1e9 : Math.abs(1 / curv);
    const dx = b[0]! - a[0]!, dz = b[2]! - a[2]!;
    const n = Math.hypot(dx, dz) || 1;
    const ux = -dz / n, uz = dx / n;                  // left of travel
    const inSide = curv > 0 ? 1 : -1;                  // turn center side (left if curv>0)
    const c = H(m[0]!, m[2]!);
    if (isNaN(c)) continue;
    let inW = 0, outW = 0;
    for (let s = 4; s <= 60; s += 4) {
      const hi = H(m[0]! + ux * s * inSide, m[2]! + uz * s * inSide);
      const ho = H(m[0]! - ux * s * inSide, m[2]! - uz * s * inSide);
      if (!isNaN(hi)) inW = Math.max(inW, hi - c);
      if (!isNaN(ho)) outW = Math.max(outW, ho - c);
    }
    samps.push({ R, inWall: inW, outWall: outW });
  }
}
const bins: [string, (r: number) => boolean][] = [
  ["R<40", r => r < 40], ["40-80", r => r >= 40 && r < 80], ["80-150", r => r >= 80 && r < 150],
  ["150-300", r => r >= 150 && r < 300], ["straight", r => r >= 300]];
console.log("radius-bin   n    inside med/p75   outside med/p75   anyWall med/p75   walled% (any>8m)");
for (const [name, f] of bins) {
  const g = samps.filter(s => f(s.R));
  if (!g.length) continue;
  const iw = g.map(s => s.inWall).sort((a, b) => a - b), ow = g.map(s => s.outWall).sort((a, b) => a - b);
  const aw = g.map(s => Math.max(s.inWall, s.outWall)).sort((a, b) => a - b);
  const med = (a: number[]) => a[Math.floor(a.length / 2)]!.toFixed(1);
  const p75 = (a: number[]) => a[Math.floor(a.length * .75)]!.toFixed(1);
  console.log(`${name.padEnd(10)} ${String(g.length).padStart(4)}   ${med(iw)}/${p75(iw)}        ${med(ow)}/${p75(ow)}         ${med(aw)}/${p75(aw)}          ${(100 * g.filter(s => Math.max(s.inWall, s.outWall) > 8).length / g.length).toFixed(0)}%`);
}

// ================ B. roller spectrum along the spine
console.log("\n=== B. ROLLER SPECTRUM (terrain height under the spine, 5 m sampling) ===");
const spinePts: number[][] = [];
for (const li of SPINE_ORDER) {
  const pts = race[li]!.pts;
  for (const p of pts) {
    if (spinePts.length && Math.hypot(p[0]! - spinePts[spinePts.length - 1]![0]!, p[2]! - spinePts[spinePts.length - 1]![2]!) < 5) continue;
    spinePts.push(p);
  }
}
const sp5 = resample(spinePts, 5);
const prof: number[] = sp5.map(p => { const h = H(p[0]!, p[2]!); return isNaN(h) ? p[1]! : h; }); // terrain under line, fallback line alt
// detrend: subtract 300 m moving average
const WIN = 12; // 12 samples = 60 m half window (roller scale; terraces stay in the trend)
const resid: number[] = prof.map((_, i) => {
  let s = 0, n = 0;
  for (let k = Math.max(0, i - WIN); k <= Math.min(prof.length - 1, i + WIN); k++) { s += prof[k]!; n++; }
  return prof[i]! - s / n;
});
const rms = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / resid.length);
// crest-to-crest: local maxima of residual above 0.5 m
const crests: number[] = [];
for (let i = 2; i < resid.length - 2; i++)
  if (resid[i]! > 0.5 && resid[i]! >= resid[i - 1]! && resid[i]! >= resid[i + 1]! && resid[i]! > resid[i - 2]! && resid[i]! > resid[i + 2]!) crests.push(i * 5);
const gaps = crests.slice(1).map((c, i) => c - crests[i]!).filter(g => g > 15 && g < 500).sort((a, b) => a - b);
const heights = crests.map(c => resid[Math.round(c / 5)]!).sort((a, b) => a - b);
console.log(`spine ridden ${(sp5.length * 5 / 1000).toFixed(2)} km; detrended RMS ${rms.toFixed(1)} m`);
console.log(`crests >0.5 m: ${crests.length}; crest spacing med ${gaps[Math.floor(gaps.length / 2)]} m (p25 ${gaps[Math.floor(gaps.length * .25)]}, p75 ${gaps[Math.floor(gaps.length * .75)]}); crest height med ${heights[Math.floor(heights.length / 2)]?.toFixed(1)} m, max ${heights[heights.length - 1]?.toFixed(1)} m`);
// convex/concave vertical curvature stats (kickers vs compressions), 25 m chord
let kick = 0, comp = 0;
const vc: number[] = [];
for (let i = 5; i < prof.length - 5; i++) {
  const c2 = (prof[i + 5]! - 2 * prof[i]! + prof[i - 5]!) / (25 * 25); // 1/m
  vc.push(c2);
  if (c2 < -0.008) kick++; else if (c2 > 0.008) comp++;
}
console.log(`vertical curvature: ${kick} kicker samples (<-0.008/m ≈ crest R<125 m), ${comp} compression samples — ${(100 * kick / vc.length).toFixed(1)}% / ${(100 * comp / vc.length).toFixed(1)}% of spine`);

// ================ C. width transitions along spine
console.log("\n=== C. WIDTH TRANSITIONS (rideable width every 25 m along spine) ===");
const sp25 = resample(spinePts, 25);
const widths: number[] = [];
for (let i = 1; i < sp25.length - 1; i++) {
  const a = sp25[i - 1]!, b = sp25[i + 1]!, m = sp25[i]!;
  const dx = b[0]! - a[0]!, dz = b[2]! - a[2]!;
  const n = Math.hypot(dx, dz) || 1;
  const ux = -dz / n, uz = dx / n;
  let l = 0, r = 0;
  for (let s = 2; s <= 250; s += 2) { if (rideAt(m[0]! + ux * s, m[2]! + uz * s)) l = s; else if (s - l > 30) break; }
  for (let s = 2; s <= 250; s += 2) { if (rideAt(m[0]! - ux * s, m[2]! - uz * s)) r = s; else if (s - r > 30) break; }
  widths.push(l + r);
}
const dw = widths.slice(1).map((w, i) => Math.abs(w - widths[i]!) / 25 * 100); // m width change per 100 m
dw.sort((a, b) => a - b);
console.log(`|dW/ds|: med ${dw[Math.floor(dw.length / 2)]?.toFixed(0)} m per 100 m, p90 ${dw[Math.floor(dw.length * .9)]?.toFixed(0)}, max ${dw[dw.length - 1]?.toFixed(0)}`);
// pinch events: local minima under 70 m
const pinches: string[] = [];
for (let i = 2; i < widths.length - 2; i++)
  if (widths[i]! < 70 && widths[i]! <= widths[i - 1]! && widths[i]! <= widths[i + 1]!) {
    // taper: width 200 m before
    const before = widths[Math.max(0, i - 8)]!;
    pinches.push(`@${(i * 25 / 1000).toFixed(2)}km w=${widths[i]!.toFixed(0)}m (from ${before.toFixed(0)}m -> taper ${((before - widths[i]!) / 200 * 100).toFixed(0)}m/100m)`);
    i += 4;
  }
console.log(`pinches (<70 m): ${pinches.length}`);
for (const p of pinches) console.log("  " + p);

// ================ D. patch continuity (G0 watertight + G1 tangents)
console.log("\n=== D. PATCH CONTINUITY ===");
// edges of the 4x4 grid: rows u (v=0: 0..3, v=3: 12..15), cols (u=0: 0,4,8,12; u=3: 3,7,11,15)
const EDGES = [
  { idx: [0, 1, 2, 3], inner: [4, 5, 6, 7] },
  { idx: [12, 13, 14, 15], inner: [8, 9, 10, 11] },
  { idx: [0, 4, 8, 12], inner: [1, 5, 9, 13] },
  { idx: [3, 7, 11, 15], inner: [2, 6, 10, 14] },
];
const snap = (q: number[]) => `${Math.round(q[0]! / 2)},${Math.round(q[1]! / 2)},${Math.round(q[2]! / 2)}`; // 2 cm snap in raw units
const edgeMap = new Map<string, { pi: number; e: number }[]>();
const valid = patches.filter(p => p.Points?.length >= 16);
valid.forEach((p, pi) => {
  EDGES.forEach((E, e) => {
    const ks = E.idx.map(i => snap(p.Points[i]));
    const k = [...ks].sort().join("|");
    if (!edgeMap.has(k)) edgeMap.set(k, []);
    edgeMap.get(k)!.push({ pi, e });
  });
});
let sharedEdges = 0, g1Edges = 0;
const angSum: number[] = [];
for (const arr of edgeMap.values()) {
  if (arr.length < 2) continue;
  sharedEdges++;
  const [A, B] = [arr[0]!, arr[1]!];
  const pa = valid[A.pi]!.Points, pb = valid[B.pi]!.Points;
  const Ea = EDGES[A.e]!, Eb = EDGES[B.e]!;
  // match Eb's order to Ea's (forward or reversed)
  const fwd = snap(pb[Eb.idx[0]!]) === snap(pa[Ea.idx[0]!]);
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const kb = fwd ? k : 3 - k;
    const e = pa[Ea.idx[k]!]!;
    const ta = [0, 1, 2].map(i => e[i]! - pa[Ea.inner[k]!]![i]!);          // inward->edge of A
    const tb = [0, 1, 2].map(i => pb[Eb.inner[kb]!]![i]! - pb[Eb.idx[kb]!]![i]!); // edge->inward of B
    const na = Math.hypot(...ta), nb = Math.hypot(...tb);
    if (na < 1e-3 || nb < 1e-3) continue;
    const dot = (ta[0]! * tb[0]! + ta[1]! * tb[1]! + ta[2]! * tb[2]!) / (na * nb);
    const ang = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    worst = Math.max(worst, ang);
  }
  angSum.push(worst);
  if (worst < 10) g1Edges++;
}
angSum.sort((a, b) => a - b);
console.log(`shared (watertight G0) edges: ${sharedEdges} (of ${valid.length} patches; ~${(sharedEdges * 2 / valid.length).toFixed(1)} shared edges/patch)`);
console.log(`G1 check (worst tangent kink across edge): med ${angSum[Math.floor(angSum.length / 2)]?.toFixed(1)}°, p75 ${angSum[Math.floor(angSum.length * .75)]?.toFixed(1)}°, p90 ${angSum[Math.floor(angSum.length * .9)]?.toFixed(1)}°; <10° on ${(100 * g1Edges / sharedEdges).toFixed(0)}% of edges`);

// ================ figure: rhythm strip (detrended profile + width + grade over spine distance)
const PW = 2200, PH = 900;
const img = Buffer.alloc(PW * PH * 4);
for (let i = 0; i < PW * PH; i++) { img[i * 4] = 24; img[i * 4 + 1] = 26; img[i * 4 + 2] = 34; img[i * 4 + 3] = 255; }
const put = (x: number, y: number, c: number[]) => { if (x >= 0 && y >= 0 && x < PW && y < PH) { const o = (y * PW + x) * 4; img[o] = c[0]!; img[o + 1] = c[1]!; img[o + 2] = c[2]!; } };
const X = (i: number, n: number) => 30 + (i / n) * (PW - 60);
const seg = (x0: number, y0: number, x1: number, y1: number, c: number[], yMin: number, yMax: number) => {
  y0 = Math.min(yMax, Math.max(yMin, y0)); y1 = Math.min(yMax, Math.max(yMin, y1));
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let s = 0; s <= steps; s++) for (let w = 0; w < 2; w++)
    put(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps) + w, c);
};
// panel 1 (top): detrended rollers (clamped ±15 m), band 30..270
for (let i = 1; i < resid.length; i++)
  seg(X(i - 1, resid.length), 150 - resid[i - 1]! * 8, X(i, resid.length), 150 - resid[i]! * 8, [120, 200, 255], 30, 270);
for (let x = 30; x < PW - 30; x += 4) put(x, 150, [70, 74, 90]);
// panel 2 (middle): grade % (100 m window), band 330..600
for (let i = 11; i < prof.length - 10; i++) {
  const g0 = (prof[i - 11]! - prof[i + 9]!) / 100, g1 = (prof[i - 10]! - prof[i + 10]!) / 100;
  const col = g1 > 0.9 ? [255, 80, 80] : g1 > 0.5 ? [255, 170, 70] : g1 > 0.15 ? [130, 220, 130] : [110, 170, 255];
  seg(X(i - 1, prof.length), 580 - g0 * 250, X(i, prof.length), 580 - g1 * 250, col, 330, 610);
}
for (const gl of [0, 0.5, 1.0]) for (let x = 30; x < PW - 30; x += 4) put(x, Math.round(580 - gl * 250), [70, 74, 90]);
// panel 3 (bottom): width, band 650..880
for (let i = 1; i < widths.length; i++) {
  const col = widths[i]! < 70 ? [255, 90, 90] : [180, 180, 200];
  seg(X(i - 1, widths.length), 870 - widths[i - 1]! * 0.6, X(i, widths.length), 870 - widths[i]! * 0.6, col, 650, 880);
}
for (const wl of [0, 100, 200, 300]) for (let x = 30; x < PW - 30; x += 4) put(x, Math.round(870 - wl * 0.6), [70, 74, 90]);
// km ticks
for (let km = 0; km * 1000 / 5 < prof.length; km++) for (let y = 30; y < PH - 10; y += 6) put(Math.round(X(km * 200, prof.length)), y, [56, 60, 76]);
writeFileSync(tempFile("gari-rhythm.png"), encodePng({ w: PW, h: PH, data: img }));
console.log("\nrhythm strip -> temp/gari-rhythm.png (top: rollers ±, mid: grade 0/50/100% lines, bottom: width 0..300 m; ticks = 1 km)");
