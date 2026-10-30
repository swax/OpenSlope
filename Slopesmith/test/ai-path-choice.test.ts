// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  aiPathCandidates,
  aiPathMood,
  aiPathProjection,
  chooseAiPath,
  type AiChoicePath,
} from '../src/app/ride/ai-path-choice';

const point = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
function path(points: THREE.Vector3[], rating = 50, respawnable = true): AiChoicePath {
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++)
    cum[i] = cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return { pts: points, cum, total: cum.at(-1)!, rating, respawnable, bounds: new THREE.Box3().setFromPoints(points) };
}

const straight = path([point(0, 0, -10), point(0, 0, 100)]);
const forward = chooseAiPath([straight], point(), point(0, 0, 1), 50)!;
assert.equal(forward.arc, 18, 'Candidate projection is 8 m ahead, not at the rider');
assert(
  Math.abs(forward.score - -103.87357421875) < 1e-9,
  'Native two-point score uses real position and projected query',
);
assert.deepEqual(
  chooseAiPath([straight], point(), point(0, 0, 100), 50),
  forward,
  'Prediction normalizes velocity rather than multiplying speed',
);
const slopeVelocity = chooseAiPath([straight], point(), point(0, 3, 4), 50)!;
assert(Math.abs(slopeVelocity.arc - 16.4) < 1e-9, 'Vertical velocity participates in the 8 m direction normalization');
assert(Number.isFinite(chooseAiPath([straight], point(), point(), 50)!.score), 'Stationary queries remain finite');

const upcomingEnd = path([point(-10), point(6)]);
const continuation = path([point(8), point(100)]);
assert.equal(
  chooseAiPath([upcomingEnd, continuation], point(), point(1), 50)!.path,
  1,
  'Projected eligibility rejects a path whose end is still ahead of the actual rider',
);
assert.equal(
  chooseAiPath([path([point(), point(10)])], point(), point(1), 50)!.arc,
  8,
  'Exactly 2 m remaining is eligible',
);
assert.equal(chooseAiPath([path([point(), point(9.99)])], point(), point(1), 50), null);

const detour = path([point(-30, 0, -30), point(-30, 0, 30), point(30, 0, 30), point(30, 0, -30)]);
const boxNetwork = [...Array.from({ length: 6 }, () => detour), path([point(1, 0, -10), point(1, 0, 100)])];
assert.deepEqual(
  aiPathCandidates(boxNetwork, point()),
  [0, 1, 2, 3, 4, 5],
  'Bounding-box containment wins even when the curve itself is farther away',
);
assert.equal(chooseAiPath(boxNetwork, point(), point(), 50)!.path, 0, 'Only the bounding-box shortlist is scored');
assert.deepEqual(
  aiPathCandidates([path([point(6, 6), point(6, 6, 100)]), path([point(7), point(7, 0, 100)])], point()),
  [0, 1],
  'Box proximity is maximum axis gap, not Euclidean distance',
);
const ended = path([point(-1), point(1)]);
const endNetwork = [...Array.from({ length: 6 }, () => ended), path([point(2), point(2, 0, 100)])];
assert.equal(
  chooseAiPath(endNetwork, point(), point(), 50),
  null,
  'End filtering does not refill the six-candidate shortlist',
);
const advanceNetwork = [straight, ...Array.from({ length: 5 }, () => ended), path([point(2), point(2, 0, 100)])];
assert.equal(
  chooseAiPath(advanceNetwork, point(), point(), 50, 0),
  null,
  'Excluding the incumbent also happens after shortlisting',
);
const unrespawnable = { ...detour, respawnable: false };
assert.deepEqual(
  aiPathCandidates([...Array.from({ length: 6 }, () => unrespawnable), straight], point(), true),
  [6],
  'Respawn-only filtering precedes the shortlist',
);

const overhead = path([point(0, 0, 0), point(10, 0, 0), point(10, 100, 10), point(0, 100, 10)]);
assert.deepEqual(
  aiPathProjection(overhead, point(5, 100)).point.toArray(),
  [5, 0, 0],
  'The closest-foot scan uses horizontal distance, including at crossings',
);
assert.equal(
  chooseAiPath([path([point(0, 100, -10), point(0, 100, 100)]), straight], point(), point(0, 0, 1), 50)!.path,
  1,
  'Height counts in scoring even though the foot search is horizontal',
);

const places = [0, 1, 2, 3, 4, 5];
assert.deepEqual(
  places.map(place => aiPathMood(0, place, 1, 1, 99)),
  [50, 50, 0, 0, 50, 50],
);
assert.deepEqual(
  places.map(place => aiPathMood(1, place, 1, 1, 99)),
  [50, 50, 50, 0, 0, 50],
);
assert.deepEqual(
  places.map(place => aiPathMood(2, place, 1, 1, 99)),
  [0, 50, 50, 50, 50, 50],
);
for (const place of places) {
  assert.equal(aiPathMood(0, place, 0.1, 1, 99), 100);
  assert.equal(aiPathMood(1, place, 0.3, 1, 99), 100);
}
assert.equal(aiPathMood(0, 2, 0.10337617248296738, 1, 99), 0, 'Class-zero boost threshold is strict');
assert.equal(aiPathMood(1, 3, 0.3118690252304077, 1, 99), 0, 'Other-class boost threshold is strict');
assert.equal(aiPathMood(2, 0, -1, 1, 99), 0, 'Class-two leader rule precedes its negative-meter test');
assert.equal(aiPathMood(2, 1, -0.01, 1, 99), 100);
assert.equal(aiPathMood(2, 1, 0, 1, 99), 50);
assert.equal(aiPathMood(1, 0, 0, 0.5, 45), 100, 'The integer skill roll includes the threshold');
assert.equal(aiPathMood(1, 0, 0, 0.5, 46), 50);
assert.equal(aiPathMood(1, 0, 0, 1, 99), 100, 'Exactly skill 1 bypasses the divisor');
assert.equal(aiPathMood(1, 0, 0, 1.000000001, 99), 100, 'The exact-one test uses the native float32 skill value');
assert.equal(aiPathMood(1, 0, 0, 0, 0), 100, 'Native zero-percent roll still keeps the mood on integer roll zero');
assert.equal(aiPathMood(1, 0, 0, 0, 1), 50);
assert.equal(aiPathMood(1, 0, 0, 1, 0, false), 100);
assert.equal(aiPathMood(1, 0, 0, 1, 1, false), 50);
console.log(
  'PASS: native projected query, bounding-box shortlist/order, planar feet, 3-D scoring, endpoint/advance filters, board-class mood, meter thresholds and integer skill roll',
);
