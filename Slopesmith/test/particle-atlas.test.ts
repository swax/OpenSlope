// tier: fast

import assert from 'node:assert/strict';
import { createParticleAtlasTexture } from '../src/app/viewport/scene/particle-atlas';

// Some browsers provide Canvas2D pixel reads but no isContextLost method.
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], green = [0, 255, 0, 255];
const backing = new Uint8ClampedArray([...red, ...blue]);
let reads = 0, lost = false;
const context: {
  isContextLost?: () => boolean;
  getImageData: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray };
} = {
  getImageData(x, y, width, height) {
    assert.equal(y, 0);
    assert.equal(height, 1);
    reads++;
    return { data: backing.slice(x * 4, (x + width) * 4) };
  },
};
const canvas = { width: 2, height: 1, getContext: () => context } as unknown as HTMLCanvasElement;
const { texture, update } = createParticleAtlasTexture(canvas);
assert(texture.image.data instanceof Uint8Array);
assert.deepEqual(Array.from(texture.image.data), [...red, ...blue],
  'startup copies the sprites even when Canvas2D has no isContextLost method');
assert.equal(texture.version, 1, 'initial sprites are scheduled for upload');

backing.set(green, 4);
update(1, 0, 1, 1);
assert.deepEqual(Array.from(texture.image.data), [...red, ...green],
  'late sprite loads update their cell without the optional method');

context.isContextLost = function () {
  assert.equal(this, context, 'the native method must keep its context receiver');
  return lost;
};
lost = true;
backing.fill(0);
const versionBeforeLoss = texture.version, readsBeforeLoss = reads;
update();
assert.equal(reads, readsBeforeLoss, 'a lost context must not be read');
assert.equal(texture.version, versionBeforeLoss, 'context loss must not trigger an empty upload');
assert.deepEqual(Array.from(texture.image.data), [...red, ...green],
  'retained sprites survive the drawing canvas losing its backing store');

lost = false;
backing.set(blue, 4);
update(1, 0, 1, 1);
assert.deepEqual(Array.from(texture.image.data), [...red, ...blue],
  'updates resume after restoration without erasing other retained sprites');
assert.equal(texture.version, versionBeforeLoss + 1);
texture.dispose();

console.log('PARTICLE ATLAS: PASS (optional Canvas2D API, cell updates and context recovery)');
