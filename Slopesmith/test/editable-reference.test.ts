// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { installTestDom } from './dom-test-support';
import { editableReferenceFixture } from './editable-reference.fixture';
import { decodeProps, type PropsPayload } from '../src/core/reference/props';
import type { ClientProject } from '../src/app/state/project-sync';
import { authoredPatches } from '../src/app/reference/authored';
import { orientFromPatchUV } from '../src/core/paint/orientation';

const cleanup = installTestDom();
try {
  const { documentReferenceSource, editableReferenceChoice, findEditableReference, referenceMapGames } =
    await import('../src/app/reference/editable');
  const { GameMapSelect } = await import('../src/app/ui/components/game-map-select');
  const { installReferenceSource } = await import('../src/app/net/reference-source');
  const { workspaceFetch } = await import('../src/app/net/workspace');
  const { setClientProjectId, clientProjectId } = await import('../src/app/net/client');
  const bundle = editableReferenceFixture();
  const project = { id: 'source-project', name: bundle.name, documentHash: 'v1', revision: 1 } as ClientProject;
  const local = editableReferenceChoice(project, 'local');
  const server = editableReferenceChoice(project, 'server');
  assert.notEqual(local.name, server.name, 'equal names and IDs retain their storage source');
  assert.equal(local.label, project.name, 'the Slopesmith group makes an editable suffix unnecessary');
  const choices = [
    local,
    server,
    { name: 'server:MYSTERY', source: 'server' as const },
    { name: 'local:MYSTERY', source: 'local' as const },
    { name: 'server:My Hill', source: 'server' as const, origin: 'slopesmith', game: 'ssx-tricky' },
    { name: 'server:TRICKY_GARI', source: 'server' as const, origin: 'retail' },
  ];
  const picker = new GameMapSelect(
    document.createElement('select'),
    'Reference',
    () => {},
    '(none)',
    referenceMapGames,
  );
  picker.setMaps(choices, server.name);
  assert.deepEqual(
    [...picker.gameSelect.options].map(option => option.text),
    ['Choose game', 'Slopesmith', 'Custom Ref', 'SSX Tricky'],
  );
  assert.equal(picker.mapSelect.selectedOptions[0].text, project.name);
  const choose = (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };
  choose(picker.gameSelect, 'custom-ref');
  assert.deepEqual(
    [...picker.mapSelect.options].map(option => option.value),
    ['(none)', 'server:MYSTERY', 'server:My Hill'],
    'unidentified folders and authored exports share Custom Ref, independently of borrowed art',
  );
  choose(picker.sourceSelect, 'local');
  assert.deepEqual(
    [...picker.mapSelect.options].map(option => option.value),
    ['(none)', 'local:MYSTERY'],
  );
  picker.select(local.name);
  assert.equal(picker.gameSelect.value, 'slopesmith');
  assert.equal(picker.mapSelect.value, local.name);
  picker.select('server:TRICKY_GARI');
  assert.equal(picker.sourceSelect.value, 'server');
  assert.equal(picker.gameSelect.value, 'ssx-tricky');
  assert.equal(picker.mapSelect.selectedOptions[0].text, 'Garibaldi');
  picker.select('server:MYSTERY');
  assert.equal(picker.gameSelect.value, 'custom-ref', 'saved folder identities restore into the new group');
  assert.equal(picker.mapSelect.value, 'server:MYSTERY');
  const assetPicker = new GameMapSelect(document.createElement('select'), 'Texture', () => {});
  assetPicker.setMaps(choices, 'server:MYSTERY');
  assert.equal(assetPicker.gameSelect.selectedOptions[0].text, 'Unknown');
  assetPicker.select('server:My Hill');
  assert.equal(assetPicker.gameSelect.selectedOptions[0].text, 'Custom');
  assert.equal(findEditableReference([server, local], `${local.name}:snapshot:old`), local);
  assert.equal(
    findEditableReference([server], local.name),
    undefined,
    'an absent local source cannot become a server source',
  );
  setClientProjectId('ACTIVE_PROJECT');
  const packed = (array: Float32Array | Uint32Array) => Buffer.from(array.buffer).toString('base64');
  const donor: PropsPayload = {
    level: 'DONOR',
    models: [
      {
        id: 0,
        name: 'Donor tree',
        subs: [
          {
            mat: 0,
            pos: packed(new Float32Array([0, 0, 0, -100, 0, 0, 0, 0, 100])),
            uv: packed(new Float32Array([0, 0, 1, 0, 0, 1])),
            idx: packed(new Uint32Array([0, 1, 2])),
          },
        ],
      },
    ],
    materials: [{ id: 0, tex: 'shared.png', frames: ['shared.png', 'next.png'], alphaMode: 'cutout' }],
    instances: [],
  };
  bundle.document.props!.push(
    { id: 'prop:0001', level: 'local:DONOR', model: 0, name: 'Borrowed tree', pos: [40, 2, 30], yaw: 90, scale: 3 },
    { id: 'prop:0002', level: '@import', model: 0, name: 'Imported tree', pos: [5, 1, 7], yaw: 0, scale: 1 },
  );
  const before = structuredClone(bundle);
  const reads: string[] = [];
  let disposed = 0;
  const source = documentReferenceSource(`${local.name}:snapshot:test`, bundle, {
    async request(path) {
      reads.push(path);
      const url = new URL(path, location.origin);
      if (url.pathname === '/api/props') return Response.json(donor);
      if (url.pathname === '/api/custom-props')
        return Response.json({ ...donor, level: '@import', materials: [{ id: 0, tex: 'Custom/shared.png' }] });
      if (url.pathname === '/api/texture')
        return new Response(`${url.searchParams.get('level')}/${url.searchParams.get('name')}`);
      throw new Error(`Unexpected read: ${path}`);
    },
    dispose() {
      disposed++;
    },
  });
  const remove = installReferenceSource(source);
  const request = (path: string, name = 'level') =>
    workspaceFetch(`/api/${path}${path.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(source.id)}`);
  const level = await (await request('level', 'name')).json();
  assert.deepEqual(level.patches[0].Points, JSON.parse(JSON.stringify(authoredPatches(bundle.document)[0].Points)));
  assert.deepEqual(
    orientFromPatchUV([
      level.patches[0].UVPoints[0],
      level.patches[0].UVPoints[2],
      level.patches[0].UVPoints[1],
      level.patches[0].UVPoints[3],
    ]),
    { rot: 1, mirror: true },
  );
  assert.equal(await (await request(`texture?name=${level.patches[0].TexturePath}`)).text(), 'Custom/shared.png');
  const payload = (await (await request('props')).json()) as PropsPayload;
  const props = decodeProps(payload);
  assert.equal(props.instances.length, 3);
  assert.equal(
    new Set(props.instances.map(instance => instance.model)).size,
    3,
    'same-numbered models from different banks never collide',
  );
  assert.deepEqual(props.instances[1].loc, [-4000, -3000, 200]);
  assert.deepEqual(props.instances[1].scale, [3, 3, 3]);
  assert(Math.abs(props.instances[1].rot[2]) > 0.7, 'the source rotation is mapped into reference coordinates');
  for (const material of payload.materials) {
    if (!material.tex) continue;
    const bytes = await (await request(`texture?name=${material.tex}`)).text();
    assert.equal(bytes, material.id === 1 ? 'local:DONOR/shared.png' : 'Custom/shared.png');
  }
  const borrowed = payload.materials[1];
  assert.equal(borrowed.alphaMode, 'cutout');
  assert.equal(await (await request(`texture?name=${borrowed.frames![1]}`)).text(), 'local:DONOR/next.png');
  assert.equal(clientProjectId(), 'ACTIVE_PROJECT', 'reference reads never activate another project');
  assert.equal(
    (await workspaceFetch(`/api/props?level=${encodeURIComponent(source.id)}`, { method: 'POST' })).status,
    405,
  );
  const normalized = `/api/texture?level=${encodeURIComponent(source.id.slice('local:'.length))}&mapSource=local&name=${level.patches[0].TexturePath}`;
  assert.equal(
    await (await workspaceFetch(normalized)).text(),
    'Custom/shared.png',
    'normalized asset URLs retain the source scope',
  );
  assert.deepEqual(bundle, before, 'source documents and bundles stay unchanged');
  assert(
    reads.every(path => !path.includes('/export') && !path.includes('/activate') && !path.includes('ACTIVE_PROJECT')),
  );
  bundle.document.vertices[0] = 999;
  assert.equal(
    (await (await request('level', 'name')).json()).patches[0].Points[0][0],
    0,
    'loaded references hold an immutable snapshot',
  );
  remove();
  remove();
  assert.equal(disposed, 1);
  assert.equal((await request('props')).status, 404, 'unloaded snapshots cannot fall through to server map folders');
  console.log(
    'EDITABLE REFERENCES: PASS (terrain, oriented paint, authored/imported/borrowed props, scoped textures, snapshot isolation, cleanup)',
  );
} finally {
  await cleanup();
}
