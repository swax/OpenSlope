/**
 * Run a real extracted level's AI field offline and report how the race actually went (docs/016, [Trailmap: 395]).
 *
 * `ai-rider.test.ts` drives the same controller over synthetic slopes, where every fixture is a shape somebody
 * chose. This is the other half: the mountain as shipped — its terrain, its AI network, its prop collision, its
 * MainType-0 boost volumes and its lap count — stepped at the ride's own 60 Hz with nothing rendered. It is what
 * answers questions a screenshot cannot: does the field take the finish tube, does it count MEGAPLEX's four
 * passes, does it chain through the network or strand itself, and where does it stop making progress.
 *
 * The world is assembled exactly as the editor assembles it for Play — same `createAiRiders`, same
 * `buildBoostVolumes`, same `referencePatchContact`, same chirality flip (`stage.worldRoot` mirrors Z) — so a
 * result here is a statement about the ride, not about a stand-in. The two knowing simplifications are named
 * where they are made: a mode-2 collider's box comes from the model's own geometry rather than from the rendered
 * instance tree, and nothing here animates, so a prop that moves during a run stands still.
 *
 * Run: npx tsx scripts/ai-course-run.ts [LEVEL] [seconds] [--riders N] [--trace] [--assert]
 *   npx tsx scripts/ai-course-run.ts MEGAPLE 240 --assert
 *   npx tsx scripts/ai-course-run.ts MEGAPLE 260 --no-rails   (the same race with the grind network removed)
 *   npx tsx scripts/ai-course-run.ts MEGAPLE 300 --watch 1 --from 120 --ticks 300   (one rider, tick by tick)
 */
import * as THREE from 'three';
import { createAiRiders, type AiPathDef } from '../src/app/ride/ai';
import { buildBoostVolumes, type BoostVolume, type BoostVolumeSpec } from '../src/app/ride/boost-volumes';
import { createGrindRails, type GrindRails } from '../src/app/ride/grind';
import { referencePatchContact } from '../src/app/ride/patch-contact';
import type { RideObstacleSource } from '../src/app/ride/physics';
import { boostVolumeSpec } from '../src/app/viewport/scene/reference-effects';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';
import { buildReferenceMesh, editorFromRaw, referenceSplineIsGrindRail } from '../src/core/reference/terrain';
import {
  attachedReferenceInstances, decodeReferenceEffects, referenceInstanceBindings,
} from '../src/core/reference/effects';
import { decodeProps, type PropInstance } from '../src/core/reference/props';
import { readReferenceEffects } from '../src/server/routes/effects';
import { modelLocalBox, readLevelProps } from '../src/server/routes/props';
import {
  readLevelAiPaths, readLevelCourse, readLevelLaps, readLevelPatches, readLevelSplines,
} from '../src/server/routes/levels';

// ---- arguments ---------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const LEVEL = positional[0] ?? 'MEGAPLE';
const SECONDS = Number(positional[1] ?? 240);
const RIDERS = option('riders', 6);
const TRACE = flag('trace');
const ASSERT = flag('assert');
const WATCH = option('watch', -1);
const NO_RAILS = flag('no-rails');
const WATCH_FROM = option('from', 0);
const WATCH_TICKS = option('ticks', 400);
let watched = 0;

const H = 1 / 60;
/** `stage.worldRoot` mirrors Z to the game's chirality; everything the ride touches rides that flip. */
const FLIP = new THREE.Matrix4().makeScale(1, 1, -1);
const toWorld = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(FLIP);
const fixed = (v: THREE.Vector3, n = 1) => `(${v.x.toFixed(n)}, ${v.y.toFixed(n)}, ${v.z.toFixed(n)})`;

let failures = 0;
const check = (ok: unknown, label: string, detail = '') => {
  if (ok) console.log(`ok    ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ---- the world, assembled the way Play assembles it --------------------------------------------------------

/** The level's prop colliders in ride world space — `reference-decor.rideColliders` without a scene. */
async function referenceColliders(level: string): Promise<RideObstacleSource[]> {
  const props = decodeProps(await readLevelProps(level));
  const out: RideObstacleSource[] = [];
  const geometryCache = new Map<string, THREE.BufferGeometry>();
  const boxGeo = new THREE.BoxGeometry(1, 1, 1); // the shared mode-2 unit box; the pose supplies centre + size
  const localBoxCache = new Map<number, THREE.Box3 | null>();

  const worldOf = (inst: PropInstance) => new THREE.Matrix4().multiplyMatrices(FLIP,
    new THREE.Matrix4().multiplyMatrices(RAW_TO_EDITOR, new THREE.Matrix4().compose(
      new THREE.Vector3(...inst.loc),
      new THREE.Quaternion(inst.rot[0], inst.rot[1], inst.rot[2], inst.rot[3]),
      new THREE.Vector3(...inst.scale))));

  const collisionGeometry = (id: string) => {
    const cached = geometryCache.get(id);
    if (cached) return cached;
    const source = props.collisionMeshes?.get(id);
    if (!source) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
    geometryCache.set(id, geometry);
    return geometry;
  };

  let unhandled = 0;
  for (const inst of props.instances) {
    if (inst.contact === 'ghost') continue;
    const world = worldOf(inst);
    const movable = Number.isFinite(inst.dynamicMass) && inst.dynamicMass > 0;
    const solid = inst.contact === 'solid';
    const common = {
      key: `reference:${inst.sourceIndex}`, object: { kind: 'reference' as const, index: inst.sourceIndex }, solid,
      bounce: solid ? (inst.bounce >= 0 ? inst.bounce : 0.5) : 0,
      playerBounce: inst.playerBounce,
      surface: solid ? inst.surface : -1,
      dynamicMass: movable ? inst.dynamicMass : 0,
    };
    if (inst.shape === 1) {
      let added = false;
      for (const id of inst.collisionModels ?? []) {
        const geometry = collisionGeometry(id);
        if (!geometry) continue;
        out.push({ ...common, geometry, matrixWorld: world.clone() });
        added = true;
      }
      if (added) continue;
    }
    if (inst.shape === 3 && inst.physicsBody >= 0) {
      const spheres = props.physicsBodies?.get(inst.physicsBody);
      if (spheres?.length) { out.push({ ...common, spheres, matrixWorld: world.clone() }); continue; }
    }
    if (inst.shape === 2) {
      // The editor unions the RENDERED instance tree's boxes; offline the model's own geometry box stands in.
      // Identical for the single-mesh props that carry mode 2, and it is the box the boost volumes read.
      if (!localBoxCache.has(inst.model)) {
        const lb = await modelLocalBox(level, inst.model);
        localBoxCache.set(inst.model, lb ? new THREE.Box3(new THREE.Vector3(...lb.min), new THREE.Vector3(...lb.max)) : null);
      }
      const local = localBoxCache.get(inst.model);
      if (!local) continue;
      const worldBox = local.clone().applyMatrix4(world);
      if (worldBox.isEmpty()) continue;
      out.push({ ...common, geometry: boxGeo,
        matrixWorld: new THREE.Matrix4().compose(worldBox.getCenter(new THREE.Vector3()),
          new THREE.Quaternion(), worldBox.getSize(new THREE.Vector3())) });
      continue;
    }
    unhandled++;
  }
  if (unhandled) console.log(`note: ${unhandled} non-ghost instances carry a shape this runner has no offline`
    + ' geometry for (the editor takes those from the rendered instance tree)');
  return out;
}

/**
 * The level's MainType-0 boost specs keyed the way `buildBoostVolumes` looks them up, plus the object keys of
 * its MainType-13 RESET volumes — the boundary an author drew around the run, and what carries a rider that
 * left it back onto the course ([Trailmap: 390-pickups-and-race]).
 */
async function referenceEffectVolumes(level: string):
Promise<{ boosts: Map<string, BoostVolumeSpec>; resets: Set<string> }> {
  const payload = await readReferenceEffects(level);
  if (payload.error) {
    console.log(`note: no effects for ${level} (${payload.error})`);
    return { boosts: new Map(), resets: new Set() };
  }
  const data = decodeReferenceEffects(payload);
  const specs = new Map<string, BoostVolumeSpec>();
  const resets = new Set<string>();
  // The two frame changes `boostVolumeSpec` asks for, as the reference host supplies them: a push axis is
  // authored in world space (raw→editor only), the lap-gated stage axis is turned by the host's own matrix.
  const worldMatrix = new THREE.Matrix4().multiplyMatrices(FLIP, RAW_TO_EDITOR);
  const worldBasis = new THREE.Matrix3().setFromMatrix4(worldMatrix);
  const world = (raw: THREE.Vector3) => raw.clone().applyMatrix3(worldBasis);
  // The same frame as a MATRIX rather than a basis, for the one field in the family that names a position:
  // the vertical lift's target altitude. A basis drops the translation, which is right for an axis and wrong
  // for a point.
  const worldPoint = (raw: THREE.Vector3) => raw.clone().applyMatrix4(worldMatrix);
  for (const instance of attachedReferenceInstances(data)) {
    const hostMatrix = new THREE.Matrix4().multiplyMatrices(FLIP,
      new THREE.Matrix4().multiplyMatrices(RAW_TO_EDITOR, new THREE.Matrix4().compose(
        new THREE.Vector3(...instance.loc),
        new THREE.Quaternion(instance.rot[0], instance.rot[1], instance.rot[2], instance.rot[3]),
        new THREE.Vector3(...instance.scale))));
    const hostBasis = new THREE.Matrix3().setFromMatrix4(hostMatrix);
    const hostLocal = (raw: THREE.Vector3) => raw.clone().applyMatrix3(hostBasis);
    for (const binding of referenceInstanceBindings(data, instance)) {
      if (binding.circumstance !== 'collision') continue;
      if (binding.graph.nodes.some(node => node.semanticType === 'rider.reset')) {
        resets.add(`reference:${instance.index}`);
      }
      for (const node of binding.graph.nodes) {
        const spec = boostVolumeSpec(node, world, hostLocal, worldPoint);
        if (spec) { specs.set(`reference:${instance.index}`, spec); break; }
      }
    }
  }
  return { boosts: specs, resets };
}

async function loadWorld(level: string) {
  const { patches } = await readLevelPatches(level);
  const rd = buildReferenceMesh(patches);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rd.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(rd.indices, 1));
  const terrain = new THREE.Mesh(geometry);
  // Under worldRoot in the editor; the flip has to be on the mesh's own matrix here, and physics reads
  // `matrixWorld` for every probe, so the two are the same world.
  terrain.scale.z = -1;
  terrain.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(terrain);

  const rawPaths = await readLevelAiPaths(level) ?? [];
  const paths: AiPathDef[] = rawPaths.map(p => ({
    rating: p.rating, respawnable: p.respawnable, markers: p.markers,
    points: p.points.map(toWorld),
  }));
  const gates = rawPaths.map((p, i) => (p.start ? i : -1)).filter(i => i >= 0).slice(0, 6);
  const courseFile = await readLevelCourse(level);
  const obstacles = await referenceColliders(level);
  const effects = await referenceEffectVolumes(level);
  const boostVolumes = buildBoostVolumes(obstacles, effects.boosts);

  return {
    terrain, box, rd, paths, rails: await grindRails(level),
    starts: gates.length ? gates : paths.slice(0, 6).map((_p, i) => i),
    course: (courseFile?.points ?? []).map(toWorld),
    finish: courseFile?.finish && courseFile.finishFwd
      ? { pos: toWorld(courseFile.finish), fwd: toWorld(courseFile.finishFwd).normalize() }
      : null,
    laps: await readLevelLaps(level),
    obstacles, boostVolumes, resetVolumes: effects.resets,
    surfaceOf: (faceIndex: number): number | null =>
      rd.patchSurf[Math.floor(faceIndex / rd.facesPerPatch)] ?? null,
    patchContact: referencePatchContact(rd) ?? undefined,
    oobFloorY: box.min.y - 100,
  };
}

/**
 * The level's ridable rail network, built the way the viewport builds it for Play.
 *
 * The field grinds what the player grinds (`ai.ts`), so a course with rails down its racing line is a different
 * race from the same course without them — which means a harness that quietly omits them reports a result about
 * a mountain nobody rides. The cubics come out of `Splines.json` in raw SSX space, through the same
 * `editorFromRaw` every reference dataset uses and then through the chirality flip, so the curve stepped here is
 * the curve the tubes are drawn along. Styles 13 (metal) and 12 (wood) are the grind network; style −1 motion
 * paths are effect routes and are deliberately not in it.
 *
 * `--no-rails` drops the network, which is how you measure what it is worth: run it both ways and read the
 * difference in the finish times.
 */
async function grindRails(level: string): Promise<{ net: GrindRails; count: number } | null> {
  if (NO_RAILS) return null;
  const raw = await readLevelSplines(level);
  if (!raw?.length) return null;
  const railsIn = raw
    .filter(referenceSplineIsGrindRail)
    .map(spline => ({
      surf: spline.style,
      // Retail Splines.json already carries the board/contact clearance above its paired prop art.
      seat: 0,
      segments: spline.segments
        .filter(seg => seg.length === 4)
        .map(seg => seg.map(p => toWorld(editorFromRaw(p))) as
          [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]),
    }))
    .filter(rail => rail.segments.length > 0);
  return railsIn.length ? { net: createGrindRails(railsIn), count: railsIn.length } : null;
}

// ---- the run -----------------------------------------------------------------------------------------------

const built = Date.now();
const world = await loadWorld(LEVEL);
console.log(`${LEVEL}: ${world.rd.patchCount} patches, ${world.paths.length} AI paths `
  + `(${world.starts.length} gates), ${world.obstacles.length} colliders, `
  + `${world.boostVolumes.length} boost volumes, ${world.resetVolumes.size} reset volumes, `
  + `${world.rails ? `${world.rails.count} grind rails` : NO_RAILS ? 'grind network OFF' : 'no grind rails'}, `
  + `${world.laps} lap(s), `
  + `course ${world.course.length} pts — loaded in ${((Date.now() - built) / 1000).toFixed(1)} s`);
if (world.boostVolumes.length) {
  const byKind = new Map<string, number>();
  for (const v of world.boostVolumes) byKind.set(v.spec.kind, (byKind.get(v.spec.kind) ?? 0) + 1);
  console.log(`  volumes: ${[...byKind].map(([k, n]) => `${n}×${k}`).join(', ')}`);
}
console.log(`  finish line ${world.finish ? fixed(world.finish.pos) : 'none (falls back to the course tail)'}; `
  + `course tail ${world.course.length ? fixed(world.course[world.course.length - 1]) : 'n/a'}`);

const field = createAiRiders({
  paths: world.paths, starts: world.starts.slice(0, RIDERS), course: world.course,
  terrain: world.terrain, scene: new THREE.Group(),
  surfaceOf: world.surfaceOf, patchContact: world.patchContact, oobFloorY: world.oobFloorY,
  obstacles: world.obstacles, boostVolumes: world.boostVolumes, resetVolumes: world.resetVolumes,
  rails: world.rails?.net,
  finish: world.finish, laps: world.laps,
  maxRiders: RIDERS,
  onLap: (slot, remaining) => console.log(`  [lap]  rider ${slot} crossed the finish — ${remaining} pass(es) left`),
});

/** Per-rider observation. The boost tallies are taken by testing the same boxes the runtime tests, so a zero
 *  here means the rider never physically entered the volume, not that the volume declined to act. */
const seen = Array.from({ length: field.count }, () => ({
  pathsVisited: new Set<number>(),
  volumeTicks: new Map<string, number>(),
  firstVolumeAt: new Map<string, number>(),
  maxY: -Infinity, minY: Infinity,
  travelled: 0,
  resets: 0,
  laps: 1,
  finishedAt: -1,
  last: new THREE.Vector3(),
}));
const volumeLabel = (v: BoostVolume) => `${v.spec.kind}:${v.key}`;

/** World AABBs of the prop colliders, for `--watch`: a rider that has stopped moving with a solid box around
 *  its ears is wedged on the level, which is a different fault from one that has simply lost its line. */
const colliderBoxes = WATCH >= 0 ? world.obstacles.flatMap(source => {
  if (!source.geometry) return [];
  source.geometry.computeBoundingBox();
  const box = source.geometry.boundingBox?.clone().applyMatrix4(source.matrixWorld);
  return box ? [{ key: source.key, solid: source.solid, box }] : [];
}) : [];

const start = field.probe();
for (let i = 0; i < start.length; i++) seen[i].last.copy(start[i].pos);
console.log(`\nrunning ${SECONDS} s at ${Math.round(1 / H)} Hz with ${field.count} riders…`);
const ran = Date.now();
let traceNext = 0;
for (let t = 0; t < SECONDS; t += H) {
  field.step(H);
  const probe = field.probe();
  for (let i = 0; i < probe.length; i++) {
    const r = probe[i], s = seen[i];
    s.pathsVisited.add(r.path);
    s.travelled += r.pos.distanceTo(s.last);
    s.last.copy(r.pos);
    s.maxY = Math.max(s.maxY, r.pos.y);
    s.minY = Math.min(s.minY, r.pos.y);
    s.resets = r.resets;
    s.laps = r.lap;
    if (r.finished && s.finishedAt < 0) {
      s.finishedAt = t;
      console.log(`  [race] rider ${i} finished all ${world.laps} laps at ${t.toFixed(1)} s`);
    }
    for (const v of world.boostVolumes) {
      if (!v.box.containsPoint(r.pos)) continue;
      const label = volumeLabel(v);
      if (!s.firstVolumeAt.has(label)) {
        s.firstVolumeAt.set(label, t);
        console.log(`  [vol]  rider ${i} entered ${label} at ${t.toFixed(1)} s, ${fixed(r.pos)}`);
      }
      s.volumeTicks.set(label, (s.volumeTicks.get(label) ?? 0) + 1);
    }
  }
  if (TRACE && t >= traceNext) {
    traceNext = t + 5;
    console.log(`  t=${t.toFixed(0).padStart(4)}s ` + probe.map((r, i) =>
      `#${i} p${r.path} y${r.pos.y.toFixed(0)} v${r.speed.toFixed(0)} lap${r.lap} ${r.state}`).join('  '));
  }
  // `--watch N [from] [ticks]`: one rider, every tick, with the volumes actually containing it. This is what
  // tells a stall apart from a bounce — a rider pinned on geometry reads `grounded` with the lift still acting.
  if (WATCH >= 0 && WATCH < probe.length && t >= WATCH_FROM && watched++ < WATCH_TICKS) {
    const r = probe[WATCH];
    const inside = world.boostVolumes.filter(v => v.box.containsPoint(r.pos)).map(volumeLabel);
    const near = colliderBoxes.filter(c => c.box.distanceToPoint(r.pos) < 1.5)
      .map(c => `${c.key}${c.solid ? '' : '~'}`);
    console.log(`  t=${t.toFixed(2)} #${WATCH} ${fixed(r.pos, 2)} vy=${r.velY.toFixed(2)} `
      + `|v|=${r.speed.toFixed(2)} ${r.grounded ? 'GROUND' : 'air'} air=${r.airTime.toFixed(2)} `
      + `p${r.path}@${((100 * r.arc) / r.total).toFixed(0)}% perp=${r.perp.toFixed(1)} `
      + `stick=${r.stick.toFixed(2)} ${r.state}${inside.length ? ` in[${inside.join(' ')}]` : ''}`
      + `${near.length ? ` near[${near.join(' ')}]` : ''}`);
  }
}
console.log(`…stepped ${(SECONDS / H).toFixed(0)} ticks in ${((Date.now() - ran) / 1000).toFixed(1)} s wall clock`);

// ---- the report --------------------------------------------------------------------------------------------
const final = field.probe();
console.log('');
for (let i = 0; i < final.length; i++) {
  const r = final[i], s = seen[i];
  console.log(`rider ${i}: lap ${r.lap}/${world.laps}${r.finished ? ' FINISHED' : ''}, `
    + `${s.travelled.toFixed(0)} m ridden, y ${s.minY.toFixed(0)}…${s.maxY.toFixed(0)}, `
    + `${s.pathsVisited.size} paths, ${s.resets} resets, now ${fixed(r.pos)} on path ${r.path} `
    + `(${((100 * r.arc) / r.total).toFixed(0)}% of it) at ${r.speed.toFixed(1)} m/s`);
  const volumes = [...s.volumeTicks].sort((a, b) => b[1] - a[1]);
  if (volumes.length) console.log(`         boost volumes: ${volumes.map(([k, n]) => `${k}×${n}t`).join(', ')}`);
  else console.log('         boost volumes: none entered');
}

const lapGated = world.boostVolumes.filter(v => v.spec.kind === 'lap-gated');
const enteredLapGate = seen.filter(s => [...s.volumeTicks.keys()].some(k => k.startsWith('lap-gated:'))).length;
const finishedAll = final.filter(r => r.finished).length;
const bestLap = Math.max(...final.map(r => r.lap));

if (ASSERT) {
  console.log('');
  check(world.boostVolumes.length > 0, 'the level resolves boost volumes at all',
    `${world.boostVolumes.length} built`);
  if (lapGated.length) {
    check(enteredLapGate > 0, 'a rider reaches the lap-gated volume',
      `${enteredLapGate}/${final.length} riders entered it`);
    check(bestLap > 1, 'the field starts a second lap', `best lap reached: ${bestLap} of ${world.laps}`);
  }
  if (world.laps > 1) {
    check(finishedAll > 0, `a rider completes all ${world.laps} laps`,
      `${finishedAll}/${final.length} finished`);
  }
  check(final.every(r => r.speed > 0.5 || r.finished), 'nobody is stationary at the end',
    final.map(r => r.speed.toFixed(1)).join(' / '));
  console.log(failures ? `\nAI COURSE RUN: ${failures} FAILED` : '\nAI COURSE RUN: PASS');
}
process.exit(ASSERT && failures ? 1 : 0);
