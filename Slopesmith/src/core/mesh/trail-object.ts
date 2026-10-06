import type { AuthoredTrail, PathHandles, QuadMeshDoc, TrailBranch, TrailKnotSettings, TrailSettings, V3 } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { railBezierSegments } from '../rails/rails';
import { setQuadsLocked } from './locks';
import { assignMap, finishMeshRewrite, looseVertexIds } from './ops/contract';
import { liveQuadEdges } from './primitives';
import {
  applyTrailNetwork, applyTrailSpline, layoutTrailSpline, MESA_TRAIL_DEFAULTS, MESA_TRAIL_TEXTURES,
  type TrailKnotProfile, type TrailLayout, type TrailLayoutOptions, type TrailRunSpec, type TrailStation,
} from './trail';

/**
 * Owned trails (docs/023 "Track: a rail that owns terrain"): a centre spline that keeps the ribbon it generated.
 *
 * The ribbon is ordinary mesh — three rails of vertices, two patches per span — and the trail names it by stable
 * id, so it survives every renumbering a topology op does elsewhere. `cutTrail` is the one generator: it lays the
 * spline out with the Create Trail law and writes the result over the vertices and patches the trail already
 * owns, appending or retiring only the stations a longer or shorter ribbon needs. Everything it owns is locked,
 * which keeps hand edits off it, and every Bézier handle on its edges is re-derived from the new positions.
 *
 * Patches joined onto the ribbon (a Weld Loops seam, a retopologised mountain) share its rim vertices. A re-cut
 * moves those vertices, so the joined patches stretch with the trail — and so a joined trail must keep its patch
 * count, which `cutTrail` enforces by asking the layout for exactly the spans it already has.
 *
 * A trail with BRANCHES is a small network (`applyTrailNetwork`): the trail split at each branch knot, plus each
 * branch, every one a run of its own, meeting in a six-patch fan around a valence-6 hub at each branch knot.
 * Whatever the shape, the cut is made standalone first (a `piece`) and then written over what the trail owns
 * slot by slot, so a re-cut that keeps the shape keeps every name.
 */

/** A new trail's settings: the measured Mesa section the Create Trail tool has always started from. */
export const TRAIL_SETTINGS_DEFAULTS: Readonly<TrailSettings> = {
  widthM: MESA_TRAIL_DEFAULTS.widthM,
  centerBias: MESA_TRAIL_DEFAULTS.centerBias,
  dishPercent: 10.5, // MESA_TRAIL_DEFAULTS.dishFraction as a percentage, written out so it is exact
  patchLengthM: MESA_TRAIL_DEFAULTS.maxPatchLengthM,
  maxTurnDegrees: MESA_TRAIL_DEFAULTS.maxTurnDegrees,
  bankGainM: MESA_TRAIL_DEFAULTS.bankGainM,
  maxBankDegrees: MESA_TRAIL_DEFAULTS.maxBankDegrees,
  mesaTextures: true,
};

export type TrailKnotSettingsList = readonly (TrailKnotSettings | null | undefined)[] | undefined;

/**
 * The knot profile a trail's own knot values stand for (docs/023 · Per-knot section), one entry per knot. A knot
 * without its own value takes the trail's, so a value set on one knot eases back to the trail's at its
 * neighbours. Only the values some knot sets are passed on: a trail whose knots set nothing cuts exactly as
 * it did before knots could.
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

/** A knot's own values with `key` set, or cleared when `value` is undefined — an entry left empty is dropped,
 *  and so are empty entries trailing off the end. */
export function setTrailKnotValue<K extends keyof TrailKnotSettings>(list: TrailKnotSettingsList, knots: number,
  knot: number, key: K, value: TrailKnotSettings[K] | undefined): (TrailKnotSettings | null)[] {
  const out = Array.from({ length: knots }, (_, i) => list?.[i] ? { ...list[i] } : null);
  if (knot < 0 || knot >= knots) return trimKnotSettings(out);
  const entry: TrailKnotSettings = { ...(out[knot] ?? {}) };
  if (value === undefined) delete entry[key]; else entry[key] = value;
  out[knot] = Object.keys(entry).length ? entry : null;
  return trimKnotSettings(out);
}

/** The knot values once knot `knot` is deleted, so every later knot keeps its own. */
export function withoutTrailKnot(list: TrailKnotSettingsList, knot: number): (TrailKnotSettings | null)[] {
  return trimKnotSettings((list ?? []).filter((_, i) => i !== knot).map(entry => entry ?? null));
}

function trimKnotSettings(list: (TrailKnotSettings | null)[]): (TrailKnotSettings | null)[] {
  let end = list.length;
  while (end > 0 && !list[end - 1]) end--;
  return list.slice(0, end);
}

/** The generator options a trail's settings stand for, with its knots' own values when it has any. */
export function trailLayoutOptions(settings: TrailSettings, knotSettings?: TrailKnotSettingsList, knots = 0):
TrailLayoutOptions {
  const knotProfile = trailKnotProfile(settings, knotSettings, knots);
  return {
    ...(knotProfile ? { knotProfile } : {}),
    widthM: settings.widthM,
    centerBias: settings.centerBias,
    dishFraction: settings.dishPercent / 100,
    maxPatchLengthM: settings.patchLengthM,
    minPatchLengthM: Math.min(MESA_TRAIL_DEFAULTS.minPatchLengthM, settings.patchLengthM * 0.45),
    maxTurnDegrees: settings.maxTurnDegrees,
    bankGainM: settings.bankGainM,
    maxBankDegrees: settings.maxBankDegrees,
    maxBankStepDegrees: MESA_TRAIL_DEFAULTS.maxBankStepDegrees,
    surface: MESA_TRAIL_DEFAULTS.surface,
    textures: settings.mesaTextures ? MESA_TRAIL_TEXTURES : undefined,
  };
}

/** The shortest run a junction may leave between itself and the next junction or the trail's end. */
const MIN_RUN_M = 2;

/** Every tile the Mesa preset can lay — the ones a trail may take back off its own patches. */
const MESA_TILES = new Set([
  ...MESA_TRAIL_TEXTURES.standard.flat(),
  ...(MESA_TRAIL_TEXTURES.tight ?? []).flat(),
]);

/** Where a trail's owned geometry is now, as indices into the current document. */
export interface OwnedTrail {
  /** Run by run, three per station (left rim, centre seam, right rim); then four per junction. */
  vertices: number[];
  /** Run by run, two per span (left lane, right lane); then six per junction fan. */
  quads: number[];
  /** Spans in every run together. */
  spans: number;
  /** Spans per run, in cut order. */
  runSpans: number[];
  junctions: number;
}

const sameCorners = (corners: readonly number[] | undefined, want: readonly number[]) =>
  !!corners && corners.length === 4 && corners.every((vertex, i) => vertex === want[i]);

/** How a trail's owned names divide up: its stored network shape, or one run of all its patches. */
const cutShapeOf = (trail: AuthoredTrail) => trail.network ?? { runSpans: [trail.quads.length / 2], junctions: 0 };

/**
 * Find a trail's ribbon in the document. Null once any vertex or patch it owns is gone, or the patches no longer
 * join its vertices the way its runs and junctions do — something cut into it, and there is no longer a ribbon to
 * re-cut.
 */
export function resolveTrail(doc: QuadMeshDoc, trail: AuthoredTrail): OwnedTrail | null {
  const { runSpans, junctions } = cutShapeOf(trail);
  if (!runSpans.length || runSpans.some(spans => !Number.isInteger(spans) || spans < 1)
    || !Number.isInteger(junctions) || junctions < 0) return null;
  const ribbonVertices = runSpans.reduce((sum, spans) => sum + (spans + 1) * 3, 0);
  const ribbonQuads = runSpans.reduce((sum, spans) => sum + spans * 2, 0);
  if (trail.vertices.length !== ribbonVertices + junctions * 4 || trail.quads.length !== ribbonQuads + junctions * 6) return null;
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
  for (const spans of runSpans) {
    for (let i = 0; i < spans; i++) {
      const [l0, c0, r0, l1, c1, r1] = vertices.slice(v0 + i * 3, v0 + i * 3 + 6);
      if (!sameCorners(doc.quads[quads[q0 + i * 2]], [l0, c0, l1, c1]) || !sameCorners(doc.quads[quads[q0 + i * 2 + 1]], [c0, r0, c1, r1]))
        return null;
    }
    v0 += (spans + 1) * 3; q0 += spans * 2;
  }
  // A junction fan is the trail's own: every corner of its patches is a vertex the trail owns.
  const mine = new Set(vertices);
  for (let j = q0; j < quads.length; j++) {
    const corners = doc.quads[quads[j]];
    if (!corners || corners.length !== 4 || !corners.every(vertex => mine.has(vertex))) return null;
  }
  return { vertices, quads, spans: ribbonQuads / 2, runSpans: [...runSpans], junctions };
}

/** Whether anything other than the trail's own patches uses one of its vertices: a patch welded onto a rim, a
 *  free edge, or a T-junction. A joined trail keeps its topology, because those vertices are shared. */
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

// ---- branches -------------------------------------------------------------------------------------------------

/**
 * A trail's branches that cut, in knot order: each leaving one of its knots, the first per knot, and rejoining one
 * (`to`) only where no other branch leaves or rejoins it — a trail knot is an end of one branch at most. A
 * rejoin that does not hold is dropped, leaving the branch free-ended; a branch with neither knots of its own nor
 * a rejoin is no branch.
 */
export function trailBranches(trail: Pick<AuthoredTrail, 'knots' | 'branches'>): TrailBranch[] {
  const n = trail.knots.length;
  const onTrail = (knot: number | undefined): knot is number => Number.isInteger(knot) && knot! >= 0 && knot! < n;
  const leaving = new Map<number, TrailBranch>();
  for (const branch of trail.branches ?? []) if (onTrail(branch.knot) && !leaving.has(branch.knot)) leaving.set(branch.knot, branch);
  const used = new Set(leaving.keys());
  const out: TrailBranch[] = [];
  for (const branch of [...leaving.values()].sort((a, b) => a.knot - b.knot)) {
    const rejoins = onTrail(branch.to) && branch.to !== branch.knot && !used.has(branch.to);
    if (rejoins) used.add(branch.to!);
    const kept: TrailBranch = { knot: branch.knot, knots: branch.knots, ...(rejoins ? { to: branch.to } : {}) };
    if (kept.knots.length || kept.to !== undefined) out.push(kept);
  }
  return out;
}

/** Every trail knot a branch leaves or rejoins: the knots that carry a junction, and can take no other branch. */
export function branchEndpoints(trail: Pick<AuthoredTrail, 'knots' | 'branches'>): Set<number> {
  return new Set(trailBranches(trail).flatMap(branch => branch.to === undefined ? [branch.knot] : [branch.knot, branch.to]));
}

/** A branch moved along by `by` trail knots, its rejoin with it. */
const shiftBranch = (branch: TrailBranch, by: number): TrailBranch =>
  ({ ...branch, knot: branch.knot + by, ...(branch.to !== undefined ? { to: branch.to + by } : {}) });

/** Every knot a trail shows, in one list: its own, then each branch's in `branches` order. A knot is picked,
 *  moved and deleted by its place in this list. */
export function trailAllKnots(trail: Pick<AuthoredTrail, 'knots' | 'branches'>): V3[] {
  return [...trail.knots, ...(trail.branches ?? []).flatMap(branch => branch.knots)];
}

/** Which knot a place in `trailAllKnots` is: the trail's own (`branch` null) or one of a branch's. */
export function trailKnotRef(trail: Pick<AuthoredTrail, 'knots' | 'branches'>, at: number):
{ branch: number | null; knot: number } | null {
  if (!Number.isInteger(at) || at < 0) return null;
  if (at < trail.knots.length) return { branch: null, knot: at };
  let rest = at - trail.knots.length;
  for (const [branch, entry] of (trail.branches ?? []).entries()) {
    if (rest < entry.knots.length) return { branch, knot: rest };
    rest -= entry.knots.length;
  }
  return null;
}

/** The place in `trailAllKnots` of a branch's knot (or, with `branch` null, the trail's own). */
export function trailKnotPlace(trail: Pick<AuthoredTrail, 'knots' | 'branches'>, branch: number | null, knot: number): number {
  if (branch === null) return knot;
  return trail.knots.length + (trail.branches ?? []).slice(0, branch).reduce((sum, entry) => sum + entry.knots.length, 0) + knot;
}

/** The branches once trail knot `knot` is deleted: the branch leaving it goes, one rejoining it is left free-ended
 *  (or goes, with no knots of its own), and the rest follow their knots down. */
export function branchesWithoutKnot(branches: readonly TrailBranch[] | undefined, knot: number): TrailBranch[] {
  return (branches ?? []).filter(branch => branch.knot !== knot).flatMap(branch => {
    const next: TrailBranch = { ...branch, knot: branch.knot > knot ? branch.knot - 1 : branch.knot };
    if (branch.to === knot) delete next.to;
    else if (branch.to !== undefined && branch.to > knot) next.to = branch.to - 1;
    return next.knots.length || next.to !== undefined ? [next] : [];
  });
}

/** The branches once a knot is put in at `knot`, ahead of the one there: every branch end from there on moves up. */
export function branchesWithKnotAt(branches: readonly TrailBranch[] | undefined, knot: number): TrailBranch[] {
  return (branches ?? []).map(branch => ({
    ...branch,
    knot: branch.knot >= knot ? branch.knot + 1 : branch.knot,
    ...(branch.to !== undefined ? { to: branch.to >= knot ? branch.to + 1 : branch.to } : {}),
  }));
}

// ---- merging (docs/023 · Merging) -----------------------------------------------------------------------------

/**
 * The trail run the other way: knots, handles (each knot's in and out swap), knot values (the centre seam and a
 * fixed bank are measured across the direction of travel, so they mirror) and branches all reversed. The same
 * ground, described from the other end.
 */
export function reverseTrail(trail: AuthoredTrail): AuthoredTrail {
  const n = trail.knots.length;
  const at = <T>(list: readonly (T | null | undefined)[] | undefined, i: number): T | null => list?.[n - 1 - i] ?? null;
  const handles = trail.knots.map((_, i) => {
    const own = at(trail.handles, i);
    return own ? { ...(own.out ? { in: own.out } : {}), ...(own.in ? { out: own.in } : {}) } as PathHandles : null;
  });
  const knotSettings = trail.knotSettings && trail.knots.map((_, i) => {
    const own = at(trail.knotSettings, i);
    if (!own) return null;
    const mirrored: TrailKnotSettings = { ...own };
    if (own.centerBias !== undefined) mirrored.centerBias = 1 - own.centerBias;
    if (own.bankDegrees !== undefined) mirrored.bankDegrees = -own.bankDegrees;
    return mirrored;
  });
  const next: AuthoredTrail = {
    ...trail,
    knots: [...trail.knots].reverse().map(p => [p[0], p[1], p[2]] as V3),
    settings: { ...trail.settings, centerBias: 1 - trail.settings.centerBias },
  };
  if (handles.some(Boolean)) next.handles = handles; else delete next.handles;
  if (knotSettings?.some(Boolean)) next.knotSettings = knotSettings; else delete next.knotSettings;
  if (trail.branches?.length) next.branches = trail.branches.map(branch => ({
    ...branch, knot: n - 1 - branch.knot, ...(branch.to !== undefined ? { to: n - 1 - branch.to } : {}),
  })).sort((a, b) => a.knot - b.knot);
  return next;
}

/** A trail's own section written onto its knots wherever it differs from `settings`, so the knots keep their look
 *  once they are cut with another trail's settings. A knot's own value stays. */
function carrySection(trail: AuthoredTrail, settings: TrailSettings): (TrailKnotSettings | null)[] {
  const differs = (key: 'widthM' | 'centerBias' | 'dishPercent') => trail.settings[key] !== settings[key];
  return trail.knots.map((_, i) => {
    const own: TrailKnotSettings = { ...(trail.knotSettings?.[i] ?? {}) };
    for (const key of ['widthM', 'centerBias', 'dishPercent'] as const)
      if (own[key] === undefined && differs(key)) own[key] = trail.settings[key];
    return Object.keys(own).length ? own : null;
  });
}

export type TrailMerge =
  | { ok: true; trail: AuthoredTrail; joined: 'ends' | 'branch' | 'rejoin' | 'extend' }
  | { ok: false; error: string };

/**
 * Merge `other` into `target` where one of `other`'s ends (`otherEnd`) lies on `target`'s knot `knot`: one trail
 * after, `target`'s, with its id, settings and patches to re-cut.
 *
 * On one of `target`'s ENDS the two join end to end into one trail through that knot; `other`'s knots keep their
 * section as their own values where its settings differ, and keep their handles, values and branches. On a MIDDLE
 * knot `other` becomes the branch leaving it — a three-way junction — and takes `target`'s settings, since a
 * branch has none of its own. The shared knot is `target`'s.
 */
export function mergeTrailInto(target: AuthoredTrail, knot: number, other: AuthoredTrail, otherEnd: 'start' | 'end'): TrailMerge {
  const n = target.knots.length;
  if (!Number.isInteger(knot) || knot < 0 || knot >= n) return { ok: false, error: 'That knot is not on the trail.' };
  if (other.knots.length < 2) return { ok: false, error: 'A trail needs two knots to join another.' };
  // `other` facing away from the shared knot: its merging end first.
  const away = otherEnd === 'start' ? other : reverseTrail(other);
  const m = away.knots.length;

  if (knot !== 0 && knot !== n - 1) {
    if (away.branches?.length) return { ok: false, error: 'A trail with branches of its own cannot become a branch.' };
    if (branchEndpoints(target).has(knot)) return { ok: false, error: 'That knot already carries a branch.' };
    const branch: TrailBranch = { knot, knots: away.knots.slice(1).map(p => [p[0], p[1], p[2]] as V3) };
    return { ok: true, joined: 'branch', trail: { ...target, branches: [...(target.branches ?? []), branch].sort((a, b) => a.knot - b.knot) } };
  }

  // End to end: `other` laid on past the shared knot, which is `target`'s — or, at `target`'s start, ahead of it.
  const atEnd = knot === n - 1;
  const facing = atEnd ? away : reverseTrail(away); // atEnd: away from the shared knot; at the start: toward it
  const section = carrySection(facing, target.settings);
  const pad = <T>(list: readonly (T | null | undefined)[] | undefined, length: number): (T | null)[] =>
    Array.from({ length }, (_, i) => list?.[i] ?? null);
  if (branchEndpoints(target).has(knot) && branchEndpoints(atEnd ? away : facing).has(atEnd ? 0 : m - 1))
    return { ok: false, error: 'Both trails carry a branch on the knot they would share.' };
  let knots: V3[], handles: (PathHandles | null)[], knotSettings: (TrailKnotSettings | null)[], branches: TrailBranch[];
  if (atEnd) {
    knots = [...target.knots, ...facing.knots.slice(1)];
    handles = [...pad(target.handles, n), ...pad(facing.handles, m).slice(1)];
    knotSettings = [...pad(target.knotSettings, n), ...section.slice(1)];
    branches = [...(target.branches ?? []), ...(facing.branches ?? []).map(b => shiftBranch(b, n - 1))];
  } else {
    knots = [...facing.knots.slice(0, -1), ...target.knots];
    handles = [...pad(facing.handles, m).slice(0, -1), ...pad(target.handles, n)];
    knotSettings = [...section.slice(0, -1), ...pad(target.knotSettings, n)];
    branches = [...(facing.branches ?? []), ...(target.branches ?? []).map(b => shiftBranch(b, m - 1))];
  }
  const trail: AuthoredTrail = { ...target, knots: knots.map(p => [p[0], p[1], p[2]] as V3) };
  if (handles.some(Boolean)) trail.handles = handles; else delete trail.handles;
  if (knotSettings.some(Boolean)) trail.knotSettings = knotSettings; else delete trail.knotSettings;
  if (branches.length) trail.branches = branches.sort((a, b) => a.knot - b.knot); else delete trail.branches;
  return { ok: true, joined: 'ends', trail };
}

/**
 * Land the free tip of `trail`'s branch `branch` — its last knot, laid exactly on the knot `target` names — there:
 *
 * - on a knot of the trail itself, the branch REJOINS it: its far end becomes that knot (`to`), a second junction,
 *   and the tip, which stood on it, goes;
 * - on an END of another trail, that trail goes on as the rest of the branch, from the shared knot out — a branch
 *   carries no settings, handles or branches of its own, so it takes the trail's, and one with branches is refused.
 *
 * A branch tip on another trail's middle knot would be a branch of a branch, which a trail cannot hold yet.
 */
export function joinBranch(trail: AuthoredTrail, branch: number, target: { trail: AuthoredTrail; knot: number }): TrailMerge {
  const entry = trail.branches?.[branch];
  if (!entry?.knots.length || entry.to !== undefined) return { ok: false, error: 'That branch has no free end to join.' };
  const replace = (next: TrailBranch): AuthoredTrail =>
    ({ ...trail, branches: trail.branches!.map((other, b) => b === branch ? next : other) });
  if (target.trail.id === trail.id) {
    if (target.knot === entry.knot) return { ok: false, error: 'A branch cannot rejoin the knot it leaves.' };
    if (branchEndpoints(trail).has(target.knot)) return { ok: false, error: 'That knot already carries a branch.' };
    return { ok: true, joined: 'rejoin', trail: replace({ ...entry, knots: entry.knots.slice(0, -1), to: target.knot }) };
  }
  const other = target.trail, last = other.knots.length - 1;
  if (target.knot !== 0 && target.knot !== last)
    return { ok: false, error: 'A branch can join the end of another trail, or a knot of its own trail — not another trail\'s middle.' };
  if (other.branches?.length) return { ok: false, error: 'A trail with branches of its own cannot become part of a branch.' };
  const onward = target.knot === 0 ? other.knots : [...other.knots].reverse();
  return { ok: true, joined: 'extend', trail: replace({ ...entry, knots: [...entry.knots, ...onward.slice(1).map(p => [p[0], p[1], p[2]] as V3)] }) };
}

const sliceProfile = (profile: TrailKnotProfile | undefined, from: number, to: number): TrailKnotProfile | undefined =>
  profile && Object.fromEntries(Object.entries(profile).map(([key, values]) => [key, values.slice(from, to + 1)]));

/**
 * A branched trail's runs, in the order its names are kept: the trail split at every middle knot a branch leaves or
 * rejoins, then each branch. Junction `i` is the `i`th such knot in order (`knots`); a branch end on an end knot
 * meets the end of the trail there without splitting it. `names` says each run in words, for a refusal.
 */
function trailRuns(trail: AuthoredTrail, held: readonly number[] | null): { specs: TrailRunSpec[]; names: string[]; knots: number[] } {
  const n = trail.knots.length;
  const main = railBezierSegments(trail.knots, trail.handles);
  const profile = trailKnotProfile(trail.settings, trail.knotSettings, n);
  const branches = trailBranches(trail);
  const junctions = [...branchEndpoints(trail)].sort((a, b) => a - b);
  const nodeAt = new Map(junctions.map((knot, node) => [knot, node]));
  const cuts = [0, ...junctions.filter(knot => knot > 0 && knot < n - 1), n - 1];
  const specs: TrailRunSpec[] = [], names: string[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    const knotProfile = sliceProfile(profile, a, b);
    specs.push({ spline: main.slice(a, b), from: nodeAt.get(a), to: nodeAt.get(b), options: knotProfile ? { knotProfile } : {} });
    names.push(cuts.length === 2 ? 'the trail' : `the trail between knots ${a + 1} and ${b + 1}`);
  }
  for (const branch of branches) {
    const rejoins = branch.to !== undefined;
    const nodes = [trail.knots[branch.knot], ...branch.knots, ...(rejoins ? [trail.knots[branch.to!]] : [])];
    // A branch carries the trail's settings, and its junction knots' own values where it leaves and rejoins.
    const own = [trail.knotSettings?.[branch.knot] ?? null, ...branch.knots.map(() => null),
      ...(rejoins ? [trail.knotSettings?.[branch.to!] ?? null] : [])];
    const knotProfile = trailKnotProfile(trail.settings, own, nodes.length);
    specs.push({ spline: railBezierSegments(nodes), from: nodeAt.get(branch.knot), to: rejoins ? nodeAt.get(branch.to!) : undefined,
      options: knotProfile ? { knotProfile } : {} });
    names.push(`the branch at knot ${branch.knot + 1}`);
  }
  if (held) specs.forEach((spec, i) => { spec.options = { ...spec.options, spanCount: held[i] }; });
  return { specs, names, knots: junctions };
}

/** A network refusal in the trail's own words: its runs and junctions by knot rather than by number. */
function describeNetworkError(error: string, runs: { names: string[]; knots: number[] }): string {
  const run = (i: string) => runs.names[Number(i)] ?? `run ${i}`;
  const told = error
    .replace(/\bruns (\d+) and (\d+)/gi, (_, a: string, b: string) => `${run(a)} and ${run(b)}`)
    .replace(/\bRun (\d+)/g, (_, a: string) => run(a).replace(/^t/, 'T'))
    .replace(/\bJunction (\d+)/g, (_, j: string) => `The junction at knot ${(runs.knots[Number(j)] ?? 0) + 1}`)
    .replace(/ \[reach [^\]]*\]$/, '');
  return told;
}

/** A blank document to cut a trail into on its own: the document's settings, none of its geometry. */
function scratchDoc(doc: QuadMeshDoc): QuadMeshDoc {
  return {
    ...doc, vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0,
    tombstones: undefined, freeEdges: undefined, tJunctions: undefined, edgeHandles: undefined,
    quadPaint: undefined, quadTex: undefined, quadOrient: undefined, quadLocked: undefined,
  };
}

/** A trail cut on its own, in the order it owns things: the standalone mesh, the shape it has, and its stations. */
type TrailPiece = { doc: QuadMeshDoc; runSpans: number[]; junctions: number; layout: TrailLayout };

export type TrailCut =
  | { ok: true; doc: QuadMeshDoc; trail: AuthoredTrail; layout: TrailLayout; connected: boolean }
  | { ok: false; error: string };

type PlannedCut =
  | { ok: true; owned: OwnedTrail | null; connected: boolean; piece: TrailPiece }
  | { ok: false; error: string };

/** Cut a trail on its own, as `cutTrail` would cut it into `doc`, without writing anything. */
function planCut(doc: QuadMeshDoc, trail: AuthoredTrail): PlannedCut {
  if (trail.knots.length < 2) return { ok: false, error: 'A trail needs at least two knots.' };
  const owned = trail.quads.length ? resolveTrail(doc, trail) : null;
  if (trail.quads.length && !owned)
    return { ok: false, error: 'This trail has lost some of its patches, so it can no longer re-cut them. Dissolve it to edit them as mesh.' };
  const connected = owned ? trailIsConnected(doc, owned) : false;
  const branches = trailBranches(trail);
  const scratch = scratchDoc(doc);

  if (!branches.length) {
    if (connected && owned!.junctions) return { ok: false, error: JOINED_SHAPE };
    const ribbon = applyTrailSpline(scratch, railBezierSegments(trail.knots, trail.handles), {
      ...trailLayoutOptions(trail.settings, trail.knotSettings, trail.knots.length),
      ...(connected ? { spanCount: owned!.spans } : {}),
    });
    if (!ribbon.ok) return ribbon;
    return { ok: true, owned, connected, piece: {
      doc: ribbon.doc, runSpans: [ribbon.spans.length], junctions: 0, layout: { stations: ribbon.stations, spans: ribbon.spans },
    } };
  }

  const shape = trailRuns(trail, null);
  // A joined trail keeps its layout, so it keeps its runs: it can neither gain nor lose a branch.
  if (connected && (shape.specs.length !== owned!.runSpans.length || shape.knots.length !== owned!.junctions))
    return { ok: false, error: JOINED_SHAPE };
  const runs = connected ? trailRuns(trail, owned!.runSpans) : shape;
  const network = applyTrailNetwork(scratch, runs.specs, { ...trailLayoutOptions(trail.settings), minRunLengthM: MIN_RUN_M });
  if (!network.ok) return { ok: false, error: describeNetworkError(network.error, runs) };
  return { ok: true, owned, connected, piece: {
    doc: network.doc,
    runSpans: network.runs.map(run => run.spans.length),
    junctions: network.junctions.length,
    layout: { stations: network.runs.flatMap(run => run.stations), spans: network.runs.flatMap(run => run.spans) },
  } };
}

const JOINED_SHAPE = 'Other patches are joined to this trail, so its layout is held: it cannot gain or lose a branch.';

/**
 * The station a cut puts at each of a trail's own knots — its section as cut, the bank the automatic law gave it
 * included — or null when the trail's spline cannot be laid out. What a knot's panel reads its values from. Read
 * off the trail as one ribbon: at a branch knot the junction stands where that station would.
 */
export function trailKnotStations(_doc: QuadMeshDoc, trail: AuthoredTrail): TrailStation[] | null {
  if (trail.knots.length < 2) return null;
  const layout = layoutTrailSpline(railBezierSegments(trail.knots, trail.handles),
    trailLayoutOptions(trail.settings, trail.knotSettings, trail.knots.length));
  if (!layout.ok) return null;
  const { stations, spans } = layout;
  // Knot k starts source cubic k: its station is the first one cut from that cubic or a later one (a cubic too
  // short to measure has none). The last knot ends the ribbon.
  return trail.knots.map((_, knot) => {
    const span = spans.findIndex(candidate => candidate.sourceSegment >= knot);
    return stations[span < 0 ? stations.length - 1 : span];
  });
}

/** A quad's corners as positions, for telling the same patch in two meshes apart from a different one. */
const quadKey = (vertices: readonly number[], corners: readonly number[]) =>
  corners.map(v => `${vertices[v * 3].toFixed(3)},${vertices[v * 3 + 1].toFixed(3)},${vertices[v * 3 + 2].toFixed(3)}`).join('|');

/**
 * What cutting `trail` into `doc` would lay down that is not there already — the new and the reshaped patches,
 * as a standalone mesh and the patches of it to show. The Create Trail ghost: the next knot, the branch about to
 * be laid, before the click that lays it.
 */
export function trailPreview(doc: QuadMeshDoc, trail: AuthoredTrail):
{ ok: true; doc: QuadMeshDoc; quads: number[] } | { ok: false; error: string } {
  const plan = planCut(doc, trail);
  if (!plan.ok) return plan;
  const { piece, owned } = plan;
  const standing = new Set(owned ? owned.quads.map(quad => quadKey(doc.vertices, doc.quads[quad])) : []);
  const quads = piece.doc.quads.flatMap((corners, quad) => standing.has(quadKey(piece.doc.vertices, corners)) ? [] : [quad]);
  return { ok: true, doc: piece.doc, quads };
}

/**
 * Cut a trail from its spline, branches and settings into `doc`. A trail that owns nothing yet appends a fresh
 * ribbon; one that does writes over it slot by slot — the same vertices and patches wherever the new cut has one
 * where the old did, new ones past the end of the old, and what the old had past the end of the new retired. A
 * trail with other patches joined to it is held at its current layout, so it never adds or retires anything.
 *
 * Returns the new document and the trail with its ownership updated; neither input is changed.
 */
export function cutTrail(doc: QuadMeshDoc, trail: AuthoredTrail): TrailCut {
  const plan = planCut(doc, trail);
  if (!plan.ok) return plan;
  const { owned, connected, piece } = plan;
  const local = piece.doc;
  const oldVertices = owned?.vertices ?? [], oldQuads = owned?.quads ?? [];

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

  const surface = (owned && doc.quadPaint?.[oldQuads[0]]) ?? MESA_TRAIL_DEFAULTS.surface;
  const quadPaint = { ...(doc.quadPaint ?? {}) };
  const quadTex = { ...(doc.quadTex ?? {}) }, quadOrient = { ...(doc.quadOrient ?? {}) };
  const quadLocked = { ...(doc.quadLocked ?? {}) };
  lanes.forEach((quad, j) => {
    if (j >= oldQuads.length) quadPaint[quad] = surface;
    const tile = local.quadTex?.[j];
    if (tile) { quadTex[quad] = tile; quadOrient[quad] = { ...(local.quadOrient?.[j] ?? { rot: 0, mirror: false }) }; }
    // Mesa tiles off: take back only what the preset laid, so a tile painted by hand stays.
    else if (quadTex[quad] && MESA_TILES.has(quadTex[quad])) { delete quadTex[quad]; delete quadOrient[quad]; }
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
    knots: trail.knots.map(knot => [knot[0], knot[1], knot[2]] as V3),
    vertices: vertexSlot.map(vertexAt).map(vertex => out.vertexIds[vertex]),
    quads: ownQuads.map(quad => out.quadIds[quad]),
  };
  if (piece.junctions) next.network = { runSpans: [...piece.runSpans], junctions: piece.junctions };
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
