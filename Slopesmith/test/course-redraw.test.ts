// tier: fast

import { redrawCourse, seatRunOnTerrain, courseCenters, startFrame } from '../src/core/doc/course';
import { blankMountain, buildMeshFromCourse, coursePathFromLine, defaultMountain } from '../src/core/doc/mountain';
import { buildMountainLevel } from '../src/core/export/level';
import { surfaceSampleAt, surfaceSamplesAt } from '../src/core/mesh/surface-height';
import type { CoursePath, V3 } from '../src/core/doc/types';
import { check, failures, near } from './check';

/**
 * Scene ▸ Course keeps the run on the snow without a button for it (docs/002 · Seating the run): reset course
 * replaces the line with clicked terrain points, and the editor re-seats the knots and the placed start / finish
 * flags after every sculpt stroke and Edit drag. These pin the two core halves of that — the redraw and the seat —
 * and the batched surface sampler the seat now runs on.
 */

const mountain = () => {
  const cur = defaultMountain();
  return buildMeshFromCourse(cur.course, { widthM: 400, roughness: 0.5, targetPatchM: 50, seed: 12345 },
    { name: cur.name, baseSurface: cur.baseSurface })!;
};

// ---- the batched sampler is the single-point sampler, many times over one build --------------------------------
{
  const doc = mountain();
  const centers = courseCenters(doc.course);
  const probes: [number, number][] = [
    ...centers.map(c => [c[0], c[2]] as [number, number]),
    ...centers.map(c => [c[0] + 37.5, c[2] - 12.25] as [number, number]),
    [1e6, 1e6], // off the mountain entirely
  ];
  const batched = surfaceSamplesAt(doc, probes);
  const single = probes.map(([x, z]) => surfaceSampleAt(doc, x, z));
  check(batched.every((b, i) => {
    const s = single[i];
    return b === null ? s === null : s !== null && b.height === s.height && b.quad === s.quad && b.surface === s.surface;
  }), 'surfaceSamplesAt answers exactly what surfaceSampleAt does at every probe');
  check(batched.at(-1) === null, 'a point off the mountain samples as null');
}

// ---- seating lands the knots AND the placed flags, and is a no-op once seated --------------------------------
{
  const doc = mountain();
  const centers = courseCenters(doc.course);
  doc.course.start = { pos: [...centers[2]] as V3 };
  doc.course.finish = { pos: [...centers[centers.length - 3]] as V3 };
  seatRunOnTerrain(doc); // a spine sample between knots is not itself on the snow; start from a seated run
  for (const k of doc.course.knots) k.pos[1] += 25;
  doc.course.start.pos[1] -= 40;
  doc.course.finish.pos[1] += 12;

  const moved = seatRunOnTerrain(doc);
  check(near(moved, 40, 0.5), 'the seat reports the largest adjustment', `${moved.toFixed(2)} m`);
  const onSurface = (p: V3) => {
    const y = surfaceSampleAt(doc, p[0], p[2])?.height;
    return y !== undefined && Math.abs(p[1] - y) <= 1e-3;
  };
  check(doc.course.knots.every(k => onSurface(k.pos)), 'every knot is back on the terrain');
  check(onSurface(doc.course.start.pos), 'the placed START flag is seated with them');
  check(onSurface(doc.course.finish.pos), 'and so is the placed FINISH flag');

  const before = JSON.stringify(doc.course);
  check(seatRunOnTerrain(doc) === 0 && JSON.stringify(doc.course) === before,
    'seating a seated run moves nothing and writes nothing');
}

// The editor seats against the viewport's surface tree rather than the document's quilt; any ground will do.
{
  const doc = mountain();
  doc.course.start = { pos: [1, 2, 3] };
  const flat = seatRunOnTerrain(doc, points => points.map(([x]) => (x > 1e5 ? null : 7)));
  check(flat > 0 && doc.course.knots.every(k => k.pos[1] === 7) && doc.course.start.pos[1] === 7,
    'a supplied ground sampler is what the run seats on');
}

{
  const doc = mountain();
  const offTerrain: V3 = [1e6, 123, 1e6];
  doc.course.knots.push({ ...doc.course.knots[doc.course.knots.length - 1], pos: [...offTerrain] as V3 });
  seatRunOnTerrain(doc);
  check(doc.course.knots.at(-1)!.pos[1] === 123, 'a knot with no terrain under it keeps its height');
}

// ---- reset course: the clicked points become the run ----------------------------------------------------------
{
  const course: CoursePath = {
    knots: [
      { pos: [0, 100, 0], width: 140, wall: 12, bank: 5, shoulder: 20, checkpointBonus: 10 },
      { pos: [100, 50, 0], width: 80, wall: 0, bank: 0, shoulder: 8, checkpointBonus: 15 },
    ],
    blend: 45, surface: 3,
    start: { pos: [10, 95, 0] }, finish: { pos: [90, 55, 0] },
  };
  const before = JSON.stringify(course);
  check(!redrawCourse(course, [[0, 0, 0]]) && JSON.stringify(course) === before,
    'one point is not a course: the run is left untouched');

  const points: V3[] = [[5, 200, 5], [60, 150, 40], [140, 90, 70], [220, 20, 90]];
  check(redrawCourse(course, points), 'two or more points redraw the run');
  check(course.knots.length === 4 && course.knots.every((k, i) => k.pos.every((v, a) => v === points[i][a])),
    'one knot per point, start first, finish last');
  check(course.knots.every(k => k.width === 30 && k.wall === 0 && k.bank === 0 && k.shoulder === 8),
    'every new knot is a 30 m open floor, not the old head’s profile');
  check(course.knots.every(k => k.checkpointBonus === undefined), 'checkpoint bonuses go with the old stations');
  check(!course.start && !course.finish, 'placed flags are dropped — the drawn ends are the race’s ends');
  check(course.blend === 45 && course.surface === 3, 'the run’s blend and floor surface are kept');
  points[0][1] = -1;
  check(course.knots[0].pos[1] === 200, 'the knots own their positions, not the caller’s arrays');
}

// ---- nothing ships as a start-gate model; the staging plates are the props a bare mountain exports ------------
{
  const doc = mountain();
  doc.props = [];
  const files = buildMountainLevel(doc, undefined, { lighting: false });
  const groups = files.text['Props.obj'].split('\n').filter(l => l.startsWith('o ')).map(l => l.slice(2));
  check(groups.length === 2 && groups[0] === 'Mdl_StageArea_Start_0' && groups[1] === 'Mdl_StageArea_Finish_0',
    'Props.obj carries the two staging plates and no start gate', groups.join(', '));
  check(files.anchorGroups.length === 2, 'and they are the only prop models the core hands the export');
  const start = startFrame(doc.course);
  const plate = files.text['Props.obj'].split('\n').filter(l => l.startsWith('v ')).slice(0, 8)
    .map(l => l.split(' ').slice(1).map(Number)).map(([x, y, z]) => [-x / 100, z / 100, -y / 100] as V3); // raw cm → m
  const centre = [0, 2].map(axis => plate.reduce((sum, p) => sum + p[axis], 0) / plate.length);
  check(near(centre[0], start.pos[0], 0.01) && near(centre[1], start.pos[2], 0.01),
    'the start plate still stands where the field is staged');
}

// ---- a new mountain's run is a 30 m floor, whatever width the terrain was lofted to ----------------------------
{
  check(defaultMountain().course.knots.every(k => k.width === 30), 'New mountain’s starter run has a 30 m floor');
  check(coursePathFromLine([[0, 100, 0], [300, 0, 50], [600, -100, 0]]).knots.every(k => k.width === 30),
    'and so does a reference line borrowed into one');
  check(blankMountain().course.knots.every(k => k.width === 30), 'and a blank mountain’s guide run');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll course-redraw checks passed.');
process.exit(failures ? 1 : 0);
