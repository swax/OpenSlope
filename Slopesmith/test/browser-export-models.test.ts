// tier: fast
import assert from 'node:assert/strict';
import { browserExportProvider } from '../src/app/export/provider';
import { safeDataName } from '../src/core/export/names';
import type { PropsPayload } from '../src/core/reference/props';

const packed = (values: Float32Array | Uint32Array) => Buffer.from(values.buffer).toString('base64');
const payload: PropsPayload = {
  level: 'GARI',
  materials: [],
  instances: [],
  models: [
    {
      id: 2,
      name: 'Source tree',
      subs: [
        {
          mat: -1,
          pos: packed(new Float32Array([0, 0, 0, 100, 0, 0, 0, 0, 200])),
          uv: packed(new Float32Array([0, 0, 1, 0, 0, 1])),
          idx: packed(new Uint32Array([0, 1, 2])),
        },
      ],
    },
  ],
};
const requests: string[] = [];
const provider = browserExportProvider({
  folderName: 'FOLDER_MAP',
  existingFile: async () => false,
  request: async path => {
    requests.push(path);
    const level = new URL(path, 'http://localhost').searchParams.get('level');
    return Response.json(level === 'GARI' ? payload : { levels: [] });
  },
});
const geometry = await provider.modelGeometry([
  { level: '@models', model: 0 },
  { level: '@import', model: 5 },
  { level: 'GARI', model: 2 },
  { level: 'GARI', model: 2 },
]);
assert.equal(geometry('@models', 0), null);
assert.equal(geometry('@import', 5), null);
assert.deepEqual(Array.from(geometry('GARI', 2)!.subs[0].positions), [0, 0, 0, 100, 0, 0, 0, 0, 200]);
assert.deepEqual(requests, ['/api/props?level=GARI'], 'Embedded models never request an external map payload');
for (const response of [Response.json({ levels: [] }), Response.json({ error: 'missing' }, { status: 404 })]) {
  const unavailable = browserExportProvider({
    folderName: 'FOLDER_MAP',
    existingFile: async () => false,
    request: async () => response,
  });
  await assert.rejects(
    unavailable.modelGeometry([{ level: 'MISSING_SOURCE', model: 2 }]),
    /MISSING_SOURCE.*source map/i,
  );
}
const pinned = 'asset2:ssx-tricky:TRICKY_GARI:prop:2:' + 'a'.repeat(64);
const queries: string[] = [];
const material = [{ TexturePath: 'bark.png', UnknownInt18: 0x40000, TextureFlipbook: ['branch.png'] }];
const materials = browserExportProvider({
  folderName: 'FOLDER_MAP',
  existingFile: async () => false,
  request: async path => {
    const url = new URL(path, 'http://localhost');
    const level = url.searchParams.get('level');
    assert.equal(url.pathname, '/api/props/materials');
    assert.ok(level, 'Export must never request the whole library');
    queries.push(level);
    if (level === pinned) return Response.json({ tables: { [safeDataName(pinned)]: material } });
    if (level === 'local:GARI') return Response.json({ tables: { GARI: material } });
    return Response.json({ error: 'Source table could not be read' }, { status: 500 });
  },
});
assert.equal((await materials.materialTables([])).size, 0);
assert.deepEqual(
  await materials.materialTables([pinned, 'local:GARI', pinned]),
  new Map([
    [safeDataName(pinned), material],
    [safeDataName('local:GARI'), material],
  ]),
);
assert.deepEqual(queries, [pinned, 'local:GARI']);
await assert.rejects(materials.materialTables(['BROKEN']), /BROKEN.*Source table could not be read/);
console.log('Browser export models: scoped geometry, material tables and missing-source diagnostics PASS');
