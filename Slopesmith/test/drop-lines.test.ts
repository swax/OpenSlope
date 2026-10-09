// tier: fast

/**
 * Drop lines (docs/012 · Drop lines, app/viewport/scene/drop-lines.ts): a plumb line from each selected Props-mode
 * thing straight down to the surface beneath it.
 *
 *  - a thing above the surface draws one line, from where it stands to the ground straight below;
 *  - nothing is drawn for a thing on or sunk into the surface, or over no surface at all;
 *  - an idle selection re-casts nothing; a moved point, or an edited ground, re-casts;
 *  - a set draws one line per member, capped, and an empty selection hides the layer.
 *
 * Run: tsx test/drop-lines.test.ts
 */
import * as THREE from 'three';
import type { V3 } from '../src/core/doc/types';
import { createDropLinesLayer, MAX_DROP_LINES } from '../src/app/viewport/scene/drop-lines';
import { check, failures } from './check';

const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

// One sheet of ground falling half a metre per metre of +x, over -50 <= x <= 50 only.
const groundAt = (x: number) => x >= -50 && x <= 50 ? 0.5 * x : null;
let points: V3[] = [];
let version = 'v1';
let casts = 0;
const worldRoot = new THREE.Group();
const layer = createDropLinesLayer({ worldRoot } as never, {
  points: () => points,
  groundBelow: (x, y) => {
    casts++;
    const g = groundAt(x);
    return g !== null && g <= y ? g : null;
  },
  groundVersion: () => version,
});
const group = worldRoot.children[0];

points = [[4, 5, 1]]; // a gem floating 3 m over ground at 2
layer.sync();
check(layer.count === 1 && near(layer.segments()[0][0], [4, 5, 1]) && near(layer.segments()[0][1], [4, 2, 1]),
  'a floating point drops a line to the ground straight below it', JSON.stringify(layer.segments()));
check(group.visible, 'the layer shows while a line is drawn');

const before = casts;
layer.sync();
check(casts === before, 'an idle selection re-casts nothing');

points = [[-6, 5, 1]];
layer.sync();
check(casts === before + 1 && near(layer.segments()[0][1], [-6, -3, 1]), 'a moved point re-casts, and its line follows');

version = 'v2';
layer.sync();
check(casts === before + 2, 'an edited ground re-casts a still selection');

points = [[2, 1, 0], [2, 0.5, 0], [80, 10, 0]]; // seated, sunk, and over nothing
layer.sync();
check(layer.count === 0 && !group.visible, 'nothing is drawn on or in the surface, or over no surface');

points = Array.from({ length: MAX_DROP_LINES + 44 }, (_, i): V3 => [0, 10, i]);
layer.sync();
check(layer.count === MAX_DROP_LINES, `a large set draws one line per member, capped at ${MAX_DROP_LINES}`, String(layer.count));

points = [];
layer.sync();
check(layer.count === 0 && !group.visible, 'an empty selection hides the layer');

if (failures) process.exitCode = 1;
