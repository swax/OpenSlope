// tier: fast

import assert from 'node:assert/strict';
import { greedyOccupancyBoxes, type OccupancyBox } from '../src/core/collision/occupancy-boxes';

const keyOf = (n: number, x: number, y: number, z: number) => (x * n + y) * n + z;

/** Independent, exhaustive oracle: visit every box and inspect its cells directly. Keep the original
 * lexicographic tie-break, overlap allowance, minimum contribution and box cap. */
function exhaustive(n: number, cells: ReadonlySet<number>, cap = 16, minNewCells = 3): OccupancyBox[] {
  const covered = new Set<number>();
  const boxes: OccupancyBox[] = [];
  while (boxes.length < cap) {
    let bestNew = minNewCells - 1;
    let best: OccupancyBox | null = null;
    for (let x0 = 0; x0 < n; x0++)
      for (let x1 = x0; x1 < n; x1++)
        for (let y0 = 0; y0 < n; y0++)
          for (let y1 = y0; y1 < n; y1++)
            for (let z0 = 0; z0 < n; z0++)
              for (let z1 = z0; z1 < n; z1++) {
                if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) <= bestNew) continue;
                let solid = true,
                  fresh = 0;
                for (let x = x0; solid && x <= x1; x++)
                  for (let y = y0; solid && y <= y1; y++)
                    for (let z = z0; z <= z1; z++) {
                      const key = keyOf(n, x, y, z);
                      if (!cells.has(key)) {
                        solid = false;
                        break;
                      }
                      if (!covered.has(key)) fresh++;
                    }
                if (solid && fresh > bestNew) {
                  bestNew = fresh;
                  best = [x0, x1, y0, y1, z0, z1];
                }
              }
    if (!best) break;
    boxes.push(best);
    const [x0, x1, y0, y1, z0, z1] = best;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) covered.add(keyOf(n, x, y, z));
  }
  return boxes;
}

// Every occupancy pattern, including empty/singleton bodies and contributions below the default minimum.
for (let mask = 0; mask < 256; mask++) {
  const cells = new Set(Array.from({ length: 8 }, (_, key) => key).filter(key => mask & (1 << key)));
  for (const minimum of [1, 3])
    assert.deepEqual(greedyOccupancyBoxes(2, cells, 16, minimum), exhaustive(2, cells, 16, minimum));
}

let seed = 87134;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (const n of [3, 4, 5]) {
  for (let sample = 0; sample < 48; sample++) {
    const density = 0.2 + 0.75 * random();
    const cells = new Set(Array.from({ length: n ** 3 }, (_, key) => key).filter(() => random() < density));
    const cap = 1 + Math.floor(random() * 8);
    const minimum = 1 + Math.floor(random() * 4);
    assert.deepEqual(
      greedyOccupancyBoxes(n, cells, cap, minimum),
      exhaustive(n, cells, cap, minimum),
      `grid ${n}, sample ${sample}: exact greedy choices and order survive overlaps and ties`,
    );
  }
}

function addBox(cells: Set<number>, n: number, [x0, x1, y0, y1, z0, z1]: OccupancyBox) {
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) cells.add(keyOf(n, x, y, z));
}

// Later boxes may end inside a run whose trailing slabs were covered by an earlier, larger box.
const overlapping = new Set<number>();
addBox(overlapping, 6, [0, 4, 0, 2, 2, 5]);
addBox(overlapping, 6, [1, 3, 0, 3, 0, 3]);
addBox(overlapping, 6, [2, 3, 2, 5, 1, 4]);
assert.deepEqual(greedyOccupancyBoxes(6, overlapping), exhaustive(6, overlapping));

const separated = new Set<number>();
addBox(separated, 32, [0, 3, 0, 3, 0, 3]);
addBox(separated, 32, [0, 3, 0, 3, 28, 31]);
assert.deepEqual(
  greedyOccupancyBoxes(32, separated),
  [
    [0, 3, 0, 3, 0, 3],
    [0, 3, 0, 3, 28, 31],
  ],
  'missing Z coordinates split solid runs, preserving the empty space between bodies',
);
assert.deepEqual(greedyOccupancyBoxes(32, separated, 1), [[0, 3, 0, 3, 0, 3]], 'the box cap is retained');
assert.deepEqual(greedyOccupancyBoxes(32, separated, 16, 65), [], 'small contributions stay below the minimum');

console.log('OCCUPANCY BOX TESTS PASSED');
