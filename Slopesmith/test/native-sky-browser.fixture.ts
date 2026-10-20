import GUI from 'lil-gui';
import * as THREE from 'three';
import { browserExportProvider } from '../src/app/export/provider';
import { clientFetch } from '../src/app/net/client';
import { cachedIsoCourses, cacheTransaction, isoCourseCacheVersion, openIsoCache } from '../src/app/public/iso-cache';
import { prepareEditorWorkspace } from '../src/app/public/local-editor';
import { localMapData } from '../src/app/public/local-map-data';
import { installLocalSky } from '../src/app/public/sky';
import { createSkybox } from '../src/app/sky/session';
import { createStore } from '../src/app/state/store';
import { createSky } from '../src/app/viewport/scene/sky';
import { defaultMountain } from '../src/core/doc/mountain';
import type { NativeSkyPayload } from '../src/shared/map-sky';

const day = 'SSXOT_ER4_DAY',
  night = 'SSXOT_ER4_NIGHT';
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const waitFor = async (ready: () => boolean) => {
  const until = performance.now() + 5000;
  while (!ready()) {
    if (performance.now() > until) throw new Error('Sky never finished loading');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

async function run() {
  const colors: Record<string, string> = { [day]: '#2c90ce', [night]: '#34204c' };
  const sourceFiles = new Map<string, Map<string, Blob>>();
  const db = await openIsoCache();
  for (const course of [day, night]) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = colors[course];
    context.fillRect(0, 0, 4, 4);
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    const files = new Map([
      [
        'Skybox/Models.json',
        new Blob([
          JSON.stringify({
            Models: [
              {
                ModelName: 'dome',
                ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'sky.obj', MaterialID: 0 }] }],
              },
            ],
          }),
        ]),
      ],
      [
        'Skybox/Materials.json',
        new Blob([JSON.stringify({ Materials: [{ TexturePath: 'sky.png', AlphaMode: 'opaque' }] })]),
      ],
      [
        'Skybox/Meshes/sky.obj',
        new Blob([
          'v -500 -1000 -500\nv 500 -1000 -500\nv 500 -1000 500\nv -500 -1000 500\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3\nf 1/1 3/3 4/4\n',
        ]),
      ],
      ['Skybox/Textures/sky.png', png],
    ]);
    sourceFiles.set(course, files);
    await cacheTransaction(db, 'files', 'readwrite', store => {
      for (const [path, blob] of files) store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
    });
    await cacheTransaction(db, 'courses', 'readwrite', store => store.put({ course, version: 7, files: files.size }));
  }
  check((await cachedIsoCourses()).join() === day, 'Keep revision-7 day imports; request a fresh empty night import');
  await cacheTransaction(db, 'courses', 'readwrite', store =>
    store.put({ course: night, version: isoCourseCacheVersion(night), files: 4 }),
  );
  db.close();
  history.replaceState(null, '', `/editor/Test?local=new&reference=${day}`);
  await prepareEditorWorkspace({ accounts: 'required' });
  const catalogue = await (await clientFetch('/api/skybox')).json();
  check(catalogue.levels.length === 0, 'Native skies need no measured panorama ring');
  check(
    catalogue.nativeLevels.includes(day) && catalogue.nativeLevels.includes(night),
    'Local editor catalogue includes both original skies with canonical names',
  );
  const payload = async (level: string): Promise<NativeSkyPayload> =>
    (await clientFetch(`/api/skybox/native?level=${level}`)).json();
  const daySky = await payload(day),
    nightSky = await payload(night);
  check(
    daySky.parts.length === 1 && nightSky.parts.length === 1 && nightSky.parts[0].texture?.startsWith('blob:'),
    `Local sky API resolves original mesh and browser-local textures: ${JSON.stringify({ daySky, nightSky })}`,
  );

  const scene = new THREE.Scene();
  const background = new THREE.Color('#112233');
  scene.background = background;
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(32, 32);
  const target = new THREE.WebGLRenderTarget(32, 32);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 4000);
  const sky = createSky({ scene } as any);
  const viewport = {
    setSky: sky.setSky,
    showSky: sky.setVisible,
    setSkyTopColor: sky.setTopColor,
    nearestMountainWorld: 'reference',
    riding: false,
    xrPresenting: false,
  } as any;
  const pixel = () => {
    sky.follow(camera.position);
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(0, 0, -1)));
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const bytes = new Uint8Array(4);
    renderer.readRenderTargetPixels(target, 16, 16, 1, 1, bytes);
    return '#' + [...bytes.subarray(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('');
  };
  const store = createStore({ mdoc: defaultMountain(), currentMode: 'props', storedUi: {} });
  store.skyboxVisible = true;
  const gui = new GUI();
  const logs: string[] = [];
  const session = createSkybox({
    store,
    viewport,
    previewFolder: gui.addFolder('Preview'),
    skyFolder: gui.addFolder('Authored'),
    refSkyFolder: gui.addFolder('Reference'),
    persistDoc() {},
    persistUi() {},
    log: message => logs.push(message),
    isPreviewSelected: () => false,
    onVisibleWorldChange() {},
    refreshView() {},
  });
  await session.initSky();
  session.setupRefSkyUi(day);
  await waitFor(() => sky.loaded);
  check(pixel() === colors[day], 'Editor displays the original day sky');
  session.setupRefSkyUi(night);
  await waitFor(() => sky.loaded);
  check(pixel() === colors[night], 'Switching editor reference displays the night sky');
  camera.position.set(120, 400, -90);
  check(pixel() === colors[night], 'Original sky follows the camera without parallax');
  session.setSkyboxVisible(false);
  check(
    scene.background === background && sky.horizonColor() === null && pixel() === '#112233',
    'Sky toggle hides geometry and restores editor background',
  );
  session.setSkyboxVisible(true);
  check(pixel() === colors[night], 'Sky toggle restores the selected original sky');

  // Adoption still uses the ordinary document shape and preserves every original file on export.
  const adopt = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('use for my map'));
  check(adopt, 'Native reference offers adoption');
  (adopt as HTMLButtonElement).click();
  check(
    store.mdoc.skybox?.source.kind === 'level' && store.mdoc.skybox.source.level === night,
    'Adoption stores a portable level sky',
  );
  const exported = await browserExportProvider({ folderName: 'sky-test', existingFile: async () => false }).skybox(
    store.mdoc.skybox!,
  );
  for (const [path, blob] of sourceFiles.get(night)!) {
    const file = exported.files.find(file => file.path === path);
    check(
      file && String(file.bytes) === String(new Uint8Array(await blob.arrayBuffer())),
      `Export preserves original bytes: ${path}`,
    );
  }
  check(!exported.files.some(file => file.path.endsWith('/Ring.json')), 'No invented panorama geometry is exported');
  const skyDoc = JSON.parse(
    new TextDecoder().decode(exported.files.find(file => file.path === 'Skybox/Sky.json')!.bytes),
  );
  check(skyDoc.Level === night && skyDoc.Source === 'level', 'Export identifies the original course sky');

  const local = await localMapData([day, night]);
  const playerSky = await installLocalSky(viewport, local.source, night, local.fileUrl);
  playerSky!.setVisible(true);
  await waitFor(() => sky.loaded);
  check(pixel() === colors[night], 'Public Play uses the same original night sky renderer');
  playerSky!.setVisible(false);
  check(scene.background === background, 'Leaving Play restores the preview backdrop');

  // SSX 3 has blended horizon tiles. They must blend with the sky before any world geometry draws.
  const translucent = document.createElement('canvas');
  translucent.width = translucent.height = 4;
  const translucentContext = translucent.getContext('2d')!;
  translucentContext.fillStyle = 'rgba(255, 0, 0, 0.5)';
  translucentContext.fillRect(0, 0, 4, 4);
  const translucentUrl = translucent.toDataURL();
  const world = new THREE.Group();
  const worldMaterial = new THREE.MeshBasicMaterial({ color: '#f0e0d0', side: THREE.DoubleSide });
  const worldMesh = new THREE.Mesh(new THREE.PlaneGeometry(50, 50), worldMaterial);
  world.add(worldMesh);
  scene.add(world);
  world.position.copy(camera.position);
  for (const mode of ['opaque', 'cutout', 'blend', 'glow']) {
    const parts = [structuredClone(daySky.parts[0])];
    if (mode !== 'opaque') parts.push({ ...structuredClone(parts[0]), texture: translucentUrl, alphaMode: mode });
    sky.setSky({ native: { level: 'SSX3_A', parts }, topColor: '#112233' });
    sky.setVisible(true);
    await waitFor(() => sky.loaded);
    world.visible = false;
    const skyOnly = pixel();
    if (mode === 'blend') {
      check(skyOnly !== colors[day] && skyOnly !== '#ff0000', 'Sky alpha still blends its tile with the backdrop');
    }
    world.visible = true;
    for (const distance of [3, 30]) {
      worldMesh.position.z = -distance;
      check(pixel() === '#f0e0d0', `${mode} sky cannot paint over the nearby rider or farther terrain (${distance}m)`);
    }
    worldMaterial.transparent = true;
    worldMaterial.opacity = 0.5;
    worldMaterial.needsUpdate = true;
    check(pixel() !== skyOnly, `${mode} sky also stays behind translucent world props`);
    worldMaterial.transparent = false;
    worldMaterial.opacity = 1;
    worldMaterial.needsUpdate = true;
    for (const shift of [0, 300, -800]) {
      camera.position.x += shift;
      world.position.copy(camera.position);
      check(pixel() === '#f0e0d0', `${mode} sky remains behind the moving camera's world`);
    }
    world.renderOrder = -2000;
    check(pixel() === '#f0e0d0', `${mode} sky precedes world groups with their own draw priority`);
    world.renderOrder = 0;
  }
  world.removeFromParent();
  worldMesh.geometry.dispose();
  worldMaterial.dispose();

  sky.setSky({ native: daySky, topColor: '#112233' });
  sky.setVisible(false);
  await waitFor(() => sky.loaded);
  check(pixel() === '#112233', 'A texture finishing after hide cannot make the sky reappear');
  sky.setVisible(true);
  check(pixel() === colors[day], 'Original mesh really draws over a different top fill');
  const slowDay = structuredClone(daySky);
  slowDay.parts[0].texture = '/slow.png';
  sky.setSky({ native: slowDay });
  sky.setSky({ native: nightSky });
  await waitFor(() => sky.loaded);
  await new Promise(resolve => setTimeout(resolve, 180));
  check(
    pixel() === colors[night] && scene.children.length === 2,
    'A late previous sky is disposed rather than replacing or leaking beside the current sky',
  );

  sky.setSky({ panorama: daySky.parts[0].texture!, ground: daySky.parts[0].texture!, topColor: colors[day] });
  await waitFor(() => sky.loaded);
  check(pixel() === colors[day], 'Existing panorama skies still render after switching from an original dome');
  sky.setSky(null);
  check(!sky.loaded && scene.background === background, 'Clearing a sky releases the active backdrop');
  check(logs.length === 0, logs.join('\n'));
  local.dispose();
  gui.destroy();
  target.dispose();
  renderer.dispose();
  return {
    catalogue: catalogue.nativeLevels,
    checks:
      'cache → local API → editor session → WebGL → adoption/export → Play → opaque/alpha sky occlusion → visibility/load lifecycle',
  };
}
void run()
  .then(result => {
    (window as any).nativeSkyResult = result;
  })
  .catch(error => {
    (window as any).nativeSkyError = String(error?.stack ?? error);
  });
