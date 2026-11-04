import type { SunLight, V3 } from '../../core/doc/types';
import { effectiveBakeAmbient, effectiveBakeSun } from '../../core/lighting/bake';
import { sunDirFromElAz } from '../../core/lighting/lightmap';
import type { Viewport } from './viewport';

const hex2rgb = (hex: string): V3 => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export function terrainSunOptions(sun: SunLight) {
  return {
    dir: sunDirFromElAz(sun.el, sun.az),
    ambient: effectiveBakeAmbient(sun),
    sun: effectiveBakeSun(sun),
    shadow: sun.shadow,
    ao: sun.ao,
    sunTint: hex2rgb(sun.sunTint),
    skyTint: hex2rgb(sun.skyTint),
  };
}

/** Editor and public play use one lighting mode, including native prop records and vertex colours. */
export function applyViewportSun(
  viewport: Pick<Viewport, 'setPlayLightingVisibility' | 'setPropLight' | 'setTerrainLight'>,
  sun: SunLight,
): void {
  viewport.setPlayLightingVisibility(sun.on);
  if (!sun.on) {
    viewport.setTerrainLight(null);
    viewport.setPropLight(null);
    return;
  }
  const terrain = terrainSunOptions(sun);
  // Prop records retain the raw HDR pair; only terrain uses the bake exposure and ambient override.
  viewport.setPropLight({
    dir: terrain.dir,
    ambient: sun.ambient,
    sun: sun.sun,
    sunTint: terrain.sunTint,
    skyTint: terrain.skyTint,
  });
  // Install after props so their ground-light sampler refreshes against the current terrain bake.
  viewport.setTerrainLight(terrain);
}
