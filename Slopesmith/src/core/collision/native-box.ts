/**
 * The native mode-2 collision law: one sphere against one axis-aligned box, faces only.
 *
 * This is deliberately NOT a sphere/box overlap. The engine considers the six faces independently, and a face
 * can only register when the sphere's CENTRE lies inside the two perpendicular slabs — the radius never widens
 * that gate. The admitted region is therefore the box grown by one radius across each face with the edges and
 * corners left square, and a sphere that overlaps only an edge or a vertex of the box reports nothing at all
 * [Trailmap: 370-sphere-box]. Reproducing that exactly is the point of this module: authored courses route
 * grind rails and jump lines through prop bounds by a few centimetres at a time, and a rounded-corner test
 * collides where the original rides through.
 *
 * The contact taken is the face with the least clearance, which is why a native box contact normal is always
 * one of the six axis directions.
 */

export interface XYZ { x: number; y: number; z: number }

export interface NativeBoxContact {
  /** Which face answered, as its outward unit axis. */
  normal: XYZ;
  /** The sphere centre projected onto that face's plane. */
  point: XYZ;
  /** How far past the face the sphere reached: `radius + inward distance from that face`. */
  depth: number;
}

const AXES = ['x', 'y', 'z'] as const;
type Axis = typeof AXES[number];
/** The two axes a face's gate is measured on, per face axis. */
const PERPENDICULAR: Record<Axis, readonly [Axis, Axis]> = {
  x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'],
};

function unit(axis: Axis, sign: number): XYZ {
  return { x: axis === 'x' ? sign : 0, y: axis === 'y' ? sign : 0, z: axis === 'z' ? sign : 0 };
}

/** `centre` with the face axis moved onto the face plane. */
function onFace(centre: XYZ, axis: Axis, plane: number): XYZ {
  return {
    x: axis === 'x' ? plane : centre.x,
    y: axis === 'y' ? plane : centre.y,
    z: axis === 'z' ? plane : centre.z,
  };
}

/**
 * The static test, in the engine's own order: each axis in turn, gated on the centre being inside the other two
 * slabs, then both of that axis's faces accepted only when `distance + radius` is non-negative. The running
 * minimum picks the answering face, so a centre deep inside a large box reports its nearest wall.
 */
export function sphereVsNativeBox(
  min: XYZ, max: XYZ, centre: XYZ, radius: number,
): NativeBoxContact | null {
  let best = Infinity;
  let contact: NativeBoxContact | null = null;
  for (const axis of AXES) {
    const [i, j] = PERPENDICULAR[axis];
    if (centre[i] < min[i] || centre[i] > max[i]) continue;
    if (centre[j] < min[j] || centre[j] > max[j]) continue;
    const low = (centre[axis] - min[axis]) + radius;
    const high = (max[axis] - centre[axis]) + radius;
    if (low < 0 || high < 0) continue;
    if (low < best) {
      best = low;
      contact = { normal: unit(axis, -1), point: onFace(centre, axis, min[axis]), depth: low };
    }
    if (high < best) {
      best = high;
      contact = { normal: unit(axis, 1), point: onFace(centre, axis, max[axis]), depth: high };
    }
  }
  return contact;
}

/** Clip `[lo, hi]` by `a·u + b >= 0`. Returns false once the interval is empty. */
function clip(span: { lo: number; hi: number }, a: number, b: number): boolean {
  if (Math.abs(a) < 1e-12) return b >= 0;
  const at = -b / a;
  if (a > 0) span.lo = Math.max(span.lo, at);
  else span.hi = Math.min(span.hi, at);
  return span.lo <= span.hi;
}

/**
 * The same law, swept over one tick's straight-line motion of the sphere centre.
 *
 * The engine tests a box statically, once per 60 Hz tick, and consequently lets a fast enough rider skip
 * straight through a thin one. Slopesmith's tick can be behind, and its contact solver wants a parameter along
 * the move rather than a yes/no at the end of it, so the sweep is a deliberate deviation — it changes WHEN a
 * contact is found, never WHICH contacts exist: every constraint above is linear in the sweep parameter, so
 * each face's admitted window is an interval and the earliest interval start is the exact entry moment.
 */
export function sweptSphereVsNativeBox(
  min: XYZ, max: XYZ, from: XYZ, to: XYZ, radius: number,
): { u: number; contact: NativeBoxContact } | null {
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  let earliest = Infinity;
  for (const axis of AXES) {
    const [i, j] = PERPENDICULAR[axis];
    const span = { lo: 0, hi: 1 };
    // Gates: the centre inside both perpendicular slabs, radius excluded exactly as in the static test.
    if (!clip(span, delta[i], from[i] - min[i])) continue;
    if (!clip(span, -delta[i], max[i] - from[i])) continue;
    if (!clip(span, delta[j], from[j] - min[j])) continue;
    if (!clip(span, -delta[j], max[j] - from[j])) continue;
    // Faces: `(centre − min) + r >= 0` and `(max − centre) + r >= 0` on the face axis.
    if (!clip(span, delta[axis], (from[axis] - min[axis]) + radius)) continue;
    if (!clip(span, -delta[axis], (max[axis] - from[axis]) + radius)) continue;
    if (span.lo < earliest) earliest = span.lo;
  }
  if (!Number.isFinite(earliest)) return null;
  const entry = Math.min(1, Math.max(0, earliest));
  // Re-run the static test at the entry parameter so the reported face is the one the engine would have named
  // for that pose, rather than a face inferred from whichever interval happened to open first. The entry sits
  // exactly on a constraint boundary, so a second sample just inside covers the rounding case where the static
  // gate reads the boundary as outside.
  for (const u of entry < 1 ? [entry, Math.min(1, entry + 1e-5)] : [entry]) {
    const centre = { x: from.x + delta.x * u, y: from.y + delta.y * u, z: from.z + delta.z * u };
    const contact = sphereVsNativeBox(min, max, centre, radius);
    if (contact) return { u, contact };
  }
  return null;
}
