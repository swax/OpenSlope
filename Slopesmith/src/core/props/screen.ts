import type { PlacedProp, Screen, V3 } from '../doc/types';
import { rotateByPlacement, type PropRotation } from './pose';

/**
 * Video SCREENS: where one is in the world, and how one is fitted to a board (docs/051).
 *
 * A screen is a rectangle rather than geometry — the export writes it to `Billboards.json`, the contract
 * `snowknife billboards` measures off an extracted course, and a runtime with video lays its own quad over it.
 * Two things live here: resolving a stored screen into world space (an ATTACHED screen is stored in its prop's
 * own frame, so it rides the board through every move / turn / resize), and FITTING one to a placement's
 * geometry, which is the local half of the same recipe the detector runs over a whole course.
 */

/** A screen resolved into editor/data space: the rectangle a viewport draws and the export writes. */
export interface ScreenPose {
  /** Centre, editor metres. */
  center: V3;
  /** Unit normal out of the screen, toward the viewer. */
  normal: V3;
  /** Unit image-up, perpendicular to `normal`. */
  up: V3;
  /** Unit image-right (`up × normal`), so `center ± right·w/2 ± up·h/2` are the corners. */
  right: V3;
  width: number;
  height: number;
}

/** A default free-standing screen: 16:9 at a size that reads from the course without dwarfing a board. */
export const DEFAULT_SCREEN_WIDTH = 8;
export const DEFAULT_SCREEN_HEIGHT = 4.5;

/** The screen's own axes before its owner's rotation: facing +Z, up +Y — the frame `yaw` / `pitch` turn. */
const FACE: V3 = [0, 0, 1];
const UP: V3 = [0, 1, 0];

const cross = (a: V3, b: V3): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

function normalize(a: V3, fallback: V3): V3 {
  const n = length(a);
  return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : [...fallback] as V3;
}

/** The angles that turn the screen's own +Z onto `normal`. Roll is never authored: a screen's image-up is
 *  whatever the turn and tilt leave it, which is what keeps the panel level on an upright board. */
export function screenAnglesFromNormal(normal: V3): { yaw: number; pitch: number } {
  const n = normalize(normal, FACE);
  const R2D = 180 / Math.PI;
  return {
    yaw: ((Math.atan2(n[0], n[2]) * R2D) % 360 + 360) % 360,
    pitch: -Math.asin(Math.max(-1, Math.min(1, n[1]))) * R2D,
  };
}

/**
 * Where a screen actually is. An attached screen's stored pose is in its prop's frame, so the prop's own
 * rotation, uniform scale and position are applied on top; a free-standing one is already in world terms.
 * `prop` absent (a free screen, or an attached one whose board has gone) resolves the stored pose as world.
 */
export function screenPose(screen: Screen, prop?: PlacedProp): ScreenPose {
  const local: PropRotation = { yaw: screen.yaw, pitch: screen.pitch };
  let normal = rotateByPlacement(FACE, local);
  let up = rotateByPlacement(UP, local);
  let center = screen.pos;
  let width = screen.width;
  let height = screen.height;

  if (prop) {
    const propScale = prop.scale || 1;
    normal = rotateByPlacement(normal, prop);
    up = rotateByPlacement(up, prop);
    center = add(prop.pos, rotateByPlacement(scale(screen.pos, propScale), prop));
    width *= propScale;
    height *= propScale;
  }
  normal = normalize(normal, FACE);
  up = normalize(up, UP);
  return { center, normal, up, right: normalize(cross(up, normal), [1, 0, 0]), width, height };
}

/** A pose straight from an oriented rectangle — a reference course's measured screens arrive this way, with
 *  no owner to resolve against. `right` is derived so every consumer builds its quad the one way. */
export function screenPoseFromAxes(center: V3, normal: V3, up: V3, width: number, height: number): ScreenPose {
  const n = normalize(normal, FACE);
  const u = normalize(up, UP);
  return { center, normal: n, up: u, right: normalize(cross(u, n), [1, 0, 0]), width, height };
}

/** The placement a screen is attached to, or undefined for a free-standing one (or an orphan). */
export const screenProp = (screen: Screen, props: readonly PlacedProp[] | undefined): PlacedProp | undefined =>
  screen.prop ? props?.find(prop => prop.id === screen.prop) : undefined;

// ---- fitting a screen to a board -----------------------------------------------------------------------

/** One submesh of a placement's model, in the prop's own frame (editor metres, unscaled). */
export interface ScreenFitMesh {
  /** Vertex positions, xyz triples. */
  positions: ArrayLike<number>;
  /** Texture coordinates, uv pairs, index-matched to `positions`. Absent = the face carries no UVs. */
  uvs?: ArrayLike<number>;
  /** Triangle vertex indices. Absent = positions are already in triangle order. */
  indices?: ArrayLike<number>;
}

/** What a fit produced, before it becomes a stored screen. */
export interface ScreenFit {
  pos: V3;
  yaw: number;
  pitch: number;
  width: number;
  height: number;
}

/** A face this steep is a roof or the ground, not a screen. */
const MAX_TILT = 0.6;
/** A real ad shows its page ONCE. Below this span it is a flip-book cell or an atlas sliver; above it the
 *  page is tiled, which is how a structural face is textured. Same gate `snowknife billboards` applies. */
const UV_SPAN_MIN = 0.4;
const UV_SPAN_MAX = 1.2;
/** Below this (m²) a face is trim rather than a board. */
const MIN_AREA = 1;
/** Sit the screen this far off the face it covers, so it reads as a screen and never z-fights. */
export const SCREEN_PROUD = 0.1;

/**
 * Fit a screen to a placement's largest FLAT, NEAR-VERTICAL face — the board of a billboard, the face of a
 * wall — expressed in the prop's own frame so the result rides the prop.
 *
 * The preference order is the detector's, reduced to one model: a face whose UVs span a single showing of
 * their page is an ad image and wins outright; failing that the largest near-vertical face of any texturing
 * is taken, which is right for an authored panel with no ad convention at all. Null when the model has no
 * near-vertical face worth calling a screen.
 *
 * `viewFrom`, when given (the camera, or the course), decides which SIDE of the fitted face is the front:
 * a board is two-sided and its winding is an authoring coin-flip, so the side the author is looking from is
 * the one they mean.
 */
export function fitScreenToMeshes(meshes: readonly ScreenFitMesh[], viewFrom?: V3): ScreenFit | null {
  interface Group { area: number; normal: V3; center: V3; tris: number[][]; minU: number; maxU: number; minV: number; maxV: number }
  const groups = new Map<string, Group>();

  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
    const mesh = meshes[meshIndex];
    const p = mesh.positions;
    const uv = mesh.uvs;
    const count = mesh.indices ? mesh.indices.length : Math.floor(p.length / 3);
    for (let t = 0; t + 2 < count; t += 3) {
      const ia = mesh.indices ? mesh.indices[t] : t;
      const ib = mesh.indices ? mesh.indices[t + 1] : t + 1;
      const ic = mesh.indices ? mesh.indices[t + 2] : t + 2;
      const a: V3 = [p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2]];
      const b: V3 = [p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2]];
      const c: V3 = [p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2]];
      const n = cross(sub(b, a), sub(c, a));
      const area = length(n) / 2;
      if (!(area > 0)) continue;
      const unit = scale(n, 1 / (area * 2));
      if (Math.abs(unit[1]) > MAX_TILT) continue;   // a roof or the ground, not a screen

      // Bucket by SUBMESH and quantized facing — the same key the detector uses, and for the same reason.
      // One submesh is one texture page, so the ad image and the structural frame welded right behind it stay
      // apart even though they share a plane; without that their UV boxes union and the ad gate rejects both.
      // The opposite face of a two-sided board keys separately too, so the front can be chosen between them.
      const key = `${meshIndex}|${Math.round(unit[0] * 5)},${Math.round(unit[1] * 5)},${Math.round(unit[2] * 5)}`;
      let group = groups.get(key);
      if (!group) {
        group = { area: 0, normal: [0, 0, 0], center: [0, 0, 0], tris: [],
          minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity };
        groups.set(key, group);
      }
      group.area += area;
      group.normal = add(group.normal, scale(unit, area));
      group.center = add(group.center, scale(add(add(a, b), c), 1 / 3));
      group.tris.push([...a, ...b, ...c]);
      if (uv) {
        for (const i of [ia, ib, ic]) {
          const u = uv[i * 2], v = uv[i * 2 + 1];
          if (u < group.minU) group.minU = u;
          if (u > group.maxU) group.maxU = u;
          if (v < group.minV) group.minV = v;
          if (v > group.maxV) group.maxV = v;
        }
      }
    }
  }

  const single = (g: Group): boolean => {
    const uSpan = g.maxU - g.minU, vSpan = g.maxV - g.minV;
    return Number.isFinite(uSpan) && Number.isFinite(vSpan)
      && uSpan >= UV_SPAN_MIN && uSpan <= UV_SPAN_MAX && vSpan >= UV_SPAN_MIN && vSpan <= UV_SPAN_MAX;
  };
  const usable = [...groups.values()].filter(g => g.area >= MIN_AREA);
  if (!usable.length) return null;
  const ads = usable.filter(single);
  const best = (ads.length ? ads : usable).reduce((a, b) => (b.area > a.area ? b : a));

  let normal = normalize(best.normal, FACE);
  const center = scale(best.center, 1 / best.tris.length);
  // A board is two-sided; the winding alone is a coin-flip, so face the viewer when there is one.
  if (viewFrom && dot(normal, sub(viewFrom, center)) < 0) normal = scale(normal, -1);

  const { yaw, pitch } = screenAnglesFromNormal(normal);
  const up = normalize(rotateByPlacement(UP, { yaw, pitch }), UP);
  const right = normalize(cross(up, normal), [1, 0, 0]);
  let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity, maxDepth = -Infinity;
  for (const tri of best.tris)
    for (let k = 0; k < 3; k++) {
      const v = sub([tri[k * 3], tri[k * 3 + 1], tri[k * 3 + 2]], center);
      const r = dot(v, right), u = dot(v, up), d = dot(v, normal);
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (d > maxDepth) maxDepth = d;
    }
  const width = maxR - minR, height = maxU - minU;
  if (!(width > 0) || !(height > 0)) return null;

  const pos = add(center, add(add(scale(right, (minR + maxR) / 2), scale(up, (minU + maxU) / 2)),
    scale(normal, maxDepth + SCREEN_PROUD)));
  return { pos, yaw, pitch, width, height };
}

/** A screen fitted to a placement, ready to push onto the document. `id` is the caller's to mint. */
export function screenFromFit(id: string, prop: PlacedProp, fit: ScreenFit): Screen {
  return {
    id,
    prop: prop.id,
    pos: fit.pos,
    yaw: fit.yaw,
    ...(fit.pitch ? { pitch: fit.pitch } : {}),
    width: fit.width,
    height: fit.height,
  };
}
