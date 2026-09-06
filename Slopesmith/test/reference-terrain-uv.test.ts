// tier: fast

import { insetReferenceUnitTile, referenceLightmapLayoutStats, type RawPatch } from '../src/core/reference/terrain';
import { check, failures } from './check';

const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;
const same = (actual: number[][], expected: number[][]) =>
  actual.length === expected.length && actual.every((corner, i) =>
    near(corner[0], expected[i][0]) && near(corner[1], expected[i][1]));

const ordinary = insetReferenceUnitTile([[0, 0], [0, -1], [1, 0], [1, -1]]);
check(same(ordinary, [[0.008, -0.008], [0.008, -0.992], [0.992, -0.008], [0.992, -0.992]]),
  'exact negative-V unit tile gets the Snowknife seam inset');

const rotated = insetReferenceUnitTile([[1, -1], [0, -1], [1, 0], [0, 0]]);
check(same(rotated, [[0.992, -0.992], [0.008, -0.992], [0.992, -0.008], [0.008, -0.008]]),
  'rotation and mirror corner order survives axis-local inset');

const alreadyInset = [[0.008, -0.008], [0.008, -0.992], [0.992, -0.008], [0.992, -0.992]] as const;
check(same(insetReferenceUnitTile(alreadyInset), alreadyInset.map(corner => [...corner])),
  'already-inset retail UVs are unchanged');

const repeated = [[0, 0], [0, -1], [2, 0], [2, -1]] as const;
check(same(insetReferenceUnitTile(repeated), repeated.map(corner => [...corner])),
  'intentional multi-tile repeat is unchanged');

const patch = (id: number, point: number[]): RawPatch => ({
  Points: Array.from({ length: 16 }, () => [0, 0, 0]), SurfaceType: 1,
  LightmapID: id, LightMapPoint: point,
});
const nativeLayout = Array.from({ length: 32 }, (_, i) => patch(i >> 8,
  [(i & 7) / 8, ((i >> 3) & 7) / 8, 1 / 16, 1 / 16]));
const nativeStats = referenceLightmapLayoutStats(nativeLayout);
check(!nativeStats.collapsed && nativeStats.unique === nativeLayout.length,
  'a native per-patch lightmap allocation remains usable');

const placeholderLayout = Array.from({ length: 32 }, () => patch(0, [0, 0, 1 / 16, 1 / 16]));
const placeholderStats = referenceLightmapLayoutStats(placeholderLayout);
check(placeholderStats.collapsed && placeholderStats.unique === 1,
  'a custom map repeating one placeholder light tile is rejected');

check(!referenceLightmapLayoutStats([patch(0, [0, 0, 1, 1])]).collapsed,
  'a genuine single-patch map may use one light tile');

if (failures) process.exitCode = 1;
