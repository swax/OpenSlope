// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const source = `
import { budgetedAnimationScene } from './test/budgeted-animation.fixture';
import { createEmptyEffectsDocument } from './src/core/effects/authoring';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const node = (mainType, payload, references = {}) => ({ id: 'node', mainType, payload, references });
const delta = rate => node(0, { type0: { SubType: 257,
  type0Sub257: { U0: 0, U1: -1, U2: -1, U3: rate, U4: 0, U6: 0, U7: 3 } } });
const grant = value => node(3, { type3: { U0: 2, U1: value } });
const wait = seconds => node(4, { WaitTime: seconds });
const call = (index, graph) => node(7, {}, { instance: 'instance:'+index, effectGraph: graph });
const stop = mode => ({ ...node(0, { type0: { SubType: 5, DeadNodeMode: mode } }),
  semanticType: mode === 1 ? 'property.node-pause' : 'property.node-tombstone' });
const instances = [0,1,2].map(index => ({ index, sourceIndex: index, name: 'tree'+index, modelName: 'tree',
  model: 0, loc: [index*300,0,0], rot: [0,0,0,1], scale: [1,1,1], visible: true,
  effectSlotIndex: index === 0 ? 0 : -1, contact: 'through', collisionSound: -1,
  collisionModels: [], externalSounds: [], ltgState: 0, bounce: -1, surface: -1, shape: 0 }));
const document = createEmptyEffectsDocument('ANIMATION');
document.instances = instances.map(i => ({ id: 'instance:'+i.index, originalIndex: i.index }));
document.graphs = [
  { id: 'collision', nodes: [stop(2), wait(1), call(1,'fall')] },
  { id: 'fall', nodes: [delta(30), wait(0.5), grant(30)] },
];
document.slots = [{ id: 'slot:0', originalIndex: 0, circumstances: { collision: 'collision' } }];
const triangle = { mat: -1, positions: new Float32Array([0,0,0, 100,0,0, 0,0,1000]),
  uvs: new Float32Array(6), indices: new Uint32Array([0,1,2]) };
const props = { level: 'ANIMATION', instances, models: [{ id: 0, name: 'tree', subs: [triangle, triangle],
  rotation: { clipFrames: 60, axis: 0, segments: [[0,0,45,0,0,2]] } }],
  materials: new Map([[-1,{tex:null,frames:[]}]]), crowdFrames: [],
  collisionMeshes: new Map(), physicsBodies: new Map() };
const { runtime, decor, poses, tick, beginPlay, endPlay, hit } = budgetedAnimationScene(props,
  { level: 'ANIMATION', document, instances });
const before = JSON.stringify(poses(1)), sibling = JSON.stringify(poses(2));
check(poses(1).length === 2, 'check both visible model submeshes');
for (const mode of ['preview','play']) {
  if (mode === 'play') { beginPlay(); hit(0); } else runtime.preview(0,'collision');
  tick(50); check(JSON.stringify(poses(1)) === before, mode+': call obeys its wait');
  tick(30); check(JSON.stringify(poses(1)) === before, mode+': constructor waits for budget');
  tick(35); const moving = JSON.stringify(poses(1));
  check(moving !== before, mode+': graph grant moves the rendered tree');
  check(JSON.stringify(poses(2)) === sibling, mode+': shared-model sibling stays still');
  check(JSON.stringify(poses(1)[0]) === JSON.stringify(poses(1)[1]), mode+': submeshes share one clock');
  tick(65); const held = JSON.stringify(poses(1));
  check(held !== moving, mode+': animation advances through its budget');
  tick(40); check(JSON.stringify(poses(1)) === held, mode+': exhausted budget holds the final pose');
  if (mode === 'play') {
    tick(1500); check(JSON.stringify(poses(1)) === held, 'tree stays fallen until the thirty-second reset');
    tick(100); check(JSON.stringify(poses(1)) === before, 'thirty-second chain reset restores the tree');
    endPlay();
  } else runtime.stopPreview();
  check(JSON.stringify(poses(1)) === before, mode+': reset restores the original pose');
  check(!decor.instanceHasBudgetedAnimation(1), mode+': reset removes the installed receiver');
}
// A subsequent constructor replaces the old law and pause must freeze this per-instance clock too.
document.graphs[0].nodes = [call(1,'fall')];
document.graphs[1].nodes = [delta(30), grant(60), wait(0.25), stop(1), wait(0.5), delta(15), grant(30)];
runtime.setData({ level: 'ANIMATION', document, instances });
beginPlay(); hit(0); tick(20); const paused = JSON.stringify(poses(1));
tick(20); check(JSON.stringify(poses(1)) === paused, 'pause freezes an installed delta receiver');
tick(30); check(JSON.stringify(poses(1)) !== paused, 'new constructor resumes with its replacement law');
endPlay(); check(JSON.stringify(poses(1)) === before, 'Test exit restores replacement receiver');
window.animationPassed = true;
`;
const bundle = await build({ stdin: { contents: source,
  resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].text
    : '<!doctype html><script type="module" src="/fixture.js"></script>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.waitForFunction(() => (window as Window & { animationPassed?: boolean }).animationPassed,
    undefined, { timeout: 10_000 }).catch(() => assert.fail(errors.join('\n') || 'Animation fixture did not finish'));
  assert.deepEqual(errors, []);
  console.log('BUDGETED MODEL ANIMATION BROWSER TEST PASSED');
} finally { await browser.close(); server.close(); }
