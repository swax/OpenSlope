import type { Rail, V3 } from '../doc/types';

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

/** The style a rail rides as (default metal), tolerating a doc saved before the style field existed. */
export const railStyle = (r: Rail): number => r.style ?? RAIL_STYLE_METAL;

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

/**
 * The rail's Catmull-Rom curve as a chain of cubic-Bézier segments: one per span between consecutive nodes,
 * each `[b0, b1, b2, b3]` in the nodes' own space. Uses the standard uniform CR→Bézier tangents (neighbour
 * difference / 6) with the endpoints clamped (P[-1]=P[0], P[n]=P[n-1]) — the same clamping sampleSpine does,
 * so the rail curve matches the run spine's. Fewer than two nodes yields no segments.
 */
export function railBezierSegments(nodes: V3[]): [V3, V3, V3, V3][] {
  const n = nodes.length;
  if (n < 2) return [];
  const at = (i: number) => nodes[Math.max(0, Math.min(n - 1, i))];
  const segs: [V3, V3, V3, V3][] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const b1: V3 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p1[2] + (p2[2] - p0[2]) / 6];
    const b2: V3 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[2] - (p3[2] - p1[2]) / 6];
    segs.push([p1, b1, b2, p2]);
  }
  return segs;
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
export function sampleRail(nodes: V3[], perSeg = 12): V3[] {
  const segs = railBezierSegments(nodes);
  if (!segs.length) return nodes.slice();
  const out: V3[] = [];
  for (const s of segs) for (let k = 0; k < perSeg; k++) out.push(bezierPoint(s, k / perSeg));
  out.push(segs[segs.length - 1][3]);
  return out;
}
