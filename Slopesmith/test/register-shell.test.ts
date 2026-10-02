// tier: fast

import assert from 'node:assert/strict';
import { canonicalJson } from '../src/core/doc/canonical';
import { seedMeshIds } from '../src/core/doc/ids';
import { applyRegisters, documentRegisters, registerShell } from '../src/core/doc/registers';
import type { QuadMeshDoc } from '../src/core/doc/types';

const mountain = (): QuadMeshDoc => ({
  kind: 'mountain', version: 5, name: 'REGISTER_SHELL', spacing: 1, baseSurface: 1,
  course: { knots: [], blend: 0, surface: 1 },
  vertices: [0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0], quads: [[0, 1, 2, 3]],
  ...seedMeshIds(0, 4, 1),
});

function roundTrip(doc: QuadMeshDoc): QuadMeshDoc {
  const rebuilt = registerShell(doc);
  // Values cross a JSON boundary, as they do during a full resync.
  const registers = documentRegisters(doc);
  const counts = applyRegisters(rebuilt, [...registers].map(([key, value]) =>
    [key, JSON.parse(JSON.stringify(value))] as const));
  assert.deepEqual(counts, { landed: registers.size, retired: 0, refused: 0 });
  assert.equal(canonicalJson(rebuilt), canonicalJson(doc), 'reconstruction preserves the document hash input');
  return rebuilt;
}

// An omitted or explicitly undefined field carries no container. A present empty container is data and
// must survive. Prop lines exposed this distinction when mountain generation began assigning undefined.
const maps = ['edgeHandles', 'quadPaint', 'quadTex', 'quadOrient', 'quadLocked', 'quadTwist', 'quadLabels'] as const;
const lists = ['props', 'lights', 'rails', 'gems', 'models', 'particleVolumes', 'screens', 'propLines', 'labels'] as const;
for (const field of [...maps, ...lists]) {
  const omitted = mountain();
  assert.equal(Object.hasOwn(roundTrip(omitted), field), false, `${field}: omitted stays omitted`);

  const undefinedField = Object.assign(mountain(), { [field]: undefined });
  assert.equal(roundTrip(undefinedField)[field], undefined, `${field}: undefined stays absent`);

  const empty = (maps as readonly string[]).includes(field) ? {} : [];
  const emptyField = Object.assign(mountain(), { [field]: empty });
  const rebuilt = roundTrip(emptyField);
  assert.deepEqual(rebuilt[field], empty, `${field}: an empty container survives`);
  assert.notEqual(rebuilt[field], empty, `${field}: the shell owns its container`);
}

const populated = mountain();
populated.edgeHandles = { '0>1': [0.5, 0.25, 0] };
populated.quadPaint = { 0: 2 };
populated.propLines = [{
  id: 'line:0000', nodes: [[0, 0, 0], [1, 0, 0]], scale: 1,
  template: { level: 'TEST', model: 7, name: 'Fence' },
}];
const shell = registerShell(populated);
assert.deepEqual(shell.edgeHandles, {});
assert.deepEqual(shell.quadPaint, {});
assert.deepEqual(shell.propLines, []);
roundTrip(populated);
assert.equal(populated.propLines.length, 1, 'shell construction leaves the source document intact');

console.log('REGISTER SHELL: PASS');
