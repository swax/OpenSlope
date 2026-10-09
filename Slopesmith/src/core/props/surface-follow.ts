import type { PlacedProp, V3 } from '../doc/types';

/**
 * Surface-frame prop transforms (docs/012 · Surface frame): a Move that carries placements over the terrain, and a
 * Scale that pivots them on it. The same Move carries the other things Props mode places as points — a rail or
 * prop-line point, a gem, a free light, a free-standing screen — each a one-item freeze of its own.
 *
 * A placement stands at some HEIGHT relative to the ground beneath it: a seated rock exactly on it, a tree sunk into
 * it, a sign floating above it. Placement measures that vertically (a drop takes the model's base offset out of the
 * clicked height), and so does this: a Surface move keeps each placement's vertical offset from the ground under its
 * origin, so the tree is sunk just as deep wherever it is dragged to and the sign floats just as high. Orientation is
 * left alone — an upright tree stays upright on a steeper slope — and a Surface scale pivots on that ground point, so
 * anything resting on the surface keeps resting on it as it grows or shrinks, and anything sunk sinks in proportion.
 *
 * Placements tied into one authored group (`assembly`) are one RIGID unit: every member takes the same lift — the
 * mean change in the ground under the group's members — so a group keeps its shape over uneven ground instead of
 * each piece dropping into its own hollow. Every other placement is a unit of its own.
 *
 * The drag is frozen at its start (`freezeSurfaceFollow`) and every frame is evaluated from that snapshot, so
 * repeated gizmo reports never accumulate drift. The one thing a frame carries forward is the deck each placement
 * last stood on: where the mountain passes over itself, the surface nearest that deck is the one it keeps riding,
 * the rule a dragged course knot follows, so a prop slid under a bridge stays under it.
 */

/** The surface height at data-space (x, z) nearest `nearY` — the deck a point riding at that height stands on — or
 *  null where the column misses the surface entirely. */
export type SurfaceHeight = (x: number, z: number, nearY: number) => number | null;

/** One placement as a Surface transform froze it. */
export interface SurfaceMember {
  index: number;
  /** Drag-start origin, data space. */
  pos: V3;
  scale: number;
  /** The ground under the origin at drag-start, nearest the origin's height; null off the surface. */
  ground: number | null;
  /** The deck it stood on at the last evaluated frame — the `nearY` the next frame asks for. */
  last: number | null;
  /** The rigid unit it moves with (an index into `SurfaceFollow.units`). */
  unit: number;
}

/** A rigid unit's drag-start ground level: the mean ground under those of its members that had any. */
export interface SurfaceUnit { ground: number | null }

export interface SurfaceFollow {
  members: SurfaceMember[];
  units: SurfaceUnit[];
}

/** What a Surface transform carries: the id its result answers by, its origin (data space), its size (1 for a
 *  point), and the rigid unit it moves with — items sharing a `unit` key take one lift; absent, it is its own. */
export interface SurfaceItem { index: number; pos: V3; scale?: number; unit?: string }

/** Freeze `items` for a Surface transform, measuring the ground under each origin. */
export function freezeSurfaceFollow(items: readonly SurfaceItem[], height: SurfaceHeight): SurfaceFollow {
  const unitOf = new Map<string, number>();
  const units: { sum: number; count: number }[] = [];
  const members: SurfaceMember[] = items.map((item, i) => {
    const pos: V3 = [item.pos[0], item.pos[1], item.pos[2]];
    const ground = height(pos[0], pos[2], pos[1]);
    const key = item.unit === undefined ? `item:${i}` : `unit:${item.unit}`;
    let unit = unitOf.get(key);
    if (unit === undefined) { unit = units.length; units.push({ sum: 0, count: 0 }); unitOf.set(key, unit); }
    if (ground !== null) { units[unit].sum += ground; units[unit].count++; }
    return { index: item.index, pos, scale: item.scale ?? 1, ground, last: ground, unit };
  });
  return { members, units: units.map(u => ({ ground: u.count ? u.sum / u.count : null })) };
}

/** The placements at `indices` (looked up through `prop`) as Surface items, an authored group one rigid unit.
 *  Indices that name no placement are dropped; repeated ones count once. */
export function placementSurfaceItems(prop: (index: number) => PlacedProp | undefined,
  indices: readonly number[]): SurfaceItem[] {
  return [...new Set(indices)].flatMap(index => {
    const placed = prop(index);
    return placed ? [{ index, pos: placed.pos, scale: placed.scale, unit: placed.assembly }] : [];
  });
}

/**
 * Each unit's lift where its members' origins now stand over (x, z) = `at(member)`: the mean change in the ground
 * under the members that had any at drag-start. A member whose column now misses the surface — dragged off the
 * mountain's edge — holds the change it last had, so it carries on at the height it reached rather than falling.
 * Advances every member's `last` deck.
 */
function unitLifts(f: SurfaceFollow, at: (m: SurfaceMember) => [number, number], height: SurfaceHeight): number[] {
  const sum = f.units.map(() => 0), count = f.units.map(() => 0);
  for (const m of f.members) {
    if (m.ground === null) continue;
    const [x, z] = at(m);
    const g = height(x, z, m.last ?? m.ground);
    if (g !== null) m.last = g;
    sum[m.unit] += (m.last ?? m.ground) - m.ground;
    count[m.unit]++;
  }
  return sum.map((s, u) => count[u] ? s / count[u] : 0);
}

/**
 * Move: every placement slides `dx` / `dz` (data space) across the ground, and rides it — its height changes by its
 * unit's lift, keeping the vertical offset it had from the surface. Answers each member's new origin.
 */
export function slideOverSurface(f: SurfaceFollow, dx: number, dz: number,
  height: SurfaceHeight): { index: number; pos: V3 }[] {
  const lifts = unitLifts(f, m => [m.pos[0] + dx, m.pos[2] + dz], height);
  return f.members.map(m => ({ index: m.index, pos: [m.pos[0] + dx, m.pos[1] + lifts[m.unit], m.pos[2] + dz] }));
}

/**
 * Scale by `factor` about `pivot` (data space): spacing spreads about the pivot across the ground, and each unit
 * grows about the ground at its own level — what rests on the surface keeps resting on it, what is sunk into it or
 * floats above it sinks or floats in proportion — then rides the ground to wherever the spread carried it. A unit
 * that stood over no surface at all scales about the pivot as a World scale does. Answers each member's new origin
 * and size.
 */
export function scaleOverSurface(f: SurfaceFollow, factor: number, pivot: V3,
  height: SurfaceHeight): { index: number; pos: V3; scale: number }[] {
  const spread = (m: SurfaceMember): [number, number] =>
    [pivot[0] + (m.pos[0] - pivot[0]) * factor, pivot[2] + (m.pos[2] - pivot[2]) * factor];
  const lifts = unitLifts(f, spread, height);
  return f.members.map(m => {
    const [x, z] = spread(m);
    const ground = f.units[m.unit].ground;
    const y = ground === null ? pivot[1] + (m.pos[1] - pivot[1]) * factor
      : ground + lifts[m.unit] + (m.pos[1] - ground) * factor;
    return { index: m.index, pos: [x, y, z], scale: m.scale * factor };
  });
}
