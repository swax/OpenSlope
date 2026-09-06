// tier: fast

import * as THREE from 'three';
import { createCheckpointTracker } from '../src/app/ride/checkpoints';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { normalizeCheckpointBonus } from '../src/core/doc/race';
import { buildLevelFiles } from '../src/core/export/level';
import { showoffCheckpoints, type CoursePathFile } from '../src/core/reference/terrain';
import { check, failures } from './check';

check(normalizeCheckpointBonus(150) === 150, 'authoring: a positive whole-seconds payload is retained');
check(normalizeCheckpointBonus(0) === undefined, 'authoring: zero removes the checkpoint from a knot');
check(normalizeCheckpointBonus(999) === 600, 'authoring: a malformed oversized payload is bounded');

// Saving/loading preserves a real checkpoint and normalizes legacy/manual JSON at the document seam.
{
  const doc = blankMountain('CHECKPOINT_ROUNDTRIP');
  doc.course.knots[1].checkpointBonus = 110;
  doc.course.knots[2].checkpointBonus = 0;
  const loaded = migrateMountain(structuredClone(doc));
  check(loaded.course.knots[1].checkpointBonus === 110, 'document: checkpoint bonus survives migration');
  check(loaded.course.knots[2].checkpointBonus === undefined, 'document: zero checkpoint is normalized away');
}

// Export is the core contract: the station exists in both datasets, but only SOP gives event 11 its time payload.
{
  const doc = blankMountain('CHECKPOINT_EXPORT');
  doc.course.knots = [
    { pos: [0, 100, 0], width: 40, wall: 0, bank: 0, shoulder: 6 },
    { pos: [100, 50, 0], width: 40, wall: 0, bank: 0, shoulder: 6, checkpointBonus: 150 },
    { pos: [200, 0, 0], width: 40, wall: 0, bank: 0, shoulder: 6 },
  ];
  const files = buildLevelFiles(doc, [], { lighting: false });
  const aip = JSON.parse(files.text['AIP.json']) as CoursePathFile;
  const sop = JSON.parse(files.text['SOP.json']) as CoursePathFile;
  const aipEvent = aip.RaceLines?.[0].PathEvents?.find(event => event.EventType === 11);
  const sopEvent = sop.RaceLines?.[0].PathEvents?.find(event => event.EventType === 11);
  check(aipEvent?.EventValue === 0, 'export: AIP carries the checkpoint progress station with a zero time payload');
  check(sopEvent?.EventValue === 150, 'export: SOP type 11 carries the authored +150 second payload');
  check((sopEvent?.EventStart ?? 0) > 0, 'export: checkpoint EventStart is a projected horizontal race-line station');
}

// Two path records at the same remaining DTF are alternate copies of one logical checkpoint, even when their
// route awards differ (the MEGAPLEX shape). Positions still remain separate for viewport/runtime route choice.
{
  const file: CoursePathFile = { RaceLines: [
    {
      DistanceToFinish: 10000, PathPos: [0, 0, 0], PathPoints: [[0, 0, 0], [10000, 0, 0]],
      PathEvents: [{ EventType: 11, EventValue: 150, EventStart: 5000, EventEnd: 5000 }],
    },
    {
      DistanceToFinish: 10050, PathPos: [0, -2000, 0], PathPoints: [[0, 0, 0], [10000, 0, 0]],
      PathEvents: [{ EventType: 11, EventValue: 120, EventStart: 5050, EventEnd: 5050 }],
    },
  ] };
  const checkpoints = showoffCheckpoints(file);
  check(checkpoints.length === 2, 'reference: every route-specific SOP event remains visible');
  check(checkpoints[0].group === checkpoints[1].group, 'reference: equal-DTF route copies form one logical checkpoint');
  check(Math.abs(checkpoints[0].pos[0] + 50) < 0.01 && Math.abs(checkpoints[1].pos[2] - 20) < 0.01,
    'reference: EventStart is interpolated to each route’s own editor-space position');
}

// The playtest query is a forward progress crossing, not a radius around the visual marker. A reverse crossing
// does nothing; crossing forward again re-arms, and an alternate-route group chooses the event nearest the rider.
{
  const course = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0)];
  const tracker = createCheckpointTracker(course, [
    { pos: new THREE.Vector3(50, 0, 0), dtf: 50, bonusSeconds: 150, group: 4 },
    { pos: new THREE.Vector3(50, 0, 20), dtf: 50, bonusSeconds: 120, group: 4 },
  ])!;
  check(tracker.step(new THREE.Vector3(40, 0, 18)).length === 0, 'runtime: initial placement grants no past checkpoint');
  check(tracker.step(new THREE.Vector3(60, 0, 18))[0]?.bonusSeconds === 120,
    'runtime: a forward crossing chooses the nearest alternate route’s payload');
  check(tracker.step(new THREE.Vector3(40, 0, 1)).length === 0, 'runtime: crossing backward grants no time');
  check(tracker.step(new THREE.Vector3(60, 0, 1))[0]?.bonusSeconds === 150,
    'runtime: a later forward re-cross can fire and chooses the other route');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll showoff-checkpoint checks passed.');
process.exit(failures ? 1 : 0);
