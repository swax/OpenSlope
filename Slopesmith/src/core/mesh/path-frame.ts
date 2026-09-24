import type { V3 } from '../doc/types';
import { add, cross, dot, len, mul, norm, sub } from '../math/vec';
import { undirectedEdgeKey } from './primitives';
import type { MeshAdjacency } from './topology';

/** A path point's local axes: x along the path, y as close to world-up as x permits, z = x × y (always level). */
export type PathFrame = { x: V3; y: V3; z: V3 };

/** The level frame of a path running along `tangent` — what a free-edge point shows as Local on the gizmo, and
 * what path extrusion carries its profile in, so the profile's sideways axis stays horizontal however the path
 * turns and climbs. A vertical tangent has no level up: `fallbackUp` (a sweep's previous up) keeps the frame
 * continuous through it, else a world axis stands in. Null for a zero tangent. */
export function levelPathFrame(tangent: V3, fallbackUp?: V3): PathFrame | null {
  if (len(tangent) < 1e-12) return null;
  const x = norm(tangent);
  const offTangent = (reference: V3) => sub(reference, mul(x, dot(reference, x)));
  let y = offTangent([0, 1, 0]);
  if (len(y) < 1e-5 && fallbackUp) y = offTangent(fallbackUp);
  if (len(y) < 1e-5) y = offTangent(Math.abs(x[0]) <= Math.abs(x[2]) ? [1, 0, 0] : [0, 0, 1]);
  y = norm(y);
  return { x, y, z: norm(cross(x, y)) };
}

/** `frame` turned by `roll` radians about its own x (the path): y swings toward z. Roll is what a path point's
 * rotation leaves once its tangent handles have carried the rest (QuadMeshDoc.vertexRoll). */
export function rolledPathFrame(frame: PathFrame, roll: number): PathFrame {
  if (!roll) return frame;
  const c = Math.cos(roll), s = Math.sin(roll);
  return { x: frame.x, y: add(mul(frame.y, c), mul(frame.z, s)), z: sub(mul(frame.z, c), mul(frame.y, s)) };
}

/** The roll that turns the level frame along `tangent` so its y lands on `up` (projected off the tangent): the
 * inverse of rolledPathFrame, for writing a rotated point's frame back as a roll. 0 when either is degenerate. */
export function pathRollOf(tangent: V3, up: V3): number {
  const level = levelPathFrame(tangent);
  if (!level) return 0;
  const y = dot(up, level.y), z = dot(up, level.z);
  return Math.hypot(y, z) < 1e-12 ? 0 : Math.atan2(z, y);
}

/** Whether a path through a point runs forward going from vertex `a` to vertex `b`. A roll turns y toward z, and z
 * flips with the path's direction, so a stored roll only means one bank if everything reading it agrees which
 * way is forward: lower stable id to higher (`ids`), which no renumbering changes. Indices stand in without ids. */
export const pathRunsForward = (ids: readonly string[] | undefined, a: number, b: number) =>
  ids ? ids[a] < ids[b] : a < b;

/** A vertex's authored roll, 0 when it has none. Keyed by stable vertex id (see QuadMeshDoc.vertexRoll). */
export const vertexRollOf = (doc: { vertexIds: readonly string[]; vertexRoll?: Record<string, number> }, vertex: number) =>
  doc.vertexRoll?.[doc.vertexIds[vertex]] ?? 0;

/** A point on a path rather than a surface: it has edges, and none of them borders a patch. Its local frame is
 * the rolled level frame, which is why rotating one on its own means something. */
export function isFreePoint(adj: MeshAdjacency, vertex: number): boolean {
  const neighbours = adj.neighbors[vertex] ?? [];
  return neighbours.length > 0 && neighbours.every(nb => !adj.edgeQuads.get(undirectedEdgeKey(vertex, nb))?.length);
}

/** A point's local frame along the free edges through it — what the gizmo shows as Local, the cage draws as its
 * axis stubs, and path extrusion carries a profile in. X follows the curve through its two farthest-apart edge
 * neighbours: their tangent handles when `handle` is given (the tangent the extrusion uses), else the chord. X
 * runs from the earlier neighbour to the later (pathRunsForward), which gives both ends of one free edge the same
 * X and a roll one sense everywhere. Y is as near world-up as X permits, then turned by `roll` about X. Null for
 * an isolated point or a zero-length chord. */
export function edgePathFrame(pos: ArrayLike<number>, adj: MeshAdjacency, id: number,
  { handle, roll = 0, ids }: { handle?: (from: number, to: number) => V3; roll?: number; ids?: readonly string[] } = {},
): PathFrame | null {
  const point = (index: number): V3 => [pos[index * 3], pos[index * 3 + 1], pos[index * 3 + 2]];
  const neighbours = (adj.neighbors[id] ?? []).filter(index => index >= 0 && index * 3 + 2 < pos.length);
  if (!neighbours.length) return null;
  let a = id, b = neighbours[0], best = -1;
  if (neighbours.length > 1) {
    for (let i = 0; i < neighbours.length - 1; i++) for (let j = i + 1; j < neighbours.length; j++) {
      const d = len(sub(point(neighbours[i]), point(neighbours[j])));
      if (d > best) { best = d; a = neighbours[i]; b = neighbours[j]; }
    }
  }
  if (!pathRunsForward(ids, a, b)) [a, b] = [b, a];
  const chord = sub(point(b), point(a));
  if (len(chord) < 1e-5) return null;
  let tangent = chord;
  if (handle) {
    // Out along the handle toward b, back against the handle toward a; an end vertex is one of the pair.
    const curve = sub(b === id ? [0, 0, 0] : handle(id, b), a === id ? [0, 0, 0] : handle(id, a));
    if (len(curve) > 1e-8) tangent = curve;
  }
  const level = levelPathFrame(tangent);
  return level && rolledPathFrame(level, roll);
}

/** `v` in `frame`'s coordinates, and back: a profile expressed in one station's frame and rebuilt in another's
 * keeps its relation to the path's local axes. */
export const toPathFrame = (frame: PathFrame, v: V3): V3 => [dot(v, frame.x), dot(v, frame.y), dot(v, frame.z)];
export const fromPathFrame = (frame: PathFrame, c: V3): V3 =>
  add(add(mul(frame.x, c[0]), mul(frame.y, c[1])), mul(frame.z, c[2]));
