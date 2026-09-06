// GARI jump integration study: airborne segments along race lines (line floats above terrain;
// flight = where terrain falls away), takeoff lip geometry, landing geometry/surface,
// ShowOff ramp placement, TrickOnly patches.
import { readFileSync } from "node:fs";
import { GARI_DIR } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
const patches = (j("Patches.json").Patches as any[]).filter(p => p.Points?.length >= 16);

const M = (q: number[]) => [-q[0]! / 100, -q[1]! / 100, q[2]! / 100];
const bez1 = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
function surfPt(P: number[][], u: number, v: number) {
  const row = (r: number, i: number) => bez1(P[r * 4]![i]!, P[r * 4 + 1]![i]!, P[r * 4 + 2]![i]!, P[r * 4 + 3]![i]!, u);
  return [0, 1, 2].map(i => bez1(row(0, i), row(1, i), row(2, i), row(3, i), v));
}
let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
for (const p of patches) for (const q of p.Points) { const m = M(q); if (m[0]! < mnx) mnx = m[0]!; if (m[0]! > mxx) mxx = m[0]!; if (m[2]! < mnz) mnz = m[2]!; if (m[2]! > mxz) mxz = m[2]!; }
const CELL = 2;
const GW = Math.ceil((mxx - mnx) / CELL) + 2, GH = Math.ceil((mxz - mnz) / CELL) + 2;
const hf = new Float32Array(GW * GH).fill(NaN);
const tf = new Int8Array(GW * GH).fill(-1);
const gi = (x: number, z: number) => [Math.round((x - mnx) / CELL), Math.round((z - mnz) / CELL)];
for (const p of patches) {
  const P = p.Points.map(M);
  let a1 = 1e9, a2 = -1e9, b1 = 1e9, b2 = -1e9;
  for (const q of P) { a1 = Math.min(a1, q[0]!); a2 = Math.max(a2, q[0]!); b1 = Math.min(b1, q[2]!); b2 = Math.max(b2, q[2]!); }
  const ru = Math.min(96, Math.max(6, Math.ceil((a2 - a1) / CELL) + 1));
  const rv = Math.min(96, Math.max(6, Math.ceil((b2 - b1) / CELL) + 1));
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

// race lines, resampled to 4 m
const aip = j("AIP.json");
interface RL { name: string; pts: number[][] }
const race: RL[] = aip.RaceLines.map((rl: any) => {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  return { name: rl.Name, pts };
});
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

// calibrate the line's float height: median (line - terrain) where small
const offs: number[] = [];
for (const L of race) for (const p of resample(L.pts, 8)) {
  const h = H(p[0]!, p[2]!);
  if (!isNaN(h)) { const d = p[1]! - h; if (d > -3 && d < 10) offs.push(d); }
}
offs.sort((a, b) => a - b);
const FLOAT = offs[Math.floor(offs.length / 2)]!;
console.log(`race-line float height above terrain: median ${FLOAT.toFixed(1)} m (n=${offs.length})`);

// airborne segments: clearance > FLOAT + 3.5 m (or no terrain)
const TN: Record<number, string> = { 1: "snow", 3: "powder", 4: "slowpow", 5: "ice", 9: "rock", 10: "wall", 18: "ramp", 0: "reset", 17: "nocol", [-1]: "void" };
interface Jump { line: string; at: number; flight: number; drop: number; lipDelta: number; approach: number; landSlope: number; landSurf: string; clearMax: number }
const jumps: Jump[] = [];
for (const L of race) {
  const sp = resample(L.pts, 4);
  const clear = sp.map(p => { const h = H(p[0]!, p[2]!); return isNaN(h) ? 999 : p[1]! - h; });
  let s0 = -1;
  for (let i = 1; i < sp.length; i++) {
    const air = clear[i]! > FLOAT + 3.5;
    if (air && s0 < 0) s0 = i;
    if ((!air || i === sp.length - 1) && s0 > 0) {
      const len = (i - s0) * 4;
      if (len >= 12 && s0 > 5 && i < sp.length - 5) {
        // takeoff at s0-1, landing at i
        const tAlt = (s: number) => H(sp[s]![0]!, sp[s]![2]!);
        const lipNear = (tAlt(s0 - 1) - tAlt(s0 - 3)) / 8;   // terrain slope last 8 m before lip (+ = rising)
        const lipFar = (tAlt(s0 - 3) - tAlt(s0 - 6)) / 12;
        const lipDelta = (Math.atan(lipNear) - Math.atan(lipFar)) * 180 / Math.PI;
        const approach = -(sp[s0 - 1]![1]! - sp[Math.max(0, s0 - 8)]![1]!) / (7 * 4) * 100; // line grade % before
        const landSlope = (Math.atan((tAlt(i + 1) - tAlt(Math.min(sp.length - 1, i + 4))) / 12) * 180) / Math.PI; // + = falling away
        const drop = tAlt(s0 - 1) - tAlt(i);
        let cmax = 0;
        for (let k = s0; k < i; k++) if (clear[k]! < 900 && clear[k]! > cmax) cmax = clear[k]!;
        const surf = TN[T(sp[i]![0]!, sp[i]![2]!)] ?? "?";
        if (!isNaN(lipDelta) && !isNaN(drop))
          jumps.push({ line: L.name, at: s0 * 4, flight: len, drop, lipDelta, approach, landSlope, landSurf: surf, clearMax: cmax });
      }
      s0 = -1;
    }
  }
}
console.log(`\n=== AIRBORNE SEGMENTS (flight ≥12 m) on the 14 race lines: ${jumps.length} ===`);
console.log("line           at(m)  flight  drop(m)  lipΔ°   approach%  landSlope°  landSurf  maxClear");
for (const jp of jumps.sort((a, b) => b.flight - a.flight))
  console.log(`${jp.line.padEnd(13)} ${String(jp.at).padStart(5)}  ${String(jp.flight).padStart(5)}  ${jp.drop.toFixed(0).padStart(6)}  ${jp.lipDelta.toFixed(0).padStart(5)}  ${jp.approach.toFixed(0).padStart(8)}  ${jp.landSlope.toFixed(0).padStart(9)}  ${jp.landSurf.padStart(8)}  ${jp.clearMax >= 900 ? "  void" : jp.clearMax.toFixed(0).padStart(6)}`);
const med = (a: number[]) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]!; };
if (jumps.length) {
  console.log(`\nmedians: flight ${med(jumps.map(j2 => j2.flight))} m, drop ${med(jumps.map(j2 => j2.drop)).toFixed(0)} m, lipΔ ${med(jumps.map(j2 => j2.lipDelta)).toFixed(1)}°, landing slope ${med(jumps.map(j2 => j2.landSlope)).toFixed(0)}°`);
  const surfs: Record<string, number> = {};
  for (const jp of jumps) surfs[jp.landSurf] = (surfs[jp.landSurf] ?? 0) + 1;
  console.log("landing surfaces:", Object.entries(surfs).map(([k, v]) => `${k}:${v}`).join("  "));
  console.log("lipΔ > +5° (built kicker):", jumps.filter(j2 => j2.lipDelta > 5).length, "| lipΔ -5..5 (rolled edge):", jumps.filter(j2 => Math.abs(j2.lipDelta) <= 5).length, "| lipΔ < -5° (terrain just falls away):", jumps.filter(j2 => j2.lipDelta < -5).length);
}

// ShowOff ramps + TrickOnly patches
console.log("\n=== BUILT FEATURES ===");
const ramps = patches.filter(p => p.SurfaceType === 18);
const trick = patches.filter(p => p.TrickOnlyPatch);
const cent = (p: any) => { let x = 0, y = 0, z = 0; for (const q of p.Points) { const m = M(q); x += m[0]!; y += m[1]!; z += m[2]!; } return [x / 16, y / 16, z / 16]; };
// nearest race-line distance for each ramp
const allPts: number[][] = [];
for (const L of race) for (const p of resample(L.pts, 12)) allPts.push(p);
const ndist = (c: number[]) => { let d = 1e9; for (const p of allPts) { const dd = Math.hypot(p[0]! - c[0]!, p[2]! - c[2]!); if (dd < d) d = dd; } return d; };
const rd = ramps.map(p => ndist(cent(p)));
console.log(`ShowOff ramps (type 18): ${ramps.length}; distance to nearest race line: med ${med(rd).toFixed(0)} m, max ${Math.max(...rd).toFixed(0)} m`);
const tTypes: Record<string, number> = {};
for (const p of trick) tTypes[TN[p.SurfaceType] ?? p.SurfaceType] = (tTypes[TN[p.SurfaceType] ?? p.SurfaceType] ?? 0) + 1;
const td = trick.map(p => ndist(cent(p)));
console.log(`TrickOnly patches: ${trick.length}; types: ${JSON.stringify(tTypes)}; dist to race line med ${med(td).toFixed(0)} m`);
// ramp slope: analytic normal at centre
const bez1d = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c); };
const rampSlopes = ramps.map(p => {
  const P = p.Points.map(M);
  const e = ((u: number, v: number) => {
    const du: number[] = [], dv: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = [0, 1, 2, 3].map(rr => bez1(P[rr * 4]![i]!, P[rr * 4 + 1]![i]!, P[rr * 4 + 2]![i]!, P[rr * 4 + 3]![i]!, u));
      const rdv = [0, 1, 2, 3].map(rr => bez1d(P[rr * 4]![i]!, P[rr * 4 + 1]![i]!, P[rr * 4 + 2]![i]!, P[rr * 4 + 3]![i]!, u));
      du.push(bez1(rdv[0]!, rdv[1]!, rdv[2]!, rdv[3]!, v));
      dv.push(bez1d(r[0]!, r[1]!, r[2]!, r[3]!, v));
    }
    return { du, dv };
  })(0.5, 0.5);
  const n = [e.du[1]! * e.dv[2]! - e.du[2]! * e.dv[1]!, e.du[2]! * e.dv[0]! - e.du[0]! * e.dv[2]!, e.du[0]! * e.dv[1]! - e.du[1]! * e.dv[0]!];
  return (Math.acos(Math.abs(n[1]!) / (Math.hypot(...n) || 1)) * 180) / Math.PI;
});
console.log(`ramp surface tilt: med ${med(rampSlopes).toFixed(0)}°, p90 ${rampSlopes.sort((a, b) => a - b)[Math.floor(rampSlopes.length * 0.9)]!.toFixed(0)}°`);
