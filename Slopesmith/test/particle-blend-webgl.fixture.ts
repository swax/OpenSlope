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
import {
  emitterBlendKeepsColor, emitterBlendMode, type EmitterBlendMode,
} from '../src/core/effects/emitter-preview';

interface ParticleBlendResult {
  ok: boolean;
  error?: string;
  renderer?: string;
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

interface Sprite { rgb: [number, number, number]; alpha: number; blend: EmitterBlendMode }

async function run(): Promise<void> {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
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

  // A one-cell, fully opaque white sheet: the sprite contributes nothing of its own, so every pixel read below
  // is the blend of the particle's packed colour and alpha against the background.
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  atlas.needsUpdate = true;
  const batches = createParticleBatches(atlas, 1, 1, 8);
  const scene = new THREE.Scene();
  scene.add(batches.additivePoints, batches.alphaPoints);
  // Orthographic, so the vertex shader's world-space sizing gives a point of halfViewportHeight pixels and the
  // centre sample is well inside it.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  batches.uniforms.halfViewportHeight.value = SIZE / 2;

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
      spriteIndex[cursor] = 0;
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

  publish({
    ok: !failures.length,
    error: failures.join('; ') || undefined,
    renderer: renderer.getContext().getParameter(renderer.getContext().RENDERER) as string,
    backgroundPixel, additivePixel, darkenPixel, alphaPixel, darkenDrawnAdditivePixel,
    flareBlend: emitterBlendMode(4),
  });
}

run().catch((error: unknown) => publish({
  ok: false,
  error: error instanceof Error ? (error.stack ?? error.message) : String(error),
}));
