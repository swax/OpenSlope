import * as THREE from 'three';
import { terrainPixelLighting } from '../src/app/viewport/mesh/terrain-lighting-material';
import { tintBackfaces } from '../src/app/viewport/mesh/backface-tint';
import { computeModelColored } from '../src/core/lighting/lightmap';
import { bakedLightmapDisplay, compositeRigGlow } from '../src/core/lighting/bake';
import { lightToWorkingSpace } from '../src/core/lighting/color-space';
import { useTextureArray } from '../src/app/viewport/mesh/texture-array';
import { createTerrainLayer } from '../src/app/viewport/mesh/terrain';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import type { Stage } from '../src/app/viewport/stage';
import type { TileMaterials } from '../src/app/viewport/mesh/tile-materials';
import { createTileMaterials } from '../src/app/viewport/mesh/tile-materials';

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(32, 32);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const scene = new THREE.Scene(),
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 2;
const geometry = new THREE.PlaneGeometry(2, 2),
  material = terrainPixelLighting(
    tintBackfaces(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })),
  ),
  mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
const normals = geometry.getAttribute('normal');
for (let i = 0; i < normals.count; i++) normals.setXYZ(i, geometry.getAttribute('position').getX(i) * 0.8, 0.6, 0);
const constant = (name: string, values: number[]) =>
  geometry.setAttribute(
    name,
    new THREE.Float32BufferAttribute(Array.from({ length: 4 }, () => values).flat(), values.length),
  );
constant('color', [0.01, 0.01, 0.01]); // The authored shader must replace already-lit vertex colors.
constant('terrainSun', [0.4, 0.32, 0.24]);
constant('terrainSky', [0.1, 0.12, 0.14]);
constant('terrainGlow', [0, 0, 0]);
constant('terrainAlbedo', [1, 1, 1]);
constant('terrainLightOptions', [0, 1, 0, 1]);
const pixels = new Uint8Array(32 * 32 * 4),
  gl = renderer.getContext();
const render = () => {
  renderer.render(scene, camera);
  gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
};
const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
let checks = 0;
function compare(baked: boolean, glow = [0, 0, 0], albedo = [1, 1, 1], texture = [1, 1, 1], sun = 0.4) {
  constant('terrainSun', [sun, sun * 0.8, sun * 0.6]);
  constant('terrainGlow', glow);
  constant('terrainAlbedo', albedo);
  constant('terrainLightOptions', [0, 1, 0, baked ? 2 : 1]);
  render();
  for (let x = 1; x < 31; x++) {
    const nx = ((x + 0.5) / 16 - 1) * 0.8,
      length = Math.hypot(nx, 0.6),
      light = computeModelColored(new Float32Array([nx / length, 0.6 / length, 0]), [0, 1, 0], {
        sun,
        ambient: 0.1,
        shadow: 0,
        ao: 0,
        sunTint: [1, 0.8, 0.6],
        skyTint: [1, 1.2, 1.4],
      });
    compositeRigGlow(light, new Float32Array(glow));
    const expected = lightToWorkingSpace(baked ? bakedLightmapDisplay(light) : light);
    for (const y of [8, 24])
      for (let c = 0; c < 3; c++) {
        const actual = pixels[(y * 32 + x) * 4 + c],
          target = Math.round(255 * srgb(expected[c] * albedo[c] * texture[c]));
        if (Math.abs(actual - target) > 2) throw new Error(`pixel ${x},${y} channel ${c}: ${actual} != ${target}`);
        checks++;
      }
  }
}
try {
  compare(false);
  if (pixels[(8 * 32 + 16) * 4] < 125)
    throw new Error('Lighting is still interpolated from the darker endpoint colors.');
  compare(true);
  compare(false, [0.2, 0.05, 0.1], [0.7, 0.8, 0.9]);
  compare(false, [0, 0, 0], [1, 1, 1], [1, 1, 1], 0.2);
  const texture = new THREE.DataTexture(new Uint8Array([128, 192, 255, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  material.map = texture;
  material.needsUpdate = true;
  const linearTexture = lightToWorkingSpace(new Float32Array([128 / 255, 192 / 255, 1]));
  compare(false, [0, 0, 0], [1, 1, 1], Array.from(linearTexture));
  // Painted pages have their own albedo. Restoring the unpainted checker must not tint textures.
  const painted = createTileMaterials(() => {}).materialLit('fixture/painted', texture);
  mesh.material = painted;
  constant('terrainAlbedo', [1, 1, 1]);
  render();
  const untinted = pixels.slice();
  constant('terrainAlbedo', [0.2, 0.4, 0.6]);
  render();
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== untinted[i]) throw new Error('Painted texture inherited the unpainted patch tint.');
    checks++;
  }
  mesh.material = material;
  material.map = null;
  material.needsUpdate = true;
  for (const key of ['terrainSun', 'terrainSky', 'terrainGlow', 'terrainAlbedo', 'terrainLightOptions'])
    geometry.deleteAttribute(key);
  constant('color', [0.25, 0.4, 0.6]);
  render();
  for (let c = 0; c < 3; c++)
    if (Math.abs(pixels[(16 * 32 + 16) * 4 + c] - Math.round(255 * srgb([0.25, 0.4, 0.6][c]))) > 2)
      throw new Error('Shared reference material lost its baked vertex colors.');
  const array = new THREE.DataArrayTexture(new Uint8Array([128, 192, 255, 255]), 1, 1, 1);
  array.colorSpace = THREE.SRGBColorSpace;
  array.needsUpdate = true;
  useTextureArray(material, array, 'terrain-lighting-test');
  material.needsUpdate = true;
  constant('texArraySlice', [0]);
  constant('terrainSky', [0.1, 0.12, 0.14]);
  compare(false, [0, 0, 0], [1, 1, 1], Array.from(linearTexture));
  // The live editor can initialize a material while its terrain is still empty. Loading the quilt must
  // replace that no-normal shader variant, not keep its face-normal fallback for the rest of the session.
  scene.clear();
  const worldRoot = new THREE.Group(),
    key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(0, 0, 3);
  scene.add(worldRoot, key, new THREE.AmbientLight(0xffffff, 0.3));
  const layer = createTerrainLayer(
    { worldRoot } as Stage,
    {} as TileMaterials,
    { shading: () => 'surface', rigData: () => null, rigVisible: () => false },
    { onGeometryRebuilt() {} },
    { pickTarget: false },
  );
  renderer.compile(scene, camera);
  // Exercise recovery from an already-cached loading variant as well as the normal hidden-empty path.
  layer.terrain.visible = true;
  layer.terrain.frustumCulled = false;
  render();
  const doc = blankMountain('LOAD_NORMALS');
  doc.vertices = [-1, 1, 0, -1, -1, 0, 1, 1, 0, 1, -1, 0];
  doc.quads = [[0, 1, 2, 3]];
  Object.assign(doc, appendMeshIds(doc, 4, 1));
  doc.quadTwist = {
    0: [
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ],
  };
  layer.applyPreview(buildMountainPreview(doc));
  render();
  const loaded = pixels.slice(),
    current = layer.terrain.material as THREE.MeshPhongMaterial;
  layer.terrain.material = tintBackfaces(current.clone());
  render();
  let mismatches = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== loaded[i]) mismatches++;
  if (mismatches)
    throw new Error(
      `Loaded terrain retains a stale flat shader: ${mismatches} framebuffer channels differ from a fresh material.`,
    );
  checks += pixels.length;
  layer.release();
  Object.assign(window, { terrainPixelResult: { checks } });
} catch (error) {
  Object.assign(window, { terrainPixelError: String(error) });
}
