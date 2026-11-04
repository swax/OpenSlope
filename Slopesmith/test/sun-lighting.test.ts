// tier: fast
import assert from 'node:assert/strict';
import { DEFAULT_SUN } from '../src/core/doc/types';
import { applyViewportSun } from '../src/app/viewport/sun-lighting';

type Target = Parameters<typeof applyViewportSun>[0];
const state: {
  visible: boolean;
  props: Parameters<Target['setPropLight']>[0];
  terrain: Parameters<Target['setTerrainLight']>[0];
} = { visible: false, props: null, terrain: null };
const viewport: Target = {
  setPlayLightingVisibility(on) {
    state.visible = on;
  },
  setPropLight(options) {
    state.props = options;
  },
  setTerrainLight(options) {
    state.terrain = options;
  },
};
applyViewportSun(viewport, DEFAULT_SUN);
assert(
  state.visible && state.props && state.terrain,
  'Public references enable the same native prop lighting as the editor',
);

const sun = {
  ...DEFAULT_SUN,
  el: 90,
  az: 0,
  ambient: 0.6,
  sun: 2.5,
  bakeExposure: 0.2,
  bakeAmbient: 0.1,
  sunTint: '#804020',
  skyTint: '#204080',
};
applyViewportSun(viewport, sun);
assert(state.props && state.terrain);
assert.equal(state.props.sun, 2.5, 'Props keep raw HDR sun intensity');
assert.equal(state.props.ambient, 0.6, 'Props keep raw ambient intensity');
assert.equal(state.terrain.sun, 0.5, 'Terrain applies bake exposure');
assert.equal(state.terrain.ambient, 0.1, 'Terrain applies its bake-only ambient');
assert.deepEqual(state.props.sunTint, [128 / 255, 64 / 255, 32 / 255]);
assert.deepEqual(state.props.skyTint, [32 / 255, 64 / 255, 128 / 255]);
assert(Math.abs(state.props.dir[0]) < 1e-10 && Math.abs(state.props.dir[2]) < 1e-10);
assert.equal(state.props.dir[1], 1, 'Both views point the sun in the same data-space direction');
assert.deepEqual(state.terrain.dir, state.props.dir);
assert.equal(state.terrain.shadow, sun.shadow);
assert.equal(state.terrain.ao, sun.ao);

applyViewportSun(viewport, { ...sun, on: false });
assert.equal(state.visible, false, 'A saved disabled lighting preview stays disabled');
assert.equal(state.props, null);
assert.equal(state.terrain, null);
applyViewportSun(viewport, sun);
assert(state.visible && state.props && state.terrain, 'Re-enabling restores both lighting paths');
assert.equal(sun.sun, 2.5, 'Preview setup cannot replace the saved raw intensity with bake exposure');
console.log('Shared editor/player sun: default lighting, saved HDR/bake settings and off/on restoration PASS');
