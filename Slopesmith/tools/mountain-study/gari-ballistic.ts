// GARI speed-jump study: 1D ballistic simulation along the spine profile.
// A crest ejects the rider when terrain drops away faster than gravity bends the arc.
// For rider speeds 15/25/35 m/s: count ejections, flight length, air height, drop,
// landing-slope mismatch (velocity angle vs terrain angle at touchdown).
import { readFileSync } from "node:fs";
import { GARI_DIR } from "./paths.ts";

const DIR = GARI_DIR;
const j = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

// spine profile from race-line altitudes (lines 0..5), 5 m plan sampling
const aip = j("AIP.json");
const race: number[][][] = aip.RaceLines.map((rl: any) => {
  let [ax, ay, az] = rl.PathPos;
  const pts: number[][] = [];
  for (const p of rl.PathPoints) { ax += p[0]; ay += p[1]; az += p[2]; pts.push([-ax / 100, -ay / 100, az / 100]); }
  return pts;
});
const spine: number[][] = [];
for (const li of [0, 1, 2, 3, 4, 5]) for (const p of race[li]!) {
  if (spine.length && Math.hypot(p[0]! - spine[spine.length - 1]![0]!, p[2]! - spine[spine.length - 1]![2]!) < 5) continue;
  spine.push(p);
}
const STEP = 5;
const prof: number[] = [];
{
  let carry = 0;
  prof.push(spine[0]![1]!);
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1]!, b = spine[i]!;
    const l = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
    let d = carry;
    while (d <= l) { prof.push(a[1]! + (b[1]! - a[1]!) * (d / l)); d += STEP; }
    carry = d - l;
  }
}
const hAt = (s: number) => { // linear interp, s in metres of plan distance
  const f = s / STEP, i = Math.floor(f);
  if (i < 0 || i + 1 >= prof.length) return NaN;
  return prof[i]! * (1 - (f - i)) + prof[i + 1]! * (f - i);
};
const g = 9.81; // real gravity: SSX rides close enough to it that a doubled game-style value reads wrong here

console.log(`spine profile: ${(prof.length * STEP / 1000).toFixed(2)} km`);
for (const v of [15, 25, 35]) {
  let i = 4;
  const flights: { at: number; len: number; maxAir: number; drop: number; mismatch: number }[] = [];
  while (i < prof.length - 10) {
    const s0 = i * STEP;
    // local slope at takeoff (downhill positive descent)
    const slope = (hAt(s0) - hAt(s0 - STEP)) / STEP; // dh/ds in travel direction (h decreasing => negative)
    // launch: horizontal speed component along plan distance, vertical from slope
    const vH = v / Math.hypot(1, slope);
    const vV = vH * slope; // dh/dt at launch (negative going down)
    // does the parabola rise above terrain ahead? simulate
    let t = 0, landed = false, maxAir = 0, sL = s0, hL = hAt(s0);
    for (let k = 1; k < 400; k++) {
      t = k * 0.02;
      const s = s0 + vH * t;
      const y = hAt(s0) + vV * t - 0.5 * g * t * t;
      const ht = hAt(s);
      if (isNaN(ht)) break;
      const air = y - ht;
      if (air > maxAir) maxAir = air;
      if (air <= 0 && k > 2) { landed = true; sL = s; hL = ht; break; }
    }
    if (landed && maxAir > 0.6 && sL - s0 >= 8) {
      const vVl = vV - g * t;
      const velAng = Math.atan2(vVl, vH);
      const terrAng = Math.atan2(hAt(sL + STEP) - hAt(sL), STEP);
      flights.push({ at: s0, len: sL - s0, maxAir, drop: hAt(s0) - hL, mismatch: ((velAng - terrAng) * 180) / Math.PI });
      i = Math.ceil(sL / STEP) + 1;
    } else i++;
  }
  const med = (a: number[]) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? NaN; };
  const p90 = (a: number[]) => { a.sort((x, y) => x - y); return a[Math.floor(a.length * 0.9)] ?? NaN; };
  console.log(`\nv=${v} m/s (${(v * 3.6).toFixed(0)} km/h): ${flights.length} airborne events (${(flights.length / (prof.length * STEP / 1000)).toFixed(1)}/km)`);
  if (flights.length) {
    console.log(`  flight len: med ${med(flights.map(f => f.len)).toFixed(0)} m, p90 ${p90(flights.map(f => f.len)).toFixed(0)} m, max ${Math.max(...flights.map(f => f.len)).toFixed(0)} m`);
    console.log(`  air height: med ${med(flights.map(f => f.maxAir)).toFixed(1)} m, p90 ${p90(flights.map(f => f.maxAir)).toFixed(1)} m`);
    console.log(`  drop:       med ${med(flights.map(f => f.drop)).toFixed(0)} m, p90 ${p90(flights.map(f => f.drop)).toFixed(0)} m`);
    console.log(`  landing-slope mismatch: med ${Math.abs(med(flights.map(f => Math.abs(f.mismatch)))).toFixed(0)}°, p90 ${p90(flights.map(f => Math.abs(f.mismatch))).toFixed(0)}° (small = terrain matches the arc)`);
    const big = flights.filter(f => f.len > 40).sort((a, b) => b.len - a.len).slice(0, 6);
    if (big.length) console.log(`  biggest: ${big.map(f => `${f.len.toFixed(0)}m@${(f.at / 1000).toFixed(2)}km(drop ${f.drop.toFixed(0)}m)`).join(", ")}`);
  }
}
