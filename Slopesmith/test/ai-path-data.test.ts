// tier: fast
import assert from 'node:assert/strict';
import { readLevelAiPaths } from '../src/shared/map-levels';
import { aiJumpMarkers } from '../src/core/reference/terrain';
import { pathFile, pathSource } from './ai-path-data.fixture';

const before = JSON.stringify(pathFile);
const paths = await readLevelAiPaths(pathSource, 'TEST');
assert(paths);
assert.deepEqual(
  paths.map(path => path.originalIndex),
  [1, 2],
  'Empty records do not renumber source identities',
);
assert.deepEqual(paths[0].startSlots, [0, 2], 'One shared path can initialize multiple grid slots');
assert.equal(paths[0].rating, 80);
assert.equal(paths[0].respawnable, false);
assert.deepEqual(paths[0].events, [
  { type: 100, value: 383, start: 5, end: 7 },
  { type: 105, value: 0, start: 8, end: 9 },
  { type: 101, value: 71, start: 10, end: 11 },
  { type: 300, value: 0, start: 20, end: 20 },
  { type: 777, value: 123, start: 12, end: 13 },
  { type: 102, value: 0, start: 17.5, end: 18 },
]);
assert.deepEqual(paths[0].points, [
  [-0, 1, -0],
  [10, 2, -0],
  [20, 1, -0],
]);
assert.equal(paths[0].markers[0].speed, 95 / 3.6);
assert.equal(paths[0].markers[0].arc, 5);
assert.equal(paths[0].markers[0].end, 7, 'Jump decoding preserves the full horizontal range');
assert(paths[0].markers[0].trickA && paths[0].markers[0].trickB);
assert.deepEqual(
  aiJumpMarkers({
    PathEvents: [
      { EventType: 100, EventValue: 80 << 2, EventStart: 8000, EventEnd: 10400 },
      { EventType: 102, EventValue: 0, EventStart: 7500, EventEnd: 11000 },
      { EventType: 100, EventValue: (60 << 2) | 1, EventStart: 7800, EventEnd: 10000 },
      { EventType: 100, EventValue: 70 << 2, EventStart: 20000 },
    ],
  }),
  [
    { arc: 80, end: 104, speed: 80 / 3.6, trickA: false, trickB: false },
    { arc: 78, end: 100, speed: 60 / 3.6, trickA: true, trickB: false },
    { arc: 200, end: 200, speed: 70 / 3.6, trickA: false, trickB: false },
  ],
  'Jump ranges retain source order, packed targets and flags; a missing end is a point event',
);
assert.equal(paths[1].points.length, 2, 'A single stored step still forms a selectable segment from its seed');
assert.equal(paths[1].rating, 50);
assert.equal(paths[1].respawnable, true);
assert.deepEqual(paths[1].events, []);
assert.equal(JSON.stringify(pathFile), before, 'Inspection preserves the source dataset');
assert.equal(await readLevelAiPaths({ ...pathSource, readJsonOr: async (_path, fallback) => fallback }, 'EMPTY'), null);
console.log(
  'PASS: reference AI path identity, single-segment geometry, slots, events, jump decoding and source preservation',
);
