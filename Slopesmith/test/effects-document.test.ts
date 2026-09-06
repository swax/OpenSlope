import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { buildMountainLevel } from '../src/core/export/level';
import { exportLevel } from '../src/server/routes/export';
import {
  CANONICAL_SEMANTIC_TYPES, cloneEffectsDocument, compatibleEffectSemanticTypes, parseEffectsDocument,
  serializeEffectsDocument, validateEffectsDocument,
  type EffectNode,
} from '../src/core/effects/document';
import {
  semanticInspectorForNode, semanticNumberValue, setSemanticNumberValue,
} from '../src/core/effects/semantic-fields';
import type { PlacedProp, Rail } from '../src/core/doc/types';
import {
  AUTHORED_MODEL_LEVEL, commitModelEditDoc, createAuthoredModel, modelEditDocFor, modelNumber,
} from '../src/core/doc/models';
import { appendPatchFromCorners } from '../src/core/mesh/ops';
import { AUTO_TEST_FIXTURES } from '../src/core/collision/autotest';
import {
  EFFECT_TEMPLATES, UNAUTHORABLE_EFFECT_NODES,
  addEffectFunction, addEffectNodeTemplate, addEffectTemplate, addEffectTemplateToProp, addEmptyEffect, addEmptyEffectToProp,
  attachEffectToProp, authoredInstanceEffectCall, bindEffectFunctionCall, bindEffectSplineToMotionPath,
  bindEffectSplineToRail, bindInstanceHop,
  bindZBoostToPlacement,
  createEmptyEffectsDocument, deleteEffectOwner, duplicateEffectNode, duplicateEffectOwner,
  authoredEffectBindings, authoredPropHoldsAtEnd, authoredPropMaterialControl, authoredPropMaterialEffects, authoredPropUvScroll, effectAttachments, effectNode, effectSelectionForProp, emitterWorldPosition, ensurePlacedPropIds, replaceEffectNodeRaw,
  effectCircumstanceLabel, effectGraphDisplayName, effectGraphHasTimerEmitter, effectSlotCanSelfEnd, effectSlotHoldsAtEnd, effectSlotHoldsOnRegionExit, effectSlotLatchIsEmptyGraph,
  authoredRailIdFromSpline, authoredSplineId, splineEffectUses, splinePairedProps,
  collisionEmitterFields,
  setEmitterWorldPosition, setParticleEmitterField, setPropEffectLatch, syncAuthoredMotionPathEffectResources, unassignedEffectOwnerIds, validateEffectsAuthoring,
  type EffectSelection,
} from '../src/core/effects/authoring';
import { isBareRail, nativeSplineFields, railHasTube, railStartsOff, railStyle } from '../src/core/rails/rails';
import {
  attachedReferenceInstances, referenceEffectDisplayName, referenceEffectSelection,
  referenceAnimDeltaEffects, referenceAnimObjectEffects, referenceMaterialControls, referenceMaterialWorldEffects, referenceUvScroll,
  referenceEffectInstanceIndices, referenceIncomingEffectCalls, referenceIncomingEffectSources, referenceIncomingEffectTree,
  referenceOutgoingEffectCalls,
  referenceSupplementalOutgoingEffectCalls, referenceInstanceBindings, referenceInstanceEffectCall,
  referenceFireworkCall, referenceFireworkEffect, referenceInstanceHoldsAtEnd, referenceNodeDisplayName,
  referenceImmediateBreakInstances, referenceRaceCountdown, referenceSlot, referenceSplineOriginalIndex,
  type ReferenceEffectsData,
} from '../src/core/reference/effects';
import {
  effectConditionPasses, effectPlayCommand, pickupPopScale, rollerPreviewImpact,
  ANIMATED_PROP_AUTO_RESET_SECONDS, BREAKABLE_RESPAWN_SECONDS, MOVABLE_PROP_RESPAWN_SECONDS,
  runScheduledEffectGraphs, scheduleEffectGraph, PICKUP_GROW_SECONDS, PICKUP_POP_HOLD_SECONDS, PICKUP_POP_SECONDS,
  splineEndModeLabel, splineOrientationAngles, splineOrientationAxes, splineMotionCopyDistances,
  splineOrientationModeLabel, stepSplineMotionDistance,
} from '../src/core/effects/play-runtime';
import {
  animComboFromGraph, animComboFromNode, animDeltaFromNode, animObjectFromNode,
  createAnimComboPlayback, createAnimDeltaPlayback,
  createAnimObjectPlayback, createTriggeredAnimObjectPlayback, createUvScrollPlayback,
  createTextureFlipPlayback, crowdBoxFromNode, editorUvScrollDelta, editorUvScrollVPhase, grantAnimDeltaPlayback,
  isTextureFlipPulse, materialWorldEffectsFromNode, retriggerTriggeredAnimObjectPlayback,
  selectTextureFlipPlaybackFrame, startTextureFlipPulse,
  stepAnimComboPlayback, stepAnimDeltaPlayback, stepAnimObjectPlayback, stepTextureFlipPlayback,
  stepTriggeredAnimObjectPlayback,
  stepUvScrollPlayback, textureFlipFromNode, triggerAnimComboPlayback,
  uvScrollFromNode, uvScrollReceiverFromNode, type AnimComboEffect,
} from '../src/core/effects/world-effects';
import {
  PARTICLE_SPRITE_NAMES, emitterBlendLabel, emitterBlendMode, timerEmitterPreviewLaw,
  collisionEmitterContactVelocityBase,
  timerEmitterPreviewLifetime,
  timerEmitterPreviewOpacity, timerEmitterPreviewSample, timerEmitterPreviewSizeRange,
  timerEmitterPreviewStartDelay, timerEmitterPreviewTrajectoryOffset,
} from '../src/core/effects/emitter-preview';
import {
  emitterColorStopsFromNativeArgb, nativeArgbFieldsFromRgbaColorStops, type RgbaColor,
} from '../src/core/effects/emitter-colors';
import {
  propModelAnimationChannels, samplePropModelAnimationChannel,
  samplePropModelRotation, samplePropModelTranslation,
} from '../src/core/reference/props';
import { hierarchicalModelAnimation, modelObjectRestMatrices, readLevelProps, rollerInstanceMasses, simpleModelRotation } from '../src/server/routes/props';
import { particleVolumesFromNative, particleVolumesToNative } from '../src/core/particles/volumes';
import { readCourseEffectSoundBytes, readNamedEffectSoundBytes } from '../src/server/routes/audio';
import { levelSplinesFromNative } from '../src/server/routes/levels';
import { referenceSplineIsGrindRail } from '../src/core/reference/terrain';
import { readReferenceEffects } from '../src/server/routes/effects';
import { crackedBreakTombstonesCollider } from '../src/app/viewport/scene/reference-effects';
import { mapsRoot } from '../src/server/workspace-config';
import { check, failures } from './check';

const retailFile = (path: string) => join(mapsRoot(), ...path.split('/'));
const withRetailFiles = async (label: string, files: string[], run: () => void | Promise<void>) => {
  const missing = files.filter(file => !existsSync(retailFile(file)));
  if (missing.length) {
    console.log(`SKIP ${label} (no extracted retail fixture: ${missing.join(', ')})`);
    return;
  }
  await run();
};

const text = readFileSync(new URL('../fixtures/effects-v1-minimal.json', import.meta.url), 'utf8');
const document = parseEffectsDocument(text);
check(document.graphs[0].nodes[0].payload.type2 !== undefined, 'parse typed payload without discarding raw fields');

const serialized = serializeEffectsDocument(document);
const roundTrip = parseEffectsDocument(serialized);
check(JSON.stringify(roundTrip) === JSON.stringify(document), 'Slopesmith parse/export preserves the complete document');

const multiplierNode: EffectNode = {
  id: 'test:multiplier', mainType: 14, semanticType: 'score.multiplier', payload: { MultiplierScore: 2 }, references: {},
};
check(JSON.stringify(effectPlayCommand(multiplierNode)) === JSON.stringify({ kind: 'score-multiplier', multiplier: 2 }),
  'Play runtime decodes the proven score-multiplier command');

check(PICKUP_POP_SECONDS === PICKUP_POP_HOLD_SECONDS + PICKUP_GROW_SECONDS
  && pickupPopScale(0) === 0
  && pickupPopScale(PICKUP_POP_HOLD_SECONDS) === 0
  && Math.abs(pickupPopScale(PICKUP_POP_HOLD_SECONDS + PICKUP_GROW_SECONDS / 2) - 0.5) < 1e-9
  && pickupPopScale(PICKUP_POP_SECONDS) === 1,
  'pickup pop snaps away, holds, then follows the Unity smooth grow-back curve');
check(ANIMATED_PROP_AUTO_RESET_SECONDS === 8 && BREAKABLE_RESPAWN_SECONDS === 12
  && MOVABLE_PROP_RESPAWN_SECONDS === BREAKABLE_RESPAWN_SECONDS,
  'Play publishes Unity\'s eight-second animation and twelve-second breakable timers, with movable convergence');

check(JSON.stringify(effectPlayCommand({
  id: 'node:hud-test', mainType: 12, semanticType: 'hud.message',
  payload: { HudText: '  trigger-cell-7  ', HudRed: 1.2, HudGreen: 0.5, HudBlue: -1 }, references: {},
})) === JSON.stringify({ kind: 'hud-message', text: 'trigger-cell-7', color: [1, 0.5, 0], durationSeconds: 2.5 }),
  'Play runtime decodes Show message text, clamps its colour, and uses the patched HUD lifetime');
const speedGate = (selector: number, thresholdWord: number): EffectNode => ({
  id: `test:speed-gate:${selector}:${thresholdWord}`, mainType: 5, semanticType: 'condition.speed',
  payload: { type5: { U0: 0, U1: selector, U2: thresholdWord } }, references: {},
});
check(!effectConditionPasses(speedGate(0, 1106247680), { riderSpeed: 20 })
  && effectConditionPasses(speedGate(1.401298464324817e-45, 1106247680), { riderSpeed: 20 })
  && !effectConditionPasses(speedGate(1.401298464324817e-45, 1232348160), { riderSpeed: 20 }),
  'Play runtime uses engine cm/s, bit-exact at-least selector, and float-bit threshold for speed gates');
const scheduled: Parameters<typeof scheduleEffectGraph<number, string>>[0] = [];
scheduleEffectGraph(scheduled, 7, { nodes: [
  { id: 'test:scheduled:first', mainType: 14, semanticType: 'score.multiplier', payload: {}, references: {} },
  { id: 'test:scheduled:wait', mainType: 4, semanticType: 'wait', payload: { WaitTime: 1 }, references: {} },
  { id: 'test:scheduled:gate', mainType: 5, semanticType: 'condition.human-rider',
    payload: { type5: { U0: 2, U1: 0, U2: 0 } }, references: {} },
  { id: 'test:scheduled:suppressed', mainType: 14, semanticType: 'score.multiplier', payload: {}, references: {} },
] }, 0, 0, 'collision');
const scheduledExecutions: string[] = [];
const scheduledHooks = {
  condition: (_host: number, node: EffectNode) => effectConditionPasses(node, { riderSpeed: 0, humanRider: false }),
  execute: (_host: number, node: EffectNode) => { scheduledExecutions.push(node.id); },
};
runScheduledEffectGraphs(scheduled, 0, scheduledHooks);
runScheduledEffectGraphs(scheduled, 1, scheduledHooks);
check(JSON.stringify(scheduledExecutions) === JSON.stringify(['test:scheduled:first']) && scheduled.length === 0,
  'shared Play graph scheduler honors waits and suppresses the rest of a thread after a failed condition');
check(JSON.stringify(effectPlayCommand({
  id: 'test:roller', mainType: 0, semanticType: 'property.roller', references: {},
  payload: { type0: { SubType: 0, type0Sub0: { U0: 6, U1: 0.002, U2: 1.5, U3: 0, U4: 1000, U5: 0 } } },
})) === JSON.stringify({ kind: 'roller', mass: 6, direction: [0, 1000, 0] }),
  'Play runtime decodes Roller mass and authored launch direction');
check(effectPlayCommand({
  id: 'test:zero-roller', mainType: 0, semanticType: 'property.roller', references: {},
  payload: { type0: { SubType: 0, type0Sub0: { U0: 0, U1: 0, U2: 0, U3: 0, U4: 0, U5: 0 } } },
}) === null, 'Play runtime ignores a non-positive Roller instead of inventing an extremely light body');
const rollerImpactX = rollerPreviewImpact(() => 0);
const rollerImpactZ = rollerPreviewImpact(() => 0.25);
check(Math.abs(Math.hypot(...rollerImpactX) - 12) < 1e-9 && rollerImpactX[1] === 0
  && Math.abs(rollerImpactZ[0]) < 1e-9 && rollerImpactZ[1] === 0 && rollerImpactZ[2] === 12,
  'Roller preview bakes a fixed 12 m/s horizontal hit while varying only its direction');
const rollerJoin = createEmptyEffectsDocument('ROLLER_JOIN');
rollerJoin.graphs = [
  { id: 'graph:0000', originalIndex: 0, nodes: [
    { id: 'graph:0000/node:0000', mainType: 0, semanticType: 'property.roller', references: {},
      payload: { type0: { SubType: 0, type0Sub0: { U0: 5, U1: 0, U2: 0, U3: 0, U4: 0, U5: 0 } } } },
    { id: 'graph:0000/node:0001', mainType: 7, semanticType: 'instance.state',
      references: { instance: 'instance:0001', effectGraph: 'graph:0001' }, payload: {} },
  ] },
  { id: 'graph:0001', originalIndex: 1, nodes: [
    { id: 'graph:0001/node:0000', mainType: 0, semanticType: 'property.roller', references: {},
      payload: { type0: { SubType: 0, type0Sub0: { U0: 6, U1: 0, U2: 0, U3: 0, U4: 0, U5: 0 } } } },
  ] },
];
rollerJoin.slots = [{ id: 'slot:0000', originalIndex: 0, circumstances: {
  persistent: null, collision: 'graph:0000', slot3: null, slot4: null, trigger: null, slot6: null, slot7: null,
} }];
const joinedRollers = rollerInstanceMasses(rollerJoin, [{ EffectSlotIndex: 0 }, { EffectSlotIndex: -1 }]);
check(joinedRollers.get(0) === 5 && joinedRollers.get(1) === 6,
  'Roller movement joins inline and MainType-7 target graphs and keeps their effect-authored masses');
const zeroInlineRoller = structuredClone(rollerJoin);
zeroInlineRoller.graphs[0].nodes[0].payload = {
  type0: { SubType: 0, type0Sub0: { U0: 0, U1: 0, U2: 0, U3: 0, U4: 0, U5: 0 } },
};
const zeroInlineMasses = rollerInstanceMasses(zeroInlineRoller, [{ EffectSlotIndex: 0 }, { EffectSlotIndex: -1 }]);
check(!zeroInlineMasses.has(0) && zeroInlineMasses.get(1) === 6,
  'portable movement ignores an inline zero-mass Roller while retaining a valid linked target Roller');
// Mode and window govern the node's lifetime, which the test ride does not model, so neither reaches the
// command; the target and approach rate that shape the push do ([Trailmap: 360-node-apply]).
check(JSON.stringify(effectPlayCommand({
  id: 'test:boost-volume', mainType: 0, semanticType: 'property.boost', references: {},
  payload: { type0: { SubType: 7, Boost: { Mode: 1, U1: 3, U2: 4, BoostAmount: 200, BoostDir: { X: 1, Y: 2, Z: 3 } } } },
})) === JSON.stringify({ kind: 'directional-boost', target: 200, rate: 4, direction: [1, 2, 3] }),
  'Play runtime decodes the directional boost target, approach rate and world-space axis');
check(JSON.stringify(effectPlayCommand({
  id: 'test:spline', mainType: 2, semanticType: 'spline.animation', references: { spline: 'spline:0038' },
  payload: { type2: { SubType: 1, SplineAnimation: {
    U1: 1, U2: 1, InstanceCount: 1, AnimationSpeed: 35, U5: 1.62,
  } } },
})) === JSON.stringify({ kind: 'spline-motion', spline: 'spline:0038', endMode: 1,
  orientationMode: 1, instanceCount: 1, speed: 35, yawOffset: 1.62,
  splineLine: { enabled: false, color: [0, 0, 0, 0] } }),
  'Play runtime decodes the subway spline-motion law through its stable resource reference');
const authoredSplineReference = createEmptyEffectsDocument('AUTHORED_SPLINE_REFERENCE');
authoredSplineReference.splines = [{
  id: 'spline:path:0000', originalIndex: 3, name: 'Motion path 1',
  data: { U1: -1, U2: -2, SplineStyle: -1 },
}];
check(referenceSplineOriginalIndex(authoredSplineReference, 'spline:path:0000') === 3
  && referenceSplineOriginalIndex(authoredSplineReference, 'spline:0038') === 38
  && referenceSplineOriginalIndex(authoredSplineReference, 'spline:path:missing') === null,
  'reference spline resolver joins authored stable path resources and keeps retail numeric ids');
const splineSegment = (first: number[]) => ({ Points: [first, [0, 0, 0], [0, 0, 0], [0, 0, 0]] });
// Purpose-built native rows: enough rail/non-rail variety to prove filtering and stable indices without
// embedding an extracted course row or reproducing a retail table's size/selection.
const nativeSplineFixture = Array.from({ length: 6 }, (_, originalIndex) => ({
  SplineName: originalIndex === 4 ? 'Spline_IceRail_2000' : `Spline_Route_${originalIndex}`,
  SplineStyle: originalIndex === 4 ? 5
    : originalIndex === 2 || originalIndex >= 4 ? -1 : originalIndex % 2 ? 12 : 13,
  Segments: originalIndex === 2
    ? [splineSegment([123.25, -456.5, 789.75]), splineSegment([1, 2, 3]),
      splineSegment([4, 5, 6]), splineSegment([7, 8, 9])]
    : [splineSegment([originalIndex, 0, 0])],
}));
const nativeSplines = levelSplinesFromNative({ Splines: nativeSplineFixture })!;
const animationRoute = nativeSplines.find(spline => spline.originalIndex === 2);
check(nativeSplines.length === 6 && animationRoute?.name === 'Spline_Route_2'
  && animationRoute.style === -1 && animationRoute.segments.length === 4
  && animationRoute.segments[0][0].join(',') === '123.25,-456.5,789.75',
  'level spline payload preserves a native index, name, and animation-only synthetic route');
const nativeGrindSplines = nativeSplines.filter(referenceSplineIsGrindRail);
check(nativeGrindSplines.length === 4
  && nativeGrindSplines.some(spline => spline.originalIndex === 4 && spline.style === 5),
  'grind consumers include a named style-5 IceRail without renumbering the shared native spline table');
const splineWrap = stepSplineMotionDistance(95, 1, 10, 1, 100, 1);
const splineReverseWrap = stepSplineMotionDistance(5, -1, 10, 1, 100, 1);
const splineBounce = stepSplineMotionDistance(95, 1, 10, 1, 100, 2);
const splineStop = stepSplineMotionDistance(95, 1, 10, 1, 100, 0);
const splineHold = stepSplineMotionDistance(95, 1, 10, 1, 100, 3);
const splineFallback = stepSplineMotionDistance(95, 1, 10, 1, 100, 9);
check(splineWrap.distance === 5 && splineWrap.direction === 1 && !splineWrap.stopped
  && splineReverseWrap.distance === 0 && splineReverseWrap.direction === -1 && splineReverseWrap.stopped
  && splineBounce.distance === 95 && splineBounce.direction === -1
  && splineStop.distance === 100 && splineStop.stopped && splineStop.finished
  && splineHold.distance === 100 && splineHold.stopped && !splineHold.finished
  && splineFallback.distance === 5 && !splineFallback.stopped,
  'spline cursor distinguishes finish/hold, clamps reverse wrap, ping-pongs, and applies the native wrap fallback');
check(splineMotionCopyDistances(0, 150, 15).join(',')
    === '0,10,20,30,40,50,60,70,80,90,100,110,120,130,140'
  && splineMotionCopyDistances(145, 150, 15).join(',')
    === '145,5,15,25,35,45,55,65,75,85,95,105,115,125,135'
  && splineMotionCopyDistances(150, 150, 3).join(',') === '150,50,100',
  'spline copies share one cursor, space evenly by arc length, wrap independently, and preserve the endpoint pose');
check(JSON.stringify([0, 1, 2, 3, 8].map(splineOrientationAxes)) === JSON.stringify([
  { followYaw: true, followPitch: true }, { followYaw: true, followPitch: false },
  { followYaw: false, followPitch: true }, { followYaw: false, followPitch: false },
  { followYaw: true, followPitch: true },
]) && splineEndModeLabel(3) === 'Hold at end'
  && splineOrientationModeLabel(2) === 'Fixed yaw, follow pitch',
  'spline orientation modes and invalid-value fallbacks use the live-confirmed native branch law');
const tangent: [number, number, number] = [0.6, 0.2, 0.8];
const orient0 = splineOrientationAngles(tangent, 1, 2, 0, 0.1);
const orient1 = splineOrientationAngles(tangent, 1, 2, 1, 0.1);
const orient2 = splineOrientationAngles(tangent, 1, 2, 2, 0.1);
const orient3 = splineOrientationAngles(tangent, 1, 2, 3, 0.1);
const orientFallback = splineOrientationAngles(tangent, 1, 2, 8, 0.1);
const orientReverse = splineOrientationAngles(tangent, -1, 2, 2, 0.1);
check(Math.abs(orient0.yaw - (Math.atan2(0.6, 0.8) - 0.1)) < 1e-9 && orient0.pitch === -0.2
  && orient1.yaw === orient0.yaw && orient1.pitch === 0
  && orient2.yaw === -0.1 && orient2.pitch === -0.2
  && orient3.yaw === -0.1 && orient3.pitch === 0
  && orientFallback.yaw === orient0.yaw && orientFallback.pitch === orient0.pitch
  && Math.abs(orientReverse.yaw - (Math.PI - 0.1)) < 1e-9 && orientReverse.pitch === 0.2,
  'spline preview applies every orientation mode plus the native ping-pong return-leg turn');
await withRetailFiles('retail effect and model integration assertions', [
  'SNOW/Effects.json', 'SNOW/Instances.json', 'SNOW/Models.json',
  'MEGAPLE/Effects.json', 'MEGAPLE/Instances.json', 'MEGAPLE/Models.json',
  'MERQUER/Effects.json', 'MERQUER/Instances.json', 'MERQUER/Models.json',
  'MESA/Effects.json', 'MESA/Instances.json', 'MESA/Models.json',
  'ALOHA/Effects.json', 'ALOHA/Instances.json', 'ALOHA/Models.json',
], async () => {
const snowEffectPayload = await readReferenceEffects('SNOW');
const snowEffectData: ReferenceEffectsData = {
  ...snowEffectPayload,
  document: parseEffectsDocument(JSON.stringify(snowEffectPayload.document)),
};
const snowImmediateBreaks = referenceImmediateBreakInstances(snowEffectData);
check(snowImmediateBreaks.has(1002)
  && snowEffectData.instances.find(instance => instance.index === 1002)?.modelName === 'Mdl_BalloonAnimal_IanAnim_3000',
  'Snowdream balloon-animal 1002 is an immediate collision break, so Play treats its collider as ride-through');
const gondolaMoverGraphs = snowEffectData.document.graphs.filter(graph => graph.nodes.some(node => {
  const command = effectPlayCommand(node);
  return command?.kind === 'spline-motion' && command.instanceCount === 15 && command.splineLine.enabled
    && command.splineLine.color.every((channel, index) => Math.abs(channel - (index === 3 ? 1 : 0.1)) < 1e-6);
}));
const gondolaGraphIds = new Set(gondolaMoverGraphs.map(graph => graph.id));
const gondolaChairs = snowEffectData.instances.filter(instance => instance.modelName === 'Mdl_Gondola_Chair_1000');
const gondolaChairIds = new Set(gondolaChairs.map(instance => `instance:${instance.index.toString().padStart(6, '0')}`));
const gondolaHandoffs = snowEffectData.document.graphs.flatMap(graph => graph.nodes
  .filter(node => !!node.references?.instance && gondolaChairIds.has(node.references.instance)
    && !!node.references.effectGraph && gondolaGraphIds.has(node.references.effectGraph))
  .map(node => ({ graph, node })));
const snowPersistentGraphIds = new Set(snowEffectData.instances.flatMap(instance =>
  referenceInstanceBindings(snowEffectData, instance)
    .filter(binding => binding.circumstance === 'persistent').map(binding => binding.graph.id)));
check(gondolaMoverGraphs.length === 3 && gondolaChairs.map(instance => instance.index).join(',') === '93,939,2008'
  && gondolaHandoffs.length === 3
  && gondolaHandoffs.every(handoff => snowPersistentGraphIds.has(handoff.graph.id)),
  'Snowdream exposes three persistent handed gondola movers, each targeting one chair template with 15 spline copies and its opaque dark cable');
const megapleEffectPayload = await readReferenceEffects('MEGAPLE');
const megapleEffectData: ReferenceEffectsData = {
  ...megapleEffectPayload,
  document: parseEffectsDocument(JSON.stringify(megapleEffectPayload.document)),
};
const megaplePane = megapleEffectData.instances.find(instance => instance.modelName === 'Mdl_Glass_Pane_4000')!;
const megaplePaneBindings = referenceInstanceBindings(megapleEffectData, megaplePane);
const megapleCrack = megaplePaneBindings.find(binding => binding.circumstance === 'collision');
const megapleBreak = megaplePaneBindings.find(binding => binding.circumstance === 'trigger');
const megapleSupportKill = megapleBreak?.graph.nodes
  .map(node => referenceInstanceEffectCall(megapleEffectData, node))
  .find(call => call?.target?.modelName === 'Mdl_Glass_Surface_4000');
check(megapleCrack?.graph.nodes.some(node => node.semanticType === 'property.cracked')
  && megapleSupportKill?.target?.index === 126
  && megapleSupportKill.graph?.nodes.some(crackedBreakTombstonesCollider),
  'Megaplex glass break calls the DeadNodeMode-2 tombstone on its separate invisible support collider');
const merquerEffectPayload = await readReferenceEffects('MERQUER');
const merquerEffectData: ReferenceEffectsData = {
  ...merquerEffectPayload,
  document: parseEffectsDocument(JSON.stringify(merquerEffectPayload.document)),
};
const merquerLetterModel = (await readLevelProps('MERQUER')).models.find(model => model.id === 5);
check(merquerLetterModel?.subs.length === 21
  && merquerLetterModel.subs.every(sub => Number.isInteger(sub.piece) && sub.piecePivot?.length === 3),
  'Effect 104 preserves all 21 mailbox letters as independently throwable model pieces');
const endSubwayRun = merquerEffectData.document.graphs.find(graph => graph.originalIndex === 755)?.nodes[1];
const leftTrainCall = endSubwayRun ? referenceInstanceEffectCall(merquerEffectData, endSubwayRun) : null;
const leftTrainAnim = leftTrainCall?.graph?.nodes.map(animObjectFromNode).find(effect => !!effect) ?? null;
const merquerModels = JSON.parse(readFileSync(
  retailFile('MERQUER/Models.json'), 'utf8')) as {
    Models: Parameters<typeof simpleModelRotation>[0][];
  };
const leftTrainClip = simpleModelRotation(merquerModels.Models[529]);
check(leftTrainCall?.target?.index === 4395 && leftTrainCall.graph?.originalIndex === 756
  && leftTrainAnim?.rate === 30 && leftTrainClip?.clipFrames === 120
  && propModelAnimationChannels(leftTrainClip).some(channel => channel.id === 'translate-y'),
  'EndSubway Run resolves Effect 756 onto TrainLeft and its non-persistent model remains clip-previewable');
const roadBarrier = merquerEffectData.instances.find(instance => instance.index === 2163)!;
const roadBarrierBindings = referenceInstanceBindings(merquerEffectData, roadBarrier);
check(roadBarrier.modelName === 'Mdl_RoadBarrier_2049'
  && roadBarrierBindings.map(binding => `${binding.circumstance}:${binding.graph.originalIndex}`).join(',')
    === 'persistent:722,collision:723'
  && roadBarrierBindings.flatMap(binding => binding.graph.nodes.map(node => node.semanticType)).join(',')
    === 'property.texture-flip,property.mesh-animation',
  'model-root preview discovers both RoadBarrier effects instead of collapsing to the selected graph');
const mesaEffectPayload = await readReferenceEffects('MESA');
const mesaEffectData: ReferenceEffectsData = {
  ...mesaEffectPayload,
  document: parseEffectsDocument(JSON.stringify(mesaEffectPayload.document)),
};
const mineCartRun = mesaEffectData.document.graphs.find(graph => graph.originalIndex === 176)?.nodes[1];
const mineCartCall = mineCartRun ? referenceInstanceEffectCall(mesaEffectData, mineCartRun) : null;
const mesaModels = JSON.parse(readFileSync(
  retailFile('MESA/Models.json'), 'utf8')) as {
    Models: Parameters<typeof hierarchicalModelAnimation>[0][];
  };
const mineCartAnimation = hierarchicalModelAnimation(mesaModels.Models[176]);
const mineCartPayload = (await readLevelProps('MESA')).models.find(model => model.id === 176);
const mineCartChannels = mineCartAnimation ? propModelAnimationChannels(mineCartAnimation) : [];
check(mineCartCall?.target?.index === 774 && mineCartCall.graph?.originalIndex === 177
  && mineCartAnimation?.clipFrames === 90 && mineCartAnimation.objects[2]?.channels?.filter(Boolean).length === 6
  && mineCartPayload?.animation?.objects.length === 6 && mineCartPayload.subs.map(sub => sub.object).join(',') === '1,2,3,4,5'
  && mineCartChannels.length === 6
  && samplePropModelAnimationChannel(mineCartAnimation!, 'object-2-translate-x', 45) > 3500
  && Math.abs(samplePropModelAnimationChannel(mineCartAnimation!, 'object-2-rotate-z', 0) + 51.474304) < 1e-5,
  'MESA mine-cart Run retains Effect 177, its full six-channel hierarchy, and per-object preview geometry');

// Aloha's sliding barriers are the corpus's only ATTACHED AnimCombo (Megaplex's copy of the identical payload
// sits in a slot nothing carries), so this is the one join that can check the decode against a real model.
const alohaEffectPayload = await readReferenceEffects('ALOHA');
const alohaEffectData: ReferenceEffectsData = {
  ...alohaEffectPayload,
  document: parseEffectsDocument(JSON.stringify(alohaEffectPayload.document)),
};
const alohaBarriers = alohaEffectData.instances
  .filter(instance => instance.modelName.startsWith('Mdl_BarrierDynamic_SideToSide_'));
const barrierCombos = new Set(alohaBarriers
  .map(instance => referenceInstanceBindings(alohaEffectData, instance)
    .find(binding => binding.circumstance === 'persistent'))
  .map(binding => JSON.stringify(binding ? animComboFromGraph(binding.graph) : null)));
const barrierTrigger = referenceInstanceBindings(alohaEffectData, alohaBarriers[0])
  .find(binding => binding.circumstance === 'collision');
const barrierCombo = animComboFromGraph(referenceInstanceBindings(alohaEffectData, alohaBarriers[0])
  .find(binding => binding.circumstance === 'persistent')!.graph)!;
check(alohaBarriers.length === 5 && barrierCombos.size === 1 && barrierCombo.comboStartFrame === 61
  && barrierCombo.comboEndFrame === 100 && barrierCombo.loopMode === 2 && barrierCombo.endFrame === 60
  && barrierCombo.comboEnd === 'resume' && barrierCombo.randomStart
  && barrierTrigger?.graph.nodes.length === 1
  && JSON.stringify(effectPlayCommand(barrierTrigger.graph.nodes[0]))
    === JSON.stringify({ kind: 'property-control', command: 3, value: 0 }),
  'the five Aloha barriers share one AnimCombo, installed persistently and triggered by their own collision chain');
const alohaModels = JSON.parse(readFileSync(
  retailFile('ALOHA/Models.json'), 'utf8')) as {
    Models: Parameters<typeof hierarchicalModelAnimation>[0][];
  };
const barrierAnimation = hierarchicalModelAnimation(alohaModels.Models[467])!;
// The model is what closes the reading: the clip is exactly as long as the combo window's end, and its two
// channels split at exactly the window boundary - translation over the idle half, rotation over the reaction.
const slideAt = (frame: number) => samplePropModelAnimationChannel(barrierAnimation, 'object-1-translate-x', frame);
const flipAt = (frame: number) => samplePropModelAnimationChannel(barrierAnimation, 'object-1-rotate-x', frame);
check(barrierAnimation.clipFrames === barrierCombo.comboEndFrame
  && Math.abs(slideAt(0) + 430) < 0.1 && Math.abs(slideAt(60) - 429.6) < 0.5
  && Math.abs(slideAt(70)) < 0.01 && Math.abs(slideAt(100)) < 0.01
  && Math.abs(flipAt(0)) < 0.1 && Math.abs(flipAt(70) + 90) < 0.1 && Math.abs(flipAt(100)) < 0.5,
  'the barrier clip slides over the idle window and rotates flat over the combo window, with the combo half authored at zero translation');
// The authored combo window is a movement away from rest, which is what the composition needs: with the
// snapshot supplying the slide, the reaction's own translation must contribute nothing.
const barrierPlayback = createAnimComboPlayback({ ...barrierCombo, randomStart: false },
  barrierAnimation.clipFrames, 1);
stepAnimComboPlayback(barrierPlayback, barrierCombo, 1);          // 30 frames into the slide
triggerAnimComboPlayback(barrierPlayback);
const knocked = stepAnimComboPlayback(barrierPlayback, barrierCombo, 0.3);   // 9 frames into the 39-frame reaction
check(barrierPlayback.snapshotFrame === 30 && knocked.basis === 30
  && Math.abs(slideAt(knocked.basis!) - slideAt(30)) < 1e-9 && Math.abs(slideAt(knocked.frame)) < 0.01
  && Math.abs(flipAt(knocked.frame) + 90) < 1e-3,
  'a barrier knocked over mid-slide composes a 90-degree flip onto the exact slide offset it was holding');
});
const multiplierField = semanticInspectorForNode(multiplierNode).fields[0]!;
check(multiplierField?.label === 'Multiplier' && semanticNumberValue(multiplierNode, multiplierField) === 2,
  'semantic inspector exposes the proven score multiplier field');
check(setSemanticNumberValue(multiplierNode, multiplierField, 3) && multiplierNode.payload.MultiplierScore === 3,
  'semantic inspector edits the underlying round-trip-safe raw field');
const particleFields = semanticInspectorForNode(document.graphs[0].nodes[0]);
check(particleFields.fields.some(item => item.label === 'Origin X (cm)')
  && particleFields.fields.some(item => item.label === 'Gravity Z'),
  'particle.timer exposes particle origin and gravity');
const firstColorFields = particleFields.fields.filter(item => item.label.startsWith('Colour stop 1 '));
check(firstColorFields.map(item => item.label).join(',')
  === 'Colour stop 1 R,Colour stop 1 G,Colour stop 1 B,Colour stop 1 A'
  && firstColorFields.map(item => item.path.at(-1)).join(',') === 'U34,U35,U36,U33',
  'particle.timer presents RGBA consistently while mapping onto native ARGB fields');
const rgbaCanary: readonly RgbaColor[] = [
  [0.1, 0.2, 0.3, 0.4], [0.5, 0.6, 0.7, 0.8], [0.9, 1, 1.1, 1.2], [1.3, 1.4, 1.5, 1.6],
];
const nativeColorCanary = nativeArgbFieldsFromRgbaColorStops(rgbaCanary);
check(nativeColorCanary.U33 === 0.4 && nativeColorCanary.U34 === 0.1
  && nativeColorCanary.U47 === 1.4 && nativeColorCanary.U48 === 1.5
  && emitterColorStopsFromNativeArgb(nativeColorCanary).map(stop => stop.join(',')).join('|')
    === rgbaCanary.map(stop => stop.join(',')).join('|'),
  'central emitter colour adapter round-trips semantic RGBA through native ARGB without channel drift');
const snowEmitter: EffectNode = {
  id: 'test:snow-emitter', mainType: 2, semanticType: 'particle.timer', references: {},
  payload: { type2: { SubType: 0, type2Sub0: {
    U0: 200, U1: 5, U2: -1, U3: 0.6, U4: 120, U5: 2, U6: 50, U7: 0.4, U8: 0.04,
    U9: 0, U10: -300, U11: 0,
    U12: 10, U13: 0, U14: 0, U15: 0, U16: 0, U17: 10,
    U18: 0, U19: -3600, U20: 2500, U21: 0, U22: 0, U23: 1100,
    U24: 0, U25: 600, U26: 0, U27: 800, U28: 0, U29: 0,
    U30: 0, U31: 0, U32: -4000,
    U33: 0.2, U34: 0.5, U35: 0.5, U36: 0.5,
    U37: 0.6, U38: 0.2, U39: 0.2, U40: 0.3,
    U41: 0.3, U42: 0.1, U43: 0.1, U44: 0.1,
    U45: 0, U46: 0, U47: 0, U48: 0, U49: 2, U50: 0,
  } } },
};
const snowLaw = timerEmitterPreviewLaw(snowEmitter)!;
check(Math.abs(snowLaw.rate - (200 / 2.2)) < 1e-9 && snowLaw.spawnAxes.length === 2
  && snowLaw.velocityAxes.length === 3 && snowLaw.gravity[2] === -4000,
  'persistent emitter law preserves the native occupancy rate, spawn axes, velocity box, and gravity');
check(timerEmitterPreviewLifetime(snowLaw, true, 0.5) === 2,
  'persistent emitter lifetime comes from U5 +/- U7/2 rather than the U2 stream sentinel');
check(snowLaw.trailCopies === 5 && snowLaw.trailStep === 0.04
  && snowLaw.colors[0].join(',') === '0.5,0.5,0.5,0.2',
  'persistent emitter trail law rotates native ARGB stops to renderer RGBA');
// UNTRACK graph/effect 10 is the corpus's only CollideEmitter. Snowknife preserves its U2..U48 words as signed
// integers, so Slopesmith must reinterpret rather than numerically convert them before feeding the shared P6 law.
const snowTreeCollisionEmitter: EffectNode = {
  id: 'test:snow-tree-collision-emitter', mainType: 2, semanticType: 'particle.collision', references: {},
  payload: { type2: { SubType: 2, type2Sub2: {
    U0: 50, U1: 0, U2: 1008981770, U3: 1065353216, U4: 1128792064, U5: 1073741824,
    U6: 1120403456, U7: 1065353216, U8: 1022739087, U9: 1107637043, U10: 1151033344,
    U11: -1037041664, U12: 0, U13: 0, U14: 1140457472, U15: 1140457472, U16: 0, U17: 0,
    U18: 0, U19: 0, U20: 1145569280, U21: 0, U22: 0, U23: 1125515264, U24: 1145569280,
    U25: 0, U26: 0, U27: 0, U28: -1001914368, U29: 0, U30: 0, U31: 0, U32: 1133903872,
    U33: 1025758986, U34: 1060991140, U35: 1062668861, U36: 1064849900, U37: 0, U38: 0,
    U39: 0, U40: 1053609165, U41: 1036831949, U42: 1036831949, U43: 1036831949,
    U44: 1036831949, U45: 0, U46: 0, U47: 0, U48: 0, U49: 2, U50: 0,
  } } },
};
const snowTreeFields = collisionEmitterFields(snowTreeCollisionEmitter)!;
const snowTreeLaw = timerEmitterPreviewLaw(snowTreeCollisionEmitter)!;
check(snowTreeFields.U0 === 50 && snowTreeFields.U49 === 2 && snowTreeFields.U50 === 0
  && Math.abs((snowTreeFields.U2 as number) - 0.01) < 1e-7
  && Math.abs((snowTreeFields.U9 as number) - 33.3) < 1e-4 && snowTreeFields.U10 === 1243
  && snowTreeFields.U11 === -44,
  'collision emitter preserves integer selectors and reinterprets its raw f32 origin/window words');
check(snowTreeLaw.count === 50 && snowTreeLaw.spriteIndex === 2 && snowTreeLaw.blendSelector === 0
  && snowTreeLaw.sizeCenter === 200 && snowTreeLaw.particleLifeCenter === 2
  && snowTreeLaw.velocityBase[2] === 800 && snowTreeLaw.velocityAxes[1][0] === 800
  && snowTreeLaw.velocityAxes[2][1] === -800 && snowTreeLaw.gravity[2] === 300
  && Math.abs(snowTreeLaw.colors[0][3] - 0.04) < 1e-7,
  'UNTRACK collision emitter reaches the shared snow-burst preview law');
const snowTreeInspector = semanticInspectorForNode(snowTreeCollisionEmitter);
const snowTreeOriginX = snowTreeInspector.fields.find(field => field.label === 'Stored origin X (runtime replaced)')!;
check(snowTreeInspector.fields.length === 51 && snowTreeOriginX.codec === 'f32-bits'
  && Math.abs(semanticNumberValue(snowTreeCollisionEmitter, snowTreeOriginX)! - 33.3) < 1e-4,
  'collision emitter panel exposes all 51 fields while decoding its float-bit words');
check(setSemanticNumberValue(snowTreeCollisionEmitter, snowTreeOriginX, 12.5)
  && (snowTreeCollisionEmitter.payload.type2 as { type2Sub2: { U9: number } }).type2Sub2.U9 === 1095237632
  && collisionEmitterFields(snowTreeCollisionEmitter)?.U9 === 12.5
  && setParticleEmitterField(snowTreeCollisionEmitter, 'U49', 4)
  && (snowTreeCollisionEmitter.payload.type2 as { type2Sub2: { U49: number } }).type2Sub2.U49 === 4,
  'collision emitter controls encode floats back to raw words while keeping selectors as integers');
const contactBase = collisionEmitterContactVelocityBase(snowTreeLaw.velocityBase, [0, 3, 4]);
check(contactBase[0] === 0 && contactBase[1] === 480 && contactBase[2] === 640
  && emitterWorldPosition(snowTreeCollisionEmitter) === null,
  'collision emitter retains the authored 800 cm/s magnitude, redirects it along the normalized contact, and exposes no false origin gizmo');
const collisionEmitterTemplate = EFFECT_TEMPLATES.find(template => template.id === 'collision-emitter')!;
const authoredSnowBurst = collisionEmitterTemplate.nodes?.[0] as EffectNode;
check(collisionEmitterTemplate.circumstance === 'collision' && authoredSnowBurst.semanticType === 'particle.collision'
  && (authoredSnowBurst.payload.type2 as { SubType: number }).SubType === 2
  && timerEmitterPreviewLaw(authoredSnowBurst)?.count === 50
  && !UNAUTHORABLE_EFFECT_NODES.some(entry => entry.semanticType === 'particle.collision'),
  'Snow collision burst is an authorable collision-node template with the recovered UNTRACK preview law');
const fireworkEmitter: EffectNode = {
  id: 'test:firework-emitter', mainType: 2, semanticType: 'particle.timer', references: {},
  payload: { type2: { SubType: 0, type2Sub0: {
    U0: 200, U1: 8, U2: 0.4, U3: 1.5, U4: 15, U5: 1.1, U6: 25, U7: 1.7, U8: 0.012,
    U20: 3800, U23: 2400, U24: 2400, U28: 2900, U32: -3000,
    U33: 0.6, U34: 0.2, U35: 1, U36: 0.2,
    U37: 0.4, U38: 1, U39: 0.2, U40: 0.2,
    U41: 1, U42: 0.1, U43: 0.1, U44: 0.1,
    U45: 0, U46: 0, U47: 0, U48: 0, U49: 0, U50: 0,
  } } },
};
const fireworkLaw = timerEmitterPreviewLaw(fireworkEmitter)!;
const fireworkSize = timerEmitterPreviewSizeRange(fireworkLaw, 1, false);
const fireworkRandom = [0.5, 0.5, 0.25, 0.75, 0.25];
const fireworkSample = timerEmitterPreviewSample(fireworkLaw, () => fireworkRandom.shift() ?? 0.5);
const fireworkOffset = timerEmitterPreviewTrajectoryOffset(fireworkLaw, fireworkSample.velocity, 0.5);
// U4=15 +/- U6/2=12.5 is a half-extent pair, so the drawn widths are 2*2.5/100 and 2*27.5/100 metres.
check(Math.abs(fireworkSize.min - 0.05) < 1e-9 && Math.abs(fireworkSize.max - 0.55) < 1e-9
  && timerEmitterPreviewOpacity(0.2, true) === 0.45
  && timerEmitterPreviewOpacity(0.2, false) === 0.2,
  'a one-shot firework draws at its authored width, with only interactive alpha floored above ambient');
check(fireworkLaw.trailCopies === 8 && PARTICLE_SPRITE_NAMES[fireworkLaw.spriteIndex] === 'part'
  && fireworkLaw.blendSelector === 0 && Math.abs(timerEmitterPreviewLifetime(fireworkLaw, false, 0.5) - 1.1) < 1e-9
  && fireworkLaw.colors[0].join(',') === '0.2,1,0.2,0.6',
  'firework preview preserves the native trail, sprite, blend, lifetime, and ARGB-to-RGBA colour decode');
// Snowdream's road flares (SNOW slot 46 -> Effect 107) are the darkening case: a near-black plume authored at
// alpha 0.08 whose blend multiplies the framebuffer toward black. Drawing it additively - the renderer's only
// mode before - adds nothing to the frame and the smoke is invisible, which is exactly what the level showed.
const flareEmitter: EffectNode = {
  id: 'test:flare-emitter', mainType: 2, semanticType: 'particle.timer', references: {},
  payload: { type2: { SubType: 0, type2Sub0: {
    U0: 100, U1: 5, U2: -1, U3: 1, U4: 40, U5: 0.65, U6: 40, U7: 1.2, U8: 0.009,
    U19: 200, U22: 400, U24: 400, U29: 400, U32: 800,
    U33: 0.08, U34: 0.9, U35: 0.9, U36: 0.9,
    U37: 0, U38: 0, U39: 0, U40: 0.9,
    U41: 0.1, U42: 0.2, U43: 0.2, U44: 0.1,
    U45: 0, U46: 0, U47: 0, U48: 0, U49: 2, U50: 4,
  } } },
};
const flareLaw = timerEmitterPreviewLaw(flareEmitter)!;
check(flareLaw.blendSelector === 4 && emitterBlendMode(flareLaw.blendSelector) === 'darken'
  && PARTICLE_SPRITE_NAMES[flareLaw.spriteIndex] === 'clod'
  && Math.abs(flareLaw.colors[0][3] - 0.08) < 1e-9,
  'the flare plume decodes as a darkening layer, so its preview cannot be drawn additively');
check(emitterBlendMode(0) === 'additive' && emitterBlendMode(1) === 'alpha'
  // The authored selector is remapped before it reaches the GS, so only 1 and 4 leave the additive path -
  // matching snowknife's SsfLogic.BlendMode table and the Unity importer's alpha/darken split.
  && [2, 3, 5, 6, 7, 9].every(selector => emitterBlendMode(selector) === 'additive'),
  'the blend remap sends only the alpha and darkening selectors off the additive path');
check(emitterBlendLabel(0) === 'Additive' && emitterBlendLabel(1) === 'Alpha blend'
  && emitterBlendLabel(4) === 'Darkening' && emitterBlendLabel(2) === 'Unnamed mode 2',
  'the inspector names the three authored selectors and keeps any other value numbered');
check(fireworkSample.spawnOffset.every(value => value === 0)
  && Math.abs(fireworkSample.velocity[0] - 600) < 1e-9
  && Math.abs(fireworkSample.velocity[1] + 725) < 1e-9
  && Math.abs(fireworkSample.velocity[2] - 3200) < 1e-9,
  'firework preview samples base velocity plus three centered half-range axes');
check(Math.abs(timerEmitterPreviewStartDelay(fireworkLaw, 199) - 0.398) < 1e-9
  && Math.abs(fireworkOffset[0] - 193.575) < 1e-9
  && Math.abs(fireworkOffset[1] + 233.903125) < 1e-9
  && Math.abs(fireworkOffset[2] - 677.65) < 1e-9,
  'firework preview reproduces the U2 emission window and shared P6 trajectory curve');
await withRetailFiles('retail effect-sound integration assertions', ['GARI/Audio/SFX', 'SNOW/Audio/SFX'], async () => {
  const fireworkSound = await readCourseEffectSoundBytes('GARI', 82);
  check(fireworkSound.length > 60000 && fireworkSound.subarray(0, 4).toString('ascii') === 'RIFF',
    'SoundPlay 82 resolves to the extracted GARI course bank rather than an identically numbered shared-bank clip');
  const snowmachineSound = await readNamedEffectSoundBytes('SNOW', 0, 'Snowmachine');
  check(snowmachineSound.length > 100000 && snowmachineSound.subarray(0, 4).toString('ascii') === 'RIFF',
    'SnowBlower external event 90 reads the decoded Snowmachine global-bank clip');
});
const propertyTimer: EffectNode = {
  id: 'test:property-timer', mainType: 0, semanticType: 'property.timer', payload: { type0: { SubType: 8 } }, references: {},
};
check(semanticInspectorForNode(propertyTimer).fields.every(item => !item.label.includes('Origin') && !item.label.includes('Gravity')),
  'property.timer stays distinct from a timed particle emitter');
const animObject: EffectNode = {
  id: 'test:anim-object', mainType: 0, semanticType: 'property.anim-object',
  payload: { type0: { SubType: 256, type0Sub256: { U0: 2, U1: -1, U2: -1, U3: 30, U4: 0, U5: 1, U6: 0, U7: 3 } } },
  references: {},
};
const animObjectInspector = semanticInspectorForNode(animObject);
check(animObjectInspector.fields.map(item => item.label).includes('Rate (frames/second)'),
  'AnimObject exposes its proven loop, window, rate, randomization, and direction fields');
check(animObjectInspector.fields.find(item => item.label === 'Loop mode')?.options?.map(option => option.label).join(',')
  === 'Play once,Wrap,Ping-pong'
  && animObjectInspector.fields.find(item => item.label === 'Direction mode')?.options?.map(option => option.label).join(',')
  === 'Forward,Reverse',
  'AnimObject loop and direction modes expose named editor choices');
const decodedAnimObject = animObjectFromNode(animObject)!;
const wrapAnimObject = { ...decodedAnimObject, loopMode: 1 };
const animPlayback = createAnimObjectPlayback(wrapAnimObject, 60, 269);
check(decodedAnimObject.loopMode === 2 && decodedAnimObject.rate === 30
  && stepAnimObjectPlayback(animPlayback, wrapAnimObject, 1) === 30,
  'AnimObject decoder and player advance the native 30 fps model clock at real time');
check(stepAnimObjectPlayback(animPlayback, wrapAnimObject, 1) === 0,
  'AnimObject wrap mode returns to the start of its resolved full-clip window');
const triggeredAnimation = createTriggeredAnimObjectPlayback(
  { ...decodedAnimObject, loopMode: 0, reverse: false, randomStart: false }, 60, 1, true,
  ANIMATED_PROP_AUTO_RESET_SECONDS);
const triggeredAtEnd = stepTriggeredAnimObjectPlayback(triggeredAnimation, 2);
const triggeredDuringHold = stepTriggeredAnimObjectPlayback(triggeredAnimation,
  ANIMATED_PROP_AUTO_RESET_SECONDS - 0.25);
const triggeredReturning = stepTriggeredAnimObjectPlayback(triggeredAnimation, 0.75);
const triggeredRestored = stepTriggeredAnimObjectPlayback(triggeredAnimation, 1.5);
check(triggeredAtEnd.frame === 60 && triggeredAnimation.autoReturnDelay === 8
  && triggeredDuringHold.frame === 60 && triggeredReturning.frame === 45
  && triggeredRestored.frame === 0 && triggeredRestored.done,
  'a triggered Play animation runs outward, holds eight seconds, and reverses exactly back to rest');
const retriggeredAnimation = createTriggeredAnimObjectPlayback(
  { ...decodedAnimObject, loopMode: 0, reverse: false, randomStart: false }, 60, 1, true,
  ANIMATED_PROP_AUTO_RESET_SECONDS);
stepTriggeredAnimObjectPlayback(retriggeredAnimation, 9.5); // 2 s outbound + 7.5 s of the hold
check(retriggerTriggeredAnimObjectPlayback(retriggeredAnimation)
  && stepTriggeredAnimObjectPlayback(retriggeredAnimation, 1).frame === 60,
  're-triggering an open animated prop extends its eight-second hold without snapping it shut');
const animDelta: EffectNode = {
  id: 'test:anim-delta', mainType: 0, semanticType: 'property.anim-delta', references: {},
  payload: { type0: { SubType: 257, type0Sub257: {
    U0: 2, U1: 0, U2: 30, U3: 30, U4: 0, U5: 1, U6: 0, U7: 3,
  } } },
};
const decodedAnimDelta = animDeltaFromNode(animDelta)!;
const deltaPlayback = createAnimDeltaPlayback(decodedAnimDelta, 30, 154);
check(semanticInspectorForNode(animDelta).fields.some(item => item.label === 'Rate (frames/second)'),
  'AnimDelta exposes its recovered clip window, rate, and playback fields');
check(stepAnimDeltaPlayback(deltaPlayback, decodedAnimDelta, 1) === 0,
  'AnimDelta starts frozen without a control-message budget');
grantAnimDeltaPlayback(deltaPlayback, 30);
check(stepAnimDeltaPlayback(deltaPlayback, decodedAnimDelta, 1) === 30 && deltaPlayback.budgetSeconds === 0,
  'AnimDelta command value 30 grants exactly one second and one kicker half-cycle');
grantAnimDeltaPlayback(deltaPlayback, 30);
check(stepAnimDeltaPlayback(deltaPlayback, decodedAnimDelta, 1) === 0,
  'a second AnimDelta grant toggles the ping-pong kicker back to rest');
check(JSON.stringify(effectPlayCommand({
  id: 'test:delta-grant', mainType: 3, semanticType: 'animation.delta-grant', references: {},
  payload: { type3: { U0: 2, U1: 30 } },
})) === JSON.stringify({ kind: 'property-control', command: 2, value: 30 }),
  'Play runtime preserves the receiver-dependent AnimDelta control message');

// ---- AnimCombo (sub 258) -------------------------------------------------------------------------------
// The payload is Aloha effect 227 verbatim, which is also Megaplex effect 80: the corpus authors this node
// twice and both copies are byte-identical. It rides `Mdl_BarrierDynamic_SideToSide_*`, a 100-frame clip
// whose 0..60 window slides the barrier and whose 61..100 window rotates it flat and back.
const animComboNode: EffectNode = {
  id: 'test:anim-combo', mainType: 0, semanticType: 'property.anim-combo', references: {},
  payload: { type0: { SubType: 258, type0Sub258: {
    U0: 2, U1: 0, U2: 60, U3: 30, U4: 0, U5: 1, U6: 1, U7: 3, U8: 61, U9: 100, U10: 30, U11: 0,
  } } },
};
const animCombo = animComboFromNode(animComboNode)!;
check(animCombo.loopMode === 2 && animCombo.startFrame === 0 && animCombo.endFrame === 60
  && animCombo.comboStartFrame === 61 && animCombo.comboEndFrame === 100
  && animCombo.comboRate === 30 && animCombo.comboEnd === 'resume' && animCombo.randomStart,
  'AnimCombo decodes the retail barrier as a ping-pong idle window plus a resuming 61..100 combo window');
check(semanticInspectorForNode(animComboNode).fields.map(item => item.label).join(',')
  .includes('Combo window start (frame)'),
  'AnimCombo exposes its recovered combo window, rate and end-behaviour fields');
const comboPlayback = createAnimComboPlayback({ ...animCombo, randomStart: false }, 100, 468);
check(comboPlayback.comboStart === 61 && comboPlayback.comboEnd === 100 && comboPlayback.frame === 0,
  'AnimCombo resolves its triggered window at construction and starts on the idle window');
const idleHalfSecond = stepAnimComboPlayback(comboPlayback, animCombo, 0.5);
check(idleHalfSecond.frame === 15 && idleHalfSecond.basis === null,
  'an untriggered AnimCombo advances its idle clip alone, with no pose to compose onto');
check(triggerAnimComboPlayback(comboPlayback) && comboPlayback.snapshotFrame === 15,
  'command 3 snapshots the idle frame the prop is standing on');
check(!triggerAnimComboPlayback(comboPlayback),
  'a running AnimCombo refuses a second trigger, as the engine\'s two-byte guard does');
const comboFirst = stepAnimComboPlayback(comboPlayback, animCombo, 0.5);
check(Math.abs(comboFirst.frame - 76) < 1e-9 && comboFirst.basis === 15
  && comboPlayback.frame === 15,
  'a running AnimCombo advances the combo clock, freezes the idle clock, and composes onto the snapshot');
const comboEnded = stepAnimComboPlayback(comboPlayback, animCombo, 2);
check(comboEnded.frame === 15 && comboEnded.basis === null && !comboPlayback.active,
  'a resuming AnimCombo drops straight back to its held idle frame on the tick the window ends');
check(stepAnimComboPlayback(comboPlayback, animCombo, 0.5).frame === 30
  && triggerAnimComboPlayback(comboPlayback),
  'a resuming AnimCombo carries its idle slide on from where it stopped and can be triggered again');
const holdCombo: AnimComboEffect = { ...animCombo, comboEnd: 'hold-combo' };
const holdPlayback = createAnimComboPlayback({ ...holdCombo, randomStart: false }, 100, 468);
stepAnimComboPlayback(holdPlayback, holdCombo, 0.5);
triggerAnimComboPlayback(holdPlayback);
stepAnimComboPlayback(holdPlayback, holdCombo, 5);
const heldCombo = stepAnimComboPlayback(holdPlayback, holdCombo, 5);
check(heldCombo.frame === 100 && heldCombo.basis === 15 && holdPlayback.latched
  && !triggerAnimComboPlayback(holdPlayback),
  'a negative end word latches the node holding the last combo frame and refuses to re-arm');
const freezeCombo: AnimComboEffect = { ...animCombo, comboEnd: 'freeze' };
const freezePlayback = createAnimComboPlayback({ ...freezeCombo, randomStart: false }, 100, 468);
stepAnimComboPlayback(freezePlayback, freezeCombo, 0.5);
triggerAnimComboPlayback(freezePlayback);
stepAnimComboPlayback(freezePlayback, freezeCombo, 5);
const frozen = stepAnimComboPlayback(freezePlayback, freezeCombo, 5);
check(frozen.frame === 15 && frozen.basis === null && freezePlayback.latched,
  'a positive end word latches the node back onto its frozen idle pose');
const defaultedCombo = animComboFromNode({ ...animComboNode, id: 'test:anim-combo-defaults',
  payload: { type0: { SubType: 258, type0Sub258: {
    U0: 2, U1: 0, U2: 60, U3: 30, U4: 0, U5: 1, U6: 0, U7: 3, U8: -1, U9: -1, U10: 30, U11: 0,
  } } } })!;
const defaultedPlayback = createAnimComboPlayback(defaultedCombo, 100, 1);
check(defaultedPlayback.comboStart === 60 && defaultedPlayback.comboEnd === 100,
  'a blank combo window falls back to the idle window\'s end and the whole clip, not to the same default twice');
const halfTurn = samplePropModelRotation({ clipFrames: 60, axis: 2,
  segments: [[0, 0, 179.82031, 0, 0, 2]] }, 30);
check(Math.abs(halfTurn - 179.82031) < 1e-6,
  'model rotation curves use native absolute-second Horner sampling');
const identityChannel = { AnimationMaths: [{
  Value1: 0, Value2: 0, Value3: 0, Value4: 0, Value5: 0, Value6: 1,
}] };
const kickerRotation = simpleModelRotation({ ModelName: 'Mdl_Dynkicker_Event1', AnimTime: 30,
  ModelObjects: [{ MeshData: [{ MeshPath: '23.obj', MaterialID: 2 }], Animation: {
    AnimationAction: 63,
    AnimationEntries: [identityChannel, identityChannel, identityChannel, identityChannel, {
      AnimationMaths: [{ Value1: 0, Value2: 0, Value3: 26.984589, Value4: 0, Value5: 0, Value6: 1 }],
    }, identityChannel],
  } }],
});
check(kickerRotation?.axis === 1 && Math.abs(samplePropModelRotation(kickerRotation, 30) - 26.984589) < 1e-6,
  'compound six-channel model clips retain the kicker’s single moving Y-rotation channel');
const linearChannel = (perSecond: number) => ({ AnimationMaths: [{
  Value1: 0, Value2: 0, Value3: perSecond, Value4: 0, Value5: 0, Value6: 8,
}] });
const blimpAnimation = simpleModelRotation({ ModelName: 'Mdl_Blimp_SSXANIM_0', AnimTime: 240,
  ModelObjects: [
    { ParentID: -1, MeshData: null, Animation: null },
    { ParentID: 0, MeshData: [{ MeshPath: 'body.obj', MaterialID: 2 }], Animation: {
      AnimationAction: 39,
      AnimationEntries: [linearChannel(100), linearChannel(200), linearChannel(50), linearChannel(10)],
    } },
    { ParentID: 1, MeshData: [{ MeshPath: 'tail.obj', MaterialID: 3 }], Animation: null },
  ],
});
const blimpTranslation = blimpAnimation ? samplePropModelTranslation(blimpAnimation, 60) : null;
check(blimpAnimation?.axis === 2 && blimpTranslation?.join(',') === '200,400,100'
  && Math.abs(samplePropModelRotation(blimpAnimation, 60) - 20) < 1e-6,
  'merged model clips retain a shared animated subtree’s XYZ travel and Z turn for the Merqury blimp');
const blimpChannels = blimpAnimation ? propModelAnimationChannels(blimpAnimation) : [];
check(blimpChannels.map(channel => `${channel.label}:${channel.segments}:${channel.boundaryFrames.join(',')}`).join('|')
  === 'Position X:1:0,240|Position Y:1:0,240|Position Z:1:0,240|Rotation Z:1:0,240'
  && !!blimpAnimation && samplePropModelAnimationChannel(blimpAnimation, 'translate-y', 60) === 400,
  'reference clip timeline derives channel-specific cubic boundaries and sampled values on the native frame axis');
const segmentedChannels = propModelAnimationChannels({ clipFrames: 240, axis: 2,
  segments: [
    [0, 0, 0, 0, 0, 2], [0, 0, 0, 0, 2, 5], [0, 0, 0, 0, 5, 8],
  ],
  translation: [
    [[0, 0, 0, 0, 0, 4], [0, 0, 0, 0, 4, 8]],
    [[0, 0, 0, 0, 0, 3], [0, 0, 0, 0, 3, 8]],
    [[0, 0, 0, 0, 0, 4], [0, 0, 0, 0, 4, 8]],
  ],
});
check(segmentedChannels.map(channel => `${channel.segments}:${channel.boundaryFrames.join(',')}`).join('|')
  === '2:0,120,240|2:0,90,240|2:0,120,240|3:0,60,150,240',
  'timeline markers remain channel-specific when recovered cubic segment boundaries do not align');
const objectRest = modelObjectRestMatrices({ ModelName: 'Broken hierarchy', ModelObjects: [
  { ParentID: -1, Position: [10, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1], MeshData: null },
  { ParentID: 0, Position: [0, 20, 0], Rotation: [0, 0, 0, 1], Scale: [2, 1, 1], MeshData: null },
] });
const transformedShard = new THREE.Vector3(1, 2, 3).applyMatrix4(objectRest[1]);
check(transformedShard.distanceTo(new THREE.Vector3(12, 22, 3)) < 1e-9,
  'model object rest hierarchy keeps child shards at their authored positions and orientation');

const reordered = cloneEffectsDocument(document);
reordered.graphs[0].originalIndex = 99;
check(validateEffectsDocument(reordered).length === 0, 'stable IDs remain authoritative when provenance indices change');

const dangling = cloneEffectsDocument(document);
dangling.slots[0].circumstances.persistent = 'graph:missing';
check(validateEffectsDocument(dangling).some(i => i.path.endsWith('.persistent')), 'dangling stable reference is rejected');

const duplicate = cloneEffectsDocument(document);
duplicate.graphs.push(cloneEffectsDocument(document).graphs[0]);
check(validateEffectsDocument(duplicate).some(i => i.message.includes('duplicate id')), 'duplicate table ID is rejected');

const mountain = defaultMountain();
check(mountain.effects?.kind === 'openslope-effects' && mountain.effects.target.level === mountain.name,
  'new mountain initializes its Effects document');
const mountainWithoutEffects = JSON.parse(JSON.stringify(mountain));
delete mountainWithoutEffects.effects;
const initializedMountain = migrateMountain(mountainWithoutEffects);
check(initializedMountain.effects?.kind === 'openslope-effects' && initializedMountain.effects.target.level === initializedMountain.name,
  'loading a mountain without effects initializes its Effects document');
const legacyEffectsMountain = JSON.parse(JSON.stringify(mountain)) as Record<string, unknown>;
const legacyEffects = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
legacyEffects.kind = 'ssx-effects';
legacyEffects.$schema = 'ssx-effects-v1.schema.json';
legacyEffectsMountain.effects = legacyEffects;
const migratedEffectsMountain = migrateMountain(legacyEffectsMountain);
check(migratedEffectsMountain.effects?.kind === 'openslope-effects'
  && migratedEffectsMountain.effects.$schema === 'openslope-effects-v1.schema.json'
  && JSON.stringify(migratedEffectsMountain.effects.graphs) === JSON.stringify(document.graphs),
  'loading a mountain with a pre-rename Effects document upgrades its contract identity');
mountain.effects = document;
const loadedMountain = migrateMountain(JSON.parse(JSON.stringify(mountain)));
check(JSON.stringify(loadedMountain.effects) === JSON.stringify(document), 'Slopesmith mountain save/load preserves Effects.json');
mountain.sun = { ...mountain.sun!, on: false };
const files = buildMountainLevel(mountain, undefined, { lighting: false });
check(files.text['Effects.json'] === serialized, 'Slopesmith level export emits the shared Effects.json verbatim');

const syntheticParticleInstances = [{
  ParticleName: 'Fixture fog', ParticleModelIndex: 0,
  Location: [100, 200, 300], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1],
  LowestXYZ: [0, 100, 200], HighestXYZ: [200, 300, 400],
}];
const syntheticParticleModels = [{ ParticleObjectHeaders: [{ ParticleObject: {
  LowestXYZ: [-100, -100, -100], HighestXYZ: [100, 100, 100], U1: 2914832,
  AnimationFrames: [{ Position: [0, 0, 0], Rotation: [1, 1, 1], Unknown: 100 }],
} }] }];
let gariFog = particleVolumesFromNative(syntheticParticleInstances, syntheticParticleModels);
await withRetailFiles('GARI particle-table integration assertion',
  ['GARI/ParticleInstances.json', 'GARI/ParticleModels.json'], () => {
    const gariParticleInstances = JSON.parse(readFileSync(retailFile('GARI/ParticleInstances.json'), 'utf8')) as
      { Particles: unknown[] };
    const gariParticleModels = JSON.parse(readFileSync(retailFile('GARI/ParticleModels.json'), 'utf8')) as
      { ParticlePrefabs: unknown[] };
    gariFog = particleVolumesFromNative(gariParticleInstances.Particles, gariParticleModels.ParticlePrefabs);
    check(gariFog.length === 10 && gariFog.reduce((count, volume) => count
      + volume.objects.reduce((subtotal, object) => subtotal + object.puffs.length, 0), 0) === 102,
      'native GARI particle tables join into 10 standalone fog volumes and 102 puffs');
  });
await withRetailFiles('ELYSIUM particle-table integration assertion',
  ['ELYSIUM/ParticleInstances.json', 'ELYSIUM/ParticleModels.json'], () => {
    const elysiumParticleInstances = JSON.parse(
      readFileSync(retailFile('ELYSIUM/ParticleInstances.json'), 'utf8')) as { Particles: unknown[] };
    const elysiumParticleModels = JSON.parse(
      readFileSync(retailFile('ELYSIUM/ParticleModels.json'), 'utf8')) as { ParticlePrefabs: unknown[] };
    const elysiumFog = particleVolumesFromNative(
      elysiumParticleInstances.Particles, elysiumParticleModels.ParticlePrefabs);
    check(elysiumFog.length === 59 && elysiumParticleModels.ParticlePrefabs.length === 19
      && elysiumFog.every(volume => volume.objects.some(object => object.puffs.length)),
      'native model-index join preserves all 59 ELYSIUM placements sharing 19 puff models');
  });
const nativeFog = particleVolumesToNative(gariFog);
check(nativeFog.instances.Particles.length === gariFog.length && nativeFog.models.ParticlePrefabs.length === gariFog.length
  && (nativeFog.instances.Particles[0] as { ParticleName: string; ParticleModelIndex: number }).ParticleName === gariFog[0].name
  && (nativeFog.instances.Particles[0] as { ParticleModelIndex: number }).ParticleModelIndex === 0,
  'fog-volume authoring emits paired native ParticleInstances/ParticleModels tables');
const fogMountain = defaultMountain();
fogMountain.particleVolumes = [gariFog[0]];
const migratedFogMountain = migrateMountain(JSON.parse(JSON.stringify(fogMountain)));
check(migratedFogMountain.particleVolumes?.[0].objects[0].puffs.length === gariFog[0].objects[0].puffs.length,
  'mountain save/load preserves native fog puff models');
const fogFiles = buildMountainLevel(migratedFogMountain, undefined, { lighting: false });
check(!!fogFiles.text['ParticleInstances.json'] && !!fogFiles.text['ParticleModels.json'],
  'Slopesmith level export includes the repackable native fog table pair');
const fogExportDir = mkdtempSync(join(tmpdir(), 'slopesmith-fog-export-'));
try {
  const fogExport = await exportLevel(migratedFogMountain, { outDir: fogExportDir, lighting: false });
  check(existsSync(join(fogExportDir, 'Textures', 'Particles', 'fog0.png'))
    || fogExport.log.includes('WARN: shared fog0.png missing'),
    'fresh Slopesmith fog export stages the shared fog0 sprite or reports that the optional retail sprite is unavailable');
} finally {
  rmSync(fogExportDir, { recursive: true, force: true });
}

const authored = parseEffectsDocument(JSON.parse(JSON.stringify({
  kind: 'openslope-effects', version: 1,
  target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level: 'TEST' },
  header: { U1: 1966592, U2: 1053952, U3: 0.006 },
  slots: [], graphs: [], functions: [], objectProperties: [], instances: [], physics: [], collisionModels: [], splines: [], extensions: {},
})));
const emitterSel = addEffectTemplate(authored, 'timer-emitter');
check(authored.graphs.length === 1 && authored.slots[0].circumstances.persistent === authored.graphs[0].id,
  'timer template creates a graph and wired persistent slot');
check(validateEffectsAuthoring(authored).length === 0, 'fresh template is structurally and semantically valid');
const canonicalTemplateDoc = createEmptyEffectsDocument('SEMANTICS');
const waitSel = addEffectTemplate(canonicalTemplateDoc, 'wait');
const trickSel = addEffectTemplate(canonicalTemplateDoc, 'trick-boost');
const rollerSel = addEffectTemplate(canonicalTemplateDoc, 'roller');
check(effectNode(canonicalTemplateDoc, waitSel)?.semanticType === 'wait'
  && effectNode(canonicalTemplateDoc, trickSel)?.semanticType === 'trick.boost'
  && JSON.stringify(effectPlayCommand(effectNode(canonicalTemplateDoc, rollerSel)!))
    === JSON.stringify({ kind: 'roller', mass: 5, direction: [0, 0, 0] })
  && validateEffectsDocument(canonicalTemplateDoc).length === 0,
  'node templates use canonical schema names rather than UI aliases');

const emptyEffectDoc = createEmptyEffectsDocument('EMPTY_EFFECTS');
const emptyCollision = addEmptyEffect(emptyEffectDoc, 'collision');
check(emptyEffectDoc.graphs.find(graph => graph.id === emptyCollision.ownerId)?.nodes.length === 0
  && emptyEffectDoc.slots[0]?.circumstances.collision === emptyCollision.ownerId,
  'adding an effect creates an empty graph in the chosen circumstance');
const emptyPropEffect = addEmptyEffectToProp(emptyEffectDoc, 'prop:empty-effect', 'persistent');
const emptyPropSlot = effectAttachments(emptyEffectDoc).find(item => item.target.id === 'prop:empty-effect')?.slot;
check(emptyEffectDoc.graphs.find(graph => graph.id === emptyPropEffect.ownerId)?.nodes.length === 0
  && !!emptyPropSlot && emptyEffectDoc.slots.find(item => item.id === emptyPropSlot)?.circumstances.persistent === emptyPropEffect.ownerId,
  'adding an effect to a prop attaches an empty graph instead of inserting a node template');
const emptyPropCollision = addEmptyEffectToProp(emptyEffectDoc, 'prop:empty-effect', 'collision');
check(emptyEffectDoc.slots.find(item => item.id === emptyPropSlot)?.circumstances.collision === emptyPropCollision.ownerId
  && emptyEffectDoc.graphs.find(graph => graph.id === emptyPropCollision.ownerId)?.nodes.length === 0
  && effectAttachments(emptyEffectDoc).filter(item => item.target.id === 'prop:empty-effect').length === 1,
  'additional empty effect types share the prop slot while keeping independent node lists');
const firstEmptyNode = addEffectNodeTemplate(emptyEffectDoc, emptyPropEffect, 'uv-scroll');
check(!!firstEmptyNode?.nodeId
  && emptyEffectDoc.graphs.find(graph => graph.id === emptyPropEffect.ownerId)?.nodes.length === 1,
  'a node is inserted only through the separate add-node action');

const triggerDoc = createEmptyEffectsDocument('TRIGGER');
const triggerSel = addEffectTemplateToProp(triggerDoc, 'trigger:0000', 'collision-trigger');
check(triggerDoc.graphs.find(graph => graph.id === triggerSel.ownerId)?.nodes.length === 0
  && triggerDoc.slots[0]?.circumstances.collision === triggerSel.ownerId
  && effectAttachments(triggerDoc)[0]?.target.id === 'trigger:0000',
  'trigger template creates an empty collision graph and attaches it directly to the trigger host');
const triggerPersistentSel = addEffectTemplateToProp(triggerDoc, 'trigger:0000', 'timer-emitter');
const triggerPropForBindings: PlacedProp = { id: 'trigger:0000', level: 'SLP_EFFECT_TRIGGER', model: 0,
  name: 'Trigger', pos: [0, 0, 0], yaw: 0, scale: 1 };
const triggerBindings = authoredEffectBindings(triggerDoc, [triggerPropForBindings]);
check(effectAttachments(triggerDoc)[0]?.circumstance === 'collision'
  && triggerBindings.some(binding => binding.circumstance === 'collision' && binding.graph.id === triggerSel.ownerId)
  && triggerBindings.some(binding => binding.circumstance === 'persistent' && binding.graph.id === triggerPersistentSel.ownerId),
  'a collision-first attachment exposes the whole slot, including a later persistent emitter');

const copiedNode = duplicateEffectNode(authored, emitterSel)!;
const copiedGraph = duplicateEffectOwner(authored, copiedNode)!;
check(new Set(authored.graphs.flatMap(g => [g.id, ...g.nodes.map(n => n.id)])).size
  === authored.graphs.reduce((n, g) => n + 1 + g.nodes.length, 0), 'graph/node duplication allocates unique stable IDs');
check(copiedGraph.ownerId !== emitterSel.ownerId, 'duplicated graph receives new identity');

const emitter = effectNode(authored, emitterSel)!;
let aliasRejected = false;
try { replaceEffectNodeRaw(authored, emitterSel, JSON.stringify({ ...emitter, semanticType: 'particle.custom-label' })); }
catch { aliasRejected = true; }
check(aliasRejected, 'raw node editor rejects an unregistered semantic alias');
let mismatchRejected = false;
try { replaceEffectNodeRaw(authored, emitterSel, JSON.stringify({ ...emitter, semanticType: 'trick.boost' })); }
catch { mismatchRejected = true; }
check(mismatchRejected, 'raw node editor rejects semanticType/native opcode mismatches');
const raw = JSON.stringify({ ...emitter, semanticType: 'x-test.particle-label' });
replaceEffectNodeRaw(authored, emitterSel, raw);
check(effectNode(authored, emitterSel)?.semanticType === 'x-test.particle-label', 'raw node editor preserves explicit x- extension semantics');
let rawRejected = false;
try { replaceEffectNodeRaw(authored, emitterSel, JSON.stringify({ ...effectNode(authored, emitterSel), references: { spline: 'missing' }, mainType: 25 })); }
catch { rawRejected = true; }
check(rawRejected, 'raw node editor rejects a document with dangling native references');

mountain.props = [
  { level: 'DONOR', model: 1, name: 'Emitter host', pos: [10, 20, 30], yaw: 90, scale: 2 },
  { level: 'DONOR', model: 2, name: 'Other', pos: [0, 0, 0], yaw: 0, scale: 1 },
];
ensurePlacedPropIds(mountain.props);
check(!!mountain.props[0].id && mountain.props[0].id !== mountain.props[1].id, 'pre-ID level props gain stable unique IDs');
attachEffectToProp(authored, mountain.props[0].id!, authored.slots[0].id, 'persistent');
check(effectAttachments(authored)[0].target.id === mountain.props[0].id, 'effect slot attaches to a stable level-object ID');
check(effectSelectionForProp(authored, mountain.props[0].id!)?.nodeId === emitterSel.nodeId,
  'authored prop viewport selection resolves its attached graph and particle node');
check(effectSelectionForProp(authored, mountain.props[1].id!) === null,
  'authored prop without an attachment leaves the effect selection unchanged');
check(validateEffectsAuthoring(authored, mountain.props).length === 0, 'valid level-object attachment passes editor validation');

const moverDoc = createEmptyEffectsDocument('TEST');
const moverProps: PlacedProp[] = [{ id: 'prop:mover', level: 'MERQUER', model: 1, name: 'Train',
  pos: [0, 0, 0], yaw: 0, scale: 1 }];
const moverRails: Rail[] = [
  { id: 'rail:grind', kind: 'grind', name: 'Grind rail', height: 0, nodes: [[0, 0, 0], [5, 0, 5]] },
  { id: 'path:route', kind: 'motion', name: 'Subway route', height: 0,
    nodes: [[0, 0, 0], [10, 2, 20], [30, 2, 30]] },
];
const moverSel = addEffectTemplateToProp(moverDoc, 'prop:mover', 'spline-animation');
check(bindEffectSplineToMotionPath(moverDoc, moverSel, moverRails, 'path:route'),
  'spline-mover template binds directly to an authored motion path');
const moverNode = effectNode(moverDoc, moverSel)!;
check(moverNode.references?.spline === 'spline:path:route'
  && effectPlayCommand(moverNode)?.kind === 'spline-motion',
  'authored spline mover retains a stable route reference and decodes through the shared runtime');
// Every complete course spline is mirrored, because every one of them is a row of the native table that a
// node may name: the mover follows a route, the rail toggle switches a grind rail. What each mirrored
// resource has to carry is its NATIVE index — the grind rail authored first is row 0 and the route row 1,
// which is the order `buildSplinesJson` writes them in.
const moverRoute = moverDoc.splines.find(resource => resource.id === 'spline:path:route');
const moverGrind = moverDoc.splines.find(resource => resource.id === 'spline:rail:grind');
check(moverDoc.splines.length === 2
  && moverRoute?.originalIndex === 1 && moverGrind?.originalIndex === 0
  && moverRoute?.data.SplineStyle === -1 && moverRoute?.data.U1 === -1 && moverRoute?.data.U2 === -2
  && moverGrind?.data.SplineStyle === 13 && moverGrind?.data.U1 === 1 && moverGrind?.data.U2 === 1,
  'both spline kinds enter Effects resources, each keeping its own native spline-table index and style');

// A mover may only follow a ROUTE. Binding it to the grind rail's resource has to be refused rather than
// silently accepted, or the mirroring above would have widened what a mover can point at.
const strayMover = effectNode(moverDoc, moverSel)!;
strayMover.references!.spline = 'spline:rail:grind';
syncAuthoredMotionPathEffectResources(moverDoc, moverRails);
check(strayMover.references?.spline === null,
  'a mover pointed at a grind rail is cleared, so mirroring rails does not widen what a route reference means');
bindEffectSplineToMotionPath(moverDoc, moverSel, moverRails, 'path:route');

const toggleSel = addEffectTemplateToProp(moverDoc, 'prop:mover', 'spline-toggle');
const toggleNode = effectNode(moverDoc, toggleSel)!;
check(bindEffectSplineToRail(moverDoc, toggleSel, moverRails)
  && toggleNode.references?.spline === 'spline:rail:grind'
  && toggleNode.mainType === 25,
  'a rail toggle binds to the mountain\'s grind rail rather than to a mover route');

// The lift's target is an absolute world altitude, so the whole template hinges on this being written from
// the placement. Raw centimetres, matching the exporter's own frame: 12 m up + 30 m of lift = 4200.
const liftSel = addEffectTemplateToProp(moverDoc, 'prop:mover', 'z-boost');
const liftNode = effectNode(moverDoc, liftSel)!;
const liftSub = () => (liftNode.payload as { type0: { type0Sub18: Record<string, number> } })
  .type0.type0Sub18;
check(liftSub().U5 === 0, 'a vertical lift ships with no target altitude, because no default world Z is meaningful');
check(bindZBoostToPlacement(moverDoc, liftSel, 12) && liftSub().U5 === 4200
  && liftSub().U0 === 4 && liftSub().U1 === 20 && liftSub().U4 === 1,
  'binding a vertical lift writes the target altitude from the placement in raw cm, keeping retail\'s tuning');

// A call is the one reference with nothing to fall back on: an authored mountain starts with an empty
// function table, so binding to "the first one" would leave every first call unbound — and an unbound call
// is a slot the repack compiler refuses whole. Adding the node therefore MAKES the body.
const callSel = addEffectTemplateToProp(moverDoc, 'prop:mover', 'call-function');
const callNode = effectNode(moverDoc, callSel)!;
const madeFunctionId = bindEffectFunctionCall(moverDoc, callSel);
check(callNode.mainType === 21 && !!madeFunctionId
  && callNode.references?.function === madeFunctionId
  && moverDoc.functions.some(fn => fn.id === madeFunctionId && fn.nodes.length === 0),
  'adding a call creates the empty function it names, so the node is never laid down unbound');
// A second call must not spawn a second body when the author points it at one that exists — the whole value
// of a function is that several chains run the SAME nodes.
const secondCallSel = addEffectTemplateToProp(moverDoc, 'prop:mover', 'call-function');
check(bindEffectFunctionCall(moverDoc, secondCallSel, madeFunctionId) === madeFunctionId
  && moverDoc.functions.length === 1
  && effectNode(moverDoc, secondCallSel)!.references?.function === madeFunctionId,
  'a call bound to an existing function shares that body rather than making another');
check(validateEffectsDocument(moverDoc).length === 0,
  'a document carrying authored functions and the calls into them validates clean');
check(semanticInspectorForNode(moverNode).fields.map(field => field.label).join(',')
  === 'End mode,Orientation mode,Instance count,Speed (m/s),Yaw offset (radians),Show route line,Route line red,Route line green,Route line blue,Route line opacity',
  'spline mover exposes motion plus generic route-line visibility, colour, and opacity controls');
const moverFields = semanticInspectorForNode(moverNode).fields;
check(moverFields[0]?.options?.map(option => option.label).join('|')
  === 'One-shot (finish)|Loop (wrap)|Ping-pong|Hold at end'
  && moverFields[1]?.options?.map(option => option.label).join('|')
    === 'Follow yaw + pitch|Follow yaw, stay level|Fixed yaw, follow pitch|Fixed orientation'
  && moverFields[5]?.options?.map(option => option.label).join('|') === 'Hidden|Shown',
  'spline mover semantic fields expose named end/orientation/route-line choices instead of raw mode numbers');
const routeLineVisibility = moverFields[5], routeLineRed = moverFields[6];
const routeLineInitiallyHidden = !!routeLineVisibility && semanticNumberValue(moverNode, routeLineVisibility) === 0;
const editedMoverCommand = routeLineVisibility && routeLineRed && routeLineInitiallyHidden
  && setSemanticNumberValue(moverNode, routeLineVisibility, 1)
  && setSemanticNumberValue(moverNode, routeLineRed, 0.25)
  ? effectPlayCommand(moverNode) : null;
check(!!routeLineVisibility && !!routeLineRed && routeLineInitiallyHidden
  && editedMoverCommand?.kind === 'spline-motion'
  && JSON.stringify(editedMoverCommand.splineLine) === JSON.stringify({
    enabled: true, color: [0.25, 1, 1, 1],
  }),
  'generic route-line editor fields write the native payload and feed the spline runtime representation');
moverRails.splice(1, 1);
syncAuthoredMotionPathEffectResources(moverDoc, moverRails);
// The route is gone and the grind rail is not, so the mover's reference must clear while the toggle's
// survives. Retargeting by array index is the failure this guards: the route was row 1 and the rail row 0.
check(moverDoc.splines.length === 1 && moverDoc.splines[0]?.id === 'spline:rail:grind'
  && moverNode.references?.spline === null && toggleNode.references?.spline === 'spline:rail:grind',
  'deleting an authored route clears its stable effect reference and leaves other splines\' references alone');
check(validateEffectsAuthoring(moverDoc, moverProps).length === 0,
  'a spline mover awaiting a new route remains a valid editable document');

// ---- a rail is named BY effects and owns none, so the join only reads one way ---------------------------
// Everything an author can be told about a rail in Effects mode comes out of walking that join backwards,
// and the toggle's two directions want opposite things of the rail it names.
const railUses = splineEffectUses(moverDoc, 'spline:rail:grind');
check(railUses.length === 1 && railUses[0].semanticType === 'spline.toggle'
  && railUses[0].switchesOn === true && railUses[0].ownerKind === 'graph'
  && railUses[0].nodeId === toggleNode.id,
  'the reverse lookup finds the toggle that names a rail, and which way it switches it');
check(splineEffectUses(moverDoc, 'spline:rail:missing').length === 0
  && splineEffectUses(moverDoc, null).length === 0,
  'a rail nothing names reports no uses rather than guessing at one');
check(authoredRailIdFromSpline('spline:rail:grind') === 'rail:grind'
  && authoredRailIdFromSpline('spline:path:route') === 'path:route'
  && authoredRailIdFromSpline('spline:donor:4') === null,
  'a Slopesmith spline resource maps back to the mountain spline id it was minted from');

// The grind and the pipe are unrelated records on disc, so a rail can be the curve alone — laid along a prop
// that already has the shape, which is how retail's rails are built. That makes the tube, not the kind, the
// line between what Effects mode may draw and what it may only inspect.
const bareRail: Rail = { id: 'rail:trunkline', kind: 'grind', name: 'Trunk line', height: 1.5, bare: true,
  nodes: [[0, 2, 0], [9, 2, 3]] };
check(isBareRail(bareRail) && !railHasTube(bareRail)
  && railHasTube({ ...bareRail, bare: undefined }) && !isBareRail({ ...bareRail, bare: undefined })
  && !railHasTube({ id: 'path:x', kind: 'motion', height: 0, nodes: [] })
  && !isBareRail({ id: 'path:x', kind: 'motion', height: 0, nodes: [], bare: true }),
  'a bare rail is a grind rail with no tube, and a motion path is neither bare nor tubed but not a rail');
check(nativeSplineFields(bareRail).style === 13 && nativeSplineFields(bareRail).u0 === 1
  && nativeSplineFields({ ...bareRail, startsOff: true }).style === 1,
  'dropping the tube changes nothing about the spline row: a bare rail grinds, and can still start off');

// A curve and the model along it are unrelated records, so the ONE thing that pairs them is an effect that
// names both — retail's HideShowOff, a MainType 25 and a MainType 7 in one graph. That is the whole join.
check(splinePairedProps(moverDoc, moverProps, 'spline:rail:grind').length === 0,
  'a rail whose effect touches no prop reports no paired prop rather than guessing one by proximity');
// The tube the trunk rail runs along, hidden by the very graph that toggles the rail — retail's own pairing.
const tubeProps: PlacedProp[] = [...moverProps,
  { id: 'prop:tube', level: 'MERQUER', model: 2, name: 'Trunk', pos: [2, 0, 2], yaw: 0, scale: 1 }];
const tubeHopSel = addEffectNodeTemplate(moverDoc, toggleSel, 'act-on-instance');
const tubeHopNode = tubeHopSel ? effectNode(moverDoc, tubeHopSel) : null;
if (tubeHopNode) bindInstanceHop(moverDoc, tubeHopNode, 'prop:tube', moverDoc.graphs[0].id);
const paired = splinePairedProps(moverDoc, tubeProps, 'spline:rail:grind');
check(paired.length === 1 && paired[0].prop.id === 'prop:tube'
  && paired[0].use.semanticType === 'spline.toggle',
  'a graph that toggles a rail AND acts on a prop pairs the two, and remembers which node named the rail');
check(splinePairedProps(moverDoc, tubeProps, 'spline:path:route').length === 0
  && splinePairedProps(moverDoc, tubeProps, null).length === 0,
  'the pairing follows the spline that was asked about, and an absent id pairs nothing');

// Candidacy has no authored bit on disc: retail's enable-after-event rails are authored at the NON-GRIND
// style 1 and the toggle is what makes the rail query find them. So "starts off" is a style swap, and only
// a style swap — the grind row's (1, 1) pair and the authored material choice both survive it.
const offRail: Rail = { id: 'rail:trunk', kind: 'grind', name: 'Fallen trunk', height: 0,
  style: 12, startsOff: true, nodes: [[0, 0, 0], [8, 0, 4]] };
const offFields = nativeSplineFields(offRail);
check(offFields.style === 1 && offFields.u0 === 1 && offFields.u1 === 1
  && railStyle(offRail) === 12 && railStartsOff(offRail),
  'a rail that starts off exports at the non-grind style while keeping its grind row and its own material');
check(nativeSplineFields({ ...offRail, startsOff: false }).style === 12
  && !railStartsOff({ id: 'path:x', kind: 'motion', height: 0, nodes: [], startsOff: true }),
  'switching "starts off" back restores the authored style, and a motion path is never in the network to leave');
check(!!authoredSplineId(offRail) && authoredSplineId({ kind: 'grind', height: 0, nodes: [] }) === null,
  'a spline resource id needs the rail\'s stable id, which migration fills in');

// The pairing between a toggle and the rail it names is silent in both directions — the node dispatches
// either way and the rail looks identical on the mountain — so it is the validator's to catch, on the rail.
const toggleRails: Rail[] = [{ id: 'rail:grind', kind: 'grind', name: 'Grind rail', height: 0,
  nodes: [[0, 0, 0], [5, 0, 5]] }];
const pointlessOn = validateEffectsAuthoring(moverDoc, moverProps, toggleRails);
check(pointlessOn.some(issue => issue.severity === 'warning'
  && issue.path === '$level.rails[rail:grind]' && /already grindable/.test(issue.message)),
  'switching ON a rail that was never switched off warns, because the node changes nothing');
check(validateEffectsAuthoring(moverDoc, moverProps,
  [{ ...toggleRails[0], startsOff: true }]).every(issue => !/already grindable|switches it on/.test(issue.message)),
  'the same toggle against a rail that starts off is the retail pairing and passes clean');
check(validateEffectsAuthoring(moverDoc, moverProps,
  [{ ...toggleRails[0], startsOff: true }, { id: 'rail:orphan', kind: 'grind', name: 'Orphan', height: 0,
    startsOff: true, nodes: [[0, 0, 0], [1, 0, 1]] }])
  .some(issue => issue.severity === 'warning' && issue.path === '$level.rails[rail:orphan]'
    && /no effect ever switches it on/.test(issue.message)),
  'a rail that starts off with nothing to switch it on can never be grinded, and says so');
check(validateEffectsAuthoring(moverDoc, moverProps).length === 0,
  'validating without rails is unchanged, so callers that do not carry a course are unaffected');

const host = mountain.props[0];
const spatialNode = effectNode(authored, emitterSel)!;
const target: [number, number, number] = [17.25, 23.5, 29.75];
check(setEmitterWorldPosition(spatialNode, target, host), 'spatial gizmo writes a timer-emitter origin');
const recovered = emitterWorldPosition(spatialNode, host)!;
check(Math.hypot(recovered[0] - target[0], recovered[1] - target[1], recovered[2] - target[2]) < 1e-9,
  'emitter world/local conversion round-trips through prop yaw, scale, axis conversion, and centimetres');

const doomed = authored.graphs.find(g => g.id === copiedGraph.ownerId)!;
authored.slots[0].circumstances.trigger = doomed.id;
const sharedFunction = addEffectFunction(authored);
const unassigned = unassignedEffectOwnerIds(authored, [authored.slots[0].id]);
check(!unassigned.has(emitterSel.ownerId) && !unassigned.has(doomed.id) && unassigned.has(sharedFunction.ownerId),
  'unassigned catch-all excludes every graph circumstance on attached slots and includes shared functions');
check(deleteEffectOwner(authored, copiedGraph) && authored.slots[0].circumstances.trigger === null,
  'deleting a graph clears native references instead of leaving dangling indices');

const referenceDocument = parseEffectsDocument({
  $schema: 'openslope-effects-v1.schema.json', kind: 'openslope-effects', version: 1,
  target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level: 'TEST' },
  header: { U1: 1966592, U2: 1053952, U3: 0.006 },
  slots: [{ id: 'slot:0000', originalIndex: 0, name: 'Host slot', circumstances: {
    persistent: 'graph:0000', collision: 'graph:0001', slot3: null, slot4: null,
    trigger: null, slot6: null, slot7: null,
  } }],
  graphs: [
    { id: 'graph:0000', originalIndex: 0, name: 'Smoke', nodes: [{
      id: 'graph:0000/node:0000', originalIndex: 0, mainType: 2, semanticType: 'particle.timer',
      payload: { type2: { SubType: 0, type2Sub0: {
        U0: 8, U1: 1, U2: 0.5, U3: 1, U9: 0, U10: 0, U11: 100,
      } } }, references: {},
    }] },
    { id: 'graph:0001', originalIndex: 1, name: 'Hit', nodes: [{
      id: 'graph:0001/node:0000', originalIndex: 0, mainType: 17, semanticType: 'rider.boost',
      payload: { type17: 5 }, references: {},
    }] },
  ],
  functions: [{ id: 'function:0000', originalIndex: 0, name: 'Delayed', nodes: [
    { id: 'function:0000/node:0000', originalIndex: 0, mainType: 4, semanticType: 'wait', payload: { WaitTime: 0.25 }, references: {} },
    { id: 'function:0000/node:0001', originalIndex: 1, mainType: 0, semanticType: 'property.mesh-animation', payload: { type0: { SubType: 20 } }, references: {} },
    { id: 'function:0000/node:0002', originalIndex: 2, mainType: 0, semanticType: 'property.breakable-kill', payload: { type0: { SubType: 5, DeadNodeMode: 4 } }, references: {} },
    { id: 'function:0000/node:0003', originalIndex: 3, mainType: 5, semanticType: 'condition.random', payload: { type5: { U0: 1, U1: 0, U2: 0.5 } }, references: {} },
    { id: 'function:0000/node:0004', originalIndex: 4, mainType: 9, semanticType: 'node.control.command-8', payload: { type9: { U0: 8, U1: 0 } }, references: {} },
  ] }],
  objectProperties: [],
  instances: [
    { id: 'instance:000000', originalIndex: 0, property: null },
    { id: 'instance:000001', originalIndex: 1, property: null },
  ],
  physics: [], collisionModels: [], splines: [], extensions: {},
});
const referenceData: ReferenceEffectsData = {
  level: 'TEST', document: referenceDocument,
  instances: [
    { index: 0, name: 'Host instance', modelName: 'Mdl_Host_1000', model: 3, loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], effectSlotIndex: 0, visible: true, collisionSound: -1, contact: 'through' },
    { index: 1, name: 'Plain', modelName: 'Mdl_Plain_1000', model: 4, loc: [1, 2, 3], rot: [0, 0, 0, 1], scale: [1, 1, 1], effectSlotIndex: -1, visible: true, collisionSound: -1, contact: 'through' },
  ],
};
check(validateEffectsDocument(referenceDocument).length === 0,
  'reference fixture is a valid lossless Effects document');
check(referenceSlot(referenceDocument, 0)?.id === 'slot:0000',
  'reference native slot joins through originalIndex instead of array position');
check(attachedReferenceInstances(referenceData).map(x => x.index).join(',') === '0',
  'reference effect join keeps only Instances.json hosts with valid native slots');
check(referenceInstanceBindings(referenceData, referenceData.instances[0]).map(x => x.circumstance).join(',') === 'persistent,collision',
  'reference host exposes every circumstance graph attached through its native slot');
check(referenceEffectSelection(referenceData, referenceData.instances[0])?.nodeId === referenceDocument.graphs[0].nodes[0].id,
  'reference viewport selection prefers the attached particle graph and emitter node');
check(effectGraphDisplayName(referenceDocument.graphs[0], 'trigger') === 'Trigger Effect 0',
  'effect display names combine the native graph identity and human trigger name');
check(referenceEffectDisplayName(referenceData, referenceDocument.graphs[0].id, 0) === 'Persistent Effect 0',
  'reference graph display name follows the native graph identity and circumstance');
const instanceEffectCallNode: EffectNode = {
  id: 'graph:0001/node:instance-call', mainType: 7, semanticType: 'instance.state', payload: {},
  references: { instance: 'instance:000001', effectGraph: referenceDocument.graphs[0].id },
};
const instanceEffectCall = referenceInstanceEffectCall(referenceData, instanceEffectCallNode);
check(instanceEffectCall?.targetLabel === 'Plain · #1' && instanceEffectCall.graphLabel === 'Smoke · graph:0000',
  'reference inspector resolves both ends of a MainType-7 instance/effect call');
check(referenceNodeDisplayName(referenceData, instanceEffectCallNode) === 'Run Plain → Smoke',
  'reference tree labels a cross-instance call with its target prop and called effect');
const targetedReferenceDocument = parseEffectsDocument(JSON.parse(JSON.stringify(referenceDocument)));
targetedReferenceDocument.graphs[1].nodes.push(instanceEffectCallNode);
const targetedReferenceData = { ...referenceData, document: targetedReferenceDocument };
const fireworkReferenceDocument = parseEffectsDocument(JSON.parse(JSON.stringify(targetedReferenceDocument)));
fireworkReferenceDocument.graphs[0].nodes = [
  { ...structuredClone(fireworkEmitter), id: 'graph:0000/node:0000', originalIndex: 0 },
  { id: 'graph:0000/node:0001', originalIndex: 1, mainType: 8, semanticType: 'audio.play',
    payload: { SoundPlay: 82 }, references: {} },
];
fireworkReferenceDocument.slots[0].circumstances.persistent = null;
const fireworkReferenceData = { ...referenceData, document: fireworkReferenceDocument };
const fireworkReference = referenceFireworkCall(fireworkReferenceData, instanceEffectCallNode);
check(fireworkReference?.call.target.index === 1 && fireworkReference.call.graph.originalIndex === 0
  && fireworkReference.layers.length === 1 && fireworkReference.layers[0].law.count === 200
  && fireworkReference.sounds.map(sound => sound.slot).join(',') === '82',
  'reference Run inspector classifies a report-bearing called emitter as a firework and exposes its P6 layer and sound');
check(referenceFireworkEffect(fireworkReferenceDocument.graphs[0])?.sounds[0]?.slot === 82,
  'the called launcher graph exposes its firework payload independently from the parent Run node');
check(referenceEffectSelection(fireworkReferenceData, fireworkReferenceData.instances[0])?.nodeId
  === instanceEffectCallNode.id,
  'selecting a firework trigger opens its launcher Run node by default');
fireworkReferenceDocument.graphs[0].nodes.pop();
check(referenceFireworkCall(fireworkReferenceData, instanceEffectCallNode) === null,
  'reference Run inspector does not mislabel a silent collision emitter as a firework');
const incomingCalls = referenceIncomingEffectCalls(targetedReferenceData, 1);
check(incomingCalls.length === 1 && incomingCalls[0].owner.id === targetedReferenceDocument.graphs[1].id
  && incomingCalls[0].sources[0]?.instance.index === 0 && incomingCalls[0].sources[0]?.circumstance === 'collision',
  'reverse effect join resolves a target prop back to its source graph and attached trigger host');
const multiSourceReferenceData = { ...targetedReferenceData, instances: [...targetedReferenceData.instances, {
  ...targetedReferenceData.instances[0], index: 2, name: 'Second trigger', modelName: 'Second trigger',
}] };
check(referenceIncomingEffectSources(multiSourceReferenceData, 1).map(instance => instance.index).join(',') === '0,2',
  'caller lookup collapses reverse graph edges to every unique contributing effect host');
const incomingEffectTree = referenceIncomingEffectTree(multiSourceReferenceData, 1);
check(incomingEffectTree.map(caller => caller.instance.index).join(',') === '0,2'
  && incomingEffectTree.every(caller => caller.effects.length === 1
    && caller.effects[0].graph?.id === targetedReferenceDocument.graphs[0].id
    && caller.effects[0].entries.length === 1),
  'target relationship tree expands a shared remote effect beneath every concrete caller prop');
check(referenceSupplementalOutgoingEffectCalls(targetedReferenceData, 0).length === 0,
  'selected trigger does not repeat calls already visible in its attached collision graph');
const functionTargetDocument = parseEffectsDocument(JSON.parse(JSON.stringify(referenceDocument)));
const functionTargetNode = { ...instanceEffectCallNode, id: 'function:0000/node:instance-call' };
functionTargetDocument.functions[0].nodes.push(functionTargetNode);
functionTargetDocument.graphs[1].nodes.push({
  id: 'graph:0001/node:function-call', mainType: 21, semanticType: 'function.call', payload: {},
  references: { function: functionTargetDocument.functions[0].id },
});
const functionIncomingCalls = referenceIncomingEffectCalls({ ...referenceData, document: functionTargetDocument }, 1);
check(functionIncomingCalls.length === 1 && functionIncomingCalls[0].owner.id === functionTargetDocument.functions[0].id
  && functionIncomingCalls[0].sources[0]?.instance.index === 0
  && functionIncomingCalls[0].sources[0]?.circumstance === 'collision'
  && functionIncomingCalls[0].sources[0]?.graph.id === functionTargetDocument.graphs[1].id,
  'reverse effect join follows function calls back to a unique attached trigger host');
check(referenceOutgoingEffectCalls({ ...referenceData, document: functionTargetDocument }, 0)
  .some(entry => entry.node.id === functionTargetNode.id && entry.call.target?.index === 1),
  'source effect join retains function-owned sibling calls for the selected trigger prop');
check(referenceSupplementalOutgoingEffectCalls({ ...referenceData, document: functionTargetDocument }, 0)
  .some(entry => entry.node.id === functionTargetNode.id && entry.call.target?.index === 1),
  'selected trigger still supplements its attached graph with reached function-owned calls');
check(referenceEffectSelection(targetedReferenceData, targetedReferenceData.instances[1]) === null,
  'an unattached called model stays selected without inheriting its caller graph');
const dualRoleReferenceData = { ...targetedReferenceData, instances: targetedReferenceData.instances.map(instance =>
  instance.index === 1 ? { ...instance, effectSlotIndex: 0 } : instance) };
check(referenceEffectSelection(dualRoleReferenceData, dualRoleReferenceData.instances[1])?.nodeId
  === targetedReferenceDocument.graphs[0].nodes[0].id,
  'a called model with its own slot opens its own effect instead of its caller graph');
check(referenceEffectInstanceIndices(targetedReferenceData).sort((a, b) => a - b).join(',') === '0,1',
  'Effects overlay includes both direct effect hosts and cross-instance target props');
const particleSecond = parseEffectsDocument(JSON.parse(JSON.stringify(referenceDocument)));
particleSecond.slots[0].circumstances.persistent = particleSecond.graphs[1].id;
particleSecond.slots[0].circumstances.collision = particleSecond.graphs[0].id;
check(referenceEffectSelection({ ...referenceData, document: particleSecond }, referenceData.instances[0])?.ownerId
  === particleSecond.graphs[0].id, 'reference viewport selection finds a particle graph after an earlier non-particle circumstance');
check(referenceEffectSelection(referenceData, referenceData.instances[1]) === null,
  'reference prop without a native effect slot leaves the effect selection unchanged');
check(effectGraphHasTimerEmitter(referenceDocument, referenceDocument.graphs[0]),
  'persistent-emitter discovery recognizes a direct timer node');
const calledEmitterDocument = parseEffectsDocument(JSON.parse(JSON.stringify(referenceDocument)));
calledEmitterDocument.functions[0].nodes.push({
  ...calledEmitterDocument.graphs[0].nodes[0], id: 'function:0000/node:emitter',
});
calledEmitterDocument.graphs[1].nodes = [{
  id: 'graph:0001/node:call', mainType: 21, semanticType: 'function.call', payload: {},
  references: { function: calledEmitterDocument.functions[0].id },
}];
check(effectGraphHasTimerEmitter(calledEmitterDocument, calledEmitterDocument.graphs[1]),
  'persistent-emitter discovery follows mapped function calls');
calledEmitterDocument.functions[0].nodes = [{
  id: 'function:0000/node:cycle', mainType: 21, semanticType: 'function.call', payload: {},
  references: { function: calledEmitterDocument.functions[0].id },
}];
check(!effectGraphHasTimerEmitter(calledEmitterDocument, calledEmitterDocument.graphs[1]),
  'persistent-emitter discovery bounds cyclic call graphs without inventing a particle effect');
const animatedReferenceDocument = parseEffectsDocument(JSON.parse(JSON.stringify(referenceDocument)));
animatedReferenceDocument.graphs[0].nodes.push({ ...animObject, id: 'graph:0000/node:anim-object' });
const animatedReferenceData = { ...referenceData, document: animatedReferenceDocument };
check(referenceAnimObjectEffects(animatedReferenceData).get(0)?.loopMode === 2,
  'reference world resolves persistent AnimObject motion through instance -> slot -> graph');
const deltaReferenceDocument = parseEffectsDocument(JSON.parse(JSON.stringify(referenceDocument)));
deltaReferenceDocument.graphs[0].nodes.push({ ...animDelta, id: 'graph:0000/node:anim-delta' });
check(referenceAnimDeltaEffects({ ...referenceData, document: deltaReferenceDocument }).get(0)?.endFrame === 30,
  'reference world installs persistent AnimDelta receivers through instance -> slot -> graph');

const scrollingDocument = parseEffectsDocument({
  $schema: 'openslope-effects-v1.schema.json', kind: 'openslope-effects', version: 1,
  target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level: 'SCROLL' },
  header: { U1: 1966592, U2: 1053952, U3: 0.006 },
  slots: [{ id: 'slot:0000', originalIndex: 0, name: 'River', circumstances: {
    persistent: 'graph:0000', collision: null, slot3: null, slot4: null,
    trigger: null, slot6: null, slot7: null,
  } }],
  graphs: [{ id: 'graph:0000', originalIndex: 0, name: 'Flow', nodes: [{
    id: 'graph:0000/node:0000', originalIndex: 0, mainType: 0, semanticType: 'property.uv-scroll',
    payload: { type0: { SubType: 10, UVScroll: { U0: 0, U1: -0.02, U2: 0, U3: 1, U4: 0, U5: 0 } } },
    references: {},
  }] }],
  functions: [], objectProperties: [],
  instances: [{ id: 'instance:000007', originalIndex: 7, property: null }],
  physics: [], collisionModels: [], splines: [], extensions: {},
});
const scrollingData: ReferenceEffectsData = {
  level: 'SCROLL', document: scrollingDocument,
  instances: [{ index: 7, name: 'River', modelName: 'Mdl_Water_River_6002', model: 229,
    loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], effectSlotIndex: 0, visible: true, collisionSound: -1, contact: 'through' }],
};
check(referenceUvScroll(scrollingData, 7)?.uPerTick === -0.02,
  'reference world resolves river UV motion through instance -> slot -> persistent graph');
scrollingDocument.extensions = { slopesmith: { attachments: [{ id: 'attachment:0000',
  target: { kind: 'prop', id: 'prop:river' }, slot: 'slot:0000', circumstance: 'persistent', enabled: true }] } };
check(authoredPropUvScroll(scrollingDocument, 'prop:river')?.uPerTick === -0.02,
  'authored world resolves the same UV motion through its stable prop attachment');
const [editorScrollU, editorScrollV] = editorUvScrollDelta({
  mode: 0, uPerTick: -0.02, vPerTick: 0.02, activeDuration: 1, pauseDuration: 0, lifetime: 0,
}, 30);
check(Math.abs(editorScrollU + 0.6) < 1e-9 && Math.abs(editorScrollV + 0.6) < 1e-9,
  'editor UV conversion preserves native U and reverses native V for Three texture space');
check(Math.abs(editorUvScrollVPhase({
  mode: 0, uPerTick: 0, vPerTick: 0.02, activeDuration: 1, pauseDuration: 0, lifetime: 0,
}, 0.25) - 0.75) < 1e-9,
  'UVScroll command 6 converts the selected native V phase into Three texture space');
const scrollInspector = semanticInspectorForNode(scrollingDocument.graphs[0].nodes[0]!);
check(scrollInspector.fields.map(field => field.label).join(',')
  === 'Mode,Horizontal speed (UV/tick),Vertical speed (UV/tick),Active duration (seconds),Pause duration (seconds),Lifetime (seconds)',
  'UVScroll exposes its recovered rate, cycle timing, and lifetime fields instead of false axis lengths');
check(scrollInspector.fields[0]?.options?.map(option => option.label).join('|')
  === 'Linear (same direction)|Eased ping-pong|Constant-speed ping-pong',
  'UVScroll mode is a named dropdown instead of an unexplained integer');
const pingPongEffect = {
  mode: 2, uPerTick: -0.004, vPerTick: 0, activeDuration: 0.5, pauseDuration: 1.5, lifetime: 0,
};
const pingPongPlayback = createUvScrollPlayback(pingPongEffect);
const [firstLeg] = stepUvScrollPlayback(pingPongPlayback, pingPongEffect, 29 / 60);
const [boundary] = stepUvScrollPlayback(pingPongPlayback, pingPongEffect, 1 / 60);
check(Math.abs(firstLeg - (-0.004 * 29)) < 1e-9 && boundary === 0
  && !pingPongPlayback.active && pingPongPlayback.direction === -1,
  'constant-speed ping-pong reverses after U3 and enters the U4 pause');
stepUvScrollPlayback(pingPongPlayback, pingPongEffect, 91 / 60);
const [returnLeg] = stepUvScrollPlayback(pingPongPlayback, pingPongEffect, 1 / 60);
check(pingPongPlayback.active && returnLeg > 0,
  'constant-speed ping-pong resumes after the pause and moves in the opposite direction');
const easedEffect = { ...pingPongEffect, mode: 1, activeDuration: 1, pauseDuration: 0 };
const easedPlayback = createUvScrollPlayback(easedEffect);
const [easedLeg] = stepUvScrollPlayback(easedPlayback, easedEffect, 59 / 60);
stepUvScrollPlayback(easedPlayback, easedEffect, 1 / 60);
check(easedLeg < 0 && Math.abs(easedLeg) < Math.abs(easedEffect.uPerTick * 59)
  && easedPlayback.direction === -1,
  'eased ping-pong applies the native triangular rate envelope and reverses at the endpoint');
const phaseOnlyUv: EffectNode = { id: 'test:phase-only-uv', mainType: 0, semanticType: 'property.uv-scroll',
  payload: { type0: { SubType: 10, UVScroll: { U0: 0, U1: 0, U2: 0, U3: 1, U4: 1 } } }, references: {} };
check(!uvScrollFromNode(phaseOnlyUv) && !!uvScrollReceiverFromNode(phaseOnlyUv),
  'zero-rate UVScroll remains a controllable phase receiver without becoming an ambient motion');

// The water templates: authoring the retail river pair from scratch — a persistent UVScroll flow plus a
// collision course-reset — then baking through the export's shipped scroll dialect (Scroll.json + _scr tags).
const waterDoc = parseEffectsDocument(JSON.parse(JSON.stringify({
  kind: 'openslope-effects', version: 1,
  target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level: 'WATER' },
  header: { U1: 1966592, U2: 1053952, U3: 0.006 },
  slots: [], graphs: [], functions: [], objectProperties: [], instances: [], physics: [], collisionModels: [], splines: [], extensions: {},
})));
const flowSel = addEffectTemplate(waterDoc, 'uv-scroll');
check(waterDoc.slots[0].circumstances.persistent === waterDoc.graphs[0].id
  && uvScrollFromNode(effectNode(waterDoc, flowSel)!)?.uPerTick === -0.02,
  'uv-scroll template authors a persistent slot at the retail river rate');
const resetSel = addEffectTemplate(waterDoc, 'rider-reset');
check(waterDoc.slots[1].circumstances.collision === waterDoc.graphs[1].id
  && effectPlayCommand(effectNode(waterDoc, resetSel)!)?.kind === 'rider-reset',
  'rider-reset template authors the traced MainType-13 collision reset');

const waterMountain = migrateMountain(JSON.parse(JSON.stringify(defaultMountain())));
waterMountain.props = [{ level: 'GARI', model: 224, name: 'Mdl_Water_River_7003', pos: [0, -2, 20], yaw: 0, scale: 1 }];
ensurePlacedPropIds(waterMountain.props);
attachEffectToProp(waterDoc, waterMountain.props[0].id!, waterDoc.slots[0].id, 'persistent');
check(authoredPropUvScroll(waterDoc, waterMountain.props[0].id)?.uPerTick === -0.02,
  'placed river prop resolves its authored flow through the stable attachment');
check(validateEffectsAuthoring(waterDoc, waterMountain.props).length === 0,
  'authored water pair passes editor validation');
waterMountain.effects = waterDoc;
const waterExportDir = mkdtempSync(join(tmpdir(), 'slopesmith-water-export-'));
try {
  await exportLevel(waterMountain, { outDir: waterExportDir, lighting: false });
  const waterObj = readFileSync(join(waterExportDir, 'Props.obj'), 'utf8');
  const waterScroll = JSON.parse(readFileSync(join(waterExportDir, 'Scroll.json'), 'utf8')) as { Speeds: {
    U: number; V: number; Mode: number; ActiveDuration: number; PauseDuration: number; Lifetime: number;
  }[] };
  await withRetailFiles('retail river-model export assertion', ['GARI/Models.json'], () => {
    check(/^usemtl mat_\d+_scr0$/m.test(waterObj),
      'export bakes the scrolled prop with the shipped _scr material-slot tag');
  });
  check(waterScroll.Speeds.length === 1
    && JSON.stringify(waterScroll.Speeds[0])
      === '{"U":-0.02,"V":0,"Mode":0,"ActiveDuration":1,"PauseDuration":0,"Lifetime":0}',
    'export writes the deduped complete native Scroll.json motion profile');
} finally {
  rmSync(waterExportDir, { recursive: true, force: true });
}

// Prop-first authoring: templates land wired into the selected prop's own slot — never orphaned.
const pfDoc = parseEffectsDocument(JSON.parse(JSON.stringify({
  kind: 'openslope-effects', version: 1,
  target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level: 'PROPFIRST' },
  header: { U1: 1966592, U2: 1053952, U3: 0.006 },
  slots: [], graphs: [], functions: [], objectProperties: [], instances: [], physics: [], collisionModels: [], splines: [], extensions: {},
})));
const pfProps: PlacedProp[] = [{ level: 'DONOR', model: 224, name: 'River piece', pos: [0, 0, 0], yaw: 0, scale: 1 }];
ensurePlacedPropIds(pfProps);
const pfId = pfProps[0].id!;
const pfFlow = addEffectTemplateToProp(pfDoc, pfId, 'uv-scroll');
check(pfDoc.slots.length === 1 && effectAttachments(pfDoc).length === 1
  && effectAttachments(pfDoc)[0].target.id === pfId
  && authoredPropUvScroll(pfDoc, pfId)?.uPerTick === -0.02,
  'prop-first template creates graph, slot, and attachment in one step');
const pfReset = addEffectTemplateToProp(pfDoc, pfId, 'rider-reset');
check(pfDoc.slots.length === 1
  && pfDoc.slots[0].circumstances.persistent === pfFlow.ownerId
  && pfDoc.slots[0].circumstances.collision === pfReset.ownerId
  && effectPlayCommand(effectNode(pfDoc, pfReset)!)?.kind === 'rider-reset'
  && authoredPropUvScroll(pfDoc, pfId)?.uPerTick === -0.02,
  'second prop-first template joins the SAME slot — the retail river pair on one attachment');
const pfWait = addEffectTemplateToProp(pfDoc, pfId, 'wait');
const pfSound = addEffectTemplateToProp(pfDoc, pfId, 'sound');
check(pfWait.ownerId === pfSound.ownerId && pfDoc.slots.length === 1
  && pfDoc.graphs.find(g => g.id === pfWait.ownerId)?.nodes.length === 2,
  'a template on an occupied circumstance extends that graph’s execution chain');
check(unassignedEffectOwnerIds(pfDoc, effectAttachments(pfDoc).map(a => a.slot)).size === 0,
  'prop-first authoring leaves no orphaned graphs');
check(validateEffectsAuthoring(pfDoc, pfProps).length === 0, 'prop-first document validates clean');

// --- the node catalogue: the picker presents the WHOLE vocabulary ---------------------------------------
// Two claims worth pinning. Every template's payload must decode to the semantic type it declares, or the
// picker offers a node that arrives in the tree under a different name than the one that was clicked. And
// addable + greyed must cover the canonical vocabulary exactly once, so a node added to the model later
// cannot silently vanish from the menu.
{
  const mismatched = EFFECT_TEMPLATES.flatMap(template => (template.nodes ?? []).flatMap(node => {
    const compatible = compatibleEffectSemanticTypes(node);
    return node.semanticType && compatible && !compatible.includes(node.semanticType)
      ? [`${template.id}/${node.semanticType} (payload reads as ${compatible.join('|')})`] : [];
  }));
  check(mismatched.length === 0,
    `every template's payload decodes to the semantic type it declares${mismatched.length ? `: ${mismatched.join(', ')}` : ''}`);

  const addable = new Set(EFFECT_TEMPLATES.flatMap(t => (t.nodes ?? []).map(n => n.semanticType!)));
  const greyed = new Set(UNAUTHORABLE_EFFECT_NODES.map(n => n.semanticType));
  const both = [...addable].filter(type => greyed.has(type));
  const missing = [...CANONICAL_SEMANTIC_TYPES].filter(type => !addable.has(type) && !greyed.has(type));
  const stray = [...greyed].filter(type => !CANONICAL_SEMANTIC_TYPES.has(type));
  check(!both.length && !missing.length && !stray.length,
    `the picker covers the canonical vocabulary exactly once — ${addable.size} addable, ${greyed.size} greyed`
    + `${missing.length ? `; UNCOVERED ${missing.join(', ')}` : ''}`
    + `${both.length ? `; BOTH ${both.join(', ')}` : ''}${stray.length ? `; NOT CANONICAL ${stray.join(', ')}` : ''}`);
  check(UNAUTHORABLE_EFFECT_NODES.every(node => node.reason.length > 40),
    'and every greyed node carries a reason, because a disabled row with no explanation is just an absence');
  // A recipe lays down more than a node — either several, or one plus the slot columns that keep it. The
  // iris door is the second kind: one play-once clip whose whole point is the two latches beside it.
  check(EFFECT_TEMPLATES.every(t => t.kind === 'container' ? !t.nodes?.length : !!t.nodes?.length)
    && EFFECT_TEMPLATES.filter(t => t.kind === 'recipe')
      .every(t => (t.nodes?.length ?? 0) > 1 || !!t.latches?.length)
    && EFFECT_TEMPLATES.filter(t => t.kind === 'node')
      .every(t => t.nodes?.length === 1 && !t.latches?.length),
    'containers lay down nothing, nodes lay down exactly one node, recipes lay down more than a node');
}

// The two persistent flips are separate templates because they are separate machines — the pause path
// re-times itself at every change, so `Speed` stops meaning frames per second.
{
  const flipDoc = createEmptyEffectsDocument('FLIPBOOK');
  const cycler = addEffectTemplateToProp(flipDoc, 'prop:sign', 'texture-flip');
  const cycle = textureFlipFromNode(effectNode(flipDoc, cycler)!)!;
  check(flipDoc.slots[0].circumstances.persistent === cycler.ownerId
    && cycle.speed === 3.5 && !cycle.dwell && !isTextureFlipPulse(cycle),
    'the Flipbook template authors a PERSISTENT cycler — no lifetime, so it is ambient motion, not a one-shot');
  const dwellDoc = createEmptyEffectsDocument('DWELL');
  const screen = addEffectTemplateToProp(dwellDoc, 'prop:lcd', 'texture-flip-dwell');
  const screenFlip = textureFlipFromNode(effectNode(dwellDoc, screen)!)!;
  check(dwellDoc.slots[0].circumstances.persistent === screen.ownerId
    && screenFlip.dwell && screenFlip.speed === 1 && !isTextureFlipPulse(screenFlip),
    'the Dwell screen template authors the retail LCD law — the pause path at the modal shipped rate');
  check(createTextureFlipPlayback(screenFlip).remaining === 1,
    'and its first hold is the un-randomized 1 / speed, exactly as the recovered constructor leaves it');
}

// The ride-over button is a RECIPE template: three nodes laid down together, because a flip node with no
// frame select paints nothing and an undebounced one re-selects forever instead of pulsing.
const buttonDoc = createEmptyEffectsDocument('BUTTON');
const buttonProps: PlacedProp[] = [{ ...pfProps[0], id: 'prop:button', name: 'Button' }];
const buttonSel = addEffectTemplateToProp(buttonDoc, 'prop:button', 'ride-over-button');
const buttonGraph = buttonDoc.graphs.find(graph => graph.id === buttonSel.ownerId)!;
check(buttonDoc.slots[0].circumstances.collision === buttonGraph.id
  && buttonGraph.nodes.map(node => node.semanticType).join(' ')
    === 'property.debounce property.texture-flip material.texture-frame',
  'the ride-over button template lays down retail’s debounce / flip / frame-select chain, in that order');
const buttonFlip = textureFlipFromNode(buttonGraph.nodes[1])!;
check(buttonFlip.speed === 3.5 && buttonFlip.length === 0.5
  && effectPlayCommand(buttonGraph.nodes[2])?.kind === 'property-control',
  'it authors the megaplex pulse law and a bound-node frame select to paint it');
const buttonControl = authoredPropMaterialControl(buttonDoc, 'prop:button')!;
check(buttonControl.receiver === 'texture-flip' && isTextureFlipPulse(buttonControl.effect.textureFlip)
  && authoredPropMaterialEffects(buttonDoc, 'prop:button') === null,
  'a receiver installed on contact still resolves for the renderer, while the ambient law stays empty');
check(validateEffectsAuthoring(buttonDoc, buttonProps).length === 0
  && validateEffectsDocument(parseEffectsDocument(JSON.parse(JSON.stringify(buttonDoc)))).length === 0,
  'the authored button validates clean as authoring and as a portable document');

const rollerWarningDoc = createEmptyEffectsDocument('ROLLER_WARNING');
const rollerWarningProp: PlacedProp = { ...pfProps[0], id: 'prop:roller-warning' };
addEffectTemplateToProp(rollerWarningDoc, rollerWarningProp.id!, 'roller');
check(validateEffectsAuthoring(rollerWarningDoc, [rollerWarningProp]).some(issue => issue.severity === 'warning'
  && issue.message.includes('no physics body for the PS2 build')),
  'Roller on a custom ISO prop warns that preview/Unity movement cannot create a native PS2 body');
const invalidRoller = rollerWarningDoc.graphs.flatMap(graph => graph.nodes)
  .find(node => node.semanticType === 'property.roller')!;
invalidRoller.payload = { type0: { SubType: 0, type0Sub0: { U0: 0 } } };
check(validateEffectsAuthoring(rollerWarningDoc, [rollerWarningProp]).some(issue => issue.severity === 'warning'
  && issue.message.includes('greater than zero')),
  'a non-positive Roller mass produces an author-facing warning instead of an artificial 0.001-mass body');
rollerWarningProp.nativeCollision = {
  mode: 0, playerCollision: true, responseMass: 5, playerBounce: true, bounceAmount: 0.5,
};
check(validateEffectsAuthoring(rollerWarningDoc, [rollerWarningProp]).some(issue => issue.severity === 'warning'
  && issue.message.includes('collision mode 0 has no contact shape')),
  'an explicit profile warns when its contact gate prevents an attached collision graph from firing');

// An authored MODEL placement ships through the same channels: the polygon bake, the tile slot with the
// source level's alpha flag, the `_scr` tag from its prop-first flow effect, and the Scroll.json table.
const modelMountain = migrateMountain(JSON.parse(JSON.stringify(defaultMountain())));
const riverModel = createAuthoredModel(modelMountain, 'River ribbon');
const ribbonGrown = appendPatchFromCorners(modelEditDocFor(modelMountain, riverModel),
  [[0, -2, 20], [8, -2, 20], [8, -2.5, 50], [0, -2.5, 50]]);
check(ribbonGrown.ok, 'river ribbon model authors its quad through the ordinary create-patch op');
if (ribbonGrown.ok) commitModelEditDoc(riverModel, ribbonGrown.doc);
riverModel.texture = 'GARI/0106.png'; // the retail river-water tile
modelMountain.props = [{ level: AUTHORED_MODEL_LEVEL, model: modelNumber(riverModel.id), name: riverModel.name,
  pos: [riverModel.anchor[0], riverModel.anchor[1], riverModel.anchor[2]], yaw: 0, scale: 1 }];
ensurePlacedPropIds(modelMountain.props);
addEffectTemplateToProp(modelMountain.effects!, modelMountain.props[0].id!, 'uv-scroll');
const modelExportDir = mkdtempSync(join(tmpdir(), 'slopesmith-model-export-'));
try {
  await exportLevel(modelMountain, { outDir: modelExportDir, lighting: false });
  const modelObj = readFileSync(join(modelExportDir, 'Props.obj'), 'utf8');
  const modelObject = /^o inst\d+_Model_0_/m.exec(modelObj);
  check(!!modelObject, 'export bakes the authored-model placement under its canonical instance/group join');
  // One `o` block, not the rest of the file: the staging anchors bake AFTER every placed prop (they go last so
  // their arrival cannot renumber a level's instances), and each is a closed box, so a slice run to EOF counts
  // their triangles as the model's.
  const afterHeader = modelObj.slice(modelObject?.index ?? 0);
  const nextGroup = /\n(?=o )/.exec(afterHeader);
  const modelGroup = nextGroup ? afterHeader.slice(0, nextGroup.index) : afterHeader;
  check(/^usemtl mat_\d+_scr0$/m.test(modelGroup) && (modelGroup.match(/^f /gm) ?? []).length === 2,
    'the model group wears the _scr-tagged tile slot and ships two triangles per quad');
  const modelMats = JSON.parse(readFileSync(join(modelExportDir, 'Materials.json'), 'utf8')) as
    { Materials: { MaterialName: string; TexturePath: string }[] };
  const tileEntry = modelMats.Materials.find(m => m.MaterialName.startsWith('model_') && m.TexturePath.includes('0106'));
  await withRetailFiles('retail river-texture export assertion', ['GARI/Textures/0106.png'], () => {
    check(!!tileEntry && existsSync(join(modelExportDir, 'Textures', tileEntry.TexturePath)),
      'the tile resolves through the combiner and its PNG copies into the export');
  });
  const modelScroll = JSON.parse(readFileSync(join(modelExportDir, 'Scroll.json'), 'utf8')) as { Speeds: {
    U: number; V: number; Mode: number; ActiveDuration: number; PauseDuration: number; Lifetime: number;
  }[] };
  check(modelScroll.Speeds.some(s => s.U === -0.02 && s.V === 0 && s.Mode === 0
    && s.ActiveDuration === 1 && s.PauseDuration === 0 && s.Lifetime === 0),
    'the model placement’s flow effect lands in Scroll.json like a reference river segment’s');
} finally {
  rmSync(modelExportDir, { recursive: true, force: true });
}

const flipNode: EffectNode = {
  id: 'test:texture-flip', mainType: 0, semanticType: 'property.texture-flip',
  payload: { type0: { SubType: 11, TextureFlip: { U0: 0, Direction: 0, Speed: 4, Length: 0, U4: 0 } } },
  references: {},
};
const flip = textureFlipFromNode(flipNode)!;
check(flip.speed === 4 && !flip.dwell, 'texture-flip decoder preserves native direction, speed, length, and dwell mode');
const forward = createTextureFlipPlayback(flip);
check(stepTextureFlipPlayback(forward, flip, 3, 0.25) && forward.frame === 1,
  'ordinary texture flips run at the authored speed in frames per second');
check(selectTextureFlipPlaybackFrame(forward, 5, 4) && forward.frame === 4,
  'TextureFlip command 2 selects the authored absolute countdown frame');
selectTextureFlipPlaybackFrame(forward, 5, 99);
check(forward.frame === 4, 'controlled texture frame selection clamps malformed values to the loaded frame bank');
const reverseEffect = { ...flip, direction: 1 };
const reverse = createTextureFlipPlayback(reverseEffect);
stepTextureFlipPlayback(reverse, reverseEffect, 3, 0.25);
check(reverse.frame === 2, 'texture-flip playback preserves reverse direction');
const dwellEffect = { ...flip, speed: 1, dwell: true, seed: 17 };
const dwell = createTextureFlipPlayback(dwellEffect);
stepTextureFlipPlayback(dwell, dwellEffect, 2, 1);
const flashed = dwell.frame === 1 && dwell.dwellPhase === 'flash';
stepTextureFlipPlayback(dwell, dwellEffect, 2, 0.1);
check(flashed && dwell.frame === 0 && dwell.dwellPhase === 'hold' && dwell.remaining >= 1,
  'warning-screen dwell mode holds 1/speed, flashes for 0.1 seconds, then begins a randomized hold');

// Tokyo Megaplex's ride-over buttons: Speed 3.5 across a two-frame green/red material, on a 0.5 s node.
const pulseEffect = { ...flip, speed: 3.5, length: 0.5 };
check(isTextureFlipPulse(pulseEffect) && !isTextureFlipPulse(flip) && !startTextureFlipPulse(createTextureFlipPlayback(flip), flip),
  'an authored Length is what makes a flip a one-shot; an always-on flip has no node to build');
const pulse = createTextureFlipPlayback(pulseEffect);
check(!stepTextureFlipPlayback(pulse, pulseEffect, 2, 5) && pulse.frame === 0,
  'a one-shot rests on the placed frame and ignores the world clock until a graph builds its node');
startTextureFlipPulse(pulse, pulseEffect);
selectTextureFlipPlaybackFrame(pulse, 2, 1);
check(pulse.frame === 1 && pulse.life === 0.5,
  'running the flip property starts the node lifetime and the paired frame select paints the pulse');
const held = !stepTextureFlipPlayback(pulse, pulseEffect, 2, 0.2) && pulse.frame === 1;
check(held && stepTextureFlipPlayback(pulse, pulseEffect, 2, 0.1) && pulse.frame === 0,
  'the one-shot holds the pulsed frame for 1 / speed and then advances off it');
stepTextureFlipPlayback(pulse, pulseEffect, 2, 0.5);
check(pulse.life === 0 && pulse.frame === 0 && !stepTextureFlipPlayback(pulse, pulseEffect, 2, 5),
  'the node dies at the authored Length, restoring the placed material until another graph run rebuilds it');
check(crowdBoxFromNode({ id: 'test:crowd', mainType: 0, semanticType: 'property.crowd-box',
  payload: { type0: { SubType: 17, CrowdEffect: { U0: 4, U1: 4 } } }, references: {} }),
  'crowd-box decoder recognizes the shared crowd-texture property');

// What ▶ Preview effect tests each node against: a material property is a render-layer clock, so the graph
// runner has to recognize one to hand it to the renderer instead of drawing its diagnostic ring.
const previewScrollNode = scrollingDocument.graphs[0].nodes[0];
check(materialWorldEffectsFromNode(previewScrollNode)?.uvScroll?.uPerTick === -0.02
  && materialWorldEffectsFromNode(flipNode)?.textureFlip?.speed === 4
  && !materialWorldEffectsFromNode({ id: 'test:wait', mainType: 16, semanticType: 'timing.wait',
    payload: { type16: 1 }, references: {} }),
  'the per-node material decoder answers for a scroll and a flipbook and stays silent on a plain wait');

scrollingDocument.graphs[0].nodes.push(flipNode);
const referenceWorld = referenceMaterialWorldEffects(scrollingData).get(7)!;
check(referenceWorld.uvScroll?.uPerTick === -0.02 && referenceWorld.textureFlip?.speed === 4,
  'reference material resolver collects multiple supported properties from one attached graph');
check(referenceMaterialControls(scrollingData).size === 0,
  'ambient material properties keep shared instancing when no bound control graph targets them');

const countdownDocument = cloneEffectsDocument(referenceDocument);
countdownDocument.graphs.push({ id: 'graph:countdown-receiver', name: 'Start light receiver', nodes: [{
  id: 'graph:countdown-receiver/node:0000', mainType: 0, semanticType: 'property.texture-flip', references: {},
  payload: { type0: { SubType: 11, TextureFlip: { U0: 0, Direction: 0, Speed: 0, Length: 7, U4: 0 } } },
}] });
for (let frame = 1; frame <= 4; frame++) countdownDocument.graphs.push({
  id: `graph:countdown-frame-${frame}`, name: `Start light frame ${frame}`, nodes: [{
    id: `graph:countdown-frame-${frame}/node:0000`, mainType: 9,
    semanticType: 'material.texture-frame', references: {}, payload: { type9: { U0: 2, U1: frame } },
  }],
});
const countdownNodes: EffectNode[] = [
  { id: 'function:countdown-start/node:0000', mainType: 7, semanticType: 'instance.state', payload: {},
    references: { instance: 'instance:000001', effectGraph: 'graph:countdown-receiver' } },
  { id: 'function:countdown-start/node:0001', mainType: 4, semanticType: 'wait', payload: { WaitTime: 1 }, references: {} },
];
for (let frame = 1; frame <= 4; frame++) {
  countdownNodes.push({ id: `function:countdown-start/node:frame-${frame}`, mainType: 7,
    semanticType: 'instance.state', payload: {},
    references: { instance: 'instance:000001', effectGraph: `graph:countdown-frame-${frame}` } });
  if (frame < 4) countdownNodes.push({ id: `function:countdown-start/node:wait-${frame}`, mainType: 4,
    semanticType: 'wait', payload: { WaitTime: 0.5 }, references: {} });
}
countdownDocument.functions.push({ id: 'function:countdown-start', name: 'CountDownStart', nodes: countdownNodes });
countdownDocument.functions.push({ id: 'function:start-countdown', name: 'StartCountDown', nodes: [
  { id: 'function:start-countdown/node:0000', mainType: 21, semanticType: 'function.call', payload: {},
    references: { function: 'function:countdown-start' } },
] });
const countdownControl = referenceMaterialControls({ ...referenceData, document: countdownDocument }).get(1);
check(countdownControl?.receiver === 'texture-flip' && countdownControl.effect.textureFlip?.length === 7,
  'reference receiver discovery follows lifecycle function instance calls to an unattached start light');
const countdown = referenceRaceCountdown({ ...referenceData, document: countdownDocument });
check(countdown?.holdSeconds === 2.5 && countdown.cues.map(cue => `${cue.at}:${cue.label}`).join(',')
  === '0:READY,1:3,1.5:2,2:1,2.5:GO',
  'reference race countdown derives the rider hold and UI cues from the authored Wait/frame sequence');
const malformedCountdown = cloneEffectsDocument(countdownDocument);
(malformedCountdown.graphs.find(graph => graph.id === 'graph:countdown-frame-3')!.nodes[0]
  .payload.type9 as Record<string, number>).U1 = 7;
check(referenceRaceCountdown({ ...referenceData, document: malformedCountdown }) === null,
  'a named countdown with an unproven frame sequence cannot hold the rider');
const authoredWorld = authoredPropMaterialEffects(scrollingDocument, 'prop:river')!;
check(authoredWorld.uvScroll?.uPerTick === -0.02 && authoredWorld.textureFlip?.speed === 4,
  'authored material resolver uses the same graph semantics as the reference world');

// --- Effect-slot latch columns: Slot3 region exit / Slot4 effect end [Trailmap: 150-logic §slot-columns] ---
check(effectCircumstanceLabel('slot3') === 'Region exit' && effectCircumstanceLabel('slot4') === 'Effect end',
  'latch circumstance columns carry their recovered engine meanings');
await withRetailFiles('ELYSIUM latch integration assertions',
  ['ELYSIUM/Effects.json', 'ELYSIUM/Instances.json', 'ELYSIUM/Models.json'], async () => {
const elysiumEffectPayload = await readReferenceEffects('ELYSIUM');
const elysiumEffectData: ReferenceEffectsData = {
  ...elysiumEffectPayload,
  document: parseEffectsDocument(JSON.stringify(elysiumEffectPayload.document)),
};
const irisDoor = elysiumEffectData.instances.find(instance => instance.name === 'Mdl_Elys_Door_5000')!;
const irisSlot = referenceSlot(elysiumEffectData.document, irisDoor.effectSlotIndex)!;
check(irisDoor.effectSlotIndex === 34 && effectSlotHoldsAtEnd(irisSlot)
  && effectSlotLatchIsEmptyGraph(elysiumEffectData.document, irisSlot, 'slot3')
  && effectSlotLatchIsEmptyGraph(elysiumEffectData.document, irisSlot, 'slot4'),
  'the iris door slot authors both latch columns as retail empty sentinel graphs');
check(referenceInstanceHoldsAtEnd(elysiumEffectData, irisDoor.index)
  && effectSlotCanSelfEnd(elysiumEffectData.document, irisSlot),
  'the door holds at end and its play-once source resolves through the trigger volumes\' MainType-7 hand-off');
const elysiumLatchIssues = validateEffectsAuthoring(elysiumEffectData.document)
  .filter(issue => /slot[3467]/.test(issue.path));
check(elysiumLatchIssues.length === 0,
  'retail ELYSIUM latch authoring validates clean — empty sentinels are the mechanism, not an error');
});
const latchDoc = createEmptyEffectsDocument('LATCH');
const latchProps: PlacedProp[] = [{ id: 'prop:door', level: 'ELYSIUM', model: 605, name: 'Door',
  pos: [0, 0, 0], yaw: 0, scale: 1 }];
check(setPropEffectLatch(latchDoc, 'prop:door', 'slot4', true)
  && latchDoc.slots.length === 1 && latchDoc.graphs.length === 1 && latchDoc.graphs[0].nodes.length === 0
  && authoredPropHoldsAtEnd(latchDoc, 'prop:door')
  && effectAttachments(latchDoc).some(item => item.target.id === 'prop:door'),
  'checking the Effect-end latch creates a bare slot, attachment, and empty sentinel graph together');
check(validateEffectsAuthoring(latchDoc, latchProps).some(issue =>
  issue.severity === 'warning' && issue.path.endsWith('.slot4') && /never used/.test(issue.message)),
  'a latch with no self-ending source on the slot warns instead of silently never firing');
// The two-stage break is two chains on one slot, and the half that is easy to leave out is the one that
// actually breaks the prop. Every node in a lone Cracked surface is correct, so nothing but this warning
// distinguishes it from a finished breakable.
const crackDoc = createEmptyEffectsDocument('CRACK');
const crackProps: PlacedProp[] = [{ id: 'prop:pane', level: 'MEGAPLE', model: 164, name: 'Pane',
  pos: [0, 0, 0], yaw: 0, scale: 1 }];
addEffectTemplateToProp(crackDoc, 'prop:pane', 'cracked');
const crackMaterialControl = authoredPropMaterialControl(crackDoc, 'prop:pane');
check(crackMaterialControl?.receiver === 'texture-flip'
  && crackMaterialControl.effect.textureFlip?.speed === 0
  && !crackDoc.graphs.some(graph => graph.nodes.some(node => node.semanticType === 'property.texture-flip')),
  'a Cracked surface prepares a private stationary frame receiver without authoring a TextureFlip node');
const crackWarned = (doc: typeof crackDoc) => validateEffectsAuthoring(doc, crackProps).some(issue =>
  issue.severity === 'warning' && issue.path.endsWith('.trigger') && /cracks and\s+then stands/.test(issue.message));
check(crackWarned(crackDoc),
  'a Cracked surface with no Trigger effect warns — every node in it is correct and it still never breaks');
addEmptyEffectToProp(crackDoc, 'prop:pane', 'trigger');
check(!crackWarned(crackDoc),
  'giving the crack a Trigger effect to fire clears the warning');
// A crack-fired Trigger effect is where the break GOES, so the property nodes that do the breaking have to
// pass the counter check silently. This is the shape retail ships and the one a false positive would land on.
addEffectNodeTemplate(crackDoc, { ownerKind: 'graph',
  ownerId: crackDoc.slots[0].circumstances.trigger! }, 'breakable-kill');
check(!validateEffectsAuthoring(crackDoc, crackProps).some(issue => /fired by a Counter|still running/.test(issue.message)),
  'a crack-fired Trigger effect carrying the break itself draws no counter warning — that is the retail shape');

// The one placement measured as a console freeze rather than a misfire: a Counter fires its own column while
// still mid-update, so a stop command in that column tells the engine to destroy what is executing it.
const counterDoc = createEmptyEffectsDocument('COUNT');
const counterProps: PlacedProp[] = [{ id: 'prop:gate', level: 'MEGAPLE', model: 164, name: 'Gate',
  pos: [0, 0, 0], yaw: 0, scale: 1 }];
addEffectTemplateToProp(counterDoc, 'prop:gate', 'counter');
addEmptyEffectToProp(counterDoc, 'prop:gate', 'trigger');
const counterTrigger: EffectSelection = { ownerKind: 'graph',
  ownerId: counterDoc.slots[0].circumstances.trigger! };
addEffectNodeTemplate(counterDoc, counterTrigger, 'node-destroy');
check(validateEffectsAuthoring(counterDoc, counterProps).some(issue =>
  issue.severity === 'error' && issue.path.endsWith('.trigger') && /console freeze/.test(issue.message)),
  'a stop command in a Counter-fired Trigger effect is an ERROR — the measured outcome is a hung console');

// The softer half of the same rule: any node that installs on this prop displaces the counter running it.
const counterInstallDoc = createEmptyEffectsDocument('COUNT');
addEffectTemplateToProp(counterInstallDoc, 'prop:gate', 'counter');
addEmptyEffectToProp(counterInstallDoc, 'prop:gate', 'trigger');
addEffectNodeTemplate(counterInstallDoc, { ownerKind: 'graph',
  ownerId: counterInstallDoc.slots[0].circumstances.trigger! }, 'texture-flip');
check(validateEffectsAuthoring(counterInstallDoc, counterProps).some(issue =>
  issue.severity === 'warning' && /displaces it mid-update/.test(issue.message)),
  'and a node that installs on the counter\'s own prop warns, pointing at Run on another prop instead');

// Every node that lays down pointing at nothing. Each is silent in the editor and either drops the effect at
// export or does nothing on hardware, so the reference being empty is the only moment anyone can be told.
const unboundDoc = createEmptyEffectsDocument('BIND');
const unboundProps: PlacedProp[] = [{ id: 'prop:btn', level: 'MEGAPLE', model: 164, name: 'Button',
  pos: [0, 0, 0], yaw: 0, scale: 1 }];
for (const templateId of ['act-on-instance', 'rider-teleport', 'spline-toggle'] as const)
  addEffectTemplateToProp(unboundDoc, 'prop:btn', templateId);
const unboundIssues = validateEffectsAuthoring(unboundDoc, unboundProps)
  .filter(issue => issue.severity === 'error' && /\.references\./.test(issue.path));
check(unboundIssues.length === 4
  && unboundIssues.some(issue => /no target prop/.test(issue.message))
  && unboundIssues.some(issue => /no effect to run/.test(issue.message))
  && unboundIssues.some(issue => /no destination/.test(issue.message))
  && unboundIssues.some(issue => /no rail/.test(issue.message)),
  'a node laid down with nothing to point at reports the empty reference rather than exporting silently');

// The authored Run inspector follows the same stable placement binding the exporter back-patches. Resolve
// both halves here so its Go-to-effect action cannot silently open the caller or a same-named graph instead.
const hopDoc = createEmptyEffectsDocument('HOP');
const hopProps: PlacedProp[] = [
  { id: 'prop:button', level: 'DONOR', model: 10, name: 'Button', pos: [0, 0, 0], yaw: 0, scale: 1 },
  { id: 'prop:firework', level: 'DONOR', model: 20, name: 'Firework launcher', pos: [10, 0, 0], yaw: 0, scale: 1 },
];
const targetEffect = addEffectTemplateToProp(hopDoc, 'prop:firework', 'timer-emitter');
const callerEffect = addEffectTemplateToProp(hopDoc, 'prop:button', 'collision-trigger');
const hopSelection = addEffectNodeTemplate(hopDoc, callerEffect, 'act-on-instance');
const hopNode = hopSelection ? effectNode(hopDoc, hopSelection) : null;
if (!hopNode) throw new Error('authored call navigation fixture did not create its Run node');
bindInstanceHop(hopDoc, hopNode, 'prop:firework', targetEffect.ownerId);
const authoredCall = authoredInstanceEffectCall(hopDoc, hopProps, hopNode);
check(authoredCall?.target?.id === 'prop:firework' && authoredCall.graph?.id === targetEffect.ownerId
  && authoredCall.targetLabel === 'Firework launcher · prop:firework',
  'authored Run navigation resolves the receiving placement and called graph through its stable instance row');

// Authored, exportable, and never seen to move the field it exists to move. That is a warning an author
// should get on the prop rather than in a play test.
const gemDoc = createEmptyEffectsDocument('SHOWOFF');
const gemProps: PlacedProp[] = [{ id: 'prop:gem', level: 'MEGAPLE', model: 164, name: 'Gem',
  pos: [0, 0, 0], yaw: 0, scale: 1 }];
addEffectTemplateToProp(gemDoc, 'prop:gem', 'score-multiplier');
check(validateEffectsAuthoring(gemDoc, gemProps).some(issue =>
  issue.severity === 'warning' && /not yet been seen to work/.test(issue.message)
  && /Showoff/.test(issue.message)),
  'Score multiplier warns that it is unproven on hardware and Showoff-only, instead of burying it in prose');
const doorTemplateSelection = addEffectTemplateToProp(latchDoc, 'prop:door', 'one-shot-clip');
const doorClipNode = effectNode(latchDoc, doorTemplateSelection);
check(animObjectFromNode(doorClipNode!)?.loopMode === 0
  && effectSlotHoldsAtEnd(latchDoc.slots[0]) && !!latchDoc.slots[0].circumstances.slot3
  && effectSlotCanSelfEnd(latchDoc, latchDoc.slots[0])
  && !validateEffectsAuthoring(latchDoc, latchProps).some(issue => /slot[34]/.test(issue.path)),
  'the one-shot clip template wires the play-once collision clip and both latches, validating clean');
// The permanent breakable wires the OTHER column, and which one is the whole content of the recipe: a kill's
// tombstone never self-ends, so Effect end is never consulted for it and only Region exit keeps the prop
// hidden (Trailmap/tools/autotest, cells `latch-kill-region` / `latch-kill-end`). A recipe that quietly wired
// slot4 would author a prop that unbreaks itself and validate perfectly clean.
const breakDoc = createEmptyEffectsDocument('LATCH');
const breakProps: PlacedProp[] = [{ id: 'prop:crate', level: 'DONOR', model: 0, name: 'Crate',
  pos: [0, 0, 0], yaw: 0, scale: 1 }];
const breakSelection = addEffectTemplateToProp(breakDoc, 'prop:crate', 'breakable-permanent');
check((effectNode(breakDoc, breakSelection)?.payload.type0 as { DeadNodeMode?: number })?.DeadNodeMode === 4
  && effectSlotHoldsOnRegionExit(breakDoc.slots[0]) && !effectSlotHoldsAtEnd(breakDoc.slots[0])
  && effectSlotLatchIsEmptyGraph(breakDoc, breakDoc.slots[0], 'slot3')
  && !validateEffectsAuthoring(breakDoc, breakProps).some(issue => issue.severity === 'error'),
  'the permanent breakable wires the kill with Region exit only — the one column that reaches a tombstone');
check(setPropEffectLatch(latchDoc, 'prop:door', 'slot4', false)
  && !latchDoc.slots[0].circumstances.slot4
  && !setPropEffectLatch(latchDoc, 'prop:door', 'slot4', false),
  'unchecking a latch clears the column, garbage-collects its empty sentinel, and re-unchecking is a no-op');
check(setPropEffectLatch(latchDoc, 'prop:door', 'slot4', true), 'a cleared latch can be re-checked');
const noLiveNodeGate: EffectNode = { id: 'gate', mainType: 5, semanticType: 'condition.no-live-node',
  payload: { type5: { U0: 3, U1: 0, U2: 0 } }, references: {} };
latchDoc.graphs.find(graph => graph.id === latchDoc.slots[0].circumstances.collision)!.nodes.push(noLiveNodeGate);
check(validateEffectsAuthoring(latchDoc, latchProps).some(issue =>
  issue.path.endsWith('.slot4') && /Only if: prop is idle/.test(issue.message)),
  'Effect end alongside a no-live-node gate warns — the kept node blocks the gate forever');
const dirtyLatchDoc = cloneEffectsDocument(latchDoc);
dirtyLatchDoc.graphs.find(graph => graph.id === dirtyLatchDoc.slots[0].circumstances.slot3)!.nodes.push({
  id: 'stray', mainType: 4, semanticType: 'wait', payload: { WaitTime: 1 }, references: {} });
dirtyLatchDoc.slots[0].circumstances.slot6 = dirtyLatchDoc.slots[0].circumstances.collision;
const dirtyLatchIssues = validateEffectsAuthoring(dirtyLatchDoc, latchProps);
check(dirtyLatchIssues.some(issue => issue.path.endsWith('.slot3') && /INSTEAD/.test(issue.message))
  && dirtyLatchIssues.some(issue => issue.path.endsWith('.slot6') && /can never run/.test(issue.message)),
  'a populated latch chain and a dead-column reference each warn with the recovered engine reason');

// ---- the proven badge has to stay attached to real evidence ------------------------------------------
// A template marked proven claims a specific auto-test cell demonstrated it. Cells get renamed and retired as
// the fixtures evolve, and a claim pointing at a cell that no longer exists is worse than no claim: it still
// sorts to the top of the picker under a heading an author trusts. So the join is checked here rather than by
// anyone remembering to.
const knownCells = new Set<string>();
for (const fixture of AUTO_TEST_FIXTURES) for (const item of fixture.cases) {
  knownCells.add(item.id);
  // A cell with a companion synthesises a second plan entry for the object the hop lands on.
  if (item.companion) knownCells.add(`${item.id}-target`);
}
// Claims that are about the whole matrix rather than one cell, which no cell id could name.
const MATRIX_WIDE = new Set(['every gold-map cell']);
const danglingProofs = EFFECT_TEMPLATES.flatMap(template => (template.proven?.cell ?? '')
  .split('/').map(cell => cell.trim()).filter(Boolean)
  .filter(cell => !knownCells.has(cell) && !MATRIX_WIDE.has(cell))
  .map(cell => `${template.id} -> ${cell}`));
check(!danglingProofs.length,
  `every proven template names a live auto-test cell${danglingProofs.length ? ` (dangling: ${danglingProofs.join(', ')})` : ''}`);
// The badge means "hardware showed this doing its job". Two nodes have been demonstrated doing NOTHING, which
// is just as well evidenced and exactly the opposite claim, so they must never carry it.
check(!EFFECT_TEMPLATES.some(template => template.proven && ['roller', 'lap-boost'].includes(template.id)),
  'a node demonstrated to do nothing is kept out of the proven group, where it would read as an endorsement');

if (failures) process.exit(1);
console.log('EFFECTS DOCUMENT TESTS PASSED');
