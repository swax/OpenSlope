// tier: fast
import assert from 'node:assert/strict';
import { publicBundle } from '../src/app/public/public-bundle';
import { bundleAssets, bundleProps } from '../src/app/public/bundle-assets';
import { blankMountain } from '../src/core/doc/mountain';
import type { PropsPayload } from '../src/core/reference/props';
import type { PublicCourse } from '../src/core/session/public-courses';
import { encodePng, decodePng } from '../src/server/routes/png';

const origin = 'https://bundle.test';
const course = {
  id: 'public-project',
  kind: 'project',
  name: 'COPY',
  isoCourses: [],
  retailData: false,
} satisfies PublicCourse;
const packed = (values: Float32Array | Uint32Array) => Buffer.from(values.buffer).toString('base64');
const payload: PropsPayload = {
  level: '@import',
  materials: [{ id: 3, tex: 'Custom/prop.png', frames: ['prop.png', 'prop_f1.png'] }],
  models: [7, 18].map(id => ({
    id,
    name: `Prop ${id}`,
    subs: [
      {
        mat: 3,
        pos: packed(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])),
        uv: packed(new Float32Array([0, 0, 1, 0, 0, 1])),
        idx: packed(new Uint32Array([0, 1, 2])),
      },
    ],
  })),
  instances: [],
};
const document = blankMountain(course.name);
document.props = [{ level: '@import', model: 7, name: 'Prop 7', pos: [0, 0, 0], yaw: 0, scale: 1 }];
const pixels = new Map([
  ['prop.png', encodePng({ w: 1, h: 1, data: new Uint8Array([200, 40, 40, 255]) })],
  ['prop_f1.png', encodePng({ w: 1, h: 1, data: new Uint8Array([40, 200, 40, 255]) })],
]);
const requests: URL[] = [];
const source = {
  origin,
  fetch: (async input => {
    const url = new URL(String(input), origin);
    requests.push(url);
    if (url.pathname === '/api/public/project') return Response.json({ document });
    if (url.pathname === '/api/custom-props') return Response.json(payload);
    if (url.pathname === '/api/texture') {
      assert.equal(url.searchParams.get('project'), course.id);
      assert.equal(url.searchParams.get('level'), 'Custom');
      const bytes = pixels.get(url.searchParams.get('name')!);
      return bytes
        ? new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } })
        : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) satisfies typeof fetch,
};

const bundle = await publicBundle(course, source);
assert.deepEqual(bundle.missing, []);
assert.deepEqual(
  bundle.assets
    .filter(asset => asset.kind === 'texture')
    .map(asset => asset.name)
    .sort(),
  ['prop.png', 'prop_f1.png'],
);
assert.equal(
  requests.filter(url => url.pathname === '/api/texture').length,
  2,
  'models sharing a texture fetch it once',
);
const props = bundleProps(bundle);
assert.deepEqual(
  props.models.map(model => model.id),
  [7, 18],
  'copying preserves stable imported-model identities',
);
assert(props.materials.every(material => material.tex === 'Custom/prop.png'));
assert(props.materials.every(material => material.frames?.join() === 'Custom/prop.png,Custom/prop_f1.png'));
const resolver = bundleAssets(bundle, origin);
try {
  for (const [name, bytes] of pixels) {
    const url = resolver.resolve(`/api/texture?level=Custom&name=${name}`);
    assert(url.startsWith('blob:'), 'stored textures resolve independently of the server');
    const stored = new Uint8Array(await (await fetch(url)).arrayBuffer());
    assert.deepEqual(Buffer.from(stored), bytes);
    assert.deepEqual(
      decodePng(Buffer.from(stored)).data,
      decodePng(bytes).data,
      'every animation frame retains its original pixels',
    );
  }
} finally {
  resolver.dispose();
}

pixels.delete('prop_f1.png');
assert.deepEqual(
  (await publicBundle(course, source)).missing,
  ['texture:prop_f1.png'],
  'missing frames are reported explicitly',
);
document.props = [];
requests.length = 0;
await publicBundle(course, source);
assert(
  !requests.some(url => url.pathname === '/api/custom-props'),
  'maps with no imported placements need no model catalogue',
);
await assert.rejects(
  publicBundle(course, { origin, fetch: async () => new Response(null, { status: 404 }) }),
  /no longer available/,
);
console.log(
  'PUBLIC BUNDLE PASS: real prop conversion, shared texture collection, frames, stable IDs, missing assets and stored PNG bytes',
);
