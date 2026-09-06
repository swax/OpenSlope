/**
 * Browser half of snowfall-webgl.test.ts. The ambient-snowfall field (docs/050) is ENTIRELY a vertex shader,
 * so the CPU checks in `snowfall.test.ts` can pin its law and its wiring and still tell you nothing about
 * whether a single flake reaches the framebuffer. This renders the real layer through real WebGL and asks the
 * only two questions that live there: does the program compile, and do the flakes behave like weather?
 *
 * Colour management is off and the output space is linear, so a pixel read back is plain additive arithmetic.
 */
import * as THREE from 'three';
import { createSnowfallLayer } from '../src/app/viewport/scene/snowfall';
import { AMOUNT_MAX, AMOUNT_PORT, SNOWFALL_PORT, snowfallAt } from '../src/core/particles/snowfall';
import type { Stage } from '../src/app/viewport/stage';

interface SnowfallResult {
  ok: boolean;
  error?: string;
  renderer?: string;
  /** Total additive light in the frame at each stage, for the passing message. */
  idleLight?: number;
  ridingLight?: number;
  clearedLight?: number;
  farLight?: number[];
  parallaxDiff?: number;
  periodDiff?: number;
  /** Mean channel byte over the whole frame at each dial setting — how white the view actually goes. */
  brightnessByAmount?: { amount: number; mean: number }[];
}

const publish = (result: SnowfallResult) => {
  (globalThis as typeof globalThis & { __snowfall?: SnowfallResult }).__snowfall = result;
  document.documentElement.dataset.snowfall = result.ok ? 'passed' : 'failed';
};

/** Big enough that a flake at the far side of the box still covers whole pixels rather than slipping between
 *  their centres, which would make "no snow drew" and "the snow is too small to sample" the same reading. */
const SIZE = 512;

async function run(): Promise<void> {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 1);   // black, so every lit sample IS the flakes
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error([
      gl.getProgramInfoLog(program),
      `VERTEX: ${gl.getShaderInfoLog(vertex)}`,
      `FRAGMENT: ${gl.getShaderInfoLog(fragment)}`,
    ].filter(Boolean).join('\n'));
  };

  const scene = new THREE.Scene();
  const layer = createSnowfallLayer({ scene } as unknown as Stage);
  // The ride's own lens (docs/016): 78.15 deg vertical, 0.15 m near — the near plane a flake fades out well
  // in front of, and the framing the effect was tuned against.
  const camera = new THREE.PerspectiveCamera(78.15, 1, 0.15, 4000);

  const gl = renderer.getContext();
  /** Draw one frame from `eye`, advancing the field by `dt` first, and read the whole buffer back. */
  function draw(eye: THREE.Vector3, dt: number, active = true): Uint8Array {
    layer.sync(eye, dt, active);
    camera.position.copy(eye);
    camera.rotation.set(0, 0, 0);       // one fixed heading everywhere, so only the eye moves
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }
  /** Total additive light in a frame: robust where counting lit pixels is not, since one near flake covers
   *  hundreds of pixels and a far one barely covers its own. */
  const light = (pixels: Uint8Array): number => {
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    return sum;
  };
  const difference = (a: Uint8Array, b: Uint8Array): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return sum;
  };

  const origin = new THREE.Vector3(0, 0, 0);
  const failures: string[] = [];

  // Nothing at all over the editor view — and, since a ride's first frame resets the clock, this also seats
  // the run every later frame is measured from.
  const idleLight = light(draw(origin, 1 / 60, false));
  if (idleLight !== 0) failures.push(`the field drew ${idleLight} of light with no ride running`);

  // Riding: flakes reach the framebuffer.
  let ridingLight = 0;
  for (let i = 0; i < 30; i++) ridingLight = light(draw(origin, 1 / 60));
  if (ridingLight <= 0) failures.push('no snow drew during a ride');

  // ...and dialling the weather to clear takes them away again without ending the run.
  layer.setAmount(0);
  const clearedLight = light(draw(origin, 1 / 60));
  if (clearedLight !== 0) failures.push(`dialling the snow to zero left ${clearedLight} of light`);
  layer.setAmount(AMOUNT_PORT);

  // Nothing is ever left behind: a full-speed descent and a respawn teleport both find the box full. Every
  // frame from here is drawn at dt = 0, so they differ only in where the eye is.
  draw(origin, 1 / 60);
  const farEyes = [
    new THREE.Vector3(240, -1300, 900),        // a long way down a course
    new THREE.Vector3(-4000, 900, 12000),      // ...and off the end of a big reference level
    new THREE.Vector3(100000, -50000, 100000), // a teleport no course reaches, wrapped in one step
  ];
  const farLight = farEyes.map(eye => light(draw(eye, 0)));
  farLight.forEach((value, index) => {
    if (value <= 0) failures.push(`no snow around the eye at ${farEyes[index].toArray().join(',')}`);
  });

  // THE PARALLAX. Move the eye three metres with the heading unchanged. A field glued to the camera would
  // carry every flake along with it and hand back the IDENTICAL frame; a world-fixed one cannot, because the
  // flakes stayed where they were and the eye did not.
  const here = draw(origin, 0);
  const stepped = draw(new THREE.Vector3(3, 0, 0), 0);
  const parallaxDiff = difference(here, stepped);
  if (parallaxDiff < light(here) * 0.5) {
    failures.push(`moving the eye 3 m barely changed the frame (${parallaxDiff} against ${light(here)} of `
      + 'light) — the flakes are being towed along by the camera, not ridden through');
  }

  // THE RECYCLE. Move the eye by exactly one wrap box instead. The toroidal fold is periodic in the box, so
  // every flake lands in the same place relative to the eye and the frame must come back IDENTICAL — the
  // sharpest statement of the wrap law there is, and one only the GPU can answer.
  const box = SNOWFALL_PORT.box;
  const period = draw(new THREE.Vector3(box[0], box[1], box[2]), 0);
  const periodDiff = difference(here, period);
  if (periodDiff > light(here) * 0.02) {
    failures.push(`a whole-box move changed the frame (${periodDiff} against ${light(here)} of light) — `
      + 'the field is not periodic in its own wrap box');
  }

  // THE DIAL, measured rather than asserted. The mean channel byte over the whole frame is how white the view
  // has actually gone, against a black clear colour — the only honest answer to "is 10 a whiteout". The port
  // stop must stay a faint veil you ride through, the top of the dial must genuinely wash the view out, and
  // every step between them must be heavier than the last.
  const brightnessByAmount: { amount: number; mean: number }[] = [];
  for (let amount = 0; amount <= AMOUNT_MAX; amount++) {
    layer.setAmount(amount);
    const mean = light(draw(origin, 0)) / (SIZE * SIZE * 3);
    brightnessByAmount.push({ amount, mean });
  }
  const meanAt = (amount: number) => brightnessByAmount[amount].mean;
  if (meanAt(AMOUNT_PORT) > 8) {
    failures.push(`the port stop washes the view to ${meanAt(AMOUNT_PORT).toFixed(1)}/255 — that is not the `
      + 'faint additive grain the engine draws');
  }
  if (meanAt(AMOUNT_MAX) < 90) {
    failures.push(`the top of the dial only reaches ${meanAt(AMOUNT_MAX).toFixed(1)}/255 of white — `
      + `${snowfallAt(AMOUNT_MAX).flakes} flakes is not yet a whiteout`);
  }
  for (let amount = 1; amount <= AMOUNT_MAX; amount++) {
    if (meanAt(amount) <= meanAt(amount - 1)) {
      failures.push(`dialling ${amount - 1} -> ${amount} did not make it snow more `
        + `(${meanAt(amount - 1).toFixed(1)} -> ${meanAt(amount).toFixed(1)})`);
    }
  }

  publish({
    ok: !failures.length,
    error: failures.join('; ') || undefined,
    renderer: gl.getParameter(gl.RENDERER) as string,
    idleLight, ridingLight, clearedLight, farLight, parallaxDiff, periodDiff, brightnessByAmount,
  });
}

run().catch((error: unknown) => publish({
  ok: false,
  error: error instanceof Error ? (error.stack ?? error.message) : String(error),
}));
