import type { V3 } from '../doc/types';
import { surfaceStyle } from '../doc/types';
import { sub } from '../math/vec';
import { rgbToHex } from '../math/color';
import { patchNormal, patchPoint, pushCubicEdge } from '../math/bezier';
import { sampleTile, sampleTileRGB, remapLightmapUv, type LightmapSet } from '../lighting/lightmap';
import { buildQuadMesh, type QuadMesh, type EdgeHandle } from '../mesh/topology';
import type { SurfaceTopology, EdgeCls } from '../mesh/surface';

/**
 * Read-only reference terrain: tessellate an *extracted* level's Patches.json
 * so it can be studied in the viewport next to an authored course. This is the inverse of the
 * export path in level.ts - an extracted Patches.json stores the same 16 Bezier control points
 * Slopesmith writes, so the same evaluator reproduces the original terrain (a live round-trip check).
 *
 * It is deliberately NOT an editable-document loader: an original level is a branching 2-3 km mountain
 * of thousands of patches with extraordinary topology, not a rectangular control net, so there is no
 * faithful inverse into the editor's grammar. This renders the quilt; it does not make it editable.
 */

/** One patch as stored in an extracted (or Slopesmith-authored) Patches.json. */
export interface RawPatch {
  /** 16 control points in raw SSX space (cm, Z-up, X-mirrored), row-major, rows along u. */
  Points: number[][];
  SurfaceType: number;
  TexturePath?: string;
  /** Four tile-UV corners [[x,y]×4] for this patch; bound to the geometry corner of the same index, like the bake. */
  UVPoints?: number[][];
  /** Lightmap sub-rect [lx, ly, lw, lh] (fractions of the 128px map) this patch samples. */
  LightMapPoint?: number[];
  /** Which level lightmap (0..15) this patch reads. */
  LightmapID?: number;
}

/** raw SSX (cm, Z-up, X-mirrored) -> editor (m, Y-up, RH). Inverse of level.ts `toRaw`. */
export function editorFromRaw(p: number[]): V3 {
  return [-p[0] / 100, p[2] / 100, -p[1] / 100];
}

/**
 * Pull an exact one-tile UV rectangle inward by the native 0.008 seam margin. Several shipped levels already
 * store that margin, but some retail patches and custom-map compilers emit exact integer corners. Sampling an
 * exact 0/1 edge with linear + RepeatWrapping blends the texture's opposite edge into the patch boundary;
 * that is especially conspicuous where neighbouring patches rotate or mirror hand-matched texture pages.
 *
 * Match Snowknife's bundle normalization: only rectangles spanning exactly one tile on BOTH axes are touched.
 * Existing insets, crops and intentional multi-tile repeats remain byte-for-byte equivalent in the viewport.
 */
export function insetReferenceUnitTile(
  corners: readonly [readonly [number, number], readonly [number, number],
    readonly [number, number], readonly [number, number]],
): [[number, number], [number, number], [number, number], [number, number]] {
  const out = corners.map(([u, v]) => [u, v]) as
    [[number, number], [number, number], [number, number], [number, number]];
  const span = (axis: 0 | 1) => {
    const values = out.map(corner => corner[axis]);
    return Math.max(...values) - Math.min(...values);
  };
  if (Math.abs(span(0) - 1) >= 1e-4 || Math.abs(span(1) - 1) >= 1e-4) return out;
  const inset = 0.008;
  for (const axis of [0, 1] as const) {
    const min = Math.min(...out.map(corner => corner[axis]));
    for (const corner of out) corner[axis] = min + inset + (corner[axis] - min) * (1 - 2 * inset);
  }
  return out;
}

/** Summary of the patch-to-lightmap allocation. A native bake gives almost every terrain patch its own atlas
 * tile. Some custom compilers instead leave the whole quilt on one placeholder tile while carrying a stale
 * `_L.ssh`; repeating that tile as real lighting draws a dark gradient down every patch boundary. */
export interface ReferenceLightmapLayoutStats {
  patches: number;
  assigned: number;
  unique: number;
  /** More than one patch is assigned, but fewer than half have a distinct page/rect allocation. */
  collapsed: boolean;
}

export function referenceLightmapLayoutStats(patches: readonly RawPatch[]): ReferenceLightmapLayoutStats {
  let rendered = 0, assigned = 0;
  const unique = new Set<string>();
  for (const patch of patches) {
    if (!patch.Points || patch.Points.length < 16) continue;
    rendered++;
    const point = patch.LightMapPoint, id = patch.LightmapID;
    if (id == null || id < 0 || !point || point.length < 4 || point.some(value => !Number.isFinite(value))) continue;
    assigned++;
    unique.add(`${id}|${point.slice(0, 4).map(value => value.toFixed(6)).join(',')}`);
  }
  return { patches: rendered, assigned, unique: unique.size,
    collapsed: assigned > 1 && unique.size * 2 < assigned };
}

/** One native spline as `/api/level` serves it off the level's Splines.json. Grind paths and effect-animation
 * routes share this table, so `originalIndex` remains stable even when a consumer filters by candidacy. */
export interface RefSplineRaw {
  originalIndex: number;
  /** Native SplineName. A few retail grind rails are identifiable only by the `Rail` token in this name. */
  name: string;
  style: number;
  segments: number[][][];
}

/** Snowknife/retail rail candidacy: the two ordinary grind styles, plus named exceptions such as Alaska's
 * six SplineStyle-5 `IceRail` rows. The match intentionally stays case-sensitive to mirror PathBundle. */
export function referenceSplineIsGrindRail(spline: Pick<RefSplineRaw, 'name' | 'style'>): boolean {
  return spline.style === 12 || spline.style === 13 || spline.name.includes('Rail');
}

// ---- course line: the level's main racing line, recovered from AIP.json / SOP.json ----

/** One AIP/SOP path record: a raw-space seed (PathPos) + INCREMENTAL deltas (PathPoints), plus the
 *  progress / respawn metadata the course stitcher keys on. */
export interface PathRecord {
  PathPos?: number[];
  PathPoints?: number[][];
  /** Distance from this segment's start to the finish (the descending key that orders the main course). */
  DistanceToFinish?: number;
  Respawnable?: boolean;
  Name?: string;
  /** The line rating, 0–100 — how daring this line is. An AI rider picks the path whose rating matches its
   *  mood, which is what makes the network a menu of racing lines rather than one route ([Trailmap: 395]). */
  U3?: number;
  PathEvents?: PathEventRecord[];
}

/** One event on a path. `EventStart` / `EventEnd` are arc lengths along the path, in raw units ([Trailmap: 250]). */
export interface PathEventRecord {
  EventType?: number;
  EventValue?: number;
  EventStart?: number;
  EventEnd?: number;
}

/**
 * The one event type the AI racer reads ([Trailmap: 395]): raw `EventType` 100, which the loader translates to
 * item type 25. It is the **jump marker** — the rider presses its ollie at one, and that is the only reason an AI
 * rider ever jumps. The value word packs the speed the line wants to be taken at (km/h, in the high bits) and two
 * trick-selection flags.
 */
export const AI_JUMP_EVENT = 100;
/** Raw race-line event whose payload is the showoff time award in seconds. The parser translates it to
 *  internal event 12, which the rider progress update dispatches when its forward arc crosses the station. */
export const SHOWOFF_CHECKPOINT_EVENT = 11;

/** One recovered SOP checkpoint. Several route-specific events may share a `group` when their DTF/value show
 *  they are alternate-path copies of one logical checkpoint. */
export interface RefShowoffCheckpoint {
  line: number;
  group: number;
  bonusSeconds: number;
  /** Horizontal station along this race-line record, metres. */
  station: number;
  /** Distance remaining at the checkpoint, metres: line DistanceToFinish minus station. */
  dtf: number;
  pos: V3;
}

/** A jump marker in editor units: arc in metres, target speed in m/s. */
export interface RefAiMarker {
  arc: number;
  speed: number;
  trickA: boolean;
  trickB: boolean;
}

/** Decode a path's jump markers out of its event list. Raw arc units are cm, and the packed speed is km/h. */
export function aiJumpMarkers(rec: PathRecord): RefAiMarker[] {
  return (rec.PathEvents ?? [])
    .filter(e => e.EventType === AI_JUMP_EVENT)
    .map(e => ({
      arc: (e.EventStart ?? 0) / 100,
      speed: ((e.EventValue ?? 0) >> 2) / 3.6, // km/h -> m/s
      trickA: !!((e.EventValue ?? 0) & 1),
      trickB: !!((e.EventValue ?? 0) & 2),
    }))
    .sort((a, b) => a.arc - b.arc);
}

/** The subset of an AIP.json / SOP.json the course extractor reads. */
export interface CoursePathFile {
  RaceLines?: PathRecord[];
  AIPaths?: PathRecord[];
  /** Indices into AIPaths of the field's start paths — one gate line per rider. */
  StartPosList?: number[];
}

/** One AI path as `/api/level` serves it off the level's AIP.json: editor-space points (seed + deltas
 *  reconstructed), whether `StartPosList` assigns it to a race-grid slot, and its line rating. */
export interface RefAiPath {
  name: string;
  start: boolean;
  /** 0–100, the path's own `U3` ([Trailmap: 395]) — the AI field scores candidate lines against it. */
  rating: number;
  /** Whether the course reset may put a fallen rider back on this line ([Trailmap: 395]). Gates the reset only. */
  respawnable: boolean;
  /** Its jump markers — where an AI rider ollies ([Trailmap: 395]). */
  markers: RefAiMarker[];
  points: V3[];
}

/**
 * Reconstruct one course path into editor-space points: SSX stores it as a raw-space seed (PathPos)
 * plus incremental deltas (PathPoints), cumulative-summed - the same bake snowknife's PathBundle does
 * (docs/011) - and editorFromRaw maps each accumulated raw point into editor metres.
 *
 * **PathPos is the path's FIRST VERTEX, not just an origin to hang the deltas off** ([Trailmap: 250]): the
 * engine's own walk seeds its running point with it and then steps one segment per stored delta, so a path of
 * N deltas is a polyline of N+1 points and its arc length starts counting at PathPos. Dropping it (as this
 * did) loses the whole first segment - a median of 4 m on Garibaldi and as much as 49 m - which slides every
 * arc-addressed thing on the path, the AI's jump markers included, back by that much.
 */
export function reconstructPathLine(rec: PathRecord): V3[] {
  const pts = rec.PathPoints;
  if (!pts || pts.length < 2) return [];
  let ax = rec.PathPos?.[0] ?? 0, ay = rec.PathPos?.[1] ?? 0, az = rec.PathPos?.[2] ?? 0;
  const out: V3[] = [editorFromRaw([ax, ay, az])];
  for (const p of pts) {
    if (!p || p.length < 3) continue;
    ax += p[0]; ay += p[1]; az += p[2];
    out.push(editorFromRaw([ax, ay, az]));
  }
  return out;
}

/** Point at a path's horizontal arc station, matching the event/DTF metric (Y is editor up). */
function pointAtHorizontalStation(points: V3[], station: number): V3 | null {
  if (!points.length) return null;
  let arc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (station <= arc + length || i === points.length - 1) {
      const t = length > 1e-9 ? Math.max(0, Math.min(1, (station - arc) / length)) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    arc += length;
  }
  return points[points.length - 1];
}

/** Recover all positive type-11 awards from SOP race lines. Group route-equivalent copies by their remaining
 *  DTF and value; Alaska, for example, carries two +150 events on alternate lines at essentially the same
 *  progress, so they are one award with two possible trigger locations rather than a stackable fourth bonus. */
export function showoffCheckpoints(file: CoursePathFile): RefShowoffCheckpoint[] {
  const found: RefShowoffCheckpoint[] = [];
  for (let line = 0; line < (file.RaceLines ?? []).length; line++) {
    const rec = file.RaceLines![line];
    const points = reconstructPathLine(rec);
    if (points.length < 2) continue;
    for (const event of rec.PathEvents ?? []) {
      const bonusSeconds = Math.round(event.EventValue ?? 0);
      const station = (event.EventStart ?? 0) / 100;
      if (event.EventType !== SHOWOFF_CHECKPOINT_EVENT || bonusSeconds <= 0 || station < 0) continue;
      const pos = pointAtHorizontalStation(points, station);
      if (!pos) continue;
      found.push({
        line, group: -1, bonusSeconds, station,
        dtf: ((rec.DistanceToFinish ?? 0) - (event.EventStart ?? 0)) / 100,
        pos,
      });
    }
  }
  let nextGroup = 0;
  for (const checkpoint of found) {
    const equivalent = found.find(other => other !== checkpoint && other.group >= 0
      && Math.abs(other.dtf - checkpoint.dtf) <= 2);
    checkpoint.group = equivalent?.group ?? nextGroup++;
  }
  return found;
}

const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Append segments end-to-end from `seed`: each step takes the unused segment whose start is nearest the
 *  current tail (within `gapM`), optionally constrained to keep descending toward the finish (`descend`). */
function chainSegments(segs: { pts: V3[]; dtf: number }[], seed: number, gapM: number, descend: boolean): V3[] {
  const used = new Set<number>([seed]);
  const chain = segs[seed].pts.slice();
  let dtf = segs[seed].dtf;
  for (;;) {
    const tail = chain[chain.length - 1];
    let best = -1, bd = gapM;
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      if (descend && segs[i].dtf > dtf + 1) continue; // never hand off to a segment closer to the start
      const d = dist3(tail, segs[i].pts[0]);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) break;
    used.add(best); dtf = segs[best].dtf;
    chain.push(...(bd < 10 ? segs[best].pts.slice(1) : segs[best].pts)); // drop a near-coincident join point
  }
  return chain;
}

/**
 * Stitch the level's MAIN top-to-bottom course from its path file. SSX splits the racing line into
 * segments keyed by DistanceToFinish (one handoff per start gate); the main course is the chain that
 * starts highest (largest DTF) and hands off to the next segment whose start meets the previous tail,
 * always descending toward the finish - so the shortcut / alternate branches that fork off mid-mountain
 * are left out. Falls back to chaining the Respawnable AI paths from the topmost start when a file
 * carries no race lines. Returns editor-space points, or null if there's no usable line.
 */
export function extractMainCourse(file: CoursePathFile, gapM = 200): V3[] | null {
  const race = (file.RaceLines ?? [])
    .map(r => ({ pts: reconstructPathLine(r), dtf: r.DistanceToFinish ?? 0 }))
    .filter(s => s.pts.length >= 2)
    .sort((a, b) => b.dtf - a.dtf); // highest DTF (the top of the run) first
  if (race.length) return chainSegments(race, 0, gapM, true);

  // no race lines: chain the respawnable AI paths spatially, seeded from the highest start point
  const ai = (file.AIPaths ?? [])
    .filter(a => a.Respawnable)
    .map(a => ({ pts: reconstructPathLine(a), dtf: 0 }))
    .filter(s => s.pts.length >= 2)
    .sort((a, b) => b.pts[0][1] - a.pts[0][1]); // topmost start first
  return ai.length ? chainSegments(ai, 0, gapM, false) : null;
}

// ---- where the race starts and ends ----

/** The subset of an extracted Instances.json the staging-anchor reader needs. */
export interface InstancesFile {
  Instances?: { InstanceName?: string; Location?: number[] }[];
}

/** Where a level's race actually begins and ends, in editor space. Served with the recovered course line
 *  and drawn over the reference terrain; every field is null when the level doesn't carry it. */
export interface RefCourseAnchors {
  /** `Mdl_StageArea_Start_0` — the staging anchor the engine places the six riders through. */
  start: V3 | null;
  /** The finish LINE (DTF=0), not the last race-line vertex and not the podium. */
  finish: V3 | null;
  /** The racing direction THROUGH that crossing — the finish plane's normal, which the lap countdown needs
   *  and which no end of the recovered line can supply on a lap course. Unit; null with no finish. */
  finishFwd: V3 | null;
  /** `Mdl_StageArea_Finish_0` — the post-race corral, 20–48 m past `finish`. */
  podium: V3 | null;
  /** Positive SOP type-11 time awards, including alternate-line copies joined by `group`. */
  checkpoints?: RefShowoffCheckpoint[];
}

/**
 * The engine's own staging anchors, in editor space. Tricky hard-codes the two model names, hashes them at
 * runtime and transforms a fixed six-rider formation through the START one — the active AIP/SOP start-path
 * origins do NOT place the riders ([Trailmap: 120-objects, 390-pickups-and-race]). So `start` is where a race
 * begins, full stop, and neither end of the recovered course line is.
 *
 * `podium` is `Mdl_StageArea_Finish_0`, which is NOT the finish line: it is the post-race corral 20–48 m past
 * the crossing, co-located with the finish visuals. The line itself is `dtfZeroPoint` below.
 */
export function stageAreaAnchors(file: InstancesFile): { start: V3 | null; podium: V3 | null } {
  const find = (prefix: string): V3 | null => {
    const hit = (file.Instances ?? []).find(i => i.InstanceName?.startsWith(prefix) && (i.Location?.length ?? 0) >= 3);
    return hit ? editorFromRaw(hit.Location!) : null;
  };
  return { start: find('Mdl_StageArea_Start'), podium: find('Mdl_StageArea_Finish') };
}

/**
 * The finish LINE: the point where a rider's continuous distance-to-finish reaches zero, i.e. arc-length
 * `DistanceToFinish` along the race line that carries the smallest one. Walked in the HORIZONTAL arc metric,
 * because that is how the engine chains path distance ([Trailmap: 250-paths-aip-sop]).
 *
 * The last race-line VERTEX is not the finish — the line overshoots the crossing by 25–61 m on the shipped
 * levels. Measured against the placed finish arch, this lands within 0.8–5.8 m on all five.
 */
export function dtfZeroPoint(file: CoursePathFile): V3 | null {
  return dtfZeroFrame(file)?.pos ?? null;
}

/**
 * The finish crossing WITH the racing direction through it — the finish plane, which is what a lap countdown
 * actually needs ([Trailmap: 390-lap-counter]). On a lap course neither end of the recovered course line is
 * the finish (Tokyo Megaplex's line stops 320 m above it), so the plane cannot be taken from the line's tail;
 * it comes from the race line that carries the crossing, at the segment the crossing falls on.
 */
export function dtfZeroFrame(file: CoursePathFile): { pos: V3; fwd: V3 } | null {
  const lines = (file.RaceLines ?? [])
    .map(r => ({ pts: reconstructPathLine(r), dtf: (r.DistanceToFinish ?? 0) / 100 }))
    .filter(l => l.pts.length >= 2)
    .sort((a, b) => a.dtf - b.dtf); // the smallest DTF is the line that actually reaches zero
  for (const { pts, dtf } of lines) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const prev = acc;
      acc += Math.hypot(b[0] - a[0], b[2] - a[2]); // horizontal only: Y is up in editor space
      const lo = dtf - prev, hi = dtf - acc;
      if (lo <= 0 || hi > 0) continue;             // want lo > 0 >= hi: the straddle
      const t = lo / (lo - hi);                    // DTF is linear along a straight segment
      const run = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
      return {
        pos: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])],
        fwd: [(b[0] - a[0]) / run, (b[1] - a[1]) / run, (b[2] - a[2]) / run],
      };
    }
  }
  return null;
}

// ---- lighting: seed the authored sun from the level's own light records ----

/** One PBD light record as stored in an extracted level's Lights.json. */
export interface LightRecord {
  /** 0 = directional (sun), 3 = ambient (sky fill); other types (spot/point/crowd) are ignored here. */
  Type: number;
  /** Linear RGB, HDR — the level's TRUE pre-bake intensity (sunTint × strength), not the 0..1 lightmap. */
  Colour: number[];
  /** Raw-space propagation (from-light) unit vector for a directional — the linear `toRaw` of −(to-sun). */
  Direction: number[];
  LightName?: string;
}

/** The subset of an extracted Lights.json the sun seeder reads. */
export interface LightsFile { Lights?: LightRecord[]; }

/** A SunLight seeded from a level's light records: the directional gives the sun's pose/strength/tint,
 *  the (optional) ambient gives the sky fill. shadow/AO aren't carried by the records, so they're left
 *  to the lightmap fit / the authored defaults. */
export interface RefSunSeed {
  el: number; az: number; sun: number; sunTint: string;  // from the first Type 0 (directional)
  ambient?: number; skyTint?: string;                     // from the first Type 3 (ambient), if present
}

/**
 * Seed an authored SunLight from a level's own Lights.json — the inverse of level.ts buildLightsJson.
 * Picks the first directional (Type 0) and first ambient (Type 3); the directional's Direction inverts
 * back to elevation/azimuth (`el = asin(-z)`, `az = atan2(y, x)`) and its Colour splits into a peak
 * strength + a normalised tint, so tint × strength reproduces the record. These are the level's TRUE
 * (HDR) light values — used to seed the export's sun over the LDR lightmap fit. Returns null when there's
 * no usable directional record (then the fit stays the only seed).
 */
export function sunFromLights(file: LightsFile): RefSunSeed | null {
  const lights = file.Lights ?? [];
  const dirRec = lights.find(l => l.Type === 0 && (l.Direction?.length ?? 0) >= 3 && (l.Colour?.length ?? 0) >= 3);
  if (!dirRec) return null;
  const d = dirRec.Direction, c = dirRec.Colour;
  const el = (Math.asin(Math.max(-1, Math.min(1, -d[2]))) * 180) / Math.PI;
  const az = ((((Math.atan2(d[1], d[0]) * 180) / Math.PI) % 360) + 360) % 360;
  const sun = Math.max(c[0], c[1], c[2]) || 1; // peak channel = strength; guard a degenerate all-zero record
  const seed: RefSunSeed = { el, az, sun, sunTint: rgbToHex([c[0] / sun, c[1] / sun, c[2] / sun]) };
  const ambRec = lights.find(l => l.Type === 3 && (l.Colour?.length ?? 0) >= 3);
  if (ambRec) {
    const a = ambRec.Colour, ambient = Math.max(a[0], a[1], a[2]) || 1;
    seed.ambient = ambient;
    seed.skyTint = rgbToHex([a[0] / ambient, a[1] / ambient, a[2] / ambient]);
  }
  return seed;
}

export interface ReferenceMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per-vertex UV, 0..1 across each patch (one tile per patch = the SSX model) for the textured view. */
  uvs: Float32Array;
  /** Per-vertex baked lightmap intensity A_S (0..1), present only when lightmaps were supplied. */
  intensity?: Float32Array;
  /** Per-vertex baked lightmap COLOUR (RGB, the coloured multiply), present only with lightmaps. */
  lightColor?: Float32Array;
  indices: Uint32Array;
  /** Tile (TexturePath) per emitted patch, in face order, or null - drives the textured-view groups. */
  patchTex: (string | null)[];
  /** SurfaceType per emitted patch, in face order - drives the test ride's per-surface feel (docs/016). */
  patchSurf: number[];
  /** The four tile-UV corners per emitted patch [uvA@(0,0), uvB@(0,1), uvC@(1,0), uvD@(1,1)], or null when
   *  the patch has no UVs - drives the tile-F overlay (the F is mapped through the patch's own UVs). */
  patchUV: (number[][] | null)[];
  /** The four editor-space corner positions per emitted patch [A@(0,0), B@(0,1), C@(1,0), D@(1,1)] - the
   *  surface stand-in the tile-F overlay evaluates its strokes on. */
  patchCorners: number[][][];
  /** The SIXTEEN bicubic control points per emitted patch (row-major, rows along u), editor space - the
   *  cell's full control net, for the selected-cell 16-point control-net overlay. patchCorners are indices
   *  0 / 3 / 12 / 15 of these; the other twelve are the off-surface tangent + twist handles. */
  patchControls: number[][][];
  /** Triangles per patch, so the textured view can address each patch's index range. */
  facesPerPatch: number;
  /** De-duplicated patch-corner positions (the control-point cloud) in editor space. */
  cornerPts: Float32Array;
  /** Curved control-net edges SHARED by two patches (interior seams), as tessellated segment endpoints. */
  cornerSeg: Float32Array;
  /** Curved control-net edges used by ONE patch that stand alone (the quilt's true outer rim), same format. */
  cornerSegBoundary: Float32Array;
  /** Every interior border edge that isn't a piece's outer rim - holes and unstitched tears alike (they read
   *  the same: a boundary loop inside the surface). Tessellated segment endpoints, drawn yellow; the depth
   *  dither then reads a watertight, tucked tear DIM and an exposed one BRIGHT. */
  cornerSegTear: Float32Array;
  /** Positions of EXTRAORDINARY control-net vertices whose interior-seam valence is 3 - the quad net
   *  pinches here (fewer than the regular four "Grid" edges meet). Rim/tear edges, which carry
   *  their own colour, are not counted, so only vertices irregular in the shared net are flagged. */
  cornerPtsExtra3: Float32Array;
  /** Positions of EXTRAORDINARY vertices whose interior-seam valence is 5 - the net fans wider here. */
  cornerPtsExtra5: Float32Array;
  /** The quilt's quad adjacency (patches = cells), for the shared face-loop / cell selection (surface.ts
   *  `faceLoop` / `faceBlock`) - built from the same boundary-edge dedup as the cage. */
  topology: SurfaceTopology;
  /** The quilt AS a QuadMesh (corners = cornerPts, one quad per emitted patch in face order) — so the shared
   *  `meshselect` edge queries (`meshEdgeLoop` / `meshEdgeSegments` / `hoveredEdge`) run on the reference the
   *  same as on the authored net. Read-only: the reference edits nothing. */
  mesh: QuadMesh;
  /** Faithful directed-edge handle from the STORED patch edge curves — pairs with `mesh` so a selected-edge
   *  highlight reproduces the reference's own boundary curves (not a Bessel re-derive). */
  edgeHandle: EdgeHandle;
  /** Editor-space AABB of the loaded quilt (before any view recenter). */
  min: V3;
  max: V3;
  patchCount: number;
}

/** Tessellation per patch - same as the authored preview (PREVIEW_RES = 8, snowknife's HD render bake), so the
 *  reference draws at the density the game renders. The ride never depends on this: contact Newton-refines onto
 *  the patch control net (`referencePatchContact` derives its lattice from `facesPerPatch`, whatever it is). */
const RES = 8;

/** Attach baked-lightmap samples to an already tessellated reference mesh. Keeping this separate from
 * `buildReferenceMesh` lets reload restore the visible terrain first, then fetch/decode the lighting study
 * only when it is requested, without paying the full tessellation cost a second time. */
export function applyReferenceLightmaps(mesh: ReferenceMesh, patches: RawPatch[], lightmaps: LightmapSet): boolean {
  if (referenceLightmapLayoutStats(patches).collapsed) {
    delete mesh.intensity;
    delete mesh.lightColor;
    return false;
  }
  const res = Math.max(1, Math.round(Math.sqrt(mesh.facesPerPatch / 2)));
  const side = res + 1, per = side * side;
  const vertices = mesh.positions.length / 3;
  const intensity = new Float32Array(vertices);
  const lightColor = new Float32Array(vertices * 3);
  intensity.fill(1); lightColor.fill(1);
  let emitted = 0;
  for (const patch of patches) {
    if (patch.Points.length < 16) continue;
    const lp = patch.LightMapPoint, id = patch.LightmapID;
    const map = id != null && lp && lp.length >= 4 ? lightmaps.get(id) : undefined;
    if (map) for (let iu = 0; iu < side; iu++) for (let iv = 0; iv < side; iv++) {
      const u = iu / res, v = iv / res;
      const [ru, rv] = remapLightmapUv(u, v);
      const vi = emitted * per + iu * side + iv;
      if (vi >= vertices) continue;
      intensity[vi] = sampleTile(map.a, lp![0], lp![1], lp![2], lp![3], ru, rv);
      const [r, g, b] = sampleTileRGB(map.rgb, lp![0], lp![1], lp![2], lp![3], ru, rv);
      lightColor[vi * 3] = r; lightColor[vi * 3 + 1] = g; lightColor[vi * 3 + 2] = b;
    }
    emitted++;
  }
  mesh.intensity = intensity;
  mesh.lightColor = lightColor;
  return true;
}

/**
 * Tessellate a parsed Patches.json into one renderable quilt of reference geometry. With `lightmaps`
 * (decoded A_S maps keyed by LightmapID), each vertex also carries the baked lightmap intensity it
 * samples - the ground truth the lighting study fits and validates against.
 */
function createReferenceMeshBuilder(patches: RawPatch[], lightmaps?: LightmapSet, res: number = RES) {
  const side = res + 1;
  const per = side * side;
  const n = patches.length;
  const positions = new Float32Array(n * per * 3);
  const normals = new Float32Array(n * per * 3); // analytic per-vertex normals (reconciled with gN below)
  const gN = new Float32Array(n * per * 3);      // accumulated geometric face normals, for the reconcile
  const colors = new Float32Array(n * per * 3);
  const uvs = new Float32Array(n * per * 2);
  const usableLightmaps = lightmaps && !referenceLightmapLayoutStats(patches).collapsed ? lightmaps : undefined;
  const intensity = usableLightmaps ? new Float32Array(n * per) : undefined;     // per-vertex baked A_S (1 = neutral)
  const lightColor = usableLightmaps ? new Float32Array(n * per * 3) : undefined; // per-vertex baked colour (1,1,1 = neutral)
  // Sized by the CALLER's res, not the module default — the lightmap bake tessellates denser than the display,
  // and a buffer sized off the constant silently dropped every index past the display density's worth.
  const indices = new Uint32Array(n * res * res * 6);
  const patchTex: (string | null)[] = [];
  const patchUV: (number[][] | null)[] = [];
  const patchSurf: number[] = [];        // per emitted patch: SurfaceType (drives the test ride's per-surface feel)
  const patchCorners: number[][][] = []; // per emitted patch: [A,B,C,D] editor-space corners (u,v = 0/1)
  const patchControls: number[][][] = []; // per emitted patch: all 16 bicubic control points (editor space)
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];

  // de-dup the patch corners (the four bicubic corners 0/3/12/15) and patch boundary edges, so the
  // control-point view shows the shared net once rather than every patch's own copy of a shared corner.
  // Each edge draws as the patch's actual cubic boundary curve (its four edge control points), not a
  // straight chord - watertight neighbours share those CPs, so the deduped net reads as the true edges.
  const EDGE_SEG = 6;
  const cornerIdx = new Map<string, number>();
  const cornerPts: number[] = [];
  // key each boundary edge by its two endpoint corners and count how many patches use it: an edge used by
  // two patches is an interior seam, one used by a single patch is on the quilt's border. Store the four
  // control points (watertight neighbours share the curve) and tessellate later, once classified. `faces`
  // collects every patch using the edge - the loop tracer's "opposite edge" test keys on shared patches -
  // and `cls` records which colour bucket the classification below put the edge in.
  type CageEdge = { cps: [V3, V3, V3, V3]; count: number; ka: string; kb: string; faces: number[]; cls?: EdgeCls };
  const edges = new Map<string, CageEdge>();
  // each patch's four boundary-edge keys in the order added (u=0 row, v=1 col, u=1 row, v=0 col), so a face
  // loop can step across a quad via its OPPOSITE edge (pairs (0,2) and (1,3)) - see faceLoopsFromPatch.
  const patchEdgeKeys: string[][] = [];
  // the quilt as a QuadMesh (corners = deduped cornerPts, one quad per emitted patch in FACE order): quad
  // [A@(0,0), B@(0,1), C@(1,0), D@(1,1)] = cp 0/3/12/15, the winding meshAdjacency reads (edges A-B,B-D,D-C,C-A
  // = the four patch boundaries). Lets the shared meshselect edge queries run on the reference exactly as on
  // the authored net; a faithful EdgeHandle (below) makes their curves match the reference's own cage wires.
  const quads: number[][] = [];
  const ckey = (p: V3) => `${Math.round(p[0] * 4)},${Math.round(p[1] * 4)},${Math.round(p[2] * 4)}`;
  const addCorner = (p: V3) => { const k = ckey(p); if (!cornerIdx.has(k)) { cornerIdx.set(k, cornerPts.length / 3); cornerPts.push(p[0], p[1], p[2]); } };
  const addEdge = (pi: number, p0: V3, p1: V3, p2: V3, p3: V3) => {
    const ka = ckey(p0), kb = ckey(p3), k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    (patchEdgeKeys[pi] ??= []).push(k);
    const e = edges.get(k);
    if (e) { e.count++; e.faces.push(pi); return; }
    edges.set(k, { cps: [p0, p1, p2, p3], count: 1, ka, kb, faces: [pi] });
  };

  // accumulate a triangle's (area-weighted) face normal into its three vertices' geometric normal
  const accumFace = (i0: number, i1: number, i2: number) => {
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const e1x = positions[i1 * 3] - ax, e1y = positions[i1 * 3 + 1] - ay, e1z = positions[i1 * 3 + 2] - az;
    const e2x = positions[i2 * 3] - ax, e2y = positions[i2 * 3 + 1] - ay, e2z = positions[i2 * 3 + 2] - az;
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    for (const j of [i0, i1, i2]) { gN[j * 3] += fx; gN[j * 3 + 1] += fy; gN[j * 3 + 2] += fz; }
  };

  let vp = 0, tp = 0, ip = 0;
  const emit = (pi: number) => {
    const cp = patches[pi].Points.map(editorFromRaw);
    if (cp.length < 16) return; // skip a malformed record rather than render garbage
    const tint = surfaceStyle(patches[pi].SurfaceType).color;
    patchTex.push(patches[pi].TexturePath ?? null);
    patchSurf.push(patches[pi].SurfaceType);
    // tile UVs: each stored UV corner binds to the geometry corner of the same index - uvA=c0 @(0,0),
    // uvB=c2 @(0,1), uvC=c1 @(1,0), uvD=c3 @(1,1) - matching the bake (TerrainBundle.cs). Exact one-tile
    // rectangles get its same seam-safe inset; D4 rotations/mirrors survive because this remaps each axis by
    // its own min/max. Falls back to 0..1.
    const uvp = patches[pi].UVPoints;
    const hasUv = !!(uvp && uvp.length >= 4);
    const uc = (i: number): [number, number] => (uvp && uvp[i] ? [uvp[i][0], uvp[i][1]] : [0, 0]);
    const [uvA, uvB, uvC, uvD] = insetReferenceUnitTile([uc(0), uc(2), uc(1), uc(3)]);
    patchUV.push(hasUv ? [uvA, uvB, uvC, uvD] : null); // corners @ (0,0),(0,1),(1,0),(1,1) - stays in step with patchTex
    patchCorners.push([cp[0], cp[3], cp[12], cp[15]]);  // world corners A@(0,0) B@(0,1) C@(1,0) D@(1,1)
    patchControls.push(cp);  // the full 16-point control net, same row-major order the loader read it in
    // per-patch lightmap tile: the patch owns sub-rect LightMapPoint of map LightmapID; sample its
    // intensity per vertex exactly like the bake (RemapUv mode 6 -> SampleTile). Falls back to 1 (neutral).
    const lp = patches[pi].LightMapPoint;
    const lmId = patches[pi].LightmapID;
    const lmMap = intensity && lmId != null && lp && lp.length >= 4 ? usableLightmaps!.get(lmId) : undefined;
    const vBase = vp / 3;
    for (let iu = 0; iu < side; iu++) {
      for (let iv = 0; iv < side; iv++) {
        const u = iu / res, v = iv / res;
        const p = patchPoint(cp, u, v);
        const nrm = patchNormal(cp, u, v);
        positions[vp] = p[0]; positions[vp + 1] = p[1]; positions[vp + 2] = p[2];
        normals[vp] = nrm[0]; normals[vp + 1] = nrm[1]; normals[vp + 2] = nrm[2];
        colors[vp] = tint[0]; colors[vp + 1] = tint[1]; colors[vp + 2] = tint[2];
        if (hasUv) { // Bilerp(A,B,C,D,u,v) = lerp(lerp(A,B,v), lerp(C,D,v), u)
          const a0 = uvA[0] + (uvB[0] - uvA[0]) * v, a1 = uvA[1] + (uvB[1] - uvA[1]) * v;
          const b0 = uvC[0] + (uvD[0] - uvC[0]) * v, b1 = uvC[1] + (uvD[1] - uvC[1]) * v;
          uvs[tp] = a0 + (b0 - a0) * u; uvs[tp + 1] = a1 + (b1 - a1) * u;
        } else { uvs[tp] = u; uvs[tp + 1] = v; }
        if (intensity && lightColor) {
          const vi = vBase + iu * side + iv;
          if (lmMap) {
            const [ru, rv] = remapLightmapUv(u, v);
            intensity[vi] = sampleTile(lmMap.a, lp![0], lp![1], lp![2], lp![3], ru, rv);
            const [r, g, b] = sampleTileRGB(lmMap.rgb, lp![0], lp![1], lp![2], lp![3], ru, rv);
            lightColor[vi * 3] = r; lightColor[vi * 3 + 1] = g; lightColor[vi * 3 + 2] = b;
          } else {
            intensity[vi] = 1; lightColor[vi * 3] = 1; lightColor[vi * 3 + 1] = 1; lightColor[vi * 3 + 2] = 1;
          }
        }
        for (let a = 0; a < 3; a++) {
          if (p[a] < min[a]) min[a] = p[a];
          if (p[a] > max[a]) max[a] = p[a];
        }
        vp += 3; tp += 2;
      }
    }
    for (let iu = 0; iu < res; iu++) {
      for (let iv = 0; iv < res; iv++) {
        const a = vBase + iu * side + iv;
        const b = a + 1;
        const c2 = vBase + (iu + 1) * side + iv;
        const d = c2 + 1;
        // wound to match the preview (the material is double-sided, so lighting is correct either way)
        indices[ip++] = a; indices[ip++] = d; indices[ip++] = c2;
        indices[ip++] = a; indices[ip++] = b; indices[ip++] = d;
        accumFace(a, d, c2); accumFace(a, b, d); // feed the geometric-normal reconcile
      }
    }
    // patch corners (row-major, rows along u): 0=(0,0) 3=(0,1) 15=(1,1) 12=(1,0); add the four, then
    // each boundary as its cubic edge (the four control points along that side of the 4x4 net).
    addCorner(cp[0]); addCorner(cp[3]); addCorner(cp[15]); addCorner(cp[12]);
    // the QuadMesh quad for this emitted patch: [A@(0,0), B@(0,1), C@(1,0), D@(1,1)] = cp 0/3/12/15 as corner ids
    quads.push([cornerIdx.get(ckey(cp[0]))!, cornerIdx.get(ckey(cp[3]))!, cornerIdx.get(ckey(cp[12]))!, cornerIdx.get(ckey(cp[15]))!]);
    addEdge(pi, cp[0], cp[1], cp[2], cp[3]);      // u=0 row  (corner 0 -> 3)
    addEdge(pi, cp[3], cp[7], cp[11], cp[15]);    // v=1 col  (corner 3 -> 15)
    addEdge(pi, cp[15], cp[14], cp[13], cp[12]);  // u=1 row  (corner 15 -> 12)
    addEdge(pi, cp[12], cp[8], cp[4], cp[0]);     // v=0 col  (corner 12 -> 0)
  };
  function* finishSteps(): Generator<void, ReferenceMesh> {
  // Reconcile the analytic normals with the accumulated geometric ones: sign each to match, and fall
  // back to the geometric normal where the analytic one diverges past 30 deg (collapsed / near-degenerate
  // patch corners, where the bezier tangents are ill-conditioned). Matches the bake (TerrainBundle.cs),
  // so high-valence stitch points shade smoothly instead of going dark.
  const DIV_COS = Math.cos((30 * Math.PI) / 180);
  for (let i = 0; i < normals.length; i += 3) {
    if (i > 0 && i % (4096 * 3) === 0) yield;
    const gl = Math.hypot(gN[i], gN[i + 1], gN[i + 2]);
    if (gl < 1e-9) continue;
    const gx = gN[i] / gl, gy = gN[i + 1] / gl, gz = gN[i + 2] / gl;
    let nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
    let dot = nx * gx + ny * gy + nz * gz;
    if (dot < 0) { nx = -nx; ny = -ny; nz = -nz; dot = -dot; }
    if (dot < DIV_COS) { nx = gx; ny = gy; nz = gz; }
    normals[i] = nx; normals[i + 1] = ny; normals[i + 2] = nz;
  }
  // Weld normals across coincident patch-boundary vertices (rounded to ~1cm, the bake's seam-weld
  // resolution) so real-time lighting is continuous across seams / high-valence stitch points - the
  // editor lights by these vertex normals, where Unity uses the seam-continuous baked lightmap. Only
  // genuinely-shared vertices are welded; an interior vertex (unique position) keeps its reconciled
  // normal so steep / vertical faces (rock walls, overhangs) whose normals are near-horizontal stay
  // correct. Within a shared group, align each contributor to the group's reference before averaging so
  // the mixed patch windings (~3.5% are reversed) reinforce instead of cancelling; the double-sided
  // material flips the result per-face, so only the welded axis matters.
  const nkey = (i: number) => `${Math.round(positions[i] * 100)},${Math.round(positions[i + 1] * 100)},${Math.round(positions[i + 2] * 100)}`;
  const nGroups = new Map<string, number[]>();
  for (let i = 0; i < normals.length; i += 3) {
    if (i > 0 && i % (4096 * 3) === 0) yield;
    const k = nkey(i), g = nGroups.get(k);
    if (g) g.push(i); else nGroups.set(k, [i]);
  }
  let weldGroup = 0;
  for (const g of nGroups.values()) {
    if (weldGroup++ > 0 && weldGroup % 4096 === 0) yield;
    if (g.length < 2) continue; // unique interior vertex: leave its reconciled normal untouched
    const r0 = normals[g[0]], r1 = normals[g[0] + 1], r2 = normals[g[0] + 2]; // group reference
    let sx = 0, sy = 0, sz = 0;
    for (const i of g) {
      const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
      const s = nx * r0 + ny * r1 + nz * r2 < 0 ? -1 : 1; // align to reference, don't cancel
      sx += s * nx; sy += s * ny; sz += s * nz;
    }
    const l = Math.hypot(sx, sy, sz);
    if (l < 1e-9) continue;
    sx /= l; sy /= l; sz /= l;
    for (const i of g) { normals[i] = sx; normals[i + 1] = sy; normals[i + 2] = sz; }
  }
  // classify edges. count >= 2 = an interior seam (shared by two patches, the blue grid). count == 1 = a BORDER
  // edge: either a piece's outer RIM (orange) or an interior TEAR (yellow) - a hole or an unstitched slit inside
  // the surface, treated the same. Border edges chain corner-to-corner into loops; per piece the widest loop is
  // the rim and every other loop is a tear. Occluded cage lines dither dim, so a WATERTIGHT tear (both lips
  // tucked into the surface - e.g. a snow drift folded onto a rock face) reads dim, an EXPOSED tear bright.
  const cornerSeg: number[] = [], cornerSegBoundary: number[] = [], cornerSegTear: number[] = [];
  // interior-seam valence per de-duplicated corner: how many "Grid" edges (shared by two patches, not
  // rim/tear) meet at it. 4 is regular; 3/5 mark the extraordinary poles of the quad net.
  const valence = new Int32Array(cornerPts.length / 3);

  const border: CageEdge[] = [];
  let classifiedEdge = 0;
  for (const e of edges.values()) {
    if (classifiedEdge++ > 0 && classifiedEdge % 2048 === 0) yield;
    if (e.count >= 2) { e.cls = 'grid'; pushCubicEdge(cornerSeg, e.cps[0], e.cps[1], e.cps[2], e.cps[3], EDGE_SEG); valence[cornerIdx.get(e.ka)!]++; valence[cornerIdx.get(e.kb)!]++; }
    else border.push(e);
  }
  // surface connected components (over EVERY edge, interior seams included): each disconnected surface piece is
  // its own component. Used only to scope the rim below, so each piece keeps its own orange outer silhouette
  // rather than one rim being picked for the whole map (the rest would then wrongly read as cyan holes).
  const sf = new Map<string, string>();
  const sTouch = (k: string) => { if (!sf.has(k)) sf.set(k, k); };
  const sFind = (x: string): string => { while (sf.get(x) !== x) { const p = sf.get(x)!; sf.set(x, sf.get(p)!); x = sf.get(x)!; } return x; };
  for (const e of edges.values()) { sTouch(e.ka); sTouch(e.kb); const ra = sFind(e.ka), rb = sFind(e.kb); if (ra !== rb) sf.set(ra, rb); }
  // union-find the border edges into loops by shared corner: each surface piece's border falls into its OUTER
  // silhouette (one big loop) plus a small closed loop around every interior opening / unstitched slit.
  const parent = new Map<string, string>();
  const touch = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
  const find = (x: string): string => { while (parent.get(x) !== x) { const p = parent.get(x)!; parent.set(x, parent.get(p)!); x = parent.get(x)!; } return x; };
  for (const e of border) { touch(e.ka); touch(e.kb); const ra = find(e.ka), rb = find(e.kb); if (ra !== rb) parent.set(ra, rb); }
  const loop = new Map<string, { comp: string; min: V3; max: V3 }>();
  border.forEach((e) => {
    const r = find(e.ka);
    let c = loop.get(r);
    if (!c) { c = { comp: sFind(e.ka), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; loop.set(r, c); }
    for (const p of [e.cps[0], e.cps[3]]) for (let a = 0; a < 3; a++) { if (p[a] < c.min[a]) c.min[a] = p[a]; if (p[a] > c.max[a]) c.max[a] = p[a]; }
  });
  // Per piece, the largest-bounding-box loop is that piece's outer RIM (orange); every OTHER border loop is an
  // interior TEAR (yellow) - a hole or an unstitched slit, treated alike. Scoping the rim per component keeps
  // each disconnected piece's own orange outer edge instead of all-but-one reading as a tear. Whether a tear is
  // watertight is left to the depth dither (a tucked, occluded tear draws dim; an exposed one bright).
  const diag = (c: { min: V3; max: V3 }) => Math.hypot(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]);
  const outerOfComp = new Map<string, { root: string; diag: number }>();
  for (const [r, c] of loop) { const d = diag(c); const cur = outerOfComp.get(c.comp); if (!cur || d > cur.diag) outerOfComp.set(c.comp, { root: r, diag: d }); }
  border.forEach((e) => {
    const r = find(e.ka), c = loop.get(r)!;
    e.cls = outerOfComp.get(c.comp)!.root === r ? 'rim' : 'tear';              // piece outer silhouette, else interior tear
    pushCubicEdge(e.cls === 'rim' ? cornerSegBoundary : cornerSegTear, e.cps[0], e.cps[1], e.cps[2], e.cps[3], EDGE_SEG);
  });
  // split the deduped corners into the two extraordinary classes by their interior-seam valence.
  const extra3: number[] = [], extra5: number[] = [];
  for (let i = 0; i < valence.length; i++) {
    if (valence[i] === 3) extra3.push(cornerPts[i * 3], cornerPts[i * 3 + 1], cornerPts[i * 3 + 2]);
    else if (valence[i] === 5) extra5.push(cornerPts[i * 3], cornerPts[i * 3 + 1], cornerPts[i * 3 + 2]);
  }
  // the deduped edge list + each edge's two corner ids, feeding the quad topology and the faithful edge handle.
  const edgeArr = [...edges.values()];
  const edgeEnds = edgeArr.map(e => [cornerIdx.get(e.ka)!, cornerIdx.get(e.kb)!] as [number, number]);
  // resolve each patch's four recorded edge keys to edge indices, so the quad topology maps patch to patch.
  const keyToEi = new Map<string, number>();
  edgeArr.forEach((e, ei) => { keyToEi.set(e.ka < e.kb ? `${e.ka}|${e.kb}` : `${e.kb}|${e.ka}`, ei); });
  // the quilt as a general quad mesh: each patch's four edges in order, each edge's ≤2 patches (its faces),
  // and whether an edge touches an extraordinary POLE (interior-seam valence 3 or ≥5, the same classification
  // as the violet/magenta pole dots) - a face loop stops at poles, where the continuation is ambiguous.
  const isPole = (ci: number) => valence[ci] === 3 || valence[ci] >= 5;
  const topology: SurfaceTopology = {
    cellCount: n,
    cellEdges: patchEdgeKeys.map(keys => keys.map(k => keyToEi.get(k) ?? -1)),
    edgeCells: edgeArr.map(e => e.faces),
    edgeTouchesPole: edgeEnds.map(([a, b]) => isPole(a) || isPole(b)),
  };
  // The quilt as a shared QuadMesh + a FAITHFUL directed-edge handle, so the authored net's edge-select
  // queries (meshEdgeLoop / meshEdgeSegments) run on the reference unchanged. For edge {a,b} with stored
  // curve cps [p0,p1,p2,p3] where a=id(p0), b=id(p3): from a the handle is p1−p0, from b it's p2−p3 — so
  // meshEdgeSegments' pushCubicEdge(p0,p1,p2,p3) reproduces the reference's own boundary curve (the same one
  // cornerSeg draws), not a Bessel re-derive that would drift off the real edge.
  const mesh = buildQuadMesh(cornerPts, quads);
  const eidKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const handleByEdge = new Map<string, { a: number; ha: V3; hb: V3 }>();
  edgeArr.forEach((e, ei) => {
    const [a, b] = edgeEnds[ei]; // a = id(p0), b = id(p3)
    handleByEdge.set(eidKey(a, b), { a, ha: sub(e.cps[1], e.cps[0]), hb: sub(e.cps[2], e.cps[3]) });
  });
  const edgeHandle: EdgeHandle = (from, to) => {
    const h = handleByEdge.get(eidKey(from, to));
    if (!h) return [0, 0, 0];
    return from === h.a ? h.ha : h.hb;
  };
  return {
    positions, normals, colors, uvs, intensity, lightColor, indices,
    patchTex, patchUV, patchSurf, patchCorners, patchControls, facesPerPatch: res * res * 2,
    cornerPts: new Float32Array(cornerPts),
    cornerSeg: new Float32Array(cornerSeg), cornerSegBoundary: new Float32Array(cornerSegBoundary),
    cornerSegTear: new Float32Array(cornerSegTear),
    cornerPtsExtra3: new Float32Array(extra3), cornerPtsExtra5: new Float32Array(extra5),
    topology, mesh, edgeHandle,
    min, max, patchCount: n,
  };
  }
  return { patchCount: n, emit, finishSteps };
}

/** The deterministic synchronous builder used by exports, tests, and small reference payloads. */
export function buildReferenceMesh(patches: RawPatch[], lightmaps?: LightmapSet, res: number = RES): ReferenceMesh {
  const builder = createReferenceMeshBuilder(patches, lightmaps, res);
  for (let pi = 0; pi < builder.patchCount; pi++) builder.emit(pi);
  const finalizer = builder.finishSteps();
  for (;;) {
    const step = finalizer.next();
    if (step.done) return step.value;
  }
}

export interface ProgressiveReferenceMeshOptions {
  /** Approximate main-thread time spent tessellating before yielding for a browser paint. */
  frameBudgetMs?: number;
  /** Browser-aware yield supplied by the load-status host; defaults to a zero-delay task. */
  yieldControl?: () => Promise<void>;
  onProgress?: (completed: number, total: number) => void;
}

/** Tessellate the same mesh as buildReferenceMesh while returning to the browser between bounded patch and
 * normal-weld chunks. Source indices and every output buffer remain byte-for-byte deterministic. */
export async function buildReferenceMeshProgressive(
  patches: RawPatch[], options: ProgressiveReferenceMeshOptions = {}, lightmaps?: LightmapSet,
  res: number = RES,
): Promise<ReferenceMesh> {
  const builder = createReferenceMeshBuilder(patches, lightmaps, res);
  const budget = Math.max(0, options.frameBudgetMs ?? 10);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  let chunkStarted = now();
  options.onProgress?.(0, builder.patchCount);
  for (let pi = 0; pi < builder.patchCount; pi++) {
    builder.emit(pi);
    if (now() - chunkStarted >= budget && pi + 1 < builder.patchCount) {
      options.onProgress?.(pi + 1, builder.patchCount);
      await yieldControl();
      chunkStarted = now();
    }
  }
  options.onProgress?.(builder.patchCount, builder.patchCount);
  if (builder.patchCount) { await yieldControl(); chunkStarted = now(); }
  const finalizer = builder.finishSteps();
  for (;;) {
    const step = finalizer.next();
    if (step.done) return step.value;
    if (now() - chunkStarted >= budget) {
      await yieldControl();
      chunkStarted = now();
    }
  }
}
