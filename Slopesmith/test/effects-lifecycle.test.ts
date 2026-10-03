// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

// Run the real graph scheduler, scene effect layer and rail query in a browser. Renderer hooks record
// per-instance changes, while the real texture cache checks that stopping a material is isolated.
const source = `
import * as THREE from 'three';
import { createEmptyEffectsDocument } from './src/core/effects/authoring';
import { EFFECT_TEMPLATES } from './src/core/effects/authoring-catalogue';
import { createReferenceEffectsLayer } from './src/app/viewport/scene/reference-effects';
import { createGrindRails } from './src/app/ride/grind';
import { PropTextureCache } from './src/app/props/textures';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const stage = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), refRoot: new THREE.Group(), worldRoot: new THREE.Group() };
stage.scene.add(stage.camera, stage.refRoot, stage.worldRoot);
const states = [0,1].map(() => ({ visible: true, writes: 0, copies: 0, retired: false, stopped: false }));
const effectResets = [0, 0];
const runtime = createReferenceEffectsLayer(stage, {
  setReferenceInstanceVisible: (index, value) => { states[index].visible = value ?? true; },
  setReferenceInstanceWorldMatrix: index => states[index].writes++,
  setReferenceInstanceWorldCopies: (index, matrices) => { states[index].copies = matrices?.length ?? 0; },
  setObjectEffectsStopped: (object, stopped) => { states[object.index].stopped = stopped; },
  retireRideObject: object => { states[object.index].retired = true; },
  restoreRideObject: object => { states[object.index].retired = false; },
  resetObjectEffects: object => { effectResets[object.index]++; },
  resetSceneRuntime: () => states.forEach(state => Object.assign(state, { visible: true, writes: 0, copies: 0, retired: false, stopped: false })),
  resolveSpline: () => ({ originalIndex: 0, style: 1, space: 'editor', segments: [[[0,0,0],[0,0,3],[0,0,6],[0,0,9]]] }),
});
const node = (semanticType, mainType, payload, references = {}) => ({ id: semanticType, semanticType, mainType, payload, references });
const flag = node('property.flag', 0, { type0: { SubType: 13, type0Sub13: { U0: 0, U1: 1, U2: 1 } } });
const mover = node('spline.animation', 2, { type2: { SubType: 1, SplineAnimation: { AnimationSpeed: 1, U1: 1, InstanceCount: 3 } } }, { spline: 'spline:0' });
const semantics = ['property.node-destroy', 'property.node-pause', 'property.node-tombstone', 'property.node-tombstone-flagged'];
const stop = mode => node(semantics[mode], 0, { type0: { SubType: 5, DeadNodeMode: mode } });
const wait = seconds => node('wait', 4, { WaitTime: seconds });
const tick = (count = 1) => { for (let i=0; i<count; i++) runtime.step(0.1, new THREE.Vector3(), new THREE.Vector3(), 'reference'); };
const hit = () => runtime.propCollision({ kind: 'reference', index: 0 }, new THREE.Vector3(), new THREE.Vector3(0,0,1), 10);
const load = (persistent, collision) => {
  const document = createEmptyEffectsDocument('LIFECYCLE');
  document.splines = [{ id: 'spline:0', originalIndex: 0 }];
  document.graphs = [{ id: 'motion', nodes: persistent }, { id: 'collision', nodes: collision }];
  document.slots = [{ id: 'slot:0', originalIndex: 0, circumstances: { persistent: 'motion', collision: 'collision',
    slot3: null, slot4: null, trigger: null, slot6: null, slot7: null } }];
  runtime.setData({ level: 'LIFECYCLE', document, instances: [0,1].map(index => ({ index, name: 'prop'+index, modelName: 'prop', model: 0,
    loc: [0,0,0], rot: [0,0,0,1], scale: [1,1,1], effectSlotIndex: 0, visible: true, collisionSound: -1, contact: 'through' })) });
  runtime.beginPlay('reference'); tick();
  return document;
};
for (const mode of [0,1]) {
  const document = load([flag], [stop(mode)]);
  check(states[0].writes > 0, 'flag starts');
  const before = states[0].writes, other = states[1].writes;
  hit(); tick(3);
  check(states[0].writes === before && states[1].writes > other, 'stop freezes only the addressed flag');
  check(states[0].visible && !states[0].retired && states[0].stopped, 'stop leaves the prop and collision present');
  tick(10);
  document.graphs[1].nodes = [flag];
  hit(); tick();
  check(states[0].writes > before && !states[0].stopped, 'explicit constructor can replace the stopped node');
  runtime.endPlay();
  check(!states[0].stopped, 'leaving Test clears installed-node stop');
}
for (const mode of [2,3]) {
  load([mover], [stop(mode)]);
  check(states[0].copies === 2, 'mover created its extra copies');
  hit(); tick();
  const before = states[0].writes;
  tick(15);
  check(states[0].retired, 'tombstone retires collision');
  if (mode === 3) {
    check(states[0].writes === before && !states[0].visible && states[0].copies === 0, 'flagged kill stops motion and all copies');
    runtime.setWorldEffectsEnabled(true); tick(15);
    check(states[0].writes === before && !states[0].visible, 'ambient toggle cannot resurrect a killed mover');
    tick(95);
    check(!states[0].visible && states[0].retired, 'breakable stays broken past the former twelve-second reset');
    tick(180);
    check(states[0].visible && !states[0].retired && states[0].writes > before, 'breakable reset reinstalls persistent motion');
  } else check(states[0].writes > before, 'ordinary tombstone preserves detached motion');
  runtime.endPlay(); runtime.setWorldEffectsEnabled(false);
}
// The receiver lives on the target, not on the switch that calls it. A delayed reinstallation must run
// after a kill; deleting all scheduled work for the host would silently break this chain.
load([mover], [stop(3), wait(0.5), mover]);
hit(); tick(2); check(!states[0].visible, 'delayed constructor has not fired');
tick(5); check(states[0].visible && states[0].copies === 2, 'following graph work survives a kill');
runtime.endPlay();

load([mover], [stop(3)]); runtime.endPlay(); runtime.setWorldEffectsEnabled(true);
runtime.preview(0, 'collision'); runtime.step(0.1, new THREE.Vector3());
check(!states[0].visible && states[0].copies === 0, 'preview applies flagged kill');
runtime.stopPreview(); runtime.step(0.1, new THREE.Vector3());
check(states[0].visible && states[0].copies === 2, 'Stop preview restores the ambient mover');
runtime.setWorldEffectsEnabled(false);

const toggle = enabled => node('spline.toggle', 25, { Spline: { Effect: enabled ? 1 : 0 } }, { spline: 'spline:0' });
load([], [wait(0.3), toggle(true), wait(0.4), toggle(false)]);
const rail = createGrindRails([{ surf: 1, seat: 0, enabled: () => runtime.railEnabled('reference', 0, false),
  segments: [[new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,3),new THREE.Vector3(0,0,6),new THREE.Vector3(0,0,9)]] }]);
const point = new THREE.Vector3(0,0,4);
check(!rail.query(point), 'non-rail spline starts off'); hit(); tick(2);
check(!rail.query(point), 'rail switch respects Wait'); tick(2);
check(rail.query(point), 'rail enters the existing query after enable'); tick(5);
check(!rail.query(point), 'disabling rail removes it from the same query');
runtime.endPlay(); check(runtime.railEnabled('reference', 0, true), 'rail override resets between runs');

// Imported mode functions use zero-padded instance IDs. Their DeadNode calls hide rail models for the whole
// mode, not one breakable respawn cycle; the rail switch must retain its state past that deadline as well.
const modeDocument = load([], [stop(2)]);
runtime.endPlay();
const callRail = node('instance.effect-call', 7, {}, { instance: 'instance:000000', effectGraph: 'hide-rail' });
modeDocument.graphs.push({ id: 'hide-rail', nodes: [stop(2)] });
modeDocument.functions = [
  { id: 'race', name: 'RaceMode', nodes: [node('function.call', 21, {}, { function: 'hide-showoff' })] },
  { id: 'free', name: 'FreerideMode', nodes: [node('function.call', 26, {}, { function: 'hide-showoff' })] },
  { id: 'hide-showoff', name: 'HideShowOff', nodes: [callRail, wait(0.3), toggle(false)] },
];
for (const mode of ['race', 'freeride']) {
  const resetsBefore = effectResets[0];
  runtime.beginPlay('reference', mode);
  check(!states[0].visible && states[0].retired, mode + ' hides the rail in setup');
  tick(350);
  check(!states[0].visible && states[0].retired, mode + ' rail stays absent after thirty-five seconds');
  check(effectResets[0] === resetsBefore, 'mode setup never arms a breakable respawn');
  check(!runtime.railEnabled('reference', 0, true), 'mode rail switch survives the respawn deadline');
  // A real interaction can reach a hidden prop too. Its reset must resolve the same padded ID that setup
  // used, while still restoring the ordinary breakable that called it.
  modeDocument.graphs[1].nodes = [stop(2), callRail];
  runtime.propCollision({ kind: 'reference', index: 1 }, point, new THREE.Vector3(0,0,1), 10);
  tick();
  check(!states[1].visible && states[1].retired, 'ordinary breakable hides on contact');
  tick(305);
  check(states[1].visible && !states[1].retired, 'ordinary breakable still respawns');
  check(!states[0].visible && states[0].retired, 'interaction respawn respects padded mode-hidden instance ID');
  runtime.endPlay();
}
runtime.beginPlay('reference', 'showoff'); tick(150);
check(states[0].visible && !states[0].retired && runtime.railEnabled('reference', 0, true),
  'switching to Showoff restores the rail model, collision and grind state');
runtime.endPlay();

const authored = createEmptyEffectsDocument('AUTHORED');
authored.graphs = [{ id: 'switch', nodes: [toggle(true)] }];
authored.slots = [{ id: 'slot', circumstances: { persistent: null, collision: 'switch',
  slot3: null, slot4: null, trigger: null, slot6: null, slot7: null } }];
authored.extensions = { slopesmith: { attachments: [{ id: 'attachment', target: { kind: 'prop', id: 'switch' },
  slot: 'slot', circumstance: 'collision', enabled: true }] } };
runtime.setAuthoredData([{ id: 'switch', pos: [0,0,0], scale: 1, yaw: 0 }], authored);
runtime.beginPlay('authored');
runtime.propCollision({ kind: 'authored', id: 'switch' }, point, new THREE.Vector3(0,0,1), 10);
runtime.step(0.1, point, point, 'authored');
check(runtime.railEnabled('authored', '0', false), 'authored switches resolve placement rail IDs');
check(!runtime.railEnabled('reference', 0, false), 'authored rail switch does not affect reference rails');
runtime.endPlay(); runtime.setAuthoredData([], null);

const emitter = structuredClone(EFFECT_TEMPLATES.find(t => t.id === 'timer-emitter').nodes[0]);
emitter.id = 'emitter';
// A short lifetime allows existing particles to expire, distinguishing a stopped emitter from an invisible host.
const fields = emitter.payload.type2.type2Sub0;
fields.U0 = 20; fields.U2 = -1; fields.U5 = 0.15;
load([emitter], [stop(3)]);
runtime.setWorldEffectsEnabled(true); tick(15);
const countParticles = () => stage.scene.getObjectByName('SSF additive particles').geometry.instanceCount
  + stage.scene.getObjectByName('SSF alpha particles').geometry.instanceCount;
check(countParticles() > 0, 'persistent emitters started');
// Both emitters run; disable the untouched host's stream too so the render batch must drain completely.
hit(); runtime.propCollision({ kind: 'reference', index: 1 }, new THREE.Vector3(), new THREE.Vector3(0,0,1), 10);
tick(40);
check(countParticles() === 0, 'flagged emitter kill drains particles and survives repeated ambient scans');
runtime.endPlay();

const textures = new PropTextureCache();
const effect = { uvScroll: { mode: 0, uPerTick: 0.01, vPerTick: 0, activeDuration: 1, pauseDuration: 0, lifetime: 0 } };
const a = textures.material('TEST', 'pixel.png', effect, [], 'a');
const b = textures.material('TEST', 'pixel.png', effect, [], 'b');
textures.setWorldEffectsEnabled(true); textures.stepWorldEffects(0.1);
const ax = a.map.offset.x, bx = b.map.offset.x;
textures.setMaterialEffectStopped(a, true); textures.stepWorldEffects(0.1);
check(a.map.offset.x === ax && b.map.offset.x !== bx, 'stopping one UV clock leaves the other material running');
textures.setMaterialEffectStopped(a, false); textures.stepWorldEffects(0.1);
check(a.map.offset.x !== ax, 'material clock resumes after reset');
window.lifecyclePassed = true;
`;

const bundle = await build({ stdin: { contents: source,
  resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
const server = createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/fixture.js') {
    response.setHeader('content-type', 'image/png');
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'));
    return;
  }
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].text
    : '<!doctype html><html><body><script type="module" src="/fixture.js"></script></body></html>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window as Window & { lifecyclePassed?: boolean }).lifecyclePassed,
    undefined, { timeout: 10_000 }).catch(() => assert.fail(errors.join('\n') || 'Lifecycle fixture did not finish'));
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => (window as Window & { lifecyclePassed?: boolean }).lifecyclePassed), true);
  console.log('EFFECT LIFECYCLE BROWSER TEST PASSED');
} finally { await browser.close(); server.close(); }
