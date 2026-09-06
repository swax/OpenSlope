import * as THREE from 'three';

const WIDTH = 56;
const HEIGHT = 32;
type Rgb = readonly [number, number, number];

/**
 * A tiny procedural SMPTE-style colour-bar card. It is deliberately a DataTexture rather than an image asset:
 * the inspection face works in the browser, tests and offline builds without another file/request, and nearest
 * filtering keeps every bar edge crisp enough to reveal the exact boundary of a measured screen.
 */
export function createScreenTestPatternTexture(): THREE.DataTexture {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  const top: readonly Rgb[] = [
    [191, 191, 191], [191, 191, 0], [0, 191, 191], [0, 191, 0],
    [191, 0, 191], [191, 0, 0], [0, 0, 191],
  ];
  const middle: readonly Rgb[] = [
    [0, 0, 191], [16, 16, 16], [191, 0, 191], [16, 16, 16],
    [0, 191, 191], [16, 16, 16], [191, 191, 191],
  ];
  const bottom: readonly Rgb[] = [
    [0, 33, 76], [255, 255, 255], [50, 0, 106], [16, 16, 16],
    [7, 7, 7], [16, 16, 16], [24, 24, 24],
  ];
  for (let y = 0; y < HEIGHT; y++) {
    const bars = y < 22 ? top : y < 26 ? middle : bottom;
    for (let x = 0; x < WIDTH; x++) {
      const color = bars[Math.min(bars.length - 1, Math.floor(x * bars.length / WIDTH))];
      // DataTexture's first row is sampled at UV y=0 (the BOTTOM of PlaneGeometry). The pattern is authored
      // top-to-bottom for readability, so store each logical row in the opposite physical row.
      const offset = ((HEIGHT - 1 - y) * WIDTH + x) * 4;
      data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'Screen coverage colour bars';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
