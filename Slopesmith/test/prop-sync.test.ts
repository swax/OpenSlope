// tier: fast
import assert from 'node:assert/strict';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { createStore } from '../src/app/state/store';
import { AUTHORED_MODEL_LEVEL } from '../src/core/doc/models';
import type { LevelProps } from '../src/core/reference/props';

// The prop operations import the shared toast; no rendered DOM is needed by the asset-loading path.
Object.defineProperty(globalThis, 'document', {
  configurable: true, value: { getElementById: () => ({ textContent: '', className: '' }) },
});
const { createPropOps } = await import('../src/app/props/operations');
const store = createStore({ mdoc: migrateMountain(defaultMountain()), currentMode: 'props', storedUi: {} });
const levels = new Map<string, LevelProps>();
const requests: string[] = [];
let renders = 0, modelRegistrations = 0, groupRegistrations = 0;
const ops = createPropOps({
  store, propLevels: levels, groupDefIdx: new Map(),
  viewport: {
    registerPropModels: () => { modelRegistrations++; },
    registerGroupDefs: () => { groupRegistrations++; },
  },
  scheduleRebuild: () => { renders++; },
} as unknown as Parameters<typeof createPropOps>[0]);
const originalFetch = globalThis.fetch;
let fail = false;
let release: (() => void) | undefined;
let waiting: Promise<void> | undefined;
globalThis.fetch = async input => {
  const url = String(input);
  requests.push(url);
  await waiting;
  if (fail) return new Response('Unavailable', { status: 503 });
  return Response.json(url.startsWith('/api/groups') ? { groups: [] }
    : { level: 'TEST', models: [], instances: [], materials: [] });
};
const place = (level: string, group?: string) => {
  store.mdoc.props = [{ id: 'p', name: 'Prop', level, model: 0, pos: [0, 0, 0], yaw: 0, scale: 1, group }];
};
try {
  assert.equal(await ops.syncPropGeom(), false, 'an empty map needs no asset redraw');
  place(AUTHORED_MODEL_LEVEL);
  assert.equal(await ops.syncPropGeom(), false, 'authored geometry is handled by the ordinary object render');
  assert.equal(requests.length, 0);

  place('TEST', 'group');
  waiting = new Promise<void>(resolve => { release = resolve; });
  const first = ops.syncPropGeom(false);
  const overlapping = ops.syncPropGeom(false);
  assert.equal(requests.length, 2, 'overlapping snapshots share model and group requests');
  release!();
  assert.deepEqual(await Promise.all([first, overlapping]), [true, true], 'each waiting snapshot learns that assets arrived');
  assert.equal(renders, 0, 'callers can render newly loaded assets themselves');
  assert.equal(modelRegistrations, 1);
  assert.equal(groupRegistrations, 1);
  assert.equal(await ops.syncPropGeom(), false, 'cached assets, including an empty group catalogue, need no redraw');
  assert.equal(requests.length, 2);
  assert.equal(modelRegistrations, 1, 'cached geometry is not registered again');
  assert.equal(renders, 0);

  place('RETRY', 'group');
  fail = true;
  assert.equal(await ops.syncPropGeom(), false, 'failed loads do not trigger an empty redraw');
  assert.equal(renders, 0);
  fail = false;
  assert.equal(await ops.syncPropGeom(), true, 'failed assets can be retried');
  assert.equal(renders, 1, 'newly available assets schedule the requested redraw');
  assert.equal(await ops.syncPropGeom(), false);
  assert.equal(renders, 1);
  console.log('Prop sync: cached, concurrent, new and failed asset loads passed.');
} finally {
  globalThis.fetch = originalFetch;
}
