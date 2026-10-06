// tier: fast

/** Owned trails (docs/023): a network of splines that keeps the patches it cut. Run: `npx tsx test/trail-object.test.ts` */
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { nameIndex, nextTrailId } from '../src/core/doc/ids';
import type { AuthoredTrail, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { quadIsLocked } from '../src/core/mesh/locks';
import { meshFromDoc } from '../src/core/mesh/topology';
import { migrateLegacyTrail, normalizeTrails } from '../src/core/doc/trails';
import {
  connectedPaths, cutTrail, disconnectPoint, fusePathsAt, joinTrails, junctionPoints, mergeTrailPoints, pointArms, removeTrailPatches,
  resolveTrail, reversePath, separateTrail, setTrailKnotValue, splitPathsAt, trailIsConnected, trailOwningQuad, trailPathQuads, trailPathStations,
  trailInterior, trailPreview, trailRunList, TRAIL_SETTINGS_DEFAULTS, withoutTrailPaths, withoutTrailPoint,
} from '../src/core/mesh/trail-object';
import { checkManifold } from '../src/core/mesh/ops';
import { MESA_TRAIL_TEXTURES, trimTrailSpline, type TrailCubic } from '../src/core/mesh/trail';
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
  check(doc.quadTex?.[owned!.quads[0]] === 'MESA/0044.png', 'create: the Mesa tiles are laid');
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
  const plain = cutTrail(painted, { ...trail, paths: [{ ...trail.paths[0], settings: { ...trail.paths[0].settings, mesaTextures: false } }] });
  check(plain.ok && plain.doc.quadTex?.[owned.quads[0]] === undefined && plain.doc.quadTex?.[owned.quads[1]] === 'Custom/hand.png',
    'tiles off: the preset tiles come off, a hand-painted one stays');

  const removed = removeTrailPatches(doc, trail);
  check(removed.quads.length === 0 && removed.vertices.length === 0, 'remove: the ribbon and its vertices go');

  const cut = { ...doc, quads: doc.quads.slice(0, -1), quadIds: doc.quadIds.slice(0, -1) };
  check(resolveTrail(cut, trail) === null, 'broken: a ribbon missing a patch does not resolve');
  const refused = cutTrail(cut, trail);
  check(!refused.ok, 'broken: a trail that lost patches will not re-cut');
}

// ---- the Mesa tiles: the tight-turn stripe halves are worn half a turn round from the standard ones -------------
{
  const arc = trailOf([0, 30, 60, 90, 120, 150].map(deg => [60 * Math.cos(deg * Math.PI / 180), 0, 60 * Math.sin(deg * Math.PI / 180)] as V3));
  const cut = cutTrail(emptyDoc(), withKnots(arc, [[0, 0, -120], ...arc.points]));
  const tight = new Set((MESA_TRAIL_TEXTURES.tight ?? []).flat());
  const tiles = cut.ok ? resolveTrail(cut.doc, cut.trail)!.quads.map(quad => ({ tile: cut.doc.quadTex?.[quad], orient: cut.doc.quadOrient?.[quad] })) : [];
  check(tiles.some(t => tight.has(t.tile!)) && tiles.some(t => t.tile && !tight.has(t.tile)),
    'tiles: a straight run into a tight arc wears both sets', tiles.map(t => t.tile).join());
  check(tiles.every(t => t.orient?.rot === (tight.has(t.tile!) ? 3 : 1) && !t.orient.mirror),
    'tiles: standard halves turn a quarter, tight ones three quarters', tiles.map(t => t.orient?.rot).join());
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
  const curling = cutTrail(emptyDoc(), withPathThrough(main, [1, [25, 0, 135], [45, 0, 125], [55, 0, 100], [50, 0, 70]]));
  if (curling.ok) {
    const stripes = new Set((MESA_TRAIL_TEXTURES.tight ?? []).flat());
    const ordinary = new Set(MESA_TRAIL_TEXTURES.standard.flat());
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
  const cut = cutTrail(emptyDoc(), withPathThrough(wide, [1, [100, 0, 180], [180, 0, 220]], { widthM: 8, mesaTextures: false }));
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

if (failures) process.exitCode = 1;
