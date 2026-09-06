// GARI terrain SHAPE study — top quarter of the mountain.
// Tessellates Bézier patches into a 2 m heightfield (+surface type + name class),
// renders hillshade+contours of the top quarter, cuts cross-sections along Race Line 0,
// and measures banking vs turn curvature.
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

// ---- bake race lines (same decode as before)
const aip = j("AIP.json");
interface Line { name: string; pts: number[][]; dtf: number }
const race: Line[] = aip.RaceLines.map((rl: any) => {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  return { name: rl.Name, pts, dtf: rl.DistanceToFinish / 100 };
});

// ---- patch class from name
const cls = (n: string) => {
  n = n ?? "";
  if (/MainPath/i.test(n)) return 1;       // the trail
  if (/ShowOff/.test(n)) return 2;
  if (/MetalRail/.test(n)) return 3;
  if (/SideGeo|_SGD|_SG_|_SG[0-9]/.test(n)) return 4; // skirt
  if (/_SCE/.test(n)) return 5;            // scenery/canyon edge
  if (/_SC[0-9]|NewSC/.test(n)) return 6;  // numbered sections
  return 0;
};

// ---- tessellate patches -> heightfield
const patches = j("Patches.json").Patches as any[];
const RES = 6; // grid per patch edge for rasterizing
const bez1 = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};
function surfPt(P: number[][], u: number, v: number) {
  const row = (r: number, i: number) => bez1(P[r * 4]![i]!, P[r * 4 + 1]![i]!, P[r * 4 + 2]![i]!, P[r * 4 + 3]![i]!, u);
  return [0, 1, 2].map(i => bez1(row(0, i), row(1, i), row(2, i), row(3, i), v));
}
// world bounds (plan, metres, x = -sx/100 east, z = sz/100 north)
let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
for (const p of patches) if (p.Points?.length >= 16) for (const q of p.Points) {
  const x = -q[0] / 100, z = q[2] / 100;
  if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (z < mnz) mnz = z; if (z > mxz) mxz = z;
}
const CELL = 2;
const GW = Math.ceil((mxx - mnx) / CELL) + 2, GH = Math.ceil((mxz - mnz) / CELL) + 2;
const hf = new Float32Array(GW * GH).fill(NaN);
const tf = new Int8Array(GW * GH).fill(-1);   // surface type
const cf = new Int8Array(GW * GH).fill(-1);   // name class
const gi = (x: number, z: number) => [Math.round((x - mnx) / CELL), Math.round((z - mnz) / CELL)];
for (const p of patches) {
  if (!p.Points || p.Points.length < 16) continue;
  const P = p.Points.map((q: number[]) => [-q[0] / 100, -q[1] / 100, q[2] / 100]); // east, up, north
  const k = cls(p.PatchName), st = p.SurfaceType;
  // adaptive sampling: ~1 sample per heightfield cell across the patch's plan extent
  let pmnx = 1e9, pmxx = -1e9, pmnz = 1e9, pmxz = -1e9;
  for (const q of P) { pmnx = Math.min(pmnx, q[0]!); pmxx = Math.max(pmxx, q[0]!); pmnz = Math.min(pmnz, q[2]!); pmxz = Math.max(pmxz, q[2]!); }
  const ru = Math.min(96, Math.max(RES, Math.ceil((pmxx - pmnx) / CELL) + 1));
  const rv = Math.min(96, Math.max(RES, Math.ceil((pmxz - pmnz) / CELL) + 1));
  for (let a = 0; a <= ru; a++) for (let b = 0; b <= rv; b++) {
    const s = surfPt(P, a / ru, b / rv);
    const [cx, cz] = gi(s[0]!, s[2]!);
    if (cx! < 0 || cz! < 0 || cx! >= GW || cz! >= GH) continue;
    const o = cz! * GW + cx!;
    if (isNaN(hf[o]!) || s[1]! > hf[o]!) { hf[o] = s[1]!; tf[o] = st; cf[o] = k; }
  }
}
// dilate one pass to close pinholes between sample grids
const hf2 = hf.slice();
for (let z = 1; z < GH - 1; z++) for (let x = 1; x < GW - 1; x++) {
  const o = z * GW + x;
  if (!isNaN(hf[o]!)) continue;
  let sum = 0, n = 0;
  for (const d of [-1, 1, -GW, GW]) if (!isNaN(hf[o + d]!)) { sum += hf[o + d]!; n++; }
  if (n >= 2) { hf2[o] = sum / n; tf[o] = tf[o + (isNaN(hf[o - 1]!) ? 1 : -1)]!; cf[o] = cf[o + (isNaN(hf[o - 1]!) ? 1 : -1)]!; }
}
const H = (x: number, z: number) => {
  const fx = (x - mnx) / CELL, fz = (z - mnz) / CELL;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const q = (xx: number, zz: number) => hf2[Math.min(GH - 1, Math.max(0, zz)) * GW + Math.min(GW - 1, Math.max(0, xx))]!;
  const h00 = q(x0, z0), h10 = q(x0 + 1, z0), h01 = q(x0, z0 + 1), h11 = q(x0 + 1, z0 + 1);
  if ([h00, h10, h01, h11].some(isNaN)) return NaN;
  const tx = fx - x0, tz = fz - z0;
  return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
};

// ---- top-quarter window: race line 0 + #6 + upper #1/#7/#8 (dtf >= 3455)
const inTop = (L: Line) => {
  // keep the prefix of pts while dtf >= 3455
  let d = L.dtf;
  const out: number[][] = [L.pts[0]!];
  for (let i = 1; i < L.pts.length; i++) {
    d -= Math.hypot(L.pts[i]![0]! - L.pts[i - 1]![0]!, L.pts[i]![1]! - L.pts[i - 1]![1]!, L.pts[i]![2]! - L.pts[i - 1]![2]!);
    if (d < 3455) break;
    out.push(L.pts[i]!);
  }
  return out.length > 1 ? out : null;
};
const topLines = race.map(L => ({ name: L.name, pts: inTop(L) })).filter(L => L.pts) as { name: string; pts: number[][] }[];
let tmnx = 1e9, tmxx = -1e9, tmnz = 1e9, tmxz = -1e9;
for (const L of topLines) for (const p of L.pts) {
  tmnx = Math.min(tmnx, p[0]! - 220); tmxx = Math.max(tmxx, p[0]! + 220);
  tmnz = Math.min(tmnz, p[2]! - 220); tmxz = Math.max(tmxz, p[2]! + 220);
}

// ---- render hillshade + contours of the window
const PW = Math.ceil(tmxx - tmnx), PH = Math.ceil(tmxz - tmnz);
const img = Buffer.alloc(PW * PH * 4);
const lightDir = [-0.5, 0.7, -0.5]; // from NE-ish above
const ln = Math.hypot(...lightDir);
const TYPE_TINT: Record<number, number[]> = { 1: [240, 244, 252], 3: [205, 220, 244], 4: [180, 190, 235], 5: [160, 235, 245], 9: [165, 130, 100], 10: [110, 110, 110], 18: [250, 180, 90], 0: [95, 105, 135], 17: [130, 150, 110] };
for (let pyy = 0; pyy < PH; pyy++) for (let pxx = 0; pxx < PW; pxx++) {
  const x = tmnx + pxx, z = tmzFix(pyy);
  const o = (pyy * PW + pxx) * 4;
  const h = H(x, z);
  if (isNaN(h)) { img[o] = 18; img[o + 1] = 20; img[o + 2] = 28; img[o + 3] = 255; continue; }
  const hx = (H(x + 2, z) - H(x - 2, z)) / 4, hz = (H(x, z + 2) - H(x, z - 2)) / 4;
  const nxv = -hx, nyv = 1, nzv = -hz;
  const nl = Math.hypot(nxv, nyv, nzv);
  let shade = (nxv * lightDir[0]! + nyv * lightDir[1]! + nzv * lightDir[2]!) / (nl * ln);
  shade = Math.max(0, shade) * 0.85 + 0.15;
  const [cgx, cgz] = gi(x, z);
  const t = tf[Math.min(GH - 1, Math.max(0, cgz!)) * GW + Math.min(GW - 1, Math.max(0, cgx!))]!;
  const tint = TYPE_TINT[t] ?? [200, 200, 200];
  let r = tint[0]! * shade, g = tint[1]! * shade, b = tint[2]! * shade;
  // contours every 10 m, bold every 50
  const c10 = Math.abs(h / 10 - Math.round(h / 10)) * 10;
  const grad = Math.hypot(hx, hz) + 1e-6;
  if (c10 < 0.06 * grad * 4) { const bold = Math.abs(h / 50 - Math.round(h / 50)) * 50 < 0.3 * grad; r *= bold ? 0.45 : 0.7; g *= bold ? 0.45 : 0.7; b *= bold ? 0.45 : 0.7; }
  img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
}
function tmzFix(pyy: number) { return tmxz - pyy; } // north up
// race lines on top
const putl = (x: number, y: number, c: number[]) => { if (x >= 0 && y >= 0 && x < PW && y < PH) { const o = (y * PW + x) * 4; img[o] = c[0]!; img[o + 1] = c[1]!; img[o + 2] = c[2]!; } };
for (const L of topLines) {
  const col = L.name === "Race Line 0" ? [255, 40, 40] : [255, 80, 200];
  for (let i = 1; i < L.pts.length; i++) {
    const a = L.pts[i - 1]!, b = L.pts[i]!;
    const steps = Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(a[0]! + ((b[0]! - a[0]!) * s) / steps - tmnx);
      const y = Math.round(tmxz - (a[2]! + ((b[2]! - a[2]!) * s) / steps));
      for (let w = -1; w <= 1; w++) { putl(x + w, y, col); putl(x, y + w, col); }
    }
  }
}
writeFileSync(tempFile("gari-top-shade.png"), encodePng({ w: PW, h: PH, data: img }));
console.log(`hillshade ${PW}x${PH} -> temp/gari-top-shade.png (window ${(tmxx - tmnx).toFixed(0)}x${(tmxz - tmnz).toFixed(0)} m)`);

// ---- cross-sections + banking along Race Line 0
const L0 = topLines.find(L => L.name === "Race Line 0")!;
// resample to every 10 m in plan
const sp: number[][] = [];
{
  let carry = 0;
  for (let i = 1; i < L0.pts.length; i++) {
    const a = L0.pts[i - 1]!, b = L0.pts[i]!;
    const l = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
    let d = carry;
    while (d <= l) { const t = d / l; sp.push([a[0]! + (b[0]! - a[0]!) * t, a[2]! + (b[2]! - a[2]!) * t]); d += 10; }
    carry = d - l;
  }
}
console.log("\n=== RACE LINE 0: banking & channel shape every 50 m ===");
console.log("dist  curv(1/m)  turnR(m)  bankL->R(deg)  wallL(m)  wallR(m)  shape");
const sections: { d: number; prof: number[]; off0: number }[] = [];
for (let i = 5; i < sp.length - 5; i += 5) {
  const a = sp[i - 5]!, m = sp[i]!, b = sp[i + 5]!;
  // curvature via circumscribed circle of 3 plan points (100 m chord)
  const ax = a[0]! - m[0]!, az = a[1]! - m[1]!, bx = b[0]! - m[0]!, bz = b[1]! - m[1]!;
  const d2a = ax * ax + az * az, d2b = bx * bx + bz * bz;
  const cross = ax * bz - az * bx;
  const curv = Math.abs(cross) < 1e-6 ? 0 : (2 * cross) / Math.sqrt(d2a * d2b * ((bx - ax) ** 2 + (bz - az) ** 2));
  // heading + perpendicular
  const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!;
  const n = Math.hypot(dx, dz);
  const ux = -dz / n, uz = dx / n; // left
  // cross-section ±120 m at 2 m
  const prof: number[] = [];
  for (let s = -120; s <= 120; s += 2) prof.push(H(m[0]! + ux * s, m[1]! + uz * s));
  const c = prof[60]!; // center height
  // bank in riding zone ±16 m: slope left-to-right
  const lH = H(m[0]! + ux * 16, m[1]! + uz * 16), rH = H(m[0]! - ux * 16, m[1]! - uz * 16);
  const bank = (Math.atan2(lH - rH, 32) * 180) / Math.PI;
  // wall rise within 80 m each side (max height above center)
  let wallL = 0, wallR = 0;
  for (let s = 2; s <= 80; s += 2) {
    const hl = H(m[0]! + ux * s, m[1]! + uz * s), hr = H(m[0]! - ux * s, m[1]! - uz * s);
    if (!isNaN(hl)) wallL = Math.max(wallL, hl - c);
    if (!isNaN(hr)) wallR = Math.max(wallR, hr - c);
  }
  const shape = wallL > 8 && wallR > 8 ? "GULLY" : wallL > 8 ? "bankL" : wallR > 8 ? "bankR" : "open";
  if (i % 5 === 0) console.log(`${String(i * 10).padStart(4)}  ${curv.toFixed(4).padStart(8)}  ${(curv !== 0 ? Math.abs(1 / curv) : Infinity).toFixed(0).padStart(7)}  ${bank.toFixed(1).padStart(8)}  ${wallL.toFixed(1).padStart(7)}  ${wallR.toFixed(1).padStart(7)}  ${shape}`);
  sections.push({ d: i * 10, prof, off0: c });
}

// ---- small-multiples cross-section strip
const CW = 2200, CH2 = 1500, COLS = 4, ROWS = 5;
const cimg = Buffer.alloc(CW * CH2 * 4);
for (let i = 0; i < CW * CH2; i++) { cimg[i * 4] = 24; cimg[i * 4 + 1] = 26; cimg[i * 4 + 2] = 34; cimg[i * 4 + 3] = 255; }
const putc = (x: number, y: number, c: number[]) => { if (x >= 0 && y >= 0 && x < CW && y < CH2) { const o = (y * CW + x) * 4; cimg[o] = c[0]!; cimg[o + 1] = c[1]!; cimg[o + 2] = c[2]!; } };
const pick = sections.filter((_, i) => i % Math.ceil(sections.length / (COLS * ROWS)) === 0).slice(0, COLS * ROWS);
pick.forEach((sec, idx) => {
  const gx = idx % COLS, gy = Math.floor(idx / COLS);
  const ox = gx * (CW / COLS) + 20, oy = gy * (CH2 / ROWS) + 20, w = CW / COLS - 40, h = CH2 / ROWS - 40;
  // vertical scale: fit -40..+40 m relative to center; same aspect notion every panel
  for (let k = 1; k < sec.prof.length; k++) {
    const r0 = sec.prof[k - 1]! - sec.off0, r1 = sec.prof[k]! - sec.off0;
    if (isNaN(r0) || isNaN(r1)) continue;
    const x0 = ox + ((k - 1) / sec.prof.length) * w, x1 = ox + (k / sec.prof.length) * w;
    const y0 = oy + h - ((r0 + 50) / 100) * h, y1 = oy + h - ((r1 + 50) / 100) * h;
    const steps = Math.max(1, Math.ceil(Math.abs(x1 - x0) + Math.abs(y1 - y0)));
    for (let s = 0; s <= steps; s++) for (let wy = 0; wy < 2; wy++) putc(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps) + wy, [120, 200, 255]);
  }
  // center marker + zero line
  for (let yy = 0; yy < h; yy += 4) putc(Math.round(ox + w / 2), Math.round(oy + yy), [255, 60, 60]);
  for (let xx = 0; xx < w; xx += 4) putc(Math.round(ox + xx), Math.round(oy + h / 2), [70, 74, 90]);
});
writeFileSync(tempFile("gari-top-sections.png"), encodePng({ w: CW, h: CH2, data: cimg }));
console.log(`\ncross-sections (every ~${Math.ceil(sections.length / 20) * 50} m, ±120 m wide, ±50 m tall, red=race line) -> temp/gari-top-sections.png`);

// ---- name-class x surface-type cross tab (whole mountain, context for the doc)
const tab = new Map<string, number>();
for (const p of patches) { const k = cls(p.PatchName) + "|" + p.SurfaceType; tab.set(k, (tab.get(k) ?? 0) + 1); }
console.log("\n=== name-class x surface-type (count) ===");
const CN = ["other", "MainPath", "ShowOff", "MetalRail", "SideGeo/SG*", "SCE", "SC#"];
for (let c = 0; c <= 6; c++) {
  const row = [...tab.entries()].filter(([k]) => k.startsWith(c + "|")).map(([k, v]) => `t${k.split("|")[1]}:${v}`).join(" ");
  if (row) console.log(`${CN[c]!.padEnd(12)} ${row}`);
}
