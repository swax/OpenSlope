import type { AuthoredTrail, QuadMeshDoc, TrailKnotSettings, TrailSettings, V3 } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { railBezierSegments } from '../rails/rails';
import { setQuadsLocked } from './locks';
import { assignMap, finishMeshRewrite, looseVertexIds } from './ops/contract';
import { liveQuadEdges } from './primitives';
import {
  layoutTrailSpline, MESA_TRAIL_DEFAULTS, MESA_TRAIL_TEXTURES, TRAIL_TILE_ORIENT, writeTrailSeamHandles,
  type TrailKnotProfile, type TrailLayout, type TrailLayoutOptions, type TrailStation,
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

/** Every tile the Mesa preset can lay — the ones a trail may take back off its own patches. */
const MESA_TILES = new Set([
  ...MESA_TRAIL_TEXTURES.standard.flat(),
  ...(MESA_TRAIL_TEXTURES.tight ?? []).flat(),
]);

/** Where a trail's owned geometry is now, as indices into the current document. */
export interface OwnedTrail {
  /** Three per station: left rim, centre seam, right rim. */
  vertices: number[];
  /** Two per span: left lane, right lane. */
  quads: number[];
  spans: number;
}

const sameCorners = (corners: readonly number[] | undefined, want: readonly number[]) =>
  !!corners && corners.length === 4 && corners.every((vertex, i) => vertex === want[i]);

/**
 * Find a trail's ribbon in the document. Null once any vertex or patch it owns is gone, or the patches no longer
 * join its vertices the way a ribbon does — something cut into it, and there is no longer a ribbon to re-cut.
 */
export function resolveTrail(doc: QuadMeshDoc, trail: AuthoredTrail): OwnedTrail | null {
  const spans = trail.quads.length / 2;
  if (!Number.isInteger(spans) || spans < 1 || trail.vertices.length !== (spans + 1) * 3) return null;
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
  for (let i = 0; i < spans; i++) {
    const [l0, c0, r0, l1, c1, r1] = vertices.slice(i * 3, i * 3 + 6);
    if (!sameCorners(doc.quads[quads[i * 2]], [l0, c0, l1, c1]) || !sameCorners(doc.quads[quads[i * 2 + 1]], [c0, r0, c1, r1]))
      return null;
  }
  return { vertices, quads, spans };
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

export type TrailCut =
  | { ok: true; doc: QuadMeshDoc; trail: AuthoredTrail; layout: TrailLayout; connected: boolean }
  | { ok: false; error: string };

type PlannedCut =
  | { ok: true; owned: OwnedTrail | null; connected: boolean; layout: TrailLayout }
  | { ok: false; error: string };

/** Lay a trail out as `cutTrail` would cut it into `doc`, without writing anything. */
function planCut(doc: QuadMeshDoc, trail: AuthoredTrail): PlannedCut {
  if (trail.knots.length < 2) return { ok: false, error: 'A trail needs at least two knots.' };
  const owned = trail.quads.length ? resolveTrail(doc, trail) : null;
  if (trail.quads.length && !owned)
    return { ok: false, error: 'This trail has lost some of its patches, so it can no longer re-cut them. Dissolve it to edit them as mesh.' };
  const connected = owned ? trailIsConnected(doc, owned) : false;
  const layout = layoutTrailSpline(railBezierSegments(trail.knots, trail.handles), {
    ...trailLayoutOptions(trail.settings, trail.knotSettings, trail.knots.length),
    ...(owned && connected ? { spanCount: owned.spans } : {}),
  });
  if (!layout.ok) return layout;
  return { ok: true, owned, connected, layout: { stations: layout.stations, spans: layout.spans } };
}

/**
 * The station a cut puts at each knot — its section as cut, the bank the automatic law gave it included — or
 * null when the trail cannot be cut as it stands. What a knot's panel reads its values from.
 */
export function trailKnotStations(doc: QuadMeshDoc, trail: AuthoredTrail): TrailStation[] | null {
  const plan = planCut(doc, trail);
  if (!plan.ok) return null;
  const { stations, spans } = plan.layout;
  // Knot k starts source cubic k: its station is the first one cut from that cubic or a later one (a cubic too
  // short to measure has none). The last knot ends the ribbon.
  return trail.knots.map((_, knot) => {
    const span = spans.findIndex(candidate => candidate.sourceSegment >= knot);
    return stations[span < 0 ? stations.length - 1 : span];
  });
}

/**
 * Cut a trail's ribbon from its spline and settings, into `doc`. A trail that owns nothing yet appends a fresh
 * ribbon; one that does writes over it — the same vertices and patches for every station both cuts share, new
 * ones for stations a longer ribbon adds, and the patches a shorter one leaves behind retired. A trail with
 * other patches joined to it is held at its current span count, so it never adds or retires anything.
 *
 * Returns the new document and the trail with its ownership updated; neither input is changed.
 */
export function cutTrail(doc: QuadMeshDoc, trail: AuthoredTrail): TrailCut {
  const plan = planCut(doc, trail);
  if (!plan.ok) return plan;
  const { owned, connected } = plan;
  const { stations, spans } = plan.layout;
  const oldSpans = owned?.spans ?? -1;

  // ---- positions: reuse a station's three vertices where the old ribbon had that station ----------------
  const vertices = doc.vertices.slice();
  const put = (index: number | null, p: V3): number => {
    if (index === null) { vertices.push(p[0], p[1], p[2]); return vertices.length / 3 - 1; }
    vertices[index * 3] = p[0]; vertices[index * 3 + 1] = p[1]; vertices[index * 3 + 2] = p[2];
    return index;
  };
  const left: number[] = [], center: number[] = [], right: number[] = [];
  stations.forEach((station, s) => {
    const reuse = owned && s <= oldSpans ? owned.vertices.slice(s * 3, s * 3 + 3) : [null, null, null];
    left.push(put(reuse[0], station.left));
    center.push(put(reuse[1], station.center));
    right.push(put(reuse[2], station.right));
  });

  // ---- patches: the same two per shared span, appended past it, retired past the new end -----------------
  const quads: (number[] | null)[] = doc.quads.map(quad => quad.slice());
  const lanes: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    const pair = [[left[i], center[i], left[i + 1], center[i + 1]], [center[i], right[i], center[i + 1], right[i + 1]]];
    for (let lane = 0; lane < 2; lane++) {
      if (owned && i < oldSpans) { quads[owned.quads[i * 2 + lane]] = pair[lane]; lanes.push(owned.quads[i * 2 + lane]); }
      else { lanes.push(quads.length); quads.push(pair[lane]); }
    }
  }
  if (owned) for (let i = spans.length; i < oldSpans; i++) { quads[owned.quads[i * 2]] = null; quads[owned.quads[i * 2 + 1]] = null; }

  // ---- shape: every handle on the ribbon is derived again from the new positions --------------------------
  // The lock materialised the old ribbon's effective handles; left in place they would bend the new one to the
  // old one's tangents. Clear them, write the exact centre seam, and let the lock below capture the rest.
  const edgeHandles = { ...(doc.edgeHandles ?? {}) };
  if (owned) for (const quad of owned.quads) for (const [a, b] of liveQuadEdges(doc.quads[quad])) {
    delete edgeHandles[`${a}>${b}`]; delete edgeHandles[`${b}>${a}`];
  }
  writeTrailSeamHandles(edgeHandles, center, spans);

  const surface = (owned && doc.quadPaint?.[owned.quads[0]]) ?? MESA_TRAIL_DEFAULTS.surface;
  const quadPaint = { ...(doc.quadPaint ?? {}) };
  const quadTex = { ...(doc.quadTex ?? {}) }, quadOrient = { ...(doc.quadOrient ?? {}) };
  const quadLocked = { ...(doc.quadLocked ?? {}) };
  lanes.forEach((quad, k) => {
    const isNew = !owned || k >= oldSpans * 2;
    if (isNew) quadPaint[quad] = surface;
    const span = spans[k >> 1], tile = span.textures?.[k & 1];
    if (tile) { quadTex[quad] = tile; quadOrient[quad] = { ...(span.textureOrient ?? TRAIL_TILE_ORIENT) }; }
    // Mesa tiles off: take back only what the preset laid, so a tile painted by hand stays.
    else if (quadTex[quad] && MESA_TILES.has(quadTex[quad])) { delete quadTex[quad]; delete quadOrient[quad]; }
    delete quadLocked[quad];
  });

  // ---- write it: in place when the topology stands, through the shared compactor when it does not ---------
  let out: QuadMeshDoc;
  let vertexAt: (raw: number) => number, quadAt: (raw: number) => number;
  if (owned && spans.length === oldSpans) {
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
  const ownVertices = stations.flatMap((_, s) => [left[s], center[s], right[s]].map(vertexAt));
  return {
    ok: true,
    doc: out,
    trail: {
      ...trail,
      knots: trail.knots.map(knot => [knot[0], knot[1], knot[2]] as V3),
      vertices: ownVertices.map(vertex => out.vertexIds[vertex]),
      quads: ownQuads.map(quad => out.quadIds[quad]),
    },
    layout: { stations, spans },
    connected,
  };
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
