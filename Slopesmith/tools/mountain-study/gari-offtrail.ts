// GARI off-trail / freeride layer study:
//  A. rideable area by distance-from-nearest-authored-line (race vs any path)
//  B. parallel-lane count along the course (perpendicular slices, full width)
//  C. cliff bands: detection, heights, powder landings
//  D. powder field structure (connected components)
// Renders an "exploration map": distance-heat + cliffs + paths.
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

// ---------------- paths
interface Line { name: string; kind: string; pts: number[][] }
const lines: Line[] = [];
const seen = new Set<string>();
for (const file of ["AIP.json", "SOP.json"]) {
  const pf = j(file);
  const bake = (e: any, kind: string) => {
    if (!e.PathPoints || e.PathPoints.length < 2) return;
    let [ax, ay, az] = e.PathPos ?? [0, 0, 0];
    const pts: number[][] = [];
    for (const p of e.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
    const sig = `${e.Name}|${Math.round(pts[0]![0]!)},${Math.round(pts[0]![2]!)}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    lines.push({ name: e.Name, kind, pts });
  };
  for (const rl of pf.RaceLines ?? []) bake(rl, "race");
  for (const ap of pf.AIPaths ?? []) bake(ap, "ai");
}
const raceIdx = j("AIP.json").RaceLines.map((r: any) => r.Name);

// ---------------- heightfield + type field
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
const CELL = 4; // 4 m cells — whole-mountain pass
const GW = Math.ceil((mxx - mnx) / CELL) + 2, GH = Math.ceil((mxz - mnz) / CELL) + 2;
const hf = new Float32Array(GW * GH).fill(NaN);
const tf = new Int8Array(GW * GH).fill(-1);
const gi = (x: number, z: number) => [Math.round((x - mnx) / CELL), Math.round((z - mnz) / CELL)];
for (const p of patches) {
  if (!p.Points || p.Points.length < 16) continue;
  const P = p.Points.map((q: number[]) => [-q[0] / 100, -q[1] / 100, q[2] / 100]);
  let pmnx = 1e9, pmxx = -1e9, pmnz = 1e9, pmxz = -1e9;
  for (const q of P) { pmnx = Math.min(pmnx, q[0]!); pmxx = Math.max(pmxx, q[0]!); pmnz = Math.min(pmnz, q[2]!); pmxz = Math.max(pmxz, q[2]!); }
  const ru = Math.min(64, Math.max(6, Math.ceil((pmxx - pmnx) / CELL) + 1));
  const rv = Math.min(64, Math.max(6, Math.ceil((pmxz - pmnz) / CELL) + 1));
  for (let a = 0; a <= ru; a++) for (let b = 0; b <= rv; b++) {
    const s = surfPt(P, a / ru, b / rv);
    const [cx, cz] = gi(s[0]!, s[2]!);
    if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) continue;
    const o = cz! * GW + cx!;
    if (isNaN(hf[o]!) || s[1]! > hf[o]!) { hf[o] = s[1]!; tf[o] = p.SurfaceType; }
  }
}
const RIDE = new Set([1, 3, 4, 5, 18]);
const rideMask = new Uint8Array(GW * GH);
for (let o = 0; o < GW * GH; o++) rideMask[o] = RIDE.has(tf[o]!) ? 1 : 0;

// ---------------- A. distance transform from paths (chamfer 3-4)
function distanceFrom(kindFilter: (L: Line) => boolean): Float32Array {
  const D = new Float32Array(GW * GH).fill(1e9);
  for (const L of lines) {
    if (!kindFilter(L)) continue;
    for (let i = 1; i < L.pts.length; i++) {
      const a = L.pts[i - 1]!, b = L.pts[i]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!) / CELL));
      for (let s = 0; s <= steps; s++) {
        const x = a[0]! + ((b[0]! - a[0]!) * s) / steps, z = a[2]! + ((b[2]! - a[2]!) * s) / steps;
        const [cx, cz] = gi(x, z);
        if (cx! >= 0 && cz! >= 0 && cx! < GW && cz! < GH) D[cz! * GW + cx!] = 0;
      }
    }
  }
  // two-pass chamfer
  const C1 = CELL, C2 = CELL * 1.4142;
  for (let z = 1; z < GH; z++) for (let x = 1; x < GW; x++) {
    const o = z * GW + x;
    D[o] = Math.min(D[o]!, D[o - 1]! + C1, D[o - GW]! + C1, D[o - GW - 1]! + C2, x + 1 < GW ? D[o - GW + 1]! + C2 : 1e9);
  }
  for (let z = GH - 2; z >= 0; z--) for (let x = GW - 2; x >= 0; x--) {
    const o = z * GW + x;
    D[o] = Math.min(D[o]!, D[o + 1]! + C1, D[o + GW]! + C1, D[o + GW + 1]! + C2, x > 0 ? D[o + GW - 1]! + C2 : 1e9);
  }
  return D;
}
const dRace = distanceFrom(L => L.kind === "race" && raceIdx.includes(L.name));
const dAny = distanceFrom(() => true);
const cellHa = (CELL * CELL) / 1e4;
const bandsDef: [string, number, number][] = [["on-line <25m", 0, 25], ["fringe 25-75m", 25, 75], ["off-trail 75-150m", 75, 150], ["deep >150m", 150, 1e9]];
console.log("=== A. RIDEABLE AREA vs DISTANCE FROM AUTHORED LINES ===");
console.log("band                from RACE lines    from ANY path (incl. AI/respawn)");
for (const [name, lo, hi] of bandsDef) {
  let aR = 0, aA = 0;
  for (let o = 0; o < GW * GH; o++) {
    if (!rideMask[o]) continue;
    if (dRace[o]! >= lo && dRace[o]! < hi) aR += cellHa;
    if (dAny[o]! >= lo && dAny[o]! < hi) aA += cellHa;
  }
  console.log(`${name.padEnd(20)} ${aR.toFixed(1).padStart(7)} ha          ${aA.toFixed(1).padStart(7)} ha`);
}

// ---------------- B. parallel lanes along the course
const aip = j("AIP.json");
const race: number[][][] = aip.RaceLines.map((rl: any) => {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  return pts;
});
const spinePts: number[][] = [];
for (const li of [0, 1, 2, 3, 4, 5]) for (const p of race[li]!) {
  if (spinePts.length && Math.hypot(p[0]! - spinePts[spinePts.length - 1]![0]!, p[2]! - spinePts[spinePts.length - 1]![2]!) < 5) continue;
  spinePts.push(p);
}
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
const sp50 = resample(spinePts, 50);
const rideAt = (x: number, z: number) => {
  const [cx, cz] = gi(x, z);
  if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) return false;
  return rideMask[cz! * GW + cx!] === 1;
};
const hAt = (x: number, z: number) => {
  const [cx, cz] = gi(x, z);
  if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) return NaN;
  return hf[cz! * GW + cx!]!;
};
console.log("\n=== B. PARALLEL LANES (slices every 50 m, scan ±450 m, lane = rideable run ≥12 m) ===");
const laneCounts: number[] = [];
const laneSeps: number[] = [];
const laneVSeps: number[] = [];
for (let i = 1; i < sp50.length - 1; i++) {
  const a = sp50[i - 1]!, b = sp50[i + 1]!, m = sp50[i]!;
  const dx = b[0]! - a[0]!, dz = b[2]! - a[2]!;
  const n = Math.hypot(dx, dz) || 1;
  const ux = -dz / n, uz = dx / n;
  // runs across the full scan
  const runs: [number, number][] = [];
  let runStart: number | null = null;
  for (let s = -450; s <= 450; s += 4) {
    const r = rideAt(m[0]! + ux * s, m[2]! + uz * s);
    if (r && runStart === null) runStart = s;
    if (!r && runStart !== null) { if (s - runStart >= 12) runs.push([runStart, s]); runStart = null; }
  }
  if (runStart !== null && 450 - runStart >= 12) runs.push([runStart, 450]);
  laneCounts.push(runs.length);
  for (let k = 1; k < runs.length; k++) {
    const gap = runs[k]![0]! - runs[k - 1]![1]!;
    laneSeps.push(gap);
    const h0 = hAt(m[0]! + ux * ((runs[k - 1]![0]! + runs[k - 1]![1]!) / 2), m[2]! + uz * ((runs[k - 1]![0]! + runs[k - 1]![1]!) / 2));
    const h1 = hAt(m[0]! + ux * ((runs[k]![0]! + runs[k]![1]!) / 2), m[2]! + uz * ((runs[k]![0]! + runs[k]![1]!) / 2));
    if (!isNaN(h0) && !isNaN(h1)) laneVSeps.push(Math.abs(h1 - h0));
  }
}
const lh: Record<number, number> = {};
for (const c of laneCounts) lh[c] = (lh[c] ?? 0) + 1;
console.log("lane-count histogram (slices):", Object.entries(lh).map(([k, v]) => `${k}:${v}`).join("  "));
console.log(`>=2 lanes on ${(100 * laneCounts.filter(c => c >= 2).length / laneCounts.length).toFixed(0)}% of slices; >=3 on ${(100 * laneCounts.filter(c => c >= 3).length / laneCounts.length).toFixed(0)}%`);
laneSeps.sort((a, b) => a - b); laneVSeps.sort((a, b) => a - b);
console.log(`lane separation (unrideable gap): med ${laneSeps[Math.floor(laneSeps.length / 2)]} m, p75 ${laneSeps[Math.floor(laneSeps.length * .75)]} m`);
console.log(`vertical offset between adjacent lanes: med ${laneVSeps[Math.floor(laneVSeps.length / 2)]?.toFixed(0)} m, p75 ${laneVSeps[Math.floor(laneVSeps.length * .75)]?.toFixed(0)} m`);

// ---------------- C. cliffs
console.log("\n=== C. CLIFF BANDS (slope >55° over 8 m baseline, clustered) ===");
const cliff = new Uint8Array(GW * GH);
const TAN55 = Math.tan((55 * Math.PI) / 180);
for (let z = 2; z < GH - 2; z++) for (let x = 2; x < GW - 2; x++) {
  const o = z * GW + x;
  if (isNaN(hf[o]!)) continue;
  const gx = (hf[o + 2]! - hf[o - 2]!) / (4 * CELL), gz = (hf[o + 2 * GW]! - hf[o - 2 * GW]!) / (4 * CELL);
  if (isNaN(gx) || isNaN(gz)) continue;
  if (Math.hypot(gx, gz) > TAN55) cliff[o] = 1;
}
// cluster via BFS
const comp = new Int32Array(GW * GH).fill(-1);
interface Cliff { id: number; cells: number; top: number; bot: number; cx: number; cz: number; powderLanding: boolean }
const cliffs: Cliff[] = [];
let cid = 0;
const stack: number[] = [];
for (let o0 = 0; o0 < GW * GH; o0++) {
  if (!cliff[o0] || comp[o0] !== -1) continue;
  let cells = 0, top = -1e9, bot = 1e9, sx = 0, sz = 0;
  stack.push(o0); comp[o0] = cid;
  let botCell = o0;
  while (stack.length) {
    const o = stack.pop()!;
    cells++;
    const h = hf[o]!;
    if (h > top) top = h;
    if (h < bot) { bot = h; botCell = o; }
    sx += o % GW; sz += Math.floor(o / GW);
    for (const d of [-1, 1, -GW, GW, -GW - 1, -GW + 1, GW - 1, GW + 1]) {
      const o2 = o + d;
      if (o2 >= 0 && o2 < GW * GH && cliff[o2] && comp[o2] === -1) { comp[o2] = cid; stack.push(o2); }
    }
  }
  // powder landing: look downhill of the lowest cliff cell, 10-40 m out, any type 3/4?
  const bx = (botCell % GW) * 1, bz = Math.floor(botCell / GW);
  let powder = false;
  for (let dz2 = -10; dz2 <= 10 && !powder; dz2++) for (let dx2 = -10; dx2 <= 10 && !powder; dx2++) {
    const o2 = (bz + dz2) * GW + (bx + dx2);
    if (o2 < 0 || o2 >= GW * GH) continue;
    if ((tf[o2] === 3 || tf[o2] === 4) && hf[o2]! < bot + 4) powder = true;
  }
  cliffs.push({ id: cid, cells, top, bot, cx: mnx + (sx / cells) * CELL, cz: mnz + (sz / cells) * CELL, powderLanding: powder });
  cid++;
}
const big = cliffs.filter(c => c.top - c.bot >= 10).sort((a, b) => (b.top - b.bot) - (a.top - a.bot));
console.log(`cliff clusters: ${cliffs.length} total; ${big.length} with ≥10 m relief; powder landing on ${(100 * big.filter(c => c.powderLanding).length / Math.max(1, big.length)).toFixed(0)}% of those`);
console.log("top 12 by relief:");
for (const c of big.slice(0, 12))
  console.log(`  relief ${(c.top - c.bot).toFixed(0).padStart(3)} m  at (${c.cx.toFixed(0)}, ${c.cz.toFixed(0)})  cells ${c.cells}  powder-landing ${c.powderLanding}`);

// ---------------- D. powder fields
console.log("\n=== D. POWDER FIELDS (connected type-3/4 regions) ===");
const pcomp = new Int32Array(GW * GH).fill(-1);
const fields: { cells: number; dMed: number }[] = [];
let pid = 0;
for (let o0 = 0; o0 < GW * GH; o0++) {
  if ((tf[o0] !== 3 && tf[o0] !== 4) || pcomp[o0] !== -1) continue;
  let cells = 0;
  const ds: number[] = [];
  stack.push(o0); pcomp[o0] = pid;
  while (stack.length) {
    const o = stack.pop()!;
    cells++;
    if (cells % 7 === 0) ds.push(dRace[o]!);
    for (const d of [-1, 1, -GW, GW]) {
      const o2 = o + d;
      if (o2 >= 0 && o2 < GW * GH && (tf[o2] === 3 || tf[o2] === 4) && pcomp[o2] === -1) { pcomp[o2] = pid; stack.push(o2); }
    }
  }
  ds.sort((a, b) => a - b);
  fields.push({ cells, dMed: ds[Math.floor(ds.length / 2)] ?? 0 });
  pid++;
}
fields.sort((a, b) => b.cells - a.cells);
console.log(`fields: ${fields.length}; top 10 by area (ha, median dist from race line):`);
for (const f of fields.slice(0, 10)) console.log(`  ${(f.cells * cellHa).toFixed(1).padStart(6)} ha   d=${f.dMed.toFixed(0)} m`);

// ---------------- exploration map
const SC = 0.5; // px per metre
const PW = Math.ceil((mxx - mnx) * SC), PH = Math.ceil((mxz - mnz) * SC);
const img = Buffer.alloc(PW * PH * 4);
for (let py = 0; py < PH; py++) for (let px = 0; px < PW; px++) {
  const x = mnx + px / SC, z = mxz - py / SC;
  const [cx, cz] = gi(x, z);
  const o = cz! * GW + cx!;
  const io = (py * PW + px) * 4;
  img[io + 3] = 255;
  if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH || isNaN(hf[o]!)) { img[io] = 18; img[io + 1] = 20; img[io + 2] = 28; continue; }
  if (cliff[o]) { img[io] = 255; img[io + 1] = 60; img[io + 2] = 60; continue; }
  if (!rideMask[o]) { img[io] = 60; img[io + 1] = 62; img[io + 2] = 76; continue; }
  // heat by distance from race line: white (on) -> green -> blue -> purple (deep)
  const d = dRace[o]!;
  const c = d < 25 ? [245, 245, 250] : d < 75 ? [140, 220, 150] : d < 150 ? [90, 150, 240] : [170, 90, 220];
  img[io] = c[0]!; img[io + 1] = c[1]!; img[io + 2] = c[2]!;
}
// race lines in red on top
for (const L of lines) {
  if (L.kind !== "race") continue;
  for (let i = 1; i < L.pts.length; i++) {
    const a = L.pts[i - 1]!, b = L.pts[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!) * SC));
    for (let s = 0; s <= steps; s++) {
      const px = Math.round((a[0]! + ((b[0]! - a[0]!) * s) / steps - mnx) * SC);
      const py = Math.round((mxz - (a[2]! + ((b[2]! - a[2]!) * s) / steps)) * SC);
      if (px >= 0 && py >= 0 && px < PW && py < PH) { const io = (py * PW + px) * 4; img[io] = 220; img[io + 1] = 30; img[io + 2] = 30; }
    }
  }
}
writeFileSync(tempFile("gari-explore.png"), encodePng({ w: PW, h: PH, data: img }));
console.log(`\nexploration map -> temp/gari-explore.png (${PW}x${PH}; white=on-line, green=fringe, blue=off-trail, purple=deep, red dots=cliffs, grey=unrideable)`);
