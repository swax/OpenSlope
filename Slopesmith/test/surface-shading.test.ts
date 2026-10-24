// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, deriveQuadMesh } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { surfaceStyle } from '../src/core/doc/types';
import { bilinearTwist, meshFromDoc } from '../src/core/mesh/topology';
import { createSurfaceFromProfiles } from '../src/core/mesh/surface-object';
import {
  buildMountainPreview,
  buildMountainPreviewProgressive,
  tessellateQuilt,
  refreshPreviewPatches,
  refreshPreviewConstruction,
  previewMismatch,
  PREVIEW_RES,
  PATCH_VERTS,
} from '../src/core/mesh/tessellation';
function fixture(height = 1) {
  const doc = blankMountain('SMOOTH_SURFACE');
  doc.vertices = [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10, 0, height, 20, 10, height, 20];
  doc.quads = [
    [0, 1, 2, 3],
    [2, 3, 4, 5],
  ];
  Object.assign(doc, appendMeshIds(doc, 6, 2));
  doc.edgeHandles = {};
  const { mesh } = meshFromDoc(doc);
  for (const q of doc.quads)
    for (const [a, b] of [
      [q[0], q[1]],
      [q[1], q[3]],
      [q[3], q[2]],
      [q[2], q[0]],
    ])
      for (const [x, y] of [
        [a, b],
        [b, a],
      ])
        doc.edgeHandles[`${x}>${y}`] = [0, 1, 2].map(d => (doc.vertices[y * 3 + d] - doc.vertices[x * 3 + d]) / 3) as [
          number,
          number,
          number,
        ];
  doc.quadTwist = { 0: bilinearTwist(mesh, 0), 1: bilinearTwist(mesh, 1) };
  doc.surfaces = [
    {
      id: 'surface:1',
      name: 'Surface 1',
      origin: 'boundary',
      controls: [],
      guides: [],
      inputs: [],
      knotsU: [],
      knotsV: [],
      patchSizeM: 10,
      vertices: doc.vertexIds,
      patches: doc.quadIds.map((quad, q) => ({
        quad,
        corners: doc.quads[q].map(v => doc.vertexIds[v]),
        domain: [0, 1, q / 2, (q + 1) / 2],
        base: [],
      })),
      evaluated: { points: [], patchSizeM: 10 },
    },
  ];
  return doc;
}
const doc = fixture(),
  raw = tessellateQuilt(deriveQuadMesh(doc)),
  smooth = buildMountainPreview(doc),
  side = PREVIEW_RES + 1;
assert.deepEqual(smooth.positions, raw.positions, 'smooth shading never changes the terrain');
// Find the seam independently by shared positions, covering both tensor axes and edge directions.
for (const transposed of [false, true]) {
  const pair = fixture();
  if (transposed) {
    pair.quads = pair.quads.map(([a, b, c, d]) => [a, c, b, d]);
    const { mesh } = meshFromDoc(pair);
    pair.quadTwist = { 0: bilinearTwist(mesh, 0), 1: bilinearTwist(mesh, 1) };
  }
  const preview = buildMountainPreview(pair),
    original = tessellateQuilt(deriveQuadMesh(pair));
  let matches = 0;
  for (let a = 0; a < PATCH_VERTS; a++)
    for (let b = PATCH_VERTS; b < PATCH_VERTS * 2; b++)
      if ([0, 1, 2].every(d => Math.abs(preview.positions[a * 3 + d] - preview.positions[b * 3 + d]) < 1e-6)) {
        assert.deepEqual(
          preview.normals.slice(a * 3, a * 3 + 3),
          preview.normals.slice(b * 3, b * 3 + 3),
          'coincident seam vertices share normals',
        );
        matches++;
      }
  assert.equal(matches, side, 'the entire shared edge was checked');
  for (let q = 0; q < 2; q++)
    for (let u = 1; u < PREVIEW_RES; u++)
      for (let v = 1; v < PREVIEW_RES; v++) {
        const at = (q * PATCH_VERTS + u * side + v) * 3;
        assert.deepEqual(
          preview.normals.slice(at, at + 3),
          original.normals.slice(at, at + 3),
          'seam averaging leaves interior normals alone',
        );
      }
}
for (let i = 0; i <= PREVIEW_RES; i++) {
  const a = (PREVIEW_RES * side + i) * 3,
    b = (PATCH_VERTS + i) * 3;
  assert.deepEqual(smooth.normals.slice(a, a + 3), smooth.normals.slice(b, b + 3), 'shared shallow seam normals agree');
}
assert.notDeepEqual(smooth.normals, raw.normals, 'the original mild crease is reproduced');
assert.equal(
  smooth.colors[PATCH_VERTS * 3],
  Math.fround(surfaceStyle(doc.baseSurface).color[0] * 0.93),
  'a live surface retains the alternating patch preview',
);
assert.deepEqual(smooth.colors, raw.colors, 'smoothing normals preserves the patch preview colors');
const progressive = await buildMountainPreviewProgressive(doc, { onProgress() {}, yieldControl: async () => {} });
assert.deepEqual(progressive.normals, smooth.normals);
const moved = structuredClone(doc);
moved.quadTwist![0][2][1] += 0.1;
const affected = new Set([0]);
refreshPreviewPatches(moved, smooth, [0], affected);
assert(affected.has(1), 'normal changes relight the neighboring patch');
assert.equal(previewMismatch(moved, smooth), null, 'incremental smoothing matches a full rebuild');
const baked = { ...moved, surfaces: undefined };
assert(refreshPreviewConstruction(baked, smooth)?.size, 'removing surface ownership refreshes shading');
assert.equal(previewMismatch(baked, smooth), null, 'plain quad shading is restored after bake');
const sharp = fixture(10);
assert.deepEqual(
  buildMountainPreview(sharp).normals,
  tessellateQuilt(deriveQuadMesh(sharp)).normals,
  'sharp authored creases remain sharp',
);
// A fit can produce a seam sharper than the authored source. Classify the source, not that fitting error.
const artifact = fixture(10),
  oldPatches = artifact.surfaces![0].patches;
artifact.surfaces = undefined;
const start = artifact.vertexIds.length;
artifact.vertices.push(0, 0, 0, 10, 0, 0, 0, 0, 20, 10, 0, 20);
Object.assign(artifact, appendMeshIds(artifact, 4, 0));
artifact.freeEdges = [
  [start, start + 1],
  [start + 2, start + 3],
];
const source = createSurfaceFromProfiles(
  artifact,
  [
    [start, start + 1],
    [start + 2, start + 3],
  ],
  { patchSizeM: 10 },
);
assert(source.ok, source.ok ? '' : source.error);
source.doc.surfaces = [{ ...source.surface, patches: oldPatches }];
const fittedRaw = tessellateQuilt(deriveQuadMesh(source.doc)),
  fittedSmooth = buildMountainPreview(source.doc);
assert.notDeepEqual(
  fittedRaw.normals.slice(0, PATCH_VERTS * 6),
  fittedSmooth.normals.slice(0, PATCH_VERTS * 6),
  'smooth source removes a steep fitting artifact',
);
assert.deepEqual(fittedRaw.positions, fittedSmooth.positions, 'smoothing preserves fitted patch positions and count');
for (let i = 0; i <= PREVIEW_RES; i++) {
  const a = (PREVIEW_RES * side + i) * 3,
    b = (PATCH_VERTS + i) * 3;
  assert.deepEqual(
    fittedSmooth.normals.slice(a, a + 3),
    fittedSmooth.normals.slice(b, b + 3),
    'a fitting artifact has continuous lighting',
  );
}
console.log(
  'SURFACE SHADING PASS: source-aware fitted seams, preserved creases/positions, alternating tint, progressive load, incremental neighbors and bake',
);
