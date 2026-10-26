// tier: fast
import assert from 'node:assert/strict';
import type { V3 } from '../src/core/doc/types';
import { aiPathMetrics, aiPathEventSpan } from '../src/core/reference/ai-paths';
import { AI_PATH_RATING_COLORS, aiPathColor, aiPathEventStyle } from '../src/app/ai-path-style';

const points: V3[] = [
  [0, 0, 0],
  [3, 12, 4],
  [9, 12, 4],
];
assert.deepEqual(aiPathMetrics(points), { length: 11, segments: 2, average: 5.5 });
assert.deepEqual(aiPathMetrics([]), { length: 0, segments: 0, average: 0 });
assert.deepEqual(
  aiPathEventSpan(points, 2.5, 9),
  [
    [1.5, 6, 2],
    [3, 12, 4],
    [7, 12, 4],
  ],
  'Event spans use horizontal stations and retain the bend',
);
assert.deepEqual(aiPathEventSpan(points, 5, 5), [[3, 12, 4]], 'A point event on a vertex is one marker');
assert.deepEqual(aiPathEventSpan(points, 11, 11), [[9, 12, 4]], 'Path-end point events are visible');
assert.deepEqual(
  aiPathEventSpan(points, -5, 2.5),
  [
    [0, 0, 0],
    [1.5, 6, 2],
  ],
  'Partly outside events clip to the path',
);
for (const range of [
  [12, 15],
  [-4, -1],
  [8, 3],
  [NaN, 5],
])
  assert.deepEqual(aiPathEventSpan(points, range[0], range[1]), []);
assert.deepEqual([0, 50, 100].map(aiPathColor), AI_PATH_RATING_COLORS);
assert.equal(aiPathColor(-5), aiPathColor(0));
assert.equal(aiPathColor(200), aiPathColor(100));
assert.notEqual(aiPathColor(25), aiPathColor(50));
assert.equal(aiPathEventStyle(101).name, 'Cruise speed');
assert.equal(aiPathEventStyle(102).name, 'Unidentified');
assert.equal(aiPathEventStyle(0xffffffff).name, 'Disabled');
console.log('PASS: concise horizontal metrics, bent event spans, point events, clipping and property colours');
