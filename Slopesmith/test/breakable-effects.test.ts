// tier: fast
import assert from 'node:assert/strict';
import { authoredPropMaterialControl, createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { parseEffectsDocument, type EffectNode } from '../src/core/effects/document';
import { effectPlayCommand, runScheduledEffectGraphs, scheduleEffectGraph } from '../src/core/effects/play-runtime';
import { referenceImmediateBreakInstances, referenceMaterialControls, type ReferenceEffectsData } from '../src/core/reference/effects';

const document = createEmptyEffectsDocument('GLASS');
// Validate the semantic/payload pairs used by imported effects before decoding them for Play.
const semantics = ['property.node-destroy', 'property.node-pause', 'property.node-tombstone',
  'property.node-tombstone-flagged', 'property.breakable-kill'];
for (let mode = 0; mode <= 4; mode++) document.graphs.push({
  id: `graph:mode-${mode}`, nodes: [{
    id: `node:mode-${mode}`, mainType: 0, semanticType: semantics[mode], references: {},
    payload: { type0: { SubType: 5, DeadNodeMode: mode } },
  }],
});
const parsed = parseEffectsDocument(document);
for (let mode = 0; mode <= 4; mode++) {
  const command = effectPlayCommand(parsed.graphs[mode].nodes[0]);
  assert.equal(command?.kind ?? null, mode >= 2 ? 'instance-hide' : 'node-stop',
    `DeadNode mode ${mode} ${mode >= 2 ? 'hides and disarms the instance' : 'only affects the installed node'}`);
  if (command?.kind === 'instance-hide') assert.equal(command.killDetached, mode === 3);
  if (command?.kind === 'node-stop') assert.equal(command.destroy, mode === 0);
}

const wait: EffectNode = {
  id: 'node:wait', mainType: 4, semanticType: 'wait', payload: { WaitTime: 0.05 }, references: {},
};
const tombstone = parsed.graphs[2].nodes[0];
const call: EffectNode = {
  id: 'node:debris', mainType: 7, semanticType: 'instance.state', payload: {},
  references: { instance: 'instance:1', effectGraph: 'graph:debris' },
};
const breakGraph = { id: 'graph:break', nodes: [wait, tombstone, call] };
const queue: Parameters<typeof scheduleEffectGraph<number, null>>[0] = [];
const actions: string[] = [];
scheduleEffectGraph(queue, 0, breakGraph, 0, 0, null);
const hooks = {
  condition: () => true,
  execute: (_host: number, node: EffectNode) => {
    const command = effectPlayCommand(node);
    if (command) actions.push(command.kind);
    if (node.mainType === 7) actions.push('debris');
  },
};
runScheduledEffectGraphs(queue, 0.049, hooks);
assert.deepEqual(actions, [], 'the pane remains intact during the initial solid impact');
runScheduledEffectGraphs(queue, 0.05, hooks);
assert.deepEqual(actions, ['instance-hide', 'debris'], 'the delayed break removes the pane before launching its twin');

parsed.graphs.push(breakGraph);
parsed.slots.push({ id: 'slot:break', originalIndex: 0, circumstances: {
  persistent: null, collision: breakGraph.id, slot3: null, slot4: null, trigger: null, slot6: null, slot7: null,
} });
const data: ReferenceEffectsData = {
  level: 'GLASS', document: parsed, instances: [{
    index: 0, name: 'intact-pane', modelName: 'glass', model: 0,
    loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
    effectSlotIndex: 0, visible: true, collisionSound: -1, contact: 'solid',
  }],
};
assert.equal(referenceImmediateBreakInstances(data).has(0), false,
  'a delayed tombstone preserves the initial blocking/bounce response');
breakGraph.nodes = [tombstone, call];
assert.equal(referenceImmediateBreakInstances(data).has(0), true,
  'an immediate tombstone is a ride-through break');

const materials = createEmptyEffectsDocument('MATERIALS');
const scroll: EffectNode = { id: 'scroll', mainType: 0, semanticType: 'property.uv-scroll',
  payload: { type0: { SubType: 10, UVScroll: { U0: 0, U1: 0.01, U2: 0, U3: 1, U4: 0, U5: 0 } } }, references: {} };
materials.graphs = [{ id: 'scroll', nodes: [scroll] }, { id: 'stop', nodes: [parsed.graphs[0].nodes[0]] },
  { id: 'switch', nodes: [{ id: 'call', mainType: 7, semanticType: 'instance.state', payload: {},
    references: { instance: 'instance:0', effectGraph: 'stop' } }] }];
materials.slots = [{ id: 'slot:scroll', originalIndex: 0, circumstances: {
  persistent: 'scroll', collision: null, slot3: null, slot4: null, trigger: null, slot6: null, slot7: null,
} }];
materials.instances = [{ id: 'instance:0', originalIndex: 0, property: null,
  extensions: { slopesmith: { placement: 'prop:0' } } }];
materials.extensions = { slopesmith: { attachments: [
  { id: 'attachment:0', target: { kind: 'prop', id: 'prop:0' }, slot: 'slot:scroll', circumstance: 'persistent', enabled: true },
] } };
const materialData = { ...data, document: materials,
  instances: [data.instances[0], { ...data.instances[0], index: 1 }] };
assert.deepEqual([...referenceMaterialControls(materialData).keys()], [0],
  'only the called stop target gets a private material; identical untouched props remain shared');
assert.equal(authoredPropMaterialControl(materials, 'prop:0')?.receiver, 'uv-scroll',
  'an authored cross-prop stop also isolates its target material');

console.log('BREAKABLE EFFECTS TEST PASSED');
