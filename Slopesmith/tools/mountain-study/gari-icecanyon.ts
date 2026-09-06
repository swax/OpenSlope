// Case study: the ice canyon S at the bottom of the opening drop (ice cluster at (-129,-251)).
// Zoom hillshade with ice highlighted + per-section measurements: curvature, channel width,
// ice band placement, wall heights, ice cross-tilt (bank), and the entry drop profile.
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
const patches = (j("Patches.json").Patches as any[]).filter(p => p.Points?.length >= 16);

// window: ice bbox + margin, plus the entry drop above (toward the start, +z/north-ish)
const WX0 = -280, WX1 = 30, WZ0 = -380, WZ1 = -60;

const M = (q: number[]) => [-q[0]! / 100, -q[1]! / 100, q[2]! / 100];
const bez1 = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
function surfPt(P: number[][], u: number, v: number) {
  const row = (r: number, i: number) => bez1(P[r * 4]![i]!, P[r * 4 + 1]![i]!, P[r * 4 + 2]![i]!, P[r * 4 + 3]![i]!, u);
  return [0, 1, 2].map(i => bez1(row(0, i), row(1, i), row(2, i), row(3, i), v));
}
const CELL = 1;
const GW = Math.ceil((WX1 - WX0) / CELL) + 2, GH = Math.ceil((WZ1 - WZ0) / CELL) + 2;
const hf = new Float32Array(GW * GH).fill(NaN);
const tf = new Int8Array(GW * GH).fill(-1);
const gi = (x: number, z: number) => [Math.round((x - WX0) / CELL), Math.round((z - WZ0) / CELL)];
for (const p of patches) {
  const P = p.Points.map(M);
  let a1 = 1e9, a2 = -1e9, b1 = 1e9, b2 = -1e9;
  for (const q of P) { a1 = Math.min(a1, q[0]!); a2 = Math.max(a2, q[0]!); b1 = Math.min(b1, q[2]!); b2 = Math.max(b2, q[2]!); }
  if (a2 < WX0 - 5 || a1 > WX1 + 5 || b2 < WZ0 - 5 || b1 > WZ1 + 5) continue;
  const ru = Math.min(128, Math.max(8, Math.ceil((a2 - a1) / CELL) + 1));
  const rv = Math.min(128, Math.max(8, Math.ceil((b2 - b1) / CELL) + 1));
  for (let a = 0; a <= ru; a++) for (let b = 0; b <= rv; b++) {
    const s = surfPt(P, a / ru, b / rv);
    const [cx, cz] = gi(s[0]!, s[2]!);
    if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) continue;
    const o = cz! * GW + cx!;
    if (isNaN(hf[o]!) || s[1]! > hf[o]!) { hf[o] = s[1]!; tf[o] = p.SurfaceType; }
  }
}
const H = (x: number, z: number) => {
  const [cx, cz] = gi(x, z);
  if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) return NaN;
  return hf[cz! * GW + cx!]!;
};
const T = (x: number, z: number) => {
  const [cx, cz] = gi(x, z);
  if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) return -1;
  return tf[cz! * GW + cx!]!;
};

// race line 0 through the window
const aip = j("AIP.json");
const rl0 = aip.RaceLines.find((r: any) => r.Name === "Race Line 0");
let [ax, ay, az] = rl0.PathPos;
const line: number[][] = [];
for (const p of rl0.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; line.push([-ax / 100, -ay / 100, az / 100]); }
// resample 10 m
const sp: number[][] = [line[0]!];
{
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const l = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
    let d = carry;
    while (d <= l) { const t = d / l; sp.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]); d += 10; }
    carry = d - l;
  }
}

console.log("=== ICE CANYON S — sections every 20 m along Race Line 0 (window only) ===");
console.log("dist  alt    R(m)   chanW  iceBand(m)     iceW  bank°  wallL  wallR  grade%");
const ICE = 5;
const RIDE = new Set([1, 3, 4, 5, 18]);
for (let i = 2; i < sp.length - 2; i++) {
  const m = sp[i]!;
  if (m[0]! < WX0 || m[0]! > WX1 || m[2]! < WZ0 || m[2]! > WZ1) continue;
  if ((i * 10) % 20 !== 0) continue;
  const a = sp[i - 2]!, b = sp[i + 2]!;
  const axx = a[0]! - m[0]!, azz = a[2]! - m[2]!, bxx = b[0]! - m[0]!, bzz = b[2]! - m[2]!;
  const crossv = axx * bzz - azz * bxx;
  const R = Math.abs(crossv) < 1e-6 ? Infinity : Math.abs(Math.sqrt((axx * axx + azz * azz) * (bxx * bxx + bzz * bzz) * (((bxx - axx) ** 2 + (bzz - azz) ** 2))) / (2 * crossv));
  const dx = b[0]! - a[0]!, dz = b[2]! - a[2]!;
  const n = Math.hypot(dx, dz) || 1;
  const ux = -dz / n, uz = dx / n; // left
  const c = H(m[0]!, m[2]!);
  if (isNaN(c)) continue;
  // scan ±80 m
  let iceMin = 999, iceMax = -999, chanL = 0, chanR = 0, wallL = 0, wallR = 0;
  for (let s = -80; s <= 80; s += 1) {
    const x = m[0]! + ux * s, z = m[2]! + uz * s;
    const t = T(x, z), h = H(x, z);
    if (t === ICE) { if (s < iceMin) iceMin = s; if (s > iceMax) iceMax = s; }
    if (RIDE.has(t)) { if (s < 0) chanL = Math.max(chanL, -s); else chanR = Math.max(chanR, s); }
    if (!isNaN(h)) { if (s > 0) wallL = Math.max(wallL, h - c); else if (s < 0) wallR = Math.max(wallR, h - c); }
  }
  // ice cross-tilt: slope across the ice band
  let bank = NaN;
  if (iceMax > iceMin) {
    const h1 = H(m[0]! + ux * iceMin, m[2]! + uz * iceMin), h2 = H(m[0]! + ux * iceMax, m[2]! + uz * iceMax);
    if (!isNaN(h1) && !isNaN(h2)) bank = (Math.atan2(h2 - h1, iceMax - iceMin) * 180) / Math.PI;
  }
  const grade = (sp[i - 1]![1]! - sp[i + 1]![1]!) / 20 * 100;
  const iceW = iceMax > iceMin ? iceMax - iceMin : 0;
  console.log(`${String(i * 10).padStart(4)}  ${c.toFixed(0).padStart(4)}  ${(R === Infinity ? "-" : R.toFixed(0)).padStart(5)}  ${(chanL + chanR).toFixed(0).padStart(4)}  ${iceW ? `[${iceMin}..${iceMax}]`.padStart(12) : "          --"}  ${iceW.toFixed(0).padStart(4)}  ${isNaN(bank) ? "  -" : bank.toFixed(0).padStart(3)}   ${wallL.toFixed(0).padStart(4)}  ${wallR.toFixed(0).padStart(4)}  ${grade.toFixed(0).padStart(5)}`);
}

// entry drop: profile straight down the line from the plateau edge into the canyon
console.log("\nentry: race-line altitude (every 20 m of ridden distance, from gate):");
let out = "";
for (let i = 0; i < Math.min(sp.length, 60); i += 2) out += `${(i * 10)}m:${sp[i]![1]!.toFixed(0)}  `;
console.log(out);

// ---------------- zoom render
const SC = 3; // px per metre
const PW = Math.ceil((WX1 - WX0) * SC), PH = Math.ceil((WZ1 - WZ0) * SC);
const img = Buffer.alloc(PW * PH * 4);
const light = [-0.5, 0.7, -0.5];
const ln = Math.hypot(...light);
const TINT: Record<number, number[]> = { 1: [240, 244, 252], 3: [205, 220, 244], 4: [180, 190, 235], 5: [80, 235, 255], 9: [165, 130, 100], 10: [110, 110, 110], 18: [250, 180, 90], 0: [80, 88, 115], 17: [130, 150, 110] };
for (let py = 0; py < PH; py++) for (let px = 0; px < PW; px++) {
  const x = WX0 + px / SC, z = WZ1 - py / SC;
  const o = (py * PW + px) * 4;
  img[o + 3] = 255;
  const h = H(x, z);
  if (isNaN(h)) { img[o] = 18; img[o + 1] = 20; img[o + 2] = 28; continue; }
  const hx = (H(x + 1.5, z) - H(x - 1.5, z)) / 3, hz = (H(x, z + 1.5) - H(x, z - 1.5)) / 3;
  let shade = 0.2;
  if (!isNaN(hx) && !isNaN(hz)) {
    const nl = Math.hypot(-hx, 1, -hz);
    shade = Math.max(0, (-hx * light[0]! + light[1]! - hz * light[2]!) / (nl * ln)) * 0.85 + 0.15;
  }
  const t = T(x, z);
  const tint = TINT[t] ?? [200, 200, 200];
  let r = tint[0]! * shade, g = tint[1]! * shade, bcol = tint[2]! * shade;
  const c10 = Math.abs(h / 10 - Math.round(h / 10)) * 10;
  const grad = Math.hypot(hx || 0, hz || 0) + 1e-6;
  if (c10 < 0.05 * grad * 3) { r *= 0.6; g *= 0.6; bcol *= 0.6; }
  img[o] = r; img[o + 1] = g; img[o + 2] = bcol;
}
// race line
for (let i = 1; i < sp.length; i++) {
  const a = sp[i - 1]!, b = sp[i]!;
  const steps = Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!) * SC);
  for (let s = 0; s <= steps; s++) {
    const x = a[0]! + ((b[0]! - a[0]!) * s) / steps, z = a[2]! + ((b[2]! - a[2]!) * s) / steps;
    const px = Math.round((x - WX0) * SC), py = Math.round((WZ1 - z) * SC);
    if (px >= 0 && py >= 0 && px < PW && py < PH) {
      for (let w = -1; w <= 1; w++) {
        const o1 = (py * PW + Math.min(PW - 1, Math.max(0, px + w))) * 4;
        img[o1] = 230; img[o1 + 1] = 40; img[o1 + 2] = 40;
        const o2 = (Math.min(PH - 1, Math.max(0, py + w)) * PW + px) * 4;
        img[o2] = 230; img[o2 + 1] = 40; img[o2 + 2] = 40;
      }
    }
  }
}
writeFileSync(tempFile("gari-icecanyon.png"), encodePng({ w: PW, h: PH, data: img }));
console.log(`\nzoom -> temp/gari-icecanyon.png (${PW}x${PH}, ${1 / SC * 100} cm/px; cyan=ice, white=snow, blue=powder, brown=rock, red=Race Line 0)`);
