// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CHARACTER_UV_SCROLL_KEY } from '../src/core/characters/contract';
import {
  registerCharacterGlow, resetCharacterGlow, stepCharacterGlow,
} from '../src/app/ride/character-glow';

/**
 * The runtime half of a character's animated emissive mask (docs/030).
 *
 * The model declares a rate in its glTF `extras` and this drives it. Everything worth pinning here is a
 * property that only misbehaves after a while or with more than one rider on screen — a scroll that runs at
 * double speed because two materials share a texture, or one that stutters an hour into a session because
 * the offset grew past the precision the pattern is drawn from.
 */

const scrolling = (rate: unknown, map: THREE.Texture | null = new THREE.Texture()) => {
  const material = new THREE.MeshStandardMaterial();
  material.emissiveMap = map;
  material.userData = { [CHARACTER_UV_SCROLL_KEY]: rate };
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  return { material, mesh, map };
};

// A declared rate is honoured, on the axis it names and in the direction it names.
resetCharacterGlow();
{
  const { mesh, map } = scrolling([0, -0.5]);
  registerCharacterGlow(mesh);
  stepCharacterGlow(1);
  assert(Math.abs(map!.offset.y - 0.5) < 1e-9, `v scrolled to ${map!.offset.y}, expected 0.5 after wrapping`);
  assert.equal(map!.offset.x, 0, 'an unnamed axis does not move');
  // Only the moving axis is switched to repeat: forcing both would un-clamp an atlas that another material
  // samples by cell, and drag a neighbouring cell's light across the seam.
  assert.equal(map!.wrapT, THREE.RepeatWrapping);
  assert.notEqual(map!.wrapS, THREE.RepeatWrapping);
}

// The offset stays inside [0, 1) however long the session runs. Left to accumulate it reaches the shader as
// a float whose fractional part — the only part that matters — has lost its precision.
resetCharacterGlow();
{
  const { mesh, map } = scrolling([0, -0.55]);
  registerCharacterGlow(mesh);
  for (let frame = 0; frame < 60 * 60 * 2; frame++) stepCharacterGlow(1 / 60);
  assert(map!.offset.y >= 0 && map!.offset.y < 1, `two hours in, the offset is ${map!.offset.y}`);
}

/**
 * One step per texture, not per material or per rider. Rider models are cloned with shared materials, so a
 * field of AI riders is one Texture object seen many times; stepping it per instance would run the animation
 * at twenty times its authored speed and drift the riders out of phase with each other.
 */
resetCharacterGlow();
{
  const shared = new THREE.Texture();
  const first = scrolling([0, -0.25], shared);
  const second = scrolling([0, -0.25], shared);
  const root = new THREE.Group();
  root.add(first.mesh, second.mesh);
  registerCharacterGlow(root);
  registerCharacterGlow(root); // a second rider on the same template must not double it either
  stepCharacterGlow(1);
  assert(Math.abs(shared.offset.y - 0.75) < 1e-9,
    `a shared mask scrolled to ${shared.offset.y}; two materials must not step it twice`);
}

// Registering a model again keeps the phase it had, rather than snapping every rider back to the start when
// a second one spawns.
resetCharacterGlow();
{
  const { mesh, map } = scrolling([0, -0.25]);
  registerCharacterGlow(mesh);
  stepCharacterGlow(1);
  registerCharacterGlow(mesh);
  assert(Math.abs(map!.offset.y - 0.75) < 1e-9, 're-registering preserves the phase');
}

// Anything that is not a usable rate is ignored rather than turned into NaN offsets, because a character
// with a broken extras block should look static, not vanish.
for (const rate of [undefined, null, [0, 0], [1], 'fast', [Number.NaN, 1], [null, 2]]) {
  resetCharacterGlow();
  const { mesh, map } = scrolling(rate);
  registerCharacterGlow(mesh);
  stepCharacterGlow(1);
  assert.equal(map!.offset.y, 0, `rate ${JSON.stringify(rate)} must not scroll anything`);
  assert.notEqual(map!.wrapT, THREE.RepeatWrapping, `rate ${JSON.stringify(rate)} must not change wrapping`);
}

// A material that declares a rate but has no emissive map has nothing to scroll.
resetCharacterGlow();
{
  const { mesh } = scrolling([0, -0.5], null);
  registerCharacterGlow(mesh);
  stepCharacterGlow(1); // must not throw
}

// A paused or reversed frame must not run the animation backwards or spike it.
resetCharacterGlow();
{
  const { mesh, map } = scrolling([0, -0.5]);
  registerCharacterGlow(mesh);
  for (const dt of [0, -1, Number.NaN]) stepCharacterGlow(dt);
  assert.equal(map!.offset.y, 0, 'a zero, negative or non-finite frame time advances nothing');
}

resetCharacterGlow();
console.log('CHARACTER GLOW: PASS');
