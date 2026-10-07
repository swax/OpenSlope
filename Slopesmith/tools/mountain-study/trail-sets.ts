/**
 * Find a map's matched trail tile SETS from its patches alone (docs/023 · Textures) — no hand-picked centreline — and
 * the MIDDLE tile each could wear across a wider trail.
 *
 * A trail lane wears one piece of a picture drawn across the trail's width, so wherever two textured patches meet with
 * the RIGHT art edge of one tile on the LEFT art edge of the other, art up the same way — and the pixels either side of
 * the seam agree, so the art really does run on (`SEAM_APART`) — the picture runs on across that seam. Following such
 * seams across gives a ROW: the tiles one span of a trail wears from rim to rim. A row two tiles wide is a pair, as
 * Mesa's trails are; a wider row shows the tiles a map lays BETWEEN its edges — a middle seen in use. Plain GROUND runs
 * on across its seams too, tiled with itself, so a tile laid beside itself that way often is ground, and a row's ground
 * is trimmed off its ends: a trail running into snow is as wide as its own tiles. A row is then kept when it is two to
 * `MAX_LANES` wide, its edges are other tiles than its middles, and it lies mostly on trail ground. For each row the
 * study reads, going downhill along it: which edge is on the rider's left, whether the art's top faces downhill or
 * uphill, and how tightly and which way it turns, from its two rims' lengths (the inner rim is the shorter).
 *
 * Rows are grouped by their two edge tiles, each way they are laid. Two tiles laid mostly through tight turns are turn
 * sets — the way they are laid most through left turns a left-turn set, through right turns a right-turn set (Mesa turns
 * its stripes round for a right turn) — and any others a trail set, laid its commonest way.
 *
 * Every set is then given a middle by its ART as well: a middle sits between the edges, so its left art edge should run
 * on from the left tile's right edge and its right art edge into the right tile's left edge — where the two edges meet
 * now. Each of the map's trail tiles is scored by how far its edge columns are from those (mean colour difference, 0 to
 * 1), against how far the edges are from each other already; by how well it repeats beside itself, which a trail of
 * four lanes or more asks of it; and by how far its whole picture's colour is from the edges' — edges alone would take
 * a logo or a marker with snow round it. The middle printed is the one seen in use, or else the best fit by art.
 *
 * A trail runs on into other rows: the study counts, for each set, the sets whose rows are next along its trails — a
 * map's turn rows are next to the trail they mark — and so gives each trail set as a WHOLE set, the 4×3 a path wears:
 * its row, the turn rows it runs on into most each way (with its middle, where none was seen between theirs: a map marks
 * a turn on its edges), and its commonest cap.
 *
 * A trail ENDS too, and many maps close it with a CAP — corner pieces drawn round its end. Along a trail the rows meet
 * across their tiles' art tops and bottoms, so from a row of a set with another of the set behind it the study walks
 * out along the trail: rows of other tiles, up to `MAX_CAP_ROWS`, and then open ground, are that set's cap; the set's
 * own row running straight into ground is a bare end. Each cap tile is read as a rider sees it travelling out to the
 * end — which way its art's top faces, and whether it is mirrored — so a cap found at a trail's start and one at its
 * end read alike. A row that is mostly a cap is not offered as a set of its own. Between two rows of a set it also
 * reads how the next is laid — repeated, turned half round, or flipped — which is how a map runs its art on along a
 * trail.
 *
 * Usage:
 *   npx tsx tools/mountain-study/trail-sets.ts            every map
 *   npx tsx tools/mountain-study/trail-sets.ts GARI SNOW   just these
 *   … --min 5                                             only sets seen on at least 5 rows (default 3)
 *
 * Writes `temp/trail-sets.html` — every candidate row as the art, the way a rider going downhill sees it, with its
 * middle candidates and the line it is written as in a set, and each trail's whole set with the literal to paste into
 * `TRAIL_TILE_SETS` — and `temp/trail-sets.json`; and `temp/trail-caps.html`, every cap closing its trail, two lanes wide
 * (2×2: the trail's last row and the cap) and three (2×3, with the set's middle and a middle for the cap by art), each
 * with its `cap:` row where it is laid at one turn (some tiles mirrored). The pictures are read from
 * `Maps/<level>/Textures`, so the sheets are only for this machine. (trail-presets.ts draws the built-in sets.)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrailTileRow, TrailTileSet } from '../../src/core/doc/types';
import { trailTileViewOrient } from '../../src/core/mesh/trail-textures';
import { buildReferenceMesh, type RawPatch } from '../../src/core/reference/terrain';
import { surfaceTypeLabel } from '../../src/core/reference/surface-types';
import type { Rgba } from '../../src/core/paint/ground-textures';
import { decodePng } from '../../src/server/routes/png';
import { MAPS_DIR, tempFile } from './paths';
import { esc, rowLiteral, SET_CSS, setHtml, setLiteral } from './set-art';

const args = process.argv.slice(2);
const minAt = args.indexOf('--min');
const MIN_ROWS = minAt >= 0 ? Number(args[minAt + 1]) : 3;
const named = args.filter((arg, i) => !arg.startsWith('--') && (minAt < 0 || i !== minAt + 1));
const levels = named.length ? named
  : readdirSync(MAPS_DIR).filter(level => existsSync(join(MAPS_DIR, level, 'Patches.json'))).sort();

/** A row turning tighter than this is a turn — the radius a path's turn tiles start at — and wider, straight. */
const TURN_RADIUS_M = 80;
/** Two tiles laid through turns at least this often are turn sets. */
const TURN_SHARE = 0.6;
/** Ground no trail is laid on: out of bounds, unskiable, rock, wall, wood, metal. */
const NOT_TRAIL = new Set([0, 6, 9, 10, 12, 13]);
/** The widest row taken for a trail; wider is a field. */
const MAX_LANES = 8;
/** The most two edge columns may differ for the art to run on across their seam; Mesa's own run 0.02 to 0.05. */
const SEAM_APART = 0.1;
/** A tile laid beside itself, art running on, at least this often — and on this share of its patches — is ground. */
const GROUND_SEAMS = 3;
const GROUND_SHARE = 0.05;
/** A tile scored as a middle must be laid on this many trail-ground patches of the map. */
const MIN_TILE_USE = 2;
/** Middle candidates shown by art, each set. */
const ART_SHOWN = 5;
/** The most a middle's colour may be from its edges' for the art to choose it. */
const MAX_BODY = 0.08;
/** The deepest a cap may be, in rows, before the trail's end. */
const MAX_CAP_ROWS = 3;
/** Caps shown each set. */
const CAPS_SHOWN = 3;

type V = readonly number[];
const sub = (a: V, b: V) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const key = (p: V) => p.map(x => Math.round(x * 20)).join(',');
const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
const median = (xs: readonly number[]) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
const bump = <K>(map: Map<K, number>, k: K, by = 1) => map.set(k, (map.get(k) ?? 0) + by);

/** One way two edge tiles are laid — which is on a rider's left going downhill, whether the art's top faces downhill,
 *  and which is the picture's left — and the rows laid so: how many, which way they turn, how tightly, how wide, and
 *  the tiles between their edges. */
interface Laying {
  left: string; right: string; topDownhill: boolean; pictureLeft: string; pictureRight: string;
  rows: number; lefts: number; rights: number; straight: number; radii: number[];
  widths: Map<number, number>; middles: Map<string, number>;
}
/** One tile as a rider sees it travelling out toward the trail's end: which way its art's top faces — 0 ahead, 1 right,
 *  2 back, 3 left — and whether it is mirrored. */
interface Seen { tile: string; turn: number; mirror: boolean }
/** A cap: its rows from the trail's last row of the set outward, each from the rider's left; how often it was found; and
 *  that last row, as seen from the same place. */
interface Cap { rows: Seen[][]; count: number; body: Seen[] }
/** Two edge tiles, every way they are laid, and the ground under them; how their trails end; how the next row of them
 *  along a trail is laid; the other couples whose rows are next along it, by id; and how often their rows were another
 *  set's cap. */
interface Couple {
  id: string; level: string; layings: Map<string, Laying>; surfaces: Map<number, number>;
  caps: Map<string, Cap>; bareEnds: number; along: Map<string, number>; next: Map<string, number>; capRows: number;
}
/** A map's rows by edge tiles, and the tiles it lays on trail ground. */
interface Study { couples: Couple[]; tiles: Map<string, number> }

// ---- the art -----------------------------------------------------------------------------------------------------

/** A tile's left and right art edges as colour columns, `SAMPLES` blocks top to bottom, each the mean of its rows,
 *  and its whole picture's mean colour. */
interface Edges { left: Float64Array; right: Float64Array; mean: Float64Array }
const SAMPLES = 32;
const edgeCache = new Map<string, Edges | null>();

function edgesOf(level: string, file: string): Edges | null {
  const id = `${level}/${file}`;
  if (edgeCache.has(id)) return edgeCache.get(id)!;
  let out: Edges | null = null;
  try {
    const { w, h, data } = decodePng(readFileSync(join(MAPS_DIR, level, 'Textures', file)));
    const column = (x: number) => {
      const col = new Float64Array(SAMPLES * 3);
      for (let y = 0; y < h; y++) {
        const s = Math.min(SAMPLES - 1, Math.floor((y * SAMPLES) / h)), at = (y * w + x) * 4;
        for (let ch = 0; ch < 3; ch++) col[s * 3 + ch] += data[at + ch] / (255 * (h / SAMPLES));
      }
      return col;
    };
    const mean = new Float64Array(3);
    for (let i = 0; i < w * h; i++) for (let ch = 0; ch < 3; ch++) mean[ch] += data[i * 4 + ch] / (255 * w * h);
    out = { left: column(0), right: column(w - 1), mean };
  } catch { /* a tile that cannot be read is no candidate */ }
  edgeCache.set(id, out);
  return out;
}

/** How far apart two edge columns are: their mean colour difference, 0 (the same) to 1. */
function apart(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Every trail row of one map, by its edge tiles. */
function study(level: string): Study {
  const raw = JSON.parse(readFileSync(join(MAPS_DIR, level, 'Patches.json'), 'utf8')) as { Patches: RawPatch[] };
  const ref = buildReferenceMesh(raw.Patches.filter(p => p.Points?.length >= 16), undefined, 1);
  const { patchCorners: corners, patchUV: uvs, patchTex: tex, patchSurf: surf } = ref;
  // A patch's four sides as corner pairs, corners [A, B, C, D] at (0,0), (0,1), (1,0), (1,1).
  const SIDES: readonly (readonly [number, number])[] = [[0, 1], [1, 3], [3, 2], [2, 0]];
  const opposite = (side: readonly number[]) => SIDES.find(s => !s.includes(side[0]) && !s.includes(side[1]))!;
  const sideKey = (patch: number, side: readonly number[]) =>
    [key(corners[patch][side[0]]), key(corners[patch][side[1]])].sort().join('|');

  const tiles = new Map<string, number>();
  const bySide = new Map<string, { patch: number; side: readonly [number, number] }[]>();
  corners.forEach((_, patch) => {
    if (!tex[patch] || !uvs[patch]) return;
    if (!NOT_TRAIL.has(surf[patch])) bump(tiles, tex[patch]!);
    for (const side of SIDES) {
      const k = sideKey(patch, side);
      (bySide.get(k) ?? bySide.set(k, []).get(k)!).push({ patch, side });
    }
  });

  /** The art edge a side of a patch lies on — the tile's left or right, read off its UVs (x is u; up is −v, the
   *  terrain sampling flipY=false) — and which of its corners is the art's top; null for any other side. */
  const artEdge = (patch: number, side: readonly [number, number]) => {
    const uv = uvs[patch]!;
    const floor = Math.floor(Math.min(...uv.map(p => p[0])) + 1e-6);
    const [i, j] = side, xi = uv[i][0] - floor, xj = uv[j][0] - floor;
    if (!near(xi, xj) || !(near(xi, 0) || near(xi, 1))) return null;
    return { right: near(xi, 1), top: -uv[i][1] > -uv[j][1] ? i : j };
  };

  type Half = { patch: number; side: readonly [number, number] };
  /** Across each matched seam: the patch on the picture's right of a patch, and the seam, its top corner the left's. */
  const rightOf = new Map<number, { patch: number; left: Half; right: Half; top: number }>();
  const hasLeft = new Set<number>();
  /** Each tile's seams beside itself. */
  const selfSeams = new Map<string, number>();
  for (const list of bySide.values()) {
    if (list.length !== 2) continue;
    const [a, b] = list;
    const ea = artEdge(a.patch, a.side), eb = artEdge(b.patch, b.side);
    if (!ea || !eb || ea.right === eb.right) continue;
    if (key(corners[a.patch][ea.top]) !== key(corners[b.patch][eb.top])) continue;
    const [l, r, top] = ea.right ? [a, b, ea.top] : [b, a, eb.top];
    const [lArt, rArt] = [edgesOf(level, tex[l.patch]!), edgesOf(level, tex[r.patch]!)];
    if (!lArt || !rArt || apart(lArt.right, rArt.left) > SEAM_APART) continue;
    rightOf.set(l.patch, { patch: r.patch, left: l, right: r, top });
    hasLeft.add(r.patch);
    if (tex[l.patch] === tex[r.patch]) bump(selfSeams, tex[l.patch]!);
  }
  const uses = new Map<string, number>();
  for (const name of tex) if (name) bump(uses, name);
  const ground = (patch: number) => {
    const seams = selfSeams.get(tex[patch]!) ?? 0;
    return seams >= GROUND_SEAMS && seams >= GROUND_SHARE * (uses.get(tex[patch]!) ?? 1);
  };

  const couples = new Map<string, Couple>();
  /** Every row kept, and the edge tiles it is grouped by. */
  const rows: { patches: number[]; id: string }[] = [];
  for (const start of rightOf.keys()) {
    if (hasLeft.has(start)) continue;
    // The row, the picture's left to its right — ground and all, a field's worth at most — then its ground trimmed off
    // both ends.
    const whole = [start];
    while (rightOf.has(whole.at(-1)!) && whole.length < 256) {
      const next = rightOf.get(whole.at(-1)!)!.patch;
      if (whole.includes(next)) break;
      whole.push(next);
    }
    let [first, last] = [0, whole.length - 1];
    while (first <= last && ground(whole[first])) first++;
    while (last >= first && ground(whole[last])) last--;
    const row = whole.slice(first, last + 1);
    if (row.length < 2 || row.length > MAX_LANES) continue;
    const edges = [tex[row[0]]!, tex[row.at(-1)!]!], middles = row.slice(1, -1).map(patch => tex[patch]!);
    if (edges[0] === edges[1] || middles.some(middle => edges.includes(middle))) continue;
    // Downhill along the row's first seam, its picture's left patch `a` and right `b`.
    const { left: a, right: b, top } = rightOf.get(row[0])!;
    const c = corners[a.patch];
    const [p, q] = [c[a.side[0]], c[a.side[1]]];
    const [high, low] = p[1] >= q[1] ? [p, q] : [q, p];
    const flow = sub(low, high), run = Math.hypot(flow[0], flow[2]);
    if (run < 1e-6) continue;
    // Data space is the game's left-handed frame: facing `flow`, a rider's left is (−fz, 0, fx).
    const leftward = [-flow[2] / run, 0, flow[0] / run];
    const mid = [(high[0] + low[0]) / 2, (high[1] + low[1]) / 2, (high[2] + low[2]) / 2];
    const centre = (patch: number) => [0, 1, 2].map(k => corners[patch].reduce((s, v) => s + v[k], 0) / 4);
    const pictureLeftOnLeft = (() => { const d = sub(centre(a.patch), mid); return d[0] * leftward[0] + d[2] * leftward[2] > 0; })();
    // Going downhill, the art's top faces downhill when the picture reads as found — its left on the left.
    const topDownhill = key(c[top]) === key(low);
    const outer: [Half, Half] = [{ patch: row[0], side: opposite(a.side) }, {
      patch: row.at(-1)!, side: opposite(row.length === 2 ? b.side : rightOf.get(row.at(-2)!)!.right.side),
    }];
    const [riderLeft, riderRight] = pictureLeftOnLeft ? outer : [outer[1], outer[0]];
    // The turn, from the rims: each edge's side across from the rest of the row.
    const rim = (half: Half) => { const k = corners[half.patch]; return { len: dist(k[half.side[0]], k[half.side[1]]), at: [0, 1, 2].map(i => (k[half.side[0]][i] + k[half.side[1]][i]) / 2) }; };
    const l = rim(riderLeft), r = rim(riderRight);
    const theta = (r.len - l.len) / Math.max(dist(l.at, r.at), 1e-6); // > 0: the right rim is longer, turning left
    const radius = Math.abs(theta) > 1e-4 ? dist(high, low) / Math.abs(theta) : Infinity;
    const left = tex[riderLeft.patch]!, right = tex[riderRight.patch]!;
    const id = [left, right].sort().join('|');
    const couple = couples.get(id) ?? {
      id, level, layings: new Map<string, Laying>(), surfaces: new Map<number, number>(),
      caps: new Map<string, Cap>(), bareEnds: 0, along: new Map<string, number>(), next: new Map<string, number>(), capRows: 0,
    };
    rows.push({ patches: row, id });
    const how = `${left}|${right}|${topDownhill}`;
    const lay: Laying = couple.layings.get(how) ?? {
      left, right, topDownhill, pictureLeft: edges[0], pictureRight: edges[1],
      rows: 0, lefts: 0, rights: 0, straight: 0, radii: [], widths: new Map(), middles: new Map(),
    };
    lay.rows++; lay.radii.push(radius);
    if (radius > TURN_RADIUS_M) lay.straight++; else if (theta > 0) lay.lefts++; else lay.rights++;
    bump(lay.widths, row.length);
    for (const middle of middles) bump(lay.middles, middle);
    couple.layings.set(how, lay);
    for (const patch of row) bump(couple.surfaces, surf[patch]);
    couples.set(id, couple);
  }
  // ---- along the trails: how the rows follow each other, and how they end ----------------------------------------
  /** A patch's art right and art up as plan vectors (x, z), read off its UVs; null for a patch not one whole tile. */
  const artFrame = (patch: number): { right: [number, number]; up: [number, number] } | null => {
    const uv = uvs[patch]!, k = corners[patch];
    const fu = Math.floor(Math.min(...uv.map(p => p[0])) + 1e-6), fv = Math.floor(Math.min(...uv.map(p => p[1])) + 1e-6);
    const at = (u: number, v: number) => uv.findIndex(p => near(p[0] - fu, u) && near(p[1] - fv, v));
    const [tl, tr, bl] = [at(0, 0), at(1, 0), at(0, 1)];
    if (tl < 0 || tr < 0 || bl < 0) return null;
    return { right: [k[tr][0] - k[tl][0], k[tr][2] - k[tl][2]], up: [k[tl][0] - k[bl][0], k[tl][2] - k[bl][2]] };
  };
  /** The side of a patch its art's top (or bottom) edge lies on. */
  const artEnd = (patch: number, end: 'top' | 'bottom') => {
    const uv = uvs[patch]!, fv = Math.floor(Math.min(...uv.map(p => p[1])) + 1e-6), want = end === 'top' ? 0 : 1;
    return SIDES.find(([i, j]) => near(uv[i][1] - fv, want) && near(uv[j][1] - fv, want)) ?? null;
  };
  type Step = { patch: number; side: readonly [number, number] } | null;
  /** The patches across each of these sides, and the side of each across from where it was entered. */
  const step = (from: readonly Step[]): Step[] => from.map(h => {
    const list = h && bySide.get(sideKey(h.patch, h.side));
    const next = list?.length === 2 ? list.find(other => other.patch !== h!.patch) : undefined;
    return next && tex[next.patch] ? { patch: next.patch, side: opposite(next.side) } : null;
  });
  const patchesOf = (row: readonly Step[]) => row.map(h => h?.patch ?? null);
  const open = (patches: readonly (number | null)[]) => patches.filter(p => p === null || ground(p)).length * 2 >= patches.length;
  const plan = (patches: readonly number[]): [number, number] => {
    const at = patches.flatMap(p => corners[p]);
    return [at.reduce((s, v) => s + v[0], 0) / at.length, at.reduce((s, v) => s + v[2], 0) / at.length];
  };
  /** A patch as a rider facing `f` (a plan unit vector) sees it. */
  const seenIn = (patch: number, f: [number, number]): Seen | null => {
    const frame = artFrame(patch);
    if (!frame) return null;
    // Data space is the game's left-handed frame: facing f, a rider's right is (fz, −fx).
    const r: [number, number] = [f[1], -f[0]];
    const coords = (v: [number, number]) => [v[0] * r[0] + v[1] * r[1], v[0] * f[0] + v[1] * f[1]];
    const [ur, uf] = coords(frame.up), [rr, rf] = coords(frame.right);
    const turn = Math.abs(uf) >= Math.abs(ur) ? (uf > 0 ? 0 : 2) : (ur > 0 ? 1 : 3);
    // Unmirrored, art right is art up turned a quarter clockwise.
    return { tile: tex[patch]!, turn, mirror: rr * uf - rf * ur < 0 };
  };
  /** A row's patches from the left of a rider facing `f`. */
  const fromLeft = (patches: readonly number[], f: [number, number]) => {
    const r = [f[1], -f[0]];
    return [...patches].sort((p, q) => { const [a, b] = [plan([p]), plan([q])]; return a[0] * r[0] + a[1] * r[1] - (b[0] * r[0] + b[1] * r[1]); });
  };
  const rowAt = new Map<number, number>();
  rows.forEach((row, i) => row.patches.forEach(patch => rowAt.set(patch, i)));

  /**
   * How far each tile lies from a trail's end: for every patch, the rows to open ground along its art up or down (1
   * beside it), and for its tile the fewest rows within which most of its patches lie — a cap tile's are by an end, a
   * trail tile's mostly further in. Infinity for a tile mostly further than a cap is deep.
   */
  const toEnd = (patch: number): number => {
    let best = MAX_CAP_ROWS + 2;
    for (const end of ['top', 'bottom'] as const) {
      const side = artEnd(patch, end);
      if (!side) continue;
      let cur: Step[] = [{ patch, side }];
      for (let k = 1; k < best; k++) {
        const next = step(cur);
        if (!next[0] || ground(next[0].patch)) { best = k; break; }
        cur = next;
      }
    }
    return best;
  };
  const reaches = new Map<string, number[]>();
  tex.forEach((name, patch) => { if (name && uvs[patch] && !ground(patch)) (reaches.get(name) ?? reaches.set(name, []).get(name)!).push(toEnd(patch)); });
  const endDepth = new Map<string, number>();
  for (const [name, list] of reaches) {
    let depth = Infinity;
    for (let d = MAX_CAP_ROWS; d >= 1; d--) if (list.length >= 2 && list.filter(k => k <= d).length >= list.length * 0.6) depth = d;
    endDepth.set(name, depth);
  }
  /** Whether a row's tiles all lie within `depth` rows of an end, as a cap's do. */
  const capRow = (patches: readonly number[], depth: number) => patches.every(p => endDepth.get(tex[p]!)! <= depth);

  for (const { patches: body, id } of rows) {
    const couple = couples.get(id)!;
    for (const end of ['top', 'bottom'] as const) {
      const out = body.map(p => artEnd(p, end));
      if (out.some(side => !side)) continue;
      // Out along the trail, row by row, to open ground or past where a cap could reach.
      let cur: Step[] = body.map((patch, k) => ({ patch, side: out[k]! }));
      const passed: number[][] = [];
      let ended = false;
      for (let k = 0; k <= MAX_CAP_ROWS; k++) {
        const next = step(cur), patches = patchesOf(next);
        if (!k) {
          // The next row along, where it is one row of another couple's: the set the trail runs on into — a turn's.
          const theirs = new Set(patches.map(p => p === null ? undefined : rowAt.get(p)));
          const [j] = theirs;
          if (theirs.size === 1 && j !== undefined && rows[j].id !== id) bump(couple.next, rows[j].id);
        }
        if (open(patches)) { ended = true; break; }
        if (patches.some(p => p === null || ground(p))) break;
        if (!k && !capRow(patches as number[], MAX_CAP_ROWS)) {
          // The trail running on: how its next row is laid against this one.
          const [mine, theirs] = [artFrame(body[0]), artFrame(patches[0]!)];
          if (mine && theirs) {
            const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1];
            const up = dot(mine.up, theirs.up) > 0, right = dot(mine.right, theirs.right) > 0;
            bump(couple.along, up ? (right ? 'repeated' : 'mirrored') : right ? 'flipped' : 'turned');
          }
        }
        passed.push(patches as number[]);
        cur = next;
      }
      if (!ended) continue;
      // A row of the set itself is no cap tile's: the end is bare where it runs straight into ground, and capped where
      // every row passed is a cap's, each within its own distance of the end.
      if (capRow(body, passed.length + 1)) continue;
      if (!passed.length) { couple.bareEnds++; continue; }
      // Each within its own distance of the end, and on trail ground: a trail running into a cliff is not capped by it.
      if (!passed.every((row, i) => capRow(row, passed.length - i) && row.every(p => !NOT_TRAIL.has(surf[p])))) continue;
      const a = plan(body), b = plan(passed[0]), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const f: [number, number] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const seen = passed.map(row => fromLeft(row, f).map(p => seenIn(p, f)));
      const last = fromLeft(body, f).map(p => seenIn(p, f));
      if (seen.flat().some(s => !s) || last.some(s => !s)) continue;
      const sig = JSON.stringify(seen);
      const found = couple.caps.get(sig) ?? { rows: seen as Seen[][], count: 0, body: last as Seen[] };
      found.count++;
      couple.caps.set(sig, found);
      // A cap row that is a row of its own is counted against its own set.
      for (const row of passed) {
        const own = new Set(row.map(p => rowAt.get(p)));
        if (own.size === 1 && !own.has(undefined)) couples.get(rows[[...own][0]!].id)!.capRows++;
      }
    }
  }

  const rowsOf = (couple: Couple) => [...couple.layings.values()].reduce((n, lay) => n + lay.rows, 0);
  return {
    tiles,
    couples: [...couples.values()].filter(couple => {
      const all = [...couple.surfaces.values()].reduce((n, k) => n + k, 0);
      const offTrail = [...couple.surfaces].reduce((n, [type, k]) => n + (NOT_TRAIL.has(type) ? k : 0), 0);
      return rowsOf(couple) >= MIN_ROWS && offTrail * 2 < all && couple.capRows * 2 < rowsOf(couple);
    }),
  };
}

/** A tile scored as the middle between a picture's left and right tiles: how far its edges are from theirs (`fit`),
 *  from each other (`self`, how it repeats beside itself), and its colour from theirs (`body`); `score` all three. */
interface MiddleFit { tile: string; fit: number; self: number; body: number; score: number }

/** Every trail tile of the map but the edges, as a middle between them, best first. */
function middlesByArt(level: string, pictureLeft: string, pictureRight: string, tiles: Map<string, number>): { seam: number; fits: MiddleFit[] } | null {
  const l = edgesOf(level, pictureLeft), r = edgesOf(level, pictureRight);
  if (!l || !r) return null;
  const fits: MiddleFit[] = [];
  for (const [tile, uses] of tiles) {
    if (uses < MIN_TILE_USE || tile === pictureLeft || tile === pictureRight) continue;
    const m = edgesOf(level, tile);
    if (!m) continue;
    const fit = (apart(l.right, m.left) + apart(m.right, r.left)) / 2, self = apart(m.right, m.left);
    const body = apart(m.mean, l.mean.map((v, ch) => (v + r.mean[ch]) / 2));
    fits.push({ tile, fit, self, body, score: fit + self / 2 + body });
  }
  fits.sort((x, y) => x.score - y.score);
  return { seam: apart(l.right, r.left), fits };
}

// ---- the sets ----------------------------------------------------------------------------------------------------

/** What a row is: a trail's, a turn's one way or either, or a cap's. */
type Kind = 'trail' | 'left-turn' | 'right-turn' | 'turn' | 'cap';
/** A row the study finds, as the row of a set it would be: its map, its name there, and what it is. */
interface FoundRow extends TrailTileRow { level: string; name: string; kind: Kind }

/** A candidate row for `trail-textures.ts`, and the evidence for it. */
interface Candidate {
  set: FoundRow;
  /** Rows of the tiles together — or, for a turn set, laid its way — and how they turn. */
  rows: number; left: number; right: number; straight: number; radius: number;
  /** Of them, laid exactly as the set is. */
  laid: number;
  surfaces: number[];
  /** How wide its rows were, and the middles seen in them. */
  widths: [number, number][];
  seen: [string, number][];
  /** Its picture's left and right tiles, for the art. */
  pictureLeft: string; pictureRight: string;
  /** How far its edges are from each other, and the middles by art. */
  seam: number | null;
  byArt: MiddleFit[];
  /** Where its middle came from. */
  middleFrom: 'seen' | 'art' | null;
  /** Its trails' caps, commonest first; how many ended bare; and how the next row along is laid. */
  caps: Cap[]; bareEnds: number; along: [string, number][];
  /** Its two edge tiles' id, and the sets its rows run on into, commonest first — by the names they are given. */
  couple: string; next: [string, number][];
  /** A trail's whole set: it, its turns and its cap. */
  full?: TrailTileSet;
}

const tileRef = (level: string, file: string) => (file.includes('/') ? file : `${level}/${file}`);

/** Two edge tiles as the sets they make: a trail set laid their commonest way, or a turn set for each way of turning
 *  they are laid through. */
function candidates(couple: Couple): Candidate[] {
  const layings = [...couple.layings.values()];
  const sum = (pick: (lay: Laying) => number) => layings.reduce((n, lay) => n + pick(lay), 0);
  const rows = sum(lay => lay.rows), lefts = sum(lay => lay.lefts), rights = sum(lay => lay.rights);
  const surfaces = [...couple.surfaces.keys()].sort((x, y) => x - y);
  // Laid with its top downhill a tile is upright to a rider: a trail tile's own half turn plus two
  // (`trailTileViewOrient`); with its top uphill, as the trail tile's own turn.
  const set = (lay: Laying, kind: Kind): FoundRow => ({
    level: couple.level, name: '', kind, left: tileRef(couple.level, lay.left), right: tileRef(couple.level, lay.right),
    quarterTurns: lay.topDownhill ? 2 : 0,
  });
  // The middles and widths of every laying of the tiles: a middle seen between them fits however they are laid.
  const merged = (pick: (lay: Laying) => Map<string | number, number>) => {
    const out = new Map<string | number, number>();
    for (const lay of layings) for (const [k, n] of pick(lay)) bump(out, k, n);
    return [...out].sort((x, y) => y[1] - x[1]);
  };
  const widths = merged(lay => lay.widths as Map<string | number, number>) as [number, number][];
  const seen = merged(lay => lay.middles as Map<string | number, number>) as [string, number][];
  const rotated = (lay: Laying) => `${lay.right}|${lay.left}|${!lay.topDownhill}`;
  const caps = [...couple.caps.values()].sort((x, y) => y.count - x.count);
  const along = [...couple.along].sort((x, y) => y[1] - x[1]);
  const evidence = (lay: Laying, n: { rows: number; lefts: number; rights: number; straight: number; radii: number[] }) => ({
    rows: n.rows, left: n.lefts, right: n.rights, straight: n.straight, radius: median(n.radii), surfaces, laid: lay.rows,
    widths, seen, pictureLeft: lay.pictureLeft, pictureRight: lay.pictureRight, seam: null, byArt: [], middleFrom: null,
    caps, bareEnds: couple.bareEnds, along, couple: couple.id, next: [...couple.next].sort((x, y) => y[1] - x[1]),
  });
  if ((lefts + rights) / rows < TURN_SHARE) {
    const commonest = layings.reduce((best, lay) => lay.rows > best.rows ? lay : best);
    return [{ set: set(commonest, 'trail'), ...evidence(commonest, { rows, lefts, rights, straight: sum(lay => lay.straight), radii: layings.flatMap(lay => lay.radii) }) }];
  }
  // Each way of turning: the laying used most for it — on a tie, the other way's laying turned round, as Mesa's are.
  const best = (count: (lay: Laying) => number, partner?: Laying) => layings.reduce((top, lay) =>
    count(lay) > count(top) || (count(lay) === count(top) && partner && `${lay.left}|${lay.right}|${lay.topDownhill}` === rotated(partner)) ? lay : top);
  // A way of turning seen on fewer than two rows is not one the map marks.
  const forLeft = lefts ? best(lay => lay.lefts) : null;
  const forRight = rights ? best(lay => lay.rights, forLeft ?? undefined) : null;
  const leftOk = !!forLeft && forLeft.lefts >= 2, rightOk = !!forRight && forRight.rights >= 2;
  if (leftOk && rightOk && forLeft === forRight) return [{ set: set(forLeft!, 'turn'), ...evidence(forLeft!, forLeft!) }];
  const out: Candidate[] = [];
  if (leftOk) out.push({ set: set(forLeft!, 'left-turn'), ...evidence(forLeft!, forLeft!) });
  if (rightOk) out.push({ set: set(forRight!, 'right-turn'), ...evidence(forRight!, forRight!) });
  return out;
}

/** Give a set its middle: the one seen between its edges most, if more than once, or else the best by art when it runs
 *  on from both edges about as well as they run into each other — no worse than twice their own seam, or 0.06 — and is
 *  about their colour (`MAX_BODY`). */
function dress(c: Candidate, tiles: Map<string, number>) {
  const art = middlesByArt(c.set.level, c.pictureLeft, c.pictureRight, tiles);
  if (art) { c.seam = art.seam; c.byArt = art.fits.slice(0, ART_SHOWN); }
  const [seen, times] = c.seen[0] ?? [];
  if (seen && times! >= 2) { c.set.middle = tileRef(c.set.level, seen); c.middleFrom = 'seen'; return; }
  const top = c.byArt[0];
  if (top && c.seam !== null && top.fit <= Math.max(c.seam * 2, 0.06) && top.body <= MAX_BODY) {
    c.set.middle = tileRef(c.set.level, top.tile); c.middleFrom = 'art';
  }
}

const KIND_WORDS: Record<Kind, string> = { trail: 'Trail', 'left-turn': 'Left Turn', 'right-turn': 'Right Turn', turn: 'Turn', cap: 'Cap' };
const KIND_ORDER: Kind[] = ['trail', 'left-turn', 'right-turn', 'turn'];
/** The rows of a set a found row is. */
const ROW_KEYS: Record<Kind, string[]> = {
  trail: ['trail'], 'left-turn': ['leftTurn'], 'right-turn': ['rightTurn'], turn: ['rightTurn', 'leftTurn'], cap: ['cap'],
};

/** A found row as a set's row. */
const rowOf = (s: FoundRow): TrailTileRow => ({
  left: s.left, right: s.right, ...(s.middle ? { middle: s.middle } : {}), ...(s.mirrored?.length ? { mirrored: [...s.mirrored] } : {}),
  quarterTurns: s.quarterTurns,
});

/** A trail candidate as a whole set: its row; the turn rows it runs on into most each way, with its middle where none
 *  was seen between theirs — a map marks a turn on its edges; and its commonest cap laid at one turn, its row at the
 *  very end, a two-lane cap given the trail's middle. */
function fullSet(c: Candidate, found: readonly Candidate[]): TrailTileSet {
  const trail = rowOf(c.set);
  const byName = new Map(found.map(f => [f.set.name, f] as const));
  const turn = (kinds: readonly Kind[]): TrailTileRow | undefined => {
    for (const [names] of c.next) {
      for (const name of names.split(' / ')) {
        const t = byName.get(name);
        if (!t || !kinds.includes(t.set.kind)) continue;
        const row = rowOf(t.set);
        if (t.middleFrom !== 'seen') { delete row.middle; if (trail.middle) row.middle = trail.middle; }
        return row;
      }
    }
    return undefined;
  };
  const leftTurn = turn(['left-turn', 'turn']), rightTurn = turn(['right-turn', 'turn']);
  const cap = c.caps.map(found => capRow(c.set.level, found.rows.at(-1)!, null, trail.middle)).find(row => !!row) ?? undefined;
  return {
    level: c.set.level, name: c.set.name, ...(cap ? { cap } : {}), trail, ...(rightTurn ? { rightTurn } : {}), ...(leftTurn ? { leftTurn } : {}),
  };
}

const report: { level: string; candidates: Candidate[] }[] = [];
for (const level of levels) {
  const { couples, tiles } = study(level);
  const found = couples.flatMap(candidates);
  // Named in each kind by how often the map lays them: its commonest trail set is Trail 1.
  const ordered: Candidate[] = [];
  for (const kind of KIND_ORDER) {
    const own = found.filter(c => c.set.kind === kind).sort((x, y) => y.rows - x.rows);
    own.forEach((c, i) => { c.set.name = `${KIND_WORDS[kind]} ${i + 1}`; dress(c, tiles); });
    ordered.push(...own);
  }
  // The sets run on into, by name: a couple laid through both ways of turning is two sets, named together.
  const named = new Map<string, string>();
  for (const c of ordered) named.set(c.couple, named.has(c.couple) ? `${named.get(c.couple)} / ${c.set.name}` : c.set.name);
  for (const c of ordered) c.next = c.next.filter(([id]) => named.has(id)).map(([id, n]) => [named.get(id)!, n]);
  for (const c of ordered) if (c.set.kind === 'trail') c.full = fullSet(c, ordered);
  report.push({ level, candidates: ordered });

  const wide = ordered.filter(c => c.seen.length).length, capped = ordered.filter(c => c.caps.length).length;
  console.log(`\n${level}: ${ordered.length} candidate set${ordered.length === 1 ? '' : 's'} (on ${MIN_ROWS}+ rows), ${wide} seen with a middle,`
    + ` ${capped} with a cap`);
  for (const c of ordered) {
    const r = Number.isFinite(c.radius) ? `${c.radius.toFixed(0)} m` : 'straight';
    const middle = c.middleFrom === 'seen' ? `middle seen ×${c.seen[0][1]}` : c.middleFrom === 'art' ? `middle by art ${c.byArt[0].fit.toFixed(3)}` : 'no middle';
    console.log(`  ${`${c.set.level}/${c.set.name}`.padEnd(22)} ${String(c.rows).padStart(3)} rows  median ${r.padEnd(8)}`
      + ` turns L${c.left} R${c.right} straight ${c.straight}  widths ${c.widths.map(([w, n]) => `${w}×${n}`).join(' ')}  ${middle}`
      + `  seam ${c.seam?.toFixed(3) ?? '?'}  surface ${c.surfaces.map(surfaceTypeLabel).join(', ')}`);
    console.log(`    ends: ${c.caps.length ? `caps ${c.caps.map(cap => `×${cap.count}`).join(' ')}, ` : ''}bare ×${c.bareEnds}`
      + `  along: ${c.along.map(([how, n]) => `${how} ×${n}`).join(', ') || '—'}`
      + `  runs into: ${c.next.map(([name, n]) => `${name} ×${n}`).join(', ') || '—'}`);
    console.log(`    ${line(c.set)}`);
    if (c.caps[0]) console.log(`    // cap ×${c.caps[0].count}: ${capWords(c.set.level, c.caps[0])}`);
    if (c.full) console.log(`    whole set:\n${setLiteral(c.full).replace(/^/gm, '      ')}`);
  }
}

// ---- the sheet ------------------------------------------------------------------------------------------------
/** A found row as it is written in a set. */
function line(set: FoundRow): string {
  return `${ROW_KEYS[set.kind].map(key => `${key}: ${rowLiteral(rowOf(set))},`).join(' ')}  // ${set.level}/${set.name}`;
}
/** A cap in words, its rows outward, each tile from the left: its ref, which way its art's top faces, and a mirror. */
function capWords(level: string, cap: Cap): string {
  return cap.rows.map(row => row.map(s => `${tileRef(level, s.tile)} ${'↑→↓←'[s.turn]}${s.mirror ? ' mirrored' : ''}`).join(' | ')).join(' / ');
}
const picture = (ref: string, quarterTurns: number, cls = '') => {
  const [level, file] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
  const { rot } = trailTileViewOrient(quarterTurns);
  return `<img class="${cls}" src="../Maps/${esc(level)}/Textures/${esc(file)}" alt="${esc(ref)}" title="${esc(ref)}" style="transform: rotate(${-rot * 90}deg)">`;
};
const blank = '<span class="blank">no middle</span>';
/** A tile as a rider travelling out to the trail's end sees it. */
const seenPicture = (level: string, s: Seen) => {
  const ref = tileRef(level, s.tile), file = ref.slice(ref.indexOf('/') + 1);
  return `<img src="../Maps/${esc(level)}/Textures/${esc(file)}" alt="${esc(ref)}" title="${esc(`${ref} ${'↑→↓←'[s.turn]}${s.mirror ? ' mirrored' : ''}`)}"`
    + ` style="transform: rotate(${s.turn * 90}deg)${s.mirror ? ' scaleX(-1)' : ''}">`;
};
/** A cap drawn above the set's last row, the trail running up the page to its end. */
const capBlock = (level: string, cap: Cap) => `<div class="cap"><div class="blocks">${[...cap.rows].reverse().concat([cap.body])
  .map((row, i, all) => `<div class="brow${i === all.length - 1 ? ' body' : ''}">${row.map(s => seenPicture(level, s)).join('')}</div>`).join('')}</div>
  <span>×${cap.count}</span></div>`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trail tile sets</title>
<style>
  :root { color-scheme: dark; --bg: #0f151c; --panel: #16202b; --line: #2a3a4a; --text: #d7e3f0; --dim: #8fa6ba; --accent: #6ee7a8; --seen: #ffc24d; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; } p { color: var(--dim); margin: 0 0 12px; max-width: 80ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .art { display: flex; gap: 2px; justify-content: center; margin-bottom: 4px; }
  .art img { width: 96px; height: 96px; border-radius: 3px; }
  .art img.mid { outline: 2px solid var(--accent); outline-offset: -2px; }
  .art img.mid.seen { outline-color: var(--seen); }
  .blank { width: 96px; height: 96px; display: flex; align-items: center; justify-content: center; color: var(--dim);
    border: 1px dashed var(--line); border-radius: 3px; font-size: 12px; }
  .lmr { display: flex; justify-content: space-around; color: var(--dim); font-size: 11px; margin: 0 0 6px; }
  .name { font-weight: 600; } .kind { color: var(--accent); font-size: 12px; margin-left: 6px; }
  .stats { color: var(--dim); font-size: 12px; margin: 2px 0 6px; }
  .alts { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .alt { display: flex; flex-direction: column; align-items: center; font-size: 10px; color: var(--dim); }
  .alt img { width: 44px; height: 44px; border-radius: 2px; }
  .alt.seen b { color: var(--seen); }
  .label { color: var(--dim); font-size: 11px; margin-top: 4px; }
  .caps { display: flex; gap: 12px; flex-wrap: wrap; margin: 6px 0; }
  .cap { display: flex; flex-direction: column; align-items: center; font-size: 11px; color: var(--dim); }
  .blocks { display: flex; flex-direction: column; gap: 1px; }
  .brow { display: flex; gap: 1px; } .brow img { width: 52px; height: 52px; }
  .brow.body { opacity: .55; margin-top: 2px; }
  code { display: block; font-size: 11px; color: #cfe3f5; background: #0c1219; border-radius: 4px; padding: 6px; overflow-wrap: anywhere; }
  ${SET_CSS}
</style></head><body><main>
<h1>Trail tile sets</h1>
<p>Matched sets found on trail rows (the tiles one span wears rim to rim) by trail-sets.ts. Each is drawn as a rider going
downhill sees it, the path running up the page: left edge, middle, right edge. A middle outlined amber was seen between
those edges on a wider trail of the map; one outlined green is the best fit by art — its edges continuing the left tile's
right edge and the right tile's left edge, scored 0 (seamless) to 1, beside the edges' own seam. "rep" is how well a
middle meets itself, for trails four lanes or wider, and "col" how far its colour is from the edges'. A row's line is
that row of a set in TRAIL_TILE_SETS (core/mesh/trail-textures.ts). A row's caps are drawn above its last row (faded),
the trail running up the page to its end, each tile as it is laid there. A trail is drawn as a whole set too — the 4×3 a
path wears: its cap, itself, and the turn rows it runs on into most, a row it has none of faded — with the literal to
paste. Minimum ${MIN_ROWS} rows.</p>
${report.map(({ level, candidates: found }) => `<h2>${esc(level)} <span class="kind">${found.length} candidates</span></h2>
${found.length ? `<div class="grid">${found.map(c => {
    const q = c.set.quarterTurns;
    const middle = c.set.middle ? picture(c.set.middle, q, `mid${c.middleFrom === 'seen' ? ' seen' : ''}`) : blank;
    const seen = c.seen.slice(0, ART_SHOWN).map(([tile, n]) => `<div class="alt seen">${picture(tileRef(c.set.level, tile), q)}<b>×${n}</b></div>`).join('');
    const art = c.byArt.map(fit => `<div class="alt">${picture(tileRef(c.set.level, fit.tile), q)}<span>${fit.fit.toFixed(3)}</span>`
      + `<span>rep ${fit.self.toFixed(3)}</span><span>col ${fit.body.toFixed(3)}</span></div>`).join('');
    return `<div class="card">
  <div class="art">${picture(c.set.left, q)}${middle}${picture(c.set.right, q)}</div>
  <div class="lmr"><span>left</span><span>middle</span><span>right</span></div>
  <div><span class="name">${esc(`${c.set.level}/${c.set.name}`)}</span><span class="kind">${c.set.kind}</span></div>
  <div class="stats">${c.rows} rows · ${c.widths.map(([w, n]) => `${w} wide ×${n}`).join(', ')} · median ${Number.isFinite(c.radius) ? `${c.radius.toFixed(0)} m` : 'straight'}
    · turns L${c.left} R${c.right} · straight ${c.straight} · edges' seam ${c.seam?.toFixed(3) ?? '?'} · ${esc(c.surfaces.map(surfaceTypeLabel).join(', '))}</div>
  <div class="stats">ends: ${c.caps.length ? `capped ×${c.caps.reduce((n, cap) => n + cap.count, 0)}, ` : ''}bare ×${c.bareEnds}
    · along: ${esc(c.along.map(([how, n]) => `${how} ×${n}`).join(', ') || '—')}
    · runs into: ${esc(c.next.map(([name, n]) => `${name} ×${n}`).join(', ') || '—')}</div>
  ${c.caps.length ? `<div class="label">caps</div><div class="caps">${c.caps.slice(0, CAPS_SHOWN).map(cap => capBlock(c.set.level, cap)).join('')}</div>` : ''}
  ${seen ? `<div class="label">middles seen between them</div><div class="alts">${seen}</div>` : ''}
  ${art ? `<div class="label">middles by art (edge fit · repeats · colour)</div><div class="alts">${art}</div>` : ''}
  <code>${esc(line(c.set))}</code>
  ${c.full ? `<div class="label">as a whole set: its cap, itself, and the turns it runs into</div>${setHtml(c.full)}<pre>${esc(setLiteral(c.full))}</pre>` : ''}
</div>`;
  }).join('\n')}</div>` : '<p>No matched trail rows on this map.</p>'}`).join('\n')}
</main></body></html>
`;
const sheet = tempFile('trail-sets.html');
writeFileSync(sheet, html);
writeFileSync(tempFile('trail-sets.json'), JSON.stringify(report.map(({ level, candidates: found }) => ({
  level, candidates: found.map(c => ({ ...c, radius: Number.isFinite(c.radius) ? c.radius : null })),
})), null, 2));
console.log(`\nwrote ${sheet}`);

// ---- the caps sheet: each cap on its trail, two lanes wide and three ---------------------------------------------

const imageCache = new Map<string, Rgba | null>();
function imageOf(level: string, file: string): Rgba | null {
  const id = `${level}/${file}`;
  if (!imageCache.has(id)) {
    let image: Rgba | null = null;
    try { image = decodePng(readFileSync(join(MAPS_DIR, level, 'Textures', file))); } catch { /* none */ }
    imageCache.set(id, image);
  }
  return imageCache.get(id)!;
}

const seenEdgeCache = new Map<string, Float64Array | null>();
/** One edge of a tile as a rider travelling out to the end sees it, `SAMPLES` colour blocks along it — left and right
 *  top to bottom, top and bottom left to right. */
function seenEdge(level: string, s: Seen, side: 'left' | 'right' | 'top' | 'bottom'): Float64Array | null {
  const id = `${level}/${s.tile}/${s.turn}/${s.mirror}/${side}`;
  if (seenEdgeCache.has(id)) return seenEdgeCache.get(id)!;
  const image = imageOf(level, s.tile);
  let out: Float64Array | null = null;
  if (image) {
    out = new Float64Array(SAMPLES * 3);
    const n = 64;
    for (let k = 0; k < n; k++) {
      // The point on the page, 0..1 across, then back through the turn (clockwise quarters) and the mirror to the art.
      const along = (k + 0.5) / n;
      let [u, v] = side === 'left' ? [0.001, along] : side === 'right' ? [0.999, along] : side === 'top' ? [along, 0.001] : [along, 0.999];
      for (let t = 0; t < s.turn; t++) [u, v] = [v, 1 - u];
      if (s.mirror) u = 1 - u;
      const x = Math.min(image.w - 1, Math.floor(u * image.w)), y = Math.min(image.h - 1, Math.floor(v * image.h));
      const block = Math.floor((k * SAMPLES) / n), at = (y * image.w + x) * 4;
      for (let ch = 0; ch < 3; ch++) out[block * 3 + ch] += image.data[at + ch] / (255 * (n / SAMPLES));
    }
  }
  seenEdgeCache.set(id, out);
  return out;
}

/** A tile scored as the middle of a cap row: its edges against the cap's edge tiles (`fit`), its bottom against the
 *  trail's middle below it (`along`), and its colour against the cap's (`body`). */
interface CapMiddle { tile: Seen; fit: number; along: number | null; body: number; score: number }

/** Every trail tile of the map, each way round, as the middle between a cap row's left and right tiles above the
 *  trail's own middle, best first — one way round a tile. */
function capMiddles(level: string, left: Seen, right: Seen, below: Seen | null, tiles: Map<string, number>): CapMiddle[] {
  const [l, r] = [seenEdge(level, left, 'right'), seenEdge(level, right, 'left')];
  const [lm, rm] = [edgesOf(level, left.tile)?.mean, edgesOf(level, right.tile)?.mean];
  const top = below && seenEdge(level, below, 'top');
  if (!l || !r || !lm || !rm) return [];
  const out: CapMiddle[] = [];
  for (const [tile, uses] of tiles) {
    if (uses < MIN_TILE_USE || tile === left.tile || tile === right.tile) continue;
    const mean = edgesOf(level, tile)?.mean;
    if (!mean) continue;
    let best: CapMiddle | null = null;
    for (let turn = 0; turn < 4; turn++) for (const mirror of [false, true]) {
      const s = { tile, turn, mirror };
      const ml = seenEdge(level, s, 'left'), mr = seenEdge(level, s, 'right'), mb = seenEdge(level, s, 'bottom');
      if (!ml || !mr || !mb) continue;
      const fit = (apart(l, ml) + apart(mr, r)) / 2, along = top ? apart(mb, top) : null;
      const body = apart(mean, lm.map((v, ch) => (v + rm[ch]) / 2));
      const score = fit + (along ?? 0) / 2 + body;
      if (!best || score < best.score) best = { tile: s, fit, along, body, score };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => x.score - y.score).slice(0, ART_SHOWN);
}

/** One cap of a map, wherever it was found: the sets it closed, and the one it closed most; its name in the map and its
 *  number on the sheet, to choose it by. */
interface CapEntry {
  level: string; cap: Cap; count: number; sets: string[]; home: Candidate; middles: CapMiddle[]; line: string | null;
  name: string; number: number;
}

/** A cap row — two tiles and a middle, or three — as a set's cap row, where its tiles are laid at one turn, some
 *  mirrored across the trail: its turn as laid at a path's last point is the trail-tile turn whose view is that
 *  (`trailTileViewOrient` turns the other way) — for a mirrored tile, whose flip on screen turns it the other way again,
 *  the opposite. A two-tile row with no middle of its own takes `middle`, a ref, where one is given. */
function capRow(level: string, row: readonly Seen[], between: Seen | null, middle?: string): TrailTileRow | null {
  const turnOf = (s: Seen) => (s.mirror ? s.turn + 2 : 6 - s.turn) % 4;
  const [left, right, mid] = row.length === 3 ? [row[0], row[2], row[1]] : row.length === 2 ? [row[0], row[1], between] : [null, null, null];
  if (!left || !right || [left, right, ...(mid ? [mid] : [])].some(s => turnOf(s) !== turnOf(left))) return null;
  const mirrored = ([['left', left], ['middle', mid], ['right', right]] as const).flatMap(([which, s]) => s?.mirror ? [which] : []);
  return {
    left: tileRef(level, left.tile), right: tileRef(level, right.tile),
    ...(mid ? { middle: tileRef(level, mid.tile) } : middle ? { middle } : {}), ...(mirrored.length ? { mirrored } : {}),
    quarterTurns: turnOf(left),
  };
}
/** A cap row's line, as it is written in a set. */
function capLine(level: string, name: string, row: readonly Seen[], middle: Seen | null): string | null {
  const cap = capRow(level, row, middle);
  return cap && `cap: ${rowLiteral(cap)},  // ${level}/${name}`;
}

const capReport: { level: string; caps: CapEntry[] }[] = [];
for (const { level, candidates: found } of report) {
  const tiles = new Map<string, number>();
  for (const name of readdirSync(join(MAPS_DIR, level, 'Textures')).filter(f => f.endsWith('.png'))) tiles.set(name, MIN_TILE_USE);
  const bySig = new Map<string, CapEntry>();
  for (const c of found) {
    for (const cap of c.caps) {
      const sig = JSON.stringify(cap.rows);
      const entry = bySig.get(sig) ?? { level, cap, count: 0, sets: [], home: c, middles: [], line: null, name: '', number: 0 };
      entry.count += cap.count;
      entry.sets.push(`${c.set.name} ×${cap.count}`);
      if (cap.count > (entry.home.caps.find(x => JSON.stringify(x.rows) === sig)?.count ?? 0)) { entry.home = c; entry.cap = cap; }
      bySig.set(sig, entry);
    }
  }
  const caps = [...bySig.values()].sort((x, y) => y.count - x.count);
  // Named in the map by how often it is found, and numbered across the sheet, every one.
  const before = capReport.reduce((n, { caps: earlier }) => n + earlier.length, 0);
  caps.forEach((entry, i) => {
    entry.name = `Cap ${i + 1}`;
    entry.number = before + i + 1;
    const row = entry.cap.rows[0];
    const below = entry.home.set.middle ? { ...entry.cap.body[0], tile: entry.home.set.middle.slice(entry.home.set.middle.indexOf('/') + 1) } : null;
    if (entry.cap.rows.length === 1 && row.length === 2) entry.middles = capMiddles(level, row[0], row[1], below, tiles);
    const middle = entry.middles[0] && entry.middles[0].fit <= 0.08 ? entry.middles[0].tile : null;
    entry.line = capLine(level, entry.name, row, middle) ?? capLine(level, entry.name, row, null);
  });
  capReport.push({ level, caps });
  if (caps.length) {
    console.log(`\n${level} caps:`);
    for (const entry of caps) {
      console.log(`  #${entry.number} ${entry.name}  ×${entry.count} ${capWords(level, entry.cap)}  (${entry.sets.join(', ')})`
        + `${entry.line ? `\n    ${entry.line}` : '  — turned tile by tile; not one set'}`);
    }
  }
}

/** A block of rows drawn as a rider travelling out to the end sees them, the end at the top. */
const square = (level: string, rows: readonly (readonly (Seen | null)[])[], bodyRows: number) => `<div class="blocks">${rows.map((row, i) =>
  `<div class="brow${i >= rows.length - bodyRows ? ' body' : ''}">${row.map(s => s ? seenPicture(level, s) : '<span class="hole"></span>').join('')}</div>`).join('')}</div>`;
const capsHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trail caps</title>
<style>
  :root { color-scheme: dark; --bg: #0f151c; --panel: #16202b; --line: #2a3a4a; --text: #d7e3f0; --dim: #8fa6ba; --accent: #6ee7a8; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; } p { color: var(--dim); margin: 0 0 12px; max-width: 80ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .pair { display: flex; gap: 18px; align-items: flex-end; margin-bottom: 8px; }
  .title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .number { font-size: 20px; font-weight: 700; color: var(--accent); } .name { font-weight: 600; }
  .pair figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .pair figcaption { color: var(--dim); font-size: 11px; }
  .blocks { display: flex; flex-direction: column; gap: 1px; }
  .brow { display: flex; gap: 1px; } .brow img, .hole { width: 64px; height: 64px; }
  .hole { border: 1px dashed var(--line); box-sizing: border-box; }
  .brow.body { opacity: .6; }
  .stats { color: var(--dim); font-size: 12px; margin: 2px 0 6px; }
  .alts { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .alt { display: flex; flex-direction: column; align-items: center; font-size: 10px; color: var(--dim); }
  .alt img { width: 44px; height: 44px; }
  .label { color: var(--dim); font-size: 11px; margin-top: 4px; }
  code { display: block; font-size: 11px; color: #cfe3f5; background: #0c1219; border-radius: 4px; padding: 6px; overflow-wrap: anywhere; }
</style></head><body><main>
<h1>Trail caps</h1>
<p>Every cap closing a trail, found by trail-sets.ts and numbered across the page to choose by: drawn as a rider
travelling out to the trail's end sees it, the end at the top, the trail's last row below it (faded), every tile square — a cap span is as long as a lane is wide. On the
left two lanes (2×2); on the right three (2×3), the set's middle in the trail's row and the best middle by art in the
cap's — its edges running on from the cap's left and right tiles, its foot from the trail's middle. A cap laid at one
turn has its line as a set's cap row, to paste into a set in TRAIL_TILE_SETS (core/mesh/trail-textures.ts); a path
wears it with "caps" in its Textures.</p>
${capReport.filter(({ caps }) => caps.length).map(({ level, caps }) => `<h2>${esc(level)} <span class="label">${caps.length} caps</span></h2>
<div class="grid">${caps.map(entry => {
    const { cap } = entry, middle = entry.middles[0]?.tile ?? null;
    const setMiddle = entry.home.set.middle ? { ...cap.body[0], tile: entry.home.set.middle.slice(entry.home.set.middle.indexOf('/') + 1) } : null;
    const two = square(level, [...[...cap.rows].reverse(), cap.body], 1);
    const three = cap.rows.length === 1 && cap.body.length === 2
      ? square(level, [[cap.rows[0][0], middle, cap.rows[0][1]], [cap.body[0], setMiddle, cap.body[1]]], 1) : '';
    const alts = entry.middles.map(m => `<div class="alt">${seenPicture(level, m.tile)}<span>${m.fit.toFixed(3)}</span>`
      + `<span>${m.along === null ? '' : `foot ${m.along.toFixed(3)}`}</span></div>`).join('');
    return `<div class="card">
  <div class="title"><span class="number">#${entry.number}</span><span class="name">${esc(`${level}/${entry.name}`)}</span></div>
  <div class="pair"><figure>${two}<figcaption>2 lanes</figcaption></figure>${three ? `<figure>${three}<figcaption>3 lanes</figcaption></figure>` : ''}</div>
  <div class="stats">found ×${entry.count} closing ${esc(entry.sets.join(', '))}</div>
  <div class="stats">${esc(capWords(level, cap))}</div>
  ${alts ? `<div class="label">cap middles by art (edge fit · foot)</div><div class="alts">${alts}</div>` : ''}
  ${entry.line ? `<code>${esc(entry.line)}</code>` : '<div class="label">laid tile by tile — turned apart — so not one set</div>'}
</div>`;
  }).join('\n')}</div>`).join('\n')}
</main></body></html>
`;
const capSheet = tempFile('trail-caps.html');
writeFileSync(capSheet, capsHtml);
console.log(`wrote ${capSheet}`);
