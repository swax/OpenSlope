import type { PropLine, PropSheet, V3 } from '../doc/types';
import type { LevelProps } from '../reference/props';
import { resolveTerrainTexRef } from '../paint/textures';
import { lineJoints, type LineGround } from './prop-line';

/**
 * SHEETS (docs/071): one continuous textured surface drawn along a path — standing up as a fence, lying flat as a
 * river — and cut into one piece per span, which is how the shipped levels store theirs (GARI's chain-link fence
 * is 332 one-quad models placed once each, sharing corners).
 *
 * Two pure halves live here. `sheetPieces` cuts a sheet into its pieces: one quad per span between the line's
 * joints, neighbours sharing the joint edge exactly. `mineSheetFamilies` finds the sheets a shipped level was
 * cut into, so the Prop Library can offer each as one entry rather than hundreds of near-identical pieces.
 */

/** Span a sheet asks for before the fit, when it names none. */
export const SHEET_DEFAULT_SPAN = 4;
/** A blank standing sheet's height, and a blank lying one's width. */
export const SHEET_DEFAULT_HEIGHT = 3;
export const SHEET_DEFAULT_WIDTH = 8;
/** How far a lying sheet floats over the ground by default — enough to stay clear of the snow it covers. */
export const SHEET_DEFAULT_LIFT = 0.05;
/** A bend widens a lying sheet's joint edge so the strip keeps its width; this caps it on a hairpin. */
const MAX_MITRE = 2;

/** One piece: a one-quad tiled model's geometry, in world (editor) metres — corners A B C D in the tiled
 *  convention (A→B along the path, A→C up or across), placed at `anchor`. */
export interface SheetPiece {
  anchor: V3;
  vertices: number[];
  quads: number[][];
}

/** The span length a sheet asks for. */
export function sheetSpan(line: Pick<PropLine, 'spacing'>): number {
  return typeof line.spacing === 'number' && line.spacing > 0 ? line.spacing : SHEET_DEFAULT_SPAN;
}

/**
 * The edge each joint shares with the spans either side of it.
 *
 * Standing: from the ground at the joint straight up to the sheet's height — plumb, so a fence on a slope keeps
 * vertical ends while its top and bottom follow the ground. Lying: across the path, perpendicular to the two
 * neighbouring steps averaged (a mitre, lengthened to keep the width through a bend), level, lifted off the
 * ground. The first corner is the LEFT one, so a lying quad's (B−A)×(C−A) points up as the terrain's do.
 */
function jointEdges(joints: readonly V3[], heights: readonly number[], sheet: PropSheet): [V3, V3][] {
  return joints.map((joint, k) => {
    const ground = heights[k];
    if (!sheet.lie) return [[joint[0], ground, joint[2]], [joint[0], ground + sheet.size, joint[2]]];
    let tx = 0, tz = 0, count = 0;
    for (const [a, b] of [[joints[k - 1], joint], [joint, joints[k + 1]]] as const) {
      if (!a || !b) continue;
      const dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz);
      if (length > 1e-9) { tx += dx / length; tz += dz / length; count++; }
    }
    const t = Math.hypot(tx, tz) || 1;
    tx /= t; tz /= t;
    const mitre = count === 2 ? Math.min(MAX_MITRE, 2 / t) : 1; // |t1 + t2| = 2 cos(θ/2)
    const half = sheet.size / 2 * mitre;
    const y = ground + (sheet.lift ?? SHEET_DEFAULT_LIFT);
    // left of travel is (−tz, tx)
    return [[joint[0] - tz * half, y, joint[2] + tx * half], [joint[0] + tz * half, y, joint[2] - tx * half]];
  });
}

/**
 * Cut a sheet into its pieces: one quad per span between the line's joints, in order along the path. Empty for
 * a path under two nodes. Neighbouring pieces share their joint edge's two corners exactly, which is the whole
 * point — the seams the shipped fences never show.
 */
export function sheetPieces(line: Pick<PropLine, 'nodes' | 'handles' | 'spacing'> & { sheet: PropSheet }, ground: LineGround):
  SheetPiece[] {
  const fitted = lineJoints(line.nodes, sheetSpan(line), 'plan', line.handles);
  if (!fitted) return [];
  const { joints } = fitted;
  const heights = joints.map(joint => ground(joint[0], joint[2], joint[1]) ?? joint[1]);
  const edges = jointEdges(joints, heights, line.sheet);
  const pieces: SheetPiece[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    if (Math.hypot(joints[k + 1][0] - joints[k][0], joints[k + 1][2] - joints[k][2]) < 1e-6) continue;
    const [a, c] = edges[k], [b, d] = edges[k + 1];
    const corners = [a, b, c, d];
    const xs = corners.map(p => p[0]), zs = corners.map(p => p[2]);
    // anchored at the base centre, as a tiled model's home placement is
    const anchor: V3 = [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...corners.map(p => p[1])),
      (Math.min(...zs) + Math.max(...zs)) / 2];
    pieces.push({ anchor, vertices: corners.flat(), quads: [[0, 1, 2, 3]] });
  }
  return pieces;
}

// ---- the Prop Library's view of a shipped level: which of its pieces are one sheet -----------------------------

/** One sheet a shipped level was cut into, as the Prop Library offers it (docs/071). */
export interface SheetFamily {
  /** The pieces' shared base name — the family's identity within its level. */
  key: string;
  /** Every model of the family, placed or not, so the library can fold them all into one entry. */
  models: number[];
  /** How many placed pieces the level holds. */
  pieces: number;
  /** Lies flat (a river) rather than standing (a fence). */
  lie: boolean;
  /** Typical height (standing) or width (lying), metres. */
  size: number;
  /** Typical straight length of one piece, metres. */
  span: number;
  /** The tile the pieces wear, as a "LEVEL/file.png" ref, and whether it draws through the alpha pass. */
  texture: string | null;
  blend: boolean;
  /** The piece whose placement stands for the family's behaviour and effect: the first one in the level. */
  representative: { model: number; sourceIndex: number };
}

/** Base name: the model name less the trailing "_<n>" retail numbers its pieces with. */
export const sheetFamilyKey = (name: string): string => name.replace(/_\d+$/, '');

/** Most vertices a sheet piece may have. The retail pieces carry four (a fence) or six (a river strip). */
const PIECE_MAX_VERTICES = 24;
const MIN_FAMILY = 4;

/** Rotate `v` by quaternion `q` (x, y, z, w). */
function rotate(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/**
 * A piece's extent in plan along its own principal axis and across it (raw cm). Read off the plan points'
 * covariance, so a strip running diagonally across the level measures its own length rather than its bounding
 * box's diagonal.
 */
function planExtents(points: readonly V3[]): [number, number] {
  let mx = 0, my = 0;
  for (const p of points) { mx += p[0]; my += p[1]; }
  mx /= points.length || 1; my /= points.length || 1;
  let xx = 0, xy = 0, yy = 0;
  for (const p of points) { const dx = p[0] - mx, dy = p[1] - my; xx += dx * dx; xy += dx * dy; yy += dy * dy; }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let aMin = Infinity, aMax = -Infinity, cMin = Infinity, cMax = -Infinity;
  for (const p of points) {
    const a = p[0] * ux + p[1] * uy, c = -p[0] * uy + p[1] * ux;
    aMin = Math.min(aMin, a); aMax = Math.max(aMax, a); cMin = Math.min(cMin, c); cMax = Math.max(cMax, c);
  }
  return [aMax - aMin, cMax - cMin];
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Find the sheets a shipped level was cut into. A family is models that share a base name (four or more), are
 * each small, are nearly all placed exactly once, and — once placed — mostly share a vertex with a sibling:
 * similar props scattered around a level fail that last test, a surface cut into pieces passes it. Everything
 * is read in the level's own raw space (cm, Z up). Largest families first.
 */
export function mineSheetFamilies(lp: Pick<LevelProps, 'level' | 'models' | 'instances' | 'materials'>): SheetFamily[] {
  const byKey = new Map<string, LevelProps['models']>();
  for (const model of lp.models) {
    if (model.line) continue;
    const key = sheetFamilyKey(model.name);
    byKey.set(key, [...(byKey.get(key) ?? []), model]);
  }
  const placements = new Map<number, LevelProps['instances']>();
  for (const instance of lp.instances) {
    if (instance.visible === false) continue;
    placements.set(instance.model, [...(placements.get(instance.model) ?? []), instance]);
  }
  const out: SheetFamily[] = [];
  for (const [key, models] of byKey) {
    if (models.length < MIN_FAMILY) continue;
    if (models.some(model => model.subs.reduce((n, sub) => n + sub.positions.length / 3, 0) > PIECE_MAX_VERTICES)) continue;
    const placed = models.filter(model => placements.get(model.id)?.length);
    if (placed.length < MIN_FAMILY) continue;
    if (placed.filter(model => placements.get(model.id)!.length === 1).length < placed.length * 0.75) continue;

    // Every placed piece in world raw space.
    const pieces = placed.flatMap(model => placements.get(model.id)!.map(instance => ({
      model, instance,
      subs: model.subs.map(sub => {
        const world: V3[] = [];
        for (let i = 0; i < sub.positions.length; i += 3) {
          const [px, py, pz] = rotate(instance.rot,
            [sub.positions[i] * instance.scale[0], sub.positions[i + 1] * instance.scale[1], sub.positions[i + 2] * instance.scale[2]]);
          world.push([px + instance.loc[0], py + instance.loc[1], pz + instance.loc[2]]);
        }
        return { world, indices: sub.indices };
      }),
    })));

    // Shared vertices: a piece touching a sibling at a corner (to the centimetre).
    const owners = new Map<string, Set<number>>();
    pieces.forEach((piece, p) => {
      for (const sub of piece.subs) for (const v of sub.world) {
        const at = v.map(Math.round).join(',');
        const set = owners.get(at) ?? new Set<number>();
        set.add(p);
        owners.set(at, set);
      }
    });
    const touching = new Set<number>();
    for (const set of owners.values()) if (set.size > 1) for (const p of set) touching.add(p);
    if (touching.size < pieces.length * 0.5) continue;

    // Facing, size and span, per piece. The size is the piece's area over its length along the run: a standing
    // panel sheared down a slope still reads its true height (its z extent would add the drop), and a river strip
    // its true width whichever way it runs.
    let facingUp = 0, area = 0;
    const sizes: number[] = [], spans: number[] = [];
    for (const piece of pieces) {
      const [along] = planExtents(piece.subs.flatMap(sub => sub.world));
      let pieceArea = 0;
      for (const sub of piece.subs) {
        for (let t = 0; t + 2 < sub.indices.length; t += 3) {
          const a = sub.world[sub.indices[t]], b = sub.world[sub.indices[t + 1]], c = sub.world[sub.indices[t + 2]];
          const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
          pieceArea += Math.hypot(n[0], n[1], n[2]) / 2;
          facingUp += Math.abs(n[2]) / 2; // |n_z| weighted by area: the vertical share of the facing
        }
      }
      area += pieceArea;
      spans.push(along / 100);
      if (along > 1e-6) sizes.push(pieceArea / along / 100);
    }
    const lie = area > 0 && facingUp / area > 0.5;
    const first = pieces.reduce((best, piece) => piece.instance.sourceIndex < best.instance.sourceIndex ? piece : best);
    const material = lp.materials.get(first.model.subs[0]?.mat ?? -1);
    out.push({
      key,
      models: models.map(model => model.id),
      pieces: pieces.length,
      lie,
      size: median(sizes),
      span: median(spans),
      texture: material?.tex ? resolveTerrainTexRef(lp.level, material.tex) : null,
      blend: !!material?.blend,
      representative: { model: first.model.id, sourceIndex: first.instance.sourceIndex },
    });
  }
  return out.sort((a, b) => b.pieces - a.pieces);
}
