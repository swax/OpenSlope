/**
 * Effect-attachment wiring checks for the ISO path (docs/026): the export writes the attachment→instance
 * join the packer compiles — `extensions.slopesmith.bakedGroups` in Effects.json maps each placement's
 * stable id to the `o <group>` names it baked as in Props.obj — and the authored-model bake keeps the
 * retail winding convention (front = ∂u×∂v → raw +Z out of a front-up sheet) while warning on a placement
 * that bakes mostly front-down (the PS2 lights props with clamped directional keys, so a down-front sheet
 * renders ambient-only near-black; the double-sided viewport can't show that). Run: tsx test/effects-wiring.test.ts
 *
 * Writes one zz-test tile under an isolated mountain asset root and a scratch export folder under the OS temp
 * dir; both are removed afterwards.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUSTOM_TEX_LEVEL, saveCustomTexture } from '../src/server/routes/textures';
import { exportLevel } from '../src/server/routes/export';
import { bakeGltf, runSnowknife } from '../scripts/snowknife-cli';
import { createMaterialCombiner } from '../src/server/routes/props';
import {
  bakeAuthoredModelProps, bakeEffectTriggerProps, placementMatrix, placementSimilarity,
} from '../src/core/export/props';
import { buildCanonicalProps } from '../src/core/export/canonical-props';
import { encodePng } from '../src/server/routes/png';
import { defaultMountain } from '../src/core/doc/mountain';
import { AUTHORED_MODEL_LEVEL } from '../src/core/doc/models';
import {
  EFFECT_TRIGGER_COLLISION_STATE, EFFECT_TRIGGER_LEVEL, effectTriggerContactState, ensureEffectTriggerProps,
} from '../src/core/effects/trigger-volume';
import {
  addEffectTemplateToProp, authoredPropHasEffectCircumstance, authoredPropTextureFlip,
  bindEffectSplineToMotionPath, createEmptyEffectsDocument, effectNode, timerEmitterFields,
} from '../src/core/effects/authoring';
import { NATIVE_COLLISION_MODE, nativeContactState } from '../src/core/collision/native';
import type { AuthoredModel, PlacedProp } from '../src/core/doc/types';
import { check, failures } from './check';

/** One flat unit quad; stored [O, +Z, +X, diag] is the FRONT-UP encoding (the orientation oracle in
 *  core/mesh/tessellation: that stored order tessellates with the ride normal +Y). */
const ribbon = (quads: number[][]): AuthoredModel => ({
  id: 'model:0000', name: 'zzribbon', anchor: [0.5, 0, 0.5],
  vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1],
  quads, texture: null,
} as unknown as AuthoredModel);

const placement = (id: string): PlacedProp => ({
  id, level: AUTHORED_MODEL_LEVEL, model: 0, name: 'zzribbon', pos: [0, 0, 0], yaw: 0, scale: 1,
});

/** Net raw-space face normal of one OBJ group's triangles. */
function netNormal(obj: string, group: string): [number, number, number] {
  const V: number[][] = []; let cur: string | null = null; let nx = 0, ny = 0, nz = 0;
  for (const raw of obj.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('o ')) cur = line.slice(2).trim();
    else if (line.startsWith('v ')) V.push(line.split(/\s+/).slice(1).map(Number));
    else if (line.startsWith('f ') && cur === group) {
      const [a, b, c] = line.split(/\s+/).slice(1).map(t => parseInt(t.split('/')[0]) - 1);
      const [A, B, C] = [V[a], V[b], V[c]];
      const [ux, uy, uz] = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const [wx, wy, wz] = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      nx += uy * wz - uz * wy; ny += uz * wx - ux * wz; nz += ux * wy - uy * wx;
    }
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

const assetRoot = mkdtempSync(join(tmpdir(), 'slopesmith-effect-assets-'));
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = assetRoot;
const customDir = join(assetRoot, 'textures');
const hadDirBefore = existsSync(customDir);
const written: string[] = [];
let outDir: string | null = null;

try {
  // --- model bake: winding convention + bakedGroups + the front-down warning -----------------------
  const up = bakeAuthoredModelProps([placement('prop:0000')], [ribbon([[0, 2, 1, 3]])], 0, 0, await createMaterialCombiner());
  const upN = netNormal(up.obj, 'Model_0_zzribbon');
  check(upN[2] > 0.99, `front-up model bakes raw +Z out (net z ${upN[2].toFixed(3)} — the retail prop convention)`);
  check(up.warnings.length === 0, 'front-up model bakes without warnings');
  check(JSON.stringify(up.bakedGroups) === '{"prop:0000":["Model_0_zzribbon"]}',
    'bakedGroups joins the placement stable id to its baked group name');

  const down = bakeAuthoredModelProps([placement('prop:0000')], [ribbon([[2, 0, 3, 1]])], 0, 0, await createMaterialCombiner());
  const downN = netNormal(down.obj, 'Model_0_zzribbon');
  check(downN[2] < -0.99, `flipped model bakes raw -Z (net z ${downN[2].toFixed(3)})`);
  check(down.warnings.length === 1 && down.warnings[0].includes('FRONT-DOWN'),
    'a mostly-front-down placement raises the ambient-only lighting warning');

  // --- the bake is always a single sheet: the game lights it once from its vertex normals and shows that
  // same shading from either side (no cull, no per-side re-light — retail fences/leaves are single sheets)
  check((down.obj.match(/^f /gm) ?? []).length === 2, 'a quad bakes ONE sheet (two triangles, no duplicate shell)');

  const alphaCombiner = await createMaterialCombiner();
  const alphaRibbon = { ...ribbon([[0, 2, 1, 3]]), texture: 'Custom/zz-alpha-ribbon.png', blend: true };
  bakeAuthoredModelProps([placement('prop:0000')], [alphaRibbon], 0, 0, alphaCombiner);
  check(alphaCombiner.materials.length === 1 && (alphaCombiner.materials[0].UnknownInt18 & 0x40000) !== 0,
    'an authored model alpha pass survives into the native material appearance word');

  // A spline mover is a special native host: the route node applies position/orientation but ignores the
  // source instance's Rotation and Scale. Canonical export therefore keeps only its pivot on the instance and
  // bakes the placement basis into the model mesh. This is also the contract Unity's mover diversion consumes.
  const moverId = 'prop:mover';
  const moverPlacement: PlacedProp = {
    ...placement(moverId), pos: [2, 3, 4], yaw: 180, scale: 3,
  };
  const moverBake = bakeAuthoredModelProps([moverPlacement], [ribbon([[0, 2, 1, 3]])], 0, 0,
    await createMaterialCombiner());
  const moverEffects = createEmptyEffectsDocument('ZZMOVER');
  addEffectTemplateToProp(moverEffects, moverId, 'spline-animation');
  const moverCanonical = buildCanonicalProps(moverBake.groups, {
    bakedGroups: moverBake.bakedGroups,
    propClips: {},
    propPoses: { [moverId]: placementSimilarity(placementMatrix(moverPlacement)) },
    collisionSounds: {}, collisionSoundClips: {}, ambientSounds: {}, propBounce: {}, propSurfaces: {},
    propModePresence: {}, nativeCollisions: {}, propLighting: {}, effects: moverEffects,
  });
  const moverInstances = JSON.parse(moverCanonical.text['Instances.json']).Instances;
  const moverModels = JSON.parse(moverCanonical.text['Models.json']).Models;
  const moverInstance = moverInstances[0];
  const moverMeshPath = moverModels[0].ModelObjects[0].MeshData[0].MeshPath;
  const moverVertices = moverCanonical.text[`Meshes/${moverMeshPath}`].split('\n')
    .filter(line => line.startsWith('v ')).map(line => line.split(/\s+/).slice(1).map(Number));
  const moverSpan = (axis: number) => Math.max(...moverVertices.map(v => v[axis]))
    - Math.min(...moverVertices.map(v => v[axis]));
  check(JSON.stringify(moverInstance.Location) === '[-200,-400,300]'
    && JSON.stringify(moverInstance.Rotation) === '[0,0,0,1]'
    && JSON.stringify(moverInstance.Scale) === '[1,1,1]' && moverInstance.Visable === false,
  'a spline mover instance carries only its authored pivot (identity rotation/scale, hidden host)');
  check(Math.abs(moverSpan(0) - 300) < 1e-6 && Math.abs(moverSpan(1) - 300) < 1e-6,
    'a spline mover keeps its 3x authored size and lead basis baked into model-local geometry');

  // A SCALED placement's triangle proxy ships at world size. The instance Scale reaches the renderer and not
  // the collision proxy, so a proxy localized like the render mesh is the authored 1x shape sitting inside
  // art many times its size — the rider crosses the art and misses the volume. Retail never exercises the
  // other reading: across eight shipped levels every one of its 10,126 mode-1 proxies is on an unscaled
  // instance, and the 22 scaled instances it does ship are modes 0/2/3.
  const scaledProp: PlacedProp = { ...placement('prop:scaled'), pos: [5, 0, 5], scale: 4, solid: true };
  const scaledBake = bakeAuthoredModelProps([scaledProp], [ribbon([[0, 2, 1, 3]])], 0, 0,
    await createMaterialCombiner());
  const scaledCanonical = buildCanonicalProps(scaledBake.groups, {
    bakedGroups: scaledBake.bakedGroups, propClips: {},
    propPoses: { [scaledProp.id!]: placementSimilarity(placementMatrix(scaledProp)) },
    collisionSounds: {}, collisionSoundClips: {}, ambientSounds: {}, propBounce: {}, propSurfaces: {},
    propModePresence: { [scaledProp.id!]: 'showoff' }, nativeCollisions: {}, propLighting: {}, effects: null,
  });
  const span = (obj: string, axis: number) => {
    const v = obj.split('\n').filter(l => l.startsWith('v ')).map(l => Number(l.split(/\s+/)[axis + 1]));
    return Math.max(...v) - Math.min(...v);
  };
  const scaledInstance = JSON.parse(scaledCanonical.text['Instances.json']).Instances[0];
  const proxy = Object.entries(scaledCanonical.text).find(([name]) => name.startsWith('Collision/'))?.[1] ?? '';
  const render = Object.entries(scaledCanonical.text).find(([name]) => name.startsWith('Meshes/'))?.[1] ?? '';
  check(JSON.stringify(scaledInstance.Scale) === '[4,4,4]' && scaledInstance.CollsionMode === 1
    && scaledInstance.CollsionModelPaths.length === 1 && scaledInstance.LTGState === 2,
  'a scaled Showoff-only placement ships its authored scale, triangle proxy, and validated GemIndex state');
  check(Math.abs(span(render, 0) - 100) < 1e-3,
    'the render mesh stays model-local — the instance Scale expands it');
  check(Math.abs(span(proxy, 0) - 400) < 1e-3,
    'the collision proxy ships at WORLD size, so contact matches the art the rider can see');

  const triggerProp: PlacedProp = { id: 'trigger:0000', level: EFFECT_TRIGGER_LEVEL, model: 0, name: 'Start fireworks',
    pos: [10, 20, 30], yaw: 90, scale: 2, effectTrigger: { size: [12, 6, 8] } };
  const emptyMountain: { props?: PlacedProp[] } = {};
  ensureEffectTriggerProps(emptyMountain).push(triggerProp);
  check(emptyMountain.props?.[0] === triggerProp,
    'adding the first effect trigger persists the mountain prop array before its attachment validates');
  const triggerBake = bakeEffectTriggerProps([triggerProp]);
  check(triggerBake.baked === 1 && (triggerBake.obj.match(/^f /gm) ?? []).length === 12,
    'effect trigger bakes a closed twelve-triangle contact box');
  check(JSON.stringify(triggerBake.bakedGroups) === '{"trigger:0000":["EffectTrigger_0_Startfireworks"]}',
    'effect trigger stable ID joins to its trigger-specific packed group');
  check(JSON.stringify(Object.values(NATIVE_COLLISION_MODE)) === '[0,1,2,3]',
    'native collision modes have one named shared ordering');
  check(effectTriggerContactState(true) === 'through' && effectTriggerContactState(false) === 'none',
    'an attached trigger is pass-through while a detached trigger has no contact shape');
  check(nativeContactState({ ...EFFECT_TRIGGER_COLLISION_STATE,
    mode: NATIVE_COLLISION_MODE.physicsBodySpheres, hasTriangleProxy: false, hasPhysicsBody: false }) === 'none',
  'physics-body mode without a body cannot create contact');
  check(nativeContactState({ ...EFFECT_TRIGGER_COLLISION_STATE,
    mode: NATIVE_COLLISION_MODE.physicsBodySpheres, hasTriangleProxy: false, hasPhysicsBody: true }) === 'through',
  'a physics-body shape preserves the trigger\'s exact-zero pass-through response');

  // --- export seam: the attachment join + scroll dialect land in the written folder ----------------
  const makeTile = async (name: string, fill: number) => {
    const saved = await saveCustomTexture(name,
      encodePng({ w: 8, h: 8, data: new Uint8Array(8 * 8 * 4).fill(fill) }));
    written.push(saved);
    return saved;
  };
  const tile = await makeTile('zz-test-wiring.png', 200);
  // Two state pairs: one animated by an always-on flip, one switched by a ride-over button. They take
  // separate tiles because a material's frame list is part of its identity — sharing one would put both
  // relationships on a single combined slot, which is the aliasing the export warns about.
  const signRest = await makeTile('zz-test-sign-a.png', 40);
  const signFrame = await makeTile('zz-test-sign-b.png', 90);
  const buttonRest = await makeTile('zz-test-button-a.png', 140);
  const buttonFrame = await makeTile('zz-test-button-b.png', 190);
  /** A model whose tile carries a two-state flipbook. What plays it — if anything — is the effect. */
  const stateModel = (id: string, name: string, rest: string, frame: string): AuthoredModel => ({
    ...ribbon([[0, 2, 1, 3]]), id, name,
    texture: `${CUSTOM_TEX_LEVEL}/${rest}`,
    frames: [`${CUSTOM_TEX_LEVEL}/${rest}`, `${CUSTOM_TEX_LEVEL}/${frame}`],
  } as unknown as AuthoredModel);

  const doc = defaultMountain() as unknown as Record<string, unknown>;
  doc.name = 'ZZWIRE';
  doc.models = [
    { ...ribbon([[0, 2, 1, 3]]), texture: `${CUSTOM_TEX_LEVEL}/${tile}` },
    stateModel('model:0001', 'zzsign', signRest, signFrame),
    stateModel('model:0002', 'zzbutton', buttonRest, buttonFrame),
  ];
  doc.props = [{
    ...placement('prop:0000'), pos: [2, 3, 4], solid: true, bounce: 0, surface: 12,
    collisionSound: 1, ambientSound: 1, ambientRadius: 35,
  }, triggerProp,
  { ...placement('prop:0001'), model: 1, name: 'zzsign', pos: [8, 0, 8] },
  { ...placement('prop:0002'), model: 2, name: 'zzbutton', pos: [12, 0, 12] }];
  doc.rails = [{ id: 'path:0000', kind: 'motion', name: 'Mover route', height: 0,
    nodes: [[0, 1, 0], [12, 3, 18], [28, 2, 35]] },
  // A rail waiting for a toggle to switch it in: the whole difference on disc is its style, so it has to
  // survive the export as a wood rail that the rail query cannot find (docs/026).
  { id: 'rail:0000', kind: 'grind', name: 'Fallen trunk', height: 0, style: 12, startsOff: true,
    nodes: [[40, 1, 0], [52, 1, 6]] },
  // The grind and the pipe are unrelated records on disc, so a rail can ship as the spline alone, laid along
  // scenery that already has the shape. It must reach Splines.json with an ordinary grind row all the same.
  { id: 'rail:0001', kind: 'grind', name: 'Trunk line', height: 0, bare: true,
    nodes: [[60, 1, 0], [72, 1, 6]] },
  // Authored ice is native style 5, whose retail candidacy is name-aware. Deliberately omit "Rail" from the
  // user-facing name: export must add the native signal rather than letting a rename drop the grind.
  { id: 'rail:0002', kind: 'grind', name: 'Frozen ledge', height: 0, style: 5, bare: true,
    nodes: [[80, 1, 0], [92, 1, 6]] }];
  const effects = createEmptyEffectsDocument('ZZWIRE');
  const uvSelection = addEffectTemplateToProp(effects, 'prop:0000', 'uv-scroll');
  const uvNode = effectNode(effects, uvSelection);
  if (uvNode) uvNode.payload = { type0: { SubType: 10, UVScroll: {
    U0: 2, U1: -0.004, U2: 0, U3: 0.5, U4: 1.5, U5: 8,
  } } };
  addEffectTemplateToProp(effects, 'prop:0000', 'roller');
  const mover = addEffectTemplateToProp(effects, 'prop:0000', 'spline-animation');
  bindEffectSplineToMotionPath(effects, mover, doc.rails as never, 'path:0000');
  addEffectTemplateToProp(effects, 'trigger:0000', 'collision-trigger');
  const emitter = addEffectTemplateToProp(effects, 'trigger:0000', 'timer-emitter');
  const emitterFields = timerEmitterFields(effectNode(effects, emitter)!);
  if (emitterFields) { emitterFields.U18 = 100; emitterFields.U19 = 0; emitterFields.U20 = 0; }
  addEffectTemplateToProp(effects, 'trigger:0000', 'speed-boost');
  // The two relationships a frame list can have to an effect: a persistent flip cycles it forever, a
  // ride-over button's collision one-shot pulses it and settles back. Only the first is an animation.
  addEffectTemplateToProp(effects, 'prop:0001', 'texture-flip');
  addEffectTemplateToProp(effects, 'prop:0002', 'ride-over-button');
  check(authoredPropTextureFlip(effects, 'prop:0001')?.speed === 3.5,
    'a persistent flip resolves as the placement’s free-running rate');
  check(authoredPropTextureFlip(effects, 'prop:0002') === null,
    'a button’s finite-lifetime flip is a triggered pulse, not a rate — it never becomes a flipbook');
  check(authoredPropHasEffectCircumstance(effects, 'trigger:0000', 'collision'),
    'Play-mode contact recognizes the trigger slot’s resolved collision graph');
  check(!authoredPropHasEffectCircumstance(effects, 'missing:0000', 'collision'),
    'an unattached prop does not acquire a pass-through Play collider');
  doc.effects = effects;

  outDir = mkdtempSync(join(tmpdir(), 'slopesmith-wiring-'));
  const result = await exportLevel(doc as never, { outDir, lighting: false });
  const fx = JSON.parse(readFileSync(join(outDir, 'Effects.json'), 'utf8'));
  const ext = fx.extensions?.slopesmith ?? {};
  check(Array.isArray(ext.attachments) && ext.attachments.length === 4,
    'export keeps every authored attachment: the prop, the trigger, the flipbook sign and the button');
  check(fx.splines?.[0]?.id === 'spline:path:0000' && fx.splines[0].originalIndex === 0
    && fx.graphs?.some((graph: { nodes?: { references?: { spline?: string } }[] }) =>
      graph.nodes?.some(node => node.references?.spline === 'spline:path:0000')),
    'export refreshes the spline mover’s stable route resource and compact native index');
  const splines = JSON.parse(readFileSync(join(outDir, 'Splines.json'), 'utf8'));
  check(splines.Splines?.[0]?.SplineName === 'Mover route' && splines.Splines[0].Segments.length === 2
    && splines.Splines[0].U0 === -1 && splines.Splines[0].U1 === -2
    && splines.Splines[0].SplineStyle === -1,
    'the motion route ships in the matching native non-grind Splines.json slot');
  check(splines.Splines?.[1]?.SplineName === 'Fallen trunk'
    && splines.Splines[1].U0 === 1 && splines.Splines[1].U1 === 1
    && splines.Splines[1].SplineStyle === 1,
    'a rail authored to start off ships at the non-grind style, keeping the grind row that the toggle switches');
  check(splines.Splines?.[2]?.SplineName === 'Trunk line'
    && splines.Splines[2].U0 === 1 && splines.Splines[2].U1 === 1
    && splines.Splines[2].SplineStyle === 13,
    'a rail drawn with no pipe still ships the ordinary grind row — the spline IS the rail');
  check(splines.Splines?.[3]?.SplineName === 'IceRail_Frozen ledge'
    && splines.Splines[3].U0 === 1 && splines.Splines[3].U1 === 1
    && splines.Splines[3].SplineStyle === 5,
    'an authored ice rail keeps style 5 and a native Rail name even when its display name does not');
  check(JSON.stringify(ext.bakedGroups?.['prop:0000']) === '["ModelSolid_0_zzribbon"]',
    'export writes extensions.slopesmith.bakedGroups (the packer’s attachment→instance join)');
  check(JSON.stringify(ext.bakedGroups?.['trigger:0000']) === '["EffectTrigger_0_Startfireworks"]',
    'export joins the trigger collision slot to its invisible packed box');
  check(JSON.stringify(ext.propPivots?.['prop:0000']) === '[-200,-400,300]',
    'export writes the authored placement pivot in raw SSX centimetres for model-local effect packing');
  check(JSON.stringify(ext.propPivots?.['trigger:0000']) === '[-1000,-3000,2000]',
    'export writes an invisible trigger pivot for native model-local particle placement');
  check(JSON.stringify(ext.propPoses?.['trigger:0000']?.origin) === '[-1000,-3000,2000]'
    && Math.abs(ext.propPoses['trigger:0000'].rotation[2] + Math.SQRT1_2) < 1e-6
    && Math.abs(ext.propPoses['trigger:0000'].rotation[3] - Math.SQRT1_2) < 1e-6
    && Math.abs(ext.propPoses['trigger:0000'].scale - 2) < 1e-6,
  'export writes the full raw placement similarity used by model-local emitter vectors');
  check(ext.collisionSounds?.['prop:0000'] === 1,
    'export writes the authored hit-sound event join');
  check(ext.propBounce?.['prop:0000'] === 0 && ext.propSurfaces?.['prop:0000'] === 12,
    'export preserves slide plus the authored ride-surface type');
  // The join carries the region in the metres it was AUTHORED in; the metre→centimetre conversion and the
  // editor→native axis reorder both happen once, where the native record is stamped (external-sound.test.ts
  // pins that contract, including the ellipsoid case this sphere cannot expose).
  check(ext.ambientSounds?.['prop:0000']?.event === 1 && ext.ambientSounds?.['prop:0000']?.radius === 35,
    'export writes the positional ambient event and its authored metre radius');
  // …and the record that actually ships is still native: type 0, centimetres, the curve beside it.
  const ambientInstance = (JSON.parse(readFileSync(join(outDir, 'Instances.json'), 'utf8')).Instances as {
    InstanceName?: string; Sounds?: { ExternalSounds?: Record<string, number>[] };
  }[]).find(inst => inst.InstanceName === 'ModelSolid_0_zzribbon');
  const ambientRecord = ambientInstance?.Sounds?.ExternalSounds?.[0];
  check(!!ambientRecord && ambientRecord.U0 === 0 && ambientRecord.SoundIndex === 1
    && ambientRecord.U5 === 3500 && ambientRecord.U6 === 2,
    'the shipped ExternalSounds record is a type-0 point in centimetres on the linear curve');
  const obj = readFileSync(join(outDir, 'Props.obj'), 'utf8');
  // The `inst<n>` half of the join is POSITIONAL over the whole bake, so it is matched loosely: the ordinal
  // is a fact about how many props precede this one, not about the join itself.
  check(/^o inst\d+_ModelSolid_0_zzribbon$/m.test(obj),
    'the placement bakes into Props.obj under the canonical instance/group join');
  check(/^o inst\d+_EffectTrigger_0_Startfireworks$/m.test(obj),
    'the authored trigger box bakes under the canonical invisible-trigger instance join');
  // Rail index 1 is the only one of the three curves that owns a tube. The motion path never had one, and
  // rail 2 declined its own — and "starts off" is a style swap, so rail 1's tube ships regardless.
  check(/^o inst\d+_Rail_1_Fallentrunk$/m.test(obj) && !/_Rail_0_/.test(obj) && !/_Rail_2_/.test(obj)
    && !obj.includes('RailSolid_'),
    'only the piped rail bakes scenery: a motion path and a bare rail ship as spline data alone');
  check(/usemtl mat_\d+_scr0\b/.test(obj), 'the scrolled model wears the _scr tag beside its material slot');
  const scroll = JSON.parse(readFileSync(join(outDir, 'Scroll.json'), 'utf8'));
  check(scroll.Speeds?.length === 1
    && JSON.stringify(scroll.Speeds[0]) === '{"U":-0.004,"V":0,"Mode":2,"ActiveDuration":0.5,"PauseDuration":1.5,"Lifetime":8}',
    'Scroll.json carries the complete native constant-speed ping-pong profile');
  // Flip.json is the free-running set, in the same per-MaterialID dialect PropsExporter writes from a retail
  // level — the table a consumer needs because the frame list alone says nothing about playback.
  const materials = JSON.parse(readFileSync(join(outDir, 'Materials.json'), 'utf8')).Materials;
  const flip = JSON.parse(readFileSync(join(outDir, 'Flip.json'), 'utf8'));
  check(flip.Materials?.length === 1 && flip.Materials[0].Speed === 3.5 && flip.Materials[0].U4 === 0,
    'Flip.json publishes the authored rate for exactly the one free-running material');
  check(materials[flip.Materials?.[0]?.Id]?.TextureFlipbook?.length === 2,
    'the flipped id names a material that actually carries a state list');
  const buttonMaterial = materials.findIndex((item: { TextureFlipbook?: string[]; TexturePath?: string }) =>
    item.TextureFlipbook?.length === 2 && item.TexturePath?.includes('button'));
  check(buttonMaterial >= 0 && !flip.Materials.some((item: { Id: number }) => item.Id === buttonMaterial),
    'the button’s state pair ships its frames but stays out of Flip.json, so nothing free-runs it');
  check(result.log.includes('effect attachment join'), 'the export log reports the attachment join');
  const canonicalFiles = ['Instances.json', 'Models.json', 'Materials.json', 'Props.obj', 'PropsCollision.obj'];
  const canonicalManifest = JSON.parse(readFileSync(join(outDir, 'Slopesmith.json'), 'utf8'));
  check(canonicalFiles.every(name => existsSync(join(outDir!, name)))
    && readdirSync(join(outDir, 'Meshes')).some(name => name.endsWith('.obj'))
    && canonicalManifest.props?.format === 'ssx-native-map-v1'
    && canonicalManifest.canonical?.models > 0,
  'SlopeSmith export directly writes the extracted Instances/Models/Meshes contract');
  const digest = () => {
    const paths = [...canonicalFiles,
      ...readdirSync(join(outDir!, 'Meshes')).sort().map(name => `Meshes/${name}`),
      ...readdirSync(join(outDir!, 'Collision')).sort().map(name => `Collision/${name}`)];
    return createHash('sha256').update(paths.map(name => readFileSync(join(outDir!, name)))
      .reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0))).digest('hex');
  };
  const canonicalBefore = digest();
  await exportLevel(doc as never, { outDir, lighting: false });
  check(digest() === canonicalBefore,
    're-exporting the same document produces identical canonical prop tables and meshes');
  const bake = bakeGltf(outDir, 'ZZWIRE');
  if (bake?.status !== 0) console.error(`${bake?.stdout ?? 'no snowknife binary'}${bake?.stderr ?? ''}${bake?.error ?? ''}`);
  check(bake?.status === 0, 'the canonical SlopeSmith fixture completes the real snowknife glTF bake');
  const manifest = bake?.status === 0
    ? JSON.parse(readFileSync(join(outDir, 'gltf', 'manifest.json'), 'utf8')) : {};
  const scrollMaterial = manifest.Materials?.find((item: { Scroll?: number[] }) => Array.isArray(item.Scroll));
  check(Math.abs((scrollMaterial?.Scroll?.[0] ?? 0) - -0.24) < 1e-6 && scrollMaterial?.Scroll?.[1] === 0
    && JSON.stringify(scrollMaterial?.ScrollCycle) === '[2,0.5,1.5,8]',
    'the bundle scales the rate to units/second and preserves mode, active/pause timing, and lifetime for Unity');
  const flipMaterial = manifest.Materials?.find((item: { FlipFps?: number }) => (item.FlipFps ?? 0) > 0);
  check(flipMaterial?.FlipFps === 3.5 && flipMaterial?.Flipbook?.length === 2 && !flipMaterial?.Dwell,
    'the bundle animates the authored flipbook at the authored fps, so Unity registers it with the animator');
  const pulsed = manifest.Materials?.find((item: { Flipbook?: string[]; Texture?: string }) =>
    item.Flipbook?.length === 2 && item.Texture?.includes('button'));
  check(pulsed && (pulsed.FlipFps ?? 0) === 0,
    'the button’s material keeps its frames as STATES: the bundle gives it no rate to free-run');
  const button = manifest.Props?.Diverted?.find((item: { Kind?: string }) => item.Kind === 'button');
  check(button?.PulseFrames?.length >= 2 && button?.PulseFrames?.[0] === 1
    && button?.PulseHolds?.length === button?.PulseFrames?.length && button?.Triggers?.length === 1,
  'an authored ride-over button diverts with the replayed pulse and its own crossing volume');
  const rollerBody = manifest.Props?.Diverted?.find((item: { Kind?: string }) => item.Kind === 'physics');
  check(rollerBody?.DynamicMass === 5,
    'an authored Roller diverts the custom prop through the shared Unity physics path');
  const staticColliderCount = (manifest.Collision?.Buckets ?? []).reduce(
    (sum: number, item: { InstanceCount?: number }) => sum + (item.InstanceCount ?? 0), 0)
    + (manifest.Collision?.ComputedBounds?.length ?? 0);
  check(staticColliderCount === 0,
    'the authored Roller body is excluded from static collision instead of leaving a duplicate wall');
  check(manifest.Emitters?.Emitters?.length === 1,
    'a persistent particle effect attached to an authored trigger survives into manifest.Emitters');
  const emitterLayer = manifest.Emitters?.Emitters?.[0]?.Layers?.[0];
  check(Math.abs(emitterLayer?.VelocityBase?.[0] ?? 0) < 1e-4
    && Math.abs((emitterLayer?.VelocityBase?.[1] ?? 0) + 200) < 1e-4
    && Math.abs(emitterLayer?.VelocityBase?.[2] ?? 0) < 1e-4,
  'the bundle rotates and scales an authored emitter vector through the exported placement pose');
  check(manifest.BoostPads?.Pads?.length === 1 && manifest.BoostPads.Pads[0].Name.startsWith('EffectTrigger_')
    && manifest.BoostPads.Pads[0].Value === 5,
    'an invisible authored trigger carrying a speed boost survives into manifest.BoostPads');
  const mismatch = structuredClone(fx);
  const particleNode = mismatch.graphs
    .flatMap((graph: { nodes?: Record<string, unknown>[] }) => graph.nodes ?? [])
    .find((node: Record<string, unknown>) => node.semanticType === 'particle.timer');
  if (particleNode) particleNode.semanticType = 'trick.boost';
  const mismatchPath = join(outDir, 'Effects-semantic-mismatch.json');
  writeFileSync(mismatchPath, JSON.stringify(mismatch));
  const checker = runSnowknife(['effects-check', mismatchPath], 30_000);
  if (!particleNode || checker?.status === 0 || !`${checker?.stdout}${checker?.stderr}`.includes('is incompatible'))
    console.error(`effects-check diagnostic (status ${checker?.status ?? 'none'}):\n${checker?.stdout ?? ''}${checker?.stderr ?? ''}${checker?.error ?? ''}`);
  check(!!particleNode && checker?.status !== 0 && `${checker?.stdout}${checker?.stderr}`.includes('is incompatible'),
    'Snowknife rejects a canonical semanticType that does not match the native opcode');

  const rawCollision = structuredClone(fx);
  rawCollision.extensions.slopesmith.nativeCollisions = {
    'prop:0000': {
      mode: 1, playerCollision: true, u0: 1e30, playerBounce: true, bounceAmount: 0.5,
      transform: { location: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
  };
  const rawCollisionPath = join(outDir, 'Effects-raw-collision-u0.json');
  writeFileSync(rawCollisionPath, JSON.stringify(rawCollision));
  const rawChecker = runSnowknife(['effects-check', rawCollisionPath], 30_000);
  check(rawChecker?.status !== 0,
    'Snowknife rejects the retired authored collision u0 alias');
} finally {
  for (const name of written) rmSync(join(customDir, name), { force: true });
  if (!hadDirBefore && existsSync(customDir) && readdirSync(customDir).length === 0)
    rmSync(customDir, { recursive: true, force: true });
  rmSync(assetRoot, { recursive: true, force: true });
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('effects-wiring: all checks passed');
