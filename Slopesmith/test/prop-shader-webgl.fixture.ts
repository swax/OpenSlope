/**
 * Browser half of prop-shader-webgl.test.ts. This deliberately renders through Three's real WebGL program
 * builder: string/source checks cannot catch a symbol hidden behind Three's object-dependent USE_COLOR define.
 */
import * as THREE from 'three';
import { PropTextureCache, propLightIndexColor } from '../src/app/props/textures';
import { applyTextureAlphaMode } from '../src/app/props/texture-alpha';
import { propPreviewIntensity } from '../src/core/lighting/prop-lights';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';
import { applyPropShade, setPropShadeSun, PROP_SHADE_TINT, PROP_THROUGH_COLOR } from '../src/app/viewport/scene/prop-shade';

/** MESA's Lights.json type-0 record, normalised the way `sunFromLights` does: #ff681e, the most saturated
 *  sun a shipped level offers and so the sharpest test of which domain the tint arrives in. */
const MESA_SUN_TINT: [number, number, number] = [1, 0.4095, 0.116];

interface ShaderSmokeResult {
  ok: boolean;
  error?: string;
  programs?: number;
  customPixel?: number[];
  nativePixel?: number[];
  batchedNativePixel?: number[];
  clayLitPixel?: number[];
  clayDarkPixel?: number[];
  clayNoSunPixel?: number[];
  clayInstancedFrontPixel?: number[];
  clayInstancedBackPixel?: number[];
  clayContactPixel?: number[];
  sunTintPixel?: number[];
  flipIntactPixel?: number[];
  flipCrackedPixel?: number[];
  flipOtherPixel?: number[];
  partialAlphaPixel?: number[];
  cutoutCoverage?: number;
  lollipopAtlasPixel?: number[];
  renderer?: string;
}

const publish = (result: ShaderSmokeResult) => {
  (globalThis as typeof globalThis & { __propShaderSmoke?: ShaderSmokeResult }).__propShaderSmoke = result;
  document.documentElement.dataset.propShaderSmoke = result.ok ? 'passed' : 'failed';
};

function centrePixel(renderer: THREE.WebGLRenderer): number[] {
  const pixel = new Uint8Array(4);
  renderer.getContext().readPixels(32, 32, 1, 1, renderer.getContext().RGBA,
    renderer.getContext().UNSIGNED_BYTE, pixel);
  return [...pixel];
}

function pixelBlock(renderer: THREE.WebGLRenderer, x: number, y: number, width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  renderer.getContext().readPixels(x, y, width, height, renderer.getContext().RGBA,
    renderer.getContext().UNSIGNED_BYTE, pixels);
  return pixels;
}

async function run(): Promise<void> {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(64, 64, false);
  renderer.setClearColor(0x000000, 1);
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error([
      gl.getProgramInfoLog(program),
      `VERTEX: ${gl.getShaderInfoLog(vertex)}`,
      `FRAGMENT: ${gl.getShaderInfoLog(fragment)}`,
    ].filter(Boolean).join('\n'));
  };

  const scene = new THREE.Scene();
  const ambient = new THREE.AmbientLight(0xffffff, 2);
  scene.add(ambient);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
  camera.position.z = 3;

  const textures = new PropTextureCache();
  textures.setPs2Normals(true);
  textures.setNativeLighting([{
    sourceIndex: 0,
    lighting: { ambient: [128, 128, 128], keys: [] },
  }, {
    sourceIndex: 1,
    lighting: { ambient: [256, 256, 256], keys: [] },
  }]);

  // The main viewport intentionally has no MSAA (Stage's XR fill-cost contract), so a depth-writing cutout
  // cannot use Unity's alpha-to-coverage. Its partial-alpha edge band instead takes Three's stable alpha-hash
  // path. Render alpha=0.5 over black: a hard 0.05 alpha test would fill every sample; alpha hash must retain
  // approximately half, and its object-space pattern must not sparkle between unchanged frames.
  const cutoutTile = document.createElement('canvas');
  cutoutTile.width = cutoutTile.height = 1;
  cutoutTile.getContext('2d')!.putImageData(new ImageData(
    new Uint8ClampedArray([255, 255, 255, 128]), 1, 1), 0, 0);
  const cutoutTexture = new THREE.CanvasTexture(cutoutTile);
  cutoutTexture.minFilter = cutoutTexture.magFilter = THREE.NearestFilter;
  const cutoutMaterial = new THREE.MeshBasicMaterial({ map: cutoutTexture });
  applyTextureAlphaMode(cutoutMaterial, 'cutout');
  const cutoutMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cutoutMaterial);
  scene.add(cutoutMesh);
  renderer.render(scene, camera);
  const cutoutFirst = pixelBlock(renderer, 20, 20, 24, 24);
  renderer.render(scene, camera);
  const cutoutSecond = pixelBlock(renderer, 20, 20, 24, 24);
  scene.remove(cutoutMesh);
  let covered = 0;
  for (let i = 0; i < cutoutFirst.length; i += 4) if (cutoutFirst[i] > 128) covered++;
  const cutoutCoverage = covered / (cutoutFirst.length / 4);
  if (cutoutCoverage < 0.3 || cutoutCoverage > 0.7)
    throw new Error(`Single-sample cutout did not turn half alpha into partial coverage: ${cutoutCoverage}`);
  if (cutoutFirst.some((value, index) => value !== cutoutSecond[index]))
    throw new Error('Alpha-hash cutout coverage changed between identical frames');

  // Imported props use one atlas material for opaque candy and translucent wrapper pixels. Exercise that
  // exact blend + self-lit composition: alpha 64 over black must remain visibly partial. An accidental
  // alphaTest path makes this black, while a lost transparent flag makes it solid red.
  const partialTile = document.createElement('canvas');
  partialTile.width = partialTile.height = 1;
  partialTile.getContext('2d')!.putImageData(new ImageData(
    new Uint8ClampedArray([255, 0, 0, 64]), 1, 1), 0, 0);
  (textures as unknown as { loader: { load(url: string): THREE.Texture } }).loader = {
    load() { return new THREE.CanvasTexture(partialTile); },
  };
  const partialMaterial = textures.fullBright(textures.material('WEBGL', 'partial-alpha.png',
    undefined, [], undefined, { blend: true }));
  const partialMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), partialMaterial);
  scene.add(partialMesh);
  renderer.render(scene, camera);
  const partialAlphaPixel = centrePixel(renderer);
  scene.remove(partialMesh);
  if (partialAlphaPixel[0] < 32 || partialAlphaPixel[0] > 240
    || partialAlphaPixel[1] > 12 || partialAlphaPixel[2] > 12)
    throw new Error(`Self-lit imported-prop alpha did not blend partially: ${partialAlphaPixel}`);

  // Exercise the wrapped lollipop's real mixed opaque/translucent atlas too. The wrapper occupies the
  // bottom-right UV quarter exactly as the model maps it; blue behind the sheet makes partial compositing
  // unambiguous.
  const lollipopAtlas = await new THREE.TextureLoader().loadAsync('/wrapped-lollipop.png');
  lollipopAtlas.colorSpace = THREE.SRGBColorSpace;
  (textures as unknown as { loader: { load(url: string): THREE.Texture } }).loader = {
    load() { return lollipopAtlas; },
  };
  const lollipopMaterial = textures.fullBright(textures.material('WRAPPED-LOLLIPOP', 'wrapped-lollipop.png',
    undefined, [], undefined, { blend: true }));
  const lollipopGeometry = new THREE.PlaneGeometry(1, 1);
  const wrapperUv = lollipopGeometry.getAttribute('uv') as THREE.BufferAttribute;
  const u0 = 0.515625, v0 = 0.015625, u1 = 0.984375, v1 = 0.484375;
  wrapperUv.setXY(0, u0, v1); wrapperUv.setXY(1, u1, v1);
  wrapperUv.setXY(2, u0, v0); wrapperUv.setXY(3, u1, v0);
  const lollipopSheet = new THREE.Mesh(lollipopGeometry, lollipopMaterial);
  scene.add(lollipopSheet);
  renderer.setClearColor(0x0000ff, 1);
  renderer.render(scene, camera);
  const lollipopAtlasPixel = centrePixel(renderer);
  scene.remove(lollipopSheet);
  renderer.setClearColor(0x000000, 1);
  if (!lollipopMaterial.transparent || lollipopMaterial.alphaTest !== 0
    || lollipopAtlasPixel[0] < 16 || lollipopAtlasPixel[1] < 16
    || lollipopAtlasPixel[1] > 220 || lollipopAtlasPixel[2] < 96)
    throw new Error(`Wrapped-lollipop atlas did not blend over blue: ${lollipopAtlasPixel}`);

  // The authored sun's tint reaches a prop in the DISPLAY domain, and has to. `setPropLight` writes
  // `sunTint` into `propKey.color` with three's plain three-arg setRGB, so three treats it as a working-space
  // (linear) colour — which looks like the colour-space slip the terrain light had, and is not. Three's
  // linear Lambert is used here purely as an accumulator: `propPreviewIntensity` feeds PI so the BRDF's
  // 1/PI cancels and `ps2Light` comes out as the GAME's own byte-domain factor, which
  // `ps2ColorModulationShader` then multiplies into the diffuse in sRGB space, the way the GS does
  // (core/lighting/prop-lights.ts, docs/032 · lighting). Converting the tint on the way in would make that a
  // linear number consumed as a gamma one and drive the prop hard toward its peak channel.
  //
  // Reasoning that out is exactly how it gets "fixed" backwards, so render it. A white texel under a tint of
  // (1, 0.4095, 0.116) — MESA's recovered sun — must draw carrying THAT ratio between channels; converted, it
  // would draw at (1, 0.1396, 0.0127), roughly 3x more saturated. Ratios rather than absolutes, so the check
  // is independent of the key scale and the intensity constant.
  const whiteTile = document.createElement('canvas');
  whiteTile.width = whiteTile.height = 1;
  whiteTile.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1), 0, 0);
  (textures as unknown as { loader: { load(url: string): THREE.Texture } }).loader = {
    load() { const t = new THREE.CanvasTexture(whiteTile); t.colorSpace = THREE.SRGBColorSpace; return t; },
  };
  const tintMaterial = textures.material('WEBGL', 'sun-tint-white.png');
  const tintSheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), tintMaterial);
  const key = new THREE.DirectionalLight(0xffffff, propPreviewIntensity(1));
  key.color.setRGB(...MESA_SUN_TINT); // verbatim how setPropLight hands the authored tint over
  key.position.set(0, 0, 10);         // square onto the +Z sheet: N.L = 1
  const ambientWas = ambient.intensity;
  ambient.intensity = 0;              // the key alone, so the tint is the only thing in the pixel
  scene.add(tintSheet, key);
  renderer.render(scene, camera);
  const sunTintPixel = centrePixel(renderer);
  scene.remove(tintSheet, key);
  ambient.intensity = ambientWas;
  if (sunTintPixel[0] < 24)
    throw new Error(`Prop key produced no light to read a tint from: ${sunTintPixel}`);
  const tintRatio = [sunTintPixel[1] / sunTintPixel[0], sunTintPixel[2] / sunTintPixel[0]];
  const drift = tintRatio.map((r, i) => Math.abs(r - MESA_SUN_TINT[i + 1]));
  if (Math.max(...drift) > 0.06)
    throw new Error('Prop key tint did not reach the pixel in the display domain — the PS2 modulation '
      + `multiplies in sRGB, so the tint must NOT be linearised. Drew ${sunTintPixel} `
      + `(G/R ${tintRatio[0].toFixed(3)} B/R ${tintRatio[1].toFixed(3)}, want `
      + `${MESA_SUN_TINT[1]}/${MESA_SUN_TINT[2]}; linearised would be ~0.140/0.013)`);

  // Authored/custom props are ordinary Mesh draws and intentionally own neither a color attribute nor an
  // instanceColor. This is the exact shader variant that failed when the native branch mentioned vColor.
  const customGeometry = new THREE.BoxGeometry(1, 1, 1);
  const custom = new THREE.Mesh(customGeometry, textures.neutral);
  scene.add(custom);
  renderer.render(scene, camera);
  const customPixel = centrePixel(renderer);
  scene.remove(custom);

  // Retail props encode the native lighting-table index in Three's instance-color channel and keep their
  // extracted model-local normals in ps2StoredNormal. Exercise that separately so guarding the custom path
  // cannot silently disable the exact native lookup.
  const nativeGeometry = new THREE.BoxGeometry(1, 1, 1);
  nativeGeometry.setAttribute('ps2StoredNormal', nativeGeometry.getAttribute('normal').clone());
  const native = new THREE.InstancedMesh(nativeGeometry, textures.native(textures.neutral), 1);
  native.setMatrixAt(0, new THREE.Matrix4());
  native.setColorAt(0, propLightIndexColor(0));
  native.instanceMatrix.needsUpdate = true;
  native.instanceColor!.needsUpdate = true;
  scene.add(native);
  renderer.render(scene, camera);
  const nativePixel = centrePixel(renderer);

  scene.remove(native);

  // Static reference scenery uses BatchedMesh when WEBGL_multi_draw is present. Three r185 moved batching
  // colours from USE_COLOR to USE_COLOR_ALPHA; the RGB still carries our native light-table index. Keep
  // record zero deliberately dark and ask this batch for bright record one so a lost index is visible.
  const batchedGeometry = new THREE.PlaneGeometry(1, 1);
  batchedGeometry.setAttribute('ps2StoredNormal', batchedGeometry.getAttribute('normal').clone());
  const batched = new THREE.BatchedMesh(1,
    batchedGeometry.getAttribute('position').count, batchedGeometry.getIndex()!.count, textures.native(textures.neutral));
  const batchedGeometryId = batched.addGeometry(batchedGeometry);
  const batchedInstanceId = batched.addInstance(batchedGeometryId);
  batched.setMatrixAt(batchedInstanceId, new THREE.Matrix4());
  batched.setColorAt(batchedInstanceId, propLightIndexColor(1));
  scene.add(batched);
  renderer.render(scene, camera);
  const batchedNativePixel = centrePixel(renderer);
  scene.remove(batched);
  if (batchedNativePixel[0] < nativePixel[0] + 80)
    throw new Error(`Batched native prop sampled the wrong light record: instanced record 0 ${nativePixel}, `
      + `batched record 1 ${batchedNativePixel}`);

  // Runtime frame selection happens AFTER every intact pane has already uploaded the same loader Source.
  // Exercise that exact WebGL-cache boundary: cracking A must allocate a new map/source/GPU texture and B must
  // continue sampling the already-uploaded intact allocation. Object/source identity assertions cannot catch a
  // stale `__webglTexture` association inside Three's renderer; only the pixels can.
  (textures as unknown as { loader: { load(url: string): THREE.Texture } }).loader = {
    load(url: string) {
      const cracked = url.includes('cracked');
      const tile = document.createElement('canvas');
      tile.width = tile.height = 1;
      const context = tile.getContext('2d')!;
      context.fillStyle = cracked ? '#00ff00' : '#ff0000';
      context.fillRect(0, 0, 1, 1);
      return new THREE.CanvasTexture(tile);
    },
  };
  const flipEffect = { textureFlip: { direction: 0, speed: 0, length: 0, dwell: false } };
  const flipA = textures.native(textures.material('WEBGL', 'intact.png', flipEffect,
    ['intact.png', 'cracked.png'], 'pane:a'));
  const flipB = textures.native(textures.material('WEBGL', 'intact.png', flipEffect,
    ['intact.png', 'cracked.png'], 'pane:b'));
  const flipGeometry = new THREE.PlaneGeometry(1, 1);
  flipGeometry.setAttribute('ps2StoredNormal', flipGeometry.getAttribute('normal').clone());
  const drawFlip = (material: THREE.Material, sourceIndex: number): number[] => {
    const mesh = new THREE.InstancedMesh(flipGeometry, material, 1);
    mesh.setMatrixAt(0, new THREE.Matrix4());
    mesh.setColorAt(0, propLightIndexColor(sourceIndex));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    scene.add(mesh);
    renderer.render(scene, camera);
    const pixel = centrePixel(renderer);
    scene.remove(mesh);
    return pixel;
  };
  const flipIntactPixel = drawFlip(flipA, 0);
  if (!textures.controlMaterial(flipA, 'texture-flip', 2, 1))
    throw new Error('Runtime texture frame control did not reach pane A');
  const flipCrackedPixel = drawFlip(flipA, 0);
  const flipOtherPixel = drawFlip(flipB, 1);
  if (flipIntactPixel[0] < flipIntactPixel[1] + 80)
    throw new Error(`Intact controlled pane did not render red: ${flipIntactPixel}`);
  if (flipCrackedPixel[1] < flipCrackedPixel[0] + 80)
    throw new Error(`Addressed controlled pane did not render cracked green: ${flipCrackedPixel}`);
  if (flipOtherPixel[0] < flipOtherPixel[1] + 80)
    throw new Error(`Cracking pane A leaked onto pane B's uploaded GPU texture: ${flipOtherPixel}`);

  // The Effects inspector's ▶ Preview effect on a UV scroll. The scroll is a render-layer clock rather than a
  // scheduled action, so Preview runs it by ungating this material while the top-bar Effects filter stays off
  // — and Stop puts it back. Building one of these materials needs a real document, so this is the only place
  // the path can be exercised end to end.
  const scrollEffect = { uvScroll: {
    mode: 0, uPerTick: 0.01, vPerTick: 0, activeDuration: 1, pauseDuration: 0, lifetime: 0,
  } };
  const scroller = textures.material('WEBGL', 'intact.png', scrollEffect);
  const scrollOffset = () => (scroller.map as THREE.Texture).offset.x;
  textures.stepWorldEffects(1 / 60);
  if (scrollOffset() !== 0) throw new Error(`A UV scroll moved with the Effects filter off: ${scrollOffset()}`);
  if (!textures.previewMaterialEffect(scroller))
    throw new Error('Preview did not reach the scrolling material');
  textures.stepWorldEffects(1 / 60);
  if (Math.abs(scrollOffset() - 0.01) > 1e-6)
    throw new Error(`Preview did not run the authored scroll rate: ${scrollOffset()}`);
  if (!textures.clearMaterialEffectPreviews()) throw new Error('Stopping the preview reported nothing running');
  textures.stepWorldEffects(1 / 60);
  if (scrollOffset() !== 0) throw new Error(`Stopping the preview left the scroll running: ${scrollOffset()}`);

  // Merqury City's strike sign: a phase-only UV receiver (both rates zero) whose whole visible effect is the
  // phase a Set-UV-phase command writes. Preview may run that command because claiming the material is what
  // lets Stop put it back — so the pair is asserted together, write then rest.
  const phaseEffect = { uvScroll: {
    mode: 0, uPerTick: 0, vPerTick: 0, activeDuration: 1, pauseDuration: 0, lifetime: 0,
  } };
  const phaseReceiver = textures.material('WEBGL', 'intact.png', phaseEffect, [], 'sign:strike');
  if (!textures.previewMaterialEffect(phaseReceiver))
    throw new Error('Preview did not claim the phase-only UV receiver');
  if (!textures.controlMaterial(phaseReceiver, 'uv-scroll', 6, 0.25))
    throw new Error('Set UV phase did not reach its receiver');
  const phaseOffset = () => (phaseReceiver.map as THREE.Texture).offset.y;
  if (Math.abs(phaseOffset() - 0.75) > 1e-6)
    throw new Error(`Set UV phase wrote the wrong V phase: ${phaseOffset()}`);
  textures.stepWorldEffects(1 / 60);
  if (Math.abs(phaseOffset() - 0.75) > 1e-6)
    throw new Error(`A zero-rate receiver drifted off its written phase: ${phaseOffset()}`);
  textures.clearMaterialEffectPreviews();
  if (phaseOffset() !== 0) throw new Error(`Stopping the preview kept the written phase: ${phaseOffset()}`);
  // And with the Effects filter ON, which is the state an author watching world motion is actually in. The
  // filter animates a material from rest; it never writes a phase, so Stop still owes the material a reset.
  textures.setWorldEffectsEnabled(true);
  textures.previewMaterialEffect(phaseReceiver);
  textures.controlMaterial(phaseReceiver, 'uv-scroll', 6, 0.25);
  textures.clearMaterialEffectPreviews();
  if (phaseOffset() !== 0)
    throw new Error(`Stop left the written phase behind while the Effects filter was on: ${phaseOffset()}`);
  textures.setWorldEffectsEnabled(false);

  // The same preview on an AMBIENT flipbook, drawn the way a retail placement actually is: through a
  // native-lit variant of the shared cache entry (Merqury City's road-barrier lights). The variant shares the
  // cached material's Texture OBJECT, while a frame change forks a private one and rebinds the cached
  // material — so this asserts what the drawn variant samples, which object identity cannot.
  const barrierEffect = { textureFlip: { direction: 0, speed: 3.5, length: 0, dwell: false } };
  const barrier = textures.material('WEBGL', 'intact.png', barrierEffect, ['intact.png', 'cracked.png']);
  const barrierNative = textures.native(barrier);
  const barrierRestPixel = drawFlip(barrierNative, 1);
  if (!textures.previewMaterialEffect(barrier))
    throw new Error('Preview did not reach the free-running flipbook');
  for (let i = 0; i < 5; i++) textures.stepWorldEffects(0.1); // 3.5 fps: half a second is well past frame 1
  const barrierFlipPixel = drawFlip(barrierNative, 1);
  if (barrierRestPixel[0] < barrierRestPixel[1] + 80)
    throw new Error(`Native-lit flipbook did not rest on frame zero: ${barrierRestPixel}`);
  if (barrierFlipPixel[1] < barrierFlipPixel[0] + 80)
    throw new Error(`Preview did not advance the native-lit flipbook's drawn frame: ${barrierFlipPixel}`);
  textures.clearMaterialEffectPreviews();

  // The Surface view's clay tints by how little of the authored sun's key a face receives — a claim about
  // the STORED normal carried through the real prop transform (worldRoot's Z mirror times RAW_TO_EDITOR's),
  // and about that reading not moving with the camera. Reasoning either out is how this gets shipped
  // backwards, so render the real composition and read the pixels. The sheet is a raw-space plane whose
  // stored normal is raw +Z, which lands as world +Y.
  const worldRoot = new THREE.Group();
  worldRoot.scale.z = -1;
  const rawRoot = new THREE.Group();
  rawRoot.matrixAutoUpdate = false;
  rawRoot.matrix.copy(RAW_TO_EDITOR);
  worldRoot.add(rawRoot);
  scene.add(worldRoot);
  const sheetGeometry = new THREE.PlaneGeometry(200, 200); // raw cm -> 2 m in the editor
  const sheet = new THREE.Mesh(sheetGeometry, textures.neutral);
  rawRoot.add(sheet);
  applyPropShade(worldRoot, 'surface');

  const sideCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
  const readSide = (height: number): number[] => {
    sideCamera.position.set(0, height, 0.35);
    sideCamera.lookAt(0, 0, 0);
    renderer.render(scene, sideCamera);
    return centrePixel(renderer);
  };
  // Magenta reads as green sitting far below both other channels; neutral clay keeps the three together.
  const spread = (pixel: number[]) => Math.min(pixel[0], pixel[2]) - pixel[1];
  const grey = (pixel: number[]) => Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3));

  // The sheet's stored normal is raw +Z, which lands as world +Y. A sun from straight overhead therefore
  // lights it square on and it must not tint — from EITHER side, because object light is baked once and
  // shown from both faces. Camera-independence is the claim that separates this reading from the winding
  // one, so it is asserted rather than reasoned about.
  setPropShadeSun([0, 1, 0]);
  const clayLitPixel = readSide(3);
  const clayLitBehindPixel = readSide(-3);
  if (spread(clayLitPixel) > 16)
    throw new Error(`Surface clay tinted a prop facing the sun: ${clayLitPixel}`);
  if (Math.max(...clayLitPixel.map((v, i) => Math.abs(v - clayLitBehindPixel[i]))) > 4)
    throw new Error(`Surface clay moved with the camera: front ${clayLitPixel} vs behind ${clayLitBehindPixel}`);

  // Turn the sun under the sheet and the SAME faces must go magenta, again from both sides.
  setPropShadeSun([0, -1, 0]);
  const clayDarkPixel = readSide(3);
  const clayDarkBehindPixel = readSide(-3);
  if (spread(clayDarkPixel) < 48)
    throw new Error(`Surface clay left a prop turned off the sun untinted: ${clayDarkPixel}`);
  if (Math.max(...clayDarkPixel.map((v, i) => Math.abs(v - clayDarkBehindPixel[i]))) > 4)
    throw new Error(`Surface clay moved with the camera: front ${clayDarkPixel} vs behind ${clayDarkBehindPixel}`);

  // With no authored sun there is no shipping-brightness fact, so nothing tints whichever way it faces.
  setPropShadeSun(null);
  const clayNoSunPixel = readSide(-3);
  if (spread(clayNoSunPixel) > 16)
    throw new Error(`Surface clay tinted with no authored sun: ${clayNoSunPixel}`);
  // A placement's contact class colours its clay: the builder stamps one tint on the pose group and every
  // submesh under it follows. Re-applying has to re-derive from the STASHED original, not from the clay it
  // already swapped in, or the second tint would compound onto the first. Read it lit, so the contact
  // colour is the only thing in the pixel.
  setPropShadeSun([0, 1, 0]);
  rawRoot.userData[PROP_SHADE_TINT] = PROP_THROUGH_COLOR;
  applyPropShade(worldRoot, 'surface');
  const clayContactPixel = readSide(3);
  if (clayContactPixel[1] - clayContactPixel[0] < 60 || clayContactPixel[2] - clayContactPixel[0] < 60)
    throw new Error(`Contact-class tint did not reach the prop's Surface clay: ${clayContactPixel}`);
  delete rawRoot.userData[PROP_SHADE_TINT];
  rawRoot.remove(sheet);
  setPropShadeSun([0, -1, 0]);   // sun back under the plane for the retail composition below

  // The RETAIL path is a different composition and gets both facts wrong on its own: a reference prop is an
  // InstancedMesh whose per-instance matrix carries RAW_TO_EDITOR, and it stores its native light-table index
  // in `instanceColor`. Neither is visible to the object-level reasoning above — Three reads only
  // `object.matrixWorld` for `frontFace`, and `color_fragment` would multiply that index in as if it were a
  // tint. Reproduce it exactly rather than trusting that the plain-Mesh case generalises.
  const instancedGeometry = new THREE.PlaneGeometry(200, 200);
  const instanced = new THREE.InstancedMesh(instancedGeometry, textures.neutral, 1);
  instanced.setMatrixAt(0, RAW_TO_EDITOR.clone());  // reference-decor: edit = RAW_TO_EDITOR x instance pose
  instanced.setColorAt(0, propLightIndexColor(9));  // the packed index, NOT a colour
  instanced.instanceMatrix.needsUpdate = true;
  instanced.instanceColor!.needsUpdate = true;
  worldRoot.add(instanced);                         // the mirror is in the INSTANCE matrix, not this object's
  applyPropShade(worldRoot, 'surface');
  const clayInstancedFrontPixel = readSide(3);
  const clayInstancedBackPixel = readSide(-3);
  // Same two claims on the retail composition. The sun is still under the sheet, so both reads must be
  // magenta and equal; the index must not have leaked in as a tint on top of it.
  if (spread(clayInstancedFrontPixel) < 48)
    throw new Error(`Surface clay left a retail prop turned off the sun untinted: ${clayInstancedFrontPixel}`);
  if (Math.max(...clayInstancedFrontPixel.map((v, i) => Math.abs(v - clayInstancedBackPixel[i]))) > 4)
    throw new Error(`Retail Surface clay moved with the camera: ${clayInstancedFrontPixel} vs ${clayInstancedBackPixel}`);
  setPropShadeSun([0, 1, 0]);
  const clayInstancedLitPixel = readSide(3);
  setPropShadeSun([0, -1, 0]);
  if (grey(clayInstancedLitPixel) > 24)
    throw new Error(`Native light-table index leaked into the Surface clay as a tint: ${clayInstancedLitPixel}`);

  // WebGLProgram.diagnostics is intentionally internal in Three's declarations, but it is the authoritative
  // link-status record populated when renderer.debug.checkShaderErrors is enabled (r170 WebGLProgram.js).
  const programs = (renderer.info.programs ?? []) as unknown as {
    diagnostics?: { runnable: boolean; programLog: string };
  }[];
  const failed = programs.find(program => program.diagnostics?.runnable === false);
  if (failed) throw new Error(`Three retained a non-runnable WebGL program: ${failed.diagnostics?.programLog}`);
  if (programs.length < 2) throw new Error(`Expected distinct custom/native programs; Three compiled ${programs.length}`);
  if (Math.max(...customPixel.slice(0, 3)) < 16) throw new Error(`Custom prop rendered black: ${customPixel}`);
  if (Math.max(...nativePixel.slice(0, 3)) < 16) throw new Error(`Native prop rendered black: ${nativePixel}`);

  const gl = renderer.getContext();
  publish({
    ok: true,
    programs: programs.length,
    customPixel,
    nativePixel,
    batchedNativePixel,
    clayLitPixel,
    clayDarkPixel,
    clayNoSunPixel,
    clayInstancedFrontPixel,
    clayInstancedBackPixel,
    clayContactPixel,
    sunTintPixel,
    flipIntactPixel,
    flipCrackedPixel,
    flipOtherPixel,
    partialAlphaPixel,
    cutoutCoverage,
    lollipopAtlasPixel,
    renderer: gl.getParameter(gl.RENDERER),
  });
  customGeometry.dispose();
  nativeGeometry.dispose();
  batchedGeometry.dispose();
  batched.dispose();
  sheetGeometry.dispose();
  instancedGeometry.dispose();
  flipGeometry.dispose();
  cutoutMesh.geometry.dispose();
  cutoutMaterial.dispose();
  cutoutTexture.dispose();
  partialMesh.geometry.dispose();
  lollipopGeometry.dispose();
  lollipopAtlas.dispose();
  renderer.dispose();
}

run().catch(error => publish({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }));
