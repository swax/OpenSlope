// GARI pathing deep-dive: race-line branch graph (chained by DistanceToFinish),
// full-course elevation profile, and rideable-width sampling along the spine.
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

interface Line { name: string; pts: number[][]; dtf: number }
const aip = j("AIP.json");
const race: Line[] = [];
for (const rl of aip.RaceLines) {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  race.push({ name: rl.Name, pts, dtf: rl.DistanceToFinish / 100 });
}

const seglen = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

// ---- branch table: dtf range per line + endpoint adjacency
console.log("=== RACE LINE CHAIN (by DistanceToFinish, metres) ===");
const ranges = race.map(L => {
  let len = 0;
  for (let i = 1; i < L.pts.length; i++) len += seglen(L.pts[i - 1]!, L.pts[i]!);
  return { L, start: L.dtf, end: L.dtf - len, len };
}).sort((a, b) => b.start - a.start);
for (const r of ranges) {
  // which other lines' endpoints sit near this line's start/end (plan distance < 30m)?
  const near = (p: number[]) => ranges.filter(o => o !== r && (
    Math.hypot(o.L.pts[o.L.pts.length - 1]![0]! - p[0]!, o.L.pts[o.L.pts.length - 1]![2]! - p[2]!) < 30 ||
    Math.hypot(o.L.pts[0]![0]! - p[0]!, o.L.pts[0]![2]! - p[2]!) < 30)).map(o => o.L.name.replace("Race Line ", "#"));
  const drop = r.L.pts[0]![1]! - r.L.pts[r.L.pts.length - 1]![1]!;
  console.log(`${r.L.name.padEnd(13)} dtf ${r.start.toFixed(0).padStart(4)} -> ${r.end.toFixed(0).padStart(4)}  len ${r.len.toFixed(0).padStart(4)}  drop ${drop.toFixed(0).padStart(4)}  joins[start: ${near(r.L.pts[0]!).join(",") || "-"} | end: ${near(r.L.pts[r.L.pts.length - 1]!).join(",") || "-"}]`);
}

// ---- full-course elevation profile: x = dtf (right→left, finish at right=0), all lines
const PW = 2200, PH = 800;
const img = Buffer.alloc(PW * PH * 4);
for (let i = 0; i < PW * PH; i++) { img[i * 4] = 24; img[i * 4 + 1] = 26; img[i * 4 + 2] = 34; img[i * 4 + 3] = 255; }
let mnA = 1e9, mxA = -1e9, mxD = 0;
for (const r of ranges) { mxD = Math.max(mxD, r.start); for (const p of r.L.pts) { mnA = Math.min(mnA, p[1]!); mxA = Math.max(mxA, p[1]!); } }
const sx = (d: number) => 40 + ((mxD - d) / mxD) * (PW - 80); // start at left, finish at right
const sy = (e: number) => PH - 50 - ((e - mnA) / (mxA - mnA)) * (PH - 100);
const put = (x: number, y: number, c: number[]) => { if (x >= 0 && y >= 0 && x < PW && y < PH) { const o = (y * PW + x) * 4; img[o] = c[0]!; img[o + 1] = c[1]!; img[o + 2] = c[2]!; } };
const drawSeg = (x0: number, y0: number, x1: number, y1: number, c: number[], w: number) => {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps), y = Math.round(y0 + ((y1 - y0) * s) / steps);
    for (let oy = -w; oy <= w; oy++) for (let ox = -w; ox <= w; ox++) put(x + ox, y + oy, c);
  }
};
// grid: 500 m dtf, 100 m altitude
for (let d = 0; d <= mxD; d += 500) for (let y = 50; y < PH - 50; y += 4) put(Math.round(sx(d)), y, [56, 60, 76]);
for (let e = Math.ceil(mnA / 100) * 100; e <= mxA; e += 100) for (let x = 40; x < PW - 40; x += 4) put(x, Math.round(sy(e)), [56, 60, 76]);
const PALETTE = [[255, 70, 70], [70, 200, 90], [90, 150, 255], [255, 200, 70], [220, 90, 220], [80, 220, 220], [255, 140, 60], [170, 220, 80], [240, 120, 160], [120, 120, 255], [200, 200, 200], [255, 230, 120], [100, 230, 170], [230, 100, 100]];
for (let li = 0; li < ranges.length; li++) {
  const r = ranges[li]!;
  let d = r.start;
  for (let i = 1; i < r.L.pts.length; i++) {
    const a = r.L.pts[i - 1]!, b = r.L.pts[i]!;
    const d2 = d - seglen(a, b);
    drawSeg(sx(d), sy(a[1]!), sx(d2), sy(b[1]!), PALETTE[li % PALETTE.length]!, 1);
    d = d2;
  }
}
writeFileSync(tempFile("gari-profile-full.png"), encodePng({ w: PW, h: PH, data: img }));
console.log(`\nfull profile -> temp/gari-profile-full.png (course ${mxD.toFixed(0)} m by dtf, alt ${mnA.toFixed(0)}..${mxA.toFixed(0)} m)`);

// ---- rideable width along the spine
// rideable quads (types 1,3,4,5,18) in a 50 m plan grid; sample every 50 m of dtf on the longest chain
const RIDE = new Set([1, 3, 4, 5, 18]);
const patches = j("Patches.json").Patches as any[];
interface Q { c: number[][] }
const grid = new Map<string, Q[]>();
const key = (x: number, z: number) => `${Math.floor(x / 50)},${Math.floor(z / 50)}`;
for (const p of patches) {
  if (!RIDE.has(p.SurfaceType) || !p.Points || p.Points.length < 16) continue;
  const c = [0, 3, 15, 12].map(i => [-p.Points[i][0] / 100, p.Points[i][2] / 100]);
  const q = { c };
  const xs = c.map(v => v[0]!), zs = c.map(v => v[1]!);
  for (let gx = Math.floor(Math.min(...xs) / 50); gx <= Math.floor(Math.max(...xs) / 50); gx++)
    for (let gz = Math.floor(Math.min(...zs) / 50); gz <= Math.floor(Math.max(...zs) / 50); gz++) {
      const k = `${gx},${gz}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(q);
    }
}
const inQuad = (x: number, z: number, q: Q) => {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q.c[i]!, b = q.c[(i + 1) % 4]!;
    const cr = (b[0]! - a[0]!) * (z - a[1]!) - (b[1]! - a[1]!) * (x - a[0]!);
    if (cr !== 0) { const s = Math.sign(cr); if (sign === 0) sign = s; else if (s !== sign) return false; }
  }
  return true;
};
const rideableAt = (x: number, z: number) => (grid.get(key(x, z)) ?? []).some(q => inQuad(x, z, q));
// walk all race lines, sample width every ~100 m of course
console.log("\n=== RIDEABLE WIDTH ALONG RACE LINES (plan, perpendicular scan ±250 m, 2 m steps) ===");
const widths: number[] = [];
for (const r of ranges) {
  let acc = 0, next = 0;
  const samples: string[] = [];
  for (let i = 1; i < r.L.pts.length; i++) {
    const a = r.L.pts[i - 1]!, b = r.L.pts[i]!;
    const l = seglen(a, b);
    while (next <= acc + l) {
      const t = (next - acc) / l;
      const x = a[0]! + (b[0]! - a[0]!) * t, z = a[2]! + (b[2]! - a[2]!) * t;
      const dx = b[0]! - a[0]!, dz = b[2]! - a[2]!;
      const n = Math.hypot(dx, dz) || 1;
      const ux = -dz / n, uz = dx / n; // perpendicular in plan
      let left = 0, right = 0;
      for (let s = 2; s <= 250; s += 2) { if (rideableAt(x + ux * s, z + uz * s)) right = s; else if (s - right > 30) break; }
      for (let s = 2; s <= 250; s += 2) { if (rideableAt(x - ux * s, z - uz * s)) left = s; else if (s - left > 30) break; }
      const w = left + right;
      widths.push(w);
      samples.push(w.toFixed(0));
      next += 100;
    }
    acc += l;
  }
  console.log(`${r.L.name.padEnd(13)} widths(m): ${samples.join(" ")}`);
}
widths.sort((a, b) => a - b);
console.log(`\nwidth stats: min ${widths[0]} m, p25 ${widths[Math.floor(widths.length * .25)]} m, median ${widths[Math.floor(widths.length / 2)]} m, p75 ${widths[Math.floor(widths.length * .75)]} m, max ${widths[widths.length - 1]} m`);
