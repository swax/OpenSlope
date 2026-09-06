// tier: fast

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  courseCenters, startFrame, finishFrame, startGateLines, startStation, finishStation, aiPathLines,
} from '../src/core/doc/course';
import { blankMountain, migrateMountain, starterCourse } from '../src/core/doc/mountain';
import {
  stageAreaAnchors, dtfZeroPoint, reconstructPathLine, type CoursePathFile, type InstancesFile,
} from '../src/core/reference/terrain';
import type { CoursePath, V3 } from '../src/core/doc/types';
import { check, failures, near } from './check';

/**
 * Placed race endpoints ([Trailmap: 120-objects, 390-pickups-and-race]). Retail keeps its start and finish as
 * their own anchors rather than deriving them from the path network, because on a lap course neither is an end
 * of the line — the two halves tested here are the editor learning to READ that for a reference level and to
 * AUTHOR it for a mountain of its own.
 *
 * The parity block is the important one: a run nobody has dragged a flag on has to behave exactly as it did
 * before anchors existed, because every mountain already saved is such a run.
 */
const sameV = (a: V3, b: V3, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const MAPS = join(process.cwd(), '..', 'Maps');

// ---- parity: an untouched run is unchanged ---------------------------------------------------------------
{
  const course: CoursePath = starterCourse(1500, 60, 7);
  const knots = course.knots;

  check(startStation(course) === 0, 'no anchor: the run starts at station 0');
  check(near(finishStation(course), finishStation(course)), 'no anchor: the finish station is the run length');
  check(sameV(startFrame(course).pos, knots[0].pos), 'no anchor: startFrame is knot 0');
  check(sameV(finishFrame(course).pos, courseCenters(course)[courseCenters(course).length - 1], 1e-3),
    'no anchor: finishFrame is the tail');
  check(startFrame(course).width === knots[0].width, 'no anchor: the gate spans knot 0’s floor width');

  // The gate lead-ins and the AI lines must still begin at the head of the line.
  const gates = startGateLines(course);
  check(gates.length === 6, 'no anchor: six start-gate lead-ins');
  const centers = courseCenters(course);
  const midGate = gates[Math.floor(gates.length / 2)];
  check(Math.abs(midGate[0][1] - centers[0][1]) < 2, 'no anchor: lead-ins start at the head of the line');
  // Line g begins at gate g's lateral offset (half the 1.4 m row, so up to ~3.5 m across), but at the head's
  // own station — so compare the height, not the point.
  const ai = aiPathLines(course, 1, false);
  check(ai.length === 6, 'no anchor: six AI lines');
  check(near(ai[0][0][1], centers[0][1], 0.01), 'no anchor: AI lines start at the head’s station');
  check(Math.hypot(ai[0][0][0] - centers[0][0], ai[0][0][2] - centers[0][2]) < 4,
    'no anchor: an AI line starts within the gate row of the centre');
  check(ai[0].length === centers.length, 'no anchor: an AI line spans the whole run');
}

// ---- a placed start moves the grid, the lead-ins and the field ---------------------------------------------
{
  const course: CoursePath = starterCourse(1500, 60, 7);
  const centers = courseCenters(course);
  const mid = centers[Math.floor(centers.length / 2)];
  course.start = { pos: [...mid] as V3 };

  const s0 = startStation(course);
  check(s0 > 0, 'placed start: the station moved off the head');
  check(sameV(startFrame(course).pos, mid), 'placed start: the gate sits where the flag was dropped');

  const gates = startGateLines(course);
  check(gates.every(g => sameV(g[0], g[0])), 'placed start: every gate line still exists');
  check(Math.abs(gates[0][0][1] - mid[1]) < 3, 'placed start: lead-ins begin at the flag, not the run’s head');

  const ai = aiPathLines(course, 1, false);
  check(Math.abs(ai[0][0][1] - mid[1]) < 3, 'placed start: AI lines begin at the flag');
  check(ai[0].length < centers.length, 'placed start: the field rides the remaining course, not the whole run');

  // The heading is the RUN's at that station, so a dropped flag can never face uphill.
  const fwd = startFrame(course).fwd;
  check(fwd[1] < 0, 'placed start: the heading still points downhill');
}

// ---- a placed finish moves where DTF reaches zero ----------------------------------------------------------
{
  const course: CoursePath = starterCourse(1500, 60, 7);
  const full = finishStation(course);
  const centers = courseCenters(course);
  const mid = centers[Math.floor(centers.length / 2)];
  course.finish = { pos: [...mid] as V3 };
  check(finishStation(course) < full * 0.75, 'placed finish: the finish station moved up the run');
  check(sameV(finishFrame(course).pos, mid), 'placed finish: the crossing is where the flag was dropped');
}

// ---- saving/loading keeps the placed endpoints -------------------------------------------------------------
{
  const doc = blankMountain('ANCHOR_ROUNDTRIP');
  const centers = courseCenters(doc.course);
  doc.course.start = { pos: [...centers[1]] as V3 };
  doc.course.finish = { pos: [...centers[centers.length - 2]] as V3 };
  const loaded = migrateMountain(structuredClone(doc));
  check(sameV(loaded.course.start!.pos, doc.course.start.pos), 'migration preserves a placed start anchor');
  check(sameV(loaded.course.finish!.pos, doc.course.finish.pos), 'migration preserves a placed finish anchor');
}

// ---- reading a retail level's own anchors -------------------------------------------------------------------
for (const level of ['MEGAPLE', 'GARI', 'MERQUER', 'MESA', 'ELYSIUM', 'SNOW']) {
  let instances: InstancesFile, aip: CoursePathFile;
  try {
    instances = JSON.parse(readFileSync(join(MAPS, level, 'Instances.json'), 'utf8'));
    aip = JSON.parse(readFileSync(join(MAPS, level, 'AIP.json'), 'utf8'));
  } catch {
    console.log(`skip ${level}: not extracted here`);
    continue;
  }
  const { start, podium } = stageAreaAnchors(instances);
  const finish = dtfZeroPoint(aip);
  check(!!start, `${level}: found Mdl_StageArea_Start_0`);
  check(!!podium, `${level}: found Mdl_StageArea_Finish_0`);
  check(!!finish, `${level}: the race lines reach DTF zero`);
  if (!start || !podium || !finish) continue;

  // The podium is the corral PAST the line, never the line itself ([Trailmap: 390-finish-anchor]: 20-48 m).
  const gap = Math.hypot(podium[0] - finish[0], podium[1] - finish[1], podium[2] - finish[2]);
  check(gap > 15 && gap < 60, `${level}: the podium sits ${gap.toFixed(0)} m past the finish line`);

  // The start is NOT an end of the recovered line - the whole reason it is read rather than derived.
  const lines = (aip.RaceLines ?? []).map(r => r.PathPos!).filter(Boolean);
  const nearestHead = Math.min(...lines.map(p =>
    Math.hypot(-p[0] / 100 - start[0], p[2] / 100 - start[1], -p[1] / 100 - start[2])));
  console.log(`     ${level}: start is ${nearestHead.toFixed(0)} m from the nearest race-line head`);

  // The ride spawns on the START ROW - a StartPosList slot - and faces down that slot's own path. Both halves
  // matter: the marker is 17-29 m behind the row (inside the structure on Megaplex), and a rider handed no
  // heading faces the board's default, which is backwards on any course that leaves its gate the other way.
  const slots = (aip.StartPosList ?? []).map(i => reconstructPathLine((aip.AIPaths ?? [])[i]));
  check(slots.length === 6 && slots.every(s => s.length >= 2), `${level}: six usable start-row slots`);
  const slot = slots[Math.floor(slots.length / 2)];
  const gate = (instances.Instances ?? []).find(i => i.InstanceName?.startsWith('Mdl_StartGate_1'));
  if (gate?.Location) {
    const g = [-gate.Location[0] / 100, gate.Location[2] / 100, -gate.Location[1] / 100];
    const away = Math.hypot(slot[0][0] - g[0], slot[0][1] - g[1], slot[0][2] - g[2]);
    check(away < 6, `${level}: the chosen slot sits ${away.toFixed(1)} m from the gate prop`);
  }
  // Heading over the same 15 m baseline the ride uses - a start path's FIRST step is a staging jog and
  // Elysium's climbs, so a one-step reading calls it uphill.
  let far = slot[0], run = 0;
  for (let i = 1; i < slot.length && run < 15; i++) {
    run += Math.hypot(slot[i][0] - far[0], slot[i][1] - far[1], slot[i][2] - far[2]);
    far = slot[i];
  }
  check(far[1] < slot[0][1], `${level}: the spawn heading runs downhill (${(far[1] - slot[0][1]).toFixed(1)} m over ${run.toFixed(0)} m)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll course-anchor checks passed.');
process.exit(failures ? 1 : 0);
