// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const source = `
import * as THREE from 'three';
import { readLevelPatches } from './src/shared/map-levels';
import { buildReferenceMesh, buildReferenceMeshProgressive } from './src/core/reference/terrain';
import { referencePatchContact } from './src/app/ride/patch-contact';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const patch = (PatchName, shift = 0, extra = {}) => ({ PatchName,
  Points: Array.from({ length: 16 }, (_, i) => [200000 + Math.floor(i/4)*100 + shift, 370000 + i%4*100 + shift, -480000]),
  SurfaceType: 1, TexturePath: 'snow.png', UVPoints: [[0,1],[1,1],[0,0],[1,0]],
  LightmapID: PatchName.includes('_off_') ? 50 : 69, LightMapPoint: [0.01,0.01,0.98,0.98], ...extra });
const on = patch('patch_er4_on_eventfinish_1012');
const off = patch('patch_er4_off_eventfinish_1012', 8);
const records = [on, off];
const bytes = JSON.stringify(records);
const read = async (level, game, rows = records) => {
  const io = { root: 'maps', readJsonOr: async (path, fallback) => path.endsWith('/Patches.json') ? { Patches: rows } :
    path.endsWith('/Import.json') ? { Game: game } : fallback };
  return (await readLevelPatches(io, level)).patches;
};
const patches = await read('SSXOT_ER4_DAY', 'ssx-on-tour');
check(patches.length === 2 && patches[0].Visable !== false && patches[1].Visable === false, 'Only the paired off state is suppressed');
check(patches[0].LightmapID === 69 && patches[1].LightmapID === 50, 'Keep both source lighting records');
check(JSON.stringify(records) === bytes, 'Read repair never changes stored source records');
check((await read('SSX3_TEST', 'ssx-3'))[1].Visable !== false, 'Other source games retain both records');
check((await read('RENAMED', 'ssx-on-tour'))[1].Visable === false, 'Import metadata identifies a renamed source');
check((await read('SSXOT_TEST', 'ssx-on-tour', [off]))[0].Visable !== false, 'An unpaired off patch stays visible');
check((await read('SSXOT_TEST', 'ssx-on-tour', [on, on, off]))[2].Visable !== false, 'Ambiguous duplicate names stay untouched');
check((await read('SSXOT_TEST', 'ssx-on-tour', [{...on, Visable:false}, off]))[1].Visable !== false, 'An explicitly hidden on state does not hide the remaining alternative');
const otherOff = patch('patch_er4_off_other_1012');
check((await read('SSXOT_TEST', 'ssx-on-tour', [patch('patch_er4_on_other_1012'), otherOff]))[1].Visable !== false, 'No broad on/off substring policy');
const texels = rgb => ({ a: new Float32Array(128*128).fill(1), rgb: Float32Array.from({length:128*128*3}, (_,i) => rgb[i%3]) });
const lightmaps = new Map([[69, texels([0,1,0])], [50, texels([1,0,0])]]);
const mesh = buildReferenceMesh(patches, lightmaps);
check(mesh.patchCount === 2 && mesh.patchVisible[0] && !mesh.patchVisible[1], 'Stable cell ordinals and explicit admission');
const per = mesh.facesPerPatch * 3;
check(mesh.indices.slice(per).every(i => i === mesh.indices[per]), 'Inactive state has no drawable triangles');
check(mesh.patchControls[1].length === 16 && mesh.patchTex[1] === 'snow.png', 'Inactive source geometry and appearance remain inspectable');
const query = referencePatchContact(mesh);
check(query(0, [0.2,0.3,0.5], new THREE.Vector3(), new THREE.Vector3()), 'Active smooth contact keeps its original face/cell join');
check(!query(mesh.facesPerPatch, [0.2,0.3,0.5], new THREE.Vector3(), new THREE.Vector3()), 'Inactive state cannot respond to a direct contact query');
const progressive = await buildReferenceMeshProgressive(patches, { yieldControl: async () => {} }, lightmaps);
check(progressive.indices.every((v,i) => v === mesh.indices[i]) && JSON.stringify(progressive.patchVisible) === JSON.stringify(mesh.patchVisible), 'Progressive load uses identical admission and indices');
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions,3));
geometry.setAttribute('color', new THREE.BufferAttribute(mesh.lightColor,3));
geometry.setIndex(new THREE.BufferAttribute(mesh.indices,1));
const scene = new THREE.Scene();
scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors:true, side:THREE.DoubleSide, toneMapped:false })));
const renderer = new THREE.WebGLRenderer(); renderer.setSize(96,96); renderer.setClearColor(0);
const target = new THREE.WebGLRenderTarget(96,96);
const center = new THREE.Vector3().fromArray(mesh.min).add(new THREE.Vector3().fromArray(mesh.max)).multiplyScalar(0.5);
const camera = new THREE.PerspectiveCamera(55,1,0.1,50000);
const pixels = new Uint8Array(96*96*4);
for (const offset of [[0,4,0.1],[2,3,2],[-2,3,-1],[0.2,2,-3]]) {
  camera.position.copy(center).add(new THREE.Vector3(...offset)); camera.lookAt(center); camera.updateMatrixWorld();
  renderer.setRenderTarget(target); renderer.render(scene,camera); renderer.readRenderTargetPixels(target,0,0,96,96,pixels);
  let green = 0, red = 0;
  for(let i=0; i<pixels.length; i+=4) { if(pixels[i+1]>20) green++; if(pixels[i]>20) red++; }
  check(green>100 && red===0, 'Only the enabled lightmap draws as the camera moves');
}
renderer.dispose(); target.dispose();
window.eventTerrainPassed = true;
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(
    request.url === '/fixture.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><script type="module" src="/fixture.js"></script>',
  );
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { waitUntil: 'networkidle' });
  await page
    .waitForFunction(() => (window as any).eventTerrainPassed, undefined, { timeout: 10_000 })
    .catch(() => assert.fail(errors.join('\n') || 'Event terrain fixture did not finish'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: On Tour event terrain admission, stable cells/contact, source preservation and camera-angle WebGL lighting',
  );
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
