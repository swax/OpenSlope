import * as THREE from 'three';
import { createParticleBatches } from '../src/app/viewport/scene/particle-batches';

/** Real framebuffer checks for the SSF renderer's atlas, packed ranges and per-eye billboard projection. */
export function checkParticleBillboards(renderer: THREE.WebGLRenderer): string[] {
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const texels = new Uint8Array(8 * 8 * 4);
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const corners = [[255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const tile = Math.floor(y / 4) * 2 + Math.floor(x / 4);
    const rgb = tile < 3 ? colours[tile] : corners[Math.floor((y % 4) / 2) * 2 + Math.floor((x % 4) / 2)];
    texels.set([...rgb, 255], (y * 8 + x) * 4);
  }
  const atlas = new THREE.DataTexture(texels, 8, 8);
  atlas.needsUpdate = true;
  const batches = createParticleBatches(atlas, 2, 2, 8);
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.add(batches.additiveMesh, batches.alphaMesh); scene.add(root);
  renderer.setClearColor(0, 1);
  renderer.setSize(256, 128, false);
  const gl = renderer.getContext();
  const target = Object.assign(new THREE.WebGLRenderTarget(256, 128, {
    samples: 4, colorSpace: THREE.LinearSRGBColorSpace,
  }), { isXRRenderTarget: true });
  target.texture.internalFormat = 'RGBA8';
  const eyes = [-0.032, 0.032].map((x, i) => {
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    camera.position.set(x, 0, 5); camera.updateMatrixWorld();
    return Object.assign(camera, { viewport: new THREE.Vector4(i * 128, 0, 128, 128) });
  });
  const stereo = new THREE.ArrayCamera(eyes as unknown as THREE.PerspectiveCamera[]);
  const draw = (camera: THREE.Camera, renderTarget: THREE.WebGLRenderTarget | null = target) => {
    // Pixel readback binds the resolve framebuffer; rebind the MSAA draw target before the next frame.
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);
  };
  const read = (x: number, y: number) => {
    const pixel = new Uint8Array(4);
    if (renderer.getRenderTarget()) renderer.readRenderTargetPixels(target, x, y, 1, 1, pixel);
    else gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return Array.from(pixel).slice(0, 3);
  };
  const near = (actual: number[], expected: number[]) => actual.every((v, i) => Math.abs(v - expected[i]) < 3);
  function write(index: number, x: number, sprite: number, size = 1) {
    batches.buffers.position.set([x, 0, 0], index * 3);
    batches.buffers.color.set([1, 1, 1], index * 3);
    batches.buffers.alpha[index] = 1;
    batches.buffers.size[index] = size;
    batches.buffers.sprite[index] = sprite;
  }
  function screen(camera: typeof eyes[number], x: number, y = 0) {
    const p = new THREE.Vector3(x, y, 0).project(camera);
    return [Math.floor(camera.viewport.x + (p.x + 1) * camera.viewport.z / 2),
      Math.floor(camera.viewport.y + (p.y + 1) * camera.viewport.w / 2)] as const;
  }

  try {
    // The second frame moves the alpha suffix: a stale offset would display the previous green sprite.
    write(0, -1, 0); write(1, 0, 1); write(2, 1, 2);
    batches.setDrawRanges(2, 1);
    draw(stereo);
    for (const eye of eyes) check(near(read(...screen(eye, 1)), colours[2]), 'alpha suffix reaches both eyes');
    write(0, -0.75, 0); write(1, 0.75, 3);
    batches.setDrawRanges(1, 1);
    for (const mirrored of [false, true]) {
      root.scale.z = mirrored ? -1 : 1;
      draw(stereo);
      check(renderer.info.render.calls === 4, 'two batches render once per eye, including mirrored parents');
      for (const eye of eyes) {
        check(near(read(...screen(eye, -0.75)), colours[0]), 'additive atlas selection survives stereo/mirroring');
        for (const [i, [dx, dy]] of [[-0.25, 0.25], [0.25, 0.25], [-0.25, -0.25], [0.25, -0.25]].entries()) {
          check(near(read(...screen(eye, 0.75 + dx, dy)), corners[i]),
            `atlas corner ${i} preserves point-sprite orientation in each eye`);
        }
      }
    }
    write(0, -0.75, 2); write(1, 0.75, 1);
    batches.setDrawRanges(0, 2); draw(stereo);
    for (const eye of eyes) check(near(read(...screen(eye, -0.75)), colours[2]), 'alpha-only packing starts at zero');
    batches.setDrawRanges(0, 0); draw(stereo);
    check(near(read(64, 64), [0, 0, 0]), 'empty counts clear the previous particle frame');

    // Projected world width follows depth in both eyes, using the same ArrayCamera route as WebXR.
    root.scale.z = 1; write(0, 0, 0);
    batches.setDrawRanges(1, 0);
    const perspectiveEyes = eyes.map(eye => {
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.copy(eye.position); camera.updateMatrixWorld();
      return Object.assign(camera, { viewport: eye.viewport.clone() });
    });
    const perspective = new THREE.ArrayCamera(perspectiveEyes);
    for (const distance of [5, 10]) {
      perspectiveEyes.forEach(eye => { eye.position.z = distance; eye.updateMatrixWorld(); });
      draw(perspective);
      for (const eye of perspectiveEyes) {
        const row = new Uint8Array(128 * 4);
        renderer.readRenderTargetPixels(target, eye.viewport.x, 64, 128, 1, row);
        let width = 0;
        for (let x = 0; x < 128; x++) if (row[x * 4] > 127) width++;
        const expected = eye.projectionMatrix.elements[5] * 64 / distance;
        check(Math.abs(width - expected) <= 2, `world width projects correctly at ${distance} metres (${width}/${expected})`);
      }
    }

    // An oversized sprite must extend beyond D3D's common 1024-pixel point-size ceiling.
    renderer.setRenderTarget(null); renderer.setSize(2048, 64, false);
    const wideCamera = new THREE.OrthographicCamera(-2, 2, 0.0625, -0.0625, 0.1, 100);
    wideCamera.position.z = 5;
    write(0, 0, 0, 3); batches.setDrawRanges(1, 0); draw(wideCamera, null);
    check(near(read(320, 32), colours[0]) && near(read(1728, 32), colours[0]),
      'a 1536-pixel world billboard is visible beyond the hardware point-size clamp');

    // Unequal eye viewports exercise the one-pixel minimum; framebuffer height is wrong for the shorter eye.
    renderer.setSize(256, 128, false);
    eyes[1].viewport.w = 64; eyes[1].left = -4; eyes[1].right = 4; eyes[1].updateProjectionMatrix();
    eyes.forEach(eye => {
      eye.position.x = 0; eye.updateMatrixWorld();
      // Put the tiny quad at pixel centres, avoiding edge-coverage ties in the triangle rasterizer.
      eye.projectionMatrix.elements[12] += 1 / eye.viewport.z;
      eye.projectionMatrix.elements[13] += 1 / eye.viewport.w;
    });
    write(0, 0, 0, 0.00001); batches.setDrawRanges(1, 0); draw(stereo, null);
    const pixels = new Uint8Array(256 * 128 * 4);
    gl.readPixels(0, 0, 256, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (const eye of eyes) {
      let lit = 0;
      for (let y = 0; y < eye.viewport.w; y++) for (let x = eye.viewport.x; x < eye.viewport.x + 128; x++) {
        if (pixels[(y * 256 + x) * 4] > 0) lit++;
      }
      check(lit === 1, `the ${eye.viewport.w}-pixel eye preserves its one-pixel minimum (got ${lit})`);
    }
    check(gl.getError() === gl.NO_ERROR, 'billboard checks produce no WebGL errors');
  } finally {
    renderer.setRenderTarget(null);
    target.dispose(); batches.dispose(); atlas.dispose();
  }
  return failures;
}
