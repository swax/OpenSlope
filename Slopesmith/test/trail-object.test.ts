// tier: fast

/** Owned trails (docs/023): a spline that keeps the ribbon it cut. Run: `npx tsx test/trail-object.test.ts` */
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { nameIndex, nextTrailId } from '../src/core/doc/ids';
import type { AuthoredTrail, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { quadIsLocked } from '../src/core/mesh/locks';
import { meshFromDoc } from '../src/core/mesh/topology';
import {
  cutTrail, removeTrailPatches, resolveTrail, setTrailKnotValue, trailIsConnected, trailKnotStations, trailOwningQuad,
  TRAIL_SETTINGS_DEFAULTS, withoutTrailKnot,
} from '../src/core/mesh/trail-object';
import { MESA_TRAIL_TEXTURES, trimTrailSpline, type TrailCubic } from '../src/core/mesh/trail';
import { check, failures } from './check';

const emptyDoc = (): QuadMeshDoc => ({
  kind: 'mountain', version: 5, name: 'TRAIL OBJECT TEST', spacing: 30,
  course: { knots: [], blend: 30, surface: 1 }, baseSurface: 1,
  vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0,
});

const trailOf = (knots: V3[], settings: Partial<AuthoredTrail['settings']> = {}): AuthoredTrail => ({
  id: 'trail:0000', knots, settings: { ...TRAIL_SETTINGS_DEFAULTS, ...settings }, vertices: [], quads: [],
});

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
}

// ---- moving a knot without changing the span count re-cuts in place ------------------------------------------------
{
  const moved = cutTrail(created.doc, { ...created.trail, knots: [[0, 0, 0], [20, 5, 100]] });
  check(moved.ok, 'move: the bent trail cuts');
  if (moved.ok) {
    check(moved.trail.quads.join() === created.trail.quads.join() && moved.trail.vertices.join() === created.trail.vertices.join(),
      'move: the same vertices and patches carry the new shape');
    check(moved.doc.nextId === created.doc.nextId && !moved.doc.tombstones?.length, 'move: nothing minted, nothing retired');
    check(dist(at(moved.doc, moved.trail.vertices[16]), [20, 5, 100]) < 1e-9, 'move: the last station follows the knot');
    // Re-cut in place must be the same surface as cutting the moved spline fresh: no stale handle survives.
    const fresh = cutTrail(emptyDoc(), { ...straight, knots: [[0, 0, 0], [20, 5, 100]] });
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
  const longer = cutTrail(created.doc, { ...created.trail, knots: [[0, 0, 0], [0, 0, 100], [0, 0, 200]] });
  check(longer.ok && longer.trail.quads.length > created.trail.quads.length, 'grow: a longer trail adds spans');
  if (longer.ok) {
    check(created.trail.quads.every((id, i) => longer.trail.quads[i] === id), 'grow: the shared spans keep their patch ids');
    check(!!resolveTrail(longer.doc, longer.trail), 'grow: the ribbon still resolves');
    check(longer.trail.quads.every(id => quadIsLocked(longer.doc, nameIndex(longer.doc.quadIds).get(id)!)),
      'grow: the added patches are locked too');
    const shorter = cutTrail(longer.doc, { ...longer.trail, knots: [[0, 0, 0], [0, 0, 40]] });
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
  const bent = cutTrail(host, { ...trail, knots: [[0, 0, 0], [0, 0, 60], [30, 0, 160]] });
  check(bent.ok, 'joined: a longer spline still cuts');
  if (bent.ok) {
    check(bent.connected && bent.trail.quads.join() === trail.quads.join(), 'joined: the span count and every id hold');
    const hostCorners = bent.doc.quads[nameIndex(bent.doc.quadIds).get('host-quad')!];
    check(hostCorners[1] === l0 && hostCorners[3] === l1, 'joined: the host patch still names the rim vertices');
    check(dist(at(bent.doc, trail.vertices[3]), at(doc, trail.vertices[3])) > 1, 'joined: the shared rim vertex moved, stretching the host');
  }
  const crowded = cutTrail(host, { ...trail, knots: Array.from({ length: 7 }, (_, i) => [0, 0, i * 15] as V3) });
  check(!crowded.ok, 'joined: more knot segments than spans is refused');
}

// ---- dressing, removal, and a broken ribbon ----------------------------------------------------------------------
{
  const { doc, trail } = created;
  const owned = resolveTrail(doc, trail)!;
  const painted = { ...doc, quadTex: { ...doc.quadTex, [owned.quads[1]]: 'Custom/hand.png' } };
  const plain = cutTrail(painted, { ...trail, settings: { ...trail.settings, mesaTextures: false } });
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
  const cut = cutTrail(emptyDoc(), { ...arc, knots: [[0, 0, -120], ...arc.knots] });
  const tight = new Set((MESA_TRAIL_TEXTURES.tight ?? []).flat());
  const tiles = cut.ok ? resolveTrail(cut.doc, cut.trail)!.quads.map(quad => ({ tile: cut.doc.quadTex?.[quad], orient: cut.doc.quadOrient?.[quad] })) : [];
  check(tiles.some(t => tight.has(t.tile!)) && tiles.some(t => t.tile && !tight.has(t.tile)),
    'tiles: a straight run into a tight arc wears both sets', tiles.map(t => t.tile).join());
  check(tiles.every(t => t.orient?.rot === (tight.has(t.tile!) ? 3 : 1) && !t.orient.mirror),
    'tiles: standard halves turn a quarter, tight ones three quarters', tiles.map(t => t.orient?.rot).join());
}

// ---- each knot's own section (docs/023 · Per-knot section) -------------------------------------------------------
{
  const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
  const stationsOf = (trail: AuthoredTrail) => {
    const cut = cutTrail(emptyDoc(), trail);
    if (!cut.ok) throw new Error(cut.error);
    return cut.layout.stations;
  };

  // A width on the middle knot of a straight: the trail swells to it and back, evenly by distance.
  const line = trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]]);
  const swollen = { ...line, knotSettings: [null, { widthM: 25 }] };
  const widths = stationsOf(swollen).map(station => station.widthM);
  const atKnots = trailKnotStations(emptyDoc(), swollen)!.map(station => station.widthM);
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
  check(same(auto, stationsOf({ ...curve, knotSettings: [null, {}, { bankStrength: 1 }] })),
    'knot values: knots that set nothing cut the trail as before');
  check(auto.some(station => Math.abs(station.bankDegrees) > 5), 'bank: the curve banks automatically',
    auto.map(s => s.bankDegrees.toFixed(1)).join());

  // Two fixed knots ramp straight between their angles: two at 0° hold the stretch level through the curve.
  const flatCurve = { ...curve, knotSettings: [null, { bankDegrees: 0 }, { bankDegrees: 0 }] };
  const flat = stationsOf(flatCurve);
  const knotStation = (knot: number) => {
    const at = trailKnotStations(emptyDoc(), flatCurve)![knot];
    return flat.findIndex(station => dist(station.center, at.center) < 1e-9);
  };
  const [from, to] = [knotStation(1), knotStation(2)];
  check(from > 0 && to > from && flat.slice(from, to + 1).every(station => station.bankDegrees === 0),
    'fixed bank: two knots at 0° keep the stretch between them level', flat.map(s => s.bankDegrees.toFixed(1)).join());
  check(auto.slice(from, to + 1).some(station => Math.abs(station.bankDegrees) > 1),
    'fixed bank: … where the automatic bank would have leaned');
  const tilted = stationsOf({ ...curve, knotSettings: [null, { bankDegrees: 4 }, { bankDegrees: 12 }] });
  const ramp = tilted.slice(from, to + 1).map(station => station.bankDegrees);
  check(near(ramp[0], 4) && near(ramp.at(-1)!, 12) && ramp.every((b, i) => !i || b > ramp[i - 1]),
    'fixed bank: it turns evenly from one knot’s angle to the next', ramp.map(b => b.toFixed(2)).join());

  // A fixed knot beside an automatic one fades from its angle to the automatic bank.
  const faded = stationsOf({ ...curve, knotSettings: [null, { bankDegrees: -10 }] });
  check(near(faded[from].bankDegrees, -10) && near(faded[to].bankDegrees, auto[to].bankDegrees)
    && faded.slice(to).every((station, i) => near(station.bankDegrees, auto[to + i].bankDegrees))
    && faded.slice(0, from).some((station, i) => !near(station.bankDegrees, auto[i].bankDegrees)),
  'fixed bank: it fades into the automatic bank at the automatic neighbours, which are left as they were');

  // Strength scales the automatic bank: 0 everywhere levels it, 2 everywhere leans harder.
  const strengthAll = (value: number) => stationsOf({ ...curve, knotSettings: curve.knots.map(() => ({ bankStrength: value })) });
  check(strengthAll(0).every(station => station.bankDegrees === 0), 'bank strength: 0 keeps the rims level');
  const steepest = (stations: typeof auto) => Math.max(...stations.map(station => Math.abs(station.bankDegrees)));
  check(steepest(strengthAll(2)) > steepest(auto) * 1.5, 'bank strength: 2 banks harder than automatic',
    `${steepest(strengthAll(2)).toFixed(1)} vs ${steepest(auto).toFixed(1)}`);
  check(!cutTrail(emptyDoc(), { ...curve, knotSettings: [{ bankStrength: -1 }] }).ok, 'bank strength: a negative one is refused');

  // The list stays index-parallel with the knots through edits, and empty entries fall away.
  const set = setTrailKnotValue(undefined, 3, 1, 'widthM', 20);
  check(set.length === 2 && set[0] === null && set[1]?.widthM === 20, 'knot values: setting one fills only that knot');
  check(setTrailKnotValue(set, 3, 1, 'widthM', undefined).length === 0, 'knot values: clearing the last value drops the list');
  const shifted = withoutTrailKnot([{ widthM: 1 }, { widthM: 2 }, { widthM: 3 }], 1);
  check(shifted.length === 2 && shifted[0]?.widthM === 1 && shifted[1]?.widthM === 3, 'knot values: deleting a knot shifts the later ones down');

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
