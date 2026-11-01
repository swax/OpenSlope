import * as THREE from 'three';
import type { Stage } from '../src/app/viewport/stage';
import type { LightsLayer } from '../src/app/viewport/scene/lights';
import type { LevelProps } from '../src/core/reference/props';
import type { PlacedProp } from '../src/core/doc/types';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createPropsLayer } from '../src/app/viewport/scene/props';
import { createPropLevelLoader } from '../src/app/props/level-loader';
import { createTileMaterials } from '../src/app/viewport/mesh/tile-materials';
import { PropPreview } from '../src/app/props/preview';
import { Palette } from '../src/app/paint/palette';
import { propLoadState } from '../src/app/state/asset-loads';
import { setAssetBackground } from '../src/app/net/asset-images';

const scene = new THREE.Scene();
const worldRoot = new THREE.Group();
scene.add(worldRoot, new THREE.AmbientLight(0xffffff, 3));
const stage = {
  scene,
  worldRoot,
  cb: {},
  gizmoKind: null,
  gizmo: { dragging: false },
  attachGizmo(_object: THREE.Object3D, kind: Stage['gizmoKind']) {
    stage.gizmoKind = kind;
  },
  detachGizmo() {
    stage.gizmoKind = null;
  },
  reframeGizmo() {},
} as unknown as Stage;
const lights = {
  authoredRigData: null,
  authoredLightsVisible: false,
  selectedSetLights: [],
  setPropSelection() {},
} as unknown as LightsLayer;
const assets = createPropAssets();
const layer = createPropsLayer(stage, assets, lights);
const placement: PlacedProp = {
  id: 'missing-prop',
  level: 'MODEL',
  model: 7,
  name: 'Lost tree',
  pos: [0, 0, 0],
  yaw: 25,
  scale: 1.5,
};
const original = JSON.stringify(placement);
const loader = createPropLevelLoader({
  levels: new Map(),
  url: level => `/api/props?level=${level}`,
  register: props => assets.registerPropModels(props),
});
void loader.ensure('MODEL').catch(() => {});
layer.setPlacedProps([placement], null, []);

const preview = new PropPreview();
preview.show('MODEL', 7, placement.name, undefined);
const palette = new Palette({ onSelect() {} });
palette.setVisible(true);
palette.setCurrent({ kind: 'tile', ref: 'TEXTURES/lost.png', surface: 1, rot: 0, mirror: false });
document.getElementById('prop')!.append(preview.el);
document.getElementById('texture')!.append(palette.el);
const swatch = document.getElementById('swatch')!;
setAssetBackground(swatch, '/api/texture?level=TEXTURES&name=lost.png');
const tiles = createTileMaterials(() => {});
tiles.ensure('TEXTURES/lost.png');
const propMaterial = assets.propTex.material('TEXTURES', 'lost.png');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(256, 256);
renderer.setClearColor(0x10202e);
document.getElementById('scene')!.append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 30);
camera.position.set(3, 2, 4);
camera.lookAt(0, 0.7, 0);
function draw() {
  scene.updateMatrixWorld(true);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(draw);

window.missingAssets = {
  snapshot() {
    const root = layer.placedPropMeshes[0];
    const box = root?.children.find(child => child.userData.propPlaceholder) as THREE.Mesh | undefined;
    const material = box?.material as THREE.MeshBasicMaterial | undefined;
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0.5, 4), new THREE.Vector3(0, 0, -1));
    scene.updateMatrixWorld(true);
    const hit = root ? ray.intersectObject(root, true).find(item => item.object.userData.propIndex === 0) : undefined;
    const texture = tiles.ensure('TEXTURES/lost.png');
    const image = texture?.image as HTMLCanvasElement | undefined;
    const pixels = image?.getContext?.('2d')?.getImageData(0, 0, 16, 1).data;
    return {
      state: propLoadState('MODEL', 7),
      color: material?.color.getHex(),
      pickable: !!hit,
      propIndex: hit?.object.userData.propIndex,
      texturePending: !texture,
      missingTexture: !!texture?.userData.missingAsset,
      propMissingTexture: !!propMaterial.map?.userData.missingAsset,
      first: pixels ? Array.from(pixels.slice(0, 4)) : [],
      second: pixels ? Array.from(pixels.slice(32, 36)) : [],
      unchanged: original === JSON.stringify(placement),
      colliderCount: layer.rideColliders().length,
      gizmo: stage.gizmoKind,
    };
  },
  select() {
    layer.seatProp(0);
  },
  recover() {
    const geometry = new THREE.BoxGeometry(100, 100, 100).translate(0, 0, 50);
    const props: LevelProps = {
      level: 'MODEL',
      models: [
        {
          id: 7,
          name: 'Found tree',
          subs: [
            {
              mat: 0,
              positions: geometry.getAttribute('position').array as Float32Array,
              uvs: geometry.getAttribute('uv').array as Float32Array,
              indices: new Uint32Array(geometry.index!.array),
            },
          ],
        },
      ],
      materials: new Map(),
      instances: [],
      crowdFrames: [],
    };
    assets.registerPropModels(props);
    preview.show('MODEL', 7, 'Found tree', props);
  },
  async retry() {
    await loader.ensure('MODEL').catch(() => {});
  },
  drawTexture() {
    const texture = tiles.ensure('TEXTURES/lost.png');
    if (!texture) return false;
    const textured = new THREE.Scene();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), tiles.material('TEXTURES/lost.png', texture));
    textured.add(plane, new THREE.AmbientLight(0xffffff, Math.PI));
    const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    flat.position.z = 2;
    renderer.setAnimationLoop(null);
    renderer.render(textured, flat);
    const gl = renderer.getContext(),
      pixels = new Uint8Array(256 * 256 * 4);
    gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let pink = 0,
      dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 180 && pixels[i + 1] < 30 && pixels[i + 2] > 180) pink++;
      if (pixels[i] < 60 && pixels[i + 1] < 30 && pixels[i + 2] < 60) dark++;
    }
    return pink > 1000 && dark > 1000;
  },
};
export type MissingAssetsFixture = typeof window.missingAssets;
declare global {
  interface Window {
    missingAssets: {
      snapshot(): {
        state: string;
        color?: number;
        pickable: boolean;
        propIndex?: number;
        texturePending: boolean;
        missingTexture: boolean;
        propMissingTexture: boolean;
        first: number[];
        second: number[];
        unchanged: boolean;
        colliderCount: number;
        gizmo: string | null;
      };
      select(): void;
      recover(): void;
      retry(): Promise<void>;
      drawTexture(): boolean;
    };
  }
}
