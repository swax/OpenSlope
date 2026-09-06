/**
 * Validate our prop-lighting model against retail's own baked output (docs/032 · lighting).
 *
 * A retail level ships BOTH sides of the problem: its inputs (`Lights.json` — one type-0 directional sun,
 * one type-3 ambient, plus the type-1/2 local lamps) and the answer the original tools baked from them
 * (`Instances.json` — per-instance `AmbentLightColour` + `LightColour1..3` / `LightVector1..3`). So the
 * model can be *measured* rather than eyeballed: feed a level its own records, and the residual against its
 * own instances is the honest fidelity of the editor's preview and of what we stamp into an export.
 *
 * That matters because the preview is only trustworthy by construction — author a mountain, preview it,
 * ship it, and it looks the same — if the same code reproduces a shipped level from a shipped level's
 * inputs. Calibrating on one hand-picked number is how INSTANCE_LIGHT_SCALE went wrong twice.
 *
 * Run: npx tsx tools/reference-study/ref-lighting.ts [LEVEL ...]     (default: every extracted level)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildReferenceMesh } from '../../src/core/reference/terrain';
import { bakeSunShadow, bakeAO } from '../../src/core/lighting/occlusion';
import { decodePng } from '../../src/server/routes/png';
import type { LightmapSet } from '../../src/core/lighting/lightmap';
import { propInstanceLight } from '../../src/core/lighting/prop-lights';
import { DEFAULT_SUN } from '../../src/core/doc/types';
import type { SunLight, V3 } from '../../src/core/doc/types';

import { mapsRoot } from '../../src/server/workspace-config';

const LEVELS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['GARI', 'ELYSIUM', 'MERQUER', 'MESA', 'SNOW'];

/** The half-bright constant retail bakes with: every level's brightest instance key is EXACTLY its sun
 *  record × 128, measured across GARI / ELYSIUM / MERQUER / MESA (SNOW's brightest key is a 6858-magnitude
 *  lamp, not the sun). The same 128 is the `AmbentLightColour` alpha every shipped instance carries. */
const RETAIL_SCALE = 128;

const editorFromRaw = (p: number[]): V3 => [-p[0] / 100, p[2] / 100, -p[1] / 100];
const unit = (v: number[]): number[] => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const peak = (c: number[]) => Math.max(c[0], c[1], c[2]);
const angleDeg = (a: number[], b: number[]) =>
  (Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180) / Math.PI;

const pct = (xs: number[], p: number) => xs.length ? xs.slice().sort((x, y) => x - y)[Math.min(xs.length - 1,
  Math.floor((xs.length * p) / 100))] : NaN;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);

interface LightRec { Type: number; Colour: number[]; Direction: number[]; Position: number[] }
interface InstRec {
  InstanceName: string; Location: number[]; Rotation: number[];
  AmbentLightColour: number[]; LightColour1: number[]; LightVector1: number[];
  LightColour2: number[]; LightColour3: number[];
}

/**
 * `LightVector1` is stored in the instance's OWN space, not the world's: rotating the world sun by the
 * instance's inverse quaternion reproduces it to **0.0°, on 100% of instances**, across GARI / ELYSIUM /
 * MERQUER / MESA (~13,000 of them). The engine dots it straight against model-space normals, so no
 * per-vertex transform is needed at draw time. Comparing a stored vector against a world-space sun without
 * undoing that rotation reads as a 25–45° "spread" that is purely the instances' own yaw — which is exactly
 * what this harness reported before, and what nearly sent us building a local-light solver for it.
 *
 * (Our own export writes the placement pose directly in Instances.json and localizes the structured mesh
 * against it, so the same model-space rule applies.)
 */
function quatRotate(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q;
  let cx = y * v[2] - z * v[1], cy = z * v[0] - x * v[2], cz = x * v[1] - y * v[0];
  cx += w * v[0]; cy += w * v[1]; cz += w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
}

/** Rebuild a `SunLight` from the level's OWN records — the input side of the comparison. */
function sunFromRecords(sun: LightRec, amb: LightRec | undefined): SunLight {
  // the record stores the from-light propagation vector; el/az describe the toward-light one
  const t = unit(sun.Direction).map(c => -c);
  const el = (Math.asin(Math.max(-1, Math.min(1, t[2]))) * 180) / Math.PI;
  const az = (Math.atan2(-t[1], -t[0]) * 180) / Math.PI;
  const hex = (c: number[]) => {
    const m = peak(c) || 1;
    const b = c.map(v => Math.max(0, Math.min(255, Math.round((v / m) * 255))));
    return `#${b.map(v => v.toString(16).padStart(2, '0')).join('')}`;
  };
  return {
    ...DEFAULT_SUN, on: true, el, az,
    sun: peak(sun.Colour), ambient: amb ? peak(amb.Colour) : DEFAULT_SUN.ambient,
    sunTint: hex(sun.Colour), skyTint: amb ? hex(amb.Colour) : DEFAULT_SUN.skyTint,
    bakeExposure: 1, bakeAmbient: undefined,
  };
}

/** A level's own shipped lightmap pages, decoded to the A_S intensity the terrain ships with. This is the
 *  input side of the prop-lighting law: retail's per-instance key tracks the ground's baked light, so the
 *  honest test feeds a level its OWN lightmap and asks whether we reproduce its OWN instances. */
function loadLightmaps(dir: string): LightmapSet {
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lm: LightmapSet = new Map();
  for (let id = 0; id <= 15; id++) {
    const f = join(dir, 'Lightmaps', String(id).padStart(4, '0') + '.png');
    if (!existsSync(f)) continue;
    const { w, h, data } = decodePng(readFileSync(f));
    const px = w * h, a = new Float32Array(px), rgb = new Float32Array(px * 3);
    for (let k = 0; k < px; k++) {
      const as = data[k * 4 + 3] / 255; a[k] = as;
      const kk = (as * 255) / 128;
      rgb[k * 3] = clamp01((0.5 - data[k * 4] / 255) * kk);
      rgb[k * 3 + 1] = clamp01((0.5 - data[k * 4 + 1] / 255) * kk);
      rgb[k * 3 + 2] = clamp01((0.5 - data[k * 4 + 2] / 255) * kk);
    }
    lm.set(id, { a, rgb });
  }
  return lm;
}

/** Nearest terrain vertex in XZ — the ground a prop stands on. Mirrors `sampleGroundLight` in the bake. */
function groundSampler(positions: Float32Array): (x: number, z: number) => number {
  const CELL = 4, grid = new Map<string, number[]>();
  const vc = positions.length / 3;
  for (let i = 0; i < vc; i++) {
    const k = `${Math.floor(positions[i * 3] / CELL)},${Math.floor(positions[i * 3 + 2] / CELL)}`;
    const b = grid.get(k); if (b) b.push(i); else grid.set(k, [i]);
  }
  return (x, z) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let r = 0; r <= 8; r++) {
      let best = -1, bd = Infinity;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const b = grid.get(`${cx + dx},${cz + dz}`); if (!b) continue;
        for (const i of b) {
          const d = (positions[i * 3] - x) ** 2 + (positions[i * 3 + 2] - z) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  };
}

function run(level: string) {
  const dir = join(mapsRoot(), level);
  for (const f of ['Lights.json', 'Instances.json', 'Patches.json']) {
    if (!existsSync(join(dir, f))) { console.log(`${level}: no ${f} — skipped`); return; }
  }
  const lights: LightRec[] = JSON.parse(readFileSync(join(dir, 'Lights.json'), 'utf8')).Lights;
  const insts: InstRec[] = JSON.parse(readFileSync(join(dir, 'Instances.json'), 'utf8')).Instances;
  const patches = JSON.parse(readFileSync(join(dir, 'Patches.json'), 'utf8')).Patches;

  const sunRec = lights.find(l => l.Type === 0);
  const ambRec = lights.find(l => l.Type === 3);
  const locals = lights.filter(l => l.Type === 1 || l.Type === 2);
  if (!sunRec) { console.log(`${level}: no type-0 sun record — skipped`); return; }
  const sun = sunFromRecords(sunRec, ambRec);

  // GROUND TRUTH: instances that carry a real directional key. The keyless ones are a separate class —
  // retail's full-bright convention (clamped-white ambient, no key: sign faces, LCD scanlines) — and
  // averaging them in would quietly flatter any model.
  const keyed = insts.filter(r => peak(r.LightColour1) >= 0.5);
  const fullBright = insts.filter(r => peak(r.LightColour1) < 0.5 && peak(r.AmbentLightColour) > 250);

  // OUR MODEL: probe each instance against the level's own terrain, exactly as an export does
  const lm = loadLightmaps(dir);
  const mesh = buildReferenceMesh(patches, lm.size ? lm : undefined, 7);
  const ground = groundSampler(mesh.positions);
  const probes = keyed.map(r => editorFromRaw(r.Location));
  const vertCount = mesh.positions.length / 3;
  const qPos = new Float32Array((vertCount + probes.length) * 3);
  const qNrm = new Float32Array((vertCount + probes.length) * 3);
  qPos.set(mesh.positions); qNrm.set(mesh.normals);
  probes.forEach((p, i) => {
    const j = (vertCount + i) * 3;
    qPos[j] = p[0]; qPos[j + 1] = p[1]; qPos[j + 2] = p[2];
    qNrm[j + 1] = 1;
  });
  const e = (sun.el * Math.PI) / 180, a = (sun.az * Math.PI) / 180;
  const dirEditor: [number, number, number] = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
  const shadow = bakeSunShadow(mesh.positions, mesh.indices, dirEditor, 1536, qPos);
  const ao = bakeAO(mesh.positions, mesh.indices, mesh.normals, 16, 1024, { positions: qPos, normals: qNrm });

  const keyErrNow: number[] = [], keyErrProp: number[] = [];
  const ambErrNow: number[] = [], ambErrProp: number[] = [];
  const dirErr: number[] = [], hueErr: number[] = [];
  const gl: number[] = [], sh: number[] = [], act: number[] = [];   // for the predictor scoreboard
  keyed.forEach((r, i) => {
    const s = shadow[vertCount + i], o = ao[vertCount + i];
    // the ground's own baked light under the instance — the term the export now feeds prop lighting
    const vi = mesh.intensity ? ground(probes[i][0], probes[i][2]) : -1;
    const g = vi >= 0 ? mesh.intensity![vi] : 1;
    const pred = propInstanceLight(sun, g, o);                 // what we ship today
    const actualKey = peak(r.LightColour1), actualAmb = peak(r.AmbentLightColour);
    // the ×128 law, driven by the ground light rather than a re-derived cast shadow
    const propKey = sun.sun * RETAIL_SCALE * (1 - sun.shadow * (1 - g));
    const propAmb = sun.ambient * RETAIL_SCALE * (1 - sun.ao * (1 - o));
    if (actualKey > 0.5) { gl.push(g); sh.push(s); act.push(actualKey / (sun.sun * RETAIL_SCALE)); }
    if (actualKey > 0.5) {
      keyErrNow.push(peak(pred.key) / actualKey);
      keyErrProp.push(propKey / actualKey);
      // compare in WORLD space: rotate the stored (instance-local) vector out by the instance's own quaternion
      dirErr.push(angleDeg(r.Rotation ? quatRotate(r.Rotation, r.LightVector1) : r.LightVector1, pred.dir));
      hueErr.push(angleDeg(r.LightColour1, pred.key));
    }
    if (actualAmb > 0.5) {
      ambErrNow.push(peak(pred.amb) / actualAmb);
      ambErrProp.push(propAmb / actualAmb);
    }
  });

  const band = (xs: number[]) =>
    `p25 ${pct(xs, 25).toFixed(2)}  med ${pct(xs, 50).toFixed(2)}  p75 ${pct(xs, 75).toFixed(2)}`;
  const within = (xs: number[], lo: number, hi: number) =>
    `${((100 * xs.filter(v => v >= lo && v <= hi).length) / (xs.length || 1)).toFixed(0)}%`;

  console.log(`\n=== ${level} ===`);
  console.log(`  sun record ${sunRec.Colour.map(c => c.toFixed(2)).join(', ')}  `
    + `ambient ${ambRec ? ambRec.Colour.map(c => c.toFixed(2)).join(', ') : '(none)'}  `
    + `local lamps ${locals.length}`);
  console.log(`  ${keyed.length} keyed instances, ${fullBright.length} full-bright (ambient-only) of ${insts.length}`);
  console.log(`  KEY   predicted/actual   now:      ${band(keyErrNow)}   within ±10%: ${within(keyErrNow, 0.9, 1.1)}`);
  console.log(`                           x128 law: ${band(keyErrProp)}   within ±10%: ${within(keyErrProp, 0.9, 1.1)}`);
  console.log(`  AMB   predicted/actual   now:      ${band(ambErrNow)}   within ±10%: ${within(ambErrNow, 0.9, 1.1)}`);
  console.log(`                           x128 law: ${band(ambErrProp)}   within ±10%: ${within(ambErrProp, 0.9, 1.1)}`);
  console.log(`  DIR   error vs our single sun: mean ${mean(dirErr).toFixed(1)}deg  med ${pct(dirErr, 50).toFixed(1)}deg  `
    + `within 10deg: ${((100 * dirErr.filter(v => v < 10).length) / dirErr.length).toFixed(0)}%`);
  console.log(`  HUE   error vs the sun record's tint: mean ${mean(hueErr).toFixed(1)}deg`);
  // Why the export reads the ground rather than re-deriving occlusion — kept in the report so the choice
  // stays falsifiable rather than resting on a comment. See `propInstanceLight`.
  if (gl.length > 1) {
    const corr = (a: number[], b: number[]) => {
      const ma = mean(a), mb = mean(b);
      let n = 0, da = 0, db = 0;
      for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
      return n / (Math.sqrt(da * db) || 1);
    };
    console.log(`  PRED  correlation with retail's own key factor:`
      + `  ground light ${corr(gl, act).toFixed(3)}   (cast shadow ${corr(sh, act).toFixed(3)})`);
  }
}

console.log('Validating the prop-lighting model against retail\'s own baked instances.');
console.log('A ratio of 1.00 means we reproduce what the original tools baked.');
for (const l of LEVELS) run(l);
