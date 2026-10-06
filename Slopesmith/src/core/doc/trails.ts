import type { AuthoredTrail, PathHandles, TrailCutShape, TrailKnotSettings, TrailPath, TrailSettings, V3 } from './types';

/**
 * Trails saved before networks (docs/023 · Networks), brought forward on load.
 *
 * A trail used to be one spline of knots with BRANCHES hung off its knots — a branch leaving one knot, perhaps
 * rejoining another — cut with the trail's settings. Now every path of a network is alike, so the old trail is the
 * network's first path, each branch a path of its own through the knots it left and rejoined, and every branch
 * takes a copy of the trail's settings. The paths are laid out in the order the old trail cut its runs and
 * junctions, so the names it owns divide up exactly as before and its next cut lands on the same patches.
 */

interface LegacyBranch { knot: number; knots: V3[]; to?: number }

interface LegacyTrail {
  id: string;
  name?: string;
  knots: V3[];
  handles?: (PathHandles | null)[];
  settings: TrailSettings;
  knotSettings?: (TrailKnotSettings | null)[];
  branches?: LegacyBranch[];
  vertices: string[];
  quads: string[];
  network?: { runSpans: number[]; junctions: number };
}

const isLegacy = (trail: unknown): trail is LegacyTrail =>
  !!trail && typeof trail === 'object' && Array.isArray((trail as LegacyTrail).knots) && !Array.isArray((trail as AuthoredTrail).paths);

/** The old trail's branches as its last cut saw them: the first leaving each knot, in knot order, each rejoining a
 *  knot no other branch ends on — a branch with neither knots nor a rejoin is none. */
function legacyBranches(trail: LegacyTrail): LegacyBranch[] {
  const n = trail.knots.length;
  const onTrail = (knot: number | undefined): knot is number => Number.isInteger(knot) && knot! >= 0 && knot! < n;
  const leaving = new Map<number, LegacyBranch>();
  for (const branch of trail.branches ?? []) if (onTrail(branch.knot) && !leaving.has(branch.knot)) leaving.set(branch.knot, branch);
  const used = new Set(leaving.keys());
  const out: LegacyBranch[] = [];
  for (const branch of [...leaving.values()].sort((a, b) => a.knot - b.knot)) {
    const rejoins = onTrail(branch.to) && branch.to !== branch.knot && !used.has(branch.to);
    if (rejoins) used.add(branch.to!);
    if (branch.knots.length || rejoins) out.push({ knot: branch.knot, knots: branch.knots, ...(rejoins ? { to: branch.to } : {}) });
  }
  return out;
}

/** One old trail as a network: its knots, then each branch's, as points; the trail and each branch as paths. */
export function migrateLegacyTrail(old: LegacyTrail): AuthoredTrail {
  const copy = (p: readonly number[]): V3 => [p[0], p[1], p[2]];
  const points: V3[] = old.knots.map(copy);
  const main: TrailPath = { points: old.knots.map((_, i) => i), settings: { ...old.settings } };
  if (old.handles?.some(Boolean)) main.handles = old.handles.slice(0, old.knots.length).map(entry => entry ?? null);
  const paths: TrailPath[] = [main];
  const branches = legacyBranches(old);
  for (const branch of branches) {
    const own = branch.knots.map(knot => points.push(copy(knot)) - 1);
    paths.push({ points: [branch.knot, ...own, ...(branch.to !== undefined ? [branch.to] : [])], settings: { ...old.settings } });
  }
  const trail: AuthoredTrail = { id: old.id, points, paths, vertices: [...old.vertices], quads: [...old.quads] };
  if (old.name !== undefined) trail.name = old.name;
  if (old.knotSettings?.some(Boolean)) trail.pointSettings = old.knotSettings.slice(0, old.knots.length).map(entry => entry ?? null);
  if (old.network?.junctions) {
    // The old cut's runs: the trail split at every middle knot a branch ends on, then each branch, in order —
    // and its junctions in the order those runs first reached them, which is how it wrote their names.
    const ends = [...new Set(branches.flatMap(branch => branch.to === undefined ? [branch.knot] : [branch.knot, branch.to]))].sort((a, b) => a - b);
    const last = old.knots.length - 1;
    const cuts = [0, ...ends.filter(knot => knot > 0 && knot < last), last];
    const node = (knot: number | undefined) => knot !== undefined && ends.includes(knot) ? knot : undefined;
    const runs: [number | undefined, number | undefined][] = [];
    for (let i = 0; i + 1 < cuts.length; i++) runs.push([node(cuts[i]), node(cuts[i + 1])]);
    for (const branch of branches) runs.push([branch.knot, branch.to]);
    const seen: number[] = [];
    for (const [from, to] of runs) for (const at of [from, to]) if (at !== undefined && !seen.includes(at)) seen.push(at);
    // A knot in the trail's middle meets three arms; one of its ends, two.
    const shape: TrailCutShape = {
      runSpans: [...old.network.runSpans],
      runPaths: [...cuts.slice(1).map(() => 0), ...branches.map((_, b) => b + 1)],
      junctionArms: seen.map(knot => knot > 0 && knot < last ? 3 : 2),
    };
    trail.network = shape;
  }
  return trail;
}

/** Bring every trail of a loaded document up to the network form; one already in it passes through. */
export function normalizeTrails(trails: unknown[] | undefined): AuthoredTrail[] | undefined {
  return trails?.map(trail => isLegacy(trail) ? migrateLegacyTrail(trail) : trail as AuthoredTrail);
}
