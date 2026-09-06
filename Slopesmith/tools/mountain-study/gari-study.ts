// Garibaldi (GARI) terrain + player-pathing design study.
// Bakes AIP/SOP paths (PathPos + cumulative deltas), reads Patches.json/Splines.json,
// prints stats and renders a top-down map + race-line elevation profile.
// Space: raw SSX is -Y-up, cm. Plan view uses (-x, z) in metres; altitude = -y/100.
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { GARI_DIR, tempFile } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

// ---------------------------------------------------------------- bake paths
interface Line { name: string; src: string; kind: string; pts: number[][]; dist?: number; events: any[] }
const lines: Line[] = [];
const seen = new Set<string>();
for (const file of ["AIP.json", "SOP.json"]) {
  const pf = j(file);
  const bake = (e: any, kind: string) => {
    if (!e.PathPoints || e.PathPoints.length < 2) return;
    let [ax, ay, az] = e.PathPos ?? [0, 0, 0];
    const pts: number[][] = [];
    for (const p of e.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); } // (east, up, north) m
    const sig = `${e.Name}|${Math.round(pts[0]![0])},${Math.round(pts[0]![2])}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    lines.push({ name: e.Name, src: file.slice(0, 3), kind, pts, dist: e.DistanceToFinish, events: e.PathEvents ?? [] });
  };
  for (const rl of pf.RaceLines ?? []) bake(rl, "race");
  for (const ap of pf.AIPaths ?? []) bake(ap, ap.Respawnable ? "ai-respawn" : "ai");
}

const len = (pts: number[][]) => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1], pts[i]![2] - pts[i - 1]![2]); return d; };
const len2d = (pts: number[][]) => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![2] - pts[i - 1]![2]); return d; };

// ---------------------------------------------------------------- patches
const SURF: Record<number, [string, number[]]> = {
  0: ["reset/side-geo", [70, 80, 110]],
  1: ["standard snow", [235, 238, 245]],
  3: ["powder snow", [190, 215, 245]],
  4: ["slow powder", [165, 175, 230]],
  5: ["ice", [140, 230, 240]],
  9: ["rock/off-track", [150, 115, 85]],
  10: ["wall", [90, 90, 90]],
  17: ["no-collision", [120, 140, 100]],
  18: ["ramp/metal", [245, 170, 80]],
};
const patches = j("Patches.json").Patches as any[];
const surfStats = new Map<number, { n: number; area: number }>();
interface Quad { c: number[][]; t: number } // 4 plan corners (east,north) + type
const quads: Quad[] = [];
let trickOnly = 0;
let minUp = 1e9, maxUp = -1e9;
for (const p of patches) {
  if (!p.Points || p.Points.length < 16) continue;
  if (p.TrickOnlyPatch) trickOnly++;
  const corner = (i: number) => [-p.Points[i][0] / 100, -p.Points[i][1] / 100, p.Points[i][2] / 100];
  const [a, b, c, d] = [corner(0), corner(3), corner(15), corner(12)];
  for (const q of [a, b, c, d]) { if (q[1]! < minUp) minUp = q[1]!; if (q[1]! > maxUp) maxUp = q[1]!; }
  // quad area via cross products (3d, both tris)
  const tri = (u: number[], v: number[], w: number[]) => {
    const e1 = [v[0]! - u[0]!, v[1]! - u[1]!, v[2]! - u[2]!], e2 = [w[0]! - u[0]!, w[1]! - u[1]!, w[2]! - u[2]!];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!, cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    return Math.hypot(cx, cy, cz) / 2;
  };
  const area = tri(a, b, c) + tri(a, c, d);
  const s = surfStats.get(p.SurfaceType) ?? { n: 0, area: 0 };
  s.n++; s.area += area;
  surfStats.set(p.SurfaceType, s);
  quads.push({ c: [[a[0]!, a[2]!], [b[0]!, b[2]!], [c[0]!, c[2]!], [d[0]!, d[2]!]], t: p.SurfaceType });
}

// ---------------------------------------------------------------- rails
const splines = j("Splines.json").Splines as any[];
const bez = (p0: number[], p1: number[], p2: number[], p3: number[], t: number) =>
  [0, 1, 2].map(i => {
    const u = 1 - t;
    return u * u * u * p0[i]! + 3 * u * u * t * p1[i]! + 3 * u * t * t * p2[i]! + t * t * t * p3[i]!;
  });
interface Rail { name: string; pts: number[][] }
const rails: Rail[] = [];
for (const sp of splines) {
  const isRail = sp.SplineStyle === 13 || (sp.SplineName ?? "").includes("Rail");
  if (!isRail || !sp.Segments) continue;
  const pts: number[][] = [];
  for (const seg of sp.Segments) {
    if (!seg.Points || seg.Points.length < 4) continue;
    for (let k = 0; k <= 8; k++) {
      const q = bez(seg.Points[0], seg.Points[1], seg.Points[2], seg.Points[3], k / 8);
      pts.push([-q[0]! / 100, -q[1]! / 100, q[2]! / 100]);
    }
  }
  if (pts.length > 1) rails.push({ name: sp.SplineName, pts });
}

// ---------------------------------------------------------------- stats out
console.log("=== TERRAIN ===");
console.log(`patches: ${patches.length} (${trickOnly} trick-only), altitude ${minUp.toFixed(0)}..${maxUp.toFixed(0)} m (drop ${(maxUp - minUp).toFixed(0)} m)`);
let totArea = 0;
for (const [t, s] of [...surfStats.entries()].sort((x, y) => y[1].area - x[1].area)) {
  totArea += s.area;
  console.log(`  surf ${String(t).padStart(2)} ${(SURF[t]?.[0] ?? "?").padEnd(15)} ${String(s.n).padStart(4)} patches  ${(s.area / 1e4).toFixed(1).padStart(8)} ha`);
}
console.log(`  total surface ~${(totArea / 1e4).toFixed(1)} ha`);

console.log("\n=== PATH LINES (deduped) ===");
for (const L of lines) {
  const drop = L.pts[0]![1]! - L.pts[L.pts.length - 1]![1]!;
  const l3 = len(L.pts);
  const grade = (drop / len2d(L.pts)) * 100;
  console.log(`${L.src} ${L.kind.padEnd(10)} ${L.name.padEnd(14)} pts=${String(L.pts.length).padStart(3)} len=${l3.toFixed(0).padStart(5)} m drop=${drop.toFixed(0).padStart(4)} m avg-grade=${grade.toFixed(1).padStart(5)}% events=${L.events.length}${L.dist ? " dtf=" + (L.dist / 100).toFixed(0) + "m" : ""}`);
}

console.log("\n=== RAILS ===");
const railLens = rails.map(r => len(r.pts)).sort((a, b) => b - a);
console.log(`rails: ${rails.length}, total ${railLens.reduce((a, b) => a + b, 0).toFixed(0)} m, longest ${railLens[0]?.toFixed(0)} m, median ${railLens[Math.floor(railLens.length / 2)]?.toFixed(0)} m`);

// event type histogram across all lines
const evHist = new Map<number, number>();
for (const L of lines) for (const e of L.events) evHist.set(e.EventType, (evHist.get(e.EventType) ?? 0) + 1);
console.log("\n=== PATH EVENT TYPES ===");
console.log([...evHist.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join("  "));

// ---------------------------------------------------------------- render map
const all2d: number[][] = [];
for (const q of quads) all2d.push(...q.c);
let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
for (const p of all2d) { mnx = Math.min(mnx, p[0]!); mxx = Math.max(mxx, p[0]!); mnz = Math.min(mnz, p[1]!); mxz = Math.max(mxz, p[1]!); }
const PAD = 40, W = 2000;
const scale = (W - 2 * PAD) / (mxx - mnx);
const H = Math.ceil((mxz - mnz) * scale) + 2 * PAD;
const px = (x: number) => PAD + (x - mnx) * scale;
const py = (z: number) => H - PAD - (z - mnz) * scale; // north up
const img = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { img[i * 4] = 24; img[i * 4 + 1] = 26; img[i * 4 + 2] = 34; img[i * 4 + 3] = 255; }
const put = (x: number, y: number, c: number[], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  img[o] = img[o]! * (1 - a) + c[0]! * a; img[o + 1] = img[o + 1]! * (1 - a) + c[1]! * a; img[o + 2] = img[o + 2]! * (1 - a) + c[2]! * a;
};
// polygon fill (convex quad scanline)
function fillQuad(c: number[][], col: number[], alpha: number) {
  const xs = c.map(p => px(p[0]!)), ys = c.map(p => py(p[1]!));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const hits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const j2 = (i + 1) % 4;
      const ya = ys[i]!, yb = ys[j2]!;
      if ((ya <= y && yb > y) || (yb <= y && ya > y)) hits.push(xs[i]! + ((y - ya) / (yb - ya)) * (xs[j2]! - xs[i]!));
    }
    hits.sort((a, b) => a - b);
    for (let k = 0; k + 1 < hits.length; k += 2)
      for (let x = Math.max(0, Math.round(hits[k]!)); x <= Math.min(W - 1, Math.round(hits[k + 1]!)); x++) put(x, y, col, alpha);
  }
}
function line2d(a: number[], b: number[], col: number[], w: number, alpha = 1) {
  const x0 = px(a[0]!), y0 = py(a[1]!), x1 = px(b[0]!), y1 = py(b[1]!);
  const dx = x1 - x0, dy = y1 - y0, steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let s = 0; s <= steps; s++) {
    const x = x0 + (dx * s) / steps, y = y0 + (dy * s) / steps;
    for (let oy = -w; oy <= w; oy++) for (let ox = -w; ox <= w; ox++)
      if (ox * ox + oy * oy <= w * w) put(Math.round(x + ox), Math.round(y + oy), col, alpha);
  }
}
for (const q of quads) fillQuad(q.c, SURF[q.t]?.[1] ?? [255, 0, 255], q.t === 0 ? 0.5 : 0.95);
for (const r of rails) for (let i = 1; i < r.pts.length; i++) line2d([r.pts[i - 1]![0]!, r.pts[i - 1]![2]!], [r.pts[i]![0]!, r.pts[i]![2]!], [20, 20, 20], 2);
const KIND_COL: Record<string, number[]> = { race: [225, 40, 40], "ai-respawn": [40, 170, 60], ai: [240, 220, 60] };
for (const L of lines) {
  if (L.kind === "race") continue;
  for (let i = 1; i < L.pts.length; i++) line2d([L.pts[i - 1]![0]!, L.pts[i - 1]![2]!], [L.pts[i]![0]!, L.pts[i]![2]!], KIND_COL[L.kind]!, 1, 0.85);
}
for (const L of lines) {
  if (L.kind !== "race") continue;
  const main = L.name === "Race Line 0" && L.src === "AIP";
  for (let i = 1; i < L.pts.length; i++) line2d([L.pts[i - 1]![0]!, L.pts[i - 1]![2]!], [L.pts[i]![0]!, L.pts[i]![2]!], main ? [255, 30, 30] : [200, 60, 160], main ? 3 : 1, 0.95);
}
// start positions: first point of each race line gets a ring
for (const L of lines) if (L.kind === "race") {
  const x = Math.round(px(L.pts[0]![0]!)), y = Math.round(py(L.pts[0]![2]!));
  for (let a = 0; a < 64; a++) put(Math.round(x + 7 * Math.cos(a / 10)), Math.round(y + 7 * Math.sin(a / 10)), [255, 255, 255]);
}
writeFileSync(tempFile("gari-map.png"), encodePng({ w: W, h: H, data: img }));
console.log(`\nmap: ${W}x${H} -> temp/gari-map.png  (plan ${(mxx - mnx).toFixed(0)} x ${(mxz - mnz).toFixed(0)} m)`);

// ---------------------------------------------------------------- elevation profile of main race line
const main = lines.find(L => L.kind === "race" && L.src === "AIP" && L.name === "Race Line 0")!;
const PW = 2000, PH = 700;
const prof = Buffer.alloc(PW * PH * 4);
for (let i = 0; i < PW * PH; i++) { prof[i * 4] = 24; prof[i * 4 + 1] = 26; prof[i * 4 + 2] = 34; prof[i * 4 + 3] = 255; }
const total = len(main.pts);
let acc = 0;
const samples: number[][] = [[0, main.pts[0]![1]!]];
for (let i = 1; i < main.pts.length; i++) {
  acc += Math.hypot(main.pts[i]![0]! - main.pts[i - 1]![0]!, main.pts[i]![1]! - main.pts[i - 1]![1]!, main.pts[i]![2]! - main.pts[i - 1]![2]!);
  samples.push([acc, main.pts[i]![1]!]);
}
const e0 = Math.min(...samples.map(s => s[1]!)), e1 = Math.max(...samples.map(s => s[1]!));
const sx = (d: number) => 30 + (d / total) * (PW - 60);
const sy = (e: number) => PH - 40 - ((e - e0) / (e1 - e0)) * (PH - 80);
const putP = (x: number, y: number, c: number[]) => { if (x >= 0 && y >= 0 && x < PW && y < PH) { const o = (y * PW + x) * 4; prof[o] = c[0]!; prof[o + 1] = c[1]!; prof[o + 2] = c[2]!; } };
for (let i = 1; i < samples.length; i++) {
  const [d0, h0] = samples[i - 1]!, [d1, h1] = samples[i]!;
  const grade = (h0! - h1!) / Math.max(1, d1! - d0!);
  const col = grade > 0.45 ? [255, 60, 60] : grade > 0.25 ? [255, 170, 60] : grade > 0.08 ? [120, 220, 120] : [110, 170, 255]; // steep/med/easy/flat-or-up
  const steps = Math.max(1, Math.ceil(sx(d1!) - sx(d0!)));
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(sx(d0!) + ((sx(d1!) - sx(d0!)) * s) / steps);
    const y = Math.round(sy(h0!) + ((sy(h1!) - sy(h0!)) * s) / steps);
    for (let w2 = 0; w2 < 3; w2++) putP(x, y + w2, col);
  }
}
// gridlines every 500 m / 50 m alt
for (let d = 0; d <= total; d += 500) for (let y = 40; y < PH - 40; y += 4) putP(Math.round(sx(d)), y, [60, 64, 80]);
for (let e = Math.ceil(e0 / 50) * 50; e <= e1; e += 50) for (let x = 30; x < PW - 30; x += 4) putP(x, Math.round(sy(e)), [60, 64, 80]);
writeFileSync(tempFile("gari-profile.png"), encodePng({ w: PW, h: PH, data: prof }));
console.log(`profile: total ${total.toFixed(0)} m, alt ${e0.toFixed(0)}..${e1.toFixed(0)} m -> temp/gari-profile.png`);
