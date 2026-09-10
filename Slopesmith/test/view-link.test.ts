// tier: fast
import assert from 'node:assert/strict';
import { encodeViewLink, parseViewLink, VIEW_FLAGS } from '../src/core/view-link';
import { browserProjectLinks, BROWSER_VIEW_SCHEMA } from '../src/server/api/browser-workflows';

assert.equal(parseViewLink(''), null);
assert.equal(parseViewLink('#invite=keep-me'), null);
const original = parseViewLink('#view=1&pos=100,270,80&look=184,187,-25&up=0,1,0&fov=65&size=1600,900&ui=0')!;
assert.deepEqual(parseViewLink(encodeViewLink(original)), original, 'a camera and explicit display settings round-trip');
const topology = parseViewLink('#view=1&label=Snow%20%26%20rock&preset=topology&az=-75&el=50&projection=orthographic&height=400')!;
assert.equal(topology.label, 'Snow & rock');
assert.equal(topology.options.cage, true);
assert.equal(topology.options.shadeMode, 'none');
assert.equal(topology.options.props, false);
assert.deepEqual(parseViewLink(encodeViewLink(topology)), topology);
const reference = parseViewLink('#view=1&reference=GARI&space=reference&refOffset=2000,20,-10&pos=1,2,3&look=4,5,6')!;
assert.deepEqual(parseViewLink(encodeViewLink(reference)), reference);
for (const [fragment, message] of [
  ['pos=1,2,3', /together/], ['pos=1,2,3&look=1,2,3', /apart/],
  ['pos=1,,3&look=0,0,0', /finite/], ['pos=NaN,2,3&look=0,0,0', /finite/],
  ['up=0,0,0', /nonzero/], ['fov=180', /fov/], ['size=4096,4096', /pixels/],
  ['size=100.5,900', /integer/], ['ui=true', /ui/], ['revision=1.5', /integer/],
  ['unknown=1', /Unknown/], ['fov=55&fov=65', /Repeated/], ['view=2', /Repeated/],
  ['space=reference', /reference level/], ['label=x&pos=0,0,0&look=1,1,1', /not both/],
] as const) assert.throws(() => parseViewLink(`#view=1&${fragment}`), message, fragment);
assert.deepEqual(Object.keys(BROWSER_VIEW_SCHEMA.properties).filter(k => k in VIEW_FLAGS).sort(), Object.keys(VIEW_FLAGS).sort());
const envelope = browserProjectLinks('map/id', 27);
for (const template of envelope._linkTemplates!) {
  const values: Record<string, string> = { pos: '100,270,80', look: '184,187,-25', fov: '65', size: '1600,900', label: 'Snow & rock', az: '45', el: '35', preset: 'topology' };
  const url = new URL(template.hrefTemplate.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(values[key])), 'http://localhost');
  assert.equal(url.searchParams.get('project'), 'map/id');
  assert.equal(parseViewLink(url.hash)!.revision, 27, 'API templates expand into accepted view links');
  assert.equal(template.execution, 'browser');
}
console.log('VIEW LINK TESTS PASSED');
