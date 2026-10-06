/**
 * Find a map's matched trail tile PAIRS from its patches alone (docs/023 · Textures) — no hand-picked centreline.
 *
 * A trail lane wears one half of a tile drawn across the trail's width, so wherever two textured patches meet with the
 * RIGHT art edge of one tile on the LEFT art edge of the other, art up the same way, the picture runs on across that
 * seam: a matched pair. A trail is two patches across, so a seam is kept only when neither half is matched again
 * across its far side — a rock wall or a tiled field is matched on every side. For each seam the study reads, going
 * downhill along it: which tile is on the rider's left and which on their right, whether the art's top faces downhill
 * or uphill, and how tightly and which way it turns, from its two rims' lengths (the inner rim is the shorter).
 *
 * Seams are grouped by the two tiles that make them, each way they are laid: which is on the left, and which way up.
 * Two tiles laid mostly through tight turns are turn pairs — the way they are laid most through left turns a left-turn
 * pair, through right turns a right-turn pair (Mesa turns its stripes round for a right turn) — and any others a trail
 * pair, laid its commonest way. Ones laid mostly on rock, walls or out of bounds are left out. Each candidate is
 * printed as a `TrailTilePair` ready for `core/mesh/trail-textures.ts`; the picture is worth a look before it goes in,
 * since a ground transition can match too.
 *
 * Usage:
 *   npx tsx tools/mountain-study/trail-pairs.ts            every map
 *   npx tsx tools/mountain-study/trail-pairs.ts GARI SNOW   just these
 *   … --min 5                                              only pairs on at least 5 seams (default 3)
 *
 * Writes `temp/trail-pairs.html` — every candidate as the art, the way a rider going downhill sees it — and
 * `temp/trail-pairs.json`. The pictures are read from `Maps/<level>/Textures`, so the sheet is only for this machine.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrailTilePair } from '../../src/core/doc/types';
import { trailTileViewOrient } from '../../src/core/mesh/trail-textures';
import { buildReferenceMesh, type RawPatch } from '../../src/core/reference/terrain';
import { surfaceTypeLabel } from '../../src/core/reference/surface-types';
import { MAPS_DIR, tempFile } from './paths';

const args = process.argv.slice(2);
const minAt = args.indexOf('--min');
const MIN_SEAMS = minAt >= 0 ? Number(args[minAt + 1]) : 3;
const named = args.filter((arg, i) => !arg.startsWith('--') && (minAt < 0 || i !== minAt + 1));
const levels = named.length ? named
  : readdirSync(MAPS_DIR).filter(level => existsSync(join(MAPS_DIR, level, 'Patches.json'))).sort();

/** A seam turning tighter than this is a turn — the radius a path's turn tiles start at — and wider, straight. */
const TURN_RADIUS_M = 80;
/** Two tiles laid through turns at least this often are turn pairs. */
const TURN_SHARE = 0.6;
/** Ground no trail is laid on: out of bounds, unskiable, rock, wall, wood, metal. */
const NOT_TRAIL = new Set([0, 6, 9, 10, 12, 13]);

type V = readonly number[];
const sub = (a: V, b: V) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const key = (p: V) => p.map(x => Math.round(x * 20)).join(',');
const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
const median = (xs: readonly number[]) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };

/** One way two tiles are laid — which is on a rider's left going downhill, and whether the art's top faces downhill
 *  — and the seams laid so: how many, which way they turn, and how tightly. */
interface Laying { left: string; right: string; topDownhill: boolean; seams: number; lefts: number; rights: number; straight: number; radii: number[] }
/** Two tiles that make a picture together, every way they are laid, and the ground under them. */
interface Couple { level: string; layings: Map<string, Laying>; surfaces: Map<number, number> }

/** Every matched ribbon seam of one map, by the two tiles that make it. */
function study(level: string): Couple[] {
  const raw = JSON.parse(readFileSync(join(MAPS_DIR, level, 'Patches.json'), 'utf8')) as { Patches: RawPatch[] };
  const ref = buildReferenceMesh(raw.Patches.filter(p => p.Points?.length >= 16), undefined, 1);
  const { patchCorners: corners, patchUV: uvs, patchTex: tex, patchSurf: surf } = ref;
  // A patch's four sides as corner pairs, corners [A, B, C, D] at (0,0), (0,1), (1,0), (1,1).
  const SIDES: readonly (readonly [number, number])[] = [[0, 1], [1, 3], [3, 2], [2, 0]];
  const opposite = (side: readonly number[]) => SIDES.find(s => !s.includes(side[0]) && !s.includes(side[1]))!;
  const sideKey = (patch: number, side: readonly number[]) =>
    [key(corners[patch][side[0]]), key(corners[patch][side[1]])].sort().join('|');

  const bySide = new Map<string, { patch: number; side: readonly [number, number] }[]>();
  corners.forEach((_, patch) => {
    if (!tex[patch] || !uvs[patch]) return;
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
  const seams: { a: Half; b: Half; top: number }[] = [];
  const matched = new Set<string>();
  for (const list of bySide.values()) {
    if (list.length !== 2 || tex[list[0].patch] === tex[list[1].patch]) continue;
    const [a, b] = list;
    const ea = artEdge(a.patch, a.side), eb = artEdge(b.patch, b.side);
    if (!ea || !eb || ea.right === eb.right) continue;
    if (key(corners[a.patch][ea.top]) !== key(corners[b.patch][eb.top])) continue;
    // `a` is the picture's left half, its right edge on the seam.
    seams.push(ea.right ? { a, b, top: ea.top } : { a: b, b: a, top: eb.top });
    matched.add(sideKey(a.patch, a.side));
  }

  const couples = new Map<string, Couple>();
  for (const { a, b, top } of seams) {
    if (matched.has(sideKey(a.patch, opposite(a.side))) || matched.has(sideKey(b.patch, opposite(b.side)))) continue;
    const c = corners[a.patch];
    const [p, q] = [c[a.side[0]], c[a.side[1]]];
    const [high, low] = p[1] >= q[1] ? [p, q] : [q, p];
    const flow = sub(low, high), run = Math.hypot(flow[0], flow[2]);
    if (run < 1e-6) continue;
    // Data space is the game's left-handed frame: facing `flow`, a rider's left is (−fz, 0, fx).
    const leftward = [-flow[2] / run, 0, flow[0] / run];
    const mid = [(high[0] + low[0]) / 2, (high[1] + low[1]) / 2, (high[2] + low[2]) / 2];
    const centre = (patch: number) => [0, 1, 2].map(k => corners[patch].reduce((s, v) => s + v[k], 0) / 4);
    const aOnLeft = (() => { const d = sub(centre(a.patch), mid); return d[0] * leftward[0] + d[2] * leftward[2] > 0; })();
    // Going downhill, the art's top faces downhill when the picture reads as found — its left half on the left.
    const topDownhill = key(c[top]) === key(low);
    const riderLeft = aOnLeft ? a : b, riderRight = aOnLeft ? b : a;
    // The turn, from the rims: each half's side across from the seam.
    const rim = (half: Half) => { const s = opposite(half.side), k = corners[half.patch]; return { len: dist(k[s[0]], k[s[1]]), at: [0, 1, 2].map(i => (k[s[0]][i] + k[s[1]][i]) / 2) }; };
    const l = rim(riderLeft), r = rim(riderRight);
    const theta = (r.len - l.len) / Math.max(dist(l.at, r.at), 1e-6); // > 0: the right rim is longer, turning left
    const radius = Math.abs(theta) > 1e-4 ? dist(high, low) / Math.abs(theta) : Infinity;
    const left = tex[riderLeft.patch]!, right = tex[riderRight.patch]!;
    const id = [left, right].sort().join('|');
    const couple = couples.get(id) ?? { level, layings: new Map<string, Laying>(), surfaces: new Map<number, number>() };
    const how = `${left}|${right}|${topDownhill}`;
    const lay = couple.layings.get(how) ?? { left, right, topDownhill, seams: 0, lefts: 0, rights: 0, straight: 0, radii: [] };
    lay.seams++; lay.radii.push(radius);
    if (radius > TURN_RADIUS_M) lay.straight++; else if (theta > 0) lay.lefts++; else lay.rights++;
    couple.layings.set(how, lay);
    for (const patch of [a.patch, b.patch]) couple.surfaces.set(surf[patch], (couple.surfaces.get(surf[patch]) ?? 0) + 1);
    couples.set(id, couple);
  }
  const seamsOf = (couple: Couple) => [...couple.layings.values()].reduce((n, lay) => n + lay.seams, 0);
  return [...couples.values()].filter(couple => {
    const halves = [...couple.surfaces.values()].reduce((n, k) => n + k, 0);
    const offTrail = [...couple.surfaces].reduce((n, [type, k]) => n + (NOT_TRAIL.has(type) ? k : 0), 0);
    return seamsOf(couple) >= MIN_SEAMS && offTrail * 2 < halves;
  });
}

/** A candidate pair for `trail-textures.ts`, and the evidence for it. */
interface Candidate {
  pair: TrailTilePair;
  /** Seams of the tiles together — or, for a turn pair, laid its way — and how they turn. */
  seams: number; left: number; right: number; straight: number; radius: number;
  /** Of them, laid exactly as the pair is. */
  laid: number;
  surfaces: number[];
}

const tileRef = (level: string, file: string) => (file.includes('/') ? file : `${level}/${file}`);

/** Two tiles as the pairs they make: a trail pair laid their commonest way, or a turn pair for each way of turning
 *  they are laid through. */
function candidates(couple: Couple): Candidate[] {
  const layings = [...couple.layings.values()];
  const sum = (pick: (lay: Laying) => number) => layings.reduce((n, lay) => n + pick(lay), 0);
  const seams = sum(lay => lay.seams), lefts = sum(lay => lay.lefts), rights = sum(lay => lay.rights);
  const surfaces = [...couple.surfaces.keys()].sort((x, y) => x - y);
  // Laid with its top downhill a half is upright to a rider: a trail tile's own half turn plus two
  // (`trailTileViewOrient`); with its top uphill, as the trail tile's own turn.
  const pair = (lay: Laying, kind: TrailTilePair['kind']): TrailTilePair => ({
    level: couple.level, name: '', kind, left: tileRef(couple.level, lay.left), right: tileRef(couple.level, lay.right),
    quarterTurns: lay.topDownhill ? 2 : 0,
  });
  const rotated = (lay: Laying) => `${lay.right}|${lay.left}|${!lay.topDownhill}`;
  const evidence = (lay: Laying, n: { seams: number; lefts: number; rights: number; straight: number; radii: number[] }) =>
    ({ seams: n.seams, left: n.lefts, right: n.rights, straight: n.straight, radius: median(n.radii), surfaces, laid: lay.seams });
  if ((lefts + rights) / seams < TURN_SHARE) {
    const commonest = layings.reduce((best, lay) => lay.seams > best.seams ? lay : best);
    return [{ pair: pair(commonest, 'trail'), ...evidence(commonest, { seams, lefts, rights, straight: sum(lay => lay.straight), radii: layings.flatMap(lay => lay.radii) }) }];
  }
  // Each way of turning: the laying used most for it — on a tie, the other way's laying turned round, as Mesa's are.
  const best = (count: (lay: Laying) => number, partner?: Laying) => layings.reduce((top, lay) =>
    count(lay) > count(top) || (count(lay) === count(top) && partner && `${lay.left}|${lay.right}|${lay.topDownhill}` === rotated(partner)) ? lay : top);
  // A way of turning seen on fewer than two seams is not one the map marks.
  const forLeft = lefts ? best(lay => lay.lefts) : null;
  const forRight = rights ? best(lay => lay.rights, forLeft ?? undefined) : null;
  const leftOk = !!forLeft && forLeft.lefts >= 2, rightOk = !!forRight && forRight.rights >= 2;
  if (leftOk && rightOk && forLeft === forRight) return [{ pair: pair(forLeft!, 'turn'), ...evidence(forLeft!, forLeft!) }];
  const out: Candidate[] = [];
  if (leftOk) out.push({ pair: pair(forLeft!, 'left-turn'), ...evidence(forLeft!, forLeft!) });
  if (rightOk) out.push({ pair: pair(forRight!, 'right-turn'), ...evidence(forRight!, forRight!) });
  return out;
}

const KIND_WORDS: Record<TrailTilePair['kind'], string> = { trail: 'Trail', 'left-turn': 'Left Turn', 'right-turn': 'Right Turn', turn: 'Turn' };
const KIND_ORDER: TrailTilePair['kind'][] = ['trail', 'left-turn', 'right-turn', 'turn'];

const report: { level: string; candidates: Candidate[] }[] = [];
for (const level of levels) {
  const found = study(level).flatMap(candidates);
  // Named in each kind by how often the map lays them: its commonest trail pair is Trail 1.
  const ordered: Candidate[] = [];
  for (const kind of KIND_ORDER) {
    const own = found.filter(c => c.pair.kind === kind).sort((x, y) => y.seams - x.seams);
    own.forEach((c, i) => { c.pair.name = `${KIND_WORDS[kind]} ${i + 1}`; });
    ordered.push(...own);
  }
  report.push({ level, candidates: ordered });

  console.log(`\n${level}: ${ordered.length} candidate pair${ordered.length === 1 ? '' : 's'} (on ${MIN_SEAMS}+ ribbon seams)`);
  for (const c of ordered) {
    const r = Number.isFinite(c.radius) ? `${c.radius.toFixed(0)} m` : 'straight';
    console.log(`  ${`${c.pair.level}/${c.pair.name}`.padEnd(22)} ${String(c.seams).padStart(3)} seams  median ${r.padEnd(8)}`
      + ` turns L${c.left} R${c.right} straight ${c.straight}  surface ${c.surfaces.map(surfaceTypeLabel).join(', ')}`);
    console.log(`    ${JSON.stringify(c.pair).replace(/"(\w+)":/g, '$1: ').replace(/"/g, '\'').replace(/,/g, ', ').replace(/\{/, '{ ').replace(/\}$/, ' },')}`);
  }
}

// ---- the sheet ------------------------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const picture = (ref: string, quarterTurns: number) => {
  const [level, file] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
  const { rot } = trailTileViewOrient(quarterTurns);
  return `<img src="../Maps/${esc(level)}/Textures/${esc(file)}" alt="${esc(ref)}" title="${esc(ref)}" style="transform: rotate(${-rot * 90}deg)">`;
};
const line = (pair: TrailTilePair) => `{ level: '${pair.level}', name: '${pair.name}', kind: '${pair.kind}', left: '${pair.left}', `
  + `right: '${pair.right}', quarterTurns: ${pair.quarterTurns} },`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trail tile pairs</title>
<style>
  :root { color-scheme: dark; --bg: #0f151c; --panel: #16202b; --line: #2a3a4a; --text: #d7e3f0; --dim: #8fa6ba; --accent: #6ee7a8; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; } p { color: var(--dim); margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .art { display: flex; gap: 2px; justify-content: center; margin-bottom: 8px; }
  .art img { width: 96px; height: 96px; image-rendering: auto; border-radius: 3px; }
  .name { font-weight: 600; } .kind { color: var(--accent); font-size: 12px; margin-left: 6px; }
  .stats { color: var(--dim); font-size: 12px; margin: 2px 0 6px; }
  code { display: block; font-size: 11px; color: #cfe3f5; background: #0c1219; border-radius: 4px; padding: 6px; overflow-wrap: anywhere; }
  .lr { display: flex; justify-content: space-between; color: var(--dim); font-size: 11px; padding: 0 30px; margin: -4px 0 6px; }
</style></head><body><main>
<h1>Trail tile pairs</h1>
<p>Matched pairs found on two-patch trail ribbons, by trail-pairs.ts. Each is drawn as a rider going downhill sees it,
the path running up the page: left lane on the left. Paste a line into TRAIL_TILE_PAIRS in core/mesh/trail-textures.ts.
Minimum ${MIN_SEAMS} seams.</p>
${report.map(({ level, candidates: found }) => `<h2>${esc(level)} <span class="kind">${found.length} candidates</span></h2>
${found.length ? `<div class="grid">${found.map(c => `<div class="card">
  <div class="art">${picture(c.pair.left, c.pair.quarterTurns)}${picture(c.pair.right, c.pair.quarterTurns)}</div>
  <div class="lr"><span>left</span><span>right</span></div>
  <div><span class="name">${esc(`${c.pair.level}/${c.pair.name}`)}</span><span class="kind">${c.pair.kind}</span></div>
  <div class="stats">${c.seams} seams · median ${Number.isFinite(c.radius) ? `${c.radius.toFixed(0)} m` : 'straight'} · turns L${c.left} R${c.right}
    · straight ${c.straight} · ${esc(c.surfaces.map(surfaceTypeLabel).join(', '))}</div>
  <code>${esc(line(c.pair))}</code>
</div>`).join('\n')}</div>` : '<p>No two-patch matched ribbons on this map.</p>'}`).join('\n')}
</main></body></html>
`;
const sheet = tempFile('trail-pairs.html');
writeFileSync(sheet, html);
writeFileSync(tempFile('trail-pairs.json'), JSON.stringify(report.map(({ level, candidates: found }) => ({
  level, candidates: found.map(c => ({ ...c, radius: Number.isFinite(c.radius) ? c.radius : null })),
})), null, 2));
console.log(`\nwrote ${sheet}`);
