// tier: fast

/** Owned trails (docs/023): a spline that keeps the ribbon it cut. Run: `npx tsx test/trail-object.test.ts` */
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { nameIndex, nextTrailId } from '../src/core/doc/ids';
import type { AuthoredTrail, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { quadIsLocked } from '../src/core/mesh/locks';
import { meshFromDoc } from '../src/core/mesh/topology';
import {
  branchEndpoints, branchesWithKnotAt, branchesWithoutKnot, cutTrail, joinBranch, mergeTrailInto, removeTrailPatches, resolveTrail, reverseTrail,
  setTrailKnotValue, trailAllKnots, trailIsConnected, trailKnotPlace, trailKnotRef, trailKnotStations, trailOwningQuad,
  trailPreview, TRAIL_SETTINGS_DEFAULTS, withoutTrailKnot,
} from '../src/core/mesh/trail-object';
import { checkManifold } from '../src/core/mesh/ops';
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

// ---- branches: the trail split at a knot, the branch, and a six-patch junction round a six-way hub (docs/023) ------
{
  const main = trailOf([[0, 0, 0], [0, 0, 120], [0, 0, 240]]);
  const branched: AuthoredTrail = { ...main, branches: [{ knot: 1, knots: [[100, 0, 180], [180, 0, 220]] }] };
  const cut = cutTrail(emptyDoc(), branched);
  check(cut.ok, 'branch: a trail with a branch cuts', cut.ok ? '' : cut.error);
  if (!cut.ok) process.exit(1);
  const { doc, trail } = cut;
  check(trail.network?.junctions === 1 && trail.network.runSpans.length === 3,
    'branch: the trail splits at the knot — two runs and the branch, one junction', JSON.stringify(trail.network));
  const owned = resolveTrail(doc, trail);
  check(!!owned && owned.quads.length === doc.quads.length && owned.vertices.length === doc.vertices.length / 3,
    'branch: the trail owns all of it, junction included');
  const hub = owned!.vertices.at(-1)!;
  const around = doc.quads.filter(quad => quad.includes(hub)).length;
  const hubAt: V3 = [doc.vertices[hub * 3], doc.vertices[hub * 3 + 1], doc.vertices[hub * 3 + 2]];
  check(around === 6 && Math.hypot(hubAt[0], hubAt[2] - 120) < 1e-9,
    'branch: the junction is six patches round one six-way vertex, at the branch knot', `${around} at ${hubAt.join()}`);
  check(checkManifold(doc.quads).ok, 'branch: the network is one manifold surface');
  // Where the trail runs straight on past the branch, the crotch on the far side is on its rim, level with the knot:
  // the two lanes there carry on into the junction as plain rectangles.
  const crotches = owned!.vertices.slice(-4, -1).map(v => [doc.vertices[v * 3], doc.vertices[v * 3 + 2]]);
  check(crotches.some(([x, z]) => Math.abs(x + 6.5) < 1e-6 && Math.abs(z - 120) < 1e-6),
    'branch: across from the branch, the crotch is on the rim abeam the knot', JSON.stringify(crotches));
  check(owned!.quads.every(quad => quadIsLocked(doc, quad)), 'branch: every patch of it is locked, junction too');
  check(trailOwningQuad(doc, [trail], owned!.quads.at(-1)!)?.id === trail.id, 'branch: a junction patch finds its trail');

  // Nudging the branch's tip keeps the shape, so every vertex and patch keeps its name; growing it keeps the
  // trail's own runs' names, which come first.
  const nudged = cutTrail(doc, { ...trail, branches: [{ knot: 1, knots: [[100, 0, 180], [180, 0.5, 220]] }] });
  check(nudged.ok && nudged.trail.vertices.join() === trail.vertices.join() && nudged.trail.quads.join() === trail.quads.join(),
    'branch: a re-cut that keeps the shape keeps every name', nudged.ok ? JSON.stringify(nudged.trail.network) : '');
  const grown = cutTrail(doc, { ...trail, branches: [{ knot: 1, knots: [[100, 0, 180], [180, 0, 220], [260, 0, 240]] }] });
  const [first, second] = trail.network!.runSpans;
  const keep = (first + 1) * 3 + (second + 1) * 3;
  check(grown.ok && grown.trail.network!.runSpans[2] > trail.network!.runSpans[2]
    && grown.trail.vertices.slice(0, keep).join() === trail.vertices.slice(0, keep).join()
    && grown.trail.quads.slice(0, (first + second) * 2).join() === trail.quads.slice(0, (first + second) * 2).join(),
  'branch: growing the branch keeps the names of the trail it leaves');
  // Moving the junction knot moves the hub with it.
  const shifted = cutTrail(doc, { ...trail, knots: [[0, 0, 0], [10, 0, 120], [0, 0, 240]] });
  const shiftedHub = shifted.ok ? resolveTrail(shifted.doc, shifted.trail)!.vertices.at(-1)! : -1;
  check(shifted.ok && Math.abs(shifted.doc.vertices[shiftedHub * 3] - 10) < 1e-9, 'branch: the hub follows its knot');

  // Taking the branch off cuts one ribbon again and leaves nothing of the network behind.
  const plain = cutTrail(doc, { ...trail, branches: undefined });
  check(plain.ok && !plain.trail.network && resolveTrail(plain.doc, plain.trail)?.runSpans.length === 1
    && plain.doc.quads.length === plain.trail.quads.length && plain.doc.vertices.length / 3 === plain.trail.vertices.length,
  'branch: taking it off cuts one ribbon again, with nothing left over');

  // A branch curving hard from the junction wears the tight-turn stripes on its first span, but the junction patches
  // carrying its lanes on wear the ordinary tiles: the stripes stop where the ribbon does.
  const curling = cutTrail(emptyDoc(), { ...main, branches: [{ knot: 1, knots: [[25, 0, 135], [45, 0, 125], [55, 0, 100], [50, 0, 70]] }] });
  if (curling.ok) {
    const stripes = new Set((MESA_TRAIL_TEXTURES.tight ?? []).flat());
    const ordinary = new Set(MESA_TRAIL_TEXTURES.standard.flat());
    const tiles = resolveTrail(curling.doc, curling.trail)!.quads.map(quad => curling.doc.quadTex?.[quad] ?? '');
    const [a, b] = curling.trail.network!.runSpans;
    check(stripes.has(tiles[(a + b) * 2]) && tiles.slice(-6).every(tile => ordinary.has(tile)),
      'branch: a tight first span wears the stripes; no junction patch does', tiles.slice(-6).join());
  } else check(false, 'branch: a branch curling from the junction cuts', curling.error);

  // A branch too tight to the trail is refused in the trail's own words.
  const tight = cutTrail(emptyDoc(), { ...main, branches: [{ knot: 1, knots: [[2, 0, 240]] }] });
  check(!tight.ok && /knot 2|branch/.test(tight.error) && !/\bRun \d|\bruns \d/.test(tight.error),
    'branch: a refused junction names the branch and knot, not run numbers', tight.ok ? '' : tight.error);

  // The ghost: one more knot on the branch shows only the patches that knot changes.
  const preview = trailPreview(doc, { ...trail, branches: [{ knot: 1, knots: [[100, 0, 180], [180, 0, 220], [260, 0, 240]] }] });
  check(preview.ok && preview.quads.length > 0 && preview.quads.length < preview.doc.quads.length,
    'preview: the next branch knot ghosts what it adds and reshapes, not the whole trail',
    preview.ok ? `${preview.quads.length} of ${preview.doc.quads.length}` : preview.error);
  const fresh = trailPreview(doc, { ...trail, branches: [...trail.branches!] });
  check(fresh.ok && fresh.quads.length === 0, 'preview: the trail as it stands ghosts nothing');

  // The knots are one list: the trail's own, then each branch's.
  check(trailAllKnots(branched).length === 5 && trailKnotRef(branched, 3)?.branch === 0 && trailKnotRef(branched, 3)?.knot === 0
    && trailKnotRef(branched, 1)?.branch === null && trailKnotPlace(branched, 0, 1) === 4 && trailKnotRef(branched, 5) === null,
  'knots: a branch’s knots follow the trail’s in one list');
  check(branchesWithoutKnot(branched.branches, 1).length === 0 && branchesWithoutKnot(branched.branches, 0)[0].knot === 0
    && branchesWithKnotAt(branched.branches, 0)[0].knot === 2,
  'knots: deleting the junction knot takes its branch; other edits carry it along');
}

// ---- merging: an end on another trail's knot joins the two, end to end or as a branch (docs/023 · Merging) --------
{
  const join = (a: readonly V3[]) => a.map(p => p.join()).join(' ');
  // Reversed, a trail is the same ground from the other end: handles swap sides, the seam and a fixed bank mirror.
  const there = { ...trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]], { centerBias: 0.4 }),
    handles: [{ out: [1, 0, 2] as V3 }], knotSettings: [null, { bankDegrees: 5, centerBias: 0.3 }], branches: [{ knot: 1, knots: [[50, 0, 120]] as V3[] }] };
  const back = reverseTrail(there);
  check(join(back.knots) === '0,0,200 0,0,100 0,0,0' && back.handles?.[2]?.in?.join() === '1,0,2' && !back.handles?.[2]?.out
    && back.knotSettings?.[1]?.bankDegrees === -5 && Math.abs(back.knotSettings![1]!.centerBias! - 0.7) < 1e-12
    && Math.abs(back.settings.centerBias - 0.6) < 1e-12 && back.branches?.[0].knot === 1,
  'reverse: knots, handles, knot values and branches run the other way');

  const target = trailOf([[0, 0, 0], [0, 0, 100], [0, 0, 200]]);
  // On its last knot, from either end of the other trail.
  const onward = trailOf([[0, 0, 200], [0, 0, 300], [0, 0, 400]], { widthM: 20 });
  const tail = mergeTrailInto(target, 2, onward, 'start');
  const tailBack = mergeTrailInto(target, 2, reverseTrail(onward), 'end');
  check(tail.ok && tail.joined === 'ends' && join(tail.trail.knots) === '0,0,0 0,0,100 0,0,200 0,0,300 0,0,400'
    && tailBack.ok && join(tailBack.trail.knots) === join(tail.trail.knots) && tail.trail.id === target.id,
  'merge: on the last knot the two run on as one trail, from either end of the other');
  check(tail.ok && !tail.trail.knotSettings?.[2] && tail.trail.knotSettings?.[3]?.widthM === 20 && tail.trail.knotSettings?.[4]?.widthM === 20,
    'merge: the joined knots keep their own width; the shared knot is the target\'s');
  // On its first knot: the other trail runs on ahead of it.
  const ahead = mergeTrailInto(target, 0, trailOf([[0, 0, -200], [0, 0, 0]]), 'end');
  const withBranch = { ...target, branches: [{ knot: 1, knots: [[60, 0, 140]] as V3[] }] };
  const aheadBranched = mergeTrailInto(withBranch, 0, trailOf([[0, 0, -200], [0, 0, -100], [0, 0, 0]]), 'end');
  check(ahead.ok && join(ahead.trail.knots) === '0,0,-200 0,0,0 0,0,100 0,0,200'
    && aheadBranched.ok && aheadBranched.trail.branches?.[0].knot === 3,
  'merge: on the first knot the other trail runs on ahead, and the target\'s branches move along');
  const joined = tail.ok ? cutTrail(emptyDoc(), tail.trail) : null;
  check(!!joined?.ok && joined.trail.quads.length > 0, 'merge: the joined trail cuts');

  // On a middle knot the other trail becomes its branch, laid outward from the junction.
  const side = trailOf([[120, 0, 160], [60, 0, 120], [0, 0, 100]]);
  const fork = mergeTrailInto(target, 1, side, 'end');
  check(fork.ok && fork.joined === 'branch' && fork.trail.branches?.[0].knot === 1
    && join(fork.trail.branches[0].knots) === '60,0,120 120,0,160',
  'merge: on a middle knot it becomes the branch there');
  const forked = fork.ok ? cutTrail(emptyDoc(), fork.trail) : null;
  check(!!forked?.ok && forked.trail.network?.junctions === 1, 'merge: … cut as a three-way junction');
  check(!mergeTrailInto(withBranch, 1, side, 'end').ok, 'merge: a knot carrying a branch takes no second');
  check(!mergeTrailInto(target, 1, { ...side, branches: [{ knot: 1, knots: [[70, 0, 90]] }] }, 'end').ok,
    'merge: a trail with branches does not become one');
}

// ---- a branch tip lands too: rejoining its own trail, or running on into another trail's end (docs/023 · Merging) ---
{
  const join = (a: readonly V3[]) => a.map(p => p.join()).join(' ');
  const line = trailOf([[0, 0, 0], [0, 0, 120], [0, 0, 240], [0, 0, 360], [0, 0, 480]]);
  const bypassing: AuthoredTrail = { ...line, branches: [{ knot: 1, knots: [[70, 0, 180], [80, 0, 240], [70, 0, 300], [0, 0, 360]] }] };
  // Its tip on knot 3 of its own trail: the branch rejoins there, a bypass with a junction at each end.
  const rejoined = joinBranch(bypassing, 0, { trail: bypassing, knot: 3 });
  check(rejoined.ok && rejoined.joined === 'rejoin' && rejoined.trail.branches![0].to === 3
    && join(rejoined.trail.branches![0].knots) === '70,0,180 80,0,240 70,0,300',
  'rejoin: a branch tip on its own trail\'s knot rejoins it there, the tip giving way to the knot');
  const bypass = rejoined.ok ? cutTrail(emptyDoc(), rejoined.trail) : null;
  check(!!bypass?.ok && bypass.trail.network?.junctions === 2 && bypass.trail.network.runSpans.length === 4,
    'rejoin: cut as a bypass — the trail in three runs and the branch, two junctions', bypass?.ok ? JSON.stringify(bypass.trail.network) : bypass?.error);
  if (bypass?.ok) {
    const owned = resolveTrail(bypass.doc, bypass.trail)!;
    const hubs = [owned.vertices.at(-5)!, owned.vertices.at(-1)!];
    check(hubs.every(hub => bypass.doc.quads.filter(quad => quad.includes(hub)).length === 6) && checkManifold(bypass.doc.quads).ok,
      'rejoin: each junction is a six-pole, and the whole is one surface');
  }
  check(branchEndpoints(rejoined.ok ? rejoined.trail : bypassing).has(3), 'rejoin: the knot it rejoins carries a branch now');
  check(!joinBranch(bypassing, 0, { trail: bypassing, knot: 1 }).ok, 'rejoin: not the knot it leaves');
  const rejoinedTrail = rejoined.ok ? rejoined.trail : bypassing;
  check(branchesWithoutKnot(rejoinedTrail.branches, 3)[0].to === undefined && branchesWithoutKnot(rejoinedTrail.branches, 2)[0].to === 2
    && branchesWithKnotAt(rejoinedTrail.branches, 0)[0].to === 4 && reverseTrail(rejoinedTrail).branches?.[0].to === 1,
  'rejoin: deleting the knot frees the branch; other edits carry the rejoin along');

  // Its tip on another trail's end: that trail goes on as the rest of the branch.
  const forking: AuthoredTrail = { ...line, branches: [{ knot: 1, knots: [[80, 0, 160], [200, 0, 200]] }] };
  const onward = { ...trailOf([[300, 0, 220], [200, 0, 200]]), id: 'trail:0001' }; // ends on the tip, so it runs on backward
  const extended = joinBranch(forking, 0, { trail: onward, knot: 1 });
  check(extended.ok && extended.joined === 'extend' && join(extended.trail.branches![0].knots) === '80,0,160 200,0,200 300,0,220',
    'extend: a branch tip on another trail\'s end runs on into it');
  check(!joinBranch(forking, 0, { trail: { ...trailOf([[150, 0, 0], [200, 0, 200], [250, 0, 400]]), id: 'trail:0001' }, knot: 1 }).ok,
    'extend: not into another trail\'s middle — that would be a branch of a branch');
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
