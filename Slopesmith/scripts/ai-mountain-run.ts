/**
 * Race an AUTHORED mountain's AI field offline and report how the run actually plays (docs/016, [Trailmap: 395]).
 *
 * `ai-course-run.ts` does this for an extracted retail level, where the terrain, the AI network and the boost
 * volumes all come off disc. This is the same instrument pointed at a course you are still designing: it opens a
 * workspace project, tessellates its quilt, derives the six gate lines the export would ship, and rides them at
 * the ride's own 60 Hz with nothing rendered.
 *
 * It exists because "is this course any good" is not a question a screenshot answers. Six riders taking the whole
 * run at once say where the field bunches, which pitch is so flat that everyone bogs, which turn nobody holds,
 * and whether the line is rideable end to end at all — and they say it in about as long as it takes to read the
 * output, which is the loop a shape/paint/ride iteration needs.
 *
 * The world is assembled exactly as the editor assembles it for Play — same `buildMountainPreview`, same
 * `createAiRiders`, same `authoredPatchContact`, same chirality flip (`stage.worldRoot` mirrors Z), and the
 * mountain's own placed props as ride obstacles — so a result here is a statement about the mountain, not
 * about a stand-in. `--no-props` rides the bare surface, which is the right comparison when the question is
 * whether the FURNITURE changed how the course plays.
 *
 * Run: npx tsx scripts/ai-mountain-run.ts [PROJECT] [seconds] [--riders N] [--zones] [--trace] [--assert]
 *   npm run run:mountain -- MY_PROJECT 240 --zones
 *   npx tsx scripts/ai-mountain-run.ts MY_PROJECT 240 --watch 2 --from 60 --ticks 300   (one rider, tick by tick)
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAiRiders, type AiPathDef } from '../src/app/ride/ai';
import { buildBoostVolumes } from '../src/app/ride/boost-volumes';
import { buildCrackedSurfaces } from '../src/app/ride/cracked-surfaces';
import { authoredPatchContact } from '../src/app/ride/patch-contact';
import type { RideObstacleSource } from '../src/app/ride/physics';
import { NATIVE_COLLISION_MODE } from '../src/core/collision/native';
import { nativeContactState } from '../src/core/collision/native';
import { AUTHORED_MODEL_LEVEL, authoredModelLevelProps } from '../src/core/doc/models';
import { clampEffectTriggerSize, isEffectTriggerProp } from '../src/core/effects/trigger-volume';
import { placementQuat } from '../src/core/props/pose';
import { expandGroupProps } from '../src/core/reference/groups';
import { groupDefIndex } from '../src/server/routes/groups';
import { readModelGeometries } from '../src/server/routes/props';
import { listImportedProps } from '../src/server/routes/imported-props';
import { IMPORTED_PROP_LEVEL } from '../src/core/props/imported';
import { aiLineRatings, aiPathLines, courseCenters, finishFrame, DEFAULT_AI_SEED } from '../src/core/doc/course';
import { migrateMountain } from '../src/core/doc/mountain';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import { sampleSpine, spineAt, totalLength } from '../src/core/math/spine';
import { DEFAULT_LAPS, normalizeLaps } from '../src/core/doc/race';
import type { PlacedProp, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { authoredEffectBindings, timerEmitterFields } from '../src/core/effects/authoring';
import type { EffectGraph, EffectNode, EffectsDocument } from '../src/core/effects/document';
import {
  effectConditionPasses, effectPlayCommand, runScheduledEffectGraphs, scheduleEffectGraph,
  type EffectGraphTask,
} from '../src/core/effects/play-runtime';
import { boostVolumeSpec, crackedSurfaceSpec } from '../src/app/viewport/scene/reference-effects';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';
import { listProjects, openProject } from '../src/server/projects';
import { migrateLegacyProjectAssets } from '../src/server/project-assets';
import { mapsRoot } from '../src/server/workspace-config';

// ---- arguments ---------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const PROJECT = positional[0] ?? '';
const SECONDS = Number(positional[1] ?? 300);
const RIDERS = option('riders', 6);
const ZONES = flag('zones');
const TRACE = flag('trace');
const ASSERT = flag('assert');
const AUTOTEST = flag('autotest');
const START = option('start', AUTOTEST ? 1 : 0);
const WATCH = option('watch', -1);
const WATCH_FROM = option('from', 0);
const WATCH_TICKS = option('ticks', 400);
let watched = 0;

const H = 1 / 60;
const COLLISION_DEBOUNCE = 50 / 60;
const MAX_GRAPH_DEPTH = 6;
/** `stage.worldRoot` mirrors Z to the game's chirality; everything the ride touches rides that flip. */
const flip = (p: V3) => new THREE.Vector3(p[0], p[1], -p[2]);
const fixed = (v: THREE.Vector3, n = 1) => `(${v.x.toFixed(n)}, ${v.y.toFixed(n)}, ${v.z.toFixed(n)})`;

let failures = 0;
const check = (ok: unknown, label: string, detail = '') => {
  if (ok) console.log(`ok    ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ---- the world, assembled the way Play assembles it --------------------------------------------------------

/** The named project's document, migrated the way the editor migrates it on open. */
async function loadDocument(name: string): Promise<{ doc: QuadMeshDoc; label: string }> {
  const projects = await listProjects();
  if (!projects.length) throw new Error('No projects in the workspace.');
  const wanted = name.trim().toUpperCase();
  const found = wanted
    ? projects.find(p => p.name.toUpperCase() === wanted)
      ?? projects.find(p => p.id.startsWith(name) || p.folder.toUpperCase().startsWith(wanted))
    : projects[0];
  if (!found) {
    throw new Error(`No project named ${name}. Have: ${projects.map(p => p.name).join(', ')}`);
  }
  const snapshot = await openProject(found.id);
  await migrateLegacyProjectAssets(snapshot);
  // This headless runner opens one mountain for its process lifetime, so its direct storage calls can use the
  // same explicit context seam as maintenance scripts that do not have an HTTP tab identity.
  process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = join(snapshot.project.folder, 'assets');
  return { doc: migrateMountain(snapshot.document), label: `${found.name} (${found.folder})` };
}

function loadWorld(doc: QuadMeshDoc) {
  const preview = buildMountainPreview(doc);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(preview.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(preview.indices, 1));
  const terrain = new THREE.Mesh(geometry);
  (terrain.material as THREE.Material).side = THREE.DoubleSide;
  // Under worldRoot in the editor; the flip has to be on the mesh's own matrix here, and physics reads
  // `matrixWorld` for every probe, so the two are the same world.
  terrain.scale.z = -1;
  terrain.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(terrain);

  const seed = doc.aiSeed ?? DEFAULT_AI_SEED;
  const ratings = aiLineRatings(doc.course, seed);
  // No jump markers: an authored mountain has no equivalent of the AIP's type-100 events, so its field never
  // ollies. Every derived line IS the course, so all of them are respawnable — same as the editor's Play.
  const paths: AiPathDef[] = aiPathLines(doc.course, seed).map((line, i) => ({
    rating: ratings[i] ?? 50, respawnable: true, points: line.map(flip),
  }));
  const finish = finishFrame(doc.course);

  return {
    preview, terrain, box, paths,
    starts: paths.map((_p, i) => i),
    course: courseCenters(doc.course).map(flip),
    finish: { pos: flip(finish.pos), fwd: flip(finish.fwd).normalize() },
    laps: normalizeLaps(doc.laps) ?? DEFAULT_LAPS,
    surfaceOf: (faceIndex: number): number | null =>
      preview.cellSurf[Math.floor(faceIndex / preview.facesPerCell)] ?? null,
    patchContact: authoredPatchContact(preview) ?? undefined,
    oobFloorY: box.min.y - 100,
  };
}

/**
 * The mountain's placed props, as ride obstacles.
 *
 * A placement renders through `compose(pos, rotation, scale) · RAW_TO_EDITOR` under `worldRoot`, so an
 * obstacle's world matrix here is that same product with the runner's Z flip in front of it — the identical
 * frame the terrain mesh is in. Model geometry stays model-local raw cm, exactly as the viewport's colliders
 * and the export's bake both keep it.
 *
 * Two knowing limits, both reported rather than hidden. A group placement is expanded to its members (docs/015)
 * because that is what the export writes. A mode-3 sphere-body placement is skipped: its shape lives in the
 * donor level's physics table rather than in the mesh, and borrowing it here would be a second implementation
 * of something Play already owns.
 */
async function loadObstacles(doc: QuadMeshDoc): Promise<{ sources: RideObstacleSource[]; skipped: number }> {
  const listed = doc.props ?? [];
  if (!listed.length) return { sources: [], skipped: 0 };
  const defs = await groupDefIndex(new Set(listed.flatMap(p => (p.group ? [p.level] : []))));
  const placements = listed.flatMap((prop, i) => {
    const def = prop.group ? defs.get(`${prop.level}:${prop.group}`) : undefined;
    return (def ? expandGroupProps(prop, def) : [prop]).map(member => ({ ...member, key: prop.id ?? `prop:${i}` }));
  });

  const wanted = new Map<string, Set<number>>();
  for (const prop of placements) {
    const found = wanted.get(prop.level) ?? new Set<number>();
    found.add(prop.model);
    wanted.set(prop.level, found);
  }
  const geometries = new Map<string, THREE.BufferGeometry>();

  // Authored models are what Play renders for the autotest gates. They already have a canonical conversion to
  // the same raw-cm LevelProps payload as borrowed/imported props; consume that conversion here so the offline
  // runner cannot drift onto a second interpretation of model anchors, winding, or units.
  for (const model of authoredModelLevelProps(doc).models) {
    const positions: number[] = [], indices: number[] = [];
    for (const sub of model.subs) {
      const base = positions.length / 3;
      for (const value of sub.positions) positions.push(value);
      for (const index of sub.indices) indices.push(base + index);
    }
    if (!indices.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometries.set(`${AUTHORED_MODEL_LEVEL}/${model.id}`, geometry);
  }

  /**
   * The course's OWN kit, which does not live in a donor level's `Meshes/` folder.
   *
   * An imported model is a record in the Custom bank with its geometry packed base64 in the same raw cm an
   * extracted mesh uses, so once it is unpacked it joins the same table and everything downstream is
   * identical. Without this branch every `@import` placement has no geometry, gets counted as skipped, and a
   * zone furnished entirely with authored props reports zero prop contacts because it loaded zero colliders —
   * a clean result that means nothing at all.
   */
  const importedIds = wanted.get(IMPORTED_PROP_LEVEL);
  if (importedIds?.size) {
    const f32 = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64');
      const out = new Float32Array(bytes.byteLength / 4);
      Buffer.from(out.buffer).set(bytes);
      return out;
    };
    const u32 = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64');
      const out = new Uint32Array(bytes.byteLength / 4);
      Buffer.from(out.buffer).set(bytes);
      return out;
    };
    for (const { record } of await listImportedProps()) {
      if (!importedIds.has(record.id)) continue;
      const positions: number[] = [], indices: number[] = [];
      for (const sub of record.subs) {
        const base = positions.length / 3;
        for (const v of f32(sub.pos)) positions.push(v);
        for (const i of u32(sub.idx)) indices.push(base + i);
      }
      if (!indices.length) continue;
      const buffer = new THREE.BufferGeometry();
      buffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      buffer.setIndex(indices);
      geometries.set(`${IMPORTED_PROP_LEVEL}/${record.id}`, buffer);
    }
    wanted.delete(IMPORTED_PROP_LEVEL);
  }

  for (const [level, ids] of wanted) {
    for (const [id, geom] of await readModelGeometries(level, ids)) {
      const positions: number[] = [], indices: number[] = [];
      for (const sub of geom.subs) {
        const base = positions.length / 3;
        for (const p of sub.positions) positions.push(p);
        for (const i of sub.indices) indices.push(base + i);
      }
      if (!indices.length) continue;
      const buffer = new THREE.BufferGeometry();
      buffer.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      buffer.setIndex(indices);
      geometries.set(`${level}/${id}`, buffer);
    }
  }

  const rawToEditor = new THREE.Matrix4().set(
    -0.01, 0, 0, 0,
    0, 0, 0.01, 0,
    0, -0.01, 0, 0,
    0, 0, 0, 1,
  );
  const zFlip = new THREE.Matrix4().makeScale(1, 1, -1);

  const sources: RideObstacleSource[] = [];
  let skipped = 0;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  for (const prop of placements) {
    const native = prop.nativeCollision;
    if (isEffectTriggerProp(prop)) {
      const size = clampEffectTriggerSize(prop.effectTrigger.size);
      const [qx, qy, qz, qw] = placementQuat(prop);
      const matrixWorld = new THREE.Matrix4().multiplyMatrices(zFlip,
        new THREE.Matrix4().compose(
          new THREE.Vector3(prop.pos[0], prop.pos[1], prop.pos[2]),
          new THREE.Quaternion(qx, qy, qz, qw),
          new THREE.Vector3(size[0] * prop.scale, size[1] * prop.scale, size[2] * prop.scale),
        ));
      sources.push({
        key: `authored:${prop.key}`, object: { kind: 'authored', id: prop.key },
        geometry: unitBox, matrixWorld, solid: false, bounce: 0, playerBounce: false, surface: -1,
      });
      continue;
    }
    const geometry = geometries.get(`${prop.level}/${prop.model}`);
    if (!geometry) { skipped++; continue; }
    const contact = native ? nativeContactState({
      visible: true, playerCollision: native.playerCollision, playerBounce: native.playerBounce,
      mode: native.mode, responseMass: native.responseMass,
      hasTriangleProxy: native.mode === NATIVE_COLLISION_MODE.triangleProxy,
      hasPhysicsBody: false,
    }) : 'solid';
    if (contact === 'none') continue;
    if (native?.mode === NATIVE_COLLISION_MODE.physicsBodySpheres) { skipped++; continue; }
    const [qx, qy, qz, qw] = placementQuat(prop);
    const pose = new THREE.Matrix4().compose(
      new THREE.Vector3(prop.pos[0], prop.pos[1], prop.pos[2]),
      new THREE.Quaternion(qx, qy, qz, qw),
      new THREE.Vector3(prop.scale, prop.scale, prop.scale),
    );
    const matrixWorld = new THREE.Matrix4().multiplyMatrices(zFlip, pose).multiply(rawToEditor);
    if (native?.mode === NATIVE_COLLISION_MODE.boundingBox) {
      const worldBox = new THREE.Box3()
        .setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute)
        .applyMatrix4(matrixWorld);
      sources.push({
        key: `authored:${prop.key}`, object: { kind: 'authored', id: prop.key }, geometry: unitBox,
        matrixWorld: new THREE.Matrix4().compose(worldBox.getCenter(new THREE.Vector3()), new THREE.Quaternion(),
          worldBox.getSize(new THREE.Vector3())),
        solid: contact === 'solid', bounce: native.playerBounce ? native.bounceAmount : 0,
        playerBounce: native.playerBounce, surface: typeof prop.surface === 'number' ? prop.surface : -1,
      });
      continue;
    }
    sources.push({
      key: `authored:${prop.key}`,
      object: { kind: 'authored', id: prop.key },
      geometry,
      matrixWorld,
      solid: contact === 'solid',
      bounce: native ? (native.playerBounce ? native.bounceAmount : 0) : (prop.bounce ?? 0.5),
      playerBounce: native?.playerBounce ?? true,
      surface: typeof prop.surface === 'number' ? prop.surface : -1,
    });
  }
  return { sources, skipped };
}

interface AutoTestRiderExpectation {
  signal: 'rise' | 'jump' | 'boost-request';
  atLeast?: number;
  atMost?: number;
}

interface AutoTestPlanEntry {
  id: string;
  propId: string;
  distanceM: number;
  expect?: 'dispatch' | 'no-dispatch' | null;
  expectPaint?: boolean;
  expectRider?: AutoTestRiderExpectation | null;
  expectSlot?: { atLeast?: number; atMost?: number } | null;
  contactOptional?: boolean;
  coveredBy?: string;
}

interface AutoTestPlan { name: string; entries: AutoTestPlanEntry[] }

interface AutoTestHost { prop: PlacedProp; document: EffectsDocument }
interface AutoTestMeta { subject: number; startedAt: number }
interface AutoTestResult {
  contact: boolean;
  exercised: boolean;
  dispatch: boolean;
  paint: boolean;
  firstAt: number;
  subject: number;
  baselineY: number;
  lastPosition: THREE.Vector3 | null;
  rise: number;
  jump: number;
  boostRequest: number;
}

function planFor(name: string): AutoTestPlan {
  return JSON.parse(readFileSync(join(mapsRoot(), name.toUpperCase(), 'autotest-plan.json'), 'utf8')) as AutoTestPlan;
}

/** Resolve the authored MainType-0 volume exactly as browser Play does, then let the normal ride model apply it. */
function authoredBoostVolumes(doc: QuadMeshDoc, obstacles: readonly RideObstacleSource[]) {
  const document = doc.effects as EffectsDocument | undefined;
  if (!document) return [];
  const specs = new Map<string, ReturnType<typeof boostVolumeSpec> extends infer T ? Exclude<T, null> : never>();
  const zFlip = new THREE.Matrix4().makeScale(1, 1, -1);
  const worldFrame = new THREE.Matrix4().multiplyMatrices(zFlip, RAW_TO_EDITOR);
  const worldBasis = new THREE.Matrix3().setFromMatrix4(worldFrame);
  for (const binding of authoredEffectBindings(document, doc.props ?? [])) {
    if (binding.circumstance !== 'collision' || !binding.prop.id) continue;
    const [qx, qy, qz, qw] = placementQuat(binding.prop);
    const pose = new THREE.Matrix4().compose(
      new THREE.Vector3(...binding.prop.pos), new THREE.Quaternion(qx, qy, qz, qw),
      new THREE.Vector3().setScalar(binding.prop.scale),
    );
    const localFrame = new THREE.Matrix4().multiplyMatrices(zFlip, pose).multiply(RAW_TO_EDITOR);
    const localBasis = new THREE.Matrix3().setFromMatrix4(localFrame);
    for (const node of binding.graph.nodes) {
      const spec = boostVolumeSpec(node,
        raw => raw.clone().applyMatrix3(worldBasis),
        raw => raw.clone().applyMatrix3(localBasis),
        raw => raw.clone().applyMatrix4(worldFrame));
      if (spec) { specs.set(`authored:${binding.prop.id}`, spec); break; }
    }
  }
  return buildBoostVolumes(obstacles, specs);
}

function authoredCrackedSurfaces(doc: QuadMeshDoc, obstacles: readonly RideObstacleSource[]) {
  const document = doc.effects as EffectsDocument | undefined;
  const specs = new Map<string, { strength: number; lifetimeSeconds: number }>();
  if (document) for (const binding of authoredEffectBindings(document, doc.props ?? [])) {
    if (binding.circumstance !== 'collision' || !binding.prop.id) continue;
    const spec = binding.graph.nodes.map(crackedSurfaceSpec).find(candidate => !!candidate);
    if (spec) specs.set(`authored:${binding.prop.id}`, spec);
  }
  return buildCrackedSurfaces(obstacles, specs);
}

// ---- the run -----------------------------------------------------------------------------------------------

const built = Date.now();
const { doc, label } = await loadDocument(PROJECT);
const world = loadWorld(doc);
const spine = sampleSpine(doc.course.knots);
const runLength = totalLength(spine);
const drop = Math.max(...doc.course.knots.map(k => k.pos[1])) - Math.min(...doc.course.knots.map(k => k.pos[1]));
const surfaceHistogram = new Map<number, number>();
for (const s of world.preview.cellSurf) surfaceHistogram.set(s, (surfaceHistogram.get(s) ?? 0) + 1);

console.log(`${label}: ${doc.quads.length} patches / ${doc.vertices.length / 3} points at ${doc.spacing} m, `
  + `run ${runLength.toFixed(0)} m over ${drop.toFixed(0)} m of drop, ${doc.course.knots.length} course points, `
  + `${world.paths.length} AI lines, ${world.laps} lap(s) — loaded in ${((Date.now() - built) / 1000).toFixed(1)} s`);
console.log(`  paint: ${[...surfaceHistogram].sort((a, b) => b[1] - a[1])
  .map(([type, n]) => `${n}×${type}`).join(', ')}`);
console.log(`  finish ${fixed(world.finish.pos)}; course tail `
  + `${world.course.length ? fixed(world.course[world.course.length - 1]) : 'n/a'}`);

const obstacles = flag('no-props') ? { sources: [], skipped: 0 } : await loadObstacles(doc);
if ((doc.props ?? []).length) {
  console.log(`  props: ${obstacles.sources.length} collider(s) from ${(doc.props ?? []).length} placement(s)`
    + `${obstacles.skipped ? `, ${obstacles.skipped} skipped (no mesh / sphere body)` : ''}`
    + `${flag('no-props') ? ' — DISABLED by --no-props' : ''}`);
}

const autoPlan = AUTOTEST ? planFor(PROJECT) : null;
const effectDocument = AUTOTEST ? doc.effects as EffectsDocument | undefined : undefined;
if (AUTOTEST && !effectDocument) throw new Error(`${PROJECT} has no authored effects document`);
const autoResults = new Map<string, AutoTestResult>((autoPlan?.entries ?? []).map(entry => [entry.propId, {
  contact: false, exercised: false, dispatch: false, paint: false, firstAt: -1, subject: -1, baselineY: 0,
  lastPosition: null, rise: 0, jump: 0, boostRequest: 0,
}]));
const authoredProps = doc.props ?? [];
const propById = new Map(authoredProps.filter(prop => !!prop.id).map(prop => [prop.id!, prop]));
const collisionBindings = new Map<string, { host: AutoTestHost; graph: EffectGraph; key: string }[]>();
const triggerBindings = new Map<string, { host: AutoTestHost; graph: EffectGraph }>();
const persistentBindings: { host: AutoTestHost; graph: EffectGraph }[] = [];
if (effectDocument) for (const binding of authoredEffectBindings(effectDocument, authoredProps)) {
  if (!binding.prop.id) continue;
  const resolved = { host: { prop: binding.prop, document: effectDocument }, graph: binding.graph,
    key: `${binding.prop.id}:${binding.slot.id}:${binding.circumstance}` };
  if (binding.circumstance === 'collision') {
    const list = collisionBindings.get(binding.prop.id) ?? [];
    list.push(resolved); collisionBindings.set(binding.prop.id, list);
  } else if (binding.circumstance === 'persistent') persistentBindings.push(resolved);
  else if (binding.circumstance === 'trigger') triggerBindings.set(binding.prop.id, resolved);
}
const scheduled: EffectGraphTask<AutoTestHost, AutoTestMeta>[] = [];
const collisionNext = new Map<string, number>();
const autoCounters = new Map<string, number>();
let autoElapsed = 0;
let autoDriveEntry: AutoTestPlanEntry | null = null;

function autoResult(propId: string): AutoTestResult | null {
  return autoResults.get(propId) ?? null;
}

function hostForInstance(document: EffectsDocument, stableId: string | null | undefined): AutoTestHost | null {
  const instance = stableId ? document.instances.find(candidate => candidate.id === stableId) : null;
  const extension = instance?.extensions?.slopesmith;
  const placement = extension && typeof extension === 'object' && !Array.isArray(extension)
    && typeof extension.placement === 'string' ? extension.placement : null;
  const prop = placement ? propById.get(placement) : null;
  return prop ? { prop, document } : null;
}

function markDispatch(host: AutoTestHost, meta: AutoTestMeta): void {
  if (!host.prop.id) return;
  const result = autoResult(host.prop.id);
  if (!result) return;
  result.dispatch = true;
  if (result.firstAt >= 0) return;
  const rider = field.probe()[meta.subject];
  result.firstAt = autoElapsed;
  result.subject = meta.subject;
  result.baselineY = rider?.pos.y ?? host.prop.pos[1];
  result.lastPosition = rider?.pos.clone() ?? null;
}

function executeAutoNode(host: AutoTestHost, node: EffectNode, depth: number, meta: AutoTestMeta): void {
  if (timerEmitterFields(node)) { markDispatch(host, meta); return; }
  // MainType-0/3/9 nodes install or control the host's native live node even when a graph deliberately carries
  // no particle marker (remote-hop companions and persistent clips are the two autotest cases).
  if (node.mainType === 0 || node.mainType === 3 || node.mainType === 9) markDispatch(host, meta);
  if (depth >= MAX_GRAPH_DEPTH) return;
  if (node.mainType === 7) {
    const target = hostForInstance(host.document, node.references?.instance);
    const graph = node.references?.effectGraph
      ? host.document.graphs.find(candidate => candidate.id === node.references!.effectGraph) : null;
    if (target && graph) scheduleEffectGraph(scheduled, target, graph, autoElapsed, depth + 1, meta);
    return;
  }
  if ((node.mainType === 21 || node.mainType === 26) && node.references?.function) {
    const fn = host.document.functions.find(candidate => candidate.id === node.references!.function);
    if (fn) scheduleEffectGraph(scheduled, host, fn, autoElapsed, depth + 1, meta);
    return;
  }
  if (node.semanticType === 'property.counter') {
    const type0 = node.payload.type0;
    const counter = type0 && typeof type0 === 'object' && !Array.isArray(type0)
      && type0.Counter && typeof type0.Counter === 'object' && !Array.isArray(type0.Counter)
      ? type0.Counter : null;
    const rawCount = counter ? (counter as Record<string, unknown>).Count : 0;
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 0;
    autoCounters.set(host.prop.id ?? '', Math.max(0, Math.trunc(count)));
  }
  if (node.semanticType === 'counter.mark' || node.semanticType === 'counter.decrement') {
    const key = host.prop.id ?? '';
    const remaining = Math.max(0, (autoCounters.get(key) ?? 0) - 1);
    autoCounters.set(key, remaining);
    const trigger = remaining === 0 ? triggerBindings.get(key) : null;
    if (trigger) scheduleEffectGraph(scheduled, trigger.host, trigger.graph, autoElapsed, depth + 1, meta);
  }
  const command = effectPlayCommand(node);
  if (!command) return;
  const result = host.prop.id ? autoResult(host.prop.id) : null;
  switch (command.kind) {
    case 'property-control':
      if (result) result.paint = true;
      return;
    case 'speed-boost': field.applyEffect(meta.subject, { kind: 'speed-boost', amount: command.amount }); return;
    case 'rider-reset': field.applyEffect(meta.subject, { kind: 'reset' }); return;
    case 'teleport': {
      const target = hostForInstance(host.document, command.instance);
      if (!target) return;
      const destination = flip(target.prop.pos).add(new THREE.Vector3(0, 0.5, 0));
      const heading = destination.clone().sub(flip(host.prop.pos)).setY(0);
      if (heading.lengthSq() < 1e-6) heading.set(0, 0, 1); else heading.normalize();
      field.applyEffect(meta.subject, { kind: 'teleport', position: destination, heading });
      return;
    }
    case 'trick-boost': case 'score-multiplier': case 'directional-boost':
    case 'instance-hide': case 'roller': case 'mesh-throw': case 'fence-flex': case 'flag-wave':
    case 'spline-motion': return;
  }
}

function onAutoCollision(slot: number, propId: string): void {
  autoResult(propId)!.contact = true;
  for (const binding of collisionBindings.get(propId) ?? []) {
    const nextKey = `${slot}:${binding.key}`;
    if (autoElapsed < (collisionNext.get(nextKey) ?? 0)) continue;
    collisionNext.set(nextKey, autoElapsed + COLLISION_DEBOUNCE);
    scheduleEffectGraph(scheduled, binding.host, binding.graph, autoElapsed, 0,
      { subject: slot, startedAt: autoElapsed });
  }
}

/** Prop contacts per rider — a rider who keeps hitting the same furniture is a placement fault, not a ride
 *  one, and it is the only signal that separates "the arrays gate the field" from "the arrays are scenery". */
const propHits = new Map<number, number>();
const boostVolumes = authoredBoostVolumes(doc, obstacles.sources);
const crackedSurfaces = authoredCrackedSurfaces(doc, obstacles.sources);
if (AUTOTEST) console.log(`  effects: ${boostVolumes.length} boost volume(s), ${crackedSurfaces.length} cracked surface(s)`);
if (AUTOTEST && TRACE) for (const surface of crackedSurfaces)
  console.log(`  cracked ${surface.key}: ${fixed(surface.box.min, 2)} .. ${fixed(surface.box.max, 2)}; `
    + `${surface.triangles.map(triangle => [triangle.a, triangle.b, triangle.c].map(point => fixed(point, 1)).join('/')).join(' ')}`);

const field = createAiRiders({
  paths: world.paths, starts: AUTOTEST ? [] : world.starts.slice(START, START + RIDERS), course: world.course,
  terrain: world.terrain, scene: new THREE.Group(),
  surfaceOf: world.surfaceOf, patchContact: world.patchContact, oobFloorY: world.oobFloorY,
  finish: world.finish, laps: world.laps,
  obstacles: obstacles.sources,
  boostVolumes,
  crackedSurfaces,
  onCrackedChange: (slot, key, cracked) => {
    const propId = key.startsWith('authored:') ? key.slice('authored:'.length) : '';
    if (cracked && propId === autoDriveEntry?.propId) onAutoCollision(slot, propId);
  },
  onCrackedBreak: (slot, key) => {
    if (!key.startsWith('authored:')) return;
    const propId = key.slice('authored:'.length);
    if (propId !== autoDriveEntry?.propId) return;
    const binding = triggerBindings.get(propId);
    if (binding) scheduleEffectGraph(scheduled, binding.host, binding.graph, autoElapsed, 0,
      { subject: slot, startedAt: autoElapsed });
  },
  onPropCollision: (slot, hit) => {
    propHits.set(slot, (propHits.get(slot) ?? 0) + 1);
    if (AUTOTEST && hit.object.kind === 'authored' && hit.object.id === autoDriveEntry?.propId)
      onAutoCollision(slot, hit.object.id);
  },
  maxRiders: AUTOTEST ? 1 : RIDERS,
  onLap: (slot, remaining) => console.log(`  [lap]  rider ${slot} crossed the finish — ${remaining} pass(es) left`),
});

if (AUTOTEST) for (const binding of persistentBindings)
  scheduleEffectGraph(scheduled, binding.host, binding.graph, 0, 0, { subject: 0, startedAt: 0 });

// A fixture is a catalogue of deliberately disruptive mechanisms (vertical throws, resets, teleports). Running
// it as one uninterrupted AI race lets an early test prevent every later test from being reached. Test mode's
// click-to-drop facility exists for exactly this authoring loop, so the parity pass drops one fresh production
// rider just upstream of each contact cell and gives that isolated cell twelve seconds to complete.
const autoDrive = (autoPlan?.entries ?? []).filter(entry => !entry.contactOptional);
let autoDriveIndex = 0;
autoDriveEntry = autoDrive[0] ?? null;
let autoNextDrop = 12;
let autoCellStarted = 0;
let autoAttempt = 0;
function pathApproach(path: readonly THREE.Vector3[], target: THREE.Vector3, before: number): {
  point: THREE.Vector3; heading: THREE.Vector3; distance: number;
} {
  let bestDistance = Infinity;
  const bestPoint = new THREE.Vector3(), bestHeading = new THREE.Vector3(0, 0, 1);
  const edge = new THREE.Vector3(), delta = new THREE.Vector3(), closestPoint = new THREE.Vector3();
  for (let i = 0; i + 1 < path.length; i++) {
    edge.subVectors(path[i + 1], path[i]);
    const denom = edge.x * edge.x + edge.z * edge.z;
    const u = denom > 1e-9 ? THREE.MathUtils.clamp(
      ((target.x - path[i].x) * edge.x + (target.z - path[i].z) * edge.z) / denom, 0, 1) : 0;
    closestPoint.lerpVectors(path[i], path[i + 1], u);
    delta.subVectors(target, closestPoint);
    const distance = delta.x * delta.x + delta.z * delta.z;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint.copy(closestPoint);
      bestHeading.copy(edge).normalize();
    }
  }
  const horizontal = bestHeading.clone().setY(0).normalize();
  const point = target.clone().addScaledVector(horizontal, -before);
  point.y = bestPoint.y;
  return { point, heading: bestHeading, distance: Math.sqrt(bestDistance) };
}
const autoTerrainRay = new THREE.Raycaster();
function terrainYAt(point: THREE.Vector3): number | null {
  autoTerrainRay.set(new THREE.Vector3(point.x, world.box.max.y + 100, point.z), new THREE.Vector3(0, -1, 0));
  return autoTerrainRay.intersectObject(world.terrain, false)[0]?.point.y ?? null;
}
function dropForAutoEntry(entry: AutoTestPlanEntry, attempt = 0): void {
  const prop = propById.get(entry.propId);
  if (!prop) throw new Error(`Could not resolve the Test host for ${entry.id}`);
  const source = obstacles.sources.find(candidate => candidate.object.kind === 'authored'
    && candidate.object.id === entry.propId);
  let target = flip(prop.pos);
  if (source?.geometry) {
    source.geometry.computeBoundingBox();
    const bounds = source.geometry.boundingBox?.clone().applyMatrix4(source.matrixWorld);
    if (bounds && !bounds.isEmpty()) target = bounds.getCenter(new THREE.Vector3());
  }
  // RideModel seats a warp one metre above the surface. At 20 m/s it falls that metre in roughly 0.32 s,
  // covering about 6.5 m; seven metres puts the first settled board contact on the centre of thin floor pads.
  const padLike = /pad|button|cracked/i.test(entry.id);
  const approaches = entry.expect === 'no-dispatch' ? [7]
    : triggerBindings.has(entry.propId) || padLike ? [2.5, 0, 7] : [0, 3, 7];
  const before = approaches[Math.min(attempt, approaches.length - 1)];
  const approach = world.paths.map(path => pathApproach(path.points, target, before))
    .sort((a, b) => a.distance - b.distance)[0];
  const terrainY = approach ? terrainYAt(approach.point) : null;
  if (approach) approach.point.y = (terrainY ?? approach.point.y) + 2;
  if (TRACE) console.log(`  [drop] ${entry.id} attempt ${attempt + 1}: target ${fixed(target, 2)}, `
    + `terrain ${terrainY?.toFixed(2) ?? 'n/a'}, start ${approach ? fixed(approach.point, 2) : 'n/a'}`);
  if (!approach || !field.spawnAt(approach.point, 20, approach.heading))
    throw new Error(`Could not drop the Test rider for ${entry.id}`);
}
if (autoDriveEntry) dropForAutoEntry(autoDriveEntry);

/**
 * Per-rider observation. `progress` is the arc length along the course ruler the standings sort on, so it is
 * also the honest measure of "did this rider get anywhere" — travelled distance counts a rider skating in a
 * circle at the bottom of a hole just as generously as one railing the fall line.
 */
const seen = Array.from({ length: field.count }, () => ({
  progress: 0,
  bestProgress: 0,
  stalledFor: 0,
  worstStall: 0,
  worstStallAt: 0,
  airTicks: 0,
  groundTicks: 0,
  speedSum: 0,
  maxSpeed: 0,
  resets: 0,
  /** Where each reset happened, as a percentage of the run — a rider put back on its line has left the course
   *  somewhere, and WHERE is the only part of that a designer can act on. */
  resetAt: [] as number[],
  finishedAt: -1,
  last: new THREE.Vector3(),
  travelled: 0,
}));

/** Course-station bins: what the field is doing at each stretch of the run. This is the readout a designer
 *  acts on — a bin where the mean speed collapses is a pitch too flat to carry, and one where nobody is on the
 *  ground is a gap somebody has to clear. */
const BINS = 40;
const bins = Array.from({ length: BINS }, () => ({ ticks: 0, speed: 0, air: 0, riders: new Set<number>() }));
const binAt = (progress: number) =>
  Math.max(0, Math.min(BINS - 1, Math.floor((progress / Math.max(1, runLength)) * BINS)));

/**
 * Did this rider get home?
 *
 * On a MULTI-lap course the ride model answers directly: `createLapCounter` exists, counts crossings and
 * latches `finished`. A single-pass course has no lap to count, so the model builds no counter at all and
 * nothing ever reports a finish — which is right for the game (the run simply ends) and useless here, where
 * "the whole field finished" is the headline result.
 *
 * So the crossing is tested here on the same terms `laps.ts` tests it: the plan-view plane through the finish
 * anchor, faced by the run's own heading there, entered from behind and within the same lateral half-width.
 * That half-width is 60 m, which is also a design constraint on the course — a finish apron wider than
 * ±60 m is one an AI rider can ride straight past.
 */
const FINISH_HALF_WIDTH = 60;
const finishSide = new THREE.Vector3(-world.finish.fwd.z, 0, world.finish.fwd.x);
const finishFwd = world.finish.fwd.clone().setY(0).normalize();
const offset = new THREE.Vector3();
function crossedFinish(pos: THREE.Vector3): boolean {
  offset.subVectors(pos, world.finish.pos);
  return offset.dot(finishFwd) > 0.5 && Math.abs(offset.dot(finishSide)) <= FINISH_HALF_WIDTH;
}

const start = field.probe();
for (let i = 0; i < start.length; i++) seen[i].last.copy(start[i].pos);
console.log(`\nrunning ${SECONDS} s at ${Math.round(1 / H)} Hz with ${field.count} riders…`);
const ran = Date.now();
let traceNext = 0;
for (let t = 0; t < SECONDS; t += H) {
  autoElapsed = t;
  if (AUTOTEST && t >= autoNextDrop && autoDriveIndex + 1 < autoDrive.length) {
    autoDriveEntry = autoDrive[++autoDriveIndex];
    autoCellStarted = t;
    autoAttempt = 0;
    dropForAutoEntry(autoDriveEntry, autoAttempt);
    autoNextDrop += 12;
  }
  if (AUTOTEST && autoDriveEntry && autoDriveEntry.expect !== 'no-dispatch' && autoAttempt < 2
      && t >= autoCellStarted + (autoAttempt + 1) * 4) {
    const result = autoResult(autoDriveEntry.propId)!;
    if (!result.dispatch) dropForAutoEntry(autoDriveEntry, ++autoAttempt);
    else autoAttempt = 2;
  }
  field.step(H);
  if (AUTOTEST) runScheduledEffectGraphs(scheduled, t, {
    condition: (_host, node, meta) => effectConditionPasses(node, {
      riderSpeed: field.probe()[meta.subject]?.speed ?? 0,
      // The deterministic test rider occupies the local player's role. This is what makes the human-only
      // fixture comparable to the single board the PS2 harness drives, even though its controller is AI.
      humanRider: true,
      random: () => 0.5,
      hostIdle: true,
    }),
    execute: executeAutoNode,
  });
  const probe = field.probe();
  if (AUTOTEST && autoDriveEntry && probe[0]?.progress >= autoDriveEntry.distanceM + 15)
    autoResult(autoDriveEntry.propId)!.exercised = true;
  if (AUTOTEST) for (const result of autoResults.values()) {
    if (result.firstAt < 0 || t - result.firstAt > 8) continue;
    const rider = probe[result.subject];
    if (!rider) continue;
    result.rise = Math.max(result.rise, rider.pos.y - result.baselineY);
    if (result.lastPosition) result.jump = Math.max(result.jump, rider.pos.distanceTo(result.lastPosition));
    result.lastPosition = rider.pos.clone();
    result.boostRequest = Math.max(result.boostRequest, rider.boostRequest);
  }
  for (let i = 0; i < probe.length; i++) {
    const r = probe[i], s = seen[i];
    const home = s.finishedAt >= 0 || r.finished || crossedFinish(r.pos);
    // Everything below is measured DURING the race. A rider that has taken the flag keeps riding — off the end
    // of the runout, usually, resetting all the way — and counting that would put its own drift into the run's
    // average speed and its post-race falls into the course's reset tally.
    //
    // A stall is progress that has stopped moving DOWN the course, which is what a flat spot, a bowl, or a wall
    // the field cannot climb all produce.
    if (!home) {
      s.progress = r.progress;
      s.travelled += r.pos.distanceTo(s.last);
      s.maxSpeed = Math.max(s.maxSpeed, r.speed);
      s.speedSum += r.speed;
      if (r.grounded) s.groundTicks++; else s.airTicks++;
      if (r.resets > s.resets) s.resetAt.push((100 * s.bestProgress) / runLength);
      if (r.progress > s.bestProgress + 0.5) { s.bestProgress = r.progress; s.stalledFor = 0; }
      else {
        s.stalledFor += H;
        if (s.stalledFor > s.worstStall) { s.worstStall = s.stalledFor; s.worstStallAt = s.bestProgress; }
      }
      const bin = bins[binAt(r.progress)];
      bin.ticks++; bin.speed += r.speed; bin.riders.add(i);
      if (!r.grounded) bin.air++;
    }
    s.last.copy(r.pos);
    s.resets = r.resets;
    if (home && s.finishedAt < 0) {
      s.finishedAt = t;
      console.log(`  [race] rider ${i} finished all ${world.laps} lap(s) at ${t.toFixed(1)} s`);
    }
  }
  if (TRACE && t >= traceNext) {
    traceNext = t + 5;
    console.log(`  t=${t.toFixed(0).padStart(4)}s ` + probe.map((r, i) =>
      `#${i} y${r.pos.y.toFixed(0)} v${r.speed.toFixed(0)} ${((100 * r.progress) / runLength).toFixed(0)}% ${r.state}`).join('  '));
  }
  if (WATCH >= 0 && WATCH < probe.length && t >= WATCH_FROM && watched++ < WATCH_TICKS) {
    const r = probe[WATCH];
    console.log(`  t=${t.toFixed(2)} #${WATCH} ${fixed(r.pos, 2)} vy=${r.velY.toFixed(2)} `
      + `|v|=${r.speed.toFixed(2)} ${r.grounded ? 'GROUND' : 'air'} air=${r.airTime.toFixed(2)} `
      + `course ${((100 * r.progress) / runLength).toFixed(1)}% perp=${r.perp.toFixed(1)} `
      + `stick=${r.stick.toFixed(2)} ${r.state}`);
  }
  if (!AUTOTEST && seen.every(s => s.finishedAt >= 0)) {
    console.log(`  [race] whole field home at ${t.toFixed(1)} s`);
    break;
  }
}
console.log(`…stepped in ${((Date.now() - ran) / 1000).toFixed(1)} s wall clock`);

// ---- the report --------------------------------------------------------------------------------------------

console.log('\nrider  finish   course   travelled  avg v  max v  air%  resets  hits  worst stall');
for (let i = 0; i < seen.length; i++) {
  const s = seen[i];
  const ticks = Math.max(1, s.airTicks + s.groundTicks);
  console.log(`  #${i}  `
    + `${s.finishedAt >= 0 ? `${s.finishedAt.toFixed(1)} s`.padStart(7) : '      —'}  `
    + `${`${((100 * s.progress) / runLength).toFixed(0)}%`.padStart(6)}  `
    + `${`${s.travelled.toFixed(0)} m`.padStart(9)}  `
    + `${(s.speedSum / ticks).toFixed(1).padStart(5)}  `
    + `${s.maxSpeed.toFixed(1).padStart(5)}  `
    + `${((100 * s.airTicks) / ticks).toFixed(0).padStart(4)}  `
    + `${String(s.resetAt.length).padStart(6)}  `
    + `${String(propHits.get(i) ?? 0).padStart(4)}  `
    + `${s.worstStall >= 1 ? `${s.worstStall.toFixed(1)} s at ${((100 * s.worstStallAt) / runLength).toFixed(0)}%` : '—'}`);
}
const allResets = seen.flatMap(s => s.resetAt).sort((a, b) => a - b);
if (allResets.length) {
  // Bucketed, because six riders leaving the course at the same place is a course fault and six leaving it at
  // six different places is just racing.
  const buckets = new Map<number, number>();
  for (const at of allResets) buckets.set(Math.round(at / 5) * 5, (buckets.get(Math.round(at / 5) * 5) ?? 0) + 1);
  console.log(`\n${allResets.length} reset(s) — riders put back on their line at: `
    + [...buckets].sort((a, b) => b[1] - a[1]).map(([at, n]) => `${at}%${n > 1 ? ` ×${n}` : ''}`).join(', '));
}

if (ZONES) {
  // Knot stations, so a bin can name the stretch of run it covers rather than a bare percentage.
  const knotStations: number[] = doc.course.knots.map((k, i) => {
    if (i === 0) return 0;
    let best = 0, bestD = Infinity;
    for (const s of spine) {
      const d = (s.pos[0] - k.pos[0]) ** 2 + (s.pos[2] - k.pos[2]) ** 2;
      if (d < bestD) { bestD = d; best = s.s; }
    }
    return best;
  });
  const knotAt = (station: number) => {
    let k = 0;
    while (k + 1 < knotStations.length && knotStations[k + 1] <= station) k++;
    return k;
  };
  console.log('\nstation      knots   riders  mean v   air%   grade');
  for (let b = 0; b < BINS; b++) {
    const bin = bins[b];
    const s0 = (b / BINS) * runLength, s1 = ((b + 1) / BINS) * runLength;
    const y0 = spineAt(spine, s0).pos[1], y1 = spineAt(spine, Math.min(s1, runLength)).pos[1];
    const grade = (Math.atan2(y0 - y1, Math.max(1, s1 - s0)) * 180) / Math.PI;
    const span = knotAt(s0) === knotAt(Math.min(s1, runLength) - 1)
      ? `${knotAt(s0)}` : `${knotAt(s0)}–${knotAt(Math.min(s1, runLength) - 1)}`;
    console.log(`${`${s0.toFixed(0)}–${s1.toFixed(0)} m`.padStart(12)}  ${span.padStart(6)}  `
      + `${String(bin.riders.size).padStart(6)}  `
      + `${(bin.ticks ? bin.speed / bin.ticks : 0).toFixed(1).padStart(6)}  `
      + `${(bin.ticks ? (100 * bin.air) / bin.ticks : 0).toFixed(0).padStart(5)}  `
      + `${grade.toFixed(0).padStart(5)}°`);
  }
}

if (AUTOTEST && autoPlan) {
  let passed = 0, mismatched = 0, open = 0, unsupported = 0;
  console.log('\nautotest parity (Slopesmith Test-run runtime vs PS2-proven plan)');
  for (const entry of autoPlan.entries) {
    const result = autoResults.get(entry.propId)!;
    const reached = result.contact || result.exercised || entry.contactOptional;
    const problems: string[] = [];
    if (entry.expect === 'dispatch' && !result.dispatch)
      problems.push(result.contact ? 'contacted but graph did not dispatch'
        : reached ? 'crossed without contact' : 'rider did not reach cell');
    if (entry.expect === 'no-dispatch' && result.dispatch) problems.push('dispatched unexpectedly');
    if (entry.expect === 'no-dispatch' && !reached) problems.push('negative was not exercised');
    if (entry.expectPaint && !result.paint) problems.push('texture/frame control did not run');
    const riderExpectation = entry.expectRider;
    if (riderExpectation) {
      const value = riderExpectation.signal === 'rise' ? result.rise
        : riderExpectation.signal === 'jump' ? result.jump : result.boostRequest;
      if (riderExpectation.atLeast !== undefined && value < riderExpectation.atLeast)
        problems.push(`${riderExpectation.signal} ${value.toFixed(2)} < ${riderExpectation.atLeast}`);
      if (riderExpectation.atMost !== undefined && value > riderExpectation.atMost)
        problems.push(`${riderExpectation.signal} ${value.toFixed(2)} > ${riderExpectation.atMost}`);
    }
    const observableProblems = problems.length;
    if (entry.expectSlot) {
      unsupported++;
      problems.push('slot-release/latch telemetry is not exposed by Test mode');
    }
    if (!entry.expect) {
      open++;
      console.log(`OPEN  ${entry.id.padEnd(26)} contact=${result.contact ? 'yes' : 'no'} dispatch=${result.dispatch ? 'yes' : 'no'}`);
      continue;
    }
    if (problems.length) {
      failures++;
      if (observableProblems) mismatched++;
      console.log(`${observableProblems ? 'FAIL ' : 'UNOBS'} ${entry.id.padEnd(26)} ${problems.join('; ')}`);
    } else {
      passed++;
      console.log(`ok    ${entry.id}`);
    }
  }
  console.log(`\n${autoPlan.name}: ${passed} matched, ${mismatched} observable mismatch(es), `
    + `${open} open question(s), ${unsupported} unsupported slot assertion(s)`);
  process.exit(failures ? 1 : 0);
}

if (ASSERT) {
  console.log('');
  const finished = seen.filter(s => s.finishedAt >= 0);
  const stalled = seen.filter(s => s.worstStall >= 8);
  const shortest = Math.min(...seen.map(s => s.progress));
  check(finished.length === seen.length, 'the whole field finishes',
    `${finished.length}/${seen.length} home; furthest-back rider reached ${((100 * shortest) / runLength).toFixed(0)}%`);
  check(!stalled.length, 'nobody stalls for 8 s',
    stalled.length ? `${stalled.length} rider(s), worst ${Math.max(...stalled.map(s => s.worstStall)).toFixed(1)} s` : 'clean');
  check(seen.every(s => s.resetAt.length <= 2), 'nobody is reset more than twice on their way down',
    `max ${Math.max(...seen.map(s => s.resetAt.length))}`);
  if (obstacles.sources.length) {
    // Furniture the field cannot avoid. A stray brush is racing; a rider grinding along a row of arrays every
    // run is a placement standing inside a corridor nobody can steer out of.
    const worst = Math.max(0, ...[...propHits.values()]);
    check(worst <= 10, 'nobody is fighting the furniture',
      `${[...propHits.values()].reduce((n, v) => n + v, 0)} prop contact(s) across the field, worst rider ${worst}`);
  }
  if (finished.length) {
    const times = finished.map(s => s.finishedAt).sort((a, b) => a - b);
    check(times[times.length - 1] - times[0] < times[0] * 0.6, 'the field arrives together',
      `${times[0].toFixed(1)} s to ${times[times.length - 1].toFixed(1)} s`);
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
