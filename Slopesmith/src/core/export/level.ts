import type { Gem, PlacedProp, QuadMeshDoc, Rail, Screen, SunLight, V3 } from '../doc/types';
import { screenPose, screenProp } from '../props/screen';
import { isEffectTriggerProp } from '../effects/trigger-volume';
import type { EditDoc } from '../doc/doc-edit';
import { surfaceStyle, DEFAULT_SUN } from '../doc/types';
import { bakeLightmaps, type DiffuseSampler } from '../lighting/bake';
import type { GodRayCourse } from '../lighting/god-rays';
import { propInstanceLight, roundPropLight, type PropInstanceLight } from '../lighting/prop-lights';
import { authoredRig, type PlacedLight } from '../lighting/sign-lights';
import { glintSizeClass } from '../lighting/glints';
import { nativeSplineFields, railBezierSegments, railStyle, RAIL_STYLE_ICE } from '../rails/rails';
import { deriveQuadMesh, type DerivedQuadMesh } from '../doc/mountain';
import { quadControlPoints } from '../mesh/topology';
import { aiLineRatings, aiPathLines, courseCenters, finishFrame, startFrame, startGateLines, startGateBoxes, DEFAULT_AI_SEED, DEFAULT_LINE_RATING, type GateBox } from '../doc/course';
import { generateTexture, sampleRgba, type Rgba } from '../paint/ground-textures';
import { parseTexRef, texDestName } from '../paint/textures';
import { orientUV } from '../paint/orientation';
import { patchName } from './names';
import { hexToRgb } from '../math/color';
import { serializeEffectsDocument } from '../effects/document';
import { particleVolumesToNative } from '../particles/volumes';
import type { BakedPropGroup } from './props';

/**
 * EditDoc -> the authored level folder snowknife consumes (`snowknife gltf <dir>` then
 * `snowknife unity <dir> <project>`). Spaces:
 *
 *   editor   metres, Y up, RH (Three.js)
 *   raw SSX  centimetres, Z up, X mirrored vs mesh space - what Patches.json / Props.obj /
 *            AIP.json store. editor (x,y,z) -> raw (-100x, -100z, 100y).
 *
 * The bake reads raw, mirrors X back, and winds triangles assuming the quilt's u×v cross points
 * down in mesh space; the generators' net orientation guarantees that, so terrain normals come out skyward.
 * UV corners pair index-for-index with the patch's geometry corners: the bake binds stored
 * [c0..c3] to parametric corners (uvA,uvB,uvC,uvD) = (c0,c2,c1,c3) - a transpose of the
 * same-index order (swap the off-diagonal B<->C). So we store [d00, d10, d01, d11] to land
 * our intended d00@(0,0) .. d11@(1,1).
 */
export interface LevelFiles {
  /** Text files keyed by name (Patches.json, Props.obj, AIP.json). */
  text: Record<string, string>;
  /** Textures/<name> images, raw RGBA (PNG-encoded at write time) - the procedural surface tiles. */
  textures: Record<string, Rgba>;
  /** Lightmaps/<name> pages (128x128 RGBA, A_S in alpha) baked from the authored sun; empty when the
   *  export's lighting option is off. */
  lightmaps: Record<string, Rgba>;
  /** Textures/<destName> to copy verbatim from an extracted level's Textures/ - the real tiles a
   *  cell was texture-painted with. destName -> {level, name} source. Done server-side (export.ts);
   *  core stays pure (no fs). */
  copyTextures: Record<string, { level: string; name: string }>;
  /** TexturePath as written into Patches.json -> its logical source and optional staged file name. Every page
   *  ships flattened and verbatim, so this is where the donor survives: exported as Slopesmith.json, it lets
   *  an authored level be opened as a reference and lets `repack` tell a native page from a borrowed or
   *  custom one. Load-bearing diagnostic: a painted document with an empty table did not export its paint;
   *  the procedural SurfaceType fallback can look like a washed/downscaled texture even though no resample ran. */
  textureSources: Record<string, { level: string; name: string; staged?: string }>;
  /** Placement id -> per-instance lighting written into canonical Instances.json (docs/032 · lighting).
   *  Empty when lighting is disabled; the canonical serializer then writes neutral full-bright values. */
  propLights: Record<string, PropInstanceLight>;
  /** Structured authored prop models in the same order as Props.obj. The canonical serializer writes them
   *  into Models.json, Instances.json and Meshes/. */
  propGroups: BakedPropGroup[];
  /** The two staging-anchor markers (`Mdl_StageArea_Start_0` / `Mdl_StageArea_Finish_0`). Kept apart from
   *  `propGroups` so they can be appended LAST, after every placed prop, leaving existing instance ordinals
   *  where they were. */
  anchorGroups: BakedPropGroup[];
  /** The stable quad id behind each Patches.json record, in that file's own order. The engine consumes an
   *  ordered patch array with no id column, so the id->ordinal join ships beside it in Slopesmith.json — which
   *  is what lets a re-export made after topology surgery be rejoined to its predecessor and diffed. */
  patchIds: string[];
}

/** One Patches.json record. UV / lightmap corner conventions are documented in the file header + docs/003. */
interface PatchRecord {
  PatchName: string;
  LightMapPoint: number[];
  UVPoints: number[][];
  Points: number[][];
  SurfaceType: number;
  TrickOnlyPatch: boolean;
  TexturePath: string;
  LightmapID: number;
}

export const toRaw = (p: V3): V3 => [-100 * p[0], -100 * p[2], 100 * p[1]];

/** Seam inset applied to every exported tile UV: corners land at [0.008, 0.992] instead of [0, 1] (span
 *  0.984) — the dominant shipped convention (ELYSIUM / MERQUER / MESA inset nearly every patch at exactly
 *  this value), keeping bilinear + wrap sampling from bleeding the tile's opposite edge across patch
 *  seams. The editor preview samples the full 0..1 tile; the 0.8% zoom difference is invisible. */
const UV_INSET = 0.008;

export function buildLevelFiles(doc: EditDoc, signLights?: PlacedLight[], opts?: LevelFileOpts): LevelFiles {
  return buildMountainLevel(doc, signLights, opts);
}

export interface LevelFileOpts {
  /** Bake terrain lightmaps + write Lights.json (default true). An export choice, independent of the
   *  viewport's sun preview toggle: off ships no lighting, so an ISO repack keeps the target level's
   *  original lights + _L.ssh verbatim. */
  lighting?: boolean;
  /** Add seeded lateral variation to the six gate-anchored race routes (default false). Race mode always
   *  requires exactly six AIP `StartPosList` entries, so off ships six non-wandering center routes. */
  aiPaths?: boolean;
  /** Override the SurfaceType base tiles with authored art (an ice-cream set, say). Called with a
   *  procedural name (`snow.png`, …); return null to keep `generateTexture`'s noise for that one. Core
   *  owns no filesystem, so the server injects the loader — the same discipline `copyTextures` follows.
   *  Feeding the SAME pixels to both call sites below keeps the lightmap's C_D matching what ships. */
  groundTex?: (name: string) => Rgba | null;
  /**
   * How far a placement's LOWEST point sits above its `pos` origin, in editor metres and UNSCALED — the
   * server's twin of the app's `placedBaseOffset` (a group seats on its lowest member). Placement stores
   * `pos.y = terrainY − scale×this`, so the prop's standing point is `pos.y + scale×this`; that is where the
   * per-prop lighting probe belongs (docs/032 · lighting). Core owns no filesystem and the geometry lives in
   * the source levels' Meshes/ (and the Custom catalogue), so the server injects the resolver — the same
   * discipline `groundTex` and `copyTextures` follow. Absent ⇒ 0, which probes `pos` as before.
   */
  propBaseOffset?: (p: PlacedProp) => number;
}

/** Patches.json records for one quilt; UV corners are stored in the index-matched transpose
 *  order the bake binds (see header). Each cell's TexturePath is its painted real tile (texOf) if any, else the SurfaceType's
 *  procedural tile - SurfaceType still rides the same either way (texture is appearance only). Reads the
 *  topology-general QuadMesh (mountain.ts `deriveQuadMesh`); each quad's 16 CPs come from
 *  `quadControlPoints`, so the emitted patches are independent of the net's topology (regular or poled). */
function quiltPatches(
  d: DerivedQuadMesh,
): { patches: PatchRecord[]; ids: string[]; texUsed: Set<string>;
  copies: Record<string, { level: string; name: string }>;
  sources: Record<string, { level: string; name: string; staged?: string }> } {
  const patches: PatchRecord[] = [];
  const ids: string[] = [];
  const texUsed = new Set<string>();
  const copies: Record<string, { level: string; name: string }> = {};
  const sources: Record<string, { level: string; name: string; staged?: string }> = {};
  const { mesh, edgeHandle } = d;
  for (let q = 0; q < mesh.quadCount; q++) {
    {
      const cp = quadControlPoints(mesh, edgeHandle, q, d.twistOf(q)).map(toRaw);
      const surf = d.surfOf(q);
      const ref = d.texOf(q);
      let tex: string;
      let source: { level: string; name: string; staged?: string } | null = null;
      if (ref) {
        tex = texDestName(ref);
        const { level, name } = parseTexRef(ref);
        copies[tex] = { level, name };
        if (level) source = { level, name, staged: tex };
      } else {
        tex = surfaceStyle(surf).tex;
        texUsed.add(tex);
      }
      if (source && !sources[tex]) sources[tex] = source;

      // One tile per patch - the SSX convention (nearly every reference patch is one full tile, unit or
      // seam-inset): the painted tile fills the cell, U 0->1 down the rows, V 0->-1 across the cols,
      // independent of cell size. So texture density follows PATCH density the way the original mountains
      // are built (denser patches => tighter tiles), not a fixed metric repeat. Slots are [d00, d10, d01,
      // d11], index-matched to the cell corners (header).
      // A per-cell D4 orientation rotates/mirrors the tile's UVs (same transform the preview applies);
      // the corners then pull inward by UV_INSET per side (the shipped seam-bleed inset).
      const o = d.orientOf(q);
      const uv = (u: number, v: number): number[] => {
        const [a, b] = o ? orientUV(u, v, o.rot, o.mirror) : [u, v];
        return [UV_INSET + (1 - 2 * UV_INSET) * a, -(UV_INSET + (1 - 2 * UV_INSET) * b)];
      };
      const d00 = uv(0, 0), d10 = uv(1, 0), d01 = uv(0, 1), d11 = uv(1, 1);

      ids.push(d.id(q));
      patches.push({
        PatchName: patchName(d.id(q)),
        LightMapPoint: [0, 0, 0.0625, 0.0625],
        UVPoints: [d00, d10, d01, d11],
        Points: cp.map(p => [p[0], p[1], p[2]]),
        SurfaceType: surf,
        TrickOnlyPatch: false,
        TexturePath: tex,
        LightmapID: 0,
      });
    }
  }
  return { patches, ids, texUsed, copies, sources };
}

/** The respawn-spine path's label. A mountain has one run, so this is a constant — `PathBundle.BakePath`
 *  folds names into a dedupe signature alongside each path's start point, and the AI lines carry their own
 *  per-gate names + starts, so nothing collides. */
const AIP_PATH_NAME = 'Slopesmith Course';

/** Raw-space increments between consecutive points — the delta form `PathPoints` ship in. */
function deltasOf(raw: V3[]): number[][] {
  const deltas: number[][] = [];
  for (let r = 1; r < raw.length; r++)
    deltas.push([raw[r][0] - raw[r - 1][0], raw[r][1] - raw[r - 1][1], raw[r][2] - raw[r - 1][2]]);
  return deltas;
}

interface RaceLineCheckpoint {
  pos: V3;
  bonusSeconds: number;
}

/** Project a checkpoint onto the exported race-line polyline and return its horizontal arc station in raw cm.
 *  The nearest segment is chosen in 3D so a folded course cannot bind a high bridge to the line underneath;
 *  the station itself advances in the engine's horizontal metric. */
function raceLineStation(raw: V3[], point: V3): number {
  let arc = 0, bestDist = Infinity, bestStation = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len2 = dx * dx + dy * dy + dz * dz;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1,
      ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy + (point[2] - a[2]) * dz) / len2)) : 0;
    const qx = a[0] + dx * t, qy = a[1] + dy * t, qz = a[2] + dz * t;
    const d = (point[0] - qx) ** 2 + (point[1] - qy) ** 2 + (point[2] - qz) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestStation = arc + Math.hypot(dx, dy) * t;
    }
    arc += Math.hypot(dx, dy);
  }
  return bestStation;
}

/**
 * The course's one race line — the engine's distance-to-finish metric. `DistanceToFinish` is the line's
 * summed **horizontal** raw arc length (the engine chains path distance in the ground plane;
 * [Trailmap: 250-paths-aip-sop]), so DTF reaches zero exactly at the course tail; the line then
 * overshoots ~40 m along the end tangent, horizontally, like every retail line (25-61 m) so the zero
 * crossing is interpolated inside a segment rather than pinned to the last vertex. The type-9 event at
 * `EventStart` == `DistanceToFinish` is the finish-line marker every retail level's min-DTF line carries.
 */
function raceLineJson(rawCenters: V3[], rawFinish: V3, checkpoints: RaceLineCheckpoint[], showoff: boolean): object {
  const deltas = deltasOf(rawCenters);
  // DTF is the horizontal arc from the line's head to the FINISH, which is the tail only when no finish
  // anchor moved it. Walking to the anchor's nearest station instead of summing every delta is what lets a
  // lap course put its crossing mid-line, the way MEGAPLEX does.
  let dtf = 0, arc = 0;
  let p: V3 = rawCenters[0];
  const gap = (a: V3) => (a[0] - rawFinish[0]) ** 2 + (a[1] - rawFinish[1]) ** 2 + (a[2] - rawFinish[2]) ** 2;
  let best = gap(p);
  for (const d of deltas) {
    arc += Math.hypot(d[0], d[1]);
    p = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    const g = gap(p);
    if (g < best) { best = g; dtf = arc; }
  }
  const tail = deltas[deltas.length - 1];
  const h = Math.hypot(tail[0], tail[1]) || 1;
  const overshoot = [(tail[0] / h) * 4000, (tail[1] / h) * 4000, 0]; // 40 m past the finish, raw cm
  // A checkpoint is a path station, not a prop trigger. Both datasets carry the type-11 marker so race
  // progress sees the same course divisions; only SOP carries the seconds payload, exactly as retail does.
  const events = checkpoints.map(checkpoint => {
    const station = raceLineStation(rawCenters, checkpoint.pos);
    return {
      EventType: 11, EventValue: showoff ? checkpoint.bonusSeconds : 0,
      EventStart: station, EventEnd: station,
    };
  });
  events.push({ EventType: 9, EventValue: 0, EventStart: dtf, EventEnd: dtf });
  events.sort((a, b) => a.EventStart - b.EventStart || a.EventType - b.EventType);
  return {
    Name: 'Race Line 0',
    DistanceToFinish: dtf,
    PathPos: rawCenters[0],
    PathPoints: [[0, 0, 0], ...deltas, overshoot],
    PathEvents: events,
  };
}

/**
 * AIP.json — the race-mode AI field + respawn network. Six gate-anchored opponent
 * lines (`aiPathLines`) lead and `StartPosList` names all six: the retail `.aip` shape
 * ([Trailmap: 250-paths-aip-sop] — GARI seeds its six riders from six start-path indices in a row at the
 * gate). Each carries the retail start-path flags (Respawnable, no events — nothing traced reads path events)
 * and its own **line rating** (`U3`, `aiLineRatings`): the AI picks the path whose rating matches its mood, so
 * the rating is what makes a leading rider take the direct line and a trailing one gamble on the wide one
 * ([Trailmap: 395]). The course-center path rides last as the OOB-reset / respawn spine at the neutral default,
 * and the race line is unchanged. The export option controls lateral wandering, not the required six-entry start
 * field — and with wandering off there is nothing to tell the lines apart, so they all rate the default.
 */
function aipJson(name: string, centers: V3[], aiLines: V3[][], ratings: number[], finish: V3,
  checkpoints: RaceLineCheckpoint[]): object {
  const rawCenters = centers.map(toRaw);
  const ai = aiLines.map((line, i) => {
    const raw = line.map(toRaw);
    return {
      Name: `AI Path ${i}`, U3: ratings[i] ?? DEFAULT_LINE_RATING, Respawnable: true,
      PathPos: raw[0], PathPoints: [[0, 0, 0], ...deltasOf(raw)], PathEvents: [],
    };
  });
  return {
    StartPosList: ai.map((_, i) => i),
    AIPaths: [
      ...ai,
      {
        Name: name, U3: DEFAULT_LINE_RATING, Respawnable: true,
        PathPos: rawCenters[0], PathPoints: [[0, 0, 0], ...deltasOf(rawCenters)], PathEvents: [],
      },
    ],
    RaceLines: [raceLineJson(rawCenters, toRaw(finish), checkpoints, false)],
  };
}

/**
 * SOP.json — the Show Off-mode path dataset. It carries exactly six start paths, one per rider slot,
 * each a short lead-in converging on the course line, plus the same race line as the AIP.
 */
function sopJson(gateLines: V3[][], centers: V3[], finish: V3, checkpoints: RaceLineCheckpoint[]): object {
  const gates = gateLines.map((line, i) => {
    const raw = line.map(toRaw);
    return {
      Name: `Start Gate ${i}`, U3: DEFAULT_LINE_RATING, Respawnable: true,
      PathPos: raw[0], PathPoints: [[0, 0, 0], ...deltasOf(raw)], PathEvents: [],
    };
  });
  return {
    StartPosList: gates.map((_, i) => i),
    AIPaths: gates,
    RaceLines: [raceLineJson(centers.map(toRaw), toRaw(finish), checkpoints, true)],
  };
}

/**
 * A `Splines.json` (SSX spline list) from authored grind rails and Effects motion paths. Each Catmull-Rom curve is written
 * as a chain of cubic-Bézier `Segments` (four control points each), `toRaw`'d into the same raw SSX space the
 * patches + props use. Grind rails use `(1, 1, style 13/12/5)`, which snowknife's PathBundle promotes to its
 * ridable network; a rail authored to start OFF keeps that pair and drops to retail's non-grind `style 1`
 * until a `Rail on / off` effect switches it in; Effects-owned motion paths use retail's non-grind
 * `(-1, -2, style -1)` route row. A
 * spline with fewer than two nodes emits no segments and is skipped, so a half-drawn path never ships a
 * broken spline (docs/014).
 *
 * The three fields land together in the level's SSF spline record (`{i16, i16, u32 style}`); keeping both
 * proven native rows preserves the PS2 distinction between rideable rails and animation routes.
 */
function buildSplinesJson(rails: Rail[]): object {
  const Splines = rails
    .map((rail, i) => {
      const segs = railBezierSegments(rail.nodes).map(seg => ({ Points: seg.map(cp => toRaw(cp)) }));
      const native = nativeSplineFields(rail);
      let name = rail.name || `${rail.kind === 'motion' ? 'MotionPath' : 'Rail'}_${i}`;
      // Style 5 is a retail named exception rather than a globally catchable style: Snowknife admits Alaska's
      // IceRails through the native `Rail` name signal. Preserve that contract for authored ice even when the
      // author calls one "Frozen ledge", so a harmless rename cannot remove it from the bundled rail network.
      if (rail.kind !== 'motion' && railStyle(rail) === RAIL_STYLE_ICE && !name.includes('Rail'))
        name = `IceRail_${name}`;
      return { SplineName: name,
        U0: native.u0, U1: native.u1, SplineStyle: native.style, Segments: segs };
    })
    .filter(s => s.Segments.length > 0);
  return { Splines };
}

/**
 * A `Gems.json` (authored gem pickups) from the doc's gems: each a raw-space `Position` (`toRaw`, the same cm /
 * Z-up / X-mirrored frame the patches and splines use) + its score `Value`. This is the authored gem channel —
 * distinct from the extracted gems snowknife derives from a level's SSF (MainType-14). snowknife's `GemBundle`
 * reads it into the manifest, and the importer places a collectible spinner per gem (docs/014).
 */
function buildGemsJson(gems: Gem[]): object {
  return { Gems: gems.map(g => ({ Position: toRaw(g.pos), Value: g.value ?? 1 })) };
}

/** Editor metres -> SSX MESH space (cm, Z up, X as the bundle stores it): `toRaw` with its X mirror undone,
 *  which is the frame every Billboards.json quantity is in. */
const toMesh = (p: V3): V3 => [100 * p[0], -100 * p[2], 100 * p[1]];

/** A direction through the same map, renormalised — the map is a rotation, so a unit vector stays one. */
function meshDir(d: V3, fallback: V3): V3 {
  const m = toMesh(d);
  const n = Math.hypot(m[0], m[1], m[2]);
  return n > 1e-9 ? [m[0] / n, m[1] / n, m[2] / n] : fallback;
}

/** An object name a consumer can use verbatim: a screen becomes a GameObject/node named after this. */
const screenName = (raw: string): string => raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Screen';

/**
 * A `Billboards.json` (docs/051) from the doc's screens: each an oriented rectangle in mesh space, the same
 * contract `snowknife billboards` writes when it measures an extracted course's boards. Snowknife's
 * `BillboardBundle` carries it into the bundle manifest, and a runtime with video lays its own quad over each.
 *
 * `Source: authored` is load-bearing: it is what stops a later detector run over this folder from replacing
 * the author's screens with measured ones.
 */
export function buildBillboardsJson(screens: Screen[], props: PlacedProp[] | undefined): object {
  const used = new Set<string>();
  const records = screens.map((screen, index) => {
    const pose = screenPose(screen, screenProp(screen, props));
    let name = screenName(screen.name || screen.id || `Screen_${index}`);
    for (let n = 2; used.has(name); n++) name = `${screenName(screen.name || screen.id || `Screen_${index}`)}_${n}`;
    used.add(name);
    const family = screen.prop ? screenName(screenProp(screen, props)?.name ?? '') : '';
    return {
      Name: name,
      ...(family ? { Family: family } : {}),
      Center: toMesh(pose.center),
      Normal: meshDir(pose.normal, [0, -1, 0]),
      Up: meshDir(pose.up, [0, 0, 1]),
      Width: 100 * pose.width,
      Height: 100 * pose.height,
    };
  });
  return { Schema: 'openslope-billboards/v1', Source: 'authored', Screens: records };
}

function texturesFor(texUsed: Set<string>): Record<string, Rgba> {
  const textures: Record<string, Rgba> = {};
  for (const t of texUsed) textures[t] = generateTexture(t);
  return textures;
}

/** The procedural surface tiles generateTexture knows (the SurfaceType bases). A patch whose TexturePath
 *  isn't one of these is painted with a real tile whose pixels aren't in core — those bake white-base. */
const PROCEDURAL_TEX = new Set(['snow.png', 'powder.png', 'ice.png', 'rock.png', 'offtrack.png', 'oob.png']);

/**
 * A DiffuseSampler over patches' procedural tiles: each patch's base C_D is its generated SurfaceType tile
 * sampled at the texel's tile UV, so the lightmap bakes the exact texture × light the engine renders. Painted
 * cells (real tiles, no pixels in core) fall back to white — they bake the texture-free form.
 */
function proceduralDiffuse(patches: PatchRecord[]): DiffuseSampler {
  const cache = new Map<string, Rgba>();
  const tiles = patches.map(p => {
    if (!PROCEDURAL_TEX.has(p.TexturePath)) return null;
    let t = cache.get(p.TexturePath);
    if (!t) { t = generateTexture(p.TexturePath); cache.set(p.TexturePath, t); }
    return t;
  });
  return (pi, u, v) => { const t = tiles[pi]; return t ? sampleRgba(t, u, v) : [1, 1, 1]; };
}

/**
 * A `Lights.json` (SSX PBD light list) authored from the sun: one **directional** (Type 0) carrying the
 * sun's direction + colour, and one **ambient** (Type 3) carrying the sky fill, plus one **spot** (Type 1)
 * per billboard sign light. This is the engine-native form the bundle reads for dynamic-object lighting
 * (`manifest.Sun`) and the ISO repack writes into the PBD lights chunk, so a from-scratch mountain
 * self-describes its lighting with nothing kept from a reference level. `Direction` is the raw-space
 * **propagation** (from-light) vector — the linear `toRaw` of −(to-sun) — matching original
 * `SD_Di_Directional`. The light bounds span the terrain (sun/ambient) or the light's own reach (spots).
 */
/**
 * The `World.json` a mountain exports: the same contract `snowknife import` writes from a course's own
 * world-configuration record, so an authored course and an imported one share a portable contract across
 * the editor, Unity tooling and an ISO repack. Colours go out as the 0-255 integer triples the record uses;
 * intensities are the engine's independent fan/sprite multipliers; angles, distance and size stay in map
 * units and the game's frame.
 */
function buildWorldJson(glare: GodRayCourse): object {
  const rgb = (c: readonly [number, number, number]) => c.map(v => Math.max(0, Math.min(255, Math.round(v))));
  return {
    Schema: 'openslope-world/v1',
    Glare: {
      Enabled: glare.enabled,
      CoreColour: rgb(glare.core),
      FanIntensity: glare.fanIntensity,
      RimColour: rgb(glare.rim),
      SpriteIntensity: glare.spriteIntensity,
      AzimuthDegrees: glare.az,
      ElevationDegrees: glare.el,
      DistanceUnits: glare.distance,
      SizeUnits: glare.size,
    },
  };
}

function buildLightsJson(sun: SunLight, rawMin: V3, rawMax: V3, signLights: PlacedLight[] = []): object {
  const e = (sun.el * Math.PI) / 180, a = (sun.az * Math.PI) / 180;
  const dir = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), -Math.sin(e)];
  const st = hexToRgb(sun.sunTint), sk = hexToRgb(sun.skyTint);
  const center: V3 = [(rawMin[0] + rawMax[0]) / 2, (rawMin[1] + rawMax[1]) / 2, (rawMin[2] + rawMax[2]) / 2];
  const common = {
    SpriteRes: 0, UnknownFloat1: 1, UnknownInt1: 0,
    LowestXYZ: rawMin, HighestXYZ: rawMax,
    UnknownFloat2: 0, UnknownInt2: 0, UnknownFloat3: 0, UnknownInt3: 0, Hash: 0,
  };
  // one PBD spot per billboard sign light: editor → raw for position (toRaw) and propagation direction
  // (editor [ex,ey,ez] → raw [−ex,−ez,ey], the inverse of ref-lights' dirEditor), a cube influence box sized
  // by the light's reach, and the cone cosine in UnknownFloat2 exactly like the shipped SignLights.
  const spots = signLights.map(L => {
    const [r, g, b] = hexToRgb(L.colorHex);
    const p = toRaw(L.pos);
    const h = L.reach * 100; // reach (m) → cm cube half-extent
    return {
      LightName: L.name, Type: L.kind === 'spot' ? 1 : 2,
      Colour: [r * L.intensity, g * L.intensity, b * L.intensity],
      Direction: [-L.dir[0], -L.dir[2], L.dir[1]],
      Position: p,
      // The engine's runtime GLINT gate (docs/047): a small resolution class (16/32/64) makes the light draw
      // its halo/core/star sparkle — on console, in Snowknife's LightGlows bundle, and in the Unity import,
      // all of which read this one field. 0 = no glint, as the shipped SignLights carry.
      SpriteRes: glintSizeClass(L.glint), UnknownFloat1: 1, UnknownInt1: 0,
      LowestXYZ: [p[0] - h, p[1] - h, p[2] - h], HighestXYZ: [p[0] + h, p[1] + h, p[2] + h],
      UnknownFloat2: L.kind === 'spot' ? L.coneCos : 0, UnknownInt2: 0, UnknownFloat3: 0, UnknownInt3: 0, Hash: 0,
    };
  });
  return {
    Lights: [
      { LightName: 'Slopesmith Sun', Type: 0, Colour: [st[0] * sun.sun, st[1] * sun.sun, st[2] * sun.sun], Direction: dir, Position: center, ...common },
      { LightName: 'Slopesmith Ambient', Type: 3, Colour: [sk[0] * sun.ambient, sk[1] * sun.ambient, sk[2] * sun.ambient], Direction: [1, 0, 0], Position: center, ...common },
      ...spots,
    ],
  };
}

// ---- mountain ------------------------------------------------------------------

export function buildMountainLevel(doc: QuadMeshDoc, signLights: PlacedLight[] = [], opts?: LevelFileOpts): LevelFiles {
  const d = deriveQuadMesh(doc);
  const { patches, ids, texUsed, copies, sources } = quiltPatches(d);

  // the run: its spine is the race/respawn path and hosts the start gate + per-mode start paths (core/doc/course —
  // the same functions the viewport's start/finish preview draws, so the markers match the disc)
  const main = doc.course;
  if (main.knots.length < 2) throw new Error('Mountain export needs a run of at least two knots (the AIP / spawn line).');
  const centers = courseCenters(main);
  const checkpoints: RaceLineCheckpoint[] = main.knots
    .filter(knot => (knot.checkpointBonus ?? 0) > 0)
    .map(knot => ({ pos: toRaw(knot.pos), bonusSeconds: Math.round(knot.checkpointBonus!) }));
  const { left, right } = startFrame(main);
  const finishPos = finishFrame(main).pos;   // where DTF reaches zero: the run's tail, or its finish anchor

  // Bake the authored sun into original-form lightmap pages, and point each patch at its tile. The bake
  // is gated by the EXPORT's lighting option (default on), not the viewport's sun preview toggle — the
  // sun settings still author the light either way. With lighting off, no lightmaps ship and the bake
  // falls back to white luminance.
  const sun = doc.sun ?? DEFAULT_SUN;
  let lightmaps: Record<string, Rgba> = {};
  const propLights: Record<string, PropInstanceLight> = {};
  const startGate = buildStartGate(left, right);
  const stageAreas = buildStageAreaMarkers(startFrame(main).pos, finishPos, startGate.vertices);
  const text: Record<string, string> = {
    'Props.obj': startGate.obj + stageAreas.obj,
    'AIP.json': JSON.stringify(aipJson(AIP_PATH_NAME, centers,
      aiPathLines(main, doc.aiSeed ?? DEFAULT_AI_SEED, opts?.aiPaths === true),
      aiLineRatings(main, doc.aiSeed ?? DEFAULT_AI_SEED, opts?.aiPaths === true), finishPos, checkpoints)),
    'SOP.json': JSON.stringify(sopJson(startGateLines(main), centers, finishPos, checkpoints)),
  };
  // Native course splines: grind rails plus invisible Effects motion routes (only when a path actually
  // carries a segment, so a single-node scratch doesn't ship an empty Splines.json).
  if (doc.rails?.length) {
    const splines = buildSplinesJson(doc.rails) as { Splines: unknown[] };
    if (splines.Splines.length) text['Splines.json'] = JSON.stringify(splines);
  }
  // gem pickups: the collectible half of the trick layer, as an authored gem list (docs/014)
  if (doc.gems?.length) text['Gems.json'] = JSON.stringify(buildGemsJson(doc.gems));
  // video screens: the rectangles a runtime lays video over, in the contract snowknife also writes for an
  // extracted course (docs/051)
  if (doc.screens?.length) text['Billboards.json'] = JSON.stringify(buildBillboardsJson(doc.screens, doc.props));
  // P1 portable effect graph: the same file Snowknife compiles back to SSF and Unity consumes.
  if (doc.effects) text['Effects.json'] = serializeEffectsDocument(doc.effects);
  // Standalone fog banks are a separate PBD channel, not SSF graph nodes or model instances. SSX-Library
  // repacks this native pair into the ISO; Snowknife folds the same pair into the Unity bundle manifest.
  if (doc.particleVolumes?.length) {
    const particles = particleVolumesToNative(doc.particleVolumes);
    text['ParticleInstances.json'] = JSON.stringify(particles.instances);
    text['ParticleModels.json'] = JSON.stringify(particles.models);
  }
  if (opts?.lighting !== false) {
    // fold the billboard sign lights into the terrain lightmap so a sign's snow pool ships baked
    const rig = signLights.length ? authoredRig(signLights) : undefined;
    // Placed props ride the bake's occlusion pass as probes, producing per-instance lighting from this sun
    // (docs/032 · lighting). The same `lighting` option gates these samples and the terrain lightmaps; when it
    // is off, the canonical serializer writes neutral full-bright prop values.
    //
    // The probe is the point the prop STANDS on, not `pos`. `pos` is the model's own origin, which sits
    // wherever the artist put it — placement stores `pos.y = terrainY − scale×baseOffset` so the model's
    // BOTTOM lands on the ground, and the origin can be metres above or below that. Probing `pos` samples
    // the occlusion 15 m inside the mountain for a tree (origin below the geometry) and 15 m in the air for
    // a media tower (origin above it), which is how MOUNTAIN38 shipped 70 of 89 props flagged fully shadowed
    // while their ground stood in full sun. Standing at the base is also the invariant this bake is for:
    // a prop and the snow under it are lit by the same numbers.
    const litProps = (doc.props ?? []).filter(p => p.id && !isEffectTriggerProp(p));
    const standsAt = (p: PlacedProp): V3 =>
      [p.pos[0], p.pos[1] + p.scale * (opts?.propBaseOffset?.(p) ?? 0), p.pos[2]];
    const baked = bakeLightmaps(patches, sun, proceduralDiffuse(patches), rig, litProps.map(standsAt));
    litProps.forEach((p, i) => {
      propLights[p.id!] = roundPropLight(
        propInstanceLight(sun, baked.probeLight[i], baked.probeAO[i], p.fullBright === true, p));
    });
    for (let i = 0; i < patches.length; i++) {
      patches[i].LightMapPoint = baked.patchLm[i].rect;
      patches[i].LightmapID = baked.patchLm[i].id;
    }
    lightmaps = baked.maps;
    // self-describe the lighting: a directional + ambient light over the terrain's raw bounds, plus a spot
    // per billboard sign light so a from-scratch course carries its own sign lighting
    const rmin: V3 = [Infinity, Infinity, Infinity], rmax: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of patches) for (const pt of p.Points) for (let k = 0; k < 3; k++) { if (pt[k] < rmin[k]) rmin[k] = pt[k]; if (pt[k] > rmax[k]) rmax[k] = pt[k]; }
    if (Number.isFinite(rmin[0])) text['Lights.json'] = JSON.stringify(buildLightsJson(sun, rmin, rmax, signLights));
  }
  // World.json — the mountain-level settings that belong to the course rather than to any of its geometry.
  // Today that is the sun's GLARE (docs/049). Written only when the mountain authored one, so a map without
  // a glare simply has no World.json and every consumer reads that as "no beams", exactly as it reads a
  // shipped course whose glare flag is clear.
  if (doc.glare?.enabled) text['World.json'] = JSON.stringify(buildWorldJson(doc.glare), null, 2);

  // Patches.json LAST: the lightmap bake stamps each patch's LightMapPoint + LightmapID above, so it must
  // be serialized after, or every patch ships the placeholder tile (all sampling page 0 slot 0).
  text['Patches.json'] = JSON.stringify({ Patches: patches });

  return {
    text,
    textures: texturesFor(texUsed),
    lightmaps,
    copyTextures: copies,
    textureSources: sources,
    propLights,
    propGroups: [startGate.group],
    // Appended AFTER every placed prop (folder.ts), so adding the markers doesn't renumber the instances a
    // level already had — Props.obj tags each group `inst<n>` by position, and joins downstream key on it.
    anchorGroups: stageAreas.groups,
    patchIds: ids,
  };
}

/** The gate's pillars + crossbar (core/doc/course startGateBoxes — the viewport previews the same three
 *  boxes) written as a Props.obj group (PropsBundle requires >= 1 visible static group). */
function buildStartGate(left: V3, right: V3): { obj: string; group: BakedPropGroup; vertices: number } {
  return boxesGroup('StartGate', 'Slopesmith start gate', startGateBoxes(left, right));
}

/**
 * The engine's two staging anchors, as the placeholder instances it resolves them by: Tricky hard-codes the
 * names `Mdl_StageArea_Start_0` / `Mdl_StageArea_Finish_0`, hashes them at runtime and transforms a fixed
 * six-rider formation through the START one ([Trailmap: 120-objects]). Shipping them means an authored
 * mountain stages its field the way a retail course does, and the Unity importer's marker read — which finds
 * these by name off Instances.json — works on our maps through the same path as an extraction.
 *
 * Each is a flat ~1 x 0.1 x 1 m plate at the anchor, the footprint retail's own markers carry. The finish
 * anchor is the podium/staging point; the finish LINE is where the race line's DTF reaches zero.
 */
function buildStageAreaMarkers(start: V3, finish: V3, vertexBase: number):
  { obj: string; groups: BakedPropGroup[] } {
  const plate = (pos: V3): GateBox => ({ base: [pos[0], pos[1], pos[2]], size: [1, 0.1, 1] });
  const s = boxesGroup('Mdl_StageArea_Start_0', 'Slopesmith start staging anchor',
    [plate(start)], toRaw(start), vertexBase);
  const f = boxesGroup('Mdl_StageArea_Finish_0', 'Slopesmith finish staging anchor',
    [plate(finish)], toRaw(finish), vertexBase + s.vertices);
  return { obj: s.obj + f.obj, groups: [s.group, f.group] };
}

/**
 * Axis-aligned boxes as a Props.obj group + its baked group, optionally declaring a raw-space pivot the
 * canonical instance carries as its Location. Faces CCW in editor space; the OBJ's X-mirror and the reader's
 * mirror-back cancel, so this winding survives to mesh space.
 *
 * `vertexBase` is how many `v` lines the file already holds: OBJ face indices are FILE-global while the baked
 * submesh's are group-local, so the two count differently once a file carries more than one group.
 */
function boxesGroup(name: string, comment: string, boxes: GateBox[], origin?: number[], vertexBase = 0):
  { obj: string; group: BakedPropGroup; vertices: number } {
  const lines: string[] = [`# ${comment}`, `o ${name}`, 'usemtl mat_untextured'];
  const positions: number[] = [], indices: number[] = [];
  let vBase = 1;
  for (const { base, size } of boxes) {
    const [cx, cy, cz] = base;
    const [sx, sy, sz] = size;
    const corners: V3[] = [];
    for (const dy of [0, sy])
      for (const dz of [-sz / 2, sz / 2])
        for (const dx of [-sx / 2, sx / 2]) corners.push([cx + dx, cy + dy, cz + dz]);
    // corners order: y0:[z- x-, z- x+, z+ x-, z+ x+], then y1 same
    for (const p of corners) {
      const r = toRaw(p);
      positions.push(...r);
      lines.push(`v ${r[0].toFixed(2)} ${r[1].toFixed(2)} ${r[2].toFixed(2)}`);
    }
    const q = (a: number, b: number, c: number, d: number) => {
      const localBase = vBase - 1;                 // group-local, 0-based: what the baked submesh indexes
      const fileBase = vertexBase + vBase;         // file-global, 1-based: what an OBJ face references
      indices.push(localBase + a, localBase + b, localBase + c,
        localBase + a, localBase + c, localBase + d);
      lines.push(`f ${fileBase + a} ${fileBase + b} ${fileBase + c}`);
      lines.push(`f ${fileBase + a} ${fileBase + c} ${fileBase + d}`);
    };
    q(0, 1, 5, 4); // z- side
    q(3, 2, 6, 7); // z+ side
    q(1, 3, 7, 5); // x+ side
    q(2, 0, 4, 6); // x- side
    q(4, 5, 7, 6); // top
    q(1, 0, 2, 3); // bottom
    vBase += 8;
  }
  return {
    obj: lines.join('\n') + '\n',
    group: {
      name,
      subs: [{ material: 'mat_untextured', slot: -1, object: 0, positions, uvs: [], indices }],
      ...(origin ? { origin } : {}),
    },
    vertices: positions.length / 3,
  };
}
