// tier: fast

/** Owned trails (docs/023): a network of splines that keeps the patches it cut. Run: `npx tsx test/trail-object.test.ts` */
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { nameIndex, nextTrailId } from '../src/core/doc/ids';
import type { AuthoredTrail, QuadMeshDoc, TrailTileSet, V3 } from '../src/core/doc/types';
import { quadIsLocked } from '../src/core/mesh/locks';
import { meshFromDoc } from '../src/core/mesh/topology';
import { migrateLegacyTrail, normalizeTrails } from '../src/core/doc/trails';
import {
  connectedPaths, cutTrail, disconnectPoint, fusePathsAt, joinTrails, junctionPoints, mergeTrailPoints, pointArms, removeTrailPatches,
  resolveTrail, reversePath, separateTrail, setTrailKnotValue, splitPathsAt, trailIsConnected, trailOwningQuad, trailPathQuads, trailPathStations,
  trailInterior, trailPreview, trailRunList, TRAIL_SETTINGS_DEFAULTS, withoutTrailPaths, withoutTrailPoint,
} from '../src/core/mesh/trail-object';
import { checkManifold } from '../src/core/mesh/ops';
import { trimTrailSpline, type TrailCubic } from '../src/core/mesh/trail';
import {
  DEFAULT_TRAIL_TILES, findTrailTileSet, nextTrailTileSetName, TRAIL_TILE_ROWS, TRAIL_TILE_SETS, trailSettingsTiles, trailTileRowTiles,
  trailTileRowView, trailTileSetFits, trailTileSetId, trailTileSetLiteral, trailTileSetRow, trailTileSetsWith, trailTiling,
  withTrailTileRowView,
} from '../src/core/mesh/trail-textures';
import { check, failures } from './check';

const emptyDoc = (): QuadMeshDoc => ({
  kind: 'mountain', version: 5, name: 'TRAIL OBJECT TEST', spacing: 30,
  course: { knots: [], blend: 30, surface: 1 }, baseSurface: 1,
  vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0,
});

type Settings = AuthoredTrail['paths'][number]['settings'];

/** A trail of one path through `knots` in order. */
const trailOf = (knots: V3[], settings: Partial<Settings> = {}): AuthoredTrail => ({
  id: 'trail:0000', points: knots, paths: [{ points: knots.map((_, i) => i), settings: { ...TRAIL_SETTINGS_DEFAULTS, ...settings } }],
  vertices: [], quads: [],
});

/** A set of the test mountain's own, laid as Mesa's built-in set once was — its groomed pair and a middle, its blue
 *  stripes turned round through right turns, its rounded end mirrored — so the turn, cap and fork checks wearing it
 *  hold whatever the built-in sets are. */
const MESA_TEST: TrailTileSet = {
  level: 'MESA', name: 'Test',
  cap: { left: 'MESA/0041.png', middle: 'MESA/0061.png', right: 'MESA/0043.png', mirrored: ['left', 'right'], quarterTurns: 2 },
  trail: { left: 'MESA/0046.png', middle: 'MESA/0061.png', right: 'MESA/0047.png', quarterTurns: 2 },
  rightTurn: { left: 'MESA/0066.png', middle: 'MESA/0061.png', right: 'MESA/0064.png', quarterTurns: 0 },
  leftTurn: { left: 'MESA/0064.png', middle: 'MESA/0061.png', right: 'MESA/0066.png', quarterTurns: 2 },
};
const mesaDoc = (): QuadMeshDoc => ({ ...emptyDoc(), trailTileSets: [MESA_TEST] });
const MESA_TILES = { trailTiles: 'MESA/Test' } as const;
/** The trail with every path wearing the test set. */
const inMesa = (trail: AuthoredTrail): AuthoredTrail =>
  ({ ...trail, paths: trail.paths.map(path => ({ ...path, settings: { ...path.settings, ...MESA_TILES } })) });

/** A one-path trail with its knots moved: new points, the path through all of them in order. */
const withKnots = (trail: AuthoredTrail, knots: V3[]): AuthoredTrail =>
  ({ ...trail, points: knots, paths: [{ ...trail.paths[0], points: knots.map((_, i) => i) }] });

/** The trail with one more path, through points already there (by place) and new ones (by position). */
function withPathThrough(trail: AuthoredTrail, through: (number | V3)[], settings: Partial<Settings> = {}): AuthoredTrail {
  const points = [...trail.points];
  const path = through.map(entry => typeof entry === 'number' ? entry : points.push(entry) - 1);
  return { ...trail, points, paths: [...trail.paths, { points: path, settings: { ...TRAIL_SETTINGS_DEFAULTS, ...settings } }] };
}

/** The valence of a vertex: how many of the document's patches use it. */
const valence = (doc: QuadMeshDoc, vertex: number) => doc.quads.filter(quad => quad.includes(vertex)).length;

const at = (doc: QuadMeshDoc, id: string): V3 => {
  const v = nameIndex(doc.vertexIds).get(id)!;
  return [doc.vertices[v * 3], doc.vertices[v * 3 + 1], doc.vertices[v * 3 + 2]];
};
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Every handle on a trail's edges, keyed by the edge's stable end ids, so two cuts can be compared by name. */
function trailHandles(doc: QuadMeshDoc, trail: AuthoredTrail): Map<string, V3> {
  const { edgeHandle } = meshFromDoc(doc);
  const owned = resolveTrail(doc, trail)!;
  const out = new Map<string, V3>();
  for (const quad of owned.quads) {
    const [a, b, c, d] = doc.quads[quad];
    for (const [from, to] of [[a, b], [b, d], [d, c], [c, a], [b, a], [d, b], [c, d], [a, c]])
      out.set(`${doc.vertexIds[from]}>${doc.vertexIds[to]}`, edgeHandle(from, to));
  }
  return out;
}

// ---- a new trail cuts a locked ribbon and remembers it ------------------------------------------------------------
const straight = trailOf([[0, 0, 0], [0, 0, 100]]);
const created = cutTrail(emptyDoc(), straight);
check(created.ok, 'create: a two-knot trail cuts');
if (!created.ok) process.exit(1);
{
  const { doc, trail } = created;
  check(trail.quads.length === 10 && trail.vertices.length === 18, 'create: 100 m is five spans — ten patches, eighteen vertices',
    `${trail.quads.length} / ${trail.vertices.length}`);
  const owned = resolveTrail(doc, trail);
  check(!!owned && owned.quads.every(quad => quadIsLocked(doc, quad)), 'create: every owned patch is locked');
  check(!!owned && !trailIsConnected(doc, owned), 'create: a fresh ribbon shares nothing');
  check(trailOwningQuad(doc, [trail], owned!.quads[3])?.id === trail.id, 'create: a patch finds the trail that owns it');
  check(dist(at(doc, trail.vertices[1]), [0, 0, 0]) < 1e-9 && dist(at(doc, trail.vertices[16]), [0, 0, 100]) < 1e-9,
    'create: the centre seam runs from the first knot to the last');
  // A span's first patch is a rider's right.
  check(doc.quadTex?.[owned!.quads[0]] === findTrailTileSet(DEFAULT_TRAIL_TILES.trailTiles, [])!.trail.right,
    'create: the default set’s tiles are laid');
  // Inside: the centre seam and the four inner station lines, and the centre of each inner station — not the rims,
  // and not the two end stations, whose station lines are the ribbon's open ends.
  const inside = trailInterior({ ...doc, trails: [trail] });
  const centres = [1, 2, 3, 4].map(station => owned!.vertices[station * 3 + 1]);
  check(inside.edges.size === 5 + 2 * 4 && inside.vertices.size === 4 && centres.every(vertex => inside.vertices.has(vertex)),
    'create: the inside is the seam, the inner station lines and their centres', `${inside.edges.size} / ${inside.vertices.size}`);
}

// ---- moving a knot without changing the span count re-cuts in place ------------------------------------------------
{
  const moved = cutTrail(created.doc, withKnots(created.trail, [[0, 0, 0], [20, 5, 100]]));
  check(moved.ok, 'move: the bent trail cuts');
  if (moved.ok) {
    check(moved.trail.quads.join() === created.trail.quads.join() && moved.trail.vertices.join() === created.trail.vertices.join(),
      'move: the same vertices and patches carry the new shape');
    check(moved.doc.nextId === created.doc.nextId && !moved.doc.tombstones?.length, 'move: nothing minted, nothing retired');
    check(dist(at(moved.doc, moved.trail.vertices[16]), [20, 5, 100]) < 1e-9, 'move: the last station follows the knot');
    // Re-cut in place must be the same surface as cutting the moved spline fresh: no stale handle survives.
    const fresh = cutTrail(emptyDoc(), withKnots(straight, [[0, 0, 0], [20, 5, 100]]));
    if (fresh.ok) {
      const a = trailHandles(moved.doc, moved.trail), b = trailHandles(fresh.doc, fresh.trail);
      const rename = new Map(fresh.trail.vertices.map((id, i) => [id, moved.trail.vertices[i]]));
      let worst = 0;
      for (const [key, offset] of b) {
        const [from, to] = key.split('>');
        const mine = a.get(`${rename.get(from)}>${rename.get(to)}`);
        worst = Math.max(worst, mine ? dist(mine, offset) : Infinity);
      }
      check(worst < 1e-9, 'move: every handle matches a fresh cut of the same spline', `${worst}`);
    }
  }
}

// ---- an unjoined trail changes length freely, keeping the stations both cuts share ---------------------------------
{
  const longer = cutTrail(created.doc, withKnots(created.trail, [[0, 0, 0], [0, 0, 100], [0, 0, 200]]));
  check(longer.ok && longer.trail.quads.length > created.trail.quads.length, 'grow: a longer trail adds spans');
  if (longer.ok) {
    check(created.trail.quads.every((id, i) => longer.trail.quads[i] === id), 'grow: the shared spans keep their patch ids');
    check(!!resolveTrail(longer.doc, longer.trail), 'grow: the ribbon still resolves');
    check(longer.trail.quads.every(id => quadIsLocked(longer.doc, nameIndex(longer.doc.quadIds).get(id)!)),
      'grow: the added patches are locked too');
    const shorter = cutTrail(longer.doc, withKnots(longer.trail, [[0, 0, 0], [0, 0, 40]]));
    check(shorter.ok && shorter.trail.quads.length < created.trail.quads.length, 'shrink: a shorter trail drops spans');
    if (shorter.ok) {
      const gone = longer.trail.quads.filter(id => !shorter.trail.quads.includes(id));
      check(gone.length > 0 && gone.every(id => shorter.doc.tombstones?.includes(id)), 'shrink: the dropped patches are retired');
      check(shorter.doc.quads.length === shorter.trail.quads.length, 'shrink: nothing but the ribbon is left');
    }
  }
}

// ---- a joined trail keeps its patch count and stretches what is joined to it -------------------------------------
{
  // A host patch welded onto the left rim of the first span: it shares two of the trail's vertices.
  const { doc, trail } = created;
  const owned = resolveTrail(doc, trail)!;
  const [l0, , , l1] = [owned.vertices[0], owned.vertices[1], owned.vertices[2], owned.vertices[3]];
  const host: QuadMeshDoc = {
    ...doc,
    vertices: [...doc.vertices, -20, 0, 0, -20, 0, 20],
    vertexIds: [...doc.vertexIds, 'host-a', 'host-b'],
    quads: [...doc.quads, [doc.vertices.length / 3, l0, doc.vertices.length / 3 + 1, l1]],
    quadIds: [...doc.quadIds, 'host-quad'],
  };
  check(trailIsConnected(host, owned), 'joined: a patch sharing rim vertices joins the trail');
  const inside = trailInterior({ ...host, trails: [trail] });
  check(inside.edges.size === 13 && inside.vertices.size === 4 && !inside.vertices.has(l0) && !inside.vertices.has(l1),
    'joined: the rim a patch is welded to stays outside the trail');
  const bent = cutTrail(host, withKnots(trail, [[0, 0, 0], [0, 0, 60], [30, 0, 160]]));
  check(bent.ok, 'joined: a longer spline still cuts');
  if (bent.ok) {
    check(bent.connected && bent.trail.quads.join() === trail.quads.join(), 'joined: the span count and every id hold');
    const hostCorners = bent.doc.quads[nameIndex(bent.doc.quadIds).get('host-quad')!];
    check(hostCorners[1] === l0 && hostCorners[3] === l1, 'joined: the host patch still names the rim vertices');
    check(dist(at(bent.doc, trail.vertices[3]), at(doc, trail.vertices[3])) > 1, 'joined: the shared rim vertex moved, stretching the host');
  }
  const crowded = cutTrail(host, withKnots(trail, Array.from({ length: 7 }, (_, i) => [0, 0, i * 15] as V3)));
  check(!crowded.ok, 'joined: more knot segments than spans is refused');
  const forked = cutTrail(host, withPathThrough(trail, [1, [60, 0, 160]]));
  check(!forked.ok && /layout is held/.test(forked.error), 'joined: it cannot gain a path', forked.ok ? '' : forked.error);
}

// ---- dressing, removal, and a broken ribbon ----------------------------------------------------------------------
{
  const { doc, trail } = created;
  const owned = resolveTrail(doc, trail)!;
  const painted = { ...doc, quadTex: { ...doc.quadTex, [owned.quads[1]]: 'Custom/hand.png' } };
  const plain = cutTrail(painted, { ...trail, paths: [{ ...trail.paths[0], settings: { ...trail.paths[0].settings, trailTiles: null } }] });
  check(plain.ok && plain.doc.quadTex?.[owned.quads[0]] === undefined && plain.doc.quadTex?.[owned.quads[1]] === 'Custom/hand.png',
    'tiles off: the preset tiles come off, a hand-painted one stays');

  const removed = removeTrailPatches(doc, trail);
  check(removed.quads.length === 0 && removed.vertices.length === 0, 'remove: the ribbon and its vertices go');

  const cut = { ...doc, quads: doc.quads.slice(0, -1), quadIds: doc.quadIds.slice(0, -1) };
  check(resolveTrail(cut, trail) === null, 'broken: a ribbon missing a patch does not resolve');
  const refused = cutTrail(cut, trail);
  check(!refused.ok, 'broken: a trail that lost patches will not re-cut');
}

// ---- the Mesa tiles: a set's turn rows through its tight turns, each worn at its own turn ------------------------
{
  const mesa = MESA_TEST;
  const arc = trailOf([0, 30, 60, 90, 120, 150].map(deg => [60 * Math.cos(deg * Math.PI / 180), 0, 60 * Math.sin(deg * Math.PI / 180)] as V3), MESA_TILES);
  const cut = cutTrail(mesaDoc(), withKnots(arc, [[0, 0, -120], ...arc.points]));
  const tight = new Set([mesa.leftTurn!.left, mesa.leftTurn!.right]);
  const tiles = cut.ok ? resolveTrail(cut.doc, cut.trail)!.quads.map(quad => ({ tile: cut.doc.quadTex?.[quad], orient: cut.doc.quadOrient?.[quad] })) : [];
  check(tiles.some(t => tight.has(t.tile!)) && tiles.some(t => t.tile && !tight.has(t.tile)),
    'tiles: a straight run into a tight arc wears the trail row and the left-turn row', tiles.map(t => t.tile).join());
  // Mesa's trail and left-turn rows are worn half a turn beyond a trail tile's own — three quarters — and its right-turn
  // row, the same stripes turned round, as a trail tile's own: a quarter, where the run bends right into the arc.
  const bends = cut.ok ? cut.layout.spans.map(span => span.signedCurvature) : [];
  check(tiles.every((t, i) => t.orient?.rot === (tight.has(t.tile!) && bends[i >> 1] < 0 ? 1 : 3) && !t.orient.mirror)
    && tiles.some(t => tight.has(t.tile!) && t.orient?.rot === 3),
  'tiles: Mesa’s trail and left-turn rows turn three quarters, its right-turn row one', tiles.map(t => t.orient?.rot).join());

  // An S-bend wears the left-turn row through its left turns and the right-turn row through its right: Mesa's stripes
  // turned round, a quarter turn where the left turn's are three.
  const bend = trailOf([[0, 0, 0], [0, 0, 60], [-40, 0, 100], [-40, 0, 160], [0, 0, 200], [0, 0, 260]], MESA_TILES);
  const bent = cutTrail(mesaDoc(), bend);
  const worn = bent.ok ? bent.layout.spans.map(span => ({ k: span.signedCurvature, tile: span.textures?.[0], rot: span.textureOrient?.rot })) : [];
  // A span's first patch is a rider's right.
  const [left, right] = [mesa.leftTurn!.right, mesa.rightTurn!.right];
  check(worn.some(s => s.tile === left) && worn.some(s => s.tile === right)
    && worn.every(s => s.tile !== left || (s.k > 0 && s.rot === 3)) && worn.every(s => s.tile !== right || (s.k < 0 && s.rot === 1)),
  'tiles: an S-bend wears the left-turn row through its left turns, the right-turn row through its right', JSON.stringify(worn));
}

// ---- tile sets (docs/023 · Textures): one set's rows, the mountain's own among them ----------------------------------
{
  const own: TrailTileSet[] = [{ level: 'A', name: 'Trail 1', trail: { left: 'A/1.png', right: 'A/2.png', quarterTurns: 1 } }];
  const pathOf = (trailTiles: string | null) => trailOf([[0, 0, 0], [0, 0, 100]], { trailTiles });
  const cut = cutTrail({ ...emptyDoc(), trailTileSets: own }, pathOf('A/Trail 1'));
  if (cut.ok) {
    const owned = resolveTrail(cut.doc, cut.trail)!;
    const tiles = owned.quads.map(quad => cut.doc.quadTex?.[quad] ?? '');
    // A span's first patch is the generator's left lane: a rider's right, going along the path.
    check(tiles.join() === Array.from({ length: 5 }, () => 'A/2.png,A/1.png').join(),
      'pairs: every span wears the one pair, the right half on its first patch — no pair after pair', tiles.join());
    check(owned.quads.every(quad => cut.doc.quadOrient?.[quad]?.rot === 2), 'pairs: worn the pair’s own quarter turn beyond a trail tile’s');
    // Taken off, the pair's tiles go — and a tile painted by hand stays.
    const before = { ...cut.doc, quadTex: { ...cut.doc.quadTex, [owned.quads[3]]: 'Custom/hand.png' } };
    const plain = cutTrail(before, { ...cut.trail, paths: [{ ...cut.trail.paths[0], settings: { ...cut.trail.paths[0].settings, trailTiles: null } }] });
    check(plain.ok && owned.quads.every((quad, i) => (plain.doc.quadTex?.[quad] ?? '') === (i === 3 ? 'Custom/hand.png' : '')),
      'pairs: taken off, every tile a pair lays comes off and a hand-painted one stays');
  } else check(false, 'pairs: a path wearing the mountain’s own pair cuts', cut.error);
  const missing = cutTrail(emptyDoc(), pathOf('A/Trail 1'));
  check(missing.ok && resolveTrail(missing.doc, missing.trail)!.quads.every(quad => !missing.doc.quadTex?.[quad]),
    'pairs: a pair the mountain does not have lays nothing');
  check(nextTrailTileSetName('MESA', []) === 'Trail 6' && nextTrailTileSetName('A', own) === 'Trail 2',
    'sets: a new set is named next among its map’s, past the names retired');

  // A cap or turn row a set has none of is its trail row; one with no middle wears the trail row's.
  const rows: TrailTileSet = {
    level: 'A', name: 'Trail 3', trail: { left: 'A/1.png', middle: 'A/m.png', right: 'A/2.png', mirrored: ['middle'], quarterTurns: 2 },
    leftTurn: { left: 'A/3.png', right: 'A/4.png', quarterTurns: 0 },
  };
  const turn = trailTileSetRow(rows, 'leftTurn'), cap = trailTileSetRow(rows, 'cap');
  check(!turn.borrowed && turn.row.middle === 'A/m.png' && turn.row.mirrored?.join() === 'middle' && turn.row.left === 'A/3.png'
    && cap.borrowed && cap.row === rows.trail, 'sets: a row it has none of is its trail row, a middle it has none of the trail row’s');
  const tiling = trailTiling({ ...TRAIL_SETTINGS_DEFAULTS, trailTiles: 'A/Trail 3' }, [rows]);
  check(tiling?.leftTurn?.middle === 'A/m.png' && tiling.rightTurn === null && tiling.cap === null && tiling.trail?.left === 'A/1.png',
    'sets: the generator is given its rows, none where it has none', JSON.stringify(tiling));

  // A path saved before tile sets has only `mesaTextures`: read as it always was, and brought forward on load. One
  // saved while turns and caps wore sets of their own wears its trail's set, whose rows they are now.
  const { trailTiles: _t, turnRadiusM: _r, ...older } = TRAIL_SETTINGS_DEFAULTS;
  const saved = (mesaTextures?: boolean) => ({ ...straight, paths: [{ ...straight.paths[0],
    settings: { ...older, ...(mesaTextures === undefined ? {} : { mesaTextures }) } as typeof straight.paths[0]['settings'] }] });
  const read = (mesaTextures?: boolean) => trailSettingsTiles(saved(mesaTextures).paths[0].settings);
  check(read(false).trailTiles === null && read(true).trailTiles === 'MESA/Preset 1'
    && read().trailTiles === 'MESA/Preset 1', 'legacy tiles: Mesa’s set on or unsaid, plain off');
  const slots = { ...older, trailTiles: 'MESA/Trail 2', leftTurnTiles: 'MESA/Left Turn 2', rightTurnTiles: null, capTiles: 'MESA/Cap 1',
    turnRadiusM: 60 } as unknown as Settings;
  check(trailSettingsTiles(slots).trailTiles === 'MESA/Trail 2' && findTrailTileSet('MESA/Trail 2', []) === findTrailTileSet('MESA/Trail 1', []),
    'legacy tiles: a built-in set no longer given out is worn as the one it became');
  const [off, on, sloted] = normalizeTrails([saved(false), saved(true), { ...straight, paths: [{ ...straight.paths[0], settings: slots }] }])!;
  check(off.paths[0].settings.trailTiles === null && !('mesaTextures' in off.paths[0].settings)
    && on.paths[0].settings.trailTiles === 'MESA/Preset 1' && on.paths[0].settings.turnRadiusM === 80,
  'legacy tiles: loading names the set each path wears');
  check(sloted.paths[0].settings.trailTiles === 'MESA/Trail 2' && sloted.paths[0].settings.turnRadiusM === 60
    && !['leftTurnTiles', 'rightTurnTiles', 'capTiles'].some(key => key in sloted.paths[0].settings),
  'legacy tiles: a path saved with turn and cap sets loads wearing its trail’s set alone');
}

// ---- a fork: a second path off a middle point, and a six-patch junction round a six-way hub (docs/023 · Networks) ---
{
  const main = trailOf([[0, 0, 0], [0, 0, 120], [0, 0, 240]]);
  const fork = withPathThrough(main, [1, [100, 0, 180], [180, 0, 220]]);
  check(pointArms(fork).join() === '1,3,1,2,1' && [...junctionPoints(fork)].join() === '1',
    'fork: three arms meet at the shared point, which carries the junction');
  check(trailRunList(fork).map(run => `${run.path}:${run.first}-${run.last}`).join() === '0:0-1,0:1-2,1:0-2',
    'fork: the first path splits at the junction, the second runs whole');
  const cut = cutTrail(emptyDoc(), fork);
  check(cut.ok, 'fork: a trail with two paths cuts', cut.ok ? '' : cut.error);
  if (!cut.ok) process.exit(1);
  const { doc, trail } = cut;
  check(trail.network?.junctionArms.join() === '3' && trail.network.runSpans.length === 3 && trail.network.runPaths.join() === '0,0,1',
    'fork: three runs — two of the first path, one of the second — and a three-arm junction', JSON.stringify(trail.network));
  const owned = resolveTrail(doc, trail);
  check(!!owned && owned.quads.length === doc.quads.length && owned.vertices.length === doc.vertices.length / 3,
    'fork: the trail owns all of it, junction included');
  const hub = owned!.vertices.at(-1)!;
  const hubAt: V3 = [doc.vertices[hub * 3], doc.vertices[hub * 3 + 1], doc.vertices[hub * 3 + 2]];
  check(valence(doc, hub) === 6 && Math.hypot(hubAt[0], hubAt[2] - 120) < 1e-9,
    'fork: the junction is six patches round one six-way vertex, at the shared point', `${valence(doc, hub)} at ${hubAt.join()}`);
  check(checkManifold(doc.quads).ok, 'fork: the network is one manifold surface');
  // Where the first path runs straight on past the fork, the crotch on the far side is on its rim, level with the
  // point: the two lanes there carry on into the junction as plain rectangles.
  const crotches = owned!.vertices.slice(-4, -1).map(v => [doc.vertices[v * 3], doc.vertices[v * 3 + 2]]);
  check(crotches.some(([x, z]) => Math.abs(x + 6.5) < 1e-6 && Math.abs(z - 120) < 1e-6),
    'fork: across from the new path, the crotch is on the rim abeam the point', JSON.stringify(crotches));
  check(owned!.quads.every(quad => quadIsLocked(doc, quad)), 'fork: every patch of it is locked, junction too');
  check(trailOwningQuad(doc, [trail], owned!.quads.at(-1)!)?.id === trail.id, 'fork: a junction patch finds its trail');

  // Every patch is exactly one path's: its runs, and the junction patches carrying its lanes on.
  const lists = trailPathQuads(doc, trail)!;
  const all = lists.flat();
  const junctionIds = trail.quads.slice(-6);
  check(all.length === trail.quads.length && new Set(all).size === all.length,
    'paths: every patch belongs to exactly one path');
  check(lists[0].filter(id => junctionIds.includes(id)).length === 4 && lists[1].filter(id => junctionIds.includes(id)).length === 2,
    'paths: the path running through has two arms of the junction, the one leaving it one');
  const firstRuns = trail.network!.runSpans[0] + trail.network!.runSpans[1];
  check(lists[1].length === trail.network!.runSpans[2] * 2 + 2 && lists[0].length === firstRuns * 2 + 4,
    'paths: … and the ribbons of their own runs');

  // Nudging the new path's tip keeps the shape, so every vertex and patch keeps its name; growing it keeps the
  // first path's runs' names, which come first.
  const nudged = cutTrail(doc, { ...trail, points: trail.points.map((p, i): V3 => i === 4 ? [180, 0.5, 220] : p) });
  check(nudged.ok && nudged.trail.vertices.join() === trail.vertices.join() && nudged.trail.quads.join() === trail.quads.join(),
    'fork: a re-cut that keeps the shape keeps every name', nudged.ok ? JSON.stringify(nudged.trail.network) : '');
  const grownTrail = { ...trail, points: [...trail.points, [260, 0, 240] as V3],
    paths: [trail.paths[0], { ...trail.paths[1], points: [...trail.paths[1].points, 5] }] };
  const grown = cutTrail(doc, grownTrail);
  const [first, second] = trail.network!.runSpans;
  const keep = (first + 1) * 3 + (second + 1) * 3;
  check(grown.ok && grown.trail.network!.runSpans[2] > trail.network!.runSpans[2]
    && grown.trail.vertices.slice(0, keep).join() === trail.vertices.slice(0, keep).join()
    && grown.trail.quads.slice(0, (first + second) * 2).join() === trail.quads.slice(0, (first + second) * 2).join(),
  'fork: growing the new path keeps the names of the path it leaves');
  // Moving the shared point moves the hub with it.
  const shifted = cutTrail(doc, { ...trail, points: trail.points.map((p, i): V3 => i === 1 ? [10, 0, 120] : p) });
  const shiftedHub = shifted.ok ? resolveTrail(shifted.doc, shifted.trail)!.vertices.at(-1)! : -1;
  check(shifted.ok && Math.abs(shifted.doc.vertices[shiftedHub * 3] - 10) < 1e-9, 'fork: the hub follows its point');

  // Taking the second path off cuts one ribbon again and leaves nothing of the network behind.
  const dropped = withoutTrailPaths(trail, [1]);
  check(dropped.trail.points.length === 3 && dropped.points.join() === '0,1,2,,', 'fork: the points only it used go with it');
  const plain = cutTrail(doc, dropped.trail);
  check(plain.ok && !plain.trail.network && resolveTrail(plain.doc, plain.trail)?.runSpans.length === 1
    && plain.doc.quads.length === plain.trail.quads.length && plain.doc.vertices.length / 3 === plain.trail.vertices.length,
  'fork: taking it off cuts one ribbon again, with nothing left over');

  // A path curving hard from the junction wears the tight-turn stripes on its first span, but the junction patches
  // carrying its lanes on wear the ordinary tiles: the stripes stop where the ribbon does.
  const curling = cutTrail(mesaDoc(), withPathThrough(inMesa(main), [1, [25, 0, 135], [45, 0, 125], [55, 0, 100], [50, 0, 70]], MESA_TILES));
  if (curling.ok) {
    const mesa = MESA_TEST;
    const stripes = new Set(trailTileRowTiles(mesa.leftTurn!));
    const ordinary = new Set(trailTileRowTiles(mesa.trail));
    const tiles = resolveTrail(curling.doc, curling.trail)!.quads.map(quad => curling.doc.quadTex?.[quad] ?? '');
    const [a, b] = curling.trail.network!.runSpans;
    check(stripes.has(tiles[(a + b) * 2]) && tiles.slice(-6).every(tile => ordinary.has(tile)),
      'fork: a tight first span wears the stripes; no junction patch does', tiles.slice(-6).join());
  } else check(false, 'fork: a path curling from the junction cuts', curling.error);

  // A path too tight to the first is refused in the trail's own words.
  const tight = cutTrail(emptyDoc(), withPathThrough(main, [1, [2, 0, 240]]));
  check(!tight.ok && /point 2|path 2/.test(tight.error) && !/\bRun \d|\bruns \d/.test(tight.error),
    'fork: a refused junction names the path and the point, not run numbers', tight.ok ? '' : tight.error);

  // The ghost: one more point on the new path shows only the patches that point changes.
  const preview = trailPreview(doc, grownTrail);
  check(preview.ok && preview.quads.length > 0 && preview.quads.length < preview.doc.quads.length,
    'preview: the next point ghosts what it adds and reshapes, not the whole trail',
    preview.ok ? `${preview.quads.length} of ${preview.doc.quads.length}` : preview.error);
  const fresh = trailPreview(doc, trail);
  check(fresh.ok && fresh.quads.length === 0, 'preview: the trail as it stands ghosts nothing');
}

// ---- every path its own: a narrow path forking off a wide one is cut with its own settings ----------------------
{
  const wide = trailOf([[0, 0, 0], [0, 0, 120], [0, 0, 240]], { widthM: 20 });
  const cut = cutTrail(emptyDoc(), withPathThrough(wide, [1, [100, 0, 180], [180, 0, 220]], { widthM: 8, trailTiles: null }));
  check(cut.ok, 'own settings: two paths cut differently still cut as one network', cut.ok ? '' : cut.error);
  if (cut.ok) {
    const width = (station: { left: V3; right: V3 }) => Math.hypot(station.left[0] - station.right[0], station.left[2] - station.right[2]);
    const [a, b] = cut.trail.network!.runSpans;
    const stations = cut.layout.stations;
    const firstPath = stations.slice(0, a + 1 + b + 1), secondPath = stations.slice(a + 1 + b + 1);
    check(firstPath.every(station => Math.abs(width(station) - 20) < 1e-6) && secondPath.every(station => Math.abs(width(station) - 8) < 1e-6),
      'own settings: each path keeps its own width');
    const lists = trailPathQuads(cut.doc, cut.trail)!;
    const tex = (ids: string[]) => ids.map(id => cut.doc.quadTex?.[nameIndex(cut.doc.quadIds).get(id)!]);
    check(tex(lists[0]).every(Boolean) && tex(lists[1]).every(tile => !tile), 'own settings: … and its own tiles, junction patches too');
    check(checkManifold(cut.doc.quads).ok, 'own settings: still one surface');
  }
}

// ---- splits, merges, crossings and loops are all paths sharing points ----------------------------------------------
{
  // A bypass: a second path leaving the first and coming back to it — a junction at each end.
  const line = trailOf([[0, 0, 0], [0, 0, 120], [0, 0, 240], [0, 0, 360], [0, 0, 480]]);
  const bypass = cutTrail(emptyDoc(), withPathThrough(line, [1, [70, 0, 180], [80, 0, 240], [70, 0, 300], 3]));
  check(bypass.ok && bypass.trail.network?.junctionArms.join() === '3,3' && bypass.trail.network.runSpans.length === 4,
    'bypass: the first path in three runs and the bypass, two junctions', bypass.ok ? JSON.stringify(bypass.trail.network) : bypass.error);
  if (bypass.ok) {
    const owned = resolveTrail(bypass.doc, bypass.trail)!;
    const hubs = [owned.vertices.at(-5)!, owned.vertices.at(-1)!];
    check(hubs.every(hub => valence(bypass.doc, hub) === 6) && checkManifold(bypass.doc.quads).ok,
      'bypass: each junction is a six-pole, and the whole is one surface');
  }

  // A crossing: two paths through one shared middle point — four arms, eight patches round an eight-way hub.
  const across = withPathThrough(trailOf([[0, 0, 0], [0, 0, 150], [0, 0, 300]]), [[-150, 0, 150], 1, [150, 0, 150]]);
  check(pointArms(across)[1] === 4, 'crossing: four arms meet where two paths run through one point');
  const crossing = cutTrail(emptyDoc(), across);
  check(crossing.ok && crossing.trail.network?.junctionArms.join() === '4' && crossing.trail.network.runSpans.length === 4,
    'crossing: both paths split there, one four-arm junction', crossing.ok ? JSON.stringify(crossing.trail.network) : crossing.error);
  if (crossing.ok) {
    const hub = resolveTrail(crossing.doc, crossing.trail)!.vertices.at(-1)!;
    check(valence(crossing.doc, hub) === 8 && checkManifold(crossing.doc.quads).ok, 'crossing: eight patches round the hub, one surface');
    const lists = trailPathQuads(crossing.doc, crossing.trail)!;
    check(lists[0].length + lists[1].length === crossing.trail.quads.length && lists.every(ids => ids.length > 8),
      'crossing: each path owns its runs and its four junction patches');
  }

  // A loop: a path ending on its own first point. Its two ends meet alone — a joint of four patches round a four-way
  // hub, so the ribbon runs on round with nothing else there.
  const ring = trailOf([[0, 0, 0], [150, 0, 100], [0, 0, 250], [-150, 0, 100]]);
  const loop: AuthoredTrail = { ...ring, paths: [{ ...ring.paths[0], points: [0, 1, 2, 3, 0] }] };
  check(pointArms(loop)[0] === 2 && junctionPoints(loop).has(0), 'loop: its two ends meet at its first point');
  const looped = cutTrail(emptyDoc(), loop);
  check(looped.ok && looped.trail.network?.junctionArms.join() === '2' && looped.trail.network.runSpans.length === 1,
    'loop: one run, closed by a two-arm joint', looped.ok ? JSON.stringify(looped.trail.network) : looped.error);
  if (looped.ok) {
    const hub = resolveTrail(looped.doc, looped.trail)!.vertices.at(-1)!;
    check(valence(looped.doc, hub) === 4 && checkManifold(looped.doc.quads).ok, 'loop: four patches round the hub, a closed ring');
    const boundary = new Map<string, number>();
    for (const [a, b, c, d] of looped.doc.quads) for (const [u, v] of [[a, b], [b, d], [d, c], [c, a]])
      boundary.set(u < v ? `${u}-${v}` : `${v}-${u}`, (boundary.get(u < v ? `${u}-${v}` : `${v}-${u}`) ?? 0) + 1);
    const open = [...boundary.values()].filter(count => count === 1).length;
    check(open === looped.trail.quads.length, 'loop: only the two rims are open — no end left', `${open} open edges`);
  }

  // A point one path just runs through is no junction.
  check(!junctionPoints(line).size && pointArms(line).join() === '1,2,2,2,1', 'plain: a point a path runs through carries nothing');
}

// ---- editing the network: points merge, paths fuse, points and paths go (docs/023 · Networks) --------------------
{
  const join = (trail: AuthoredTrail, path = 0) => trail.paths[path].points.map(point => trail.points[point].join()).join(' ');
  const two = withPathThrough(trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]]), [[0, 0, 300], [0, 0, 400]]);

  // Two paths' ends made one point, cut alike: one path through it. The point is the target's.
  const ends = mergeTrailPoints(two, 3, 2);
  check(ends.trail.paths.length === 1 && join(ends.trail) === '0,0,0 0,0,100 0,0,200 0,0,400' && ends.points[3] === null,
    'merge: two path ends on one point, cut alike, fuse into one path', join(ends.trail));
  // Cut differently, they meet in a joint and stay two.
  const unlike = { ...two, paths: [two.paths[0], { ...two.paths[1], settings: { ...two.paths[1].settings, widthM: 20 } }] };
  const kept = mergeTrailPoints(unlike, 3, 2);
  check(kept.trail.paths.length === 2 && junctionPoints(kept.trail).has(2), 'merge: cut differently, they stay two paths and meet in a joint');
  // Tiles count by what they lay, not by which copy of them a path holds.
  const { trailTiles: _t, turnRadiusM: _r, ...older } = two.paths[1].settings;
  const mesaFirst = { ...two.paths[0], settings: { ...two.paths[0].settings, trailTiles: 'MESA/Preset 1' } };
  const legacy = { ...two, paths: [mesaFirst, { ...two.paths[1], settings: { ...older, mesaTextures: true } as unknown as Settings }] };
  check(mergeTrailPoints(legacy, 3, 2).trail.paths.length === 1, 'merge: a path saved before tile sets wears what it always did, cut alike');
  const retiled = { ...two, paths: [two.paths[0], { ...two.paths[1], settings: { ...two.paths[1].settings, trailTiles: 'ALOHA/Preset 1' } }] };
  check(mergeTrailPoints(retiled, 3, 2).trail.paths.length === 2, 'merge: paths wearing different tiles stay two');

  // A split cuts each path running on through the point; where paths only end, there is nothing to cut.
  const loop = { ...two.paths[0], points: [0, 1, 2, 1, 0] };
  const twice = splitPathsAt({ ...two, paths: [loop] }, 1);
  check(twice?.trail.paths.map(path => path.points.join('-')).join() === '0-1,1-2-1,1-0' && twice.pieces[0].join() === '0,1,2',
    'split: a path through the point twice is cut at both, its first piece in its place and the rest after');
  check(splitPathsAt(two, 0) === null && splitPathsAt(two, 2) === null, 'split: a path’s end has nothing to split');

  // Disconnecting: each arm ends at a point of its own, carrying the point's values; apart, a trail each.
  const tee = { ...withPathThrough(trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]]), [1, [80, 0, 160]]),
    pointSettings: [null, { widthM: 25 }] };
  const apart = disconnectPoint(tee, 1, 1)!;
  const arms = pointArms(apart.trail);
  check(apart.trail.points.length === 6 && !junctionPoints(apart.trail).size && arms.every(count => count === 1 || count === 0)
    && [1, 4, 5].every(point => apart.trail.pointSettings?.[point]?.widthM === 25 && apart.trail.points[point].join() === '0,0,100'),
  'disconnect: a fork’s three arms each end at a copy of the point, with its values', arms.join());
  check(apart.trail.paths[1].points[0] === 1, 'disconnect: the first arm of the path asked for keeps the point');
  const parts = separateTrail(apart.trail);
  check(parts.trails.length === 3 && parts.trails[0].id === tee.id && parts.trails.slice(1).every(part => !part.id && !part.quads.length)
    && parts.trails.every(part => part.paths.length === 1 && part.points.length === 2),
  'separate: three networks, three trails — the first keeps the trail, the others are new');
  check(disconnectPoint(tee, 0) === null, 'disconnect: a free end has nothing to come apart');
  const jointCut = cutTrail(emptyDoc(), kept.trail);
  check(jointCut.ok && jointCut.trail.network?.junctionArms.join() === '2' && checkManifold(jointCut.doc.quads).ok,
    'merge: … and the joint cuts as one surface', jointCut.ok ? '' : jointCut.error);
  // Running backward into the point, the path is turned round to fuse: its handles swap sides and its seam mirrors.
  const backward = { ...two, points: [...two.points], paths: [two.paths[0], { ...two.paths[1], points: [4, 3], handles: [{ out: [1, 0, 2] as V3 }] }] };
  const fused = mergeTrailPoints(backward, 3, 2);
  check(fused.trail.paths.length === 1 && join(fused.trail) === '0,0,0 0,0,100 0,0,200 0,0,400'
    && fused.trail.paths[0].handles?.[3]?.in?.join() === '1,0,2', 'merge: a path running the other way is turned round to fuse');
  // A path's end on another's middle point: a fork.
  const fork = mergeTrailPoints(two, 3, 1);
  check(fork.trail.paths.length === 2 && pointArms(fork.trail)[1] === 3, 'merge: an end on a middle point makes a fork');
  // A path's end on its own first point closes a loop, which stays one path.
  const ring = trailOf([[0, 0, 0], [100, 0, 100], [0, 0, 200], [-100, 0, 100], [0, 0, 10]]);
  const closed = mergeTrailPoints(ring, 4, 0);
  check(closed.trail.paths.length === 1 && closed.trail.paths[0].points.join() === '0,1,2,3,0', 'merge: an end on its own start closes a loop');
  check(fusePathsAt(closed.trail, 0) === null, 'fuse: a loop’s two ends are one path already');

  // Deleting a point: every path runs straight past it; a path left with one point goes, and its lone point.
  const forked = withPathThrough(trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]]), [1, [100, 0, 150]]);
  const noFork = withoutTrailPoint(forked, 1);
  check(noFork.trail.paths.length === 1 && join(noFork.trail) === '0,0,0 0,0,200' && noFork.trail.points.length === 2
    && noFork.paths.join() === '0,' && noFork.points.join() === '0,,1,',
  'delete point: the junction point goes from every path; one left with a single point goes too', JSON.stringify(noFork));
  const settled = withoutTrailPoint({ ...trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]]), pointSettings: [{ widthM: 1 }, { widthM: 2 }, { widthM: 3 }] }, 1);
  check(settled.trail.pointSettings?.map(entry => entry?.widthM).join() === '1,3', 'delete point: later points keep their own values');

  // Two trails become one: the other's points and paths after this one's.
  const joined = joinTrails(trailOf([[0, 0, 0], [0, 0, 100]]), { ...trailOf([[50, 0, 0], [50, 0, 100], [50, 0, 200]]), id: 'trail:0001' });
  check(joined.trail.id === 'trail:0000' && joined.points === 2 && joined.paths === 1 && joined.trail.paths[1].points.join() === '2,3,4',
    'join trails: the other is renumbered after this one');
  check(connectedPaths(joined.trail, 0).join() === '0' && connectedPaths(forked, 1).join() === '0,1',
    'connected: paths sharing a point are one network; ones that do not are not');

  // Reversed, a path is the same ground from the other end.
  const back = reversePath({ points: [0, 1, 2], handles: [{ out: [1, 0, 2] }], settings: { ...TRAIL_SETTINGS_DEFAULTS, centerBias: 0.4 } });
  check(back.points.join() === '2,1,0' && back.handles?.[2]?.in?.join() === '1,0,2' && !back.handles?.[2]?.out
    && Math.abs(back.settings.centerBias - 0.6) < 1e-12, 'reverse: points and handles run the other way, the seam mirrors');
}

// ---- trails saved before networks come forward as paths, keeping every name ------------------------------------
{
  // Cut a fork as a network, then write it out as the old trail-with-a-branch it used to be.
  const network = withPathThrough(trailOf([[0, 0, 0], [0, 0, 120], [0, 0, 240]]), [1, [100, 0, 180], [180, 0, 220]]);
  const cut = cutTrail(emptyDoc(), network);
  if (cut.ok) {
    const legacy = {
      id: cut.trail.id, knots: cut.trail.points.slice(0, 3), settings: { ...TRAIL_SETTINGS_DEFAULTS },
      knotSettings: [null, { widthM: 16 }], branches: [{ knot: 1, knots: cut.trail.points.slice(3) }],
      vertices: cut.trail.vertices, quads: cut.trail.quads,
      network: { runSpans: cut.trail.network!.runSpans, junctions: 1 },
    };
    const migrated = migrateLegacyTrail(legacy);
    check(JSON.stringify(migrated.points) === JSON.stringify(cut.trail.points)
      && migrated.paths.map(path => path.points.join()).join(' ') === '0,1,2 1,3,4'
      && JSON.stringify(migrated.network) === JSON.stringify(cut.trail.network) && migrated.pointSettings?.[1]?.widthM === 16,
    'legacy: the trail is the first path, its branch the second, and its names divide as they did', JSON.stringify(migrated.network));
    const plainPoints = { ...migrated, pointSettings: undefined };
    const again = cutTrail(cut.doc, plainPoints);
    check(!!resolveTrail(cut.doc, migrated) && again.ok && again.trail.quads.join() === cut.trail.quads.join()
      && again.doc.nextId === cut.doc.nextId, 'legacy: it re-cuts in place, on the same patches');
    const loaded = migrateMountain({ ...JSON.parse(JSON.stringify(cut.doc)), trails: [legacy] });
    check(loaded.trails?.[0].paths.length === 2 && !('knots' in loaded.trails[0]), 'legacy: loading a document brings it forward');
    check(normalizeTrails([cut.trail])![0] === cut.trail, 'legacy: a trail already in network form passes through');
    const rejoin = migrateLegacyTrail({ ...legacy, branches: [{ knot: 1, knots: [[60, 0, 200]], to: 2 }], network: undefined });
    check(rejoin.paths[1].points.join() === '1,3,2', 'legacy: a branch that rejoined runs on to the point it rejoined');
  } else check(false, 'legacy: the fork cuts', cut.error);
}

// ---- each point's own section (docs/023 · Per-point section) -----------------------------------------------------
{
  const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
  const stationsOf = (trail: AuthoredTrail) => {
    const cut = cutTrail(emptyDoc(), trail);
    if (!cut.ok) throw new Error(cut.error);
    return cut.layout.stations;
  };

  // A width on the middle knot of a straight: the trail swells to it and back, evenly by distance.
  const line = trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]]);
  const swollen = { ...line, pointSettings: [null, { widthM: 25 }] };
  const widths = stationsOf(swollen).map(station => station.widthM);
  const atKnots = trailPathStations(swollen, 0)!.map(station => station.widthM);
  check(atKnots.length === 3 && near(atKnots[0], 13) && near(atKnots[1], 25) && near(atKnots[2], 13),
    'knot width: the knot is cut at its own width, its neighbours at the trail’s', atKnots.join());
  // 100 m per segment is five even spans; the clamped end tangent makes the curve's parameter run unevenly
  // there, so a taper read by parameter would not land on these.
  check(widths.length === 11 && [13, 15.4, 17.8, 20.2, 22.6, 25, 22.6, 20.2, 17.8, 15.4, 13].every((w, i) => near(widths[i], w)),
    'knot width: the taper runs evenly by distance along the trail', widths.map(w => w.toFixed(2)).join());

  // A knot that sets nothing, or the neutral strength, cuts exactly what no knot values do.
  const curve = trailOf([[0, 0, 0], [0, 0, 100], [60, 0, 180], [150, 0, 220], [260, 0, 220]]);
  const auto = stationsOf(curve);
  const same = (a: typeof auto, b: typeof auto) => a.length === b.length && a.every((station, i) =>
    dist(station.left, b[i].left) < 1e-9 && dist(station.right, b[i].right) < 1e-9 && dist(station.center, b[i].center) < 1e-9);
  check(same(auto, stationsOf({ ...curve, pointSettings: [null, {}, { bankStrength: 1 }] })),
    'knot values: knots that set nothing cut the trail as before');
  check(auto.some(station => Math.abs(station.bankDegrees) > 5), 'bank: the curve banks automatically',
    auto.map(s => s.bankDegrees.toFixed(1)).join());

  // Two fixed knots ramp straight between their angles: two at 0° hold the stretch level through the curve.
  const flatCurve = { ...curve, pointSettings: [null, { bankDegrees: 0 }, { bankDegrees: 0 }] };
  const flat = stationsOf(flatCurve);
  const knotStation = (knot: number) => {
    const at = trailPathStations(flatCurve, 0)![knot];
    return flat.findIndex(station => dist(station.center, at.center) < 1e-9);
  };
  const [from, to] = [knotStation(1), knotStation(2)];
  check(from > 0 && to > from && flat.slice(from, to + 1).every(station => station.bankDegrees === 0),
    'fixed bank: two knots at 0° keep the stretch between them level', flat.map(s => s.bankDegrees.toFixed(1)).join());
  check(auto.slice(from, to + 1).some(station => Math.abs(station.bankDegrees) > 1),
    'fixed bank: … where the automatic bank would have leaned');
  const tilted = stationsOf({ ...curve, pointSettings: [null, { bankDegrees: 4 }, { bankDegrees: 12 }] });
  const ramp = tilted.slice(from, to + 1).map(station => station.bankDegrees);
  check(near(ramp[0], 4) && near(ramp.at(-1)!, 12) && ramp.every((b, i) => !i || b > ramp[i - 1]),
    'fixed bank: it turns evenly from one knot’s angle to the next', ramp.map(b => b.toFixed(2)).join());

  // A fixed knot beside an automatic one fades from its angle to the automatic bank.
  const faded = stationsOf({ ...curve, pointSettings: [null, { bankDegrees: -10 }] });
  check(near(faded[from].bankDegrees, -10) && near(faded[to].bankDegrees, auto[to].bankDegrees)
    && faded.slice(to).every((station, i) => near(station.bankDegrees, auto[to + i].bankDegrees))
    && faded.slice(0, from).some((station, i) => !near(station.bankDegrees, auto[i].bankDegrees)),
  'fixed bank: it fades into the automatic bank at the automatic neighbours, which are left as they were');

  // Strength scales the automatic bank: 0 everywhere levels it, 2 everywhere leans harder.
  const strengthAll = (value: number) => stationsOf({ ...curve, pointSettings: curve.points.map(() => ({ bankStrength: value })) });
  check(strengthAll(0).every(station => station.bankDegrees === 0), 'bank strength: 0 keeps the rims level');
  const steepest = (stations: typeof auto) => Math.max(...stations.map(station => Math.abs(station.bankDegrees)));
  check(steepest(strengthAll(2)) > steepest(auto) * 1.5, 'bank strength: 2 banks harder than automatic',
    `${steepest(strengthAll(2)).toFixed(1)} vs ${steepest(auto).toFixed(1)}`);
  check(!cutTrail(emptyDoc(), { ...curve, pointSettings: [{ bankStrength: -1 }] }).ok, 'bank strength: a negative one is refused');

  // The list stays index-parallel with the points through edits, and empty entries fall away.
  const set = setTrailKnotValue(undefined, 3, 1, 'widthM', 20);
  check(set.length === 2 && set[0] === null && set[1]?.widthM === 20, 'knot values: setting one fills only that knot');
  check(setTrailKnotValue(set, 3, 1, 'widthM', undefined).length === 0, 'knot values: clearing the last value drops the list');

  // A point two paths share sets its value for both.
  const shared = { ...withPathThrough(line, [1, [100, 0, 160], [180, 0, 200]]), pointSettings: [null, { widthM: 30 }] };
  check(trailPathStations(shared, 0)![1].widthM === 30 && trailPathStations(shared, 1)![0].widthM === 30
    && trailPathStations(shared, 1)![1].widthM === 13, 'shared point: both paths through it take its width');

  // A trimmed spline (a junction's run) carries a bank fixed on one side as the nearer knot's choice.
  const chain: TrailCubic[] = [[[0, 0, 0], [0, 0, 33], [0, 0, 67], [0, 0, 100]]];
  const trimmed = trimTrailSpline(chain, { bankDegrees: [null, 10], widthM: [10, 20] }, 10, 10);
  check('spline' in trimmed && trimmed.profile?.bankDegrees?.join() === ',10' && near(trimmed.profile.widthM![0], 11, 1e-3),
    'trim: a fixed bank carries as the nearer knot’s, a width by distance', JSON.stringify('spline' in trimmed && trimmed.profile));
}

// ---- a trail is a document object: an id, a register, and a round trip ------------------------------------------
{
  check(nextTrailId([{ id: 'trail:0000' } as AuthoredTrail]) === 'trail:0001', 'identity: the next free trail id');
  const raw = migrateMountain(blankMountain()) as unknown as Record<string, unknown>;
  raw.trails = [{ ...created.trail, id: undefined }];
  const doc = migrateMountain(JSON.parse(JSON.stringify(raw)));
  check(doc.trails?.[0].id === 'trail:0000', 'migrate: a trail saved without an id is given one');
  const key = objectRegister('trail', 'trail:0000');
  check(documentRegisters(doc).has(key), 'registers: a trail is addressable by its own id');
  const other = migrateMountain(blankMountain());
  applyRegisters(other, [[key, doc.trails![0]]]);
  check(other.trails?.length === 1 && other.trails[0].quads.length === 10, 'registers: assigning a trail lands it whole');
  applyRegisters(other, [[key, undefined]]);
  check(other.trails?.length === 0, 'registers: assigning nothing deletes it');
}

// ---- lanes: a path some patches wide ------------------------------------------------------------------------------
{
  const wide = trailOf([[0, 0, 0], [0, 0, 100]], { lanes: 3, widthM: 20 });
  const cut = cutTrail(emptyDoc(), wide);
  check(cut.ok, 'lanes: a three-lane trail cuts', cut.ok ? '' : cut.error);
  if (cut.ok) {
    const spans = cut.layout.spans.length;
    check(cut.trail.quads.length === spans * 3 && cut.trail.vertices.length === (spans + 1) * 4
      && cut.trail.network?.runLanes?.join() === '3',
    'lanes: three patches a span, four rails a station, and the cut remembers its lanes', JSON.stringify(cut.trail.network));
    const owned = resolveTrail(cut.doc, cut.trail);
    check(!!owned && owned.runLanes.join() === '3' && owned.quads.every(quad => quadIsLocked(cut.doc, quad)),
      'lanes: the trail finds its three-lane ribbon again');
    check(trailPathQuads(cut.doc, cut.trail)?.[0].length === cut.trail.quads.length, 'lanes: every patch is the path’s');
    // Narrowed to two the trail is plain Mesa again, with nothing to remember; widened to four it grows.
    const two = cutTrail(cut.doc, { ...cut.trail, paths: [{ ...cut.trail.paths[0], settings: { ...cut.trail.paths[0].settings, lanes: 2 } }] });
    check(two.ok && !two.trail.network && two.trail.quads.length === spans * 2 && two.doc.quads.length === spans * 2
      && !!resolveTrail(two.doc, two.trail), 'lanes: back to two lanes, the cut is an ordinary ribbon again');
    const four = two.ok && cutTrail(two.doc, { ...two.trail, paths: [{ ...two.trail.paths[0], settings: { ...two.trail.paths[0].settings, lanes: 4 } }] });
    check(!!four && four.ok && four.trail.quads.length === spans * 4 && four.doc.quads.length === spans * 4
      && four.trail.quads.slice(0, spans * 2).every(id => two.ok && two.trail.quads.includes(id)),
    'lanes: widening to four re-uses the patches it had and adds the rest');
  }

  // Joined to other patches the trail keeps its layout, lanes and all.
  const { doc, trail } = created;
  const owned = resolveTrail(doc, trail)!;
  const host: QuadMeshDoc = {
    ...doc,
    vertices: [...doc.vertices, -20, 0, 0, -20, 0, 20],
    vertexIds: [...doc.vertexIds, 'host-a', 'host-b'],
    quads: [...doc.quads, [doc.vertices.length / 3, owned.vertices[0], doc.vertices.length / 3 + 1, owned.vertices[3]]],
    quadIds: [...doc.quadIds, 'host-quad'],
  };
  const widened = cutTrail(host, { ...trail, paths: [{ ...trail.paths[0], settings: { ...trail.paths[0].settings, lanes: 3 } }] });
  check(!widened.ok && /lanes wide/.test(widened.error), 'lanes: a joined trail cannot change its lanes', widened.ok ? '' : widened.error);

  // A fork of three lanes through and four leaving: one surface, each patch one path's, names kept by a nudge.
  const main = trailOf([[0, 0, 0], [0, 0, 160], [0, 0, 320]], { lanes: 3, widthM: 18 });
  const fork = withPathThrough(main, [1, [120, 0, 230], [220, 0, 290]], { lanes: 4, widthM: 24 });
  const forked = cutTrail(emptyDoc(), fork);
  check(forked.ok, 'lanes fork: three lanes and four meet', forked.ok ? '' : forked.error);
  if (forked.ok) {
    const shape = forked.trail.network!;
    check(shape.runLanes?.join() === '3,3,4' && JSON.stringify(shape.runEnds) === '[[3,2],[2,3],[2,4]]'
      && JSON.stringify(shape.junctionSizes) === '[{"vertices":4,"quads":6}]',
    'lanes fork: the cut remembers each run’s lanes, the two each narrows to at the junction, and its size', JSON.stringify(shape));
    const own = resolveTrail(forked.doc, forked.trail);
    check(!!own && own.quads.length === forked.doc.quads.length && own.vertices.length === forked.doc.vertices.length / 3
      && checkManifold(forked.doc.quads).ok, 'lanes fork: the trail owns one manifold surface, junction included');
    const lists = trailPathQuads(forked.doc, forked.trail)!;
    const all = lists.flat();
    const junction = shape.junctionSizes![0].quads;
    // Each run a patch a lane a span, at its widest; and two patches an arm in the junction.
    check(all.length === forked.trail.quads.length && new Set(all).size === all.length
      && lists[1].length === shape.runSpans[2] * 4 - 1 + 2 && lists[0].length === (shape.runSpans[0] + shape.runSpans[1]) * 3 + 4
      && junction === 6,
    'lanes fork: every patch is exactly one path’s, the junction’s by the arm it carries on', lists.map(list => list.length).join());
    const nudged = cutTrail(forked.doc, { ...forked.trail, points: forked.trail.points.map((p, i): V3 => i === 4 ? [220, 0.5, 300] : p) });
    check(nudged.ok && nudged.trail.vertices.join() === forked.trail.vertices.join() && nudged.trail.quads.join() === forked.trail.quads.join(),
      'lanes fork: a re-cut that keeps the shape keeps every name');
  }
}

// ---- caps: a path's free ends closed square, its ends at a junction not ----------------------------------------
{
  const main = trailOf([[0, 0, 0], [0, 0, 120], [0, 0, 240]], { caps: 'both', ...MESA_TILES });
  const cut = cutTrail(mesaDoc(), main);
  check(cut.ok, 'caps: a capped path cuts', cut.ok ? '' : cut.error);
  if (cut.ok) {
    const spans = cut.layout.spans;
    check(spans[0].cap === 'start' && spans.at(-1)!.cap === 'end' && Math.abs(spans[0].lengthM - 6.5) < 0.01
      && Math.abs(spans.at(-1)!.lengthM - 6.5) < 0.01,
    'caps: both its ends are capped, a lane long', `${spans[0].lengthM} ${spans.at(-1)!.lengthM}`);
    const tiles = resolveTrail(cut.doc, cut.trail)!.quads.map(quad => cut.doc.quadTex?.[quad]);
    const mirrored = resolveTrail(cut.doc, cut.trail)!.quads.map(quad => !!cut.doc.quadOrient?.[quad]?.mirror);
    check(tiles.slice(-2).join() === 'MESA/0043.png,MESA/0041.png' && tiles.slice(0, 2).join() === 'MESA/0041.png,MESA/0043.png'
      && [...mirrored.slice(0, 2), ...mirrored.slice(-2)].every(Boolean),
    'caps: wearing Mesa’s cap row, mirrored as it is, turned round at the first point', tiles.join());
    const forked = cutTrail(cut.doc, withPathThrough(cut.trail, [1, [100, 0, 180], [180, 0, 220]], { caps: 'both' }));
    check(forked.ok && forked.layout.spans.filter(span => span.cap).length === 3,
      'caps: at a fork, the three free ends are capped and the junction’s are not', forked.ok ? '' : forked.error);
  }
  const reversed = reversePath({ points: [0, 1], settings: { ...TRAIL_SETTINGS_DEFAULTS, caps: 'start' } });
  check(reversed.settings.caps === 'end', 'caps: a path turned round keeps its cap on the same end');
}

// ---- the set builder's tiles: each shown as it is laid, turned and mirrored of its own --------------------------------
{
  // Every way a tile can show, on a row at every turn, is the way it is set to.
  const round = [0, 1, 2, 3].every(quarterTurns => [0, 1, 2, 3].every(rot => [false, true].every(mirror => {
    const row = withTrailTileRowView({ left: 'A/1.png', middle: 'A/2.png', right: 'A/3.png', quarterTurns }, 'middle', { rot, mirror });
    const view = trailTileRowView(row, 'middle'), others = trailTileRowView(row, 'left');
    return view.rot === rot && view.mirror === mirror && others.rot === trailTileRowView({ ...row, turns: undefined, mirrored: undefined }, 'left').rot
      && !others.mirror;
  })));
  check(round, 'builder: a tile set to show some way shows that way, and only it changes');
  const upright = withTrailTileRowView({ left: 'A/1.png', right: 'A/3.png', quarterTurns: 2 }, 'left', { rot: 0, mirror: false });
  check(!upright.turns && !upright.mirrored, 'builder: a tile shown as its row lays it carries no turn of its own', JSON.stringify(upright));
  // A cap or turn row's middle set plain stays plain; left out, it is the trail row's.
  const set: TrailTileSet = {
    level: 'A', name: 'Trail 9', trail: { left: 'A/1.png', middle: 'A/2.png', right: 'A/3.png', quarterTurns: 2 },
    cap: { left: 'A/4.png', middle: '', right: 'A/5.png', quarterTurns: 2 }, leftTurn: { left: 'A/6.png', right: 'A/7.png', quarterTurns: 0 },
  };
  check(trailTileSetRow(set, 'cap').row.middle === '' && trailTileSetRow(set, 'leftTurn').row.middle === 'A/2.png'
    && trailTileRowView(trailTileSetRow(set, 'leftTurn').row, 'middle').rot === trailTileRowView(set.trail, 'middle').rot,
  'builder: a plain middle stays plain, a borrowed one shows as it does in the trail row');
  // Its layout, as it is written among the built-in sets.
  const turned = { ...set, trail: withTrailTileRowView(set.trail, 'left', { rot: 1, mirror: true }) };
  check(trailTileSetLiteral(turned).includes(`trail: { left: 'A/1.png', middle: 'A/2.png', right: 'A/3.png', mirrored: ['left'], quarterTurns: 2, turns: { left: 1 } },`)
    && trailTileSetLiteral(turned).includes(`\n  cap: { left: 'A/4.png', middle: '', right: 'A/5.png', quarterTurns: 2 },\n`)
    && trailTileSetLiteral(turned).startsWith(`{\n  level: 'A', name: 'Trail 9',\n  cap: `),
  'builder: a set’s layout reads as it is written in the built-in sets', trailTileSetLiteral(turned));
  // A narrow set — two across — fits a two-lane path only; a wide one any. Its layout says it is narrow.
  check(trailTileSetFits({ narrow: true }, 2) && !trailTileSetFits({ narrow: true }, 3) && !trailTileSetFits({ narrow: true }, 1)
    && trailTileSetFits({}, 1) && trailTileSetFits({}, 4), 'narrow: a narrow set fits two lanes, a wide one any');
  check(trailTileSetLiteral({ level: 'A', name: 'Trail 9', narrow: true, trail: { left: 'A/1.png', right: 'A/3.png', quarterTurns: 2 } })
    .startsWith(`{\n  level: 'A', name: 'Trail 9', narrow: true,\n`), 'narrow: its layout says it is narrow');
}

// ---- the presets: whole 4×3 sets, each of one map's tiles ----------------------------------------------------------
{
  const ids = TRAIL_TILE_SETS.map(trailTileSetId);
  check(['ALASKA/Preset 1', 'ALOHA/Preset 1', 'GARI/Preset 1', 'GARI/Preset 2', 'GARI/Preset 3', 'MESA/Preset 1', 'SNOW/Preset 1']
    .join() === ids.join(), 'presets: the built-in sets, map by map', ids.join());
  check(TRAIL_TILE_SETS.every(set => TRAIL_TILE_ROWS.every(key => !set[key]
    || trailTileRowTiles(set[key]!).every(tile => tile.startsWith(`${set.level}/`)) && trailTileRowTiles(set[key]!).length === (set.narrow ? 2 : 3))),
  'presets: every row of each is three tiles of its own map’s, a narrow set’s two');
  check(DEFAULT_TRAIL_TILES.trailTiles === 'GARI/Preset 3' && !findTrailTileSet(DEFAULT_TRAIL_TILES.trailTiles, [])!.narrow,
    'presets: a new path wears Gari’s wide set');
  // The sets they replaced: a path naming one wears the set after it with the same trail row, or goes plain.
  check(findTrailTileSet('GARI/Snow Trail', []) === findTrailTileSet('GARI/Preset 3', [])
    && findTrailTileSet('MESA/Trail 1', []) === findTrailTileSet('MESA/Preset 1', []) && findTrailTileSet('MERQUER/Trail 1', []) === null,
  'presets: a set replaced is worn as the one after it, or none');
  // A mountain's own set by a built-in one's name — laid as its own, since built in — stands behind it.
  const shadow: TrailTileSet = { level: 'GARI', name: 'Preset 3', trail: { left: 'GARI/0001.png', right: 'GARI/0002.png', quarterTurns: 0 } };
  check(trailTileSetsWith([shadow]).filter(set => trailTileSetId(set) === 'GARI/Preset 3').length === 1
    && findTrailTileSet('GARI/Preset 3', [shadow]) === TRAIL_TILE_SETS.find(set => trailTileSetId(set) === 'GARI/Preset 3'),
  'presets: a mountain’s own set by a built-in one’s name stands behind it');
  // A preset's name before it was one names it still — but a mountain's own set of that name is its own.
  const kept: TrailTileSet = { level: 'GARI', name: 'Trail 3', trail: { left: 'GARI/0001.png', right: 'GARI/0002.png', quarterTurns: 0 } };
  check(findTrailTileSet('GARI/Trail 3', []) === findTrailTileSet('GARI/Preset 3', []) && findTrailTileSet('GARI/Trail 3', [kept]) === kept,
    'presets: a preset’s old name names it, where the mountain has no set of its own by that name');
  // A three-lane path wears its set right across: Alaska's snow plain, Gari's edge tile on both edges.
  const lanesOf = (trailTiles: string) => {
    const cut = cutTrail(emptyDoc(), trailOf([[0, 0, 0], [0, 0, 100]], { lanes: 3, widthM: 18, trailTiles }));
    return cut.ok ? resolveTrail(cut.doc, cut.trail)!.quads.slice(0, 3)
      .map(quad => `${cut.doc.quadTex?.[quad]}${cut.doc.quadOrient?.[quad]?.mirror ? ' mirrored' : ''}`).join() : cut.error;
  };
  check(lanesOf('ALASKA/Preset 1') === 'ALASKA/0137.png,ALASKA/0137.png,ALASKA/0137.png', 'presets: Alaska’s snow, plain right across');
  check(lanesOf('GARI/Preset 3') === 'GARI/0012.png,GARI/0020.png,GARI/0012.png',
    'presets: Gari’s edge tile on both edges, its groomed snow between', lanesOf('GARI/Preset 3'));
}

// ---- a document saved with tile pairs and two-lane paths loads with tile sets and lanes ---------------------------
{
  const raw = JSON.parse(JSON.stringify(migrateMountain(blankMountain()))) as Record<string, unknown>;
  const { lanes: _lanes, caps: _caps, ...older } = TRAIL_SETTINGS_DEFAULTS;
  raw.trails = [{ ...created.trail, paths: [{ ...created.trail.paths[0], settings: older }] }];
  raw.trailTilePairs = [{ level: 'A', name: 'Trail 1', kind: 'trail', left: 'A/1.png', right: 'A/2.png', quarterTurns: 0 }];
  const doc = migrateMountain(raw);
  check(doc.trailTileSets?.[0].name === 'Trail 1' && doc.trailTileSets[0].trail.right === 'A/2.png' && !('trailTilePairs' in doc),
    'migrate: the mountain’s own pairs load as sets of that row');
  // Sets saved while a set was one row of a kind load as sets of that row; whole sets load as they are.
  const whole: TrailTileSet = { level: 'A', name: 'Trail 3', trail: { left: 'A/5.png', right: 'A/6.png', quarterTurns: 2 } };
  const rowSets = migrateMountain({ ...raw, trailTilePairs: undefined, trailTileSets: [
    { level: 'A', name: 'Left Turn 1', kind: 'left-turn', left: 'A/3.png', middle: 'A/4.png', right: 'A/1.png', mirrored: ['left'], quarterTurns: 2 }, whole,
  ] });
  check(JSON.stringify(rowSets.trailTileSets) === JSON.stringify([
    { level: 'A', name: 'Left Turn 1', trail: { left: 'A/3.png', right: 'A/1.png', middle: 'A/4.png', mirrored: ['left'], quarterTurns: 2 } }, whole,
  ]), 'migrate: sets of one row load as sets of that row, whole ones as they are', JSON.stringify(rowSets.trailTileSets));
  // A set of the mountain's own laid exactly as a preset — laid as its own, since built in — gives way to it: it goes,
  // and its paths wear the preset. One laid otherwise stays, by its name.
  const preset = TRAIL_TILE_SETS.find(set => trailTileSetId(set) === 'GARI/Preset 3')!;
  const twinned = migrateMountain({ ...raw, trailTilePairs: undefined,
    trailTileSets: [{ ...structuredClone(preset), name: 'Trail 3' }, { ...whole, level: 'GARI', name: 'Trail 1' }],
    trails: [{ ...created.trail, paths: [{ ...created.trail.paths[0], settings: { ...created.trail.paths[0].settings, trailTiles: 'GARI/Trail 3' } }] }] });
  check(twinned.trailTileSets?.map(set => set.name).join() === 'Trail 1' && twinned.trails?.[0].paths[0].settings.trailTiles === 'GARI/Preset 3',
    'migrate: a set of its own laid as a preset gives way to the preset, its paths wearing it',
    JSON.stringify([twinned.trailTileSets?.map(set => set.name), twinned.trails?.[0].paths[0].settings.trailTiles]));
  // A path naming a preset since renamed names it by its new name — unless the mountain has a set of its own by the old
  // one; a set with none after it stays named, and goes plain.
  const wornAfter = (trailTiles: string, own?: TrailTileSet[]) => migrateMountain({ ...raw, trailTilePairs: undefined,
    ...(own ? { trailTileSets: own } : {}),
    trails: [{ ...created.trail, paths: [{ ...created.trail.paths[0], settings: { ...created.trail.paths[0].settings, trailTiles } }] }],
  }).trails?.[0].paths[0].settings.trailTiles;
  check(wornAfter('GARI/Snow Trail') === 'GARI/Preset 3' && wornAfter('MERQUER/Trail 1') === 'MERQUER/Trail 1'
    && wornAfter('GARI/Trail 1', [{ ...whole, level: 'GARI', name: 'Trail 1' }]) === 'GARI/Trail 1',
  'migrate: a path names a renamed preset by its new name, a set of its own by its own',
  JSON.stringify([wornAfter('GARI/Snow Trail'), wornAfter('MERQUER/Trail 1')]));
  check(doc.trails?.[0].paths[0].settings.lanes === 2 && doc.trails[0].paths[0].settings.caps === 'none',
    'migrate: a path saved before lanes is two lanes wide, and one before caps uncapped');
}

if (failures) process.exitCode = 1;
