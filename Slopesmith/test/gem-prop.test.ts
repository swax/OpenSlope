// tier: fast
import { gemEffectTemplate, promoteGem } from '../src/core/props/gem';
import { baselineBehaviour } from '../src/core/props/defaults';
import { addEffectTemplateToProp, createEmptyEffectsDocument, effectAttachments, validateEffectsAuthoring } from '../src/core/effects/authoring';
import { effectPlayCommand } from '../src/core/effects/play-runtime';
import { specialPropNode, type SpecialDocument } from '../src/core/props/special';
import { bakePlacedProps } from '../src/core/export/props';
import { buildMaterialCombiner } from '../src/core/export/materials';
import { buildCanonicalProps } from '../src/core/export/canonical-props';
import { check, failures } from './check';

const native = createEmptyEffectsDocument('DONOR');
addEffectTemplateToProp(native, 'source', 'score-multiplier');
const collision = native.graphs[0];
collision.nodes.push({ id: 'pickup', mainType: 0, semanticType: 'property.node-tombstone',
  payload: { type0: { SubType: 5, DeadNodeMode: 2 } }, references: {} });
native.graphs.push({ id: 'spin', name: 'Spin', nodes: [{ id: 'spin-node', mainType: 0,
  semanticType: 'property.anim-object', payload: { type0: { SubType: 256,
    type0Sub256: { U0: 1, U1: -1, U2: -1, U3: 45, U4: 0, U5: 1, U6: 0, U7: 3 } } }, references: {} }] });
native.slots[0].circumstances.persistent = 'spin';
const template = gemEffectTemplate('DONOR', native, 0)!;
check(!!template && template.circumstances.persistent?.[0].semanticType === 'property.anim-object',
  'gem preset keeps the native spin and the complete pickup chain');
const doc: SpecialDocument = { name: 'GEMS', gems: [
  { id: 'gem:0000', pos: [10, 20, 30], value: 3 }, { id: 'gem:0001', pos: [0, 0, 0], value: 2 },
] };
const before = JSON.stringify(doc);
const model = { level: 'DONOR', model: 2, name: 'Gem_TrickMultiplier_OrangeX3' };
const prop = promoteGem(doc, 'gem:0000', model, baselineBehaviour('DONOR'), template)!;
check(doc.gems?.length === 1 && doc.props?.length === 1 && prop.pos.join() === '10,20,30',
  'opening standard tools replaces exactly one gem, preserving its position');
check(prop.specialKind === 'gem' && prop.modePresence === 'showoff'
  && prop.nativeCollision?.playerCollision && prop.nativeCollision.responseMass === 0,
  'the ordinary prop preserves Showoff-only pickup contact');
const score = specialPropNode(doc.effects, prop, 'gem')!;
check(score.payload.MultiplierScore === 3 && effectPlayCommand(score)?.kind === 'score-multiplier',
  'the legacy tier becomes a real editable score node');
check(doc.effects!.graphs.some(graph => graph.nodes.some(node => effectPlayCommand(node)?.kind === 'instance-hide')),
  'the ordinary effect hides the collected gem');
check(!promoteGem(doc, 'gem:0000', model, baselineBehaviour('DONOR'), template),
  'repeated navigation cannot duplicate an upgraded gem');
const second = promoteGem(doc, 'gem:0001', model, baselineBehaviour('DONOR'), template)!;
score.payload.MultiplierScore = 5;
check(specialPropNode(doc.effects, second, 'gem')!.payload.MultiplierScore === 2,
  'editing one gem in the standard graph leaves another gem’s multiplier alone');
check(validateEffectsAuthoring(doc.effects!, doc.props).every(issue => issue.severity !== 'error'),
  'both upgraded gems have valid standard effect attachments');
check(JSON.parse(before).gems.length === 2 && !JSON.parse(before).props,
  'the previous document snapshot remains suitable for undo');

const bake = bakePlacedProps([prop], () => ({
  subs: [{ mat: -1, positions: [0, 0, 0, 100, 0, 0, 0, 0, 100], uvs: [], indices: [0, 1, 2] }],
  rotation: { clipFrames: 60, axis: 2, segments: [[0, 0, 180, 0, 0, 2]] },
}), buildMaterialCombiner(new Map()));
const exported = buildCanonicalProps(bake.groups, {
  bakedGroups: bake.bakedGroups, propClips: bake.propClips, propPoses: {}, collisionSounds: {},
  collisionSoundClips: {}, ambientSounds: {}, propBounce: {}, propSurfaces: {},
  propModePresence: { [prop.id!]: 'showoff' }, nativeCollisions: {}, propLighting: {}, effects: doc.effects,
});
const packedModels = JSON.parse(exported.text['Models.json']).Models;
check(exported.animatedModels === 1 && packedModels[0].AnimTime === 60
  && bake.groups[0].subs[0].object === 1,
  'native spin reaches the exported model and its animated geometry object');
check(exported.effectBindings === 1 && JSON.parse(exported.text['Instances.json']).Instances[0].LTGState === 2,
  'export binds the real effect graph and Showoff layer to the prop');
check(effectAttachments(doc.effects!).length === 2 && doc.gems?.length === 0,
  'export has one gameplay representation per gem');
collision.nodes[0].references = { instance: 'unresolved-other-instance' };
check(!gemEffectTemplate('DONOR', native, 0), 'source-level references are never copied unbound');
if (failures) process.exit(1);
console.log('gem-prop: all checks passed');
