// tier: fast

/**
 * The reference quilt's render-only index is split into a spatial grid so the renderer can frustum-cull the
 * course a cell at a time (the port of the Unity importer's StaticChunker). What has to hold: the split is
 * a pure reordering of the source patches, each chunk's bounds really do contain the triangles it draws, and
 * the resulting bounds are tight enough that an off-screen cell is actually rejected.
 */
import * as THREE from 'three';
import {
  buildReferenceBatchLayout, REFERENCE_CHUNK_METRES, type ReferenceBatchLayout,
} from '../src/app/viewport/mesh/reference-batching';
import { check, failures } from './check';

// ---- fixture: a 10x10 grid of one-quad patches, 100 m apart, spanning 0..990 m in X and Z ----
const GRID = 10, SPACING = 100, QUAD = 90, FACES_PER_PATCH = 2, LEVEL = 'CHUNKS';
const patchCount = GRID * GRID;
const positions = new Float32Array(patchCount * 4 * 3);
const indices = new Uint32Array(patchCount * FACES_PER_PATCH * 3);
const patchTex: (string | null)[] = [];
for (let gz = 0; gz < GRID; gz++) {
  for (let gx = 0; gx < GRID; gx++) {
    const patch = gz * GRID + gx;
    const x = gx * SPACING, z = gz * SPACING, y = gx + gz; // a little height so the boxes are not degenerate
    const v = patch * 4;
    positions.set([x, y, z, x + QUAD, y, z, x + QUAD, y, z + QUAD, x, y, z + QUAD], v * 3);
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], patch * FACES_PER_PATCH * 3);
    // three tiles in rotation plus an untextured patch, so slot 0 (fallback) is exercised alongside real refs
    patchTex.push(patch % 4 === 3 ? null : `tile-${patch % 3}.png`);
  }
}

// Pin the cell size rather than riding the default: the grid arithmetic below is exact, and the default is a
// measured tuning value (see the constant) that should be free to move without rewriting these expectations.
const CELL = 200;
const layout = buildReferenceBatchLayout(indices, positions, patchTex, FACES_PER_PATCH, LEVEL, CELL);

check(layout.textureRefs.length === 3
  && layout.textureRefs.every((ref, i) => ref === `${LEVEL}/tile-${i}.png`),
  'each distinct tile takes one material slot, qualified by the containing level');

// ---- the split is a pure reordering: every source triangle survives exactly once ----
const key = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(':');
const sourceTris = new Map<string, number>();
for (let i = 0; i < indices.length; i += 3) {
  const k = key(indices[i], indices[i + 1], indices[i + 2]);
  sourceTris.set(k, (sourceTris.get(k) ?? 0) + 1);
}
const chunkTris = new Map<string, number>();
let drawnIndices = 0;
for (const chunk of layout.chunks) {
  for (const group of chunk.groups) {
    drawnIndices += group.count;
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const k = key(layout.indices[i], layout.indices[i + 1], layout.indices[i + 2]);
      chunkTris.set(k, (chunkTris.get(k) ?? 0) + 1);
    }
  }
}
check(drawnIndices === indices.length && chunkTris.size === sourceTris.size
  && [...sourceTris].every(([k, n]) => chunkTris.get(k) === n),
  'the chunked index draws every source triangle exactly once, and nothing else');

check([...layout.patchStarts].every((start, patch) => {
  const count = FACES_PER_PATCH * 3;
  return layout.indices.slice(start, start + count).every((vertex, i) => vertex === indices[patch * count + i]);
}), 'every source patch retains its exact range start in the reordered render index');

// ---- the groups tile the buffer: contiguous, in order, no gap and no overlap ----
let cursor = 0, contiguous = true;
for (const chunk of layout.chunks) {
  for (const group of chunk.groups) {
    if (group.start !== cursor || group.count <= 0) contiguous = false;
    cursor += group.count;
  }
}
check(contiguous && cursor === layout.indices.length,
  'chunk draw ranges are contiguous and cover the whole index');

check(layout.chunks.every(chunk => new Set(chunk.groups.map(g => g.materialIndex)).size === chunk.groups.length),
  'a cell submits one draw range per texture it contains, never two for the same slot');

// ---- the geometry actually lands in the cell that claims it ----
const EPSILON = 1e-4;
const boundsHold = layout.chunks.every(chunk => {
  for (const group of chunk.groups) {
    for (let i = group.start; i < group.start + group.count; i++) {
      const v = layout.indices[i] * 3;
      for (let axis = 0; axis < 3; axis++) {
        const p = positions[v + axis];
        if (p < chunk.min[axis] - EPSILON || p > chunk.max[axis] + EPSILON) return false;
      }
    }
  }
  return true;
});
check(boundsHold, 'every chunk bound contains all of the geometry that chunk draws');

// 0..990 m over 200 m cells is five cells per axis; every one of the 25 holds four of the 100 patches.
check(layout.chunks.length === 25 && layout.chunks.every(chunk => chunk.patches === 4),
  `a ${GRID * SPACING} m quilt splits into 25 cells at ${CELL} m`);

check(layout.chunks.every(chunk =>
  chunk.max[0] - chunk.min[0] <= CELL + QUAD && chunk.max[2] - chunk.min[2] <= CELL + QUAD),
  'cell bounds stay near the cell size — a straddling patch widens one cell, it does not merge two');

// The shipped default is a tuning value, but it still has to be a real split: coarser than the pinned 200 m
// above and finer than the whole map, or the constant has been edited into something that cannot cull.
const shipped = buildReferenceBatchLayout(indices, positions, patchTex, FACES_PER_PATCH, LEVEL);
check(shipped.chunks.length > 1 && shipped.chunks.length <= layout.chunks.length,
  `the shipped ${REFERENCE_CHUNK_METRES} m default splits the quilt into ${shipped.chunks.length} cells`);

// ---- the point of all of it: Three can now reject an off-screen cell ----
const boundingSphere = (chunk: ReferenceBatchLayout['chunks'][number]) =>
  new THREE.Box3(
    new THREE.Vector3(chunk.min[0], chunk.min[1], chunk.min[2]),
    new THREE.Vector3(chunk.max[0], chunk.max[1], chunk.max[2]),
  ).getBoundingSphere(new THREE.Sphere());

const camera = new THREE.PerspectiveCamera(50, 1, 1, 400);
camera.position.set(45, 60, 45);           // stood on the first cell...
camera.lookAt(new THREE.Vector3(45, 0, 0)); // ...looking up the -Z edge, away from the bulk of the quilt
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();
const frustum = new THREE.Frustum().setFromProjectionMatrix(
  new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
const visible = layout.chunks.filter(chunk => frustum.intersectsSphere(boundingSphere(chunk)));
check(visible.length > 0 && visible.length < layout.chunks.length,
  `an off-axis view keeps ${visible.length} of ${layout.chunks.length} cells and rejects the rest`);

// The same view against the unsplit quilt — one mesh over the whole map — can reject nothing. This is the
// regression the split exists to prevent, so assert the old shape's behaviour rather than describing it.
const whole = buildReferenceBatchLayout(indices, positions, patchTex, FACES_PER_PATCH, LEVEL, 0);
check(whole.chunks.length === 1 && frustum.intersectsSphere(boundingSphere(whole.chunks[0])),
  'cellMetres 0 disables the split, and that single map-spanning chunk is never culled');
check(whole.indices.length === layout.indices.length
  && whole.chunks[0].groups.length === layout.textureRefs.length + 1,
  'the unsplit layout still draws the whole quilt, one range per material slot');

if (failures) process.exitCode = 1;
else console.log('REFERENCE TERRAIN CHUNK TESTS PASSED');
