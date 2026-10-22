import * as THREE from 'three';
import { prepareRiderLighting, RIDER_LIGHT_SOURCE } from '../src/app/ride/rider-lighting';
import type { RiderLight } from '../src/core/lighting/rider-light';
import { attachCharacterRig } from '../src/app/ride/character-rig';
import { BLOCKY_RIDER_CHARACTER_ID } from '../src/core/characters/builtins';

const expect = (value: boolean, what: string) => {
  if (!value) throw new Error(what);
};
try {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  document.body.append(renderer.domElement);
  renderer.setSize(64, 64);
  renderer.setClearColor(0);
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error(
      [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join('\n'),
    );
  };
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 4));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const shared = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const owners: THREE.Group[] = [];
  const meshes: THREE.Mesh[] = [];
  for (const x of [-0.5, 0.5]) {
    const owner = new THREE.Group();
    owner.position.x = x;
    scene.add(owner);
    owners.push(owner);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.8), shared);
    owner.add(mesh);
    meshes.push(mesh);
    prepareRiderLighting(owner, owner, true);
  }
  expect(meshes[0].material !== meshes[1].material, 'riders share lighting state');
  let dark = false;
  scene.userData[RIDER_LIGHT_SOURCE] = (position: THREE.Vector3): RiderLight =>
    position.x < 0
      ? {
          ambient: dark ? [0, 0, 0] : [0.1, 0.2, 0.3],
          keys: dark ? [] : [{ color: [0.7, 0, 0], direction: [0, 0, 1] }],
        }
      : { ambient: [0.1, 0.6, 0.1], keys: [] };
  const pixel = (x: number) => {
    const data = new Uint8Array(4);
    const gl = renderer.getContext();
    gl.readPixels(x, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return [...data];
  };
  renderer.render(scene, camera);
  const bright = pixel(16),
    other = pixel(48);
  expect(Math.abs(bright[0] - 204) < 3 && Math.abs(bright[1] - 51) < 3, `display-domain lighting ${bright}`);
  expect(other[1] > 150 && other[0] < 28, `independent avatar lighting ${other}`);
  owners[0].rotation.y = Math.PI;
  renderer.render(scene, camera);
  const turned = pixel(16);
  expect(turned[0] < 28 && turned[2] > 74, `animated normal follows pose ${turned}`);
  dark = true;
  (meshes[0].material as THREE.MeshStandardMaterial).emissive.setRGB(0.1, 0, 0);
  renderer.render(scene, camera);
  const glow = pixel(16);
  expect(glow[0] > 85 && glow[0] < 93 && glow[1] === 0, `emissive survives shade ${glow}`);
  expect(pixel(48)[1] > 150, 'shade from first rider leaked to second');

  // The same hook must see normals after actual GPU skinning.
  const bone = new THREE.Bone();
  const geometry = new THREE.PlaneGeometry(0.9, 1.8);
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(16), 4));
  const weights = new Float32Array(16);
  for (let i = 0; i < 4; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const skin = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  );
  skin.add(bone);
  skin.bind(new THREE.Skeleton([bone]));
  owners[0].remove(meshes[0]);
  owners[0].rotation.y = 0;
  owners[0].add(skin);
  prepareRiderLighting(skin, owners[0]);
  dark = false;
  renderer.render(scene, camera);
  expect(pixel(16)[0] > 200, 'skinned avatar receives light');
  bone.rotation.y = Math.PI;
  renderer.render(scene, camera);
  expect(pixel(16)[0] < 28, 'light ignores skinned normal');
  delete scene.userData[RIDER_LIGHT_SOURCE];
  renderer.render(scene, camera);
  expect(pixel(16)[1] > 200, 'studio fallback remains available without course data');

  // Exercise the asynchronous GLB path, not just a synthetic material.
  for (const owner of owners) scene.remove(owner);
  const actual = new THREE.Group();
  scene.add(actual);
  const character = attachCharacterRig(actual, BLOCKY_RIDER_CHARACTER_ID);
  const deadline = performance.now() + 10000;
  while (actual.userData.riderVisual !== BLOCKY_RIDER_CHARACTER_ID && performance.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  expect(actual.userData.riderVisual === BLOCKY_RIDER_CHARACTER_ID, 'built-in character did not load');
  camera.position.set(0, 0.85, 3);
  camera.lookAt(0, 0.85, 0);
  scene.userData[RIDER_LIGHT_SOURCE] = () => ({ ambient: [1, 1, 1], keys: [] });
  renderer.render(scene, camera);
  const energy = () => {
    const data = new Uint8Array(64 * 64 * 4);
    const gl = renderer.getContext();
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum;
  };
  const modelBright = energy();
  scene.userData[RIDER_LIGHT_SOURCE] = () => ({ ambient: [0.1, 0.1, 0.1], keys: [] });
  renderer.render(scene, camera);
  const modelDark = energy();
  expect(modelBright > 10000 && modelDark < modelBright * 0.15, `built-in character shade ${modelBright}/${modelDark}`);
  character.dispose();
  document.documentElement.dataset.riderLightResult = JSON.stringify({ ok: true, bright, other, turned, glow });
} catch (error) {
  document.documentElement.dataset.riderLightResult = JSON.stringify({ ok: false, error: String(error) });
}
