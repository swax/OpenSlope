// First authored candidate: drive Slopesmith's headless course-to-mesh generator from a CoursePath that
// embodies GARI's terrain vocabulary, write Maps/OpenSlope01, then score it with Slopesmith/tools/mountain-study/score.ts.
// This is one rep of the author -> measure -> gap loop. It targets the *trail* invariants
// (avg grade ~70%, bimodal pitch/bench, terrace lips ~60-75 m, ~30% convex, wall-banked S with
// ice on the banks). It is a single lofted ribbon, so it cannot reproduce the whole-mountain
// powder-fringe surface mix - that gap is the point, and the lesson (stacked lanes need more
// than a spine loft).
import { writeFileSync, mkdirSync } from "node:fs";
import { encodePng } from "../../src/server/routes/png.ts";
import { buildLevelFiles } from "../../src/core/export/level.ts";
import { buildMeshFromCourse } from "../../src/core/doc/mountain.ts";
import { sampleSpine, totalLength } from "../../src/core/math/spine.ts";
import type { CourseKnot, CoursePath, V3 } from "../../src/core/doc/types.ts";
import { MAPS_DIR } from "./paths.ts";
import { join } from "node:path";

const NAME = "OpenSlope01";
const OUT = join(MAPS_DIR, NAME);
const D2R = Math.PI / 180;

// ---- spine builder: walk downhill emitting one knot per segment end ----------
const knots: CourseKnot[] = [];
let pos: V3 = [0, 620, 0];
let heading = 0; // plan bearing, radians; advance moves along (sin,cos) in (east,north)

function knot(width: number, wall: number, bank: number, shoulder: number) {
  knots.push({ pos: [pos[0], pos[1], pos[2]], width, wall, bank, shoulder });
}
function advance(horiz: number, drop: number, turnDeg: number) {
  heading += turnDeg * D2R;
  pos = [pos[0] + Math.sin(heading) * horiz, pos[1] - drop, pos[2] + Math.cos(heading) * horiz];
}

// Two-scale descent (Finding B): MACRO pitch/shelf segments >100 m carry the grade-band split
// (a 100 m window centered inside a sustained steep face reads >90%; inside a shelf reads flat),
// with MICRO terrace lips superimposed as a grade oscillation around the macro mean -> rollers
// (convex events) that do not move the windowed band. A single-frequency cycle averaged to mid;
// this keeps the macro mean while adding the lips.
function macro(horiz: number, gradePct: number, turn: number, w: number, wall: number, bank: number, sh: number, rollAmp = 0) {
  const segs = Math.max(2, Math.round(horiz / 12));   // ~1 knot per 12 m
  const dh = horiz / segs;
  const period = Math.max(1, Math.round(segs / 3));   // ~3 terrace lips per macro segment
  for (let i = 0; i < segs; i++) {
    const roll = rollAmp * Math.sin((i / period) * Math.PI * 2);
    advance(dh, Math.max(0, (dh * (gradePct + roll)) / 100), turn / segs);
    knot(w, wall, bank, sh);
  }
}

knot(42, 6, 0, 5);                          // gate (knot 0)
macro(48, 4, 0, 42, 6, 0, 6);               // PLATEAU (flat macro: speed-build, no decisions)
advance(20, 70, 0); knot(38, 8, 0, 6);      // LAUNCH plunge (dramatic single drop off the lip)
macro(130, 104, 6, 46, 8, 0, 9, 40);        // MACRO PITCH A: sustained steep + rollers -> steep band
macro(36, 7, 0, 40, 6, 0, 9);               // SHELF B lead-in (flat regroup)
const sIce0 = knots.length;                 // wall-banked ICE S lives on the flat shelf
advance(30, 8, 36); knot(30, 26, 16, 5);    // S entry: pinch, wall rises, bank in
advance(24, 9, 46); knot(28, 42, 30, 4);    // S apex 1: tight, tall ice wall (the fast line is high on it)
advance(28, 10, -54); knot(34, 32, -26, 4); // S reverse: wall flips side
advance(26, 7, -28); knot(40, 18, -8, 6);   // S exit straighten
const sIce1 = knots.length - 1;
macro(120, 100, 8, 48, 8, 0, 9, 34);        // MACRO PITCH C: sustained steep + rollers
macro(100, 6, -10, 46, 8, 0, 12);           // MACRO SHELF D: flat trick shelf, wide powder shoulder
macro(110, 116, 6, 40, 8, 0, 7, 30);        // FINALE: sustained steep plunge + rollers
macro(42, 28, 0, 38, 6, 0, 6);              // runout (moderate)

const course: CoursePath = { knots, blend: 20, surface: 1 };
const doc = buildMeshFromCourse(course, {
  widthM: 120,
  roughness: 0.15,
  targetPatchM: 12,
  seed: 1,
}, { name: "OpenSlope Demo One", baseSurface: 3 });
if (!doc) throw new Error("course-to-mesh generation failed");

// ---- paint the S-turn band as ice -------------------------------------------
const samples = sampleSpine(course.knots);
const total = totalLength(samples);
// arc at a given continuous knot index (first sample whose k >= target)
const arcAtKnot = (ki: number) => { const s = samples.find(s => s.k >= ki) ?? samples[samples.length - 1]; return s.s; };
const aLo = arcAtKnot(sIce0), aHi = arcAtKnot(sIce1);
const paint = (doc.quadPaint ??= {});
let icedPatches = 0;
for (let q = 0; q < doc.quads.length; q++) {
  const center: V3 = [0, 0, 0];
  for (const id of doc.quads[q]) {
    center[0] += doc.vertices[id * 3] / 4;
    center[1] += doc.vertices[id * 3 + 1] / 4;
    center[2] += doc.vertices[id * 3 + 2] / 4;
  }
  let nearest = samples[0], best = Infinity;
  for (const sample of samples) {
    const dx = center[0] - sample.pos[0], dz = center[2] - sample.pos[2];
    const distance2 = dx * dx + dz * dz;
    if (distance2 < best) { best = distance2; nearest = sample; }
  }
  if (nearest.s >= aLo && nearest.s <= aHi && best <= 55 * 55) {
    paint[q] = 5;
    icedPatches++;
  }
}

// ---- build + write the level folder -----------------------------------------
const files = buildLevelFiles(doc, undefined, { lighting: false });
mkdirSync(`${OUT}/Textures`, { recursive: true });
for (const [name, body] of Object.entries(files.text)) writeFileSync(`${OUT}/${name}`, body);
for (const [name, img] of Object.entries(files.textures)) writeFileSync(`${OUT}/Textures/${name}`, encodePng(img));

const patchCount = JSON.parse(files.text["Patches.json"]).Patches.length;
console.log(`wrote ${OUT}`);
console.log(`  knots=${knots.length} patches=${patchCount} iced patches=${icedPatches} (S arc ${aLo.toFixed(0)}..${aHi.toFixed(0)} m of ${total.toFixed(0)} m)`);
console.log(`  run: npx tsx tools/mountain-study/score.ts ${NAME}`);
