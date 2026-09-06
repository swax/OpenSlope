import type { Mode } from '../viewport/types';
import type { GodRayCourse } from '../../core/lighting/god-rays';

export type SkyPreviewTarget = 'authored' | 'reference';
export type SkyPreviewLayer = 'none' | 'skybox' | 'god-rays';
export type SkyPreviewLayers = { skybox: boolean; godRays: boolean };

/**
 * Keep the current world until the other mountain is meaningfully nearer. Distances are measured by the
 * viewport against each mountain's world-space bounds; null means that world is not available. The dead band
 * prevents an orbit near the midpoint from swapping a full-screen backdrop on adjacent frames.
 */
export function nearestSkyWorld(
  authoredDistance: number | null,
  referenceDistance: number | null,
  current: SkyPreviewTarget,
  hysteresis: number,
): SkyPreviewTarget {
  if (authoredDistance === null) return referenceDistance === null ? 'authored' : 'reference';
  if (referenceDistance === null) return 'authored';
  if (current === 'authored') {
    return referenceDistance + hysteresis < authoredDistance ? 'reference' : 'authored';
  }
  return authoredDistance + hysteresis < referenceDistance ? 'authored' : 'reference';
}

/** Keep an explicit choice while it is usable; otherwise take the first sky in panel order. */
export function reconcileSkyPreviewTarget(
  current: SkyPreviewTarget | null,
  authoredHasSky: boolean,
  referenceHasSky: boolean,
): SkyPreviewTarget | null {
  if (current === 'authored' && authoredHasSky) return current;
  if (current === 'reference' && referenceHasSky) return current;
  if (authoredHasSky) return 'authored';
  if (referenceHasSky) return 'reference';
  return null;
}

/**
 * The world whose sky-adjacent presentation effects may be visible right now. Scene exposes the selected
 * Skybox preview only; a running Test ride follows its ride target. Every other editor state is flat.
 */
export function activeSkyWorld(
  mode: Mode,
  skyboxSelected: boolean,
  playTesting: boolean,
  playTarget: SkyPreviewTarget,
  previewTarget: SkyPreviewTarget | null,
  scenePreviewEnabled: boolean,
): SkyPreviewTarget | null {
  if (mode === 'info') return skyboxSelected && scenePreviewEnabled ? previewTarget : null;
  if (mode === 'play' && playTesting) return playTarget;
  return null;
}

/**
 * Resolve the global Skybox view. A running ride is locked to its selected course; the dedicated Scene
 * preview keeps its explicit comparison choice; every ordinary editor view follows the nearest mountain.
 */
export function activeSkyboxWorld(
  mode: Mode,
  skyboxSelected: boolean,
  playTesting: boolean,
  playTarget: SkyPreviewTarget,
  previewTarget: SkyPreviewTarget | null,
  nearestTarget: SkyPreviewTarget,
  enabled: boolean,
): SkyPreviewTarget | null {
  if (!enabled) return null;
  if (mode === 'play' && playTesting) return playTarget;
  if (mode === 'info' && skyboxSelected) return previewTarget;
  return nearestTarget;
}

/** Skybox and glare are independent toggles; None is the one-shot action that clears both. */
export function toggleSkyPreviewLayer(state: SkyPreviewLayers, layer: SkyPreviewLayer): SkyPreviewLayers {
  if (layer === 'none') return { skybox: false, godRays: false };
  if (layer === 'skybox') return { ...state, skybox: !state.skybox };
  return { ...state, godRays: !state.godRays };
}

/** Use the active world's own authored effect; never silently borrow glare from the other mountain. */
export function godRaysForSkyWorld(
  world: SkyPreviewTarget | null,
  authored: GodRayCourse | undefined,
  reference: GodRayCourse | null,
): GodRayCourse | null {
  const course = world === 'authored' ? authored : world === 'reference' ? reference : null;
  return course?.enabled ? course : null;
}
