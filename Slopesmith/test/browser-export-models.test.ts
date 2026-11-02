// tier: fast
import assert from 'node:assert/strict';
import { browserExportProvider } from '../src/app/export/provider';
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
console.log('Browser export models: embedded sources, external geometry and missing-source diagnostics PASS');
