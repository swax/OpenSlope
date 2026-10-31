import assert from 'node:assert/strict';
import {
  findMapChoice,
  legacyTrickyMapName,
  mapSourceId,
  serverMapName,
  splitMapSource,
} from '../src/core/reference/map-source';
import { mapDisplayName, mapGame } from '../src/core/reference/map-game';
import { safeMapName } from '../src/shared/map-data';
import { buildMaterialCombiner } from '../src/core/export/materials';
import { bindMapPayload, mapSourceRequest } from '../src/app/net/map-source';

const copies = [
  { name: mapSourceId('server', 'TRICKY_GARI'), source: 'server' as const },
  { name: mapSourceId('local', 'TRICKY_GARI'), source: 'local' as const },
];
assert.equal(findMapChoice(copies, 'TRICKY_GARI'), copies[1]);
assert.equal(findMapChoice(copies, 'server:TRICKY_GARI'), copies[0]);
assert.equal(findMapChoice(copies, 'GARI'), copies[1]);
assert.equal(findMapChoice(copies, 'local:GARI'), copies[1]);
assert.equal(findMapChoice(copies, 'server:GARI'), copies[0]);
assert.equal(findMapChoice(copies.slice(0, 1), 'local:GARI'), undefined);
const oldServer = { name: 'server:GARI', source: 'server' as const };
assert.equal(findMapChoice([...copies, oldServer], 'GARI'), oldServer, 'exact bank names win over aliases');
assert.equal(legacyTrickyMapName('some_other_map'), 'TRICKY_SOME_OTHER_MAP', 'fallback does not need a slot list');
for (const name of [
  'TRICKY_GARI',
  'SSX_SNOW',
  'SSX3_ARA1',
  'SSXOT_ER1_DAY',
  'SSXGBA_ALASKA',
  'AVALANCHE_CRS01_00',
  'MADTRIX_TR_TRAINING',
  'Custom',
  'Shared',
  'Riders',
  '../GARI',
  'GARI/tile.png',
  'asset1:ssx:map:hash',
  '@models',
])
  assert.equal(legacyTrickyMapName(name), undefined, `${name} must not receive a Tricky prefix`);
assert.equal(
  findMapChoice(copies.slice(0, 1), 'local:TRICKY_GARI'),
  undefined,
  'an explicit source never selects the other copy',
);
assert.deepEqual(splitMapSource('server:TRICKY_GARI'), { name: 'TRICKY_GARI', source: 'server' });
assert.equal(mapSourceId('local', 'server:TRICKY_GARI'), 'local:TRICKY_GARI');
assert.equal(mapGame({ name: 'local:TRICKY_GARI' }), 'ssx-tricky');
assert.equal(mapDisplayName({ name: 'server:TRICKY_GARI' }), 'Garibaldi');
assert.equal(mapDisplayName({ name: 'local:MYSTERY' }), 'MYSTERY');
assert.equal(safeMapName('server:TRICKY_GARI'), 'TRICKY_GARI');
assert.throws(() => serverMapName('local:TRICKY_GARI'), /on this device/);

for (const source of ['local', 'server'] as const) {
  const id = mapSourceId(source, 'TRICKY_GARI');
  const request = mapSourceRequest(`/api/props?level=${encodeURIComponent(id)}&v=123`);
  assert.equal(request.url.searchParams.get('level'), 'TRICKY_GARI');
  assert.equal(request.url.searchParams.get('mapSource'), source);
  assert.equal(request.url.searchParams.get('v'), '123');
  assert.deepEqual(bindMapPayload(`/api/textures?level=${id}`, { level: 'TRICKY_GARI', tiles: [] }), {
    level: id,
    tiles: [],
  });
  assert.deepEqual(bindMapPayload(`/api/level?name=${id}`, { name: 'TRICKY_GARI', patches: [] }), {
    name: id,
    patches: [],
  });
}
assert.equal(mapSourceRequest('/maps?level=server:TRICKY_GARI').explicit, false);

const combiner = buildMaterialCombiner(
  new Map([
    ['TRICKY_GARI', [{ TexturePath: 'server.png' }]],
    ['localTRICKY_GARI', [{ TexturePath: 'local.png' }]],
  ]),
);
const serverSlot = combiner.resolveSlot('server:TRICKY_GARI', 0);
const localSlot = combiner.resolveSlot('local:TRICKY_GARI', 0);
assert(serverSlot >= 0 && localSlot >= 0 && serverSlot !== localSlot);
assert.deepEqual(
  combiner.texCopies.map(copy => [copy.level, copy.name]),
  [
    ['server:TRICKY_GARI', 'server.png'],
    ['local:TRICKY_GARI', 'local.png'],
  ],
);
const legacyCombiner = buildMaterialCombiner(
  new Map([
    ['TRICKY_GARI', [{ TexturePath: 'server.png' }]],
    ['localTRICKY_GARI', [{ TexturePath: 'local.png' }]],
  ]),
);
assert(legacyCombiner.resolveSlot('GARI', 0) >= 0);
assert(legacyCombiner.resolveSlot('local:GARI', 0) >= 0);
assert.deepEqual(
  legacyCombiner.texCopies.map(copy => copy.name),
  ['server.png', 'local.png'],
);
const shadowed = buildMaterialCombiner(
  new Map([
    ['GARI', []],
    ['TRICKY_GARI', [{ TexturePath: 'other.png' }]],
  ]),
);
assert.equal(shadowed.resolveSlot('GARI', 0), -1, 'an empty exact table never borrows from another bank');
const localOnlyTables = buildMaterialCombiner(
  new Map([
    ['TRICKY_GARI', [{ TexturePath: 'local.png' }]],
    ['localTRICKY_GARI', [{ TexturePath: 'local.png' }]],
    ['serverTRICKY_GARI', []],
  ]),
);
assert.equal(localOnlyTables.resolveSlot('server:GARI', 0), -1, 'an explicit server alias never uses local tables');
console.log('Source-qualified map selection, routing, legacy IDs and export materials PASS');
