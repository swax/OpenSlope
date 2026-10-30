// tier: fast
import assert from 'node:assert/strict';
import type { AuthoredAiPath } from '../src/core/doc/types';
import {
  deleteAiPathNode,
  hasAiPathNodeReselect,
  insertAiPathNode,
  moveAiPathNode,
  setAiPathNodeReselect,
} from '../src/core/doc/ai-paths';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { buildLevelFiles } from '../src/core/export/level';

const path: AuthoredAiPath = {
  id: 'fork-path',
  name: 'Fork approach',
  rating: 50,
  respawnable: true,
  points: [
    [0, 9, 0],
    [3, 99, 4],
    [3, -30, 16],
  ],
  events: [
    { type: 100, value: 288, start: 1, end: 4 },
    { type: 300, value: 7, start: 0, end: 15 },
  ],
};
assert(!hasAiPathNodeReselect(path, 1), 'A covering region is independent of a node point event');
const placed = setAiPathNodeReselect(path, 1, true);
assert.equal(path.events.length, 2, 'Placement does not mutate the original path');
assert.deepEqual(placed.events.slice(0, 2), path.events, 'Existing events retain source order and values');
assert.deepEqual(
  placed.events[2],
  { type: 300, value: 0, start: 5, end: 5 },
  'Placement uses horizontal distance, ignoring elevation',
);
assert(hasAiPathNodeReselect(placed, 1));
assert(!hasAiPathNodeReselect(placed, 0));
assert.strictEqual(setAiPathNodeReselect(placed, 1, true), placed, 'Repeated placement cannot add duplicates');
assert.deepEqual(setAiPathNodeReselect(placed, 1, false), path, 'Removing the point preserves the covering region');
assert.strictEqual(setAiPathNodeReselect(path, 1, false), path);
for (const node of [-1, 3, 0.5, NaN]) {
  assert(!hasAiPathNodeReselect(path, node));
  assert.strictEqual(setAiPathNodeReselect(path, node, true), path);
}
assert.equal(setAiPathNodeReselect(path, 0, true).events.at(-1)!.start, 0);
assert.equal(setAiPathNodeReselect(path, 2, true).events.at(-1)!.start, 17);
const moved = moveAiPathNode(placed, 1, [6, 500, 8]);
assert(hasAiPathNodeReselect(moved, 1), 'Node movement remaps the event onto the moved node');
assert.deepEqual(moved.events[2], { type: 300, value: 0, start: 10, end: 10 });

const inserted = insertAiPathNode(placed, 0);
assert.equal(inserted.points.length, 4);
assert.deepEqual(inserted.points[1], [1.5, 54, 2]);
assert.deepEqual(inserted.events, placed.events, 'Midpoint insertion preserves event stations');
assert(hasAiPathNodeReselect(inserted, 2), 'The original node keeps its flag after insertion');
assert(!hasAiPathNodeReselect(inserted, 1), 'The new node starts without a flag');
assert.deepEqual(deleteAiPathNode(inserted, 1), placed, 'Deleting the inserted midpoint restores the original path');
assert.equal(path.points.length, 3, 'Node edits preserve the original snapshot');
for (const node of [-1, 3, 0.5, NaN]) assert.strictEqual(deleteAiPathNode(placed, node), placed);
for (const node of [-1, 2, 0.5, NaN]) assert.strictEqual(insertAiPathNode(placed, node), placed);
const deleted = deleteAiPathNode(placed, 1);
assert.equal(deleted.points.length, 2);
assert.equal(deleted.events.length, 2, 'Deleting the flagged node removes its point event, retaining the range');
assert(Math.abs(deleted.events[0].start - Math.hypot(3, 16) / 17) < 1e-9);
assert(
  Math.abs(deleted.events[0].end - (4 * Math.hypot(3, 16)) / 17) < 1e-9,
  'Jump ranges map across the joined segment',
);
assert.strictEqual(deleteAiPathNode(deleted, 0), deleted, 'Two required path nodes cannot be deleted');
const trimmedHead = deleteAiPathNode(placed, 0);
assert.deepEqual(
  trimmedHead.events,
  [
    { type: 300, value: 7, start: 0, end: 10 },
    { type: 300, value: 0, start: 0, end: 0 },
  ],
  'Trimming the head drops events before the new start and shifts surviving events',
);
const trimmedTail = deleteAiPathNode(setAiPathNodeReselect(placed, 2, true), 2);
assert.deepEqual(
  trimmedTail.events,
  [path.events[0], { type: 300, value: 7, start: 0, end: 5 }, placed.events[2]],
  'Trimming the tail clips ranges and removes the endpoint flag',
);
const collapsed = deleteAiPathNode(
  {
    ...placed,
    points: [
      [0, 0, 0],
      [0, 2, 0],
      [0, 3, 12],
    ],
  },
  1,
);
assert(
  collapsed.events.every(event => Number.isFinite(event.start) && event.end >= event.start),
  'Zero-length horizontal segments remain safe to edit',
);

const doc = defaultMountain();
doc.autoAiPaths = false;
doc.aiPaths = [placed];
const restored = migrateMountain(serializeMountain(doc));
assert.deepEqual(restored.aiPaths, doc.aiPaths, 'Reselect events survive save/reload');
const replica = defaultMountain();
const key = objectRegister('ai-path', placed.id);
applyRegisters(replica, [[key, documentRegisters(doc).get(key)]]);
assert.deepEqual(replica.aiPaths, doc.aiPaths, 'Reselect placement participates in shared path edits');
const files = buildLevelFiles(doc);
for (const filename of ['AIP.json', 'SOP.json']) {
  const exported = JSON.parse(files.text[filename]).AIPaths[0];
  assert.deepEqual(
    exported.PathEvents.at(-1),
    { EventType: 300, EventValue: 0, EventStart: 500, EventEnd: 500 },
    `${filename} exports the point event in horizontal centimetres`,
  );
}
console.log(
  'PASS: node insertion/deletion, reselect placement/removal, horizontal stations, movement, persistence, shared edits and AIP/SOP export',
);
