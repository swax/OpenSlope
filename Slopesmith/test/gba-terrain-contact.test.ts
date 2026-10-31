// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readLevelPatches } from '../src/shared/map-levels';
import type { MapDataSource } from '../src/shared/map-data';
import { buildReferenceMesh, type RawPatch } from '../src/core/reference/terrain';
import { referencePatchContact } from '../src/app/ride/patch-contact';
import { createRideModel } from '../src/app/ride/physics';
import { patchPoint } from '../src/core/math/bezier';
import type { V3 } from '../src/core/doc/types';
import { gbaReferenceSpawn } from '../src/app/ride/reference-spawn';

async function read(patch: RawPatch, name = 'SSXGBA_GARIBALDI', game = 'ssx-tricky-gba') {
  const source: MapDataSource = {
    root: 'maps',
    readJsonOr: async <T>(path: string, fallback: T): Promise<T> =>
      path.endsWith('/Patches.json')
        ? ({ Patches: [patch] } as T)
        : path.endsWith('/Import.json')
          ? ({ Game: game } as T)
          : fallback,
    readTextOrNull: async () => null,
    readBytesOrNull: async () => null,
    listDir: async () => [],
    listEntries: async () => [],
    pathExists: async () => false,
  };
  return (await readLevelPatches(source, name)).patches[0];
}

function drop(patch: RawPatch, triangular: boolean, edge = false) {
  const data = buildReferenceMesh([patch], undefined, 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  const terrain = new THREE.Mesh(geometry);
  terrain.scale.z = -1; // Public reference worlds use the same chirality mirror.
  terrain.updateMatrixWorld(true);
  const at: V3 = edge ? [triangular ? 0 : -50, 0, 620.8] : [triangular ? -25 : -50, 0, 50];
  const seated = edge ? gbaReferenceSpawn(data, geometry, at) : at;
  if (edge) {
    assert(Math.hypot(...seated.map((p, i) => p - at[i])) <= 0.501, 'Boundary seating stays within half a metre');
    assert(seated[2] < at[2], 'A boundary start moves into the existing terrain');
  }
  const model = createRideModel({
    terrain,
    patchContact: referencePatchContact(data)!,
    surfaceOf: () => 1,
    spawn: new THREE.Vector3(seated[0], seated[1] + 1, -seated[2]),
    heading: new THREE.Vector3(0, 0, 1),
    keys: { left: false, right: false, tuck: false, brake: false, boost: false },
    stick: { active: false, x: 0 },
    drive: 0,
    oobFloorY: -200,
    onRespawn: () => {},
  });
  model.start();
  let grounded = 0;
  for (let i = 0; i < 180; i++) {
    model.step(1 / 60);
    grounded += Number(model.st.grounded);
  }
  geometry.dispose();
  return { grounded, y: model.st.pos.y };
}

for (const triangular of [false, true]) {
  const corners: V3[] = [[0, 0, 0], [10000, 0, 0], [0, -10000, 0], triangular ? [0, -10000, 0] : [10000, -10000, 0]];
  const down: RawPatch = {
    Points: Array.from({ length: 16 }, (_, index) => {
      const u = Math.floor(index / 4) / 3,
        v = (index % 4) / 3;
      return [0, 1, 2].map(
        k =>
          corners[0][k] * (1 - u) * (1 - v) +
          corners[1][k] * u * (1 - v) +
          corners[2][k] * (1 - u) * v +
          corners[3][k] * u * v,
      );
    }),
    UVPoints: [[0.1, 0.2], [0.8, 0.2], [0.1, 0.9], triangular ? [0.1, 0.9] : [0.8, 0.9]],
    SurfaceType: 1,
    LightColorPoints: Array.from({ length: 16 }, (_, i) => [i / 16, 0.5, 1]),
  };
  const original = JSON.stringify(down);
  assert.equal(drop(down, triangular).grounded, 0, 'The old GBA winding reproduces falling through analytic terrain');
  const fixed = await read(down);
  const ride = drop(fixed, triangular);
  assert(ride.grounded > 120 && ride.y > -0.1, 'Cached GBA terrain catches the rider and keeps them grounded');
  assert.equal(JSON.stringify(down), original, 'Reading does not mutate the stored source');
  const cornerControls = [0, 12, 3, 15];
  for (const [index, control] of cornerControls.entries()) {
    const old = cornerControls.findIndex(i => JSON.stringify(down.Points[i]) === JSON.stringify(fixed.Points[control]));
    assert.deepEqual(
      fixed.UVPoints![index],
      down.UVPoints![old],
      'Each UV corner remains attached to its physical corner',
    );
  }
  for (const [u, v] of [
    [0.2, 0.7],
    [0.5, 0.5],
    [1, 0],
  ]) {
    const before = patchPoint(down.Points as V3[], u, v);
    const after = patchPoint(fixed.Points as V3[], v, u);
    assert(
      before.every((p, i) => Math.abs(p - after[i]) < 1e-8),
      'Transposition preserves the complete surface',
    );
  }
  for (let i = 0; i < 16; i++)
    assert.deepEqual(fixed.LightColorPoints![i], down.LightColorPoints![(i % 4) * 4 + Math.floor(i / 4)]);
  assert.deepEqual((await read(fixed)).Points, fixed.Points, 'Already-correct GBA patches are unchanged');
  assert.deepEqual(
    (await read(down, 'TRICKY_GARI', 'ssx-tricky')).Points,
    down.Points,
    'Other games retain their authored one-sided normals',
  );
  assert.deepEqual(
    (await read(down, 'LEGACY_GBA')).Points,
    fixed.Points,
    'Import metadata also identifies earlier GBA names',
  );
  const edgePatch = structuredClone(down);
  edgePatch.Points = edgePatch.Points.map(p => [p[0], p[1] - 52080, p[2]]);
  const boundary = drop(await read(edgePatch), triangular, true);
  assert(
    boundary.grounded > 120,
    `Float-rounded edge/corner (${triangular}) remains grounded: ${JSON.stringify(boundary)}`,
  );
}
console.log('GBA cached quad/triangle terrain: grounded spawn, unchanged geometry, UVs, lighting and other games PASS');
