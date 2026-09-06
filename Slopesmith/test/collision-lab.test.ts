import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLISION_LAB_BOUNCE_COLUMN, COLLISION_LAB_CASES, COLLISION_LAB_MODE1_BOUNCE_OFF_CASE,
  COLLISION_LAB_ORACLE_COLUMN, COLLISION_LAB_TARGET, collisionLabMountain,
} from '../src/core/collision/lab';
import {
  AUTO_TEST_COLLISION_CASES, AUTO_TEST_COLLISION_NAME, autoTestFixture, autoTestMountain,
} from '../src/core/collision/autotest';
import { nativeContactState } from '../src/core/collision/native';
import { addEffectTemplateToProp, effectAttachments, effectNode, timerEmitterFields } from '../src/core/effects/authoring';
import { emitterColorStopsFromNativeArgb } from '../src/core/effects/emitter-colors';
import { surfaceHeightAt, surfaceSampleAt } from '../src/core/mesh/surface-height';
import { exportLevel } from '../src/server/routes/export';
import { bakeGltf } from '../scripts/snowknife-cli';

const lab = collisionLabMountain();
assert.equal(lab.name, 'COLLISION_LAB');
assert.equal(lab.props?.length, 29,
  'the lab has the historical matrix/follow-up, six downhill oracle cases, and six bounce calibrators');
assert.equal(new Set(lab.props!.map(prop => prop.id)).size, 29, 'every case has a stable unique prop id');
assert.ok(lab.props!.every(prop => {
  const ground = surfaceHeightAt(lab, prop.pos[0], prop.pos[2]);
  return ground !== null && Math.abs((prop.pos[1] - ground) - 1.3501688) < 1e-6;
}), 'every crash bag is seated by the source model base offset instead of half-buried at its origin');

const migrated = autoTestFixture(AUTO_TEST_COLLISION_NAME);
assert.equal(migrated.cases, AUTO_TEST_COLLISION_CASES,
  'AUTOTEST7 resolves to the migrated collision matrix rather than a copied fixture');
assert.equal(migrated.cases.length, 17,
  'the machine fixture carries all sixteen historical cells and the mode-1 bounce-off follow-up');
const sourceProfiles = [...COLLISION_LAB_CASES.flat(), COLLISION_LAB_MODE1_BOUNCE_OFF_CASE]
  .map(test => JSON.stringify(test.profile)).sort();
assert.deepEqual(migrated.cases.map(test => JSON.stringify(test.profile)).sort(), sourceProfiles,
  'the automated matrix reuses every exact hand-ridden collision profile once');
assert.equal(migrated.cases.filter(test => test.expect === 'no-dispatch').length, 2,
  'mode 0 and PlayerCollision-off preserve the two no-contact expectations');
assert.equal(migrated.cases.filter(test => test.expectRider?.[0]?.signal === 'impact').length, 15,
  'every contactable cell grades physical response independently of dispatch');
assert.ok(migrated.cases.every(test => test.scale === undefined),
  'the machine fixture retains the original hand-ridden scale-1 crash-bag shape');
const { doc: migratedDoc, plan: migratedPlan } = autoTestMountain({
  name: migrated.name, cases: migrated.cases, mode: migrated.mode,
  windowFrames: migrated.windowFrames,
});
assert.equal(migratedPlan.entries.length, 17, 'all migrated cells survive into the machine-readable plan');
assert.equal(migratedPlan.windowFrames, 4800,
  'the plan owns the bounded observation window needed to finish cleanly after every response');
assert.equal(migratedPlan.hudText, true,
  'the plan tells the runner that AUTOTEST7 requires the Show Message executable patch');
const stageMessages = migratedDoc!.effects!.graphs.flatMap(graph => graph.nodes)
  .filter(node => node.mainType === 12).map(node => node.payload.HudText);
assert.deepEqual(stageMessages, migrated.cases.map((test, index) =>
  `${index + 1}/${migrated.cases.length} ${test.stageMessage}`),
  'every historical specimen gets its original label from an independent Show Message node');
assert.equal(migratedDoc!.props!.filter(prop => prop.id?.endsWith(':stage')
  && prop.level === '@effects' && prop.effectTrigger).length, 17,
  'every label is fired by a hidden pass-through stage trigger, including the two no-contact controls');
assert.deepEqual(migratedPlan.entries.map(entry => entry.id), migrated.cases.map(test => test.id),
  'plan order is stable, with pass-through controls ahead of the solid-response cells');
assert.equal(effectAttachments(lab.effects!).length, 29, 'every case owns its visible collision marker');
assert.ok(effectAttachments(lab.effects!).every(attachment => attachment.circumstance === 'collision'),
  'every diagnostic marker is dispatched by exact collision contact');

const mode3 = lab.props!.filter(prop => prop.nativeCollision?.mode === 3);
assert.equal(mode3.length, 4);
assert.ok(mode3.every(prop => prop.nativeCollision?.physicsSource?.level === COLLISION_LAB_TARGET
  && prop.nativeCollision.physicsSource.body === 7), 'all mode-3 cases reuse one exact GARI sphere tree');

const mode1Finite = lab.props!.find(prop => prop.name === 'M1 response mass=0.2 glass')!.nativeCollision!;
assert.equal(nativeContactState({ visible: true, ...mode1Finite, responseMass: mode1Finite.responseMass,
  hasTriangleProxy: true, hasPhysicsBody: false }), 'solid',
  'nonzero response mass plus PlayerBounce admits the solid rider response');
const mode3Zero = lab.props!.find(prop => prop.name === 'M3 response mass=0 path-marker value')!.nativeCollision!;
assert.equal(nativeContactState({ visible: true, ...mode3Zero, responseMass: mode3Zero.responseMass,
  hasTriangleProxy: false, hasPhysicsBody: true }), 'through', 'exact-zero stays massless across shape modes');
const mode3Finite = lab.props!.find(prop => prop.name === 'M3 response mass=5 crash-bag value')!.nativeCollision!;
assert.equal(nativeContactState({ visible: true, ...mode3Finite, responseMass: mode3Finite.responseMass,
  hasTriangleProxy: false, hasPhysicsBody: true }), 'solid',
  'finite response mass plus PlayerBounce does not by itself activate body dynamics');
const mode3Pinned = lab.props!.find(prop => prop.name === 'M3 response mass=1e30')!.nativeCollision!;
assert.equal(nativeContactState({ visible: true, ...mode3Pinned, responseMass: mode3Pinned.responseMass,
  hasTriangleProxy: false, hasPhysicsBody: true }), 'solid', 'the huge nonzero uses the common solid response');
const bounceOff = lab.props!.find(prop => prop.name === 'CONTROL mode2 bounce off')!.nativeCollision!;
assert.equal(nativeContactState({ visible: true, ...bounceOff, responseMass: bounceOff.responseMass,
  hasTriangleProxy: false, hasPhysicsBody: false }), 'through',
'PlayerBounce-off preserves the mode-2 contact while suppressing its physical response');
const mode1BounceOff = lab.props!.find(prop => prop.name === COLLISION_LAB_MODE1_BOUNCE_OFF_CASE.label)!.nativeCollision!;
assert.equal(nativeContactState({ visible: true, ...mode1BounceOff, responseMass: mode1BounceOff.responseMass,
  hasTriangleProxy: true, hasPhysicsBody: false }), 'through',
'the live-confirmed mode-1 PlayerBounce-off cell preserves contact while suppressing physical response');

const oracleProps = COLLISION_LAB_ORACLE_COLUMN.map(test =>
  lab.props!.find(prop => prop.name === test.label)!);
assert.ok(oracleProps.every(Boolean), 'all six oracle cases are present');
assert.deepEqual(oracleProps.map(prop => prop.id), [
  'collision-lab:17', 'collision-lab:18', 'collision-lab:19',
  'collision-lab:20', 'collision-lab:21', 'collision-lab:22',
], 'the added column preserves every historical fixture id');
const oracleAxis = [
  oracleProps[oracleProps.length - 1].pos[0] - oracleProps[0].pos[0],
  oracleProps[oracleProps.length - 1].pos[2] - oracleProps[0].pos[2],
];
assert.ok(oracleProps.every(prop => Math.abs(
  (prop.pos[0] - oracleProps[0].pos[0]) * oracleAxis[1]
  - (prop.pos[2] - oracleProps[0].pos[2]) * oracleAxis[0]) < 1e-6),
'all six oracle cases form one straight downhill column');
const oracleLength = Math.hypot(oracleAxis[0], oracleAxis[1]);
const oracleDown = [oracleAxis[0] / oracleLength, oracleAxis[1] / oracleLength];
const oracleSide = [-oracleDown[1], oracleDown[0]];
let minimumSpacing = Number.POSITIVE_INFINITY;
for (let a = 0; a < lab.props!.length; a++) for (let b = a + 1; b < lab.props!.length; b++)
  minimumSpacing = Math.min(minimumSpacing, Math.hypot(
    lab.props![a].pos[0] - lab.props![b].pos[0], lab.props![a].pos[2] - lab.props![b].pos[2]));
assert.ok(minimumSpacing >= 40,
  `every fixture has at least 40 m of horizontal separation (minimum ${minimumSpacing.toFixed(2)} m)`);
assert.ok(lab.props!.every(prop => [-4, 0, 4].every(along => [-4, 0, 4].every(across =>
  surfaceSampleAt(lab,
    prop.pos[0] + oracleDown[0] * along + oracleSide[0] * across,
    prop.pos[2] + oracleDown[1] * along + oracleSide[1] * across)?.surface === 1))),
'a full eight-metre footprint around every lab box stays on rideable snow');
assert.ok(oracleProps.every(prop => [-4, 0, 4].every(along => [-4, 0, 4].every(across =>
  surfaceSampleAt(lab,
    prop.pos[0] + oracleDown[0] * along + oracleSide[0] * across,
    prop.pos[2] + oracleDown[1] * along + oracleSide[1] * across)?.surface === 1))),
'a full eight-metre footprint around every oracle box stays on snow rather than straddling the shoulder');
const oracleStates = oracleProps.map(prop => nativeContactState({
  visible: true,
  ...prop.nativeCollision!,
  responseMass: prop.nativeCollision!.responseMass,
  hasTriangleProxy: prop.nativeCollision!.mode === 1,
  hasPhysicsBody: prop.nativeCollision!.mode === 3 && !!prop.nativeCollision!.physicsSource,
}));
assert.deepEqual(oracleStates, COLLISION_LAB_ORACLE_COLUMN.map(test => test.expectedContact),
'the downhill oracle encodes the shared classifier’s none, through, and solid sequence');
assert.deepEqual(COLLISION_LAB_ORACLE_COLUMN.map(test => test.expectedMarker),
  oracleStates.map(state => state !== 'none'),
  'the oracle expects a particle marker exactly when native shape/contact eligibility exists');

const bounceProps = COLLISION_LAB_BOUNCE_COLUMN.map(test =>
  lab.props!.find(prop => prop.name === test.label)!);
assert.deepEqual(bounceProps.map(prop => prop.id), [
  'collision-lab:23', 'collision-lab:24', 'collision-lab:25',
  'collision-lab:26', 'collision-lab:27', 'collision-lab:28',
], 'the bounce column appends without renumbering the matrix, follow-up, or oracle column');
assert.deepEqual(bounceProps.map(prop => prop.nativeCollision?.bounceAmount), [0, 0.03, 0.2, 0.5, 0.6, 1],
  'the calibration row spans the floor-only case, every retail tier, and one elastic stress control');
assert.ok(bounceProps.every(prop => nativeContactState({
  visible: true, ...prop.nativeCollision!, responseMass: prop.nativeCollision!.responseMass,
  hasTriangleProxy: true, hasPhysicsBody: false,
}) === 'solid'), 'all bounce calibrators hold shape, contact, mass, and response gates constant');
const bounceAxis = [
  bounceProps[bounceProps.length - 1].pos[0] - bounceProps[0].pos[0],
  bounceProps[bounceProps.length - 1].pos[2] - bounceProps[0].pos[2],
];
assert.ok(bounceProps.every(prop => Math.abs(
  (prop.pos[0] - bounceProps[0].pos[0]) * bounceAxis[1]
  - (prop.pos[2] - bounceProps[0].pos[2]) * bounceAxis[0]) < 1e-6),
'all six bounce controls form one straight downhill column');
const bounceDepths = bounceProps.map(prop => prop.pos[0] * oracleDown[0] + prop.pos[2] * oracleDown[1]);
assert.ok(bounceDepths.slice(1).every((depth, i) => Math.abs(depth - bounceDepths[i] - 190) < 1e-6),
  'each bounce impact has a 190 m downhill acceleration/recovery gap');
assert.ok(bounceProps.every(prop => [-4, 0, 4].every(along => [-4, 0, 4].every(across =>
  surfaceSampleAt(lab,
    prop.pos[0] + oracleDown[0] * along + oracleSide[0] * across,
    prop.pos[2] + oracleDown[1] * along + oracleSide[1] * across)?.surface === 1))),
'every bounce calibrator has a full in-bounds snow footprint');

// Confirm the lab colors use the same RGBA adapter as the editor, not hand-indexed native fields.
const firstTimer = lab.effects!.graphs.flatMap(graph => graph.nodes)
  .find(node => node.semanticType === 'particle.timer')!;
const timer = timerEmitterFields(firstTimer)!;
assert.deepEqual(emitterColorStopsFromNativeArgb(timer)[0], COLLISION_LAB_CASES[0][0].color,
  'the first red marker round-trips native ARGB as semantic RGBA');
assert.equal(timer.U0, 72, 'the native marker emits enough particles to remain conspicuous');
assert.equal(timer.U5, 1.5, 'the native marker has a nonzero visible lifetime');
assert.equal(timer.U49, 4, 'the marker uses the soft halo sprite rather than an ambiguous square');
assert.equal(timer.U50, 0, 'the marker uses additive blending for visibility against snow');

const out = mkdtempSync(join(tmpdir(), 'slopesmith-collision-lab-'));
try {
  const bake = process.argv.includes('--bake');
  await exportLevel(lab, { outDir: out, lighting: false });
  const effects = JSON.parse(readFileSync(join(out, 'Effects.json'), 'utf8'));
  const native = effects.extensions?.slopesmith?.nativeCollisions ?? {};
  assert.equal(Object.keys(native).length, 29, 'all generated exact collision profiles cross the export seam');
  const crash = native['collision-lab:09'];
  assert.equal(crash.mode, 3);
  assert.equal(crash.responseMass, 5);
  assert.equal(Object.hasOwn(crash, 'u0'), false,
    'authored collision profiles expose only the semantic responseMass field');
  assert.equal(crash.physicsSource.level, 'GARI');
  assert.equal(crash.physicsSource.body, 7);
  assert.equal(crash.playerCollision, true, 'mode 3 keeps its independent PlayerCollision gate');
  assert.equal(crash.transform.location.length, 3);
  assert.equal(crash.transform.rotation.length, 4);
  assert.deepEqual(crash.transform.scale, [1, 1, 1]);
  const obj = readFileSync(join(out, 'Props.obj'), 'utf8');
  assert.equal((obj.match(/^o inst\d+_Prop(?:Ghost)?_/gm) ?? []).length, 29,
    'the lab exports twenty-nine visible selectable hosts with prefixes matching their effective response');
  if (bake) {
    assert.equal(bakeGltf(out, 'COLLISION_LAB')?.status, 0, 'the optional direct Unity bundle bake succeeds');
    const manifest = JSON.parse(readFileSync(join(out, 'gltf', 'manifest.json'), 'utf8'));
    assert.equal(manifest.AmbientEmitters?.Emitters?.length, 25,
      'the Unity proxy keeps all six bounce markers plus the prior contact-capable cases');
    const physics = manifest.Props?.Diverted?.filter((item: { Kind?: string }) => item.Kind === 'physics') ?? [];
    assert.equal(physics.length, 0,
      `instance response mass alone never activates Unity Rigidbody dynamics (${JSON.stringify(manifest.Props?.Diverted ?? [])})`);
    assert.equal(manifest.Collision?.Buckets?.reduce((sum: number, item: { InstanceCount?: number }) =>
      sum + (item.InstanceCount ?? 0), 0), 11,
    'the six calibrated bounce cases join the prior PlayerBounce-enabled nonzero mode-1 collision');
    assert.equal(manifest.Collision?.Buckets?.some((item: { PlayerBounce?: boolean }) =>
      item.PlayerBounce === false), false,
    'the live-confirmed mode-1 PlayerBounce-off case does not become a Unity wall');
    assert.equal(manifest.Collision?.ComputedBounds?.length, 7,
      'nonzero mode-2/mode-3 cases use bounds except for the PlayerBounce-off pass-through control');
    assert.equal(manifest.Collision.ComputedBounds[0].PlayerBounce, true,
      'bounds/sphere Unity proxies retain the authored response gate');
    assert.equal(manifest.Collision.ComputedBounds[0].PlayerBounceAmmount, 0.2,
      'bounds/sphere Unity proxies retain the authored bounce amount');

    const dynamicLab = collisionLabMountain('COLLISION_LAB_DYNAMIC');
    addEffectTemplateToProp(dynamicLab.effects!, dynamicLab.props![0].id!, 'roller');
    const dynamicOut = join(out, 'dynamic');
    await exportLevel(dynamicLab, { outDir: dynamicOut, lighting: false });
    const dynamicBake = bakeGltf(dynamicOut, 'COLLISION_LAB_DYNAMIC');
    assert.equal(dynamicBake?.status, 0,
      `the semantic dynamic-mass fixture bakes (${dynamicBake?.stdout}${dynamicBake?.stderr})`);
    const dynamicManifest = JSON.parse(readFileSync(join(dynamicOut, 'gltf', 'manifest.json'), 'utf8'));
    const dynamic = dynamicManifest.Props?.Diverted?.find((item: { Kind?: string }) => item.Kind === 'physics');
    assert.equal(dynamic?.DynamicMass, 5, 'the Unity bundle carries the Roller-authored mass semantically');
    assert.equal(Object.hasOwn(dynamic ?? {}, 'U0'), false,
      'the bundle does not reuse raw instance-U0 naming for Rigidbody mass');

    const zeroMassLab = collisionLabMountain('COLLISION_LAB_ZERO_ROLLER');
    const zeroSelection = addEffectTemplateToProp(zeroMassLab.effects!, zeroMassLab.props![0].id!, 'roller');
    const zeroNode = effectNode(zeroMassLab.effects!, zeroSelection)!;
    zeroNode.payload = {
      type0: { SubType: 0, type0Sub0: { U0: 0, U1: 0.002, U2: 1.5, U3: 0, U4: 0, U5: 0 } },
    };
    const zeroOut = join(out, 'zero-roller');
    await exportLevel(zeroMassLab, { outDir: zeroOut, lighting: false });
    const zeroBake = bakeGltf(zeroOut, 'COLLISION_LAB_ZERO_ROLLER');
    assert.equal(zeroBake?.status, 0,
      `the zero-mass Roller fixture still bakes (${zeroBake?.stdout}${zeroBake?.stderr})`);
    const zeroManifest = JSON.parse(readFileSync(join(zeroOut, 'gltf', 'manifest.json'), 'utf8'));
    assert.equal(zeroManifest.Props?.Diverted?.some((item: { Kind?: string }) => item.Kind === 'physics'), false,
    'a zero-mass Roller does not create a portable physics body');
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

console.log('COLLISION LAB TESTS PASSED');
