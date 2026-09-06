// tier: fast

import { strict as assert } from 'node:assert';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import {
  effectHostIsPresentInMode, effectModeDisabledSplineIds, effectModeFunctionName, effectModeHiddenInstanceIds,
  effectModeNodes,
  nativeGemModelIsShowoffOnly, nativeInstanceIsShowoffOnly,
} from '../src/core/effects/mode-functions';
import type { EffectFunction, EffectNode } from '../src/core/effects/document';

const doc = createEmptyEffectsDocument('MODE_TEST');
doc.splines.push({ id: 'spline:rail:showoff', originalIndex: 4, data: {} });

const call = (id: string, fn: string): EffectNode => ({
  id, mainType: 21, payload: {}, references: { function: fn },
});
const hide = (id: string, instance: string): EffectNode => ({
  id, mainType: 7, payload: { Instance: { Effect: 0 } }, references: { instance },
});
const railOff: EffectNode = {
  id: 'rail-off', mainType: 25, payload: { Spline: { Effect: 0 } },
  references: { spline: 'spline:rail:showoff' },
};
const fn = (id: string, name: string, nodes: EffectNode[]): EffectFunction => ({ id, name, nodes });

doc.functions.push(
  fn('race-mode', 'RaceMode', [call('race-call', 'hide-showoff')]),
  fn('showoff-mode', 'ShowoffMode', [call('showoff-call', 'hide-race')]),
  fn('free-mode', 'FreerideMode', [call('free-showoff', 'hide-showoff'), call('free-race', 'hide-race')]),
  fn('hide-showoff', 'HideShowOff', [hide('hide-rail-model', 'instance:rail'), railOff]),
  fn('hide-race', 'HideRace', [hide('hide-race-pad', 'instance:pad')]),
);

assert.equal(effectModeFunctionName('showoff'), 'ShowoffMode');
assert.deepEqual(effectModeNodes(doc, 'race').map(node => node.id),
  ['race-call', 'hide-rail-model', 'rail-off']);
assert.deepEqual(effectModeNodes(doc, 'showoff').map(node => node.id),
  ['showoff-call', 'hide-race-pad']);
assert.deepEqual(effectModeNodes(doc, 'freeride').map(node => node.id),
  ['free-showoff', 'hide-rail-model', 'rail-off', 'free-race', 'hide-race-pad']);
assert.deepEqual([...effectModeDisabledSplineIds(doc, 'race')], ['spline:rail:showoff']);
assert.deepEqual([...effectModeDisabledSplineIds(doc, 'showoff')], []);
assert.deepEqual([...effectModeHiddenInstanceIds(doc, 'race')], ['instance:rail']);
assert.deepEqual([...effectModeHiddenInstanceIds(doc, 'showoff')], ['instance:pad']);
assert.deepEqual([...effectModeHiddenInstanceIds(doc, 'freeride')], ['instance:rail', 'instance:pad']);
assert.equal(nativeGemModelIsShowoffOnly('Gem_TrickMultiplier_YellowX2'), true);
assert.equal(nativeGemModelIsShowoffOnly('Gem_RailSupport_1000'), true);
assert.equal(nativeGemModelIsShowoffOnly('Mdl_Rail_Metal_1005'), false);
assert.equal(nativeInstanceIsShowoffOnly({ modelName: 'Gem_RailSupport_1000', ltgState: 2 }), true);
assert.equal(nativeInstanceIsShowoffOnly({ modelName: 'Mdl_Rail_Metal_1005', ltgState: 0 }), false);
assert.equal(nativeInstanceIsShowoffOnly({ modelName: 'Gem_TrickMultiplier_YellowX2' }), true,
  'older payloads without LTGState retain the known model fallback');
assert.equal(effectHostIsPresentInMode('race', {}), true,
  'common world effects are present across modes');
assert.equal(effectHostIsPresentInMode('race', { showoffOnly: true }), false,
  'a Race recipient does not instantiate a Showoff-only target');
assert.equal(effectHostIsPresentInMode('showoff', { showoffOnly: true }), true,
  'Showoff instantiates its dedicated target layer');
assert.equal(effectHostIsPresentInMode('showoff', { hiddenByMode: true }), false,
  'an explicit mode hide wins even for an otherwise common target');

// A malformed/custom cycle must terminate rather than recursively scheduling forever.
doc.functions.find(f => f.id === 'hide-race')!.nodes.push(call('cycle', 'showoff-mode'));
assert.equal(effectModeNodes(doc, 'showoff').filter(node => node.id === 'hide-race-pad').length, 1);

console.log('mode functions: named entry points, native LTG Showoff presence, nested leaves, rail gating, and cycles ok');
