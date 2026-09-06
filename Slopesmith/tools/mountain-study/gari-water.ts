// GARI water study: river/waterfall system (type-5 patches with water textures) and
// how race lines criss-cross it. Per-cluster anatomy + crossing events + zoom render.
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
const patches = (j("Patches.json").Patches as any[]).filter(p => p.Points?.length >= 16);

const M = (q: number[]) => [-q[0]! / 100, -q[1]! / 100, q[2]! / 100];
const bez1 = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
function surfPt(P: number[][], u: number, v: number) {
  const row = (r: number, i: number) => bez1(P[r * 4]![i]!, P[r * 4 + 1]![i]!, P[r * 4 + 2]![i]!, P[r * 4 + 3]![i]!, u);
  return [0, 1, 2].map(i => bez1(row(0, i), row(1, i), row(2, i), row(3, i), v));
}

// which type-5 textures are water vs ice? classify every type-5 patch by texture and report
const t5tex = new Map<string, { n: number; minY: number; maxY: number }>();
for (const p of patches) {
  if (p.SurfaceType !== 5) continue;
  const e = t5tex.get(p.TexturePath) ?? { n: 0, minY: 1e9, maxY: -1e9 };
  e.n++;
  for (const q of p.Points) { const y = -q[1]! / 100; if (y < e.minY) e.minY = y; if (y > e.maxY) e.maxY = y; }
  t5tex.set(p.TexturePath, e);
}
console.log("type-5 textures (n, alt range):", [...t5tex.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k}:${v.n} [${v.minY.toFixed(0)}..${v.maxY.toFixed(0)}]`).join("  "));

// water set: the blue/foam family (visually identified)
const WATER_TEX = new Set(["0093.png", "0094.png", "0095.png", "0022.png", "0023.png", "0024.png", "0025.png", "0026.png", "0027.png", "0035.png", "0036.png", "0037.png", "0085.png", "0097.png", "0109.png", "0110.png", "0111.png"]);
const water = patches.filter(p => p.SurfaceType === 5 && WATER_TEX.has(p.TexturePath));
console.log(`water-textured type-5 patches: ${water.length}`);

// per-patch: centroid + mean slope (analytic at center via finite diff of surfPt)
interface WP { cx: number; cy: number; cz: number; slope: number; tex: string }
const wps: WP[] = water.map(p => {
  const P = p.Points.map(M);
  const c = surfPt(P, 0.5, 0.5);
  const du = surfPt(P, 0.62, 0.5), dv = surfPt(P, 0.5, 0.62);
  const g1 = Math.abs(du[1]! - c[1]!) / (Math.hypot(du[0]! - c[0]!, du[2]! - c[2]!) || 1);
  const g2 = Math.abs(dv[1]! - c[1]!) / (Math.hypot(dv[0]! - c[0]!, dv[2]! - c[2]!) || 1);
  return { cx: c[0]!, cy: c[1]!, cz: c[2]!, slope: (Math.atan(Math.max(g1, g2)) * 180) / Math.PI, tex: p.TexturePath };
});
// cluster (<50 m)
const comp = wps.map(() => -1);
let cid = 0;
for (let i = 0; i < wps.length; i++) {
  if (comp[i] !== -1) continue;
  const st = [i];
  comp[i] = cid;
  while (st.length) {
    const a = st.pop()!;
    for (let b = 0; b < wps.length; b++) {
      if (comp[b] !== -1) continue;
      if (Math.hypot(wps[a]!.cx - wps[b]!.cx, wps[a]!.cz - wps[b]!.cz) < 50) { comp[b] = cid; st.push(b); }
    }
  }
  cid++;
}
const clusters = new Map<number, WP[]>();
wps.forEach((w, i) => { if (!clusters.has(comp[i]!)) clusters.set(comp[i]!, []); clusters.get(comp[i]!)!.push(w); });
console.log("\n=== WATER CLUSTERS ===");
const sorted = [...clusters.values()].sort((a, b) => b.length - a.length);
for (const C of sorted.slice(0, 6)) {
  const xs = C.map(w => w.cx), zs = C.map(w => w.cz), ys = C.map(w => w.cy);
  const falls = C.filter(w => w.slope > 40).length;
  console.log(`n=${String(C.length).padStart(3)} centroid(${(xs.reduce((a, b) => a + b) / C.length).toFixed(0)},${(zs.reduce((a, b) => a + b) / C.length).toFixed(0)}) alt ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} extent ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)}x${(Math.max(...zs) - Math.min(...zs)).toFixed(0)}m waterfall-patches(>40°) ${falls}`);
}

// rasterize water + all terrain in a window around the biggest cluster for crossings + render
const C0 = sorted[0]!;
const WX0 = Math.min(...C0.map(w => w.cx)) - 80, WX1 = Math.max(...C0.map(w => w.cx)) + 80;
const WZ0 = Math.min(...C0.map(w => w.cz)) - 80, WZ1 = Math.max(...C0.map(w => w.cz)) + 80;
const CELL = 1;
const GW = Math.ceil((WX1 - WX0) / CELL) + 2, GH = Math.ceil((WZ1 - WZ0) / CELL) + 2;
const hf = new Float32Array(GW * GH).fill(NaN);
const wf = new Float32Array(GW * GH).fill(NaN); // water surface height
const tf = new Int8Array(GW * GH).fill(-1);
const gi = (x: number, z: number) => [Math.round((x - WX0) / CELL), Math.round((z - WZ0) / CELL)];
for (const p of patches) {
  const P = p.Points.map(M);
  let a1 = 1e9, a2 = -1e9, b1 = 1e9, b2 = -1e9;
  for (const q of P) { a1 = Math.min(a1, q[0]!); a2 = Math.max(a2, q[0]!); b1 = Math.min(b1, q[2]!); b2 = Math.max(b2, q[2]!); }
  if (a2 < WX0 || a1 > WX1 || b2 < WZ0 || b1 > WZ1) continue;
  const isWater = p.SurfaceType === 5 && WATER_TEX.has(p.TexturePath);
  const ru = Math.min(128, Math.max(8, Math.ceil((a2 - a1) / CELL) + 1));
  const rv = Math.min(128, Math.max(8, Math.ceil((b2 - b1) / CELL) + 1));
  for (let a = 0; a <= ru; a++) for (let b = 0; b <= rv; b++) {
    const s = surfPt(P, a / ru, b / rv);
    const [cx, cz] = gi(s[0]!, s[2]!);
    if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) continue;
    const o = cz! * GW + cx!;
    if (isNaN(hf[o]!) || s[1]! > hf[o]!) { hf[o] = s[1]!; tf[o] = isWater ? 99 : p.SurfaceType; }
    if (isWater && (isNaN(wf[o]!) || s[1]! > wf[o]!)) wf[o] = s[1]!;
  }
}
const H = (F: Float32Array, x: number, z: number) => { const [cx, cz] = gi(x, z); if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) return NaN; return F[cz! * GW + cx!]!; };

// race line crossings over the water
const aip = j("AIP.json");
console.log("\n=== RACE-LINE CROSSINGS over the main water system ===");
for (const rl of aip.RaceLines) {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  // resample 3 m
  const sp: number[][] = [pts[0]!];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const l = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
    let d = carry;
    while (d <= l) { const t = d / l; sp.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]); d += 3; }
    carry = d - l;
  }
  let on = -1;
  for (let i = 0; i < sp.length; i++) {
    const w = H(wf, sp[i]![0]!, sp[i]![2]!);
    const over = !isNaN(w);
    if (over && on < 0) on = i;
    if ((!over || i === sp.length - 1) && on >= 0) {
      const len = (i - on) * 3;
      if (len >= 6) {
        const mid = sp[Math.floor((on + i) / 2)]!;
        const wAlt = H(wf, mid[0]!, mid[2]!);
        const clear = mid[1]! - wAlt;
        console.log(`${rl.Name.padEnd(13)} crosses ${len.toFixed(0).padStart(4)} m of water @(${mid[0]!.toFixed(0)},${mid[2]!.toFixed(0)})  line-alt-above-water ${isNaN(clear) ? "?" : clear.toFixed(1)} m`);
      }
      on = -1;
    }
  }
}

// waterfall profile down the river: altitude of water cells vs north-south position
const wAlts: { z: number; y: number }[] = [];
for (let z = 0; z < GH; z += 3) for (let x = 0; x < GW; x += 3) { const o = z * GW + x; if (!isNaN(wf[o]!)) wAlts.push({ z: WZ0 + z * CELL, y: wf[o]! }); }
wAlts.sort((a, b) => b.z - a.z);
console.log(`\nriver altitude span: ${Math.min(...wAlts.map(w => w.y)).toFixed(0)}..${Math.max(...wAlts.map(w => w.y)).toFixed(0)} m over ${(WZ1 - WZ0).toFixed(0)} m of canyon`);

// render
const SC = 2.5;
const PW = Math.ceil((WX1 - WX0) * SC), PH = Math.ceil((WZ1 - WZ0) * SC);
const img = Buffer.alloc(PW * PH * 4);
const light = [-0.5, 0.7, -0.5];
const ln = Math.hypot(...light);
const TINT: Record<number, number[]> = { 1: [240, 244, 252], 3: [205, 220, 244], 4: [180, 190, 235], 5: [140, 230, 240], 9: [165, 130, 100], 10: [110, 110, 110], 18: [250, 180, 90], 0: [80, 88, 115], 17: [130, 150, 110], 99: [40, 120, 255] };
for (let py = 0; py < PH; py++) for (let px = 0; px < PW; px++) {
  const x = WX0 + px / SC, z = WZ1 - py / SC;
  const o = (py * PW + px) * 4;
  img[o + 3] = 255;
  const h = H(hf, x, z);
  if (isNaN(h)) { img[o] = 18; img[o + 1] = 20; img[o + 2] = 28; continue; }
  const hx = (H(hf, x + 1.5, z) - H(hf, x - 1.5, z)) / 3, hz = (H(hf, x, z + 1.5) - H(hf, x, z - 1.5)) / 3;
  let shade = 0.2;
  if (!isNaN(hx) && !isNaN(hz)) {
    const nl = Math.hypot(-hx, 1, -hz);
    shade = Math.max(0, (-hx * light[0]! + light[1]! - hz * light[2]!) / (nl * ln)) * 0.85 + 0.15;
  }
  const [cgx, cgz] = gi(x, z);
  const t = tf[cgz! * GW + cgx!]!;
  const tint = TINT[t] ?? [200, 200, 200];
  img[o] = tint[0]! * shade; img[o + 1] = tint[1]! * shade; img[o + 2] = tint[2]! * shade;
}
// race lines red
for (const rl of aip.RaceLines) {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const steps = Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!) * SC);
    for (let s = 0; s <= steps; s++) {
      const x = a[0]! + ((b[0]! - a[0]!) * s) / steps, z = a[2]! + ((b[2]! - a[2]!) * s) / steps;
      const px = Math.round((x - WX0) * SC), py = Math.round((WZ1 - z) * SC);
      if (px >= 1 && py >= 1 && px < PW - 1 && py < PH - 1)
        for (let w = -1; w <= 1; w++) { const o1 = (py * PW + px + w) * 4; img[o1] = 230; img[o1 + 1] = 40; img[o1 + 2] = 40; const o2 = ((py + w) * PW + px) * 4; img[o2] = 230; img[o2 + 1] = 40; img[o2 + 2] = 40; }
    }
  }
}
writeFileSync(tempFile("gari-water.png"), encodePng({ w: PW, h: PH, data: img }));
console.log(`\nzoom -> temp/gari-water.png (${PW}x${PH}; bright blue=water, cyan=other ice, red=race lines)`);
