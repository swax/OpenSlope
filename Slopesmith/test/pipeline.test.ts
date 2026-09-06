/**
 * Golden pin for the mountain pipeline: every generator, the migration and the terrain sweep must produce a
 * byte-identical document and byte-identical exported level files. Run: tsx test/pipeline.test.ts
 *
 * The pins cover document migration, topology, terrain/material export, the seam-inset UV contract,
 * six-entry AIP/SOP start fields, straight and wandering AI routes, props, and race-line encoding.
 * A deliberate encoding change requires updating the corresponding expected hash.
 *
 * 'defaultMountain (AI field)' AIP.json pins the wandering-AI-lines export: each line carries a per-line RATING
 * (the record's `U3`) read off its own wander instead of a flat default — the field picks its line by matching
 * that rating to its mood ([Trailmap: 395]), so a flat table gave six riders nothing to choose between. Only the
 * wandering case is affected: with wandering off every line is the same centre route and still rates the default,
 * which is why the other AIP pins are untouched.
 */
import { createHash } from 'node:crypto';
import type { CoursePath, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { DEFAULT_SUN } from '../src/core/doc/types';
import {
  buildMeshFromCourse, courseAtHeight, courseHeight, coursePathFromLine, defaultMountain, deriveQuadMesh,
  migrateMountain, starterCourse,
} from '../src/core/doc/mountain';
import { quadControlPoints } from '../src/core/mesh/topology';
import { patchNormal } from '../src/core/math/bezier';
import { seatRunOnTerrain, startFrame } from '../src/core/doc/course';
import { getVertex, setVertex, quadCount, surfOf, setSurf, texOf, setTex, clearTex } from '../src/core/doc/doc-edit';
import { buildMountainLevel, type LevelFileOpts } from '../src/core/export/level';
import { patchName } from '../src/core/export/names';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import { buildMountainPreview } from '../src/core/mesh/tessellation';

let fail = 0;
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const GOLDEN: Record<string, Record<string, string>> = {
  'defaultMountain': { doc: '138ef16db7773bf3', 'AIP.json': '2d354e43a325de60', 'SOP.json': '693c467b53eca57f', 'Patches.json': 'e83cda16c869c706', 'Props.obj': '7e8fe40612e01460' },
  'migrate(v1)': { doc: 'e9a82422371dc941', 'AIP.json': '901753e6ff0de45c', 'SOP.json': 'a673592a16e3c57b', 'Patches.json': 'afd6b63b9e0e0477', 'Props.obj': 'fd73355abcfad479' },
  'migrate(v5 passthrough)': { doc: '138ef16db7773bf3', 'AIP.json': '2d354e43a325de60', 'SOP.json': '693c467b53eca57f', 'Patches.json': 'e83cda16c869c706', 'Props.obj': '7e8fe40612e01460' },
  'migrate(garbage)': { doc: '138ef16db7773bf3', 'AIP.json': '2d354e43a325de60', 'SOP.json': '693c467b53eca57f', 'Patches.json': 'e83cda16c869c706', 'Props.obj': '7e8fe40612e01460' },
  'buildMeshFromCourse (generate terrain from run)': { doc: '8a8ac2d0f97aacc8', 'AIP.json': '88e9994eae813092', 'SOP.json': '6d8dae32f824ba52', 'Patches.json': '1bb02917de86083d', 'Props.obj': '96cbcedad8a3067a' },
  'defaultMountain (AI field)': { doc: '138ef16db7773bf3', 'AIP.json': '1d591d566514f7ed', 'SOP.json': '693c467b53eca57f', 'Patches.json': 'e83cda16c869c706', 'Props.obj': '7e8fe40612e01460' },
};

const borrowedLine = (n: number): V3[] =>
  Array.from({ length: n }, (_, i) => [i * 120, 900 - i * 55, Math.sin(i * 0.7) * 180] as V3);

/** A v1 heightfield save: `verts` + a `carves` array, the shape migrateMountain must still swallow. */
function v1Mountain() {
  const verts: number[] = [];
  for (let r = 0; r < 20; r++) for (let c = 0; c < 15; c++) verts.push(r * 30, 180 - r * 10, c * 30);
  return { kind: 'mountain', name: 'OLD', rows: 20, cols: 15, spacing: 30,
    verts,
    carves: [{ name: 'Old carve', knots: [
      { pos: [0, 100, 100], width: 60 }, { pos: [300, 40, 140] }, { pos: [560, -20, 90] }] }],
    baseSurface: 2, paint: {} };
}

/** What `generate terrain from run` does: loft fresh cross edges around the run, carry the meta across. */
function sweptFromRun(): QuadMeshDoc {
  const cur = defaultMountain();
  return buildMeshFromCourse(cur.course, { widthM: 400, roughness: 0.5, targetPatchM: 50, seed: 12345 },
    { name: cur.name, baseSurface: cur.baseSurface, sun: cur.sun })!;
}

const cases: Array<[string, () => QuadMeshDoc, LevelFileOpts?]> = [
  ['defaultMountain', () => defaultMountain()],
  ['migrate(v1)', () => migrateMountain(v1Mountain())],
  ['migrate(v5 passthrough)', () => migrateMountain(defaultMountain())],
  ['migrate(garbage)', () => migrateMountain({ nope: 1 })],
  ['buildMeshFromCourse (generate terrain from run)', sweptFromRun],
  ['defaultMountain (AI field)', () => defaultMountain(), { aiPaths: true }],
];

console.log('== golden: document + exported level files ==');
for (const [label, make, opts] of cases) {
  const doc = make();
  doc.sun = { ...DEFAULT_SUN, on: false }; // the lightmap bake is slow and orthogonal; hash the geometry
  const got: Record<string, string> = { doc: sha(JSON.stringify(doc)) };
  const files = buildMountainLevel(doc, undefined, opts);
  for (const k of Object.keys(files.text).sort()) got[k] = sha(files.text[k]);

  const aip = JSON.parse(files.text['AIP.json']) as { StartPosList?: number[]; AIPaths?: unknown[] };
  const starts = aip.StartPosList ?? [];
  const startFieldOk = starts.length === 6
    && starts.every(i => Number.isInteger(i) && i >= 0 && i < (aip.AIPaths?.length ?? 0));
  if (!startFieldOk) { fail++; console.error(`FAIL ${label}: AIP race field is not six valid start paths`); }

  const want = GOLDEN[label];
  const diffs = Object.keys(want).filter(k => got[k] !== want[k]);
  if (diffs.length) { fail++; console.error(`FAIL ${label}`); for (const k of diffs) console.error(`       ${k}: want ${want[k]}, got ${got[k]}`); }
  else console.log(`ok   ${label.padEnd(46)} ${doc.quads.length} quads`);
}

console.log('\n== a patch is named by its quad, and the sidecar table joins that name to its ordinal ==');
{
  // The one place an in-memory index used to escape to disk as an identifier. Deleting a patch renumbers
  // every patch above it, so a name derived from the ordinal would rename faces that never changed (docs/039).
  const before = defaultMountain();
  const named = (doc: QuadMeshDoc) => {
    const files = buildMountainLevel(doc, undefined, { lighting: false });
    const patches = (JSON.parse(files.text['Patches.json']) as { Patches: { PatchName: string }[] }).Patches;
    return { ids: files.patchIds, names: patches.map(p => p.PatchName) };
  };
  const was = named(before);
  const cut = applyMeshDelete(before, { vertices: [], edges: [], quads: [0] });
  if (!cut.ok) throw new Error(cut.error);
  const now = named(cut.doc);

  const identifiers = was.names.every(name => /^[A-Za-z0-9_]+$/.test(name));
  const unique = new Set(was.names).size === was.names.length;
  const joins = was.ids.length === was.names.length
    && was.ids.every((id, at) => was.names[at] === patchName(id));
  // Every surviving patch keeps the name it had, at a new ordinal — which is exactly what the sidecar's
  // id → ordinal table is for.
  const survivors = now.ids.map((id, at) => [was.ids.indexOf(id), at] as const).filter(([then]) => then >= 0);
  const kept = survivors.every(([then, at]) => was.names[then] === now.names[at]);
  const renumbered = survivors.some(([then, at]) => then !== at);
  const dropped = was.ids.length - now.ids.length;
  const ok = identifiers && unique && joins && kept && renumbered && dropped === 1;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${was.names.length} patches · identifiers ${identifiers} · unique ${unique}`
    + ` · sidecar joins ${joins} · ${survivors.length} kept their name across a delete ${kept} · renumbered ${renumbered}`);
}

console.log('\n== the document survives save -> JSON -> migrate -> load ==');
{
  const doc = defaultMountain();
  const round = migrateMountain(JSON.parse(JSON.stringify(doc)));
  const a = deriveQuadMesh(doc), b = deriveQuadMesh(round);
  let maxD = 0;
  for (let q = 0; q < a.mesh.quadCount; q++) {
    const ca = quadControlPoints(a.mesh, a.edgeHandle, q), cb = quadControlPoints(b.mesh, b.edgeHandle, q);
    for (let i = 0; i < 16; i++) for (let k = 0; k < 3; k++) maxD = Math.max(maxD, Math.abs(ca[i][k] - cb[i][k]));
  }
  const ok = maxD === 0;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} round-trip derives identically     Δ ${maxD}`);
}

console.log('\n== docedit accessors read + write the live doc ==');
{
  const doc = defaultMountain();
  setVertex(doc, 5, [1, 2, 3]);
  const v = getVertex(doc, 5);
  setSurf(doc, 7, 9);
  setTex(doc, 7, 'DONOR/0019.png');
  const painted = surfOf(doc, 7) === 9 && texOf(doc, 7) === 'DONOR/0019.png';
  clearTex(doc, 7);
  const cleared = texOf(doc, 7) === null && surfOf(doc, 7) === 9; // clearing the tile keeps the SurfaceType
  const moved = v[0] === 1 && v[1] === 2 && v[2] === 3;
  const counted = quadCount(doc) === doc.quads.length;
  const ok = moved && painted && cleared && counted;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} setVertex ${moved} · paint ${painted} · clearTex ${cleared} · quadCount ${counted}`);
}

console.log('\n== the preview tessellates the same quilt the bake consumes ==');
{
  const doc = defaultMountain();
  const p = buildMountainPreview(doc);
  const finite = p.positions.every(Number.isFinite) && p.normals.every(Number.isFinite);
  const ok = finite && p.mesh.quadCount === doc.quads.length;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.mesh.quadCount} quads · finite ${finite}`);
}

console.log('\n== the start line uses the exact first-node chord ==');
{
  const course: CoursePath = { blend: 20, surface: 1, knots: [
    { pos: [0, 100, 0], width: 100, wall: 0, bank: 0, shoulder: 0 },
    { pos: [100, 60, 20], width: 100, wall: 0, bank: 0, shoulder: 0 },
    { pos: [80, 20, 500], width: 100, wall: 0, bank: 0, shoulder: 0 }, // must not steer the start gate
  ] };
  const frame = startFrame(course);
  const chord = [100, 20] as const;
  const perpendicular = Math.abs(frame.side[0] * chord[0] + frame.side[2] * chord[1]) < 1e-9;
  const anchored = frame.pos.every((v, i) => v === course.knots[0].pos[i]);
  const ok = perpendicular && anchored;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} perpendicular ${perpendicular} · anchored ${anchored}`);
}

console.log('\n== new courses cross the retail profile box corner-to-corner ==');
{
  const height = 1500;
  const a = starterCourse(height, 300, 12345);
  const again = starterCourse(height, 300, 12345);
  const b = starterCourse(height, 300, 54321);
  const start = a.knots[0].pos, finish = a.knots[a.knots.length - 1].pos;
  const exactCorners = start[0] === 0 && start[1] === 0 && start[2] === 0
    && Math.abs(finish[0] + height * 0.68) < 1e-9 && finish[1] === -height && finish[2] === -height;
  const insideBox = a.knots.every(k => k.pos[0] >= -height * 0.68 && k.pos[0] <= 0
    && k.pos[1] >= -height && k.pos[1] <= 0 && k.pos[2] >= -height && k.pos[2] <= 0);
  const reproducible = JSON.stringify(a) === JSON.stringify(again);
  const variedInterior = a.knots.slice(1, -1).some((k, i) =>
    k.pos.some((v, axis) => Math.abs(v - b.knots[i + 1].pos[axis]) > 1e-6));
  const defaultWidth = starterCourse().knots.every(k => k.width === 400);
  const ok = exactCorners && insideBox && reproducible && variedInterior && defaultWidth;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} corners ${exactCorners} · inside ${insideBox} · seeded ${reproducible}/${variedInterior} · default width ${defaultWidth}`);
}

console.log('\n== steep reference courses keep their requested terrain width ==');
{
  // Model the shape that exposed this on GARI without depending on its ignored extracted SOP.json: a long
  // descent whose second 150 m segment moves only ~31 m overhead. Resampling in 3D used to place 300 m cross
  // rails that close together in overhead view, shrinking the corresponding nodes to 34/84 m bottlenecks.
  const firstZ = -Math.sqrt(7_200);
  const second: V3 = [122, -30 - Math.sqrt(21_535), firstZ - 31];
  const steepLine: V3[] = [
    [0, 0, 0],
    [120, -30, firstZ],
    second,
    ...Array.from({ length: 36 }, (_, i): V3 => [
      second[0] - 100 * (i + 1), second[1] - 80 * (i + 1), second[2] - 80 * (i + 1),
    ]),
  ];
  const width = 300, target = 50;
  const referenceHeight = Math.max(...steepLine.map(p => p[1])) - Math.min(...steepLine.map(p => p[1]));
  // This is the reference-dialog path: passing the displayed raw height must not spuriously extend the tail.
  const referenceCourse = coursePathFromLine(steepLine, width, referenceHeight);
  const generated = buildMeshFromCourse(referenceCourse, {
    widthM: width, roughness: 0.5, targetPatchM: target, seed: 0,
  })!;
  const railPoints = Math.ceil(width / target) + 1;
  const primaryRailCount = generated.quads[0][1] / railPoints;
  const railWidths = Array.from({ length: primaryRailCount }, (_, rail) => {
    const a = rail * railPoints * 3, b = a + (railPoints - 1) * 3;
    return Math.hypot(generated.vertices[a] - generated.vertices[b], generated.vertices[a + 2] - generated.vertices[b + 2]);
  });
  // rail 0 is the generator's lead-in; rails 1..3 are the reference knots around the vertical drop.
  const openingMinimumWidth = Math.min(...railWidths.slice(1, 4));
  const denseDescent = referenceCourse.knots.length >= 35;
  const referenceDerived = deriveQuadMesh(generated);
  const quadsAcross = railPoints - 1;
  const openingLanes = Math.min(20, generated.quads.length / quadsAcross);
  const openingNormals = Array.from({ length: openingLanes }, (_, lane) =>
    Array.from({ length: quadsAcross }, (_, across) => patchNormal(quadControlPoints(
      referenceDerived.mesh, referenceDerived.edgeHandle, lane * quadsAcross + across,
    ), 0.5, 0.5)));
  const agrees = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] >= 0;
  const openingNormalsAgree = openingNormals.every((row, lane) => row.every((normal, across) =>
    (lane + 1 >= openingNormals.length || agrees(normal, openingNormals[lane + 1][across]))
      && (across + 1 >= row.length || agrees(normal, row[across + 1]))));
  const ok = denseDescent && Math.abs(openingMinimumWidth - width) < 1e-6 && openingNormalsAgree;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${referenceCourse.knots.length} primary knots · opening wall ${openingMinimumWidth.toFixed(1)} m · adjacent normals ${openingNormalsAgree}`);
}

console.log('\n== the common generator trims and extends course height ==');
{
  const source = coursePathFromLine([
    [0, 900, 0], [300, 700, 80], [650, 420, -40], [1000, 100, 20],
  ], 300);
  const trimmed = courseAtHeight(source, 400);
  const extended = courseAtHeight(source, 1200);
  const referenceTrimmed = coursePathFromLine([
    [0, 900, 0], [300, 700, 80], [650, 420, -40], [1000, 100, 20],
  ], 300, 400);
  const trimExact = Math.abs(courseHeight(trimmed) - 400) < 1e-6
    && Math.abs(trimmed.knots[trimmed.knots.length - 1].pos[1] - 500) < 1e-6;
  const extendExact = Math.abs(courseHeight(extended) - 1200) < 1e-6
    && extended.knots.length === source.knots.length + 1;
  const refUsesSamePath = Math.abs(courseHeight(referenceTrimmed) - 400) < 1e-6
    && !!buildMeshFromCourse(referenceTrimmed, { widthM: 300, roughness: 0.5, targetPatchM: 50, seed: 1 });
  const fresh = starterCourse(1750, 300);
  const freshExact = Math.abs(courseHeight(fresh) - 1750) < 1e-6;
  const ok = trimExact && extendExact && refUsesSamePath && freshExact;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} trim ${courseHeight(trimmed).toFixed(1)} m · extend ${courseHeight(extended).toFixed(1)} m · fresh ${courseHeight(fresh).toFixed(1)} m · shared ref ${refUsesSamePath}`);
}

console.log('\n== course terrain has visible cross-edge relief and skyward winding ==');
{
  const course = defaultMountain().course;
  const flat = buildMeshFromCourse(course, { widthM: 140, roughness: 0, targetPatchM: 50 })!;
  const rough = buildMeshFromCourse(course, { widthM: 140, roughness: 1, targetPatchM: 50 })!;
  const firstRailPoints = 5; // ceil(140/50), rounded up to an even segment count, plus one centre point
  const flatY = Array.from({ length: firstRailPoints }, (_, i) => flat.vertices[i * 3 + 1]);
  const roughY = Array.from({ length: firstRailPoints }, (_, i) => rough.vertices[i * 3 + 1]);
  const flatCrossEdge = Math.max(...flatY) - Math.min(...flatY) < 1e-9;
  const roughCrossEdge = Math.max(...roughY) - Math.min(...roughY) > 5;
  const derived = deriveQuadMesh(flat);
  const skyward = flat.quads.every((_, q) => patchNormal(quadControlPoints(derived.mesh, derived.edgeHandle, q), 0.5, 0.5)[1] > 0);
  const knotCourse: CoursePath = { blend: 20, surface: 1, knots: [
    { pos: [0, 100, 0], width: 100, wall: 0, bank: 0, shoulder: 0 },
    { pos: [200, 40, 30], width: 100, wall: 0, bank: 0, shoulder: 0 },
    { pos: [450, -20, -20], width: 100, wall: 0, bank: 0, shoulder: 0 },
  ] };
  const atKnots = buildMeshFromCourse(knotCourse, { widthM: 300, roughness: 0, targetPatchM: 50 })!;
  const perturbedAtKnots = buildMeshFromCourse(knotCourse, { widthM: 300, roughness: 1, targetPatchM: 50 })!;
  const knotCentres = knotCourse.knots.every(k => {
    for (let i = 0; i < atKnots.vertices.length; i += 3) {
      if (Math.abs(atKnots.vertices[i] - k.pos[0]) < 1e-9
        && Math.abs(atKnots.vertices[i + 2] - k.pos[2]) < 1e-9) return true;
    }
    return false;
  });
  const rerouted: CoursePath = { blend: 30, surface: 1, knots: Array.from({ length: 10 }, (_, i) => {
    const t = i / 9;
    return { pos: [-1000 + 2000 * t, 600 - 1200 * t, (t - 0.5) * 500] as V3,
      width: 140, wall: 0, bank: 0, shoulder: 8 };
  }) };
  rerouted.knots[4].pos[2] += 700; // force neighbouring full-width perpendiculars to overlap
  const regenerated = buildMeshFromCourse(rerouted, {
    widthM: 300, roughness: 0, targetPatchM: 50, seed: 1,
  });
  const movedKnot = rerouted.knots[4].pos;
  const rerouteFollows = !!regenerated && regenerated.vertices.some((_, i, vertices) =>
    i % 3 === 0 && Math.abs(vertices[i] - movedKnot[0]) < 1e-9
      && Math.abs(vertices[i + 2] - movedKnot[2]) < 1e-9);
  const borrowed = borrowedLine(9);
  const borrowedViaSharedGenerator = buildMeshFromCourse(coursePathFromLine(borrowed, 160), {
    widthM: 160, roughness: 0.4, targetPatchM: 50, seed: 0,
  }, { name: 'MOUNTAIN01', baseSurface: 1 });
  const sharedReferencePath = !!borrowedViaSharedGenerator;
  const defaults = buildMeshFromCourse(knotCourse)!;
  const explicitDefaults = buildMeshFromCourse(knotCourse, { widthM: 400, roughness: 0.5, targetPatchM: 50, seed: 0 })!;
  const defaultOptions = JSON.stringify(defaults) === JSON.stringify(explicitDefaults);
  const seededA = buildMeshFromCourse(knotCourse, { widthM: 300, roughness: 0.5, targetPatchM: 50, seed: 1234 })!;
  const seededARepeat = buildMeshFromCourse(knotCourse, { widthM: 300, roughness: 0.5, targetPatchM: 50, seed: 1234 })!;
  const seededB = buildMeshFromCourse(knotCourse, { widthM: 300, roughness: 0.5, targetPatchM: 50, seed: 5678 })!;
  const seedRepeatable = JSON.stringify(seededA) === JSON.stringify(seededARepeat);
  const seedVaries = JSON.stringify(seededA) !== JSON.stringify(seededB);
  const primaryPoints = 7; // 300 m / 50 m = six cross-edge spans plus one centre point
  const inheritedDelta = Array.from({ length: primaryPoints }, (_, c) =>
    atKnots.vertices[(primaryPoints + c) * 3 + 1] - atKnots.vertices[c * 3 + 1]);
  const perturbedDelta = Array.from({ length: primaryPoints }, (_, c) =>
    perturbedAtKnots.vertices[(primaryPoints + c) * 3 + 1] - perturbedAtKnots.vertices[c * 3 + 1]);
  const inheritedProfile = Math.max(...inheritedDelta) - Math.min(...inheritedDelta) < 1e-9;
  const incrementalPerturbation = Math.max(...perturbedDelta) - Math.min(...perturbedDelta) > 1;
  const primaryRailCount = perturbedAtKnots.quads[0][1] / primaryPoints;
  const relativeProfile = (rail: number) => Array.from({ length: primaryPoints }, (_, c) =>
    perturbedAtKnots.vertices[(rail * primaryPoints + c) * 3 + 1]
      - perturbedAtKnots.vertices[(rail * primaryPoints + primaryPoints / 2 | 0) * 3 + 1]);
  const topProfile = relativeProfile(0), bottomProfile = relativeProfile(primaryRailCount - 1);
  const correlation = (a: number[], b: number[]) => {
    const ma = a.reduce((sum, v) => sum + v, 0) / a.length, mb = b.reduce((sum, v) => sum + v, 0) / b.length;
    const covariance = a.reduce((sum, v, i) => sum + (v - ma) * (b[i] - mb), 0);
    const scale = Math.sqrt(a.reduce((sum, v) => sum + (v - ma) ** 2, 0) * b.reduce((sum, v) => sum + (v - mb) ** 2, 0));
    return scale > 1e-9 ? covariance / scale : 1;
  };
  const topBottomCorrelation = correlation(topProfile, bottomProfile);
  const decorrelated = topBottomCorrelation < 0.4; // an inverse profile is visibly different; reject retained positive shape
  let largestJump = 0, largestJumpRail = -1, largestJumpVertex = -1;
  for (let rail = 1; rail < primaryRailCount; rail++) {
    const previousProfile = relativeProfile(rail - 1), nextProfile = relativeProfile(rail);
    for (let c = 0; c < primaryPoints; c++) {
      const change = Math.abs(nextProfile[c] - previousProfile[c]);
      if (change > largestJump) { largestJump = change; largestJumpRail = rail; largestJumpVertex = c; }
    }
  }
  const hasBigJump = largestJump > 60;
  const jumpProfile = largestJumpRail >= 0 ? relativeProfile(largestJumpRail) : [];
  const afterJumpProfile = largestJumpRail + 1 < primaryRailCount ? relativeProfile(largestJumpRail + 1) : [];
  const returnsToMean = !!afterJumpProfile.length
    && Math.abs(afterJumpProfile[largestJumpVertex]) < Math.abs(jumpProfile[largestJumpVertex]) * 0.35;
  const grades = perturbedAtKnots.course.knots.slice(1).map((k, i) => {
    const a = perturbedAtKnots.course.knots[i].pos, b = k.pos;
    return (b[1] - a[1]) / Math.max(1e-9, Math.hypot(b[0] - a[0], b[2] - a[2]));
  });
  const variableDrop = Math.max(...grades) - Math.min(...grades) > 0.03;
  const seated = seatRunOnTerrain(atKnots) < 1e-6;
  const ok = flatCrossEdge && roughCrossEdge && skyward && knotCentres && rerouteFollows && sharedReferencePath
    && defaultOptions && seated
    && inheritedProfile && incrementalPerturbation && decorrelated && hasBigJump && returnsToMean && variableDrop
    && seedRepeatable && seedVaries;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} flat edge ${flatCrossEdge} · rough relief ${(Math.max(...roughY) - Math.min(...roughY)).toFixed(2)} m · skyward ${skyward} · knot rails ${knotCentres} · moved knot ${rerouteFollows} · shared ref ${sharedReferencePath} · inherited ${inheritedProfile}/${incrementalPerturbation} · jump ${largestJump.toFixed(1)} m/mean ${returnsToMean} · grade spread ${(Math.max(...grades) - Math.min(...grades)).toFixed(3)} · top/bottom r=${topBottomCorrelation.toFixed(2)} · seeds ${seedRepeatable}/${seedVaries} · seated ${seated} · defaults ${defaultOptions}`);
}

console.log('\n== generated terrain receives safety, snow, powder and shape surfaces ==');
{
  // Wide/high-relief input reaches every semantic branch, including a genuine deep gentle pocket.
  const width = 700, target = 50;
  const doc = buildMeshFromCourse(starterCourse(1500, width, 77), {
    widthM: width, roughness: 1.5, targetPatchM: target, seed: 77,
  })!;
  const quadsAcross = Math.ceil(width / target); // already even for this fixture
  const lanes = doc.quads.length / quadsAcross;
  const surface = (q: number) => doc.quadPaint?.[q] ?? doc.baseSurface;
  const isPerimeter = (lane: number, across: number) =>
    lane === 0 || lane === lanes - 1 || across === 0 || across === quadsAcross - 1;
  const isSlowRing = (lane: number, across: number) =>
    lane === 1 || lane === lanes - 2 || across === 1 || across === quadsAcross - 2;
  let perimeterOob = true, innerSlow = true;
  for (let lane = 0; lane < lanes; lane++) for (let across = 0; across < quadsAcross; across++) {
    const q = lane * quadsAcross + across;
    if (isPerimeter(lane, across)) perimeterOob &&= surface(q) === 0;
    else if (isSlowRing(lane, across)) innerSlow &&= surface(q) === 2;
  }
  const counts = Object.values(doc.quadPaint ?? {}).reduce<Record<number, number>>((out, s) => {
    out[s] = (out[s] ?? 0) + 1; return out;
  }, {});
  const semanticInterior = [1, 3, 4, 5, 9].every(s => (counts[s] ?? 0) > 0);
  const allPainted = Object.keys(doc.quadPaint ?? {}).length === doc.quads.length;
  const ok = perimeterOob && innerSlow && semanticInterior && allPainted;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} OOB ${counts[0] ?? 0} · slow ${counts[2] ?? 0} · snow ${counts[1] ?? 0} · powder ${counts[3] ?? 0} · slow powder ${counts[4] ?? 0} · ice ${counts[5] ?? 0} · rock ${counts[9] ?? 0}`);
}

console.log(fail ? `\nPIPELINE-CHECK: ${fail} FAIL` : '\nPIPELINE-CHECK: PASS');
process.exit(fail ? 1 : 0);
