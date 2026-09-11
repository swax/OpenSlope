import * as THREE from 'three';

/** Keep sprite pixels independently of the 2D canvas: an XR GPU reset can clear that canvas's backing store. */
export function createParticleAtlasTexture(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  const texture = new THREE.DataTexture(pixels, canvas.width, canvas.height, THREE.RGBAFormat);

  /** Copy only the changed cell. All other sprites survive even if the drawing canvas has been reset. */
  function update(x = 0, y = 0, width = canvas.width, height = canvas.height) {
    if (!context || context.isContextLost()) return;
    const source = context.getImageData(x, y, width, height).data;
    for (let row = 0; row < height; row++) {
      pixels.set(source.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * canvas.width + x) * 4);
    }
    texture.needsUpdate = true;
  }
  update();
  return { texture, update };
}
