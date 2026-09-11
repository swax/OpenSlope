// tier: fast

import assert from 'node:assert/strict';
import { createGpuFrameTimer } from '../src/app/viewport/gpu-timer';

type FakeQuery = { available: boolean; nanoseconds: number; deleted: boolean; valid: boolean };

function fakeContext(extension = true) {
  const queries: FakeQuery[] = [];
  let current: FakeQuery | null = null;
  let disjoint = false;
  let lost = false, extensionReads = 0;
  const canvas = new EventTarget();
  const ext = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
  const gl = {
    canvas,
    isContextLost: () => lost,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    CURRENT_QUERY: 0x8865,
    getExtension: (name: string) => {
      extensionReads++;
      return name === 'EXT_disjoint_timer_query_webgl2' && extension && !lost ? ext : null;
    },
    getParameter: (name: number) => name === ext.GPU_DISJOINT_EXT ? disjoint : null,
    getQuery: (_target: number, name: number) => name === 0x8865 ? current : null,
    createQuery: () => {
      const query = { available: false, nanoseconds: 0, deleted: false, valid: true };
      queries.push(query);
      return query;
    },
    beginQuery: (_target: number, query: FakeQuery) => { current = query; },
    endQuery: () => { current = null; },
    getQueryParameter: (query: FakeQuery, name: number) => {
      assert.equal(query.valid, true, 'must not poll queries from a lost context');
      return name === 0x8867 ? query.available : query.nanoseconds;
    },
    deleteQuery: (query: FakeQuery) => {
      assert.equal(query.valid, true, 'must not delete invalidated queries');
      query.deleted = true;
    },
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    queries,
    setDisjoint(value: boolean) { disjoint = value; },
    get extensionReads() { return extensionReads; },
    lose() {
      lost = true; current = null;
      queries.forEach(query => { query.valid = false; });
      canvas.dispatchEvent(new Event('webglcontextlost'));
    },
    restore(supported = true) {
      lost = false; extension = supported;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
  };
}

{
  const fake = fakeContext();
  const timer = createGpuFrameTimer(fake.gl);
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'pending' });
  timer.endFrame();
  assert.equal(fake.queries.length, 1);

  fake.queries[0].nanoseconds = 12_500_000;
  fake.queries[0].available = true;
  assert.deepEqual(timer.beginFrame(), { gpuMs: 12.5, state: 'ok' },
    'a completed asynchronous result is converted from nanoseconds to milliseconds');
  assert.equal(fake.queries[0].deleted, true, 'consumed driver queries are retired');
  timer.endFrame();

  fake.setDisjoint(true);
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'disjoint' },
    'a GPU clock discontinuity is visible and never reported as timing');
  assert.equal(fake.queries[1].deleted, true, 'disjoint invalidates every outstanding query');
  fake.setDisjoint(false);
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'pending' },
    'measurement resumes only after the disjoint flag clears');
  timer.endFrame();
  timer.reset();
  assert.equal(fake.queries[2].deleted, true, 'reset retires an old session’s in-flight results');
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'pending' },
    'the reusable timer starts cleanly for a later diagnostic session');
  timer.endFrame();
  timer.dispose();
  assert.equal(fake.queries[3].deleted, true, 'dispose retires the final in-flight result');
}

{
  const timer = createGpuFrameTimer(fakeContext(false).gl);
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'unsupported' });
  timer.endFrame();
  timer.dispose();
}

for (const initiallySupported of [false, true]) {
  const fake = fakeContext(initiallySupported);
  const timer = createGpuFrameTimer(fake.gl);
  timer.beginFrame(); timer.endFrame(); // pending query
  timer.beginFrame(); // active query
  fake.lose();
  timer.endFrame(); timer.reset();
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'disjoint' });
  fake.restore();
  assert.equal(fake.extensionReads, 2, 'reacquire extension after an XR adapter/context change');
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'pending' });
  timer.endFrame();
  const query = fake.queries.at(-1)!;
  query.available = true; query.nanoseconds = 2_000_000;
  assert.deepEqual(timer.beginFrame(), { gpuMs: 2, state: 'ok' }, 'only new-context timings are consumed');
  timer.endFrame();
  fake.lose(); fake.restore(false);
  assert.deepEqual(timer.beginFrame(), { gpuMs: null, state: 'unsupported' }, 'new adapter may lack timer queries');
  timer.dispose();
  const reads = fake.extensionReads;
  fake.lose(); fake.restore();
  assert.equal(fake.extensionReads, reads, 'dispose removes context listeners');
}

console.log('GPU TIMER: PASS');
