/**
 * Browser half of particle-blend-webgl.test.ts. It renders the editor's real particle batches through Three's
 * real WebGL blend state, because the whole question here is what the hardware does to the framebuffer — and
 * that is precisely what a source-string assertion cannot see. Snowdream's road flares went missing for
 * exactly this reason: the law read correctly everywhere except at the blend unit.
 *
 * Colour management is off and the output space is linear so the readback is plain blend arithmetic. The blend
 * factors under test are unaffected by either.
 */
import * as THREE from 'three';
import { createParticleBatches } from '../src/app/viewport/scene/particle-batches';
import { createParticleAtlasTexture } from '../src/app/viewport/scene/particle-atlas';
import { createXrContext } from '../src/app/viewport/xr-context';
import { checkParticleBillboards } from './particle-billboard-webgl.fixture';
import {
  emitterBlendKeepsColor, emitterBlendMode, type EmitterBlendMode,
} from '../src/core/effects/emitter-preview';

interface ParticleBlendResult {
  ok: boolean;
  error?: string;
  renderer?: string;
  legacyAtlasCleared?: boolean;
  backgroundPixel?: number[];
  additivePixel?: number[];
  darkenPixel?: number[];
  alphaPixel?: number[];
  darkenDrawnAdditivePixel?: number[];
  flareBlend?: string;
}

const publish = (result: ParticleBlendResult) => {
  (globalThis as typeof globalThis & { __particleBlend?: ParticleBlendResult }).__particleBlend = result;
  document.documentElement.dataset.particleBlend = result.ok ? 'passed' : 'failed';
};

const SIZE = 64;

interface Sprite { rgb: [number, number, number]; alpha: number; blend: EmitterBlendMode; sprite?: number }

async function run(): Promise<void> {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  THREE.ColorManagement.enabled = false;
  const context = canvas.getContext('webgl2', {
    antialias: false, preserveDrawingBuffer: true, xrCompatible: true,
  })!;
  const xrContext = createXrContext(context); // use the same context-attribute wrapper as Stage
  const initiallyCompatible = context.getContextAttributes()?.xrCompatible === true;
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  // Mid grey, so a darkening particle has something to darken and an additive one something to lift.
  renderer.setClearColor(0x808080, 1);
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error([
      gl.getProgramInfoLog(program),
      `VERTEX: ${gl.getShaderInfoLog(vertex)}`,
      `FRAGMENT: ${gl.getShaderInfoLog(fragment)}`,
    ].filter(Boolean).join('\n'));
  };

  // A fully opaque white sheet: the sprite contributes nothing of its own, so every pixel read below
  // is the blend of the particle's packed colour and alpha against the background.
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = atlasCanvas.height = 16;
  const atlasContext = atlasCanvas.getContext('2d', { willReadFrequently: true })!;
  atlasContext.fillStyle = 'white';
  atlasContext.fillRect(0, 0, 16, 16);
  const { texture: atlas, update: updateAtlas } = createParticleAtlasTexture(atlasCanvas);
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  const batches = createParticleBatches(atlas, 2, 2, 8);
  const scene = new THREE.Scene();
  scene.add(batches.additiveMesh, batches.alphaMesh);
  // A one-metre billboard covers half the orthographic viewport; the centre sample is well inside it.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;

  /** Pack sprites the way the viewport's per-frame packer does, then draw one frame. */
  function draw(sprites: Sprite[]): number[] {
    const { position, color, alpha, size, sprite: spriteIndex } = batches.buffers;
    let cursor = 0;
    const write = (item: Sprite) => {
      const k = cursor * 3;
      position[k] = 0; position[k + 1] = 0; position[k + 2] = 0;
      const keepColor = emitterBlendKeepsColor(item.blend);
      color[k] = keepColor ? item.rgb[0] : 0;
      color[k + 1] = keepColor ? item.rgb[1] : 0;
      color[k + 2] = keepColor ? item.rgb[2] : 0;
      alpha[cursor] = item.alpha;
      size[cursor] = 1;
      spriteIndex[cursor] = item.sprite ?? 0;
      cursor++;
    };
    for (const item of sprites) if (item.blend === 'additive') write(item);
    const additiveCount = cursor;
    for (const item of sprites) if (item.blend !== 'additive') write(item);
    batches.setDrawRanges(additiveCount, cursor - additiveCount);
    renderer.render(scene, camera);
    const pixel = new Uint8Array(4);
    const gl = renderer.getContext();
    gl.readPixels(SIZE / 2, SIZE / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return [...pixel];
  }

  const backgroundPixel = draw([]);
  // Authored selector 0. Additive: src*srcAlpha + dst, so a white quarter-alpha spark lifts the frame.
  const additivePixel = draw([{ rgb: [1, 1, 1], alpha: 0.25, blend: emitterBlendMode(0) }]);
  // Authored selector 4 — the flare plume. Black at half alpha over mid grey must land at half the background.
  const darkenPixel = draw([{ rgb: [0.9, 0.9, 0.9], alpha: 0.5, blend: emitterBlendMode(4) }]);
  // Authored selector 1. Alpha blend keeps its colour and replaces rather than adds.
  const alphaPixel = draw([{ rgb: [1, 0, 0], alpha: 1, blend: emitterBlendMode(1) }]);
  // The regression itself: the same black plume particle forced down the additive path. Black added to the
  // frame changes nothing, which is exactly what a Snowdream flare looked like before the batches were split.
  const darkenDrawnAdditivePixel = draw([{ rgb: [0, 0, 0], alpha: 0.5, blend: 'additive' }]);

  const failures: string[] = [];
  const near = (actual: number, expected: number, tolerance = 2) => Math.abs(actual - expected) <= tolerance;
  if (!near(backgroundPixel[0], 128)) failures.push(`background ${backgroundPixel.join('/')} is not mid grey`);
  if (!near(additivePixel[0], 192)) failures.push(`additive spark ${additivePixel.join('/')} did not lift the frame`);
  if (!near(darkenPixel[0], 64) || !near(darkenPixel[1], 64) || !near(darkenPixel[2], 64))
    failures.push(`darkening plume ${darkenPixel.join('/')} did not halve the background`);
  if (!near(alphaPixel[0], 255) || !near(alphaPixel[1], 0) || !near(alphaPixel[2], 0))
    failures.push(`alpha layer ${alphaPixel.join('/')} did not replace the background with its own colour`);
  if (!near(darkenDrawnAdditivePixel[0], 128))
    failures.push(`additive control ${darkenDrawnAdditivePixel.join('/')} was expected to be invisible`);
  if (emitterBlendMode(4) !== 'darken') failures.push('selector 4 no longer resolves to the darkening law');

  // XR adapter negotiation can lose/restore this context after desktop has uploaded its atlas and buffers.
  // Keep those SAME resources alive, as the app does, and check their first frame after restoration.
  const loseContext = renderer.getContext().getExtension('WEBGL_lose_context');
  if (!loseContext) throw new Error('WEBGL_lose_context is required for particle restoration coverage');
  let compatibilityCalls = 0;
  Object.defineProperty(context, 'makeXRCompatible', { configurable: true, value: async () => {
    if (++compatibilityCalls !== 1) return;
    canvas.addEventListener('webglcontextlost', () => {
      if (!xrContext.preparing) throw new Error('viewport gate released before context loss');
      setTimeout(() => loseContext.restoreContext(), 0);
    }, { once: true });
    loseContext.loseContext();
    throw new DOMException('adapter transition lost the context', 'InvalidStateError');
  } });
  await xrContext.prepare();
  Reflect.deleteProperty(context, 'makeXRCompatible');
  if (compatibilityCalls !== (initiallyCompatible ? 0 : 2) || xrContext.preparing)
    failures.push('XR compatibility did not preserve initial readiness or recover after restoration');
  renderer.setClearColor(0x808080, 1);
  const restoredPixel = draw([{ rgb: [1, 1, 1], alpha: 0.25, blend: 'additive' }]);
  if (!restoredPixel.every((value, index) => near(value, additivePixel[index])))
    failures.push(`restored particle ${restoredPixel.join('/')} differs from before context loss ${additivePixel.join('/')}`);
  const compatibilityError = context.getError();
  if (compatibilityError !== context.NO_ERROR) failures.push(`WebGL error after compatibility recovery: ${compatibilityError}`);

  // Full GPU-process reset also loses accelerated Canvas2D contents, unlike WEBGL_lose_context above.
  // An old CanvasTexture is the control: its white sprite becomes transparent, while retained atlas data stays.
  const gpuTest = (globalThis as typeof globalThis & { chrome?: { gpuBenchmarking?: {
    crashGpuProcess(): void; isAcceleratedCanvasImageSource(canvas: HTMLCanvasElement): boolean;
  } } }).chrome?.gpuBenchmarking;
  if (!gpuTest) throw new Error('GPU reset coverage requires --enable-gpu-benchmarking');
  const legacyCanvas = document.createElement('canvas');
  legacyCanvas.width = 1024; legacyCanvas.height = 1280;
  const legacyContext = legacyCanvas.getContext('2d')!;
  legacyContext.fillStyle = 'white'; legacyContext.fillRect(0, 0, 1024, 1280);
  const accelerated = gpuTest.isAcceleratedCanvasImageSource(legacyCanvas);
  const legacyTexture = new THREE.CanvasTexture(legacyCanvas);
  const sampleSpark = () => draw([{ rgb: [1, 1, 1], alpha: 0.25, blend: 'additive' }]);
  const atlasUniform = batches.additiveMesh.material.uniforms.particleAtlas;
  atlasUniform.value = legacyTexture;
  if (!near(sampleSpark()[0], 192)) failures.push('legacy canvas control was not visible before reset');
  atlasUniform.value = atlas;
  await new Promise<void>((resolve, reject) => {
    let glRestored = false, canvasRestored = !accelerated;
    const timer = setTimeout(() => reject(new Error('GPU-process reset did not restore contexts')), 10_000);
    const complete = () => { if (glRestored && canvasRestored) { clearTimeout(timer); resolve(); } };
    canvas.addEventListener('webglcontextrestored', () => { glRestored = true; complete(); }, { once: true });
    if (accelerated) legacyCanvas.addEventListener('contextrestored', () => { canvasRestored = true; complete(); }, { once: true });
    gpuTest.crashGpuProcess();
  });
  renderer.setClearColor(0x808080, 1);
  if (!near(sampleSpark()[0], 192)) failures.push('retained firework atlas disappeared after GPU-process reset');
  if (accelerated) {
    atlasUniform.value = legacyTexture;
    if (!near(sampleSpark()[0], 128)) failures.push('legacy CanvasTexture did not reproduce the blank-atlas failure');
    atlasUniform.value = atlas;
  }
  const resetError = context.getError();
  if (resetError !== context.NO_ERROR) failures.push(`WebGL error after GPU reset: ${resetError}`);
  atlasContext.fillStyle = 'blue'; atlasContext.fillRect(8, 8, 8, 8); updateAtlas(8, 8, 8, 8);
  const updated = draw([{ rgb: [1, 1, 1], alpha: 1, blend: 'alpha', sprite: 3 }]);
  const unchanged = draw([{ rgb: [1, 1, 1], alpha: 1, blend: 'alpha', sprite: 2 }]);
  if (!near(updated[0], 0) || !near(updated[2], 255) || !near(unchanged[0], 255))
    failures.push('a late sprite load did not update only its atlas cell after restoration');
  failures.push(...checkParticleBillboards(renderer));

  publish({
    ok: !failures.length,
    legacyAtlasCleared: accelerated,
    error: failures.join('; ') || undefined,
    renderer: renderer.getContext().getExtension('WEBGL_debug_renderer_info')
      ? renderer.getContext().getParameter(0x9246) as string
      : renderer.getContext().getParameter(renderer.getContext().RENDERER) as string,
    backgroundPixel, additivePixel, darkenPixel, alphaPixel, darkenDrawnAdditivePixel,
    flareBlend: emitterBlendMode(4),
  });
}

run().catch((error: unknown) => publish({
  ok: false,
  error: error instanceof Error ? (error.stack ?? error.message) : String(error),
}));
