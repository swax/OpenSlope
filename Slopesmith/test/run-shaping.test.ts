// tier: fast

/**
 * The run's cross-section pressed into the mesh (core/doc/run-shaping) — the operation that makes a knot's
 * `width` / `wall` / `bank` / `shoulder` mean something on the terrain the editor holds.
 *
 * Everything here rides a hand-built flat plane under a dead-straight run, because the point of each check is
 * one number of the profile and a generated hill would only hide it. The straight run is along −Z, which makes
 * the rider's right +X, so a vertex's x IS its signed lateral offset and every expectation below can be read
 * off `crossHeight` by hand.
 *
 * Run: npx tsx test/run-shaping.test.ts
 */
import {
  crossHeight, crossReach, profileWarnings, shapeRunIntoTerrain,
} from '../src/core/doc/run-shaping';
import { seedMeshIds } from '../src/core/doc/ids';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import type { CourseKnot, CoursePath, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { check, failures, near } from './check';

const SPACING = 20;
const GROUND = -40;

/** A flat plane of `SPACING` quads, spanning ±halfX across the run and 0..−lengthZ down it. */
function plane(halfX: number, lengthZ: number, course: CoursePath): QuadMeshDoc {
  const cols = Math.round((2 * halfX) / SPACING) + 1;
  const rows = Math.round(lengthZ / SPACING) + 1;
  const vertices: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) vertices.push(-halfX + c * SPACING, GROUND, -r * SPACING);
  }
  const quads: number[][] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      quads.push([a, a + 1, a + cols, a + cols + 1]);
    }
  }
  return {
    kind: 'mountain', version: 5, name: 'SHAPETEST', spacing: SPACING, baseSurface: 3,
    course, vertices, quads, ...seedMeshIds(0, vertices.length / 3, quads.length),
    effects: createEmptyEffectsDocument('SHAPETEST'),
  };
}

const straight = (profile: Omit<CourseKnot, 'pos'>): CoursePath => ({
  knots: [0, -200, -400].map((z): CourseKnot => ({ ...profile, pos: [0, 0, z] as V3 })),
  blend: 40, surface: 1,
});

/** Vertex heights on the middle row, keyed by their lateral offset — the cross-section, measured. */
function section(doc: QuadMeshDoc, z: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < doc.vertices.length; i += 3) {
    if (Math.abs(doc.vertices[i + 2] - z) > 1e-6) continue;
    out.set(Math.round(doc.vertices[i]), doc.vertices[i + 1]);
  }
  return out;
}

// ---- the profile lands where crossHeight says it does -------------------------------------------------------
{
  // Floor to ±60, a 40 m wall crested at ±100, a 10 m shoulder to ±110, then 40 m of blend to ±150. Every one
  // of those lands on a 20 m grid line, so each check below reads a vertex rather than an interpolation.
  const shape = { width: 120, wall: 40, bank: 0, shoulder: 10 };
  const doc = plane(300, 400, straight(shape));
  const done = shapeRunIntoTerrain(doc, { subsamples: 1 });
  const at = section(doc, -200);

  check(near(at.get(0) ?? NaN, 0, 1e-9), 'the floor centre sits on the run itself', `${at.get(0)?.toFixed(3)} m`);
  check(near(at.get(60) ?? NaN, 0, 1e-9), 'the floor is flat all the way to its edge', `${at.get(60)?.toFixed(3)} m at ±60`);
  check(near(at.get(100) ?? NaN, 40, 1e-9), 'the wall reaches its authored height at the crest', `${at.get(100)?.toFixed(2)} m`);
  check(near(at.get(80) ?? NaN, 20, 1e-9), 'the wall is half-height half-way up (smoothstep)', `${at.get(80)?.toFixed(2)} m`);
  check(near(at.get(-100) ?? NaN, 40, 1e-9), 'unbanked, both walls are the same height', `${at.get(-100)?.toFixed(2)} m`);
  check(near(at.get(160) ?? NaN, GROUND, 1e-9),
    'past the shoulder plus the blend the terrain is untouched', `${at.get(160)?.toFixed(2)} m vs ${GROUND}`);
  check((at.get(120) ?? 0) > GROUND && (at.get(120) ?? 0) < 42,
    'the blend band lands between the shoulder and the hill', `${at.get(120)?.toFixed(2)} m`);
  check(done.moved > 0 && done.maxAdjust > 40, 'the pass reports what it moved',
    `${done.moved} points, largest ${done.maxAdjust.toFixed(1)} m`);
  check(near(crossReach(shape), 110, 1e-9), 'crossReach is floor + wall + shoulder');

  // The profile is an ABSOLUTE target inside its reach, so re-asserting it moves nothing there. The blend band
  // is deliberately not: it mixes with the terrain it finds, so each pass draws it a little further in.
  shapeRunIntoTerrain(doc, { subsamples: 1 });
  const second = section(doc, -200);
  check(near(second.get(0) ?? NaN, 0, 1e-9) && near(second.get(100) ?? NaN, 40, 1e-9),
    'a second pass leaves the channel exactly where it was',
    `centre ${second.get(0)?.toFixed(3)} m, crest ${second.get(100)?.toFixed(3)} m`);
  check((second.get(120) ?? 0) > (at.get(120) ?? 0),
    'while the blend band converges further toward the ribbon',
    `${at.get(120)?.toFixed(1)} m → ${second.get(120)?.toFixed(1)} m`);
}

// ---- bank rolls the section, and it rolls the walls with it -------------------------------------------------
{
  const bank = 10;
  const doc = plane(300, 400, straight({ width: 120, wall: 40, bank, shoulder: 10 }));
  shapeRunIntoTerrain(doc, { subsamples: 1 });
  const at = section(doc, -200);
  const tilt = 60 * Math.sin((bank * Math.PI) / 180);

  check(near(at.get(60) ?? NaN, tilt, 1e-9), 'positive bank raises the rider’s right floor edge',
    `+${at.get(60)?.toFixed(2)} m at +60`);
  check(near(at.get(-60) ?? NaN, -tilt, 1e-9), '…and drops their left by the same', `${at.get(-60)?.toFixed(2)} m at −60`);
  check((at.get(100) ?? 0) > (at.get(-100) ?? 0), 'the uphill wall crest stands above the downhill one',
    `${at.get(100)?.toFixed(1)} m vs ${at.get(-100)?.toFixed(1)} m`);
  // The trap the warnings exist for: the DOWNHILL crest must still be above the floor it contains.
  check((at.get(-100) ?? 0) > 0, 'a contained bank still holds a rider in on the downhill side',
    `crest ${at.get(-100)?.toFixed(1)} m above the centre`);
}

// ---- profileWarnings names the two ways a bank goes wrong ---------------------------------------------------
{
  const spilled = { width: 140, wall: 24, bank: -24, shoulder: 20 };
  const contained = { width: 140, wall: 36, bank: -12, shoulder: 20 };
  const crest = crossHeight(spilled, spilled.width / 2 + spilled.wall);

  check(crest < 0, 'the spilled section really does open on its downhill side',
    `crest sits ${crest.toFixed(1)} m below the floor`);
  check(profileWarnings(spilled).some(w => w.includes('nothing holds a rider in')),
    'a bank its wall cannot survive is reported');
  check(profileWarnings(spilled).some(w => w.includes('past the')),
    'so is an uphill wall too steep to hold');
  check(!profileWarnings(contained).length, 'a contained banked turn reports nothing',
    `wall ${contained.wall} m against ${Math.abs(contained.bank)}°`);
  check(!profileWarnings({ width: 200, wall: 0, bank: 0, shoulder: 30 }).length,
    'an open unbanked channel reports nothing');
}

// ---- locked patches are honoured, exactly as sculpt honours them --------------------------------------------
{
  const course = straight({ width: 120, wall: 20, bank: 0, shoulder: 10 });
  const doc = plane(300, 400, course);
  // Lock every patch the floor runs through at one row, then check its corners never moved.
  const locked: Record<number, true> = {};
  for (let q = 0; q < doc.quads.length; q++) {
    const cs = doc.quads[q].map(id => doc.vertices[id * 3 + 2]);
    if (cs.every(z => z <= -180 && z >= -220)) locked[q] = true;
  }
  doc.quadLocked = locked;
  const done = shapeRunIntoTerrain(doc, { subsamples: 1 });
  const held = new Set<number>();
  for (const q of Object.keys(locked)) for (const id of doc.quads[Number(q)]) held.add(id);
  const stillFlat = [...held].every(id => near(doc.vertices[id * 3 + 1], GROUND, 1e-9));

  check(Object.keys(locked).length > 0, 'the fixture locked some patches', `${Object.keys(locked).length}`);
  check(stillFlat, 'a locked patch keeps every corner it owns');
  check(done.held > 0, 'and the pass says how many it held', `${done.held} points`);
}

// ---- the floor strip is painted with the run's surface -------------------------------------------------------
{
  const course = straight({ width: 120, wall: 40, bank: 0, shoulder: 10 });
  course.surface = 5;
  const doc = plane(300, 400, course);
  const done = shapeRunIntoTerrain(doc, { subsamples: 1 });
  // A patch is painted by where its CENTRE sits, so the floor strip is every column whose centroid is inside
  // the 120 m floor — ±10, ±30, ±50 on this grid.
  let floor = 0, off = 0, wrong = 0;
  for (let q = 0; q < doc.quads.length; q++) {
    let cx = 0;
    for (const id of doc.quads[q]) cx += doc.vertices[id * 3] / 4;
    const painted = doc.quadPaint?.[q];
    if (Math.abs(cx) <= 60) { floor++; if (painted !== 5) wrong++; }
    else if (Math.abs(cx) > 150) { off++; if (painted !== undefined) wrong++; }
  }
  check(floor > 0 && off > 0, 'the fixture has both floor and far-field patches', `${floor} / ${off}`);
  check(!wrong && done.painted === floor, 'exactly the floor strip took the run’s surface',
    `${done.painted} painted, ${floor} on the floor, ${wrong} wrong`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nRUN SHAPING: PASS');
process.exit(failures ? 1 : 0);
