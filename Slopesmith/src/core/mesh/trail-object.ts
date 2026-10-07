import type {
  AuthoredTrail, PathHandles, QuadMeshDoc, TrailCutShape, TrailKnotSettings, TrailPath, TrailSettings, TrailTileSet, V3,
} from '../doc/types';
import { nameIndex } from '../doc/ids';
import { pathHandleOffsets, railBezierSegments } from '../rails/rails';
import { setQuadsLocked } from './locks';
import { assignMap, finishMeshRewrite, looseVertexIds } from './ops/contract';
import { liveQuadEdges, undirectedEdgeKey } from './primitives';
import {
  applyTrailNetwork, applyTrailSpline, layoutTrailSpline, MESA_TRAIL_DEFAULTS, trailSpanPatches, trailStationLanes, untrimmedSplinePlace,
  type TrailJunction, type TrailKnotProfile, type TrailLayout, type TrailLayoutOptions, type TrailRibbon, type TrailRunSpec,
  type TrailSplineTrim, type TrailStation,
} from './trail';
import { DEFAULT_TRAIL_TILES, trailSettingsTiles, trailTileSetsWith, trailTileSetTiles, trailTiling } from './trail-textures';

/**
 * Owned trails (docs/023 "Track: a rail that owns terrain"): a network of centre splines that keeps the patches it
 * generated.
 *
 * A trail is a set of POINTS and the PATHS through them (docs/023 · Networks). Every path is alike — its own
 * spline, settings and handles — and a point paths share is where they meet. A point where three or more arms
 * meet, or two path ends with nothing else, carries a JUNCTION: the paths are cut back from it and the opening is
 * knitted with one patch per lane around a hub (`applyTrailNetwork`). Forks, merges, crossings, bypasses and loops
 * are all just paths sharing points.
 *
 * The ribbons are ordinary mesh — a rail of vertices per lane and one more, a patch per lane per span, narrowing into
 * the junctions — and the trail names them by stable id, so they survive every renumbering a topology op does elsewhere. `cutTrail` is the one generator: it
 * cuts the whole network standalone (a `piece`) and writes the result over the vertices and patches the trail
 * already owns, slot by slot, appending or retiring only what a bigger or smaller cut needs. A re-cut that keeps
 * the network's shape keeps every name. Everything it owns is locked, which keeps hand edits off it, and every
 * Bézier handle on its edges is re-derived from the new positions.
 *
 * Patches joined onto the ribbons (a Weld Loops seam, a retopologised mountain) share their rim vertices. A re-cut
 * moves those vertices, so the joined patches stretch with the trail — and so a joined trail must keep its layout,
 * which `cutTrail` enforces by asking each run for exactly the spans it already has.
 */

/** A new path's settings: the measured Mesa section the Create Trail tool has always started from. */
export const TRAIL_SETTINGS_DEFAULTS: Readonly<TrailSettings> = {
  widthM: MESA_TRAIL_DEFAULTS.widthM,
  lanes: MESA_TRAIL_DEFAULTS.lanes,
  centerBias: MESA_TRAIL_DEFAULTS.centerBias,
  dishPercent: 10.5, // MESA_TRAIL_DEFAULTS.dishFraction as a percentage, written out so it is exact
  patchLengthM: MESA_TRAIL_DEFAULTS.maxPatchLengthM,
  maxTurnDegrees: MESA_TRAIL_DEFAULTS.maxTurnDegrees,
  bankGainM: MESA_TRAIL_DEFAULTS.bankGainM,
  maxBankDegrees: MESA_TRAIL_DEFAULTS.maxBankDegrees,
  ...DEFAULT_TRAIL_TILES,
  caps: 'none',
};

export type TrailKnotSettingsList = readonly (TrailKnotSettings | null | undefined)[] | undefined;

const copy = (p: readonly number[]): V3 => [p[0], p[1], p[2]];

/**
 * The knot profile some points' own values stand for (docs/023 · Per-point section), one entry per knot of a path.
 * A knot without its own value takes the path's, so a value set on one knot eases back to the path's at its
 * neighbours. Only the values some knot sets are passed on: a path whose knots set nothing cuts exactly as it did
 * before knots could.
 */
export function trailKnotProfile(settings: TrailSettings, knotSettings: TrailKnotSettingsList, knots: number):
TrailKnotProfile | undefined {
  const own = Array.from({ length: knots }, (_, knot) => knotSettings?.[knot] ?? {});
  const sets = (key: keyof TrailKnotSettings) => own.some(entry => entry[key] !== undefined);
  const profile: TrailKnotProfile = {};
  if (sets('widthM')) profile.widthM = own.map(entry => entry.widthM ?? settings.widthM);
  if (sets('centerBias')) profile.centerBias = own.map(entry => entry.centerBias ?? settings.centerBias);
  if (sets('dishPercent')) profile.dishFraction = own.map(entry => (entry.dishPercent ?? settings.dishPercent) / 100);
  if (sets('bankDegrees')) profile.bankDegrees = own.map(entry => entry.bankDegrees ?? null);
  // A fixed knot's strength is moot at the knot itself; the automatic bank it fades into is the neighbour's.
  if (sets('bankStrength'))
    profile.bankStrength = own.map(entry => entry.bankDegrees === undefined ? entry.bankStrength ?? 1 : 1);
  return Object.keys(profile).length ? profile : undefined;
}

/** A point list's own values with `key` set on `point`, or cleared when `value` is undefined — an entry left empty
 *  is dropped, and so are empty entries trailing off the end. */
export function setTrailKnotValue<K extends keyof TrailKnotSettings>(list: TrailKnotSettingsList, count: number,
  point: number, key: K, value: TrailKnotSettings[K] | undefined): (TrailKnotSettings | null)[] {
  const out = Array.from({ length: count }, (_, i) => list?.[i] ? { ...list[i] } : null);
  if (point < 0 || point >= count) return trimKnotSettings(out);
  const entry: TrailKnotSettings = { ...(out[point] ?? {}) };
  if (value === undefined) delete entry[key]; else entry[key] = value;
  out[point] = Object.keys(entry).length ? entry : null;
  return trimKnotSettings(out);
}

function trimKnotSettings(list: (TrailKnotSettings | null)[]): (TrailKnotSettings | null)[] {
  let end = list.length;
  while (end > 0 && !list[end - 1]) end--;
  return list.slice(0, end);
}

/** The generator options some settings stand for, with knots' own values when there are any. */
export function trailLayoutOptions(settings: TrailSettings, knotSettings?: TrailKnotSettingsList, knots = 0,
  sets?: readonly TrailTileSet[]): TrailLayoutOptions {
  const knotProfile = trailKnotProfile(settings, knotSettings, knots);
  return {
    ...(knotProfile ? { knotProfile } : {}),
    widthM: settings.widthM,
    lanes: settings.lanes ?? MESA_TRAIL_DEFAULTS.lanes,
    centerBias: settings.centerBias,
    dishFraction: settings.dishPercent / 100,
    maxPatchLengthM: settings.patchLengthM,
    minPatchLengthM: Math.min(MESA_TRAIL_DEFAULTS.minPatchLengthM, settings.patchLengthM * 0.45),
    maxTurnDegrees: settings.maxTurnDegrees,
    bankGainM: settings.bankGainM,
    maxBankDegrees: settings.maxBankDegrees,
    maxBankStepDegrees: MESA_TRAIL_DEFAULTS.maxBankStepDegrees,
    surface: MESA_TRAIL_DEFAULTS.surface,
    textures: trailTiling(settings, sets),
  };
}

/** The generator options one path is cut with: its settings, the own values of the points it runs through, and the
 *  tile sets it names, from the built-in ones and the mountain's own `sets`. */
export function pathLayoutOptions(trail: Pick<AuthoredTrail, 'pointSettings'>, path: TrailPath, sets?: readonly TrailTileSet[]):
TrailLayoutOptions {
  return trailLayoutOptions(path.settings, path.points.map(point => trail.pointSettings?.[point] ?? null), path.points.length, sets);
}

/** The shortest run a junction may leave between itself and the next junction or the path's end. */
const MIN_RUN_M = 2;

// ---- the network (docs/023 · Networks) ----------------------------------------------------------------------

type Network = Pick<AuthoredTrail, 'points' | 'paths'>;

/** Whether a path cuts: it needs two points. One still being drawn may have a single point. */
export const pathCuts = (path: TrailPath): boolean => path.points.length >= 2;

/** A path's knots, as positions. */
export const pathKnots = (trail: Pick<AuthoredTrail, 'points'>, path: TrailPath): V3[] =>
  path.points.map(point => trail.points[point]);

/** How many arms meet at each point: one for every path that ends there, two for every one that runs through. */
export function pointArms(trail: Network): number[] {
  const arms = trail.points.map(() => 0);
  for (const path of trail.paths) {
    if (!pathCuts(path)) continue;
    const last = path.points.length - 1;
    path.points.forEach((point, i) => { if (arms[point] !== undefined) arms[point] += i === 0 || i === last ? 1 : 2; });
  }
  return arms;
}

/**
 * The points that carry a junction: three arms or more — a fork, a merge, a crossing — or two path ends and nothing
 * else, where a loop closes or two paths meet end to end. A point one path just runs through is none.
 */
export function junctionPoints(trail: Network): Set<number> {
  const arms = pointArms(trail);
  const through = new Set<number>();
  for (const path of trail.paths) {
    if (!pathCuts(path)) continue;
    path.points.forEach((point, i) => { if (i > 0 && i < path.points.length - 1) through.add(point); });
  }
  return new Set(arms.flatMap((count, point) => count >= 3 || (count === 2 && !through.has(point)) ? [point] : []));
}

/** The paths that run through or end on `point`, each once. */
export const pathsThrough = (trail: Network, point: number): number[] =>
  trail.paths.flatMap((path, index) => path.points.includes(point) ? [index] : []);

/** Which ends of `path` stand on `point`: none, one, or — a loop closed there — both. */
export function pathEndsAt(path: TrailPath, point: number): ('start' | 'end')[] {
  if (!pathCuts(path)) return path.points[0] === point ? ['end'] : [];
  return [...(path.points[0] === point ? ['start' as const] : []), ...(path.points.at(-1) === point ? ['end' as const] : [])];
}

/** Every path joined to `path` through shared points, itself included, in index order. */
export function connectedPaths(trail: Network, path: number): number[] {
  const seen = new Set([path]), queue = [path];
  for (let at = 0; at < queue.length; at++) {
    const own = new Set(trail.paths[queue[at]]?.points ?? []);
    trail.paths.forEach((other, index) => {
      if (!seen.has(index) && other.points.some(point => own.has(point))) { seen.add(index); queue.push(index); }
    });
  }
  return [...seen].sort((a, b) => a - b);
}

// ---- editing the network ---------------------------------------------------------------------------------------

/** What tidying a trail did to its numbering: each old path's and point's new place, or null where it went. */
export interface TrailRenumbering {
  trail: AuthoredTrail;
  paths: (number | null)[];
  points: (number | null)[];
}

const handlesOf = (path: TrailPath, length = path.points.length): (PathHandles | null)[] =>
  Array.from({ length }, (_, i) => path.handles?.[i] ?? null);

/** A path with its handles, the field dropped once none is dragged. */
function withHandles(path: TrailPath, handles: readonly (PathHandles | null)[]): TrailPath {
  const next: TrailPath = { ...path };
  if (handles.some(Boolean)) next.handles = [...handles]; else delete next.handles;
  return next;
}

/** A trail with a new point at `pos`, and its place. */
export function withNewPoint(trail: AuthoredTrail, pos: readonly number[]): { trail: AuthoredTrail; point: number } {
  return { trail: { ...trail, points: [...trail.points, copy(pos)] }, point: trail.points.length };
}

/** A trail with path `index` replaced. */
export const withPath = (trail: AuthoredTrail, index: number, path: TrailPath): AuthoredTrail =>
  ({ ...trail, paths: trail.paths.map((other, i) => i === index ? path : other) });

/** `path` grown by `point` on one end: after its last point, or ahead of its first. */
export function extendPath(path: TrailPath, point: number, end: 'start' | 'end'): TrailPath {
  const handles = handlesOf(path);
  return end === 'end'
    ? withHandles({ ...path, points: [...path.points, point] }, [...handles, null])
    : withHandles({ ...path, points: [point, ...path.points] }, [null, ...handles]);
}

/** `path` without the point on one end, and that end's handles. */
export function trimPath(path: TrailPath, end: 'start' | 'end'): TrailPath {
  const handles = handlesOf(path);
  return end === 'end'
    ? withHandles({ ...path, points: path.points.slice(0, -1) }, handles.slice(0, -1))
    : withHandles({ ...path, points: path.points.slice(1) }, handles.slice(1));
}

/** A path keeping only the knots at `indices`, each with its own handles. */
const pathAt = (path: TrailPath, indices: readonly number[]): TrailPath =>
  withHandles({ ...path, points: indices.map(i => path.points[i]) }, indices.map(i => path.handles?.[i] ?? null));

/** `path` with every visit to a dropped point taken out — it then runs straight from the point before to the
 *  point after — and two visits left in a row to the same point made one. */
function pathWithout(path: TrailPath, drop: (point: number) => boolean): TrailPath {
  const keep: number[] = [];
  path.points.forEach((point, i) => {
    if (drop(point) || (keep.length && path.points[keep.at(-1)!] === point)) return;
    keep.push(i);
  });
  return pathAt(path, keep);
}

/**
 * Tidy a trail after an edit: paths left with fewer than two points go — all but `keep`, the one being drawn — and
 * so do points no path uses any more, each later point moving down into the gap.
 */
export function compactTrail(trail: AuthoredTrail, keep: number | null = null): TrailRenumbering {
  const paths: (number | null)[] = [];
  const kept: TrailPath[] = [];
  trail.paths.forEach((path, i) => {
    if (path.points.length >= 2 || (i === keep && path.points.length)) { paths.push(kept.length); kept.push(path); } else paths.push(null);
  });
  const used = new Set(kept.flatMap(path => path.points));
  const points: (number | null)[] = [];
  let next = 0;
  for (let i = 0; i < trail.points.length; i++) points.push(used.has(i) ? next++ : null);
  const out: AuthoredTrail = {
    ...trail,
    points: trail.points.filter((_, i) => points[i] !== null),
    paths: kept.map(path => ({ ...path, points: path.points.map(point => points[point]!) })),
  };
  const settings = trimKnotSettings(trail.points.flatMap((_, i) => points[i] === null ? [] : [trail.pointSettings?.[i] ?? null]));
  if (settings.length) out.pointSettings = settings; else delete out.pointSettings;
  return { trail: out, paths, points };
}

/** Delete a point: out of every path through it — each then runs straight past it — and gone from the network.
 *  A path left with one point goes too, except `keep`, the one being drawn. */
export function withoutTrailPoint(trail: AuthoredTrail, point: number, keep: number | null = null): TrailRenumbering {
  return compactTrail({ ...trail, paths: trail.paths.map(path => pathWithout(path, at => at === point)) }, keep);
}

/** Delete paths, and the points only they ran through. */
export function withoutTrailPaths(trail: AuthoredTrail, drop: readonly number[]): TrailRenumbering {
  const gone = new Set(drop);
  return compactTrail({ ...trail, paths: trail.paths.map((path, i) => gone.has(i) ? { ...path, points: [] } : path) });
}

/**
 * `path` run the other way: its points and handles reversed (each knot's in and out swap), its centre seam mirrored,
 * since the seam is measured across the direction of travel, and its caps on the ends they were on — the same ground,
 * from the other end.
 */
export function reversePath(path: TrailPath): TrailPath {
  const handles = handlesOf(path).reverse().map(own => own
    ? { ...(own.out ? { in: own.out } : {}), ...(own.in ? { out: own.in } : {}) } as PathHandles : null);
  const caps = path.settings.caps === 'start' ? 'end' : path.settings.caps === 'end' ? 'start' : path.settings.caps;
  return withHandles({
    ...path, points: [...path.points].reverse(),
    settings: { ...path.settings, centerBias: 1 - path.settings.centerBias, ...(caps ? { caps } : {}) },
  }, handles);
}

/** The point values `path`'s own points carry, mirrored for a path now run the other way: the centre seam and a
 *  fixed bank are measured across the direction of travel. A point other paths share is theirs too, and stays. */
function mirrorOwnPoints(trail: AuthoredTrail, path: number): AuthoredTrail {
  if (!trail.pointSettings?.some(Boolean)) return trail;
  const own = new Set(trail.paths[path].points.filter(point => pathsThrough(trail, point).length === 1));
  const settings = trail.pointSettings.map((entry, point) => {
    if (!entry || !own.has(point)) return entry;
    const mirrored: TrailKnotSettings = { ...entry };
    if (entry.centerBias !== undefined) mirrored.centerBias = 1 - entry.centerBias;
    if (entry.bankDegrees !== undefined) mirrored.bankDegrees = -entry.bankDegrees;
    return mirrored;
  });
  return { ...trail, pointSettings: settings };
}

const sameSettings = (a: TrailSettings, b: TrailSettings) => {
  const x = { ...a, lanes: a.lanes ?? 2, caps: a.caps ?? 'none', ...trailSettingsTiles(a) };
  const y = { ...b, lanes: b.lanes ?? 2, caps: b.caps ?? 'none', ...trailSettingsTiles(b) };
  return (Object.keys(TRAIL_SETTINGS_DEFAULTS) as (keyof TrailSettings)[]).every(key => x[key] === y[key]);
};

/**
 * Where exactly two path ends meet at `point` and nothing else does — two paths laid end to end — and the two are
 * cut alike, make them one path: the lower-numbered keeps its place and its direction and takes the other in,
 * turned round if it ran the other way, and the other goes (its old place maps to the one it joined). A path whose
 * own two ends meet there is a closed loop and stays one; two paths cut differently stay two, the junction between
 * them easing one into the other. Null when there is nothing to join.
 */
export function fusePathsAt(trail: AuthoredTrail, point: number): (TrailRenumbering & { kept: number }) | null {
  if (pointArms(trail)[point] !== 2) return null;
  const ends = trail.paths.flatMap((path, index) => pathCuts(path) ? pathEndsAt(path, point).map(end => ({ index, end })) : []);
  if (ends.length !== 2 || ends[0].index === ends[1].index) return null;
  const [a, b] = ends;
  const keep = trail.paths[a.index];
  // The other path faced to run on from `keep` through the point: away from it after `keep`'s end, into it ahead of
  // `keep`'s start.
  const turned = a.end === 'end' ? b.end !== 'start' : b.end !== 'end';
  const other = turned ? reversePath(trail.paths[b.index]) : trail.paths[b.index];
  if (!sameSettings(keep.settings, other.settings)) return null;
  const [into, onward] = a.end === 'end' ? [keep, other] : [other, keep];
  const arriving = handlesOf(into), leaving = handlesOf(onward);
  const meet = { ...(arriving.at(-1)?.in ? { in: arriving.at(-1)!.in } : {}), ...(leaving[0]?.out ? { out: leaving[0].out } : {}) };
  const joined = withHandles({ ...keep, points: [...into.points, ...onward.points.slice(1)] },
    [...arriving.slice(0, -1), Object.keys(meet).length ? meet as PathHandles : null, ...leaving.slice(1)]);
  let next = turned ? mirrorOwnPoints(trail, b.index) : trail;
  next = withPath(next, a.index, joined);
  const tidied = compactTrail({ ...next, paths: next.paths.map((path, i) => i === b.index ? { ...path, points: [] } : path) });
  const kept = tidied.paths[a.index]!;
  return { ...tidied, paths: tidied.paths.map((index, i) => i === b.index ? kept : index), kept };
}

/**
 * Make `from` and `into` one point, at `into`: every path through `from` runs through `into` instead (a path that
 * would then visit it twice in a row visits it once), `from`'s own values go where `into` has none, and where that
 * leaves two path ends meeting alone, the two paths join (`fusePathsAt`).
 */
export function mergeTrailPoints(trail: AuthoredTrail, from: number, into: number): TrailRenumbering {
  const moved = trail.paths.map(path => pathWithout({ ...path, points: path.points.map(point => point === from ? into : point) }, () => false));
  let next: AuthoredTrail = { ...trail, paths: moved };
  if (!trail.pointSettings?.[into] && trail.pointSettings?.[from])
    next = { ...next, pointSettings: trail.pointSettings.map((entry, i) => i === into ? trail.pointSettings![from] : entry) };
  const tidied = compactTrail(next);
  const at = tidied.points[into];
  const fused = at === null ? null : fusePathsAt(tidied.trail, at);
  if (!fused) return tidied;
  return {
    trail: fused.trail,
    paths: tidied.paths.map(index => index === null ? null : fused.paths[index]),
    points: tidied.points.map(index => index === null ? null : fused.points[index]),
  };
}

/**
 * Cut every path that runs through `point` in two there, so each arm there is a path's end: two pieces where one path
 * runs through, three at a fork, four at a crossing. A path's first piece keeps its place, and the rest follow every
 * path, in order along it, each with its path's settings. The handles either side of a cut are fixed where the curve
 * already ran — an end's automatic handle would aim along its own chord — so no piece changes shape. The points stay
 * as they are, and nothing fuses: the pieces are apart so each can be set on its own. `pieces` gives each old path's
 * pieces; null when no path runs through `point`.
 */
export function splitPathsAt(trail: AuthoredTrail, point: number): { trail: AuthoredTrail; pieces: number[][] } | null {
  const kept: TrailPath[] = [], added: TrailPath[] = [], pieces: number[][] = [];
  trail.paths.forEach((path, index) => {
    const cuts = path.points.flatMap((at, i) => at === point && i > 0 && i < path.points.length - 1 ? [i] : []);
    if (!cuts.length) { kept.push(path); pieces.push([index]); return; }
    const offsets = pathHandleOffsets(pathKnots(trail, path), path.handles);
    const bounds = [0, ...cuts, path.points.length - 1];
    const parts = bounds.slice(1).map((last, k) => {
      const first = bounds[k];
      const handles = handlesOf(path).slice(first, last + 1);
      if (k > 0) handles[0] = { out: offsets[first].out! };
      if (k < cuts.length) handles[handles.length - 1] = { in: offsets[last].in! };
      return withHandles({ ...path, points: path.points.slice(first, last + 1) }, handles);
    });
    kept.push(parts[0]);
    pieces.push([index, ...parts.slice(1).map((_, k) => trail.paths.length + added.length + k)]);
    added.push(...parts.slice(1));
  });
  return added.length ? { trail: { ...trail, paths: [...kept, ...added] }, pieces } : null;
}

/**
 * Break `point` apart, so the paths no longer meet there: every path running on through it is cut there
 * (`splitPathsAt`), and every arm there ends at a point of its own at the same place — two sides mid-path, three at a
 * fork, four at a crossing. The first arm of path `first` (or of the first path there) keeps the point; each other
 * arm gets a new point after all the others, carrying the point's own values. A loop broken open this way is one
 * path again: where its pieces' far ends now meet alone, they fuse (`fusePathsAt`). `pieces` gives each old path's
 * paths now; null where fewer than two arms meet.
 */
export function disconnectPoint(trail: AuthoredTrail, point: number, first?: number):
{ trail: AuthoredTrail; pieces: number[][] } | null {
  if ((pointArms(trail)[point] ?? 0) < 2) return null;
  const split = splitPathsAt(trail, point) ?? { trail, pieces: trail.paths.map((_, index) => [index]) };
  const points = [...split.trail.points];
  const settings = points.map((_, i) => trail.pointSettings?.[i] ?? null);
  const order = split.trail.paths.map((_, index) => index);
  const leading = first === undefined ? [] : split.pieces[first] ?? [];
  order.sort((a, b) => Number(!leading.includes(a)) - Number(!leading.includes(b)) || a - b);
  let kept = false;
  const own = (): number => {
    if (!kept) { kept = true; return point; }
    settings.push(trail.pointSettings?.[point] ?? null);
    return points.push(copy(trail.points[point])) - 1;
  };
  const paths = [...split.trail.paths];
  for (const index of order) {
    const path = paths[index];
    if (!pathCuts(path)) continue;
    const last = path.points.length - 1;
    paths[index] = { ...path, points: path.points.map((at, i) => at === point && (i === 0 || i === last) ? own() : at) };
  }
  let next: AuthoredTrail = { ...split.trail, points, paths };
  const list = trimKnotSettings(settings);
  if (list.length) next.pointSettings = list; else delete next.pointSettings;
  let pieces = split.pieces;
  // A closed loop cut open elsewhere: its first and last pieces meet at its old closing point, and only there.
  trail.paths.forEach((path, index) => {
    const closing = path.points[0];
    if (pieces[index].length < 2 || closing === point || path.points.at(-1) !== closing) return;
    const fused = fusePathsAt(next, closing);
    if (!fused) return;
    next = fused.trail;
    pieces = pieces.map(list => [...new Set(list.map(piece => fused.paths[piece]!))]);
  });
  return { trail: next, pieces };
}

/**
 * A trail split into one trail per connected network — what a disconnect leaves. The network holding its first path
 * keeps the trail, and so its id, patches and names, which re-cut in place; each other is a new trail with no id or
 * patches yet, to be named and cut fresh. Each path's and point's new place, as the trail it went to (by its place in
 * `trails`) and its place there.
 */
export function separateTrail(trail: AuthoredTrail): {
  trails: AuthoredTrail[];
  paths: { trail: number; path: number }[];
  points: ({ trail: number; point: number } | null)[];
} {
  const groups: number[][] = [], seen = new Set<number>();
  trail.paths.forEach((_, index) => {
    if (seen.has(index)) return;
    const group = connectedPaths(trail, index);
    group.forEach(path => seen.add(path));
    groups.push(group);
  });
  const paths: { trail: number; path: number }[] = [];
  const points: ({ trail: number; point: number } | null)[] = trail.points.map(() => null);
  const trails = groups.map((group, g) => {
    const tidied = compactTrail({ ...trail, paths: trail.paths.map((path, i) => group.includes(i) ? path : { ...path, points: [] }) });
    tidied.paths.forEach((at, i) => { if (at !== null) paths[i] = { trail: g, path: at }; });
    tidied.points.forEach((at, i) => { if (at !== null) points[i] = { trail: g, point: at }; });
    if (g === 0) return tidied.trail;
    const { network: _network, name: _name, ...fresh } = tidied.trail;
    return { ...fresh, id: '', vertices: [], quads: [] };
  });
  return { trails, paths, points };
}

/** `other` taken into `trail`: its points after `trail`'s, its paths after `trail`'s, with `trail`'s id and names.
 *  Returns how far its points and paths moved. */
export function joinTrails(trail: AuthoredTrail, other: AuthoredTrail): { trail: AuthoredTrail; points: number; paths: number } {
  const offset = trail.points.length;
  const next: AuthoredTrail = {
    ...trail,
    points: [...trail.points, ...other.points.map(copy)],
    paths: [...trail.paths, ...other.paths.map(path => ({ ...path, points: path.points.map(point => point + offset) }))],
  };
  const settings = trimKnotSettings([
    ...Array.from({ length: offset }, (_, i) => trail.pointSettings?.[i] ?? null),
    ...other.points.map((_, i) => other.pointSettings?.[i] ?? null),
  ]);
  if (settings.length) next.pointSettings = settings; else delete next.pointSettings;
  return { trail: next, points: offset, paths: trail.paths.length };
}

// ---- ownership ---------------------------------------------------------------------------------------------------

/** Where a trail's owned geometry is now, as indices into the current document. */
export interface OwnedTrail {
  /** Run by run, station by station, one more than the lanes there, from the generator's left rim across; then each
   *  junction's: a crotch per arm, the hub, and any points of a split line. */
  vertices: number[];
  /** Run by run, span by span, as each lays them (`trailSpanPatches`); then each junction's. */
  quads: number[];
  /** Spans in every run together. */
  spans: number;
  /** Spans per run, in cut order, the path each run is cut from, its lanes, and the lanes at each of its stations. */
  runSpans: number[];
  runPaths: number[];
  runLanes: number[];
  runStations: number[][];
  /** Arms per junction, in cut order. */
  junctionArms: number[];
}

const sameCorners = (corners: readonly number[] | undefined, want: readonly number[]) =>
  !!corners && corners.length === 4 && corners.every((vertex, i) => vertex === want[i]);

/** How a trail's owned names divide up: its stored shape, or one two-lane run of all its patches. */
export const trailCutShape = (trail: AuthoredTrail): TrailCutShape =>
  trail.network ?? { runSpans: [trail.quads.length / 2], runPaths: [0], junctionArms: [] };

/** Each run's lanes, the lanes at each of its stations, and each junction's vertices and patches, as a cut shape says
 *  — two lanes a run, end to end, where it says none. */
function shapeSizes(shape: TrailCutShape):
{ runLanes: number[]; runStations: number[][]; junctions: { vertices: number; quads: number }[] } | null {
  const runLanes = shape.runLanes ?? shape.runSpans.map(() => 2);
  const ends = shape.runEnds ?? runLanes.map(lanes => [lanes, lanes] as [number, number]);
  if (runLanes.length !== shape.runSpans.length || ends.length !== shape.runSpans.length
    || [...runLanes, ...ends.flat()].some(lanes => !Number.isInteger(lanes) || lanes < 1)) return null;
  return {
    runLanes,
    runStations: shape.runSpans.map((spans, run) => trailStationLanes(spans, runLanes[run], ends[run])),
    junctions: shape.junctionSizes ?? shape.junctionArms.map(arms => ({ vertices: arms + 1, quads: arms * 2 })),
  };
}

/** The lanes, ends and junction sizes a cut shape records — nothing while every run is two lanes wide. */
function cutSizes(runLanes: readonly number[], ribbons: readonly TrailRibbon[], junctions: readonly TrailJunction[]):
Pick<TrailCutShape, 'runLanes' | 'junctionSizes' | 'runEnds'> {
  if (runLanes.every(lanes => lanes === 2)) return {};
  const ends = ribbons.map(ribbon => [ribbon.sections[0].length - 1, ribbon.sections.at(-1)!.length - 1] as [number, number]);
  return {
    runLanes: [...runLanes],
    junctionSizes: junctions.map(junction => ({ vertices: junction.vertices.length, quads: junction.quads.length })),
    ...(ends.some(([head, tail], run) => head !== runLanes[run] || tail !== runLanes[run]) ? { runEnds: ends } : {}),
  };
}

/**
 * Find a trail's ribbons in the document. Null once any vertex or patch it owns is gone, or the patches no longer
 * join its vertices the way its runs and junctions do — something cut into it, and there is nothing left to re-cut.
 */
export function resolveTrail(doc: QuadMeshDoc, trail: AuthoredTrail): OwnedTrail | null {
  const shape = trailCutShape(trail);
  const { runSpans, runPaths, junctionArms } = shape;
  if (!runSpans.length || runSpans.some(spans => !Number.isInteger(spans) || spans < 1) || runPaths.length !== runSpans.length
    || junctionArms.some(arms => !Number.isInteger(arms) || arms < 2)) return null;
  const sizes = shapeSizes(shape);
  if (!sizes || sizes.junctions.length !== junctionArms.length) return null;
  const { runLanes, runStations, junctions } = sizes;
  /** Each span's patches, run by run. */
  const runPatches = runStations.map(stations => stations.slice(1).map((to, i) => trailSpanPatches(stations[i], to)));
  const ribbonVertices = runStations.reduce((sum, stations) => sum + stations.reduce((n, lanes) => n + lanes + 1, 0), 0);
  const ribbonQuads = runPatches.reduce((sum, spans) => sum + spans.reduce((n, patches) => n + patches.length, 0), 0);
  const junctionVertices = junctions.reduce((sum, junction) => sum + junction.vertices, 0);
  const junctionQuads = junctions.reduce((sum, junction) => sum + junction.quads, 0);
  if (trail.vertices.length !== ribbonVertices + junctionVertices || trail.quads.length !== ribbonQuads + junctionQuads) return null;
  const vertexAt = nameIndex(doc.vertexIds), quadAt = nameIndex(doc.quadIds);
  const vertices: number[] = [], quads: number[] = [];
  for (const id of trail.vertices) {
    const index = vertexAt.get(id);
    if (index === undefined) return null;
    vertices.push(index);
  }
  for (const id of trail.quads) {
    const index = quadAt.get(id);
    if (index === undefined) return null;
    quads.push(index);
  }
  let v0 = 0, q0 = 0;
  for (let run = 0; run < runSpans.length; run++) {
    const stations = runStations[run];
    const starts = stations.map((_, i) => v0 + stations.slice(0, i).reduce((n, lanes) => n + lanes + 1, 0));
    for (let i = 0; i < runSpans[run]; i++) {
      for (const { corners } of runPatches[run][i]) {
        if (!sameCorners(doc.quads[quads[q0++]], corners.map(([station, rail]) => vertices[starts[i + station] + rail]))) return null;
      }
    }
    v0 = starts.at(-1)! + stations.at(-1)! + 1;
  }
  // A junction's patches are the trail's own: every corner of them is a vertex the trail owns.
  const mine = new Set(vertices);
  for (let j = q0; j < quads.length; j++) {
    const corners = doc.quads[quads[j]];
    if (!corners || corners.length !== 4 || !corners.every(vertex => mine.has(vertex))) return null;
  }
  return {
    vertices, quads, spans: runSpans.reduce((sum, spans) => sum + spans, 0),
    runSpans: [...runSpans], runPaths: [...runPaths], runLanes: [...runLanes], runStations, junctionArms: [...junctionArms],
  };
}

/** Whether anything other than the trail's own patches uses one of its vertices: a patch welded onto a rim, a
 *  free edge, or a T-junction. A joined trail keeps its layout, because those vertices are shared. */
export function trailIsConnected(doc: QuadMeshDoc, owned: OwnedTrail): boolean {
  const mine = new Set(owned.vertices), ownQuads = new Set(owned.quads);
  for (let quad = 0; quad < doc.quads.length; quad++) {
    if (!ownQuads.has(quad) && doc.quads[quad].some(vertex => mine.has(vertex))) return true;
  }
  if (doc.freeEdges?.some(([a, b]) => mine.has(a) || mine.has(b))) return true;
  return !!doc.tJunctions?.some(node => mine.has(node.vertex) || mine.has(node.edge[0]) || mine.has(node.edge[1]));
}

/** The trail that owns the patch at `quad`, if any. */
export function trailOwningQuad(doc: QuadMeshDoc, trails: readonly AuthoredTrail[] | undefined, quad: number):
AuthoredTrail | undefined {
  const id = doc.quadIds[quad];
  return id === undefined ? undefined : trails?.find(trail => trail.quads.includes(id));
}

const pathQuadsMemo = new WeakMap<AuthoredTrail, string[][] | null>();

/**
 * Each path's own patches, by stable id: its runs' ribbons, and the junction patches carrying its lanes on into every
 * junction it meets — so every patch of the trail is exactly one path's. Null while the trail cannot be found in
 * `doc`. A trail and its names are re-made by every cut, so the answer is kept per trail.
 */
export function trailPathQuads(doc: QuadMeshDoc, trail: AuthoredTrail): string[][] | null {
  if (pathQuadsMemo.has(trail)) return pathQuadsMemo.get(trail)!;
  const owned = resolveTrail(doc, trail);
  let out: string[][] | null = null;
  if (owned) {
    const lists: string[][] = trail.paths.map(() => []);
    // A junction lays each arm's patches together: its lanes carried on, each with a corner on that run's end, and
    // then any between them and the hub, which have none.
    const endRun = new Map<number, number>();
    let v0 = 0, q0 = 0;
    owned.runStations.forEach((stations, run) => {
      const patches = stations.slice(1).reduce((n, to, i) => n + Math.max(stations[i], to), 0);
      for (let j = 0; j < patches; j++) lists[owned.runPaths[run]]?.push(trail.quads[q0 + j]);
      const last = v0 + stations.slice(0, -1).reduce((n, lanes) => n + lanes + 1, 0);
      for (let k = 0; k <= stations[0]; k++) endRun.set(owned.vertices[v0 + k], run);
      for (let k = 0; k <= stations.at(-1)!; k++) endRun.set(owned.vertices[last + k], run);
      v0 = last + stations.at(-1)! + 1; q0 += patches;
    });
    let run: number | undefined;
    for (let j = q0; j < owned.quads.length; j++) {
      run = doc.quads[owned.quads[j]].map(vertex => endRun.get(vertex)).find(found => found !== undefined) ?? run;
      if (run !== undefined) lists[owned.runPaths[run]]?.push(trail.quads[j]);
    }
    out = lists;
  }
  pathQuadsMemo.set(trail, out);
  return out;
}

/** The inside of the trails: live vertex indices, and edges by `undirectedEdgeKey`. */
export interface TrailInterior { vertices: ReadonlySet<number>; edges: ReadonlySet<string> }

const interiorMemo = new WeakMap<QuadMeshDoc, { quads: unknown; trails: unknown; out: TrailInterior }>();

/**
 * The trails' inside edges and vertices, as live indices: an edge every patch on which (two or more) is a trail's,
 * and a vertex every edge and patch round which is. Only its trail moves them, so a click there is better spent on
 * the trail itself; the open rim is not inside, and stays pickable for the welds, bridges and extrusions that join
 * other patches to a trail.
 */
export function trailInterior(doc: QuadMeshDoc): TrailInterior {
  const memo = interiorMemo.get(doc);
  if (memo && memo.quads === doc.quads && memo.trails === doc.trails) return memo.out;
  const at = nameIndex(doc.quadIds), owned = new Set<number>();
  for (const trail of doc.trails ?? []) for (const id of trail.quads) {
    const quad = at.get(id);
    if (quad !== undefined) owned.add(quad);
  }
  const edges = new Set<string>(), vertices = new Set<number>();
  if (owned.size) {
    // Every edge of a trail patch, with how many of its patches are a trail's and how many it has at all.
    const sides = new Map<string, { trail: number; all: number; ends: [number, number] }>();
    for (const quad of owned) for (const [a, b] of liveQuadEdges(doc.quads[quad] ?? [])) {
      const key = undirectedEdgeKey(a, b), side = sides.get(key);
      if (side) side.trail++; else sides.set(key, { trail: 1, all: 0, ends: [a, b] });
    }
    const outside = new Set<number>();
    doc.quads.forEach((corners, quad) => {
      for (const [a, b] of liveQuadEdges(corners)) {
        const side = sides.get(undirectedEdgeKey(a, b));
        if (side) side.all++;
      }
      if (!owned.has(quad)) for (const vertex of corners) outside.add(vertex);
    });
    for (const [a, b] of doc.freeEdges ?? []) { outside.add(a); outside.add(b); }
    for (const [key, side] of sides) {
      if (side.all >= 2 && side.all === side.trail) edges.add(key);
      else for (const vertex of side.ends) outside.add(vertex);
    }
    for (const [key, side] of sides) if (edges.has(key)) for (const vertex of side.ends) if (!outside.has(vertex)) vertices.add(vertex);
  }
  const out = { vertices, edges };
  interiorMemo.set(doc, { quads: doc.quads, trails: doc.trails, out });
  return out;
}

// ---- cutting ---------------------------------------------------------------------------------------------------

const sliceProfile = (profile: TrailKnotProfile | undefined, from: number, to: number): TrailKnotProfile | undefined =>
  profile && Object.fromEntries(Object.entries(profile).map(([key, values]) => [key, values.slice(from, to + 1)]));

/** One run of a network: a stretch of one path between junctions (or its ends), as knots `first`..`last` of it. */
export interface TrailRun { path: number; first: number; last: number }

/** Every run a trail cuts into, in the order its names are kept: each path in turn, split at every junction it runs
 *  through. */
export function trailRunList(trail: Network): TrailRun[] {
  const junctions = junctionPoints(trail);
  const runs: TrailRun[] = [];
  trail.paths.forEach((path, index) => {
    if (!pathCuts(path)) return;
    let first = 0;
    for (let knot = 1; knot < path.points.length; knot++) {
      if (knot === path.points.length - 1 || junctions.has(path.points[knot])) { runs.push({ path: index, first, last: knot }); first = knot; }
    }
  });
  return runs;
}

/**
 * The network's runs as the generator takes them: each a stretch of its path's spline, cut with that path's options,
 * its ends on the junctions they meet (numbered by point). `names` says each run in words, for a refusal.
 */
function trailRuns(trail: AuthoredTrail, held: readonly number[] | null, sets: readonly TrailTileSet[] | undefined):
{ specs: TrailRunSpec[]; names: string[]; runPaths: number[]; runs: TrailRun[] } {
  const junctions = junctionPoints(trail);
  const runs = trailRunList(trail);
  const cutting = trail.paths.filter(pathCuts).length;
  const splines = new Map<number, ReturnType<typeof railBezierSegments>>();
  const specs: TrailRunSpec[] = [], names: string[] = [];
  for (const run of runs) {
    const path = trail.paths[run.path];
    if (!splines.has(run.path)) splines.set(run.path, railBezierSegments(pathKnots(trail, path), path.handles));
    const { knotProfile, ...options } = pathLayoutOptions(trail, path, sets);
    const profile = sliceProfile(knotProfile, run.first, run.last);
    const from = path.points[run.first], to = path.points[run.last];
    // A path's caps close its free ends; an end at a junction carries on into it.
    const caps = path.settings.caps ?? 'none';
    const start = (caps === 'start' || caps === 'both') && run.first === 0 && !junctions.has(from);
    const end = (caps === 'end' || caps === 'both') && run.last === path.points.length - 1 && !junctions.has(to);
    specs.push({
      spline: splines.get(run.path)!.slice(run.first, run.last),
      from: junctions.has(from) ? from : undefined,
      to: junctions.has(to) ? to : undefined,
      options: { ...options, ...(profile ? { knotProfile: profile } : {}), ...(start || end ? { caps: { start, end } } : {}) },
    });
    const whole = run.first === 0 && run.last === path.points.length - 1;
    const which = cutting === 1 ? 'the trail' : `path ${run.path + 1}`;
    names.push(whole ? which : `${which} between points ${from + 1} and ${to + 1}`);
  }
  if (held) specs.forEach((spec, i) => { spec.options = { ...spec.options, spanCount: held[i] }; });
  return { specs, names, runPaths: runs.map(run => run.path), runs };
}

/** A network refusal in the trail's own words: its runs by path and its junctions by point. */
function describeNetworkError(error: string, names: readonly string[]): string {
  const run = (i: string) => names[Number(i)] ?? `run ${i}`;
  return error
    .replace(/\bruns (\d+) and (\d+)/gi, (_, a: string, b: string) => `${run(a)} and ${run(b)}`)
    .replace(/\bRun (\d+)/g, (_, a: string) => run(a).replace(/^[tp]/, letter => letter.toUpperCase()))
    .replace(/\bJunction (\d+)/g, (_, point: string) => `The junction at point ${Number(point) + 1}`)
    .replace(/ \[reach [^\]]*\]$/, '');
}

/** A blank document to cut a trail into on its own: the document's settings, none of its geometry. */
function scratchDoc(doc: QuadMeshDoc): QuadMeshDoc {
  return {
    ...doc, vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0,
    tombstones: undefined, freeEdges: undefined, tJunctions: undefined, edgeHandles: undefined,
    quadPaint: undefined, quadTex: undefined, quadOrient: undefined, quadLocked: undefined,
  };
}

/** A trail cut on its own, in the order it owns things: the standalone mesh, the shape it has, its stations, and where
 *  each of its patches lies (`TrailPatchPlace`, by its index in the mesh). */
type TrailPiece = { doc: QuadMeshDoc; shape: TrailCutShape; layout: TrailLayout; places: TrailPatchPlace[] };

/**
 * Where a patch of a cut lies in its trail, in terms a re-cut keeps (docs/023 · Hand-painted tiles): the path, and the
 * knot SEGMENT of it, from its knot `segment` to the next. A ribbon's patch runs `t0`..`t1` along that segment's cubic,
 * and is `lane` of the `lanes` across its span's wider station from the generator's left rim — a `wedge` where a lane
 * ends or begins. A junction's patch carries on lane `lane` of the `lanes` its arm brings in, the junction standing at
 * the segment's `start` or `end`.
 */
export type TrailPatchPlace = { path: number; segment: number; lane: number; lanes: number }
  & ({ junction?: undefined; t0: number; t1: number; wedge: boolean } | { junction: 'start' | 'end' });

/** Each patch's place in a cut of `runs`, by its index in the cut's mesh: the ribbons' — `trims` saying where each
 *  starts and ends on its run's spline, where junctions cut it back — and then the junctions'. */
function patchPlaces(runs: readonly TrailRun[], ribbons: readonly TrailRibbon[], trims: readonly (TrailSplineTrim | undefined)[],
  junctions: readonly TrailJunction[]): TrailPatchPlace[] {
  const places: TrailPatchPlace[] = [];
  ribbons.forEach((ribbon, r) => {
    const run = runs[r];
    let k = 0;
    ribbon.spans.forEach((span, i) => {
      const from = untrimmedSplinePlace(trims[r], span.sourceSegment, span.sourceT0);
      const to = untrimmedSplinePlace(trims[r], span.sourceSegment, span.sourceT1);
      const patches = trailSpanPatches(ribbon.sections[i].length - 1, ribbon.sections[i + 1].length - 1);
      patches.forEach((patch, lane) => {
        places[ribbon.quads[k++]] = {
          path: run.path, segment: run.first + from.segment, t0: from.t, t1: to.t, lane, lanes: patches.length, wedge: patch.lane === null,
        };
      });
    });
  });
  for (const junction of junctions) junction.quads.forEach((quad, k) => {
    const { run, atHead, lane, of } = junction.lanes[k];
    places[quad] = {
      path: runs[run].path, segment: atHead ? runs[run].first : runs[run].last - 1, lane, lanes: of, junction: atHead ? 'start' : 'end',
    };
  });
  return places;
}

export type TrailCut =
  | { ok: true; doc: QuadMeshDoc; trail: AuthoredTrail; layout: TrailLayout; connected: boolean }
  | { ok: false; error: string };

type PlannedCut =
  | { ok: true; owned: OwnedTrail | null; connected: boolean; piece: TrailPiece }
  | { ok: false; error: string };

const JOINED_SHAPE = 'Other patches are joined to this trail, so its layout is held: it cannot gain or lose a path or a junction.';
const JOINED_LANES = 'Other patches are joined to this trail, so its layout is held: it cannot change how many lanes wide it is.';

/** Cut a trail on its own, as `cutTrail` would cut it into `doc`, without writing anything. */
function planCut(doc: QuadMeshDoc, trail: AuthoredTrail): PlannedCut {
  if (!trail.paths.some(pathCuts)) return { ok: false, error: 'A trail needs a path of at least two points.' };
  const owned = trail.quads.length ? resolveTrail(doc, trail) : null;
  if (trail.quads.length && !owned)
    return { ok: false, error: 'This trail has lost some of its patches, so it can no longer re-cut them. Dissolve it to edit them as mesh.' };
  const connected = owned ? trailIsConnected(doc, owned) : false;
  const scratch = scratchDoc(doc);
  const shape = trailRuns(trail, null, doc.trailTileSets);
  const junctions = junctionPoints(trail);

  // A joined trail keeps its layout, so it keeps its runs and junctions.
  if (connected && (shape.specs.length !== owned!.runSpans.length || junctions.size !== owned!.junctionArms.length
    || shape.runPaths.some((path, i) => path !== owned!.runPaths[i]))) return { ok: false, error: JOINED_SHAPE };
  if (connected && shape.specs.some((spec, i) => (spec.options?.lanes ?? 2) !== owned!.runLanes[i])) return { ok: false, error: JOINED_LANES };
  const runs = connected ? trailRuns(trail, owned!.runSpans, doc.trailTileSets) : shape;

  if (runs.specs.length === 1 && !junctions.size) {
    const ribbon = applyTrailSpline(scratch, runs.specs[0].spline, runs.specs[0].options);
    if (!ribbon.ok) return ribbon;
    return { ok: true, owned, connected, piece: {
      doc: ribbon.doc,
      shape: {
        runSpans: [ribbon.spans.length], runPaths: runs.runPaths, junctionArms: [],
        ...cutSizes(runs.specs.map(spec => spec.options?.lanes ?? 2), [ribbon], []),
      },
      layout: { stations: ribbon.stations, spans: ribbon.spans },
      places: patchPlaces(runs.runs, [ribbon], [undefined], []),
    } };
  }

  const network = applyTrailNetwork(scratch, runs.specs, { minRunLengthM: MIN_RUN_M });
  if (!network.ok) return { ok: false, error: describeNetworkError(network.error, runs.names) };
  return { ok: true, owned, connected, piece: {
    doc: network.doc,
    shape: {
      runSpans: network.runs.map(run => run.spans.length),
      runPaths: runs.runPaths,
      junctionArms: network.junctions.map(junction => junction.runs.length),
      ...cutSizes(runs.specs.map(spec => spec.options?.lanes ?? 2), network.runs, network.junctions),
    },
    layout: { stations: network.runs.flatMap(run => run.stations), spans: network.runs.flatMap(run => run.spans) },
    places: patchPlaces(runs.runs, network.runs, network.trims, network.junctions),
  } };
}

/**
 * The station a cut puts at each knot of path `index` — its section as cut, the bank the automatic law gave it
 * included — or null when the path's spline cannot be laid out. What a point's panel reads its values from. Read
 * off the path as one ribbon: at a junction the junction stands where that station would.
 */
export function trailPathStations(trail: AuthoredTrail, index: number): TrailStation[] | null {
  const path = trail.paths[index];
  if (!path || !pathCuts(path)) return null;
  const layout = layoutTrailSpline(railBezierSegments(pathKnots(trail, path), path.handles), pathLayoutOptions(trail, path));
  if (!layout.ok) return null;
  const { stations, spans } = layout;
  // Knot k starts source cubic k: its station is the first one cut from that cubic or a later one (a cubic too
  // short to measure has none). The last knot ends the ribbon.
  return path.points.map((_, knot) => {
    const span = spans.findIndex(candidate => candidate.sourceSegment >= knot);
    return stations[span < 0 ? stations.length - 1 : span];
  });
}

/** A quad's corners as positions, for telling the same patch in two meshes apart from a different one. */
const quadKey = (vertices: readonly number[], corners: readonly number[]) =>
  corners.map(v => `${vertices[v * 3].toFixed(3)},${vertices[v * 3 + 1].toFixed(3)},${vertices[v * 3 + 2].toFixed(3)}`).join('|');

/**
 * What cutting `trail` into `doc` would lay down that is not there already — the new and the reshaped patches,
 * as a standalone mesh and the patches of it to show. The Create Trail ghost: the next point, the path about to
 * be laid and the junction it makes, before the click that lays it; and the merge a dragged point would make,
 * before the drop. The patches of `also` — trails `trail` would take in — count as already there.
 */
export function trailPreview(doc: QuadMeshDoc, trail: AuthoredTrail, also: readonly AuthoredTrail[] = []):
{ ok: true; doc: QuadMeshDoc; quads: number[] } | { ok: false; error: string } {
  const plan = planCut(doc, trail);
  if (!plan.ok) return plan;
  const { piece, owned } = plan;
  // What stands already: the trail's own patches — and those of `also`, trails it would take in.
  const held = [...(owned?.quads ?? []), ...also.flatMap(other => resolveTrail(doc, other)?.quads ?? [])];
  const standing = new Set(held.map(quad => quadKey(doc.vertices, doc.quads[quad])));
  const quads = piece.doc.quads.flatMap((corners, quad) => standing.has(quadKey(piece.doc.vertices, corners)) ? [] : [quad]);
  return { ok: true, doc: piece.doc, quads };
}

// ---- tiles painted by hand (docs/023 · Hand-painted tiles) -----------------------------------------------------

type Orient = { rot: number; mirror: boolean };

/**
 * A tile on a trail's patch that its cut did not lay — painted, turned or taken off by hand — and where it is: on which
 * trail, at which place (`TrailPatchPlace`), between which two of the trail's points, which find its knot segment again
 * once the trail's paths and points have changed, and in which `slot` of the trail's own patches.
 */
export interface TrailCustomTile {
  trail: string;
  place: TrailPatchPlace;
  ends: [V3, V3];
  slot: number;
  /** The tile and how it is turned; no tile is one taken off. */
  tex: string | null;
  orient: Orient | null;
  /** The patch's ride feel, painted with the tile. */
  surface?: number;
}

/** What a trail's own cut lays on each of its patches, and where each lies: kept per trail — every cut makes a new one
 *  — and per the tile sets and the hold on its layout it was cut under. */
const laidMemo = new WeakMap<AuthoredTrail, {
  sets: unknown; connected: boolean; laid: { tiles: { tex: string | null; orient: Orient | null }[]; places: TrailPatchPlace[] } | null;
}>();

const sameOrient = (a: Orient | null | undefined, b: Orient | null | undefined) =>
  (((a?.rot ?? 0) % 4) + 4) % 4 === (((b?.rot ?? 0) % 4) + 4) % 4 && !!a?.mirror === !!b?.mirror;

/**
 * The tiles on a trail's patches in `doc` that its own cut does not lay there: every patch wearing another tile, the
 * same tile turned or mirrored, or none where the cut lays one. Null when the trail cannot be found in `doc`, or its
 * cut no longer comes out the shape of its patches, so nothing can be told apart.
 */
export function trailCustomTiles(doc: QuadMeshDoc, trail: AuthoredTrail): TrailCustomTile[] | null {
  if (!trail.quads.length) return [];
  const owned = resolveTrail(doc, trail);
  if (!owned) return null;
  const connected = trailIsConnected(doc, owned);
  let memo = laidMemo.get(trail);
  if (!memo || memo.sets !== doc.trailTileSets || memo.connected !== connected) {
    const plan = planCut(doc, trail);
    const local = plan.ok && plan.piece.doc.quads.length === owned.quads.length ? plan.piece : null;
    memo = {
      sets: doc.trailTileSets, connected,
      laid: local && {
        tiles: local.doc.quads.map((_, j) => ({ tex: local.doc.quadTex?.[j] ?? null, orient: local.doc.quadOrient?.[j] ?? null })),
        places: local.places,
      },
    };
    laidMemo.set(trail, memo);
  }
  const { laid } = memo;
  if (!laid) return null;
  const out: TrailCustomTile[] = [];
  owned.quads.forEach((quad, slot) => {
    const tex = doc.quadTex?.[quad] ?? null, orient = doc.quadOrient?.[quad] ?? null, want = laid.tiles[slot];
    if (tex === want.tex && (tex === null || sameOrient(orient, want.orient))) return;
    const place = laid.places[slot], points = trail.paths[place.path].points, surface = doc.quadPaint?.[quad];
    out.push({
      trail: trail.id, place, slot, ends: [copy(trail.points[points[place.segment]]), copy(trail.points[points[place.segment + 1]])],
      tex, orient: tex !== null && orient ? { rot: orient.rot, mirror: orient.mirror } : null,
      ...(surface !== undefined ? { surface } : {}),
    });
  });
  return out;
}

/** A point, to find a knot segment by its two ends. */
const pointKey = (p: readonly number[]) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;

/** Whether two trails run the same paths through the same points: one only moved, reshaped or set differently. */
const sameNetwork = (a: Network, b: Network) => a.points.length === b.points.length && a.paths.length === b.paths.length
  && a.paths.every((path, i) => path.points.length === b.paths[i].points.length && path.points.every((point, k) => point === b.paths[i].points[k]));

type WornTile = { tex: string | null; orient: Orient | null; surface?: number };

/**
 * Where hand-painted tiles go in a new cut of `trail` (`places`), as the tile each patch of it wears, by its index in the
 * cut. Each goes back to its place on its knot segment — found by path and segment while the trail keeps the paths and
 * points of `before`, the trail it was read from, and by the segment's two points once those have changed — on the same
 * lane, or the one as far across where the lanes changed, and on the patch whose stretch of the segment holds the
 * middle of its own. A segment now run the other way turns the tile round with it. A tile whose place is gone — its
 * segment, its junction, its wedge — is let go, and where two land on one patch the nearer keeps it.
 */
function wearCustomTiles(custom: readonly TrailCustomTile[], before: AuthoredTrail | undefined, trail: AuthoredTrail,
  places: readonly TrailPatchPlace[]): Map<number, WornTile> {
  const worn = new Map<number, WornTile & { off: number }>();
  if (!custom.length) return worn;
  const same = !!before && sameNetwork(before, trail);
  const listed = <T>(map: Map<string, T[]>, key: string): T[] => map.get(key) ?? (map.set(key, []), map.get(key)!);
  const segments = new Map<string, { path: number; segment: number }[]>();
  trail.paths.forEach((path, index) => path.points.slice(1).forEach((point, k) => {
    listed(segments, `${pointKey(trail.points[path.points[k]])}>${pointKey(trail.points[point])}`).push({ path: index, segment: k });
  }));
  const onSegment = new Map<string, number[]>();
  places.forEach((place, j) => listed(onSegment, `${place.path}:${place.segment}`).push(j));
  for (const tile of custom) {
    const { place } = tile, own = tile.trail === trail.id;
    let found: { path: number; segment: number } | undefined, turned = false;
    if (same && own) found = { path: place.path, segment: place.segment };
    else {
      const [a, b] = tile.ends.map(pointKey);
      const pick = (list?: { path: number; segment: number }[]) => list?.find(entry => own && entry.path === place.path) ?? list?.[0];
      found = pick(segments.get(`${a}>${b}`));
      if (!found) { found = pick(segments.get(`${b}>${a}`)); turned = !!found; }
    }
    if (!found) continue;
    // Its lane and its stretch of the segment, as the segment runs now.
    const lane = turned ? place.lanes - 1 - place.lane : place.lane;
    const end = place.junction && (turned ? (place.junction === 'start' ? 'end' : 'start') : place.junction);
    const mid = place.junction ? 0 : turned ? 1 - (place.t0 + place.t1) / 2 : (place.t0 + place.t1) / 2;
    let best: { j: number; off: number } | null = null;
    for (const j of onSegment.get(`${found.path}:${found.segment}`) ?? []) {
      const there = places[j];
      let off = 0;
      if (place.junction || there.junction) {
        if (there.junction !== end) continue;
      } else {
        if (there.wedge !== place.wedge || (place.wedge && (turned || there.lanes !== place.lanes))) continue;
        if (mid < there.t0 || mid > there.t1) continue;
        off = Math.abs(mid - (there.t0 + there.t1) / 2);
      }
      if (there.lane !== (there.lanes === place.lanes ? lane : Math.floor(((lane + 0.5) / place.lanes) * there.lanes))) continue;
      if (!best || off < best.off) best = { j, off };
    }
    if (!best || (worn.get(best.j)?.off ?? Infinity) <= best.off) continue;
    const orient = turned && tile.tex !== null ? { rot: ((tile.orient?.rot ?? 0) + 2) % 4, mirror: !!tile.orient?.mirror } : tile.orient;
    worn.set(best.j, { tex: tile.tex, orient, ...(tile.surface !== undefined ? { surface: tile.surface } : {}), off: best.off });
  }
  return worn;
}

export interface TrailCutOptions {
  /**
   * The hand-painted tiles the cut carries on (`trailCustomTiles`) — by default those on the trail's patches in `doc`,
   * read against its record in `doc.trails`. Null, or no record to read them against, cannot tell them apart: the cut
   * then lays its tiles over its patches slot by slot, taking back only a tile set's where it lays none.
   */
  custom?: readonly TrailCustomTile[] | null;
  /** Tiles painted by hand let go of: their patches wear what the cut lays, and the trail's ride feel, again. */
  dropped?: readonly TrailCustomTile[];
}

/**
 * Cut a trail from its paths and settings into `doc`. A trail that owns nothing yet appends fresh ribbons; one that
 * does writes over them slot by slot — the same vertices and patches wherever the new cut has one where the old
 * did, new ones past the end of the old, and what the old had past the end of the new retired. A trail with other
 * patches joined to it is held at its current layout, so it never adds or retires anything. Tiles painted by hand go
 * back to their places on the new cut (`wearCustomTiles`), wherever those are now.
 *
 * Returns the new document and the trail with its ownership updated; neither input is changed.
 */
export function cutTrail(doc: QuadMeshDoc, trail: AuthoredTrail, options: TrailCutOptions = {}): TrailCut {
  const plan = planCut(doc, trail);
  if (!plan.ok) return plan;
  const { owned, connected, piece } = plan;
  const local = piece.doc;
  const oldVertices = owned?.vertices ?? [], oldQuads = owned?.quads ?? [];
  const before = doc.trails?.find(other => other.id === trail.id);
  const custom = options.custom !== undefined ? options.custom : !oldQuads.length ? [] : before ? trailCustomTiles(doc, before) : null;
  const worn = custom && wearCustomTiles(custom, before, trail, piece.places);
  /** The trail's own patches that wore a tile painted by hand: one that wears none now takes the trail's ride feel. */
  const painted = new Set([...custom ?? [], ...options.dropped ?? []].flatMap(tile => tile.trail === trail.id ? [tile.slot] : []));

  // ---- positions: slot by slot over what the trail owns, appended past it ---------------------------------
  const vertices = doc.vertices.slice();
  const vertexSlot: number[] = [];
  for (let v = 0; v < local.vertices.length / 3; v++) {
    const p = [local.vertices[v * 3], local.vertices[v * 3 + 1], local.vertices[v * 3 + 2]];
    const index = v < oldVertices.length ? oldVertices[v] : vertices.length / 3;
    if (index === vertices.length / 3) vertices.push(p[0], p[1], p[2]);
    else { vertices[index * 3] = p[0]; vertices[index * 3 + 1] = p[1]; vertices[index * 3 + 2] = p[2]; }
    vertexSlot.push(index);
  }

  // ---- patches: the same, and the old ones past the new end retired -----------------------------------------
  const quads: (number[] | null)[] = doc.quads.map(quad => quad.slice());
  const lanes: number[] = [];
  let sameTopology = local.quads.length === oldQuads.length && local.vertices.length / 3 === oldVertices.length;
  local.quads.forEach((corners, j) => {
    const mapped = corners.map(v => vertexSlot[v]);
    if (j < oldQuads.length) {
      if (!sameCorners(doc.quads[oldQuads[j]], mapped)) sameTopology = false;
      quads[oldQuads[j]] = mapped; lanes.push(oldQuads[j]);
    } else { lanes.push(quads.length); quads.push(mapped); }
  });
  for (let j = local.quads.length; j < oldQuads.length; j++) quads[oldQuads[j]] = null;

  // ---- shape: every handle on the trail is derived again from the new positions ---------------------------
  // The lock materialised the old cut's effective handles; left in place they would bend the new one to the old
  // one's tangents. Clear them, write the exact centre seams, and let the lock below capture the rest.
  const edgeHandles = { ...(doc.edgeHandles ?? {}) };
  for (const quad of oldQuads) for (const [a, b] of liveQuadEdges(doc.quads[quad])) {
    delete edgeHandles[`${a}>${b}`]; delete edgeHandles[`${b}>${a}`];
  }
  for (const [key, offset] of Object.entries(local.edgeHandles ?? {})) {
    const [a, b] = key.split('>').map(Number);
    edgeHandles[`${vertexSlot[a]}>${vertexSlot[b]}`] = [offset[0], offset[1], offset[2]];
  }

  // The trail's ride feel is its patches' — one not painted by hand.
  const plain = oldQuads.find((_, j) => !painted.has(j)) ?? oldQuads[0];
  const surface = (plain === undefined ? undefined : doc.quadPaint?.[plain]) ?? MESA_TRAIL_DEFAULTS.surface;
  const quadPaint = { ...(doc.quadPaint ?? {}) };
  const quadTex = { ...(doc.quadTex ?? {}) }, quadOrient = { ...(doc.quadOrient ?? {}) };
  const quadLocked = { ...(doc.quadLocked ?? {}) };
  const laid = trailTileSetTiles(trailTileSetsWith(doc.trailTileSets));
  lanes.forEach((quad, j) => {
    const own = worn?.get(j), tile = local.quadTex?.[j];
    if (own) {
      quadPaint[quad] = own.surface ?? surface;
      if (own.tex === null) { delete quadTex[quad]; delete quadOrient[quad]; } else {
        quadTex[quad] = own.tex;
        if (own.orient) quadOrient[quad] = { ...own.orient }; else delete quadOrient[quad];
      }
    } else {
      if (j >= oldQuads.length || painted.has(j)) quadPaint[quad] = surface;
      if (tile) { quadTex[quad] = tile; quadOrient[quad] = { ...(local.quadOrient?.[j] ?? { rot: 0, mirror: false }) }; }
      // No tile here now. Where the tiles painted by hand are known, nothing else is left here; where they are not, take
      // back only what a tile set lays, so a tile painted by hand stays.
      else if (worn || (quadTex[quad] && laid.has(quadTex[quad]))) { delete quadTex[quad]; delete quadOrient[quad]; }
    }
    delete quadLocked[quad];
  });

  // ---- write it: in place when the topology stands, through the shared compactor when it does not ---------
  let out: QuadMeshDoc;
  let vertexAt: (raw: number) => number, quadAt: (raw: number) => number;
  if (owned && sameTopology) {
    out = { ...doc, vertices, quads: quads as number[][] };
    assignMap(out, 'edgeHandles', edgeHandles);
    assignMap(out, 'quadPaint', quadPaint);
    assignMap(out, 'quadTex', Object.keys(quadTex).length ? quadTex : undefined);
    assignMap(out, 'quadOrient', Object.keys(quadOrient).length ? quadOrient : undefined);
    assignMap(out, 'quadLocked', Object.keys(quadLocked).length ? quadLocked : undefined);
    vertexAt = raw => raw; quadAt = raw => raw;
  } else {
    const rewrite = finishMeshRewrite(doc, {
      vertices, quads,
      keepVertices: looseVertexIds(doc),
      freeEdges: doc.freeEdges?.map(edge => [edge[0], edge[1]] as [number, number]),
      tJunctions: doc.tJunctions,
      edgeHandles, quadPaint, quadTex, quadOrient, quadLocked,
      quadTwist: doc.quadTwist ? { ...doc.quadTwist } : undefined,
      quadLabels: doc.quadLabels ? Object.fromEntries(Object.entries(doc.quadLabels).map(([quad, labels]) => [quad, [...labels]])) : undefined,
    });
    out = rewrite.doc;
    vertexAt = raw => rewrite.vertexMap.get(rewrite.rawVertexIds[raw]!)!;
    const compacted: number[] = [];
    let next = 0;
    for (const quad of quads) compacted.push(quad ? next++ : -1);
    quadAt = raw => compacted[raw];
  }

  const ownQuads = lanes.map(quadAt);
  setQuadsLocked(out, ownQuads, true);
  const next: AuthoredTrail = {
    ...trail,
    points: trail.points.map(copy),
    vertices: vertexSlot.map(vertexAt).map(vertex => out.vertexIds[vertex]),
    quads: ownQuads.map(quad => out.quadIds[quad]),
  };
  const { shape } = piece;
  if (shape.runSpans.length > 1 || shape.junctionArms.length || shape.runPaths[0] !== 0 || shape.runLanes) next.network = shape;
  else delete next.network;
  return { ok: true, doc: out, trail: next, layout: piece.layout, connected };
}

/** Take a trail's patches out of the mesh. Vertices other patches still use stay, with them. */
export function removeTrailPatches(doc: QuadMeshDoc, trail: AuthoredTrail): QuadMeshDoc {
  const owned = resolveTrail(doc, trail);
  const quadAt = nameIndex(doc.quadIds);
  const gone = new Set(owned?.quads ?? trail.quads.map(id => quadAt.get(id)).filter((quad): quad is number => quad !== undefined));
  if (!gone.size) return doc;
  return finishMeshRewrite(doc, {
    vertices: doc.vertices.slice(),
    quads: doc.quads.map((quad, i) => gone.has(i) ? null : quad.slice()),
    keepVertices: looseVertexIds(doc),
    freeEdges: doc.freeEdges?.map(edge => [edge[0], edge[1]] as [number, number]),
    tJunctions: doc.tJunctions,
    edgeHandles: doc.edgeHandles ? { ...doc.edgeHandles } : undefined,
    quadPaint: doc.quadPaint ? { ...doc.quadPaint } : undefined,
    quadTex: doc.quadTex ? { ...doc.quadTex } : undefined,
    quadOrient: doc.quadOrient ? { ...doc.quadOrient } : undefined,
    quadLocked: doc.quadLocked ? { ...doc.quadLocked } : undefined,
    quadTwist: doc.quadTwist ? { ...doc.quadTwist } : undefined,
    quadLabels: doc.quadLabels ? Object.fromEntries(Object.entries(doc.quadLabels).map(([quad, labels]) => [quad, [...labels]])) : undefined,
  }).doc;
}
