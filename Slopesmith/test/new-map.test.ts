// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { installTestDom } from './dom-test-support';
import { loadDomFixture } from './dom-fixture-support';

const cleanup = installTestDom('https://new-map.test/');
const fetchBefore = globalThis.fetch;
let dispose: (() => Promise<void>) | undefined;
const destinations: string[] = [];
Object.defineProperty(location, 'assign', { configurable: true, value: (url: string) => destinations.push(url) });
const requests: { url: string; body: any }[] = [];
let fail = false;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return fail
    ? Response.json({ error: 'Temporary test failure' }, { status: 503 })
    : Response.json({ project: { name: requests.at(-1)!.body.name, id: 'server-id' } });
};
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert(Date.now() < deadline, 'dialog operation completes');
    await setImmediate();
  }
}
try {
  dispose = await loadDomFixture(new URL('./new-map.fixture.ts', import.meta.url));
  const api = (window as any).newMap;
  const dialog = () => document.querySelector<HTMLDialogElement>('dialog')!;
  const field = (name: string) =>
    [...dialog().querySelectorAll('label')]
      .find(label => label.textContent?.startsWith(name))!
      .querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!;
  const create = () => [...dialog().querySelectorAll('button')].find(button => button.textContent === 'Create map')!;
  const show = (member = false, localNames: string[] = []) => api.show({ canCreateServer: member, localNames });
  const name = (value: string) => {
    field('Map name').value = value;
    field('Map name').dispatchEvent(new Event('input'));
  };
  const submit = () =>
    dialog()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
  const choose = (label: string, value: string) => {
    field(label).value = value;
    field(label).dispatchEvent(new Event('change'));
  };
  show();
  assert.equal(field('Save location').value, 'local');
  assert.equal(field('Terrain').value, 'blank');
  assert.equal(field('Map name').value, 'MOUNTAIN01');
  assert(!dialog().querySelector('option[value="server"]'));
  name('CANCELLED');
  [...dialog().querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click();
  assert.equal((await api.list()).length, 0);
  show(false, ['taken']);
  for (const value of ['', 'bad/name', 'TAKEN']) {
    name(value);
    assert(create().disabled, `${value} cannot be created`);
  }
  name('LOCAL_BLANK');
  submit();
  assert(field('Terrain').disabled && field('Map name').disabled, 'prevent duplicate edits while saving');
  const cancelEvent = new Event('cancel', { cancelable: true });
  dialog().dispatchEvent(cancelEvent);
  assert(cancelEvent.defaultPrevented, 'Escape cannot interrupt an in-flight save');
  await until(() => destinations.length === 1);
  const localId = new URL(destinations[0], location.origin).searchParams.get('local');
  assert(localId?.startsWith('local-'));
  const local = await api.read(localId);
  assert.equal(local.document.name, 'LOCAL_BLANK');
  assert.equal(local.document.spacing, 30);
  assert.equal(local.document.vertices.length, 0);
  assert.equal(local.document.quads.length, 0);
  assert.equal(requests.length, 0, 'local creation needs no HTTP request');
  dialog().remove();
  show();
  name('LOCAL_GENERATED');
  choose('Terrain', 'generated');
  submit();
  await until(() => destinations.length === 2);
  const generatedId = new URL(destinations[1], location.origin).searchParams.get('local');
  assert((await api.read(generatedId)).document.quads.length > 0);
  dialog().remove();
  show(true);
  name('SERVER_MAP');
  choose('Save location', 'server');
  fail = true;
  submit();
  await until(() => !field('Map name').disabled);
  assert(dialog().textContent?.includes('Temporary test failure'));
  assert.equal(field('Map name').value, 'SERVER_MAP');
  assert.equal(field('Save location').value, 'server');
  assert.equal(field('Terrain').value, 'blank');
  assert(!field('Terrain').disabled);
  assert(!create().disabled, 'a failed request enables the retry button');
  fail = false;
  submit();
  await until(() => destinations.length === 3);
  assert.equal(new URL(destinations[2]).searchParams.get('project'), 'server-id');
  assert.equal(requests.at(-1)!.url, '/api/projects');
  assert.equal(requests.at(-1)!.body.document.quads.length, 0);
  assert.equal((await api.list()).length, 2, 'server creation does not duplicate into IndexedDB');
  dialog().remove();
  show(true);
  name('SERVER_GENERATED');
  choose('Terrain', 'generated');
  choose('Save location', 'server');
  submit();
  await until(() => destinations.length === 4);
  assert(requests.at(-1)!.body.document.quads.length > 0);
  dialog().remove();
  const serverRequests = requests.length;
  show(true);
  name('MEMBER_LOCAL');
  submit();
  await until(() => destinations.length === 5);
  assert(new URL(destinations[4], location.origin).searchParams.has('local'));
  assert.equal((await api.list()).length, 3, 'signed-in members can still create local maps');
  assert.equal(requests.length, serverRequests, 'a member choosing local storage makes no server copy');
  console.log('PASS new-map defaults, naming, cancellation, local bytes, terrain choice, server payloads and retry');
} finally {
  globalThis.fetch = fetchBefore;
  await dispose?.();
  await cleanup();
}
