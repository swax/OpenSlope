/**
 * Browser half of fog-opacity.ts. Renders ONE fog puff through Three's real Sprite path, over two known
 * backdrops, fogged and clear — the four frames the per-pixel opacity solve needs.
 *
 * The geometry deliberately copies the Unity rig exactly (60 degree fov, 1280x720, backdrop at 20 m, puff at
 * 8 m with a 2 m half-width, backdrops sRGB 64 and 153) so the two readings differ by the RENDERER and
 * nothing else. Three's defaults do the rest: no tone mapping, sRGB output, colour management on — so the
 * blend happens in linear light and the PNG is sRGB-encoded, exactly like Unity in Linear colour space.
 */
import * as THREE from 'three';
import { FOG_PUFF_COMPOSITE } from '../../src/app/viewport/scene/particle-volumes';

interface FogShot { name: string; png: string }
interface FogResult {
  ok: boolean;
  error?: string;
  renderer?: string;
  shots?: FogShot[];
  geometry?: Record<string, number>;
  material?: Record<string, number | string>;
}

const W = 1280, H = 720;
const PUFF_Z = 8, BACK_Z = 20, HALF_WIDTH_M = 2;
const DARK = 0x404040, LIGHT = 0x999999;   // sRGB 64 and 153, matching the Unity rig's rendered values

const publish = (result: FogResult) => {
  (globalThis as typeof globalThis & { __fogOpacity?: FogResult }).__fogOpacity = result;
  document.documentElement.dataset.fogOpacity = result.ok ? 'passed' : 'failed';
};

async function run(): Promise<void> {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 500);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);   // three looks down -Z, so the rig sits at negative z

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 50),
    new THREE.MeshBasicMaterial({ color: DARK, toneMapped: false }));
  backdrop.position.set(0, 0, -BACK_Z);
  scene.add(backdrop);

  const texture = await new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load('/fog0.png',
      loaded => { loaded.colorSpace = THREE.SRGBColorSpace; loaded.needsUpdate = true; resolve(loaded); },
      undefined, () => reject(new Error('fog0.png did not load')));
  });

  // The shipped compositing, imported rather than copied, so this cannot silently measure stale numbers.
  const material = new THREE.SpriteMaterial({
    map: texture, ...FOG_PUFF_COMPOSITE, transparent: true, depthTest: true, depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(0, 0, -PUFF_Z);
  // A Three sprite of scale s spans s world units, so half-width = s/2. Matched to the Unity billboard's
  // 2 m half-width rather than to a stored puff radius: what is being compared is the MATERIAL, and the
  // radius-to-draw-size mapping (PUFF_DRAW_DIAMETER) is a separate question with its own answer.
  sprite.scale.setScalar(HALF_WIDTH_M * 2);
  scene.add(sprite);

  const shots: FogShot[] = [];
  for (const fogOn of [true, false]) {
    sprite.visible = fogOn;
    for (const [label, hex] of [['dark', DARK], ['light', LIGHT]] as const) {
      (backdrop.material as THREE.MeshBasicMaterial).color.setHex(hex);
      renderer.render(scene, camera);
      shots.push({ name: `s-${label}-${fogOn ? 'fog' : 'clear'}`, png: canvas.toDataURL('image/png') });
    }
  }

  const context = renderer.getContext();
  const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
  publish({
    ok: true,
    renderer: debugInfo ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : 'unknown',
    shots,
    geometry: { width: W, height: H, fov: 60, puffZ: PUFF_Z, backZ: BACK_Z, halfWidthM: HALF_WIDTH_M },
    material: {
      opacity: FOG_PUFF_COMPOSITE.opacity,
      color: '#' + FOG_PUFF_COMPOSITE.color.toString(16),
      blending: FOG_PUFF_COMPOSITE.blending === THREE.NormalBlending ? 'NormalBlending' : 'other',
      toneMapping: renderer.toneMapping,
      outputColorSpace: renderer.outputColorSpace === THREE.SRGBColorSpace ? 1 : 0,
    },
  });
}

run().catch((error: unknown) => publish({
  ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error),
}));
