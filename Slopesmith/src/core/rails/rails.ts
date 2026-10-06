import type { PathHandles, Rail, V3 } from '../doc/types';
import type { LevelProps } from '../reference/props';
import { resolveTerrainTexRef } from '../paint/textures';

/**
 * Course-spline geometry (docs/014). Grind rails and Effects motion paths share the SAME uniform Catmull-Rom
 * curve used by the run spine (spine.ts). For export it becomes cubic Béziers in SSX's `Splines.json`; native
 * flags decide whether the curve enters the ridable rail network or remains an animation-only route. The
 * viewport samples the same segments into a polyline, so what you see is what ships.
 */

/** SSX SplineStyle values that ride as grind rails. Metal is the default; wood and ice tint apart. */
export const RAIL_STYLE_ICE = 5;
export const RAIL_STYLE_METAL = 13;
export const RAIL_STYLE_WOOD = 12;
/** Props-mode material combo, in its deliberate user-facing order. */
export const RAIL_MATERIAL_OPTIONS = {
  metal: RAIL_STYLE_METAL,
  wood: RAIL_STYLE_WOOD,
  ice: RAIL_STYLE_ICE,
} as const;
export const MOTION_PATH_STYLE = -1;
/** The non-grind style retail authors a rail at when an effect is meant to switch it on later — MESA's fallen
 *  trunk ships its two splines at style 1, outside the rail query, until the break chain toggles them in
 *  [Trailmap: 140-rail-toggle]. It is a style rather than a flag because candidacy has no authored bit on disc. */
export const RAIL_STYLE_OFF = 1;

/** Human material name for a catchable spline style. Kept beside the native values so inspectors, guide
 *  colours and authored controls do not invent separate names for the same ridden surface. */
export const railMaterialLabel = (style: number): string => {
  if (style === RAIL_STYLE_ICE) return 'Ice';
  if (style === RAIL_STYLE_WOOD) return 'Wood';
  if (style === RAIL_STYLE_METAL) return 'Metal';
  return `SplineStyle ${style}`;
};

/** Documents written before motion paths contain only grind rails, so an absent discriminator is grind. */
export const railKind = (rail: Rail): 'grind' | 'motion' => rail.kind === 'motion' ? 'motion' : 'grind';
export const isMotionPath = (rail: Rail): boolean => railKind(rail) === 'motion';

/** Whether this rail waits outside the rail network for a `Rail on / off` effect to switch it in. Only a grind
 *  rail can: a motion path is never in that network to begin with. */
export const railStartsOff = (rail: Rail): boolean => !isMotionPath(rail) && rail.startsOff === true;

/**
 * Whether this curve carries a visible tube — previewed in the viewport, baked into `Props.obj`.
 *
 * The grind and the pipe are separate records on disc, so the two are separable here as well: a motion path
 * never has one, and a grind rail has one unless it was drawn BARE, as grind data over scenery that already
 * has the shape. Everything downstream that means "is there geometry to draw / sweep / collide with" asks
 * this rather than testing the kind, because the kind is no longer the whole answer.
 */
export const railHasTube = (rail: Rail): boolean => !isMotionPath(rail) && rail.bare !== true;

/** A grind rail with no tube: the spline alone. Distinct from a motion path, which is not a rail at all. */
export const isBareRail = (rail: Rail): boolean => !isMotionPath(rail) && !railHasTube(rail);

/** The four states a grind rail can be in, as the phrase the Tricks picker offers and every panel reports —
 *  its grind surface, and whether it draws a pipe of its own. One vocabulary so the two never disagree. */
export const railKindLabel = (rail: Rail): string => {
  const material = railMaterialLabel(railStyle(rail)).toLowerCase();
  return railHasTube(rail) ? `${material} pipe` : `bare ${material}`;
};

function nextSplineId(rails: readonly Rail[], prefix: 'rail' | 'path'): string {
  const used = new Set(rails.map(rail => rail.id).filter((id): id is string => !!id));
  for (let i = 0; ; i++) {
    const id = `${prefix}:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** Stable rail ids let effect nodes keep following the same curve when another rail is deleted. */
export function nextRailId(rails: readonly Rail[]): string {
  return nextSplineId(rails, 'rail');
}

/** Stable identity for an effects-owned, non-grind motion path. */
export function nextMotionPathId(rails: readonly Rail[]): string { return nextSplineId(rails, 'path'); }

/** Upgrade old documents and repair duplicate/empty rail ids in place. */
export function ensureRailIds(rails: Rail[] | undefined): void {
  if (!rails) return;
  const used = new Set<string>();
  for (const rail of rails) {
    if (typeof rail.id === 'string' && rail.id && !used.has(rail.id)) used.add(rail.id);
    else {
      const prefix = isMotionPath(rail) ? 'path' : 'rail';
      rail.id = nextSplineId([...used].map(id => ({ id } as Rail)), prefix);
      used.add(rail.id);
    }
  }
}

/**
 * How the shipped levels name their rail PIPES. Each is one bespoke swept chunk of tube, placed exactly once
 * with the curve baked into its vertices (GARI ships 98, ELYSIUM 99, each a separate model) — the pipe half of a
 * rail, cut per chunk on export the way a sheet is (docs/071). The server reads the metal default skin off the
 * same models (`nativeArtSource`).
 */
export const RAIL_PIPE_MODEL = /^Mdl_Rail_Metal/;

/** A level's rail pipes, as the Prop Library folds them into one entry that opens the rail tool. */
export interface RailPipeFamily {
  /** The pieces' shared base name. */
  key: string;
  /** Every pipe model, placed or not, so the library can fold them all. */
  models: number[];
  /** How many placed pieces the level holds. */
  pieces: number;
  /** The tile the pipes wear, as a "LEVEL/file.png" ref. */
  texture: string | null;
}

/**
 * The rail pipes a shipped level was cut into, or null when it has none. Named like the retail pipes AND nearly
 * all placed exactly once — an instanced kit piece that happened to share the name would not be a pipe chunk.
 * (Wood and ice rails ship no pipe: retail rides them along logs and icicles that are ordinary props.)
 */
export function mineRailPipes(lp: Pick<LevelProps, 'level' | 'models' | 'instances' | 'materials'>): RailPipeFamily | null {
  const models = lp.models.filter(model => !model.line && RAIL_PIPE_MODEL.test(model.name));
  if (models.length < 2) return null;
  const placements = new Map<number, number>();
  for (const instance of lp.instances) {
    if (instance.visible !== false) placements.set(instance.model, (placements.get(instance.model) ?? 0) + 1);
  }
  const placed = models.filter(model => placements.get(model.id));
  if (!placed.length || placed.filter(model => placements.get(model.id) === 1).length < placed.length * 0.75) return null;
  const material = lp.materials.get(placed[0].subs[0]?.mat ?? -1);
  return {
    key: placed[0].name.replace(/_\d+$/, ''),
    models: models.map(model => model.id),
    pieces: placed.length,
    texture: material?.tex ? resolveTerrainTexRef(lp.level, material.tex) : null,
  };
}

/** The style a rail rides as (default metal), tolerating a doc saved before the style field existed. */
export const railStyle = (r: Rail): number => r.style ?? RAIL_STYLE_METAL;

export type RailMaterialKey = keyof typeof RAIL_MATERIAL_OPTIONS;

/** The material key a grind style is offered under, or null for a style the material combo does not offer. */
export const railMaterialKey = (style: number): RailMaterialKey | null =>
  (Object.keys(RAIL_MATERIAL_OPTIONS) as RailMaterialKey[]).find(key => RAIL_MATERIAL_OPTIONS[key] === style) ?? null;

/** The default tube texture per material, as "LEVEL/file.png" refs borrowed off shipped models (docs/014).
 *  A material with no entry has no default and bakes untextured. */
export type RailSkins = Partial<Record<RailMaterialKey, string>>;

/**
 * The texture a rail's tube wears — its own pick, else its material's default — or null for untextured.
 *
 * The one answer the viewport, the export bake and the Tools swatch all ask, so the tube you see is the tube
 * that ships. An own pick of '' is an explicit "no texture", not an absent one.
 */
export function railTubeTexture(rail: Rail, skins: RailSkins): string | null {
  if (rail.texture !== undefined) return rail.texture || null;
  const key = railMaterialKey(railStyle(rail));
  return (key && skins[key]) || null;
}

/**
 * Exact native SSF spline row fields. Animation-only routes match the retail train/gondola path records.
 *
 * A `startsOff` rail keeps the grind row's `(1, 1)` pair and swaps only its STYLE, which is the whole
 * mechanism retail uses: the rail query searches by style, so a curve authored at `RAIL_STYLE_OFF` is not
 * there to be caught until a MainType-25 toggle pushes it onto the candidacy bit. Its authored material
 * choice stays in the document (and on the baked tube) so switching the rail on restores the rail it looks
 * like, rather than a style the author never picked.
 */
export function nativeSplineFields(rail: Rail): { u0: number; u1: number; style: number } {
  if (isMotionPath(rail)) return { u0: -1, u1: -2, style: MOTION_PATH_STYLE };
  return { u0: 1, u1: 1, style: railStartsOff(rail) ? RAIL_STYLE_OFF : railStyle(rail) };
}

/** A path's handle overrides, index-parallel with its nodes; anything missing is automatic (`PathHandles`). */
export type PathHandleList = readonly (PathHandles | null | undefined)[] | undefined;

const addV = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The automatic (uniform Catmull-Rom) handle leaving node `i`: neighbour difference / 6, with the endpoints
 *  clamped (P[-1]=P[0], P[n]=P[n-1]) — the same clamping sampleSpine does, so a path matches the run spine.
 *  The arriving handle is its negation. */
function autoOut(nodes: readonly V3[], i: number): V3 {
  const n = nodes.length, at = (k: number) => nodes[Math.max(0, Math.min(n - 1, k))];
  const a = at(i - 1), b = at(i + 1);
  return [(b[0] - a[0]) / 6, (b[1] - a[1]) / 6, (b[2] - a[2]) / 6];
}

/**
 * Every node's two handles as they stand — the override where one was dragged, the automatic tangent where
 * not — as offsets from the node. The first node has no arriving handle and the last none leaving (null).
 */
export function pathHandleOffsets(nodes: readonly V3[], handles?: PathHandleList): { in: V3 | null; out: V3 | null }[] {
  return nodes.map((_, i) => {
    const auto = autoOut(nodes, i), own = handles?.[i];
    return {
      in: i > 0 ? own?.in ?? [-auto[0], -auto[1], -auto[2]] : null,
      out: i < nodes.length - 1 ? own?.out ?? auto : null,
    };
  });
}

/**
 * A path's curve as a chain of cubic-Bézier segments: one per span between consecutive nodes, each `[b0, b1, b2,
 * b3]` in the nodes' own space. The inner points are the nodes' handles (`pathHandleOffsets`): automatic uniform
 * Catmull-Rom tangents unless a handle was dragged. Fewer than two nodes yields no segments.
 */
export function railBezierSegments(nodes: readonly V3[], handles?: PathHandleList): [V3, V3, V3, V3][] {
  if (nodes.length < 2) return [];
  const offsets = pathHandleOffsets(nodes, handles);
  const segs: [V3, V3, V3, V3][] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const p1 = nodes[i], p2 = nodes[i + 1];
    segs.push([p1, addV(p1, offsets[i].out!), addV(p2, offsets[i + 1].in!), p2]);
  }
  return segs;
}

/**
 * Drag one handle of node `node` to `offset` (from the node). The opposite handle swings to stay in line with it,
 * keeping its own length, so the curve stays smooth through the node; `independent` (Alt) moves only the one,
 * which is how a path takes a corner. Returns the new list, trimmed of trailing nodes with no override.
 */
export function setPathHandle(nodes: readonly V3[], handles: PathHandleList, node: number, side: 'in' | 'out',
  offset: V3, independent = false): (PathHandles | null)[] {
  const out: (PathHandles | null)[] = nodes.map((_, i) => handles?.[i] ? { ...handles[i] } : null);
  if (!nodes[node]) return trimHandles(out);
  const entry: PathHandles = { ...(out[node] ?? {}), [side]: [offset[0], offset[1], offset[2]] };
  const other = side === 'in' ? 'out' : 'in';
  const opposite = pathHandleOffsets(nodes, handles)[node][other];
  const length = Math.hypot(offset[0], offset[1], offset[2]);
  if (!independent && opposite && length > 1e-9) {
    const keep = Math.hypot(opposite[0], opposite[1], opposite[2]) / length;
    entry[other] = [-offset[0] * keep, -offset[1] * keep, -offset[2] * keep];
  }
  out[node] = entry;
  return trimHandles(out);
}

/** Put node `node` back on the automatic curve. */
export function resetPathHandles(handles: PathHandleList, node: number): (PathHandles | null)[] {
  return trimHandles((handles ?? []).map((own, i) => i === node ? null : own ?? null));
}

/** The handle list once node `node` is deleted, so every later node keeps its own. */
export function withoutPathNode(handles: PathHandleList, node: number): (PathHandles | null)[] {
  return trimHandles((handles ?? []).filter((_, i) => i !== node).map(own => own ?? null));
}

/** Whether node `node` has a dragged handle. */
export const pathNodeHasHandles = (handles: PathHandleList, node: number): boolean => !!handles?.[node];

function trimHandles(list: (PathHandles | null)[]): (PathHandles | null)[] {
  let end = list.length;
  while (end > 0 && !list[end - 1]) end--;
  return list.slice(0, end);
}

const bezierPoint = (b: [V3, V3, V3, V3], t: number): V3 => {
  const u = 1 - t, uu = u * u, tt = t * t;
  const a = uu * u, bb = 3 * uu * t, cc = 3 * u * tt, dd = tt * t;
  return [
    a * b[0][0] + bb * b[1][0] + cc * b[2][0] + dd * b[3][0],
    a * b[0][1] + bb * b[1][1] + cc * b[2][1] + dd * b[3][1],
    a * b[0][2] + bb * b[1][2] + cc * b[2][2] + dd * b[3][2],
  ];
};

/**
 * The rail curve sampled to a polyline for the preview: `perSeg` points along each Bézier segment plus the
 * final endpoint, so it reads as a continuous curve. A single-node (or empty) rail returns its bare nodes.
 */
export function sampleRail(nodes: readonly V3[], perSeg = 12, handles?: PathHandleList): V3[] {
  const segs = railBezierSegments(nodes, handles);
  if (!segs.length) return nodes.slice();
  const out: V3[] = [];
  for (const s of segs) for (let k = 0; k < perSeg; k++) out.push(bezierPoint(s, k / perSeg));
  out.push(segs[segs.length - 1][3]);
  return out;
}
