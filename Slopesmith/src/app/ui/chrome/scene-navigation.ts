/** The Scene toolbox's focused comparison categories. `info` is the Reference landing view. */
export type SceneSel = 'info' | 'lighting' | 'godrays' | 'sound' | 'skybox' | 'course';

export type SceneBoundsVisibility = {
  mountain: boolean;
  reference: boolean;
};

export type SceneFolderVisibility = {
  info: boolean;
  lighting: boolean;
  godrays: boolean;
  sound: boolean;
  skybox: boolean;
  course: boolean;
  selection: boolean;
};

/** One category owns exactly one Mountain / Reference folder pair; Course may add a selected-knot card. */
export function sceneFolderVisibility(selected: SceneSel, hasCourseSelection: boolean): SceneFolderVisibility {
  return {
    info: selected === 'info',
    lighting: selected === 'lighting',
    godrays: selected === 'godrays',
    sound: selected === 'sound',
    skybox: selected === 'skybox',
    course: selected === 'course',
    selection: selected === 'course' && hasCourseSelection,
  };
}

/** Both worlds are positionable on Scene's Reference landing view, so both get bounds there and nowhere else.
 *  Study panels (especially Skybox) need an unobstructed preview, and hidden Scene mode must not leak bounds
 *  into Edit / Sculpt / Paint / Props / Effects / Play. */
export function sceneBoundsVisibility(
  selected: SceneSel,
  sceneActive: boolean,
): SceneBoundsVisibility {
  const show = sceneActive && selected === 'info';
  return { mountain: show, reference: show };
}

/** Escape leaves Reference alone; every focused comparison returns to it. */
export const sceneBackTarget = (selected: SceneSel): SceneSel | null => selected === 'info' ? null : 'info';

/** A preview launched from Sound must not outlive the panel that owns its controls. `null` means Scene mode
 *  itself is being hidden; selecting Sound again is the only transition that keeps the preview alive. */
export const leavesSceneSound = (selected: SceneSel, next: SceneSel | null): boolean =>
  selected === 'sound' && next !== 'sound';
