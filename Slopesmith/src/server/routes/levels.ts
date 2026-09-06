import { join } from 'node:path';
import { mapsRoot } from '../workspace-config';
import { listEntries, mapLimit, pathExists, readBytesOrNull, readJsonOr, READ_CONCURRENCY } from '../fs-async';
import type {
  RawPatch, CoursePathFile, InstancesFile, LightsFile, RefAiPath, RefShowoffCheckpoint, RefSplineRaw, RefSunSeed,
} from '../../core/reference/terrain';
import {
  aiJumpMarkers, dtfZeroFrame, extractMainCourse, reconstructPathLine, showoffCheckpoints, stageAreaAnchors, sunFromLights,
} from '../../core/reference/terrain';
import type { LightRigPayload } from '../../core/reference/lights';
import { decodeBillboards, type ReferenceScreen } from '../../core/reference/screens';
import { normalizeGodRayCourse, type GodRayCourse } from '../../core/lighting/god-rays';
import type { V3 } from '../../core/doc/types';
import {
  normalizeLaps, normalizeShowoffSeconds, referenceLaps, referenceShowoffSeconds,
} from '../../core/doc/race';
import {
  MAP_ORIGIN_FILE, MAP_ORIGIN_SCHEMA, UNCLASSIFIED_EXPORT_REASON, UNMARKED_ORIGIN, normalizeMapOrigin,
  originSummary, type MapOriginRecord, type MapOriginSummary,
} from '../../core/export/origin';
import { SLOPESMITH_EXPORT_MANIFEST, isSlopesmithExportManifest } from '../../core/export/manifest';
import { safeDataName } from './safe-name';

/**
 * Serve extracted-level terrain to the editor's reference layer. Reads Maps/<name>/Patches.json
 * straight off disk - the same folder `snowknife import` writes and Slopesmith exports.
 */

/** Level folders under Maps/ that carry a Patches.json (extracted or Slopesmith-authored). */
export async function listLevels(): Promise<string[]> {
  // Offline import commands publish through a hidden sibling and rename only once their contract is complete.
  // Never advertise one of those staging folders if a long import writes Patches.json while the server is open.
  const dirs = (await listEntries(mapsRoot()))
    .filter(entry => entry.isDirectory && !entry.name.startsWith('.')).map(entry => entry.name);
  const present = await mapLimit(dirs, READ_CONCURRENCY,
    name => pathExists(join(mapsRoot(), name, 'Patches.json')));
  return dirs.filter((_name, index) => present[index]).sort();
}

/**
 * What a map folder is, and whether it carries retail bytes (core/export/origin.ts).
 *
 * Three answers in falling order of authority. `Origin.json` is the folder saying so itself, written by
 * whichever tool produced it. Without one, a `Slopesmith.json` export manifest still identifies the folder as
 * authored, and its provenance block answers the second question — an export made before that block existed
 * says nothing, and is read as carrying retail data rather than as clean. With neither, the folder is an
 * extract: an unmarked directory in a Maps library got there by `snowknife import`, and the failure that
 * matters is describing retail bytes as authored, not describing an authored mountain as an extract until its
 * author re-exports it.
 *
 * Never throws. A folder that cannot be read at all reads as retail, which is the conservative direction.
 */
export async function readLevelOrigin(name: string): Promise<MapOriginRecord> {
  const safe = safeDataName(name);
  const dir = join(mapsRoot(), safe);
  const stated = normalizeMapOrigin(await readJsonOr<unknown>(join(dir, MAP_ORIGIN_FILE), null));
  if (stated) return stated;

  const manifest = await readJsonOr<unknown>(join(dir, SLOPESMITH_EXPORT_MANIFEST), null);
  if (!isSlopesmithExportManifest(manifest)) return UNMARKED_ORIGIN;
  const provenance = manifest.provenance;
  const reasons = (provenance?.reasons ?? []).filter(reason => reason.startsWith('retail-'));
  // `retailDerived` absent is the legacy case, not a denial: the guard that computes it postdates these
  // folders, so there is no evidence either way and the conservative reading stands.
  const retailData = provenance ? provenance.retailDerived : true;
  return {
    Schema: MAP_ORIGIN_SCHEMA,
    Origin: 'slopesmith',
    RetailData: retailData,
    Reasons: retailData ? (reasons.length ? reasons : [UNCLASSIFIED_EXPORT_REASON]) : [],
  };
}

/** Every level folder with the origin summary the reference picker lists it by. One read per folder, so it
 *  rides the same concurrency limit the presence scan above uses. */
export async function listLevelOrigins(): Promise<MapOriginSummary[]> {
  const names = await listLevels();
  const origins = await mapLimit(names, READ_CONCURRENCY, name => readLevelOrigin(name));
  return names.map((name, index) => originSummary(name, origins[index]));
}

/** Read a level's Patches.json, trimmed to what the reference renderer needs (points + surface). */
export async function readLevelPatches(name: string): Promise<{ name: string; patches: RawPatch[] }> {
  const safe = safeDataName(name);
  const json = await readJsonOr<{ Patches?: unknown[] } | null>(join(mapsRoot(), safe, 'Patches.json'), null);
  if (!json) throw new Error(`no Patches.json for level "${safe}"`);
  const arr = (json.Patches ?? (json as unknown as unknown[])) as Array<Record<string, unknown>>;
  const patches: RawPatch[] = arr.map(p => ({
    Points: p.Points as number[][],
    SurfaceType: p.SurfaceType as number,
    TexturePath: p.TexturePath as string | undefined,
    UVPoints: p.UVPoints as number[][] | undefined,
    LightMapPoint: p.LightMapPoint as number[] | undefined,
    LightmapID: p.LightmapID as number | undefined,
  }));
  return { name: safe, patches };
}

/** The level's recovered main course line: the stitched racing line in editor space, its arc length and
 *  vertical drop, which file it came from, and where the race actually starts and ends. */
export interface LevelCourse {
  source: string;
  points: V3[];
  length: number;
  drop: number;
  /** `Mdl_StageArea_Start_0` — where the engine stages the six riders. NOT either end of `points`. */
  start: V3 | null;
  /** The finish LINE: distance-to-finish zero on the race lines. Null when no line reaches zero. */
  finish: V3 | null;
  /** The racing direction through that crossing — the finish plane's normal for the lap countdown. */
  finishFwd: V3 | null;
  /** `Mdl_StageArea_Finish_0` — the post-race corral 20–48 m PAST `finish`, not the crossing. */
  podium: V3 | null;
  /** SOP type-11 checkpoint events and their seconds payloads. */
  checkpoints: RefShowoffCheckpoint[];
}

/**
 * Recover a level's main top-to-bottom course line for the reference layer. Prefers SOP.json (the
 * curated spline-object paths) and falls back to AIP.json (the AI paths) - both carry the same
 * DistanceToFinish-keyed RaceLines, so they reconstruct the same run; SOP is the cleaner authored set.
 * Returns null (not an error) when the level has no usable path file, so the reference still loads.
 *
 * The endpoints come from elsewhere, because neither end of the recovered line is one: the start is the
 * level's own `Mdl_StageArea_Start_0` instance, and the finish is the DTF=0 crossing, which sits 25-61 m
 * BEFORE the last race-line vertex. On a lap course the gap is dramatic - Tokyo Megaplex's grid is 343 m
 * below the top of its lap loop, which is where the line's head lands.
 */
export async function readLevelCourse(name: string): Promise<LevelCourse | null> {
  const safe = safeDataName(name);
  // The staging anchors live in Instances.json; DTF=0 prefers the `.aip` authoring, which is the copy that
  // lands on the finish arch where the two files disagree ([Trailmap: 250-paths-aip-sop]).
  const [instances, aip] = await Promise.all([
    readJsonOr<InstancesFile | null>(join(mapsRoot(), safe, 'Instances.json'), null),
    readJsonOr<CoursePathFile | null>(join(mapsRoot(), safe, 'AIP.json'), null),
  ]);
  const anchors = instances ? stageAreaAnchors(instances) : { start: null, podium: null };

  for (const file of ['SOP.json', 'AIP.json']) {
    const raw = file === 'AIP.json' ? aip : await readJsonOr<CoursePathFile | null>(join(mapsRoot(), safe, file), null);
    if (!raw) continue;
    try {
      const points = extractMainCourse(raw);
      if (!points || points.length < 2) continue;
      let length = 0, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
        if (i) length += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1], p[2] - points[i - 1][2]);
      }
      const finish = dtfZeroFrame(aip ?? raw) ?? dtfZeroFrame(raw);
      return {
        source: file.replace('.json', ''), points, length, drop: maxY - minY,
        start: anchors.start, finish: finish?.pos ?? null, finishFwd: finish?.fwd ?? null,
        podium: anchors.podium,
        checkpoints: file === 'SOP.json' ? showoffCheckpoints(raw) : [],
      };
    } catch { /* unreadable / unexpected shape - try the next file */ }
  }
  return null;
}

/**
 * How many passes a loaded reference is raced over. A Slopesmith-authored folder states it in its own export
 * sidecar — the only file that can hold it — and an extracted retail level is answered from the slot table,
 * because retail keeps no lap data in its level files at all (core/doc/race). Never fails: a level we ship no
 * knowledge of is a single pass, same as every course but one.
 */
export async function readLevelLaps(name: string): Promise<number> {
  return (await readLevelRace(name)).laps;
}

/**
 * The same question for the SHOWOFF clock, answered the same two ways: an authored folder's sidecar first, then
 * retail's own per-course table (core/doc/race). Both come off one read of the sidecar, since a folder that has
 * one has it for both numbers.
 */
export async function readLevelShowoffSeconds(name: string): Promise<number> {
  return (await readLevelRace(name)).showoffSeconds;
}

async function readLevelRace(name: string): Promise<{ laps: number; showoffSeconds: number }> {
  const safe = safeDataName(name);
  const sidecar = await readJsonOr<{ laps?: unknown; showoffSeconds?: unknown } | null>(
    join(mapsRoot(), safe, 'Slopesmith.json'), null);
  return {
    laps: normalizeLaps(sidecar?.laps) ?? referenceLaps(safe),
    showoffSeconds: normalizeShowoffSeconds(sidecar?.showoffSeconds) ?? referenceShowoffSeconds(safe),
  };
}

/**
 * Read a level's AI-path network (AIP.json `AIPaths`) for the Info-mode overlay: every path reconstructed
 * into editor space, with `StartPosList` members flagged (one assigned route per race-grid slot). This is the
 * OPPONENT network — the main racing line is readLevelCourse's business. Returns null when the level ships
 * no AIP.json (or nothing reconstructable), so the overlay just shows nothing.
 */
export async function readLevelAiPaths(name: string): Promise<RefAiPath[] | null> {
  const safe = safeDataName(name);
  const raw = await readJsonOr<CoursePathFile | null>(join(mapsRoot(), safe, 'AIP.json'), null);
  if (!raw) return null;
  try {
    const starts = new Set(raw.StartPosList ?? []);
    const paths = (raw.AIPaths ?? [])
      .map((p, i) => ({
        name: p.Name ?? `AI Path ${i}`, start: starts.has(i), rating: p.U3 ?? 50,
        // The two fields the AI field reads besides the points ([Trailmap: 395]): where it may be put back after a
        // fall, and where it jumps. Levels we generate ship neither yet, and default sensibly.
        respawnable: p.Respawnable !== false,
        markers: aiJumpMarkers(p),
        points: reconstructPathLine(p),
      }))
      .filter(p => p.points.length >= 2);
    return paths.length ? paths : null;
  } catch {
    return null; // unreadable / unexpected shape — the overlay falls back to empty
  }
}

/**
 * Seed the authored sun from a level's own Lights.json light records (the level's TRUE HDR sun + sky),
 * the same way readLevelCourse recovers its course line. The inversion lives in core (sunFromLights);
 * this just reads the file off disk. Returns null when the level ships no Lights.json (or no directional
 * record), so the reference loader falls back to the lightmap fit.
 */
export async function readLevelLights(name: string): Promise<RefSunSeed | null> {
  const safe = safeDataName(name);
  const raw = await readJsonOr<LightsFile | null>(join(mapsRoot(), safe, 'Lights.json'), null);
  if (!raw) return null;
  try {
    return sunFromLights(raw);
  } catch {
    return null; // unexpected shape -> fall back to the fit
  }
}

/**
 * Read a level's `Billboards.json` — the video SCREENS `snowknife billboards` measured off its boards, or the
 * ones its author placed (docs/051). Editor-space rectangles, so the reference layer can draw them beside the
 * author's own. Empty when the level has none, which is every folder extracted before the contract existed.
 */
export async function readLevelBillboards(name: string): Promise<ReferenceScreen[]> {
  const safe = safeDataName(name);
  const raw = await readJsonOr<unknown>(join(mapsRoot(), safe, 'Billboards.json'), null);
  return raw ? decodeBillboards(raw) : [];
}

/**
 * Read a level's World.json — the course's world-configuration settings, which do NOT live in its level
 * files: they are per-course data the executable carries, so `snowknife import` reads them off the disc and
 * writes them beside the geometry. Today that means the celestial glare (docs/049). Returns null when the
 * level has no World.json (extracted before the contract existed, or an authored map that never set one),
 * which every consumer treats as "no glare" rather than an error.
 */
export async function readLevelWorld(name: string): Promise<GodRayCourse | null> {
  const safe = safeDataName(name);
  const raw = await readJsonOr<RawWorldFile | null>(join(mapsRoot(), safe, 'World.json'), null);
  const g = raw?.Glare;
  if (!g) return null;
  // These are required parts of the current contract. Old extracts must be re-run rather than silently
  // receiving project-authored brightness values that did not come from their WorldConf record.
  if (!Number.isFinite(g.FanIntensity) || !Number.isFinite(g.SpriteIntensity)) return null;
  const rgb = (a: number[] | undefined, fb: [number, number, number]): [number, number, number] =>
    a && a.length >= 3 ? [Number(a[0]), Number(a[1]), Number(a[2])] : fb;
  return normalizeGodRayCourse({
    enabled: !!g.Enabled,
    core: rgb(g.CoreColour, [255, 255, 255]),
    fanIntensity: Number(g.FanIntensity),
    rim: rgb(g.RimColour, [128, 128, 128]),
    spriteIntensity: Number(g.SpriteIntensity),
    az: Number(g.AzimuthDegrees),
    el: Number(g.ElevationDegrees),
    distance: Number(g.DistanceUnits),
    size: Number(g.SizeUnits),
  });
}

/** The slice of World.json this reads. Written by `snowknife import` / `snowknife world`. */
interface RawWorldFile {
  Glare?: {
    Enabled?: boolean;
    CoreColour?: number[];
    FanIntensity: number;
    RimColour?: number[];
    SpriteIntensity: number;
    AzimuthDegrees?: number;
    ElevationDegrees?: number;
    DistanceUnits?: number;
    SizeUnits?: number;
  };
}

/** One raw Lights.json record — the full field set as `snowknife import` writes it (only the ones the light-rig
 *  overlay reads are typed; the rest are ignored). */
interface RawLightRecord {
  LightName?: string;
  Type?: number;
  Colour?: number[];
  Direction?: number[];
  Position?: number[];
  LowestXYZ?: number[];
  HighestXYZ?: number[];
  /** Glow-sprite resolution — the engine's runtime GLINT gate (`& 0x70`; core/lighting/glints). */
  SpriteRes?: number;
  /** Spot cone half-angle cosine. */
  UnknownFloat2?: number;
}

/**
 * Read a level's WHOLE light rig (Lights.json) for the read-only reference overlay — every sun / ambient /
 * spot / point record trimmed to what the viewport draws. This is the full-rig companion to readLevelLights
 * (which pulls only the ONE directional + ambient to seed the authored sun). Returns null when the level
 * ships no Lights.json, so the overlay just shows nothing.
 */
export async function readLevelLightRig(name: string): Promise<LightRigPayload | null> {
  const safe = safeDataName(name);
  const raw = await readJsonOr<{ Lights?: RawLightRecord[] } | null>(join(mapsRoot(), safe, 'Lights.json'), null);
  if (!raw) return null;
  try {
    const num3 = (a: number[] | undefined, fb: number[]) =>
      (a && a.length >= 3 ? [a[0], a[1], a[2]] : fb).map(Number);
    const lights = (raw.Lights ?? []).map(l => {
      const pos = num3(l.Position, [0, 0, 0]);
      return {
        name: String(l.LightName ?? ''),
        type: Number(l.Type ?? 1),
        colour: num3(l.Colour, [0, 0, 0]),
        dir: num3(l.Direction, [0, 0, -1]),
        pos,
        lo: num3(l.LowestXYZ, pos),
        hi: num3(l.HighestXYZ, pos),
        cone: Number(l.UnknownFloat2 ?? 1),
        spriteRes: Number(l.SpriteRes ?? 0) | 0,
      };
    });
    return { level: safe, lights };
  } catch {
    return null; // unreadable / unexpected shape — the overlay falls back to empty
  }
}

/** One raw Splines.json record — the fields the grind reads (control points stay in raw SSX space; the
 *  client maps them through editorFromRaw like every other reference dataset). */
interface RawSplineRecord {
  SplineName?: string;
  SplineStyle?: number;
  Segments?: { Points?: number[][] }[];
}

/** Decode the shared native spline table without compacting its indices. Kept separate from the file read so
 *  the index-preservation contract can be tested without requiring a user's extracted retail Maps library. */
export function levelSplinesFromNative(raw: { Splines?: RawSplineRecord[] }): RefSplineRaw[] | null {
  const splines = (raw.Splines ?? [])
    .map((s, originalIndex) => ({
      originalIndex,
      name: String(s.SplineName ?? ''),
      style: Number(s.SplineStyle),
      segments: (s.Segments ?? [])
        .map(seg => seg.Points ?? [])
        .filter(pts => pts.length === 4 && pts.every(p => p.length >= 3)),
    }))
    .filter(s => s.segments.length > 0);
  return splines.length ? splines : null;
}

/**
 * Read every well-formed native spline while preserving its original table index. The ride layer applies the
 * shared style-or-`Rail`-name candidacy rule; animation-only routes remain available to stable effect references such as
 * `spline:0038`. Keeping the filtering at the consumer prevents compacted indices from pointing effects at the
 * next unrelated rail.
 */
export async function readLevelSplines(name: string): Promise<RefSplineRaw[] | null> {
  const safe = safeDataName(name);
  const raw = await readJsonOr<{ Splines?: RawSplineRecord[] } | null>(join(mapsRoot(), safe, 'Splines.json'), null);
  if (!raw) return null;
  try {
    return levelSplinesFromNative(raw);
  } catch {
    return null; // unreadable / unexpected shape — reference grind and effect routes stay unavailable
  }
}

/** Read a level lightmap PNG (Lightmaps/000N.png; RGB = C_S residual, alpha = A_S intensity) for the
 *  lighting study to decode client-side. Throws if the level / id has no map. */
export async function readLightmapPng(name: string, id: number): Promise<Buffer> {
  const safe = safeDataName(name);
  const file = join(mapsRoot(), safe, 'Lightmaps', String(Math.max(0, id | 0)).padStart(4, '0') + '.png');
  const bytes = await readBytesOrNull(file);
  if (!bytes) throw new Error(`no lightmap ${safe}/${id}`);
  return bytes;
}
