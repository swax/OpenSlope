// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import {
  buildMountainPreview,
  refreshPreviewPatches,
  PATCH_VERTS,
  type PreviewData,
} from '../src/core/mesh/tessellation';
import { createTerrainLayer, type TerrainLightOptions } from '../src/app/viewport/mesh/terrain';
import type { Stage } from '../src/app/viewport/stage';
import type { TileMaterials } from '../src/app/viewport/mesh/tile-materials';

const doc = blankMountain('PIXEL_LIGHT');
doc.vertices = [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10, 0, 0, 20, 10, 0, 20];
doc.quads = [
  [0, 1, 2, 3],
  [2, 3, 4, 5],
];
Object.assign(doc, appendMeshIds(doc, 6, 2));
const options: TerrainLightOptions = {
  dir: [0, 1, 0],
  sun: 0.6,
  ambient: 0.2,
  shadow: 0,
  ao: 0,
  sunTint: [1, 0.9, 0.8],
  skyTint: [0.7, 0.8, 1],
};
let mode: 'surface' | 'textured' | 'none' = 'surface';
function layer(preview: PreviewData) {
  const result = createTerrainLayer(
    { worldRoot: new THREE.Group() } as Stage,
    {} as TileMaterials,
    { shading: () => mode, rigData: () => null, rigVisible: () => false },
    { onGeometryRebuilt() {} },
    { pickTarget: false },
  );
  assert.equal(result.terrain.visible, false, 'empty terrain is hidden until its normals are installed');
  result.applyPreview(preview);
  result.setTerrainLight(options);
  return result;
}
const preview = buildMountainPreview(doc),
  incremental = layer(preview),
  attributes = ['terrainSun', 'terrainSky', 'terrainGlow', 'terrainAlbedo', 'terrainLightOptions'];
for (const name of attributes)
  (incremental.terrain.geometry.getAttribute(name) as THREE.BufferAttribute).clearUpdateRanges();
doc.quadTwist = {
  0: [
    [0, 3, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
};
refreshPreviewPatches(doc, preview, [0]);
incremental.updatePatches(new Set([0]), [[0, PATCH_VERTS]], { geometry: true, materials: false });
const full = layer(buildMountainPreview(doc));
for (const name of attributes) {
  const a = incremental.terrain.geometry.getAttribute(name) as THREE.BufferAttribute,
    b = full.terrain.geometry.getAttribute(name);
  assert.deepEqual(a.array, b.array, `${name}: incremental light inputs equal a full rebuild`);
  assert.deepEqual(
    a.updateRanges,
    [{ start: 0, count: PATCH_VERTS * a.itemSize }],
    `${name}: upload only the edited patch`,
  );
}
incremental.setTerrainBakedView(true);
assert.equal(
  incremental.terrain.geometry.getAttribute('terrainLightOptions').getW(PATCH_VERTS),
  2,
  'baked view updates every patch',
);
mode = 'none';
incremental.applyTerrainLight();
assert(
  Array.from(incremental.terrain.geometry.getAttribute('terrainAlbedo').array).every(v => v === 1),
  'non-Surface views omit the surface tint',
);
mode = 'textured';
incremental.applyTerrainLight();
assert.deepEqual(
  incremental.terrain.geometry.getAttribute('terrainAlbedo').array,
  preview.colors,
  'lit unpainted terrain keeps its alternating patch colors in Textured view too',
);
mode = 'surface';
incremental.setTerrainLight(null);
const materials = Array.isArray(incremental.terrain.material)
  ? incremental.terrain.material
  : [incremental.terrain.material];
assert(materials[0] instanceof THREE.MeshPhongMaterial, 'sun-off surface lighting uses interpolated per-pixel normals');
incremental.release();
full.release();
console.log(
  'TERRAIN PIXEL INPUTS PASS: incremental/full equivalence, partial uploads, baked mode, surface tint and studio fallback.',
);
