import type { PlacedProp, Screen, V3 } from '../../core/doc/types';
import { nextScreenId } from '../../core/doc/ids';
import {
  DEFAULT_SCREEN_HEIGHT, DEFAULT_SCREEN_WIDTH, fitScreenToMeshes, screenAnglesFromNormal, screenFromFit,
  type ScreenFitMesh,
} from '../../core/props/screen';
import { unrotateByPlacement } from '../../core/props/pose';
import type { LevelProps } from '../../core/reference/props';

/**
 * Authoring operations for video SCREENS (docs/051) — the editor half of `core/props/screen.ts`.
 *
 * Two ways to make one, and they answer different questions. FIT one to a placement and the board decides:
 * the same texture-led recipe `snowknife billboards` runs over a whole course, applied to this model's own
 * geometry, so marking a billboard as a screen takes one click and lands on its ad face. Drop a FREE screen
 * and the author decides: a rectangle facing the camera, ready to be dragged onto whatever it belongs on.
 */

/** editorFromRaw's linear map: a model-local raw vertex (cm, Z up, X mirrored) into the prop's own frame. */
const RAW_TO_PROP = (x: number, y: number, z: number): [number, number, number] =>
  [-x / 100, z / 100, -y / 100];

/** A placement's model geometry in the prop's own frame — what a fit measures. Empty when the model's
 *  geometry has not been registered (a library still loading), which the caller reports rather than guesses. */
export function propFitMeshes(prop: PlacedProp, levels: Map<string, LevelProps>): ScreenFitMesh[] {
  const model = levels.get(prop.level)?.models.find(entry => entry.id === prop.model);
  if (!model?.subs?.length) return [];
  return model.subs.map(sub => {
    const positions = new Float32Array(sub.positions.length);
    for (let i = 0; i + 2 < sub.positions.length; i += 3) {
      const [x, y, z] = RAW_TO_PROP(sub.positions[i], sub.positions[i + 1], sub.positions[i + 2]);
      positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
    }
    return { positions, uvs: sub.uvs, indices: sub.indices };
  });
}

/** Fit a screen to a placement's board and hand back the record to push onto the document. Null when the
 *  model carries no face worth calling a screen (or its geometry has not loaded). `viewFrom` is world space —
 *  the camera — and only decides which side of a two-sided board is the front. */
export function screenForProp(prop: PlacedProp, levels: Map<string, LevelProps>,
                              screens: readonly Screen[], viewFrom?: V3): Screen | null {
  const meshes = propFitMeshes(prop, levels);
  if (!meshes.length) return null;
  // The fit works in the prop's own frame, so the viewpoint has to arrive there too — otherwise a turned
  // board would be judged against a direction that means nothing to it.
  const local = viewFrom ? propLocalPoint(viewFrom, prop) : undefined;
  const fit = fitScreenToMeshes(meshes, local);
  return fit ? screenFromFit(nextScreenId(screens), prop, fit) : null;
}

/** A world point in a placement's own frame (the inverse of how `screenPose` resolves one). */
function propLocalPoint(world: V3, prop: PlacedProp): V3 {
  const dx = world[0] - prop.pos[0], dy = world[1] - prop.pos[1], dz = world[2] - prop.pos[2];
  const scale = prop.scale || 1;
  // Inverse rotation then inverse scale; imported here rather than re-derived so the two stay one convention.
  const [x, y, z] = unrotateByPlacement([dx, dy, dz], prop);
  return [x / scale, y / scale, z / scale];
}

/** A free-standing screen at `pos`, turned to face `viewFrom` (the camera) with no tilt. */
export function freeScreen(screens: readonly Screen[], pos: V3, viewFrom: V3): Screen {
  const toViewer: V3 = [viewFrom[0] - pos[0], 0, viewFrom[2] - pos[2]];   // upright: a dropped screen stands
  const { yaw } = screenAnglesFromNormal(
    Math.hypot(toViewer[0], toViewer[2]) > 1e-6 ? toViewer : [0, 0, 1]);
  return {
    id: nextScreenId(screens),
    pos,
    yaw,
    width: DEFAULT_SCREEN_WIDTH,
    height: DEFAULT_SCREEN_HEIGHT,
  };
}

/** The screens attached to one placement, in document order. */
export const screensOfProp = (screens: readonly Screen[] | undefined, prop: PlacedProp): Screen[] =>
  (screens ?? []).filter(screen => screen.prop && screen.prop === prop.id);

/** Drop every screen a deleted placement was carrying: the board it named is gone, and a screen floating
 *  where one used to be is worse than no screen. Returns how many went. */
export function dropScreensForProp(doc: { screens?: Screen[] }, propId: string | undefined): number {
  if (!propId || !doc.screens?.length) return 0;
  const before = doc.screens.length;
  doc.screens = doc.screens.filter(screen => screen.prop !== propId);
  return before - doc.screens.length;
}
