/**
 * Headless checks over INCREMENTAL REBUILD (docs/039, stage 6). Run: `npx tsx test/rebuild.test.ts`
 *
 * With several people editing, a remote assignment arrives at up to 25 Hz from each of them, and each one used
 * to drive the same full re-tessellation and re-bake a local edit does. This suite is the safety argument for
 * not doing that any more, and it makes three claims.
 *
 * **The dependency radius is right.** A moved corner changes exactly the patches incident to its closed one
 * ring. That is not asserted from the reading of `quadControlPoints` — it is proved by brute force: move each
 * corner of a grid, a poled net and a closed all-pole barrel in turn, rebuild the whole mountain, and require
 * that every patch that actually moved was named. The barrel exists for one reason: its caps are valence-FIVE
 * interior poles, which is where the automatic handles stop reading a single axis and fit a plane to the whole
 * incident fan — the one place a corner's handle looks past its own edges. That brute force is ~1300 full
 * re-tessellations and used to be most of the gate's wall clock on its own, so the corners are dealt out to a
 * pool of worker threads (`rebuild-radius.worker.ts`) and the tallies added back up. Every corner is still
 * moved and still checked — the proof is spread, not sampled.
 *
 * **The incremental quilt IS the full quilt.** For a vertex move, a crease, each of the four face attributes,
 * an object move, a loop cut and a delete, the incrementally updated buffers are compared byte for byte
 * against a full rebuild of the same document. A stale patch is silent — nothing throws, the terrain simply
 * renders differently for two people looking at one mountain — so equivalence is checked rather than argued.
 *
 * **The watcher says what moved, whoever moved it.** It reads the document rather than being told, so a local
 * tool, a remote register assignment and an undo re-assertion are one mechanism; a burst of assignments
 * between two frames answers as their union; and topology, which no incremental path can follow, asks for the
 * full rebuild it needs.
 *
 * **What is bound to the quilt's buffers follows them.** An update rewrites positions IN PLACE, through the
 * very buffers the ray-acceleration trees index, so the last section drives a real update through the real
 * terrain layer and requires the pointer pick to land on the surface as it now stands.
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { collisionLabMountain } from '../src/core/collision/lab';
import { getVertex, setVertex } from '../src/core/doc/doc-edit';
import { seedMeshIds } from '../src/core/doc/ids';
import { defaultMountain, meshSetHandle, meshSetTwist, migrateMountain } from '../src/core/doc/mountain';
import { applyRegisters, objectRegister, quadRegister, vertexRegister } from '../src/core/doc/registers';
import { createNetWatcher, patchDependency, patchVertexSpans } from '../src/core/mesh/incremental';
import { applyLoopCut, planLoopCut } from '../src/core/mesh/ops/loop-cut';
import { applyMeshDelete } from '../src/core/mesh/ops/delete';
import {
  buildMountainPreview, previewMismatch, refreshPreviewPatches, PATCH_VERTS,
} from '../src/core/mesh/tessellation';
import { buildQuadMesh, extraordinaryPoles, meshAdjacency } from '../src/core/mesh/topology';
import { createTerrainLayer } from '../src/app/viewport/mesh/terrain';
import { pickTree, type TreeGeometry } from '../src/app/viewport/mesh/surface-trees';
import { radiusTally, type RadiusShard, type RadiusTally } from './rebuild-radius.worker';
import type { Stage } from '../src/app/viewport/stage';
import type { TileMaterials } from '../src/app/viewport/mesh/tile-materials';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { check, failures } from './check';

const clone = (doc: QuadMeshDoc): QuadMeshDoc => migrateMountain(JSON.parse(JSON.stringify(doc)));

// ---- fixtures ----------------------------------------------------------------------------------------------

/**
 * A closed "pentagonal barrel": two five-quad caps around a centre of valence FIVE, joined by a ring of ten.
 * Every edge is shared by two quads, so both cap centres are extraordinary interior poles — the case the
 * handle derivation fits a tangent plane for, and the only place its stencil could have reached past the one
 * ring. A grid has no poles at all, so nothing else here would exercise it.
 */
function barrel(): QuadMeshDoc {
  const points: number[][] = [];
  const push = (p: number[]) => (points.push(p), points.length - 1);
  const top = push([0, 40, 0]);
  const upper: number[] = [], lower: number[] = [];
  for (let j = 0; j < 10; j++) {
    const angle = (j / 10) * Math.PI * 2, radius = j % 2 === 0 ? 25 : 20;
    upper.push(push([Math.cos(angle) * radius, 20, Math.sin(angle) * radius]));
    lower.push(push([Math.cos(angle) * radius, -20, Math.sin(angle) * radius]));
  }
  const bottom = push([0, -40, 0]);
  const quads: number[][] = [];
  for (let i = 0; i < 5; i++) {
    quads.push([top, upper[i * 2 + 1], upper[(i * 2 + 3) % 10], upper[(i * 2 + 2) % 10]]);
    quads.push([bottom, lower[(i * 2 + 3) % 10], lower[i * 2 + 1], lower[(i * 2 + 2) % 10]]);
  }
  for (let j = 0; j < 10; j++) quads.push([upper[j], upper[(j + 1) % 10], lower[j], lower[(j + 1) % 10]]);
  return {
    kind: 'quadmesh', version: 1, name: 'barrel', spacing: 10, baseSurface: 0,
    course: { knots: [], blend: 0, surface: 0 },
    vertices: points.flat(), quads, ...seedMeshIds(1, points.length, quads.length),
  } as unknown as QuadMeshDoc;
}

/** The seed template with one interior patch removed, so the net carries a hole and its rim. */
function holed(): QuadMeshDoc {
  const seed = defaultMountain();
  const cut = applyMeshDelete(seed, { quads: [Math.floor(seed.quads.length / 2) + 3] });
  if (!cut.ok) throw new Error(`the holed fixture could not be built: ${cut.error}`);
  return cut.doc;
}

/** A real authored mountain, off disk when the workspace has one and generated otherwise, so the numbers this
 *  suite reports are about a mountain somebody made rather than a template. */
function realMountain(): QuadMeshDoc {
  const path = 'workspace/projects/COLLISION_LAB-de0415cc/mountain.slope.json';
  try { return migrateMountain(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return migrateMountain(collisionLabMountain()); }
}

// ---- 1. the dependency radius, against brute force ---------------------------------------------------------

/**
 * How many threads the brute force is spread over. A quarter of the machine, because this check does not run
 * alone: the gate runs several checks at once and its own concurrency was chosen to leave headroom for the
 * ones that wait on sockets, so this must not spend that headroom the moment it is handed some. One thread
 * means no pool at all — the probes run inline, which is what a small CI box wants anyway.
 */
const askedWorkers = Number(process.env.SLOPESMITH_TEST_WORKERS);
const RADIUS_WORKERS = Number.isFinite(askedWorkers) && askedWorkers > 0
  ? Math.floor(askedWorkers)
  : Math.max(1, Math.min(6, Math.floor(availableParallelism() / 4)));
const RADIUS_WORKER = new URL('./rebuild-radius.worker.ts', import.meta.url);

const workers: Worker[] = [];
const idle: Worker[] = [];
const waiting: ((worker: Worker) => void)[] = [];

/** A worker off the pool, starting a new one only while the pool is under its size. */
function acquire(): Promise<Worker> {
  const free = idle.pop();
  if (free) return Promise.resolve(free);
  if (workers.length < RADIUS_WORKERS) {
    const started = new Worker(RADIUS_WORKER);
    workers.push(started);
    return Promise.resolve(started);
  }
  return new Promise(resolve => waiting.push(resolve));
}

/** Probe one slice of corners on a pooled worker. Workers are held open ACROSS fixtures, so the loader and
 *  three.js are paid for once at the first shard rather than again for every fixture. */
function shardTally(shard: RadiusShard): Promise<RadiusTally> {
  return acquire().then(worker => new Promise<RadiusTally>((resolve, reject) => {
    const done = () => { worker.off('message', onMessage); worker.off('error', onError); };
    const onMessage = (tally: RadiusTally) => {
      done();
      const next = waiting.shift();
      if (next) next(worker); else idle.push(worker);
      resolve(tally);
    };
    // A worker that throws is not a check that failed, it is a check that never ran — so it is raised rather
    // than tallied, and the worker is dropped instead of handed back to the pool.
    const onError = (error: Error) => { done(); reject(error); };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage(shard);
  }));
}

/** The corners split into one contiguous slice per worker; empty slices are dropped so small fixtures do not
 *  pay a round trip per corner. */
function slices(sample: number[]): number[][] {
  const size = Math.ceil(sample.length / RADIUS_WORKERS);
  const parts: number[][] = [];
  for (let at = 0; at < sample.length; at += size) parts.push(sample.slice(at, at + size));
  return parts.length ? parts : [[]];
}

async function radiusHolds(label: string, doc: QuadMeshDoc, sample: number[]): Promise<void> {
  const tallies = RADIUS_WORKERS === 1
    ? [radiusTally(doc, sample)]
    : await Promise.all(slices(sample).map(part => shardTally({ doc, sample: part })));
  const missed = tallies.reduce((sum, one) => sum + one.missed, 0);
  const claimed = tallies.reduce((sum, one) => sum + one.claimed, 0);
  const over = tallies.reduce((sum, one) => sum + one.over, 0);
  check(missed === 0,
    `${label}: every patch a moved corner changes is named (${sample.length} corners, ${missed} missed)`);
  check(over <= sample.length,
    `${label}: and barely more — ${(claimed / sample.length).toFixed(1)} patches claimed per corner, ${over} over ${sample.length} corners`);
}

{
  const seed = defaultMountain();
  await radiusHolds('seed template', seed, Array.from({ length: seed.vertices.length / 3 }, (_, i) => i));

  const hole = holed();
  await radiusHolds('net with a hole', hole, Array.from({ length: hole.vertices.length / 3 }, (_, i) => i));

  const closed = barrel();
  const poles = extraordinaryPoles(meshAdjacency(buildQuadMesh(closed.vertices, closed.quads, closed.freeEdges)));
  const adjacency = meshAdjacency(buildQuadMesh(closed.vertices, closed.quads, closed.freeEdges));
  check([...poles].some(p => adjacency.neighbors[p].length === 5),
    'barrel fixture: the caps really are valence-five extraordinary poles, so the fan case is under test');
  await radiusHolds('all-pole barrel', closed, Array.from({ length: closed.vertices.length / 3 }, (_, i) => i));

  const real = realMountain();
  const corners = real.vertices.length / 3;
  await radiusHolds('authored mountain', real, Array.from({ length: 40 }, (_, i) => Math.floor(i * corners / 40)));

  // Nothing below this point probes corners, and the timings further down want the machine to themselves.
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));

  // A crease reaches nothing beyond the edge it is pinned to.
  const preview = buildMountainPreview(seed);
  const dependency = patchDependency(preview.mesh, preview.adjacency);
  const [a, b] = [seed.quads[0][0], seed.quads[0][1]];
  const creased = dependency.ofEdges([[a, b]]);
  const incident = new Set(seed.quads.map((quad, q) => quad.includes(a) && quad.includes(b) ? q : -1).filter(q => q >= 0));
  check(creased.size === incident.size && [...creased].every(q => incident.has(q)),
    'a crease moves exactly the patches incident to its edge, and no neighbour of them');
  check(dependency.of({ quads: [17] }).size === 1,
    'a face attribute moves one patch: its own');
}

// ---- 2. incremental == full, for every kind of edit ---------------------------------------------------------

/**
 * Apply an edit, update the retained quilt through the dependency radius alone, and require the result to be
 * byte-identical to a full rebuild. This is the whole safety argument, so it compares every buffer the
 * viewport draws from rather than positions alone.
 */
function equivalent(label: string, doc: QuadMeshDoc, edit: (doc: QuadMeshDoc) => void): void {
  const preview = buildMountainPreview(doc);
  const watcher = createNetWatcher();
  watcher.note(doc);
  edit(doc);
  const change = watcher.note(doc);
  if (change.kind !== 'patches') {
    check(false, `${label}: the watcher called for a '${change.kind}' rebuild (${change.reason || 'no reason given'})`);
    return;
  }
  const dirty = patchDependency(preview.mesh, preview.adjacency).of(change);
  refreshPreviewPatches(doc, preview, dirty);
  const mismatch = previewMismatch(doc, preview);
  check(mismatch === null,
    `${label}: ${dirty.size} of ${preview.mesh.quadCount} patches updated, identical to a full rebuild`
    + (mismatch ? ` — ${mismatch}` : ''));
}

{
  const mountain = realMountain();
  const middle = Math.floor(mountain.vertices.length / 6);

  equivalent('a vertex move', clone(mountain), doc => {
    const at = getVertex(doc, middle);
    setVertex(doc, middle, [at[0] + 4, at[1] + 9, at[2] - 6]);
  });

  equivalent('a group vertex move (a smooth, resolved into positions)', clone(mountain), doc => {
    for (let v = middle; v < middle + 12; v++) {
      const at = getVertex(doc, v);
      setVertex(doc, v, [at[0], at[1] + 2.5, at[2]]);
    }
  });

  equivalent('a crease', clone(mountain), doc => {
    const [a, b] = [doc.quads[40][0], doc.quads[40][1]];
    meshSetHandle(doc, a, b, [2.5, 1.5, -0.5]);
  });

  equivalent('an uncrease (the override removed)', (() => {
    const doc = clone(mountain);
    meshSetHandle(doc, doc.quads[40][0], doc.quads[40][1], [2.5, 1.5, -0.5]);
    return doc;
  })(), doc => { delete doc.edgeHandles![`${doc.quads[40][0]}>${doc.quads[40][1]}`]; });

  equivalent('a paint (quad surface type)', clone(mountain), doc => { (doc.quadPaint ??= {})[64] = 3; });
  equivalent('a tile (quad tex)', clone(mountain), doc => { (doc.quadTex ??= {})[64] = 'TEST/REBUILD.png'; });
  equivalent('a tile orientation (quad orient)', clone(mountain), doc => {
    (doc.quadOrient ??= {})[64] = { rot: 3, mirror: true };
  });
  equivalent('an interior sculpt (quad twist)', clone(mountain), doc => { meshSetTwist(doc, 64, 2, [1.5, -2, 0.75]); });
  equivalent('a cleared tile', (() => {
    const doc = clone(mountain);
    (doc.quadTex ??= {})[64] = 'TEST/REBUILD.png';
    return doc;
  })(), doc => { delete doc.quadTex![64]; });

  // The poled and closed nets take the same trip, because the pole fan is where the radius could be wrong.
  equivalent('a vertex move beside a hole', holed(), doc => {
    const at = getVertex(doc, Math.floor(doc.vertices.length / 6));
    setVertex(doc, Math.floor(doc.vertices.length / 6), [at[0] + 5, at[1] + 3, at[2]]);
  });
  for (let v = 0; v < 22; v++) {
    const closed = barrel();
    const preview = buildMountainPreview(closed);
    const at = getVertex(closed, v);
    setVertex(closed, v, [at[0] + 2.5, at[1] + 1.5, at[2] - 3.5]);
    const dirty = patchDependency(preview.mesh, preview.adjacency).ofVertices([v]);
    refreshPreviewPatches(closed, preview, dirty);
    if (previewMismatch(closed, preview) !== null) { check(false, `all-pole barrel: corner ${v} left a stale patch`); break; }
    if (v === 21) check(true, 'all-pole barrel: every one of its 22 corners updates identically to a full rebuild');
  }
}

// ---- 3. an object assignment is not a terrain change --------------------------------------------------------

{
  const doc = realMountain();
  const watcher = createNetWatcher();
  watcher.note(doc);
  const prop = doc.props?.[0];
  check(!!prop, 'the authored mountain carries a prop to move');
  if (prop) {
    applyRegisters(doc, [[objectRegister('prop', prop.id!), { ...prop, pos: [prop.pos[0] + 12, prop.pos[1], prop.pos[2]] }]]);
    check(watcher.note(doc).kind === 'none', 'moving a prop is not a terrain change: no patch is re-tessellated');
  }
  doc.course = { ...doc.course, blend: (doc.course.blend ?? 0) + 0.1 };
  check(watcher.note(doc).kind === 'none', 'editing the run is not a terrain change either');
  doc.sun = { ...(doc.sun ?? {}), ambient: 0.42 } as typeof doc.sun;
  check(watcher.note(doc).kind === 'none', 'and neither is the sun, which relights rather than reshapes');
}

// ---- 4. topology is where a full rebuild is still the correct answer -----------------------------------------

{
  const doc = defaultMountain();
  const watcher = createNetWatcher();
  check(watcher.note(doc).kind === 'whole', 'the first render is a full build, having nothing to compare against');
  check(watcher.note(doc).kind === 'none', 'and an unchanged document asks for nothing at all');

  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const plan = planLoopCut(mesh, meshAdjacency(mesh), 0, [doc.quads[0][0], doc.quads[0][1]]);
  const cut = applyLoopCut(doc, plan, 0.5);
  check(cut.ok, 'the loop cut applies');
  if (cut.ok) {
    const change = watcher.note(cut.doc);
    check(change.kind === 'whole' && change.renumbered,
      `a loop cut asks for a full rebuild and reports the numbering moved (${change.reason})`);
  }

  const deleted = applyMeshDelete(defaultMountain(), { quads: [12] });
  check(deleted.ok, 'the delete applies');
  if (deleted.ok) {
    const after = createNetWatcher();
    after.note(defaultMountain());
    const change = after.note(deleted.doc);
    check(change.kind === 'whole' && change.renumbered, `a delete asks for a full rebuild too (${change.reason})`);
  }

  // A field every patch reads is a full rebuild WITHOUT a renumbering — nothing indexed has moved.
  const settled = defaultMountain();
  const globals = createNetWatcher();
  globals.note(settled);
  settled.baseSurface = 4;
  const change = globals.note(settled);
  check(change.kind === 'whole' && !change.renumbered,
    'changing the base surface rebuilds the whole quilt, but nothing addressed by index moved');
}

// ---- 5. the watcher: whoever moved it, and a burst as one union ----------------------------------------------

{
  const doc = realMountain();
  const watcher = createNetWatcher();
  watcher.note(doc);

  // Exactly what a remote participant's coalescing tick sends: absolute assignments, applied to this replica.
  const ids = [doc.vertexIds[100], doc.vertexIds[500], doc.vertexIds[900]];
  applyRegisters(doc, ids.map((id, at) => [vertexRegister(id), [at * 10, at * 3, at * 7] as V3]));
  applyRegisters(doc, [[quadRegister(doc.quadIds[300], 'paint'), 2]]);
  const burst = watcher.note(doc);
  check(burst.kind === 'patches' && burst.vertices.join(',') === '100,500,900' && burst.quads.join(',') === '300',
    'three remote vertex assignments and a paint between two frames answer as ONE change naming all four');

  const preview = buildMountainPreview(doc);
  const dependency = patchDependency(preview.mesh, preview.adjacency);
  const union = dependency.of(burst);
  const separately = new Set([...burst.vertices.flatMap(v => [...dependency.ofVertices([v])]), ...burst.quads]);
  check(union.size === separately.size && [...union].every(q => separately.has(q)),
    'and the union of their radii is exactly what rebuilding each of them separately would have touched');

  // An undo re-assertion is an ordinary write, so the watcher sees it the same way a fresh edit is seen.
  applyRegisters(doc, [[vertexRegister(ids[0]), [1, 2, 3] as V3]]);
  const undone = watcher.note(doc);
  check(undone.kind === 'patches' && undone.vertices.join(',') === '100',
    'an undo re-asserting a prior value is just another change, named the same way');

  // A value re-assigned to what it already held is not a change at all.
  applyRegisters(doc, [[vertexRegister(ids[0]), [1, 2, 3] as V3]]);
  check(watcher.note(doc).kind === 'none', 'and re-assigning a value the document already holds moves nothing');

  // A document REPLACED whole is compared over its mesh rather than over the object holding it, so a resync
  // or an undo restore that left the topology alone is still incremental.
  const replaced = clone(doc);
  const at = getVertex(replaced, 100);
  setVertex(replaced, 100, [at[0] + 5, at[1], at[2]]);
  const swapped = watcher.note(replaced);
  check(swapped.kind === 'patches' && swapped.vertices.join(',') === '100',
    'a whole-document replace that left the topology alone updates the one corner that moved');
}

// ---- 6. patch vertex spans: what a per-vertex relight is re-run over ------------------------------------------

{
  const spans = patchVertexSpans([3, 1, 2, 9], PATCH_VERTS);
  check(spans.length === 2 && spans[0][0] === PATCH_VERTS && spans[0][1] === 4 * PATCH_VERTS
    && spans[1][0] === 9 * PATCH_VERTS && spans[1][1] === 10 * PATCH_VERTS,
  'consecutive patches merge into one contiguous quilt span, so a relight walks runs rather than patches');
  check(patchVertexSpans([], PATCH_VERTS).length === 0, 'and no patches are no span');
}

// ---- 7. the measurement, so the win is a number rather than a claim -------------------------------------------

{
  const doc = realMountain();
  const timed = (n: number, run: () => void): number => {
    run();
    const started = performance.now();
    for (let i = 0; i < n; i++) run();
    return (performance.now() - started) / n;
  };
  const full = timed(3, () => { buildMountainPreview(doc); });
  const preview = buildMountainPreview(doc);
  const dependency = patchDependency(preview.mesh, preview.adjacency);
  const watcher = createNetWatcher();
  watcher.note(doc);

  const one = Math.floor(doc.vertices.length / 6);
  let step = 0;
  const single = timed(200, () => {
    const at = getVertex(doc, one);
    setVertex(doc, one, [at[0], at[1] + (step++ % 2 ? 0.5 : -0.5), at[2]]);
    const change = watcher.note(doc);
    refreshPreviewPatches(doc, preview, dependency.of(change));
  });
  const burst = timed(40, () => {
    for (let i = 0; i < 25; i++) {
      const v = (one + i * 17) % (doc.vertices.length / 3);
      const at = getVertex(doc, v);
      setVertex(doc, v, [at[0], at[1] + (step++ % 2 ? 0.4 : -0.4), at[2]]);
    }
    const change = watcher.note(doc);
    refreshPreviewPatches(doc, preview, dependency.of(change));
  });
  console.log(`\n    ${doc.vertices.length / 3} corners · ${doc.quads.length} patches`);
  console.log(`    full re-tessellation                ${full.toFixed(1)} ms`);
  console.log(`    incremental, one vertex move        ${single.toFixed(2)} ms  (${(full / single).toFixed(0)}x)`);
  console.log(`    incremental, a burst of 25          ${burst.toFixed(2)} ms  (${(full / burst).toFixed(0)}x)\n`);
  check(single < full / 10, `one vertex move costs less than a tenth of a full rebuild (${(full / single).toFixed(0)}x faster)`);
  check(burst < full, `a burst of 25 assignments in one frame still beats one full rebuild (${(full / burst).toFixed(0)}x faster)`);
}

// ---- 8. the pick tree follows the patches that moved ----------------------------------------------------

/**
 * The pointer-pick tree is built over the terrain's OWN position buffer (viewport/mesh/surface-trees.ts), and
 * an incremental update rewrites that buffer in place under it. Its node bounds therefore go on describing
 * the surface where it USED to be, and a ray aimed at where it now is gets culled before it reaches a
 * triangle — a cursor that intermittently stops finding ground it is standing on, which shows up as a brush
 * ring blinking out and a sculpt drag that raises terrain in fits.
 *
 * So the update refits the tree over exactly the runs of patches that moved, and this drives the real path —
 * the watcher, the dependency radius, `refreshPreviewPatches`, the real terrain layer — and then casts.
 *
 * The ray is aimed UP from between the old surface and the new one. That is the whole failure mode in one
 * shape: the surface is genuinely there to be hit, and a tree still bounding the old positions holds nothing
 * above the ray's origin at all, so it answers a confident miss rather than a wrong hit.
 */
{
  const doc = realMountain();
  const preview = buildMountainPreview(doc);

  // The terrain layer, headless: nothing here renders, and a shade mode of 'none' keeps the tile materials
  // (the only part that wants a live GL context) out of it.
  const stage = { worldRoot: new THREE.Group(), terrainMesh: null } as unknown as Stage;
  const layer = createTerrainLayer(stage, {} as TileMaterials,
    { shading: () => 'none', rigData: () => null, rigVisible: () => false }, { onGeometryRebuilt() {} });
  layer.applyPreview(preview);
  const geometry = layer.terrain.geometry as TreeGeometry;

  /** A tree over the same shared buffers, outside the geometry's cache so nothing refits it. */
  const looseTree = () => {
    const twin = new THREE.BufferGeometry();
    twin.setAttribute('position', geometry.getAttribute('position'));
    twin.setIndex(geometry.getIndex());
    return new MeshBVH(twin, { indirect: true });
  };

  const cached = pickTree(geometry)!;   // the tree a hover over the terrain builds and leaves warm
  const unrefit = looseTree();          // the same tree, as it would stand without the refit below
  check(!!cached, 'the terrain geometry carries a pointer-pick tree once something has picked against it');

  const corner = Math.floor(doc.vertices.length / 6);
  const seated = getVertex(doc, corner);
  const down = new THREE.Ray(new THREE.Vector3(seated[0], seated[1] + 500, seated[2]), new THREE.Vector3(0, -1, 0));
  const wasAt = cached.raycastFirst(down, THREE.DoubleSide);
  check(!!wasAt, 'and it finds the ground under a corner before anything moves');

  const RAISE = 60;
  const watcher = createNetWatcher();
  watcher.note(doc);
  setVertex(doc, corner, [seated[0], seated[1] + RAISE, seated[2]]);
  const change = watcher.note(doc);
  const dirty = patchDependency(preview.mesh, preview.adjacency).of(change);
  refreshPreviewPatches(doc, preview, dirty);
  layer.updatePatches(dirty, patchVertexSpans(dirty, PATCH_VERTS), { geometry: true, materials: false });

  // Between the old surface and the new one, aimed up: only the raised terrain is there to be hit.
  const up = new THREE.Ray(new THREE.Vector3(seated[0], wasAt!.point.y + RAISE / 2, seated[2]), new THREE.Vector3(0, 1, 0));
  const hit = cached.raycastFirst(up, THREE.DoubleSide);
  check(!!hit, `the pick lands on the raised surface (a corner lifted ${RAISE} units over ${dirty.size} patches)`);
  check(!!hit && hit.point.y > up.origin.y,
    'and on the new surface rather than the old one, which is below the ray entirely');

  const rebuilt = looseTree().raycastFirst(up, THREE.DoubleSide);
  check(!!hit && !!rebuilt && hit.faceIndex === rebuilt.faceIndex
    && hit.point.distanceTo(rebuilt.point) < 1e-6,
  'the refit tree reports the same triangle and the same point a freshly built one does');
  check(unrefit.raycastFirst(up, THREE.DoubleSide) === null,
    'while a tree left standing over the vacated positions misses it entirely — the regression this guards');

  // The down-cast has to agree too: a refit that only grew boxes would still pass the miss test above.
  const nowAt = cached.raycastFirst(down, THREE.DoubleSide);
  check(!!nowAt && Math.abs(nowAt.point.y - (wasAt!.point.y + RAISE)) < 1e-3,
    `and a cast from above lands ${RAISE} units higher, where the corner now is`);

  // What keeping it true costs, against the re-emit it rides on. Best of three batches: the claim below is
  // a ratio between two measurements taken seconds apart, and a single batch can lose to a GC pause or to
  // a neighbour in the suite landing on the same core (it did once in CI, by 4 ms). The minimum is the
  // cost both measurements share.
  const timed = (n: number, run: () => void): number => {
    run();
    let best = Infinity;
    for (let batch = 0; batch < 3; batch++) {
      const started = performance.now();
      for (let i = 0; i < n; i++) run();
      best = Math.min(best, (performance.now() - started) / n);
    }
    return best;
  };
  const dependency = patchDependency(preview.mesh, preview.adjacency);
  let step = 0;
  const nudge = () => {
    const held = getVertex(doc, corner);
    setVertex(doc, corner, [held[0], held[1] + (step++ % 2 ? 0.5 : -0.5), held[2]]);
    const moved = dependency.of(watcher.note(doc));
    refreshPreviewPatches(doc, preview, moved);
    return moved;
  };
  const spare = createTerrainLayer(stage, {} as TileMaterials,
    { shading: () => 'none', rigData: () => null, rigVisible: () => false }, { onGeometryRebuilt() {} },
    { pickTarget: false });
  spare.applyPreview(preview);
  const untreed = timed(100, () => {
    const moved = nudge();
    spare.updatePatches(moved, patchVertexSpans(moved, PATCH_VERTS), { geometry: true, materials: false });
  });
  const treed = timed(100, () => {
    const moved = nudge();
    layer.updatePatches(moved, patchVertexSpans(moved, PATCH_VERTS), { geometry: true, materials: false });
  });
  console.log(`\n    incremental update, no pick tree     ${untreed.toFixed(3)} ms`);
  console.log(`    ... with the pick tree kept true    ${treed.toFixed(3)} ms  (+${(treed - untreed).toFixed(3)} ms)\n`);
  check(treed - untreed < untreed,
    `keeping the tree true costs less than the update it rides on (+${(treed - untreed).toFixed(2)} ms)`);
}

console.log(failures ? '\nREBUILD: FAIL' : '\nREBUILD: PASS');
process.exit(failures ? 1 : 0);
